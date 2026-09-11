#!/usr/bin/env node
/**
 * forge — Ω layer (classifier, hypothesis, evidence, impact, cmdout, HUD).
 * Isolated FORGE_HOME, zero network. Every check is a real call into the
 * shipped modules — no mocks of the classifier, no fake exit codes.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-omega-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

const {
  classifyTask, classifyTaskComplexity, resolveEffort, synthesizePlan,
  TASK_CLASS, strategyFor,
} = await import("../forge/classify.js")
const { createHypothesisEngine, HSTATUS } = await import("../forge/hypothesis.js")
const { KIND, fact, inference, verified, isStale, markStale, createEvidenceLog } = await import("../forge/evidence.js")
const { impactRadius, testingScope, parseImports } = await import("../forge/impact.js")
const {
  createCommandResult, formatCommandResult, summarizeCommand,
  parseTestCounts, extractFirstFailure, parseCommandResult,
} = await import("../forge/cmdout.js")
const { createKernel, omegaBanner } = await import("../forge/omega.js")
const { classifyFailure, recoveryPlan, FAILURE, STRATEGY } = await import("../forge/diagnose.js")
const { validatePlan, repairPlan, buildDAG } = await import("../forge/dag.js")
const { renderOmegaPanel, renderOptions, displayWidth, stripAnsi } = await import("../forge/render.js")
const { reduce, initialState } = await import("../forge/uistate.js")
const { classifyTaskComplexity: fromAgent, resolveEffort: effortFromAgent } = await import("../forge/agent.js")
const { VERSION } = await import("../forge/version.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + extra : ""}`) }
}

console.log("== classify (Ω + legacy) ==")
{
  ok("typo is MICRO", classifyTask("fix a typo in README").class === TASK_CLASS.MICRO)
  ok("what-is is MICRO/trivial", classifyTask("what is this file").class === TASK_CLASS.MICRO && classifyTask("what is this file").legacy === "trivial")
  ok("rename is trivial/MICRO", classifyTaskComplexity("rename this variable") === "trivial")
  ok("short imperative is SMALL/simple", classifyTask("add a log line").class === TASK_CLASS.SMALL)
  ok("security audit is LARGE (critical, not architecture)", classifyTask("audit the auth layer for a security vulnerability").class === TASK_CLASS.LARGE)
  ok("architecture rewrite is ARCHITECTURAL", classifyTask("rewrite the architecture of the auth layer").class === TASK_CLASS.ARCHITECTURAL)
  ok("legacy critical still critical", classifyTaskComplexity("audit the auth layer for a security vulnerability") === "critical")
  ok("multi-signal refactor is critical", classifyTaskComplexity("refactor the database schema and fix the failing test suite") === "critical")
  ok("empty does not throw", ["trivial", "simple"].includes(classifyTaskComplexity("")))
  ok("agent.js re-exports the same classifier", fromAgent("what is this file") === classifyTaskComplexity("what is this file"))
  ok("agent.js re-exports resolveEffort", effortFromAgent("auto", "what is this file").deep === false)
  ok("MICRO strategy synthesises a plan", strategyFor(TASK_CLASS.MICRO).plan === "synthesize")
  ok("MICRO uses 0 workers", strategyFor(TASK_CLASS.MICRO).workers === 0)
  ok("ARCHITECTURAL is deep + review", strategyFor(TASK_CLASS.ARCHITECTURAL).deep === true && strategyFor(TASK_CLASS.ARCHITECTURAL).requireReview === true)
  ok("LARGE is not used for a typo", classifyTask("fix a one line typo").strategy.plan === "synthesize")
}

console.log("== synthesizePlan is a valid DAG ==")
{
  const micro = synthesizePlan("fix the typo in main.js", TASK_CLASS.MICRO)
  const v = validatePlan(micro)
  ok("MICRO plan validates", v.ok === true, v.errors && v.errors.join("; "))
  ok("MICRO is one node", micro.length === 1 && micro[0].id === "do")
  const g = buildDAG(micro)
  ok("MICRO DAG builds", g.nodes instanceof Map && g.nodes.size === 1 && Array.isArray(g.order) && g.order.length === 1)
  const small = synthesizePlan("add a log line", TASK_CLASS.SMALL)
  const vs = validatePlan(small)
  ok("SMALL plan validates", vs.ok === true, vs.errors && vs.errors.join("; "))
  ok("SMALL is inspect→patch→verify", small.map((n) => n.id).join(",") === "inspect,patch,verify")
  const repaired = repairPlan(micro, "fix the typo")
  ok("repairPlan accepts a synthesised MICRO plan", repaired.ok === true)
}

console.log("== hypothesis engine ==")
{
  const h = createHypothesisEngine()
  const a = h.add({ description: "missing export in auth.js", confidence: 0.4 })
  ok("starts OPEN", a.status === HSTATUS.OPEN)
  h.support(a.id, { text: "grep found no export" })
  ok("support → SUPPORTED", h.get(a.id).status === HSTATUS.SUPPORTED)
  ok("confidence rose", h.get(a.id).confidence > 0.4)
  h.contradict(a.id, { text: "export exists on line 12" })
  ok("strong contradict → REJECTED", h.get(a.id).status === HSTATUS.REJECTED)
  const b = h.add({ description: "wrong timeout value", confidence: 0.6 })
  h.recordTest(b.id, { name: "run login.test.js", result: "fail" })
  h.recordTest(b.id, { name: "run login.test.js", result: "fail" })
  ok("same test twice is a loop", h.looping(b.id, "run login.test.js") === true)
  ok("a different test is not a loop", h.looping(b.id, "run other.test.js") === false)
  h.confirm(b.id)
  ok("CONFIRMED sticks", h.get(b.id).status === HSTATUS.CONFIRMED)
  h.reject(b.id) // already confirmed — confirm() should have blocked reject? we allow reject to override? Our reject() always sets REJECTED.
  // documented: reject after confirm is allowed only if we didn't guard. We DID NOT guard confirm against later reject except contradict().
  // reject() currently always sets REJECTED. That's OK for "we were wrong".
  const c = h.add({ description: "stale cache", confidence: 0.5 })
  h.stale(c.id)
  ok("stale parked", h.get(c.id).status === HSTATUS.STALE)
  const d = h.add({ description: "confirmed cause", confidence: 0.8 })
  h.confirm(d.id)
  h.stale(d.id)
  ok("CONFIRMED is not stale-able", h.get(d.id).status === HSTATUS.CONFIRMED)
  ok("rank skips REJECTED/STALE/CONFIRMED", h.rank().every((x) => x.status === HSTATUS.OPEN || x.status === HSTATUS.SUPPORTED))
}

console.log("== evidence ==")
{
  const f = fact("tests passed", { source: "bash", files: ["src/a.js"], asOf: 1000 })
  ok("FACT kind", f.kind === KIND.FACT && f.confidence === 1)
  ok("not stale before write", isStale(f, { "src/a.js": 999 }) === false)
  ok("stale after write", isStale(f, { "src/a.js": 1001 }) === true)
  ok("unrelated write does not stale", isStale(f, { "src/b.js": 5000 }) === false)
  const log = createEvidenceLog()
  log.record(f)
  log.record(inference("timeout too low", { files: ["src/a.js"], asOf: 1000 }))
  log.invalidate({ "src/a.js": 2000 })
  ok("invalidate flips covering facts to STALE", log.snapshot().every((e) => e.kind === KIND.STALE))
  ok("verified has confidence 1", verified("ok", { source: "test" }).confidence === 1)
}

console.log("== impact radius ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-impact-"))
  fs.writeFileSync(path.join(dir, "util.js"), "export function add(a,b){return a+b}\n")
  fs.writeFileSync(path.join(dir, "app.js"), "import { add } from './util.js'\nadd(1,2)\n")
  fs.mkdirSync(path.join(dir, "tests"))
  fs.writeFileSync(path.join(dir, "tests", "util.test.js"), "import { add } from '../util.js'\n")
  const r = impactRadius({ files: [path.join(dir, "util.js")], cwd: dir })
  ok("finds the importer", r.importers.some((p) => /app\.js$/.test(p)))
  ok("finds the test", r.tests.some((p) => /util\.test/.test(p)))
  ok("scope includes focused_test", r.scope.includes("focused_test"))
  ok("leaf file stays small", testingScope({ files: 1, importers: 0, tests: 0, radius: 1 }).includes("syntax"))
  ok("wide blast radius asks for regression", testingScope({ files: 8, importers: 25, tests: 10, radius: 40 }).includes("regression_test"))
  ok("parseImports handles ESM", parseImports("import x from './a.js'\n", "src/b.js").some((s) => /a\.js$/.test(s)))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log("== command results ==")
{
  const huge = "ok\n".repeat(8000) + "Error: expected 401, received 500\n" + "FAIL src/auth/login.test.ts:82\n"
  const rec = createCommandResult({
    command: "npm test",
    exitCode: 1,
    stdout: huge,
    durationMs: 4200,
    truncated: true,
  })
  ok("failed command is not ok", rec.ok === false)
  ok("exitCode is 1, not inferred 0", rec.exitCode === 1)
  const formatted = formatCommandResult(rec, { max: 800 })
  ok("exit marker survives truncation", /\[exit code: 1\]\s*$/.test(formatted))
  ok("body is capped", formatted.length < huge.length)
  const counts = parseTestCounts("3 failed / 184 passed\n")
  ok("parses failed/passed", counts && counts.failed === 3 && counts.passed === 184)
  const first = extractFirstFailure(huge)
  ok("first failure names the file", /login\.test\.ts:82/.test(first) || /expected 401/.test(first))
  const sum = summarizeCommand(rec)
  ok("summary is short", sum.summary.join("\n").length < 800)
  ok("summary is not a pass", sum.ok === false)
  const timed = formatCommandResult(createCommandResult({ timedOut: true, timeoutSec: 5, durationMs: 5000, stdout: "hanging" }))
  ok("timeout marker is 124", /\[exit code: 124\]/.test(timed) && /timed out after 5s/.test(timed))
  const parsed = parseCommandResult("hello\n[exit code: 3]")
  ok("parse round-trips exit", parsed.exitCode === 3 && parsed.ok === false)
  const good = createCommandResult({ exitCode: 0, stdout: "ok" })
  ok("exit 0 is ok", good.ok === true)
}

console.log("== real bash via cmdout (authoritative process result) ==")
{
  const r = spawnSync(process.execPath, ["-e", "console.log('hi'); process.exit(7)"], { encoding: "utf8" })
  const rec = createCommandResult({
    command: "node -e",
    exitCode: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    durationMs: 1,
  })
  ok("real non-zero is not success", rec.ok === false && rec.exitCode === 7)
  ok("stdout captured", /hi/.test(rec.stdout))
  const fmt = formatCommandResult(rec)
  ok("real failure keeps marker", /\[exit code: 7\]/.test(fmt))
}

console.log("== diagnose extras ==")
{
  ok("TypeError is TYPE", classifyFailure("ERROR: TypeError: x is not a function", { tool: "bash", exitCode: 1 }).code === FAILURE.TYPE_FAILURE)
  ok("ENOSPC is ENVIRONMENT", classifyFailure("ERROR: ENOSPC: no space left on device", { thrown: true }).code === FAILURE.ENVIRONMENT_FAILURE)
  ok("heap OOM is PERFORMANCE", classifyFailure("ERROR: JavaScript heap out of memory", { thrown: true }).code === FAILURE.PERFORMANCE_FAILURE)
  ok("deadlock is CONCURRENCY", classifyFailure("ERROR: deadlock detected", { thrown: true }).code === FAILURE.CONCURRENCY_FAILURE)
  ok("SyntaxError stays SYNTAX", classifyFailure("ERROR: SyntaxError: Unexpected token '}'", { tool: "bash" }).code === FAILURE.SYNTAX_FAILURE)
  ok("unknown tool stays INVALID_ARGUMENT", classifyFailure('ERROR: unknown tool "banana"', { tool: "banana" }).code === FAILURE.INVALID_ARGUMENT)
  ok("plugin crash is TOOL", classifyFailure("ERROR: plugin crashed: at_net.mjs", { thrown: true }).code === FAILURE.TOOL_FAILURE)
  ok("TYPE inspects first", recoveryPlan(FAILURE.TYPE_FAILURE).strategies[0].action === STRATEGY.INSPECT_FIRST)
  ok("CONCURRENCY does not retry first", recoveryPlan(FAILURE.CONCURRENCY_FAILURE).strategies[0].action !== STRATEGY.RETRY)
  ok("TOOL_FAILURE aborts looping a crashed plugin", recoveryPlan(FAILURE.TOOL_FAILURE).strategies.some((s) => s.action === STRATEGY.ABORT))
  ok("ENVIRONMENT escalates", recoveryPlan(FAILURE.ENVIRONMENT_FAILURE).strategies.some((s) => s.action === STRATEGY.ESCALATE))
}

console.log("== Ω kernel ==")
{
  const k = createKernel({ cwd: HOME })
  const c = k.classify("fix a typo in notes.txt")
  ok("kernel classifies MICRO", c.class === TASK_CLASS.MICRO)
  const plan = k.planFor("fix a typo in notes.txt")
  ok("kernel synthesises MICRO plan", Array.isArray(plan) && plan.length === 1)
  const obs = k.observeCommand("ERROR: SyntaxError: Unexpected token", { tool: "bash", exitCode: 1 })
  ok("observation opens a hypothesis", obs.hypothesis && obs.diagnosis.failed)
  ok("next repair points at it", k.nextRepair().hypothesis?.id === obs.hypothesis.id)
  k.rejectCause(obs.hypothesis.id, "not a syntax error")
  ok("rejected cause is gone from rank", !k.hypotheses.rank().some((h) => h.id === obs.hypothesis.id))
  const loopH = k.hypotheses.add({ description: "wrong flag", confidence: 0.6 })
  k.hypotheses.recordTest(loopH.id, { name: "repair-pass", result: "fail" })
  k.hypotheses.recordTest(loopH.id, { name: "repair-pass", result: "fail" })
  ok("kernel escalates a looping repair", k.nextRepair().action === "escalate")
  const smallPlan = k.planFor("add a log line")
  ok("kernel synthesises SMALL plan", Array.isArray(smallPlan) && smallPlan.length === 3)
  ok("banner keeps forge v prefix", omegaBanner("23.0.0").startsWith("forge v23.0.0"))
}

console.log("== Ω HUD is width-safe ==")
{
  const o = renderOptions({ now: 1_700_000_000_000 })
  let s = initialState({ mode: "agent", cwd: "/tmp/my-app", provider: "openai", model: "gpt-4o" })
  s = reduce(s, { type: "TASK_STARTED", id: "run-1", title: "Fix authentication timeout", startedAt: 1_700_000_000_000 - 8400 })
  s = reduce(s, { type: "TASK_CLASSIFIED", class: "MEDIUM", legacy: "moderate", workflow: ["inspect", "plan", "implement"] })
  s = reduce(s, { type: "PLAN_UPDATED", items: [
    { text: "inspect auth flow", status: "done" },
    { text: "identify timeout source", status: "done" },
    { text: "patch implementation", status: "doing" },
    { text: "run regression tests", status: "todo" },
  ] })
  s = reduce(s, { type: "TOOL_STARTED", id: "t1", name: "read_file", target: "src/auth/client.ts" })
  s = { ...s, state: "EXECUTING" }
  for (const w of [20, 40, 48, 80, 120]) {
    const lines = renderOmegaPanel(s, w, o)
    const wide = lines.filter((l) => displayWidth(l) > w)
    ok(`HUD @${w} never overflows (${lines.length} lines)`, wide.length === 0, wide[0])
    ok(`HUD @${w} has content`, lines.some((l) => /FORGE/.test(stripAnsi(l))))
  }
  const arabic = renderOmegaPanel({ ...s, task: { ...s.task, title: "إصلاح مهلة المصادقة" } }, 40, o)
  ok("Arabic title does not overflow 40", arabic.every((l) => displayWidth(l) <= 40))
  const ku = renderOmegaPanel({ ...s, task: { ...s.task, title: "چاککردنی کاتی چاوەڕوانی" } }, 40, o)
  ok("Kurdish title does not overflow 40", ku.every((l) => displayWidth(l) <= 40))
  const de = renderOmegaPanel({ ...s, task: { ...s.task, title: "Authentifizierungs-Zeitüberschreitung beheben" } }, 40, o)
  ok("German title does not overflow 40", de.every((l) => displayWidth(l) <= 40))
  const ascii = renderOmegaPanel(s, 80, renderOptions({ ascii: true, now: o.now }))
  ok("ascii dialect has no box drawing", ascii.every((l) => !/[╭╮╰╯│]/.test(l)))
  const a11y = renderOmegaPanel(s, 80, renderOptions({ a11y: true, now: o.now }))
  ok("a11y dialect has no box drawing", a11y.every((l) => !/[╭╮╰╯│]/.test(l)))
}

console.log("== package version ==")
{
  ok("VERSION is 61.0.0", VERSION === "61.0.0")
}

console.log(`\n== omega suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
