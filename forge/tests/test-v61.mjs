#!/usr/bin/env node
/**
 * forge — v61 todo: shipped PLAN files are gone; leftovers are unchecked.
 *
 * Does not: flip assumeYes, add a runtime dep, write ~/.forge/tools,
 * change classifyTaskComplexity(), invent a second data root.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v61-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v61-work-"))
process.chdir(WORK)

const { evaluateSkills } = await import("../evaluate.js")
const { classifyTaskComplexity, classifyTask, TASK_CLASS } = await import("../classify.js")
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

console.log("== completed PLAN files are gone ==")
{
  const plans = fs.readdirSync(FORGE).filter((n) => /^PLAN-v\d+\.md$/.test(n))
  eq("no PLAN-vN.md", plans.length, 0)
  ok("TODO.md exists", fs.existsSync(path.join(FORGE, "TODO.md")))
  const todo = fs.readFileSync(path.join(FORGE, "TODO.md"), "utf8")
  ok("TODO says not completed", /not completed/i.test(todo))
  ok("TODO forbids keeping shipped plans", /do not keep a PLAN/i.test(todo) || /do not keep a plan file/i.test(todo))
  const checked = (todo.match(/^- \[[xX]\]/gm) || []).length
  eq("no checked items", checked, 0)
  const open = (todo.match(/^- \[ \]/gm) || []).length
  ok("has open todos", open >= 5, open)
  ok("skill forge leftover", /Research crawler/.test(todo))
  ok("STALE leftover", /isolated worktree|chat-compact/.test(todo))
  ok("kernel leftover", /isolated worktree/.test(todo))
  ok("never crawler", /Research crawler/.test(todo))
}

console.log("== CHANGELOG no longer points at a living PLAN file ==")
{
  const cl = fs.readFileSync(path.join(FORGE, "CHANGELOG.md"), "utf8")
  ok("v61 section", /## v61\.0\.0/.test(cl))
  ok("v61 names TODO.md", /leftovers live in TODO\.md/.test(cl))
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
  eq("VERSION is 88.0.0", VERSION, "88.0.0")
  const pkg = JSON.parse(fs.readFileSync(path.join(FORGE, "package.json"), "utf8"))
  eq("package.json is 88.0.0", pkg.version, "88.0.0")
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
  eq("custom is still index 17 (pick 18)", CATALOG[17]?.name, "custom")
  eq("apinex still after custom", CATALOG[18]?.name, "apinex")
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
  eq("bundled pack unchanged", fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(","), bundledBefore)
}

console.log(`\n== v61 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
