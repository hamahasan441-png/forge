#!/usr/bin/env node
/**
 * forge — test hygiene: the suite must pass wherever the checkout lives.
 *
 * Regression: `test-resource-leaks.mjs` wrote a probe script that imported
 * a probe script that imported the checkout's meta.js by its literal path — a
 * path that only exists on the author's machine. It passed locally and failed every CI job, because
 * CI checks the repository out under a completely different root.
 *
 * A test that only passes in one directory is not a test. This suite fails the
 * build if any test file bakes in a machine-specific absolute path.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const testFiles = fs.readdirSync(here)
  .filter((f) => (f.endsWith(".mjs") || f.endsWith(".sh") || f.endsWith(".cjs")))
  .map((f) => path.join(here, f))

console.log("== no machine-specific absolute paths in tests ==")
{
  // /home/<user>/… (CI checks out under /home/runner/work/…), /Users/… (macOS)
  // and C:\… (Windows). Prose and comments may mention them — code may not.
  const BAD = [
    { re: /(['"`(=]|\s|^)(\/home\/|\/Users\/)[A-Za-z0-9._-]+\//, why: "a POSIX home path" },
    { re: /(['"`(=]|\s|^)[A-Za-z]:\\[A-Za-z0-9_.\\-]+/, why: "a Windows path" },
  ]
  const offenders = []
  for (const f of testFiles) {
    const lines = fs.readFileSync(f, "utf8").split("\n")
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|#)/.test(line)) return            // comments may give examples
      // an absolute path BUILT at runtime (import.meta.url, os.homedir(),
      // fileURLToPath, path.join…) is portable — only literals are banned
      if (/import\.meta\.url|fileURLToPath|__dirname|os\.homedir|process\.cwd|path\.join\(|mkdtemp/.test(line)) return
      for (const { re, why } of BAD) {
        if (re.test(line)) offenders.push(`${path.basename(f)}:${i + 1} — ${why}: ${line.trim().slice(0, 90)}`)
      }
    })
  }
  eq("no hardcoded absolute paths", offenders.length, 0)
  for (const o of offenders) console.log(`       ${o}`)
}

console.log("== every suite resolves its own modules ==")
{
  const broken = []
  for (const f of testFiles.filter((x) => x.endsWith(".mjs"))) {
    const src = fs.readFileSync(f, "utf8")
    // a relative import must be relative to the file that contains it
    for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const target = path.resolve(path.dirname(f), m[1])
      if (!fs.existsSync(target)) broken.push(`${path.basename(f)} → ${m[1]}`)
    }
  }
  eq("every relative import resolves", broken.length, 0)
  for (const b of broken) console.log(`       ${b}`)
}

console.log("== every suite is syntactically valid ==")
{
  const bad = []
  for (const f of testFiles.filter((x) => x.endsWith(".mjs"))) {
    try { execFileSync(process.execPath, ["--check", f], { stdio: "ignore" }) } catch { bad.push(path.basename(f)) }
  }
  eq("node --check passes for every suite", bad.length, 0)
  for (const b of bad) console.log(`       ${b}`)
  for (const f of testFiles.filter((x) => x.endsWith(".sh"))) {
    let shOk = true
    try { execFileSync("bash", ["-n", f], { stdio: "ignore" }) } catch { shOk = false }
    ok(`bash -n ${path.basename(f)}`, shOk)
  }
}

console.log("== the runner knows about every suite file ==")
{
  const runner = fs.readFileSync(path.join(here, "run-all.mjs"), "utf8")
  const unregistered = testFiles
    .map((f) => path.basename(f))
    .filter((b) => b.startsWith("test-") && !b.includes(".inner.") && !runner.includes(b))
  eq("every test-*.mjs is registered in run-all.mjs", unregistered.length, 0)
  for (const u of unregistered) console.log(`       not registered: ${u}`)
  const listed = [...runner.matchAll(/\["[^"]+",\s*"node",\s*\["(test-[^"]+)"\]/g)].map((m) => m[1])
  const missing = listed.filter((b) => !fs.existsSync(path.join(here, b)))
  eq("every registered node suite exists", missing.length, 0)
}

console.log("== every suite isolates its own state ==")
{
  // A suite that runs against the developer's real ~/.forge would read their
  // config, write into their sessions and depend on their machine. Every suite
  // must therefore point FORGE_HOME (or its cwd) at a temp directory it made.
  // Only suites that actually TOUCH a home directory need isolation; a pure
  // logic suite (diffpatch, providers, retrieval …) never reads one.
  const unisolated = []
  for (const f of testFiles.filter((x) => x.endsWith(".mjs") && path.basename(x).startsWith("test-") && !x.includes(".inner."))) {
    const src = fs.readFileSync(f, "utf8")
    const touchesHome = /os\.homedir|DEFAULT_DIR|homedir\(|~\/\.forge|FORGE_HOME/.test(src)
    if (!touchesHome) continue
    const isolated = /mkdtemp|tmpdir\(|FORGE_HOME/.test(src)
    if (!isolated) unisolated.push(path.basename(f))
  }
  eq("no suite touches a home directory it did not create", unisolated.length, 0)
  for (const u of unisolated) console.log(`       ${u}`)
  // …and the ones that set FORGE_HOME must point it at a temp path, not at ~
  const badHome = []
  for (const f of testFiles) {
    const src = fs.readFileSync(f, "utf8")
    for (const m of src.matchAll(/FORGE_HOME\s*=\s*["'`]([^"'`]+)["'`]/g)) {
      const v = m[1]
      // a value built from a variable is resolved at runtime — that is fine;
      // only a LITERAL path outside the temp dir is a problem
      if (v.includes("$")) continue
      if (/^~/.test(v) || (/^\//.test(v) && !/\/tmp|\/temp/i.test(v))) badHome.push(`${path.basename(f)}: ${v}`)
    }
  }
  eq("FORGE_HOME is never a literal real path", badHome.length, 0)
  for (const b of badHome) console.log(`       ${b}`)

  const runner = fs.readFileSync(path.join(here, "run-all.mjs"), "utf8")
  ok("the runner passes the environment through unchanged", !/FORGE_HOME\s*=\s*["']/.test(runner))
}

console.log(`\n== path-hygiene suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
