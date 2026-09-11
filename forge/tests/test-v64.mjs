#!/usr/bin/env node
/**
 * forge — v64 wire: VERIFIED downloads actually load.
 *
 * load_skill + compose attach bodies. CANDIDATE stays hidden.
 * Does not: fetch from compose, write ~/.forge/tools, spawn plugin-host,
 * flip assumeYes, change classifyTaskComplexity().
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v64-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v64-work-"))
process.chdir(WORK)

const {
  downloadSkill, downloadTool, verifySkill, verifyTool, verifySkills,
  readDownloadedSkill, readDownloadedToolPlaybook, indexVerifiedSkills,
} = await import("../skilldl.js")
const { SKILL_LIFE } = await import("../evolve.js")
const { pickSkills } = await import("../skillforge.js")
const { compose, formatCompose } = await import("../compose.js")
const { execTool } = await import("../tools.js")
const { dataStatus, formatDataStatus } = await import("../knowgap.js")
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

const SKILL_MD = `---
name: web-design
description: Responsive layout playbook
---

# Web Design

You will produce accessible, responsive layouts.

## What worked
Set a fluid grid and test at 390px.

## Files
- src/styles.css

## Verify
\`npm test\`
`

const TOOL_MJS = `export default {
  name: "lint_hints",
  description: "Read-only lint hints playbook",
  readOnly: true,
  async run() { return { ok: true, text: "run the project linter" } },
}
`

function mockFetch(body, { filename = "artifact.bin" } = {}) {
  const buf = Buffer.from(String(body), "utf8")
  return async (href) => ({
    ok: true, status: 200, statusText: "OK",
    headers: { "content-disposition": `filename="${filename}"` },
    body: buf, url: href,
  })
}

console.log("== CANDIDATE is hidden from load_skill; VERIFIED loads ==")
{
  await downloadSkill("https://example.com/web-design.skill", {
    fetchFn: mockFetch(SKILL_MD, { filename: "web-design.skill" }),
  })
  eq("candidate body hidden", readDownloadedSkill("web-design"), null)
  const before = await execTool({ cwd: WORK, skillsDir: null }, "load_skill", { name: "web-design" })
  ok("load_skill CANDIDATE fails", typeof before === "string" && /ERROR/.test(before), before)
  const v = verifySkill("web-design")
  eq("verified", v.ok && v.lifecycle === SKILL_LIFE.VERIFIED, true)
  const body = readDownloadedSkill("web-design")
  ok("readDownloadedSkill body", typeof body === "string" && /fluid grid/.test(body))
  const loaded = await execTool({ cwd: WORK, skillsDir: null }, "load_skill", { name: "web-design" })
  ok("load_skill without skillsDir", typeof loaded === "string" && /fluid grid/.test(loaded), loaded)
  ok("not an ERROR", !/^ERROR/.test(String(loaded)))
}

console.log("== tool playbook is markdown, not .mjs; CANDIDATE hidden ==")
{
  await downloadTool("https://example.com/lint_hints.mjs", {
    fetchFn: mockFetch(TOOL_MJS, { filename: "lint_hints.mjs" }),
  })
  eq("tool candidate hidden", readDownloadedToolPlaybook("lint_hints"), null)
  verifyTool("lint_hints")
  const md = readDownloadedToolPlaybook("lint_hints")
  ok("playbook markdown", typeof md === "string" && /hostless playbook/.test(md))
  ok("no mjs dump", !/export default/.test(md) && !/async run/.test(md))
  const loaded = await execTool({ cwd: WORK, skillsDir: null }, "load_skill", { name: "lint_hints" })
  ok("load_skill tool playbook", typeof loaded === "string" && /hostless/.test(loaded), loaded)
}

console.log("== pickSkills keeps downloaded path; compose attaches body ==")
{
  const picks = pickSkills("use the web-design skill to build a responsive accessible layout", [])
  const hit = picks.find((s) => s.name === "web-design")
  ok("picked", Boolean(hit), JSON.stringify(picks))
  eq("downloaded flag", hit?.downloaded, true)
  ok("path kept", typeof hit?.path === "string" && /skill-downloads/.test(hit.path) && /SKILL\.md$/.test(hit.path), hit?.path)
  const snap = compose("use the web-design skill to build a responsive accessible layout", { cwd: WORK, klass: TASK_CLASS.MEDIUM })
  const sk = (snap.skills || []).find((s) => s.name === "web-design")
  ok("compose has skill", Boolean(sk))
  ok("repair attached", /fluid grid/.test(sk?.repair || ""), sk?.repair)
  ok("files attached", Array.isArray(sk?.files) && sk.files.includes("src/styles.css"), JSON.stringify(sk?.files))
  const fmt = formatCompose(snap)
  ok("steer or compose mentions skill", /web-design/.test(fmt), fmt.slice(0, 400))
}

console.log("== data status counts downloads; empty verify all is quiet ==")
{
  const st = dataStatus(WORK)
  ok("skillDownloads >= 1", (st.skillDownloads ?? 0) >= 1, st.skillDownloads)
  ok("toolDownloads >= 1", (st.toolDownloads ?? 0) >= 1, st.toolDownloads)
  ok("format lists downloads", /downloads/.test(formatDataStatus(st)))
  const none = verifySkills(["all"])
  ok("verify all returns existing", none.length >= 1)
}

console.log("== compose still never fetches ==")
{
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("compose has no skilldl", !/skilldl/.test(composeSrc))
  ok("compose has no downloadSkill", !/downloadSkill\(/.test(composeSrc))
  ok("compose has no pinnedFetch", !/pinnedFetch/.test(composeSrc))
  const toolsSrc = fs.readFileSync(path.join(FORGE, "tools.js"), "utf8")
  ok("tools load_skill reads downloads", /readDownloadedSkill/.test(toolsSrc))
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
  eq("VERSION is 84.0.0", VERSION, "84.0.0")
  const pkg = JSON.parse(fs.readFileSync(path.join(FORGE, "package.json"), "utf8"))
  eq("package.json is 84.0.0", pkg.version, "84.0.0")
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

console.log(`\n== v64 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
