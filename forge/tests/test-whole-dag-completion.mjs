#!/usr/bin/env node
/**
 * forge — P0 whole-DAG completion gate.
 *
 * The bug: a task reported COMPLETED while required DAG nodes were still
 * pending. Every completion path in meta.js asked a LOCAL question ("did this
 * segment error?", "do I have evidence?") and never the GLOBAL one ("is the
 * graph finished?"). There is now exactly one gate — completion.js
 * canCompleteTask() — and this suite proves it blocks every shortcut.
 *
 * Cases required by the directive:
 *   - one node complete, another pending  → blocked
 *   - one node running                    → blocked
 *   - all nodes complete                  → allowed
 *   - optional node pending               → policy-dependent
 *   - required node failed                → blocked
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-dagdone-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-dagdone-work-"))
process.chdir(WORK)

const dag = await import("../dag.js")
const { canCompleteTask, canCompleteDAG, CHECK, GATE_STATUS } = await import("../completion.js")
const meta = await import("../meta.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const nd = (id, status, extra = {}) => ({ id, objective: `objective ${id}`, dependencies: [], status, ...extra })

// ---------------------------------------------------------------------------
console.log("== gate: one node complete, another pending → blocked ==")
{
  const g = dag.buildDAG([nd("a", dag.NODE_STATUS.COMPLETED), nd("b", dag.NODE_STATUS.PENDING)])
  const r = canCompleteDAG(g)
  ok("blocked", r.ok === false)
  ok("blocker names the incomplete node", r.reasons.join(" ").includes("b"))
  ok("blocker is the whole-DAG check", r.checks[CHECK.ALL_REQUIRED_NODES_COMPLETE] === false)
  eq("recommends WAITING", r.status, GATE_STATUS.WAITING)
  ok("canonical allComplete agrees", dag.allComplete(g) === false)
}

console.log("== gate: one node running → blocked ==")
{
  const g = dag.buildDAG([nd("a", dag.NODE_STATUS.COMPLETED), nd("b", dag.NODE_STATUS.RUNNING)])
  const r = canCompleteDAG(g)
  ok("running node blocks completion", r.ok === false)
  ok("reason mentions running", /running/.test(r.reasons.join(" ")))
}

console.log("== gate: execution succeeded but unverified → blocked ==")
{
  const g = dag.buildDAG([nd("a", dag.NODE_STATUS.COMPLETED), nd("b", dag.NODE_STATUS.EXECUTION_SUCCEEDED)])
  const r = canCompleteDAG(g)
  ok("execution_succeeded is NOT complete", r.ok === false)
  const g2 = dag.buildDAG([nd("a", dag.NODE_STATUS.COMPLETED), nd("b", dag.NODE_STATUS.VERIFYING)])
  ok("verifying is NOT complete", canCompleteDAG(g2).ok === false)
  const g3 = dag.buildDAG([nd("a", dag.NODE_STATUS.COMPLETED), nd("b", dag.NODE_STATUS.REPAIRING)])
  ok("repairing is NOT complete", canCompleteDAG(g3).ok === false)
}

console.log("== gate: all nodes complete → allowed ==")
{
  const g = dag.buildDAG([nd("a", dag.NODE_STATUS.COMPLETED), nd("b", dag.NODE_STATUS.COMPLETED)])
  ok("allowed", canCompleteDAG(g).ok === true)
  const full = canCompleteTask({ dag: g, dagValid: true, verification: null, verificationRequired: false })
  eq("full gate COMPLETED", full.status, "COMPLETED")
}

console.log("== gate: cancelled nodes do not block ==")
{
  const g = dag.buildDAG([nd("a", dag.NODE_STATUS.COMPLETED), nd("b", dag.NODE_STATUS.CANCELLED)])
  ok("cancelled is skipped", canCompleteDAG(g).ok === true)
}

console.log("== gate: optional node pending is policy-dependent ==")
{
  const g = dag.buildDAG([nd("a", dag.NODE_STATUS.COMPLETED), nd("b", dag.NODE_STATUS.PENDING, { optional: true })])
  ok("optional ignored by default", canCompleteDAG(g, { optionalPolicy: "ignore" }).ok === true)
  ok("optional allowed", canCompleteDAG(g, { optionalPolicy: "allow" }).ok === true)
  ok("optional blocked when policy says so", canCompleteDAG(g, { optionalPolicy: "block" }).ok === false)
}

console.log("== gate: required node failed → blocked ==")
{
  const g = dag.buildDAG([nd("a", dag.NODE_STATUS.COMPLETED), nd("b", dag.NODE_STATUS.FAILED)])
  const r = canCompleteDAG(g)
  ok("failed node blocks", r.ok === false)
  ok("recommends REPAIR while repair budget remains", r.status === GATE_STATUS.REPAIRING)
  const noBudget = canCompleteTask({ dag: g, repairBudgetRemaining: false })
  eq("recommends FAILED with no repair budget", noBudget.status, GATE_STATUS.FAILED)
  // a failed node that is optional does not block
  const g2 = dag.buildDAG([nd("a", dag.NODE_STATUS.COMPLETED), nd("b", dag.NODE_STATUS.FAILED, { optional: true })])
  ok("optional failed node does not block", canCompleteDAG(g2).ok === true)
}

console.log("== gate: every other check is enforced ==")
{
  const g = dag.buildDAG([nd("a", dag.NODE_STATUS.COMPLETED)])
  const base = { dag: g, verification: null, verificationRequired: false }
  ok("invalid plan blocks", canCompleteTask({ ...base, planValid: false, planErrors: ["node 1 has no id"] }).ok === false)
  ok("missing DAG blocks", canCompleteTask({ ...base, dag: null }).ok === false)
  ok("malformed DAG blocks", canCompleteTask({ ...base, dag: { nodes: [{ id: "a", dependencies: ["ghost"] }] } }).ok === false)
  ok("live worker blocks", canCompleteTask({ ...base, workersSettled: false, activeWorkers: 1 }).ok === false)
  ok("missing verification blocks", canCompleteTask({ dag: g, verification: null, verificationRequired: true }).ok === false)
  ok("failed verification blocks", canCompleteTask({ dag: g, verification: { ok: false, anyFailure: true, missing: [] }, verificationRequired: true }).ok === false)
  ok("pending required action blocks", canCompleteTask({ ...base, pendingRequiredActions: ["wait: human approval"] }).ok === false)
  ok("unreconciled state blocks", canCompleteTask({ ...base, finalStateReconciled: false }).ok === false)
  ok("failed critical persistence blocks", canCompleteTask({ ...base, criticalPersistenceSucceeded: false }).ok === false)
  ok("cancel is CANCELLED", canCompleteTask({ ...base, cancelled: true, pendingRequiredActions: ["x"] }).status === GATE_STATUS.CANCELLED)
  ok("all nine checks are reported", Object.keys(canCompleteTask({ ...base }).checks).length === 9)
}

// ---------------------------------------------------------------------------
console.log("== end-to-end: meta must not report COMPLETED with nodes pending ==")
{
  const planText = "1. investigate the parser\n2. rewrite the parser\n3. test the parser"
  let planCalls = 0
  const runAgent = async (args) => {
    if (args.planOnly) { planCalls++; return { text: planText, toolRecords: [], commandChecks: [], toolLog: [] } }
    // the model claims completion after ONE unit of work, every time
    return { text: "All done.", budgetHit: false, steps: 2, toolRecords: [], commandChecks: [], toolLog: [] }
  }
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const r = await meta.runMeta({
    config: cfg, provider: { name: "x", model: "m" }, task: "rewrite the parser",
    runAgent, workers: false, maxSegments: 2, signal: new AbortController().signal,
  })
  ok("plan was produced", planCalls === 1)
  ok("NOT COMPLETED while nodes remain", r.status !== "COMPLETED")
  const statuses = (r.task.dag?.nodes ?? []).map((n) => n.status)
  ok("some node is unfinished", statuses.some((s) => s !== "completed"))
  ok("completion gate recorded the block", r.completionGate && r.completionGate.ok === false)
  ok("gate names allRequiredNodesComplete", (r.completionGate?.blockers ?? []).some((b) => b.check === CHECK.ALL_REQUIRED_NODES_COMPLETE))
  console.log(`       (status=${r.status}, nodes=${JSON.stringify(statuses)})`)
}

console.log("== end-to-end: the same task COMPLETES when every node finishes ==")
{
  const planText = "1. investigate the parser\n2. rewrite the parser\n3. test the parser"
  const runAgent = async (args) => {
    if (args.planOnly) return { text: planText, toolRecords: [], commandChecks: [], toolLog: [] }
    return { text: "step done", budgetHit: false, steps: 2, toolRecords: [], commandChecks: [], toolLog: [] }
  }
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const r = await meta.runMeta({
    config: cfg, provider: { name: "x", model: "m" }, task: "rewrite the parser",
    runAgent, workers: false, maxSegments: 12, signal: new AbortController().signal,
  })
  eq("COMPLETED once every node is done", r.status, "COMPLETED")
  ok("gate passed", r.completionGate?.ok === true)
  ok("every node completed", (r.task.dag?.nodes ?? []).every((n) => n.status === "completed"))
}

console.log(`\n== whole-dag-completion suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
