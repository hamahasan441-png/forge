/**
 * forge — information-gain experiment picker (v29, zero dependencies)
 *
 * Repair is not "try the same command again". After Ω names a hypothesis and
 * ∞ names a causal layer, this module picks the *next experiment*:
 *
 *   gain = (uncertainty + diagnostic + impact + reliability)
 *        / (cost + risk + time)
 *
 * Cheap read-only inspections beat expensive mutating repairs while the
 * cause is still uncertain. An experiment already run twice is excluded
 * (loop). FORGE-origin failures escalate; SAFETY_BLOCK aborts. MICRO/SMALL
 * never get a full-suite experiment.
 *
 * Deterministic. No model call. Meta still owns execution; this only ranks.
 */
import { FAILURE } from "./diagnose.js"
import { TASK_CLASS } from "./classify.js"
import { ORIGIN } from "./selfdiag.js"

export const XID = {
  READ_STACK: "read_stack",
  INSPECT_FILE: "inspect_file",
  GREP_SYMBOL: "grep_symbol",
  FOCUSED_TEST: "focused_test",
  REDUCE_SCOPE: "reduce_scope",
  ALTERNATE_TOOL: "alternate_tool",
  INSTALL_DEP: "install_dep",
  MINIMAL_FIX: "minimal_fix",
  FULL_SUITE: "full_suite",
  REPLAY: "replay_command",
  ESCALATE: "escalate",
  ABORT: "abort",
  DIFFERENT_CAUSE: "different_cause",
}

export const XKIND = {
  INSPECT: "inspect",
  DISCRIMINATE: "discriminate",
  ISOLATE: "isolate",
  REPAIR: "repair",
  ESCALATE: "escalate",
  ABORT: "abort",
}

const ALL = null
const PROJECT_CODES = [
  FAILURE.SYNTAX_FAILURE, FAILURE.TYPE_FAILURE, FAILURE.TEST_FAILURE,
  FAILURE.BUILD_FAILURE, FAILURE.DEPENDENCY_FAILURE, FAILURE.NOT_FOUND,
  FAILURE.CONFIGURATION_FAILURE, FAILURE.RUNTIME_FAILURE, FAILURE.INTEGRATION_FAILURE,
  FAILURE.STATE_FAILURE, FAILURE.CONCURRENCY_FAILURE, FAILURE.PERFORMANCE_FAILURE,
  FAILURE.INVALID_ARGUMENT,
]

/** Catalog: scores are 1–5. `forced` items are never ranked unless policy picks them. */
const CATALOG = [
  {
    id: XID.READ_STACK, kind: XKIND.INSPECT, mutating: false,
    uncertainty: 4, diagnostic: 5, impact: 2, reliability: 5, cost: 1, risk: 1, time: 1,
    instruction: "Read the stack / reported error line. Do not edit yet.",
    for: ALL, notFor: [FAILURE.SAFETY_BLOCK, FAILURE.CANCELLED],
  },
  {
    id: XID.INSPECT_FILE, kind: XKIND.INSPECT, mutating: false,
    uncertainty: 4, diagnostic: 4, impact: 3, reliability: 4, cost: 1, risk: 1, time: 1,
    instruction: "Open the failing file at the reported line and inspect. Do not edit yet.",
    for: ALL, notFor: [FAILURE.SAFETY_BLOCK, FAILURE.CANCELLED, FAILURE.NETWORK_FAILURE],
  },
  {
    id: XID.GREP_SYMBOL, kind: XKIND.INSPECT, mutating: false,
    uncertainty: 3, diagnostic: 3, impact: 2, reliability: 4, cost: 1, risk: 1, time: 1,
    instruction: "grep/glob the symbol or path named in the error. Do not edit yet.",
    for: [FAILURE.NOT_FOUND, FAILURE.TYPE_FAILURE, FAILURE.SYNTAX_FAILURE, FAILURE.DEPENDENCY_FAILURE, FAILURE.INTEGRATION_FAILURE],
  },
  {
    id: XID.FOCUSED_TEST, kind: XKIND.DISCRIMINATE, mutating: false,
    uncertainty: 5, diagnostic: 5, impact: 3, reliability: 4, cost: 2, risk: 1, time: 2,
    instruction: "Run the smallest focused test that would discriminate this cause.",
    for: [FAILURE.TEST_FAILURE, FAILURE.TYPE_FAILURE, FAILURE.SYNTAX_FAILURE, FAILURE.BUILD_FAILURE, FAILURE.CONCURRENCY_FAILURE, FAILURE.RUNTIME_FAILURE, FAILURE.STATE_FAILURE, FAILURE.INTEGRATION_FAILURE],
  },
  {
    id: XID.REDUCE_SCOPE, kind: XKIND.ISOLATE, mutating: false,
    uncertainty: 4, diagnostic: 4, impact: 2, reliability: 3, cost: 2, risk: 1, time: 2,
    instruction: "Narrow to one file / one test / one command. Do not expand the blast radius.",
    for: [FAILURE.TIMEOUT, FAILURE.CONCURRENCY_FAILURE, FAILURE.PERFORMANCE_FAILURE, FAILURE.RESOURCE_FAILURE, FAILURE.TEST_FAILURE, FAILURE.BUILD_FAILURE],
  },
  {
    id: XID.ALTERNATE_TOOL, kind: XKIND.ISOLATE, mutating: false,
    uncertainty: 3, diagnostic: 3, impact: 2, reliability: 3, cost: 2, risk: 1, time: 2,
    instruction: "Use a cheaper/other tool that answers the same question (search vs fetch, glob vs exact path).",
    for: [FAILURE.NETWORK_FAILURE, FAILURE.TIMEOUT, FAILURE.NOT_FOUND, FAILURE.TOOL_FAILURE, FAILURE.INVALID_ARGUMENT],
  },
  {
    id: XID.INSTALL_DEP, kind: XKIND.REPAIR, mutating: true,
    uncertainty: 3, diagnostic: 3, impact: 4, reliability: 3, cost: 3, risk: 3, time: 3,
    instruction: "Confirm the dependency is declared, then install the expected version and re-run.",
    for: [FAILURE.DEPENDENCY_FAILURE],
    requirePrior: [XID.INSPECT_FILE, XID.READ_STACK, XID.GREP_SYMBOL],
  },
  {
    id: XID.MINIMAL_FIX, kind: XKIND.REPAIR, mutating: true,
    uncertainty: 2, diagnostic: 2, impact: 4, reliability: 3, cost: 3, risk: 3, time: 2,
    instruction: "Apply the smallest surgical fix for the confirmed cause, then verify.",
    for: PROJECT_CODES,
    requirePrior: [XID.INSPECT_FILE, XID.READ_STACK, XID.FOCUSED_TEST],
  },
  {
    id: XID.FULL_SUITE, kind: XKIND.DISCRIMINATE, mutating: false,
    uncertainty: 2, diagnostic: 3, impact: 3, reliability: 3, cost: 5, risk: 2, time: 5,
    instruction: "Run the broader verification suite only after a focused test passed.",
    for: ALL,
    classes: [TASK_CLASS.LARGE, TASK_CLASS.ARCHITECTURAL, TASK_CLASS.RECOVERY],
    requirePrior: [XID.FOCUSED_TEST],
  },
  {
    id: XID.REPLAY, kind: XKIND.DISCRIMINATE, mutating: false,
    uncertainty: 1, diagnostic: 1, impact: 1, reliability: 2, cost: 3, risk: 2, time: 2,
    instruction: "Re-run the identical failing command only if it is idempotent and has not been tried.",
    for: [FAILURE.TIMEOUT, FAILURE.NETWORK_FAILURE],
  },
  {
    id: XID.DIFFERENT_CAUSE, kind: XKIND.ISOLATE, mutating: false, forced: true,
    uncertainty: 4, diagnostic: 4, impact: 3, reliability: 3, cost: 2, risk: 1, time: 2,
    instruction: "This cause was already tested twice — pick a different root cause. Do NOT retry it.",
    for: ALL,
  },
  {
    id: XID.ESCALATE, kind: XKIND.ESCALATE, mutating: false, forced: true,
    uncertainty: 1, diagnostic: 1, impact: 1, reliability: 5, cost: 1, risk: 1, time: 1,
    instruction: "Escalate: do not patch the project around a forge/tool/origin failure.",
    for: ALL,
  },
  {
    id: XID.ABORT, kind: XKIND.ABORT, mutating: false, forced: true,
    uncertainty: 1, diagnostic: 1, impact: 1, reliability: 5, cost: 1, risk: 1, time: 1,
    instruction: "Abort: a safety control refused this. Retrying is never the answer.",
    for: [FAILURE.SAFETY_BLOCK],
  },
]

export function catalog() {
  return CATALOG.map((e) => ({ ...e, for: e.for ? [...e.for] : null }))
}

function clamp(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 0
  return Math.max(0, Math.min(5, x))
}

/**
 * Information gain. Denominator is at least 1 so a zero-cost item cannot inf.
 */
export function informationGain({
  uncertainty = 0, diagnostic = 0, impact = 0, reliability = 0,
  cost = 1, risk = 1, time = 1,
} = {}) {
  const num = clamp(uncertainty) + clamp(diagnostic) + clamp(impact) + clamp(reliability)
  const den = Math.max(1, clamp(cost) + clamp(risk) + clamp(time))
  return Math.round((num / den) * 1000) / 1000
}

function matchesCode(entry, code) {
  if (entry.for === ALL || entry.for == null) return true
  return entry.for.includes(code)
}

function classOk(entry, klass) {
  if (!entry.classes) return true
  return entry.classes.includes(klass)
}

function priorOk(entry, tried) {
  const need = entry.requirePrior
  if (!need || !need.length) return true
  return need.some((id) => (tried[id] || 0) > 0)
}

function countsOf(history) {
  const tried = Object.create(null)
  for (const rec of history || []) {
    const id = rec && rec.id
    if (!id) continue
    tried[id] = (tried[id] || 0) + 1
  }
  return tried
}

/**
 * Rank eligible catalog entries. Forced items are omitted unless `forceId`.
 * Tried-twice → excluded. Tried-once → gain × 0.2 (almost never re-picked).
 */
export function rankExperiments(ctx = {}) {
  const code = ctx.code || null
  const klass = ctx.klass || null
  const tried = ctx.tried && typeof ctx.tried === "object" && !Array.isArray(ctx.tried)
    ? ctx.tried
    : countsOf(ctx.history)
  const forceId = ctx.forceId || null
  const out = []
  for (const e of CATALOG) {
    if (forceId && e.id !== forceId) continue
    if (!forceId && e.forced) continue
    if (e.notFor && code && e.notFor.includes(code)) continue
    if (code && !matchesCode(e, code) && !forceId) continue
    if (!classOk(e, klass)) continue
    if (!forceId && !priorOk(e, tried)) continue
    const n = tried[e.id] || 0
    if (n >= 2) continue
    let gain = informationGain(e)
    if (n === 1) gain = Math.round(gain * 0.2 * 1000) / 1000
    out.push({
      id: e.id,
      kind: e.kind,
      instruction: e.instruction,
      mutating: !!e.mutating,
      gain,
      tried: n,
      cost: e.cost, risk: e.risk, time: e.time,
      uncertainty: e.uncertainty, diagnostic: e.diagnostic,
      impact: e.impact, reliability: e.reliability,
    })
  }
  out.sort((a, b) => b.gain - a.gain || a.id.localeCompare(b.id))
  return out
}

function forceFor(ctx) {
  const origin = ctx.origin && (ctx.origin.origin || ctx.origin)
  const code = ctx.code
  const action = ctx.action
  if (code === FAILURE.SAFETY_BLOCK) return XID.ABORT
  if (origin === ORIGIN.FORGE) return XID.ESCALATE
  if (action === "escalate") return ctx.looping ? XID.DIFFERENT_CAUSE : XID.ESCALATE
  if (ctx.looping) return XID.DIFFERENT_CAUSE
  return null
}

/**
 * Pick the next experiment. Never throws.
 */
export function selectExperiment(ctx = {}) {
  const forceId = forceFor(ctx)
  const ranked = rankExperiments({ ...ctx, forceId })
  const avoided = Object.entries(ctx.tried && !Array.isArray(ctx.tried) ? ctx.tried : countsOf(ctx.history))
    .filter(([, n]) => n >= 2)
    .map(([id]) => id)
  const best = ranked[0] || {
    id: XID.READ_STACK,
    kind: XKIND.INSPECT,
    instruction: "Inspect the failure evidence. Do not edit yet.",
    mutating: false,
    gain: 0,
    tried: 0,
  }
  const reason = forceId
    ? `policy:${forceId}`
    : `highest gain ${best.gain} among ${ranked.length} eligible`
  return {
    id: best.id,
    kind: best.kind,
    instruction: best.instruction,
    mutating: !!best.mutating,
    gain: best.gain,
    reason,
    avoided,
    ranked: ranked.slice(0, 6).map((r) => ({ id: r.id, gain: r.gain, kind: r.kind })),
  }
}

export function formatExperiment(sel) {
  if (!sel || !sel.id) return ""
  const gain = Number.isFinite(sel.gain) ? Number(sel.gain).toFixed(3) : "?"
  let s = `Next experiment (${sel.id}, gain=${gain}, kind=${sel.kind}): ${sel.instruction}`
  if (sel.avoided && sel.avoided.length) {
    s += `\nAvoided (already uninformative): ${sel.avoided.slice(0, 6).join(", ")}`
  }
  return s
}

export function createInfoGainEngine() {
  const history = []

  function record(id, result = null) {
    const rec = { id: String(id || ""), result: result ?? null, at: Date.now() }
    if (!rec.id) return rec
    history.push(rec)
    return rec
  }

  function tried() {
    return countsOf(history)
  }

  function looping(id) {
    return (tried()[id] || 0) >= 2
  }

  function select(ctx = {}) {
    return selectExperiment({ ...ctx, tried: tried(), history })
  }

  function snapshot() {
    return history.map((h) => ({ ...h }))
  }

  return { record, tried, looping, select, snapshot, size: () => history.length }
}

export { CATALOG }
