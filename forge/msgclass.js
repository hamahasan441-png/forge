/**
 * forge — user-message classification (v97 "unifiedwise", ∞ §7, zero dependencies)
 *
 * "The user must not need to repeat previous engineering decisions."
 *
 * Deterministic classification of meaningful USER messages into engineering
 * memory categories. This is NOT a model call — it is a lexical/structural
 * classifier with honest precedence, so every important user turn becomes a
 * first-class record (goal / requirement / constraint / preference / …) the
 * session rehydration and engmemory layers can replay.
 *
 * Rules of honesty:
 *   - a message may carry several classes; each hit carries its evidence line
 *   - classification is advisory metadata, never a gate — chat never blocks
 *   - the classifier never invents content: every class cites the matched text
 */
export const MSG_CLASSES = [
  "goal", "requirement", "constraint", "preference", "correction",
  "decision", "approval", "rejection", "priority", "scope_change",
  "clarification", "stop", "continue",
]

const RULES = [
  {
    cls: "stop",
    re: /\b(stop|halt|abort|cancel (?:this|the|it)|don'?t (?:do|run) (?:this|that|it)|leave it(?: alone)?|enough)\b/i,
  },
  {
    cls: "continue",
    re: /\b(go on|carry on|continue|keep going|proceed|next step|do it)\b/i,
  },
  {
    cls: "approval",
    re: /\b^(?:yes|y|ok|okay|approve[d]?|confirmed?|looks good|lgtm|ship it|go ahead|proceed)\b/i,
  },
  {
    cls: "rejection",
    re: /\b(no|reject(?:ed)?|declined|veto|don'?t (?:want|use|do)|not (?:this|that)|revert (?:this|that|it)|wrong approach|try something else)\b/i,
  },
  {
    cls: "correction",
    re: /\b(?:that'?s (?:wrong|incorrect|not right)|actually[ ,]|correction[:]|not like that|I (?:meant|said)|you (?:misunderstood|got it wrong)|instead of that|fix (?:that|the approach))\b/i,
  },
  {
    cls: "goal",
    // v103: a BARE IMPERATIVE is how most people state a goal — "Create a
    // paper-trading Android app.", "Build a REST API for the project." Before
    // this the rule needed a polite prefix ("please build", "I want you to"),
    // so the single most consequential turn in a conversation classified as
    // nothing at all and never reached engineering memory.
    // Anchored to the start so "you could build X" mid-sentence is not a goal.
    re: /\b(?:the (?:goal|objective|aim) (?:is|should be)|I (?:want|need) (?:you )?to|please (?:implement|build|create|fix|refactor|add|remove|write|make)|our goal|target is)\b|^(?:build|create|implement|write|make|design|develop|set up|scaffold)\s+(?:me\s+)?(?:a|an|the|some)?\s*\S/i,
  },
  {
    cls: "requirement",
    re: /\b(?:must|shall|has to|needs to|required(?: to)?|it is mandatory|always|never)\b/i,
  },
  {
    cls: "constraint",
    re: /\b(?:do not|don'?t|cannot|can'?t|no (?:more than|fewer than)|at most|at least|only|within \d+|budget|deadline|limit(?:ed)? to|keep (?:it|this) (?:under|within)|without (?:changing|breaking|touching))\b/i,
  },
  {
    cls: "preference",
    re: /\b(?:I (?:prefer|like|always|usually)|prefer(?:ably)?|from now on|remember that|note that|my (?:style|convention|workflow)|we (?:always|usually) (?:use|write|name))\b/i,
  },
  {
    cls: "decision",
    re: /\b(?:let'?s (?:go with|use|do|take)|we(?:'ll| will) (?:use|go with|take)|decision[:]|chose|chosen|settled on|option \d|final (?:answer|choice)|go with)\b/i,
  },
  {
    cls: "priority",
    re: /\b(?:first|before (?:anything|that)|more important|top priority|prioriti[sz]e|focus on|do X first|most critical|urgent)\b/i,
  },
  {
    cls: "scope_change",
    // v103: a retarget and a removal are both scope changes and neither
    // matched. "Change the target from Android to Flutter" and "Drop the dark
    // theme requirement" classified as nothing, so the turn that invalidates
    // half a plan was invisible to every downstream consumer.
    re: /\b(?:also|additionally|instead[ ,]|new requirement|change of plans|scratch that|expand (?:the )?scope|also (?:add|do|handle)|one more thing|on top of that)\b|\b(?:change|switch|move|migrate|port)\b[^.\n]{0,40}?\b(?:to|from)\s+\S+|\buse\s+\S+\s+instead of\b|\b(?:drop|remove|delete|scrap|cut)\b[^.\n]{0,30}\b(?:requirement|feature|support|screen|endpoint|module|part)\b|\bno longer (?:need|needs|required|necessary)\b/i,
  },
  {
    cls: "clarification",
    re: /\b(?:what (?:about|do you mean|exactly)|why (?:do|did|not)|clarif|to be clear|I mean|does that mean|can you explain)\b/i,
  },
]

/** Classify one user message. Returns { classes: [{cls, evidence}], primary }
 *  — empty classes when nothing matches (most turns are plain chat; that is
 *  honest, not a failure). */
export function classifyUserMessage(text) {
  const t = String(text ?? "").trim()
  if (!t) return { classes: [], primary: null }
  if (t.startsWith("AUTO-COMPACTED") || t.startsWith("[agent task]")) return { classes: [], primary: null }
  const hits = []
  for (const r of RULES) {
    const m = r.re.exec(t)
    if (m) hits.push({ cls: r.cls, evidence: m[0].slice(0, 80) })
  }
  // precedence for the "primary" label: control > correction > rejection >
  // goal > preference (an explicit "from now on" beats a generic "always") >
  // requirement > constraint > decision > the rest
  const order = ["stop", "continue", "approval", "correction", "rejection", "goal", "preference", "requirement", "constraint", "decision", "priority", "scope_change", "clarification"]
  let primary = null
  for (const o of order) { const h = hits.find((x) => x.cls === o); if (h) { primary = o; break } }
  return { classes: hits.slice(0, 6), primary }
}

/** Which classes are worth persisting into engineering memory (the "important"
 *  subset of §7 — everything else stays in the raw transcript only). */
export function isEngineeringRelevant(classification) {
  const important = new Set(["goal", "requirement", "constraint", "preference", "correction", "decision", "approval", "rejection", "priority", "scope_change", "stop"])
  return (classification?.classes ?? []).some((c) => important.has(c.cls))
}

/** One-line rendering for banners/summaries. */
export function formatClassification(c) {
  const names = (c?.classes ?? []).map((x) => x.cls)
  if (!names.length) return ""
  return names.slice(0, 4).join(", ") + (names.length > 4 ? ` +${names.length - 4}` : "")
}
