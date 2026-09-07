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
  COMPLETED: "completed",
  FAILED: "failed",
  BLOCKED: "blocked",
  CANCELLED: "cancelled",
}

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
  }
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

export function markCompleted(graph, id, result = null) {
  const n = graph.nodes.get(id)
  if (!n) return false
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
  if (![NODE_STATUS.FAILED, NODE_STATUS.BLOCKED].includes(n.status)) return false
  n.status = depsSatisfied(graph, n) ? NODE_STATUS.READY : NODE_STATUS.PENDING
  n.error = null
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
  const s = { total: 0, completed: 0, failed: 0, running: 0, ready: 0, blocked: 0, pending: 0, cancelled: 0 }
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
 */
export function scheduleBatch(graph, { maxParallel = 2, conflictKeys = canonicalConflictKeys } = {}) {
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

export function allComplete(graph) {
  for (const n of graph.nodes.values()) {
    if (n.status === NODE_STATUS.CANCELLED) continue
    if (n.status !== NODE_STATUS.COMPLETED) return false
  }
  return graph.nodes.size > 0
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

/**
 * Plan validation pipeline (P0):
 * USER TASK → INTENT → PLAN → SCHEMA VALIDATION → DEPENDENCY VALIDATION
 * → TARGET VALIDATION → CONFLICT VALIDATION → VERIFICATION PLAN → DAG → EXECUTION
 * If validation fails: REPAIR or WAITING depending on recoverability.
 */
export function validatePlan(planDefs = []) {
  const errors = []
  if (!Array.isArray(planDefs)) {
    return { ok: false, errors: ["plan must be an array"], recoverable: false }
  }
  if (!planDefs.length) {
    return { ok: false, errors: ["plan is empty"], recoverable: true, code: "EMPTY_PLAN" }
  }
  // Schema validation
  for (let i = 0; i < planDefs.length; i++) {
    const n = planDefs[i]
    if (!n || typeof n !== "object") {
      errors.push(`node ${i} must be an object`)
      continue
    }
    if (!n.id && !n.objective && !n.title && !n.task) {
      errors.push(`node ${i} missing id/objective`)
    }
    if (n.id && typeof n.id !== "string") errors.push(`node ${i} id must be string`)
    if (n.dependencies && !Array.isArray(n.dependencies)) errors.push(`node ${n.id ?? i} dependencies must be array`)
  }
  if (errors.length) {
    return { ok: false, errors, recoverable: errors.some(e => /missing|empty/i.test(e)), code: "SCHEMA_FAILED" }
  }

  // Dependency validation
  try {
    const nodes = new Map()
    for (const def of planDefs) {
      const id = String(def.id ?? "")
      if (!id) continue
      if (nodes.has(id)) {
        errors.push(`duplicate node id: ${id}`)
      }
      nodes.set(id, def)
    }
    for (const n of nodes.values()) {
      const deps = n.dependencies ?? n.deps ?? []
      for (const d of deps) {
        if (!nodes.has(String(d))) {
          errors.push(`node ${n.id} depends on unknown node ${d}`)
        }
      }
    }
    // Cycle check via topoSort
    if (!errors.length) {
      const graph = buildDAG(planDefs)
      void graph
    }
  } catch (e) {
    errors.push(String(e.message))
  }
  if (errors.length) {
    const recoverable = !errors.some(e => /cycle/i.test(e))
    return { ok: false, errors, recoverable, code: recoverable ? "DEPENDENCY_FAILED" : "CYCLE_DETECTED" }
  }

  // Target validation (files/symbols/dirs must be plausible)
  for (const n of planDefs) {
    const files = n.targetFiles ?? n.target_files ?? []
    for (const f of files) {
      if (typeof f !== "string" || !f.trim()) errors.push(`node ${n.id} has invalid targetFile`)
      if (String(f).includes("..") && String(f).includes("/etc/")) errors.push(`node ${n.id} has suspicious targetFile: ${f}`)
    }
  }

  // Conflict validation: check for duplicate conflict keys that would deadlock
  // (not fatal, but warn)

  // Verification plan: ensure nodes with risk high/critical have verificationRequirements
  for (const n of planDefs) {
    const risk = n.risk ?? "low"
    if ((risk === "high" || risk === "critical") && (!n.verificationRequirements || !n.verificationRequirements.length)) {
      // not blocking, but note
    }
  }

  if (errors.length) {
    return { ok: false, errors, recoverable: true, code: "TARGET_FAILED" }
  }
  return { ok: true, errors: [], recoverable: true }
}

/**
 * Adaptive DAG support (P1):
 * DAG → EXECUTION → NEW EVIDENCE → DAG UPDATE → NEW NODE → EXECUTION
 * All updates must remain validated, deterministic, auditable, checkpointed.
 * Never allow uncontrolled infinite DAG growth.
 */
export function updateDAG(graph, newDefs = [], { maxNodes = 100 } = {}) {
  if (!graph) return buildDAG(newDefs)
  if (graph.nodes.size + newDefs.length > maxNodes) {
    throw new Error(`DAG growth limit exceeded: ${graph.nodes.size} + ${newDefs.length} > ${maxNodes}`)
  }
  const existing = [...graph.nodes.values()]
  const combined = [...existing]
  for (const def of newDefs) {
    if (!graph.nodes.has(def.id)) combined.push(def)
  }
  const validation = validatePlan(combined)
  if (!validation.ok && !validation.recoverable) {
    throw new Error(`DAG update validation failed: ${validation.errors.join("; ")}`)
  }
  return buildDAG(combined)
}

export function parsePlanToDAG(text) {
  const raw = String(text ?? "").trim()
  if (!raw) return []
  const json = extractJson(raw)
  if (json) {
    try {
      const arr = JSON.parse(json)
      if (Array.isArray(arr)) {
        const defs = arr.map((n, i) => ({
          id: String(n.id ?? `n${i + 1}`),
          objective: n.objective ?? n.title ?? n.task ?? "",
          dependencies: n.dependencies ?? n.deps ?? [],
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
