#!/usr/bin/env node
/**
 * v94 gapclose — bwrap kernel-probe RE-PROBE (TODO sandbox).
 *
 * Before: bwrapKernelSupport() cached the overflowuid/overflowgid read once
 * per process. A kernel hardened (or relaxed) AFTER forge started was never
 * re-probed: doctor/capabilities kept reporting a sandbox that demonstrably
 * could not start (or hiding one that now could). Now the first REAL bwrap
 * start failure (tools.js runBash) drops the cached probe via
 * resetSandboxProbe(), so every later detection in the process re-reads the
 * kernel — evidence over a stale boot-time answer.
 *
 * Uses the same fake-bwrap integration path as test-v87: a broken wrapper +
 * FORGE_SANDBOX=1 through the real bash tool.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-reprobe-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_DATA_DIR

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

const KERNEL_READABLE = fs.existsSync("/proc/sys/kernel/overflowuid") && process.platform === "linux"
  ? (() => { try { fs.readFileSync("/proc/sys/kernel/overflowuid"); return true } catch { return false } })()
  : false

console.log("== probe cache: reset drops it, the next detection re-reads the kernel ==")
{
  const { findSandboxBinary, resetSandboxProbe, sandboxProbeState } = await import("../sandbox.js")
  const fake = path.join(HOME, "fake-bwrap")
  fs.writeFileSync(fake, "#!/bin/sh\nexec /bin/sh \"$@\"\n")
  fs.chmodSync(fake, 0o755)
  process.env.FORGE_BWRAP = fake
  process.env.FORGE_SANDBOX = "1"
  eq("fresh process: probe not yet cached", sandboxProbeState(), undefined)
  const found = findSandboxBinary()
  if (KERNEL_READABLE) {
    eq("readable kernel → fake bwrap chosen", found, fake)
    eq("detection cached the kernel answer", sandboxProbeState(), true)
    resetSandboxProbe()
    eq("resetSandboxProbe drops the cached answer", sandboxProbeState(), undefined)
    eq("next detection re-probes and re-establishes it", findSandboxBinary(), fake)
    eq("…and the cache is filled again (re-read, not remembered)", sandboxProbeState(), true)
  } else {
    eq("unreadable kernel → bwrap treated as missing", found, null)
    resetSandboxProbe()
    eq("reset still leaves an honest state", sandboxProbeState(), undefined)
    console.log("  --   (kernel hides overflowuid here — cache-fill assertions skipped honestly)")
  }
  delete process.env.FORGE_BWRAP
  delete process.env.FORGE_SANDBOX
}

console.log("== integration: a REAL bwrap start failure drops the stale probe ==")
if (KERNEL_READABLE) {
  const { sandboxProbeState, findSandboxBinary } = await import("../sandbox.js")
  const broken = path.join(HOME, "broken-bwrap")
  fs.writeFileSync(broken, "#!/bin/sh\necho \"bwrap: Can't read /proc/sys/kernel/overflowuid: Permission denied\" >&2\nexit 1\n")
  fs.chmodSync(broken, 0o755)
  process.env.FORGE_BWRAP = broken
  process.env.FORGE_SANDBOX = "1"
  // detection caches "kernel supports bwrap" — the boot-time answer
  eq("wrapper is selected before the failure", findSandboxBinary(), broken)
  eq("probe cached as supporting", sandboxProbeState(), true)
  const work = path.join(HOME, "work")
  fs.mkdirSync(work, { recursive: true })
  const { makeToolContext } = await import("../tools.js")
  const tools = makeToolContext({ cwd: work, root: work })
  const r1 = await tools.exec("bash", { command: "echo alive-after-fallback" })
  ok("the command still ran (unsandboxed re-run, v87 behavior intact)", r1.includes("alive-after-fallback") && r1.includes("sandbox skipped"), r1.slice(0, 200))
  eq("the stale probe was DROPPED by the real start failure", sandboxProbeState(), undefined)
  // and a later detection re-reads the kernel instead of trusting the cache
  findSandboxBinary()
  ok("later detection re-probed the kernel (state re-established)", sandboxProbeState() !== undefined, JSON.stringify(sandboxProbeState()))
  delete process.env.FORGE_BWRAP
  delete process.env.FORGE_SANDBOX
} else {
  console.log("  --   (this host cannot start unprivileged bwrap — integration path skipped honestly; the unit path above covers the reset contract)")
}

console.log(`\n== sandbox-reprobe suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
