/**
 * v92 "PROCREW" — professional sub-agent intelligence.
 *
 *  1. crew work units: a plan becomes named-specialist units; roles come from
 *     the plan when it names one, from the wording when it does not; a sub-agent
 *     is never promoted to writer.
 *  2. duplicate work: two units with the same words are ONE unit — the second is
 *     refused before it costs a model call.
 *  3. conflict-free waves: units that touch the same file are never in the same
 *     wave, using dag's own conflict-key space.
 *  4. reassignment: a failed unit is retried under a DIFFERENT specialist, never
 *     the same one twice, and the ladder is exhausted honestly.
 *  5. self-review: a finding is reviewed before it is merged; a bad one is
 *     re-run once with the issues attached.
 *  6. rejected approaches: the Memory Agent's verdict store — a rejected
 *     approach is skipped, and a later ACCEPTED verdict cancels the rejection.
 *  7. verification pipeline: stages come from the project's own manifests, a
 *     missing command is skipped (never faked), pass/fail is verifyledger's
 *     call, a repair hook re-runs the stage, and evidence is complete.
 *  8. wiring: config defaults, meta.js runs both and returns their results,
 *     agent.crew:false / agent.pipeline:false restore the v91 path, the report
 *     carries the crew run and the pipeline table, `forge verify` exits non-zero
 *     on failure.
 *
 * Zero network. Isolated FORGE_HOME. No live model (injected runners/spawns).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v92-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"
const FORGE_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

const crew = await import("../crew.js")
const pipe = await import("../pipeline.js")
const mem = await import("../memory.js")
const orch = await import("../orchestra.js")
const dag = await import("../dag.js")
const lang = await import("../langengine.js")
const { TASK_CLASS } = await import("../classify.js")
const { ROLES, roleIsReadOnly } = await import("../agentmanager.js")
const { VERSION } = await import("../version.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const ROSTER = orch.rosterFor(TASK_CLASS.LARGE)
const member = (key) => ROSTER.find((r) => r.key === key)

// ---------------------------------------------------------------------------
console.log("== 1. work units: named specialists, one writer, never promoted ==")
{
  const steps = [
    { id: "n1", objective: "read the auth module and report the session API", targetFiles: ["lib/auth.js"] },
    { id: "n2", objective: "run the unit tests and report which fail", targetFiles: ["lib/auth.js"] },
    { id: "n3", objective: "review the diff for duplicates and dead code" },
    { id: "n4", objective: "update the README and CHANGELOG for the new flag" },
    { id: "n5", objective: "role:researcher", role: "researcher" },
  ]
  const units = crew.workUnits({ objective: "harden auth", steps, crew: ROSTER, context: "ctx" })
  eq("one unit per step", units.length, 5)
  eq("a task about RUNNING tests picks the tester", units[1] && units[1].key, "tester")
  eq("a task about a FAILURE picks the debugger", crew.workUnits({ objective: "x", steps: [{ id: "d", objective: "debug the stack trace in the auth crash" }], crew: ROSTER })[0].key, "debugger")
  ok("the review wording picks the reviewer", ["reviewer", "optimizer"].includes(units[2].key), units[2].key)
  eq("the docs wording picks the documentation writer", units[3].key, "documentation_writer")
  eq("an explicit role in the plan wins", units[4].key, "researcher")
  ok("every unit is read-only — a sub-agent never writes", units.every((u) => u.readOnly === true))
  ok("no unit is granted the writer role", units.every((u) => u.role !== ROLES.CODER))
  ok("the executor stays the only writer in the roster", orch.writersOf(ROSTER).length === 1 && orch.writersOf(ROSTER)[0].key === "executor")
  ok("task text is bounded", units.every((u) => u.task.length <= 2000))
  ok("context is bounded", units.every((u) => u.context.length <= crew.CREW_LIMITS.contextChars))

  // an explicit writer role is mapped, but the unit stays read-only
  const w = crew.workUnits({ objective: "x", steps: [{ id: "w", objective: "implement it", role: "executor" }], crew: ROSTER })
  eq("an executor step maps to the coder role", w[0].role, ROLES.CODER)
  eq("the plan's own read-only flag is preserved, not invented", w[0].readOnly, false)

  // limits
  const many = crew.workUnits({ objective: "x", steps: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, objective: `investigate thing number ${i}` })), crew: ROSTER })
  eq("the unit ceiling is enforced", many.length, crew.CREW_LIMITS.maxUnits)
  eq("roleForKey falls back to the researcher", crew.roleForKey("please do the thing"), "researcher")
}

// ---------------------------------------------------------------------------
console.log("== 2. duplicate work is refused before it costs a model call ==")
{
  const steps = [
    { id: "a", objective: "read the schema files and report the tables" },
    { id: "b", objective: "Read the schema files! And report the tables." },
    { id: "c", objective: "read the config loader and report the env vars" },
  ]
  const units = crew.workUnits({ objective: "x", steps, crew: ROSTER })
  const { units: kept, duplicates } = crew.dedupeUnits(units)
  eq("the re-worded duplicate is caught", duplicates.length, 1)
  eq("the distinct unit survives", kept.length, 2)
  eq("the duplicate names its twin", duplicates[0].sameAs, "a")
  ok("fingerprints are stable", crew.fingerprint(kept[0]) === crew.fingerprint(kept[0]))
  ok("different tasks get different fingerprints", crew.fingerprint(kept[0]) !== crew.fingerprint(kept[1]))
  ok("the kept units carry their fingerprint", kept.every((u) => typeof u.fingerprint === "string"))
}

// ---------------------------------------------------------------------------
console.log("== 3. waves: units that clash on a file never run together ==")
{
  const steps = [
    { id: "x1", objective: "read the auth module first pass", targetFiles: ["lib/auth.js"] },
    { id: "x2", objective: "read the auth module second pass", targetFiles: ["lib/auth.js"] },
    { id: "x3", objective: "read the db layer", targetFiles: ["lib/db.js"] },
  ]
  const { units } = crew.dedupeUnits(crew.workUnits({ objective: "x", steps, crew: ROSTER }))
  const w = crew.waves(units, { maxParallel: 8 })
  eq("the clash splits into two waves", w.length, 2)
  eq("wave one holds the two disjoint units", w[0].length, 2)
  eq("wave two holds the clashing unit", w[1].length, 1)
  ok("the conflict keys are dag's own key space", crew.conflictKeysOf(units[0]).includes("file:lib/auth.js"))
  ok("dag.canonicalConflictKeys agrees", dag.canonicalConflictKeys(units[0]).includes("file:lib/auth.js"))
  const capped = crew.waves(units, { maxParallel: 1 })
  eq("maxParallel 1 serialises", capped.length, 3)
  ok("an empty list yields no waves", crew.waves([]).length === 0)
}

// ---------------------------------------------------------------------------
console.log("== 4. reassignment: a different specialist, never the same one twice ==")
{
  const next = crew.reassignFor({ key: "researcher" }, ROSTER, ["researcher"])
  eq("a failed researcher escalates to the debugger", next.key, "debugger")
  const next2 = crew.reassignFor({ key: "researcher" }, ROSTER, ["researcher", "debugger"])
  eq("and then to the architect", next2.key, "project_architect")
  ok("the ladder never repeats a tried role", ["researcher", "debugger"].includes(next2.key) === false)
  const exhausted = crew.reassignFor({ key: "git_manager" }, ROSTER, ["git_manager", "researcher"])
  eq("an exhausted ladder returns null, honestly", exhausted, null)
  const unknown = crew.reassignFor({ key: "not_a_role" }, ROSTER, [])
  ok("an unknown role still gets a fallback", unknown && typeof unknown.key === "string", JSON.stringify(unknown?.key))
  ok("reassignment never hands back the writer", crew.reassignFor({ key: "executor" }, ROSTER, ["executor"]).key !== "executor")
}

// ---------------------------------------------------------------------------
console.log("== 5. self-review before merge ==")
{
  const empty = crew.selfReview({ unit: { task: "x" }, text: "" })
  eq("an empty finding fails review", empty.ok, false)
  const fine = crew.selfReview({ unit: { task: "read the auth module", objective: "harden auth" }, text: "lib/auth.js exports createSession(token, ttl) at line 40; sessions.js stores them in a Map; no expiry check exists." })
  ok("a concrete finding passes (or is skipped, never invented)", fine.ok === true || fine.skipped === true, JSON.stringify(fine))
  ok("issues are bounded", (fine.issues || []).length <= 4)
}

// ---------------------------------------------------------------------------
console.log("== 6. runCrew: parallel dispatch, dedupe, reassignment, merge ==")
{
  const steps = [
    { id: "r1", objective: "read the session store and report the API", targetFiles: ["lib/sess.js"] },
    { id: "r2", objective: "read the token issuer and report the claims", targetFiles: ["lib/tok.js"] },
  ]
  const { units } = crew.dedupeUnits(crew.workUnits({ objective: "harden auth", steps, crew: ROSTER }))
  const spawned = []
  let calls = 0
  const result = await crew.runCrew({
    units, crew: ROSTER, maxParallel: 4,
    spawn: async (u) => {
      calls += 1
      spawned.push(u.role)
      ok("the spawn is read-only", u.readOnly === true)
      return { status: "completed", result: `finding for ${u.stepId}: the file exports two functions and one of them never checks expiry.` }
    },
  })
  eq("every unit produced a finding", result.results.filter((r) => r.ok).length, 2)
  eq("one model call per unit — no duplicate work", calls, 2)
  eq("modelCalls is accounted", result.modelCalls, 2)
  ok("the merged text names both specialists", /researcher|tester|reviewer/.test(result.findings), result.findings.slice(0, 80))
  ok("the merge came from integrateResults", typeof result.merged === "object")
  ok("results carry the caller's step id", result.results.every((r) => r.stepId))
  eq("the run is ok", result.ok, true)
  ok("formatCrew reports the run", /crew: 2\/2/.test(crew.formatCrew(result)), crew.formatCrew(result).split("\n")[0])

  // a unit that fails is reassigned ONCE, then reported as failed
  const failedRun = await crew.runCrew({
    units: crew.workUnits({ objective: "x", steps: [{ id: "f1", objective: "read the broken thing", targetFiles: ["a.js"] }], crew: ROSTER }),
    crew: ROSTER,
    spawn: async (u) => { spawned.push(u.role); return u.role === "researcher" ? { status: "completed", result: "" } : { status: "completed", result: `second opinion on ${u.stepId}: the parser rejects an empty header.` } },
  })
  eq("the reassigned specialist rescued the unit", failedRun.results[0].ok, true)
  eq("it took two attempts", failedRun.results[0].attempts, 2)
  eq("exactly one reassignment was recorded", failedRun.reassigned, 1)
  ok("the reassignment changed the specialist", failedRun.results[0].key !== "researcher", failedRun.results[0].key)

  // a unit that fails under BOTH specialists is reported failed, not hidden
  const hopeless = await crew.runCrew({
    units: crew.workUnits({ objective: "x", steps: [{ id: "h1", objective: "read the broken thing", targetFiles: ["a.js"] }], crew: ROSTER }),
    crew: ROSTER,
    spawn: async () => ({ status: "error", result: "", error: "provider exploded" }),
  })
  eq("a hopeless unit fails honestly", hopeless.results[0].ok, false)
  eq("it stopped at the attempt ceiling", hopeless.results[0].attempts, crew.CREW_LIMITS.maxAttemptsPerUnit)
  eq("the failure is listed", hopeless.failed.length, 1)
  ok("the error is carried through", /provider exploded/.test(hopeless.results[0].error))

  // a previously rejected approach is never attempted
  const rejected = await crew.runCrew({
    units: crew.workUnits({ objective: "x", steps: [{ id: "j1", objective: "bump the timeout to hide the leak" }], crew: ROSTER }),
    crew: ROSTER,
    isRejected: () => true,
    spawn: async () => { throw new Error("must not be called") },
  })
  eq("the rejected unit was skipped, not run", rejected.results[0].skipped, true)
  eq("and reported in skipped", rejected.skipped.length, 1)
  eq("no model call was spent on it", rejected.modelCalls, 0)
}

// ---------------------------------------------------------------------------
console.log("== 7. the Memory Agent's verdict store ==")
{
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v92-proj-"))
  eq("recording a rejection works", mem.recordVerdict(mem.VERDICT.REJECTED, "raise the socket timeout to 300 seconds", { reason: "masks the leak", cwd: proj }).ok, true)
  eq("recording an acceptance works", mem.recordVerdict(mem.VERDICT.ACCEPTED, "cache the repo index by mtime", { cwd: proj }).ok, true)
  eq("an unknown verdict kind is refused", mem.recordVerdict("maybe", "x", { cwd: proj }).ok, false)
  eq("an empty approach is refused", mem.recordVerdict(mem.VERDICT.REJECTED, "  ", { cwd: proj }).ok, false)
  const v = mem.verdicts(proj)
  eq("one accepted, one rejected", [v.accepted.length, v.rejected.length], [1, 1])
  eq("the reason is preserved", v.rejected[0].reason, "masks the leak")
  const hit = mem.isRejectedApproach("raise the socket timeout to 300 seconds please", { cwd: proj })
  eq("a re-worded rejected approach still matches", hit.rejected, true)
  ok("the match is named", /timeout/.test(hit.match), hit.match)
  eq("an unrelated approach does not match", mem.isRejectedApproach("rewrite the parser in rust", { cwd: proj }).rejected, false)
  eq("a too-short approach cannot match", mem.isRejectedApproach("it", { cwd: proj }).rejected, false)
  // an accepted verdict for the same shape cancels the rejection
  mem.recordVerdict(mem.VERDICT.ACCEPTED, "raise the socket timeout to 300 seconds", { reason: "user changed their mind", cwd: proj })
  eq("a later acceptance cancels the rejection", mem.isRejectedApproach("raise the socket timeout to 300 seconds", { cwd: proj }).rejected, false)
  ok("the prompt block says what not to retry", /do NOT propose these again/.test(mem.verdictBlock(proj)), mem.verdictBlock(proj))
  eq("an empty project has no verdicts", [mem.verdicts(fs.mkdtempSync(path.join(os.tmpdir(), "forge-v92-empty-"))).rejected.length], [0])
}

// ---------------------------------------------------------------------------
console.log("== 8. verification pipeline: real stages, never faked ==")
{
  // a project with a full script set
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v92-pipe-"))
  fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "p", scripts: { build: "tsc -b", lint: "eslint .", typecheck: "tsc --noEmit", test: "node --test", validate: "node check.js" } }))
  const stages = pipe.detectStages({ cwd: proj, files: ["src/a.ts"] })
  eq("the stage vocabulary is fixed", Object.values(pipe.STAGE), [...pipe.STAGE_ORDER])
  ok("every stage has a stated purpose", pipe.STAGE_ORDER.every((id) => pipe.STAGE_PURPOSE[id]?.length > 5))
  eq("all five stages are detected", stages.map((s) => s.id), [...pipe.STAGE_ORDER])
  eq("readScripts is not part of the public surface", typeof (await import("../pipeline.js")).readScripts, "undefined")
  ok("the default runner really runs a command", pipe.defaultRunner("exit 0", { cwd: proj }).exitCode === 0)
  eq("and reports a non-zero status honestly", pipe.defaultRunner("exit 7", { cwd: proj }).exitCode, 7)
  ok("every stage has a real command", stages.every((s) => s.available && s.command))
  eq("package scripts win over the stack", stages.find((s) => s.id === "test").command, "npm test")
  eq("the test form matches langengine's stack", stages.find((s) => s.id === "test").command, lang.stackFor(proj, ["src/a.ts"]).test)
  ok("the source is named", /package.json script/.test(stages.find((s) => s.id === "lint").source))

  // a project with nothing: skipped, never invented
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v92-bare-"))
  const none = pipe.detectStages({ cwd: bare, files: [] })
  ok("no command is invented for a bare project", none.every((s) => !s.available && !s.command))
  ok("each skip explains itself", none.every((s) => /no .* command/.test(s.reason)))

  // only / skip
  const plan = pipe.planPipeline({ cwd: proj, files: ["src/a.ts"], only: ["test", "lint"] })
  eq("only[] selects", plan.stages.map((s) => s.id), ["lint", "test"])
  eq("the rest are skipped with a reason", plan.skipped.length, 3)
  const plan2 = pipe.planPipeline({ cwd: proj, files: ["src/a.ts"], skip: ["lint"] })
  ok("skip[] removes a stage", !plan2.stages.some((s) => s.id === "lint"))
  eq("the cap is bounded by the stage count", pipe.planPipeline({ cwd: proj, files: ["src/a.ts"], maxStages: 2 }).stages.length, 2)

  // pass
  const green = await pipe.runPipeline({ plan, cwd: proj, run: async () => ({ exitCode: 0, output: "2 tests passed" }) })
  eq("a green pipeline is ok", green.ok, true)
  eq("both stages passed", green.passedCount, 2)
  ok("the verdict says PASS", pipe.pipelineVerdict(green).ok === true)

  // fail — and pass/fail is verifyledger's call, not ours
  const red = await pipe.runPipeline({ plan, cwd: proj, run: async () => ({ exitCode: 1, output: "AssertionError: expected 1 to equal 2" }) })
  eq("a failing stage fails the pipeline", red.ok, false)
  eq("the failure shape is diagnosed", red.stages[0].failureShape, "test_failure")
  ok("the verdict names the stage", /lint|test/.test(pipe.pipelineVerdict(red).reason), pipe.pipelineVerdict(red).reason)
  ok("formatPipeline marks it", /✗/.test(pipe.formatPipeline(red)))

  // regression: a TAP summary of "# fail 0" is a CLEAN run. A bare \bFAIL\b in
  // verifyledger's shape table matched it, so any project whose runner prints a
  // zero failure count was diagnosed as a test failure.
  const vl = await import("../verifyledger.js")
  eq("a zero failure count is not a failure shape", vl.detectFailureShape("TAP version 13\n1..0\n# tests 0\n# pass 0\n# fail 0"), null)
  eq("a non-zero count still is", vl.detectFailureShape("# tests 4\n# pass 1\n# fail 3"), "test_failure")
  eq("a named failing file still is", vl.detectFailureShape("FAIL src/app.test.js"), "test_failure")
  eq("and so is a real assertion failure", vl.detectFailureShape("3 tests failed in auth.spec.ts"), "test_failure")
  const zeroTests = await pipe.runPipeline({ plan: pipe.planPipeline({ cwd: proj, files: ["a.ts"], only: ["test"] }), cwd: proj, run: async () => ({ exitCode: 0, output: "1..0\n# tests 0\n# pass 0\n# fail 0" }) })
  eq("a clean zero-test run is not a false failure", zeroTests.ok, true)

  // exit 0 with a failure shape still fails (the ledger's rule, unchanged)
  const lyingGreen = await pipe.runPipeline({ plan, cwd: proj, run: async () => ({ exitCode: 0, output: "FAIL src/app.test.js — 3 failed" }) })
  eq("exit 0 with a failure shape is NOT a pass", lyingGreen.ok, false)

  // unknown exit status never passes
  const unknown = await pipe.runPipeline({ plan: pipe.planPipeline({ cwd: proj, files: ["a.ts"], only: ["test"] }), cwd: proj, run: async () => ({ exitCode: null, output: "…" }) })
  eq("an unobserved exit status is not a pass", unknown.ok, false)

  // a repair hook re-runs the stage; without one there is no retry
  let attempts = 0
  const repaired = await pipe.runPipeline({
    plan: pipe.planPipeline({ cwd: proj, files: ["a.ts"], only: ["test"] }), cwd: proj,
    opts: { maxRepairs: 2 },
    run: async () => { attempts += 1; return attempts === 1 ? { exitCode: 1, output: "test failed" } : { exitCode: 0, output: "1 test passed" } },
    onRepair: async () => true,
  })
  eq("the repair re-ran the stage", attempts, 2)
  eq("and it then passed", repaired.ok, true)
  eq("the repair is counted", repaired.repairs, 1)
  const noHook = await pipe.runPipeline({ plan: pipe.planPipeline({ cwd: proj, files: ["a.ts"], only: ["test"] }), cwd: proj, opts: { maxRepairs: 5 }, run: async () => ({ exitCode: 1, output: "test failed" }) })
  eq("without a repair hook there is exactly one attempt", noHook.stages[0].attempts, 1)

  // stopOnFailure skips the rest, with a reason
  const stopped = await pipe.runPipeline({ plan, cwd: proj, opts: { stopOnFailure: true }, run: async () => ({ exitCode: 1, output: "build failed" }) })
  ok("later stages are marked not-run with a reason", stopped.stages.some((s) => s.skippedRun && /earlier stage/.test(s.reason)))

  // an empty plan is not a pass
  const nothing = await pipe.runPipeline({ plan: { stages: [], skipped: [] }, cwd: proj, run: async () => ({ exitCode: 0, output: "" }) })
  eq("an empty pipeline is not ok", nothing.ok, false)
  ok("and says why", /no verification stage/.test(pipe.pipelineVerdict(nothing).reason))

  // stage → ledger type mapping and diagnosis vocabulary
  eq("build maps to the ledger's BUILD type", pipe.typeForStage("build"), "build")
  eq("test maps to the regression type", pipe.typeForStage("test"), "regression_test")
  const d = pipe.diagnose({ failureShape: "not_found", output: "sh: pytest: not found" })
  eq("diagnosis carries the shape", d.shape, "not_found")
  ok("and a hint that is not a platitude", d.hint.length > 12, d.hint)
  ok("every failure shape has a hint", Object.keys((await import("../verifyledger.js")).FAILURE_SHAPES.reduce((a, s) => (a[s.kind] = 1, a), {})).every((k) => pipe.diagnose({ failureShape: k }).hint.length > 5))
}

// ---------------------------------------------------------------------------
console.log("== 9. the stackFor refactor did not change recommendedVerify ==")
{
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v92-lang-"))
  fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "x", scripts: { test: "vitest run" } }))
  const s = lang.stackFor(proj, ["src/a.js"])
  // inspectProject normalises a package script to its package-manager command
  ok("stackFor returns the whole stack", s && s.id === "javascript" && s.test === "npm test", JSON.stringify(s))
  eq("recommendedVerify still returns the first real command", lang.recommendedVerify(proj, ["src/a.js"]), "npm test")
  eq("an empty dir has no stack", lang.stackFor(fs.mkdtempSync(path.join(os.tmpdir(), "forge-v92-nostack-")), []), null)
  eq("and no recommended command", lang.recommendedVerify(fs.mkdtempSync(path.join(os.tmpdir(), "forge-v92-nostack2-")), []), "")
}

// ---------------------------------------------------------------------------
console.log("== 10. wiring: config, meta.js, report, CLI ==")
{
  const { defaultConfig } = await import("../config.js")
  const cfg = defaultConfig()
  eq("the crew is on by default", cfg.agent.crew, true)
  eq("the pipeline is on by default", cfg.agent.pipeline, true)
  eq("the per-stage timeout has a real default", cfg.agent.verifyTimeoutMs, 300_000)
  // the v91 switches are untouched
  eq("orchestration/objective/report still default on", [cfg.agent.orchestration, cfg.agent.objective, cfg.agent.report], [true, true, true])

  const metaSrc = fs.readFileSync(path.join(FORGE_DIR, "meta.js"), "utf8")
  const crewSrc = fs.readFileSync(path.join(FORGE_DIR, "crew.js"), "utf8")
  // the scheduler's own events live in crew.js; meta.js forwards them stamped
  // with the task identity, and owns the duplicate/rejected/pipeline events
  for (const ev of ["CREW_DISPATCH", "CREW_UNIT", "CREW_REASSIGNED", "CREW_UNIT_SKIPPED", "CREW_MERGED"]) {
    ok(`crew.js emits ${ev}`, crewSrc.includes(ev))
  }
  for (const ev of ["CREW_DUPLICATE_SKIPPED", "CREW_REJECTED_APPROACH", "CREW_DEADLINE", "CREW_FAILED", "PIPELINE_PLANNED", "PIPELINE_RESULT", "PIPELINE_DIAGNOSIS", "PIPELINE_ERROR"]) {
    ok(`meta.js emits ${ev}`, metaSrc.includes(ev))
  }
  const pipeSrc = fs.readFileSync(path.join(FORGE_DIR, "pipeline.js"), "utf8")
  for (const ev of ["PIPELINE_STAGE_STARTED", "PIPELINE_STAGE", "PIPELINE_REPAIR"]) {
    ok(`pipeline.js emits ${ev}`, pipeSrc.includes(ev))
  }
  ok("meta.js stamps crew events with the task identity", /emit: \(ev\) => emit\(\{ taskId, runId: taskRunId, segmentId, \.\.\.ev \}\)/.test(metaSrc))
  ok("meta.js routes the fan-out through crew.js", /runCrewBatch\(/.test(metaSrc) && /from "\.\/crew\.js"/.test(metaSrc))
  ok("there is exactly one worker spawn site", (metaSrc.match(/manager\.spawn\(/g) || []).length === 1)
  ok("a repair invalidates the pipeline evidence", /pipelineStale = true/.test(metaSrc))
  ok("pipeline evidence is recorded before the gate judges", metaSrc.indexOf("PIPELINE_RESULT") < metaSrc.indexOf("const v = ledger.status(finalRiskLevel"))
  ok("the pipeline is opt-out, not opt-in", /config\?\.agent\?\.pipeline !== false/.test(metaSrc))

  // the report carries both
  const rep = await import("../report.js")
  const r = rep.buildReport({
    objective: null, task: null, gate: null,
    crewRun: { units: 4, findings: 3, modelCalls: 4, reassigned: 1, duplicates: 1, skipped: 1, deadlineHit: 0 },
    pipeline: { ms: 1200, repairs: 1, stages: [{ id: "test", command: "npm run test", passed: true, attempts: 2, repairs: 1, evidence: "2 passed" }], skipped: [] },
  })
  const byId = Object.fromEntries(r.sections.map((s) => [s.id, s.lines.join("\n")]))
  ok("the analysis names the crew run", /crew run: 3\/4/.test(byId.analysis), byId.analysis)
  ok("the analysis reports the reassignment", /1 reassigned/.test(byId.analysis))
  ok("the verification section carries the pipeline", /verification pipeline/.test(byId.verification), byId.verification)
  ok("and the stage result", /npm run test/.test(byId.verification))
  // an empty report still says so, and never invents a crew run
  const bare = rep.buildReport({})
  const bareId = Object.fromEntries(bare.sections.map((s) => [s.id, s.lines.join("\n")]))
  ok("no crew run is claimed when there was none", !/crew run/.test(bareId.analysis), bareId.analysis)
  ok("no pipeline is claimed when none ran", !/verification pipeline/.test(bareId.verification), bareId.verification)

  // the CLI exits non-zero on failure, zero on success
  const { execFileSync } = await import("node:child_process")
  const cliProj = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v92-cli-"))
  fs.writeFileSync(path.join(cliProj, "package.json"), JSON.stringify({ name: "c", scripts: { test: "exit 0" } }))
  const run = (args, cwd) => {
    try {
      const out = execFileSync(process.execPath, [path.join(FORGE_DIR, "forge.js"), ...args], { cwd, encoding: "utf8", env: { ...process.env, FORGE_HOME: HOME, NO_COLOR: "1" }, timeout: 120_000 })
      return { code: 0, out }
    } catch (e) { return { code: e.status, out: String(e.stdout ?? "") + String(e.stderr ?? "") } }
  }
  const passRun = run(["verify", "--json"], cliProj)
  eq("forge verify exits 0 when the stage passes", passRun.code, 0)
  ok("and the JSON says ok", /"ok": true/.test(passRun.out), passRun.out.slice(0, 160))
  fs.writeFileSync(path.join(cliProj, "package.json"), JSON.stringify({ name: "c", scripts: { test: "exit 3" } }))
  const failRun = run(["verify", "--json"], cliProj)
  eq("forge verify exits 1 when the stage fails", failRun.code, 1)
  ok("and names the stage", /"id": "test"/.test(failRun.out), failRun.out.slice(0, 160))
  const noStage = run(["verify", "--json"], fs.mkdtempSync(path.join(os.tmpdir(), "forge-v92-nostage-")))
  eq("forge verify refuses to fake a stage it cannot run", noStage.code, 1)
  ok("and says nothing was faked", /no build command/.test(noStage.out) || /skipped/.test(noStage.out), noStage.out.slice(0, 160))
  const helpOut = run(["--help"], FORGE_DIR)
  ok("forge verify is in the help", /forge verify/.test(helpOut.out))

  // every new module ships in the package
  const pkg = JSON.parse(fs.readFileSync(path.join(FORGE_DIR, "package.json"), "utf8"))
  for (const f of ["crew.js", "pipeline.js"]) ok(`${f} is in files[]`, pkg.files.includes(f))
  ok("the version is 92.0.0", VERSION === "92.0.0", VERSION)
  eq("package.json agrees", pkg.version, "92.0.0")
}

// ---------------------------------------------------------------------------
console.log("== 11. meta integration: the crew and the pipeline really run ==")
{
  const meta = await import("../meta.js")

  const mkProject = (testScript) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v92-run-"))
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: testScript } }))
    fs.writeFileSync(path.join(dir, "lib.js"), "export const add = (a, b) => a + b\n")
    return dir
  }
  // a stub agent that behaves like the real one: a plan, read-only sub-agent
  // findings, and a writer that actually changes a file
  const stubAgent = (calls = { n: 0 }) => async (o = {}) => {
    calls.n += 1
    if (o.planOnly) {
      return {
        text: "1. inspect lib.js\n2. add subtract\n3. run the tests",
        toolRecords: [], commandChecks: [], toolLog: [],
        plan: [
          { id: "n1", objective: "read lib.js and report the exported API", role: "researcher", read_only: true, targetFiles: ["lib.js"] },
          { id: "n2", objective: "run the unit tests and report the results", role: "tester", read_only: true },
        ],
      }
    }
    if (o.worker) return { text: `finding for ${o.worker.dagNode}: lib.js exports add(a,b); there is no subtract and no test file.`, toolRecords: [], commandChecks: [], toolLog: [] }
    fs.appendFileSync(path.join(process.cwd(), "lib.js"), "export const subtract = (a, b) => a - b\n")
    return {
      text: "Added subtract and verified.",
      toolRecords: [{ tool: "edit_file", files_changed: ["lib.js"] }],
      commandChecks: [{ command: "npm test", tail: "1 test passed", exitCode: 0, at: Date.now() }],
      toolLog: [{ name: "edit_file" }],
    }
  }
  const baseCfg = (over = {}) => ({ providers: {}, agent: { autonomous: true, modelStrategy: false, maxRepairs: 3, ...over }, tools: { autoApprove: true, unrestricted: true } })
  const run = async (dir, cfg, task = "add a subtract function to lib.js") => {
    const prev = process.cwd()
    process.chdir(dir)
    const events = []
    try {
      const r = await meta.runMeta({ config: cfg, provider: { name: "x", model: "m" }, task, runAgent: stubAgent(), workers: 2, onEvent: (ev) => events.push(ev), signal: new AbortController().signal })
      return { r, events, types: events.map((e) => e.type) }
    } finally { process.chdir(prev) }
  }

  // A. a project whose tests pass: the pipeline runs and the crew dispatches
  const a = await run(mkProject("node --test"), baseCfg())
  ok("the crew dispatched at least one unit", a.r.crew.units >= 1, JSON.stringify(a.r.crew))
  ok("a sub-agent produced a finding", a.r.crew.findings >= 1)
  ok("the pipeline ran", !!a.r.pipeline, JSON.stringify(a.r.pipeline))
  eq("and it passed", a.r.pipeline.ok, true)
  eq("with exactly one stage this project can run", a.r.pipeline.stages.filter((x) => !x.skipped).length, 1)
  ok("CREW_DISPATCH was emitted", a.types.includes("CREW_DISPATCH"))
  ok("CREW_MERGED was emitted", a.types.includes("CREW_MERGED"))
  ok("PIPELINE_RESULT was emitted", a.types.includes("PIPELINE_RESULT"))
  ok("the pipeline evidence reached the ledger before the gate", a.types.indexOf("PIPELINE_RESULT") < a.types.lastIndexOf("VERIFICATION_STATUS"))
  const aSec = Object.fromEntries(a.r.report.sections.map((x) => [x.id, x.lines.join("\n")]))
  ok("the report carries the crew run", /crew run:/.test(aSec.analysis), aSec.analysis)
  ok("the report carries the pipeline table", /verification pipeline/.test(aSec.verification))
  ok("and the skipped stages are listed, not hidden", /skipped — no build command/.test(aSec.verification))
  ok("no [object Object] leaked into the report", !Object.values(aSec).some((t) => /\[object Object\]/.test(t)))

  // B. a project whose tests always fail: repair until success OR report a
  //    blocking issue — never repair the same failure until the fuse
  const b = await run(mkProject("exit 3"), baseCfg())
  eq("the pipeline reports the failure", b.r.pipeline.ok, false)
  ok("the diagnosis was emitted", b.types.includes("PIPELINE_DIAGNOSIS"))
  ok("repairs were attempted and then bounded", b.types.includes("REPAIR_GAVE_UP"), JSON.stringify(b.types.filter((t) => /REPAIR/.test(t))))
  const blocker = (b.r.objective?.blockers || []).find((x) => x.reason === "VERIFICATION_NOT_RECOVERING")
  ok("a non-recoverable blocker was recorded", !!blocker && blocker.recoverable === false, JSON.stringify(b.r.objective?.blockers?.map((x) => x.reason)))
  ok("the run did not claim success", b.r.status !== "COMPLETED", b.r.status)
  ok("the run stopped well before the segment fuse", b.r.segments <= 8, String(b.r.segments))
  const bSec = Object.fromEntries(b.r.report.sections.map((x) => [x.id, x.lines.join("\n")]))
  ok("the remaining issue is in the report", /VERIFICATION_NOT_RECOVERING|could not be satisfied/.test(bSec.remaining_issues), bSec.remaining_issues.slice(0, 160))

  // C. agent.pipeline:false restores the v91 verification path
  const c = await run(mkProject("node --test"), baseCfg({ pipeline: false }))
  eq("no pipeline result", c.r.pipeline, null)
  ok("and no pipeline event", !c.types.some((t) => String(t).startsWith("PIPELINE_")))
  ok("the run still completes its lifecycle", !!c.r.objective)

  // D. agent.crew:false turns the fan-out off — no orphaned nodes, no second path
  const d = await run(mkProject("node --test"), baseCfg({ crew: false }))
  eq("no crew units were dispatched", d.r.crew.units, 0)
  ok("CREW_DISABLED was emitted", d.types.includes("CREW_DISABLED"))
  ok("no worker was spawned", !d.types.includes("WORKER_QUEUED"))
  ok("the DAG still had an owner for its read-only nodes", d.types.includes("DAG_NODE_STARTED"))
}

console.log(`\n== v92 suite: ${PASS} passed, ${FAIL} failed ==`)
if (FAIL) process.exit(1)
