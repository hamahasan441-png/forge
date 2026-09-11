#!/usr/bin/env node
/**
 * forge — v60 blast: v33 graph as planner knowledge.
 *
 * blastFromWorld never walks. A miss is UNKNOWN. MICRO skips.
 * Graph-mapped tests beat web. Does not: dump pages, flip assumeYes,
 * rewrite xlang, add a runtime dep, write ~/.forge/tools.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v60-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v60-work-"))
process.chdir(WORK)

const { blastFromWorld, emptyBlast, formatBlast, formatBlastSteer } = await import("../forge/impact.js")
const { linkRecords } = await import("../forge/xlang.js")
const { compose, formatCompose, emptyCompose } = await import("../forge/compose.js")
const { planAcquire, METHOD, IMPACT, STATUS } = await import("../forge/knowgap.js")
const { formatSteer, evaluateSkills } = await import("../forge/evaluate.js")
const { classifyTaskComplexity, classifyTask, TASK_CLASS } = await import("../forge/classify.js")
const { defaultConfig, sanitizeProjectConfig } = await import("../forge/config.js")
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

function listGlobalTools() {
  try { return fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")) } catch { return [] }
}

function payGraph() {
  return linkRecords([
    { rel: "src/pay.js", lang: "javascript", symbols: ["charge"], imports: [], test: false, config: false, contracts: [] },
    { rel: "src/app.js", lang: "javascript", symbols: [], imports: ["./pay.js"], test: false, config: false, contracts: [] },
    { rel: "src/pay.test.js", lang: "javascript", symbols: [], imports: ["./pay.js"], test: true, config: false, contracts: [] },
  ])
}

console.log("== blastFromWorld is graph-only ==")
{
  eq("empty unknown", emptyBlast().unknown, true)
  const miss = blastFromWorld({ files: ["src/pay.js"], graph: { files: [], edges: [] } })
  eq("empty graph is unknown", miss.unknown, true)
  ok("unknown is not zero-dependents", miss.unknown === true && miss.importers.length === 0)
  const g = payGraph()
  const b = blastFromWorld({ files: ["src/pay.js"], graph: g, cwd: WORK })
  eq("known not unknown", b.unknown, false)
  ok("importer app.js", (b.importers || []).some((p) => /app\.js$/.test(p)), JSON.stringify(b.importers))
  ok("mapped test", (b.tests || []).some((p) => /pay\.test\.js$/.test(p)), JSON.stringify(b.tests))
  ok("radius >= 3", b.radius >= 3, b.radius)
  ok("scope nonempty", Array.isArray(b.scope) && b.scope.length > 0, JSON.stringify(b.scope))
  const line = formatBlast(b)
  ok("[blast] line", /\[blast\]/.test(line), line)
  ok("steer BLAST", /BLAST:/.test(formatBlastSteer(b)), formatBlastSteer(b))
  ok("hub warning", /hub as a leaf/.test(formatBlastSteer(b)))
  eq("unknown format empty", formatBlast(miss), "")
  const src = fs.readFileSync(new URL("../forge/impact.js", import.meta.url), "utf8")
  const fn = src.slice(src.indexOf("export function blastFromWorld"), src.indexOf("export function formatBlast"))
  ok("blastFromWorld does not walk", !/buildCrossGraph/.test(fn) && !/\bwalk\(/.test(fn), fn.slice(0, 200))
}

console.log("== planAcquire prefers mapped tests over web ==")
{
  const gap = { id: "payment", impact: IMPACT.CRITICAL, status: STATUS.UNKNOWN, learn: true }
  const web = planAcquire(gap, { skills: [], world: { files: [] } })
  eq("no graph is web", web?.method, METHOD.WEB)
  const g = payGraph()
  const b = blastFromWorld({ files: ["src/pay.js"], graph: g, cwd: WORK })
  const mapped = planAcquire(gap, { skills: [], world: { files: [] }, blast: b })
  eq("mapped is verify", mapped?.method, METHOD.VERIFY)
  ok("query is the test", /pay\.test\.js/.test(mapped?.query || ""), JSON.stringify(mapped))
  ok("not web_search", mapped?.tool !== "web_search")
  const skill = planAcquire(gap, {
    skills: [{ name: "forge-api", desc: "API" }],
    world: { files: [] },
    blast: b,
  })
  eq("skill still beats tests", skill?.method, METHOD.SKILL)
}

console.log("== compose MICRO skips blast; LARGE surfaces it ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v60-co-"))
  fs.writeFileSync(path.join(dir, "util.js"), "export const x = 1\n")
  const micro = compose("fix a typo in README", { cwd: dir, includePlugins: false, klass: TASK_CLASS.MICRO })
  ok("MICRO blast unknown", micro.blast?.unknown !== false, JSON.stringify(micro.blast))
  ok("typo format has no [blast]", !/\[blast\]/.test(formatCompose(micro)), formatCompose(micro))
  eq("empty compose blast unknown", emptyCompose().blast.unknown, true)
  eq("empty steer", formatSteer({}), "")
  const g = payGraph()
  const b = blastFromWorld({ files: ["src/pay.js"], graph: g, cwd: dir })
  const steer = formatSteer({ blast: b, gaps: { gaps: [{ id: "payment", impact: "CRITICAL", status: "UNKNOWN", learn: true }] } })
  ok("BLAST after GAPS", /GAPS:[\s\S]*BLAST:/.test(steer), steer)
  ok("do not dump in BLAST? hub", /hub as a leaf/.test(steer), steer)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== compose never walks / writes ==")
{
  const composeSrc = fs.readFileSync(new URL("../forge/compose.js", import.meta.url), "utf8")
  ok("compose imports blastFromWorld", /blastFromWorld/.test(composeSrc))
  ok("compose does not import buildCrossGraph", !/buildCrossGraph/.test(composeSrc))
  ok("compose still no persistGaps", !/persistGaps/.test(composeSrc))
  ok("compose still no writeStateFile", !/writeStateFile/.test(composeSrc))
  ok("agent passes blast", /blast: composed\?\.blast/.test(fs.readFileSync(new URL("../forge/agent.js", import.meta.url), "utf8")))
  ok("chat passes blast", /blast: composed\?\.blast/.test(fs.readFileSync(new URL("../forge/chat.js", import.meta.url), "utf8")))
  ok("meta passes blast", /blast: composed\.blast/.test(fs.readFileSync(new URL("../forge/meta.js", import.meta.url), "utf8")))
  ok("formatSteer accepts blast", /blast = null/.test(fs.readFileSync(new URL("../forge/evaluate.js", import.meta.url), "utf8")))
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
  eq("VERSION is 62.0.0", VERSION, "62.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8"))
  eq("package.json is 62.0.0", pkg.version, "62.0.0")
  ok("files includes impact.js", pkg.files.includes("impact.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
  eq("custom is still index 17 (pick 18)", CATALOG[17]?.name, "custom")
  eq("apinex still after custom", CATALOG[18]?.name, "apinex")
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
  eq("bundled pack unchanged", fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(","), bundledBefore)
}

console.log(`\n== v60 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
