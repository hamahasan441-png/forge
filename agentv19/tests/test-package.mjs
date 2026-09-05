#!/usr/bin/env node
/**
 * forge — packaging integrity (v20.3).
 *
 * Guards a ship-blocking class of bug: a module added to the source tree but not
 * to package.json `files[]`. The published TARBALL then omits it while the
 * modules importing it ship fine, so `npm i -g forge-agent-cli` yields a CLI
 * that dies on startup. The clean-room suite could not catch this because it
 * installs from the directory, and npm treats a local directory differently from
 * the tarball a user actually receives.
 *
 * The real invariant checked here: every relative import of a shipped module
 * must itself be shipped.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const PKG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "forge")
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf8"))

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }

const listed = new Set(pkg.files.filter((f) => f.endsWith(".js")))
const onDisk = fs.readdirSync(PKG_DIR).filter((f) => f.endsWith(".js"))

console.log("== every module on disk is declared in files[] ==")
{
  const missing = onDisk.filter((f) => !listed.has(f))
  ok(`no module missing from files[]${missing.length ? " — " + missing.join(", ") : ""}`, missing.length === 0)
  const ghosts = [...listed].filter((f) => !onDisk.includes(f))
  ok(`no files[] entry without a file${ghosts.length ? " — " + ghosts.join(", ") : ""}`, ghosts.length === 0)
}

console.log("== the bin entrypoint ships ==")
{
  const bin = Object.values(pkg.bin || {})[0] || ""
  ok("bin target is declared in files[]", listed.has(path.basename(bin)))
}

console.log("== every relative import of a shipped module also ships ==")
{
  const broken = []
  for (const f of [...listed]) {
    let src = ""
    try { src = fs.readFileSync(path.join(PKG_DIR, f), "utf8") } catch { continue }
    const re = /(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g
    let m
    while ((m = re.exec(src))) {
      const spec = m[1] || m[2]
      const target = path.basename(spec)
      if (!target.endsWith(".js")) continue
      if (!listed.has(target)) broken.push(`${f} imports ${spec} (not in files[])`)
    }
  }
  ok(`no shipped module imports an unshipped file${broken.length ? " — " + broken.join("; ") : ""}`, broken.length === 0)
}

console.log("== the packed tarball actually contains them ==")
{
  // npm writes the packed-file listing to STDERR ("npm notice ..."), so both
  // streams must be read — capturing stdout alone yields just the tarball name.
  const r = spawnSync("npm", ["pack", "--dry-run"], { cwd: PKG_DIR, encoding: "utf8" })
  const out = String(r.stdout ?? "") + String(r.stderr ?? "")
  if (!out || !/package\.json/.test(out)) {
    console.log("  skip (npm pack unavailable or produced no listing)")
  } else {
    const absent = onDisk.filter((f) => !new RegExp(`\\b${f.replace(".", "\\.")}\\b`).test(out))
    ok(`every module appears in the tarball${absent.length ? " — " + absent.join(", ") : ""}`, absent.length === 0)
    ok("package.json is in the tarball", /package\.json/.test(out))
  }
}

console.log(`\n== package suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
