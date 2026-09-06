/**
 * forge — structured verification ledger (v21, zero dependencies)
 *
 * verify.js already proves a MUTATION landed (file exists, parses, the
 * replacement text is present) with local, side-effect-free checks. This
 * module is the task-level counterpart: it collects EVIDENCE that the OBJECTIVE
 * holds, not that a command merely ran.
 *
 * Rules this enforces:
 *  - A result is verified only by ACTUAL EXECUTION RESULTS (exit code + output),
 *    never by a command NAME. `npm test` that exits 1 is a failure even though
 *    the string contains "test".
 *  - Verification is risk-proportional: a docs line needs syntax; a core change
 *    needs focused + regression + build.
 *  - A later MUTATION to a file INVALIDATES evidence that covered that file —
 *    once invalidated the task cannot be called "verified" until it re-proves.
 *
 * The ledger never runs commands itself: the agent runs them through the bash
 * tool (the same ShellGuard + security gate), and reports the observed result
 * here. This module judges that result honestly and persists it with the task.
 */

export const VTYPE = {
  SYNTAX: "syntax",
  FOCUSED_TEST: "focused_test",
  REGRESSION_TEST: "regression_test",
  BUILD: "build",
  RUNTIME: "runtime",
  INTEGRATION: "integration",
  SECURITY: "security",
  ACCEPTANCE: "acceptance",
}

export const RISK_PROFILE = {
  // risk level → the verification types that constitute adequate evidence
  trivial: [VTYPE.SYNTAX],
  low: [VTYPE.SYNTAX],
  medium: [VTYPE.SYNTAX, VTYPE.FOCUSED_TEST],
  high: [VTYPE.SYNTAX, VTYPE.FOCUSED_TEST, VTYPE.REGRESSION_TEST, VTYPE.BUILD],
  critical: [VTYPE.SYNTAX, VTYPE.FOCUSED_TEST, VTYPE.REGRESSION_TEST, VTYPE.BUILD, VTYPE.SECURITY],
}

const TEST_CMD = /(^|[\s/])(test|jest|vitest|mocha|pytest|cargo[ _]test|go[ _]test|rspec|unittest)([\s]|$)/i
const BUILD_CMD = /\b(build|tsc|webpack|vite build|cargo build|make|compile|babel)\b/i
const SECURITY_CMD = /\b(audit|npm audit|snyk|trivy|semgrep|bandit|gosec|lint)\b/i

/** Classify a command into a verification TYPE from what it IS, not its exit code. */
export function classifyCommand(command = "") {
  const c = String(command)
  if (SECURITY_CMD.test(c)) return VTYPE.SECURITY
  // an explicit syntax check is syntax evidence, not a generic build
  if (/\bnode\s+--check\b|\b(node|tsc|python3?|ruby)\s+-c\b|--syntax[ -]?check|syntax check/i.test(c)) return VTYPE.SYNTAX
  if (BUILD_CMD.test(c)) return VTYPE.BUILD
  if (TEST_CMD.test(c)) {
    // a TARGETED test run (a spec/path/filter on the command line) is the
    // "focused" evidence a small change needs; a bare suite run is regression.
    // During an interactive fix the typical `npm test` after a single-function
    // change doubles as the focused signal, so a passing targeted-looking OR
    // short test command satisfies the focused requirement too — judged by the
    // controller against how many files changed.
    const hasTarget = /[\w/.-]+(?:spec|test)\.\w+|::|(-k\s)|(-t\s)|(--grep)|(-m\s)|(run\s+[\w/.-]+)/i.test(c)
    const bare = /^\s*(npm|pnpm|yarn|bun|cargo|go)\s+(run\s+)?test\s*$/.test(c.trim())
    if (hasTarget && !bare) return VTYPE.FOCUSED_TEST
    return VTYPE.REGRESSION_TEST
  }
  return VTYPE.RUNTIME
}

/**
 * Judge a command's observed outcome HONESTLY.
 * @param command      the command that ran
 * @param result       its observed output string (must contain real output)
 * @param opts         { exitCode? (else parsed from output), duration, scope,
 *                       affectedFiles, type? }
 * Returns a structured verification record (not yet stored).
 */
export function evaluateVerification(command, result, opts = {}) {
  const out = String(result ?? "")
  const exitFromText = /\[exit code: (-?\d+)\]/.exec(out)
  const exitCode = Number.isInteger(opts.exitCode) ? opts.exitCode
    : exitFromText ? Number(exitFromText[1])
      : /timed out after/i.test(out) ? 124
        : 0
  const timedOut = exitCode === 124 || /timed out after|timeout/i.test(out)
  const type = opts.type || classifyCommand(command)

  // PASS means: exited 0, did not time out, and no failure markers in output.
  const failureMarkers = /\b(failed|failure|error TS\d|AssertionError|✗|✘|BUILD FAILED|compile error|cannot find module|traceback)\b/i
  const passed = exitCode === 0 && !timedOut && !failureMarkers.test(out)

  // evidence: a short, REAL excerpt — the summary line if there is one.
  const evidence = extractEvidence(out, type)

  return {
    verification_id: opts.verification_id || `ver-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type,
    command: String(command).slice(0, 300),
    exit_code: exitCode,
    passed,
    duration: opts.duration ?? null,
    scope: opts.scope ?? (type === VTYPE.FOCUSED_TEST ? "focused" : type === VTYPE.REGRESSION_TEST ? "regression" : type),
    affected_files: (opts.affectedFiles ?? []).map(String),
    timestamp: Date.now(),
    confidence: confidenceFor(type, passed, out),
    evidence,
    timed_out: timedOut,
  }
}

function confidenceFor(type, passed, out) {
  if (!passed) return "high" // a real failure is high-confidence evidence
  // a pass with a substantive test/build summary is stronger than a bare exit-0
  if (/\b(\d+)\s*(tests?|passed|ok|suites?)\b/i.test(out)) return "high"
  if (type === VTYPE.BUILD || type === VTYPE.REGRESSION_TEST) return "medium"
  return "medium"
}

function extractEvidence(out, type) {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean)
  // prefer a summary-ish line
  const summary = lines.find((l) => /\b(passed|failed|ok|success|compiled|built|test|suite)\b/i.test(l))
  const pick = summary || lines[lines.length - 1] || ""
  return String(pick).slice(0, 300)
}

/**
 * The verification ledger for one task. It tracks evidence and answers the one
 * question that matters at task end: "is the change adequately PROVEN for its
 * risk, given everything that mutated since?"
 */
export function createLedger() {
  const records = []

  const add = (rec, { invalidate = false } = {}) => {
    // Verification EVIDENCE is additive: two passing checks strengthen the
    // result. Evidence is invalidated only by an actual MUTATION (see
    // invalidate()), never by recording another verification.
    if (invalidate && rec.affected_files?.length) {
      for (const r of records) {
        if (r.affected_files?.some((f) => rec.affected_files.includes(f))) r.invalidated = true
      }
    }
    // a LATER check of the same type supersedes an earlier one for the same
    // files: after a repair re-runs the failing test and it passes, the stale
    // failure must not block the gate (a real mutation invalidates separately).
    if (rec.passed) {
      for (const r of records) {
        if (r.type === rec.type && !r.passed && sameScope(r, rec)) r.superseded = true
      }
    }
    records.push(rec)
    return rec
  }

  const sameScope = (a, b) => {
    const af = (a.affected_files ?? []).map(norm2)
    const bf = (b.affected_files ?? []).map(norm2)
    if (!af.length || !bf.length) return true // whole-scope runs cover everything
    return af.some((f) => bf.includes(f)) || bf.some((f) => af.includes(f))
  }

  /** Record from a raw command+result; returns the stored record. */
  const recordCommand = (command, result, opts = {}) => add(evaluateVerification(command, result, opts))

  /**
   * A mutation to `files` invalidates evidence that covered them (§verification
   * invalidation). Called by the controller whenever a write tool succeeds.
   */
  const invalidate = (files = []) => {
    const set = new Set(files.map(String))
    let n = 0
    for (const r of records) {
      if (r.invalidated) continue
      if (r.affected_files?.some((f) => set.has(f))) { r.invalidated = true; n++ }
    }
    return n
  }

  const validRecords = () => records.filter((r) => !r.invalidated && !r.superseded)

  /**
   * Is the task verified for its risk level?
   * @param risk        task/change risk (trivial|low|medium|high|critical)
   * @param changedFiles files changed since the last good verification
   * Returns { ok, missing:[types], satisfied:[…], evidence:[…], reason }.
   */
  const norm = norm2
  function norm2(f) { return String(f ?? "").replace(/^\.\//, "").replace(/^\/+/, "") }
  const status = (risk = "medium", changedFiles = []) => {
    const required = RISK_PROFILE[risk] ?? RISK_PROFILE.medium
    const changed = changedFiles.map(norm)
    const byType = new Map()
    for (const r of validRecords()) {
      if (!r.passed) continue
      // evidence counts when it covers the changed files OR is whole-scope (no
      // specific affected files, e.g. a full suite/build run), or when there is
      // nothing to cross-check against.
      const covered = (r.affected_files ?? []).map(norm)
      const covers = !covered.length || !changed.length || covered.some((f) => changed.includes(f) || changed.some((c) => c.endsWith("/" + f) || f.endsWith("/" + c) || c === f))
      if (!covers) continue
      byType.set(r.type, r)
    }
    const satisfied = []
    const missing = []
    for (const t of required) (byType.has(t) ? satisfied : missing).push(t)
    const anyFailure = validRecords().some((r) => !r.passed)
    const ok = missing.length === 0 && !anyFailure
    return {
      ok,
      missing,
      satisfied,
      anyFailure,
      evidence: validRecords().map((r) => ({ type: r.type, passed: r.passed, scope: r.scope, evidence: r.evidence, invalidated: !!r.invalidated })),
      reason: ok
        ? `verified for risk=${risk} (${satisfied.join("+")})`
        : anyFailure
          ? "a verification command FAILED — repair before completing"
          : `insufficient evidence for risk=${risk}: missing ${missing.join(", ")}`,
    }
  }

  const serialize = () => records.slice(-100)
  const load = (arr) => { if (Array.isArray(arr)) records.push(...arr.slice(-100)) }

  return { add, recordCommand, invalidate, status, records: validRecords, all: () => records.slice(), serialize, load }
}

/** The risk level for a set of changed files / task, used to pick verification depth. */
export function riskForChange({ filesChanged = 0, filesCreated = 0, task = "", securitySensitive = false } = {}) {
  const t = String(task ?? "").toLowerCase()
  // security-sensitive work always demands the deepest verification
  if (securitySensitive || /security|vulnerab|injection|exploit|sanitiz|auth|secret|token|password|crypto|permission|sandbox|escape/i.test(t)) return "critical"
  // no mutation at all (research, docs reading, conversation) → basic/none
  if (filesChanged + filesCreated === 0) {
    if (/\b(docs?|documentation|readme|comment|typo|rename|explain|summar|read me)\b/.test(t) || /fix/.test(t) === false && /implement|add |create|build|change|refactor/i.test(t) === false) return "trivial"
    return /fix|implement|add |create|build|change|refactor|migrat/i.test(t) ? "medium" : "trivial"
  }
  // documentation-only edits only need syntax/basic validation
  if (/\b(docs?|documentation|readme|comment|typo)\b/.test(t) && filesChanged + filesCreated <= 2) return "low"
  if (/core|architect|refactor across|multi-file|migrat|provider|router|shellguard|safety/i.test(t) || filesChanged >= 8) return "high"
  if (filesChanged + filesCreated >= 2 || /fix|bug|implement|feature|add |change/i.test(t)) return "medium"
  return "low"
}
