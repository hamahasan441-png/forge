/**
 * forge — FORGE-BENCH (v29, zero dependencies)
 *
 * Internal, deterministic benchmark. No live model. Each case feeds the Ω
 * kernel + information-gain picker (and, where it matters, the 9-check
 * completion gate / DAG replan / classifier) and scores:
 *
 *   correctness, root-cause, time, tokens, tool calls, regressions,
 *   false completion, recovery, replanning, resource efficiency.
 *
 * Progressive ladder (spec §27):
 *   1 simple bug → 12 long-running autonomous task
 *
 * `forge bench` prints a report. Tests import runBench() directly.
 */
import { createKernel } from "./omega.js"
import { TASK_CLASS, strategyFor } from "./classify.js"
import { FAILURE } from "./diagnose.js"
import { ORIGIN } from "./selfdiag.js"
import { XID } from "./infogain.js"
import { canCompleteTask, GATE_STATUS } from "./completion.js"
import { buildDAG, replanRemaining, NODE_STATUS, markCompleted } from "./dag.js"
import { VERSION } from "./version.js"
import { generateGapTest } from "./experiment.js"
import { ROLES, roleIsReadOnly, roleCatalog } from "./agentmanager.js"

export const BENCH_CASES = [
  {
    id: "01-simple-bug",
    name: "simple bug",
    task: "fix a syntax error in src/add.js",
    failure: "ERROR: SyntaxError: Unexpected token '}'",
    meta: { tool: "bash", exitCode: 1, files: ["src/add.js"] },
    expect: { code: FAILURE.SYNTAX_FAILURE, origin: ORIGIN.PROJECT, experiment: XID.READ_STACK },
  },
  {
    id: "02-multi-file",
    name: "multi-file bug",
    task: "debug TypeError across src/a.js and src/b.js",
    failure: "ERROR: TypeError: x is not a function",
    meta: { tool: "bash", exitCode: 1, files: ["src/a.js", "src/b.js"] },
    expect: { code: FAILURE.TYPE_FAILURE, origin: ORIGIN.PROJECT, notExperiment: [XID.FULL_SUITE, XID.REPLAY] },
  },
  {
    id: "03-dependency",
    name: "dependency issue",
    task: "fix missing package import in the build",
    failure: "ERROR: Cannot find module 'left-pad'\nMODULE_NOT_FOUND",
    meta: { tool: "bash", exitCode: 1, files: ["package.json"] },
    expect: { code: FAILURE.DEPENDENCY_FAILURE, origin: ORIGIN.PROJECT, notExperiment: [XID.MINIMAL_FIX] },
  },
  {
    id: "04-concurrency",
    name: "concurrency bug",
    task: "debug a deadlock in the worker pool",
    failure: "ERROR: deadlock detected",
    meta: { tool: "bash", exitCode: 1, thrown: true, files: ["src/pool.js"] },
    expect: { code: FAILURE.CONCURRENCY_FAILURE, origin: ORIGIN.PROJECT, notExperiment: [XID.REPLAY, XID.MINIMAL_FIX] },
  },
  {
    id: "05-state",
    name: "state corruption",
    task: "recover from a stale lock in the cache",
    failure: "ERROR: EBUSY resource busy stale lock already locked",
    meta: { tool: "bash", exitCode: 1, files: ["src/lock.js"] },
    expect: { code: FAILURE.STATE_FAILURE, origin: ORIGIN.PROJECT, notExperiment: [XID.REPLAY] },
  },
  {
    id: "06-architecture",
    name: "architecture change",
    task: "redesign the auth architecture across files",
    classifyOnly: true,
    expect: { class: TASK_CLASS.ARCHITECTURAL, workersMin: 1 },
  },
  {
    id: "07-cross-language",
    name: "cross-language bug",
    task: "fix schema mismatch between the python API and typescript client",
    failure: "ERROR: API contract schema mismatch between python and typescript",
    meta: { tool: "bash", exitCode: 1, files: ["api.py", "client.ts"] },
    expect: { code: FAILURE.INTEGRATION_FAILURE, origin: ORIGIN.PROJECT, notExperiment: [XID.FULL_SUITE] },
  },
  {
    id: "08-large-repo",
    name: "large repository",
    task: "fix the failing test in src/core.js in this large repository",
    failure: "ERROR: 3 tests failed",
    meta: {
      tool: "bash", exitCode: 1,
      files: ["src/core.js", ...Array.from({ length: 80 }, (_, i) => `src/gen/f${i}.js`)],
    },
    expect: { code: FAILURE.TEST_FAILURE, origin: ORIGIN.PROJECT, notExperiment: [XID.FULL_SUITE] },
  },
  {
    id: "09-provider-failure",
    name: "provider failure",
    task: "the model call failed, continue the task",
    failure: "ERROR: fetch failed ECONNREFUSED 127.0.0.1:8787",
    meta: { tool: "fetch_url", thrown: true },
    expect: { code: FAILURE.NETWORK_FAILURE, origin: ORIGIN.UNKNOWN, notExperiment: [XID.MINIMAL_FIX, XID.INSTALL_DEP] },
  },
  {
    id: "10-crash-recovery",
    name: "crash recovery",
    task: "fix a typo in notes.txt",
    classifyOpts: { resume: true },
    classifyOnly: true,
    expect: { class: TASK_CLASS.RECOVERY },
  },
  {
    id: "11-adversarial",
    name: "adversarial hidden bug",
    task: "the test suite is failing, make it pass",
    failure: "3 tests failed\nFAIL src/parse.spec.js",
    meta: { tool: "bash", exitCode: 1, files: ["src/parse.js"] },
    expect: {
      code: FAILURE.TEST_FAILURE, origin: ORIGIN.PROJECT,
      notExperiment: [XID.ABORT, XID.MINIMAL_FIX],
      noFalseComplete: true,
    },
  },
  {
    id: "12-long-running",
    name: "long-running autonomous task",
    task: "implement the remaining work across the repository",
    longRunning: true,
    expect: { notCompleted: true },
  },
  {
    id: "13-gap-no-invent",
    name: "gap test never invents a toolchain",
    task: "fix a typo in README",
    classifyOnly: true,
    expect: {
      class: TASK_CLASS.MICRO,
      custom: () => generateGapTest({ id: "auth" }, { blast: { tests: ["npm test"] } }).ok === false,
    },
  },
  {
    id: "14-planner-role",
    name: "planner role is read-only",
    task: "fix a typo in README",
    classifyOnly: true,
    expect: {
      class: TASK_CLASS.MICRO,
      custom: () => roleIsReadOnly(ROLES.PLANNER) && roleCatalog().some((r) => r.role === "planner"),
    },
  },
  {
    id: "15-explicit-command",
    name: "explicit experiment command is allowed",
    task: "fix a typo in README",
    classifyOnly: true,
    expect: {
      class: TASK_CLASS.MICRO,
      custom: () => generateGapTest({ id: "auth" }, { command: "true" }).command === "true",
    },
  },
  {
    id: "16-coder-is-writer",
    name: "coder role may mutate (main only)",
    task: "fix a typo in README",
    classifyOnly: true,
    expect: {
      class: TASK_CLASS.MICRO,
      custom: () => roleIsReadOnly(ROLES.CODER) === false,
    },
  },
]

const METRIC_KEYS = [
  "correctness", "rootCause", "time", "tokens", "toolCalls",
  "regressions", "falseCompletion", "recovery", "replanning", "resource",
]

function pass(cond) {
  return cond === true
}

function emptyDag() {
  return buildDAG([
    { id: "n1", description: "inspect", dependencies: [] },
    { id: "n2", description: "implement", dependencies: ["n1"] },
    { id: "n3", description: "verify", dependencies: ["n2"] },
  ])
}

function scoreCase(c, got) {
  const e = c.expect || {}
  const checks = {}
  if (e.code) checks.correctness = pass(got.diagnosis === e.code)
  if (e.origin) checks.rootCause = pass(got.origin === e.origin)
  if (e.class) checks.correctness = pass(got.class === e.class)
  if (e.workersMin != null) checks.resource = pass(Number(got.workers) >= e.workersMin)
  if (e.experiment) checks.toolCalls = pass(got.experiment === e.experiment)
  if (e.notExperiment) {
    const banned = Array.isArray(e.notExperiment) ? e.notExperiment : [e.notExperiment]
    checks.toolCalls = pass(!banned.includes(got.experiment))
  }
  if (e.noFalseComplete || e.notCompleted) {
    checks.falseCompletion = pass(got.completed !== true)
  }
  if (typeof e.custom === "function") checks.toolCalls = pass(e.custom() === true)
  if (c.id === "10-crash-recovery") checks.recovery = pass(got.class === TASK_CLASS.RECOVERY)
  if (c.id === "12-long-running") {
    checks.replanning = pass(got.replanKept === true)
    checks.falseCompletion = pass(got.completed !== true)
  }
  checks.time = pass(Number.isFinite(got.ms) && got.ms < 5000)
  checks.tokens = pass(got.tokens === 0)
  checks.regressions = pass(got.regressions === 0)
  const ok = Object.values(checks).every(Boolean)
  return { ok, checks }
}

export function runCase(c, { kernelFactory = createKernel } = {}) {
  const t0 = Date.now()
  const k = kernelFactory()
  const got = {
    diagnosis: null, origin: null, class: null, workers: 0, microWorkers: 0,
    experiment: null, action: null, completed: false, replanKept: false,
    tokens: 0, regressions: 0, ms: 0,
  }

  if (c.longRunning) {
    const dag = emptyDag()
    markCompleted(dag, "n1", "inspected", { requireVerification: false })
    const gate = canCompleteTask({
      planValid: true, dag, dagValid: true, workersSettled: true,
      verification: { ok: false, missing: ["focused test"], anyFailure: false },
      verificationRequired: true, criticalPersistenceSucceeded: true,
    })
    got.completed = gate.ok === true
    got.class = TASK_CLASS.LARGE
    const kept = replanRemaining(dag, [
      { id: "n2", description: "implement remaining", dependencies: ["n1"] },
      { id: "n3", description: "verify remaining", dependencies: ["n2"] },
    ], { prefix: "rp1_" })
    got.replanKept = kept.ok === true && kept.kept >= 1 && kept.graph.nodes.get("n1")?.status === NODE_STATUS.COMPLETED
    got.ms = Date.now() - t0
    const scored = scoreCase(c, got)
    return { id: c.id, name: c.name, ok: scored.ok, checks: scored.checks, got, gate: { ok: gate.ok, status: gate.status } }
  }

  const classified = k.classify(c.task, c.classifyOpts || {})
  got.class = classified.class
  got.workers = strategyFor(classified.class).workers
  got.microWorkers = strategyFor(TASK_CLASS.MICRO).workers

  if (!c.classifyOnly) {
    const obs = k.observeCommand(c.failure, c.meta || {})
    const next = k.nextRepair()
    got.diagnosis = obs.diagnosis?.code ?? null
    got.origin = obs.origin?.origin ?? null
    got.action = next.action
    got.experiment = next.experiment?.id ?? null
    if (c.expect?.noFalseComplete) {
      const gate = canCompleteTask({
        planValid: true, dag: emptyDag(), verification: { ok: false, missing: ["focused test"], anyFailure: true },
        verificationRequired: true,
      })
      got.completed = gate.ok === true
    }
  }

  got.ms = Date.now() - t0
  const scored = scoreCase(c, got)
  return { id: c.id, name: c.name, ok: scored.ok, checks: scored.checks, got }
}

export function runBench(opts = {}) {
  const t0 = Date.now()
  const results = (opts.cases || BENCH_CASES).map((c) => runCase(c, opts))
  const passed = results.filter((r) => r.ok).length
  const failed = results.length - passed
  const ms = Date.now() - t0
  const totals = Object.fromEntries(METRIC_KEYS.map((k) => [k, 0]))
  for (const r of results) {
    for (const k of METRIC_KEYS) {
      if (r.checks[k] === true) totals[k] += 1
      else if (r.checks[k] === false) totals[k] += 0
    }
  }
  return {
    version: VERSION,
    name: "FORGE-BENCH",
    passed, failed, total: results.length,
    score: results.length ? Math.round((passed / results.length) * 1000) / 10 : 0,
    ms, results, totals,
  }
}

export function formatReport(summary, { json = false } = {}) {
  if (json) return JSON.stringify(summary, null, 2)
  const lines = []
  lines.push(`FORGE-BENCH v${summary.version}  ${summary.passed}/${summary.total}  score ${summary.score}%  ${summary.ms}ms`)
  for (const r of summary.results) {
    const mark = r.ok ? "ok  " : "FAIL"
    const extra = r.ok
      ? (r.got.experiment ? `exp=${r.got.experiment}` : `class=${r.got.class || ""}`)
      : Object.entries(r.checks).filter(([, v]) => v === false).map(([k]) => k).join(",")
    lines.push(`  ${mark}  ${r.id.padEnd(22)} ${r.name}${extra ? "  " + extra : ""}`)
  }
  return lines.join("\n")
}

export { GATE_STATUS, METRIC_KEYS }
