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
const MAX_FILES = 200 // per-segment cap on recorded file effects

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
export function recordSegment(taskId, result, { note, files } = {}) {
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
    // Phase 4: what this segment actually changed on disk, from the checkpoint
    // manifests. Without it, a segment that died mid-edit left no trace of
    // WHICH files it had already touched.
    files: Array.isArray(files) ? files.slice(0, MAX_FILES).map((f) => ({ path: String(f.path), created: !!f.created })) : [],
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

/**
 * Attach verification evidence to a task, and let it DEMOTE a claimed
 * completion: a segment that said COMPLETED while the project's own checks
 * fail has not finished, and the record must say so rather than take the
 * agent's word for it. Verification never promotes a task the other way.
 */
export function recordVerification(taskId, verification, { demote = true } = {}) {
  const rec = loadTask(taskId)
  if (!rec || !verification) return null
  rec.verification = {
    status: verification.status,
    ranAt: verification.ranAt ?? Date.now(),
    checks: (verification.checks ?? []).map((c) => ({
      id: c.id, cmd: c.cmd, source: c.source, ok: !!c.ok, code: c.code ?? null,
      blocked: !!c.blocked, reason: c.reason ? clip(c.reason, 300) : null,
      ms: c.ms ?? 0, output: clip(c.output ?? "", 2000),
    })),
  }
  if (demote && verification.status === "FAILED" && rec.status === AGENT_STATUS.COMPLETED) {
    rec.status = AGENT_STATUS.CONTINUE_REQUIRED
  }
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

/** Every distinct run id this task produced, oldest segment first. */
export function taskRunIds(rec) {
  return [...new Set((rec?.segments ?? []).map((s) => s.runId).filter(Boolean))]
}

/** Files this task changed, deduplicated across its segments. */
export function taskFiles(rec) {
  const seen = new Map()
  for (const seg of rec?.segments ?? []) {
    for (const f of seg.files ?? []) {
      const prev = seen.get(f.path)
      seen.set(f.path, { path: f.path, created: !!(prev?.created || f.created) })
    }
  }
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path))
}

export const RECONCILE = Object.freeze({
  CLEAN: "CLEAN",       // nothing was changed, or everything the record claims is present
  DIVERGED: "DIVERGED", // the record and the working tree disagree
  ABANDONED: "ABANDONED", // a segment wrote files and then FAILED — partial edits, no completion
})

/**
 * Phase 4 — effect reconciliation. Compare what the record says this task did
 * against what is actually on disk right now, and say so plainly.
 *
 * The case that matters: a segment that changed files and then FAILED (the
 * provider died, the process was killed) leaves half-finished edits behind. The
 * old behaviour left no record at all, so nobody — user or agent — could tell
 * which files were mid-edit. This names them.
 *
 * It reports; it never repairs. Rolling back is `forge tasks undo`, an explicit
 * user action, because silently reverting someone's working tree is worse than
 * a stale record.
 */
export function reconcileTask(rec, { statFile } = {}) {
  const stat = statFile ?? ((p) => { try { return fs.statSync(p) } catch { return null } })
  const files = taskFiles(rec)
  const missing = [], present = []
  for (const f of files) {
    if (stat(f.path)) present.push(f.path)
    else missing.push(f.path)
  }
  const lastWriting = [...(rec?.segments ?? [])].reverse().find((s) => s.wrote)
  const abandoned = !!lastWriting && rec?.status === AGENT_STATUS.FAILED

  const notes = []
  if (abandoned) notes.push(`the last writing segment FAILED — ${present.length} file(s) may hold partial edits`)
  if (missing.length) notes.push(`${missing.length} file(s) this task changed no longer exist`)
  if (!files.length) notes.push("this task changed no files")

  const status = abandoned ? RECONCILE.ABANDONED
    : missing.length ? RECONCILE.DIVERGED
      : RECONCILE.CLEAN
  return { status, files, present, missing, notes, undoable: taskRunIds(rec).length > 0 }
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
  // Phase 4: name the files earlier segments changed, and — the case that
  // matters — call out partial edits left by a segment that FAILED mid-run, so
  // the resuming segment inspects them before trusting them.
  const rc = reconcileTask(rec)
  const changedList = rc.files.length
    ? `Files earlier segments changed (inspect before editing):\n${rc.files.slice(0, 20).map((f) => `  - ${f.path}${f.created ? " (created)" : ""}`).join("\n")}`
    : ""
  const abandonedWarn = rc.status === RECONCILE.ABANDONED
    ? "WARNING: a previous segment FAILED part-way through while editing files — the files above may hold PARTIAL, inconsistent edits. Read them before trusting or building on them."
    : ""
  return [
    rec.task,
    "",
    "--- continuation context (system) ---",
    `This is segment ${done + 1} of an ongoing task; ${done} earlier segment(s) ran and the step budget ran out before the work was finished.`,
    done ? `Earlier segments:\n${notes}` : "",
    rec.lastText ? `Where the last segment stopped:\n${rec.lastText}` : "",
    changedList,
    abandonedWarn,
    "",
    "Files in this working directory may ALREADY have been changed by those segments.",
    "Check the current state of the code before editing anything — do not redo work that is already done, and do not assume it was done correctly either.",
    "Finish the remaining work and then give a final answer.",
  ].filter(Boolean).join("\n")
}
