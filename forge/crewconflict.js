/**
 * forge — evidence-based agent conflict resolution (v91 ∞ CORE §31)
 *
 * When two workers disagree, the procedure is fixed:
 *
 *   1. preserve both findings          — nothing is discarded
 *   2. compare evidence                — kind + freshness + confidence
 *   3. inspect the World Model         — does the repo agree with either side?
 *   4. run a discriminating experiment — when evidence is tied
 *   5. rank hypotheses                 — by support, not by volume
 *   6. choose the evidence-supported result
 *   7. record the decision             — architecture decision log
 *   8. preserve the rejected reasoning — it stays readable, never deleted
 *
 * NEVER resolved by majority vote. Evidence wins. A single VERIFIED record
 * outranks any number of unverified claims; an INFERRED claim only wins when
 * nothing better exists and the world model does not contradict it.
 */

import { KIND } from "./evidence.js"

export const CONFLICT_STATUS = {
  OPEN: "OPEN",
  RESOLVED: "RESOLVED",
  ESCALATED: "ESCALATED", // no discriminating evidence — an experiment must run
}

/** Evidence-kind strength: the ladder is the law (§19). */
const KIND_STRENGTH = {
  [KIND.PROOF]: 6,
  [KIND.VERIFIED]: 5.5,
  [KIND.VERIFICATION]: 5,
  [KIND.FACT]: 5,
  [KIND.OBSERVATION]: 3,
  [KIND.FINDING]: 3,
  [KIND.ANALYSIS]: 2,
  [KIND.INFERENCE]: 1.5,
  [KIND.HYPOTHESIS]: 0.5,
  [KIND.UNKNOWN]: 0,
  [KIND.STALE]: 0,
}

let seq = 0
export function conflictId() { return `cf-${Date.now().toString(36)}-${++seq}` }

/**
 * Report a disagreement between two workers. Both positions are preserved
 * verbatim with their evidence.
 *
 * @param {object} a { claimant, claim, evidence: [evidence records/strings], confidence }
 * @param {object} b same shape
 * @param {object} opts { topic, taskId, nodeId }
 */
export function reportConflict(a = {}, b = {}, { topic = null, taskId = null, nodeId = null } = {}) {
  return {
    conflict_id: conflictId(),
    status: CONFLICT_STATUS.OPEN,
    topic: String(topic ?? "").slice(0, 300),
    task_id: taskId != null ? String(taskId).slice(0, 120) : null,
    node_id: nodeId != null ? String(nodeId).slice(0, 120) : null,
    created_at: Date.now(),
    a: normalizePosition(a),
    b: normalizePosition(b),
    resolution: null,
    history: [],
  }
}

function normalizePosition(p = {}) {
  return {
    claimant: String(p.claimant ?? "worker").slice(0, 80),
    claim: String(p.claim ?? "").slice(0, 1000),
    evidence: (Array.isArray(p.evidence) ? p.evidence : [p.evidence]).filter(Boolean).slice(0, 12),
    confidence: clamp01(p.confidence ?? 0.5),
  }
}

/** Score one position: evidence strength dominates, self-confidence barely counts. */
export function scorePosition(pos, { worldAgreement = null, writes = {} } = {}) {
  let best = 0
  let freshBest = 0
  for (const ev of pos.evidence ?? []) {
    const kind = typeof ev === "string" ? guessKind(ev) : ev?.kind
    const strength = KIND_STRENGTH[kind] ?? 0
    const asOf = Number(ev?.asOf ?? Date.now())
    const stale = typeof ev === "object" && ev ? isEvidenceStale(ev, writes) : false
    const s = stale ? 0 : strength * (typeof ev === "object" && ev?.confidence != null ? clamp01(ev.confidence) : 1)
    best = Math.max(best, s)
    if (!stale && s > 0) freshBest = Math.max(freshBest, s)
  }
  // world-model agreement is a tiebreaker worth one strong observation
  const world = worldAgreement == null ? 0 : worldAgreement ? 3 : -2
  return {
    score: Math.round((freshBest + 0.1 * best + world + 0.5 * clamp01(pos.confidence)) * 100) / 100,
    bestEvidence: freshBest,
    world,
  }
}

function guessKind(text) {
  const t = String(text)
  if (/verified|tests? (ran|passed)|exit code 0/i.test(t)) return KIND.VERIFICATION
  if (/observed|saw|output:/i.test(t)) return KIND.OBSERVATION
  if (/found|located|discovered/i.test(t)) return KIND.FINDING
  return KIND.HYPOTHESIS
}

function isEvidenceStale(ev, writes) {
  const files = ev?.files ?? []
  const asOf = Number(ev?.asOf ?? 0)
  for (const f of files) {
    const w = writes[f]
    if (w != null && Number(w) > asOf) return true
  }
  return false
}

/**
 * Resolve a conflict (steps 2-8). `options.world` is a function
 * (claim) => true|false|null consulting the World Model; `options.experiment`
 * is a suggested discriminating experiment description when evidence ties.
 * Returns the conflict record with `resolution` filled.
 */
export function resolveConflict(conflict, { world = null, writes = {}, note = null } = {}) {
  if (!conflict || conflict.status !== CONFLICT_STATUS.OPEN) return conflict
  const sa = scorePosition(conflict.a, { worldAgreement: world ? world(conflict.a.claim) : null, writes })
  const sb = scorePosition(conflict.b, { worldAgreement: world ? world(conflict.b.claim) : null, writes })

  conflict.history.push({ at: Date.now(), step: "compared evidence", sa: sa.score, sb: sb.score })

  let winner = null
  if (sa.score !== sb.score) winner = sa.score > sb.score ? "a" : "b"

  if (!winner && world) {
    // step 3: let the world model discriminate
    conflict.history.push({ at: Date.now(), step: "consulted world model" })
    const wa = world(conflict.a.claim)
    const wb = world(conflict.b.claim)
    if (wa === true && wb !== true) winner = "a"
    else if (wb === true && wa !== true) winner = "b"
  }

  if (!winner) {
    // steps 4-5: no discriminating evidence — rank hypotheses and escalate to
    // an experiment rather than guessing (never resolve by vote or volume).
    conflict.status = CONFLICT_STATUS.ESCALATED
    conflict.resolution = {
      winner: null,
      reason: "no discriminating evidence — a discriminating experiment is required before either claim may be acted on",
      suggestedExperiment: discriminatingExperiment(conflict),
      rejected: null,
      note: note ?? null,
    }
    conflict.history.push({ at: Date.now(), step: "escalated to experiment" })
    return conflict
  }

  const w = winner === "a" ? conflict.a : conflict.b
  const l = winner === "a" ? conflict.b : conflict.a
  conflict.status = CONFLICT_STATUS.RESOLVED
  conflict.resolution = {
    winner: w.claimant,
    winningClaim: w.claim,
    reason: `evidence-supported: ${describeEvidence(w)}${sa.score !== sb.score ? ` (score ${winner === "a" ? sa.score : sb.score} vs ${winner === "a" ? sb.score : sa.score})` : " (world model agreed)"}`,
    rejected: {
      claimant: l.claimant,
      claim: l.claim,
      preservedReasoning: l.evidence?.length ? l.evidence.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).slice(0, 6) : [],
    },
    note: note ?? null,
  }
  conflict.history.push({ at: Date.now(), step: "resolved", winner: w.claimant })
  return conflict
}

/** Step 4 helper — the experiment that would discriminate a vs b. */
export function discriminatingExperiment(conflict) {
  const topic = conflict.topic || "the disputed claim"
  return `run the smallest check that can only succeed for one side of: ${topic}`.slice(0, 300)
}

function describeEvidence(pos) {
  const ev = (pos.evidence ?? [])[0]
  if (!ev) return "self-confidence only"
  return typeof ev === "string" ? ev.slice(0, 120) : `${ev.kind ?? "evidence"}: ${String(ev.value ?? "").slice(0, 100)}`
}

/** One-line for the TUI. */
export function formatConflict(c) {
  if (!c) return ""
  if (c.status === CONFLICT_STATUS.RESOLVED) {
    return `[CONFLICT RESOLVED] ${c.resolution.winner}: ${c.resolution.reason}`
  }
  if (c.status === CONFLICT_STATUS.ESCALATED) {
    return `[CONFLICT OPEN] ${c.topic || "disagreement"} — needs discriminating experiment`
  }
  return `[CONFLICT REPORTED] ${c.a.claimant} vs ${c.b.claimant}${c.topic ? ` on ${c.topic}` : ""}`
}

function clamp01(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 0.5
  return Math.max(0, Math.min(1, x))
}
