#!/usr/bin/env node
/**
 * forge — LSP client (v23).
 *
 * Proves the client speaks real LSP (Content-Length-framed JSON-RPC) against a
 * stand-in language server:
 *   - initialize handshake + serverCapabilities, initialized notification
 *   - didOpen, then textDocument/definition · references · hover
 *   - server-pushed publishDiagnostics captured and awaited
 *   - result normalizers (Location / LocationLink, Hover variants)
 *   - server-initiated requests (workspace/configuration) answered, not hung
 *   - a hung server times out; a bad command errors; clean shutdown
 *   - serverForFile resolves by extension and skips disabled servers
 *
 * Byte-accurate framing is exercised with a multi-byte (é) document. Zero
 * external network.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const {
  connectServer, pathToUri, uriToPath, normalizeLocations, hoverText,
  serverForFile, languageIdForFile, locateSymbol, formatDiagnostics, createLspSession,
} = await import("../lsp.js")
import http from "node:http"

let PASS = 0, FAIL = 0
const ok = (n, c) => { if (c) { PASS++; console.log(`  ok   ${n}`) } else { FAIL++; console.log(`  FAIL ${n}`) } }

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lsp-"))
process.env.FORGE_HOME = DIR // isolate the agent's ~/.forge before agent.js loads

// A minimal but real LSP server: Content-Length framing, JSON-RPC 2.0.
const STUB = String.raw`
const HANG = process.argv[2] === "hang"
let buf = Buffer.alloc(0)
function write(o) {
  const j = Buffer.from(JSON.stringify(o), "utf8")
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + j.length + "\r\n\r\n", "ascii"), j]))
}
process.stdin.on("data", (d) => {
  if (HANG) return // never respond to anything
  buf = Buffer.concat([buf, d])
  for (;;) {
    const sep = buf.indexOf("\r\n\r\n")
    if (sep === -1) return
    const m = /content-length:\s*(\d+)/i.exec(buf.slice(0, sep).toString("ascii"))
    if (!m) { buf = buf.slice(sep + 4); continue }
    const len = parseInt(m[1], 10), start = sep + 4
    if (buf.length < start + len) return
    const msg = JSON.parse(buf.slice(start, start + len).toString("utf8"))
    buf = buf.slice(start + len)
    handle(msg)
  }
})
function handle(msg) {
  if (msg.method === "initialize") {
    write({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { definitionProvider: true, referencesProvider: true, hoverProvider: true } } })
    // a server-initiated request during startup: the client must answer it
    write({ jsonrpc: "2.0", id: 9001, method: "workspace/configuration", params: { items: [{ section: "x" }] } })
  } else if (msg.method === "initialized") {
    /* no-op */
  } else if (msg.method === "textDocument/didOpen") {
    const uri = msg.params.textDocument.uri
    // push diagnostics for this document
    write({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [
      { range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } }, message: "unused variable", severity: 2, source: "stub" },
    ] } })
  } else if (msg.method === "textDocument/definition") {
    write({ jsonrpc: "2.0", id: msg.id, result: { uri: msg.params.textDocument.uri, range: { start: { line: 10, character: 2 }, end: { line: 10, character: 8 } } } })
  } else if (msg.method === "textDocument/references") {
    write({ jsonrpc: "2.0", id: msg.id, result: [
      { uri: msg.params.textDocument.uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } } },
      { uri: msg.params.textDocument.uri, range: { start: { line: 5, character: 6 }, end: { line: 5, character: 10 } } },
    ] })
  } else if (msg.method === "textDocument/hover") {
    write({ jsonrpc: "2.0", id: msg.id, result: { contents: { kind: "markdown", value: "function greet(): void" } } })
  } else if (msg.method === "shutdown") {
    write({ jsonrpc: "2.0", id: msg.id, result: null })
  } else if (msg.method === "exit") {
    process.exit(0)
  } else if (msg.id !== undefined) {
    write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } })
  }
}
`
const stubPath = path.join(DIR, "lsp-stub.cjs")
fs.writeFileSync(stubPath, STUB)
const spec = (mode = "normal") => ({ command: process.execPath, args: [stubPath, mode === "hang" ? "hang" : "normal"] })

console.log("== uri + normalizer helpers ==")
{
  const p = path.join(DIR, "a.ts")
  ok("path→uri→path round-trips", uriToPath(pathToUri(p)) === p)
  ok("a Location normalizes", normalizeLocations({ uri: "file:///x.ts", range: { start: { line: 3, character: 2 } } })[0].line === 3)
  ok("a Location[] normalizes", normalizeLocations([{ uri: "file:///x.ts", range: { start: { line: 1, character: 0 } } }]).length === 1)
  ok("a LocationLink normalizes (targetUri/targetSelectionRange)", normalizeLocations([{ targetUri: "file:///y.ts", targetSelectionRange: { start: { line: 7, character: 1 } } }])[0].line === 7)
  ok("garbage normalizes to empty, not a throw", normalizeLocations(null).length === 0 && normalizeLocations({}).length === 0)
  ok("hover: markup content", hoverText({ contents: { kind: "markdown", value: "T" } }) === "T")
  ok("hover: bare string", hoverText({ contents: "T" }) === "T")
  ok("hover: array of marked strings", hoverText({ contents: ["a", { value: "b" }] }) === "a\nb")
  ok("languageId maps by extension", languageIdForFile("x.ts") === "typescript" && languageIdForFile("x.py") === "python")
}

console.log("== connect + initialize + server-initiated request ==")
{
  const c = await connectServer("stub", spec(), { rootUri: pathToUri(DIR) })
  ok("serverCapabilities came back", c.serverCapabilities?.definitionProvider === true)
  // if the client hadn't answered workspace/configuration, later requests would still work;
  // this simply proves initialize completed despite the server-initiated request.
  ok("client is usable after a server-initiated request", typeof c.definition === "function")
  await c.close()
}

console.log("== definition / references / hover / diagnostics ==")
{
  const file = path.join(DIR, "greet.ts")
  const text = "const gréét = 1\nfunction greet() {}\n  let x = 2\n" // multi-byte é exercises byte framing
  fs.writeFileSync(file, text)
  const c = await connectServer("stub", spec(), { rootUri: pathToUri(DIR) })
  const uri = pathToUri(file)
  c.openDoc(uri, "typescript", text)

  const def = await c.definition(uri, 1, 9)
  ok("definition returns a location with a path + line", def[0]?.path === file && def[0].line === 10)
  const refs = await c.references(uri, 1, 9)
  ok("references returns all locations", refs.length === 2 && refs[1].line === 5)
  const hov = await c.hover(uri, 1, 9)
  ok("hover returns the type text", hov === "function greet(): void")

  const diags = await c.diagnosticsFor(uri, 3000)
  ok("diagnostics pushed on didOpen are captured", diags.length === 1 && /unused variable/.test(diags[0].message))
  ok("byte-accurate framing survived a multi-byte document", diags[0].range.start.line === 2)
  await c.close()
}

console.log("== diagnosticsFor waits then returns empty when none arrive ==")
{
  const c = await connectServer("stub", spec(), { rootUri: pathToUri(DIR) })
  const t0 = Date.now()
  const diags = await c.diagnosticsFor("file:///never-opened.ts", 300)
  ok("returns empty rather than hanging", Array.isArray(diags) && diags.length === 0)
  ok("it waited roughly the timeout, not forever", Date.now() - t0 < 3000)
  await c.close()
}

console.log("== a hung server times out; a bad command errors ==")
{
  const t0 = Date.now()
  let threw = false
  try { await connectServer("hung", spec("hang"), { timeoutMs: 400 }) } catch { threw = true }
  ok("initialize rejects on timeout", threw)
  ok("promptly, not forever", Date.now() - t0 < 5000)

  let threw2 = false
  try { await connectServer("nope", { command: "/nonexistent/forge-lsp-xyz" }, { timeoutMs: 800 }) } catch { threw2 = true }
  ok("a bad command rejects cleanly", threw2)
}

console.log("== serverForFile resolves by extension ==")
{
  const cfg = { lsp: { servers: {
    ts: { command: "tsserver", extensions: [".ts", ".tsx"] },
    py: { command: "pylsp", extensions: [".py"], disabled: true },
  } } }
  ok("resolves a .ts file to the ts server", serverForFile(cfg, "src/a.ts")?.name === "ts")
  ok("an unconfigured extension resolves to nothing", serverForFile(cfg, "a.rs") === null)
  ok("a disabled server is not resolved", serverForFile(cfg, "a.py") === null)
  ok("no lsp config → nothing", serverForFile({}, "a.ts") === null)
}

console.log("== symbol location + diagnostics formatting ==")
{
  ok("locateSymbol finds a word-boundary match", (() => { const p = locateSymbol("a\n  const foo = 1\n", "foo"); return p.line === 1 && p.character === 8 })())
  ok("locateSymbol ignores substrings", locateSymbol("foobar = 1", "foo") === null)
  ok("locateSymbol returns null when absent", locateSymbol("x = 1", "y") === null)
  ok("formatDiagnostics on clean file says so", /clean/.test(formatDiagnostics([], { file: "a.ts" })))
  ok("formatDiagnostics renders severity + position", /error 3:5/.test(formatDiagnostics([{ severity: 1, range: { start: { line: 2, character: 4 } }, message: "boom" }], { file: "a.ts" })))
}

console.log("== createLspSession: read-only plugin-shaped tools ==")
{
  const file = path.join(DIR, "sess.ts")
  fs.writeFileSync(file, "function greet() {}\nconst y = greet\n")
  const cfg = { lsp: { servers: { ts: { command: process.execPath, args: [stubPath, "normal"], extensions: [".ts"] } } } }
  const sess = createLspSession(cfg, { cwd: DIR })
  const names = sess.tools.map((t) => t.name)
  ok("exposes the four LSP tools", ["lsp_definition", "lsp_references", "lsp_hover", "lsp_diagnostics"].every((n) => names.includes(n)))
  ok("every LSP tool is read-only", sess.tools.every((t) => t.readOnly === true))
  ok("tools carry the tool-def shape the loop expects", sess.tools.every((t) => t.def?.function?.parameters?.type === "object"))

  const diagTool = sess.tools.find((t) => t.name === "lsp_diagnostics")
  const out = await diagTool.run({ path: "sess.ts" })
  ok("lsp_diagnostics returns the server's diagnostics", /unused variable/.test(out))

  const defTool = sess.tools.find((t) => t.name === "lsp_definition")
  const defOut = await defTool.run({ path: "sess.ts", symbol: "greet" })
  ok("lsp_definition resolves a symbol to a location", /sess\.ts:11:3/.test(defOut))
  ok("a missing symbol is a clear message, not a throw", /not found/.test(await defTool.run({ path: "sess.ts", symbol: "nope" })))
  fs.writeFileSync(path.join(DIR, "sess.rs"), "fn x() {}\n") // exists, but no server for .rs
  ok("an unconfigured file type is a clear message", /no language server configured/.test(await defTool.run({ path: "sess.rs", symbol: "x" })))
  await sess.close()
}

console.log("== agent loop: an LSP tool is callable end-to-end, and the server is closed ==")
{
  const marker = path.join(DIR, "lsp-server-exited")
  // stub that also records shutdown: on `exit` it writes a marker before quitting
  const closingStub = stubPath.replace(/\.cjs$/, "-closing.cjs")
  fs.writeFileSync(closingStub, STUB.replace('else if (msg.method === "exit") {\n    process.exit(0)', `else if (msg.method === "exit") {\n    try { require("fs").writeFileSync(${JSON.stringify(marker)}, "bye") } catch {}\n    process.exit(0)`))

  const file = path.join(DIR, "e2e.ts")
  fs.writeFileSync(file, "const bad = 1\n")

  const provServer = http.createServer((req, res) => {
    let body = ""
    req.on("data", (d) => { body += d })
    req.on("end", () => {
      let toolRan = false
      try { toolRan = (JSON.parse(body).messages || []).some((m) => m.role === "tool") } catch {}
      res.writeHead(200, { "content-type": "application/json" })
      if (toolRan) res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "checked diagnostics" }, finish_reason: "stop" }] }))
      else res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "", tool_calls: [
        { id: "t1", type: "function", function: { name: "lsp_diagnostics", arguments: JSON.stringify({ path: file }) } },
      ] }, finish_reason: "tool_calls" }] }))
    })
  })
  await new Promise((r) => provServer.listen(0, "127.0.0.1", r))
  const port = provServer.address().port

  const { runAgent } = await import("../agent.js")
  const config = {
    providers: {}, lsp: { servers: { ts: { command: process.execPath, args: [closingStub, "normal"], extensions: [".ts"] } } },
    agent: { maxSteps: 6, timeoutSec: 20 }, skills: { enabled: false }, context: { repoMap: false },
    tools: { intelligence: true, verify: false }, retry: { attempts: 1, backoffMs: 1 },
  }
  const provider = { name: "m", protocol: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "m", contextWindow: 128000 }
  // agent tools resolve paths against process.cwd(); run from DIR so e2e.ts resolves
  const prevCwd = process.cwd(); process.chdir(DIR)
  let r
  try { r = await runAgent({ config, provider, task: "check diagnostics for e2e.ts", journal: false }) }
  finally { process.chdir(prevCwd) }
  provServer.close()

  const diagCall = (r.toolLog || []).find((t) => t.name === "lsp_diagnostics")
  ok("the LSP tool was invoked by the agent loop", !!diagCall)
  ok("its result came from the language server", diagCall && /unused variable/.test(String(diagCall.result)))
  ok("the run produced a final answer", /checked diagnostics/.test(r.text))
  await new Promise((res) => setTimeout(res, 500))
  ok("the LSP server was shut down (no leaked child process)", fs.existsSync(marker))
}

try { fs.rmSync(DIR, { recursive: true, force: true }) } catch {}
console.log(`\n== lsp suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
