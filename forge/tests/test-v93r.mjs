#!/usr/bin/env node
/**
 * v93 GAP FIX — phase 5: RUNTIME INTELLIGENCE (runtimesession.js).
 *
 *  1. Discovery is evidence-based: every fact carries file+field; commands
 *     are never invented (unknown project → honest "unknown" + missing list).
 *  2. Health probes are REAL HTTP requests: a live server → ok + evidence;
 *     a dead port → not ok (evidence AGAINST a "server started" claim).
 *  3. The claim gate: "server started" requires process + health proof —
 *     a build that exits 0 is not runtime proof.
 *  4. Launch: discovered command (from real scripts) via the ONE process
 *     manager; ledger persisted with pid/pgid/starttime.
 *  5. Crash reconcile: dead pid → reported; live owned → orphan; pid-reuse
 *     (starttime mismatch) → NOT ours, never touched; unrelated processes
 *     never appear because we only act on ledger entries.
 *  6. Tool wiring: 30 tools (v94c toolwise), verifier gating (discover/status/health/claim/
 *     reconcile allowed; launch/stop blocked), read-only gating.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93r-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93r-work-"))
process.chdir(WORK)

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const rs = await import("../runtimesession.js")
const { projectDir } = await import("../memory.js")
const { execTool, makeToolContext, disposeToolManagers, TOOL_DEFS, VERIFICATION_TOOLS, verificationAllows, toolCount, getProcessManager, getRuntimeSession } = await import("../tools.js")
const { BUILTIN_CAPABILITIES, checkWriteClassification, defaultRegistry } = await import("../capabilities.js")

// ---------------------------------------------------------------------------
console.log("== 1. discovery — evidence-based, never invented ==")
{
  // a real node web project
  const WEB = path.join(WORK, "webproj")
  fs.mkdirSync(WEB, { recursive: true })
  fs.writeFileSync(path.join(WEB, "package.json"), JSON.stringify({
    name: "webproj", main: "src/index.js",
    scripts: { dev: "node srv.js", build: "echo built", test: "node --test" },
    dependencies: { express: "^4.0.0" },
  }, null, 2))
  fs.writeFileSync(path.join(WEB, "package-lock.json"), "{}")
  fs.writeFileSync(path.join(WEB, "srv.js"), "require('http').createServer((q,s)=>s.end('hi')).listen(0,'127.0.0.1',()=>console.log('up'))\nsetInterval(()=>{},1e6)\n")

  const d = rs.discoverRuntime(WEB)
  eq("web project type detected (express → backend)", d.projectType, "backend")
  ok("adapter carries its why", /express/.test(d.adapters[0].why))
  eq("package manager from lockfile evidence", d.packageManager, "npm")
  const pmFact = d.facts.find((f) => f.key === "packageManager")
  eq("packageManager fact cites the lockfile", pmFact?.evidence.file, "package-lock.json")
  eq("run command from scripts.dev", d.runCommand?.command, "npm run dev")
  eq("run command cites its source", d.runCommand?.source, "package.json scripts.dev")
  eq("build command from scripts.build", d.buildCommand?.command, "npm run build")
  ok("entrypoint fact from package.json main", d.facts.some((f) => f.key === "entrypoint" && f.value === "src/index.js" && f.evidence.field === "main"))
  ok("every fact carries evidence (file + field)", d.facts.every((f) => f.evidence?.file))

  // an unknown project: honest, no invented commands
  const EMPTY = path.join(WORK, "empty")
  fs.mkdirSync(EMPTY, { recursive: true })
  const d2 = rs.discoverRuntime(EMPTY)
  eq("unknown project → type unknown (honest)", d2.projectType, "unknown")
  eq("no run command invented", d2.runCommand, null)
  eq("no build command invented", d2.buildCommand, null)
  ok("missing list explains what was not found", d2.missing.length >= 1 && /manifest/.test(d2.missing[0]))

  // multi-service compose ports are static hints WITH their source
  const COMPOSE = path.join(WORK, "composeproj")
  fs.mkdirSync(COMPOSE, { recursive: true })
  fs.writeFileSync(path.join(COMPOSE, "docker-compose.yml"), "services:\n  api:\n    ports:\n      - \"8080:8080\"\n  db:\n    ports:\n      - \"5432:5432\"\n")
  const d3 = rs.discoverRuntime(COMPOSE)
  eq("compose → multi-service adapter", d3.adapters[0]?.id, "multi-service")
  eq("static port hints with source", d3.portHints?.ports.join(","), "8080,5432")
  eq("port hint fact cites compose file", d3.facts.find((f) => f.key === "portHints")?.evidence.file, "docker-compose.yml")
}

// ---------------------------------------------------------------------------
console.log("== 2. health probes are REAL (never faked) ==")
{
  const srv = http.createServer((q, s) => { s.writeHead(200); s.end("ok") })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const port = srv.address().port
  const good = await rs.healthProbe({ port })
  ok("live server → healthy with status evidence", good.ok === true && good.probe.status === 200 && good.probe.ms >= 0)
  const bad = await rs.healthProbe({ port: 1 }) // port 1: nothing there
  ok("dead port → NOT healthy (evidence against claims)", bad.ok === false && Boolean(bad.error))
  const invalid = await rs.healthProbe({ port: "not-a-port" }) // v94 todowise: async (protocol-aware probe awaits the TCP fallback)
  ok("invalid port → honest error, no probe", invalid.ok === false && invalid.probe === null)
  srv.close()
}

// ---------------------------------------------------------------------------
console.log("== 3/4. session — discovered launch, ledger, claim gate (BEHAVIORAL) ==")
{
  const WEB = path.join(WORK, "webproj")
  process.chdir(WEB)
  disposeToolManagers() // fresh managers for this cwd
  const mgr = getProcessManager()
  const session = rs.createRuntimeSession({ cwd: WEB, mgr })

  // launch the DISCOVERED command (npm run dev → node srv.js)
  const launch = session.launch({})
  ok("discovered launch succeeds", launch.ok === true, JSON.stringify(launch.error ?? ""))
  eq("the launched command is the discovered one", launch.command, "npm run dev")
  eq("the command source is cited", launch.source, "package.json scripts.dev")

  // ledger persisted with pid + starttime (pid-reuse guard)
  const ledFile = path.join(projectDir(WEB), "runtime-ledger.json")
  const led = JSON.parse(fs.readFileSync(ledFile, "utf8"))
  ok("ownership ledger persisted with pid", typeof led.entries[0]?.pid === "number" && led.entries[0].pid > 0)
  ok("ledger records the pgid (group kill safety)", led.entries[0]?.pgid === led.entries[0]?.pid)
  const st0 = led.entries[0]?.starttime
  ok("ledger records /proc starttime (pid-reuse guard)", st0 == null || typeof st0 === "number") // null only on non-/proc systems

  // wait for boot, then health + claim
  await mgr.poll(launch.entry.id, { waitMs: 2500 })
  const health = await session.health({})
  ok("health probe against the live server passes", health.ok === true, JSON.stringify(health.error ?? ""))
  const claim = await session.claimServerStarted({})
  ok("CLAIM 'server started' PROVEN: process + health evidence", claim.ok === true, JSON.stringify({ procs: claim.processes.length, h: claim.health.error }))
  ok("claim recorded as evidence", session.evidenceLog().some((e) => /PROVEN/.test(e.claim)))

  // status is observable
  const st = await session.status()
  ok("status shows live process + ledger", st.ok && st.processes.length >= 1 && st.ledger.length >= 1)
  ok("status reports the project type from discovery", st.project.type === "backend")

  // stop + reconcile cleans up
  session.stop({ name: "app" })
  await new Promise((r) => setTimeout(r, 300))

  // §11: build success alone is NOT runtime proof — with the process stopped
  // (even though this project HAS a passing build script) no claim may pass
  const claim2 = await session.claimServerStarted({})
  ok("no live process → cannot claim 'server started' (build success ≠ runtime proof)", claim2.ok === false)
  eq("no processes listed", claim2.processes.length, 0)

  const rec = session.reconcile({})
  ok("reconcile after stop: ledger is clean (dead entries dropped)", rec.entries.length === 0 || rec.entries.every((e) => e.verdict === "dead"), JSON.stringify(rec.entries))
  disposeToolManagers()
  process.chdir(WORK)
}

// ---------------------------------------------------------------------------
console.log("== 4b. crash reconcile — owned-only, pid-reuse guard ==")
{
  // simulate a crash: write a ledger with (a) a live OWNED process spawned
  // outside the manager, (b) a dead pid, (c) a pid-reuse entry
  const R = path.join(WORK, "recon")
  fs.mkdirSync(R, { recursive: true })
  fs.writeFileSync(path.join(R, "package.json"), "{}")
  const { spawn } = await import("node:child_process")
  const owned = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })
  owned.unref()
  const livePid = owned.pid

  const hash = projectDir(R)
  fs.mkdirSync(hash, { recursive: true })
  const ledger = { entries: [
    { name: "owned", command: "sleep 30", pid: livePid, pgid: livePid, starttime: procStarttime(livePid), startedAt: Date.now(), source: "test" },
    { name: "dead", command: "x", pid: 999999, pgid: 999999, starttime: null, startedAt: Date.now(), source: "test" },
    { name: "reused", command: "x", pid: livePid, pgid: livePid, starttime: (procStarttime(livePid) ?? 1) + 99999, startedAt: Date.now(), source: "test" },
  ] }
  fs.writeFileSync(path.join(hash, "runtime-ledger.json"), JSON.stringify(ledger))

  const session = rs.createRuntimeSession({ cwd: R, mgr: getProcessManager() })
  const rec = session.reconcile({})
  const verdicts = Object.fromEntries(rec.entries.map((e) => [e.name, e.verdict]))
  eq("live owned process → orphan-owned", verdicts.owned, "orphan-owned")
  eq("dead pid → dead", verdicts.dead, "dead")
  eq("starttime mismatch → pid-reused (NOT ours)", verdicts.reused, "pid-reused")

  // kill mode removes ONLY the owned orphan (never the reused pid)
  const rec2 = session.reconcile({ kill: true })
  await new Promise((r) => setTimeout(r, 300))
  let ownedAlive = true
  try { process.kill(livePid, 0) } catch { ownedAlive = false }
  ok("kill mode kills the owned orphan", ownedAlive === false)
  const after = JSON.parse(fs.readFileSync(path.join(hash, "runtime-ledger.json"), "utf8"))
  eq("ledger cleared after destructive reconcile", after.entries.length, 0)
}
function procStarttime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const rest = stat.slice(stat.lastIndexOf(")") + 2)
    return Number(rest.split(" ")[19]) || null
  } catch { return null }
}

// ---------------------------------------------------------------------------
console.log("== 5. tool wiring — registry, verifier + read-only gating ==")
{
  eq("tool count is 30 (runtime + v94c toolwise + v113 github)", toolCount(), 30)
  eq("TOOL_DEFS length 30", TOOL_DEFS.length, 30)
  ok("runtime def registered", TOOL_DEFS.some((t) => t.function.name === "runtime"))
  eq("capabilities registry 1:1 with the wire (26)", BUILTIN_CAPABILITIES.length, TOOL_DEFS.length)
  eq("checkWriteClassification: no disagreement", checkWriteClassification(defaultRegistry({})).length, 0)
  ok("runtime in verifier allowed set", VERIFICATION_TOOLS.allowed.includes("runtime"))
  ok("runtime NOT in verifier forbidden set", !VERIFICATION_TOOLS.forbidden.includes("runtime"))

  ok("verifier: runtime discover allowed", verificationAllows("runtime", { action: "discover" }).ok === true)
  ok("verifier: runtime health allowed (runtime evidence IS verification)", verificationAllows("runtime", { action: "health" }).ok === true)
  ok("verifier: runtime claim allowed", verificationAllows("runtime", { action: "claim" }).ok === true)
  ok("verifier: runtime launch BLOCKED", verificationAllows("runtime", { action: "launch" }).ok === false)
  ok("verifier: runtime stop BLOCKED", verificationAllows("runtime", { action: "stop" }).ok === false)

  // real tool dispatch against a real project dir
  const WEB = path.join(WORK, "webproj")
  const wrapped = makeToolContext({ cwd: WEB, readOnly: false })
  const ctx = wrapped.ctx
  const disc = await execTool(ctx, "runtime", { action: "discover" })
  ok("discover via the tool returns evidence-carrying text", /RUNTIME DISCOVERY \(backend\)/.test(disc) && /package-lock\.json/.test(disc), String(disc).slice(0, 200))

  const ro = makeToolContext({ cwd: WEB, readOnly: true }).ctx
  ok("read-only: runtime discover ALLOWED", !(await execTool(ro, "runtime", { action: "discover" })).startsWith("BLOCKED"))
  ok("read-only: runtime launch BLOCKED", /BLOCKED/.test(await execTool(ro, "runtime", { action: "launch" })), await execTool(ro, "runtime", { action: "launch" }))
  ok("read-only: runtime status ALLOWED", !(await execTool(ro, "runtime", { action: "status" })).startsWith("BLOCKED"))

  const vf = makeToolContext({ cwd: WEB, mode: "verifier" }).ctx
  ok("verifier mode: runtime claim executes", !(await execTool(vf, "runtime", { action: "claim" })).startsWith("BLOCKED"))
  ok("verifier mode: runtime launch blocked", /BLOCKED/.test(await execTool(vf, "runtime", { action: "launch" })))

  // unknown action → honest error
  const bad = await execTool(ctx, "runtime", { action: "nonsense" })
  ok("unknown action → ERROR, never a silent ok", /^ERROR: unknown runtime action/.test(bad))
  disposeToolManagers()
}

console.log(`\n== v93r: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
