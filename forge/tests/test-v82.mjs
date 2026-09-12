#!/usr/bin/env node
/**
 * forge — v82 zip unpack: SKILL.md + scripts/examples/references.
 * Never tools, never binaries, never ACTIVE.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v82-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v82-work-"))
process.chdir(WORK)

const { makeStoreZip, extractSkillMdFromZip, extractZipPack, safeSupportRel } = await import("../zipingest.js")
const { ingestLocal, skillDownloadsDir } = await import("../skilldl.js")
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

console.log("== pack extract: SKILL.md + scripts/examples, skip junk ==")
{
  eq("scripts ok", safeSupportRel("scripts/ok.sh"), "scripts/ok.sh")
  eq("deny traversal", safeSupportRel("scripts/../evil.sh"), null)
  eq("deny exe", safeSupportRel("scripts/tool.exe"), null)
  eq("deny tools root", safeSupportRel("tools/x.mjs"), null)
  const zip = makeStoreZip({
    "pack/SKILL.md": MD,
    "pack/scripts/ok.sh": "echo grid\n",
    "pack/examples/grid.md": "# grid\n",
    "pack/README.txt": "nope",
    "bin/tool.exe": "MZ",
    "scripts/../evil.sh": "rm -rf /\n",
  })
  const md = extractSkillMdFromZip(zip)
  eq("v79 extract still ok", md.ok, true)
  const pack = extractZipPack(zip)
  eq("pack ok", pack.ok, true)
  ok("has script", pack.files.some((f) => f.name === "scripts/ok.sh"))
  ok("has example", pack.files.some((f) => f.name === "examples/grid.md"))
  eq("no readme", pack.files.some((f) => /README/.test(f.name)), false)
  eq("no exe", pack.files.some((f) => /\.exe$/.test(f.name)), false)
  eq("no traversal", pack.files.some((f) => f.name.includes("..")), false)
}

console.log("== ingest writes support; never tools; CANDIDATE ==")
{
  const zip = makeStoreZip({
    "SKILL.md": MD,
    "scripts/ok.sh": "echo grid\n",
    "examples/grid.md": "# grid\n",
  })
  const zipPath = path.join(WORK, "skill.zip")
  fs.writeFileSync(zipPath, zip)
  const ing = ingestLocal(zipPath)
  eq("ingest ok", ing.ok, true)
  eq("CANDIDATE", ing.lifecycle, SKILL_LIFE.CANDIDATE)
  eq("not ACTIVE", ing.lifecycle === SKILL_LIFE.ACTIVE, false)
  ok("unpacked listed", (ing.record?.unpacked || []).includes("scripts/ok.sh"))
  const dest = path.join(skillDownloadsDir(), ing.record.id)
  ok("script on disk", fs.existsSync(path.join(dest, "scripts", "ok.sh")))
  ok("example on disk", fs.existsSync(path.join(dest, "examples", "grid.md")))
  eq("mode 0600-class", (fs.statSync(path.join(dest, "scripts", "ok.sh")).mode & 0o111), 0)
  eq("no tools dir", fs.existsSync(path.join(HOME, "tools")), false)
  const folder = path.join(WORK, "skill-folder")
  fs.mkdirSync(path.join(folder, "scripts"), { recursive: true })
  fs.writeFileSync(path.join(folder, "SKILL.md"), MD)
  fs.writeFileSync(path.join(folder, "scripts", "from-folder.sh"), "echo hi\n")
  const ing2 = ingestLocal(folder)
  eq("folder ingest", ing2.ok, true)
  ok("folder script", (ing2.record?.unpacked || []).includes("scripts/from-folder.sh"))
}

console.log("== compose write-free ==")
{
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("compose has no zipingest", !/zipingest/.test(composeSrc))
  ok("compose has no extractZipPack", !/extractZipPack/.test(composeSrc))
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
  ok("files includes zipingest.js", (pkg.files || []).includes("zipingest.js"))
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
  ok("ZIP leftover gone", !/Full ZIP unpack/.test(todo))
  ok("no ~/.forge/tools", !fs.existsSync(path.join(HOME, "tools")) || fs.readdirSync(path.join(HOME, "tools")).length === 0)
}

console.log(`\n== v82 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
