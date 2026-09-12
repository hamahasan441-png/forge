/**
 * forge — crew execution (v92 PROCREW, zero dependencies)
 *
 * orchestra.js answers "who is on this task". This module answers "what do they
 * actually DO, in parallel, without stepping on each other".
 *
 * It is a SCHEDULER, not a second agent runtime:
 *  - work is spawned through the caller's existing runner (meta.js wires it to
 *    agentmanager.spawn → runAgent), so there is exactly one tool loop in the
 *    product and one set of budgets
 *  - concurrency slots, timeouts and cancellation belong to agentmanager; this
 *    module only decides WHAT to spawn, in which wave, and what to do when a
 *    unit comes back empty or wrong
 *  - conflict prevention reuses dag.canonicalConflictKeys, the same key space
 *    the DAG scheduler already uses, so the two schedulers cannot disagree
 *  - merging reuses integrate.integrateResults, the same merge the DAG's
 *    integrator node uses
 *
 * The three guarantees the spec asks for, and where each one lives:
 *  1. independent units run concurrently            → waves()
 *  2. no duplicate work, no conflicting edits        → dedupeUnits() + waves()
 *  3. a failed unit is retried under another strategy → reassignFor()
 * Plus: every unit reviews its own output before it is merged (selfReview()).
 */
import { ROLES, roleIsReadOnly } from "./agentmanager.js"
import { ROLE } from "./orchestra.js"
import { canonicalConflictKeys } from "./dag.js"
import { integrateResults } from "./integrate.js"
import { adversarialReview } from "./review.js"

export const CREW_LIMITS = Object.freeze({
  /** Hard ceiling on units per task: a 40-step plan is not 40 sub-agents. */
  maxUnits: 24,
  /** original attempt + 1 reassignment under a different role. */
  maxAttemptsPerUnit: 2,
  perUnitTimeoutMs: 120_000,
  /** how much project context a unit sees (the rest is demand-loaded by tools) */
  contextChars: 3500,
  /** a finding longer than this is a page dump, not a finding */
  findingChars: 4000,
  /** below this length a unit produced nothing worth merging */
  minFindingChars: 24,
})

/**
 * Which crew member owns a piece of work, inferred from its wording. Only used
 * when the plan step does not already name a role — the plan's own role always
 * wins, so this never overrides an explicit decision.
 */
const ROLE_HINTS = Object.freeze([
  // A task about RUNNING tests belongs to the tester; a task about a FAILURE
  // belongs to the debugger. Order matters, so the tester's pattern is narrow
  // ("run the tests", "test suite", "coverage") and comes first — otherwise
  // "run the unit tests and report which fail" would be read as a debug task.
  [ROLE.TESTER, /\b(run the (unit |integration |e2e )?tests?|test suite|coverage|run the build|run the linter)\b/i],
  [ROLE.DEBUGGER, /\b(debug|root[- ]cause|stack ?trace|exception|panic|traceback|error|fail|crash|regression)\b/i],
  [ROLE.OPTIMIZER, /\b(perf|performance|slow|latency|memory|allocat|hot ?path|optimi[sz]e|benchmark)\b/i],
  [ROLE.DOCS, /\b(readme|changelog|doc|docs|jsdoc|comment|api reference|migration note)\b/i],
  [ROLE.ARCHITECT, /\b(architect|module boundar|blast radius|design|refactor plan|layering|dependency graph)\b/i],
  [ROLE.RESEARCHER, /\b(read|inspect|find|locate|survey|history|git log|schema|config file|api surface)\b/i],
  [ROLE.REVIEWER, /\b(review|duplicat|dead code|smell|security review|adversarial)\b/i],
  [ROLE.PLANNER, /\b(plan|break (down|into)|steps|sequence|milestone)\b/i],
  [ROLE.GIT, /\b(commit|branch|merge|revert|tag|release|history)\b/i],
  [ROLE.MEMORY, /\b(remember|forget|lesson|preference|convention|knowledge)\b/i],
])

/** The crew member that runs a unit, given an optional explicit role. */
export function roleForKey(text = "", fallback = ROLE.RESEARCHER) {
  const t = String(text ?? "")
  for (const [key, re] of ROLE_HINTS) if (re.test(t)) return key
  return fallback
}

/**
 * A short, stable identity for a unit of work: same role + same words = the same
 * job. Used to refuse duplicate work before it costs a model call.
 */
export function fingerprint(unit = {}) {
  const norm = String(unit.task ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .sort()
    .slice(0, 24)
    .join(" ")
  return `${unit.key ?? "unknown"}::${norm}`
}

/**
 * Build the independent units of work for a task.
 *
 * @param {object}   input
 * @param {string}   input.objective
 * @param {Array}    input.steps    plan steps / DAG nodes: {id,objective,role?,
 *                                  targetFiles?,targetSymbols?,read_only?}
 * @param {Array}    input.crew     roster rows from orchestra.rosterFor()
 * @param {string}   input.context  shared project context
 * @returns {Array<object>} units, each spawnable
 */
export function workUnits({ objective = "", steps = [], crew = [], context = "" } = {}) {
  const rows = Array.isArray(crew) ? crew : []
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const list = Array.isArray(steps) ? steps : []
  const units = []
  let seq = 0
  for (const s of list) {
    if (units.length >= CREW_LIMITS.maxUnits) break
    const text = String(s?.objective ?? s?.task ?? s?.text ?? "").trim()
    if (!text) continue
    // an explicit role in the plan wins; otherwise infer from the wording
    const explicit = String(s?.role ?? "").trim()
    const key = explicit && byKey.has(explicit) ? explicit : roleForKey(text)
    const member = byKey.get(key) || byKey.get(ROLE.RESEARCHER) || null
    if (!member) continue
    // The executor writes. Sub-agents never do — one writer is structural.
    const writer = member.writer === true || member.readOnly === false
    const targetFiles = Array.isArray(s?.targetFiles) ? s.targetFiles.map(String).filter(Boolean) : []
    units.push({
      id: `u${++seq}`,
      stepId: s?.id ?? null,
      key: member.key,
      label: member.label,
      role: writer ? ROLES.CODER : member.role,
      phase: member.phase,
      // a unit inherits the member's authority; a sub-agent is never promoted
      readOnly: writer ? false : true,
      platformReadOnly: writer ? !roleIsReadOnly(ROLES.CODER) : roleIsReadOnly(member.role),
      needsModel: member.needsModel !== false,
      task: text.slice(0, 2000),
      objective,
      context: String(context ?? "").slice(0, CREW_LIMITS.contextChars),
      targetFiles,
      targetSymbols: Array.isArray(s?.targetSymbols) ? s.targetSymbols.map(String) : [],
      targetDirs: Array.isArray(s?.targetDirs) ? s.targetDirs.map(String) : [],
      resourceLocks: Array.isArray(s?.resourceLocks) ? s.resourceLocks.map(String) : [],
      attempts: 0,
      status: "queued",
    })
  }
  return units
}

/**
 * Drop duplicate work. Two units with the same fingerprint are the same job
 * asked twice; the first keeps it, the rest are recorded as duplicates so the
 * report can say why they were not run.
 * @returns {{units: Array, duplicates: Array<{id,fingerprint,sameAs}>}}
 */
export function dedupeUnits(units = []) {
  const seen = new Map()
  const kept = []
  const duplicates = []
  for (const u of units) {
    const fp = fingerprint(u)
    if (seen.has(fp)) {
      const twin = seen.get(fp)
      duplicates.push({ id: u.id, stepId: u.stepId ?? null, fingerprint: fp, sameAs: twin.stepId ?? twin.id, sameAsUnit: twin.id })
      continue
    }
    seen.set(fp, u)
    u.fingerprint = fp
    kept.push(u)
  }
  return { units: kept, duplicates }
}

/**
 * Group units into waves that may run concurrently.
 *
 * Two units share a wave only when their canonical conflict keys are disjoint —
 * the same key space dag.scheduleBatch uses, so a unit can never be scheduled
 * against a file another running unit already holds. Read-only units that touch
 * nothing still get a `unit:<id>` key, which keeps the waves stable.
 *
 * @returns {Array<Array<object>>} waves, in execution order
 */
export function waves(units = [], { maxParallel = 8 } = {}) {
  const cap = Math.max(1, maxParallel | 0)
  const pending = [...units]
  const out = []
  while (pending.length) {
    const held = new Set()
    const wave = []
    for (let i = 0; i < pending.length; ) {
      const u = pending[i]
      const keys = conflictKeysOf(u)
      const clash = keys.some((k) => held.has(k))
      if (!clash && wave.length < cap) {
        for (const k of keys) held.add(k)
        wave.push(u)
        pending.splice(i, 1)
      } else i++
    }
    // nothing could be scheduled (every remaining unit conflicts with itself)
    if (!wave.length) { wave.push(pending.shift()) }
    out.push(wave)
    if (out.length > units.length) break // paranoia: never loop forever
  }
  return out
}

/** Canonical conflict keys for a unit, in dag's key space. */
export function conflictKeysOf(unit = {}) {
  let keys
  try {
    keys = canonicalConflictKeys(unit)
  } catch { keys = null }
  if (!Array.isArray(keys) || !keys.length) keys = [`unit:${unit.id ?? "unknown"}`]
  return keys.map(String)
}

/**
 * The next role to try when a unit fails.
 *
 * A failure is information: the SAME role asked again is a loop, not a retry.
 * The reassignment ladder prefers the role that can actually fix that class of
 * problem, and never returns the role that already failed.
 *
 * @param {object} unit          the failed unit (must carry .key)
 * @param {Array}  crew          the roster
 * @param {Array}  [tried]       keys already attempted for this unit
 * @returns {object|null} the next crew row, or null when the ladder is exhausted
 */
export function reassignFor(unit = {}, crew = [], tried = []) {
  const roster = Array.isArray(crew) ? crew : []
  const attempted = new Set([unit?.key, ...tried].filter(Boolean))
  // a read-only investigation that failed is a research/debug problem; a
  // verification that failed is a debugging problem; docs that failed need a
  // researcher to read the code first.
  const ladder = {
    [ROLE.RESEARCHER]: [ROLE.DEBUGGER, ROLE.ARCHITECT, ROLE.REVIEWER],
    [ROLE.DEBUGGER]: [ROLE.TESTER, ROLE.ARCHITECT, ROLE.RESEARCHER],
    [ROLE.TESTER]: [ROLE.DEBUGGER, ROLE.RESEARCHER],
    [ROLE.OPTIMIZER]: [ROLE.REVIEWER, ROLE.RESEARCHER],
    [ROLE.DOCS]: [ROLE.RESEARCHER, ROLE.REVIEWER],
    [ROLE.ARCHITECT]: [ROLE.REVIEWER, ROLE.RESEARCHER],
    [ROLE.REVIEWER]: [ROLE.ARCHITECT, ROLE.RESEARCHER],
    [ROLE.PLANNER]: [ROLE.ARCHITECT, ROLE.RESEARCHER],
    [ROLE.GIT]: [ROLE.RESEARCHER],
    [ROLE.MEMORY]: [ROLE.RESEARCHER],
    [ROLE.INTENT]: [ROLE.PLANNER, ROLE.RESEARCHER],
    [ROLE.EXECUTOR]: [ROLE.DEBUGGER, ROLE.ARCHITECT],
  }
  for (const key of ladder[unit?.key] || [ROLE.RESEARCHER, ROLE.DEBUGGER]) {
    if (attempted.has(key)) continue
    const row = roster.find((r) => r.key === key)
    if (row) return row
  }
  return null
}

/**
 * A unit reviews its own output before it is merged.
 *
 * Uses the existing adversarial review, scoped to the unit's own finding, so a
 * self-review costs no model call and cannot invent new work. Returns
 * `{ok, issues}` — `ok:false` means the caller may re-run the unit once with the
 * issues appended as instructions.
 */
export function selfReview({ unit = {}, text = "", klass = null } = {}) {
  const body = String(text ?? "").trim()
  if (!body) return { ok: false, issues: ["empty finding"] }
  try {
    const rev = adversarialReview({
      klass,
      objective: unit.objective || unit.task || "",
      plan: unit.task || "",
      text: body,
      files: Array.isArray(unit.targetFiles) ? unit.targetFiles : [],
    })
    const issues = (rev?.issues || []).map((i) => String(i?.why ?? i?.text ?? i)).slice(0, 4)
    return { ok: issues.length === 0, issues, verdict: rev?.verdict ?? null }
  } catch {
    // a review that cannot run must not fail the unit: report, don't block
    return { ok: true, issues: [], skipped: true }
  }
}

/**
 * Run a crew.
 *
 * @param {object}   input
 * @param {Array}    input.units     from workUnits() (+ dedupeUnits())
 * @param {Array}    input.crew      roster rows
 * @param {Function} input.spawn     ({role,task,context,readOnly,targetFiles,...})
 *                                   → Promise<{status,result,error}> — meta.js
 *                                   wires this to agentmanager.spawn()
 * @param {Function} [input.isRejected] (unit) => bool  memory: skip a unit whose
 *                                   approach was already rejected by the user
 * @param {Function} [input.merge]   ({objective,reports}) => {text,...}
 * @param {Function} [input.emit]    event sink
 * @param {number}   [input.maxParallel]
 * @param {object}   [input.limits]
 * @returns {Promise<{ok:boolean,results:Array,findings:string,merged:object,
 *                    modelCalls:number,reassigned:number,skipped:Array}>}
 */
export async function runCrew({
  units = [], crew = [], spawn = null, isRejected = null, merge = null,
  emit = null, maxParallel = 4, limits = {}, signal = null,
} = {}) {
  const L = { ...CREW_LIMITS, ...limits }
  const ev = (e) => { try { emit?.(e) } catch { /* observability never breaks a run */ } }
  const doMerge = typeof merge === "function" ? merge : ({ objective, reports }) => integrateResults({ objective, reports })
  const results = []
  const skipped = []
  let modelCalls = 0
  let reassigned = 0

  const planned = waves(units, { maxParallel })
  ev({ type: "CREW_DISPATCH", units: units.length, waves: planned.length, parallel: maxParallel, roles: [...new Set(units.map((u) => u.key))] })

  for (const wave of planned) {
    if (signal?.aborted) break
    const settled = await Promise.all(wave.map(async (u) => runUnit(u)))
    results.push(...settled)
  }

  const done = results.filter((r) => r.ok)
  const findings = done.map((r) => `--- ${r.label} (${r.key})${r.reassigned ? ", reassigned from " + r.from : ""} ---\n${r.text}`).join("\n\n")
  let merged = { text: "", apply: [], conflicts: [] }
  try {
    merged = doMerge({ objective: units[0]?.objective || "", reports: done.map((r) => ({ role: r.key, text: r.text })) }) || merged
  } catch (e) {
    ev({ type: "CREW_MERGE_FAILED", error: String(e?.message ?? e).slice(0, 200) })
  }
  ev({ type: "CREW_MERGED", ok: done.length > 0, units: results.length, findings: done.length, modelCalls, reassigned, skipped: skipped.length })
  return {
    ok: done.length > 0 || results.length === 0,
    results, findings, merged, modelCalls, reassigned, skipped,
    failed: results.filter((r) => !r.ok).map((r) => ({ id: r.id, stepId: r.stepId, key: r.key, error: r.error })),
    modelCallCount: modelCalls,
  }

  async function runUnit(u) {
    if (typeof isRejected === "function") {
      let rejected = false
      try { rejected = isRejected(u) === true } catch { rejected = false }
      if (rejected) {
        u.status = "skipped"
        skipped.push({ id: u.id, key: u.key, reason: "approach previously rejected" })
        ev({ type: "CREW_UNIT_SKIPPED", unitId: u.id, key: u.key, reason: "previously rejected" })
        return { id: u.id, stepId: u.stepId, key: u.key, label: u.label, ok: false, skipped: true, text: "", error: "previously rejected" }
      }
    }
    let row = crew.find((r) => r.key === u.key) || null
    const tried = [u.key]
    let last = null
    for (let attempt = 1; attempt <= L.maxAttemptsPerUnit; attempt++) {
      if (signal?.aborted) return { id: u.id, stepId: u.stepId, key: u.key, label: u.label, ok: false, text: "", error: "cancelled" }
      u.attempts = attempt
      const extra = attempt > 1 && last?.issues?.length
        ? `\n\nYour previous attempt was rejected by self-review: ${last.issues.join("; ")}. Address those specifically.`
        : ""
      let rec = null
      try {
        modelCalls += 1
        rec = await spawn({
          role: u.role,
          task: `${u.task}${extra}`,
          context: u.context,
          readOnly: u.readOnly !== false,
          targetFiles: u.targetFiles, targetSymbols: u.targetSymbols, targetDirs: u.targetDirs, resourceLocks: u.resourceLocks,
          timeoutMs: L.perUnitTimeoutMs,
          unitId: u.id,
        })
      } catch (e) {
        rec = { status: "error", result: "", error: String(e?.message ?? e) }
      }
      const text = String(rec?.result ?? "").trim()
      const okRun = rec?.status === "completed" && text.length >= L.minFindingChars
      const review = okRun ? selfReview({ unit: u, text }) : { ok: false, issues: [String(rec?.error || "no output")] }
      last = { text, review, error: okRun ? null : String(rec?.error || "empty or too short") }
      ev({ type: "CREW_UNIT", unitId: u.id, key: row?.key ?? u.key, attempt, ok: okRun && review.ok, selfReviewOk: review.ok, chars: text.length })
      if (okRun && review.ok) {
        u.status = "completed"
        return { id: u.id, stepId: u.stepId, key: row?.key ?? u.key, label: row?.label ?? u.label, ok: true, text: text.slice(0, L.findingChars), attempts: attempt, review }
      }
      // strategy change, not a retry: the same role asked twice is a loop
      const next = reassignFor({ key: row?.key ?? u.key }, crew, tried)
      if (!next || attempt >= L.maxAttemptsPerUnit) break
      tried.push(next.key)
      reassigned += 1
      ev({ type: "CREW_REASSIGNED", unitId: u.id, from: row?.key ?? u.key, to: next.key, reason: last.error || "self-review" })
      u.key = next.key
      u.role = next.role
      u.readOnly = next.writer === true ? u.readOnly : true // never promote a sub-agent to writer
      row = next
    }
    u.status = "failed"
    return { id: u.id, stepId: u.stepId, key: u.key, label: row?.label ?? u.label, ok: false, text: "", attempts: u.attempts, error: last?.error || "failed", review: last?.review || null, from: tried[0] !== u.key ? tried[0] : null }
  }
}

/** Human-readable summary of a crew run (the HUD and the final report). */
export function formatCrew(result = {}) {
  const lines = []
  const done = (result.results || []).filter((r) => r.ok)
  const failed = (result.results || []).filter((r) => !r.ok)
  lines.push(`crew: ${done.length}/${(result.results || []).length} unit(s) produced findings • ${result.modelCalls ?? 0} model call(s)${result.reassigned ? ` • ${result.reassigned} reassigned` : ""}${(result.skipped || []).length ? ` • ${result.skipped.length} skipped (rejected before)` : ""}`)
  const wavesSeen = [...new Set(done.map((r) => r.key))]
  if (wavesSeen.length) lines.push(`  specialists heard from: ${wavesSeen.join(", ")}`)
  for (const f of failed) lines.push(`  ${f.skipped ? "skipped" : "no finding"}: ${f.key} — ${String(f.error || "").slice(0, 90)}`)
  for (const d of result.skipped || []) lines.push(`  skipped ${d.key}: ${d.reason}`)
  return lines.join("\n")
}
