/**
 * forge — the verification gate (Phase 3): evidence before "done".
 *
 * An agent that edits code and then says "COMPLETED" has asserted success, not
 * demonstrated it. Nothing in forge previously distinguished "I ran the tests
 * and they pass" from "I believe this is right" — and the second is where an
 * autonomous agent quietly ruins a repository over several segments.
 *
 * This module answers one question honestly: *does this project's own checks
 * pass right now?* The honesty matters more than the coverage:
 *
 *   - `NOT_AVAILABLE` is a first-class result. A project with no test command
 *     gets NOT_AVAILABLE, never PASSED. Absence of evidence is never recorded
 *     as evidence of correctness.
 *   - `BLOCKED` is a first-class result. A detected command that the safety
 *     engine refuses is recorded as blocked and NOT run. This module has no
 *     private path to the shell: every command goes through `modelMayRun`,
 *     exactly like the agent's own bash tool.
 *   - Commands are only ever derived from the project's OWN config files
 *     (package.json scripts, Makefile targets, and the conventional entry
 *     point for a few ecosystems). Nothing here executes a string the model
 *     produced, and nothing here reads a command out of agent output.
 *
 * Running a project's test command executes that project's code — which the
 * agent's bash tool could already do. The gate does not widen what forge can
 * run; it makes running it deliberate, recorded, and off by default.
 */
import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { modelMayRun } from "./shellguard.js"
import { redact } from "./secrets.js"

export const VERIFY_STATUS = Object.freeze({
  PASSED: "PASSED",               // every check that ran exited 0
  FAILED: "FAILED",               // at least one check failed
  NOT_AVAILABLE: "NOT_AVAILABLE", // this project has no checks to run
  BLOCKED: "BLOCKED",             // every candidate check was refused by policy
})

/** Cheap checks first: a type error should surface before a 10-minute suite. */
const SCRIPT_PRIORITY = ["typecheck", "tsc", "lint", "check", "test"]

/** Hard ceilings — a verification gate must not become the long pole. */
export const MAX_CHECKS = 3
export const DEFAULT_TIMEOUT_SEC = 300
const MAX_OUTPUT = 4000 // chars of tail kept per check

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")) } catch { return null } }
const exists = (cwd, f) => { try { return fs.existsSync(path.join(cwd, f)) } catch { return false } }

/**
 * Discover this project's verification commands from its own configuration.
 * Returns `[{ id, cmd, source }]`, cheapest first, capped at MAX_CHECKS.
 * An empty array means NOT_AVAILABLE — which is a real answer, not a failure.
 */
export function detectChecks(cwd) {
  const out = []

  const pkg = readJson(path.join(cwd, "package.json"))
  if (pkg && pkg.scripts && typeof pkg.scripts === "object") {
    for (const name of SCRIPT_PRIORITY) {
      if (typeof pkg.scripts[name] === "string" && pkg.scripts[name].trim()) {
        out.push({ id: name, cmd: name === "test" ? "npm test" : `npm run ${name}`, source: "package.json scripts" })
      }
    }
  }

  // Makefile targets, matched at the start of a line as `target:`
  try {
    const mk = fs.readFileSync(path.join(cwd, "Makefile"), "utf8")
    for (const name of ["lint", "check", "test"]) {
      if (out.some((c) => c.id === name)) continue
      if (new RegExp(`^${name}:`, "m").test(mk)) out.push({ id: name, cmd: `make ${name}`, source: "Makefile" })
    }
  } catch { /* no Makefile */ }

  // Conventional single entry points for a few ecosystems
  if (!out.length) {
    if (exists(cwd, "Cargo.toml")) out.push({ id: "test", cmd: "cargo test", source: "Cargo.toml" })
    else if (exists(cwd, "go.mod")) out.push({ id: "test", cmd: "go test ./...", source: "go.mod" })
    else if (exists(cwd, "pytest.ini") || exists(cwd, "tox.ini") || (exists(cwd, "pyproject.toml") && exists(cwd, "tests"))) {
      out.push({ id: "test", cmd: "pytest -q", source: "python project" })
    }
  }

  return out.slice(0, MAX_CHECKS)
}

function runOne(cwd, cmd, timeoutSec) {
  return new Promise((resolve) => {
    const t = Math.min(1800, Math.max(1, timeoutSec)) * 1000
    const t0 = Date.now()
    execFile("/bin/sh", ["-c", cmd], {
      cwd, timeout: t, maxBuffer: 8 * 1024 * 1024, killSignal: "SIGKILL",
      env: { ...process.env, TERM: "dumb", CI: "1", NO_COLOR: "1" },
    }, (error, stdout, stderr) => {
      let out = String(stdout ?? "")
      if (stderr) out += (out ? "\n--- stderr ---\n" : "") + stderr
      const timedOut = !!(error && error.killed)
      const code = timedOut ? null : (error && typeof error.code === "number" ? error.code : (error ? 1 : 0))
      if (timedOut) out += `\n[timed out after ${t / 1000}s]`
      // Keep the TAIL: a failing suite puts its summary at the end.
      const red = redact(out)
      const tail = red.length > MAX_OUTPUT ? "…(truncated)\n" + red.slice(-MAX_OUTPUT) : red
      resolve({ ok: code === 0, code, timedOut, ms: Date.now() - t0, output: tail.trim() || "(no output)" })
    })
  })
}

/**
 * Run this project's checks and report what actually happened.
 *
 * @returns {Promise<{status, checks:[{id,cmd,source,ok,code,blocked,reason,ms,output}], ranAt}>}
 */
export async function verifyProject(cwd, { checks, timeoutSec = DEFAULT_TIMEOUT_SEC, allowSudo = false, assumeYes = false } = {}) {
  const found = checks ?? detectChecks(cwd)
  if (!found.length) {
    return { status: VERIFY_STATUS.NOT_AVAILABLE, checks: [], ranAt: Date.now() }
  }

  const results = []
  for (const c of found) {
    // No private path to the shell: the same policy the agent's bash tool uses.
    const verdict = modelMayRun(c.cmd, { cwd, root: cwd }, { allowSudo, assumeYes })
    if (!verdict.ok) {
      results.push({ ...c, ok: false, code: null, blocked: true, reason: verdict.reason, ms: 0, output: "" })
      continue
    }
    const r = await runOne(cwd, c.cmd, timeoutSec)
    results.push({ ...c, blocked: false, reason: null, ...r })
  }

  const ran = results.filter((r) => !r.blocked)
  const status = !ran.length ? VERIFY_STATUS.BLOCKED
    : ran.every((r) => r.ok) ? VERIFY_STATUS.PASSED
      : VERIFY_STATUS.FAILED
  return { status, checks: results, ranAt: Date.now() }
}

/** One line per check, for the CLI and the task record. */
export function summarizeVerification(v) {
  if (!v) return "no verification recorded"
  if (v.status === VERIFY_STATUS.NOT_AVAILABLE) return "NOT_AVAILABLE — this project exposes no test/lint command to run"
  return v.checks.map((c) => {
    if (c.blocked) return `${c.id}: BLOCKED (${String(c.reason).slice(0, 80)})`
    return `${c.id}: ${c.ok ? "pass" : `FAIL (exit ${c.code ?? "timeout"})`} — ${c.cmd} [${(c.ms / 1000).toFixed(1)}s]`
  }).join("\n")
}

/**
 * Turn a failed verification into the task text for a corrective segment.
 * The agent is told what failed and what the output was, and told explicitly
 * not to make the check pass by weakening it — the failure mode this loop
 * would otherwise reward.
 */
export function repairPrompt(originalTask, v) {
  const failed = (v?.checks ?? []).filter((c) => !c.ok && !c.blocked)
  return [
    originalTask,
    "",
    "--- verification failed (system) ---",
    "The work is not finished: this project's own checks fail after the previous segment's changes.",
    ...failed.map((c) => `\n$ ${c.cmd}   → exit ${c.code ?? "timeout"}\n${c.output}`),
    "",
    "Fix the underlying cause so these checks pass.",
    "Do NOT delete, skip, weaken or rewrite a check to make it pass, and do not change its assertions to match current behaviour — if you believe a check itself is wrong, say so in your final answer instead of editing it.",
  ].join("\n")
}
