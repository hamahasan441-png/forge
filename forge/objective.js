/**
 * forge — objective-based task engine (v91 ULTIMATE, zero dependencies)
 *
 * The spec defect this replaces: "stop after N steps".
 *
 * agent.js still bounds a single tool loop (a runaway loop must not burn tokens
 * forever) and meta.js still has a segment safety fuse — but NEITHER of those is
 * the definition of completion. This engine makes the objective the only
 * definition:
 *
 *   DONE    — the completion gate (completion.js, the existing 9-check gate)
 *             says the objective is satisfied and verified. Nothing else may
 *             declare DONE. This module never re-implements that gate; it reads
 *             it.
 *   BLOCKED — an unrecoverable blocker, with the exact reason recorded.
 *   RUNNING — keep going. A budget/fuse hit lands here, never in DONE.
 *
 * What the engine adds on top of the existing lifecycle:
 *  - explicit phases (ANALYZE → … → LEARN) with per-phase state and timing
 *  - a checkpoint per completed phase, persisted under the ONE forge data root
 *    (~/.forge/projects/<hash>/objectives/, via memory.projectDir + securefs) so
 *    a crashed run resumes from the last completed phase instead of restarting
 *  - loop detection: the same (phase, action, args-fingerprint) repeated N times
 *    is a stuck agent, not progress — the engine reports it and recommends a
 *    strategy pivot, which meta.js feeds to the existing strategy machinery
 *  - honest progress: a percentage derived from phase state + gate checks, not
 *    from steps burned
 *  - a compression request when the carried context grows past a budget, so the
 *    caller can hand older turns to compaction.js instead of dropping them
 *
 * Zero model calls. Deterministic. Safe to run in every test lane.
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { projectDir } from "./memory.js"
import { writeStateFile } from "./securefs.js"
import { redact } from "./secrets.js"

/** The canonical workflow, in order. Order is load-bearing: progressOf() and
 *  resume rely on it, and the HUD prints phases in this sequence. */
export const PHASE = Object.freeze({
  ANALYZE: "ANALYZE",
  RESEARCH: "RESEARCH",
  REVIEW: "REVIEW",
  PLAN: "PLAN",
  APPROVE: "APPROVE",
  EXECUTE: "EXECUTE",
  VERIFY: "VERIFY",
  REPAIR: "REPAIR",
  OPTIMIZE: "OPTIMIZE",
  DOCUMENT: "DOCUMENT",
  REPORT: "REPORT",
  LEARN: "LEARN",
})

export const PHASES = Object.freeze(Object.values(PHASE))

/** Phases that must have run at least once before DONE is even considered. */
export const REQUIRED_PHASES = Object.freeze([PHASE.ANALYZE, PHASE.PLAN, PHASE.EXECUTE, PHASE.VERIFY])

export const PHASE_STATE = Object.freeze({
  PENDING: "pending",
  ACTIVE: "active",
  DONE: "done",
  SKIPPED: "skipped",
  FAILED: "failed",
})

export const OBJ_STATUS = Object.freeze({
  RUNNING: "RUNNING",
  DONE: "DONE",
  BLOCKED: "BLOCKED",
  WAITING: "WAITING",
  CANCELLED: "CANCELLED",
})

/** Why a run stopped. Recorded verbatim in the final report. */
export const STOP_REASON = Object.freeze({
  GATE_SATISFIED: "GATE_SATISFIED",
  BLOCKER: "BLOCKER",
  CANCELLED: "CANCELLED",
  FUSE: "FUSE",
  RUNNING: "RUNNING",
})

export const OBJECTIVES_DIRNAME = "objectives"

/** Default loop threshold: the same fingerprinted action this many times in a
 *  row means the agent is retrying, not progressing. */
export const DEFAULT_LOOP_THRESHOLD = 3

/** Carried-context budget before a compression request is raised (chars). */
export const DEFAULT_CONTEXT_BUDGET = 48_000

const MAX_ACTIONS = 400
const MAX_OBJECTIVE_TEXT = 2000
const MAX_NOTES_PER_PHASE = 12
const MAX_NOTE = 400
const MAX_PIVOTS = 12

export function objectivesDir(cwd = process.cwd()) {
  return path.join(projectDir(cwd), OBJECTIVES_DIRNAME)
}

export function objectiveFile(id, cwd = process.cwd()) {
  return path.join(objectivesDir(cwd), `${String(id).replace(/[^A-Za-z0-9._-]/g, "_")}.json`)
}

export function newObjectiveId(now = Date.now()) {
  return `obj-${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`
}

/** Stable fingerprint for loop detection: what was done, not how it was phrased. */
export function actionFingerprint({ phase, action = "", args = null } = {}) {
  let argPart = ""
  try {
    argPart = typeof args === "string" ? args : JSON.stringify(args ?? {})
  } catch { argPart = String(args) }
  return crypto.createHash("sha256")
    .update(`${phase ?? ""}|${String(action).toLowerCase()}|${String(argPart).slice(0, 400)}`)
    .digest("hex").slice(0, 16)
}

function blankPhase(name) {
  return { phase: name, state: PHASE_STATE.PENDING, startedAt: null, endedAt: null, notes: [], entries: 0 }
}

/**
 * Create an objective record. Phases start PENDING; ANALYZE becomes ACTIVE.
 * @param {{objective?: string, cwd?: string, klass?: string, approvalRequired?: boolean,
 *          loopThreshold?: number, contextBudget?: number, id?: string, taskId?: string}} input
 */
export function createObjective({
  objective = "", cwd = process.cwd(), klass = "MEDIUM", approvalRequired = false,
  loopThreshold = DEFAULT_LOOP_THRESHOLD, contextBudget = DEFAULT_CONTEXT_BUDGET,
  id = null, taskId = null, runId = null, now = Date.now(),
} = {}) {
  const phases = {}
  for (const p of PHASES) phases[p] = blankPhase(p)
  phases[PHASE.ANALYZE].state = PHASE_STATE.ACTIVE
  phases[PHASE.ANALYZE].startedAt = now
  return {
    schema: 1,
    id: id || newObjectiveId(now),
    taskId: taskId || null,
    runId: runId || null,
    objective: redact(String(objective ?? "")).slice(0, MAX_OBJECTIVE_TEXT),
    class: String(klass || "MEDIUM"),
    cwd: path.resolve(cwd),
    approvalRequired: Boolean(approvalRequired),
    approved: approvalRequired ? false : true,
    loopThreshold: Math.max(2, Number(loopThreshold) || DEFAULT_LOOP_THRESHOLD),
    contextBudget: Math.max(4_000, Number(contextBudget) || DEFAULT_CONTEXT_BUDGET),
    status: OBJ_STATUS.RUNNING,
    stopReason: STOP_REASON.RUNNING,
    phases,
    phase: PHASE.ANALYZE,
    actions: [],
    pivots: [],
    checkpoints: [],
    blockers: [],
    contextChars: 0,
    compressions: 0,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
  }
}

function touch(o, now) {
  o.updatedAt = now
  return o
}

/** Record one action. Returns the loop verdict for this action (or null). */
export function recordAction(o, { phase = null, action = "", args = null, ok = true, detail = "" } = {}, now = Date.now()) {
  if (!o) return null
  const fp = actionFingerprint({ phase: phase ?? o.phase, action, args })
  o.actions.push({ fp, phase: phase ?? o.phase, action: String(action).slice(0, 120), ok: Boolean(ok), detail: redact(String(detail ?? "")).slice(0, MAX_NOTE), at: now })
  if (o.actions.length > MAX_ACTIONS) o.actions.splice(0, o.actions.length - MAX_ACTIONS)
  const loop = detectLoop(o.actions, { threshold: o.loopThreshold })
  return loop?.looping ? loop : null
}

/**
 * Detect a repeated identical action.
 *
 * "Repeated" = the same fingerprint appearing `threshold` times among the most
 * recent `window` actions. A retry that changed its arguments is NOT a loop;
 * that is exactly the strategy change we want to keep.
 * @returns {{looping: boolean, fingerprint?: string, action?: string, repeats?: number, suggestion?: string}|null}
 */
export function detectLoop(actions = [], { threshold = DEFAULT_LOOP_THRESHOLD, window = 8 } = {}) {
  const list = Array.isArray(actions) ? actions.slice(-Math.max(threshold, window)) : []
  if (list.length < threshold) return null
  const counts = new Map()
  for (const a of list) {
    const k = a?.fp || actionFingerprint(a || {})
    const rec = counts.get(k) || { n: 0, action: a?.action ?? "", phase: a?.phase ?? null }
    rec.n++
    counts.set(k, rec)
  }
  for (const [fp, rec] of counts) {
    if (rec.n >= threshold) {
      return {
        looping: true,
        fingerprint: fp,
        action: rec.action,
        phase: rec.phase,
        repeats: rec.n,
        suggestion: `change strategy: "${rec.action || "this action"}" has now been attempted ${rec.n}× with the same arguments — pick a different approach or a different tool instead of retrying`,
      }
    }
  }
  return null
}

/** Move to a phase. Re-entering a cyclic phase increments its entry count. */
export function advance(o, phase, { note = "", now = Date.now() } = {}) {
  if (!o || !PHASES.includes(phase)) return o
  const prev = o.phases[o.phase]
  if (prev && prev.phase !== phase && prev.state === PHASE_STATE.ACTIVE) {
    prev.state = PHASE_STATE.DONE
    prev.endedAt = now
  }
  const next = o.phases[phase]
  if (next.state === PHASE_STATE.PENDING || next.state === PHASE_STATE.FAILED) next.startedAt = next.startedAt ?? now
  next.state = PHASE_STATE.ACTIVE
  next.entries = (next.entries || 0) + 1
  if (note) addNote(o, phase, note, now)
  o.phase = phase
  return touch(o, now)
}

/** Mark a phase done (or skipped/failed) without making it current. */
export function settlePhase(o, phase, state = PHASE_STATE.DONE, { note = "", now = Date.now() } = {}) {
  if (!o || !o.phases[phase]) return o
  const p = o.phases[phase]
  p.state = state
  if (state !== PHASE_STATE.ACTIVE && state !== PHASE_STATE.PENDING) p.endedAt = p.endedAt ?? now
  if (note) addNote(o, phase, note, now)
  if (o.phase === phase && state !== PHASE_STATE.ACTIVE) {
    const nxt = nextPendingPhase(o)
    if (nxt) advance(o, nxt, { now })
  }
  return touch(o, now)
}

export function addNote(o, phase, note, now = Date.now()) {
  if (!o || !o.phases[phase]) return o
  const p = o.phases[phase]
  const line = redact(String(note ?? "").trim()).slice(0, MAX_NOTE)
  if (!line) return o
  p.notes.push({ at: now, text: line })
  if (p.notes.length > MAX_NOTES_PER_PHASE) p.notes.splice(0, p.notes.length - MAX_NOTES_PER_PHASE)
  return o
}

function nextPendingPhase(o) {
  const i = PHASES.indexOf(o.phase)
  for (let j = i + 1; j < PHASES.length; j++) {
    const p = o.phases[PHASES[j]]
    if (p.state === PHASE_STATE.PENDING) return PHASES[j]
  }
  return null
}

/** Save a phase checkpoint. Meta.js already checkpoints FILES (checkpoint.js);
 *  this records PROGRESS, so the two never compete. */
export function checkpointPhase(o, { label = "", checkpointId = null, now = Date.now() } = {}) {
  if (!o) return null
  const rec = {
    id: `ocp-${o.checkpoints.length + 1}`,
    phase: o.phase,
    label: String(label || o.phase).slice(0, 120),
    fileCheckpointId: checkpointId || null,
    pct: progressOf(o).pct,
    donePhases: PHASES.filter((p) => o.phases[p].state === PHASE_STATE.DONE),
    at: now,
  }
  o.checkpoints.push(rec)
  if (o.checkpoints.length > 64) o.checkpoints.splice(0, o.checkpoints.length - 64)
  return touch(o, rec)
}

/** Track carried context size; returns a compression request when over budget. */
export function noteContext(o, chars = 0, { now = Date.now() } = {}) {
  if (!o) return null
  o.contextChars = Math.max(0, Number(chars) || 0)
  if (o.contextChars >= o.contextBudget) {
    o.compressions++
    return touch(o, now) && {
      compress: true,
      chars: o.contextChars,
      budget: o.contextBudget,
      directive: "compress completed phases into memory before continuing: keep the objective, the plan, the current file list and the last verification result; drop verbatim tool output",
    }
  }
  return null
}

/** Record a strategy pivot (the response to a detected loop). */
export function recordPivot(o, { from = "", to = "", why = "", now = Date.now() } = {}) {
  if (!o) return o
  o.pivots.push({ from: String(from).slice(0, 160), to: String(to).slice(0, 160), why: redact(String(why ?? "")).slice(0, MAX_NOTE), at: now })
  if (o.pivots.length > MAX_PIVOTS) o.pivots.splice(0, o.pivots.length - MAX_PIVOTS)
  return touch(o, now)
}

/** Record an unrecoverable blocker. A blocker with a reason is an honest stop. */
export function recordBlocker(o, { reason = "", detail = "", phase = null, recoverable = false, now = Date.now() } = {}) {
  if (!o) return o
  o.blockers.push({
    reason: String(reason || "unknown").slice(0, 200),
    detail: redact(String(detail ?? "")).slice(0, 600),
    phase: phase || o.phase,
    recoverable: Boolean(recoverable),
    at: now,
  })
  if (o.blockers.length > 24) o.blockers.splice(0, o.blockers.length - 24)
  return touch(o, now)
}

/**
 * Normalize a completion gate's checks into one shape.
 *
 * completion.js returns `checks` as an OBJECT MAP ({ check_name: bool }) while
 * advisory callers naturally think in a list. Every consumer goes through here
 * so the two shapes can never disagree again.
 * @returns {Array<{check: string, ok: boolean, detail: string}>}
 */
export function gateChecks(gate = null) {
  const c = gate?.checks
  if (!c) return []
  if (Array.isArray(c)) return c.map((x) => ({ check: String(x?.check ?? x?.id ?? "?"), ok: x?.ok === true, detail: String(x?.detail ?? x?.reason ?? "") }))
  if (typeof c === "object") return Object.entries(c).map(([k, v]) => ({ check: String(k), ok: v === true, detail: "" }))
  return []
}

/** Gate blockers, always an array of {check, reason}. */
export function gateBlockers(gate = null) {
  const b = gate?.blockers
  if (!Array.isArray(b)) return []
  return b.map((x) => ({ check: String(x?.check ?? x?.id ?? x?.reason ?? "?"), reason: String(x?.reason ?? x?.detail ?? "") }))
}

/**
 * Honest progress. Weighted by phase, with the gate's own checks folded in so a
 * run that has executed everything but failed verification never reads 100%.
 * @returns {{pct: number, phase: string, done: number, total: number, phases: object, label: string}}
 */
export function progressOf(o, { gate = null } = {}) {
  if (!o) return { pct: 0, phase: null, done: 0, total: PHASES.length, phases: {}, label: "no objective" }
  const done = PHASES.filter((p) => o.phases[p].state === PHASE_STATE.DONE || o.phases[p].state === PHASE_STATE.SKIPPED).length
  // Phase share is 80% of the bar; gate share is 20% (only when a gate exists).
  let pct = Math.round((done / PHASES.length) * 80)
  const checks = gateChecks(gate)
  if (checks.length) {
    const passed = checks.filter((c) => c.ok).length
    pct += Math.round((passed / checks.length) * 20)
  } else if (o.status === OBJ_STATUS.DONE) pct = 100
  if (o.status === OBJ_STATUS.DONE) pct = 100
  if (o.status === OBJ_STATUS.BLOCKED || o.status === OBJ_STATUS.CANCELLED) pct = Math.min(pct, 99)
  const label = `${o.phase} · ${done}/${PHASES.length} phases`
  return { pct: Math.max(0, Math.min(100, pct)), phase: o.phase, done, total: PHASES.length, phases: o.phases, label }
}

/**
 * THE verdict. Reads the existing completion gate; never invents one.
 * @param {object} o
 * @param {{gate?: {ok?: boolean, status?: string, blockers?: Array}|null,
 *          cancelled?: boolean, fuse?: boolean, fuseReason?: string}} input
 * @returns {{status: string, reason: string, pct: number, missing: Array, blockers: Array}}
 */
export function verdict(o, { gate = null, cancelled = false, fuse = false, fuseReason = "" } = {}) {
  if (!o) return { status: OBJ_STATUS.RUNNING, reason: STOP_REASON.RUNNING, pct: 0, missing: [], blockers: [] }
  const prog = progressOf(o, { gate })
  if (cancelled) return finish(o, OBJ_STATUS.CANCELLED, STOP_REASON.CANCELLED, prog)
  const unrecoverable = (o.blockers || []).filter((b) => !b.recoverable)
  if (unrecoverable.length) {
    return finish(o, OBJ_STATUS.BLOCKED, STOP_REASON.BLOCKER, prog, unrecoverable.map((b) => `${b.reason}${b.detail ? ` — ${b.detail}` : ""}`))
  }
  if (gate) {
    const missing = gateBlockers(gate).map((b) => b.check)
    const requiredDone = REQUIRED_PHASES.every((p) => [PHASE_STATE.DONE, PHASE_STATE.SKIPPED].includes(o.phases[p]?.state))
    if (gate.ok && requiredDone) return finish(o, OBJ_STATUS.DONE, STOP_REASON.GATE_SATISFIED, prog)
    if (fuse) return finish(o, OBJ_STATUS.WAITING, STOP_REASON.FUSE, prog, missing, fuseReason)
    return { status: OBJ_STATUS.RUNNING, reason: STOP_REASON.RUNNING, pct: prog.pct, missing, blockers: [] }
  }
  if (fuse) return finish(o, OBJ_STATUS.WAITING, STOP_REASON.FUSE, prog, [], fuseReason)
  return { status: OBJ_STATUS.RUNNING, reason: STOP_REASON.RUNNING, pct: prog.pct, missing: [], blockers: [] }
}

function finish(o, status, reason, prog, missing = [], extra = "") {
  o.status = status
  o.stopReason = reason
  // The run ends NOW: a re-run of finish() must never leave an endedAt older
  // than a phase that started after it (that reads as negative duration).
  o.endedAt = Date.now()
  // A finished run has no phase left "in flight": settle whatever is active so
  // the phase table and the percentage agree with the verdict.
  if (status === OBJ_STATUS.DONE) {
    for (const p of PHASES) if (o.phases[p]?.state === PHASE_STATE.ACTIVE) { o.phases[p].state = PHASE_STATE.DONE; o.phases[p].endedAt = o.endedAt }
  }
  o.updatedAt = o.endedAt
  if (extra) addNote(o, o.phase, extra, o.endedAt)
  if (missing?.length) addNote(o, PHASE.VERIFY, `missing: ${missing.slice(0, 6).join(", ")}`, o.endedAt)
  return { status, reason, pct: status === OBJ_STATUS.DONE ? 100 : prog.pct, missing, blockers: o.blockers }
}

/** Persist (atomic, 0600, under the ONE forge data root). */
export function saveObjective(o, { cwd = o?.cwd ?? process.cwd() } = {}) {
  if (!o?.id) return { ok: false, error: "no objective" }
  const file = objectiveFile(o.id, cwd)
  try {
    const w = writeStateFile(file, JSON.stringify(o, null, 2))
    return { ok: true, file, bytes: w.bytes }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), file }
  }
}

export function loadObjective(id, cwd = process.cwd()) {
  const file = objectiveFile(id, cwd)
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"))
    return raw && typeof raw === "object" ? raw : null
  } catch { return null }
}

export function listObjectives(cwd = process.cwd(), limit = 20) {
  const dir = objectivesDir(cwd)
  let names = []
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".json")) } catch { return [] }
  const rows = []
  for (const n of names) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"))
      rows.push({ id: o.id, objective: o.objective, status: o.status, phase: o.phase, pct: progressOf(o).pct, updatedAt: o.updatedAt, taskId: o.taskId })
    } catch { /* unreadable record: skip, never throw out of a listing */ }
  }
  rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return rows.slice(0, Math.max(1, limit))
}

/** Most recent objective for a task id (or the newest overall). */
export function latestObjective(cwd = process.cwd(), taskId = null) {
  const rows = listObjectives(cwd, 50)
  if (taskId) {
    const hit = rows.find((r) => r.taskId === taskId)
    if (hit) return loadObjective(hit.id, cwd)
  }
  return rows.length ? loadObjective(rows[0].id, cwd) : null
}

/**
 * Resume support: which phase to pick up from, and what was already done.
 * A completed cyclic phase (VERIFY/REPAIR) is never treated as "finished work"
 * — resuming always re-verifies.
 */
export function resumePoint(o) {
  if (!o) return null
  const done = PHASES.filter((p) => o.phases[p].state === PHASE_STATE.DONE)
  const resumeFrom = PHASES.find((p) => o.phases[p].state === PHASE_STATE.ACTIVE)
    || PHASES.find((p) => o.phases[p].state === PHASE_STATE.PENDING)
    || PHASE.VERIFY
  return {
    resumeFrom,
    donePhases: done,
    lastCheckpoint: o.checkpoints?.length ? o.checkpoints[o.checkpoints.length - 1] : null,
    mustReverify: true,
    note: "resumed from the last completed phase checkpoint — verification is never inherited from a previous process",
  }
}

/**
 * One line of text for an objective-engine event, or null if it is not one.
 *
 * Both printers (chat.js's meta printer and the piped CLI printer in
 * agentview.js) call this, so the wording exists exactly once. Colours stay with
 * the caller — this module has no UI dependency.
 * @returns {{text: string, tone: "dim"|"warn"|"ok"}|null}
 */
export function formatObjectiveEvent(ev = {}) {
  switch (ev?.type) {
    case "OBJECTIVE_STARTED":
      return { tone: "dim", text: `◈ objective ${ev.objectiveId} — class ${ev.class}, crew of ${(ev.crew || []).length}, writer: ${(ev.writers || []).join(",") || "?"}${ev.approvalRequired ? " (approval required)" : ""}` }
    case "OBJECTIVE_PHASE":
      return { tone: "dim", text: `◈ ${String(ev.phase).padEnd(9)} ${String(ev.pct).padStart(3)}%  ${ev.done}/${ev.total} phases` }
    case "LOOP_DETECTED":
      return { tone: "warn", text: `↺ loop: "${String(ev.action ?? "").slice(0, 40)}" ×${ev.repeats} — ${String(ev.suggestion ?? "").slice(0, 90)}` }
    case "CONTEXT_COMPRESSION_REQUESTED":
      return { tone: "dim", text: `⇣ context ${ev.chars} > ${ev.budget} — compressing completed phases into memory` }
    case "OBJECTIVE_VERDICT":
      return {
        tone: ev.status === OBJ_STATUS.DONE ? "ok" : "warn",
        text: `◈ objective ${ev.status} (${ev.reason}) ${ev.pct}%${ev.missing?.length ? ` — missing: ${ev.missing.slice(0, 3).join(", ")}` : ""}`,
      }
    case "FINAL_REPORT":
      return { tone: "dim", text: `▤ final report ${ev.reportId} — ${(ev.sections || []).length} sections${ev.gateOk ? ", gate satisfied" : ", gate open"} (forge report ${ev.reportId})` }
    default:
      return null
  }
}

/** Human-readable one-liner for the HUD. */
export function formatObjective(o, { gate = null } = {}) {
  if (!o) return "no objective record"
  const prog = progressOf(o, { gate })
  const bits = [`[${o.id}]`, `${o.status}`, `${prog.pct}%`, prog.label]
  if (o.pivots?.length) bits.push(`${o.pivots.length} pivot${o.pivots.length === 1 ? "" : "s"}`)
  if (o.checkpoints?.length) bits.push(`${o.checkpoints.length} checkpoint${o.checkpoints.length === 1 ? "" : "s"}`)
  if (o.blockers?.length) bits.push(`${o.blockers.length} blocker${o.blockers.length === 1 ? "" : "s"}`)
  return bits.join(" ")
}

/** Full phase table (used by the final report and `forge report`). */
export function phaseTable(o) {
  if (!o) return []
  return PHASES.map((p) => {
    const rec = o.phases[p] || blankPhase(p)
    const ms = rec.startedAt && rec.endedAt ? Math.max(0, rec.endedAt - rec.startedAt) : null
    return { phase: p, state: rec.state, entries: rec.entries || 0, ms, notes: rec.notes.map((n) => n.text) }
  })
}
