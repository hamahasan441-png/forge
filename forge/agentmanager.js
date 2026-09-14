/**
 * forge — agent manager (v21, hardened v24, zero dependencies)
 *
 * First-class manager for the worker pool. Before v21, sub-agents existed only
 * as the `delegate` tool inside tools.js (read-only researchers with a
 * concurrency cap). The DAG planner needs to SCHEDULE workers by role with
 * priorities, budgets, timeouts, pause/resume, cancellation and conflict
 * detection — that is what this owns.
 *
 * Design constraints:
 *  - Workers are created with a role and receive ONLY the context their task
 *    needs (scoped sub-task text, never the whole history).
 *  - Research / review / security / tester workers are READ-ONLY and may run
 *    concurrently (the DAG scheduler already separates them).
 *  - A worker that mutates is the MAIN agent — there is exactly one mutating
 *    execution context and it flows through the same Tool Intelligence +
 *    Security Gate as every other call. This module never spawns a second
 *    writer (two concurrent mutators would race SafePath-checked writes).
 *  - The actual model call is injected (`runner`) so this module is pure
 *    orchestration and trivially testable; the meta controller wires it to
 *    runAgent in agent.js.
 *
 * v24 P0 — worker timeout / orphan race.
 *
 *   Before: `withTimeout` raced the runner and simply STOPPED CARING. The
 *   controller saw `timed_out`, decremented `active`, and moved on — while the
 *   underlying agent kept running for as long as it liked, writing files,
 *   mutating the DAG and emitting events into the next segment. There was no
 *   per-worker cancellation token, so nothing could even ask it to stop.
 *
 *   Now every worker record carries:
 *     workerId, taskId, runId, segmentId, nodeId, status, cancellationToken,
 *     startedAt, finishedAt
 *   and a timeout runs the full protocol:
 *     REQUEST_CANCEL → WAIT_FOR_SHUTDOWN → CONFIRM_NOT_RUNNING → PERSIST
 *   `settle()` implements the same protocol for the whole pool, so the
 *   completion gate can prove "no worker is alive" before it allows COMPLETED.
 *   A worker that ignores cancellation is reported as an ORPHAN and stays
 *   counted as active — it blocks completion, it is never lied about.
 */

import { handoffContextBlock } from "./handoff.js"

export const ROLES = {
  RESEARCHER: "researcher",
  PLANNER: "planner",
  CODER: "coder",
  TESTER: "tester",
  REVIEWER: "reviewer",
  SECURITY: "security",
  DEBUGGER: "debugger",
  ARCHITECT: "architect",
  INTEGRATOR: "integrator",
  // v91 (∞ CORE §23): first-class specialist bench. Every role is read-only
  // except coder — the single-writer discipline is untouched.
  EXPLORER: "explorer",
  BUILD_ENGINEER: "build_engineer",
  PERFORMANCE_ENGINEER: "performance_engineer",
  DEPENDENCY_ANALYST: "dependency_analyst",
  DOC_ENGINEER: "doc_engineer",
  RELEASE_ENGINEER: "release_engineer",
  LANGUAGE_SPECIALIST: "language_specialist",
  RUNTIME_SPECIALIST: "runtime_specialist",
}

const READ_ONLY_ROLES = new Set([
  ROLES.RESEARCHER, ROLES.PLANNER, ROLES.REVIEWER, ROLES.SECURITY, ROLES.TESTER,
  ROLES.ARCHITECT, ROLES.INTEGRATOR, ROLES.EXPLORER, ROLES.BUILD_ENGINEER,
  ROLES.PERFORMANCE_ENGINEER, ROLES.DEPENDENCY_ANALYST, ROLES.DOC_ENGINEER,
  ROLES.RELEASE_ENGINEER, ROLES.LANGUAGE_SPECIALIST, ROLES.RUNTIME_SPECIALIST,
])

/** Dynamically registered specialist roles (§23 "dynamically creating future
 *  specialist roles"). Registered roles are read-only — mutation stays
 *  with the single coder/main context. */
const DYNAMIC_ROLES = new Map() // name → { readOnly, weight }

export function registerRole(name, { weight = 1, capabilities = [] } = {}) {
  const key = String(name ?? "").trim().toLowerCase()
  if (!key || /^[^a-z]/.test(key)) return false
  // dynamic roles are ALWAYS read-only: a future specialist may observe and
  // report, mutation stays with the single coder/main context — forever.
  DYNAMIC_ROLES.set(key, { readOnly: true, weight, capabilities })
  READ_ONLY_ROLES.add(key)
  return true
}

export function roleExists(name) {
  const key = String(name ?? "").trim().toLowerCase()
  return Boolean(Object.values(ROLES).includes(key) || DYNAMIC_ROLES.has(key))
}

/** Is a role permitted to mutate? Only the coder/main agent — and even that is
 *  funnelled through the single mutating context, never a parallel worker. */
export function roleIsReadOnly(role) {
  return READ_ONLY_ROLES.has(role)
}

const ROLE_CONFLICT_WEIGHT = {
  security: 4, reviewer: 3, integrator: 3, debugger: 3, architect: 2, planner: 2, tester: 2, coder: 2, researcher: 1,
  explorer: 1, build_engineer: 2, performance_engineer: 2, dependency_analyst: 1,
  doc_engineer: 1, release_engineer: 2, language_specialist: 2, runtime_specialist: 2,
}

export function roleCatalog() {
  const builtin = Object.values(ROLES).map((role) => ({ role, readOnly: roleIsReadOnly(role) }))
  const dynamic = [...DYNAMIC_ROLES.keys()].map((role) => ({ role, readOnly: roleIsReadOnly(role), dynamic: true }))
  return [...builtin, ...dynamic]
}

/** Worker lifecycle states. v93 gap fix: EXHAUSTED — the sub-agent spent its
 * step/tool budget (or hit a resource limit) without finishing. A worker
 * whose runner resolved but whose AGENT outcome is INCOMPLETE is NOT work
 * complete; it is a settled, classifiable, retryable state. */
export const WORKER_STATUS = {
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed_out",
  ORPHANED: "orphaned",
  EXHAUSTED: "exhausted",
}

const SETTLED = new Set([
  WORKER_STATUS.COMPLETED, WORKER_STATUS.FAILED,
  WORKER_STATUS.CANCELLED, WORKER_STATUS.TIMED_OUT, WORKER_STATUS.ORPHANED,
  WORKER_STATUS.EXHAUSTED,
])

/** How long to wait for a cancelled worker to actually stop before calling it
 *  an orphan (it stays counted as active either way — never silently). */
const DEFAULT_GRACE_MS = 5_000

export function createAgentManager({
  maxWorkers = 8,
  defaultTimeoutMs = 180_000,
  /** how many SETTLED worker records to keep for stats/audit (bounded) */
  maxRecords = 200,
  onEvent = null,
  runner = null,
  signal = null,
} = {}) {
  let seq = 0
  const workers = new Map() // id → record
  /** ids whose runner promise has NOT resolved yet — the truth for "alive". */
  const live = new Set()
  let active = 0
  let paused = false
  let totalBudgetMs = 0
  let usedBudgetMs = 0

  const emit = (ev) => { try { onEvent?.(ev) } catch { /* observability never breaks */ } }

  const now = () => Date.now()

  function setBudget(ms) { totalBudgetMs = Math.max(0, ms | 0) }
  function budgetRemaining() { return totalBudgetMs ? Math.max(0, totalBudgetMs - usedBudgetMs) : Infinity }

  /** Is any worker still alive (running, or queued behind a slot)? */
  function liveWorkers() {
    return [...workers.values()].filter((w) => !SETTLED.has(w.status) || live.has(w.id))
  }

  /**
   * Spawn a worker. Waits for a free concurrency slot unless `enqueue:false`.
   * @returns the worker record (with a .promise for its result).
   */
  function spawn({
    role = ROLES.RESEARCHER, task, context = "", priority = 0, dagNode = null,
    timeoutMs = defaultTimeoutMs, id = null,
    // P0 exact identity: who this worker belongs to, carried end-to-end.
    taskId = null, runId = null, segmentId = null, nodeId = null,
    // canonical conflict keys (file:/symbol:/dir:/resource:)
    targetFiles = null, targetSymbols = null, targetDirs = null, resourceLocks = null,
    // v96: optional per-batch concurrency gate (runMany) — internal, never serialized
    batchGate = null,
  } = {}) {
    const wid = id || `w${++seq}`
    if (!task) throw new Error("worker requires a task")
    const readOnly = roleIsReadOnly(role)
    // §32 — duplicate work prevention: is another live worker already on this
    // exact node / these exact files? The new worker still spawns (callers may
    // want deliberate redundancy) but the record is flagged and the TUI sees it.
    const dupe = findDuplicate({ nodeId: nodeId ?? dagNode, targetFiles, targetSymbols })
    const rec = {
      // --- P0 worker identity -------------------------------------------
      workerId: wid,
      id: wid,
      taskId, runId, segmentId,
      nodeId: nodeId ?? dagNode ?? null,
      targetFiles, targetSymbols, targetDirs, resourceLocks,
      // ------------------------------------------------------------------
      role, task: String(task).slice(0, 2000),
      context: String(context ?? "").slice(0, 4000),
      priority, dagNode, readOnly,
      status: WORKER_STATUS.QUEUED,
      result: null, error: null,
      startedAt: null, finishedAt: null, durationMs: 0,
      attempts: 0,
      cancellationToken: null, // AbortController — set when the worker starts
      cancelRequested: false,
      timedOut: false,
      orphaned: false,
      // --- v91 §25 sub-agent state --------------------------------------
      parentAgentId: null,       // set by reassign(); null = core-spawned
      model: null,               // specialist routing choice (crewroute)
      hypothesis: null,          // what this worker believes it will find/do
      confidence: null,          // self-reported + selfreview confidence
      evidenceRefs: [],          // ledger/verification ids this worker produced
      progress: "",              // last progress note
      resourceUsage: { toolCalls: 0, tokens: 0, ms: 0 },
      history: [],               // bounded state trail
      performanceHistory: [],    // bounded {ok, ms, verified} trail
      duplicateOf: dupe?.workerId ?? null,
      reassignmentCount: 0,
      batchGate, // per-batch gate (runMany maxParallel); harmless null otherwise
    }
    if (dupe) emit({ type: "WORKER_DUPLICATE", workerId: wid, duplicateOf: dupe.workerId, nodeId: rec.nodeId, reason: "same node/files already claimed by an active worker" })
    workers.set(wid, rec)
    rec.promise = runWhenReady(rec, timeoutMs)
    emit({ type: "WORKER_QUEUED", workerId: wid, id: wid, role, task: rec.task, priority, dagNode, nodeId: rec.nodeId, taskId, runId, segmentId, readOnly })
    return rec
  }

  async function runWhenReady(rec, timeoutMs) {
    // wait for a slot (and for resume if paused)
    while ((paused || active >= maxWorkers || rec.batchGate?.check() || (totalBudgetMs && usedBudgetMs >= totalBudgetMs)) && !isAborted()) {
      if (isAborted()) { rec.status = WORKER_STATUS.CANCELLED; rec.finishedAt = now(); return rec }
      await sleep(120)
    }
    if (isAborted() || rec.status === WORKER_STATUS.CANCELLED) {
      rec.status = WORKER_STATUS.CANCELLED
      rec.finishedAt = now()
      emit({ type: "WORKER_COMPLETED", workerId: rec.id, id: rec.id, role: rec.role, ok: false, cancelled: true, nodeId: rec.nodeId })
      return rec
    }

    // --- P0: per-worker cancellation token -------------------------------
    const ac = new AbortController()
    rec.cancellationToken = ac
    const onOuterAbort = () => ac.abort()
    if (signal) {
      if (signal.aborted) ac.abort()
      else signal.addEventListener?.("abort", onOuterAbort, { once: true })
    }

    rec.status = WORKER_STATUS.RUNNING
    rec.startedAt = now()
    rec.attempts++
    active++
    rec.batchGate?.enter() // v96: a runMany batch counts its own in-flight workers
    live.add(rec.id)
    emit({
      type: "WORKER_STARTED", workerId: rec.id, id: rec.id, role: rec.role, task: rec.task,
      dagNode: rec.dagNode, nodeId: rec.nodeId, taskId: rec.taskId, runId: rec.runId,
      segmentId: rec.segmentId, readOnly: rec.readOnly, activeWorkers: active,
    })

    const t0 = now()
    // This promise settles ONLY when the underlying runner does — that is the
    // difference between "the controller gave up" and "the worker stopped".
    const runnerPromise = (async () => {
      try {
        const result = await runOne(rec, ac.signal)
        return { ok: true, result }
      } catch (e) {
        return { ok: false, error: e }
      }
    })()
    rec._runner = runnerPromise
    const stopRunning = () => {
      live.delete(rec.id)
      rec.finishedAt = rec.finishedAt ?? now()
      active = Math.max(0, active - 1)
      rec.batchGate?.exit()
    }
    runnerPromise.then(stopRunning, stopRunning)

    let outcome
    try {
      const ms = budgetRemaining() === Infinity ? timeoutMs : Math.min(timeoutMs, budgetRemaining())
      outcome = await withTimeout(runnerPromise, ms)
    } catch (e) {
      // --- REQUEST_CANCEL -------------------------------------------------
      rec.cancelRequested = true
      try { ac.abort() } catch {}
      rec.timedOut = e?.name === "TimeoutError" || /timed out/i.test(String(e?.message ?? ""))
      emit({
        type: "WORKER_CANCEL_REQUESTED", workerId: rec.id, id: rec.id, role: rec.role,
        nodeId: rec.nodeId, reason: rec.timedOut ? `timed out after ${fmtSec(timeoutMs)}` : String(e?.message ?? e),
      })
      // --- WAIT_FOR_SHUTDOWN ---------------------------------------------
      await Promise.race([runnerPromise.catch(() => ({})), sleep(DEFAULT_GRACE_MS)])
      if (live.has(rec.id)) {
        // --- CONFIRM_NOT_RUNNING failed: report the orphan, never hide it --
        rec.orphaned = true
        emit({
          type: "WORKER_ORPHANED", workerId: rec.id, id: rec.id, role: rec.role, nodeId: rec.nodeId,
          taskId: rec.taskId, reason: "worker ignored cancellation and is still running",
        })
        outcome = null
      } else {
        // CONFIRM_NOT_RUNNING succeeded — but a timeout is still a timeout: a
        // result produced after the deadline must never be reported as success.
        outcome = rec.timedOut ? null : await runnerPromise
      }
      if (rec.timedOut) {
        rec.error = `worker timed out after ${fmtSec(timeoutMs)}${rec.orphaned ? " (orphaned: still running)" : ""}`
        rec.status = rec.orphaned ? WORKER_STATUS.ORPHANED : WORKER_STATUS.TIMED_OUT
        emit({
          type: "WORKER_COMPLETED", workerId: rec.id, id: rec.id, role: rec.role, ok: false,
          status: rec.status, error: rec.error, dagNode: rec.dagNode, nodeId: rec.nodeId, orphaned: rec.orphaned,
        })
        rec.durationMs = (rec.finishedAt ?? now()) - t0
        usedBudgetMs += rec.durationMs
        return rec
      }
    }

    try {
      if (outcome?.ok && !(rec.cancelRequested === true || ac.signal?.aborted === true)) {
        // v93 gap fix: the default runner returns the full agent result —
        // classify it. A resolved runner is NOT evidence of work complete.
        const res = outcome.result
        const resObj = res && typeof res === "object" ? res : null
        const text = String(resObj ? resObj.text : res ?? "").slice(0, 8000)
        const agentStatus = resObj ? String(resObj.status ?? "") : ""
        const agentBudgetHit = resObj?.budgetHit === true
        const exhausted = agentStatus === "INCOMPLETE" || agentBudgetHit
        rec.result = text
        rec.agentStatus = agentStatus || null
        rec.agentBudgetHit = agentBudgetHit
        if (exhausted) {
          // §3/§6: budget exhaustion is an execution control, not completion.
          // The worker is settled EXHAUSTED — meta classifies (retry/reassign/
          // continue/replan); it can never complete a DAG node like this.
          rec.status = WORKER_STATUS.EXHAUSTED
          rec.error = `sub-agent exhausted its budget without finishing (${agentStatus || "budget"})`
          emit({ type: "WORKER_COMPLETED", workerId: rec.id, id: rec.id, role: rec.role, ok: false, status: rec.status, error: rec.error, exhausted: true, agentStatus: agentStatus || null, report: rec.result.slice(0, 400), dagNode: rec.dagNode, nodeId: rec.nodeId })
        } else {
          rec.status = rec.orphaned ? WORKER_STATUS.ORPHANED : WORKER_STATUS.COMPLETED
          emit({ type: "WORKER_COMPLETED", workerId: rec.id, id: rec.id, role: rec.role, ok: true, agentStatus: agentStatus || null, report: rec.result.slice(0, 400), dagNode: rec.dagNode, nodeId: rec.nodeId })
        }
      } else if (outcome?.ok) {
        // cancelled (or the outer signal aborted) — a result produced after a
        // cancellation request is a partial, never a success
        const pr = outcome.result
        rec.partialResult = String(pr && typeof pr === "object" ? pr.text : pr ?? "").slice(0, 8000)
        rec.status = WORKER_STATUS.CANCELLED
        rec.error = rec.error ?? "cancelled before completion"
        emit({ type: "WORKER_COMPLETED", workerId: rec.id, id: rec.id, role: rec.role, ok: false, status: rec.status, cancelled: true, dagNode: rec.dagNode, nodeId: rec.nodeId })
      } else {
        const err = outcome?.error ?? new Error(rec.orphaned ? "worker orphaned" : "worker failed")
        rec.error = String(err?.message ?? err).slice(0, 400)
        if (rec.orphaned) rec.status = WORKER_STATUS.ORPHANED
        else if (err?.name === "AbortError" || ac.signal?.aborted || rec.status === WORKER_STATUS.CANCELLED) rec.status = WORKER_STATUS.CANCELLED
        else if (rec.timedOut || /timed out/i.test(rec.error)) rec.status = WORKER_STATUS.TIMED_OUT
        else rec.status = WORKER_STATUS.FAILED
        emit({ type: "WORKER_COMPLETED", workerId: rec.id, id: rec.id, role: rec.role, ok: false, status: rec.status, error: rec.error, dagNode: rec.dagNode, nodeId: rec.nodeId, orphaned: rec.orphaned })
      }
    } finally {
      rec.durationMs = (rec.finishedAt ?? now()) - t0
      usedBudgetMs += rec.durationMs
      signal?.removeEventListener?.("abort", onOuterAbort)
      reapSettled()
    }
    return rec
  }

  /** Controller-injected config/provider/runner for the default runner. */
  const ctx = { config: null, provider: null, runner: null }

  /** §32 — is an UNSETTLED worker already on this node / these files? */
  function findDuplicate({ nodeId = null, targetFiles = null, targetSymbols = null } = {}) {
    const files = new Set((targetFiles ?? []).filter(Boolean))
    const symbols = new Set((targetSymbols ?? []).filter(Boolean))
    for (const w of workers.values()) {
      if (SETTLED.has(w.status) && !live.has(w.id)) continue
      if (nodeId && w.nodeId && w.nodeId === nodeId) return w
      if (files.size && (w.targetFiles ?? []).some((f) => files.has(f))) return w
      if (symbols.size && (w.targetSymbols ?? []).some((s) => symbols.has(s))) return w
    }
    return null
  }

  /** §35 — reassign a failed/stuck worker: preserve state, classify, hand off,
   *  select an alternative specialist, transfer context. The original record
   *  is NEVER deleted — the new one links to it. */
  function reassign(id, { reason = "", newRole = null, handoff = null } = {}) {
    const old = workers.get(id)
    if (!old) return null
    // preserve state + evidence
    const context = [
      old.result ? `Previous worker's findings: ${old.result.slice(0, 1200)}` : "",
      old.result ? "" : `Previous worker produced no findings (status: ${old.status}${old.error ? `: ${old.error}` : ""})`,
      old.context,
    ].filter(Boolean).join("\n\n")
    if (!SETTLED.has(old.status) || live.has(id)) cancel(id)
    old.reassigned = true
    old.reassignmentCount = (old.reassignmentCount ?? 0) + 1
    const successor = spawn({
      role: newRole && roleExists(newRole) ? newRole : old.role,
      task: old.task,
      // v96 unifywise: the §30 structured handoff (remaining work, proven-
      // failed approaches, recommended next action, verification status) used
      // to be ledgered onto successor.handoff and then READ BY NOBODY — the
      // successor only saw the flattened findings text. The formatted
      // handoff block now travels INTO the successor's context ("build on it,
      // never repeat it"), so a reassigned worker actually inherits the
      // failed-approaches list instead of rediscovering it.
      context: handoff ? [context, handoffContextBlock(handoff)].filter(Boolean).join("\n\n") : context,
      priority: old.priority,
      dagNode: old.dagNode,
      taskId: old.taskId,
      runId: old.runId,
      segmentId: old.segmentId,
      nodeId: old.nodeId,
      targetFiles: old.targetFiles,
      targetSymbols: old.targetSymbols,
      targetDirs: old.targetDirs,
      resourceLocks: old.resourceLocks,
    })
    successor.parentAgentId = old.workerId
    successor.reassignment_reason = String(reason).slice(0, 300)
    successor.handoff = handoff ?? {
      from: old.workerId,
      to: successor.workerId,
      current_state: old.status,
      completed_work: old.result ? [old.result.slice(0, 300)] : [],
      failed_approaches: old.error ? [old.error.slice(0, 300)] : [],
      verification_status: "unknown",
    }
    old.history.push({ at: Date.now(), kind: "reassigned", to: successor.workerId, reason: String(reason).slice(0, 160) })
    emit({ type: "WORKER_REASSIGNED", from: old.workerId, to: successor.workerId, role: successor.role, nodeId: old.nodeId, reason: String(reason).slice(0, 200) })
    return successor
  }

  async function runOne(rec, workerSignal) {
    const run = ctx.runner || runner
    if (typeof run === "function") {
      return run({
        role: rec.role,
        task: rec.task,
        context: rec.context,
        readOnly: rec.readOnly,
        // the worker's own cancellation token wins over the outer one
        signal: workerSignal ?? signal,
        dagNode: rec.dagNode,
        nodeId: rec.nodeId,
        workerId: rec.workerId ?? rec.id,
        taskId: rec.taskId,
        runId: rec.runId,
        segmentId: rec.segmentId,
        // v91: the runner reports the model it actually used (§37 crew perf)
        setModel: (m) => { rec.model = m ? String(m).slice(0, 120) : rec.model },
      })
    }
    // default runner lazily loads the real sub-agent (read-only by role).
    // v93 gap fix: return the FULL agent result, not just r.text — the
    // worker's settlement must see the agent's real outcome (status/
    // budgetHit) or an exhausted sub-agent used to look like a completed
    // worker whose "findings" were the fabricated budget text.
    const { runAgent } = await import("./agent.js")
    const fullTask = rec.context ? `${rec.context}\n\nTASK: ${rec.task}` : rec.task
    const r = await runAgent({
      config: ctx.config, provider: ctx.provider, task: fullTask, onEvent: null,
      readOnly: rec.readOnly, maxStepsOverride: 12, role: rec.role,
      signal: workerSignal ?? signal, sub: rec.id,
      taskId: rec.taskId, runId: rec.runId, segmentId: rec.segmentId, nodeId: rec.nodeId,
    })
    return r
  }

  /** Allow the controller to inject config/provider for the default runner. */
  function configure({ config = null, provider = null, runner: r = null } = {}) {
    if (config !== null) ctx.config = config
    if (provider !== null) ctx.provider = provider
    if (r !== null) ctx.runner = r
  }

  /** Request cancellation of one worker. Never throws. */
  function cancel(id) {
    const rec = workers.get(id)
    if (!rec) return false
    if (SETTLED.has(rec.status) && !live.has(id)) return false
    rec.cancelRequested = true
    try { rec.cancellationToken?.abort() } catch {}
    if (rec.status === WORKER_STATUS.QUEUED) {
      rec.status = WORKER_STATUS.CANCELLED
      rec.finishedAt = now()
    }
    emit({ type: "WORKER_CANCELLED", workerId: id, id, role: rec.role, nodeId: rec.nodeId })
    return true
  }
  function cancelAll() { for (const id of workers.keys()) cancel(id) }

  /**
   * Bound the record map (P1). A long session spawns thousands of workers and
   * every settled record used to be kept forever. Settled records beyond the
   * cap are dropped oldest-first; LIVE/unsettled records are never removed.
   */
  function reapSettled() {
    try {
      if (workers.size <= maxRecords) return
      const settled = [...workers.values()]
        .filter((w) => SETTLED.has(w.status) && !live.has(w.id))
        .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
      let over = workers.size - maxRecords
      for (const rec of settled) {
        if (over-- <= 0) break
        workers.delete(rec.id)
      }
    } catch { }
  }

  /**
   * P0 — settle the whole pool before a mutation boundary or a completion.
   *
   *   REQUEST_CANCEL → WAIT_FOR_SHUTDOWN → CONFIRM_NOT_RUNNING
   *
   * @returns {{ settled: boolean, waited: number, stillRunning: string[], orphans: string[] }}
   */
  async function settle({ graceMs = DEFAULT_GRACE_MS, cancelRunning = false } = {}) {
    const unsettled = [...workers.values()].filter((w) => !SETTLED.has(w.status) || live.has(w.id))
    if (cancelRunning) for (const w of unsettled) cancel(w.id)
    const t0 = now()
    if (unsettled.length) {
      await Promise.race([
        Promise.allSettled(unsettled.map((w) => w.promise)),
        sleep(Math.max(0, graceMs)),
      ])
    }
    const still = [...workers.values()].filter((w) => live.has(w.id) || !SETTLED.has(w.status))
    const orphans = still.map((w) => {
      w.orphaned = true
      return w.id
    })
    if (orphans.length) {
      emit({ type: "WORKER_ORPHANED", workerIds: orphans, reason: "workers still running after settle() grace period" })
    }
    emit({ type: "WORKERS_SETTLED", settled: still.length === 0, stillRunning: still.length, workers: workers.size, ms: now() - t0 })
    return { settled: still.length === 0, waited: now() - t0, stillRunning: still.map((w) => w.id), orphans }
  }

  function pause() { paused = true; emit({ type: "WORKERS_PAUSED" }) }
  function resume() { paused = false; emit({ type: "WORKERS_RESUMED" }) }

  /**
   * Run a set of workers, respecting concurrency and role-based conflicts.
   * Read-only workers with non-overlapping focus run in parallel; the method
   * resolves once all settle (never throws — failures live on the records).
   */
  async function runMany(specs = [], { maxParallel = maxWorkers } = {}) {
    // v96 unifywise: maxParallel is now a REAL per-batch ceiling (it used to
    // be accepted and ignored — `void maxParallel`). The manager-level
    // maxWorkers ceiling still applies; a batch may additionally cap itself
    // lower. The gate counts only THIS batch's in-flight workers, so
    // concurrent spawns from other call sites are unaffected.
    const cap = Math.max(1, Math.min((Number(maxParallel) | 0) || maxWorkers, maxWorkers))
    let batchActive = 0
    const gate = { check: () => batchActive >= cap, enter: () => { batchActive++ }, exit: () => { batchActive = Math.max(0, batchActive - 1) } }
    const recs = specs.map((s) => spawn({ ...s, batchGate: gate }))
    const settled = await Promise.allSettled(recs.map((r) => r.promise))
    return recs.map((r, i) => (settled[i].status === "fulfilled" ? r : { ...r, status: WORKER_STATUS.FAILED, error: String(settled[i].reason) }))
  }

  /** Detect conflict between two proposed workers: two mutators, or two
   *  workers focused on the same file/area, never run together. */
  /** Canonical conflict keys for a worker (file:/symbol:/dir:/resource:). */
  function workerKeys(w) {
    const keys = []
    for (const f of w.targetFiles ?? []) if (f) keys.push(`file:${f}`)
    for (const sy of w.targetSymbols ?? []) if (sy) keys.push(`symbol:${sy}`)
    for (const d of w.targetDirs ?? []) if (d) keys.push(`dir:${d}`)
    for (const r of w.resourceLocks ?? []) if (r) keys.push(`resource:${r}`)
    if (!keys.length && (w.nodeId || w.dagNode)) keys.push(`node:${w.nodeId ?? w.dagNode}`)
    return keys.length ? [...new Set(keys)] : null
  }

  /**
   * Conflict test with canonical keys (P0). Falling back to the conservative
   * rule only when a worker carries NO key information at all.
   */
  function conflict(a, b) {
    if (!a || !b) return null
    const ka = workerKeys(a)
    const kb = workerKeys(b)
    const mutating = !a.readOnly || !b.readOnly
    if (ka && kb) {
      const overlap = ka.filter((k) => kb.includes(k))
      if (overlap.length) return { conflict: true, reason: `both workers hold ${overlap.join(", ")}` }
      // a lock inferred from the node id alone is the CONSERVATIVE default: it
      // proves nothing about what the node touches, so two mutators that only
      // have inferred locks never run together.
      const inferred = (k) => k.length === 1 && k[0].startsWith("node:")
      if (mutating && (inferred(ka) || inferred(kb))) {
        return { conflict: true, reason: "a mutating worker without explicit conflict keys runs alone" }
      }
      return null
    }
    if (mutating) return { conflict: true, reason: "a mutating worker without conflict keys cannot run concurrently" }
    const fa = focusFiles(a.task), fb = focusFiles(b.task)
    const overlap = fa.filter((f) => fb.includes(f))
    if (overlap.length) return { conflict: true, reason: `both workers target ${overlap.join(", ")}` }
    return null
  }

  function stats() {
    const s = {
      total: workers.size, active, queued: 0, completed: 0, failed: 0, cancelled: 0,
      timedOut: 0, orphaned: 0, byRole: {}, usedBudgetMs, maxWorkers, paused,
      live: live.size,
    }
    for (const w of workers.values()) {
      s[w.status] = (s[w.status] ?? 0) + 1
      s.byRole[w.role] = (s.byRole[w.role] ?? 0) + 1
    }
    return s
  }
  function list() { return [...workers.values()].map((w) => ({ ...w, promise: undefined, _runner: undefined, cancellationToken: undefined, batchGate: undefined })) }

  function isAborted() { return signal?.aborted }

  return {
    spawn, runMany, cancel, cancelAll, pause, resume, configure, conflict,
    stats, list, setBudget, budgetRemaining, settle, liveWorkers,
    WORKER_STATUS,
    setMaxWorkers(n) { maxWorkers = Math.max(1, n | 0) },
    roleWeight: (role) => ROLE_CONFLICT_WEIGHT[role] ?? DYNAMIC_ROLES.get(role)?.weight ?? 0,
    // v91 additions
    findDuplicate, reassign,
  }
}

function focusFiles(task) {
  const out = []
  for (const m of String(task ?? "").matchAll(/([\w./-]+\.(js|mjs|ts|tsx|py|go|rs|java|md|json))/g)) {
    out.push(m[1])
    if (out.length >= 8) break
  }
  return out
}

function withTimeout(p, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return p
  let t
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => {
      const e = new Error(`worker timed out after ${fmtSec(ms)}`)
      e.name = "TimeoutError"
      reject(e)
    }, ms)
    if (t.unref) t.unref()
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(t))
}

function fmtSec(ms) {
  const s = ms / 1000
  return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
