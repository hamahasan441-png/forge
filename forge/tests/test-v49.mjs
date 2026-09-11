#!/usr/bin/env node
/**
 * forge — v49 check: INTENT.VERIFY uses focusedVerify.
 *
 * Native command + graph tests reach the VERIFY chain. Never auto-run.
 * Never invent flags. Does not: flip assumeYes, flip allowNewPlugins,
 * add a runtime dep, spawn a second writer, change
 * classifyTaskComplexity(), write ~/.forge/tools, or weaken plugin-iso.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v49-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v49-work-"))
process.chdir(WORK)

const { planChain, route, detectTestCommand, toolGuidance, INTENT } = await import("../router.js")
const { focusedVerify, runVerification } = await import("../verify.js")
const { compose, formatCompose } = await import("../compose.js")
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
const reg = defaultRegistry({})

function tmp(name, files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), name))
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(d, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  return d
}

function listGlobalTools() {
  try { return fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")) } catch { return [] }
}

console.log("== VERIFY on a JS project suggests npm test ==")
{
  const js = tmp("forge-v49-js-", {
    "package.json": JSON.stringify({ name: "a", scripts: { test: "node --test" } }),
    "util.js": "export function add(a, b) { return a + b }\n",
    "util.test.js": "import { add } from './util.js'\n",
  })
  const chain = planChain("run the tests", { registry: reg, context: { cwd: js } })
  eq("intent VERIFY", chain.intent, INTENT.VERIFY)
  eq("one verify step", chain.active.length, 1)
  eq("tool is bash", chain.active[0]?.tool, "bash")
  eq("phase verify", chain.active[0]?.phase, "verify")
  eq("args.command npm test", chain.active[0]?.args?.command, "npm test")
  ok("why names npm test", /npm test/.test(chain.active[0]?.why || ""), chain.active[0]?.why)
  const r = route({ task: "run the tests", registry: reg, context: { cwd: js } })
  eq("route tool bash", r.selected_tool, "bash")
  eq("route command npm test", r.arguments.command, "npm test")
  ok("no invented flag", !/--/.test(r.arguments.command || ""))
  const focus = focusedVerify(js, ["util.js"])
  eq("focusedVerify still npm test", focus.command, "npm test")
  try { fs.rmSync(js, { recursive: true, force: true }) } catch {}
}

console.log("== mixed npm+cargo: file stack wins ==")
{
  const mixed = tmp("forge-v49-mix-", {
    "package.json": JSON.stringify({ name: "a", scripts: { test: "vitest" } }),
    "app.js": "export const a = 1\n",
    "Cargo.toml": '[package]\nname = "x"\nedition = "2021"\n',
    "src/lib.rs": "pub fn x() -> u8 { 1 }\n",
  })
  const rust = planChain("verify src/lib.rs", { registry: reg, context: { cwd: mixed } })
  eq("rust intent VERIFY", rust.intent, INTENT.VERIFY)
  eq("rust command cargo test", rust.active[0]?.args?.command, "cargo test")
  const js = planChain("verify app.js", { registry: reg, context: { cwd: mixed } })
  eq("js command npm test", js.active[0]?.args?.command, "npm test")
  const viaPlay = planChain("run the tests", {
    registry: reg,
    context: { cwd: mixed, playbookFiles: ["src/lib.rs"] },
  })
  eq("playbook rust file → cargo test", viaPlay.active[0]?.args?.command, "cargo test")
  eq("1-arg detectTestCommand frozen", detectTestCommand(mixed), "npm test")
  const hinted = planChain("run the tests", {
    registry: reg,
    context: { cwd: mixed, verifyCommand: "pytest -q" },
  })
  eq("verifyCommand wins", hinted.active[0]?.args?.command, "pytest -q")
  try { fs.rmSync(mixed, { recursive: true, force: true }) } catch {}
}

console.log("== EXECUTE / regress / DISCOVER / cold chains frozen ==")
{
  const js = tmp("forge-v49-frz-", {
    "package.json": JSON.stringify({ name: "a", scripts: { test: "node --test" } }),
    "auth.js": "export function authenticate(){ return 1 }\n",
  })
  const exe = planChain("run echo hello", { registry: reg, context: { cwd: js, verifyCommand: "cargo test" } })
  eq("echo is EXECUTE", exe.intent, INTENT.EXECUTE)
  ok("EXECUTE has no focused args", !exe.active[0]?.args?.command, JSON.stringify(exe.active[0]))
  const rExe = route({ task: "run echo hello", registry: reg, context: { cwd: js, verifyCommand: "cargo test" } })
  ok("EXECUTE route does not inherit verifyCommand", rExe.arguments.command !== "cargo test", JSON.stringify(rExe.arguments))
  const recover = planChain("Fix the failing authentication test", { registry: reg, context: { cwd: js } })
  ok("cold RECOVER still greps", recover.active.some((s) => s.tool === "grep_files"), recover.active.map((s) => s.tool).join(" → "))
  ok("cold RECOVER still has regress", recover.active.some((s) => s.phase === "regress"))
  const regress = recover.active.find((s) => s.phase === "regress")
  ok("regress has no focused command", !regress?.args?.command, JSON.stringify(regress))
  const modify = planChain("update the retry logic", { registry: reg, context: { cwd: js } })
  ok("cold MODIFY still greps", modify.active.some((s) => s.tool === "grep_files"))
  const discover = planChain("Find where tokens are generated", {
    registry: reg,
    context: { cwd: js, playbookFiles: ["auth.js"], verifyCommand: "npm test" },
  })
  ok("DISCOVER still greps", discover.active.some((s) => s.tool === "grep_files"))
  eq("DISCOVER intent", discover.intent, INTENT.DISCOVER)
  try { fs.rmSync(js, { recursive: true, force: true }) } catch {}
}

console.log("== toolGuidance + compose [verify next] ==")
{
  const js = tmp("forge-v49-g-", {
    "package.json": JSON.stringify({ name: "a", scripts: { test: "node --test" } }),
    "util.js": "export function add(a, b) { return a + b }\n",
    "util.test.js": "import { add } from './util.js'\n",
  })
  const g = toolGuidance("run the tests", { registry: reg, cwd: js, verifyCommand: "npm test" })
  ok("guidance has suggested chain", /Suggested chain/.test(g), g)
  ok("guidance names verify", /verify/.test(g.toLowerCase()), g)
  const c = compose("run the tests in util.js", { cwd: js, includePlugins: false, includeLessons: false })
  ok("[verify next] still in compose", /\[verify next\]/.test(formatCompose(c)), formatCompose(c))
  ok("compose command npm test", (c.verify?.command || "") === "npm test", JSON.stringify(c.verify))
  try { fs.rmSync(js, { recursive: true, force: true }) } catch {}
}

console.log("== never auto-run; no spawn ==")
{
  const beforeGlobal = listGlobalTools()
  const hostBefore = fs.readFileSync(HOST, "utf8")
  const bundledBefore = fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(",")
  const src = fs.readFileSync(new URL("../router.js", import.meta.url), "utf8")
  ok("router does not call runVerification", !/runVerification\(/.test(src))
  ok("focusedHint does not invent -- flags", !/npm test --/.test(src))
  const composeSrc = fs.readFileSync(new URL("../compose.js", import.meta.url), "utf8")
  ok("compose does not import child_process", !/child_process/.test(composeSrc))
  ok("compose does not call loadLearnedPlugins", !/loadLearnedPlugins/.test(composeSrc))
  eq("runVerification is still exported", typeof runVerification, "function")
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
  eq("bundled pack unchanged", fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(","), bundledBefore)
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
  eq("VERSION is 70.0.0", VERSION, "70.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  eq("package.json is 70.0.0", pkg.version, "70.0.0")
  ok("files includes router.js", pkg.files.includes("router.js"))
  ok("files includes verify.js", pkg.files.includes("verify.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
}

console.log(`\n== v49 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
