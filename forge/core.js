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
import { createBus, MESSAGE_TYPE, busPath } from "./bus.js"
import { createHandoffLedger } from "./handoff.js"
import { createDecisionEngine, DECISION_STATUS, answerDecision as answerDecisionRecord } from "./decisionengine.js"
import { createWorldModel } from "./worldmodel.js"
import { createEpisodeStore, EPISODE_RESULT } from "./episodes.js"
import { createCrewRouter } from "./crewroute.js"
import { reviewWorkerResult, formatSelfReview } from "./selfreview.js"
import { reportConflict, resolveConflict, CONFLICT_STATUS } from "./crewconflict.js"
import { createResourceManager } from "./resources.js"
import { TASK_STATUS } from "./taskstate.js"
import { openTask, readTask } from "./taskstate.js"
import { listCheckpoints } from "./checkpoint.js"
import { projectDir } from "./memory.js"
import { readSourceRecord } from "./sourceresolve.js" // v97 §3: source record in the canonical state
import { predictionCalibration } from "./prediction.js" // v97 §3: prediction calibration view
import fs from "node:fs"
import path from "node:path"

/** §2 — the unified execution lifecycle, in order. */
export const CORE_PHASES = [
  "UNDERSTAND", "DISCOVER", "PLAN", "DECOMPOSE", "ALLOCATE",
  "DELEGATE", "EXECUTE", "OBSERVE", "COLLECT_EVIDENCE", "VERIFY",
  "REVIEW", "REPLAN", "PERSIST", "CONTINUE", "COMPLETE",
  // failure / crash flows
  "DIAGNOSE", "REPAIR", "RECOVER", "RESUME",
]

/** Meta events → lifecycle phases (§2). Truth comes from real events only.
 * v96 unifywise: this map previously named four event types meta never emits
 * (TASK_CREATED, TASK_RESUMED, REPAIR_COMPLETED, VERIFY_PASSED) — dead
 * vocabulary that made the RESUME and REPAIR phases UNRECORDABLE from real
 * events. It now maps meta's ACTUAL vocabulary (RECOVERY_COMPLETED is the
 * resume signal; meta additionally emits TASK_RESUMED + REPAIR_COMPLETED as
 * of v96), so every phase in CORE_PHASES is reachable from real traffic. */
const EVENT_PHASE = {
  TASK_STARTED: "UNDERSTAND",
  TASK_CLASSIFIED: "UNDERSTAND",
  TASK_RESUMED: "RESUME",          // v96: meta emits it right after recovery completes
  RECOVERY_STARTED: "RECOVER",
  RECOVERY_COMPLETED: "RESUME",    // v96: recovery finishing IS the resume transition
  DISCOVERY: "DISCOVER",
  PLAN_STARTED: "PLAN",
  PLAN_READY: "PLAN",
  PLAN_COMPOSE: "PLAN",
  PLAN_RESTORED: "PLAN",
  DAG_BUILT: "DECOMPOSE",
  DAG_UPDATED: "DECOMPOSE",
  SEGMENT_STARTED: "ALLOCATE",
  WORKER_QUEUED: "DELEGATE",
  WORKER_STARTED: "DELEGATE",
  WORKER_COMPLETED: "OBSERVE",
  PREDICTION_SETTLED: "COLLECT_EVIDENCE", // v96: what the segment actually changed vs predicted
  REALITY_DELTA: "COLLECT_EVIDENCE",
  TOOL_START: "EXECUTE",
  TOOL_END: "EXECUTE",
  SEGMENT_COMPLETED: "CONTINUE",          // v96: a settled segment IS the loop continuing
  CHECKPOINT_CREATED: "PERSIST",
  VERIFY: "VERIFY",
  VERIFICATION: "VERIFY",
  VERIFICATION_PASSED: "VERIFY",
  VERIFICATION_FAILED: "VERIFY",
  REVIEW_STARTED: "REVIEW",
  REVIEW_COMPLETED: "REVIEW",
  REPLAN: "REPLAN",
  REPLAN_STARTED: "REPLAN",
  REPAIR_STARTED: "DIAGNOSE",
  REPAIR_COMPLETED: "REPAIR",      // v96: meta emits it after a successful repair
  COMPLETION_ATTEMPT: "COMPLETE",
  COMPLETION_GATE: "COMPLETE",
  TASK_COMPLETED: "COMPLETE",
  TASK_FAILED: "COMPLETE",
  TASK_FINISHED: "COMPLETE",
  DECISION_REQUIRED: "WAIT_FOR_USER",
}

export function createForgeCore({
  config = {},
  provider = null,
  cwd = process.cwd(),
  onEvent = null,
  signal = null,
  conversationId = null, // v94 masterwise (§17): chat session / conversation identity
} = {}) {
  config = config && typeof config === "object" ? config : {}
  // --- shared subsystems (the Core owns the instances) --------------------
  // v93 gap fix §14: the bus persists. It binds to the task file the moment
  // the task id exists (bindTask) and replays prior history on resume; the
  // bounded JSONL + trim keeps it from ever becoming a bottleneck, and
  // PROGRESS chatter is not written (appendDisk).
  const bus = createBus({ taskId: null, persist: true })
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
    // 0. v93 §14: bind the persisted bus to the task as soon as it exists,
    //    and append the engineering event to the bounded events ledger.
    if ((ev.type === "TASK_CREATED" || ev.type === "TASK_STARTED" || ev.type === "TASK_RESUMED") && ev.taskId && !bus.file) {
      bus.bindTask(ev.taskId)
    }
    persistEvent(ev)
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
      // v96 unifywise: the world-model consultation step of the §31 procedure
      // is no longer disabled (`world: () => null` always escalated ties). The
      // Core OWNS a world model — but the callback stays HONEST: it only
      // answers claims it can actually verify. A claim mentioning path-like
      // tokens (a.js, src/b.py) is checked against the world's file set —
      // all exist → true (agreement), any missing → false (contradiction).
      // A behavioral claim ("the API is fast") has no verifiable form → null
      // (unknown) → the tie still escalates to a discriminating experiment.
      resolveConflict(c, { world: (claim) => {
        try {
          const text = String(claim ?? "")
          const tokens = text.match(/[A-Za-z0-9_-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|rb|php|cs|json|yaml|yml|toml|md|sql)\b/g) ?? []
          if (!tokens.length) return null
          const w = world.build() // first call builds/loads the persisted snapshot; later calls are drift-checked reuse
          const files = new Set((w?.files ?? []).map((f) => String(f.path ?? "")))
          if (!files.size) return null
          const hit = (t) => [...files].some((p) => p === t || p.endsWith("/" + t))
          const allHit = tokens.every(hit)
          const anyHit = tokens.some(hit)
          // every mentioned path exists → agreement; NONE exists → the claim
          // references nothing real → contradiction; a MIX → unknown
          return allHit ? true : (anyHit ? null : false)
        } catch { return null }
      } })
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

  /** §14 — bounded, append-only engineering-event ledger (events.jsonl under
   *  the project dir). Task/plan/DAG/segment/worker/verification/checkpoint/
   *  recovery/decision/completion events only; raw tool traffic and huge
   *  payloads are never written. Restart reconstruction reads it back. */
  const PERSISTED_EVENT_RE = /^(TASK_|PLAN_|DAG_|SEGMENT_|WORKER_|VERIFICATION_|VERIFY_|CHECKPOINT|REPAIR_|RECOVER|RESUM|DECISION_|COMPLETION_|INTEGRATION_CONFLICT|CONFLICT_|SELF_REVIEW|MODEL_SELECTED|STRATEGY_CHANGED|PREDICTION_|CONTRACT_DRIFT|WORLD_INVALIDATED|WORLD_ENRICHED|ENVIRONMENT_DRIFT|GITSHIP_|CODE_REVIEW_)/
  function eventsPath() { return path.join(projectDir(cwd), "events.jsonl") }
  function persistEvent(ev) {
    if (!ev || !ev.type || !PERSISTED_EVENT_RE.test(ev.type)) return
    try {
      const line = JSON.stringify({ ts: Date.now(), ...ev, content: undefined, text: typeof ev.text === "string" ? ev.text.slice(0, 400) : undefined })
      if (line.length > 4000) return // a huge payload is raw log material, not history
      const p = eventsPath()
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.appendFileSync(p, line + "\n", "utf8")
      try {
        const st = fs.statSync(p)
        if (st.size > 2_000_000) {
          const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean)
          fs.writeFileSync(p, lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n", "utf8")
        }
      } catch { }
    } catch { /* persistence never breaks the run */ }
  }

  /** §14 — reconstruct the authoritative engineering state for a task after
   *  a restart: event history + checkpoint + world model + task state. Read
   *  ONLY what exists; every field says honestly what was found. */
  function reconstruct(taskId) {
    const out = { taskId: taskId ?? null, bus: null, events: null, task: null, checkpoints: 0, world: null }
    try {
      const busFile = busPath(taskId)
      if (fs.existsSync(busFile)) {
        const lines = fs.readFileSync(busFile, "utf8").split("\n").filter(Boolean)
        out.bus = { file: busFile, messages: lines.length }
      }
    } catch { }
    try {
      if (fs.existsSync(eventsPath())) {
        const lines = fs.readFileSync(eventsPath(), "utf8").split("\n").filter(Boolean)
        const last = lines.slice(-40).map((l) => { try { return JSON.parse(l).type } catch { return null } }).filter(Boolean)
        out.events = { file: eventsPath(), count: lines.length, lastTypes: [...new Set(last)].slice(-12) }
      }
    } catch { }
    try { const t = readTask(taskId); if (t) out.task = { status: t.status, objective: String(t.objective ?? "").slice(0, 160), segment: t.segment_count ?? null } } catch { }
    try { out.checkpoints = listCheckpoints(cwd, 50).length } catch { }
    try { out.world = { file: path.join(projectDir(cwd), "world.json"), exists: fs.existsSync(path.join(projectDir(cwd), "world.json")) } } catch { }
    return out
  }

  /**
   * Run an objective through the whole system (delegates execution to meta).
   * This is the §2 loop made real: meta drives, the Core coordinates,
   * observes, remembers and proves.
   */
  async function run(objective, { resumeTaskId = null, deep = null, segmentSteps = null, maxSegments = null, runAgent = null, pluginStartedAt = null, conversationId: convOverride = null } = {}) {
    if (running) throw new Error("core is already running a task")
    running = true
    const t0 = Date.now()
    // v97 §4: every autonomous run records the resolved source of truth for
    // this workspace (idempotent, best-effort — an existing record wins).
    try { (await import("./sourceresolve.js")).ensureWorkspaceSource(cwd) } catch { }
    if (resumeTaskId) {
      // §14: a resumed task reattaches to its persisted history FIRST — the
      // conversation and events that already happened are the context
      try { bus.bindTask(resumeTaskId) } catch { }
    }
    const ep = episodes.start({
      problem: String(objective ?? "").slice(0, 1200),
      context: world.summarize({ maxLines: 8 }),
      taskId: resumeTaskId,
      files: [],
    })
    // v96 unifywise: the episode's STAGE RECORDERS (hypotheses, experiments,
    // evidence, verification, failed approaches) had no production callers —
    // episodes persisted only problem/context/review/lesson while the Ω kernel
    // held exactly that data and threw it away at run end. The sink passes the
    // recorders into runMeta: repair/diagnosis/verification stages now feed
    // the durable episodic story ("never repeat what failed" becomes real).
    const episodeSink = {
      addHypothesis: (text, opts) => { try { episodes.addHypothesis(ep, text, opts) } catch { } },
      addExperiment: (spec) => { try { episodes.addExperiment(ep, spec) } catch { } },
      addEvidence: (item) => { try { episodes.addEvidence(ep, item) } catch { } },
      addVerification: (spec) => { try { episodes.addVerification(ep, spec) } catch { } },
      addFailedApproach: (text) => { try { episodes.addFailedApproach(ep, text) } catch { } },
      addFix: (text) => { try { episodes.addFix(ep, text) } catch { } },
    }
    try {
      const { runMeta } = await import("./meta.js")
      const result = await runMeta({
        config, provider, task: objective,
        onEvent: coreEventTap, signal,
        resumeTaskId, segmentSteps, maxSegments, deep, runAgent, pluginStartedAt,
        conversationId: convOverride ?? conversationId,
        episodeSink,
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

  /**
   * Resolve a pending human decision (§40) — Core owns the transition back.
   *
   * v108: the record-and-unblock half moved to decisionengine.answerDecision so
   * that chat can answer a question too. It had to: this function was the ONLY
   * resolver in the repository and had no production caller, so a question forge
   * asked could never be answered by anyone. Core still owns what is Core's —
   * the live task handle, the bus and the event.
   */
  function answerDecision(decisionId, { choice, note = null } = {}) {
    const d = answerDecisionRecord({ cwd, ref: decisionId, choice, note })
    if (!d) return null
    try { decisions.reload?.() } catch { /* the file is authoritative; this is a cache */ }
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

  /** final-but-resumable states also stop the loop and need a next action */
  function FINALish(status) {
    return TERMINALish(status) || status === TASK_STATUS.WAITING || status === TASK_STATUS.WAITING_FOR_USER || status === TASK_STATUS.PAUSED
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

  /** v96 unifywise (§24): the NEXT-BEST-ACTION surface. This is deliberately
   *  an INSPECTABLE READ-ONLY VIEW over the decision authorities that already
   *  exist — the Ω kernel's repair chooser, the execution controller, the
   *  completion gate, the human decision engine — NOT a second decider. It
   *  answers "given the state the Core can see, what happens next and why"
   *  deterministically, so the TUI (and tests) can audit the loop's intent.
   *  Priority order mirrors the real control flow:
   *    1. a pending HUMAN decision outranks everything (the loop is parked)
   *    2. a terminal task's next_action tells the user how to continue
   *    3. the live phase says what the loop is doing right now
   *    4. idle → await instruction
   */
  function nextBestAction() {
    try { decisions.reload?.() } catch { }
    const pending = decisions.pendingList()
    if (pending.length) {
      const d = pending[pending.length - 1]
      return { action: "answer_decision", why: `the run is WAITING_FOR_USER: ${String(d.title ?? d.key ?? "decision").slice(0, 120)}`, detail: { decisionId: d.decision_id, options: (d.options ?? []).map((o) => o.label).slice(0, 6) } }
    }
    if (task && FINALish(task.status)) {
      const rec = task.record ?? {}
      const st = rec.status ?? task.status
      if (st === TASK_STATUS.COMPLETED) return { action: "none", why: "task COMPLETED — nothing pending", detail: null }
      if (st === TASK_STATUS.WAITING || st === TASK_STATUS.WAITING_FOR_USER || st === TASK_STATUS.PAUSED) {
        return { action: "continue", why: `task is ${st}${rec.waiting_reason ? ` (${String(rec.waiting_reason).slice(0, 120)})` : ""} — resume it (forge tasks --resume <id>)`, detail: { nextAction: rec.next_action ?? null } }
      }
      return { action: "inspect", why: `task ended ${st}${rec.waiting_reason ? ` (${String(rec.waiting_reason).slice(0, 120)})` : ""}`, detail: { nextAction: rec.next_action ?? null } }
    }
    if (running) {
      const phaseWhy = {
        UNDERSTAND: "classifying the objective and seeding the task model",
        DISCOVER: "discovering the repository surfaces relevant to the goal",
        PLAN: "composing the plan from lessons, world model and constraints",
        DECOMPOSE: "building and validating the execution DAG",
        ALLOCATE: "sizing the next segment (adaptive budget)",
        DELEGATE: "routing read-only DAG nodes to specialist workers",
        EXECUTE: "executing the current DAG node",
        OBSERVE: "settling worker findings into evidence",
        COLLECT_EVIDENCE: "recording what the segment actually changed",
        VERIFY: "checking verification evidence against the required risk profile",
        REVIEW: "running the adversarial completion review",
        REPLAN: "reshaping the remaining plan (strategy change)",
        PERSIST: "checkpointing durable state",
        CONTINUE: "continuing to the next segment",
        COMPLETE: "evaluating the completion gate",
        DIAGNOSE: "diagnosing a failure (hypotheses, causal layers)",
        REPAIR: "executing the minimal repair and re-verifying",
        RECOVER: "reconciling state after an interruption",
        RESUME: "reconstructing the task from checkpoint + events + git",
      }
      return { action: "continue", why: phaseWhy[currentPhase.name] ?? `running (${currentPhase.name ?? "starting"})`, detail: { phase: currentPhase.name } }
    }
    return { action: "await_instruction", why: "no task is running", detail: null }
  }

  /** v97 unifiedwise (§3): the CANONICAL ENGINEERING STATE — one connected,
   *  inspectable view over the stores that already exist (task record, world
   *  model, episodes, decisions, resources, predictions, source record). It
   *  is a READ-ONLY aggregate: no second truth, no private copies — §89.
   *  Every field says honestly what is known; missing data stays null. */
  function engineeringState() {
    try { decisions.reload?.() } catch { }
    const rec = task?.record ?? null
    let source = null
    try { source = readSourceRecord(cwd) } catch { }
    let predictionCal = null
    try { predictionCal = predictionCalibration(cwd) } catch { }
    let worldSnap = null
    try { worldSnap = world.snapshot() } catch { }
    const dag = rec?.dag ?? null
    const dagNodes = Array.isArray(dag?.nodes) ? dag.nodes : null
    return {
      identity: {
        taskId: rec?.task_id ?? null,
        runId: rec?.run_id ?? null,
        conversationId: conversationId ?? null,
        checkpointId: rec?.checkpoint_id ?? null,
        node: rec?.node_id ?? null,
        segmentId: rec?.segment_id ?? null,
      },
      source: source ? { sourceType: source.sourceType, origin: source.origin, authority: source.authority, localPath: source.localPath, archivePath: source.archivePath } : null,
      goal: { objective: rec?.objective ?? null, status: rec?.status ?? null, phase: currentPhase.name },
      work: {
        completedSteps: (rec?.completed_steps ?? []).length,
        pendingSteps: (rec?.pending_steps ?? []).length,
        currentStep: rec?.current_step ?? null,
        segments: rec?.segment_count ?? 0,
        filesChanged: (rec?.files_changed ?? []).length,
        filesCreated: (rec?.files_created ?? []).length,
        dag: dagNodes ? { nodes: dagNodes.length, status: dag.status ?? null } : null,
      },
      verification: {
        results: (rec?.verification_results ?? []).length,
        testsRun: (rec?.tests_run ?? []).length,
        epoch: rec?.verification_epoch ?? 0,
        verifications: stats.verifications,
        repairs: stats.repairs,
      },
      blockers: {
        errors: (rec?.errors ?? []).slice(-3),
        waitingReason: rec?.waiting_reason ?? null,
        pendingDecisions: decisions.pendingList().length,
        conflicts: stats.conflicts,
      },
      knowledge: {
        episodes: episodes.stats?.() ?? null,
        predictions: predictionCal,
        world: worldSnap ? { files: worldSnap.files, edges: worldSnap.edges, degraded: worldSnap.degraded, truncated: worldSnap.stats?.truncated ?? false } : null,
      },
      resources: resources.snapshot(),
      nextBestAction: nextBestAction(),
    }
  }

  /** Live dashboard state for the Premium TUI (§63). */
  function status() {
    try { decisions.reload?.() } catch { } // v96: meta may have asked a decision this process never saw
    const pendingDecisions = decisions.pendingList()
    return {
      running,
      phase: currentPhase.name,
      nextBestAction: nextBestAction(),
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
    run, status, pause, answerDecision, failureFlow, reconstruct, nextBestAction, engineeringState,
    // subsystem access (wired, shared — every consumer gets THE instance)
    bus, handoffs, decisions, episodes, crewRouter, resources, world, conflicts,
    reviewWorkerResult, formatSelfReview,
    get phases() { return [...CORE_PHASES] },
    get currentPhase() { return currentPhase.name },
  }
}
