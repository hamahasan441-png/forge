/**
 * forge — DAG planner (v21 hardened, zero dependencies)
 *
 * Before v21 planning was a flat numbered list (plans.js) and the model drove
 * a single sequential tool loop. A real task is a dependency graph: research
 * can fan out to independent read-only workers, and two mutating nodes that
 * touch the same file must never run concurrently.
 *
 * This module is the pure graph: nodes, edges, readiness, scheduling, failure
 * propagation and recomputation. It executes NOTHING — the meta controller
 * walks it, the agent manager schedules the workers and the security gate
 * still guards every tool. The graph is plain JSON so it survives a process
 * interruption inside the task record.
 *
 * Hardening (v23):
 *  - canonical conflict-key implementation: file:<path>, symbol:<symbol>,
 *    dir:<path>, resource:<lock>, with conservative node-specific lock fallback
 *  - exact node identity: executeNode(nodeId) deterministic, markCompleted(nodeId)
 *  - attributeSegment remains only as diagnostic fallback
 *  - verification scoped to node
 *  - plan validation pipeline: schema, dependency, target, conflict, verification
 *  - adaptive DAG support with validated, deterministic, auditable updates
 *
 * Node status: pending → ready → running → completed
 *                       │          │
 *                       └→ blocked └→ failed / cancelled
 */

export const NODE_STATUS = {
  PENDING: "pending",
  READY: "ready",
  RUNNING: "running",
  // P0: execution success and node completion are NOT the same state.
  //   RUNNING → EXECUTION_SUCCEEDED → VERIFYING → COMPLETED
  //                                             └→ REPAIRING → VERIFYING
  EXECUTION_SUCCEEDED: "execution_succeeded",
  VERIFYING: "verifying",
  REPAIRING: "repairing",
  COMPLETED: "completed",
  FAILED: "failed",
  BLOCKED: "blocked",
  CANCELLED: "cancelled",
}

/** Statuses that mean "the node is not finished yet" for the completion gate. */
export const UNFINISHED_STATUS = new Set([
  NODE_STATUS.PENDING,
  NODE_STATUS.READY,
  NODE_STATUS.RUNNING,
  NODE_STATUS.EXECUTION_SUCCEEDED,
  NODE_STATUS.VERIFYING,
  NODE_STATUS.REPAIRING,
  NODE_STATUS.BLOCKED,
])

const STATUSES = new Set(Object.values(NODE_STATUS))
export const RISK_LEVELS = ["low", "medium", "high", "critical"]

function normalizeNode(n) {
  if (!n || typeof n !== "object") throw new Error("dag node must be an object")
  const id = String(n.id ?? "").trim()
  if (!id) throw new Error("dag node requires an id")
  const status = STATUSES.has(n.status) ? n.status : NODE_STATUS.PENDING
  return {
    id,
    objective: String(n.objective ?? n.title ?? "").slice(0, 600),
    dependencies: [...new Set((n.dependencies ?? n.deps ?? []).map(String))],
    status,
    priority: Number.isFinite(Number(n.priority)) ? Number(n.priority) : 0,
    risk: RISK_LEVELS.includes(n.risk) ? n.risk : "low",
    estimated_cost: Number.isFinite(Number(n.estimated_cost)) ? Number(n.estimated_cost) : 1,
    required_capabilities: Array.isArray(n.required_capabilities) ? n.required_capabilities.map(String) : [],
    role: n.role ?? null,
    read_only: n.read_only ?? false,
    targetFiles: Array.isArray(n.targetFiles) ? n.targetFiles.map(String) : (Array.isArray(n.target_files) ? n.target_files.map(String) : []),
    targetSymbols: Array.isArray(n.targetSymbols) ? n.targetSymbols.map(String) : (Array.isArray(n.target_symbols) ? n.target_symbols.map(String) : []),
    targetDirs: Array.isArray(n.targetDirs) ? n.targetDirs.map(String) : (Array.isArray(n.target_dirs) ? n.target_dirs.map(String) : []),
    resourceLocks: Array.isArray(n.resourceLocks) ? n.resourceLocks.map(String) : (Array.isArray(n.resource_locks) ? n.resource_locks.map(String) : []),
    verificationRequirements: Array.isArray(n.verificationRequirements) ? n.verificationRequirements.map(String) : (Array.isArray(n.verification_requirements) ? n.verification_requirements.map(String) : []),
    result: n.result ?? null,
    started_at: n.started_at ?? null,
    ended_at: n.ended_at ?? null,
    attempts: n.attempts ?? 0,
    error: n.error ?? null,
    // exact crash/resume + verification scoping
    taskId: n.taskId ?? n.task_id ?? null,
    runId: n.runId ?? n.run_id ?? null,
    segmentId: n.segmentId ?? n.segment_id ?? null,
    verificationEpoch: n.verificationEpoch ?? n.verification_epoch ?? 0,
    affectedFiles: Array.isArray(n.affectedFiles) ? n.affectedFiles : [],
    // P0 verification gate: a node is only COMPLETED when its required
    // verification passed. `optional` nodes may be skipped from the whole-DAG
    // completion gate by policy (see allComplete / canCompleteTask).
    verificationSatisfied: n.verificationSatisfied ?? n.verification_satisfied ?? null,
    verificationId: n.verificationId ?? n.verification_id ?? null,
    optional: n.optional === true || n.optional === "true",
    // adaptive-DAG provenance (P1): every generated node records why it exists
    createdBy: n.createdBy ?? n.created_by ?? null,
    createdReason: n.createdReason ?? n.created_reason ?? null,
    createdEvidence: n.createdEvidence ?? n.created_evidence ?? null,
    parentNode: n.parentNode ?? n.parent_node ?? null,
  }
}

/** Did this node's required verification pass? `null` = never verified. */
export function verificationSatisfied(node) {
  if (!node) return null
  if (node.verificationSatisfied === true) return true
  if (node.verificationSatisfied === false) return false
  return node.verification_satisfied === true ? true : node.verification_satisfied === false ? false : null
}

/** Put a node back into repair after a failed verification. */
export function markRepairing(graph, id, reason = null) {
  const n = graph.nodes.get(id)
  if (!n) return false
  if (n.status === NODE_STATUS.COMPLETED || n.status === NODE_STATUS.CANCELLED) return false
  n.status = NODE_STATUS.REPAIRING
  n.repair_reason = reason == null ? n.repair_reason : String(reason).slice(0, 400)
  n.verificationSatisfied = false
  return true
}

export function buildDAG(nodeDefs = []) {
  const nodes = new Map()
  for (const def of nodeDefs) {
    const n = normalizeNode(def)
    if (nodes.has(n.id)) throw new Error(`duplicate dag node id: ${n.id}`)
    nodes.set(n.id, n)
  }
  for (const n of nodes.values()) {
    for (const d of n.dependencies) {
      if (!nodes.has(d)) throw new Error(`node ${n.id} depends on unknown node ${d}`)
    }
  }
  const order = topoSort(nodes)
  for (const n of nodes.values()) if (!n.dependencies.length && n.status === NODE_STATUS.PENDING) n.status = NODE_STATUS.READY
  return { nodes, order }
}

export function topoSort(nodes) {
  const indeg = new Map()
  const dependents = new Map()
  for (const id of nodes.keys()) { indeg.set(id, 0); dependents.set(id, []) }
  for (const n of nodes.values()) {
    indeg.set(n.id, n.dependencies.length)
    for (const d of n.dependencies) dependents.get(d).push(n.id)
  }
  const ready = [...nodes.values()]
    .filter((n) => n.dependencies.length === 0)
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .map((n) => n.id)
  const out = []
  while (ready.length) {
    const id = ready.shift()
    out.push(id)
    for (const dep of dependents.get(id) ?? []) {
      indeg.set(dep, indeg.get(dep) - 1)
      if (indeg.get(dep) === 0) {
        const node = nodes.get(dep)
        const idx = ready.findIndex((r) => {
          const rn = nodes.get(r)
          return rn.priority < node.priority || (rn.priority === node.priority && rn.id.localeCompare(node.id) > 0)
        })
        if (idx === -1) ready.push(dep)
        else ready.splice(idx, 0, dep)
      }
    }
  }
  if (out.length !== nodes.size) {
    const cyc = [...nodes.keys()].filter((id) => !out.includes(id))
    throw new Error(`dag has a cycle involving: ${cyc.join(", ")}`)
  }
  return out
}

export function serializeDAG(graph) {
  return { order: graph.order, nodes: graph.order.map((id) => graph.nodes.get(id)) }
}

export function deserializeDAG(data) {
  try {
    if (!data || !Array.isArray(data.nodes)) return null
    const graph = buildDAG(data.nodes)
    return graph
  } catch { return null }
}

export function readyNodes(graph) {
  return graph.order
    .map((id) => graph.nodes.get(id))
    .filter((n) => n.status === NODE_STATUS.READY)
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
}

/**
 * Canonical conflict-key implementation (P0).
 * Sources: targetFiles, targetSymbols, targetDirs, resourceLocks
 * Keys: file:<path>, symbol:<symbol>, dir:<path>, resource:<lock>
 * If no explicit conflict info, use conservative node-specific lock.
 * Never use conflictKeys: () => [] for real execution.
 */
export function canonicalConflictKeys(node) {
  if (!node || typeof node !== "object") return ["node:unknown"]
  // an EXPLICIT lock declaration wins — but an empty one is a lie and is
  // rejected by validatePlan (CONFLICTS), never silently ignored.
  if (Array.isArray(node.conflictKeys) && node.conflictKeys.length) {
    return [...new Set(node.conflictKeys.map((k) => String(k).trim()).filter(Boolean))]
  }
  const keys = []
  const files = Array.isArray(node.targetFiles) ? node.targetFiles : []
  const symbols = Array.isArray(node.targetSymbols) ? node.targetSymbols : []
  const dirs = Array.isArray(node.targetDirs) ? node.targetDirs : []
  const locks = Array.isArray(node.resourceLocks) ? node.resourceLocks : []

  for (const f of files) {
    const p = String(f).trim()
    if (p) keys.push(`file:${p}`)
  }
  for (const s of symbols) {
    const sym = String(s).trim()
    if (sym) keys.push(`symbol:${sym}`)
  }
  for (const d of dirs) {
    const dir = String(d).trim()
    if (dir) keys.push(`dir:${dir}`)
  }
  for (const l of locks) {
    const lock = String(l).trim()
    if (lock) keys.push(`resource:${lock}`)
  }

  // Conservative fallback: node-specific lock ensures no two "empty" nodes run concurrently as mutators
  if (!keys.length) {
    return [`node:${String(node.id ?? "unknown")}`]
  }
  return [...new Set(keys)]
}

/**
 * Exact DAG node identity execution (P0).
 * executeNode(nodeId) deterministic, returns node or null.
 * Replaces heuristic attributeSegment with explicit node operation.
 */
export function executeNode(graph, nodeId, { taskId = null, runId = null, segmentId = null } = {}) {
  if (!graph || !nodeId) return null
  const n = graph.nodes.get(String(nodeId))
  if (!n) return null
  if (n.status !== NODE_STATUS.READY) return null
  n.status = NODE_STATUS.RUNNING
  n.started_at = n.started_at ?? Date.now()
  n.attempts++
  if (taskId) n.taskId = taskId
  if (runId) n.runId = runId
  if (segmentId) n.segmentId = segmentId
  return n
}

/** Compatibility wrapper for existing callers that used markRunning. */
export function markRunning(graph, id) {
  const n = graph.nodes.get(id)
  if (!n || n.status !== NODE_STATUS.READY) return false
  n.status = NODE_STATUS.RUNNING
  n.started_at = n.started_at ?? Date.now()
  n.attempts++
  return true
}

/**
 * P0 — execution success is NOT node completion.
 *
 * The agent's tools all ran without error ⇒ EXECUTION_SUCCEEDED. The node is
 * still UNFINISHED: the *requested outcome* has not been verified yet. Only
 * markCompleted()/markVerified() below may set COMPLETED, and both require
 * evidence (see the `requireVerification` guard).
 */
export function markExecutionSucceeded(graph, id, result = null) {
  const n = graph.nodes.get(id)
  if (!n) return false
  if (![NODE_STATUS.RUNNING, NODE_STATUS.EXECUTION_SUCCEEDED, NODE_STATUS.REPAIRING].includes(n.status)) return false
  n.status = NODE_STATUS.EXECUTION_SUCCEEDED
  n.result = result == null ? n.result : String(result).slice(0, 2000)
  n.execution_succeeded_at = n.execution_succeeded_at ?? Date.now()
  n.verificationSatisfied = false
  return true
}

/** Move a node into verification. Idempotent. */
export function markVerifying(graph, id) {
  const n = graph.nodes.get(id)
  if (!n) return false
  if (n.status === NODE_STATUS.COMPLETED || n.status === NODE_STATUS.FAILED || n.status === NODE_STATUS.CANCELLED) return false
  n.status = NODE_STATUS.VERIFYING
  return true
}

/**
 * Sentinel for "this node has no verification requirement".
 *
 * A read-only investigation node does not mutate an artifact, so there is
 * nothing to verify beyond the worker having settled with a result. Passing
 * this sentinel records WHY completion was allowed (auditable) instead of
 * silently skipping the gate.
 */
export const VERIFICATION_NOT_REQUIRED = "NOT_REQUIRED"

/**
 * The ONE authoritative way to finish a node.
 *
 * `requireVerification` (default TRUE) is the gate: a node may only reach
 * COMPLETED when its required verification passed. Verifiers pass the evidence
 * (a ledger record, or the VERIFICATION_NOT_REQUIRED sentinel) so every
 * completion is auditable after the fact.
 */
export function markCompleted(graph, id, result = null, { requireVerification = true, verification = null, evidence = null } = {}) {
  const n = graph.nodes.get(id)
  if (!n) return false
  const verified = verification != null && verification !== false
  if (requireVerification && verificationSatisfied(n) !== true && !verified) return false
  if (verified) {
    n.verificationSatisfied = true
    if (verification === VERIFICATION_NOT_REQUIRED) {
      n.verificationId = VERIFICATION_NOT_REQUIRED
      n.verificationMode = "not_required"
    } else if (typeof verification === "string") {
      n.verificationId = verification
      n.verificationMode = "record"
    } else {
      n.verificationId = verification.verification_id ?? verification.id ?? null
      n.verificationEpoch = Number(verification.verificationEpoch ?? verification.verification_epoch ?? n.verificationEpoch ?? 0) || n.verificationEpoch
      n.verificationMode = "record"
    }
  } else {
    n.verificationSatisfied = n.verificationSatisfied ?? null
  }
  if (evidence) n.evidence = String(evidence).slice(0, 1000)
  n.status = NODE_STATUS.COMPLETED
  n.ended_at = Date.now()
  n.result = result == null ? n.result : String(result).slice(0, 2000)
  n.verificationEpoch = (n.verificationEpoch ?? 0) + 1
  for (const m of graph.nodes.values()) {
    if (m.status !== NODE_STATUS.PENDING && m.status !== NODE_STATUS.BLOCKED) continue
    if (m.dependencies.includes(id) && depsSatisfied(graph, m)) m.status = NODE_STATUS.READY
  }
  return true
}

export function markFailed(graph, id, error = null) {
  const n = graph.nodes.get(id)
  if (!n) return []
  n.status = NODE_STATUS.FAILED
  n.ended_at = Date.now()
  n.error = error == null ? n.error : String(error).slice(0, 500)
  return recomputeDownstream(graph, id)
}

export function markCancelled(graph, id, { cascade = true } = {}) {
  const n = graph.nodes.get(id)
  if (!n) return []
  n.status = NODE_STATUS.CANCELLED
  n.ended_at = Date.now()
  const cancelled = [id]
  if (cascade) {
    for (const m of graph.nodes.values()) {
      if (m.status === NODE_STATUS.PENDING && m.dependencies.some((d) => cancelled.includes(d))) {
        const dead = m.dependencies.every((d) => {
          const dn = graph.nodes.get(d)
          return dn && [NODE_STATUS.CANCELLED, NODE_STATUS.FAILED].includes(dn.status)
        })
        if (dead) { m.status = NODE_STATUS.CANCELLED; m.ended_at = Date.now(); cancelled.push(m.id) }
        else m.status = NODE_STATUS.BLOCKED
      }
    }
  }
  return cancelled
}

export function retryNode(graph, id) {
  const n = graph.nodes.get(id)
  if (!n) return false
  if (![NODE_STATUS.FAILED, NODE_STATUS.BLOCKED, NODE_STATUS.REPAIRING, NODE_STATUS.VERIFYING, NODE_STATUS.EXECUTION_SUCCEEDED].includes(n.status)) return false
  n.status = depsSatisfied(graph, n) ? NODE_STATUS.READY : NODE_STATUS.PENDING
  n.error = null
  n.verificationSatisfied = false
  return true
}

export function recomputeDownstream(graph, id) {
  const affected = []
  for (const m of graph.nodes.values()) {
    if (!m.dependencies.includes(id)) continue
    if (m.status === NODE_STATUS.PENDING) { m.status = NODE_STATUS.BLOCKED; affected.push(m.id) }
    else if (m.status === NODE_STATUS.READY || m.status === NODE_STATUS.RUNNING) affected.push(m.id)
  }
  return affected
}

function depsSatisfied(graph, n) {
  return n.dependencies.every((d) => graph.nodes.get(d)?.status === NODE_STATUS.COMPLETED)
}

export function dagStats(graph) {
  const s = {
    total: 0, completed: 0, failed: 0, running: 0, ready: 0, blocked: 0, pending: 0, cancelled: 0,
    execution_succeeded: 0, verifying: 0, repairing: 0,
  }
  for (const n of graph.nodes.values()) {
    s.total++
    s[n.status] = (s[n.status] ?? 0) + 1
  }
  return s
}

/**
 * Nodes eligible to run CONCURRENTLY: ready, read-only, no conflicting targets.
 * Uses canonical conflict keys by default, never empty.
 * Mutating nodes are always returned one at a time (serialized).
 * v27: default maxParallel is 8 (ARCH / high-tier ceiling); callers pass a smaller class cap.
 */
export function scheduleBatch(graph, { maxParallel = 8, conflictKeys = canonicalConflictKeys } = {}) {
  const ready = readyNodes(graph)
  if (!ready.length) return []
  const batch = []
  const heldLocks = new Set()
  for (const n of ready) {
    let keys
    try {
      keys = conflictKeys(n)
      if (!Array.isArray(keys) || !keys.length) keys = canonicalConflictKeys(n)
    } catch {
      keys = canonicalConflictKeys(n)
    }
    const locks = new Set(keys.map(String))
    let conflicts = false
    for (const l of locks) if (heldLocks.has(l)) { conflicts = true; break }
    if (n.read_only && !conflicts) {
      batch.push(n)
      for (const l of locks) heldLocks.add(l)
      if (batch.length >= maxParallel) break
      continue
    }
    if (batch.length === 0 && !conflicts) {
      batch.push(n)
      break
    }
  }
  return batch
}

/**
 * CANONICAL "all required nodes completed" check (P0).
 *
 * The completion gate and every caller must use this instead of re-deriving
 * incompleteness locally — duplicated logic is how "1 of 3 nodes done" used to
 * be reported as a finished task.
 *
 * Semantics:
 *   - CANCELLED nodes are skipped (a cancelled node cannot block the task).
 *   - Optional nodes are policy-dependent: `optionalPolicy: "ignore"` (default)
 *     skips them, "block" requires them, "allow" treats them as satisfied.
 *   - Every other status — including RUNNING, EXECUTION_SUCCEEDED, VERIFYING
 *     and REPAIRING — is NOT complete. Execution success is not completion.
 *
 * Works with both a live graph ({ nodes: Map, order: [] }) and a serialized
 * one ({ nodes: [ …nodeObjects ] }), so the gate can judge a task record it
 * just loaded from disk without rehydrating it.
 */
export function allComplete(graph, { optionalPolicy = "ignore" } = {}) {
  const nodes = graphNodes(graph)
  if (!nodes.length) return false
  for (const n of nodes) {
    if (n.status === NODE_STATUS.CANCELLED) continue
    if (n.status === NODE_STATUS.COMPLETED) continue
    if (isOptional(n)) {
      if (optionalPolicy === "ignore" || optionalPolicy === "allow") continue
    }
    return false
  }
  return true
}

/** Nodes that are required (not optional, not cancelled) and not completed. */
export function incompleteRequiredNodes(graph, { optionalPolicy = "ignore" } = {}) {
  return graphNodes(graph).filter((n) => {
    if (n.status === NODE_STATUS.CANCELLED) return false
    if (n.status === NODE_STATUS.COMPLETED) return false
    if (isOptional(n) && optionalPolicy !== "block") return false
    return true
  })
}

function isOptional(n) {
  return n?.optional === true || n?.optional === "true"
}

/** Accept a live graph, a serialized graph, or a plain array of nodes. */
export function graphNodes(graph) {
  if (!graph) return []
  if (Array.isArray(graph.nodes)) return graph.nodes
  if (graph.nodes instanceof Map) return [...graph.nodes.values()]
  if (Array.isArray(graph)) return graph
  return []
}

export function isStalled(graph) {
  if (readyNodes(graph).length) return false
  for (const n of graph.nodes.values()) {
    if (n.status === NODE_STATUS.RUNNING) return false
  }
  for (const n of graph.nodes.values()) {
    if ([NODE_STATUS.FAILED, NODE_STATUS.BLOCKED, NODE_STATUS.PENDING].includes(n.status)) {
      for (const m of graph.nodes.values()) {
        if (m.dependencies.includes(n.id) && [NODE_STATUS.BLOCKED, NODE_STATUS.PENDING, NODE_STATUS.READY].includes(m.status)) return true
      }
      if (n.status === NODE_STATUS.FAILED) return true
    }
  }
  return false
}

/** Conflict-key prefixes that are canonical. */
const CONFLICT_PREFIXES = new Set(["file:", "symbol:", "dir:", "resource:", "node:"])

/** Paths a plan is never allowed to target. */
const FORBIDDEN_TARGET = /(^|\/)(etc|usr|bin|sbin|boot|sys|proc|dev)(\/|$)|\0/

function canonicalConflicts(n) {
  return canonicalConflictKeys({
    id: n?.id,
    conflictKeys: n?.conflictKeys ?? null,
    targetFiles: n?.targetFiles ?? n?.target_files ?? [],
    targetSymbols: n?.targetSymbols ?? n?.target_symbols ?? [],
    targetDirs: n?.targetDirs ?? n?.target_dirs ?? [],
    resourceLocks: n?.resourceLocks ?? n?.resource_locks ?? [],
  })
}

/**
 * Plan validation pipeline (P0):
 * USER TASK → INTENT → PLAN → SCHEMA → DEPENDENCIES → TARGETS → CONFLICTS
 * → VERIFICATION PLAN → DAG → EXECUTION
 *
 * Failure ⇒ REPAIR (repairPlan) or WAITING. It must never be possible for an
 * invalid plan to reach execution by falling through — which is what used to
 * happen: the controller logged "plan validation failed" and then executed the
 * same unrepaired plan.
 *
 * `stage` says which stage rejected the plan; `recoverable` says whether
 * repairPlan() can plausibly fix it (a cycle is repairable by dropping the
 * offending edge; a plan that is not an object is not).
 */
export function validatePlan(planDefs = []) {
  const errors = []
  // per-stage observability: which stage failed is as important as the fact
  // that it failed — the controller logs it and the operator can see it.
  const stages = { SCHEMA: "skipped", DEPENDENCIES: "skipped", TARGETS: "skipped", CONFLICTS: "skipped", VERIFICATION: "skipped" }
  const pass = (stage) => { if (stages[stage] === "skipped") stages[stage] = "passed" }
  const fail = (stage, code, recoverable, list) => {
    stages[stage] = "failed"
    return { ok: false, stage, code, recoverable, errors: list, stages: { ...stages } }
  }

  if (!Array.isArray(planDefs)) return fail("SCHEMA", "SCHEMA_FAILED", false, ["plan must be an array"])
  if (!planDefs.length) return fail("SCHEMA", "EMPTY_PLAN", true, ["plan is empty"])

  // ---- 1. SCHEMA ---------------------------------------------------------
  const schemaErrors = []
  for (let i = 0; i < planDefs.length; i++) {
    const n = planDefs[i]
    if (!n || typeof n !== "object") { schemaErrors.push(`node ${i} must be an object`); continue }
    if (!n.id && !n.objective && !n.title && !n.task) schemaErrors.push(`node ${i} missing id/objective`)
    if (n.id != null && typeof n.id !== "string") schemaErrors.push(`node ${i} id must be a string`)
    for (const k of ["dependencies", "deps"]) {
      if (n[k] != null && !Array.isArray(n[k])) schemaErrors.push(`node ${n.id ?? i} ${k} must be an array`)
    }
    if (n.risk != null && !RISK_LEVELS.includes(n.risk)) schemaErrors.push(`node ${n.id ?? i} has invalid risk "${n.risk}"`)
  }
  if (schemaErrors.length) return fail("SCHEMA", "SCHEMA_FAILED", true, schemaErrors)
  pass("SCHEMA")

  // ---- 2. DEPENDENCIES ---------------------------------------------------
  const depErrors = []
  const ids = new Set()
  for (const def of planDefs) {
    const id = String(def.id ?? "")
    if (!id) { depErrors.push("a node has no id"); continue }
    if (ids.has(id)) depErrors.push(`duplicate node id: ${id}`)
    ids.add(id)
  }
  for (const n of planDefs) {
    const id = String(n.id ?? "")
    for (const d of n.dependencies ?? n.deps ?? []) {
      const dep = String(d)
      if (dep === id) { depErrors.push(`node ${id} depends on itself`); continue }
      if (!ids.has(dep)) depErrors.push(`node ${id} depends on unknown node ${dep}`)
    }
  }
  if (!depErrors.length) {
    try { buildDAG(planDefs) } catch (e) { depErrors.push(String(e.message)) }
  }
  if (depErrors.length) {
    const cyclic = depErrors.some((e) => /cycle/i.test(e))
    return fail("DEPENDENCIES", cyclic ? "CYCLE_DETECTED" : "DEPENDENCY_FAILED", true, depErrors)
  }
  pass("SCHEMA"); pass("DEPENDENCIES")

  // ---- 3. TARGETS --------------------------------------------------------
  const targetErrors = []
  for (const n of planDefs) {
    for (const key of ["targetFiles", "target_files", "targetSymbols", "target_symbols", "targetDirs", "target_dirs", "resourceLocks", "resource_locks"]) {
      const list = n[key]
      if (list == null) continue
      if (!Array.isArray(list)) { targetErrors.push(`node ${n.id} ${key} must be an array`); continue }
      for (const v of list) {
        if (typeof v !== "string" || !v.trim()) { targetErrors.push(`node ${n.id} has an empty/non-string entry in ${key}`); continue }
        if (key.startsWith("target")) {
          if (v.includes("\0")) targetErrors.push(`node ${n.id} target ${key} contains NUL`)
          if (FORBIDDEN_TARGET.test(v)) targetErrors.push(`node ${n.id} targets a system path: ${v}`)
          if (/(^|\/)\.\.(\/|$)/.test(v)) targetErrors.push(`node ${n.id} target escapes the project: ${v}`)
          if (pathIsAbsolute(v)) targetErrors.push(`node ${n.id} target is an absolute path: ${v}`)
        }
      }
    }
  }
  if (targetErrors.length) return fail("TARGETS", "TARGET_FAILED", true, targetErrors)
  pass("SCHEMA"); pass("DEPENDENCIES"); pass("TARGETS")

  // ---- 4. CONFLICTS ------------------------------------------------------
  const conflictErrors = []
  for (const n of planDefs) {
    for (const key of canonicalConflicts(n)) {
      const [prefix] = String(key).split(":")
      if (!CONFLICT_PREFIXES.has(prefix + ":")) conflictErrors.push(`node ${n.id} has an unrecognised conflict key "${key}"`)
    }
    // a mutating node whose only lock is the conservative node lock is fine,
    // but an explicit empty-key declaration is a lie we must not accept
    if (n.conflictKeys !== undefined && Array.isArray(n.conflictKeys) && n.conflictKeys.length === 0) {
      conflictErrors.push(`node ${n.id} declares empty conflictKeys — conflict detection would be disabled`)
    }
  }
  if (conflictErrors.length) return fail("CONFLICTS", "CONFLICT_FAILED", true, conflictErrors)
  pass("SCHEMA"); pass("DEPENDENCIES"); pass("TARGETS"); pass("CONFLICTS")

  // ---- 5. VERIFICATION PLAN ---------------------------------------------
  const verifyErrors = []
  for (const n of planDefs) {
    const mutating = n.read_only !== true
    const reqs = n.verificationRequirements ?? n.verification_requirements ?? []
    if (mutating && (!Array.isArray(reqs) || reqs.length === 0)) {
      verifyErrors.push(`node ${n.id} mutates but declares no verification requirement`)
    }
    if (Array.isArray(reqs) && reqs.some((r) => typeof r !== "string" || !String(r).trim())) {
      verifyErrors.push(`node ${n.id} has an empty/non-string verification requirement`)
    }
  }
  if (verifyErrors.length) return fail("VERIFICATION", "VERIFICATION_PLAN_FAILED", true, verifyErrors)
  for (const k of Object.keys(stages)) pass(k)

  return { ok: true, errors: [], stage: "OK", code: "OK", recoverable: true, stages: { ...stages } }
}

function pathIsAbsolute(p) {
  const s = String(p ?? "")
  return s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s)
}

/** Default verification requirement for a node that mutates but declared none. */
export function defaultVerificationFor(node) {
  const risk = RISK_LEVELS.includes(node?.risk) ? node.risk : "medium"
  if (node?.read_only === true) return ["acceptance"]
  if (risk === "critical") return ["syntax", "focused_test", "regression_test", "build", "security"]
  if (risk === "high") return ["syntax", "focused_test", "regression_test", "build"]
  if (risk === "medium") return ["syntax", "focused_test"]
  return ["syntax"]
}

/**
 * Repair an invalid plan deterministically (P0).
 *
 * Repairs: synthesise missing ids, coerce dependencies, drop unknown/self
 * dependencies, sanitise or drop invalid targets, restore conflict keys, and
 * inject the default verification requirement for mutating nodes. Cycles are
 * reported (`cycle`, `needsReplan`) and never "fixed" by dropping an edge.
 *
 * Every change is reported so the controller can audit the repair. If the plan
 * cannot be made valid (e.g. there are no nodes left to work with) it returns
 * ok:false — the controller must then WAIT, never execute.
 */
export function repairPlan(planDefs = [], objective = "", validation = null) {
  const changes = []
  const src = Array.isArray(planDefs) ? planDefs : []
  let nodes = src
    .map((n, i) => (n && typeof n === "object" ? { ...n } : { objective: String(n ?? "") }))
    .filter((n) => n && typeof n === "object")

  // synthesise ids
  const seen = new Set()
  nodes = nodes.map((n, i) => {
    let id = typeof n.id === "string" && n.id.trim() ? n.id.trim() : null
    if (!id) {
      id = `n${i + 1}`
      changes.push(`node ${i + 1} had no id — assigned ${id}`)
    }
    if (seen.has(id)) {
      const next = `${id}-${i + 1}`
      changes.push(`duplicate id ${id} renamed to ${next}`)
      id = next
    }
    seen.add(id)
    n.id = id
    if (!n.objective && !n.title && !n.task) {
      n.objective = String(objective ?? "").slice(0, 300)
      changes.push(`node ${id} had no objective — inherited the task objective`)
    }
    return n
  })

  if (!nodes.length) {
    // No plan at all. This is the ONLY explicitly-proven-safe fallback: one
    // node carrying the objective verbatim, with a verification requirement.
    // It is never used for a plan that existed and was rejected.
    if (!String(objective ?? "").trim()) return { ok: false, nodes: [], changes }
    changes.push("plan was empty — created a single explicit objective node (proven-safe fallback)")
    nodes = [{
      id: "n1", objective: String(objective).slice(0, 600), dependencies: [], priority: 100,
      role: "coder", read_only: false, risk: "medium",
      targetFiles: [], targetSymbols: [], targetDirs: [], resourceLocks: [],
      verificationRequirements: defaultVerificationFor({ read_only: false, risk: "medium" }),
    }]
  }

  // coerce + sanitise dependencies
  const idSet = new Set(nodes.map((n) => n.id))
  for (const n of nodes) {
    const raw = Array.isArray(n.dependencies) ? n.dependencies : Array.isArray(n.deps) ? n.deps : []
    const clean = []
    for (const d of raw) {
      const dep = String(d ?? "").trim()
      if (!dep) continue
      if (dep === n.id) { changes.push(`node ${n.id} self-dependency removed`); continue }
      if (!idSet.has(dep)) { changes.push(`node ${n.id} unknown dependency "${dep}" dropped`); continue }
      clean.push(dep)
    }
    n.dependencies = [...new Set(clean)]
    delete n.deps
  }

  // sanitise targets / conflicts
  for (const n of nodes) {
    for (const key of ["targetFiles", "targetSymbols", "targetDirs", "resourceLocks"]) {
      const alt = key === "targetFiles" ? "target_files" : key === "targetSymbols" ? "target_symbols" : key === "targetDirs" ? "target_dirs" : "resource_locks"
      const raw = n[key] ?? n[alt]
      if (raw == null) { n[key] = []; delete n[alt]; continue }
      if (!Array.isArray(raw)) { changes.push(`node ${n.id} ${key} was not an array — emptied`); n[key] = []; delete n[alt]; continue }
      const clean = []
      for (const v of raw) {
        const s = typeof v === "string" ? v.trim() : ""
        if (!s) { changes.push(`node ${n.id} empty ${key} entry dropped`); continue }
        if (key !== "resourceLocks" && (pathIsAbsolute(s) || /(^|\/)\.\.(\/|$)/.test(s) || FORBIDDEN_TARGET.test(s))) {
          changes.push(`node ${n.id} unsafe ${key} target "${s}" dropped`)
          continue
        }
        clean.push(s)
      }
      n[key] = [...new Set(clean)]
      delete n[alt]
    }
    // verification requirements
    const reqs = Array.isArray(n.verificationRequirements) ? n.verificationRequirements : Array.isArray(n.verification_requirements) ? n.verification_requirements : null
    const cleanReqs = (reqs ?? []).map((r) => String(r ?? "").trim()).filter(Boolean)
    if (n.read_only !== true && !cleanReqs.length) {
      const def = defaultVerificationFor(n)
      changes.push(`node ${n.id} had no verification requirement — added [${def.join(", ")}]`)
      n.verificationRequirements = def
    } else {
      n.verificationRequirements = cleanReqs
    }
    delete n.verification_requirements
    if (!RISK_LEVELS.includes(n.risk)) { if (n.risk != null) changes.push(`node ${n.id} invalid risk reset`); n.risk = "medium" }
  }

  // v21.1 P1 — cycles are NOT repaired here. The old code dropped whichever
  // dependency edge it met first inside the cycle. A dependency is an ordering
  // constraint the planner asserted ("migrate schema BEFORE running the
  // tests"); removing one at random lets the executor run a node before the
  // work it depends on, and it did so silently under the label "repaired". A
  // cycle is a PLANNING error: the plan must be re-made by the planner with
  // the cycle spelled out, or the task must stop. We report the cycle
  // (members + the offending edges) so the controller can re-plan with that
  // feedback, and leave every edge exactly as the planner wrote it.
  const final = validatePlan(nodes)
  let cycle = null
  if (!final.ok && final.code === "CYCLE_DETECTED") {
    const cyc = /cycle involving: (.*)$/.exec(final.errors.find((e) => /cycle involving/.test(e)) ?? "")?.[1] ?? ""
    const members = cyc.split(",").map((s) => s.trim()).filter(Boolean)
    const edges = []
    for (const n of nodes) if (members.includes(n.id)) for (const d of n.dependencies ?? []) if (members.includes(d)) edges.push(`${n.id} → ${d}`)
    cycle = { members, edges }
    changes.push(`cycle NOT repaired (dependencies are never dropped): ${edges.join(", ") || members.join(", ")} — re-plan required`)
  }
  return { ok: final.ok, nodes, changes, validation: final, ...(cycle ? { cycle, needsReplan: true } : {}) }
}

/**
 * Adaptive DAG support (P1):
 * DAG → EXECUTION → NEW EVIDENCE → DAG UPDATE → NEW NODE → EXECUTION
 * All updates must remain validated, deterministic, auditable, checkpointed.
 * Never allow uncontrolled infinite DAG growth.
 */
/**
 * Adaptive DAG (P1): new requirements discovered during execution may add
 * nodes — but every addition is bounded, validated and AUDITED.
 *
 * Every generated node records: parent, reason, evidence, risk, verification,
 * creator and timestamp. Without that provenance an adaptive DAG is
 * unfalsifiable: nobody can tell why node n17 exists.
 *
 * Bounds (no infinite growth):
 *   maxNodes      hard cap on graph size
 *   maxExpansion  how many nodes one expansion may add
 *   maxDepth      how deep a discovery chain may go (parent → child → …)
 */
export const ADAPTIVE_LIMITS = { maxNodes: 100, maxExpansion: 8, maxDepth: 6 }

export function updateDAG(graph, newDefs = [], opts = {}) {
  const {
    maxNodes = ADAPTIVE_LIMITS.maxNodes,
    maxExpansion = ADAPTIVE_LIMITS.maxExpansion,
    maxDepth = ADAPTIVE_LIMITS.maxDepth,
    // provenance of this expansion
    parent = null, reason = null, evidence = null, creator = null,
  } = opts
  if (!graph) return buildDAG(stampProvenance(newDefs, { parent, reason, evidence, creator }))
  if (newDefs.length > maxExpansion) {
    throw new Error(`DAG expansion limit exceeded: ${newDefs.length} new node(s) > ${maxExpansion}`)
  }
  if (graph.nodes.size + newDefs.length > maxNodes) {
    throw new Error(`DAG growth limit exceeded: ${graph.nodes.size} + ${newDefs.length} > ${maxNodes}`)
  }
  if (parent) {
    const depth = nodeDepth(graph, parent)
    if (depth + 1 > maxDepth) {
      throw new Error(`DAG depth limit exceeded: ${depth + 1} > ${maxDepth}`)
    }
  }
  const existing = [...graph.nodes.values()]
  const combined = [...existing]
  for (const def of stampProvenance(newDefs, { parent, reason, evidence, creator })) {
    if (!graph.nodes.has(def.id)) combined.push(def)
  }
  const validation = validatePlan(combined)
  if (!validation.ok) {
    // an adaptive update must land on a VALID graph; repair it deterministically
    const repair = repairPlan(combined, "", validation)
    if (!repair.ok) throw new Error(`DAG update validation failed: ${validation.errors.join("; ")}`)
    return buildDAG(repair.nodes)
  }
  return buildDAG(combined)
}

/**
 * v28 mid-task replan: keep COMPLETED nodes (status + verification), drop
 * unfinished ones, splice in a new remaining plan. New ids are prefixed so
 * a numbered list (`n1`…) cannot collide with a completed `n1`. Dependencies
 * on completed ids are kept; unknown deps are dropped. Never a second writer.
 *
 * Returns { ok, graph, kept, added, dropped, error }.
 */
export function replanRemaining(graph, newDefs = [], opts = {}) {
  const prefix = String(opts.prefix ?? "rp")
  if (!graph) {
    const defs = (newDefs ?? []).map((d, i) => ({ ...d, id: `${prefix}${i + 1}` }))
    if (!defs.length) return { ok: false, graph: null, kept: 0, added: 0, dropped: 0, error: "empty replan" }
    return { ok: true, graph: buildDAG(defs), kept: 0, added: defs.length, dropped: 0, error: null }
  }
  const kept = [...graph.nodes.values()].filter((n) => n.status === NODE_STATUS.COMPLETED)
  const keptIds = new Set(kept.map((n) => n.id))
  const dropped = [...graph.nodes.values()].filter((n) => n.status !== NODE_STATUS.COMPLETED)
  const incoming = Array.isArray(newDefs) ? newDefs : []
  if (!incoming.length) return { ok: false, graph, kept: kept.length, added: 0, dropped: dropped.length, error: "empty replan" }

  const idMap = new Map()
  incoming.forEach((d, i) => {
    const oldId = String(d?.id ?? `n${i + 1}`).trim() || `n${i + 1}`
    idMap.set(oldId, `${prefix}${i + 1}`)
  })
  const remapDep = (d) => {
    const s = String(d)
    if (keptIds.has(s)) return s
    if (idMap.has(s)) return idMap.get(s)
    return null
  }
  const remapped = incoming.map((d, i) => {
    const deps = [...new Set((d.dependencies ?? d.deps ?? []).map(remapDep).filter(Boolean))]
    return {
      ...d,
      id: `${prefix}${i + 1}`,
      dependencies: deps,
      status: NODE_STATUS.PENDING,
      createdBy: opts.creator ?? "replan",
      createdReason: opts.reason ?? "mid-task replan from verification evidence",
      createdEvidence: opts.evidence == null ? null : String(opts.evidence).slice(0, 600),
    }
  })

  const combined = [...kept, ...remapped]
  let nodes = combined
  const validation = validatePlan(combined)
  if (!validation.ok) {
    const repair = repairPlan(combined, opts.objective ?? "", validation)
    if (!repair.ok) return { ok: false, graph, kept: kept.length, added: 0, dropped: dropped.length, error: validation.errors.join("; "), validation }
    nodes = repair.nodes.map((n) => keptIds.has(n.id) ? (kept.find((k) => k.id === n.id) || n) : n)
  }
  let next
  try {
    next = buildDAG(nodes)
  } catch (e) {
    return { ok: false, graph, kept: kept.length, added: 0, dropped: dropped.length, error: String(e?.message ?? e) }
  }
  for (const k of kept) {
    const n = next.nodes.get(k.id)
    if (!n) continue
    n.status = NODE_STATUS.COMPLETED
    n.result = k.result
    n.verificationSatisfied = k.verificationSatisfied
    n.verificationId = k.verificationId
    n.ended_at = k.ended_at
  }
  for (const n of next.nodes.values()) {
    if (n.status === NODE_STATUS.PENDING && depsSatisfied(next, n)) n.status = NODE_STATUS.READY
  }
  return { ok: true, graph: next, kept: kept.length, added: remapped.length, dropped: dropped.length, error: null }
}

function stampProvenance(defs, { parent, reason, evidence, creator }) {
  const at = Date.now()
  return (defs ?? []).map((d) => (d && typeof d === "object" ? {
    ...d,
    parentNode: d.parentNode ?? d.parent_node ?? parent ?? null,
    createdReason: d.createdReason ?? d.created_reason ?? reason ?? null,
    createdEvidence: d.createdEvidence ?? d.created_evidence ?? (evidence == null ? null : String(evidence).slice(0, 600)),
    createdBy: d.createdBy ?? d.created_by ?? creator ?? "adaptive",
    createdAt: d.createdAt ?? d.created_at ?? at,
  } : d))
}

/** Depth of a node in the discovery chain (0 = an original planned node). */
export function nodeDepth(graph, id) {
  let depth = 0
  let cur = graph?.nodes?.get?.(String(id)) ?? null
  const seen = new Set()
  while (cur?.parentNode && depth < 64) {
    if (seen.has(cur.parentNode)) break
    seen.add(cur.parentNode)
    depth++
    cur = graph.nodes.get(String(cur.parentNode)) ?? null
  }
  return depth
}

export function parsePlanToDAG(text) {
  const raw = String(text ?? "").trim()
  if (!raw) return []
  const json = extractJson(raw)
  if (json) {
    try {
      const arr = JSON.parse(json)
      if (Array.isArray(arr)) {
        // v21.1: model JSON is untrusted — non-object entries are skipped and
        // dependency lists are normalised to string ids (null/number/garbage
        // entries used to survive into the graph and crash later stages).
        const depList = (d) => (Array.isArray(d) ? d : typeof d === "string" && d.trim() ? d.split(/[,\s]+/) : [])
          .filter((x) => x != null && x !== "" && (typeof x === "string" || typeof x === "number")).map((x) => String(x).trim()).filter(Boolean)
        const defs = arr.filter((n) => n && typeof n === "object" && !Array.isArray(n)).map((n, i) => ({
          id: (typeof n.id === "string" || typeof n.id === "number") && String(n.id).trim() ? String(n.id).trim() : `n${i + 1}`,
          objective: String(n.objective ?? n.title ?? n.task ?? ""),
          dependencies: depList(n.dependencies ?? n.deps),
          priority: n.priority ?? (arr.length - i),
          risk: n.risk,
          role: n.role ?? inferRole(n.objective ?? n.task ?? ""),
          read_only: n.read_only ?? /research|investigat|review|read|analy|find|search|inspect/i.test(String(n.objective ?? n.task ?? "")),
          required_capabilities: n.required_capabilities ?? [],
          targetFiles: n.targetFiles ?? n.target_files ?? [],
          targetSymbols: n.targetSymbols ?? n.target_symbols ?? [],
          targetDirs: n.targetDirs ?? n.target_dirs ?? [],
          resourceLocks: n.resourceLocks ?? n.resource_locks ?? [],
          verificationRequirements: n.verificationRequirements ?? n.verification_requirements ?? [],
          conflictKeys: n.conflictKeys ?? null,
        }))
        const v = validatePlan(defs)
        if (!v.ok && !v.recoverable) throw new Error(`plan validation failed: ${v.errors.join("; ")}`)
        return defs
      }
    } catch { }
  }
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean)
  const defs = []
  let idx = 0
  for (const line of lines) {
    const m = /^(?:\d+[.)]\s*|[-*]\s+)(.+)$/.exec(line)
    if (!m) continue
    idx++
    const id = `n${idx}`
    let body = m[1].trim()
    const deps = []
    const depMatch = /(?:depends on|after|deps?:)\s*([^)]+)\)?$/i.exec(body)
    if (depMatch) {
      for (const d of depMatch[1].split(/[,\\s]+/)) {
        const dm = /\b(n\d+|\d+)\b/.exec(d)
        if (dm) deps.push(dm[1].startsWith("n") ? dm[1] : `n${dm[1]}`)
      }
      body = body.slice(0, depMatch.index).replace(/\s*\(?,?\s*$/, "").trim()
    }
    if (!deps.length && idx > 1) deps.push(`n${idx - 1}`)
    defs.push({
      id,
      objective: body,
      dependencies: deps,
      priority: 100 - idx,
      role: inferRole(body),
      read_only: /research|investigat|review|read|analy|find|search|inspect|explore|locate/i.test(body),
      targetFiles: [],
      targetSymbols: [],
      targetDirs: [],
      resourceLocks: [],
      verificationRequirements: [],
    })
  }
  const v = validatePlan(defs)
  if (!v.ok && !v.recoverable) throw new Error(`plan validation failed: ${v.errors.join("; ")}`)
  return defs
}

function inferRole(text) {
  const t = String(text ?? "").toLowerCase()
  if (/research|investigat|find|search|inspect|explore|locate|read/.test(t)) return "researcher"
  if (/review|audit/.test(t)) return "reviewer"
  if (/security|vulnerab|injection|auth/.test(t)) return "security"
  if (/test|verify|spec/.test(t)) return "tester"
  if (/debug|diagnos|root cause|failing|error/.test(t)) return "debugger"
  if (/architect|design|plan|structure/.test(t)) return "architect"
  if (/implement|write|code|edit|refactor|fix|add|create|build/.test(t)) return "coder"
  return "coder"
}

function extractJson(s) {
  const start = s.indexOf("[")
  const end = s.lastIndexOf("]")
  if (start !== -1 && end > start) return s.slice(start, end + 1)
  return null
}
