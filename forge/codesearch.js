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
 *   - pure read: this module never writes anything
 *
 * Zero dependencies: node:fs + retrieval.js only.
 */
import fs from "node:fs"
import path from "node:path"
import { isSourceFile, isConfigFile } from "./lang.js"
import { rankDocs, rankDocsHybrid } from "./retrieval.js"

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
  if (useCache) {
    if (chunkCache.size >= CHUNK_CACHE_MAX) {
      const oldest = chunkCache.keys().next().value
      chunkCache.delete(oldest)
    }
    chunkCache.set(f.full, { mtimeMs: st.mtimeMs, size: st.size, docs })
  }
  return docs
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

  const docs = []
  let chunksTruncated = false
  for (const f of files) {
    if (docs.length >= MAX_CHUNKS) { chunksTruncated = true; break }
    for (const d of chunksForFile(f)) {
      if (docs.length >= MAX_CHUNKS) { chunksTruncated = true; break }
      docs.push(d)
    }
  }
  if (!docs.length) return { ok: false, files: files.length, chunks: 0, truncated: false, mode: "none", hits: [], note: "files found but no content chunks" }

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
