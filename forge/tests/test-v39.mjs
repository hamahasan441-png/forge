#!/usr/bin/env node
/**
 * forge — v39 focused verification.
 *
 * UNIFIED §13 leftover + §19: recommended command reaches the model;
 * graph-connected tests are listed. Never auto-run, never invent flags.
 * Does not: flip assumeYes, add a runtime dep, spawn a second writer,
 * change classifyTaskComplexity(), or weaken plugin-iso.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v39-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v39-work-"))
process.chdir(WORK)

const {
  focusedVerify, verificationPlan, runVerification, formatVerification, CHECK,
} = await import("../verify.js")
const { detectTestCommand } = await import("../router.js")
const { inspectProject } = await import("../langengine.js")
const { defaultConfig, sanitizeProjectConfig } = await import("../config.js")
const { classifyTaskComplexity, classifyTask, TASK_CLASS } = await import("../classify.js")
const { RISK } = await import("../capabilities.js")
const { VERSION } = await import("../version.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

function tmp(name, files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), name))
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(d, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  return d
}

const HIGH = { risk: RISK.HIGH, meta: { read_only: false, verification_required: true } }

console.log("== focusedVerify empty / cargo / js graph ==")
{
  eq("empty command", focusedVerify(WORK, []).command, "")
  eq("empty tests", focusedVerify(WORK, []).tests.length, 0)

  const cargo = tmp("forge-v39-cargo-", {
    "Cargo.toml": '[package]\nname = "x"\nedition = "2021"\n',
    "src/lib.rs": "pub fn x() -> u8 { 1 }\n",
  })
  const rust = focusedVerify(cargo, [path.join(cargo, "src/lib.rs")])
  eq("cargo command", rust.command, "cargo test")
  eq("cargo no invented tests", rust.tests.length, 0)
  fs.rmSync(cargo, { recursive: true, force: true })

  const js = tmp("forge-v39-js-", {
    "package.json": JSON.stringify({ name: "a", scripts: { test: "node --test" } }),
    "util.js": "export function add(a, b) { return a + b }\n",
    "util.test.js": "import { add } from './util.js'\n",
  })
  const focus = focusedVerify(js, [path.join(js, "util.js")])
  eq("js command", focus.command, "npm test")
  ok("js tests include util.test.js", focus.tests.some((t) => t.replace(/\\/g, "/").endsWith("util.test.js")), JSON.stringify(focus.tests))
  ok("command has no invented flags", !/--/.test(focus.command) && focus.command === "npm test")
  fs.rmSync(js, { recursive: true, force: true })
}

console.log("== verificationPlan HIGH carries command + tests ==")
{
  const js = tmp("forge-v39-plan-", {
    "package.json": JSON.stringify({ name: "a", scripts: { test: "node --test" } }),
    "util.js": "export function add(a, b) { return a + b }\n",
    "util.test.js": "import { add } from './util.js'\n",
  })
  const plan = verificationPlan("write_file", { path: "util.js" }, { ...HIGH, cwd: js })
  const tests = plan.checks.find((c) => c.kind === CHECK.TESTS)
  ok("HIGH has TESTS", !!tests)
  eq("HIGH command", tests.command, "npm test")
  ok("HIGH tests list util.test.js", (tests.tests || []).some((t) => t.replace(/\\/g, "/").endsWith("util.test.js")), JSON.stringify(tests.tests))
  const med = verificationPlan("write_file", { path: "util.js" }, { risk: RISK.MEDIUM, cwd: js, meta: { read_only: false, verification_required: true } })
  ok("MEDIUM does not escalate to TESTS", !med.checks.some((c) => c.kind === CHECK.TESTS))
  fs.rmSync(js, { recursive: true, force: true })
}

console.log("== formatVerification shows [verify next]; never auto-runs ==")
{
  const marker = path.join(os.tmpdir(), "forge-v39-marker-" + Date.now())
  const js = tmp("forge-v39-fmt-", {
    "package.json": JSON.stringify({ name: "a", scripts: { test: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'RAN')"` } }),
    "util.js": "export function add(a, b) { return a + b }\n",
    "util.test.js": "import { add } from './util.js'\n",
  })
  fs.writeFileSync(path.join(js, "util.js"), "export function add(a, b) { return a + b }\n")
  const plan = verificationPlan("write_file", { path: "util.js" }, { ...HIGH, cwd: js })
  const vres = await runVerification(plan, { cwd: js })
  ok("local checks ran", vres.ran > 0 && vres.ok === true)
  ok("recommended has command", vres.recommended.some((r) => r.command === "npm test"))
  const line = formatVerification(vres)
  ok("format has [verified]", /\[verified\]/.test(line), line)
  ok("format has [verify next] npm test", /\[verify next\] npm test/.test(line), line)
  ok("format lists the test file", /util\.test\.js/.test(line), line)
  ok("format does not invent flags", !/npm test --/.test(line), line)
  ok("npm test was NOT executed", !fs.existsSync(marker))
  fs.rmSync(js, { recursive: true, force: true })
}

console.log("== mixed stack + frozen detectTestCommand ==")
{
  const mixed = tmp("forge-v39-mix-", {
    "package.json": JSON.stringify({ name: "a", scripts: { test: "vitest" } }),
    "Cargo.toml": '[package]\nname = "x"\nedition = "2021"\n',
    "src/lib.rs": "pub fn x() -> u8 { 1 }\n",
    "app.js": "export const n = 1\n",
  })
  eq("mixed rust → cargo test", focusedVerify(mixed, [path.join(mixed, "src/lib.rs")]).command, "cargo test")
  eq("mixed js → npm test", focusedVerify(mixed, [path.join(mixed, "app.js")]).command, "npm test")
  eq("1-arg detectTestCommand frozen", detectTestCommand(mixed), "npm test")
  ok("inspectProject still reports both", inspectProject(mixed).stacks.length >= 2)
  const rustPlan = verificationPlan("write_file", { path: "src/lib.rs" }, { ...HIGH, cwd: mixed })
  eq("HIGH rust command", rustPlan.checks.find((c) => c.kind === CHECK.TESTS)?.command, "cargo test")
  fs.rmSync(mixed, { recursive: true, force: true })
}

console.log("== frozen kernel + package ==")
{
  const cfg = defaultConfig()
  eq("assumeYes stays false", cfg.tools.assumeYes, false)
  eq("allowSudo stays false", cfg.tools.allowSudo, false)
  const { dropped } = sanitizeProjectConfig({ tools: { assumeYes: true } })
  ok("project cannot flip assumeYes", dropped.includes("tools.assumeYes"))
  eq("classifyTaskComplexity frozen", classifyTaskComplexity("fix a typo"), "trivial")
  eq("typo still MICRO", classifyTask("fix a typo in README").class, TASK_CLASS.MICRO)
  eq("VERSION is 80.0.0", VERSION, "80.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  eq("package.json is 80.0.0", pkg.version, "80.0.0")
  ok("files includes verify.js", pkg.files.includes("verify.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
}

console.log(`\n== v39 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
