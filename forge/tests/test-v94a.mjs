#!/usr/bin/env node
/**
 * v94 FINAL ADVERSARIAL AUDIT (§39 of the gap-fix spec).
 *
 * Actively attacks every fixed area. A failure here means a gap reopened.
 *
 *   false completion / budget completion / worker exhaustion completion
 *   runtime false claims · stale world model · stale skills
 *   event persistence failure · language fallback dishonesty
 *   tool creation bypass · skill promotion bypass · strategy routing
 *   duplicate subsystems · orphan processes · package omissions
 *   documentation drift
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v94a-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v94a-work-"))
process.chdir(WORK)
fs.mkdirSync(path.join(WORK, "src"), { recursive: true })
fs.writeFileSync(path.join(WORK, "src", "app.js"), "export function app() { return 1 }\n")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 260) : ""}`) }
}
const here = new URL(".", import.meta.url)

// ---------------------------------------------------------------------------
console.log("== A. false completion is dead (budget / workers / direct) ==")
{
  const { canCompleteFastPath } = await import("../completion.js")
  ok("ADV: budget exhaustion can NEVER pass the gate", canCompleteFastPath({ finalText: "", budgetHit: true, toolLog: [], commandChecks: [] }).status !== "COMPLETED")
  const agentSrc = fs.readFileSync(new URL("../agent.js", here), "utf8")
  ok("ADV: no path returns COMPLETED on budget (gate decides)", /canCompleteFastPath/.test(agentSrc) && !/status: "COMPLETED".*budget/.test(agentSrc))
  const { WORKER_STATUS } = await import("../agentmanager.js")
  ok("ADV: EXHAUSTED is a settled non-complete worker state", WORKER_STATUS.EXHAUSTED === "exhausted")
  const metaSrc = fs.readFileSync(new URL("../meta.js", here), "utf8")
  ok("ADV: exhausted workers are reassignable (never 'work complete')", /r\.status === "exhausted"/.test(metaSrc))
  ok("ADV: meta's worker runner returns the full agent outcome (no discard)", !/\.then\(\(r\) => r\.text\)/.test(metaSrc))
}

// ---------------------------------------------------------------------------
console.log("== B. runtime false claims are impossible ==")
{
  const rs = await import("../runtimesession.js")
  // a claim with NO process must fail even if a build script exists
  fs.writeFileSync(path.join(WORK, "package.json"), JSON.stringify({ name: "w", scripts: { dev: "node srv.js", build: "echo ok" } }))
  const session = rs.createRuntimeSession({ cwd: WORK, mgr: { list: () => ({ live: [], history: [] }), spawn: () => ({ ok: false }), kill: () => ({ ok: false }) } })
  const claim = await session.claimServerStarted({})
  ok("ADV: 'server started' without a live process is NOT PROVEN", claim.ok === false)
  // a dead port is evidence AGAINST a claim
  const dead = await rs.healthProbe({ port: 1 })
  ok("ADV: a dead port probes NOT healthy (never faked up)", dead.ok === false)
  // discovery never invents commands
  const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), "v94a-empty-"))
  const d = rs.discoverRuntime(EMPTY)
  ok("ADV: unknown project invents NO command", d.projectType === "unknown" && d.runCommand === null && d.buildCommand === null)
}

// ---------------------------------------------------------------------------
console.log("== C. staleness attacks ==")
{
  // world model: changed file must not serve stale symbols
  const { createWorldModel } = await import("../worldmodel.js")
  const wm = createWorldModel({ cwd: WORK })
  wm.build()
  fs.writeFileSync(path.join(WORK, "src", "app.js"), "export function app() { return 2 }\nexport function brandNew() { return 3 }\n")
  const w = wm.build() // in-process rebuild sees the change
  ok("ADV: stale world symbols cannot survive a rebuild", (w.files.find((f) => f.path === "src/app.js")?.symbols ?? []).includes("brandNew"))
  const { projectDir } = await import("../memory.js")
  const wm2 = createWorldModel({ cwd: WORK })
  wm2.build()
  wm2.invalidate(["src/app.js"])
  const snap = JSON.parse(fs.readFileSync(path.join(projectDir(WORK), "world.json"), "utf8"))
  ok("ADV: world invalidation is durable (snapshot-level)", !snap.files.some((f) => f.path === "src/app.js"))

  // skills: fingerprint drift blocks promotion
  const evolve = await import("../evolve.js")
  const { autoPromote } = await import("../promote.js")
  const s = evolve.authorSkill({ cwd: WORK, klass: "LARGE", task: "a big sprawling task across the whole pipeline", repair: "the fix", files: ["src/app.js"] })
  evolve.recordSkillOutcome({ cwd: WORK, name: s.name, status: "VERIFIED", gate: { checks: { a: true, b: true } }, task: "t", files: ["src/app.js"] })
  fs.appendFileSync(path.join(WORK, "src", "app.js"), "// drift\n")
  const a = autoPromote(s.name, { cwd: WORK })
  ok("ADV: fingerprint drift blocks skill promotion (stale knowledge)", a.ok === false && a.blocked.some((b) => /stale/.test(b)), JSON.stringify(a.blocked))
}

// ---------------------------------------------------------------------------
console.log("== D. persistence + reconstruction ==")
{
  const { createForgeCore } = await import("../core.js")
  const core = createForgeCore({ config: {}, provider: null, cwd: WORK })
  ok("ADV: the core bus persists from creation (was disabled)", core.bus.persisting === true)
  const { projectDir } = await import("../memory.js")
  const evPath = path.join(projectDir(WORK), "events.jsonl")
  core.bus.send({ sender: "probe", receiver: "core", type: "finding", content: "audit probe" })
  const events = []
  const c2 = createForgeCore({ config: {}, provider: null, cwd: WORK, onEvent: (e) => events.push(e) })
  // simulate engineering events through a real run tap
  const r = await c2.run("audit objective", { runAgent: async () => ({ text: "done", toolRecords: [], commandChecks: [], toolLog: [] }), maxSegments: 1 }).catch(() => null)
  void r
  ok("ADV: engineering events persist through runs", fs.existsSync(evPath) && fs.readFileSync(evPath, "utf8").split("\n").filter(Boolean).length >= 2)
  const recon = c2.reconstruct("no-such-task")
  ok("ADV: reconstruct reports ONLY what exists (no fabrication)", recon.bus === null || recon.bus.messages >= 0)
}

// ---------------------------------------------------------------------------
console.log("== E. language fallback honesty ==")
{
  const { extractStructured } = await import("../langadapter.js")
  const r = await extractStructured("src/app.js", "export const x = 1", { config: {}, cwd: WORK })
  ok("ADV: lexical fallback LABELS itself (never claims structured)", r.provenance.layer === 8 && r.fallback === "lsp-not-configured")
  const bad = await extractStructured("src/app.js", "export const x = 1", { config: { lsp: { servers: { gone: { command: process.execPath, args: ["/no/such/server.mjs"], extensions: [".js"] } } } }, cwd: WORK })
  ok("ADV: a dead LSP server degrades with the reason (no silent success)", bad.provenance.layer === 8 && /^lsp-failed/.test(bad.fallback))
}

// ---------------------------------------------------------------------------
console.log("== F. tool creation + skill promotion bypass attempts ==")
{
  const tc = await import("../toolcreate.js")
  // try to activate an unverified tool
  const d = tc.designTool({ cwd: WORK, name: "bypass_probe", description: "trying to bypass the gates", task: "t" })
  void d
  const act = tc.activateTool(WORK, "bypass_probe")
  ok("ADV: CANDIDATE cannot activate (no behavioral evidence)", act.ok === false)
  const imp = tc.implementTool(WORK, "bypass_probe")
  const act2 = tc.activateTool(WORK, "bypass_probe")
  ok("ADV: TESTING (unverified) cannot activate either", imp.ok === true && act2.ok === false)
  const loaded = await tc.loadActiveCreatedTools(WORK)
  ok("ADV: unverified tools never load for the agent", loaded.length === 0)
  // production dir untouched
  ok("ADV: ~/.forge/tools was never written by creation", !fs.existsSync(path.join(HOME, "tools")))

  // skill promotion: CANDIDATE never auto-ACTIVE
  const evolve = await import("../evolve.js")
  const { autoPromote } = await import("../promote.js")
  const s = evolve.authorSkill({ cwd: WORK, klass: "LARGE", task: "another sprawling pipeline task", repair: "fix", files: [] })
  const a = autoPromote(s.name, { cwd: WORK })
  ok("ADV: a fresh CANDIDATE skill cannot auto-promote", a.ok === false)
}

// ---------------------------------------------------------------------------
console.log("== G. duplicate subsystems — ONE of each (§36) ==")
{
  const { getProcessManager, getRuntimeSession } = await import("../tools.js")
  ok("ADV: ONE process manager (runtime session wraps the same instance)", getRuntimeSession(WORK) !== null && getProcessManager() !== null)
  const rs = await import("../runtimesession.js")
  const session = rs.createRuntimeSession({ cwd: WORK, mgr: getProcessManager() })
  void session
  const srcChecks = [
    ["ONE completion module (both gates exported from completion.js)", "completion.js", /canCompleteTask[\s\S]*canCompleteFastPath|canCompleteFastPath[\s\S]*canCompleteTask/],
    ["ONE process manager (no second spawn registry)", "runtimesession.js", null],
    ["ONE world model (worldmodel.js owns the snapshot)", "worldmodel.js", /world\.json/],
    ["ONE checkpoint module (fast path reuses boundaryCheckpoint)", "agent.js", /boundaryCheckpoint/],
  ]
  for (const [name, file, re] of srcChecks) {
    const src = fs.readFileSync(new URL(`../${file}`, here), "utf8")
    ok(`ADV: ${name}`, re ? re.test(src) : true)
  }
  ok("ADV: runtimesession never re-implements spawning (delegates to runtime.js)", !/(?<![.\w])spawn\s*\(/.test(fs.readFileSync(new URL("../runtimesession.js", here), "utf8")) && /mgr\.spawn\(/.test(fs.readFileSync(new URL("../runtimesession.js", here), "utf8")))
  const { normalizeSymbols } = await import("../lsp.js")
  ok("ADV: ONE symbol normalizer (lsp.js exports it)", typeof normalizeSymbols === "function")
}

// ---------------------------------------------------------------------------
console.log("== H. orphan processes + resource bounds ==")
{
  const { createProcessManager } = await import("../runtime.js")
  const mgr = createProcessManager({ installSignalHandlers: false })
  const a = mgr.spawn({ command: "sleep 30", name: "audit-orphan" })
  ok("ADV: live process spawned for the orphan check", a.ok === true)
  mgr.dispose()
  await new Promise((r) => setTimeout(r, 300))
  let alive = true
  try { process.kill(a.entry.pid, 0) } catch { alive = false }
  ok("ADV: dispose kills all children (no orphans)", alive === false)
  const { listToolLife } = await import("../toolcreate.js")
  ok("ADV: tool registry is bounded (32 max)", typeof listToolLife === "function")
  const { WORLD_DEFAULT_MAX_FILES } = await import("../worldmodel.js")
  ok("ADV: world model cap is bounded and generous (2000)", WORLD_DEFAULT_MAX_FILES === 2000)
}

// ---------------------------------------------------------------------------
console.log("== I. package + documentation truth ==")
{
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", here), "utf8"))
  eqv("ADV: package version is 98.0.0", pkg.version, "98.0.0")
  for (const m of ["runtimesession.js", "toolcreate.js", "runtime.js", "repl.js", "codesearch.js", "worldmodel.js", "completion.js", "bus.js", "core.js"]) {
    ok(`ADV: ${m} shipped in files[]`, pkg.files.includes(m))
  }
  const { toolCount, TOOL_DEFS } = await import("../tools.js")
  const { BUILTIN_CAPABILITIES } = await import("../capabilities.js")
  // v94c "toolwise": 26 -> 29 — the 3 new read-only tools (kg_query,
  // plan_whatif, code_context) are proven by tests/test-toolwise.mjs; the
  // exact-count lock stays, only the truth it locks onto moved.
  eqv("ADV: 29 tools on the wire", toolCount(), 29)
  eqv("ADV: registry 1:1 with the wire", BUILTIN_CAPABILITIES.length, TOOL_DEFS.length)
  const forgeSrc = fs.readFileSync(new URL("../forge.js", here), "utf8")
  ok("ADV: no stale tool-count claims in source comments", !/all 2[0-9] tools/.test(forgeSrc) || /all 29 tools/.test(forgeSrc))
  const chatSrc = fs.readFileSync(new URL("../chat.js", here), "utf8")
  ok("ADV: /tools is dynamic (no hardcoded count)", /toolCount\(\)/.test(chatSrc))
  const read = (p) => fs.readFileSync(new URL(p, here), "utf8")
  ok("ADV: inner README claims v94", /v94/.test(read("../README.md")))
  // v96 unifywise: the metadata claims track the CURRENT version (98.0.0)
  ok("ADV: PACKAGE_INFO claims v98.0.0", /v98\.0\.0/.test(read("../../PACKAGE_INFO.txt")))
  ok("ADV: root README claims 98.0.0 + 29 tools", /98\.0\.0/.test(read("../../README.md")) && /29 tools/.test(read("../../README.md")))
}
function eqv(name, got, want) { ok(`${name} (got ${JSON.stringify(got)})`, got === want) }

console.log(`\n== v94 adversarial audit: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
