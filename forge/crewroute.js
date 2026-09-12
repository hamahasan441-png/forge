/**
 * forge — specialist model routing + crew performance memory
 *        (v91 ∞ CORE §36-37, zero dependencies)
 *
 * Different specialists deserve different models:
 *
 *   Explorer  → fast model        (breadth beats depth, latency matters)
 *   Coder     → strongest coding  (the mutation quality gate)
 *   Debugger  → reasoning         (hypotheses must hold up)
 *   Reviewer  → independent       (a different bias than the coder's)
 *   Tester    → efficient         (many cheap calls)
 *
 * Selection considers task complexity, language, historical success, latency,
 * cost, context, tool capability and reliability — through the same
 * CAPABILITY_CLASS vocabulary modelstrategy.js already uses, so the crew
 * router never picks a model outside the configured provider set.
 *
 * §37 performance memory: every (task class, specialist, model) outcome is
 * recorded — success, failure, latency, tokens, verification result — and
 * future routing prefers combinations that actually verified. The memory is
 * per-project, bounded, and damped (one failure never blacklists).
 */
import fs from "node:fs"
import path from "node:path"
import { CAPABILITY_CLASS } from "./modelstrategy.js"
import { projectDir } from "./memory.js"

/** §36 default class per specialist role. The explorer/reviewer split keeps
 *  review independent from coding bias. Unknown roles are fast+cheap. */
export const ROLE_ROUTE = {
  explorer: CAPABILITY_CLASS.FAST_REASONING,
  researcher: CAPABILITY_CLASS.REPOSITORY_ANALYSIS,
  planner: CAPABILITY_CLASS.PLANNING,
  architect: CAPABILITY_CLASS.PLANNING,
  coder: CAPABILITY_CLASS.CODING,
  debugger: CAPABILITY_CLASS.DEBUGGING,
  tester: CAPABILITY_CLASS.FAST_REASONING,
  reviewer: CAPABILITY_CLASS.SECURITY_REVIEW,
  security: CAPABILITY_CLASS.SECURITY_REVIEW,
  integrator: CAPABILITY_CLASS.CODING,
  build_engineer: CAPABILITY_CLASS.CODING,
  performance_engineer: CAPABILITY_CLASS.DEBUGGING,
  dependency_analyst: CAPABILITY_CLASS.REPOSITORY_ANALYSIS,
  doc_engineer: CAPABILITY_CLASS.SUMMARIZATION,
  release_engineer: CAPABILITY_CLASS.FAST_REASONING,
  language_specialist: CAPABILITY_CLASS.CODING,
  runtime_specialist: CAPABILITY_CLASS.DEBUGGING,
}

/** Map a role onto the capability class the model strategy understands. */
export function preferredClassFor(role, { klass = null } = {}) {
  const r = String(role ?? "").toLowerCase()
  if (ROLE_ROUTE[r]) return ROLE_ROUTE[r]
  // dynamic/unknown roles keep the spirit: readers are fast, mutators code
  if (/read|explore|scan|map|index|search/.test(r)) return CAPABILITY_CLASS.FAST_REASONING
  if (/code|fix|patch|write|refactor/.test(r)) return CAPABILITY_CLASS.CODING
  if (/debug|diagnose|root.?cause/.test(r)) return CAPABILITY_CLASS.DEBUGGING
  if (/test|verify|bench/.test(r)) return CAPABILITY_CLASS.FAST_REASONING
  if (/review|audit|security/.test(r)) return CAPABILITY_CLASS.SECURITY_REVIEW
  return klass === "MICRO" || klass === "SMALL" ? CAPABILITY_CLASS.FAST_REASONING : CAPABILITY_CLASS.CODING
}

export const CREWPERF_FILE = "crewperf.json"
const MAX_ENTRIES = 240

export function crewPerfPath(cwd) {
  return path.join(projectDir(cwd), CREWPERF_FILE)
}

export function loadCrewPerf(cwd) {
  try {
    const j = JSON.parse(fs.readFileSync(crewPerfPath(cwd), "utf8"))
    return j && typeof j === "object" ? j : {}
  } catch { return {} }
}

export function saveCrewPerf(cwd, data) {
  try {
    fs.mkdirSync(path.dirname(crewPerfPath(cwd)), { recursive: true })
    fs.writeFileSync(crewPerfPath(cwd), JSON.stringify(data, null, 1), "utf8")
    return true
  } catch { return false }
}

function key(klass, role, model) { return `${klass || "ANY"}|${role}|${model}` }

/** Damped success stats for one key — a single failure never blacklists. */
export function effectiveStats(data, klass, role, model) {
  const e = data[key(klass, role, model)]
  if (!e) return { runs: 0, successRate: 0.5, avgLatencyMs: 0, avgTokens: 0, verifiedRate: 0.5 }
  const runs = e.runs ?? 0
  // add-two damping: 2 pseudo-runs at 50% — one failure can never blacklist
  const successRate = ((e.ok ?? 0) + 1) / (runs + 2)
  const verifiedRate = ((e.verified ?? 0) + 1) / (runs + 2)
  return {
    runs,
    successRate: Math.round(successRate * 100) / 100,
    avgLatencyMs: runs ? Math.round((e.latencyMs ?? 0) / runs) : 0,
    avgTokens: runs ? Math.round((e.tokens ?? 0) / runs) : 0,
    verifiedRate: Math.round(verifiedRate * 100) / 100,
  }
}

export function createCrewRouter({ cwd = process.cwd(), config = null } = {}) {
  let data = loadCrewPerf(cwd)

  /** §36 — pick the best model for a specialist run.
   *  candidates: [{provider, model}] (already filtered by the strategy layer).
   *  Returns { provider, model, cls, why, candidates }. */
  function pick({ role = "researcher", klass = null, candidates = [], risk = "medium" } = {}) {
    const cls = preferredClassFor(role, { klass })
    if (!candidates.length) return { provider: null, model: null, cls, why: "no candidates configured", candidates }
    const scored = candidates.map((c) => {
      const st = effectiveStats(data, klass, role, c.model)
      // score: verified outcomes dominate, then success, then latency
      const score = 2 * st.verifiedRate + st.successRate - Math.min(1, st.avgLatencyMs / 120_000)
      return { ...c, score, stats: st }
    })
    scored.sort((a, b) => b.score - a.score)
    const top = scored[0]
    return {
      provider: top.provider,
      model: top.model,
      cls,
      risk,
      why: top.stats.runs ? `best measured crew performance (${top.stats.runs} runs, verified ${Math.round(top.stats.verifiedRate * 100)}%)` : `no history — routed by role class ${cls}`,
      candidates: scored,
    }
  }

  /** §37 — record a real outcome. verified=true only when verification passed. */
  function record({ klass = null, role = "researcher", model = null, ok = false, verified = false, latencyMs = 0, tokens = 0, regressions = 0 } = {}) {
    if (!model) return false
    const k = key(klass, role, model)
    const e = data[k] ?? { runs: 0, ok: 0, verified: 0, latencyMs: 0, tokens: 0, regressions: 0 }
    e.runs++
    if (ok) e.ok++
    if (verified) e.verified++
    e.latencyMs += Math.max(0, Number(latencyMs) || 0)
    e.tokens += Math.max(0, Number(tokens) || 0)
    e.regressions += Math.max(0, Number(regressions) || 0)
    data[k] = e
    // bounded: drop the coldest third when over cap
    if (Object.keys(data).length > MAX_ENTRIES) {
      const entries = Object.entries(data).sort((a, b) => (a[1].runs ?? 0) - (b[1].runs ?? 0))
      for (const [k2] of entries.slice(0, Math.floor(MAX_ENTRIES / 3))) delete data[k2]
    }
    saveCrewPerf(cwd, data)
    return true
  }

  function stats() {
    return Object.entries(data).map(([k, e]) => ({ key: k, runs: e.runs ?? 0, ok: e.ok ?? 0, verified: e.verified ?? 0 }))
  }

  function reload() { data = loadCrewPerf(cwd) }

  return { pick, record, stats, reload, preferredClassFor }
}
