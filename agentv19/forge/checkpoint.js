/**
 * forge — checkpoints (v16, hardened v20): automatic file snapshots before mutations.
 *
 * Every write tool (write_file / edit_file / multi_edit / apply_patch) snapshots
 * the original file(s) BEFORE changing them:
 *
 *   ~/.forge/checkpoints/<id>/manifest.json   { id, ts, cwd, files: [{ path, backup, sha? }] }
 *   ~/.forge/checkpoints/<id>/<n>.bak         original file contents
 *   ~/.forge/checkpoints/<id>/<n>.bak.gz      …gzip'ed when larger than 256 KB (v20.1)
 *
 * v20: CREATED files are tracked too — a manifest entry with `backup: null`
 * and a sha256 of the created content. `forge undo` deletes a created file
 * only when its current content still hashes the same (never clobber edits
 * the user made afterwards). This makes apply_patch's create+modify fully
 * atomic to undo (v19 left created files behind).
 *
 * v20.1 (P0-5): the 2 MB per-file cap meant every large file was simply not
 * protected — `forge undo` could only report "NOT restored … larger than 2MB".
 * Backups are now gzip'ed (node:zlib, still zero dependencies), which raises
 * the cap to 64 MB and shrinks the checkpoint directory by ~10x on text. A
 * total-directory budget (512 MB) keeps 30 checkpoints from filling a disk.
 *
 * `forge undo` / chat `/undo` restores the newest checkpoint recorded for the
 * CURRENT working directory and consumes it — repeated undo walks back through
 * history. Zero dependencies.
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import zlib from "node:zlib"
import { DEFAULT_DIR } from "./config.js"

export const CHECKPOINTS_DIR = path.join(DEFAULT_DIR, "checkpoints")
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024 // per file — compressed on the way in
const COMPRESS_OVER_BYTES = 256 * 1024 // small files stay plain: instant undo
const MAX_CHECKPOINTS = 30
const MAX_CHECKPOINT_DIR_BYTES = 512 * 1024 * 1024 // total budget for all of them

// v20.5: a per-process monotonic sequence baked into the checkpoint id so that
// lexicographic id order == creation order. The id used to be
// `<ISO-millisecond>-<random>`, and two checkpoints made in the SAME
// millisecond tied on the timestamp and then sorted by the RANDOM suffix — an
// order unrelated to when they were made. Every rollback (restoreRun /
// restoreRuns) replays newest→oldest by that order, so two same-ms checkpoints
// could unwind in the wrong sequence and leave a file holding intermediate
// content instead of its true pre-run state. The zero-padded, monotonic seq
// breaks ms-ties in creation order. Within one run/task (always one process)
// this makes rollback ordering exact.
let _seq = 0

function sha256Head(file) {
  try {
    const st = fs.statSync(file)
    const len = Math.min(st.size, 1024 * 1024)
    const fd = fs.openSync(file, "r")
    try {
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, 0)
      return crypto.createHash("sha256").update(buf).digest("hex")
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

/** Snapshot `files` (absolute paths, EXISTING) before they get modified, plus
 *  track `created` (absolute paths, NOT existing yet — this mutation will
 *  create them) so undo can remove them. One manifest covers both — a single
 *  undo restores the whole atomic operation. Returns id | null. */
export function snapshotBefore(files, cwd, created = [], runId = null) {
  try {
    // v20.0.1: files too big to snapshot are RECORDED (instead of silently
    // skipped) so `forge undo` can tell the user it could not protect them.
    const tooLarge = []
    const want = [...new Set((files || []).map((f) => path.resolve(f)))].filter((f) => {
      try {
        const st = fs.statSync(f)
        if (!st.isFile()) return false
        if (st.size > MAX_SNAPSHOT_BYTES) { tooLarge.push(f); return false }
        return true
      } catch {
        return false // does not exist (creation) — handled via `created`
      }
    })
    const creating = [...new Set((created || []).map((f) => path.resolve(f)))].filter((f) => {
      try { fs.accessSync(f); return false } catch { return true } // must NOT exist yet
    })
    if (!want.length && !creating.length && !tooLarge.length) return null
    const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + String(_seq++).padStart(6, "0") + "-" + Math.random().toString(36).slice(2, 6)
    const dir = path.join(CHECKPOINTS_DIR, id)
    fs.mkdirSync(dir, { recursive: true })
    const manifest = { id, ts: Date.now(), cwd: path.resolve(cwd || process.cwd()), ...(runId ? { runId } : {}), files: [] }
    want.forEach((f, i) => {
      // v20.1: gzip anything worth compressing. Text shrinks ~10x, which is
      // what pays for the higher per-file cap.
      let backup = String(i) + ".bak"
      let gz = false
      let size = 0
      try {
        size = fs.statSync(f).size
      } catch {}
      if (size > COMPRESS_OVER_BYTES) {
        backup += ".gz"
        gz = true
        fs.writeFileSync(path.join(dir, backup), zlib.gzipSync(fs.readFileSync(f), { level: 6 }))
      } else {
        fs.copyFileSync(f, path.join(dir, backup))
      }
      manifest.files.push({ path: f, backup, ...(gz ? { gz: true, size } : {}) })
    })
    creating.forEach((f) => {
      manifest.files.push({ path: f, backup: null, created: true })
    })
    tooLarge.forEach((f) => {
      manifest.files.push({ path: f, backup: null, tooLarge: true })
    })
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 1))
    prune()
    return id
  } catch {
    return null // checkpointing must NEVER break the actual tool call
  }
}

/** Record the content hash of files this mutation CREATED (called AFTER the
 *  write), so undo can verify the file is still ours before deleting it. */
export function sealCreated(checkpointId, cwd) {
  try {
    if (!checkpointId) return
    const dir = path.join(CHECKPOINTS_DIR, checkpointId)
    const mFile = path.join(dir, "manifest.json")
    const m = JSON.parse(fs.readFileSync(mFile, "utf8"))
    let changed = false
    for (const f of m.files ?? []) {
      if (f.created && !f.sha) {
        f.sha = sha256Head(f.path)
        changed = true
      }
    }
    if (changed) fs.writeFileSync(mFile, JSON.stringify(m, null, 1))
  } catch {}
  void cwd
}

/** Restore one checkpoint object (from listCheckpoints) and consume it.
 *  Returns {id, files, notes} | null. Shared by restoreLast and restoreRun. */
function restoreOne(c) {
  let restored = 0
  const notes = []
  try {
    for (const f of c.files) {
      if (f.created) {
        // file was CREATED by the checkpointed operation — remove it if unchanged
        if (fs.existsSync(f.path)) {
          const cur = sha256Head(f.path)
          if (f.sha && cur && f.sha === cur) {
            fs.unlinkSync(f.path)
            restored++
            notes.push(`removed created file ${path.basename(f.path)}`)
          } else {
            notes.push(`kept created file ${path.basename(f.path)} (modified since — not deleting)`)
          }
        } // already gone: nothing to do
        continue
      }
      if (f.tooLarge) {
        notes.push(`NOT restored ${path.basename(f.path)} — it is larger than ${Math.round(MAX_SNAPSHOT_BYTES / 1024 / 1024)}MB and was never snapshotted`)
        continue
      }
      const src = path.join(CHECKPOINTS_DIR, c.id, f.backup)
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(f.path), { recursive: true })
        // .bak.gz is v20.1+; a bare .bak is a pre-v20.1 checkpoint
        if (f.gz || f.backup.endsWith(".gz")) {
          fs.writeFileSync(f.path, zlib.gunzipSync(fs.readFileSync(src)))
        } else {
          fs.copyFileSync(src, f.path)
        }
        restored++
      }
    }
    fs.rmSync(path.join(CHECKPOINTS_DIR, c.id), { recursive: true, force: true })
  } catch {
    return null
  }
  return restored || notes.length ? { id: c.id, files: restored, notes } : null
}

/** Restore the newest checkpoint for cwd. Consumes it. Returns {id, files, notes} | null. */
export function restoreLast(cwd) {
  const found = listCheckpoints(cwd, 1)
  if (!found.length) return null
  return restoreOne(found[0])
}

/**
 * v20.2 (P3-4): restore an ENTIRE agent run atomically. Every checkpoint tagged
 * with the same runId is rolled back, newest→oldest, so files return to their
 * pre-run state even if the run touched one file several times. With no runId,
 * the most recent run for cwd is used. Returns
 * {runId, checkpoints, files, notes} | null.
 */
export function restoreRun(cwd, runId = null) {
  const all = listCheckpoints(cwd, 999)
  const rid = runId || all.find((c) => c.runId)?.runId
  if (!rid) return null
  const group = all.filter((c) => c.runId === rid) // already newest-first
  if (!group.length) return null
  let files = 0
  const notes = []
  let checkpoints = 0
  for (const c of group) {
    const r = restoreOne(c)
    if (r) { files += r.files; checkpoints++; for (const n of r.notes) notes.push(n) }
  }
  return checkpoints ? { runId: rid, checkpoints, files, notes } : null
}

/**
 * v20.5 (Phase 4): the files a run touched, absolute, deduplicated, each marked
 * with whether that run CREATED it. Checkpoint manifests are the authoritative
 * record of what changed — tool results are prose and cannot be trusted for it.
 */
export function filesFromRun(cwd, runId) {
  if (!runId) return []
  const seen = new Map()
  for (const c of listCheckpoints(cwd, 999)) {
    if (c.runId !== runId) continue
    for (const f of c.files ?? []) {
      // A file created and later edited in the same run is still a creation.
      const prev = seen.get(f.path)
      seen.set(f.path, { path: f.path, created: !!(prev?.created || f.created), tooLarge: !!f.tooLarge })
    }
  }
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * v20.5 (Phase 4): restore SEVERAL runs — every segment of one long-horizon
 * task — as a single rollback.
 *
 * Ordering is the whole correctness argument: checkpoints from all the runs are
 * gathered and replayed newest→oldest ACROSS runs, not run-by-run. Two segments
 * that both edited the same file must unwind in the reverse of the order they
 * were made, or the file ends up holding the older segment's content instead of
 * its true pre-task state.
 */
export function restoreRuns(cwd, runIds) {
  const wanted = new Set((runIds || []).filter(Boolean))
  if (!wanted.size) return null
  const group = listCheckpoints(cwd, 999).filter((c) => c.runId && wanted.has(c.runId)) // newest-first
  if (!group.length) return null
  let files = 0, checkpoints = 0
  const notes = []
  const runs = new Set()
  for (const c of group) {
    const r = restoreOne(c)
    if (r) { files += r.files; checkpoints++; runs.add(c.runId); for (const n of r.notes) notes.push(n) }
  }
  return checkpoints ? { runIds: [...runs], checkpoints, files, notes } : null
}

/** Newest-first checkpoints for cwd (or all if cwd is null). */
export function listCheckpoints(cwd, max = 10) {
  const out = []
  try {
    const dirs = fs
      .readdirSync(CHECKPOINTS_DIR)
      .filter((d) => !d.startsWith("."))
      .sort()
      .reverse()
    for (const d of dirs) {
      if (out.length >= max) break
      try {
        const m = JSON.parse(fs.readFileSync(path.join(CHECKPOINTS_DIR, d, "manifest.json"), "utf8"))
        if (cwd && path.resolve(m.cwd) !== path.resolve(cwd)) continue
        out.push({ id: m.id, ts: m.ts, cwd: m.cwd, runId: m.runId ?? null, files: m.files ?? [] })
      } catch {}
    }
  } catch {}
  return out
}

function dirBytes(dir) {
  let total = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      try {
        if (e.isDirectory()) walk(full)
        else total += fs.statSync(full).size
      } catch {}
    }
  }
  try {
    walk(dir)
  } catch {}
  return total
}

function prune() {
  try {
    const dirs = fs
      .readdirSync(CHECKPOINTS_DIR)
      .filter((d) => !d.startsWith("."))
      .sort()
    // v20.1: oldest-first by count…
    while (dirs.length > MAX_CHECKPOINTS) {
      fs.rmSync(path.join(CHECKPOINTS_DIR, dirs.shift()), { recursive: true, force: true })
    }
    // …and then by total size, so 30 compressed multi-MB checkpoints cannot
    // quietly eat half a disk.
    let guard = 0
    while (dirs.length > 1 && guard++ < MAX_CHECKPOINTS) {
      if (dirBytes(CHECKPOINTS_DIR) <= MAX_CHECKPOINT_DIR_BYTES) break
      fs.rmSync(path.join(CHECKPOINTS_DIR, dirs.shift()), { recursive: true, force: true })
    }
  } catch {}
}
