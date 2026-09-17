/**
 * forge — Predictive Risk-Aware Planner (v94 "masterwise", §19–§29)
 *
 * Upgrades the planner from GOAL → PLAN to
 *   GOAL → PLAN → PREDICT → RISK SCORE → SUCCESS PROBABILITY → EXECUTE →
 *   OBSERVE → UPDATE → REPLAN.
 *
 * Everything here is DETERMINISTIC (no model calls, no fabricated
 * precision): probabilities are heuristic estimates derived from the plan
 * graph, the world model, past prediction calibration, lesson history and
 * tool-reliability stats. Weak evidence LOWERS the reported confidence —
 * an estimate with thin evidence says so (`confidence: "low"`), it never
 * pretends to be sure (§20).
 *
 * Composition, not duplication:
 *   - dag.js owns the graph; this module only reads it (+ stamps predictions)
 *   - verifyledger.js owns the risk ladder + RISK_PROFILE; this module maps
 *     plan risk onto verification LEVELS (§28) and flags
 *   - prediction.js owns per-segment expected-vs-observed settlement; this
 *     module classifies the resulting reality delta (§25) and turns it into
 *     live risk updates (§26)
 *   - infogain.js owns repair-side experiment ranking; this module performs
 *     the PLAN-TIME version (§24): cheapest uncertainty-reducing experiment
 *
 * Zero dependencies.
 */
import { loadLessons, relevantLessons } from "./lessons.js"
import { predictionCalibration } from "./prediction.js"

export const REALITY_DELTA = {
  MATCH: "MATCH",
  MINOR_DELTA: "MINOR_DELTA",
  SIGNIFICANT_DELTA: "SIGNIFICANT_DELTA",
  CONTRADICTION: "CONTRADICTION",
}

export const RISK_ORDER = { trivial: 0, low: 1, medium: 2, high: 3, critical: 4 }

// ---------------------------------------------------------------------------
// v121 deadwire — measured prediction error reaches the risk NUMBER
//
// predictionCalibration() computes eight signals from settled predictions.
// Before v121 this module consumed exactly one of them: avgDrift, into an
// uncertainty bump. riskBias, riskEscalations, outcomeAccuracy, testBias,
// stepBias, fileRecall and scopeDriftRate reached only PROSE — the sentence
// predictionsForPrompt adds to the system prompt and the weakness selfmodel
// lists. So a project whose last eight plans each ended TWO ladder steps above
// what was predicted assessed its next plan at exactly the number a project
// with no history at all would get:
//
//   riskBias +2 over 8 samples : 0.278 low
//   no calibration whatsoever  : 0.278 low
//
// The prompt said "risk was UNDER-predicted 8/8 times — predict risk honestly"
// while forge's own estimate stayed optimistic, and riskLadder is not
// cosmetic: meta.js only generates and adopts alternatives() at high/critical.
//
// Three rules keep this evidence and not enthusiasm:
//
//   DAMPING     nothing is claimed below CALIBRATION_MIN_SAMPLES observations
//               of the SPECIFIC signal (riskSamples for risk, outcomeSamples
//               for outcome accuracy) — not merely of settled predictions.
//   RAISE-ONLY  every term is non-negative by construction, so a calibrated
//               estimate can never fall below its uncalibrated value. Having
//               been wrong in the SAFE direction is not evidence for optimism.
//   BOUNDED     total risk pressure caps at RISK_PRESSURE_MAX. Calibration
//               adjusts the shape model; it never replaces it.
// ---------------------------------------------------------------------------

/** Observations of one signal needed before it may move a number. Mirrors
 *  prediction.js MIN_CALIBRATION_SAMPLES — two observations are an anecdote. */
export const CALIBRATION_MIN_SAMPLES = 5

/** One ladder step (trivial→low→medium→high→critical) is worth about this
 *  much of the 0..1 risk scale, whose bands sit at .15/.32/.55/.75. */
const LADDER_BAND = 0.2

/** Calibration may lift the estimate by at most ~1.5 ladder steps. */
const RISK_PRESSURE_MAX = 0.3
const COMPLEXITY_PRESSURE_MAX = 0.12
const UNCERTAINTY_PRESSURE_MAX = 0.12

/** The shape-model prior for "this node declares no targets, so the change
 *  may land anywhere". Measured drift may raise it; nothing lowers it. */
const SCOPE_DRIFT_PRIOR = 0.3

/**
 * Turn settled-prediction error into bounded, damped, raise-only pressure on
 * the planning numbers. Returns zeros — never negatives — when the evidence
 * is too thin to say anything, so callers can add unconditionally.
 */
export function calibrationPressure(calibration) {
  const out = { risk: 0, complexity: 0, uncertainty: 0, why: [], sufficient: false }
  if (calibration?.sufficient !== true) return out
  out.sufficient = true

  // §15 — risk systematically under-predicted. riskDelta is signed ladder
  // steps (finalRisk − expectedRisk), so riskBias is directly in ladder units.
  const riskSamples = Number(calibration.riskSamples) || 0
  const riskBias = Number(calibration.riskBias)
  if (riskSamples >= CALIBRATION_MIN_SAMPLES && Number.isFinite(riskBias) && riskBias > 0) {
    out.risk += Math.min(RISK_PRESSURE_MAX, riskBias * LADDER_BAND)
    const esc = Number(calibration.riskEscalations) || 0
    out.why.push(`risk under-predicted by ${riskBias} ladder step(s) over ${riskSamples} settled prediction(s) (${esc} escalation(s))`)
  }

  // §6/§21 — changes keep landing outside the declared targets, or the work
  // keeps taking more steps/tests than planned. Both are complexity the shape
  // model did not see in the DAG.
  let complexity = 0
  const drift = Number(calibration.scopeDriftRate)
  if (Number.isFinite(drift) && drift > 0.25) {
    complexity += Math.min(0.08, (drift - 0.25) * 0.2)
    out.why.push(`scope drift ${Math.round(drift * 100)}% — changes land outside the declared targets`)
  }
  const stepBias = Number(calibration.stepBias)
  if (Number.isFinite(stepBias) && stepBias > 0.5) {
    complexity += Math.min(0.06, stepBias * 0.02)
    out.why.push(`segments needed ~+${stepBias} more steps than predicted`)
  }
  const testBias = Number(calibration.testBias)
  if (Number.isFinite(testBias) && testBias > 0.5) {
    complexity += Math.min(0.04, testBias * 0.015)
    out.why.push(`~+${testBias} more verification run(s) than predicted`)
  }
  out.complexity = Math.min(COMPLEXITY_PRESSURE_MAX, complexity)

  // §15 — the outcome call itself has been wrong. That is uncertainty about
  // the estimate, not risk in the plan, so it widens the band instead.
  const outcomeSamples = Number(calibration.outcomeSamples) || 0
  const acc = Number(calibration.outcomeAccuracy)
  if (outcomeSamples >= CALIBRATION_MIN_SAMPLES && Number.isFinite(acc) && acc < 0.6) {
    out.uncertainty = Math.min(UNCERTAINTY_PRESSURE_MAX, (0.6 - acc) * 0.3)
    out.why.push(`outcome prediction was right only ${Math.round(acc * 100)}% of ${outcomeSamples} time(s)`)
  }
  return out
}

/** §28 — risk-based verification ladder (deterministic mapping). */
export function verificationPlanForRisk(risk) {
  switch (risk) {
    case "trivial":
    case "low":
      return { level: "LOW", targeted: true, regression: false, integration: false, adversarialReview: false, runtimeValidation: false, why: "low risk — targeted verification" }
    case "medium":
      return { level: "MEDIUM", targeted: true, regression: true, integration: false, adversarialReview: false, runtimeValidation: false, why: "medium risk — targeted + regression" }
    case "high":
      return { level: "HIGH", targeted: true, regression: true, integration: true, adversarialReview: false, runtimeValidation: false, why: "high risk — targeted + regression + integration" }
    case "critical":
      return { level: "CRITICAL", targeted: true, regression: true, integration: true, adversarialReview: true, runtimeValidation: true, why: "critical risk — full relevant verification + adversarial review + runtime validation" }
    default:
      return verificationPlanForRisk("medium")
  }
}

// ---------------------------------------------------------------------------
// §27 — critical path, bottlenecks, single points of failure
// ---------------------------------------------------------------------------

/**
 * Longest estimated-cost path through the DAG (topological DP over
 * node.estimated_cost), fan-in/fan-out bottlenecks, and SPOFs (the nodes
 * whose failure blocks the most downstream work).
 * @returns {{path:string[], spof:string[], bottlenecks:string[]}}
 */
export function criticalPath(dag) {
  const nodes = dag?.nodes instanceof Map ? [...dag.nodes.values()] : Array.isArray(dag) ? dag : []
  if (!nodes.length) return { path: [], spof: [], bottlenecks: [] }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const costOf = (n) => Math.max(1, Number(n?.estimated_cost) || 1)
  // longest path via memoized DFS (graph is validated acyclic upstream)
  const memo = new Map()
  const bestFrom = (id) => {
    if (memo.has(id)) return memo.get(id)
    memo.set(id, { cost: 0, path: [] }) // cycle guard
    const n = byId.get(id)
    let best = { cost: 0, path: [] }
    for (const dep of n?.dependencies ?? []) {
      if (!byId.has(dep)) continue
      const sub = bestFrom(dep)
      if (sub.cost > best.cost) best = sub
    }
    const r = { cost: best.cost + costOf(n), path: [...best.path, id] }
    memo.set(id, r)
    return r
  }
  let best = { cost: 0, path: [] }
  for (const n of nodes) {
    const r = bestFrom(n.id)
    if (r.cost > best.cost) best = r
  }
  // SPOF: descendants blocked if this node fails (downstream reach)
  const downstream = new Map()
  const reach = (id, seen = new Set()) => {
    for (const n of nodes) {
      if (seen.has(n.id)) continue
      if ((n.dependencies ?? []).includes(id)) {
        seen.add(n.id)
        reach(n.id, seen)
      }
    }
    return seen
  }
  const spof = nodes
    .map((n) => ({ id: n.id, blocked: reach(n.id).size }))
    .filter((x) => x.blocked >= 2)
    .sort((a, b) => b.blocked - a.blocked)
    .slice(0, 3)
    .map((x) => x.id)
  // bottlenecks: high fan-in × fan-out (many feed it, many wait on it)
  const fanIn = (id) => nodes.filter((n) => (n.dependencies ?? []).includes(id)).length
  const bottlenecks = nodes
    .map((n) => ({ id: n.id, v: (n.dependencies?.length ?? 0) * fanIn(n.id) }))
    .filter((x) => x.v >= 2)
    .sort((a, b) => b.v - a.v)
    .slice(0, 3)
    .map((x) => x.id)
  return { path: best.path, spof, bottlenecks }
}

// ---------------------------------------------------------------------------
// §21 — node-level prediction
// ---------------------------------------------------------------------------

/**
 * Per-node estimate: expected outcome, success probability, risk,
 * uncertainty, cost, failure modes and the verification method. Read-only
 * risk fields (risk ladder) stay; numeric probabilities are honest
 * heuristics from the node shape + class priors.
 */
export function predictNodes(dag, { klass = "MEDIUM", lessons = [], calibration = null } = {}) {
  const nodes = dag?.nodes instanceof Map ? [...dag.nodes.values()] : Array.isArray(dag) ? dag : []
  const out = new Map()
  const classBase = { MICRO: 0.95, SMALL: 0.9, MEDIUM: 0.82, LARGE: 0.74, ARCHITECTURAL: 0.65, RECOVERY: 0.7 }
  const base = classBase[klass] ?? 0.8
  const riskPenalty = { trivial: 0, low: 0.03, medium: 0.1, high: 0.2, critical: 0.32 }
  // v121 deadwire: measured error widens the band and sets the scope-drift
  // failure probability that used to be the constant 0.3.
  const pressure = calibrationPressure(calibration)
  for (const n of nodes) {
    const risk = RISK_ORDER[n.risk] != null ? n.risk : "low"
    let p = base - (riskPenalty[risk] ?? 0.1)
    const isReadOnly = n.read_only === true
    if (isReadOnly) p += 0.08 // investigation rarely "fails", it just informs
    const deps = n.dependencies?.length ?? 0
    p -= Math.min(0.15, deps * 0.03) // dependency chain risk
    if (n.optional === true) p += 0.02
    // failure forecasting (§22): lesson history for this node's objective
    const text = String(n.objective ?? n.title ?? "")
    const failureModes = []
    let impact = 1, recovery = 1
    for (const l of lessons.slice(0, 60)) {
      const hay = `${l.failure ?? ""} ${l.symptoms ?? ""}`.toLowerCase()
      const words = text.toLowerCase().split(/\W+/).filter((w) => w.length > 3)
      const hit = words.some((w) => hay.includes(w))
      if (hit && l.failureClass) {
        failureModes.push({ mode: String(l.failureClass).slice(0, 40), from: "lesson", probability: Math.min(0.7, 0.2 + (l.failureCount ?? 0) * 0.05) })
        p -= 0.05
        if (failureModes.length >= 3) break
      }
    }
    if (!isReadOnly && (n.targetFiles?.length ?? 0) === 0 && (n.dependencies?.length ?? 0) > 0) {
      // v121: scopeDriftRate measured how often changes actually landed
      // outside the declared targets and reached nothing — this probability
      // was the constant 0.3 however much drift had been observed. Raise-only,
      // like every other calibration term here: measured drift ABOVE the shape
      // prior lifts it; a low measured rate leaves the prior alone rather than
      // talking the planner out of a caution it has not earned.
      const measuredDrift = pressure.sufficient ? Number(calibration.scopeDriftRate) : NaN
      failureModes.push(Number.isFinite(measuredDrift) && measuredDrift > SCOPE_DRIFT_PRIOR
        ? { mode: "scope_drift", from: `measured scope drift ${Math.round(measuredDrift * 100)}%`, probability: Number(Math.min(0.7, measuredDrift).toFixed(3)) }
        : { mode: "scope_drift", from: "no declared targets", probability: SCOPE_DRIFT_PRIOR })
    }
    if (risk === "high" || risk === "critical") {
      failureModes.push({ mode: "verification_gap", from: "risk ladder", probability: risk === "critical" ? 0.4 : 0.25 })
      recovery = 3
      impact = risk === "critical" ? 4 : 3
    }
    p = Math.max(0.05, Math.min(0.98, p))
    // calibration evidence adjusts confidence, not the estimate itself (§20)
    const calibrated = calibration?.sufficient === true
    const uncertainty = calibrated
      ? Math.min(0.5, 0.15 + (calibration.avgDrift ?? 0.2) * 0.5 + pressure.uncertainty)
      : 0.45 // thin evidence → high uncertainty, never fake precision
    out.set(n.id, {
      nodeId: n.id,
      expectedOutcome: "advance",
      successProbability: Number(p.toFixed(3)),
      risk,
      uncertainty: Number(uncertainty.toFixed(3)),
      estimatedCost: costOf(n),
      dependencies: n.dependencies ?? [],
      failureModes,
      verificationMethod: isReadOnly
        ? "review findings"
        : (n.verificationRequirements?.length ? n.verificationRequirements.join(" + ") : "risk-ladder default"),
      forecastScore: failureModes.length ? Number((failureModes[0].probability * impact * recovery).toFixed(3)) : 0,
      derived: "deterministic node shape + class prior + lesson history",
    })
  }
  return out
}

function costOf(n) {
  return Math.max(1, Number(n?.estimated_cost) || 1)
}

// ---------------------------------------------------------------------------
// §20 — plan-level risk assessment
// ---------------------------------------------------------------------------

/**
 * Assess the whole plan BEFORE execution. Returns numeric estimates plus an
 * explicit evidence-strength statement (weak evidence ⇒ confidence "low").
 */
export function assessPlan(dag, {
  klass = "MEDIUM",
  world = null,
  resources = null,
  calibration = null,
  lessons = [],
  task = "",
  securitySensitive = false,
} = {}) {
  const nodes = dag?.nodes instanceof Map ? [...dag.nodes.values()] : Array.isArray(dag) ? dag : []
  const n = nodes.length
  const mutating = nodes.filter((x) => x.read_only !== true).length
  const cp = criticalPath(dag)
  const depths = nodes.map((x) => (x.dependencies?.length ?? 0))
  const maxDeps = Math.max(0, ...depths)
  const targetFiles = new Set()
  for (const x of nodes) for (const f of x.targetFiles ?? []) targetFiles.add(f)

  // factor sub-scores, all 0..1 (1 = worst)
  const complexity = Math.min(1, (n / 40) * 0.5 + (mutating / Math.max(1, n)) * 0.3 + (maxDeps / 6) * 0.2)
  const dependencyRisk = cp.spof.length ? Math.min(1, 0.3 + cp.spof.length * 0.2) : Math.min(1, maxDeps / 8)
  const environmentRisk = (() => {
    if (!resources) return 0.3
    const s = resources.snapshot?.() ?? resources.state ?? {}
    const freeMB = s.freeMB ?? 2048
    const disk = s.diskFreeMB ?? 10240
    return Math.min(1, (freeMB < 400 ? 0.5 : 0) + (disk < 200 ? 0.5 : 0) + (s.tier === "low" ? 0.2 : 0))
  })()
  const runtimeRisk = Math.min(1, securitySensitive ? 0.9 : mutating / Math.max(1, n) * 0.6)
  const modelRisk = klass === "ARCHITECTURAL" ? 0.5 : klass === "LARGE" ? 0.4 : 0.25
  const toolRisk = (() => {
    // bash-heavy plans carry more tool risk; read-only investigation carries less
    const bashy = nodes.filter((x) => /build|test|run|install|migrat|deploy|exec/i.test(String(x.objective ?? x.title ?? ""))).length
    return Math.min(1, 0.2 + (bashy / Math.max(1, n)) * 0.6)
  })()
  const verificationRisk = (() => {
    const noVerify = nodes.filter((x) => x.read_only !== true && !(x.verificationRequirements?.length)).length
    return Math.min(1, (noVerify / Math.max(1, mutating)) * 0.8)
  })()
  const resourceRisk = environmentRisk

  const factors = { complexity, dependency: dependencyRisk, tool: toolRisk, model: modelRisk, environment: environmentRisk, runtime: runtimeRisk, verification: verificationRisk, resource: resourceRisk }
  const weights = { complexity: 0.2, dependency: 0.15, tool: 0.12, model: 0.08, environment: 0.08, runtime: 0.15, verification: 0.12, resource: 0.1 }
  let overall = 0
  for (const k of Object.keys(weights)) overall += factors[k] * weights[k]
  overall = Math.min(1, Math.max(0, overall))
  // v121 deadwire: the DAG shape is what the planner can SEE. Settled
  // predictions are what actually happened last time, and before v121 they
  // reached this number not at all. Pressure is non-negative by construction,
  // so `overall` can only ever rise from here — `shapeRisk` below keeps the
  // uncalibrated estimate visible so the lift is inspectable, not folded in.
  const shapeRisk = overall
  const pressure = calibrationPressure(calibration)
  overall = Math.min(1, overall + pressure.risk + pressure.complexity)

  // success probability: noisy-OR style combination of node predictions,
  // dampened (nodes are not fully independent) — a plan-level ESTIMATE.
  const preds = predictNodes(dag, { klass, lessons, calibration })
  let fail = 1
  for (const p of preds.values()) fail *= 1 - p.successProbability
  const independent = 1 - fail
  // dampen toward the mean: real plans have correlated failures AND recoveries
  const successProbability = Math.max(0.05, Math.min(0.97, 0.5 + (independent - 0.5) * 0.85))
  // critical-path / SPOF drag
  const successAdjusted = Math.max(0.05, successProbability - cp.spof.length * 0.04)

  // evidence strength (§20): weak evidence must REDUCE confidence
  const evidenceSamples = calibration?.sufficient === true ? (calibration.filePrecision != null ? 5 : 0) : 0
  const lessonCount = lessons.length
  const confidence = evidenceSamples >= 5 && lessonCount >= 3 ? "high" : evidenceSamples >= 5 || lessonCount >= 3 ? "medium" : "low"
  const uncertainty = calibratedUncertainty(calibration, pressure)

  const ladder = overall >= 0.75 ? "critical" : overall >= 0.55 ? "high" : overall >= 0.32 ? "medium" : overall >= 0.15 ? "low" : "trivial"

  return {
    risk: Number(overall.toFixed(3)),
    // what the DAG shape alone said, before settled-prediction evidence
    shapeRisk: Number(shapeRisk.toFixed(3)),
    calibrationPressure: {
      risk: Number(pressure.risk.toFixed(3)),
      complexity: Number(pressure.complexity.toFixed(3)),
      uncertainty: Number(pressure.uncertainty.toFixed(3)),
      why: pressure.why.slice(0, 3),
    },
    riskLadder: ladder,
    successProbability: Number(successAdjusted.toFixed(3)),
    failureProbability: Number((1 - successAdjusted).toFixed(3)),
    uncertainty,
    confidence, // evidence strength for the estimate itself
    factors,
    criticalPath: cp,
    nodeCount: n,
    mutatingNodes: mutating,
    targetFiles: [...targetFiles].slice(0, 24),
    estimatesNotProof: true,
  }
}

function calibratedUncertainty(calibration, pressure = null) {
  if (calibration?.sufficient !== true) return 0.45
  const drift = Math.min(0.4, 0.1 + (calibration.avgDrift ?? 0.2) * 0.5)
  // v121: outcomeAccuracy measured how often the outcome CALL was right and
  // then reached nothing. A planner that keeps being wrong about outcomes is
  // more uncertain than its drift alone says.
  const extra = Number(pressure?.uncertainty) || 0
  return Number(Math.min(0.5, drift + extra).toFixed(3))
}

// ---------------------------------------------------------------------------
// §23 — alternative plans (for high-risk plans)
// ---------------------------------------------------------------------------

/**
 * Generate alternative plan shapes for a high-risk plan and compare them on
 * expected VERIFIED progress (success probability × verified fraction −
 * risk penalty), never on raw cost alone. Returns [] for low-risk plans.
 *
 * v94 deepwise: the ORIGINAL plan now competes as a candidate too. The
 * winner (original or a variant) is reported honestly, and when the winner
 * is a shape-changing variant its full node definitions are returned so the
 * planner can actually ADOPT it (see adoptDecision + the meta planner) —
 * alternatives are no longer computed-then-ignored.
 */
export const ADOPT_MARGIN = 0.03

/**
 * v126 — how much MEASURED shape history may move a candidate.
 *
 * Sized against the two gaps that actually occur. On a real two-node plan the
 * top candidates sit 0.001 apart (inspect-first 0.746, incremental-verify
 * 0.745) — a statistical tie the estimate cannot resolve — while the gap to
 * the original is 0.082. With add-two damping the term spans +/-0.03, so the
 * widest SWING between two candidates is 0.06: decisive on a near-tie, and
 * unable to overturn a clear estimate difference. One observation moves a
 * candidate by 0.010, a third of ADOPT_MARGIN — visible, never decisive.
 *
 * Damping is crewroute's, not a new invention: (ok + 1) / (samples + 2), two
 * pseudo-runs at 50%. It needs no minimum-sample floor because a single
 * result barely moves it and it converges honestly — which matters here,
 * because alternatives() only runs on high-risk plans, so a hard floor of 5
 * might never fill on a small project.
 */
export const SHAPE_WEIGHT = 0.06

/** Damped, bounded adjustment for one shape's measured history. */
export function shapeAdjustment(rec) {
  const samples = Number(rec?.samples) || 0
  if (samples <= 0) return 0
  const ok = Number(rec?.ok) || 0
  const shrunk = (ok + 1) / (samples + 2)     // add-two damping (crewroute)
  return Number(((shrunk - 0.5) * SHAPE_WEIGHT).toFixed(4))
}
export const NON_ADOPTABLE = new Set(["conservative-order"]) // drops declared dependencies — advised, never auto-adopted

export function alternatives(assessment, planDefs = [], { shapeRates = null } = {}) {
  // v96 unifywise: ONE return shape. This function used to return [] (an
  // array) for low/medium-risk plans and an object for high/critical — every
  // caller had to guard with `alts?.recommended` AND `!Array.isArray(alts)`.
  // Low-risk plans now get the same { needed:false, ... } shape; `needed`
  // is the one flag callers check.
  if (!assessment || assessment.riskLadder !== "high" && assessment.riskLadder !== "critical") {
    return { needed: false, recommended: null, all: [], basis: "risk ladder does not warrant reshaping", original: null, bestIsOriginal: true, winner: null, winnerDefs: null, margin: 0 }
  }
  const nodes = planDefs.map((n) => ({ ...n }))
  if (!nodes.length) {
    return { needed: false, recommended: null, all: [], basis: "no nodes to reshape", original: null, bestIsOriginal: true, winner: null, winnerDefs: null, margin: 0 }
  }
  const opts = { klass: "MEDIUM", resources: null, calibration: null, lessons: [] }
  // deepwise: the original plan competes on the SAME thin-prior options as
  // the variants — an apples-to-apples comparison, not a rigged one.
  const a0 = assessPlan(buildTempDag(nodes), opts)
  // v126: measured history for this task class, applied to the ESTIMATE that
  // ranks candidates. `rates` absent (or empty) leaves every number exactly as
  // it was, so a fresh project plans identically to before.
  const rates = shapeRates && typeof shapeRates === "object" ? shapeRates : {}
  const measuredFor = (name) => {
    const rec = rates[name]
    const adj = shapeAdjustment(rec)
    return adj ? { adjustment: adj, samples: Number(rec.samples) || 0, ok: Number(rec.ok) || 0 } : null
  }
  const withMeasured = (cand) => {
    const m = measuredFor(cand.name)
    if (!m) return cand
    return { ...cand, estimatedVerifiedProgress: cand.expectedVerifiedProgress, measured: m, expectedVerifiedProgress: Number((cand.expectedVerifiedProgress + m.adjustment).toFixed(3)) }
  }
  const original = withMeasured({ name: "original", nodes: nodes.length, risk: a0.risk, successProbability: a0.successProbability, expectedVerifiedProgress: Number((a0.successProbability * 0.8 - a0.risk * 0.15).toFixed(3)) })
  const variants = []
  const defsByName = {}
  // (a) inspect-first: prepend a read-only discovery node that everything depends on
  const inspectFirst = [
    { id: "alt_inspect", objective: `Investigate the surfaces this plan touches before mutating anything: ${planDefs.map((n) => n.objective ?? n.title ?? "").slice(0, 3).join("; ")}`.slice(0, 600), dependencies: [], read_only: true, risk: "low", estimated_cost: 1 },
    ...nodes.map((n) => ({ ...n, dependencies: [...(n.dependencies ?? []), "alt_inspect"] })),
  ]
  // (b) incremental: split the plan into verify-as-you-go halves — the second
  //     half depends on the first half's verification
  const mid = Math.ceil(nodes.length / 2)
  const first = nodes.slice(0, mid).map((n) => ({ ...n }))
  const second = nodes.slice(mid).map((n) => ({ ...n, dependencies: [...new Set([...(n.dependencies ?? []), "alt_verify_mid"])].filter((d) => d !== n.id) }))
  const incremental = [...first, { id: "alt_verify_mid", objective: "Verify the first half end-to-end before continuing", dependencies: first.map((x) => x.id), read_only: true, risk: "low", estimated_cost: 1 }, ...second]
  // (c) conservative order: fully serialized (no parallel branches)
  const serialized = nodes.map((n, i) => ({ ...n, dependencies: i ? [nodes[i - 1].id] : [] }))
  for (const [name, defs] of [["inspect-first", inspectFirst], ["incremental-verify", incremental], ["conservative-order", serialized]]) {
    const a = assessPlan(buildTempDag(defs), opts)
    const verifiedFraction = 0.8 + (defs.some((d) => d.id?.startsWith("alt_verify") || d.id === "alt_inspect") ? 0.1 : 0)
    const expectedVerifiedProgress = Number((a.successProbability * verifiedFraction - a.risk * 0.15).toFixed(3))
    variants.push(withMeasured({ name, nodes: defs.length, risk: a.risk, successProbability: a.successProbability, expectedVerifiedProgress }))
    defsByName[name] = defs
  }
  variants.sort((a, b) => b.expectedVerifiedProgress - a.expectedVerifiedProgress)
  const best = variants[0]
  const bestIsOriginal = original.expectedVerifiedProgress >= best.expectedVerifiedProgress
  const winner = bestIsOriginal ? original : best
  return {
    needed: true,
    recommended: winner, all: variants, basis: "expected verified progress, not raw cost",
    // deepwise (additive): winner vs original, and the winner's real node
    // definitions when adoption is structurally safe to consider.
    original, bestIsOriginal, winner,
    winnerDefs: !bestIsOriginal && !NON_ADOPTABLE.has(winner.name) ? defsByName[winner.name] : null,
    margin: Number((winner.expectedVerifiedProgress - original.expectedVerifiedProgress).toFixed(3)),
  }
}

/**
 * deepwise — deterministic adoption gate. A winning variant is ADOPTED only
 * when it beats the original by a meaningful margin at equal-or-better risk
 * and success. Never adopts: the original itself (nothing to adopt), shapes
 * that drop declared dependencies, or any candidate that is worse on success
 * or risk. Returns { adopt, why, name?, margin? } — pure, no I/O.
 */
export function adoptDecision(alts) {
  if (!alts || typeof alts !== "object") return { adopt: false, why: "no alternatives computed" }
  if (alts.bestIsOriginal || !alts.winner) return { adopt: false, why: "the original plan already matches the best candidate" }
  const o = alts.original
  const w = alts.winner
  if (!o || !w) return { adopt: false, why: "incomplete candidate set" }
  if (!Array.isArray(alts.winnerDefs) || !alts.winnerDefs.length) return { adopt: false, why: `the winning shape (${w.name}) is not adoption-safe — advised, never auto-adopted` }
  const margin = Number((w.expectedVerifiedProgress - o.expectedVerifiedProgress).toFixed(3))
  if (!(margin >= ADOPT_MARGIN)) return { adopt: false, why: `winner margin ${margin} is below the adoption threshold ${ADOPT_MARGIN} — not worth reshaping the plan` }
  if (w.successProbability < o.successProbability) return { adopt: false, why: "winner has a lower success estimate than the original — never adopt a less likely plan" }
  if (Number(w.risk) > Number(o.risk)) return { adopt: false, why: "winner sits higher on the risk ladder than the original — never adopt a riskier plan" }
  return { adopt: true, why: `${w.name} beats the original by ${margin} expected verified progress at equal-or-better risk and success`, name: w.name, margin }
}

function buildTempDag(defs) {
  // assessPlan accepts plain arrays — reuse that path
  return defs
}

// ---------------------------------------------------------------------------
// §24 — plan-time information gain
// ---------------------------------------------------------------------------

/**
 * When uncertainty is high, find the CHEAPEST experiment that reduces it
 * before executing mutating work. Deterministic: reads the plan + known
 * gaps, ranks read-only experiments by (uncertainty reduction) / cost.
 */
export function informationGainExperiments({ assessment, planDefs = [], knowledgeGaps = [] } = {}) {
  const out = []
  const uncertainty = assessment?.uncertainty ?? 0
  if (uncertainty < 0.35) return { needed: false, experiments: out, why: "uncertainty is acceptable — execute" }
  const mutating = planDefs.filter((n) => n.read_only !== true)
  const targets = [...new Set(mutating.flatMap((n) => n.targetFiles ?? []))].slice(0, 6)
  if (targets.length) {
    out.push({ experiment: "inspect targets", kind: "INSPECT", cost: 1, reduces: "target-surface uncertainty", how: `read ${targets.slice(0, 3).join(", ")} before mutating`, mutating: false })
  }
  for (const g of (knowledgeGaps ?? []).slice(0, 3)) {
    out.push({ experiment: `acquire: ${g.id ?? g.domain ?? "gap"}`, kind: "DISCRIMINATE", cost: Number(g.cost ?? 2), reduces: g.question ?? g.id ?? "knowledge gap", how: g.acquire ?? "cheapest source first (skill → repo → docs)", mutating: false })
  }
  if (mutating.length > 2) {
    out.push({ experiment: "dry-run the riskiest step", kind: "ISOLATE", cost: 2, reduces: "execution uncertainty", how: "replay the highest-risk mutation against a scratch copy first", mutating: false })
  }
  // v96 unifywise: rank by EXPECTED REDUCTION PER UNIT COST, not cost alone —
  // the header contract said "(uncertainty reduction)/cost" while the code
  // sorted by raw cost (a cheap-but-useless experiment beat an informative
  // one). Each experiment now carries its expected reduction (deterministic:
  // a target-surface inspection reduces the most, a dry-run less, a gap
  // acquisition reduces what its gap says it does) and the sort honors it.
  for (const e of out) {
    e.expectedReduction = e.kind === "INSPECT" ? 0.5 : e.kind === "ISOLATE" ? 0.35 : Number(e.reduces ? 0.3 : 0.2)
    e.value = Number((e.expectedReduction / Math.max(1, e.cost)).toFixed(3))
  }
  out.sort((a, b) => (b.value - a.value) || (a.cost - b.cost))
  return { needed: out.length > 0, experiments: out.slice(0, 3), why: "high uncertainty — highest uncertainty-reduction-per-cost experiments first" }
}

// ---------------------------------------------------------------------------
// §25/§26 — reality delta classification + live risk updates
// ---------------------------------------------------------------------------

/**
 * Classify the reality delta from a prediction.js settlement:
 *   MATCH              — reality ≈ prediction
 *   MINOR_DELTA        — small drift
 *   SIGNIFICANT_DELTA  — world differs enough to update model/risk/plan
 *   CONTRADICTION      — outcome was wrong / risk jumped the ladder
 */
export function classifyRealityDelta(settled = {}) {
  const drift = Number(settled.driftScore ?? 0)
  const riskDelta = Number(settled.riskDelta ?? 0)
  const outcomeCorrect = settled.outcomeCorrect !== false
  // a 3-ladder-step risk jump CONTRADICTS the predicted risk outright; a
  // wrong outcome with a 2-step jump does too
  if (!outcomeCorrect && riskDelta >= 2) return { cls: REALITY_DELTA.CONTRADICTION, why: `outcome wrong and risk jumped ${riskDelta} ladder steps` }
  if (riskDelta >= 3) return { cls: REALITY_DELTA.CONTRADICTION, why: `risk jumped ${riskDelta} ladder steps — the prediction was contradicted` }
  if (riskDelta >= 2 || drift >= 0.66) return { cls: REALITY_DELTA.SIGNIFICANT_DELTA, why: `drift ${drift.toFixed(2)}, risk Δ${riskDelta} — update world model, risk and plan` }
  if (riskDelta >= 1 || drift >= 0.25) return { cls: REALITY_DELTA.MINOR_DELTA, why: `drift ${drift.toFixed(2)}, risk Δ${riskDelta}` }
  return { cls: REALITY_DELTA.MATCH, why: `drift ${drift.toFixed(2)}, risk Δ${riskDelta} — reality matches prediction` }
}

/**
 * §26 live risk: event-driven multiplicative updates on the success
 * estimate, bounded per event and clamped to [0.05, 0.97]. These are
 * ESTIMATES, never proof.
 */
export function createLiveRisk(initialSuccessProbability = 0.8) {
  const state = {
    successProbability: Math.max(0.05, Math.min(0.97, initialSuccessProbability)),
    history: [{ at: Date.now(), event: "initial", p: Math.max(0.05, Math.min(0.97, initialSuccessProbability)) }],
  }
  const clamp = (p) => Math.max(0.05, Math.min(0.97, p))
  const apply = (event, factor) => {
    state.successProbability = clamp(state.successProbability * factor)
    state.history.push({ at: Date.now(), event, factor, p: Number(state.successProbability.toFixed(3)) })
    if (state.history.length > 50) {
      // keep the initial baseline pinned (it is the plan estimate), trim the middle
      state.history.splice(1, state.history.length - 50)
    }
    return state.successProbability
  }
  return {
    get: () => state.successProbability,
    history: state.history,
    toolResult: (ok) => apply("tool_result", ok ? 1.03 : 0.9),
    testResult: (ok) => apply("test", ok ? 1.06 : 0.78),
    failure: (severity = 1) => apply("failure", Math.max(0.6, 0.92 - 0.08 * severity)),
    milestone: () => apply("milestone", 1.05),
    experiment: (informative) => apply("experiment", informative ? 1.05 : 0.98),
    environmentChange: () => apply("environment_change", 0.95),
    searchEvidence: (supports) => apply("search_evidence", supports ? 1.04 : 0.93),
    realityDelta: (cls) => apply("reality_delta", cls === REALITY_DELTA.MATCH ? 1.04 : cls === REALITY_DELTA.MINOR_DELTA ? 0.97 : cls === REALITY_DELTA.SIGNIFICANT_DELTA ? 0.88 : 0.75),
  }
}

// ---------------------------------------------------------------------------
// Convenience: gather the evidence inputs (lessons + calibration) for a task
// ---------------------------------------------------------------------------

export function gatherPlannerEvidence(cwd, task) {
  let lessons = []
  try { lessons = loadLessons(cwd) ?? [] } catch { }
  if ((!lessons || !lessons.length) && task) {
    try { lessons = relevantLessons(task, { cwd, limit: 10 }) ?? [] } catch { }
  }
  let calibration = null
  try { calibration = predictionCalibration(cwd) } catch { }
  return { lessons, calibration }
}
