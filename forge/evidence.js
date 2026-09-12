/**
 * forge — evidence kinds (Ω, zero dependencies)
 *
 * Decisions distinguish FACT / INFERENCE / HYPOTHESIS / UNKNOWN / VERIFIED /
 * STALE. Guesses never become facts. Provenance is required. A fact about a
 * file is STALE the moment that file is written after the fact's `asOf`.
 *
 * v91 (∞ CORE §19): the evidence engine carries the full claim ladder —
 * OBSERVATION / FINDING / ANALYSIS join the kinds, VERIFICATION and PROOF
 * mark verified claims, and every item may carry structured provenance:
 * source, command, file, line, symbol, timestamp, task, reproducibility,
 * confidence and freshness. When the source changes, dependent evidence
 * goes STALE (isStale is unchanged and now also honors `provenance.file`).
 */
export const KIND = {
  FACT: "FACT",
  OBSERVATION: "OBSERVATION",
  FINDING: "FINDING",
  ANALYSIS: "ANALYSIS",
  INFERENCE: "INFERENCE",
  HYPOTHESIS: "HYPOTHESIS",
  VERIFICATION: "VERIFICATION",
  VERIFIED: "VERIFIED",
  PROOF: "PROOF",
  UNKNOWN: "UNKNOWN",
  STALE: "STALE",
}

export function fact(value, { source = "observe", files = [], asOf = Date.now() } = {}) {
  return { kind: KIND.FACT, value, source: String(source), files: asFiles(files), asOf, confidence: 1 }
}

/** v91 §19 — raw observation (tool output, command result). Evidence-bearing
 *  but weaker than a fact: it is what we SAW, not yet what we KNOW. */
export function observation(value, { source = "tool", files = [], asOf = Date.now(), confidence = 0.8, provenance = null } = {}) {
  return withProvenance({ kind: KIND.OBSERVATION, value, source: String(source), files: asFiles(files), asOf, confidence: clamp01(confidence) }, provenance)
}

/** v91 §19 — a finding: the result of looking for something specific. */
export function finding(value, { source = "search", files = [], asOf = Date.now(), confidence = 0.7, provenance = null } = {}) {
  return withProvenance({ kind: KIND.FINDING, value, source: String(source), files: asFiles(files), asOf, confidence: clamp01(confidence) }, provenance)
}

/** v91 §19 — an analysis: interpretation over observations/findings. */
export function analysis(value, { source = "analyze", files = [], asOf = Date.now(), confidence = 0.6, provenance = null } = {}) {
  return withProvenance({ kind: KIND.ANALYSIS, value, source: String(source), files: asFiles(files), asOf, confidence: clamp01(confidence) }, provenance)
}

/** v91 §19 — the record that a specific verification ran and what it showed. */
export function verification(value, { source = "verify", files = [], asOf = Date.now(), confidence = 1, provenance = null } = {}) {
  return withProvenance({ kind: KIND.VERIFICATION, value, source: String(source), files: asFiles(files), asOf, confidence: clamp01(confidence) }, provenance)
}

/** v91 §19 — proof: the strongest claim; requires a reproducible source. */
export function proof(value, { source = "prove", files = [], asOf = Date.now(), provenance = null } = {}) {
  const ev = withProvenance({ kind: KIND.PROOF, value, source: String(source), files: asFiles(files), asOf, confidence: 1 }, provenance)
  if (!ev.provenance || !ev.provenance.reproducible) {
    // a proof without reproducibility is a VERIFICATION, never a PROOF
    ev.kind = KIND.VERIFICATION
    ev.downgraded_from = KIND.PROOF
  }
  return ev
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
 * v91: provenance.file and provenance.symbol follow the same rule.
 */
export function isStale(ev, writes = {}) {
  if (!ev || ev.kind === KIND.UNKNOWN) return false
  if (ev.kind === KIND.STALE) return true
  const asOf = Number(ev.asOf) || 0
  const paths = new Set([...(ev.files || [])])
  const p = ev.provenance
  if (p?.file) paths.add(p.file)
  for (const f of paths) {
    const w = writes[f]
    if (w != null && Number(w) > asOf) return true
  }
  return false
}

/** v91 §19 — attach structured provenance (source, command, file, line,
 *  symbol, task, reproducibility, freshness). Bounded and serializable. */
export function withProvenance(ev, provenance = null) {
  if (!provenance || typeof provenance !== "object") return ev
  ev.provenance = {
    command: provenance.command != null ? String(provenance.command).slice(0, 300) : undefined,
    file: provenance.file != null ? String(provenance.file).slice(0, 500) : undefined,
    line: Number.isFinite(Number(provenance.line)) ? Number(provenance.line) : undefined,
    symbol: provenance.symbol != null ? String(provenance.symbol).slice(0, 200) : undefined,
    task: provenance.task != null ? String(provenance.task).slice(0, 120) : undefined,
    node: provenance.node != null ? String(provenance.node).slice(0, 120) : undefined,
    reproducible: provenance.reproducible === true ? true : undefined,
    commandHash: provenance.commandHash != null ? String(provenance.commandHash).slice(0, 64) : undefined,
  }
  // drop undefined keys so JSON stays compact
  for (const k of Object.keys(ev.provenance)) if (ev.provenance[k] === undefined) delete ev.provenance[k]
  if (!Object.keys(ev.provenance).length) delete ev.provenance
  return ev
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
