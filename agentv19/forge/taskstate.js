/**
 * forge — task state engine (v21 hardened, zero dependencies)
 *
 * ONE authoritative, persistent record of where an autonomous task is.
 * Before v21 the closest thing was the run journal (runlog.js): a crash-safe
 * list of tools and touched files, but it had no notion of task lifecycle,
 * segments, DAG, verification evidence or repair history.
 *
 * This module owns the lifecycle. The journal remains the low-level tool/
 * file record; taskstate.js is the state machine on top of it:
 *
 *   ~/.forge/tasks/<taskId>.json
 *
 * States and explicit transition graph make impossible transitions throw
 * instead of silently corrupting state.
 *
 * Hardening:
 *  - durability classes UI/NORMAL/CRITICAL with atomic persistence + fsync
 *  - critical persistence failures are explicitly reported, never swallowed
 *  - explicit finalization preserves COMPLETED/FAILED/WAITING/CANCELLED
 *  - exact crash/resume fields: taskId, runId, nodeId, segmentId, checkpointId,
 *    verificationEpoch, last completed operation, recovery state, DAG state
 */
import fs from "node:fs"
import path from "node:path"
import { DEFAULT_DIR } from "./config.js"

export const TASKS_DIR = path.join(DEFAULT_DIR, "tasks")
const MAX_TASKS = 200
const MAX_STEPS = 2000
const MAX_ERRORS = 100
const MAX_DECISIONS = 200
const MAX_FILES = 500

/** Lifecycle states. */
export const TASK_STATUS = {
  IDLE: "IDLE",
  PLANNING: "PLANNING",
  DISCOVERING: "DISCOVERING",
  EXECUTING: "EXECUTING",
  VERIFYING: "VERIFYING",
  REPAIRING: "REPAIRING",
  CHECKPOINTING: "CHECKPOINTING",
  WAITING: "WAITING",
  RECOVERING: "RECOVERING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
}

/** Terminal states — once here a task never moves. */
export const TERMINAL = new Set([TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED])

/** Final statuses that must be preserved verbatim (directive P0). */
export const FINAL_STATUSES = new Set([TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.WAITING, TASK_STATUS.CANCELLED])

/** Durability classes (P1). */
export const DURABILITY = {
  UI: "UI",           // best effort
  NORMAL: "NORMAL",   // atomic persistence
  CRITICAL: "CRITICAL", // atomic + fsync + explicit failure reporting
}

/** Critical events that must use CRITICAL durability. */
const CRITICAL_EVENTS = new Set([
  TASK_STATUS.CHECKPOINTING,
  TASK_STATUS.WAITING,
  TASK_STATUS.RECOVERING,
  TASK_STATUS.COMPLETED,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELLED,
])

export const TRANSITIONS = {
  IDLE: new Set(["PLANNING", "DISCOVERING", "EXECUTING", "WAITING", "CANCELLED", "FAILED"]),
  PLANNING: new Set(["DISCOVERING", "EXECUTING", "WAITING", "FAILED", "CANCELLED", "PLANNING"]),
  DISCOVERING: new Set(["PLANNING", "EXECUTING", "VERIFYING", "WAITING", "FAILED", "CANCELLED", "DISCOVERING"]),
  EXECUTING: new Set(["VERIFYING", "REPAIRING", "CHECKPOINTING", "WAITING", "RECOVERING", "DISCOVERING", "PLANNING", "COMPLETED", "FAILED", "CANCELLED", "EXECUTING"]),
  VERIFYING: new Set(["EXECUTING", "REPAIRING", "CHECKPOINTING", "COMPLETED", "FAILED", "WAITING", "CANCELLED", "VERIFYING"]),
  REPAIRING: new Set(["EXECUTING", "VERIFYING", "CHECKPOINTING", "FAILED", "WAITING", "CANCELLED", "REPAIRING"]),
  CHECKPOINTING: new Set(["EXECUTING", "VERIFYING", "REPAIRING", "WAITING", "RECOVERING", "COMPLETED", "FAILED", "CANCELLED"]),
  WAITING: new Set(["EXECUTING", "PLANNING", "DISCOVERING", "RECOVERING", "CANCELLED", "FAILED", "COMPLETED", "WAITING"]),
  RECOVERING: new Set(["EXECUTING", "PLANNING", "DISCOVERING", "WAITING", "FAILED", "CANCELLED", "RECOVERING"]),
  COMPLETED: new Set([]),
  FAILED: new Set([]),
  CANCELLED: new Set([]),
}

export function canTransition(from, to) {
  if (from === to) return true
  return Boolean(TRANSITIONS[from]?.has(to))
}

export function taskFile(taskId) {
  return path.join(TASKS_DIR, String(taskId).replace(/[^A-Za-z0-9._-]/g, "_") + ".json")
}

function writeAtomic(file, obj, { durability = DURABILITY.NORMAL, syncDir = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + ".tmp-" + Math.random().toString(36).slice(2, 6)
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 })
    if (durability === DURABILITY.CRITICAL) {
      // durable flush: fsync file then rename then fsync dir where supported
      try {
        const fd = fs.openSync(tmp, "r+")
        try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      } catch {}
    }
    fs.renameSync(tmp, file)
    if (durability === DURABILITY.CRITICAL && syncDir) {
      try {
        const dirFd = fs.openSync(path.dirname(file), "r")
        try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
      } catch {}
    }
    return { ok: true }
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch {}
    if (durability === DURABILITY.CRITICAL) {
      // explicit failure reporting for critical events
      throw e
    }
    return { ok: false, error: e }
  }
}

export function blankTask({ taskId, runId = null, objective = "", cwd = process.cwd() } = {}) {
  const now = Date.now()
  return {
    task_id: taskId,
    run_id: runId,
    objective: String(objective ?? "").slice(0, 2000),
    status: TASK_STATUS.IDLE,
    cwd: path.resolve(cwd),
    plan: null,
    dag: null,
    // exact crash/resume fields (P1)
    node_id: null,
    segment_id: null,
    checkpoint_id: null,
    verification_epoch: 0,
    last_completed_operation: null,
    recovery_state: null,
    // bounded summaries
    segments: [],
    completed_steps: [],
    current_step: null,
    pending_steps: [],
    files_changed: [],
    files_created: [],
    tests_run: [],
    verification_results: [],
    errors: [],
    decisions: [],
    model_used: null,
    provider_used: null,
    model_history: [],
    checkpoints: [],
    resource_usage: { tokens_in: 0, tokens_out: 0, tool_calls: 0, segments: 0, ms: 0, workers: 0, retries: 0 },
    retry_count: 0,
    repair_count: 0,
    segment_count: 0,
    // P0 segment safety fuse: how many times this task has been RESUMED after
    // hitting the safety budget. "Continuation" is not failure — but it must be
    // bounded, so a task that never converges eventually fails instead of
    // looping through the fuse forever.
    continuation_count: 0,
    next_action: null,
    waiting_reason: null,
    pid: process.pid,
    created_at: now,
    updated_at: now,
    started_at: null,
    ended_at: null,
  }
}

/**
 * Explicit finalization mapping (P0): preserves terminal states verbatim.
 * COMPLETED → COMPLETED, FAILED → FAILED, WAITING → WAITING, CANCELLED → CANCELLED
 * Never silently convert WAITING into FAILED.
 */
export function finalizeStatus(current, desired) {
  if (!FINAL_STATUSES.has(desired)) return current
  // WAITING must be preserved, never converted to FAILED
  if (desired === TASK_STATUS.WAITING) return TASK_STATUS.WAITING
  if (desired === TASK_STATUS.COMPLETED) return TASK_STATUS.COMPLETED
  if (desired === TASK_STATUS.FAILED) return TASK_STATUS.FAILED
  if (desired === TASK_STATUS.CANCELLED) return TASK_STATUS.CANCELLED
  return current
}

export function openTask(taskId, { create = true, runId = null, objective = "", cwd = process.cwd() } = {}) {
  const file = taskFile(taskId)
  let rec = null
  try {
    rec = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    if (!create) return null
    rec = blankTask({ taskId, runId, objective, cwd })
  }
  let dirty = false
  let timer = null
  let lastFlushError = null

  const save = (durability = DURABILITY.NORMAL) => {
    try {
      rec.updated_at = Date.now()
      const res = writeAtomic(file, rec, { durability, syncDir: durability === DURABILITY.CRITICAL })
      if (!res.ok && durability === DURABILITY.CRITICAL) throw res.error
      dirty = false
      lastFlushError = null
      return { ok: true }
    } catch (e) {
      lastFlushError = e
      if (durability === DURABILITY.CRITICAL) {
        // critical persistence failure must be reported, not swallowed
        console.error(`[taskstate] CRITICAL persistence failure for ${taskId}: ${e.message}`)
        throw e
      }
      return { ok: false, error: e }
    }
  }

  const schedule = (durability = DURABILITY.NORMAL) => {
    if (durability === DURABILITY.CRITICAL) {
      // critical: immediate flush, not debounced
      return save(DURABILITY.CRITICAL)
    }
    dirty = true
    if (timer) return { ok: true, scheduled: true }
    timer = setTimeout(() => { timer = null; if (dirty) save(DURABILITY.NORMAL) }, 120)
    if (typeof timer.unref === "function") timer.unref()
    return { ok: true, scheduled: true }
  }

  const push = (arr, item, cap) => {
    arr.push(item)
    if (arr.length > cap) arr.splice(0, arr.length - cap)
  }

  const api = {
    file,
    get record() { return rec },
    get status() { return rec.status },
    get lastError() { return lastFlushError },

    transition(to, { reason = "", durability } = {}) {
      const from = rec.status
      if (to === from) { schedule(durability ?? (CRITICAL_EVENTS.has(to) ? DURABILITY.CRITICAL : DURABILITY.NORMAL)); return true }
      if (TERMINAL.has(from)) return false
      if (!canTransition(from, to)) {
        push(rec.errors, { at: Date.now(), code: "INVALID_TRANSITION", detail: `${from} → ${to} (${String(reason).slice(0, 120)})` }, MAX_ERRORS)
        schedule(DURABILITY.NORMAL)
        return false
      }
      rec.status = to
      if (to === TASK_STATUS.WAITING) rec.waiting_reason = reason || null
      else rec.waiting_reason = null
      push(rec.decisions, { at: Date.now(), kind: "state", detail: `${from} → ${to}${reason ? `: ${String(reason).slice(0, 160)}` : ""}` }, MAX_DECISIONS)
      if (rec.started_at == null && to !== TASK_STATUS.IDLE) rec.started_at = Date.now()
      if (TERMINAL.has(to) || to === TASK_STATUS.WAITING) {
        // WAITING is not terminal in taskstate but needs ended_at for durability tracking
        if (TERMINAL.has(to)) rec.ended_at = Date.now()
      }
      const dur = durability ?? (CRITICAL_EVENTS.has(to) ? DURABILITY.CRITICAL : DURABILITY.NORMAL)
      if (dur === DURABILITY.CRITICAL) {
        try { save(DURABILITY.CRITICAL) } catch (e) { return false }
      } else {
        schedule(dur)
      }
      return true
    },

    /** Explicit finalization preserving actual terminal state (P0). */
    finalize(desiredStatus, { reason = "" } = {}) {
      const final = finalizeStatus(rec.status, desiredStatus)
      if (final === rec.status) return true
      if (TERMINAL.has(rec.status)) return false
      rec.status = final
      if (final === TASK_STATUS.WAITING) rec.waiting_reason = reason || rec.waiting_reason || "explicit finalization"
      else rec.waiting_reason = null
      push(rec.decisions, { at: Date.now(), kind: "finalize", detail: `finalized → ${final}${reason ? `: ${String(reason).slice(0, 160)}` : ""}` }, MAX_DECISIONS)
      if (TERMINAL.has(final)) rec.ended_at = Date.now()
      try { save(DURABILITY.CRITICAL) } catch (e) { return false }
      return true
    },

    setPlan(plan, source = "model") {
      rec.plan = { steps: Array.isArray(plan) ? plan.slice(0, MAX_STEPS) : plan, source, at: Date.now() }
      if (Array.isArray(plan)) {
        rec.pending_steps = plan.map((_, i) => i)
        rec.completed_steps = []
      }
      schedule()
    },

    setDAG(dag) { rec.dag = dag; schedule() },

    setNodeId(nodeId) { rec.node_id = nodeId ?? null; schedule() },
    setSegmentId(segmentId) { rec.segment_id = segmentId ?? null; schedule() },
    setCheckpointId(checkpointId) { rec.checkpoint_id = checkpointId ?? rec.checkpoint_id; schedule() },
    setVerificationEpoch(epoch) { rec.verification_epoch = Number(epoch) || 0; schedule() },
    setLastOperation(op) { rec.last_completed_operation = op ?? null; schedule(DURABILITY.CRITICAL) },
    setRecoveryState(st) { rec.recovery_state = st ?? null; schedule(DURABILITY.CRITICAL) },

    addSegment(seg) {
      rec.segment_count = (rec.segment_count ?? 0) + 1
      rec.resource_usage.segments = rec.segment_count
      const s = {
        segment_id: seg.segment_id ?? `seg-${rec.segment_count}`,
        node_id: seg.node_id ?? rec.node_id ?? null,
        objective: String(seg.objective ?? "").slice(0, 300),
        status: seg.status ?? "completed",
        steps: seg.steps ?? 0,
        tool_calls: seg.tool_calls ?? 0,
        continued: seg.continued ?? false,
        at: Date.now(),
      }
      push(rec.segments, s, 60)
      rec.segment_id = s.segment_id
      if (s.node_id) rec.node_id = s.node_id
      schedule()
      return s
    },

    stepComplete(index, note = "") {
      if (!rec.completed_steps.includes(index)) rec.completed_steps.push(index)
      rec.pending_steps = rec.pending_steps.filter((i) => i !== index)
      rec.current_step = rec.pending_steps[0] ?? null
      if (note) push(rec.decisions, { at: Date.now(), kind: "step", detail: `#${index} done: ${String(note).slice(0, 160)}` }, MAX_DECISIONS)
      schedule()
    },

    setCurrentStep(index) { rec.current_step = index; schedule() },

    noteFiles(changed = [], created = []) {
      for (const f of changed || []) {
        const p = path.resolve(rec.cwd, f)
        if (!rec.files_changed.includes(p)) { rec.files_changed.push(p); if (rec.files_changed.length > MAX_FILES) rec.files_changed.shift() }
      }
      for (const f of created || []) {
        const p = path.resolve(rec.cwd, f)
        if (!rec.files_created.includes(p)) { rec.files_created.push(p); if (rec.files_created.length > MAX_FILES) rec.files_created.shift() }
      }
      schedule()
    },

    noteTest(t) {
      push(rec.tests_run, {
        command: String(t.command ?? "").slice(0, 300),
        exit_code: t.exit_code ?? null,
        passed: t.passed ?? false,
        at: Date.now(),
      }, 100)
      schedule()
    },

    noteVerification(v) {
      push(rec.verification_results, v, 100)
      rec.verification_epoch = (rec.verification_epoch ?? 0) + 1
      schedule(CRITICAL_EVENTS.has(TASK_STATUS.VERIFYING) ? DURABILITY.CRITICAL : DURABILITY.NORMAL)
    },

    noteError(code, detail = "") {
      push(rec.errors, { at: Date.now(), code: String(code ?? "UNKNOWN").slice(0, 60), detail: String(detail ?? "").slice(0, 300) }, MAX_ERRORS)
      schedule()
    },

    decide(kind, detail = "") {
      push(rec.decisions, { at: Date.now(), kind: String(kind).slice(0, 40), detail: String(detail ?? "").slice(0, 300) }, MAX_DECISIONS)
      schedule()
    },

    noteModel(provider, model, why = "") {
      rec.provider_used = provider
      rec.model_used = model
      push(rec.model_history, { provider, model, why: String(why).slice(0, 200), at: Date.now() }, 40)
      schedule()
    },

    noteCheckpoint(id) {
      if (id && !rec.checkpoints.includes(id)) rec.checkpoints.push(id)
      rec.checkpoint_id = id || rec.checkpoint_id
      schedule(DURABILITY.CRITICAL)
    },

    noteRepair(n = 1) { rec.repair_count = (rec.repair_count ?? 0) + n; rec.resource_usage.retries = rec.retry_count; schedule() },
    /** Count a resume after the segment safety fuse; returns the new count. */
    noteContinuation(n = 1) {
      rec.continuation_count = (rec.continuation_count ?? 0) + n
      schedule(DURABILITY.CRITICAL)
      return rec.continuation_count
    },
    noteRetry(n = 1) { rec.retry_count = (rec.retry_count ?? 0) + n; rec.resource_usage.retries = rec.retry_count; schedule() },

    noteUsage(u = {}) {
      const r = rec.resource_usage
      if (u.tokens_in) r.tokens_in += u.tokens_in
      if (u.tokens_out) r.tokens_out += u.tokens_out
      if (u.tool_calls) r.tool_calls += u.tool_calls
      if (u.ms) r.ms += u.ms
      if (u.workers) r.workers = Math.max(r.workers, u.workers)
      schedule()
    },

    setNextAction(action) { rec.next_action = action == null ? null : String(action).slice(0, 400); schedule() },

    flush(durability = DURABILITY.CRITICAL) {
      if (timer) { clearTimeout(timer); timer = null }
      if (dirty || durability === DURABILITY.CRITICAL) {
        try { return save(durability) } catch (e) { return { ok: false, error: e } }
      }
      return { ok: true }
    },
    save: (d = DURABILITY.NORMAL) => save(d),
  }

  save(DURABILITY.NORMAL)
  try { pruneTasks() } catch {}
  return api
}

export function readTask(taskId) {
  try {
    const j = JSON.parse(fs.readFileSync(taskFile(taskId), "utf8"))
    return j && typeof j === "object" ? j : null
  } catch { return null }
}

export function listTasks({ cwd = null, status = null, max = 50 } = {}) {
  const out = []
  try {
    const files = fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith(".json"))
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf8"))
        if (!j || typeof j !== "object") continue
        if (cwd && path.resolve(j.cwd || "") !== path.resolve(cwd)) continue
        if (status && j.status !== status) continue
        out.push(j)
      } catch {}
    }
  } catch {}
  out.sort((a, b) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0))
  return out.slice(0, max)
}

export function interruptedTasks({ cwd = process.cwd() } = {}) {
  return listTasks({ cwd, max: 100 }).filter(
    (t) => !TERMINAL.has(t.status) && t.status !== TASK_STATUS.WAITING && !pidAlive(t.pid)
  )
}

export function pidAlive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid
  try { process.kill(pid, 0); return true } catch (e) { return e?.code === "EPERM" }
}

export function pruneTasks(max = MAX_TASKS) {
  try {
    const files = fs.readdirSync(TASKS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const full = path.join(TASKS_DIR, f)
        try { return { full, mt: fs.statSync(full).mtimeMs } } catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => b.mt - a.mt)
    let removed = 0
    for (const f of files.slice(max)) {
      try {
        const j = JSON.parse(fs.readFileSync(f.full, "utf8"))
        if (!TERMINAL.has(j.status) && j.status !== TASK_STATUS.WAITING && pidAlive(j.pid)) continue
      } catch {}
      try { fs.rmSync(f.full, { force: true }); removed++ } catch {}
    }
    return removed
  } catch { return 0 }
}
