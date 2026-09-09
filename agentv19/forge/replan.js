/**
 * forge — mid-task replan policy (v28, zero dependencies)
 *
 * Cycle replan already lives in meta.js (PLAN_CYCLE_DETECTED). This module
 * is the OTHER replan: verification evidence says the remaining DAG is
 * wrong, so rewrite the unfinished part and keep completed nodes.
 *
 * MICRO/SMALL never replan (fast path). At most once (twice on 8-core
 * burst). Does not talk to a model or the filesystem — meta owns the call.
 */
import { TASK_CLASS } from "./classify.js"

export function maxReplans(profile = null) {
  if (profile?.burst) return 2
  return 1
}

/**
 * Should the controller rewrite the remaining DAG?
 *
 * Triggers:
 *   - two failed repairs or two consecutive failed segments (the plan is
 *     the common cause)
 *   - omega escalate after at least one repair (rejected cause / FORGE origin)
 *
 * Never: MICRO/SMALL, or after the replan cap.
 */
export function shouldReplan({
  klass,
  repairCount = 0,
  consecutiveFailures = 0,
  replanCount = 0,
  profile = null,
  escalate = false,
} = {}) {
  const k = String(klass || "")
  if (k === TASK_CLASS.MICRO || k === TASK_CLASS.SMALL) return false
  if (replanCount >= maxReplans(profile)) return false
  if (escalate && (repairCount >= 1 || consecutiveFailures >= 1)) return true
  if (repairCount >= 2 || consecutiveFailures >= 2) return true
  return false
}

/** Planner prompt: keep completed work, do not repeat failed steps. */
export function replanPrompt({
  objective,
  reason = "",
  evidence = "",
  completed = [],
  failed = [],
  lessons = "",
  avoided = [],
  causal = "",
} = {}) {
  const lines = [
    String(objective ?? "").trim() || "task",
    "",
    "The current plan is NOT working. Rewrite ONLY the remaining work as a numbered list (one action per line, 3-8 steps). Mark read-only investigation vs implementation. Do NOT execute.",
  ]
  if (reason) lines.push("", `Why we are re-planning: ${String(reason).slice(0, 400)}`)
  if (evidence) lines.push(`Evidence: ${String(evidence).slice(0, 400)}`)
  if (causal) lines.push(`Causal target: ${String(causal).slice(0, 240)}`)
  if (completed.length) {
    lines.push("", "ALREADY DONE (you may depend on these ids, do not redo them):")
    for (const n of completed.slice(0, 12)) {
      lines.push(`- ${n.id}: ${String(n.objective ?? n.title ?? "").slice(0, 160)}`)
    }
  } else {
    lines.push("", "Nothing is verified complete yet — produce a fresh plan.")
  }
  if (failed.length) {
    lines.push("", "THESE STEPS FAILED (do not repeat them as-is):")
    for (const n of failed.slice(0, 8)) {
      const err = n.error || n.repair_reason || ""
      lines.push(`- ${n.id}: ${String(n.objective ?? "").slice(0, 140)}${err ? ` — ${String(err).slice(0, 120)}` : ""}`)
    }
  }
  if (lessons) lines.push("", String(lessons).slice(0, 1200))
  if (avoided.length) {
    lines.push("", `Do NOT repeat these previously-ineffective approaches: ${avoided.slice(0, 6).join("; ")}`)
  }
  lines.push("", "Use new step numbers. A step may only depend on steps that come strictly before it, or on an ALREADY DONE id.")
  return lines.join("\n")
}

/** Compact planner prefix from lessonsForPlan() — also used on the FIRST plan. */
export function planLessonsPrefix(planLessons) {
  if (!planLessons) return ""
  const parts = []
  if (planLessons.text) parts.push(String(planLessons.text).slice(0, 1200))
  if (planLessons.avoided?.length) {
    parts.push(`Do NOT repeat these previously-ineffective approaches: ${planLessons.avoided.slice(0, 6).join("; ")}`)
  }
  return parts.join("\n")
}
