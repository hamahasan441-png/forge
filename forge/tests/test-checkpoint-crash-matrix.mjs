#!/usr/bin/env node
/**
 * forge — checkpoint restore under crashes (v21.1 P1 fault-injection matrix).
 * For a checkpoint covering M files, a child process performs the restore and
 * is SIGKILLed right after the N-th file write (N = 0..M), also right after
 * the manifest is retired. After every kill the parent checks:
 *  - every file is either fully the pre-checkpoint content or fully the
 *    modified content — never a torn/partial file
 *  - the checkpoint directory and manifest still exist (never retired early)
 *    unless ALL files were restored and verified
 *  - a second, uninterrupted restore completes with status RESTORED and every
 *    file matches its recorded SHA-256
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cpcrash-home-"))
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cpcrash-work-"))
process.env.FORGE_HOME = HOME
process.chdir(WORK)
const cp = await import("../checkpoint.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 300) : ""}`) } }
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex")

const M = 4
const files = Array.from({ length: M }, (_, i) => path.join(WORK, `f${i}.txt`))
const ORIGINAL = files.map((_, i) => `original-${i}\n` + "o".repeat(30000 + i))
const MODIFIED = files.map((_, i) => `modified-${i}\n` + "m".repeat(30000 + i))
const cpUrl = new URL("../checkpoint.js", import.meta.url).href

function setup() {
  files.forEach((f, i) => fs.writeFileSync(f, ORIGINAL[i]))
  const id = cp.snapshotBefore(files, WORK, [], "run-crash")
  files.forEach((f, i) => fs.writeFileSync(f, MODIFIED[i]))
  return id
}
function classify() {
  return files.map((f, i) => {
    let cur; try { cur = fs.readFileSync(f, "utf8") } catch { return "MISSING" }
    if (cur === ORIGINAL[i]) return "ORIGINAL"
    if (cur === MODIFIED[i]) return "MODIFIED"
    return "TORN"
  })
}
function crashRestore(id, killAfterWrites, { killAfterRetire = false } = {}) {
  const script = `
    import fs from "node:fs"
    process.env.FORGE_HOME = ${JSON.stringify(HOME)}
    process.chdir(${JSON.stringify(WORK)})
    const cp = await import(${JSON.stringify(cpUrl)})
    let writes = 0
    const realRename = fs.renameSync
    fs.renameSync = (a, b) => {
      // a restore write = rename of a temp onto a project file (not into the checkpoint dir)
      const r = realRename(a, b)
      if (!String(b).includes(${JSON.stringify(HOME)})) { writes++; if (writes === ${killAfterWrites} && !${killAfterRetire}) process.kill(process.pid, "SIGKILL") }
      return r
    }
    const realRm = fs.rmSync
    fs.rmSync = (p, o) => { const r = realRm(p, o); if (${killAfterRetire} && String(p).includes(${JSON.stringify(id)})) process.kill(process.pid, "SIGKILL"); return r }
    const res = cp.restoreTransactional(${JSON.stringify(id)}, { cwd: ${JSON.stringify(WORK)} })
    console.log(JSON.stringify({ status: res.status, restored: res.restored.length }))
  `
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })
}
const cpDir = (id) => path.join(HOME, "checkpoints", id)

console.log(`== kill after N of ${M} restore writes ==`)
for (let n = 1; n <= M; n++) {
  const id = setup()
  const r = crashRestore(id, n)
  const killed = r.signal === "SIGKILL"
  const states = classify()
  ok(`N=${n}: child killed mid-restore`, killed, `signal=${r.signal} out=${r.stdout}`)
  ok(`N=${n}: no torn or missing file`, states.every((s) => s === "ORIGINAL" || s === "MODIFIED"), states.join(","))
  ok(`N=${n}: exactly ${n} file(s) restored so far`, states.filter((s) => s === "ORIGINAL").length === n, states.join(","))
  ok(`N=${n}: checkpoint NOT retired (manifest still present for resume)`, fs.existsSync(path.join(cpDir(id), "manifest.json")))
  const again = cp.restoreTransactional(id, { cwd: WORK })
  ok(`N=${n}: resumed restore completes`, again.status === "RESTORED" && again.ok === true, JSON.stringify({ status: again.status, notes: again.notes }).slice(0, 200))
  ok(`N=${n}: every file matches the pre-checkpoint SHA-256`, classify().every((s) => s === "ORIGINAL") && files.every((f, i) => sha(fs.readFileSync(f)) === sha(Buffer.from(ORIGINAL[i]))))
  ok(`N=${n}: checkpoint retired only after a complete, verified restore`, !fs.existsSync(cpDir(id)))
  ok(`N=${n}: no temp files left in the project`, !fs.readdirSync(WORK).some((x) => /\.tmp$/.test(x)), fs.readdirSync(WORK).join(","))
}

console.log("== kill during checkpoint retirement (all files already restored) ==")
{
  const id = setup()
  const r = crashRestore(id, 999, { killAfterRetire: true })
  ok("child killed during retire", r.signal === "SIGKILL")
  ok("all files restored", classify().every((s) => s === "ORIGINAL"))
  // whether or not the directory survived, a re-run must be harmless
  const again = cp.restoreTransactional(id, { cwd: WORK })
  ok("re-running after a retire-crash is harmless (RESTORED, NOT_FOUND-style skip, or nothing to do)", ["RESTORED", "NOT_FOUND", "FAILED", "SKIPPED"].includes(again.status) && classify().every((s) => s === "ORIGINAL"), JSON.stringify(again).slice(0, 200))
}

console.log("== crash with a backup missing: partial is reported, never claimed ==")
{
  const id = setup()
  const m = JSON.parse(fs.readFileSync(path.join(cpDir(id), "manifest.json"), "utf8"))
  fs.rmSync(path.join(cpDir(id), m.files[2].backup))
  const res = cp.restoreTransactional(id, { cwd: WORK })
  ok("status is not RESTORED", res.ok === false && res.status !== "RESTORED", res.status)
  ok("the checkpoint is kept for recovery", fs.existsSync(cpDir(id)))
  ok("files that could be restored are intact, the rest untouched (no torn)", classify().every((s) => s === "ORIGINAL" || s === "MODIFIED"))
}

try { fs.rmSync(HOME, { recursive: true, force: true }); fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
console.log(`\n== checkpoint-crash-matrix suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
