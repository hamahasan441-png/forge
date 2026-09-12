/**
 * forge — the final report (v91 ULTIMATE, zero dependencies)
 *
 * One artifact, ten sections, always in the same order, built from evidence that
 * already exists: the objective record (objective.js), the task state
 * (taskstate.js), the completion gate (completion.js), the verification ledger
 * (verifyledger.js), the review checklist (review.js), the advisory crew
 * (orchestra.js) and the doc/git deltas (docsintel.js).
 *
 * The report never asserts something it cannot cite. A section with no evidence
 * says so in one line instead of inventing a plausible sentence — that is the
 * whole reason this is a module and not a model prompt.
 */
import { formatPipeline } from "./pipeline.js"
import fs from "node:fs"
import path from "node:path"
import { projectDir } from "./memory.js"
import { writeStateFile } from "./securefs.js"
import { redact } from "./secrets.js"
import { OBJ_STATUS, phaseTable, progressOf, gateChecks, gateBlockers } from "./objective.js"
import { changelogSection } from "./docsintel.js"

export const REPORT_DIRNAME = "reports"

/** The ten sections, in the order they are always printed. */
export const REPORT_SECTIONS = Object.freeze([
  "analysis", "review_findings", "execution_plan", "progress", "verification",
  "files_changed", "bugs_fixed", "performance", "remaining_issues", "next_improvements",
])

const TITLES = Object.freeze({
  analysis: "Analysis",
  review_findings: "Review Findings",
  execution_plan: "Execution Plan",
  progress: "Progress",
  verification: "Verification Results",
  files_changed: "Files Changed",
  bugs_fixed: "Bugs Fixed",
  performance: "Performance Improvements",
  remaining_issues: "Remaining Issues",
  next_improvements: "Recommended Next Improvements",
})

const NONE = {
  analysis: "(no analysis recorded)",
  review_findings: "no review findings — nothing was flagged before or after the edit",
  execution_plan: "(no plan recorded)",
  progress: "(no progress recorded)",
  verification: "no verification evidence recorded — the objective cannot be claimed as met",
  files_changed: "no files changed",
  bugs_fixed: "no bugs were fixed by this run",
  performance: "no measured performance change",
  remaining_issues: "none recorded",
  next_improvements: "none suggested",
}

export function reportsDir(cwd = process.cwd()) {
  return path.join(projectDir(cwd), REPORT_DIRNAME)
}

export function reportFile(id, cwd = process.cwd()) {
  return path.join(reportsDir(cwd), `${String(id).replace(/[^A-Za-z0-9._-]/g, "_")}.json`)
}

const MAX_LINE = 400
const MAX_LINES = 40

function lines(input) {
  const raw = Array.isArray(input) ? input : (input == null || input === "" ? [] : [input])
  return raw
    .filter((l) => l !== null && l !== undefined && String(l).trim() !== "")
    .map((l) => redact(String(l).replace(/\s+$/g, "")).slice(0, MAX_LINE))
    .slice(0, MAX_LINES)
}

/**
 * Assemble the report.
 *
 * @param {{objective?: object, task?: object, gate?: object, review?: object, ledger?: object,
 *          advisories?: object, docs?: Array, commit?: object, perf?: Array, bugs?: Array,
 *          analysis?: Array|string, plan?: Array|string, remaining?: Array|string,
 *          next?: Array|string, klass?: string, now?: number}} input
 */
export function buildReport({
  objective = null, task = null, gate = null, review = null, ledger = null,
  advisories = null, docs = null, commit = null, perf = null, bugs = null,
  analysis = null, plan = null, remaining = null, next = null,
  klass = null, now = Date.now(),
  // v92 PROCREW: what the sub-agents actually did, and what the verification
  // pipeline actually ran. Both are optional; neither is ever invented.
  crewRun = null, pipeline = null,
} = {}) {
  const prog = objective ? progressOf(objective, { gate }) : { pct: 0, phase: null, done: 0, total: 0, label: "" }
  const s = {}

  // 1. Analysis — objective, class, crew, advisories, what was known up front
  s.analysis = lines([
    objective?.objective ? `objective: ${objective.objective}` : null,
    klass || objective?.class ? `class: ${klass || objective.class}` : null,
    objective?.taskId ? `task: ${objective.taskId}` : null,
    objective?.runId ? `run: ${objective.runId}` : null,
    ...(Array.isArray(analysis) ? analysis : analysis ? [analysis] : []),
    ...(advisories?.sections || []).slice(0, 6).map((a) => `${a.role} / ${a.title}: ${a.text.split("\n")[0]}`),
    crewRun && crewRun.units ? `crew run: ${crewRun.findings}/${crewRun.units} unit(s) produced findings • ${crewRun.modelCalls} model call(s)${crewRun.reassigned ? ` • ${crewRun.reassigned} reassigned to another specialist` : ""}${crewRun.duplicates ? ` • ${crewRun.duplicates} duplicate unit(s) refused` : ""}${crewRun.skipped ? ` • ${crewRun.skipped} previously-rejected approach(es) skipped` : ""}${crewRun.deadlineHit ? " • fan-out deadline hit" : ""}` : null,
  ])

  // 2. Review Findings — the checklist, blockers first
  s.review_findings = lines([
    review?.blockers?.length ? `BLOCKERS (${review.blockers.length}):` : null,
    ...(review?.blockers || []).map((b) => `  ✗ ${b.id || b.check || "blocker"}${b.detail ? ` — ${b.detail}` : ""}`),
    review?.findings?.length ? `findings (${review.findings.length}):` : null,
    ...(review?.findings || []).map((f) => `  · ${f.id || f.check || "finding"}${f.detail ? ` — ${f.detail}` : ""}`),
    review?.checks?.length ? review.checks.map((c) => `  ${c.ok ? "✓" : "✗"} ${c.id || c.check}${c.detail ? ` — ${c.detail}` : ""}`) : null,
  ])

  // 3. Execution Plan — phases and their state, plus any explicit plan text
  s.execution_plan = lines([
    ...(Array.isArray(plan) ? plan : plan ? [plan] : []),
    ...(objective ? phaseTable(objective).map((p) => `  ${p.phase.padEnd(9)} ${p.state}${p.entries > 1 ? ` (×${p.entries})` : ""}${p.ms != null ? ` ${p.ms}ms` : ""}`) : []),
    ...(objective?.pivots?.length ? [`strategy pivots:`, ...objective.pivots.map((p) => `  ${p.from || "?"} → ${p.to || "?"}${p.why ? ` — ${p.why}` : ""}`)] : []),
  ])

  // 4. Progress — honest percentage, checkpoints, stop reason
  s.progress = lines([
    objective ? `${prog.pct}% — ${prog.label}` : null,
    objective?.status ? `status: ${objective.status}${objective.stopReason ? ` (${objective.stopReason})` : ""}` : null,
    objective?.checkpoints?.length ? `checkpoints: ${objective.checkpoints.length} (last: ${objective.checkpoints[objective.checkpoints.length - 1].label} @ ${prog.pct}%)` : null,
    objective?.compressions ? `context compressions: ${objective.compressions}` : null,
    task?.segment_count != null ? `segments: ${task.segment_count}` : null,
    task?.repair_count != null ? `repairs: ${task.repair_count}` : null,
    // NB: written as words, not "12in/34out" — a key/value-shaped token trips
    // secret redaction (secrets.js), which stays exactly as strict as it is.
    task?.resource_usage ? `tool calls ${task.resource_usage.tool_calls ?? 0} • tokens in ${task.resource_usage.tokens_in ?? 0} out ${task.resource_usage.tokens_out ?? 0} • ${task.resource_usage.ms ?? 0} ms` : null,
  ])

  // 5. Verification Results — the gate and the ledger, verbatim
  s.verification = lines([
    gate ? `gate: ${gate.ok ? "SATISFIED" : "NOT SATISFIED"} (${gate.status || "unknown"})` : null,
    ...gateChecks(gate).map((c) => `  ${c.ok ? "✓" : "✗"} ${c.check}${c.detail ? ` — ${c.detail}` : ""}`),
    ...(gateBlockers(gate).length ? [`  blockers: ${gateBlockers(gate).map((b) => b.check).join(", ")}`] : []),
    ...(ledger?.all ? ledger.all().slice(-8).map((r) => `  ${r.passed ? "✓" : "✗"} ${String(r.command || "").slice(0, 140)}${r.exit_code != null ? ` [exit ${r.exit_code}]` : ""}`) : []),
    task?.tests_run?.length ? `tests: ${task.tests_run.map((t) => `${t.command || "?"} ${t.passed ? "pass" : "FAIL"}`).join(", ")}` : null,
    ...(pipeline?.stages?.length ? [`verification pipeline (${pipeline.ms ?? 0}ms${pipeline.repairs ? `, ${pipeline.repairs} repair(s)` : ""}):`, ...formatPipeline(pipeline).split("\n")] : []),
  ])

  // 6. Files Changed — created/modified/deleted, from the task state
  const changed = (task?.files_changed || []).map((f) => `  ~ ${f}`)
  const created = (task?.files_created || []).map((f) => `  + ${f}`)
  s.files_changed = lines([...created, ...changed, ...(task?.files_deleted || []).map((f) => `  - ${f}`)])

  // 7. Bugs Fixed — explicit records only; never inferred from "tests passed"
  s.bugs_fixed = lines([
    ...(Array.isArray(bugs) ? bugs : bugs ? [bugs] : []),
    ...(task?.segments || []).filter((g) => /repair|fix/i.test(String(g.reason || g.kind || ""))).slice(0, 6).map((g) => `  ${g.reason || g.kind}`),
  ])

  // 8. Performance — measured numbers only
  s.performance = lines([
    ...(Array.isArray(perf) ? perf : perf ? [perf] : []),
  ])

  // 9. Remaining Issues — blockers, failed checks, missing evidence
  s.remaining_issues = lines([
    ...(Array.isArray(remaining) ? remaining : remaining ? [remaining] : []),
    ...(objective?.blockers || []).map((b) => `  ${b.recoverable ? "recoverable" : "BLOCKER"} ${b.reason}${b.detail ? ` — ${b.detail}` : ""}`),
    ...(gate && !gate.ok ? gateBlockers(gate).map((b) => `  gate: ${b.check}${b.reason ? ` — ${b.reason}` : ""}`) : []),
    ...(review?.findings || []).map((f) => `  review: ${f.id || f.check}`),
    ...(docs || []).filter((d) => d.severity === "MAJOR" && !d.exists).map((d) => `  docs: no ${d.doc} file exists to record the breaking change`),
  ])

  // 10. Recommended Next Improvements — derived, not improvised
  s.next_improvements = lines([
    ...(Array.isArray(next) ? next : next ? [next] : []),
    ...(docs || []).map((d) => `  ${d.doc}: ${d.action}${d.path ? ` (${d.path})` : ""}`),
    ...(commit?.breaking ? ["  publish the migration note before tagging this release"] : []),
    ...(objective?.pivots?.length ? ["  record the successful strategy as a playbook so the next run does not rediscover it"] : []),
  ])

  const sections = REPORT_SECTIONS.map((id) => ({
    id,
    title: TITLES[id],
    lines: s[id]?.length ? s[id] : [NONE[id]],
    empty: !(s[id]?.length),
  }))

  return {
    schema: 1,
    id: objective?.id || task?.task_id || `report-${now.toString(36)}`,
    taskId: objective?.taskId || task?.task_id || null,
    runId: objective?.runId || task?.run_id || null,
    objective: objective?.objective || task?.objective || "",
    status: objective?.status || (gate?.ok ? OBJ_STATUS.DONE : OBJ_STATUS.RUNNING),
    pct: prog.pct,
    gateOk: gate?.ok === true,
    sections,
    changelog: null,
    createdAt: now,
  }
}

/** Attach a ready-to-paste CHANGELOG section (docsintel owns the format). */
export function attachChangelog(report, { version = "", title = "", added = [], changed = [], fixed = [], removed = [], breaking = [] } = {}) {
  if (!report) return report
  report.changelog = changelogSection({ version, title, added, changed, fixed, removed, breaking })
  return report
}

/** Render as markdown (default) or plain text. */
export function formatReport(report, { markdown = true, maxWidth = 100 } = {}) {
  if (!report) return "(no report)"
  const out = []
  const head = `${markdown ? "# " : ""}FINAL REPORT — ${report.objective || report.id}`
  out.push(head)
  out.push("")
  out.push(`${markdown ? "**" : ""}status${markdown ? "**" : ""}: ${report.status} • ${report.pct}% • gate ${report.gateOk ? "SATISFIED" : "NOT SATISFIED"}` +
    (report.taskId ? ` • task ${report.taskId}` : ""))
  out.push("")
  for (const sec of report.sections) {
    out.push(`${markdown ? "## " : ""}${sec.title}`)
    for (const l of sec.lines) out.push(markdown && l.startsWith("  ") ? l : l.slice(0, maxWidth * 4))
    out.push("")
  }
  if (report.changelog) {
    out.push(`${markdown ? "## " : ""}CHANGELOG entry (ready to paste)`)
    out.push("")
    out.push("```markdown")
    out.push(report.changelog.trimEnd())
    out.push("```")
    out.push("")
  }
  return out.join("\n").trimEnd() + "\n"
}

export function saveReport(report, { cwd = process.cwd() } = {}) {
  if (!report?.id) return { ok: false, error: "no report" }
  const file = reportFile(report.id, cwd)
  try {
    const w = writeStateFile(file, JSON.stringify(report, null, 2))
    return { ok: true, file, bytes: w.bytes }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), file }
  }
}

export function loadReport(id, cwd = process.cwd()) {
  try {
    const raw = JSON.parse(fs.readFileSync(reportFile(id, cwd), "utf8"))
    return raw && typeof raw === "object" ? raw : null
  } catch { return null }
}

export function listReports(cwd = process.cwd(), limit = 20) {
  let names = []
  try { names = fs.readdirSync(reportsDir(cwd)).filter((f) => f.endsWith(".json")) } catch { return [] }
  const rows = []
  for (const n of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(reportsDir(cwd), n), "utf8"))
      rows.push({ id: r.id, objective: r.objective, status: r.status, pct: r.pct, gateOk: r.gateOk, createdAt: r.createdAt, taskId: r.taskId })
    } catch { /* unreadable: skip */ }
  }
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return rows.slice(0, Math.max(1, limit))
}

export function latestReport(cwd = process.cwd(), taskId = null) {
  const rows = listReports(cwd, 50)
  if (taskId) {
    const hit = rows.find((r) => r.taskId === taskId)
    if (hit) return loadReport(hit.id, cwd)
  }
  return rows.length ? loadReport(rows[0].id, cwd) : null
}
