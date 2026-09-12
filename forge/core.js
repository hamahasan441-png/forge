/**
 * forge — FORGE CORE (v91 ∞ CORE §1/§2/§94, zero dependencies)
 *
 * The Core is the orchestration and INTELLIGENCE layer around the existing
 * implementation — not a second task loop. meta.js remains the authoritative
 * executor (§97: never duplicate a working system); the Core:
 *
 *   1. OWNS the shared subsystems and wires them into one coherent whole:
 *      Task Runtime · World Model · Memory/Episodes · Decision Engine ·
 *      Communication Bus · Handoff Ledger · Crew Router · Conflict
 *      Resolution · Resource Governor · Evidence/Verification/Completion
 *      (through meta's existing gates).
 *   2. EXPOSES the unified lifecycle (§2) as a first-class, inspectable
 *      phase machine that mirrors what meta actually does:
 *        UNDERSTAND → DISCOVER → PLAN → DECOMPOSE(DAG) → ALLOCATE →
 *        DELEGATE → EXECUTE → OBSERVE → COLLECT EVIDENCE → VERIFY →
 *        REVIEW → REPLAN? → PERSIST → CONTINUE → COMPLETE
 *      plus failure (DIAGNOSE→…→REPAIR) and crash (RECOVER→RESUME) flows.
 *   3. PROVIDES introspection for the Premium TUI: live dashboard state,
 *      crew view, communication view, verification view, resource view,
 *      decision panel — one status() call.
 *
 * The Core never widens a security boundary and never fakes a phase: phases
 * are recorded from REAL meta events, not from a wishful state machine.
 */
import { createBus, MESSAGE_TYPE } from "./bus.js"
import { createHandoffLedger } from "./handoff.js"
import { createDecisionEngine, DECISION_STATUS } from "./decisionengine.js"
import { createWorldModel } from "./worldmodel.js"
import { createEpisodeStore, EPISODE_RESULT } from "./episodes.js"
import { createCrewRouter } from "./crewroute.js"
import { reviewWorkerResult, formatSelfReview } from "./selfreview.js"
import { reportConflict, resolveConflict, CONFLICT_STATUS } from "./crewconflict.js"
import { createResourceManager } from "./resources.js"
import { TASK_STATUS } from "./taskstate.js"
import { openTask } from "./taskstate.js"

/** §2 — the unified execution lifecycle, in order. */
export const CORE_PHASES = [
  "UNDERSTAND", "DISCOVER", "PLAN", "DECOMPOSE", "ALLOCATE",
  "DELEGATE", "EXECUTE", "OBSERVE", "COLLECT_EVIDENCE", "VERIFY",
  "REVIEW", "REPLAN", "PERSIST", "CONTINUE", "COMPLETE",
  // failure / crash flows
  "DIAGNOSE", "REPAIR", "RECOVER", "RESUME",
]

/** Meta events → lifecycle phases (§2). Truth comes from real events only. */
const EVENT_PHASE = {
  TASK_CREATED: "UNDERSTAND",
  TASK_STARTED: "UNDERSTAND",
  DISCOVERY: "DISCOVER",
  PLAN_STARTED: "PLAN",
  PLAN_READY: "PLAN",
  PLAN_COMPOSE: "PLAN",
  DAG_BUILT: "DECOMPOSE",
  DAG_UPDATED: "DECOMPOSE",
  SEGMENT_STARTED: "ALLOCATE",
  WORKER_QUEUED: "DELEGATE",
  WORKER_STARTED: "DELEGATE",
  WORKER_COMPLETED: "OBSERVE",
  TOOL_START: "EXECUTE",
  TOOL_END: "EXECUTE",
  CHECKPOINT: "PERSIST",
  VERIFY: "VERIFY",
  VERIFICATION: "VERIFY",
  REVIEW_STARTED: "REVIEW",
  REVIEW_COMPLETED: "REVIEW",
  REPLAN: "REPLAN",
  REPAIR_STARTED: "DIAGNOSE",
  REPAIR_COMPLETED: "REPAIR",
  RECOVERING: "RECOVER",
  TASK_RESUMED: "RESUME",
  COMPLETION_ATTEMPT: "COMPLETE",
  TASK_COMPLETED: "COMPLETE",
  TASK_FAILED: "COMPLETE",
  DECISION_REQUIRED: "WAIT_FOR_USER",
}

export function createForgeCore({
  config = {},
  provider = null,
  cwd = process.cwd(),
  onEvent = null,
  signal = null,
} = {}) {
  config = config && typeof config === "object" ? config : {}
  // --- shared subsystems (the Core owns the instances) --------------------
  const bus = createBus({ taskId: null, persist: false })
  bus.register("core", { kind: "core" })
  bus.register("crew", { kind: "crew" })
  const handoffs = createHandoffLedger()
  const episodes = createEpisodeStore({ cwd })
  const crewRouter = createCrewRouter({ cwd, config })
  const resources = createResourceManager({ config, cwd })
  const decisions = createDecisionEngine({
    cwd,
    onWait: (d) => {
      emit({ type: "DECISION_REQUIRED", decision: d })
      bus.send({ sender: "core", receiver: "*", type: MESSAGE_TYPE.REQUEST, content: `DECISION REQUIRED: ${d.title || d.key}`, priority: 3, requires_action: true })
    },
  })
  const world = createWorldModel({ cwd })
  const conflicts = []
  // lifecycle truth, recorded from real events
  const phaseHistory = []
  const currentPhase = { name: null, since: null }
  const stats = { segments: 0, workers: 0, verifications: 0, repairs: 0, decisions: 0, conflicts: 0, messages: 0 }
  let task = null
  let running = false
  let lastResult = null

  function emit(ev) {
    try { onEvent?.(ev) } catch { /* observability never breaks */ }
  }

  /** Record a phase from a REAL event (never speculative). */
  function recordPhase(phase, detail = null) {
    if (!phase) return
    const now = Date.now()
    if (currentPhase.name) {
      phaseHistory.push({ phase: currentPhase.name, ms: now - currentPhase.since })
      if (phaseHistory.length > 120) phaseHistory.shift()
    }
    currentPhase.name = phase
    currentPhase.since = now
    if (detail) currentPhase.detail = String(detail).slice(0, 200)
  }

  /** The event tap: wires meta/agent/worker events into Core intelligence. */
  function coreEventTap(ev = {}) {
    // 1. phase truth
    const phase = EVENT_PHASE[ev.type]
    if (phase) recordPhase(phase, ev.type)
    // 2. resource metrics
    if (ev.type === "TOOL_END") resources.record({ toolCalls: 1, latencyMs: ev.ms })
    if (ev.type === "MODEL_END" || ev.type === "AGENT_END") resources.record({ modelCalls: 1, latencyMs: ev.ms, tokensIn: ev.tokensIn, tokensOut: ev.tokensOut })
    if (ev.type === "CHECKPOINT") resources.record({ checkpoint: 1 })
    if (ev.type === "REPAIR_STARTED") resources.record({ failure: 1 })
    if (ev.type === "RECOVERY_DONE" || ev.type === "TASK_RESUMED") resources.record({ recovery: 1, recoveryCostMs: ev.ms })
    if (ev.type === "SEGMENT_STARTED") { stats.segments++; resources.record({ segment: 1, workers: ev.activeWorkers }) }
    if (ev.type === "VERIFY_PASSED" || ev.type === "VERIFICATION_PASSED") stats.verifications++
    if (ev.type === "REPAIR_COMPLETED") stats.repairs++
    // 3. crew performance memory (§37) + self-review confidence
    if (ev.type === "WORKER_COMPLETED") {
      stats.workers++
      crewRouter.record({
        role: ev.role, model: ev.model ?? null,
        ok: ev.ok === true, verified: ev.verified === true,
        latencyMs: ev.ms ?? 0, regressions: ev.regressions ? 1 : 0,
      })
    }
    // 4. mirror meaningful agent communication onto the bus (§27) so the TUI
    //    comm view and future agents see it — without inventing chatter
    if (ev.type === "DISCOVERY" || ev.type === "FINDING" || ev.type === "BLOCKED" || ev.type === "WARNING") {
      const m = bus.send({
        sender: ev.workerId ? `worker:${ev.workerId}` : (ev.role ? `${ev.role}:agent` : "agent:main"),
        receiver: "core",
        type: ev.type === "DISCOVERY" ? MESSAGE_TYPE.DISCOVERY : ev.type === "FINDING" ? MESSAGE_TYPE.FINDING : ev.type === "BLOCKED" ? MESSAGE_TYPE.BLOCKED : MESSAGE_TYPE.WARNING,
        content: ev.content ?? ev.text ?? ev.message ?? "",
        node_id: ev.nodeId ?? null,
        file_refs: ev.files ?? [],
        confidence: ev.confidence ?? 0.6,
      })
      if (m) stats.messages++
    }
    // 5. conflicts reported by the integrator become conflict records (§31)
    if (ev.type === "INTEGRATION_CONFLICT" && ev.claims) {
      const c = reportConflict(
        { claimant: ev.claims.a?.worker ?? "worker-a", claim: ev.claims.a?.text ?? "", evidence: ev.claims.a?.evidence ?? [] },
        { claimant: ev.claims.b?.worker ?? "worker-b", claim: ev.claims.b?.text ?? "", evidence: ev.claims.b?.evidence ?? [] },
        { topic: ev.claims.topic ?? ev.file ?? "overlapping change", taskId: ev.taskId, nodeId: ev.nodeId }
      )
      resolveConflict(c, { world: (claim) => null }) // evidence-only at this point
      conflicts.push(c)
      if (conflicts.length > 40) conflicts.shift()
      stats.conflicts++
      emit({ type: "CONFLICT_RESOLVED", conflict: c.status === CONFLICT_STATUS.RESOLVED ? { winner: c.resolution.winner, reason: c.resolution.reason } : { escalated: true, experiment: c.resolution?.suggestedExperiment } })
    }
    // 6. worker progress → bus (bounded)
    if (ev.type === "WORKER_PROGRESS" && ev.workerId) {
      bus.send({ sender: `worker:${ev.workerId}`, receiver: "crew", type: MESSAGE_TYPE.PROGRESS, content: ev.note ?? "", priority: 0 })
    }
    // 7. decision resolution → continue
    if (ev.type === "DECISION_RESOLVED") stats.decisions++
    // always forward to the original listener
    emit(ev)
  }

  /**
   * Run an objective through the whole system (delegates execution to meta).
   * This is the §2 loop made real: meta drives, the Core coordinates,
   * observes, remembers and proves.
   */
  async function run(objective, { resumeTaskId = null, deep = null, segmentSteps = null, maxSegments = null, runAgent = null, pluginStartedAt = null } = {}) {
    if (running) throw new Error("core is already running a task")
    running = true
    const t0 = Date.now()
    const ep = episodes.start({
      problem: String(objective ?? "").slice(0, 1200),
      context: world.summarize({ maxLines: 8 }),
      taskId: resumeTaskId,
      files: [],
    })
    try {
      const { runMeta } = await import("./meta.js")
      const result = await runMeta({
        config, provider, task: objective,
        onEvent: coreEventTap, signal,
        resumeTaskId, segmentSteps, maxSegments, deep, runAgent, pluginStartedAt,
      })
      lastResult = result
      // close the episode with what actually happened (§78)
      const verified = Boolean(result?.verification?.ok ?? result?.completionGate?.ok)
      const succeeded = result?.status === "COMPLETED"
      episodes.setReview(ep, result?.completionGate ? `gate: ${result.completionGate.ok ? "ok" : `blocked: ${(result.completionGate.blockers ?? []).slice(0, 3).join("; ")}`}` : null)
      episodes.setLesson(ep, succeeded
        ? `Completed via ${result?.segments ?? 0} segment(s), ${result?.repairs ?? 0} repair(s). Strategy worked.`
        : `Ended ${result?.status}: ${String(result?.text ?? "").slice(0, 200)}`,
        { result: succeeded ? (verified ? EPISODE_RESULT.SUCCESS : EPISODE_RESULT.PARTIAL) : EPISODE_RESULT.FAILED })
      if (Array.isArray(result?.filesChanged)) for (const f of result.filesChanged.slice(0, 10)) episodes.addFix(ep, `touched ${f}`)
      task = result?.task ?? null
      return result
    } finally {
      running = false
      recordPhase(null)
    }
  }

  /** Resolve a pending human decision (§40) — Core owns the transition back. */
  function answerDecision(decisionId, { choice, note = null } = {}) {
    const d = decisions.resolve(decisionId, { choice, note })
    if (!d) return null
    if (task && !TERMINALish(task.status)) {
      try { task.transition(TASK_STATUS.EXECUTING, { reason: `decision ${d.decision_id} answered: ${d.answer}` }) } catch { }
    }
    bus.send({ sender: "core", receiver: "*", type: MESSAGE_TYPE.REQUEST, content: `decision ${d.key} resolved: ${d.answer}`, priority: 2 })
    emit({ type: "DECISION_RESOLVED", decision: d })
    return d
  }

  function TERMINALish(status) {
    return status === TASK_STATUS.COMPLETED || status === TASK_STATUS.FAILED || status === TASK_STATUS.CANCELLED
  }

  /** Pause: workers pause + task PAUSED (§3). Resume is the inverse. */
  function pause({ reason = "user paused" } = {}) {
    if (task && !TERMINALish(task.status)) {
      try { task.transition(TASK_STATUS.PAUSED, { reason }) } catch { }
    }
    emit({ type: "CORE_PAUSED", reason })
  }

  /** §2 failure flow visibility for the TUI (meta does the actual repair). */
  function failureFlow() {
    return {
      diagnose: currentPhase.name === "DIAGNOSE",
      repair: currentPhase.name === "REPAIR",
      recover: currentPhase.name === "RECOVER",
      hypotheses: [],
    }
  }

  /** Live dashboard state for the Premium TUI (§63). */
  function status() {
    const pendingDecisions = decisions.pendingList()
    return {
      running,
      phase: currentPhase.name,
      phaseHistory: phaseHistory.slice(-12),
      task: task ? { taskId: task.record.task_id, status: task.status, objective: task.record.objective, segment: task.record.segment_count, waiting_reason: task.record.waiting_reason } : null,
      lastResult: lastResult ? { status: lastResult.status, segments: lastResult.segments, repairs: lastResult.repairs, risk: lastResult.risk, filesChanged: (lastResult.filesChanged ?? []).length } : null,
      crew: { workers: stats.workers, router: crewRouter.stats().length + " routed roles" },
      communication: { messages: stats.messages, pending: bus.stats().pendingQuestions, conflicts: stats.conflicts },
      verification: { verifications: stats.verifications, repairs: stats.repairs },
      resources: resources.snapshot(),
      decisions: { pending: pendingDecisions.length, items: pendingDecisions },
      episodes: episodes.stats(),
      handoffs: handoffs.size,
      conflicts: conflicts.map((c) => ({ id: c.conflict_id, status: c.status, topic: c.topic, winner: c.resolution?.winner ?? null })),
    }
  }

  return {
    run, status, pause, answerDecision, failureFlow,
    // subsystem access (wired, shared — every consumer gets THE instance)
    bus, handoffs, decisions, episodes, crewRouter, resources, world, conflicts,
    reviewWorkerResult, formatSelfReview,
    get phases() { return [...CORE_PHASES] },
    get currentPhase() { return currentPhase.name },
  }
}
