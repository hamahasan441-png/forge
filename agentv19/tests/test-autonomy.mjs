#!/usr/bin/env node
/**
 * forge — v21 autonomous orchestration suite (zero network, isolated HOME).
 *
 * Covers the upgrade directive's new systems:
 *   task state machine + validated transitions, segment continuation (no fixed
 *   step-lifetime), DAG dependencies / parallel read-only / failure
 *   recomputation, model selection + fallback, agent worker cancellation,
 *   resource adaptation, structured verification evidence + invalidation,
 *   unknown-result recovery, effect reconciliation, checkpoint/crash recovery,
 *   failure learning, security boundaries on new paths, and the meta lifecycle.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-autonomy-"))
process.env.FORGE_HOME = HOME // resolved by config.js at import
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-autonomy-work-"))
process.chdir(WORK)

const {
  TASK_STATUS, TERMINAL, TRANSITIONS, openTask, readTask, listTasks, canTransition, interruptedTasks,
} = await import("../forge/taskstate.js")
const dag = await import("../forge/dag.js")
const resources = await import("../forge/resources.js")
const modelstrategy = await import("../forge/modelstrategy.js")
const agentmanager = await import("../forge/agentmanager.js")
const verifyledger = await import("../forge/verifyledger.js")
const lessons = await import("../forge/lessons.js")
const context = await import("../forge/context.js")
const recovery = await import("../forge/recovery.js")
const meta = await import("../forge/meta.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

// ---------------------------------------------------------------------------
console.log("== task state machine: states + validated transitions ==")
ok("all 12 states defined", [
  "IDLE", "PLANNING", "DISCOVERING", "EXECUTING", "VERIFYING", "REPAIRING",
  "CHECKPOINTING", "WAITING", "RECOVERING", "COMPLETED", "FAILED", "CANCELLED",
].every((s) => TASK_STATUS[s] === s))

ok("legal transition IDLE→PLANNING", canTransition(TASK_STATUS.IDLE, TASK_STATUS.PLANNING))
ok("legal transition EXECUTING→VERIFYING", canTransition(TASK_STATUS.EXECUTING, TASK_STATUS.VERIFYING))
ok("legal transition VERIFYING→REPAIRING", canTransition(TASK_STATUS.VERIFYING, TASK_STATUS.REPAIRING))
ok("impossible IDLE→COMPLETED rejected", !canTransition(TASK_STATUS.IDLE, TASK_STATUS.COMPLETED))
ok("impossible COMPLETED→EXECUTING rejected", !canTransition(TASK_STATUS.COMPLETED, TASK_STATUS.EXECUTING))
ok("terminal states have no outgoing transitions", [...TERMINAL].every((s) => TRANSITIONS[s].size === 0))

const t = openTask("t1", { objective: "do the thing", cwd: WORK })
ok("task starts IDLE", t.status === TASK_STATUS.IDLE)
ok("valid transition returns true", t.transition(TASK_STATUS.PLANNING) === true)
ok("status now PLANNING", t.status === TASK_STATUS.PLANNING)
ok("invalid transition returns false (no corruption)", t.transition(TASK_STATUS.COMPLETED) === false)
ok("status unchanged after rejected transition", t.status === TASK_STATUS.PLANNING)
t.transition(TASK_STATUS.EXECUTING)
t.noteFiles(["src/a.js"], ["src/b.js"])
t.addSegment({ objective: "seg", steps: 5, tool_calls: 3 })
t.noteRepair(1)
t.flush()
const persisted = readTask("t1")
eq("task persisted to disk with objective", persisted.objective, "do the thing")
eq("repair count persisted", persisted.repair_count, 1)
eq("segment count persisted", persisted.segment_count, 1)
ok("files_changed recorded absolute", persisted.files_changed.some((f) => f.endsWith("a.js")))
t.transition(TASK_STATUS.COMPLETED)
t.flush()
eq("terminal transition persisted", readTask("t1").status, "COMPLETED")

// ---------------------------------------------------------------------------
console.log("== segment continuation (no fixed step-lifetime) ==")
{
  let calls = 0
  const runAgent = async (o) => {
    calls++
    if (o.planOnly) return { text: "1. investigate\n2. fix\n3. test", toolRecords: [], commandChecks: [], toolLog: [] }
    if (calls <= 3) return { text: "working", budgetHit: true, steps: 12, toolRecords: [], commandChecks: [], toolLog: [] }
    return { text: "All done, complete and verified.", budgetHit: false, steps: 3, toolRecords: [], commandChecks: [], toolLog: [] }
  }
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const r = await meta.runMeta({ config: cfg, provider: { name: "x", model: "m" }, task: "no mutation docs task", runAgent, signal: new AbortController().signal })
  ok("task continues across >1 segment until model ends its turn", r.segments >= 3)
  eq("final status COMPLETED", r.status, "COMPLETED")
  ok("task state file written", !!readTask(r.taskId))
}

// ---------------------------------------------------------------------------
console.log("== DAG planner: dependencies, ordering, failure recompute ==")
{
  const g = dag.buildDAG([
    { id: "a", objective: "read x", read_only: true, role: "researcher" },
    { id: "b", objective: "read y", read_only: true, role: "researcher" },
    { id: "c", objective: "implement", dependencies: ["a", "b"], role: "coder" },
    { id: "d", objective: "test", dependencies: ["c"], role: "tester" },
  ])
  eq("topological order", g.order, ["a", "b", "c", "d"])
  eq("ready set is the two independent reads", dag.readyNodes(g).map((n) => n.id).sort(), ["a", "b"])

  // parallel read-only batch
  const batch = dag.scheduleBatch(g, { maxParallel: 4, conflictKeys: () => [] })
  eq("independent read-only nodes scheduled together", batch.map((n) => n.id).sort(), ["a", "b"])

  // mutation serialized alone
  dag.markCompleted(g, "a"); dag.markCompleted(g, "b")
  const mut = dag.scheduleBatch(g, { maxParallel: 4, conflictKeys: () => [] })
  eq("mutating node scheduled alone", mut.map((n) => n.id), ["c"])

  // fail c → downstream d blocked
  dag.markRunning(g, "c")
  const affected = dag.markFailed(g, "c", "boom")
  ok("failure recomputes downstream (d affected)", affected.includes("d"))
  eq("d becomes blocked", g.nodes.get("d").status, dag.NODE_STATUS.BLOCKED)
  eq("graph reports stalled", dag.isStalled(g), true)

  // repair: retry c → completes → d ready
  dag.retryNode(g, "c")
  eq("retried node back to ready", g.nodes.get("c").status, dag.NODE_STATUS.READY)
  dag.markCompleted(g, "c")
  eq("d unblocked after dependency satisfied", g.nodes.get("d").status, dag.NODE_STATUS.READY)
  dag.markCompleted(g, "d")
  ok("all complete", dag.allComplete(g))

  // serialization survives crash via persistence
  const ser = dag.serializeDAG(g)
  const restored = dag.deserializeDAG(ser)
  ok("DAG rehydrates from JSON", restored && dag.allComplete(restored))

  // cycle detection
  let threw = false
  try { dag.buildDAG([{ id: "x", dependencies: ["y"] }, { id: "y", dependencies: ["x"] }]) } catch { threw = true }
  ok("cyclic DAG rejected", threw)
}

// ---------------------------------------------------------------------------
console.log("== DAG: parse model plan into graph ==")
{
  const defs = dag.parsePlanToDAG("1. research the auth module\n2. review the login flow\n3. implement the fix\n4. run the tests")
  eq("four nodes parsed", defs.length, 4)
  ok("research steps read-only", defs[0].read_only && defs[1].read_only)
  ok("implementation node is coder", defs[2].role === "coder")
  ok("sequential dependency inferred", defs[2].dependencies.includes("n2"))
}

// ---------------------------------------------------------------------------
console.log("== model strategy engine ==")
{
  const cfg = {
    providers: {
      openai: { apiKey: "k", model: "gpt-4o" },
      groq: { apiKey: "k", model: "llama-3.1-8b-instant" },
    },
  }
  const prov = { name: "openai", model: "gpt-4o" }
  const heavy = modelstrategy.selectModel(cfg, { task: "debug a complex production race condition across the auth module", provider: prov })
  ok("selection returns a decision", !!heavy.decision)
  ok("decision carries reason + confidence", !!heavy.decision.reason && ["low", "medium", "high"].includes(heavy.decision.confidence))
  ok("fallback chain lists another provider", heavy.decision.fallback.some((f) => f.provider === "groq"))
  eq("capabilities include debugging", heavy.decision.capabilities.includes("debugging"), true)

  const light = modelstrategy.selectModel(cfg, { task: "summarize this short readme", provider: prov })
  ok("light task still produces a model choice", !!light.decision)

  // model strategy is SEPARATE from transport failover: no network, no throw
  ok("selection is pure (no throw on minimal config)", !!modelstrategy.selectModel({ providers: {} }, { task: "x" }))
}

// ---------------------------------------------------------------------------
console.log("== agent manager: roles, cancellation, conflicts ==")
{
  let cancelled = 0
  const runner = ({ role, task, signal: sig }) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(`${role} done`), 200)
    if (sig) sig.addEventListener?.("abort", () => { clearTimeout(t); cancelled++; const e = new Error("aborted"); e.name = "AbortError"; reject(e) })
  })
  const mgr = agentmanager.createAgentManager({ maxWorkers: 2, runner, signal: new AbortController().signal })
  // read-only roles
  ok("researcher is read-only", agentmanager.roleIsReadOnly("researcher"))
  ok("security is read-only", agentmanager.roleIsReadOnly("security"))
  ok("coder is NOT read-only", !agentmanager.roleIsReadOnly("coder"))

  // conflict: two mutators never run concurrently
  const a = { role: "coder", readOnly: false, task: "edit src/x.js" }
  const b = { role: "coder", readOnly: false, task: "edit src/y.js" }
  ok("two mutators conflict", mgr.conflict(a, b)?.conflict === true)
  // two researchers on different files do not
  const c = { role: "researcher", readOnly: true, task: "look at src/a.js" }
  const d = { role: "researcher", readOnly: true, task: "look at src/b.js" }
  ok("independent readers do not conflict", mgr.conflict(c, d) === null)

  // cancellation
  const controller = new AbortController()
  const mgr2 = agentmanager.createAgentManager({ maxWorkers: 1, runner, signal: controller.signal })
  const w = mgr2.spawn({ role: "researcher", task: "long investigation that reads a lot" })
  mgr2.cancel(w.id)
  controller.abort()
  await w.promise.catch(() => {})
  ok("cancelled worker recorded", w.status === "cancelled")
}

// ---------------------------------------------------------------------------
console.log("== resource manager: adaptation ==")
{
  const rm = resources.createResourceManager({ config: {}, cwd: WORK })
  // simulate high token usage
  rm.record({ tokensIn: 1_900_000, tokensOut: 50_000 })
  const ev = rm.evaluate()
  ok("near token budget → compact context", ev.actions.some((a) => a.action === resources.ADAPT.COMPACT_CONTEXT))
  ok("near token budget → prefer fast model", ev.limits.preferredClass === "fast_reasoning")

  // low RAM forces concurrency down
  const rm2 = resources.createResourceManager({ config: { agent: { maxParallelSubAgents: 3 } }, cwd: WORK })
  rm2.setFreeMB(200)
  const ev2 = rm2.evaluate()
  eq("low RAM reduces workers to 1", ev2.limits.maxWorkers, 1)
  ok("low RAM reported", ev2.actions.some((a) => a.action === resources.ADAPT.REDUCE_CONCURRENCY))

  // large repo → precise retrieval
  const rm3 = resources.createResourceManager({ config: {}, cwd: WORK })
  rm3.record({ repoSizeFiles: 5000 })
  const ev3 = rm3.evaluate()
  eq("large repo uses precise retrieval", ev3.limits.retrievalPrecision, "precise")
}

// ---------------------------------------------------------------------------
console.log("== structured verification: evidence, not command names ==")
{
  // a command NAMED test that FAILS must be a failure
  const fail = verifyledger.evaluateVerification("npm test", "2 tests failed\nAssertionError: nope\n[exit code: 1]")
  eq("failing test detected (not fooled by name)", fail.passed, false)
  eq("exit code captured", fail.exit_code, 1)
  ok("failure has high confidence evidence", fail.confidence === "high")

  const pass = verifyledger.evaluateVerification("npm test", "5 tests passed\n")
  eq("passing test detected", pass.passed, true)

  const build = verifyledger.evaluateVerification("npm run build", "webpack compiled successfully\n")
  eq("build classified", build.type, verifyledger.VTYPE.BUILD)
  const focused = verifyledger.evaluateVerification("npx vitest run src/auth.test.js", "2 tests passed\n")
  eq("targeted test = focused", focused.type, verifyledger.VTYPE.FOCUSED_TEST)
  const syn = verifyledger.evaluateVerification("node --check src/x.js", "")
  eq("node --check = syntax", syn.type, verifyledger.VTYPE.SYNTAX)

  // ledger gating + invalidation
  const led = verifyledger.createLedger()
  led.recordCommand("node --check src/x.js", "ok", { exitCode: 0, affectedFiles: ["src/x.js"] })
  led.recordCommand("npx vitest run src/x.test.js", "2 tests passed", { exitCode: 0, affectedFiles: ["src/x.js"] })
  const st1 = led.status("medium", ["src/x.js"])
  eq("medium change verified with syntax+focused", st1.ok, true)

  // a later mutation to x.js invalidates prior evidence
  const n = led.invalidate(["src/x.js"])
  ok("mutation invalidates prior evidence", n >= 1)
  const st2 = led.status("medium", ["src/x.js"])
  eq("invalidated evidence no longer counts as verified", st2.ok, false)
  ok("missing focused+syntax reported", st2.missing.includes("focused_test"))

  // a failing check anywhere blocks completion
  const led2 = verifyledger.createLedger()
  led2.recordCommand("npm test", "1 test failed [exit code: 1]", { exitCode: 1, affectedFiles: ["src/y.js"] })
  const st3 = led2.status("high", ["src/y.js"])
  ok("a failing check blocks the verified gate", st3.anyFailure && !st3.ok)

  // risk proportional depth
  const trivial = verifyledger.riskForChange({ filesChanged: 0, task: "fix a typo in the README" })
  eq("docs/trivial risk", trivial, "trivial")
  const crit = verifyledger.riskForChange({ task: "fix the auth token handling in the security sandbox" })
  eq("security-sensitive is critical", crit, "critical")
}

// ---------------------------------------------------------------------------
console.log("== unknown-result recovery + effect reconciliation ==")
{
  // write that DID land (content present) → CONTINUE, never blind retry
  fs.writeFileSync(path.join(WORK, "recon.txt"), "the desired content is here")
  const r1 = recovery.reconcileEffect({ kind: "file_edit", path: "recon.txt", contains: "desired content" }, WORK)
  eq("content present → continue", r1.decision, recovery.UNKNOWN_DECISION.CONTINUE)

  // write whose content is absent but file exists → compensate/inspect
  const r2 = recovery.reconcileEffect({ kind: "file_edit", path: "recon.txt", contains: "NEVER WRITTEN" }, WORK)
  eq("content absent → compensate", r2.decision, recovery.UNKNOWN_DECISION.COMPENSATE)

  // file write that never landed → safe retry
  const r3 = recovery.reconcileEffect({ kind: "file_write", path: "ghost.js" }, WORK)
  eq("missing target → retry", r3.decision, recovery.UNKNOWN_DECISION.RETRY)

  // non-idempotent bash unknown → ask, never blind retry
  const r4 = recovery.reconcileEffect({ kind: "bash", idempotent: false }, WORK)
  eq("uncertain non-idempotent op → ask user", r4.decision, recovery.UNKNOWN_DECISION.ASK_USER)

  // delete idempotency
  fs.writeFileSync(path.join(WORK, "gone.txt"), "x")
  const r5 = recovery.reconcileEffect({ kind: "file_delete", path: "gone.txt" }, WORK)
  eq("file still present + delete idempotent → retry", r5.decision, recovery.UNKNOWN_DECISION.RETRY)
  fs.rmSync(path.join(WORK, "gone.txt"))
  const r6 = recovery.reconcileEffect({ kind: "file_delete", path: "gone.txt" }, WORK)
  eq("file already gone → continue", r6.decision, recovery.UNKNOWN_DECISION.CONTINUE)
}

// ---------------------------------------------------------------------------
console.log("== effect reconciliation of an interrupted run ==")
{
  const files = {}
  const present = path.join(WORK, "kept.js")
  fs.writeFileSync(present, "// kept")
  files[present] = { action: "modified" }
  files[path.join(WORK, "vanished.js")] = { action: "created" }
  const eff = recovery.observeEffects({ cwd: WORK, files })
  ok("present modified file observed", eff.modified.includes(present))
  ok("missing created file detected as drift", eff.missing.length >= 1)
}

// ---------------------------------------------------------------------------
console.log("== crash recovery: interrupted task detection + resume prompt ==")
{
  const ct = openTask("crash-1", { objective: "refactor the parser", cwd: WORK })
  ct.transition(TASK_STATUS.PLANNING)
  ct.transition(TASK_STATUS.EXECUTING)
  ct.addSegment({ steps: 4, tool_calls: 2 })
  ct.noteFiles(["src/parser.js"], [])
  ct.flush()
  // simulate a DEAD pid (the crash) by editing the persisted record directly
  const rec = readTask("crash-1")
  rec.pid = 999999
  fs.writeFileSync(path.join(HOME, "tasks", "crash-1.json"), JSON.stringify(rec))
  const interrupted = interruptedTasks({ cwd: WORK })
  ok("interrupted (dead pid, non-terminal) task detected", interrupted.some((x) => x.task_id === "crash-1"))

  const recon = recovery.reconcileTask(rec, { cwd: WORK })
  ok("reconciliation recommends a resume action", ["resume", "resume_repair", "inspect"].includes(recon.recommended))
  const prompt = recovery.resumePrompt(rec, recon, WORK)
  ok("resume prompt forbids blind replay", /do not blindly re-run/i.test(prompt))
  ok("resume prompt carries original objective", /refactor the parser/.test(prompt))
}

// ---------------------------------------------------------------------------
console.log("== failure learning ==")
{
  lessons.recordLesson({
    failure: "MODULE_NOT_FOUND on import foo",
    cause: "missing dependency",
    failedStrategy: "re-run same command",
    failedAction: "bash: node index.js",
    successfulRepair: "run npm install foo then re-run",
    applicableContext: "setting up the project",
    task: "build the app",
  }, WORK)
  const bad = lessons.ineffectiveStrategies("when I run node index.js it says Cannot find module foo", { cwd: WORK })
  ok("previously-ineffective strategy retrievable", bad.length >= 1)
  const prompt = lessons.lessonsForPrompt("node index.js Cannot find module foo", { cwd: WORK })
  ok("lessons surface in prompt", /LEARNED FROM PAST FAILURES/.test(prompt))
  // dedup
  const before = lessons.loadLessons(WORK).length
  lessons.recordLesson({ failure: "MODULE_NOT_FOUND on import foo", cause: "missing dependency", failedStrategy: "re-run same command" }, WORK)
  eq("duplicate lesson deduped (uses bumped)", lessons.loadLessons(WORK).length, before)
}

// ---------------------------------------------------------------------------
console.log("== context engine: demand-driven + cache invalidation ==")
{
  fs.mkdirSync(path.join(WORK, "ctx"), { recursive: true })
  fs.writeFileSync(path.join(WORK, "ctx", "alpha.js"), "export function alpha() { return 1 }\n")
  const eng = context.createContextEngine({ cwd: WORK, config: {} })
  const built = eng.build("where is the alpha function", { budgetTokens: 4000, includeMemory: false, includeLessons: false })
  ok("context produces a bounded block", typeof built.text === "string" && built.tokens <= 4000)
  const genBefore = eng.generation()
  eng.invalidateFor([path.join(WORK, "ctx", "alpha.js")])
  ok("mutation bumps context generation", eng.generation() > genBefore)
  // ranking helper works
  const ranked = eng.rank("alpha", [{ text: "beta gamma delta" }, { text: "alpha function here" }])
  ok("BM25 ranks the relevant doc first", ranked[0]?.i === 1)
}

// ---------------------------------------------------------------------------
console.log("== meta lifecycle: failure → repair → verified continue ==")
{
  const seq = []
  let call = 0
  const runAgent = async (o) => {
    call++
    if (o.planOnly) return { text: "1. investigate\n2. fix\n3. test", toolRecords: [], commandChecks: [], toolLog: [] }
    seq.push(o.task.slice(0, 24))
    // first mutating segment runs a test that FAILS; repair then passes
    if (!/FAILED|repair|verify|VERIF/i.test(o.task) && call === 2) {
      return { text: "made the change", budgetHit: false, steps: 4, toolRecords: [{ tool: "edit_file", files_changed: ["src/z.js"] }],
        commandChecks: [{ command: "npx vitest run src/z.test.js", exitCode: 1, passed: false, tail: "1 test failed" }], toolLog: [] }
    }
    if (/FAILED|repair|diagnose|VERIF|verify/i.test(o.task)) {
      return { text: "fixed the root cause and verified.", budgetHit: false, steps: 3, toolRecords: [],
        commandChecks: [
          { command: "node --check src/z.js", exitCode: 0, passed: true, tail: "ok" },
          { command: "npx vitest run src/z.test.js", exitCode: 0, passed: true, tail: "3 tests passed" },
        ], toolLog: [] }
    }
    return { text: "All done, complete and verified.", budgetHit: false, steps: 2, toolRecords: [], commandChecks: [], toolLog: [] }
  }
  const events = []
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const r = await meta.runMeta({ config: cfg, provider: { name: "x", model: "m" }, task: "fix the z module bug", runAgent, signal: new AbortController().signal, onEvent: (e) => events.push(e.type) })
  ok("a repair pass was triggered", events.includes("REPAIR_STARTED"))
  ok("verification failure observed", events.includes("VERIFICATION_FAILED"))
  ok("verification pass observed", events.includes("VERIFICATION_PASSED"))
  ok("strategy change recorded", events.includes("STRATEGY_CHANGED"))
  eq("task reached COMPLETED after repair", r.status, "COMPLETED")
  ok("repairs counted", r.repairs >= 1)
}

// ---------------------------------------------------------------------------
console.log("== meta lifecycle: cancellation ==")
{
  const runAgent = async (o) => {
    if (o.planOnly) return { text: "1. x", toolRecords: [], commandChecks: [], toolLog: [] }
    await new Promise((r) => setTimeout(r, 500))
    return { text: "working", budgetHit: true, steps: 12, toolRecords: [], commandChecks: [], toolLog: [] }
  }
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 50)
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const r = await meta.runMeta({ config: cfg, provider: { name: "x", model: "m" }, task: "long task", runAgent, signal: ac.signal })
  eq("cancelled task ends CANCELLED", r.status, "CANCELLED")
}

// ---------------------------------------------------------------------------
console.log("== security: new orchestration never bypasses the gate ==")
{
  // New orchestration modules contain NO shell execution primitive of their
  // own: every model-controlled command still flows through runAgent → tools
  // → Tool Intelligence → ShellGuard/SafePath/NetGuard. Scan source directly.
  const forgeDir = path.resolve(new URL("../forge/", import.meta.url).pathname)
  for (const m of ["meta.js", "taskstate.js", "dag.js", "resources.js", "modelstrategy.js", "agentmanager.js", "verifyledger.js", "lessons.js", "context.js"]) {
    const src = fs.readFileSync(path.join(forgeDir, m), "utf8")
    ok(`${m} does not import child_process`, !/child_process/.test(src))
  }
  // recovery.js may inspect git, but only via fixed-arg execFileSync (no shell)
  const recSrc = fs.readFileSync(path.join(forgeDir, "recovery.js"), "utf8")
  ok("recovery uses only fixed-arg git execFileSync (no shell exec)", /execFileSync\("git"/.test(recSrc) && !/[^F]exec\(|execSync\(/.test(recSrc))
  // lessons/memory writes are redacted: a secret never lands in lessons
  lessons.recordLesson({ failure: "key sk-abcdef1234567890abcdef1234567890 leaked", successfulRepair: "rotated it" }, WORK)
  const stored = JSON.stringify(lessons.loadLessons(WORK))
  ok("secrets redacted in stored lessons", !/sk-abcdef1234567890/.test(stored))
}

// ---------------------------------------------------------------------------
console.log(`\n== autonomy suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
