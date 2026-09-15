/**
 * forge — shared task contract (v100 cognitionwise, zero dependencies)
 *
 * Canonical task state. Intent is versioned. Original wording is frozen.
 * Assumptions are never promoted to requirements.
 *
 * Success is not "code changed" and not "tests passed" alone.
 * Success = user goal + requirements + expected behavior + verification.
 */
export const REQ = {
  OPEN: "OPEN",
  IN_PROGRESS: "IN_PROGRESS",
  IMPLEMENTED: "IMPLEMENTED",
  VERIFIED: "VERIFIED",
  CLOSED: "CLOSED",
  BLOCKED: "BLOCKED",
  PARTIAL: "PARTIAL",
}

export const GAP = {
  MISSING: "missing",
  BROKEN: "broken",
  INCORRECT: "incorrect",
  INCOMPLETE: "incomplete",
  UNKNOWN: "unknown",
  UNVERIFIED: "unverified",
  MISCONFIGURED: "misconfigured",
  ARCHITECTURAL: "architectural",
  BEHAVIORAL: "behavioral",
  PERFORMANCE: "performance",
  DEPENDENCY: "dependency",
  CONFLICT: "conflict",
}

let seq = 0
function nextId(prefix) {
  seq += 1
  return `${prefix}${seq}`
}

export function createTaskContract({ originalIntent = "" } = {}) {
  const createdAt = Date.now()
  const intents = []
  if (originalIntent) {
    intents.push({ version: 1, text: String(originalIntent), at: createdAt, source: "user", reason: "original" })
  }
  const requirements = []
  const constraints = []
  const unknowns = []
  const hypotheses = []
  const evidence = []
  const decisions = []
  const alternatives = []
  const predictions = []
  const gaps = []
  let strategy = null
  let expectedOutcome = null
  let actualOutcome = null
  let verification = { status: "NONE", records: [] }
  let userFeedback = []
  let scope = { files: [], modules: [], allowed: true }
  let desiredWorld = null
  let currentWorld = null

  function freezeIntent(text, { source = "user", reason = "original" } = {}) {
    const t = String(text ?? "").trim()
    if (!t) return currentIntent()
    if (!intents.length) {
      intents.push({ version: 1, text: t, at: Date.now(), source, reason })
      return currentIntent()
    }
    // original is immutable — later versions are discovery, not replacement
    return currentIntent()
  }

  function reviseIntent(text, { source = "discovery", reason = "evidence" } = {}) {
    const t = String(text ?? "").trim()
    if (!t) return currentIntent()
    if (!intents.length) return freezeIntent(t, { source, reason: "original" })
    if (intents[intents.length - 1].text === t) return currentIntent()
    intents.push({ version: intents.length + 1, text: t, at: Date.now(), source, reason })
    return currentIntent()
  }

  function original() {
    return intents[0] || null
  }

  function currentIntent() {
    return intents[intents.length - 1] || null
  }

  function addRequirement({ text, source = "user", tag = "REQUIREMENT" } = {}) {
    if (tag === "ASSUMPTION") {
      return { ok: false, reason: "never promote an assumption to a requirement", item: null }
    }
    const rec = {
      id: nextId("R"),
      text: String(text ?? "").slice(0, 400),
      source,
      tag,
      status: REQ.OPEN,
      at: Date.now(),
      evidence: [],
    }
    requirements.push(rec)
    return { ok: true, item: rec }
  }

  function setRequirement(id, status, { evidenceId = null } = {}) {
    const rec = requirements.find((r) => r.id === id)
    if (!rec) return { ok: false, reason: "unknown requirement" }
    if (!Object.values(REQ).includes(status)) return { ok: false, reason: "bad status" }
    rec.status = status
    if (evidenceId) rec.evidence.push(evidenceId)
    rec.updatedAt = Date.now()
    return { ok: true, item: rec }
  }

  function addUnknown({ text, impact = "LOW-VALUE UNKNOWN", kind = GAP.UNKNOWN } = {}) {
    const rec = {
      id: nextId("U"),
      text: String(text ?? "").slice(0, 300),
      impact, // UNKNOWN | LOW-VALUE UNKNOWN | HIGH-VALUE UNKNOWN | CRITICAL UNKNOWN
      kind,
      at: Date.now(),
    }
    unknowns.push(rec)
    return rec
  }

  function resolveUnknown(id) {
    const i = unknowns.findIndex((u) => u.id === id)
    if (i < 0) return false
    unknowns.splice(i, 1)
    return true
  }

  function addGap({ text, kind = GAP.UNKNOWN, impact = "medium" } = {}) {
    const rec = { id: nextId("G"), text: String(text ?? "").slice(0, 300), kind, impact, at: Date.now() }
    gaps.push(rec)
    return rec
  }

  function noteEvidence(ev) {
    evidence.push({ ...ev, at: ev?.at ?? Date.now() })
    if (evidence.length > 80) evidence.splice(0, evidence.length - 80)
  }

  function notePrediction(p) {
    predictions.push({ ...p, at: Date.now() })
  }

  function settlePrediction(id, actual) {
    const p = predictions.find((x) => x.id === id) || predictions[predictions.length - 1]
    if (!p) return null
    p.actual = actual
    p.error = p.expected != null && actual != null ? String(p.expected) !== String(actual) : null
    return p
  }

  function setStrategy(s) { strategy = s; return s }
  function setExpected(o) { expectedOutcome = o }
  function setActual(o) { actualOutcome = o }
  function setVerification(v) { verification = { ...verification, ...v } }
  function setWorlds({ desired = null, current = null } = {}) {
    if (desired != null) desiredWorld = desired
    if (current != null) currentWorld = current
  }
  function addFeedback(f) { userFeedback.push(f) }
  function addDecision(d) { decisions.push({ ...d, at: Date.now() }) }
  function addAlternative(a) { alternatives.push(a) }

  function openCritical() {
    return requirements.filter((r) => r.tag === "REQUIREMENT" && r.status !== REQ.CLOSED && r.status !== REQ.VERIFIED && r.status !== REQ.BLOCKED)
  }

  function criticalUnknowns() {
    return unknowns.filter((u) => /CRITICAL|HIGH-VALUE/.test(u.impact))
  }

  /**
   * Implemented ≠ verified ≠ closed.
   * A task cannot COMPLETE while a REQUIREMENT is OPEN/IMPLEMENTED without VERIFIED.
   */
  function closure() {
    const reqs = requirements.filter((r) => r.tag === "REQUIREMENT")
    const open = reqs.filter((r) => r.status === REQ.OPEN || r.status === REQ.IN_PROGRESS || r.status === REQ.IMPLEMENTED || r.status === REQ.PARTIAL)
    const blocked = reqs.filter((r) => r.status === REQ.BLOCKED)
    const critU = criticalUnknowns()
    const verified = verification.status === "VERIFIED" || verification.status === "PASSED"
    const intent = currentIntent()
    return {
      ok: open.length === 0 && blocked.length === 0 && critU.length === 0 && (!reqs.length || verified || requirements.length === 0),
      open: open.map((r) => r.id),
      blocked: blocked.map((r) => r.id),
      criticalUnknowns: critU.map((u) => u.id),
      verification: verification.status,
      intent: intent?.text ?? null,
      originalIntent: original()?.text ?? null,
    }
  }

  function canComplete({ wrote = false, unverified = [], klass = "SMALL" } = {}) {
    const c = closure()
    if (c.blocked.length) return { ok: false, status: "BLOCKED", why: "a requirement is blocked", closure: c }
    if (c.criticalUnknowns.length) return { ok: false, status: "INCOMPLETE", why: "critical unknown remains", closure: c }
    if (wrote && unverified.length && (klass === "LARGE" || klass === "ARCHITECTURAL" || klass === "MEDIUM")) {
      return { ok: false, status: "VERIFICATION_FAILED", why: "writes without covering checks", closure: c }
    }
    if (c.open.length && wrote) return { ok: false, status: "PARTIAL", why: "requirements implemented but not closed", closure: c }
    return { ok: true, status: "CLOSED", why: "goal satisfied or no open requirements", closure: c }
  }

  function snapshot() {
    return {
      userIntent: currentIntent()?.text ?? null,
      originalIntent: original()?.text ?? null,
      currentIntent: currentIntent()?.text ?? null,
      intentVersions: intents.slice(),
      desiredOutcome: currentIntent()?.text ?? null,
      desiredWorld,
      currentWorld,
      requirements: requirements.slice(),
      constraints: constraints.slice(),
      scope,
      unknowns: unknowns.slice(),
      hypotheses: hypotheses.slice(),
      evidence: evidence.slice(-24),
      decisions: decisions.slice(),
      alternatives: alternatives.slice(),
      strategy,
      predictions: predictions.slice(-12),
      expectedOutcome,
      actualOutcome,
      verification,
      userFeedback: userFeedback.slice(),
      gaps: gaps.slice(),
      closure: closure(),
    }
  }

  function formatForPrompt() {
    const o = original()
    const c = currentIntent()
    const cl = closure()
    const lines = ["TASK CONTRACT (original wording is frozen; discovery versions, never silent substitution):"]
    if (o) lines.push(`- Intent v1 (original): ${o.text}`)
    if (c && o && c.version !== o.version) lines.push(`- Intent v${c.version} (${c.reason}): ${c.text}`)
    if (requirements.length) {
      lines.push("- requirements:")
      for (const r of requirements.slice(0, 8)) lines.push(`  ${r.id} [${r.status}/${r.tag}] ${r.text}`)
    }
    if (unknowns.length) {
      lines.push("- unknowns:")
      for (const u of unknowns.slice(0, 6)) lines.push(`  ${u.id} [${u.impact}] ${u.text}`)
    }
    if (gaps.length) {
      lines.push("- gaps (desired − current):")
      for (const g of gaps.slice(0, 6)) lines.push(`  ${g.id} [${g.kind}] ${g.text}`)
    }
    lines.push(`- closure: ${cl.ok ? "closable" : "OPEN"} (open=${cl.open.length} blocked=${cl.blocked.length} critUnknown=${cl.criticalUnknowns.length} verify=${cl.verification})`)
    lines.push("- IMPLEMENTED ≠ VERIFIED. Do not report complete without the verification ladder.")
    return lines.join("\n")
  }

  return {
    freezeIntent, reviseIntent, original, currentIntent,
    addRequirement, setRequirement, addUnknown, resolveUnknown, addGap,
    noteEvidence, notePrediction, settlePrediction,
    setStrategy, setExpected, setActual, setVerification, setWorlds,
    addFeedback, addDecision, addAlternative,
    closure, canComplete, snapshot, formatForPrompt,
    REQ, GAP,
  }
}
