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
      env: { ...process.env, ...this.env },
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
      clientInfo: { name: "forge", version: "23" },
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
    try { this._notify("notifications/cancelled") } catch {}
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error(`MCP server "${this.name}" closed`)) }
    this._pending.clear()
    try { this.child?.stdin?.end() } catch {}
    try { this.child?.kill() } catch {}
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
 * Names are namespaced; MCP tools are WRITE-class (readOnly:false) by default.
 * The returned `run(args)` calls the server and returns a string; an MCP
 * `isError` result is surfaced as an "ERROR:" string, matching how the tool
 * layer marks failures (never thrown into the loop).
 */
export function mcpToolsToPlugins(client, tools) {
  return tools.map((t) => {
    const name = mcpToolName(client.name, t.name)
    const params = normalizeSchema(t.inputSchema)
    return {
      name,
      readOnly: false, // assume side effects unless a future annotation says otherwise
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
 */
export async function loadMcpTools(config, { timeoutMs } = {}) {
  const out = { tools: [], clients: [], errors: [] }
  for (const [name, spec] of configuredServers(config)) {
    let client
    try {
      client = await connectServer(name, spec, { timeoutMs })
    } catch (e) {
      out.errors.push(`${name}: ${e.message}`)
      continue
    }
    try {
      const tools = await client.listTools()
      out.clients.push(client)
      out.tools.push(...mcpToolsToPlugins(client, tools))
    } catch (e) {
      out.errors.push(`${name}: tools/list failed — ${e.message}`)
      client.close()
    }
  }
  return out
}
