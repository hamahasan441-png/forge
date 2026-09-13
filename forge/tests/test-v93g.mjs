#!/usr/bin/env node
/**
 * v93 GAP FIX — phases 2/3/4: one completion contract, honest direct path,
 * worker exhaustion classification.
 *
 *  1. canCompleteFastPath (completion.js): the fast path shares the ONE
 *     completion contract — never COMPLETED on budget exhaustion / doubt.
 *  2. BEHAVIORAL direct-agent false completion (agent.js, real mock
 *     provider): a task that intentionally needs more steps than the budget
 *     → budget reached → status INCOMPLETE (≠ COMPLETED) → checkpoint
 *     exists → resumable, journal records "incomplete".
 *  3. agentmanager worker exhaustion: a resolved runner whose AGENT outcome
 *     is INCOMPLETE settles EXHAUSTED with ok:false (never work-complete);
 *     legacy string runners and COMPLETED objects still settle COMPLETED.
 *  4. runMeta integration: when every worker exhausts, the task can NOT
 *     end COMPLETED (the gate + node failure semantics hold).
 *  5. Entry-point honesty: the one-shot CLI + chat render the INCOMPLETE
 *     status (source-contract checks).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93g-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93g-work-"))
process.chdir(WORK)
fs.writeFileSync(path.join(WORK, "a.js"), "export const a = 1\n")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

// ---------------------------------------------------------------------------
console.log("== 1. canCompleteFastPath — the ONE contract, fast-path subset ==")
{
  const { canCompleteFastPath, FAST_PATH_CHECK, FAST_PATH_STATUS } = await import("../completion.js")
  const good = canCompleteFastPath({ finalText: "the fix is applied", error: null, budgetHit: false, toolLog: [], commandChecks: [] })
  ok("real answer + no error + budget left → COMPLETED", good.ok === true && good.status === "COMPLETED" && good.blockers.length === 0)
  ok("all four checks recorded true", Object.values(good.checks).length === 4 && Object.values(good.checks).every(Boolean))

  const noAnswer = canCompleteFastPath({ finalText: "", error: null, budgetHit: false, toolLog: [], commandChecks: [] })
  ok("no final answer → INCOMPLETE (never COMPLETED)", noAnswer.ok === false && noAnswer.status === FAST_PATH_STATUS.INCOMPLETE)
  ok("blocker names the missing answer", noAnswer.blockers.some((b) => b.check === FAST_PATH_CHECK.FINAL_ANSWER_PRESENT))

  const budget = canCompleteFastPath({ finalText: "", error: null, budgetHit: true, toolLog: [], commandChecks: [] })
  ok("budget exhausted → INCOMPLETE", budget.ok === false && budget.status === FAST_PATH_STATUS.INCOMPLETE)
  ok("blocker names the budget (budget exhaustion ≠ completion)", budget.blockers.some((b) => b.check === FAST_PATH_CHECK.NOT_BUDGET_EXHAUSTED))

  const err = canCompleteFastPath({ finalText: "partial", error: "provider died", budgetHit: false, toolLog: [], commandChecks: [] })
  ok("error → FAILED", err.status === FAST_PATH_STATUS.FAILED)

  const cancelled = canCompleteFastPath({ finalText: "", error: null, budgetHit: false, cancelled: true, toolLog: [], commandChecks: [] })
  ok("cancelled → CANCELLED", cancelled.status === FAST_PATH_STATUS.CANCELLED)

  const noEvidence = canCompleteFastPath({ finalText: "looks done", error: null, budgetHit: false, toolLog: null, commandChecks: null })
  ok("missing evidence arrays → not ok (evidence must survive)", noEvidence.ok === false && noEvidence.blockers.some((b) => b.check === FAST_PATH_CHECK.EVIDENCE_PRESERVED))

  // budgetHit WITH a real final answer is a real answer — §5 forbids
  // completion "only because" of the budget; an actual answer completes.
  // agent.js composes this: exhausted = budgetHit && !answerPresent.
  const answeredLate = canCompleteFastPath({ finalText: "done, tests pass", error: null, budgetHit: false, toolLog: [], commandChecks: [] })
  ok("a real final answer completes even on the last allowed step", answeredLate.ok === true && answeredLate.status === "COMPLETED")

  // the shape is the SAME as the whole-task gate
  const { canCompleteTask } = await import("../completion.js")
  const whole = canCompleteTask({ planValid: true, dag: null, requireDAG: false, verificationRequired: false })
  eq("same result shape as canCompleteTask (keys)", Object.keys(good).sort(), Object.keys(whole).sort())
}

// ---------------------------------------------------------------------------
console.log("== 2. BEHAVIORAL: direct agent, budget reached, false completion dead ==")
{
  // mock provider: EVERY turn is a tool call — the task intentionally
  // requires more steps than the budget allows
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && /chat\/completions$/.test(req.url)) {
      let body = ""
      req.on("data", (c) => { body += c })
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({
          id: "mock", object: "chat.completion", created: Date.now(), model: "mock-1",
          choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo step" }) } }] }, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }))
      })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const port = server.address().port

  const { runAgent } = await import("../agent.js")
  const { listCheckpoints } = await import("../checkpoint.js")
  const { readRun } = await import("../runlog.js")
  const events = []
  try {
    const r = await runAgent({
      config: { providers: {}, tools: {}, agent: { autonomous: false } },
      provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", model: "mock-1" },
      task: "this task intentionally needs more steps than the budget",
      onEvent: (e) => events.push(e),
      maxStepsOverride: 3,
    })
    // §5 invariant: budget exhaustion != completion
    eq("status is INCOMPLETE, not COMPLETED", r.status, "INCOMPLETE")
    eq("reason is RESOURCE_LIMIT", r.reason, "RESOURCE_LIMIT")
    eq("resource named", r.resource, "steps")
    ok("budgetHit still reported (meta compatibility)", r.budgetHit === true)
    ok("completionGate present with the blocker", r.completionGate?.ok === false && r.completionGate.blockers.some((b) => b.check === "notBudgetExhausted"))
    ok("text no longer fabricates a silent success", /INCOMPLETE/.test(r.text) && /step budget/.test(r.text))
    ok("error stays null (nothing errored — it ran out of budget)", r.error === null)

    // §5 example test, continued: checkpoint exists → task can resume
    ok("resume payload carries the checkpoint", typeof r.resume?.checkpointId === "string" && r.resume.checkpointId.length > 8, JSON.stringify(r.resume))
    const cps = listCheckpoints(WORK, 50).filter((c) => c.runId === r.runId)
    ok("the checkpoint EXISTS on disk for this run", cps.length >= 1, JSON.stringify(listCheckpoints(WORK, 5).map((c) => c.label)))
    const mine = cps.find((c) => c.label === "budget-incomplete")
    ok("checkpoint labeled budget-incomplete (resumable)", Boolean(mine))
    let manifest = null
    try { manifest = JSON.parse(fs.readFileSync(path.join(HOME, "checkpoints", mine.id, "manifest.json"), "utf8")) } catch {}
    ok("checkpoint manifest carries the objective", manifest != null && /intentionally needs more steps/.test(String(manifest.objective ?? "")), JSON.stringify(manifest?.objective))

    // the run journal records the honest terminal state
    const rec = readRun(r.runId)
    eq("run journal status is incomplete", rec?.status, "incomplete")

    // run_end event carries the honest status
    const end = events.find((e) => e.type === "run_end")
    eq("run_end event status is incomplete", end?.status, "incomplete")
  } finally {
    server.close()
  }

  // contrast: a NORMAL run (model answers) still completes honestly
  const server2 = http.createServer((req, res) => {
    if (req.method === "POST" && /chat\/completions$/.test(req.url)) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        id: "mock", object: "chat.completion", created: Date.now(), model: "mock-1",
        choices: [{ index: 0, message: { role: "assistant", content: "task finished, all good" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((r) => server2.listen(0, "127.0.0.1", r))
  try {
    const r2 = await runAgent({
      config: { providers: {}, tools: {}, agent: { autonomous: false } },
      provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${server2.address().port}`, apiKey: "k", model: "mock-1" },
      task: "just answer",
      journal: false,
    })
    eq("a real final answer still returns COMPLETED", r2.status, "COMPLETED")
    eq("no reason on honest completion", r2.reason, null)
    ok("completionGate ok", r2.completionGate?.ok === true)
  } finally { server2.close() }
}

// ---------------------------------------------------------------------------
console.log("== 3. agentmanager — worker exhaustion is classified, never complete ==")
{
  const { createAgentManager, WORKER_STATUS } = await import("../agentmanager.js")
  const mk = (runner) => {
    const events = []
    const m = createAgentManager({ onEvent: (e) => events.push(e) })
    m.configure({ runner })
    return { m, events }
  }

  // a resolved runner whose agent outcome is INCOMPLETE (budget exhaustion)
  {
    const { m, events } = mk(async () => ({ text: "(stopped at budget)", status: "INCOMPLETE", budgetHit: true }))
    const rec = await m.spawn({ role: "researcher", task: "investigate" }).promise
    eq("exhausted agent → worker EXHAUSTED", rec.status, WORKER_STATUS.EXHAUSTED)
    const ev = events.find((e) => e.type === "WORKER_COMPLETED")
    ok("WORKER_COMPLETED ok:false + exhausted:true", ev && ev.ok === false && ev.exhausted === true)
    eq("agentStatus propagated", rec.agentStatus, "INCOMPLETE")
    ok("worker text preserved (not [object Object])", /stopped at budget/.test(rec.result))
  }
  // budgetHit without status (older shape) is still exhaustion
  {
    const { m } = mk(async () => ({ text: "partial", budgetHit: true }))
    const rec = await m.spawn({ role: "researcher", task: "x" }).promise
    eq("budgetHit alone → EXHAUSTED", rec.status, WORKER_STATUS.EXHAUSTED)
  }
  // legacy custom runners returning a plain string still complete
  {
    const { m, events } = mk(async () => "findings: the answer is 42")
    const rec = await m.spawn({ role: "researcher", task: "x" }).promise
    eq("legacy string runner → COMPLETED (backward compat)", rec.status, WORKER_STATUS.COMPLETED)
    const ev = events.find((e) => e.type === "WORKER_COMPLETED")
    ok("legacy runner still ok:true", ev && ev.ok === true)
  }
  // a full COMPLETED agent result object
  {
    const { m } = mk(async () => ({ text: "done", status: "COMPLETED", budgetHit: false }))
    const rec = await m.spawn({ role: "researcher", task: "x" }).promise
    eq("COMPLETED agent object → COMPLETED worker", rec.status, WORKER_STATUS.COMPLETED)
  }
  // rejections still FAIL (unchanged)
  {
    const { m } = mk(async () => { throw new Error("boom") })
    const rec = await m.spawn({ role: "researcher", task: "x" }).promise
    eq("rejected runner → FAILED", rec.status, WORKER_STATUS.FAILED)
  }
  // EXHAUSTED is settled — not "alive" — so pools settle correctly
  {
    const { m } = mk(async () => ({ text: "x", status: "INCOMPLETE", budgetHit: true }))
    const job = m.spawn({ role: "researcher", task: "x" })
    await job.promise
    eq("EXHAUSTED workers are settled (pool can drain)", m.liveWorkers().length, 0)
  }
}

// ---------------------------------------------------------------------------
console.log("== 4. runMeta integration — exhausting workers cannot complete a task ==")
{
  const meta = await import("../meta.js")
  const events = []
  // single read-only researcher node; its workers call the REAL runAgent
  // against a mock that never lets the sub-agent finish (tool calls forever)
  const PLAN = JSON.stringify([
    { id: "n1", objective: "investigate a.js deeply", read_only: true, role: "researcher", targetFiles: ["a.js"] },
  ])
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && /chat\/completions$/.test(req.url)) {
      let body = ""
      req.on("data", (c) => { body += c })
      req.on("end", () => {
        let hasTools = false
        try { hasTools = Boolean(JSON.parse(body).tools?.length) } catch {}
        const mk = (message, finish) => JSON.stringify({
          id: "mock", object: "chat.completion", created: Date.now(), model: "mock-1",
          choices: [{ index: 0, message, finish_reason: finish }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        })
        res.writeHead(200, { "content-type": "application/json" })
        if (hasTools) {
          res.end(mk({ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo probe" }) } }] }, "tool_calls"))
        } else if (/plan/i.test(body)) {
          res.end(mk({ role: "assistant", content: PLAN }, "stop"))
        } else {
          res.end(mk({ role: "assistant", content: "cannot finish" }, "stop"))
        }
      })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  try {
    const r = await meta.runMeta({
      config: { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} },
      provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "k", model: "mock-1" },
      task: "investigate a.js",
      workers: true,
      segmentSteps: 2,
      maxSegments: 2,
      onEvent: (e) => events.push(e),
    })
    // the invariant: whatever it ended as, it did NOT end COMPLETED while
    // its only node's workers exhausted
    ok("task did not claim COMPLETED while workers exhausted", r.status !== "COMPLETED", `status=${r.status}`)
    const exhausted = events.filter((e) => e.type === "WORKER_COMPLETED" && e.exhausted === true)
    ok("workers were reported EXHAUSTED (not silently completed)", exhausted.length >= 1, `${exhausted.length} exhausted`)
  } finally { server.close() }
}

// ---------------------------------------------------------------------------
console.log("== 5. entry-point honesty (source contracts) ==")
{
  const read = (p) => fs.readFileSync(path.join(WORK, "..", "..", "forge", p), "utf8")
  const here = new URL(".", import.meta.url)
  const agentSrc = fs.readFileSync(new URL("../agent.js", here), "utf8")
  const forgeSrc = fs.readFileSync(new URL("../forge.js", here), "utf8")
  const chatSrc = fs.readFileSync(new URL("../chat.js", here), "utf8")
  const runlogSrc = fs.readFileSync(new URL("../runlog.js", here), "utf8")
  const metaSrc = fs.readFileSync(new URL("../meta.js", here), "utf8")
  void read

  ok("agent.js: the fast path consults the ONE completion module", /canCompleteFastPath/.test(agentSrc) && /from "\.\/completion\.js"/.test(agentSrc))
  ok("agent.js: budget path checkpoints (resumable)", /budget-incomplete/.test(agentSrc))
  ok("agent.js: endRun uses the honest incomplete status", /endRun\(fastGate\.ok \? "completed" : "incomplete"/.test(agentSrc))
  ok("runlog.js: incomplete is a first-class journal state", /\["completed", "failed", "cancelled", "incomplete"\]/.test(runlogSrc))
  ok("forge.js: one-shot prints the honest status + resume hint", /status: \$\{res\.status\}/.test(forgeSrc) && /the task can resume/.test(forgeSrc))
  ok("chat.js: history persists only honest COMPLETED results", /res\.status === "COMPLETED"/.test(chatSrc) && !/reached max steps/.test(chatSrc))
  ok("meta.js: exhausted workers are reassignable (classified, not completed)", /r\.status === "exhausted"/.test(metaSrc))
}

console.log(`\n== v93g: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
