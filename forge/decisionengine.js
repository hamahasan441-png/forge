/**
 * forge — human decision engine (v91 ∞ CORE §40, zero dependencies)
 *
 * Forge is autonomous BY DEFAULT. It asks the user only when a genuine
 * decision is required, and when it asks it asks WELL:
 *
 *   DECISION NEEDED → OPTIONS → RECOMMENDATION → REASON → CONSEQUENCES → WAIT
 *
 * Decision types: INFORMATION · DECISION · CLARIFICATION · AUTHORIZATION
 * While a decision is pending the task state is WAITING_FOR_USER (taskstate
 * v91) — never FAILED, never silently continued past.
 *
 * Anti-nag rule (§40): a question answerable from project evidence is never
 * asked. The engine keeps an asked-key ledger with cooldown — the same
 * question key needs NEW evidence (a different key hash) to be asked again.
 *
 * After the user answers, the engine hands the answer back so Core can
 * update the world model, plan and DAG, then continue.
 */
import fs from "node:fs"
import path from "node:path"
import { projectDir } from "./memory.js"

export const DECISION_TYPE = {
  INFORMATION: "INFORMATION",
  DECISION: "DECISION",
  CLARIFICATION: "CLARIFICATION",
  AUTHORIZATION: "AUTHORIZATION",
}

export const DECISION_STATUS = {
  PENDING: "PENDING",
  ANSWERED: "ANSWERED",
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
}

const DECISIONS_FILE = "askings.json"
const MAX_STORED = 60
const ASK_COOLDOWN_MS = 30 * 60 * 1000 // same key never re-asked for 30 min

export function askingsPath(cwd) {
  return path.join(projectDir(cwd), DECISIONS_FILE)
}

export function loadAskings(cwd) {
  try {
    const j = JSON.parse(fs.readFileSync(askingsPath(cwd), "utf8"))
    return Array.isArray(j?.items) ? j.items : []
  } catch { return [] }
}

export function saveAskings(cwd, items) {
  try {
    fs.mkdirSync(path.dirname(askingsPath(cwd)), { recursive: true })
    fs.writeFileSync(askingsPath(cwd), JSON.stringify({ items }, null, 1), "utf8")
    return true
  } catch { return false }
}

export function validDecisionType(t) { return Object.values(DECISION_TYPE).includes(t) }

let seq = 0
export function decisionId() { return `dec-${Date.now().toString(36)}-${++seq}` }

/** Build a well-formed decision record (§40 schema). */
export function buildDecision({
  type = DECISION_TYPE.DECISION, title = "", question = "",
  options = [], recommendation = null, reason = "", context = null,
  taskId = null, nodeId = null, key = null, consequences = {},
} = {}) {
  const opts = (Array.isArray(options) ? options : [options])
    .map((o, i) => {
      if (typeof o === "string") return { id: `opt${i + 1}`, label: String(o).slice(0, 200), consequences: "" }
      return {
        id: String(o?.id ?? `opt${i + 1}`).slice(0, 40),
        label: String(o?.label ?? o?.title ?? `option ${i + 1}`).slice(0, 200),
        consequences: String(o?.consequences ?? "").slice(0, 300),
      }
    })
    .slice(0, 6)
  return {
    decision_id: decisionId(),
    type: validDecisionType(type) ? type : DECISION_TYPE.DECISION,
    title: String(title ?? "").slice(0, 200),
    question: String(question ?? "").slice(0, 600),
    options: opts,
    recommendation: recommendation != null ? String(recommendation).slice(0, 40) : null,
    reason: String(reason ?? "").slice(0, 400),
    context: context != null ? String(context).slice(0, 1000) : null,
    task_id: taskId != null ? String(taskId).slice(0, 120) : null,
    node_id: nodeId != null ? String(nodeId).slice(0, 120) : null,
    key: String(key ?? title ?? question ?? "decision").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80),
    status: DECISION_STATUS.PENDING,
    created_at: Date.now(),
    answered_at: null,
    answer: null,
    answer_note: null,
    consequences,
  }
}

/**
 * The decision engine. `onWait` (optional) is called when a decision starts
 * waiting — Core uses it to transition the task to WAITING_FOR_USER.
 */
export function createDecisionEngine({ cwd = process.cwd(), taskId = null, onWait = null, clock = null } = {}) {
  const now = () => (typeof clock === "function" ? clock() : Date.now())
  let items = loadAskings(cwd)

  const persist = () => {
    items = items.slice(-MAX_STORED)
    saveAskings(cwd, items)
  }

  function pendingList() { return items.filter((d) => d.status === DECISION_STATUS.PENDING) }

  /** v96 unifywise: the Core and the meta controller each hold an engine
   *  instance over the SAME askings.json. A decision the OTHER instance
   *  asked after this one loaded would otherwise stay invisible to this
   *  instance's pending list (a stale in-memory copy). reload() re-reads
   *  the file — cheap, bounded, honest. */
  function reload() {
    const fresh = loadAskings(cwd)
    // never lose a decision this instance just asked but has not persisted…
    // persist() writes immediately on ask(), so anything in `items` not on
    // disk yet is a race window of milliseconds — the file is authoritative.
    items = fresh.length >= items.length ? fresh : items
    return items.length
  }

  /**
   * Should we ask at all? Autonomous default: NO when this exact key was
   * asked recently, or when it was already answered in this project.
   * Returns { ask: boolean, why }.
   */
  function shouldAsk(key) {
    const k = String(key ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80)
    const prior = items.filter((d) => d.key === k)
    const answered = prior.find((d) => d.status === DECISION_STATUS.ANSWERED)
    if (answered) return { ask: false, why: `already answered in this project (${answered.answer})` }
    const last = prior[prior.length - 1]
    if (last && now() - last.created_at < ASK_COOLDOWN_MS) {
      return { ask: false, why: "asked recently — do not nag the user" }
    }
    return { ask: true, why: "no prior answer for this decision" }
  }

  /**
   * Ask the user a genuine decision. Persists the record, calls onWait (Core
   * transitions to WAITING_FOR_USER), and returns the pending record.
   * When shouldAsk refuses, returns { skipped: true, why } — the caller must
   * answer it from project evidence instead.
   */
  function ask(spec = {}) {
    const gate = shouldAsk(spec.key ?? spec.title ?? spec.question)
    if (!gate.ask) return { skipped: true, why: gate.why }
    const d = buildDecision({ ...spec, taskId: spec.taskId ?? taskId })
    items.push(d)
    persist()
    try { onWait?.(d) } catch { /* observability never breaks */ }
    return d
  }

  /**
   * Resolve a pending decision with the user's answer.
   * `choice` is an option id or free text. Returns the updated record or null.
   */
  function resolve(decisionId, { choice = null, note = null, cancelled = false } = {}) {
    const d = items.find((x) => x.decision_id === decisionId || x.key === decisionId)
    if (!d || d.status !== DECISION_STATUS.PENDING) return null
    d.status = cancelled ? DECISION_STATUS.CANCELLED : DECISION_STATUS.ANSWERED
    d.answered_at = Date.now()
    d.answer = choice != null ? String(choice).slice(0, 200) : null
    d.answer_note = note != null ? String(note).slice(0, 600) : null
    persist()
    return d
  }

  /** Expire stale pending decisions (user never answered, task moved on). */
  function expireOlderThan(ms) {
    const cutoff = now() - ms
    let n = 0
    for (const d of items) {
      if (d.status === DECISION_STATUS.PENDING && d.created_at < cutoff) { d.status = DECISION_STATUS.EXPIRED; n++ }
    }
    if (n) persist()
    return n
  }

  function list({ status = null, max = 20 } = {}) {
    return items
      .filter((d) => (status ? d.status === status : true))
      .slice(-max)
  }

  return { ask, resolve, shouldAsk, pendingList, reload, list, expireOlderThan, get size() { return items.length } }
}

/**
 * §68 — render the DECISION REQUIRED panel for the TUI.
 *   ┌─ DECISION REQUIRED ─────
 *   │ title / question
 *   │ [A] option label — consequences
 *   │ Recommended: B — reason
 */
export function formatDecisionPanel(d, { width = 56 } = {}) {
  if (!d) return ""
  const lines = []
  lines.push(`┌─ DECISION REQUIRED (${d.type}) ${"─".repeat(Math.max(0, width - 26 - d.type.length))}┐`)
  const push = (s) => lines.push(`│ ${s.padEnd(width - 4)} │`)
  if (d.title) push(d.title.slice(0, width - 6))
  if (d.question) push(d.question.slice(0, width - 6))
  push("")
  const letters = "ABCDEF"
  d.options.forEach((o, i) => {
    push(`[${letters[i] ?? i}] ${o.label}`)
    if (o.consequences) push(`     ${o.consequences}`.slice(0, width - 6))
  })
  push("")
  if (d.recommendation) {
    const rec = d.options.find((o) => o.id === d.recommendation)
    push(`Recommended: ${d.recommendation}${rec ? ` (${rec.label})` : ""}`)
  }
  if (d.reason) push(`Reason: ${d.reason}`)
  push("[Choose an option] [Explain] [Cancel]")
  lines.push(`└${"─".repeat(width - 2)}┘`)
  return lines.join("\n")
}

/** One-line summary for logs. */
export function formatDecisionLine(d) {
  if (!d) return ""
  const s = d.status === DECISION_STATUS.ANSWERED ? `answered: ${d.answer}` : d.status.toLowerCase()
  return `[${d.type}] ${d.title || d.key} — ${s}`
}
