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
import { canCompleteTask, CHECK as GATE_CHECK } from "./completion.js"
import { createResourceManager, ADAPT, fanoutWaitMs, scaleWorkers } from "./resources.js"
import { selectModel, reconsiderModel, recordOutcome } from "./modelstrategy.js"
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
import { mergeLearnedSkills, evolveRun, hardAvoid, formatEvolve } from "./evolve.js"
import { resolveEmbeddingsConfig, createEmbedder } from "./embeddings.js"
import { recordLesson, ineffectiveStrategies, ineffectiveStrategiesAsync, lessonsForPlan } from "./lessons.js"
import { reconcileEffect, reconcileTask, resumePrompt, UNKNOWN_DECISION } from "./recovery.js"
import { snapshotBefore, boundaryCheckpoint } from "./checkpoint.js"
import { collectDiagnosticsForFiles } from "./lsp.js"
import { redact } from "./secrets.js"
import { classifyTask, synthesizePlan, TASK_CLASS } from "./classify.js"
import { AGENT_BUDGETS } from "./config.js"
import { createKernel } from "./omega.js"
import { shouldReplan, replanPrompt, planLessonsPrefix } from "./replan.js"
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

export async function runMeta({ config, provider, task, onEvent = null, signal = null, resumeTaskId = null, segmentSteps, maxSegments, runAgent = null, deep, workers = null, pluginStartedAt = null } = {}) {
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
  const taskRunId = state.run_id || "run-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6)
  state.run_id = taskRunId
  const ledger = createLedger()
  if (Array.isArray(state.verification_results)) ledger.load(state.verification_results)
  const resources = createResourceManager({ config, cwd: process.cwd() })
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
  const provRef = { prov: provider }

  const pluginStartedAtMs = pluginStartedAt ?? Date.now()
  const rawAgent = runAgent ?? (await import("./agent.js")).runAgent
  const agent = (opts) => rawAgent({ ...opts, pluginStartedAt: opts.pluginStartedAt ?? pluginStartedAtMs })
  const workersEnabled = workers ?? (!runAgent && config?.agent?.workers !== false)

  manager.configure({
    config, provider,
    runner: ({ role, task: subTask, context, readOnly, signal: sig, dagNode }) =>
      agent({
        config, provider: provRef.prov, task: subTask,
        taskId, runId: taskRunId, segmentId: `worker-${dagNode ?? role}`, nodeId: dagNode ?? null,
        extraContext: context ? `--- relevant project context (demand-loaded) ---\n${context}` : undefined,
        onEvent: segmentEvents(emit, `worker:${dagNode ?? role}`), signal: sig ?? signal,
        readOnly: readOnly !== false, maxStepsOverride: 10, worker: { role, dagNode },
        budgetHit: false,
        journal: false, suppressRunEvents: true,
      }).then((r) => r.text),
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

  const segSteps = segmentSteps ?? config?.agent?.segmentSteps ?? SEGMENT_STEPS
  let maxSeg = maxSegments ?? config?.agent?.maxSegments ?? MAX_SEGMENTS_DEFAULT
  // P0 segment safety fuse: a continuation is a RESUME, not a failure. The
  // continuation budget bounds it so "resume later" cannot loop forever.
  const maxContinuations = config?.agent?.maxContinuations ?? AGENT_BUDGETS.maxContinuations
  // how many times this task has already been resumed after a safety fuse
  let continuationCount = Number(resumeRec?.continuation_count ?? 0) || 0

  const sel = selectModel(config, { task: state.objective, provider })
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
  let planValidation = null
  let planRepaired = false
  // RESUME: the task already has a validated DAG on disk. Re-planning would
  // throw away the graph the interrupted run was executing (and pay for a
  // model call that can contradict it), so we restore instead.
  const restoredDAG = Boolean(resumeRec && state.dag)
  try {
    if (restoredDAG) {
      planDefs = []
      planValidation = { ok: true, errors: [], stage: "RESTORED", code: "RESTORED", recoverable: true }
      emit({ type: "PLAN_RESTORED", taskId, runId: taskRunId, nodes: state.dag?.nodes?.length ?? 0, reason: "resuming an interrupted task — the recorded DAG is authoritative" })
      ts.setPlan((state.plan ?? []).map((p) => (typeof p === "string" ? p : p?.objective ?? p?.title ?? p?.id)), "resumed")
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
          })
        }
        try { persistGaps(process.cwd(), composed.gaps, { task: state.objective }) } catch { /* persist is best-effort */ }
      } catch { composePrefix = "" }
    }
    const planRes = restoredDAG || fastPath || recoveryPath ? null : await agent({
      config, provider: prov, signal,
      task: `${state.objective}\n\n${lessonPrefix ? `${lessonPrefix}\n\n` : ""}${langPrefix ? `${langPrefix}\n\n` : ""}${enginePrefix ? `${enginePrefix}\n\n` : ""}${composePrefix ? `${composePrefix}\n\n` : ""}Produce a concise dependency-aware plan as a numbered list (one action per line). Mark read-only investigation steps and implementation steps. 4-8 steps. Do NOT execute.`,
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
        task: state,
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
      task: state,
    }
  }

  let dag = null
  const persistDAG = () => { if (dag) ts.setDAG(dagLib.serializeDAG(dag)) }
  try {
    if (planDefs.length) {
      dag = (resumeRec && state.dag && dagLib.deserializeDAG(state.dag)) || dagLib.buildDAG(planDefs)
      persistDAG()
      emit({ type: "DAG_BUILT", taskId, runId: taskRunId, nodes: dag.order.length, graph: dagLib.serializeDAG(dag) })
    } else if (state.dag) {
      dag = dagLib.deserializeDAG(state.dag)
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
        status: FINAL.WAITING,
        text: `DAG build failed: ${e?.message}`,
        segments: 0,
        repairs: 0,
        toolCalls: 0,
        filesChanged: [],
        verification: { ok: false, missing: [], reason: "DAG invalid" },
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
  let repairCount = 0
  let replanCount = 0
  let evidenceRequests = 0
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
    // 1. never complete while a worker is alive
    await settleWorkers()
    const fr = recomputeFinalRisk()
    const changedRel = [...changedFiles].map((f) => path.relative(process.cwd(), f))
    const vv = ledger.status(fr.risk, changedRel)
    if (classified.strategy.requireReview) {
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
    })
    if (!gate.ok) return { done: false, gate }
    finalStatus = explicitFinalization(FINAL.COMPLETED)
    finalState = TASK_STATUS.COMPLETED
    finalText = text ?? "task completed"
    clearRequiredActions()
    ts.setNextAction(null)
    ts.transition(TASK_STATUS.COMPLETED, { reason: "completion gate satisfied", durability: DURABILITY.CRITICAL })
    emit({ type: "TASK_COMPLETED", taskId, runId: taskRunId, segment, segmentId, nodeId, text: String(finalText).slice(0, 400), verification: vv.status, finalRisk: fr.risk, gate: gate.checks })
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
        finalRisk: finalRiskLevel,
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
  const tryMidTaskReplan = async ({ reason, evidence }) => {
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
    })) return { ok: false }
    if (!dag) return { ok: false }
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

  while (segment < maxSeg) {
    if (signal?.aborted) { finalStatus = explicitFinalization(FINAL.CANCELLED); break }

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
    emit({ type: "SEGMENT_STARTED", taskId, runId: taskRunId, segment, segmentId, nodeId: currentNodeId, objective: state.objective, maxSteps: segSteps })
    resources.record({ segment: true })

    const adaptation = resources.evaluate()
    manager.setMaxWorkers(adaptation.limits.maxWorkers)
    if (adaptation.actions.length) emit({ type: "RESOURCE_ADAPTED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, level: adaptation.level, actions: adaptation.actions.map((a) => a.action), summary: resources.summary() })

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
      if (cpId) ts.noteCheckpoint(cpId)
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
          const jobs = batch.map((n) => {
            dagLib.markRunning(dag, n.id)
            if (isIntegratorRole(n.role)) {
              const merged = integrateResults({ objective: state.objective, reports: reportsFromGraph(dag) })
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
          return job.promise.then((r) => {
            if (r.status === "completed" && String(r.result ?? "").trim()) {
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
              dagFindings += `\n\n--- finding from ${n.role} (${n.id}) ---\n${String(r.result ?? "").slice(0, 1200)}`
            } else if (r.status === "completed") {
              // worker settled but produced nothing: unverifiable, not complete
              dagLib.markFailed(dag, n.id, "worker produced no findings — cannot verify the node outcome")
            } else {
              dagLib.markFailed(dag, n.id, r.error ?? r.status)
            }
            persistDAG()
          }).catch((e) => { try { dagLib.markFailed(dag, n.id, String(e?.message ?? e)); persistDAG() } catch {} })
          })
          // Bounded wait: the deadline must be cleared (and unref'd) or it keeps
          // a timer alive long after the workers have settled.
          let fanoutTimer = null
          const waitMs = fanoutWaitMs(resources.state.tier, resources.state)
          const fanoutDeadline = new Promise((resolve) => {
            fanoutTimer = setTimeout(resolve, waitMs)
            if (fanoutTimer && typeof fanoutTimer.unref === "function") fanoutTimer.unref()
          })
          await Promise.race([Promise.allSettled(jobs), fanoutDeadline])
          clearTimeout(fanoutTimer)
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

    let res
    try {
      res = await agent({
        config, provider: prov, signal,
        task: segTask,
        taskId,
        runId: taskRunId,
        segmentId,
        nodeId: currentNodeId,
        extraContext: [dagFindings ? `DAG worker findings:\n${dagFindings}` : "", contextBlock ? `--- relevant project context (demand-loaded) ---\n${contextBlock}` : ""].filter(Boolean).join("\n\n") || undefined,
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

    const recs = res.toolRecords ?? []
    const segChanged = new Set()
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
      // affected symbols feed the risk escalation rules (auth/crypto/exec …)
      try {
        const syms = detectAffectedSymbols([...changedFiles], process.cwd())
        for (const s of syms) if (!affectedSymbols.includes(s)) affectedSymbols.push(s)
      } catch { }
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
    // failed `node --check` does. Off when lsp.servers is empty; a missing
    // server is skipped, not a gate failure.
    if (segChanged.size && config?.tools?.lsp !== false && Object.keys(config?.lsp?.servers || {}).length) {
      try {
        const diags = await collectDiagnosticsForFiles(config, [...segChanged], { cwd: process.cwd() })
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
    }

    const u = res.usage ?? {}
    const tokIn = u.prompt ?? u.prompt_tokens ?? u.input_tokens ?? u.promptTokens ?? 0
    const tokOut = u.completion ?? u.completion_tokens ?? u.output_tokens ?? u.completionTokens ?? 0
    resources.record({ tokensIn: tokIn, tokensOut: tokOut, toolCalls: segToolCalls, latencyMs: segMs, workers: manager.stats().active })
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

    if (res.error) {
      consecutiveFailures++
      ts.transition(TASK_STATUS.REPAIRING, { reason: "segment errored" })
      ts.noteError("SEGMENT_FAILED", res.error)
      emit({ type: "REPAIR_STARTED", taskId, runId: taskRunId, segment, segmentId, nodeId: currentNodeId, attempt: consecutiveFailures, error: redact(String(res.error)).slice(0, 200) })
      const recovered = await repairSegment({ agent, config, provider: prov, signal, emit, state, error: res.error, segment, ts, ledger, ctxEngine, taskRunId, taskId, segmentId, nodeId: currentNodeId, omega, changedFiles: [...changedFiles] })
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

    // VERIFICATION FAILED → REPAIRING (hard gate). The node goes back to
    // REPAIRING too: execution succeeded, the OUTCOME did not.
    if (v.anyFailure) {
      if (dag && currentNodeId) { try { dagLib.markRepairing(dag, currentNodeId, v.reason); persistDAG() } catch { } }
      ts.transition(TASK_STATUS.REPAIRING, { reason: "verification failed" })
      emit({ type: "REPAIR_STARTED", taskId, runId: taskRunId, segment, segmentId, nodeId: currentNodeId, attempt: repairCount + 1, error: v.reason })
      const recovered = await repairSegment({ agent, config, provider: prov, signal, emit, state, error: v.reason, segment, ts, ledger, ctxEngine, verification: v, taskRunId, taskId, segmentId, nodeId: currentNodeId, finalRisk: finalRiskLevel, omega, changedFiles: [...changedFiles] })
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
    if (!finished) {
      evidenceRequests = 0
      ts.setNextAction("continue: segment budget spent, work remains")
      ts.transition(TASK_STATUS.EXECUTING, { reason: "continuing to next segment" })
      continue
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
      await requestVerification({ agent, config, provider: prov, signal, emit, state, missing: v.missing, ts, ledger, ctxEngine, taskRunId, taskId, segmentId, nodeId: currentNodeId, risk: finalRiskLevel, impact })
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
      if (cpId) ts.noteCheckpoint(cpId)
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

async function repairSegment({ agent, config, provider, signal, emit, state, error, segment, ts, ledger, ctxEngine, verification = null, taskRunId = null, taskId = null, segmentId = null, nodeId = null, omega = null, changedFiles = [] }) {
  ts.transition(TASK_STATUS.REPAIRING, { reason: "diagnosing failure" })
  const ctxBlock = await ctxEngine.buildAsync(state.objective, { budgetTokens: 1600 })
  const failText = String(error ?? verification?.reason ?? "")
  let hypoHint = ""
  let observed = null
  let next = null
  if (omega) {
    observed = omega.observeCommand(failText, { tool: "segment", files: changedFiles })
    next = omega.nextRepair()
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
  const diag = `A previous step FAILED and needs repair. Diagnose the root cause, then fix it, then VERIFY (run the relevant focused test/build). Do NOT repeat the identical failing call — change strategy.\n\nFailure: ${failText.slice(0, 600)}${verification?.missing?.length ? `\nRequired evidence still missing: ${verification.missing.join(", ")}` : ""}${hypoHint}${steerHint}\n\nIf TRY FIRST is present, apply that known repair to the named files, then verify. Otherwise inspect the relevant files first, then make a minimal surgical fix, then run verification.`
  const repairContext = `--- relevant project context (demand-loaded) ---\n${typeof ctxBlock === "string" ? ctxBlock : ctxBlock?.text ?? ""}`
  try {
    const r = await agent({ config, provider, signal, task: diag, taskId, runId: taskRunId, segmentId, nodeId, extraContext: repairContext, maxStepsOverride: 8, deep: true, onEvent: emit, journal: true, runIdOverride: taskRunId, suppressRunEvents: true, keepJournalRunning: true })
    const fixed = !r.error && !r.budgetHit
    if (omega && observed?.hypothesis) {
      omega.hypotheses.recordTest(observed.hypothesis.id, { name: "repair-pass", result: fixed ? "pass" : "fail" })
      if (omega.noteExperiment && next?.experiment?.id) omega.noteExperiment(next.experiment.id, fixed ? "pass" : "fail")
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
      if (rec.invalidated) emit({ type: "VERIFICATION_INVALIDATED", taskId, runId: taskRunId, segmentId, nodeId, count: 1, reason: rec.staleReason, command: rec.command, verificationId: rec.verification_id })
      ts.noteVerification(rec)
      ts.noteTest({ command: rec.command, exit_code: rec.exit_code ?? rec.exitCode, passed: rec.passed })
      emit({ type: chk.passed ? "VERIFICATION_PASSED" : "VERIFICATION_FAILED", taskId, runId: taskRunId, segmentId, nodeId, vtype: rec.type, command: rec.command, exitCode: rec.exitCode ?? rec.exit_code, evidence: rec.evidence, verificationId: rec.verification_id })
    }
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
    const st = ledger.status(risk, changedRel, { nodeId })
    return st.ok && !st.anyFailure
  } catch (e) {
    ts.noteError("VERIFY_FAILED", e?.message ?? String(e))
    return false
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
