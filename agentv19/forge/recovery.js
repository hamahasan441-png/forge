/**
 * forge — recovery & effect reconciliation (v21, zero dependencies)
 *
 * The journal (runlog.js) records what we INTENDED to do; it cannot prove what
 * actually happened when a command's result was lost (timeout mid-execution,
 * process killed, network drop after a write landed). This module answers the
 * two questions a robust autonomous loop must never skip:
 *
 *  UNKNOWN RESULT  — did that mutate actually happen? Never blind-retry:
 *                      UNKNOWN → INSPECT STATE → RECONCILE → DECIDE
 *                      decide ∈ { continue, compensate, retry, ask_user }
 *
 *  RESUME          — after a crash: load task + journal + checkpoint, compare
 *                      EXPECTED state (touched files, checkpoints, verification)
 *                      against ACTUAL filesystem/git state, and choose the next
 *                      action from the last KNOWN-CONSISTENT point.
 *
 * It executes NOTHING mutating: it inspects and returns decisions. The meta
 * controller performs any compensation/repair through the normal security gate.
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"
import { readRun, verifyRun, interruptedRuns, listRuns } from "./runlog.js"
import { readTask, interruptedTasks } from "./taskstate.js"
import { listCheckpoints } from "./checkpoint.js"

export const UNKNOWN_DECISION = {
  CONTINUE: "continue",       // effect already present as desired — nothing to redo
  COMPENSATE: "compensate",   // partial/wrong effect — undo or repair first
  RETRY: "retry",             // effect provably absent + operation is safe to repeat
  ASK_USER: "ask_user",       // cannot determine safely — human judgement needed
}

function sha256Head(file, bytes = 1024 * 1024) {
  try {
    const st = fs.statSync(file)
    const len = Math.min(st.size, bytes)
    const fd = fs.openSync(file, "r")
    try {
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, 0)
      return crypto.createHash("sha256").update(buf).digest("hex")
    } finally { fs.closeSync(fd) }
  } catch { return null }
}

/**
 * Reconcile the effect of a SINGLE uncertain operation against real state.
 *
 * @param expected  { kind: 'file_write'|'file_edit'|'file_delete'|'bash'|'fetch',
 *                    path?, contains?, exists?, command? }
 * @returns { decision, reason, observed }
 */
export function reconcileEffect(expected = {}, cwd = process.cwd()) {
  const observed = {}
  switch (expected.kind) {
    case "file_write":
    case "file_edit": {
      const p = path.resolve(cwd, String(expected.path ?? ""))
      const exists = fs.existsSync(p)
      observed.exists = exists
      if (!exists) {
        // provably did NOT happen → a write/create may be retried; an edit can't
        return expected.kind === "file_write"
          ? { decision: UNKNOWN_DECISION.RETRY, reason: "target file does not exist — the write did not land", observed }
          : { decision: UNKNOWN_DECISION.COMPENSATE, reason: "file missing that an edit expected to modify — inspect before acting", observed }
      }
      if (expected.contains) {
        let text = ""
        try { text = fs.readFileSync(p, "utf8") } catch {}
        observed.contains = text.includes(String(expected.contains))
        if (observed.contains) return { decision: UNKNOWN_DECISION.CONTINUE, reason: "the intended content is already present — do not re-apply", observed }
        return { decision: UNKNOWN_DECISION.COMPENSATE, reason: "file exists but the intended change is absent — re-apply after inspecting", observed }
      }
      // file exists but we don't know the exact intended content → inspect, don't blindly overwrite
      observed.sha = sha256Head(p)
      return { decision: UNKNOWN_DECISION.ASK_USER, reason: "file exists but desired end-state is unknown — inspect before retrying", observed }
    }
    case "file_delete": {
      const p = path.resolve(cwd, String(expected.path ?? ""))
      const exists = fs.existsSync(p)
      observed.exists = exists
      if (!exists) return { decision: UNKNOWN_DECISION.CONTINUE, reason: "file is already gone — delete succeeded", observed }
      return { decision: UNKNOWN_DECISION.RETRY, reason: "file still present and deletes are idempotent — safe to remove once", observed }
    }
    case "bash":
    case "fetch":
    default: {
      // a generic unknown side effect cannot be proven either way — never blind
      // retry a non-idempotent command; require inspection or a human.
      const idempotent = expected.idempotent === true
      if (idempotent) {
        // idempotent and unverifiable from here: a single guarded retry is
        // acceptable, but the controller should still inspect first.
        return { decision: UNKNOWN_DECISION.RETRY, reason: "idempotent operation with an unobserved result — one guarded retry is safe after inspection", observed }
      }
      return { decision: UNKNOWN_DECISION.ASK_USER, reason: "uncertain external side effect; cannot prove the operation did or did not happen — inspect or ask", observed }
    }
  }
}

/**
 * Build the observable EFFECT SET of an operation/run: files created/modified/
 * deleted, git changes, generated artifacts. Compared across an interruption to
 * find drift between what the journal expected and what is actually on disk.
 */
export function observeEffects({ cwd = process.cwd(), files = {} } = {}) {
  const out = { created: [], modified: [], deleted: [], missing: [], git: null, unknown: [] }
  for (const [p, info] of Object.entries(files || {})) {
    const exists = fs.existsSync(p)
    const action = info?.action ?? "modified"
    if (action === "created") {
      if (exists) out.created.push(p)
      else out.missing.push(p) // journal says created, file gone
    } else if (action === "deleted") {
      if (!exists) out.deleted.push(p)
      else out.unknown.push(p) // journal says deleted, file present
    } else {
      if (exists) out.modified.push(p)
      else out.missing.push(p)
    }
  }
  out.git = gitState(cwd)
  return out
}

export function gitState(cwd = process.cwd()) {
  try {
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd, timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    const changed = porcelain.split("\n").filter(Boolean).map((l) => l.trim())
    return { isRepo: true, changed: changed.slice(0, 200), dirty: changed.length }
  } catch { return { isRepo: false, changed: [], dirty: 0 } }
}

/**
 * Reconcile an interrupted run/task: compare expected journal state to actual.
 * Returns a structured report + a recommended next action. NEVER mutates.
 */
export function reconcileRun(runRec, { cwd = process.cwd() } = {}) {
  const effects = observeEffects({ cwd, files: runRec?.files ?? {} })
  const verify = verifyRun(runRec)
  const cps = listCheckpoints(cwd, 999).filter((c) => c.runId === runRec?.runId)
  const git = effects.git

  const drift = []
  if (effects.missing.length) drift.push(`${effects.missing.length} file(s) the journal touched are now missing`)
  if (effects.unknown.length) drift.push(`${effects.unknown.length} file(s) recorded deleted are present`)

  // decide the last known-consistent point
  let recommended = "inspect"
  let safePoint = null
  if (cps.length) {
    safePoint = { checkpoint: cps[cps.length - 1].id, restorableCheckpoints: cps.length }
    recommended = drift.length || verify.missing ? "resume_from_checkpoint" : "resume"
  } else if (!drift.length && verify.ok) {
    recommended = "resume"
  } else if (runRec?.lastTool) {
    recommended = "inspect_last_tool"
  }
  if (git?.isRepo && git.dirty > 0) {
    recommended = recommended === "resume" ? "resume" : recommended
  }

  return {
    runId: runRec?.runId ?? null,
    step: runRec?.step ?? 0,
    lastTool: runRec?.lastTool ?? null,
    effects,
    verify,
    checkpoints: cps.map((c) => c.id),
    safePoint,
    drift,
    git,
    recommended,
    canResume: ["resume", "resume_from_checkpoint", "inspect_last_tool", "inspect"].includes(recommended),
  }
}

/**
 * Crash recovery entry point: find interrupted TASKS and legacy RUNS for cwd,
 * reconcile each, and return a prioritized list of recovery candidates. The
 * UI prompts on these; nothing here restarts or replays automatically.
 */
export function detectInterrupted({ cwd = process.cwd() } = {}) {
  const out = { tasks: [], runs: [] }
  try {
    for (const t of interruptedTasks({ cwd })) {
      out.tasks.push({ task: t, reconciliation: reconcileTask(t, { cwd }) })
    }
  } catch {}
  try {
    for (const r of interruptedRuns({ cwd })) {
      // skip runs already represented by a task record
      if (out.tasks.some((x) => x.task.run_id === r.runId)) continue
      out.runs.push({ run: r, reconciliation: reconcileRun(r, { cwd }) })
    }
  } catch {}
  return out
}

/** Reconcile a v21 task record (DAG + segments + verification) for resume. */
export function reconcileTask(taskRec, { cwd = process.cwd() } = {}) {
  const files = {}
  for (const f of taskRec?.files_changed ?? []) files[f] = { action: "modified" }
  for (const f of taskRec?.files_created ?? []) files[f] = { action: "created" }
  const effects = observeEffects({ cwd, files })
  const cps = listCheckpoints(cwd, 999).filter((c) => c.runId === taskRec?.run_id || taskRec?.checkpoints?.includes(c.id))

  const dagSummary = taskRec?.dag ? dagProgress(taskRec.dag) : null
  const unverified = (taskRec?.verification_results ?? []).filter((v) => v.passed === false)
  const pendingSegments = taskRec?.status === "EXECUTING" || taskRec?.status === "CHECKPOINTING"

  let recommended = "resume"
  if (unverified.length) recommended = "resume_repair"
  else if (effects.missing.length || effects.unknown.length) recommended = "inspect"
  else if (cps.length) recommended = "resume"
  else recommended = pendingSegments ? "resume" : "inspect"

  return {
    taskId: taskRec?.task_id ?? null,
    status: taskRec?.status ?? null,
    objective: taskRec?.objective ?? "",
    segment: taskRec?.segment_count ?? 0,
    currentStep: taskRec?.current_step ?? null,
    pendingSteps: (taskRec?.pending_steps ?? []).length,
    dag: dagSummary,
    effects,
    checkpoints: cps.map((c) => c.id),
    unverified: unverified.length,
    repairCount: taskRec?.repair_count ?? 0,
    recommended,
    canResume: true,
  }
}

function dagProgress(dag) {
  try {
    const nodes = dag?.nodes ?? []
    const s = { total: nodes.length, completed: 0, failed: 0, running: 0, ready: 0, blocked: 0, pending: 0, cancelled: 0 }
    for (const n of nodes) s[n.status] = (s[n.status] ?? 0) + 1
    return s
  } catch { return null }
}

/** The concrete next action text fed to a resumed agent run, derived from the
 *  reconciliation — never a blind replay of the previous command. */
export function resumePrompt(taskRec, recon, cwd = process.cwd()) {
  const lines = [
    `Resuming an interrupted task (status was ${taskRec?.status}, ${recon.segment} segment(s) done).`,
  ]
  if (recon.currentStep != null) lines.push(`It stopped around plan step ${recon.currentStep}; pending steps: ${recon.pendingSteps}.`)
  if (recon.dag) lines.push(`DAG: ${recon.dag.completed}/${recon.dag.total} nodes complete${recon.dag.failed ? `, ${recon.dag.failed} failed` : ""}${recon.dag.blocked ? `, ${recon.dag.blocked} blocked` : ""}.`)
  if (recon.effects) {
    const fx = recon.effects
    if (fx.created.length) lines.push(`Files present from earlier work: ${fx.created.slice(0, 8).map((f) => path.relative(cwd, f)).join(", ")}.`)
    if (fx.modified.length) lines.push(`Files modified earlier: ${fx.modified.slice(0, 8).map((f) => path.relative(cwd, f)).join(", ")}.`)
    if (fx.missing.length) lines.push(`WARNING: ${fx.missing.length} file(s) the task recorded are now MISSING: ${fx.missing.slice(0, 5).map((f) => path.relative(cwd, f)).join(", ")}.`)
  }
  if (recon.unverified) lines.push(`${recon.unverified} verification check(s) failed before interruption — re-verify and repair before claiming success.`)
  if (recon.checkpoints?.length) lines.push(`Checkpoints available (${recon.checkpoints.length}) — undo is possible if state is inconsistent.`)
  lines.push(`Do NOT blindly re-run the last command. First inspect the current state (git_status, read the relevant files), reconcile what already happened, then continue toward the objective.`)
  lines.push(`\nOriginal objective: ${taskRec?.objective ?? ""}`)
  return lines.join("\n")
}

// re-export for callers that want the run-reading helpers from one place
export { readRun, listRuns, readTask }
