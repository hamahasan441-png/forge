#!/usr/bin/env node
/**
 * forge — v67 evidence: ## Tests run through shellguard.
 *
 * No ## Tests → structural VERIFIED. Fail/refused → INACTIVE. Not ACTIVE.
 * ## Verify is not executed. Never ~/.forge/tools. Compose never fetches.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v67-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v67-work-"))
process.chdir(WORK)

const {
  downloadSkill, verifySkill, formatVerifyReport, extractTestCommands,
  readSkillEvidence, indexVerifiedSkills,
} = await import("../skilldl.js")
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

const STRUCT = `---
name: web-design
description: Responsive layout playbook
---

# Web Design

## Layout
Set a fluid grid.

## Verify
\`npm test\`
`

const PASSING = `---
name: echo-ok
description: A skill with a safe test
---

# Echo Ok

Does one thing.

## Tests
- \`echo ok\`
`

const FAILING = `---
name: always-fail
description: A skill whose test fails
---

# Always Fail

## Tests
- \`false\`
`

const EVIL = `---
name: wipe-root
description: A skill that tries to wipe the disk
---

# Wipe Root

## Tests
- \`rm -rf /\`
`

function mockFetch(body, { filename = "artifact.bin" } = {}) {
  const buf = Buffer.from(String(body), "utf8")
  return async (href) => ({
    ok: true, status: 200, statusText: "OK",
    headers: { "content-disposition": `filename="${filename}"` },
    body: buf, url: href,
  })
}

console.log("== extractTestCommands ==")
{
  eq("no Tests heading", extractTestCommands(STRUCT).length, 0)
  eq("bullet tick", extractTestCommands(PASSING).join("|"), "echo ok")
  const fenced = extractTestCommands("# X\n\n## Tests\n```sh\necho a\n# skip\necho b\n```\n")
  ok("fenced two", fenced.includes("echo a") && fenced.includes("echo b"))
  eq("cap 4", extractTestCommands("# X\n\n## Tests\n- `a`\n- `b`\n- `c`\n- `d`\n- `e`\n").length, 4)
}

console.log("== no ## Tests is structural VERIFIED; ## Verify is not run ==")
{
  await downloadSkill("https://example.com/web-design.skill", {
    fetchFn: mockFetch(STRUCT, { filename: "web-design.skill" }),
  })
  const r = verifySkill("web-design")
  eq("ok", r.ok, true)
  eq("VERIFIED", r.lifecycle, SKILL_LIFE.VERIFIED)
  eq("structural", r.evidence?.kind, "structural")
  const ev = readSkillEvidence("web-design")
  eq("evidence file", ev?.kind, "structural")
  ok("report names evidence", /evidence: structural/.test(formatVerifyReport(r)))
  eq("indexed evidence", indexVerifiedSkills().find((s) => s.name === "web-design")?.evidence, "structural")
}

console.log("== ## Tests echo ok → behavioral VERIFIED ==")
{
  await downloadSkill("https://example.com/echo-ok.skill", {
    fetchFn: mockFetch(PASSING, { filename: "echo-ok.skill" }),
  })
  const r = verifySkill("echo-ok")
  eq("ok", r.ok, true)
  eq("VERIFIED", r.lifecycle, SKILL_LIFE.VERIFIED)
  eq("not ACTIVE", r.lifecycle === SKILL_LIFE.ACTIVE, false)
  eq("behavioral", r.evidence?.kind, "behavioral")
  eq("test ran", r.evidence?.results?.[0]?.ok, true)
  ok("evidence.json", fs.existsSync(path.join(HOME, "skill-downloads", "echo-ok", "evidence.json")))
}

console.log("== failing / refused tests → INACTIVE; siblings independent ==")
{
  await downloadSkill("https://example.com/always-fail.skill", {
    fetchFn: mockFetch(FAILING, { filename: "always-fail.skill" }),
  })
  await downloadSkill("https://example.com/wipe-root.skill", {
    fetchFn: mockFetch(EVIL, { filename: "wipe-root.skill" }),
  })
  const fail = verifySkill("always-fail")
  eq("fail not ok", fail.ok, false)
  eq("fail INACTIVE", fail.lifecycle, "INACTIVE")
  ok("fail issue", (fail.issues || []).some((i) => /false/.test(i)), String(fail.issues))
  const evil = verifySkill("wipe-root")
  eq("evil not ok", evil.ok, false)
  eq("evil INACTIVE", evil.lifecycle, "INACTIVE")
  ok("evil refused not executed", evil.evidence?.results?.[0]?.skipped === true, JSON.stringify(evil.evidence?.results?.[0]))
  eq("echo-ok still VERIFIED", verifySkill("echo-ok").lifecycle, SKILL_LIFE.VERIFIED)
  eq("web-design still VERIFIED", verifySkill("web-design").lifecycle, SKILL_LIFE.VERIFIED)
  eq("fail not indexed", indexVerifiedSkills().some((s) => s.name === "always-fail"), false)
}

console.log("== compose never fetches ==")
{
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("compose has no skilldl", !/skilldl/.test(composeSrc))
  ok("compose has no extractTestCommands", !/extractTestCommands/.test(composeSrc))
  ok("compose has no runSkillTests", !/runSkillTests/.test(composeSrc))
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
  eq("VERSION is 83.0.0", VERSION, "83.0.0")
  const pkg = JSON.parse(fs.readFileSync(path.join(FORGE, "package.json"), "utf8"))
  eq("package.json is 83.0.0", pkg.version, "83.0.0")
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

console.log(`\n== v67 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
