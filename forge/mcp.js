/**
 * forge — Model Context Protocol (MCP) client (v23, zero dependencies)
 *
 * MCP is the industry-standard way to give an agent tools and data from an
 * external process (a "server") — filesystems, databases, issue trackers,
 * browsers, company-internal APIs. Before this, forge could only be extended by
 * dropping a local `*.mjs` plugin in ~/.forge/tools (plugins.js). MCP opens the
 * whole ecosystem: any MCP server the user configures becomes a set of agent
 * tools, governed by the SAME capability registry, policy gate and safety
 * engine as the built-ins.
 *
 * This module is the transport + protocol client only. It deliberately does NOT
 * wire tools into the agent loop yet — `mcpToolsToPlugins()` returns tool
 * objects in the exact shape plugins.js already produces
 * (`{ name, readOnly, def, run, source }`), so the agent-loop integration is a
 * separate, small change that reuses the existing plugin choke point (output
 * redaction, write-class serialization, read-only sub-agent blocking).
 *
 * Transport: MCP stdio — newline-delimited JSON-RPC 2.0 over the child's
 * stdin/stdout (messages MUST NOT contain embedded newlines). Zero deps:
 * node:child_process + manual framing.
 *
 * Trust model (unchanged from plugins): a server is launched from a command in
 * the USER's config — never from model output — exactly like running any local
 * program the user chose. MCP is OFF by default (no servers configured). Tool
 * names are namespaced `mcp__<server>__<tool>` so they can never shadow a
 * built-in, and MCP tools are treated as WRITE-class by default (the protocol
 * does not reliably declare side-effect freedom, so we assume the unsafe case).
 */
import { spawn } from "node:child_process"
import pathMod from "node:path"
import fsMod from "node:fs"
import { resolveDataDir } from "./config.js"
import { writeStateFile } from "./securefs.js"
import { childEnv } from "./childenv.js"
import { VERSION } from "./version.js"

export const PROTOCOL_VERSION = "2024-11-05"
const DEFAULT_TIMEOUT_MS = 20000
const MAX_LINE_BYTES = 8 * 1024 * 1024 // guard against a runaway server flooding stdout

/** Namespaced tool name, e.g. mcp__github__create_issue. Stable + collision-free. */
export function mcpToolName(server, tool) {
  return `mcp__${server}__${tool}`
}

/** Parse a namespaced name back to { server, tool }, or null if not one of ours. */
export function parseMcpToolName(name) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(String(name || ""))
  return m ? { server: m[1], tool: m[2] } : null
}

/**
 * One MCP server connection over stdio. Not exported as a class API surface to
 * keep churn low; use `connectServer()` which returns a ready client.
 */
class McpClient {
  constructor(name, { command, args = [], env = {}, cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.name = name
    this.command = command
    this.args = Array.isArray(args) ? args : []
    this.env = env && typeof env === "object" ? env : {}
    this.cwd = cwd
    this.timeoutMs = timeoutMs
    this.child = null
    this._buf = ""
    this._nextId = 1
    this._pending = new Map() // id -> { resolve, reject, timer }
    this._closed = false
    this._exitReason = null
    this.serverInfo = null
    this.capabilities = null
  }

  _fail(reason) {
    this._closed = true
    this._exitReason = reason
    for (const [, p] of this._pending) {
      clearTimeout(p.timer)
      p.reject(new Error(`MCP server "${this.name}" ${reason}`))
    }
    this._pending.clear()
  }

  _onData(chunk) {
    this._buf += chunk
    if (this._buf.length > MAX_LINE_BYTES) {
      // a well-behaved server sends one JSON object per line; unbounded growth
      // with no newline means a broken/hostile server — cut it off.
      this._buf = ""
      this._fail("sent an over-long line with no message boundary")
      try { this.child?.kill("SIGKILL") } catch {}
      return
    }
    let nl
    while ((nl = this._buf.indexOf("\n")) !== -1) {
      const line = this._buf.slice(0, nl).trim()
      this._buf = this._buf.slice(nl + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue } // ignore non-JSON noise
      this._dispatch(msg)
    }
  }

  _dispatch(msg) {
    // We only issue requests, so we only expect responses (id + result/error).
    // Server-initiated requests/notifications are ignored (we advertise no such
    // capabilities), which is safe and spec-permitted for a minimal client.
    if (msg && msg.id !== undefined && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id)
      this._pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message || "unknown"}`))
      else p.resolve(msg.result)
    }
  }

  _request(method, params) {
    if (this._closed) return Promise.reject(new Error(`MCP server "${this.name}" is closed (${this._exitReason || "not connected"})`))
    const id = this._nextId++
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })
    if (payload.includes("\n")) return Promise.reject(new Error("internal: request contained a newline"))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`MCP request "${method}" to "${this.name}" timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      this._pending.set(id, { resolve, reject, timer })
      try {
        this.child.stdin.write(payload + "\n")
      } catch (e) {
        this._pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`MCP write to "${this.name}" failed: ${e.message}`))
      }
    })
  }

  _notify(method, params) {
    if (this._closed) return
    try { this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }) + "\n") } catch {}
  }

  async start() {
    if (!this.command || typeof this.command !== "string") throw new Error(`MCP server "${this.name}" has no command`)
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: childEnv(this.env),
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (d) => this._onData(d))
    this.child.on("error", (e) => this._fail(`could not launch (${e.message})`))
    this.child.on("exit", (code, sig) => this._fail(`exited (${sig || "code " + code})`))
    // stderr is the server's private log; drain it so the pipe never blocks.
    this.child.stderr.on("data", () => {})

    const init = await this._request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {}, // a minimal client: we consume tools, advertise nothing
      clientInfo: { name: "forge", version: VERSION },
    })
    this.serverInfo = init?.serverInfo ?? null
    this.capabilities = init?.capabilities ?? null
    this._notify("notifications/initialized")
    return this
  }

  /** @returns {Promise<Array<{name,description,inputSchema}>>} */
  async listTools() {
    const res = await this._request("tools/list", {})
    const tools = Array.isArray(res?.tools) ? res.tools : []
    return tools.filter((t) => t && typeof t.name === "string")
  }

  /** Call a tool. Returns { text, isError } — content flattened to text. */
  async callTool(tool, args) {
    const res = await this._request("tools/call", { name: tool, arguments: args ?? {} })
    return { text: flattenContent(res?.content), isError: res?.isError === true }
  }

  close() {
    if (this._closed) return
    this._closed = true
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error(`MCP server "${this.name}" closed`)) }
    this._pending.clear()
    // Graceful shutdown for the stdio transport: closing our stdin is the
    // conventional "you may exit now" signal, so a well-behaved server exits on
    // its own. A SIGKILL fallback (after a grace period) handles a stuck server
    // without ever leaking a child process. The timer is unref'd so it never
    // keeps forge's own process alive.
    const child = this.child
    try { child?.stdin?.end() } catch {}
    if (child && child.exitCode === null && child.signalCode === null) {
      const t = setTimeout(() => { try { child.kill("SIGKILL") } catch {} }, 2000)
      if (t.unref) t.unref()
      child.once?.("exit", () => clearTimeout(t))
    }
  }
}

/** Flatten an MCP content array (text/other parts) into a single string. */
export function flattenContent(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content == null ? "" : String(content)
  const parts = []
  for (const c of content) {
    if (!c || typeof c !== "object") { parts.push(String(c)); continue }
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text)
    else if (c.type === "resource" && c.resource?.text) parts.push(String(c.resource.text))
    else if (c.type === "image") parts.push(`[image ${c.mimeType || "data"} omitted]`)
    else parts.push(JSON.stringify(c))
  }
  return parts.join("\n")
}

/** Connect and initialize a server. Caller owns close(). */
export async function connectServer(name, spec, { timeoutMs } = {}) {
  const client = new McpClient(name, { ...spec, timeoutMs: timeoutMs ?? spec?.timeoutMs })
  await client.start()
  return client
}

/** The configured, non-disabled servers as [name, spec] pairs. */
export function configuredServers(config) {
  const servers = config?.mcp?.servers
  if (!servers || typeof servers !== "object") return []
  return Object.entries(servers).filter(([, s]) => s && typeof s === "object" && s.disabled !== true && s.command)
}

/**
 * Adapt a connected client's tools into forge's plugin tool shape, so the agent
 * loop can treat them exactly like local plugins (same safety choke point).
 * Names are namespaced; an MCP tool is WRITE-class unless the server's own
 * ToolAnnotations declare `readOnlyHint: true` (absent hints stay WRITE).
 * The returned `run(args)` calls the server and returns a string; an MCP
 * `isError` result is surfaced as an "ERROR:" string, matching how the tool
 * layer marks failures (never thrown into the loop).
 */
/**
 * MCP `ToolAnnotations` (spec 2025-03-26), normalized and bounded.
 * Hints are the SERVER's own declaration about its tool: they are advisory
 * metadata, never a security boundary — an absent hint stays the safe default
 * (assume the tool mutates). Unknown/!== true values never widen anything.
 */
export function normalizeAnnotations(a) {
  if (!a || typeof a !== "object") return null
  const out = {}
  if (typeof a.title === "string" && a.title) out.title = a.title.slice(0, 120)
  for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
    if (typeof a[k] === "boolean") out[k] = a[k]
  }
  return Object.keys(out).length ? out : null
}

/** A tool is read-only ONLY when the server explicitly says so. Absent or
 *  malformed annotations keep the historical assumption (mutating), so this
 *  can never silently promote an unannotated tool into a read-only context. */
export function readOnlyHinted(t) {
  return t?.annotations?.readOnlyHint === true
}

export function mcpToolsToPlugins(client, tools) {
  return tools.map((t) => {
    const name = mcpToolName(client.name, t.name)
    const params = normalizeSchema(t.inputSchema)
    return {
      name,
      readOnly: readOnlyHinted(t),
      annotations: normalizeAnnotations(t.annotations),
      def: {
        type: "function",
        function: {
          name,
          description: String(t.description || `${t.name} (via MCP server ${client.name})`).slice(0, 500),
          parameters: params,
        },
      },
      source: `mcp:${client.name}`,
      async run(args) {
        try {
          const r = await client.callTool(t.name, args)
          return r.isError ? `ERROR: ${r.text || "MCP tool reported an error"}` : (r.text || "(no output)")
        } catch (e) {
          return `ERROR: ${e.message}`
        }
      },
    }
  })
}

/** Coerce an MCP inputSchema into the JSON-schema object the tool layer expects. */
function normalizeSchema(schema) {
  if (schema && typeof schema === "object" && schema.type === "object") {
    return { type: "object", properties: schema.properties ?? {}, ...(Array.isArray(schema.required) ? { required: schema.required } : {}) }
  }
  return { type: "object", properties: {} }
}

/**
 * Connect every configured server, collect their tools as plugin objects, and
 * return { tools, clients, errors }. Best-effort: a server that fails to start
 * is recorded in `errors`, never thrown. The caller closes `clients` when done.
 *
 * v96 unifywise — LAZY CONNECT (§28 "lazy load; do not load every MCP tool
 * into every model context"): by default (`config.mcp.lazy !== false`,
 * `FORGE_MCP_LAZY=0` opts out) a server with a FRESH cached tool inventory
 * (~/.forge/cache/mcp-tools.json, TTL 24h, keyed by name+command so configs
 * never collide) is NOT spawned at agent start — its tool defs are advertised
 * from the cache and the server connects on the FIRST tool call. A cold or
 * stale cache connects immediately (exactly the old eager behavior), lists,
 * and refreshes the cache — so a first run is byte-identical with before, and
 * every later run pays the server startup only if its tools are actually
 * used. On the first call the freshly connected server's listTools is checked
 * against the cached names: a tool that vanished is an honest ERROR, and the
 * cache entry is dropped (never serve a phantom capability).
 */
export async function loadMcpTools(config, { timeoutMs } = {}) {
  const lazy = lazyEnabled(config)
  const out = { tools: [], clients: [], errors: [] }
  // per-call memo of lazily-connected servers: name → Promise<McpClient>
  const lazyClients = new Map()
  const ensureConnected = async (name, spec) => {
    if (!lazyClients.has(name)) {
      const p = connectServer(name, spec, { timeoutMs }).then(async (client) => {
        // refresh the inventory from the live server (cheap: it just started)
        try {
          const tools = await client.listTools()
          saveInventory(cacheKey(name, spec), name, tools)
        } catch { /* inventory refresh is best-effort; the call proceeds */ }
        return client
      })
      // v96: a REJECTED connect must not poison the memo for the whole session
      // (a transient server start failure would otherwise make every later
      // call reuse the rejection). Evict on failure so the next call retries.
      p.catch(() => lazyClients.delete(name))
      lazyClients.set(name, p)
    }
    return lazyClients.get(name)
  }
  const slots = [...configuredServers(config)].map(([name, spec]) => ({
    name, spec, inv: lazy ? freshInventory(name, spec) : null,
    tools: [], client: null, error: null,
  }))
  // v100: every COLD server handshakes in PARALLEL. These are independent child
  // processes, so the old sequential `await connectServer` per server made a
  // cold start pay the SUM of every server's startup (~300ms each → ~2.4s for
  // eight); it now costs the slowest one. Servers with a fresh cached inventory
  // are not spawned at all (v96 lazy connect), so they never enter this pass.
  await Promise.all(slots.filter((s) => !s.inv).map(async (s) => {
    let client
    try {
      client = await connectServer(s.name, s.spec, { timeoutMs })
    } catch (e) { s.error = `${s.name}: ${e.message}`; return }
    try {
      const tools = await client.listTools()
      if (lazy) saveInventory(cacheKey(s.name, s.spec), s.name, tools)
      s.client = client
      s.tools = mcpToolsToPlugins(client, tools)
    } catch (e) {
      s.error = `${s.name}: tools/list failed — ${e.message}`
      client.close()
    }
  }))
  // Assemble in CONFIG order: parallelism must never reorder the tool list
  // (tool order is part of what the model sees, and tests pin it).
  for (const s of slots) {
    const sname = s.name
    if (s.inv) {
      out.tools.push(...inventoryToPlugins(sname, s.spec, s.inv.tools, { ensureConnected, timeoutMs }))
      out.clients.push({
        name: sname,
        close() {
          const p = lazyClients.get(sname)
          if (!p) return
          lazyClients.delete(sname)
          Promise.resolve(p).then((c) => { try { c.close() } catch { /* already gone */ } }).catch(() => {})
        },
      })
      continue
    }
    if (s.error) { out.errors.push(s.error); continue }
    if (s.client) { out.clients.push(s.client); out.tools.push(...s.tools) }
  }
  return out
}

// --- v96 lazy-connect inventory cache --------------------------------------

const INVENTORY_TTL_MS = 24 * 60 * 60 * 1000
const MAX_CACHED_SERVERS = 64
const MAX_CACHED_TOOLS = 256

function lazyEnabled(config) {
  const env = String(process.env.FORGE_MCP_LAZY ?? "").toLowerCase()
  if (env === "0" || env === "false" || env === "off") return false
  if (config?.mcp && typeof config.mcp === "object" && config.mcp.lazy === false) return false
  return true
}

function inventoryPath() {
  return pathMod.join(resolveDataDir(), "cache", "mcp-tools.json")
}

/** Cache key = server name + command/args fingerprint: two configs that share
 *  a name but run different commands never collide (tests included). */
function cacheKey(name, spec) {
  const cmd = [spec.command, ...(spec.args ?? [])].join("\u0000")
  let h = 5381
  for (let i = 0; i < cmd.length; i++) h = ((h << 5) + h + cmd.charCodeAt(i)) | 0
  return `${name}:${(h >>> 0).toString(36)}`
}

function loadInventoryFile() {
  try {
    const j = JSON.parse(fsMod.readFileSync(inventoryPath(), "utf8"))
    if (j && j.v === 1 && j.servers && typeof j.servers === "object") return j
  } catch { /* absent/corrupt → cold cache */ }
  return { v: 1, servers: {} }
}

/** v97 §33: read-only view of the CACHED MCP tool inventory for capability
 *  resolution (the unified ladder). Never connects; a cold cache is an empty
 *  list, honestly. [{ server, tool, description }] */
export function cachedInventoryTools() {
  const out = []
  try {
    const inv = loadInventoryFile()
    for (const entry of Object.values(inv.servers ?? {})) {
      for (const t of entry.tools ?? []) {
        out.push({ server: entry.name ?? null, tool: t?.name, description: t?.description ?? "" })
      }
    }
  } catch { /* read-only, best-effort */ }
  return out.slice(0, 256)
}

function freshInventory(name, spec) {
  try {
    const entry = loadInventoryFile().servers[cacheKey(name, spec)]
    if (!entry || !Array.isArray(entry.tools)) return null
    const ttl = Number(process.env.FORGE_MCP_TTL_MS) > 0 ? Number(process.env.FORGE_MCP_TTL_MS) : INVENTORY_TTL_MS
    if (Date.now() - Number(entry.at ?? 0) >= ttl) return null
    return entry
  } catch { return null }
}

function saveInventory(key, name, tools) {
  try {
    const file = loadInventoryFile()
    file.servers[key] = {
      at: Date.now(), name,
      tools: (tools ?? []).slice(0, MAX_CACHED_TOOLS).map((t) => ({
        name: String(t?.name ?? "").slice(0, 200),
        description: String(t?.description ?? "").slice(0, 500),
        inputSchema: t?.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : undefined,
        annotations: normalizeAnnotations(t?.annotations) ?? undefined,
      })),
    }
    const keys = Object.keys(file.servers)
    if (keys.length > MAX_CACHED_SERVERS) {
      // drop the oldest entries (bounded cache, never unbounded growth)
      const byAge = keys.sort((a, b) => (file.servers[a].at ?? 0) - (file.servers[b].at ?? 0))
      for (const k of byAge.slice(0, keys.length - MAX_CACHED_SERVERS)) delete file.servers[k]
    }
    writeStateFile(inventoryPath(), JSON.stringify(file))
  } catch { /* cache is a speedup, never a correctness dependency */ }
}

function dropInventory(key) {
  try {
    const file = loadInventoryFile()
    if (file.servers[key]) { delete file.servers[key]; writeStateFile(inventoryPath(), JSON.stringify(file)) }
  } catch { }
}

/** Build LAZY plugin stubs from a cached inventory: same shape as
 *  mcpToolsToPlugins, but run() connects the server on first call. */
function inventoryToPlugins(name, spec, tools, { ensureConnected, timeoutMs }) {
  return (tools ?? []).map((t) => {
    const name2 = mcpToolName(name, t.name)
    const params = normalizeSchema(t.inputSchema)
    return {
      name: name2,
      readOnly: readOnlyHinted(t),
      annotations: normalizeAnnotations(t.annotations),
      def: {
        type: "function",
        function: {
          name: name2,
          description: String(t.description || `${t.name} (via MCP server ${name})`).slice(0, 500),
          parameters: params,
        },
      },
      source: `mcp:${name}`,
      async run(args) {
        try {
          const client = await ensureConnected(name, spec)
          // honesty check: the cached def must still exist on the live server
          try {
            const live = await client.listTools()
            if (!live.some((x) => String(x?.name) === String(t.name))) {
              dropInventory(cacheKey(name, spec))
              return `ERROR: mcp tool ${t.name} no longer exists on server ${name} (cached inventory dropped — restart to re-advertise the real tool set)`
            }
          } catch { /* listing failed; let the call itself speak */ }
          const r = await client.callTool(t.name, args)
          return r.isError ? `ERROR: ${r.text || "MCP tool reported an error"}` : (r.text || "(no output)")
        } catch (e) {
          return `ERROR: ${e.message}`
        }
      },
    }
  })
}
