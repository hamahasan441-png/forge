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
import { createHash } from "node:crypto"
import { pinnedFetch } from "./netguard.js"
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

function resolvedBinding(binding, base, server, target) {
  if (binding === undefined || binding === null) return null
  if (typeof binding !== "object" || Array.isArray(binding)) return String(binding)
  const envName = typeof binding.env === "string" ? binding.env.trim() : ""
  if (!envName) return null
  const value = base?.[envName]
  if (value === undefined || value === "") {
    if (binding.required === true) throw new Error(`MCP server "${server}" requires environment variable ${envName} for ${target}`)
    return null
  }
  return `${String(binding.prefix ?? "")}${String(value)}${String(binding.suffix ?? "")}`
}

/** Resolve config environment references without persisting or logging values. */
export function resolveMcpEnvironment(declared = {}, base = process.env, server = "unknown") {
  const out = {}
  for (const [name, binding] of Object.entries(declared || {})) {
    const value = resolvedBinding(binding, base, server, `environment variable ${name}`)
    if (value !== null) out[name] = value
  }
  return out
}

/** Resolve HTTP header environment references immediately before a request. */
export function resolveMcpHeaders(declared = {}, base = process.env, server = "unknown") {
  const out = {}
  for (const [name, binding] of Object.entries(declared || {})) {
    const value = resolvedBinding(binding, base, server, `HTTP header ${name}`)
    if (value !== null) out[name] = value
  }
  return out
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
    this.env = resolveMcpEnvironment(env && typeof env === "object" ? env : {}, process.env, name)
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

  async listResources() {
    const res = await this._request("resources/list", {})
    return normalizeResources(res)
  }

  async readResource(uri) {
    const res = await this._request("resources/read", { uri })
    return flattenResourceContents(res)
  }

  async listPrompts() {
    const res = await this._request("prompts/list", {})
    return normalizePrompts(res)
  }

  async getPrompt(name, args) {
    const res = await this._request("prompts/get", { name, arguments: args ?? {} })
    return flattenPromptMessages(res)
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

/**
 * One MCP server reached over Streamable HTTP (spec 2025-03-26) instead of
 * stdio. Same public surface as the stdio client — name / serverInfo /
 * capabilities / listTools() / callTool() / close() — so everything downstream
 * (mcpToolsToPlugins, the inventory cache, the capability fabric) is unchanged.
 *
 * Why this exists: forge was stdio-only, which meant every HOSTED MCP server
 * (the bulk of the ecosystem — Linear, Notion, Sentry, remote GitHub) was
 * simply unreachable, no matter how it was configured.
 *
 * Every request goes through netguard.pinnedFetch, so a remote endpoint gets
 * the same DNS-pinning / private-address / redirect protection as any other
 * outbound URL. A server on a private address (a local dev stack) requires the
 * same explicit opt-in as any other private fetch — never an implicit one.
 *
 * The endpoint may answer a POST with either `application/json` (one response)
 * or `text/event-stream` (SSE frames); both are handled. We are a minimal
 * client: we issue requests and read responses, and ignore server-initiated
 * traffic, exactly like the stdio client.
 */
class McpHttpClient {
  constructor(name, { url, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, allowPrivate = false } = {}) {
    this.name = name
    this.url = String(url || "")
    this.extraHeaders = headers && typeof headers === "object" ? headers : {}
    this.timeoutMs = timeoutMs
    this.allowPrivate = allowPrivate === true
    this._nextId = 1
    this._closed = false
    this._sessionId = null
    this.serverInfo = null
    this.capabilities = null
  }

  _headers(extra = {}) {
    const h = {
      "content-type": "application/json",
      // both response shapes are acceptable to us
      accept: "application/json, text/event-stream",
      "user-agent": `forge-agent/${VERSION}`,
      ...resolveMcpHeaders(this.extraHeaders, process.env, this.name),
      ...extra,
    }
    if (this._sessionId) h["mcp-session-id"] = this._sessionId
    return h
  }

  /** Pull the JSON-RPC payload out of an SSE stream: the first `data:` frame
   *  carrying a JSON object with our id. Non-data lines are protocol noise. */
  static parseSse(text) {
    const out = []
    for (const block of String(text ?? "").split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
      if (!data) continue
      try { out.push(JSON.parse(data)) } catch { /* a non-JSON frame is noise */ }
    }
    return out
  }

  async _rpc(method, params, { notify = false } = {}) {
    if (this._closed) throw new Error(`MCP server "${this.name}" is closed`)
    const id = notify ? undefined : this._nextId++
    const payload = { jsonrpc: "2.0", method, params: params ?? {}, ...(notify ? {} : { id }) }
    let res
    try {
      res = await pinnedFetch(this.url, {
        method: "POST",
        headers: this._headers(),
        body: Buffer.from(JSON.stringify(payload)),
        timeoutMs: this.timeoutMs,
        totalTimeoutMs: this.timeoutMs,
        allowPrivate: this.allowPrivate ? "first-hop" : false,
        maxBytes: MAX_LINE_BYTES,
      })
    } catch (e) {
      throw new Error(`MCP HTTP request "${method}" to "${this.name}" failed: ${e.message}`)
    }
    // the server may hand us a session id on initialize; echo it from then on
    const sid = res.headers?.["mcp-session-id"]
    if (sid && !this._sessionId) this._sessionId = String(sid)
    if (notify) return null
    if (!res.ok) throw new Error(`MCP HTTP ${res.status} from "${this.name}" for "${method}"`)
    const ctype = String(res.headers?.["content-type"] ?? "")
    const text = res.body?.toString("utf8") ?? ""
    let msg = null
    if (/text\/event-stream/i.test(ctype)) {
      msg = McpHttpClient.parseSse(text).find((m) => m && m.id === id) ?? null
    } else {
      try { msg = JSON.parse(text) } catch { msg = null }
      if (Array.isArray(msg)) msg = msg.find((m) => m && m.id === id) ?? null
    }
    if (!msg) throw new Error(`MCP HTTP response from "${this.name}" for "${method}" was not a JSON-RPC result`)
    if (msg.error) throw new Error(`MCP error ${msg.error.code}: ${msg.error.message || "unknown"}`)
    return msg.result
  }

  async start() {
    if (!/^https?:\/\//i.test(this.url)) throw new Error(`MCP server "${this.name}" has an invalid url`)
    const init = await this._rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "forge", version: VERSION },
    })
    this.serverInfo = init?.serverInfo ?? null
    this.capabilities = init?.capabilities ?? null
    try { await this._rpc("notifications/initialized", {}, { notify: true }) } catch { /* best-effort, matches stdio */ }
    return this
  }

  async listTools() {
    const res = await this._rpc("tools/list", {})
    const tools = Array.isArray(res?.tools) ? res.tools : []
    return tools.filter((t) => t && typeof t.name === "string")
  }

  async callTool(tool, args) {
    const res = await this._rpc("tools/call", { name: tool, arguments: args ?? {} })
    return { text: flattenContent(res?.content), isError: res?.isError === true }
  }

  async listResources() { return normalizeResources(await this._rpc("resources/list", {})) }
  async readResource(uri) { return flattenResourceContents(await this._rpc("resources/read", { uri })) }
  async listPrompts() { return normalizePrompts(await this._rpc("prompts/list", {})) }
  async getPrompt(name, args) { return flattenPromptMessages(await this._rpc("prompts/get", { name, arguments: args ?? {} })) }

  close() {
    // HTTP is stateless per request: there is no child to reap. Marking closed
    // makes later calls fail honestly instead of silently reconnecting.
    this._closed = true
  }
}

/** `resources/list` → a bounded [{uri, name, description, mimeType}]. */
export function normalizeResources(res) {
  const list = Array.isArray(res?.resources) ? res.resources : []
  return list.filter((r) => r && typeof r.uri === "string").slice(0, 200).map((r) => ({
    uri: String(r.uri).slice(0, 500),
    name: String(r.name ?? "").slice(0, 200),
    description: String(r.description ?? "").slice(0, 300),
    mimeType: String(r.mimeType ?? "").slice(0, 100),
  }))
}

/** `prompts/list` → a bounded [{name, description}]. */
export function normalizePrompts(res) {
  const list = Array.isArray(res?.prompts) ? res.prompts : []
  return list.filter((p) => p && typeof p.name === "string").slice(0, 200).map((p) => ({
    name: String(p.name).slice(0, 200),
    description: String(p.description ?? "").slice(0, 300),
  }))
}

/** `resources/read` → the contents flattened to text, honestly labeled when a
 *  part is binary (blob) rather than silently dropped. */
export function flattenResourceContents(res) {
  const parts = Array.isArray(res?.contents) ? res.contents : []
  const out = []
  for (const c of parts) {
    if (!c || typeof c !== "object") continue
    if (typeof c.text === "string") out.push(c.text)
    else if (typeof c.blob === "string") out.push(`[binary resource ${c.mimeType || "data"}, ${c.blob.length} base64 chars — not inlined]`)
  }
  return out.join("\n")
}

/** `prompts/get` → the prompt's messages flattened to readable text. */
export function flattenPromptMessages(res) {
  const msgs = Array.isArray(res?.messages) ? res.messages : []
  const out = []
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue
    const body = typeof m.content === "string" ? m.content : flattenContent(m.content?.type ? [m.content] : m.content)
    out.push(`${String(m.role ?? "user")}: ${body}`)
  }
  return out.join("\n\n")
}

/**
 * One synthetic READ-ONLY tool per server that advertises resources and/or
 * prompts. MCP exposes three primitives — tools, resources, prompts — and forge
 * consumed only the first, so a server's documents, schemas and canned prompts
 * were invisible. Folding them into ONE tool per server (instead of one tool
 * per resource) keeps the context cost flat no matter how many resources a
 * server publishes, and read-only means the crew can use it too.
 */
export function mcpContextTool(client, caps) {
  const hasRes = Boolean(caps?.resources)
  const hasPrompts = Boolean(caps?.prompts)
  if (!hasRes && !hasPrompts) return null
  const name = mcpToolName(client.name, "context")
  const actions = [...(hasRes ? ["list_resources", "read_resource"] : []), ...(hasPrompts ? ["list_prompts", "get_prompt"] : [])]
  return {
    name,
    readOnly: true,
    annotations: { readOnlyHint: true },
    def: {
      type: "function",
      function: {
        name,
        description: `Read-only access to the documents and canned prompts published by MCP server "${client.name}". Actions: ${actions.join(", ")}.`,
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: actions },
            uri: { type: "string", description: "resource uri (read_resource)" },
            name: { type: "string", description: "prompt name (get_prompt)" },
          },
          required: ["action"],
        },
      },
    },
    source: `mcp:${client.name}`,
    async run(args) {
      const action = String(args?.action ?? "")
      try {
        if (action === "list_resources") {
          const r = await client.listResources()
          return r.length ? r.map((x) => `${x.uri}${x.name ? ` — ${x.name}` : ""}${x.mimeType ? ` [${x.mimeType}]` : ""}`).join("\n") : "(no resources published)"
        }
        if (action === "read_resource") {
          if (!args?.uri) return "ERROR: read_resource needs a uri"
          return (await client.readResource(String(args.uri))) || "(empty resource)"
        }
        if (action === "list_prompts") {
          const p = await client.listPrompts()
          return p.length ? p.map((x) => `${x.name}${x.description ? ` — ${x.description}` : ""}`).join("\n") : "(no prompts published)"
        }
        if (action === "get_prompt") {
          if (!args?.name) return "ERROR: get_prompt needs a name"
          return (await client.getPrompt(String(args.name), args?.arguments)) || "(empty prompt)"
        }
        return `ERROR: unknown action "${action}" — expected one of ${actions.join(", ")}`
      } catch (e) {
        return `ERROR: ${e.message}`
      }
    },
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
  // Transport is chosen by the SHAPE of the spec: a `url` is Streamable HTTP,
  // a `command` is stdio. Never guessed from anything else.
  const client = spec?.url
    ? new McpHttpClient(name, { ...spec, timeoutMs: timeoutMs ?? spec?.timeoutMs })
    : new McpClient(name, { ...spec, timeoutMs: timeoutMs ?? spec?.timeoutMs })
  await client.start()
  return client
}

/** The configured, non-disabled servers as [name, spec] pairs. */
export function configuredServers(config) {
  const servers = config?.mcp?.servers
  if (!servers || typeof servers !== "object") return []
  return Object.entries(servers).filter(([, s]) => s && typeof s === "object" && s.disabled !== true && (s.command || s.url))
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
  // Property ACCESS is the risk, not just the value: a getter can throw. This
  // object came off the wire, so reading it is the untrusted step — an
  // exception here would take down the whole tool-load for one bad server.
  try {
    if (typeof a.title === "string" && a.title) out.title = a.title.slice(0, 120)
  } catch { /* unreadable title → no title */ }
  for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
    try { if (typeof a[k] === "boolean") out[k] = a[k] } catch { /* unreadable hint → absent, i.e. the safe default */ }
  }
  return Object.keys(out).length ? out : null
}

/** A tool is read-only ONLY when the server explicitly says so. Absent or
 *  malformed annotations keep the historical assumption (mutating), so this
 *  can never silently promote an unannotated tool into a read-only context. */
export function readOnlyHinted(t) {
  // Same untrusted-access rule as normalizeAnnotations: a throwing getter must
  // not escape. Anything unreadable falls back to the SAFE default (mutating),
  // so a hostile server can never promote its tool into a read-only context.
  try { return t?.annotations?.readOnlyHint === true } catch { return false }
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
export async function loadMcpTools(config, { timeoutMs, cachedOnly = false } = {}) {
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
          saveInventory(cacheKey(name, spec), name, tools, client.capabilities)
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
  await Promise.all(slots.filter((s) => !s.inv && !cachedOnly).map(async (s) => {
    let client
    try {
      client = await connectServer(s.name, s.spec, { timeoutMs })
    } catch (e) { s.error = `${s.name}: ${e.message}`; return }
    try {
      const tools = await client.listTools()
      if (lazy) saveInventory(cacheKey(s.name, s.spec), s.name, tools, client.capabilities)
      s.client = client
      const ctx = mcpContextTool(client, client.capabilities)
      s.tools = [...mcpToolsToPlugins(client, tools), ...(ctx ? [ctx] : [])]
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
      if (s.inv.caps?.resources || s.inv.caps?.prompts) {
        // a lazy stand-in: the same read-only context tool, but it connects the
        // server on first use exactly like every other lazy stub
        const lazyClient = {
          name: sname,
          listResources: async () => (await ensureConnected(sname, s.spec)).listResources(),
          readResource: async (u) => (await ensureConnected(sname, s.spec)).readResource(u),
          listPrompts: async () => (await ensureConnected(sname, s.spec)).listPrompts(),
          getPrompt: async (n, a) => (await ensureConnected(sname, s.spec)).getPrompt(n, a),
        }
        const ctx = mcpContextTool(lazyClient, s.inv.caps)
        if (ctx) out.tools.push(ctx)
      }
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
    if (cachedOnly) {
      // v100: cache-only callers (delegated sub-agents) never pay a server
      // handshake. A server with no fresh inventory is skipped HONESTLY rather
      // than spawned — the crew simply has fewer tools this run, never a stall.
      out.errors.push(`${sname}: skipped (cache-only: no fresh tool inventory)`)
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
  // Include binding SHAPES so two accounts/configurations do not share an
  // inventory accidentally. Only the resulting hash is persisted; literal
  // credential values, when used by legacy configs, never leave memory.
  const shape = JSON.stringify({ url: spec.url || null, command: spec.command || null, args: spec.args || [], env: spec.env || {}, headers: spec.headers || {} })
  return `${name}:${createHash("sha256").update(shape).digest("hex").slice(0, 16)}`
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

function saveInventory(key, name, tools, caps = null) {
  try {
    const file = loadInventoryFile()
    file.servers[key] = {
      at: Date.now(), name,
      // remember WHICH primitives the server offers, so the lazy path can
      // advertise the read-only context tool without a handshake
      caps: caps && typeof caps === "object"
        ? { resources: Boolean(caps.resources), prompts: Boolean(caps.prompts) }
        : undefined,
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
