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
      failureModes.push({ mode: "scope_drift", from: "no declared targets", probability: 0.3 })
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
      ? Math.min(0.5, 0.15 + (calibration.avgDrift ?? 0.2) * 0.5)
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
  const uncertainty = calibratedUncertainty(calibration)

  const ladder = overall >= 0.75 ? "critical" : overall >= 0.55 ? "high" : overall >= 0.32 ? "medium" : overall >= 0.15 ? "low" : "trivial"

  return {
    risk: Number(overall.toFixed(3)),
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

function calibratedUncertainty(calibration) {
  if (calibration?.sufficient !== true) return 0.45
  return Number(Math.min(0.4, 0.1 + (calibration.avgDrift ?? 0.2) * 0.5).toFixed(3))
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
export const NON_ADOPTABLE = new Set(["conservative-order"]) // drops declared dependencies — advised, never auto-adopted

export function alternatives(assessment, planDefs = []) {
  if (!assessment || assessment.riskLadder !== "high" && assessment.riskLadder !== "critical") return []
  const nodes = planDefs.map((n) => ({ ...n }))
  if (!nodes.length) return []
  const opts = { klass: "MEDIUM", resources: null, calibration: null, lessons: [] }
  // deepwise: the original plan competes on the SAME thin-prior options as
  // the variants — an apples-to-apples comparison, not a rigged one.
  const a0 = assessPlan(buildTempDag(nodes), opts)
  const original = { name: "original", nodes: nodes.length, risk: a0.risk, successProbability: a0.successProbability, expectedVerifiedProgress: Number((a0.successProbability * 0.8 - a0.risk * 0.15).toFixed(3)) }
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
    variants.push({ name, nodes: defs.length, risk: a.risk, successProbability: a.successProbability, expectedVerifiedProgress })
    defsByName[name] = defs
  }
  variants.sort((a, b) => b.expectedVerifiedProgress - a.expectedVerifiedProgress)
  const best = variants[0]
  const bestIsOriginal = original.expectedVerifiedProgress >= best.expectedVerifiedProgress
  const winner = bestIsOriginal ? original : best
  return {
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
  out.sort((a, b) => (a.cost - b.cost))
  return { needed: out.length > 0, experiments: out.slice(0, 3), why: "high uncertainty — cheapest uncertainty-reducing experiments first" }
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
