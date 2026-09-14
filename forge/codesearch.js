/**
 * forge — semantic code search (v93 "sensewise")
 *
 * grep_files finds LITERAL text. This module finds code by MEANING: every
 * source file is chunked into line windows, each chunk is scored against the
 * query with BM25 (retrieval.js — the same battle-tested ranker behind the
 * repo map and memory), and, when the run resolved an embeddings provider
 * (agent.js injects `embed`), the BM25 shortlist is reranked with the
 * BM25+cosine hybrid. Every embedding failure degrades to plain BM25 —
 * search can never break because of the network (retrieval.js contract).
 *
 * Honesty rules:
 *   - a truncated scan (chunk cap hit) is REPORTED, never silent
 *   - zero hits says so and points at grep_files
 *   - scores are the real BM25/hybrid scores, not decorated
 *   - the repository itself is pure read: this module NEVER writes inside the
 *     project. v94 gapclose (TODO semantic_search): the chunk cache persists
 *     OUTSIDE the repo, in the project's forge state dir
 *     (~/.forge/projects/<hash>/semantic-index.json), fingerprint-invalidated
 *     per file (mtime+size) exactly like the world model — a fresh process
 *     reuses the chunks of every unchanged file instead of re-reading and
 *     re-chunking the whole repository. FORGE_INDEX=0 disables the persistent
 *     index together with the in-memory cache. Every result carries its real
 *     `index` stats (loadedFromDisk / rebuilt / saved), never decorated.
 *
 * Zero dependencies: node:fs + retrieval.js + forge state helpers only.
 */
import fs from "node:fs"
import path from "node:path"
import { isSourceFile, isConfigFile } from "./lang.js"
import { rankDocs, rankDocsHybrid } from "./retrieval.js"
import { projectDir } from "./memory.js"
import { writeStateFile } from "./securefs.js"

const SKIP = new Set([
  "node_modules", ".git", ".hg", ".svn", ".next", ".nuxt", ".svelte-kit",
  "dist", "build", "coverage", "__pycache__", ".turbo", ".cache",
  ".venv", "venv", ".mypy_cache", ".pytest_cache", ".gradle", ".forge",
])

const MAX_FILES = 400
const MAX_BYTES_PER_FILE = 128 * 1024
const MAX_DEPTH = 8
const CHUNK_LINES = 60
const MAX_CHUNKS = 5000
const SHORTLIST = 40
const DEFAULT_LIMIT = 8
const SNIPPET_LINES = 6
const SNIPPET_LINE_CHARS = 160

function gitignoreDirs(root) {
  const out = new Set()
  try {
    for (let line of fs.readFileSync(path.join(root, ".gitignore"), "utf8").split("\n")) {
      line = line.trim()
      if (!line || line.startsWith("#") || line.startsWith("!")) continue
      const name = line.replace(/^\/+/, "").replace(/\/+$/, "")
      if (name && !name.includes("/") && !/[*?\[\]]/.test(name)) out.add(name)
    }
  } catch {}
  return out
}

/** Collect source/config files (bounded, gitignore-aware). Pure read. */
function collectFiles(root, { maxFiles = MAX_FILES, maxBytesPerFile = MAX_BYTES_PER_FILE } = {}) {
  const files = []
  let scanned = 0
  let truncated = false
  const skip = new Set([...SKIP, ...gitignoreDirs(root)])
  const walk = (dir, depth) => {
    if (scanned >= maxFiles || depth > MAX_DEPTH) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (scanned >= maxFiles) { truncated = true; return }
      if (skip.has(e.name)) continue
      if (e.name.startsWith(".") && e.name !== ".") continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      if (!isSourceFile(e.name) && !isConfigFile(e.name)) continue
      let st
      try { st = fs.statSync(full) } catch { continue }
      if (st.size > maxBytesPerFile) continue
      scanned++
      files.push({ full, rel: path.relative(root, full) })
    }
  }
  walk(root, 0)
  return { files, truncated }
}

/** Split a file into ~CHUNK_LINES line windows. Returns [{ start, end, lines }]. */
function chunkLines(text) {
  const all = String(text ?? "").split("\n")
  const chunks = []
  for (let i = 0; i < all.length; i += CHUNK_LINES) {
    const slice = all.slice(i, i + CHUNK_LINES)
    if (!slice.join("").trim()) continue // skip blank-only windows
    chunks.push({ start: i + 1, end: i + slice.length, lines: slice })
  }
  return chunks
}

function snippetOf(lines) {
  const picked = []
  for (const l of lines) {
    const t = l.replace(/\t/g, "  ").trim()
    if (!t) continue
    picked.push(t.length > SNIPPET_LINE_CHARS ? t.slice(0, SNIPPET_LINE_CHARS - 1) + "…" : t)
    if (picked.length >= SNIPPET_LINES) break
  }
  return picked
}

// v94 masterwise (§5 LOCAL SEARCH): an incremental per-file chunk cache.
// A repository search re-chunks every file on every call; with the cache a
// second search (or any later call in the same process) re-uses the chunks of
// every UNCHANGED file (mtime+size fingerprint — the same discipline as the
// v32 index) and only reads/re-chunks what actually changed. Bounded (FIFO
// eviction); a changed file re-chunks, so staleness is impossible; the cache
// is pure-read and never reported as hits. FORGE_INDEX=0 disables it, exactly
// like the persistent index.
const CHUNK_CACHE_MAX = 4000
const chunkCache = new Map() // full path -> { mtimeMs, size, docs }
export function chunkCacheSize() { return chunkCache.size }
/** Counts REAL cache-miss rebuilds (file read + re-chunk) — the dirty signal
 *  for the persistent index; surfaced honestly per result as `index.rebuilt`. */
let chunkRebuilds = 0
function chunksForFile(f) {
  const useCache = process.env.FORGE_INDEX !== "0"
  let st = null
  try { st = fs.statSync(f.full) } catch { return [] }
  if (useCache) {
    const hit = chunkCache.get(f.full)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.docs
  }
  let src
  try { src = fs.readFileSync(f.full, "utf8") } catch { return [] }
  const docs = []
  for (const c of chunkLines(src)) {
    docs.push({ text: `${f.rel}\n${c.lines.join("\n")}`, ref: { path: f.rel, start: c.start, end: c.end, snippet: snippetOf(c.lines) } })
  }
  chunkRebuilds++
  if (useCache) {
    if (chunkCache.size >= CHUNK_CACHE_MAX) {
      const oldest = chunkCache.keys().next().value
      chunkCache.delete(oldest)
    }
    chunkCache.set(f.full, { mtimeMs: st.mtimeMs, size: st.size, docs })
  }
  return docs
}

// ---------------------------------------------------------------------------
// v94 gapclose (TODO semantic_search) — PERSISTENT chunk index.
//
// The BM25 corpus (per-file line-window chunks) was rebuilt from scratch in
// every process: on a large repo the first semantic_search of every run paid
// the full read+chunk cost again. The index file stores the SAME per-file
// chunk docs the in-memory cache holds, keyed by the project's forge state
// dir (one file per project root — docs carry root-RELATIVE refs, so entries
// must never migrate between roots; the stored `root` field is checked on
// load). Invalidation is per-file fingerprint (mtime+size), exactly like the
// world model: a changed file re-chunks from source, an unchanged file is
// reused. Bounded on both ends (CHUNK_CACHE_MAX entries, INDEX_MAX_BYTES on
// disk — an oversize index is skipped, never truncated into a lie).
// ---------------------------------------------------------------------------
const INDEX_FILE = "semantic-index.json"
const INDEX_VERSION = 1
const INDEX_MAX_BYTES = 24 * 1024 * 1024
const loadedRoots = new Map() // resolved root -> { loaded, at }

function indexPathFor(root) {
  return path.join(projectDir(root), INDEX_FILE)
}

/** Seed the in-memory cache from disk. Once per process per root; per-file
 *  fingerprints decide reuse — a stale entry is simply not loaded. */
function loadPersistentChunks(root, files) {
  if (process.env.FORGE_INDEX === "0") return { persistent: false, loaded: 0 }
  const prev = loadedRoots.get(root)
  if (prev) return { persistent: true, loaded: prev.loaded }
  let loaded = 0
  try {
    const file = indexPathFor(root)
    const st = fs.statSync(file)
    if (st.size <= INDEX_MAX_BYTES) {
      const j = JSON.parse(fs.readFileSync(file, "utf8"))
      if (j?.v === INDEX_VERSION && j.root === root && j.entries && typeof j.entries === "object") {
        for (const f of files) {
          if (chunkCache.size >= CHUNK_CACHE_MAX) break
          if (chunkCache.has(f.full)) continue // already fresh in memory
          const ent = j.entries[f.full]
          if (!ent || !Array.isArray(ent.docs)) continue
          let fst = null
          try { fst = fs.statSync(f.full) } catch { continue }
          if (fst.mtimeMs !== ent.mtimeMs || fst.size !== ent.size) continue // fingerprint drift — rebuild from source
          chunkCache.set(f.full, { mtimeMs: ent.mtimeMs, size: ent.size, docs: ent.docs })
          loaded++
        }
      }
    }
  } catch { /* no index yet / unreadable / corrupt — rebuild from source, honestly */ }
  loadedRoots.set(root, { loaded, at: Date.now() })
  return { persistent: true, loaded }
}

/** Persist the current chunks for this root's collected files. Atomic write;
 *  honest skip reasons (disabled / empty / oversize / IO error). */
function savePersistentChunks(root, files) {
  if (process.env.FORGE_INDEX === "0") return { saved: false, skipped: "disabled (FORGE_INDEX=0)" }
  const entries = {}
  let n = 0
  for (const f of files) {
    const hit = chunkCache.get(f.full)
    if (!hit) continue
    entries[f.full] = { mtimeMs: hit.mtimeMs, size: hit.size, docs: hit.docs }
    n++
  }
  if (!n) return { saved: false, skipped: "no cached chunks to persist" }
  try {
    const text = JSON.stringify({ v: INDEX_VERSION, root, updatedAt: Date.now(), entries })
    if (text.length > INDEX_MAX_BYTES) return { saved: false, skipped: `index would exceed ${Math.round(INDEX_MAX_BYTES / 1024 / 1024)}MB — not persisted (in-memory cache still active)` }
    const file = indexPathFor(root)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    writeStateFile(file, text)
    return { saved: true, entries: n }
  } catch (e) {
    return { saved: false, skipped: `write failed: ${String(e?.message ?? e).slice(0, 100)}` }
  }
}

/** Where the persistent index lives (doctor/tests). */
export function persistentIndexPath(root) {
  return indexPathFor(path.resolve(String(root || process.cwd())))
}

/**
 * Search a project root by meaning. opts:
 *   limit, maxFiles, maxBytesPerFile, embed (async fn), alpha, budgetMs
 * Returns { ok, hits, files, chunks, truncated, mode }.
 * hits: [{ path, start, end, score, scoreDetail?, snippet: [] }]
 */
export async function semanticSearch(root, query, {
  limit = DEFAULT_LIMIT,
  maxFiles = MAX_FILES,
  maxBytesPerFile = MAX_BYTES_PER_FILE,
  embed = null,
  alpha,
  budgetMs = 4000,
} = {}) {
  const q = String(query ?? "").trim()
  const base = path.resolve(String(root || process.cwd()))
  const { files, truncated: filesTruncated } = collectFiles(base, { maxFiles, maxBytesPerFile })
  if (!files.length) return { ok: false, files: 0, chunks: 0, truncated: false, mode: "none", hits: [], note: `no source/config files under ${path.basename(base)} — nothing to search` }
  if (!q) return { ok: false, files: files.length, chunks: 0, truncated: false, mode: "none", hits: [], note: "empty query" }

  // v94 gapclose: seed the chunk cache from the persistent index (per-file
  // fingerprint decides reuse) and count what genuinely had to be rebuilt.
  const loaded = loadPersistentChunks(base, files)
  const rebuildsBefore = chunkRebuilds

  const docs = []
  let chunksTruncated = false
  for (const f of files) {
    if (docs.length >= MAX_CHUNKS) { chunksTruncated = true; break }
    for (const d of chunksForFile(f)) {
      if (docs.length >= MAX_CHUNKS) { chunksTruncated = true; break }
      docs.push(d)
    }
  }
  const rebuilt = chunkRebuilds - rebuildsBefore
  // persist only when something changed (or no index exists yet) — an
  // unchanged repo never re-writes its index
  let save = { saved: false, skipped: "up to date" }
  if (loaded.persistent && (rebuilt > 0 || !fs.existsSync(indexPathFor(base)))) save = savePersistentChunks(base, files)
  const indexStats = { persistent: loaded.persistent, loadedFromDisk: loaded.loaded, rebuilt, saved: save.saved === true, entries: save.entries ?? 0, ...(save.skipped ? { saveSkipped: save.skipped } : {}) }
  if (!docs.length) return { ok: false, files: files.length, chunks: 0, truncated: false, mode: "none", hits: [], note: "files found but no content chunks", index: indexStats }

  // BM25 orders EVERYTHING (offline, cheap). Embeddings only RERANK the
  // shortlist — they never widen it (the repomap contract), so the embed call
  // stays bounded at SHORTLIST+1 texts no matter how large the repo is.
  const bm = rankDocs(q, docs)
  let ranked
  let mode = "bm25"
  if (typeof embed === "function" && bm.length) {
    const shortlist = bm.slice(0, SHORTLIST)
    ranked = await rankDocsHybrid(q, shortlist, { embed, alpha, budgetMs })
    mode = ranked[0]?.scoreDetail?.mode ?? "hybrid"
  } else {
    ranked = bm
  }

  const lim = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), 30)
  let top = ranked.slice(0, lim)
  // BM25 modes: a 0 score means ZERO term overlap — returning it as a "hit"
  // would be noise (grep does not list non-matching files). Hybrid modes
  // normalize scores, so the shortlist members are all genuine candidates.
  if (mode !== "hybrid") top = top.filter((r) => (Number(r.score) || 0) > 0)
  const hits = top.map((r) => ({
    path: r.ref?.path ?? "?",
    start: r.ref?.start ?? 0,
    end: r.ref?.end ?? 0,
    score: Math.round((Number(r.score) || 0) * 1000) / 1000,
    snippet: r.ref?.snippet ?? [],
  }))

  return {
    ok: hits.length > 0,
    files: files.length,
    chunks: docs.length,
    truncated: filesTruncated || chunksTruncated,
    mode,
    hits,
    index: indexStats,
    note: hits.length ? "" : `no chunk scored above zero for "${q}" — try more specific terms, or grep_files for exact text`,
  }
}

/** Render a search result as the tool-facing text (bounded, honest). */
export function formatSemanticSearch(result, query) {
  if (!result || typeof result !== "object") return "ERROR: no search result"
  const head = `SEMANTIC SEARCH "${String(query ?? "").slice(0, 120)}" — ${result.hits?.length ?? 0} hit(s) in ${result.files ?? 0} file(s), ${result.chunks ?? 0} chunk(s) [${result.mode ?? "?"}]${result.truncated ? " (scan truncated at bounds — deepest/rarest code may be missing)" : ""}`
  if (!result.ok || !result.hits?.length) return `${head}\n${result.note ?? "no matches"}`
  const lines = [head]
  for (const h of result.hits) {
    lines.push(`${h.path}:${h.start}-${h.end}  (score ${h.score})`)
    for (const s of h.snippet) lines.push(`  | ${s}`)
  }
  return lines.join("\n")
}
