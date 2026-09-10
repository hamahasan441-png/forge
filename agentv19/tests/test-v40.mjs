#!/usr/bin/env node
/**
 * forge — v40 strategy evolution (L4).
 *
 * Score the 9-check, hard-avoid failed strategies, promote/demote lessons,
 * author a project-local SKILL.md from a successful repair.
 * Does not: flip assumeYes, add a runtime dep, spawn a second writer,
 * change classifyTaskComplexity(), write into the bundled pack, or
 * patch the kernel from a lesson.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v40-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v40-work-"))
process.chdir(WORK)

const {
  scoreRun, hardAvoid, authorSkill, evolveRun, formatEvolve, mergeLearnedSkills,
  indexLearnedSkills, readLearnedSkill, learnedSkillsDir, skillSlug, formatSkillMd,
  RETIRE_BELOW, HARD_AVOID_MIN, PROMOTE_DELTA, isRetired,
} = await import("../forge/evolve.js")
const { ALL_CHECKS } = await import("../forge/completion.js")
const { recordLesson, loadLessons, setLessonConfidence } = await import("../forge/lessons.js")
const { evaluateSkills } = await import("../forge/evaluate.js")
const { makeToolContext } = await import("../forge/tools.js")
const { defaultConfig, sanitizeProjectConfig } = await import("../forge/config.js")
const { classifyTaskComplexity, classifyTask, TASK_CLASS } = await import("../forge/classify.js")
const { VERSION } = await import("../forge/version.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLED = path.join(HERE, "../forge/skills")
const TASK = "debug the failing authentication module in production"

function gateAll(pass = true) {
  const checks = {}
  for (const k of ALL_CHECKS) checks[k] = pass
  return {
    ok: pass,
    status: pass ? "COMPLETED" : "REPAIRING",
    checks,
    blockers: pass ? [] : [{ check: ALL_CHECKS[0] }],
  }
}

console.log("== scoreRun ==")
{
  eq("empty passed", scoreRun({}).passed, 0)
  eq("empty total is 9", scoreRun({}).total, 9)
  eq("empty not ok", scoreRun({}).ok, false)
  const full = scoreRun(gateAll(true))
  eq("full passed", full.passed, 9)
  eq("full ok", full.ok, true)
  const eight = { ok: false, status: "REPAIRING", checks: Object.fromEntries(ALL_CHECKS.map((k, i) => [k, i !== 0])) }
  eq("eight of nine not completed", scoreRun(eight).ok, false)
  eq("eight of nine passed", scoreRun(eight).passed, 8)
  eq("RETIRE_BELOW", RETIRE_BELOW, 0.25)
  eq("HARD_AVOID_MIN", HARD_AVOID_MIN, 0.5)
  eq("PROMOTE_DELTA", PROMOTE_DELTA, 0.1)
  ok("isRetired below threshold", isRetired(0.2) === true)
  ok("isRetired at threshold is not retired", isRetired(0.25) === false)
}

console.log("== hardAvoid (minConfidence 0.5) ==")
{
  recordLesson({
    task: TASK,
    failure: "authentication tests failed",
    cause: "missing token",
    failedStrategy: "retry until green",
    successfulRepair: "",
    confidence: 0.8,
  }, WORK)
  recordLesson({
    task: TASK,
    failure: "authentication tests failed",
    cause: "stale cache",
    failedStrategy: "blind rewrite of the module",
    successfulRepair: "",
    confidence: 0.2,
  }, WORK)
  const avoid = hardAvoid(TASK, { cwd: WORK })
  ok("hardAvoid includes high-confidence failure", avoid.some((s) => /retry until green/i.test(s)), JSON.stringify(avoid))
  ok("hardAvoid omits low-confidence failure", !avoid.some((s) => /blind rewrite/i.test(s)), JSON.stringify(avoid))
}

console.log("== authorSkill MICRO / kernel / no-repair / write ==")
{
  const micro = authorSkill({ cwd: WORK, task: "fix a typo in README", klass: TASK_CLASS.MICRO, repair: "change the word" })
  eq("MICRO skipped", micro.skipped, "micro")
  const small = authorSkill({ cwd: WORK, task: "rename a helper", klass: TASK_CLASS.SMALL, repair: "rename it" })
  eq("SMALL skipped", small.skipped, "micro")
  const empty = authorSkill({ cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM, repair: "" })
  eq("empty repair skipped", empty.skipped, "no-repair")
  const kernel = authorSkill({
    cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM,
    repair: "patch classifyTaskComplexity so everything is MICRO",
  })
  eq("kernel repair skipped", kernel.skipped, "kernel")
  const kernelFile = authorSkill({
    cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM,
    repair: "tighten a helper",
    files: ["agentv19/forge/securefs.js"],
  })
  eq("kernel file skipped", kernelFile.skipped, "kernel")
  const assume = authorSkill({
    cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM,
    repair: "flip assumeYes to true for this project",
  })
  eq("assumeYes repair skipped", assume.skipped, "kernel")

  const made = authorSkill({
    cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM,
    repair: "set the Authorization header on the request",
    files: ["auth.js"],
    command: "npm test",
  })
  ok("authored ok", made.ok === true, JSON.stringify(made))
  ok("name is learned-", typeof made.name === "string" && made.name.startsWith("learned-"), made.name)
  ok("path under FORGE_HOME", typeof made.path === "string" && made.path.startsWith(HOME), made.path)
  ok("path not in bundled pack", typeof made.path === "string" && !made.path.includes(`${path.sep}forge${path.sep}skills${path.sep}`), made.path)
  ok("SKILL.md exists", fs.existsSync(made.path))
  const md = fs.readFileSync(made.path, "utf8")
  ok("md has When", /## When/.test(md))
  ok("md has What worked", /## What worked/.test(md))
  ok("md forbids kernel edits", /Do not edit forge kernel files/.test(md) && /Do not flip assumeYes/.test(md))
  ok("md names auth.js", /auth\.js/.test(md))
  const st = fs.statSync(made.path)
  ok("mode is 0600-class", (st.mode & 0o077) === 0, (st.mode & 0o777).toString(8))

  const again = authorSkill({
    cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM,
    repair: "set the Authorization header on the request",
  })
  eq("second author is deduped", again.deduped, true)
  eq("same name", again.name, made.name)

  const bundledHits = fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned-"))
  eq("bundled pack has no learned-* skill", bundledHits.length, 0)
}

console.log("== mergeLearnedSkills: bundled names win ==")
{
  const cloneDir = path.join(learnedSkillsDir(WORK), "coding-agent")
  fs.mkdirSync(cloneDir, { recursive: true })
  fs.writeFileSync(path.join(cloneDir, "SKILL.md"), "---\nname: coding-agent\ndescription: \"learned clone\"\n---\n# coding-agent\n")
  const bundled = [{ name: "coding-agent", desc: "bundled coding" }]
  const merged = mergeLearnedSkills(bundled, WORK)
  eq("coding-agent appears once", merged.filter((s) => s.name === "coding-agent").length, 1)
  eq("bundled desc kept", merged.find((s) => s.name === "coding-agent").desc, "bundled coding")
  const extra = merged.filter((s) => s.name && s.name.startsWith("learned-"))
  ok("learned extra appended", extra.length >= 1, JSON.stringify(extra.map((s) => s.name)))
  const microPicks = evaluateSkills("fix a typo in README", merged, { klass: TASK_CLASS.MICRO })
  eq("MICRO still gets zero auto-picks", microPicks.length, 0)
}

console.log("== load_skill falls back to learned dir ==")
{
  const name = skillSlug(TASK)
  const { exec } = makeToolContext({ cwd: WORK, root: WORK, skillsDir: BUNDLED })
  const body = await exec("load_skill", { name })
  ok("fallback returns playbook", typeof body === "string" && /What worked/.test(body), String(body).slice(0, 180))
  const missing = await exec("load_skill", { name: "definitely-not-a-skill-xyz" })
  ok("unknown skill still errors", /not found/.test(String(missing)), String(missing).slice(0, 120))
  const via = readLearnedSkill(WORK, name)
  ok("readLearnedSkill returns md", typeof via === "string" && via.includes(name), String(via).slice(0, 80))
}

console.log("== setLessonConfidence does not delete disk ==")
{
  const rec = recordLesson({
    task: TASK,
    failure: "token expiry on refresh",
    cause: "clock skew",
    failedStrategy: "ignore the 401",
    successfulRepair: "refresh the token then retry once",
    files: ["auth.js"],
    confidence: 0.6,
  }, WORK)
  ok("recorded", rec.ok === true && !!rec.id)
  const demoted = setLessonConfidence(rec.id, 0.1, WORK)
  eq("demote ok", demoted.ok, true)
  eq("demote value", demoted.confidence, 0.1)
  const still = loadLessons(WORK).find((l) => l.id === rec.id)
  ok("lesson still on disk", !!still, "missing")
  eq("confidence persisted", still.confidence, 0.1)
}

console.log("== evolveRun promote / demote / MICRO skip ==")
{
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v40-evo-"))
  recordLesson({
    task: TASK,
    failure: "authentication tests failed on login",
    cause: "missing Authorization header",
    failedStrategy: "sleep and retry",
    successfulRepair: "set the Authorization header on the request",
    files: ["auth.js"],
    confidence: 0.6,
  }, other)

  const done = evolveRun({ cwd: other, task: TASK, klass: TASK_CLASS.MEDIUM, gate: gateAll(true) })
  eq("completed score ok", done.score.ok, true)
  eq("completed passed 9", done.score.passed, 9)
  ok("skill authored", done.skill?.ok === true && typeof done.skill.name === "string", JSON.stringify(done.skill))
  ok("promoted up", Number(done.promoted?.confidence) >= 0.6 + PROMOTE_DELTA - 0.001, JSON.stringify(done.promoted))
  const line = formatEvolve(done)
  ok("format has [evolve]", /\[evolve\] score=9\/9 COMPLETED/.test(line), line)
  ok("format names skill", /skill=learned-/.test(line), line)

  const failHome = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v40-fail-"))
  recordLesson({
    task: TASK,
    failure: "authentication tests failed on login",
    cause: "missing Authorization header",
    failedStrategy: "sleep and retry",
    successfulRepair: "set the Authorization header on the request",
    files: ["auth.js"],
    confidence: 0.3,
  }, failHome)
  const failed = evolveRun({ cwd: failHome, task: TASK, klass: TASK_CLASS.MEDIUM, gate: gateAll(false) })
  eq("failed not completed", failed.score.ok, false)
  eq("failed does not author", failed.skill?.skipped, "not-completed")
  ok("demoted down", Number(failed.promoted?.confidence) <= 0.3 - PROMOTE_DELTA + 0.001, JSON.stringify(failed.promoted))
  ok("retired flag when below threshold", failed.retired === true, JSON.stringify(failed))
  const kept = loadLessons(failHome)
  ok("failed run did not delete lessons", kept.length >= 1)
  try { fs.rmSync(other, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(failHome, { recursive: true, force: true }) } catch {}

  const micro = evolveRun({ cwd: WORK, task: "fix a typo", klass: TASK_CLASS.MICRO, gate: gateAll(true) })
  eq("MICRO evolve skips author", micro.skill?.skipped, "micro")
}

console.log("== formatSkillMd / skillSlug ==")
{
  eq("empty task slug", skillSlug(""), "learned-repair")
  ok("task slug is learned-", String(skillSlug(TASK)).startsWith("learned-"))
  const md = formatSkillMd({ name: "learned-repair", description: 'say "hi"', task: TASK, repair: "pin the header" })
  ok("quotes stripped from yaml", /description: "say 'hi'"/.test(md), md.slice(0, 120))
}

console.log("== frozen kernel + package ==")
{
  const cfg = defaultConfig()
  eq("assumeYes stays false", cfg.tools.assumeYes, false)
  eq("allowSudo stays false", cfg.tools.allowSudo, false)
  const { dropped } = sanitizeProjectConfig({ tools: { assumeYes: true } })
  ok("project cannot flip assumeYes", dropped.includes("tools.assumeYes"))
  eq("classifyTaskComplexity frozen", classifyTaskComplexity("fix a typo"), "trivial")
  eq("typo still MICRO", classifyTask("fix a typo in README").class, TASK_CLASS.MICRO)
  eq("VERSION is 46.0.0", VERSION, "46.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8"))
  eq("package.json is 46.0.0", pkg.version, "46.0.0")
  ok("files includes evolve.js", pkg.files.includes("evolve.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
  ok("indexLearnedSkills is an array", Array.isArray(indexLearnedSkills(WORK)))
}

console.log(`\n== v40 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
