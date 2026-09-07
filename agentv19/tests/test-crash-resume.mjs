#!/usr/bin/env node
/**
 * forge — P1 crash resume.
 *
 * A task killed mid-run must be DETECTABLE and RESUMABLE: the task record says
 * what it was doing, the interrupted-task scan finds it, recovery reconciles
 * every in-flight effect, and the resumed run continues from the recorded node
 * — never from a guess, and never by re-running a non-idempotent effect.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-crash-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-crash-work-"))
process.chdir(WORK)

const ts = await import("../forge/taskstate.js")
const recovery = await import("../forge/recovery.js")
const meta = await import("../forge/meta.js")
const dag = await import("../forge/dag.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

console.log("== a task killed mid-run is detectable ==")
{
  const t = ts.openTask("crash-1", { create: true, objective: "rewrite the parser", cwd: WORK })
  t.setPlan(["investigate", "rewrite", "test"], "model")
  t.setDAG(dag.serializeDAG(dag.buildDAG([
    { id: "n1", objective: "investigate", read_only: true, role: "researcher" },
    { id: "n2", objective: "rewrite", dependencies: ["n1"], role: "coder" },
  ])))
  t.setSegmentId("seg-2")
  t.setNodeId("n2")
  t.setVerificationEpoch(3)
  t.transition(ts.TASK_STATUS.EXECUTING, { reason: "started segment 2" })
  t.setLastOperation({ kind: "edit", tool: "edit_file", path: "src/parser.js", at: Date.now(), status: "unknown" })
  // a real crash leaves a DEAD owning pid behind — simulate that exactly
  t.record.pid = 999999
  t.flush(ts.DURABILITY.CRITICAL)

  // the process that owned it is dead now
  const rec = ts.readTask("crash-1")
  eq("status on disk", rec.status, ts.TASK_STATUS.EXECUTING)
  eq("node id on disk", rec.node_id, "n2")
  eq("segment id on disk", rec.segment_id, "seg-2")
  eq("verification epoch on disk", rec.verification_epoch, 3)
  ok("the last operation was persisted", !!rec.last_completed_operation)
  const interrupted = ts.interruptedTasks({ cwd: WORK })
  ok("the task is found by the interrupted scan", interrupted.some((x) => x.task_id === "crash-1"))
}

console.log("== recovery reconciles every in-flight effect ==")
{
  const t = ts.openTask("crash-2", { create: true, objective: "migrate the database", cwd: WORK })
  t.transition(ts.TASK_STATUS.EXECUTING, { reason: "running" })
  t.noteFiles(["src/a.js"], [])
  t.noteRepair(1)
  t.setLastOperation({ kind: "bash", command: "prisma migrate deploy", at: Date.now(), status: "unknown" })
  t.flush(ts.DURABILITY.CRITICAL)
  const rec = ts.readTask("crash-2")
  const recon = recovery.reconcileTask(rec, { cwd: WORK })
  ok("a recovery verdict exists", !!recon)
  ok("it reports the task id", recon.taskId === "crash-2" || recon.task_id === "crash-2")
  ok("it recommends an action", typeof recon.recommended === "string")
  ok("effects were reconciled", recon.effects && typeof recon.effects === "object")
  ok("the recorded changed file was checked", Array.isArray(recon.effects.modified) || Array.isArray(recon.effects.missing))
  ok("it reports the git state", !!recon.effects.git)
  ok("it says whether resume is possible", typeof recon.canResume === "boolean")
  ok("a resume prompt can be built", typeof recovery.resumePrompt(rec, recon, WORK) === "string")
  console.log(`       (decision=${recon.decision})`)
}

console.log("== resume continues from the recorded node, not from zero ==")
{
  const graph = dag.buildDAG([
    { id: "n1", objective: "investigate", read_only: true, role: "researcher" },
    { id: "n2", objective: "rewrite", dependencies: ["n1"], role: "coder" },
    { id: "n3", objective: "test", dependencies: ["n2"], role: "tester" },
  ])
  dag.markCompleted(graph, "n1", null, { verification: dag.VERIFICATION_NOT_REQUIRED })
  const t = ts.openTask("resume-1", { create: true, objective: "rewrite the thing", cwd: WORK })
  t.setDAG(dag.serializeDAG(graph))
  t.setNodeId("n2")
  t.setSegmentId("seg-4")
  t.transition(ts.TASK_STATUS.WAITING, { reason: "interrupted" })
  t.flush(ts.DURABILITY.CRITICAL)

  const seen = []
  const fake = async (args) => {
    seen.push({ planOnly: !!args.planOnly, nodeId: args.nodeId ?? null, task: String(args.task).slice(0, 40) })
    if (args.planOnly) return { text: "", toolRecords: [], commandChecks: [], toolLog: [] }
    return {
      text: "done", budgetHit: false, steps: 1, toolRecords: [],
      commandChecks: [
        { command: "node --check src/x.js", exitCode: 0, passed: true, tail: "ok" },
        { command: "npx vitest run src/x.test.js", exitCode: 0, passed: true, tail: "1 passed" },
      ],
      toolLog: [],
    }
  }
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const r = await meta.runMeta({
    config: cfg, provider: { name: "x", model: "m" }, task: "rewrite the thing",
    runAgent: fake, workers: false, maxSegments: 8, resumeTaskId: "resume-1",
    signal: new AbortController().signal,
  })
  ok("the run resumed the recorded task", r.status !== undefined)
  ok("no re-plan happened (the DAG was restored)", seen.every((s) => !s.planOnly))
  const nodes = r.task.dag?.nodes ?? []
  ok("n1 was already complete and stayed complete", nodes.find((n) => n.id === "n1")?.status === "completed")
  console.log(`       (status=${r.status}, nodes=${JSON.stringify(nodes.map((n) => `${n.id}:${n.status}`))})`)
}

console.log("== a completed task is never offered as interrupted ==")
{
  const t = ts.openTask("done-1", { create: true, objective: "finished work", cwd: WORK })
  t.transition(ts.TASK_STATUS.EXECUTING, { reason: "working" })
  t.transition(ts.TASK_STATUS.COMPLETED, { reason: "done" })
  t.flush(ts.DURABILITY.CRITICAL)
  const interrupted = ts.interruptedTasks({ cwd: WORK })
  ok("the finished task is not in the interrupted list", !interrupted.some((x) => x.task_id === "done-1"))
}

console.log("== interrupted detection does not swallow a live task ==")
{
  const t = ts.openTask("live-1", { create: true, objective: "still running", cwd: WORK })
  t.transition(ts.TASK_STATUS.EXECUTING, { reason: "working" })
  t.flush(ts.DURABILITY.CRITICAL)
  // the owning pid is THIS process, which is alive
  const interrupted = ts.interruptedTasks({ cwd: WORK })
  ok("a task owned by a live pid is not interrupted", !interrupted.some((x) => x.task_id === "live-1"))
}

console.log(`\n== crash-resume suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
