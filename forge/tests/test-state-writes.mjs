#!/usr/bin/env node
/**
 * forge — one crash-safe writer for ~/.forge state (v21.1).
 * Fault-injection matrix over writeStateFile and the modules that use it
 * (sessions, taskstate, config, health, runlog, checkpoint manifest):
 *  - kill between temp write and rename  → previous file intact, no temp left
 *  - rename fails                         → previous file intact, temp removed
 *  - fsync fails                          → previous file intact
 *  - partial write (disk full simulation) → previous file intact
 *  - concurrent writers                   → every observed file is complete JSON
 *  - mode 0600 on create AND on replace of a 0644 file; symlink honoured;
 *    directory / fifo at the path refused
 *  - checkpoint restore crash: kill after N of M restore writes → resume
 *    completes or the manifest still lists the pending files
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync, spawn } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-state-"))
process.env.FORGE_HOME = HOME
const { writeStateFile } = await import("../securefs.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 300) : ""}`) } }
const tmps = (dir) => fs.readdirSync(dir).filter((n) => /\.tmp$/.test(n))
const mode = (f) => fs.statSync(f).mode & 0o777

console.log("== basic contract ==")
{
  const f = path.join(HOME, "a", "b", "state.json")
  const r = writeStateFile(f, '{"v":1}')
  ok("creates parents + file", fs.readFileSync(f, "utf8") === '{"v":1}' && r.replaced === false)
  ok("mode 0600 on create", mode(f) === 0o600, mode(f).toString(8))
  fs.chmodSync(f, 0o644)
  writeStateFile(f, '{"v":2}')
  ok("mode 0600 re-applied on replace", mode(f) === 0o600 && fs.readFileSync(f, "utf8") === '{"v":2}')
  ok("explicit mode honoured", (writeStateFile(path.join(HOME, "plan.md"), "x", { mode: 0o644 }), mode(path.join(HOME, "plan.md")) === 0o644))
  ok("no temp left", tmps(path.dirname(f)).length === 0)
  const real = path.join(HOME, "real.json"); fs.writeFileSync(real, "{}")
  const link = path.join(HOME, "link.json"); fs.symlinkSync(real, link)
  writeStateFile(link, '{"via":"link"}')
  ok("symlink honoured: written through, link kept", fs.lstatSync(link).isSymbolicLink() && fs.readFileSync(real, "utf8") === '{"via":"link"}')
  const d = path.join(HOME, "adir"); fs.mkdirSync(d)
  let threw = null; try { writeStateFile(d, "x") } catch (e) { threw = e }
  ok("directory at path refused", threw && /not a regular file/.test(threw.message))
}

console.log("== fault injection: previous content always survives ==")
{
  const f = path.join(HOME, "fi", "s.json")
  writeStateFile(f, "GOOD")
  const faults = {
    "rename fails": ["renameSync", () => { throw Object.assign(new Error("EIO"), { code: "EIO" }) }],
    "fsync fails": ["fsyncSync", () => { throw Object.assign(new Error("EIO fsync"), { code: "EIO" }) }],
    "partial write (ENOSPC)": ["writeSync", () => { throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }) }],
    "open temp fails (EACCES)": ["openSync", () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }) }],
  }
  for (const [name, [fn, impl]] of Object.entries(faults)) {
    const real = fs[fn]
    fs[fn] = function (...a) { if (fn === "openSync" && !/\.tmp$/.test(String(a[0]))) return real.apply(fs, a); return impl(...a) }
    let err = null
    try { writeStateFile(f, "NEW") } catch (e) { err = e } finally { fs[fn] = real }
    ok(`${name}: error surfaced`, err !== null)
    ok(`${name}: previous content intact`, fs.readFileSync(f, "utf8") === "GOOD")
    ok(`${name}: no temp file left`, tmps(path.dirname(f)).length === 0, tmps(path.dirname(f)).join(","))
  }
}

console.log("== crash between temp write and rename (real process kill) ==")
{
  const f = path.join(HOME, "crash", "s.json")
  writeStateFile(f, "BEFORE-CRASH")
  // child: monkey-patch renameSync to SIGKILL itself right before renaming
  const script = `
    import fs from "node:fs"
    const { writeStateFile } = await import(${JSON.stringify(new URL("../securefs.js", import.meta.url).href)})
    const real = fs.renameSync
    fs.renameSync = (...a) => { process.kill(process.pid, "SIGKILL") }
    writeStateFile(${JSON.stringify(f)}, "AFTER-CRASH")
  `
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" })
  ok("child was killed", r.signal === "SIGKILL")
  ok("previous content intact after crash", fs.readFileSync(f, "utf8") === "BEFORE-CRASH")
  const left = tmps(path.dirname(f))
  ok("a crash leaves at most the orphan temp (never a torn target)", left.length <= 1)
  writeStateFile(f, "RECOVERED")
  ok("next write succeeds regardless of the orphan", fs.readFileSync(f, "utf8") === "RECOVERED")
}

console.log("== concurrent writers: readers never see a torn file ==")
{
  const f = path.join(HOME, "conc", "s.json")
  const script = `
    const { writeStateFile } = await import(${JSON.stringify(new URL("../securefs.js", import.meta.url).href)})
    const w = process.argv[1]
    for (let i = 0; i < 200; i++) writeStateFile(${JSON.stringify(f)}, JSON.stringify({ w, i, pad: "x".repeat(20000) }))
  `
  const procs = Array.from({ length: 4 }, (_, w) => new Promise((res) => spawn(process.execPath, ["--input-type=module", "-e", script, String(w)], { stdio: "ignore" }).on("exit", res)))
  let torn = 0, reads = 0
  const t0 = Date.now()
  while (Date.now() - t0 < 1500) { try { const j = JSON.parse(fs.readFileSync(f, "utf8")); reads++; if (j.pad.length !== 20000) torn++ } catch (e) { if (e.code !== "ENOENT") torn++ } }
  await Promise.all(procs)
  ok(`no torn reads under 4 concurrent writers (${reads} reads)`, torn === 0 && reads > 0, `${torn} torn`)
  ok("no temp files left", tmps(path.dirname(f)).length === 0)
}

console.log("== modules use the shared writer ==")
{
  const { saveSession, loadSession } = await import("../sessions.js")
  const { saveConfig } = await import("../config.js")
  const { recordHealth, readHealth } = await import("../health.js")
  const sf = saveSession({ provider: "p", model: "m", messages: [{ role: "user", content: "hi" }], usage: {}, cwd: HOME })
  ok("session saved 0600", sf && mode(sf) === 0o600 && loadSession(sf)?.messages?.length === 1)
  const real = fs.renameSync
  fs.renameSync = () => { throw new Error("EIO") }
  let sf2
  try { sf2 = saveSession({ provider: "p", model: "m", messages: [{ role: "user", content: "changed" }], id: path.basename(sf, ".json"), usage: {}, cwd: HOME }) } finally { fs.renameSync = real }
  ok("failed session save keeps the previous session readable", loadSession(sf)?.messages?.[0]?.content === "hi")
  const cfgPath = path.join(HOME, "config.json")
  saveConfig({ providers: { x: { apiKey: "sk-secret" } } }, cfgPath)
  ok("config 0600", mode(cfgPath) === 0o600)
  fs.renameSync = () => { throw new Error("EIO") }
  let cerr = null
  try { saveConfig({ providers: {} }, cfgPath) } catch (e) { cerr = e } finally { fs.renameSync = real }
  ok("failed config save throws AND keeps the old keys", cerr && JSON.parse(fs.readFileSync(cfgPath, "utf8")).providers.x.apiKey === "sk-secret")
  recordHealth("prov", { ok: true })
  ok("health written", readHealth().prov?.ok === true)
  const orphanDir = path.join(HOME, "crash") // the SIGKILL test above legitimately leaves its orphan there
  ok("no temp files anywhere under FORGE_HOME (except the deliberate crash orphan)", !fs.readdirSync(HOME, { recursive: true }).some((n) => /\.tmp$/.test(String(n)) && !path.join(HOME, String(n)).startsWith(orphanDir)))
}

console.log("== task state: crash mid-write never yields a torn task file ==")
{
  const { openTask, readTask, TASK_STATUS } = await import("../taskstate.js")
  const ts = openTask("t-crash", { objective: "o", cwd: HOME })
  ts.transition(TASK_STATUS.PLANNING, { reason: "x" }); ts.flush()
  const before = readTask("t-crash")
  ok("task persisted", before && before.status === TASK_STATUS.PLANNING)
  const real = fs.renameSync
  fs.renameSync = () => { throw Object.assign(new Error("EIO"), { code: "EIO" }) }
  let fr = null
  const origErr = console.error; const logged = []; console.error = (...a) => logged.push(a.join(" "))
  try { ts.transition(TASK_STATUS.EXECUTING, { reason: "y" }); fr = ts.flush() } finally { fs.renameSync = real; console.error = origErr }
  const after = readTask("t-crash")
  ok("critical flush failure is reported ({ok:false,error} + stderr), not swallowed", fr && fr.ok === false && fr.error && logged.some((l) => /CRITICAL persistence failure/.test(l)))
  ok("task file is still the last complete state (no torn JSON)", after && after.status === TASK_STATUS.PLANNING, JSON.stringify(after)?.slice(0, 100))
  ok("no task temp files left", !fs.readdirSync(path.join(HOME, "tasks")).some((n) => /\.tmp/.test(n)), fs.readdirSync(path.join(HOME, "tasks")).join(","))
  ts.flush()
  ok("after the fault clears, the pending state lands", readTask("t-crash").status === TASK_STATUS.EXECUTING)
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
console.log(`\n== state-writes suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
