/**
 * forge — conversation → task brief (v107 "carrywise", zero dependencies)
 *
 * THE BUG THIS MODULE EXISTS FOR, reproduced against the real runtime before a
 * line of it was written:
 *
 *   $ forge chat
 *   > Build a CSV-to-JSON converter in convert.js with a --pretty flag
 *   · noted: goal
 *   > /agent yes, authorized, start
 *   ◇ task [critical risk] started — yes, authorized, start
 *
 * The prompts the agent run actually sent contained the words "yes, authorized,
 * start" and did not contain the word CSV anywhere. chat.js launches every
 * agent run with `runAgentTask(line)` — the line the user just typed — and the
 * conversation that produced that line is never passed along. So the agent's
 * entire objective was the authorization, and it said so: "I don't have the
 * actual task in this conversation — just the authorization."
 *
 * forge had already classified the goal turn ("· noted: goal", msgclass.js) and
 * then thrown it away. Nothing here is new intelligence; this module carries
 * what forge already knew across the one seam where it was being dropped.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - it never rewrites a line that states its own task. A launch line is only
 *     recomposed when it classifies as PURELY referential (approval, consent,
 *     a pick from a list) — an unclassified line is treated as a task exactly
 *     as before, so ordinary use is untouched.
 *   - it never drops the launch line. Whatever the user typed is always the
 *     last thing in the composed objective and always verbatim.
 *   - it never invents a goal. With nothing in the conversation to carry, the
 *     brief says so (`underspecified`) instead of filling the gap.
 *   - it does not re-implement requirement evolution. Later corrections are
 *     resolved through reqdelta.js — the same code v106 resumes with — so
 *     there is one answer in the repository to "what is still required".
 */
import { classifyUserMessage } from "./msgclass.js"
import { requirementDelta } from "./reqdelta.js"

/** How a launch line relates to the conversation it was typed into. */
export const LAUNCH = Object.freeze({
  EMPTY: "empty",              // nothing to run
  STANDALONE: "standalone",    // the line states its own task
  REFERENTIAL: "referential",  // the line only points back at the conversation
})

/**
 * Classes that carry task content. A line with any of these says what to do,
 * so it is run as written — this is the guard that keeps ordinary use
 * byte-identical to the behaviour before this module existed.
 */
const CONTENT_CLASSES = new Set(["goal", "requirement", "constraint", "scope_change", "preference", "priority", "correction"])

/** Classes that only refer to something already said. */
const REFERENTIAL_CLASSES = new Set(["approval", "continue", "stop", "rejection", "decision", "clarification"])

/**
 * Is this line a task, or a pointer back at the conversation?
 *
 * An UNCLASSIFIED line is STANDALONE. That is the conservative direction: the
 * classifier matching nothing is not evidence of emptiness, and treating such a
 * line as a task is exactly what forge did before.
 */
export function launchKind(line) {
  const t = String(line ?? "").trim()
  if (!t) return LAUNCH.EMPTY
  const c = classifyUserMessage(t)
  const names = (c.classes ?? []).map((x) => x.cls)
  if (names.some((n) => CONTENT_CLASSES.has(n))) return LAUNCH.STANDALONE
  if (names.some((n) => REFERENTIAL_CLASSES.has(n))) return LAUNCH.REFERENTIAL
  return LAUNCH.STANDALONE
}

/**
 * v108 — is this line an ANSWER to a question that was just asked?
 *
 * `launchKind` alone cannot tell. "SQLite" classifies as nothing, so the
 * conservative rule (unclassified → the line is its own task) makes it
 * STANDALONE — correct with no question on the table, and exactly wrong right
 * after forge asked "SQLite or flat JSON?". What makes a line an answer is not
 * its wording, it is the question sitting in front of it.
 *
 * Three signals, strongest first. A line carrying real task content is never an
 * answer, whatever else matches — a new instruction outranks a stale question,
 * and that guard is what keeps v107's promise that a task line runs as written.
 */
export function isAnswerLike(line, { options = [] } = {}) {
  const t = String(line ?? "").trim()
  if (!t) return false
  const names = (classifyUserMessage(t).classes ?? []).map((x) => x.cls)
  if (names.some((n) => CONTENT_CLASSES.has(n))) return false
  const norm = (x) => String(x ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  const nt = norm(t)
  // 1. it names one of the options forge offered
  for (const o of Array.isArray(options) ? options : []) {
    for (const cand of [o?.label, o?.id, o]) {
      const nc = norm(cand)
      if (nc && (nt === nc || nt.split(" ").includes(nc) || nt.includes(nc))) return true
    }
  }
  // 2. it is consent, a pick, or a refusal
  if (names.some((n) => REFERENTIAL_CLASSES.has(n))) return true
  // 3. it is too short to be an instruction — a bare noun is an answer
  return nt.split(" ").filter(Boolean).length <= 6
}

/** Flatten a chat message's content to text (vision turns arrive as parts). */
export function messageText(m) {
  const c = m?.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : (p?.type === "text" ? String(p.text ?? "") : ""))).filter(Boolean).join("\n")
  return ""
}

/**
 * The user turns of a conversation, classified, oldest first.
 *
 * Synthetic turns are excluded: `[agent task] …` is forge's own record of a
 * previous run and `AUTO-COMPACTED …` is a compaction marker. Feeding either
 * back in would make a run's objective grow a copy of itself on every launch.
 */
export function userTurns(messages = []) {
  const out = []
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.role !== "user") continue
    const text = messageText(m).trim()
    if (!text) continue
    if (text.startsWith("[agent task]") || text.startsWith("AUTO-COMPACTED")) continue
    const c = classifyUserMessage(text)
    out.push({ text, classes: (c.classes ?? []).map((x) => x.cls), primary: c.primary })
  }
  return out
}

const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s))

/**
 * v108 — the last question forge asked, so the user's answer is not orphaned.
 *
 * "It asks me something, I answer, and it doesn't know what I'm talking about."
 * A referential line IS an answer, and an answer without its question is
 * meaningless: "SQLite" or "option 2" says nothing on its own. v107 carried the
 * goal and the requirements across this seam and still dropped the one turn the
 * answer is a reply to, because it only ever read `role === "user"`.
 *
 * Only the LAST assistant turn is considered, and only when it actually asks:
 * an older question has been overtaken, and a statement is not a question just
 * because it came from forge.
 */
export function lastQuestionAsked(messages = []) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m?.role === "user") return null            // the user already moved on
    if (m?.role !== "assistant") continue
    const text = messageText(m).trim()
    if (!text) continue
    // the question is the last interrogative line — what the user is answering
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean)
    for (let j = lines.length - 1; j >= 0; j--) if (lines[j].includes("?")) return clip(lines[j], 300)
    return null
  }
  return null
}

function bucket(turns, cls, { exclude = new Set(), max = 6, limit = 200 } = {}) {
  const seen = new Set()
  const out = []
  for (const t of turns) {
    if (!t.classes.includes(cls)) continue
    if (exclude.has(t.text)) continue
    if (seen.has(t.text)) continue
    seen.add(t.text)
    out.push(clip(t.text, limit))
  }
  // most recent wins when there are more than `max`: a later statement about
  // the same subject is the one the user is standing behind
  return out.slice(-max)
}

/**
 * Build the brief for an agent run launched from `line` inside `messages`.
 *
 * @returns {{
 *   kind, objective, composed, underspecified,
 *   goal, requirements, constraints, decisions, corrections, invalidated,
 *   summary
 * }}
 *   `objective` is what the run should actually be given. `composed` is false
 *   whenever `objective === line`, so a caller can tell "carried context" from
 *   "ran it as typed" without comparing strings.
 */
export function conversationBrief({ line = "", messages = [], pendingQuestion = null, questionOptions = [], maxChars = 4000 } = {}) {
  const launch = String(line ?? "").trim()
  const turns = userTurns(messages)
  const asked = lastQuestionAsked(messages) ?? (pendingQuestion ? clip(pendingQuestion, 300) : null)
  // A line answering a question forge just asked is referential even when its
  // own wording says nothing ("SQLite"). Composition is purely additive — the
  // launch line always survives verbatim — so widening the test here can add
  // context to a run but can never take the user's instruction away.
  const kind = launchKind(launch) === LAUNCH.REFERENTIAL
    ? LAUNCH.REFERENTIAL
    : (asked && isAnswerLike(launch, { options: questionOptions }) ? LAUNCH.REFERENTIAL : launchKind(launch))

  const empty = {
    kind, objective: launch, composed: false, underspecified: false,
    goal: null, requirements: [], constraints: [], decisions: [], corrections: [], invalidated: [], question: null,
    summary: "",
  }
  if (kind === LAUNCH.STANDALONE || kind === LAUNCH.EMPTY) return empty

  // THE GOAL: the most recent turn the classifier called a goal. Falling back
  // to the earliest turn that states its own task keeps a conversation that
  // opened with an unclassified instruction ("fix the crash in parser.js")
  // from losing its subject — that turn is a task by the same test the launch
  // line is judged by, so the two rules cannot disagree.
  let goal = null
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].classes.includes("goal")) { goal = turns[i].text; break }
  if (!goal) {
    const first = turns.find((t) => launchKind(t.text) === LAUNCH.STANDALONE)
    goal = first ? first.text : null
  }

  const exclude = new Set(goal ? [goal] : [])
  const requirements = bucket(turns, "requirement", { exclude })
  const constraints = bucket(turns, "constraint", { exclude })
  const decisions = bucket(turns, "decision", { exclude })
  const corrections = [...bucket(turns, "correction", { exclude, max: 3 }), ...bucket(turns, "scope_change", { exclude, max: 3 })]

  // What the corrections killed. reqdelta.js owns requirement evolution — v106
  // resumes through the same function — so this asks it rather than deciding
  // for itself what a later statement invalidates.
  const invalidated = []
  if (corrections.length) {
    const previous = [goal, ...requirements].filter(Boolean)
    for (const c of corrections) {
      let d = null
      try { d = requirementDelta({ previous, message: c }) } catch { d = null }
      for (const item of d?.invalidated ?? []) if (item.text && !invalidated.includes(item.text)) invalidated.push(clip(item.text, 160))
    }
  }

  // the question this line is answering — from the conversation, or from the
  // decision store when forge asked it in an earlier session
  const question = asked

  const carried = goal || requirements.length || constraints.length || decisions.length || corrections.length || question
  if (!carried) return { ...empty, underspecified: true }

  const sections = []
  if (requirements.length) sections.push(`REQUIRED: ${requirements.join("; ")}`)
  if (constraints.length) sections.push(`CONSTRAINTS: ${constraints.join("; ")}`)
  if (decisions.length) sections.push(`DECIDED: ${decisions.join("; ")}`)
  if (corrections.length) sections.push(`CORRECTED (the later statement wins): ${corrections.join("; ")}`)
  if (invalidated.length) sections.push(`NO LONGER VALID (do not build these): ${invalidated.join("; ")}`)
  if (question) sections.push(`THE LAUNCH INSTRUCTION BELOW ANSWERS THIS QUESTION: ${question}`)

  const blocks = [
    goal ?? null,
    sections.length
      ? ["CONTEXT — this run was launched from a conversation and the user did not repeat what was already said:", ...sections].join("\n")
      : null,
    `[the user's launch instruction, verbatim] ${launch}`,
  ].filter(Boolean)
  const objective = blocks.join("\n\n").slice(0, maxChars)

  const counts = []
  if (goal) counts.push("goal")
  if (requirements.length) counts.push(`${requirements.length} requirement(s)`)
  if (constraints.length) counts.push(`${constraints.length} constraint(s)`)
  if (decisions.length) counts.push(`${decisions.length} decision(s)`)
  if (corrections.length) counts.push(`${corrections.length} correction(s)`)
  if (invalidated.length) counts.push(`${invalidated.length} invalidated`)
  if (question) counts.push("the question it answers")

  return {
    kind, objective, composed: true, underspecified: false,
    goal, requirements, constraints, decisions, corrections, invalidated, question,
    summary: counts.join(", "),
  }
}

/**
 * The other half of the same gap: a referential launch line in a conversation
 * that carries nothing.
 *
 * `forge chat` in a directory with previous work reattaches to it, and
 * rehydrate.js reconstructs what was done, what is open and what went stale
 * from the real stores. That reconstruction was printed to the terminal and
 * nowhere else — chat.js console.log'd it and never gave it to anyone. So a
 * user who opened a new session and typed "continue" launched a run whose
 * objective was the word "continue", while forge had the answer on screen.
 *
 * This composes an objective from a reconstruction that already exists. It
 * takes the built object rather than building one, so this module stays free
 * of the session/run/task stores and can be tested without them.
 */
export function briefFromRehydration({ line = "", rehydration = null, maxChars = 4000 } = {}) {
  const launch = String(line ?? "").trim()
  const r = rehydration
  const goal = r?.goal ? clip(r.goal, 300) : null
  const open = (r?.incomplete ?? []).slice(0, 4).map((x) => clip(x, 160))
  const next = r?.nextAction ? clip(r.nextAction, 200) : null
  const blockers = (r?.blockers ?? []).slice(0, 3).map((x) => clip(x, 160))
  const requirements = (r?.requirements ?? []).slice(0, 4).map((x) => clip(x, 160))
  const decisions = (r?.decisions ?? []).slice(0, 4).map((x) => clip(x, 160))
  const stale = (r?.stale ?? []).slice(0, 4)

  if (!goal && !open.length && !next && !requirements.length && !decisions.length) {
    return { objective: launch, composed: false, underspecified: true, summary: "" }
  }

  const sections = []
  if (requirements.length) sections.push(`REQUIRED: ${requirements.join("; ")}`)
  if (decisions.length) sections.push(`DECIDED: ${decisions.join("; ")}`)
  if (open.length) sections.push(`STILL OPEN: ${open.join("; ")}`)
  if (next) sections.push(`RECORDED NEXT ACTION: ${next}`)
  if (blockers.length) sections.push(`BLOCKED BY: ${blockers.join("; ")}`)
  if (stale.length) sections.push(`GONE FROM DISK (verify before trusting): ${stale.join(", ")}`)

  const blocks = [
    goal,
    ["CONTEXT — reconstructed from this project's own records (task store, run journals, session store), not from this conversation.",
      "It describes state as it was recorded. Verify against the working tree before relying on any line of it:",
      ...sections].join("\n"),
    `[the user's launch instruction, verbatim] ${launch}`,
  ].filter(Boolean)

  const counts = []
  if (goal) counts.push("previous goal")
  if (open.length) counts.push(`${open.length} open item(s)`)
  if (next) counts.push("recorded next action")
  if (blockers.length) counts.push(`${blockers.length} blocker(s)`)

  return { objective: blocks.join("\n\n").slice(0, maxChars), composed: true, underspecified: false, summary: counts.join(", ") }
}
