#!/usr/bin/env node
/**
 * v94 "masterwise" — TRUE DYNAMIC EXECUTION (§6/§7/§8/§9/§10/§29/§34 EXECUTION).
 *
 * Acceptance contract for the ExecutionController and the unified completion
 * semantics:
 *
 *   1. «25 steps»/«100 logical actions»: a step counter is TELEMETRY, never a
 *      completion condition. A task whose EVERY segment ends on its budget
 *      still completes — through the gate, when the verified DAG says so —
 *      and a never-finishing task is parked WAITING by the fuse, never
 *      COMPLETED by the counter.
 *   2. segment continuation: budget end → observe → continue (never terminal).
 *   3. stuck detection: repeated tool signatures / repeated identical
 *      failures / no meaningful state change → DIAGNOSE → CHANGE STRATEGY →
 *      REPLAN → CONTINUE — never completion, never silent.
 *   4. repeated failure: an honestly unrecoverable task FAILS after its
 *      repair budget (a legitimate stop under §9.2) — it never completes.
 *   5. resource fuses (§29): failure_rate → replan; wall_clock → checkpoint
 *      → WAIT (resumable). Segment size adapts deterministically (§8).
 *   6. agent-level (§6/§7): a budget-forced "final answer" (produced because
 *      the tool-call budget ordered it) on the step-budget boundary is
 *      INCOMPLETE + checkpoint + resume — never COMPLETED. A real answer on
 *      the last allowed step, or an answer with budget left, completes.
 *   7. checkpoint/resume: the fuse writes a checkpoint and the task resumes.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v94-exec-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v94-exec-work-"))
process.chdir(WORK)

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 220) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const meta = await import("../meta.js")
const xc = await import("../execcontroller.js")

const CFG = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }

// ---------------------------------------------------------------------------
console.log("== 1. «25 steps»: the counter ends SEGMENTS, never the task ==")
{
  let actions = 0
  const fake = async (args) => {
    actions++
    if (args.planOnly) return { text: "1. investigate x\n2. implement x\n3. verify x", toolRecords: [], commandChecks: [], toolLog: [] }
    // the agent burns its budget for the first 4 segments (20 steps) — the
    // counter ends each SEGMENT; only the verified-complete final segment
    // (clean end, no budget) lets the gate decide COMPLETED
    if (actions <= 5) return { text: "still working", budgetHit: true, steps: 5, toolRecords: [], commandChecks: [], toolLog: [] }
    return { text: "done: verified", budgetHit: false, steps: 5, toolRecords: [], commandChecks: [], toolLog: [] }
  }
  const events = []
  const r = await meta.runMeta({
    config: CFG, provider: { name: "x", model: "m" }, task: "a three step job that needs more than 25 steps",
    runAgent: fake, workers: false, maxSegments: 20, segmentSteps: 5,
    signal: new AbortController().signal, onEvent: (e) => events.push(e),
  })
  eq("COMPLETED — the step counter never decided completion", r.status, "COMPLETED")
  ok("the work crossed multiple budget boundaries (25 logical steps)", r.segments >= 5, `segments=${r.segments}`)
  const segDone = events.filter((e) => e.type === "SEGMENT_COMPLETED")
  ok("every boundary segment ended on its budget (budget is telemetry)", segDone.length >= 5 && segDone.slice(0, 4).every((e) => e.budgetHit === true))
  ok("no fuse was needed — the gate completed the verified work", !events.some((e) => e.type === "SEGMENT_SAFETY_FUSE"))
  ok("budget events were recorded as telemetry, not termination", events.filter((e) => e.type === "SEGMENT_BUDGET_TELEMETRY").length >= 4)
  ok("the task logical action count exceeded any single segment budget", actions >= 6, `actions=${actions}`)
}

console.log("== 2. a task that never finishes is PARKED (WAITING), never completed by the counter ==")
{
  const fake = async (args) => {
    if (args.planOnly) return { text: "1. investigate x\n2. implement x\n3. test x\n4. document x\n5. review x", toolRecords: [], commandChecks: [], toolLog: [] }
    return { text: "still working", budgetHit: true, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] }
  }
  const events = []
  const r = await meta.runMeta({
    config: CFG, provider: { name: "x", model: "m" }, task: "an unbounded job",
    runAgent: fake, workers: false, maxSegments: 2, maxContinuations: 4,
    signal: new AbortController().signal, onEvent: (e) => events.push(e),
  })
  ok("not COMPLETED", r.status !== "COMPLETED")
  ok("WAITING (continue required) — resumable, not failed", r.status === "WAITING", r.status)
  ok("the safety fuse fired", events.some((e) => e.type === "SEGMENT_SAFETY_FUSE"))
}

// ---------------------------------------------------------------------------
console.log("== 3. stuck detection: tool loop → diagnose → strategy escape → continue ==")
{
  const ghosts = Array.from({ length: 8 }, (_, i) => `ghost${i}.txt`)
  const fake = async (args) => {
    if (args.planOnly) return { text: "1. edit the ghost files\n2. review the ghost files", toolRecords: [], commandChecks: [], toolLog: [] }
    // the SAME tool call, identical arguments, every segment — and 8 "changed"
    // files whose high verification risk can never be satisfied, so the node
    // stays verifying forever and the graph cannot complete
    return {
      text: "running the same command again", budgetHit: true, steps: 1,
      toolRecords: [{ tool: "bash", args: { command: "npm test" }, files_changed: ghosts }],
      commandChecks: [], toolLog: [],
    }
  }
  const events = []
  const r = await meta.runMeta({
    // LARGE class: the stuck-escape replan policy (like the failure-driven
    // one) does not rewrite MICRO/SMALL graphs — a 1-3 node plan IS the
    // strategy. Stuck escape needs a plan worth rewriting.
    config: CFG, provider: { name: "x", model: "m" },
    task: "refactor the parser module structure and update all related tests and documentation across the repository",
    runAgent: fake, workers: false, maxSegments: 8,
    signal: new AbortController().signal, onEvent: (e) => events.push(e),
  })
  const stuck = events.find((e) => e.type === "STUCK_DETECTED")
  ok("STUCK_DETECTED fired", !!stuck, JSON.stringify([...new Set(events.map((e) => e.type))]))
  ok("the stuck reason is the repeated tool signature", stuck?.reason === "tool_loop", stuck?.reason)
  ok("the stuck signal was surfaced to the loop (SEGMENT_STUCK)", events.some((e) => e.type === "SEGMENT_STUCK"))
  ok("stuck did NOT become completion", r.status !== "COMPLETED")
  ok("stuck did NOT become failure either — it escapes strategy and continues", r.status === "WAITING", r.status)
  ok("the strategy escape produced a replan", events.some((e) => e.type === "PLAN_REPLAN_STARTED"))
  ok("the fuse eventually parked it with a checkpoint (bounded, resumable)", events.some((e) => e.type === "SEGMENT_SAFETY_FUSE"))
}

console.log("== 4. repeated identical failure: honest FAILED after the repair budget (§9.2), never COMPLETED ==")
{
  let calls = 0
  const fake = async (args) => {
    calls++
    if (args.planOnly) return { text: "1. investigate x\n2. implement x", toolRecords: [], commandChecks: [], toolLog: [] }
    return { status: "FAILED", error: "EPROVIDER: upstream model provider unreachable", text: "", steps: 0, toolRecords: [], commandChecks: [], toolLog: [], budgetHit: false }
  }
  const events = []
  const r = await meta.runMeta({
    config: CFG, provider: { name: "x", model: "m" }, task: "a doomed job",
    runAgent: fake, workers: false, maxSegments: 12,
    signal: new AbortController().signal, onEvent: (e) => events.push(e),
  })
  eq("FAILED is the honest terminal for verified unrecoverable failure", r.status, "FAILED")
  ok("the give-up reason is recorded", String(r.task?.errors ?? JSON.stringify(r.task ?? "")).includes("GIVE_UP") || String(r.text ?? "").includes("consecutive failed segments"), r.text?.slice(0, 120))
  ok("the same-failure stuck signal was observed too", events.some((e) => e.type === "STUCK_DETECTED" && e.reason === "repeat_failure"))
  ok("it never completed", r.status !== "COMPLETED")
}

// ---------------------------------------------------------------------------
console.log("== 5. ExecutionController units: adaptive segments + enforced fuses (§8/§29) ==")
{
  const ctl = xc.createExecutionController({ taskId: "t-x", runId: "r-x" })
  // deterministic adaptive segment sizing
  eq("ARCHITECTURAL base is 40", ctl.segmentSize({ klass: "ARCHITECTURAL" }), 40)
  eq("MICRO base is 8", ctl.segmentSize({ klass: "MICRO" }), 8)
  ok("failure rate shrinks segments (earlier checkpoints)", ctl.segmentSize({ klass: "LARGE", failureRate: 0.8 }) < ctl.segmentSize({ klass: "LARGE", failureRate: 0 }))
  ok("resource pressure shrinks segments", ctl.segmentSize({ klass: "LARGE", pressureLevel: "adapting" }) < ctl.segmentSize({ klass: "LARGE" }))
  ok("slow tools shrink segments", ctl.segmentSize({ klass: "LARGE", avgToolLatencyMs: 30000 }) < ctl.segmentSize({ klass: "LARGE" }))
  ok("clamped to [8, 64]", ctl.segmentSize({ klass: "MICRO", failureRate: 1 }) >= 8 && ctl.segmentSize({ klass: "ARCHITECTURAL" }) <= 64)

  // fuses are enforced, not displayed
  eq("wall_clock fuse → checkpoint_wait", ctl.enforceFuses([{ fuse: "wall_clock", action: "checkpoint_and_wait", why: "4h" }], { segment: 1 }).action, "checkpoint_wait")
  eq("failure_rate fuse → replan", ctl.enforceFuses([{ fuse: "failure_rate", action: "replan", why: "majority failing" }], { segment: 2 }).action, "replan")
  eq("no fuses → none", ctl.enforceFuses([], { segment: 3 }).action, "none")

  // stuck: tool loop at the 4th identical signature
  for (let i = 0; i < 3; i++) ctl.observeSegment({ segment: i + 1, toolRecords: [{ tool: "bash", args: { command: "npm test" } }], filesChanged: 1 })
  const d4 = ctl.observeSegment({ segment: 4, toolRecords: [{ tool: "bash", args: { command: "npm test" } }], filesChanged: 1 })
  ok("4th identical tool signature → tool_loop stuck", d4.stuck?.reason === "tool_loop", JSON.stringify(d4.stuck))

  // stuck: no meaningful state change across 3 segments
  const ctl2 = xc.createExecutionController({ taskId: "t-y", runId: "r-y" })
  ctl2.observeSegment({ segment: 1, toolRecords: [] })
  ctl2.observeSegment({ segment: 2, toolRecords: [] })
  const d3 = ctl2.observeSegment({ segment: 3, toolRecords: [] })
  ok("3 idle segments → no_progress stuck", d3.stuck?.reason === "no_progress", JSON.stringify(d3.stuck))
  const d4p = ctl2.observeSegment({ segment: 4, toolRecords: [], filesChanged: 2, nodesCompleted: 1 })
  ok("progress resets the idle streak", d4p.stuck === null && d4p.action === "continue")

  // stuck: repeated identical failures
  const ctl3 = xc.createExecutionController({ taskId: "t-z", runId: "r-z" })
  ctl3.observeSegment({ segment: 1, error: "EPROVIDER upstream down" })
  const d2f = ctl3.observeSegment({ segment: 2, error: "EPROVIDER  upstream down " })
  ok("same failure twice → repeat_failure stuck", d2f.stuck?.reason === "repeat_failure", JSON.stringify(d2f.stuck))
  const d3f = ctl3.observeSegment({ segment: 3, error: "a different error entirely" })
  ok("a different error resets the streak", d3f.stuck === null)

  // controller never yields a "complete" action
  const actions = new Set()
  for (let i = 0; i < 30; i++) {
    const d = ctl3.observeSegment({ segment: 10 + i, toolRecords: [], filesChanged: i % 2 })
    actions.add(d.action)
  }
  ok("the controller's vocabulary is continue/replan — NEVER complete", ![...actions].some((a) => /complete/i.test(String(a))), [...actions].join(","))
}

// ---------------------------------------------------------------------------
console.log("== 6. agent-level: a budget-FORCED answer is INCOMPLETE, a real answer completes (§6/§7) ==")
{
  const { runAgent } = await import("../agent.js")
  // minimal OpenAI-protocol mock — a request COUNTER drives the scripted
  // conversation (content-sniffing is unreliable: the system prompt may name
  // tools without the model having called any)
  let mode = "coerced"
  let reqIdx = 0
  const srv = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      reqIdx++
      res.writeHead(200, { "content-type": "application/json" })
      const body = JSON.parse(raw || "{}")
      const nudgeSeen = (body.messages ?? []).some((m) => String(m.content ?? "").includes("tool-call budget exhausted"))
      let message
      if (mode === "coerced") {
        // req1: five tool calls (count 5, executed) → req2: six more (count 11
        // > the floored budget of 10 → nudge fires) → req3: coerced answer
        const mk = (n, tag) => Array.from({ length: n }, (_, i) => ({ id: `c${tag}_${i}`, type: "function", function: { name: "list_dir", arguments: "{\"path\":\".\"}" } }))
        if (nudgeSeen) message = { role: "assistant", content: "final answer under budget pressure" }
        else if (reqIdx === 1) message = { role: "assistant", content: "", tool_calls: mk(5, "a") }
        else message = { role: "assistant", content: "", tool_calls: mk(6, "b") }
      } else if (mode === "natural-on-budget") {
        // req1: one real tool call, req2: a real answer exactly on the last step
        message = reqIdx === 1
          ? { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "list_dir", arguments: "{\"path\":\".\"}" } }] }
          : { role: "assistant", content: "the real final answer" }
      } else {
        message = { role: "assistant", content: "quick answer, budget left" }
      }
      res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 10 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const port = srv.address().port
  const provider = { name: "openai", model: "mock-chat", protocol: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "sk-test", contextWindow: 128000 }

  mode = "coerced"
  const cfgA = { providers: {}, activeProvider: "openai", agent: { maxSteps: 3, maxToolCalls: 2 }, skills: { enabled: false } }
  const rA = await runAgent({ config: cfgA, provider, task: "list the directory", journal: false })
  eq("budget-forced answer + budget end → INCOMPLETE", rA.status, "INCOMPLETE")
  eq("reason is the resource limit", rA.reason, "RESOURCE_LIMIT")
  ok("a checkpoint was saved for resume", typeof rA.resume?.checkpointId === "string" && rA.resume.checkpointId.length > 0)
  ok("the text says the answer was budget-forced", /forced by the tool-call budget/.test(rA.text ?? ""), rA.text?.slice(0, 160))
  ok("never reported COMPLETED", rA.status !== "COMPLETED")

  mode = "natural-on-budget"
  const cfgB = { providers: {}, activeProvider: "openai", agent: { maxSteps: 2, maxToolCalls: 10 }, skills: { enabled: false } }
  const rB = await runAgent({ config: cfgB, provider, task: "list the directory", journal: false })
  eq("a REAL answer produced on the last allowed step completes", rB.status, "COMPLETED")

  mode = "quick"
  const cfgC = { providers: {}, activeProvider: "openai", agent: { maxSteps: 5, maxToolCalls: 10 }, skills: { enabled: false } }
  const rC = await runAgent({ config: cfgC, provider, task: "quick question", journal: false })
  eq("an answer with budget left completes normally", rC.status, "COMPLETED")

  srv.close()
  mode = "coerced"; reqIdx = 0
}

// ---------------------------------------------------------------------------
console.log("== 7. checkpoint/resume: the fuse parks the task, a resume continues it ==")
{
  const fakeFactory = () => async (args) => {
    if (args.planOnly) return { text: "1. investigate x\n2. implement x\n3. test x", toolRecords: [], commandChecks: [], toolLog: [] }
    return { text: "working", budgetHit: true, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] }
  }
  const first = await meta.runMeta({
    config: CFG, provider: { name: "x", model: "m" }, task: "a resumable job",
    runAgent: fakeFactory(), workers: false, maxSegments: 1,
    signal: new AbortController().signal,
  })
  ok("first run parks at the fuse", first.status === "WAITING", first.status)
  ok("a taskId exists to resume", typeof first.taskId === "string" && first.taskId.length > 0)
  const resume = await meta.runMeta({
    config: CFG, provider: { name: "x", model: "m" }, task: "a resumable job",
    runAgent: fakeFactory(), workers: false, maxSegments: 1, resumeTaskId: first.taskId,
    signal: new AbortController().signal,
  })
  ok("the resume actually resumed the same task", resume.taskId === first.taskId)
  ok("the resumed run continued executing (not stuck in WAITING)", resume.segments >= 1)
  ok("resume is still bounded by the fuse (honest WAITING again)", resume.status === "WAITING")
}

console.log(`\n== v94 execution suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
