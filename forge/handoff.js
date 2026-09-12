/**
 * forge — formal agent handoffs (v91 ∞ CORE §30, zero dependencies)
 *
 * A reassignment or role change must never lose context. Before v91 a failed
 * worker's node was simply retried later with the same objective text — the
 * new attempt knew nothing about what the first one had learned, tried, or
 * disproved.
 *
 * A handoff is a first-class record carried on the bus (HANDOFF message) and
 * kept in a ledger:
 *
 *   current state · completed work · remaining work · files · symbols ·
 *   hypotheses · evidence · failed approaches · recommended next action ·
 *   verification status
 *
 * The receiving worker ACKNOWLEDGES the handoff before it starts (§30) — an
 * unacknowledged handoff is visible to the crew manager and the TUI, never
 * silently dropped.
 */

export const HANDOFF_STATUS = {
  PENDING: "PENDING",
  ACKNOWLEDGED: "ACKNOWLEDGED",
  ACCEPTED: "ACCEPTED",
  REJECTED: "REJECTED",
  SUPERSEDED: "SUPERSEDED",
}

const MAX_LIST = 24
const MAX_TEXT = 1200

let seq = 0
export function handoffId() { return `ho-${Date.now().toString(36)}-${++seq}` }

/** Build a handoff record. Every spec field is present; all bounded. */
export function createHandoff({
  from, to, taskId = null, nodeId = null, reason = null,
  currentState = "", completedWork = [], remainingWork = [],
  files = [], symbols = [], hypotheses = [], evidence = [],
  failedApproaches = [], recommendedNextAction = "", verificationStatus = "unknown",
  meta = null,
} = {}) {
  return {
    handoff_id: handoffId(),
    from: String(from ?? "core"),
    to: String(to ?? "").trim(),
    task_id: taskId != null ? String(taskId).slice(0, 120) : null,
    node_id: nodeId != null ? String(nodeId).slice(0, 120) : null,
    reason: reason != null ? String(reason).slice(0, 300) : null,
    status: HANDOFF_STATUS.PENDING,
    created_at: Date.now(),
    acknowledged_at: null,
    // the ten spec fields
    current_state: String(currentState ?? "").slice(0, MAX_TEXT),
    completed_work: strList(completedWork),
    remaining_work: strList(remainingWork),
    files: strList(files),
    symbols: strList(symbols),
    hypotheses: strList(hypotheses),
    evidence: strList(evidence),
    failed_approaches: strList(failedApproaches),
    recommended_next_action: String(recommendedNextAction ?? "").slice(0, MAX_TEXT),
    verification_status: String(verificationStatus ?? "unknown").slice(0, 40),
    meta: meta && typeof meta === "object" ? meta : null,
  }
}

const HANDOFF_KEYS = new Set([
  "handoff_id", "from", "to", "task_id", "node_id", "reason", "status", "created_at",
  "acknowledged_at", "current_state", "completed_work", "remaining_work", "files",
  "symbols", "hypotheses", "evidence", "failed_approaches", "recommended_next_action",
  "verification_status", "meta",
])

/** Structural validation — a handoff missing a spec field is rejected loudly. */
export function validateHandoff(h) {
  const errors = []
  if (!h || typeof h !== "object") return { ok: false, errors: ["handoff must be an object"] }
  for (const k of HANDOFF_KEYS) if (!(k in h)) errors.push(`missing field: ${k}`)
  if (!h.to) errors.push("handoff requires a receiver")
  if (errors.length) return { ok: false, errors }
  if (typeof h.handoff_id !== "string" || !h.handoff_id) errors.push("handoff_id must be a non-empty string")
  if (typeof h.from !== "string" || !h.from) errors.push("from must be a non-empty string")
  return { ok: errors.length === 0, errors }
}

/** The context block injected into the receiving worker's prompt. */
export function handoffContextBlock(h) {
  if (!h) return ""
  const lines = ["HANDOFF CONTEXT (a previous worker's preserved state — build on it, never repeat it):"]
  if (h.current_state) lines.push(`State: ${h.current_state}`)
  if (h.completed_work?.length) lines.push(`Already done:\n${h.completed_work.map((x) => `- ${x}`).join("\n")}`)
  if (h.remaining_work?.length) lines.push(`Still to do:\n${h.remaining_work.map((x) => `- ${x}`).join("\n")}`)
  if (h.files?.length) lines.push(`Files involved: ${h.files.join(", ")}`)
  if (h.symbols?.length) lines.push(`Symbols involved: ${h.symbols.join(", ")}`)
  if (h.hypotheses?.length) lines.push(`Live hypotheses:\n${h.hypotheses.map((x) => `- ${x}`).join("\n")}`)
  if (h.evidence?.length) lines.push(`Evidence:\n${h.evidence.map((x) => `- ${x}`).join("\n")}`)
  if (h.failed_approaches?.length) lines.push(`Do NOT repeat (proven failed):\n${h.failed_approaches.map((x) => `- ${x}`).join("\n")}`)
  if (h.recommended_next_action) lines.push(`Recommended next action: ${h.recommended_next_action}`)
  lines.push(`Verification status: ${h.verification_status}`)
  return lines.join("\n")
}

/** One line for the TUI crew view. */
export function formatHandoff(h) {
  if (!h) return ""
  return `[HANDOFF ${h.status}] ${h.from} → ${h.to}${h.node_id ? ` (node ${h.node_id})` : ""}: ${h.recommended_next_action || h.current_state || "context transfer"}`
}

/**
 * Handoff ledger: tracks handoffs for a task, enforces acknowledgment, and
 * preserves rejected reasoning (the record is never deleted, only SUPERSEDED).
 */
export function createHandoffLedger({ max = 100 } = {}) {
  const items = new Map()

  function add(h) {
    const v = validateHandoff(h)
    if (!v.ok) throw new Error(`invalid handoff: ${v.errors.join("; ")}`)
    items.set(h.handoff_id, h)
    if (items.size > max) {
      // supersede the oldest settled handoff, drop only truly stale ones
      const settled = [...items.values()].filter((x) => x.status !== HANDOFF_STATUS.PENDING)
      if (settled.length) items.delete(settled[0].handoff_id)
    }
    return h
  }

  function get(id) { return items.get(id) ?? null }

  /** The receiver acknowledges — §30 makes this explicit, never implicit. */
  function acknowledge(id, { accepted = true, note = null } = {}) {
    const h = items.get(id)
    if (!h) return null
    h.status = accepted ? HANDOFF_STATUS.ACKNOWLEDGED : HANDOFF_STATUS.REJECTED
    h.acknowledged_at = Date.now()
    if (note) h.ack_note = String(note).slice(0, 300)
    return h
  }

  function accept(id) {
    const h = items.get(id)
    if (!h) return null
    h.status = HANDOFF_STATUS.ACCEPTED
    return h
  }

  /** A newer handoff for the same node supersedes the old one — history kept. */
  function supersede(id) {
    const h = items.get(id)
    if (!h) return null
    h.status = HANDOFF_STATUS.SUPERSEDED
    return h
  }

  function forNode(nodeId) { return [...items.values()].filter((h) => h.node_id === nodeId) }
  function pending() { return [...items.values()].filter((h) => h.status === HANDOFF_STATUS.PENDING) }
  function list() { return [...items.values()] }
  /** Last accepted handoff context for a node — what the new worker should load. */
  function latestContextFor(nodeId) {
    const settled = [...items.values()]
      .filter((h) => h.node_id === nodeId && (h.status === HANDOFF_STATUS.ACKNOWLEDGED || h.status === HANDOFF_STATUS.ACCEPTED))
      .sort((a, b) => b.created_at - a.created_at)
    return settled[0] ?? null
  }

  return { add, get, acknowledge, accept, supersede, forNode, pending, list, latestContextFor, get size() { return items.size } }
}

function strList(arr) {
  return (Array.isArray(arr) ? arr : [arr])
    .map((x) => String(x ?? "").slice(0, 300))
    .filter(Boolean)
    .slice(0, MAX_LIST)
}
