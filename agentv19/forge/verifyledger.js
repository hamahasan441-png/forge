/**
 * forge — structured verification ledger (v21 hardened, zero dependencies)
 *
 * verify.js already proves a MUTATION landed (file exists, parses, the
 * replacement text is present) with local, side-effect-free checks. This
 * module is the task-level counterpart: it collects EVIDENCE that the OBJECTIVE
 * holds, not that a command merely ran.
 *
 * Hardening (v23):
 *  - every verification record contains taskId, nodeId, segmentId,
 *    verificationEpoch, affectedFiles, scope, type, passed, exitCode,
 *    output/evidence, timestamp
 *  - failures evaluated against correct scope: unrelated Node A failure
 *    must not block Node B; whole-project/regression may have broader scope
 *  - deterministic invalidation after mutations
 *  - verification is a hard gate: missing/failed/unavailable blocks COMPLETED
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
  trivial: [VTYPE.SYNTAX],
  low: [VTYPE.SYNTAX],
  medium: [VTYPE.SYNTAX, VTYPE.FOCUSED_TEST],
  high: [VTYPE.SYNTAX, VTYPE.FOCUSED_TEST, VTYPE.REGRESSION_TEST, VTYPE.BUILD],
  critical: [VTYPE.SYNTAX, VTYPE.FOCUSED_TEST, VTYPE.REGRESSION_TEST, VTYPE.BUILD, VTYPE.SECURITY],
}

export const VERIFICATION_STATUS = {
  NOT_REQUIRED: "NOT_REQUIRED",
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  PASSED: "PASSED",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
  UNKNOWN: "UNKNOWN",
  NOT_AVAILABLE: "NOT_AVAILABLE",
}

const TEST_CMD = /(^|[\s/])(test|jest|vitest|mocha|pytest|cargo[ _]test|go[ _]test|rspec|unittest)([\s]|$)/i
const BUILD_CMD = /\b(build|tsc|webpack|vite build|cargo build|make|compile|babel)\b/i
const SECURITY_CMD = /\b(audit|npm audit|snyk|trivy|semgrep|bandit|gosec|lint)\b/i

export function classifyCommand(command = "") {
  const c = String(command)
  if (SECURITY_CMD.test(c)) return VTYPE.SECURITY
  if (/\bnode\s+--check\b|\b(node|tsc|python3?|ruby)\s+-c\b|--syntax[ -]?check|syntax check/i.test(c)) return VTYPE.SYNTAX
  if (BUILD_CMD.test(c)) return VTYPE.BUILD
  if (TEST_CMD.test(c)) {
    const hasTarget = /[\w/.-]+(?:spec|test)\.\w+|::|(-k\s)|(-t\s)|(--grep)|(-m\s)|(run\s+[\w/.-]+)/i.test(c)
    const bare = /^\s*(npm|pnpm|yarn|bun|cargo|go)\s+(run\s+)?test\s*$/.test(c.trim())
    if (hasTarget && !bare) return VTYPE.FOCUSED_TEST
    return VTYPE.REGRESSION_TEST
  }
  return VTYPE.RUNTIME
}

export function evaluateVerification(command, result, opts = {}) {
  const out = String(result ?? "")
  const exitFromText = /\[exit code: (-?\d+)\]/.exec(out)
  const exitCode = Number.isInteger(opts.exitCode) ? opts.exitCode
    : exitFromText ? Number(exitFromText[1])
      : /timed out after/i.test(out) ? 124
        : 0
  const timedOut = exitCode === 124 || /timed out after|timeout/i.test(out)
  const type = opts.type || classifyCommand(command)

  const failureMarkers = /\b(failed|failure|error TS\d|AssertionError|✗|✘|BUILD FAILED|compile error|cannot find module|traceback)\b/i
  const passed = exitCode === 0 && !timedOut && !failureMarkers.test(out)

  const evidence = extractEvidence(out, type)

  // P1 scoping: every record contains required fields
  return {
    verification_id: opts.verification_id || opts.verificationId || `ver-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    taskId: opts.taskId ?? null,
    nodeId: opts.nodeId ?? null,
    segmentId: opts.segmentId ?? null,
    verificationEpoch: opts.verificationEpoch ?? opts.verification_epoch ?? 0,
    affectedFiles: (opts.affectedFiles ?? opts.affected_files ?? []).map(String),
    affected_files: (opts.affectedFiles ?? opts.affected_files ?? []).map(String), // backward compat
    scope: opts.scope ?? (type === VTYPE.FOCUSED_TEST ? "focused" : type === VTYPE.REGRESSION_TEST ? "regression" : type),
    type,
    passed,
    exitCode,
    exit_code: exitCode, // backward compat
    output: out.slice(0, 2000),
    evidence,
    timestamp: opts.timestamp ?? Date.now(),
    confidence: confidenceFor(type, passed, out),
    timed_out: timedOut,
    command: String(command).slice(0, 300),
    duration: opts.duration ?? null,
  }
}

function confidenceFor(type, passed, out) {
  if (!passed) return "high"
  if (/\b(\d+)\s*(tests?|passed|ok|suites?)\b/i.test(out)) return "high"
  if (type === VTYPE.BUILD || type === VTYPE.REGRESSION_TEST) return "medium"
  return "medium"
}

function extractEvidence(out, type) {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean)
  const summary = lines.find((l) => /\b(passed|failed|ok|success|compiled|built|test|suite)\b/i.test(l))
  const pick = summary || lines[lines.length - 1] || ""
  return String(pick).slice(0, 300)
}

export function createLedger() {
  const records = []
  let epoch = 0

  const add = (rec, { invalidate = false } = {}) => {
    epoch++
    rec.verificationEpoch = rec.verificationEpoch ?? epoch
    rec.verification_epoch = rec.verificationEpoch
    if (invalidate && rec.affectedFiles?.length) {
      for (const r of records) {
        if (r.affectedFiles?.some((f) => rec.affectedFiles.includes(f)) || r.affected_files?.some((f) => rec.affectedFiles.includes(f))) {
          r.invalidated = true
          r.invalidatedAt = Date.now()
          r.invalidatedBy = rec.verification_id
        }
      }
    }
    if (rec.passed) {
      for (const r of records) {
        if (r.type === rec.type && !r.passed && sameScope(r, rec)) {
          r.superseded = true
          r.supersededBy = rec.verification_id
        }
      }
    }
    records.push(rec)
    return rec
  }

  const sameScope = (a, b) => {
    const af = (a.affectedFiles ?? a.affected_files ?? []).map(norm2)
    const bf = (b.affectedFiles ?? b.affected_files ?? []).map(norm2)
    if (!af.length || !bf.length) return true
    return af.some((f) => bf.includes(f)) || bf.some((f) => af.includes(f))
  }

  const recordCommand = (command, result, opts = {}) => {
    const rec = evaluateVerification(command, result, {
      ...opts,
      verificationEpoch: opts.verificationEpoch ?? ++epoch,
    })
    return add(rec, { invalidate: false })
  }

  const invalidate = (files = []) => {
    const set = new Set(files.map(String).map(norm2))
    let n = 0
    for (const r of records) {
      if (r.invalidated) continue
      const affected = (r.affectedFiles ?? r.affected_files ?? []).map(norm2)
      if (affected.some((f) => set.has(f))) {
        r.invalidated = true
        r.invalidatedAt = Date.now()
        n++
      }
    }
    return n
  }

  const validRecords = () => records.filter((r) => !r.invalidated && !r.superseded)

  function norm2(f) { return String(f ?? "").replace(/^\.\//, "").replace(/^\/+/, "") }

  /**
   * Is the task verified for its risk level?
   * Scoped: failures in unrelated nodes do not block.
   * Whole-project/regression failures may have broader scope.
   */
  const status = (risk = "medium", changedFiles = [], { nodeId = null } = {}) => {
    const required = RISK_PROFILE[risk] ?? RISK_PROFILE.medium
    const changed = changedFiles.map(norm2)
    const byType = new Map()
    const scopedFailures = []

    for (const r of validRecords()) {
      // Scope filtering: if nodeId specified, only consider records for that node or whole-project
      if (nodeId && r.nodeId && r.nodeId !== nodeId) {
        // if record is scoped to different node and not regression/build whole-project, skip for ok check
        // but still check if it's a failure that overlaps files -> it should block if overlapping
        const isBroad = r.scope === "regression" || r.type === VTYPE.REGRESSION_TEST || r.type === VTYPE.BUILD
        if (!isBroad) {
          // failure in unrelated Node A must not block Node B
          // only count if affected files overlap
          const rFiles = (r.affectedFiles ?? r.affected_files ?? []).map(norm2)
          const overlaps = !rFiles.length || !changed.length || rFiles.some((f) => changed.includes(f))
          if (!overlaps) continue
        }
      }

      if (!r.passed) {
        const rFiles = (r.affectedFiles ?? r.affected_files ?? []).map(norm2)
        const covers = !rFiles.length || !changed.length || rFiles.some((f) => changed.includes(f) || changed.some((c) => c.endsWith("/" + f) || f.endsWith("/" + c) || c === f))
        if (covers) scopedFailures.push(r)
        continue
      }
      const covered = (r.affectedFiles ?? r.affected_files ?? []).map(norm2)
      const covers = !covered.length || !changed.length || covered.some((f) => changed.includes(f) || changed.some((c) => c.endsWith("/" + f) || f.endsWith("/" + c) || c === f))
      if (!covers) continue
      byType.set(r.type, r)
    }

    const satisfied = []
    const missing = []
    for (const t of required) (byType.has(t) ? satisfied : missing).push(t)
    const anyFailure = scopedFailures.length > 0
    const ok = missing.length === 0 && !anyFailure

    let verificationStatus
    if (required.length === 0) verificationStatus = VERIFICATION_STATUS.NOT_REQUIRED
    else if (ok) verificationStatus = VERIFICATION_STATUS.PASSED
    else if (anyFailure) verificationStatus = VERIFICATION_STATUS.FAILED
    else if (missing.length > 0) verificationStatus = VERIFICATION_STATUS.PENDING
    else verificationStatus = VERIFICATION_STATUS.UNKNOWN

    return {
      ok,
      missing,
      satisfied,
      anyFailure,
      failures: scopedFailures,
      status: verificationStatus,
      evidence: validRecords().map((r) => ({
        taskId: r.taskId,
        nodeId: r.nodeId,
        segmentId: r.segmentId,
        verificationEpoch: r.verificationEpoch,
        type: r.type,
        passed: r.passed,
        scope: r.scope,
        affectedFiles: r.affectedFiles,
        exitCode: r.exitCode,
        evidence: r.evidence,
        timestamp: r.timestamp,
        invalidated: !!r.invalidated,
      })),
      reason: ok
        ? `verified for risk=${risk} (${satisfied.join("+")})`
        : anyFailure
          ? `a verification command FAILED in scope: ${scopedFailures.map(f => f.type).join(", ")} — repair before completing`
          : `insufficient evidence for risk=${risk}: missing ${missing.join(", ")}`,
    }
  }

  const serialize = () => records.slice(-100)
  const load = (arr) => { if (Array.isArray(arr)) { records.push(...arr.slice(-100)); epoch = Math.max(epoch, ...arr.map(r => r.verificationEpoch ?? r.verification_epoch ?? 0)) } }

  return { add, recordCommand, invalidate, status, records: validRecords, all: () => records.slice(), serialize, load, get epoch() { return epoch } }
}

export function riskForChange({ filesChanged = 0, filesCreated = 0, task = "", securitySensitive = false } = {}) {
  const t = String(task ?? "").toLowerCase()
  if (securitySensitive || /security|vulnerab|injection|exploit|sanitiz|auth|secret|token|password|crypto|permission|sandbox|escape/i.test(t)) return "critical"
  if (filesChanged + filesCreated === 0) {
    if (/\b(docs?|documentation|readme|comment|typo|rename|explain|summar|read me)\b/.test(t) || /fix/.test(t) === false && /implement|add |create|build|change|refactor/i.test(t) === false) return "trivial"
    return /fix|implement|add |create|build|change|refactor|migrat/i.test(t) ? "medium" : "trivial"
  }
  if (/\b(docs?|documentation|readme|comment|typo)\b/.test(t) && filesChanged + filesCreated <= 2) return "low"
  if (/core|architect|refactor across|multi-file|migrat|provider|router|shellguard|safety/i.test(t) || filesChanged >= 8) return "high"
  if (filesChanged + filesCreated >= 2 || /fix|bug|implement|feature|add |change/i.test(t)) return "medium"
  return "low"
}
