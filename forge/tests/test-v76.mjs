#!/usr/bin/env node
/**
 * forge — v76 live: /claims refreshes the dock without PLAN_COMPOSE.
 * Compose never writes.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v76-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v76-work-"))
process.chdir(WORK)

const { recordClaim } = await import("../claims.js")
const { recordDecision, snapshotKnowledge } = await import("../decisions.js")
const { reduce, initialState } = await import("../uistate.js")
const { knowledgeDockText } = await import("../render.js")
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

console.log("== snapshotKnowledge folds store → dock without PLAN_COMPOSE ==")
{
  recordClaim({ cwd: WORK, subject: "web-design", text: "Use a 12-column grid.", source: "skill" })
  recordDecision({ cwd: WORK, title: "use-postgres", reason: "billing rows need SQL." })
  const snap = snapshotKnowledge(WORK)
  eq("claim in snap", snap.claims.some((c) => c.subject === "web-design"), true)
  eq("decision in snap", snap.decisions.some((d) => d.title === "use-postgres"), true)
  const s1 = reduce(initialState({ cwd: WORK }), { type: "KNOWLEDGE_UPDATED", ...snap })
  const line = knowledgeDockText(s1.knowledge)
  ok("dock claims", /web-design/.test(line), line)
  ok("dock decisions", /use-postgres/.test(line), line)
}

console.log("== TUI commands dispatch KNOWLEDGE_UPDATED; compose never writes ==")
{
  const chatSrc = fs.readFileSync(path.join(FORGE, "chat.js"), "utf8")
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("/claims dispatch", /case "claims"/.test(chatSrc) && /KNOWLEDGE_UPDATED/.test(chatSrc) && /snapshotKnowledge/.test(chatSrc))
  ok("/decisions dispatch", /case "decisions"/.test(chatSrc))
  ok("/knowledge dispatch", /case "knowledge"[\s\S]*KNOWLEDGE_UPDATED/.test(chatSrc))
  ok("/skill learn dispatch", /skill learn[\s\S]{0,400}snapshotKnowledge/.test(chatSrc) || /learnSkill[\s\S]{0,500}snapshotKnowledge/.test(chatSrc))
  ok("compose has no snapshotKnowledge", !/snapshotKnowledge/.test(composeSrc))
  ok("compose has no recordClaim", !/recordClaim/.test(composeSrc))
  ok("compose has no skilldl", !/skilldl/.test(composeSrc))
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

console.log(`\n== v76 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
