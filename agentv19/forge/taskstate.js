/**
 * forge — task state engine (v21, zero dependencies)
 *
 * ONE authoritative, persistent record of where an autonomous task is.
 * Before v21 the closest thing was the run journal (runlog.js): a crash-safe
 * list of tools and touched files, but it had no notion of task lifecycle,
 * segments, DAG, verification evidence or repair history. That scattered task
 * state across the journal, the session and the terminal UI.
 *
 * This module owns the lifecycle. The journal remains the low-level tool/
 * file record; taskstate.js is the state machine on top of it:
 *
 *   ~/.forge/tasks/<taskId>.json
 *
 * States (the ONLY legal ones) and the explicit transition graph below make
 * impossible transitions throw instead of silently corrupting state:
 *
 *   IDLE → PLANNING → DISCOVERING → EXECUTING → VERIFYING → COMPLETED
 *                     │              │   ↑          │
 *                     │              │   └── REPAIRING ←─┘ (failure)
 *                     │              ├─→ CHECKPOINTING ─→ (back to caller)
 *                     │              ├─→ WAITING ─→ (resume) → EXECUTING
 *                     │              └─→ RECOVERING → EXECUTING
 *                     └→ FAILED / CANCELLED
 *
 * Every write is atomic (tmp + rename) and bounded. Nothing here ever throws
 * into the agent loop: a broken task record degrades to an in-memory record.
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

/**
 * The legal transition graph. Keys are states; each value is the set of
 * states they may move to. A transition not listed here is impossible and
 * transition() rejects it (rather than silently corrupting the record).
 */
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
  if (from === to) return true // same-state heartbeats are legal (logged, not validated)
  return Boolean(TRANSITIONS[from]?.has(to))
}

export function taskFile(taskId) {
  return path.join(TASKS_DIR, String(taskId).replace(/[^A-Za-z0-9._-]/g, "_") + ".json")
}

function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** Fresh, empty task record. */
export function blankTask({ taskId, runId = null, objective = "", cwd = process.cwd() } = {}) {
  const now = Date.now()
  return {
    task_id: taskId,
    run_id: runId,
    objective: String(objective ?? "").slice(0, 2000),
    status: TASK_STATUS.IDLE,
    cwd: path.resolve(cwd),
    plan: null, // { steps: [...], source }
    dag: null, // { nodes: { id: node }, order: [...] }
    segments: [], // bounded summaries; full segments live in the run journal
    completed_steps: [],
    current_step: null,
    pending_steps: [],
    files_changed: [], // absolute paths
    files_created: [],
    tests_run: [],
    verification_results: [], // structured evidence (see verify-ledger.js)
    errors: [],
    decisions: [], // { at, kind, detail }
    model_used: null,
    provider_used: null,
    model_history: [],
    checkpoint_id: null,
    checkpoints: [],
    resource_usage: { tokens_in: 0, tokens_out: 0, tool_calls: 0, segments: 0, ms: 0, workers: 0, retries: 0 },
    retry_count: 0,
    repair_count: 0,
    segment_count: 0,
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
 * Open (or create) a task record. Returns a handle whose methods never throw.
 * @param create  when false and the record is missing, returns null (used by
 *                recovery to READ interrupted tasks without fabricating one).
 */
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

  const save = () => {
    try {
      rec.updated_at = Date.now()
      writeAtomic(file, rec)
      dirty = false
    } catch { /* task state is best-effort — never break the run */ }
  }
  const schedule = () => {
    dirty = true
    if (timer) return
    timer = setTimeout(() => { timer = null; if (dirty) save() }, 120)
    if (typeof timer.unref === "function") timer.unref()
  }

  const push = (arr, item, cap) => {
    arr.push(item)
    if (arr.length > cap) arr.splice(0, arr.length - cap)
  }

  const api = {
    file,
    get record() { return rec },
    get status() { return rec.status },

    /** The ONLY way to change status. Validates the transition. */
    transition(to, { reason = "", now: _ = null } = {}) {
      const from = rec.status
      if (to === from) { schedule(); return true }
      if (TERMINAL.has(from)) return false // a finished task never moves
      if (!canTransition(from, to)) {
        // record the rejected attempt; do NOT corrupt state
        push(rec.errors, { at: Date.now(), code: "INVALID_TRANSITION", detail: `${from} → ${to} (${String(reason).slice(0, 120)})` }, MAX_ERRORS)
        schedule()
        return false
      }
      rec.status = to
      if (to === TASK_STATUS.WAITING) rec.waiting_reason = reason || null
      else rec.waiting_reason = null
      push(rec.decisions, { at: Date.now(), kind: "state", detail: `${from} → ${to}${reason ? `: ${String(reason).slice(0, 160)}` : ""}` }, MAX_DECISIONS)
      if (rec.started_at == null && to !== TASK_STATUS.IDLE) rec.started_at = Date.now()
      if (TERMINAL.has(to)) rec.ended_at = Date.now()
      schedule()
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

    /** Record one completed segment (bounded summary; journal keeps detail). */
    addSegment(seg) {
      rec.segment_count = (rec.segment_count ?? 0) + 1
      rec.resource_usage.segments = rec.segment_count
      const s = {
        segment_id: seg.segment_id ?? `seg-${rec.segment_count}`,
        objective: String(seg.objective ?? "").slice(0, 300),
        status: seg.status ?? "completed",
        steps: seg.steps ?? 0,
        tool_calls: seg.tool_calls ?? 0,
        continued: seg.continued ?? false,
        at: Date.now(),
      }
      push(rec.segments, s, 60)
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

    noteVerification(v) { push(rec.verification_results, v, 100); schedule() },

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
      schedule()
    },

    noteRepair(n = 1) { rec.repair_count = (rec.repair_count ?? 0) + n; rec.resource_usage.retries = rec.retry_count; schedule() },
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

    flush() { if (timer) { clearTimeout(timer); timer = null } if (dirty) save() },
    save,
  }

  save()
  try { pruneTasks() } catch {}
  return api
}

export function readTask(taskId) {
  try {
    const j = JSON.parse(fs.readFileSync(taskFile(taskId), "utf8"))
    return j && typeof j === "object" ? j : null
  } catch { return null }
}

/** All task records, newest first, optionally scoped to cwd. */
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

/**
 * Tasks that were mid-flight when their process died: non-terminal status with
 * a pid that is no longer alive. This is the resume engine's trigger.
 */
export function interruptedTasks({ cwd = process.cwd() } = {}) {
  return listTasks({ cwd, max: 100 }).filter(
    (t) => !TERMINAL.has(t.status) && !pidAlive(t.pid)
  )
}

export function pidAlive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid
  try { process.kill(pid, 0); return true } catch (e) { return e?.code === "EPERM" }
}

/** Keep the newest MAX_TASKS task records; never delete a live one. */
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
        if (!TERMINAL.has(j.status) && pidAlive(j.pid)) continue
      } catch {}
      try { fs.rmSync(f.full, { force: true }); removed++ } catch {}
    }
    return removed
  } catch { return 0 }
}
