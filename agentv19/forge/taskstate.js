/**
 * forge — durable task state (Phase 2).
 *
 * `contract.js` made an agent segment's outcome explicit. This is the first
 * consumer of it: the place a task's history actually survives the process.
 *
 * Why it exists: a `forge agent` run that hit its step budget printed
 * "work remains" and then forgot everything. There was no record that the task
 * existed, what it had already done, or what it cost — so "continue where you
 * left off" was impossible and every retry started from zero context. Sessions
 * (`sessions.js`) record a *conversation*; nothing recorded a *task*.
 *
 * On disk: ~/.forge/tasks/<taskId>.json, chmod 600, written atomically
 * (tmp + rename) so an interrupted write cannot leave a half-parsed record.
 *
 * Honesty rules this module enforces, rather than papering over:
 *   - token totals are UNKNOWN-aware. Segments whose provider reported no
 *     counts are COUNTED as unknown (`unknownSegments`), never folded in as 0,
 *     so a total is never quietly understated.
 *   - a task's status is the status of its latest segment. Nothing here
 *     promotes a CONTINUE_REQUIRED task to COMPLETED.
 *
 * Everything written here is passed through secret redaction first: task text
 * and agent output can contain keys, and this file outlives the process.
 */
import fs from "node:fs"
import path from "node:path"
import { TASKS_DIR } from "./config.js"
import { redact } from "./secrets.js"
import { AGENT_STATUS, UNKNOWN, newTaskId, isAgentStatus } from "./contract.js"

/** Keep the store bounded, like sessions. */
export const MAX_TASKS = 200
/** Per-task cap on retained segment records (a task is a history, not a log). */
export const MAX_SEGMENTS = 100
const MAX_TEXT = 4000 // bytes of remembered answer text per task

const clip = (s, n = MAX_TEXT) => {
  const t = redact(String(s ?? ""))
  return t.length > n ? t.slice(0, n) + "\n…(truncated)" : t
}

function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, file) // atomic within one filesystem
  return file
}

export function taskFile(taskId) {
  return path.join(TASKS_DIR, `${taskId}.json`)
}

/**
 * Start a task record. Returns the record; the caller passes `record.taskId`
 * into runAgent so every segment of the task shares one identity.
 */
export function createTask({ task, cwd, provider, model, taskId }) {
  const rec = {
    taskId: taskId || newTaskId(),
    task: clip(task, 2000),
    cwd: cwd ?? null,
    provider: provider ?? null,
    model: model ?? null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: AGENT_STATUS.WAITING, // nothing has run yet — not COMPLETED, not FAILED
    segments: [],
    totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0, unknownSegments: 0, steps: 0, toolCalls: 0, segments: 0 },
    lastText: null,
  }
  writeAtomic(taskFile(rec.taskId), rec)
  return rec
}

const known = (v) => typeof v === "number" && Number.isFinite(v)

/**
 * Fold one agent result (the Phase 1 contract shape) into a task record and
 * persist it. Returns the updated record, or null if it could not be written.
 *
 * `note` is an optional short human/agent-written line about what the segment
 * accomplished; it is what a later segment reads to pick the work back up.
 */
export function recordSegment(taskId, result, { note } = {}) {
  const rec = loadTask(taskId)
  if (!rec || !result) return null

  const u = result.usage ?? {}
  const anyKnown = known(u.promptTokens) || known(u.completionTokens)
  const seg = {
    segmentId: result.segmentId ?? null,
    runId: result.runId ?? null,
    status: isAgentStatus(result.status) ? result.status : AGENT_STATUS.FAILED,
    budgetHit: result.budgetHit === true,
    steps: known(result.steps) ? result.steps : 0,
    wrote: result.wrote === true,
    toolCalls: Array.isArray(result.toolLog) ? result.toolLog.length : 0,
    usage: {
      promptTokens: known(u.promptTokens) ? u.promptTokens : UNKNOWN,
      completionTokens: known(u.completionTokens) ? u.completionTokens : UNKNOWN,
      totalTokens: known(u.totalTokens) ? u.totalTokens : UNKNOWN,
    },
    endedAt: Date.now(),
    note: note ? clip(note, 600) : null,
  }

  rec.segments.push(seg)
  if (rec.segments.length > MAX_SEGMENTS) rec.segments = rec.segments.slice(-MAX_SEGMENTS)

  const t = rec.totals
  t.segments++
  t.steps += seg.steps
  t.toolCalls += seg.toolCalls
  // UNKNOWN is counted, never summed as zero: a total that silently omits a
  // segment's cost is worse than a total that admits it is incomplete.
  if (anyKnown) {
    t.promptTokens += known(u.promptTokens) ? u.promptTokens : 0
    t.completionTokens += known(u.completionTokens) ? u.completionTokens : 0
    t.totalTokens += known(u.totalTokens) ? u.totalTokens : 0
  } else {
    t.unknownSegments++
  }

  rec.status = seg.status // the task is exactly as finished as its last segment
  rec.lastText = clip(result.text)
  rec.updatedAt = Date.now()
  try { writeAtomic(taskFile(rec.taskId), rec) } catch { return null }
  return rec
}

/** Mark a task terminally, e.g. FAILED when runAgent threw. Returns the record. */
export function setTaskStatus(taskId, status, { note } = {}) {
  const rec = loadTask(taskId)
  if (!rec || !isAgentStatus(status)) return null
  rec.status = status
  if (note) rec.lastText = clip(note)
  rec.updatedAt = Date.now()
  try { writeAtomic(taskFile(rec.taskId), rec) } catch { return null }
  return rec
}

/** Load by full task id, or by unambiguous id prefix. Null if absent/corrupt. */
export function loadTask(idOrPrefix) {
  if (!idOrPrefix) return null
  const direct = taskFile(idOrPrefix)
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")) } catch { return null } }
  if (fs.existsSync(direct)) return read(direct)
  const hits = listTasks({ all: true }).filter((r) => r.taskId.startsWith(idOrPrefix))
  return hits.length === 1 ? hits[0] : null
}

/**
 * Newest-first task records. `cwd` filters to tasks started in that directory;
 * `all` ignores the filter. Corrupt files are skipped, never thrown.
 *
 * Ordering is a TOTAL order (updatedAt, then taskId): two records written in
 * the same millisecond must not order by readdir chance — `pruneTasks` DELETES
 * in this order, and a tie could otherwise drop the newer task.
 */
export function listTasks({ cwd, all = false } = {}) {
  let names = []
  try { names = fs.readdirSync(TASKS_DIR).filter((n) => n.endsWith(".json")) } catch { return [] }
  const out = []
  for (const n of names) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, n), "utf8"))
      if (!rec?.taskId) continue
      if (!all && cwd && rec.cwd !== cwd) continue
      out.push(rec)
    } catch { /* skip corrupt record */ }
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || String(a.taskId).localeCompare(String(b.taskId)))
}

/** Delete all but the newest `max` tasks. Returns count removed. Best-effort. */
export function pruneTasks(max = MAX_TASKS) {
  try {
    const recs = listTasks({ all: true })
    if (recs.length <= max) return 0
    let removed = 0
    for (const r of recs.slice(max)) {
      try { fs.rmSync(taskFile(r.taskId), { force: true }); removed++ } catch {}
    }
    return removed
  } catch {
    return 0
  }
}

/** True when the task has unfinished work a further segment could pick up. */
export function isResumable(rec) {
  return !!rec && (rec.status === AGENT_STATUS.CONTINUE_REQUIRED || rec.status === AGENT_STATUS.WAITING)
}

/**
 * Build the task text for the NEXT segment of a resumable task.
 *
 * This is the whole point of persisting state: a continuation that just
 * re-sent the original task would redo finished work and re-edit files. The
 * prompt states plainly what has already happened, that files may already be
 * changed, and that verification comes before new edits.
 */
export function continuationPrompt(rec) {
  if (!rec) return ""
  const done = rec.segments.length
  const notes = rec.segments.map((s, i) => `  ${i + 1}. ${s.status}${s.wrote ? " (changed files)" : ""}${s.note ? " — " + s.note : ""}`).join("\n")
  return [
    rec.task,
    "",
    "--- continuation context (system) ---",
    `This is segment ${done + 1} of an ongoing task; ${done} earlier segment(s) ran and the step budget ran out before the work was finished.`,
    done ? `Earlier segments:\n${notes}` : "",
    rec.lastText ? `Where the last segment stopped:\n${rec.lastText}` : "",
    "",
    "Files in this working directory may ALREADY have been changed by those segments.",
    "Check the current state of the code before editing anything — do not redo work that is already done, and do not assume it was done correctly either.",
    "Finish the remaining work and then give a final answer.",
  ].filter(Boolean).join("\n")
}
