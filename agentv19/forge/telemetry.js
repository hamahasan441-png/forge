/**
 * forge — process-local telemetry (∞, zero dependencies)
 *
 * Counters only. No network, no files, no PII. The HUD and tests read
 * snapshot(); the kernel increments. Names are dotted (origin.forge).
 */
export const METRIC = {
  CLASSIFY: "classify",
  REPAIR: "repair",
  REVIEW: "review",
  CAUSAL: "causal",
  ORIGIN_FORGE: "origin.forge",
  ORIGIN_PROJECT: "origin.project",
  ORIGIN_UNKNOWN: "origin.unknown",
  LOOP_ESCALATE: "repair.loop_escalate",
  COMMAND_FAIL: "command.fail",
  COMMAND_OK: "command.ok",
  RECOVERY: "classify.recovery",
}

export function createTelemetry() {
  const counts = Object.create(null)

  function inc(name, n = 1) {
    const k = String(name || "")
    if (!k) return 0
    const add = Number(n)
    counts[k] = (counts[k] || 0) + (Number.isFinite(add) ? add : 1)
    return counts[k]
  }

  function get(name) {
    return counts[String(name)] || 0
  }

  function snapshot() {
    return { ...counts }
  }

  function reset() {
    for (const k of Object.keys(counts)) delete counts[k]
  }

  return { inc, get, snapshot, reset }
}
