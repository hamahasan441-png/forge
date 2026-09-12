#!/usr/bin/env node
/**
 * forge — v80 verify2: structured exec results, truncated/unknown never PASS,
 * evidence fingerprint, generated provenance, benchmark UNKNOWN.
 * Kernel frozen. Never auto-ACTIVE.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v80-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v80-work-"))
process.chdir(WORK)

const { classifySpawn, runCommand, EXEC_STATUS, generatedTestProvenance } = await import("../execresult.js")
const { downloadSkill, verifySkill, readSkillEvidence, evidenceIsFresh, indexVerifiedSkills, benchmarkSkill } = await import("../skilldl.js")
const { evaluateVerification } = await import("../verifyledger.js")
const { generateGapTest } = await import("../experiment.js")
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

function mockFetch(body, { filename = "artifact.bin" } = {}) {
  const buf = Buffer.from(String(body), "utf8")
  return async (href) => ({
    ok: true, status: 200, statusText: "OK",
    headers: { "content-disposition": `filename="${filename}"` },
    body: buf, url: href,
  })
}

const PASSING = `---
name: echo-ok
description: A skill with a safe test
---
# Echo Ok
## Tests
- \`echo ok\`
`

console.log("== classifySpawn: truncated/unknown/timeout never PASS ==")
{
  eq("exit 0 is PASS", classifySpawn({ status: 0, stdout: "ok", stderr: "" }, { cmd: "echo" }).status, EXEC_STATUS.PASS)
  eq("exit 1 is FAIL", classifySpawn({ status: 1, stdout: "", stderr: "x" }, { cmd: "false" }).status, EXEC_STATUS.FAIL)
  eq("null status UNKNOWN", classifySpawn({ status: null, stdout: "maybe" }, { cmd: "?" }).status, EXEC_STATUS.UNKNOWN)
  eq("UNKNOWN not ok", classifySpawn({ status: null }, { cmd: "?" }).ok, false)
  const big = "x".repeat(70 * 1024)
  const tr = classifySpawn({ status: 0, stdout: big, stderr: "" }, { cmd: "yes", maxBytes: 64 * 1024 })
  eq("truncated status", tr.status, EXEC_STATUS.TRUNCATED)
  eq("truncated not PASS", tr.ok, false)
  eq("timeout", classifySpawn({ status: null, error: { code: "ETIMEDOUT" } }, { cmd: "sleep" }).status, EXEC_STATUS.TIMEOUT)
  eq("killed", classifySpawn({ status: null, signal: "SIGKILL" }, { cmd: "x" }).status, EXEC_STATUS.KILLED)
  eq("blocked", classifySpawn(null, { cmd: "rm -rf /", blocked: true, level: "danger" }).status, EXEC_STATUS.BLOCKED)
  const live = runCommand("echo ok")
  eq("runCommand PASS", live.status, EXEC_STATUS.PASS)
  eq("runCommand false FAIL", runCommand("false").status, EXEC_STATUS.FAIL)
}

console.log("== ledger truncated/killed never PASS ==")
{
  const t = evaluateVerification("echo ok", "ok", { exitCode: 0, truncated: true })
  eq("truncated not passed", t.passed, false)
  const k = evaluateVerification("echo ok", "ok", { exitCode: 0, killed: true })
  eq("killed not passed", k.passed, false)
  const u = evaluateVerification("echo ok", "no status printed")
  eq("unknown not passed", u.passed, false)
  const p = evaluateVerification("echo ok", "ok", { exitCode: 0 })
  eq("clean pass", p.passed, true)
}

console.log("== evidence fingerprint; changed body is not indexed ==")
{
  await downloadSkill("https://example.com/echo-ok.skill", {
    fetchFn: mockFetch(PASSING, { filename: "echo-ok.skill" }),
  })
  const r = verifySkill("echo-ok")
  eq("verify ok", r.ok, true)
  eq("behavioral", r.evidence?.kind, "behavioral")
  eq("evidence v2", r.evidence?.evidenceVersion, 2)
  ok("fingerprint", Boolean(r.evidence?.sourceFingerprint))
  eq("fresh", evidenceIsFresh("echo-ok"), true)
  eq("result PASS", r.evidence?.results?.[0]?.status, EXEC_STATUS.PASS)
  ok("indexed", indexVerifiedSkills().some((s) => s.name === "echo-ok"))
  const mdPath = path.join(HOME, "skill-downloads", "echo-ok", "SKILL.md")
  fs.writeFileSync(mdPath, PASSING + "\n# changed\n")
  eq("stale after edit", evidenceIsFresh("echo-ok"), false)
  eq("not indexed after edit", indexVerifiedSkills().some((s) => s.name === "echo-ok"), false)
  const b = benchmarkSkill("echo-ok")
  eq("benchmark measured", b.metrics?.status, "MEASURED")
  ok("successRate real", b.metrics.successRate === 1)
}

console.log("== structural benchmark UNKNOWN; generated provenance ==")
{
  const STRUCT = `---
name: web-design
description: layout
---
# Web Design
Set a grid.
`
  await downloadSkill("https://example.com/web-design.skill", {
    fetchFn: mockFetch(STRUCT, { filename: "web-design.skill" }),
  })
  const r = verifySkill("web-design")
  eq("structural", r.evidence?.kind, "structural")
  const bm = benchmarkSkill("web-design")
  eq("structural UNKNOWN", bm.metrics?.status, "UNKNOWN")
  eq("no invented successRate", bm.metrics?.successRate, null)
  const g = generateGapTest({ id: "auth" }, { command: "true" })
  ok("provenance generated", g.provenance?.generated === true)
  eq("sourceGap", g.provenance?.sourceGap, "auth")
  ok("fingerprint", Boolean(g.provenance?.fingerprint))
  const p = generatedTestProvenance({ command: "true", sourceGap: "auth" })
  eq("generated flag", p.generated, true)
}

console.log("== compose write-free / CLI ==")
{
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("compose has no execresult", !/execresult/.test(composeSrc))
  ok("compose has no runCommand", !/runCommand/.test(composeSrc))
  const forgeSrc = fs.readFileSync(path.join(FORGE, "forge.js"), "utf8")
  ok("CLI evidence", /skill evidence/.test(forgeSrc))
  ok("CLI benchmark", /skill benchmark/.test(forgeSrc))
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
  ok("files includes execresult.js", (pkg.files || []).includes("execresult.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
  eq("custom is still index 17 (pick 18)", CATALOG[17]?.name, "custom")
  eq("apinex still after custom", CATALOG[18]?.name, "apinex")
  eq("global tools dir unchanged", listGlobalTools().join(","), beforeGlobal.join(","))
  eq("plugin-host.js unchanged", fs.readFileSync(HOST, "utf8"), hostBefore)
  eq("bundled pack unchanged", fs.readdirSync(BUNDLED).filter((n) => n.startsWith("learned")).join(","), bundledBefore)
  const todo = fs.readFileSync(path.join(FORGE, "TODO.md"), "utf8")
  eq("TODO still unchecked", (todo.match(/^- \[[xX]\]/gm) || []).length, 0)
  ok("no PLAN file", fs.readdirSync(FORGE).filter((n) => /^PLAN-v\d+\.md$/.test(n)).length === 0)
  ok("Never list kept", /Research crawler/.test(todo) && /Auto-ACTIVE/.test(todo))
  ok("no ~/.forge/tools", !fs.existsSync(path.join(HOME, "tools")) || fs.readdirSync(path.join(HOME, "tools")).length === 0)
}

console.log(`\n== v80 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
