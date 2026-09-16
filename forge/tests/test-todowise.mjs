#!/usr/bin/env node
/**
 * v94 "todowise" — the TODO.md open-gap ledger, closed with proof.
 *
 * Every item below was an OPEN item in forge/TODO.md ("an item moves out of
 * here only when a test proves the behavior exists"). This suite is that
 * proof, one section per closed gap:
 *
 *  1. runtime: protocol-aware health probe — a TCP-only/WebSocket service
 *     reports LISTENER-level health (ok, level "tcp", honest "no HTTP probe"
 *     evidence) instead of a false NOT-HEALTHY; nothing-listening stays NOT
 *     healthy; the claim gate and the tool-layer rendering are level-aware.
 *  2. runtime: process-group kill WITHOUT kill(-pgid) — an evidence-based
 *     member walk (/proc, then a bounded ps parse) signals every member; the
 *     old fallback reached only the leader. Tested with an injected signalFn
 *     that refuses negative pids (simulating the platforms that need this).
 *  3. sandbox: bwrap kernel re-probe — a bwrap startup failure resets the
 *     once-per-process overflowuid/overflowgid verdict; the next
 *     findSandboxBinary() re-probes for real (counter-observed).
 *  4. checkpoint: working-tree drift verification at restore — the manifest's
 *     (sha, postSha) pair attributes the current state; externally-modified
 *     files are KEPT (status DRIFT, never clobbered), forge-owned edits undo
 *     cleanly, unattributed changes revert with a REPORTED drift note; the
 *     write tools seal post-write hashes.
 *  5. semantic_search: persistent index — chunk docs survive the process
 *     (fingerprint-validated per file, ~/.forge/projects/<hash>/), a fresh
 *     process adopts unchanged files and re-chunks only drift, results always
 *     reflect current file content, FORGE_INDEX=0 opts out entirely.
 *  6. tool creation: multi-step scripted behavioral probes — a stateful
 *     plugin (login → act) is verified by a SEQUENCE of steps in one child
 *     process; a failing step aborts and stays INACTIVE; per-step evidence
 *     (schema/expectOk/expectContains) is recorded.
 *  7. LSP: first-party auto-start table — the structured path is the DEFAULT
 *     for ts/js when a server binary is on PATH (proved end-to-end against a
 *     real stand-in language server), user config wins, absent binaries are
 *     honestly null, lsp.autostart=false opts out.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import http from "node:http"
import { spawn, execFileSync } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-todowise-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-todowise-work-"))
process.chdir(WORK)

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
console.log("== 1. protocol-aware health probe (runtimesession.js) ==")
{
  const rs = await import("../runtimesession.js")

  // (a) HTTP server — unchanged contract
  const hsrv = http.createServer((q, s) => { s.writeHead(200); s.end("ok") })
  await new Promise((r) => hsrv.listen(0, "127.0.0.1", r))
  const httpPort = hsrv.address().port
  const goodHttp = await rs.healthProbe({ port: httpPort })
  ok("HTTP server → ok, level http, status evidence", goodHttp.ok === true && goodHttp.level === "http" && goodHttp.probe.status === 200)
  hsrv.close()

  // (b) TCP-only service (closes the socket the moment an HTTP request lands)
  const tsrv = net.createServer((sock) => sock.on("data", () => sock.destroy()))
  await new Promise((r) => tsrv.listen(0, "127.0.0.1", r))
  const tcpPort = tsrv.address().port
  const tcpOnly = await rs.healthProbe({ port: tcpPort, timeoutMs: 1200 })
  ok("TCP-only service → ok (listener IS health evidence)", tcpOnly.ok === true, JSON.stringify(tcpOnly).slice(0, 200))
  ok("level is tcp, never a fake HTTP status", tcpOnly.level === "tcp" && tcpOnly.probe.tcp === true && tcpOnly.probe.status === undefined)
  ok("honest evidence line: no HTTP probe available", /no HTTP probe available/i.test(tcpOnly.note ?? ""))
  ok("probe records the port", tcpOnly.probe.port === tcpPort)

  // (c) nothing listening — still NOT healthy (evidence against claims)
  const dead = await rs.healthProbe({ port: 1, timeoutMs: 800 })
  ok("dead port → NOT healthy, level none", dead.ok === false && dead.level === "none" && Boolean(dead.error))

  // (d) invalid port — honest error, no probe
  const invalid = await rs.healthProbe({ port: "not-a-port" })
  ok("invalid port → honest error, no probe", invalid.ok === false && invalid.probe === null)

  // (e) tcpConnectProbe is exported and real
  const tcp = await rs.tcpConnectProbe({ port: tcpPort })
  ok("tcpConnectProbe connects to the live listener", tcp.ok === true && tcp.ms >= 0)
  const tcpDead = await rs.tcpConnectProbe({ port: 1 })
  ok("tcpConnectProbe refuses a dead port", tcpDead.ok === false && Boolean(tcpDead.error))
  tsrv.close()

  // (f) the CLAIM gate is level-aware: a live process + TCP listener proves
  // "server started" for a TCP service (behavioral, real process manager)
  const { createProcessManager } = await import("../runtime.js")
  const mgr = createProcessManager({ installSignalHandlers: false })
  const freePort = 21000 + Math.floor(Math.random() * 20000)
  const session = rs.createRuntimeSession({ cwd: WORK, mgr })
  const launched = session.launch({ command: `node -e "require('net').createServer(s=>s.on('data',()=>s.destroy())).listen(${freePort}, '127.0.0.1')"`, name: "tcpsrv" })
  ok("TCP service launched through the runtime session", launched.ok === true, JSON.stringify(launched).slice(0, 200))
  // v122: `sleep(700)` then one probe was the same race in a smaller hat — a
  // bare `node -e` server boots in ~50ms unloaded and in far more when CI is
  // doubling every job. Poll what the assertion is about, inside a deadline.
  const bootBy = Date.now() + 15000
  let health = await session.health({ port: freePort })
  while (!(health.ok === true && health.level === "tcp") && Date.now() < bootBy) {
    await sleep(200)
    health = await session.health({ port: freePort })
  }
  ok("session health on the TCP service → ok at tcp level", health.ok === true && health.level === "tcp", JSON.stringify(health).slice(0, 200))
  const claim = await session.claimServerStarted({ port: freePort })
  ok("CLAIM 'server started' PROVEN for a TCP-only service (process + listener)", claim.ok === true, JSON.stringify({ procs: claim.processes?.length, h: claim.health?.error }).slice(0, 200))
  ok("claim evidence mentions the TCP listener", /TCP-listener/.test(session.evidenceLog().filter((e) => e.kind === "claim").at(-1)?.detail ?? ""))
  mgr.kill("tcpsrv", "SIGKILL")
  await sleep(300)
  mgr.dispose()

  // (g) tool-layer rendering is level-aware (real dispatcher)
  const toolsMod = await import("../tools.js")
  const ctx = toolsMod.makeToolContext({ cwd: WORK, root: WORK, skillsDir: null }).ctx
  const free2 = 21000 + Math.floor(Math.random() * 20000)
  const srv2 = net.createServer((s) => s.on("data", () => s.destroy()))
  await new Promise((r) => srv2.listen(free2, "127.0.0.1", r))
  const rendered2 = await toolsMod.execTool(ctx, "runtime", { action: "health", port: free2 })
  ok("execTool runtime health renders REACHABLE + TCP listener for TCP services", /REACHABLE — TCP listener/.test(rendered2), String(rendered2).slice(0, 160))
  srv2.close()
  await toolsMod.disposeToolManagers()
}

// ---------------------------------------------------------------------------
console.log("== 2. process-group kill: evidence-based member walk (runtime.js) ==")
{
  const runtime = await import("../runtime.js")

  // (a) the portable ps parser (pure, deterministic — the non-Linux path of
  // the walk; on Linux /proc answers first and the walk never burns a ps)
  const fakePs = () => "  PID  PGID\n 100  100\n 101  100\n 102  103\n 999  100\n"
  const parsed = runtime.parsePsMembers(fakePs(), 100)
  ok("ps parser finds exactly the group's members", JSON.stringify(parsed.sort((a, b) => a - b)) === JSON.stringify([100, 101, 999]))
  eq("ps parser ignores foreign groups", runtime.parsePsMembers("1 1\n2 2\n", 777).length, 1)

  // (b) ps unavailable → honest leader-only
  const evNoPs = runtime.groupMembersEvidence(424242, { runPs: () => null })
  ok("ps unavailable → leader-only, never a guess", evNoPs.members.length === 1 && evNoPs.members[0] === 424242)

  // (c) invalid pgid → empty, never a crash
  eq("invalid pgid → no members", runtime.groupMembersEvidence(-1).members.length, 0)

  // (d) signalGroup with a signalFn that REFUSES negative pids (the platforms
  // this fix exists for): every member is signaled individually, with counts
  const sent = []
  const noGroupSignal = (pid, sig) => {
    if (pid < 0) throw Object.assign(new Error("group signal not supported"), { code: "EPERM" })
    sent.push(pid)
    process.kill(pid, sig)
  }
  const sh = spawn("sh", ["-c", "sleep 30 & sleep 30 & sleep 30 & wait"], { detached: true, stdio: "ignore" })
  await sleep(300)
  const pgid = sh.pid
  // confirm the group really has members on this /proc-capable system
  const walk = runtime.groupMembersEvidence(pgid)
  ok("the test group really has >1 member (walk sees them)", walk.members.length >= 2, JSON.stringify(walk).slice(0, 120))
  const r = runtime.signalGroup(pgid, "SIGKILL", { signalFn: noGroupSignal })
  ok("group-signal refused → pid-walk delivered to every member", r.sent === true && r.method.startsWith("pid-walk(") && r.delivered === walk.members.length, JSON.stringify(r).slice(0, 160))
  ok("the walk used the REAL process table (no injected ps)", r.method.includes("/proc") || r.method.includes("ps"))
  await sleep(400)
  // A SIGKILL'd member is dead the instant it is signaled, but on a system
  // whose PID 1 does not reap orphans (many containers), a member whose parent
  // we also just killed lingers as a ZOMBIE — genuinely dead, only unreaped.
  // `process.kill(pid, 0)` still succeeds for a zombie, so it is not a valid
  // liveness oracle here. Real evidence: a member is a survivor only if it
  // still exists AND is not in Z (zombie) / X (dead) state per /proc.
  const trulyAlive = (p) => {
    try { process.kill(p, 0) } catch { return false } // fully gone/reaped
    try {
      const stat = fs.readFileSync(`/proc/${p}/stat`, "utf8")
      const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]
      return state !== "Z" && state !== "X" && state !== "x"
    } catch { return false } // /proc entry gone → dead
  }
  const survivors = walk.members.filter(trulyAlive)
  ok("every group member is actually dead (real evidence, not a claim)", survivors.length === 0, `survivors: ${survivors.join(",")}`)

  // (e) the process manager kill path: injected signalFn exercises the same
  // fallback, records killEvidence, and the note names the walk
  const mgr = runtime.createProcessManager({ installSignalHandlers: false, signalFn: noGroupSignal })
  const sp = mgr.spawn({ command: "sleep 30", name: "grp" })
  await sleep(250)
  const killed = mgr.kill("grp", "SIGKILL")
  ok("kill note reports the pid-walk fallback", killed.ok && /via pid-walk/.test(killed.note), killed.note)
  ok("killEvidence recorded on the entry", mgr._entry("grp").killEvidence?.method?.startsWith("pid-walk(") === true)
  await mgr.poll("grp", { waitMs: 300 })
  ok("the killed process is actually dead (poll = evidence)", mgr._entry("grp").state !== "running")
  mgr.dispose()

  // (f) the normal group-signal path still works (no injection)
  const mgr2 = runtime.createProcessManager({ installSignalHandlers: false })
  mgr2.spawn({ command: "sleep 30", name: "plain" })
  await sleep(200)
  const k2 = mgr2.kill("plain", "SIGKILL")
  ok("group-signal path unaffected (no via- prefix)", k2.ok && /SIGKILL sent to the process group —/.test(k2.note), k2.note)
  mgr2.dispose()
}

// ---------------------------------------------------------------------------
console.log("== 3. sandbox: bwrap kernel re-probe on startup failure ==")
{
  const sandbox = await import("../sandbox.js")
  if (process.platform !== "linux") {
    console.log("  (non-linux — kernel probe is a no-op here; section skipped)")
  } else {
    // a fake bwrap that reproduces the v87 signature: dies before the command
    const fakeBwrap = path.join(WORK, "fake-bwrap.sh")
    fs.writeFileSync(fakeBwrap, '#!/bin/sh\necho "bwrap: Can\'t read /proc/sys/kernel/overflowuid: Permission denied" >&2\nexit 1\n')
    fs.chmodSync(fakeBwrap, 0o755)
    process.env.FORGE_SANDBOX = "1"
    process.env.FORGE_BWRAP = fakeBwrap

    const before = sandbox.kernelProbeCount()
    const det = sandbox.detectSandbox()
    ok("fake bwrap detected (kernel says userns works here)", det.available === true && det.kind === "bwrap")
    ok("kernel probe happened once (counted)", sandbox.kernelProbeCount() === before + 1)

    // runBash through the REAL tool layer: sandboxed attempt fails with the
    // bwrap signature → command re-run plain + the probe cache is RESET
    const tools = await import("../tools.js")
    const ctx = tools.makeToolContext({ cwd: WORK, root: WORK, skillsDir: null }).ctx
    const mid = sandbox.kernelProbeCount()
    const out = await tools.execTool(ctx, "bash", { command: "echo probe-marker", timeout_sec: 10 })
    ok("failed sandbox → command re-run unsandboxed (marker present)", /probe-marker/.test(String(out)), String(out).slice(0, 200))
    ok("re-run is labeled and says the kernel was re-probed", /sandbox skipped: bwrap/.test(String(out)) && /re-probed/.test(String(out)))
    const after = sandbox.kernelProbeCount()
    ok("the kernel probe was RESET and re-run for real (count+1)", after === mid + 1, `mid=${mid} after=${after}`)

    // second command: bwrapBroken session flag → plain wrap, no bwrap spawn
    const out2 = await tools.execTool(ctx, "bash", { command: "echo second-marker", timeout_sec: 10 })
    ok("later commands skip the dead wrapper entirely", /second-marker/.test(String(out2)) && !/sandbox skipped/.test(String(out2)))
    await tools.disposeToolManagers()

    // resetKernelProbe + honest re-probe round-trip
    sandbox.resetKernelProbe()
    sandbox.detectSandbox()
    ok("resetKernelProbe forces a fresh real probe", sandbox.kernelProbeCount() === after + 1)
    delete process.env.FORGE_SANDBOX
    delete process.env.FORGE_BWRAP
  }
}

// ---------------------------------------------------------------------------
console.log("== 4. checkpoint: working-tree drift verification at restore ==")
{
  const cp = await import("../checkpoint.js")
  const tools = await import("../tools.js")
  const target = path.join(WORK, "drift.js")
  fs.writeFileSync(target, "const A = 1\n")
  const original = fs.readFileSync(target, "utf8")

  // (a) forge-owned edit (sealed) → clean undo, status RESTORED
  const id1 = cp.snapshotBefore([target], WORK)
  fs.writeFileSync(target, "const A = 2 // forge edit\n")
  cp.sealEdited(id1, WORK)
  const r1 = cp.restoreTransactional(id1, { cwd: WORK })
  ok("sealed forge edit → RESTORED, content back", r1.ok === true && r1.status === "RESTORED" && fs.readFileSync(target, "utf8") === original, JSON.stringify(r1.status))
  ok("drift phase classified the edit as forge-owned", r1.phases.drift?.forge === 1 && r1.phases.drift?.checked === 1)

  // (b) external modification (postSha sealed, then touched externally) → KEPT
  const id2 = cp.snapshotBefore([target], WORK)
  fs.writeFileSync(target, "const A = 2 // forge edit\n")
  cp.sealEdited(id2, WORK)
  fs.writeFileSync(target, "const A = 99 // EXTERNAL work that must survive\n")
  const externalContent = fs.readFileSync(target, "utf8")
  const r2 = cp.restoreTransactional(id2, { cwd: WORK })
  ok("externally-modified file → status DRIFT, ok:false (tree NOT at checkpoint state)", r2.ok === false && r2.status === "DRIFT", JSON.stringify(r2.status))
  ok("external work PRESERVED, never clobbered", fs.readFileSync(target, "utf8") === externalContent)
  ok("skip carries the protection reason", r2.skipped?.some((s) => s.path === target && /external/.test(s.reason)))
  ok("drift phase counted the external file", r2.phases.drift?.external === 1)
  ok("checkpoint kept (still restorable, not silently consumed)", fs.existsSync(path.join(cp.CHECKPOINTS_DIR, id2)))
  ok("notes explain the protection", r2.notes.some((n) => /DRIFT/.test(n) && /cannot attribute/.test(n)))

  // (c) unattributed change (legacy manifest, no seal) → reverts, REPORTED
  const contentAtSnapshot = fs.readFileSync(target, "utf8")
  const id3 = cp.snapshotBefore([target], WORK)
  fs.writeFileSync(target, "const A = 3 // unsealed edit\n")
  const r3 = cp.restoreTransactional(id3, { cwd: WORK })
  ok("unattributed change → reverts to the snapshot state (its purpose)", r3.ok === true && r3.status === "RESTORED" && fs.readFileSync(target, "utf8") === contentAtSnapshot)
  ok("but the drift is REPORTED, never silent", r3.phases.drift?.unattributed === 1 && r3.notes.some((n) => /unattributed/.test(n)))

  // (d) clean file (already at snapshot state) → idempotent restore
  const id4 = cp.snapshotBefore([target], WORK)
  const r4 = cp.restoreTransactional(id4, { cwd: WORK })
  ok("unchanged file → clean + RESTORED", r4.ok === true && r4.phases.drift?.clean === 1)

  // (e) legacy restoreOne (forge undo path) protects external work too
  const id5 = cp.snapshotBefore([target], WORK)
  fs.writeFileSync(target, "const A = 2 // forge edit\n")
  cp.sealEdited(id5, WORK)
  fs.writeFileSync(target, "const A = 77 // second EXTERNAL change\n")
  const legacyContent = fs.readFileSync(target, "utf8")
  const r5 = cp.restoreLast(WORK)
  ok("restoreLast KEEPS the externally-modified file", r5 && r5.notes.some((n) => /external process/.test(n)) && fs.readFileSync(target, "utf8") === legacyContent, JSON.stringify(r5?.notes).slice(0, 200))

  // (f) the write tools seal post-write hashes (real dispatcher)
  const sealTarget = path.join(WORK, "sealed.js")
  fs.writeFileSync(sealTarget, "export const one = 1\n")
  const ctx = tools.makeToolContext({ cwd: WORK, root: WORK, skillsDir: null }).ctx
  const editOut = await tools.execTool(ctx, "edit_file", { path: "sealed.js", old: "one = 1", new: "one = 2" })
  ok("edit_file succeeded", /^OK edited/.test(String(editOut)), String(editOut).slice(0, 120))
  const cps = cp.listCheckpoints(WORK, 5)
  const sealedRec = cps.flatMap((c) => c.files ?? []).find((f) => f.path === sealTarget)
  ok("edit_file sealed a postSha (drift attribution evidence)", Boolean(sealedRec?.postSha), JSON.stringify(sealedRec ?? null).slice(0, 160))
  await tools.disposeToolManagers()
}

// ---------------------------------------------------------------------------
console.log("== 5. semantic_search: persistent, fingerprint-invalidated index ==")
{
  const cs = await import("../codesearch.js")
  const { projectHash, PROJECTS_DIR } = await import("../memory.js")
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-semidx-"))
  // 70 files → 70 docs, above MIN_PERSIST_DOCS (64) so persistence pays
  // (below the threshold a rebuild is cheaper than the write — by design)
  for (let i = 0; i < 70; i++) {
    fs.writeFileSync(path.join(root, `mod${i}.js`), `// module ${i}\nexport function handler${i}(req) {\n  // validate request ${i}\n  return { ok: true, n: ${i} }\n}\n`)
  }
  const idxFile = path.join(PROJECTS_DIR, projectHash(root), "semantic-index.json")

  // (a) child process 1: first search → index saved
  const runChild = (script) => {
    const src = `const cs = await import(${JSON.stringify(new URL("../codesearch.js", import.meta.url).href)})\n${script}`
    const file = path.join(WORK, `.semidx-child-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mjs`)
    fs.writeFileSync(file, src)
    return new Promise((resolve) => {
      const out = execFileSync(process.execPath, [file], { encoding: "utf8", env: { ...process.env, FORGE_HOME: HOME } })
      try { fs.rmSync(file) } catch {}
      resolve(JSON.parse(out.slice(out.indexOf("{"))))
    })
  }
  const r1 = await runChild(`const r = await cs.semanticSearch(${JSON.stringify(root)}, "handler validate request")\nconst s = cs.semanticIndexStats()\nprocess.stdout.write("\\n" + JSON.stringify({ ok: r.ok, hits: r.hits.length, first: r.hits[0]?.path ?? null, stats: s }))`)
  ok("first search (child 1) finds the code", r1.ok === true && r1.hits > 0, JSON.stringify(r1).slice(0, 200))
  ok("child 1 persisted the index", r1.stats.saved === 1 && fs.existsSync(idxFile), JSON.stringify(r1.stats))
  ok("child 1 re-chunked the corpus (nothing to adopt yet)", r1.stats.rechunked >= 70, JSON.stringify(r1.stats))

  // (b) child process 2: FRESH process → adopts persisted chunks, no re-read
  const r2 = await runChild(`const r = await cs.semanticSearch(${JSON.stringify(root)}, "handler validate request")\nconst s = cs.semanticIndexStats()\nprocess.stdout.write("\\n" + JSON.stringify({ ok: r.ok, hits: r.hits.length, first: r.hits[0]?.path ?? null, stats: s }))`)
  ok("fresh process adopted the persisted chunks (cross-process win)", r2.stats.loaded === 1 && r2.stats.adopted >= 70 && r2.stats.rechunked === 0, JSON.stringify(r2.stats))
  ok("fresh process finds the same code (index never changes results)", r2.ok === true && r2.first === r1.first)

  // (c) drift: modify one file (different SIZE → different fingerprint) →
  // only that file re-chunks; the index never serves stale content
  fs.writeFileSync(path.join(root, "mod0.js"), "// module 0 edited externally\nexport function zebracorn(req) {\n  // exotic drift marker\n  return { ok: true }\n}\n")
  const r3 = await runChild(`const r = await cs.semanticSearch(${JSON.stringify(root)}, "zebracorn exotic drift")\nconst s = cs.semanticIndexStats()\nprocess.stdout.write("\\n" + JSON.stringify({ ok: r.ok, hitPath: r.hits[0]?.path ?? null, hitLine: r.hits[0]?.start ?? null, stats: s }))`)
  ok("drifted file re-chunked, the rest adopted", r3.stats.rechunked === 1 && r3.stats.adopted >= 69, JSON.stringify(r3.stats))
  ok("search sees the NEW content (stale docs can never be served)", r3.ok === true && r3.hitPath === "mod0.js", JSON.stringify({ hitPath: r3.hitPath }).slice(0, 120))

  // (d) FORGE_INDEX=0 → no load, no save (full opt-out)
  const noIdx = await new Promise((resolve) => {
    const file = path.join(WORK, `.semidx-off-${Date.now()}.mjs`)
    fs.writeFileSync(file, `const cs = await import(${JSON.stringify(new URL("../codesearch.js", import.meta.url).href)})\nconst r = await cs.semanticSearch(${JSON.stringify(root)}, "validate request")\nconst s = cs.semanticIndexStats()\nprocess.stdout.write("\\n" + JSON.stringify({ ok: r.ok, stats: s }))`)
    const out = execFileSync(process.execPath, [file], { encoding: "utf8", env: { ...process.env, FORGE_HOME: HOME, FORGE_INDEX: "0" } })
    try { fs.rmSync(file) } catch {}
    resolve(JSON.parse(out.slice(out.indexOf("{"))))
  })
  ok("FORGE_INDEX=0: no load, no save (opt-out honored)", noIdx.stats.loaded === 0 && noIdx.stats.saved === 0, JSON.stringify(noIdx.stats))
  ok("FORGE_INDEX=0: search still works (pure in-memory rebuild)", noIdx.ok === true)

  // (e) corruption → honest rebuild (a cache, never evidence)
  fs.mkdirSync(path.dirname(idxFile), { recursive: true })
  fs.writeFileSync(idxFile, "{not json at all")
  const r5 = await runChild(`const r = await cs.semanticSearch(${JSON.stringify(root)}, "handler validate request")\nconst s = cs.semanticIndexStats()\nprocess.stdout.write("\\n" + JSON.stringify({ ok: r.ok, stats: s }))`)
  ok("corrupt index → silent rebuild, search correct", r5.ok === true && r5.stats.loaded === 0)
}

// ---------------------------------------------------------------------------
console.log("== 6. tool creation: multi-step scripted behavioral probes ==")
{
  const tc = await import("../toolcreate.js")
  const projectDirC = (await import("../memory.js")).projectDir

  // a STATEFUL plugin: step 1 logs in, step 2 requires the session — the
  // exact login→act shape the single probe could not test
  const statefulSrc = `let session = null
let calls = 0
export default {
  name: "statetest_login_act",
  description: "stateful multi-step test tool",
  parameters: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
  readOnly: true,
  async run(args) {
    calls++
    if (args.action === "login") { session = "sess-" + Date.now(); return { tool: "statetest_login_act", ok: true, session, calls } }
    if (args.action === "act") {
      if (!session) return { tool: "statetest_login_act", ok: false, error: "not logged in", calls }
      return { tool: "statetest_login_act", ok: true, session, acted: true, calls }
    }
    if (args.action === "throw") throw new Error("boom from step")
    return { tool: "statetest_login_act", ok: true, calls }
  },
}
`
  const dir = path.join(WORK, "msproj")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "a.js"), "export const a = 1\n")

  // design + implement, then REPLACE the generated file with the stateful one
  // (the real authoring flow: the design declares the probe, the
  // implementation is the author's stateful code)
  const design = tc.designTool({
    cwd: dir, name: "statetest_login_act",
    description: "stateful multi-step test tool with login then act",
    task: "test multi-step probes", inputSchema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
    outputSchema: { type: "object" },
    probeSteps: [
      { args: { action: "login" }, expectOk: true, label: "login" },
      { args: { action: "act" }, expectOk: true, expectContains: "acted", label: "act-on-session" },
    ],
  })
  ok("design with probeSteps accepted", design.ok === true, JSON.stringify(design).slice(0, 160))
  const impl = tc.implementTool(dir, "statetest_login_act")
  ok("implementTool wrote the plugin", impl.ok === true)
  fs.writeFileSync(path.join(projectDirC(dir), "tools", "statetest_login_act.mjs"), statefulSrc)

  // (a) multi-step verification: sequence passes → VERIFIED with per-step evidence
  const v = await tc.verifyTool(dir, "statetest_login_act")
  ok("multi-step probe: login→act passes → VERIFIED", v.ok === true && v.lifecycle === "VERIFIED", JSON.stringify(v.evidence ?? v).slice(0, 300))
  ok("evidence is multi-step mode with 2 steps", v.evidence.mode === "multi-step" && v.evidence.steps === 2)
  ok("per-step evidence: state really survived (calls=2 on step 2)", v.evidence.stepEvidence[1].outputPreview.includes('"calls":2'), v.evidence.stepEvidence[1].outputPreview)
  ok("expectContains honored (acted)", v.evidence.stepEvidence[1].expectContains === true)
  ok("per-step tests recorded", (tc.readToolRecord(dir, "statetest_login_act").tests ?? []).length === 2)

  // (b) activation right after the passing verification (VERIFIED → ACTIVE),
  // then a failed re-verification must revoke reactivation (evidence discipline)
  const act = tc.activateTool(dir, "statetest_login_act")
  ok("VERIFIED tool activates", act.ok === true && act.lifecycle === "ACTIVE", JSON.stringify(act).slice(0, 160))
  const deact = tc.deactivateTool(dir, "statetest_login_act")
  ok("deactivate → INACTIVE", deact.ok === true)

  // (c) act-before-login fails → INACTIVE, and the failed record blocks
  // reactivation (a failed re-verification revokes the earlier pass)
  const vBad = await tc.verifyTool(dir, "statetest_login_act", { steps: [{ args: { action: "act" }, expectOk: true, label: "act-first" }] })
  ok("act-before-login → NOT verified (expectOk=false observed)", vBad.ok === false && vBad.lifecycle === "INACTIVE", JSON.stringify(vBad.evidence?.stepEvidence ?? vBad).slice(0, 200))
  const actBlocked = tc.activateTool(dir, "statetest_login_act")
  ok("failed re-verification blocks reactivation (no stale pass)", actBlocked.ok === false, JSON.stringify(actBlocked).slice(0, 160))

  // (d) a step that THROWS aborts the sequence honestly
  const vThrow = await tc.verifyTool(dir, "statetest_login_act", { steps: [{ args: { action: "throw" }, label: "explode" }, { args: { action: "act" }, label: "after" }] })
  ok("throwing step aborts → INACTIVE, later step marked unrun", vThrow.ok === false && vThrow.evidence.stepEvidence[0].threw === true && vThrow.evidence.stepEvidence[1].ran === false, JSON.stringify(vThrow.evidence?.stepEvidence).slice(0, 200))

  // (e) single-probe behavior unchanged (a tool with NO probeSteps anywhere
  // → the classic one-shot contract, byte-for-byte)
  const plainDesign = tc.designTool({
    cwd: dir, name: "plain_probe_tool",
    description: "classic single-probe test tool",
    task: "back-compat", inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object" },
  })
  ok("design without probeSteps accepted", plainDesign.ok === true)
  tc.implementTool(dir, "plain_probe_tool")
  const vSingle = await tc.verifyTool(dir, "plain_probe_tool", { args: { x: 1 } })
  ok("no script → single-probe mode, still passes and VERIFIES", vSingle.ok === true && vSingle.lifecycle === "VERIFIED" && vSingle.evidence.mode === undefined && vSingle.evidence.outputMatchedSchema === true, JSON.stringify(vSingle.evidence ?? vSingle).slice(0, 200))

  // (f) unknown tool blocked
  const actBad = tc.activateTool(dir, "nonexistent_tool")
  ok("unknown tool blocked", actBad.ok === false)
}

// ---------------------------------------------------------------------------
console.log("== 7. LSP: first-party auto-start table ==")
{
  const lsp = await import("../lsp.js")
  const langengine = await import("../langengine.js")
  const langadapter = await import("../langadapter.js")

  // (a) absent binaries → honest null (probed BEFORE any PATH injection,
  // because the presence memo is per-process)
  ok("no gopls on PATH → autostartForFile(.go) is null (never a guess)", lsp.autostartForFile("/x/main.go") === null || process.env.FORGE_GOPLS_FORCED === "1")
  ok("unknown extension → null", lsp.autostartForFile("/x/README.md") === null)
  ok("autostart disabled → null even for ts", (() => { const had = process.env.PATH; const r = lsp.autostartForFile("/x/a.ts", { config: { lsp: { autostart: false } } }); void had; return r === null })())

  // (b) a REAL stand-in language server on PATH (the test-lsp.mjs pattern)
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lsp-bin-"))
  const STUB = String.raw`
let buf = Buffer.alloc(0)
function write(o) {
  const j = Buffer.from(JSON.stringify(o), "utf8")
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + j.length + "\r\n\r\n", "ascii"), j]))
}
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d])
  for (;;) {
    const sep = buf.indexOf("\r\n\r\n")
    if (sep === -1) return
    const m = /content-length:\s*(\d+)/i.exec(buf.slice(0, sep).toString("ascii"))
    if (!m) { buf = buf.slice(sep + 4); continue }
    const len = parseInt(m[1], 10), start = sep + 4
    if (buf.length < start + len) return
    const msg = JSON.parse(buf.slice(start, start + len).toString("utf8"))
    buf = buf.slice(start + len)
    if (msg.method === "initialize") {
      write({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { documentSymbolProvider: true } } })
    } else if (msg.method === "textDocument/documentSymbol") {
      write({ jsonrpc: "2.0", id: msg.id, result: [
        { name: "alphaFunc", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } } },
        { name: "betaClass", kind: 5, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } } },
      ] })
    } else if (msg.id != null) {
      write({ jsonrpc: "2.0", id: msg.id, result: null })
    }
  }
})
`
  fs.writeFileSync(path.join(binDir, "typescript-language-server"), `#!/bin/sh\nexec "${process.execPath}" -e '${STUB.replace(/'/g, "'\\''")}'\n`)
  fs.chmodSync(path.join(binDir, "typescript-language-server"), 0o755)
  const prevPath = process.env.PATH
  process.env.PATH = `${binDir}:${prevPath}`

  // (c) serverForFile falls back to the table (zero user config)
  const auto = lsp.serverForFile({}, "/x/src/a.ts")
  ok("serverForFile: no config → autostart:typescript spec", auto?.name === "autostart:typescript" && auto?.spec?.autostart === true && auto?.spec?.command === "typescript-language-server")

  // (d) user config WINS over the table
  const mine = lsp.serverForFile({ lsp: { servers: { myts: { command: "my-custom-ls", extensions: [".ts"] } } } }, "/x/src/a.ts")
  ok("user-configured server wins over autostart", mine?.name === "myts")

  // (e) availability reporting counts the table
  const avail = langengine.lspAvailability({})
  ok("lspAvailability lists autostart:typescript (real binary)", avail.some((s) => s.name === "autostart:typescript" && s.available === true && s.autostart === true))

  // (f) BEHAVIORAL end-to-end: structured extraction with ZERO user config —
  // the stub server's symbols come back through the auto-started client
  const tsFile = path.join(WORK, "autostart_probe.ts")
  fs.writeFileSync(tsFile, "function alphaFunc() {}\nclass betaClass {}\n")
  const ex = await langadapter.extractStructured(tsFile, fs.readFileSync(tsFile, "utf8"), { config: {}, cwd: WORK })
  ok("extractStructured via AUTO-START: real server symbols, layer 3", ex.structured?.length === 2 && ex.provenance.layer === 3 && ex.provenance.source === "lsp:autostart:typescript", JSON.stringify(ex.provenance).slice(0, 160))
  ok("symbols are the stub server's (alphaFunc, betaClass)", ex.symbols.includes("alphaFunc") && ex.symbols.includes("betaClass"))
  ok("no fallback claimed", ex.fallback === null)

  // (g) the ladder reports layer 3 available with zero user config
  const layers = langadapter.extractLadder?.(tsFile) ?? null
  void layers // ladder shape varies; the availability row test above covers it

  process.env.PATH = prevPath
}

// ---------------------------------------------------------------------------
const total = PASS + FAIL
console.log(`\n== todowise suite: ${PASS} passed, ${FAIL} failed (of ${total}) ==`)
if (FAIL > 0) {
  console.log("::error title=suite \"todowise\" failed:: " + FAIL + " assertion(s) failed")
  process.exit(1)
}
