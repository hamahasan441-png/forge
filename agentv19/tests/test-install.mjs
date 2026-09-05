#!/usr/bin/env node
/**
 * forge — installer checks (v20.3 P1-10). Hermetic: a stub `npm` on PATH records
 * every invocation, so nothing is really installed and no network is touched.
 * Guards the defect where a failing install ran `npm i -g .` a SECOND time just
 * to grep its error, doubling an already-slow failure.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INSTALL = path.join(HERE, "..", "forge", "install.sh")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "forge-install-"))
const STUB = path.join(TMP, "bin")
fs.mkdirSync(STUB, { recursive: true })

// stub npm: logs args, fails installs with EACCES, fails link
fs.writeFileSync(path.join(STUB, "npm"), `#!/usr/bin/env bash
echo "$*" >> "$NPM_CALL_LOG"
case "$1" in
  prefix) echo "${TMP}/prefix"; exit 0 ;;
  i|install) echo "npm ERR! code EACCES"; exit 243 ;;
  link) exit 1 ;;
esac
exit 0
`)
fs.chmodSync(path.join(STUB, "npm"), 0o755)

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }

function run(args, { log } = {}) {
  const env = { ...process.env, PATH: `${STUB}:${process.env.PATH}`, NPM_CALL_LOG: log || path.join(TMP, "calls.txt") }
  try {
    return { out: execFileSync("bash", [INSTALL, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), code: 0 }
  } catch (e) {
    return { out: String(e.stdout ?? "") + String(e.stderr ?? ""), code: e.status ?? 1 }
  }
}

console.log("== options ==")
{
  const r = run(["--help"])
  ok("--help prints usage and exits 0", r.code === 0 && /usage: bash install\.sh/.test(r.out))
  const bad = run(["--nope"])
  ok("unknown option exits non-zero", bad.code !== 0 && /unknown option/.test(bad.out))
  const noarg = run(["--prefix"])
  ok("--prefix without a directory is rejected", noarg.code !== 0)
}

console.log("== P1-10: a failing install runs npm ONCE ==")
{
  const log = path.join(TMP, "calls-fail.txt")
  fs.writeFileSync(log, "")
  const r = run(["--prefix", path.join(TMP, "prefix")], { log })
  const calls = fs.readFileSync(log, "utf8").split("\n").filter((l) => /^(i|install)\b/.test(l))
  ok("exactly one npm install attempt", calls.length === 1)
  ok("install failure is surfaced, not swallowed", /EACCES/.test(r.out))
  ok("EACCES guidance offers a no-sudo prefix", /--prefix/.test(r.out) && /sudo/.test(r.out))
  ok("exits non-zero when the install fails", r.code !== 0)
}

console.log("== --prefix is passed through to npm ==")
{
  const log = path.join(TMP, "calls-prefix.txt")
  fs.writeFileSync(log, "")
  run(["--prefix", path.join(TMP, "prefix")], { log })
  ok("npm received the --prefix flag", /--prefix/.test(fs.readFileSync(log, "utf8")))
}

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log(`\n== install suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
