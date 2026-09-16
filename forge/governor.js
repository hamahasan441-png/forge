/**
 * forge — cognitive governor (v101 authoritywise, zero dependencies)
 *
 * The central controller. Not a prompt. Not a second brain.
 * Chooses the highest-value next cognitive action given the ONE cognitive state.
 *
 * v100 chose the action and narrated it. v101 ENFORCES it:
 * ASK pauses the run, VERIFY/INSPECT hide writes, STOP ends the loop.
 * The model is an instrument. The governor is the authority.
 *
 * Depth L0..L7: do not use L7 for a typo.
 */
export const ACTION = {
  THINK: "THINK",
  INSPECT: "INSPECT",
  SEARCH: "SEARCH",
  TEST: "TEST",
  EXPERIMENT: "EXPERIMENT",
  PLAN: "PLAN",
  EXECUTE: "EXECUTE",
  VERIFY: "VERIFY",
  REVIEW: "REVIEW",
  REPAIR: "REPAIR",
  REPLAN: "REPLAN",
  ASK: "ASK",
  WAIT: "WAIT",
  STOP: "STOP",
  ROLLBACK: "ROLLBACK",
}

export const DEPTH = {
  L0: "L0", // deterministic
  L1: "L1", // simple
  L2: "L2", // structured
  L3: "L3", // multi-hypothesis
  L4: "L4", // causal
  L5: "L5", // future simulation
  L6: "L6", // adversarial
  L7: "L7", // meta-reasoning
}

const MICRO_CLASS = new Set(["MICRO", "SMALL", "trivial", "simple"])

/** Native mutating tools. Governor never imports tools.js — keep this list in sync. */
export const WRITE_TOOL_NAMES = ["bash", "write_file", "edit_file", "multi_edit", "apply_patch"]

export const INSPECT_KEEP = [
  "read_file", "read_image", "list_dir", "glob_files", "grep_files",
  "git_status", "git_diff", "git_log", "git_blame", "github",
  "think", "semantic_search", "code_context", "kg_query", "plan_whatif",
  "load_skill",
]

const VERIFY_KEEP = [...INSPECT_KEEP, "bash", "todo"]

export const GOV_PREFIX = "(governor)"

export function depthFor({ klass = "SMALL", uncertainty = 0, impact = 0, failed = false, conflict = false } = {}) {
  if (MICRO_CLASS.has(klass) && !failed) return uncertainty > 0.6 ? DEPTH.L2 : DEPTH.L1
  if (klass === "ARCHITECTURAL" || impact >= 0.8) return conflict || failed ? DEPTH.L6 : DEPTH.L5
  if (klass === "LARGE" || failed) return DEPTH.L4
  if (uncertainty > 0.55) return DEPTH.L3
  return DEPTH.L2
}

/**
 * VOI = expected improvement in decision quality − acquisition cost.
 * Cheap inspection before an expensive question; question before irreversible action.
 */
export function voi({ impact = 0.5, uncertainty = 0.5, cost = 0.2 } = {}) {
  return Math.max(0, (Number(impact) * Number(uncertainty)) - Number(cost))
}

export function chooseNextAction({
  klass = "SMALL",
  contract = null,
  user = null,
  repair = null,
  writes = 0,
  unverified = [],
  steps = 0,
  failed = false,
  looping = false,
  pendingDecision = false,
  hasPlan = false,
  inspected = false,
  verified = false,
  reviewRequired = false,
  aborted = false,
  driftScore = 0,
  driftLevel = null,
  driftReplans = 0,
  experiment = null,
  knowledgeGap = false,
  capabilityGap = false,
  learnedDepth = null,
} = {}) {
  const u = user?.understanding || user || null
  const closure = contract?.closure?.() || contract?.snapshot?.()?.closure || { ok: true, open: [], blocked: [], criticalUnknowns: [], verification: "NONE" }
  const ambiguous = (u?.intentHypotheses?.length ?? 0) > 1 && (u?.confidence ?? 1) < 0.55
  const irreversible = u?.decisionAuthority === "IRREVERSIBLE_CONFIRM" || u?.decisionAuthority === "HIGH_IMPACT_CONFIRM"
  const impact = irreversible ? 0.85 : (klass === "ARCHITECTURAL" ? 0.8 : klass === "LARGE" ? 0.65 : 0.35)
  const uncertainty = u ? (1 - (u.confidence ?? 0.7)) : 0.3
  const depthDefault = depthFor({ klass, uncertainty, impact, failed, conflict: ambiguous })
  const learned = learnedDepth && Object.values(DEPTH).includes(String(learnedDepth)) ? String(learnedDepth) : null
  const depth = (!failed && !ambiguous && learned) ? learned : depthDefault

  const pick = (action, reason, extra = {}) => ({
    action,
    why: reason,
    depth,
    voi: extra.voi ?? voi({ impact, uncertainty, cost: extra.cost ?? 0.2 }),
    reversible: extra.reversible ?? (action !== ACTION.EXECUTE && action !== ACTION.ROLLBACK),
    ask: action === ACTION.ASK,
    stop: action === ACTION.STOP,
    detail: extra.detail ?? null,
  })

  if (aborted) return pick(ACTION.STOP, "run aborted")
  if (pendingDecision) return pick(ACTION.WAIT, "a human decision is pending — do not continue past it")

  if (looping) return pick(ACTION.REPLAN, "same strategy is looping — change hypothesis before retrying")

  // v102: a settled prediction that missed reality is a reason to change
  // hypothesis — but not for MICRO (a typo extra-file is not architecture)
  // and not forever (bounded replans).
  if (!MICRO_CLASS.has(klass) && driftReplans < 2 && (driftLevel === "MISS" || Number(driftScore) >= 0.75)) {
    return pick(ACTION.REPLAN, "prediction missed reality — change hypothesis before another mutation", {
      detail: { driftScore, driftLevel },
      voi: voi({ impact, uncertainty: Math.max(uncertainty, 0.7), cost: 0.2 }),
    })
  }
  if (!MICRO_CLASS.has(klass) && (driftLevel === "SCOPE" || (Number(driftScore) >= 0.5 && Number(driftScore) < 0.75)) && writes > 0 && !verified) {
    return pick(ACTION.VERIFY, "scope drifted from the prediction — verify before more writes", {
      detail: { driftScore, driftLevel },
      reversible: true, cost: 0.15,
    })
  }

  if (failed && experiment?.kind === "discriminate") {
    return pick(ACTION.TEST, experiment.instruction || "run the cheapest experiment that would discriminate the open hypothesis", {
      detail: experiment, voi: experiment.gain ?? voi({ impact, uncertainty, cost: 0.15 }),
    })
  }
  if (failed && experiment?.kind === "inspect") {
    return pick(ACTION.INSPECT, experiment.instruction || "inspect the failing evidence before another patch", {
      detail: experiment, voi: experiment.gain ?? voi({ impact, uncertainty, cost: 0.1 }),
    })
  }
  if (failed && repair?.action === "escalate") {
    return pick(ACTION.REPLAN, repair.reason || "origin is forge itself or a rejected cause is looping", { detail: repair })
  }
  if (failed) {
    const act = repair?.action === "inspect" ? ACTION.INSPECT : repair?.action === "test" ? ACTION.TEST : ACTION.REPAIR
    return pick(act, repair?.reason || "failure observed — discriminate hypotheses before another patch", { detail: repair })
  }

  // high-impact + high-uncertainty + cannot inspect cheaply → ASK
  if (ambiguous && irreversible && inspected) {
    return pick(ACTION.ASK, "irreversible work under unresolved intent hypotheses — ask, do not silently substitute the goal", {
      detail: { hypotheses: u.intentHypotheses?.map((h) => h.id) },
      voi: voi({ impact: 0.9, uncertainty: 0.7, cost: 0.4 }),
    })
  }
  if (ambiguous && !inspected) {
    return pick(ACTION.INSPECT, "intent is ambiguous — inspect reality before collapsing hypotheses (asking is more expensive than looking)", {
      voi: voi({ impact, uncertainty, cost: 0.1 }),
    })
  }

  if (closure.blocked?.length) return pick(ACTION.ASK, "a requirement is blocked on a user decision")
  if (closure.criticalUnknowns?.length && !inspected) {
    return pick(ACTION.INSPECT, "a high-value unknown is cheaper to inspect than to guess")
  }

  if (writes > 0 && unverified.length && !verified) {
    return pick(ACTION.VERIFY, `implemented ≠ verified — ${unverified.length} write(s) have no covering check`, {
      reversible: true, cost: 0.15, detail: { unverified: unverified.slice(0, 8) },
    })
  }

  if (reviewRequired && writes > 0) {
    return pick(ACTION.REVIEW, "adversarial review is required before completion")
  }

  // STOP only after real work is verified — never halt a run that has not started.
  const closable = contract?.canComplete?.({ wrote: writes > 0, unverified, klass })
  if (closable?.ok && writes > 0 && (verified || unverified.length === 0) && steps > 0) {
    return pick(ACTION.STOP, closable.why || "goal satisfied, remaining uncertainty is not worth more tokens")
  }

  if (!hasPlan && !MICRO_CLASS.has(klass) && steps === 0) {
    return pick(ACTION.PLAN, "no plan yet — generate competing strategies before the first mutation")
  }

  if (knowledgeGap && !inspected && writes === 0 && !MICRO_CLASS.has(klass)) {
    return pick(ACTION.SEARCH, "high-value knowledge gap — cheapest acquire (skill/repo) before a patch", {
      reversible: true, cost: 0.15,
    })
  }
  if (capabilityGap && !inspected && writes === 0 && !MICRO_CLASS.has(klass)) {
    return pick(ACTION.INSPECT, "required capability missing or unverified — do not fill the gap with raw reasoning", {
      reversible: true, cost: 0.1,
    })
  }

  if (!inspected && steps === 0) {
    return pick(ACTION.INSPECT, "reconstruct current world before changing it")
  }

  if (MICRO_CLASS.has(klass)) {
    return pick(ACTION.EXECUTE, "smallest sufficient action — do not escalate depth")
  }

  return pick(ACTION.EXECUTE, "highest-value remaining action is to apply the current strategy")
}

export function formatAction(a) {
  if (!a) return ""
  return `GOVERNOR: ${a.action} [${a.depth}] — ${a.why}`
}

export function directiveFor(action) {
  switch (String(action)) {
    case ACTION.INSPECT: return "Inspect reality with native read/grep/git_status first (cheapest reliable capability). Do not mutate files this step. Do not spend tokens on what a grep can answer."
    case ACTION.SEARCH: return "Search locally first (grep/glob). External search only if local evidence is insufficient. Do not mutate files this step."
    case ACTION.PLAN: return "Produce competing strategies. Rank cheapest reversible first. Do not mutate yet."
    case ACTION.REPLAN: return "The current strategy is looping or the prediction missed. Change hypothesis. Do not retry the same patch."
    case ACTION.EXECUTE: return "Apply the current strategy. Smallest sufficient mutation. Stay inside the predicted file set."
    case ACTION.VERIFY: return "Run a covering check now. Do not write more files until verification evidence exists."
    case ACTION.TEST: return "Run a discriminating test. Do not patch until the result is observed."
    case ACTION.REVIEW: return "Review the actual diff. Do not add unrelated edits."
    case ACTION.ASK: return "Stop. Ask the user. Do not guess the goal."
    case ACTION.WAIT: return "A human decision is pending. Do not continue."
    case ACTION.STOP: return "Stop. Do not call tools."
    case ACTION.REPAIR: return "Discriminate failure hypotheses with a test before another identical patch."
    case ACTION.ROLLBACK: return "Revert the last mutation. Do not add new work on top of a failed change."
    default: return "Follow the governor action."
  }
}

/**
 * What the loop MUST do with a governor action. MICRO/SMALL keep mutation
 * available (existing one-shot paths, verify-nudge); ASK/WAIT/STOP always
 * halt regardless of class. MEDIUM+ hide writes on INSPECT/VERIFY/PLAN/REPLAN.
 *
 * v122 "yolowise" — `enforce: false` (what YOLO resolves to) keeps EVERYTHING
 * this function says except the veto: the action, the directive, the depth,
 * and the event stream stay identical, but nothing is hidden, nothing is
 * frozen, and no step waits for a human. That is a deliberate asymmetry:
 * INSPECT-before-write is a *quality* policy that reads brilliantly in a log
 * and obstructs terribly in practice (v115 had to add MUTATIONS_ALL_REFUSED
 * because runs were COMPLETING on top of a refused write). Under YOLO the
 * governor advises; the model decides.
 */
export function authorityFor(action, { klass = "SMALL", enforce = true } = {}) {
  const a = String(action || ACTION.EXECUTE)
  const micro = MICRO_CLASS.has(klass)
  if (enforce === false) {
    const advisoryHalt = a === ACTION.STOP // closing a run is not a veto: it stays
    return {
      action: a,
      klass,
      hideWrites: false,
      halt: advisoryHalt,
      waitForUser: false,
      enforce: false,
      advisory: true,
      keep: null,
      forbidden: [],
      directive: directiveFor(a),
    }
  }
  const waitForUser = a === ACTION.ASK || a === ACTION.WAIT
  const halt = waitForUser || a === ACTION.STOP
  let hideWrites = false
  let keep = null
  let forbidden = []

  if (halt) {
    hideWrites = true
    keep = []
    forbidden = [...WRITE_TOOL_NAMES]
  } else if (a === ACTION.INSPECT || a === ACTION.SEARCH || a === ACTION.PLAN) {
    hideWrites = !micro
    if (!micro) { keep = INSPECT_KEEP; forbidden = [...WRITE_TOOL_NAMES] }
  } else if (a === ACTION.VERIFY || a === ACTION.REVIEW || a === ACTION.TEST || a === ACTION.EXPERIMENT) {
    hideWrites = !micro
    if (!micro) { keep = VERIFY_KEEP; forbidden = ["write_file", "edit_file", "multi_edit", "apply_patch"] }
  } else if (a === ACTION.REPLAN) {
    hideWrites = !micro
    if (!micro) { keep = INSPECT_KEEP; forbidden = ["write_file", "edit_file", "multi_edit", "apply_patch"] }
  }

  return {
    action: a,
    klass,
    hideWrites,
    halt,
    waitForUser,
    // v122: the enforced branch reports what it IS. v118 started surfacing
    // `lastAuth.enforce` in GOVERNOR_ACTION, the run's `governor:` report and
    // the AUTHORITY prompt line — and it always read false, because no branch
    // ever set the key. The flag now says what the owner decided in both
    // directions, so "was the veto armed?" is answerable from a log line.
    enforce: true,
    enforce: halt || (!micro && hideWrites),
    keep,
    forbidden,
    directive: directiveFor(a),
  }
}

export function isMutatingExternal(name) {
  const n = String(name || "")
  if (WRITE_TOOL_NAMES.includes(n)) return true
  if (!n.startsWith("mcp__")) return false
  const bare = n.split("__").pop() || n
  return /^(write|create|update|delete|push|commit|patch|edit|remove|insert|drop|destroy|publish|deploy|put|post)/i.test(bare)
}

export function maskToolDefs(defs, auth) {
  if (!Array.isArray(defs) || !auth?.enforce) return defs
  if (auth.waitForUser || auth.action === ACTION.STOP || auth.action === ACTION.WAIT) return []
  const keep = Array.isArray(auth.keep) ? new Set(auth.keep) : null
  const forbidden = new Set(auth.forbidden || [])
  const allow = new Set(auth.allow || [])
  return defs.filter((d) => {
    const name = d?.function?.name || d?.name
    if (!name) return true
    if (forbidden.has(name)) return false
    if (keep) {
      if (keep.has(name)) return true
      if (allow.has(name) && !isMutatingExternal(name)) return true
      return false
    }
    return true
  })
}

export function enforceToolCall(name, auth) {
  const n = String(name || "")
  if (!auth?.enforce) return { ok: true }
  if (auth.waitForUser || auth.action === ACTION.STOP || auth.action === ACTION.WAIT) {
    return { ok: false, reason: `BLOCKED: governor ${auth.action} — tools are frozen (${auth.directive})` }
  }
  if ((auth.forbidden || []).includes(n)) {
    return { ok: false, reason: `BLOCKED: governor ${auth.action} forbids ${n} — ${auth.directive}` }
  }
  if (Array.isArray(auth.keep) && auth.keep.length) {
    if (auth.keep.includes(n)) return { ok: true }
    if ((auth.allow || []).includes(n) && !isMutatingExternal(n)) return { ok: true }
    if (WRITE_TOOL_NAMES.includes(n) || isMutatingExternal(n)) {
      return { ok: false, reason: `BLOCKED: governor ${auth.action} forbids ${n} — ${auth.directive}` }
    }
    return { ok: false, reason: `BLOCKED: governor ${auth.action} forbids ${n} — ${auth.directive}` }
  }
  if (auth.hideWrites && isMutatingExternal(n)) {
    return { ok: false, reason: `BLOCKED: governor ${auth.action} forbids ${n} — ${auth.directive}` }
  }
  return { ok: true }
}

export function formatGovernorMessage(gov, auth) {
  const a = gov || {}
  const en = auth || authorityFor(a.action)
  return `${GOV_PREFIX} ${formatAction(a)}\nYou MUST follow this action this step. ${en.directive}`
}

/** Native → skill → MCP → generated → model. Printed, and the INSPECT
 *  keep-list already implements the first rung. */
export const CHEAPEST_FIRST = "native deterministic → existing skill → MCP → generated tool → model reasoning"

/**
 * Rank competing strategies by expected value: reversible and cheap first.
 * Confidence is never treated as evidence — it only breaks ties.
 */
/**
 * v121 deadwire — the stable identity of a strategy, for the outcome ledger.
 *
 * A strategy's `id` is positional (IH1, S2) and its `text` embeds the
 * objective, so one is too coarse to mean anything across tasks and the other
 * too fine to ever repeat. The key is the slug of what the strategy is FOR,
 * which is drawn from a fixed table and so recurs run after run.
 */
export function strategyKey(source = "") {
  return String(source ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    // 40, not an arbitrary cap: metalearn.recordStrategy truncates the id it
    // stores to 40 chars. A longer key would be WRITTEN truncated and READ in
    // full, so every lookup of a long goal would miss and the row would read
    // as "never tried" forever.
    .slice(0, 40)
    .replace(/-+$/, "") || ""
}

export function rankStrategies(list = [], { rates = null } = {}) {
  const map = rates && typeof rates === "object" ? rates : {}
  const rows = (Array.isArray(list) ? list : []).map((s, i) => {
    const reversible = s?.reversible !== false
    const cost = Math.max(0, Math.min(1, Number(s?.cost) || 0.5))
    const confidence = Math.max(0, Math.min(1, Number(s?.confidence) || 0.5))
    const blast = Math.max(0, Math.min(1, Number(s?.blast) || (reversible ? 0.2 : 0.7)))
    const id = s?.id || `S${i + 1}`
    const text = String(s?.text || s?.strategy || s?.label || "").slice(0, 200)
    // v121: the stable key first. `id` stays as a fallback so rows recorded
    // before v121 still read, and `text` stays for callers that pass a
    // recurring label rather than a per-task sentence.
    const key = s?.key ? String(s.key) : ""
    const rec = (key && map[key]) || map[id] || map[text] || null
    const n = rec?.samples || 0
    const rate = n >= 2 ? (Number(rec.ok || 0) / n) : null
    let ev = (reversible ? 0.35 : 0) + (1 - cost) * 0.25 + (1 - blast) * 0.15
    if (rate != null) ev += rate * 0.45 - (1 - rate) * 0.4
    else ev += confidence * 0.05
    return {
      id, key, text, reversible, cost, confidence, blast,
      expectedValue: Number(ev.toFixed(3)),
      measured: rate != null ? { samples: n, rate } : null,
    }
  })
  rows.sort((a, b) => b.expectedValue - a.expectedValue || a.id.localeCompare(b.id))
  return rows
}

