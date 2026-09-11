#!/usr/bin/env node
/**
 * forge — P0 explicit node identity, end to end.
 *
 * No component may infer which DAG node a segment belongs to from filenames,
 * keywords or tool names. taskId / runId / segmentId / nodeId are passed
 * explicitly through Meta → Agent → AgentManager → Tools → Events →
 * Verification → TaskState → DAG. `attributeSegment()` survives only as a
 * DIAGNOSTIC and must never determine authoritative state.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-identity-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-identity-work-"))
process.chdir(WORK)

const dag = await import("../dag.js")
const meta = await import("../meta.js")
const { runAgent } = await import("../agent.js")
const { createAgentManager } = await import("../agentmanager.js")
const { createLedger } = await import("../verifyledger.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

console.log("== DAG: node identity is exact, never inferred ==")
{
  const g = dag.buildDAG([
    { id: "research", objective: "investigate the parser", read_only: true, role: "researcher" },
    { id: "implement", objective: "rewrite the parser", dependencies: ["research"], role: "coder" },
  ])
  ok("executeNode() by id", !!dag.executeNode(g, "implement", { taskId: "T", runId: "R", segmentId: "S" }) === false) // dependency not satisfied
  const taken = dag.executeNode(g, "research", { taskId: "T", runId: "R", segmentId: "S" })
  ok("ready node executes", !!taken)
  eq("taskId stamped on the node", taken.taskId, "T")
  eq("runId stamped on the node", taken.runId, "R")
  eq("segmentId stamped on the node", taken.segmentId, "S")
  ok("executeNode is deterministic (same id, same node)", dag.executeNode(g, "research", {}) === null)
  ok("unknown node id returns null", dag.executeNode(g, "does-not-exist", {}) === null)
  ok("markCompleted takes an explicit id", dag.markCompleted(g, "research", null, { verification: dag.VERIFICATION_NOT_REQUIRED }) === true)
  eq("unknown id is rejected", dag.markCompleted(g, "ghost", null, { verification: { verification_id: "x" } }), false)
}

console.log("== agent: identity in, identity out ==")
{
  const provider = { name: "fake", model: "m", call: async () => ({ choices: [{ message: { content: "ok" } }] }) }
  const res = await runAgent({
    config: {}, provider, task: "do the thing",
    taskId: "task-42", runId: "run-42", segmentId: "seg-7", nodeId: "node-9",
    maxStepsOverride: 0, noTools: true, suppressRunEvents: true,
  })
  eq("taskId returned", res.taskId, "task-42")
  eq("segmentId returned", res.segmentId, "seg-7")
  eq("nodeId returned", res.nodeId, "node-9")
}

console.log("== worker: identity reaches the runner ==")
{
  let got = null
  const m = createAgentManager({
    maxWorkers: 1, defaultTimeoutMs: 1000,
    runner: async (args) => { got = args; return "ok" },
  })
  const rec = m.spawn({ role: "researcher", task: "look", dagNode: "n3", nodeId: "n3", taskId: "t", runId: "r", segmentId: "s" })
  await rec.promise
  eq("runner got nodeId", got.nodeId, "n3")
  eq("runner got taskId", got.taskId, "t")
  eq("runner got segmentId", got.segmentId, "s")
  eq("runner got workerId", got.workerId, rec.id)
  ok("runner got its own cancellation signal", !!got.signal)
}

console.log("== verification records carry the identity ==")
{
  const ledger = createLedger()
  const rec = ledger.recordCommand("npm test", "ok\n[exit code: 0]", {
    exitCode: 0, affectedFiles: ["a.js"], taskId: "t1", nodeId: "n1", segmentId: "seg-1", verificationEpoch: 7,
  })
  eq("record.taskId", rec.taskId, "t1")
  eq("record.nodeId", rec.nodeId, "n1")
  eq("record.segmentId", rec.segmentId, "seg-1")
  ok("record.verificationEpoch", rec.verificationEpoch === 7)
  ok("record.affectedFiles", Array.isArray(rec.affectedFiles) && rec.affectedFiles[0] === "a.js")
  ok("record.scope present", typeof rec.scope === "string")
  ok("record.type present", typeof rec.type === "string")
  ok("record.evidence present", typeof rec.evidence === "string")
  ok("record.timestamp present", typeof rec.timestamp === "number")
}

console.log("== meta: every event carries taskId/runId/segmentId/nodeId ==")
{
  const events = []
  const fake = async (args) => {
    if (args.planOnly) return { text: "1. investigate the parser\n2. rewrite the parser", toolRecords: [], commandChecks: [], toolLog: [] }
    return {
      text: "done", budgetHit: false, steps: 2,
      toolRecords: [{ tool: "edit_file", files_changed: ["src/p.js"] }],
      commandChecks: [
        { command: "node --check src/p.js", exitCode: 0, passed: true, tail: "ok" },
        { command: "npx vitest run src/p.test.js", exitCode: 0, passed: true, tail: "1 passed" },
      ],
      toolLog: [{ name: "edit_file" }],
    }
  }
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const r = await meta.runMeta({
    config: cfg, provider: { name: "x", model: "m" }, task: "rewrite the parser",
    runAgent: fake, workers: false, maxSegments: 6,
    signal: new AbortController().signal, onEvent: (e) => events.push(e),
  })
  ok("taskId is known", typeof r.taskId === "string" && r.taskId.length > 0)
  ok("runId is known", typeof r.runId === "string" && r.runId.length > 0)
  const nodeEvents = events.filter((e) => e && e.nodeId)
  ok("events carry nodeId", nodeEvents.length > 0)
  ok("DAG_NODE_STARTED carries nodeId", events.some((e) => e.type === "DAG_NODE_STARTED" && e.nodeId))
  ok("DAG_NODE_STARTED carries segmentId", events.some((e) => e.type === "DAG_NODE_STARTED" && e.segmentId))
  ok("verification events carry nodeId", events.filter((e) => /^VERIFICATION_(PASSED|FAILED)$/.test(e.type)).every((e) => e.nodeId))
  ok("every event carries taskId", events.every((e) => e && e.taskId === r.taskId))
  ok("segment events carry segmentId", events.filter((e) => /^SEGMENT_/.test(e.type)).every((e) => e.segmentId))
  // taskstate persisted the identity
  ok("task record has a node_id", typeof r.task.node_id === "string" && r.task.node_id.length > 0)
  ok("task record has a segment_id", typeof r.task.segment_id === "string")
  ok("segments record their node", (r.task.segments ?? []).every((s) => s.node_id))
  // DAG nodes know who owns them
  const nodes = r.task.dag?.nodes ?? []
  ok("every executed node has taskId/runId/segmentId", nodes.every((n) => n.taskId && n.runId && n.segmentId))
  eq("task completed", r.status, "COMPLETED")
}

console.log("== heuristic attribution is DIAGNOSTIC ONLY ==")
{
  const src = fs.readFileSync(new URL("../meta.js", import.meta.url), "utf8")
  const fn = src.slice(src.indexOf("function attributeSegment"))
  const body = fn.slice(0, fn.indexOf("\nfunction ") === -1 ? fn.length : fn.indexOf("\nfunction "))
  ok("attributeSegment exists", src.includes("function attributeSegment"))
  ok("it never calls markCompleted", !/markCompleted|markExecutionSucceeded|markFailed|markVerifying|markRepairing/.test(body))
  ok("it only reads the graph", /filter\(|for \(const n of/.test(body))
  // and the controller only emits a diagnostic with it
  const usage = src.slice(src.indexOf("DIAGNOSTIC ONLY"))
  ok("its result is only emitted, never applied", usage.includes('applied: false') || usage.includes("applied:false") || usage.includes("diagnostic only"))
}

console.log(`\n== exact-node-attribution suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
