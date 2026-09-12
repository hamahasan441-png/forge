#!/usr/bin/env node
/**
 * forge — v81 variants: family+strategy+version+fingerprint.
 * Siblings coexist. Never overwrite ACTIVE. Never auto-ACTIVE.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v81-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
delete process.env.FORGE_DATA_DIR
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v81-work-"))
process.chdir(WORK)

const {
  slugStrategy, variantName, authorVariant, listVariants, pickVariant,
  recordVariantOutcome, formatVariants, variantFromSkill,
} = await import("../variant.js")
const { SKILL_LIFE, authorSkill, promoteSkill, recordSkillOutcome } = await import("../evolve.js")
const { formatSteer } = await import("../evaluate.js")
const { compose } = await import("../compose.js")
const { TASK_CLASS, classifyTaskComplexity, classifyTask } = await import("../classify.js")
const { evaluateSkills } = await import("../evaluate.js")
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

console.log("== identity and coexistence ==")
{
  eq("slug", slugStrategy("Component First"), "component-first")
  eq("name", variantName("web-design", "component-first", 1), "web-design--component-first-v1")
  const a = authorVariant({ cwd: WORK, family: "web-design", strategy: "component-first", repair: "Use a 12-column grid.", task: "layout the homepage" })
  eq("authored", a.ok, true)
  eq("CANDIDATE", a.lifecycle, SKILL_LIFE.CANDIDATE)
  eq("not ACTIVE", a.lifecycle === SKILL_LIFE.ACTIVE, false)
  eq("v1", a.version, 1)
  ok("fingerprint", Boolean(a.fingerprint))
  const reuse = authorVariant({ cwd: WORK, family: "web-design", strategy: "component-first", repair: "Use a 12-column grid.", task: "layout the homepage" })
  eq("same body reused", reuse.reused, true)
  eq("same name", reuse.name, a.name)
  const b = authorVariant({ cwd: WORK, family: "web-design", strategy: "layout-first", repair: "Start with the outer shell.", task: "layout the homepage" })
  eq("sibling ok", b.ok, true)
  eq("other strategy", b.strategy, "layout-first")
  ok("two siblings", listVariants(WORK, "web-design").length >= 2)
  ok("v1 file kept", fs.existsSync(a.path))
  ok("v2 sibling file", fs.existsSync(b.path) && a.path !== b.path)
}

console.log("== version bump does not overwrite known-good ==")
{
  const first = authorVariant({ cwd: WORK, family: "auth", strategy: "token-first", repair: "Check the JWT next.", task: "fix auth timeout" })
  recordSkillOutcome({ cwd: WORK, name: first.name, status: SKILL_LIFE.VERIFIED })
  const next = authorVariant({ cwd: WORK, family: "auth", strategy: "token-first", repair: "Refresh then retry the JWT.", task: "fix auth timeout" })
  eq("v2 authored", next.ok && next.version === 2, true)
  eq("v2 CANDIDATE", next.lifecycle, SKILL_LIFE.CANDIDATE)
  eq("v1 file still there", fs.existsSync(first.path), true)
  eq("different names", next.name === first.name, false)
}

console.log("== pick / steer / compose read-only ==")
{
  recordVariantOutcome({ cwd: WORK, name: "web-design--component-first-v1", ok: true })
  recordVariantOutcome({ cwd: WORK, name: "web-design--component-first-v1", ok: true })
  const picked = pickVariant("layout the homepage with a component first grid", { cwd: WORK, klass: TASK_CLASS.MEDIUM })
  ok("picks component-first", picked.some((v) => v.strategy === "component-first"), JSON.stringify(picked))
  eq("MICRO empty", pickVariant("fix a typo", { cwd: WORK, klass: TASK_CLASS.MICRO }).length, 0)
  const steer = formatSteer({ variants: picked })
  ok("VARIANTS line", /VARIANTS:/.test(steer) && /component-first/.test(steer), steer)
  const c = compose("layout the homepage with component first", { cwd: WORK, klass: TASK_CLASS.MEDIUM, includePlugins: false })
  ok("compose.variants array", Array.isArray(c.variants))
  const composeSrc = fs.readFileSync(path.join(FORGE, "compose.js"), "utf8")
  ok("compose has no authorVariant", !/authorVariant/.test(composeSrc))
  ok("compose has no recordVariantOutcome", !/recordVariantOutcome/.test(composeSrc))
}

console.log("== CLI wired; from-skill; no zip unpack ==")
{
  const sk = authorSkill({ cwd: WORK, task: "repair the payment webhook handler", klass: TASK_CLASS.MEDIUM, repair: "Verify the signature first.", files: ["src/pay.js"] })
  eq("learned skill", sk.ok, true)
  const v = variantFromSkill(WORK, sk.name, "signature-first")
  eq("from skill", v.ok, true)
  eq("from CANDIDATE", v.lifecycle, SKILL_LIFE.CANDIDATE)
  const forgeSrc = fs.readFileSync(path.join(FORGE, "forge.js"), "utf8")
  ok("CLI variant add", /forge variant add/.test(forgeSrc) || /case "variant"/.test(forgeSrc))
  ok("no zip unpack in variant.js", !/unzip|zipingest/.test(fs.readFileSync(path.join(FORGE, "variant.js"), "utf8")))
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
  eq("VERSION is 86.0.0", VERSION, "86.0.0")
  const pkg = JSON.parse(fs.readFileSync(path.join(FORGE, "package.json"), "utf8"))
  eq("package.json is 86.0.0", pkg.version, "86.0.0")
  ok("files includes variant.js", (pkg.files || []).includes("variant.js"))
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
  ok("L6 leftover kept", /isolated worktree/.test(todo))
  ok("no ~/.forge/tools", !fs.existsSync(path.join(HOME, "tools")) || fs.readdirSync(path.join(HOME, "tools")).length === 0)
}

console.log(`\n== v81 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
