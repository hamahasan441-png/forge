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
// v91 ULTIMATE: objective engine + orchestration + final report. The objective
// engine never decides completion (the 9-check gate below still does) — it
// records phases, checkpoints, loop detection and honest progress, and it is
// what `forge report` reads back.
import { createObjective, saveObjective, advance as objAdvancePhase, recordAction as objRecord, recordPivot, recordBlocker, verdict as objVerdict, progressOf as objProgress, PHASE, OBJ_STATUS, noteContext } from "./objective.js"
import { rosterFor, advisories as crewAdvisories, formatAdvisories, approvalRequired as crewApproval, singleWriterOk } from "./orchestra.js"
// v92 PROCREW: the crew as an executable scheduler, and the verification
// pipeline that every task runs. Both are additive — `agent.crew:false` and
// `agent.pipeline:false` restore the v91 behaviour exactly.
import { workUnits, dedupeUnits, runCrew, formatCrew, CREW_LIMITS } from "./crew.js"
import { recordVerdict, verdictBlock, VERDICT } from "./memory.js"
import { planPipeline, runPipeline, pipelineVerdict, formatPipeline, diagnose as pipelineDiagnose, PIPELINE_DEFAULTS } from "./pipeline.js"
import { buildReport, saveReport } from "./report.js"
import { docPlan as docsDocPlan, docsBrief } from "./docsintel.js"
// v93 DOCSMITH: the Documentation Writer. The brief is deterministic; the
// writing is done by the roster's single writer, never by a second writer.
import { listSourceFiles } from "./selfup.js"
import * as dagLib from "./dag.js"
import fs from "node:fs"
import path from "node:path"

const SEGMENT_STEPS = AGENT_BUDGETS.segmentSteps
const MAX_SEGMENTS_DEFAULT = AGENT_BUDGETS.maxSegments

export const FINAL = { COMPLETED: "COMPLETED", FAILED: "FAILED", CANCELLED: "CANCELLED", WAITING: "WAITING" }

/** A read-only drafting pass costs a model call, so it is reserved for the
 *  classes where the documentation delta is usually more than a changelog line. */
export const DOCS_DRAFT_CLASSES = new Set(["LARGE", "ARCHITECTURAL"])

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

  // --- v91 ULTIMATE: objective engine + orchestration crew -------------------
  // Both are additive. `agent.objective:false` / `agent.orchestration:false`
  // restore the exact v90 path (obj === null makes every hook a no-op).
  const obj = config?.agent?.objective !== false
    ? createObjective({
      objective: state.objective, cwd: process.cwd(), klass: classified.class,
      approvalRequired: crewApproval(classified.class), taskId, runId: taskRunId,
    })
    : null
  const crew = config?.agent?.orchestration !== false ? rosterFor(classified.class) : []

  // --- v92 PROCREW: crew execution stats (reported, never invented) ---------
  const crewStats = { units: 0, findings: 0, modelCalls: 0, reassigned: 0, skipped: 0, duplicates: 0, failed: 0, deadlineHit: 0 }
  // --- v92 PROCREW: verification pipeline state -----------------------------
  // `pipelineRuns` bounds re-runs after repairs; a repair invalidates the last
  // result, so the NEXT verification pass runs the pipeline again on the fixed
  // code instead of trusting evidence that predates the fix.
  // NB: plan-only runs never reach runMeta (they call runAgent directly), so
  // there is no planOnly flag to check here — and referencing one would be a
  // ReferenceError, not a no-op.
  const pipelineEnabled = config?.agent?.pipeline !== false
  let pipelineRuns = 0
  let pipelineStale = true
  let pipelineResult = null
  // --- v93 DOCSMITH: documentation agent state ------------------------------
  const docsAgentEnabled = config?.agent?.docsAgent !== false
  let docsResult = null

  /**
   * Run a batch of read-only DAG nodes as the named crew.
   *
   * This REPLACED the inline per-node spawn loop: there is one scheduler for
   * sub-agent work, so duplicate work, conflicting edits, self-review, rejected
   * approaches and failure reassignment are enforced in one place. What did not
   * change: the runner is still agentmanager.spawn → runAgent, evidence still
   * lands in the same ledger, nodes still complete only WITH evidence, and the
   * fan-out is still bounded by the same deadline.
   *
   * @returns {Promise<string>} the findings text for the model context
   */
  const runCrewBatch = async (batch, { segmentId = null, contextBlock = "", parallelN = 4 } = {}) => {
    if (!Array.isArray(batch) || !batch.length) return ""
    // `agent.crew:false` turns the fan-out OFF — not "back to the old loop":
    // there is exactly one scheduler. The DAG's read-only nodes are then picked
    // up one at a time by the main agent (the existing no-mutating-node-ready
    // path), so nothing is orphaned and no logic is duplicated.
    if (config?.agent?.crew === false) {
      emit({ type: "CREW_DISABLED", taskId, runId: taskRunId, segmentId, nodes: batch.map((n) => n.id) })
      return ""
    }
    let findings = ""
    const byId = new Map(batch.map((n) => [n.id, n]))
    const built = workUnits({ objective: state.objective, steps: batch, crew, context: contextBlock })
    const { units, duplicates } = dedupeUnits(built)

    // A duplicate work unit is covered by its twin. That fact IS the evidence,
    // so the node completes with it instead of paying for a second model call.
    for (const d of duplicates) {
      // `d.id` is the UNIT id ("u3"); the DAG is keyed by node id, which the unit
      // carries as stepId. Looking the node up by the unit id silently matched
      // nothing, so duplicate nodes were never completed.
      const node = byId.get(d.stepId ?? d.id)
      if (!node) continue
      crewStats.duplicates += 1
      const rec = ledger.add({
        verification_id: `ver-worker-${node.id}-dup`, taskId, nodeId: node.id, segmentId,
        verificationEpoch: state.verification_epoch ?? 0, affectedFiles: [], scope: "node", type: "acceptance",
        passed: true, exitCode: 0, exitCodeKnown: true,
        evidence: `duplicate work unit — covered by ${d.sameAs}`, timestamp: Date.now(),
        command: "worker:deduped", output: `duplicate of ${d.sameAs}`,
      })
      ts.noteVerification(rec)
      dagLib.markCompleted(dag, node.id, `duplicate of ${d.sameAs} — not re-run`, { verification: rec })
      persistDAG()
      emit({ type: "CREW_DUPLICATE_SKIPPED", taskId, runId: taskRunId, segmentId, nodeId: node.id, sameAs: d.sameAs })
    }

    // The integrator merges; it never costs a model call. Same rule as before.
    const spawnable = []
    for (const u of units) {
      const node = byId.get(u.stepId)
      if (node && isIntegratorRole(node.role)) {
        const merged = integrateResults({ objective: state.objective, reports: reportsFromGraph(dag) })
        const rec = ledger.add({
          verification_id: `ver-worker-${node.id}-integrate`, taskId, nodeId: node.id, segmentId,
          verificationEpoch: state.verification_epoch ?? 0,
          affectedFiles: merged.apply.map((a) => a.file).filter(Boolean).slice(0, 32),
          scope: "node", type: "acceptance", passed: true, exitCode: 0, exitCodeKnown: true,
          evidence: merged.text.slice(0, 300), timestamp: Date.now(),
          command: "worker:integrator", output: merged.text.slice(0, 500),
        })
        ts.noteVerification(rec)
        dagLib.markCompleted(dag, node.id, merged.text.slice(0, 2000), { verification: rec })
        findings += `\n\n${merged.text}`
        persistDAG()
        continue
      }
      spawnable.push(u)
    }

    // Memory Agent: what this project already proved, so no sub-agent re-derives
    // an approach the user rejected or ignores one that already worked.
    let verdictHint = ""
    try {
      const vb = verdictBlock(process.cwd(), 3)
      if (vb) verdictHint = `\n\nMemory from previous runs on this project:\n${vb}`
    } catch { verdictHint = "" }

    const settled = runCrew({
      units: spawnable, crew, maxParallel: parallelN, signal,
      emit: (ev) => emit({ taskId, runId: taskRunId, segmentId, ...ev }),
      // Memory Agent: never spend a model call on an approach the user already
      // rejected. A later ACCEPTED verdict for the same shape cancels it.
      isRejected: (u) => {
        let r = { rejected: false }
        try { r = isRejectedApproach(u.task, { cwd: process.cwd() }) } catch { r = { rejected: false } }
        if (r.rejected) emit({ type: "CREW_REJECTED_APPROACH", taskId, runId: taskRunId, segmentId, nodeId: u.stepId, match: r.match })
        return r.rejected
      },
      // The runner is the existing one: same budgets, same tool loop, same
      // single-writer rule (a sub-agent is spawned read-only by role).
      spawn: async (u) => {
        const job = manager.spawn({
          role: u.role, taskId, runId: taskRunId, segmentId, nodeId: u.stepId,
          task: `${u.task}\n\nThis is a read-only investigation subtask of: ${state.objective}. Do NOT modify files. Report concise findings (file paths, symbols, facts) the implementer will need.${verdictHint}`,
          context: u.context, dagNode: u.stepId, timeoutMs: CREW_LIMITS.perUnitTimeoutMs,
          targetFiles: u.targetFiles?.length ? u.targetFiles : null,
          targetSymbols: u.targetSymbols?.length ? u.targetSymbols : null,
          targetDirs: u.targetDirs?.length ? u.targetDirs : null,
          resourceLocks: u.resourceLocks?.length ? u.resourceLocks : null,
        })
        resources.record({ workers: 1 })
        return job.promise
      },
    // Map every settled unit back onto its DAG node. Attached BEFORE the
    // deadline race so a late result still lands, exactly as the old per-node
    // .then() did — the deadline bounds the WAIT, not the bookkeeping.
    }).then((res) => {
      crewStats.units += (res.results || []).length
      crewStats.modelCalls += res.modelCalls || 0
      crewStats.reassigned += res.reassigned || 0
      crewStats.skipped += (res.skipped || []).length
      for (const r of res.results || []) {
        if (!r.stepId) continue
        if (r.ok) {
          crewStats.findings += 1
          const rec = ledger.add({
            verification_id: `ver-worker-${r.stepId}-${r.id}`, taskId, nodeId: r.stepId, segmentId,
            verificationEpoch: state.verification_epoch ?? 0, affectedFiles: [], scope: "node", type: "acceptance",
            passed: true, exitCode: 0, exitCodeKnown: true,
            evidence: String(r.text ?? "").slice(0, 300), timestamp: Date.now(),
            command: `worker:${r.key}`, output: String(r.text ?? "").slice(0, 500),
          })
          ts.noteVerification(rec)
          dagLib.markCompleted(dag, r.stepId, String(r.text ?? "").slice(0, 2000), { verification: rec })
          findings += `\n\n--- finding from ${r.key} (${r.stepId})${r.attempts > 1 ? `, reassigned from ${r.from}` : ""} ---\n${String(r.text ?? "").slice(0, 1200)}`
        } else if (r.skipped) {
          dagLib.markFailed(dag, r.stepId, "approach previously rejected by the user — not attempted")
        } else {
          crewStats.failed += 1
          dagLib.markFailed(dag, r.stepId, r.error ?? "worker produced no findings — cannot verify the node outcome")
        }
        // Memory Agent: an approach tried under two different specialists is a
        // DECISION, not just a failure — the next run must not pay for it again.
        // A success that only landed after reassignment is worth keeping too.
        if (r.attempts > 1) {
          const u = spawnable.find((x) => x.stepId === r.stepId)
          const approach = String(u?.task ?? "").split("\n")[0].slice(0, 200)
          if (approach) {
            try {
              recordVerdict(r.ok ? VERDICT.ACCEPTED : VERDICT.REJECTED, approach, {
                reason: r.ok ? `worked when reassigned to ${r.key}` : `${r.key}: ${String(r.error || "no findings").slice(0, 90)}`,
                cwd: process.cwd(),
                provenance: { source: "subagent", runId: taskRunId, model: provider?.model ?? null },
              })
            } catch { /* memory is best-effort; it never fails a run */ }
          }
        }
        persistDAG()
      }
      const line = formatCrew(res)
      if (obj) objPhase(PHASE.RESEARCH, line.split("\n")[0])
      return findings
    }).catch((e) => {
      ts.noteError("CREW_FAILED", e?.message ?? String(e))
      emit({ type: "CREW_FAILED", taskId, runId: taskRunId, segmentId, error: String(e?.message ?? e).slice(0, 200) })
      return findings
    })

    // Bounded wait: the deadline must be cleared (and unref'd) or it keeps a
    // timer alive long after the workers have settled.
    let fanoutTimer = null
    const waitMs = fanoutWaitMs(resources.state.tier, resources.state)
    const fanoutDeadline = new Promise((resolve) => {
      fanoutTimer = setTimeout(resolve, waitMs)
      if (fanoutTimer && typeof fanoutTimer.unref === "function") fanoutTimer.unref()
    })
    const raced = await Promise.race([settled, fanoutDeadline])
    clearTimeout(fanoutTimer)
    if (raced === undefined) {
      crewStats.deadlineHit += 1
      emit({ type: "CREW_DEADLINE", taskId, runId: taskRunId, segmentId, waitedMs: waitMs })
      return findings
    }
    return raced
  }

  let lastReview = null
  let finalReport = null
  if (obj) {
    saveObjective(obj)
    const sw = singleWriterOk(crew)
    emit({
      type: "OBJECTIVE_STARTED", taskId, runId: taskRunId, segmentId: null, nodeId: null,
      objectiveId: obj.id, class: classified.class, approvalRequired: obj.approvalRequired,
      crew: crew.map((c) => c.key), writers: sw.writers, singleWriter: sw.ok,
    })
  }
  /** Advance a phase, persist it, and publish honest progress. */
  const objPhase = (phase, note = "", gate = null) => {
    if (!obj) return
    try {
      objAdvancePhase(obj, phase, { note })
      saveObjective(obj)
      const prog = objProgress(obj, { gate })
      emit({ type: "OBJECTIVE_PHASE", taskId, runId: taskRunId, segmentId: null, nodeId: null, phase, pct: prog.pct, label: prog.label, done: prog.done, total: prog.total })
    } catch { /* the objective record is diagnostic — it must never break a run */ }
  }
  /** One action, with loop detection. Returns the loop verdict (or null). */
  const objAct = (phase, action, args = null, detail = "") => {
    if (!obj) return null
    try {
      const loop = objRecord(obj, { phase, action, args, detail })
      if (loop) {
        emit({ type: "LOOP_DETECTED", taskId, runId: taskRunId, segmentId: null, nodeId: null, action: loop.action, repeats: loop.repeats, suggestion: loop.suggestion })
        // The pivot is recorded AND handed to the strategy machinery that
        // already exists: an ineffective strategy is not retried.
        recordPivot(obj, { from: loop.action, to: "different approach", why: loop.suggestion })
        try {
          // A detected loop IS a lesson: the same action, retried with identical
          // arguments, is a failure mode the planner should skip next time.
          recordLesson({
            task: state.objective,
            failure: `loop: "${loop.action}" repeated ${loop.repeats}× with identical arguments`,
            failedStrategy: loop.action,
            rootCause: "the agent retried the same action instead of changing approach",
            solution: loop.suggestion,
          }, process.cwd())
        } catch { }
        saveObjective(obj)
      }
      return loop
    } catch { return null }
  }
  /** Build + persist the final report. Idempotent unless `force` (the verdict
   *  settles the last phases, so the report is rebuilt once to match them). */
  const objReport = ({ gate = null, docs = null, next = null, force = false, silent = false } = {}) => {
    if (!obj || (finalReport && !force)) return finalReport
    try {
      const changedRel = [...changedFiles].map((f) => path.relative(process.cwd(), f))
      const plan = docsDocPlan({ files: changedRel, repoFiles: changedRel })
      finalReport = buildReport({
        objective: obj, task: state, gate: gate ?? lastGate, review: lastReview, ledger,
        advisories: crew.length ? crewAdvisories({ cwd: process.cwd(), objective: state.objective, klass: classified.class, gate: gate ?? lastGate, review: lastReview, ledger, dag, files: changedRel }) : null,
        docs: docs ?? plan, klass: classified.class,
        analysis: [`crew: ${crew.length ? crew.map((c) => c.key).join(", ") : "(orchestration off)"}`],
        crewRun: crewStats, pipeline: pipelineResult,
        next,
      })
      if (config?.agent?.report !== false) saveReport(finalReport, { cwd: process.cwd() })
      // `silent` = a draft the closing hook will rebuild and announce once, so
      // a completed run never prints two FINAL_REPORT lines.
      if (!silent) emit({ type: "FINAL_REPORT", taskId, runId: taskRunId, segmentId: null, nodeId: null, reportId: finalReport.id, status: finalReport.status, pct: finalReport.pct, gateOk: finalReport.gateOk, sections: finalReport.sections.map((x) => x.id) })
      return finalReport
    } catch (e) { if (process.env.FORGE_DEBUG === "1") console.error("objReport failed:", e?.stack ?? e); return null }
  }
  if (obj && crew.length) {
    // The advisory pack is deterministic evidence, not another model call.
    try {
      const adv = crewAdvisories({ cwd: process.cwd(), objective: state.objective, klass: classified.class, compose: null })
      const text = formatAdvisories(adv)
      if (text) objAdvancePhase(obj, PHASE.ANALYZE, { note: `advisories: ${adv.sections.length} section(s) from ${adv.roles.join(", ")}` })
    } catch { }
  }
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
            claims: (composed.claims || []).slice(0, 3),
            decisions: (composed.decisions || []).slice(0, 3),
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
    if (obj) {
      // Planning failure is a real blocker, recorded as one — the objective is
      // never marked DONE because a later phase would have succeeded.
      recordBlocker(obj, { reason: "PLAN_FAILED", detail: String(e?.message ?? e).slice(0, 300), phase: PHASE.PLAN, recoverable: true })
      objPhase(PHASE.PLAN, `planning failed: ${String(e?.message ?? e).slice(0, 160)}`)
      objVerdict(obj, {})
      saveObjective(obj)
      objReport({})
    }
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
      objective: obj,
      report: finalReport,
    }
  }

  // v91 ULTIMATE: RESEARCH → PLAN → APPROVE are settled before the segment loop
  // starts. They are phases of the existing pipeline, not new work: the compose
  // snapshot IS the research, planValidation IS the plan, and approval is the
  // operator's standing decision (tools.autoApprove), never an invented prompt.
  if (obj) {
    objPhase(PHASE.RESEARCH, composedSnap ? "compose snapshot: index + world model + memory + skills" : "no repo model needed for this class")
    objPhase(PHASE.PLAN, `${planDefs.length} step(s)${planRepaired ? " (plan repaired)" : ""} — validation ${planValidation?.ok === false ? "FAILED" : "ok"}`)
    if (obj.approvalRequired) {
      const auto = config?.tools?.autoApprove !== false
      objAdvancePhase(obj, PHASE.APPROVE, { note: auto ? "auto-approved (tools.autoApprove — FULL CONTROL is the operator's standing decision)" : "approval requested" })
      if (!auto) recordBlocker(obj, { reason: "APPROVAL_REQUIRED", detail: "this class requires explicit approval; set tools.autoApprove or run with --yolo", phase: PHASE.APPROVE, recoverable: true })
    }
    objAdvancePhase(obj, PHASE.APPROVE, { note: obj.approvalRequired ? "see above" : `not required for ${classified.class}` })
    saveObjective(obj)
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
  // The budget counts ATTEMPTS. `repairCount` only counts repairs that worked,
  // so a repair that fails left the budget untouched and the run repaired the
  // same failure until the segment fuse (16 repairs observed against a budget of
  // 6). Attempts are the thing a budget can bound; successes are a report field.
  let repairAttempts = 0
  let lastVerifySignature = null
  let identicalVerifyFailures = 0
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
      lastReview = rev // v91: the report cites the real checklist, not a summary of it
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
    // v91 ULTIMATE: the objective closes through DOCUMENT → REPORT → LEARN, and
    // the report is written from evidence that already exists.
    if (obj) {
      objPhase(PHASE.VERIFY, "completion gate satisfied", gate)
      objPhase(PHASE.OPTIMIZE, changedFiles.size ? `${changedFiles.size} file(s) changed` : "no files changed", gate)
      const docsRun = await runDocsPhase({
        agent, config, provider: provRef.prov, signal, emit,
        objective: state.objective, klass: classified.class, changedFiles,
        noteFiles: (abs) => ts.noteFiles([abs], []),
        taskId, runId: taskRunId, cwd: process.cwd(), enabled: docsAgentEnabled,
      })
      docsResult = docsRun.result
      objPhase(PHASE.DOCUMENT, docsRun.note, gate)
      objVerdict(obj, { gate })
      objPhase(PHASE.REPORT, "", gate)
      objReport({ gate, silent: true })
      objPhase(PHASE.LEARN, `strategy score recorded${repairCount ? ` • ${repairCount} repair(s)` : ""}`, gate)
      saveObjective(obj)
    }
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
          // v92 PROCREW: one scheduler for sub-agent work. Duplicate units are
          // refused before they cost a model call, units that clash on a file
          // are split into separate waves, every finding is self-reviewed, a
          // failed unit is retried under a different specialist, and an
          // approach the user already rejected is never attempted again.
          dagFindings += await runCrewBatch(batch, { segmentId, contextBlock, parallelN })
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

    // v91 ULTIMATE: objective bookkeeping for this segment. The fingerprint is
    // what the segment DID — same outcome twice in a row is a loop, not progress.
    if (obj) {
      objPhase(PHASE.EXECUTE, `segment ${segment}: ${segStatus}${res.budgetHit ? " (step budget hit)" : ""}`)
      const loop = objAct(PHASE.EXECUTE, `segment:${segStatus}:${changedFiles.size}:${segToolCalls}`, { nodeId: currentNodeId, segment })
      if (loop) objPhase(PHASE.REPAIR, `loop detected: ${loop.suggestion}`)
      const comp = noteContext(obj, (state.resource_usage?.tokens_in ?? 0) + (state.resource_usage?.tokens_out ?? 0))
      if (comp) emit({ type: "CONTEXT_COMPRESSION_REQUESTED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, chars: comp.chars, budget: comp.budget, directive: comp.directive })
      if (segStatus === "error") recordBlocker(obj, { reason: "SEGMENT_FAILED", detail: String(res.error ?? "").slice(0, 200), phase: PHASE.EXECUTE, recoverable: true })
    }

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

    // --- v92 PROCREW: the verification pipeline ------------------------------
    // Every task runs the SAME stages in the SAME order, taken from the
    // project's own manifests — build, lint, typecheck, test, validate. The
    // evidence lands in the ledger BEFORE the status below is judged, so the
    // completion gate reads real results instead of whatever the model happened
    // to run. A stage with no real command is reported skipped, never faked.
    if (pipelineEnabled && pipelineStale && pipelineRuns < 3 && changedFiles.size && !signal?.aborted) {
      try {
        pipelineRuns += 1
        const plan = planPipeline({ cwd: process.cwd(), files: changedRel, config })
        emit({ type: "PIPELINE_PLANNED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, stages: plan.stages.map((x) => x.id), skipped: plan.skipped.map((x) => `${x.id}: ${x.reason}`) })
        if (!plan.stages.length) {
          pipelineStale = false
          objPhase(PHASE.VERIFY, "pipeline: this project defines no build/lint/typecheck/test command — nothing faked")
        } else {
          objPhase(PHASE.VERIFY, `pipeline: ${plan.stages.map((x) => x.id).join(" → ")}`)
          const res = await runPipeline({
            plan, cwd: process.cwd(), signal,
            opts: { timeoutMs: Number(config?.agent?.verifyTimeoutMs) || PIPELINE_DEFAULTS.timeoutMs, stopOnFailure: true },
            onEvent: (ev) => emit({ taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, ...ev }),
          })
          pipelineResult = res
          pipelineStale = false
          for (const st of res.stages) {
            if (st.skippedRun) continue
            const rec = ledger.add({
              ...st.record,
              verification_id: `ver-pipeline-${st.id}-${pipelineRuns}`,
              taskId, runId: taskRunId, nodeId: currentNodeId, segmentId,
              verificationEpoch: state.verification_epoch ?? 0,
              affectedFiles: changedRel.slice(0, 32),
              identityScope: "task",
            })
            ts.noteVerification(rec)
          }
          const verdict = pipelineVerdict(res)
          emit({ type: "PIPELINE_RESULT", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, ok: res.ok, reason: verdict.reason, stages: res.stages.map((x) => ({ id: x.id, passed: x.passed, failureShape: x.failureShape, attempts: x.attempts })), ms: res.ms })
          objPhase(PHASE.VERIFY, `pipeline ${res.ok ? "PASS" : "FAIL"} — ${verdict.reason}`)
          if (!res.ok) {
            // Diagnose for the repair phase: shape + hint, from the ledger's own
            // vocabulary. No new failure taxonomy.
            const broken = res.stages.find((x) => !x.passed && !x.skippedRun)
            if (broken) {
              const d = pipelineDiagnose(broken.record)
              emit({ type: "PIPELINE_DIAGNOSIS", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, stage: broken.id, shape: d.shape, hint: d.hint, tail: d.tail })
              recordBlocker(obj, { reason: "PIPELINE_FAILED", detail: `${broken.id}: ${d.shape} — ${d.hint}`, phase: PHASE.VERIFY, recoverable: true })
            }
          }
        }
      } catch (e) {
        ts.noteError("PIPELINE_FAILED", e?.message ?? String(e))
        emit({ type: "PIPELINE_ERROR", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, error: String(e?.message ?? e).slice(0, 200) })
      }
    }

    const v = ledger.status(finalRiskLevel, changedRel, { nodeId: currentNodeId })
    emit({ type: "VERIFICATION_STATUS", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, ok: v.ok, missing: v.missing, reason: v.reason, risk: finalRiskLevel, initialRisk: riskLevel, status: v.status })

    if (!v.anyFailure) { lastVerifySignature = null; identicalVerifyFailures = 0 }
    // VERIFICATION FAILED → REPAIRING (hard gate). The node goes back to
    // REPAIRING too: execution succeeded, the OUTCOME did not.
    if (v.anyFailure) {
      // v92: "retry until success OR report a blocking issue". Two bounds, both
      // measured on ATTEMPTS: the configured repair budget, and a repeat of the
      // SAME failure on the SAME files — repairing that again is the loop, not
      // the fix. Without this the run repaired one unfixable verification until
      // the segment fuse and then reported a FUSE instead of the real blocker.
      const verifySignature = `${String(v.reason ?? "")}|${changedRel.join(",")}`
      if (verifySignature === lastVerifySignature) identicalVerifyFailures += 1
      else { lastVerifySignature = verifySignature; identicalVerifyFailures = 0 }
      const exhausted = repairAttempts >= maxRepairs || identicalVerifyFailures >= 2
      if (exhausted) {
        const detail = repairAttempts >= maxRepairs
          ? `${repairAttempts} repair attempt(s) against a budget of ${maxRepairs} — ${String(v.reason ?? "").slice(0, 140)}`
          : `the same verification failure repeated ${identicalVerifyFailures + 1}× on the same files — ${String(v.reason ?? "").slice(0, 140)}`
        recordBlocker(obj, { reason: "VERIFICATION_NOT_RECOVERING", detail, phase: PHASE.REPAIR, recoverable: false })
        emit({ type: "REPAIR_GAVE_UP", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, attempts: repairAttempts, identicalFailures: identicalVerifyFailures + 1, reason: String(v.reason ?? "").slice(0, 200) })
        objPhase(PHASE.REPAIR, `giving up: ${detail}`)
        ts.transition(TASK_STATUS.REPAIRING, { reason: "verification not recovering" })
        finalStatus = explicitFinalization(FINAL.WAITING)
        finalText = `verification could not be satisfied: ${String(v.reason ?? "").slice(0, 300)}`
        break
      }
      if (dag && currentNodeId) { try { dagLib.markRepairing(dag, currentNodeId, v.reason); persistDAG() } catch { } }
      ts.transition(TASK_STATUS.REPAIRING, { reason: "verification failed" })
      emit({ type: "REPAIR_STARTED", taskId, runId: taskRunId, segment, segmentId, nodeId: currentNodeId, attempt: repairCount + 1, error: v.reason })
      objPhase(PHASE.REPAIR, `verification failed: ${String(v.reason ?? "").slice(0, 120)}`)
      const recovered = await repairSegment({ agent, config, provider: prov, signal, emit, state, error: v.reason, segment, ts, ledger, ctxEngine, verification: v, taskRunId, taskId, segmentId, nodeId: currentNodeId, finalRisk: finalRiskLevel, omega, changedFiles: [...changedFiles] })
      repairAttempts += 1
      // v92: the pipeline evidence predates the repair, so it no longer verifies
      // these files. Re-run it on the next verification pass.
      pipelineStale = true
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

  // v91 ULTIMATE: the objective verdict is derived, never assumed. A budget or
  // segment fuse lands in WAITING/FUSE — never in DONE.
  if (obj) {
    const v = objVerdict(obj, { gate: lastGate, cancelled: Boolean(signal?.aborted), fuse: finalStatus === FINAL.WAITING, fuseReason: `segment/continuation fuse reached after ${segment} segment(s)` })
    saveObjective(obj)
    emit({ type: "OBJECTIVE_VERDICT", taskId, runId: taskRunId, segmentId: null, nodeId: null, status: v.status, reason: v.reason, pct: v.pct, missing: v.missing })
    // The verdict settled the in-flight phases — rebuild so the report's phase
    // table and percentage agree with the status it prints.
    if (finalReport || v.status === OBJ_STATUS.DONE) objReport({ gate: lastGate, force: true })
    else objReport({ gate: lastGate })
  }

  emit({ type: "TASK_FINISHED", taskId, runId: taskRunId, status: finalStatus, state: finalState, segments: segment, repairs: repairCount, text: String(finalText).slice(0, 300) })

  const finalRisk = recomputeFinalRisk()
  return {
    taskId,
    runId: taskRunId,
    status: finalStatus,
    state: finalState,
    text: finalText,
    // v92 PROCREW: what the sub-agents did and what the pipeline proved
    crew: { ...crewStats },
    docs: docsResult,
    pipeline: pipelineResult ? { ok: pipelineResult.ok, reason: pipelineVerdict(pipelineResult).reason, stages: pipelineResult.stages.map((x) => ({ id: x.id, passed: x.passed, skipped: x.skippedRun === true, failureShape: x.failureShape || null, attempts: x.attempts || 1 })) } : null,
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
    // v91 ULTIMATE — the objective record and the final report (null when
    // agent.objective / agent.report is off, so callers keep working unchanged)
    objective: obj,
    report: finalReport,
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

/**
 * v93 DOCSMITH — the DOCUMENT phase, as a testable unit.
 *
 * The BRIEF is deterministic (docsintel.docsBrief): every target in it is
 * obliged by the diff, so the model is never invited to invent something to
 * document, and an empty brief means "nothing to write" — not "write something
 * plausible".
 *
 * The WRITING is done by the executor, the roster's single writer. The
 * documentation specialist is read-only and stays read-only: `singleWriterOk`
 * is a structural invariant, and a docs agent with its own write authority would
 * be a second writer. For LARGE/ARCHITECTURAL a read-only drafting pass runs
 * first, because there the delta is usually more than a changelog line.
 *
 * Runs after verification, because documentation does not invalidate test
 * evidence about code. What it writes is added to `changedFiles` so the
 * report's Files Changed stays truthful.
 *
 * @returns {Promise<{note:string, result:object|null}>}
 */
export async function runDocsPhase({
  agent, config, provider, signal = null, emit = () => {},
  objective = "", klass = null, changedFiles = new Set(), noteFiles = () => {},
  taskId = null, runId = null, cwd = process.cwd(), enabled = true,
  draftClasses = DOCS_DRAFT_CLASSES,
} = {}) {
  const ev = (e) => { try { emit({ taskId, runId, ...e }) } catch { /* observability never breaks a run */ } }
  if (!enabled) return { note: "documentation deltas listed in the report (docs agent off)", result: null }
  if (!changedFiles.size) return { note: "no files changed — nothing to document", result: null }

  let brief = null
  try {
    const changedRel = [...changedFiles].map((f) => path.relative(cwd, f))
    // the REAL repo file list: with only the changed files, a README that exists
    // would be reported "missing — create", and the model would act on that lie
    const repoFiles = listSourceFiles(cwd, { exts: new Set([".md", ".markdown", ".txt"]) })
    brief = docsBrief({ objective, files: changedRel, repoFiles })
  } catch (e) {
    return { note: `doc plan unavailable: ${String(e?.message ?? e).slice(0, 120)}`, result: null }
  }
  if (brief.empty) return { note: "nothing in this change obliges a documentation update", result: null }
  ev({ type: "DOCS_BRIEF", segmentId: null, nodeId: null, targets: brief.targets.map((t) => `${t.doc}${t.path ? `(${t.path})` : "(create)"}:${t.severity}`) })

  let draft = ""
  if (draftClasses.has(klass)) {
    try {
      const d = await agent({
        config, provider, signal, taskId, runId, segmentId: null, nodeId: null,
        task: `${brief.text}\n\nDo NOT modify any file — you are read-only. Return the exact documentation content to write for each listed file, under a heading with the file path. No commentary.`,
        readOnly: true, maxStepsOverride: 6, deep: false, onEvent: ev, journal: true,
        runIdOverride: runId, suppressRunEvents: true, keepJournalRunning: true,
      })
      draft = String(d?.text ?? "")
      ev({ type: "DOCS_DRAFTED", segmentId: null, nodeId: null, ok: !d?.error && draft.trim().length > 0, chars: draft.length, error: d?.error ? String(d.error).slice(0, 160) : null })
    } catch (e) {
      ev({ type: "DOCS_DRAFT_FAILED", segmentId: null, nodeId: null, error: String(e?.message ?? e).slice(0, 200) })
    }
  }

  try {
    const ask = `${brief.text}${draft ? `\n\nA read-only reviewer drafted this — use it where it is correct, correct it where it is not:\n${draft.slice(0, 6000)}` : ""}\n\nApply these updates now with the file tools. Change ONLY the listed files.`
    const r = await agent({
      config, provider, signal, taskId, runId, segmentId: null, nodeId: null,
      task: ask, maxStepsOverride: 8, deep: false, onEvent: ev, journal: true,
      runIdOverride: runId, suppressRunEvents: true, keepJournalRunning: true,
    })
    const wrote = [...new Set((r?.toolRecords ?? []).flatMap((x) => x.files_changed ?? []).map(String))]
    for (const f of wrote) {
      const abs = path.resolve(cwd, f)
      changedFiles.add(abs)
      try { noteFiles(abs) } catch { /* accounting is best-effort */ }
    }
    const result = { targets: brief.targets, wrote, draftChars: draft.length, ok: !r?.error }
    ev({ type: "DOCS_APPLIED", segmentId: null, nodeId: null, ok: !r?.error, files: wrote, targets: brief.targets.length, error: r?.error ? String(r.error).slice(0, 160) : null })
    return {
      note: `${brief.targets.length} doc target(s) — ${wrote.length ? `wrote ${wrote.map((f) => path.relative(cwd, f)).join(", ")}` : "no listed file needed a change"}`,
      result,
    }
  } catch (e) {
    ev({ type: "DOCS_APPLY_FAILED", segmentId: null, nodeId: null, error: String(e?.message ?? e).slice(0, 200) })
    return { note: `documentation not written: ${String(e?.message ?? e).slice(0, 120)}`, result: null }
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
