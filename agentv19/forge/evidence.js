/**
 * forge — evidence kinds (Ω, zero dependencies)
 *
 * Decisions distinguish FACT / INFERENCE / HYPOTHESIS / UNKNOWN / VERIFIED /
 * STALE. Guesses never become facts. Provenance is required. A fact about a
 * file is STALE the moment that file is written after the fact's `asOf`.
 */
export const KIND = {
  FACT: "FACT",
  INFERENCE: "INFERENCE",
  HYPOTHESIS: "HYPOTHESIS",
  UNKNOWN: "UNKNOWN",
  VERIFIED: "VERIFIED",
  STALE: "STALE",
}

export function fact(value, { source = "observe", files = [], asOf = Date.now() } = {}) {
  return { kind: KIND.FACT, value, source: String(source), files: asFiles(files), asOf, confidence: 1 }
}

export function inference(value, { source = "reason", files = [], asOf = Date.now(), confidence = 0.6 } = {}) {
  return { kind: KIND.INFERENCE, value, source: String(source), files: asFiles(files), asOf, confidence: clamp01(confidence) }
}

export function hypothesis(value, { source = "guess", files = [], asOf = Date.now(), confidence = 0.4 } = {}) {
  return { kind: KIND.HYPOTHESIS, value, source: String(source), files: asFiles(files), asOf, confidence: clamp01(confidence) }
}

export function unknown(value, { source = "gap" } = {}) {
  return { kind: KIND.UNKNOWN, value, source: String(source), files: [], asOf: Date.now(), confidence: 0 }
}

export function verified(value, { source = "test", files = [], asOf = Date.now() } = {}) {
  return { kind: KIND.VERIFIED, value, source: String(source), files: asFiles(files), asOf, confidence: 1 }
}

/**
 * A fact covering `files` is stale when any of those files was written after
 * `asOf`. Callers pass the write ledger (path → mtime/epoch).
 */
export function isStale(ev, writes = {}) {
  if (!ev || ev.kind === KIND.UNKNOWN) return false
  if (ev.kind === KIND.STALE) return true
  const asOf = Number(ev.asOf) || 0
  for (const f of ev.files || []) {
    const w = writes[f]
    if (w != null && Number(w) > asOf) return true
  }
  return false
}

/** Convert a v32 index (`{ files: { rel: { mtime } } }`) into the writes ledger `isStale` expects. Empty/missing index → {}. */
export function writesFromIndex(idx) {
  const out = {}
  const files = idx && idx.files && typeof idx.files === "object" && !Array.isArray(idx.files) ? idx.files : null
  if (!files) return out
  for (const [rel, rec] of Object.entries(files)) {
    const m = Number(rec?.mtime)
    if (Number.isFinite(m) && m > 0) out[String(rel)] = m
  }
  return out
}

export function markStale(ev) {
  return { ...ev, kind: KIND.STALE, confidence: 0 }
}

export function createEvidenceLog() {
  const items = []
  function record(ev) {
    items.push(ev)
    return ev
  }
  function invalidate(writes) {
    for (let i = 0; i < items.length; i++) {
      if (isStale(items[i], writes) && items[i].kind !== KIND.STALE) items[i] = markStale(items[i])
    }
  }
  function ofKind(kind) {
    return items.filter((e) => e.kind === kind)
  }
  function snapshot() {
    return items.map((e) => ({ ...e, files: [...(e.files || [])] }))
  }
  return { record, invalidate, ofKind, snapshot, get length() { return items.length } }
}

function asFiles(files) {
  return (Array.isArray(files) ? files : [files]).map((f) => String(f || "")).filter(Boolean).slice(0, 32)
}
function clamp01(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 0
  return Math.max(0, Math.min(1, x))
}
