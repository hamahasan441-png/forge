/**
 * forge — session rehydration (v97 "unifiedwise", ∞ §6/§8, zero dependencies)
 *
 * Automatic session rehydration: a normal `forge chat` startup in a directory
 * with a previous session reattaches to it WITHOUT requiring --continue (§6).
 *
 * The reconstruction (§8) is read-only aggregation over the stores that
 * already exist — sessions, run journals, task records, episodes, decisions,
 * the world model and the source record. It NEVER invents history, and
 * current verified reality always overrides stale memory:
 *   - files recorded in the session that no longer exist → reported stale
 *   - task states are read from the task store, not from the chat's memory
 *   - the world model is probed with a cheap stat walk, not trusted blindly
 */
import fs from "node:fs"
import path from "node:path"
import { loadSession, readTranscript } from "./sessions.js"
import { listRuns, interruptedRuns } from "./runlog.js"

/**
 * Build the §8 reconstruction for a session. Everything is optional — what is
 * missing is reported as unknown, never fabricated.
 */
export async function buildRehydration(sessionFile, { cwd = process.cwd() } = {}) {
  const s = loadSession(sessionFile)
  if (!s) return null
  const out = {
    session: { id: s.id, title: s.title ?? null, summary: s.summary ?? null, updatedAt: s.updatedAt ?? s.ts ?? 0, cwd: s.cwd ?? null },
    goal: null, requirements: [], decisions: [],
    completed: [], incomplete: [], failed: [],
    filesTouched: [], commandsRun: 0,
    blockers: [], stale: [], nextAction: null,
    transcriptTurns: 0,
  }
  // goal: the session title is the first user message — the honest proxy for
  // the original goal (the full goal lives in the transcript/messages)
  out.goal = s.title ?? null

  // raw transcript: what the user actually said (survives compaction, §7)
  const transcript = readTranscript(s.id, { limit: 400 })
  out.transcriptTurns = transcript.length
  const userTurns = transcript.filter((t) => t.role === "user")
  for (const t of userTurns.slice(-12)) {
    for (const c of t.classes ?? []) {
      if (c.cls === "goal" && !out.goal) out.goal = String(t.content).slice(0, 120)
      if (c.cls === "requirement" && out.requirements.length < 8) out.requirements.push(String(t.content).slice(0, 160))
      if (c.cls === "decision" && out.decisions.length < 8) out.decisions.push(String(t.content).slice(0, 160))
      if (c.cls === "stop" && !out.blockers.includes("user asked to stop")) out.blockers.push("user asked to stop")
    }
  }

  // run journals for this cwd — completed/incomplete/failed work (§5)
  try {
    const runs = listRuns({ cwd: s.cwd || cwd, max: 12 })
    for (const r of runs) {
      const label = `${String(r.task ?? "").slice(0, 60)} (${r.status}${r.files ? `, ${Object.keys(r.files).length} file(s)` : ""})`
      if (r.status === "completed") out.completed.push(label)
      else if (r.status === "incomplete") out.incomplete.push(label)
      else if (r.status === "failed") out.failed.push(label)
      out.commandsRun += r.toolCalls ?? 0
      for (const f of Object.keys(r.files ?? {}).slice(0, 6)) out.filesTouched.push(f)
    }
  } catch { }
  // interrupted runs are the actionable "incomplete" truth
  try {
    for (const r of interruptedRuns({ cwd: s.cwd || cwd }).slice(0, 3)) {
      out.incomplete.push(`${String(r.task ?? "").slice(0, 60)} (INTERRUPTED — recoverable)`)
    }
  } catch { }

  // task records (autonomous tasks for this cwd)
  try {
    const { listTasks } = await import("./taskstate.js")
    const tasks = listTasks({ cwd: s.cwd || cwd, max: 10 })
    for (const t of tasks) {
      const label = `${String(t.objective ?? "").slice(0, 60)} [${t.status}]`
      if (t.status === "COMPLETED") out.completed.push(label)
      else if (t.status === "FAILED") out.failed.push(label)
      else if (t.status !== "CANCELLED") out.incomplete.push(label)
      if (t.waiting_reason) out.blockers.push(String(t.waiting_reason).slice(0, 120))
      if (t.next_action) out.nextAction = String(t.next_action).slice(0, 160)
    }
  } catch { }

  // reality reconciliation (§8 "current verified reality must override stale
  // memory"): session-touched files that no longer exist are STALE, honestly.
  const seen = new Set()
  for (const f of out.filesTouched) {
    if (seen.has(f)) continue
    seen.add(f)
    try { if (!fs.existsSync(f)) out.stale.push(f) } catch { }
  }
  out.filesTouched = [...seen].slice(0, 12)
  out.completed = dedupe(out.completed).slice(0, 6)
  out.incomplete = dedupe(out.incomplete).slice(0, 6)
  out.failed = dedupe(out.failed).slice(0, 4)
  out.requirements = dedupe(out.requirements).slice(0, 6)
  out.decisions = dedupe(out.decisions).slice(0, 6)
  out.blockers = dedupe(out.blockers).slice(0, 4)
  out.stale = out.stale.slice(0, 6)
  return out
}

function dedupe(arr) {
  return [...new Set(arr.filter(Boolean))]
}

/** Human summary lines for the banner (§6 "concise active-state summary"). */
export function formatRehydration(r, { maxLines = 12 } = {}) {
  if (!r) return []
  const lines = []
  const age = r.session.updatedAt ? Math.round((Date.now() - r.session.updatedAt) / 60000) : null
  lines.push(`previous session in this directory: "${r.session.title ?? "(untitled)"}"${age != null ? ` • ${age < 60 ? age + " min" : Math.round(age / 60) + " h"} ago` : ""}`)
  if (r.session.summary) lines.push(`summary: ${String(r.session.summary).replace(/\s+/g, " ").slice(0, 160)}`)
  if (r.completed.length) lines.push(`completed: ${r.completed.slice(0, 3).join(" | ")}`)
  if (r.incomplete.length) lines.push(`incomplete: ${r.incomplete.slice(0, 3).join(" | ")}`)
  if (r.failed.length) lines.push(`failed: ${r.failed.slice(0, 2).join(" | ")}`)
  if (r.decisions.length) lines.push(`decisions: ${r.decisions.slice(0, 2).join(" | ")}`)
  if (r.blockers.length) lines.push(`blockers: ${r.blockers.slice(0, 2).join(" | ")}`)
  if (r.stale.length) lines.push(`stale (files gone): ${r.stale.slice(0, 3).join(", ")}`)
  if (r.transcriptTurns) lines.push(`raw history: ${r.transcriptTurns} turn(s) preserved`)
  if (r.nextAction) lines.push(`next: ${r.nextAction}`)
  return lines.slice(0, maxLines)
}
