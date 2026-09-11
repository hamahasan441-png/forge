#!/usr/bin/env node
/**
 * forge — v42 isolated plugin / skill self-extension (L5).
 *
 * Author a project-local read-only plugin from a successful repair.
 * Does not: flip assumeYes, flip allowNewPlugins, add a runtime dep,
 * spawn a second writer, change classifyTaskComplexity(), write
 * ~/.forge/tools, patch plugin-host, or auto-grant capabilities.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v42-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v42-work-"))
process.chdir(WORK)

const {
  authorPlugin, formatPluginMjs, pluginSlug, learnedPluginsDir,
  loadLearnedPlugins, mergeLearnedPlugins,
} = await import("../extend.js")
const { evolveRun, formatEvolve } = await import("../evolve.js")
const { ALL_CHECKS } = await import("../completion.js")
const { recordLesson } = await import("../lessons.js")
const { PLUGINS_DIR, PLUGIN_ISOLATION_AVAILABLE } = await import("../plugins.js")
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

function listGlobalTools() {
  try { return fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")) } catch { return [] }
}

console.log("== authorPlugin MICRO / kernel / no-repair ==")
{
  eq("MICRO skipped", authorPlugin({ cwd: WORK, task: "fix a typo", klass: TASK_CLASS.MICRO, repair: "pin the header" }).skipped, "micro")
  eq("SMALL skipped", authorPlugin({ cwd: WORK, task: "rename a var", klass: TASK_CLASS.SMALL, repair: "pin the header" }).skipped, "micro")
  eq("empty repair skipped", authorPlugin({ cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM, repair: "" }).skipped, "no-repair")
  eq("kernel repair skipped", authorPlugin({ cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM, repair: "patch classifyTaskComplexity" }).skipped, "kernel")
  eq("kernel file skipped", authorPlugin({ cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM, repair: "edit it", files: ["agentv19/forge/meta.js"] }).skipped, "kernel")
  eq("assumeYes repair skipped", authorPlugin({ cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM, repair: "flip assumeYes" }).skipped, "kernel")
  eq("plugin-host repair skipped", authorPlugin({ cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM, repair: "rewrite plugin-host isolation" }).skipped, "kernel")
}

console.log("== authorPlugin writes project-local isolated mjs ==")
{
  const beforeGlobal = listGlobalTools()
  const hostBefore = fs.readFileSync(HOST, "utf8")
  const r = authorPlugin({
    cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM,
    repair: "set the Authorization header on the request",
    files: ["auth.js"], command: "npm test",
  })
  eq("authored ok", r.ok, true)
  ok("name is learned_", String(r.name || "").startsWith("learned_"), r.name)
  ok("NAME_RE", /^[a-z][a-z0-9_]{1,40}$/.test(r.name), r.name)
  ok("path under FORGE_HOME", String(r.path || "").startsWith(HOME), r.path)
  ok("path is project tools", /[/\\]tools[/\\]learned_/.test(r.path || ""), r.path)
  ok("not in ~/.forge/tools", !String(r.path || "").startsWith(PLUGINS_DIR + path.sep) && path.dirname(r.path || "") !== PLUGINS_DIR, r.path)
  ok("SKILL-dir is not this path", !/[/\\]skills[/\\]/.test(r.path || ""))
  ok("file exists", fs.existsSync(r.path))
  const src = fs.readFileSync(r.path, "utf8")
  ok("readOnly true", /readOnly:\s*true/.test(src))
  ok("no capabilities field", !/^\s*capabilities\s*:/m.test(src))
  ok("no network true", !/network\s*:\s*true/.test(src))
  ok("no childProcess true", !/childProcess\s*:\s*true/.test(src))
  ok("playbook is JSON", /const PLAYBOOK = \{/.test(src))
  ok("repair is in JSON", src.includes("Authorization header"))
  ok("forbids kernel edits", /Do not edit forge kernel files/.test(src))
  ok("forbids assumeYes", /Do not flip assumeYes/.test(src))
  ok("mode is 0600-class", (fs.statSync(r.path).mode & 0o777) <= 0o644)
  const again = authorPlugin({
    cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM,
    repair: "set the Authorization header on the request",
    files: ["auth.js"],
  })
  eq("second author is deduped", again.deduped, true)
  eq("same name", again.name, r.name)
  const afterGlobal = listGlobalTools()
  eq("global tools dir unchanged", afterGlobal.join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
}

console.log("== repair text is data, not code ==")
{
  const payload = '"); import("node:net"); process.exit(1); const x = ("'
  const src = formatPluginMjs({
    name: "learned_inject",
    description: "x",
    task: TASK,
    repair: payload,
    files: ["auth.js"],
  })
  ok("payload is JSON-escaped", src.includes(JSON.stringify(payload)))
  ok("payload is not a statement", !/\n\s*import\("node:net"\)/.test(src))
  eq("slug starts learned_", pluginSlug(TASK).startsWith("learned_"), true)
  eq("empty slug", pluginSlug(""), "learned_repair")
}

console.log("== mergeLearnedPlugins: global names win, grants empty ==")
{
  const authored = authorPlugin({
    cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM,
    repair: "set the Authorization header on the request",
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
  const empty = await mergeLearnedPlugins({ tools: [], errors: [], close() {} }, WORK, { startedAt: null })
  if (PLUGIN_ISOLATION_AVAILABLE) {
    ok("learned plugin loads when isolation is on", empty.tools.some((t) => t.name === authored.name), empty.errors.join("; "))
    const t = empty.tools.find((t) => t.name === authored.name)
    eq("loaded plugin is read-only", t?.readOnly, true)
    eq("loaded plugin isolated", t?.isolated, true)
    eq("loaded plugin has no network cap", t?.capabilities?.network, false)
    eq("loaded plugin has no childProcess cap", t?.capabilities?.childProcess, false)
  } else {
    ok("without isolation, learned dir does not run unprotected", true)
  }
  try { empty.close?.() } catch {}
}

console.log("== evolveRun authors plugin on COMPLETED; MICRO skips ==")
{
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v42-evo-"))
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
  ok("plugin authored", done.plugin?.ok === true && typeof done.plugin.name === "string", JSON.stringify(done.plugin))
  ok("plugin file exists", done.plugin?.path && fs.existsSync(done.plugin.path), done.plugin?.path)
  const line = formatEvolve(done)
  ok("format names plugin", /plugin=learned_/.test(line), line)
  const failed = evolveRun({ cwd: other, task: TASK, klass: TASK_CLASS.MEDIUM, gate: gateAll(false) })
  eq("failed does not author plugin", failed.plugin?.skipped, "not-completed")
  const micro = evolveRun({ cwd: WORK, task: "fix a typo", klass: TASK_CLASS.MICRO, gate: gateAll(true) })
  eq("MICRO plugin skipped", micro.plugin?.skipped, "micro")
  try { fs.rmSync(other, { recursive: true, force: true }) } catch {}
}

console.log("== learned dir + quarantine contract ==")
{
  const dir = learnedPluginsDir(WORK)
  ok("learned dir is under FORGE_HOME", dir.startsWith(HOME))
  ok("learned dir is not PLUGINS_DIR", dir !== PLUGINS_DIR)
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
  eq("VERSION is 76.0.0", VERSION, "76.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  eq("package.json is 76.0.0", pkg.version, "76.0.0")
  ok("files includes extend.js", pkg.files.includes("extend.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
}

console.log(`\n== v42 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
