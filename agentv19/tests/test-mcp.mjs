#!/usr/bin/env node
/**
 * forge — MCP client (v23).
 *
 * Proves the client speaks real MCP stdio JSON-RPC against a stand-in server:
 *   - initialize handshake + serverInfo
 *   - tools/list, tools/call (success and isError)
 *   - namespacing (mcp__<server>__<tool>) and the plugin-shaped adapter
 *   - a hung server times out instead of hanging the agent
 *   - a server that never starts is an error, not a crash
 *   - loadMcpTools aggregates configured servers and closes cleanly
 *
 * The stand-in server is written to a temp file and speaks the protocol for
 * real (newline-delimited JSON-RPC over stdio). Zero external network.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const {
  connectServer, loadMcpTools, mcpToolName, parseMcpToolName,
  mcpToolsToPlugins, flattenContent, configuredServers, PROTOCOL_VERSION,
} = await import("../forge/mcp.js")

let PASS = 0, FAIL = 0
const ok = (n, c) => { if (c) { PASS++; console.log(`  ok   ${n}`) } else { FAIL++; console.log(`  FAIL ${n}`) } }

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mcp-"))

// A minimal but real MCP stdio server: newline-delimited JSON-RPC 2.0.
// Behaviour is switchable via argv[2] so one file drives several scenarios.
const STUB = `
let buf = ""
const mode = process.argv[2] || "normal"
process.stdin.setEncoding("utf8")
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n") }
process.stdin.on("data", (d) => {
  buf += d
  let nl
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.method === "initialize") {
      if (mode === "hang_init") return // never answer → client must time out
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "${PROTOCOL_VERSION}", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "9.9" } } })
    } else if (m.method === "notifications/initialized") {
      // no reply to a notification
    } else if (m.method === "tools/list") {
      send({ jsonrpc: "2.0", id: m.id, result: { tools: [
        { name: "echo", description: "echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
        { name: "boom", description: "always errors", inputSchema: { type: "object", properties: {} } },
        { name: "noschema", description: "no schema at all" },
      ] } })
    } else if (m.method === "tools/call") {
      const { name, arguments: a } = m.params || {}
      if (name === "echo") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "echo:" + (a?.text ?? "") }] } })
      else if (name === "boom") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "it broke" }], isError: true } })
      else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no such tool" } })
    } else if (m.id !== undefined) {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } })
    }
  }
})
`
const stubPath = path.join(DIR, "stub-server.mjs")
fs.writeFileSync(stubPath, STUB)
const spec = (mode = "normal") => ({ command: process.execPath, args: [stubPath, mode] })

console.log("== name helpers ==")
ok("namespaced name is stable", mcpToolName("github", "create_issue") === "mcp__github__create_issue")
ok("round-trips back to server+tool", (() => { const p = parseMcpToolName("mcp__github__create_issue"); return p && p.server === "github" && p.tool === "create_issue" })())
ok("a built-in name is not mistaken for MCP", parseMcpToolName("read_file") === null)
ok("flattenContent joins text parts", flattenContent([{ type: "text", text: "a" }, { type: "text", text: "b" }]) === "a\nb")
ok("flattenContent tolerates a bare string", flattenContent("hi") === "hi")

console.log("== connect + initialize ==")
{
  const c = await connectServer("stub", spec())
  ok("serverInfo came back from the handshake", c.serverInfo?.name === "stub")
  ok("server advertised tools capability", !!c.capabilities?.tools)
  const tools = await c.listTools()
  ok("tools/list returns the three tools", tools.length === 3 && tools.some((t) => t.name === "echo"))
  c.close()
}

console.log("== tools/call: success, isError, protocol error ==")
{
  const c = await connectServer("stub", spec())
  const good = await c.callTool("echo", { text: "hi" })
  ok("a successful call returns text", good.text === "echo:hi" && good.isError === false)
  const bad = await c.callTool("boom", {})
  ok("an isError result is flagged, not thrown", bad.isError === true && /it broke/.test(bad.text))
  let threw = false
  try { await c.callTool("nonexistent", {}) } catch { threw = true }
  ok("a JSON-RPC error rejects", threw)
  c.close()
}

console.log("== plugin adapter shape ==")
{
  const c = await connectServer("stub", spec())
  const tools = await c.listTools()
  const plugins = mcpToolsToPlugins(c, tools)
  const echo = plugins.find((p) => p.name === "mcp__stub__echo")
  ok("adapter namespaces every tool", plugins.every((p) => p.name.startsWith("mcp__stub__")))
  ok("adapter marks MCP tools write-class by default", plugins.every((p) => p.readOnly === false))
  ok("adapter produces the tool-def shape the loop expects", echo?.def?.type === "function" && echo.def.function.name === "mcp__stub__echo" && echo.def.function.parameters.type === "object")
  ok("a tool with no schema still gets a valid object schema", plugins.find((p) => p.name === "mcp__stub__noschema").def.function.parameters.type === "object")
  const out = await echo.run({ text: "yo" })
  ok("run() returns the server's text", out === "echo:yo")
  const errOut = await plugins.find((p) => p.name === "mcp__stub__boom").run({})
  ok("run() surfaces an isError as an ERROR: string, never throws", errOut.startsWith("ERROR:"))
  c.close()
}

console.log("== a hung server times out, it does not hang forever ==")
{
  const t0 = Date.now()
  let threw = false
  try { await connectServer("hung", spec("hang_init"), { timeoutMs: 400 }) } catch { threw = true }
  ok("initialize rejects on timeout", threw)
  ok("it timed out promptly, not forever", Date.now() - t0 < 5000)
}

console.log("== a server that cannot launch is an error, not a crash ==")
{
  let threw = false
  try { await connectServer("nope", { command: "/nonexistent/forge-mcp-xyz", args: [] }, { timeoutMs: 800 }) } catch { threw = true }
  ok("a bad command rejects cleanly", threw)
}

console.log("== configuredServers + loadMcpTools ==")
{
  ok("no mcp config → no servers", configuredServers({}).length === 0)
  ok("a disabled server is skipped", configuredServers({ mcp: { servers: { s: { command: "x", disabled: true } } } }).length === 0)
  ok("a server with no command is skipped", configuredServers({ mcp: { servers: { s: { args: [] } } } }).length === 0)

  const config = { mcp: { servers: {
    good: spec(),
    broken: { command: "/nonexistent/forge-mcp-xyz" },
  } } }
  const res = await loadMcpTools(config, { timeoutMs: 1500 })
  ok("tools from the good server are loaded", res.tools.some((t) => t.name === "mcp__good__echo"))
  ok("the broken server is recorded as an error, not fatal", res.errors.some((e) => /broken/.test(e)))
  ok("clients are returned for cleanup", res.clients.length === 1)
  for (const c of res.clients) c.close()
}

try { fs.rmSync(DIR, { recursive: true, force: true }) } catch {}
console.log(`\n== mcp suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
