#!/usr/bin/env node
/**
 * forge — P0 worker timeout / orphan race.
 *
 * Before: `withTimeout` raced the runner and then STOPPED CARING. The
 * controller saw `timed_out`, decremented `active` and started the next
 * segment while the orphaned agent kept running — mutating files and the DAG
 * behind the controller's back. There was no per-worker cancellation token, so
 * nothing could even ask it to stop.
 *
 * Now: REQUEST_CANCEL → WAIT_FOR_SHUTDOWN → CONFIRM_NOT_RUNNING → PERSIST.
 * A worker that ignores cancellation is reported as ORPHANED and stays counted
 * as active, so the completion gate can never be lied to.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-worker-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-worker-work-"))
process.chdir(WORK)

const { createAgentManager, WORKER_STATUS } = await import("../agentmanager.js")
const dag = await import("../dag.js")
const { canCompleteTask, CHECK } = await import("../completion.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

console.log("== every worker carries full identity ==")
{
  const m = createAgentManager({ maxWorkers: 1, defaultTimeoutMs: 1000, runner: async () => "ok" })
  const rec = m.spawn({ role: "researcher", task: "t", dagNode: "n7", taskId: "task-1", runId: "run-1", segmentId: "seg-2", nodeId: "n7" })
  for (const field of ["workerId", "taskId", "runId", "segmentId", "nodeId", "status", "startedAt"]) {
    ok(`record has ${field}`, field in rec)
  }
  ok("cancellationToken slot exists", "cancellationToken" in rec)
  ok("finishedAt slot exists", "finishedAt" in rec)
  await rec.promise
  const w = m.list()[0]
  eq("nodeId propagated", w.nodeId, "n7")
  eq("taskId propagated", w.taskId, "task-1")
  eq("runId propagated", w.runId, "run-1")
  eq("segmentId propagated", w.segmentId, "seg-2")
  ok("status settled", w.status === WORKER_STATUS.COMPLETED)
  ok("startedAt set", typeof w.startedAt === "number")
  ok("finishedAt set", typeof w.finishedAt === "number")
  ok("cancellationToken was created", w.cancellationToken !== null)
}

console.log("== timeout: the runner is asked to stop and awaited ==")
{
  let aborted = false
  let finishedAt = null
  const m = createAgentManager({
    maxWorkers: 1, defaultTimeoutMs: 120,
    runner: async ({ signal }) => {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 3000)
        signal?.addEventListener?.("abort", () => { clearTimeout(t); aborted = true; resolve() }, { once: true })
      })
      finishedAt = Date.now()
      return "too late"
    },
  })
  const t0 = Date.now()
  const rec = m.spawn({ role: "researcher", task: "hang", dagNode: "n1", nodeId: "n1" })
  await rec.promise
  const dt = Date.now() - t0
  eq("status is timed_out", rec.status, WORKER_STATUS.TIMED_OUT)
  ok("cancellation was requested", aborted === true)
  ok("controller waited for the runner to actually stop", finishedAt !== null && dt < 2500)
  ok("result from after the deadline is NOT reported as success", rec.result === null)
  ok("error names the timeout", /timed out/.test(String(rec.error)))
  eq("pool is empty afterwards", m.stats().active, 0)
  eq("no live workers", m.stats().live, 0)
}

console.log("== a worker that ignores cancellation is reported as an ORPHAN ==")
{
  const m = createAgentManager({
    maxWorkers: 1, defaultTimeoutMs: 100,
    runner: async () => { await new Promise((r) => setTimeout(r, 9000)); return "late" },
  })
  const rec = m.spawn({ role: "researcher", task: "stubborn", nodeId: "n2" })
  await rec.promise
  eq("status is orphaned", rec.status, WORKER_STATUS.ORPHANED)
  ok("orphan flag set", rec.orphaned === true)
  ok("still counted as active (never hidden)", m.stats().active === 1)
  ok("still counted as live", m.stats().live === 1)
  // the completion gate must refuse while it is alive
  const g = dag.buildDAG([{ id: "a", objective: "x", status: dag.NODE_STATUS.COMPLETED }])
  const gate = canCompleteTask({ dag: g, workersSettled: m.stats().active === 0, activeWorkers: m.stats().active, verificationRequired: false })
  ok("gate blocks while a worker is alive", gate.ok === false)
  ok("gate names the worker check", gate.checks[CHECK.ALL_WORKERS_SETTLED] === false)
}

console.log("== settle(): request → wait → confirm ==")
{
  const events = []
  let stopped = false
  const m = createAgentManager({
    maxWorkers: 4, defaultTimeoutMs: 2000, onEvent: (e) => events.push(e.type),
    runner: async ({ signal }) => {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 5000)
        signal?.addEventListener?.("abort", () => { clearTimeout(t); stopped = true; resolve() }, { once: true })
      })
      return "ok"
    },
  })
  const a = m.spawn({ role: "researcher", task: "a", nodeId: "n1" })
  const b = m.spawn({ role: "reviewer", task: "b", nodeId: "n2" })
  const s = await m.settle({ graceMs: 1500, cancelRunning: true })
  ok("settle reports settled", s.settled === true)
  eq("nothing still running", s.stillRunning.length, 0)
  ok("cancellation was requested", events.includes("WORKER_CANCELLED") || events.includes("WORKER_CANCEL_REQUESTED"))
  ok("settlement was announced", events.includes("WORKERS_SETTLED"))
  ok("the runners really stopped", stopped === true)
  await Promise.all([a.promise, b.promise])
  eq("pool idle", m.stats().active, 0)
}

console.log("== cancel() reaches a queued and a running worker ==")
{
  const m = createAgentManager({
    maxWorkers: 1, defaultTimeoutMs: 5000,
    runner: async ({ signal }) => {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 2000)
        signal?.addEventListener?.("abort", () => { clearTimeout(t); resolve() }, { once: true })
      })
      return "ok"
    },
  })
  const running = m.spawn({ role: "researcher", task: "running", nodeId: "n1" })
  await new Promise((r) => setTimeout(r, 50))
  const queued = m.spawn({ role: "reviewer", task: "queued", nodeId: "n2" })
  ok("cancel(running) accepted", m.cancel(running.id) === true)
  ok("cancel(queued) accepted", m.cancel(queued.id) === true)
  await Promise.all([running.promise, queued.promise])
  ok("running worker ended cancelled", running.status === WORKER_STATUS.CANCELLED)
  ok("queued worker ended cancelled", queued.status === WORKER_STATUS.CANCELLED)
  eq("pool idle", m.stats().active, 0)
}

console.log("== repeated execution leaks nothing ==")
{
  let live = 0
  const m = createAgentManager({
    maxWorkers: 3, defaultTimeoutMs: 2000,
    runner: async () => { live++; await new Promise((r) => setTimeout(r, 1)); live--; return "ok" },
  })
  for (let round = 0; round < 5; round++) {
    const recs = []
    for (let i = 0; i < 6; i++) recs.push(m.spawn({ role: "researcher", task: `r${round}-${i}`, nodeId: `n${i}` }))
    await Promise.all(recs.map((r) => r.promise))
  }
  await m.settle({ graceMs: 500 })
  const st = m.stats()
  eq("no worker left active", st.active, 0)
  eq("no worker left live", st.live, 0)
  eq("no runner left mid-flight", live, 0)
  eq("all 30 workers settled", st.completed, 30)
  ok("every record has a finishedAt", m.list().every((w) => typeof w.finishedAt === "number"))
}

console.log("== a timed-out worker never completes its DAG node ==")
{
  const g = dag.buildDAG([
    { id: "n1", objective: "research", read_only: true, role: "researcher" },
    { id: "n2", objective: "implement", dependencies: ["n1"], role: "coder" },
  ])
  const m = createAgentManager({
    maxWorkers: 2, defaultTimeoutMs: 80,
    runner: async () => { await new Promise((r) => setTimeout(r, 4000)); return "findings" },
  })
  dag.markRunning(g, "n1")
  const rec = m.spawn({ role: "researcher", task: "research", dagNode: "n1", nodeId: "n1" })
  await rec.promise
  ok("worker did not complete", rec.status !== WORKER_STATUS.COMPLETED)
  ok("node is NOT completed by a timed-out worker", g.nodes.get("n1").status !== dag.NODE_STATUS.COMPLETED)
  ok("DAG is not complete", dag.allComplete(g) === false)
  ok("gate refuses", canCompleteTask({ dag: g, workersSettled: false, activeWorkers: 1, verificationRequired: false }).ok === false)
}

console.log(`\n== worker-timeout-cleanup suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
