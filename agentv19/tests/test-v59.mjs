#!/usr/bin/env node
/**
 * forge — v59 contradict: failed evidence on VERIFIED is CONTRADICTED.
 *
 * Does not: dump pages, flip assumeYes, add a runtime dep, write
 * ~/.forge/tools, change classifyTaskComplexity(), invent a second root.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v59-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v59-work-"))
process.chdir(WORK)

const {
  detectGaps, ingestAcquire, recordGapOutcome, persistGaps, loadGapStats,
  planAcquire, STATUS, LIFECYCLE, METHOD, IMPACT, formatGapSteer,
} = await import("../forge/knowgap.js")
const { compose } = await import("../forge/compose.js")
const { formatSteer, evaluateSkills } = await import("../forge/evaluate.js")
const { classifyTaskComplexity, classifyTask, TASK_CLASS } = await import("../forge/classify.js")
const { defaultConfig, sanitizeProjectConfig } = await import("../forge/config.js")
const { VERSION } = await import("../forge/version.js")
const { CATALOG } = await import("../forge/providers.js")
const { PLUGINS_DIR } = await import("../forge/plugins.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOST = path.join(HERE, "../forge/plugin-host.js")
const BUNDLED = path.join(HERE, "../forge/skills")
const PAY = "Build a production-quality payment system across files"

function listGlobalTools() {
  try { return fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")) } catch { return [] }
}

console.log("== failed ingest on VERIFIED is CONTRADICTED ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v59-in-"))
  recordGapOutcome({ cwd: dir, id: "payment", status: LIFECYCLE.VERIFIED, evidence: "tests passed" })
  eq("before is KNOWN", loadGapStats(dir).domains.payment.status, STATUS.KNOWN)
  eq("before VERIFIED", loadGapStats(dir).domains.payment.lifecycle, LIFECYCLE.VERIFIED)
  const hit = ingestAcquire({
    cwd: dir, task: PAY, klass: TASK_CLASS.LARGE,
    records: [{ tool: "web_search", query: "stripe payments official docs", status: "error" }],
  })
  ok("ingest returned", !!hit)
  const rec = loadGapStats(dir).domains.payment
  eq("status CONTRADICTED", rec.status, STATUS.CONTRADICTED)
  eq("lifecycle CONTRADICTED", rec.lifecycle, LIFECYCLE.CONTRADICTED)
  ok("confidence low", rec.confidence <= 0.2, rec.confidence)
  ok("evidence names failed tool", /failed:web_search/.test(rec.evidence), rec.evidence)
  ok("no page dump", !/https?:\/\//.test(JSON.stringify(rec)))
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== failed ingest on unverified is still ignored ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v59-ig-"))
  const before = ingestAcquire({
    cwd: dir, task: PAY, klass: TASK_CLASS.LARGE,
    records: [{ tool: "web_search", query: "stripe payments official docs", status: "error" }],
  })
  eq("unverified failed ignored", before, null)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== successful ingest still skips VERIFIED ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v59-ok-"))
  recordGapOutcome({ cwd: dir, id: "payment", status: LIFECYCLE.VERIFIED })
  ingestAcquire({
    cwd: dir, task: PAY, klass: TASK_CLASS.LARGE,
    records: [{ tool: "web_search", query: "stripe payments official docs", status: "ok" }],
  })
  const rec = loadGapStats(dir).domains.payment
  eq("still KNOWN", rec.status, STATUS.KNOWN)
  eq("still VERIFIED", rec.lifecycle, LIFECYCLE.VERIFIED)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== detectGaps + planAcquire re-verify, not web ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v59-dg-"))
  recordGapOutcome({ cwd: dir, id: "payment", status: LIFECYCLE.VERIFIED })
  ingestAcquire({
    cwd: dir, task: PAY, klass: TASK_CLASS.LARGE,
    records: [{ tool: "web_search", query: "stripe payments official docs", status: "error" }],
  })
  const g = detectGaps(PAY, { cwd: dir, klass: TASK_CLASS.LARGE, skills: [], world: { files: [] } })
  const pay = (g.gaps || []).find((x) => x.id === "payment")
  ok("payment is a gap", !!pay, JSON.stringify(g.gaps))
  eq("gap CONTRADICTED", pay?.status, STATUS.CONTRADICTED)
  ok("not in known", !(g.known || []).some((x) => x.id === "payment"))
  const plan = planAcquire(pay, { cwd: dir })
  eq("verify method", plan?.method, METHOD.VERIFY)
  ok("verify is not web_search", plan?.tool !== "web_search", JSON.stringify(plan))
  const steer = formatGapSteer(g)
  ok("CONTRADICT line", /CONTRADICT:/.test(steer), steer)
  ok("names payment", /payment/.test(steer), steer)
  eq("empty steer", formatSteer({}), "")
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== persistGaps will not promote CONTRADICTED; outcome restores ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v59-ps-"))
  recordGapOutcome({ cwd: dir, id: "payment", status: LIFECYCLE.VERIFIED })
  ingestAcquire({
    cwd: dir, task: PAY, klass: TASK_CLASS.LARGE,
    records: [{ tool: "web_search", query: "stripe payments official docs", status: "error" }],
  })
  persistGaps(dir, detectGaps(PAY, { cwd: dir, klass: TASK_CLASS.LARGE, world: { files: ["src/stripe-payment.js"] } }), { task: PAY })
  eq("still CONTRADICTED after lexical persist", loadGapStats(dir).domains.payment.status, STATUS.CONTRADICTED)
  recordGapOutcome({ cwd: dir, id: "payment", status: LIFECYCLE.VERIFIED, evidence: "re-verified" })
  eq("outcome restores KNOWN", loadGapStats(dir).domains.payment.status, STATUS.KNOWN)
  eq("outcome restores VERIFIED", loadGapStats(dir).domains.payment.lifecycle, LIFECYCLE.VERIFIED)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== compose never writes ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v59-co-"))
  fs.writeFileSync(path.join(dir, "util.js"), "export const x = 1\n")
  compose(PAY, { cwd: dir, includePlugins: false, klass: TASK_CLASS.LARGE })
  ok("compose did not write knowgap", !fs.existsSync(path.join(dir, "knowgap.json")))
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== source contracts ==")
{
  const knowgap = fs.readFileSync(new URL("../forge/knowgap.js", import.meta.url), "utf8")
  const composeSrc = fs.readFileSync(new URL("../forge/compose.js", import.meta.url), "utf8")
  ok("STATUS has CONTRADICTED", /CONTRADICTED: "CONTRADICTED"/.test(knowgap))
  ok("knowgap has no fetch(", !/\bfetch\(/.test(knowgap))
  ok("compose still no persistGaps", !/persistGaps/.test(composeSrc))
  ok("compose still no ingestAcquire call", !/ingestAcquire\(/.test(composeSrc))
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
  eq("VERSION is 66.0.0", VERSION, "66.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8"))
  eq("package.json is 66.0.0", pkg.version, "66.0.0")
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
  eq("custom is still index 17 (pick 18)", CATALOG[17]?.name, "custom")
  eq("apinex still after custom", CATALOG[18]?.name, "apinex")
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
  eq("bundled pack unchanged", fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(","), bundledBefore)
}

console.log(`\n== v59 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
