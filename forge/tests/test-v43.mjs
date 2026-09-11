#!/usr/bin/env node
/**
 * forge — v43 compose picks learned plugins.
 *
 * Sync PLAYBOOK index. Planner lists isolated names. Never spawn
 * plugin-host. Does not: flip assumeYes, flip allowNewPlugins, add a
 * runtime dep, spawn a second writer, change classifyTaskComplexity(),
 * write ~/.forge/tools, or weaken plugin-iso.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v43-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v43-work-"))
process.chdir(WORK)

const {
  authorPlugin, formatPluginMjs, learnedPluginsDir,
  indexLearnedPlugins, readLearnedPlaybook,
} = await import("../extend.js")
const { compose, formatCompose } = await import("../compose.js")
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

function listGlobalTools() {
  try { return fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")) } catch { return [] }
}

function writeLearned(name, extra = "") {
  const dir = learnedPluginsDir(WORK)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.mjs`)
  const src = formatPluginMjs({
    name,
    description: "debug failing authentication modules in production",
    task: TASK,
    repair: "set the Authorization header on the request",
    files: ["auth.js"],
    command: "npm test",
  }) + extra
  fs.writeFileSync(file, src)
  return file
}

console.log("== indexLearnedPlugins empty / skip junk ==")
{
  eq("empty project is []", indexLearnedPlugins(WORK).length, 0)
  eq("missing dir is []", indexLearnedPlugins(path.join(WORK, "no-such")).length, 0)
  const idx = indexLearnedPlugins(WORK)
  ok("index is a plain array", Array.isArray(idx) && typeof idx.then !== "function")
}

console.log("== authorPlugin then index (never execute) ==")
{
  const beforeGlobal = listGlobalTools()
  const hostBefore = fs.readFileSync(HOST, "utf8")
  const r = authorPlugin({
    cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM,
    repair: "set the Authorization header on the request",
    files: ["auth.js"], command: "npm test",
  })
  eq("authored ok", r.ok, true)
  const idx = indexLearnedPlugins(WORK)
  ok("index lists the learned plugin", idx.some((p) => p.name === r.name), idx.map((p) => p.name).join(","))
  const hit = idx.find((p) => p.name === r.name)
  eq("indexed isolated", hit?.isolated, true)
  eq("indexed readOnly", hit?.readOnly, true)
  eq("indexed source learned", hit?.source, "learned")
  ok("description mentions authentication", /authentication/i.test(hit?.description || ""))
  const book = readLearnedPlaybook(r.path)
  eq("playbook tool matches", book?.tool, r.name)
  ok("playbook repair is data", /Authorization header/.test(book?.repair || ""))
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
}

console.log("== trap file is indexed, never executed ==")
{
  const trap = writeLearned("learned_trap_auth", "\nprocess.exit(91)\nthrow new Error(\"executed\")\n")
  const before = process.exitCode
  const book = readLearnedPlaybook(trap)
  eq("trap playbook parsed", book?.tool, "learned_trap_auth")
  const idx = indexLearnedPlugins(WORK)
  ok("trap is in the index", idx.some((p) => p.name === "learned_trap_auth"))
  eq("process still running", process.exitCode ?? 0, before ?? 0)
  ok("trap file still on disk", fs.existsSync(trap))
}

console.log("== symlink / dotfile / non-learned skipped ==")
{
  const dir = learnedPluginsDir(WORK)
  const real = writeLearned("learned_real_auth")
  const link = path.join(dir, "learned_link_auth.mjs")
  try { fs.symlinkSync(real, link) } catch { /* platform may refuse */ }
  fs.writeFileSync(path.join(dir, ".learned_hidden.mjs"), formatPluginMjs({
    name: "learned_hidden", description: "debug failing authentication", task: TASK, repair: "x",
  }))
  fs.writeFileSync(path.join(dir, "helper.mjs"), formatPluginMjs({
    name: "helper", description: "debug failing authentication", task: TASK, repair: "x",
  }))
  fs.writeFileSync(path.join(dir, "learned_broken.mjs"), "const PLAYBOOK = { not json\n")
  const idx = indexLearnedPlugins(WORK)
  const names = idx.map((p) => p.name)
  ok("symlink skipped", !names.includes("learned_link_auth"))
  ok("dotfile skipped", !names.includes("learned_hidden") && !names.includes(".learned_hidden"))
  ok("non-learned_ skipped", !names.includes("helper"))
  ok("broken JSON skipped", !names.includes("learned_broken"))
  ok("real file kept", names.includes("learned_real_auth"))
  if (fs.existsSync(link)) {
    eq("readLearnedPlaybook skips symlink", readLearnedPlaybook(link), null)
  } else {
    ok("symlink create skipped on this platform", true)
  }
}

console.log("== cap via limit ==")
{
  writeLearned("learned_cap_one")
  writeLearned("learned_cap_two")
  writeLearned("learned_cap_three")
  const limited = indexLearnedPlugins(WORK, { limit: 2 })
  eq("limit 2 returns 2", limited.length, 2)
}

console.log("== compose picks learned plugins with no opts.plugins ==")
{
  const c = compose(TASK, { cwd: WORK, klass: TASK_CLASS.MEDIUM })
  ok("compose is sync", c && typeof c.then !== "function")
  ok("picks a learned plugin", c.plugins.some((p) => p.isolated && String(p.name || "").startsWith("learned_")), c.plugins.map((p) => p.name).join(","))
  const block = formatCompose(c)
  ok("format has [plugins]", /\[plugins\]/.test(block) && /learned_/.test(block), block)
  const off = compose(TASK, { cwd: WORK, klass: TASK_CLASS.MEDIUM, includePlugins: false })
  eq("includePlugins false is empty", off.plugins.length, 0)
}

console.log("== MICRO skip unless named; caller names win ==")
{
  const authored = indexLearnedPlugins(WORK).find((p) => p.name && p.name.startsWith("learned_"))
  ok("have a learned name to test", Boolean(authored?.name))
  const micro = compose("fix a typo in README", { cwd: WORK, klass: TASK_CLASS.MICRO })
  eq("MICRO zero auto isolated", micro.plugins.filter((p) => p.isolated).length, 0)
  const named = compose(`fix a typo using ${authored.name}`, { cwd: WORK, klass: TASK_CLASS.MICRO })
  ok("named MICRO keeps the plugin", named.plugins.some((p) => p.name === authored.name))
  const caller = compose(TASK, {
    cwd: WORK, klass: TASK_CLASS.MEDIUM,
    plugins: [{ name: authored.name, isolated: true, description: "caller wins authentication description", source: "caller" }],
  })
  const hit = caller.plugins.find((p) => p.name === authored.name)
  eq("caller source kept", hit?.source, "caller")
}

console.log("== compose source never spawns ==")
{
  const src = fs.readFileSync(path.join(HERE, "../compose.js"), "utf8")
  ok("compose does not import child_process", !/child_process/.test(src))
  ok("compose does not call loadLearnedPlugins", !/loadLearnedPlugins/.test(src))
  ok("compose does not call loadToolPlugins", !/loadToolPlugins/.test(src))
  ok("compose does not import()", !/\bimport\s*\(/.test(src))
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
  eq("VERSION is 69.0.0", VERSION, "69.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  eq("package.json is 69.0.0", pkg.version, "69.0.0")
  ok("files includes extend.js", pkg.files.includes("extend.js"))
  ok("files includes compose.js", pkg.files.includes("compose.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
}

console.log(`\n== v43 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
