#!/usr/bin/env node
/**
 * forge — v72 claims: per-claim subject store under the project hash.
 *
 * Not a second memory. Compose never writes. Never ACTIVE.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v72-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v72-work-"))
process.chdir(WORK)

const { recordClaim, getClaim, listClaims, claimsPath, validSubject } = await import("../claims.js")
const { downloadSkill, verifySkill, learnSkill } = await import("../skilldl.js")
const { SKILL_LIFE } = await import("../evolve.js")
const { projectDir } = await import("../memory.js")
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

## What worked
Use a 12-column grid.

## Files
- layout.css
`

function mockFetch(body, { filename = "artifact.bin" } = {}) {
  const buf = Buffer.from(String(body), "utf8")
  return async (href) => ({
    ok: true, status: 200, statusText: "OK",
    headers: { "content-disposition": `filename="${filename}"` },
    body: buf, url: href,
  })
}

console.log("== subject + recordClaim under project hash ==")
{
  eq("valid", validSubject("web-design"), "web-design")
  eq("bad", validSubject("../x"), "")
  const r = recordClaim({ cwd: WORK, subject: "web-design", text: "Use a 12-column grid.", source: "skill", skill: "web-design" })
  eq("ok", r.ok, true)
  const p = claimsPath(WORK)
  ok("under projects hash", p.startsWith(projectDir(WORK)), p)
  ok("named claims.json", p.endsWith("claims.json"))
  eq("get text", getClaim(WORK, "web-design")?.text, "Use a 12-column grid.")
  eq("listed", listClaims(WORK).some((c) => c.subject === "web-design"), true)
  eq("missing", getClaim(WORK, "no-such"), null)
  eq("empty refused", recordClaim({ cwd: WORK, subject: "web-design", text: "  " }).ok, false)
}

console.log("== learnSkill upserts a claim; CANDIDATE does not ==")
{
  await downloadSkill("https://example.com/web-design.skill", {
    fetchFn: mockFetch(STRUCT, { filename: "web-design.skill" }),
  })
  eq("candidate learn fails", (learnSkill("web-design", { cwd: WORK })).ok, false)
  eq("no extra claim from candidate", listClaims(WORK).filter((c) => c.subject === "web-design").length, 1)
  eq("verified", verifySkill("web-design").lifecycle, SKILL_LIFE.VERIFIED)
  const learned = learnSkill("web-design", { cwd: WORK })
  eq("learn ok", learned.ok, true)
  eq("not ACTIVE", learned.lifecycle === SKILL_LIFE.ACTIVE, false)
  const c = getClaim(WORK, "web-design")
  ok("claim has procedure", /12-column/.test(c?.text || ""), c?.text)
  eq("source skill", c?.source, "skill")
  const mem = path.join(projectDir(WORK), "memory.md")
  ok("did not write memory.md", !fs.existsSync(mem))
}

console.log("== CLI/TUI wired; compose never writes ==")
{
  const forgeSrc = fs.readFileSync(path.join(FORGE, "forge.js"), "utf8")
  const chatSrc = fs.readFileSync(path.join(FORGE, "chat.js"), "utf8")
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("CLI claims", /case "claims"/.test(forgeSrc) && /listClaims/.test(forgeSrc))
  ok("TUI /claims", /case "claims"/.test(chatSrc))
  ok("compose has no claims", !/claims\.js/.test(composeSrc) && !/recordClaim/.test(composeSrc))
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
  eq("VERSION is 72.0.0", VERSION, "72.0.0")
  const pkg = JSON.parse(fs.readFileSync(path.join(FORGE, "package.json"), "utf8"))
  eq("package.json is 72.0.0", pkg.version, "72.0.0")
  ok("files includes claims.js", (pkg.files || []).includes("claims.js"))
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

console.log(`\n== v72 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
