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
 * config (`lsp.servers`) or from the first-party AUTO-START table below (a
 * well-known binary that actually exists on the user's PATH — same trust
 * class as npm/cargo discovery), never from model output — the same trust
 * model as plugins and MCP. Every tool built on this is READ-ONLY: a
 * language server observes code, it never mutates it.
 */
import { spawn } from "node:child_process"
import { childEnv } from "./childenv.js"
import { VERSION } from "./version.js"
import fsMod from "node:fs"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

// A language-server request that blocks for 20s would stall an agent step that
// is meant to feel interactive: forge budgets 12s per request by default, and
// every caller may override it (spec.timeoutMs).
const DEFAULT_TIMEOUT_MS = 12000
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
    this._openText = new Map() // uri -> last-synced text
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
    this.child = spawn(this.command, this.args, { cwd: this.cwd, env: childEnv(this.env), stdio: ["pipe", "pipe", "pipe"] })
    this.child.stdout.on("data", (d) => this._onData(d))
    this.child.on("error", (e) => this._fail(`could not launch (${e.message})`))
    this.child.on("exit", (code, sig) => this._fail(`exited (${sig || "code " + code})`))
    this.child.stderr.on("data", () => {})

    const res = await this._request("initialize", {
      processId: process.pid,
      rootUri: this.rootUri,
      workspaceFolders: [{ uri: this.rootUri, name: "root" }],
      clientInfo: { name: "forge", version: VERSION },
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
    this._openText.set(uri, text)
    this._notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } })
  }

  /**
   * Ensure the server sees the CURRENT content of a document. Opens it if new;
   * if it is open but the text changed (an agent edited the file), sends a full
   * didChange and clears the cached diagnostics so `diagnosticsFor` waits for
   * the server's fresh push instead of returning stale results.
   */
  syncDoc(uri, languageId, text) {
    if (!this._open.has(uri)) { this.openDoc(uri, languageId, text); return }
    if (this._openText.get(uri) === text) return
    const version = (this._open.get(uri) || 1) + 1
    this._open.set(uri, version)
    this._openText.set(uri, text)
    this.diagnostics.delete(uri) // force a fresh wait on the next diagnosticsFor
    this._notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] })
  }

  async definition(uri, line, character) {
    return normalizeLocations(await this._request("textDocument/definition", { textDocument: { uri }, position: { line, character } }))
  }
  async references(uri, line, character, includeDeclaration = true) {
    return normalizeLocations(await this._request("textDocument/references", { textDocument: { uri }, position: { line, character }, context: { includeDeclaration } }))
  }
  /** §15 (v93 gap fix) — STRUCTURED symbol extraction via
   *  textDocument/documentSymbol. Handles both shapes servers return:
   *  hierarchical DocumentSymbol[] and flat SymbolInformation[]. */
  async documentSymbols(uri, languageId, text) {
    if (languageId && text != null) this.syncDoc(uri, languageId, text)
    return normalizeSymbols(await this._request("textDocument/documentSymbol", { textDocument: { uri } }))
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

/** SymbolKind → short label (LSP numbering). */
const SYMBOL_KIND = {
  1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method",
  7: "property", 8: "interface", 9: "constructor", 10: "enum", 11: "function",
  12: "function", 13: "variable", 14: "constant", 15: "string", 16: "number",
  17: "boolean", 18: "array", 19: "object", 20: "key", 21: "null", 22: "enummember",
  23: "struct", 24: "event", 25: "operator", 26: "typeparameter",
}

/** Normalize documentSymbol responses (hierarchical OR flat) to
 *  [{ name, kind, line }]. Never throws; malformed entries are dropped. */
export function normalizeSymbols(res) {
  const out = []
  const walk = (items) => {
    if (!Array.isArray(items)) return
    for (const it of items) {
      if (!it || typeof it.name !== "string") continue
      const line = it.range?.start?.line ?? it.location?.range?.start?.line ?? null
      out.push({ name: it.name, kind: SYMBOL_KIND[it.kind] ?? "symbol", line: typeof line === "number" ? line + 1 : null })
      if (Array.isArray(it.children) && it.children.length) walk(it.children)
    }
  }
  walk(res)
  return out.slice(0, 500) // bounded — a file with 500+ symbols is machine-generated
}

/** Resolve the configured server for a file, by extension. */
export function serverForFile(config, file) {
  const servers = config?.lsp?.servers
  const ext = path.extname(String(file || "")).toLowerCase()
  if (servers && typeof servers === "object") {
    for (const [name, spec] of Object.entries(servers)) {
      if (!spec || spec.disabled === true || !spec.command) continue
      const exts = Array.isArray(spec.extensions) ? spec.extensions.map((e) => String(e).toLowerCase()) : []
      if (exts.includes(ext)) return { name, spec }
    }
  }
  // v94 gapclose (TODO LSP): user config found nothing — consult the
  // first-party auto-start table (a real binary on PATH, or nothing).
  const auto = autoStartForFile(config, file)
  if (auto?.found) return { name: auto.found.name, spec: auto.found.spec, autoStarted: true }
  return null
}

// ---------------------------------------------------------------------------
// v94 gapclose — AUTO-START TABLE for the top languages.
//
// Before this, documentSymbol extraction fell back to lexical scanning unless
// the user had hand-written lsp.servers config — the structured path was the
// exception, not the default. The table below makes it the default for the
// most common languages WITHOUT inventing anything:
//
//   - a candidate is used only when its binary ACTUALLY EXISTS on PATH
//     (evidence, never a guess; the resolved absolute path is what spawns)
//   - user `lsp.servers` config ALWAYS wins over the table
//   - `lsp.autoStart: false` or FORGE_LSP_AUTOSTART=0 turns the table off
//   - the command list is first-party static config — the trust model is
//     unchanged: a language server is never launched from model output
//
// Same trust class as build-system discovery (npm/cargo on PATH): a well-known
// toolchain binary the user already installed.
// ---------------------------------------------------------------------------
export const AUTO_START_TABLE = [
  { name: "typescript", extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"], candidates: [{ command: "typescript-language-server", args: ["--stdio"] }] },
  { name: "python", extensions: [".py", ".pyi"], candidates: [{ command: "pyright-langserver", args: ["--stdio"] }, { command: "pylsp", args: [] }] },
  { name: "go", extensions: [".go"], candidates: [{ command: "gopls", args: [] }] },
  { name: "rust", extensions: [".rs"], candidates: [{ command: "rust-analyzer", args: [] }] },
]

const autoStartCache = new Map() // command -> resolved absolute path | null (PATH does not change mid-process; tests call resetAutoStartCache)

/** Drop the PATH-resolution cache (tests; a PATH change in a long session). */
export function resetAutoStartCache() { autoStartCache.clear() }

/** Absolute path of a command on PATH, or null. Existence + regular file is
 *  the evidence; a directory or a dangling name is never "found". */
function whichOnPath(command) {
  const cached = autoStartCache.get(command)
  if (cached !== undefined) return cached
  let resolved = null
  try {
    for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
      if (!dir) continue
      const cand = path.join(dir, command)
      try {
        const st = fsMod.statSync(cand)
        if (st.isFile()) { resolved = cand; break }
      } catch { /* not in this dir */ }
    }
  } catch { /* unreadable PATH entry — skip */ }
  autoStartCache.set(command, resolved)
  return resolved
}

export function autoStartEnabled(config) {
  if (process.env.FORGE_LSP_AUTOSTART === "0") return false
  if (config?.lsp?.autoStart === false) return false
  return true
}

/** Table entry for a file's extension (or null) — used for honest errors. */
function autoStartEntryFor(file) {
  const ext = path.extname(String(file || "")).toLowerCase()
  return AUTO_START_TABLE.find((e) => e.extensions.includes(ext)) ?? null
}

/** Which candidate commands WOULD be probed for this file — for the honest
 *  "probed PATH for X, Y (not found)" error line. [] when disabled/no entry. */
export function autoStartProbedFor(config, file) {
  if (!autoStartEnabled(config)) return []
  const entry = autoStartEntryFor(file)
  return entry ? entry.candidates.map((c) => c.command) : []
}

/** Resolve an auto-start server for a file: { found: {name, spec} | null }.
 *  Only a binary that exists on PATH is ever returned — never a hope. */
export function autoStartForFile(config, file) {
  if (!autoStartEnabled(config)) return null
  const entry = autoStartEntryFor(file)
  if (!entry) return null
  for (const cand of entry.candidates) {
    const bin = whichOnPath(cand.command)
    if (bin) return { found: { name: `auto:${entry.name}`, spec: { command: bin, args: cand.args, extensions: entry.extensions, languageId: undefined } } }
  }
  return { found: null }
}

export function languageIdForFile(file, spec) {
  if (spec?.languageId) return spec.languageId
  const ext = path.extname(String(file || "")).toLowerCase()
  const map = { ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact", ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".c": "c", ".cpp": "cpp", ".rb": "ruby" }
  return map[ext] || "plaintext"
}

// ---------------------------------------------------------------------------
// Agent tool layer (v23): read-only LSP tools over a per-run session.
// ---------------------------------------------------------------------------

const SEVERITY = { 1: "error", 2: "warning", 3: "info", 4: "hint" }

/** Escape a string for use inside a RegExp. */
function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") }

/** First word-boundary occurrence of `symbol` → { line, character } (0-based). */
export function locateSymbol(text, symbol) {
  if (!symbol) return null
  const re = new RegExp(`\\b${escapeRegExp(symbol)}\\b`)
  const lines = String(text).split("\n")
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].search(re)
    if (idx !== -1) return { line: i, character: idx }
  }
  return null
}

const rel = (cwd, p) => { try { return path.relative(cwd, p) || p } catch { return p } }

/** Format diagnostics as concise, bounded text for the model. */
export function formatDiagnostics(diags, { cwd = process.cwd(), file = "" } = {}) {
  if (!diags.length) return `no diagnostics for ${rel(cwd, file)} — the language server reports it clean`
  return diags.slice(0, 100).map((d) => {
    const ln = (d.range?.start?.line ?? 0) + 1, col = (d.range?.start?.character ?? 0) + 1
    const sev = SEVERITY[d.severity] || "note"
    const src = d.source ? ` [${d.source}]` : ""
    return `${sev} ${ln}:${col}${src} ${String(d.message).split("\n")[0]}`
  }).join("\n")
}

/**
 * A per-run LSP session: lazily starts ONE language server per configured
 * language (cached by server name, reused across tool calls), keeps documents
 * in sync with the file on disk, and is closed with the run. Returns
 * plugin-shaped, READ-ONLY tools so the agent loop treats them exactly like any
 * other tool (through the same safety choke point and capability registry).
 */
export function createLspSession(config, { cwd = process.cwd() } = {}) {
  const rootUri = pathToUri(cwd)
  const clients = new Map() // serverName -> Promise<client>
  const fs2 = fsMod

  async function resolve(file) {
    const abs = path.resolve(cwd, String(file || ""))
    if (!fs2.existsSync(abs)) return { error: `no such file: ${rel(cwd, abs)}` }
    const found = serverForFile(config, abs)
    if (!found) {
      // v94 gapclose: honest error — when the auto-start table covers this
      // extension, say exactly which binaries were probed on PATH and missed
      const probed = autoStartProbedFor(config, abs)
      return {
        error: probed.length
          ? `no language server available for ${path.extname(abs) || "this file type"} — PATH probed for ${probed.join(", ")} (not found); install one, configure lsp.servers, or use grep_files / read_file`
          : `no language server configured for ${path.extname(abs) || "this file type"} (configure lsp.servers, or use grep_files / read_file)`,
      }
    }
    if (!clients.has(found.name)) {
      clients.set(found.name, connectServer(found.name, found.spec, { rootUri }).catch((e) => { clients.delete(found.name); throw e }))
    }
    let client
    try { client = await clients.get(found.name) } catch (e) { return { error: `language server "${found.name}" failed to start: ${e.message}` } }
    let text
    try { text = fs2.readFileSync(abs, "utf8") } catch (e) { return { error: `could not read ${rel(cwd, abs)}: ${e.message}` } }
    client.syncDoc(pathToUri(abs), languageIdForFile(abs, found.spec), text)
    return { client, abs, uri: pathToUri(abs), text }
  }

  const needSymbol = async (args, fn) => {
    const r = await resolve(args?.path)
    if (r.error) return r.error
    const pos = locateSymbol(r.text, args?.symbol)
    if (!pos) return `symbol ${JSON.stringify(args?.symbol)} not found in ${rel(cwd, r.abs)}`
    return fn(r, pos)
  }

  const mkTool = (name, description, properties, required, run) => ({
    name, readOnly: true, source: "lsp",
    def: { type: "function", function: { name, description, parameters: { type: "object", properties, required } } },
    run,
  })

  const tools = [
    mkTool("lsp_definition", "Find where a symbol is defined (go-to-definition via the language server). Returns file:line locations.",
      { path: { type: "string" }, symbol: { type: "string", description: "identifier to resolve at its first occurrence in the file" } }, ["path", "symbol"],
      (args) => needSymbol(args, async (r, pos) => {
        const locs = await r.client.definition(r.uri, pos.line, pos.character)
        if (!locs.length) return `no definition found for ${args.symbol}`
        return locs.map((l) => `${rel(cwd, l.path)}:${l.line + 1}:${l.character + 1}`).join("\n")
      })),
    mkTool("lsp_references", "Find all references to a symbol (via the language server). Returns file:line locations.",
      { path: { type: "string" }, symbol: { type: "string" } }, ["path", "symbol"],
      (args) => needSymbol(args, async (r, pos) => {
        const locs = await r.client.references(r.uri, pos.line, pos.character, true)
        if (!locs.length) return `no references found for ${args.symbol}`
        return `${locs.length} reference(s):\n` + locs.slice(0, 200).map((l) => `${rel(cwd, l.path)}:${l.line + 1}:${l.character + 1}`).join("\n")
      })),
    mkTool("lsp_hover", "Get the type/signature/documentation of a symbol (hover via the language server).",
      { path: { type: "string" }, symbol: { type: "string" } }, ["path", "symbol"],
      (args) => needSymbol(args, async (r, pos) => {
        const h = await r.client.hover(r.uri, pos.line, pos.character)
        return h || `no hover information for ${args.symbol}`
      })),
    mkTool("lsp_diagnostics", "Get compiler/linter diagnostics (errors and warnings) for a file from the language server.",
      { path: { type: "string" } }, ["path"],
      async (args) => {
        const r = await resolve(args?.path)
        if (r.error) return r.error
        const diags = await r.client.diagnosticsFor(r.uri, 4000)
        return formatDiagnostics(diags, { cwd, file: r.abs })
      }),
  ]

  return {
    tools,
    async close() {
      for (const p of clients.values()) {
        try { const c = await p; await c.close() } catch {}
      }
      clients.clear()
    },
  }
}

/**
 * Run `lsp_diagnostics` on each changed file that has a configured language
 * server and return `{ file, text, passed, errorCount }[]` for the
 * verification ledger. Error-severity diagnostics fail (`passed: false`);
 * warnings/info/clean pass. A missing/unconfigured/failed server is skipped
 * (not a gate failure — LSP is optional evidence). Off when `lsp.servers`
 * is empty AND the auto-start table finds no real binary on PATH. Caller
 * does not own the session.
 */
export async function collectDiagnosticsForFiles(config, files, { cwd = process.cwd() } = {}) {
  const out = []
  // v94 gapclose: diagnostics run when EITHER the user configured servers OR
  // the auto-start table can resolve a real binary on PATH (serverForFile
  // below is auto-start aware). No config and no binary → still off.
  const hasConfigured = config?.lsp?.servers && typeof config.lsp.servers === "object" && Object.keys(config.lsp.servers).length > 0
  if (!hasConfigured && !autoStartEnabled(config)) return out
  const wanted = []
  const seen = new Set()
  for (const f of files || []) {
    const abs = path.resolve(cwd, String(f))
    if (seen.has(abs)) continue
    seen.add(abs)
    if (!serverForFile(config, abs)) continue
    try { if (!fsMod.existsSync(abs)) continue } catch { continue }
    wanted.push(abs)
  }
  if (!wanted.length) return out
  const session = createLspSession(config, { cwd })
  try {
    const tool = session.tools.find((t) => t.name === "lsp_diagnostics")
    if (!tool) return out
    for (const abs of wanted) {
      let text
      try { text = String(await tool.run({ path: abs })) } catch (e) { text = `ERROR: ${e?.message ?? e}` }
      if (/^no such file|^no language server (configured|available)|^language server ".*" failed to start|^ERROR:/.test(text)) continue
      const errorCount = (text.match(/^error /gm) || []).length
      out.push({ file: abs, text, passed: errorCount === 0, errorCount })
    }
  } finally {
    try { await session.close() } catch {}
  }
  return out
}
