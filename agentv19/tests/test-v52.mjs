#!/usr/bin/env node
/**
 * forge — v52 toolmem: persist toolintel outcomes → compose / steer.
 *
 * Aggregates only (no result text). 0600. MICRO skip for steer.
 * runCall / cheaperAlternative unchanged. Does not: flip assumeYes,
 * flip allowNewPlugins, add a runtime dep, spawn a second writer,
 * change classifyTaskComplexity(), write ~/.forge/tools, or weaken
 * plugin-iso. Wizard pick 18 stays custom.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v52-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v52-work-"))
process.chdir(WORK)

const {
  recordToolRun, relevantTools, formatToolMem, emptyTools,
  loadToolStats, clearToolStats, toolStatsPath,
} = await import("../forge/toolintel.js")
const { compose, composeOnce, clearComposeOnce, formatCompose, emptyCompose } = await import("../forge/compose.js")
const { formatSteer } = await import("../forge/evaluate.js")
const { PLUGINS_DIR } = await import("../forge/plugins.js")
const { defaultConfig, sanitizeProjectConfig } = await import("../forge/config.js")
const { classifyTaskComplexity, classifyTask, TASK_CLASS } = await import("../forge/classify.js")
const { VERSION } = await import("../forge/version.js")
const { CATALOG } = await import("../forge/providers.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOST = path.join(HERE, "../forge/plugin-host.js")
const BUNDLED = path.join(HERE, "../forge/skills")
const TASK = "debug the failing authentication module in util.js for production"

function listGlobalTools() {
  try { return fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")) } catch { return [] }
}

function rec(tool, status, extra = {}) {
  return { tool, status, failure: extra.failure ?? null, duration_ms: extra.ms ?? 1, cached: extra.cached === true }
}

function nOk(tool, n, klass = TASK_CLASS.MEDIUM) {
  return Array.from({ length: n }, () => rec(tool, "ok"))
    .map((r) => ({ ...r, _klass: klass }))
}

console.log("== persist: writes aggregates, 0600, no result text ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v52-p-"))
  fs.writeFileSync(path.join(dir, "util.js"), "export const x = 1\n")
  eq("empty records is null", recordToolRun({ cwd: dir, records: [] }), null)
  ok("no file yet", !fs.existsSync(toolStatsPath(dir)))
  const r = recordToolRun({
    cwd: dir, klass: TASK_CLASS.MEDIUM, task: TASK,
    records: [
      rec("grep_files", "ok"),
      rec("grep_files", "ok"),
      rec("grep_files", "ok"),
      rec("bash", "failed", { failure: "SAFETY_BLOCK" }),
      rec("bash", "blocked", { failure: "SAFETY_BLOCK" }),
      rec("bash", "failed", { failure: "SAFETY_BLOCK" }),
      rec("think", "ok"),
      rec("todo", "ok"),
      rec("memory", "ok"),
      { tool: "read_file", status: "ok", result: "SECRET sk-abc result text", arguments_summary: "/etc/passwd" },
    ],
  })
  ok("record returned stats", r && r.tools && r.tools.grep_files)
  eq("grep samples 3", r.tools.grep_files.samples, 3)
  eq("grep ok 3", r.tools.grep_files.ok, 3)
  eq("bash samples 3", r.tools.bash.samples, 3)
  ok("noise think skipped", r.tools.think == null)
  ok("noise todo skipped", r.tools.todo == null)
  ok("noise memory skipped", r.tools.memory == null)
  const file = toolStatsPath(dir)
  ok("file exists", fs.existsSync(file))
  const mode = fs.statSync(file).mode & 0o777
  eq("mode 0600", mode, 0o600)
  const raw = fs.readFileSync(file, "utf8")
  ok("no result text", !/SECRET|sk-abc|\/etc\/passwd/.test(raw))
  const loaded = loadToolStats(dir)
  eq("load grep ok", loaded.tools.grep_files.ok, 3)
  clearToolStats(dir)
  ok("clear removes file", !fs.existsSync(file))
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== damping: one sample cannot prefer or avoid ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v52-d-"))
  recordToolRun({ cwd: dir, klass: TASK_CLASS.MEDIUM, records: [rec("bash", "failed", { failure: "NOT_FOUND" })] })
  const one = relevantTools(TASK, { cwd: dir, klass: TASK_CLASS.MEDIUM })
  eq("1 fail prefer empty", one.prefer.length, 0)
  eq("1 fail avoid empty", one.avoid.length, 0)
  recordToolRun({
    cwd: dir, klass: TASK_CLASS.MEDIUM,
    records: [rec("bash", "failed", { failure: "NOT_FOUND" }), rec("bash", "failed", { failure: "NOT_FOUND" })],
  })
  const three = relevantTools(TASK, { cwd: dir, klass: TASK_CLASS.MEDIUM })
  eq("3 fail prefer empty", three.prefer.length, 0)
  ok("3 fail avoids bash", three.avoid.some((t) => t.tool === "bash"), JSON.stringify(three))
  ok("avoid cites failure", three.avoid.some((t) => t.tool === "bash" && t.why), JSON.stringify(three.avoid))
  const gdir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v52-g-"))
  recordToolRun({ cwd: gdir, klass: TASK_CLASS.MEDIUM, records: nOk("grep_files", 3) })
  const good = relevantTools(TASK, { cwd: gdir, klass: TASK_CLASS.MEDIUM })
  ok("3 ok prefers grep_files", good.prefer.some((t) => t.tool === "grep_files"), JSON.stringify(good))
  ok("prefer has rate", good.prefer[0].rate >= 0.8)
  const micro = relevantTools(TASK, { cwd: gdir, klass: TASK_CLASS.MICRO })
  eq("MICRO prefer empty", micro.prefer.length, 0)
  eq("MICRO avoid empty", micro.avoid.length, 0)
  const small = relevantTools(TASK, { cwd: gdir, klass: TASK_CLASS.SMALL })
  eq("SMALL prefer empty", small.prefer.length, 0)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(gdir, { recursive: true, force: true }) } catch {}
}

console.log("== cap 32 + malformed file is empty, not a throw ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v52-c-"))
  const recs = []
  for (let i = 0; i < 40; i++) recs.push(rec(`tool_${i}`, "ok"))
  recordToolRun({ cwd: dir, klass: TASK_CLASS.MEDIUM, records: recs })
  const n = Object.keys(loadToolStats(dir).tools).length
  ok("capped at 32", n <= 32, `got ${n}`)
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v52-bad-"))
  fs.mkdirSync(path.dirname(toolStatsPath(bad)), { recursive: true })
  fs.writeFileSync(toolStatsPath(bad), "{not json")
  let threw = false
  let empty
  try { empty = loadToolStats(bad) } catch { threw = true }
  ok("malformed does not throw", !threw)
  eq("malformed tools empty", Object.keys(empty.tools).length, 0)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(bad, { recursive: true, force: true }) } catch {}
}

console.log("== compose + formatCompose [tools] ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v52-co-"))
  fs.writeFileSync(path.join(dir, "util.js"), "export function authenticate(){ return 1 }\n")
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app", scripts: { test: "node --test" } }))
  recordToolRun({ cwd: dir, klass: TASK_CLASS.MEDIUM, records: nOk("grep_files", 4) })
  recordToolRun({
    cwd: dir, klass: TASK_CLASS.MEDIUM,
    records: [rec("bash", "failed", { failure: "SAFETY_BLOCK" }), rec("bash", "blocked", { failure: "SAFETY_BLOCK" }), rec("bash", "failed", { failure: "SAFETY_BLOCK" })],
  })
  const c = compose(TASK, { cwd: dir, includePlugins: false, klass: TASK_CLASS.MEDIUM })
  ok("compose.tools prefer grep", (c.tools?.prefer || []).some((t) => t.tool === "grep_files"), JSON.stringify(c.tools))
  ok("compose.tools avoid bash", (c.tools?.avoid || []).some((t) => t.tool === "bash"), JSON.stringify(c.tools))
  const block = formatCompose(c)
  ok("formatCompose [tools]", /\[tools\]/.test(block), block)
  ok("formatCompose prefer", /prefer/.test(block) && /grep_files/.test(block), block)
  ok("formatCompose avoid", /avoid/.test(block) && /bash/.test(block), block)
  const typo = compose("fix a typo in README", { cwd: dir, includePlugins: false })
  eq("typo is MICRO", typo.klass, TASK_CLASS.MICRO)
  eq("typo tools prefer empty", (typo.tools?.prefer || []).length, 0)
  ok("typo format has no [tools]", !/\[tools\]/.test(formatCompose(typo)), formatCompose(typo))
  const off = compose(TASK, { cwd: dir, includePlugins: false, includeTools: false, klass: TASK_CLASS.MEDIUM })
  eq("includeTools false prefer empty", (off.tools?.prefer || []).length, 0)
  const e = emptyCompose()
  eq("emptyCompose tools prefer", e.tools.prefer.length, 0)
  eq("empty format still empty", formatCompose(e), "")
  eq("formatToolMem empty", formatToolMem(emptyTools()), "")
  eq("formatToolMem null", formatToolMem(null), "")
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== formatSteer TOOLS is additive ==")
{
  eq("empty steer", formatSteer({}), "")
  const withTools = formatSteer({
    tools: {
      prefer: [{ tool: "grep_files", rate: 0.91, samples: 4 }],
      avoid: [{ tool: "bash", why: "SAFETY_BLOCK", samples: 3 }],
    },
  })
  ok("TOOLS line", /TOOLS:/.test(withTools), withTools)
  ok("prefer grep", /prefer grep_files/.test(withTools), withTools)
  ok("avoid bash", /avoid bash/.test(withTools) && /SAFETY_BLOCK/.test(withTools), withTools)
  const both = formatSteer({
    avoid: ["retry until green"],
    tools: { prefer: [{ tool: "read_file" }], avoid: [] },
  })
  ok("AVOID kept", /AVOID:/.test(both) && /retry until green/.test(both), both)
  ok("TOOLS after AVOID", both.indexOf("AVOID:") < both.indexOf("TOOLS:"), both)
  const play = formatSteer({
    plugins: [{ name: "learned_x", isolated: true, repair: "set the Authorization header", files: ["auth.js"] }],
    tools: { prefer: [{ tool: "grep_files" }], avoid: [] },
  })
  ok("TRY FIRST still first", play.startsWith("TRY FIRST"), play)
  ok("TOOLS still present", /TOOLS:/.test(play), play)
}

console.log("== composeOnce includeTools is a distinct key ==")
{
  clearComposeOnce()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v52-once-"))
  fs.writeFileSync(path.join(dir, "util.js"), "export const x = 1\n")
  recordToolRun({ cwd: dir, klass: TASK_CLASS.MEDIUM, records: nOk("grep_files", 3) })
  const a = composeOnce(TASK, { cwd: dir, includePlugins: false, klass: TASK_CLASS.MEDIUM })
  const b = composeOnce(TASK, { cwd: dir, includePlugins: false, klass: TASK_CLASS.MEDIUM })
  ok("identical args hit ===", a === b)
  const off = composeOnce(TASK, { cwd: dir, includePlugins: false, klass: TASK_CLASS.MEDIUM, includeTools: false })
  ok("includeTools false is not ===", off !== a)
  eq("includeTools false empty prefer", (off.tools?.prefer || []).length, 0)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== source: persist from agent/chat; runCall untouched ==")
{
  const toolintel = fs.readFileSync(new URL("../forge/toolintel.js", import.meta.url), "utf8")
  const agent = fs.readFileSync(new URL("../forge/agent.js", import.meta.url), "utf8")
  const chat = fs.readFileSync(new URL("../forge/chat.js", import.meta.url), "utf8")
  const meta = fs.readFileSync(new URL("../forge/meta.js", import.meta.url), "utf8")
  const composeSrc = fs.readFileSync(new URL("../forge/compose.js", import.meta.url), "utf8")
  const evaluate = fs.readFileSync(new URL("../forge/evaluate.js", import.meta.url), "utf8")
  ok("recordToolRun exported", /export function recordToolRun/.test(toolintel))
  ok("relevantTools exported", /export function relevantTools/.test(toolintel))
  ok("agent persists in finally", /recordToolRun\(/.test(agent))
  ok("chat persists after runBatch", /recordToolRun\(/.test(chat))
  ok("meta does not call recordToolRun", !/recordToolRun/.test(meta))
  ok("meta formatSteer passes tools", /formatSteer\(\{[\s\S]*tools: composed\.tools/.test(meta))
  ok("agent formatSteer passes tools", /tools: composed\?\.tools/.test(agent))
  ok("chat formatSteer passes tools", /tools: composed\?\.tools/.test(chat))
  ok("runCall does not persist", !/async function runCall[\s\S]*?^  async function runBatch/m.test(toolintel) || !/async function runCall[\s\S]{0,8000}recordToolRun\(/.test(toolintel))
  ok("cheaperAlternative still wired", /cheaperAlternative\(name, args/.test(toolintel))
  ok("nextAction still wired", /nextAction\(\{ task, history: records/.test(toolintel))
  ok("recoveryPlan still wired", /recoveryPlan\(/.test(toolintel))
  ok("compose imports relevantTools", /relevantTools/.test(composeSrc))
  ok("compose does not import child_process", !/child_process/.test(composeSrc))
  ok("compose does not write SKILL.md", !/authorSkill|writeStateFile/.test(composeSrc))
  ok("formatSteer accepts tools", /tools = null/.test(evaluate))
  ok("omega kernel not imported by toolintel persist", !/from "\.\/omega\.js"/.test(toolintel))
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
  eq("VERSION is 57.0.0", VERSION, "57.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8"))
  eq("package.json is 57.0.0", pkg.version, "57.0.0")
  ok("files includes toolintel.js", pkg.files.includes("toolintel.js"))
  ok("files includes compose.js", pkg.files.includes("compose.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
  eq("custom is still index 17 (pick 18)", CATALOG[17]?.name, "custom")
  eq("apinex still after custom", CATALOG[18]?.name, "apinex")
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
  eq("bundled pack unchanged", fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(","), bundledBefore)
}

console.log(`\n== v52 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
