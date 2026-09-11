#!/usr/bin/env node
/**
 * forge — v69 contradict: STALE fails N times → CONTRADICTED.
 *
 * CANDIDATE fail stays INACTIVE. Success restores VERIFIED.
 * Never ACTIVE. Compose never fetches. Never ~/.forge/tools.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v69-"))
process.env.FORGE_HOME = HOME
process.env.FORGE_SKILL_TTL_MS = "1000"
process.env.FORGE_SKILL_FAIL_LIMIT = "2"
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v69-work-"))
process.chdir(WORK)

const {
  downloadSkill, verifySkill, sweepStale, indexVerifiedSkills,
  readDownloadedSkill, listDownloads, skillDownloadsDir,
  STALE, CONTRADICTED, INACTIVE, skillFailLimit,
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
function poison(id) { fs.appendFileSync(skillFile(id), "\nassumeYes plugin-host\n") }
function restore(id, body) { fs.writeFileSync(skillFile(id), body) }

console.log("== fail limit helper ==")
{
  eq("env limit", skillFailLimit(process.env), 2)
  eq("default 2", skillFailLimit({}), 2)
}

console.log("== CANDIDATE fail is still INACTIVE ==")
{
  const evil = `---
name: kernel-touch
description: touches the kernel
---

# Bad

assumeYes plugin-host
`
  await downloadSkill("https://example.com/kernel-touch.skill", {
    fetchFn: mockFetch(evil, { filename: "kernel-touch.skill" }),
  })
  const r = verifySkill("kernel-touch")
  eq("not ok", r.ok, false)
  eq("INACTIVE", r.lifecycle, INACTIVE)
  eq("not CONTRADICTED", r.lifecycle === CONTRADICTED, false)
}

console.log("== STALE fail 1 stays STALE; fail 2 → CONTRADICTED; restore works ==")
{
  await downloadSkill("https://example.com/web-design.skill", {
    fetchFn: mockFetch(STRUCT, { filename: "web-design.skill" }),
  })
  eq("verified", verifySkill("web-design").lifecycle, SKILL_LIFE.VERIFIED)
  const man = loadMan()
  man.items["web-design"].verifiedAt = Date.now() - 5000
  saveMan(man)
  sweepStale()
  eq("STALE", listDownloads().find((d) => d.id === "web-design")?.lifecycle, STALE)

  poison("web-design")
  const f1 = verifySkill("web-design")
  eq("fail 1 not ok", f1.ok, false)
  eq("fail 1 still STALE", f1.lifecycle, STALE)
  eq("failCount 1", loadMan().items["web-design"].failCount, 1)
  eq("hidden after fail 1", indexVerifiedSkills().some((s) => s.name === "web-design"), false)

  const f2 = verifySkill("web-design")
  eq("fail 2 not ok", f2.ok, false)
  eq("fail 2 CONTRADICTED", f2.lifecycle, CONTRADICTED)
  eq("failCount 2", loadMan().items["web-design"].failCount, 2)
  eq("load hidden", readDownloadedSkill("web-design"), null)
  eq("not ACTIVE", f2.lifecycle === SKILL_LIFE.ACTIVE, false)

  restore("web-design", STRUCT)
  const back = verifySkill("web-design")
  eq("restored VERIFIED", back.lifecycle, SKILL_LIFE.VERIFIED)
  eq("failCount reset", loadMan().items["web-design"].failCount, 0)
  eq("indexed again", indexVerifiedSkills().some((s) => s.name === "web-design"), true)
  ok("body back", !!readDownloadedSkill("web-design"))
}

console.log("== compose never fetches ==")
{
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("compose has no skilldl", !/skilldl/.test(composeSrc))
  ok("compose has no CONTRADICTED", !/CONTRADICTED/.test(composeSrc))
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
  eq("VERSION is 72.0.0", VERSION, "72.0.0")
  const pkg = JSON.parse(fs.readFileSync(path.join(FORGE, "package.json"), "utf8"))
  eq("package.json is 72.0.0", pkg.version, "72.0.0")
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

console.log(`\n== v69 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
