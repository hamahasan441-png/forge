#!/usr/bin/env node
/**
 * forge — v38 gap-fix layer.
 *
 * Trailing-symlink writes are never followed outside the project.
 * Generated dirs listed by the engine are refused as write targets.
 * HIGH TESTS recommend the inspectProject-native command for the file.
 * Does not: flip assumeYes, add a runtime dep, spawn a second writer,
 * change classifyTaskComplexity(), weaken plugin-iso, or invent cargo.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v38-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v38-work-"))
process.chdir(WORK)

const {
  generatedBoundary, GENERATED_DIRS, recommendedVerify, inspectProject,
} = await import("../forge/langengine.js")
const { makeToolContext, safePath } = await import("../forge/tools.js")
const { verificationPlan, CHECK } = await import("../forge/verify.js")
const { RISK } = await import("../forge/capabilities.js")
const { detectTestCommand } = await import("../forge/router.js")
const { defaultConfig, sanitizeProjectConfig } = await import("../forge/config.js")
const { classifyTaskComplexity, classifyTask, TASK_CLASS } = await import("../forge/classify.js")
const { VERSION } = await import("../forge/version.js")

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

console.log("== generatedBoundary ==")
{
  const d = tmp("forge-v38-gen-", { "src/app.js": "export const a = 1\n", "dist.js": "not a dir\n" })
  eq("src is not generated", generatedBoundary(path.join(d, "src/app.js"), d), "")
  eq("dist/bundle.js is dist", generatedBoundary(path.join(d, "dist/bundle.js"), d), "dist")
  eq("node_modules nested", generatedBoundary(path.join(d, "node_modules/x/index.js"), d), "node_modules")
  eq(".next page", generatedBoundary(path.join(d, ".next/server/page.js"), d), ".next")
  eq("target rust", generatedBoundary(path.join(d, "target/debug/x"), d), "target")
  eq("file named dist.js is not a dir", generatedBoundary(path.join(d, "dist.js"), d), "")
  eq("outside path is empty", generatedBoundary("/etc/hostname", d), "")
  ok("GENERATED_DIRS lists dist", GENERATED_DIRS.includes("dist") && GENERATED_DIRS.includes("node_modules"))
  fs.rmSync(d, { recursive: true, force: true })
}

console.log("== recommendedVerify picks the file's stack ==")
{
  eq("empty is empty", recommendedVerify(WORK, []), "")
  const cargo = tmp("forge-v38-cargo-", {
    "Cargo.toml": '[package]\nname = "x"\nedition = "2021"\n',
    "src/lib.rs": "pub fn x() {}\n",
  })
  eq("cargo only → cargo test", recommendedVerify(cargo, [path.join(cargo, "src/lib.rs")]), "cargo test")
  fs.rmSync(cargo, { recursive: true, force: true })

  const mixed = tmp("forge-v38-mix-", {
    "package.json": JSON.stringify({ name: "a", scripts: { test: "vitest" } }),
    "app.js": "export const a = 1\n",
    "Cargo.toml": '[package]\nname = "x"\nedition = "2021"\n',
    "src/lib.rs": "pub fn x() {}\n",
  })
  eq("mixed rust file → cargo test", recommendedVerify(mixed, [path.join(mixed, "src/lib.rs")]), "cargo test")
  eq("mixed js file → npm test", recommendedVerify(mixed, [path.join(mixed, "app.js")]), "npm test")
  eq("1-arg detectTestCommand frozen", detectTestCommand(mixed), "npm test")
  ok("inspectProject still reports both", inspectProject(mixed).stacks.some((s) => s.id === "rust") && inspectProject(mixed).stacks.some((s) => s.id === "javascript" || s.id === "typescript"))
  fs.rmSync(mixed, { recursive: true, force: true })
}

console.log("== generated dir writes refused ==")
{
  const d = tmp("forge-v38-write-", {
    "src/app.js": "export const a = 1\n",
    "dist/bundle.js": "generated\n",
    "node_modules/x/index.js": "dep\n",
  })
  const tool = makeToolContext({ cwd: d, root: d, maxToolOutput: 4000 })
  const rDist = await tool.exec("write_file", { path: "dist/bundle.js", content: "PWNED" })
  ok("dist write refused", String(rDist).startsWith("ERROR") && /generated/.test(String(rDist)), String(rDist).slice(0, 160))
  eq("dist contents unchanged", fs.readFileSync(path.join(d, "dist/bundle.js"), "utf8"), "generated\n")
  const rNm = await tool.exec("write_file", { path: "node_modules/x/index.js", content: "PWNED" })
  ok("node_modules write refused", String(rNm).startsWith("ERROR") && /generated/.test(String(rNm)), String(rNm).slice(0, 160))
  const rSrc = await tool.exec("write_file", { path: "src/app.js", content: "export const b = 2\n" })
  ok("source write allowed", String(rSrc).startsWith("OK"), String(rSrc).slice(0, 160))
  const rName = await tool.exec("write_file", { path: "dist.js", content: "a file named dist\n" })
  ok("file named dist.js allowed", String(rName).startsWith("OK"), String(rName).slice(0, 160))
  const sp = safePath(tool.ctx, "dist/new.js", { write: true })
  ok("safePath flags generated", sp.ok === false && /generated/.test(sp.error))
  const loose = makeToolContext({ cwd: d, root: d, allowGeneratedWrites: true, maxToolOutput: 4000 })
  const rOpt = await loose.exec("write_file", { path: "dist/bundle.js", content: "opt-out\n" })
  ok("allowGeneratedWrites opts out", String(rOpt).startsWith("OK") && fs.readFileSync(path.join(d, "dist/bundle.js"), "utf8") === "opt-out\n", String(rOpt).slice(0, 160))
  fs.rmSync(d, { recursive: true, force: true })
}

console.log("== allowOutsideProject does not follow a trailing host symlink ==")
{
  const T = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v38-sym-"))
  const PROJ = path.join(T, "proj")
  const OUT = path.join(T, "outside")
  fs.mkdirSync(PROJ, { recursive: true })
  fs.mkdirSync(OUT, { recursive: true })
  const loose = makeToolContext({ cwd: PROJ, root: PROJ, allowOutsideProject: true, maxToolOutput: 4000 })
  const r = await loose.exec("write_file", { path: path.join(OUT, "allowed.txt"), content: "user allowed" })
  ok("opt-out still permits a regular outside write", String(r).startsWith("OK") && fs.readFileSync(path.join(OUT, "allowed.txt"), "utf8") === "user allowed", String(r).slice(0, 160))

  fs.symlinkSync("/etc/hostname", path.join(OUT, "hostlink"))
  const before = fs.readFileSync("/etc/hostname", "utf8")
  const payload = "FORGE-V38-PWN-" + Date.now()
  const r2 = await loose.exec("write_file", { path: path.join(OUT, "hostlink"), content: payload })
  const after = fs.readFileSync("/etc/hostname", "utf8")
  ok("hostname unchanged", after === before)
  ok("…and ERROR or the link itself was replaced", String(r2).startsWith("ERROR") || !fs.lstatSync(path.join(OUT, "hostlink")).isSymbolicLink(), String(r2).slice(0, 200))
  ok("payload never landed on the host file", !after.includes("FORGE-V38-PWN-"))

  fs.writeFileSync(path.join(PROJ, "real.txt"), "hello")
  fs.symlinkSync(path.join(PROJ, "real.txt"), path.join(PROJ, "alias.txt"))
  const tight = makeToolContext({ cwd: PROJ, root: PROJ, maxToolOutput: 4000 })
  const r3 = await tight.exec("write_file", { path: "alias.txt", content: "via alias" })
  ok("in-project trailing symlink still followed", String(r3).startsWith("OK") && fs.readFileSync(path.join(PROJ, "real.txt"), "utf8") === "via alias", String(r3).slice(0, 160))
  fs.rmSync(T, { recursive: true, force: true })
}

console.log("== verificationPlan HIGH TESTS uses recommendedVerify ==")
{
  const mixed = tmp("forge-v38-plan-", {
    "package.json": JSON.stringify({ name: "a", scripts: { test: "vitest" } }),
    "app.js": "export const a = 1\n",
    "Cargo.toml": '[package]\nname = "x"\nedition = "2021"\n',
    "src/lib.rs": "pub fn x() {}\n",
  })
  const meta = { read_only: false, verification_required: true, verify_after: [] }
  const rust = verificationPlan("write_file", { path: "src/lib.rs" }, { risk: RISK.HIGH, cwd: mixed, meta })
  const rustTests = rust.checks.find((c) => c.kind === CHECK.TESTS)
  ok("HIGH rust write has TESTS", !!rustTests && rustTests.executor === "agent")
  eq("HIGH rust command is cargo test", rustTests?.command, "cargo test")
  const js = verificationPlan("write_file", { path: "app.js" }, { risk: RISK.HIGH, cwd: mixed, meta })
  eq("HIGH js command is npm test", js.checks.find((c) => c.kind === CHECK.TESTS)?.command, "npm test")
  const empty = verificationPlan("write_file", { path: "notes.txt" }, { risk: RISK.HIGH, cwd: WORK, meta })
  const emptyTests = empty.checks.find((c) => c.kind === CHECK.TESTS)
  ok("empty repo TESTS has no invented command", !!emptyTests && !emptyTests.command)
  const med = verificationPlan("write_file", { path: "app.js" }, { risk: RISK.MEDIUM, cwd: mixed, meta })
  ok("MEDIUM does not escalate to TESTS", !med.checks.some((c) => c.kind === CHECK.TESTS))
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
  eq("VERSION is 49.0.0", VERSION, "49.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8"))
  eq("package.json is 49.0.0", pkg.version, "49.0.0")
  ok("files includes langengine.js", pkg.files.includes("langengine.js"))
  ok("files includes tools.js", pkg.files.includes("tools.js"))
  ok("files includes verify.js", pkg.files.includes("verify.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
}

console.log(`\n== v38 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
