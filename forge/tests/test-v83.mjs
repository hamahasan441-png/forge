#!/usr/bin/env node
/**
 * forge — v83 knowtype: FACT/EXPERIENCE/LESSON/HYPOTHESIS.
 * Hypothesis is never a fact. Compose never writes. Never auto-ACTIVE.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v83-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v83-work-"))
process.chdir(WORK)

const { recordKnowledge, pickKnowledge, listKnowledge, asFact, formatKnowtype, KTYPE } = await import("../knowtype.js")
const { formatSteer } = await import("../evaluate.js")
const { compose } = await import("../compose.js")
const { TASK_CLASS, classifyTaskComplexity, classifyTask } = await import("../classify.js")
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

console.log("== FACT needs evidence; hypothesis is never a fact ==")
{
  const hyp = recordKnowledge({ cwd: WORK, type: "HYPOTHESIS", text: "auth tokens expire after fifteen minutes" })
  eq("hyp ok", hyp.ok, true)
  eq("hyp type", hyp.type, KTYPE.HYPOTHESIS)
  eq("hyp not fact", asFact(hyp), false)
  const silent = recordKnowledge({ cwd: WORK, type: "FACT", text: "the payment webhook retries twice" })
  eq("FACT without evidence demoted", silent.type, KTYPE.HYPOTHESIS)
  eq("demoted flag", silent.demoted, true)
  eq("still not fact", asFact(silent), false)
  const fact = recordKnowledge({ cwd: WORK, type: "FACT", text: "JWT expires after 15 minutes", evidence: "verifySkill echo-ok" })
  eq("FACT with evidence", fact.type, KTYPE.FACT)
  eq("asFact", asFact(fact), true)
  const exp = recordKnowledge({ cwd: WORK, type: "EXPERIENCE", text: "layout-first failed on the homepage grid" })
  eq("experience", exp.type, KTYPE.EXPERIENCE)
  const les = recordKnowledge({ cwd: WORK, type: "LESSON", text: "do not invent npm test for a knowledge gap" })
  eq("lesson", les.type, KTYPE.LESSON)
}

console.log("== pick ranks FACT above HYPOTHESIS; MICRO skip ==")
{
  const picked = pickKnowledge("JWT auth timeout on the login page", { cwd: WORK, klass: TASK_CLASS.MEDIUM })
  ok("includes FACT", picked.some((x) => x.type === KTYPE.FACT), JSON.stringify(picked.map((x) => x.type)))
  const types = picked.map((x) => x.type)
  const fi = types.indexOf(KTYPE.FACT)
  const hi = types.indexOf(KTYPE.HYPOTHESIS)
  ok("FACT before HYPOTHESIS when both present", fi === -1 || hi === -1 || fi < hi, types.join(","))
  const steer = formatSteer({ knowtype: picked })
  ok("KNOW line", /KNOW:/.test(steer), steer)
  ok("unproven label if hyp present", !picked.some((x) => x.type === KTYPE.HYPOTHESIS) || /unproven/.test(steer), steer)
  eq("MICRO empty", pickKnowledge("fix a typo", { cwd: WORK, klass: TASK_CLASS.MICRO }).length, 0)
  const c = compose("JWT auth timeout", { cwd: WORK, klass: TASK_CLASS.MEDIUM, includePlugins: false })
  ok("compose.knowtype array", Array.isArray(c.knowtype))
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("compose has no recordKnowledge", !/recordKnowledge/.test(composeSrc))
  ok("compose has no knowtype.json write", !/knowtype\.json/.test(composeSrc))
}

console.log("== CLI wired ==")
{
  const forgeSrc = fs.readFileSync(path.join(FORGE, "forge.js"), "utf8")
  ok("CLI knowtype", /case "knowtype"/.test(forgeSrc))
  const chatSrc = fs.readFileSync(path.join(FORGE, "chat.js"), "utf8")
  ok("TUI /knowtype", /case "knowtype"/.test(chatSrc))
  ok("list not empty", listKnowledge(WORK).length >= 3)
  ok("formatKnowtype", /KNOW:/.test(formatKnowtype(listKnowledge(WORK))))
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
  eq("VERSION is 83.0.0", VERSION, "83.0.0")
  const pkg = JSON.parse(fs.readFileSync(path.join(FORGE, "package.json"), "utf8"))
  eq("package.json is 83.0.0", pkg.version, "83.0.0")
  ok("files includes knowtype.js", (pkg.files || []).includes("knowtype.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
  eq("custom is still index 17 (pick 18)", CATALOG[17]?.name, "custom")
  eq("apinex still after custom", CATALOG[18]?.name, "apinex")
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
  eq("bundled pack unchanged", fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(","), bundledBefore)
  const todo = fs.readFileSync(path.join(FORGE, "TODO.md"), "utf8")
  eq("TODO still unchecked", (todo.match(/^- \[[xX]\]/gm) || []).length, 0)
  ok("no PLAN file", fs.readdirSync(FORGE).filter((n) => /^PLAN-v\d+\.md$/.test(n)).length === 0)
  ok("Never list kept", /Research crawler/.test(todo) && /Auto-ACTIVE/.test(todo))
  ok("no ~/.forge/tools", !fs.existsSync(path.join(HOME, "tools")) || fs.readdirSync(path.join(HOME, "tools")).length === 0)
}

console.log(`\n== v83 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
