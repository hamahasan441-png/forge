/**
 * forge — verification pipeline (v92 PROCREW, zero dependencies)
 *
 * Every completed task runs the SAME stages, in the SAME order, whether a human
 * asked for it or the objective engine did: build → lint → typecheck → test →
 * validate. Before v92 the ledger could only JUDGE evidence that some other part
 * of the run happened to record; nothing owned the sequence, so "did the change
 * actually build?" depended on whether the model remembered to run it.
 *
 * What this module deliberately does NOT do:
 *  - it does not invent commands. A stage with no real command from the project's
 *    own manifests is reported SKIPPED with the reason, never faked.
 *  - it does not decide pass/fail itself. Every result goes through
 *    verifyledger.evaluateVerification, which already refuses to call an
 *    unobserved exit status, a timeout, a truncated capture or a killed process
 *    a pass. Two definitions of PASS in one product is how false green happens.
 *  - it does not repair. Repair is the caller's business (meta.js owns the
 *    REPAIR phase and the repair agent); this module diagnoses, retries, and
 *    reports honestly.
 *
 * The runner is injected. `defaultRunner` uses execresult.runCommand, which
 * already normalises spawn results — so a pipeline result is comparable with
 * every other command result in the product.
 */
import fs from "node:fs"
import path from "node:path"
import { stackFor } from "./langengine.js"
import { evaluateVerification, detectFailureShape, VTYPE } from "./verifyledger.js"
import { runCommand, EXEC_STATUS } from "./execresult.js"

export const STAGE = Object.freeze({
  BUILD: "build",
  LINT: "lint",
  TYPECHECK: "typecheck",
  TEST: "test",
  VALIDATE: "validate",
})

/** Fixed order: a broken build makes every later stage's output meaningless. */
export const STAGE_ORDER = Object.freeze([STAGE.BUILD, STAGE.LINT, STAGE.TYPECHECK, STAGE.TEST, STAGE.VALIDATE])

/** What each stage is FOR — printed in the report so a skip is explainable. */
export const STAGE_PURPOSE = Object.freeze({
  [STAGE.BUILD]: "does it compile / bundle",
  [STAGE.LINT]: "style and static rules the project already enforces",
  [STAGE.TYPECHECK]: "type contract",
  [STAGE.TEST]: "unit + integration tests",
  [STAGE.VALIDATE]: "the project's own validate/check script, if it has one",
})

export const PIPELINE_DEFAULTS = Object.freeze({
  /** per-stage wall clock. Long enough for a real suite, short enough to fail. */
  timeoutMs: 300_000,
  /** how many times a failing stage may be repaired and re-run */
  maxRepairs: 2,
  /** run later stages even after a failure, so one pass yields all evidence */
  stopOnFailure: false,
  maxStages: STAGE_ORDER.length,
  evidenceChars: 400,
})

/** npm/pnpm/yarn/bun script names that count as each stage. */
const SCRIPT_OF = Object.freeze({
  [STAGE.BUILD]: ["build"],
  [STAGE.LINT]: ["lint"],
  [STAGE.TYPECHECK]: ["typecheck", "type-check", "types"],
  [STAGE.TEST]: ["test"],
  [STAGE.VALIDATE]: ["validate", "check"],
})

/**
 * The stages this project can really run, from its own manifests.
 *
 * @returns {Array<{id,command,source,available:boolean,reason:string}>}
 */
export function detectStages({ cwd = process.cwd(), files = [], config = null, scripts = null } = {}) {
  const stack = stackFor(cwd, files) || null
  // explicit package scripts win over the stack's generic command: if the
  // project defines `lint`, that IS the project's lint.
  const pkgScripts = scripts || readScripts(cwd)
  const pm = stack?.pm || "npm"
  // `npm test` is the idiomatic form for the test script — and it is what
  // langengine's stack reports, so the two detectors agree. Everything else
  // needs `run <name>`.
  const run = (name) => {
    const bare = name === "test"
    if (pm === "yarn") return `yarn ${name}`
    if (pm === "pnpm") return `pnpm ${bare ? name : `run ${name}`}`
    return `npm ${bare ? "test" : `run ${name}`}`
  }
  const out = []
  for (const id of STAGE_ORDER) {
    const script = (SCRIPT_OF[id] || []).find((n) => pkgScripts[n])
    let command = script ? run(script) : ""
    let source = script ? `package.json script "${script}"` : ""
    if (!command && stack) {
      const fromStack = stack[id]
      if (fromStack) { command = String(fromStack); source = `${stack.id} stack` }
    }
    out.push({
      id,
      command,
      source,
      available: Boolean(command),
      reason: command ? "" : `no ${id} command in this project's manifests`,
      purpose: STAGE_PURPOSE[id],
    })
  }
  return out
}

/** package.json "scripts", or {} — a missing/unreadable manifest is not an error. */
function readScripts(cwd = process.cwd()) {
  try {
    const p = path.join(String(cwd), "package.json")
    if (!fs.existsSync(p)) return {}
    const pkg = JSON.parse(fs.readFileSync(p, "utf8"))
    return (pkg && typeof pkg.scripts === "object" && pkg.scripts) || {}
  } catch { return {} }
}

/**
 * Which stages to run for this task.
 *
 * @param {object} input
 * @param {string[]} [input.only]  run just these stage ids
 * @param {string[]} [input.skip]  never run these stage ids
 * @returns {{stages:Array,skipped:Array}}
 */
export function planPipeline({ cwd = process.cwd(), files = [], config = null, only = null, skip = null, maxStages } = {}) {
  const all = detectStages({ cwd, files, config })
  const want = Array.isArray(only) && only.length ? new Set(only.map(String)) : null
  const no = new Set(Array.isArray(skip) ? skip.map(String) : [])
  const stages = []
  const skipped = []
  for (const s of all) {
    if (want && !want.has(s.id)) { skipped.push({ ...s, reason: "not selected (--only)" }); continue }
    if (no.has(s.id)) { skipped.push({ ...s, reason: "skipped (--skip)" }); continue }
    if (!s.available) { skipped.push(s); continue }
    stages.push(s)
  }
  const cap = Math.max(1, Math.min(maxStages ?? PIPELINE_DEFAULTS.maxStages, STAGE_ORDER.length))
  return { stages: stages.slice(0, cap), skipped: [...skipped, ...stages.slice(cap).map((s) => ({ ...s, reason: "stage cap" }))] }
}

/**
 * Run the pipeline.
 *
 * @param {object}   input
 * @param {object}   input.plan        from planPipeline()
 * @param {Function} [input.run]       (command,{cwd,timeoutMs,signal}) =>
 *                                     {exitCode,output,status} — defaults to
 *                                     execresult.runCommand
 * @param {Function} [input.onRepair]  ({stage,record,attempt}) => Promise<bool>
 *                                     true ⇒ the caller repaired something, so
 *                                     re-run this stage
 * @param {Function} [input.onEvent]   event sink
 * @returns {Promise<{ok:boolean,anyFailure:boolean,stages:Array,skipped:Array,
 *                    repairs:number,ms:number}>}
 */
export async function runPipeline({
  plan = null, run = null, onRepair = null, onEvent = null,
  cwd = process.cwd(), signal = null, opts = {},
} = {}) {
  const O = { ...PIPELINE_DEFAULTS, ...opts }
  const ev = (e) => { try { onEvent?.(e) } catch { /* observability never breaks a run */ } }
  const exec = typeof run === "function" ? run : defaultRunner
  const t0 = Date.now()
  const stages = []
  let repairs = 0
  let anyFailure = false

  for (const stage of (plan?.stages || [])) {
    if (signal?.aborted) { stages.push({ ...stage, passed: false, skippedRun: true, reason: "cancelled" }); continue }
    ev({ type: "PIPELINE_STAGE_STARTED", stage: stage.id, command: stage.command, source: stage.source })
    let rec = null
    let attempts = 0
    let stageRepairs = 0
    for (;;) {
      attempts += 1
      const t1 = Date.now()
      let raw = null
      try {
        raw = await exec(stage.command, { cwd, timeoutMs: O.timeoutMs, signal })
      } catch (e) {
        raw = { exitCode: null, output: `runner error: ${String(e?.message ?? e)}`, status: "unknown" }
      }
      const ms = Date.now() - t1
      const text = String(raw?.output ?? raw?.stdout ?? "")
      rec = evaluateVerification(stage.command, text, {
        cwd,
        exitCode: raw?.exitCode ?? null,
        truncated: raw?.truncated === true || raw?.status === EXEC_STATUS.TRUNCATED,
        killed: raw?.killed === true || raw?.status === EXEC_STATUS.KILLED,
        duration: ms,
        type: typeForStage(stage.id),
      })
      rec.attempt = attempts
      ev({
        type: "PIPELINE_STAGE", stage: stage.id, command: stage.command, attempt: attempts,
        passed: rec.passed, exitCode: rec.exitCode, failureShape: rec.failureShape,
        evidence: rec.evidence, ms,
      })
      if (rec.passed) break
      // Diagnose, then let the caller repair. Without a repair hook there is
      // nothing to retry — re-running an unchanged command is not a strategy.
      if (typeof onRepair !== "function" || stageRepairs >= O.maxRepairs) break
      let fixed = false
      try { fixed = (await onRepair({ stage, record: rec, attempt: stageRepairs + 1 })) === true } catch { fixed = false }
      if (!fixed) break
      stageRepairs += 1
      repairs += 1
      ev({ type: "PIPELINE_REPAIR", stage: stage.id, attempt: stageRepairs, failureShape: rec.failureShape })
    }
    if (!rec.passed) anyFailure = true
    stages.push({
      id: stage.id, command: stage.command, source: stage.source,
      passed: rec.passed, exitCode: rec.exitCode, exitCodeKnown: rec.exitCodeKnown,
      failureShape: rec.failureShape, evidence: String(rec.evidence || "").slice(0, O.evidenceChars),
      confidence: rec.confidence, attempts, repairs: stageRepairs,
      output: String(rec.output || "").slice(-O.evidenceChars),
      record: rec,
    })
    if (!rec.passed && O.stopOnFailure) {
      for (const rest of (plan?.stages || []).slice(stages.length)) stages.push({ ...rest, passed: false, skippedRun: true, reason: `earlier stage (${stage.id}) failed` })
      break
    }
  }

  const ran = stages.filter((s) => !s.skippedRun)
  return {
    ok: ran.length > 0 && !anyFailure,
    anyFailure,
    stages,
    skipped: plan?.skipped || [],
    repairs,
    ranCount: ran.length,
    passedCount: ran.filter((s) => s.passed).length,
    ms: Date.now() - t0,
  }
}

/** The ledger's verification type for a stage, so evidence is scoped correctly. */
export function typeForStage(id) {
  switch (id) {
    case STAGE.BUILD: return VTYPE.BUILD
    case STAGE.LINT: return VTYPE.SYNTAX
    case STAGE.TYPECHECK: return VTYPE.SYNTAX
    case STAGE.TEST: return VTYPE.REGRESSION_TEST
    case STAGE.VALIDATE: return VTYPE.SYNTAX
    default: return VTYPE.SYNTAX
  }
}

/** The verdict line the completion gate and the report both read. */
export function pipelineVerdict(result = {}) {
  const stages = result.stages || []
  const ran = stages.filter((s) => !s.skippedRun)
  const failed = ran.filter((s) => !s.passed)
  if (!ran.length) return { ok: false, reason: "no verification stage could run", missing: (result.skipped || []).map((s) => s.id) }
  if (failed.length) return { ok: false, reason: `${failed.length}/${ran.length} stage(s) failed: ${failed.map((f) => `${f.id}${f.failureShape ? `(${f.failureShape})` : ""}`).join(", ")}`, missing: [] }
  return { ok: true, reason: `${ran.length} stage(s) passed`, missing: [] }
}

/** Human-readable pipeline table (HUD + final report). */
export function formatPipeline(result = {}) {
  const lines = []
  for (const s of result.stages || []) {
    if (s.skippedRun) { lines.push(`  · ${s.id.padEnd(10)} not run — ${s.reason}`); continue }
    lines.push(`  ${s.passed ? "✓" : "✗"} ${s.id.padEnd(10)} ${String(s.command || "").slice(0, 60)}${s.attempts > 1 ? ` (attempt ${s.attempts})` : ""}${s.repairs ? ` • ${s.repairs} repair(s)` : ""}${s.failureShape ? ` • ${s.failureShape}` : ""}`)
    if (!s.passed && s.output) lines.push(`      ${String(s.output).split("\n").slice(-2).join(" ⏎ ").slice(0, 150)}`)
  }
  for (const s of result.skipped || []) lines.push(`  · ${s.id.padEnd(10)} skipped — ${s.reason}`)
  const v = pipelineVerdict(result)
  lines.push(`  verdict: ${v.ok ? "PASS" : "FAIL"} — ${v.reason}`)
  return lines.join("\n")
}

/** Default runner: the product's own command executor, no new spawn semantics. */
export function defaultRunner(command, { cwd = process.cwd(), timeoutMs = PIPELINE_DEFAULTS.timeoutMs } = {}) {
  const r = runCommand(command, { cwd, timeoutMs })
  const output = [r.stdout, r.stderr].filter(Boolean).join("\n")
  return {
    exitCode: r.exitCode,
    output,
    status: r.status,
    truncated: r.truncated,
    killed: r.killed,
    timedOut: r.timedOut,
    ms: r.duration,
  }
}

/** Failure diagnosis for the repair agent: what broke, in one line. */
export function diagnose(record = {}) {
  const shape = record?.failureShape || detectFailureShape(String(record?.output ?? "")) || "unknown"
  const tail = String(record?.output ?? "").split("\n").filter(Boolean).slice(-4).join(" ⏎ ").slice(0, 300)
  return { shape, hint: HINTS[shape] || "read the failing output and fix the cause, not the symptom", tail }
}

const HINTS = Object.freeze({
  build_failure: "a compile/bundle error: fix the source, not the config",
  test_failure: "an assertion failed: read the expected/received pair and fix the code under test",
  timeout: "the command did not finish — find what it is waiting on",
  oom: "out of memory — reduce the working set, do not raise the limit blindly",
  not_found: "a binary or module is missing — install it or fix the path",
  permission_denied: "a path or socket is not writable/readable in this environment",
  no_tests: "no tests matched — the test command or filter is wrong",
  panic: "the process crashed — get the stack trace before changing anything",
  signal: "killed by a signal — treat as a crash, not a failure",
  killed: "the OS or a watchdog killed it — look for the resource limit",
  generic_failure: "the command reported failure — read the last lines",
})
