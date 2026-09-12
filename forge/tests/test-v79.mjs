#!/usr/bin/env node
/**
 * forge — v79 complete: ZIP ingest, strategy 2.0, empirics, consolidate,
 * bench 2.0, planner role. Kernel frozen. Never auto-ACTIVE.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v79-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v79-work-"))
process.chdir(WORK)

const { makeStoreZip, extractSkillMdFromZip } = await import("../zipingest.js")
const { ingestLocal, listDownloads } = await import("../skilldl.js")
const { recordStrategy, pickStrategy, loadStrategies } = await import("../strategy.js")
const { recordModelOutcome, pickModelEmpiric } = await import("../empirics.js")
const { recordLesson, consolidateLessons, loadLessons } = await import("../lessons.js")
const { appendMemory, consolidateMemory, memoryEntries } = await import("../memory.js")
const { generateGapTest, runExperiment } = await import("../experiment.js")
const { relevantTools } = await import("../toolintel.js")
const { recordToolRun } = await import("../toolintel.js")
const { ROLES, roleIsReadOnly, roleCatalog } = await import("../agentmanager.js")
const { formatSteer } = await import("../evaluate.js")
const { BENCH_CASES, runBench } = await import("../bench.js")
const { SKILL_LIFE } = await import("../evolve.js")
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

const MD = `---
name: web-design
description: layout
---
# Web Design
## What worked
Use a 12-column grid.
`

console.log("== ZIP / folder ingest is CANDIDATE ==")
{
  const zip = makeStoreZip({ "pack/SKILL.md": MD, "README.txt": "nope" })
  const extracted = extractSkillMdFromZip(zip)
  eq("extract ok", extracted.ok, true)
  ok("extract body", /12-column/.test(extracted.text))
  const zipPath = path.join(WORK, "skill.zip")
  fs.writeFileSync(zipPath, zip)
  const ing = ingestLocal(zipPath)
  eq("ingest zip ok", ing.ok, true)
  eq("CANDIDATE", ing.lifecycle, SKILL_LIFE.CANDIDATE)
  eq("not ACTIVE", ing.lifecycle === SKILL_LIFE.ACTIVE, false)
  const folder = path.join(WORK, "skill-folder")
  fs.mkdirSync(path.join(folder, "nested"), { recursive: true })
  fs.writeFileSync(path.join(folder, "nested", "SKILL.md"), MD)
  const ing2 = ingestLocal(folder)
  eq("ingest folder ok", ing2.ok, true)
  ok("listed", listDownloads().length >= 2)
}

console.log("== strategy / empirics / consolidate / roles ==")
{
  recordStrategy({ cwd: WORK, name: "playbook-first", ok: true })
  recordStrategy({ cwd: WORK, name: "playbook-first", ok: true })
  recordStrategy({ cwd: WORK, name: "rediscover", ok: false })
  const picked = pickStrategy("use the playbook first on a repair", { cwd: WORK, klass: TASK_CLASS.MEDIUM })
  ok("picks playbook-first", picked.some((s) => s.name === "playbook-first"), JSON.stringify(picked))
  ok("strategy file", Object.keys(loadStrategies(WORK).items || {}).includes("playbook-first"))
  recordModelOutcome({ provider: "xai", model: "grok-4", ok: true, ms: 120 })
  const models = pickModelEmpiric({ candidates: [{ provider: "xai", model: "grok-4" }] })
  eq("empiric grok", models[0]?.model, "grok-4")
  recordLesson({ failure: "boom", failedStrategy: "retry", cause: "null", successfulRepair: "guard" }, WORK)
  recordLesson({ failure: "boom", failedStrategy: "retry", cause: "null", successfulRepair: "guard" }, WORK)
  const les = consolidateLessons(WORK)
  ok("lessons consolidated", les.after <= les.before)
  ok("lessons kept", loadLessons(WORK).length >= 1)
  appendMemory("project", "same note", WORK, { source: "test" })
  appendMemory("project", "same note", WORK, { source: "test" })
  const mem = consolidateMemory("project", WORK)
  ok("memory dedup", mem.after <= mem.before)
  ok("memory still has note", memoryEntries("project", WORK).some((e) => /same note/.test(e.text)))
  eq("planner read-only", roleIsReadOnly(ROLES.PLANNER), true)
  eq("coder writer", roleIsReadOnly(ROLES.CODER), false)
  ok("catalog has planner", roleCatalog().some((r) => r.role === "planner"))
}

console.log("== gap tests never invent; steer STRAT; bench 2.0 ==")
{
  eq("npm test skipped", generateGapTest({ id: "auth" }, { blast: { tests: ["npm test"] } }).ok, false)
  eq("explicit true", generateGapTest({ id: "auth" }, { command: "true" }).command, "true")
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v79-tools-"))
  recordToolRun({
    cwd: tdir, klass: TASK_CLASS.MEDIUM,
    records: [
      { tool: "bash", status: "failed", failure: "NOT_FOUND", duration_ms: 1 },
      { tool: "bash", status: "failed", failure: "NOT_FOUND", duration_ms: 1 },
      { tool: "bash", status: "failed", failure: "NOT_FOUND", duration_ms: 1 },
    ],
  })
  const avoided = relevantTools("debug the failing authentication module", { cwd: tdir, klass: TASK_CLASS.MEDIUM })
  ok("3-fail bash still avoided", avoided.avoid.some((t) => t.tool === "bash"), JSON.stringify(avoided))
  try { fs.rmSync(tdir, { recursive: true, force: true }) } catch {}
  const exp = runExperiment({ cwd: WORK, id: "testing", command: "true", generateSkill: false })
  eq("experiment pass", exp.ok, true)
  ok("experiment scored strategy", (loadStrategies(WORK).items?.experiment?.ok ?? 0) >= 1)
  const steer = formatSteer({ strategy: [{ name: "playbook-first", rate: 1 }], models: [{ model: "grok-4", rate: 1 }] })
  ok("STRAT line", /STRAT:/.test(steer) && /playbook-first/.test(steer), steer)
  ok("MODELS line", /MODELS:/.test(steer) && /grok-4/.test(steer), steer)
  ok("bench 16 cases", BENCH_CASES.length >= 16, BENCH_CASES.length)
  const summary = runBench({ cases: BENCH_CASES.slice(12) })
  eq("bench2 all pass", summary.failed, 0)
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("compose has no ingestLocal", !/ingestLocal/.test(composeSrc))
  ok("compose has no recordStrategy", !/recordStrategy/.test(composeSrc))
  ok("compose has no recordModelOutcome", !/recordModelOutcome/.test(composeSrc))
  const pluginsSrc = fs.readFileSync(path.join(FORGE, "plugins.js"), "utf8")
  ok("allow-net gated", /allow-net/.test(pluginsSrc) && /allowedNodeEnvironmentFlags/.test(pluginsSrc))
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
  ok("files includes zipingest.js", (pkg.files || []).includes("zipingest.js"))
  ok("files includes strategy.js", (pkg.files || []).includes("strategy.js"))
  ok("files includes empirics.js", (pkg.files || []).includes("empirics.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
  eq("custom is still index 17 (pick 18)", CATALOG[17]?.name, "custom")
  eq("apinex still after custom", CATALOG[18]?.name, "apinex")
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
  eq("bundled pack unchanged", fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(","), bundledBefore)
  const todo = fs.readFileSync(path.join(FORGE, "TODO.md"), "utf8")
  eq("TODO still unchecked", (todo.match(/^- \[[xX]\]/gm) || []).length, 0)
  ok("no PLAN file", fs.readdirSync(FORGE).filter((n) => /^PLAN-v\d+\.md$/.test(n)).length === 0)
  ok("Never list kept", /Research crawler/.test(todo) && /Auto-ACTIVE/.test(todo))
  ok("L6 kept", /isolated worktree/.test(todo))
  ok("no ~/.forge/tools", !fs.existsSync(path.join(HOME, "tools")) || fs.readdirSync(path.join(HOME, "tools")).length === 0)
}

console.log(`\n== v79 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
