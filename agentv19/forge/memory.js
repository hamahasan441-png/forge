/**
 * forge — hierarchical memory (v20).
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
 * Everything here is best-effort: a broken memory can never break the CLI.
 */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { DEFAULT_DIR } from "./config.js"
import { redact } from "./secrets.js"
import { rankDocs, rankDocsHybrid } from "./retrieval.js"

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

function readLines(p) {
  try {
    const raw = fs.readFileSync(p, "utf8")
    return raw.split("\n").map((l) => l.replace(/^[-•*]\s+/, "").trim()).filter(Boolean)
  } catch {
    return []
  }
}

// v20.2 (P3-2): relevance scoring moved to retrieval.js (BM25). The old
// token-overlap helpers (words/score) were retired with that switch.

/** Both memory tiers as one scored-at-read pool (400 lines per tier cap). */
export function memoryPool(cwd = process.cwd()) {
  const global = readLines(GLOBAL_MEMORY_PATH).slice(0, 400)
  const project = readLines(projectMemoryPath(cwd)).slice(0, 400)
  return [
    ...global.map((l) => ({ l, tier: "global" })),
    ...project.map((l) => ({ l, tier: "project" })),
  ]
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
export function relevantMemory(query, { cwd = process.cwd(), limit = 10 } = {}) {
  if (!String(query ?? "").trim()) return ""
  const pool = memoryPool(cwd)
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
export async function relevantMemoryAsync(query, { cwd = process.cwd(), limit = 10, embedder = null, alpha, budgetMs = 4000 } = {}) {
  if (!String(query ?? "").trim()) return ""
  const pool = memoryPool(cwd)
  if (!pool.length) return ""
  if (!embedder || typeof embedder.embed !== "function") return relevantMemory(query, { cwd, limit })
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
    return relevantMemory(query, { cwd, limit })
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
  for (let i = 0; i < src.length; i++) {
    const line = src[i]
    if (!line.trim()) continue
    if (/^\s*LEARNING:/i.test(line)) {
      const block = [line]
      while (i + 1 < src.length && /^\s*(root-cause|fix):/i.test(src[i + 1])) block.push(src[++i])
      entries.push({ text: block.join("\n"), lines: block })
    } else {
      entries.push({ text: line.replace(/^[-•*]\s+/, "").trim(), lines: [line] })
    }
  }
  return entries
}

function writeEntries(tier, entries, cwd) {
  const file = memoryFileFor(tier, cwd)
  const body = entries.map((e) => e.lines.join("\n")).join("\n")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body ? body + "\n" : "")
  return file
}

/** Append one note to a tier ("global" | "project"). Redacted, deduped, capped. */
export function appendMemory(tier, text, cwd = process.cwd()) {
  const file = memoryFileFor(tier, cwd)
  const line = redact(String(text ?? "").trim()).slice(0, 400)
  if (!line) return { ok: false, error: "empty text" }
  try {
    // dedup: an identical bullet already present is a no-op (best-effort)
    const existing = memoryEntries(tier, cwd)
    if (existing.some((e) => e.text === line)) return { ok: true, file, deduped: true }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `- ${line}\n`)
    pruneMemory(tier, cwd)
    return { ok: true, file }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** Trim a tier to the newest MEMORY_MAX_ENTRIES entries. Returns count removed. */
export function pruneMemory(tier, cwd = process.cwd(), max = MEMORY_MAX_ENTRIES) {
  try {
    const entries = memoryEntries(tier, cwd)
    if (entries.length <= max) return { ok: true, removed: 0 }
    const kept = entries.slice(entries.length - max)
    writeEntries(tier, kept, cwd)
    return { ok: true, removed: entries.length - kept.length }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** Remove entry N (1-based, as shown by `memory list`) from a tier. */
export function forgetMemory(tier, n, cwd = process.cwd()) {
  try {
    const entries = memoryEntries(tier, cwd)
    const idx = Number(n) - 1
    if (!Number.isInteger(idx) || idx < 0 || idx >= entries.length) {
      return { ok: false, error: `no entry ${n} (${entries.length} in ${tier} memory)` }
    }
    const [removed] = entries.splice(idx, 1)
    writeEntries(tier, entries, cwd)
    return { ok: true, removed: removed.text }
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
export function recordLearning({ problem, rootCause, fix } = {}, cwd = process.cwd()) {
  const block = [
    `LEARNING: ${redact(String(problem ?? "").slice(0, 200))}`,
    `  root-cause: ${redact(String(rootCause ?? "").slice(0, 200))}`,
    `  fix: ${redact(String(fix ?? "").slice(0, 240))}`,
  ]
  const line = block.join("\n")
  try {
    const file = projectMemoryPath(cwd)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, line + "\n")
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

/** Retrieve learned fixes relevant to a query (for the context engine). */
export function relevantLearnings(query, { cwd = process.cwd(), limit = 3 } = {}) {
  const learnings = parseLearnings(cwd)
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
export async function relevantLearningsAsync(query, { cwd = process.cwd(), limit = 3, embedder = null, alpha, budgetMs = 4000 } = {}) {
  if (!String(query ?? "").trim()) return ""
  const learnings = parseLearnings(cwd)
  if (!learnings.length) return ""
  if (!embedder || typeof embedder.embed !== "function") return relevantLearnings(query, { cwd, limit })
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
    return relevantLearnings(query, { cwd, limit })
  }
}

// keep os import meaningful (homedir fallback if DEFAULT_DIR unset)
void os
