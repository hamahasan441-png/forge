#!/usr/bin/env node
/**
 * forge — v73 cite: matching claims join compose [claims]. Read-only.
 *
 * MICRO skips unless named. Compose never writes claims.json.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v73-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v73-work-"))
process.chdir(WORK)

const { recordClaim, pickClaims, listClaims } = await import("../claims.js")
const { compose, formatCompose } = await import("../compose.js")
const { TASK_CLASS } = await import("../classify.js")
const { evaluateSkills } = await import("../evaluate.js")
const { classifyTaskComplexity, classifyTask } = await import("../classify.js")
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

console.log("== pickClaims MICRO skip unless named ==")
{
  recordClaim({ cwd: WORK, subject: "web-design", text: "Use a 12-column grid.", source: "skill" })
  const rows = listClaims(WORK)
  eq("large hits", pickClaims("responsive web-design layout", rows, { klass: TASK_CLASS.LARGE }).some((c) => c.subject === "web-design"), true)
  eq("typo MICRO empty", pickClaims("fix a typo in README", rows, { klass: TASK_CLASS.MICRO }).length, 0)
  eq("named MICRO one", pickClaims("web-design grid", rows, { klass: TASK_CLASS.MICRO }).length, 1)
}

console.log("== compose cites matching claim; MICRO empty; never writes ==")
{
  const snap = compose("responsive web-design layout", { cwd: WORK })
  eq("picked", snap.claims.some((c) => c.subject === "web-design"), true)
  const fmt = formatCompose(snap)
  ok("[claims] line", /\[claims\] web-design/.test(fmt), fmt)
  ok("names grid", /12-column/.test(fmt), fmt)
  const typo = compose("fix a typo in README", { cwd: WORK })
  eq("typo zero claims", typo.claims.length, 0)
  ok("typo format no [claims]", !/\[claims\]/.test(formatCompose(typo)))
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("compose imports pickClaims", /pickClaims/.test(composeSrc) && /listClaims/.test(composeSrc))
  ok("compose has no recordClaim", !/recordClaim/.test(composeSrc))
  ok("compose has no skilldl", !/skilldl/.test(composeSrc))
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
  eq("VERSION is 90.0.0", VERSION, "90.0.0")
  const pkg = JSON.parse(fs.readFileSync(path.join(FORGE, "package.json"), "utf8"))
  eq("package.json is 90.0.0", pkg.version, "90.0.0")
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
  eq("custom is still index 17 (pick 18)", CATALOG[17]?.name, "custom")
  eq("apinex still after custom", CATALOG[18]?.name, "apinex")
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
  eq("bundled pack unchanged", fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(","), bundledBefore)
  const todo = fs.readFileSync(path.join(FORGE, "TODO.md"), "utf8")
  eq("TODO still unchecked", (todo.match(/^- \[[xX]\]/gm) || []).length, 0)
  ok("no PLAN file", fs.readdirSync(FORGE).filter((n) => /^PLAN-v\d+\.md$/.test(n)).length === 0)
  ok("no ~/.forge/tools", !fs.existsSync(path.join(HOME, "tools")) || fs.readdirSync(path.join(HOME, "tools")).length === 0)
}

console.log(`\n== v73 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
