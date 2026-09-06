/**
 * forge — task orchestration: long-horizon work across segments (Phase 2).
 *
 * `runAgent()` executes ONE segment and stops when its step budget is spent.
 * Until now that was the end of the road: the CLI printed "work remains" and
 * the task was gone. `runTask()` is the loop above it — the piece that makes
 * forge able to finish something bigger than one budget.
 *
 * It is deliberately thin, and deliberately conservative:
 *
 *   - It only continues on the explicit `CONTINUE_REQUIRED` status from the
 *     Phase 1 contract. It never guesses from text, and it never continues a
 *     segment that reported COMPLETED.
 *   - `maxSegments` defaults to 1, so `forge agent` behaves exactly as before
 *     unless a caller opts in. Continuation costs real money; it is not
 *     switched on behind the user's back.
 *   - The segment budget is a hard ceiling (HARD_MAX_SEGMENTS), not a
 *     suggestion, so a misconfigured value cannot spend without bound.
 *   - Errors are NOT swallowed. If runAgent throws, the task record is marked
 *     FAILED (so the state on disk is true) and the error is re-thrown to the
 *     caller, which is what every existing call site already expects.
 *
 * Every segment is recorded in ~/.forge/tasks before the next one starts, so
 * killing the process mid-task loses at most the segment in flight.
 */
import { runAgent } from "./agent.js"
import { AGENT_STATUS } from "./contract.js"
import { createTask, recordSegment, setTaskStatus, continuationPrompt, pruneTasks } from "./taskstate.js"

/** A ceiling no config value can exceed — continuation spends real tokens. */
export const HARD_MAX_SEGMENTS = 20

export function resolveMaxSegments(config, override) {
  const raw = override ?? config?.agent?.maxSegments ?? 1
  // A bare `--segments` (no value) arrives as `true`. Number(true) is 1, which
  // would silently accept a typo as "no continuation"; reject it instead.
  if (typeof raw === "boolean") return 1
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(Math.floor(n), HARD_MAX_SEGMENTS)
}

/** One-line summary of a segment, stored as the note a later segment reads. */
export function segmentNote(result) {
  if (!result) return null
  const names = [...new Set((result.toolLog ?? []).map((t) => t.name))].slice(0, 6)
  const bits = [`${result.steps} step(s)`]
  if (result.toolLog?.length) bits.push(`${result.toolLog.length} tool call(s)${names.length ? " (" + names.join(", ") + ")" : ""}`)
  if (result.wrote) bits.push("changed files")
  return bits.join(", ")
}

/**
 * Run a task to completion, across up to `maxSegments` agent segments.
 *
 * @returns {Promise<{taskId,status,segments,text,wrote,record,budgetExhausted}>}
 *   `status` is the last segment's contract status. `budgetExhausted` is true
 *   when the loop stopped because it ran out of SEGMENTS (as opposed to the
 *   agent finishing) — the task is still resumable and says so.
 */
export async function runTask({
  config, provider, task, onEvent, signal, deep, maxSegments, maxStepsOverride, cwd, resume,
}) {
  const limit = resolveMaxSegments(config, maxSegments)
  const dir = cwd ?? process.cwd()

  // `resume` is an existing task record: continue it rather than starting over.
  const rec0 = resume ?? createTask({ task, cwd: dir, provider: provider?.name ?? null, model: provider?.model ?? null })
  if (!resume) pruneTasks()

  let record = rec0
  let last = null
  let ran = 0

  while (ran < limit) {
    // Segment 1 of a fresh task is the task itself; anything after it (or any
    // resumed task) gets the continuation context built from durable state.
    const segTask = record.segments.length === 0 ? record.task : continuationPrompt(record)
    if (onEvent && record.segments.length > 0) {
      // `index` is the task's absolute segment number; `of` is the highest it
      // can reach in THIS invocation. On a resume the two must not be compared
      // against `limit` alone, or a second segment renders as "2/1".
      const reachable = record.segments.length + (limit - ran)
      onEvent({ type: "segment", index: record.segments.length + 1, of: reachable, taskId: record.taskId })
    }

    let result
    try {
      result = await runAgent({
        config, provider, task: segTask, onEvent, signal, deep, maxStepsOverride,
        taskId: record.taskId,
        classifyTask: record.task, // effort follows the real task, not the scaffolding
      })
    } catch (e) {
      // §7: never silently swallow a core-engine error. Record the truth, re-throw.
      setTaskStatus(record.taskId, AGENT_STATUS.FAILED, { note: e?.message ?? String(e) })
      throw e
    }

    ran++
    last = result
    record = recordSegment(record.taskId, result, { note: segmentNote(result) }) ?? record

    if (result.status !== AGENT_STATUS.CONTINUE_REQUIRED) break
  }

  const budgetExhausted = last?.status === AGENT_STATUS.CONTINUE_REQUIRED
  return {
    taskId: record.taskId,
    status: last?.status ?? AGENT_STATUS.WAITING,
    segments: ran,
    text: last?.text ?? "",
    wrote: record.segments.some((s) => s.wrote),
    runId: last?.runId ?? null,
    toolLog: last?.toolLog ?? [],
    steps: last?.steps ?? 0,
    usage: last?.usage ?? null,
    totals: record.totals,
    record,
    budgetExhausted,
  }
}
