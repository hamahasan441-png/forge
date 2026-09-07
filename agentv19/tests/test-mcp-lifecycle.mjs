#!/usr/bin/env node
/**
 * forge — P1 MCP lifecycle.
 *
 * An external tool server is a CHILD PROCESS. If forge leaks one per run, a
 * long session accumulates zombies, open stdio pipes and pending timers. This
 * suite drives the full lifecycle — connect → initialize → tools/list →
 * tools/call → close — repeatedly, and proves every child dies and nothing is
 * left behind.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mcplc-"))
process.env.FORGE_HOME = DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mcplc-work-"))
process.chdir(WORK)

const mcp = await import("../forge/mcp.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const STUB = `
let buf = ""
const mode = process.argv[2] || "normal"
process.stdin.setEncoding("utf8")
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n") }
process.stdin.on("data", (d) => {
  buf += d
  let i
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    const { id, method, params } = msg
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1.0.0" } } })
    } else if (method === "notifications/initialized" || (method || "").startsWith("notifications/")) {
      // no response
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: [ { name: "echo", description: "echo a value", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } } ] } })
    } else if (method === "tools/call") {
      if (mode === "error") send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "boom" }], isError: true } })
      else send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "echo:" + ((params.arguments || {}).value ?? "") }] } })
    } else if (method === "shutdown") {
      send({ jsonrpc: "2.0", id, result: {} })
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } })
    }
  }
})
process.stdin.on("end", () => process.exit(0))
`
const STUB_PATH = path.join(DIR, "mcp-stub.mjs")
fs.writeFileSync(STUB_PATH, STUB)

const spec = (mode = "normal") => ({ command: process.execPath, args: [STUB_PATH, mode], timeoutMs: 5000 })
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e?.code === "EPERM" } }

console.log("== connect → use → close ==")
{
  const c = await mcp.connectServer("stub", spec())
  ok("client connected", !!c)
  ok("server name recorded", c?.name === "stub")
  const tools = await c.listTools()
  eq("one tool listed", tools.length, 1)
  eq("tool name", tools[0].name, "echo")
  const plugins = mcp.mcpToolsToPlugins(c, tools)
  eq("namespaced tool name", plugins[0].name, "mcp__stub__echo")
  const out = await plugins[0].run({ value: "hi" })
  ok("the tool returns the server's result", String(out).includes("echo:hi"))
  const pid = c.proc?.pid ?? c.child?.pid ?? c.process?.pid ?? null
  ok("the child pid is observable", typeof pid === "number")
  if (pid) ok("the child is alive while connected", alive(pid))
  await c.close()
  await new Promise((r) => setTimeout(r, 250))
  if (pid) ok("the child is DEAD after close", !alive(pid))
}

console.log("== an MCP error is a string, never a throw ==")
{
  const c = await mcp.connectServer("stub-err", spec("error"))
  const tools = await c.listTools()
  const plugins = mcp.mcpToolsToPlugins(c, tools)
  const out = await plugins[0].run({ value: "x" })
  ok("the error is reported as an ERROR string", typeof out === "string" && /^ERROR/.test(out))
  await c.close()
}

console.log("== repeated connect/close cycles leak nothing ==")
{
  const pids = []
  for (let i = 0; i < 5; i++) {
    const c = await mcp.connectServer(`stub-${i}`, spec())
    const t = await c.listTools()
    const p = mcp.mcpToolsToPlugins(c, t)
    ok(`cycle ${i + 1}: tool works`, String(await p[0].run({ value: String(i) })).includes(`echo:${i}`))
    const pid = c.proc?.pid ?? c.child?.pid ?? c.process?.pid ?? null
    if (pid) pids.push(pid)
    await c.close()
  }
  await new Promise((r) => setTimeout(r, 400))
  const stillAlive = pids.filter(alive)
  eq("no child process survived", stillAlive.length, 0)
}

console.log("== loadMcpTools aggregates and closes cleanly ==")
{
  const config = { mcp: { servers: { one: spec(), two: spec() } } }
  const out = await mcp.loadMcpTools(config, { timeoutMs: 5000 })
  eq("both servers connected", out.clients.length, 2)
  ok("tools were collected", out.tools.length === 2)
  eq("no errors", out.errors.length, 0)
  const pids = out.clients.map((c) => c.proc?.pid ?? c.child?.pid ?? c.process?.pid).filter(Boolean)
  for (const c of out.clients) await c.close()
  await new Promise((r) => setTimeout(r, 350))
  eq("every aggregated child died", pids.filter(alive).length, 0)
}

console.log("== a broken server is an error, not a crash ==")
{
  const config = { mcp: { servers: { broken: { command: process.execPath, args: ["-e", "process.exit(3)"], timeoutMs: 2000 } } } }
  const out = await mcp.loadMcpTools(config, { timeoutMs: 2000 })
  eq("no tools", out.tools.length, 0)
  ok("the failure is recorded", out.errors.length === 1)
  ok("the error names the server", /broken/.test(out.errors[0]))
}

console.log("== disabled / empty configurations are inert ==")
{
  const config = { mcp: { servers: { off: { ...spec(), disabled: true } } } }
  eq("disabled server skipped", mcp.configuredServers(config).length, 0)
  eq("no servers configured", mcp.configuredServers({}).length, 0)
  eq("null config is safe", mcp.configuredServers(null).length, 0)
  const out = await mcp.loadMcpTools({}, { timeoutMs: 1000 })
  eq("loading with no servers yields nothing", out.tools.length, 0)
  eq("and no errors", out.errors.length, 0)
}

console.log("== name mangling round-trips ==")
{
  eq("mcpToolName", mcp.mcpToolName("srv", "do_thing"), "mcp__srv__do_thing")
  const parsed = mcp.parseMcpToolName("mcp__srv__do_thing")
  eq("parse server", parsed?.server, "srv")
  eq("parse tool", parsed?.tool, "do_thing")
  eq("a non-mcp name parses to null", mcp.parseMcpToolName("read_file"), null)
}

console.log(`\n== mcp-lifecycle suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
