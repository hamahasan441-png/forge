/**
 * forge — failure classification & recovery strategy (v20.5, zero dependencies)
 *
 * §9: a tool result is not just "ok" or "not ok". A missing file, a denied
 * permission, a timeout, a failed test and a safety block need FIVE different
 * reactions — and exactly one of them ("just try again") is usually wrong.
 *
 * classifyFailure() reads the real strings forge's tools produce (and the raw
 * output of the commands they run) and returns a code plus the evidence that
 * justified it. recoveryPlan() maps the code to an ORDERED list of strategies,
 * and refuses to suggest a retry when the operation is not safely repeatable.
 *
 * Nothing here executes anything: the executor (toolintel.js) decides, using
 * this plan, what it is allowed to do.
 */

export const FAILURE = {
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  NOT_FOUND: "NOT_FOUND",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  TIMEOUT: "TIMEOUT",
  NETWORK_FAILURE: "NETWORK_FAILURE",
  DEPENDENCY_FAILURE: "DEPENDENCY_FAILURE",
  SYNTAX_FAILURE: "SYNTAX_FAILURE",
  TEST_FAILURE: "TEST_FAILURE",
  BUILD_FAILURE: "BUILD_FAILURE",
  SAFETY_BLOCK: "SAFETY_BLOCK",
  CANCELLED: "CANCELLED",
  TYPE_FAILURE: "TYPE_FAILURE",
  STATE_FAILURE: "STATE_FAILURE",
  CONCURRENCY_FAILURE: "CONCURRENCY_FAILURE",
  ENVIRONMENT_FAILURE: "ENVIRONMENT_FAILURE",
  PERFORMANCE_FAILURE: "PERFORMANCE_FAILURE",
  RESOURCE_FAILURE: "RESOURCE_FAILURE",
  TOOL_FAILURE: "TOOL_FAILURE",
  CONFIGURATION_FAILURE: "CONFIGURATION_FAILURE",
  RUNTIME_FAILURE: "RUNTIME_FAILURE",
  INTEGRATION_FAILURE: "INTEGRATION_FAILURE",
  UNKNOWN: "UNKNOWN",
}
export const FAILURE_CODES = Object.values(FAILURE)

export const STRATEGY = {
  RETRY: "retry",
  REDUCE_SCOPE: "reduce_scope",
  ALTERNATE_TOOL: "alternate_tool",
  INSPECT_FIRST: "inspect_first",
  FIX_ARGUMENTS: "fix_arguments",
  INSTALL_DEPENDENCY: "install_dependency",
  ESCALATE: "escalate",
  ABORT: "abort",
}

// Ordered: the FIRST pattern that matches wins, so specific beats generic.
const PATTERNS = [
  [FAILURE.CANCELLED, /\bcancelled\b|user interrupt|AbortError/i],
  [FAILURE.SAFETY_BLOCK, /^BLOCKED\b|BLOCKED for safety|BLOCKED:|is protected from model reads|escapes the project directory|needs explicit user consent|write tools are disabled/im],
  [FAILURE.TIMEOUT, /timed out|ETIMEDOUT|ESOCKETTIMEDOUT|timeout after|deadline exceeded/i],
  [FAILURE.NETWORK_FAILURE, /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|getaddrinfo|network is unreachable|DNS|TLS handshake|certificate has expired|socket hang up/i],
  [FAILURE.PERMISSION_DENIED, /EACCES|EPERM|permission denied|operation not permitted|read-only file system|EROFS|401 Unauthorized|403 Forbidden/i],
  [FAILURE.DEPENDENCY_FAILURE, /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ModuleNotFoundError|ImportError|npm ERR! (missing|404)|package .* not found|unresolved import|no such crate|cannot find package/i],
  [FAILURE.SYNTAX_FAILURE, /SyntaxError|Unexpected token|Unexpected end of (input|JSON)|IndentationError|parse error|invalid syntax|unterminated string/i],
  [FAILURE.TEST_FAILURE, /\d+ (test|spec|assertion)s? failed|tests? failed|FAIL(ED)?\s|✗|AssertionError|expect\(.*\)\.to|assert\.|\bfailing tests?\b|\d+ failed,/i],
  [FAILURE.BUILD_FAILURE, /build failed|compilation (failed|error)|error TS\d+|rustc: error|cannot compile|webpack.*ERROR|tsc .*error/i],
  [FAILURE.CONFIGURATION_FAILURE, /configuration (error|invalid|missing)|missing config\b|invalid config\b|malformed (json|yaml|toml) config|config schema/i],
  [FAILURE.RUNTIME_FAILURE, /uncaught (exception|error)|ReferenceError\b|\bruntime error\b/i],
  [FAILURE.INTEGRATION_FAILURE, /API contract|schema mismatch between|502 Bad Gateway|503 Service Unavailable/i],
  [FAILURE.TYPE_FAILURE, /TypeError\b|incompatible types|type mismatch|cannot assign.*(type|to parameter)/i],
  [FAILURE.STATE_FAILURE, /EBUSY|resource busy|stale (lock|state)|already locked|ELOCKED/i],
  [FAILURE.CONCURRENCY_FAILURE, /deadlock|race condition|EAGAIN|resource temporarily unavailable|concurrent modification/i],
  [FAILURE.ENVIRONMENT_FAILURE, /missing env|environment variable|ENOSPC|no space left|EIO\b/i],
  [FAILURE.PERFORMANCE_FAILURE, /heap out of memory|JavaScript heap|ENOMEM|killed \(oom\)/i],
  [FAILURE.RESOURCE_FAILURE, /EMFILE|too many open files|ENFILE|thread.*exhausted/i],
  [FAILURE.TOOL_FAILURE, /plugin (crashed|timed out)|tool host (exited|died)|plugin process (exited|died|terminated)/i],
  [FAILURE.NOT_FOUND, /ENOENT|no such file|not found|does not exist|404|no matches|nothing matched|old string not found|string not found|unknown skill|no file matched/i],
  [FAILURE.INVALID_ARGUMENT, /invalid|malformed|missing required|expected .* argument|bad pattern|unknown tool|empty path|must be a|required parameter|no task provided/i],
]

/** Result strings that LOOK like failures but are normal, empty results. */
const EMPTY_OK = /^\(no output\)$|^\(no matches\)$|^no matches found/i

/**
 * Classify a tool result.
 * @param result  the tool's string result (or an Error)
 * @param meta    { tool, args, exitCode, thrown }
 * @returns { failed, code, evidence, retryable, transient, safeToRetry }
 */
export function classifyFailure(result, meta = {}) {
  const tool = meta.tool ?? ""
  const text = result instanceof Error ? `ERROR: ${result.message}` : String(result ?? "")
  const thrown = meta.thrown === true || result instanceof Error
  const head = text.slice(0, 4000)

  const explicitError = /^ERROR\b/.test(text.trimStart()) || /^BLOCKED\b/.test(text.trimStart()) || thrown
  const exitBad = Number.isInteger(meta.exitCode) && meta.exitCode !== 0
  const exitLine = /\[exit code: (\d+)\]/.exec(text)
  const exitFromText = exitLine ? Number(exitLine[1]) : null
  const commandFailed = tool === "bash" && (exitBad || (exitFromText !== null && exitFromText !== 0) || /\[command timed out after/.test(text))

  if (!explicitError && !commandFailed) {
    // a successful call may still carry a diagnostic worth surfacing
    if (EMPTY_OK.test(text.trim())) return ok()
    return ok()
  }

  let code = FAILURE.UNKNOWN
  let evidence = firstMeaningfulLine(head)
  for (const [c, re] of PATTERNS) {
    const m = re.exec(head)
    if (m) { code = c; evidence = lineAround(head, m.index); break }
  }
  // bash exits non-zero with no recognizable pattern: it is the COMMAND that
  // failed, not the tool — classify by what the command was doing.
  if (code === FAILURE.UNKNOWN && commandFailed) {
    const cmd = String(meta.args?.command ?? "")
    if (/\btest|jest|vitest|pytest|mocha|go test|cargo test\b/.test(cmd)) code = FAILURE.TEST_FAILURE
    else if (/\bbuild|tsc|webpack|vite build|cargo build|make\b/.test(cmd)) code = FAILURE.BUILD_FAILURE
    else if (/\b(npm|pnpm|yarn|pip3?|apt-get|brew|cargo)\s+(i|install|add|ci)\b/.test(cmd)) code = FAILURE.DEPENDENCY_FAILURE
  }

  const transient = code === FAILURE.TIMEOUT || code === FAILURE.NETWORK_FAILURE
  return {
    failed: true,
    code,
    evidence: String(evidence || text.slice(0, 200)).trim().slice(0, 300),
    exitCode: exitFromText ?? (Number.isInteger(meta.exitCode) ? meta.exitCode : null),
    transient,
    retryable: transient,
    safeToRetry: transient && meta.idempotent !== false,
  }
}

function ok() {
  return { failed: false, code: null, evidence: "", exitCode: 0, transient: false, retryable: false, safeToRetry: false }
}

function firstMeaningfulLine(text) {
  for (const line of String(text).split("\n")) {
    const l = line.trim()
    if (l && !/^-{3,}$/.test(l)) return l.slice(0, 300)
  }
  return String(text).slice(0, 200)
}

function lineAround(text, index) {
  const start = text.lastIndexOf("\n", index) + 1
  const end = text.indexOf("\n", index)
  return text.slice(start, end === -1 ? Math.min(text.length, start + 300) : end)
}

/**
 * Ordered recovery strategies for a failure (§9).
 * @param code     FAILURE.*
 * @param opts     { tool, attempts, idempotent, readOnly, hasAlternative, args }
 * @returns { code, strategies:[{action, why, safe}], escalate, maxAttempts, summary }
 */
export function recoveryPlan(code, opts = {}) {
  const { tool = "", attempts = 0, idempotent = false, hasAlternative = true } = opts
  const s = []
  const add = (action, why, safe = true) => s.push({ action, why, safe })

  switch (code) {
    case FAILURE.TIMEOUT:
      if (idempotent && attempts < 1) add(STRATEGY.RETRY, "one retry is safe: the operation is idempotent", true)
      else if (!idempotent) add(STRATEGY.INSPECT_FIRST, "the operation may have partially applied — inspect state before repeating", true)
      add(STRATEGY.REDUCE_SCOPE, "narrow the command/window (fewer files, a focused test, a smaller read)", true)
      if (hasAlternative) add(STRATEGY.ALTERNATE_TOOL, "use a cheaper tool that answers the same question", true)
      add(STRATEGY.ESCALATE, "raise the timeout with the user if the work genuinely needs longer", true)
      break
    case FAILURE.NETWORK_FAILURE:
      if (attempts < 1) add(STRATEGY.RETRY, "transient network errors resolve on a single retry", true)
      add(STRATEGY.ALTERNATE_TOOL, "try another source (search instead of fetch, or the local repo)", true)
      add(STRATEGY.ESCALATE, "report that the network is unavailable instead of pretending", true)
      break
    case FAILURE.NOT_FOUND:
      add(STRATEGY.INSPECT_FIRST, "stop guessing the path/anchor: discover it (glob/grep) and re-read", true)
      add(STRATEGY.FIX_ARGUMENTS, "correct the path or the exact old-text and call once more", true)
      if (hasAlternative) add(STRATEGY.ALTERNATE_TOOL, "a discovery tool answers this more reliably", true)
      break
    case FAILURE.INVALID_ARGUMENT:
      add(STRATEGY.FIX_ARGUMENTS, "the call shape is wrong — fix the arguments, do not repeat them", true)
      add(STRATEGY.INSPECT_FIRST, "re-read the tool contract/state that the arguments describe", true)
      break
    case FAILURE.PERMISSION_DENIED:
      add(STRATEGY.REDUCE_SCOPE, "work inside the project boundary instead", true)
      add(STRATEGY.ESCALATE, "this needs a human decision (credentials/permissions) — ask", true)
      add(STRATEGY.ABORT, "never escalate privileges automatically", true)
      break
    case FAILURE.SAFETY_BLOCK:
      add(STRATEGY.ABORT, "a safety control refused this — retrying is never the answer", true)
      add(STRATEGY.ALTERNATE_TOOL, "achieve the goal with a permitted operation", true)
      add(STRATEGY.ESCALATE, "if it is genuinely required, the user must run/allow it", true)
      break
    case FAILURE.DEPENDENCY_FAILURE:
      add(STRATEGY.INSPECT_FIRST, "confirm the dependency is declared and what version is expected", true)
      add(STRATEGY.INSTALL_DEPENDENCY, "install it, then re-run the failing command to verify", true)
      add(STRATEGY.ESCALATE, "adding a dependency to someone's project can be a product decision", true)
      break
    case FAILURE.SYNTAX_FAILURE:
      add(STRATEGY.INSPECT_FIRST, "read the exact region the parser named", true)
      add(STRATEGY.FIX_ARGUMENTS, "repair the edit that broke the syntax (or undo it)", true)
      add(STRATEGY.REDUCE_SCOPE, "apply the change in smaller pieces", true)
      break
    case FAILURE.TEST_FAILURE:
      add(STRATEGY.INSPECT_FIRST, "read the assertion and the failing implementation before editing", true)
      add(STRATEGY.REDUCE_SCOPE, "run the single failing test for a fast signal", true)
      add(STRATEGY.FIX_ARGUMENTS, "change the implementation, then verify again", true)
      break
    case FAILURE.BUILD_FAILURE:
      add(STRATEGY.INSPECT_FIRST, "read the first compiler error only — later ones are usually cascades", true)
      add(STRATEGY.REDUCE_SCOPE, "build the affected package/target alone", true)
      break
    case FAILURE.TYPE_FAILURE:
      add(STRATEGY.INSPECT_FIRST, "read the type error and the declared types at the call site", true)
      add(STRATEGY.FIX_ARGUMENTS, "correct the type/shape, then re-check", true)
      add(STRATEGY.REDUCE_SCOPE, "fix the one mismatched site, not the whole module", true)
      break
    case FAILURE.STATE_FAILURE:
      add(STRATEGY.INSPECT_FIRST, "the resource is busy or locked — inspect who holds it", true)
      add(STRATEGY.REDUCE_SCOPE, "retry only after the lock/state is released", true)
      add(STRATEGY.ESCALATE, "a stuck lock often needs a human", true)
      break
    case FAILURE.CONCURRENCY_FAILURE:
      add(STRATEGY.INSPECT_FIRST, "identify the shared state and the racing accessors", true)
      add(STRATEGY.REDUCE_SCOPE, "serialize the critical section or add a lock", true)
      add(STRATEGY.ESCALATE, "concurrency bugs are easy to mis-fix — confirm the diagnosis", true)
      break
    case FAILURE.ENVIRONMENT_FAILURE:
      add(STRATEGY.INSPECT_FIRST, "check env vars, disk space, and the runtime environment", true)
      add(STRATEGY.ESCALATE, "environment (disk, env, I/O) is not something the agent should invent", true)
      break
    case FAILURE.PERFORMANCE_FAILURE:
      add(STRATEGY.REDUCE_SCOPE, "the process ran out of memory — shrink the work", true)
      add(STRATEGY.INSPECT_FIRST, "find the allocation that blew the heap", true)
      add(STRATEGY.ESCALATE, "raising heap limits is a human decision", true)
      break
    case FAILURE.RESOURCE_FAILURE:
      add(STRATEGY.REDUCE_SCOPE, "too many files/threads — close what you opened and do less in parallel", true)
      add(STRATEGY.ESCALATE, "resource exhaustion may need a process restart", true)
      break
    case FAILURE.TOOL_FAILURE:
      add(STRATEGY.ALTERNATE_TOOL, "the tool/plugin itself failed — use a builtin", true)
      add(STRATEGY.INSPECT_FIRST, "confirm the tool is still alive before retrying it", true)
      add(STRATEGY.ABORT, "do not keep restarting a crashed plugin", true)
      break
    case FAILURE.CONFIGURATION_FAILURE:
      add(STRATEGY.INSPECT_FIRST, "read the config the process named before changing it", true)
      add(STRATEGY.FIX_ARGUMENTS, "correct the configuration, then re-run once", true)
      add(STRATEGY.ESCALATE, "config changes can be a product decision", true)
      break
    case FAILURE.RUNTIME_FAILURE:
      add(STRATEGY.INSPECT_FIRST, "read the stack: uncaught exceptions are rarely fixed by retrying", true)
      add(STRATEGY.REDUCE_SCOPE, "reproduce with the smallest input that throws", true)
      add(STRATEGY.ESCALATE, "if the crash is in forge itself, stop patching the project", true)
      break
    case FAILURE.INTEGRATION_FAILURE:
      add(STRATEGY.INSPECT_FIRST, "the contract between two systems drifted — read both sides", true)
      add(STRATEGY.ALTERNATE_TOOL, "try a second endpoint/source before editing both", true)
      add(STRATEGY.ESCALATE, "an API contract change may need a human", true)
      break
    case FAILURE.CANCELLED:
      add(STRATEGY.ABORT, "the user interrupted — do not restart without being asked", true)
      break
    default:
      add(STRATEGY.INSPECT_FIRST, "gather evidence about what actually happened", true)
      if (idempotent && attempts < 1) add(STRATEGY.RETRY, "one retry is safe for an idempotent operation", true)
      if (hasAlternative) add(STRATEGY.ALTERNATE_TOOL, "try a different tool for the same capability", true)
      add(STRATEGY.ESCALATE, "if the cause stays unknown, report it instead of looping", true)
  }

  // never suggest repeating a non-idempotent mutation after an uncertain result
  const strategies = s.filter((x) => !(x.action === STRATEGY.RETRY && !idempotent))
  return {
    code,
    tool,
    strategies,
    escalate: strategies.some((x) => x.action === STRATEGY.ESCALATE) && attempts >= 1,
    maxAttempts: code === FAILURE.TIMEOUT || code === FAILURE.NETWORK_FAILURE ? 2 : 1,
    summary: strategies.map((x) => x.action).join(" → "),
  }
}

/**
 * §17 — when does a human materially improve the decision?
 * Not "every write needs a y/N" (that is what the safety engine already gates)
 * but the four cases where forge genuinely cannot know the right answer:
 * a permission/credential decision, a destructive irreversible operation, a
 * strategy that has now failed repeatedly, and a dependency/product choice.
 */
export function shouldEscalate({ code = null, attempts = 0, risk = "low", reversible = true, tool = "", blockedRepeat = false } = {}) {
  const no = { escalate: false, question: "", why: "" }
  if (code === FAILURE.PERMISSION_DENIED) {
    return { escalate: true, question: `${tool || "this operation"} was denied by the OS/service — should I try a different approach, or will you grant access?`, why: "credential/permission decisions belong to the user" }
  }
  if (code === FAILURE.CANCELLED) return no
  if (code === FAILURE.SAFETY_BLOCK && attempts >= 1) {
    return { escalate: true, question: `a safety control keeps refusing ${tool || "this operation"} — do you want to run it yourself, or should I solve it another way?`, why: "a repeatedly blocked operation needs an explicit human decision" }
  }
  if (code === FAILURE.DEPENDENCY_FAILURE && attempts >= 1) {
    return { escalate: true, question: "this needs a dependency that is not installed — may I add it to the project?", why: "adding a dependency is a product decision" }
  }
  if (blockedRepeat || attempts >= 3) {
    return { escalate: true, question: `${tool || "this strategy"} has failed ${Math.max(attempts, 2)}× — I can change approach or hand it back to you; which do you prefer?`, why: "a repeatedly failing strategy is a signal to stop, not to loop" }
  }
  if (!reversible && (risk === "high" || risk === "critical")) {
    return { escalate: true, question: `this is an irreversible ${risk}-risk operation (${tool}) — confirm before I proceed?`, why: "destructive irreversible operations need consent" }
  }
  return no
}

/** classify + plan in one call. */
export function diagnose(result, meta = {}) {
  const f = classifyFailure(result, meta)
  if (!f.failed) return { ...f, plan: null }
  return { ...f, plan: recoveryPlan(f.code, { ...meta, attempts: meta.attempts ?? 0 }) }
}

/** One compact, model-readable hint appended to a failed tool result. */
export function formatDiagnosis(d) {
  if (!d || !d.failed) return ""
  const first = d.plan?.strategies?.[0]
  const second = d.plan?.strategies?.[1]
  const parts = [`[forge] failure=${d.code}`]
  if (first) parts.push(`recovery: ${first.action} (${first.why})`)
  if (second) parts.push(`then: ${second.action}`)
  return parts.join(" • ")
}
