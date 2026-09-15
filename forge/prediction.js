/**
 * forge — prediction ledger (v92 "wirewise", ∞ CORE §9, zero dependencies)
 *
 * PREDICTIVE ENGINEERING, made real:
 *
 *   BEFORE a significant action  → predict expected files, expected risk and
 *                                  expected outcome (deterministic, derived
 *                                  from the DAG node + plan — NEVER a model's
 *                                  self-reported confidence, which is not
 *                                  evidence).
 *   AFTER execution              → compare prediction with observed reality:
 *                                  Prediction → Observation → Reality Delta.
 *   OVER TIME                    → accumulate the deltas, calibrate, and feed
 *                                  the errors back into planning so future
 *                                  task strategy improves (§9 "learn from
 *                                  incorrect predictions").
 *
 * Schema (a settled prediction entry):
 *
 *   id                 pred-<base36 time>-<seq>
 *   taskId / nodeId / segmentId / segment   identity (P0 exact attribution)
 *   objective          task objective (bounded)
 *   madeAt / settledAt timestamps
 *   expectedFiles      predicted affected files (relative, bounded)
 *   expectedRisk       planning risk at prediction time
 *   expectedOutcome    advance | blocked (advance = node proceeds)
 *   derived            targets | objective-only (honesty about the source)
 *   actualFiles        files that actually changed (relative, bounded)
 *   finalRisk          risk recalculated from actual changes
 *   status             ok | error (segment outcome)
 *   filesHit           predicted ∩ actual   (precision evidence)
 *   filesExtra         changed but not predicted (scope drift, §6)
 *   filesMissed        predicted but not changed (incomplete work)
 *   riskDelta          +2 risk ladder steps (finalRisk − expectedRisk)
 *   outcomeCorrect     predicted outcome matched reality
 *   driftScore         0..1 — 1 = reality fully outside the prediction
 *
 * Storage: ~/.forge/projects/<hash>/predictions.json (atomic writeStateFile,
 * bounded like lessons). Provenance is first-class: every entry records what
 * it was derived from, so calibration can weight targeted predictions above
 * objective-only guesses.
 *
 * Honesty rules (§92 "never fake success"):
 *   - a prediction with no node targets is labeled objective-only, not
 *     "expected nothing to change"
 *   - settlement records UNKNOWN reality as null fields, never as zeros
 *   - calibration is only reported when there are enough settled samples;
 *     below the minimum it says "insufficient evidence"
 */
import fs from "node:fs"
import path from "node:path"
import { projectDir } from "./memory.js"
import { writeStateFile } from "./securefs.js"
import { RISK_ORDER } from "./verifyledger.js"

export const PREDICTION_OUTCOMES = ["advance", "blocked"]
export const MAX_PREDICTIONS = 200
export const MAX_PREDICTION_FILES = 24
export const MIN_CALIBRATION_SAMPLES = 5

let seq = 0
const now = () => Date.now()
const rel = (f) => { try { return path.relative(process.cwd(), f) } catch { return String(f) } }
const clamp01 = (n) => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0

export function predictionsPath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), "predictions.json")
}

export function loadPredictions(cwd = process.cwd()) {
  try {
    const j = JSON.parse(fs.readFileSync(predictionsPath(cwd), "utf8"))
    const arr = Array.isArray(j) ? j : Array.isArray(j?.predictions) ? j.predictions : []
    return arr.filter((p) => p && typeof p === "object")
  } catch { return [] }
}

/** §9 — build the deterministic prediction for a segment about to run.
 *  v97 §29: the prediction now also covers TESTS and STEPS (effort) — the two
 *  realities a planner can be systematically wrong about. Both stay null
 *  (honest UNKNOWN) when the caller has no deterministic basis. */
export function predictForNode({ node = null, objective = "", riskLevel = null, segment = 0, segmentId = null, taskId = null, expectedTests = null, expectedSteps = null } = {}) {
  const targets = node?.targetFiles ?? node?.target_files ?? []
  const symbols = node?.targetSymbols ?? node?.target_symbols ?? []
  const expectedFiles = (Array.isArray(targets) ? targets : []).map(rel).filter(Boolean).slice(0, MAX_PREDICTION_FILES)
  const expectedRisk = RISK_ORDER[riskLevel] != null ? riskLevel : (RISK_ORDER[node?.risk] != null ? node.risk : null)
  return {
    id: `pred-${now().toString(36)}-${++seq}`,
    taskId: taskId ?? null,
    nodeId: node?.id ?? null,
    segmentId: segmentId ?? (segment ? `seg-${segment}` : null),
    segment: Number.isFinite(segment) ? segment : 0,
    objective: String(objective ?? "").slice(0, 240),
    madeAt: now(),
    settledAt: null,
    expectedFiles,
    expectedSymbols: (Array.isArray(symbols) ? symbols : []).slice(0, 12),
    expectedRisk,
    expectedTests: Number.isFinite(expectedTests) ? Math.max(0, Math.round(expectedTests)) : null,
    expectedSteps: Number.isFinite(expectedSteps) ? Math.max(0, Math.round(expectedSteps)) : null,
    expectedOutcome: "advance",
    derived: expectedFiles.length ? "targets" : "objective-only",
    // reality — unset until settlement
    actualFiles: null,
    finalRisk: null,
    status: null,
  }
}

/**
 * §9 — settle a prediction against observed reality and compute the delta.
 * `actualFiles` are absolute OR relative paths (normalized to relative);
 * `finalRisk` is the risk recalculated from the actual change; `status` is
 * the segment outcome ("ok" | "error" | null = unknown).
 */
export function settlePrediction(pred, { actualFiles = [], finalRisk = null, status = null, actualTests = null, actualSteps = null } = {}) {
  if (!pred || typeof pred !== "object") return pred
  const expected = (pred.expectedFiles ?? []).map(String)
  const actual = (Array.isArray(actualFiles) ? actualFiles : []).map(rel).filter(Boolean).slice(0, MAX_PREDICTION_FILES)
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  const filesHit = actual.filter((f) => expectedSet.has(f))
  const filesExtra = actual.filter((f) => !expectedSet.has(f))
  const filesMissed = expected.filter((f) => !actualSet.has(f))
  const eo = RISK_ORDER[pred.expectedRisk] ?? null
  const fo = RISK_ORDER[finalRisk] ?? null
  const riskDelta = eo != null && fo != null ? fo - eo : null
  const outcomeCorrect = status == null ? null : (status === "ok") === (pred.expectedOutcome === "advance")
  // v97 §29: tests + steps deltas (null-vs-null stays null — UNKNOWN ≠ 0)
  const testsDelta = Number.isFinite(pred.expectedTests) && Number.isFinite(actualTests) ? actualTests - pred.expectedTests : null
  const stepsDelta = Number.isFinite(pred.expectedSteps) && Number.isFinite(actualSteps) ? actualSteps - pred.expectedSteps : null
  // drift: how far reality sat outside the prediction, 0 = fully predicted
  const denom = Math.max(1, expected.length, actual.length)
  const driftScore = clamp01((filesExtra.length + filesMissed.length) / denom)
  return {
    ...pred,
    settledAt: now(),
    actualFiles: actual,
    finalRisk: RISK_ORDER[finalRisk] != null ? finalRisk : null,
    status: status == null ? null : String(status).slice(0, 40),
    filesHit,
    filesExtra,
    filesMissed,
    riskDelta,
    outcomeCorrect,
    driftScore,
    actualTests: Number.isFinite(actualTests) ? actualTests : null,
    actualSteps: Number.isFinite(actualSteps) ? actualSteps : null,
    testsDelta,
    stepsDelta,
  }
}

/** Persist one settled prediction (bounded, atomic, best-effort).
 * A non-record entry is rejected outright — a null/garbage entry in the
 * ledger would poison calibration silently. */
export function recordPrediction(entry, cwd = process.cwd()) {
  if (!entry || typeof entry !== "object" || !entry.id) return false
  try {
    const all = loadPredictions(cwd)
    const filtered = all.filter((p) => p && p.id !== entry.id)
    filtered.push(entry)
    writeStateFile(predictionsPath(cwd), JSON.stringify({ predictions: filtered.slice(-MAX_PREDICTIONS) }, null, 1))
    return true
  } catch { return false }
}

/**
 * §9 calibration — aggregate the settled history into planning feedback.
 * Only targeted predictions (derived === "targets") count toward file
 * precision; objective-only entries would dilute the signal dishonestly.
 */
export function predictionCalibration(cwd = process.cwd()) {
  const settled = loadPredictions(cwd).filter((p) => p.settledAt)
  const targeted = settled.filter((p) => p.derived === "targets")
  const riskSamples = settled.filter((p) => Number.isFinite(p.riskDelta))
  const outcomeSamples = settled.filter((p) => p.outcomeCorrect != null)
  if (settled.length < MIN_CALIBRATION_SAMPLES) {
    return { samples: settled.length, sufficient: false, note: "insufficient evidence for prediction calibration" }
  }
  const predicted = targeted.reduce((a, p) => a + (p.expectedFiles?.length ?? 0), 0)
  const hit = targeted.reduce((a, p) => a + (p.filesHit?.length ?? 0), 0)
  const extra = targeted.reduce((a, p) => a + (p.filesExtra?.length ?? 0), 0)
  const missed = targeted.reduce((a, p) => a + (p.filesMissed?.length ?? 0), 0)
  const precision = predicted ? clamp01(hit / predicted) : null
  const recall = hit + missed ? clamp01(hit / (hit + missed)) : null
  const drift = settled.length ? clamp01(settled.reduce((a, p) => a + (p.driftScore ?? 0), 0) / settled.length) : null
  const riskBias = riskSamples.length
    ? Number((riskSamples.reduce((a, p) => a + p.riskDelta, 0) / riskSamples.length).toFixed(2))
    : null
  const riskEscalations = riskSamples.filter((p) => p.riskDelta > 0).length
  const outcomeAccuracy = outcomeSamples.length
    ? clamp01(outcomeSamples.filter((p) => p.outcomeCorrect).length / outcomeSamples.length)
    : null
  // v97 §29: test/effort calibration — is the planner systematically running
  // more tests / more steps than it predicted? (Honest: null without samples.)
  const testSamples = settled.filter((p) => Number.isFinite(p.testsDelta))
  const stepSamples = settled.filter((p) => Number.isFinite(p.stepsDelta))
  const testBias = testSamples.length ? Number((testSamples.reduce((a, p) => a + p.testsDelta, 0) / testSamples.length).toFixed(1)) : null
  const stepBias = stepSamples.length ? Number((stepSamples.reduce((a, p) => a + p.stepsDelta, 0) / stepSamples.length).toFixed(1)) : null
  return {
    samples: settled.length,
    riskSamples: riskSamples.length,
    outcomeSamples: outcomeSamples.length,
    sufficient: true,
    filePrecision: precision,
    fileRecall: recall,
    scopeDriftRate: extra && (hit + extra) ? clamp01(extra / (hit + extra)) : (extra ? 1 : 0),
    avgDrift: drift,
    riskBias,
    riskEscalations,
    outcomeAccuracy,
    testBias,
    stepBias,
  }
}

/** §9 — bounded planning feedback built from real prediction errors. */
export function predictionsForPrompt(cwd = process.cwd(), { limit = 4, maxChars = 420 } = {}) {
  const cal = predictionCalibration(cwd)
  if (!cal.sufficient) return ""
  const settled = loadPredictions(cwd).filter((p) => p.settledAt).slice(-limit)
  const lines = []
  if (cal.filePrecision != null) lines.push(`file prediction precision ${(cal.filePrecision * 100).toFixed(0)}%${cal.fileRecall != null ? `, recall ${(cal.fileRecall * 100).toFixed(0)}%` : ""}`)
  if (cal.riskBias != null && cal.riskBias > 0) lines.push(`risk was UNDER-predicted ${cal.riskEscalations}/${cal.riskSamples ?? 0} time(s) — predict risk honestly, not optimistically`)  
  if (cal.scopeDriftRate > 0.25) lines.push(`scope drift ${(cal.scopeDriftRate * 100).toFixed(0)}% — keep changes inside the declared target files`)
  if (cal.testBias != null && cal.testBias > 0.5) lines.push(`tests ran ~+${cal.testBias} MORE than predicted — declare the real test scope up front`)
  if (cal.stepBias != null && cal.stepBias > 0.5) lines.push(`segments needed ~+${cal.stepBias} more steps than predicted — budget effort honestly`)
  const worst = settled
    .filter((p) => (p.driftScore ?? 0) >= 0.5 && (p.filesExtra?.length || p.filesMissed?.length || (p.riskDelta ?? 0) > 0))
    .slice(-2)
  for (const w of worst) {
    const bits = []
    if (w.filesExtra?.length) bits.push(`changed unpredicted: ${w.filesExtra.slice(0, 3).join(", ")}`)
    if (w.filesMissed?.length) bits.push(`left untouched: ${w.filesMissed.slice(0, 3).join(", ")}`)
    if ((w.riskDelta ?? 0) > 0) bits.push(`risk ended ${w.finalRisk} (predicted ${w.expectedRisk})`)
    if (bits.length) lines.push(`${w.nodeId ?? w.segmentId ?? w.id}: ${bits.join("; ")}`)
  }
  if (!lines.length) return ""
  return `--- prediction calibration (${cal.samples} settled) ---\n${lines.join("\n")}`.slice(0, maxChars)
}

/** Event/TUI formatting (bounded, honest). */
export function formatPrediction(p) {
  if (!p) return ""
  const files = (p.expectedFiles ?? []).slice(0, 4).join(", ")
  return `predict ${p.id}${p.nodeId ? ` node ${p.nodeId}` : ""}: ${p.expectedFiles?.length ?? 0} file(s)${files ? ` (${files})` : ""}, risk ${p.expectedRisk ?? "unknown"}, outcome ${p.expectedOutcome} [${p.derived}]`
}

export function formatSettlement(s) {
  if (!s) return ""
  const parts = []
  if (s.status != null) parts.push(s.status === "ok" ? "succeeded" : "errored")
  parts.push(`${s.actualFiles?.length ?? 0} file(s) actually changed`)
  if (s.filesHit?.length) parts.push(`${s.filesHit.length} predicted`)
  if (s.filesExtra?.length) parts.push(`${s.filesExtra.length} UNPREDICTED`)
  if (s.filesMissed?.length) parts.push(`${s.filesMissed.length} predicted-but-untouched`)
  if (s.riskDelta != null) parts.push(`risk ${s.expectedRisk}→${s.finalRisk} (${s.riskDelta >= 0 ? "+" : ""}${s.riskDelta})`)
  if (s.testsDelta != null) parts.push(`tests ${s.expectedTests}→${s.actualTests}`)
  if (s.stepsDelta != null) parts.push(`steps ${s.expectedSteps}→${s.actualSteps}`)
  if (s.outcomeCorrect != null) parts.push(s.outcomeCorrect ? "outcome as predicted" : "outcome MIS-PREDICTED")
  return `${s.id}: ${parts.join(", ")}`
}

/**
 * v102 intelwise — the default agent has no DAG node. Predict from
 * deterministic context (files named in the objective, files already read,
 * declared scope). Never from the model's self-reported confidence.
 */
export function filesMentionedIn(text) {
  const t = String(text || "")
  const out = []
  const re = /(?<![A-Za-z0-9_/])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,7})\b/g
  let m
  while ((m = re.exec(t))) {
    const f = m[1]
    if (!f || f.startsWith("http") || /^\d+\.\d+/.test(f)) continue
    if (!out.includes(f)) out.push(f)
  }
  return out.slice(0, MAX_PREDICTION_FILES)
}

export function expectedFilesFromContext({ objective = "", reads = [], writes = [], scope = [] } = {}) {
  const seen = new Set()
  const out = []
  const push = (f) => {
    const s = rel(String(f || "")).replace(/\\/g, "/").replace(/^\.\//, "")
    if (!s || s === "(shell write)" || seen.has(s)) return
    seen.add(s)
    out.push(s)
  }
  for (const f of filesMentionedIn(objective)) push(f)
  for (const f of Array.isArray(scope) ? scope : []) push(f)
  for (const f of Array.isArray(reads) ? reads : []) push(f)
  for (const f of Array.isArray(writes) ? writes : []) push(f)
  return out.slice(0, MAX_PREDICTION_FILES)
}

export function predictForAction({
  action = "EXECUTE",
  objective = "",
  expectedFiles = [],
  expectedRisk = null,
  expectedOutcome = "advance",
  expectedSteps = 1,
  taskId = null,
  reads = [],
  writes = [],
  scope = [],
} = {}) {
  const files = (Array.isArray(expectedFiles) && expectedFiles.length)
    ? expectedFiles.map(rel).filter(Boolean).slice(0, MAX_PREDICTION_FILES)
    : expectedFilesFromContext({ objective, reads, writes, scope })
  const pred = predictForNode({
    node: { id: `act-${String(action).slice(0, 24)}`, targetFiles: files, risk: expectedRisk },
    objective,
    expectedSteps,
    taskId,
  })
  pred.action = String(action).slice(0, 24)
  pred.expectedOutcome = PREDICTION_OUTCOMES.includes(expectedOutcome) ? expectedOutcome : "advance"
  pred.derived = files.length ? "targets" : "objective-only"
  return pred
}

export const DRIFT = {
  MATCH: "MATCH",
  SCOPE: "SCOPE",
  MISS: "MISS",
  UNSCORED: "UNSCORED",
}

/** How the governor should react to a settled prediction. Objective-only
 *  predictions cannot score file drift (that would treat "I named no files"
 *  as "I predicted zero files"). */
export function driftVerdict(settled) {
  if (!settled || settled.settledAt == null) {
    return { level: DRIFT.UNSCORED, action: null, why: "no settled prediction", driftScore: null }
  }
  if (settled.derived !== "targets") {
    return { level: DRIFT.UNSCORED, action: null, why: "objective-only prediction cannot score file drift", driftScore: settled.driftScore ?? null }
  }
  const d = Number(settled.driftScore)
  const score = Number.isFinite(d) ? d : 0
  if (score >= 0.75) {
    return { level: DRIFT.MISS, action: "REPLAN", why: "prediction missed reality — change hypothesis before another mutation", driftScore: score, extra: settled.filesExtra, missed: settled.filesMissed }
  }
  if (score >= 0.5) {
    return { level: DRIFT.SCOPE, action: "VERIFY", why: "scope drifted from the prediction — verify before more writes", driftScore: score, extra: settled.filesExtra, missed: settled.filesMissed }
  }
  return { level: DRIFT.MATCH, action: null, why: "prediction matched reality", driftScore: score }
}

