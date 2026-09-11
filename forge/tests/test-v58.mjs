#!/usr/bin/env node
/**
 * forge — v58 skilllife: learned skills are CANDIDATE until verified.
 *
 * First authorSkill is CANDIDATE. Second 9/9 evolveRun (deduped) is
 * VERIFIED. Does not: write ~/.forge/tools, flip assumeYes, dump the
 * pack, change classifyTaskComplexity(), invent a second data root.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v58-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v58-work-"))
process.chdir(WORK)

const {
  authorSkill, evolveRun, recordSkillOutcome, loadSkillLife, skillLifePath,
  skillLifecycle, SKILL_LIFE, learnedSkillsDir,
} = await import("../evolve.js")
const { pickSkills } = await import("../skillforge.js")
const { formatSteer, evaluateSkills } = await import("../evaluate.js")
const { compose, formatCompose } = await import("../compose.js")
const { recordLesson } = await import("../lessons.js")
const { ALL_CHECKS } = await import("../completion.js")
const { classifyTaskComplexity, classifyTask, TASK_CLASS } = await import("../classify.js")
const { defaultConfig, sanitizeProjectConfig } = await import("../config.js")
const { VERSION } = await import("../version.js")
const { CATALOG } = await import("../providers.js")
const { PLUGINS_DIR } = await import("../plugins.js")
const { projectDir } = await import("../memory.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOST = path.join(HERE, "../plugin-host.js")
const BUNDLED = path.join(HERE, "../skills")
const TASK = "debug the failing authentication module in production"

function listGlobalTools() {
  try { return fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")) } catch { return [] }
}

function gateAll(pass = true) {
  const checks = {}
  for (const k of ALL_CHECKS) checks[k] = pass
  return { ok: pass, status: pass ? "COMPLETED" : "REPAIRING", checks, blockers: pass ? [] : [{ check: ALL_CHECKS[0] }] }
}

console.log("== first author is CANDIDATE ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v58-au-"))
  const made = authorSkill({
    cwd: dir, task: TASK, klass: TASK_CLASS.MEDIUM,
    repair: "set the Authorization header on the request", files: ["auth.js"],
  })
  ok("authored", made.ok === true && made.deduped === false, JSON.stringify(made))
  eq("lifecycle CANDIDATE", made.lifecycle, SKILL_LIFE.CANDIDATE)
  const rec = loadSkillLife(dir).skills[made.name]
  eq("store CANDIDATE", rec.lifecycle, SKILL_LIFE.CANDIDATE)
  eq("samples 1", rec.samples, 1)
  const p = skillLifePath(dir)
  ok("under FORGE_HOME project", p.startsWith(projectDir(dir)), p)
  ok("not in user workdir", !p.startsWith(dir), p)
  const mode = (fs.statSync(p).mode & 0o777).toString(8)
  ok("mode 0600-ish", mode === "600" || mode === "400", mode)
  const again = authorSkill({
    cwd: dir, task: TASK, klass: TASK_CLASS.MEDIUM,
    repair: "set the Authorization header on the request",
  })
  eq("deduped still CANDIDATE", again.lifecycle, SKILL_LIFE.CANDIDATE)
  eq("deduped flag", again.deduped, true)
  eq("samples 2", loadSkillLife(dir).skills[made.name].samples, 2)
  eq("MICRO skip", authorSkill({ cwd: dir, task: "fix a typo", klass: TASK_CLASS.MICRO, repair: "x" }).skipped, "micro")
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== second 9/9 evolveRun VERIFIED ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v58-ev-"))
  recordLesson({
    task: TASK, failure: "authentication tests failed",
    cause: "missing token", failedStrategy: "retry",
    successfulRepair: "set the Authorization header on the request",
    files: ["auth.js"], confidence: 0.6,
  }, dir)
  const first = evolveRun({ cwd: dir, task: TASK, klass: TASK_CLASS.MEDIUM, gate: gateAll(true) })
  eq("first CANDIDATE", first.skill.lifecycle, SKILL_LIFE.CANDIDATE)
  eq("first not deduped", first.skill.deduped, false)
  const second = evolveRun({ cwd: dir, task: TASK, klass: TASK_CLASS.MEDIUM, gate: gateAll(true) })
  eq("second VERIFIED", second.skill.lifecycle, SKILL_LIFE.VERIFIED)
  eq("store VERIFIED", skillLifecycle(second.skill.name, dir), SKILL_LIFE.VERIFIED)
  const failed = evolveRun({ cwd: dir, task: TASK, klass: TASK_CLASS.MEDIUM, gate: gateAll(false) })
  eq("failed does not author", failed.skill?.skipped, "not-completed")
  eq("still VERIFIED after fail", skillLifecycle(second.skill.name, dir), SKILL_LIFE.VERIFIED)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== recordSkillOutcome is explicit VERIFIED ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v58-out-"))
  const made = authorSkill({
    cwd: dir, task: TASK, klass: TASK_CLASS.MEDIUM,
    repair: "set the Authorization header on the request",
  })
  recordSkillOutcome({ cwd: dir, name: made.name, status: SKILL_LIFE.VERIFIED })
  eq("explicit VERIFIED", skillLifecycle(made.name, dir), SKILL_LIFE.VERIFIED)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== pickSkills / formatSteer mark candidate ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v58-pk-"))
  const made = authorSkill({
    cwd: dir, task: TASK, klass: TASK_CLASS.MEDIUM,
    repair: "set the Authorization header on the request",
  })
  const picks = pickSkills(TASK, [{ name: made.name, desc: "auth repair", learned: true }], { klass: TASK_CLASS.MEDIUM, cwd: dir })
  ok("pick has lifecycle", picks.some((s) => s.name === made.name && s.lifecycle === SKILL_LIFE.CANDIDATE), JSON.stringify(picks))
  const steer = formatSteer({ skills: picks })
  ok("steer candidate", /candidate/.test(steer), steer)
  eq("empty steer", formatSteer({}), "")
  const fp = pickSkills("debug a crash", [{ name: "forge-debug", desc: "Reproduce, isolate root cause" }], { klass: TASK_CLASS.MEDIUM })
  ok("first-party not candidate", fp.every((s) => s.lifecycle !== SKILL_LIFE.CANDIDATE), JSON.stringify(fp))
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== compose never writes skilllife ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v58-co-"))
  fs.writeFileSync(path.join(dir, "util.js"), "export const x = 1\n")
  compose(TASK, { cwd: dir, includePlugins: false, klass: TASK_CLASS.LARGE })
  ok("no skilllife from compose", !fs.existsSync(skillLifePath(dir)))
  ok("no skills dir from compose", !fs.existsSync(learnedSkillsDir(dir)))
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== source contracts ==")
{
  const evolve = fs.readFileSync(new URL("../evolve.js", import.meta.url), "utf8")
  const composeSrc = fs.readFileSync(new URL("../compose.js", import.meta.url), "utf8")
  const skillforge = fs.readFileSync(new URL("../skillforge.js", import.meta.url), "utf8")
  ok("recordSkillOutcome exported", /export function recordSkillOutcome/.test(evolve))
  ok("recordSkillCandidate exported", /export function recordSkillCandidate/.test(evolve))
  ok("evolve does not import plugins", !/from "\.\/plugins\.js"/.test(evolve))
  ok("compose still no authorSkill", !/authorSkill/.test(composeSrc))
  ok("compose still no recordSkillOutcome", !/recordSkillOutcome/.test(composeSrc))
  ok("pickSkills loads skill life", /loadSkillLife/.test(skillforge))
  ok("evaluateSkills still exported", /export function evaluateSkills/.test(fs.readFileSync(new URL("../evaluate.js", import.meta.url), "utf8")))
}

console.log("== no side writes / frozen kernel + package ==")
{
  const beforeGlobal = listGlobalTools()
  const hostBefore = fs.readFileSync(HOST, "utf8")
  const bundledBefore = fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(",")
  const cfg = defaultConfig()
  eq("assumeYes stays false", cfg.tools.assumeYes, false)
  eq("allowNewPlugins stays false", cfg.tools.allowNewPlugins, false)
  const { dropped } = sanitizeProjectConfig({ tools: { assumeYes: true, allowNewPlugins: true } })
  ok("project cannot flip assumeYes", dropped.includes("tools.assumeYes"))
  eq("classifyTaskComplexity frozen", classifyTaskComplexity("fix a typo"), "trivial")
  eq("typo still MICRO", classifyTask("fix a typo in README").class, TASK_CLASS.MICRO)
  eq("evaluateSkills typo empty", evaluateSkills("fix a typo in README", [{ name: "coding-agent", desc: "Coding workflow with planning" }]).length, 0)
  eq("VERSION is 73.0.0", VERSION, "73.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  eq("package.json is 73.0.0", pkg.version, "73.0.0")
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
  eq("custom is still index 17 (pick 18)", CATALOG[17]?.name, "custom")
  eq("apinex still after custom", CATALOG[18]?.name, "apinex")
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
  eq("bundled pack unchanged", fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(","), bundledBefore)
}

console.log(`\n== v58 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
