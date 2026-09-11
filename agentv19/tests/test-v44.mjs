#!/usr/bin/env node
/**
 * forge — v44 playbook snapshot.
 *
 * Keep repair/files/command on the learned index. Cite playbook files
 * into the world. [playbook] reaches the noTools planner. Never spawn
 * plugin-host. Never auto-run the recorded command.
 * Does not: flip assumeYes, flip allowNewPlugins, add a runtime dep,
 * spawn a second writer, change classifyTaskComplexity(), write
 * ~/.forge/tools, or weaken plugin-iso.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v44-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v44-work-"))
process.chdir(WORK)

const {
  authorPlugin, formatPluginMjs, learnedPluginsDir, indexLearnedPlugins,
} = await import("../forge/extend.js")
const { compose, formatCompose } = await import("../forge/compose.js")
const { saveIndex } = await import("../forge/index.js")
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
const TASK = "debug the failing authentication module in production"
const REPAIR = "set the Authorization header on the request"

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

function writeLearned(dir, name, book) {
  const tools = learnedPluginsDir(dir)
  fs.mkdirSync(tools, { recursive: true })
  const file = path.join(tools, `${name}.mjs`)
  fs.writeFileSync(file, formatPluginMjs({ name, ...book }))
  return file
}

console.log("== index keeps repair / files / command ==")
{
  const beforeGlobal = listGlobalTools()
  const hostBefore = fs.readFileSync(HOST, "utf8")
  const r = authorPlugin({
    cwd: WORK, task: TASK, klass: TASK_CLASS.MEDIUM,
    repair: REPAIR, files: ["auth.js"], command: "npm test",
  })
  eq("authored ok", r.ok, true)
  const idx = indexLearnedPlugins(WORK)
  const hit = idx.find((p) => p.name === r.name)
  ok("indexed", Boolean(hit), JSON.stringify(idx.map((p) => p.name)))
  eq("repair kept", hit?.repair, REPAIR)
  ok("files include auth.js", (hit?.files || []).includes("auth.js"))
  eq("command kept", hit?.command, "npm test")
  eq("isolated", hit?.isolated, true)
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
}

console.log("== path traversal and kernel playbooks skipped ==")
{
  writeLearned(WORK, "learned_escape_auth", {
    description: "debug failing authentication modules in production",
    task: TASK,
    repair: REPAIR,
    files: ["../etc/passwd", "/tmp/x", "~/.ssh/id_rsa", "auth.js"],
    command: "npm test",
  })
  const esc = indexLearnedPlugins(WORK).find((p) => p.name === "learned_escape_auth")
  ok("escape plugin indexed", Boolean(esc))
  ok("relative auth.js kept", (esc?.files || []).includes("auth.js"))
  ok(".. dropped", !(esc?.files || []).some((f) => f.includes("..")))
  ok("absolute dropped", !(esc?.files || []).some((f) => f.startsWith("/") || f.startsWith("~")))
  writeLearned(WORK, "learned_kernel_auth", {
    description: "debug failing authentication modules in production",
    task: TASK,
    repair: "patch classifyTaskComplexity",
    files: ["auth.js"],
  })
  ok("kernel playbook not indexed", !indexLearnedPlugins(WORK).some((p) => p.name === "learned_kernel_auth"))
}

console.log("== compose cites playbook files; [playbook] reaches the planner ==")
{
  const c = compose(TASK, { cwd: WORK })
  ok("compose is sync", c && typeof c.then !== "function")
  ok("cites auth.js from playbook", (c.world?.files || []).includes("auth.js"), JSON.stringify(c.world?.files))
  ok("picks learned plugin", (c.plugins || []).some((p) => p.isolated && p.repair === REPAIR))
  const block = formatCompose(c)
  ok("format has [plugins]", /\[plugins\]/.test(block) && /learned_/.test(block), block)
  ok("format has [playbook]", /\[playbook\]/.test(block) && /Authorization header/.test(block), block)
  ok("format playbook names auth.js", /\[playbook\].*auth\.js/.test(block), block)
  ok("format playbook names npm test", /\[playbook\].*npm test/.test(block), block)
  const skipped = compose(TASK, { cwd: WORK, includePlugins: false })
  eq("includePlugins false has no plugins", skipped.plugins.length, 0)
  ok("includePlugins false does not cite playbook files", !(skipped.world?.files || []).includes("auth.js"))
}

console.log("== MICRO skip unless named ==")
{
  const c = compose("fix a typo in README", { cwd: WORK })
  eq("typo is MICRO", c.klass, TASK_CLASS.MICRO)
  eq("typo zero isolated", c.plugins.filter((p) => p.isolated).length, 0)
  ok("typo does not cite auth.js", !(c.world?.files || []).includes("auth.js"))
  ok("typo format has no playbook", !/\[playbook\]/.test(formatCompose(c)))
  const authored = indexLearnedPlugins(WORK).find((p) => p.repair === REPAIR)
  ok("have a learned name", Boolean(authored?.name), JSON.stringify(authored))
  const named = compose(`fix a typo using ${authored.name}`, { cwd: WORK })
  ok("named MICRO keeps plugin", named.plugins.some((p) => p.name === authored.name))
  ok("named MICRO cites playbook files", (named.world?.files || []).includes("auth.js"))
}

console.log("== playbook files drive verify; command is not auto-run ==")
{
  const dir = tmp("forge-v44-js-", {
    "package.json": JSON.stringify({
      name: "app",
      scripts: { test: "node -e \"require('fs').writeFileSync('RAN','1')\"" },
    }) + "\n",
    "auth.js": "export function ok() { return true }\n",
    "auth.test.js": "import { ok } from './auth.js'\n",
  })
  saveIndex(dir, {
    version: 1,
    files: {
      "auth.js": { mtime: Date.now(), size: 40, symbols: ["ok"], lang: "javascript", imports: [], test: false, contracts: [] },
      "auth.test.js": { mtime: Date.now(), size: 40, symbols: [], lang: "javascript", imports: ["./auth.js"], test: true, contracts: [] },
    },
  })
  authorPlugin({
    cwd: dir, task: TASK, klass: TASK_CLASS.MEDIUM,
    repair: REPAIR, files: ["auth.js"], command: "npm test",
  })
  const c = compose(TASK, { cwd: dir })
  ok("cites auth.js", (c.world?.files || []).includes("auth.js"))
  eq("verify command npm test", c.verify.command, "npm test")
  ok("verify tests include auth.test.js", (c.verify.tests || []).some((t) => /auth\.test\.js$/.test(t)))
  ok("format has [verify next] npm test", /\[verify next\] npm test/.test(formatCompose(c)))
  ok("npm test was NOT executed", !fs.existsSync(path.join(dir, "RAN")))
  ok("no invented npm test -- flag", !/--/.test(c.verify.command || ""))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log("== compose source never spawns ==")
{
  const src = fs.readFileSync(new URL("../forge/compose.js", import.meta.url), "utf8")
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
  eq("VERSION is 55.0.0", VERSION, "55.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8"))
  eq("package.json is 55.0.0", pkg.version, "55.0.0")
  ok("files includes extend.js", pkg.files.includes("extend.js"))
  ok("files includes compose.js", pkg.files.includes("compose.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
}

console.log(`\n== v44 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
