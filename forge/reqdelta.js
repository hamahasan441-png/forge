/**
 * forge — requirement evolution (v103 §6/§7/§17, zero dependencies)
 *
 * WHAT CHANGED, and WHAT STAYS VALID.
 *
 * The repository already had the two ends of this and nothing in between:
 *
 *   msgclass.js  classifies a user turn (requirement / constraint / correction
 *                / scope_change …) — but its output is advisory. chat.js:1076
 *                prints it as "· noted:" and files it in the transcript.
 *                Nothing plans with it.
 *   dag.js       invalidateNodes(): "COMPLETED nodes that do not depend
 *                (transitively) on invalidated ground truth are PRESERVED —
 *                rebuild only the necessary portion." Exported, tested, and
 *                with ZERO production callers.
 *
 * So a follow-up like "change the target from Android to Flutter, keep the
 * trading requirements" had no path from the sentence to the plan. This module
 * is that path: it turns a new user message into a delta over the requirements
 * already on record, and names the plan nodes the delta invalidates — which is
 * exactly the input invalidateNodes() was built to take.
 *
 * HONESTY RULES, because this is the module most able to lie quietly:
 *   - PRESERVED is the DEFAULT. A requirement is only invalidated when the
 *     message gives a concrete reason — never because it was not re-stated.
 *     "Keep everything else the same" is what users mean by silence.
 *   - Invalidation is EVIDENCE-BEARING: every invalidated item carries the
 *     token that did it ("mentions kotlin, which belongs to android") so the
 *     decision can be argued with instead of taken on faith.
 *   - IMPLICATIONS are labeled inferences, never observations. "Offline
 *     read-only implies caching" is a reasonable consequence to plan for, not
 *     a fact read off the repository, and it is returned under its own key so
 *     no caller can mistake one for the other.
 *   - No model call. This is lexical and structural, like msgclass.js.
 */

export const DELTA = Object.freeze({
  PRESERVED: "preserved",
  CHANGED: "changed",
  ADDED: "added",
  REMOVED: "removed",
  INVALIDATED: "invalidated",
})

/**
 * Which technologies belong to which platform.
 *
 * A fact table, deliberately small and specific. Its ONLY job is to answer
 * "does this requirement depend on the platform that just changed?" — so it
 * lists stack-bound tokens, never domain words. `trading`, `portfolio` and
 * `order` are absent on purpose: they survive every platform change, and that
 * survival is the whole point.
 */
export const STACK = Object.freeze({
  android: ["android", "kotlin", "jetpack", "compose", "hilt", "dagger", "room", "workmanager",
    "gradle", "activity", "fragment", "apk", "viewmodel", "livedata", "retrofit", "okhttp", "espresso", "androidx"],
  flutter: ["flutter", "dart", "widget", "pubspec", "riverpod", "bloc", "provider", "getx",
    "sqflite", "hive", "dio", "cupertino", "material app", "flutter_test"],
  ios: ["ios", "swift", "swiftui", "xcode", "uikit", "combine", "core data", "cocoapods", "xctest"],
  web: ["react", "vue", "svelte", "angular", "next.js", "nextjs", "vite", "webpack", "dom", "browser", "css", "tailwind"],
  backend: ["express", "fastify", "django", "flask", "rails", "spring", "laravel", "nest.js", "nestjs"],
})

/** Platform names as a user would write them, mapped to STACK keys. */
const PLATFORM_ALIASES = Object.freeze({
  android: "android", kotlin: "android",
  flutter: "flutter", dart: "flutter",
  ios: "ios", swift: "ios", swiftui: "ios",
  web: "web", react: "web", vue: "web", angular: "web", svelte: "web",
})

/** Consequences worth planning for. Inferences — returned separately, and the
 *  caller is told so. Each is a topic name, not a promise about the code. */
const IMPLICATIONS = Object.freeze([
  { when: /\boffline\b/i, topics: ["local persistence", "caching", "read path", "synchronization", "API/client boundary"] },
  { when: /\breal[- ]?time\b|\blive updates?\b/i, topics: ["streaming transport", "subscription lifecycle", "backpressure"] },
  { when: /\bmulti[- ]?user\b|\bauth(entication|orization)?\b/i, topics: ["identity", "session handling", "access control"] },
  { when: /\bi18n\b|\blocalis(z)?ation\b|\bmultiple languages\b/i, topics: ["string extraction", "locale selection", "formatting"] },
])

const norm = (s) => String(s ?? "").toLowerCase()

/** Words that carry no product meaning, so they cannot make a clause
 *  "substantive" on their own. */
const STOPWORDS = new Set(["the", "and", "for", "with", "using", "app", "application",
  "create", "build", "make", "add", "implement", "write", "use", "new", "our", "its", "that", "this"])

/** Every stack token present in a piece of text, with the platform it belongs to. */
export function stackTokensIn(text) {
  const t = norm(text)
  const hits = []
  for (const [platform, tokens] of Object.entries(STACK)) {
    for (const tok of tokens) {
      // word-ish boundary: "room" must not match "bathroom", "dart" not "dartboard"
      const re = new RegExp(`(^|[^a-z0-9_])${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_]|$)`, "i")
      if (re.test(t)) hits.push({ token: tok, platform })
    }
  }
  return hits
}

/**
 * Did this message change the target platform? Returns { from, to } or null.
 *
 * Only an EXPLICIT redirection counts. A message that merely mentions Flutter
 * ("does Flutter do this too?") is not a platform change, and treating it as
 * one would invalidate a plan over a question.
 */
export function detectPlatformChange(message = "") {
  const m = String(message ?? "")
  // Trailing punctuation is part of the captured word ("Flutter." from "…to
  // Flutter."), which silently defeated every lookup. Found by running the
  // real sentence end to end, not by the unit tests, which all happened to use
  // a comma.
  const alias = (w) => PLATFORM_ALIASES[norm(w).replace(/[^a-z0-9.+#]/g, "").replace(/\.$/, "")] ?? null
  const patterns = [
    /\bfrom\s+([A-Za-z.]+)\s+to\s+([A-Za-z.]+)/i,
    /\b(?:change|switch|move|migrate|port)\b[^.\n]{0,40}?\bto\s+([A-Za-z.]+)\s+instead of\s+([A-Za-z.]+)/i,
    /\buse\s+([A-Za-z.]+)\s+instead of\s+([A-Za-z.]+)/i,
    /\b(?:change|switch|move|migrate|port)\b[^.\n]{0,40}?\bto\s+([A-Za-z.]+)/i,
    /\btarget\b[^.\n]{0,20}?\bis now\s+([A-Za-z.]+)/i,
  ]
  for (let i = 0; i < patterns.length; i++) {
    const hit = patterns[i].exec(m)
    if (!hit) continue
    if (i === 0) {
      const from = alias(hit[1]); const to = alias(hit[2])
      if (from && to && from !== to) return { from, to }
      continue
    }
    if (i === 1 || i === 2) {
      const to = alias(hit[1]); const from = alias(hit[2])
      if (from && to && from !== to) return { from, to }
      continue
    }
    const to = alias(hit[1])
    if (to) return { from: null, to }
  }
  return null
}

/**
 * Split one recorded requirement into clause-sized items.
 *
 * A user states a goal in one breath — "Create a paper-trading Android app
 * with Jetpack Compose, Room, Hilt and WorkManager." Compared whole, that
 * sentence carries both the product and the stack, so a platform change either
 * invalidates the product too or preserves the dead stack. Neither is true.
 *
 * Splitting on "with", "using" and list separators lets the product clause be
 * preserved while the stack clauses are invalidated, which is the answer the
 * user actually means. A clause carrying no stack token keeps its full text so
 * nothing is lost from what is reported back.
 */
export function clausesOf(item) {
  const text = String(item?.text ?? "")
  if (!text.trim()) return []
  // only worth splitting when the sentence mixes stack tokens with other content
  const hits = stackTokensIn(text)
  if (!hits.length) return [item]
  const head = text.split(/\s+\b(?:with|using|built with|based on)\b\s+/i)[0].trim()
  const tailRaw = text.slice(head.length)
  const parts = tailRaw
    .replace(/^\s*\b(?:with|using|built with|based on)\b\s*/i, "")
    .split(/\s*,\s*|\s+\band\b\s+/i)
    .map((p) => p.replace(/[.;]+$/, "").trim())
    .filter(Boolean)
  if (!parts.length) return [item]
  const out = []
  if (head && stackTokensIn(head).length === 0) out.push({ id: `${item.id}#0`, text: head })
  else if (head) out.push({ id: `${item.id}#0`, text: head })
  parts.forEach((p, i) => out.push({ id: `${item.id}#${i + 1}`, text: p }))
  return out
}

/** Split a message into requirement-sized sentences, dropping empty noise. */
export function sentences(text = "") {
  return String(text ?? "")
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2)
}

/** Does this sentence ask for something to be dropped? */
function isRemoval(s) {
  return /\b(drop|remove|delete|no longer|stop|without|forget|scrap|cut)\b/i.test(s) &&
    !/\bdon'?t (?:drop|remove|delete)\b/i.test(s)
}

/** Does this sentence explicitly protect existing requirements? */
export function saysKeepEverythingElse(message = "") {
  return /\b(keep|retain|preserve|same)\b[^.\n]{0,30}\b(the same|requirements?|rest|everything|unchanged|as (?:before|is))\b/i.test(String(message ?? "")) ||
    /\beverything else (?:stays|remains|is) (?:the same|unchanged)\b/i.test(String(message ?? ""))
}

/**
 * The delta.
 *
 * @param previous  the requirements already on record — strings, or objects
 *                  with a `text` field (plan nodes work too: {id, text})
 * @param message   the user's new message
 * @param nodes     plan/DAG nodes to classify as affected or not: [{id, text}]
 *
 * @returns {{
 *   platformChange, preserved, changed, added, removed, invalidated,
 *   affectedNodes, unaffectedNodes, implications, keepEverythingElse, summary
 * }}
 */
export function requirementDelta({ previous = [], message = "", nodes = [] } = {}) {
  // dag.js nodes carry their text as `objective` (dag.js:95) — accepted here so
  // a caller can hand this function a DAG's nodes directly, with no adapter.
  const asItem = (x, i) => (typeof x === "string"
    ? { id: `r${i}`, text: x }
    : { id: String(x?.id ?? `r${i}`), text: String(x?.text ?? x?.objective ?? x?.title ?? x?.description ?? "") })
  const prior = (Array.isArray(previous) ? previous : []).flatMap((x, i) => clausesOf(asItem(x, i)))
  const planNodes = (Array.isArray(nodes) ? nodes : []).map(asItem)

  const platformChange = detectPlatformChange(message)
  const keepEverythingElse = saysKeepEverythingElse(message)

  const preserved = []
  const invalidated = []
  const changed = []

  // The only thing that invalidates prior requirements here is a platform
  // change, and then only the ones that actually name the OLD stack. Everything
  // else is preserved — silence never invalidates.
  const deadPlatforms = platformChange
    ? (platformChange.from ? [platformChange.from] : Object.keys(STACK).filter((p) => p !== platformChange.to && PLATFORM_ALIASES[p]))
    : []

  for (const item of prior) {
    const hits = platformChange ? stackTokensIn(item.text).filter((h) => deadPlatforms.includes(h.platform)) : []
    if (!hits.length) { preserved.push(item); continue }
    // A clause that is ESSENTIALLY the technology ("Jetpack Compose", "Room")
    // dies with the platform. A clause that carries real product content and
    // merely names the old platform ("Create a paper-trading Android app") is
    // RETARGETED, not thrown away — the app still has to exist. Discarding it
    // would make a platform change look like a cancelled project.
    let residue = norm(item.text)
    for (const h of hits) residue = residue.split(norm(h.token)).join(" ")
    const substantive = residue.split(/[^a-z0-9]+/i).filter((w) => w.length > 2 && !STOPWORDS.has(w))
    const reason = `mentions ${hits.map((h) => h.token).join(", ")}, which belong${hits.length === 1 ? "s" : ""} to ${hits[0].platform} — the target moved to ${platformChange.to}`
    if (substantive.length >= 2) {
      changed.push({ ...item, kind: DELTA.CHANGED, from: platformChange.from, to: platformChange.to, tokens: hits.map((h) => h.token),
        reason: `${reason}; the requirement itself still stands and is retargeted to ${platformChange.to}` })
    } else {
      invalidated.push({ ...item, reason, tokens: hits.map((h) => h.token) })
    }
  }

  // What the message itself asks for.
  const added = []
  const removed = []
  for (const s of sentences(message)) {
    // The sentence that ANNOUNCES the retarget is the cause, not a retargeted
    // requirement — it is already reported as `platformChange`. Putting it in
    // `changed` alongside the requirements it acts on conflates the two.
    if (platformChange && new RegExp(`\\b${platformChange.to}\\b`, "i").test(s) && /\b(change|switch|move|migrate|port|target|instead)\b/i.test(s)) continue
    if (isRemoval(s)) { removed.push({ text: s }); continue }
    // a sentence that merely protects what exists is not a new requirement
    if (saysKeepEverythingElse(s)) continue
    added.push({ text: s })
  }

  // Consequences to plan for — inferences, kept apart from everything observed.
  const implications = []
  for (const rule of IMPLICATIONS) {
    if (rule.when.test(message)) for (const topic of rule.topics) if (!implications.includes(topic)) implications.push(topic)
  }

  // Plan nodes: affected when they rest on the stack that just died, or when
  // they name a topic the new requirement touches.
  const affectedNodes = []
  const unaffectedNodes = []
  for (const n of planNodes) {
    const stackHits = platformChange ? stackTokensIn(n.text).filter((h) => deadPlatforms.includes(h.platform)) : []
    const topicHit = implications.find((t) => norm(n.text).includes(norm(t.split(" ")[0])))
    if (stackHits.length) affectedNodes.push({ ...n, reason: `built on ${stackHits.map((h) => h.token).join(", ")}`, kind: DELTA.INVALIDATED })
    else if (topicHit) affectedNodes.push({ ...n, reason: `touches "${topicHit}", which the new requirement changes`, kind: DELTA.CHANGED })
    else unaffectedNodes.push(n)
  }

  const summary = platformChange
    ? `target ${platformChange.from ? `${platformChange.from} → ` : "→ "}${platformChange.to}: ${preserved.length} requirement(s) preserved, ${invalidated.length} invalidated, ${affectedNodes.length} plan node(s) affected`
    : `${added.length} added, ${removed.length} removed, ${preserved.length} preserved, ${affectedNodes.length} plan node(s) affected`

  return {
    platformChange, keepEverythingElse,
    preserved, changed, added, removed, invalidated,
    affectedNodes, unaffectedNodes,
    implications,
    summary,
  }
}

/** One line for a prompt or a log. Empty when nothing changed. */
export function formatDelta(d) {
  if (!d) return ""
  const bits = []
  if (d.platformChange) bits.push(`[requirements] target ${d.platformChange.from ?? "?"} → ${d.platformChange.to}`)
  if (d.invalidated.length) bits.push(`INVALIDATED: ${d.invalidated.map((i) => i.text.slice(0, 40)).join("; ")}`)
  if (d.changed.length) bits.push(`RETARGETED: ${d.changed.map((i) => i.text.slice(0, 40)).join("; ")}`)
  if (d.preserved.length) bits.push(`PRESERVED (${d.preserved.length}): ${d.preserved.slice(0, 4).map((i) => i.text.slice(0, 30)).join("; ")}`)
  if (d.added.length) bits.push(`ADDED: ${d.added.map((i) => i.text.slice(0, 40)).join("; ")}`)
  if (d.removed.length) bits.push(`REMOVED: ${d.removed.map((i) => i.text.slice(0, 40)).join("; ")}`)
  if (d.implications.length) bits.push(`implies (inferred, not observed): ${d.implications.join(", ")}`)
  return bits.length ? bits.join(" · ") : ""
}
