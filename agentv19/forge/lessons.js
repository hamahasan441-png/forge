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
 * Structured lesson schema (P1).
 *
 *   failureClass     what KIND of failure this was (test_failure, build_failure,
 *                    tool_timeout, security_block, provider_error, …)
 *   symptoms         how it looked (the error text / command output)
 *   rootCause        why it happened
 *   solution         what fixed it
 *   files / symbols  where it happened
 *   framework        ecosystem it belongs to (node, python, go, rust, …)
 *   confidence       0..1, raised by successes and lowered by failures
 *   successCount     how often the recorded SOLUTION worked
 *   failureCount     how often this lesson was seen failing anyway
 *   firstSeen/lastUsed, model, strategy
 *
 * Learning is scoped: `scope` (default "project") plus `framework`/`files`
 * keep a lesson learned in one project from contaminating an unrelated one.
 */
export const LESSON_SCOPE = { PROJECT: "project", GLOBAL: "global" }

export const FAILURE_CLASS = {
  TEST_FAILURE: "test_failure",
  BUILD_FAILURE: "build_failure",
  SYNTAX_FAILURE: "syntax_failure",
  DEPENDENCY_FAILURE: "dependency_failure",
  TOOL_TIMEOUT: "tool_timeout",
  TOOL_CRASH: "tool_crash",
  SECURITY_BLOCK: "security_block",
  PROVIDER_ERROR: "provider_error",
  VERIFICATION_MISSING: "verification_missing",
  TOOL_MISUSE: "tool_misuse",
  STATE_CORRUPTION: "state_corruption",
  UNKNOWN: "unknown",
}

/** Classify a failure text into a stable failure class. */
export function classifyFailure(text = "") {
  const t = String(text ?? "")
  if (/\btests? failed|assertion|AssertionError|1\)\s/i.test(t)) return FAILURE_CLASS.TEST_FAILURE
  if (/BUILD FAILED|build failed|error TS\d+|compile error|error\[E\d+\]/i.test(t)) return FAILURE_CLASS.BUILD_FAILURE
  if (/SyntaxError|unexpected token|EOL while scanning/i.test(t)) return FAILURE_CLASS.SYNTAX_FAILURE
  if (/Cannot find module|module not found|no such package|npm ERR!|ENOENT/i.test(t)) return FAILURE_CLASS.DEPENDENCY_FAILURE
  if (/timed out|timeout|ETIMEDOUT/i.test(t)) return FAILURE_CLASS.TOOL_TIMEOUT
  if (/segmentation fault|core dumped|panic:|OOM|heap out of memory|SIGKILL/i.test(t)) return FAILURE_CLASS.TOOL_CRASH
  if (/BLOCKED:|permission denied|EACCES|safety/i.test(t)) return FAILURE_CLASS.SECURITY_BLOCK
  // a malformed call is its own class: it was never a provider/state problem,
  // and lumping it into "unknown" hides the single most repeatable failure mode
  if (/did not match the schema|invalid arguments|unknown tool|tool not found|missing required argument|arguments? (were|was) invalid/i.test(t)) return FAILURE_CLASS.TOOL_MISUSE
  if (/provider|HTTP \d\d\d|fetch failed|rate limit|ECONNRESET/i.test(t)) return FAILURE_CLASS.PROVIDER_ERROR
  if (/verification|evidence missing|not verified/i.test(t)) return FAILURE_CLASS.VERIFICATION_MISSING
  if (/corrupt|invalid state|invalid transition|drift/i.test(t)) return FAILURE_CLASS.STATE_CORRUPTION
  return FAILURE_CLASS.UNKNOWN
}

/** Detect the ecosystem a set of files belongs to. */
export function detectFramework(files = [], text = "") {
  const hay = `${(files ?? []).join(" ")} ${String(text ?? "")}`.toLowerCase()
  if (/\.py\b|pytest|pip\b|poetry/.test(hay)) return "python"
  if (/\.go\b|go test|go\.mod/.test(hay)) return "go"
  if (/\.rs\b|cargo|error\[e\d+\]/i.test(hay)) return "rust"
  if (/\.php\b|phpunit|composer\.json|pest/i.test(hay)) return "php"
  if (/\.tsx?\b|\.jsx?\b|npm|node|tsc|vitest|jest/.test(hay)) return "node"
  if (/\.rb\b|rspec|gem/.test(hay)) return "ruby"
  if (/\.java\b|gradle|maven/.test(hay)) return "java"
  return null
}

/**
 * Record a structured lesson.
 * @param l { failure, cause, failedStrategy, failedAction, successfulRepair,
 *            applicableContext, task, confidence (0..1),
 *            failureClass, symptoms, rootCause, solution, files, symbols,
 *            framework, model, strategy, scope }
 */
export function recordLesson(l = {}, cwd = process.cwd()) {
  const lessons = loadLessons(cwd)
  const files = Array.isArray(l.files) ? l.files.map((f) => redact(String(f)).slice(0, 200)).slice(0, 20) : []
  const symbols = Array.isArray(l.symbols) ? l.symbols.map((s) => redact(String(s)).slice(0, 120)).slice(0, 20) : []
  const lesson = {
    id: `les-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    at: Date.now(),
    // --- legacy fields (kept: memory.js, prompts and older records use them)
    failure: redact(String(l.failure ?? "")).slice(0, 240),
    cause: redact(String(l.cause ?? "")).slice(0, 240),
    failed_strategy: redact(String(l.failedStrategy ?? l.failed_strategy ?? "")).slice(0, 240),
    failed_action: redact(String(l.failedAction ?? l.failed_action ?? "")).slice(0, 240),
    successful_repair: redact(String(l.successfulRepair ?? l.successful_repair ?? "")).slice(0, 300),
    applicable_context: redact(String(l.applicableContext ?? l.applicable_context ?? l.task ?? "")).slice(0, 300),
    task: redact(String(l.task ?? "")).slice(0, 300),
    // --- structured schema (P1)
    failureClass: l.failureClass ?? classifyFailure(`${l.failure ?? ""} ${l.cause ?? ""}`),
    symptoms: redact(String(l.symptoms ?? l.failure ?? "")).slice(0, 400),
    rootCause: redact(String(l.rootCause ?? l.cause ?? "")).slice(0, 400),
    solution: redact(String(l.solution ?? l.successfulRepair ?? l.successful_repair ?? "")).slice(0, 400),
    files,
    symbols,
    framework: l.framework ?? detectFramework(files, `${l.task ?? ""} ${l.failure ?? ""}`),
    model: l.model ?? null,
    strategy: redact(String(l.strategy ?? l.failed_strategy ?? l.failedStrategy ?? "")).slice(0, 200) || null,
    scope: l.scope === LESSON_SCOPE.GLOBAL ? LESSON_SCOPE.GLOBAL : LESSON_SCOPE.PROJECT,
    successCount: 0,
    failureCount: 0,
    firstSeen: Date.now(),
    lastUsed: Date.now(),
    confidence: clamp01(l.confidence ?? 0.6),
    uses: 0,
  }
  // dedup: an identical failure+failedStrategy lesson already present → bump it
  const existing = lessons.find(
    (x) => x.failure === lesson.failure && x.failed_strategy === lesson.failed_strategy && x.cause === lesson.cause
  )
  if (existing) {
    existing.uses++
    existing.lastUsed = Date.now()
    // confidence is evidence-driven: a lesson that fixed the problem gains
    // confidence, one that keeps failing loses it (and can be retired).
    if (lesson.solution || lesson.successful_repair) {
      existing.successCount = (existing.successCount ?? 0) + 1
      existing.solution = lesson.solution || existing.solution
      existing.successful_repair = lesson.successful_repair || existing.successful_repair
      existing.confidence = Math.min(1, Number(existing.confidence ?? 0.6) + 0.1)
    } else {
      existing.failureCount = (existing.failureCount ?? 0) + 1
      existing.confidence = Math.max(0, Number(existing.confidence ?? 0.6) - 0.15)
    }
    for (const f of lesson.files ?? []) if (!(existing.files ?? []).includes(f)) (existing.files ??= []).push(f)
    for (const sym of lesson.symbols ?? []) if (!(existing.symbols ?? []).includes(sym)) (existing.symbols ??= []).push(sym)
    if (lesson.framework && !existing.framework) existing.framework = lesson.framework
    existing.at = Date.now()
    save(cwd, lessons)
    return { ok: true, id: existing.id, deduped: true, confidence: existing.confidence }
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
export function ineffectiveStrategies(query, { cwd = process.cwd(), strategyHint = "", limit = 5, framework = null, minConfidence = 0 } = {}) {
  let lessons = loadLessons(cwd).filter((l) => l.failed_strategy || l.failed_action)
  // scoping: a lesson learned against a different ecosystem is not evidence
  // here — it must not contaminate an unrelated project's strategy choices.
  if (framework) lessons = lessons.filter((l) => !l.framework || l.framework === framework)
  if (minConfidence > 0) lessons = lessons.filter((l) => Number(l.confidence ?? 0) >= minConfidence)
  if (!lessons.length) return []
  const scored = rankDocs(String(query ?? "") + " " + String(strategyHint ?? ""), lessons.map((l, i) => ({ i, text: `${l.failure} ${l.cause} ${l.failed_strategy} ${l.failed_action} ${l.applicable_context}` })))
    .filter((r) => r.score > 0)
    .slice(0, limit)
    .map((r) => lessons[r.i])
  // a direct strategy-name match always counts even with a weak text score
  if (strategyHint) {
    const hint = String(strategyHint).toLowerCase().trim()
    const words = hint.split(/[^a-z0-9]+/).filter((w) => w.length >= 3)
    const matches = (v) => {
      const s2 = String(v ?? "").toLowerCase()
      if (!s2) return false
      if (s2 === hint || s2.includes(hint) || hint.includes(s2)) return true
      return words.some((w) => s2.includes(w))
    }
    // an EXACT strategy-name match always counts; a token overlap counts too,
    // so "re-run" still warns about "re-run until green" (near-miss strategies
    // are exactly the ones an otherwise-honest agent repeats).
    const direct = lessons.filter((l) => matches(l.failed_strategy) || matches(l.failed_action) || matches(l.strategy))
    for (const d of direct) if (!scored.includes(d)) scored.unshift(d)
  }
  return scored.slice(0, limit)
}

/** Lessons with a known successful repair, relevance-ranked (for context). */
export function relevantLessons(query, { cwd = process.cwd(), limit = 3, framework = null, minConfidence = 0 } = {}) {
  let lessons = loadLessons(cwd).filter((l) => l.successful_repair || l.solution)
  if (framework) lessons = lessons.filter((l) => !l.framework || l.framework === framework)
  if (minConfidence > 0) lessons = lessons.filter((l) => Number(l.confidence ?? 0) >= minConfidence)
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
  const byClass = {}
  for (const l of lessons) byClass[l.failureClass ?? "unknown"] = (byClass[l.failureClass ?? "unknown"] ?? 0) + 1
  return {
    total: lessons.length,
    withRepair: lessons.filter((l) => l.successful_repair || l.solution).length,
    byClass,
    avgConfidence: lessons.length
      ? Math.round((lessons.reduce((a, l) => a + Number(l.confidence ?? 0), 0) / lessons.length) * 100) / 100
      : 0,
    retired: lessons.filter((l) => Number(l.confidence ?? 1) <= 0.15).length,
    path: lessonsPath(cwd),
  }
}
