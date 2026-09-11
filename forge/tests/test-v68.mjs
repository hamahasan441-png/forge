#!/usr/bin/env node
/**
 * forge — v68 stale: VERIFIED past TTL → STALE, not CONTRADICTED.
 *
 * Re-verify restores VERIFIED. Hidden from pick/load. Never ACTIVE.
 * Compose never fetches. Never ~/.forge/tools.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v68-"))
process.env.FORGE_HOME = HOME
process.env.FORGE_SKILL_TTL_MS = "1000"
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v68-work-"))
process.chdir(WORK)

const {
  downloadSkill, verifySkill, sweepStale, indexVerifiedSkills,
  readDownloadedSkill, listDownloads, STALE, skillTtlMs,
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

## Verify
\`npm test\`
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

console.log("== TTL helper ==")
{
  eq("env ttl", skillTtlMs(process.env), 1000)
  eq("default 30d", skillTtlMs({}), 30 * 24 * 60 * 60 * 1000)
}

console.log("== VERIFIED past TTL → STALE, not CONTRADICTED; re-verify restores ==")
{
  await downloadSkill("https://example.com/web-design.skill", {
    fetchFn: mockFetch(STRUCT, { filename: "web-design.skill" }),
  })
  const v = verifySkill("web-design")
  eq("verified", v.lifecycle, SKILL_LIFE.VERIFIED)
  ok("body readable", !!readDownloadedSkill("web-design"))
  eq("indexed", indexVerifiedSkills().some((s) => s.name === "web-design"), true)

  const man = loadMan()
  man.items["web-design"].verifiedAt = Date.now() - 5000
  saveMan(man)
  const demoted = sweepStale()
  ok("sweep names it", demoted.includes("web-design"), String(demoted))
  eq("STALE", listDownloads().find((d) => d.id === "web-design")?.lifecycle, STALE)
  eq("not CONTRADICTED", listDownloads().find((d) => d.id === "web-design")?.lifecycle === "CONTRADICTED", false)
  eq("hidden from pick", indexVerifiedSkills().some((s) => s.name === "web-design"), false)
  eq("load hidden", readDownloadedSkill("web-design"), null)

  const again = verifySkill("web-design")
  eq("re-verify VERIFIED", again.lifecycle, SKILL_LIFE.VERIFIED)
  eq("not ACTIVE", again.lifecycle === SKILL_LIFE.ACTIVE, false)
  eq("indexed again", indexVerifiedSkills().some((s) => s.name === "web-design"), true)
  ok("body back", !!readDownloadedSkill("web-design"))
}

console.log("== missing verifiedAt is stamped, not instantly STALE; CANDIDATE stays ==")
{
  await downloadSkill("https://example.com/fresh-name.skill", {
    fetchFn: mockFetch(STRUCT.replace("web-design", "fresh-name"), { filename: "fresh-name.skill" }),
  })
  verifySkill("fresh-name")
  const man = loadMan()
  delete man.items["fresh-name"].verifiedAt
  saveMan(man)
  const demoted = sweepStale()
  eq("fresh not demoted", demoted.includes("fresh-name"), false)
  eq("still VERIFIED", listDownloads().find((d) => d.id === "fresh-name")?.lifecycle, SKILL_LIFE.VERIFIED)
  ok("clock stamped", Number(loadMan().items["fresh-name"].verifiedAt) > 0)

  await downloadSkill("https://example.com/cand-name.skill", {
    fetchFn: mockFetch(STRUCT.replace("web-design", "cand-name"), { filename: "cand-name.skill" }),
  })
  const man2 = loadMan()
  man2.items["cand-name"].verifiedAt = Date.now() - 999999
  saveMan(man2)
  sweepStale()
  eq("CANDIDATE not STALE", listDownloads().find((d) => d.id === "cand-name")?.lifecycle, SKILL_LIFE.CANDIDATE)
}

console.log("== compose never fetches ==")
{
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("compose has no skilldl", !/skilldl/.test(composeSrc))
  ok("compose has no sweepStale", !/sweepStale/.test(composeSrc))
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
  eq("VERSION is 81.0.0", VERSION, "81.0.0")
  const pkg = JSON.parse(fs.readFileSync(path.join(FORGE, "package.json"), "utf8"))
  eq("package.json is 81.0.0", pkg.version, "81.0.0")
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

console.log(`\n== v68 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
