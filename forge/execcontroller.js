/**
 * forge — centralized ExecutionController (v94 "masterwise", §6/§7/§8/§9/§10/§29)
 *
 * ONE authoritative execution policy on top of the meta segment loop. The
 * loop in meta.js remains the executor (it owns agents, workers, DAG and
 * verification); this module owns the CONTROL DECISIONS around it:
 *
 *   - adaptive segment size (§8): segment budgets scale with task class,
 *     failure rate, resource pressure and tool latency. A segment boundary
 *     is NOT a task boundary.
 *   - stuck detection (§10): repeated tool signatures, repeated identical
 *     failures, and segments with no meaningful state change. Stuck is
 *     NEVER converted into completion — it produces DIAGNOSE → CHANGE
 *     STRATEGY → REPLAN → CONTINUE.
 *   - resource fuses (§29): resources.fuses() was computed but never
 *     enforced; the controller enforces it. `replan` fuses trigger a
 *     strategy change; the wall-clock fuse triggers CHECKPOINT → WAIT
 *     → (resumable). Resource pressure is NEVER completion.
 *   - continuation policy (§6): a segment budget that ends is telemetry —
 *     the controller's answer is always CONTINUE / REPLAN / WAIT, and only
 *     the completion gate (completion.js) may ever say COMPLETED.
 *
 * The controller is deterministic (no model calls), additive to the loop
 * (nothing existing is bypassed), and every decision it makes is emitted
 * as an event so the run log shows WHY the execution changed course.
 *
 * Zero dependencies.
 */

/** Bounded telemetry — the controller never grows unboundedly. */
const MAX_TRACKED_SIGNATURES = 256
const MAX_STUCK_EVENTS = 24

export const STUCK_REASON = {
  TOOL_LOOP: "tool_loop",               // same tool+argument signature repeated
  REPEAT_FAILURE: "repeat_failure",     // the same error, segment after segment
  NO_PROGRESS: "no_progress",           // no files, no node, no worker movement
}

/**
 * Base per-segment step budget by task class (classify.js classes).
 * v99 loopwise: the v98 table (MICRO 8 … ARCHITECTURAL 40, fallback 24) made
 * a healthy coding run surface a "stopped at the step budget" event every
 * ~25 steps — segments are a CHECKPOINT cadence, never a wall (meta always
 * continues on budgetHit), but the heartbeat was so tight the run spent more
 * effort observing than building. Bases are raised ~2x; the shrink factors
 * (failure/pressure/latency) and the floor are unchanged, so degrading runs
 * still converge to short, checkpoint-dense segments exactly as before.
 */
const CLASS_SEGMENT_BASE = {
  MICRO: 14,
  SMALL: 24,
  MEDIUM: 40,
  LARGE: 60,
  ARCHITECTURAL: 88,
  RECOVERY: 30,
}

export function createExecutionController({
  config = null,
  taskId = null,
  runId = null,
  cwd = process.cwd(),
  onEvent = null,
  resources = null,
  signal = null,
} = {}) {
  const emit = (e) => { try { onEvent?.(e) } catch { /* telemetry never breaks execution */ } }

  const state = {
    segments: 0,
    noProgressStreak: 0,
    lastErrorKey: null,
    repeatErrorStreak: 0,
    toolSigs: new Map(),   // signature -> count (bounded)
    stuckEvents: [],       // bounded history of stuck detections
    fuseReplansDone: 0,
    lastFuseActionSegment: -1,
    strategyEscapes: 0,
  }

  const snap = () => ({
    segments: state.segments,
    noProgressStreak: state.noProgressStreak,
    repeatErrorStreak: state.repeatErrorStreak,
    trackedSignatures: state.toolSigs.size,
    stuckEvents: state.stuckEvents.length,
    fuseReplansDone: state.fuseReplansDone,
    strategyEscapes: state.strategyEscapes,
  })

  /**
   * §8 — adaptive segment size. Deterministic from observable facts:
   * task class, failure rate, resource pressure, tool latency. Never a
   * model decision; never wider than the safety clamps.
   */
  const segmentSize = ({ klass = null, failureRate = 0, pressureLevel = "nominal", avgToolLatencyMs = 0 } = {}) => {
    let steps = CLASS_SEGMENT_BASE[klass] ?? 40
    // failing strategies get SHORTER segments: checkpoints and strategy
    // changes arrive sooner (bounded shrink, never below the floor)
    if (failureRate > 0) steps *= 1 - Math.min(0.4, failureRate * 0.8)
    if (pressureLevel === "adapting") steps *= 0.75
    else if (pressureLevel === "watch") steps *= 0.9
    if (avgToolLatencyMs > 15000) steps *= 0.7
    else if (avgToolLatencyMs > 8000) steps *= 0.85
    return Math.max(8, Math.min(128, Math.round(steps)))
  }

  /**
   * §10 — tool signature tracking. A signature is tool + normalized primary
   * argument. The same signature repeating across segments is a loop signal
   * (the existing per-run dedupe in agent.js shrinks CONTEXT, it does not
   * detect loops — this does).
   */
  const observeToolCalls = (records = []) => {
    let loop = null
    for (const r of records || []) {
      if (!r) continue
      const name = String(r.tool ?? r.name ?? "")
      if (!name) continue
      let argsKey = ""
      try {
        const a = r.args ?? r.arguments ?? null
        argsKey = a ? JSON.stringify(a).slice(0, 120) : String(r.target ?? r.command ?? "").slice(0, 120)
      } catch { argsKey = "" }
      const sig = `${name}:${argsKey}`
      let n = state.toolSigs.get(sig) ?? 0
      n++
      state.toolSigs.set(sig, n)
      if (state.toolSigs.size > MAX_TRACKED_SIGNATURES) {
        const oldest = state.toolSigs.keys().next().value
        state.toolSigs.delete(oldest)
      }
      // 4 identical calls is a loop; 4 read-only inspections might be lazy,
      // but the cost of a strategy nudge is lower than the cost of spinning.
      if (n === 4 && !loop) loop = { signature: sig.slice(0, 200), count: n }
    }
    return { loop }
  }

  const noteStuck = (reason, detail) => {
    const ev = { reason, detail: String(detail ?? "").slice(0, 300), segment: state.segments, at: Date.now() }
    state.stuckEvents.push(ev)
    if (state.stuckEvents.length > MAX_STUCK_EVENTS) state.stuckEvents.shift()
    state.strategyEscapes++
    emit({
      type: "STUCK_DETECTED", taskId, runId,
      reason, detail: ev.detail, segment: state.segments,
      text: `stuck detected (${reason}) — diagnose, change strategy, replan, continue; never complete`,
    })
    return ev
  }

  /**
   * §6/§9/§10 — observe one finished segment, decide the next control move.
   * Returns { action: "continue"|"replan", stuck: null|{reason,detail}, snapshot }.
   * There is deliberately NO "complete" action: completion belongs to the gate.
   */
  const observeSegment = ({
    segment = 0,
    budgetHit = false,
    error = null,
    filesChanged = 0,
    nodesCompleted = 0,
    nodesExecutionSucceeded = 0,
    workerCompletions = 0,
    toolRecords = [],
  } = {}) => {
    state.segments = Math.max(state.segments, segment)
    const segmentId = `seg-${segment}`

    // 1. tool loops (§10)
    const { loop } = observeToolCalls(toolRecords)

    // 2. repeated identical failures (§10) — same normalized error twice in a row
    let repeatFailure = null
    if (error) {
      const key = String(error).replace(/\s+/g, " ").trim().slice(0, 120)
      if (key === state.lastErrorKey) state.repeatErrorStreak++
      else { state.lastErrorKey = key; state.repeatErrorStreak = 1 }
      if (state.repeatErrorStreak >= 2) repeatFailure = { detail: key, streak: state.repeatErrorStreak }
    } else {
      state.lastErrorKey = null
      state.repeatErrorStreak = 0
    }

    // 3. no meaningful state change (§10): nothing mutated, no node advanced,
    //    no worker finished. Read-only research segments advance nodes, so
    //    they count as progress; a segment that only burns budget does not.
    const progressed = filesChanged > 0 || nodesCompleted > 0 || nodesExecutionSucceeded > 0 || workerCompletions > 0
    if (!error && !progressed) state.noProgressStreak++
    else if (progressed) state.noProgressStreak = 0
    const noProgress = state.noProgressStreak >= 3
      ? { detail: `${state.noProgressStreak} consecutive segments without any file, node or worker movement`, streak: state.noProgressStreak }
      : null

    let stuck = null
    if (loop) stuck = noteStuck(STUCK_REASON.TOOL_LOOP, `signature ${loop.signature} repeated ${loop.count}×`)
    else if (repeatFailure) stuck = noteStuck(STUCK_REASON.REPEAT_FAILURE, `same failure ${repeatFailure.streak} segments in a row: ${repeatFailure.detail}`)
    else if (noProgress) stuck = noteStuck(STUCK_REASON.NO_PROGRESS, noProgress.detail)

    if (stuck && !error) {
      emit({ type: "SEGMENT_STUCK", taskId, runId, segment, segmentId, reason: stuck.reason, detail: stuck.detail })
    }

    // budget end is ALWAYS a continue — the segment loop owns that transition;
    // the controller records it as telemetry, never as a completion condition.
    if (budgetHit) emit({ type: "SEGMENT_BUDGET_TELEMETRY", taskId, runId, segment, segmentId, note: "segment budget ended — checkpoint/observe/continue, never complete" })

    const action = stuck && !error ? "replan" : "continue"
    return { action, stuck, snapshot: snap() }
  }

  /**
   * §29 — enforce the resource fuses that used to be advisory-only.
   *   failure_rate / recovery_loop → REPLAN (strategy change, keep going)
   *   wall_clock → CHECKPOINT → WAIT (resumable; NEVER completion)
   * Returns { action: "none"|"replan"|"checkpoint_wait", fuse?, why? }.
   */
  const enforceFuses = (fuses = [], { segment = 0 } = {}) => {
    const list = Array.isArray(fuses) ? fuses : []
    if (!list.length || segment === state.lastFuseActionSegment) return { action: "none" }
    const wait = list.find((f) => f?.action === "checkpoint_and_wait")
    const replan = list.find((f) => f?.action === "replan")
    if (wait) {
      state.lastFuseActionSegment = segment
      emit({ type: "RESOURCE_FUSE_ENFORCED", taskId, runId, segment, fuse: wait.fuse, value: wait.value, decision: "checkpoint_wait", why: wait.why, text: "resource fuse: checkpoint and wait — never completion" })
      return { action: "checkpoint_wait", fuse: wait.fuse, why: wait.why }
    }
    if (replan) {
      state.lastFuseActionSegment = segment
      state.fuseReplansDone++
      emit({ type: "RESOURCE_FUSE_ENFORCED", taskId, runId, segment, fuse: replan.fuse, value: replan.value, decision: "replan", why: replan.why, text: "resource fuse: change strategy and replan — never completion" })
      return { action: "replan", fuse: replan.fuse, why: replan.why }
    }
    return { action: "none" }
  }

  return {
    segmentSize,
    observeSegment,
    observeToolCalls,
    enforceFuses,
    noteStuck,
    snapshot: snap,
    /** introspection for tests */
    _state: state,
  }
}
