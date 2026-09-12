#!/usr/bin/env node
/**
 * forge — v56 ingest: record real acquire-tool runs as UNCERTAIN.
 *
 * Never VERIFIED from a search. Never stores result text or URLs.
 * Next planAcquire skips tried methods. Does not: dump pages, flip
 * assumeYes, add a runtime dep, spawn plugin-host, change
 * classifyTaskComplexity(), write ~/.forge/tools.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v56-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v56-work-"))
process.chdir(WORK)

const {
  detectGaps, planAcquire, persistGaps, ingestAcquire, loadGapStats, gapStatsPath,
  recordGapOutcome, METHOD, STATUS, LIFECYCLE,
} = await import("../knowgap.js")
const { compose, formatCompose } = await import("../compose.js")
const { formatSteer, evaluateSkills } = await import("../evaluate.js")
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
const PAY = "Build a production-quality payment system across files"
const GAP = { id: "payment", impact: "CRITICAL", status: STATUS.UNKNOWN, learn: true }

function listGlobalTools() {
  try { return fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")) } catch { return [] }
}

console.log("== ingestAcquire records UNCERTAIN, never VERIFIED ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v56-in-"))
  persistGaps(dir, detectGaps(PAY, { klass: TASK_CLASS.LARGE, skills: [], world: { files: [] } }), { task: PAY })
  const before = loadGapStats(dir).domains.payment
  ok("before is not VERIFIED", before && before.lifecycle !== LIFECYCLE.VERIFIED, JSON.stringify(before))
  const out = ingestAcquire({
    cwd: dir,
    task: PAY,
    klass: TASK_CLASS.LARGE,
    records: [{
      tool: "web_search",
      status: "ok",
      arguments_summary: "payment official documentation",
      result: "HUGE PAGE BODY https://evil.example/secret sk-abc",
    }],
  })
  ok("ingest returned", !!out)
  const rec = loadGapStats(dir).domains.payment
  eq("status UNCERTAIN", rec.status, STATUS.UNCERTAIN)
  ok("not VERIFIED", rec.lifecycle !== LIFECYCLE.VERIFIED, JSON.stringify(rec))
  ok("tried includes web", Array.isArray(rec.tried) && rec.tried.includes(METHOD.WEB), JSON.stringify(rec.tried))
  ok("confidence <= 0.5", rec.confidence <= 0.5, rec.confidence)
  const raw = fs.readFileSync(gapStatsPath(dir), "utf8")
  ok("no page body", !/HUGE PAGE BODY/.test(raw))
  ok("no url dumped", !/evil\.example/.test(raw))
  ok("no https dump", !/https:\/\//.test(raw))
  ok("no secret", !/sk-abc/.test(raw))
  eq("failed records ignored", ingestAcquire({
    cwd: dir, task: PAY,
    records: [{ tool: "web_search", status: "failed", arguments_summary: "payment" }],
  }), null)
  eq("bash ignored", ingestAcquire({
    cwd: dir, task: PAY,
    records: [{ tool: "bash", status: "ok", arguments_summary: "npm test" }],
  }), null)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== load_skill matches payment via forge-api ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v56-sk-"))
  ingestAcquire({
    cwd: dir, task: PAY, klass: TASK_CLASS.LARGE,
    records: [{ tool: "load_skill", status: "ok", arguments_summary: "forge-api" }],
  })
  const rec = loadGapStats(dir).domains.payment
  ok("tried skill", rec && rec.tried && rec.tried.includes(METHOD.SKILL), JSON.stringify(rec))
  eq("uncertain", rec.status, STATUS.UNCERTAIN)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== planAcquire skips tried, then verify ==")
{
  const skill = planAcquire(GAP, { skills: [{ name: "forge-api" }], tried: [METHOD.SKILL] })
  ok("skips skill", skill && skill.method !== METHOD.SKILL, JSON.stringify(skill))
  const web = planAcquire(GAP, { skills: [], world: { files: [] }, tried: [METHOD.SKILL] })
  eq("falls to web", web?.method, METHOD.WEB)
  const done = planAcquire(GAP, { skills: [], world: { files: [] }, tried: [METHOD.SKILL, METHOD.REPO, METHOD.DOCS, METHOD.WEB] })
  eq("exhausted is verify", done?.method, METHOD.VERIFY)
  ok("verify is not web_search", done?.tool !== "web_search")
  ok("verify is not fetch_url", done?.tool !== "fetch_url")
}

console.log("== detectGaps after ingest skips the tried method ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v56-det-"))
  ingestAcquire({
    cwd: dir, task: PAY, klass: TASK_CLASS.LARGE,
    records: [{ tool: "load_skill", status: "ok", arguments_summary: "forge-api" }],
  })
  const g = detectGaps(PAY, {
    cwd: dir, klass: TASK_CLASS.LARGE,
    skills: [{ name: "forge-api" }], world: { files: [] },
  })
  const pay = (g.learn || []).find((l) => l.id === "payment")
  ok("payment still learns", !!pay, JSON.stringify(g.learn))
  ok("does not re-suggest load_skill", pay && pay.method !== METHOD.SKILL, JSON.stringify(pay))
  ok("payment gap is UNCERTAIN", (g.gaps || []).some((x) => x.id === "payment" && x.status === STATUS.UNCERTAIN), JSON.stringify(g.gaps))
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== persistGaps will not demote UNCERTAIN ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v56-dem-"))
  ingestAcquire({
    cwd: dir, task: PAY, klass: TASK_CLASS.LARGE,
    records: [{ tool: "web_search", status: "ok", arguments_summary: "payment official documentation" }],
  })
  persistGaps(dir, detectGaps(PAY, { klass: TASK_CLASS.LARGE, skills: [], world: { files: [] } }), { task: PAY })
  const rec = loadGapStats(dir).domains.payment
  eq("still UNCERTAIN", rec.status, STATUS.UNCERTAIN)
  ok("tried kept", rec.tried && rec.tried.includes(METHOD.WEB), JSON.stringify(rec.tried))
  recordGapOutcome({ cwd: dir, id: "payment", status: LIFECYCLE.VERIFIED, evidence: "stripe test passed" })
  eq("outcome still VERIFIED", loadGapStats(dir).domains.payment.lifecycle, LIFECYCLE.VERIFIED)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== compose still never writes / fetches ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v56-co-"))
  fs.writeFileSync(path.join(dir, "util.js"), "export const x = 1\n")
  compose(PAY, { cwd: dir, includePlugins: false, klass: TASK_CLASS.LARGE })
  ok("compose did not write knowgap.json", !fs.existsSync(gapStatsPath(dir)))
  eq("empty steer", formatSteer({}), "")
  ok("typo format has no [learn]", !/\[learn\]/.test(formatCompose(compose("fix a typo in README", { cwd: dir, includePlugins: false }))))
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== source: wired in agent/chat, not compose ==")
{
  const knowgap = fs.readFileSync(new URL("../knowgap.js", import.meta.url), "utf8")
  const composeSrc = fs.readFileSync(new URL("../compose.js", import.meta.url), "utf8")
  const agent = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  const chat = fs.readFileSync(new URL("../chat.js", import.meta.url), "utf8")
  const meta = fs.readFileSync(new URL("../meta.js", import.meta.url), "utf8")
  ok("ingestAcquire exported", /export function ingestAcquire/.test(knowgap))
  ok("knowgap has no fetch(", !/\bfetch\(/.test(knowgap))
  ok("knowgap has no child_process", !/child_process/.test(knowgap))
  ok("compose does not call ingestAcquire", !/ingestAcquire\(/.test(composeSrc))
  ok("compose still no persistGaps", !/persistGaps/.test(composeSrc))
  ok("agent calls ingestAcquire", /ingestAcquire\(/.test(agent))
  ok("chat calls ingestAcquire", /ingestAcquire\(/.test(chat))
  ok("agent busts compose cache", /clearComposeOnce\(/.test(agent))
  ok("chat busts compose cache", /clearComposeOnce\(/.test(chat))
  ok("meta does not ingest", !/ingestAcquire/.test(meta))
  ok("recordGapOutcome still exported", /export function recordGapOutcome/.test(knowgap))
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
  eq("VERSION is 85.0.0", VERSION, "85.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  eq("package.json is 85.0.0", pkg.version, "85.0.0")
  ok("files includes knowgap.js", pkg.files.includes("knowgap.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
  eq("custom is still index 17 (pick 18)", CATALOG[17]?.name, "custom")
  eq("apinex still after custom", CATALOG[18]?.name, "apinex")
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
  eq("bundled pack unchanged", fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(","), bundledBefore)
}

console.log(`\n== v56 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
