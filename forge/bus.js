/**
 * forge — agent communication bus (v91 ∞ CORE, §27-29, zero dependencies)
 *
 * A first-class message bus between engineering entities: sub-agents, the
 * Forge Core, and the Crew Manager. Before v91 the only "communication" was
 * worker findings concatenated into the main agent's next prompt. That hid
 * discoveries, could not route a question to the right specialist, and gave
 * the TUI nothing meaningful to show.
 *
 * Topologies (§27):
 *   Agent → Agent          worker asks another worker / hands over
 *   Agent → Core           findings, blockers, warnings, completion claims
 *   Core → Agent           missions, decisions, invalidations, answers
 *   Agent → Crew Manager   progress, conflicts, blocked reports
 *   Crew Manager → Agent   assignments, handoffs, cancellations
 *
 * Message schema (§27) — every field the spec names is present and bounded:
 *   sender, receiver, task_id, node_id, message_id, message_type, priority,
 *   content, evidence_refs, file_refs, symbol_refs, confidence,
 *   requires_action, timestamp, causal_context.
 *
 * Anti-flood (§29 "do not create unnecessary communication overhead"):
 *   - identical (from,to,type,content) inside the dedupe window is dropped
 *   - per-participant inbox is bounded (oldest PROGRESS dropped first)
 *   - the on-disk log is JSONL, append-only, size-capped
 *
 * The bus never executes anything and never trusts content: evidence_refs
 * point at ledger records, file_refs at world-model paths. It is transport +
 * audit, not truth. Truth stays in the evidence ledger and the world model.
 */
import fs from "node:fs"
import path from "node:path"
import { DEFAULT_DIR } from "./config.js"

export const MESSAGE_TYPE = {
  DISCOVERY: "DISCOVERY",
  FINDING: "FINDING",
  QUESTION: "QUESTION",
  REQUEST: "REQUEST",
  HYPOTHESIS: "HYPOTHESIS",
  EVIDENCE: "EVIDENCE",
  WARNING: "WARNING",
  CONFLICT: "CONFLICT",
  PROGRESS: "PROGRESS",
  BLOCKED: "BLOCKED",
  HANDOFF: "HANDOFF",
  VERIFIED: "VERIFIED",
  REJECTED: "REJECTED",
  COMPLETED: "COMPLETED",
}

export const MESSAGE_TYPES = new Set(Object.values(MESSAGE_TYPE))

export const PRIORITY = { LOW: 0, NORMAL: 1, HIGH: 2, CRITICAL: 3 }

export const PARTICIPANT_KIND = { AGENT: "agent", CORE: "core", CREW: "crew", USER: "user" }

const MAX_LOG = 2000            // in-memory ring cap
const MAX_INBOX = 100           // per-participant cap
const MAX_CONTENT = 2000        // chars per message body
const MAX_REFS = 32             // per ref list
const DEDUPE_WINDOW_MS = 1500   // identical messages inside this window drop
const DEFAULT_ASK_TIMEOUT_MS = 60_000

const CORE_ID = "core"
const CREW_ID = "crew"

export function messageId() {
  const rnd = Math.random().toString(36).slice(2, 8)
  return `msg-${Date.now().toString(36)}-${rnd}`
}

export function validMessageType(t) { return MESSAGE_TYPES.has(t) }
export function validPriority(p) { const n = Number(p); return Number.isFinite(n) && n >= 0 && n <= 3 ? n : PRIORITY.NORMAL }

/** Where the per-task bus log lives (JSONL, sibling of the task record). */
export function busPath(taskId) {
  const safe = String(taskId ?? "task").replace(/[^A-Za-z0-9._-]/g, "_")
  return path.join(DEFAULT_DIR, "tasks", `${safe}.bus.jsonl`)
}

/** Clamp + normalize one message. Returns null when structurally invalid. */
export function normalizeMessage(m) {
  if (!m || typeof m !== "object") return null
  const type = String(m.message_type ?? m.type ?? "").toUpperCase()
  if (!MESSAGE_TYPES.has(type)) return null
  const sender = String(m.sender ?? m.from ?? "").trim()
  const receiver = String(m.receiver ?? m.to ?? "").trim()
  if (!sender || !receiver) return null
  const ref = (arr) => (Array.isArray(arr) ? arr.map((x) => String(x ?? "").slice(0, 300)).filter(Boolean).slice(0, MAX_REFS) : [])
  return {
    message_id: String(m.message_id ?? "").trim() || messageId(),
    message_type: type,
    sender,
    receiver,
    task_id: m.task_id != null ? String(m.task_id).slice(0, 120) : null,
    node_id: m.node_id != null ? String(m.node_id).slice(0, 120) : null,
    priority: validPriority(m.priority),
    content: String(m.content ?? "").slice(0, MAX_CONTENT),
    evidence_refs: ref(m.evidence_refs),
    file_refs: ref(m.file_refs),
    symbol_refs: ref(m.symbol_refs),
    confidence: clamp01(m.confidence ?? 0.5),
    requires_action: m.requires_action === true,
    in_reply_to: m.in_reply_to != null ? String(m.in_reply_to).slice(0, 80) : null,
    causal_context: m.causal_context != null ? String(m.causal_context).slice(0, 300) : null,
    timestamp: Number.isFinite(Number(m.timestamp)) ? Number(m.timestamp) : Date.now(),
  }
}

export function createBus({ taskId = null, maxLog = MAX_LOG, persist = false, clock = null } = {}) {
  const now = () => (typeof clock === "function" ? clock() : Date.now())
  const log = []                  // every message, bounded ring
  const inboxes = new Map()       // participantId → [message]
  const participants = new Map()  // participantId → { kind, role, meta, joinedAt }
  const pending = new Map()       // message_id → { resolve, timer } for ask/reply
  const recent = []               // dedupe ring: `${from}|${to}|${type}|${content}`
  let overflow = 0                // dropped-by-cap counter (observability, never silent)

  const file = taskId ? busPath(taskId) : null

  function appendDisk(msg) {
    if (!persist || !file) return
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, JSON.stringify(msg) + "\n", "utf8")
      trimDisk()
    } catch { /* transport never breaks the run */ }
  }

  function trimDisk() {
    try {
      const st = fs.statSync(file)
      if (st.size <= 2_000_000) return
      // drop the oldest half, keep append-only semantics otherwise
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
      fs.writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n", "utf8")
    } catch { }
  }

  function load() {
    if (!file) return 0
    let n = 0
    try {
      const text = fs.readFileSync(file, "utf8")
      for (const line of text.split("\n")) {
        if (!line.trim()) continue
        try {
          const m = normalizeMessage(JSON.parse(line))
          if (m) { log.push(m); if (m.receiver !== "*") inboxFor(m.receiver).push(m); n++ }
        } catch { }
      }
      if (log.length > maxLog) log.splice(0, log.length - maxLog)
    } catch { }
    return n
  }

  function inboxFor(id) {
    let box = inboxes.get(id)
    if (!box) { box = []; inboxes.set(id, box) }
    return box
  }

  function dedupeKey(m) { return `${m.sender}|${m.receiver}|${m.message_type}|${m.content}` }

  function isDuplicate(m) {
    const t = now()
    const key = dedupeKey(m)
    for (let i = recent.length - 1; i >= 0; i--) {
      if (t - recent[i].t > DEDUPE_WINDOW_MS) { recent.splice(0, i + 1); break }
      if (recent[i].k === key) return true
    }
    recent.push({ k: key, t })
    if (recent.length > 200) recent.splice(0, recent.length - 200)
    return false
  }

  /**
   * Send a message. `to: "*"` broadcasts to every participant except sender.
   * Returns the normalized message, or null when it was invalid or a
   * duplicate inside the dedupe window.
   */
  function send(spec = {}) {
    const m = normalizeMessage({ ...spec, timestamp: spec.timestamp ?? now() })
    if (!m) return null
    if (isDuplicate(m)) return null
    // participants auto-register: communication must not require ceremony
    if (!participants.has(m.sender)) register(m.sender, { kind: m.sender === CORE_ID ? PARTICIPANT_KIND.CORE : m.sender === CREW_ID ? PARTICIPANT_KIND.CREW : PARTICIPANT_KIND.AGENT })
    log.push(m)
    if (log.length > maxLog) { log.splice(0, log.length - maxLog); overflow++ }
    appendDisk(m)
    if (m.receiver === "*") {
      for (const id of participants.keys()) {
        if (id === m.sender) continue
        deliver(id, m)
      }
    } else {
      deliver(m.receiver, m)
      // core mirrors everything addressed to it — the crew manager watches
      if (m.receiver === CORE_ID) deliver(CREW_ID, m)
    }
    return m
  }

  function deliver(id, m) {
    const box = inboxFor(id)
    box.push(m)
    if (box.length > MAX_INBOX) {
      // drop oldest low-priority PROGRESS first; never drop requires_action
      const idx = box.findIndex((x) => x.message_type === MESSAGE_TYPE.PROGRESS && !x.requires_action && !x.in_reply_to)
      if (idx >= 0) box.splice(idx, 1)
      else box.shift()
    }
    // resolve a pending question reply
    if (m.in_reply_to && pending.has(m.in_reply_to)) {
      const p = pending.get(m.in_reply_to)
      clearTimeout(p.timer)
      pending.delete(m.in_reply_to)
      p.resolve(m)
    }
  }

  /** §29 — ask a targeted question and await the reply. Resolves with the
   *  reply message, or null on timeout. Questions must be minimal: the
   *  content is capped hard. */
  function ask({ from, to, content, timeoutMs = DEFAULT_ASK_TIMEOUT_MS, node_id = null, evidence_refs = [], file_refs = [], priority = PRIORITY.HIGH, causal_context = null } = {}) {
    const q = send({
      sender: from, receiver: to, message_type: MESSAGE_TYPE.QUESTION,
      content: String(content ?? "").slice(0, 500), node_id, evidence_refs, file_refs,
      priority, requires_action: true, causal_context,
    })
    if (!q) return Promise.resolve(null)
    return new Promise((resolve) => {
      // NOTE: this timer is deliberately NOT unref'd — the asker is blocked on
      // this promise and must always be woken (with null) when nobody answers.
      const timer = setTimeout(() => { pending.delete(q.message_id); resolve(null) }, Math.max(1, timeoutMs))
      pending.set(q.message_id, { resolve, timer, questionSender: q.sender })
    })
  }

  /** Answer a QUESTION. Returns the reply message or null when the question
   *  is no longer pending (timed out / already answered). */
  function reply(questionId, { from, content, evidence_refs = [], file_refs = [], confidence = 0.8 } = {}) {
    if (!questionId) return null
    const p = pending.get(questionId)
    if (!p) return null
    return send({
      sender: from, receiver: p.questionSender ?? CORE_ID,
      message_type: MESSAGE_TYPE.FINDING, content, evidence_refs, file_refs,
      confidence, in_reply_to: questionId,
    })
  }

  // handoffs get their own module (handoff.js) — the bus carries the message

  function register(id, { kind = PARTICIPANT_KIND.AGENT, role = null, meta = null } = {}) {
    const pid = String(id ?? "").trim()
    if (!pid) return false
    if (!participants.has(pid)) participants.set(pid, { kind, role, meta, joinedAt: now() })
    inboxFor(pid)
    return true
  }
  function unregister(id) {
    participants.delete(id)
    inboxes.delete(id)
    return true
  }

  /** Read a participant's inbox without draining. */
  function inbox(id, { types = null, since = 0, limit = MAX_INBOX, priorityMin = null } = {}) {
    const box = inboxFor(id)
    return box
      .filter((m) => (types ? types.includes(m.message_type) : true))
      .filter((m) => m.timestamp >= since)
      .filter((m) => priorityMin == null || m.priority >= priorityMin)
      .slice(-limit)
  }

  /** Read + clear a participant's inbox (the worker loop drains each turn). */
  function drain(id, opts = {}) {
    const items = inbox(id, opts)
    inboxes.set(id, [])
    return items
  }

  /** Whole log view for the TUI comm view (§65) — meaningful messages only. */
  function view({ types = null, limit = 30, meaningfulOnly = true } = {}) {
    const NOISE = meaningfulOnly ? new Set([MESSAGE_TYPE.PROGRESS]) : null
    return log
      .filter((m) => (types ? types.includes(m.message_type) : true))
      .filter((m) => (NOISE ? !NOISE.has(m.message_type) || m.requires_action : true))
      .slice(-limit)
  }

  function stats() {
    const byType = {}
    for (const m of log) byType[m.message_type] = (byType[m.message_type] ?? 0) + 1
    return {
      messages: log.length, overflow, participants: participants.size,
      pendingQuestions: pending.size, byType,
    }
  }

  function flush() { return { ok: true, file, persisted: Boolean(persist && file) } }

  return {
    send, ask, reply, register, unregister, inbox, drain, view, stats, load, flush,
    log: () => [...log],
    participants: () => new Map(participants),
    CORE_ID, CREW_ID,
  }
}

/** §65 — one line for the TUI communication view. */
export function formatMessage(m) {
  if (!m) return ""
  const arrow = m.receiver === "*" ? "→ *all*" : `→ ${m.receiver}`
  return `[${m.message_type}] ${m.sender} ${arrow}: ${m.content}`
}

function clamp01(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 0.5
  return Math.max(0, Math.min(1, x))
}
