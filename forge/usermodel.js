/**
 * forge — user understanding (v100 cognitionwise, zero dependencies)
 *
 * The missing subsystem. Forge parsed what the user typed. It did not model
 * the user. This module is the ONE user model: explicit vs inferred, competing
 * intent hypotheses, preferences with provenance and decay, structured
 * feedback, negative knowledge, decision authority.
 *
 * NEVER silently convert INFERENCE → FACT.
 * NEVER let a stale preference override a current explicit instruction.
 * NEVER replace the user's goal without asking.
 *
 * Roles (Explorer/Planner/Coder/…) are perspectives of the same core.
 * This is not a second brain.
 */
export const BELIEF = {
  EXPLICIT: "EXPLICIT",
  CONFIRMED: "CONFIRMED",
  INFERRED: "INFERRED",
  PROBABLE: "PROBABLE",
  ASSUMED: "ASSUMED",
  UNKNOWN: "UNKNOWN",
  CONTRADICTED: "CONTRADICTED",
  STALE: "STALE",
  REJECTED: "REJECTED",
}

export const FEEDBACK_KIND = {
  TASK_FEEDBACK: "TASK_FEEDBACK",
  QUALITY_FEEDBACK: "QUALITY_FEEDBACK",
  PREFERENCE_FEEDBACK: "PREFERENCE_FEEDBACK",
  STRATEGY_FEEDBACK: "STRATEGY_FEEDBACK",
  COMMUNICATION_FEEDBACK: "COMMUNICATION_FEEDBACK",
  CORRECTION: "CORRECTION",
  REJECTION: "REJECTION",
  APPROVAL: "APPROVAL",
}

export const AUTHORITY = {
  SAFE_AUTONOMOUS: "SAFE_AUTONOMOUS",
  REVERSIBLE_AUTONOMOUS: "REVERSIBLE_AUTONOMOUS",
  LOW_IMPACT_INFERABLE: "LOW_IMPACT_INFERABLE",
  HIGH_IMPACT_CONFIRM: "HIGH_IMPACT_CONFIRM",
  IRREVERSIBLE_CONFIRM: "IRREVERSIBLE_CONFIRM",
  USER_ONLY: "USER_ONLY",
}

export const PREFERENCE_SCOPE = {
  GLOBAL: "GLOBAL_USER_PREFERENCE",
  PROJECT: "PROJECT_PREFERENCE",
  TASK: "TASK_PREFERENCE",
  TEMPORARY: "TEMPORARY_PREFERENCE",
  OVERRIDE: "EXPLICIT_OVERRIDE",
  INFERRED: "INFERRED_PREFERENCE",
}

const STALE_MS = 14 * 24 * 60 * 60 * 1000

const AMBIGUOUS = [
  /\bmake (it|this|forge|the (app|code|system)) (smarter|better|faster|nicer|cleaner)\b/i,
  /\bimprove\b/i,
  /\bfix (it|this|that)\b/i,
  /\bdo the (right|needful) thing\b/i,
  /\bhandle this\b/i,
  /\brefactor\b(?! .+ to )/i,
]

const IRREVERSIBLE = [
  /\bdelete\b/i, /\bdrop (table|database|db)\b/i, /\bpush --force\b/i,
  /\bforce.?push\b/i, /\bproduction\b/i, /\bmigrate\b/i, /\brewrite\b/i,
]

const PREFERENCE_CUES = [
  { re: /\bdon'?t (rewrite|refactor|touch)\b/i, key: "no-rewrite", value: "prefer minimal patch" },
  { re: /\bno tests\b/i, key: "skip-tests", value: "user asked to skip tests (do not treat as verified)" },
  { re: /\bkeep it simple\b/i, key: "simplicity", value: "prefer the smallest change" },
  { re: /\btypescript\b/i, key: "language", value: "typescript" },
]

function clamp01(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 0
  return Math.max(0, Math.min(1, x))
}

function belief(value, klass, extra = {}) {
  return {
    value: String(value ?? "").slice(0, 500),
    class: BELIEF[klass] || BELIEF.ASSUMED,
    confidence: clamp01(extra.confidence ?? (klass === BELIEF.EXPLICIT ? 1 : 0.45)),
    source: extra.source ?? "user",
    at: extra.at ?? Date.now(),
    lastConfirmedAt: extra.lastConfirmedAt ?? (klass === BELIEF.EXPLICIT ? Date.now() : null),
    provenance: extra.provenance ?? "utterance",
  }
}

/**
 * Competing interpretations of an ambiguous request.
 * Do not collapse until evidence is sufficient.
 */
export function intentHypothesesFor(text) {
  const t = String(text ?? "").trim()
  if (!t) return []
  const lower = t.toLowerCase()
  const out = []
  const add = (meaning, goal, confidence, discriminating) => {
    out.push({
      id: `IH${out.length + 1}`,
      meaning, goal,
      supportingEvidence: [],
      contradictingEvidence: [],
      assumptions: [],
      confidence: clamp01(confidence),
      predictions: [],
      discriminatingEvidence: discriminating,
      whatWouldChangeMyMind: discriminating,
      status: "OPEN",
    })
  }
  if (/\bsmart(er)?\b/.test(lower) || /\bintelligen/.test(lower)) {
    add("better reasoning under uncertainty", "improve decision quality", 0.28, "user names reasoning/governor/hypotheses")
    add("better autonomy (less asking, more doing)", "raise autonomy without dropping verification", 0.22, "user says 'just do it' / 'stop asking'")
    add("better user understanding", "model the user, not only the repo", 0.18, "user talks about intent/preferences")
    add("better tool/model routing", "cheapest capable capability first", 0.16, "user mentions models, cost, tools")
    add("better learning from outcomes", "calibrate on prediction error", 0.16, "user mentions memory/lessons/self-improve")
  } else if (/\bfix (it|this|that|the bug)\b/.test(lower) || lower === "fix it") {
    add("repair the currently failing test/runtime", "make the failing check pass", 0.4, "a failing test or stack trace exists")
    add("repair a user-visible defect", "restore expected behavior", 0.3, "user names a symptom")
    add("the stated problem is not the real problem", "find the root mechanism before patching", 0.3, "inspect shows a different cause")
  } else if (/\bimprove\b|\bbetter\b|\bclean(er)?\b/.test(lower)) {
    add("quality of the existing behavior", "raise quality without changing the contract", 0.35, "user names a quality axis")
    add("performance", "reduce latency/cost of the hot path", 0.25, "user names speed/tokens")
    add("architecture", "reshape structure — high blast radius", 0.2, "user names modules/rewrite")
    add("developer experience", "simpler to change next time", 0.2, "user names DX/readability")
  }
  return out
}

export function classifyFeedback(text) {
  const t = String(text ?? "").trim().toLowerCase()
  if (!t) return null
  if (/^(yes|y|ok|okay|lgtm|ship it|this is good|approved)\b/.test(t)) return FEEDBACK_KIND.APPROVAL
  if (/^(no|nope|stop|don't|dont|wrong|that's wrong|not that)\b/.test(t)) return FEEDBACK_KIND.REJECTION
  if (/\bdon'?t do that again\b|\bnever .+ again\b/.test(t)) return FEEDBACK_KIND.REJECTION
  if (/\bmake it simpler\b|\btoo (complex|much)\b/.test(t)) return FEEDBACK_KIND.QUALITY_FEEDBACK
  if (/\buse (another|a different) (approach|strategy|model)\b/.test(t)) return FEEDBACK_KIND.STRATEGY_FEEDBACK
  if (/\bprefer\b|\balways\b|\bnever\b/.test(t)) return FEEDBACK_KIND.PREFERENCE_FEEDBACK
  if (/\bwrong\b|\bincorrect\b|\bnot what i\b/.test(t)) return FEEDBACK_KIND.CORRECTION
  return FEEDBACK_KIND.TASK_FEEDBACK
}

// v129: was authorityFor — governor.js exports that name for the GOVERNOR's
// action authority, which is a different question. This one is about how much
// autonomy the USER's request grants.
export function userAuthorityFor({ irreversible = false, highImpact = false, ambiguous = false, reversible = true } = {}) {
  if (irreversible) return AUTHORITY.IRREVERSIBLE_CONFIRM
  if (highImpact && ambiguous) return AUTHORITY.HIGH_IMPACT_CONFIRM
  if (highImpact) return AUTHORITY.HIGH_IMPACT_CONFIRM
  if (reversible) return AUTHORITY.REVERSIBLE_AUTONOMOUS
  return AUTHORITY.LOW_IMPACT_INFERABLE
}

export function createUserModel() {
  const preferences = new Map()
  const feedback = []
  const rejected = []
  let understanding = null

  function getPref(key) {
    const p = preferences.get(key)
    if (!p) return null
    if (p.class === BELIEF.EXPLICIT || p.class === BELIEF.CONFIRMED || p.class === BELIEF.OVERRIDE) return p
    if (p.at && Date.now() - p.at > STALE_MS) {
      p.class = BELIEF.STALE
      p.freshness = "stale"
    }
    return p
  }

  function setPref({ key, value, scope = PREFERENCE_SCOPE.TASK, klass = BELIEF.INFERRED, source = "user" } = {}) {
    const k = String(key || "").slice(0, 80)
    if (!k) return null
    const existing = preferences.get(k)
    // current explicit always beats historical inference
    if (existing && existing.class === BELIEF.EXPLICIT && klass !== BELIEF.EXPLICIT && klass !== BELIEF.OVERRIDE) {
      return existing
    }
    const rec = {
      key: k,
      value: String(value ?? "").slice(0, 240),
      scope,
      class: BELIEF[klass] || klass,
      source,
      createdAt: existing?.createdAt ?? Date.now(),
      lastConfirmedAt: klass === BELIEF.EXPLICIT ? Date.now() : (existing?.lastConfirmedAt ?? null),
      lastUsedAt: Date.now(),
      confidence: klass === BELIEF.EXPLICIT ? 1 : 0.5,
      freshness: "fresh",
      contradictions: existing && existing.value !== value ? [existing.value] : [],
    }
    preferences.set(k, rec)
    return rec
  }

  function understand(text, { source = "user" } = {}) {
    const raw = String(text ?? "").trim()
    const ambiguous = AMBIGUOUS.some((re) => re.test(raw)) || raw.split(/\s+/).length < 4
    const irreversible = IRREVERSIBLE.some((re) => re.test(raw))
    const intentHypos = intentHypothesesFor(raw)
    const prefs = []
    for (const cue of PREFERENCE_CUES) {
      if (cue.re.test(raw)) prefs.push(setPref({ key: cue.key, value: cue.value, scope: PREFERENCE_SCOPE.TASK, klass: BELIEF.EXPLICIT, source }))
    }
    const explicitIntent = belief(raw, BELIEF.EXPLICIT, { source, provenance: "current utterance" })
    const inferredIntent = intentHypos[0]
      ? belief(intentHypos[0].goal, BELIEF.INFERRED, { source: "intent-hypotheses", confidence: intentHypos[0].confidence })
      : belief("", BELIEF.UNKNOWN, { source: "none" })
    const highImpact = irreversible || /\barchitect|redesign|rewrite|migrat|production\b/i.test(raw) || /\bmake forge\b|\bforge itself\b/i.test(raw)
    understanding = {
      explicitIntent,
      inferredIntent,
      intentHypotheses: intentHypos,
      goal: explicitIntent.value,
      underlyingGoal: inferredIntent.value || explicitIntent.value,
      desiredOutcome: explicitIntent.value,
      desiredFutureState: null,
      successCriteria: [],
      requirements: [],
      constraints: prefs.filter(Boolean).map((p) => p.value),
      priorities: [],
      preferences: [...preferences.values()],
      expectations: [],
      assumptions: intentHypos.slice(1).map((h) => h.meaning),
      ambiguities: ambiguous ? ["request is underspecified"] : [],
      unknowns: ambiguous ? ["which interpretation the user means"] : [],
      decisionAuthority: userAuthorityFor({ irreversible, highImpact, ambiguous, reversible: !irreversible }),
      riskTolerance: null,
      urgency: /\basap|urgent|now|today\b/i.test(raw) ? "high" : "normal",
      qualityExpectations: prefs.find((p) => p?.key === "simplicity") ? "simple" : null,
      costSensitivity: null,
      complexityTolerance: null,
      reversibilityPreference: irreversible ? "confirm" : "prefer-reversible",
      communicationPreferences: [],
      rejectedApproaches: rejected.slice(),
      acceptedApproaches: [],
      feedback: feedback.slice(),
      confidence: ambiguous ? 0.35 : (intentHypos.length > 1 ? 0.55 : 0.85),
      provenance: source,
      freshness: "fresh",
      originalText: raw,
      at: Date.now(),
    }
    return understanding
  }

  function recordFeedback(text, { kind = null } = {}) {
    const k = kind || classifyFeedback(text) || FEEDBACK_KIND.TASK_FEEDBACK
    const rec = { kind: k, text: String(text ?? "").slice(0, 400), at: Date.now() }
    feedback.push(rec)
    if (k === FEEDBACK_KIND.REJECTION) {
      rejectStrategy({ strategy: String(text ?? "").slice(0, 200), reason: "user rejection", result: "rejected" })
    }
    if (understanding) understanding.feedback = feedback.slice()
    return rec
  }

  function rejectStrategy({ strategy, reason, result = "failed", scope = "task", confidence = 0.8 } = {}) {
    const rec = {
      strategy: String(strategy ?? "").slice(0, 240),
      context: understanding?.originalText?.slice(0, 200) ?? "",
      reason: String(reason ?? "").slice(0, 240),
      result: String(result ?? "").slice(0, 80),
      scope,
      confidence: clamp01(confidence),
      at: Date.now(),
    }
    rejected.push(rec)
    if (understanding) understanding.rejectedApproaches = rejected.slice()
    return rec
  }

  function questionValue({ impact = 0.5, uncertainty = 0.5, gain = 0.5, attentionCost = 0.5 } = {}) {
    const cost = Math.max(0.05, Number(attentionCost) || 0.5)
    return (Number(impact) * Number(uncertainty) * Number(gain)) / cost
  }

  function shouldAsk({ impact = 0.5, uncertainty = 0.5, discoverable = false, reversible = true, irreversible = false } = {}) {
    if (discoverable) return false
    if (irreversible && uncertainty > 0.3) return true
    if (!reversible && uncertainty > 0.45 && impact > 0.5) return true
    return questionValue({ impact, uncertainty, gain: 0.7, attentionCost: 0.6 }) >= 0.55
  }

  function snapshot() {
    return {
      understanding,
      preferences: [...preferences.values()],
      feedback: feedback.slice(),
      rejected: rejected.slice(),
    }
  }

  function formatForPrompt() {
    if (!understanding) return ""
    const u = understanding
    const lines = ["USER MODEL (explicit beats inferred; never promote a guess to a requirement):"]
    lines.push(`- explicit intent (EXPLICIT, frozen): ${u.explicitIntent.value}`)
    if (u.inferredIntent?.value && u.inferredIntent.value !== u.explicitIntent.value) {
      lines.push(`- inferred intent (${u.inferredIntent.class}, confidence ${u.inferredIntent.confidence}): ${u.inferredIntent.value}`)
    }
    if (u.intentHypotheses?.length > 1) {
      lines.push("- competing intent hypotheses (do not collapse yet):")
      for (const h of u.intentHypotheses.slice(0, 6)) {
        lines.push(`  ${h.id} (${h.confidence.toFixed(2)}) ${h.meaning} — disprove by: ${h.whatWouldChangeMyMind}`)
      }
    }
    if (u.ambiguities?.length) lines.push(`- ambiguities: ${u.ambiguities.join("; ")}`)
    if (u.unknowns?.length) lines.push(`- unknowns: ${u.unknowns.join("; ")}`)
    if (rejected.length) lines.push(`- rejected approaches: ${rejected.map((r) => r.strategy).slice(0, 4).join("; ")}`)
    lines.push(`- decision authority: ${u.decisionAuthority}`)
    lines.push("- current explicit instruction outranks any historical preference")
    return lines.join("\n")
  }

  return {
    understand, recordFeedback, rejectStrategy, setPref, getPref,
    shouldAsk, questionValue, snapshot, formatForPrompt,
    get understanding() { return understanding },
    BELIEF, FEEDBACK_KIND, AUTHORITY, PREFERENCE_SCOPE,
  }
}
