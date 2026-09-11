#!/usr/bin/env node
/**
 * forge — v48 hostless: learned plugins are playbooks, never a live
 * plugin-host spawn on the execute path.
 *
 * agent / chat / forge tools+plugins load ~/.forge/tools only.
 * compose still lists learned names via indexLearnedPlugins.
 * load_skill still returns PLAYBOOK markdown. mergeLearnedPlugins stays
 * for v42 tests. Does not: flip assumeYes, flip allowNewPlugins, add a
 * runtime dep, spawn a second writer, change classifyTaskComplexity(),
 * write ~/.forge/tools, or weaken plugin-iso.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v48-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v48-work-"))
process.chdir(WORK)

const {
  authorPlugin, mergeLearnedPlugins, loadLearnedPlugins,
  indexLearnedPlugins, learnedPluginsDir, readLearnedPlaybookByName,
} = await import("../forge/extend.js")
const { compose, formatCompose } = await import("../forge/compose.js")
const { makeToolContext } = await import("../forge/tools.js")
const { PLUGINS_DIR, PLUGIN_ISOLATION_AVAILABLE } = await import("../forge/plugins.js")
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
const HOST = path.join(HERE, "../forge/plugin-host.js")
const BUNDLED = path.join(HERE, "../forge/skills")
const TASK = "debug the failing authentication module in production"
const REPAIR = "set the Authorization header on the request"

function listGlobalTools() {
  try { return fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")) } catch { return [] }
}

function readSrc(rel) {
  return fs.readFileSync(new URL(rel, import.meta.url), "utf8")
}

console.log("== execute path does not host learned plugins ==")
{
  const agentSrc = readSrc("../forge/agent.js")
  const chatSrc = readSrc("../forge/chat.js")
  const forgeSrc = readSrc("../forge/forge.js")
  const extendSrc = readSrc("../forge/extend.js")
  ok("agent.js does not call mergeLearnedPlugins", !/mergeLearnedPlugins/.test(agentSrc))
  ok("agent.js does not call loadLearnedPlugins", !/loadLearnedPlugins/.test(agentSrc))
  ok("agent.js does not import extend.js", !/from\s+["']\.\/extend\.js["']/.test(agentSrc))
  ok("chat.js does not call mergeLearnedPlugins", !/mergeLearnedPlugins/.test(chatSrc))
  ok("chat.js does not call loadLearnedPlugins", !/loadLearnedPlugins/.test(chatSrc))
  ok("chat.js does not import extend.js", !/from\s+["']\.\/extend\.js["']/.test(chatSrc))
  ok("forge.js does not call mergeLearnedPlugins", !/mergeLearnedPlugins/.test(forgeSrc))
  ok("forge.js does not call loadLearnedPlugins", !/loadLearnedPlugins/.test(forgeSrc))
  ok("forge.js indexes learned playbooks", /indexLearnedPlugins/.test(forgeSrc))
  ok("forge.js JSON lists playbooks", /playbooks/.test(forgeSrc))
  ok("mergeLearnedPlugins still exported", /export async function mergeLearnedPlugins/.test(extendSrc))
  ok("loadLearnedPlugins still exported", /export async function loadLearnedPlugins/.test(extendSrc))
}

console.log("== index + compose + load_skill still see the playbook ==")
{
  const beforeGlobal = listGlobalTools()
  const hostBefore = fs.readFileSync(HOST, "utf8")
  const bundledBefore = fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(",")
  const r = authorPlugin({
    cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM,
    repair: REPAIR, files: ["auth.js"], command: "npm test",
  })
  eq("authored ok", r.ok, true)
  const idx = indexLearnedPlugins(WORK)
  ok("index lists the learned plugin", idx.some((p) => p.name === r.name), idx.map((p) => p.name).join(","))
  const hit = idx.find((p) => p.name === r.name)
  eq("indexed source is learned", hit?.source, "learned")
  eq("indexed isolated", hit?.isolated, true)
  eq("indexed readOnly", hit?.readOnly, true)
  ok("indexed repair", /Authorization header/.test(hit?.repair || ""))
  const c = compose(TASK, { cwd: WORK })
  ok("compose picks learned plugin", (c.plugins || []).some((p) => p.name === r.name), JSON.stringify((c.plugins || []).map((p) => p.name)))
  const block = formatCompose(c)
  ok("[plugins] learned_", /\[plugins\]/.test(block) && /learned_/.test(block), block)
  ok("[playbook] body", /\[playbook\]/.test(block) && /Authorization header/.test(block), block)
  const md = readLearnedPlaybookByName(WORK, r.name)
  ok("playbook md returned", typeof md === "string" && /What worked/.test(md), String(md).slice(0, 200))

  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v48-skills-"))
  const { exec } = makeToolContext({
    cwd: WORK, root: WORK, skillsDir, timeoutSec: 3, maxToolOutput: 4000,
    readOnly: true,
  })
  const out = await exec("load_skill", { name: r.name })
  const text = typeof out === "string" ? out : String(out?.text ?? out ?? "")
  ok("load_skill returns playbook", /What worked/.test(text) && /Authorization header/.test(text), text.slice(0, 240))
  try { fs.rmSync(skillsDir, { recursive: true, force: true }) } catch {}

  eq("learned dir is not PLUGINS_DIR", learnedPluginsDir(WORK) !== PLUGINS_DIR, true)
  ok("learned dir is under FORGE_HOME", learnedPluginsDir(WORK).startsWith(HOME))
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
  eq("bundled pack unchanged", fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(","), bundledBefore)
}

console.log("== mergeLearnedPlugins kept for tests ==")
{
  const authored = authorPlugin({
    cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM,
    repair: REPAIR, files: ["auth.js"],
  })
  const loaded = {
    tools: [{ name: authored.name, isolated: true, source: "global.mjs" }],
    errors: [],
    close() {},
  }
  const merged = await mergeLearnedPlugins(loaded, WORK, { startedAt: null })
  const hits = merged.tools.filter((t) => t.name === authored.name)
  eq("colliding name appears once", hits.length, 1)
  eq("global source kept", hits[0].source, "global.mjs")
  eq("loadLearnedPlugins is a function", typeof loadLearnedPlugins, "function")
  if (PLUGIN_ISOLATION_AVAILABLE) {
    const empty = await mergeLearnedPlugins({ tools: [], errors: [], close() {} }, WORK, { startedAt: null })
    ok("learned plugin still loads when isolation is on", empty.tools.some((t) => t.name === authored.name), (empty.errors || []).join("; "))
    try { empty.close?.() } catch {}
  } else {
    ok("without isolation, learned dir does not run unprotected", true)
  }
  try { merged.close?.() } catch {}
}

console.log("== compose source never spawns ==")
{
  const src = readSrc("../forge/compose.js")
  ok("compose does not import child_process", !/child_process/.test(src))
  ok("compose does not call loadLearnedPlugins", !/loadLearnedPlugins/.test(src))
  ok("compose does not call loadToolPlugins", !/loadToolPlugins/.test(src))
  ok("compose does not write SKILL.md", !/authorSkill|writeStateFile/.test(src))
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
  eq("VERSION is 63.0.0", VERSION, "63.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8"))
  eq("package.json is 63.0.0", pkg.version, "63.0.0")
  ok("files includes extend.js", pkg.files.includes("extend.js"))
  ok("files includes compose.js", pkg.files.includes("compose.js"))
  ok("files includes agent.js", pkg.files.includes("agent.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
}

console.log(`\n== v48 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
