/**
 * forge — hierarchical memory (v20 tiers, v21.1 storage pipeline + provenance).
 *
 *   GLOBAL  ~/.forge/memory.md                     user preferences, durable facts
 *   PROJECT ~/.forge/projects/<hash>/memory.md     per-project notes + learned fixes
 *   TASK    the session file itself (messages + rolling summary)
 *
 * v19 dumped up to 2000 chars of the global file into EVERY system prompt.
 * v20 retrieves by relevance instead: lines are scored against the current
 * query (task / user message) and only the top matches are injected, from
 * BOTH tiers, deduplicated, capped. Writes go through secret redaction so
 * credentials never land in long-term memory.
 *
 * v21.1: ONE storage pipeline. Every mutation (append / learn / forget / prune
 * / replace) goes through `writeMemoryFile`: the file's real path is resolved
 * (a user's symlinked memory.md keeps working), the new content is written to
 * a temp file next to it, fsynced and renamed into place, mode 0600. A crash
 * or a concurrent writer can no longer leave a half-written or interleaved
 * memory file; the last complete write wins as a unit. Every entry also
 * carries PROVENANCE — who stored it (cli / tool / agent / …), when, and from
 * which run — on a comment line directly above it:
 *
 *   <!-- forge: source=tool at=2026-09-07T10:00:00.000Z run=r-abc -->
 *   - prefer tabs
 *
 * Comment lines are never injected into prompts and never scored; they travel
 * with their entry through forget / prune, and files written by older
 * versions (no comments) read exactly as before.
 *
 * Everything here is best-effort: a broken memory can never break the CLI.
 */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { DEFAULT_DIR } from "./config.js"
import { redact } from "./secrets.js"
import { rankDocs, rankDocsHybrid } from "./retrieval.js"
import { entryIsStale, worldFromCwd } from "./memgraph.js"

export const GLOBAL_MEMORY_PATH = path.join(DEFAULT_DIR, "memory.md")
export const PROJECTS_DIR = path.join(DEFAULT_DIR, "projects")

export function projectHash(cwd) {
  return crypto.createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 12)
}

export function projectDir(cwd) {
  return path.join(PROJECTS_DIR, projectHash(cwd))
}

export function projectMemoryPath(cwd) {
  return path.join(projectDir(cwd), "memory.md")
}

// --- reading ----------------------------------------------------------------

/** Provenance comment line: `<!-- forge: k=v k=v -->` (never injected/scored). */
const PROVENANCE_RE = /^\s*<!--\s*forge:\s*(.*?)\s*-->\s*$/
export const MEMORY_SOURCES = new Set(["cli", "tool", "agent", "subagent", "repair", "import", "unknown"])

export function formatProvenance(p = {}) {
  const source = MEMORY_SOURCES.has(p.source) ? p.source : "unknown"
  const ts = p.at != null && !Number.isNaN(new Date(p.at).getTime()) ? new Date(p.at) : new Date()
  const at = ts.toISOString()
  const parts = [`source=${source}`, `at=${at}`]
  if (p.runId) parts.push(`run=${String(p.runId).replace(/[\s>]/g, "_").slice(0, 40)}`)
  if (p.model) parts.push(`model=${String(p.model).replace(/[\s>]/g, "_").slice(0, 40)}`)
  return `<!-- forge: ${parts.join(" ")} -->`
}

export function parseProvenance(line) {
  const m = PROVENANCE_RE.exec(String(line ?? ""))
  if (!m) return null
  const out = { source: "unknown", at: null, runId: null, model: null }
  for (const kv of m[1].split(/\s+/)) {
    const i = kv.indexOf("=")
    if (i < 1) continue
    const k = kv.slice(0, i), v = kv.slice(i + 1)
    if (k === "source" && MEMORY_SOURCES.has(v)) out.source = v
    else if (k === "at" && !Number.isNaN(Date.parse(v))) out.at = v
    else if (k === "run") out.runId = v
    else if (k === "model") out.model = v
  }
  return out
}

function readLines(p) {
  try {
    const raw = fs.readFileSync(p, "utf8")
    return raw.split("\n").filter((l) => !PROVENANCE_RE.test(l)).map((l) => l.replace(/^[-•*]\s+/, "").trim()).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * v21.1 — the ONE write path for memory files: resolve the real target (so a
 * symlinked memory.md is honoured, but never a symlink swapped in at write
 * time), write to a temp file in the same directory, fsync, rename over the
 * target, fsync the directory. Mode 0600: memory may hold personal notes.
 */
/**
 * Advisory lock around a memory file's read-modify-write. Created with
 * O_EXCL (atomic on every platform), holds the owner pid + time; a lock older
 * than LOCK_STALE_MS whose owner is gone is broken. Waits synchronously
 * (Atomics.wait) up to LOCK_WAIT_MS — the memory layer is sync by contract.
 */
const LOCK_WAIT_MS = 3000
const LOCK_STALE_MS = 10_000
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch {} }
function pidAlive(pid) { try { process.kill(pid, 0); return true } catch (e) { return e?.code === "EPERM" } }

const HELD_LOCKS = new Set()
export function withMemoryLock(file, fn) {
  if (HELD_LOCKS.has(file)) return fn() // re-entrant within this process (appendMemory → appendEntry)
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const lock = path.join(dir, `.${path.basename(file)}.lock`)
  const deadline = Date.now() + LOCK_WAIT_MS
  let fd = null
  for (;;) {
    try { fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600); break } catch (e) {
      if (e?.code !== "EEXIST") throw e
      // stale? (owner dead, or lock much older than any legitimate hold)
      try {
        const st = fs.statSync(lock)
        const owner = Number((() => { try { return fs.readFileSync(lock, "utf8").split(" ")[0] } catch { return "" } })())
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS || (owner && owner !== process.pid && !pidAlive(owner))) { try { fs.unlinkSync(lock) } catch {}; continue }
      } catch { continue }
      if (Date.now() > deadline) throw new Error(`memory file is locked by another writer: ${lock}`)
      sleepSync(5 + Math.floor(Math.random() * 10))
    }
  }
  try { fs.writeSync(fd, `${process.pid} ${Date.now()}`) } catch {}
  HELD_LOCKS.add(file)
  try { return fn() } finally {
    HELD_LOCKS.delete(file)
    try { fs.closeSync(fd) } catch {}
    try { fs.unlinkSync(lock) } catch {}
  }
}

export function writeMemoryFile(file, text) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  let target = file
  try { target = fs.realpathSync(file) } catch { /* absent: create in place */ }
  const tdir = path.dirname(target)
  let st = null
  try { st = fs.lstatSync(target) } catch {}
  if (st && !st.isFile()) throw new Error(`memory path is not a regular file: ${target}`)
  const tmp = path.join(tdir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`)
  let fd = null
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    const buf = Buffer.from(String(text ?? ""), "utf8")
    let off = 0
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off)
    fs.fsyncSync(fd)
    fs.closeSync(fd); fd = null
    fs.renameSync(tmp, target)
    try { const dfd = fs.openSync(tdir, "r"); try { fs.fsyncSync(dfd) } finally { fs.closeSync(dfd) } } catch {}
    return target
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
    try { fs.unlinkSync(tmp) } catch {}
    throw e
  }
}

// v20.2 (P3-2): relevance scoring moved to retrieval.js (BM25). The old
// token-overlap helpers (words/score) were retired with that switch.

/** Both memory tiers as one scored-at-read pool (400 lines per tier cap). */
export function memoryPool(cwd = process.cwd()) {
  const global = memoryEntries("global", cwd).slice(0, 400)
  const project = memoryEntries("project", cwd).slice(0, 400)
  return [
    ...global.map((e) => ({ l: e.text, tier: "global", provenance: e.provenance || null })),
    ...project.map((e) => ({ l: e.text, tier: "project", provenance: e.provenance || null })),
  ]
}

function livePool(pool, cwd, opts = {}) {
  const writes = opts.writes
  const graph = opts.graph
  const world = (writes && typeof writes === "object")
    ? { writes, graph: graph || { files: [], edges: [] } }
    : worldFromCwd(cwd)
  if (!Object.keys(world.writes || {}).length) return pool
  return pool.filter((e) => e.tier === "global" || !entryIsStale({ text: e.l, l: e.l, provenance: e.provenance }, world))
}

/** BM25 shortlist over the pool: pool entries ordered by score > 0. */
function bm25Shortlist(query, pool, cap = Infinity) {
  return rankDocs(query, pool.map((e, i) => ({ i, text: e.l })))
    .filter((r) => r.score > 0)
    .slice(0, cap)
    .map((r) => pool[r.i])
}

/** Deduplicate (near-)identical lines and cap the pick count. */
function dedupePick(entries, limit) {
  const seen = new Set()
  const picked = []
  for (const e of entries) {
    const key = e.l.toLowerCase().slice(0, 80)
    if (seen.has(key)) continue
    seen.add(key)
    picked.push(e)
    if (picked.length >= limit) break
  }
  return picked
}

/** Format picked entries as the prompt block ("" when nothing picked). */
function formatMemory(picked, cwd) {
  if (!picked.length) return ""
  const g = picked.filter((e) => e.tier === "global").map((e) => `- ${e.l}`)
  const p = picked.filter((e) => e.tier === "project").map((e) => `- ${e.l}`)
  const out = []
  if (g.length) out.push("USER MEMORY (persistent):\n" + g.join("\n"))
  if (p.length) out.push(`PROJECT MEMORY (${path.basename(path.resolve(cwd))}):\n` + p.join("\n"))
  return out.join("\n\n").slice(0, 1600)
}

/**
 * Relevant memory for a query from both tiers.
 * Returns a compact string ready for a system prompt ("" when nothing matches).
 */
export function relevantMemory(query, { cwd = process.cwd(), limit = 10, writes, graph } = {}) {
  if (!String(query ?? "").trim()) return ""
  const pool = livePool(memoryPool(cwd), cwd, { writes, graph })
  if (!pool.length) return ""
  // v20.2 (P3-2): BM25 relevance instead of raw token overlap
  return formatMemory(dedupePick(bm25Shortlist(query, pool), limit), cwd)
}

/**
 * v23 semantic variant: reranks the BM25 shortlist with provider embeddings
 * when an `embedder` (embeddings.js createEmbedder) is supplied. The shortlist
 * is BM25's — embeddings only REORDER it, they never widen it — so a bad or
 * offline embeddings endpoint degrades to exactly the v20.2 behaviour. Every
 * failure path returns the plain BM25 result; this function never throws.
 */
export async function relevantMemoryAsync(query, { cwd = process.cwd(), limit = 10, embedder = null, alpha, budgetMs = 4000, writes, graph } = {}) {
  if (!String(query ?? "").trim()) return ""
  const pool = livePool(memoryPool(cwd), cwd, { writes, graph })
  if (!pool.length) return ""
  if (!embedder || typeof embedder.embed !== "function") return relevantMemory(query, { cwd, limit, writes, graph })
  try {
    const shortN = Math.max(limit * 4, 24)
    const short = bm25Shortlist(query, pool, shortN)
    if (!short.length) return ""
    const reranked = await rankDocsHybrid(query, short.map((e) => ({ text: e.l, ref: e })), {
      embed: (texts) => embedder.embed(texts),
      alpha,
      budgetMs,
    })
    return formatMemory(dedupePick(reranked.map((r) => r.ref), limit), cwd)
  } catch {
    return relevantMemory(query, { cwd, limit, writes, graph })
  }
}

/** Full stats for /status and doctor. */
export function memoryStats(cwd = process.cwd()) {
  return {
    globalLines: readLines(GLOBAL_MEMORY_PATH).length,
    globalPath: GLOBAL_MEMORY_PATH,
    projectLines: readLines(projectMemoryPath(cwd)).length,
    projectPath: projectMemoryPath(cwd),
  }
}

// --- writing ----------------------------------------------------------------

// v20.2 memory hygiene: an append-only file grows without bound. Every
// autonomous run appends notes, and relevantMemory() reads up to 400 lines per
// tier and scores them — so unbounded growth means slower reads and, worse,
// near-duplicate notes crowding out real signal in the injected context. We now
// (1) skip an append whose bullet text already exists verbatim, and (2) trim the
// file to MEMORY_MAX_ENTRIES entries (oldest first) after writing. Both are
// best-effort; a failure here can never break the CLI.
export const MEMORY_MAX_ENTRIES = 500

function memoryFileFor(tier, cwd) {
  return tier === "project" ? projectMemoryPath(cwd) : GLOBAL_MEMORY_PATH
}

/** Path for a tier ("global" | "project"). */
export function memoryPathFor(tier, cwd = process.cwd()) {
  return memoryFileFor(tier, cwd)
}

/**
 * Parse a memory file into entries. A bullet line ("- note") is one entry; a
 * "LEARNING:" line plus its following "root-cause:"/"fix:" lines is one entry
 * (kept together so list/forget never split a learning block). Returns
 * [{ text, lines }] preserving order.
 */
export function memoryEntries(tier, cwd = process.cwd()) {
  let raw = ""
  try { raw = fs.readFileSync(memoryFileFor(tier, cwd), "utf8") } catch { return [] }
  const src = raw.split("\n")
  const entries = []
  let pending = null // provenance comment waiting for its entry
  for (let i = 0; i < src.length; i++) {
    const line = src[i]
    if (!line.trim()) continue
    const prov = parseProvenance(line)
    if (prov) { pending = { line, prov }; continue }
    const lines = pending ? [pending.line] : []
    const provenance = pending?.prov ?? null
    pending = null
    if (/^\s*LEARNING:/i.test(line)) {
      const block = [line]
      while (i + 1 < src.length && /^\s*(root-cause|fix):/i.test(src[i + 1])) block.push(src[++i])
      entries.push({ text: block.join("\n"), lines: [...lines, ...block], provenance })
    } else {
      entries.push({ text: line.replace(/^[-•*]\s+/, "").trim(), lines: [...lines, line], provenance })
    }
  }
  return entries
}

function writeEntries(tier, entries, cwd) {
  const file = memoryFileFor(tier, cwd)
  const body = entries.map((e) => e.lines.join("\n")).join("\n")
  writeMemoryFile(file, body ? body + "\n" : "")
  return file
}

/** Append entry lines (with provenance) through the single pipeline; prunes to the cap. */
function appendEntry(tier, lines, cwd, provenance, max = MEMORY_MAX_ENTRIES) {
  return withMemoryLock(memoryFileFor(tier, cwd), () => {
    const entries = memoryEntries(tier, cwd)
    entries.push({ text: "", lines: [formatProvenance(provenance), ...lines], provenance })
    const kept = entries.length > max ? entries.slice(entries.length - max) : entries
    return writeEntries(tier, kept, cwd)
  })
}

/**
 * Append one note to a tier ("global" | "project"). Redacted, deduped, capped.
 * `provenance` = { source, runId?, model?, at? } — who is storing this and why.
 */
export function appendMemory(tier, text, cwd = process.cwd(), provenance = {}) {
  const file = memoryFileFor(tier, cwd)
  const line = redact(String(text ?? "").trim()).slice(0, 400)
  if (!line) return { ok: false, error: "empty text" }
  try {
    return withMemoryLock(file, () => {
      // dedup: an identical bullet already present is a no-op — checked under the lock
      const existing = memoryEntries(tier, cwd)
      if (existing.some((e) => e.text === line)) return { ok: true, file, deduped: true }
      appendEntry(tier, [`- ${line}`], cwd, provenance)
      return { ok: true, file }
    })
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** Replace a whole tier (or an explicit file) with `text` — redacted, one pipeline. */
export function replaceMemory(tierOrFile, text, cwd = process.cwd(), provenance = {}) {
  try {
    const file = tierOrFile === "global" || tierOrFile === "project" ? memoryFileFor(tierOrFile, cwd) : String(tierOrFile)
    const body = redact(String(text ?? "")).trimEnd()
    withMemoryLock(file, () => writeMemoryFile(file, body ? `${formatProvenance(provenance)}\n${body}\n` : ""))
    return { ok: true, file, chars: body.length }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** Trim a tier to the newest MEMORY_MAX_ENTRIES entries. Returns count removed. */
export function pruneMemory(tier, cwd = process.cwd(), max = MEMORY_MAX_ENTRIES) {
  try {
    return withMemoryLock(memoryFileFor(tier, cwd), () => {
      const entries = memoryEntries(tier, cwd)
      if (entries.length <= max) return { ok: true, removed: 0 }
      const kept = entries.slice(entries.length - max)
      writeEntries(tier, kept, cwd)
      return { ok: true, removed: entries.length - kept.length }
    })
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** Remove entry N (1-based, as shown by `memory list`) from a tier. */
export function forgetMemory(tier, n, cwd = process.cwd()) {
  try {
    return withMemoryLock(memoryFileFor(tier, cwd), () => {
      const entries = memoryEntries(tier, cwd)
      const idx = Number(n) - 1
      if (!Number.isInteger(idx) || idx < 0 || idx >= entries.length) {
        return { ok: false, error: `no entry ${n} (${entries.length} in ${tier} memory)` }
      }
      const [removed] = entries.splice(idx, 1)
      writeEntries(tier, entries, cwd)
      return { ok: true, removed: removed.text }
    })
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** Clear a whole tier. Returns count removed. */
export function clearMemory(tier, cwd = process.cwd()) {
  try {
    const n = memoryEntries(tier, cwd).length
    const file = memoryFileFor(tier, cwd)
    try { fs.rmSync(file, { force: true }) } catch {}
    return { ok: true, removed: n, file }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** Structured failure learning: { problem, rootCause, fix } → project memory. */
export function recordLearning({ problem, rootCause, fix } = {}, cwd = process.cwd(), provenance = {}) {
  const block = [
    `LEARNING: ${redact(String(problem ?? "").slice(0, 200))}`,
    `  root-cause: ${redact(String(rootCause ?? "").slice(0, 200))}`,
    `  fix: ${redact(String(fix ?? "").slice(0, 240))}`,
  ]
  try {
    const file = appendEntry("project", block, cwd, provenance)
    return { ok: true, file }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** Parse LEARNING blocks (a LEARNING: line + its root-cause:/fix: lines). */
export function parseLearnings(cwd = process.cwd()) {
  const lines = readLines(projectMemoryPath(cwd))
  const learnings = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("LEARNING:")) continue
    const block = [lines[i]]
    let j = i + 1
    // readLines trims indentation, so match "root-cause:"/"fix:" without \s+
    while (j < lines.length && /^(root-cause|fix):/i.test(lines[j])) { block.push(lines[j]); j++ }
    learnings.push(block.join("\n"))
  }
  return learnings
}

function liveLearnings(cwd, opts = {}) {
  const writes = opts.writes
  const graph = opts.graph
  const world = (writes && typeof writes === "object")
    ? { writes, graph: graph || { files: [], edges: [] } }
    : worldFromCwd(cwd)
  const blocks = memoryEntries("project", cwd).filter((e) => /^\s*LEARNING:/i.test(e.text) || /^LEARNING:/i.test(e.text))
  if (!Object.keys(world.writes || {}).length) return blocks.map((e) => e.text)
  return blocks.filter((e) => !entryIsStale(e, world)).map((e) => e.text)
}

/** Retrieve learned fixes relevant to a query (for the context engine). */
export function relevantLearnings(query, { cwd = process.cwd(), limit = 3, writes, graph } = {}) {
  const learnings = liveLearnings(cwd, { writes, graph })
  if (!learnings.length) return ""
  if (!String(query ?? "").trim()) return ""
  // v20.2 (P3-2): BM25 relevance
  const scored = rankDocs(query, learnings.map((l, i) => ({ i, text: l })))
    .filter((r) => r.score > 0)
    .slice(0, limit)
    .map((r) => learnings[r.i])
  return scored.length ? "LEARNED FIXES (relevant past failures):\n" + scored.join("\n") : ""
}

/**
 * v23 semantic variant of relevantLearnings — same BM25-shortlist-then-rerank
 * contract as relevantMemoryAsync (embeddings reorder, never widen; failures
 * fall back to the exact BM25 result).
 */
export async function relevantLearningsAsync(query, { cwd = process.cwd(), limit = 3, embedder = null, alpha, budgetMs = 4000, writes, graph } = {}) {
  if (!String(query ?? "").trim()) return ""
  const learnings = liveLearnings(cwd, { writes, graph })
  if (!learnings.length) return ""
  if (!embedder || typeof embedder.embed !== "function") return relevantLearnings(query, { cwd, limit, writes, graph })
  try {
    const short = rankDocs(query, learnings.map((l, i) => ({ i, text: l })))
      .filter((r) => r.score > 0)
      .slice(0, Math.max(limit * 4, 8))
    if (!short.length) return ""
    const reranked = await rankDocsHybrid(query, short.map((r) => ({ text: learnings[r.i], ref: learnings[r.i] })), {
      embed: (texts) => embedder.embed(texts),
      alpha,
      budgetMs,
    })
    const picked = reranked.slice(0, limit).map((r) => r.ref)
    return picked.length ? "LEARNED FIXES (relevant past failures):\n" + picked.join("\n") : ""
  } catch {
    return relevantLearnings(query, { cwd, limit, writes, graph })
  }
}

// keep os import meaningful (homedir fallback if DEFAULT_DIR unset)
void os
