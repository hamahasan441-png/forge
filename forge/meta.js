/**
 * forge — meta controller (v21 hardened v23, zero dependencies)
 *
 * The autonomous orchestration brain. Before v21 an agent run was one bounded
 * tool loop (agent.js): Task → maxSteps → stop. This controller turns that into
 * the recoverable lifecycle:
 *
 *   PLAN → DISCOVER → BUILD DAG → SELECT MODEL → ALLOCATE RESOURCES
 *        → EXECUTE SEGMENT → OBSERVE → CHECKPOINT → VERIFY → CONTINUE …
 *   on failure:  DIAGNOSE → CHANGE STRATEGY → REPAIR → VERIFY → CONTINUE
 *   on interrupt: RECOVER → RECONCILE → RESUME
 *
 * Hardening (v23 P0):
 *  - segToolCalls initialization before every read (no TDZ)
 *  - explicit task finalization preserving COMPLETED/FAILED/WAITING/CANCELLED
 *  - verification is a hard gate: NO BYPASS for medium/high/critical
 *  - exact DAG node identity: taskId, runId, segmentId, nodeId everywhere
 *  - executeNode(nodeId) deterministic, markCompleted(nodeId), attributeSegment only diagnostic
 *  - canonical conflict keys: file:<path>, symbol:<symbol>, dir:<path>, resource:<lock>
 *  - read-only truly read-only enforced via tools.js policy
 *  - plan validation pipeline with REPAIR/WAITING on failure
 *  - segment safety fuse: maxSegments → CHECKPOINT → PERSIST → WAITING/CONTINUE_REQUIRED → RESUME
 *  - critical TaskState durability with fsync
 *  - checkpoint full SHA-256 integrity
 *  - exact crash/resume with nodeId, verificationEpoch, etc.
 *  - effect-aware recovery
 */
import { openTask, readTask, TASK_STATUS, TERMINAL, DURABILITY, FINAL_STATUSES, finalizeStatus } from "./taskstate.js"
import { createLedger, riskForChange, finalRiskForChange, detectAffectedSymbols, VERIFICATION_STATUS, VTYPE } from "./verifyledger.js"
import { canCompleteTask, requirementCoverage, CHECK as GATE_CHECK } from "./completion.js"
import { createResourceManager, ADAPT, fanoutWaitMs, scaleWorkers } from "./resources.js"
import { createExecutionController } from "./execcontroller.js"
import { createEngMemory } from "./engmemory.js"
import { assessPlan, predictNodes, alternatives, adoptDecision, informationGainExperiments, classifyRealityDelta, createLiveRisk, verificationPlanForRisk, gatherPlannerEvidence } from "./plannerisk.js"
import { selectModel, reconsiderModel, recordOutcome, resolveLane } from "./modelstrategy.js"
import { warmCaches } from "./fastwise.js"
import { createAgentManager } from "./agentmanager.js"
import { createContextEngine } from "./context.js"
import { integrateResults, reportsFromGraph, isIntegratorRole } from "./integrate.js"
import { languagesIn, formatLangReason } from "./langreason.js"
import { engineFor } from "./langengine.js"
import { composeOnce, clearComposeOnce, formatCompose } from "./compose.js"
import { formatSteer } from "./evaluate.js"
import { persistGaps } from "./knowgap.js"
import { focusedVerify } from "./verify.js"
import { indexSkills, resolveSkillsDir } from "./skills.js"
import { mergeLearnedSkills, evolveRun, hardAvoid, formatEvolve, markStaleSkills } from "./evolve.js"
import { resolveEmbeddingsConfig, createEmbedder } from "./embeddings.js"
import { recordLesson, ineffectiveStrategies, ineffectiveStrategiesAsync, lessonsForPlan } from "./lessons.js"
import { reconcileEffect, reconcileTask, resumePrompt, UNKNOWN_DECISION } from "./recovery.js"
import { snapshotBefore, boundaryCheckpoint } from "./checkpoint.js"
import { collectDiagnosticsForFiles } from "./lsp.js"
import { maybeShip } from "./gitship.js" // v98 shipwise: verified delivery (kernel policy, never a tool)
import { enrichIndex } from "./langstruct.js" // v98 shipwise: tier-3 structured enrichment of changed files
import { artifactRuntimeEvidence } from "./runtimesession.js" // v98 shipwise: runtime/artifact evidence for the ledger
import { redact } from "./secrets.js"
import { runCodeReview } from "./codereview.js" // v99 loopwise: the post-mutation reviewer pass
import { tryNativeAutoFix } from "./autofix.js" // v99 loopwise: deterministic lint/format repair fast path
import { critiquePlan, planRevisionPrompt } from "./plancritique.js" // v99 loopwise: plan-quality gate + one revision pass
import { classifyTask, synthesizePlan, TASK_CLASS } from "./classify.js"
import { AGENT_BUDGETS } from "./config.js"
import { createKernel } from "./omega.js"
import { classifyUserMessage } from "./msgclass.js"
import { requirementDelta, formatDelta } from "./reqdelta.js"
import { shouldReplan, replanPrompt, planLessonsPrefix } from "./replan.js"
// v91 ∞ CORE wiring: communication bus, crew intelligence, decisions, self-review
import { createBus, MESSAGE_TYPE } from "./bus.js"
import { createDecisionEngine, DECISION_TYPE } from "./decisionengine.js"
import { createCrewRouter, preferredClassFor } from "./crewroute.js"
import { reviewWorkerResult } from "./selfreview.js"
// v96 unifywise: handoffContextBlock is no longer imported here — it is now
// consumed where it belongs (agentmanager.reassign renders the structured
// handoff into the successor's context) instead of being dead import surface.
import { createHandoffLedger, createHandoff as createHandoffLocal } from "./handoff.js"
// v92 "wirewise" wiring: prediction ledger (§9), language adapters (§7/§8),
// semantic world-model consultation (§5/§10). Conflict reporting (§31) flows
// through INTEGRATION_CONFLICT events to core.js (the v92 wiring), so the old
// direct reportConflict import here was dead and is gone (v96 unifywise).
// Nothing below replaces an existing engine — each island module is now
// consulted by the living loop that needed it.
import { predictForNode, settlePrediction, recordPrediction, predictionsForPrompt, predictionCalibration, formatPrediction, formatSettlement } from "./prediction.js"
import { adapterBrief } from "./langadapter.js"
import { createWorldModel } from "./worldmodel.js"
import { ensureKnowledgeGraph } from "./knowgraph.js" // v94 knowwise: auto KG bootstrap
// v95 worktreewise: isolated worktree execution for DAG nodes (the kernel TODO
// closed). Mutating nodes with pairwise-disjoint declared targets run in
// per-node git worktrees; the merge back is serialized single-writer.
import { planIsolation, createWorktree, captureChanges, mergeBack, removeWorktree, sweepOrphans, isolationAvailable } from "./worktree.js"
import { contractDrift } from "./xlang.js" // v97 §21: API/schema drift evidence
import * as dagLib from "./dag.js"
import fs from "node:fs"
import path from "node:path"

const SEGMENT_STEPS = AGENT_BUDGETS.segmentSteps
const MAX_SEGMENTS_DEFAULT = AGENT_BUDGETS.maxSegments

export const FINAL = { COMPLETED: "COMPLETED", FAILED: "FAILED", CANCELLED: "CANCELLED", WAITING: "WAITING" }

/**
 * Explicit finalization mapping (P0): preserves terminal states verbatim.
 * COMPLETED → COMPLETED, FAILED → FAILED, WAITING → WAITING, CANCELLED → CANCELLED
 * Never silently convert WAITING into FAILED.
 */
function explicitFinalization(desired) {
  if (desired === FINAL.COMPLETED) return FINAL.COMPLETED
  if (desired === FINAL.FAILED) return FINAL.FAILED
  if (desired === FINAL.WAITING) return FINAL.WAITING
  if (desired === FINAL.CANCELLED) return FINAL.CANCELLED
  return FINAL.FAILED
}

export async function runMeta({ config, provider, task, onEvent = null, signal = null, resumeTaskId = null, segmentSteps, maxSegments, runAgent = null, deep, workers = null, pluginStartedAt = null, conversationId = null, episodeSink = null } = {}) {
  const emit = (ev) => { try { onEvent?.(ev) } catch { } }

  let taskId = resumeTaskId
  let resumeRec = null
  if (resumeTaskId) {
    resumeRec = readTask(resumeTaskId)
    if (resumeRec) taskId = resumeTaskId
  }
  if (!taskId) taskId = "task-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6)

  const ts = openTask(taskId, {
    create: true,
    runId: resumeRec?.run_id ?? null,
    objective: resumeRec?.objective ?? task,
    cwd: process.cwd(),
  })
  const state = ts.record

  // v106 §continuity — a RESUME that carries a NEW instruction.
  //
  // meta.js:124 reads `objective: resumeRec?.objective ?? task`, and after that
  // line every consumer reads state.objective. So resuming a task with a
  // changed requirement DISCARDED the new instruction outright: reproduced by
  // resuming an Android task with "change the target to Flutter" and watching
  // the model never once see the word Flutter — it kept building the Android
  // app. The user's correction vanished between two lines of code.
  const resumeInstruction = (() => {
    if (!resumeRec) return null
    const t = String(task ?? "").trim()
    if (!t) return null
    if (t === String(resumeRec.objective ?? "").trim()) return null
    // "continue" / "carry on" is consent to keep going, not a requirement
    // change, and must never disturb a valid plan.
    const cls = (() => { try { return classifyUserMessage(t).classes.map((c) => c.cls) } catch { return [] } })()
    if (cls.includes("continue") && !cls.includes("scope_change") && !cls.includes("correction")) return null
    return t
  })()
  const taskRunId = state.run_id || "run-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6)
  state.run_id = taskRunId

  /**
   * v106 — carry a resumed run's NEW instruction into the objective, BEFORE
   * anything plans from it.
   *
   * Two defects, one cause. The instruction was discarded outright
   * (meta.js:124 keeps the stored objective and every later consumer reads
   * state.objective) — reproduced by resuming an Android task with "change the
   * target to Flutter" and watching the model never once see the word Flutter.
   * And dag.invalidateNodes() — "COMPLETED nodes that do not depend on
   * invalidated ground truth are PRESERVED" — had no production caller at all,
   * which forge's own `selfaudit` reports.
   *
   * Ordering is the whole trick: the objective must change before classify and
   * the planner read it, while node invalidation can only happen once the DAG
   * is materialized. So the delta is computed once, here, and applied in two
   * places.
   */
  const resumeDelta = (() => {
    if (!resumeInstruction) return null
    let d = null
    try { d = requirementDelta({ previous: [state.objective], message: resumeInstruction }) }
    catch (e) {
      emit({ type: "REQUIREMENTS_CHANGED", taskId, runId: taskRunId, error: String(e?.message ?? e).slice(0, 200), applied: false })
      return null
    }
    // The objective carries the change AND what it killed, so every prompt
    // built from state.objective sees both. Appended, never replaced — the
    // requirements the user said to keep must survive verbatim.
    const dead = [...d.invalidated, ...d.changed].map((i) => i.text).filter(Boolean)
    state.objective = [
      state.objective,
      "",
      `[requirement change] ${resumeInstruction}`,
      dead.length ? `NO LONGER VALID (do not continue building these): ${dead.join("; ")}` : "",
      d.preserved.length ? `STILL REQUIRED: ${d.preserved.map((i) => i.text).join("; ")}` : "",
    ].filter(Boolean).join("\n").slice(0, 4000)
    // resumePrompt() builds segment 1's task from `resumeRec` — the snapshot
    // read off disk BEFORE this update (meta.js: `segTask = resumeRec && …`).
    // Updating only state.objective left the one prompt that a resumed run
    // actually sends still carrying the superseded objective, which is the
    // whole bug over again one layer down.
    if (resumeRec) resumeRec.objective = state.objective
    try { ts.save?.() } catch { /* persistence is best-effort; the run continues */ }
    emit({
      type: "REQUIREMENTS_CHANGED", taskId, runId: taskRunId,
      instruction: resumeInstruction.slice(0, 200),
      platformChange: d.platformChange ?? null,
      summary: formatDelta(d).slice(0, 400),
      applied: true,
    })
    return d
  })()

  /** Invalidate only the plan nodes the change actually killed; everything
   *  else keeps whatever status it had, COMPLETED included. */
  function invalidateForResume(graph) {
    if (!resumeDelta || !graph) return null
    let scored = resumeDelta
    try { scored = requirementDelta({ previous: [], message: resumeInstruction, nodes: [...graph.nodes.values()] }) } catch { return null }
    const affected = scored.affectedNodes.map((n) => n.id)
    if (!affected.length) return null
    let r = { invalidated: [], blocked: [] }
    try { r = dagLib.invalidateNodes(graph, affected, { reason: scored.summary }) } catch { return null }
    emit({
      type: "PLAN_INVALIDATED", taskId, runId: taskRunId,
      invalidatedNodes: r.invalidated, blockedNodes: r.blocked,
      preservedNodes: scored.unaffectedNodes.map((n) => n.id),
      reason: scored.summary.slice(0, 300),
    })
    return r
  }

  // v96 unifywise (§50): environment fingerprint + drift. One bounded capture
  // (process facts free, toolchain presence stat-only, versions TTL-memoized)
  // diffed against the per-project persisted fingerprint. Drift is ADVISORY —
  // an ENVIRONMENT_DRIFT warning with per-signal impact notes, never a gate
  // decision. The check itself never breaks the run ("absent" is honest).
  try {
    const { checkEnvironment, formatDrift } = await import("./envfingerprint.js")
    const envCheck = checkEnvironment({ cwd: process.cwd() })
    if (envCheck.ok && envCheck.drift?.drifted) {
      emit({ type: "ENVIRONMENT_DRIFT", taskId, runId: taskRunId, signals: envCheck.drift.signals.slice(0, 6), note: formatDrift(envCheck.drift), advisory: true })
    }
  } catch { /* environment fingerprinting is advisory, never load-bearing */ }
  const ledger = createLedger()
  if (Array.isArray(state.verification_results)) ledger.load(state.verification_results)
  const resources = createResourceManager({ config, cwd: process.cwd() })
  // v94 masterwise (§8/§10/§29): ONE authoritative ExecutionController. It owns
  // adaptive segment sizing, stuck detection, resource-fuse enforcement and
  // the continuation policy. It never declares completion — the completion
  // gate (completion.js, via attemptCompletion) remains the only authority.
  const xctl = createExecutionController({ config, taskId, runId: taskRunId, cwd: process.cwd(), onEvent: emit, resources, signal })
  // v94 masterwise (§11–§18): the Engineering Memory Core — layered memory
  // with provenance, freshness and conversation continuity, composed over
  // the existing stores. Never a second truth: memory is history, the world
  // model is current truth.
  const engMem = createEngMemory({ cwd: process.cwd(), taskId, runId: taskRunId, conversationId })
  engMem.setTask(state.objective)
  // v23 semantic retrieval: when retrieval.embeddings resolves, the context
  // engine reranks memory/learnings BM25 shortlists with provider embeddings.
  // Off by default; a failed resolution simply leaves embedder = null (BM25).
  const embCfg = resolveEmbeddingsConfig(config)
  const embedder = embCfg.ok ? createEmbedder(embCfg) : null
  const ctxEngine = createContextEngine({
    cwd: process.cwd(),
    config,
    embedder,
    skillsIndex: (config.skills?.enabled !== false) ? mergeLearnedSkills(indexSkills(resolveSkillsDir(config.skills?.dir)), process.cwd()) : null,
  })
  if (embedder) {
    emit({ type: "RETRIEVAL_MODE", taskId, runId: taskRunId, segmentId: null, nodeId: null, mode: "semantic", provider: embCfg.provider, model: embCfg.model, alpha: embCfg.alpha })
  }
  const manager = createAgentManager({
    maxWorkers: resources.state.maxWorkers,
    // worker events are stamped with the task identity like every other event
    onEvent: (ev) => emit({ taskId, runId: taskRunId, ...ev }),
    signal,
  })
  // --- v95 worktreewise state ----------------------------------------------
  // nodeId → { id, dir, base } for nodes currently executing in an isolated
  // git worktree. Declared BEFORE manager.configure() so the runner closure
  // (which needs it) can see the SAME map for the whole task.
  const worktreeByNode = new Map()
  // resolved once per task on first fan-out (null = not yet resolved)
  let wtAvailability = null
  // v97 §52 (adaptive parallelism): the writer ceiling is configurable —
  // config.worktree.maxNodes or FORGE_WORKTREE_WRITERS, default 2, hard cap 8
  // (measured parallelism, not a fan-out bomb; the single-writer merge lane
  // and pairwise-disjoint conflict keys stay exactly as they were).
  const wtMaxNodes = Math.max(1, Math.min(8, Number(config?.worktree?.maxNodes) || Number(process.env.FORGE_WORKTREE_WRITERS) || 2))
  // crash-resume house pattern: worktrees whose owning run is gone are swept
  // BEFORE this task starts writing (a stale checkout must never look live).
  try {
    const swept = await sweepOrphans({ root: process.cwd(), liveRunIds: [taskRunId, resumeRec?.run_id].filter(Boolean) })
    for (const s of swept) emit({ type: "WORKTREE_ORPHAN_SWEPT", taskId, runId: taskRunId, worktreeId: s.id, dir: s.dir, note: s.reason })
  } catch { /* a broken registry must never break a task */ }
  // --- v91 ∞ CORE subsystems (shared, bounded, never a second truth) ------
  const bus91 = createBus({ taskId, persist: true })
  const handoffs91 = createHandoffLedger()
  const crewRouter = createCrewRouter({ cwd: process.cwd(), config })
  const crewModels = new Map() // "provider|model" → built provider (reuse, never rebuild)
  // reassignment budget: at most ONE successor per node per task (§35 — never
  // an infinite relay of doomed workers)
  const reassignBudget = new Map() // nodeId → count
  // Human decision engine (§40): asks ONLY on genuine decision points, never
  // nags (30-min per-key cooldown is inside the engine).
  const decisions91 = createDecisionEngine({
    cwd: process.cwd(), taskId,
    onWait: (d) => {
      emit({ type: "DECISION_REQUIRED", taskId, runId: taskRunId, decisionId: d.decision_id, type: d.type, title: d.title, question: d.question, options: d.options.map((o) => o.label), recommendation: d.recommendation, reason: d.reason })
    },
  })
  const provRef = { prov: provider }
  /** Build (and cache) an alternate provider for per-role model routing. */
  const buildProvider91 = async (cfg, name) => {
    try {
      const { buildProvider } = await import("./providers.js")
      const p = buildProvider(cfg, name)
      return p && p.model ? p : null
    } catch { return null }
  }

  const pluginStartedAtMs = pluginStartedAt ?? Date.now()
  const rawAgent = runAgent ?? (await import("./agent.js")).runAgent
  const agent = (opts) => rawAgent({ ...opts, pluginStartedAt: opts.pluginStartedAt ?? pluginStartedAtMs })
  const workersEnabled = workers ?? (!runAgent && config?.agent?.workers !== false)

  manager.configure({
    config, provider,
    runner: async ({ role, task: subTask, context, readOnly, signal: sig, dagNode, setModel }) => {
      // §36 specialist model routing: pick the provider/model whose measured
      // class best fits this ROLE (explorer→fast, coder→coding, debugger→
      // reasoning, reviewer→independent). Falls back to the run's provider on
      // any doubt — a routing failure must never fail the worker.
      let roleProv = provRef.prov
      if (config?.agent?.crewRouting !== false) {
        try {
          const cls = preferredClassFor(role)
          const rsel = selectModel(config, { task: subTask, preferredClass: cls })
          if (rsel?.decision?.provider && rsel.decision.provider !== provRef.prov?.name) {
            const key = `${rsel.decision.provider}|${rsel.decision.model}`
            if (!crewModels.has(key)) {
              const built = await buildProvider91(config, rsel.decision.provider)
              if (built) crewModels.set(key, built)
            }
            const p = crewModels.get(key)
            if (p) {
              roleProv = { ...p, model: rsel.decision.model }
              try { setModel?.(rsel.decision.model) } catch { }
              emit({ type: "CREW_MODEL_ROUTED", taskId, runId: taskRunId, nodeId: dagNode ?? null, role, model: rsel.decision.model, provider: rsel.decision.provider, class: cls })
            }
          }
        } catch { roleProv = provRef.prov }
      }
      // v95 worktreewise: a node registered in worktreeByNode executes in a
      // CHILD PROCESS whose cwd IS its own git worktree. agent.js binds
      // everything to process.cwd(), so a child per node is the only
      // race-free parallelism — and the writes can only land in the worktree.
      // The spec (with the provider key) is written mode 600 OUTSIDE the
      // worktree; the result JSON comes back the same way.
      const wt = dagNode ? worktreeByNode.get(String(dagNode)) : null
      if (wt) {
        const { runIsolatedNode } = await import("./worktree.js")
        return runIsolatedNode({
          dir: wt.dir,
          spec: {
            nodeId: String(dagNode), role: "coder", task: subTask,
            context: context ? `--- relevant project context (demand-loaded) ---\n${context}` : "",
            config, provider: roleProv, maxSteps: 10,
            taskId, runId: taskRunId, segmentId: `worktree-${dagNode}`,
          },
          timeoutMs: 1000 * 60 * 3, signal: sig ?? signal,
        })
      }
      return agent({
        config, provider: roleProv, task: subTask,
        taskId, runId: taskRunId, segmentId: `worker-${dagNode ?? role}`, nodeId: dagNode ?? null,
        extraContext: context ? `--- relevant project context (demand-loaded) ---\n${context}` : undefined,
        onEvent: segmentEvents(emit, `worker:${dagNode ?? role}`), signal: sig ?? signal,
        readOnly: readOnly !== false, maxStepsOverride: 10, worker: { role, dagNode },
        budgetHit: false,
        journal: false, suppressRunEvents: true,
      })
      // v93 gap fix: return the FULL agent result, not r.text — the worker
      // settlement (agentmanager) must see the agent's real outcome or an
      // exhausted worker looks like a completed one whose "findings" were
      // the budget-exhaustion text. Meta's §35 classifier now receives
      // status/budgetHit and reassigns instead of completing the node.
    },
  })

  // --- critical-persistence accounting (completion gate check #9) ----------
  // Every CRITICAL flush is recorded. A failure is surfaced, never swallowed:
  // the gate refuses COMPLETED when the terminal state did not reach disk.
  let criticalPersistenceSucceeded = true
  const persistCritical = () => {
    try {
      ts.flush(DURABILITY.CRITICAL)
    } catch (e) {
      criticalPersistenceSucceeded = false
      emit({ type: "CRITICAL_PERSISTENCE_FAILED", taskId, runId: taskRunId, error: String(e?.message ?? e) })
      return false
    }
    return true
  }

  // v94 masterwise: a PINNED segment size (explicit caller arg or config)
  // is honored verbatim; otherwise the ExecutionController sizes each
  // segment adaptively (§8) — task class, failure rate, resource pressure,
  // tool latency. A segment boundary is never a task boundary.
  const segStepsPinned = segmentSteps ?? config?.agent?.segmentSteps ?? null
  let maxSeg = maxSegments ?? config?.agent?.maxSegments ?? MAX_SEGMENTS_DEFAULT
  // P0 segment safety fuse: a continuation is a RESUME, not a failure. The
  // continuation budget bounds it so "resume later" cannot loop forever.
  const maxContinuations = config?.agent?.maxContinuations ?? AGENT_BUDGETS.maxContinuations
  // how many times this task has already been resumed after a safety fuse
  let continuationCount = Number(resumeRec?.continuation_count ?? 0) || 0

  // v94 fastwise: resolve the execution lane from signals forge already has
  // (task complexity + device tier from the resource manager) and feed the
  // EXISTING selection opts — one strategy engine, deterministic, offline.
  const lane = resolveLane({ task: state.objective, resources: { tier: resources?.state?.tier ?? null, burst: resources?.state?.burst === true } })
  const sel = selectModel(config, { task: state.objective, provider, latencyBudgetMs: lane.latencyBudgetMs, costBias: lane.costBias })
  const requiredCaps = sel?.capabilities ?? null
  let prov = provider
  if (sel?.decision && config?.agent?.modelStrategy !== false) {
    emit({ type: "MODEL_SELECTED", model: sel.decision.model, provider: sel.decision.provider, reason: sel.decision.reason, confidence: sel.decision.confidence, capabilities: sel.decision.capabilities, taskId, runId: taskRunId })
    ts.noteModel(sel.decision.provider, sel.decision.model, sel.decision.reason)
    if (sel.decision.provider !== provider?.name) {
      try {
        const { buildProvider } = await import("./providers.js")
        const np = buildProvider(config, sel.decision.provider)
        if (np && np.model) { prov = { ...np, model: sel.decision.model }; provRef.prov = prov; manager.configure({ config, provider: prov }) }
      } catch { }
    }
  } else {
    ts.noteModel(provider?.name ?? "?", provider?.model ?? "?", "active provider")
  }

  let resumeRecon = null
  if (resumeRec) {
    ts.transition(TASK_STATUS.RECOVERING, { reason: "resuming interrupted task" })
    emit({ type: "RECOVERY_STARTED", taskId, runId: taskRunId, objective: state.objective })
    resumeRecon = reconcileTask(resumeRec, { cwd: process.cwd() })
    emit({ type: "RECOVERY_COMPLETED", taskId, runId: taskRunId, recommended: resumeRecon.recommended, drift: resumeRecon.effects ? [resumeRecon.effects.missing.length, resumeRecon.effects.unknown.length] : [0, 0] })
    // v96 unifywise: the RESUME transition is now a real event (the Core's
    // lifecycle map records the RESUME phase from it; the bus binds task
    // history on it). Recovery finishing IS the resume — one truth, two views.
    emit({ type: "TASK_RESUMED", taskId, runId: taskRunId, fromCheckpoint: state.checkpoint_id ?? null, continuation: state.continuation_count ?? 0, recommended: resumeRecon.recommended })
    ts.decide("recovery", resumeRecon.recommended)
  }

  const riskLevel = riskForChange({ task: state.objective })
  const classified = classifyTask(state.objective, { resume: Boolean(resumeRec) })
  const omega = createKernel({ cwd: process.cwd() })
  omega.classify(state.objective, { resume: Boolean(resumeRec) })
  clearComposeOnce()
  let composedSnap = null
  const takeCompose = ({ refresh = false } = {}) => {
    if (composedSnap && !refresh) return composedSnap
    composedSnap = composeOnce(state.objective, {
      cwd: process.cwd(), config, klass: classified.class, includeMemory: true, refresh,
    })
    return composedSnap
  }
  ts.transition(TASK_STATUS.PLANNING, { reason: "building plan" })
  emit({ type: "TASK_STARTED", taskId, runId: taskRunId, objective: state.objective, risk: riskLevel, taskClass: classified.class, strategy: classified.strategy.class })
  emit({
    type: "TASK_CLASSIFIED",
    taskId, runId: taskRunId,
    class: classified.class,
    legacy: classified.legacy,
    confidence: classified.confidence,
    workflow: classified.strategy.workflow,
    plan: classified.strategy.plan,
    workers: classified.strategy.workers,
    verification: classified.strategy.verification,
    resume: Boolean(resumeRec),
    underlying: classified.underlying || null,
  })
  if (maxSegments == null && config?.agent?.maxSegments == null && classified.strategy.maxSegments) {
    maxSeg = classified.strategy.maxSegments
  }

  let planText = ""
  let planDefs = []
  // v99 loopwise: whether the planner already received ONE explicit revision
  // request (the cycle re-plan). The critique below stays advisory in that
  // case — the planner was already given feedback once this task; a second
  // revision pass in the same planning phase is diminishing returns.
  let plannerAlreadyRevised = false
  let planValidation = null
  let planRepaired = false
  // RESUME: the task already has a validated DAG on disk. Re-planning would
  // throw away the graph the interrupted run was executing (and pay for a
  // model call that can contradict it), so we restore instead.
  /**
   * v106 — carry a resumed run's NEW instruction into the plan.
   *
   * Two things were broken and they are the same bug. The instruction was
   * discarded (meta.js:124), and dag.invalidateNodes() — "COMPLETED nodes that
   * do not depend on invalidated ground truth are PRESERVED" — had no
   * production caller anywhere, which forge's own `selfaudit` reported.
   *
   * So: measure what the new instruction actually changes, invalidate only the
   * nodes that rest on the part that died, and leave everything else COMPLETED.
   * Not a restart, and not a silent continuation of work the user just
   * countermanded.
   */
  const restoredDAG = Boolean(resumeRec && state.dag)
  try {
    if (restoredDAG) {
      planDefs = []
      planValidation = { ok: true, errors: [], stage: "RESTORED", code: "RESTORED", recoverable: true }
      emit({ type: "PLAN_RESTORED", taskId, runId: taskRunId, nodes: state.dag?.nodes?.length ?? 0, reason: "resuming an interrupted task — the recorded DAG is authoritative" })
      // v94 masterwise (§17 continuity fix): setPlan persists an object
      // ({ steps, source, at }) — the resume path used to call .map() on it
      // directly, which threw "state.plan.map is not a function" and turned
      // EVERY fuse-parked (WAITING) resume into a fake "planning failed".
      // Accept both the historical array shape and the record shape.
      const restoredPlan = Array.isArray(state.plan)
        ? state.plan
        : (Array.isArray(state.plan?.steps) ? state.plan.steps : [])
      ts.setPlan(restoredPlan.map((p) => (typeof p === "string" ? p : p?.objective ?? p?.title ?? p?.id)), "resumed")
      ts.transition(TASK_STATUS.PLANNING, { reason: "plan restored from the task record" })
    }
    const fastPath = !restoredDAG && classified.strategy.plan === "synthesize" && classified.class === TASK_CLASS.MICRO
    const recoveryPath = !restoredDAG && classified.class === TASK_CLASS.RECOVERY
    const planLessons = (!restoredDAG && !fastPath && !recoveryPath)
      ? lessonsForPlan(state.objective, { cwd: process.cwd() })
      : { text: "", avoided: [], count: 0 }
    if (planLessons && !fastPath && !recoveryPath) {
      const extra = hardAvoid(state.objective, { cwd: process.cwd() })
      if (extra.length) planLessons.avoided = [...new Set([...(planLessons.avoided || []), ...extra])]
    }
    const lessonPrefix = planLessonsPrefix(planLessons)
    if (planLessons.count || planLessons.avoided.length) {
      emit({ type: "PLAN_LESSONS", taskId, runId: taskRunId, count: planLessons.count, avoided: planLessons.avoided.slice(0, 4) })
    }
    const planLangs = (!restoredDAG && !fastPath && !recoveryPath)
      ? languagesIn(state.objective, { cwd: process.cwd(), klass: classified.class })
      : []
    const langPrefix = formatLangReason(planLangs)
    if (planLangs.length) emit({ type: "PLAN_LANG", taskId, runId: taskRunId, langs: planLangs })
    // v92 §9 (wirewise): prediction-calibration feedback — real prediction
    // errors from earlier runs steer this plan. The master loop demands
    // "learn from incorrect predictions"; the ledger is the honest record.
    const predictionPrefix = (!restoredDAG && !fastPath && !recoveryPath)
      ? predictionsForPrompt(process.cwd())
      : ""
    if (predictionPrefix) {
      const cal = predictionCalibration(process.cwd())
      emit({ type: "PLAN_PREDICTION_CALIBRATION", taskId, runId: taskRunId, calibration: cal })
    }
    // v94 masterwise (§18 LONG PROMPT INTELLIGENCE): a very long objective is
    // ingested into requirement RECORDS (deterministic, ids R1..Rn) so that
    // compaction can never silently drop a requirement — they are retrieved
    // verbatim whenever needed. The planner prompt carries them explicitly.
    let requirementsPrefix = ""
    if (!restoredDAG && !fastPath && !recoveryPath && String(state.objective ?? "").length > 1500) {
      try {
        const reqs = engMem.ingestRequirements(state.objective)
        if (reqs.length) {
          requirementsPrefix = engMem.requirementsBlock(state.objective)
          emit({ type: "REQUIREMENTS_INGESTED", taskId, runId: taskRunId, count: reqs.length })
        }
      } catch { /* requirement extraction is best-effort */ }
    }
    // v94 knowwise: bounded KG bootstrap — the first task in a project without
    // a .ua/knowledge-graph.json writes a deterministic FLOOR graph (world-model
    // extractors; no LLM, no network) so the engmemory bridge and kg_query have
    // project knowledge from run one. A real understand-anything graph is
    // detected and NEVER touched. Deferred + unref'd so planning is never
    // delayed; every failure is swallowed (best-effort, off-path).
    if (!restoredDAG) {
      try {
        const kgTimer = setTimeout(() => {
          try {
            const kg = ensureKnowledgeGraph({ cwd: process.cwd() })
            if (kg?.ok && kg?.built) emit({ type: "KG_BOOTSTRAPPED", taskId, runId: taskRunId, files: kg.files, edges: kg.edges, truncated: !!kg.truncated })
          } catch { /* KG bootstrap is best-effort */ }
        }, 0)
        if (typeof kgTimer.unref === "function") kgTimer.unref()
      } catch { /* KG bootstrap is best-effort */ }
    }
    // v94 fastwise: idle warmup — persist the world-model snapshot and warm
    // the semantic chunk cache ONCE per freshness window, guided by the
    // likely-next prediction (objective + knowwise hubs). Deferred + unref'd
    // exactly like the KG bootstrap; FORGE_FASTWISE=0 turns it off; every
    // failure swallowed (best-effort, off-path, planning never delayed). The
    // KG floor graph itself is NOT re-warmed here — knowwise owns it.
    try {
      const fwTimer = setTimeout(() => {
        warmCaches({ cwd: process.cwd(), objectives: [String(state.objective ?? "")] })
          .then((fw) => {
            if (fw?.ok && !fw.cached && fw.warmed.length) emit({ type: "FASTWISE_WARMED", taskId, runId: taskRunId, warmed: fw.warmed, predicted: fw.predicted })
          })
          .catch(() => { /* fastwise warm is best-effort */ })
      }, 0)
      if (typeof fwTimer.unref === "function") fwTimer.unref()
    } catch { /* fastwise warm is best-effort */ }
    // v92 §5/§10 (wirewise): consult the semantic world model BEFORE planning.
    // Project shape + blast radius of files the objective names — bounded,
    // honest (degraded world says so), never fabricated.
    const worldPrefix = await (async () => {
      if (restoredDAG || fastPath || recoveryPath) return ""
      try {
        const world = createWorldModel({ cwd: process.cwd() })
        // v98 shipwise: the plan-time consult walks CHUNKED (never freezes the
        // TTY/bus on a six-figure repo) and opens the async-fresh window so
        // the summarize/impact/testsFor queries below don't re-walk per call
        await world.buildAsync()
        const lines = []
        const summary = world.summarize({ maxLines: 5 })
        if (summary) lines.push(String(summary))
        const mentions = [...String(state.objective ?? "").matchAll(/[\w./-]+\.[A-Za-z0-9]{1,6}/g)].map((m) => m[0]).slice(0, 6)
        const known = [...new Set(mentions)].filter((f) => { try { return fs.existsSync(path.resolve(process.cwd(), f)) } catch { return false } })
        if (known.length) {
          const abs = known.map((f) => path.resolve(process.cwd(), f))
          const imp = world.impact(abs)
          if (imp && !imp.unknown) {
            const importers = (imp.importers ?? []).slice(0, 6).map((i) => i.file ?? i.path ?? i)
            const tests = (imp.tests ?? []).slice(0, 4).map((t) => t.file ?? t.path ?? t)
            lines.push(`Blast radius of ${known.slice(0, 4).join(", ")}: radius ${imp.radius ?? "?"}${importers.length ? ` — importers: ${importers.join(", ")}` : ""}${tests.length ? ` — tests: ${tests.join(", ")}` : ""}`)
          }
          const tFor = world.testsFor(abs)
          if (tFor?.length && !imp?.tests?.length) lines.push(`Tests touching these files: ${tFor.slice(0, 4).join(", ")}`)
        }
        if (!lines.length) return ""
        return `--- world model (semantic project state) ---\n${lines.join("\n")}`.slice(0, 900)
      } catch { return "" }
    })()
    if (worldPrefix) emit({ type: "PLAN_WORLD_CONSULTED", taskId, runId: taskRunId, blastRadius: Boolean(worldPrefix.includes("Blast radius")) })
    const enginePrefix = (!restoredDAG && !fastPath && !recoveryPath)
      ? engineFor(state.objective, { cwd: process.cwd(), config, klass: classified.class })
      : ""
    if (enginePrefix) emit({ type: "PLAN_ENGINE", taskId, runId: taskRunId })
    let composePrefix = ""
    if (!restoredDAG && !fastPath && !recoveryPath) {
      try {
        const composed = takeCompose()
        composePrefix = formatCompose(composed)
        if (composePrefix) {
          emit({
            type: "PLAN_COMPOSE",
            taskId, runId: taskRunId,
            files: (composed.world?.files || []).slice(0, 8),
            avoid: (composed.avoid || []).slice(0, 4),
            verify: composed.verify?.command || "",
            skills: (composed.skills || []).map((s) => s.name).slice(0, 3),
            plugins: (composed.plugins || []).filter((p) => p && p.isolated && p.name).map((p) => p.name).slice(0, 4),
            playbook: String((composed.plugins || []).find((p) => p && p.isolated && p.repair)?.repair || "").slice(0, 160),
            playbooks: (composed.playbooks || []).map((p) => p.name).slice(0, 3),
            mcp: (composed.mcp || []).map((m) => m.name).slice(0, 4),
            gaps: (composed.gaps?.gaps || []).map((g) => g.id).slice(0, 4),
            claims: (composed.claims || []).slice(0, 3),
            decisions: (composed.decisions || []).slice(0, 3),
          })
        }
        try { persistGaps(process.cwd(), composed.gaps, { task: state.objective }) } catch { /* persist is best-effort */ }
      } catch { composePrefix = "" }
    }
    const planRes = restoredDAG || fastPath || recoveryPath ? null : await agent({
      config, provider: prov, signal,
      task: `${state.objective}\n\n${lessonPrefix ? `${lessonPrefix}\n\n` : ""}${langPrefix ? `${langPrefix}\n\n` : ""}${predictionPrefix ? `${predictionPrefix}\n\n` : ""}${worldPrefix ? `${worldPrefix}\n\n` : ""}${enginePrefix ? `${enginePrefix}\n\n` : ""}${composePrefix ? `${composePrefix}\n\n` : ""}${requirementsPrefix ? `${requirementsPrefix}\n\n` : ""}Produce a concise dependency-aware plan as a numbered list (one action per line). Mark read-only investigation steps and implementation steps. 4-8 steps. Do NOT execute.`,
      taskId, runId: taskRunId, segmentId: "seg-plan", nodeId: null,
      planOnly: true, readOnly: true, noTools: true, maxStepsOverride: 4, deep: deep ?? classified.strategy.deep,
      onEvent: passThrough(emit, "plan"), suppressRunEvents: true,
    })
    planText = planRes?.text ?? ""
    if (fastPath) {
      planDefs = synthesizePlan(state.objective, classified.class)
      planValidation = dagLib.validatePlan(planDefs)
      if (!planValidation.ok) {
        const repaired = dagLib.repairPlan(planDefs, state.objective, planValidation)
        if (repaired.ok) { planDefs = repaired.nodes; planValidation = dagLib.validatePlan(planDefs); planRepaired = true }
      }
      emit({
        type: "PLAN_SYNTHESIZED",
        taskId, runId: taskRunId,
        class: classified.class,
        nodes: planDefs.length,
        reason: `${classified.class} task — skip model planner`,
        items: planDefs.map((n, i) => ({ n: i + 1, text: n.title || n.objective || n.id, status: "todo" })),
      })
    } else if (recoveryPath) {
      // resume without a DAG: a 3-node inspect→patch→verify, no extra model call
      planDefs = synthesizePlan(state.objective, TASK_CLASS.SMALL)
      planValidation = dagLib.validatePlan(planDefs)
      if (!planValidation.ok) {
        const repaired = dagLib.repairPlan(planDefs, state.objective, planValidation)
        if (repaired.ok) { planDefs = repaired.nodes; planValidation = dagLib.validatePlan(planDefs); planRepaired = true }
      }
      emit({
        type: "PLAN_SYNTHESIZED",
        taskId, runId: taskRunId,
        class: classified.class,
        nodes: planDefs.length,
        reason: "RECOVERY without a recorded DAG — synthesised inspect→patch→verify",
        items: planDefs.map((n, i) => ({ n: i + 1, text: n.title || n.objective || n.id, status: "todo" })),
      })
    } else if (!restoredDAG) {
      planDefs = dagLib.parsePlanToDAG(planText)
      planValidation = dagLib.validatePlan(planDefs)
    }

    // P0 — an invalid plan must NEVER fall through into execution.
    // TASK → PLAN → SCHEMA → DEPENDENCIES → TARGETS → CONFLICTS →
    // VERIFICATION PLAN → DAG → EXECUTION.  Failure ⇒ REPAIR, or WAITING.
    // The old code transitioned to REPAIRING and then executed the *unrepaired*
    // plan anyway; and an EMPTY_PLAN silently became a generic single-node
    // mutation, which is exactly how a complex task got collapsed into "edit
    // one file". Now we actually repair, re-validate, and only continue on a
    // plan that passes.
    if (!planValidation.ok) {
      emit({ type: "PLAN_VALIDATION_FAILED", taskId, runId: taskRunId, errors: planValidation.errors, recoverable: planValidation.recoverable })
      let repair = dagLib.repairPlan(planDefs, state.objective, planValidation)
      // v21.1 P1 — a dependency CYCLE is a planning error, not something the
      // repair pass may "fix" by deleting an edge (that silently reorders
      // work the planner said must be ordered). Re-plan ONCE with the cycle
      // spelled out to the planner; if the second plan is still cyclic, stop
      // and wait for the user instead of executing a guessed order.
      if (!repair.ok && repair.needsReplan && !restoredDAG) {
        const cyc = repair.cycle
        emit({ type: "PLAN_CYCLE_DETECTED", taskId, runId: taskRunId, members: cyc.members, edges: cyc.edges, action: "re-plan" })
        ts.transition(TASK_STATUS.REPAIRING, { reason: `plan has a dependency cycle (${cyc.edges.join(", ").slice(0, 200)}) — re-planning` })
        plannerAlreadyRevised = true
        const replanRes = await agent({
          config, provider: prov, signal,
          task: `${state.objective}\n\nYour previous plan contained a DEPENDENCY CYCLE: ${cyc.edges.join(", ")} (steps ${cyc.members.join(", ")} depend on each other). A step may only depend on steps that come strictly before it. Produce a corrected, concise dependency-aware plan as a numbered list (one action per line, 4-8 steps, mark read-only investigation steps and implementation steps). Do NOT execute.`,
          taskId, runId: taskRunId, segmentId: "seg-replan", nodeId: null,
          planOnly: true, readOnly: true, noTools: true, maxStepsOverride: 4, deep,
          onEvent: passThrough(emit, "plan"), suppressRunEvents: true,
        })
        const replanText = replanRes?.text ?? ""
        const replanDefs = dagLib.parsePlanToDAG(replanText)
        const replanValidation = dagLib.validatePlan(replanDefs)
        emit({ type: "PLAN_REPLANNED", taskId, runId: taskRunId, ok: replanValidation.ok, code: replanValidation.code ?? null, nodes: replanDefs.length })
        if (replanValidation.ok || replanValidation.code !== "CYCLE_DETECTED") {
          planText = replanText
          planDefs = replanDefs
          planValidation = replanValidation
          repair = planValidation.ok ? { ok: false } : dagLib.repairPlan(planDefs, state.objective, planValidation)
          if (repair.needsReplan) repair = { ok: false } // still cyclic after non-cycle repair: stop below
        } else {
          repair = { ok: false }
          planValidation = replanValidation
        }
      }
      if (repair.ok) {
        planDefs = repair.nodes
        planValidation = dagLib.validatePlan(planDefs)
        planRepaired = true
        ts.transition(TASK_STATUS.REPAIRING, { reason: `plan repaired: ${repair.changes.join("; ").slice(0, 300)}` })
        emit({ type: "PLAN_REPAIRED", taskId, runId: taskRunId, changes: repair.changes, nodes: planDefs.length })
        ts.setNextAction(null)
      }
    }
    // still invalid after repair (or unrecoverable by construction) → WAITING
    if (!planValidation.ok) {
      ts.transition(TASK_STATUS.WAITING, { reason: `plan invalid: ${planValidation.errors.join("; ").slice(0, 300)}` })
      // v91 §40 — an unrepairable plan is a GENUINE decision point: record a
      // CLARIFICATION and put the task in WAITING_FOR_USER (resumable, never
      // a fake failure). The engine's anti-nag gate prevents repeats.
      try {
        const d = decisions91.ask({
          type: DECISION_TYPE.CLARIFICATION,
          title: "Plan needs your input",
          question: `The plan could not be validated: ${planValidation.errors.slice(0, 2).join("; ").slice(0, 300)}`,
          options: [
            { id: "restate", label: "Restate the objective with more detail", consequences: "I will re-plan from your clarified goal" },
            { id: "proceed-minimal", label: "Proceed with a minimal safe plan", consequences: "I will execute only the unambiguous parts" },
            { id: "cancel", label: "Cancel this task", consequences: "Task ends as CANCELLED" },
          ],
          recommendation: "restate",
          reason: "the planner could not produce a verifiable plan from the current objective",
          key: `plan-invalid-${classified.class}`,
        })
        if (d && !d.skipped) ts.transition(TASK_STATUS.WAITING_FOR_USER, { reason: `decision ${d.decision_id} pending: plan invalid` })
      } catch { }
      ts.setNextAction(`wait: plan invalid — ${planValidation.errors.slice(0, 3).join(", ")}`)
      ts.setPlan(planDefs, "invalid")
      persistCritical()
      return {
        taskId,
        runId: taskRunId,
        status: FINAL.WAITING,
        text: `plan validation failed: ${planValidation.errors.join("; ")}`,
        segments: 0,
        repairs: 0,
        toolCalls: 0,
        filesChanged: [],
        verification: { ok: false, missing: [], reason: "plan invalid" },
        planValidation,
        state: state.status,
        task: state,
      }
    }
    // v99 loopwise — the PLANNER quality gate: structure was validated
    // above; QUALITY was not. One deterministic critique (coverage vs the
    // objective's own terms, granularity, verification presence, read-only
    // balance); when majors exist, ONE bounded planOnly revision pass that
    // must beat the original score AND re-validate, else the original plan
    // stands. Fast-path synthesized plans (MICRO/SMALL/RECOVERY) are exempt —
    // deterministic by design, a revision model call would defeat the point.
    if (!restoredDAG && !fastPath && !recoveryPath && planDefs.length && planValidation.ok && config?.planner?.critique !== false) {
      try {
        const critique = critiquePlan({ objective: state.objective, planDefs, planText })
        if (critique.findings.length) {
          emit({ type: "PLAN_CRITIQUE", taskId, runId: taskRunId, findings: critique.findings.map((f) => `${f.severity}: ${f.id}`), score: Number(critique.score.toFixed(2)), advisory: plannerAlreadyRevised })
        }
        const revisionAsk = plannerAlreadyRevised ? null : planRevisionPrompt({ objective: state.objective, planText, findings: critique.findings })
        if (revisionAsk) {
          const revRes = await agent({
            config, provider: prov, signal, task: revisionAsk,
            taskId, runId: taskRunId, segmentId: "seg-plancritique", nodeId: null,
            planOnly: true, readOnly: true, noTools: true, maxStepsOverride: 4, deep,
            onEvent: passThrough(emit, "plan"), suppressRunEvents: true,
          })
          const revText = revRes?.text ?? ""
          let revDefs = dagLib.parsePlanToDAG(revText)
          let revValidation = dagLib.validatePlan(revDefs)
          // the revision gets the SAME structural repair the original plan
          // gets (e.g. "mutates but declares no verification requirement"
          // is repairable) — a revision must not be rejected for a defect
          // the pipeline already knows how to fix deterministically
          if (!revValidation.ok && revValidation.recoverable) {
            const revRepair = dagLib.repairPlan(revDefs, state.objective, revValidation)
            if (revRepair.ok) {
              revDefs = revRepair.nodes
              revValidation = dagLib.validatePlan(revDefs)
            }
          }
          if (revValidation.ok) {
            const revCritique = critiquePlan({ objective: state.objective, planDefs: revDefs, planText: revText })
            if (revCritique.score > critique.score) {
              planText = revText
              planDefs = revDefs
              planValidation = revValidation
              planRepaired = true
              emit({ type: "PLAN_REVISED", taskId, runId: taskRunId, reason: `quality critique: score ${critique.score.toFixed(2)} → ${revCritique.score.toFixed(2)}`, findingsBefore: critique.findings.length, findingsAfter: revCritique.findings.length, nodes: planDefs.length })
            } else {
              emit({ type: "PLAN_REVISION_REJECTED", taskId, runId: taskRunId, reason: `revision did not improve (score ${revCritique.score.toFixed(2)} ≤ ${critique.score.toFixed(2)}) — original stands` })
            }
          } else {
            emit({ type: "PLAN_REVISION_REJECTED", taskId, runId: taskRunId, reason: `revision failed validation (${revValidation.code ?? "invalid"}) — original stands` })
          }
        }
      } catch (e) {
        emit({ type: "PLAN_CRITIQUE", taskId, runId: taskRunId, error: String(e?.message ?? e).slice(0, 160) })
      }
    }
    if (!restoredDAG) ts.setPlan(planDefs.map((n) => n.objective ?? n.title ?? n.id), planRepaired ? "model+repaired" : "model")
  } catch (e) {
    ts.noteError("PLAN_FAILED", e?.message ?? String(e))
    planValidation = { ok: false, errors: [String(e?.message ?? e)], recoverable: true, code: "PLAN_EXCEPTION" }
    ts.transition(TASK_STATUS.WAITING, { reason: `planning failed: ${String(e?.message ?? e).slice(0, 200)}` })
    persistCritical()
    return {
      taskId,
      runId: taskRunId,
      status: FINAL.WAITING,
      text: `planning failed: ${String(e?.message ?? e)}`,
      segments: 0,
      repairs: 0,
      toolCalls: 0,
      filesChanged: [],
      verification: { ok: false, missing: [], reason: "planning failed" },
      state: state.status,
      task: state,
    }
  }

  let dag = null
  const persistDAG = () => { if (dag) ts.setDAG(dagLib.serializeDAG(dag)) }

  // v94 masterwise (§19–§24): the PREDICTIVE PLANNER — before the graph is
  // built, the validated plan is PREDICTED, SCORED and (when risky) compared
  // against alternatives. Deterministic: node shape + class prior + lesson
  // history + prediction calibration. Estimates, never proof — weak evidence
  // lowers the reported confidence instead of faking precision.
  let planRisk = null
  let liveRisk = null
  // v96 unifywise: §24 information-gain experiments captured at planning time
  // and injected into the FIRST segment's context (consumed once, then null).
  let planInfogain = null
  if (planDefs.length && !restoredDAG) {
    try {
      const evidence = gatherPlannerEvidence(process.cwd(), state.objective)
      planRisk = assessPlan(planDefs, {
        klass: classified.class,
        resources,
        calibration: evidence.calibration,
        lessons: evidence.lessons,
        task: state.objective,
        securitySensitive: riskLevel === "critical",
      })
      // §21 node-level predictions are stamped ONTO the nodes so they persist
      // with the graph (checkpoint/resume keeps them).
      const preds = predictNodes(planDefs, { klass: classified.class, lessons: evidence.lessons, calibration: evidence.calibration })
      for (const def of planDefs) {
        const p = preds.get(def.id)
        if (p) def.prediction = p
      }
      // §26 live risk starts at the plan estimate and is updated by reality
      liveRisk = createLiveRisk(planRisk.successProbability)
      emit({
        type: "PLAN_RISK_ASSESSED", taskId, runId: taskRunId,
        risk: planRisk.risk, riskLadder: planRisk.riskLadder,
        successProbability: planRisk.successProbability,
        uncertainty: planRisk.uncertainty, confidence: planRisk.confidence,
        factors: planRisk.factors, criticalPath: planRisk.criticalPath,
        estimatesNotProof: true,
        text: `plan risk ${planRisk.riskLadder} (${planRisk.risk}), success estimate ${Math.round(planRisk.successProbability * 100)}% (confidence: ${planRisk.confidence})`,
      })
      // §23 alternative plans — only for high-risk plans. v94 deepwise: the
      // original plan now COMPETES as a candidate, and the winning shape is
      // actually ADOPTED when it beats the original by a meaningful margin at
      // equal-or-better risk and success (adoptDecision — deterministic, no
      // model call). The adopted defs flow into the DAG below: the guard node
      // (inspect/verify) becomes real executed work, not advice.
      if (planRisk.riskLadder === "high" || planRisk.riskLadder === "critical") {
        const alts = alternatives(planRisk, planDefs)
        if (alts?.recommended) {
          let adoptedName = null, adoptWhy = ""
          const decision = adoptDecision(alts)
          if (decision.adopt && Array.isArray(alts.winnerDefs) && alts.winnerDefs.length) {
            try {
              planDefs = alts.winnerDefs
              planRisk = assessPlan(planDefs, {
                klass: classified.class,
                resources,
                calibration: evidence.calibration,
                lessons: evidence.lessons,
                task: state.objective,
                securitySensitive: riskLevel === "critical",
              })
              const preds2 = predictNodes(planDefs, { klass: classified.class, lessons: evidence.lessons, calibration: evidence.calibration })
              for (const def of planDefs) {
                const p = preds2.get(def.id)
                if (p) def.prediction = p
              }
              liveRisk = createLiveRisk(planRisk.successProbability)
              adoptedName = decision.name
              adoptWhy = decision.why
            } catch { /* adoption is advisory — on any failure keep the original plan */ }
          }
          emit({
            type: "PLAN_ALTERNATIVES", taskId, runId: taskRunId,
            recommended: alts.recommended.name, basis: alts.basis,
            variants: alts.all, adopted: adoptedName,
            ...(adoptedName ? { why: adoptWhy, successProbability: planRisk.successProbability } : {}),
            note: adoptedName
              ? `executing the ${adoptedName} shape — ${adoptWhy}`
              : "executing the original plan; alternatives recorded for replan decisions",
          })
        }
      }
      // §24 information gain — when uncertainty is high, run the CHEAPEST
      // uncertainty-reducing experiment first. v96 unifywise: this used to be
      // computed-then-ignored — the comment said "the planner prompt carries
      // it" but the planner prompt was already built before assessment ran.
      // The experiments are now CAPTURED and injected into the FIRST segment's
      // context, so the uncertainty reduction actually happens before the
      // first mutation (planner prompt ordering fixed the honest way).
      const ig = informationGainExperiments({ assessment: planRisk, planDefs, knowledgeGaps: composedSnap?.gaps?.gaps ?? [] })
      if (ig.needed) {
        planInfogain = ig
        emit({ type: "PLAN_INFOGAIN", taskId, runId: taskRunId, why: ig.why, experiments: ig.experiments, carriedInto: "segment-1" })
      }
    } catch (e) {
      emit({ type: "PLAN_RISK_ASSESSMENT_FAILED", taskId, runId: taskRunId, error: String(e?.message ?? e).slice(0, 160) })
    }
  }

  // v96 unifywise (§9/taskmodel): FEED THE ORIGIN-TAG LEDGER. Only
  // seedFromObjective ever ran, so review's NO_ASSUMPTION_AS_REQUIREMENT
  // check always saw an empty list — a ledger that exists but is never fed is
  // a dead check. Plan nodes that SPEAK in assumptions now become ASSUMPTION
  // entries (the promotion lattice keeps them from ever being treated as
  // REQUIREMENTs), and mutating nodes declare IMPLEMENTATION intent. Bounded
  // (≤8 assumptions, ≤12 implementations), deterministic, advisory-only.
  try {
    const ASSUMPTION_SPEAK = /\b(assum\w*|presumab\w*|should work|expects? to|likely|probably|might be|guess(?:ing)?|if (?:it|they) (?:is|are))\b/i
    let fedA = 0, fedI = 0
    for (const n of planDefs.slice(0, 24)) {
      const text = String(n.objective ?? n.title ?? "").trim()
      if (!text) continue
      if (fedA < 8 && ASSUMPTION_SPEAK.test(text)) {
        omega.tasks.add({ tag: "ASSUMPTION", text: `plan node ${n.id}: ${text.slice(0, 180)}`, source: "plan", files: n.targetFiles ?? [] })
        fedA++
      } else if (fedI < 12 && n.read_only !== true) {
        omega.tasks.add({ tag: "IMPLEMENTATION", text: `implement via node ${n.id}: ${text.slice(0, 180)}`, source: "plan", files: n.targetFiles ?? [] })
        fedI++
      }
    }
    if (fedA) emit({ type: "TASKMODEL_FED", taskId, runId: taskRunId, assumptions: fedA, implementations: fedI, note: "plan-derived assumptions tagged — they can never be promoted to requirements" })
  } catch { /* the origin-tag ledger is advisory for the review check */ }

  try {
    if (planDefs.length) {
      dag = (resumeRec && state.dag && dagLib.deserializeDAG(state.dag)) || dagLib.buildDAG(planDefs)
      invalidateForResume(dag)
      persistDAG()
      emit({ type: "DAG_BUILT", taskId, runId: taskRunId, nodes: dag.order.length, graph: dagLib.serializeDAG(dag) })
      // v91 §3: plan + DAG exist and are valid — the task is READY.
      ts.transition(TASK_STATUS.READY, { reason: `plan valid, ${dag.order.length} DAG node(s) ready` })
      bus91.send({ sender: "core", receiver: "*", type: MESSAGE_TYPE.PROGRESS, content: `plan ready: ${dag.order.length} node(s)`, priority: 1 })
    } else if (state.dag) {
      // A RESTORED DAG takes this branch, not the one above: `restoredDAG`
      // sets planDefs = [] precisely because the recorded graph is
      // authoritative. That is the branch a resume with a changed requirement
      // actually lands in, so the invalidation has to happen here too.
      dag = dagLib.deserializeDAG(state.dag)
      if (invalidateForResume(dag)) persistDAG()
    }
  } catch (e) {
    ts.noteError("DAG_FAILED", e?.message ?? String(e))
    // P0: if plan parsing or validation fails, do NOT silently execute without orchestration
    // Use REPAIR or WAITING depending on recoverability
    if (planValidation && !planValidation.recoverable) {
      ts.transition(TASK_STATUS.WAITING, { reason: `DAG build failed: ${e?.message}` })
      emit({ type: "DAG_BUILD_FAILED", taskId, runId: taskRunId, error: e?.message, recoverable: false })
      persistCritical()
      return {
        taskId,
        runId: taskRunId,
        status: FINAL.WAITING,
        text: `DAG build failed: ${e?.message}`,
        segments: 0,
        repairs: 0,
        toolCalls: 0,
        filesChanged: [],
        verification: { ok: false, missing: [], reason: "DAG invalid" },
        state: TASK_STATUS.WAITING,
        task: state,
      }
    } else {
      ts.transition(TASK_STATUS.REPAIRING, { reason: `DAG build failed: ${e?.message}` })
      emit({ type: "DAG_BUILD_FAILED", taskId, runId: taskRunId, error: e?.message, recoverable: true })
      // fallback to single-node DAG for repair path
      try {
        dag = dagLib.buildDAG([{ id: "n1", objective: state.objective, dependencies: [], priority: 100, role: "coder", read_only: false }])
        persistDAG()
      } catch {}
    }
  }

  let segment = 0
  let finalStatus = FINAL.FAILED
  let finalText = ""
  let finalState = null
  let consecutiveFailures = 0
  // v94 masterwise: worker node completions this run (feeds stuck detection —
  // settled workers count as progress even when the main segment mutates nothing)
  let workerCompletionsTotal = 0
  let repairCount = 0
  let replanCount = 0
  let evidenceRequests = 0
  // v99 loopwise: the most recent read-only verifier report (threaded into
  // repairSegment so the fixer sees the defects that were already observed)
  let lastVerifierReport = null
  // v99 loopwise: post-mutation code-review budget (config: review.maxPerTask,
  // default 4 — the reviewer pass is one bounded read-only agent run each)
  let codeReviewsDone = 0
  let totalToolCalls = 0
  const changedFiles = new Set()
  const seenExisting = new Set()
  const deletedFiles = new Set()
  const mutatingCommands = new Set()
  const affectedSymbols = []
  const requiredActions = new Set()
  const maxRepairs = config?.agent?.maxRepairs ?? 6
  /** Last completion-gate verdict (for the audit trail / return value). */
  let lastGate = null

  const addRequiredAction = (a) => { if (a) requiredActions.add(String(a).slice(0, 400)) }
  const clearRequiredActions = () => requiredActions.clear()
  // v99 loopwise FIX (latent v94 bug): required actions were add-only until
  // whole-gate success — a `review:` blocker added at attempt #1 survived a
  // CLEAN re-review at attempt #2 and deadlocked the task into WAITING.
  // The recurring prefixes below are all re-derived inside attemptCompletion
  // on every attempt, so they are dropped at the top of each attempt and
  // re-added only while still true. Event-driven actions (recover:,
  // reconcile:) are NOT recurring and stay sticky.
  const RECURRING_ACTION_PREFIXES = ["review: ", "requirement ", "codereview: ", "critical-risk runtime validation: "]
  const refreshRecurringActions = () => { for (const p of RECURRING_ACTION_PREFIXES) for (const a of [...requiredActions]) if (a.startsWith(p)) requiredActions.delete(a) }

  /** P0: no mutation boundary may be crossed while a worker is still alive. */
  const settleWorkers = async (graceMs) => {
    const ms = graceMs == null ? fanoutWaitMs(resources.state.tier, resources.state) : graceMs
    try {
      const res = await manager.settle({ graceMs: ms })
      if (!res.settled) {
        emit({ type: "WORKER_ORPHANED", taskId, runId: taskRunId, stillRunning: res.stillRunning, reason: "workers still alive at a mutation boundary" })
      }
      return res
    } catch (e) {
      ts.noteError("WORKER_SETTLE_FAILED", String(e?.message ?? e))
      return { settled: false, stillRunning: [], error: String(e?.message ?? e) }
    }
  }

  /** Drift between expected and observed effects (crash-resume reconciliation). */
  /**
   * Recovery drift = something is genuinely UNRESOLVED from the interrupted
   * run: a file the task said it changed is gone, an operation ended with an
   * unknown status, or git was left mid-operation. Those need an operator.
   *
   * "inspect" alone is NOT drift: it is also recommended when there is simply
   * nothing to prove (no checkpoints, a task paused in WAITING). Blocking
   * completion on that would freeze an otherwise healthy resume forever.
   */
  const recoveryDrift = () => {
    const fx = resumeRecon?.effects
    if (fx && ((fx.missing?.length ?? 0) > 0 || (fx.unknown?.length ?? 0) > 0)) return true
    const git = fx?.git
    if (git?.operation && ["merge", "rebase", "cherry-pick", "revert", "bisect"].includes(git.operation)) return true
    return false
  }
  const recoveryGateState = () => {
    if (!resumeRecon) return null
    return {
      recommended: resumeRecon.recommended,
      unverified: resumeRecon.unverified ?? 0,
      clear: !recoveryDrift() && !/ask_user|abort|compensate/.test(String(resumeRecon.recommended ?? "")),
    }
  }
  if (resumeRecon && recoveryDrift()) addRequiredAction(`reconcile: ${resumeRecon.recommended}`)

  /**
   * Complete a node ONLY when the ledger proves its verification passed for the
   * current risk. Used after execution, after an explicit verification pass and
   * after a repair — one rule, one place.
   */
  const completeNodeIfVerified = (nodeId, { risk, segmentId = null, phase = "post-segment" } = {}) => {
    if (!dag || !nodeId) return false
    try {
      const rel = [...changedFiles].map((f) => path.relative(process.cwd(), f))
      const st = ledger.status(risk, rel, { nodeId })
      if (!st.ok || st.anyFailure) return false
      const last = (st.evidence ?? []).filter((e) => e.passed).slice(-1)[0] ?? null
      const okDone = dagLib.markCompleted(dag, nodeId, `verified (${risk})`, {
        verification: { verification_id: last?.verificationId ?? `ver-${phase}-${nodeId}` },
      })
      if (okDone) {
        emit({ type: "DAG_NODE_COMPLETED", taskId, runId: taskRunId, segmentId, nodeId, verified: true, risk, phase })
        persistDAG()
      }
      return okDone
    } catch { return false }
  }

  /** Recompute the final risk from what actually changed (never lowers it). */
  const recomputeFinalRisk = () => finalRiskForChange({
    task: state.objective,
    initialRisk: riskLevel,
    changedFiles: [...changedFiles].map((f) => path.relative(process.cwd(), f)),
    createdFiles: (state.files_created ?? []).map((f) => path.relative(process.cwd(), f)),
    deletedFiles: [...deletedFiles].map((f) => path.relative(process.cwd(), f)),
    affectedSymbols,
    commands: [...mutatingCommands],
  })

  /**
   * THE completion gate (P0). Nothing else may declare COMPLETED.
   * @returns {{done: boolean, gate: object}}
   */
  const attemptCompletion = async ({ text, segment = 0, segmentId = null, nodeId = null } = {}) => {
    // v99 loopwise: recurring required actions are re-derived below — clear
    // the stale copies from earlier attempts first (see refreshRecurringActions)
    refreshRecurringActions()
    // 1. never complete while a worker is alive
    await settleWorkers()
    const fr = recomputeFinalRisk()
    const changedRel = [...changedFiles].map((f) => path.relative(process.cwd(), f))
    const vv = ledger.status(fr.risk, changedRel)
    // v94 masterwise (§28): RISK-BASED VERIFICATION — the intensity follows
    // the FINAL risk: LOW targeted; MEDIUM +regression; HIGH +integration;
    // CRITICAL full relevant verification + ADVERSARIAL REVIEW + runtime
    // validation. The class strategy may require review earlier; critical
    // risk always does.
    const vPlan = verificationPlanForRisk(fr.risk)
    const needReview = classified.strategy.requireReview || vPlan.adversarialReview
    if (needReview) {
      // v91 §3: REVIEWING is a real, persisted state before completion.
      ts.transition(TASK_STATUS.REVIEWING, { reason: "adversarial final review" })
      emit({ type: "REVIEW_STARTED", taskId, runId: taskRunId, segmentId, nodeId, class: classified.class })
      let rev = { required: true, ok: true, findings: [], blockers: [], checks: [] }
      try {
        const filesAbs = changedRel.map((f) => path.resolve(process.cwd(), f))
        const impactForReview = filesAbs.length ? omega.impact(filesAbs) : {}
        rev = omega.review({
          klass: classified.class,
          objective: state.objective,
          files: changedRel,
          impact: impactForReview,
          verificationOk: vv.ok,
          checkpoint: state.last_checkpoint_id ?? null,
        })
      } catch { /* review is a checklist; never throw out of completion */ }
      emit({
        type: "REVIEW_COMPLETED", taskId, runId: taskRunId, segmentId, nodeId,
        ok: rev.ok, required: rev.required, findings: (rev.findings || []).map((f) => f.id),
        blockers: (rev.blockers || []).map((b) => b.id), checks: rev.checks || [],
      })
      for (const b of rev.blockers || []) addRequiredAction(`review: ${b.id}${b.detail ? ` (${b.detail})` : ""}`)
    }
    // v96 unifywise (§9 requirement traceability → §45 "requirements
    // satisfied"): every ingested REQUIREMENT must be ADDRESSED by real work —
    // a completed node's objective, a changed file, or verification evidence.
    // An uncovered requirement becomes a REQUIRED ACTION, which blocks the
    // gate through the existing noPendingRequiredActions check (the same path
    // review blockers take — no second gate, no new state store). Tasks that
    // never ingested requirements (short objectives) see zero requirements and
    // the check is a no-op — fast paths are untouched.
    let reqCoverage = null
    try {
      const reqs = engMem.requirementRecords?.() ?? []
      if (reqs.length) {
        const nodeObjectives = dag
          ? [...dag.nodes.values()].filter((n) => n.status === dagLib.NODE_STATUS.COMPLETED).map((n) => String(n.objective ?? ""))
          : []
        const evidenceTexts = (ledger.all?.() ?? []).map((r) => String(r.evidence ?? r.command ?? ""))
        reqCoverage = requirementCoverage(reqs, {
          nodeObjectives,
          changedFiles: changedRel,
          verificationEvidence: evidenceTexts,
        })
        for (const u of reqCoverage.uncovered.slice(0, 4)) {
          addRequiredAction(`requirement ${u.id ?? "?"} not addressed by any completed work: ${u.text.slice(0, 90)}`)
        }
      }
    } catch { /* coverage is a gate input; its failure must not bypass the gate */ }
    // v98 shipwise — RUNTIME/ARTIFACT EVIDENCE (the declared-then-ignored
    // fix): plannerisk.verificationPlanForRisk promises runtimeValidation at
    // CRITICAL risk, but nothing ever enforced it. Now: when the plan tier
    // demands runtime validation AND the run mutated files AND the project
    // has a PROVEN build command (adapter-gated, never invented), observed
    // artifacts become ledger evidence — and their ABSENCE becomes a required
    // action the gate refuses to complete over. A plain repo with no adapter
    // or no build command is never asked for an artifact.
    try {
      if (vPlan.runtimeValidation && changedRel.length) {
        // A4: the run window starts at task start — only artifacts THIS run
        // produced/updated count as runtime evidence (a dist/ left over from
        // a previous build is not evidence this run built anything)
        const ae = artifactRuntimeEvidence(process.cwd(), { since: pluginStartedAtMs ?? null })
        if (ae?.applicable) {
          if (ae.passed) {
            const rec = ledger.recordCommand(`artifact-observe ${ae.buildCommand}`, ae.evidence, {
              type: VTYPE.ARTIFACT,
              exitCode: 0,
              affectedFiles: changedRel.slice(0, 40),
              taskId,
              nodeId,
              segmentId,
              verificationEpoch: state.verification_epoch ?? 0,
            })
            ts.noteVerification(rec)
            emit({ type: "VERIFICATION_PASSED", taskId, runId: taskRunId, segmentId, nodeId, vtype: rec.type, command: rec.command, exitCode: 0, evidence: rec.evidence, verificationId: rec.verification_id })
          } else {
            addRequiredAction(`critical-risk runtime validation: no build artifact observed for the proven build command "${ae.buildCommand}" — run the build (or provide runtime evidence) before completion`)
          }
        }
      }
    } catch { /* artifact evidence is best-effort; its failure must not bypass the gate */ }
    const gate = canCompleteTask({
      planValid: planValidation ? planValidation.ok !== false : true,
      planErrors: planValidation?.errors ?? [],
      dag,
      dagValid: Boolean(dag),
      workersSettled: manager.stats().active === 0,
      activeWorkers: manager.stats().active,
      verification: vv,
      verificationRequired: !(changedFiles.size === 0 || fr.risk === "trivial"),
      recovery: recoveryGateState(),
      pendingRequiredActions: [...requiredActions],
      finalStateReconciled: !recoveryDrift(),
      criticalPersistenceSucceeded,
      cancelled: Boolean(signal?.aborted),
      repairBudgetRemaining: repairCount < maxRepairs,
      optionalPolicy: config?.agent?.optionalNodePolicy ?? "ignore",
    })
    lastGate = gate
    emit({
      type: "COMPLETION_GATE", taskId, runId: taskRunId, segmentId, nodeId,
      ok: gate.ok, status: gate.status, checks: gate.checks, blockers: gate.blockers,
      finalRisk: fr.risk, initialRisk: fr.initialRisk,
      ...(reqCoverage ? { requirements: { total: reqCoverage.total, covered: reqCoverage.covered, uncovered: reqCoverage.uncovered.slice(0, 4).map((u) => u.id ?? u.text.slice(0, 60)) } } : {}),
      verificationPlan: { level: vPlan.level, targeted: vPlan.targeted, regression: vPlan.regression, integration: vPlan.integration, adversarialReview: vPlan.adversarialReview, runtimeValidation: vPlan.runtimeValidation },
      planRisk: planRisk ? { riskLadder: planRisk.riskLadder, successProbability: planRisk.successProbability, confidence: planRisk.confidence } : null,
      liveSuccessProbability: liveRisk ? liveRisk.get() : null,
    })
    if (!gate.ok) return { done: false, gate }
    finalStatus = explicitFinalization(FINAL.COMPLETED)
    finalState = TASK_STATUS.COMPLETED
    finalText = text ?? "task completed"
    clearRequiredActions()
    ts.setNextAction(null)
    ts.transition(TASK_STATUS.COMPLETED, { reason: "completion gate satisfied", durability: DURABILITY.CRITICAL })
    emit({ type: "TASK_COMPLETED", taskId, runId: taskRunId, segment, segmentId, nodeId, text: String(finalText).slice(0, 400), verification: vv.status, finalRisk: fr.risk, gate: gate.checks })
    // v98 shipwise — VERIFIED GIT DELIVERY. The ONLY commit path in the
    // kernel, structurally after the 9-check gate said ok. Best-effort by
    // law: a skipped/failed delivery NEVER flips the task status — the
    // pre-v98 behavior (verified files in the working tree, undo-able via
    // checkpoints) is exactly the fallback. Default policy is OFF.
    try {
      const ship = await maybeShip({
        root: process.cwd(),
        config,
        taskId,
        runId: taskRunId,
        objective: state.objective,
        changedFiles: changedRel,
        verificationStatus: vv.status,
        finalRisk: fr.risk,
        gate,
        ask: (spec) => decisions91.ask(spec),
      })
      if (ship?.shipped) {
        emit({ type: "GITSHIP_COMMITTED", taskId, runId: taskRunId, segmentId, nodeId, sha: ship.sha ?? null, files: (ship.files ?? []).slice(0, 20), branch: ship.branch ?? null, pushed: Boolean(ship.pushed), idempotent: Boolean(ship.idempotent), foreignDirtyFiles: ship.foreignDirtyFiles ?? [], prPath: ship.prPath ?? null, text: String(ship.reason ?? "").slice(0, 300) })
        lastGate = { ...gate, gitship: { shipped: true, sha: ship.sha ?? null } }
      } else {
        emit({ type: "GITSHIP_SKIPPED", taskId, runId: taskRunId, segmentId, nodeId, reason: String(ship?.reason ?? "unknown").slice(0, 200) })
      }
    } catch (e) {
      try { emit({ type: "GITSHIP_SKIPPED", taskId, runId: taskRunId, segmentId, nodeId, reason: `delivery error (task stays COMPLETED): ${String(e?.message ?? e).slice(0, 160)}` }) } catch { }
    }
    // v94 masterwise (§16/§17): consolidation — raw events → observations →
    // verified facts → reusable knowledge; provenance and evidence preserved.
    try {
      const cons = engMem.onTaskCompleted({ verification: vv, files: changedRel, summary: String(finalText ?? "").slice(0, 300) })
      emit({ type: "MEMORY_CONSOLIDATED", taskId, runId: taskRunId, segmentId, nodeId, merged: cons.merged, contradictions: cons.contradictions, total: cons.total })
    } catch { /* memory consolidation is best-effort */ }
    try {
      const evo = evolveRun({
        cwd: process.cwd(),
        task: state.objective,
        klass: classified.class,
        gate,
        files: changedRel,
        command: (focusedVerify(process.cwd(), changedRel || []).command
          || composedSnap?.verify?.command
          || ""),
      })
      const line = formatEvolve(evo)
      if (line) emit({ type: "STRATEGY_EVOLVED", taskId, runId: taskRunId, segmentId, nodeId, score: evo.score, skill: evo.skill?.name || null, skipped: evo.skill?.skipped || null, avoid: (evo.avoid || []).slice(0, 4), text: line })
    } catch { /* evolution is best-effort — never block COMPLETED */ }
    return { done: true, gate }
  }

  /** The gate refused completion: move to the safe state it recommended. */
  const refuseCompletion = async ({ v, segment = 0, segmentId = null, nodeId = null, finalRiskLevel = "medium", text = "" } = {}) => {
    const gate = lastGate ?? { status: "WAITING", blockers: [], reasons: [] }
    const status = gate.status
    emit({
      type: "TASK_BLOCKED", taskId, runId: taskRunId, segment, segmentId, nodeId,
      status, missing: v?.missing ?? [], risk: finalRiskLevel, blockers: gate.blockers,
    })

    // The gate exists to prevent a FALSE COMPLETED, not to stop useful work.
    // When the only thing missing is "more nodes to finish / more evidence"
    // and the DAG can still make progress, keep executing the next node.
    // Anything structural (live workers, invalid plan/DAG, uncleared recovery,
    // failed persistence, a failed node) never continues — it settles safely.
    const progressBlockers = new Set([
      GATE_CHECK.ALL_REQUIRED_NODES_COMPLETE,
      GATE_CHECK.VERIFICATION_SATISFIED,
      GATE_CHECK.NO_PENDING_REQUIRED_ACTIONS,
    ])
    const onlyProgressBlockers = gate.blockers.every((b) => progressBlockers.has(b.check))
    let canProgress = false
    if (dag) {
      try { canProgress = dagLib.readyNodes(dag).length > 0 && !dagLib.isStalled(dag) } catch { canProgress = false }
    }
    if (onlyProgressBlockers && canProgress && segment < maxSeg) {
      ts.transition(TASK_STATUS.EXECUTING, { reason: `continuing: ${gate.reasons.slice(0, 2).join("; ").slice(0, 200)}` })
      return { done: false, gate }
    }

    // REPAIRING: there is still repair budget — try once, then keep looping.
    if (status === "REPAIRING" && repairCount < maxRepairs) {
      ts.transition(TASK_STATUS.REPAIRING, { reason: gate.reasons.join("; ").slice(0, 300) })
      const recovered = await repairSegment({
        agent, config, provider: prov, signal, emit, state,
        error: gate.reasons.join("; ") || v?.reason || "completion gate refused",
        segment, ts, ledger, ctxEngine, verification: v, taskRunId, taskId, segmentId, nodeId,
        finalRisk: finalRiskLevel, liveRisk, episodeSink, verifierReport: lastVerifierReport,
      })
      repairCount += recovered ? 1 : 0
      ts.noteRepair(recovered ? 1 : 0)
      ts.transition(TASK_STATUS.EXECUTING, { reason: "after completion-gate repair" })
      return { done: false, gate }
    }

    // RECOVERING: drift or unresolved recovery — go through RECOVERING state.
    if (status === "RECOVERING") {
      ts.transition(TASK_STATUS.RECOVERING, { reason: gate.reasons.join("; ").slice(0, 300) })
      addRequiredAction(`recover: ${gate.reasons.slice(0, 2).join("; ")}`)
    }

    const mapped = status === "FAILED" ? FINAL.FAILED
      : status === "CANCELLED" ? FINAL.CANCELLED
        : FINAL.WAITING
    finalStatus = explicitFinalization(mapped)
    finalState = (status === "RECOVERING" || status === "REPAIRING") ? TASK_STATUS.WAITING : (TASK_STATUS[status] ?? TASK_STATUS.WAITING)
    finalText = text
      ? `${text}`
      : `not completed — ${gate.reasons.slice(0, 3).join("; ")}`
    if (mapped === FINAL.WAITING) {
      ts.setNextAction(`wait: ${gate.reasons.slice(0, 2).join("; ").slice(0, 300)}`)
      ts.transition(TASK_STATUS.WAITING, { reason: gate.reasons.join("; ").slice(0, 300) })
    } else if (mapped === FINAL.FAILED) {
      ts.transition(TASK_STATUS.FAILED, { reason: gate.reasons.join("; ").slice(0, 300) })
    } else {
      ts.transition(TASK_STATUS.CANCELLED, { reason: "user cancel" })
    }
    persistCritical()
    return { done: true, gate }
  }

  ts.transition(TASK_STATUS.EXECUTING, { reason: "starting segments" })

  /** v28: rewrite remaining DAG from verification evidence. MICRO never. At most maxReplans. */
  const tryMidTaskReplan = async ({ reason, evidence, stuck = false }) => {
    let escalate = false
    let causalHint = ""
    try {
      const next = omega?.nextRepair?.()
      escalate = next?.action === "escalate"
      if (next?.causal?.node) causalHint = `${next.causal.layer}: ${next.causal.node.description}`
    } catch {}
    if (!shouldReplan({
      klass: classified.class,
      repairCount,
      consecutiveFailures,
      replanCount,
      profile: resources.state,
      escalate,
      stuck,
    })) return { ok: false }
    if (!dag) return { ok: false }
    // v91 §3/§74: evidence changed the situation — REPLANNING is the honest
    // state before the planner rebuilds the remaining graph.
    ts.transition(TASK_STATUS.REPLANNING, { reason: String(reason ?? "").slice(0, 200) || "evidence invalidated the plan" })
    const completed = [...dag.nodes.values()].filter((n) => n.status === dagLib.NODE_STATUS.COMPLETED)
    const failed = [...dag.nodes.values()].filter((n) => n.status !== dagLib.NODE_STATUS.COMPLETED)
    const planL = lessonsForPlan(state.objective, { cwd: process.cwd() })
    const langBlock = formatLangReason(languagesIn(state.objective, { cwd: process.cwd(), klass: classified.class }))
    const engineBlock = engineFor(state.objective, { cwd: process.cwd(), config, klass: classified.class })
    let composeBlock = ""
    try {
      composeBlock = formatCompose(takeCompose({ refresh: true }))
    } catch { composeBlock = "" }
    const prompt = replanPrompt({
      objective: state.objective,
      reason,
      evidence,
      completed,
      failed,
      lessons: [planL.text, langBlock, engineBlock, composeBlock].filter(Boolean).join("\n\n"),
      avoided: planL.avoided,
      causal: causalHint,
    })
    emit({
      type: "PLAN_REPLAN_STARTED",
      taskId, runId: taskRunId,
      reason: String(reason ?? "").slice(0, 240),
      kept: completed.length,
      dropped: failed.length,
      attempt: replanCount + 1,
    })
    ts.transition(TASK_STATUS.REPAIRING, { reason: "mid-task replan from verification evidence" })
    let replanRes
    try {
      replanRes = await agent({
        config, provider: prov, signal,
        task: prompt,
        taskId, runId: taskRunId, segmentId: `seg-replan-${replanCount + 1}`, nodeId: null,
        planOnly: true, readOnly: true, noTools: true, maxStepsOverride: 4,
        deep: classified.strategy.deep,
        onEvent: passThrough(emit, "replan"), suppressRunEvents: true,
      })
    } catch (e) {
      emit({ type: "PLAN_REPLANNED", taskId, runId: taskRunId, ok: false, reason: "verification", error: String(e?.message ?? e).slice(0, 200) })
      return { ok: false }
    }
    const defs = dagLib.parsePlanToDAG(replanRes?.text ?? "")
    const result = dagLib.replanRemaining(dag, defs, {
      prefix: `rp${replanCount + 1}_`,
      reason: String(reason ?? "verification"),
      evidence: String(evidence ?? "").slice(0, 600),
      objective: state.objective,
      creator: "mid-task-replan",
    })
    if (!result.ok) {
      emit({ type: "PLAN_REPLANNED", taskId, runId: taskRunId, ok: false, reason: "verification", error: result.error, nodes: defs.length })
      return { ok: false }
    }
    dag = result.graph
    replanCount++
    persistDAG()
    ts.setPlan([...dag.nodes.values()].map((n) => n.objective ?? n.id), "model+replanned")
    emit({
      type: "PLAN_REPLANNED",
      taskId, runId: taskRunId,
      ok: true,
      reason: "verification",
      kept: result.kept,
      added: result.added,
      dropped: result.dropped,
      nodes: dag.nodes.size,
    })
    return { ok: true, clearNode: true }
  }

  /**
   * §29 — a segment budget is a CHECKPOINT CADENCE, not a wall. Reaching it
   * used to stop the task dead with WAITING/CONTINUE_REQUIRED, so a human had
   * to type "continue" to get the same work going again — the babysitting the
   * spec forbids ("never stop because the step counter ended").
   *
   * A run that is still making VERIFIED progress now consumes one unit of the
   * SAME bounded continuation budget automatically and keeps going. Nothing is
   * widened: `maxContinuations` is unchanged, the absolute segment ceiling
   * still applies, and a run that is stalled, erroring or aborted falls through
   * to the honest fuse below exactly as before. Auto-continuation is only ever
   * granted on evidence, and it is always announced.
   */
  // Progress is a DELTA, never a level. "3 nodes are done" is true of a run
  // that finished them an hour ago and has achieved nothing since; only growth
  // SINCE THE LAST GRANT proves the extra budget is buying anything.
  let lastGrantMark = null
  // Each grant extends by ONE more budget of the size this task class actually
  // earned — not by the global default, which would jump straight to the
  // absolute ceiling and spend every continuation in a single step.
  const segBudgetStep = Math.max(1, maxSeg)
  // An EXPLICIT budget is a decision, not a default. When a caller or the
  // user's config pinned maxSegments, that number is the contract and
  // auto-continuation must never quietly exceed it — the same rule agent.js
  // already applies to maxStepsOverride. Auto-continuation only widens a
  // budget that forge itself derived from the task class.
  const segBudgetIsDerived = maxSegments == null && config?.agent?.maxSegments == null
  const progressMark = () => {
    let doneNodes = 0
    try { for (const n of dag.nodes.values()) if (n?.status === "done" || n?.status === "completed") doneNodes++ } catch { doneNodes = 0 }
    return { files: changedFiles.size, doneNodes }
  }
  // Why the last continuation was refused — reported on the fuse so a run that
  // stops always says what stopped it, instead of a bare "waiting for resume".
  let lastRefusal = null
  const productiveContinuation = () => {
    const refuse = (why) => { lastRefusal = why; return null }
    if (!segBudgetIsDerived) return refuse("segment budget was set explicitly — honoring it")
    if (signal?.aborted) return refuse("run was cancelled")
    if (continuationCount >= maxContinuations) return refuse(`continuation budget spent (${continuationCount}/${maxContinuations})`)
    if (maxSeg >= AGENT_BUDGETS.maxSegments) return refuse(`absolute segment ceiling reached (${AGENT_BUDGETS.maxSegments})`)
    let snap = null
    try { snap = xctl.snapshot() } catch { return refuse("execution controller unavailable") }
    // a stalled or repeatedly-erroring run must NOT buy more budget: more of a
    // failing strategy is waste, and the fuse is what forces a rethink
    if ((snap?.noProgressStreak ?? 0) > 0) return refuse(`no-progress streak of ${snap.noProgressStreak} — more budget cannot fix a stalled strategy`)
    if ((snap?.repeatErrorStreak ?? 0) > 0) return refuse(`repeating the same error ${snap.repeatErrorStreak}x — needs a different approach, not more steps`)
    const mark = progressMark()
    const base = lastGrantMark ?? { files: 0, doneNodes: 0 }
    const dFiles = mark.files - base.files
    const dNodes = mark.doneNodes - base.doneNodes
    // nothing NEW since the last grant → this budget bought nothing; stop and
    // let the honest fuse force a checkpoint and a rethink
    if (dFiles <= 0 && dNodes <= 0) return refuse("no new files changed and no new nodes completed since the last budget grant")
    lastGrantMark = mark
    lastRefusal = null
    return { newFiles: dFiles, newNodesDone: dNodes, totalFiles: mark.files, totalNodesDone: mark.doneNodes }
  }

  while (true) {
    if (signal?.aborted) { finalStatus = explicitFinalization(FINAL.CANCELLED); break }
    if (segment >= maxSeg) {
      const evidence = productiveContinuation()
      if (!evidence) break
      const prev = maxSeg
      maxSeg = Math.min(maxSeg + segBudgetStep, AGENT_BUDGETS.maxSegments)
      if (maxSeg <= prev) break
      continuationCount++
      ts.noteContinuation?.()
      emit({
        type: "SEGMENT_BUDGET_AUTO_CONTINUED",
        taskId, runId: taskRunId, segment,
        from: prev, to: maxSeg,
        continuation: continuationCount, maxContinuations,
        evidence,
        reason: `still making verified progress since the last budget grant (+${evidence.newFiles} file(s), +${evidence.newNodesDone} node(s) done) — continuing automatically instead of waiting for a human`,
      })
    }

    segment++
    const segmentId = `seg-${segment}`
    const segStart = Date.now()

    // Exact DAG node identity (P0): the node executed by this segment is chosen
    // explicitly and carried in taskId/runId/segmentId/nodeId through Meta →
    // Agent → Tools → Events → Verification → TaskState → DAG. Nothing is
    // inferred from filenames, keywords or tool names.
    const changedBefore = changedFiles.size

    // --- close out any in-flight node whose verification has since landed ---
    // A node left in VERIFYING / EXECUTION_SUCCEEDED / REPAIRING by an earlier
    // segment is finished the moment its evidence holds — it must not linger
    // unfinished and block the whole-DAG gate forever.
    if (dag) {
      try {
        const relNow = [...changedFiles].map((f) => path.relative(process.cwd(), f))
        for (const n of [...dag.nodes.values()]) {
          if (![dagLib.NODE_STATUS.EXECUTION_SUCCEEDED, dagLib.NODE_STATUS.VERIFYING, dagLib.NODE_STATUS.REPAIRING].includes(n.status)) continue
          const st = ledger.status(riskNow, relNow, { nodeId: n.id })
          if (st.ok && !st.anyFailure) {
            dagLib.markCompleted(dag, n.id, "verification satisfied after repair", { verification: { verification_id: `ver-after-repair-${n.id}-${segment}` } })
            emit({ type: "DAG_NODE_COMPLETED", taskId, runId: taskRunId, segmentId, nodeId: n.id, verified: true, phase: "post-repair" })
          }
        }
        persistDAG()
      } catch { }
    }

    let currentNodeId = null
    let currentNode = null
    if (dag) {
      try {
        const ready = dagLib.readyNodes(dag)
        // Mutating nodes first: they advance the objective. Read-only nodes are
        // normally fanned out to workers below; if none could be dispatched the
        // main agent takes one itself so the graph can never stall owner-less.
        const candidates = ready.filter((n) => !n.read_only)
        const pick = candidates.length ? candidates[0] : null
        if (pick) {
          currentNodeId = pick.id
          currentNode = dagLib.executeNode(dag, currentNodeId, { taskId, runId: taskRunId, segmentId })
          if (currentNode) {
            currentNode.taskId = taskId
            currentNode.runId = taskRunId
            currentNode.segmentId = segmentId
            ts.setNodeId(currentNodeId)
            emit({ type: "DAG_NODE_STARTED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, objective: currentNode.objective })
            persistDAG()
          }
        }
      } catch {}
    }

    ts.setSegmentId(segmentId)
    if (currentNodeId) ts.setNodeId(currentNodeId)
    ts.transition(TASK_STATUS.EXECUTING, { reason: `segment ${segment}${currentNodeId ? ` node ${currentNodeId}` : ""}` })
    resources.record({ segment: true })

    const adaptation = resources.evaluate()
    manager.setMaxWorkers(adaptation.limits.maxWorkers)
    if (adaptation.actions.length) emit({ type: "RESOURCE_ADAPTED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, level: adaptation.level, actions: adaptation.actions.map((a) => a.action), summary: resources.summary() })

    // v94 masterwise (§29): resource fuses are ENFORCED here, not merely
    // displayed. failure_rate/recovery_loop → strategy change + replan;
    // wall_clock → checkpoint → WAIT (resumable). Resource pressure is
    // NEVER completion.
    const segSteps = segStepsPinned ?? xctl.segmentSize({
      klass: classified.class,
      failureRate: (() => { const s = resources.state; return (s.modelCalls + s.toolCalls) > 0 ? s.failures / (s.modelCalls + s.toolCalls) : 0 })(),
      pressureLevel: adaptation.level,
      avgToolLatencyMs: resources.state.slowStreak >= 3 ? 20000 : 0,
    })
    emit({ type: "SEGMENT_STARTED", taskId, runId: taskRunId, segment, segmentId, nodeId: currentNodeId, objective: state.objective, maxSteps: segSteps, adaptive: !segStepsPinned })
    const fuseAction = xctl.enforceFuses(resources.fuses(), { segment })
    if (fuseAction.action === "checkpoint_wait") {
      // wall-clock fuse: the honest move is checkpoint → persist → WAIT for
      // resources/user. The task is resumable; this is not a failure and
      // never a completion.
      try {
        const touched = [...changedFiles].filter((f) => { try { return fs.existsSync(f) } catch { return false } })
        const cpId = touched.length
          ? snapshotBefore(touched, process.cwd(), [], taskRunId)
          : boundaryCheckpoint(process.cwd(), { runId: taskRunId, label: `resource-fuse-${segment}`, objective: state.objective })
        if (cpId) { ts.noteCheckpoint(cpId); try { engMem.rememberCheckpoint(cpId) } catch { } }
        emit({ type: "CHECKPOINT_CREATED", taskId, runId: taskRunId, boundary: "resource-fuse", segment, checkpointId: cpId })
      } catch {}
      persistDAG()
      finalStatus = explicitFinalization(FINAL.WAITING)
      finalState = TASK_STATUS.WAITING
      finalText = `resource fuse (${fuseAction.fuse}) — checkpointed and waiting (CONTINUE_REQUIRED), not failed`
      ts.transition(TASK_STATUS.WAITING, { reason: `resource fuse ${fuseAction.fuse}: checkpoint and wait` })
      ts.setNextAction("continue_required: resource pressure — resume later")
      persistCritical()
      ts.noteError("RESOURCE_FUSE_WAIT", finalText)
      break
    }
    if (fuseAction.action === "replan") {
      const rp = await tryMidTaskReplan({ reason: `resource fuse ${fuseAction.fuse}: ${fuseAction.why}`, evidence: fuseAction.why })
      if (rp.ok) { currentNodeId = null; currentNode = null }
    }

    const riskNow = riskForChange({ filesChanged: changedFiles.size, task: state.objective, securitySensitive: riskLevel === "critical" })
    if (riskNow === "high" || riskNow === "critical" || segment === 1) {
      ts.transition(TASK_STATUS.CHECKPOINTING, { reason: "boundary before risky segment" })
      let cpId = null
      try {
        const cwd = process.cwd()
        const touched = [...changedFiles].filter((f) => { try { return fs.existsSync(f) } catch { return false } })
        cpId = touched.length
          ? snapshotBefore(touched, cwd, [], taskRunId)
          : boundaryCheckpoint(cwd, { runId: taskRunId, label: `segment-${segment}`, objective: state.objective })
      } catch (e) { ts.noteError("CHECKPOINT_FAILED", e?.message ?? String(e)) }
      if (cpId) { ts.noteCheckpoint(cpId); try { engMem.rememberCheckpoint(cpId) } catch { } }
      emit({ type: "CHECKPOINT_CREATED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, boundary: "segment", segment, checkpointId: cpId })
      ts.transition(TASK_STATUS.EXECUTING, { reason: "resume after checkpoint boundary" })
    }

    // v23: buildAsync = hybrid rerank when embeddings are configured, else the
    // exact synchronous BM25 build (no embedder → no behavior change)
    const contextBuilt = await ctxEngine.buildAsync(state.objective, { budgetTokens: resources.state.burst ? 5000 : resources.state.tier === "high" ? 4000 : 2200, precision: adaptation.limits.retrievalPrecision === "precise" ? "precise" : "normal" })
    const contextBlock = typeof contextBuilt === "string" ? contextBuilt : contextBuilt?.text ?? ""

    const knownBad = embedder
      ? await ineffectiveStrategiesAsync(state.objective, { cwd: process.cwd(), embedder, alpha: embCfg.alpha, budgetMs: embCfg.rerankBudgetMs })
      : ineffectiveStrategies(state.objective, { cwd: process.cwd() })
    if (knownBad.length) emit({ type: "STRATEGY_CHANGED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, reason: `avoiding ${knownBad.length} previously-ineffective approach(es)`, avoided: knownBad.slice(0, 2).map((l) => l.failed_strategy || l.failed_action) })

    let dagFindings = ""
    // v95 worktreewise: isolated worker jobs dispatched THIS segment. They run
    // CONCURRENTLY with the main agent (each child in its own worktree), and
    // their merge-back is awaited after the main agent settles — concurrent
    // work, SERIALIZED merge into the shared tree. A lost update is never
    // possible: the main tree has exactly one writer at every instant.
    const isoJobs = []
    if (dag && workersEnabled && (workers != null || classified.strategy.workers > 0) && !signal?.aborted) {
      try {
        const classWorkers = scaleWorkers(classified.strategy.workers, resources.state)
        const parallelN = workers != null
          ? Math.max(1, resources.state.maxWorkers)
          : Math.max(1, Math.min(resources.state.maxWorkers, classWorkers))
        const batch = dagLib.scheduleBatch(dag, { maxParallel: parallelN, conflictKeys: dagLib.canonicalConflictKeys })
          .filter((n) => n.read_only && n.role && n.role !== "coder" && n.id !== currentNodeId)
        if (batch.length) {
          emit({ type: "DAG_DISPATCH", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, nodes: batch.map((n) => n.id), parallel: batch.length })
          bus91.send({ sender: "core", receiver: "crew", type: MESSAGE_TYPE.REQUEST, content: `dispatch ${batch.length} read-only node(s): ${batch.map((n) => n.id).join(", ")}`, priority: 1, node_id: currentNodeId })
          /** v91 §34/§35 — one shared handler for a worker outcome: evidence
           *  acceptance, self-review, crew performance memory, bus mirror,
           *  and ONE reassignment with full context transfer on failure. */
          const settleWorkerOutcome = (n, job, r) => {
            // crew performance memory (§37) — every outcome teaches routing
            crewRouter.record({ role: n.role, model: job.model ?? null, ok: r.status === "completed", verified: r.status === "completed", latencyMs: job.durationMs ?? 0 })
            if (r.status === "completed" && String(r.result ?? "").trim()) {
              // §34 — the worker's report must survive the deterministic
              // self-review before its findings are trusted as evidence.
              const sr = reviewWorkerResult({
                objective: n.objective,
                result: String(r.result ?? ""),
                ok: true,
                toolCalls: r.toolCalls ?? (r.toolStats?.calls ?? 0),
                filesTouched: 0,
                evidenceCount: 1,
                verification: "unverified",
              })
              r.selfReview = sr
              emit({ type: "SELF_REVIEW", taskId, runId: taskRunId, segmentId, nodeId: n.id, workerId: r.workerId ?? job.id, role: n.role, ok: sr.ok, confidence: sr.confidence, flags: sr.flags, uncertainties: sr.uncertainties })
              // A read-only node's outcome is its findings: record that as
              // scoped ACCEPTANCE evidence, then complete the node WITH it.
              const rec = ledger.add({
                verification_id: `ver-worker-${n.id}-${job.id}`,
                taskId, nodeId: n.id, segmentId,
                verificationEpoch: state.verification_epoch ?? 0,
                affectedFiles: [], scope: "node", type: "acceptance",
                passed: true, exitCode: 0, exitCodeKnown: true,
                evidence: String(r.result ?? "").slice(0, 300),
                timestamp: Date.now(), command: `worker:${n.role}`, output: String(r.result ?? "").slice(0, 500),
              })
              ts.noteVerification(rec)
              dagLib.markCompleted(dag, n.id, String(r.result ?? "").slice(0, 2000), { verification: rec })
              workerCompletionsTotal++
              dagFindings += `\n\n--- finding from ${n.role} (${n.id}) ---\n${String(r.result ?? "").slice(0, 1200)}`
              if (sr.flags.length) dagFindings += `\n[self-review flags: ${sr.flags.join("; ")}]`
              if (sr.uncertainties.length) dagFindings += `\n[uncertain: ${sr.uncertainties[0]}]`
              bus91.send({ sender: `worker:${job.id}`, receiver: "core", type: MESSAGE_TYPE.FINDING, content: String(r.result ?? "").slice(0, 400), node_id: n.id, confidence: sr.confidence })
              bus91.send({ sender: `worker:${job.id}`, receiver: "core", type: MESSAGE_TYPE.COMPLETED, content: `node ${n.id} (${n.role}) findings delivered`, node_id: n.id, priority: 1 })
            } else if (r.status === "completed") {
              // worker settled but produced nothing: unverifiable, not complete
              dagLib.markFailed(dag, n.id, "worker produced no findings — cannot verify the node outcome")
              bus91.send({ sender: `worker:${job.id}`, receiver: "core", type: MESSAGE_TYPE.BLOCKED, content: `node ${n.id}: no findings`, node_id: n.id, priority: 2 })
            } else {
              // §35 — reassignment: ONE successor, full context transfer, the
              // failed attempt's findings preserved in the handoff. Never an
              // infinite relay; the second failure marks the node FAILED.
              // v93 gap fix: an EXHAUSTED worker (sub-agent spent its budget
              // without finishing) is classified like a failure — retry /
              // reassign, never "work complete". Unresolved → markFailed →
              // the completion gate keeps the task honestly INCOMPLETE.
              const used = reassignBudget.get(n.id) ?? 0
              const reassignable = used < 1 && (r.status === "failed" || r.status === "timed_out" || r.status === "exhausted")
              if (reassignable) {
                reassignBudget.set(n.id, used + 1)
                const h = createHandoffLocal({
                  from: `worker:${r.workerId ?? job.id}`,
                  to: `successor:${n.id}`,
                  taskId, nodeId: n.id,
                  reason: r.error ?? r.status,
                  currentState: `worker ${r.status}`, 
                  completedWork: r.result ? [String(r.result).slice(0, 300)] : [],
                  failedApproaches: r.error ? [String(r.error).slice(0, 300)] : [],
                  files: n.targetFiles ?? [],
                  recommendedNextAction: `retry node ${n.id} with a different approach`,
                  verificationStatus: "unknown",
                })
                try { handoffs91.add(h) } catch { }
                const succ = manager.reassign(r.workerId ?? job.id, { reason: r.error ?? r.status, handoff: h })
                if (succ) {
                  emit({ type: "WORKER_REASSIGNED_2", taskId, runId: taskRunId, nodeId: n.id, from: job.id, to: succ.workerId, reason: String(r.error ?? r.status).slice(0, 200) })
                  void succ.promise.then((r2) => settleWorkerOutcome(n, succ, r2)).catch(() => { })
                  return
                }
              }
              dagLib.markFailed(dag, n.id, r.error ?? r.status)
              bus91.send({ sender: `worker:${job.id}`, receiver: "core", type: MESSAGE_TYPE.BLOCKED, content: `node ${n.id} failed: ${String(r.error ?? r.status).slice(0, 200)}`, node_id: n.id, priority: 2 })
            }
            persistDAG()
          }
          const jobs = batch.map((n) => {
            dagLib.markRunning(dag, n.id)
            if (isIntegratorRole(n.role)) {
              const merged = integrateResults({ objective: state.objective, reports: reportsFromGraph(dag) })
              // v92 §31 (wirewise): overlapping worker claims on the same file
              // are real conflicts — report them instead of silently dropping
              // them. The INTEGRATION_CONFLICT event is consumed by the Core
              // event tap, which records and resolves it with the evidence
              // ladder (evidence wins; ties escalate to an experiment).
              // Before this wiring the conflicts field was computed by
              // integrate.js and discarded — core's handler was dead code.
              for (const cf of (merged.conflicts ?? []).slice(0, 3)) {
                try {
                  emit({
                    type: "INTEGRATION_CONFLICT", taskId, runId: taskRunId, segmentId, nodeId: n.id,
                    file: cf.file,
                    claims: {
                      topic: `overlapping change: ${cf.file}`,
                      a: { worker: cf.a?.from ?? "worker-a", text: `${cf.a?.action ?? ""}${cf.a?.why ? ` — ${cf.a.why}` : ""}`, evidence: [cf.file] },
                      b: { worker: cf.b?.from ?? "worker-b", text: `${cf.b?.action ?? ""}${cf.b?.why ? ` — ${cf.b.why}` : ""}`, evidence: [cf.file] },
                    },
                  })
                  bus91.send({ sender: `integrator:${n.id}`, receiver: "core", type: MESSAGE_TYPE.WARNING, content: `conflicting worker claims on ${cf.file}: ${cf.a?.from ?? "a"} vs ${cf.b?.from ?? "b"}`, node_id: n.id, file_refs: [cf.file], priority: 2 })
                } catch { /* one bad conflict shape must never break integration */ }
              }
              const rec = ledger.add({
                verification_id: `ver-worker-${n.id}-integrate`,
                taskId, nodeId: n.id, segmentId,
                verificationEpoch: state.verification_epoch ?? 0,
                affectedFiles: merged.apply.map((a) => a.file).filter(Boolean).slice(0, 32),
                scope: "node", type: "acceptance",
                passed: true, exitCode: 0, exitCodeKnown: true,
                evidence: merged.text.slice(0, 300),
                timestamp: Date.now(), command: "worker:integrator", output: merged.text.slice(0, 500),
              })
              ts.noteVerification(rec)
              dagLib.markCompleted(dag, n.id, merged.text.slice(0, 2000), { verification: rec })
              dagFindings += `\n\n${merged.text}`
              persistDAG()
              return Promise.resolve()
            }
            const job = manager.spawn({
              role: n.role,
              // P0 worker identity: every worker carries taskId/nodeId/segmentId
              // so nothing downstream has to guess which node it belongs to.
              taskId, runId: taskRunId, segmentId, nodeId: n.id,
              task: `${n.objective}\n\nThis is a read-only investigation subtask of: ${state.objective}. Do NOT modify files. Report concise findings (file paths, symbols, facts) the implementer will need.`,
              context: contextBlock.slice(0, 3500),
              dagNode: n.id,
              timeoutMs: 1000 * 60 * 2,
              // canonical conflict keys, straight from the node definition
              targetFiles: n.targetFiles ?? null,
              targetSymbols: n.targetSymbols ?? null,
              targetDirs: n.targetDirs ?? null,
              resourceLocks: n.resourceLocks ?? null,
            })
            resources.record({ workers: 1 })
          return job.promise.then((r) => settleWorkerOutcome(n, job, r)).catch((e) => { try { dagLib.markFailed(dag, n.id, String(e?.message ?? e)); persistDAG() } catch {} })
          })
          // Bounded wait: the deadline must be cleared (and unref'd) or it keeps
          // a timer alive long after the workers have settled.
          // v91 §3: the task honestly reports WAITING_FOR_AGENT while the crew
          // runs, then returns to EXECUTING — real states, not cosmetics.
          let fanoutTimer = null
          const waitMs = fanoutWaitMs(resources.state.tier, resources.state)
          ts.transition(TASK_STATUS.WAITING_FOR_AGENT, { reason: `${jobs.length} worker(s) running` })
          const fanoutDeadline = new Promise((resolve) => {
            fanoutTimer = setTimeout(resolve, waitMs)
            if (fanoutTimer && typeof fanoutTimer.unref === "function") fanoutTimer.unref()
          })
          await Promise.race([Promise.allSettled(jobs), fanoutDeadline])
          clearTimeout(fanoutTimer)
          ts.transition(TASK_STATUS.EXECUTING, { reason: "worker fan-out settled" })
        }

        // ------------------------------------------------------------------
        // v95 worktreewise — ISOLATED MUTATING DISPATCH (the kernel TODO,
        // closed). READY MUTATING nodes with pairwise-disjoint DECLARED
        // targets run in parallel, each inside its own detached git worktree:
        // parallel segments can never see each other's partial writes. The
        // merge back into the shared tree happens in settleIsolatedNode —
        // SERIALIZED, checked-then-applied, honest on conflict. Nodes that
        // cannot be isolated (no declared targets, overlap, not a git repo,
        // FORGE_WORKTREE=0, creation failure) stay serialized EXACTLY as
        // before: worktrees are the fix for the never-list ("never run DAG
        // nodes in a shared tree when they mutate the same files"), not a
        // license to share.
        // ------------------------------------------------------------------
        if (wtAvailability === null) {
          wtAvailability = isolationAvailable({ root: process.cwd(), config })
          emit({ type: "WORKTREE_MODE", taskId, runId: taskRunId, segmentId, enabled: wtAvailability.ok, reason: wtAvailability.ok ? "git worktree isolation active" : wtAvailability.reason, maxNodes: wtMaxNodes })
        }
        if (wtAvailability.ok && !signal?.aborted) {
          const currentKeys = (() => { try { return currentNodeId ? dagLib.canonicalConflictKeys(dag.nodes.get(currentNodeId) ?? {}) : [] } catch { return [] } })()
          const readyNow = dagLib.readyNodes(dag)
          const isoPlan = planIsolation({
            nodes: readyNow, excludeIds: [currentNodeId], excludeKeys: currentKeys,
            conflictKeys: dagLib.canonicalConflictKeys, maxNodes: wtMaxNodes,
          })
          // in-flight shared-tree work must never be double-booked: a node whose
          // declared targets have UNCOMMITTED changes (an earlier merge, the
          // user's own edits, a prior segment) stays serialized. null (not a
          // repo / git failure) blocks the whole dispatch honestly.
          const { uncommittedFiles } = await import("./worktree.js")
          const dirty = await uncommittedFiles(process.cwd())
          const isoFiltered = dirty === null ? [] : isoPlan.filter(({ node: n }) => {
            const targets = [...(n.targetFiles ?? []), ...(n.targetDirs ?? [])].map(String)
            const clash = targets.some((t) => dirty.has(t) || [...dirty].some((d) => d.startsWith(t + "/")))
            if (clash) emit({ type: "WORKTREE_UNAVAILABLE", taskId, runId: taskRunId, segmentId, nodeId: n.id, reason: "declared target has uncommitted changes in the shared tree — serialized" })
            return !clash
          })
          if (isoFiltered.length) {
            /** Settle ONE isolated node: merge its worktree back through the
             *  serialized single-writer lane, then complete or fail it with
             *  evidence. Merge conflicts KEEP the worktree for inspection. */
            const settleIsolatedNode = async (n, job, r) => {
              const wt = worktreeByNode.get(String(n.id)) ?? null
              worktreeByNode.delete(String(n.id))
              const finishWt = async (keep) => {
                if (keep) return
                const rm = await removeWorktree({ root: process.cwd(), dir: wt?.dir })
                emit({ type: "WORKTREE_REMOVED", taskId, runId: taskRunId, segmentId, nodeId: n.id, worktreeId: wt?.id ?? null, ok: rm.ok, reason: rm.ok ? "removed" : rm.reason })
              }
              try {
                if (!wt) { try { dagLib.markFailed(dag, n.id, "isolated node settled without a worktree record"); persistDAG() } catch {} return }
                if (r?.status !== "completed") {
                  // worker failed / timed out / exhausted / crashed — discard the
                  // worktree, fail the node with the worker's own reason.
                  await finishWt(false)
                  const why = `isolated worker ${r?.status ?? "failed"}${r?.error ? ": " + String(r.error).slice(0, 160) : ""}`
                  dagLib.markFailed(dag, n.id, why)
                  bus91.send({ sender: `worktree:${wt.id}`, receiver: "core", type: MESSAGE_TYPE.BLOCKED, content: `node ${n.id}: ${why}`, node_id: n.id, priority: 2 })
                  emit({ type: "WORKTREE_FAILED", taskId, runId: taskRunId, segmentId, nodeId: n.id, worktreeId: wt.id, reason: why })
                  persistDAG()
                  return
                }
                const cap = await captureChanges({ root: process.cwd(), dir: wt.dir, nodeId: n.id })
                if (!cap.ok) {
                  await finishWt(false)
                  dagLib.markFailed(dag, n.id, `worktree capture failed: ${cap.reason}`)
                  emit({ type: "WORKTREE_FAILED", taskId, runId: taskRunId, segmentId, nodeId: n.id, worktreeId: wt.id, reason: cap.reason })
                  persistDAG()
                  return
                }
                if (cap.clean !== true && cap.patchPath) {
                  const merged = await mergeBack({ root: process.cwd(), patchPath: cap.patchPath })
                  if (!merged.ok) {
                    // honest conflict: report the files, keep the worktree as
                    // evidence, fail the node — a serialized retry may re-run it.
                    emit({ type: "WORKTREE_CONFLICT", taskId, runId: taskRunId, segmentId, nodeId: n.id, worktreeId: wt.id, files: (merged.conflicts ?? []).slice(0, 8), reason: merged.reason })
                    bus91.send({ sender: `worktree:${wt.id}`, receiver: "core", type: MESSAGE_TYPE.WARNING, content: `node ${n.id} merge conflict: ${(merged.conflicts ?? []).slice(0, 3).join(", ") || "unknown files"}`, node_id: n.id, priority: 2 })
                    dagLib.markFailed(dag, n.id, `worktree merge conflict — ${merged.reason}${(merged.conflicts ?? []).length ? ` (files: ${(merged.conflicts ?? []).slice(0, 4).join(", ")})` : ""}; worktree ${wt.id} kept for inspection`)
                    await finishWt(true)
                    persistDAG()
                    return
                  }
                  // merged: the files now exist in the SHARED tree — record them
                  // exactly like the main loop records its own writes so risk
                  // recalculation, freshness and final verification all see them.
                  const absFiles = (merged.files ?? []).map((f) => path.resolve(process.cwd(), String(f))).filter((f) => !f.includes(`${path.sep}.forge${path.sep}`))
                  for (const abs of absFiles) {
                    changedFiles.add(abs)
                    try { ts.noteFiles([abs], []) } catch { }
                  }
                  if (absFiles.length) { try { ctxEngine.invalidateFor([...absFiles]) } catch { } }
                  const rec = ledger.add({
                    verification_id: `ver-worktree-${n.id}-${job.id}`,
                    taskId, nodeId: n.id, segmentId,
                    verificationEpoch: state.verification_epoch ?? 0,
                    affectedFiles: absFiles.slice(0, 32), scope: "node", type: "acceptance",
                    passed: true, exitCode: 0, exitCodeKnown: true,
                    evidence: `worktree ${wt.id} merged ${absFiles.length} file(s) — ${String(r.result ?? "").slice(0, 200)}`,
                    timestamp: Date.now(), command: `worktree-merge:${wt.id}`, output: String(r.result ?? "").slice(0, 500),
                  })
                  ts.noteVerification(rec)
                  dagLib.markCompleted(dag, n.id, String(r.result ?? `worktree ${wt.id} merged ${absFiles.length} file(s)`).slice(0, 2000), { verification: rec })
                  workerCompletionsTotal++
                  emit({ type: "WORKTREE_MERGED", taskId, runId: taskRunId, segmentId, nodeId: n.id, worktreeId: wt.id, files: absFiles.slice(0, 12) })
                  bus91.send({ sender: `worktree:${wt.id}`, receiver: "core", type: MESSAGE_TYPE.COMPLETED, content: `node ${n.id} merged ${absFiles.length} file(s) from worktree ${wt.id}`, node_id: n.id, priority: 1 })
                  await finishWt(false)
                  persistDAG()
                  return
                }
                // worker completed but changed NOTHING in its worktree: its
                // report is the outcome. Complete on a real report (mirrors the
                // read-only rule: no findings → unverifiable → failed).
                if (String(r.result ?? "").trim()) {
                  const rec = ledger.add({
                    verification_id: `ver-worktree-${n.id}-${job.id}`,
                    taskId, nodeId: n.id, segmentId,
                    verificationEpoch: state.verification_epoch ?? 0,
                    affectedFiles: [], scope: "node", type: "acceptance",
                    passed: true, exitCode: 0, exitCodeKnown: true,
                    evidence: String(r.result).slice(0, 300),
                    timestamp: Date.now(), command: `worktree:${wt.id}`, output: String(r.result ?? "").slice(0, 500),
                  })
                  ts.noteVerification(rec)
                  dagLib.markCompleted(dag, n.id, String(r.result).slice(0, 2000), { verification: rec })
                  workerCompletionsTotal++
                  emit({ type: "WORKTREE_MERGED", taskId, runId: taskRunId, segmentId, nodeId: n.id, worktreeId: wt.id, files: [] , note: "clean worktree — no changes to merge" })
                  await finishWt(false)
                  persistDAG()
                } else {
                  await finishWt(false)
                  dagLib.markFailed(dag, n.id, "isolated worker completed with no report and no changes — outcome unverifiable")
                  persistDAG()
                }
              } catch (e) {
                await finishWt(false)
                try { dagLib.markFailed(dag, n.id, `isolated settle threw: ${String(e?.message ?? e).slice(0, 200)}`); persistDAG() } catch { }
              }
            }
            for (const { node: n } of isoFiltered) {
              if (signal?.aborted) break
              const wt = await createWorktree({ root: process.cwd(), nodeId: n.id, runId: taskRunId, taskId })
              if (!wt.ok) {
                // honest fallback: the node stays READY and will be executed
                // serialized by the main loop — never dispatched shared-tree.
                emit({ type: "WORKTREE_UNAVAILABLE", taskId, runId: taskRunId, segmentId, nodeId: n.id, reason: wt.reason })
                continue
              }
              worktreeByNode.set(String(n.id), wt)
              dagLib.markRunning(dag, n.id)
              emit({ type: "WORKTREE_CREATED", taskId, runId: taskRunId, segmentId, nodeId: n.id, worktreeId: wt.id, dir: wt.dir, base: wt.base, objective: n.objective })
              bus91.send({ sender: "core", receiver: "crew", type: MESSAGE_TYPE.REQUEST, content: `isolated node ${n.id} dispatched to worktree ${wt.id} (coder role, private checkout)`, priority: 1, node_id: n.id })
              const job = manager.spawn({
                role: "coder",
                taskId, runId: taskRunId, segmentId, nodeId: n.id,
                task: `${n.objective}\n\nYou are executing DAG node ${n.id} inside an ISOLATED git worktree — a private checkout of the project. Work ONLY inside the current directory. Do NOT run git commit, git branch, git worktree or git push — the orchestrator merges your changes back. ${(n.targetFiles ?? []).length ? `Declared target files: ${(n.targetFiles ?? []).join(", ")}.` : ""} When finished, report exactly what you changed and why.`,
                context: contextBlock.slice(0, 3500),
                dagNode: n.id,
                timeoutMs: 1000 * 60 * 3,
                targetFiles: n.targetFiles ?? null,
                targetSymbols: n.targetSymbols ?? null,
                targetDirs: n.targetDirs ?? null,
                resourceLocks: n.resourceLocks ?? null,
              })
              resources.record({ workers: 1 })
              isoJobs.push(job.promise.then((r) => settleIsolatedNode(n, job, r)).catch((e) => { try { dagLib.markFailed(dag, n.id, String(e?.message ?? e)); persistDAG() } catch {} }))
            }
            // NOTE: isoJobs are NOT awaited here. They run concurrently with
            // the main agent below (each child inside its own worktree — the
            // trees are disjoint, so true parallelism is safe), and the
            // merge-back into the shared tree is awaited AFTER the main agent
            // settles (post-agent barrier): the main tree keeps exactly one
            // writer at every instant. The worker timeout (3 min) bounds each
            // child; the manager's settle gate bounds the task.
          }
        }
      } catch (e) { ts.noteError("DAG_FANOUT_FAILED", e?.message ?? String(e)) }
    }

    // If no mutating node was ready, everything that is still READY now is a
    // read-only node the fan-out could not dispatch — execute one here so the
    // DAG always has an owner and the completion gate can eventually pass.
    if (dag && !currentNodeId && !signal?.aborted) {
      try {
        let pick = null
        // (a) a node left mid-flight whose verification never landed: retry it
        //     while there is repair budget, so the graph can never deadlock.
        const inflight = [...dag.nodes.values()].filter((n) => [
          dagLib.NODE_STATUS.EXECUTION_SUCCEEDED, dagLib.NODE_STATUS.VERIFYING, dagLib.NODE_STATUS.REPAIRING,
        ].includes(n.status))
        if (inflight.length && repairCount < maxRepairs) {
          const n = inflight[0]
          if (dagLib.retryNode(dag, n.id)) pick = n
        }
        // (b) otherwise take any read-only node the fan-out could not dispatch
        if (!pick) pick = dagLib.readyNodes(dag)[0] ?? null
        if (pick) {
          currentNodeId = pick.id
          currentNode = dagLib.executeNode(dag, currentNodeId, { taskId, runId: taskRunId, segmentId })
          if (currentNode) {
            currentNode.taskId = taskId
            currentNode.runId = taskRunId
            currentNode.segmentId = segmentId
            ts.setNodeId(currentNodeId)
            emit({ type: "DAG_NODE_STARTED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, objective: currentNode.objective, owner: "main" })
            persistDAG()
          }
        }
      } catch { }
    }


    const segTask = resumeRec && segment === 1
      ? resumePrompt(resumeRec, resumeRecon ?? reconcileTask(resumeRec, { cwd: process.cwd() }), process.cwd())
      : segment === 1
        ? state.objective
        : buildContinuation({ state, segment, planText, riskNow, knownBad })

    // v92 §9 (wirewise): PREDICT before acting — deterministic, derived from
    // the DAG node's declared targets and the planning risk. Never a model's
    // self-reported confidence (that is not evidence). The prediction is
    // settled against observed reality after the segment completes.
    // v97 §29: the prediction also declares TESTS and STEPS up front — derived
    // deterministically from the node's targets (world-model test mapping) and
    // the adaptive segment budget. Settled below against what really ran.
    const segExpectedTests = (() => {
      try {
        const targets = currentNode?.targetFiles ?? []
        if (!targets.length) return null
        return createWorldModel({ cwd: process.cwd() }).testsFor(targets).length || 0
      } catch { return null }
    })()
    const segPrediction = predictForNode({
      node: currentNode, objective: state.objective, riskLevel: riskNow,
      segment, segmentId, taskId,
      expectedTests: segExpectedTests, expectedSteps: segSteps,
    })
    emit({
      type: "PREDICTION_MADE", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId,
      prediction: {
        id: segPrediction.id, expectedFiles: segPrediction.expectedFiles, expectedRisk: segPrediction.expectedRisk,
        expectedOutcome: segPrediction.expectedOutcome, derived: segPrediction.derived,
        expectedTests: segPrediction.expectedTests, expectedSteps: segPrediction.expectedSteps,
      },
      nodePrediction: currentNode?.prediction ?? null,
      text: formatPrediction(segPrediction),
    })
    // v92 §7/§8 (wirewise): honest language-adapter brief for the node's
    // declared targets — tells the model exactly how well Forge can parse
    // the files it is about to touch (deep vs conservative mode).
    const segAdapterBrief = (() => {
      try {
        const targets = currentNode?.targetFiles ?? []
        return targets.length ? adapterBrief(targets, { maxFiles: 6, maxChars: 480 }) : ""
      } catch { return "" }
    })()

    let res
    try {
      // v96 unifywise: the §24 information-gain experiments ride the FIRST
      // segment's context — the cheapest uncertainty-reducing steps run before
      // the first mutation, exactly as the (previously false) comment promised.
      const infogainBlock = planInfogain && planInfogain.needed
        ? `--- pre-execution information-gain experiments (run these read-only checks BEFORE mutating anything) ---\n${planInfogain.experiments.map((e) => `- [${e.kind}] ${e.experiment}: ${e.how} (cost ${e.cost}, reduces: ${e.reduces})`).join("\n")}\nWhy: ${planInfogain.why}`
        : ""
      planInfogain = null // consumed once — segment 2+ executes, it does not re-inspect
      res = await agent({
        config, provider: prov, signal,
        task: segTask,
        taskId,
        runId: taskRunId,
        segmentId,
        nodeId: currentNodeId,
        extraContext: [dagFindings ? `DAG worker findings:\n${dagFindings}` : "", segAdapterBrief, infogainBlock, contextBlock ? `--- relevant project context (demand-loaded) ---\n${contextBlock}` : "", (() => { try { return engMem.retrievalBlock(segTask, { limit: 6, maxChars: 1200 }) } catch { return "" } })()].filter(Boolean).join("\n\n") || undefined,
        maxStepsOverride: segSteps, deep, onEvent: segmentEvents(emit, segment, { taskId, runId: taskRunId, segmentId, nodeId: currentNodeId }),
        journal: true, runIdOverride: taskRunId, suppressRunEvents: true, keepJournalRunning: true,
      })
    } catch (e) {
      res = { status: (e?.name === "AbortError" || signal?.aborted) ? "CANCELLED" : "FAILED", error: e?.message ?? String(e), text: "", steps: 0, taskId: taskId ?? null, segmentId: segmentId ?? null, nodeId: currentNodeId ?? null, runId: taskRunId ?? null, toolLog: [], toolRecords: [], toolStats: {}, commandChecks: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 0, toolCalls: 0 }, budgetHit: false, wrote: false, aborted: e?.name === "AbortError" || signal?.aborted }
    }
    const segMs = Date.now() - segStart
    // P0 fix segToolCalls initialization before every read (no TDZ)
    const segToolCalls = res?.toolLog?.length ?? 0
    totalToolCalls += segToolCalls

    if (res.aborted || signal?.aborted) { finalStatus = explicitFinalization(FINAL.CANCELLED); finalText = "cancelled by user"; break }

    // v95 worktreewise — the post-agent MERGE BARRIER. The isolated nodes ran
    // concurrently with the main agent (disjoint worktrees); their merge-back
    // into the shared tree is the single-writer lane and it is serialized
    // HERE, after the main agent's writes settled and before this segment's
    // accounting/verification runs. A lost update is never possible; a
    // conflict is an honest WORKTREE_CONFLICT (node FAILED, evidence kept).
    if (isoJobs.length) {
      try { await Promise.allSettled(isoJobs) } catch { /* allSettled never rejects; belt for exotic thenable shapes */ }
    }

    const recs = res.toolRecords ?? []
    const segChanged = new Set()
    // v99 loopwise: this segment's LSP diagnostics — collected once at the
    // verification gate, reused by the post-mutation reviewer pass
    let segDiags = []
    for (const r of recs) {
      for (const f of r.files_changed ?? []) {
        const abs = path.resolve(process.cwd(), f)
        changedFiles.add(abs)
        segChanged.add(abs)
        if (r.tool === "write_file") state.files_created.includes(abs) || ts.noteFiles([], [abs])
        else ts.noteFiles([abs], [])
      }
      if (r.checkpoint) ts.noteCheckpoint(r.checkpoint)
    }
    // A file that no longer exists was DELETED — but only if we have SEEN it
    // exist. A file the agent intends to create has not been observed yet, so
    // counting it as a deletion would fabricate risk (and mark it gone).
    for (const f of changedFiles) {
      const exists = (() => { try { return fs.existsSync(f) } catch { return false } })()
      if (exists) { seenExisting.add(f); continue }
      if (seenExisting.has(f)) {
        deletedFiles.add(f)
        changedFiles.delete(f)
        seenExisting.delete(f)
      }
    }
    if (changedFiles.size) {
      ctxEngine.invalidateFor([...changedFiles])
      // v94 masterwise (§14): memory freshness — every memory record citing a
      // changed file goes STALE (POTENTIALLY STALE until revalidated). Never
      // silently used while stale.
      try { engMem.markFilesChanged([...changedFiles].map((f) => path.relative(process.cwd(), f))) } catch { }
      // affected symbols feed the risk escalation rules (auth/crypto/exec …)
      try {
        const syms = detectAffectedSymbols([...changedFiles], process.cwd())
        for (const s of syms) if (!affectedSymbols.includes(s)) affectedSymbols.push(s)
      } catch { }
    }

    // v92 §9 (wirewise): settle the prediction against observed reality —
    // Prediction → Observation → Reality Delta, then persist for calibration.
    // Files changed in this segment + the risk recalculated from the actual
    // change + the segment outcome are the reality; the delta is evidence.
    {
      const segRealityRisk = (() => { try { return recomputeFinalRisk().risk } catch { return null } })()
      // v97 §29: reality for tests + steps — verification records that actually
      // ran this segment, and the agent's real step count.
      const segActualTests = (() => {
        try {
          const ran = Array.isArray(res?.commandChecks) ? res.commandChecks : []
          return ran.length || null
        } catch { return null }
      })()
      const settled = settlePrediction(segPrediction, {
        actualFiles: [...segChanged],
        finalRisk: segRealityRisk,
        status: res.error ? "error" : "ok",
        actualTests: segActualTests,
        actualSteps: Number.isFinite(res?.steps) ? res.steps : null,
      })
      emit({
        type: "PREDICTION_SETTLED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId,
        prediction: {
          id: settled.id, driftScore: settled.driftScore, riskDelta: settled.riskDelta,
          filesHit: settled.filesHit?.length ?? 0, filesExtra: settled.filesExtra?.length ?? 0,
          filesMissed: settled.filesMissed?.length ?? 0, outcomeCorrect: settled.outcomeCorrect,
          testsDelta: settled.testsDelta, stepsDelta: settled.stepsDelta,
        },
        text: formatSettlement(settled),
      })
      try { recordPrediction(settled, process.cwd()) } catch { /* best-effort persistence */ }
      // v94 masterwise (§25/§26): classify the REALITY DELTA and update the
      // live risk estimate. MATCH/MINOR → keep going; SIGNIFICANT → world
      // model + risk + plan get updated (replan triggers already exist on
      // verification failure); CONTRADICTION → recorded as a required action.
      try {
        const delta = classifyRealityDelta(settled)
        emit({
          type: "REALITY_DELTA", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId,
          cls: delta.cls, why: delta.why, driftScore: settled.driftScore, riskDelta: settled.riskDelta,
        })
        if (liveRisk) {
          liveRisk.realityDelta(delta.cls)
          if (res.error) liveRisk.failure(2)
          else if (settled.filesHit?.length) liveRisk.milestone()
          emit({
            type: "PLAN_RISK_UPDATED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId,
            successProbability: liveRisk.get(), basis: "live estimate from observed reality — not proof",
            history: liveRisk.history.slice(-6),
          })
        }
        if (delta.cls === "CONTRADICTION") {
          addRequiredAction(`reconcile: reality contradicted the prediction (${delta.why})`)
        }
      } catch { /* delta classification is advisory */ }
    }

    // Exact node identity + P0 verification gate.
    // Execution success ⇒ EXECUTION_SUCCEEDED only. The node reaches COMPLETED
    // further down, and only when its verification passed. It is NEVER
    // completed here, before verification — that was the bug that let a node
    // report "completed" while its own test run had just failed.
    if (dag && currentNodeId) {
      try {
        if (res.error) {
          dagLib.markFailed(dag, currentNodeId, String(res.error).slice(0, 200))
        } else {
          dagLib.markExecutionSucceeded(dag, currentNodeId, `segment ${segment}: ${changedFiles.size} file(s), ${segToolCalls} tool call(s)`)
          emit({ type: "DAG_NODE_EXECUTION_SUCCEEDED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, note: "execution succeeded — not completed until verification passes" })
        }
        persistDAG()
        ts.setLastOperation(`node:${currentNodeId} segment:${segment} files:${changedFiles.size} tools:${segToolCalls}`)
      } catch { }
    } else if (dag) {
      // DIAGNOSTIC ONLY (P0): attributeSegment may annotate what a segment
      // LOOKED like, but it must never determine authoritative DAG state —
      // no markCompleted / markFailed / markExecutionSucceeded here.
      try {
        const progress = { files: changedFiles.size, toolCalls: segToolCalls, text: String(res.text ?? "").slice(0, 800), segment }
        const segNode = attributeSegment(dag, progress)
        if (segNode) {
          emit({
            type: "DAG_DIAGNOSTIC_ATTRIBUTION", taskId, runId: taskRunId, segmentId,
            nodeId: segNode.id, guessed: true, applied: false,
            reason: "diagnostic only — heuristic attribution never mutates DAG state",
          })
        }
      } catch { }
    }

    // Files written in THIS segment change the artifact: evidence recorded in
    // EARLIER segments that covered them is stale now (epoch bump + invalidate).
    if (segChanged.size) {
      const n = ledger.touch([...segChanged].map((f) => path.relative(process.cwd(), f)))
      ts.setVerificationEpoch(Math.max(state.verification_epoch ?? 0, ledger.epoch))
      if (n) emit({ type: "VERIFICATION_INVALIDATED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, count: n, reason: "files changed after evidence", files: [...segChanged].map((f) => path.relative(process.cwd(), f)).slice(0, 20) })
    }
    for (const chk of res.commandChecks ?? []) {
      const rec = ledger.recordCommand(chk.command, chk.tail + (chk.passed ? "" : ` [exit code: ${chk.exitCode}]`), {
        exitCode: chk.exitCode,
        duration: null,
        affectedFiles: [...changedFiles].map((f) => path.relative(process.cwd(), f)),
        taskId,
        nodeId: currentNodeId,
        segmentId,
        verificationEpoch: state.verification_epoch ?? 0,
        cwd: chk.cwd, env: chk.env, repoState: chk.repoState, stdoutTail: chk.stdoutTail, timestamp: chk.at,
        filesWrittenAfter: (chk.filesWrittenAfter ?? []).map((f) => f === "(shell write)" ? f : path.relative(process.cwd(), f)),
      })
      if (rec.invalidated) emit({ type: "VERIFICATION_INVALIDATED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, count: 1, reason: rec.staleReason, command: rec.command, verificationId: rec.verification_id })
      ts.noteVerification(rec)
      ts.noteTest({ command: rec.command, exit_code: rec.exit_code ?? rec.exitCode, passed: rec.passed })
      emit({ type: chk.passed ? "VERIFICATION_PASSED" : "VERIFICATION_FAILED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, vtype: rec.type, command: rec.command, exitCode: rec.exitCode ?? rec.exit_code, evidence: rec.evidence, verificationId: rec.verification_id })
    }

    // v21.2: LSP diagnostics on files this segment mutated feed the SYNTAX
    // gate. Error-severity diagnostics fail HIGH/CRITICAL the same way a
    // failed `node --check` does. v96 unifywise: the AUTOSTART table now
    // participates (allowAutostart) — typescript-language-server/pyright/
    // gopls/rust-analyzer on PATH produce diagnostics evidence with zero
    // user config, closing the gap where the DEFAULT language path had
    // structured extraction but no verification evidence. A missing/failed
    // server is still skipped, never a gate failure.
    if (segChanged.size && config?.tools?.lsp !== false) {
      let diags = []
      try {
        diags = await collectDiagnosticsForFiles(config, [...segChanged], { cwd: process.cwd(), allowAutostart: true })
        for (const d of diags) {
          const relFile = path.relative(process.cwd(), d.file)
          const rec = ledger.recordCommand(`lsp_diagnostics ${relFile}`, d.text, {
            type: VTYPE.SYNTAX,
            exitCode: d.passed ? 0 : 1,
            affectedFiles: [relFile],
            taskId,
            nodeId: currentNodeId,
            segmentId,
            verificationEpoch: state.verification_epoch ?? 0,
          })
          ts.noteVerification(rec)
          emit({ type: d.passed ? "VERIFICATION_PASSED" : "VERIFICATION_FAILED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, vtype: rec.type, command: rec.command, exitCode: rec.exitCode ?? rec.exit_code, evidence: rec.evidence, verificationId: rec.verification_id })
        }
      } catch { /* best-effort: a broken language server must not crash the gate */ }
      // v99 loopwise: the gate's diagnostics are REUSED by the reviewer pass
      // below — one LSP spawn serves both the gate and the review.
      segDiags = diags
    }

    // v93 §13 (gap fix): a mutation invalidates EXACTLY what it touched —
    // drop the changed files from the persisted world-model snapshot so the
    // next world build (next segment's plan, compose, or a restarted forge)
    // re-extracts only those files instead of trusting stale records.
    if (segChanged.size) {
      try {
        const changedRel = [...segChanged].map((f) => path.relative(process.cwd(), f))
        const changedSet = new Set(changedRel)
        // v97 §21 — API/SCHEMA DRIFT: capture the pre-mutation contracts of the
        // changed files (from the persisted world — the last recorded truth),
        // then compare with the re-extracted records after invalidation. A
        // removed route/table/proto or an orphaned consumer is ADVISORY
        // evidence: detected and reported, never silently ignored.
        // v98 shipwise FIX: the "before" capture went through the world
        // getter, which REBUILDS and re-extracts from disk — so "pre-mutation"
        // was actually POST-mutation and drift could never fire. The last
        // recorded truth is read from the PERSISTED SNAPSHOT (persistedRecords
        // — no walk, no re-extraction), which is exactly what the comment
        // always claimed.
        let beforeFiles = []
        try {
          beforeFiles = createWorldModel({ cwd: process.cwd() }).persistedRecords(changedRel)
            .map((f) => ({ path: f.path, contracts: f.contracts ?? [] }))
        } catch { beforeFiles = [] }
        createWorldModel({ cwd: process.cwd() }).invalidate(changedRel)
        emit({ type: "WORLD_INVALIDATED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, files: changedRel.slice(0, 12) })
        if (beforeFiles.length) {
          try {
            const wmAfter = createWorldModel({ cwd: process.cwd() })
            const afterWorld = wmAfter.build()
            const afterFiles = (afterWorld.files ?? []).filter((f) => changedSet.has(f.path)).map((f) => ({ path: f.path, contracts: f.contracts ?? [] }))
            const drift = contractDrift(beforeFiles, afterFiles)
            if (!drift.ok) {
              emit({
                type: "CONTRACT_DRIFT", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId,
                removed: drift.removed.slice(0, 6), orphaned: drift.orphaned.slice(0, 6),
                text: `contract drift: ${drift.removed.length} removed producer(s), ${drift.orphaned.length} orphaned consumer(s) — verify API/schema consumers still match`,
              })
            }
          } catch { /* drift is advisory evidence, never a gate crash */ }
        }
        // §22: knowledge verified against files that just changed is stale —
        // mark it so promotion is blocked and consumers see the staleness
        const stale = markStaleSkills(process.cwd(), changedRel)
        if (stale.marked) emit({ type: "SKILLS_STALE", taskId, runId: taskRunId, segmentId, skills: stale.skills.slice(0, 8) })
        // v98 shipwise — TIER-3 STRUCTURED ENRICHMENT of exactly the files
        // this segment changed. One LSP session per server, bounded budget,
        // honest per-file fallback: records upgrade to
        // {symbolDetails, extraction:{layer:3}} in the SHARED index, and the
        // next world build serves them (extractOne reuses fresh records by
        // fingerprint — the enrichment survives the rebuild). No server on
        // PATH → zero candidates → zero cost. Best-effort by law.
        if (config?.tools?.lsp !== false) {
          try {
            const enr = await enrichIndex(process.cwd(), { config, files: changedRel, budgetMs: 8000, maxFiles: 60 })
            if (enr && (enr.enriched || enr.failed || enr.noSymbols)) {
              emit({ type: "WORLD_ENRICHED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, enriched: enr.enriched ?? 0, failed: enr.failed ?? 0, noSymbols: enr.noSymbols ?? 0, skipped: enr.skipped ?? 0, servers: enr.servers ?? {} })
            }
          } catch { /* enrichment is best-effort — the lexical floor always answers */ }
        }
      } catch { /* invalidation is best-effort; fingerprints still catch drift */ }
    }

    const u = res.usage ?? {}
    const tokIn = u.prompt ?? u.prompt_tokens ?? u.input_tokens ?? u.promptTokens ?? 0
    const tokOut = u.completion ?? u.completion_tokens ?? u.output_tokens ?? u.completionTokens ?? 0
    resources.record({ tokensIn: tokIn, tokensOut: tokOut, toolCalls: segToolCalls, latencyMs: segMs, workers: manager.stats().active })
    // v93 §23: store the actual segment outcome WITH context (class +
    // languages + latency) — strategy 3.0 selection learns what worked where
    try {
      const { recordStrategy } = await import("./strategy.js")
      recordStrategy({
        cwd: process.cwd(), name: `klass:${classified.class ?? "UNKNOWN"}`,
        ok: !res.error && !res.budgetHit,
        klass: classified.class ?? null,
        langs: languagesIn(state.objective).slice(0, 6),
        latencyMs: segMs,
      })
    } catch { /* strategy memory is best-effort */ }
    // v96 unifywise: skill-variant outcomes were CLI-only (`forge variant
    // score`) — the autonomous loop never scored the variants compose
    // surfaced, so variant rates stayed at 0 and selection ran on name hits
    // alone. The TOP surfaced variant now records the segment outcome, same
    // as strategy recording above (bounded: one variant, one row per segment).
    try {
      const topVariant = composedSnap?.variants?.[0]
      if (topVariant?.name) {
        const { recordVariantOutcome } = await import("./variant.js")
        recordVariantOutcome({ cwd: process.cwd(), name: topVariant.name, ok: !res.error && !res.budgetHit, durationMs: segMs })
      }
    } catch { /* variant memory is best-effort */ }
    const segStatus = res.error ? "failed" : res.budgetHit ? "continued" : "completed"
    ts.addSegment({ segment_id: segmentId, node_id: currentNodeId, objective: state.objective, status: segStatus, steps: res.steps ?? 0, tool_calls: segToolCalls, continued: !!res.budgetHit })
    ts.noteUsage({ tokens_in: tokIn, tokens_out: tokOut, tool_calls: segToolCalls, ms: segMs, workers: manager.stats().active })
    persistCritical()

    if (!res.aborted && config?.agent?.modelStrategy !== false) {
      const rad = resources.evaluate()
      const wantModel = rad.actions.some((a) => a.action === ADAPT.PREFER_FAST_MODEL) || resources.state.slowStreak >= 3
      if (wantModel) {
        const decision = reconsiderModel(config, {
          task: state.objective,
          provider: { name: prov?.name, model: prov?.model },
          failures: res.error ? consecutiveFailures : 0,
          failureKind: res.error ? "reasoning" : null,
          resourceLimits: { preferredClass: rad.limits.preferredClass ?? "fast_reasoning" },
        })
        if (decision && (decision.provider !== prov?.name || decision.model !== prov?.model)) {
          try {
            const { buildProvider } = await import("./providers.js")
            const np = buildProvider(config, decision.provider)
            if (np && np.model) {
              prov = { ...np, model: decision.model }
              provRef.prov = prov
              manager.configure({ config, provider: prov })
              ts.noteModel(decision.provider, decision.model, `reconsidered: ${decision.reason}`)
              emit({ type: "MODEL_SELECTED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, model: decision.model, provider: decision.provider, reason: decision.reason, confidence: decision.confidence, reconsidered: true })
              emit({ type: "STRATEGY_CHANGED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, reason: `model → ${decision.model} (${decision.provider}): ${decision.reason}` })
            }
          } catch { }
        }
      }
    }

    emit({ type: "SEGMENT_COMPLETED", taskId, runId: taskRunId, segment, segmentId, nodeId: currentNodeId, status: segStatus, steps: res.steps, toolCalls: segToolCalls, budgetHit: !!res.budgetHit })

    // v94 masterwise (§8/§10): the ExecutionController observes EVERY finished
    // segment. Stuck signals (tool loops, repeated identical failures, no
    // meaningful state change) trigger DIAGNOSE → CHANGE STRATEGY → REPLAN →
    // CONTINUE — never completion. A budget-only segment is telemetry: the
    // loop continues below regardless.
    {
      let nodesCompletedNow = 0
      let nodesExecSucceededNow = 0
      if (dag) {
        try {
          for (const n of dag.nodes.values()) {
            if (n.status === dagLib.NODE_STATUS.COMPLETED) nodesCompletedNow++
            else if (n.status === dagLib.NODE_STATUS.EXECUTION_SUCCEEDED || n.status === dagLib.NODE_STATUS.VERIFYING) nodesExecSucceededNow++
          }
        } catch { }
      }
      const xDecision = xctl.observeSegment({
        segment, budgetHit: !!res.budgetHit, error: res.error ?? null,
        filesChanged: segChanged.size, nodesCompleted: nodesCompletedNow,
        nodesExecutionSucceeded: nodesExecSucceededNow,
        workerCompletions: workerCompletionsTotal,
        toolRecords: recs,
      })
      // v94 masterwise (§11 L1/L2): the observation stream — one bounded
      // working-memory record per segment (what happened, which files).
      try {
        engMem.observeSegment({ segment, status: res.error ? "error" : "ok", files: [...segChanged].map((f) => path.relative(process.cwd(), f)), error: res.error ?? null })
        if (res.error) engMem.noteEvidence(`segment ${segment} failed: ${String(res.error).slice(0, 120)}`)
      } catch { }
      if (xDecision.action === "replan" && xDecision.stuck && !res.error) {
        ts.noteError("STUCK_STRATEGY_ESCAPE", `${xDecision.stuck.reason}: ${xDecision.stuck.detail}`)
        const rp = await tryMidTaskReplan({ reason: `stuck (${xDecision.stuck.reason}): ${xDecision.stuck.detail}`, evidence: xDecision.stuck.detail, stuck: true })
        if (rp.ok) {
          currentNodeId = null
          currentNode = null
          ts.transition(TASK_STATUS.EXECUTING, { reason: "stuck escape: changed strategy, continuing with the replanned graph" })
          continue
        }
        // replan unavailable (budget/class policy): continue anyway — stuck
        // is never allowed to become a terminal state by the controller.
      }
    }

    if (res.error) {
      consecutiveFailures++
      ts.transition(TASK_STATUS.REPAIRING, { reason: "segment errored" })
      ts.noteError("SEGMENT_FAILED", res.error)
      emit({ type: "REPAIR_STARTED", taskId, runId: taskRunId, segment, segmentId, nodeId: currentNodeId, attempt: consecutiveFailures, error: redact(String(res.error)).slice(0, 200) })
      const recovered = await repairSegment({ agent, config, provider: prov, signal, emit, state, error: res.error, segment, ts, ledger, ctxEngine, taskRunId, taskId, segmentId, nodeId: currentNodeId, omega, changedFiles: [...changedFiles], liveRisk, episodeSink, verifierReport: lastVerifierReport })
      repairCount += recovered ? 1 : 0
      ts.noteRepair(recovered ? 1 : 0)
      if (consecutiveFailures >= 3 || !recovered) {
        recordLesson({
          failure: String(res.error).slice(0, 200),
          cause: "segment failed repeatedly",
          failedStrategy: "repeat same approach",
          successfulRepair: "",
          applicableContext: state.objective,
          task: state.objective,
          confidence: 0.5,
          // P1 structured schema: where it happened, what it looked like and
          // which model/strategy produced it — so the lesson is retrievable by
          // failure class, file, symbol and ecosystem instead of fuzzy text.
          symptoms: String(res.error).slice(0, 400),
          rootCause: "segment failed repeatedly",
          files: [...changedFiles].map((f) => path.relative(process.cwd(), f)).slice(0, 12),
          symbols: affectedSymbols.slice(0, 12),
          model: prov?.model ?? null,
          strategy: "repeat same approach",
        }, process.cwd())
        if (consecutiveFailures >= 3) {
          finalStatus = explicitFinalization(FINAL.FAILED)
          finalText = `task failed after ${consecutiveFailures} consecutive failed segments: ${redact(String(res.error)).slice(0, 300)}`
          ts.noteError("GIVE_UP", finalText)
          break
        }
      }
      const rp = await tryMidTaskReplan({ reason: res.error, evidence: String(res.error).slice(0, 400) })
      if (rp.ok) { currentNodeId = null; currentNode = null }
      ts.transition(TASK_STATUS.EXECUTING, { reason: "after repair" })
      continue
    }
    consecutiveFailures = 0

    // --- VERIFICATION HARD GATE (P0) ---------------------------------------
    ts.transition(TASK_STATUS.VERIFYING, { reason: "post-segment verification" })

    // P0: FINAL RISK IS RECALCULATED FROM WHAT ACTUALLY CHANGED.
    // riskLevel is the PLANNING risk (from the objective). riskNow (below the
    // loop) only counted files. Neither inspects paths. A task that said "add a
    // comment" (trivial) but went on to edit package.json, a migration and an
    // authentication module must be verified as CRITICAL, not as trivial.
    for (const c of res.commandChecks ?? []) if (c?.command) mutatingCommands.add(String(c.command))
    for (const r of recs) for (const c of (r.commands ?? [])) if (c) mutatingCommands.add(String(c))
    const changedRel = [...changedFiles].map((f) => path.relative(process.cwd(), f))
    let impact = null
    if (changedRel.length) {
      try {
        impact = omega.impact(changedRel.map((f) => path.resolve(process.cwd(), f)))
        let cf = null
        try { cf = omega.counterfactualOf(null) } catch { cf = null }
        emit({
          type: "IMPACT_ANALYZED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId,
          radius: impact.radius, scope: impact.scope, importers: impact.importers.length,
          tests: impact.tests.slice(0, 8), unknown: impact.unknown,
          stillAtRisk: cf?.stillAtRisk?.slice(0, 8) || [],
        })
        for (const f of changedRel) omega.noteWrite(f)
      } catch { /* impact is advisory; never block verification */ }
    }
    const finalRisk = finalRiskForChange({
      task: state.objective,
      initialRisk: riskLevel,
      changedFiles: changedRel,
      createdFiles: (state.files_created ?? []).map((f) => path.relative(process.cwd(), f)),
      deletedFiles: [...deletedFiles].map((f) => path.relative(process.cwd(), f)),
      affectedSymbols: affectedSymbols,
      commands: [...mutatingCommands],
    })
    const finalRiskLevel = finalRisk.risk
    if (finalRisk.escalated) {
      ts.setNextAction(`verify: risk recalculated ${finalRisk.initialRisk} → ${finalRiskLevel} (${finalRisk.signals.slice(0, 3).join(", ")})`)
      emit({
        type: "FINAL_RISK_RECALCULATED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId,
        initialRisk: finalRisk.initialRisk, finalRisk: finalRiskLevel,
        signals: finalRisk.signals, reasons: finalRisk.reasons, counts: finalRisk.counts,
      })
    }
    // The node itself is now officially under verification (not completed).
    if (dag && currentNodeId && !res.error) dagLib.markVerifying(dag, currentNodeId)

    const v = ledger.status(finalRiskLevel, changedRel, { nodeId: currentNodeId })
    emit({ type: "VERIFICATION_STATUS", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, ok: v.ok, missing: v.missing, reason: v.reason, risk: finalRiskLevel, initialRisk: riskLevel, status: v.status })
    // v96 unifywise: the episode's VERIFICATION stage — the segment-level
    // verdict (what the gate actually judged), one bounded record per segment.
    if (episodeSink) episodeSink.addVerification({ command: `segment-${segment} verification (${finalRiskLevel}): ${String(v.reason ?? v.status ?? "").slice(0, 160)}`, ok: v.ok === true })

    // VERIFICATION FAILED → REPAIRING (hard gate). The node goes back to
    // REPAIRING too: execution succeeded, the OUTCOME did not.
    if (v.anyFailure) {
      if (dag && currentNodeId) { try { dagLib.markRepairing(dag, currentNodeId, v.reason); persistDAG() } catch { } }
      ts.transition(TASK_STATUS.REPAIRING, { reason: "verification failed" })
      emit({ type: "REPAIR_STARTED", taskId, runId: taskRunId, segment, segmentId, nodeId: currentNodeId, attempt: repairCount + 1, error: v.reason })
      const recovered = await repairSegment({ agent, config, provider: prov, signal, emit, state, error: v.reason, segment, ts, ledger, ctxEngine, verification: v, taskRunId, taskId, segmentId, nodeId: currentNodeId, finalRisk: finalRiskLevel, omega, changedFiles: [...changedFiles], liveRisk, episodeSink, verifierReport: lastVerifierReport })
      repairCount += recovered ? 1 : 0
      ts.noteRepair(recovered ? 1 : 0)
      evidenceRequests = 0

      // REPAIR → VERIFYING → (PASS) COMPLETED. The repair agent records its
      // own evidence in the ledger, so re-judge the node here: if the evidence
      // now holds, the node is DONE — otherwise it goes back to VERIFYING and
      // the next segment retries it.
      if (dag && currentNodeId) {
        try {
          const vAfter = ledger.status(finalRiskLevel, changedRel, { nodeId: currentNodeId })
          if (vAfter.ok && !vAfter.anyFailure) {
            completeNodeIfVerified(currentNodeId, { risk: finalRiskLevel, segmentId, phase: "after-repair" })
            // if that was the last node, the gate can decide immediately
            if (dagLib.allComplete(dag)) {
              const outcome = await attemptCompletion({ text: res.text ?? "task completed", segment, segmentId, nodeId: currentNodeId })
              if (outcome.done) break
            }
          } else {
            dagLib.markVerifying(dag, currentNodeId)
            persistDAG()
            const rp = await tryMidTaskReplan({
              reason: vAfter.reason || v.reason || "verification failed",
              evidence: (vAfter.missing || v.missing || []).join(", "),
            })
            if (rp.ok) { currentNodeId = null; currentNode = null }
          }
        } catch { }
      }
      ts.transition(TASK_STATUS.EXECUTING, { reason: "after verification repair" })
      continue
    }

    const finished = !res.budgetHit
    const needsMore = res.budgetHit

    const noMutation = changedFiles.size === 0
    // Verification is required unless nothing was mutated, or the FINAL
    // (recalculated) risk is trivial. Note this uses finalRiskLevel, not the
    // planning-time riskLevel — this is the single most important consumer of
    // the recalculation.
    const verificationRequired = !(noMutation || finalRiskLevel === "trivial")

    // --- NODE COMPLETION REQUIRES NODE VERIFICATION (P0) -------------------
    // Execution already succeeded above; the node may now be marked COMPLETED
    // only if its verification passed (or it has nothing to verify: a read-only
    // node, or a node that did not actually mutate anything at trivial risk).
    if (dag && currentNodeId && !res.error) {
      try {
        const nodeObj = dag.nodes.get(currentNodeId)
        const segMutation = changedFiles.size > changedBefore
        const nodeNeedsVerification = nodeObj
          ? (nodeObj.read_only !== true && (segMutation || finalRiskLevel !== "trivial"))
          : true
        if (!nodeNeedsVerification) {
          dagLib.markCompleted(dag, currentNodeId, `segment ${segment}: read-only node, no artifact to verify`, { verification: dagLib.VERIFICATION_NOT_REQUIRED })
          persistDAG()
        } else if (!completeNodeIfVerified(currentNodeId, { risk: finalRiskLevel, segmentId, phase: "post-segment" })) {
          dagLib.markVerifying(dag, currentNodeId)
          emit({ type: "DAG_NODE_AWAITING_VERIFICATION", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, missing: v.missing, risk: finalRiskLevel })
          persistDAG()
        }
      } catch { }
    }

    // If the segment merely spent its budget, continue to the next one.
    // v94 masterwise (§6): a budget end is CHECKPOINT → OBSERVE → CONTINUE.
    // The budgetHit flag means the AGENT WANTED MORE STEPS — it is never a
    // completion trigger, even when the DAG looks finished (a later segment
    // may still invalidate evidence). The completion gate runs only on a
    // segment that ended cleanly, below.
    if (!finished) {
      evidenceRequests = 0
      ts.setNextAction("continue: segment budget spent, work remains")
      ts.transition(TASK_STATUS.EXECUTING, { reason: "continuing to next segment" })
      continue
    }

    // --- v99 loopwise: the REVIEWER pass ------------------------------------
    // A clean segment that mutated files gets ONE bounded read-only code
    // review of the actual change (diff + LSP diagnostics + failing ledger
    // evidence), before the completion gate is asked anything. This is the
    // "second pair of eyes" the v98 surfaces lacked: review.js checked
    // METADATA at completion; this checks the CODE per mutation. Blockers
    // become required actions (which block completion and drive repair —
    // and are re-derived on every later completion attempt, never stale).
    // Bounded: maxPerTask reviews (default 4), skipped at trivial risk,
    // honest when the reviewer pass is unavailable (deterministic findings
    // alone still review), never throws.
    {
      const maxReviews = Number.isFinite(Number(config?.review?.maxPerTask)) ? Math.max(0, Number(config.review.maxPerTask)) : 4
      const reviewOn = config?.review?.code !== false && maxReviews > 0 && codeReviewsDone < maxReviews
      if (reviewOn && segChanged.size && finalRiskLevel !== "trivial" && !res.error) {
        codeReviewsDone++
        try {
          emit({ type: "CODE_REVIEW_STARTED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, files: [...segChanged].map((f) => path.relative(process.cwd(), f)).slice(0, 16) })
          const failingRecords = (ledger.records() ?? [])
            .filter((r) => Number(r.exit_code ?? r.exitCode ?? 0) !== 0 && r.command)
            .slice(-8)
            .map((r) => ({ command: r.command, exit_code: Number(r.exit_code ?? r.exitCode ?? 0), evidence: r.evidence ?? null }))
          const review = await runCodeReview({
            agent, config, provider: prov, signal, emit,
            objective: state.objective,
            files: [...segChanged],
            diagnostics: segDiags,
            ledgerFailures: failingRecords,
            taskId, runId: taskRunId, segmentId, nodeId: currentNodeId,
          })
          emit({
            type: "CODE_REVIEW_COMPLETED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId,
            ok: review.blockers.length === 0,
            findings: review.findings.length, blockers: review.blockers.length,
            detail: review.findings.slice(0, 8).map((f) => `[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""} ${f.issue}`),
            sources: review.sources, facts: review.facts,
          })
          if (episodeSink && review.findings.length) {
            episodeSink.addEvidence(`code review: ${review.findings.slice(0, 4).map((f) => `${f.severity} ${f.file}: ${String(f.issue ?? "").slice(0, 80)}`).join(" | ")}`)
          }
          // blockers → required actions (recurring prefix; re-derived on every
          // completion attempt — refreshRecurringActions keeps them honest)
          for (const b of review.blockers.slice(0, 4)) {
            addRequiredAction(`codereview: ${b.file}: ${String(b.issue ?? b.id).slice(0, 160)}`)
          }
        } catch (e) {
          emit({ type: "CODE_REVIEW_COMPLETED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, ok: true, findings: 0, blockers: 0, detail: [], error: String(e?.message ?? e).slice(0, 160) })
        }
      }
    }

    // --- the ONE authoritative whole-task completion decision (P0) ---------
    // Nothing above may declare COMPLETED. The gate asks the global question:
    // is the whole DAG finished, are all workers settled, is the evidence
    // sufficient for the FINAL risk, is recovery clear, and did the terminal
    // state actually reach disk?
    if (!verificationRequired || v.ok) {
      const outcome = await attemptCompletion({ text: res.text ?? "task completed", segment, segmentId, nodeId: currentNodeId })
      if (outcome.done) break
    } else if (evidenceRequests < 1) {
      // Evidence is thin for the final risk: ask the READ-ONLY verifier for it.
      evidenceRequests++
      ts.setNextAction(`verify: run ${v.missing.join(" / ")} before declaring success`)
      ts.transition(TASK_STATUS.VERIFYING, { reason: "requesting risk-proportional evidence" })
      emit({ type: "STRATEGY_CHANGED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, reason: `objective met but evidence is thin for risk=${finalRiskLevel} — run ${v.missing.join(", ")} to verify`, missing: v.missing })
      lastVerifierReport = (await requestVerification({ agent, config, provider: prov, signal, emit, state, missing: v.missing, ts, ledger, ctxEngine, taskRunId, taskId, segmentId, nodeId: currentNodeId, risk: finalRiskLevel, impact }))?.report ?? null
      // the verifier produced new evidence: the node may now be completed
      completeNodeIfVerified(currentNodeId, { risk: finalRiskLevel, segmentId, phase: "after-verification" })
      const outcome = await attemptCompletion({ text: res.text ?? "task completed", segment, segmentId, nodeId: currentNodeId })
      if (outcome.done) break
    }

    // The gate refused completion: fall back to the safe state it recommended.
    const outcome = await refuseCompletion({ v, segment, segmentId, nodeId: currentNodeId, finalRiskLevel, text: res.text })
    if (outcome.done) break

    evidenceRequests = 0
    ts.setNextAction("continue: segment budget spent, work remains")
    ts.transition(TASK_STATUS.EXECUTING, { reason: "continuing to next segment" })
  }

  // P0 segment safety fuse: maxSegments is a SAFETY LIMIT, not a task failure.
  //   CHECKPOINT → PERSIST → WAITING / CONTINUE_REQUIRED → RESUME
  // It is persisted with everything resume needs: taskId, runId, nodeId,
  // segmentId, checkpointId, DAG state, verification epoch and next action.
  // The continuation budget keeps "resume later" from looping forever: past it
  // the task genuinely is FAILED (it had N chances and did not converge).
  if (finalStatus !== FINAL.COMPLETED && finalStatus !== FINAL.CANCELLED && segment >= maxSeg) {
    await settleWorkers()
    let cpId = null
    try {
      const cwd = process.cwd()
      const touched = [...changedFiles].filter((f) => { try { return fs.existsSync(f) } catch { return false } })
      cpId = touched.length
        ? snapshotBefore(touched, cwd, [], taskRunId)
        : boundaryCheckpoint(cwd, { runId: taskRunId, label: `safety-fuse-${segment}`, objective: state.objective })
      if (cpId) { ts.noteCheckpoint(cpId); try { engMem.rememberCheckpoint(cpId) } catch { } }
      emit({ type: "CHECKPOINT_CREATED", taskId, runId: taskRunId, boundary: "safety-fuse", segment, checkpointId: cpId })
    } catch {}
    continuationCount++
    ts.noteContinuation?.()
    persistDAG()
    emit({
      type: "SEGMENT_SAFETY_FUSE",
      taskId, runId: taskRunId, segment, nodeId: state.node_id ?? null,
      maxSegments: maxSeg,
      continuation: continuationCount,
      maxContinuations,
      checkpointId: cpId,
      continuationRequired: true,
      reason: `segment safety budget (${maxSeg}) reached — checkpointed and waiting for resume (CONTINUE_REQUIRED), not FAILED`,
      autoContinueRefused: lastRefusal,
    })
    if (continuationCount > maxContinuations) {
      finalStatus = explicitFinalization(FINAL.FAILED)
      finalState = TASK_STATUS.FAILED
      finalText = `continuation budget exhausted after ${continuationCount} resume(s) — not converging`
      ts.transition(TASK_STATUS.FAILED, { reason: finalText })
      ts.setNextAction(null)
      persistCritical()
      ts.noteError("CONTINUATION_BUDGET_EXHAUSTED", finalText)
    } else {
      finalStatus = explicitFinalization(FINAL.WAITING)
      finalState = TASK_STATUS.WAITING
      finalText = `segment safety budget (${maxSeg}) reached — checkpointed and waiting for resume (CONTINUE_REQUIRED), not FAILED (continuation ${continuationCount}/${maxContinuations})`
      ts.transition(TASK_STATUS.WAITING, { reason: `safety fuse: ${maxSeg} segments reached — CONTINUE_REQUIRED` })
      ts.setNextAction(`continue_required: safety budget ${maxSeg} reached — resume later`)
      persistCritical()
      ts.noteError("SEGMENT_BUDGET_CONTINUE", finalText)
    }
  }

  // A cancelled run must never be reported as anything else.
  if (signal?.aborted && finalStatus !== FINAL.CANCELLED) {
    finalStatus = explicitFinalization(FINAL.CANCELLED)
    finalState = TASK_STATUS.CANCELLED
    finalText = finalText || "cancelled by user"
  }

  // P0 explicit finalization: preserve actual terminal state
  // COMPLETED → COMPLETED, FAILED → FAILED, WAITING → WAITING, CANCELLED → CANCELLED
  // Never silently convert WAITING into FAILED
  if (finalStatus === FINAL.COMPLETED) ts.transition(TASK_STATUS.COMPLETED, { reason: "done", durability: DURABILITY.CRITICAL })
  else if (finalStatus === FINAL.FAILED) ts.transition(TASK_STATUS.FAILED, { reason: finalText, durability: DURABILITY.CRITICAL })
  else if (finalStatus === FINAL.WAITING) ts.transition(TASK_STATUS.WAITING, { reason: finalText, durability: DURABILITY.CRITICAL })
  else if (finalStatus === FINAL.CANCELLED) ts.transition(TASK_STATUS.CANCELLED, { reason: "user cancel", durability: DURABILITY.CRITICAL })
  else ts.transition(TASK_STATUS.FAILED, { reason: finalText, durability: DURABILITY.CRITICAL })

  // P1 critical durability: the terminal state MUST reach disk. If it does not,
  // say so and refuse to report COMPLETED — never pretend it was persisted.
  if (!persistCritical()) {
    emit({ type: "CRITICAL_PERSISTENCE_FAILED", taskId, runId: taskRunId, error: "terminal state could not be written — completion is not durable" })
    if (finalStatus === FINAL.COMPLETED) {
      finalStatus = explicitFinalization(FINAL.WAITING)
      finalState = TASK_STATUS.WAITING
      finalText = `completed but NOT durably persisted — waiting instead of claiming success`
      ts.transition(TASK_STATUS.WAITING, { reason: finalText })
      try { ts.flush(DURABILITY.CRITICAL) } catch {}
    }
  }

  // P1 model routing on REAL history: record what this run actually achieved
  // so the next routing decision is evidence-based, not name-based.
  try {
    const vAll = ledger.all()
    recordOutcome({
      provider: prov?.name ?? null,
      model: prov?.model ?? null,
      taskClass: (requiredCaps?.[0]?.class) ?? (sel?.decision?.capabilities?.[0]) ?? "general",
      ok: finalStatus === FINAL.COMPLETED,
      crashed: state.errors?.some((e) => /PROVIDER|CRASH|PROCESS/i.test(String(e.code ?? ""))) === true,
      repairs: repairCount,
      verificationPassed: vAll.filter((r) => r.passed).length,
      verificationTotal: vAll.length,
      latencyMs: state.resource_usage?.ms ?? null,
      tokensIn: state.resource_usage?.tokens_in ?? 0,
      tokensOut: state.resource_usage?.tokens_out ?? 0,
      toolCalls: totalToolCalls,
    })
    // v96 unifywise: the empirics ledger (model-outcomes.json — what compose's
    // MODELS line reads) had NO production writer: it stayed empty in every
    // real run and pickModelEmpiric surfaced nothing. The run's outcome now
    // reaches BOTH stores — modelstrategy's performance ledger (capability
    // scoring, Bayesian-shrunk) and empirics (the compose/CLI display view).
    try {
      const { recordModelOutcome } = await import("./empirics.js")
      recordModelOutcome({
        provider: prov?.name ?? null,
        model: prov?.model ?? null,
        ok: finalStatus === FINAL.COMPLETED,
        ms: state.resource_usage?.ms ?? null,
        klass: classified?.class ?? null,
      })
    } catch { /* the empirics view is best-effort */ }
  } catch { }

  emit({ type: "TASK_FINISHED", taskId, runId: taskRunId, status: finalStatus, state: finalState, segments: segment, repairs: repairCount, text: String(finalText).slice(0, 300) })

  const finalRisk = recomputeFinalRisk()
  return {
    taskId,
    runId: taskRunId,
    status: finalStatus,
    state: finalState,
    text: finalText,
    segments: segment,
    repairs: repairCount,
    toolCalls: totalToolCalls,
    filesChanged: [...changedFiles],
    filesDeleted: [...deletedFiles],
    // FINAL risk (recalculated from what actually changed), not the planning risk
    risk: finalRisk.risk,
    initialRisk: finalRisk.initialRisk,
    riskEscalated: finalRisk.escalated,
    riskSignals: finalRisk.signals,
    completionGate: lastGate ? { ok: lastGate.ok, status: lastGate.status, checks: lastGate.checks, blockers: lastGate.blockers } : null,
    verification: ledger.status(finalRisk.risk, [...changedFiles].map((f) => path.relative(process.cwd(), f))),
    task: state,
  }
}

function passThrough(emit, tag) {
  return (ev) => { try { emit({ ...ev, phase: tag }) } catch {} }
}

function segmentEvents(emit, segment, ids = {}) {
  return (ev) => {
    if (!ev || !ev.type) return
    if (ev.type === "run_start" || ev.type === "run_end") return
    try { emit({ ...ids, ...ev, segment }) } catch {}
  }
}

async function repairSegment({ agent, config, provider, signal, emit, state, error, segment, ts, ledger, ctxEngine, verification = null, taskRunId = null, taskId = null, segmentId = null, nodeId = null, omega = null, changedFiles = [], liveRisk = null, episodeSink = null, verifierReport = null }) {
  ts.transition(TASK_STATUS.REPAIRING, { reason: "diagnosing failure" })
  const ctxBlock = await ctxEngine.buildAsync(state.objective, { budgetTokens: 1600 })
  const failText = String(error ?? verification?.reason ?? "")
  let hypoHint = ""
  let observed = null
  let next = null
  if (omega) {
    observed = omega.observeCommand(failText, { tool: "segment", files: changedFiles })
    next = omega.nextRepair()
    // v96 unifywise: the episode's HYPOTHESES stage is now fed from the Ω
    // kernel's live ledger (the durable "full story" the episodic memory was
    // designed for and never received).
    if (episodeSink && observed?.hypothesis) {
      episodeSink.addHypothesis(String(observed.hypothesis.description ?? "").slice(0, 400), { status: "supported", confidence: observed.hypothesis.confidence ?? 0.55 })
    }
    if (observed.diagnosis?.failed) {
      hypoHint += `\n\nFailure class: ${observed.diagnosis.code}. Evidence: ${String(observed.diagnosis.evidence ?? "").slice(0, 240)}.`
    }
    if (observed.originHint) hypoHint += `\n${observed.originHint}`
    if (observed.origin) {
      emit({ type: "ORIGIN_CLASSIFIED", taskId, runId: taskRunId, segmentId, nodeId, origin: observed.origin.origin, why: observed.origin.why, code: observed.origin.code })
    }
    if (next.causal?.node) {
      hypoHint += `\nCausal target (${next.causal.layer}, ${next.causal.node.id}): ${next.causal.node.description} — ${next.causal.reason}`
      emit({
        type: "CAUSAL_UPDATED", taskId, runId: taskRunId, segmentId, nodeId,
        layer: next.causal.layer, id: next.causal.node.id,
        description: next.causal.node.description, reason: next.causal.reason,
      })
    }
    if (next.hypothesis) {
      hypoHint += `\nCurrent hypothesis (${next.hypothesis.id}, ${next.hypothesis.status}, conf=${Number(next.hypothesis.confidence).toFixed(2)}): ${next.hypothesis.description}`
      if (next.action === "escalate") {
        hypoHint += `\nThis hypothesis has already been tested twice — do NOT retry it. Pick a different cause.`
      }
    }
    if (next.experiment) {
      const g = Number.isFinite(next.experiment.gain) ? Number(next.experiment.gain).toFixed(3) : "?"
      hypoHint += `\nNext experiment (${next.experiment.id}, gain=${g}, kind=${next.experiment.kind}): ${next.experiment.instruction}`
      if (next.experiment.avoided?.length) {
        hypoHint += `\nAvoided (already uninformative): ${next.experiment.avoided.slice(0, 6).join(", ")}`
      }
      emit({
        type: "EXPERIMENT_SELECTED", taskId, runId: taskRunId, segmentId, nodeId,
        id: next.experiment.id, kind: next.experiment.kind, gain: next.experiment.gain,
        reason: next.experiment.reason,
      })
    }
    const rejected = omega.hypotheses.snapshot().filter((h) => h.status === "REJECTED")
    if (rejected.length) {
      hypoHint += `\nRejected causes (do not retry): ${rejected.map((h) => h.description).slice(0, 4).join("; ")}`
      if (episodeSink) for (const h of rejected.slice(0, 4)) episodeSink.addFailedApproach(`rejected cause: ${String(h.description ?? "").slice(0, 200)}`)
    }
  }
  let steerHint = ""
  try {
    const composed = composeOnce(state.objective, {
      cwd: process.cwd(), config, includeMemory: false, includeSkills: true,
    })
    const block = formatSteer({
      skills: composed.skills,
      plugins: composed.plugins,
      avoid: composed.avoid,
      know: composed.know,
      tools: composed.tools,
      playbooks: composed.playbooks,
      mcp: composed.mcp,
      gaps: composed.gaps,
      blast: composed.blast,
      claims: composed.claims,
      decisions: composed.decisions,
      strategy: composed.strategy,
      models: composed.models,
      variants: composed.variants,
      knowtype: composed.knowtype,
    })
    if (block) {
      steerHint = `\n\n${block}`
      emit({
        type: "REPAIR_STEER",
        taskId, runId: taskRunId, segmentId, nodeId,
        skills: (composed.skills || []).map((s) => s.name).slice(0, 3),
        plugins: (composed.plugins || []).filter((p) => p && p.isolated && p.name).map((p) => p.name).slice(0, 4),
        playbook: String((composed.plugins || []).find((p) => p && p.isolated && p.repair)?.repair || "").slice(0, 160),
        avoid: (composed.avoid || []).slice(0, 4),
      })
    }
  } catch { steerHint = "" }
  // v99 loopwise FIXER — the defect report: the repair prompt used to get a
  // bare error string and had to RE-DISCOVER what the kernel already knew
  // (LSP diagnostics, failing ledger evidence, the verifier's own defect
  // text). Assemble the structured DEFECT REPORT the fixer actually needs.
  let defectBlock = ""
  {
    const lines = []
    if (changedFiles.length) {
      try {
        const diags = await collectDiagnosticsForFiles(config, changedFiles.slice(0, 20), { cwd: process.cwd(), allowAutostart: true, budgetMs: 8000 })
        const bad = diags.filter((d) => d.passed === false).slice(0, 12)
        if (bad.length) {
          lines.push("LIVE LSP DIAGNOSTICS on the changed files (file:line — message):")
          for (const d of bad) lines.push(`  ${path.relative(process.cwd(), d.file)} — ${String(d.text ?? "").split("\n")[0].slice(0, 160)}`)
        }
      } catch { /* diagnostics are best-effort context */ }
    }
    try {
      const fails = (ledger.records() ?? []).filter((r) => Number(r.exit_code ?? r.exitCode ?? 0) !== 0 && r.command).slice(-5)
      if (fails.length) {
        lines.push("FAILING VERIFICATION RECORDS (most recent last):")
        for (const f of fails) lines.push(`  ${String(f.command).slice(0, 140)} → exit ${f.exit_code ?? f.exitCode}${f.evidence ? ` — ${String(f.evidence).split("\n")[0].slice(0, 100)}` : ""}`)
      }
    } catch { /* ledger read is best-effort */ }
    if (verifierReport?.text) {
      lines.push(`READ-ONLY VERIFIER REPORT (defects observed, not fixed):\n  ${String(verifierReport.text).replace(/\n/g, "\n  ").slice(0, 1200)}`)
    }
    if (lines.length) defectBlock = `\n\n--- DEFECT REPORT (observed evidence — trust this over assumptions) ---\n${lines.join("\n")}`
  }
  // v99 loopwise FIXER — deterministic fast path: a lint/format-shaped
  // failure gets the project's OWN formatter once, before any LLM tokens are
  // spent. Evidence is recorded exactly like an agent-run check; on success
  // the repair is done and the LLM pass is skipped entirely.
  {
    const changedRel = changedFiles.map((f) => path.relative(process.cwd(), f)).filter(Boolean)
    const fix = tryNativeAutoFix({ cwd: process.cwd(), config, failureText: `${failText}\n${defectBlock}`, changedFiles: changedRel })
    if (fix.tried && fix.applied) {
      try {
        const rec = ledger.recordCommand(`autofix: ${fix.command}`, fix.tail || "formatter completed cleanly", {
          exitCode: fix.exitCode, affectedFiles: changedRel, taskId, nodeId, segmentId,
          verificationEpoch: state.verification_epoch ?? 0, scope: "repair",
        })
        ts.noteVerification(rec)
        ts.noteTest({ command: rec.command, exit_code: rec.exit_code ?? rec.exitCode, passed: rec.passed })
        emit({ type: "VERIFICATION_PASSED", taskId, runId: taskRunId, segmentId, nodeId, vtype: rec.type, command: rec.command, exitCode: 0, evidence: rec.evidence, verificationId: rec.verification_id, autofix: true })
      } catch { /* evidence is best-effort */ }
      emit({ type: "REPAIR_COMPLETED", taskId, runId: taskRunId, segment, segmentId, nodeId, ok: true, attemptHint: "native autofix", autofix: fix.command })
      emit({ type: "STRATEGY_CHANGED", taskId, runId: taskRunId, segment, segmentId, nodeId, reason: `deterministic autofix applied: ${fix.command}`, ok: true })
      try {
        recordLesson({
          failure: String(error ?? verification?.reason ?? "").slice(0, 200),
          cause: `lint/format-class failure — project formatter fixed it deterministically`,
          failedStrategy: "LLM repair for a mechanical failure",
          successfulRepair: fix.command,
          applicableContext: state.objective, task: state.objective, confidence: 0.8,
          symptoms: failText.slice(0, 400), rootCause: "formatting/lint violation", solution: fix.command,
          files: changedRel.slice(0, 12), symbols: [], model: provider?.model ?? null,
          strategy: "autofix: deterministic formatter before LLM repair",
        }, process.cwd())
      } catch { /* lessons are best-effort */ }
      return true
    }
    if (fix.tried) emit({ type: "STRATEGY_CHANGED", taskId, runId: taskRunId, segment, segmentId, nodeId, reason: `native autofix tried but exited ${fix.exitCode} — falling through to LLM repair`, ok: false })
  }
  const diag = `A previous step FAILED and needs repair. Diagnose the root cause, then fix it, then VERIFY (run the relevant focused test/build). Do NOT repeat the identical failing call — change strategy.\n\nFailure: ${failText.slice(0, 600)}${verification?.missing?.length ? `\nRequired evidence still missing: ${verification.missing.join(", ")}` : ""}${hypoHint}${steerHint}${defectBlock}\n\nIf TRY FIRST is present, apply that known repair to the named files, then verify. Otherwise inspect the relevant files first, then make a minimal surgical fix, then run verification.`
  const repairContext = `--- relevant project context (demand-loaded) ---\n${typeof ctxBlock === "string" ? ctxBlock : ctxBlock?.text ?? ""}`
  try {
    const r = await agent({ config, provider, signal, task: diag, taskId, runId: taskRunId, segmentId, nodeId, extraContext: repairContext, maxStepsOverride: 8, deep: true, onEvent: emit, journal: true, runIdOverride: taskRunId, suppressRunEvents: true, keepJournalRunning: true })
    const fixed = !r.error && !r.budgetHit
    // v96 unifywise: the EXPERIMENT + FIX stages of the episode — what was
    // tried and what actually worked, recorded durably for "never repeat what
    // failed" retrieval in future similar problems.
    if (episodeSink) {
      if (next?.experiment) {
        episodeSink.addExperiment({ command: `${next.experiment.id}: ${String(next.experiment.instruction ?? "").slice(0, 200)}`, result: fixed ? "pass" : "fail", ok: fixed })
      }
      if (fixed) episodeSink.addFix(String(r.text ?? "").slice(0, 300))
      if (!fixed) episodeSink.addFailedApproach(`repair did not fix: ${String(error ?? verification?.reason ?? "").slice(0, 160)}`)
    }
    if (omega && observed?.hypothesis) {
      omega.hypotheses.recordTest(observed.hypothesis.id, { name: "repair-pass", result: fixed ? "pass" : "fail" })
      if (omega.noteExperiment && next?.experiment?.id) omega.noteExperiment(next.experiment.id, fixed ? "pass" : "fail")
      // v94 deepwise: experiment outcomes move LIVE risk — the reality→risk
      // loop closes for the experiment path too (a failed repair is evidence).
      try { liveRisk?.experiment(fixed) } catch { }
      if (fixed) omega.confirmRootCause(observed.hypothesis.id)
      else if (omega.hypotheses.looping(observed.hypothesis.id, "repair-pass")) {
        omega.rejectCause(observed.hypothesis.id, "same repair already failed twice")
      }
    }
    recordLesson({
      failure: String(error ?? verification?.reason ?? "").slice(0, 200),
      cause: String(r.text ?? "").slice(0, 200),
      failedStrategy: "repeat identical failing call",
      successfulRepair: fixed ? String(r.text ?? "").slice(0, 240) : "",
      applicableContext: state.objective,
      task: state.objective,
      confidence: fixed ? 0.7 : 0.4,
      // P1 structured schema (see above)
      symptoms: String(error ?? verification?.reason ?? "").slice(0, 400),
      rootCause: String(r.text ?? "").slice(0, 400),
      solution: fixed ? String(r.text ?? "").slice(0, 400) : "",
      files: [...(state.files_changed ?? [])].map((f) => path.relative(process.cwd(), f)).slice(0, 12),
      symbols: (verification?.missing ?? []).slice(0, 12),
      model: provider?.model ?? null,
      strategy: "repair: diagnose root cause, minimal fix, verify",
    }, process.cwd())
    const changedForScope = (state.files_changed ?? []).map((f) => path.relative(process.cwd(), f))
    for (const chk of r.commandChecks ?? []) {
      const rec = ledger.recordCommand(chk.command, chk.tail, {
        exitCode: chk.exitCode, affectedFiles: changedForScope, taskId, nodeId, segmentId, verificationEpoch: state.verification_epoch ?? 0,
        cwd: chk.cwd, env: chk.env, repoState: chk.repoState, stdoutTail: chk.stdoutTail, timestamp: chk.at,
        filesWrittenAfter: (chk.filesWrittenAfter ?? []).map((f) => f === "(shell write)" ? f : path.relative(process.cwd(), f)),
      })
      if (episodeSink) episodeSink.addVerification({ command: String(chk.command ?? "").slice(0, 200), ok: chk.passed === true }) // v96: the episode's VERIFICATION stage
      if (rec.invalidated) emit({ type: "VERIFICATION_INVALIDATED", taskId, runId: taskRunId, segmentId, nodeId, count: 1, reason: rec.staleReason, command: rec.command, verificationId: rec.verification_id })
      ts.noteVerification(rec)
      ts.noteTest({ command: rec.command, exit_code: rec.exit_code ?? rec.exitCode, passed: rec.passed })
      emit({ type: chk.passed ? "VERIFICATION_PASSED" : "VERIFICATION_FAILED", taskId, runId: taskRunId, segmentId, nodeId, vtype: rec.type, command: rec.command, exitCode: rec.exitCode ?? rec.exit_code, evidence: rec.evidence, verificationId: rec.verification_id })
    }
    // v96 unifywise: REPAIR_COMPLETED is a real event (the Core records the
    // REPAIR lifecycle phase from it; the previously dead vocabulary is gone).
    emit({ type: "REPAIR_COMPLETED", taskId, runId: taskRunId, segment, segmentId, nodeId, ok: fixed, attemptHint: fixed ? "fixed" : "not fixed" })
    emit({ type: "STRATEGY_CHANGED", taskId, runId: taskRunId, segment, segmentId, nodeId, reason: "repair pass completed", ok: fixed })
    return fixed
  } catch (e) {
    ts.noteError("REPAIR_FAILED", e?.message ?? String(e))
    return false
  }
}

/**
 * P0 — VERIFY ⇒ READ_ONLY, REPAIR ⇒ WRITE.
 *
 * A verifier must never be able to change the artifact it is verifying: a
 * write-capable "verifier" can make a failing test pass by editing it. The
 * verification agent therefore runs with `readOnly: true`, which (via
 * tools.js isReadOnlyViolation) denies write_file / edit_file / multi_edit /
 * apply_patch / mutating bash / memory / todo / plugin / config mutation, and
 * allows ONLY the approved verification commands (test / build / lint /
 * typecheck / read-only git and shell inspection).
 */
async function requestVerification({ agent, config, provider, signal, emit, state, missing, ts, ledger, ctxEngine, taskRunId, taskId = null, segmentId = null, nodeId = null, risk = "medium", impact = null }) {
  const ctxBuilt = await ctxEngine.buildAsync(state.objective, { budgetTokens: 1200 })
  const verifyContext = `--- relevant project context (demand-loaded) ---\n${typeof ctxBuilt === "string" ? ctxBuilt : ctxBuilt?.text ?? ""}`
  let ask = `The task appears complete, but before success is claimed the following evidence is required for this risk level (${risk}): ${missing.join(", ")}.\n\nRun the appropriate command(s) for THIS project (e.g. a focused test for a single-function change; focused + regression + build for a core change). Use the project's real test command (check package.json / Makefile). If the project has NO test suite or build, say so plainly instead of fabricating a result. Report the exact command(s) and their outcomes.\n\nYou are the VERIFIER: you may read, search, inspect and run approved test/build/lint/static-analysis commands, but you may NOT modify the project. If you find a defect, report it — do not fix it.`
  if (impact?.scope?.length) ask += `\n\nImpact-based verification ladder: ${impact.scope.join(" → ")}.`
  if (impact?.tests?.length) ask += `\nTests that import the changed files: ${impact.tests.slice(0, 8).join(", ")}.`
  try {
    emit({ type: "VERIFIER_STARTED", taskId, runId: taskRunId, segmentId, nodeId, mode: "READ_ONLY", missing, risk })
    const r = await agent({ config, provider, signal, task: ask, taskId, runId: taskRunId, segmentId, nodeId, extraContext: verifyContext, maxStepsOverride: 6, deep: false, onEvent: emit, journal: true, readOnly: true, verifier: true, runIdOverride: taskRunId, suppressRunEvents: true, keepJournalRunning: true })
    emit({ type: "VERIFIER_FINISHED", taskId, runId: taskRunId, segmentId, nodeId, mode: "READ_ONLY", checks: (r.commandChecks ?? []).length })
    for (const chk of r.commandChecks ?? []) {
      const rec = ledger.recordCommand(
        chk.command,
        chk.tail + (chk.exitCode === 0 || chk.exitCode == null ? "" : ` [exit code: ${chk.exitCode}]`),
        {
          exitCode: chk.exitCode,
          taskId, nodeId, segmentId,
          affectedFiles: (state.files_changed ?? []).map((f) => path.relative(process.cwd(), f)),
          verificationEpoch: state.verification_epoch ?? 0,
          scope: "verification",
        },
      )
      ts.noteVerification(rec)
      ts.noteTest({ command: rec.command, exit_code: rec.exit_code ?? rec.exitCode, passed: rec.passed })
      emit({ type: chk.passed ? "VERIFICATION_PASSED" : "VERIFICATION_FAILED", taskId, runId: taskRunId, segmentId, nodeId, vtype: rec.type, command: rec.command, exitCode: rec.exit_code ?? rec.exitCode, evidence: rec.evidence, verificationId: rec.verification_id, verifier: "READ_ONLY" })
    }
    const changedRel = (state.files_changed ?? []).map((f) => path.relative(process.cwd(), f))
    // judged against the FINAL risk, not the planning risk
    // v99 loopwise: the verifier's own defect REPORT travels with the
    // verdict — the fixer no longer has to re-discover what was already
    // observed. Callers treat this as truthy/falsy exactly as before.
    const st = ledger.status(risk, changedRel, { nodeId })
    return { ok: st.ok && !st.anyFailure, report: { at: Date.now(), missing, text: String(r?.text ?? "").slice(0, 2400) } }
  } catch (e) {
    ts.noteError("VERIFY_FAILED", e?.message ?? String(e))
    return { ok: false, report: null }
  }
}

/**
 * Diagnostic fallback only (P0): attributeSegment remains only as diagnostic fallback.
 * Primary is explicit executeNode(nodeId) / markCompleted(nodeId).
 */
function attributeSegment(dag, { files = 0, toolCalls = 0, text = "" } = {}) {
  const active = [...dag.nodes.values()].filter((n) => n.status === "running" || n.status === "ready")
  if (!active.length) return null
  const hay = String(text).toLowerCase()
  let best = null
  let bestScore = 0
  for (const n of active) {
    let score = n.status === "running" ? 5 : 0
    const words = String(n.objective ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3)
    for (const w of words) if (hay.includes(w)) score++
    if (files > 0 && !n.read_only) score += 2
    if (toolCalls > 0) score += 0.5
    if (score > bestScore) { bestScore = score; best = n }
  }
  return bestScore >= (best?.status === "running" ? 5 : 3) ? best : null
}

function buildContinuation({ state, segment, planText, riskNow, knownBad }) {
  const parts = [
    `Continue the autonomous task (segment ${segment}). Work toward the objective; do not restart from scratch.`,
    `Objective: ${state.objective}`,
  ]
  if (planText) parts.push(`Plan:\n${String(planText).slice(0, 1200)}`)
  if (state.files_changed?.length) parts.push(`Files already changed: ${state.files_changed.slice(-10).map((f) => path.relative(process.cwd(), f)).join(", ")}`)
  if (knownBad?.length) parts.push(`Avoid approaches that already failed here: ${knownBad.slice(0, 2).map((l) => l.failed_strategy || l.failed_action).join("; ")}`)
  parts.push(`After your edits, VERIFY with the appropriate command (focused test for a single-function change; focused + regression + build for a core change). Then either continue to the next remaining step or give a concise final summary if the objective is fully met and verified.`)
  void riskNow
  return parts.join("\n\n")
}

export { reconcileEffect, UNKNOWN_DECISION, TASK_STATUS, TERMINAL }
