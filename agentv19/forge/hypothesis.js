/**
 * forge — hypothesis engine (Ω, zero dependencies)
 *
 * A non-trivial failure is not "try the same command again". It is:
 *   error → candidate causes → rank → smallest discriminating test
 *        → update confidence → confirm or reject.
 *
 * States: OPEN, SUPPORTED, REJECTED, CONFIRMED, STALE.
 * A REJECTED hypothesis is never retried as the primary path. Repeating the
 * same (hypothesis, test) pair is a loop and is reported, not executed.
 */
export const HSTATUS = {
  OPEN: "OPEN",
  SUPPORTED: "SUPPORTED",
  REJECTED: "REJECTED",
  CONFIRMED: "CONFIRMED",
  STALE: "STALE",
}

let seq = 0
function nextId() {
  seq += 1
  return `H${seq}`
}

export function createHypothesisEngine() {
  const items = new Map()
  const attempts = []

  function get(id) {
    return items.get(id) || null
  }

  function add({ id, description, confidence = 0.5 } = {}) {
    const hid = id || nextId()
    if (items.has(hid)) return items.get(hid)
    const h = {
      id: hid,
      description: String(description ?? "").slice(0, 400),
      confidence: clamp01(confidence),
      supportingEvidence: [],
      contradictingEvidence: [],
      tests: [],
      status: HSTATUS.OPEN,
    }
    items.set(hid, h)
    return h
  }

  function evidence(kind, payload) {
    return {
      kind,
      text: String(payload?.text ?? payload ?? "").slice(0, 400),
      at: payload?.at ?? Date.now(),
      source: payload?.source ?? "observe",
    }
  }

  function support(id, payload) {
    const h = get(id)
    if (!h || h.status === HSTATUS.REJECTED || h.status === HSTATUS.STALE) return h
    h.supportingEvidence.push(evidence("support", payload))
    h.confidence = clamp01(h.confidence + 0.15)
    if (h.status === HSTATUS.OPEN) h.status = HSTATUS.SUPPORTED
    return h
  }

  function contradict(id, payload) {
    const h = get(id)
    if (!h || h.status === HSTATUS.CONFIRMED) return h
    h.contradictingEvidence.push(evidence("contradict", payload))
    h.confidence = clamp01(h.confidence - 0.35)
    if (h.contradictingEvidence.length >= 1 && h.confidence < 0.3) {
      h.status = HSTATUS.REJECTED
    }
    return h
  }

  function confirm(id) {
    const h = get(id)
    if (!h || h.status === HSTATUS.REJECTED) return h
    h.status = HSTATUS.CONFIRMED
    h.confidence = 1
    return h
  }

  function reject(id, payload) {
    const h = get(id)
    if (!h) return h
    if (payload) h.contradictingEvidence.push(evidence("reject", payload))
    h.status = HSTATUS.REJECTED
    h.confidence = 0
    return h
  }

  function stale(id) {
    const h = get(id)
    if (!h) return h
    if (h.status === HSTATUS.CONFIRMED || h.status === HSTATUS.REJECTED) return h
    h.status = HSTATUS.STALE
    return h
  }

  function recordTest(id, test) {
    const h = get(id)
    const rec = {
      id,
      test: String(test?.name ?? test ?? "").slice(0, 200),
      result: test?.result ?? null,
      at: Date.now(),
    }
    attempts.push(rec)
    if (h) h.tests.push(rec)
    return rec
  }

  function looping(id, testName) {
    const name = String(testName ?? "")
    const hits = attempts.filter((a) => a.id === id && a.test === name)
    return hits.length >= 2
  }

  function rank() {
    return [...items.values()]
      .filter((h) => h.status === HSTATUS.OPEN || h.status === HSTATUS.SUPPORTED)
      .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
  }

  function best() {
    return rank()[0] || null
  }

  function snapshot() {
    return [...items.values()].map((h) => ({ ...h, supportingEvidence: [...h.supportingEvidence], contradictingEvidence: [...h.contradictingEvidence], tests: [...h.tests] }))
  }

  return { add, get, support, contradict, confirm, reject, stale, recordTest, looping, rank, best, snapshot, size: () => items.size }
}

function clamp01(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 0
  return Math.max(0, Math.min(1, x))
}
