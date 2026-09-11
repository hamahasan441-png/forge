#!/usr/bin/env node
/**
 * forge — v35 language-specific reasoning.
 *
 * UNIFIED §8: Rust ownership, Python packaging, JS event loop, … as planner
 * constraints. Never mix patterns. Never invent a test command.
 *
 * Does not: flip assumeYes, add a runtime dep, spawn a second writer,
 * change classifyTaskComplexity(), or change 1-arg detectTestCommand.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v35-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v35-work-"))
process.chdir(WORK)

const {
  languagesIn, namedLangIn, canonicalLang, semanticsFor, formatLangReason,
  verifyFor, mixedWarning, SEMANTICS,
} = await import("../forge/langreason.js")
const { detectTestCommand } = await import("../forge/router.js")
const { createContextEngine } = await import("../forge/context.js")
const { classifyTaskComplexity, classifyTask, TASK_CLASS } = await import("../forge/classify.js")
const { defaultConfig, sanitizeProjectConfig } = await import("../forge/config.js")
const { VERSION } = await import("../forge/version.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

console.log("== canonical / semantics ==")
{
  eq("rs → rust", canonicalLang("rs"), "rust")
  eq("ts → typescript", canonicalLang("ts"), "typescript")
  eq("c++ → cpp", canonicalLang("c++"), "cpp")
  eq("c# → csharp", canonicalLang("c#"), "csharp")
  eq("unknown is null", canonicalLang("brainfuck"), null)
  eq("empty is null", canonicalLang(""), null)
  ok("rust has ownership", semanticsFor("rust").constraints.some((c) => /ownership/i.test(c)))
  ok("python has packaging", semanticsFor("python").constraints.some((c) => /packag/i.test(c)))
  ok("javascript has event loop", semanticsFor("js").constraints.some((c) => /event loop/i.test(c)))
  eq("unknown semantics null", semanticsFor("nope"), null)
  ok("SEMANTICS.rust.verify is cargo test", SEMANTICS.rust.verify === "cargo test")
}

console.log("== namedLangIn ==")
{
  ok("rust word", namedLangIn("fix a rust borrow checker error").includes("rust"))
  ok("cargo → rust", namedLangIn("please cargo test this").includes("rust"))
  ok("python", namedLangIn("python packaging across the repo").includes("python"))
  ok("does not match trust", !namedLangIn("trust the tests").includes("rust"))
  ok("does not match apply as py", !namedLangIn("please apply this patch").includes("python"))
  eq("empty", namedLangIn("").length, 0)
}

console.log("== languagesIn MICRO/SMALL skip ==")
{
  eq("typo is empty", languagesIn("fix a typo in README").length, 0)
  eq("empty task is empty", languagesIn("").length, 0)
  const named = languagesIn("use rust for this typo")
  ok("named rust on MICRO still selected", named.includes("rust"))
  const across = languagesIn("fix a rust borrow checker error across files")
  ok("across-files rust", across.includes("rust"))
  eq("SMALL inspect is empty without name", languagesIn("add a comment in README").length, 0)
}

console.log("== languagesIn from files / cwd ==")
{
  const files = languagesIn("refactor the service across files", { files: ["src/lib.rs", "src/main.rs"] })
  ok("files → rust", files.includes("rust"))
  const cargo = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v35-cargo-"))
  fs.writeFileSync(path.join(cargo, "Cargo.toml"), "[package]\nname=\"x\"\nversion=\"0.1.0\"\n")
  const fromCwd = languagesIn("refactor the service across files", { cwd: cargo })
  ok("cwd cargo → rust", fromCwd.includes("rust"))
  const microCwd = languagesIn("fix a typo", { cwd: cargo })
  eq("MICRO ignores cwd langs", microCwd.length, 0)
  fs.rmSync(cargo, { recursive: true, force: true })
}

console.log("== formatLangReason ==")
{
  eq("empty is empty", formatLangReason([]), "")
  eq("nullish is empty", formatLangReason(), "")
  const rs = formatLangReason(["rust"])
  ok("rust mentions ownership", /ownership/i.test(rs))
  ok("header present", /LANGUAGE CONSTRAINTS/.test(rs))
  const js = formatLangReason(["javascript"])
  ok("js mentions event loop", /event loop/i.test(js))
  ok("js does not mention ownership", !/ownership/i.test(js))
  const mix = formatLangReason(["rust", "javascript"])
  ok("mixed warning", /do not apply one language/i.test(mix))
  ok("mixedWarning true", mixedWarning(["rust", "javascript"]))
  ok("mixedWarning false", !mixedWarning(["rust"]))
  const cap = formatLangReason(["rust", "python", "go", "javascript"], { maxChars: 200 })
  ok("respects maxChars", cap.length <= 200)
}

console.log("== verifyFor never invents ==")
{
  eq("no cwd rust is empty", verifyFor(["rust"]), "")
  const cargo = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v35-vf-"))
  fs.writeFileSync(path.join(cargo, "Cargo.toml"), "[package]\nname=\"x\"\nversion=\"0.1.0\"\n")
  eq("cargo dir → cargo test", verifyFor(["rust"], { cwd: cargo }), "cargo test")
  const py = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v35-py-"))
  fs.writeFileSync(path.join(py, "pyproject.toml"), "[project]\nname=\"x\"\n")
  eq("pyproject → pytest", verifyFor(["python"], { cwd: py }), "pytest -q")
  const mixed = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v35-mix-"))
  fs.writeFileSync(path.join(mixed, "package.json"), JSON.stringify({ scripts: { test: "node t.js" } }))
  fs.writeFileSync(path.join(mixed, "Cargo.toml"), "[package]\nname=\"x\"\nversion=\"0.1.0\"\n")
  eq("mixed: rust lang wins cargo", verifyFor(["rust"], { cwd: mixed }), "cargo test")
  eq("1-arg detectTestCommand still npm", detectTestCommand(mixed), "npm test")
  eq("empty langs detectTestCommand npm", detectTestCommand(mixed, []), "npm test")
  eq("2-arg rust prefers cargo", detectTestCommand(mixed, ["rust"]), "cargo test")
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v35-empty-"))
  eq("rust without Cargo.toml does not invent", verifyFor(["rust"], { cwd: empty }), "")
  fs.rmSync(cargo, { recursive: true, force: true })
  fs.rmSync(py, { recursive: true, force: true })
  fs.rmSync(mixed, { recursive: true, force: true })
  fs.rmSync(empty, { recursive: true, force: true })
}

console.log("== context engine injects LANGUAGE CONSTRAINTS ==")
{
  const eng = createContextEngine({ cwd: WORK })
  const rs = eng.build("fix a rust borrow checker error across files", { budgetTokens: 2000 })
  ok("context has LANGUAGE CONSTRAINTS", /LANGUAGE CONSTRAINTS/.test(rs.text))
  ok("context names rust", /Rust/i.test(rs.text))
  const typo = eng.build("fix a typo in README", { budgetTokens: 2000 })
  ok("typo has no LANGUAGE CONSTRAINTS", !/LANGUAGE CONSTRAINTS/.test(typo.text))
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
  eq("VERSION is 59.0.0", VERSION, "59.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8"))
  eq("package.json is 59.0.0", pkg.version, "59.0.0")
  ok("files includes langreason.js", pkg.files.includes("langreason.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
}

console.log(`\n== v35 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
