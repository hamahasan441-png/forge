#!/usr/bin/env node
/**
 * forge — v63 tool-download + structural verify.
 *
 * DOWNLOAD ≠ VERIFY. Failed verify is INACTIVE; siblings stay independent.
 * Verified tools are hostless playbooks — never ~/.forge/tools, never
 * plugin-host. Does not: flip assumeYes, add a runtime dep, dump HTML,
 * change classifyTaskComplexity(), fetch from compose.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v63-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v63-work-"))
process.chdir(WORK)

const {
  downloadSkill, downloadTool, downloadTools, verifySkill, verifyTool,
  verifySkills, verifyTools, formatVerifyReport, listDownloads, listToolDownloads,
  loadDownloadLife, skillDownloadsDir, toolDownloadsDir, detectToolArtifact,
  indexVerifiedSkills, indexVerifiedToolPlaybooks, INACTIVE,
} = await import("../skilldl.js")
const { SKILL_LIFE } = await import("../evolve.js")
const { pickSkills } = await import("../skillforge.js")
const { pickPlugins } = await import("../plugintel.js")
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

const EVIL_MJS = `export default {
  name: "evil_shell",
  description: "should never verify",
  run() { eval("1"); },
}
`

function mockFetch(body, { status = 200, headers = {}, filename = "artifact.bin" } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8")
  return async (href) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "ERR",
    headers: { "content-disposition": `filename="${filename}"`, ...headers },
    body: buf,
    url: href,
  })
}

console.log("== detect tool artifact ==")
{
  eq("plugin", detectToolArtifact(Buffer.from(TOOL_MJS), "lint_hints.mjs").type, "plugin")
  eq("html fail", detectToolArtifact(Buffer.from("<!DOCTYPE html><html>x</html>"), "x.mjs").type, null)
  eq("skill md is not a tool", detectToolArtifact(Buffer.from(SKILL_MD), "web-design.skill").type, null)
}

console.log("== tool download is CANDIDATE under FORGE_HOME/tool-downloads ==")
{
  const r = await downloadTool("https://example.com/lint_hints.mjs", {
    fetchFn: mockFetch(TOOL_MJS, { filename: "lint_hints.mjs" }),
  })
  ok("ok", r.ok === true, JSON.stringify(r))
  eq("CANDIDATE", r.lifecycle, SKILL_LIFE.CANDIDATE)
  const dir = toolDownloadsDir()
  ok("under FORGE_HOME", dir.startsWith(HOME) && dir.endsWith("tool-downloads"), dir)
  ok("not in user workdir", !dir.startsWith(WORK))
  ok("mjs stored", fs.existsSync(path.join(dir, "lint_hints", "lint_hints.mjs")))
  ok("meta stored", fs.existsSync(path.join(dir, "lint_hints", "meta.json")))
  const life = loadDownloadLife(process.env, "tool")
  eq("life CANDIDATE", life.tools.lint_hints?.lifecycle, SKILL_LIFE.CANDIDATE)
  ok("not in ~/.forge/tools", !fs.existsSync(path.join(HOME, "tools")) || fs.readdirSync(path.join(HOME, "tools")).length === 0)
  ok("workdir clean", !fs.existsSync(path.join(WORK, "tool-downloads")))
}

console.log("== skill verify pass → VERIFIED, fail → INACTIVE, siblings independent ==")
{
  const good = await downloadSkill("https://example.com/web-design.skill", {
    fetchFn: mockFetch(SKILL_MD, { filename: "web-design.skill" }),
  })
  eq("skill downloaded", good.ok, true)
  const badMd = "# Nope\n\nassumeYes plugin-host classifyTaskComplexity"
  await downloadSkill("https://example.com/kernel-touch.skill", {
    fetchFn: mockFetch(`---\nname: kernel-touch\ndescription: x\n---\n\n${badMd}\n`, { filename: "kernel-touch.skill" }),
  })
  const results = verifySkills(["web-design", "kernel-touch"])
  eq("two results", results.length, 2)
  eq("web-design ok", results[0].ok, true)
  eq("web-design VERIFIED", results[0].lifecycle, SKILL_LIFE.VERIFIED)
  eq("kernel-touch fail", results[1].ok, false)
  eq("kernel-touch INACTIVE", results[1].lifecycle, INACTIVE)
  eq("web-design still VERIFIED after sibling fail", verifySkill("web-design").lifecycle, SKILL_LIFE.VERIFIED)
  ok("report has both", /VERIFIED/.test(formatVerifyReport(results)) && /INACTIVE/.test(formatVerifyReport(results)))
}

console.log("== tool verify pass → VERIFIED playbook; evil stays INACTIVE ==")
{
  const evil = await downloadTool("https://example.com/evil_shell.mjs", {
    fetchFn: mockFetch(EVIL_MJS, { filename: "evil_shell.mjs" }),
  })
  eq("evil downloaded CANDIDATE", evil.ok && evil.lifecycle === SKILL_LIFE.CANDIDATE, true)
  const good = verifyTool("lint_hints")
  eq("lint_hints verified", good.ok, true)
  eq("lint_hints VERIFIED", good.lifecycle, SKILL_LIFE.VERIFIED)
  const bad = verifyTool("evil_shell")
  eq("evil not ok", bad.ok, false)
  eq("evil INACTIVE", bad.lifecycle, INACTIVE)
  ok("eval reason", (bad.issues || []).some((i) => /forbidden|eval/i.test(i)))
  const all = verifyTools(["all"])
  ok("verify all includes both", all.length >= 2)
  eq("lint_hints still VERIFIED", verifyTool("lint_hints").lifecycle, SKILL_LIFE.VERIFIED)
  const books = indexVerifiedToolPlaybooks()
  ok("playbook listed", books.some((b) => b.name === "lint_hints" && b.playbook === true))
  ok("evil not a playbook", !books.some((b) => b.name === "evil_shell"))
}

console.log("== CANDIDATE not picked; VERIFIED skill is ==")
{
  const unverified = `---
name: still-candidate
description: Should not be trusted yet
---

# Still Candidate

You will wait for verify.
`
  await downloadSkill("https://example.com/still-candidate.skill", {
    fetchFn: mockFetch(unverified, { filename: "still-candidate.skill" }),
  })
  const indexed = indexVerifiedSkills()
  ok("verified skill indexed", indexed.some((s) => s.name === "web-design"))
  ok("candidate not indexed", !indexed.some((s) => s.name === "still-candidate"))
  const picks = pickSkills("use the web-design skill to build a responsive accessible layout", [])
  ok("pickSkills sees verified download", picks.some((s) => s.name === "web-design"))
  ok("pickSkills skips candidate", !picks.some((s) => s.name === "still-candidate"))
  const plugs = pickPlugins("run lint hints on the project", [], { klass: TASK_CLASS.MEDIUM })
  ok("pickPlugins sees verified tool playbook", plugs.playbooks?.some?.((b) => b.name === "lint_hints") || plugs.some?.((b) => b.name === "lint_hints") || JSON.stringify(plugs).includes("lint_hints"))
}

console.log("== HTML / missing / already-verified ==")
{
  const html = await downloadTool("https://example.com/page.mjs", {
    fetchFn: mockFetch("<!DOCTYPE html><html>docs</html>", { filename: "page.mjs" }),
  })
  eq("html tool refused", html.ok, false)
  const miss = verifySkill("no-such-skill")
  eq("missing not ok", miss.ok, false)
  const again = verifySkill("web-design")
  eq("already VERIFIED ok", again.ok, true)
  eq("already flag", again.already, true)
}

console.log("== compose never fetches; CLI/TUI wired; no tools write ==")
{
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("compose has no skilldl", !/skilldl/.test(composeSrc))
  ok("compose has no verifySkill", !/verifySkill\(/.test(composeSrc))
  ok("compose has no downloadTool", !/downloadTool\(/.test(composeSrc))
  const forgeSrc = fs.readFileSync(path.join(FORGE, "forge.js"), "utf8")
  ok("CLI tool download", /forge tool download/.test(forgeSrc) && /runToolDownload/.test(forgeSrc))
  ok("CLI skill verify", /forge skill verify/.test(forgeSrc) && /runVerify/.test(forgeSrc))
  const chatSrc = fs.readFileSync(path.join(FORGE, "chat.js"), "utf8")
  ok("TUI /tool download", /\/tool download/.test(chatSrc) && /case "tool"/.test(chatSrc))
  ok("TUI /skill verify", /\/skill verify/.test(chatSrc))
  const dlSrc = fs.readFileSync(path.join(FORGE, "skilldl.js"), "utf8")
  ok("never writes PLUGINS_DIR", !/writeStateFile\(PLUGINS_DIR/.test(dlSrc))
  ok("never imports plugins.js", !/from "\.\/plugins\.js"/.test(dlSrc))
  const toolsDir = path.join(HOME, "tools")
  ok("no ~/.forge/tools after verify", !fs.existsSync(toolsDir) || fs.readdirSync(toolsDir).length === 0)
  ok("hostless: no plugin-host spawn in skilldl", !/plugin-host\.js|spawn\(/.test(dlSrc) || !/spawnSync|execFile/.test(dlSrc))
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
  ok("files includes skilldl.js", (pkg.files || []).includes("skilldl.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
  eq("custom is still index 17 (pick 18)", CATALOG[17]?.name, "custom")
  eq("apinex still after custom", CATALOG[18]?.name, "apinex")
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
  eq("bundled pack unchanged", fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(","), bundledBefore)
  const todo = fs.readFileSync(path.join(FORGE, "TODO.md"), "utf8")
  const checked = (todo.match(/^- \[[xX]\]/gm) || []).length
  eq("TODO still unchecked", checked, 0)
  ok("no PLAN file", fs.readdirSync(FORGE).filter((n) => /^PLAN-v\d+\.md$/.test(n)).length === 0)
}

console.log(`\n== v63 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
