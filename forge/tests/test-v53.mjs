#!/usr/bin/env node
/**
 * forge — v53 rank: pickSkills + playbooks + MCP into compose / planner.
 *
 * Does not: flip assumeYes, add a runtime dep, spawn plugin-host for
 * playbooks, connect MCP from compose, change classifyTaskComplexity(),
 * dump all skills into MICRO tasks, write ~/.forge/tools.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v53-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v53-work-"))
process.chdir(WORK)

const {
  FIRST_PARTY, enrichSkills, pickSkills, scoreSkill, formatForgePicks, firstPartyNames, catalogEntry,
} = await import("../skillforge.js")
const {
  pickPlugins, formatPluginPicks, PLUGIN_PLAYBOOKS, scorePlugin,
  rankMcp, mcpCatalog, isMcpTool, formatMcpPicks,
} = await import("../plugintel.js")
const { evaluateSkills, formatSteer } = await import("../evaluate.js")
const { compose, composeOnce, clearComposeOnce, formatCompose, emptyCompose } = await import("../compose.js")
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
const HOST = path.join(HERE, "../plugin-host.js")
const BUNDLED = path.join(HERE, "../skills")
const TASK = "debug the failing authentication module in util.js for production"
const API = "implement a REST API route and OpenAPI across files"

function listGlobalTools() {
  try { return fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")) } catch { return [] }
}

console.log("== catalog ==")
{
  ok("12 first-party skills", FIRST_PARTY.length === 12)
  ok("names are unique", new Set(firstPartyNames()).size === FIRST_PARTY.length)
  ok("coding-agent catalog", catalogEntry("coding-agent")?.tags.includes("code"))
  eq("missing catalog", catalogEntry("nope-skill"), null)
  ok("forge-debug skill on disk", fs.existsSync(path.join(BUNDLED, "forge-debug", "SKILL.md")))
  ok("forge-api skill on disk", fs.existsSync(path.join(BUNDLED, "forge-api", "SKILL.md")))
}

console.log("== enrich + pick ==")
{
  const indexed = [
    { name: "coding-agent", desc: "Coding workflow" },
    { name: "gift-evaluator", desc: "Evaluate gift ideas" },
    { name: "broken", desc: "x", ok: false },
  ]
  const en = enrichSkills(indexed)
  ok("keeps coding-agent", en.some((s) => s.name === "coding-agent" && s.tags.includes("code")))
  ok("adds forge-security virtual", en.some((s) => s.name === "forge-security" && s.virtual))
  eq("typo still empty", pickSkills("fix a typo in README", indexed).length, 0)
  const api = pickSkills(API, indexed)
  ok("api prefers coding or forge-api", api.some((s) => s.name === "coding-agent" || s.name === "forge-api"), JSON.stringify(api))
  ok("api drops gifts", !api.some((s) => s.name === "gift-evaluator"), JSON.stringify(api))
  ok("default top-k <= 3", api.length <= 3)
  const named = pickSkills("use forge-security on this typo", indexed)
  ok("named first-party on MICRO", named.some((s) => s.name === "forge-security"))
  ok("broken never picked", !pickSkills("broken please", indexed).some((s) => s.name === "broken"))
  ok("format lists load_skill", /load_skill/.test(formatForgePicks(named)))
  eq("format empty", formatForgePicks([]), "")
  ok("tag score beats gift", scoreSkill("ssrf secret scan", catalogEntry("forge-security")) > scoreSkill("ssrf secret scan", { name: "gift-evaluator", desc: "gifts" }))
  const debug = pickSkills(TASK, indexed)
  ok("debug prefers forge-debug", debug.some((s) => s.name === "forge-debug"), JSON.stringify(debug))
}

console.log("== evaluateSkills contract still holds ==")
{
  const SKILLS = [
    { name: "coding-agent", desc: "Coding workflow with planning" },
    { name: "gift-evaluator", desc: "Evaluate gift ideas" },
  ]
  eq("evaluateSkills typo empty", evaluateSkills("fix a typo in README", SKILLS).length, 0)
}

console.log("== plugintel playbooks ==")
{
  eq("6 playbooks", PLUGIN_PLAYBOOKS.length, 6)
  const jira = { name: "jira_issue", isolated: true, description: "Fetch a Jira issue by key" }
  const typo = pickPlugins("fix a typo", [jira], { klass: TASK_CLASS.MICRO })
  eq("MICRO drops isolated", typo.tools.filter((p) => p.isolated).length, 0)
  eq("MICRO drops playbooks", typo.playbooks.length, 0)
  const named = pickPlugins("use secret_scan on the diff", [jira], { klass: TASK_CLASS.MICRO })
  ok("named playbook on MICRO", named.playbooks.some((p) => p.name === "secret_scan"))
  const med = pickPlugins("trace impact of api.ts on deploy", [jira], { klass: TASK_CLASS.MEDIUM })
  ok("impact playbook on MEDIUM", med.playbooks.some((p) => p.name === "impact_trace"))
  ok("jira not selected for impact", !med.tools.some((p) => p.name === "jira_issue"))
  ok("format playbooks", /PLUGIN PLAYBOOKS/.test(formatPluginPicks(med)))
  ok("secret_scan scores on leak task", scorePlugin("redact leaked tokens", PLUGIN_PLAYBOOKS.find((p) => p.name === "secret_scan")) >= 2)
}

console.log("== MCP rank (no connect) ==")
{
  eq("empty catalog", mcpCatalog({}).length, 0)
  const cfg = { mcp: { servers: { github: { command: "npx", args: ["-y", "x"] }, dead: { command: "x", disabled: true } } } }
  const cat = mcpCatalog(cfg)
  ok("config stub github", cat.some((t) => t.name === "mcp__github"))
  ok("disabled skipped", !cat.some((t) => /dead/.test(t.name)))
  const micro = rankMcp("fix a typo", cat, { klass: TASK_CLASS.MICRO })
  eq("MICRO mcp empty", micro.length, 0)
  const named = rankMcp("use mcp__github on this typo", cat, { klass: TASK_CLASS.MICRO })
  ok("named mcp on MICRO", named.some((t) => t.name === "mcp__github"))
  const med = rankMcp("open a github pull request across files", cat, { klass: TASK_CLASS.MEDIUM })
  ok("github ranked on PR task", med.some((t) => t.name === "mcp__github"), JSON.stringify(med))
  ok("top-k <= 4", med.length <= 4)
  const live = [{ name: "mcp__jira__create_issue", description: "create a jira issue", source: "mcp:jira" }]
  ok("isMcpTool live", isMcpTool(live[0]))
  ok("isMcpTool rejects grep", !isMcpTool({ name: "grep_files" }))
  const mixed = mcpCatalog(cfg, live)
  ok("live beats config stubs", mixed.every((t) => t.name.startsWith("mcp__jira")), JSON.stringify(mixed))
  const rankedLive = rankMcp("create a jira issue across files", mixed, { klass: TASK_CLASS.MEDIUM })
  ok("live jira ranked", rankedLive.some((t) => t.name === "mcp__jira__create_issue"))
  eq("formatMcp empty", formatMcpPicks([]), "")
  ok("formatMcp names", /mcp__github/.test(formatMcpPicks(med)))
}

console.log("== compose snapshot carries rank ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v53-co-"))
  fs.writeFileSync(path.join(dir, "util.js"), "export function authenticate(){ return 1 }\n")
  const cfg = { mcp: { servers: { github: { command: "npx", args: ["gh"] } } } }
  const c = compose(TASK, {
    cwd: dir,
    config: cfg,
    skillsIndex: [
      { name: "coding-agent", desc: "Coding workflow" },
      { name: "gift-evaluator", desc: "Evaluate gift ideas" },
    ],
    includePlugins: false,
    klass: TASK_CLASS.MEDIUM,
  })
  ok("compose skills pick forge-debug", (c.skills || []).some((s) => s.name === "forge-debug"), JSON.stringify(c.skills))
  ok("compose drops gifts", !(c.skills || []).some((s) => s.name === "gift-evaluator"))
  ok("compose playbooks nonempty", (c.playbooks || []).length > 0, JSON.stringify(c.playbooks))
  ok("playbooks are hostless", (c.playbooks || []).every((p) => p.playbook === true))
  const block = formatCompose(c)
  ok("formatCompose [skills]", /\[skills\]/.test(block) && /forge-debug/.test(block), block)
  ok("formatCompose [playbooks]", /\[playbooks\]/.test(block), block)
  const pr = compose("open a github pull request across files", {
    cwd: dir, config: cfg, includePlugins: false, klass: TASK_CLASS.MEDIUM,
  })
  ok("compose mcp github", (pr.mcp || []).some((m) => m.name === "mcp__github"), JSON.stringify(pr.mcp))
  ok("formatCompose [mcp]", /\[mcp\]/.test(formatCompose(pr)) && /mcp__github/.test(formatCompose(pr)), formatCompose(pr))
  const typo = compose("fix a typo in README", { cwd: dir, config: cfg, includePlugins: false })
  eq("typo is MICRO", typo.klass, TASK_CLASS.MICRO)
  eq("typo skills empty", (typo.skills || []).length, 0)
  eq("typo playbooks empty", (typo.playbooks || []).length, 0)
  eq("typo mcp empty", (typo.mcp || []).length, 0)
  ok("typo format has no [mcp]", !/\[mcp\]/.test(formatCompose(typo)))
  ok("typo format has no [playbooks]", !/\[playbooks\]/.test(formatCompose(typo)))
  const off = compose(TASK, { cwd: dir, includePlaybooks: false, includeMcp: false, includePlugins: false, klass: TASK_CLASS.MEDIUM })
  eq("includePlaybooks false", (off.playbooks || []).length, 0)
  eq("includeMcp false", (off.mcp || []).length, 0)
  const e = emptyCompose()
  eq("empty playbooks", e.playbooks.length, 0)
  eq("empty mcp", e.mcp.length, 0)
  eq("empty format still empty", formatCompose(e), "")
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== formatSteer PLAYBOOKS / MCP are additive ==")
{
  eq("empty steer", formatSteer({}), "")
  const withPlay = formatSteer({ playbooks: [{ name: "secret_scan" }] })
  ok("PLAYBOOKS line", /PLAYBOOKS:/.test(withPlay) && /secret_scan/.test(withPlay), withPlay)
  ok("no plugin-host in steer", /do not spawn plugin-host/.test(withPlay), withPlay)
  const withMcp = formatSteer({ mcp: [{ name: "mcp__github" }] })
  ok("MCP line", /MCP:/.test(withMcp) && /mcp__github/.test(withMcp), withMcp)
  const both = formatSteer({
    avoid: ["retry until green"],
    playbooks: [{ name: "focused_verify" }],
    mcp: [{ name: "mcp__github" }],
    tools: { prefer: [{ tool: "read_file" }], avoid: [] },
  })
  ok("AVOID kept", /AVOID:/.test(both) && /retry until green/.test(both), both)
  ok("TOOLS after AVOID", both.indexOf("AVOID:") < both.indexOf("TOOLS:"), both)
  ok("PLAYBOOKS before AVOID", both.indexOf("PLAYBOOKS:") < both.indexOf("AVOID:"), both)
}

console.log("== composeOnce playbooks/mcp are distinct keys ==")
{
  clearComposeOnce()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v53-once-"))
  fs.writeFileSync(path.join(dir, "util.js"), "export const x = 1\n")
  const a = composeOnce(TASK, { cwd: dir, includePlugins: false, klass: TASK_CLASS.MEDIUM })
  const b = composeOnce(TASK, { cwd: dir, includePlugins: false, klass: TASK_CLASS.MEDIUM })
  ok("identical args hit ===", a === b)
  const offB = composeOnce(TASK, { cwd: dir, includePlugins: false, klass: TASK_CLASS.MEDIUM, includePlaybooks: false })
  ok("includePlaybooks false is not ===", offB !== a)
  eq("includePlaybooks false empty", (offB.playbooks || []).length, 0)
  const offC = composeOnce(TASK, { cwd: dir, includePlugins: false, klass: TASK_CLASS.MEDIUM, includeMcp: false })
  ok("includeMcp false is not ===", offC !== a)
  eq("includeMcp false empty", (offC.mcp || []).length, 0)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== source: wired into compose / agent / chat / meta / context ==")
{
  const composeSrc = fs.readFileSync(new URL("../compose.js", import.meta.url), "utf8")
  const agent = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  const chat = fs.readFileSync(new URL("../chat.js", import.meta.url), "utf8")
  const meta = fs.readFileSync(new URL("../meta.js", import.meta.url), "utf8")
  const context = fs.readFileSync(new URL("../context.js", import.meta.url), "utf8")
  const evaluate = fs.readFileSync(new URL("../evaluate.js", import.meta.url), "utf8")
  const plugintel = fs.readFileSync(new URL("../plugintel.js", import.meta.url), "utf8")
  const skillforge = fs.readFileSync(new URL("../skillforge.js", import.meta.url), "utf8")
  ok("compose imports pickSkills", /pickSkills/.test(composeSrc))
  ok("compose imports pickPlugins", /pickPlugins/.test(composeSrc))
  ok("compose imports rankMcp", /rankMcp/.test(composeSrc))
  ok("compose does not import child_process", !/child_process/.test(composeSrc))
  ok("compose does not call loadMcpTools", !/loadMcpTools/.test(composeSrc))
  ok("compose does not call connectServer", !/connectServer/.test(composeSrc))
  ok("plugintel does not call connectServer", !/connectServer\(/.test(plugintel))
  ok("plugintel does not call loadMcpTools", !/loadMcpTools/.test(plugintel))
  ok("agent uses pickSkills", /pickSkills\(/.test(agent))
  ok("chat uses pickSkills", /pickSkills\(/.test(chat))
  ok("context uses pickSkills", /pickSkills\(/.test(context))
  ok("agent formatSteer passes playbooks", /playbooks: composed\?\.playbooks/.test(agent))
  ok("agent formatSteer passes mcp", /mcp: composed\?\.mcp/.test(agent))
  ok("chat formatSteer passes playbooks", /playbooks: composed\?\.playbooks/.test(chat))
  ok("meta formatSteer passes playbooks", /playbooks: composed\.playbooks/.test(meta))
  ok("meta formatSteer passes mcp", /mcp: composed\.mcp/.test(meta))
  ok("meta PLAN_COMPOSE emits playbooks", /playbooks: \(composed\.playbooks/.test(meta))
  ok("meta PLAN_COMPOSE emits mcp", /mcp: \(composed\.mcp/.test(meta))
  ok("formatSteer accepts playbooks", /playbooks = \[\]/.test(evaluate))
  ok("formatSteer accepts mcp", /mcp = \[\]/.test(evaluate))
  ok("evaluateSkills still exported", /export function evaluateSkills/.test(evaluate))
  ok("skillforge does not import omega", !/from "\.\/omega\.js"/.test(skillforge))
  ok("plugintel does not import omega", !/from "\.\/omega\.js"/.test(plugintel))
  ok("compose does not write SKILL.md", !/authorSkill|writeStateFile/.test(composeSrc))
}

console.log("== no side writes / frozen kernel + package ==")
{
  const beforeGlobal = listGlobalTools()
  const hostBefore = fs.readFileSync(HOST, "utf8")
  const bundledBefore = fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(",")
  const cfg = defaultConfig()
  eq("assumeYes stays false", cfg.tools.assumeYes, false)
  eq("allowSudo stays false", cfg.tools.allowSudo, false)
  eq("allowNewPlugins stays false", cfg.tools.allowNewPlugins, false)
  const { dropped } = sanitizeProjectConfig({ tools: { assumeYes: true, allowNewPlugins: true } })
  ok("project cannot flip assumeYes", dropped.includes("tools.assumeYes"))
  ok("project cannot flip allowNewPlugins", dropped.includes("tools.allowNewPlugins"))
  eq("classifyTaskComplexity frozen", classifyTaskComplexity("fix a typo"), "trivial")
  eq("typo still MICRO", classifyTask("fix a typo in README").class, TASK_CLASS.MICRO)
  eq("VERSION is 71.0.0", VERSION, "71.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  eq("package.json is 71.0.0", pkg.version, "71.0.0")
  ok("files includes skillforge.js", pkg.files.includes("skillforge.js"))
  ok("files includes plugintel.js", pkg.files.includes("plugintel.js"))
  ok("files includes compose.js", pkg.files.includes("compose.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
  eq("custom is still index 17 (pick 18)", CATALOG[17]?.name, "custom")
  eq("apinex still after custom", CATALOG[18]?.name, "apinex")
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
  eq("bundled pack unchanged", fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(","), bundledBefore)
}

console.log(`\n== v53 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
