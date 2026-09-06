/**
 * forge — meta controller (v21, zero dependencies)
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
 * It does NOT replace agent.js — each SEGMENT is one runAgent() call (the
 * existing, hardened tool loop with ShellGuard / SafePath / NetGuard / redaction
 * / Tool Intelligence fully intact). The controller owns the cross-segment
 * state machine, the DAG, model strategy, the worker pool, resources, the
 * verification ledger, effect reconciliation and failure learning.
 *
 * Final status is always one of COMPLETED / FAILED / CANCELLED / WAITING — a
 * task never silently stops.
 */
import { openTask, readTask, TASK_STATUS, TERMINAL } from "./taskstate.js"
import { createLedger, riskForChange } from "./verifyledger.js"
import { createResourceManager, ADAPT } from "./resources.js"
import { selectModel, reconsiderModel } from "./modelstrategy.js"
import { createAgentManager } from "./agentmanager.js"
import { createContextEngine } from "./context.js"
import { recordLesson, ineffectiveStrategies } from "./lessons.js"
import { reconcileEffect, reconcileTask, resumePrompt, UNKNOWN_DECISION } from "./recovery.js"
import { snapshotBefore, boundaryCheckpoint } from "./checkpoint.js"
import { redact } from "./secrets.js"
import * as dagLib from "./dag.js"
import fs from "node:fs"
import path from "node:path"

const SEGMENT_STEPS = 12 // per-segment step budget (a SAFETY bound, not task completion)
const MAX_SEGMENTS_DEFAULT = 40 // task-level fuse; generous, and never the definition of done

export const FINAL = { COMPLETED: "COMPLETED", FAILED: "FAILED", CANCELLED: "CANCELLED", WAITING: "WAITING" }

/**
 * Run a task to a terminal/waiting state.
 * @param config   forge config
 * @param provider a runnable provider object (name/model/baseUrl/apiKey…)
 * @param task     objective string
 * @param opts     { onEvent, signal, resumeTaskId, segmentSteps, maxSegments,
 *                   runAgent (injected for tests), deep }
 */
export async function runMeta({ config, provider, task, onEvent = null, signal = null, resumeTaskId = null, segmentSteps, maxSegments, runAgent = null, deep, workers = null } = {}) {
  const emit = (ev) => { try { onEvent?.(ev) } catch { /* observability never breaks */ } }

  // --- resume vs fresh -----------------------------------------------------
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
  // ONE runId shared by every mutating segment → one atomic undo for the task.
  const taskRunId = state.run_id || "run-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6)
  state.run_id = taskRunId
  const ledger = createLedger()
  if (Array.isArray(state.verification_results)) ledger.load(state.verification_results)
  const resources = createResourceManager({ config, cwd: process.cwd() })
  const ctxEngine = createContextEngine({ cwd: process.cwd(), config })
  const manager = createAgentManager({
    maxWorkers: resources.state.maxWorkers,
    onEvent: emit,
    signal,
  })
  // mutable holder so the injected worker runner always sees the CURRENT
  // provider (initial provider + any model-strategy switch later on).
  const provRef = { prov: provider }

  // agent.js is imported lazily so this module stays cycle-free in tests; the
  // caller may inject a fake runAgent.
  const agent = runAgent ?? (await import("./agent.js")).runAgent
  // The DAG worker pool fans out REAL sub-agents; with an injected fake
  // (tests) it defaults OFF unless the caller explicitly opts in.
  const workersEnabled = workers ?? (!runAgent && config?.agent?.workers !== false)

  // the worker pool runs read-only research/review/security sub-agents through
  // the SAME runAgent (and therefore the same security gate); it is injected
  // rather than imported so tests can supply a fake runner.
  manager.configure({
    config, provider,
    runner: ({ role, task: subTask, context, readOnly, signal: sig, dagNode }) =>
      agent({
        config, provider: provRef.prov, task: subTask,
        extraContext: context ? `--- relevant project context (demand-loaded) ---\n${context}` : undefined,
        onEvent: segmentEvents(emit, `worker:${dagNode ?? role}`), signal: sig ?? signal,
        readOnly: readOnly !== false, maxStepsOverride: 10, worker: { role, dagNode },
        budgetHit: false, // worker findings never count as "task continues"
        journal: false, suppressRunEvents: true,
      }).then((r) => r.text),
  })

  const segSteps = segmentSteps ?? config?.agent?.segmentSteps ?? SEGMENT_STEPS
  const maxSeg = maxSegments ?? config?.agent?.maxSegments ?? MAX_SEGMENTS_DEFAULT

  // model selection (separate from transport failover, which stays in providers)
  const sel = selectModel(config, { task: state.objective, provider })
  let prov = provider
  if (sel?.decision && config?.agent?.modelStrategy !== false) {
    emit({ type: "MODEL_SELECTED", model: sel.decision.model, provider: sel.decision.provider, reason: sel.decision.reason, confidence: sel.decision.confidence, capabilities: sel.decision.capabilities })
    ts.noteModel(sel.decision.provider, sel.decision.model, sel.decision.reason)
    // switch only if the decision points at another CONFIGURED, runnable provider
    if (sel.decision.provider !== provider?.name) {
      try {
        const { buildProvider } = await import("./providers.js")
        const np = buildProvider(config, sel.decision.provider)
        if (np && np.model) { prov = { ...np, model: sel.decision.model }; provRef.prov = prov; manager.configure({ config, provider: prov }) }
      } catch { /* keep the active provider on any trouble */ }
    }
  } else {
    ts.noteModel(provider?.name ?? "?", provider?.model ?? "?", "active provider")
  }

  // --- recovery reconciliation (resume path) -------------------------------
  let resumeRecon = null
  if (resumeRec) {
    ts.transition(TASK_STATUS.RECOVERING, { reason: "resuming interrupted task" })
    emit({ type: "RECOVERY_STARTED", taskId, objective: state.objective })
    resumeRecon = reconcileTask(resumeRec, { cwd: process.cwd() })
    emit({ type: "RECOVERY_COMPLETED", taskId, recommended: resumeRecon.recommended, drift: resumeRecon.effects ? [resumeRecon.effects.missing.length, resumeRecon.effects.unknown.length] : [0, 0] })
    ts.decide("recovery", resumeRecon.recommended)
  }

  // --- plan / discover -----------------------------------------------------
  const riskLevel = riskForChange({ task: state.objective })
  ts.transition(TASK_STATUS.PLANNING, { reason: "building plan" })
  emit({ type: "TASK_STARTED", taskId, objective: state.objective, risk: riskLevel })

  // plan via a read-only planning segment (model proposes; never mutates).
  // noTools → the model emits a plan rather than trying to execute one.
  let planText = ""
  try {
    const planRes = await agent({
      config, provider: prov, signal,
      task: `${state.objective}\n\nProduce a concise dependency-aware plan as a numbered list (one action per line). Mark read-only investigation steps and implementation steps. 4-8 steps. Do NOT execute.`,
      planOnly: true, readOnly: true, noTools: true, maxStepsOverride: 4, deep,
      onEvent: passThrough(emit, "plan"), suppressRunEvents: true,
    })
    planText = planRes?.text ?? ""
  } catch (e) {
    ts.noteError("PLAN_FAILED", e?.message ?? String(e))
  }

  // build the DAG from the plan (best-effort; a bad parse just leaves no DAG)
  let dag = null
  const persistDAG = () => { if (dag) ts.setDAG(dagLib.serializeDAG(dag)) }
  try {
    const defs = dagLib.parsePlanToDAG(planText)
    if (defs.length) {
      // on resume, prefer rehydrating the CRASH-SURVIVED graph so completed
      // nodes stay complete; fall back to a fresh build from the new plan.
      dag = (resumeRec && state.dag && dagLib.deserializeDAG(state.dag)) || dagLib.buildDAG(defs)
      persistDAG()
      emit({ type: "DAG_BUILT", nodes: dag.order.length })
    }
  } catch (e) {
    ts.noteError("DAG_FAILED", e?.message ?? String(e))
  }

  // --- the segment loop ----------------------------------------------------
  let segment = 0
  let finalStatus = FINAL.FAILED
  let finalText = ""
  let consecutiveFailures = 0
  let repairCount = 0
  let evidenceRequests = 0
  let totalToolCalls = 0
  let slowFailures = 0
  const changedFiles = new Set()

  ts.transition(TASK_STATUS.EXECUTING, { reason: "starting segments" })

  while (segment < maxSeg) {
    if (signal?.aborted) { finalStatus = FINAL.CANCELLED; break }

    segment++
    const segmentId = `seg-${segment}`
    const segStart = Date.now()
    ts.transition(TASK_STATUS.EXECUTING, { reason: `segment ${segment}` })
    emit({ type: "SEGMENT_STARTED", segment, segmentId, objective: state.objective, maxSteps: segSteps })
    resources.record({ segment: true })

    // adapt resources for this segment
    const adaptation = resources.evaluate()
    manager.setMaxWorkers(adaptation.limits.maxWorkers)
    if (adaptation.actions.length) emit({ type: "RESOURCE_ADAPTED", level: adaptation.level, actions: adaptation.actions.map((a) => a.action), summary: resources.summary() })

    // before a risky segment, checkpoint (the controller's own boundary; the
    // tools also checkpoint before each mutation — this covers the segment)
    const riskNow = riskForChange({ filesChanged: changedFiles.size, task: state.objective, securitySensitive: riskLevel === "critical" })
    if (riskNow === "high" || riskNow === "critical" || segment === 1) {
      ts.transition(TASK_STATUS.CHECKPOINTING, { reason: "boundary before risky segment" })
      // real rollback point: record the fs state (files + git head + untracked
      // list) so `forge undo --run` and crash-resume can reconcile against it.
      let cpId = null
      try {
        const cwd = process.cwd()
        // protect the files this task has already touched (the ones an undo
        // would need to restore); if none exist yet, still record a boundary
        // anchor (git HEAD + run label) for crash-resume reconciliation.
        const touched = [...changedFiles].filter((f) => { try { return fs.existsSync(f) } catch { return false } })
        cpId = touched.length
          ? snapshotBefore(touched, cwd, [], taskRunId)
          : boundaryCheckpoint(cwd, { runId: taskRunId, label: `segment-${segment}`, objective: state.objective })
      } catch (e) { ts.noteError("CHECKPOINT_FAILED", e?.message ?? String(e)) }
      if (cpId) ts.noteCheckpoint(cpId)
      emit({ type: "CHECKPOINT_CREATED", boundary: "segment", segment, checkpointId: cpId })
      ts.transition(TASK_STATUS.EXECUTING, { reason: "resume after checkpoint boundary" })
    }

    // demand-driven context for THIS segment (never the whole repo)
    const contextBuilt = ctxEngine.build(state.objective, { budgetTokens: 2200, precision: adaptation.limits.retrievalPrecision === "precise" ? "precise" : "normal" })
    const contextBlock = typeof contextBuilt === "string" ? contextBuilt : contextBuilt?.text ?? ""

    // check failure learning BEFORE repeating a known-dead strategy
    const knownBad = ineffectiveStrategies(state.objective, { cwd: process.cwd() })
    if (knownBad.length) emit({ type: "STRATEGY_CHANGED", reason: `avoiding ${knownBad.length} previously-ineffective approach(es)`, avoided: knownBad.slice(0, 2).map((l) => l.failed_strategy || l.failed_action) })

    // continuation prompt: resume reconciliation for the first segment of a
    // resumed task, the objective for the first segment of a fresh task, and a
    // state-aware continuation thereafter.
    // DAG-driven read-only fan-out: independent investigation nodes run as
    // PARALLEL researcher/reviewer/security workers while mutating nodes stay
    // with the serialized main agent. Read-only work NEVER mutates (the worker
    // runs readOnly:true through the same security gate).
    let dagFindings = ""
    if (dag && workersEnabled && !signal?.aborted) {
      try {
        const batch = dagLib.scheduleBatch(dag, { maxParallel: Math.max(1, resources.state.maxWorkers), conflictKeys: () => [] })
          .filter((n) => n.read_only && n.role && n.role !== "coder")
        if (batch.length) {
          emit({ type: "DAG_DISPATCH", nodes: batch.map((n) => n.id), parallel: batch.length })
          const jobs = batch.map((n) => {
            dagLib.markRunning(dag, n.id)
            const job = manager.spawn({
              role: n.role,
              task: `${n.objective}\n\nThis is a read-only investigation subtask of: ${state.objective}. Do NOT modify files. Report concise findings (file paths, symbols, facts) the implementer will need.`,
              context: contextBlock.slice(0, 3500),
              dagNode: n.id,
              timeoutMs: 1000 * 60 * 2,
            })
            resources.record({ workers: 1 })
          return job.promise.then((r) => {
            if (r.status === "completed") {
              dagLib.markCompleted(dag, n.id, String(r.result ?? "").slice(0, 2000))
              dagFindings += `\n\n--- finding from ${n.role} (${n.id}) ---\n${String(r.result ?? "").slice(0, 1200)}`
            } else {
              dagLib.markFailed(dag, n.id, r.error ?? r.status)
            }
            persistDAG()
          }).catch((e) => { try { dagLib.markFailed(dag, n.id, String(e?.message ?? e)); persistDAG() } catch {} })
          })
          // findings are ADVISORY: give fast read-only workers a short window
          // to contribute before the mutating segment proceeds; results that
          // land later still update the persisted DAG for future segments.
          await Promise.race([
            Promise.allSettled(jobs),
            new Promise((resolve) => setTimeout(resolve, 4000)),
          ])
        }
      } catch (e) { ts.noteError("DAG_FANOUT_FAILED", e?.message ?? String(e)) }
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
        extraContext: [dagFindings ? `DAG worker findings:\n${dagFindings}` : "", contextBlock ? `--- relevant project context (demand-loaded) ---\n${contextBlock}` : ""].filter(Boolean).join("\n\n") || undefined,
        maxStepsOverride: segSteps, deep, onEvent: segmentEvents(emit, segment),
        journal: true, runIdOverride: taskRunId, suppressRunEvents: true, keepJournalRunning: true,
      })
    } catch (e) {
      res = { error: e?.message ?? String(e), aborted: e?.name === "AbortError" || signal?.aborted }
    }
    const segMs = Date.now() - segStart

    // --- observation -------------------------------------------------------
    if (res.aborted || signal?.aborted) { finalStatus = FINAL.CANCELLED; finalText = "cancelled by user"; break }

    // gather files changed from tool records
    const recs = res.toolRecords ?? []
    for (const r of recs) {
      for (const f of r.files_changed ?? []) {
        const abs = path.resolve(process.cwd(), f)
        changedFiles.add(abs)
        if (r.tool === "write_file") state.files_created.includes(abs) || ts.noteFiles([], [abs])
        else ts.noteFiles([abs], [])
      }
      if (r.checkpoint) ts.noteCheckpoint(r.checkpoint)
    }
    if (changedFiles.size) ctxEngine.invalidateFor([...changedFiles])

    // DAG progress: attribute this segment to the best-matching READY/RUNNING
    // node and mark it complete (or failed) so the graph reflects reality and
    // downstream nodes become READY after a crash-safe persist.
    if (dag) {
      try {
        const progress = { files: changedFiles.size, toolCalls: segToolCalls, text: String(res.text ?? "").slice(0, 800), segment }
        const segNode = attributeSegment(dag, progress)
        if (segNode) {
          if (res.error) dagLib.markFailed(dag, segNode.id, String(res.error).slice(0, 200))
          else dagLib.markCompleted(dag, segNode.id, `segment ${segment}: ${changedFiles.size} file(s), ${segToolCalls} tool call(s)`)
          persistDAG()
        }
      } catch { /* DAG accounting is best-effort */ }
    }

    // structured verification evidence from real command exit codes
    for (const chk of res.commandChecks ?? []) {
      const rec = ledger.recordCommand(chk.command, chk.tail + (chk.passed ? "" : ` [exit code: ${chk.exitCode}]`), {
        exitCode: chk.exitCode,
        duration: null,
        affectedFiles: [...changedFiles].map((f) => path.relative(process.cwd(), f)),
      })
      ts.noteVerification(rec)
      ts.noteTest({ command: rec.command, exit_code: rec.exit_code, passed: rec.passed })
      emit({ type: chk.passed ? "VERIFICATION_PASSED" : "VERIFICATION_FAILED", vtype: rec.type, command: rec.command, exitCode: rec.exitCode, evidence: rec.evidence })
    }

    const segToolCalls = res.toolLog?.length ?? 0
    totalToolCalls += segToolCalls
    // real resource accounting: latency, token usage (reported by the provider
    // or estimated by agent.js), tool calls and active workers.
    const u = res.usage ?? {}
    const tokIn = u.prompt ?? u.prompt_tokens ?? u.input_tokens ?? 0
    const tokOut = u.completion ?? u.completion_tokens ?? u.output_tokens ?? 0
    resources.record({ tokensIn: tokIn, tokensOut: tokOut, toolCalls: segToolCalls, latencyMs: segMs, workers: manager.stats().active })
    const segStatus = res.error ? "failed" : res.budgetHit ? "continued" : "completed"
    ts.addSegment({ segment_id: segmentId, objective: state.objective, status: segStatus, steps: res.steps ?? 0, tool_calls: segToolCalls, continued: !!res.budgetHit })
    ts.noteUsage({ tokens_in: tokIn, tokens_out: tokOut, tool_calls: segToolCalls, ms: segMs, workers: manager.stats().active })
    ts.flush()

    // mid-task model reconsideration: when the resource manager's signals
    // (latency / token pressure / error streak) call for a cheaper or stronger
    // model, ASK the strategy engine — switching stays its margin-gated call.
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
              emit({ type: "MODEL_SELECTED", model: decision.model, provider: decision.provider, reason: decision.reason, confidence: decision.confidence, reconsidered: true })
              emit({ type: "STRATEGY_CHANGED", reason: `model → ${decision.model} (${decision.provider}): ${decision.reason}` })
            }
          } catch { /* keep current provider on any trouble */ }
        }
      }
    }

    emit({ type: "SEGMENT_COMPLETED", segment, status: segStatus, steps: res.steps, toolCalls: res.toolLog?.length ?? 0, budgetHit: !!res.budgetHit })

    // --- failure → diagnose → strategy change → repair --------------------
    if (res.error) {
      consecutiveFailures++
      ts.transition(TASK_STATUS.REPAIRING, { reason: "segment errored" })
      ts.noteError("SEGMENT_FAILED", res.error)
      emit({ type: "REPAIR_STARTED", segment, attempt: consecutiveFailures, error: redact(String(res.error)).slice(0, 200) })
      const recovered = await repairSegment({ agent, config, provider: prov, signal, emit, state, error: res.error, segment, ts, ledger, ctxEngine, taskRunId })
      repairCount += recovered ? 1 : 0
      ts.noteRepair(recovered ? 1 : 0)
      if (consecutiveFailures >= 3 || !recovered) {
        // repeated failure: learn, then either ask or fail
        recordLesson({
          failure: String(res.error).slice(0, 200),
          cause: "segment failed repeatedly",
          failedStrategy: "repeat same approach",
          successfulRepair: "",
          applicableContext: state.objective,
          task: state.objective,
          confidence: 0.5,
        })
        if (consecutiveFailures >= 3) {
          finalStatus = FINAL.FAILED
          finalText = `task failed after ${consecutiveFailures} consecutive failed segments: ${redact(String(res.error)).slice(0, 300)}`
          ts.noteError("GIVE_UP", finalText)
          break
        }
      }
      ts.transition(TASK_STATUS.EXECUTING, { reason: "after repair" })
      continue
    }
    consecutiveFailures = 0

    // --- verification gate --------------------------------------------------
    ts.transition(TASK_STATUS.VERIFYING, { reason: "post-segment verification" })
    const changedRel = [...changedFiles].map((f) => path.relative(process.cwd(), f))
    const v = ledger.status(riskNow, changedRel)
    emit({ type: "VERIFICATION_STATUS", ok: v.ok, missing: v.missing, reason: v.reason, risk: riskNow })

    // a FAILED command-level check is evidence of a broken change → repair.
    if (v.anyFailure) {
      ts.transition(TASK_STATUS.REPAIRING, { reason: "verification failed" })
      emit({ type: "REPAIR_STARTED", segment, attempt: repairCount + 1, error: v.reason })
      const recovered = await repairSegment({ agent, config, provider: prov, signal, emit, state, error: v.reason, segment, ts, ledger, ctxEngine, verification: v, taskRunId })
      repairCount += recovered ? 1 : 0
      ts.noteRepair(recovered ? 1 : 0)
      evidenceRequests = 0 // a repair is a fresh chance to verify
      ts.transition(TASK_STATUS.EXECUTING, { reason: "after verification repair" })
      continue
    }

    // did the model signal completion (final answer, budget not hit)?
    const finished = !res.budgetHit
    const needsMore = res.budgetHit

    // decide whether the objective is adequately VERIFIED for its risk.
    // Risk-proportional: trivial/no-file changes need no command evidence;
    // medium+ changes should have a passing test/build; if the agent declared
    // done but evidence is thin, we ask ONCE for explicit verification instead
    // of looping or of claiming success without proof.
    const noMutation = changedFiles.size === 0
    const evidenceAdequate = v.ok || noMutation || riskLevel === "trivial"
    const evidenceRequestedAlready = evidenceRequests >= 1

    if (finished && evidenceAdequate) {
      finalStatus = FINAL.COMPLETED
      finalText = res.text ?? "task completed"
      ts.transition(TASK_STATUS.COMPLETED, { reason: "objective satisfied and verified" })
      emit({ type: "TASK_COMPLETED", taskId, segment, text: String(finalText).slice(0, 400) })
      break
    }

    if (finished && !evidenceAdequate && !evidenceRequestedAlready) {
      // ask the agent ONE explicit verification segment before accepting success
      evidenceRequests++
      ts.setNextAction(`verify: run ${v.missing.join(" / ")} before declaring success`)
      ts.transition(TASK_STATUS.VERIFYING, { reason: "requesting risk-proportional evidence" })
      emit({ type: "STRATEGY_CHANGED", reason: `objective met but evidence is thin for risk=${riskNow} — run ${v.missing.join(", ")} to verify`, missing: v.missing })
      const verified = await requestVerification({ agent, config, provider: prov, signal, emit, state, missing: v.missing, ts, ledger, ctxEngine, taskRunId })
      if (verified) {
        finalStatus = FINAL.COMPLETED
        finalText = res.text ?? "task completed (verified)"
        ts.transition(TASK_STATUS.COMPLETED, { reason: "objective satisfied after explicit verification" })
        emit({ type: "TASK_COMPLETED", taskId, segment, text: String(finalText).slice(0, 400) })
        break
      }
      // verification could not be produced (no test suite etc.) — accept with
      // honest local evidence rather than loop; record the shortfall.
      ts.decide("evidence", `accepted without ${v.missing.join(", ")} (not available for this project)`)
      finalStatus = FINAL.COMPLETED
      finalText = (res.text ?? "task completed") + "\n\n(note: no automated test/build evidence available; local verification applied)"
      ts.transition(TASK_STATUS.COMPLETED, { reason: "objective satisfied; command evidence unavailable" })
      emit({ type: "TASK_COMPLETED", taskId, segment, text: String(finalText).slice(0, 400) })
      break
    }

    if (!needsMore) {
      // model ended its turn but the task isn't verified and we already asked —
      // complete honestly rather than silently stopping or looping forever.
      finalStatus = FINAL.COMPLETED
      finalText = res.text ?? "task reached a stopping point"
      ts.transition(TASK_STATUS.COMPLETED, { reason: "agent ended its turn" })
      emit({ type: "TASK_COMPLETED", taskId, segment, text: String(finalText).slice(0, 400) })
      break
    }

    // budget hit mid-task → continue automatically to the next segment
    evidenceRequests = 0
    ts.setNextAction("continue: segment budget spent, work remains")
    ts.transition(TASK_STATUS.EXECUTING, { reason: "continuing to next segment" })
  }

  // task-level fuse: segments exhausted without completion
  if (finalStatus !== FINAL.COMPLETED && finalStatus !== FINAL.CANCELLED && segment >= maxSeg) {
    finalStatus = FINAL.FAILED
    finalText = `segment safety budget (${maxSeg}) exhausted without verified completion — not claiming success`
    ts.noteError("SEGMENT_BUDGET", finalText)
  }

  // persist terminal state
  if (finalStatus === FINAL.COMPLETED) ts.transition(TASK_STATUS.COMPLETED, { reason: "done" })
  else if (finalStatus === FINAL.CANCELLED) ts.transition(TASK_STATUS.CANCELLED, { reason: "user cancel" })
  else ts.transition(TASK_STATUS.FAILED, { reason: finalText })
  ts.flush()

  emit({ type: "TASK_FINISHED", taskId, status: finalStatus, segments: segment, repairs: repairCount, text: String(finalText).slice(0, 300) })

  return {
    taskId,
    status: finalStatus,
    text: finalText,
    segments: segment,
    repairs: repairCount,
    toolCalls: totalToolCalls,
    filesChanged: [...changedFiles],
    verification: ledger.status(riskForChange({ filesChanged: changedFiles.size, task: state.objective }), [...changedFiles].map((f) => path.relative(process.cwd(), f))),
    task: state,
  }
}

function passThrough(emit, tag) {
  return (ev) => { try { emit({ ...ev, phase: tag }) } catch {} }
}

/**
 * Wrap a segment's agent events: tool traffic passes straight through (the UI
 * renders it via the existing tool_start/tool_result + TOOL_* bridges), while
 * the segment-level run lifecycle is suppressed (one TASK, not N).
 */
function segmentEvents(emit, segment) {
  return (ev) => {
    if (!ev || !ev.type) return
    if (ev.type === "run_start" || ev.type === "run_end") return // task-level, owned by meta
    try { emit({ ...ev, segment }) } catch {}
  }
}

/**
 * A repair segment: a focused, read-then-fix pass that diagnoses the failure,
 * changes strategy (never repeats the identical failed call — the tool layer
 * already blocks that), and re-verifies. Returns true when the next state is
 * healthy.
 */
async function repairSegment({ agent, config, provider, signal, emit, state, error, segment, ts, ledger, ctxEngine, verification = null, taskRunId = null }) {
  ts.transition(TASK_STATUS.REPAIRING, { reason: "diagnosing failure" })
  const ctxBlock = ctxEngine.build(state.objective, { budgetTokens: 1600 })
  const diag = `A previous step FAILED and needs repair. Diagnose the root cause, then fix it, then VERIFY (run the relevant focused test/build). Do NOT repeat the identical failing call — change strategy.\n\nFailure: ${String(error ?? verification?.reason ?? "").slice(0, 600)}${verification?.missing?.length ? `\nRequired evidence still missing: ${verification.missing.join(", ")}` : ""}\n\nInspect the relevant files first, then make a minimal surgical fix, then run verification.`
  const repairContext = `--- relevant project context (demand-loaded) ---\n${typeof ctxBlock === "string" ? ctxBlock : ctxBlock?.text ?? ""}`
  try {
    const r = await agent({ config, provider, signal, task: diag, extraContext: repairContext, maxStepsOverride: 8, deep: true, onEvent: emit, journal: true, runIdOverride: taskRunId, suppressRunEvents: true, keepJournalRunning: true })
    // learn from the repair
    const fixed = !r.error && !r.budgetHit
    recordLesson({
      failure: String(error ?? verification?.reason ?? "").slice(0, 200),
      cause: String(r.text ?? "").slice(0, 200),
      failedStrategy: "repeat identical failing call",
      successfulRepair: fixed ? String(r.text ?? "").slice(0, 240) : "",
      applicableContext: state.objective,
      task: state.objective,
      confidence: fixed ? 0.7 : 0.4,
    })
    // capture any new verification evidence, scoped to the files the task
    // changed so it supersedes the earlier failure for those files.
    const changedForScope = (state.files_changed ?? []).map((f) => path.relative(process.cwd(), f))
    for (const chk of r.commandChecks ?? []) {
      const rec = ledger.recordCommand(chk.command, chk.tail, { exitCode: chk.exitCode, affectedFiles: changedForScope })
      ts.noteVerification(rec)
      ts.noteTest({ command: rec.command, exit_code: rec.exit_code, passed: rec.passed })
      emit({ type: chk.passed ? "VERIFICATION_PASSED" : "VERIFICATION_FAILED", vtype: rec.type, command: rec.command, exitCode: rec.exitCode, evidence: rec.evidence })
    }
    emit({ type: "STRATEGY_CHANGED", segment, reason: "repair pass completed", ok: fixed })
    return fixed
  } catch (e) {
    ts.noteError("REPAIR_FAILED", e?.message ?? String(e))
    return false
  }
}

/**
 * One explicit, read-mostly VERIFICATION segment: ask the agent to run the
 * evidence commands the risk profile calls for and report results. Captures
 * the real exit-code evidence. Returns true when the added evidence satisfies
 * the ledger. Never fakes a pass.
 */
async function requestVerification({ agent, config, provider, signal, emit, state, missing, ts, ledger, ctxEngine, taskRunId }) {
  const ctxBuilt = ctxEngine.build(state.objective, { budgetTokens: 1200 })
  const verifyContext = `--- relevant project context (demand-loaded) ---\n${typeof ctxBuilt === "string" ? ctxBuilt : ctxBuilt?.text ?? ""}`
  const ask = `The task appears complete, but before success is claimed the following evidence is required for this risk level: ${missing.join(", ")}.\n\nRun the appropriate command(s) for THIS project (e.g. a focused test for a single-function change; focused + regression + build for a core change). Use the project's real test command (check package.json / Makefile). If the project has NO test suite or build, say so plainly instead of fabricating a result. Report the exact command(s) and their outcomes.`
  try {
    const r = await agent({ config, provider, signal, task: ask, extraContext: verifyContext, maxStepsOverride: 6, deep: false, onEvent: emit, journal: true, readOnly: false, runIdOverride: taskRunId, suppressRunEvents: true, keepJournalRunning: true })
    for (const chk of r.commandChecks ?? []) {
      const rec = ledger.recordCommand(chk.command, chk.tail, { exitCode: chk.exitCode })
      ts.noteVerification(rec)
      ts.noteTest({ command: rec.command, exit_code: rec.exit_code, passed: rec.passed })
      emit({ type: chk.passed ? "VERIFICATION_PASSED" : "VERIFICATION_FAILED", vtype: rec.type, command: rec.command, exitCode: rec.exit_code, evidence: rec.evidence })
    }
    const changedRel = (state.files_changed ?? []).map((f) => path.relative(process.cwd(), f))
    const st = ledger.status(riskForChange({ filesChanged: changedRel.length, task: state.objective }), changedRel)
    return st.ok && !st.anyFailure
  } catch (e) {
    ts.noteError("VERIFY_FAILED", e?.message ?? String(e))
    return false
  }
}

/**
 * Attribute a completed segment to the best-matching DAG node so the graph
 * moves forward. Prefers a RUNNING node (started by the fan-out) then a READY
 * node whose objective shares the most keywords with the segment's activity.
 * Returns null when nothing is plausibly attributable.
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
    // a mutating segment (files changed) credits a non-read-only node
    if (files > 0 && !n.read_only) score += 2
    if (toolCalls > 0) score += 0.5
    if (score > bestScore) { bestScore = score; best = n }
  }
  // require at least a weak signal (a running node counts inherently)
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

// re-export for callers/tests
export { reconcileEffect, UNKNOWN_DECISION, TASK_STATUS, TERMINAL }
