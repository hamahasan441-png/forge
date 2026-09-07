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
import { createLedger, riskForChange, VERIFICATION_STATUS } from "./verifyledger.js"
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

const SEGMENT_STEPS = 12
const MAX_SEGMENTS_DEFAULT = 40

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

export async function runMeta({ config, provider, task, onEvent = null, signal = null, resumeTaskId = null, segmentSteps, maxSegments, runAgent = null, deep, workers = null } = {}) {
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
  const ctxEngine = createContextEngine({ cwd: process.cwd(), config })
  const manager = createAgentManager({
    maxWorkers: resources.state.maxWorkers,
    onEvent: emit,
    signal,
  })
  const provRef = { prov: provider }

  const agent = runAgent ?? (await import("./agent.js")).runAgent
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

  const segSteps = segmentSteps ?? config?.agent?.segmentSteps ?? SEGMENT_STEPS
  const maxSeg = maxSegments ?? config?.agent?.maxSegments ?? MAX_SEGMENTS_DEFAULT

  const sel = selectModel(config, { task: state.objective, provider })
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
  ts.transition(TASK_STATUS.PLANNING, { reason: "building plan" })
  emit({ type: "TASK_STARTED", taskId, runId: taskRunId, objective: state.objective, risk: riskLevel })

  let planText = ""
  let planDefs = []
  let planValidation = null
  try {
    const planRes = await agent({
      config, provider: prov, signal,
      task: `${state.objective}\n\nProduce a concise dependency-aware plan as a numbered list (one action per line). Mark read-only investigation steps and implementation steps. 4-8 steps. Do NOT execute.`,
      taskId, runId: taskRunId, segmentId: "seg-plan", nodeId: null,
      planOnly: true, readOnly: true, noTools: true, maxStepsOverride: 4, deep,
      onEvent: passThrough(emit, "plan"), suppressRunEvents: true,
    })
    planText = planRes?.text ?? ""
    planDefs = dagLib.parsePlanToDAG(planText)
    planValidation = dagLib.validatePlan(planDefs)
    if (!planValidation.ok) {
      if (planValidation.recoverable) {
        ts.transition(TASK_STATUS.REPAIRING, { reason: `plan validation failed: ${planValidation.errors.join("; ")}` })
        emit({ type: "PLAN_VALIDATION_FAILED", taskId, runId: taskRunId, errors: planValidation.errors, recoverable: true })
        ts.setNextAction(`repair: fix plan validation errors: ${planValidation.errors.join(", ")}`)
        // continue to execution with repaired plan if possible, else WAITING
        if (planValidation.code === "EMPTY_PLAN") {
          // fallback to single node plan
          planDefs = [{ id: "n1", objective: state.objective, dependencies: [], priority: 100, role: "coder", read_only: false }]
          planValidation = { ok: true, errors: [] }
        }
      } else {
        ts.transition(TASK_STATUS.WAITING, { reason: `unrecoverable plan validation: ${planValidation.errors.join("; ")}` })
        emit({ type: "PLAN_VALIDATION_FAILED", taskId, runId: taskRunId, errors: planValidation.errors, recoverable: false })
        ts.setNextAction(`wait: plan invalid and unrecoverable: ${planValidation.errors.join(", ")}`)
        // persist WAITING with critical durability
        try { ts.flush(DURABILITY.CRITICAL) } catch {}
        return {
          taskId,
          status: FINAL.WAITING,
          text: `plan validation failed and unrecoverable: ${planValidation.errors.join("; ")}`,
          segments: 0,
          repairs: 0,
          toolCalls: 0,
          filesChanged: [],
          verification: { ok: false, missing: [], reason: "plan invalid" },
          task: state,
        }
      }
    }
  } catch (e) {
    ts.noteError("PLAN_FAILED", e?.message ?? String(e))
    planValidation = { ok: false, errors: [String(e?.message ?? e)], recoverable: true, code: "PLAN_EXCEPTION" }
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
      try { ts.flush(DURABILITY.CRITICAL) } catch {}
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
  let consecutiveFailures = 0
  let repairCount = 0
  let evidenceRequests = 0
  let totalToolCalls = 0
  const changedFiles = new Set()

  ts.transition(TASK_STATUS.EXECUTING, { reason: "starting segments" })

  while (segment < maxSeg) {
    if (signal?.aborted) { finalStatus = explicitFinalization(FINAL.CANCELLED); break }

    segment++
    const segmentId = `seg-${segment}`
    const segStart = Date.now()

    // Exact DAG node identity: select next READY mutating node for main execution
    // Read-only nodes are handled via worker fan-out, not main execution
    let currentNodeId = null
    let currentNode = null
    if (dag) {
      try {
        const ready = dagLib.readyNodes(dag)
        const candidates = ready.filter(n => !n.read_only)
        const pick = candidates.length ? candidates[0] : null
        if (pick) {
          currentNodeId = pick.id
          currentNode = dagLib.executeNode(dag, currentNodeId, { taskId, runId: taskRunId, segmentId })
          if (currentNode) {
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

    const contextBuilt = ctxEngine.build(state.objective, { budgetTokens: 2200, precision: adaptation.limits.retrievalPrecision === "precise" ? "precise" : "normal" })
    const contextBlock = typeof contextBuilt === "string" ? contextBuilt : contextBuilt?.text ?? ""

    const knownBad = ineffectiveStrategies(state.objective, { cwd: process.cwd() })
    if (knownBad.length) emit({ type: "STRATEGY_CHANGED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, reason: `avoiding ${knownBad.length} previously-ineffective approach(es)`, avoided: knownBad.slice(0, 2).map((l) => l.failed_strategy || l.failed_action) })

    let dagFindings = ""
    if (dag && workersEnabled && !signal?.aborted) {
      try {
        const batch = dagLib.scheduleBatch(dag, { maxParallel: Math.max(1, resources.state.maxWorkers), conflictKeys: dagLib.canonicalConflictKeys })
          .filter((n) => n.read_only && n.role && n.role !== "coder" && n.id !== currentNodeId)
        if (batch.length) {
          emit({ type: "DAG_DISPATCH", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, nodes: batch.map((n) => n.id), parallel: batch.length })
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

    // Exact node identity: deterministic completion
    if (dag && currentNodeId) {
      try {
        if (res.error) dagLib.markFailed(dag, currentNodeId, String(res.error).slice(0, 200))
        else dagLib.markCompleted(dag, currentNodeId, `segment ${segment}: ${changedFiles.size} file(s), ${segToolCalls} tool call(s)`)
        persistDAG()
        ts.setLastOperation(`node:${currentNodeId} segment:${segment} files:${changedFiles.size} tools:${segToolCalls}`)
      } catch { }
    } else if (dag) {
      // Diagnostic fallback: attributeSegment only as diagnostic fallback (P0)
      try {
        const progress = { files: changedFiles.size, toolCalls: segToolCalls, text: String(res.text ?? "").slice(0, 800), segment }
        const segNode = attributeSegment(dag, progress)
        if (segNode) {
          emit({ type: "DAG_DIAGNOSTIC_ATTRIBUTION", taskId, runId: taskRunId, segmentId, nodeId: segNode.id, reason: "fallback heuristic used — primary is explicit nodeId" })
          if (res.error) dagLib.markFailed(dag, segNode.id, String(res.error).slice(0, 200))
          else dagLib.markCompleted(dag, segNode.id, `segment ${segment}: ${changedFiles.size} file(s), ${segToolCalls} tool call(s)`)
          persistDAG()
        }
      } catch { }
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
      })
      ts.noteVerification(rec)
      ts.noteTest({ command: rec.command, exit_code: rec.exit_code ?? rec.exitCode, passed: rec.passed })
      emit({ type: chk.passed ? "VERIFICATION_PASSED" : "VERIFICATION_FAILED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, vtype: rec.type, command: rec.command, exitCode: rec.exitCode ?? rec.exit_code, evidence: rec.evidence, verificationId: rec.verification_id })
    }

    const u = res.usage ?? {}
    const tokIn = u.prompt ?? u.prompt_tokens ?? u.input_tokens ?? u.promptTokens ?? 0
    const tokOut = u.completion ?? u.completion_tokens ?? u.output_tokens ?? u.completionTokens ?? 0
    resources.record({ tokensIn: tokIn, tokensOut: tokOut, toolCalls: segToolCalls, latencyMs: segMs, workers: manager.stats().active })
    const segStatus = res.error ? "failed" : res.budgetHit ? "continued" : "completed"
    ts.addSegment({ segment_id: segmentId, node_id: currentNodeId, objective: state.objective, status: segStatus, steps: res.steps ?? 0, tool_calls: segToolCalls, continued: !!res.budgetHit })
    ts.noteUsage({ tokens_in: tokIn, tokens_out: tokOut, tool_calls: segToolCalls, ms: segMs, workers: manager.stats().active })
    try { ts.flush(DURABILITY.CRITICAL) } catch {}

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
      const recovered = await repairSegment({ agent, config, provider: prov, signal, emit, state, error: res.error, segment, ts, ledger, ctxEngine, taskRunId, taskId, segmentId, nodeId: currentNodeId })
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
        }, process.cwd())
        if (consecutiveFailures >= 3) {
          finalStatus = explicitFinalization(FINAL.FAILED)
          finalText = `task failed after ${consecutiveFailures} consecutive failed segments: ${redact(String(res.error)).slice(0, 300)}`
          ts.noteError("GIVE_UP", finalText)
          break
        }
      }
      ts.transition(TASK_STATUS.EXECUTING, { reason: "after repair" })
      continue
    }
    consecutiveFailures = 0

    // --- VERIFICATION HARD GATE (P0) ---
    ts.transition(TASK_STATUS.VERIFYING, { reason: "post-segment verification" })
    const changedRel = [...changedFiles].map((f) => path.relative(process.cwd(), f))
    const v = ledger.status(riskNow, changedRel, { nodeId: currentNodeId })
    emit({ type: "VERIFICATION_STATUS", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, ok: v.ok, missing: v.missing, reason: v.reason, risk: riskNow, status: v.status })

    // VERIFICATION FAILED → REPAIRING (hard gate)
    if (v.anyFailure) {
      ts.transition(TASK_STATUS.REPAIRING, { reason: "verification failed" })
      emit({ type: "REPAIR_STARTED", taskId, runId: taskRunId, segment, segmentId, nodeId: currentNodeId, attempt: repairCount + 1, error: v.reason })
      const recovered = await repairSegment({ agent, config, provider: prov, signal, emit, state, error: v.reason, segment, ts, ledger, ctxEngine, verification: v, taskRunId, taskId, segmentId, nodeId: currentNodeId })
      repairCount += recovered ? 1 : 0
      ts.noteRepair(recovered ? 1 : 0)
      evidenceRequests = 0
      ts.transition(TASK_STATUS.EXECUTING, { reason: "after verification repair" })
      continue
    }

    const finished = !res.budgetHit
    const needsMore = res.budgetHit

    const noMutation = changedFiles.size === 0
    // NO VERIFICATION REQUIRED → COMPLETED (trivial/low with no mutation)
    const noVerificationRequired = noMutation || riskLevel === "trivial" || (riskLevel === "low" && changedFiles.size <= 1)

    let evidenceAdequate
    if (noVerificationRequired) evidenceAdequate = true
    else evidenceAdequate = v.ok

    const evidenceRequestedAlready = evidenceRequests >= 1

    // VERIFICATION PASSED → COMPLETED
    if (finished && evidenceAdequate) {
      finalStatus = explicitFinalization(FINAL.COMPLETED)
      finalText = res.text ?? "task completed"
      ts.transition(TASK_STATUS.COMPLETED, { reason: "objective satisfied and verified" })
      emit({ type: "TASK_COMPLETED", taskId, runId: taskRunId, segment, segmentId, nodeId: currentNodeId, text: String(finalText).slice(0, 400), verification: v.status })
      break
    }

    if (finished && !evidenceAdequate && !evidenceRequestedAlready) {
      evidenceRequests++
      ts.setNextAction(`verify: run ${v.missing.join(" / ")} before declaring success`)
      ts.transition(TASK_STATUS.VERIFYING, { reason: "requesting risk-proportional evidence" })
      emit({ type: "STRATEGY_CHANGED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, reason: `objective met but evidence is thin for risk=${riskNow} — run ${v.missing.join(", ")} to verify`, missing: v.missing })
      const verified = await requestVerification({ agent, config, provider: prov, signal, emit, state, missing: v.missing, ts, ledger, ctxEngine, taskRunId, taskId, segmentId, nodeId: currentNodeId })
      if (verified) {
        finalStatus = explicitFinalization(FINAL.COMPLETED)
        finalText = res.text ?? "task completed (verified)"
        ts.transition(TASK_STATUS.COMPLETED, { reason: "objective satisfied after explicit verification" })
        emit({ type: "TASK_COMPLETED", taskId, runId: taskRunId, segment, segmentId, nodeId: currentNodeId, text: String(finalText).slice(0, 400), verification: VERIFICATION_STATUS.PASSED })
        break
      }
      // HARD GATE: verification required but missing → WAITING (including medium, high, critical)
      // VERIFICATION UNAVAILABLE → WAITING, never bypass
      const requiresVerification = !noVerificationRequired
      if (requiresVerification && v.missing.length > 0) {
        finalStatus = explicitFinalization(FINAL.WAITING)
        finalText = `verification evidence missing for risk=${riskLevel}: ${v.missing.join(", ")}. Not completing until verified (hard gate).`
        ts.transition(TASK_STATUS.WAITING, { reason: `hard gate: required verification missing for risk=${riskLevel}` })
        emit({ type: "TASK_BLOCKED", taskId, runId: taskRunId, segment, segmentId, nodeId: currentNodeId, missing: v.missing, risk: riskNow, status: VERIFICATION_STATUS.PENDING })
        ts.setNextAction(`wait: provide ${v.missing.join(", ")} before declaring success (risk=${riskLevel})`)
        try { ts.flush(DURABILITY.CRITICAL) } catch {}
        break
      }
      // If not requiresVerification but still missing, we already handled above, but fallback to WAITING not COMPLETED
      finalStatus = explicitFinalization(FINAL.WAITING)
      finalText = `verification pending: ${v.missing.join(", ")}`
      ts.transition(TASK_STATUS.WAITING, { reason: "verification pending" })
      emit({ type: "TASK_BLOCKED", taskId, runId: taskRunId, segment, segmentId, nodeId: currentNodeId, missing: v.missing, risk: riskNow })
      try { ts.flush(DURABILITY.CRITICAL) } catch {}
      break
    }

    if (finished && !evidenceAdequate && evidenceRequestedAlready) {
      // Already asked for verification, still missing → WAITING (hard gate, never COMPLETED)
      finalStatus = explicitFinalization(FINAL.WAITING)
      finalText = `verification required but missing after explicit request: ${v.missing.join(", ")} for risk=${riskLevel} — waiting for evidence`
      ts.transition(TASK_STATUS.WAITING, { reason: `hard gate: verification still missing after request: ${v.missing.join(", ")}` })
      emit({ type: "TASK_BLOCKED", taskId, runId: taskRunId, segment, segmentId, nodeId: currentNodeId, missing: v.missing, risk: riskNow, status: VERIFICATION_STATUS.PENDING })
      ts.setNextAction(`wait: verification still missing: ${v.missing.join(", ")}`)
      try { ts.flush(DURABILITY.CRITICAL) } catch {}
      break
    }

    if (!needsMore) {
      // P0: NEVER allow "agent ended its turn → COMPLETED" without verification
      // If we reach here, it means budget not hit but we didn't complete via verified path
      // This should be WAITING, not COMPLETED
      finalStatus = explicitFinalization(FINAL.WAITING)
      finalText = `agent ended its turn without verified completion — waiting (risk=${riskNow}, missing=${v.missing.join(", ")})`
      ts.transition(TASK_STATUS.WAITING, { reason: "agent ended turn without verification — hard gate blocks COMPLETED" })
      emit({ type: "TASK_BLOCKED", taskId, runId: taskRunId, segment, segmentId, nodeId: currentNodeId, reason: "agent ended its turn without verified completion", risk: riskNow, missing: v.missing })
      try { ts.flush(DURABILITY.CRITICAL) } catch {}
      break
    }

    evidenceRequests = 0
    ts.setNextAction("continue: segment budget spent, work remains")
    ts.transition(TASK_STATUS.EXECUTING, { reason: "continuing to next segment" })
  }

  // P0 segment safety fuse: maxSegments is safety, not failure definition
  // When segment budget is reached: CHECKPOINT → PERSIST → WAITING / CONTINUE_REQUIRED → RESUME LATER
  // Do not automatically mark FAILED merely because safety budget exhausted
  if (finalStatus !== FINAL.COMPLETED && finalStatus !== FINAL.CANCELLED && segment >= maxSeg) {
    // Checkpoint before going to WAITING
    try {
      const cwd = process.cwd()
      const touched = [...changedFiles].filter((f) => { try { return fs.existsSync(f) } catch { return false } })
      const cpId = touched.length
        ? snapshotBefore(touched, cwd, [], taskRunId)
        : boundaryCheckpoint(cwd, { runId: taskRunId, label: `safety-fuse-${segment}`, objective: state.objective })
      if (cpId) ts.noteCheckpoint(cpId)
      emit({ type: "CHECKPOINT_CREATED", taskId, runId: taskRunId, boundary: "safety-fuse", segment, checkpointId: cpId })
    } catch {}
    finalStatus = explicitFinalization(FINAL.WAITING)
    finalText = `segment safety budget (${maxSeg}) reached — checkpointed and waiting for resume (CONTINUE_REQUIRED), not FAILED`
    ts.transition(TASK_STATUS.WAITING, { reason: `safety fuse: ${maxSeg} segments reached — CONTINUE_REQUIRED` })
    ts.setNextAction(`continue_required: safety budget ${maxSeg} reached — resume later`)
    try { ts.flush(DURABILITY.CRITICAL) } catch {}
    ts.noteError("SEGMENT_BUDGET_CONTINUE", finalText)
  }

  // P0 explicit finalization: preserve actual terminal state
  // COMPLETED → COMPLETED, FAILED → FAILED, WAITING → WAITING, CANCELLED → CANCELLED
  // Never silently convert WAITING into FAILED
  if (finalStatus === FINAL.COMPLETED) ts.transition(TASK_STATUS.COMPLETED, { reason: "done", durability: DURABILITY.CRITICAL })
  else if (finalStatus === FINAL.FAILED) ts.transition(TASK_STATUS.FAILED, { reason: finalText, durability: DURABILITY.CRITICAL })
  else if (finalStatus === FINAL.WAITING) ts.transition(TASK_STATUS.WAITING, { reason: finalText, durability: DURABILITY.CRITICAL })
  else if (finalStatus === FINAL.CANCELLED) ts.transition(TASK_STATUS.CANCELLED, { reason: "user cancel", durability: DURABILITY.CRITICAL })
  else ts.transition(TASK_STATUS.FAILED, { reason: finalText, durability: DURABILITY.CRITICAL })

  try { ts.flush(DURABILITY.CRITICAL) } catch (e) {
    // Critical persistence failure must be reported, not swallowed
    emit({ type: "CRITICAL_PERSISTENCE_FAILED", taskId, runId: taskRunId, error: String(e?.message ?? e) })
  }

  emit({ type: "TASK_FINISHED", taskId, runId: taskRunId, status: finalStatus, segments: segment, repairs: repairCount, text: String(finalText).slice(0, 300) })

  return {
    taskId,
    runId: taskRunId,
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

function segmentEvents(emit, segment, ids = {}) {
  return (ev) => {
    if (!ev || !ev.type) return
    if (ev.type === "run_start" || ev.type === "run_end") return
    try { emit({ ...ids, ...ev, segment }) } catch {}
  }
}

async function repairSegment({ agent, config, provider, signal, emit, state, error, segment, ts, ledger, ctxEngine, verification = null, taskRunId = null, taskId = null, segmentId = null, nodeId = null }) {
  ts.transition(TASK_STATUS.REPAIRING, { reason: "diagnosing failure" })
  const ctxBlock = ctxEngine.build(state.objective, { budgetTokens: 1600 })
  const diag = `A previous step FAILED and needs repair. Diagnose the root cause, then fix it, then VERIFY (run the relevant focused test/build). Do NOT repeat the identical failing call — change strategy.\n\nFailure: ${String(error ?? verification?.reason ?? "").slice(0, 600)}${verification?.missing?.length ? `\nRequired evidence still missing: ${verification.missing.join(", ")}` : ""}\n\nInspect the relevant files first, then make a minimal surgical fix, then run verification.`
  const repairContext = `--- relevant project context (demand-loaded) ---\n${typeof ctxBlock === "string" ? ctxBlock : ctxBlock?.text ?? ""}`
  try {
    const r = await agent({ config, provider, signal, task: diag, taskId, runId: taskRunId, segmentId, nodeId, extraContext: repairContext, maxStepsOverride: 8, deep: true, onEvent: emit, journal: true, runIdOverride: taskRunId, suppressRunEvents: true, keepJournalRunning: true })
    const fixed = !r.error && !r.budgetHit
    recordLesson({
      failure: String(error ?? verification?.reason ?? "").slice(0, 200),
      cause: String(r.text ?? "").slice(0, 200),
      failedStrategy: "repeat identical failing call",
      successfulRepair: fixed ? String(r.text ?? "").slice(0, 240) : "",
      applicableContext: state.objective,
      task: state.objective,
      confidence: fixed ? 0.7 : 0.4,
    }, process.cwd())
    const changedForScope = (state.files_changed ?? []).map((f) => path.relative(process.cwd(), f))
    for (const chk of r.commandChecks ?? []) {
      const rec = ledger.recordCommand(chk.command, chk.tail, { exitCode: chk.exitCode, affectedFiles: changedForScope, taskId, nodeId, segmentId, verificationEpoch: state.verification_epoch ?? 0 })
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

async function requestVerification({ agent, config, provider, signal, emit, state, missing, ts, ledger, ctxEngine, taskRunId, taskId = null, segmentId = null, nodeId = null }) {
  const ctxBuilt = ctxEngine.build(state.objective, { budgetTokens: 1200 })
  const verifyContext = `--- relevant project context (demand-loaded) ---\n${typeof ctxBuilt === "string" ? ctxBuilt : ctxBuilt?.text ?? ""}`
  const ask = `The task appears complete, but before success is claimed the following evidence is required for this risk level: ${missing.join(", ")}.\n\nRun the appropriate command(s) for THIS project (e.g. a focused test for a single-function change; focused + regression + build for a core change). Use the project's real test command (check package.json / Makefile). If the project has NO test suite or build, say so plainly instead of fabricating a result. Report the exact command(s) and their outcomes.`
  try {
    const r = await agent({ config, provider, signal, task: ask, taskId, runId: taskRunId, segmentId, nodeId, extraContext: verifyContext, maxStepsOverride: 6, deep: false, onEvent: emit, journal: true, readOnly: false, runIdOverride: taskRunId, suppressRunEvents: true, keepJournalRunning: true })
    for (const chk of r.commandChecks ?? []) {
      const rec = ledger.recordCommand(chk.command, chk.tail, { exitCode: chk.exitCode, taskId, nodeId, segmentId, verificationEpoch: state.verification_epoch ?? 0 })
      ts.noteVerification(rec)
      ts.noteTest({ command: rec.command, exit_code: rec.exit_code ?? rec.exitCode, passed: rec.passed })
      emit({ type: chk.passed ? "VERIFICATION_PASSED" : "VERIFICATION_FAILED", taskId, runId: taskRunId, segmentId, nodeId, vtype: rec.type, command: rec.command, exitCode: rec.exit_code ?? rec.exitCode, evidence: rec.evidence, verificationId: rec.verification_id })
    }
    const changedRel = (state.files_changed ?? []).map((f) => path.relative(process.cwd(), f))
    const st = ledger.status(riskForChange({ filesChanged: changedRel.length, task: state.objective }), changedRel, { nodeId })
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
