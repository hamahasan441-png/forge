/**
 * forge — causal engine (∞, zero dependencies)
 *
 * A failure is not one blob of text. It has layers:
 *   SYMPTOM → PROXIMATE → ROOT, plus CONTRIBUTING and SECONDARY.
 *
 * The repair loop must name the layer it is acting on. Fixing a symptom
 * (the test assertion) while the root (wrong timeout) is open is how
 * loops happen. A REJECTED root is never the next repair.
 *
 * Deterministic. No model call. Meta still owns the lifecycle.
 */
import { classifyFailure, FAILURE } from "./diagnose.js"

export const LAYER = {
  SYMPTOM: "SYMPTOM",
  PROXIMATE: "PROXIMATE",
  ROOT: "ROOT",
  CONTRIBUTING: "CONTRIBUTING",
  SECONDARY: "SECONDARY",
}

export const LSTATUS = {
  OPEN: "OPEN",
  SUPPORTED: "SUPPORTED",
  REJECTED: "REJECTED",
  CONFIRMED: "CONFIRMED",
  STALE: "STALE",
}

const LAYER_OF_CODE = {
  [FAILURE.SYNTAX_FAILURE]: LAYER.PROXIMATE,
  [FAILURE.TYPE_FAILURE]: LAYER.PROXIMATE,
  [FAILURE.TEST_FAILURE]: LAYER.SYMPTOM,
  [FAILURE.BUILD_FAILURE]: LAYER.SYMPTOM,
  [FAILURE.DEPENDENCY_FAILURE]: LAYER.ROOT,
  [FAILURE.CONFIGURATION_FAILURE]: LAYER.ROOT,
  [FAILURE.RUNTIME_FAILURE]: LAYER.PROXIMATE,
  [FAILURE.INTEGRATION_FAILURE]: LAYER.PROXIMATE,
  [FAILURE.STATE_FAILURE]: LAYER.CONTRIBUTING,
  [FAILURE.CONCURRENCY_FAILURE]: LAYER.ROOT,
  [FAILURE.ENVIRONMENT_FAILURE]: LAYER.CONTRIBUTING,
  [FAILURE.PERFORMANCE_FAILURE]: LAYER.PROXIMATE,
  [FAILURE.RESOURCE_FAILURE]: LAYER.CONTRIBUTING,
  [FAILURE.TOOL_FAILURE]: LAYER.ROOT,
  [FAILURE.NETWORK_FAILURE]: LAYER.PROXIMATE,
  [FAILURE.TIMEOUT]: LAYER.PROXIMATE,
  [FAILURE.NOT_FOUND]: LAYER.PROXIMATE,
  [FAILURE.INVALID_ARGUMENT]: LAYER.PROXIMATE,
  [FAILURE.PERMISSION_DENIED]: LAYER.ROOT,
  [FAILURE.SAFETY_BLOCK]: LAYER.ROOT,
  [FAILURE.CANCELLED]: LAYER.SECONDARY,
}

let seq = 0
function nextId() {
  seq += 1
  return `C${seq}`
}

export function createCausalEngine() {
  const nodes = new Map()
  let lastSymptom = null

  function get(id) {
    return nodes.get(id) || null
  }

  function add({ id, layer = LAYER.SYMPTOM, description, confidence = 0.5, parent = null, code = null } = {}) {
    const cid = id || nextId()
    if (nodes.has(cid)) return nodes.get(cid)
    const n = {
      id: cid,
      layer,
      description: String(description ?? "").slice(0, 400),
      confidence: clamp01(confidence),
      parent: parent || null,
      code: code || null,
      status: LSTATUS.OPEN,
      evidence: [],
    }
    nodes.set(cid, n)
    if (layer === LAYER.SYMPTOM) lastSymptom = n
    return n
  }

  /**
   * Observe a failed command. Always records a SYMPTOM; proposes a layer
   * from the failure code (test fail = symptom, missing dep = root, …).
   */
  function observe(result, meta = {}) {
    const d = meta.diagnosis && meta.diagnosis.failed ? meta.diagnosis : classifyFailure(result, meta)
    if (!d.failed) return { diagnosis: d, symptom: null, proposed: null }
    const symptom = add({
      layer: LAYER.SYMPTOM,
      description: String(d.evidence || d.code || "failure").slice(0, 240),
      confidence: 0.8,
      code: d.code,
    })
    const layer = LAYER_OF_CODE[d.code] || LAYER.PROXIMATE
    let proposed = symptom
    if (layer !== LAYER.SYMPTOM) {
      proposed = add({
        layer,
        description: `${d.code}: ${String(d.evidence || "").slice(0, 200)}`,
        confidence: layer === LAYER.ROOT ? 0.45 : 0.55,
        parent: symptom.id,
        code: d.code,
      })
    }
    return { diagnosis: d, symptom, proposed }
  }

  function support(id, payload) {
    const n = get(id)
    if (!n || n.status === LSTATUS.REJECTED || n.status === LSTATUS.STALE) return n
    n.evidence.push({ kind: "support", text: String(payload?.text ?? payload ?? "").slice(0, 300), at: Date.now() })
    n.confidence = clamp01(n.confidence + 0.15)
    if (n.status === LSTATUS.OPEN) n.status = LSTATUS.SUPPORTED
    return n
  }

  function contradict(id, payload) {
    const n = get(id)
    if (!n || n.status === LSTATUS.CONFIRMED) return n
    n.evidence.push({ kind: "contradict", text: String(payload?.text ?? payload ?? "").slice(0, 300), at: Date.now() })
    n.confidence = clamp01(n.confidence - 0.35)
    if (n.confidence < 0.3) n.status = LSTATUS.REJECTED
    return n
  }

  function confirm(id) {
    const n = get(id)
    if (!n || n.status === LSTATUS.REJECTED) return n
    n.status = LSTATUS.CONFIRMED
    n.confidence = 1
    return n
  }

  function reject(id, payload) {
    const n = get(id)
    if (!n) return n
    if (payload) n.evidence.push({ kind: "reject", text: String(payload?.text ?? payload ?? "").slice(0, 300), at: Date.now() })
    n.status = LSTATUS.REJECTED
    n.confidence = 0
    return n
  }

  function stale(id) {
    const n = get(id)
    if (!n) return n
    if (n.status === LSTATUS.CONFIRMED || n.status === LSTATUS.REJECTED) return n
    n.status = LSTATUS.STALE
    return n
  }

  function ofLayer(layer) {
    return [...nodes.values()].filter((n) => n.layer === layer)
  }

  function live(layer) {
    return ofLayer(layer).filter((n) => n.status === LSTATUS.OPEN || n.status === LSTATUS.SUPPORTED || n.status === LSTATUS.CONFIRMED)
      .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
  }

  /** Best node at a layer, CONFIRMED first, then highest confidence live. */
  function best(layer) {
    const all = live(layer)
    const confirmed = all.filter((n) => n.status === LSTATUS.CONFIRMED)
    return (confirmed[0] || all[0]) || null
  }

  function chain() {
    return {
      symptom: best(LAYER.SYMPTOM) || lastSymptom,
      proximate: best(LAYER.PROXIMATE),
      root: best(LAYER.ROOT),
      contributing: live(LAYER.CONTRIBUTING),
      secondary: live(LAYER.SECONDARY),
    }
  }

  /**
   * What the next repair should target. Prefer a confirmed/open ROOT; never
   * a REJECTED node; never a SYMPTOM when a live ROOT exists.
   */
  function nextTarget() {
    const c = chain()
    if (c.root && c.root.status !== LSTATUS.REJECTED) {
      return { layer: LAYER.ROOT, node: c.root, reason: "act on root, not the symptom" }
    }
    if (c.proximate && c.proximate.status !== LSTATUS.REJECTED) {
      return { layer: LAYER.PROXIMATE, node: c.proximate, reason: "no root yet — discriminate the proximate cause" }
    }
    if (c.contributing[0]) {
      return { layer: LAYER.CONTRIBUTING, node: c.contributing[0], reason: "no proximate — inspect a contributing factor" }
    }
    if (c.symptom) {
      return { layer: LAYER.SYMPTOM, node: c.symptom, reason: "only the symptom is known — inspect before patching" }
    }
    return { layer: null, node: null, reason: "no causal node" }
  }

  function snapshot() {
    return [...nodes.values()].map((n) => ({ ...n, evidence: [...n.evidence] }))
  }

  return {
    add, get, observe, support, contradict, confirm, reject, stale,
    ofLayer, live, best, chain, nextTarget, snapshot, size: () => nodes.size,
  }
}

/**
 * Counterfactual from an impact radius: if the named root were fixed, which
 * files would still be at risk, and which tests would still need to run.
 * A miss is UNKNOWN, never "nothing depends on this".
 */
export function counterfactual(impact = {}, { root = null } = {}) {
  const files = arr(impact.files)
  const importers = arr(impact.importers)
  const tests = arr(impact.tests)
  const configs = arr(impact.configs)
  const unknown = impact.unknown === true || files.length === 0
  return {
    root: root ? String(root).slice(0, 240) : null,
    ifFixed: files.slice(0, 40),
    stillAtRisk: unique([...importers, ...tests]).slice(0, 40),
    configs: configs.slice(0, 12),
    tests: tests.slice(0, 20),
    scope: Array.isArray(impact.scope) ? [...impact.scope] : [],
    unknown,
    radius: Number(impact.radius) || (files.length + importers.length + tests.length),
  }
}

function arr(x) {
  return Array.isArray(x) ? x.map(String).filter(Boolean) : []
}
function unique(xs) {
  return [...new Set(xs)]
}
function clamp01(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 0
  return Math.max(0, Math.min(1, x))
}
