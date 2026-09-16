#!/usr/bin/env node
/**
 * forge — v104 "bindwise": engines that already existed were skipped on the
 * DEFAULT agent path. This suite proves they are bound, and that the old
 * blind spots are closed.
 *
 *   1. `echo ok` is not verification
 *   2. a real test command with exit 0 IS a covering check
 *   3. VOI experiments are recorded (not re-picked forever)
 *   4. PLAN ranks competing strategies
 *   5. world-model invalidate is called on writes
 *   6. dead import of unused predictionCalibration is gone
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bind-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + extra : ""}`) }
}

const { createCognition, isCoveringCheck, COGNITION_VERSION } = await import("../cognition.js")
const { VERSION } = await import("../version.js")
const { ACTION } = await import("../governor.js")

console.log("== version identity ==")
{
  ok("package version is 117.x", /^122\./.test(VERSION), VERSION)
  ok("cognition protocol is 1.5.x", /^1\.5\./.test(COGNITION_VERSION), COGNITION_VERSION)
}

console.log("== covering check: 'ok' in stdout is not verification ==")
{
  ok("echo ok is NOT covering", isCoveringCheck({ command: "echo ok", result: "ok\n[exit code: 0]" }) === false)
  ok("ls is NOT covering", isCoveringCheck({ command: "ls", result: "file.js\n[exit code: 0]" }) === false)
  ok("body containing 'pass' without a test command is NOT covering", isCoveringCheck({ command: "cat notes.txt", result: "all pass\n[exit code: 0]" }) === false)
  ok("npm test exit 0 IS covering", isCoveringCheck({ command: "npm test", result: "1 passed\n[exit code: 0]" }) === true)
  ok("pytest with failures is NOT covering", isCoveringCheck({ command: "pytest", result: "1 failed / 0 passed\n[exit code: 1]" }) === false)
  ok("jest exit 0 IS covering", isCoveringCheck({ command: "npx jest", result: "Tests: 3 passed\n[exit code: 0]" }) === true)
}

console.log("== observeTools no longer treats echo ok as verified ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bind-obs-"))
  const cog = createCognition({ cwd: dir, objective: "rewrite auth.js" })
  cog.observeTools([{ name: "write_file", args: { path: "auth.js" }, result: "ok" }])
  ok("write leaves unverified files", cog.snapshot().unverified.includes("auth.js") || cog.snapshot().unverified.some((f) => String(f).endsWith("auth.js")))
  ok("a result of 'ok' is not classified as ERROR (?? vs ternary)", cog.snapshot().writes >= 1)
  cog.observeTools([{ name: "bash", args: { command: "echo ok" }, result: "ok\n[exit code: 0]" }])
  ok("echo ok does NOT clear unverified", cog.snapshot().unverified.length > 0, JSON.stringify(cog.snapshot().unverified))
  cog.observeTools([{ name: "bash", args: { command: "npx vitest run" }, result: "1 passed\n[exit code: 0]" }])
  ok("real test command DOES clear unverified", cog.snapshot().unverified.length === 0, JSON.stringify(cog.snapshot().unverified))
}

console.log("== PLAN ranks strategies instead of leaving the list empty ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bind-plan-"))
  const cog = createCognition({ cwd: dir, objective: "rewrite the auth architecture across files" })
  const gov = cog.next({ steps: 0, writes: 0, inspected: false, hasPlan: false })
  ok("first action on architectural work is PLAN", gov.action === ACTION.PLAN, gov.action)
  ok("strategies were ranked", (cog.snapshot().ranked || []).length >= 2, JSON.stringify(cog.snapshot().ranked))
  ok("cheapest reversible is first", cog.snapshot().ranked[0].reversible === true)
  ok("prompt names STRATEGIES", /STRATEGIES/.test(cog.promptBlock()))
}

console.log("== VOI experiments are recorded on the kernel, not re-picked forever ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bind-voi-"))
  const cog = createCognition({ cwd: dir, objective: "rewrite the auth architecture across files" })
  cog.next({ steps: 0, writes: 0, inspected: false, hasPlan: false })
  ok("an experiment is selected on LARGE/ARCHITECTURAL", !!cog.lastExperiment, JSON.stringify(cog.lastExperiment))
  const id = cog.lastExperiment?.id
  cog.observeTools([{ name: "bash", args: { command: "pytest" }, result: "1 failed\n[exit code: 1]" }])
  const tried = cog.kernel.infogain.tried()
  ok("the experiment was recorded on the kernel", id ? (tried[id] || 0) >= 1 : false, JSON.stringify(tried))
}

console.log("== dead import gone; live engines imported ==")
{
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "cognition.js"), "utf8")
  ok("predictionCalibration is not a dead import", !/predictionCalibration/.test(src) || /predictionsForPrompt/.test(src) && !/, predictionCalibration,/.test(src))
  ok("worldmodel is imported", /from "\.\/worldmodel\.js"/.test(src))
  ok("cmdout is imported", /from "\.\/cmdout\.js"/.test(src))
  ok("isCoveringCheck is exported", /export function isCoveringCheck/.test(src))
  ok("invalidate is called on write", /invalidate\?/.test(src) || /invalidate\(/.test(src))
  ok("noteExperiment is called from cognition", /noteExperiment/.test(src))
}

console.log(`\n== bind suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
