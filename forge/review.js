/**
 * forge — adversarial review (∞, zero dependencies)
 *
 * LARGE and ARCHITECTURAL work gets a checklist before COMPLETED. This is
 * not another model call — call-count tests stay stable and a second agent
 * cannot "review" by agreeing with itself. The checklist is deterministic
 * and emits REVIEW_STARTED / REVIEW_COMPLETED for the HUD.
 *
 * Findings are warnings. Blockers refuse completion (via required actions).
 */
import { TASK_CLASS } from "./classify.js"
import { TAG } from "./taskmodel.js"

export const REVIEW_CHECK = {
  OBJECTIVE_COVERED: "objective_covered",
  BLAST_RADIUS: "blast_radius",
  TESTS_MATCH_IMPACT: "tests_match_impact",
  NO_ASSUMPTION_AS_REQUIREMENT: "no_assumption_as_requirement",
  SECRETS_UNTOUCHED: "secrets_untouched",
  VERIFICATION_PRESENT: "verification_present",
  UNKNOWN_IMPACT: "unknown_impact",
  ROLLBACK_POSSIBLE: "rollback_possible",
}

const SECRET_HINT = /(?:^|[\\/])(\.env(?:\..+)?|credentials|\.pem|\.p12|id_rsa|id_ed25519|\.netrc|\.npmrc)$/i

export function needsReview(klass) {
  return klass === TASK_CLASS.LARGE || klass === TASK_CLASS.ARCHITECTURAL
}

/**
 * @param {{
 *   klass, objective, files, impact, taskModel, hypotheses, causal,
 *   verificationOk, checkpoint
 * }} input
 * @returns {{ required, ok, findings, blockers, checks }}
 */
export function adversarialReview(input = {}) {
  const klass = input.klass
  if (!needsReview(klass)) {
    return { required: false, ok: true, findings: [], blockers: [], checks: [], klass: klass || null }
  }

  const findings = []
  const blockers = []
  const checks = []
  const note = (id, { ok, blocker = false, detail = "" }) => {
    checks.push({ id, ok, blocker, detail: String(detail).slice(0, 240) })
    if (ok) return
    const rec = { id, detail: String(detail).slice(0, 240) }
    if (blocker) blockers.push(rec)
    else findings.push(rec)
  }

  const files = (input.files || []).map(String)
  const impact = input.impact || {}
  const objective = String(input.objective ?? "")
  const snapshot = typeof input.taskModel?.snapshot === "function" ? input.taskModel.snapshot() : []

  note(REVIEW_CHECK.OBJECTIVE_COVERED, {
    ok: objective.trim().length > 0,
    detail: objective.trim() ? "objective present" : "empty objective",
  })

  const secretHits = files.filter((f) => SECRET_HINT.test(f) || /(^|[\\/])\.ssh[\\/]/.test(f))
  note(REVIEW_CHECK.SECRETS_UNTOUCHED, {
    ok: secretHits.length === 0,
    blocker: secretHits.length > 0,
    detail: secretHits.length ? `secret-bearing path touched: ${secretHits.slice(0, 3).join(", ")}` : "no secret paths in the change set",
  })

  const assumptions = snapshot.filter((i) => i.tag === TAG.ASSUMPTION)
  const smuggled = assumptions.filter((i) => /must|required|acceptance|shall/i.test(i.text))
  note(REVIEW_CHECK.NO_ASSUMPTION_AS_REQUIREMENT, {
    ok: smuggled.length === 0,
    blocker: smuggled.length > 0,
    detail: smuggled.length ? `assumption spoken as a requirement: ${smuggled[0].text}` : "no assumption promoted to a requirement",
  })

  const radius = Number(impact.radius) || files.length
  const tests = Array.isArray(impact.tests) ? impact.tests : []
  const scope = Array.isArray(impact.scope) ? impact.scope : []
  const wide = radius >= 8 || (impact.importers || []).length >= 8
  note(REVIEW_CHECK.BLAST_RADIUS, {
    ok: true,
    detail: `radius=${radius} importers=${(impact.importers || []).length} tests=${tests.length}`,
  })
  if (wide && !scope.includes("regression_test") && !scope.includes("integration")) {
    note(REVIEW_CHECK.TESTS_MATCH_IMPACT, {
      ok: false,
      detail: "wide blast radius without regression/integration in the testing scope",
    })
  } else {
    note(REVIEW_CHECK.TESTS_MATCH_IMPACT, {
      ok: true,
      detail: scope.length ? scope.join(" → ") : "scope not yet measured",
    })
  }

  if (klass === TASK_CLASS.ARCHITECTURAL && tests.length === 0 && files.length > 0) {
    note(REVIEW_CHECK.VERIFICATION_PRESENT, {
      ok: false,
      detail: "architectural change with no discovered tests in the impact radius",
    })
  } else {
    note(REVIEW_CHECK.VERIFICATION_PRESENT, {
      ok: input.verificationOk !== false,
      detail: input.verificationOk === false ? "verification not satisfied" : "verification flag accepted",
    })
  }

  note(REVIEW_CHECK.UNKNOWN_IMPACT, {
    ok: impact.unknown !== true,
    detail: impact.unknown ? "impact walk was UNKNOWN — do not treat 'no dependents' as proof" : "impact walk completed",
  })

  note(REVIEW_CHECK.ROLLBACK_POSSIBLE, {
    ok: true,
    detail: input.checkpoint ? `checkpoint ${String(input.checkpoint).slice(0, 40)}` : "no checkpoint recorded (advisory)",
  })

  return {
    required: true,
    ok: blockers.length === 0,
    findings,
    blockers,
    checks,
    klass,
  }
}

export function formatReview(rev) {
  if (!rev || !rev.required) return ""
  const bits = [`[forge] review=${rev.ok ? "ok" : "block"} class=${rev.klass}`]
  if (rev.blockers?.length) bits.push(`blockers: ${rev.blockers.map((b) => b.id).join(", ")}`)
  if (rev.findings?.length) bits.push(`findings: ${rev.findings.map((f) => f.id).join(", ")}`)
  return bits.join(" • ")
}
