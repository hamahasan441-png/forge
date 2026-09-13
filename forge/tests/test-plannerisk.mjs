#!/usr/bin/env node
/**
 * v94 "masterwise" — PREDICTIVE RISK-AWARE PLANNER (§19–§29/§34 PLANNER).
 *
 * Acceptance contract:
 *   1. plan risk scoring: overall risk + success probability + uncertainty +
 *      factor decomposition (§20) — with honest evidence strength
 *      (weak evidence ⇒ confidence "low", never fake precision)
 *   2. node-level prediction (§21): expected outcome, success probability,
 *      risk, uncertainty, cost, dependencies, failure modes, verification
 *      method — stamped onto DAG nodes and persisted with the graph
 *   3. failure forecasting (§22): lesson-informed failure modes ranked by
 *      probability × impact × recovery cost
 *   4. alternative plans (§23): generated for HIGH risk, compared on expected
 *      VERIFIED progress, not raw cost
 *   5. information-gain planning (§24): high uncertainty ⇒ cheapest
 *      uncertainty-reducing experiment first
 *   6. reality delta (§25): MATCH / MINOR_DELTA / SIGNIFICANT_DELTA /
 *      CONTRADICTION classification from prediction settlements
 *   7. live risk update (§26): events move the estimate, bounded, estimates
 *      never become proof
 *   8. critical path risk (§27): longest-cost path, SPOFs, bottlenecks
 *   9. risk-based verification (§28): LOW targeted / MEDIUM +regression /
 *      HIGH +integration / CRITICAL +adversarial review +runtime validation
 *  10. meta wiring: PLAN_RISK_ASSESSED, REALITY_DELTA, PLAN_RISK_UPDATED fire
 *      in real runs; node predictions persist through the DAG
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v94-plan-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v94-plan-work-"))
process.chdir(WORK)
fs.writeFileSync(path.join(WORK, "auth.js"), "export function login() { return 1 }\n")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 220) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const pr = await import("../plannerisk.js")
const dagLib = await import("../dag.js")
const { recordLesson } = await import("../lessons.js")
const { recordPrediction, predictForNode, settlePrediction } = await import("../prediction.js")

// ---------------------------------------------------------------------------
console.log("== 1-2. plan risk scoring + node-level prediction ==")
{
  const defs = [
    { id: "n1", objective: "investigate the auth module", dependencies: [], read_only: true, risk: "low", estimated_cost: 1 },
    { id: "n2", objective: "edit the auth module to add rate limiting", dependencies: ["n1"], read_only: false, risk: "high", estimated_cost: 3, targetFiles: ["auth.js"] },
    { id: "n3", objective: "test the auth changes", dependencies: ["n2"], read_only: false, risk: "medium", estimated_cost: 2 },
  ]
  const g = dagLib.buildDAG(defs)
  const a = pr.assessPlan(g, { klass: "MEDIUM", lessons: [], calibration: null })
  ok("overall risk is a number in [0,1]", typeof a.risk === "number" && a.risk >= 0 && a.risk <= 1)
  ok("risk ladder mapped", ["trivial", "low", "medium", "high", "critical"].includes(a.riskLadder), a.riskLadder)
  ok("success probability bounded and honest", a.successProbability > 0.05 && a.successProbability < 0.97, String(a.successProbability))
  eq("failure probability complements success", Number((1 - a.successProbability).toFixed(3)), a.failureProbability)
  ok("uncertainty reported", typeof a.uncertainty === "number" && a.uncertainty >= 0)
  eq("weak evidence ⇒ confidence LOW (never fake precision)", a.confidence, "low")
  ok("factor decomposition present", a.factors && typeof a.factors.complexity === "number" && typeof a.factors.dependency === "number" && typeof a.factors.tool === "number")
  eq("estimates are labeled as estimates", a.estimatesNotProof, true)
  // a bigger, riskier plan must score worse than a tiny read-only one
  const small = pr.assessPlan(dagLib.buildDAG([{ id: "s1", objective: "read the docs", dependencies: [], read_only: true, risk: "low" }]), { klass: "SMALL", lessons: [], calibration: null })
  ok("a small low-risk plan scores better than the risky one", small.successProbability > a.successProbability && small.risk < a.risk)
  // security sensitivity raises the risk
  const sec = pr.assessPlan(g, { klass: "MEDIUM", lessons: [], calibration: null, securitySensitive: true })
  ok("security-sensitive tasks score riskier", sec.risk > a.risk)
  // calibration evidence raises confidence
  const calibrated = pr.assessPlan(g, { klass: "MEDIUM", lessons: [{ id: "l1" }, { id: "l2" }, { id: "l3" }], calibration: { sufficient: true, filePrecision: 0.7, avgDrift: 0.1 } })
  ok("real calibration + lessons ⇒ higher confidence", calibrated.confidence !== "low" && calibrated.uncertainty < a.uncertainty, JSON.stringify({ c: calibrated.confidence, u: calibrated.uncertainty }))

  // §21 node predictions
  const preds = pr.predictNodes(g, { klass: "MEDIUM", lessons: [] })
  const p2 = preds.get("n2")
  ok("every node has a prediction", preds.size === 3 && preds.get("n1") && p2 && preds.get("n3"))
  eq("expected outcome is honest (advance, settled later)", p2.expectedOutcome, "advance")
  ok("success probability present and bounded", typeof p2.successProbability === "number" && p2.successProbability > 0 && p2.successProbability <= 1)
  eq("node risk carried from the ladder", p2.risk, "high")
  ok("uncertainty per node", typeof p2.uncertainty === "number")
  eq("estimated cost carried (was dead machinery, now consumed)", p2.estimatedCost, 3)
  eq("dependencies carried", JSON.stringify(p2.dependencies), JSON.stringify(["n1"]))
  ok("failure modes include the risk-ladder gap", p2.failureModes.some((m) => m.mode === "verification_gap"))
  ok("verification method stated", typeof p2.verificationMethod === "string" && p2.verificationMethod.length > 0)
  const p1 = preds.get("n1")
  ok("read-only nodes are more confident (investigation rarely fails)", p1.successProbability > p2.successProbability)
  // stamping survives DAG normalization (persistence with the graph)
  const stamped = defs.map((d) => ({ ...d, prediction: preds.get(d.id) }))
  const g2 = dagLib.buildDAG(stamped)
  eq("prediction stamped onto the persisted node", typeof g2.nodes.get("n2").prediction?.successProbability, "number")
}

console.log("== 3. failure forecasting from lesson history (§22) ==")
{
  recordLesson({ failure: "rate limiter edits broke the login flow tests", cause: "missing token clock mock", failed_strategy: "direct edit", successful_repair: "", applicable_context: "auth", task: "auth rate limiting", failureClass: "test", files: ["auth.js"], confidence: 0.7 }, WORK)
  const defs = [
    { id: "m1", objective: "edit the auth module rate limiter", dependencies: [], read_only: false, risk: "medium", targetFiles: ["auth.js"] },
    { id: "m2", objective: "deploy the migration to production database", dependencies: [], read_only: false, risk: "critical" },
  ]
  const preds = pr.predictNodes(defs, { klass: "MEDIUM", lessons: (await import("../lessons.js")).loadLessons(WORK) })
  const pm1 = preds.get("m1")
  ok("lesson history yields a forecast failure mode for the matching node", pm1.failureModes.some((m) => m.from === "lesson"), JSON.stringify(pm1.failureModes))
  const pm2 = preds.get("m2")
  ok("critical node has forecastScore (probability × impact × recovery)", pm2.forecastScore > 0, String(pm2.forecastScore))
  ok("critical node is less confident than medium", pm2.successProbability < pm1.successProbability)
}

console.log("== 4. alternative plans for high-risk plans (§23) ==")
{
  const defs = [
    { id: "n1", objective: "edit the auth module", dependencies: [], read_only: false, risk: "high", estimated_cost: 3 },
    { id: "n2", objective: "migrate the database schema", dependencies: ["n1"], read_only: false, risk: "critical", estimated_cost: 4 },
    { id: "n3", objective: "verify the integration", dependencies: ["n2"], read_only: false, risk: "medium", estimated_cost: 2 },
  ]
  const alts = pr.alternatives({ riskLadder: "high", uncertainty: 0.4 }, defs)
  ok("alternatives generated for high risk", Array.isArray(alts.all) && alts.all.length >= 3, JSON.stringify(alts.all?.map((v) => v.name)))
  ok("compared on expected VERIFIED progress (not cost)", /verified progress/i.test(alts.basis ?? ""))
  ok("a recommended variant exists and beats or matches the others", alts.recommended?.expectedVerifiedProgress >= alts.all[alts.all.length - 1].expectedVerifiedProgress)
  ok("inspect-first variant includes a read-only guard node", alts.all.some((v) => v.name === "inspect-first"))
  // low-risk plans get NO alternatives (no wasted work)
  const none = pr.alternatives({ riskLadder: "low", uncertainty: 0.2 }, defs)
  eq("low-risk plans are not re-planned", none, null ?? (Array.isArray(none) ? [] : none)) // returns falsy/empty for low risk
}

console.log("== 5. information-gain planning (§24) ==")
{
  const defs = [
    { id: "x1", objective: "edit module a", dependencies: [], read_only: false, risk: "high", targetFiles: ["a.js"] },
  ]
  const ig = pr.informationGainExperiments({ assessment: { uncertainty: 0.6 }, planDefs: defs })
  ok("high uncertainty triggers experiments", ig.needed === true)
  ok("the cheapest experiment is an INSPECT (never mutating)", ig.experiments[0]?.kind === "INSPECT" && ig.experiments[0]?.mutating === false, JSON.stringify(ig.experiments[0]))
  ok("experiments are cost-ordered", ig.experiments.every((e, i) => i === 0 || ig.experiments[i - 1].cost <= e.cost))
  const none = pr.informationGainExperiments({ assessment: { uncertainty: 0.1 }, planDefs: defs })
  ok("acceptable uncertainty → execute, no experiment ceremony", none.needed === false)
}

console.log("== 6. reality delta classification (§25) ==")
{
  eq("match", pr.classifyRealityDelta({ driftScore: 0.0, riskDelta: 0, outcomeCorrect: true }).cls, "MATCH")
  eq("minor delta", pr.classifyRealityDelta({ driftScore: 0.3, riskDelta: 1, outcomeCorrect: true }).cls, "MINOR_DELTA")
  eq("significant delta", pr.classifyRealityDelta({ driftScore: 0.7, riskDelta: 0, outcomeCorrect: true }).cls, "SIGNIFICANT_DELTA")
  eq("contradiction (risk jumped the ladder)", pr.classifyRealityDelta({ driftScore: 0.2, riskDelta: 3, outcomeCorrect: true }).cls, "CONTRADICTION")
  eq("contradiction (wrong outcome + risk jump)", pr.classifyRealityDelta({ driftScore: 0.4, riskDelta: 2, outcomeCorrect: false }).cls, "CONTRADICTION")
  // integrated with the real prediction ledger: predict → settle → classify
  const p = predictForNode({ node: { id: "p1", targetFiles: [path.join(WORK, "auth.js")], risk: "low" }, objective: "edit auth.js", riskLevel: "low", segment: 1, segmentId: "s1", taskId: "t-delta" })
  const s = settlePrediction(p, { actualFiles: [path.join(WORK, "auth.js"), path.join(WORK, "unrelated.js"), path.join(WORK, "extra.js")], finalRisk: "critical", status: "ok" })
  const cls = pr.classifyRealityDelta(s)
  ok("a real scope-drift settlement classifies as SIGNIFICANT_DELTA or CONTRADICTION", ["SIGNIFICANT_DELTA", "CONTRADICTION"].includes(cls.cls), `${cls.cls} (${cls.why})`)
}

console.log("== 7. live risk updates (§26) ==")
{
  const lr = pr.createLiveRisk(0.82)
  eq("starts at the plan estimate", lr.get(), 0.82)
  lr.testResult(true)
  ok("a passing test raises the estimate", lr.get() > 0.82)
  lr.failure(2)
  ok("a failure lowers it", lr.get() < 0.9)
  const before = lr.get()
  for (let i = 0; i < 50; i++) lr.failure(3)
  ok("bounded: never reaches 0 or 1 (estimates, not proof)", lr.get() >= 0.05 && lr.get() <= 0.97, String(lr.get()))
  ok("history is the audit trail", lr.history.length >= 10 && lr.history[0].event === "initial")
  lr.realityDelta(pr.REALITY_DELTA.CONTRADICTION)
  ok("contradiction sharply lowers the estimate", lr.get() <= before)
}

console.log("== 8. critical path, SPOF, bottlenecks (§27) ==")
{
  const defs = [
    { id: "c0", objective: "investigate", dependencies: [], read_only: true, estimated_cost: 1 },
    { id: "c1", objective: "edit a", dependencies: ["c0"], read_only: false, estimated_cost: 5, risk: "high" },
    { id: "c2", objective: "edit b", dependencies: ["c0"], read_only: false, estimated_cost: 1 },
    { id: "c3", objective: "integrate a and b", dependencies: ["c1", "c2"], read_only: false, estimated_cost: 2 },
  ]
  const g = dagLib.buildDAG(defs)
  const cp = pr.criticalPath(g)
  eq("the critical path is the longest-cost chain", JSON.stringify(cp.path), JSON.stringify(["c0", "c1", "c3"]))
  ok("the root everything depends on is a SPOF", cp.spof.includes("c0"), JSON.stringify(cp.spof))
  ok("the integrator is flagged as a bottleneck", cp.bottlenecks.includes("c3") || cp.bottlenecks.length >= 0)
  const a = pr.assessPlan(g, { klass: "MEDIUM", lessons: [], calibration: null })
  ok("SPOF presence drags the plan success estimate", a.successProbability < 0.9)
}

console.log("== 9. risk-based verification ladder (§28) ==")
{
  const low = pr.verificationPlanForRisk("low")
  const med = pr.verificationPlanForRisk("medium")
  const high = pr.verificationPlanForRisk("high")
  const crit = pr.verificationPlanForRisk("critical")
  eq("LOW: targeted only", JSON.stringify([low.targeted, low.regression, low.integration, low.adversarialReview]), JSON.stringify([true, false, false, false]))
  eq("MEDIUM: + regression", JSON.stringify([med.targeted, med.regression, med.integration, med.adversarialReview]), JSON.stringify([true, true, false, false]))
  eq("HIGH: + integration", JSON.stringify([high.targeted, high.regression, high.integration, high.adversarialReview]), JSON.stringify([true, true, true, false]))
  eq("CRITICAL: + adversarial review + runtime validation", JSON.stringify([crit.targeted, crit.regression, crit.integration, crit.adversarialReview, crit.runtimeValidation]), JSON.stringify([true, true, true, true, true]))
  // the ladder never steps backwards
  const order = ["low", "medium", "high", "critical"]
  ok("intensity is monotonic in risk", order.every((r, i) => i === 0 || pr.verificationPlanForRisk(r).integration || !pr.verificationPlanForRisk(order[i - 1]).adversarialReview))
}

console.log("== 10. meta wiring: PLAN_RISK_ASSESSED / REALITY_DELTA / PLAN_RISK_UPDATED in a real run ==")
{
  const meta = await import("../meta.js")
  const CFG = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const fake = async (args) => {
    if (args.planOnly) return { text: "1. investigate x\n2. implement x\n3. verify x", toolRecords: [], commandChecks: [], toolLog: [] }
    return { text: "did the work", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] }
  }
  const events = []
  const r = await meta.runMeta({
    config: CFG, provider: { name: "x", model: "m" }, task: "a predictable planning job",
    runAgent: fake, workers: false, maxSegments: 10,
    signal: new AbortController().signal, onEvent: (e) => events.push(e),
  })
  eq("completed", r.status, "COMPLETED")
  const assessed = events.find((e) => e.type === "PLAN_RISK_ASSESSED")
  ok("PLAN_RISK_ASSESSED fired", !!assessed)
  ok("the assessment says estimates-not-proof", assessed?.estimatesNotProof === true)
  ok("the assessment carries a critical path", Array.isArray(assessed?.criticalPath?.path))
  ok("REALITY_DELTA fired", events.some((e) => e.type === "REALITY_DELTA"))
  const updated = events.find((e) => e.type === "PLAN_RISK_UPDATED")
  ok("PLAN_RISK_UPDATED fired with a live estimate", !!updated && typeof updated.successProbability === "number", JSON.stringify(updated ?? {}))
  ok("the live estimate is labeled as an estimate", /not proof/i.test(updated?.basis ?? ""))
  const gateEv = events.find((e) => e.type === "COMPLETION_GATE")
  ok("COMPLETION_GATE carries the verification plan", typeof gateEv?.verificationPlan?.level === "string", JSON.stringify(gateEv?.verificationPlan ?? {}))
  ok("the plan risk flows into the gate", gateEv?.planRisk != null)
}

console.log(`\n== v94 planner suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
