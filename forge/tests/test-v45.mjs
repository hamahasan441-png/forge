#!/usr/bin/env node
/**
 * forge — v45 steer: playbook first, skip rediscovery.
 *
 * Repair / load_skill / RECOVER chain use the v44 playbook instead of
 * rediscovering. Never spawn plugin-host. Never auto-run the recorded
 * command. Does not: flip assumeYes, flip allowNewPlugins, add a runtime
 * dep, spawn a second writer, change classifyTaskComplexity(), write
 * ~/.forge/tools, or weaken plugin-iso.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v45-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v45-work-"))
process.chdir(WORK)

const { authorPlugin, learnedPluginsDir, readLearnedPlaybookByName, formatPlaybookMd } = await import("../extend.js")
const { compose, formatCompose } = await import("../compose.js")
const { formatSteer, formatSkillPicks } = await import("../evaluate.js")
const { planChain, INTENT } = await import("../router.js")
const { makeToolContext } = await import("../tools.js")
const { defaultRegistry } = await import("../capabilities.js")
const { PLUGINS_DIR } = await import("../plugins.js")
const { defaultConfig, sanitizeProjectConfig } = await import("../config.js")
const { classifyTaskComplexity, classifyTask, TASK_CLASS } = await import("../classify.js")
const { VERSION } = await import("../version.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOST = path.join(HERE, "../plugin-host.js")
const TASK = "debug the failing authentication module in production"
const REPAIR = "set the Authorization header on the request"

function listGlobalTools() {
  try { return fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")) } catch { return [] }
}

console.log("== formatSteer ranks playbook first ==")
{
  eq("empty steer", formatSteer({}), "")
  eq("empty skill picks", formatSkillPicks([]), "")
  const block = formatSteer({
    skills: [{ name: "auth-playbook", desc: "debug failing authentication" }],
    plugins: [{
      name: "learned_debug_failing_authentication",
      isolated: true,
      repair: REPAIR,
      files: ["auth.js"],
      command: "npm test",
    }],
    avoid: ["retry until green"],
  })
  ok("TRY FIRST", /TRY FIRST/.test(block), block)
  ok("names the repair", /Authorization header/.test(block), block)
  ok("names the file", /auth\.js/.test(block), block)
  ok("then npm test", /then npm test/.test(block), block)
  ok("skills line", /SKILLS/.test(block) && /auth-playbook/.test(block), block)
  ok("avoid line", /AVOID/.test(block) && /retry until green/.test(block), block)
  ok("no PLUGINS dump when playbook present", !/PLUGINS \(isolated/.test(block), block)
  const micro = formatSteer({ plugins: [] })
  eq("MICRO empty plugins is empty steer", micro, "")
}

console.log("== compose fills playbook onto caller plugin; MICRO skip ==")
{
  const beforeGlobal = listGlobalTools()
  const hostBefore = fs.readFileSync(HOST, "utf8")
  const r = authorPlugin({
    cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM,
    repair: REPAIR, files: ["auth.js"], command: "npm test",
  })
  eq("authored ok", r.ok, true)
  const caller = [{
    name: r.name, isolated: true, source: "host",
    description: "debug failing authentication modules in production",
  }]
  const c = compose(TASK, { cwd: WORK, plugins: caller })
  const hit = (c.plugins || []).find((p) => p.name === r.name)
  eq("caller source kept", hit?.source, "host")
  eq("repair filled from index", hit?.repair, REPAIR)
  ok("files filled", (hit?.files || []).includes("auth.js"))
  ok("formatCompose still has playbook", /\[playbook\]/.test(formatCompose(c)) && /Authorization header/.test(formatCompose(c)))
  const typo = compose("fix a typo in README", { cwd: WORK })
  eq("typo is MICRO", typo.klass, TASK_CLASS.MICRO)
  eq("typo zero isolated", typo.plugins.filter((p) => p.isolated).length, 0)
  eq("typo steer empty", formatSteer({ plugins: typo.plugins, skills: typo.skills, avoid: typo.avoid }).includes("TRY FIRST"), false)
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
}

console.log("== load_skill falls back to learned playbook ==")
{
  const authored = authorPlugin({
    cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM,
    repair: REPAIR, files: ["auth.js"], command: "npm test",
  })
  const md = readLearnedPlaybookByName(WORK, authored.name)
  ok("playbook md returned", typeof md === "string" && /What worked/.test(md), String(md).slice(0, 200))
  ok("md has repair", md.includes("Authorization header"))
  ok("md forbids kernel", /Do not edit forge kernel files/.test(md))
  ok("md forbids assumeYes", /Do not flip assumeYes/.test(md))
  eq("unknown name is null", readLearnedPlaybookByName(WORK, "learned_nope_missing"), null)
  eq("reserved name is null", readLearnedPlaybookByName(WORK, "bash"), null)
  eq("kernel playbook md is null", formatPlaybookMd(null), null)

  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v45-skills-"))
  const { exec } = makeToolContext({
    cwd: WORK, root: WORK, skillsDir, timeoutSec: 3, maxToolOutput: 4000,
    readOnly: true,
  })
  const out = await exec("load_skill", { name: authored.name })
  const text = typeof out === "string" ? out : String(out?.text ?? out ?? "")
  ok("load_skill returns playbook", /What worked/.test(text) && /Authorization header/.test(text), text.slice(0, 240))
  const miss = await exec("load_skill", { name: "definitely-missing-skill" })
  const missText = typeof miss === "string" ? miss : String(miss?.text ?? miss ?? "")
  ok("unknown skill still errors", /ERROR: skill not found/.test(missText), missText.slice(0, 160))
  try { fs.rmSync(skillsDir, { recursive: true, force: true }) } catch {}
}

console.log("== RECOVER chain skips rediscovery when playbook files known ==")
{
  const reg = defaultRegistry({})
  const cold = planChain("Fix the failing authentication test", { registry: reg, context: { cwd: WORK } })
  ok("cold recovery still greps", cold.active.some((s) => s.tool === "grep_files"), cold.active.map((s) => s.tool).join(" → "))
  ok("cold recovery still has regress", cold.active.some((s) => s.phase === "regress"))
  const hot = planChain("Fix the failing authentication test", {
    registry: reg,
    context: { cwd: WORK, playbookFiles: ["auth.js"] },
  })
  const tools = hot.active.map((s) => s.tool)
  const phases = hot.active.map((s) => s.phase)
  ok("hot recovery does not grep", !tools.includes("grep_files"), tools.join(" → "))
  ok("hot recovery inspects first", phases[0] === "inspect", phases.join(" → "))
  eq("hot inspect target", hot.active[0].target, "auth.js")
  ok("hot recovery edits", tools.includes("edit_file"))
  ok("hot recovery verifies", phases.includes("verify"))
  ok("hot recovery skips regress", !phases.includes("regress"))
  ok("hot chain is shorter than cold", hot.active.length < cold.active.length)
  eq("intent still RECOVER", hot.intent || INTENT.RECOVER, INTENT.RECOVER)
}

console.log("== compose source never spawns; command not auto-run ==")
{
  const src = fs.readFileSync(new URL("../compose.js", import.meta.url), "utf8")
  ok("compose does not import child_process", !/child_process/.test(src))
  ok("compose does not call loadLearnedPlugins", !/loadLearnedPlugins/.test(src))
  const evalSrc = fs.readFileSync(new URL("../evaluate.js", import.meta.url), "utf8")
  ok("evaluate does not import child_process", !/child_process/.test(evalSrc))
  ok("learned dir is not PLUGINS_DIR", learnedPluginsDir(WORK) !== PLUGINS_DIR)
}

console.log("== frozen kernel + package ==")
{
  const cfg = defaultConfig()
  eq("assumeYes stays false", cfg.tools.assumeYes, false)
  eq("allowSudo stays false", cfg.tools.allowSudo, false)
  eq("allowNewPlugins stays false", cfg.tools.allowNewPlugins, false)
  const { dropped } = sanitizeProjectConfig({ tools: { assumeYes: true, allowNewPlugins: true } })
  ok("project cannot flip assumeYes", dropped.includes("tools.assumeYes"))
  ok("project cannot flip allowNewPlugins", dropped.includes("tools.allowNewPlugins"))
  eq("classifyTaskComplexity frozen", classifyTaskComplexity("fix a typo"), "trivial")
  eq("typo still MICRO", classifyTask("fix a typo in README").class, TASK_CLASS.MICRO)
  eq("VERSION is 75.0.0", VERSION, "75.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  eq("package.json is 75.0.0", pkg.version, "75.0.0")
  ok("files includes extend.js", pkg.files.includes("extend.js"))
  ok("files includes evaluate.js", pkg.files.includes("evaluate.js"))
  ok("files includes compose.js", pkg.files.includes("compose.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
}

console.log(`\n== v45 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
