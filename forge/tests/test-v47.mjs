#!/usr/bin/env node
/**
 * forge — v47 know: index locate + graph impl + lesson playbook.
 *
 * Deep world / skill-forge / strategy / tool-intelligence / knowledge graph
 * as unused-wiring of the existing layers. Never spawn plugin-host. Never
 * auto-run tests. Does not: flip assumeYes, flip allowNewPlugins, add a
 * runtime dep, spawn a second writer, change classifyTaskComplexity(),
 * rewrite the world model, write ~/.forge/tools, or weaken plugin-iso.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v47-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v47-work-"))
process.chdir(WORK)

const { compose, formatCompose, playbookFilesOf } = await import("../compose.js")
const { formatSteer } = await import("../evaluate.js")
const { implForFiles, linkRecords, XEDGE } = await import("../xlang.js")
const { implOf } = await import("../memgraph.js")
const { planChain, INTENT } = await import("../router.js")
const { recordLesson } = await import("../lessons.js")
const { buildRepoMap } = await import("../repomap.js")
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
const BUNDLED = path.join(HERE, "../skills")
const TASK = "debug the failing authentication module in production"
const REPAIR = "set the Authorization header on the request"

function listGlobalTools() {
  try { return fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")) } catch { return [] }
}

console.log("== implForFiles (graph TEST → source) ==")
{
  const g = linkRecords([
    { rel: "auth.js", lang: "javascript", symbols: ["authenticate"], imports: [], test: false, config: false, contracts: [] },
    { rel: "auth.test.js", lang: "javascript", symbols: [], imports: ["./auth.js"], test: true, config: false, contracts: [] },
    { rel: "other.js", lang: "javascript", symbols: [], imports: [], test: false, config: false, contracts: [] },
  ])
  ok("graph has TEST edge", (g.edges || []).some((e) => e.kind === XEDGE.TEST || e.kind === XEDGE.IMPORT))
  const impl = implForFiles(["auth.test.js"], g)
  ok("test locates auth.js", impl.some((p) => /auth\.js$/.test(p)), JSON.stringify(impl))
  eq("non-test start is empty impl", implForFiles(["auth.js"], g).length, 0)
  eq("empty files", implForFiles([], g).length, 0)
  eq("empty graph", implForFiles(["auth.test.js"], { files: [], edges: [] }).length, 0)
  ok("implOf wraps", implOf(["auth.test.js"], g).some((p) => /auth\.js$/.test(p)))
}

console.log("== lesson know: high-confidence repair+files ==")
{
  const beforeGlobal = listGlobalTools()
  const hostBefore = fs.readFileSync(HOST, "utf8")
  const bundledBefore = fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(",")
  recordLesson({
    task: TASK,
    failure: "authentication tests failed on login",
    cause: "missing Authorization header",
    failedStrategy: "sleep and retry",
    successfulRepair: REPAIR,
    files: ["auth.js", "/etc/passwd", "../x.js", "~/secret.js"],
    confidence: 0.8,
  }, WORK)
  const c = compose(TASK, { cwd: WORK, includePlugins: false })
  ok("know attached", (c.know || []).some((k) => k.repair && /Authorization header/.test(k.repair)), JSON.stringify(c.know))
  ok("rel file kept", (c.know || []).some((k) => (k.files || []).includes("auth.js")))
  ok("abs dropped", (c.know || []).every((k) => !(k.files || []).includes("/etc/passwd")))
  ok("parent dropped", (c.know || []).every((k) => !(k.files || []).some((f) => f.includes(".."))))
  ok("home dropped", (c.know || []).every((k) => !(k.files || []).some((f) => f.startsWith("~"))))
  const block = formatCompose(c)
  ok("[know] in compose", /\[know\]/.test(block) && /Authorization header/.test(block), block)
  ok("world cites lesson file", (c.world.files || []).includes("auth.js"))
  ok("playbookFilesOf has auth.js", playbookFilesOf(c).includes("auth.js"))
  const off = compose(TASK, { cwd: WORK, includeLessons: false, includePlugins: false })
  eq("includeLessons false is empty know", (off.know || []).length, 0)
  const typo = compose("fix a typo in README", { cwd: WORK })
  eq("typo is MICRO", typo.klass, TASK_CLASS.MICRO)
  eq("typo zero know", (typo.know || []).length, 0)
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
  eq("bundled pack unchanged", fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(","), bundledBefore)
}

console.log("== low-confidence / kernel lessons skipped ==")
{
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v47-low-"))
  recordLesson({
    task: TASK,
    failure: "authentication tests failed on login",
    cause: "missing header",
    failedStrategy: "sleep",
    successfulRepair: REPAIR,
    files: ["auth.js"],
    confidence: 0.2,
  }, other)
  const low = compose(TASK, { cwd: other, includePlugins: false })
  eq("low confidence is not know", (low.know || []).length, 0)
  const kern = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v47-kern-"))
  recordLesson({
    task: TASK,
    failure: "authentication tests failed on login",
    cause: "kernel",
    failedStrategy: "sleep",
    successfulRepair: "flip assumeYes then retry",
    files: ["auth.js"],
    confidence: 0.9,
  }, kern)
  const k = compose(TASK, { cwd: kern, includePlugins: false })
  eq("kernel repair is not know", (k.know || []).length, 0)
  try { fs.rmSync(other, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(kern, { recursive: true, force: true }) } catch {}
}

console.log("== formatSteer: know is TRY FIRST when no plugin/skill playbook ==")
{
  const block = formatSteer({
    know: [{ name: "lesson-auth-js", repair: REPAIR, files: ["auth.js"] }],
  })
  ok("TRY FIRST", /TRY FIRST/.test(block), block)
  ok("names the repair", /Authorization header/.test(block), block)
  const pluginWins = formatSteer({
    plugins: [{ name: "learned_debug_failing_authentication", isolated: true, repair: "plugin body", files: ["auth.js"] }],
    know: [{ name: "lesson-auth-js", repair: REPAIR, files: ["auth.js"] }],
  })
  ok("plugin ranks above know", /TRY FIRST/.test(pluginWins) && /plugin body/.test(pluginWins), pluginWins)
  ok("plugin not lesson name", !/lesson-auth-js/.test(pluginWins.split("\n")[1] || ""), pluginWins)
  eq("empty steer", formatSteer({}), "")
}

console.log("== index locate: symbol match without a filename in the task ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v47-idx-"))
  fs.writeFileSync(path.join(dir, "authenticate.js"), "export function authenticate(){ return 1 }\n")
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app", scripts: { test: "node --test" } }))
  buildRepoMap(dir)
  const c = compose("debug the failing authenticate module in production", { cwd: dir, includePlugins: false, includeLessons: false })
  ok("cites authenticate.js from index", (c.world.files || []).some((f) => /authenticate\.js$/.test(f)), JSON.stringify(c.world.files))
  const typo = compose("fix a typo in README", { cwd: dir, includePlugins: false, includeLessons: false })
  eq("MICRO does not locate from index", (typo.world.files || []).some((f) => /authenticate\.js$/.test(f)), false)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== graph impl joins playbookFiles; MODIFY skips grep ==")
{
  fs.writeFileSync(path.join(WORK, "auth.js"), "export function authenticate(){ return 1 }\n")
  fs.writeFileSync(path.join(WORK, "auth.test.js"), "import { authenticate } from './auth.js'\n")
  fs.writeFileSync(path.join(WORK, "package.json"), JSON.stringify({ name: "app", scripts: { test: "node --test" } }))
  buildRepoMap(WORK)
  const c = compose("Fix the failing authentication test in auth.test.js", { cwd: WORK, includePlugins: false })
  ok("world includes test", (c.world.files || []).some((f) => /auth\.test\.js$/.test(f)), JSON.stringify(c.world.files))
  ok("world includes impl", (c.world.files || []).some((f) => /(^|\/)auth\.js$/.test(f)), JSON.stringify(c.world.files))
  const files = playbookFilesOf(c)
  ok("playbookFilesOf includes impl", files.some((f) => /(^|\/)auth\.js$/.test(f)), JSON.stringify(files))
  const reg = defaultRegistry({})
  const cold = planChain("update the retry logic", { registry: reg, context: { cwd: WORK } })
  ok("cold MODIFY still greps", cold.active.some((s) => s.tool === "grep_files"), cold.active.map((s) => s.tool).join(" → "))
  const hot = planChain("implement the login header", {
    registry: reg,
    context: { cwd: WORK, playbookFiles: files },
  })
  const tools = hot.active.map((s) => s.tool)
  ok("hot MODIFY does not grep", !tools.includes("grep_files"), tools.join(" → "))
  ok("hot inspects first", hot.active[0]?.phase === "inspect")
  const discover = planChain("Find where tokens are generated", {
    registry: reg,
    context: { cwd: WORK, playbookFiles: files },
  })
  ok("DISCOVER still greps", discover.active.some((s) => s.tool === "grep_files"))
  eq("hot intent MODIFY", hot.intent || INTENT.MODIFY, INTENT.MODIFY)
}

console.log("== compose source never spawns; command not auto-run ==")
{
  const src = fs.readFileSync(new URL("../compose.js", import.meta.url), "utf8")
  ok("compose does not import child_process", !/child_process/.test(src))
  ok("compose does not call loadLearnedPlugins", !/loadLearnedPlugins/.test(src))
  ok("compose does not write SKILL.md", !/authorSkill|writeStateFile/.test(src))
  const memSrc = fs.readFileSync(new URL("../memgraph.js", import.meta.url), "utf8")
  ok("memgraph does not import child_process", !/child_process/.test(memSrc))
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
  eq("VERSION is 72.0.0", VERSION, "72.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  eq("package.json is 72.0.0", pkg.version, "72.0.0")
  ok("files includes compose.js", pkg.files.includes("compose.js"))
  ok("files includes memgraph.js", pkg.files.includes("memgraph.js"))
  ok("files includes xlang.js", pkg.files.includes("xlang.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
}

console.log(`\n== v47 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
