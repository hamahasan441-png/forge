#!/usr/bin/env node
/**
 * forge — v74 cockpit: claims TRY FIRST, decisions.json, knowledge pane,
 * honest download progress. Kernel frozen. Compose never writes.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v74-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v74-work-"))
process.chdir(WORK)

const { recordClaim } = await import("../claims.js")
const { recordDecision, listDecisions, pickDecisions, formatKnowledgePane, decisionsPath } = await import("../decisions.js")
const { compose, formatCompose } = await import("../compose.js")
const { formatSteer } = await import("../evaluate.js")
const { downloadSkill } = await import("../skilldl.js")
const { TASK_CLASS, classifyTask, classifyTaskComplexity } = await import("../classify.js")
const { evaluateSkills } = await import("../evaluate.js")
const { defaultConfig, sanitizeProjectConfig } = await import("../config.js")
const { VERSION } = await import("../version.js")
const { CATALOG } = await import("../providers.js")
const { PLUGINS_DIR } = await import("../plugins.js")
const { projectDir } = await import("../memory.js")

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

console.log("== formatSteer TRY FIRST from claims ==")
{
  const empty = formatSteer({})
  eq("empty steer", empty, "")
  const steer = formatSteer({
    claims: [{ subject: "web-design", text: "Use a 12-column grid." }],
  })
  ok("TRY FIRST", /TRY FIRST/.test(steer), steer)
  ok("names claim", /web-design/.test(steer) && /12-column/.test(steer), steer)
  ok("CLAIMS line", /CLAIMS:/.test(steer))
  const pluginWins = formatSteer({
    plugins: [{ name: "auth_fix", isolated: true, repair: "check Authorization header" }],
    claims: [{ subject: "web-design", text: "Use a 12-column grid." }],
  })
  ok("plugin ranks above claim", /auth_fix/.test(pluginWins) && !/12-column/.test(pluginWins.split("CLAIMS")[0]))
}

console.log("== decisions under project hash; compose cites; MICRO skip ==")
{
  const r = recordDecision({ cwd: WORK, title: "use-postgres", reason: "JSON files will not hold billing rows." })
  eq("ok", r.ok, true)
  ok("path under hash", decisionsPath(WORK).startsWith(projectDir(WORK)))
  eq("listed", listDecisions(WORK).some((d) => d.title === "use-postgres"), true)
  eq("MICRO unnamed empty", pickDecisions("fix a typo in README", listDecisions(WORK), { klass: TASK_CLASS.MICRO }).length, 0)
  const snap = compose("billing use-postgres schema", { cwd: WORK })
  eq("picked", snap.decisions.some((d) => d.title === "use-postgres"), true)
  ok("[decisions] line", /\[decisions\] use-postgres/.test(formatCompose(snap)))
  const typo = compose("fix a typo in README", { cwd: WORK })
  eq("typo zero decisions", typo.decisions.length, 0)
}

console.log("== knowledge pane + CLI/TUI wired ==")
{
  recordClaim({ cwd: WORK, subject: "web-design", text: "Use a 12-column grid.", source: "skill" })
  const pane = formatKnowledgePane({
    claims: [{ subject: "web-design", text: "Use a 12-column grid." }],
    decisions: listDecisions(WORK),
    gaps: { gaps: [{ id: "auth", impact: "HIGH", status: "UNKNOWN" }] },
    downloads: [{ id: "web-design", lifecycle: "VERIFIED" }],
  })
  ok("header", /^KNOWLEDGE/.test(pane))
  ok("lists claim", /web-design/.test(pane))
  ok("lists decision", /use-postgres/.test(pane))
  ok("lists gap", /auth/.test(pane))
  ok("lists download", /VERIFIED/.test(pane))
  const forgeSrc = fs.readFileSync(path.join(FORGE, "forge.js"), "utf8")
  const chatSrc = fs.readFileSync(path.join(FORGE, "chat.js"), "utf8")
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("CLI knowledge", /case "knowledge"/.test(forgeSrc) && /case "decisions"/.test(forgeSrc))
  ok("TUI /knowledge", /case "knowledge"/.test(chatSrc) && /download started/.test(chatSrc))
  ok("compose has no recordDecision", !/recordDecision/.test(composeSrc))
  ok("compose has no skilldl", !/skilldl/.test(composeSrc))
}

console.log("== download progress never 100 on fail; 100 only after store ==")
{
  const events = []
  const r = await downloadSkill("https://example.com/nope.skill", {
    fetchFn: async () => ({ ok: false, status: 404, headers: {}, body: Buffer.alloc(0) }),
    onProgress: (p) => events.push(p),
  })
  eq("fail", r.ok, false)
  ok("started", events.some((e) => e.phase === "start"))
  ok("error phase", events.some((e) => e.phase === "error"))
  eq("no fake 100", events.some((e) => e.pct === 100), false)

  const STRUCT = `---
name: web-design
description: Responsive layout playbook
---

# Web Design
A layout playbook.
`
  const events2 = []
  const okDl = await downloadSkill("https://example.com/web-design.skill", {
    fetchFn: async () => ({
      ok: true, status: 200, headers: { "content-disposition": 'filename="web-design.skill"' },
      body: Buffer.from(STRUCT),
    }),
    onProgress: (p) => events2.push(p),
  })
  eq("download ok", okDl.ok, true)
  ok("done 100 after store", events2.some((e) => e.phase === "done" && e.pct === 100 && e.done === true))
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
  ok("files includes decisions.js", (pkg.files || []).includes("decisions.js"))
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

console.log(`\n== v74 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
