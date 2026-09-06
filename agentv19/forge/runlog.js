/**
 * forge — run journal (crash-safe task state, zero dependencies)
 *
 *   ~/.forge/runs/<runId>.json
 *
 * Every top-level agent run writes a compact journal: what the task was, where
 * it ran, which step it reached, the last tool it executed, the files it
 * touched and the checkpoints it created. Written atomically (tmp + rename) at
 * start, after every tool result, and at the end with a terminal status.
 *
 * If forge dies mid-run (crash, SIGKILL, power loss) the journal is left at
 * status "running" with a pid that is no longer alive. That is exactly what the
 * next interactive startup looks for: it never guesses whether a task was
 * interrupted, and it never replays anything — it shows the user what is known
 * and offers Resume / Verify / Undo / Cancel.
 *
 * The journal is a record, not a transcript: no model messages, no tool
 * outputs. Bounded: 200 files, ~60 touched paths per run.
 */
import fs from "node:fs"
import path from "node:path"
import { DEFAULT_DIR } from "./config.js"
import { listCheckpoints } from "./checkpoint.js"

export const RUNS_DIR = path.join(DEFAULT_DIR, "runs")
const MAX_RUNS = 200
const MAX_FILES = 60

function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function runFile(runId) {
  return path.join(RUNS_DIR, String(runId).replace(/[^A-Za-z0-9._-]/g, "_") + ".json")
}

/** Start a journal for a run. Returns a handle whose methods never throw. */
export function openRun({ runId, task, cwd = process.cwd(), kind = "agent", provider = "", model = "" }) {
  const file = runFile(runId)
  const rec = {
    runId, kind, task: String(task ?? "").slice(0, 500), cwd: path.resolve(cwd), provider, model,
    pid: process.pid, status: "running", startedAt: Date.now(), updatedAt: Date.now(), endedAt: null,
    step: 0, toolCalls: 0, lastTool: null, files: {}, checkpoints: [], error: null,
  }
  let dirty = false
  let timer = null
  const save = () => {
    try { rec.updatedAt = Date.now(); writeAtomic(file, rec); dirty = false } catch { /* journal is best-effort */ }
  }
  const schedule = () => {
    dirty = true
    if (timer) return
    timer = setTimeout(() => { timer = null; if (dirty) save() }, 150)
    if (typeof timer.unref === "function") timer.unref()
  }
  save()
  try { pruneRuns() } catch {}
  return {
    file,
    get record() { return rec },
    step(n) { rec.step = n; schedule() },
    tool(name, target, ok) {
      rec.toolCalls++
      rec.lastTool = { name, target: String(target ?? "").slice(0, 200), ok: ok !== false, at: Date.now() }
      schedule()
    },
    file: file,
    touched(p, action) {
      const key = String(p)
      if (!rec.files[key] && Object.keys(rec.files).length >= MAX_FILES) return
      rec.files[key] = { action: rec.files[key]?.action === "created" && action !== "deleted" ? "created" : action || "modified", at: Date.now() }
      schedule()
    },
    checkpoint(id) {
      if (id && !rec.checkpoints.includes(id)) { rec.checkpoints.push(id); schedule() }
    },
    end(status, extra = {}) {
      rec.status = ["completed", "failed", "cancelled"].includes(status) ? status : "failed"
      rec.endedAt = Date.now()
      if (extra.error) rec.error = String(extra.error).slice(0, 400)
      if (extra.steps != null) rec.step = extra.steps
      if (timer) { clearTimeout(timer); timer = null }
      save()
    },
    /** Flush synchronously (exit paths). */
    flush() { if (dirty) save() },
  }
}

export function readRun(runId) {
  try {
    const j = JSON.parse(fs.readFileSync(runFile(runId), "utf8"))
    return j && typeof j === "object" ? j : null
  } catch {
    return null
  }
}

export function listRuns({ cwd = null, max = 20 } = {}) {
  const out = []
  try {
    const files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"))
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), "utf8"))
        if (!j || typeof j !== "object") continue
        if (cwd && path.resolve(j.cwd || "") !== path.resolve(cwd)) continue
        out.push(j)
      } catch {}
    }
  } catch {}
  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  return out.slice(0, max)
}

export function pidAlive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid
  try { process.kill(pid, 0); return true } catch (e) { return e?.code === "EPERM" }
}

/**
 * Runs that were interrupted: status "running" whose process is gone.
 * Scoped to cwd by default, because recovery choices (undo/resume) only make
 * sense in the directory the run worked in.
 */
export function interruptedRuns({ cwd = process.cwd() } = {}) {
  return listRuns({ cwd, max: 50 }).filter((r) => r.status === "running" && !pidAlive(r.pid))
}

/** Mark a run with a final status without a handle (recovery flows). */
export function markRun(runId, status, extra = {}) {
  const rec = readRun(runId)
  if (!rec) return false
  rec.status = ["running", "completed", "failed", "cancelled", "undone"].includes(status) ? status : rec.status
  rec.endedAt = rec.endedAt ?? Date.now()
  rec.updatedAt = Date.now()
  if (extra.note) rec.note = String(extra.note).slice(0, 400)
  if (extra.verify) rec.verify = extra.verify
  try { writeAtomic(runFile(runId), rec); return true } catch { return false }
}

/**
 * Verify what an interrupted run left behind — facts only:
 *   - which touched files still exist
 *   - which of its checkpoints are still restorable
 * Never runs commands.
 */
export function verifyRun(rec) {
  const files = Object.entries(rec?.files ?? {})
  let present = 0, missing = 0
  for (const [p, info] of files) {
    const exists = fs.existsSync(p)
    if (info?.action === "deleted" ? !exists : exists) present++
    else missing++
  }
  const cps = listCheckpoints(rec?.cwd || process.cwd(), 999)
  const mine = new Set(cps.filter((c) => c.runId === rec?.runId).map((c) => c.id))
  const restorable = (rec?.checkpoints ?? []).filter((id) => mine.has(id)).length
  const filesystem = files.length === 0 ? "nothing to verify (no files touched)" : missing === 0 ? `verified (${present} file${present === 1 ? "" : "s"} as recorded)` : `${missing} of ${files.length} recorded files missing`
  const checkpoints = (rec?.checkpoints ?? []).length === 0 ? "none" : `${restorable}/${rec.checkpoints.length} restorable`
  return { filesystem, checkpoints, present, missing, restorable, total: files.length, ok: missing === 0 && restorable === (rec?.checkpoints ?? []).length }
}

/**
 * Resolve a user-typed run id: full "run-…" id, or the short "RUN-XXXX" form
 * shown in the UI (last 4 chars of the id's tail, case-insensitive). Looks at
 * checkpoints first (what /undo can act on), then journals.
 */
export function resolveRunId(cwd, idOrShort) {
  const raw = String(idOrShort ?? "").trim()
  if (!raw) return null
  if (/^run-[a-z0-9]+-[a-z0-9]+$/i.test(raw)) return raw
  const tail = raw.replace(/^run-?/i, "").toLowerCase()
  if (!tail) return null
  const ids = new Set()
  try { for (const c of listCheckpoints(cwd, 999)) if (c.runId) ids.add(c.runId) } catch {}
  for (const r of listRuns({ cwd, max: 200 })) if (r.runId) ids.add(r.runId)
  const hits = [...ids].filter((id) => id.toLowerCase().endsWith(tail) || (id.split("-").pop() || "").toLowerCase().endsWith(tail))
  return hits.length === 1 ? hits[0] : hits.length > 1 ? hits.sort().reverse()[0] : null
}

/** Keep the newest MAX_RUNS journals; never delete a running one. */
export function pruneRuns(max = MAX_RUNS) {
  try {
    const files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")).map((f) => {
      const full = path.join(RUNS_DIR, f)
      try { return { full, mt: fs.statSync(full).mtimeMs } } catch { return null }
    }).filter(Boolean).sort((a, b) => b.mt - a.mt)
    let removed = 0
    for (const f of files.slice(max)) {
      try {
        const j = JSON.parse(fs.readFileSync(f.full, "utf8"))
        if (j.status === "running" && pidAlive(j.pid)) continue
      } catch {}
      try { fs.rmSync(f.full, { force: true }); removed++ } catch {}
    }
    return removed
  } catch {
    return 0
  }
}
