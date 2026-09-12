#!/usr/bin/env node
/**
 * forge — v77 skillver: versioned learned skills, rollback, generated tests,
 * tool download progress, knowledge on the idle header.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v77-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v77-work-"))
process.chdir(WORK)

const {
  authorSkill, recordSkillOutcome, promoteSkill, rollbackSkill, supersedeSkill,
  skillLifecycle, SKILL_LIFE, learnedSkillsDir,
} = await import("../evolve.js")
const { generateSkillTests, downloadSkill, verifySkill } = await import("../skilldl.js")
const { knowledgeDockText, renderHeader, renderIdle, renderOptions } = await import("../render.js")
const { initialState } = await import("../uistate.js")
const { TASK_CLASS, classifyTask, classifyTaskComplexity } = await import("../classify.js")
const { evaluateSkills } = await import("../evaluate.js")
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

const TASK = "implement user authentication with JWT refresh tokens"
const REPAIR = "Validate the Authorization header before hitting the handler."

console.log("== versioned author: v2 is CANDIDATE, v1 stays VERIFIED ==")
{
  eq("task not MICRO", classifyTask(TASK).class === TASK_CLASS.MICRO, false)
  const a1 = authorSkill({ cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM, repair: REPAIR, files: ["auth.js"], command: "npm test" })
  eq("first ok", a1.ok, true)
  eq("first CANDIDATE", a1.lifecycle, SKILL_LIFE.CANDIDATE)
  recordSkillOutcome({ cwd: WORK, name: a1.name, status: SKILL_LIFE.VERIFIED })
  eq("v1 VERIFIED", skillLifecycle(a1.name, WORK), SKILL_LIFE.VERIFIED)
  const a2 = authorSkill({ cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM, repair: REPAIR + " Also rotate refresh tokens.", files: ["auth.js"], command: "npm test" })
  eq("second ok", a2.ok, true)
  ok("v2 name", /-v2$/.test(a2.name), a2.name)
  eq("v2 CANDIDATE", a2.lifecycle, SKILL_LIFE.CANDIDATE)
  eq("v2 not ACTIVE", a2.lifecycle === SKILL_LIFE.ACTIVE, false)
  eq("v1 still VERIFIED", skillLifecycle(a1.name, WORK), SKILL_LIFE.VERIFIED)
  ok("both on disk", fs.existsSync(path.join(learnedSkillsDir(WORK), a1.name, "SKILL.md")) && fs.existsSync(path.join(learnedSkillsDir(WORK), a2.name, "SKILL.md")))
  eq("promote CANDIDATE refused", promoteSkill(WORK, a2.name).ok, false)
  recordSkillOutcome({ cwd: WORK, name: a2.name, status: SKILL_LIFE.VERIFIED })
  const promoted = promoteSkill(WORK, a2.name)
  eq("promote ok", promoted.ok, true)
  eq("v2 ACTIVE", skillLifecycle(a2.name, WORK), SKILL_LIFE.ACTIVE)
  eq("v1 SUPERSEDED", skillLifecycle(a1.name, WORK), SKILL_LIFE.SUPERSEDED)
  const rb = rollbackSkill(WORK, a2.name)
  eq("rollback ok", rb.ok, true)
  eq("v2 SUPERSEDED", skillLifecycle(a2.name, WORK), SKILL_LIFE.SUPERSEDED)
  eq("v1 ACTIVE again", skillLifecycle(a1.name, WORK), SKILL_LIFE.ACTIVE)
  eq("supersede ok", supersedeSkill(WORK, a2.name).ok, true)
}

console.log("== generateSkillTests + verify generated ==")
{
  const md = `---
name: web-design
description: layout
---
# Web Design
## What worked
Use a 12-column grid.
## Files
- layout.css
## Verify
Recommended: \`true\`
`
  const cmds = generateSkillTests(md)
  ok("has true", cmds.includes("true"), String(cmds))
  eq("only verify cmd", cmds.length, 1)
  await downloadSkill("https://example.com/web-design.skill", {
    fetchFn: async () => ({
      ok: true, status: 200,
      headers: { "content-disposition": 'filename="web-design.skill"' },
      body: Buffer.from(md),
    }),
  })
  const v = verifySkill("web-design", { generate: true })
  eq("generated verify ok", v.ok, true)
  eq("kind generated", v.evidence?.kind, "generated")
  eq("not ACTIVE", v.lifecycle === SKILL_LIFE.ACTIVE, false)
}

console.log("== CLI/TUI + header + compose never writes ==")
{
  const forgeSrc = fs.readFileSync(path.join(FORGE, "forge.js"), "utf8")
  const chatSrc = fs.readFileSync(path.join(FORGE, "chat.js"), "utf8")
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("CLI promote", /promoteSkill/.test(forgeSrc) && /rollbackSkill/.test(forgeSrc))
  ok("TUI /skill promote", /\/skill promote/.test(chatSrc) || /sub === "promote"/.test(chatSrc))
  ok("TUI tool progress", /case "tool"[\s\S]*download started/.test(chatSrc) || /\/tool download[\s\S]*onProgress/.test(chatSrc))
  ok("compose has no authorSkill", !/authorSkill/.test(composeSrc))
  ok("compose has no skilldl", !/skilldl/.test(composeSrc))
  const o = renderOptions({ ascii: true, a11y: true })
  const idle = renderIdle({ version: "89.0.0", knowledge: "claims web-design" }, 80, o).join("\n")
  ok("idle knowledge", /Knowledge/.test(idle) && /web-design/.test(idle), idle)
  const st = initialState({
    cwd: WORK, state: "READY",
    knowledge: { claims: [{ subject: "web-design" }], decisions: [] },
  })
  const head = renderHeader(st, 120, o)
  ok("header claims", /web-design/.test(head) || knowledgeDockText(st.knowledge).includes("web-design"), head)
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
  eq("VERSION is 89.0.0", VERSION, "89.0.0")
  const pkg = JSON.parse(fs.readFileSync(path.join(FORGE, "package.json"), "utf8"))
  eq("package.json is 89.0.0", pkg.version, "89.0.0")
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

console.log(`\n== v77 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
