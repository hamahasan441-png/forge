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
import { buildRepoMap, buildRepoMapAsync } from "./repomap.js"
import { relevantMemory, relevantLearnings, relevantMemoryAsync, relevantLearningsAsync, appendMemory } from "./memory.js"
import { lessonsForPrompt, lessonsForPromptAsync } from "./lessons.js"
import { profileSummary, loadProfile } from "./profile.js"
import { rankDocs, rankDocsHybrid } from "./retrieval.js"
import fs from "node:fs"
import path from "node:path"
import { estimateTokens } from "./ui.js"

/**
 * `embedder` (v23, optional): an embeddings.js embedder. When supplied,
 * buildAsync()/rankAsync() rerank BM25 shortlists with provider embeddings;
 * build()/rank() stay synchronous + BM25 so nothing in the hot path changes
 * when semantic retrieval is off (the default).
 */
export function createContextEngine({ cwd = process.cwd(), config = null, skillsIndex = null, embedder = null } = {}) {
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

  /** Async twin of cached(): checks the same generation-keyed store, awaits
   *  the builder only on a miss. */
  async function cachedAsync(key, tags, build) {
    const hit = cache.get(key)
    if (hit && hit.generation === generation) return hit.value
    const value = await build()
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
    return _assemble(task, opts, {})
  }

  /**
   * v24: async build. With no embedder this IS build() (pure BM25, sync core).
   * With an embedder, memory / learnings / repo-map / lessons / extra-file
   * snippets are BM25-shortlisted then embeddings-reordered (never widened).
   * Every failure degrades to the exact BM25 slice.
   */
  async function buildAsync(task, opts = {}) {
    if (!embedder) return build(task, opts)
    const precise = opts.precision === "precise"
    const pre = {}
    const alpha = config?.retrieval?.embeddings?.alpha
    const budgetMs = config?.retrieval?.embeddings?.rerankBudgetMs ?? 4000
    const embed = (texts) => embedder.embed(texts)
    if (opts.includeMemory !== false && task) {
      pre.memory = await cachedAsync(`memory+sem:${bucket(task)}:${precise ? "p" : "n"}`, [], () =>
        relevantMemoryAsync(task, { cwd, limit: precise ? 6 : 10, embedder, alpha, budgetMs }))
      pre.learnings = await cachedAsync("learnings+sem:" + bucket(task), [], () =>
        relevantLearningsAsync(task, { cwd, limit: 2, embedder, alpha, budgetMs }))
    }
    if (opts.includeRepoMap !== false) {
      pre.repomap = await cachedAsync(`repomap+sem:${bucket(task)}:${precise ? "p" : "n"}`, repoTags(), () => {
        try {
          return buildRepoMapAsync(cwd, {
            query: task || "",
            maxChars: precise ? 1800 : 4000,
            maxListed: precise ? 25 : 60,
            embed, alpha, budgetMs,
          })
        } catch { return "" }
      })
    }
    if (opts.includeLessons !== false && task) {
      pre.lessons = await cachedAsync("lessons+sem:" + bucket(task), [], () =>
        lessonsForPromptAsync(task, { cwd, limit: precise ? 2 : 3, embedder, alpha, budgetMs }))
    }
    if (Array.isArray(opts.extraFiles) && opts.extraFiles.length) {
      const cap = precise ? 3 : 6
      const listed = opts.extraFiles.slice(0, cap)
      try {
        const ranked = await rankAsync(task || "", listed.map((f) => ({ text: String(f), path: f })))
        const order = []
        const seen = new Set()
        for (const r of ranked) {
          const p = r.path ?? listed[r.i]
          if (!p || seen.has(p) || !listed.includes(p)) continue
          seen.add(p)
          order.push(p)
        }
        for (const p of listed) if (!seen.has(p)) order.push(p)
        pre.extraFiles = order.slice(0, cap)
      } catch {
        pre.extraFiles = listed
      }
    }
    return _assemble(task, opts, pre)
  }

  /** Core assembler. pre.memory / pre.learnings (when not undefined) override
   *  the synchronous BM25 computation of those two slices. */
  function _assemble(task, opts = {}, pre = {}) {
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
      const map = pre.repomap !== undefined
        ? pre.repomap
        : cached("repomap:" + (precise ? "precise" : "normal"), repoTags(), () => {
          try { return buildRepoMap(cwd, { query: task || "", maxChars: precise ? 1800 : 4000, maxListed: precise ? 25 : 60 }) } catch { return "" }
        })
      if (map) { sections.push({ name: "repomap", text: map }); sources.repomap = true }
    }

    // 3. relevant memory (global + project) — demand-driven BM25, or the v23
    // hybrid rerank when buildAsync() precomputed those slices
    if (opts.includeMemory !== false && task) {
      // v23.0.1 (audit): the key carries precision — a normal-precision build
      // (limit 10) must not be served to a precise build (limit 6) or vice versa
      const mem = pre.memory !== undefined
        ? pre.memory
        : cached(`memory:${bucket(task)}:${precise ? "p" : "n"}`, [], () => relevantMemory(task, { cwd, limit: precise ? 6 : 10 }))
      if (mem) sections.push({ name: "memory", text: mem })
      const learn = pre.learnings !== undefined
        ? pre.learnings
        : cached("learnings:" + bucket(task), [], () => relevantLearnings(task, { cwd, limit: 2 }))
      if (learn) sections.push({ name: "learnings", text: learn })
    }

    // 4. structured failure lessons (v21) — hybrid-reranked when pre.lessons set
    if (opts.includeLessons !== false && task) {
      const les = pre.lessons !== undefined
        ? pre.lessons
        : lessonsForPrompt(task, { cwd, limit: precise ? 2 : 3 })
      if (les) sections.push({ name: "lessons", text: les })
    }

    // 5. explicitly requested files (the controller decides these from the DAG).
    //    embeddings may REORDER the caller list, never add to it.
    if (Array.isArray(opts.extraFiles) && opts.extraFiles.length) {
      const cap = precise ? 3 : 6
      const files = Array.isArray(pre.extraFiles) ? pre.extraFiles : opts.extraFiles.slice(0, cap)
      const snippets = []
      for (const f of files.slice(0, cap)) {
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

  /** v23: async rank — hybrid BM25+embeddings when an embedder is configured,
   *  otherwise the exact BM25 result. Entries carry .scoreDetail in hybrid
   *  mode (see retrieval.rankDocsHybrid). Never throws. */
  async function rankAsync(query, docs) {
    if (!Array.isArray(docs) || !docs.length) return []
    const mapped = docs.map((d, i) => ({ i, text: typeof d === "string" ? d : d.text ?? "" }))
    if (!embedder) return rankDocs(query, mapped)
    return rankDocsHybrid(query, mapped, {
      embed: (texts) => embedder.embed(texts),
      alpha: config?.retrieval?.embeddings?.alpha,
      budgetMs: config?.retrieval?.embeddings?.rerankBudgetMs ?? 4000,
    })
  }

  /** Persist a durable note through the EXISTING memory layer (redacted). */
  function remember(text, tier = "project", provenance = { source: "agent" }) {
    return appendMemory(tier, text, cwd, provenance)
  }

  function repoTags() {
    // tag the repo map broadly: any source-file change invalidates it
    try { return [path.resolve(cwd)] } catch { return [] }
  }

  return { build, buildAsync, rank, rankAsync, invalidateFor, remember, repoSizeFiles, generation: () => generation, hasEmbedder: () => Boolean(embedder) }
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
