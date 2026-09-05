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

const STOP = new Set("a an the is are was were be been to of in on for with and or not it this that i you my your we they do does did how what why when where which who if then as at by from".split(" "))

function words(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
}

/** Score one memory line against a query (token overlap, cheap and effective). */
function score(line, queryTokens) {
  const lt = new Set(words(line))
  if (!lt.size) return 0
  let hits = 0
  for (const q of queryTokens) {
    if (lt.has(q)) hits += 2
    else for (const l of lt) {
      if (l.length > 4 && q.length > 4 && (l.startsWith(q) || q.startsWith(l))) { hits += 1; break }
    }
  }
  return hits
}

/**
 * Relevant memory for a query from both tiers.
 * Returns a compact string ready for a system prompt ("" when nothing matches).
 */
export function relevantMemory(query, { cwd = process.cwd(), limit = 10 } = {}) {
  const q = words(query)
  if (!q.length) return ""
  const global = readLines(GLOBAL_MEMORY_PATH).slice(0, 400)
  const project = readLines(projectMemoryPath(cwd)).slice(0, 400)
  const pool = [
    ...global.map((l) => ({ l, tier: "global" })),
    ...project.map((l) => ({ l, tier: "project" })),
  ]
  const scored = pool
    .map((e) => ({ ...e, s: score(e.l, q) }))
    .filter((e) => e.s > 0)
    .sort((a, b) => b.s - a.s)
  const seen = new Set()
  const picked = []
  for (const e of scored) {
    const key = e.l.toLowerCase().slice(0, 80)
    if (seen.has(key)) continue
    seen.add(key)
    picked.push(e)
    if (picked.length >= limit) break
  }
  if (!picked.length) return ""
  const g = picked.filter((e) => e.tier === "global").map((e) => `- ${e.l}`)
  const p = picked.filter((e) => e.tier === "project").map((e) => `- ${e.l}`)
  const out = []
  if (g.length) out.push("USER MEMORY (persistent):\n" + g.join("\n"))
  if (p.length) out.push(`PROJECT MEMORY (${path.basename(path.resolve(cwd))}):\n` + p.join("\n"))
  return out.join("\n\n").slice(0, 1600)
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

/** Append one note to a tier ("global" | "project"). Redacted, atomic-ish. */
export function appendMemory(tier, text, cwd = process.cwd()) {
  const file = tier === "project" ? projectMemoryPath(cwd) : GLOBAL_MEMORY_PATH
  const line = redact(String(text ?? "").trim()).slice(0, 400)
  if (!line) return { ok: false, error: "empty text" }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `- ${line}\n`)
    return { ok: true, file }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** Structured failure learning: { problem, rootCause, fix } → project memory. */
export function recordLearning({ problem, rootCause, fix }, cwd = process.cwd()) {
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

/** Retrieve learned fixes relevant to a query (for the context engine). */
export function relevantLearnings(query, { cwd = process.cwd(), limit = 3 } = {}) {
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
  if (!learnings.length) return ""
  const q = words(query)
  const scored = learnings
    .map((l) => ({ l, s: score(l, q) }))
    .filter((e) => e.s > 1)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
  return scored.length ? "LEARNED FIXES (relevant past failures):\n" + scored.map((e) => e.l).join("\n") : ""
}

// keep os import meaningful (homedir fallback if DEFAULT_DIR unset)
void os
