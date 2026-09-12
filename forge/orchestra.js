/**
 * forge — master orchestrator (v91 ULTIMATE, zero dependencies)
 *
 * The multi-agent roster, as a MAPPING — not a second agent runtime.
 *
 * agentmanager.js already owns role identity and the single-writer invariant
 * (ROLES + roleIsReadOnly: only `coder` may mutate, everything else is
 * read-only). meta.js already owns the lifecycle (PLAN → DAG → segments →
 * VERIFY → REPAIR → RECOVER). This module duplicates none of it. It adds the
 * one thing that was missing: a named, ordered crew for a task class, and a
 * deterministic advisory pack for the roles that do not need a model call at
 * all (git, memory, docs, optimize, report).
 *
 * Rules this module enforces:
 *  - every orchestration role maps onto an existing agentmanager role, so the
 *    read-only/write invariant cannot drift between the two vocabularies
 *  - exactly one mutating role per task (executor → coder). Never two writers.
 *  - advisory roles add ZERO model calls: they assemble evidence from modules
 *    that already exist (compose, memory, lessons, knowtype, claims, decisions,
 *    verifyledger, completion, evolve). Call-count tests stay stable.
 *  - a role that needs a model (researcher, docs drafting) is dispatched
 *    read-only through the caller's existing runAgent — never a new loop.
 */
import { ROLES, roleIsReadOnly } from "./agentmanager.js"
import { TASK_CLASS, strategyFor } from "./classify.js"
import { PHASE, gateChecks } from "./objective.js"
import { integrateResults, isIntegratorRole, reportsFromGraph } from "./integrate.js"
import { formatReview, needsReview } from "./review.js"
import { formatKnowtype, listKnowledge } from "./knowtype.js"
import { formatClaimLines, listClaims } from "./claims.js"
import { formatDecisionLines, listDecisions } from "./decisions.js"
import { relevantLessons, formatLessons } from "./lessons.js"
import { relevantMemory } from "./memory.js"

/** Orchestration identities. `role` is the agentmanager role that executes it,
 *  which is where read-only/write authority is actually decided. */
export const ROLE = Object.freeze({
  INTENT: "intent_analyzer",
  PLANNER: "planner",
  ARCHITECT: "project_architect",
  RESEARCHER: "researcher",
  REVIEWER: "reviewer",
  EXECUTOR: "executor",
  DEBUGGER: "debugger",
  TESTER: "tester",
  OPTIMIZER: "optimizer",
  DOCS: "documentation_writer",
  GIT: "git_manager",
  MEMORY: "memory_manager",
  REPORTER: "reporter",
})

/** The crew, in dispatch order, with the phase each one owns. */
export const CREW = Object.freeze([
  { key: ROLE.INTENT, label: "Intent Analyzer", role: ROLES.PLANNER, phase: PHASE.ANALYZE, needsModel: false, advisory: true, duty: "classify the task, extract acceptance criteria, detect the real intent behind the wording" },
  { key: ROLE.RESEARCHER, label: "Researcher", role: ROLES.RESEARCHER, phase: PHASE.RESEARCH, needsModel: true, advisory: false, duty: "read the code and docs the task actually touches; report what exists, never what should exist" },
  { key: ROLE.REVIEWER, label: "Reviewer", role: ROLES.REVIEWER, phase: PHASE.REVIEW, needsModel: false, advisory: true, duty: "pre-edit review: duplicates, dead code, architecture drift, security smells" },
  { key: ROLE.PLANNER, label: "Planner", role: ROLES.PLANNER, phase: PHASE.PLAN, needsModel: true, advisory: false, duty: "turn the objective into ordered steps a single writer can execute" },
  { key: ROLE.ARCHITECT, label: "Project Architect", role: ROLES.ARCHITECT, phase: PHASE.PLAN, needsModel: false, advisory: true, duty: "module boundaries, blast radius, alternatives, backward compatibility" },
  { key: ROLE.EXECUTOR, label: "Executor", role: ROLES.CODER, phase: PHASE.EXECUTE, needsModel: true, advisory: false, duty: "the ONLY mutating role — edits, patches, builds" },
  { key: ROLE.TESTER, label: "Tester", role: ROLES.TESTER, phase: PHASE.VERIFY, needsModel: true, advisory: false, duty: "run the project's real test/build/lint command and report evidence" },
  { key: ROLE.DEBUGGER, label: "Debugger", role: ROLES.DEBUGGER, phase: PHASE.REPAIR, needsModel: true, advisory: false, duty: "classify the failure, form a hypothesis, propose the smallest repair" },
  { key: ROLE.OPTIMIZER, label: "Optimizer", role: ROLES.REVIEWER, phase: PHASE.OPTIMIZE, needsModel: false, advisory: true, duty: "hot paths, repeated work, allocation/perf smells in what just changed" },
  { key: ROLE.DOCS, label: "Documentation Writer", role: ROLES.RESEARCHER, phase: PHASE.DOCUMENT, needsModel: false, advisory: true, duty: "README / CHANGELOG / API / migration deltas implied by the diff" },
  { key: ROLE.GIT, label: "Git Manager", role: ROLES.INTEGRATOR, phase: PHASE.DOCUMENT, needsModel: false, advisory: true, duty: "commit summary, breaking-change detection, history context" },
  { key: ROLE.MEMORY, label: "Memory Manager", role: ROLES.INTEGRATOR, phase: PHASE.LEARN, needsModel: false, advisory: true, duty: "what to remember, what to forget, which lessons this run produced" },
  { key: ROLE.REPORTER, label: "Reporter", role: ROLES.INTEGRATOR, phase: PHASE.REPORT, needsModel: false, advisory: true, duty: "the final report: analysis, findings, verification, files, remaining issues" },
])

/** Which workflow steps (classify.strategyFor) each crew member implements.
 *  A crew member is selected when the class workflow needs its step — so the
 *  roster is derived from the existing strategy table, not a second table. */
const STEP_OF = {
  [ROLE.RESEARCHER]: ["inspect", "repo-model", "recover", "reconcile"],
  [ROLE.REVIEWER]: ["review", "alternatives"],
  [ROLE.PLANNER]: ["plan"],
  [ROLE.ARCHITECT]: ["architecture", "impact", "repo-model"],
  [ROLE.EXECUTOR]: ["implement", "patch", "dag", "parallel", "integrate"],
  [ROLE.TESTER]: ["test", "regression", "verify"],
  [ROLE.DEBUGGER]: ["diagnose", "repair"],
  [ROLE.OPTIMIZER]: ["regression"],
  [ROLE.DOCS]: ["integrate", "verify"],
  [ROLE.GIT]: ["integrate", "verify"],
}

/** Always-on crew: intent, the single writer, the tester and the memory/report
 *  trail exist for every task, however small. */
const ALWAYS = new Set([ROLE.INTENT, ROLE.EXECUTOR, ROLE.TESTER, ROLE.MEMORY, ROLE.REPORTER])

/** Class rank — the smallest task class each crew member is worth waking for.
 *  A typo fix does not get an architect, an optimizer and a docs writer. */
export const CLASS_RANK = Object.freeze({
  [TASK_CLASS.MICRO]: 0,
  [TASK_CLASS.SMALL]: 1,
  [TASK_CLASS.MEDIUM]: 2,
  [TASK_CLASS.LARGE]: 3,
  [TASK_CLASS.ARCHITECTURAL]: 4,
  [TASK_CLASS.RECOVERY]: 2,
})

/** LARGE and up always carry these four, whatever the workflow table names. */
const ANALYSIS_QUARTET = new Set([ROLE.REVIEWER, ROLE.ARCHITECT, ROLE.DEBUGGER, ROLE.OPTIMIZER])

const MIN_RANK = Object.freeze({
  [ROLE.INTENT]: 0,
  [ROLE.EXECUTOR]: 0,
  [ROLE.TESTER]: 0,
  [ROLE.MEMORY]: 0,
  [ROLE.REPORTER]: 0,
  [ROLE.RESEARCHER]: 1,
  [ROLE.PLANNER]: 2,
  [ROLE.DEBUGGER]: 2,
  [ROLE.DOCS]: 2,
  [ROLE.GIT]: 2,
  [ROLE.REVIEWER]: 3,
  [ROLE.ARCHITECT]: 3,
  [ROLE.OPTIMIZER]: 3,
})

/**
 * Authority, made explicit.
 *
 * `platformReadOnly` is what agentmanager.js says about the role (note: `debugger`
 * is NOT read-only there — it may apply repairs). `readOnly` is what THIS
 * orchestrator grants: every role except the executor is dispatched read-only,
 * because repairs go through the single mutating writer path in meta.js. The two
 * columns disagreeing is deliberate and visible, never silent.
 */
function grant(c) {
  const writer = c.key === ROLE.EXECUTOR
  return { ...c, writer, readOnly: !writer, platformReadOnly: roleIsReadOnly(c.role) }
}

/** The writers in a roster. The invariant: exactly one, and it is the executor. */
export function writersOf(rows = []) {
  return rows.filter((r) => r.writer || r.readOnly === false)
}

export function singleWriterOk(rows = []) {
  const w = writersOf(rows)
  return { ok: w.length === 1 && w[0].key === ROLE.EXECUTOR, writers: w.map((r) => r.key) }
}

/**
 * The crew for a task class, derived from strategyFor(klass).workflow plus a
 * class floor: MICRO gets 5 people, LARGE and ARCHITECTURAL get the whole crew.
 * Selection is derived from the existing strategy table — never a second one.
 * @returns {Array<{key,label,role,phase,readOnly,needsModel,advisory,duty}>}
 */
export function rosterFor(klass = TASK_CLASS.MEDIUM) {
  const strategy = strategyFor(klass)
  const steps = new Set(strategy.workflow || [])
  const rank = CLASS_RANK[klass] ?? CLASS_RANK[TASK_CLASS.MEDIUM]
  // LARGE and up always carry the analysis quartet: a big change needs a
  // reviewer, an architect, a debugger and an optimizer even when the class
  // workflow table happens not to name their step.
  const picked = CREW.filter((c) => ALWAYS.has(c.key)
    || (rank >= 3 && ANALYSIS_QUARTET.has(c.key))
    || (rank >= (MIN_RANK[c.key] ?? 0) && (STEP_OF[c.key] || []).some((s) => steps.has(s))))
  // The single-writer invariant is structural, not aspirational: the executor is
  // the only member granted write access (see grant()).
  return picked.map(grant)
}

/** Roles grouped by the phase that owns them (what the HUD prints). */
export function phasesFor(klass = TASK_CLASS.MEDIUM) {
  const rows = rosterFor(klass)
  const out = new Map()
  for (const r of rows) {
    if (!out.has(r.phase)) out.set(r.phase, [])
    out.get(r.phase).push(r.key)
  }
  return [...out.entries()].map(([phase, roles]) => ({ phase, roles }))
}

/** Does this class require an explicit approval step before EXECUTE? */
export function approvalRequired(klass = TASK_CLASS.MEDIUM) {
  return needsReview(klass) || klass === TASK_CLASS.ARCHITECTURAL
}

/**
 * The deterministic advisory pack — evidence the advisory roles contribute
 * WITHOUT a model call. Every block is best-effort: a missing store yields an
 * empty section, never a throw (advisories must never break a run).
 *
 * @param {{cwd?: string, objective?: string, klass?: string, gate?: object, review?: object,
 *          ledger?: object, dag?: object, files?: string[], compose?: object, limits?: object}} input
 * @returns {{sections: Array<{role: string, title: string, text: string}>, roles: string[]}}
 */
export function advisories({
  cwd = process.cwd(), objective = "", klass = TASK_CLASS.MEDIUM,
  gate = null, review = null, ledger = null, dag = null, files = [],
  compose = null, limits = {},
} = {}) {
  const crew = new Set(rosterFor(klass).map((r) => r.key))
  const sections = []
  const push = (role, title, text) => {
    if (!crew.has(role)) return
    const body = String(text ?? "").trim()
    if (body) sections.push({ role, title, text: body })
  }

  // --- Reviewer: the existing adversarial checklist, when it applies --------
  if (review) {
    const line = formatReview(review)
    push(ROLE.REVIEWER, "pre-completion review", line)
  }

  // --- Architect: blast radius from the compose snapshot --------------------
  if (compose?.world?.graph?.files?.length) {
    const g = compose.world.graph
    const touched = new Set((files || []).map((f) => String(f).replace(/^\.\//, "")))
    const edges = (g.edges || []).filter((e) => touched.has(String(e.to).replace(/^\.\//, "")) || touched.has(String(e.from).replace(/^\.\//, "")))
    const importers = [...new Set(edges.map((e) => String(e.from).replace(/^\.\//, "")))].filter((f) => !touched.has(f))
    push(ROLE.ARCHITECT, "blast radius", [
      `changed: ${(files || []).length} file(s)`,
      importers.length ? `importers affected: ${importers.slice(0, 10).join(", ")}${importers.length > 10 ? ` (+${importers.length - 10})` : ""}` : "no importers of the changed files in the index",
      `graph size: ${g.files.length} files / ${(g.edges || []).length} edges`,
    ].join("\n"))
  }

  // --- Memory Manager: what is already known, so nothing is repeated --------
  try {
    const mem = relevantMemory(objective, { cwd, limit: limits.memory ?? 4 })
    push(ROLE.MEMORY, "remembered about this objective", mem || "(nothing recorded yet)")
  } catch { /* memory is optional */ }

  try {
    // relevantLessons returns OBJECTS; formatting them is lessons.js's job.
    // Interpolating the array printed "[object Object]" in the report.
    const lessons = formatLessons(relevantLessons(objective, { cwd, limit: limits.lessons ?? 3 }))
    push(ROLE.MEMORY, "past failures on similar work", lessons || "(no prior failures recorded)")
  } catch { /* lessons are optional */ }

  try {
    const know = listKnowledge(cwd).slice(0, limits.knowledge ?? 6)
    if (know.length) push(ROLE.MEMORY, "typed knowledge", formatKnowtype(know))
  } catch { /* knowtype store is optional */ }

  try {
    const claims = listClaims(cwd).slice(0, limits.claims ?? 5)
    if (claims.length) push(ROLE.GIT, "claims on record", formatClaimLines(claims))
  } catch { /* claims store is optional */ }

  try {
    const dec = listDecisions(cwd).slice(0, limits.decisions ?? 5)
    if (dec.length) push(ROLE.ARCHITECT, "architecture decisions", formatDecisionLines(dec))
  } catch { /* decisions store is optional */ }

  // --- Tester: what the ledger already proves -------------------------------
  if (ledger?.all) {
    try {
      const all = ledger.all()
      const passed = all.filter((r) => r.passed).length
      const failed = all.filter((r) => r.passed === false)
      push(ROLE.TESTER, "verification ledger", [
        `${all.length} command(s) recorded — ${passed} passed, ${failed.length} failed`,
        ...failed.slice(0, 3).map((f) => `  ✗ ${String(f.command || "").slice(0, 120)}`),
        ...all.slice(-3).map((r) => `  ${r.passed ? "✓" : "✗"} ${String(r.command || "").slice(0, 120)}`),
      ].join("\n"))
    } catch { /* ledger shape unknown: skip */ }
  }

  // --- Reporter: worker reports, merged the existing way --------------------
  if (dag) {
    try {
      const reports = reportsFromGraph(dag)
      if (reports.length) {
        const merged = integrateResults({ objective, reports })
        push(ROLE.REPORTER, "worker findings", String(merged.text || "").slice(0, 1200))
        if (merged.conflicts?.length) push(ROLE.REPORTER, "conflicting write sets", merged.conflicts.map((c) => `  ! ${c.file || c.key || "?"}`).join("\n"))
      }
    } catch { /* integration is best-effort */ }
  }

  // --- Gate: the reporter states the gate honestly --------------------------
  const checks = gateChecks(gate)
  if (checks.length) {
    push(ROLE.REPORTER, "completion gate", checks.map((c) => `  ${c.ok ? "✓" : "✗"} ${c.check}${c.detail ? ` — ${c.detail}` : ""}`).join("\n"))
  }

  return { sections, roles: [...new Set(sections.map((s) => s.role))] }
}

/** Render the advisory pack for a prompt or the report. */
export function formatAdvisories(adv, { maxWidth = 1600 } = {}) {
  const rows = (adv?.sections || []).map((s) => `[${s.role}] ${s.title}\n${s.text}`)
  if (!rows.length) return ""
  const out = rows.join("\n\n")
  return out.length > maxWidth ? `${out.slice(0, maxWidth)}\n… (advisory pack truncated)` : out
}

/** Render the crew table (`forge roles --crew`, /agent crew). */
export function formatRoster(rows, { pad = 22 } = {}) {
  const out = []
  for (const r of rows || []) {
    out.push(`  ${String(r.label || r.key).padEnd(pad)} ${String(r.role).padEnd(11)} ${r.readOnly ? "read-only" : "WRITER (the only one)"}  ${r.needsModel ? "model" : "deterministic"}  ${String(r.phase).padEnd(9)} ${r.platformReadOnly === false && r.readOnly ? "(platform may mutate; orchestration does not)" : ""}`.trimEnd())
  }
  return out.join("\n")
}

/** Re-export so callers do not need two imports for one vocabulary. */
export { ROLES, roleIsReadOnly, isIntegratorRole, TASK_CLASS }
