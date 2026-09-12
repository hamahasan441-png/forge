#!/usr/bin/env node
/**
 * forge — v62 skilldl: native download, CANDIDATE only.
 *
 * DOWNLOAD ≠ TRUST. Does not: verify, learn, activate, dump HTML,
 * write ~/.forge/tools, flip assumeYes, add a runtime dep, invent a
 * second data root, change classifyTaskComplexity(), fetch from compose.
 */
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v62-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v62-work-"))
process.chdir(WORK)

const {
  downloadSkill, downloadSkills, validateDownloadUrl, detectSkillArtifact,
  listDownloads, loadDownloadManifest, loadDownloadLife, skillDownloadsDir,
  formatDownloadReport, DOWNLOAD_STATUS, MAX_SKILL_BYTES, safeFilename,
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

const SKILL_MD = `---
name: web-design
description: Responsive layout playbook
---

# Web Design

You will produce accessible, responsive layouts.
`

function mockFetch(body, { status = 200, headers = {}, url = "https://example.com/web-design.skill" } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8")
  return async (href) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "ERR",
    headers: { "content-disposition": `filename="web-design.skill"`, ...headers },
    body: buf,
    url: href || url,
  })
}

console.log("== validate URL fail-closed ==")
{
  eq("empty", validateDownloadUrl("").ok, false)
  eq("garbage", validateDownloadUrl("not a url").ok, false)
  eq("http refused", validateDownloadUrl("http://example.com/a.skill").ok, false)
  eq("file refused", validateDownloadUrl("file:///etc/passwd").ok, false)
  eq("loopback refused", validateDownloadUrl("https://127.0.0.1/x").ok, false)
  eq("localhost refused", validateDownloadUrl("https://localhost/x").ok, false)
  eq("metadata refused", validateDownloadUrl("https://169.254.169.254/latest").ok, false)
  eq("https ok", validateDownloadUrl("https://example.com/web-design.skill").ok, true)
}

console.log("== detect artifact ==")
{
  eq("markdown", detectSkillArtifact(Buffer.from(SKILL_MD), "web-design.skill").type, "markdown")
  eq("html fail", detectSkillArtifact(Buffer.from("<!DOCTYPE html><html>hi</html>"), "x.skill").type, null)
  eq("empty fail", detectSkillArtifact(Buffer.from(""), "x.skill").type, null)
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  eq("zip archive", detectSkillArtifact(zip, "pack.skill").type, "archive")
  eq("safe name", safeFilename("../../etc/passwd"), "passwd")
}

console.log("== download stores CANDIDATE under FORGE_HOME ==")
{
  const r = await downloadSkill("https://example.com/web-design.skill", { fetchFn: mockFetch(SKILL_MD) })
  ok("ok", r.ok === true, JSON.stringify(r))
  eq("not reused", r.reused, false)
  eq("status DOWNLOADED", r.record.status, DOWNLOAD_STATUS.DOWNLOADED)
  eq("lifecycle CANDIDATE", r.lifecycle, SKILL_LIFE.CANDIDATE)
  eq("not ACTIVE", r.record.lifecycle, SKILL_LIFE.CANDIDATE)
  const dir = skillDownloadsDir()
  ok("dir under FORGE_HOME", dir.startsWith(HOME) && dir.endsWith("skill-downloads"), dir)
  ok("not in user workdir", !dir.startsWith(WORK), dir)
  const recDir = path.join(dir, "web-design")
  ok("artifact exists", fs.existsSync(path.join(recDir, "web-design.skill")))
  ok("SKILL.md discovered", fs.existsSync(path.join(recDir, "SKILL.md")))
  ok("meta.json", fs.existsSync(path.join(recDir, "meta.json")))
  const meta = JSON.parse(fs.readFileSync(path.join(recDir, "meta.json"), "utf8"))
  eq("meta sha256", typeof meta.sha256, "string")
  ok("sha256 hex", /^[a-f0-9]{64}$/.test(meta.sha256))
  eq("meta url", meta.sourceUrl, "https://example.com/web-design.skill")
  eq("meta size", meta.size, Buffer.byteLength(SKILL_MD))
  const mode = (fs.statSync(path.join(recDir, "meta.json")).mode & 0o777).toString(8)
  ok("meta 0600-ish", mode === "600" || mode === "400", mode)
  const life = loadDownloadLife()
  eq("skilllife CANDIDATE", life.skills["web-design"]?.lifecycle, SKILL_LIFE.CANDIDATE)
  ok("workdir empty of forge files", !fs.existsSync(path.join(WORK, "skill-downloads")) && !fs.existsSync(path.join(WORK, "SKILL.md")))
  ok("report names candidate", /CANDIDATE/.test(formatDownloadReport(r)) && /web-design/.test(formatDownloadReport(r)))
  ok("report not trusted", /DOWNLOAD ≠ VERIFY|Not trusted/.test(formatDownloadReport(r)))
}

console.log("== duplicate sha256 reuses, does not overwrite VERIFIED ==")
{
  const first = await downloadSkill("https://example.com/web-design.skill", { fetchFn: mockFetch(SKILL_MD) })
  eq("reuse ok", first.ok, true)
  eq("reused flag", first.reused, true)
  const man = loadDownloadManifest()
  man.items["web-design"].lifecycle = SKILL_LIFE.VERIFIED
  fs.writeFileSync(path.join(skillDownloadsDir(), "manifest.json"), JSON.stringify(man, null, 1))
  const skillFile = path.join(skillDownloadsDir(), "web-design", "web-design.skill")
  const before = fs.readFileSync(skillFile)
  const r = await downloadSkill("https://example.com/other-name.skill", { fetchFn: mockFetch(SKILL_MD) })
  eq("still reused when VERIFIED", r.reused, true)
  eq("kept VERIFIED", r.record.lifecycle, SKILL_LIFE.VERIFIED)
  ok("bytes unchanged", Buffer.compare(before, fs.readFileSync(skillFile)) === 0)
}

console.log("== failures leave no candidate ==")
{
  const before = listDownloads().length
  const html = await downloadSkill("https://example.com/page.html", {
    fetchFn: mockFetch("<!DOCTYPE html><html><body>docs</body></html>", { headers: { "content-disposition": 'filename="page.html"' } }),
  })
  eq("html not ok", html.ok, false)
  const miss = await downloadSkill("https://example.com/missing.skill", { fetchFn: mockFetch("", { status: 404 }) })
  eq("404 not ok", miss.ok, false)
  const empty = await downloadSkill("https://example.com/empty.skill", { fetchFn: mockFetch("") })
  eq("empty not ok", empty.ok, false)
  const bad = await downloadSkill("http://example.com/x.skill", { fetchFn: mockFetch(SKILL_MD) })
  eq("http never fetches", bad.ok, false)
  eq("no extra candidates", listDownloads().length, before)
}

console.log("== multiple URLs independent ==")
{
  const other = `---
name: react-ui
description: React UI playbook
---

# React UI

You will build component trees.
`
  const results = await downloadSkills(
    ["https://example.com/react-ui.skill", "http://evil.example/x"],
    { fetchFn: mockFetch(other, { headers: { "content-disposition": 'filename="react-ui.skill"' } }) },
  )
  eq("two results", results.length, 2)
  eq("first ok", results[0].ok, true)
  eq("first CANDIDATE", results[0].lifecycle, SKILL_LIFE.CANDIDATE)
  eq("second fail", results[1].ok, false)
  ok("react-ui stored", listDownloads().some((d) => d.id === "react-ui"))
}

console.log("== restart still sees it ==")
{
  const have = listDownloads()
  ok("web-design persists", have.some((d) => d.id === "web-design" && d.sha256))
  ok("react-ui persists", have.some((d) => d.id === "react-ui"))
}

console.log("== SSRF: live loopback server is not contacted ==")
{
  let hits = 0
  const srv = http.createServer((_req, res) => { hits++; res.end("secret") })
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve))
  const port = srv.address().port
  const r = await downloadSkill(`https://127.0.0.1:${port}/web-design.skill`)
  srv.close()
  eq("loopback download refused", r.ok, false)
  eq("server never hit", hits, 0)
}

console.log("== compose never fetches; CLI wired; no tools write ==")
{
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("compose has no skilldl", !/skilldl/.test(composeSrc))
  ok("compose has no downloadSkill", !/downloadSkill\(/.test(composeSrc))
  const forgeSrc = fs.readFileSync(path.join(FORGE, "forge.js"), "utf8")
  ok("CLI skill download", /skill download/.test(forgeSrc) && /runSkillDownload/.test(forgeSrc))
  const chatSrc = fs.readFileSync(path.join(FORGE, "chat.js"), "utf8")
  ok("TUI /skill download", /\/skill download/.test(chatSrc) && /case "skill"/.test(chatSrc))
  const dlSrc = fs.readFileSync(path.join(FORGE, "skilldl.js"), "utf8")
  ok("uses pinnedFetch", /pinnedFetch/.test(dlSrc))
  ok("never writes tools dir", !/writeStateFile\(PLUGINS_DIR/.test(dlSrc) && !/from "\.\/plugins\.js"/.test(dlSrc))
  ok("cap is bounded", MAX_SKILL_BYTES <= 8 * 1024 * 1024)
  const tools = path.join(HOME, "tools")
  ok("no ~/.forge/tools", !fs.existsSync(tools) || fs.readdirSync(tools).length === 0)
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
  eq("VERSION is 89.0.0", VERSION, "89.0.0")
  const pkg = JSON.parse(fs.readFileSync(path.join(FORGE, "package.json"), "utf8"))
  eq("package.json is 89.0.0", pkg.version, "89.0.0")
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

console.log(`\n== v62 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
