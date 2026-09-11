#!/usr/bin/env node
/**
 * forge — v57 priority: LEARN is the gap worth paying for.
 *
 * Cap 1 (2 only if both CRITICAL). FORGE_DATA_DIR aliases FORGE_HOME.
 * Does not: dump pages, flip assumeYes, add a runtime dep, spawn
 * plugin-host, change classifyTaskComplexity(), write ~/.forge/tools,
 * invent a second data root.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v57-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v57-work-"))
process.chdir(WORK)

const {
  detectGaps, priorityOf, pickLearn, planAcquire, METHOD, STATUS, IMPACT,
} = await import("../forge/knowgap.js")
const { compose, formatCompose } = await import("../forge/compose.js")
const { formatSteer, evaluateSkills } = await import("../forge/evaluate.js")
const { classifyTaskComplexity, classifyTask, TASK_CLASS } = await import("../forge/classify.js")
const { defaultConfig, sanitizeProjectConfig, resolveDataDir } = await import("../forge/config.js")
const { VERSION } = await import("../forge/version.js")
const { CATALOG } = await import("../forge/providers.js")
const { PLUGINS_DIR } = await import("../forge/plugins.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOST = path.join(HERE, "../forge/plugin-host.js")
const BUNDLED = path.join(HERE, "../forge/skills")
const PAY = "Build a production-quality payment system across files"
const PAY_CSS = "Build a production-quality payment system and tweak the css animation"

function listGlobalTools() {
  try { return fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")) } catch { return [] }
}

console.log("== priorityOf is deterministic ==")
{
  const unknownPay = { id: "payment", impact: IMPACT.CRITICAL, status: STATUS.UNKNOWN, learn: true, acquire: { method: METHOD.WEB, cost: 4 } }
  const skillPay = { ...unknownPay, acquire: { method: METHOD.SKILL, cost: 1 } }
  const ui = { id: "ui", impact: IMPACT.LOW, status: STATUS.SKIPPABLE, learn: false }
  const known = { id: "payment", impact: IMPACT.CRITICAL, status: STATUS.KNOWN }
  ok("skill beats web", priorityOf(skillPay) > priorityOf(unknownPay), `${priorityOf(skillPay)} vs ${priorityOf(unknownPay)}`)
  eq("skip is 0", priorityOf(ui), 0)
  eq("known is 0", priorityOf(known), 0)
  eq("empty is 0", priorityOf(null), 0)
  ok("recurrence raises score", priorityOf(unknownPay, { samples: 4, tried: ["web"] }) > priorityOf(unknownPay), "samples should raise")
}

console.log("== pickLearn cap ==")
{
  const a = { id: "payment", impact: IMPACT.CRITICAL, learn: true, acquire: { method: METHOD.SKILL, cost: 1 }, priority: 3 }
  const b = { id: "security", impact: IMPACT.CRITICAL, learn: true, acquire: { method: METHOD.SKILL, cost: 1 }, priority: 2.5 }
  const c = { id: "api", impact: "HIGH", learn: true, acquire: { method: METHOD.WEB, cost: 4 }, priority: 0.7 }
  const two = pickLearn([a, b, c])
  eq("two CRITICAL → 2", two.length, 2)
  ok("payment first", two[0].id === "payment")
  ok("security second", two[1].id === "security")
  ok("api not learned", !two.some((g) => g.id === "api"))
  const one = pickLearn([a, c])
  eq("one CRITICAL → 1", one.length, 1)
  eq("winner payment", one[0].id, "payment")
  eq("empty pick", pickLearn([]).length, 0)
}

console.log("== detectGaps LEARN is payment, not ui ==")
{
  const g = detectGaps(PAY_CSS, { klass: TASK_CLASS.LARGE, skills: [], world: { files: [] } })
  const learnIds = (g.learn || []).map((l) => l.id)
  ok("learn nonempty", learnIds.length > 0, JSON.stringify(learnIds))
  ok("learn cap <= 2", learnIds.length <= 2, JSON.stringify(learnIds))
  ok("payment or api learned", learnIds.includes("payment") || learnIds.includes("api"), JSON.stringify(learnIds))
  ok("ui not learned", !learnIds.includes("ui"), JSON.stringify(learnIds))
  ok("ui is skip", (g.skip || []).some((s) => s.id === "ui"), JSON.stringify(g.skip))
  const gapsStill = (g.gaps || []).map((x) => x.id)
  ok("other HIGH gaps still listed", gapsStill.includes("api") || gapsStill.includes("database"), JSON.stringify(gapsStill))
  const typo = detectGaps("fix a typo in README", { klass: TASK_CLASS.MICRO })
  eq("typo learn empty", (typo.learn || []).length, 0)
}

console.log("== compose snapshot respects cap ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v57-co-"))
  fs.writeFileSync(path.join(dir, "util.js"), "export const x = 1\n")
  const c = compose(PAY_CSS, { cwd: dir, includePlugins: false, klass: TASK_CLASS.LARGE })
  const n = (c.gaps?.learn || []).length
  ok("compose learn <= 2", n <= 2, n)
  ok("compose learn >= 1", n >= 1, JSON.stringify(c.gaps?.learn))
  const block = formatCompose(c)
  ok("formatCompose [learn]", /\[learn\]/.test(block), block)
  ok("no ui in learn line", !/\[learn\][^\n]*\bui\b/.test(block), block)
  eq("empty steer", formatSteer({}), "")
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== FORGE_DATA_DIR aliases FORGE_HOME, not a second tree ==")
{
  eq("FORGE_HOME wins", resolveDataDir({ FORGE_HOME: "/tmp/forge-a", FORGE_DATA_DIR: "/tmp/forge-b" }), "/tmp/forge-a")
  eq("FORGE_DATA_DIR used when no HOME", resolveDataDir({ FORGE_DATA_DIR: "/tmp/forge-b" }), "/tmp/forge-b")
  ok("default is ~/.forge", resolveDataDir({}).includes(".forge"), resolveDataDir({}))
  const cfg = fs.readFileSync(new URL("../forge/config.js", import.meta.url), "utf8")
  ok("no checkout data/ tree", !/agentv19\/forge\/data/.test(cfg))
  const kg = fs.readFileSync(new URL("../forge/knowgap.js", import.meta.url), "utf8")
  ok("knowgap still uses DEFAULT_DIR", /DEFAULT_DIR/.test(kg))
  ok("knowgap still uses projectDir", /projectDir/.test(kg))
}

console.log("== source: no fetch, compose write-free ==")
{
  const knowgap = fs.readFileSync(new URL("../forge/knowgap.js", import.meta.url), "utf8")
  const composeSrc = fs.readFileSync(new URL("../forge/compose.js", import.meta.url), "utf8")
  ok("priorityOf exported", /export function priorityOf/.test(knowgap))
  ok("pickLearn exported", /export function pickLearn/.test(knowgap))
  ok("knowgap has no fetch(", !/\bfetch\(/.test(knowgap))
  ok("knowgap has no child_process", !/child_process/.test(knowgap))
  ok("compose still no persistGaps", !/persistGaps/.test(composeSrc))
  ok("compose still no ingestAcquire call", !/ingestAcquire\(/.test(composeSrc))
  ok("evaluateSkills still exported", /export function evaluateSkills/.test(fs.readFileSync(new URL("../forge/evaluate.js", import.meta.url), "utf8")))
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
  eq("VERSION is 64.0.0", VERSION, "64.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8"))
  eq("package.json is 64.0.0", pkg.version, "64.0.0")
  ok("files includes knowgap.js", pkg.files.includes("knowgap.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
  eq("custom is still index 17 (pick 18)", CATALOG[17]?.name, "custom")
  eq("apinex still after custom", CATALOG[18]?.name, "apinex")
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
  eq("bundled pack unchanged", fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(","), bundledBefore)
}

console.log(`\n== v57 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
