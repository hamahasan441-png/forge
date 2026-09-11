#!/usr/bin/env node
/**
 * forge — v53 skillforge + plugintel.
 *
 * Does not: flip assumeYes, add a runtime dep, spawn plugin-host for playbooks,
 * change classifyTaskComplexity(), dump all skills into MICRO tasks.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v53-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v53-work-"))
process.chdir(WORK)

const {
  FIRST_PARTY, enrichSkills, pickSkills, scoreSkill, formatForgePicks, firstPartyNames, catalogEntry,
} = await import("../forge/skillforge.js")
const { pickPlugins, formatPluginPicks, PLUGIN_PLAYBOOKS, scorePlugin } = await import("../forge/plugintel.js")
const { evaluateSkills } = await import("../forge/evaluate.js")
const { classifyTaskComplexity, classifyTask, TASK_CLASS } = await import("../forge/classify.js")
const { defaultConfig, sanitizeProjectConfig } = await import("../forge/config.js")
const { VERSION } = await import("../forge/version.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

console.log("== catalog ==")
{
  ok("12 first-party skills", FIRST_PARTY.length === 12)
  ok("names are unique", new Set(firstPartyNames()).size === FIRST_PARTY.length)
  ok("coding-agent catalog", catalogEntry("coding-agent")?.tags.includes("code"))
  eq("missing catalog", catalogEntry("nope-skill"), null)
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
  const api = pickSkills("implement a REST API route and OpenAPI across files", indexed)
  ok("api prefers coding or forge-api", api.some((s) => s.name === "coding-agent" || s.name === "forge-api"))
  ok("api drops gifts", !api.some((s) => s.name === "gift-evaluator"))
  eq("default top-k <= 3", api.length <= 3, true)
  const named = pickSkills("use forge-security on this typo", indexed)
  ok("named first-party on MICRO", named.some((s) => s.name === "forge-security"))
  ok("broken never picked", !pickSkills("broken please", indexed).some((s) => s.name === "broken"))
  ok("format lists load_skill", /load_skill/.test(formatForgePicks(named)))
  eq("format empty", formatForgePicks([]), "")
  ok("tag score beats gift", scoreSkill("ssrf secret scan", catalogEntry("forge-security")) > scoreSkill("ssrf secret scan", { name: "gift-evaluator", desc: "gifts" }))
}

console.log("== evaluateSkills contract still holds ==")
{
  const SKILLS = [
    { name: "coding-agent", desc: "Coding workflow with planning" },
    { name: "gift-evaluator", desc: "Evaluate gift ideas" },
  ]
  eq("evaluateSkills typo empty", evaluateSkills("fix a typo in README", SKILLS).length, 0)
}

console.log("== plugintel ==")
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

console.log("== frozen kernel ==")
{
  const cfg = defaultConfig()
  eq("assumeYes false", cfg.tools.assumeYes, false)
  eq("allowSudo false", cfg.tools.allowSudo, false)
  const { dropped } = sanitizeProjectConfig({ tools: { assumeYes: true } })
  ok("project cannot flip assumeYes", dropped.includes("tools.assumeYes"))
  eq("classifyTaskComplexity frozen", classifyTaskComplexity("fix a typo"), "trivial")
  eq("typo still MICRO", classifyTask("fix a typo in README").class, TASK_CLASS.MICRO)
  eq("VERSION stays 37.0.0", VERSION, "37.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8"))
  ok("files includes skillforge.js", pkg.files.includes("skillforge.js"))
  ok("files includes plugintel.js", pkg.files.includes("plugintel.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
}

console.log(`\n== v53 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
