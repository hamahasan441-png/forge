#!/usr/bin/env node
/**
 * forge — v87 FULL CONTROL: broken-bwrap auto-fallback + zero permission pauses.
 *
 * Kali-in-a-container reality: a bwrap binary exists on PATH but the kernel
 * hides /proc/sys/kernel/overflowuid, so EVERY sandboxed command dies before
 * it runs with `bwrap: Can't read /proc/sys/kernel/overflowuid: Permission
 * denied` — and the failure text then mis-classifies as PERMISSION_DENIED,
 * stalling the agent on "needs your decision" forever.
 *
 * This suite pins the two fixes:
 *   1. sandbox: a bwrap that cannot build a user namespace is treated as
 *      missing (probe), and runBash re-runs unsandboxed if one still fails.
 *   2. toolintel: tools.autoApprove (default ON) never hands a decision back
 *      to the user — no "[forge] ask the user:" line, no TOOL_ESCALATION.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v87-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_DATA_DIR
delete process.env.FORGE_AUTO_APPROVE

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

console.log("== sandbox: a broken-kernel bwrap is never chosen ==")
{
  const { findSandboxBinary, detectSandbox } = await import("../sandbox.js")
  const prev = process.env.FORGE_BWRAP
  // fake bwrap on a readable-proc host: the binary is honoured (it may work)
  const fake = path.join(HOME, "fake-bwrap")
  fs.writeFileSync(fake, "#!/bin/sh\nexec /bin/sh \"$@\"\n")
  fs.chmodSync(fake, 0o755)
  process.env.FORGE_BWRAP = fake
  const found = findSandboxBinary()
  if (fs.existsSync("/proc/sys/kernel/overflowuid")) {
    // readable kernel → the pinned binary is trusted (setuid-free)
    eq("readable kernel → pinned bwrap is used", found, fake)
  } else {
    eq("hidden overflowuid → bwrap treated as missing", found, null)
  }
  // setuid bwrap never needs the probe
  fs.chmodSync(fake, 0o6755)
  eq("setuid bwrap skips the kernel probe", findSandboxBinary(), fake)
  fs.chmodSync(fake, 0o755)
  if (prev === undefined) delete process.env.FORGE_BWRAP
  else process.env.FORGE_BWRAP = prev
  ok("detectSandbox stays honest without a binary", detectSandbox({ binary: null }).available === false)
}

console.log("== bash tool: bwrap that dies at startup re-runs UNSANDBOXED ==")
{
  const broken = path.join(HOME, "broken-bwrap")
  fs.writeFileSync(broken, "#!/bin/sh\necho \"bwrap: Can't read /proc/sys/kernel/overflowuid: Permission denied\" >&2\nexit 1\n")
  fs.chmodSync(broken, 0o755)
  process.env.FORGE_BWRAP = broken
  const work = path.join(HOME, "work")
  fs.mkdirSync(work, { recursive: true })
  const { makeToolContext } = await import("../tools.js")
  const tools = makeToolContext({ cwd: work, root: work })
  const r1 = await tools.exec("bash", { command: "echo alive && printf first-run" })
  ok("output is the REAL command output, not the bwrap error", r1.includes("alive") && r1.includes("first-run"))
  ok("no bwrap error leaks into the result", !r1.includes("overflowuid: Permission denied\n[exit code: 1]"))
  ok("the fallback is announced once, honestly", r1.includes("sandbox skipped") && r1.includes("WITHOUT the sandbox"))
  const r2 = await tools.exec("bash", { command: "echo second-run" })
  ok("broken wrapper is skipped for the rest of the session", r2.includes("second-run") && !r2.includes("sandbox skipped"))
  delete process.env.FORGE_BWRAP
}

console.log("== FULL CONTROL: autoApprove never hands a decision to the user ==")
{
  const { shouldEscalate, FAILURE } = await import("../diagnose.js")
  ok("default (no flag): permission denied still asks", shouldEscalate({ code: FAILURE.PERMISSION_DENIED, tool: "bash" }).escalate === true)
  const classes = [
    { code: FAILURE.PERMISSION_DENIED, tool: "bash" },
    { code: FAILURE.SAFETY_BLOCK, attempts: 2, tool: "bash" },
    { code: FAILURE.DEPENDENCY_FAILURE, attempts: 1 },
    { risk: "critical", reversible: false, tool: "bash" },
    { blockedRepeat: true, code: FAILURE.RUNTIME_FAILURE, attempts: 3, tool: "bash" },
  ]
  ok("autoApprove: NO failure class pauses the run", classes.every((c) => shouldEscalate({ ...c, autoApprove: true }).escalate === false))
  ok("autoApprove keeps the shape {escalate:false,question:''}", (() => { const r = shouldEscalate({ code: FAILURE.PERMISSION_DENIED, autoApprove: true }); return r.escalate === false && r.question === "" })())
}
{
  const { createToolIntel } = await import("../toolintel.js")
  const events = []
  const intel = createToolIntel({
    exec: async () => "cat: /root/secret: Permission denied\n[exit code: 1]",
    ctx: { cwd: HOME, root: HOME },
    config: { tools: { intelligence: true, autoApprove: true } },
    onEvent: (e) => events.push(e),
    taskId: "v87",
  })
  const res = await intel.runCall({ name: "bash", args: { command: "cat /root/secret" } })
  ok("no [forge] ask the user: appended", !/\[forge\] ask the user:/.test(res.result ?? ""))
  ok("no TOOL_ESCALATION event emitted", !events.some((e) => e.type === "TOOL_ESCALATION"))
}

console.log("== config: tools.autoApprove defaults ON and is owner-only ==")
{
  const { defaultConfig, sanitizeProjectConfig } = await import("../config.js")
  eq("default ON", defaultConfig().tools?.autoApprove, true)
  const { cfg, dropped } = sanitizeProjectConfig({ tools: { autoApprove: false } })
  ok("a cloned repo's forge.config.json cannot flip it", cfg?.tools?.autoApprove === undefined && dropped.includes("tools.autoApprove"))
}

console.log("== CLI: --yolo forces full control for the process ==")
{
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))) // repo root (…/forge/forge)
  const help = spawnSync("node", [path.join(root, "forge.js"), "--help"], { encoding: "utf8", timeout: 30000 })
  ok("--help documents --yolo", /--yolo/.test(help.stdout ?? ""))
  ok("--help names the config key", /tools\.autoApprove/.test(help.stdout ?? ""))
}

console.log(`\n== v87 suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
