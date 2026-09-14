/**
 * codereview.js — v99 "loopwise" reviewer pass.
 *
 * The v98 review surfaces were METADATA checklists (review.js adversarial
 * checklist at the completion gate; critique.js pre-mutation guards) — none
 * of them ever looked at the CODE the run produced. This module adds the
 * missing pass: after a segment mutates files, gather the deterministic
 * facts (working diff vs HEAD, LSP diagnostics, ledger failures, secret and
 * smell scan of ADDED lines) and run ONE read-only reviewer agent over the
 * actual change. The reviewer may not modify anything (verifier semantics);
 * it reports findings as strict JSON. Deterministic findings stand on their
 * own — if the LLM pass is unavailable or returns garbage, the review still
 * happens, just quieter. Nothing here invents evidence: every finding
 * carries the file (and line, when known) it was observed on.
 *
 * House rules honored: zero dependencies, no duplicate subsystem (reuses
 * textdiff/secrets/langengine facts, the verifier agent shape, the
 * required-action mechanism), honest degradation, bounded cost (per-task
 * review budget enforced by the caller, per-file diff caps here).
 */
import path from "node:path"
import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { unifiedDiff } from "./textdiff.js"
import { redactSecrets } from "./secrets.js"
import { detectLanguage } from "./lang.js"

/** Bounded everywhere: a review that costs more than the work is a regression. */
const MAX_FILES = 16
const MAX_DIFF_CHARS_PER_FILE = 6000
const MAX_TOTAL_DIFF_CHARS = 24000
const MAX_FINDINGS = 12
const MAX_PROMPT_FINDINGS = 20

/**
 * Deterministic fact gathering for the changed files. Read-only.
 * @param {object} o
 * @param {string} o.cwd
 * @param {string[]} o.files relative (to cwd) changed files
 * @param {Array<object>} o.diagnostics LSP diagnostics already collected at the gate (shape: {file, passed, text}) — reused, never re-spawned
 * @param {Array<object>} o.ledgerFailures failing verification records ({command, exit_code, evidence})
 * @returns {object} facts
 */
export function gatherReviewFacts({ cwd = process.cwd(), files = [], diagnostics = [], ledgerFailures = [] } = {}) {
  // files may arrive absolute (meta passes absolute segChanged paths) or
  // relative — resolve against cwd FIRST, then make repo-relative
  const rel = [...new Set(files.map((f) => path.relative(cwd, path.isAbsolute(String(f)) ? String(f) : path.resolve(cwd, String(f)))).filter((p) => p && !p.startsWith("..")))].slice(0, MAX_FILES)
  const facts = {
    cwd,
    files: [],
    totalAdded: 0,
    totalRemoved: 0,
    diagnostics: diagnostics.slice(0, 40),
    ledgerFailures: ledgerFailures.slice(0, 8),
    diffAvailable: false,
    preExistingDirty: 0,
  }
  // git working diff vs HEAD is the change-set under review. If this is not
  // a git repo (or git is unavailable) the review degrades honestly: file
  // facts only, no diff.
  let dirty = null
  try {
    dirty = execFileSync("git", ["status", "--porcelain"], { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString()
  } catch { dirty = null }
  const tracked = rel.filter((f) => dirty === null ? false : dirty.split("\n").some((l) => l.endsWith(f)))
  facts.diffAvailable = tracked.length > 0
  if (dirty !== null) {
    // pre-existing dirt (files dirty that this run never touched) lowers
    // diff attribution confidence — recorded, not guessed away
    const touched = new Set(rel)
    facts.preExistingDirty = dirty.split("\n").filter((l) => l.trim() && !touched.has(l.slice(3).trim())).length
  }
  let budget = MAX_TOTAL_DIFF_CHARS
  for (const f of rel) {
    const langInfo = detectLanguage(f)
    const langId = typeof langInfo === "string" ? langInfo : (langInfo?.id ?? "unknown")
    const entry = { file: f, lang: langId, added: 0, removed: 0, diff: null, diagCount: 0 }
    for (const d of facts.diagnostics) {
      try { if (path.relative(cwd, d.file ?? "x") === f && d.passed === false) entry.diagCount++ } catch { /* skip malformed */ }
    }
    if (tracked.includes(f) && budget > 0) {
      try {
        const before = execFileSync("git", ["show", `HEAD:${f}`], { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 3000, maxBuffer: 2 * 1024 * 1024 }).toString()
        // the AFTER side is the working tree — the current truth on disk
        // (never the index: unstaged writes would diff as empty)
        let after = ""
        try { after = readFileSync(path.join(cwd, f), { encoding: "utf8", flag: "r" }) } catch { after = "" }
        if (after.length > 512 * 1024) after = after.slice(0, 512 * 1024)
        let diff = unifiedDiff(before, after, { path: f, context: 2 })
        if (diff.length > MAX_DIFF_CHARS_PER_FILE) diff = diff.slice(0, MAX_DIFF_CHARS_PER_FILE) + "\n… (diff truncated)"
        if (diff && diff.length <= budget) {
          entry.diff = diff
          budget -= diff.length
          for (const line of diff.split("\n")) {
            if (line.startsWith("+") && !line.startsWith("+++")) entry.added++
            else if (line.startsWith("-") && !line.startsWith("---")) entry.removed++
          }
          facts.totalAdded += entry.added
          facts.totalRemoved += entry.removed
        }
      } catch { /* per-file diff is best-effort; the entry still reviews */ }
    }
    facts.files.push(entry)
  }
  return facts
}

/**
 * Deterministic findings from facts alone — no LLM, no guesses. Each finding
 * is something OBSERVED in the diff or the diagnostics, with its file.
 */
export function deterministicFindings(facts) {
  const out = []
  const push = (severity, id, file, detail) => out.length < MAX_FINDINGS && out.push({ severity, id, file, detail: String(detail).slice(0, 240) })
  for (const f of facts.files ?? []) {
    if (f.diagCount > 0) push("blocker", "syntax_diagnostics", f.file, `${f.diagCount} error-severity LSP diagnostic(s) on this changed file`)
    if (!f.diff) continue
    const added = f.diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1))
    const joined = added.join("\n")
    if (!joined) continue
    const secrets = redactSecrets(joined)
    if (secrets.found > 0) push("blocker", "secret_in_code", f.file, `${secrets.found} secret-shaped string(s) added — never commit credentials`)
    if (/\bdebugger\b/.test(joined)) push("major", "debugger_left", f.file, "a `debugger` statement was added")
    const todos = joined.match(/\b(TODO|FIXME|XXX|HACK)\b/g) ?? []
    if (todos.length > 3) push("minor", "todo_spam", f.file, `${todos.length} TODO/FIXME markers added in one change`)
    if (/^(js|ts|javascript|typescript)$/.test(String(f.lang).toLowerCase()) && /^\s*console\.(log|debug)\(/m.test(joined) && facts.totalAdded > 20) {
      push("minor", "console_log", f.file, "console.log/debug left in a non-trivial change")
    }
    if (f.added > 600) push("major", "mega_edit", f.file, `${f.added} added lines in ONE file — split or justify the blast radius`)
  }
  for (const lf of facts.ledgerFailures ?? []) {
    if (out.length >= MAX_FINDINGS) break
    push("major", "failing_verification", "(verification)", `${String(lf.command ?? "command").slice(0, 120)} failed (exit ${lf.exit_code ?? "?"})${lf.evidence ? `: ${String(lf.evidence).slice(0, 100)}` : ""}`)
  }
  return out
}

/** The reviewer agent's ask. Strict JSON contract, read-only semantics. */
export function reviewerPrompt({ objective, facts, findings }) {
  const fileList = facts.files.map((f) => `- ${f.file} (${f.lang}, +${f.added}/-${f.removed}${f.diagCount ? `, ${f.diagCount} LSP error(s)` : ""})`).join("\n")
  const diffBlocks = facts.files.filter((f) => f.diff).map((f) => `--- ${f.file} ---\n${f.diff}`).join("\n\n") || "(no working diff available — review the file facts and diagnostics only)"
  const detList = findings.length ? findings.map((f) => `- [${f.severity}] ${f.id} on ${f.file}: ${f.detail}`).join("\n") : "(none)"
  return `You are the CODE REVIEWER for this task. The implementer claims the objective below is addressed; review the ACTUAL change for defects it introduced.

OBJECTIVE: ${String(objective).slice(0, 500)}

CHANGED FILES:
${fileList}

WORKING DIFF (vs HEAD):
${diffBlocks}

ALREADY-OBSERVED DETERMINISTIC FINDINGS (verify, don't parrot):
${detList}
${facts.ledgerFailures?.length ? `\nFAILING VERIFICATION EVIDENCE:\n${facts.ledgerFailures.map((l) => `- ${String(l.command ?? "").slice(0, 120)} → exit ${l.exit_code ?? "?"}`).join("\n")}` : ""}

Look ONLY for defects the change itself introduces: logic errors, inverted conditions, missing error handling, broken imports/exports, API misuse, resource leaks, race conditions, security regressions, and objective violations. Do NOT restyle, do NOT suggest refactors, do NOT invent issues to seem thorough — an empty findings list is a valid answer for a clean diff.

You may read files and search the project for context, but you may NOT modify anything.

Output STRICT JSON as your final answer (no prose around it):
{"findings":[{"severity":"blocker|major|minor","file":"relative/path","line":<number or null>,"id":"short_snake_id","issue":"one sentence","fix_hint":"one sentence"}]}`
}

/**
 * Parse the reviewer report. Honest: a malformed report returns ok:false —
 * the caller keeps the deterministic findings and moves on. Never invents.
 */
export function parseReviewerReport(text = "") {
  const s = String(text ?? "")
  const start = s.indexOf("{")
  const arrStart = s.indexOf("[")
  if (start === -1 && arrStart === -1) return { ok: false, findings: [], error: "no JSON found" }
  let raw = ""
  if (arrStart !== -1 && (start === -1 || arrStart < start)) {
    const open = s.indexOf("[", arrStart)
    const close = s.lastIndexOf("]")
    if (open === -1 || close <= open) return { ok: false, findings: [], error: "unterminated array" }
    raw = s.slice(open, close + 1)
  } else {
    const open = s.indexOf("{", start)
    const close = s.lastIndexOf("}")
    if (open === -1 || close <= open) return { ok: false, findings: [], error: "unterminated object" }
    raw = s.slice(open, close + 1)
  }
  let parsed
  try { parsed = JSON.parse(raw) } catch { return { ok: false, findings: [], error: "invalid JSON" } }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.findings) ? parsed.findings : null
  if (!list) return { ok: false, findings: [], error: "no findings array" }
  const SEV = new Set(["blocker", "major", "minor"])
  const findings = []
  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const severity = SEV.has(String(item.severity).toLowerCase()) ? String(item.severity).toLowerCase() : "major"
    const file = String(item.file ?? "").slice(0, 200) || "(unspecified)"
    const issue = String(item.issue ?? item.detail ?? "").slice(0, 300)
    if (!issue) continue
    const line = Number.isFinite(Number(item.line)) && Number(item.line) > 0 ? Number(item.line) : null
    if (findings.length < MAX_FINDINGS) findings.push({ severity, id: String(item.id ?? "finding").replace(/[^a-z0-9_]/gi, "_").slice(0, 40) || "finding", file, line, issue, fix_hint: String(item.fix_hint ?? "").slice(0, 240) })
  }
  return { ok: true, findings }
}

/** Merge deterministic + LLM findings, deduped by file+issue prefix. On a
 *  duplicate the richer report wins: the reviewer's line number and fix
 *  hint are merged into the deterministic entry (which found the same
 *  problem with less precision). */
export function mergeFindings(deterministic = [], llm = []) {
  const merged = []
  const key = (f) => `${String(f.file).toLowerCase()}|${String(f.issue ?? f.detail ?? "").toLowerCase().slice(0, 44)}`
  const seen = new Map()
  for (const f of [...deterministic, ...llm]) {
    if (merged.length >= MAX_FINDINGS) break
    const k = key(f)
    if (seen.has(k)) {
      const existing = merged[seen.get(k)]
      if (existing.fix_hint == null && f.fix_hint != null) existing.fix_hint = f.fix_hint
      if (existing.line == null && f.line != null) existing.line = f.line
      continue
    }
    seen.set(k, merged.length)
    merged.push({
      severity: f.severity, id: f.id, file: f.file, line: f.line ?? null,
      issue: f.issue ?? f.detail ?? "", fix_hint: f.fix_hint ?? null,
      source: f.fix_hint !== undefined ? "reviewer" : "deterministic",
    })
  }
  return merged
}

/**
 * One review pass: facts → deterministic findings → (optional) one read-only
 * reviewer agent run → merged report. Bounded, honest, never throws.
 */
export async function runCodeReview({ agent = null, config, provider, signal = null, emit = null, objective, files, diagnostics = [], ledgerFailures = [], taskId = null, runId = null, segmentId = null, nodeId = null, extraContext = "" } = {}) {
  const facts = gatherReviewFacts({ cwd: process.cwd(), files, diagnostics, ledgerFailures })
  const det = deterministicFindings(facts)
  let llm = []
  let llmStatus = "skipped"
  if (agent && facts.files.length) {
    try {
      llmStatus = "failed"
      const r = await agent({
        config, provider, signal,
        task: reviewerPrompt({ objective, facts, findings: det.slice(0, MAX_PROMPT_FINDINGS) }),
        taskId, runId, segmentId, nodeId,
        extraContext,
        maxStepsOverride: 8, deep: false,
        onEvent: emit,
        journal: true, readOnly: true, verifier: true,
        runIdOverride: runId, suppressRunEvents: true, keepJournalRunning: true,
      })
      const parsed = parseReviewerReport(r?.text ?? "")
      if (parsed.ok) { llm = parsed.findings; llmStatus = "ok" }
    } catch { /* the deterministic review stands on its own */ }
  }
  const findings = mergeFindings(det, llm)
  const blockers = findings.filter((f) => f.severity === "blocker")
  return {
    ran: true,
    facts: { files: facts.files.length, added: facts.totalAdded, removed: facts.totalRemoved, diffAvailable: facts.diffAvailable, preExistingDirty: facts.preExistingDirty },
    findings, blockers,
    sources: { deterministic: det.length, reviewer: llmStatus },
  }
}
