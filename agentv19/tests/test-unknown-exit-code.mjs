#!/usr/bin/env node
/**
 * forge — P0 unknown exit code ⇒ NOT verified.
 *
 * The concrete defect: `evaluateVerification("go test ./...", "signal:
 * segmentation fault")` returned { passed: true, exitCode: 0 } — because with
 * no explicit exitCode the parser inferred 0 from the absence of a marker.
 * Absence of failure is not evidence of success.
 *
 * Rules enforced here:
 *   - an OBSERVED exit code 0 is required to pass
 *   - unknown status (missing/inferred) never passes
 *   - a signal (SIGSEGV/SIGABRT/…) is a failure, resolved as 128+11 = 139
 *   - "Killed" resolves to 137, a timeout to 124
 *   - failure SHAPES (panic, core dumped, "not found", "command not found",
 *     "no tests found", OOM) fail even when the exit code is missing
 *   - UNKNOWN carries confidence "none"
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-exit-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-exit-work-"))
process.chdir(WORK)

const vl = await import("../forge/verifyledger.js")
const { evaluateVerification, UNKNOWN_EXIT_CODE, resolveExitCode, detectFailureShape, createLedger } = vl

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

console.log("== the reported defect ==")
{
  const r = evaluateVerification("go test ./...", "signal: segmentation fault")
  eq("segfault does NOT pass", r.passed, false)
  eq("exit code is the signal code", r.exitCode, 139)
  ok("the status is known (it was resolved, not inferred)", r.exitCodeKnown === true)
  ok("failure shape recorded", r.failureShape !== null)
  ok("confidence is not 'none' (it confidently failed)", r.confidence === "high")
}

console.log("== unknown status never passes ==")
{
  for (const [cmd, out] of [
    ["go test ./...", "signal: segmentation fault"],
    ["npm test", "Killed"],
    ["npx jest", "sh: 1: jest: not found"],
    ["pytest", ""],
    ["npm test", "some output with no exit marker"],
    ["make check", "command not found"],
    ["npm test", "FAIL src/app.test.js"],
    ["npm test", "panic: runtime error: index out of range"],
    ["npm test", "JavaScript heap out of memory"],
    ["npm test", "AssertionError: expected 1 to equal 2"],
  ]) {
    const r = evaluateVerification(cmd, out)
    ok(`not passed: ${cmd} ← ${JSON.stringify(out.slice(0, 40))}`, r.passed === false)
  }
}

console.log("== observed 0 is required ==")
{
  for (const out of ["[exit code: 0]", "3 tests passed\n[exit code: 0]", "ok"]) {
    const r = evaluateVerification("npm test", out, { exitCode: 0 })
    ok(`passes on observed 0: ${JSON.stringify(out.slice(0, 24))}`, r.passed === true)
  }
  for (const code of [1, 2, 127, 137, 139]) {
    const r = evaluateVerification("npm test", "anything\n[exit code: X]", { exitCode: code })
    ok(`fails on exit ${code}`, r.passed === false)
  }
  const unknown = evaluateVerification("npm test", "no marker here")
  eq("UNKNOWN_EXIT_CODE sentinel is null", UNKNOWN_EXIT_CODE, null)
  eq("unknown status is reported as unknown", unknown.exitCode, null)
  eq("exitCodeKnown false", unknown.exitCodeKnown, false)
  eq("confidence none", unknown.confidence, "none")
}

console.log("== exit code resolution ==")
{
  eq("signal → 139", resolveExitCode({}, "signal: segmentation fault"), 139)
  eq("SIGSEGV → 139", resolveExitCode({}, "[signal: SIGSEGV]"), 139)
  eq("killed → 137", resolveExitCode({}, "[killed]"), 137)
  eq("timeout → 124", resolveExitCode({}, "timed out after 30s"), 124)
  eq("explicit wins", resolveExitCode({ exitCode: 3 }, "signal: segmentation fault"), 3)
  eq("unknown → null", resolveExitCode({}, "nothing to see"), null)
}

console.log("== failure shape detection ==")
{
  eq("signal shape", detectFailureShape("signal: segmentation fault"), "signal")
  eq("killed shape", detectFailureShape("Killed"), "killed")
  eq("timeout shape", detectFailureShape("timed out after 10s"), "timeout")
  eq("panic shape", detectFailureShape("panic: nil pointer"), "panic")
  eq("oom shape", detectFailureShape("JavaScript heap out of memory"), "oom")
  eq("not-found shape", detectFailureShape("sh: 1: jest: not found"), "not_found")
  eq("missing tests shape", detectFailureShape("No tests found"), "no_tests")
  eq("clean output has no shape", detectFailureShape("3 tests passed"), null)
}

console.log("== exit code 0 with a failure shape still fails ==")
{
  const r = evaluateVerification("npm test", "0 tests passed but then: FAIL\n[exit code: 0]")
  ok("a suspicious exit-0 output is not trusted blindly", r.passed === false)
  const clean = evaluateVerification("npm test", "3 tests passed\n[exit code: 0]")
  ok("a clean exit-0 output passes", clean.passed === true)
}

console.log("== the ledger refuses to verify on unknown evidence ==")
{
  const l = createLedger()
  l.recordCommand("npx vitest run src/a.test.js", "2 tests passed\n[exit code: 0]", { exitCode: 0, affectedFiles: ["src/a.js"], nodeId: "n1" })
  l.recordCommand("node --check src/a.js", "signal: segmentation fault", { affectedFiles: ["src/a.js"], nodeId: "n1" })
  const st = l.status("medium", ["src/a.js"], { nodeId: "n1" })
  ok("not verified", st.ok === false)
  ok("a failure is reported", st.anyFailure === true)
  const l2 = createLedger()
  l2.recordCommand("node --check src/a.js", "ok\n[exit code: 0]", { exitCode: 0, affectedFiles: ["src/a.js"], nodeId: "n1" })
  l2.recordCommand("npx vitest run src/a.test.js", "no marker at all", { affectedFiles: ["src/a.js"], nodeId: "n1" })
  const st2 = l2.status("medium", ["src/a.js"], { nodeId: "n1" })
  ok("unknown-status evidence leaves the node unverified", st2.ok === false)
  ok("focused_test is missing", (st2.missing ?? []).includes("focused_test"))
}

console.log("== end-to-end: an unverifiable run does not complete ==")
{
  const meta = await import("../forge/meta.js")
  const fake = async (args) => {
    if (args.planOnly) return { text: "1. fix the parser", toolRecords: [], commandChecks: [], toolLog: [] }
    return {
      text: "done", budgetHit: false, steps: 2,
      toolRecords: [{ tool: "edit_file", files_changed: ["p.js"] }],
      // the command "ran" but its status was never observed, and it crashed
      commandChecks: [{ command: "npx vitest run p.test.js", exitCode: null, passed: true, tail: "signal: segmentation fault" }],
      toolLog: [{ name: "edit_file" }],
    }
  }
  fs.writeFileSync(path.join(WORK, "p.js"), "module.exports = 1\n")
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const r = await meta.runMeta({
    config: cfg, provider: { name: "x", model: "m" }, task: "fix the parser",
    runAgent: fake, workers: false, maxSegments: 3, signal: new AbortController().signal,
  })
  ok("NOT COMPLETED on unverifiable evidence", r.status !== "COMPLETED")
  console.log(`       (status=${r.status}, node=${(r.task.dag?.nodes ?? [])[0]?.status})`)
}

console.log(`\n== unknown-exit-code suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
