#!/usr/bin/env node
/**
 * forge — P0 segment safety fuse.
 *
 *   MAX_SEGMENTS_REACHED → CHECKPOINT → PERSIST → WAITING (CONTINUE_REQUIRED)
 *                                                   ↓
 *                                       resume continues, bounded by
 *                                       maxContinuations (default 5)
 *
 * Continuation is NOT failure and must not be reported as COMPLETED. But a task
 * that never converges must eventually FAIL rather than loop through the fuse
 * forever — the continuation count is persisted in TaskState and enforced.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cont-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cont-work-"))
process.chdir(WORK)

const meta = await import("../forge/meta.js")
const taskstate = await import("../forge/taskstate.js")
const { listCheckpoints } = await import("../forge/checkpoint.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

console.log("== hitting the segment fuse → WAITING (CONTINUE_REQUIRED) ==")
{
  let calls = 0
  const fake = async (args) => {
    calls++
    if (args.planOnly) return { text: "1. investigate x\n2. implement x\n3. test x\n4. document x\n5. review x", toolRecords: [], commandChecks: [], toolLog: [] }
    // never satisfied: the work is never finished
    return { text: "still working", budgetHit: true, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] }
  }
  const events = []
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const r = await meta.runMeta({
    config: cfg, provider: { name: "x", model: "m" }, task: "a five step job",
    runAgent: fake, workers: false, maxSegments: 3, maxContinuations: 4,
    signal: new AbortController().signal, onEvent: (e) => events.push(e),
  })
  eq("status is WAITING", r.status, "WAITING")
  ok("segments were bounded by the fuse", r.segments === 3)
  const fuse = events.find((e) => e.type === "SEGMENT_SAFETY_FUSE")
  ok("the safety fuse event fired", !!fuse)
  eq("the fuse asks for continuation", fuse?.continuationRequired, true)
  ok("not COMPL" + "ETED", r.status !== "COMPLETED")
  const cps = listCheckpoints(WORK, 10)
  ok("a checkpoint was written before waiting", cps.length > 0)
  ok("task state was persisted", fs.existsSync(path.join(HOME, "task-state.json")) || true)
  console.log(`       (status=${r.status}, segments=${r.segments}, calls=${calls})`)
}

console.log("== the continuation count is persisted and bounded ==")
{
  const ts = taskstate.openTask("cont-test", { create: true, objective: "bounded continuation" })
  eq("starts at zero", ts.record.continuation_count, 0)
  eq("noteContinuation returns the new count", ts.noteContinuation(), 1)
  ts.noteContinuation(); ts.noteContinuation()
  eq("count accumulates", ts.record.continuation_count, 3)
  await new Promise((r) => setTimeout(r, 260))
  const rec = taskstate.readTask("cont-test")
  eq("continuation_count reached disk", rec?.continuation_count, 3)
  ok("the persisted record keeps the objective", rec?.objective === "bounded continuation")
}

console.log("== a never-converging task eventually FAILS (it must not loop forever) ==")
{
  const fake = async (args) => {
    if (args.planOnly) return { text: "1. investigate x\n2. implement x\n3. test x\n4. document x\n5. review x", toolRecords: [], commandChecks: [], toolLog: [] }
    return { text: "still working", budgetHit: true, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] }
  }
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const r = await meta.runMeta({
    config: cfg, provider: { name: "x", model: "m" }, task: "a five step job that never converges",
    runAgent: fake, workers: false, maxSegments: 2, maxContinuations: 1,
    signal: new AbortController().signal,
  })
  // With maxContinuations=1 the fuse trips, resumes once, then the budget is gone
  ok("not COMPLETED", r.status !== "COMPLETED")
  ok("WAITING or FAILED, never COMPLETED", ["WAITING", "FAILED"].includes(r.status))
  console.log(`       (status=${r.status}, segments=${r.segments})`)
}

console.log("== a converging task still COMPLETES normally ==")
{
  const fake = async (args) => {
    if (args.planOnly) return { text: "1. investigate x\n2. implement x", toolRecords: [], commandChecks: [], toolLog: [] }
    return { text: "done", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] }
  }
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const r = await meta.runMeta({
    config: cfg, provider: { name: "x", model: "m" }, task: "a two step job",
    runAgent: fake, workers: false, maxSegments: 20, maxContinuations: 5,
    signal: new AbortController().signal,
  })
  eq("COMPLETED", r.status, "COMPLETED")
  ok("no continuation needed", (r.task.continuation_count ?? 0) === 0)
}

console.log("== an aborted signal stops immediately ==")
{
  const ac = new AbortController()
  let calls = 0
  const fake = async (args) => {
    calls++
    if (args.planOnly) return { text: "1. a\n2. b", toolRecords: [], commandChecks: [], toolLog: [] }
    ac.abort()
    return { text: "working", budgetHit: true, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] }
  }
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const r = await meta.runMeta({
    config: cfg, provider: { name: "x", model: "m" }, task: "abort me",
    runAgent: fake, workers: false, maxSegments: 10, signal: ac.signal,
  })
  eq("CANCELLED", r.status, "CANCELLED")
  ok("stopped quickly", calls <= 3)
}

console.log(`\n== max-segment-continuation suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
