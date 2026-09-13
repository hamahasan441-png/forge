/**
 * forge — execution result model (v80, zero dependencies)
 *
 * A command result is structural. Truncation and unknown status never PASS.
 * Used by skill verify and experiment. Kernel frozen. Not a second verifier.
 */
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"

export const EXEC_STATUS = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  TIMEOUT: "TIMEOUT",
  KILLED: "KILLED",
  BLOCKED: "BLOCKED",
  TRUNCATED: "TRUNCATED",
  UNKNOWN: "UNKNOWN",
})

export const MAX_CAPTURE = 64 * 1024
export const DEFAULT_TIMEOUT_MS = 8000

function clip(s, max) {
  const t = String(s ?? "")
  if (Buffer.byteLength(t) <= max) return { text: t, truncated: false }
  let out = t
  while (Buffer.byteLength(out) > max) out = out.slice(0, Math.max(0, out.length - 64))
  return { text: out, truncated: true }
}

export function classifySpawn(r, {
  cmd = "",
  maxBytes = MAX_CAPTURE,
  blocked = false,
  level = null,
  reason = null,
  duration = 0,
} = {}) {
  if (blocked) {
    return {
      cmd, stdout: "", stderr: "", exitCode: null, timedOut: false, killed: false,
      truncated: false, duration: Number(duration) || 0, signal: null,
      status: EXEC_STATUS.BLOCKED, ok: false, skipped: true, level, reason,
    }
  }
  const stdoutRaw = r?.stdout == null ? "" : String(r.stdout)
  const stderrRaw = r?.stderr == null ? "" : String(r.stderr)
  const out = clip(stdoutRaw, maxBytes)
  const err = clip(stderrRaw, maxBytes)
  const bufErr = r?.error?.code === "ENOBUFS"
  const truncated = out.truncated || err.truncated || bufErr
  const timedOut = r?.error?.code === "ETIMEDOUT" || r?.signal === "SIGTERM"
  const killed = r?.signal === "SIGKILL" || /SIGKILL/.test(String(r?.error?.message || ""))
  const exitCode = Number.isInteger(r?.status) ? r.status : null
  const signal = r?.signal || null
  let status
  if (timedOut) status = EXEC_STATUS.TIMEOUT
  else if (killed) status = EXEC_STATUS.KILLED
  else if (truncated) status = EXEC_STATUS.TRUNCATED
  else if (exitCode === 0) status = EXEC_STATUS.PASS
  else if (exitCode != null) status = EXEC_STATUS.FAIL
  else status = EXEC_STATUS.UNKNOWN
  return {
    cmd,
    stdout: out.text,
    stderr: err.text,
    exitCode,
    timedOut: !!timedOut,
    killed: !!killed,
    truncated: !!truncated,
    duration: Number(duration) || 0,
    signal,
    status,
    ok: status === EXEC_STATUS.PASS,
    skipped: false,
    level: level || "allow",
    code: exitCode,
    timed: !!timedOut,
  }
}

export function runCommand(cmd, {
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_CAPTURE,
} = {}) {
  const t0 = Date.now()
  const r = spawnSync("sh", ["-c", String(cmd)], {
    cwd,
    env: { PATH: env.PATH || process.env.PATH || "/usr/bin:/bin", HOME: cwd, LANG: "C" },
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: maxBytes,
    killSignal: "SIGTERM",
  })
  return classifySpawn(r, { cmd: String(cmd).slice(0, 200), maxBytes, duration: Date.now() - t0 })
}

export function generatedTestProvenance({ command = "", sourceGap = null, reason = "", generator = "forge-v80" } = {}) {
  const cmd = String(command || "").slice(0, 200)
  return {
    generated: true,
    sourceGap: sourceGap || null,
    reason: String(reason || "derived, not invented").slice(0, 240),
    knowledgeSources: sourceGap ? [sourceGap] : [],
    generatedAt: new Date().toISOString(),
    generator,
    fingerprint: crypto.createHash("sha256").update(cmd).digest("hex"),
    command: cmd,
  }
}
