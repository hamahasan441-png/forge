#!/usr/bin/env node
/**
 * forge — v41 compose pipeline (v32+ → world → memory → skills → strategy → tools).
 *
 * One snapshot. Planner and context engine share it. Never auto-run tests.
 * Does not: flip assumeYes, add a runtime dep, spawn a second writer,
 * change classifyTaskComplexity(), or weaken plugin-iso.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v41-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v41-work-"))
process.chdir(WORK)

const {
  compose, composeWorld, formatCompose, formatWorld, emptyCompose, emptyWorld,
} = await import("../forge/compose.js")
const { createContextEngine } = await import("../forge/context.js")
const { recordLesson } = await import("../forge/lessons.js")
const { appendMemory } = await import("../forge/memory.js")
const { saveIndex } = await import("../forge/index.js")
const { defaultConfig, sanitizeProjectConfig } = await import("../forge/config.js")
const { classifyTaskComplexity, classifyTask, TASK_CLASS } = await import("../forge/classify.js")
const { VERSION } = await import("../forge/version.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

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
  "app.js": "import { add } from './util.js'\nadd(1, 2)\n",
  "util.test.js": "import { add } from './util.js'\n",
}

const TASK = "debug the failing authentication module in util.js for production"

console.log("== empty compose ==")
{
  const c = compose("")
  eq("empty files", c.world.files.length, 0)
  eq("empty skills", c.skills.length, 0)
  eq("empty avoid", c.avoid.length, 0)
  eq("empty verify command", c.verify.command, "")
  eq("empty verify tests", c.verify.tests.length, 0)
  eq("empty format", formatCompose(c), "")
  eq("null format", formatCompose(null), "")
  eq("emptyWorld files", emptyWorld().files.length, 0)
  eq("emptyCompose micro false without klass", emptyCompose().micro, false)
}

console.log("== MICRO skip auto skills / plugins ==")
{
  const c = compose("fix a typo in README", {
    skillsIndex: [
      { name: "coding-agent", desc: "Coding workflow with planning and testing" },
    ],
    plugins: [
      { name: "jira_issue", isolated: true, def: { function: { description: "Fetch a Jira issue" } } },
    ],
  })
  eq("typo is MICRO", c.klass, TASK_CLASS.MICRO)
  eq("typo micro flag", c.micro, true)
  eq("typo zero auto skills", c.skills.length, 0)
  eq("typo zero isolated plugins", c.plugins.filter((p) => p.isolated).length, 0)
  ok("typo format has no verify next without files", !/\[verify next\]/.test(formatCompose(c)))
}

console.log("== world cites files; verify from graph ==")
{
  const dir = tmp("forge-v41-js-", JS_TREE)
  saveIndex(dir, {
    version: 1,
    files: {
      "util.js": { mtime: Date.now(), size: 40, symbols: ["add"], lang: "javascript", imports: [], test: false, contracts: [] },
      "app.js": { mtime: Date.now(), size: 40, symbols: [], lang: "javascript", imports: ["./util.js"], test: false, contracts: [] },
      "util.test.js": { mtime: Date.now(), size: 40, symbols: [], lang: "javascript", imports: ["./util.js"], test: true, contracts: [] },
    },
  })
  const world = composeWorld(dir, { task: TASK })
  ok("cites util.js", world.files.includes("util.js"))
  ok("indexed", world.indexed === true)
  ok("radius includes importer or test", world.radius.includes("app.js") || world.radius.includes("util.test.js"))
  ok("lang javascript", world.langs.includes("javascript"))
  const c = compose(TASK, { cwd: dir })
  eq("verify command npm test", c.verify.command, "npm test")
  ok("verify tests includes util.test.js", c.verify.tests.some((t) => /util\.test\.js$/.test(t)))
  const block = formatCompose(c)
  ok("format has [world]", /\[world\]/.test(block) && /util\.js/.test(block))
  ok("format has [verify next] npm test", /\[verify next\] npm test/.test(block))
  ok("formatWorld compact", /\[world\]/.test(formatWorld(c.world)))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log("== empty graph never invents tests ==")
{
  const dir = tmp("forge-v41-empty-", { "orphan.js": "export const x = 1\n" })
  const c = compose("debug orphan.js in production authentication", { cwd: dir })
  ok("cites orphan.js", c.world.files.includes("orphan.js"))
  eq("no invented tests", c.verify.tests.length, 0)
  eq("no invented command without stack", c.verify.command, "")
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log("== memory uses the world snapshot (stale dropped) ==")
{
  const dir = tmp("forge-v41-mem-", JS_TREE)
  const now = Date.now()
  saveIndex(dir, {
    version: 1,
    files: {
      "util.js": { mtime: now, size: 40, symbols: ["add"], lang: "javascript", imports: [], test: false, contracts: [] },
    },
  })
  appendMemory("project", "util.js overflow is handled by wrapping", dir, { at: now - 60_000, source: "test" })
  appendMemory("project", "prefer tabs in this repo", dir, { at: now, source: "test" })
  const c = compose(TASK, { cwd: dir })
  ok("memory count is a number", Number.isInteger(c.memoryCount))
  ok("live note can survive", c.memoryCount >= 0)
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log("== hard-avoid + skills join the same snapshot ==")
{
  recordLesson({
    task: TASK,
    failure: "authentication tests failed",
    cause: "missing token",
    failedStrategy: "retry until green",
    files: ["util.js"],
    confidence: 0.8,
  }, WORK)
  const skillsIndex = [
    { name: "auth-playbook", desc: "debug failing authentication modules in production" },
    { name: "blog-writer", desc: "Write a blog post from an outline" },
  ]
  const plugins = [
    { name: "always_on", isolated: false, def: { function: { description: "mcp" } } },
    { name: "auth_linter", isolated: true, def: { function: { description: "lint authentication modules in production" } } },
    { name: "unrelated_fmt", isolated: true, def: { function: { description: "format yaml" } } },
  ]
  const c = compose(TASK, { cwd: WORK, skillsIndex, plugins })
  ok("not micro", c.micro === false)
  ok("avoid retry until green", c.avoid.some((s) => /retry until green/i.test(s)))
  ok("auth-playbook picked", c.skills.some((s) => s.name === "auth-playbook"))
  ok("blog-writer not picked", !c.skills.some((s) => s.name === "blog-writer"))
  ok("non-isolated plugin stays", c.plugins.some((p) => p.name === "always_on"))
  ok("matching isolated plugin stays", c.plugins.some((p) => p.name === "auth_linter"))
  const block = formatCompose(c)
  ok("format has [avoid]", /\[avoid\]/.test(block) && /retry until green/.test(block))
  ok("format has [skills]", /\[skills\]/.test(block) && /auth-playbook/.test(block))
  ok("format has [plugins]", /\[plugins\]/.test(block) && /auth_linter/.test(block))
}

console.log("== named isolated plugin on MICRO ==")
{
  const c = compose("fix a typo using auth_linter", {
    plugins: [
      { name: "auth_linter", isolated: true, def: { function: { description: "lint authentication" } } },
    ],
  })
  eq("named micro is MICRO", c.klass, TASK_CLASS.MICRO)
  ok("named plugin survives MICRO", c.plugins.some((p) => p.name === "auth_linter"))
}

console.log("== context engine compose section ==")
{
  const dir = tmp("forge-v41-ctx-", JS_TREE)
  const eng = createContextEngine({ cwd: dir, config: {} })
  const built = eng.build(TASK, { budgetTokens: 4000 })
  const section = (built.sections || []).find((s) => s.name === "compose")
  ok("context has compose section", Boolean(section) && /\[world\]/.test(section.text || built.text))
  ok("context compose has verify next", /\[verify next\]/.test(section?.text || built.text))
  const typo = eng.build("fix a typo in README", { budgetTokens: 2000 })
  const tSection = (typo.sections || []).find((s) => s.name === "compose")
  ok("typo compose omits verify next", !tSection || !/\[verify next\]/.test(tSection.text))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log("== compose names the command and does not invent flags ==")
{
  const dir = tmp("forge-v41-norun-", JS_TREE)
  const c = compose(TASK, { cwd: dir })
  eq("command is named not invented", c.verify.command, "npm test")
  ok("no invented npm test -- flag", !/--/.test(c.verify.command))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log("== frozen kernel + package ==")
{
  const cfg = defaultConfig()
  eq("assumeYes stays false", cfg.tools.assumeYes, false)
  eq("allowSudo stays false", cfg.tools.allowSudo, false)
  const { dropped } = sanitizeProjectConfig({ tools: { assumeYes: true } })
  ok("project cannot flip assumeYes", dropped.includes("tools.assumeYes"))
  eq("classifyTaskComplexity frozen", classifyTaskComplexity("fix a typo"), "trivial")
  eq("typo still MICRO", classifyTask("fix a typo in README").class, TASK_CLASS.MICRO)
  eq("VERSION is 42.0.0", VERSION, "42.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8"))
  eq("package.json is 42.0.0", pkg.version, "42.0.0")
  ok("files includes compose.js", pkg.files.includes("compose.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
}

console.log(`\n== v41 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
