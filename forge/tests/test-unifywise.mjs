#!/usr/bin/env node
/**
 * forge — unifywise acceptance (v96).
 *
 * The upgrade thesis: v95 already IMPLEMENTED nearly everything — what it
 * lacked was WIRING. Intelligence was computed and then ignored; subsystems
 * held state the loop never read; two copies of one truth drifted apart.
 * This suite pins every reconnected wire:
 *
 *   §1  engmemory retrieval — task/conversation relevance bonuses FIRE now
 *   §2  taskstate.noteRepair — repairs visible in resource_usage
 *   §3  execresult — external SIGTERM is KILLED, ETIMEDOUT is TIMEOUT
 *   §4  worldmodel — recentChanges answers from the index (no wasted build),
 *       empty incremental worlds are honestly degraded
 *   §5  context engine — budget overflow is REPORTED, not silent
 *   §6  episodes — durable atomic store (securefs), stage recorders exist
 *   §7  decisionengine.reload — a second engine instance sees new asks
 *   §8  crewroute.record — read-modify-write on the file (no lost updates)
 *   §9  dag — "trivial" joins the node-risk vocabulary (one ladder)
 *   §10 completion — requirement coverage: UNADDRESSED/IMPLEMENTED/TESTED
 *   §11 compose — the justified strategy pick reaches formatCompose
 *   §12 core — EVENT_PHASE matches meta's REAL vocabulary; every phase is
 *       reachable; nextBestAction is the read-only §24 surface
 *   §13 meta — emits TASK_RESUMED + REPAIR_COMPLETED; empirics + variant
 *       outcomes have production writers; infogain experiments reach
 *       segment-1 context; taskmodel is fed; requirement coverage blocks
 *       the gate; environment drift is checked
 *   §14 chat — a resumed task ALWAYS goes through the controller
 *   §15 agentmanager — the structured handoff reaches the successor; runMany
 *       maxParallel is a REAL gate
 *   §16 mcp — lazy connect: cold cache behaves eager, warm cache defers the
 *       spawn to the first call, vanished tools are honest errors
 *   §17 lsp — collectDiagnosticsForFiles keep the pinned default and gain
 *       allowAutostart for the meta verification path
 *   §18 hardShrink — ONE implementation in compaction.js (no duplicates)
 *   §19 dead code removed — formatStrategy, reportConflict import, void fs
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-unify-home-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond, extra) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-unify-work-"))
process.chdir(work)

console.log("== 1. engmemory retrieval relevance bonuses fire ==")
{
  const { createEngMemory } = await import("../engmemory.js")
  const em = createEngMemory({ cwd: work, taskId: "task-A", runId: "run-A", conversationId: "conv-A" })
  em.recordMemory({ text: "the auth middleware lives in src/auth.ts and validates bearer tokens", layer: "EVIDENCE", status: "FACT", source: "tool", evidenceRef: { kind: "test" }, files: ["src/auth.ts"] })
  const r = em.retrieve({ query: "auth middleware bearer tokens", limit: 6 })
  ok("record retrievable", r.length >= 1, JSON.stringify(r.map((x) => x.text.slice(0, 40))))
  // the ranking factor unit: candidates now carry taskId/conversationId
  const src = fs.readFileSync(new URL("../engmemory.js", import.meta.url), "utf8")
  ok("candidates carry taskId + conversationId (the +0.4/+0.15 factors can fire)", src.includes("taskId: r.taskId ?? null, conversationId: r.conversationId ?? null"))
}

console.log("== 2. taskstate.noteRepair writes resource_usage.repairs ==")
{
  const { openTask } = await import("../taskstate.js")
  const ts = openTask("task-rep-" + Date.now().toString(36), { create: true, objective: "x", cwd: work })
  ts.noteRepair(1)
  ts.noteRepair(1)
  const rec = ts.record
  eq("repair_count is 2", rec.repair_count, 2)
  eq("resource_usage.repairs mirrors it (was: retry_count copy-paste)", rec.resource_usage.repairs, 2)
}

console.log("== 3. execresult: external SIGTERM ≠ timeout ==")
{
  const { classifySpawn, EXEC_STATUS } = await import("../execresult.js")
  const ext = classifySpawn({ stdout: "", stderr: "", status: null, signal: "SIGTERM" }, { cmd: "x" })
  ok("external SIGTERM → KILLED (someone ended it, it did not time out)", ext.status === EXEC_STATUS.KILLED && ext.killed === true && ext.timedOut === false, JSON.stringify(ext.status))
  const to = classifySpawn({ stdout: "", stderr: "", status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } }, { cmd: "x" })
  ok("runCommand's own timeout (ETIMEDOUT+SIGTERM) → TIMEOUT", to.status === EXEC_STATUS.TIMEOUT && to.timedOut === true)
  const k9 = classifySpawn({ stdout: "", stderr: "", status: null, signal: "SIGKILL" }, { cmd: "x" })
  ok("SIGKILL stays KILLED", k9.status === EXEC_STATUS.KILLED)
}

console.log("== 4. worldmodel honesty ==")
{
  const src = fs.readFileSync(new URL("../worldmodel.js", import.meta.url), "utf8")
  ok("recentChanges no longer builds-then-discards the world", !/const w = build\(\)\s*\n\s*void w/.test(src))
  ok("incremental empty worlds are degraded on every path", src.includes("w.degraded = !w.files.length // v96 unifywise"))
}

console.log("== 5. context budget overflow is reported ==")
{
  const { createContextEngine } = await import("../context.js")
  // a real big file so the FIRST kept section (files) alone exceeds a tiny budget
  const big = path.join(work, "big.txt")
  fs.writeFileSync(big, "profile line with lots of tokens ".repeat(120))
  const ctx = createContextEngine({ cwd: work, config: {} })
  const built = ctx.build("task", { budgetTokens: 50, includeProfile: false, includeRepoMap: false, includeMemory: false, includeLessons: false, includeSkills: false, includeLang: false, includeEngine: false, includeCompose: false, extraFiles: [big] })
  ok("a first section that alone exceeds the budget sets budgetOverflow", built.budgetOverflow === true, JSON.stringify({ tokens: built.tokens }))
  const small = ctx.build("task", { budgetTokens: 2400 })
  ok("a normal build sets no overflow flag", small.budgetOverflow !== true)
}

console.log("== 6. episodes: durable store + stage recorders ==")
{
  const { createEpisodeStore } = await import("../episodes.js")
  const store = createEpisodeStore({ cwd: work })
  const ep = store.start({ problem: "p", context: "c" })
  store.addHypothesis(ep, "H1: stale lock", { status: "open" })
  store.addExperiment(ep, { command: "rm lock", result: "pass", ok: true })
  store.addFailedApproach(ep, "re-run the same command")
  store.addVerification(ep, { command: "npm test", ok: true })
  store.addFix(ep, "removed lockfile")
  store.persist()
  const raw = JSON.parse(fs.readFileSync(path.join(HOME, "projects", fs.readdirSync(path.join(HOME, "projects")).find((d) => fs.statSync(path.join(HOME, "projects", d)).isDirectory()), "episodes.json"), "utf8"))
  const saved = raw.episodes.find((e) => e.id === ep.id)
  ok("episode persists with hypotheses/experiments/fixes", saved.hypotheses.length === 1 && saved.experiments.length === 1 && saved.fixes.length === 1)
  ok("failed approaches survive", saved.failed_approaches.length === 1)
  const st = fs.statSync(path.join(HOME, "projects", fs.readdirSync(path.join(HOME, "projects")).find((d) => fs.statSync(path.join(HOME, "projects", d)).isDirectory()), "episodes.json"))
  ok("episodes.json is written 0600 via securefs (atomic pipeline)", (st.mode & 0o777) === 0o600, st.mode.toString(8))
}

console.log("== 7. decisionengine.reload ==")
{
  const { createDecisionEngine } = await import("../decisionengine.js")
  const a = createDecisionEngine({ cwd: work })
  const b = createDecisionEngine({ cwd: work })
  a.ask({ type: "DECISION", title: "engine A asks", question: "q?", options: [{ id: "x", label: "X" }] })
  eq("engine B (stale copy) sees 0 pending before reload", b.pendingList().length, 0)
  eq("engine B.reload() re-reads the shared askings.json", b.reload() >= 1, true)
  ok("engine B now sees engine A's pending decision", b.pendingList().length === 1)
}

console.log("== 8. crewroute.record reload-before-write (no lost update) ==")
{
  const { createCrewRouter } = await import("../crewroute.js")
  const a = createCrewRouter({ cwd: work })
  const b = createCrewRouter({ cwd: work })
  a.record({ klass: "MEDIUM", role: "researcher", model: "m-a", ok: true, verified: true })
  b.record({ klass: "MEDIUM", role: "researcher", model: "m-b", ok: true, verified: true }) // second instance, STALE in-memory copy
  a.record({ klass: "MEDIUM", role: "researcher", model: "m-c", ok: true, verified: true }) // writes again from the FIRST copy
  const fresh = createCrewRouter({ cwd: work })
  const stats = fresh.stats()
  ok("all three outcomes survive the interleaved writes (was: lost update)", stats.length === 3, JSON.stringify(stats.map((s) => s.key)))
}

console.log("== 9. dag: trivial joins the risk vocabulary ==")
{
  const dag = await import("../dag.js")
  ok("RISK_LEVELS includes trivial (one ladder with plannerisk/verifyledger)", dag.RISK_LEVELS[0] === "trivial" && dag.RISK_LEVELS.includes("low"))
  const g = dag.buildDAG([{ id: "n1", objective: "fix typo in readme", dependencies: [], risk: "trivial", read_only: false }])
  eq("a trivial-risk node keeps its risk (was: coerced to low)", g.nodes.get("n1").risk, "trivial")
  eq("trivial default verification stays syntax-only", dag.defaultVerificationFor({ risk: "trivial", read_only: false }), ["syntax"])
  const v = dag.validatePlan([{ id: "n1", objective: "x", dependencies: [], risk: "trivial", read_only: false, verificationRequirements: ["syntax"] }])
  ok("validatePlan accepts trivial risk (with declared verification)", v.ok === true, JSON.stringify(v.errors))
}

console.log("== 10. completion: requirement coverage ==")
{
  const { requirementCoverage, canCompleteTask, CHECK } = await import("../completion.js")
  const reqs = [
    { id: "R1", text: "1. The API must return JSON errors", files: ["src/api.js"] },
    { id: "R2", text: "2. Never log credentials", files: [] },
    { id: "R3", text: "3. Add a retry counter to the uploader", files: ["src/upload.js"] },
  ]
  const cov = requirementCoverage(reqs, {
    nodeObjectives: ["implement JSON error responses in the api module", "unrelated work"],
    changedFiles: ["src/upload.js"],
    verificationEvidence: ["api returns json errors — 200 exit npm test"],
  })
  const byId = Object.fromEntries(cov.requirements.map((r) => [r.id, r]))
  eq("R1 TESTED (objective + evidence mention)", byId.R1.status, "TESTED")
  eq("R2 UNADDRESSED (nothing references it)", byId.R2.status, "UNADDRESSED")
  eq("R3 IMPLEMENTED (changed file hit)", byId.R3.status, "IMPLEMENTED")
  eq("coverage summary", { total: cov.total, covered: cov.covered }, { total: 3, covered: 2 })
  ok("uncovered requirement blocks ok", cov.ok === false)
  // and the gate blocks through pendingRequiredActions (the house pattern)
  const gate = canCompleteTask({
    planValid: true, dag: { nodes: [{ id: "n1", status: "completed", dependencies: [] }], order: ["n1"] }, dagValid: true,
    workersSettled: true, verification: { ok: true, missing: [], anyFailure: false }, verificationRequired: false,
    recovery: null,
    pendingRequiredActions: cov.uncovered.map((u) => `requirement ${u.id} not addressed`),
  })
  ok("an unaddressed requirement blocks COMPLETED via required actions", gate.ok === false && gate.blockers.some((b) => b.check === CHECK.NO_PENDING_REQUIRED_ACTIONS))
}

console.log("== 11. compose: strategyJustified reaches the prompt block ==")
{
  const { formatCompose } = await import("../compose.js")
  const block = formatCompose({ klass: "MEDIUM", world: null, strategyJustified: "STRATEGY: x — 67% ok over 3 samples; LOW SAMPLES" })
  ok("formatCompose renders the justified strategy line (was computed-then-ignored)", block.includes("STRATEGY: x"), block.slice(0, 120))
  const { emptyCompose } = await import("../compose.js")
  const e = emptyCompose("MICRO")
  ok("emptyCompose has the strategy/models/variants/knowtype defaults (no holes)", Array.isArray(e.strategy) && e.strategyJustified === "" && Array.isArray(e.models) && Array.isArray(e.variants) && Array.isArray(e.knowtype))
}

console.log("== 12. core: phase vocabulary + nextBestAction ==")
{
  const core = await import("../core.js")
  const src = fs.readFileSync(new URL("../core.js", import.meta.url), "utf8")
  // source-level: every phase in CORE_PHASES must have at least one event mapping
  const phasesCovered = new Set()
  for (const m of src.matchAll(/^\s{2}([A-Z_]+):\s+"([A-Z_]+)",/gm)) phasesCovered.add(m[2])
  const missing = core.CORE_PHASES.filter((p) => !phasesCovered.has(p))
  eq("every lifecycle phase is reachable from a real event mapping", missing, [])
  // v128: this read
  //   A && B === true || src.includes("VERIFICATION_PASSED")
  // and `===` binds tighter than `&&`, which binds tighter than `||`, so the
  // trailing clause short-circuited the whole assertion. core.js contains
  // "VERIFICATION_PASSED" (it is a live event name), so this passed even with
  // the dead vocabulary put back — proven by re-inserting it. Both halves of
  // the real property are true today, so stating them plainly costs nothing.
  ok("no dead vocabulary: TASK_CREATED entry is gone", !src.includes("TASK_CREATED:"))
  ok("no dead vocabulary: VERIFY_PASSED entry is gone", !src.includes('VERIFY_PASSED: "VERIFY"'))
  ok("…and the live verification event it was replaced by is present", src.includes("VERIFICATION_PASSED"))
  // behavior: nextBestAction on an idle core (fresh project dir — §7 asked a
  // decision in `work`, and nextBestAction correctly reports that one)
  const idleDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-unify-idle-"))
  const c = core.createForgeCore({ config: {}, cwd: idleDir })
  const nba = c.nextBestAction()
  ok("idle core → await_instruction", nba.action === "await_instruction" && typeof nba.why === "string")
  const st = c.status()
  ok("status() exposes nextBestAction (the §24 inspectable surface)", st.nextBestAction && typeof st.nextBestAction.action === "string")
  ok("conflict resolution consults the world model (no more world:()=>null)", src.includes("resolveConflict(c, { world: (claim) =>"))
}

console.log("== 13. meta wiring (source contract) ==")
{
  const metaSrc = fs.readFileSync(new URL("../meta.js", import.meta.url), "utf8")
  ok("resume emits TASK_RESUMED after recovery", metaSrc.includes('"TASK_RESUMED"'))
  ok("repairSegment emits REPAIR_COMPLETED", metaSrc.includes('"REPAIR_COMPLETED"'))
  ok("empirics has a production writer (model-outcomes.json fills in real runs)", metaSrc.includes("recordModelOutcome"))
  ok("variant outcomes have a production writer", metaSrc.includes("recordVariantOutcome"))
  ok("infogain experiments ride segment-1 context", metaSrc.includes("planInfogain") && metaSrc.includes("pre-execution information-gain experiments"))
  ok("taskmodel is fed from the plan (assumptions tagged)", metaSrc.includes("TASKMODEL_FED") && metaSrc.includes('tag: "ASSUMPTION"'))
  ok("requirement coverage runs at the completion gate", metaSrc.includes("requirementCoverage(reqs"))
  ok("episode sink threads hypotheses/experiments/verification", metaSrc.includes("episodeSink.addHypothesis") && metaSrc.includes("episodeSink.addVerification") && metaSrc.includes("episodeSink.addExperiment"))
  ok("the environment check runs at task start", metaSrc.includes("checkEnvironment("))
  ok("LSP verification passes allowAutostart (default-language diagnostics)", metaSrc.includes("allowAutostart: true"))
}

console.log("== 14. chat: resume always goes through the controller ==")
{
  const chatSrc = fs.readFileSync(new URL("../chat.js", import.meta.url), "utf8")
  ok("useController decides the loop (resume still forces the controller)", chatSrc.includes("useController({ planOnly, resumeTaskId, autonomous: config?.agent?.autonomous })"))
  ok("TTY no longer has a private one-shot exemption", !chatSrc.includes("autonomous !== false && !ui"))
  ok("TTY controller runs render through printResult", chatSrc.includes("ui.view.printResult(res, { elapsedMs: Date.now() - t0, planOnly })"))
}

console.log("== 15. agentmanager: handoff context + runMany gate ==")
{
  const am = await import("../agentmanager.js")
  let lastContext = null
  const mgr = am.createAgentManager({
    maxWorkers: 4,
    onEvent: () => { },
    runner: async ({ context }) => { lastContext = context ?? ""; return { ok: true, result: "done" } },
  })
  const first = mgr.spawn({ role: "researcher", task: "investigate the flaky test", context: "" })
  await first.promise
  const { createHandoff } = await import("../handoff.js")
  const h = createHandoff({
    from: first.workerId, to: "w2", reason: "failed",
    currentState: "failed after timeout",
    completedWork: ["found the flaky seed"],
    remainingWork: ["identify the race window"],
    failedApproaches: ["re-running the same test twice"],
    recommendedNextAction: "inspect the mutex ordering",
    verificationStatus: "unknown",
  })
  const successor = mgr.reassign(first.workerId, { reason: "timeout", newRole: "researcher", handoff: h })
  await successor.promise
  ok("the successor's context CONTAINS the structured handoff block", lastContext.includes("HANDOFF CONTEXT") && lastContext.includes("Do NOT repeat"), lastContext.slice(0, 80))
  ok("failed approaches travel to the successor", lastContext.includes("re-running the same test twice"))
  // runMany maxParallel is a real gate
  let running = 0, peak = 0
  const mgr2 = am.createAgentManager({
    maxWorkers: 8,
    onEvent: () => { },
    runner: async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 120)); running--; return { ok: true, result: "x" } },
  })
  const recs = await mgr2.runMany(
    Array.from({ length: 6 }, (_, i) => ({ role: "researcher", task: `t${i}` })),
    { maxParallel: 2 },
  )
  ok("runMany settles all six", recs.length === 6 && recs.every((r) => r.status === "completed"))
  ok("maxParallel=2 was enforced (peak concurrency ≤ 2, was: ignored)", peak <= 2, `peak=${peak}`)
}

console.log("== 16. mcp lazy connect ==")
{
  const mcp = await import("../mcp.js")
  // a stub server that records every start into a marker file
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mcp-lazy-"))
  const marker = path.join(ROOT, "starts.txt")
  const stub = path.join(ROOT, "server.cjs")
  fs.writeFileSync(stub, `
const fs = require("fs")
const marker = ${JSON.stringify(marker)}
fs.appendFileSync(marker, "start\\n")
let buf = ""
process.stdin.setEncoding("utf8")
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n") }
process.stdin.on("data", (d) => {
  buf += d
  let nl
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } } })
    else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "echoes", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } })
    else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo:" + (msg.params && msg.params.arguments && msg.params.arguments.text) }] } })
    else if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: null })
  }
})`)
  const config = { mcp: { servers: { lazy1: { command: process.execPath, args: [stub] } } } }
  const starts = () => { try { return fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).length } catch { return 0 } }
  eq("cold cache: zero starts so far", starts(), 0)
  const first = await mcp.loadMcpTools(config)
  ok("cold run lists the tool (eager, like before)", first.tools.length === 1 && first.tools[0].name === "mcp__lazy1__echo")
  eq("cold run started the server exactly once", starts(), 1)
  const out1 = await first.tools[0].run({ text: "hi" })
  eq("cold-run tool call works", out1, "echo:hi")
  for (const c of first.clients) c.close()
  // WARM cache: no spawn until a tool is called
  const second = await mcp.loadMcpTools(config)
  ok("warm run advertises the same tool from the inventory cache", second.tools.length === 1 && second.tools[0].name === "mcp__lazy1__echo")
  eq("warm run did NOT spawn the server at load time (lazy)", starts(), 1)
  const out2 = await second.tools[0].run({ text: "again" })
  eq("lazy tool call connects on demand and works", out2, "echo:again")
  eq("the lazy call started the server exactly once more", starts(), 2)
  for (const c of second.clients) c.close()
  // opt-out restores eager behavior even with a warm cache
  process.env.FORGE_MCP_LAZY = "0"
  const eager = await mcp.loadMcpTools(config)
  eq("FORGE_MCP_LAZY=0 ignores the cache and connects eagerly", starts(), 3)
  const out3 = await eager.tools[0].run({ text: "x" })
  eq("eager opt-out tool call works", out3, "echo:x")
  for (const c of eager.clients) c.close()
  delete process.env.FORGE_MCP_LAZY
}

console.log("== 17. lsp: pinned default + allowAutostart ==")
{
  const { collectDiagnosticsForFiles } = await import("../lsp.js")
  const empty = await collectDiagnosticsForFiles({ lsp: { servers: {} } }, [path.join(work, "a.ts")], { cwd: work })
  eq("pinned default: no user servers + no allowAutostart → no evidence", empty, [])
  const none = await collectDiagnosticsForFiles({ lsp: { servers: {} } }, [], { cwd: work, allowAutostart: true })
  eq("allowAutostart with no servable files → no evidence (honest)", none, [])
  const src = fs.readFileSync(new URL("../lsp.js", import.meta.url), "utf8")
  ok("the autostart branch is gated on allowAutostart", src.includes("fromAutostart && !allowAutostart"))
}

console.log("== 18. hardShrink: ONE implementation ==")
{
  const compaction = await import("../compaction.js")
  ok("compaction.js exports hardShrink", typeof compaction.hardShrink === "function")
  const msgs = [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
    { role: "tool", content: "x".repeat(2000) },
    { role: "assistant", content: "a" },
    { role: "tool", content: "x".repeat(2000) },
    { role: "assistant", content: "b" },
    { role: "tool", content: "x".repeat(2000) },
    { role: "assistant", content: "c" },
    { role: "tool", content: "recent tool output stays" },
  ]
  const shrunk = compaction.hardShrink(msgs)
  ok("old oversized tool outputs are stubbed, the most recent 6 messages intact", shrunk[2].content.length < 900 && shrunk[8].content === "recent tool output stays")
  const chatSrc = fs.readFileSync(new URL("../chat.js", import.meta.url), "utf8")
  const agentSrc = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  ok("chat.js imports the shared hardShrink (no local copy)", chatSrc.includes("hardShrink") && chatSrc.includes("compaction.js") && !chatSrc.includes("function hardShrink"))
  ok("agent.js imports the shared hardShrink (no local copy)", agentSrc.includes("hardShrink") && agentSrc.includes("compaction.js") && !agentSrc.includes("function hardShrink"))
}

console.log("== 19. dead code removed ==")
{
  const metaSrc = fs.readFileSync(new URL("../meta.js", import.meta.url), "utf8")
  const agentSrc = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  const strategySrc = fs.readFileSync(new URL("../strategy.js", import.meta.url), "utf8")
  ok("meta no longer imports the dead reportConflict", !metaSrc.includes('import { reportConflict }'))
  ok("agent.js no longer carries the dead fs import (`void fs` gone)", !agentSrc.includes("void fs") && !agentSrc.includes('import fs from "node:fs"'))
  ok("strategy.js dead formatStrategy export removed (evaluate owns the STRAT line)", !/^export function formatStrategy\b(?!Justified)/m.test(strategySrc))
  const amSrc = fs.readFileSync(new URL("../agentmanager.js", import.meta.url), "utf8")
  ok("agentmanager consumes the handoff (handoffContextBlock imported)", amSrc.includes("handoffContextBlock") && amSrc.includes("handoff.js"))
}

console.log(`\nunifywise: ${PASS} passed, ${FAIL} failed`)
if (FAIL > 0) process.exit(1)
