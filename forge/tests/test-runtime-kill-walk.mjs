#!/usr/bin/env node
/**
 * v94 gapclose — EVIDENCE-BASED process-group kill walk (TODO runtime #1).
 *
 * Before: when `kill(-pgid)` failed (platforms without group signals), the
 * fallback killed ONLY the leader — `sh -c` grandchildren (the real server)
 * were orphaned, violating the process-ownership contract (§133: no orphan
 * process trees). Now the fallback walks the REAL process table (/proc on
 * linux, `ps -axo pid=,pgid=,ppid=` on other POSIX, PowerShell/wmic on
 * win32) and signals every member. Evidence, never assumption.
 *
 * The fallback is exercised deterministically by stubbing process.kill to
 * reject negative pids (exactly what a no-group-signal platform does), then
 * proving the whole tree still dies.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-killwalk-"))
process.env.FORGE_HOME = HOME

const { createProcessManager, groupPidsPortable } = await import("../runtime.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 260) : ""}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const IS_LINUX = process.platform === "linux" && fs.existsSync("/proc")
const HAS_PS = (() => {
  try { execFileSync("ps", ["-axo", "pid=,pgid=,ppid="], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }); return true } catch { return false }
})()

/** A shell tree: leader `sh` + two background `sleep` children in its group. */
const TREE_CMD = "sleep 30 & sleep 30 & wait"

console.log("== groupPidsPortable finds the REAL tree from the process table ==")
let mgr = createProcessManager({ installSignalHandlers: false })
let leaderPid = null
let members = []
{
  const r = mgr.spawn({ command: TREE_CMD, name: "tree1" })
  ok("tree spawned", r.ok === true, JSON.stringify(r))
  leaderPid = r.entry.pid
  await sleep(400) // let sh fork the sleeps
  members = groupPidsPortable(leaderPid)
  ok("walk includes the leader", members.includes(leaderPid), JSON.stringify(members))
  ok("walk finds the grandchildren (>= 3 members: sh + 2 sleeps)", members.length >= 3, JSON.stringify(members))
  ok("every walked member is a real live pid", members.every(pidAlive), JSON.stringify(members.filter((p) => !pidAlive(p))))
}

console.log("== forced fallback: no group signal → the walk kills the WHOLE tree ==")
{
  const realKill = process.kill
  // simulate a platform where kill(-pgid) does not exist: negative pids throw
  process.kill = function (pid, sig) {
    if (typeof pid === "number" && pid < 0) {
      const e = new Error("kill(-pgid) unsupported (simulated)")
      e.code = "EPERM"
      throw e
    }
    return realKill.call(process, pid, sig)
  }
  let killResult
  try {
    killResult = mgr.kill("tree1", "SIGKILL")
  } finally {
    process.kill = realKill
  }
  ok("kill reports the signal was sent (via the walk)", killResult.ok === true && /sent/.test(killResult.note ?? ""), JSON.stringify(killResult))
  await sleep(500)
  const survivors = members.filter((p) => p !== leaderPid && pidAlive(p))
  ok("NO orphan grandchildren: every walked non-leader member is dead", survivors.length === 0, JSON.stringify(survivors))
  // the leader is this process's child — poll until the manager reaps it
  let reaped = false
  for (let i = 0; i < 20; i++) {
    const st = mgr.status("tree1")
    if (st.ok && st.entry.state !== "running") { reaped = true; break }
    await sleep(100)
  }
  ok("manager observed the leader exit (evidence, not assumption)", reaped, JSON.stringify(mgr.status("tree1")))
}

console.log("== normal path (group signal available) still works ==")
{
  const r = mgr.spawn({ command: TREE_CMD, name: "tree2" })
  await sleep(400)
  const m2 = groupPidsPortable(r.entry.pid)
  const k = mgr.kill("tree2", "SIGKILL")
  ok("kill sent", k.ok === true)
  await sleep(500)
  const survivors = m2.filter((p) => p !== r.entry.pid && pidAlive(p))
  ok("group-signal path also leaves no orphans", survivors.length === 0, JSON.stringify(survivors))
  for (let i = 0; i < 20; i++) {
    const st = mgr.status("tree2")
    if (st.ok && st.entry.state !== "running") break
    await sleep(100)
  }
}

console.log("== portable walkers: ps path (any POSIX) + win32 honesty ==")
{
  const r = mgr.spawn({ command: TREE_CMD, name: "tree3" })
  await sleep(400)
  const leader = r.entry.pid
  if (HAS_PS) {
    // the darwin/BSD branch speaks `ps -axo pid=,pgid=,ppid=` — procps on
    // linux understands the same dialect, so the branch is testable here
    const viaPs = groupPidsPortable(leader, { platform: "darwin" })
    ok("ps-based walk (darwin branch) finds the leader", viaPs.includes(leader), JSON.stringify(viaPs))
    ok("ps-based walk finds group members too (>= 3)", viaPs.length >= 3, JSON.stringify(viaPs))
  } else {
    console.log("  --   (ps not available — darwin branch skipped honestly)")
  }
  // win32 branch: no powershell/wmic on this host → leader-only, never a throw
  const viaWin = groupPidsPortable(leader, { platform: "win32" })
  ok("win32 walk without PowerShell/wmic degrades to leader-only (no throw)", Array.isArray(viaWin) && viaWin.includes(leader), JSON.stringify(viaWin))
  // garbage input
  ok("garbage pid → empty walk, no throw", groupPidsPortable(-5).length === 0 && groupPidsPortable("x").length === 0)
  mgr.kill("tree3", "SIGKILL")
  await sleep(300)
}

if (IS_LINUX) {
  console.log("== /proc walk and portable walk agree on linux ==")
  const r = mgr.spawn({ command: TREE_CMD, name: "tree4" })
  await sleep(400)
  const a = groupPidsPortable(r.entry.pid).sort((x, y) => x - y)
  const b = groupPidsPortable(r.entry.pid, { platform: "linux" }).sort((x, y) => x - y)
  ok("same evidence from both entry points", JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
  mgr.kill("tree4", "SIGKILL")
  await sleep(300)
}

try { mgr.dispose() } catch {}
await sleep(200)
console.log(`\n== runtime-kill-walk suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
