/**
 * forge — Language Server Protocol (LSP) client (v23, zero dependencies)
 *
 * The biggest *code-understanding* gap vs. the largest agents: forge locates
 * code with a regex repo-map and BM25 keyword search. A language server gives
 * the real thing — go-to-definition, find-references, hover types, and compiler
 * diagnostics — computed by the same engine the user's editor uses. This is the
 * client; the read-only agent tools that sit on top of it (`definition`,
 * `references`, `hover_type`, `diagnostics`) are built in a separate step, and
 * diagnostics feed the verification ledger.
 *
 * Transport: LSP stdio — JSON-RPC 2.0 with `Content-Length` header framing
 * (NOT the newline framing MCP uses). Framing is byte-accurate (a header counts
 * bytes, not characters), so the read path accumulates Buffers, never strings.
 *
 * Trust model: a language server is launched from a command in the USER's
 * config (`lsp.servers`), never from model output — the same trust model as
 * plugins and MCP. Off by default. Every tool built on this is READ-ONLY: a
 * language server observes code, it never mutates it.
 */
import { spawn } from "node:child_process"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

const DEFAULT_TIMEOUT_MS = 20000
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024

export function pathToUri(p) {
  return pathToFileURL(path.resolve(p)).href
}
export function uriToPath(uri) {
  try { return fileURLToPath(uri) } catch { return uri }
}

class LspClient {
  constructor(name, { command, args = [], env = {}, cwd = process.cwd(), rootUri, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.name = name
    this.command = command
    this.args = Array.isArray(args) ? args : []
    this.env = env && typeof env === "object" ? env : {}
    this.cwd = cwd
    this.rootUri = rootUri || pathToUri(cwd)
    this.timeoutMs = timeoutMs
    this.child = null
    this._buf = Buffer.alloc(0)
    this._nextId = 1
    this._pending = new Map()
    this._closed = false
    this._exitReason = null
    this._open = new Map() // uri -> version
    this.diagnostics = new Map() // uri -> [{range, message, severity, source}]
    this._diagWaiters = new Map() // uri -> [resolve]
    this.serverCapabilities = null
  }

  _fail(reason) {
    this._closed = true
    this._exitReason = reason
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error(`LSP server "${this.name}" ${reason}`)) }
    this._pending.clear()
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk])
    if (this._buf.length > MAX_MESSAGE_BYTES) { this._buf = Buffer.alloc(0); this._fail("sent an over-long message"); try { this.child?.kill("SIGKILL") } catch {}; return }
    for (;;) {
      const sep = this._buf.indexOf("\r\n\r\n")
      if (sep === -1) return
      const header = this._buf.slice(0, sep).toString("ascii")
      const m = /content-length:\s*(\d+)/i.exec(header)
      if (!m) { this._buf = this._buf.slice(sep + 4); continue } // malformed header block — skip it
      const len = parseInt(m[1], 10)
      const start = sep + 4
      if (this._buf.length < start + len) return // wait for the full body
      const body = this._buf.slice(start, start + len).toString("utf8")
      this._buf = this._buf.slice(start + len)
      let msg
      try { msg = JSON.parse(body) } catch { continue }
      this._dispatch(msg)
    }
  }

  _dispatch(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id)
      this._pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(`LSP error ${msg.error.code}: ${msg.error.message || "unknown"}`))
      else p.resolve(msg.result)
      return
    }
    // Server-initiated request: a minimal client answers the few that block
    // initialization with a benign default, and null for the rest, so the
    // server never hangs waiting on us.
    if (msg.id !== undefined && msg.method) {
      let result = null
      if (msg.method === "workspace/configuration" && Array.isArray(msg.params?.items)) result = msg.params.items.map(() => ({}))
      else if (msg.method === "client/registerCapability" || msg.method === "client/unregisterCapability") result = null
      else if (msg.method === "workspace/workspaceFolders") result = [{ uri: this.rootUri, name: "root" }]
      else if (msg.method === "window/workDoneProgress/create") result = null
      this._write({ jsonrpc: "2.0", id: msg.id, result })
      return
    }
    // Notification.
    if (msg.method === "textDocument/publishDiagnostics" && msg.params?.uri) {
      const uri = msg.params.uri
      this.diagnostics.set(uri, Array.isArray(msg.params.diagnostics) ? msg.params.diagnostics : [])
      const waiters = this._diagWaiters.get(uri)
      if (waiters) { this._diagWaiters.delete(uri); for (const w of waiters) w() }
    }
  }

  _write(obj) {
    const json = Buffer.from(JSON.stringify(obj), "utf8")
    const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, "ascii")
    try { this.child.stdin.write(Buffer.concat([header, json])) } catch { /* closed */ }
  }

  _request(method, params) {
    if (this._closed) return Promise.reject(new Error(`LSP server "${this.name}" is closed (${this._exitReason || "not connected"})`))
    const id = this._nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._pending.delete(id); reject(new Error(`LSP request "${method}" to "${this.name}" timed out after ${this.timeoutMs}ms`)) }, this.timeoutMs)
      this._pending.set(id, { resolve, reject, timer })
      this._write({ jsonrpc: "2.0", id, method, params: params ?? {} })
    })
  }

  _notify(method, params) {
    if (this._closed) return
    this._write({ jsonrpc: "2.0", method, params: params ?? {} })
  }

  async start() {
    if (!this.command || typeof this.command !== "string") throw new Error(`LSP server "${this.name}" has no command`)
    this.child = spawn(this.command, this.args, { cwd: this.cwd, env: { ...process.env, ...this.env }, stdio: ["pipe", "pipe", "pipe"] })
    this.child.stdout.on("data", (d) => this._onData(d))
    this.child.on("error", (e) => this._fail(`could not launch (${e.message})`))
    this.child.on("exit", (code, sig) => this._fail(`exited (${sig || "code " + code})`))
    this.child.stderr.on("data", () => {})

    const res = await this._request("initialize", {
      processId: process.pid,
      rootUri: this.rootUri,
      workspaceFolders: [{ uri: this.rootUri, name: "root" }],
      clientInfo: { name: "forge", version: "23" },
      capabilities: {
        textDocument: {
          synchronization: { didSave: false, dynamicRegistration: false },
          hover: { contentFormat: ["plaintext", "markdown"] },
          definition: {}, references: {},
          publishDiagnostics: {},
        },
        workspace: { workspaceFolders: true, configuration: true },
      },
    })
    this.serverCapabilities = res?.capabilities ?? null
    this._notify("initialized", {})
    return this
  }

  /** Open a document so position-based requests and diagnostics work. */
  openDoc(uri, languageId, text) {
    if (this._open.has(uri)) return
    this._open.set(uri, 1)
    this._notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } })
  }

  async definition(uri, line, character) {
    return normalizeLocations(await this._request("textDocument/definition", { textDocument: { uri }, position: { line, character } }))
  }
  async references(uri, line, character, includeDeclaration = true) {
    return normalizeLocations(await this._request("textDocument/references", { textDocument: { uri }, position: { line, character }, context: { includeDeclaration } }))
  }
  async hover(uri, line, character) {
    const r = await this._request("textDocument/hover", { textDocument: { uri }, position: { line, character } })
    return hoverText(r)
  }

  /** Diagnostics for a URI. Waits up to `waitMs` for the server's first push. */
  async diagnosticsFor(uri, waitMs = 3000) {
    if (this.diagnostics.has(uri)) return this.diagnostics.get(uri)
    await new Promise((resolve) => {
      const arr = this._diagWaiters.get(uri) || []
      arr.push(resolve); this._diagWaiters.set(uri, arr)
      const t = setTimeout(() => {
        const w = this._diagWaiters.get(uri)
        if (w) { this._diagWaiters.set(uri, w.filter((x) => x !== resolve)); }
        resolve()
      }, waitMs)
      if (t.unref) t.unref()
    })
    return this.diagnostics.get(uri) || []
  }

  async close() {
    if (this._closed) return
    // Polite LSP shutdown: `shutdown` request then `exit` notification.
    try { await Promise.race([this._request("shutdown", null), new Promise((r) => setTimeout(r, 800))]) } catch {}
    try { this._notify("exit") } catch {}
    this._closed = true
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error(`LSP server "${this.name}" closed`)) }
    this._pending.clear()
    const child = this.child
    try { child?.stdin?.end() } catch {}
    if (child && child.exitCode === null && child.signalCode === null) {
      const t = setTimeout(() => { try { child.kill("SIGKILL") } catch {} }, 2000)
      if (t.unref) t.unref()
      child.once?.("exit", () => clearTimeout(t))
    }
  }
}

/** LSP Location | Location[] | LocationLink[] → [{ path, line, character }]. */
export function normalizeLocations(res) {
  if (!res) return []
  const arr = Array.isArray(res) ? res : [res]
  const out = []
  for (const loc of arr) {
    if (!loc || typeof loc !== "object") continue
    const uri = loc.uri || loc.targetUri
    const range = loc.range || loc.targetSelectionRange || loc.targetRange
    if (!uri || !range) continue
    out.push({ path: uriToPath(uri), line: range.start?.line ?? 0, character: range.start?.character ?? 0 })
  }
  return out
}

/** LSP Hover → plain text (handles MarkupContent, MarkedString, and arrays). */
export function hoverText(r) {
  if (!r || !r.contents) return ""
  const c = r.contents
  const one = (x) => (typeof x === "string" ? x : (x && typeof x === "object" ? (x.value ?? "") : ""))
  if (Array.isArray(c)) return c.map(one).filter(Boolean).join("\n").trim()
  return one(c).trim()
}

export async function connectServer(name, spec, { rootUri, timeoutMs } = {}) {
  const client = new LspClient(name, { ...spec, rootUri: rootUri ?? spec?.rootUri, timeoutMs: timeoutMs ?? spec?.timeoutMs })
  await client.start()
  return client
}

/** Resolve the configured server for a file, by extension. */
export function serverForFile(config, file) {
  const servers = config?.lsp?.servers
  if (!servers || typeof servers !== "object") return null
  const ext = path.extname(String(file || "")).toLowerCase()
  for (const [name, spec] of Object.entries(servers)) {
    if (!spec || spec.disabled === true || !spec.command) continue
    const exts = Array.isArray(spec.extensions) ? spec.extensions.map((e) => String(e).toLowerCase()) : []
    if (exts.includes(ext)) return { name, spec }
  }
  return null
}

export function languageIdForFile(file, spec) {
  if (spec?.languageId) return spec.languageId
  const ext = path.extname(String(file || "")).toLowerCase()
  const map = { ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact", ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".c": "c", ".cpp": "cpp", ".rb": "ruby" }
  return map[ext] || "plaintext"
}
