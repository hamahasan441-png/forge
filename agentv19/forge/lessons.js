/**
 * forge — failure learning (v21, zero dependencies)
 *
 * memory.js already keeps free-form `LEARNING:` bullets in project memory and
 * retrieves them by relevance. This module is the STRUCTURED counterpart the
 * meta controller and agent manager consult BEFORE repeating a strategy:
 *
 *   ~/.forge/projects/<hash>/lessons.json   (per project, bounded)
 *
 * A lesson records the failure, its root cause, the strategy that FAILED, the
 * action that ultimately fixed it, the context it applies to, and a confidence.
 * Before an operation, `ineffectiveStrategies()` answers "have we already
 * proven this exact approach does not work for this kind of problem?" — the
 * controller changes strategy instead of repeating a known dead end.
 *
 * Lessons also flow into the model's context as a compact, relevance-ranked
 * block (reusing memory.js retrieval), so learned fixes are not just stored but
 * used. Everything is redacted and best-effort.
 */
import fs from "node:fs"
import path from "node:path"
import { projectDir } from "./memory.js"
import { rankDocs } from "./retrieval.js"
import { redact } from "./secrets.js"

const MAX_LESSONS = 300

function lessonsPath(cwd) {
  return path.join(projectDir(cwd), "lessons.json")
}

export function loadLessons(cwd = process.cwd()) {
  try {
    const j = JSON.parse(fs.readFileSync(lessonsPath(cwd), "utf8"))
    return Array.isArray(j) ? j : Array.isArray(j?.lessons) ? j.lessons : []
  } catch { return [] }
}

function save(cwd, lessons) {
  try {
    const file = lessonsPath(cwd)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + ".tmp"
    fs.writeFileSync(tmp, JSON.stringify(lessons.slice(-MAX_LESSONS), null, 1), { mode: 0o600 })
    fs.renameSync(tmp, file)
    return true
  } catch { return false }
}

/**
 * Record a structured lesson.
 * @param l { failure, cause, failedStrategy, failedAction, successfulRepair,
 *            applicableContext, task, confidence (0..1) }
 */
export function recordLesson(l = {}, cwd = process.cwd()) {
  const lessons = loadLessons(cwd)
  const lesson = {
    id: `les-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    at: Date.now(),
    failure: redact(String(l.failure ?? "")).slice(0, 240),
    cause: redact(String(l.cause ?? "")).slice(0, 240),
    failed_strategy: redact(String(l.failedStrategy ?? l.failed_strategy ?? "")).slice(0, 240),
    failed_action: redact(String(l.failedAction ?? l.failed_action ?? "")).slice(0, 240),
    successful_repair: redact(String(l.successfulRepair ?? l.successful_repair ?? "")).slice(0, 300),
    applicable_context: redact(String(l.applicableContext ?? l.applicable_context ?? l.task ?? "")).slice(0, 300),
    task: redact(String(l.task ?? "")).slice(0, 300),
    confidence: clamp01(l.confidence ?? 0.6),
    uses: 0,
  }
  // dedup: an identical failure+failedStrategy lesson already present → bump it
  const existing = lessons.find(
    (x) => x.failure === lesson.failure && x.failed_strategy === lesson.failed_strategy && x.cause === lesson.cause
  )
  if (existing) {
    existing.uses++
    existing.confidence = Math.min(1, existing.confidence + 0.1)
    if (lesson.successful_repair) existing.successful_repair = lesson.successful_repair
    existing.at = Date.now()
    save(cwd, lessons)
    return { ok: true, id: existing.id, deduped: true }
  }
  lessons.push(lesson)
  save(cwd, lessons)
  return { ok: true, id: lesson.id }
}

function clamp01(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0.6
  return Math.max(0, Math.min(1, v))
}

/**
 * Strategies already proven ineffective for a task/context. Returns lessons
 * whose failed strategy matches, relevance-ranked, so the controller can avoid
 * repeating them. `strategyHint` (e.g. "retry", tool name) narrows the match.
 */
export function ineffectiveStrategies(query, { cwd = process.cwd(), strategyHint = "", limit = 5 } = {}) {
  const lessons = loadLessons(cwd).filter((l) => l.failed_strategy || l.failed_action)
  if (!lessons.length) return []
  const scored = rankDocs(String(query ?? "") + " " + String(strategyHint ?? ""), lessons.map((l, i) => ({ i, text: `${l.failure} ${l.cause} ${l.failed_strategy} ${l.failed_action} ${l.applicable_context}` })))
    .filter((r) => r.score > 0)
    .slice(0, limit)
    .map((r) => lessons[r.i])
  // a direct strategy-name match always counts even with a weak text score
  if (strategyHint) {
    const direct = lessons.filter((l) => l.failed_strategy === strategyHint || l.failed_action === strategyHint)
    for (const d of direct) if (!scored.includes(d)) scored.unshift(d)
  }
  return scored.slice(0, limit)
}

/** Lessons with a known successful repair, relevance-ranked (for context). */
export function relevantLessons(query, { cwd = process.cwd(), limit = 3 } = {}) {
  const lessons = loadLessons(cwd).filter((l) => l.successful_repair)
  if (!lessons.length || !String(query ?? "").trim()) return []
  return rankDocs(String(query), lessons.map((l, i) => ({ i, text: `${l.failure} ${l.cause} ${l.successful_repair} ${l.applicable_context} ${l.task}` })))
    .filter((r) => r.score > 0)
    .slice(0, limit)
    .map((r) => lessons[r.i])
}

/** Compact, model-facing block of relevant learned fixes. "" when none. */
export function lessonsForPrompt(query, opts = {}) {
  const hits = relevantLessons(query, opts)
  if (!hits.length) return ""
  const lines = hits.map((l) => `- failure: ${l.failure || "?"} • cause: ${l.cause || "?"} • fix that worked: ${l.successful_repair}`)
  return "LEARNED FROM PAST FAILURES (do not repeat the failed approach):\n" + lines.join("\n")
}

export function lessonStats(cwd = process.cwd()) {
  const lessons = loadLessons(cwd)
  return { total: lessons.length, withRepair: lessons.filter((l) => l.successful_repair).length, path: lessonsPath(cwd) }
}
