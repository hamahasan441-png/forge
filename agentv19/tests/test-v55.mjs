#!/usr/bin/env node
/**
 * forge — v55 acquire: cheapest source for each blocking gap.
 *
 * skill → repo → docs → web_search last. Compose never fetches.
 * Does not: dump pages, flip assumeYes, add a runtime dep, spawn
 * plugin-host, change classifyTaskComplexity(), write ~/.forge/tools,
 * invent a second data root, claim VERIFIED from a search.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v55-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v55-work-"))
process.chdir(WORK)

const {
  detectGaps, planAcquire, persistGaps, loadGapStats, gapStatsPath,
  emptyGaps, formatGaps, METHOD, STATUS,
} = await import("../forge/knowgap.js")
const { compose, composeOnce, clearComposeOnce, formatCompose, emptyCompose } = await import("../forge/compose.js")
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
const GAP = { id: "payment", impact: "CRITICAL", status: STATUS.UNKNOWN, learn: true }

function listGlobalTools() {
  try { return fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")) } catch { return [] }
}

console.log("== planAcquire cheapest source ==")
{
  eq("known is null", planAcquire({ ...GAP, status: STATUS.KNOWN, learn: false }), null)
  eq("skip is null", planAcquire({ id: "ui", status: STATUS.SKIPPABLE, learn: false }), null)
  const skill = planAcquire(GAP, { skills: [{ name: "forge-api", desc: "HTTP APIs" }] })
  eq("skill method", skill?.method, METHOD.SKILL)
  eq("skill tool", skill?.tool, "load_skill")
  eq("skill query", skill?.query, "forge-api")
  eq("skill cost 1", skill?.cost, 1)
  ok("skill then glob or grep", skill?.then && (skill.then.tool === "glob_files" || skill.then.tool === "grep_files"), JSON.stringify(skill))
  const repo = planAcquire(GAP, { skills: [], world: { files: ["src/payments.js"] } })
  eq("repo method", repo?.method, METHOD.REPO)
  eq("repo tool", repo?.tool, "grep_files")
  eq("repo cost 1", repo?.cost, 1)
  ok("repo query is a tag", typeof repo?.query === "string" && repo.query.length >= 4, JSON.stringify(repo))
  const web = planAcquire(GAP, { skills: [], world: { files: [] } })
  eq("web method", web?.method, METHOD.WEB)
  eq("web tool", web?.tool, "web_search")
  eq("web cost 4", web?.cost, 4)
  ok("web query is official docs", /official documentation/.test(web?.query || ""), JSON.stringify(web))
  ok("web is not fetch_url", web?.tool !== "fetch_url")
  const docs = planAcquire(GAP, { skills: [], world: { files: [], radius: ["docs/README.md"] } })
  eq("docs method", docs?.method, METHOD.DOCS)
  eq("docs tool", docs?.tool, "read_file")
}

console.log("== detectGaps attaches learn ==")
{
  const none = detectGaps(PAY, { klass: TASK_CLASS.LARGE, skills: [], world: { files: [] } })
  ok("learn nonempty", (none.learn || []).length > 0, JSON.stringify(none.learn))
  ok("learn is web without local evidence", none.learn.some((l) => l.method === METHOD.WEB), JSON.stringify(none.learn))
  const withSkill = detectGaps(PAY, {
    klass: TASK_CLASS.LARGE,
    skills: [{ name: "forge-api", desc: "HTTP APIs" }],
    world: { files: [] },
  })
  ok("skill beats web", withSkill.learn.some((l) => l.method === METHOD.SKILL && l.query === "forge-api"), JSON.stringify(withSkill.learn))
  ok("payment itself is not web", withSkill.learn.filter((l) => l.id === "payment").every((l) => l.method !== METHOD.WEB), JSON.stringify(withSkill.learn))
  const withFile = detectGaps(PAY, {
    klass: TASK_CLASS.LARGE,
    skills: [],
    world: { files: ["payments.js"] },
  })
  ok("file hit is probable so not a learn-web", (withFile.gaps || []).every((g) => g.id !== "payment" || g.status === STATUS.PROBABLE), JSON.stringify(withFile))
  const typo = detectGaps("fix a typo in README", { klass: TASK_CLASS.MICRO })
  eq("typo learn empty", (typo.learn || []).length, 0)
  ok("formatGaps [learn]", /\[learn\]/.test(formatGaps(none)) && /web_search/.test(formatGaps(none)), formatGaps(none))
}

console.log("== persist stores method, not pages ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v55-p-"))
  const g = detectGaps(PAY, { klass: TASK_CLASS.LARGE, skills: [{ name: "forge-api" }], world: { files: [] } })
  persistGaps(dir, g, { task: PAY + " https://evil.example/secret" })
  const raw = fs.readFileSync(gapStatsPath(dir), "utf8")
  ok("no url dumped", !/evil\.example/.test(raw))
  ok("no https dump", !/https:\/\//.test(raw))
  const rec = loadGapStats(dir).domains.payment
  ok("acquire method stored", rec && rec.acquire && rec.acquire.method === METHOD.SKILL, JSON.stringify(rec))
  eq("acquire tool", rec.acquire.tool, "load_skill")
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== compose snapshot [learn], never fetches ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v55-co-"))
  fs.writeFileSync(path.join(dir, "util.js"), "export const x = 1\n")
  const c = compose(PAY, {
    cwd: dir, includePlugins: false, klass: TASK_CLASS.LARGE,
    skillsIndex: [{ name: "forge-api", desc: "HTTP APIs with validation" }, { name: "gift-evaluator", desc: "gifts" }],
  })
  ok("compose learn nonempty", (c.gaps?.learn || []).length > 0, JSON.stringify(c.gaps?.learn))
  const block = formatCompose(c)
  ok("formatCompose [learn]", /\[learn\]/.test(block), block)
  ok("learn names a real tool", /load_skill|grep_files|glob_files|web_search/.test(block), block)
  const typo = compose("fix a typo in README", { cwd: dir, includePlugins: false })
  ok("typo format has no [learn]", !/\[learn\]/.test(formatCompose(typo)))
  eq("empty format still empty", formatCompose(emptyCompose()), "")
  eq("empty learn", emptyGaps().learn.length, 0)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== formatSteer LEARN is additive ==")
{
  eq("empty steer", formatSteer({}), "")
  const withLearn = formatSteer({
    gaps: {
      gaps: [{ id: "payment", impact: "CRITICAL", status: "UNKNOWN", learn: true }],
      learn: [{ id: "payment", method: "skill", tool: "load_skill", query: "forge-api", then: { tool: "glob_files" } }],
    },
  })
  ok("LEARN line", /LEARN:/.test(withLearn) && /load_skill/.test(withLearn), withLearn)
  ok("do not dump pages", /do not dump pages/.test(withLearn), withLearn)
  ok("GAPS kept", /GAPS:/.test(withLearn), withLearn)
  ok("LEARN after GAPS", withLearn.indexOf("GAPS:") < withLearn.indexOf("LEARN:"), withLearn)
}

console.log("== composeOnce unchanged for includeGaps ==")
{
  clearComposeOnce()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v55-once-"))
  fs.writeFileSync(path.join(dir, "util.js"), "export const x = 1\n")
  const a = composeOnce(PAY, { cwd: dir, includePlugins: false, klass: TASK_CLASS.LARGE })
  const b = composeOnce(PAY, { cwd: dir, includePlugins: false, klass: TASK_CLASS.LARGE })
  ok("identical args hit ===", a === b)
  const off = composeOnce(PAY, { cwd: dir, includePlugins: false, klass: TASK_CLASS.LARGE, includeGaps: false })
  eq("includeGaps false learn empty", (off.gaps?.learn || []).length, 0)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log("== source: no fetch, no dump, wired ==")
{
  const knowgap = fs.readFileSync(new URL("../forge/knowgap.js", import.meta.url), "utf8")
  const composeSrc = fs.readFileSync(new URL("../forge/compose.js", import.meta.url), "utf8")
  const evaluate = fs.readFileSync(new URL("../forge/evaluate.js", import.meta.url), "utf8")
  ok("planAcquire exported", /export function planAcquire/.test(knowgap))
  ok("knowgap has no fetch", !/\bfetch\b/.test(knowgap))
  ok("knowgap has no https", !/https:\/\//.test(knowgap))
  ok("knowgap has no child_process", !/child_process/.test(knowgap))
  ok("knowgap does not import omega", !/from "\.\/omega\.js"/.test(knowgap))
  ok("compose still no writeStateFile", !/writeStateFile/.test(composeSrc))
  ok("compose still no persistGaps", !/persistGaps/.test(composeSrc))
  ok("compose no fetch_url", !/fetch_url/.test(composeSrc))
  ok("formatSteer LEARN", /LEARN:/.test(evaluate))
  ok("evaluateSkills still exported", /export function evaluateSkills/.test(evaluate))
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
  eq("VERSION is 64.0.0", VERSION, "64.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8"))
  eq("package.json is 64.0.0", pkg.version, "64.0.0")
  ok("files includes knowgap.js", pkg.files.includes("knowgap.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
  eq("custom is still index 17 (pick 18)", CATALOG[17]?.name, "custom")
  eq("apinex still after custom", CATALOG[18]?.name, "apinex")
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
  eq("bundled pack unchanged", fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(","), bundledBefore)
}

console.log(`\n== v55 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
