#!/usr/bin/env node
/**
 * forge — v71 drift: VERIFIED body sha mismatch → DRIFT, not STALE.
 *
 * Re-verify restores. Sibling unchanged. Never ACTIVE. Compose never fetches.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v71-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v71-work-"))
process.chdir(WORK)

const {
  downloadSkill, verifySkill, sweepDrift, indexVerifiedSkills,
  readDownloadedSkill, listDownloads, skillDownloadsDir,
  DRIFT, STALE,
} = await import("../skilldl.js")
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

const STRUCT = `---
name: web-design
description: Responsive layout playbook
---

# Web Design

A layout playbook.
`

function mockFetch(body, { filename = "artifact.bin" } = {}) {
  const buf = Buffer.from(String(body), "utf8")
  return async (href) => ({
    ok: true, status: 200, statusText: "OK",
    headers: { "content-disposition": `filename="${filename}"` },
    body: buf, url: href,
  })
}

function manPath() { return path.join(HOME, "skill-downloads", "manifest.json") }
function loadMan() { return JSON.parse(fs.readFileSync(manPath(), "utf8")) }
function saveMan(j) { fs.writeFileSync(manPath(), JSON.stringify(j, null, 1)) }
function skillFile(id) { return path.join(skillDownloadsDir(), id, "SKILL.md") }

console.log("== body change → DRIFT; sibling stays VERIFIED; re-verify restores ==")
{
  await downloadSkill("https://example.com/web-design.skill", {
    fetchFn: mockFetch(STRUCT, { filename: "web-design.skill" }),
  })
  await downloadSkill("https://example.com/fresh-name.skill", {
    fetchFn: mockFetch(STRUCT.replace("web-design", "fresh-name"), { filename: "fresh-name.skill" }),
  })
  eq("a VERIFIED", verifySkill("web-design").lifecycle, SKILL_LIFE.VERIFIED)
  eq("b VERIFIED", verifySkill("fresh-name").lifecycle, SKILL_LIFE.VERIFIED)
  ok("verifiedSha stamped", !!loadMan().items["web-design"].verifiedSha)

  fs.appendFileSync(skillFile("web-design"), "\nA harmless extra line.\n")
  const demoted = sweepDrift()
  ok("sweep names it", demoted.includes("web-design"), String(demoted))
  eq("DRIFT", listDownloads().find((d) => d.id === "web-design")?.lifecycle, DRIFT)
  eq("not STALE", listDownloads().find((d) => d.id === "web-design")?.lifecycle === STALE, false)
  eq("sibling VERIFIED", listDownloads().find((d) => d.id === "fresh-name")?.lifecycle, SKILL_LIFE.VERIFIED)
  eq("hidden", indexVerifiedSkills().some((s) => s.name === "web-design"), false)
  eq("sibling indexed", indexVerifiedSkills().some((s) => s.name === "fresh-name"), true)
  eq("load hidden", readDownloadedSkill("web-design"), null)

  const back = verifySkill("web-design")
  eq("restored VERIFIED", back.lifecycle, SKILL_LIFE.VERIFIED)
  eq("not ACTIVE", back.lifecycle === SKILL_LIFE.ACTIVE, false)
  eq("indexed again", indexVerifiedSkills().some((s) => s.name === "web-design"), true)
  ok("body back", !!readDownloadedSkill("web-design"))
}

console.log("== missing verifiedSha is stamped, not instantly DRIFT ==")
{
  const man = loadMan()
  delete man.items["fresh-name"].verifiedSha
  saveMan(man)
  const demoted = sweepDrift()
  eq("fresh not demoted", demoted.includes("fresh-name"), false)
  eq("still VERIFIED", listDownloads().find((d) => d.id === "fresh-name")?.lifecycle, SKILL_LIFE.VERIFIED)
  ok("clock stamped", !!loadMan().items["fresh-name"].verifiedSha)
}

console.log("== compose never fetches ==")
{
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("compose has no skilldl", !/skilldl/.test(composeSrc))
  ok("compose has no sweepDrift", !/sweepDrift/.test(composeSrc))
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

console.log(`\n== v71 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
