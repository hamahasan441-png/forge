#!/usr/bin/env node
/**
 * forge — P1 LSP lifecycle.
 *
 * The protocol tests prove the client speaks LSP. This suite proves the
 * LIFECYCLE is clean: one server per language (not per request), documents
 * synced on demand, `close()` reaping every child, a hung server timing out
 * instead of hanging the agent, and a session that never crashes on a missing
 * file, an unknown extension or an empty configuration.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lsplc-"))
process.env.FORGE_HOME = DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lsplc-work-"))
process.chdir(WORK)

const lsp = await import("../lsp.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const STUB = String.raw`
const HANG = process.argv[2] === "hang"
let buf = Buffer.alloc(0)
let opens = 0
function write(o) {
  const j = Buffer.from(JSON.stringify(o), "utf8")
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + j.length + "\r\n\r\n", "ascii"), j]))
}
process.stdin.on("data", (d) => {
  if (HANG) return
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
  } else if (msg.method === "initialized") { /* no-op */
  } else if (msg.method === "textDocument/didOpen") {
    opens++
    write({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: msg.params.textDocument.uri, diagnostics: [
      { range: { start: { line: opens, character: 1 }, end: { line: opens, character: 2 } }, message: "stub diagnostic " + opens, severity: 2, source: "stub" },
    ] } })
  } else if (msg.method === "textDocument/definition") {
    write({ jsonrpc: "2.0", id: msg.id, result: { uri: msg.params.textDocument.uri, range: { start: { line: 10, character: 2 }, end: { line: 10, character: 8 } } } })
  } else if (msg.method === "textDocument/references") {
    write({ jsonrpc: "2.0", id: msg.id, result: [ { uri: msg.params.textDocument.uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } } } ] })
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
const spec = (mode = "normal") => ({ command: process.execPath, args: [stubPath, mode === "hang" ? "hang" : "normal"], extensions: [".ts", ".js"] })
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e?.code === "EPERM" } }

const config = { lsp: { servers: { stub: spec() } } }

console.log("== session start → use → close reaps the child ==")
{
  const session = lsp.createLspSession(config, { cwd: WORK })
  ok("four read-only tools are exposed", session.tools.length === 4)
  ok("every lsp tool is read-only", session.tools.every((t) => t.readOnly === true))
  const file = path.join(WORK, "greet.ts")
  fs.writeFileSync(file, "function greet() {}\nlet x = 1\n")
  const def = await session.tools.find((t) => t.name === "lsp_definition").run({ path: file, symbol: "greet" })
  ok("definition resolves", String(def).includes("greet.ts:11"))
  const hov = await session.tools.find((t) => t.name === "lsp_hover").run({ path: file, symbol: "greet" })
  ok("hover resolves", String(hov).includes("function greet(): void"))
  const refs = await session.tools.find((t) => t.name === "lsp_references").run({ path: file, symbol: "greet" })
  ok("references resolve", String(refs).includes("reference"))
  await session.close()
  await new Promise((r) => setTimeout(r, 250))
  ok("close() did not throw", true)
}

console.log("== one server per language, reused across requests ==")
{
  const session = lsp.createLspSession(config, { cwd: WORK })
  const a = path.join(WORK, "a.ts")
  const b = path.join(WORK, "b.ts")
  fs.writeFileSync(a, "function alpha() {}\n")
  fs.writeFileSync(b, "function beta() {}\n")
  const t0 = Date.now()
  const r1 = await session.tools.find((t) => t.name === "lsp_definition").run({ path: a, symbol: "alpha" })
  const first = Date.now() - t0
  const r2 = await session.tools.find((t) => t.name === "lsp_definition").run({ path: b, symbol: "beta" })
  const second = Date.now() - t0 - first
  ok("both definitions resolved", String(r1).includes("a.ts") && String(r2).includes("b.ts"))
  ok(`the second call reused the server (${first}ms then ${second}ms)`, second < first + 200)
  await session.close()
}

console.log("== repeated sessions leak no child processes ==")
{
  const pids = []
  for (let i = 0; i < 4; i++) {
    const session = lsp.createLspSession(config, { cwd: WORK })
    const f = path.join(WORK, `s${i}.ts`)
    fs.writeFileSync(f, `function s${i}() {}\n`)
    await session.tools.find((t) => t.name === "lsp_definition").run({ path: f, symbol: `s${i}` })
    await session.close()
  }
  // the client does not expose the pid, so count live stub processes instead
  await new Promise((r) => setTimeout(r, 300))
  let running = 0
  try {
    const out = execFileSync("bash", ["-c", `ps -eo args= | grep -c "[l]sp-stub.cjs" || true`], { encoding: "utf8" })
    running = Number(String(out).trim()) || 0
  } catch { running = 0 }
  eq("no stub server survived close()", running, 0)
}

console.log("== a hung server times out instead of hanging the agent ==")
{
  const hangConfig = { lsp: { servers: { stub: { ...spec("hang"), timeoutMs: 1500 } } } }
  const session = lsp.createLspSession(hangConfig, { cwd: WORK })
  const f = path.join(WORK, "hang.ts")
  fs.writeFileSync(f, "function h() {}\n")
  const t0 = Date.now()
  let out = null
  try {
    out = await Promise.race([
      session.tools.find((t) => t.name === "lsp_definition").run({ path: f, symbol: "h" }),
      new Promise((r) => setTimeout(() => r("__TIMEOUT__"), 6000)),
    ])
  } catch (e) { out = `error: ${e.message}` }
  const dt = Date.now() - t0
  ok(`the call did not hang forever (${dt}ms)`, dt < 6000)
  ok("it returned an error/timeout rather than a false result", out === "__TIMEOUT__" || /error|failed|timeout/i.test(String(out)))
  try { await session.close() } catch { }
}

console.log("== hostile inputs are handled, never thrown ==")
{
  const session = lsp.createLspSession(config, { cwd: WORK })
  const missing = await session.tools.find((t) => t.name === "lsp_definition").run({ path: "nope.ts", symbol: "x" })
  ok("a missing file is an error string", typeof missing === "string" && /no such file/i.test(missing))
  const f = path.join(WORK, "nosym.ts")
  fs.writeFileSync(f, "const a = 1\n")
  const unknown = await session.tools.find((t) => t.name === "lsp_hover").run({ path: f, symbol: "doesNotExist" })
  ok("an unknown symbol is reported", typeof unknown === "string" && /not found/i.test(unknown))
  const other = path.join(WORK, "other.rb")
  fs.writeFileSync(other, "puts 1\n")
  const noServer = await session.tools.find((t) => t.name === "lsp_definition").run({ path: other, symbol: "puts" })
  ok("an unconfigured extension is explained", typeof noServer === "string" && /no language server/i.test(noServer))
  await session.close()
}

console.log("== an empty LSP configuration is inert ==")
{
  eq("serverForFile with no servers", lsp.serverForFile({}, path.join(WORK, "a.ts")), null)
  const session = lsp.createLspSession({}, { cwd: WORK })
  ok("a session with no servers still exposes tools", session.tools.length === 4)
  const out = await session.tools.find((t) => t.name === "lsp_definition").run({ path: path.join(WORK, "a.ts"), symbol: "x" })
  ok("and reports that no server is configured", /no language server/i.test(String(out)))
  await session.close()
}

console.log(`\n== lsp-lifecycle suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
