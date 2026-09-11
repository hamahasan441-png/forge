/**
 * forge — self-diagnostics (∞, zero dependencies)
 *
 * A failure is PROJECT (the user's code, tests, config, build) or FORGE
 * (the agent, a plugin, the tool host, persistence, a safety control).
 * Repairing PROJECT by restarting a plugin is the wrong move; patching
 * the user's repo because forge's tool host died is worse.
 *
 * Deterministic. Uses diagnose codes + stack/path signals. Does not
 * rewrite classifyFailure — it layers origin on top.
 */
import { classifyFailure, FAILURE } from "./diagnose.js"

export const ORIGIN = {
  PROJECT: "PROJECT",
  FORGE: "FORGE",
  UNKNOWN: "UNKNOWN",
}

const FORGE_PATH = /(?:^|[\\/])(meta|omega|agent|tools|plugin-host|diagnose|shellguard|netguard|securefs|taskstate|verifyledger|recovery|cmdout|classify|hypothesis|causal|selfdiag)\.js\b/i
const FORGE_SIGNAL = /plugin (crashed|timed out)|tool host (exited|died)|plugin process (exited|died|terminated)|CRITICAL_PERSISTENCE_FAILED|forge internal|\[forge\]/i

/**
 * @param result  tool result string or Error
 * @param meta    { tool, args, exitCode, thrown, stack, files, diagnosis }
 * @returns {{ origin, why, code, retryable }}
 */
export function classifyOrigin(result, meta = {}) {
  const d = meta.diagnosis && typeof meta.diagnosis.failed === "boolean"
    ? meta.diagnosis
    : classifyFailure(result, meta)
  const text = result instanceof Error ? `ERROR: ${result.message}` : String(result ?? "")
  const stack = String(meta.stack ?? (result instanceof Error ? result.stack : "") ?? "")
  const files = (meta.files || []).map(String)

  if (d.code === FAILURE.TOOL_FAILURE || FORGE_SIGNAL.test(text)) {
    return { origin: ORIGIN.FORGE, why: "tool/plugin host died — this is a forge failure, not the project", code: d.code, retryable: false }
  }
  if (d.code === FAILURE.SAFETY_BLOCK) {
    return { origin: ORIGIN.FORGE, why: "a forge safety control refused the call — do not patch the project around it", code: d.code, retryable: false }
  }
  if (FORGE_PATH.test(stack) && !files.length) {
    return { origin: ORIGIN.FORGE, why: "stack points at forge internals", code: d.code, retryable: false }
  }
  if (d.code === FAILURE.CANCELLED) {
    return { origin: ORIGIN.FORGE, why: "user interrupt — forge stopped, the project did not fail", code: d.code, retryable: false }
  }

  const projectCodes = new Set([
    FAILURE.SYNTAX_FAILURE, FAILURE.TYPE_FAILURE, FAILURE.TEST_FAILURE,
    FAILURE.BUILD_FAILURE, FAILURE.DEPENDENCY_FAILURE, FAILURE.NOT_FOUND,
    FAILURE.CONFIGURATION_FAILURE, FAILURE.RUNTIME_FAILURE, FAILURE.INTEGRATION_FAILURE,
    FAILURE.STATE_FAILURE, FAILURE.CONCURRENCY_FAILURE, FAILURE.PERFORMANCE_FAILURE,
  ])
  if (d.failed && projectCodes.has(d.code)) {
    return { origin: ORIGIN.PROJECT, why: `failure class ${d.code} is the project's`, code: d.code, retryable: !!d.retryable }
  }
  if (d.failed && (d.code === FAILURE.ENVIRONMENT_FAILURE || d.code === FAILURE.RESOURCE_FAILURE || d.code === FAILURE.NETWORK_FAILURE || d.code === FAILURE.TIMEOUT)) {
    return { origin: ORIGIN.UNKNOWN, why: `${d.code} could be the machine, the project, or the network`, code: d.code, retryable: !!d.retryable }
  }
  if (d.failed) {
    return { origin: ORIGIN.PROJECT, why: "default: a failed command is the project's until proven otherwise", code: d.code, retryable: !!d.retryable }
  }
  return { origin: ORIGIN.UNKNOWN, why: "no failure", code: d.code, retryable: false }
}

/** Compact hint for a repair prompt. Empty when origin is uninteresting. */
export function formatOrigin(o) {
  if (!o || o.origin === ORIGIN.UNKNOWN) return ""
  if (o.origin === ORIGIN.FORGE) {
    return `[forge] origin=FORGE — ${o.why}. Do NOT edit the project to paper over a forge/tool failure. Escalate or switch tool.`
  }
  return `[forge] origin=PROJECT — ${o.why}`
}
