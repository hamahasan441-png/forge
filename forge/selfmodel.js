/**
 * forge — self model (v103 learnwise, zero dependencies)
 *
 * Not a personality. Not a claim of competence.
 * What THIS installation has been measured to get right and wrong:
 *   - prediction calibration (scope drift, outcome accuracy, risk bias)
 *   - model empirics (success rate, samples — never auto-switch)
 *   - rejected strategies the user already closed
 *
 * Insufficient evidence is said out loud. A hunch is not a self-model.
 */
import { predictionCalibration } from "./prediction.js"
import { pickModelEmpiric, formatEmpiric } from "./empirics.js"

export const SELF_VERSION = "1.0.0"

export function createSelfModel({ cwd = process.cwd(), env = process.env } = {}) {
  function snapshot() {
    let cal = { samples: 0, sufficient: false, note: "insufficient evidence for prediction calibration" }
    try { cal = predictionCalibration(cwd) } catch { /* ledger may not exist yet */ }
    let models = []
    try { models = pickModelEmpiric({ env, limit: 5 }) } catch { models = [] }
    const strengths = []
    const weaknesses = []
    if (cal.sufficient) {
      if ((cal.outcomeAccuracy ?? 0) >= 0.7) strengths.push("outcome prediction holds")
      if ((cal.filePrecision ?? 0) >= 0.7) strengths.push("file-target prediction holds")
      if ((cal.avgDrift ?? 1) <= 0.3) strengths.push("scope stays inside the predicted set")
      if ((cal.avgDrift ?? 0) >= 0.5) weaknesses.push("scope drift — inspect targets before mutating")
      if ((cal.riskBias ?? 0) > 0) weaknesses.push("risk is under-predicted — do not plan optimistically")
      if ((cal.outcomeAccuracy ?? 1) < 0.5) weaknesses.push("outcome predictions miss — change hypothesis after a miss, do not retry")
    }
    const weakModel = models.find((m) => (m.samples ?? 0) >= 3 && (m.rate ?? 1) < 0.5)
    if (weakModel) weaknesses.push(`measured: ${weakModel.model} succeeds ${Math.round((weakModel.rate || 0) * 100)}% (n=${weakModel.samples}) — consider a better-measured model, do not auto-switch`)
    return {
      version: SELF_VERSION,
      calibrated: !!cal.sufficient,
      samples: cal.samples ?? 0,
      avgDrift: cal.avgDrift ?? null,
      outcomeAccuracy: cal.outcomeAccuracy ?? null,
      filePrecision: cal.filePrecision ?? null,
      riskBias: cal.riskBias ?? null,
      models,
      strengths,
      weaknesses,
      note: cal.sufficient ? null : "insufficient evidence for self-assessment",
    }
  }

  function advise({ klass = "SMALL", driftLevel = null, currentModel = null } = {}) {
    const s = snapshot()
    const lines = []
    if (s.note) lines.push(s.note)
    for (const w of s.weaknesses) lines.push(w)
    if (driftLevel === "MISS") lines.push("last prediction missed — change hypothesis, do not retry the same patch")
    if ((klass === "ARCHITECTURAL" || klass === "LARGE") && !s.calibrated) {
      lines.push("no calibration yet — inspect reality before the first mutation")
    }
    let recommend = null
    if (s.models[0] && (s.models[0].samples ?? 0) >= 3 && (s.models[0].rate ?? 0) >= 0.7) {
      recommend = s.models[0]
      if (currentModel && s.models[0].model !== currentModel) {
        lines.push(`measured better model ${s.models[0].model} (${Math.round(s.models[0].rate * 100)}%, n=${s.models[0].samples}) — recommend, do not auto-switch`)
      }
    }
    return { snapshot: s, lines, recommend, autoSwitch: false }
  }

  function formatForPrompt({ klass = "SMALL", driftLevel = null, currentModel = null } = {}) {
    const a = advise({ klass, driftLevel, currentModel })
    const s = a.snapshot
    const lines = ["SELF-MODEL (measured, not claimed):"]
    if (!s.calibrated) {
      lines.push(`- ${s.note}`)
    } else {
      lines.push(`- calibration n=${s.samples} drift=${s.avgDrift ?? "?"} accuracy=${s.outcomeAccuracy ?? "?"}`)
      if (s.strengths.length) lines.push(`- holds: ${s.strengths.join("; ")}`)
      if (s.weaknesses.length) lines.push(`- fails: ${s.weaknesses.join("; ")}`)
    }
    const emp = formatEmpiric(s.models)
    if (emp) lines.push(`- ${emp}`)
    lines.push("- never auto-switch models; never treat confidence as evidence")
    return lines.join("\n")
  }

  return { snapshot, advise, formatForPrompt, version: SELF_VERSION }
}
