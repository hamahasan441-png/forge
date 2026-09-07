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
