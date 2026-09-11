/**
 * forge — graph-aware memory invalidation (v36, zero dependencies)
 *
 * UNIFIED §9 / §33 Memory ↔ World Model:
 *   Memory is historical knowledge. The v32 index + v33 graph is current truth.
 *   A note about util.js is stale when util.js *or a graph neighbor*
 *   (importer / consumer / test / implements) has a newer index mtime.
 *
 * Empty graph / no files / no index → not stale. Never invents a miss.
 * Does not rewrite memory.js storage (append / lock / provenance stay).
 * Does not import memory.js or index.js (those import this / each other).
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { DEFAULT_DIR } from "./config.js"
import { isStale, writesFromIndex } from "./evidence.js"
import { linkRecords, consumersOf, testsForFiles, implForFiles } from "./xlang.js"

const INDEX_VER = 1
const RADIUS_CAP = 48
const CITED_CAP = 8

const FILE_RE = /(?<![A-Za-z0-9_/:])((?:[\w.-]+\/)*[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|dart|zig|ex|sh|sql|tf|json|ya?ml|md))\b/gi

function posix(p) {
  return String(p || "").replace(/\\/g, "/")
}

function hashCwd(cwd) {
  return crypto.createHash("sha1").update(path.resolve(cwd || process.cwd())).digest("hex").slice(0, 12)
}

/** Best-effort v32 index read without importing index.js (cycle with memory.js). */
export function indexSnapshot(cwd = process.cwd()) {
  const v = process.env.FORGE_INDEX
  if (v === "0" || v === "false" || v === "off") return null
  try {
    const p = path.join(DEFAULT_DIR, "projects", hashCwd(cwd), "index.json")
    const idx = JSON.parse(fs.readFileSync(p, "utf8"))
    if (!idx || idx.version !== INDEX_VER || !idx.files || typeof idx.files !== "object" || Array.isArray(idx.files)) {
      return null
    }
    return idx
  } catch {
    return null
  }
}

/** Paths mentioned in a memory/lesson string. URLs and bare words are skipped. */
export function filesCited(text) {
  const s = String(text ?? "")
  if (!s.trim()) return []
  const urls = []
  const urlRe = /https?:\/\/[^\s)]+/gi
  let u
  while ((u = urlRe.exec(s))) urls.push([u.index, u.index + u[0].length])
  const inUrl = (i) => urls.some(([a, b]) => i >= a && i < b)
  const out = []
  const seen = new Set()
  FILE_RE.lastIndex = 0
  let m
  while ((m = FILE_RE.exec(s))) {
    if (inUrl(m.index)) continue
    const name = posix(m[1])
    if (name.includes("node_modules/")) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= CITED_CAP) break
  }
  return out
}

export function graphFromIndex(idx) {
  const files = idx && idx.files && typeof idx.files === "object" && !Array.isArray(idx.files) ? idx.files : null
  if (!files) return { files: [], edges: [], stats: { files: 0, edges: 0 } }
  const recs = []
  for (const [rel, rec] of Object.entries(files)) {
    if (!rel || !rec || typeof rec !== "object") continue
    recs.push({
      rel: posix(rel),
      lang: rec.lang || "unknown",
      symbols: rec.symbols || [],
      imports: rec.imports || [],
      test: !!rec.test,
      config: !!rec.config,
      contracts: Array.isArray(rec.contracts) ? rec.contracts : [],
    })
  }
  return linkRecords(recs)
}

/**
 * Files whose current truth is affected when `paths` change:
 * the files themselves, plus importers/consumers and tests.
 * Empty graph → just the files (v34 behaviour).
 */
export function radiusOf(paths, graph, { max = RADIUS_CAP } = {}) {
  const start = [...new Set((paths || []).map(posix).filter(Boolean))]
  if (!start.length) return []
  const out = new Set(start)
  if (!graph?.edges?.length && !graph?.files?.length) return [...out].slice(0, max)
  try {
    for (const p of consumersOf(start, graph)) {
      out.add(posix(p))
      if (out.size >= max) break
    }
    if (out.size < max) {
      for (const p of testsForFiles(start, graph)) {
        out.add(posix(p))
        if (out.size >= max) break
      }
    }
  } catch { /* miss → files only */ }
  return [...out].slice(0, max)
}

/** Implementation files the graph already linked from cited tests. */
export function implOf(paths, graph, { max = 8 } = {}) {
  if (!graph?.files?.length) return []
  try {
    return [...new Set(implForFiles(paths, graph).map(posix).filter(Boolean))].slice(0, max)
  } catch {
    return []
  }
}

/**
 * Stamp graph neighbors of a changed file with that file's mtime so
 * isStale(fact about app.js) fires when util.js (imported) moved.
 */
export function expandWrites(writes, graph, { max = RADIUS_CAP } = {}) {
  const src = writes && typeof writes === "object" && !Array.isArray(writes) ? writes : {}
  const keys = Object.keys(src)
  if (!keys.length) return {}
  if (!graph?.edges?.length && !graph?.files?.length) return { ...src }
  const out = { ...src }
  for (const [rel, mtime] of Object.entries(src)) {
    const t = Number(mtime)
    if (!Number.isFinite(t) || t <= 0) continue
    for (const n of radiusOf([rel], graph, { max })) {
      const cur = Number(out[n])
      if (!Number.isFinite(cur) || cur < t) out[n] = t
    }
  }
  return out
}

export function worldFromIndex(idx) {
  if (!idx || !idx.files) return { writes: {}, graph: { files: [], edges: [] } }
  const graph = graphFromIndex(idx)
  const writes = expandWrites(writesFromIndex(idx), graph)
  return { writes, graph }
}

export function worldFromCwd(cwd = process.cwd()) {
  const idx = indexSnapshot(cwd)
  return idx ? worldFromIndex(idx) : { writes: {}, graph: { files: [], edges: [] } }
}

export function entryAsOf(entry) {
  if (!entry || typeof entry !== "object") return 0
  const raw = entry.asOf
    ?? entry.lastUsed
    ?? entry.last_used
    ?? entry.firstSeen
    ?? entry.first_seen
    ?? entry.at
    ?? entry.provenance?.at
  if (raw == null) return 0
  if (typeof raw === "number" && Number.isFinite(raw)) return raw
  const t = Date.parse(raw)
  return Number.isFinite(t) ? t : 0
}

/**
 * Historical knowledge is stale against current truth.
 * No files / no asOf / no writes → not stale (never invent).
 */
export function entryIsStale(entry, { writes, graph, files } = {}) {
  if (!entry) return false
  const cited = Array.isArray(files) && files.length
    ? files.map(posix)
    : Array.isArray(entry.files) && entry.files.length
      ? entry.files.map(posix)
      : filesCited(entry.text || entry.l || entry.failure || "")
  if (!cited.length) return false
  const asOf = entryAsOf(entry)
  if (!asOf) return false
  let w = writes && typeof writes === "object" ? writes : {}
  if (graph && Object.keys(w).length) w = expandWrites(w, graph)
  if (!Object.keys(w).length) return false
  return isStale({ kind: "FACT", files: cited, asOf }, w)
}
