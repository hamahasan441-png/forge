#!/usr/bin/env node
/**
 * forge — v78 experiment: gap hypothesis → focused test → recordGapOutcome.
 * Skill from a gap. Playbook vs repair benchmark. Never invent npm test.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v78-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v78-work-"))
process.chdir(WORK)

const { generateGapTest, hypothesize, runExperiment, benchmarkPlaybook, formatExperimentReport } = await import("../experiment.js")
const { loadGapStats, LIFECYCLE } = await import("../knowgap.js")
const { skillLifecycle, SKILL_LIFE, learnedSkillsDir } = await import("../evolve.js")
const { evaluateSkills } = await import("../evaluate.js")
const { classifyTaskComplexity, classifyTask, TASK_CLASS } = await import("../classify.js")
const { defaultConfig, sanitizeProjectConfig } = await import("../config.js")
const { VERSION } = await import("../version.js")
const { CATALOG } = await import("../providers.js")
const { PLUGINS_DIR } = await import("../plugins.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FORGE = path.join(HERE, "..")
const HOST = path.join(FORGE, "plugin-host.js")
const BUNDLED = path.join(FORGE, "skills")

function listGlobalTools() {
  try { return fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")) } catch { return [] }
}

console.log("== generateGapTest never invents npm test ==")
{
  const skip = generateGapTest({ id: "auth" })
  eq("no command skips", skip.ok, false)
  eq("skip reason", skip.skipped, "no-focused-test")
  ok("never npm test", skip.command !== "npm test" && skip.ok === false)
  const explicit = generateGapTest({ id: "auth" }, { command: "true" })
  eq("explicit ok", explicit.ok, true)
  eq("explicit cmd", explicit.command, "true")
  const graph = generateGapTest({ id: "auth" }, { blast: { tests: ["true"] } })
  eq("graph cmd", graph.command, "true")
  const hypo = hypothesize({ id: "auth" }, { command: "true" })
  ok("hypothesis names domain", /auth/.test(hypo.hypothesis))
}

console.log("== runExperiment VERIFIED + CANDIDATE skill; fail CONTRADICTED ==")
{
  const pass = runExperiment({ cwd: WORK, id: "auth", command: "true", task: "implement user authentication with JWT refresh tokens", klass: TASK_CLASS.MEDIUM })
  eq("pass ok", pass.ok, true)
  eq("gap VERIFIED", pass.lifecycle, LIFECYCLE.VERIFIED)
  eq("store VERIFIED", loadGapStats(WORK).domains?.auth?.lifecycle, LIFECYCLE.VERIFIED)
  eq("skill ok", pass.skill?.ok, true)
  eq("skill CANDIDATE", pass.skill?.lifecycle, SKILL_LIFE.CANDIDATE)
  eq("not ACTIVE", pass.skill?.lifecycle === SKILL_LIFE.ACTIVE, false)
  ok("skill on disk", fs.existsSync(path.join(learnedSkillsDir(WORK), pass.skill.name, "SKILL.md")))
  ok("report names experiment", /experiment/.test(formatExperimentReport(pass)))

  const fail = runExperiment({ cwd: WORK, id: "auth", command: "false", generateSkill: false })
  eq("fail not ok", fail.ok, false)
  eq("gap CONTRADICTED", fail.lifecycle, LIFECYCLE.CONTRADICTED)
  eq("store CONTRADICTED", loadGapStats(WORK).domains?.auth?.lifecycle, LIFECYCLE.CONTRADICTED)

  const refused = runExperiment({ cwd: WORK, id: "security", command: "rm -rf /", generateSkill: false })
  eq("shellguard skip", refused.skipped, "shellguard")
  eq("security not VERIFIED", loadGapStats(WORK).domains?.security?.lifecycle === LIFECYCLE.VERIFIED, false)

  const missing = runExperiment({ cwd: WORK, id: "auth" })
  eq("no command ledger", missing.skipped, "no-focused-test")
}

console.log("== benchmarkPlaybook + compose never writes ==")
{
  const play = `---
name: learned-auth
description: auth
---
# learned-auth
## What worked
Validate the Authorization header.
## Files
- auth.js
## Verify
\`true\`
`
  const b = benchmarkPlaybook({ playbook: play, repair: "Validate the Authorization header." })
  ok("playbook scores", b.playbookScore >= 3, String(b.playbookScore))
  eq("winner playbook", b.winner, "playbook")
  const empty = benchmarkPlaybook({ playbook: "", repair: "a repair" })
  eq("empty playbook loses", empty.winner, "repair")
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("compose has no experiment", !/experiment/.test(composeSrc))
  ok("compose has no recordGapOutcome", !/recordGapOutcome/.test(composeSrc))
  const forgeSrc = fs.readFileSync(path.join(FORGE, "forge.js"), "utf8")
  const chatSrc = fs.readFileSync(path.join(FORGE, "chat.js"), "utf8")
  ok("CLI experiment", /case "experiment"/.test(forgeSrc))
  ok("TUI /experiment", /case "experiment"/.test(chatSrc))
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
  eq("VERSION is 80.0.0", VERSION, "80.0.0")
  const pkg = JSON.parse(fs.readFileSync(path.join(FORGE, "package.json"), "utf8"))
  eq("package.json is 80.0.0", pkg.version, "80.0.0")
  ok("files includes experiment.js", (pkg.files || []).includes("experiment.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
  eq("custom is still index 17 (pick 18)", CATALOG[17]?.name, "custom")
  eq("apinex still after custom", CATALOG[18]?.name, "apinex")
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
  eq("bundled pack unchanged", fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(","), bundledBefore)
  const todo = fs.readFileSync(path.join(FORGE, "TODO.md"), "utf8")
  eq("TODO still unchecked", (todo.match(/^- \[[xX]\]/gm) || []).length, 0)
  ok("no PLAN file", fs.readdirSync(FORGE).filter((n) => /^PLAN-v\d+\.md$/.test(n)).length === 0)
  ok("no ~/.forge/tools", !fs.existsSync(path.join(HOME, "tools")) || fs.readdirSync(path.join(HOME, "tools")).length === 0)
}

console.log(`\n== v78 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
