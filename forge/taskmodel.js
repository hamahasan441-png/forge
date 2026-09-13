/**
 * forge — task model with origin tags (∞, zero dependencies)
 *
 * Every statement about the task is tagged:
 *   REQUIREMENT     — the user asked for this (frozen)
 *   IMPLEMENTATION  — how we chose to do it
 *   ASSUMPTION      — we guessed; must be tested
 *   INFERENCE       — derived from evidence, not asked
 *   FACT            — observed, provenance required
 *
 * An ASSUMPTION never becomes a REQUIREMENT. Promoting a guess into the
 * acceptance criteria is how agents "complete" work the user did not ask
 * for. Requirements come from the user (or an explicit user confirmation),
 * never from the model talking to itself.
 */
export const TAG = {
  REQUIREMENT: "REQUIREMENT",
  IMPLEMENTATION: "IMPLEMENTATION",
  ASSUMPTION: "ASSUMPTION",
  INFERENCE: "INFERENCE",
  FACT: "FACT",
}

/** Legal promotions. ASSUMPTION → REQUIREMENT is deliberately absent. */
const ALLOWED = {
  [TAG.ASSUMPTION]: new Set([TAG.INFERENCE, TAG.FACT, TAG.IMPLEMENTATION]),
  [TAG.INFERENCE]: new Set([TAG.FACT]),
  [TAG.IMPLEMENTATION]: new Set([TAG.FACT]),
  [TAG.FACT]: new Set(),
  [TAG.REQUIREMENT]: new Set(),
}

let seq = 0
function nextId() {
  seq += 1
  return `T${seq}`
}

export function createTaskModel() {
  const items = new Map()

  function get(id) {
    return items.get(id) || null
  }

  function add({ id, tag, text, source = "user", files = [] } = {}) {
    const tid = id || nextId()
    if (items.has(tid)) return items.get(tid)
    const t = String(tag || TAG.ASSUMPTION)
    const rec = {
      id: tid,
      tag: TAG[t] || TAG.ASSUMPTION,
      text: String(text ?? "").slice(0, 400),
      source: String(source).slice(0, 80),
      files: (Array.isArray(files) ? files : [files]).map(String).filter(Boolean).slice(0, 16),
      at: Date.now(),
    }
    items.set(tid, rec)
    return rec
  }

  /**
   * Promote a statement to a stricter tag.
   * ASSUMPTION → REQUIREMENT is always refused.
   */
  function promote(id, toTag, { source = "promote" } = {}) {
    const rec = get(id)
    if (!rec) return { ok: false, reason: "unknown id", item: null }
    const to = TAG[toTag] || toTag
    if (rec.tag === TAG.ASSUMPTION && to === TAG.REQUIREMENT) {
      return { ok: false, reason: "never promote an assumption to a requirement", item: rec }
    }
    const allowed = ALLOWED[rec.tag] || new Set()
    if (rec.tag === to) return { ok: true, reason: "already", item: rec }
    if (!allowed.has(to)) {
      return { ok: false, reason: `cannot promote ${rec.tag} → ${to}`, item: rec }
    }
    rec.tag = to
    rec.source = `${rec.source}>${source}`
    return { ok: true, reason: "promoted", item: rec }
  }

  function ofTag(tag) {
    return [...items.values()].filter((i) => i.tag === tag)
  }

  function requirements() {
    return ofTag(TAG.REQUIREMENT)
  }

  /** Assumptions still open — the review pass must not treat these as asked. */
  function openAssumptions() {
    return ofTag(TAG.ASSUMPTION)
  }

  function snapshot() {
    return [...items.values()].map((i) => ({ ...i, files: [...i.files] }))
  }

  return { add, get, promote, ofTag, requirements, openAssumptions, snapshot, size: () => items.size }
}

/** Seed the model from a user objective. The objective is a REQUIREMENT. */
export function seedFromObjective(objective, model = createTaskModel()) {
  const text = String(objective ?? "").replace(/\s+/g, " ").trim()
  if (text) model.add({ tag: TAG.REQUIREMENT, text: text.slice(0, 400), source: "user" })
  return model
}
