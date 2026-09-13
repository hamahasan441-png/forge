/**
 * forge — agent context compaction (v21.1 P1).
 *
 * v20 `compactAgentHistory` did two things when the history grew: replaced
 * old tool outputs with "[tool output shrunk: N chars]" and, past a second
 * threshold, asked the model to summarise `middle.slice(2, -4)` where each
 * message had been cut to its first 400 characters. Three defects:
 *
 *   1. `slice()` on message INDEX ignores structure. An assistant message
 *      carrying tool_calls and the tool results that answer it are one unit
 *      for every provider API; cutting between them produced histories the
 *      provider rejects ("tool_call_id not found") or, worse, a dangling
 *      tool_calls entry the model answers as if the tool had never run.
 *   2. `content.slice(0, 400)` keeps the *beginning* of a tool result — the
 *      command echo / file header — and drops the part that matters: the
 *      error at the end, the exit code, the "N tests failed" line.
 *   3. The facts an agent must not lose (which files it wrote, which
 *      commands failed with what, what it decided) were entrusted entirely
 *      to a model summary, and when that call failed the catch returned the
 *      history UNCHANGED — so a context-overflow retry overflowed again.
 *
 * This module compacts by MEANING and by STRUCTURE:
 *   - the history is split into turns (assistant + its tool results);
 *   - a deterministic ledger of facts is extracted from tool calls and
 *     results (files written/edited/deleted, commands with exit codes and
 *     their error tails, blocked actions, decisions) — this never depends on
 *     a model call and is the floor of what a summary may contain;
 *   - tool outputs are shrunk head+tail so errors and exit markers survive;
 *   - old turns are folded into ONE summary message = ledger + (optional)
 *     model narrative; the tail keeps whole turns only.
 */
import { estimateTokens } from "./ui.js"
import { stripOldVisionParts } from "./vision.js"

const FILE_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"])
const KEEP_TURNS_DEFAULT = 3

// ---------------------------------------------------------------------------
// structure
// ---------------------------------------------------------------------------

/**
 * Split messages into { head, turns, trailing }:
 *   head     — system + first user (never compacted)
 *   turns    — [{ msgs }] where a turn is an assistant message plus every
 *              tool message that answers one of its tool_calls (or a single
 *              standalone user/assistant message)
 *   trailing — tool messages whose assistant is missing (kept with the
 *              previous turn; never split off)
 */
export function splitTurns(messages) {
  const head = []
  let i = 0
  while (i < messages.length && head.length < 2 && (messages[i]?.role === "system" || (head.length === 1 && messages[i]?.role === "user"))) head.push(messages[i++])
  const turns = []
  let cur = null
  for (; i < messages.length; i++) {
    const m = messages[i]
    if (m?.role === "assistant") {
      if (cur) turns.push(cur)
      cur = { msgs: [m], ids: new Set((m.tool_calls ?? []).map((tc) => tc.id)) }
      continue
    }
    if (m?.role === "tool") {
      if (cur) { cur.msgs.push(m); continue }
      cur = { msgs: [m], ids: new Set() } // orphan tool result — keep as its own unit
      continue
    }
    // user / other → its own turn
    if (cur) turns.push(cur)
    cur = null
    turns.push({ msgs: [m], ids: new Set() })
  }
  if (cur) turns.push(cur)
  return { head, turns }
}

/** True when every assistant tool_call has a matching tool result and no tool result is orphaned. */
export function historyIsWellFormed(messages) {
  const pending = new Set()
  for (const m of messages) {
    if (m?.role === "assistant") {
      if (pending.size) return false
      for (const tc of m.tool_calls ?? []) pending.add(tc.id)
    } else if (m?.role === "tool") {
      if (!pending.has(m.tool_call_id)) return false
      pending.delete(m.tool_call_id)
    } else if (pending.size) return false
  }
  return pending.size === 0
}

// ---------------------------------------------------------------------------
// semantic shrink of a single tool output
// ---------------------------------------------------------------------------

const SIGNAL_LINE = /error|fail|exception|traceback|denied|blocked|not found|cannot|\[exit code|timed out|warning|✗|FAIL|refused|panic|fatal/i

/**
 * Shrink a tool result to ≤ `limit` chars, keeping what carries meaning:
 * the first lines (what was asked / file header), every line that looks like
 * an error or a status marker, and the LAST lines (exit code, summary).
 */
export function shrinkToolOutput(text, limit = 1200) {
  const s = String(text ?? "")
  if (s.length <= limit) return s
  const lines = s.split("\n")
  const headN = Math.min(6, lines.length)
  const tailN = Math.min(8, lines.length - headN)
  const head = lines.slice(0, headN)
  const tail = tailN > 0 ? lines.slice(lines.length - tailN) : []
  const middle = lines.slice(headN, lines.length - tailN)
  const signals = middle.filter((l) => SIGNAL_LINE.test(l)).slice(0, 12)
  let out = [...head]
  if (signals.length) out.push(`… (${middle.length} lines omitted; ${signals.length} notable kept) …`, ...signals)
  else if (middle.length) out.push(`… (${middle.length} lines omitted) …`)
  out.push(...tail)
  let joined = out.join("\n")
  if (joined.length > limit) {
    // still too big (very long lines): keep the beginning and the end
    const half = Math.floor(limit / 2) - 20
    joined = `${joined.slice(0, half)}\n… (${joined.length - 2 * half} chars omitted) …\n${joined.slice(-half)}`
  }
  return `${joined}\n[tool output shrunk from ${s.length} chars]`
}

// ---------------------------------------------------------------------------
// deterministic fact ledger
// ---------------------------------------------------------------------------

function parseArgs(a) {
  if (a && typeof a === "object") return a
  try { return JSON.parse(String(a ?? "{}")) } catch { return {} }
}

/**
 * Extract what must survive compaction from a set of turns. No model call.
 * @returns {{ files: Map<string,string>, commands: Array, blocked: string[], errors: string[], notes: string[], decisions: string[] }}
 */
export function extractLedger(turns) {
  const files = new Map() // path → last action
  const commands = []
  const blocked = []
  const errors = []
  const decisions = []
  for (const t of turns) {
    const byId = new Map()
    for (const m of t.msgs) if (m.role === "tool") byId.set(m.tool_call_id, String(m.content ?? ""))
    for (const m of t.msgs) {
      if (m.role === "assistant" && typeof m.content === "string" && m.content.trim() && !(m.tool_calls?.length)) {
        decisions.push(m.content.trim().replace(/\s+/g, " ").slice(0, 240))
      }
      for (const tc of m.tool_calls ?? []) {
        const name = tc.function?.name ?? tc.name
        const args = parseArgs(tc.function?.arguments ?? tc.args)
        const res = byId.get(tc.id) ?? ""
        const failed = /^(ERROR|BLOCKED)/.test(res)
        if (/^BLOCKED/.test(res)) blocked.push(`${name}: ${res.split("\n")[0].slice(0, 160)}`)
        else if (/^ERROR/.test(res)) errors.push(`${name}${args.path ? ` ${args.path}` : ""}: ${res.split("\n")[0].slice(0, 160)}`)
        if (FILE_TOOLS.has(name) && !failed) {
          const paths = name === "apply_patch" ? [...String(res).matchAll(/(?:updated|created|deleted|wrote)\s+([^\s,;]+)/gi)].map((m) => m[1]) : [args.path].filter(Boolean)
          for (const p of paths) files.set(String(p), name === "write_file" && /created/.test(res) ? "created" : name === "apply_patch" && /deleted/.test(res) ? "deleted" : "edited")
        }
        if (name === "bash") {
          const exit = /\[exit code: (-?\d+)\]/.exec(res)
          const code = exit ? Number(exit[1]) : failed ? null : 0
          const tailLines = res.split("\n").filter((l) => l.trim()).slice(-3).join(" | ").slice(0, 200)
          commands.push({ command: String(args.command ?? "").slice(0, 160), exitCode: code, tail: code === 0 ? "" : tailLines })
        }
      }
    }
  }
  return { files, commands, blocked, errors, decisions }
}

/** Render the ledger as compact text (bounded). */
export function renderLedger(l, { maxChars = 6000 } = {}) {
  const out = []
  if (l.files.size) {
    out.push("FILES CHANGED SO FAR:")
    for (const [p, a] of [...l.files].slice(-60)) out.push(`- ${a}: ${p}`)
  }
  if (l.commands.length) {
    out.push("COMMANDS RUN (last 25):")
    for (const c of l.commands.slice(-25)) out.push(`- ${c.exitCode === 0 ? "ok" : `exit ${c.exitCode ?? "?"}`}: ${c.command}${c.tail ? ` → ${c.tail}` : ""}`)
  }
  if (l.errors.length) { out.push("ERRORS SEEN:"); for (const e of l.errors.slice(-15)) out.push(`- ${e}`) }
  if (l.blocked.length) { out.push("BLOCKED ACTIONS (do not retry the same way):"); for (const b of l.blocked.slice(-10)) out.push(`- ${b}`) }
  if (l.decisions.length) { out.push("AGENT NOTES / DECISIONS:"); for (const d of l.decisions.slice(-8)) out.push(`- ${d}`) }
  let text = out.join("\n")
  if (text.length > maxChars) text = text.slice(0, maxChars) + "\n… (ledger truncated)"
  return text
}

// ---------------------------------------------------------------------------
// compaction
// ---------------------------------------------------------------------------

/**
 * Compact an agent history.
 * @param messages   full history (system, user, assistant/tool turns…)
 * @param opts.window        model context window (tokens)
 * @param opts.force         compact even below the soft threshold
 * @param opts.summarize     async (digestText) → string | null — optional model narrative
 * @param opts.keepTurns     whole turns kept verbatim at the tail (default 3)
 * @returns {{ messages, changed, stats }}
 */
export async function compactHistory(messages, opts = {}) {
  const { window = 128000, force = false, summarize = null, keepTurns = KEEP_TURNS_DEFAULT } = opts
  const stripped = stripOldVisionParts(messages, { keep: 1 })
  const visionStripped = stripped !== messages
  messages = stripped
  const stats = { before: messages.length, after: messages.length, estTokBefore: estimateTokens(JSON.stringify(messages)), estTokAfter: 0, shrunk: 0, folded: 0, summarized: false, stage: "none" }
  const shrinkBudget = Math.floor(window * 0.40)
  const foldBudget = Math.floor(window * 0.55)
  if (!force && stats.estTokBefore < shrinkBudget) {
    stats.estTokAfter = stats.estTokBefore
    if (visionStripped) stats.stage = "vision-strip"
    return { messages, changed: visionStripped, stats }
  }

  const { head, turns } = splitTurns(messages)
  if (!turns.length) { stats.estTokAfter = stats.estTokBefore; return { messages, changed: false, stats } }

  // stage 1 — shrink old tool outputs (head+tail+signals), keep the last turns intact
  const tailStart = Math.max(0, turns.length - keepTurns)
  const shrunkTurns = turns.map((t, ti) => ti >= tailStart ? t : { ...t, msgs: t.msgs.map((m) => {
    if (m.role !== "tool" || typeof m.content !== "string" || m.content.length <= 1200) return m
    const c = shrinkToolOutput(m.content, 1200)
    stats.shrunk += m.content.length - c.length
    return { ...m, content: c }
  }) })
  let out = [...head, ...shrunkTurns.flatMap((t) => t.msgs)]
  let est = estimateTokens(JSON.stringify(out))
  stats.stage = "shrink"
  if (!force && est < foldBudget) {
    stats.after = out.length; stats.estTokAfter = est
    return { messages: out, changed: stats.shrunk > 0, stats }
  }

  // stage 2 — fold everything before the tail into ledger (+ narrative)
  if (turns.length <= keepTurns) {
    // nothing old enough to fold; shrink the tail too rather than give up.
    // Older tail turns go to 600 chars; the LAST turn (the result the model
    // has not reacted to yet) is only touched if that was not enough.
    const lastTurnStart = out.length - turns[turns.length - 1].msgs.length
    const tighten = (msgs, from, to, limit) => msgs.map((m, i) => {
      if (i < from || i >= to || m.role !== "tool" || typeof m.content !== "string" || m.content.length <= limit) return m
      const c = shrinkToolOutput(m.content, limit)
      stats.shrunk += m.content.length - c.length
      return { ...m, content: c }
    })
    let tight = tighten(out, head.length, lastTurnStart, 600)
    let estTight = estimateTokens(JSON.stringify(tight))
    if (estTight >= foldBudget) { tight = tighten(tight, lastTurnStart, tight.length, 1200); estTight = estimateTokens(JSON.stringify(tight)) }
    if (estTight >= stats.estTokBefore) { stats.estTokAfter = stats.estTokBefore; stats.shrunk = 0; return { messages, changed: false, stats } }
    stats.after = tight.length; stats.estTokAfter = estTight; stats.stage = "shrink-tail"
    return { messages: tight, changed: true, stats }
  }
  const oldTurns = shrunkTurns.slice(0, tailStart)
  const ledger = extractLedger(oldTurns)
  const ledgerText = renderLedger(ledger)
  let narrative = null
  if (typeof summarize === "function") {
    try {
      const digest = oldTurns.flatMap((t) => t.msgs).map((m) => {
        if (m.role === "assistant") return `[assistant] ${m.tool_calls?.length ? `called ${m.tool_calls.map((tc) => tc.function?.name ?? tc.name).join(", ")}` : ""} ${String(m.content ?? "").slice(0, 400)}`
        if (m.role === "tool") return `[tool] ${shrinkToolOutput(String(m.content ?? ""), 500)}`
        return `[${m.role}] ${String(m.content ?? "").slice(0, 400)}`
      }).join("\n").slice(0, 20000)
      const s = await summarize(digest)
      if (s && String(s).trim()) { narrative = String(s).trim().slice(0, 2400); stats.summarized = true }
    } catch { narrative = null }
  }
  const summaryMsg = {
    role: "user",
    content: `(system) CONTEXT COMPACTED — ${oldTurns.length} earlier step(s) folded. The facts below are extracted from the actual tool calls and results; trust them over memory.\n\n${ledgerText || "(no file or command activity recorded)"}${narrative ? `\n\nNARRATIVE SUMMARY:\n${narrative}` : ""}`,
  }
  out = [...head, summaryMsg, ...shrunkTurns.slice(tailStart).flatMap((t) => t.msgs)]
  stats.folded = oldTurns.length
  stats.stage = narrative ? "fold+summary" : "fold"
  est = estimateTokens(JSON.stringify(out))
  // stage 3 — still too large (huge tail outputs): tighten the tail's tool outputs
  if (est >= foldBudget) {
    out = out.map((m, i) => {
      if (i <= head.length || m.role !== "tool" || typeof m.content !== "string" || m.content.length <= 800) return m
      const c = shrinkToolOutput(m.content, 800)
      stats.shrunk += m.content.length - c.length
      return { ...m, content: c }
    })
    est = estimateTokens(JSON.stringify(out))
    stats.stage += "+tight"
  }
  // Automatic mode invariant: compaction never returns a LARGER history. On a
  // tiny history the ledger/summary framing can outweigh what folding saved —
  // then the shrink-only form wins, and if even that is not smaller, the
  // input is returned untouched (the pressure was not caused by the history).
  // `force` (the user's /compact, a configured char cap, an overflow retry)
  // asks for the fold itself: older turns are replaced by the ledger+summary
  // even when that is not a byte win — the caller wants fewer, denser turns.
  if (!force) {
    const shrunkOnly = [...head, ...shrunkTurns.flatMap((t) => t.msgs)]
    const estShrunk = estimateTokens(JSON.stringify(shrunkOnly))
    if (estShrunk < est) { out = shrunkOnly; est = estShrunk; stats.folded = 0; stats.summarized = false; stats.stage = "shrink" }
    if (est >= stats.estTokBefore) { stats.after = messages.length; stats.estTokAfter = stats.estTokBefore; stats.stage = "none"; return { messages, changed: false, stats } }
  }
  stats.after = out.length; stats.estTokAfter = est
  return { messages: out, changed: true, stats }
}
