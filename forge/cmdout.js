/**
 * forge — structured command results + output intelligence (Ω, zero deps)
 *
 * Every command execution produces a structured record. Success is the
 * process result (exitCode / signal / timedOut), NEVER inferred from a
 * truncated stdout. The model-facing string still carries `[exit code: N]`
 * OUTSIDE the truncation window (the v20.0.1 defect).
 *
 * Long output is summarised for the UI: counts, first failure, duration,
 * truncation flag. The full text stays on `stdout`/`stderr` for diagnosis.
 */
export function createCommandResult({
  command = "",
  exitCode = null,
  signal = null,
  timedOut = false,
  killed = false,
  stdout = "",
  stderr = "",
  durationMs = 0,
  truncated = false,
  processId = null,
  processGroupId = null,
  startedAt = 0,
  finishedAt = 0,
  overflow = false,
  aborted = false,
  timeoutSec = null,
  maxBuf = null,
} = {}) {
  const code = Number.isInteger(exitCode) ? exitCode : (timedOut ? 124 : (signal ? 137 : (aborted ? 130 : null)))
  const ok = !timedOut && !aborted && !overflow && code === 0
  return {
    command: String(command ?? "").slice(0, 2000),
    exitCode: code,
    signal: signal ?? null,
    timedOut: !!timedOut,
    killed: !!killed || !!timedOut || !!overflow,
    stdout: String(stdout ?? ""),
    stderr: String(stderr ?? ""),
    durationMs: Math.max(0, Number(durationMs) || 0),
    truncated: !!truncated || !!overflow,
    processId: processId ?? null,
    processGroupId: processGroupId ?? null,
    startedAt: startedAt || 0,
    finishedAt: finishedAt || 0,
    overflow: !!overflow,
    aborted: !!aborted,
    timeoutSec: timeoutSec ?? null,
    maxBuf: maxBuf ?? null,
    ok,
  }
}

/**
 * Authoritative model-facing string. Marker (timeout / overflow / exit / kill)
 * is appended AFTER the body is capped so agent.js can always parse it.
 */
export function formatCommandResult(r, { max = 12000 } = {}) {
  const body = composeBody(r)
  const marker = markerOf(r)
  const capped = capKeepTail(body || "(no output)", max)
  return marker ? `${capped}\n${marker}` : capped
}

function composeBody(r) {
  let out = r.stdout || ""
  if (r.stderr) out += (out ? "\n--- stderr ---\n" : "") + r.stderr
  return out
}

function markerOf(r) {
  if (r.aborted) return ""
  if (r.timedOut) {
    const sec = r.timeoutSec ?? Math.round((r.durationMs || 0) / 1000) ?? "?"
    return `[command timed out after ${sec}s]\n[exit code: 124]`
  }
  if (r.overflow) {
    const n = r.maxBuf ? `${r.maxBuf} bytes` : "buffer"
    return `[output exceeded ${n} — process killed]\n[exit code: 1]`
  }
  if (typeof r.exitCode === "number" && r.exitCode !== 0) return `[exit code: ${r.exitCode}]`
  if (r.exitCode == null && r.signal) return `[killed by ${r.signal}]\n[exit code: 137]`
  return ""
}

function capKeepTail(s, limit) {
  if (s.length <= limit) return s
  const head = Math.floor(limit * 0.7)
  const tail = Math.max(200, limit - head - 80)
  return `${s.slice(0, head)}\n... (truncated, ${s.length} chars total; tail kept)\n${s.slice(-tail)}`
}

const FAIL_LINE = /\b(FAIL|FAILED|Error|ERROR|AssertionError|✗|×|not ok|Traceback|Exception|Expected |Received )\b/
const TEST_COUNTS = /(\d+)\s+failed[^\n]*?(\d+)\s+passed|(\d+)\s+passed[^\n]*?(\d+)\s+failed|Tests:\s+[^\n]*?(\d+)\s+failed[^\n]*?(\d+)\s+passed/i

export function parseTestCounts(text = "") {
  const t = String(text)
  const m = TEST_COUNTS.exec(t)
  if (m) {
    const failed = Number(m[1] || m[4] || m[5] || 0)
    const passed = Number(m[2] || m[3] || m[6] || 0)
    return { failed, passed, total: failed + passed }
  }
  const failN = /\b(\d+)\s+(?:test|spec|assertion)s?\s+failed/i.exec(t)
  const passN = /\b(\d+)\s+(?:test|spec)s?\s+passed/i.exec(t)
  if (failN || passN) {
    const failed = failN ? Number(failN[1]) : 0
    const passed = passN ? Number(passN[1]) : 0
    return { failed, passed, total: failed + passed }
  }
  return null
}

export function extractFirstFailure(text = "") {
  const lines = String(text).split("\n")
  for (const line of lines) {
    if (FAIL_LINE.test(line) && line.trim().length > 4) return line.trim().slice(0, 240)
  }
  return ""
}

/**
 * UI summary of a command. Never invents a pass. Full text stays on `text`.
 */
export function summarizeCommand(r, { maxLines = 6 } = {}) {
  const text = typeof r === "string" ? r : composeBody(r)
  const rec = typeof r === "string" ? parseCommandResult(r) : r
  const counts = parseTestCounts(text)
  const first = extractFirstFailure(text)
  const lines = String(text).split("\n")
  const summary = []
  if (counts) summary.push(`${counts.failed} failed / ${counts.passed} passed`)
  if (first) {
    summary.push("First failure:")
    summary.push(first)
  } else {
    const head = lines.filter((l) => l.trim()).slice(0, 2)
    summary.push(...head.map((l) => l.replace(/\s+/g, " ").slice(0, 120)))
  }
  if (rec.timedOut) summary.push(`timed out after ${Math.round((rec.durationMs || 0) / 1000)}s`)
  else if (rec.exitCode != null && rec.exitCode !== 0) summary.push(`Process exited with code ${rec.exitCode}`)
  if (rec.durationMs) summary.push(`Duration: ${(rec.durationMs / 1000).toFixed(1)}s`)
  if (rec.truncated) summary.push("[full output available]")
  return {
    ok: rec.ok === true,
    exit: rec.exitCode,
    lines: lines.length,
    summary: summary.filter(Boolean).slice(0, maxLines),
    hidden: rec.truncated ? Math.max(0, lines.length - maxLines) : 0,
    counts,
    firstFailure: first,
    durationMs: rec.durationMs,
    timedOut: rec.timedOut,
    truncated: rec.truncated,
    text,
  }
}

/** Parse the model-facing string back into a structured result. */
export function parseCommandResult(text = "") {
  const s = String(text ?? "")
  const timedOut = /\[command timed out after/.test(s)
  const overflow = /\[output exceeded /.test(s)
  const killed = /\[killed by /.exec(s)
  const abort = /^ERROR: cancelled/.test(s)
  const exitM = /\[exit code: (-?\d+)\]\s*$/m.exec(s)
  const exitCode = exitM ? Number(exitM[1]) : (timedOut ? 124 : (abort ? 130 : (overflow ? 1 : 0)))
  return createCommandResult({
    exitCode,
    timedOut,
    overflow,
    aborted: abort,
    killed: timedOut || overflow || !!killed,
    signal: killed ? killed[1] : null,
    stdout: s,
    truncated: /\(truncated/.test(s) || overflow,
    ok: !timedOut && !overflow && !abort && exitCode === 0,
  })
}
