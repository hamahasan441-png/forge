#!/usr/bin/env node
/**
 * v92 "wirewise" — island wiring, part 2: the living loop.
 *
 *  1. runMeta prediction loop (§9): PREDICTION_MADE before the segment,
 *     PREDICTION_SETTLED after reality, persisted to the project ledger,
 *     calibration fed back into the next plan (PLAN_PREDICTION_CALIBRATION).
 *  2. World-model consultation at planning (§5/§10): PLAN_WORLD_CONSULTED with
 *     a real repo, blast radius of an objective-named file inside the plan
 *     prompt.
 *  3. Language-adapter brief (§7/§8): the segment agent receives the honest
 *     per-file adapter status for the DAG node's declared targets.
 *  4. Integrator conflicts (§31): overlapping worker claims on one file are
 *     emitted as INTEGRATION_CONFLICT in the exact claims shape the Core
 *     event tap consumes — and the emitted event really resolves through
 *     reportConflict/resolveConflict (the v91 handler was dead code).
 *  5. The prediction ledger closes the §9 loop across runs: run 1 settles a
 *     drift, run 2 steers its plan prompt from the recorded calibration.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v92c-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v92c-work-"))
process.chdir(WORK)
// a real tiny repo: the world model and adapter brief need real files
fs.mkdirSync(path.join(WORK, "src"), { recursive: true })
fs.writeFileSync(path.join(WORK, "src", "calc.js"), "export function add(a, b) { return a + b }\n")
fs.writeFileSync(path.join(WORK, "src", "app.js"), "import { add } from './calc.js'\nexport function total(xs) { return xs.reduce(add, 0) }\n")
fs.writeFileSync(path.join(WORK, "src", "calc.test.js"), "import { test } from 'node:test'\nimport { add } from './calc.js'\ntest('add', () => {})\n")
fs.writeFileSync(path.join(WORK, "legacy.cob"), "IDENTIFICATION DIVISION.\n")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 260) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const meta = await import("../meta.js")
const pred = await import("../prediction.js")
const { integrateResults, reportsFromGraph } = await import("../integrate.js")
const { reportConflict, resolveConflict, CONFLICT_STATUS } = await import("../crewconflict.js")
const { projectDir } = await import("../memory.js")

const baseConfig = () => ({ providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} })

// ---------------------------------------------------------------------------
console.log("== 1. runMeta: the prediction loop fires inside the living loop (§9) ==")
{
  const events = []
  let planSeen = null
  const PLAN = JSON.stringify([
    { id: "n1", objective: "investigate the app module", read_only: true, role: "researcher", targetFiles: ["src/app.js"] },
    { id: "n2", objective: "implement the change in src/app.js and legacy.cob", role: "coder", targetFiles: ["src/app.js", "legacy.cob"], dependencies: ["n1"] },
  ])
  const runAgent = async (o) => {
    if (o.planOnly) { planSeen = o.task; return { text: PLAN, toolRecords: [], commandChecks: [], toolLog: [] } }
    if (o.readOnly) return { text: "found: total() imports add()", toolRecords: [], commandChecks: [], toolLog: [] }
    return {
      text: "All done, complete and verified.",
      budgetHit: false, steps: 2,
      toolRecords: [{ tool: "edit_file", files_changed: [path.join(WORK, "src", "app.js")] }],
      commandChecks: [
        { command: "node --check src/app.js", exitCode: 0, passed: true, tail: "ok" },
        { command: "npx vitest run src/calc.test.js", exitCode: 0, passed: true, tail: "3 tests passed" },
      ],
      toolLog: [],
    }
  }
  const r = await meta.runMeta({
    config: baseConfig(), provider: { name: "x", model: "m" },
    task: "change src/app.js total() and verify it",
    runAgent, signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
  })

  const made = events.filter((e) => e.type === "PREDICTION_MADE")
  const settled = events.filter((e) => e.type === "PREDICTION_SETTLED")
  ok("run completed", r.status === "COMPLETED", `status=${r.status} err=${r.text?.slice(0, 120)}`)
  ok("PREDICTION_MADE fired for the mutating segment", made.length >= 1, `${made.length} made`)
  ok("PREDICTION_SETTLED fired after reality", settled.length >= 1, `${settled.length} settled`)

  const coderMade = made.find((e) => (e.prediction?.expectedFiles ?? []).length === 2)
  ok("prediction carries the node's declared targets (relative)", coderMade && JSON.stringify(coderMade.prediction.expectedFiles) === JSON.stringify(["src/app.js", "legacy.cob"]), JSON.stringify(made.map((e) => e.prediction?.expectedFiles)))
  ok("prediction carries the planning risk", made.every((e) => e.prediction.expectedRisk != null))

  const st = settled.find((e) => e.prediction?.filesExtra > 0 || e.prediction?.filesMissed > 0)
  ok("reality delta is explicit (legacy.cob was left untouched)", st && st.prediction.filesMissed >= 1 && st.prediction.filesHit >= 1, JSON.stringify(settled.map((e) => e.prediction)))

  ok("prediction persisted to the project ledger", (() => {
    const loaded = pred.loadPredictions(WORK)
    return loaded.length >= 1 && loaded.some((p) => p.settledAt && Array.isArray(p.filesMissed) && p.filesMissed.includes("legacy.cob"))
  })())
  ok("formatPrediction text rides the event", made.every((e) => typeof e.text === "string" && e.text.startsWith("predict")))
  ok("formatSettlement text rides the event", settled.every((e) => typeof e.text === "string" && /file\(s\) actually changed/.test(e.text)))
}

console.log("== 2. runMeta: world-model consultation at planning (§5/§10) ==")
{
  const events = []
  let planTask = null
  const runAgent = async (o) => {
    if (o.planOnly) { planTask = o.task; return { text: "1. inspect src/app.js\n2. edit src/app.js", toolRecords: [], commandChecks: [], toolLog: [] } }
    return {
      text: "All done, complete and verified.", budgetHit: false, steps: 2,
      toolRecords: [{ tool: "edit_file", files_changed: [path.join(WORK, "src", "app.js")] }],
      commandChecks: [{ command: "node --check src/app.js", exitCode: 0, passed: true, tail: "ok" }], toolLog: [],
    }
  }
  const r = await meta.runMeta({
    config: baseConfig(), provider: { name: "x", model: "m" },
    task: "improve src/app.js total()",
    runAgent, signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
  })
  ok("run completed", r.status === "COMPLETED", `status=${r.status}`)
  ok("PLAN_WORLD_CONSULTED fired", events.some((e) => e.type === "PLAN_WORLD_CONSULTED"))
  ok("plan prompt carries the world-model block", /world model \(semantic project state\)/.test(planTask ?? ""))
  ok("world summary counts the real files", /WORLD MODEL: \d+ files/.test(planTask ?? ""))
  ok("blast radius of the named file is in the plan prompt", /Blast radius of src\/app\.js/.test(planTask ?? "") && /calc\.test\.js|importers/.test(planTask ?? ""))
  ok("bounded world block (≤ 900 + slack)", (planTask.match(/--- world model[\s\S]*?---/) ?? [""])[0].length <= 1000)
}

console.log("== 3. runMeta: language-adapter brief reaches the segment (§7/§8) ==")
{
  const PLAN = JSON.stringify([
    { id: "n1", objective: "edit the legacy cobol report and the app", role: "coder", targetFiles: ["legacy.cob", "src/app.js"] },
  ])
  let sawBrief = null
  const runAgent = async (o) => {
    if (o.planOnly) return { text: PLAN, toolRecords: [], commandChecks: [], toolLog: [] }
    if (o.extraContext && /language adapter status/.test(o.extraContext)) sawBrief = o.extraContext
    return {
      text: "All done, complete and verified.", budgetHit: false, steps: 2,
      toolRecords: [{ tool: "edit_file", files_changed: [path.join(WORK, "legacy.cob")] }],
      commandChecks: [{ command: "node --check legacy.cob", exitCode: 0, passed: true, tail: "ok" }], toolLog: [],
    }
  }
  const r = await meta.runMeta({
    config: baseConfig(), provider: { name: "x", model: "m" },
    task: "update the cobol report generator file",
    runAgent, signal: new AbortController().signal,
  })
  ok("run completed", r.status === "COMPLETED", `status=${r.status}`)
  ok("segment extraContext contains the adapter brief", sawBrief != null, "no brief seen")
  ok("brief reports legacy.cob honestly (shallow/conservative)", /legacy\.cob: cobol \[conservative\]/.test(sawBrief ?? ""))
  ok("brief reports src/app.js with its deep adapter", /app\.js: javascript \[deep\]/.test(sawBrief ?? ""))
}

console.log("== 4. integrator conflicts: emitted, shaped, resolvable (§31) ==")
{
  // (a) unit: overlapping claims on one file from different roles → conflict
  const reports = [
    { role: "researcher", text: "Approach A: keep the module, add a wrapper in src/app.js around total().", files: ["src/app.js"], ok: true },
    { role: "reviewer", text: "Approach B: rewrite src/app.js total() from scratch.", files: ["src/app.js"], ok: true },
  ]
  const merged = integrateResults({ objective: "pick an approach", reports })
  eq("integrateResults reports the overlap", merged.conflicts.length, 1)
  eq("conflict names the file", merged.conflicts[0].file, "src/app.js")
  ok("conflict carries both claimants", merged.conflicts[0].a.from === "researcher" && merged.conflicts[0].b.from === "reviewer")

  // (b) integration: runMeta (workers on) emits INTEGRATION_CONFLICT with the
  // exact claims shape core.js consumes
  const events = []
  const PLAN = JSON.stringify([
    { id: "n1", objective: "investigate src/app.js and recommend an approach", read_only: true, role: "researcher", targetFiles: ["src/app.js"] },
    { id: "n2", objective: "review src/app.js and recommend an approach", read_only: true, role: "reviewer", targetFiles: ["src/app.js"] },
    { id: "n3", objective: "integrate the worker findings", read_only: true, role: "integrator", dependencies: ["n1", "n2"] },
    { id: "n4", objective: "implement the chosen approach in src/app.js", role: "coder", targetFiles: ["src/app.js"], dependencies: ["n3"] },
  ])
  const runAgent = async (o) => {
    if (o.planOnly) return { text: PLAN, toolRecords: [], commandChecks: [], toolLog: [] }
    if (o.role === "researcher") return { text: "Approach A: keep the module, add a wrapper in src/app.js around total().", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] }
    if (o.role === "reviewer") return { text: "Approach B: rewrite src/app.js total() from scratch.", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] }
    return {
      text: "All done, complete and verified.", budgetHit: false, steps: 2,
      toolRecords: [{ tool: "edit_file", files_changed: [path.join(WORK, "src", "app.js")] }],
      commandChecks: [{ command: "node --check src/app.js", exitCode: 0, passed: true, tail: "ok" }], toolLog: [],
    }
  }
  const r = await meta.runMeta({
    config: baseConfig(), provider: { name: "x", model: "m" },
    task: "investigate, review and improve src/app.js",
    runAgent, workers: true, signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
  })
  const conflicts = events.filter((e) => e.type === "INTEGRATION_CONFLICT")
  ok("run completed", r.status === "COMPLETED", `status=${r.status}`)
  ok("INTEGRATION_CONFLICT emitted (the v91 dead handler now has a producer)", conflicts.length >= 1, `${conflicts.length} conflicts`)
  const c = conflicts[0]
  ok("event shape matches the core consumer contract", Boolean(c && c.claims && c.claims.a?.worker && c.claims.b?.worker && c.claims.topic && c.taskId && c.nodeId && c.file), JSON.stringify(c ?? {}).slice(0, 200))

  // (c) the emitted event resolves through the same code core runs
  if (c) {
    const rec = reportConflict(
      { claimant: c.claims.a.worker, claim: c.claims.a.text, evidence: c.claims.a.evidence },
      { claimant: c.claims.b.worker, claim: c.claims.b.text, evidence: c.claims.b.evidence },
      { topic: c.claims.topic, taskId: c.taskId, nodeId: c.nodeId },
    )
    resolveConflict(rec, { world: () => null })
    ok("emitted conflict resolves through crewconflict (evidence ladder)", rec.status === CONFLICT_STATUS.ESCALATED || rec.status === CONFLICT_STATUS.RESOLVED, String(rec.status))
    ok("both sides preserved in the record", rec.positions?.length === 2 || rec.sides?.length === 2 || Boolean(rec.claims) || Boolean(rec.a && rec.b))
  }
}

console.log("== 5. the §9 loop closes across runs: calibration steers the next plan ==")
{
  // run A already settled predictions in WORK (section 1). Push two more
  // targeted settlements so calibration has enough signal, then run again
  // and watch the plan prompt receive the calibration feedback.
  const mk = (i, exp, act) => pred.settlePrediction(
    pred.predictForNode({ node: { id: `cal${i}`, targetFiles: exp.map((f) => path.join(WORK, f)) }, riskLevel: "low", segment: i }),
    { actualFiles: act.map((f) => path.join(WORK, f)), finalRisk: "medium", status: "ok" },
  )
  pred.recordPrediction(mk(1, ["src/app.js"], ["src/app.js", "unplanned.js"]), WORK)
  pred.recordPrediction(mk(2, ["src/app.js"], ["src/app.js", "other.js"]), WORK)

  const events = []
  let planTask = null
  const runAgent = async (o) => {
    if (o.planOnly) { planTask = o.task; return { text: "1. edit src/app.js\n2. verify", toolRecords: [], commandChecks: [], toolLog: [] } }
    return {
      text: "All done, complete and verified.", budgetHit: false, steps: 2,
      toolRecords: [{ tool: "edit_file", files_changed: [path.join(WORK, "src", "app.js")] }],
      commandChecks: [
        { command: "node --check src/app.js", exitCode: 0, passed: true, tail: "ok" },
        { command: "npx vitest run src/calc.test.js", exitCode: 0, passed: true, tail: "1 test passed" },
      ], toolLog: [],
    }
  }
  const r = await meta.runMeta({
    config: baseConfig(), provider: { name: "x", model: "m" },
    task: "adjust src/app.js total()",
    runAgent, signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
  })
  ok("run completed", r.status === "COMPLETED", `status=${r.status}`)
  ok("PLAN_PREDICTION_CALIBRATION fired from real history", events.some((e) => e.type === "PLAN_PREDICTION_CALIBRATION"))
  ok("plan prompt carries the calibration block", /prediction calibration/.test(planTask ?? ""))
  ok("calibration names the recorded drift (unplanned changes)", /unplanned\.js|scope drift|UNDER-predicted/.test(planTask ?? ""))
  const cal = pred.predictionCalibration(WORK)
  ok("ledger grew across runs", cal.samples >= 5 && cal.sufficient === true, `samples=${cal.samples}`)
}

console.log(`\n== v92 part 2: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
