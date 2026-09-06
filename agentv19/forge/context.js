/**
 * forge — context engine (v21, zero dependencies)
 *
 * One demand-driven entry point for "what does the model need to know RIGHT
 * NOW?". Before v21 those pieces were assembled ad-hoc inside the agent system
 * prompt: profile.js, repomap.js, memory.js (global + project), retrieval.js
 * (BM25) and the session. They all worked; this module composes them under a
 * token BUDGET and owns the cache invalidation rules so the model never gets:
 *   - the whole repository dumped into context, nor
 *   - a stale map/memory after a mutation.
 *
 * Demand-driven: the caller says what the current task is and roughly how many
 * tokens it can spend; the engine returns the highest-value slices, ranked.
 * Mutations invalidate the affected cached state via invalidateFor(paths).
 */
import { buildRepoMap } from "./repomap.js"
import { relevantMemory, relevantLearnings, appendMemory } from "./memory.js"
import { lessonsForPrompt } from "./lessons.js"
import { profileSummary, loadProfile } from "./profile.js"
import { rankDocs } from "./retrieval.js"
import fs from "node:fs"
import path from "node:path"
import { estimateTokens } from "./ui.js"

export function createContextEngine({ cwd = process.cwd(), config = null, skillsIndex = null } = {}) {
  // cache of expensive-to-build slices; a generation counter + path tags drive
  // invalidation (mutations bump the generation and tag the affected files).
  let generation = 0
  const cache = new Map() // key → { generation, tags:Set, value }

  function cached(key, tags, build) {
    const hit = cache.get(key)
    if (hit && hit.generation === generation) return hit.value
    const value = build()
    cache.set(key, { generation, tags: new Set(tags || []), value })
    return value
  }

  /** Invalidate cached slices that touch any of these paths (or everything on
   *  a broad change). */
  function invalidateFor(paths = []) {
    generation++
    if (!paths.length) { cache.clear(); return }
    const set = new Set(paths.map((p) => path.resolve(cwd, String(p))))
    for (const [key, entry] of cache) {
      let touched = false
      for (const t of entry.tags) {
        if (set.has(t)) { touched = true; break }
        // directory-level invalidation: a cached slice tagged with a parent dir
        if ([...set].some((s) => s.startsWith(t + path.sep) || t.startsWith(s + path.sep))) { touched = true; break }
      }
      if (touched) cache.delete(key)
    }
  }

  function repoSizeFiles() {
    const p = loadProfile(cwd)
    return p?.files ?? 0
  }

  /**
   * Build the demand-driven context block for a task.
   * @param task       the current objective / sub-task
   * @param opts       { budgetTokens, precision: 'normal'|'precise', includeRepoMap,
   *                    includeMemory, includeLessons, extraFiles:[paths] }
   * Returns { text, tokens, sections:[{name,text,tokens}], sources }.
   */
  function build(task, opts = {}) {
    const budget = opts.budgetTokens ?? 2400
    const precise = opts.precision === "precise"
    const sections = []
    const sources = {}

    // 1. project profile (tiny, high value) — cached
    if (opts.includeProfile !== false) {
      const prof = cached("profile", [], () => profileSummary(cwd))
      if (prof) { sections.push({ name: "profile", text: prof }); sources.profile = true }
    }

    // 2. repo map — ranked by task relevance; in precise mode shrink the cap
    if (opts.includeRepoMap !== false) {
      const map = cached("repomap:" + (precise ? "precise" : "normal"), repoTags(), () => {
        try { return buildRepoMap(cwd, { query: task || "", maxChars: precise ? 1800 : 4000, maxListed: precise ? 25 : 60 }) } catch { return "" }
      })
      if (map) { sections.push({ name: "repomap", text: map }); sources.repomap = true }
    }

    // 3. relevant memory (global + project) — demand-driven BM25
    if (opts.includeMemory !== false && task) {
      const mem = cached("memory:" + bucket(task), [], () => relevantMemory(task, { cwd, limit: precise ? 6 : 10 }))
      if (mem) sections.push({ name: "memory", text: mem })
      const learn = cached("learnings:" + bucket(task), [], () => relevantLearnings(task, { cwd, limit: 2 }))
      if (learn) sections.push({ name: "learnings", text: learn })
    }

    // 4. structured failure lessons (v21)
    if (opts.includeLessons !== false && task) {
      const les = lessonsForPrompt(task, { cwd, limit: precise ? 2 : 3 })
      if (les) sections.push({ name: "lessons", text: les })
    }

    // 5. explicitly requested files (the controller decides these from the DAG)
    if (Array.isArray(opts.extraFiles) && opts.extraFiles.length) {
      const snippets = []
      for (const f of opts.extraFiles.slice(0, precise ? 3 : 6)) {
        const txt = readSnippet(path.resolve(cwd, f), precise ? 1200 : 2000)
        if (txt) snippets.push(txt)
      }
      if (snippets.length) sections.push({ name: "files", text: snippets.join("\n\n") })
    }

    // fit to budget: keep sections in priority order until the budget is spent
    const ranked = sections.map((s) => ({ ...s, tokens: estimateTokens(s.text) }))
    const kept = []
    let used = 0
    for (const s of ranked) {
      if (used + s.tokens > budget && kept.length) { s.dropped = true; continue }
      kept.push(s)
      used += s.tokens
    }
    const text = kept.filter((s) => !s.dropped).map((s) => s.text).join("\n\n")
    return { text, tokens: used, sections: kept, sources, repoFiles: repoSizeFiles() }
  }

  /** BM25 over a set of candidate docs the caller already has (e.g. file
   *  contents) — demand-driven retrieval without loading the whole repo. */
  function rank(query, docs) {
    if (!Array.isArray(docs) || !docs.length) return []
    return rankDocs(query, docs.map((d, i) => ({ i, text: typeof d === "string" ? d : d.text ?? "" })))
  }

  /** Persist a durable note through the EXISTING memory layer (redacted). */
  function remember(text, tier = "project") {
    return appendMemory(tier, text, cwd)
  }

  function repoTags() {
    // tag the repo map broadly: any source-file change invalidates it
    try { return [path.resolve(cwd)] } catch { return [] }
  }

  return { build, rank, invalidateFor, remember, repoSizeFiles, generation: () => generation }
}

function bucket(task) {
  // coarse task bucket so similar tasks share a memory cache but distinct
  // tasks don't collide: first 6 significant words.
  return String(task ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 6).join("-")
}

function readSnippet(file, maxChars) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > 256 * 1024) return null
    const text = fs.readFileSync(file, "utf8").slice(0, maxChars)
    const rel = path.relative(process.cwd(), file) || file
    return `--- ${rel} ---\n${text}`
  } catch { return null }
}
