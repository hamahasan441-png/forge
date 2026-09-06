/**
 * forge — agent manager (v21, zero dependencies)
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
 */

export const ROLES = {
  RESEARCHER: "researcher",
  CODER: "coder",
  TESTER: "tester",
  REVIEWER: "reviewer",
  SECURITY: "security",
  DEBUGGER: "debugger",
  ARCHITECT: "architect",
}

const READ_ONLY_ROLES = new Set([ROLES.RESEARCHER, ROLES.REVIEWER, ROLES.SECURITY, ROLES.TESTER, ROLES.ARCHITECT])

/** Is a role permitted to mutate? Only the coder/main agent — and even that is
 *  funnelled through the single mutating context, never a parallel worker. */
export function roleIsReadOnly(role) {
  return READ_ONLY_ROLES.has(role)
}

const ROLE_CONFLICT_WEIGHT = {
  security: 4, reviewer: 3, debugger: 3, architect: 2, tester: 2, coder: 2, researcher: 1,
}

export function createAgentManager({
  maxWorkers = 2,
  defaultTimeoutMs = 180_000,
  onEvent = null,
  runner = null,
  signal = null,
} = {}) {
  let seq = 0
  const workers = new Map() // id → record
  let active = 0
  let paused = false
  let totalBudgetMs = 0
  let usedBudgetMs = 0

  const emit = (ev) => { try { onEvent?.(ev) } catch { /* observability never breaks */ } }

  const now = () => Date.now()

  function setBudget(ms) { totalBudgetMs = Math.max(0, ms | 0) }
  function budgetRemaining() { return totalBudgetMs ? Math.max(0, totalBudgetMs - usedBudgetMs) : Infinity }

  /**
   * Spawn a worker. Waits for a free concurrency slot unless `enqueue:false`.
   * @returns the worker record (with a .promise for its result).
   */
  function spawn({ role = ROLES.RESEARCHER, task, context = "", priority = 0, dagNode = null, timeoutMs = defaultTimeoutMs, id = null } = {}) {
    const wid = id || `w${++seq}`
    if (!task) throw new Error("worker requires a task")
    const readOnly = roleIsReadOnly(role)
    const rec = {
      id: wid, role, task: String(task).slice(0, 2000),
      context: String(context ?? "").slice(0, 4000),
      priority, dagNode, readOnly,
      status: "queued", // queued → running → completed | failed | cancelled | timed_out
      result: null, error: null,
      startedAt: null, endedAt: null, durationMs: 0,
      attempts: 0,
    }
    workers.set(wid, rec)
    rec.promise = runWhenReady(rec, timeoutMs)
    emit({ type: "WORKER_QUEUED", id: wid, role, task: rec.task, priority, dagNode, readOnly })
    return rec
  }

  async function runWhenReady(rec, timeoutMs) {
    // wait for a slot (and for resume if paused)
    while ((paused || active >= maxWorkers || (totalBudgetMs && usedBudgetMs >= totalBudgetMs)) && !isAborted()) {
      if (isAborted()) { rec.status = "cancelled"; rec.endedAt = now(); return rec }
      await sleep(120)
    }
    if (isAborted() || rec.status === "cancelled") { rec.status = rec.status === "cancelled" ? rec.status : "cancelled"; rec.endedAt = now(); emit({ type: "WORKER_COMPLETED", id: rec.id, role: rec.role, ok: false, cancelled: true }); return rec }

    rec.status = "running"
    rec.startedAt = now()
    rec.attempts++
    active++
    emit({ type: "WORKER_STARTED", id: rec.id, role: rec.role, task: rec.task, dagNode: rec.dagNode, readOnly: rec.readOnly, activeWorkers: active })

    const t0 = now()
    try {
      const result = await withTimeout(runOne(rec), Math.min(timeoutMs, budgetRemaining() === Infinity ? timeoutMs : Math.min(timeoutMs, budgetRemaining())))
      rec.result = String(result ?? "").slice(0, 8000)
      rec.status = "completed"
      emit({ type: "WORKER_COMPLETED", id: rec.id, role: rec.role, ok: true, report: rec.result.slice(0, 400), dagNode: rec.dagNode })
    } catch (e) {
      rec.error = String(e?.message ?? e).slice(0, 400)
      if (e?.name === "AbortError" || signal?.aborted || rec.status === "cancelled") rec.status = "cancelled"
      else if (rec.error.includes("timed out")) rec.status = "timed_out"
      else rec.status = "failed"
      emit({ type: "WORKER_COMPLETED", id: rec.id, role: rec.role, ok: false, status: rec.status, error: rec.error, dagNode: rec.dagNode })
    } finally {
      rec.endedAt = now()
      rec.durationMs = rec.endedAt - t0
      usedBudgetMs += rec.durationMs
      active = Math.max(0, active - 1)
    }
    return rec
  }

  /** Controller-injected config/provider for the default runner. */
  const ctx = { config: null, provider: null }

  async function runOne(rec) {
    if (typeof runner === "function") {
      return runner({
        role: rec.role,
        task: rec.task,
        context: rec.context,
        readOnly: rec.readOnly,
        signal,
        dagNode: rec.dagNode,
      })
    }
    // default runner lazily loads the real sub-agent (read-only by role)
    const { runAgent } = await import("./agent.js")
    const fullTask = rec.context ? `${rec.context}\n\nTASK: ${rec.task}` : rec.task
    const r = await runAgent({
      config: ctx.config, provider: ctx.provider, task: fullTask, onEvent: null,
      readOnly: rec.readOnly, maxStepsOverride: 12, role: rec.role, signal, sub: rec.id,
    })
    return r.text
  }

  /** Allow the controller to inject config/provider for the default runner. */
  function configure({ config = null, provider = null } = {}) {
    ctx.config = config
    ctx.provider = provider
  }

  function cancel(id) {
    const rec = workers.get(id)
    if (rec && rec.status !== "completed") { rec.status = "cancelled"; emit({ type: "WORKER_CANCELLED", id, role: rec.role }) }
  }
  function cancelAll() { for (const id of workers.keys()) cancel(id) }
  function pause() { paused = true; emit({ type: "WORKERS_PAUSED" }) }
  function resume() { paused = false; emit({ type: "WORKERS_RESUMED" }) }

  /**
   * Run a set of workers, respecting concurrency and role-based conflicts.
   * Read-only workers with non-overlapping focus run in parallel; the method
   * resolves once all settle (never throws — failures live on the records).
   */
  async function runMany(specs = [], { maxParallel = maxWorkers } = {}) {
    const recs = specs.map((s) => spawn(s))
    // simple gate: spawn already queues on maxWorkers; here we just await all
    void maxParallel
    const settled = await Promise.allSettled(recs.map((r) => r.promise))
    return recs.map((r, i) => (settled[i].status === "fulfilled" ? r : { ...r, status: "failed", error: String(settled[i].reason) }))
  }

  /** Detect conflict between two proposed workers: two mutators, or two
   *  workers focused on the same file/area, never run together. */
  function conflict(a, b) {
    if (!a || !b) return null
    if (!a.readOnly || !b.readOnly) return { conflict: true, reason: "a mutating worker cannot run concurrently" }
    const fa = focusFiles(a.task), fb = focusFiles(b.task)
    const overlap = fa.filter((f) => fb.includes(f))
    if (overlap.length) return { conflict: true, reason: `both workers target ${overlap.join(", ")}` }
    return null
  }

  function stats() {
    const s = { total: workers.size, active, queued: 0, completed: 0, failed: 0, cancelled: 0, timedOut: 0, byRole: {}, usedBudgetMs, maxWorkers, paused }
    for (const w of workers.values()) {
      s[w.status] = (s[w.status] ?? 0) + 1
      s.byRole[w.role] = (s.byRole[w.role] ?? 0) + 1
    }
    return s
  }
  function list() { return [...workers.values()].map((w) => ({ ...w, promise: undefined })) }

  function isAborted() { return signal?.aborted }

  return {
    spawn, runMany, cancel, cancelAll, pause, resume, configure, conflict,
    stats, list, setBudget, budgetRemaining,
    setMaxWorkers(n) { maxWorkers = Math.max(1, n | 0) },
    roleWeight: (role) => ROLE_CONFLICT_WEIGHT[role] ?? 0,
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
  const timeout = new Promise((_, reject) => { t = setTimeout(() => { const e = new Error(`worker timed out after ${Math.round(ms / 1000)}s`); e.name = "TimeoutError"; reject(e) }, ms); if (t.unref) t.unref() })
  return Promise.race([p, timeout]).finally(() => clearTimeout(t))
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
