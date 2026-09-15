/**
 * forge — the ONE authoritative whole-task completion gate (P0, zero deps).
 *
 * Before this module "the agent finished its turn" was treated as "the task is
 * done". A run whose DAG had five nodes could report COMPLETED after the first
 * one, because every completion path in meta.js asked a local question
 * ("did this segment error? do I have evidence?") and never the global one
 * ("is the graph actually finished?").
 *
 * There is now exactly one gate: canCompleteTask(). It verifies, in order:
 *
 *   1. validPlan                     the plan passed the validation pipeline
 *   2. validDAG                      the DAG is a well-formed, acyclic graph
 *   3. allRequiredNodesComplete      dag.allComplete() — canonical, never local
 *   4. allWorkersSettled             no worker is alive anywhere
 *   5. verificationSatisfied         evidence for the FINAL (recalculated) risk
 *   6. recoveryClear                 no unresolved recovery / drift
 *   7. noPendingRequiredActions      nothing the task must still do
 *   8. finalStateReconciled          expected effects == observed effects
 *   9. criticalPersistenceSucceeded  the terminal state actually reached disk
 *
 * Only when all nine hold may the controller emit COMPLETED. Otherwise the gate
 * returns the safe state to move to: WAITING, REPAIRING, RECOVERING, FAILED or
 * CANCELLED. It never returns COMPLETED on doubt, and it never throws — a gate
 * that can crash the controller would be bypassed the first time it did.
 */

import { allComplete, incompleteRequiredNodes, graphNodes, NODE_STATUS } from "./dag.js"

export const CHECK = {
  VALID_PLAN: "validPlan",
  VALID_DAG: "validDAG",
  ALL_REQUIRED_NODES_COMPLETE: "allRequiredNodesComplete",
  ALL_WORKERS_SETTLED: "allWorkersSettled",
  VERIFICATION_SATISFIED: "verificationSatisfied",
  RECOVERY_CLEAR: "recoveryClear",
  NO_PENDING_REQUIRED_ACTIONS: "noPendingRequiredActions",
  FINAL_STATE_RECONCILED: "finalStateReconciled",
  CRITICAL_PERSISTENCE_SUCCEEDED: "criticalPersistenceSucceeded",
}

export const ALL_CHECKS = Object.values(CHECK)

/** Safe, non-COMPLETED outcomes the gate may recommend. */
export const GATE_STATUS = {
  WAITING: "WAITING",
  REPAIRING: "REPAIRING",
  RECOVERING: "RECOVERING",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
}

/** Recovery recommendations that mean "do not proceed". */
const BLOCKING_RECOVERY = new Set(["ask_user", "abort", "inspect", "compensate", "resume_from_checkpoint"])

/**
 * v96 unifywise (§9 requirement traceability): the REQUIREMENT → WORK →
 * EVIDENCE chain, checked deterministically at the gate.
 *
 * engmemory ingests numbered/MUST/SHALL/NEVER lines of a long objective as
 * REQUIREMENT-layer records (R1..Rn) that "survive compaction" — but nothing
 * ever asked whether the work actually ADDRESSED each one. This function
 * closes that loop WITHOUT a second state store: it derives coverage from
 * what the run already has — completed DAG node objectives, changed files,
 * and verification evidence — and reports per-requirement status:
 *
 *   UNADDRESSED  nothing references it (gate blocker via required actions)
 *   IMPLEMENTED  a completed node's objective covers it
 *   TESTED       verification evidence mentions it (stronger than IMPLEMENTED)
 *
 * Pure, bounded (≤40 requirements × ≤12 tokens), never throws.
 */
export function requirementCoverage(requirements = [], { nodeObjectives = [], changedFiles = [], verificationEvidence = [] } = {}) {
  const sig = (t) => String(t ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 2 && !["the", "and", "for", "with", "that", "must", "shall", "should", "have", "are", "not", "any", "all"].includes(w))
    .slice(0, 12)
  const objectives = (Array.isArray(nodeObjectives) ? nodeObjectives : []).map(sig).filter((a) => a.length)
  const evidence = (Array.isArray(verificationEvidence) ? verificationEvidence : []).map((e) => sig(e)).filter((a) => a.length)
  const changed = new Set((Array.isArray(changedFiles) ? changedFiles : []).map((f) => String(f)))
  const out = []
  for (const r of (Array.isArray(requirements) ? requirements : []).slice(0, 40)) {
    const tokens = sig(r.text)
    if (!tokens.length) continue
    const files = Array.isArray(r.files) ? r.files : []
    const fileHit = files.some((f) => changed.has(String(f)))
    const tokenHit = (hay) => tokens.some((t) => hay.includes(t))
    let status = "UNADDRESSED"
    if (objectives.some(tokenHit) || fileHit) status = "IMPLEMENTED"
    if (evidence.some(tokenHit)) status = "TESTED" // evidence mention is the stronger signal either way
    out.push({ id: r.id ?? null, text: String(r.text ?? "").slice(0, 200), status, files })
  }
  const uncovered = out.filter((r) => r.status === "UNADDRESSED")
  return {
    total: out.length,
    covered: out.length - uncovered.length,
    uncovered,
    requirements: out,
    ok: uncovered.length === 0,
  }
}

function str(x) {
  return x == null ? "" : String(x)
}

/**
 * Evaluate the completion contract.
 *
 * @param {object} input
 * @param {boolean} [input.planValid]          plan passed validatePlan()
 * @param {string[]} [input.planErrors]
 * @param {object}  [input.dag]                live or serialized DAG
 * @param {boolean} [input.dagValid]           override for "is the DAG well formed"
 * @param {boolean} [input.workersSettled]     no worker alive (manager-driven)
 * @param {number}  [input.activeWorkers]      >0 means NOT settled
 * @param {object}  [input.verification]       ledger.status() result { ok, missing, anyFailure }
 * @param {boolean} [input.verificationRequired]
 * @param {object}  [input.recovery]           { recommended, drift, unverified } from recovery.js
 * @param {string[]} [input.pendingRequiredActions]
 * @param {boolean} [input.finalStateReconciled]
 * @param {boolean} [input.criticalPersistenceSucceeded]
 * @param {boolean} [input.cancelled]
 * @param {boolean} [input.repairBudgetRemaining]
 * @param {"ignore"|"block"|"allow"} [input.optionalPolicy]
 * @returns {{ ok: boolean, status: string, allowed: boolean, blockers: Array,
 *             checks: object, reasons: string[] }}
 */
export function canCompleteTask(input = {}) {
  const {
    planValid = true,
    planErrors = [],
    dag = null,
    dagValid = true,
    workersSettled = true,
    activeWorkers = 0,
    verification = null,
    verificationRequired = true,
    recovery = null,
    pendingRequiredActions = [],
    finalStateReconciled = true,
    criticalPersistenceSucceeded = true,
    cancelled = false,
    repairBudgetRemaining = true,
    optionalPolicy = "ignore",
    // a task with no graph has no proof anything was executed
    requireDAG = true,
  } = input

  const blockers = []
  const checks = {}
  const add = (name, ok, reason) => {
    checks[name] = ok === true
    if (ok !== true) blockers.push({ check: name, reason: str(reason) || `${name} failed` })
  }

  // --- 1. valid plan -------------------------------------------------------
  add(CHECK.VALID_PLAN, planValid === true, planErrors.length ? `plan invalid: ${planErrors.slice(0, 3).join("; ")}` : "plan invalid")

  // --- 2. valid DAG --------------------------------------------------------
  let dagWellFormed = dagValid === true
  if (dagWellFormed && requireDAG && !graphNodes(dag).length) {
    dagWellFormed = false
    add(CHECK.VALID_DAG, false, "no DAG — the plan was never turned into an executable graph")
  }
  if (dagWellFormed && dag) {
    try {
      const nodes = graphNodes(dag)
      const ids = new Set()
      for (const n of nodes) {
        if (!n || !n.id) { dagWellFormed = false; break }
        if (ids.has(n.id)) { dagWellFormed = false; break }
        ids.add(n.id)
        for (const d of n.dependencies ?? n.deps ?? []) {
          if (!ids.has(String(d)) && !nodes.some((m) => m.id === String(d))) { dagWellFormed = false; break }
        }
        if (!dagWellFormed) break
      }
    } catch {
      dagWellFormed = false
    }
  }
  add(CHECK.VALID_DAG, dagWellFormed, "DAG is not a well-formed graph")

  // --- 3. all required nodes complete (canonical, never local) --------------
  const nodesComplete = dag ? allComplete(dag, { optionalPolicy }) : true
  const unfinished = dag ? incompleteRequiredNodes(dag, { optionalPolicy }) : []
  add(
    CHECK.ALL_REQUIRED_NODES_COMPLETE,
    nodesComplete,
    unfinished.length
      ? `${unfinished.length} required DAG node(s) not complete: ${unfinished.slice(0, 6).map((n) => `${n.id}(${n.status ?? "?"})`).join(", ")}`
      : "no DAG nodes",
  )

  // --- 4. all workers settled ----------------------------------------------
  const settled = workersSettled === true && Number(activeWorkers) === 0
  add(CHECK.ALL_WORKERS_SETTLED, settled, `${Number(activeWorkers) || "?"} worker(s) still alive`)

  // --- 5. verification satisfied (for the FINAL risk) ----------------------
  let verificationOk = true
  if (verificationRequired) {
    if (!verification) verificationOk = false
    else if (verification.anyFailure === true) verificationOk = false
    else verificationOk = verification.ok === true
  }
  add(
    CHECK.VERIFICATION_SATISFIED,
    verificationOk,
    verification
      ? (verification.anyFailure ? `verification FAILED: ${str(verification.reason)}` : `verification missing: ${(verification.missing ?? []).join(", ")}`)
      : "no verification evidence at all",
  )

  // --- 6. recovery clear ----------------------------------------------------
  const recRecommended = str(recovery?.recommended)
  // The controller computes `clear` from REAL drift (a file the task said it
  // changed is gone, an operation ended with an unknown status, git is
  // mid-operation). When it does, that verdict is authoritative — the
  // recommendation string alone ("inspect" is also returned when there is
  // simply nothing to prove) must not freeze a healthy resume forever.
  const recClear = !recovery
    ? true
    : typeof recovery.clear === "boolean"
      ? recovery.clear
      : !BLOCKING_RECOVERY.has(recRecommended) && !Number(recovery.unverified > 0)
  add(CHECK.RECOVERY_CLEAR, recClear, `recovery unresolved (recommended=${recRecommended || "none"}${recovery?.unverified ? `, unverified=${recovery.unverified}` : ""})`)

  // --- 7. no pending required actions --------------------------------------
  const required = (pendingRequiredActions ?? []).filter(Boolean)
  add(CHECK.NO_PENDING_REQUIRED_ACTIONS, required.length === 0, `pending required action(s): ${required.slice(0, 3).join("; ")}`)

  // --- 8. final state reconciled -------------------------------------------
  add(CHECK.FINAL_STATE_RECONCILED, finalStateReconciled === true, "expected and observed effects disagree (drift)")

  // --- 9. critical persistence succeeded -----------------------------------
  add(CHECK.CRITICAL_PERSISTENCE_SUCCEEDED, criticalPersistenceSucceeded === true, "critical state was NOT persisted")

  const ok = blockers.length === 0
  return {
    ok,
    allowed: ok,
    status: ok ? "COMPLETED" : recommendStatus({ cancelled, blockers, dag, repairBudgetRemaining, verificationRequired }),
    blockers,
    checks,
    reasons: blockers.map((b) => b.reason),
  }
}

/**
 * Which safe state to fall back to. Deterministic and ordered:
 *   CANCELLED > RECOVERING > FAILED > REPAIRING > WAITING
 */
function recommendStatus({ cancelled, blockers, dag, repairBudgetRemaining, verificationRequired }) {
  const codes = new Set(blockers.map((b) => b.check))
  if (cancelled) return GATE_STATUS.CANCELLED
  if (codes.has(CHECK.RECOVERY_CLEAR) || codes.has(CHECK.FINAL_STATE_RECONCILED)) return GATE_STATUS.RECOVERING

  const nodes = graphNodes(dag)
  const anyFailed = nodes.some((n) => n?.status === NODE_STATUS.FAILED)
  const anyStalled = nodes.some((n) => [NODE_STATUS.BLOCKED, NODE_STATUS.PENDING].includes(n?.status))
  if (anyFailed && !repairBudgetRemaining) return GATE_STATUS.FAILED
  if (anyFailed) return GATE_STATUS.REPAIRING

  // verification missing/failed and we can still repair → REPAIRING, else WAITING
  if (verificationRequired && codes.has(CHECK.VERIFICATION_SATISFIED)) {
    return repairBudgetRemaining ? GATE_STATUS.REPAIRING : GATE_STATUS.WAITING
  }
  if (codes.has(CHECK.VALID_PLAN) || codes.has(CHECK.VALID_DAG)) {
    return repairBudgetRemaining ? GATE_STATUS.REPAIRING : GATE_STATUS.WAITING
  }
  if (anyStalled) return GATE_STATUS.WAITING
  return GATE_STATUS.WAITING
}

/**
 * §4 (gap fix) — the Fast Path shares the ONE completion contract.
 *
 * The direct agent (one-shot `forge agent`, chat `/agent` normal mode, plan
 * passes) has no DAG, so the whole-task gate's graph checks do not apply.
 * But it must not invent its OWN definition of completion either — this is
 * the same module, the same return shape, and the same invariant the whole-
 * task gate enforces: never COMPLETED on doubt, never COMPLETED because a
 * budget ran out. A fast-path run may only claim COMPLETED when the model
 * actually produced a final answer, nothing errored, and the run's evidence
 * (tool log + ordered command checks) survived to be reported.
 */
export const FAST_PATH_CHECK = {
  FINAL_ANSWER_PRESENT: "finalAnswerPresent",
  NO_ERROR: "noError",
  NOT_BUDGET_EXHAUSTED: "notBudgetExhausted",
  EVIDENCE_PRESERVED: "evidencePreserved",
  // v101 P4 — opt-in (config.agent.requireVerification). OFF by default:
  // plenty of honest runs change a file in a repo that has no command to run,
  // and turning those into INCOMPLETE would be a lie in the other direction.
  WRITES_VERIFIED: "writesVerified",
}

export const FAST_PATH_STATUS = {
  INCOMPLETE: "INCOMPLETE",   // budget/resource exhaustion — never completion
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
}

/**
 * v101 P4 — which of this run's writes no passing check ever covered.
 *
 * The ordering data has been collected since v21.1 and used only to detect
 * STALE evidence ("tests passed, THEN the agent edited src/x.js"). The same
 * two numbers answer a question nobody was asking: which files were changed
 * and never checked at all. A check records `writeIndex` = how many writes
 * preceded it, so every write at or after the LAST PASSING check's index is
 * uncovered — by exactly the staleness rule already in use, not a new one.
 *
 * Returns plain data. It decides nothing; callers decide what to do with it.
 */
export function unverifiedWrites({ writesSoFar = [], commandChecks = [] } = {}) {
  const writes = Array.isArray(writesSoFar) ? writesSoFar : []
  const checks = Array.isArray(commandChecks) ? commandChecks : []
  const passing = checks.filter((c) => c?.passed === true)
  // -1 → no passing check at all, so every write is uncovered
  const lastPassingIndex = passing.reduce((max, c) => Math.max(max, Number(c.writeIndex) || 0), passing.length ? 0 : -1)
  const uncovered = lastPassingIndex < 0 ? writes.slice() : writes.slice(lastPassingIndex)
  const dedup = (a) => [...new Set(a.filter(Boolean))]
  return {
    wrote: dedup(writes),
    unverified: dedup(uncovered),
    covered: dedup(lastPassingIndex < 0 ? [] : writes.slice(0, lastPassingIndex)),
    checksRun: checks.length,
    checksPassing: passing.length,
  }
}

/**
 * Evaluate the fast-path completion contract. Same shape as canCompleteTask
 * ({ ok, status, blockers, checks, reasons }) so every consumer of a run
 * result reads ONE shape from ONE module.
 */
export function canCompleteFastPath({ finalText = "", error = null, budgetHit = false, cancelled = false, toolLog = null, commandChecks = null, unverified = null, requireVerification = false } = {}) {
  const blockers = []
  const checks = {}
  const add = (name, ok, reason) => {
    checks[name] = ok === true
    if (ok !== true) blockers.push({ check: name, reason })
  }

  const answer = String(finalText ?? "").trim()
  // a fabricated placeholder is not an answer — budget-exhaustion text is
  // supplied by the caller only AFTER this gate decides, never before
  add(FAST_PATH_CHECK.FINAL_ANSWER_PRESENT, answer.length > 0, "no final answer was produced")
  add(FAST_PATH_CHECK.NO_ERROR, !error, String(error ?? "") || "run errored")
  add(FAST_PATH_CHECK.NOT_BUDGET_EXHAUSTED, budgetHit !== true, "step budget exhausted before a final answer")
  add(FAST_PATH_CHECK.EVIDENCE_PRESERVED, Array.isArray(toolLog) && Array.isArray(commandChecks), "run evidence (tool log / command checks) missing")
  // Opt-in only. When it is off the result is byte-for-byte what it was
  // before this check existed — the files are still REPORTED either way, so
  // the caller can see the gap without the gate deciding for them.
  const uncovered = Array.isArray(unverified) ? unverified.filter(Boolean) : []
  if (requireVerification === true) {
    add(FAST_PATH_CHECK.WRITES_VERIFIED, uncovered.length === 0,
      `${uncovered.length} file(s) changed with no passing check covering them: ${uncovered.slice(0, 5).join(", ")}`)
  }

  const ok = blockers.length === 0
  let status = "COMPLETED"
  if (!ok) {
    if (cancelled) status = FAST_PATH_STATUS.CANCELLED
    else if (error) status = FAST_PATH_STATUS.FAILED
    else status = FAST_PATH_STATUS.INCOMPLETE
  }
  // NB: no extra key. test-v93g pins that this result has exactly the shape of
  // canCompleteTask — one shape from one module — and the unverified FILES are
  // reported on the run result (`verification`), which is where data belongs.
  // The gate returns a verdict.
  return { ok, allowed: ok, status, blockers, checks, reasons: blockers.map((b) => b.reason) }
}

/**
 * Convenience: the DAG part of the gate only — "is the graph finished?".
 * Every non-DAG check is disabled so callers can reason about the graph in
 * isolation (verification, workers and persistence are the controller's job).
 */
export function canCompleteDAG(dag, { optionalPolicy = "ignore" } = {}) {
  return canCompleteTask({
    dag,
    optionalPolicy,
    planValid: true,
    verificationRequired: false,
    workersSettled: true,
    activeWorkers: 0,
    finalStateReconciled: true,
    criticalPersistenceSucceeded: true,
    requireDAG: true,
  })
}
