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
import { execFileSync } from "node:child_process"
import { readRun, verifyRun, interruptedRuns, listRuns } from "./runlog.js"
import { readTask, interruptedTasks } from "./taskstate.js"
import { listCheckpoints, fullFileHash } from "./checkpoint.js"

export const UNKNOWN_DECISION = {
  CONTINUE: "continue",
  COMPENSATE: "compensate",
  RETRY: "retry",
  ASK_USER: "ask_user",
}

export const EFFECT_STATUS = {
  DONE: "DONE",
  PARTIAL: "PARTIAL",
  NOT_DONE: "NOT_DONE",
  UNKNOWN: "UNKNOWN",
}

function toEffectStatus(decision) {
  if (decision === UNKNOWN_DECISION.CONTINUE) return EFFECT_STATUS.DONE
  if (decision === UNKNOWN_DECISION.COMPENSATE) return EFFECT_STATUS.PARTIAL
  if (decision === UNKNOWN_DECISION.RETRY) return EFFECT_STATUS.NOT_DONE
  return EFFECT_STATUS.UNKNOWN
}


/**
 * P1 — hash the WHOLE file, never just the first 1 MB.
 *
 * The old helper hashed `min(size, 1MB)` bytes, so a change past the 1 MB mark
 * was invisible and a corrupted/modified file reconciled as "unchanged". It now
 * delegates to checkpoint.fullFileHash (chunked full-file SHA-256).
 */
function sha256Head(file) {
  try {
    return fullFileHash(file)?.sha ?? null
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
          ? { decision: UNKNOWN_DECISION.RETRY, reason: "target file does not exist — the write did not land", observed, expectedEffects: expected, observedEffects: observed, effectStatus: EFFECT_STATUS.NOT_DONE }
          : { decision: UNKNOWN_DECISION.COMPENSATE, reason: "file missing that an edit expected to modify — inspect before acting", observed, expectedEffects: expected, observedEffects: observed, effectStatus: EFFECT_STATUS.PARTIAL }
      }
      if (expected.contains) {
        let text = ""
        try { text = fs.readFileSync(p, "utf8") } catch {}
        observed.contains = text.includes(String(expected.contains))
        if (observed.contains) return { decision: UNKNOWN_DECISION.CONTINUE, reason: "the intended content is already present — do not re-apply", observed, expectedEffects: expected, observedEffects: observed, effectStatus: EFFECT_STATUS.DONE }
        return { decision: UNKNOWN_DECISION.COMPENSATE, reason: "file exists but the intended change is absent — re-apply after inspecting", observed, expectedEffects: expected, observedEffects: observed, effectStatus: EFFECT_STATUS.PARTIAL }
      }
      // When the intended end-state was recorded we can PROVE the effect: the
      // full-file hash either matches (DONE) or it does not (PARTIAL).
      const wantHash = expected.expectedHash ?? expected.expected_hash ?? expected.sha ?? null
      observed.sha = sha256Head(p)
      if (wantHash) {
        if (observed.sha && observed.sha === String(wantHash)) {
          return { decision: UNKNOWN_DECISION.CONTINUE, reason: "the file already has the intended content — the effect landed, do not re-apply", observed, expectedEffects: expected, observedEffects: observed, effectStatus: EFFECT_STATUS.DONE }
        }
        return { decision: UNKNOWN_DECISION.COMPENSATE, reason: `file exists but its content (${String(observed.sha).slice(0, 8)}) is not the intended end-state (${String(wantHash).slice(0, 8)}) — inspect before re-applying`, observed, expectedEffects: expected, observedEffects: observed, effectStatus: EFFECT_STATUS.PARTIAL }
      }
      // file exists but we don't know the exact intended content → inspect, don't blindly overwrite
      return { decision: UNKNOWN_DECISION.ASK_USER, reason: "file exists but desired end-state is unknown — inspect before retrying", observed, expectedEffects: expected, observedEffects: observed, effectStatus: EFFECT_STATUS.UNKNOWN }
    }
    case "file_delete": {
      const p = path.resolve(cwd, String(expected.path ?? ""))
      const exists = fs.existsSync(p)
      observed.exists = exists
      if (!exists) return { decision: UNKNOWN_DECISION.CONTINUE, reason: "file is already gone — delete succeeded", observed, expectedEffects: expected, observedEffects: observed, effectStatus: EFFECT_STATUS.DONE }
      return { decision: UNKNOWN_DECISION.RETRY, reason: "file still present and deletes are idempotent — safe to remove once", observed, expectedEffects: expected, observedEffects: observed, effectStatus: EFFECT_STATUS.NOT_DONE }
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
        return { decision: UNKNOWN_DECISION.RETRY, reason: "idempotent operation with an unobserved result — one guarded retry is safe after inspection", observed, expectedEffects: expected, observedEffects: observed, effectStatus: EFFECT_STATUS.NOT_DONE }
      }
      return { decision: UNKNOWN_DECISION.ASK_USER, reason: "uncertain external side effect; cannot prove the operation did or did not happen — inspect or ask", observed, expectedEffects: expected, observedEffects: observed, effectStatus: EFFECT_STATUS.UNKNOWN }
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

/**
 * P1 — GIT EFFECT MODEL.
 *
 * `git status --porcelain` alone cannot answer "did the commit land?" after a
 * crash. The model captures the full repo state — HEAD, branch, staged vs
 * unstaged vs untracked, and the operation in progress — so recovery can diff
 * BEFORE against AFTER and decide per operation (commit / reset / checkout /
 * merge / rebase / stash) instead of guessing.
 */
export function gitState(cwd = process.cwd()) {
  const base = { isRepo: false, head: null, branch: null, staged: [], unstaged: [], untracked: [], dirty: 0, operation: null, stashCount: 0 }
  try {
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd, timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    const lines = porcelain.split("\n").filter(Boolean).map((l) => l.trimEnd())
    const staged = [], unstaged = [], untracked = []
    for (const l of lines) {
      const x = l[0] ?? " ", y = l[1] ?? " "
      const file = l.slice(3)
      if (x === "?" && y === "?") { untracked.push(file); continue }
      if (x !== " " && x !== "?") staged.push(file)
      if (y !== " ") unstaged.push(file)
    }
    let head = null, branch = null
    try { head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() } catch { head = null }
    try { branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() } catch { branch = null }
    let stashCount = 0
    try {
      const st = execFileSync("git", ["stash", "list"], { cwd, timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      stashCount = st.split("\n").filter(Boolean).length
    } catch { }
    return {
      isRepo: true,
      head, branch,
      staged: staged.slice(0, 200),
      unstaged: unstaged.slice(0, 200),
      untracked: untracked.slice(0, 200),
      changed: lines.slice(0, 200),
      dirty: lines.length,
      operation: gitOperationInProgress(cwd),
      stashCount,
    }
  } catch {
    return base
  }
}

/** Which git operation is mid-flight (merge/rebase/cherry-pick/revert/bisect)? */
export function gitOperationInProgress(cwd = process.cwd()) {
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd, timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    const has = (p) => { try { fs.accessSync(path.join(gitDir, p)); return true } catch { return false } }
    if (has("rebase-merge") || has("rebase-apply")) return "rebase"
    if (has("MERGE_HEAD")) return "merge"
    if (has("CHERRY_PICK_HEAD")) return "cherry-pick"
    if (has("REVERT_HEAD")) return "revert"
    if (has("BISECT_LOG")) return "bisect"
    return null
  } catch { return null }
}

/**
 * Diff two captured git states. Returns the structured effect of whatever
 * happened between them.
 */
export function gitEffectDiff(before, after) {
  const b = before ?? {}, a = after ?? {}
  return {
    previousHead: b.head ?? null,
    currentHead: a.head ?? null,
    headChanged: Boolean(a.head && b.head && a.head !== b.head),
    headAppeared: Boolean(!b.head && a.head),
    branch: { before: b.branch ?? null, after: a.branch ?? null },
    staged: { before: b.staged ?? [], after: a.staged ?? [] },
    unstaged: { before: b.unstaged ?? [], after: a.unstaged ?? [] },
    untracked: { before: b.untracked ?? [], after: a.untracked ?? [] },
    stashCount: { before: b.stashCount ?? 0, after: a.stashCount ?? 0 },
    operation: a.operation ?? null,
    isRepo: a.isRepo === true,
  }
}

/**
 * Operation-aware git recovery. Never blind-replays a non-idempotent git
 * command: it inspects the observed effect and decides.
 *
 * commit   → HEAD moved                 ⇒ DONE      else NOT_DONE (retry safe)
 * checkout → HEAD moved (or branch changed) ⇒ DONE  else NOT_DONE
 * reset    → HEAD moved back            ⇒ DONE      else NOT_DONE
 * merge    → HEAD moved and no conflict ⇒ DONE
 *            operation still in progress ⇒ PARTIAL (compensate: finish/abort)
 * rebase   → same as merge
 * stash    → stash count increased      ⇒ DONE      else NOT_DONE
 */
export function reconcileGitOperation(expected = {}, { before = null, after = null, cwd = process.cwd() } = {}) {
  const op = String(expected.operation ?? expected.git ?? "").toLowerCase()
  const diff = gitEffectDiff(before, after ?? gitState(cwd))
  const observed = { git: diff, operation: op }
  const wrap = (decision, reason, effectStatus) => ({
    decision, reason, observed, expectedEffects: expected, observedEffects: diff, effectStatus,
  })

  if (!diff.isRepo) return wrap(UNKNOWN_DECISION.ASK_USER, "not a git repository — cannot reconcile the git effect", EFFECT_STATUS.UNKNOWN)

  // any operation left mid-flight is a partial state that must be resolved
  if (diff.operation && ["merge", "rebase", "cherry-pick", "revert", "bisect"].includes(diff.operation)) {
    return wrap(
      UNKNOWN_DECISION.COMPENSATE,
      `a ${diff.operation} is still in progress — finish or abort it before continuing (never auto-resolve conflicts)`,
      EFFECT_STATUS.PARTIAL,
    )
  }

  switch (op) {
    case "commit":
      if (diff.headChanged || diff.headAppeared) return wrap(UNKNOWN_DECISION.CONTINUE, "HEAD moved — the commit landed", EFFECT_STATUS.DONE)
      return wrap(UNKNOWN_DECISION.RETRY, "HEAD did not move — the commit did not land (a retry is safe: it is a no-op if it did)", EFFECT_STATUS.NOT_DONE)
    case "checkout":
      if (diff.headChanged || (diff.branch.before && diff.branch.before !== diff.branch.after)) {
        return wrap(UNKNOWN_DECISION.CONTINUE, "HEAD/branch moved — the checkout landed", EFFECT_STATUS.DONE)
      }
      return wrap(UNKNOWN_DECISION.RETRY, "HEAD did not move — the checkout did not land", EFFECT_STATUS.NOT_DONE)
    case "reset":
      if (diff.headChanged) return wrap(UNKNOWN_DECISION.CONTINUE, "HEAD moved — the reset landed", EFFECT_STATUS.DONE)
      return wrap(UNKNOWN_DECISION.RETRY, "HEAD did not move — the reset did not land", EFFECT_STATUS.NOT_DONE)
    case "merge":
    case "rebase":
    case "cherry-pick":
      if (diff.headChanged) return wrap(UNKNOWN_DECISION.CONTINUE, `HEAD moved — the ${op} landed`, EFFECT_STATUS.DONE)
      return wrap(UNKNOWN_DECISION.COMPENSATE, `HEAD did not move and no ${op} is in progress — inspect before repeating`, EFFECT_STATUS.PARTIAL)
    case "stash":
      if ((diff.stashCount.after ?? 0) > (diff.stashCount.before ?? 0)) {
        return wrap(UNKNOWN_DECISION.CONTINUE, "stash count increased — the stash landed", EFFECT_STATUS.DONE)
      }
      return wrap(UNKNOWN_DECISION.RETRY, "stash count unchanged — the stash did not land", EFFECT_STATUS.NOT_DONE)
    default:
      return wrap(UNKNOWN_DECISION.ASK_USER, `unknown git operation "${op || "?"}" — inspect the repository state before acting`, EFFECT_STATUS.UNKNOWN)
  }
}

// ---------------------------------------------------------------------------
// P1 — effect kinds beyond "a file was written"
// ---------------------------------------------------------------------------

export const EFFECT_KIND = {
  FILE_WRITE: "file_write",
  FILE_EDIT: "file_edit",
  FILE_DELETE: "file_delete",
  BASH: "bash",
  FETCH: "fetch",
  PACKAGE_INSTALL: "package_install",
  DB_MIGRATION: "db_migration",
  PROCESS_LAUNCH: "process_launch",
  NETWORK_MUTATION: "network_mutation",
  GIT: "git",
}

/** Classify a mutating command into the effect kind it produces. */
export function classifyEffectKind(command = "") {
  const c = String(command ?? "")
  if (/\bgit\s+(commit|reset|checkout|merge|rebase|stash|cherry-pick|revert)\b/i.test(c)) return EFFECT_KIND.GIT
  if (/\b(npm|pnpm|yarn|bun|pip|poetry|cargo|gem|apt-get|brew)\s+(install|add)\b/i.test(c)) return EFFECT_KIND.PACKAGE_INSTALL
  if (/\b(migrate|migration|db:push|db:migrate|prisma\s+migrate|alembic\s+upgrade|rails\s+db:migrate)\b/i.test(c)) return EFFECT_KIND.DB_MIGRATION
  if (/\b(curl|wget|ssh|scp|rsync|nc)\b/i.test(c) && !/\s-o\s|\s>/i.test(c)) return EFFECT_KIND.NETWORK_MUTATION
  if (/&\s*$|nohup|\b(serve|start|run\s+dev|node\s+server)\b/i.test(c)) return EFFECT_KIND.PROCESS_LAUNCH
  if (/\brm\b|\bunlink\b/i.test(c)) return EFFECT_KIND.FILE_DELETE
  return EFFECT_KIND.BASH
}

/** Observed effect of a package install: is the package actually on disk? */
function observePackageInstall(expected, cwd) {
  const pkgs = expected.packages ?? []
  const base = path.resolve(cwd, String(expected.cwd ?? cwd))
  const present = []
  const absent = []
  for (const p of pkgs) {
    const name = String(p).replace(/@[^/]+$/, "")
    let found = false
    for (const dir of ["node_modules", "vendor"]) {
      try {
        if (fs.existsSync(path.join(base, dir, name, "package.json"))) { found = true; break }
      } catch { }
    }
    ;(found ? present : absent).push(name)
  }
  return { present, absent }
}

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true } catch (e) { return e?.code === "EPERM" }
}

/**
 * Reconcile an effect by KIND (P1). Covers package installation, database
 * migration, process launch, network mutation and git — the operations that a
 * crash most often leaves in an unknown state.
 */
export function reconcileEffectByKind(expected = {}, cwd = process.cwd()) {
  const kind = expected.kind ?? classifyEffectKind(expected.command ?? "")
  if (kind === EFFECT_KIND.GIT) return reconcileGitOperation(expected, { before: expected.before, after: expected.after, cwd })

  if (kind === EFFECT_KIND.PACKAGE_INSTALL) {
    const obs = observePackageInstall(expected, cwd)
    const observed = { packages: obs }
    if (obs.present.length && !obs.absent.length) {
      return { decision: UNKNOWN_DECISION.CONTINUE, reason: `package(s) present on disk: ${obs.present.join(", ")} — install landed`, observed, expectedEffects: expected, observedEffects: obs, effectStatus: EFFECT_STATUS.DONE }
    }
    if (obs.present.length && obs.absent.length) {
      return { decision: UNKNOWN_DECISION.RETRY, reason: `partially installed: ${obs.present.join(", ")} present, ${obs.absent.join(", ")} missing — an install is idempotent, one guarded retry is safe`, observed, expectedEffects: expected, observedEffects: obs, effectStatus: EFFECT_STATUS.PARTIAL }
    }
    if (expected.idempotent === true || expected.observablyAbsent === true) {
      return { decision: UNKNOWN_DECISION.RETRY, reason: "no package found on disk — the install did not land", observed, expectedEffects: expected, observedEffects: obs, effectStatus: EFFECT_STATUS.NOT_DONE }
    }
    return { decision: UNKNOWN_DECISION.ASK_USER, reason: "cannot prove whether the install landed — inspect the lockfile / node_modules before repeating", observed, expectedEffects: expected, observedEffects: obs, effectStatus: EFFECT_STATUS.UNKNOWN }
  }

  if (kind === EFFECT_KIND.DB_MIGRATION) {
    if (expected.verified === true && expected.exitCode === 0) {
      return { decision: UNKNOWN_DECISION.CONTINUE, reason: "migration reported success with an observed exit code 0", observed: { verified: true }, expectedEffects: expected, observedEffects: { verified: true }, effectStatus: EFFECT_STATUS.DONE }
    }
    return {
      decision: UNKNOWN_DECISION.ASK_USER,
      reason: "a database migration is NOT idempotent and its effect cannot be proven from the filesystem — inspect the migration state before repeating",
      observed: { verified: expected.verified ?? null },
      expectedEffects: expected, observedEffects: { verified: expected.verified ?? null },
      effectStatus: EFFECT_STATUS.UNKNOWN,
    }
  }

  if (kind === EFFECT_KIND.PROCESS_LAUNCH) {
    const alive = expected.pid != null ? pidAlive(expected.pid) : null
    if (alive === true) return { decision: UNKNOWN_DECISION.CONTINUE, reason: `process ${expected.pid} is running — the launch landed`, observed: { pid: expected.pid, alive }, expectedEffects: expected, observedEffects: { pid: expected.pid, alive }, effectStatus: EFFECT_STATUS.DONE }
    if (alive === false) return { decision: UNKNOWN_DECISION.RETRY, reason: `process ${expected.pid} is not running — the launch did not survive`, observed: { pid: expected.pid, alive: false }, expectedEffects: expected, observedEffects: { pid: expected.pid, alive: false }, effectStatus: EFFECT_STATUS.NOT_DONE }
    return { decision: UNKNOWN_DECISION.ASK_USER, reason: "no pid to observe — cannot prove the process launched", observed: {}, expectedEffects: expected, observedEffects: {}, effectStatus: EFFECT_STATUS.UNKNOWN }
  }

  if (kind === EFFECT_KIND.NETWORK_MUTATION) {
    return {
      decision: UNKNOWN_DECISION.ASK_USER,
      reason: "a network mutation has an unobservable remote effect — never blind-retry; inspect the remote (or ask) first",
      observed: {}, expectedEffects: expected, observedEffects: {},
      effectStatus: EFFECT_STATUS.UNKNOWN,
    }
  }

  return reconcileEffect(expected, cwd)
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
