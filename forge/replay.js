/**
 * forge — task replay (v97 "unifiedwise", ∞ §56/§88, zero dependencies)
 *
 * "A failed autonomous task must allow reconstruction of: state, action,
 *  observation, decision, evidence, transition. This is required for
 *  debugging Forge itself."
 *
 * This is a READ-ONLY AGGREGATOR over the ledgers that already exist —
 * NO second store, NO new writes (§89):
 *   - the run journal          ~/.forge/runs/<runId>.json        (runlog.js)
 *   - the engineering events   ~/.forge/projects/<h>/events.jsonl (core.js §14)
 *   - the task record          ~/.forge/tasks/<taskId>.json      (taskstate.js)
 *   - the communication bus    ~/.forge/tasks/<taskId>.bus.jsonl (bus.js)
 *
 * The output is one chronological timeline: goal → state → action → decision
 * → evidence → verification → transition → result. Everything it prints was
 * RECORDED when it happened — replay never reconstructs a plausible story.
 */
import fs from "node:fs"
import path from "node:path"
import { readRun, listRuns, resolveRunId } from "./runlog.js"
import { readTask, listTasks } from "./taskstate.js"
import { projectDir } from "./memory.js"

const MAX_EVENTS = 4000
const MAX_LINES = 240

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return null }
}

function readEvents(cwd, { taskId = null, runId = null } = {}) {
  const file = path.join(projectDir(cwd), "events.jsonl")
  let lines
  try { lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-MAX_EVENTS) } catch { return [] }
  const out = []
  for (const l of lines) {
    try {
      const j = JSON.parse(l)
      if (taskId && j.taskId && j.taskId !== taskId) continue
      if (runId && j.runId && j.runId !== runId) continue
      out.push(j)
    } catch { }
  }
  return out
}

/** Classify an engineering event into the replay vocabulary (§56). */
function kindOf(type) {
  const t = String(type ?? "")
  if (/^TASK_(CREATED|STARTED|RESUMED|COMPLETED|FAILED|FINISHED)/.test(t)) return "state"
  if (/^TASK_/.test(t)) return "state"
  if (/^(SEGMENT_|DAG_|PLAN_)/.test(t)) return "action"
  if (/^DECISION_/.test(t)) return "decision"
  if (/^(VERIFICATION_|VERIFY_|PREDICTION_|REALITY_DELTA|IMPACT_|WORLD_|ENVIRONMENT_)/.test(t)) return "evidence"
  if (/^(REPAIR_|RECOVER|RESUM)/.test(t)) return "repair"
  if (/^(WORKER_|INTEGRATION_CONFLICT|CONFLICT_)/.test(t)) return "worker"
  if (/^(COMPLETION_|SELF_REVIEW|MODEL_SELECTED|STRATEGY_CHANGED)/.test(t)) return "transition"
  if (/^CHECKPOINT/.test(t)) return "checkpoint"
  return "event"
}

/** Build the replay timeline for a run and/or task. Read-only. */
export function buildReplay({ runId = null, taskId = null, cwd = process.cwd() } = {}) {
  const run = runId ? readRun(runId) : null
  // resolve a taskId from the run journal when only runId is given
  let task = taskId ? readTask(taskId) : null
  if (!task && run) {
    // run journals store the task text; find the task record whose run_id matches
    try {
      const candidates = listTasks({ cwd, max: 60 })
      task = candidates.find((t) => run.runId && t.run_id === run.runId) ?? null
      if (task) taskId = task.task_id
    } catch { }
  }
  const events = readEvents(cwd, { taskId, runId: runId ?? run?.runId ?? null })
  const timeline = []
  if (run) {
    timeline.push({ ts: run.startedAt, kind: "goal", source: "run-journal", detail: `${String(run.task ?? "").slice(0, 160)} (run ${run.runId}, kind ${run.kind}, ${run.provider ?? "?"}/${run.model ?? "?"})` })
    if (run.status && run.endedAt) timeline.push({ ts: run.endedAt, kind: "result", source: "run-journal", detail: `run ${run.status} • ${run.toolCalls ?? 0} tool call(s) • ${Object.keys(run.files ?? {}).length} file(s) touched${run.error ? ` • error: ${String(run.error).slice(0, 120)}` : ""}` })
    if (run.lastTool) timeline.push({ ts: run.lastTool.at, kind: "action", source: "run-journal", detail: `last tool ${run.lastTool.name} → ${String(run.lastTool.target ?? "").slice(0, 80)} ${run.lastTool.ok ? "ok" : "FAILED"}` })
  }
  if (task) {
    timeline.push({ ts: task.created_at, kind: "state", source: "task-record", detail: `task ${String(task.task_id).slice(-8)} created — objective: ${String(task.objective ?? "").slice(0, 140)}` })
    for (const seg of (task.segments ?? []).slice(-12)) {
      timeline.push({ ts: seg.at ?? null, kind: "action", source: "task-record", detail: `segment ${seg.segment_id ?? "?"}: ${String(seg.objective ?? "").slice(0, 100)}` })
    }
    for (const d of (task.decisions ?? []).slice(-10)) {
      timeline.push({ ts: d.at ?? null, kind: "decision", source: "task-record", detail: `${d.kind ?? "decision"}: ${String(d.detail ?? "").slice(0, 120)}` })
    }
    for (const v of (task.verification_results ?? []).slice(-10)) {
      timeline.push({ ts: v.at ?? null, kind: "evidence", source: "task-record", detail: `verification ${v.status ?? v.result ?? "?"}: ${String(v.command ?? v.check ?? "").slice(0, 100)}` })
    }
    timeline.push({ ts: task.ended_at ?? task.updated_at, kind: "result", source: "task-record", detail: `task ${task.status} • ${task.segment_count ?? 0} segment(s) • ${task.repair_count ?? 0} repair(s) • ${(task.files_changed ?? []).length} file(s) changed` })
  }
  for (const ev of events) {
    const text = ev.text ?? ev.reason ?? ev.decision?.title ?? ev.phase ?? ""
    timeline.push({
      ts: ev.ts ?? null,
      kind: kindOf(ev.type),
      source: "events-ledger",
      detail: `${ev.type}${text ? `: ${String(text).slice(0, 120)}` : ""}`,
    })
  }
  timeline.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || (a.kind === "goal" ? -1 : 0))
  return {
    runId: runId ?? run?.runId ?? null,
    taskId: taskId ?? task?.task_id ?? null,
    timeline: timeline.slice(-MAX_LINES),
    counts: timeline.reduce((a, t) => { a[t.kind] = (a[t.kind] ?? 0) + 1; return a }, {}),
  }
}

/** Resolve what the user typed (run id, short run id, task id, or --last). */
export function resolveReplayTarget(input, { cwd = process.cwd(), last = false } = {}) {
  if (last) {
    const r = listRuns({ cwd, max: 1 })[0]
    if (r) return { runId: r.runId }
    const t = (() => { try { return listTasks({ cwd, max: 1 })[0] } catch { return null } })()
    return t ? { taskId: t.task_id } : null
  }
  const raw = String(input ?? "").trim()
  if (!raw) return null
  const run = resolveRunId(cwd, raw)
  if (run) return { runId: run }
  try {
    const t = readTask(raw)
    if (t) return { taskId: t.task_id }
  } catch { }
  try {
    const candidates = listTasks({ cwd, max: 60 }).filter((t) => String(t.task_id).endsWith(raw) || String(t.task_id).slice(-6) === raw)
    if (candidates.length === 1) return { taskId: candidates[0].task_id }
  } catch { }
  return null
}

/** Human rendering: WHAT → WHY → EVIDENCE → ACTION → RESULT, chronologically. */
export function formatReplay(r, { maxLines = 80 } = {}) {
  if (!r) return "nothing to replay"
  const lines = []
  lines.push(`REPLAY ${r.runId ? `run ${r.runId}` : ""}${r.taskId ? ` task ${String(r.taskId).slice(-8)}` : ""} — ${r.timeline.length} recorded entr(ies)${Object.entries(r.counts).length ? ` (${Object.entries(r.counts).map(([k, n]) => `${n} ${k}`).join(", ")})` : ""}`)
  lines.push("(every line below was RECORDED when it happened — replay never reconstructs a story)")
  for (const t of r.timeline.slice(-maxLines)) {
    const time = t.ts ? new Date(t.ts).toISOString().slice(11, 19) : "--:--:--"
    lines.push(`  ${time} ${pad(t.kind, 10)} ${t.detail}`)
  }
  if (r.timeline.length > maxLines) lines.push(`  … (+${r.timeline.length - maxLines} earlier entries)`)
  return lines.join("\n")
}

function pad(s, n) {
  return String(s ?? "").slice(0, n).padEnd(n)
}
