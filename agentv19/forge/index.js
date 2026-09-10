/**
 * forge — incremental code index (v32, zero dependencies)
 *
 * UNIFIED §23: persist file fingerprints (size + mtime) + extracted symbols
 * under ~/.forge/projects/<hash>/index.json. Unchanged files are not re-read.
 * Missing/corrupt cache → full parse, never a throw. FORGE_INDEX=0 disables
 * persist+reuse (always parse), the sandbox.js lesson: never fake a hit.
 *
 * The walk and skip-dirs stay in repomap.js. This module is load/save/hit.
 */
import fs from "node:fs"
import path from "node:path"
import { projectDir } from "./memory.js"
import { writeStateFile } from "./securefs.js"
import { extractRecord } from "./lang.js"

export const INDEX_VERSION = 1

export function indexEnabled() {
  const v = process.env.FORGE_INDEX
  if (v === "0" || v === "false" || v === "off") return false
  return true
}

export function indexPath(root) {
  return path.join(projectDir(root), "index.json")
}

export function emptyIndex() {
  return { version: INDEX_VERSION, files: {} }
}

export function loadIndex(root) {
  if (!indexEnabled()) return emptyIndex()
  try {
    const j = JSON.parse(fs.readFileSync(indexPath(root), "utf8"))
    if (!j || j.version !== INDEX_VERSION || !j.files || typeof j.files !== "object" || Array.isArray(j.files)) {
      return emptyIndex()
    }
    return j
  } catch {
    return emptyIndex()
  }
}

export function saveIndex(root, idx) {
  if (!indexEnabled()) return false
  try {
    const payload = {
      version: INDEX_VERSION,
      root: path.resolve(root || process.cwd()),
      updatedAt: Date.now(),
      files: idx?.files && typeof idx.files === "object" ? idx.files : {},
    }
    writeStateFile(indexPath(root), JSON.stringify(payload) + "\n")
    return true
  } catch {
    return false
  }
}

export function fingerprint(st) {
  return { size: Number(st.size) || 0, mtime: Math.round(Number(st.mtimeMs) || 0) }
}

export function cacheHit(cached, st) {
  if (!cached || !st) return false
  const fp = fingerprint(st)
  return cached.size === fp.size && cached.mtime === fp.mtime && Array.isArray(cached.symbols)
}

export function recordFromSource(file, src, fullPath, st) {
  const fp = fingerprint(st)
  const rec = extractRecord(file, src, fullPath)
  return { ...fp, ...rec }
}

export function invalidate(root, rels = []) {
  const idx = loadIndex(root)
  let n = 0
  for (const rel of rels) {
    const k = String(rel || "").replace(/\\/g, "/")
    if (k && idx.files[k]) { delete idx.files[k]; n++ }
  }
  if (n) saveIndex(root, idx)
  return n
}
