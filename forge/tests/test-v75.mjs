#!/usr/bin/env node
/**
 * forge — v75 dock: claims/decisions on the omega TUI dock. Read-only.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v75-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v75-work-"))
process.chdir(WORK)

const { initialState, reduce } = await import("../uistate.js")
const { knowledgeDockText, renderOmegaPanel, renderTaskPanel, renderOptions } = await import("../render.js")
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

console.log("== knowledgeDockText + reduce KNOWLEDGE_UPDATED ==")
{
  eq("empty", knowledgeDockText({}), "")
  eq("claims", knowledgeDockText({ claims: [{ subject: "web-design" }] }), "claims web-design")
  ok("both", /claims web-design/.test(knowledgeDockText({
    claims: [{ subject: "web-design" }],
    decisions: [{ title: "use-postgres" }],
  })) && /decisions use-postgres/.test(knowledgeDockText({
    claims: [{ subject: "web-design" }],
    decisions: [{ title: "use-postgres" }],
  })))
  const s0 = initialState({ cwd: WORK })
  eq("initial empty", (s0.knowledge?.claims || []).length, 0)
  const s1 = reduce(s0, {
    type: "KNOWLEDGE_UPDATED",
    claims: [{ subject: "web-design", text: "Use a 12-column grid." }],
    decisions: [{ title: "use-postgres", reason: "billing rows", status: "accepted" }],
  })
  eq("claim folded", s1.knowledge.claims[0]?.subject, "web-design")
  eq("decision folded", s1.knowledge.decisions[0]?.title, "use-postgres")
}

console.log("== omega / status panels show know line ==")
{
  const o = renderOptions({ ascii: true, a11y: true })
  const st = reduce(initialState({ cwd: WORK, state: "PLANNING", task: { title: "layout", startedAt: Date.now() } }), {
    type: "KNOWLEDGE_UPDATED",
    claims: [{ subject: "web-design", text: "grid" }],
    decisions: [{ title: "use-postgres" }],
  })
  const omega = renderOmegaPanel(st, 80, o).join("\n")
  ok("omega know", /know /.test(omega) && /web-design/.test(omega), omega)
  ok("omega decisions", /use-postgres/.test(omega))
  const panel = renderTaskPanel(st, 80, o).join("\n")
  ok("status Knowledge", /Knowledge/.test(panel) && /web-design/.test(panel), panel)
  const empty = renderOmegaPanel(initialState({ cwd: WORK }), 80, o).join("\n")
  eq("empty no know", /know /.test(empty), false)
}

console.log("== PLAN_COMPOSE wires claims; compose never writes ==")
{
  const metaSrc = fs.readFileSync(path.join(FORGE, "meta.js"), "utf8")
  const uiSrc = fs.readFileSync(path.join(FORGE, "uistate.js"), "utf8")
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("PLAN_COMPOSE claims", /type: "PLAN_COMPOSE"/.test(metaSrc) && /composed\.claims/.test(metaSrc))
  ok("PLAN_COMPOSE decisions", /composed\.decisions/.test(metaSrc))
  ok("bridge PLAN_COMPOSE", /case "PLAN_COMPOSE"/.test(uiSrc) && /KNOWLEDGE_UPDATED/.test(uiSrc))
  ok("compose has no recordClaim", !/recordClaim/.test(composeSrc))
  ok("compose has no recordDecision", !/recordDecision/.test(composeSrc))
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
  eq("VERSION is 87.0.0", VERSION, "87.0.0")
  const pkg = JSON.parse(fs.readFileSync(path.join(FORGE, "package.json"), "utf8"))
  eq("package.json is 87.0.0", pkg.version, "87.0.0")
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

console.log(`\n== v75 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
