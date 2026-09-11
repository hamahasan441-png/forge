#!/usr/bin/env node
/**
 * forge — ∞ layer (causal, self-diag, task model, review, telemetry, RECOVERY).
 * Isolated FORGE_HOME, zero network. Real calls into shipped modules.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-inf-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

const {
  classifyTask, classifyTaskComplexity, TASK_CLASS, strategyFor, synthesizePlan,
} = await import("../forge/classify.js")
const { createCausalEngine, counterfactual, LAYER, LSTATUS } = await import("../forge/causal.js")
const { classifyOrigin, formatOrigin, ORIGIN } = await import("../forge/selfdiag.js")
const { createTaskModel, seedFromObjective, TAG } = await import("../forge/taskmodel.js")
const { adversarialReview, needsReview, REVIEW_CHECK } = await import("../forge/review.js")
const { createTelemetry, METRIC } = await import("../forge/telemetry.js")
const { createKernel, omegaBanner } = await import("../forge/omega.js")
const { classifyFailure, recoveryPlan, FAILURE, STRATEGY } = await import("../forge/diagnose.js")
const { renderOmegaPanel, renderOptions, displayWidth, stripAnsi } = await import("../forge/render.js")
const { reduce, initialState } = await import("../forge/uistate.js")
const { VERSION } = await import("../forge/version.js")
const { impactRadius } = await import("../forge/impact.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + extra : ""}`) }
}

console.log("== RECOVERY class does not steal MICRO ==")
{
  ok("typo stays MICRO", classifyTask("fix a typo in README").class === TASK_CLASS.MICRO)
  ok("resume of a typo is RECOVERY", classifyTask("fix a typo in README", { resume: true }).class === TASK_CLASS.RECOVERY)
  ok("resume keeps underlying MICRO", classifyTask("fix a typo in README", { resume: true }).underlying === TASK_CLASS.MICRO)
  ok("legacy scoring is frozen", classifyTaskComplexity("fix a typo in README") === "trivial")
  ok("resume does not change legacy score", classifyTask("fix a typo in README", { resume: true }).legacy === "trivial")
  ok("RECOVERY strategy restores, no review", strategyFor(TASK_CLASS.RECOVERY).plan === "restore" && strategyFor(TASK_CLASS.RECOVERY).requireReview === false)
  ok("RECOVERY workflow starts with recover", strategyFor(TASK_CLASS.RECOVERY).workflow[0] === "recover")
  ok("architecture rewrite is still ARCHITECTURAL", classifyTask("rewrite the architecture of the auth layer").class === TASK_CLASS.ARCHITECTURAL)
  ok("resume of architecture is RECOVERY not ARCH", classifyTask("rewrite the architecture of the auth layer", { resume: true }).class === TASK_CLASS.RECOVERY)
  ok("MICRO still synthesises", synthesizePlan("fix typo", TASK_CLASS.MICRO).length === 1)
}

console.log("== causal engine ==")
{
  const c = createCausalEngine()
  const obs = c.observe("ERROR: 3 tests failed", { tool: "bash", exitCode: 1 })
  ok("test failure is a SYMPTOM", obs.symptom && obs.symptom.layer === LAYER.SYMPTOM)
  ok("test failure does not invent a ROOT", !obs.proposed || obs.proposed.layer === LAYER.SYMPTOM)
  const dep = c.observe("ERROR: Cannot find module 'left-pad'", { tool: "bash", exitCode: 1 })
  ok("missing module proposes ROOT", dep.proposed && dep.proposed.layer === LAYER.ROOT)
  c.confirm(dep.proposed.id)
  const t = c.nextTarget()
  ok("next target prefers confirmed ROOT", t.layer === LAYER.ROOT && t.node.id === dep.proposed.id)
  c.reject(dep.proposed.id, "was a transitive, not the cause")
  const t2 = c.nextTarget()
  ok("rejected ROOT is not the next target", !t2.node || t2.node.id !== dep.proposed.id)
  const chain = c.chain()
  ok("chain exposes contributing as an array", Array.isArray(chain.contributing) && Array.isArray(chain.secondary))
}

console.log("== counterfactual from impact ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cf-"))
  fs.writeFileSync(path.join(dir, "util.js"), "export function add(a,b){return a+b}\n")
  fs.writeFileSync(path.join(dir, "app.js"), "import { add } from './util.js'\nadd(1,2)\n")
  fs.mkdirSync(path.join(dir, "tests"))
  fs.writeFileSync(path.join(dir, "tests", "util.test.js"), "import { add } from '../util.js'\n")
  const r = impactRadius({ files: [path.join(dir, "util.js")], cwd: dir })
  const cf = counterfactual(r, { root: "wrong export" })
  ok("ifFixed names the edited file", cf.ifFixed.some((p) => /util\.js$/.test(p)))
  ok("stillAtRisk includes importers or tests", cf.stillAtRisk.length >= 1)
  ok("unknown is not claimed on a real walk", cf.unknown === false)
  ok("empty impact is UNKNOWN", counterfactual({ files: [], unknown: true }).unknown === true)
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log("== self-diagnostics PROJECT vs FORGE ==")
{
  const proj = classifyOrigin("ERROR: SyntaxError: Unexpected token '}'", { tool: "bash", exitCode: 1 })
  ok("syntax is PROJECT", proj.origin === ORIGIN.PROJECT)
  const plugin = classifyOrigin("ERROR: plugin crashed: at_net.mjs", { thrown: true })
  ok("plugin crash is FORGE", plugin.origin === ORIGIN.FORGE)
  const safety = classifyOrigin("BLOCKED: write tools are disabled", { tool: "write_file" })
  ok("safety block is FORGE (do not patch around it)", safety.origin === ORIGIN.FORGE)
  const banana = classifyOrigin('ERROR: unknown tool "banana"', { tool: "banana" })
  ok("unknown tool stays a project-side argument error, not TOOL_FAILURE", banana.code === FAILURE.INVALID_ARGUMENT)
  ok("unknown tool is not FORGE origin", banana.origin !== ORIGIN.FORGE)
  ok("FORGE hint tells the repairer not to edit the project", /Do NOT edit/.test(formatOrigin(plugin)))
}

console.log("== task model: never promote assumption → requirement ==")
{
  const m = seedFromObjective("add a log line")
  ok("objective is a REQUIREMENT", m.requirements().length === 1 && m.requirements()[0].tag === TAG.REQUIREMENT)
  const a = m.add({ tag: TAG.ASSUMPTION, text: "the logger is winston", source: "guess" })
  const blocked = m.promote(a.id, TAG.REQUIREMENT)
  ok("assumption cannot become a requirement", blocked.ok === false && /never promote/.test(blocked.reason))
  ok("tag stayed ASSUMPTION", m.get(a.id).tag === TAG.ASSUMPTION)
  const toFact = m.promote(a.id, TAG.FACT)
  ok("assumption may become a FACT once observed", toFact.ok === true && m.get(a.id).tag === TAG.FACT)
  const req = m.requirements()[0]
  const down = m.promote(req.id, TAG.ASSUMPTION)
  ok("a requirement cannot be demoted", down.ok === false)
}

console.log("== adversarial review is a checklist, not a model call ==")
{
  ok("MICRO does not require review", needsReview(TASK_CLASS.MICRO) === false)
  ok("SMALL does not require review", needsReview(TASK_CLASS.SMALL) === false)
  ok("LARGE requires review", needsReview(TASK_CLASS.LARGE) === true)
  ok("ARCHITECTURAL requires review", needsReview(TASK_CLASS.ARCHITECTURAL) === true)
  ok("RECOVERY does not require review", needsReview(TASK_CLASS.RECOVERY) === false)
  const skip = adversarialReview({ klass: TASK_CLASS.MICRO, objective: "typo" })
  ok("MICRO review is a no-op", skip.required === false && skip.ok === true)
  const secrets = adversarialReview({
    klass: TASK_CLASS.LARGE,
    objective: "rotate keys",
    files: [".env", "src/auth.js"],
    impact: { files: [".env"], importers: [], tests: [], scope: ["syntax"], radius: 1 },
  })
  ok("touching .env is a blocker", secrets.ok === false && secrets.blockers.some((b) => b.id === REVIEW_CHECK.SECRETS_UNTOUCHED))
  const tm = createTaskModel()
  tm.add({ tag: TAG.ASSUMPTION, text: "the API must return 200 as an acceptance criterion", source: "guess" })
  const smug = adversarialReview({ klass: TASK_CLASS.LARGE, objective: "fix login", files: ["src/a.js"], taskModel: tm, impact: { files: ["src/a.js"], tests: ["a.test.js"], scope: ["focused_test"], radius: 2 } })
  ok("assumption spoken as a requirement is a blocker", smug.blockers.some((b) => b.id === REVIEW_CHECK.NO_ASSUMPTION_AS_REQUIREMENT))
  const clean = adversarialReview({
    klass: TASK_CLASS.LARGE,
    objective: "fix login timeout",
    files: ["src/auth.js"],
    impact: { files: ["src/auth.js"], importers: ["src/app.js"], tests: ["auth.test.js"], scope: ["syntax", "focused_test"], radius: 3, unknown: false },
    verificationOk: true,
  })
  ok("a clean LARGE review passes", clean.ok === true && clean.required === true)
}

console.log("== extra diagnose codes do not steal ==")
{
  ok("TypeError stays TYPE", classifyFailure("ERROR: TypeError: x is not a function", { tool: "bash", exitCode: 1 }).code === FAILURE.TYPE_FAILURE)
  ok("SyntaxError stays SYNTAX", classifyFailure("ERROR: SyntaxError: Unexpected token '}'", { tool: "bash" }).code === FAILURE.SYNTAX_FAILURE)
  ok("unknown tool stays INVALID_ARGUMENT", classifyFailure('ERROR: unknown tool "banana"', { tool: "banana" }).code === FAILURE.INVALID_ARGUMENT)
  ok("plugin crash stays TOOL", classifyFailure("ERROR: plugin crashed: at_net.mjs", { thrown: true }).code === FAILURE.TOOL_FAILURE)
  ok("3 tests failed stays TEST", classifyFailure("ERROR: 3 tests failed", { tool: "bash", exitCode: 1 }).code === FAILURE.TEST_FAILURE)
  ok("invalid config is CONFIGURATION", classifyFailure("ERROR: invalid config: missing host", { thrown: true }).code === FAILURE.CONFIGURATION_FAILURE)
  ok("uncaught exception is RUNTIME", classifyFailure("ERROR: uncaught exception: boom", { thrown: true }).code === FAILURE.RUNTIME_FAILURE)
  ok("502 Bad Gateway is INTEGRATION", classifyFailure("ERROR: 502 Bad Gateway from payments API", { tool: "bash", exitCode: 1 }).code === FAILURE.INTEGRATION_FAILURE)
  ok("CONFIGURATION inspects first", recoveryPlan(FAILURE.CONFIGURATION_FAILURE).strategies[0].action === STRATEGY.INSPECT_FIRST)
  ok("RUNTIME does not retry first", recoveryPlan(FAILURE.RUNTIME_FAILURE).strategies[0].action !== STRATEGY.RETRY)
  ok("INTEGRATION inspects first", recoveryPlan(FAILURE.INTEGRATION_FAILURE).strategies[0].action === STRATEGY.INSPECT_FIRST)
}

console.log("== telemetry counters ==")
{
  const t = createTelemetry()
  t.inc(METRIC.CLASSIFY)
  t.inc(METRIC.CLASSIFY)
  t.inc(METRIC.ORIGIN_FORGE)
  ok("classify counted twice", t.get(METRIC.CLASSIFY) === 2)
  ok("missing metric is 0", t.get("nope") === 0)
  ok("snapshot is a plain object", t.snapshot()[METRIC.CLASSIFY] === 2 && t.snapshot()[METRIC.ORIGIN_FORGE] === 1)
  t.reset()
  ok("reset clears", t.get(METRIC.CLASSIFY) === 0)
}

console.log("== ∞ kernel ==")
{
  const k = createKernel({ cwd: HOME })
  const c = k.classify("fix a typo in notes.txt")
  ok("kernel still classifies MICRO", c.class === TASK_CLASS.MICRO)
  const rec = k.classify("fix a typo in notes.txt", { resume: true })
  ok("kernel resume is RECOVERY", rec.class === TASK_CLASS.RECOVERY)
  ok("kernel does not synthesise a restore-class plan", k.planFor("fix a typo in notes.txt") === null)
  const k2 = createKernel({ cwd: HOME })
  k2.classify("fix a typo in notes.txt")
  ok("fresh kernel still synthesises MICRO", Array.isArray(k2.planFor("fix a typo in notes.txt")) && k2.planFor("fix a typo in notes.txt").length === 1)
  const obs = k2.observeCommand("ERROR: SyntaxError: Unexpected token", { tool: "bash", exitCode: 1 })
  ok("observation opens a hypothesis", obs.hypothesis && obs.diagnosis.failed)
  ok("origin is PROJECT", obs.origin.origin === ORIGIN.PROJECT)
  ok("next repair points at it", k2.nextRepair().hypothesis?.id === obs.hypothesis.id)
  const forgeObs = k2.observeCommand("ERROR: plugin crashed: at_net.mjs", { thrown: true })
  ok("plugin crash is FORGE origin", forgeObs.origin.origin === ORIGIN.FORGE)
  ok("FORGE origin escalates repair", k2.nextRepair().action === "escalate")
  const rev = k2.review({ klass: TASK_CLASS.LARGE, objective: "fix login", files: ["src/a.js"], verificationOk: true })
  ok("kernel review is local (no throw)", rev && typeof rev.ok === "boolean")
  ok("banner keeps forge v prefix", omegaBanner("23.0.0").startsWith("forge v23.0.0"))
  ok("banner names infinity", omegaBanner("23.0.0").includes("∞"))
  const snap = k2.snapshot()
  ok("snapshot has causal + telemetry", snap.causal && snap.telemetry && typeof snap.telemetry["command.fail"] === "number")
}

console.log("== ∞ HUD stays width-safe ==")
{
  const o = renderOptions({ now: 1_700_000_000_000 })
  let s = initialState({ mode: "agent", cwd: "/tmp/my-app", provider: "openai", model: "gpt-4o" })
  s = reduce(s, { type: "TASK_STARTED", id: "run-1", title: "Fix authentication timeout", startedAt: 1_700_000_000_000 - 8400 })
  ok("TASK_STARTED is still THINKING", s.state === "THINKING")
  s = reduce(s, { type: "TASK_CLASSIFIED", class: "RECOVERY", legacy: "complex", workflow: ["recover", "inspect", "repair"], resume: true })
  s = reduce(s, { type: "CAUSAL_UPDATED", layer: "ROOT", id: "C1", description: "timeout flag too low", reason: "act on root" })
  s = reduce(s, { type: "ORIGIN_CLASSIFIED", origin: "PROJECT", why: "test failure" })
  s = reduce(s, { type: "PLAN_UPDATED", items: [
    { text: "inspect auth flow", status: "done" },
    { text: "patch implementation", status: "doing" },
  ] })
  s = { ...s, state: "REPAIRING" }
  for (const w of [20, 40, 48, 80, 120]) {
    const lines = renderOmegaPanel(s, w, o)
    const wide = lines.filter((l) => displayWidth(l) > w)
    ok(`HUD @${w} never overflows (${lines.length} lines)`, wide.length === 0, wide[0])
    ok(`HUD @${w} has FORGE`, lines.some((l) => /FORGE/.test(stripAnsi(l))))
  }
  const body = renderOmegaPanel(s, 80, o).map((l) => stripAnsi(l)).join("\n")
  ok("HUD shows ∞", /FORGE ∞/.test(body))
  ok("HUD shows cause", /cause/.test(body) && /timeout flag/.test(body))
  ok("HUD shows origin", /origin PROJECT/.test(body))
}

console.log("== package version ==")
{
  ok("VERSION is 61.0.0", VERSION === "61.0.0")
}

console.log(`\n== infinity suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
