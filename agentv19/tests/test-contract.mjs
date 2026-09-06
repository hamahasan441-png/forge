#!/usr/bin/env node
/**
 * forge — agent execution contract (Phase 1).
 * Proves the two things that were previously INFERRED are now explicit:
 *   §4 budget exhaustion is a boolean + status, not a string in the answer
 *   §6 unknown token usage is UNKNOWN, never a silent 0
 * Uses a local stand-in provider; zero external network.
 */
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-contract-"))

const { AGENT_STATUS, AGENT_STATUSES, isAgentStatus, UNKNOWN, makeUsageAccumulator,
        newId, newTaskId, newRunId, newSegmentId, isUnknown, validateAgentResult } = await import("../forge/contract.js")
const { runAgent } = await import("../forge/agent.js")

let PASS = 0, FAIL = 0
const ok = (n, c) => { if (c) { PASS++; console.log(`  ok   ${n}`) } else { FAIL++; console.log(`  FAIL ${n}`) } }

function listen(handler) {
  const srv = http.createServer(handler)
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)))
}
const body = (msg, usage) => JSON.stringify({
  choices: [{ message: msg, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }],
  ...(usage ? { usage } : {}),
})

console.log("== status enum ==")
ok("all six statuses defined", AGENT_STATUSES.length === 6)
for (const s of ["COMPLETED", "CONTINUE_REQUIRED", "FAILED", "CANCELLED", "BLOCKED", "WAITING"]) {
  ok(`${s} is a valid status`, isAgentStatus(AGENT_STATUS[s]))
}
ok("an invented status is rejected", !isAgentStatus("DONE_PROBABLY"))
ok("undefined is not a status (no state-by-absence)", !isAgentStatus(undefined))

console.log("== usage accumulator: UNKNOWN is not zero ==")
{
  const u = makeUsageAccumulator()
  u.addCall(undefined); u.addCall(null); u.addCall({})
  const snap = u.snapshot()
  ok("no provider counts → promptTokens UNKNOWN", snap.promptTokens === UNKNOWN)
  ok("no provider counts → totalTokens UNKNOWN", snap.totalTokens === UNKNOWN)
  ok("model calls still counted", snap.modelCalls === 3)

  const v = makeUsageAccumulator()
  v.addCall({ prompt_tokens: 0, completion_tokens: 0 })
  ok("a REPORTED zero stays 0, not UNKNOWN", v.snapshot().promptTokens === 0 && v.snapshot().totalTokens === 0)

  const w = makeUsageAccumulator()
  w.addCall({ prompt_tokens: 10, completion_tokens: 5 })
  w.addCall({ input_tokens: 7, output_tokens: 3 }) // anthropic-shaped
  const ws = w.snapshot()
  ok("counts accumulate across calls and wire shapes", ws.promptTokens === 17 && ws.completionTokens === 8 && ws.totalTokens === 25)
}

console.log("== identity ==")
ok("ids are unique", newTaskId() !== newTaskId() && newSegmentId() !== newSegmentId())
ok("ids are prefixed", newTaskId().startsWith("task-") && newSegmentId().startsWith("seg-"))
ok("newRunId is the one run-id generator", newRunId().startsWith("run-") && newRunId() !== newRunId())
ok("newId takes any prefix and stays unique", newId("x").startsWith("x-") && newId("x") !== newId("x"))
ok("isUnknown distinguishes the sentinel from a real zero", isUnknown(UNKNOWN) && !isUnknown(0) && !isUnknown("0") && !isUnknown(undefined))

console.log("== validateAgentResult ==")
{
  const good = { status: "COMPLETED", text: "x", steps: 1, budgetHit: false, wrote: false, toolLog: [],
                 taskId: "task-a", segmentId: "seg-a", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
  ok("a well-formed result validates", validateAgentResult(good).length === 0)
  ok("UNKNOWN usage is valid", validateAgentResult({ ...good, usage: { promptTokens: UNKNOWN, completionTokens: UNKNOWN, totalTokens: UNKNOWN } }).length === 0)
  ok("missing status is rejected", validateAgentResult({ ...good, status: undefined }).length > 0)
  ok("non-boolean budgetHit is rejected", validateAgentResult({ ...good, budgetHit: undefined }).length > 0)
  ok("budgetHit + COMPLETED is contradictory", validateAgentResult({ ...good, budgetHit: true }).some((m) => /COMPLETED/.test(m)))
}

console.log("== runAgent: COMPLETED with real usage ==")
{
  const srv = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(body({ role: "assistant", content: "ALL DONE" }, { prompt_tokens: 11, completion_tokens: 4 }))
  })
  const cfg = { providers: { m: { protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, apiKey: "k", model: "m" } },
                agent: { maxSteps: 5 }, skills: { enabled: false }, context: { repoMap: false } }
  const provider = { name: "m", protocol: "openai", baseUrl: cfg.providers.m.baseUrl, apiKey: "k", model: "m", contextWindow: 128000 }
  const r = await runAgent({ config: cfg, provider, task: "say done", taskId: "task-fixed" })
  ok("contract-valid result", validateAgentResult(r).length === 0)
  ok("status COMPLETED", r.status === AGENT_STATUS.COMPLETED)
  ok("budgetHit is explicitly false", r.budgetHit === false)
  ok("caller-supplied taskId is preserved", r.taskId === "task-fixed")
  ok("a segmentId is always assigned", typeof r.segmentId === "string" && r.segmentId.length > 0)
  ok("provider usage surfaces (was previously discarded)", r.usage.promptTokens === 11 && r.usage.completionTokens === 4)
  srv.close()
}

console.log("== runAgent: budget exhaustion → CONTINUE_REQUIRED ==")
{
  // never returns a final answer — only tool calls — so the step budget runs out
  const srv = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(body({ role: "assistant", content: "", tool_calls: [
      { id: "c1", type: "function", function: { name: "think", arguments: JSON.stringify({ thought: "loop" }) } },
    ] }))
  })
  const cfg = { providers: {}, agent: { maxSteps: 3 }, skills: { enabled: false }, context: { repoMap: false } }
  const provider = { name: "m", protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, apiKey: "k", model: "m", contextWindow: 128000 }
  const r = await runAgent({ config: cfg, provider, task: "spin forever" })
  ok("contract-valid result", validateAgentResult(r).length === 0)
  ok("status is CONTINUE_REQUIRED, not COMPLETED", r.status === AGENT_STATUS.CONTINUE_REQUIRED)
  ok("budgetHit is explicitly true", r.budgetHit === true)
  ok("budget exhaustion is NOT reported as success", r.status !== AGENT_STATUS.COMPLETED)
  ok("the answer text is no longer the state signal", !/reached max steps/.test(r.text))
  ok("tool calls were counted in usage", r.usage.toolCalls > 0)
  ok("usage with no provider counts is UNKNOWN, not 0", r.usage.promptTokens === UNKNOWN)
  srv.close()
}

console.log("== the CLI reports the contract (FORGE_DEBUG=1) ==")
{
  // The debug summary is the one place a terminal user can SEE the contract, so
  // it is exercised through the real CLI rather than by calling the printer.
  const srv = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(body({ role: "assistant", content: "ALL DONE" }, { prompt_tokens: 11, completion_tokens: 4 }))
  })
  const base = `http://127.0.0.1:${srv.address().port}/v1`
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-contract-cli-"))
  const cfgPath = path.join(home, "config.json")
  fs.writeFileSync(cfgPath, JSON.stringify({
    activeProvider: "m",
    providers: { m: { protocol: "openai", baseUrl: base, apiKey: "k", model: "m" } },
    agent: { maxSteps: 5 }, skills: { enabled: false }, context: { repoMap: false },
  }))
  const FORGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "forge", "forge.js")
  // spawn (not spawnSync): the stand-in provider lives in THIS process's event
  // loop, so a synchronous child would deadlock waiting on a server that can
  // never accept the connection.
  const errOut = await new Promise((resolve) => {
    const child = spawn("node", [FORGE, "agent", "say done"], {
      env: { ...process.env, FORGE_HOME: home, FORGE_CONFIG: cfgPath, FORGE_DEBUG: "1", NO_COLOR: "1" },
      cwd: home,
      stdio: ["ignore", "ignore", "pipe"], // stdin closed: never block on a prompt
    })
    let buf = ""
    child.stderr.on("data", (d) => { buf += d })
    const kill = setTimeout(() => child.kill("SIGKILL"), 30000)
    child.on("close", () => { clearTimeout(kill); resolve(buf) })
    child.on("error", () => { clearTimeout(kill); resolve("") })
  })
  const line = errOut.split("\n").find((l) => l.includes("[debug]")) ?? ""
  ok("a debug line is printed", line !== "")
  ok("it reports status", /status=COMPLETED/.test(line))
  ok("it reports budgetHit explicitly", /budgetHit=false/.test(line))
  ok("it reports the token usage that used to be discarded", /tokens=11\/4/.test(line))
  ok("it reports task identity", /taskId=task-/.test(line))
  fs.rmSync(home, { recursive: true, force: true })
  srv.close()
}

try { fs.rmSync(process.env.FORGE_HOME, { recursive: true, force: true }) } catch {}
console.log(`\n== contract suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
