#!/usr/bin/env node
/**
 * forge — v21.2 "close the loops" regression suite.
 *
 *   IE-1  inline interpreter eval (`node -e` / `python -c`) is danger unless
 *         tools.allowInterpreterEval; script-file execution stays low;
 *         CODE_DANGER still fires with the flag on.
 *   PQ-1  same-run plugin quarantine: a *.mjs newer than startedAt is skipped
 *         (unless allowNewPlugins); default startedAt=null does not quarantine
 *         (isolation tests write plugins after process start).
 *   PS-1  plugin file that is a symlink escaping ~/.forge/tools is skipped.
 *   PG-1  a read/write grant that is a symlink leaving the project is dropped.
 *   CF-2  project forge.config.json cannot set allowInterpreterEval / allowNewPlugins.
 *   MCP-1 loadChatPlugins joins MCP tools and closeChatPlugins shuts the child.
 *   LSP-1 collectDiagnosticsForFiles records error-severity as failed SYNTAX
 *         evidence and skips unconfigured extensions.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v212-"))
const HOME = path.join(ROOT, "home")
const FORGE = path.join(HOME, ".forge")
const PLUG = path.join(FORGE, "tools")
const PROJ = path.join(ROOT, "proj")
const OUTSIDE = path.join(ROOT, "outside")
for (const d of [HOME, FORGE, PLUG, PROJ, OUTSIDE]) fs.mkdirSync(d, { recursive: true })
process.env.FORGE_HOME = FORGE
process.chdir(PROJ)

const { classifyCommand, modelMayRun } = await import("../shellguard.js")
const { loadToolPlugins, resolveGrants, PLUGIN_ISOLATION_AVAILABLE } = await import("../plugins.js")
const { sanitizeProjectConfig, defaultConfig } = await import("../config.js")
const { loadChatPlugins, closeChatPlugins } = await import("../chat.js")
const { collectDiagnosticsForFiles } = await import("../lsp.js")
const { VTYPE } = await import("../verifyledger.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}

const ctx = { cwd: PROJ, root: PROJ, home: HOME }

console.log("== IE-1 inline interpreter eval defaults to danger ==")
{
  ok("python3 -c print → danger", classifyCommand('python3 -c "print(1)"', ctx).level === "danger")
  ok("node -e console.log → danger", classifyCommand('node -e "console.log(1)"', ctx).level === "danger")
  ok("node --eval → danger", classifyCommand('node --eval "console.log(1)"', ctx).level === "danger")
  ok("perl -e → danger", classifyCommand("perl -e 'print 1'", ctx).level === "danger")
  ok("ruby -e → danger", classifyCommand("ruby -e 'puts 1'", ctx).level === "danger")
  ok("php -r → danger", classifyCommand("php -r 'echo 1;'", ctx).level === "danger")
  ok("python3 app.py stays low", classifyCommand("python3 app.py", ctx).level === "low")
  ok("node ./scripts/build.js stays low", classifyCommand("node ./scripts/build.js", ctx).level === "low")
  ok("node --check file.js is not eval", classifyCommand("node --check app.js", ctx).level === "low")
  ok("consent restores python -c to low", classifyCommand('python3 -c "print(1)"', { ...ctx, allowInterpreterEval: true }).level === "low")
  ok("consent restores node -e to low", classifyCommand('node -e "console.log(1)"', { ...ctx, allowInterpreterEval: true }).level === "low")
  ok("CODE_DANGER still danger with consent", classifyCommand('python3 -c "import os; os.system(\'rm -rf /\')"', { ...ctx, allowInterpreterEval: true }).level === "danger")
  ok("model refused without consent", modelMayRun('node -e "console.log(1)"', ctx).ok === false)
  ok("model allowed with consent", modelMayRun('node -e "console.log(1)"', ctx, { allowInterpreterEval: true }).ok === true)
  ok("model still runs a script file", modelMayRun("node ./scripts/build.js", ctx).ok === true)
  ok("reason names the flag", /allowInterpreterEval/.test(classifyCommand('python3 -c "print(1)"', ctx).reasons.join(" ")))
}

console.log("== CF-2 project config cannot opt into eval / new plugins ==")
{
  const evil = { tools: { allowInterpreterEval: true, allowNewPlugins: true, allowSudo: true }, agent: { maxSteps: 3 } }
  const { cfg, dropped } = sanitizeProjectConfig(evil)
  ok("dropped allowInterpreterEval", dropped.includes("tools.allowInterpreterEval"))
  ok("dropped allowNewPlugins", dropped.includes("tools.allowNewPlugins"))
  ok("dropped allowSudo still", dropped.includes("tools.allowSudo"))
  ok("keys do not survive", !("allowInterpreterEval" in (cfg.tools || {})) && !("allowNewPlugins" in (cfg.tools || {})))
  ok("defaults stay false", defaultConfig().tools.allowInterpreterEval === false && defaultConfig().tools.allowNewPlugins === false)
}

console.log(`== plugin isolation available: ${PLUGIN_ISOLATION_AVAILABLE} ==`)
if (PLUGIN_ISOLATION_AVAILABLE) {
  const toolBody = (name) => `export default { name: ${JSON.stringify(name)}, description: "d", parameters: { type: "object", properties: {} }, readOnly: true, async run(){ return "ok" } }\n`
  const oldPath = path.join(PLUG, "old_ok.mjs")
  fs.writeFileSync(oldPath, toolBody("old_ok"))
  const past = new Date(Date.now() - 60_000)
  fs.utimesSync(oldPath, past, past)
  const startedAt = Date.now()
  const newPath = path.join(PLUG, "new_pwn.mjs")
  fs.writeFileSync(newPath, toolBody("new_pwn"))
  const future = new Date(Date.now() + 60_000)
  fs.utimesSync(newPath, future, future)

  console.log("== PQ-1 same-run plugin quarantine ==")
  {
    const loaded = await loadToolPlugins(PLUG, { reserved: [], grants: {}, cwd: PROJ, startedAt })
    const names = loaded.tools.map((t) => t.name)
    ok("plugin that existed at start still loads", names.includes("old_ok"))
    ok("plugin written after start is skipped", !names.includes("new_pwn"))
    ok("quarantine reason is recorded", loaded.errors.some((e) => /new_pwn\.mjs: skipped — plugin is newer/.test(e)), loaded.errors.join(" | "))
    loaded.close()

    const noStamp = await loadToolPlugins(PLUG, { reserved: [], grants: {}, cwd: PROJ })
    ok("startedAt=null does not quarantine (isolation-test contract)", noStamp.tools.some((t) => t.name === "new_pwn"))
    noStamp.close()

    const opted = await loadToolPlugins(PLUG, { reserved: [], grants: {}, cwd: PROJ, startedAt, allowNewPlugins: true })
    ok("allowNewPlugins:true loads the new plugin", opted.tools.some((t) => t.name === "new_pwn"))
    opted.close()
  }

  console.log("== PS-1 plugin file symlink escape is skipped ==")
  {
    const outsidePlug = path.join(OUTSIDE, "escape.mjs")
    fs.writeFileSync(outsidePlug, toolBody("escaped_tool"))
    const link = path.join(PLUG, "link_escape.mjs")
    fs.symlinkSync(outsidePlug, link)
    const loaded = await loadToolPlugins(PLUG, { reserved: [], grants: {}, cwd: PROJ })
    ok("escaped symlink plugin did not load", !loaded.tools.some((t) => t.name === "escaped_tool"))
    ok("skip reason recorded", loaded.errors.some((e) => /link_escape\.mjs: skipped — plugin file is a symlink/.test(e)), loaded.errors.join(" | "))
    loaded.close()
    try { fs.unlinkSync(link) } catch {}
  }

  console.log("== PG-1 grant symlink leaving the project is refused ==")
  {
    const victim = path.join(OUTSIDE, "secret.txt")
    fs.writeFileSync(victim, "secret")
    const grantLink = path.join(PROJ, "link-out")
    fs.symlinkSync(OUTSIDE, grantLink)
    const notes = resolveGrants("x.mjs", { write: [grantLink] }, { write: [grantLink] }, { cwd: PROJ, pluginDir: PLUG }).notes
    ok("symlink grant is refused", notes.some((n) => /symlink target/.test(n) && /leaves the project/.test(n)), notes.join(" | "))
    const inProj = path.join(PROJ, "src")
    fs.mkdirSync(inProj, { recursive: true })
    const inLink = path.join(PROJ, "link-in")
    fs.symlinkSync(inProj, inLink)
    const okGrant = resolveGrants("x.mjs", { write: [inLink] }, { write: [inLink] }, { cwd: PROJ, pluginDir: PLUG })
    ok("in-project symlink grant is kept", okGrant.write.some((p) => path.resolve(p) === path.resolve(inLink) || path.resolve(p) === path.resolve(inProj)), JSON.stringify(okGrant.write))
  }
} else {
  ok("plugin checks skipped: no permission model on this Node", true)
}

console.log("== MCP-1 loadChatPlugins + closeChatPlugins ==")
{
  const STUB = `
let buf = ""
process.stdin.setEncoding("utf8")
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n") }
process.stdin.on("data", (d) => {
  buf += d
  let nl
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } } })
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } })
    else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "echo:" + ((m.params?.arguments?.text) ?? "") }] } })
    else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} })
  }
})
process.stdin.on("end", () => process.exit(0))
`
  const stubPath = path.join(ROOT, "mcp-stub.mjs")
  fs.writeFileSync(stubPath, STUB)
  const config = {
    tools: { plugins: false, mcp: true },
    mcp: { servers: { stub: { command: process.execPath, args: [stubPath] } } },
  }
  const loaded = await loadChatPlugins(config, { cwd: PROJ })
  ok("MCP tool is namespaced onto the chat plugin list", loaded.plugins.some((t) => t.name === "mcp__stub__echo"))
  ok("MCP client is owned by the loader", loaded.mcpClients.length === 1)
  const echo = loaded.plugins.find((t) => t.name === "mcp__stub__echo")
  ok("chat can call the MCP tool", echo && /echo:hi/.test(await echo.run({ text: "hi" })))
  const pid = loaded.mcpClients[0]?.child?.pid
  ok("child pid is observable", typeof pid === "number")
  closeChatPlugins(loaded)
  closeChatPlugins(loaded) // idempotent
  let alive = typeof pid === "number"
  for (let i = 0; i < 25 && alive; i++) {
    alive = false
    if (typeof pid === "number") { try { process.kill(pid, 0); alive = true } catch (e) { alive = e?.code === "EPERM" } }
    if (alive) await new Promise((r) => setTimeout(r, 80))
  }
  ok("closeChatPlugins shut the MCP child", !alive)
}

console.log("== LSP-1 collectDiagnosticsForFiles feeds SYNTAX evidence ==")
{
  const STUB = String.raw`
let buf = Buffer.alloc(0)
const mode = process.argv[2] || "ok"
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
  if (msg.method === "initialize") write({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } })
  else if (msg.method === "textDocument/didOpen") {
    const uri = msg.params.textDocument.uri
    const isErr = /error/.test(uri) || mode === "err"
    write({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: isErr
      ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "cannot find name", severity: 1, source: "stub" }]
      : [] } })
  } else if (msg.method === "shutdown") write({ jsonrpc: "2.0", id: msg.id, result: null })
  else if (msg.method === "exit") process.exit(0)
  else if (msg.id !== undefined) write({ jsonrpc: "2.0", id: msg.id, result: null })
}
`
  const stubPath = path.join(ROOT, "lsp-stub.cjs")
  fs.writeFileSync(stubPath, STUB)
  const clean = path.join(PROJ, "clean.ts")
  const bad = path.join(PROJ, "error.ts")
  const other = path.join(PROJ, "notes.md")
  fs.writeFileSync(clean, "const x = 1\n")
  fs.writeFileSync(bad, "const y = z\n")
  fs.writeFileSync(other, "# hi\n")
  const config = { lsp: { servers: { ts: { command: process.execPath, args: [stubPath], extensions: [".ts"] } } } }
  const empty = await collectDiagnosticsForFiles({ lsp: { servers: {} } }, [clean], { cwd: PROJ })
  ok("empty lsp.servers → no evidence", empty.length === 0)
  const diags = await collectDiagnosticsForFiles(config, [clean, bad, other, clean], { cwd: PROJ })
  ok("unconfigured .md is skipped", !diags.some((d) => d.file.endsWith("notes.md")))
  ok("dedupes the same file", diags.filter((d) => d.file === clean).length === 1)
  const cleanRec = diags.find((d) => d.file === clean)
  const badRec = diags.find((d) => d.file === bad)
  ok("clean file passes", cleanRec && cleanRec.passed === true && cleanRec.errorCount === 0, JSON.stringify(cleanRec))
  ok("error-severity fails", badRec && badRec.passed === false && badRec.errorCount >= 1, JSON.stringify(badRec))
  ok("failure text is error-prefixed", badRec && /^error /m.test(badRec.text), badRec?.text)
  ok("VTYPE.SYNTAX is the ledger type this evidence uses", VTYPE.SYNTAX === "syntax")
}

try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch {}
console.log(`\n== v21.2 suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
