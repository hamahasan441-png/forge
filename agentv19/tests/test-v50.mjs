#!/usr/bin/env node
/**
 * forge — v50 once: compose snapshot reused for identical args.
 *
 * compose() stays uncached. composeOnce hits ===. refresh recomputes.
 * meta/agent/chat do not call compose(. context.js still does (generation
 * cache). Does not: flip assumeYes, flip allowNewPlugins, add a runtime
 * dep, spawn a second writer, change classifyTaskComplexity(), write
 * ~/.forge/tools, or weaken plugin-iso.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v50-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v50-work-"))
process.chdir(WORK)

const {
  compose, composeOnce, clearComposeOnce, formatCompose,
} = await import("../forge/compose.js")
const { PLUGINS_DIR } = await import("../forge/plugins.js")
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
const TASK = "debug the failing authentication module in util.js for production"

function listGlobalTools() {
  try { return fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")) } catch { return [] }
}

function tmp(name, files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), name))
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(d, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  return d
}

const JS_TREE = {
  "package.json": '{"name":"app","scripts":{"test":"node --test"}}\n',
  "util.js": "export function add(a, b) { return a + b }\n",
  "util.test.js": "import { add } from './util.js'\n",
}

console.log("== compose() stays uncached ==")
{
  clearComposeOnce()
  const dir = tmp("forge-v50-plain-", JS_TREE)
  const a = compose(TASK, { cwd: dir, includePlugins: false })
  const b = compose(TASK, { cwd: dir, includePlugins: false })
  ok("two compose() calls are distinct objects", a !== b)
  ok("both see util.js", (a.world.files || []).some((f) => /util\.js$/.test(f)))
  ok("second compose() still sees util.js", (b.world.files || []).some((f) => /util\.js$/.test(f)))
  eq("empty compose is empty", compose("").world.files.length, 0)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== composeOnce identical args hit ==")
{
  clearComposeOnce()
  const dir = tmp("forge-v50-once-", JS_TREE)
  const a = composeOnce(TASK, { cwd: dir, includePlugins: false })
  const b = composeOnce(TASK, { cwd: dir, includePlugins: false })
  ok("identical args return ===", a === b)
  ok("cached snap has util.js", (a.world.files || []).some((f) => /util\.js$/.test(f)))
  ok("format of cached snap has [world]", /\[world\]/.test(formatCompose(a)))
  ok("format of cached snap has [verify next]", /\[verify next\]/.test(formatCompose(a)))
  const other = composeOnce("fix a typo in README", { cwd: dir, includePlugins: false })
  ok("different task is not the hit", other !== a)
  eq("typo still MICRO", other.klass, TASK_CLASS.MICRO)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== refresh recomputes; flags are keys ==")
{
  clearComposeOnce()
  const dir = tmp("forge-v50-refresh-", JS_TREE)
  const a = composeOnce(TASK, { cwd: dir, includePlugins: false })
  const r = composeOnce(TASK, { cwd: dir, includePlugins: false, refresh: true })
  ok("refresh is a new object", r !== a)
  const again = composeOnce(TASK, { cwd: dir, includePlugins: false })
  ok("after refresh the store holds the new snap", again === r)
  const memOff = composeOnce(TASK, { cwd: dir, includePlugins: false, includeMemory: false })
  ok("includeMemory:false is a different key", memOff !== r)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== compose() sees a write; composeOnce without refresh does not ==")
{
  clearComposeOnce()
  const dir = tmp("forge-v50-stale-", {
    "package.json": '{"name":"app"}\n',
    "alpha.js": "export const a = 1\n",
  })
  const once = composeOnce("debug the failing module in alpha.js", { cwd: dir, includePlugins: false })
  const plain = compose("debug the failing module in alpha.js", { cwd: dir, includePlugins: false })
  fs.writeFileSync(path.join(dir, "beta.js"), "export const b = 2\n")
  const once2 = composeOnce("debug the failing module in alpha.js", { cwd: dir, includePlugins: false })
  ok("once without refresh is ===", once2 === once)
  const plain2 = compose("debug the failing module in alpha.js", { cwd: dir, includePlugins: false })
  ok("plain compose after write is a new object", plain2 !== plain)
  const fresh = composeOnce("debug the failing module in alpha.js", { cwd: dir, includePlugins: false, refresh: true })
  ok("refresh after write is a new object", fresh !== once)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== clearComposeOnce drops the hit ==")
{
  clearComposeOnce()
  const dir = tmp("forge-v50-clear-", JS_TREE)
  const a = composeOnce(TASK, { cwd: dir, includePlugins: false })
  clearComposeOnce()
  const b = composeOnce(TASK, { cwd: dir, includePlugins: false })
  ok("after clear, not ===", a !== b)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== cap 8 evicts the oldest ==")
{
  clearComposeOnce()
  const dir = tmp("forge-v50-cap-", JS_TREE)
  const first = composeOnce("debug the failing authentication module in production zero", { cwd: dir, includePlugins: false })
  for (let i = 1; i <= 8; i++) {
    composeOnce(`debug the failing authentication module in production ${i}`, { cwd: dir, includePlugins: false })
  }
  const again = composeOnce("debug the failing authentication module in production zero", { cwd: dir, includePlugins: false })
  ok("9th unique key evicts the first", again !== first)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== source: meta/agent/chat once; context stays compose() ==")
{
  const meta = fs.readFileSync(new URL("../forge/meta.js", import.meta.url), "utf8")
  const agent = fs.readFileSync(new URL("../forge/agent.js", import.meta.url), "utf8")
  const chat = fs.readFileSync(new URL("../forge/chat.js", import.meta.url), "utf8")
  const context = fs.readFileSync(new URL("../forge/context.js", import.meta.url), "utf8")
  const composeSrc = fs.readFileSync(new URL("../forge/compose.js", import.meta.url), "utf8")
  ok("meta does not call compose(", !/\bcompose\(/.test(meta))
  ok("meta imports composeOnce", /composeOnce/.test(meta))
  ok("meta clears the cache at task start", /clearComposeOnce\(/.test(meta))
  ok("meta evolve uses focusedVerify", /focusedVerify\(process\.cwd\(\), changedRel/.test(meta))
  ok("repairSegment does not call takeCompose", !/async function repairSegment[\s\S]*takeCompose\(/.test(meta))
  ok("agent does not call compose(", !/\bcompose\(/.test(agent))
  ok("agent calls composeOnce", /composeOnce\(/.test(agent))
  ok("chat does not call compose(", !/\bcompose\(/.test(chat))
  ok("chat calls composeOnce", /composeOnce\(/.test(chat))
  ok("context still calls compose()", /\bcompose\(/.test(context))
  ok("context does not import composeOnce", !/composeOnce/.test(context))
  ok("compose does not import child_process", !/child_process/.test(composeSrc))
  ok("compose does not call loadLearnedPlugins", !/loadLearnedPlugins/.test(composeSrc))
}

console.log("== no side writes / frozen kernel + package ==")
{
  const beforeGlobal = listGlobalTools()
  const hostBefore = fs.readFileSync(HOST, "utf8")
  const bundledBefore = fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(",")
  const cfg = defaultConfig()
  eq("assumeYes stays false", cfg.tools.assumeYes, false)
  eq("allowSudo stays false", cfg.tools.allowSudo, false)
  eq("allowNewPlugins stays false", cfg.tools.allowNewPlugins, false)
  const { dropped } = sanitizeProjectConfig({ tools: { assumeYes: true, allowNewPlugins: true } })
  ok("project cannot flip assumeYes", dropped.includes("tools.assumeYes"))
  ok("project cannot flip allowNewPlugins", dropped.includes("tools.allowNewPlugins"))
  eq("classifyTaskComplexity frozen", classifyTaskComplexity("fix a typo"), "trivial")
  eq("typo still MICRO", classifyTask("fix a typo in README").class, TASK_CLASS.MICRO)
  eq("VERSION is 65.0.0", VERSION, "65.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8"))
  eq("package.json is 65.0.0", pkg.version, "65.0.0")
  ok("files includes compose.js", pkg.files.includes("compose.js"))
  ok("files includes meta.js", pkg.files.includes("meta.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
  eq("bundled pack unchanged", fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(","), bundledBefore)
}

console.log(`\n== v50 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
