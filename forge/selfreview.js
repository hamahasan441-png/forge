/**
 * forge — agent self-review (v91 ∞ CORE §34, zero dependencies)
 *
 * Before reporting success, every worker must interrogate its own result:
 *
 *   Did I solve the actual objective?        — objectiveCoverage
 *   Did I inspect sufficient context?        — contextDepth
 *   Did I make assumptions?                  — assumptions
 *   Did I produce evidence?                  — evidence
 *   Did I introduce regressions?             — regressions
 *   Is the result verified?                  — verification
 *   What remains uncertain?                  — uncertainty
 *
 * The review is DETERMINISTIC (it scores the shape of the report against the
 * facts the runner knows), so it cannot be talked out of by the model. A
 * report with unverifiable claims gets low confidence and explicit uncertainty
 * — uncertainty is reported upward, never hidden (§34).
 *
 * Empty/failed results can never pass: a worker with no evidence is not a
 * success, it is an observation of failure.
 */

export const REVIEW_QUESTION_KEYS = [
  "objectiveCoverage",
  "contextDepth",
  "assumptions",
  "evidence",
  "regressions",
  "verification",
  "uncertainty",
]

/** Confidence weight per question (sums to 1). */
const WEIGHTS = {
  objectiveCoverage: 0.28,
  contextDepth: 0.12,
  assumptions: 0.08,
  evidence: 0.22,
  regressions: 0.12,
  verification: 0.14,
  uncertainty: 0.04,
}

const UNCERTAIN_MARKERS = /\b(uncertain|unsure|not sure|may not|might not|possibly|probably|unverified|assumed|guess|cannot confirm|couldn't confirm|didn't check|not checked|unknown)\b/i
const CLAIM_MARKERS = /\b(fixed|solved|done|completed|implemented|added|removed|updated|refactored|renamed|migrated|works now|passes)\b/i
const EVIDENCE_MARKERS = /\b(test[s]?( ran| passed| fail)|exit code|output:|build (passed|failed)|verified|diff|changed|created|lint|typecheck|assert|expect)\b/i

/**
 * Score a worker result.
 *
 * @param {object} input
 *   objective        the mission text the worker was given
 *   result           the worker's report text ("" when it produced nothing)
 *   ok               did the runner finish without error
 *   toolCalls        how many tool calls the worker made (0 = inspected nothing)
 *   filesTouched     files the worker reports touching
 *   evidenceCount    how many evidence records the run produced
 *   verification     "verified" | "unverified" | "failed" | "not_required"
 *   durationMs       wall-clock
 */
export function reviewWorkerResult({
  objective = "", result = "", ok = false,
  toolCalls = 0, filesTouched = 0, evidenceCount = 0,
  verification = "unverified", durationMs = 0,
} = {}) {
  const text = String(result ?? "")
  const obj = String(objective ?? "")
  const answered = {}

  // 1. objectiveCoverage — did the report engage with the actual objective?
  //    Empty result or a report that never addresses the objective fails.
  if (!text.trim()) {
    answered.objectiveCoverage = 0
  } else {
    const objTokens = new Set(String(obj).toLowerCase().match(/[a-z][a-z0-9_.-]{2,}/g) ?? [])
    const reportTokens = new Set(text.toLowerCase().match(/[a-z][a-z0-9_.-]{2,}/g) ?? [])
    let overlap = 0
    for (const t of objTokens) if (reportTokens.has(t)) overlap++
    const coverage = objTokens.size ? overlap / objTokens.size : 0.5
    const claimsWork = CLAIM_MARKERS.test(text)
    answered.objectiveCoverage = Math.max(0, Math.min(1, (claimsWork ? 0.4 : 0) + 0.6 * coverage))
  }

  // 2. contextDepth — did it actually inspect anything? A zero-tool report is
  //    a guess, not engineering (zero-inspection success is suspicious).
  answered.contextDepth = toolCalls <= 0 ? 0 : toolCalls === 1 ? 0.4 : toolCalls <= 3 ? 0.7 : 1

  // 3. assumptions — explicit assumptions are FINE and honest; unstated ones
  //    are the risk. We reward an explicit assumptions/limits section.
  const declaresAssumptions = /\b(assumption|assuming|caveat|limitation|note that)\b/i.test(text)
  answered.assumptions = declaresAssumptions ? 1 : text.trim() ? 0.5 : 0

  // 4. evidence — did it produce checkable facts?
  answered.evidence = evidenceCount > 0 ? 1 : EVIDENCE_MARKERS.test(text) ? 0.6 : 0

  // 5. regressions — did it consider side effects? (files/impact awareness)
  const considersImpact = /\b(regression|side effect|affected|also update|breaks|blast|dependenc)/i.test(text)
  answered.regressions = filesTouched > 0 ? (considersImpact ? 1 : 0.6) : 0.8

  // 6. verification — the only strong signal.
  answered.verification = verification === "verified" ? 1 : verification === "not_required" ? 0.7 : verification === "failed" ? 0 : 0.2

  // 7. uncertainty — honest uncertainty is REQUIRED, hidden uncertainty is a
  //    defect. A report full of unflagged claims about complex work scores
  //    lower than one that names what it could not confirm.
  const flagsUncertainty = UNCERTAIN_MARKERS.test(text)
  answered.uncertainty = flagsUncertainty ? 1 : text.length > 200 ? 0.5 : 0.8

  // overall confidence — runner failure caps it hard
  let confidence = 0
  for (const k of REVIEW_QUESTION_KEYS) confidence += WEIGHTS[k] * (answered[k] ?? 0)
  if (!ok) confidence = Math.min(confidence, 0.15)
  if (verification === "failed") confidence = Math.min(confidence, 0.2)

  const flags = []
  if (answered.objectiveCoverage < 0.3) flags.push("report does not clearly address the objective")
  if (toolCalls <= 0 && obj.length > 0) flags.push("no inspection happened (zero tool calls)")
  if (evidenceCount <= 0 && !EVIDENCE_MARKERS.test(text)) flags.push("no evidence produced")
  if (verification === "unverified" && CLAIM_MARKERS.test(text)) flags.push("claims completion without verification")
  if (!text.trim()) flags.push("empty result")

  const uncertainties = extractUncertainties(text)
  const pass = flags.length === 0 && confidence >= 0.55 && ok

  return {
    ok: pass,
    confidence: Math.round(confidence * 100) / 100,
    answered,
    flags,
    uncertainties,
    questions: REVIEW_QUESTION_KEYS,
  }
}

/** Pull the explicit "what remains uncertain" items out of a report. */
export function extractUncertainties(text) {
  const out = []
  for (const raw of String(text ?? "").split(/\n+/)) {
    const line = raw.trim().replace(/^[-*\d.)\s]+/, "")
    if (line && UNCERTAIN_MARKERS.test(line) && line.length < 300) out.push(line.slice(0, 300))
    if (out.length >= 5) break
  }
  return out
}

/** One-block summary for the worker record / TUI. */
export function formatSelfReview(review) {
  if (!review) return ""
  const lines = [`self-review: ${review.ok ? "PASS" : "FLAGS"} (confidence ${review.confidence})`]
  for (const f of review.flags) lines.push(`  ! ${f}`)
  for (const u of review.uncertainties) lines.push(`  ? ${u}`)
  return lines.join("\n")
}
