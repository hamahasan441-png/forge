#!/usr/bin/env node
/**
 * forge — P0 node verification gate.
 *
 *   RUNNING → EXECUTION_SUCCEEDED → VERIFYING ─┬─ PASS → COMPLETED
 *                                              └─ FAIL → REPAIRING → VERIFYING
 *
 * Execution success ("the tools ran") is NOT node completion ("the requested
 * outcome was verified"). Before this suite existed, meta.js called
 * markCompleted(nodeId) immediately after a successful segment — so a node was
 * 'completed' with a failing test run behind it, and stayed completed.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-nodegate-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-nodegate-work-"))
process.chdir(WORK)

const dag = await import("../dag.js")
const { createLedger } = await import("../verifyledger.js")
const meta = await import("../meta.js")
const { runAgent } = await import("../agent.js")
const { makeToolContext } = await import("../tools.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

// ---------------------------------------------------------------------------
console.log("== state machine: execution success ≠ completion ==")
{
  const g = dag.buildDAG([{ id: "n1", objective: "fix the bug", role: "coder", read_only: false }])
  ok("node starts ready", g.nodes.get("n1").status === dag.NODE_STATUS.READY)
  ok("executeNode takes it", !!dag.executeNode(g, "n1", { taskId: "t1", runId: "r1", segmentId: "seg-1" }))
  eq("now running", g.nodes.get("n1").status, dag.NODE_STATUS.RUNNING)

  ok("markExecutionSucceeded accepted", dag.markExecutionSucceeded(g, "n1", "tools all ran") === true)
  eq("state is execution_succeeded", g.nodes.get("n1").status, dag.NODE_STATUS.EXECUTION_SUCCEEDED)
  ok("allComplete still false", dag.allComplete(g) === false)
  ok("verificationSatisfied is explicitly false", dag.verificationSatisfied(g.nodes.get("n1")) === false)

  // the gate refuses completion without evidence
  ok("markCompleted refused without verification", dag.markCompleted(g, "n1") === false)
  eq("still execution_succeeded", g.nodes.get("n1").status, dag.NODE_STATUS.EXECUTION_SUCCEEDED)

  ok("markVerifying accepted", dag.markVerifying(g, "n1") === true)
  eq("state is verifying", g.nodes.get("n1").status, dag.NODE_STATUS.VERIFYING)

  ok("completion with evidence accepted", dag.markCompleted(g, "n1", "verified", { verification: { verification_id: "ver-1", verificationEpoch: 4 } }) === true)
  eq("completed", g.nodes.get("n1").status, dag.NODE_STATUS.COMPLETED)
  eq("verification id recorded", g.nodes.get("n1").verificationId, "ver-1")
  ok("allComplete true", dag.allComplete(g) === true)
  ok("verificationSatisfied true", dag.verificationSatisfied(g.nodes.get("n1")) === true)
}

console.log("== failed verification → REPAIRING, never COMPLETED ==")
{
  const g = dag.buildDAG([{ id: "n1", objective: "fix the bug", role: "coder" }])
  dag.executeNode(g, "n1")
  dag.markExecutionSucceeded(g, "n1")
  dag.markVerifying(g, "n1")
  ok("markRepairing accepted", dag.markRepairing(g, "n1", "npm test failed") === true)
  eq("state is repairing", g.nodes.get("n1").status, dag.NODE_STATUS.REPAIRING)
  ok("verification flag reset", dag.verificationSatisfied(g.nodes.get("n1")) === false)
  ok("completion still refused", dag.markCompleted(g, "n1") === false)
  // retry after repair → verify → complete
  ok("retryNode from repairing", dag.retryNode(g, "n1") === true)
  eq("back to ready", g.nodes.get("n1").status, dag.NODE_STATUS.READY)
  dag.executeNode(g, "n1")
  dag.markExecutionSucceeded(g, "n1")
  ok("completes after a passing verification", dag.markCompleted(g, "n1", null, { verification: { verification_id: "ver-2" } }) === true)
  eq("completed after repair loop", g.nodes.get("n1").status, dag.NODE_STATUS.COMPLETED)
}

console.log("== read-only nodes: NOT_REQUIRED is recorded, not assumed ==")
{
  const g = dag.buildDAG([{ id: "r1", objective: "investigate", role: "researcher", read_only: true }])
  dag.executeNode(g, "r1")
  dag.markExecutionSucceeded(g, "r1")
  ok("completes with the NOT_REQUIRED sentinel", dag.markCompleted(g, "r1", null, { verification: dag.VERIFICATION_NOT_REQUIRED }) === true)
  eq("verification mode recorded", g.nodes.get("r1").verificationMode, "not_required")
  ok("allComplete true", dag.allComplete(g) === true)
}

console.log("== ledger-backed evidence is what unlocks completion ==")
{
  const ledger = createLedger()
  const rec = ledger.recordCommand("npx vitest run src/a.test.js", "3 tests passed\n[exit code: 0]", {
    exitCode: 0, affectedFiles: ["src/a.js"], taskId: "t1", nodeId: "n1", segmentId: "seg-1",
  })
  ok("evidence record passed", rec.passed === true)
  // medium risk requires syntax + focused_test: half the evidence is not enough
  ok("focused test alone does not satisfy medium risk", ledger.status("medium", ["src/a.js"], { nodeId: "n1" }).ok === false)
  ledger.recordCommand("node --check src/a.js", "ok\n[exit code: 0]", {
    exitCode: 0, affectedFiles: ["src/a.js"], taskId: "t1", nodeId: "n1", segmentId: "seg-1",
  })
  const st = ledger.status("medium", ["src/a.js"], { nodeId: "n1" })
  ok("ledger says verified for medium risk", st.ok === true)
  const g = dag.buildDAG([{ id: "n1", objective: "fix a", role: "coder" }])
  dag.executeNode(g, "n1"); dag.markExecutionSucceeded(g, "n1")
  ok("node completes with the ledger record", dag.markCompleted(g, "n1", null, { verification: rec }) === true)
  eq("epoch carried from the record", g.nodes.get("n1").verificationEpoch > 0, true)
}

// ---------------------------------------------------------------------------
console.log("== end-to-end: a failing verification keeps the node out of COMPLETED ==")
{
  let call = 0
  const fake = async (args) => {
    call++
    if (args.planOnly) return { text: "1. fix the parser", toolRecords: [], commandChecks: [], toolLog: [] }
    return {
      text: "changed it", budgetHit: false, steps: 2,
      toolRecords: [{ tool: "edit_file", files_changed: ["src/p.js"] }],
      commandChecks: [{ command: "npx vitest run src/p.test.js", exitCode: 1, passed: false, tail: "2 tests failed" }],
      toolLog: [{ name: "edit_file" }],
    }
  }
  fs.writeFileSync(path.join(WORK, "src-p.js"), "")
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const r = await meta.runMeta({
    config: cfg, provider: { name: "x", model: "m" }, task: "fix the parser bug",
    runAgent: fake, workers: false, maxSegments: 3, signal: new AbortController().signal,
  })
  const node = (r.task.dag?.nodes ?? [])[0]
  ok("task is NOT COMPLETED", r.status !== "COMPLETED")
  ok("node is NOT completed", node && node.status !== "completed")
  ok("node is repairing or verifying", ["repairing", "verifying", "execution_succeeded"].includes(node?.status))
  ok("a repair pass was attempted", call > 1)
  console.log(`       (status=${r.status}, node=${node?.status})`)
}

console.log("== end-to-end: repair + successful verification completes the node ==")
{
  let call = 0
  const fake = async (args) => {
    call++
    if (args.planOnly) return { text: "1. fix the parser", toolRecords: [], commandChecks: [], toolLog: [] }
    const first = !/FAILED|repair|diagnose|VERIF|verify/i.test(args.task)
    return {
      text: first ? "changed it" : "fixed the root cause",
      budgetHit: false, steps: 2,
      toolRecords: first ? [{ tool: "edit_file", files_changed: ["src/p.js"] }] : [],
      commandChecks: first
        ? [{ command: "npx vitest run src/p.test.js", exitCode: 1, passed: false, tail: "1 test failed" }]
        : [
          { command: "node --check src/p.js", exitCode: 0, passed: true, tail: "ok" },
          { command: "npx vitest run src/p.test.js", exitCode: 0, passed: true, tail: "4 tests passed" },
        ],
      toolLog: [],
    }
  }
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const r = await meta.runMeta({
    config: cfg, provider: { name: "x", model: "m" }, task: "fix the parser bug",
    runAgent: fake, workers: false, maxSegments: 8, signal: new AbortController().signal,
  })
  eq("COMPLETED", r.status, "COMPLETED")
  const node = (r.task.dag?.nodes ?? [])[0]
  eq("node completed", node?.status, "completed")
  ok("verified, not assumed", dag.verificationSatisfied(node) === true)
}

console.log("== the agent itself cannot complete a node by claiming success ==")
{
  const tools = makeToolContext({ cwd: WORK, readOnly: false, timeoutSec: 5, maxToolOutput: 2000 })
  ok("tool context built for the negative control", typeof tools.exec === "function")
  const provider = { name: "fake", model: "m", call: async () => ({ choices: [{ message: { content: "done" } }] }) }
  const res = await runAgent({
    config: {}, provider, task: "trivial", maxStepsOverride: 0, noTools: true, suppressRunEvents: true,
  })
  ok("agent reports its own COMPLETED (that is execution success, not task completion)", res.status === "COMPLETED")
  ok("…and carries no node identity by itself", res.nodeId === null)
}

console.log(`\n== node-verification-gate suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
