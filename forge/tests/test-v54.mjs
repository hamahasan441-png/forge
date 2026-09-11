#!/usr/bin/env node
/**
 * forge — v54 knowgap: required vs known vs skippable → compose / planner.
 *
 * Persist under FORGE_HOME/projects/<hash>/knowgap.json (0600, no task text).
 * Compose never writes. Does not: flip assumeYes, add a runtime dep, spawn
 * plugin-host, connect MCP, change classifyTaskComplexity(), dump skills,
 * write ~/.forge/tools, invent a second data root.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v54-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v54-work-"))
process.chdir(WORK)

const {
  DOMAINS, detectGaps, requiredDomains, persistGaps, recordGapOutcome,
  loadGapStats, clearGapStats, gapStatsPath, emptyGaps, formatGaps, formatGapSteer,
  dataStatus, formatDataStatus, STATUS, IMPACT, LIFECYCLE,
} = await import("../knowgap.js")
const { compose, composeOnce, clearComposeOnce, formatCompose, emptyCompose } = await import("../compose.js")
const { formatSteer, evaluateSkills } = await import("../evaluate.js")
const { classifyTaskComplexity, classifyTask, TASK_CLASS } = await import("../classify.js")
const { defaultConfig, sanitizeProjectConfig, DEFAULT_DIR } = await import("../config.js")
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
const HOST = path.join(HERE, "../plugin-host.js")
const BUNDLED = path.join(HERE, "../skills")
const FORGE_BIN = path.join(HERE, "../forge.js")
const PAY = "Build a production-quality payment system across files"
const CSS = "add a css animation to the header across files"
const AUTH = "debug the failing authentication module in util.js for production"

function listGlobalTools() {
  try { return fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")) } catch { return [] }
}

console.log("== catalog ==")
{
  ok("12 domains", DOMAINS.length === 12)
  ok("ids unique", new Set(DOMAINS.map((d) => d.id)).size === DOMAINS.length)
  ok("payment is CRITICAL", DOMAINS.find((d) => d.id === "payment")?.impact === IMPACT.CRITICAL)
  ok("ui is LOW", DOMAINS.find((d) => d.id === "ui")?.impact === IMPACT.LOW)
}

console.log("== requiredDomains ==")
{
  eq("typo empty", requiredDomains("fix a typo in README", { klass: TASK_CLASS.MICRO }).length, 0)
  const pay = requiredDomains(PAY, { klass: TASK_CLASS.LARGE })
  ok("payment required", pay.some((d) => d.id === "payment" && d.impact === "CRITICAL"), JSON.stringify(pay))
  ok("implies api", pay.some((d) => d.id === "api"), JSON.stringify(pay))
  ok("implies database", pay.some((d) => d.id === "database"), JSON.stringify(pay))
  ok("implies security", pay.some((d) => d.id === "security"), JSON.stringify(pay))
  const named = requiredDomains("use payment on this typo", { klass: TASK_CLASS.MICRO })
  ok("named payment on MICRO", named.some((d) => d.id === "payment"))
  eq("unnamed MICRO still empty", requiredDomains("fix a typo", { klass: TASK_CLASS.MICRO }).length, 0)
}

console.log("== detectGaps skip vs block ==")
{
  const pay = detectGaps(PAY, { klass: TASK_CLASS.LARGE })
  ok("payment is a gap", pay.gaps.some((g) => g.id === "payment" && g.status === STATUS.UNKNOWN && g.learn), JSON.stringify(pay.gaps))
  ok("formatGaps lists payment", /\[gaps\]/.test(formatGaps(pay)) && /payment/.test(formatGaps(pay)), formatGaps(pay))
  const css = detectGaps(CSS, { klass: TASK_CLASS.MEDIUM })
  ok("css is skippable", css.skip.some((s) => s.id === "ui"), JSON.stringify(css))
  eq("css has no blocking gaps", css.gaps.length, 0)
  ok("formatGaps [skip]", /\[skip\]/.test(formatGaps(css)) && /ui/.test(formatGaps(css)), formatGaps(css))
  eq("empty task", detectGaps("").gaps.length, 0)
  eq("emptyGaps format", formatGaps(emptyGaps()), "")
}

console.log("== evidence is probable, never verified from lexical ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v54-ev-"))
  fs.writeFileSync(path.join(dir, "payments.js"), "export function charge(){ return 1 }\n")
  const g = detectGaps(PAY, {
    cwd: dir, klass: TASK_CLASS.LARGE,
    world: { files: ["payments.js"], radius: [], langs: [] },
  })
  const row = [...g.known, ...g.gaps].find((x) => x.id === "payment")
  ok("file hit is PROBABLE", row && row.status === STATUS.PROBABLE, JSON.stringify(row))
  ok("not VERIFIED from a filename", row && row.confidence < 0.8, JSON.stringify(row))
  const mem = detectGaps(PAY, {
    klass: TASK_CLASS.LARGE,
    memory: "- stripe checkout uses webhook signing",
  })
  const mrow = [...mem.known, ...mem.gaps].find((x) => x.id === "payment")
  ok("memory hit is PROBABLE", mrow && mrow.status === STATUS.PROBABLE, JSON.stringify(mrow))
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== persist: 0600, hashed task, FORGE_HOME project dir ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v54-p-"))
  fs.writeFileSync(path.join(dir, "app.js"), "export const x = 1\n")
  const g = detectGaps(PAY, { cwd: dir, klass: TASK_CLASS.LARGE })
  eq("compose-style detect does not write", fs.existsSync(gapStatsPath(dir)), false)
  const saved = persistGaps(dir, g, { task: PAY + " SECRET sk-abc-secret" })
  ok("persist returned", saved && saved.domains && saved.domains.payment)
  const file = gapStatsPath(dir)
  ok("file exists", fs.existsSync(file))
  ok("under FORGE_HOME", file.startsWith(HOME), file)
  ok("not in user project", !file.startsWith(dir), file)
  const mode = fs.statSync(file).mode & 0o777
  eq("mode 0600", mode, 0o600)
  const raw = fs.readFileSync(file, "utf8")
  ok("no task text", !/Build a production/.test(raw))
  ok("no secret", !/sk-abc-secret/.test(raw))
  ok("schema v1", /"v": 1/.test(raw))
  const loaded = loadGapStats(dir)
  ok("load payment", loaded.domains.payment && loaded.domains.payment.status === STATUS.UNKNOWN)
  clearGapStats(dir)
  ok("clear removes file", !fs.existsSync(file))
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== recordGapOutcome is the only VERIFIED path ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v54-v-"))
  persistGaps(dir, detectGaps(PAY, { klass: TASK_CLASS.LARGE }), { task: PAY })
  recordGapOutcome({ cwd: dir, id: "payment", status: LIFECYCLE.VERIFIED, evidence: "stripe test passed" })
  const next = detectGaps(PAY, { cwd: dir, klass: TASK_CLASS.LARGE })
  const row = [...next.known, ...next.gaps].find((x) => x.id === "payment")
  ok("verified is KNOWN", row && row.status === STATUS.KNOWN, JSON.stringify(row))
  ok("verified confidence 0.9", row && row.confidence === 0.9, JSON.stringify(row))
  eq("lifecycle VERIFIED", loadGapStats(dir).domains.payment.lifecycle, LIFECYCLE.VERIFIED)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== compose snapshot carries gaps, never writes ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v54-co-"))
  fs.writeFileSync(path.join(dir, "util.js"), "export function authenticate(){ return 1 }\n")
  const c = compose(AUTH, { cwd: dir, includePlugins: false, klass: TASK_CLASS.MEDIUM })
  ok("compose gaps nonempty", (c.gaps?.gaps || []).length + (c.gaps?.required || []).length > 0, JSON.stringify(c.gaps))
  ok("auth required", (c.gaps?.required || []).some((d) => d.id === "auth"), JSON.stringify(c.gaps?.required))
  const block = formatCompose(c)
  ok("formatCompose [gaps]", /\[gaps\]/.test(block), block)
  ok("compose did not write knowgap.json", !fs.existsSync(gapStatsPath(dir)))
  const typo = compose("fix a typo in README", { cwd: dir, includePlugins: false })
  eq("typo is MICRO", typo.klass, TASK_CLASS.MICRO)
  eq("typo gaps empty", (typo.gaps?.gaps || []).length, 0)
  eq("typo skip empty", (typo.gaps?.skip || []).length, 0)
  ok("typo format has no [gaps]", !/\[gaps\]/.test(formatCompose(typo)))
  const off = compose(AUTH, { cwd: dir, includeGaps: false, includePlugins: false, klass: TASK_CLASS.MEDIUM })
  eq("includeGaps false", (off.gaps?.gaps || []).length, 0)
  const e = emptyCompose()
  eq("empty gaps", e.gaps.gaps.length, 0)
  eq("empty format still empty", formatCompose(e), "")
  const css = compose(CSS, { cwd: dir, includePlugins: false, klass: TASK_CLASS.MEDIUM })
  ok("css skip ui", (css.gaps?.skip || []).some((s) => s.id === "ui"), JSON.stringify(css.gaps))
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== formatSteer GAPS / SKIP are additive ==")
{
  eq("empty steer", formatSteer({}), "")
  const withGaps = formatSteer({ gaps: { gaps: [{ id: "payment", impact: "CRITICAL", status: "UNKNOWN", learn: true }], skip: [] } })
  ok("GAPS line", /GAPS:/.test(withGaps) && /payment/.test(withGaps), withGaps)
  ok("learn hint", /research\+verify/.test(withGaps), withGaps)
  const withSkip = formatSteer({ gaps: { gaps: [], skip: [{ id: "ui", impact: "LOW" }] } })
  ok("SKIP line", /SKIP:/.test(withSkip) && /ui/.test(withSkip), withSkip)
  const both = formatSteer({
    avoid: ["retry until green"],
    mcp: [{ name: "mcp__github" }],
    gaps: { gaps: [{ id: "auth", impact: "HIGH", status: "UNKNOWN", learn: true }], skip: [] },
  })
  ok("MCP kept", /MCP:/.test(both), both)
  ok("GAPS after MCP", both.indexOf("MCP:") < both.indexOf("GAPS:"), both)
  ok("GAPS before AVOID", both.indexOf("GAPS:") < both.indexOf("AVOID:"), both)
  ok("formatGapSteer matches", /GAPS:/.test(formatGapSteer({ gaps: [{ id: "payment", impact: "CRITICAL", status: "UNKNOWN", learn: true }] })))
}

console.log("== composeOnce includeGaps is a distinct key ==")
{
  clearComposeOnce()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v54-once-"))
  fs.writeFileSync(path.join(dir, "util.js"), "export const x = 1\n")
  const a = composeOnce(AUTH, { cwd: dir, includePlugins: false, klass: TASK_CLASS.MEDIUM })
  const b = composeOnce(AUTH, { cwd: dir, includePlugins: false, klass: TASK_CLASS.MEDIUM })
  ok("identical args hit ===", a === b)
  const off = composeOnce(AUTH, { cwd: dir, includePlugins: false, klass: TASK_CLASS.MEDIUM, includeGaps: false })
  ok("includeGaps false is not ===", off !== a)
  eq("includeGaps false empty", (off.gaps?.gaps || []).length, 0)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== forge data CLI + dataStatus ==")
{
  const s = dataStatus(WORK)
  eq("root is FORGE_HOME", s.root, HOME)
  eq("via FORGE_HOME", s.via, "FORGE_HOME")
  eq("DEFAULT_DIR is HOME", DEFAULT_DIR, HOME)
  ok("project hash", typeof s.project === "string" && s.project.length === 12)
  ok("projectDir under HOME", s.projectDir.startsWith(HOME))
  ok("format lists root", /forge data/.test(formatDataStatus(s)))
  persistGaps(WORK, detectGaps(PAY, { klass: TASK_CLASS.LARGE }), { task: PAY })
  const out = execFileSync(process.execPath, [FORGE_BIN, "data", "status"], {
    encoding: "utf8", cwd: WORK, env: { ...process.env, FORGE_HOME: HOME, NO_COLOR: "1" },
  })
  ok("cli status prints root", out.includes(HOME), out.slice(0, 240))
  const gapsOut = execFileSync(process.execPath, [FORGE_BIN, "data", "gaps"], {
    encoding: "utf8", cwd: WORK, env: { ...process.env, FORGE_HOME: HOME, NO_COLOR: "1" },
  })
  ok("cli gaps lists payment", /payment/.test(gapsOut), gapsOut.slice(0, 240))
  execFileSync(process.execPath, [FORGE_BIN, "data", "reset", "gaps"], {
    encoding: "utf8", cwd: WORK, env: { ...process.env, FORGE_HOME: HOME, NO_COLOR: "1" },
  })
  ok("reset removed file", !fs.existsSync(gapStatsPath(WORK)))
}

console.log("== source: wired, compose write-free, no second root ==")
{
  const composeSrc = fs.readFileSync(new URL("../compose.js", import.meta.url), "utf8")
  const agent = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  const chat = fs.readFileSync(new URL("../chat.js", import.meta.url), "utf8")
  const meta = fs.readFileSync(new URL("../meta.js", import.meta.url), "utf8")
  const evaluate = fs.readFileSync(new URL("../evaluate.js", import.meta.url), "utf8")
  const knowgap = fs.readFileSync(new URL("../knowgap.js", import.meta.url), "utf8")
  const forge = fs.readFileSync(new URL("../forge.js", import.meta.url), "utf8")
  ok("compose imports detectGaps", /detectGaps/.test(composeSrc))
  ok("compose does not import writeStateFile", !/writeStateFile/.test(composeSrc))
  ok("compose does not call persistGaps", !/persistGaps/.test(composeSrc))
  ok("compose does not import child_process", !/child_process/.test(composeSrc))
  ok("knowgap writes via writeStateFile", /writeStateFile/.test(knowgap))
  ok("knowgap uses projectDir", /projectDir/.test(knowgap))
  ok("knowgap does not import omega", !/from "\.\/omega\.js"/.test(knowgap))
  ok("agent formatSteer passes gaps", /gaps: composed\?\.gaps/.test(agent))
  ok("chat formatSteer passes gaps", /gaps: composed\?\.gaps/.test(chat))
  ok("meta formatSteer passes gaps", /gaps: composed\.gaps/.test(meta))
  ok("meta persists after plan", /persistGaps\(/.test(meta))
  ok("meta PLAN_COMPOSE emits gaps", /gaps: \(composed\.gaps/.test(meta))
  ok("formatSteer accepts gaps", /gaps = null/.test(evaluate))
  ok("evaluateSkills still exported", /export function evaluateSkills/.test(evaluate))
  ok("forge data command", /case "data"/.test(forge))
  ok("help mentions forge data", /forge data/.test(forge))
  ok("no ~/.config store", !/~\/\.config/.test(knowgap))
  ok("no /var store", !/\/var\//.test(knowgap))
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
  eq("evaluateSkills typo empty", evaluateSkills("fix a typo in README", [{ name: "coding-agent", desc: "Coding workflow with planning" }]).length, 0)
  eq("VERSION is 72.0.0", VERSION, "72.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  eq("package.json is 72.0.0", pkg.version, "72.0.0")
  ok("files includes knowgap.js", pkg.files.includes("knowgap.js"))
  ok("files includes compose.js", pkg.files.includes("compose.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
  eq("custom is still index 17 (pick 18)", CATALOG[17]?.name, "custom")
  eq("apinex still after custom", CATALOG[18]?.name, "apinex")
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
  eq("bundled pack unchanged", fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(","), bundledBefore)
  void projectDir
}

console.log(`\n== v54 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
