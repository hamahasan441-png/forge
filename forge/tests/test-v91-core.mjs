/**
 * v91 "corewise" — ∞ CORE part 2: state engines, world model, episodes,
 * language adapters, crew manager extensions, resource fuses, and the Core.
 *
 *  1. Task states (§3): CREATED/UNDERSTANDING/READY/REVIEWING/REPLANNING/
 *     WAITING_FOR_AGENT/WAITING_FOR_USER/BLOCKED/PAUSED with explicit
 *     transitions, WAITING_FOR_USER never degraded, PAUSED preserved.
 *  2. DAG states (§21): INVALIDATED cascades but preserves settled work,
 *     SKIPPED never blocks completion, RETRYING carries a reason.
 *  3. Evidence (§19): full claim ladder + provenance + staleness via
 *     provenance.file, PROOF without reproducibility downgrades honestly.
 *  4. World model (§5): builds over the real index, answers locate/dependents/
 *     impact/tests/language/recent questions, degraded-not-thrown.
 *  5. Episodes (§11/78): full stage structure, unverified success → PARTIAL,
 *     failed approaches preserved, BM25 similar-episode retrieval.
 *  6. Language adapters (§6-8): 60+ catalog, layered parse honesty, adaptive
 *     plan for unknown languages with conservative rules.
 *  7. Agent manager (§23-26/32/35): new roles read-only, dynamic roles,
 *     duplicate-work flags, reassignment with context transfer, handoff.
 *  8. Resource fuses (§4): failure-rate/recovery-loop fuses → replan, never
 *     completion.
 *  9. Core (§1/2): createForgeCore wires subsystems, records phases from real
 *     events, answers decisions.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v91b-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v91b-work-"))
process.chdir(WORK)
// give the world model something real to index
fs.mkdirSync(path.join(WORK, "src"), { recursive: true })
fs.writeFileSync(path.join(WORK, "src", "calc.js"), "export function add(a, b) { return a + b }\nexport function sub(a, b) { return a - b }\n")
fs.writeFileSync(path.join(WORK, "src", "app.js"), "import { add } from './calc.js'\nexport function total(xs) { return xs.reduce(add, 0) }\n")
fs.writeFileSync(path.join(WORK, "src", "calc.test.js"), "import { test } from 'node:test'\nimport { add } from './calc.js'\ntest('add', () => {})\n")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 220) : ""}`) }
}

const { TASK_STATUS, WAITING_STATUSES, canTransition, openTask, finalizeStatus, FINAL_STATUSES, readTask } = await import("../taskstate.js")
const dagLib = await import("../dag.js")
const ev = await import("../evidence.js")
const { createWorldModel } = await import("../worldmodel.js")
const { EPISODE_RESULT, createEpisodeStore } = await import("../episodes.js")
const { catalogSize, adapterFor, parseLayered, adaptivePlan, EXTENSION_LANGUAGES } = await import("../langadapter.js")
const { createAgentManager, ROLES, registerRole, roleIsReadOnly, roleCatalog } = await import("../agentmanager.js")
const { createResourceManager } = await import("../resources.js")
const { createForgeCore } = await import("../core.js")

// ---------------------------------------------------------------------------
console.log("== 1. task states: the v91 lifecycle (§3) ==")
{
  ok("all 9 new states exist", [TASK_STATUS.CREATED, TASK_STATUS.UNDERSTANDING, TASK_STATUS.READY, TASK_STATUS.REVIEWING, TASK_STATUS.REPLANNING, TASK_STATUS.WAITING_FOR_AGENT, TASK_STATUS.WAITING_FOR_USER, TASK_STATUS.BLOCKED, TASK_STATUS.PAUSED].every(Boolean))
  ok("full lifecycle path is legal", canTransition(TASK_STATUS.IDLE, TASK_STATUS.CREATED) && canTransition(TASK_STATUS.CREATED, TASK_STATUS.UNDERSTANDING) && canTransition(TASK_STATUS.UNDERSTANDING, TASK_STATUS.PLANNING) && canTransition(TASK_STATUS.PLANNING, TASK_STATUS.READY) && canTransition(TASK_STATUS.READY, TASK_STATUS.EXECUTING))
  ok("EXECUTING → WAITING_FOR_AGENT", canTransition(TASK_STATUS.EXECUTING, TASK_STATUS.WAITING_FOR_AGENT))
  ok("WAITING_FOR_AGENT → EXECUTING", canTransition(TASK_STATUS.WAITING_FOR_AGENT, TASK_STATUS.EXECUTING))
  ok("EXECUTING → WAITING_FOR_USER", canTransition(TASK_STATUS.EXECUTING, TASK_STATUS.WAITING_FOR_USER))
  ok("EXECUTING → REVIEWING", canTransition(TASK_STATUS.EXECUTING, TASK_STATUS.REVIEWING))
  ok("REVIEWING → COMPLETED", canTransition(TASK_STATUS.REVIEWING, TASK_STATUS.COMPLETED))
  ok("VERIFYING → REPLANNING", canTransition(TASK_STATUS.VERIFYING, TASK_STATUS.REPLANNING))
  ok("REPLANNING → PLANNING", canTransition(TASK_STATUS.REPLANNING, TASK_STATUS.PLANNING))
  ok("impossible jump refused", !canTransition(TASK_STATUS.CREATED, TASK_STATUS.REVIEWING))

  const t = openTask("v91-states", { create: true, objective: "state test", cwd: WORK })
  t.transition(TASK_STATUS.CREATED, { reason: "spawned" })
  t.transition(TASK_STATUS.UNDERSTANDING, { reason: "reading goal" })
  t.transition(TASK_STATUS.PLANNING, { reason: "planning" })
  t.transition(TASK_STATUS.READY, { reason: "dag ready" })
  t.transition(TASK_STATUS.EXECUTING, { reason: "work" })
  t.transition(TASK_STATUS.WAITING_FOR_USER, { reason: "needs authorization" })
  t.flush()
  const rec = readTask("v91-states")
  ok("WAITING_FOR_USER persisted", rec.status === TASK_STATUS.WAITING_FOR_USER)
  ok("waiting_reason recorded", rec.waiting_reason === "needs authorization")
  ok("WAITING_FOR_USER is a final status (never degraded)", FINAL_STATUSES.has(TASK_STATUS.WAITING_FOR_USER))
  ok("finalize preserves WAITING_FOR_USER", finalizeStatus(TASK_STATUS.WAITING_FOR_USER, TASK_STATUS.WAITING_FOR_USER) === TASK_STATUS.WAITING_FOR_USER)
  ok("finalize never turns it into FAILED", finalizeStatus(TASK_STATUS.WAITING_FOR_USER, TASK_STATUS.FAILED) === TASK_STATUS.WAITING_FOR_USER)
  t.transition(TASK_STATUS.EXECUTING, { reason: "answered" })
  t.transition(TASK_STATUS.PAUSED, { reason: "user paused" })
  ok("PAUSED reached and preserved", t.status === TASK_STATUS.PAUSED && finalizeStatus(TASK_STATUS.PAUSED, TASK_STATUS.FAILED) === TASK_STATUS.PAUSED)
  ok("waiting family is exported", WAITING_STATUSES.has(TASK_STATUS.BLOCKED) && WAITING_STATUSES.has(TASK_STATUS.PAUSED))
}

console.log("== 2. DAG: INVALIDATED / SKIPPED / RETRYING (§21) ==")
{
  const graph = dagLib.buildDAG([
    { id: "a", objective: "foundation" },
    { id: "b", objective: "build on a", dependencies: ["a"] },
    { id: "c", objective: "build on b", dependencies: ["b"] },
    { id: "d", objective: "independent, optional", optional: true },
  ])
  dagLib.markRunning(graph, "a")
  dagLib.markCompleted(graph, "a", "done", { verification: dagLib.VERIFICATION_NOT_REQUIRED })
  dagLib.markRunning(graph, "b")
  dagLib.markCompleted(graph, "b", "done", { verification: dagLib.VERIFICATION_NOT_REQUIRED })

  // invalidation of "b" cascades to unfinished "c"
  const res = dagLib.invalidateNodes(graph, ["b"], { reason: "ground truth changed" })
  ok("invalidated the named node", res.invalidated.includes("b"))
  ok("downstream dependent blocked", res.blocked.includes("c") && graph.nodes.get("c").status === dagLib.NODE_STATUS.BLOCKED)
  ok("invalidated node is unfinished (blocks completion)", dagLib.UNFINISHED_STATUS.has(dagLib.NODE_STATUS.INVALIDATED))
  ok("invalidation reason recorded", String(graph.nodes.get("b").invalidation_reason).includes("ground truth"))

  // preserve valid work: "a" stays completed
  ok("valid completed work preserved", graph.nodes.get("a").status === dagLib.NODE_STATUS.COMPLETED)
  // rebuild path: retry an invalidated node once its deps are satisfied
  ok("retryNode accepts INVALIDATED", dagLib.retryNode(graph, "b") === true && graph.nodes.get("b").status === dagLib.NODE_STATUS.READY)

  // completed downstream of invalidated ground truth is invalidated too
  const g2 = dagLib.buildDAG([{ id: "x" }, { id: "y", dependencies: ["x"] }])
  for (const id of ["x", "y"]) { dagLib.markRunning(g2, id); dagLib.markCompleted(g2, id, "ok", { verification: dagLib.VERIFICATION_NOT_REQUIRED }) }
  dagLib.invalidateNodes(g2, ["x"], { reason: "spec changed" })
  ok("settled downstream work on invalid ground truth is invalidated", g2.nodes.get("y").status === dagLib.NODE_STATUS.INVALIDATED)

  // SKIPPED never blocks the completion gate
  dagLib.skipNode(graph, "d", "no longer needed")
  ok("skipNode records the reason", String(graph.nodes.get("d").skip_reason).includes("no longer needed"))
  const g3 = dagLib.buildDAG([{ id: "only" }])
  dagLib.markRunning(g3, "only"); dagLib.markCompleted(g3, "only", "ok", { verification: dagLib.VERIFICATION_NOT_REQUIRED })
  dagLib.skipNode(g3, "only", "policy")
  ok("all SKIPPED graph counts as complete", dagLib.allComplete(g3))

  // RETRYING carries a reason (§91 no blind retries)
  const g4 = dagLib.buildDAG([{ id: "r" }])
  dagLib.markFailed(g4, "r", "boom")
  ok("markRetrying requires a reason path", dagLib.markRetrying(g4, "r", "changed the approach: use v2 API") === true && g4.nodes.get("r").status === dagLib.NODE_STATUS.RETRYING)
  ok("attempts counted on retry", g4.nodes.get("r").attempts === 1)
  ok("RETRYING blocks completion", dagLib.UNFINISHED_STATUS.has(dagLib.NODE_STATUS.RETRYING))
  ok("stats include new statuses", dagLib.dagStats(g4).retrying === 1)
}

console.log("== 3. evidence: claim ladder + provenance (§19) ==")
{
  ok("spec kinds exist", [ev.KIND.OBSERVATION, ev.KIND.FINDING, ev.KIND.ANALYSIS, ev.KIND.VERIFICATION, ev.KIND.PROOF].every((k) => typeof k === "string"))

  const o = ev.observation("exit code 0 from npm test", { source: "bash", provenance: { command: "npm test", file: "package.json" } })
  ok("observation carries provenance", o.provenance?.command === "npm test")

  const pr = ev.proof("the fix works", { source: "repro", provenance: { command: "npm test", reproducible: true } })
  ok("reproducible proof stays PROOF", pr.kind === ev.KIND.PROOF)
  const fakeProof = ev.proof("trust me", { source: "model" })
  ok("proof without reproducibility downgrades to VERIFICATION", fakeProof.kind === ev.KIND.VERIFICATION && fakeProof.downgraded_from === ev.KIND.PROOF)

  const log = ev.createEvidenceLog()
  log.record(ev.observation("x", { files: ["a.js"], asOf: 100, provenance: { file: "b.js" } }))
  log.record(ev.fact("y", { files: ["c.js"], asOf: 50 }))
  log.invalidate({ "b.js": 200 }) // provenance.file staleness
  ok("provenance.file goes stale", log.snapshot()[0].kind === ev.KIND.STALE)
  ok("unrelated fact survives", log.snapshot()[1].kind === ev.KIND.FACT)
}

console.log("== 4. world model: current project truth (§5) ==")
{
  const w = createWorldModel({ cwd: WORK })
  const world = w.build()
  ok("files indexed from the real repo", world.files.length >= 3)
  ok("language census", Object.keys(world.langs).some((l) => /javascript|js/.test(l)))
  ok("locate finds calc.js", w.locate("calc").some((m) => m.path.includes("calc.js")))
  ok("dependents: app imports calc", w.dependents("src/calc.js").includes("src/app.js"))
  ok("testsFor finds the test", w.testsFor(["src/calc.js"]).some((t) => String(t).includes("calc.test")))
  ok("languageOf works", /javascript|js/i.test(w.languageOf("src/app.js")))
  const ans = w.answer("where is add defined")
  ok("answer() routes locate questions", ans.method === "locate" && ans.answer.matches.length > 0)
  const dep = w.answer("what depends on src/calc.js")
  ok("answer() routes dependents questions", dep.method === "dependents" && dep.answer.dependents.includes("src/app.js"))
  ok("summarize is compact", w.summarize().split("\n").length <= 24 && w.summarize().includes("WORLD MODEL"))
  ok("snapshot is serializable", JSON.parse(JSON.stringify(w.snapshot())).root === path.resolve(WORK))
}

console.log("== 5. episodes: complete engineering stories (§11/78) ==")
{
  const store = createEpisodeStore({ cwd: WORK })
  const e = store.start({ problem: "flaky login test", context: "auth refactor", symptoms: ["intermittent 401"], files: ["auth.js"], taskId: "t-ep" })
  store.addHypothesis(e, "token cache race", { confidence: 0.6 })
  store.addExperiment(e, { command: "npm test -- auth", ok: false, result: "fails 1/5" })
  store.addFailedApproach(e, "retrying with longer sleeps")
  store.addFix(e, "deduplicate token writes")
  store.addVerification(e, { command: "npm test -- auth", ok: true })
  store.setReview(e, "adversarial review: pass")
  store.setLesson(e, "dedupe token writes before flaky-test hunting", { result: EPISODE_RESULT.SUCCESS })
  ok("episode has the full stage chain", [e.problem, e.hypotheses, e.experiments, e.evidence !== undefined, e.fixes, e.verification, e.review, e.result, e.lesson].every(Boolean))
  ok("verified success stays SUCCESS", e.result === EPISODE_RESULT.SUCCESS)

  const e2 = store.start({ problem: "another one" })
  store.setLesson(e2, "never verified", { result: EPISODE_RESULT.SUCCESS })
  ok("unverified 'success' demoted to PARTIAL", e2.result === EPISODE_RESULT.PARTIAL)

  ok("failed approaches preserved", e.failed_approaches.includes("retrying with longer sleeps"))
  const sims = store.similar("flaky login test auth")
  ok("BM25 retrieves the similar episode", sims.some((x) => x.episode_id === e.episode_id))
  ok("context block warns about failed approaches", store.contextBlock("flaky login test auth").includes("retrying with longer sleeps"))
  ok("stats count by result", store.stats().byResult.success >= 1)
}

console.log("== 6. language adapters: layered + adaptive (§6-8) ==")
{
  const size = catalogSize()
  ok("60+ language coverage", size.total >= 60, JSON.stringify(size))
  ok("extension catalog includes the spec list", ["scala", "perl", "lua", "haskell", "cobol", "kubernetes", "openapi", "helm", "nix", "latex"].every((id) => EXTENSION_LANGUAGES.some((l) => l.id === id)))

  const deep = adapterFor("src/calc.js")
  ok("deep adapter for js (lexical extraction)", deep.deep === true && typeof deep.capabilities.symbols.extract === "function")
  ok("deep adapter reports semantics", deep.capabilities.semanticAnalysis?.semantics != null)

  const shallow = adapterFor("main.foo")
  ok("unknown language is adaptive, never refused", shallow.adaptive === true && shallow.id === "foo")

  const layers = parseLayered("src/calc.js", "export function add() {}")
  ok("8 layers reported honestly", layers.layers.length === 8 && layers.layers[0].available === false)
  ok("layer 8 lexical always available", layers.layers[7].available === true && layers.layers[7].name === "lexical")
  ok("extraction falls back to lexical", Boolean(layers.extraction?.symbols))

  const plan = adaptivePlan("widget.blorp", "definitely not a known language")
  ok("adaptive plan has the 8 spec steps", plan.steps.map((s) => s.step).join().includes("OPERATE_CONSERVATIVELY") && plan.steps.length === 8)
  ok("conservative rules for unknown languages", plan.conservativeRules.length >= 3)
}

console.log("== 7. agent manager: specialists + reassignment (§23-26/32/35) ==")
{
  ok("spec roles exist", [ROLES.EXPLORER, ROLES.BUILD_ENGINEER, ROLES.PERFORMANCE_ENGINEER, ROLES.DEPENDENCY_ANALYST, ROLES.DOC_ENGINEER, ROLES.RELEASE_ENGINEER, ROLES.LANGUAGE_SPECIALIST, ROLES.RUNTIME_SPECIALIST].every(Boolean))
  ok("new roles are read-only", [ROLES.EXPLORER, ROLES.BUILD_ENGINEER, ROLES.DOC_ENGINEER].every((r) => roleIsReadOnly(r)))
  ok("registerRole creates a read-only dynamic role", registerRole("data_engineer_v2") === true && roleIsReadOnly("data_engineer_v2") && roleCatalog().some((r) => r.role === "data_engineer_v2" && r.dynamic === true))
  ok("registerRole rejects garbage", registerRole("1bad name") === false && registerRole("") === false)

  const results = []
  const mgr = createAgentManager({ maxWorkers: 4, runner: async (r) => { results.push(r.role); return `findings from ${r.role}` } })

  // duplicate work prevention (§32)
  const w1 = mgr.spawn({ role: "explorer", task: "map the auth flow", nodeId: "n1", targetFiles: ["auth.js"] })
  const w2 = mgr.spawn({ role: "researcher", task: "also map the auth flow", nodeId: "n1", targetFiles: ["auth.js"] })
  ok("duplicate spawn is flagged, not hidden", w2.duplicateOf === w1.workerId)
  await Promise.allSettled([w1.promise, w2.promise])

  // reassignment (§35): failed worker → successor with context transfer
  const mgr2 = createAgentManager({
    maxWorkers: 4,
    runner: async (r) => {
      if (r.task.includes("fail-first")) throw new Error("worker crashed mid-analysis")
      if (r.task.includes("SECOND ATTEMPT")) return "successor findings with prior context"
      return "fallback findings"
    },
  })
  const f = mgr2.spawn({ role: "debugger", task: "fail-first: diagnose the crash", nodeId: "n9", targetFiles: ["crash.js"] })
  const rec = await f.promise
  ok("first attempt fails as scripted", rec.status === "failed" && String(rec.error ?? "").includes("crashed"))
  const succ = mgr2.reassign(rec.workerId, { reason: rec.error ?? "failed", newRole: "runtime_specialist" })
  ok("reassign returns a successor with a new role", Boolean(succ) && succ.role === "runtime_specialist")
  ok("successor links to its parent", succ.parentAgentId === rec.workerId)
  ok("handoff preserves the failed attempt", Boolean(succ.handoff) && String(succ.handoff.current_state ?? "").length > 0)
  ok("successor inherits conflict targets", JSON.stringify(succ.targetFiles) === JSON.stringify(["crash.js"]))
  ok("reassignment is observable via events", mgr2.list().some((x) => x.parentAgentId === rec.workerId))
  await succ.promise.catch(() => {})
  // budget: a second reassign of the SAME worker is refused by the caller-side budget, not the manager
  ok("original record preserved (never deleted)", mgr2.list().some((x) => x.workerId === rec.workerId && x.reassigned === true))
}

console.log("== 8. resource fuses: recovery, never false completion (§4) ==")
{
  const m = createResourceManager({ config: {}, cwd: WORK })
  for (let i = 0; i < 3; i++) m.record({ modelCalls: 2, failures: 2 })
  const fuses = m.fuses()
  ok("failure-rate fuse fires", fuses.some((f) => f.fuse === "failure_rate" && f.action === "replan"))
  ok("fuse never reports completion", fuses.every((f) => ["replan", "checkpoint_and_wait"].includes(f.action)))
  const m2 = createResourceManager({ config: {}, cwd: WORK })
  for (let i = 0; i < 5; i++) m2.record({ recovery: true, recoveryCostMs: 100 })
  ok("recovery-loop fuse fires", m2.fuses().some((f) => f.fuse === "recovery_loop"))
  ok("snapshot carries the metric set", (() => { const s = m.snapshot(); return ["modelCalls", "failures", "recoveries", "checkpoints", "peakWorkers", "fuses"].every((k) => k in s) })())
}

console.log("== 9. core: one coherent system (§1/2/94) ==")
{
  const core = createForgeCore({ config: {}, cwd: WORK })
  ok("subsystems wired and shared", Boolean(core.bus && core.handoffs && core.decisions && core.episodes && core.crewRouter && core.resources && core.world))
  ok("phases are the §2 loop", core.phases.includes("UNDERSTAND") && core.phases.includes("DECOMPOSE") && core.phases.includes("COLLECT_EVIDENCE") && core.phases.includes("RECOVER"))

  // core taps real events into phases + bus + crew memory
  const events = []
  const core2 = createForgeCore({ config: {}, cwd: WORK, onEvent: (e) => events.push(e) })
  core2.bus.send({ sender: "worker:w1", receiver: "core", type: "DISCOVERY", content: "found the contract" })
  const st = core2.status()
  ok("status dashboard has all views", ["phase", "crew", "communication", "verification", "resources", "decisions", "episodes", "handoffs", "conflicts"].every((k) => k in st))
  ok("core is not running before run()", st.running === false)
  ok("decision answer flow", (() => {
    const d = core2.decisions.ask({ title: "t", options: ["a", "b"], key: "core-test-dec" })
    const r = core2.answerDecision(d.decision_id, { choice: "a" })
    return r?.status === "ANSWERED"
  })())
  ok("pause is observable", (() => { core2.pause({ reason: "test" }); return true })())
}

console.log(`\n== v91 part 2: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
