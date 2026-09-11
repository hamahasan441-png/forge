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

import fs from "node:fs"
import path from "node:path"

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
  // P0: evidence that exists but was produced before the artifact changed
  STALE: "STALE",
  // P0: no evidence was produced for a required type
  MISSING: "MISSING",
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

/**
 * P1 — UNKNOWN IS NOT SUCCESS.
 *
 * An exit status we could not observe is NOT exit status 0. Before this fix a
 * command that was killed by a signal, OOM-killed, or that never reported a
 * code at all was recorded as `exitCode: 0` ⇒ `passed: true`, so a segfaulting
 * test run satisfied the verification gate.
 *
 * `UNKNOWN_EXIT_CODE` is `null`: it is falsy AND distinct from 0, so the strict
 * `exitCode === 0` success test can never be satisfied by it.
 */
export const UNKNOWN_EXIT_CODE = null

/**
 * Explicit failure shapes. Exit status is authoritative when available; these
 * patterns only classify a result whose status is unknown, and they never
 * upgrade an unknown status to success.
 */
export const FAILURE_SHAPES = [
  // most specific first: a signal is a crash, not a generic failure
  { kind: "signal", test: /signal: (SIG)?(SEGV|ABRT|BUS|FPE|ILL|KILL)|segmentation fault|segfault|core dumped|\bsigsegv\b|\bsigabrt\b/i },
  { kind: "killed", test: /\[killed[:\s]|process was killed|SIGKILL|(^|\s)Killed(\s|$)/i },
  { kind: "timeout", test: /timed out|timeout after|ETIMEDOUT|TimeoutError/i },
  { kind: "oom", test: /out of memory|JavaScript heap out of memory|Cannot allocate memory|MemoryError|OOMKilled/i },
  { kind: "panic", test: /\bpanic:|panicked at|internal error:|fatal error:|UnhandledPromiseRejection|unhandled rejection/i },
  { kind: "permission_denied", test: /permission denied|EACCES|not permitted|Operation not permitted|403 forbidden/i },
  { kind: "not_found", test: /command not found|not found:|\bnot found\b|ENOENT|No such file or directory|module not found|can'?t (find|open)/i },
  { kind: "no_tests", test: /no tests? (found|ran|executed|matched)|no test files|0 tests? (found|ran|executed)|No test suite/i },
  { kind: "build_failure", test: /BUILD FAILED|build failed|compile error|compilation failed|error TS\d+|error\[E\d+\]|SyntaxError:|tsc.*error/i },
  { kind: "test_failure", test: /tests? failed|failures:|AssertionError|FAILED\s|\bFAIL\b|✗|✘|Expected .*Received|1\)\s/i },
  { kind: "generic_failure", test: /\b(failed|failure|fatal|error|exception|traceback)\b/i },
]

/** Classify a result string when the exit status is unknown. */
export function detectFailureShape(text = "") {
  const out = String(text ?? "")
  for (const shape of FAILURE_SHAPES) {
    if (shape.test.test(out)) return shape.kind
  }
  return null
}

/**
 * Resolve an exit status from a command result. Returns a number, or
 * `UNKNOWN_EXIT_CODE` (null) when the status genuinely cannot be observed.
 */
export function resolveExitCode(opts = {}, text = "") {
  const out = String(text ?? "")
  if (Number.isInteger(opts.exitCode)) return opts.exitCode
  if (Number.isInteger(opts.exit_code)) return opts.exit_code
  const fromText = /\[exit code: (-?\d+)\]/.exec(out)
  if (fromText) return Number(fromText[1])
  if (/timed out|ETIMEDOUT|TimeoutError/i.test(out)) return 124
  // a crash is observable: 128 + signal. "segmentation fault" is SIGSEGV even
  // when the harness never prints a numeric status.
  const signal = /\[signal: ([A-Z]+)\]|signal: (SIG)?(SEGV|ABRT|BUS|FPE|ILL)|segmentation fault|segfault|core dumped/i.exec(out)
  if (signal) return 128 + 11 // 128 + SIGSEGV — a signal is never success
  if (/\[killed[:\s]|\bKilled\b/i.test(out)) return 137 // 128 + SIGKILL
  return UNKNOWN_EXIT_CODE
}

export function evaluateVerification(command, result, opts = {}) {
  const out = String(result ?? "")
  const resolved = resolveExitCode(opts, out)
  const exitCode = resolved
  const timedOut = exitCode === 124 || /timed out after|TimeoutError/i.test(out)
  const type = opts.type || classifyCommand(command)

  const observed = exitCode !== UNKNOWN_EXIT_CODE
  const shape = detectFailureShape(out)
  // Success requires RELIABLE evidence: an OBSERVED exit status of 0, no
  // timeout and no failure shape in the output. Unknown status ⇒ not passed.
  const passed = observed && exitCode === 0 && !timedOut && !shape

  const evidence = extractEvidence(out, type)

  // P1 scoping: every record contains required fields
  return withAliases({
    verification_id: opts.verification_id || opts.verificationId || `ver-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    verificationId: null, // convenience alias, filled in just below
    taskId: opts.taskId ?? null,
    runId: opts.runId ?? opts.run_id ?? null,
    nodeId: opts.nodeId ?? null,
    segmentId: opts.segmentId ?? null,
    verificationEpoch: opts.verificationEpoch ?? opts.verification_epoch ?? 0,
    affectedFiles: (opts.affectedFiles ?? opts.affected_files ?? []).map(String),
    affected_files: (opts.affectedFiles ?? opts.affected_files ?? []).map(String), // backward compat
    // `scope` is the EVIDENCE BREADTH (focused / regression / syntax / …);
    // `identityScope` says WHO the evidence belongs to: a node or the task.
    scope: opts.scope ?? (type === VTYPE.FOCUSED_TEST ? "focused" : type === VTYPE.REGRESSION_TEST ? "regression" : type),
    identityScope: opts.identityScope ?? (opts.nodeId ? "node" : "task"),
    type,
    passed,
    exitCode,
    exit_code: exitCode, // backward compat
    exitCodeKnown: observed, // P1: false ⇒ the status was never observed
    failureShape: shape, // timeout | signal | oom | killed | panic | …
    output: out.slice(0, 2000),
    evidence,
    timestamp: opts.timestamp ?? Date.now(),
    confidence: confidenceFor(type, passed, out, observed),
    timed_out: timedOut,
    command: String(command).slice(0, 300),
    duration: opts.duration ?? null,
    // v21.1 P1 — provenance: where/when the check ran and what it covered.
    // `stale` is set at record time when the producing run ALREADY wrote files
    // after the check: such evidence never verified those files.
    cwd: opts.cwd ?? null,
    env: opts.env ?? null,
    repoState: opts.repoState ?? null,
    stdoutTail: opts.stdoutTail != null ? String(opts.stdoutTail).slice(-2000) : null,
    filesWrittenAfter: (opts.filesWrittenAfter ?? []).map(String).slice(0, 50),
  })
}

/** Normalise a finished record (aliases) before it is stored. */
function withAliases(rec) {
  rec.verificationId = rec.verification_id
  return rec
}

function confidenceFor(type, passed, out, observed = true) {
  if (!observed) return "none" // unknown status carries no confidence at all
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
    // Evidence produced BEFORE later writes in the same run is stale for the
    // files those writes touched. A passing record whose scope intersects the
    // later writes (or a shell write with unknown target) is invalidated at
    // once — it was true of an artifact that no longer exists. Failures are
    // kept: a failure is a fact until a later PASS supersedes it.
    if (rec.passed && rec.filesWrittenAfter?.length) {
      const later = new Set(rec.filesWrittenAfter.map(norm2))
      const unknownTarget = rec.filesWrittenAfter.some((f) => /^\(shell write\)$/.test(f))
      const scope = (rec.affectedFiles ?? []).map(norm2)
      const hit = unknownTarget || !scope.length || scope.some((f) => later.has(f) || [...later].some((l) => l.endsWith("/" + f) || f.endsWith("/" + l)))
      if (hit) { rec.invalidated = true; rec.invalidatedAt = Date.now(); rec.invalidatedBy = "writes-after-check"; rec.staleReason = "files were written after this check ran" }
    }
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

  /**
   * Files changed AFTER existing evidence: bump the epoch and invalidate the
   * PASSING records whose scope covers them (or that have no scope at all —
   * project-wide evidence is stale once anything changes). Returns the count.
   */
  const touch = (files = []) => {
    const set = new Set(files.map(String).map(norm2))
    if (!set.size) return 0
    epoch++
    let n = 0
    for (const r of records) {
      if (r.invalidated || !r.passed) continue
      const affected = (r.affectedFiles ?? r.affected_files ?? []).map(norm2)
      const covers = !affected.length || affected.some((f) => set.has(f) || [...set].some((c) => c.endsWith("/" + f) || f.endsWith("/" + c)))
      if (covers) { r.invalidated = true; r.invalidatedAt = Date.now(); r.invalidatedBy = "touch"; r.staleReason = "covered file changed after this check"; n++ }
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
  const status = (risk = "medium", changedFiles = [], { nodeId = null, verificationEpoch = null } = {}) => {
    const required = RISK_PROFILE[risk] ?? RISK_PROFILE.medium
    const changed = changedFiles.map(norm2)
    const byType = new Map()
    const scopedFailures = []
    const stale = []

    for (const r of validRecords()) {
      // --- P0 ATTRIBUTION -------------------------------------------------
      // Evidence produced by ANOTHER node is not evidence for this one: the
      // fact that node A's tests passed says nothing about node B's change.
      // (A record with no nodeId is task-level evidence and applies to all.)
      const otherNode = Boolean(nodeId && r.nodeId && r.nodeId !== nodeId)
      // --- P0 EPOCH -------------------------------------------------------
      // Evidence from an earlier verification epoch is STALE: the artifact has
      // been touched since it was produced.
      const isStale = verificationEpoch != null && Number(r.verificationEpoch ?? 0) < Number(verificationEpoch)
      if (isStale) stale.push(r)

      if (!r.passed) {
        const rFiles = (r.affectedFiles ?? r.affected_files ?? []).map(norm2)
        const covers = !rFiles.length || !changed.length || rFiles.some((f) => changed.includes(f) || changed.some((c) => c.endsWith("/" + f) || f.endsWith("/" + c) || c === f))
        if (covers && (!otherNode || !r.nodeId)) scopedFailures.push(r)
        else if (covers && otherNode && r.scope === "regression") scopedFailures.push(r)
        continue
      }
      if (otherNode || isStale) continue
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
    else if (stale.length > 0 && missing.length > 0) verificationStatus = VERIFICATION_STATUS.STALE
    else if (missing.length > 0) verificationStatus = VERIFICATION_STATUS.PENDING
    else verificationStatus = VERIFICATION_STATUS.UNKNOWN

    return {
      ok,
      missing,
      satisfied,
      anyFailure,
      failures: scopedFailures,
      stale,
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

  return { add, recordCommand, invalidate, touch, status, records: validRecords, all: () => records.slice(), serialize, load, get epoch() { return epoch } }
}

// ---------------------------------------------------------------------------
// P0 — FINAL RISK RECALCULATION
// ---------------------------------------------------------------------------
//
// Planning risk (`riskForChange`, above) is computed from the OBJECTIVE before
// anything happened: "add a comment" is trivial. Final risk is computed from
// what the agent ACTUALLY did — the changed/created/deleted files, the symbols
// it touched and the mutating commands it ran — and it is the risk that must
// drive final verification.
//
// The bug this fixes: initialRisk = trivial ⇒ no verification required ⇒
// COMPLETED, even though the run went on to edit seven files, package.json and
// an authentication module. Final risk is therefore monotonic with the initial
// risk: it can raise it, never lower it.

export const RISK_ORDER = { trivial: 0, low: 1, medium: 2, high: 3, critical: 4 }

/** Path shapes that escalate risk no matter what the objective said. */
export const SENSITIVE_PATH_RULES = [
  { test: /(^|\/)(auth|authentication|authorization|session|login|permission|rbac|oauth|jwt|credential|token)[^/]*\.(js|mjs|cjs|ts|tsx|py|go|rs|java|rb)$/i, risk: "critical", signal: "authentication/authorization module" },
  { test: /(^|\/)(crypto|crypt|password|secret|signing|keys?|certificate|tls|ssl)[^/]*\.(js|mjs|ts|py|go|rs|rb)$/i, risk: "critical", signal: "cryptography/secret material" },
  { test: /(^|\/)\.env(\.|$)|(^|\/)(\.aws|\.ssh|\.gnupg)\/|(^|\/)(id_rsa|id_ed25519|\.npmrc|\.netrc|\.pypirc|\.htpasswd)$/i, risk: "critical", signal: "credential file" },
  { test: /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json|requirements.*\.txt|pyproject\.toml|Pipfile(\.lock)?|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|pom\.xml|build\.gradle|composer\.(json|lock))$/i, risk: "high", signal: "dependency manifest" },
  { test: /(^|\/)(migrations?|schema|prisma|knexfile|seed(er)?s?)\//i, risk: "high", signal: "database migration/schema" },
  { test: /\.(sql|prisma)$/i, risk: "high", signal: "database schema" },
  { test: /(^|\/)\.github\/workflows\/|(^|\/)(Dockerfile|docker-compose[^/]*|nginx\.conf|\.gitlab-ci\.yml|Jenkinsfile|Makefile)$/i, risk: "high", signal: "build/CI/deployment configuration" },
  { test: /(^|\/)(tsconfig[^/]*|vite\.config\.[jt]s|webpack\.config\.[jt]s|rollup\.config\.[jt]s|next\.config\.[jt]s|jest\.config\.[jt]s|vitest\.config\.[jt]s|\.eslintrc[^/]*|\.babelrc)$/i, risk: "high", signal: "toolchain configuration" },
  { test: /(^|\/)(install\.sh|setup\.[sh|py]|deploy[^/]*\.(sh|py|js)|terraform[^/]*\.tf|.*\.tf)$/i, risk: "high", signal: "install/deploy script" },
  { test: /(^|\/)(security|sandbox|shellguard|netguard|safepath|permissions?|policy)[^/]*\.(js|mjs|ts|py|go|rs)$/i, risk: "high", signal: "security-sensitive module" },
]

/** Mutating commands whose execution escalates risk (tool/command mutations). */
const MUTATING_COMMAND_RULES = [
  { test: /\b(npm|pnpm|yarn|bun|pip|poetry|cargo|gem|apt-get|brew)\s+(install|add|remove|uninstall|update|upgrade)\b/i, risk: "high", signal: "package manager mutation" },
  { test: /\bgit\s+(push|commit|reset|checkout|merge|rebase|stash|cherry-pick|revert)\b/i, risk: "medium", signal: "git history mutation" },
  { test: /\b(docker|kubectl|helm|terraform|ansible)\b/i, risk: "high", signal: "infrastructure mutation" },
  { test: /\b(migrate|migration|db:push|prisma\s+migrate|alembic)\b/i, risk: "high", signal: "database mutation" },
  { test: /\brm\s+-r|\brm\s+-f|\bmv\s+|\bdd\s+|\bchmod\s+|\bchown\s+/i, risk: "medium", signal: "destructive filesystem command" },
  { test: /\b(curl|wget|nc|ssh|scp|rsync)\b/i, risk: "medium", signal: "network/remote command" },
]

const SYMBOL_RULES = [
  { test: /^(authenticate|authorize|verifyToken|signJwt|hashPassword|checkPermission|validateSession|encrypt|decrypt)$/i, risk: "critical", signal: "auth/crypto symbol" },
  { test: /^(exec|execSync|spawn|eval|runCommand|shellExecute)$/i, risk: "high", signal: "execution-boundary symbol" },
]

function maxRisk(a, b) {
  return (RISK_ORDER[b] ?? 0) > (RISK_ORDER[a] ?? 0) ? b : a
}

/**
 * Best-effort extraction of the symbols a set of files defines, bounded in
 * files and bytes so a huge file can never stall the risk pass.
 * Used to answer "did this change touch authenticate()/authorize()/exec()?".
 */
export function detectAffectedSymbols(files = [], cwd = process.cwd(), { maxFiles = 12, maxBytes = 200_000 } = {}) {
  const out = new Set()
  let n = 0
  for (const f of files ?? []) {
    if (n++ >= maxFiles) break
    try {
      const p = path.resolve(cwd, String(f))
      const fd = fs.openSync(p, "r")
      try {
        const buf = Buffer.alloc(Math.min(maxBytes, 64 * 1024))
        const read = fs.readSync(fd, buf, 0, buf.length, 0)
        const src = buf.subarray(0, read).toString("utf8")
        const re = /(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)|(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g
        let m
        while ((m = re.exec(src))) {
          const name = m[1] || m[2]
          if (name) out.add(name)
          if (out.size >= 400) break
        }
      } finally { fs.closeSync(fd) }
    } catch { /* unreadable / binary — skip */ }
  }
  return [...out].slice(0, 400)
}

function basenameOf(p) {
  const s = String(p ?? "").replace(/\\/g, "/")
  return s.split("/").pop() ?? s
}

/**
 * Recalculate risk from what actually changed.
 *
 * @param {object} input
 * @param {string[]} [input.changedFiles]   modified files (paths or relative)
 * @param {string[]} [input.createdFiles]
 * @param {string[]} [input.deletedFiles]
 * @param {string[]} [input.affectedSymbols]
 * @param {string[]} [input.commands]       mutating commands that were run
 * @param {string}   [input.task]           original objective
 * @param {string}   [input.initialRisk]    planning-time risk (never lowered)
 * @param {boolean}  [input.securitySensitive]
 * @returns {{ risk: string, initialRisk: string, escalated: boolean, signals: string[], reasons: string[] }}
 */
export function finalRiskForChange(input = {}) {
  const changed = normList(input.changedFiles)
  const created = normList(input.createdFiles)
  const deleted = normList(input.deletedFiles)
  const symbols = normList(input.affectedSymbols)
  const commands = normList(input.commands)
  const initialRisk = RISK_ORDER[input.initialRisk] != null ? input.initialRisk : riskForChange({
    filesChanged: changed.length,
    filesCreated: created.length,
    task: input.task ?? "",
    securitySensitive: input.securitySensitive === true,
  })

  let risk = initialRisk
  const signals = []
  const reasons = []
  const escalate = (next, signal, where) => {
    if ((RISK_ORDER[next] ?? 0) > (RISK_ORDER[risk] ?? 0)) {
      risk = next
      reasons.push(`${where} → ${signal} raises risk to ${next}`)
    }
    if (signal && !signals.includes(signal)) signals.push(signal)
  }

  for (const f of [...changed, ...created, ...deleted]) {
    for (const rule of SENSITIVE_PATH_RULES) {
      if (rule.test.test(f)) escalate(rule.risk, rule.signal, basenameOf(f))
    }
  }
  for (const s of symbols) {
    for (const rule of SYMBOL_RULES) {
      if (rule.test.test(s)) escalate(rule.risk, rule.signal, `symbol ${s}`)
    }
  }
  for (const c of commands) {
    for (const rule of MUTATING_COMMAND_RULES) {
      if (rule.test.test(c)) escalate(rule.risk, rule.signal, `command "${String(c).slice(0, 60)}"`)
    }
  }

  // breadth of the change
  const touched = changed.length + created.length + deleted.length
  if (touched >= 8) escalate("high", `${touched} files touched`, "change breadth")
  else if (touched >= 4) escalate("medium", `${touched} files touched`, "change breadth")
  if (deleted.length) escalate("medium", `${deleted.length} file(s) deleted`, "deletion")

  return {
    risk,
    initialRisk,
    escalated: (RISK_ORDER[risk] ?? 0) > (RISK_ORDER[initialRisk] ?? 0),
    signals,
    reasons,
    counts: { changed: changed.length, created: created.length, deleted: deleted.length, symbols: symbols.length, commands: commands.length },
  }
}

function normList(v) {
  if (!v) return []
  if (Array.isArray(v)) return v.filter(Boolean).map((x) => String(x))
  if (v instanceof Set) return [...v].filter(Boolean).map((x) => String(x))
  if (typeof v === "string") return [v]
  return []
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
