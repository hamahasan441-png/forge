#!/usr/bin/env node
/**
 * forge — P1 clean-room package test.
 *
 * Installs the tarball/tree into a PRISTINE directory (no node_modules, no
 * ~/.forge, no repo files) and drives the real CLI end to end:
 *   - `npm pack` produces a tarball that contains ONLY the whitelisted files
 *   - a clean install boots: --version, --help, config, doctor
 *   - a foreign cwd works (no dependence on the repo layout)
 *   - no repo-only artifacts (tests, .git, PLAN docs) leak into the package
 *   - the installed package is self-contained: zero runtime dependencies
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"

const FORGE_DIR = path.resolve(process.cwd(), "..")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cleanroom-"))
const CLEAN_HOME = path.join(TMP, "home")
fs.mkdirSync(CLEAN_HOME, { recursive: true })

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const strip = (s) => String(s ?? "").replace(/\u001b\[[0-9;]*m/g, "")
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, {
  encoding: "utf8", cwd: opts.cwd ?? FORGE_DIR, env: { ...process.env, FORGE_HOME: opts.home ?? CLEAN_HOME }, timeout: opts.timeout ?? 60000,
})

console.log("== npm pack produces a clean tarball ==")
let tarball = null
{
  const r = run("npm", ["pack", "--silent"])
  ok("npm pack succeeded", r.status === 0)
  const files = fs.readdirSync(FORGE_DIR).filter((f) => /^forge-agent-cli-.*\.tgz$/.test(f))
  ok("a tarball exists", files.length === 1)
  tarball = path.join(FORGE_DIR, files[0])
  const list = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n").filter(Boolean)
  ok("the tarball is not empty", list.length > 5)
  ok("it ships package.json", list.some((f) => f.endsWith("package.json")))
  ok("it ships the CLI entry point", list.some((f) => f.endsWith("forge.js")))
  ok("it ships the completion gate", list.some((f) => f.endsWith("completion.js")))
  ok("it ships the dag module", list.some((f) => f.endsWith("dag.js")))
  ok("it ships the verification ledger", list.some((f) => f.endsWith("verifyledger.js")))
  ok("NO tests are shipped", !list.some((f) => /test-.*\.mjs$/.test(f)))
  ok("NO .git metadata is shipped", !list.some((f) => f.includes("/.git/")))
  ok("NO PLAN documents are shipped", !list.some((f) => /PLAN-.*\.md$/.test(f)))
  ok("NO node_modules are shipped", !list.some((f) => f.includes("node_modules/")))
  ok("NO source maps / caches", !list.some((f) => /\.(map|tsbuildinfo)$/.test(f)))
  console.log(`       (${list.length} entries)`)
}

console.log("== the package declares zero runtime dependencies ==")
{
  const pkg = JSON.parse(fs.readFileSync(path.join(FORGE_DIR, "package.json"), "utf8"))
  eq("no dependencies", Object.keys(pkg.dependencies ?? {}).length, 0)
  ok("it is an ES module", pkg.type === "module")
  ok("it declares the node engine", !!pkg.engines?.node)
  ok("a bin is declared", !!pkg.bin)
  ok("files are whitelisted", Array.isArray(pkg.files) && pkg.files.length > 0)
}

console.log("== a pristine install boots ==")
{
  const installDir = path.join(TMP, "install")
  fs.mkdirSync(installDir, { recursive: true })
  const r = spawnSync("npm", ["install", "--silent", "--no-audit", "--no-fund", tarball], {
    encoding: "utf8", cwd: installDir, timeout: 180000,
    env: { ...process.env, FORGE_HOME: CLEAN_HOME, npm_config_audit: "false", npm_config_fund: "false" },
  })
  ok("npm install succeeded", r.status === 0)
  const bin = path.join(installDir, "node_modules", ".bin", "forge")
  ok("the forge binary was linked", fs.existsSync(bin))

  const version = spawnSync(bin, ["--version"], { encoding: "utf8", cwd: TMP, env: { ...process.env, FORGE_HOME: CLEAN_HOME }, timeout: 30000 })
  ok("`forge --version` exits 0 in a clean room", version.status === 0)
  ok("it prints the version", /forge v\d+\.\d+\.\d+/.test(version.stdout ?? ""))

  const help = spawnSync(bin, ["--help"], { encoding: "utf8", cwd: TMP, env: { ...process.env, FORGE_HOME: CLEAN_HOME }, timeout: 30000 })
  ok("`forge --help` exits 0", help.status === 0)
  ok("help lists commands", /usage|usage:/i.test(strip(help.stdout ?? "")) && strip(help.stdout ?? "").includes("forge agent"))
}

console.log("== the installed CLI works from a foreign cwd ==")
{
  const bin = path.join(TMP, "install", "node_modules", ".bin", "forge")
  const foreign = path.join(TMP, "foreign")
  fs.mkdirSync(foreign, { recursive: true })
  const env = { ...process.env, FORGE_HOME: CLEAN_HOME }
  const cfg = spawnSync(bin, ["config", "--json"], { encoding: "utf8", cwd: foreign, env, timeout: 30000 })
  ok("`forge config --json` works outside the repo", cfg.status === 0)
  let parsed = null
  try { parsed = JSON.parse(cfg.stdout) } catch { }
  ok("config output is valid JSON", !!parsed)
  const dr = spawnSync(bin, ["doctor", "--json"], { encoding: "utf8", cwd: foreign, env, timeout: 30000 })
  ok("`forge doctor` exits 0 or 1 (never crashes)", [0, 1].includes(dr.status))
  const skills = spawnSync(bin, ["skills", "--check", "--json"], { encoding: "utf8", cwd: foreign, env, timeout: 60000 })
  ok("`forge skills --check` runs", [0, 1].includes(skills.status))
}

console.log("== the clean room leaves no repo-only state behind ==")
{
  const homeFiles = fs.existsSync(CLEAN_HOME) ? fs.readdirSync(CLEAN_HOME) : []
  ok("a ~/.forge was created in the clean HOME", homeFiles.length > 0)
  ok("no test artifacts leaked into the HOME", !homeFiles.some((f) => /test|__pycache__|\.tgz$/.test(f)))
}

// tidy: remove the tarball we built from the repo
try { if (tarball) fs.rmSync(tarball, { force: true }) } catch { }

function eq(name, got, want) { ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want)) }

console.log(`\n== clean-room-package suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
