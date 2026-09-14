#!/usr/bin/env node
/**
 * v94 gapclose — LSP AUTO-START table (TODO LSP).
 *
 * Before: documentSymbol extraction fell back to lexical scanning unless the
 * user had hand-configured lsp.servers — the structured path was the
 * exception. Now a first-party table (typescript-language-server,
 * pyright-langserver/pylsp, gopls, rust-analyzer) is consulted when config is
 * absent, and a candidate is used ONLY when its binary actually exists on
 * PATH (evidence, never invention). User config always wins;
 * FORGE_LSP_AUTOSTART=0 / lsp.autoStart:false turn it off; a missing binary
 * produces an honest "PATH probed for X (not found)" error.
 *
 * Proven end-to-end against a REAL (stub) language server binary placed on
 * PATH: spawn → initialize → didOpen → documentSymbol / publishDiagnostics,
 * including langadapter.extractStructured reporting layer-3 provenance.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lspauto-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lspauto-work-"))
const BIN = path.join(HOME, "bin")
fs.mkdirSync(BIN, { recursive: true })

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 260) : ""}`) }
}

// --- a minimal but REAL LSP server (Content-Length framed JSON-RPC 2.0) -----
const STUB = String.raw`
let buf = Buffer.alloc(0)
function write(o) {
  const j = Buffer.from(JSON.stringify(o), "utf8")
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + j.length + "\r\n\r\n", "ascii"), j]))
}
process.stdin.on("data", (d) => {
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
    write({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { definitionProvider: true, documentSymbolProvider: true, textDocumentSync: 1 } } })
  } else if (msg.method === "textDocument/didOpen") {
    write({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: msg.params.textDocument.uri, diagnostics: [] } })
  } else if (msg.method === "textDocument/documentSymbol") {
    write({ jsonrpc: "2.0", id: msg.id, result: [
      { name: "mainFunc", kind: 12, range: { start: { line: 0, character: 5 }, end: { line: 0, character: 13 } } },
      { name: "Helper", kind: 23, range: { start: { line: 3, character: 5 }, end: { line: 3, character: 11 } } },
    ] })
  } else if (msg.method === "shutdown") {
    write({ jsonrpc: "2.0", id: msg.id, result: null })
  } else if (msg.method === "exit") {
    process.exit(0)
  } else if (msg.id !== undefined) {
    write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } })
  }
}
`
const stubPath = path.join(HOME, "stub-lsp.cjs")
fs.writeFileSync(stubPath, STUB)
// the fake toolchain binaries: named exactly like the table's candidates
for (const name of ["gopls", "pylsp"]) {
  const bin = path.join(BIN, name)
  fs.writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stubPath)} "$@"\n`)
  fs.chmodSync(bin, 0o755)
}
// a real .go file to extract symbols from
const goFile = path.join(WORK, "main.go")
fs.writeFileSync(goFile, "package main\n\nfunc mainFunc() {}\n\ntype Helper struct{}\n")

const { serverForFile, autoStartForFile, autoStartProbedFor, autoStartEnabled, resetAutoStartCache, createLspSession, collectDiagnosticsForFiles, AUTO_START_TABLE } = await import("../lsp.js")
const { extractStructured } = await import("../langadapter.js")

const ORIG_PATH = process.env.PATH
const withBin = () => { process.env.PATH = BIN + path.delimiter + ORIG_PATH; resetAutoStartCache() }
const withoutBin = () => { process.env.PATH = ORIG_PATH; resetAutoStartCache() }

console.log("== table shape: first-party, static, honest ==")
{
  ok("table covers the four TODO languages", ["typescript", "python", "go", "rust"].every((n) => AUTO_START_TABLE.some((e) => e.name === n)), JSON.stringify(AUTO_START_TABLE.map((e) => e.name)))
  ok("every candidate is a plain command name (resolved via PATH, never a shell string)", AUTO_START_TABLE.every((e) => e.candidates.every((c) => typeof c.command === "string" && !/[|&;$<>]/.test(c.command) && Array.isArray(c.args))))
}

console.log("== resolution: evidence (binary on PATH) or nothing ==")
{
  withoutBin()
  ok("no binary on PATH → null (never a hope)", serverForFile({}, goFile) === null)
  ok("probed list still tells the truth for errors", JSON.stringify(autoStartProbedFor({}, goFile)) === JSON.stringify(["gopls"]), JSON.stringify(autoStartProbedFor({}, goFile)))
  withBin()
  const found = serverForFile({}, goFile)
  ok("gopls on PATH → auto:go resolved", !!found && found.name === "auto:go" && found.autoStarted === true, JSON.stringify(found))
  ok("spec carries the RESOLVED ABSOLUTE binary (evidence)", found.spec.command === path.join(BIN, "gopls"), JSON.stringify(found.spec))
  // python: first candidate (pyright-langserver) missing → second (pylsp) wins
  const py = serverForFile({}, path.join(WORK, "x.py"))
  ok("candidate order honored: pylsp used when pyright-langserver is absent", !!py && py.name === "auto:python" && py.spec.command === path.join(BIN, "pylsp"), JSON.stringify(py))
  // unknown extension → null even with bins on PATH
  ok("unknown extension → null", serverForFile({}, path.join(WORK, "x.zzz")) === null)
  ok("unknown extension probes nothing", autoStartProbedFor({}, path.join(WORK, "x.zzz")).length === 0)
}

console.log("== user config ALWAYS wins; kill switches work ==")
{
  withBin()
  const cfg = { lsp: { servers: { mygo: { command: "/usr/bin/true", args: [], extensions: [".go"] } } } }
  const found = serverForFile(cfg, goFile)
  ok("configured server beats the table", found.name === "mygo" && !found.autoStarted, JSON.stringify(found))
  process.env.FORGE_LSP_AUTOSTART = "0"
  ok("FORGE_LSP_AUTOSTART=0 disables the table", serverForFile({}, goFile) === null && autoStartEnabled({}) === false)
  ok("…and the probe list empties (error text won't lie about probing)", autoStartProbedFor({}, goFile).length === 0)
  delete process.env.FORGE_LSP_AUTOSTART
  ok("lsp.autoStart:false disables the table", serverForFile({ lsp: { autoStart: false } }, goFile) === null)
  ok("config server still resolves while auto-start is off", serverForFile({ lsp: { autoStart: false, servers: cfg.lsp.servers } }, goFile)?.name === "mygo")
}

console.log("== END-TO-END: structured extraction defaults to the auto-started server ==")
{
  withBin()
  const ex = await extractStructured("main.go", fs.readFileSync(goFile, "utf8"), { config: {}, cwd: WORK })
  ok("symbols came from the SERVER, not regex", ex.provenance.layer === 3 && ex.provenance.source === "lsp:auto:go", JSON.stringify(ex.provenance))
  ok("real documentSymbol payload normalized", ex.symbols.includes("mainFunc") && ex.symbols.includes("Helper") && ex.fallback === null, JSON.stringify(ex))
  // session tools: diagnostics through the auto-started server
  const session = createLspSession({}, { cwd: WORK })
  const diag = session.tools.find((t) => t.name === "lsp_diagnostics")
  const text = String(await diag.run({ path: goFile }))
  ok("lsp_diagnostics works through auto-start (clean file)", /no diagnostics/.test(text) && /clean/.test(text), text.slice(0, 160))
  await session.close()
  // verification-ledger collection with EMPTY config — the TODO's exact gap
  const collected = await collectDiagnosticsForFiles({}, [goFile], { cwd: WORK })
  ok("collectDiagnosticsForFiles runs on auto-start with empty config", collected.length === 1 && collected[0].passed === true && collected[0].errorCount === 0, JSON.stringify(collected))
}

console.log("== honest failure when the binary is NOT there ==")
{
  withoutBin()
  const session = createLspSession({}, { cwd: WORK })
  const diag = session.tools.find((t) => t.name === "lsp_diagnostics")
  const text = String(await diag.run({ path: goFile }))
  ok("error says WHICH binaries were probed on PATH", /PATH probed for gopls \(not found\)/.test(text), text.slice(0, 200))
  ok("error offers the real alternatives", /configure lsp.servers/.test(text) && /grep_files/.test(text))
  await session.close()
  const collected = await collectDiagnosticsForFiles({}, [goFile], { cwd: WORK })
  ok("ledger collection skips the unresolvable file (never fake diagnostics)", collected.length === 0, JSON.stringify(collected))
  // lexical extraction remains the honest fallback (langadapter contract):
  // layer 8, source says lexical, never "structured"
  const ex = await extractStructured("main.go", fs.readFileSync(goFile, "utf8"), { config: {}, cwd: WORK })
  ok("extraction degrades to lexical with provenance layer 8", ex.provenance.layer === 8 && /lexical/.test(ex.provenance.source) && ex.structured === null, JSON.stringify(ex.provenance))
  ok("fallback is labeled (no server resolved)", typeof ex.fallback === "string" && /lsp-/.test(ex.fallback), JSON.stringify(ex.fallback))
}

process.env.PATH = ORIG_PATH
resetAutoStartCache()
console.log(`\n== lsp-autostart suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
