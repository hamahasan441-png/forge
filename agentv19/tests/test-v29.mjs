#!/usr/bin/env node
/**
 * forge — v29 information-gain experiments + FORGE-BENCH.
 *
 * Repair picks the next experiment by information gain. FORGE-BENCH is a
 * 12-case deterministic eval with no live model. nextRepair().action is
 * unchanged (Ω/∞). MICRO never gets a full suite. assumeYes stays false.
 *
 * Does not: flip assumeYes, raise block-class, change
 * classifyTaskComplexity(), spawn a second writer, or add a runtime dep.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v29-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v29-work-"))
process.chdir(WORK)

const { informationGain, selectExperiment, rankExperiments, createInfoGainEngine, formatExperiment, XID, XKIND } = await import("../forge/infogain.js")
const { BENCH_CASES, runBench, runCase, formatReport } = await import("../forge/bench.js")
const { createKernel } = await import("../forge/omega.js")
const { FAILURE } = await import("../forge/diagnose.js")
const { ORIGIN } = await import("../forge/selfdiag.js")
const { TASK_CLASS, classifyTaskComplexity, strategyFor } = await import("../forge/classify.js")
const { defaultConfig } = await import("../forge/config.js")
const { VERSION } = await import("../forge/version.js")
const { canCompleteTask } = await import("../forge/completion.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

console.log("== informationGain is finite, cheap inspect beats expensive suite ==")
{
  const cheap = informationGain({ uncertainty: 5, diagnostic: 5, impact: 3, reliability: 4, cost: 1, risk: 1, time: 1 })
  const expensive = informationGain({ uncertainty: 2, diagnostic: 3, impact: 3, reliability: 3, cost: 5, risk: 2, time: 5 })
  ok("cheap gain is finite and positive", Number.isFinite(cheap) && cheap > 0)
  ok("expensive gain is finite", Number.isFinite(expensive))
  ok("cheap inspect beats full suite", cheap > expensive)
  eq("zero-cost cannot inf", Number.isFinite(informationGain({ cost: 0, risk: 0, time: 0, uncertainty: 5 })), true)
  eq("clamps above 5", informationGain({ uncertainty: 99, diagnostic: 99, impact: 99, reliability: 99, cost: 1, risk: 1, time: 1 }), informationGain({ uncertainty: 5, diagnostic: 5, impact: 5, reliability: 5, cost: 1, risk: 1, time: 1 }))
}

console.log("== policy: SAFETY abort, FORGE escalate, looping different_cause ==")
{
  eq("SAFETY_BLOCK aborts", selectExperiment({ code: FAILURE.SAFETY_BLOCK }).id, XID.ABORT)
  eq("FORGE origin escalates", selectExperiment({ origin: { origin: ORIGIN.FORGE, code: FAILURE.TOOL_FAILURE } }).id, XID.ESCALATE)
  eq("looping + escalate → different_cause", selectExperiment({ looping: true, action: "escalate" }).id, XID.DIFFERENT_CAUSE)
  eq("abort is not mutating", selectExperiment({ code: FAILURE.SAFETY_BLOCK }).mutating, false)
  ok("formatExperiment names the id", /abort/.test(formatExperiment(selectExperiment({ code: FAILURE.SAFETY_BLOCK }))))
}

console.log("== ranking: inspect first, no full_suite on MICRO, no mutating without inspect ==")
{
  const syn = rankExperiments({ code: FAILURE.SYNTAX_FAILURE, klass: TASK_CLASS.MEDIUM })
  ok("syntax has candidates", syn.length >= 2)
  eq("top syntax is read-only", syn[0].mutating, false)
  ok("top syntax is inspect-class", syn[0].kind === XKIND.INSPECT || syn[0].id === XID.READ_STACK || syn[0].id === XID.INSPECT_FILE)
  ok("minimal_fix is not first for a fresh syntax error", syn[0].id !== XID.MINIMAL_FIX)
  ok("full_suite not in MICRO rank", !rankExperiments({ code: FAILURE.TEST_FAILURE, klass: TASK_CLASS.MICRO }).some((r) => r.id === XID.FULL_SUITE))
  ok("full_suite not in SMALL rank", !rankExperiments({ code: FAILURE.TEST_FAILURE, klass: TASK_CLASS.SMALL }).some((r) => r.id === XID.FULL_SUITE))
  const med = rankExperiments({ code: FAILURE.TEST_FAILURE, klass: TASK_CLASS.MEDIUM })
  ok("full_suite not in MEDIUM either (class gate)", !med.some((r) => r.id === XID.FULL_SUITE))
  const net = selectExperiment({ code: FAILURE.NETWORK_FAILURE, origin: { origin: ORIGIN.UNKNOWN } })
  ok("network does not pick a project edit", net.id !== XID.MINIMAL_FIX && net.id !== XID.INSTALL_DEP)
}

console.log("== engine: tried-twice is excluded; tried-once is penalised ==")
{
  const eng = createInfoGainEngine()
  const first = eng.select({ code: FAILURE.SYNTAX_FAILURE, klass: TASK_CLASS.MEDIUM })
  eq("fresh pick is read_stack or inspect", [XID.READ_STACK, XID.INSPECT_FILE].includes(first.id), true)
  eng.record(first.id, "insufficient")
  const second = eng.select({ code: FAILURE.SYNTAX_FAILURE, klass: TASK_CLASS.MEDIUM })
  ok("after one try, a different experiment can win", second.id !== first.id || second.gain < first.gain)
  eng.record(first.id, "insufficient")
  eq("looping(id) after two records", eng.looping(first.id), true)
  const third = eng.select({ code: FAILURE.SYNTAX_FAILURE, klass: TASK_CLASS.MEDIUM })
  ok("tried-twice id is not picked again", third.id !== first.id)
  ok("avoided lists it", third.avoided.includes(first.id))
  eq("engine size is 2", eng.size(), 2)
}

console.log("== Ω kernel: nextRepair.action frozen; experiment is additive ==")
{
  const k = createKernel({ cwd: WORK })
  k.classify("fix a typo in notes.txt")
  const obs = k.observeCommand("ERROR: SyntaxError: Unexpected token", { tool: "bash", exitCode: 1 })
  const next = k.nextRepair()
  eq("hypothesis still pointed at", next.hypothesis?.id, obs.hypothesis.id)
  ok("experiment is attached", next.experiment && typeof next.experiment.id === "string")
  ok("experiment is not mutating first", next.experiment.mutating === false)
  k.noteExperiment(next.experiment.id, "fail")
  ok("kernel infogain recorded it", k.infogain.size() >= 1)

  const k2 = createKernel({ cwd: WORK })
  k2.observeCommand("ERROR: plugin crashed: at_net.mjs", { thrown: true })
  eq("FORGE origin still escalates action", k2.nextRepair().action, "escalate")
  eq("FORGE experiment is escalate", k2.nextRepair().experiment.id, XID.ESCALATE)

  const k3 = createKernel({ cwd: WORK })
  k3.observeCommand("ERROR: SyntaxError: Unexpected token", { tool: "bash", exitCode: 1 })
  const loopH = k3.hypotheses.add({ description: "wrong flag", confidence: 0.9 })
  k3.hypotheses.recordTest(loopH.id, { name: "repair-pass", result: "fail" })
  k3.hypotheses.recordTest(loopH.id, { name: "repair-pass", result: "fail" })
  eq("looping repair still escalates action", k3.nextRepair().action, "escalate")
  eq("looping experiment is different_cause", k3.nextRepair().experiment.id, XID.DIFFERENT_CAUSE)
}

console.log("== FORGE-BENCH 12/12, no live model ==")
{
  eq("12 cases", BENCH_CASES.length, 12)
  const summary = runBench()
  eq("bench total 12", summary.total, 12)
  eq("bench failed 0", summary.failed, 0)
  ok("score is 100", summary.score === 100)
  ok("every case ok", summary.results.every((r) => r.ok))
  const ids = summary.results.map((r) => r.id)
  ok("ladder starts at simple bug", ids[0] === "01-simple-bug")
  ok("ladder ends at long-running", ids[11] === "12-long-running")
  const report = formatReport(summary)
  ok("report names FORGE-BENCH", /FORGE-BENCH/.test(report))
  ok("tokens metric is 0 (no model)", summary.results.every((r) => r.got.tokens === 0))

  const recov = runCase(BENCH_CASES.find((c) => c.id === "10-crash-recovery"))
  eq("crash recovery is RECOVERY class", recov.got.class, TASK_CLASS.RECOVERY)
  const arch = runCase(BENCH_CASES.find((c) => c.id === "06-architecture"))
  ok("architecture has workers", arch.got.workers >= 1)
  eq("MICRO still 0 workers", strategyFor(TASK_CLASS.MICRO).workers, 0)
  const long = runCase(BENCH_CASES.find((c) => c.id === "12-long-running"))
  eq("long-running is not COMPLETED", long.got.completed, false)
  eq("long-running replan kept completed", long.got.replanKept, true)
}

console.log("== 9-check gate still refuses false completion ==")
{
  const gate = canCompleteTask({
    planValid: true, dag: null, requireDAG: true,
    verification: { ok: true }, verificationRequired: true,
  })
  eq("no DAG is not COMPLETED", gate.ok, false)
}

console.log("== CLI: forge bench --list / --json ==")
{
  const forge = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "forge", "forge.js")
  const env = { ...process.env, FORGE_HOME: HOME, NO_COLOR: "1" }
  const list = execFileSync("node", [forge, "bench", "--list", "--json"], { env, encoding: "utf8" })
  const parsed = JSON.parse(list)
  eq("list json has 12 cases", parsed.cases.length, 12)
  const run = execFileSync("node", [forge, "bench", "--json"], { env, encoding: "utf8" })
  const ran = JSON.parse(run)
  eq("run json passed 12", ran.passed, 12)
  eq("run json failed 0", ran.failed, 0)
}

console.log("== safety + wiring (source) ==")
{
  const meta = fs.readFileSync(new URL("../forge/meta.js", import.meta.url), "utf8")
  ok("meta emits EXPERIMENT_SELECTED", /EXPERIMENT_SELECTED/.test(meta))
  ok("meta calls noteExperiment", /noteExperiment/.test(meta))
  ok("meta still filters read_only non-coder workers", /n\.read_only && n\.role && n\.role !== "coder"/.test(meta))
  const omega = fs.readFileSync(new URL("../forge/omega.js", import.meta.url), "utf8")
  ok("omega imports infogain", /createInfoGainEngine/.test(omega))
  ok("classifyTaskComplexity is frozen (typo still trivial)", classifyTaskComplexity("fix a typo") === "trivial")
  const cfg = defaultConfig()
  eq("assumeYes stays false", cfg.tools.assumeYes, false)
  eq("allowSudo stays false", cfg.tools.allowSudo, false)
  eq("allowInterpreterEval stays false", cfg.tools.allowInterpreterEval, false)
}

console.log("== package version ==")
{
  eq("VERSION is 48.0.0", VERSION, "48.0.0")
  eq("package.json is 48.0.0", JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8")).version, "48.0.0")
}

console.log(`\n== v29 suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
