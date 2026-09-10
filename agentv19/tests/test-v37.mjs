#!/usr/bin/env node
/**
 * forge — v37 language-aware engine.
 *
 * UNIFIED §6: stacks from real files. LSP/compiler optional.
 * Does not: flip assumeYes, add a runtime dep, spawn a second writer,
 * change classifyTaskComplexity(), invent cargo, or run rustc --version.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v37-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v37-work-"))
process.chdir(WORK)

const {
  inspectProject, formatLangEngine, binaryOnPath, lspAvailability, engineFor,
} = await import("../forge/langengine.js")
const { discoverToolchain } = await import("../forge/lang.js")
const { detectTestCommand } = await import("../forge/router.js")
const { defaultConfig, sanitizeProjectConfig } = await import("../forge/config.js")
const { classifyTaskComplexity, classifyTask, TASK_CLASS } = await import("../forge/classify.js")
const { createContextEngine } = await import("../forge/context.js")
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

console.log("== inspectProject empty / rust / mixed ==")
{
  eq("empty stacks", inspectProject(WORK).stacks.length, 0)
  const cargo = tmp("forge-v37-cargo-", {
    "Cargo.toml": '[package]\nname = "x"\nedition = "2021"\n[dependencies]\naxum = "0.7"\n',
  })
  const rust = inspectProject(cargo).stacks.find((s) => s.id === "rust")
  ok("rust stack", !!rust)
  eq("rust pm", rust.pm, "cargo")
  eq("rust test", rust.test, "cargo test")
  eq("rust typecheck", rust.typecheck, "cargo check")
  ok("rust edition", /2021/.test(rust.version))
  eq("rust framework axum", rust.framework, "axum")
  fs.rmSync(cargo, { recursive: true, force: true })

  const mixed = tmp("forge-v37-mix-", {
    "package.json": JSON.stringify({ name: "a", scripts: { test: "vitest" }, dependencies: { next: "14.0.0" }, engines: { node: ">=18" } }),
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
    "tsconfig.json": "{}\n",
    "Cargo.toml": '[package]\nname = "x"\nedition = "2021"\n',
  })
  const m = inspectProject(mixed)
  ok("mixed has rust", m.stacks.some((s) => s.id === "rust"))
  ok("mixed has ts", m.stacks.some((s) => s.id === "typescript" || s.id === "javascript"))
  const js = m.stacks.find((s) => s.id === "typescript" || s.id === "javascript")
  eq("pnpm lock", js.pm, "pnpm")
  eq("next framework", js.framework, "next")
  ok("node engines", /18/.test(js.version))
  eq("tsc typecheck", js.typecheck, "tsc")
  fs.rmSync(mixed, { recursive: true, force: true })
}

console.log("== python / go never invent ==")
{
  const py = tmp("forge-v37-py-", {
    "pyproject.toml": '[project]\nname = "p"\nrequires-python = ">=3.11"\n[tool.pytest.ini_options]\naddopts = "-q"\n[tool.ruff]\n',
  })
  const p = inspectProject(py).stacks.find((s) => s.id === "python")
  ok("python stack", !!p)
  eq("python pm", p.pm, "pip")
  eq("python test pytest", p.test, "pytest -q")
  eq("python lint ruff", p.lint, "ruff")
  ok("python version 3.11", /3\.11/.test(p.version))
  fs.rmSync(py, { recursive: true, force: true })

  const bare = tmp("forge-v37-barepy-", { "pyproject.toml": "[project]\nname = \"p\"\n" })
  const b = inspectProject(bare).stacks.find((s) => s.id === "python")
  eq("no pytest invent", b.test, "")
  fs.rmSync(bare, { recursive: true, force: true })

  const go = tmp("forge-v37-go-", { "go.mod": "module x\n\ngo 1.22\n" })
  const g = inspectProject(go).stacks.find((s) => s.id === "go")
  eq("go version", g.version, "1.22")
  eq("go test", g.test, "go test ./...")
  fs.rmSync(go, { recursive: true, force: true })
}

console.log("== generated + lsp + binaryOnPath ==")
{
  const d = tmp("forge-v37-gen-", { "package.json": "{\"name\":\"a\"}" })
  fs.mkdirSync(path.join(d, "dist"))
  fs.mkdirSync(path.join(d, "node_modules"))
  const info = inspectProject(d)
  ok("generated dist", info.generated.includes("dist"))
  ok("generated node_modules", info.generated.includes("node_modules"))
  fs.rmSync(d, { recursive: true, force: true })

  eq("missing binary", binaryOnPath("definitely-not-a-forge-bin-xyz"), false)
  ok("node is present", binaryOnPath("node") === true)
  const lsp = lspAvailability({ lsp: { servers: { "rust-analyzer": { command: "definitely-not-a-forge-bin-xyz" } } } })
  eq("lsp unavailable", lsp[0].available, false)
  eq("empty lsp", lspAvailability({}).length, 0)
}

console.log("== formatLangEngine MICRO skip ==")
{
  const cargo = tmp("forge-v37-fmt-", { "Cargo.toml": '[package]\nname = "x"\nedition = "2021"\n' })
  const info = inspectProject(cargo)
  eq("typo empty", formatLangEngine(info, { task: "fix a typo in README" }), "")
  const named = formatLangEngine(info, { task: "use rust for this typo" })
  ok("named rust on MICRO", /LANGUAGE ENGINE/.test(named) && /rust/.test(named))
  ok("missing rustc is UNAVAILABLE or present", /rustc (UNAVAILABLE|present)/.test(named))
  const across = formatLangEngine(info, { task: "fix a rust borrow checker error across files" })
  ok("across-files rust", /rust/.test(across))
  eq("engineFor typo", engineFor("fix a typo in README", { cwd: cargo }), "")
  fs.rmSync(cargo, { recursive: true, force: true })
}

console.log("== discoverToolchain frozen ==")
{
  const npm = tmp("forge-v37-npm-", { "package.json": JSON.stringify({ scripts: { test: "node t.js" } }) })
  eq("discoverToolchain npm test", discoverToolchain(npm).test, "npm test")
  eq("detectTestCommand 1-arg npm", detectTestCommand(npm), "npm test")
  const empty = tmp("forge-v37-e-", {})
  eq("discoverToolchain empty", discoverToolchain(empty).test, "")
  fs.rmSync(npm, { recursive: true, force: true })
  fs.rmSync(empty, { recursive: true, force: true })
}

console.log("== context injects LANGUAGE ENGINE ==")
{
  const cargo = tmp("forge-v37-ctx-", { "Cargo.toml": '[package]\nname = "x"\nedition = "2021"\n' })
  const eng = createContextEngine({ cwd: cargo })
  const built = eng.build("fix a rust borrow checker error across files", { budgetTokens: 2000 })
  ok("context has LANGUAGE ENGINE", /LANGUAGE ENGINE/.test(built.text))
  const typo = eng.build("fix a typo in README", { budgetTokens: 2000 })
  ok("typo has no LANGUAGE ENGINE", !/LANGUAGE ENGINE/.test(typo.text))
  fs.rmSync(cargo, { recursive: true, force: true })
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
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
}

console.log(`\n== v37 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
