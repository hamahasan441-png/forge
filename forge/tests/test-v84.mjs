#!/usr/bin/env node
/**
 * forge — v84 gated auto-promote + capability extract.
 * DOWNLOAD / structural / CANDIDATE never auto-ACTIVE.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v84-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v84-work-"))
process.chdir(WORK)

const { downloadSkill, verifySkill } = await import("../skilldl.js")
const { autoPromote, evaluatePromoteGates } = await import("../promote.js")
const { extractCapabilities } = await import("../caps.js")
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

function mockFetch(body, { filename = "artifact.bin" } = {}) {
  const buf = Buffer.from(String(body), "utf8")
  return async (href) => ({
    ok: true, status: 200, statusText: "OK",
    headers: { "content-disposition": `filename="${filename}"` },
    body: buf, url: href,
  })
}

const STRUCT = `---
name: web-design
description: Responsive layout playbook
---
# Web Design
## Layout
Set a fluid grid.
## What worked
Use a 12-column grid.
`

const PASSING = `---
name: echo-ok
description: A skill with a safe test
---
# Echo Ok
Does one thing.
## What worked
Echo ok then continue.
## Tests
- \`echo ok\`
`

console.log("== download / structural never auto-ACTIVE ==")
{
  await downloadSkill("https://example.com/web-design.skill", {
    fetchFn: mockFetch(STRUCT, { filename: "web-design.skill" }),
  })
  const cand = autoPromote("web-design")
  eq("CANDIDATE blocked", cand.ok, false)
  ok("mentions CANDIDATE", /CANDIDATE/.test(cand.error || (cand.blocked || []).join(" ")), cand.error)
  const v = verifySkill("web-design")
  eq("structural VERIFIED", v.lifecycle, SKILL_LIFE.VERIFIED)
  const g = evaluatePromoteGates("web-design")
  eq("structural gates fail", g.ok, false)
  ok("structural-only blocked", (g.blocked || []).some((b) => /structural/.test(b)), JSON.stringify(g.blocked))
  const no = autoPromote("web-design")
  eq("still not ACTIVE", no.ok, false)
  eq("lifecycle stays VERIFIED", no.lifecycle, SKILL_LIFE.VERIFIED)
}

console.log("== behavioral VERIFIED auto-promotes ==")
{
  await downloadSkill("https://example.com/echo-ok.skill", {
    fetchFn: mockFetch(PASSING, { filename: "echo-ok.skill" }),
  })
  const v = verifySkill("echo-ok")
  eq("behavioral VERIFIED", v.ok && v.evidence?.kind === "behavioral", true)
  const r = autoPromote("echo-ok")
  eq("autoPromote ok", r.ok, true)
  eq("ACTIVE", r.lifecycle, SKILL_LIFE.ACTIVE)
  eq("gated", r.gated, true)
  const again = autoPromote("echo-ok")
  eq("already ACTIVE", again.already, true)
}

console.log("== caps extract; compose write-free ==")
{
  const caps = extractCapabilities(PASSING, { name: "echo-ok" })
  eq("caps ok", caps.ok, true)
  ok("has capability or workflow", caps.capabilities.length + (caps.workflow ? 1 : 0) >= 1)
  ok("fingerprint", Boolean(caps.fingerprint))
  const empty = extractCapabilities("---\nname: x\ndescription: y\n---\n# X\n")
  eq("name-only not a capability", empty.ok, false)
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("compose has no autoPromote", !/autoPromote/.test(composeSrc))
  ok("compose has no promote.js", !/promote\.js/.test(composeSrc) && !/from \".\/promote/.test(composeSrc))
  const forgeSrc = fs.readFileSync(path.join(FORGE, "forge.js"), "utf8")
  ok("CLI autopromote", /autopromote/.test(forgeSrc))
  ok("CLI caps", /skill caps/.test(forgeSrc))
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
  eq("VERSION is 87.0.0", VERSION, "87.0.0")
  const pkg = JSON.parse(fs.readFileSync(path.join(FORGE, "package.json"), "utf8"))
  eq("package.json is 87.0.0", pkg.version, "87.0.0")
  ok("files includes promote.js", (pkg.files || []).includes("promote.js"))
  ok("files includes caps.js", (pkg.files || []).includes("caps.js"))
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
  ok("download still never auto-ACTIVE", /because a download succeeded/.test(todo))
  ok("no ~/.forge/tools", !fs.existsSync(path.join(HOME, "tools")) || fs.readdirSync(path.join(HOME, "tools")).length === 0)
}

console.log(`\n== v84 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
