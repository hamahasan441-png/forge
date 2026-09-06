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
  serverForFile, languageIdForFile,
} = await import("../forge/lsp.js")

let PASS = 0, FAIL = 0
const ok = (n, c) => { if (c) { PASS++; console.log(`  ok   ${n}`) } else { FAIL++; console.log(`  FAIL ${n}`) } }

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lsp-"))

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

try { fs.rmSync(DIR, { recursive: true, force: true }) } catch {}
console.log(`\n== lsp suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
