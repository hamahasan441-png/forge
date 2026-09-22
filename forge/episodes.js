/**
 * forge — engineering episodes (v91 ∞ CORE §11/§78, zero dependencies)
 *
 * Memory is not chat history. An EPISODE is the durable record of one
 * complete engineering experience:
 *
 *   PROBLEM → CONTEXT → HYPOTHESES → EXPERIMENTS → EVIDENCE → FIX →
 *   VERIFICATION → REVIEW → RESULT → LESSON
 *
 * Episodes complement the existing memory stack (memory.md facts, lessons.json
 * failure knowledge, knowtype typed knowledge): lessons are distilled rules,
 * episodes are the full story — including the failed approaches, so a future
 * task can reuse "what we tried and why it did not work" (§78 "use similar
 * episodes for future tasks").
 *
 * Storage: ~/.forge/projects/<hash>/episodes.json (bounded, per project).
 * Retrieval: BM25 over problem+symptoms+files via retrieval.js — the smallest
 * useful context, never a dump (§14).
 */
import fs from "node:fs"
import path from "node:path"
import { projectDir } from "./memory.js"
import { writeStateFile } from "./securefs.js"
import { rankDocs } from "./retrieval.js"

export const EPISODE_STAGE = {
  PROBLEM: "PROBLEM",
  CONTEXT: "CONTEXT",
  HYPOTHESES: "HYPOTHESES",
  EXPERIMENTS: "EXPERIMENTS",
  EVIDENCE: "EVIDENCE",
  FIX: "FIX",
  VERIFICATION: "VERIFICATION",
  REVIEW: "REVIEW",
  RESULT: "RESULT",
  LESSON: "LESSON",
}

export const EPISODE_STAGES = Object.values(EPISODE_STAGE)

export const EPISODE_RESULT = {
  SUCCESS: "success",
  PARTIAL: "partial",
  FAILED: "failed",
  ABANDONED: "abandoned",
}

const EPISODES_FILE = "episodes.json"
const MAX_EPISODES = 120
const MAX_LIST = 16
const MAX_TEXT = 1200

export function episodesPath(cwd) {
  return path.join(projectDir(cwd), EPISODES_FILE)
}

export function loadEpisodes(cwd) {
  try {
    const j = JSON.parse(fs.readFileSync(episodesPath(cwd), "utf8"))
    return Array.isArray(j?.episodes) ? j.episodes : []
  } catch { return [] }
}

export function saveEpisodes(cwd, episodes) {
  // v96 unifywise: the episodic store is ENGINEERING HISTORY — a torn write
  // here loses a whole episode. Every sibling store (lessons, engmemory,
  // predictions, claims) writes through securefs.writeStateFile; episodes now
  // do too (atomic tmp+fsync+rename, mode 0600).
  try {
    return Boolean(writeStateFile(episodesPath(cwd), JSON.stringify({ episodes }, null, 1)))
  } catch { return false }
}

let seq = 0
export function episodeId() { return `ep-${Date.now().toString(36)}-${++seq}` }

/** Start a new episode at the PROBLEM stage. */
export function createEpisode({ problem = "", context = "", taskId = null, symptoms = [], files = [], language = null, klass = null } = {}) {
  return {
    episode_id: episodeId(),
    created_at: Date.now(),
    updated_at: Date.now(),
    task_id: taskId != null ? String(taskId).slice(0, 120) : null,
    problem: String(problem ?? "").slice(0, MAX_TEXT),
    context: String(context ?? "").slice(0, MAX_TEXT),
    symptoms: strList(symptoms),
    files: strList(files),
    language: language != null ? String(language).slice(0, 40) : null,
    klass: klass != null ? String(klass).slice(0, 20) : null,
    hypotheses: [],   // [{text, status, confidence}]
    experiments: [],  // [{command, result, ok}]
    evidence: [],     // [strings / {kind, value}]
    fixes: [],        // [strings]
    verification: [], // [{command, ok, at}]
    review: null,     // adversarial review verdict text
    result: null,     // EPISODE_RESULT
    lesson: null,     // the distilled reusable knowledge
    failed_approaches: [], // preserved so nobody repeats them (§78)
    thoughts: [],          // v132: think() scratchpad that a later run can recall
  }
}

/** An episode may only be marked a LESSON once verification is recorded. */
export function setLesson(ep, lesson, { result = null } = {}) {
  if (!ep) return false
  ep.lesson = String(lesson ?? "").slice(0, MAX_TEXT)
  if (result && Object.values(EPISODE_RESULT).includes(result)) ep.result = result
  if (!ep.verification.length && ep.result === EPISODE_RESULT.SUCCESS) {
    // an unverified success is a PARTIAL at best — never a proven lesson
    ep.result = EPISODE_RESULT.PARTIAL
  }
  ep.updated_at = Date.now()
  return true
}

export function episodeToText(ep) {
  if (!ep) return ""
  const parts = [ep.problem, ep.context, ...ep.symptoms, ...ep.files, ...ep.failed_approaches, ...(ep.thoughts ?? []).map((t) => t.text || t), ep.lesson]
  return parts.filter(Boolean).join("\n")
}

/** Episode store: create, advance, retrieve similar, consolidate. */
export function createEpisodeStore({ cwd = process.cwd(), max = MAX_EPISODES } = {}) {
  let episodes = loadEpisodes(cwd)

  const persist = () => {
    if (episodes.length > max) episodes = episodes.slice(-max)
    saveEpisodes(cwd, episodes)
  }

  function start(spec = {}) {
    const ep = createEpisode(spec)
    episodes.push(ep)
    persist()
    return ep
  }

  function get(id) { return episodes.find((e) => e.episode_id === id) ?? null }
  function latest() { return episodes[episodes.length - 1] ?? null }

  /** Stage recorders — each stamps updated_at and persists. */
  function addHypothesis(ep, text, { status = "open", confidence = 0.4 } = {}) {
    if (!ep) return false
    ep.hypotheses.push({ text: String(text ?? "").slice(0, 300), status, confidence, at: Date.now() })
    if (ep.hypotheses.length > MAX_LIST) ep.hypotheses.shift()
    ep.updated_at = Date.now()
    persist()
    return true
  }

  function addExperiment(ep, { command = "", result = "", ok = false } = {}) {
    if (!ep) return false
    ep.experiments.push({ command: String(command ?? "").slice(0, 300), result: String(result ?? "").slice(0, 600), ok: !!ok, at: Date.now() })
    if (ep.experiments.length > MAX_LIST) ep.experiments.shift()
    ep.updated_at = Date.now()
    persist()
    return true
  }

  function addEvidence(ep, item) {
    if (!ep) return false
    ep.evidence.push(typeof item === "string" ? item.slice(0, 300) : item)
    if (ep.evidence.length > MAX_LIST) ep.evidence.shift()
    ep.updated_at = Date.now()
    persist()
    return true
  }

  function addFix(ep, text) {
    if (!ep) return false
    ep.fixes.push(String(text ?? "").slice(0, 300))
    if (ep.fixes.length > MAX_LIST) ep.fixes.shift()
    ep.updated_at = Date.now()
    persist()
    return true
  }

  function addVerification(ep, { command = "", ok = false } = {}) {
    if (!ep) return false
    ep.verification.push({ command: String(command ?? "").slice(0, 300), ok: !!ok, at: Date.now() })
    if (ep.verification.length > MAX_LIST) ep.verification.shift()
    ep.updated_at = Date.now()
    persist()
    return true
  }

  /** A failed approach is VALUABLE — record it so it is never retried. */
  function addFailedApproach(ep, text) {
    if (!ep) return false
    ep.failed_approaches.push(String(text ?? "").slice(0, 300))
    if (ep.failed_approaches.length > MAX_LIST) ep.failed_approaches.shift()
    ep.updated_at = Date.now()
    persist()
    return true
  }

  /** v132: a think() that dies with the tool context cannot teach the next run. */
  function addThought(ep, text, { runId = null } = {}) {
    if (!ep) return false
    if (!Array.isArray(ep.thoughts)) ep.thoughts = []
    const t = String(text ?? "").trim().slice(0, 400)
    if (!t) return false
    ep.thoughts.push({ at: Date.now(), text: t, runId: runId ?? null })
    if (ep.thoughts.length > MAX_LIST) ep.thoughts.shift()
    ep.updated_at = Date.now()
    persist()
    return true
  }

  /**
   * Failed approaches for THIS query. BM25 similar() misses when the next
   * objective is worded differently; overlap + recency does not.
   */
  function failedApproachesFor(query, { limit = 6 } = {}) {
    const qTokens = new Set(String(query ?? "").toLowerCase().match(/[a-z][a-z0-9_.-]{2,}/g) ?? [])
    const scored = []
    for (let i = 0; i < episodes.length; i++) {
      const e = episodes[i]
      const fails = Array.isArray(e.failed_approaches) ? e.failed_approaches : []
      if (!fails.length) continue
      const pTokens = new Set(String(e.problem ?? "").toLowerCase().match(/[a-z][a-z0-9_.-]{2,}/g) ?? [])
      let overlap = 0
      for (const t of qTokens) if (pTokens.has(t)) overlap++
      const recent = i >= episodes.length - 3
      if (overlap === 0 && qTokens.size && !recent) continue
      const recency = e.updated_at ?? e.created_at ?? 0
      for (const fa of fails) scored.push({ text: String(fa), overlap, recency })
    }
    scored.sort((a, b) => b.overlap - a.overlap || b.recency - a.recency)
    const seen = new Set()
    const out = []
    for (const s of scored) {
      const k = s.text.slice(0, 80)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(s.text.slice(0, 200))
      if (out.length >= limit) break
    }
    return out
  }

  function setReview(ep, verdict) {
    if (!ep) return false
    ep.review = String(verdict ?? "").slice(0, MAX_TEXT)
    ep.updated_at = Date.now()
    persist()
    return true
  }

  /** §14 — retrieve the smallest useful set of similar episodes (BM25). */
  function similar(query, { limit = 3 } = {}) {
    if (!episodes.length || !query) return []
    const docs = episodes.map((e) => ({ id: e.episode_id, text: episodeToText(e) }))
    const ranked = rankDocs(String(query), docs, { limit })
    return ranked.map((r) => episodes.find((e) => e.episode_id === r.id)).filter(Boolean)
  }

  /** Context block for the planner: similar past experience, compact. */
  function contextBlock(query, { limit = 2 } = {}) {
    const sims = similar(query, { limit })
    if (!sims.length) return ""
    const lines = ["SIMILAR PAST EPISODES (build on what worked, never repeat what failed):"]
    for (const e of sims) {
      lines.push(`- Problem: ${e.problem.slice(0, 160)}`)
      if (e.failed_approaches.length) lines.push(`  Failed before: ${e.failed_approaches.slice(0, 3).join(" | ")}`)
      if (e.thoughts?.length) lines.push(`  Thought: ${e.thoughts.slice(-2).map((t) => String(t.text || t).slice(0, 160)).join(" | ")}`)
      if (e.fixes.length) lines.push(`  Fix that worked: ${e.fixes[e.fixes.length - 1].slice(0, 160)}`)
      if (e.lesson) lines.push(`  Lesson: ${e.lesson.slice(0, 160)}`)
    }
    return lines.join("\n")
  }

  function stats() {
    const byResult = {}
    for (const e of episodes) byResult[e.result ?? "open"] = (byResult[e.result ?? "open"] ?? 0) + 1
    return { total: episodes.length, byResult }
  }

  function list({ max = 20 } = {}) { return episodes.slice(-max) }

  return {
    start, get, latest, addHypothesis, addExperiment, addEvidence, addFix,
    addVerification, addFailedApproach, addThought, setReview,
    failedApproachesFor,
    // v96 unifywise: setLesson is usually the LAST mutation of an episode
    // (core.run closes with setReview → setLesson → addFix-only-if-files).
    // The bare module function mutates in memory only, so a run whose gate
    // blocked with no file changes never durably persisted its distilled
    // lesson. The store method now persists — the run's outcome reaches disk.
    setLesson: (ep, lesson, opts) => { const r = setLesson(ep, lesson, opts); if (r) persist(); return r },
    similar, contextBlock, stats, list, persist,
    get episodes() { return [...episodes] },
  }
}

function strList(arr) {
  return (Array.isArray(arr) ? arr : [arr]).map((x) => String(x ?? "").slice(0, 300)).filter(Boolean).slice(0, MAX_LIST)
}
