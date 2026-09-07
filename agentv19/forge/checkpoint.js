/**
 * forge — checkpoints (v16 hardened v20, hardened v23): automatic file snapshots before mutations.
 *
 * Every write tool snapshots the original file(s) BEFORE changing them:
 *
 *   ~/.forge/checkpoints/<id>/manifest.json   { id, ts, cwd, runId, files: [{ path, backup, sha, size, mtime }] }
 *   ~/.forge/checkpoints/<id>/<n>.bak         original file contents
 *   ~/.forge/checkpoints/<id>/<n>.bak.gz      …gzip'ed when larger than 256 KB
 *
 * v23 hardening:
 *  - full SHA-256 integrity, not just first 1 MB — detects modifications anywhere
 *  - chunked full-file hashing for large files (no OOM)
 *  - records size, hash, mtime, checkpoint ID, run ID
 *  - restore verification detects modifications anywhere in file
 *  - sealCreated stores full hash for created files
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import zlib from "node:zlib"
import { execFileSync } from "node:child_process"
import { DEFAULT_DIR } from "./config.js"

export const CHECKPOINTS_DIR = path.join(DEFAULT_DIR, "checkpoints")
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
const COMPRESS_OVER_BYTES = 256 * 1024
const MAX_CHECKPOINTS = 30
const MAX_CHECKPOINT_DIR_BYTES = 512 * 1024 * 1024

/**
 * Full-file SHA-256 with chunked reading (no OOM, detects modifications anywhere).
 * Returns { sha, size, mtime } or null on failure.
 */
export function fullFileHash(file) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return null
    const hash = crypto.createHash("sha256")
    const fd = fs.openSync(file, "r")
    try {
      const buf = Buffer.alloc(64 * 1024)
      let bytesRead = 0
      let pos = 0
      while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) {
        hash.update(buf.subarray(0, bytesRead))
        pos += bytesRead
      }
      return { sha: hash.digest("hex"), size: st.size, mtime: st.mtimeMs }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

// Backward compat: old name now delegates to full hash
function sha256Head(file) {
  const info = fullFileHash(file)
  return info?.sha ?? null
}

function fileInfo(file) {
  const info = fullFileHash(file)
  if (!info) return null
  return { sha: info.sha, size: info.size, mtime: info.mtime }
}

export function snapshotBefore(files, cwd, created = [], runId = null) {
  try {
    const tooLarge = []
    const want = [...new Set((files || []).map((f) => path.resolve(f)))].filter((f) => {
      try {
        const st = fs.statSync(f)
        if (!st.isFile()) return false
        if (st.size > MAX_SNAPSHOT_BYTES) { tooLarge.push(f); return false }
        return true
      } catch {
        return false
      }
    })
    const creating = [...new Set((created || []).map((f) => path.resolve(f)))].filter((f) => {
      try { fs.accessSync(f); return false } catch { return true }
    })
    if (!want.length && !creating.length && !tooLarge.length) return null
    const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + Math.random().toString(36).slice(2, 6)
    const dir = path.join(CHECKPOINTS_DIR, id)
    fs.mkdirSync(dir, { recursive: true })
    const manifest = { id, ts: Date.now(), cwd: path.resolve(cwd || process.cwd()), ...(runId ? { runId } : {}), files: [] }
    want.forEach((f, i) => {
      let backup = String(i) + ".bak"
      let gz = false
      let info = null
      try {
        const st = fs.statSync(f)
        info = { size: st.size, mtime: st.mtimeMs, sha: fullFileHash(f)?.sha ?? null }
      } catch {}
      const size = info?.size ?? 0
      if (size > COMPRESS_OVER_BYTES) {
        backup += ".gz"
        gz = true
        try {
          fs.writeFileSync(path.join(dir, backup), zlib.gzipSync(fs.readFileSync(f), { level: 6 }))
        } catch {
          fs.copyFileSync(f, path.join(dir, backup))
          gz = false
          backup = backup.replace(/\.gz$/, "")
        }
      } else {
        try { fs.copyFileSync(f, path.join(dir, backup)) } catch {}
      }
      manifest.files.push({
        path: f,
        backup,
        ...(gz ? { gz: true } : {}),
        ...(info ? { sha: info.sha, size: info.size, mtime: info.mtime } : {}),
      })
    })
    creating.forEach((f) => {
      manifest.files.push({ path: f, backup: null, created: true })
    })
    tooLarge.forEach((f) => {
      const info = fileInfo(f)
      manifest.files.push({ path: f, backup: null, tooLarge: true, ...(info ? { size: info.size, sha: info.sha, mtime: info.mtime } : {}) })
    })
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 1))
    prune()
    return id
  } catch {
    return null
  }
}

export function boundaryCheckpoint(cwd = process.cwd(), { runId = null, label = null, objective = null } = {}) {
  try {
    let head = null
    try { head = execFileSync("git", ["-C", path.resolve(cwd), "rev-parse", "HEAD"], { encoding: "utf8" }).trim() } catch { }
    const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + Math.random().toString(36).slice(2, 6)
    const dir = path.join(CHECKPOINTS_DIR, id)
    fs.mkdirSync(dir, { recursive: true })
    const manifest = {
      id, ts: Date.now(), cwd: path.resolve(cwd), boundary: true,
      ...(runId ? { runId } : {}), ...(label ? { label } : {}), ...(objective ? { objective: String(objective).slice(0, 300) } : {}),
      ...(head ? { gitHead: head } : {}),
      files: [],
    }
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 1))
    prune()
    return id
  } catch {
    return null
  }
}

export function sealCreated(checkpointId, cwd) {
  try {
    if (!checkpointId) return
    const dir = path.join(CHECKPOINTS_DIR, checkpointId)
    const mFile = path.join(dir, "manifest.json")
    const m = JSON.parse(fs.readFileSync(mFile, "utf8"))
    let changed = false
    for (const f of m.files ?? []) {
      if (f.created && !f.sha) {
        const info = fullFileHash(f.path)
        if (info) {
          f.sha = info.sha
          f.size = info.size
          f.mtime = info.mtime
          changed = true
        }
      }
    }
    if (changed) fs.writeFileSync(mFile, JSON.stringify(m, null, 1))
  } catch {}
  void cwd
}

function restoreOne(c) {
  let restored = 0
  const notes = []
  try {
    for (const f of c.files) {
      if (f.created) {
        if (fs.existsSync(f.path)) {
          const cur = fullFileHash(f.path)
          if (f.sha && cur && f.sha === cur.sha) {
            fs.unlinkSync(f.path)
            restored++
            notes.push(`removed created file ${path.basename(f.path)}`)
          } else {
            // full hash mismatch means file modified anywhere, not just first 1MB
            notes.push(`kept created file ${path.basename(f.path)} (modified since — not deleting, full SHA-256 mismatch)`)
          }
        }
        continue
      }
      if (f.tooLarge) {
        notes.push(`NOT restored ${path.basename(f.path)} — it is larger than ${Math.round(MAX_SNAPSHOT_BYTES / 1024 / 1024)}MB and was never snapshotted (size=${f.size ?? "?"}, sha=${(f.sha ?? "").slice(0, 8)})`)
        continue
      }
      const src = path.join(CHECKPOINTS_DIR, c.id, f.backup)
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(f.path), { recursive: true })
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

export function restoreLast(cwd) {
  const found = listCheckpoints(cwd, 1)
  if (!found.length) return null
  return restoreOne(found[0])
}

export function restoreRun(cwd, runId = null) {
  const all = listCheckpoints(cwd, 999)
  const rid = runId || all.find((c) => c.runId)?.runId
  if (!rid) return null
  const group = all.filter((c) => c.runId === rid)
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
        out.push({ id: m.id, ts: m.ts, cwd: m.cwd, runId: m.runId ?? null, files: m.files ?? [], boundary: !!m.boundary, label: m.label ?? null, gitHead: m.gitHead ?? null })
      } catch {}
    }
  } catch {}
  return out
}

/** Verify integrity of a checkpoint manifest against actual backup files (full SHA-256). */
export function verifyCheckpointIntegrity(checkpointId) {
  try {
    const dir = path.join(CHECKPOINTS_DIR, checkpointId)
    const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"))
    const issues = []
    for (const f of m.files ?? []) {
      if (f.created || f.tooLarge) continue
      const src = path.join(dir, f.backup)
      if (!fs.existsSync(src)) {
        issues.push(`missing backup for ${f.path}`)
        continue
      }
      // verify backup file hash matches recorded sha if present
      if (f.sha) {
        let backupData
        try {
          if (f.gz || f.backup.endsWith(".gz")) backupData = zlib.gunzipSync(fs.readFileSync(src))
          else backupData = fs.readFileSync(src)
          const sha = crypto.createHash("sha256").update(backupData).digest("hex")
          if (sha !== f.sha) issues.push(`backup hash mismatch for ${f.path}: expected ${f.sha.slice(0, 8)}, got ${sha.slice(0, 8)}`)
        } catch (e) {
          issues.push(`cannot verify backup for ${f.path}: ${e.message}`)
        }
      }
    }
    return { ok: issues.length === 0, issues, id: checkpointId, files: m.files?.length ?? 0 }
  } catch (e) {
    return { ok: false, issues: [String(e.message)], id: checkpointId }
  }
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
  try { walk(dir) } catch {}
  return total
}

function prune() {
  try {
    const dirs = fs
      .readdirSync(CHECKPOINTS_DIR)
      .filter((d) => !d.startsWith("."))
      .sort()
    while (dirs.length > MAX_CHECKPOINTS) {
      fs.rmSync(path.join(CHECKPOINTS_DIR, dirs.shift()), { recursive: true, force: true })
    }
    let guard = 0
    while (dirs.length > 1 && guard++ < MAX_CHECKPOINTS) {
      if (dirBytes(CHECKPOINTS_DIR) <= MAX_CHECKPOINT_DIR_BYTES) break
      fs.rmSync(path.join(CHECKPOINTS_DIR, dirs.shift()), { recursive: true, force: true })
    }
  } catch {}
}

export { sha256Head }
