#!/usr/bin/env node
/**
 * forge — v65 discover: verified downloads show up in lists and CLI print.
 *
 * Does not: fetch from compose, write ~/.forge/tools, spawn plugin-host,
 * flip assumeYes, change classifyTaskComplexity().
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v65-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v65-work-"))
process.chdir(WORK)

const {
  downloadSkill, downloadTool, verifySkill, verifyTool,
  readDownloadedToolPlaybook, indexVerifiedSkills,
} = await import("../skilldl.js")
const { SKILL_LIFE, INACTIVE } = await import("../skilldl.js").then(async (m) => ({
  SKILL_LIFE: (await import("../evolve.js")).SKILL_LIFE,
  INACTIVE: m.INACTIVE,
}))
const { compose, formatCompose } = await import("../compose.js")
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

console.log("== CLI/TUI discovery is wired ==")
{
  const forgeSrc = fs.readFileSync(path.join(FORGE, "forge.js"), "utf8")
  ok("forge skills print uses readDownloadedSkill", /readDownloadedSkill\(sub\)/.test(forgeSrc))
  ok("forge skills lists extra", /verified downloads/.test(forgeSrc) && /indexVerifiedSkills/.test(forgeSrc))
  ok("forge plugins lists downloads", /indexVerifiedToolPlaybooks/.test(forgeSrc) && /downloaded playbook/.test(forgeSrc))
  ok("forge tools download hint", /did you mean: forge tool/.test(forgeSrc))
  const chatSrc = fs.readFileSync(path.join(FORGE, "chat.js"), "utf8")
  ok("TUI /skills download alias", /head === "download"/.test(chatSrc))
  ok("TUI /skills lists extra", /indexVerifiedSkills/.test(chatSrc) && /verified downloads/.test(chatSrc))
  ok("TUI empty verify", /no skill candidates to verify/.test(chatSrc))
  const ctxSrc = fs.readFileSync(path.join(FORGE, "context.js"), "utf8")
  ok("context compose includes skills", /includeSkills:\s*true/.test(ctxSrc))
}

console.log("== no What-worked still attaches; playbook line; re-verify demotes ==")
{
  await downloadSkill("https://example.com/web-design.skill", {
    fetchFn: mockFetch(SKILL_MD, { filename: "web-design.skill" }),
  })
  eq("verified", verifySkill("web-design").ok, true)
  const snap = compose("use the web-design skill to build a responsive accessible layout", { cwd: WORK, klass: TASK_CLASS.MEDIUM })
  const sk = (snap.skills || []).find((s) => s.name === "web-design")
  ok("repair from first paragraph", /accessible, responsive/.test(sk?.repair || ""), sk?.repair)
  await downloadTool("https://example.com/lint_hints.mjs", {
    fetchFn: mockFetch(TOOL_MJS, { filename: "lint_hints.mjs" }),
  })
  verifyTool("lint_hints")
  const md = readDownloadedToolPlaybook("lint_hints")
  ok("When heading", /## When/.test(md) && /hostless/.test(md))
  ok("no mjs dump", !/export default/.test(md))
  const snap2 = compose("run lint hints on the project", { cwd: WORK, klass: TASK_CLASS.MEDIUM })
  const fmt = formatCompose(snap2)
  ok("[playbook] line", /\[playbook\] lint_hints/.test(fmt) || (snap2.playbooks || []).some((p) => p.name === "lint_hints"), fmt.slice(0, 500))
  const listed = indexVerifiedSkills()
  ok("indexed", listed.some((s) => s.name === "web-design"))
  const dest = path.join(HOME, "skill-downloads", "web-design", "SKILL.md")
  fs.unlinkSync(dest)
  const again = verifySkill("web-design")
  eq("demoted INACTIVE", again.ok, false)
  eq("lifecycle INACTIVE", again.lifecycle, INACTIVE)
}

console.log("== compose still never fetches ==")
{
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("compose has no skilldl", !/skilldl/.test(composeSrc))
  ok("compose has no downloadSkill", !/downloadSkill\(/.test(composeSrc))
  ok("compose has no pinnedFetch", !/pinnedFetch/.test(composeSrc))
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
  eq("VERSION is 80.0.0", VERSION, "80.0.0")
  const pkg = JSON.parse(fs.readFileSync(path.join(FORGE, "package.json"), "utf8"))
  eq("package.json is 80.0.0", pkg.version, "80.0.0")
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

console.log(`\n== v65 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
