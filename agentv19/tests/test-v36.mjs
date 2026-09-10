#!/usr/bin/env node
/**
 * forge — v36 graph-aware memory invalidation.
 *
 * UNIFIED §9 / §33: Memory is historical; the index+graph is current truth.
 * Does not: flip assumeYes, add a runtime dep, spawn a second writer,
 * change classifyTaskComplexity(), or delete memory from disk.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v36-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v36-work-"))
process.chdir(WORK)

const {
  filesCited, radiusOf, expandWrites, graphFromIndex, entryIsStale, worldFromIndex,
} = await import("../forge/memgraph.js")
const { linkRecords } = await import("../forge/xlang.js")
const { relevantMemory, appendMemory, projectDir } = await import("../forge/memory.js")
const { lessonIsStale } = await import("../forge/lessons.js")
const { defaultConfig, sanitizeProjectConfig } = await import("../forge/config.js")
const { classifyTaskComplexity, classifyTask, TASK_CLASS } = await import("../forge/classify.js")
const { VERSION } = await import("../forge/version.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

const GRAPH_RECS = [
  { rel: "util.js", lang: "javascript", symbols: ["add"], imports: [], test: false, contracts: [] },
  { rel: "app.js", lang: "javascript", symbols: [], imports: ["./util.js"], test: false, contracts: [] },
  { rel: "util.test.js", lang: "javascript", symbols: [], imports: ["./util.js"], test: true, contracts: [] },
]
const GRAPH = linkRecords(GRAPH_RECS)

console.log("== filesCited ==")
{
  eq("prefs cite nothing", filesCited("prefer tabs").length, 0)
  ok("cites util.js", filesCited("util.js add overflow").includes("util.js"))
  ok("cites nested", filesCited("see src/api.ts route").includes("src/api.ts"))
  ok("url is not a file", !filesCited("see https://example.com/app.js for docs").includes("app.js"))
  eq("empty is empty", filesCited("").length, 0)
}

console.log("== radiusOf / expandWrites ==")
{
  const r = radiusOf(["util.js"], GRAPH)
  ok("includes self", r.includes("util.js"))
  ok("includes importer", r.includes("app.js"))
  ok("includes test", r.includes("util.test.js"))
  eq("empty graph is self", radiusOf(["util.js"], { files: [], edges: [] }).join(","), "util.js")
  eq("empty paths", radiusOf([], GRAPH).length, 0)
  const w = expandWrites({ "util.js": 2000 }, GRAPH)
  eq("stamps importer", w["app.js"], 2000)
  eq("stamps test", w["util.test.js"], 2000)
  eq("keeps origin", w["util.js"], 2000)
  eq("empty writes", Object.keys(expandWrites({}, GRAPH)).length, 0)
  eq("no graph keeps writes", expandWrites({ "util.js": 9 }, { files: [], edges: [] })["util.js"], 9)
}

console.log("== graphFromIndex ==")
{
  const idx = {
    version: 1,
    files: {
      "util.js": { mtime: 2000, size: 10, symbols: ["add"], lang: "javascript", imports: [], test: false, contracts: [] },
      "app.js": { mtime: 1000, size: 12, symbols: [], lang: "javascript", imports: ["./util.js"], test: false, contracts: [] },
    },
  }
  const g = graphFromIndex(idx)
  ok("index graph has IMPORT", g.edges.some((e) => e.kind === "IMPORT"))
  const world = worldFromIndex(idx)
  eq("world stamps app.js", world.writes["app.js"], 2000)
  ok("empty index world empty writes", Object.keys(worldFromIndex(null).writes).length === 0)
}

console.log("== entryIsStale ==")
{
  const writes = expandWrites({ "util.js": 2000 }, GRAPH)
  ok("app.js note stale when util moved", entryIsStale({
    text: "app.js calls add()", files: ["app.js"], asOf: 1000,
  }, { writes, graph: GRAPH }))
  ok("same-file stale", entryIsStale({
    text: "util.js add overflows", files: ["util.js"], asOf: 1000,
  }, { writes, graph: GRAPH }))
  ok("newer asOf is live", !entryIsStale({
    text: "util.js add overflows", files: ["util.js"], asOf: 9000,
  }, { writes, graph: GRAPH }))
  ok("no files not stale", !entryIsStale({ text: "prefer tabs", asOf: 1 }, { writes, graph: GRAPH }))
  ok("no writes not stale", !entryIsStale({ text: "util.js x", files: ["util.js"], asOf: 1 }, { writes: {} }))
  ok("no asOf not stale", !entryIsStale({ text: "util.js x", files: ["util.js"] }, { writes, graph: GRAPH }))
}

console.log("== relevantMemory drops stale project notes ==")
{
  appendMemory("global", "prefer tabs", WORK, { source: "cli", at: "2020-01-01T00:00:00.000Z" })
  appendMemory("project", "util.js add overflows on large n", WORK, { source: "agent", at: "2020-01-01T00:00:00.000Z" })
  const pdir = projectDir(WORK)
  fs.mkdirSync(pdir, { recursive: true })
  fs.writeFileSync(path.join(pdir, "index.json"), JSON.stringify({
    version: 1,
    files: {
      "util.js": { mtime: Date.now() + 60_000, size: 20, symbols: ["add"], lang: "javascript", imports: [], test: false, contracts: [] },
      "app.js": { mtime: 1, size: 10, symbols: [], lang: "javascript", imports: ["./util.js"], test: false, contracts: [] },
    },
  }))
  const mem = relevantMemory("overflow tabs add", { cwd: WORK })
  ok("global pref survives", /prefer tabs/.test(mem))
  ok("stale project note dropped", !/overflows/.test(mem))
}

console.log("== lessonIsStale graph neighbor ==")
{
  const les = { files: ["app.js"], lastUsed: Date.now() - 120_000, successful_repair: "x", failure: "y" }
  ok("neighbor change stales lesson", lessonIsStale(les, WORK) === true)
  ok("lesson without files is not stale", lessonIsStale({ files: [], lastUsed: 1 }, WORK) === false)
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
  eq("VERSION is 50.0.0", VERSION, "50.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8"))
  eq("package.json is 50.0.0", pkg.version, "50.0.0")
  ok("files includes memgraph.js", pkg.files.includes("memgraph.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
}

console.log(`\n== v36 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
