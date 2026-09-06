/**
 * forge — the authoritative agent execution contract (Phase 1).
 *
 * Before this module the agent's result was `{ text, steps, toolLog, planOnly,
 * runId, wrote }` and callers had to INFER what happened:
 *   - "did it finish, or did it run out of budget?" was answered by string-
 *     matching the answer text ("(reached max steps without a final answer…)"),
 *   - token usage was discarded entirely, so there was no way to tell
 *     "the provider reported 0 tokens" from "we never learned the token count".
 *
 * Both are now explicit. Nothing here infers state from the absence of a field.
 *
 * Scope note (honesty): COMPLETED and CONTINUE_REQUIRED are produced by
 * runAgent today. FAILED / CANCELLED / BLOCKED / WAITING are part of the
 * contract for the orchestration layer that consumes it — runAgent still
 * THROWS on hard provider errors (unchanged, so existing callers keep working).
 * They are defined here so callers can switch on one enum instead of inventing
 * their own strings.
 */

/** Terminal and non-terminal outcomes of one agent execution segment. */
export const AGENT_STATUS = Object.freeze({
  COMPLETED: "COMPLETED",                 // produced a final answer
  CONTINUE_REQUIRED: "CONTINUE_REQUIRED", // budget spent, work remains — resumable
  FAILED: "FAILED",                       // unrecoverable failure
  CANCELLED: "CANCELLED",                 // aborted by the user/caller
  BLOCKED: "BLOCKED",                     // cannot proceed (policy/permission)
  WAITING: "WAITING",                     // needs input or missing evidence
})

export const AGENT_STATUSES = Object.freeze(Object.values(AGENT_STATUS))

export function isAgentStatus(s) {
  return typeof s === "string" && AGENT_STATUSES.includes(s)
}

/**
 * Sentinel for "we genuinely do not know", as distinct from a real zero.
 * A provider that reports no token counts must NOT be recorded as 0 tokens.
 */
export const UNKNOWN = "UNKNOWN"

export function isUnknown(v) { return v === UNKNOWN }

/** Short, sortable, collision-resistant id with a readable prefix. */
export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
export const newTaskId = () => newId("task")
export const newRunId = () => newId("run")
export const newSegmentId = () => newId("seg")

/**
 * Accumulates per-call provider usage across a segment.
 * Reports UNKNOWN for a counter no provider ever supplied, and a real number
 * (including 0) once any call reported one.
 */
export function makeUsageAccumulator() {
  let prompt = null, completion = null, calls = 0, toolCalls = 0
  const startedAt = Date.now()
  const add = (n, v) => (typeof v === "number" && Number.isFinite(v) ? (n ?? 0) + v : n)
  return {
    /** Fold in one provider usage object ({prompt_tokens, completion_tokens}). */
    addCall(usage) {
      calls++
      if (!usage || typeof usage !== "object") return
      prompt = add(prompt, usage.prompt_tokens ?? usage.input_tokens)
      completion = add(completion, usage.completion_tokens ?? usage.output_tokens)
    },
    addToolCalls(n) { toolCalls += Number.isFinite(n) ? n : 0 },
    /** @returns {{promptTokens,completionTokens,totalTokens,latencyMs,modelCalls,toolCalls}} */
    snapshot() {
      const total = prompt === null && completion === null ? UNKNOWN : (prompt ?? 0) + (completion ?? 0)
      return {
        promptTokens: prompt === null ? UNKNOWN : prompt,
        completionTokens: completion === null ? UNKNOWN : completion,
        totalTokens: total,
        latencyMs: Date.now() - startedAt,
        modelCalls: calls,
        toolCalls,
      }
    },
  }
}

/**
 * Validate an agent result against the contract. Returns a list of problems
 * (empty when valid) — used by the contract tests and safe to call anywhere.
 */
export function validateAgentResult(r) {
  const problems = []
  if (!r || typeof r !== "object") return ["result is not an object"]
  if (!isAgentStatus(r.status)) problems.push(`status must be one of ${AGENT_STATUSES.join("|")}, got ${JSON.stringify(r.status)}`)
  if (typeof r.text !== "string") problems.push("text must be a string")
  if (typeof r.steps !== "number") problems.push("steps must be a number")
  if (typeof r.budgetHit !== "boolean") problems.push("budgetHit must be an explicit boolean")
  if (typeof r.wrote !== "boolean") problems.push("wrote must be an explicit boolean")
  if (!Array.isArray(r.toolLog)) problems.push("toolLog must be an array")
  if (typeof r.taskId !== "string" || !r.taskId) problems.push("taskId must be a non-empty string")
  if (typeof r.segmentId !== "string" || !r.segmentId) problems.push("segmentId must be a non-empty string")
  if (!r.usage || typeof r.usage !== "object") problems.push("usage must be an object")
  else {
    for (const k of ["promptTokens", "completionTokens", "totalTokens"]) {
      const v = r.usage[k]
      if (!(v === UNKNOWN || (typeof v === "number" && Number.isFinite(v)))) {
        problems.push(`usage.${k} must be a number or ${UNKNOWN}, got ${JSON.stringify(v)}`)
      }
    }
  }
  // a segment that hit its budget is resumable, never "completed"
  if (r.budgetHit === true && r.status === AGENT_STATUS.COMPLETED) {
    problems.push("budgetHit=true must not be reported as COMPLETED")
  }
  return problems
}
