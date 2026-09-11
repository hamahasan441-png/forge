#!/usr/bin/env node
/**
 * forge — v66 learn: extract procedures from VERIFIED downloads.
 *
 * LEARN ≠ INDEX. CANDIDATE refused. Not ACTIVE. Never ~/.forge/tools.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v66-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v66-work-"))
process.chdir(WORK)

const {
  downloadSkill, verifySkill, learnSkill, formatLearnReport,
  extractKnowledge, readSkillKnowledge, readDownloadedSkill, indexVerifiedSkills,
} = await import("../skilldl.js")
const { SKILL_LIFE } = await import("../evolve.js")
const { execTool } = await import("../tools.js")
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

const RICH = `---
name: web-design
description: Responsive layout playbook
---

# Web Design

You will produce accessible, responsive layouts.

## Layout
Set a fluid grid and test at 390px.

## What worked
Use clamp() for type and a 12-column grid.

## Files
- src/styles.css

## Verify
\`npm test\`
`

const THIN = `---
name: thin-name
description: Just a label
---

# Thin Name
`

function mockFetch(body, { filename = "artifact.bin" } = {}) {
  const buf = Buffer.from(String(body), "utf8")
  return async (href) => ({
    ok: true, status: 200, statusText: "OK",
    headers: { "content-disposition": `filename="${filename}"` },
    body: buf, url: href,
  })
}

console.log("== extractKnowledge ==")
{
  const k = extractKnowledge(RICH)
  ok("layout procedure", k.procedures.some((p) => /layout/i.test(p.title)))
  ok("repair from What worked", /clamp/.test(k.repair))
  ok("file", k.files.includes("src/styles.css"))
  const thin = extractKnowledge(THIN)
  eq("thin no procedures", thin.procedures.length, 0)
}

console.log("== CANDIDATE learn fails; VERIFIED extracts; thin fails ==")
{
  await downloadSkill("https://example.com/web-design.skill", {
    fetchFn: mockFetch(RICH, { filename: "web-design.skill" }),
  })
  const before = learnSkill("web-design")
  ok("CANDIDATE refused", before.ok === false && /not verified|indexing/.test(before.error), before.error)
  verifySkill("web-design")
  const r = learnSkill("web-design")
  eq("learn ok", r.ok, true)
  eq("still VERIFIED", r.lifecycle, SKILL_LIFE.VERIFIED)
  eq("not ACTIVE", r.lifecycle === SKILL_LIFE.ACTIVE, false)
  ok("knowledge.json", fs.existsSync(path.join(HOME, "skill-downloads", "web-design", "knowledge.json")))
  const know = readSkillKnowledge("web-design")
  ok("procedures stored", (know?.procedures || []).length >= 1)
  ok("report", /Learned/.test(formatLearnReport(r)) && /Not ACTIVE/.test(formatLearnReport(r)))
  const loaded = await execTool({ cwd: WORK, skillsDir: null }, "load_skill", { name: "web-design" })
  ok("load_skill appends procedures", /Learned procedures/.test(String(loaded)), String(loaded).slice(0, 200))
  const listed = indexVerifiedSkills()
  eq("extracted flag", listed.find((s) => s.name === "web-design")?.extracted, true)

  await downloadSkill("https://example.com/thin-name.skill", {
    fetchFn: mockFetch(THIN, { filename: "thin-name.skill" }),
  })
  verifySkill("thin-name")
  const thin = learnSkill("thin-name")
  ok("thin refused", thin.ok === false && /indexing is not learned/.test(thin.error), thin.error)
  eq("thin not learned", readSkillKnowledge("thin-name"), null)
}

console.log("== CLI/TUI wired; compose never fetches ==")
{
  const forgeSrc = fs.readFileSync(path.join(FORGE, "forge.js"), "utf8")
  ok("CLI learn", /forge skill learn/.test(forgeSrc) && /runLearn/.test(forgeSrc))
  const chatSrc = fs.readFileSync(path.join(FORGE, "chat.js"), "utf8")
  ok("TUI /skill learn", /\/skill learn/.test(chatSrc) && /sub === "learn"/.test(chatSrc))
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("compose has no skilldl", !/skilldl/.test(composeSrc))
  ok("compose has no learnSkill", !/learnSkill\(/.test(composeSrc))
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
  eq("VERSION is 74.0.0", VERSION, "74.0.0")
  const pkg = JSON.parse(fs.readFileSync(path.join(FORGE, "package.json"), "utf8"))
  eq("package.json is 74.0.0", pkg.version, "74.0.0")
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

console.log(`\n== v66 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
