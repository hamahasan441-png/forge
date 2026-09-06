/**
 * forge — DAG planner (v21, zero dependencies)
 *
 * Before v21 planning was a flat numbered list (plans.js) and the model drove
 * a single sequential tool loop. A real task is a dependency graph: research
 * can fan out to independent read-only workers, and two mutating nodes that
 * touch the same file must never run concurrently.
 *
 * This module is the pure graph: nodes, edges, readiness, scheduling, failure
 * propagation and recomputation. It executes NOTHING — the meta controller
 * (meta.js) walks it, the agent manager (agentmanager.js) schedules the workers
 * and the security gate still guards every tool. The graph is plain JSON so it
 * survives a process interruption inside the task record.
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

/** Validate + normalize a node definition. Throws on a structurally bad node. */
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
    role: n.role ?? null, // researcher | coder | tester | reviewer | security | debugger | architect
    read_only: n.read_only ?? false,
    result: n.result ?? null,
    started_at: n.started_at ?? null,
    ended_at: n.ended_at ?? null,
    attempts: n.attempts ?? 0,
    error: n.error ?? null,
  }
}

/**
 * Build a graph from node defs. Validates uniqueness and dependency wiring.
 * Returns { nodes, order } where order is a topological ordering (used for a
 * deterministic schedule and crash-safe persistence).
 */
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
  // mark the initially-ready set (no dependencies)
  for (const n of nodes.values()) if (!n.dependencies.length && n.status === NODE_STATUS.PENDING) n.status = NODE_STATUS.READY
  return { nodes, order }
}

/** Kahn topological sort; throws on a cycle. */
export function topoSort(nodes) {
  const indeg = new Map()
  const dependents = new Map()
  for (const id of nodes.keys()) { indeg.set(id, 0); dependents.set(id, []) }
  for (const n of nodes.values()) {
    indeg.set(n.id, n.dependencies.length)
    for (const d of n.dependencies) dependents.get(d).push(n.id)
  }
  // stable: order by priority desc then id so the schedule is deterministic
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
        // insert in priority order
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

/** Serialize to a plain JSON-safe object (for the task record). */
export function serializeDAG(graph) {
  return { order: graph.order, nodes: graph.order.map((id) => graph.nodes.get(id)) }
}

/** Rehydrate from the task record (validates). Returns null if unusable. */
export function deserializeDAG(data) {
  try {
    if (!data || !Array.isArray(data.nodes)) return null
    const graph = buildDAG(data.nodes)
    return graph
  } catch { return null }
}

/** A node is runnable when READY (deps satisfied, not yet started). */
export function readyNodes(graph) {
  return graph.order
    .map((id) => graph.nodes.get(id))
    .filter((n) => n.status === NODE_STATUS.READY)
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
}

/** Nodes currently eligible to run CONCURRENTLY: ready, read-only, no
 *  conflicting targets. Mutating nodes are always returned one at a time. */
export function scheduleBatch(graph, { maxParallel = 2, conflictKeys = () => [] } = {}) {
  const ready = readyNodes(graph)
  if (!ready.length) return []
  const batch = []
  const heldLocks = new Set()
  for (const n of ready) {
    const locks = new Set(conflictKeys(n).map(String))
    let conflicts = false
    for (const l of locks) if (heldLocks.has(l)) { conflicts = true; break }
    if (n.read_only && !conflicts) {
      batch.push(n)
      for (const l of locks) heldLocks.add(l)
      if (batch.length >= maxParallel) break
      continue
    }
    // a mutating node: run it ALONE (it takes the whole batch). Reads already
    // collected in this batch may proceed alongside only if they don't touch
    // its targets — but to keep mutations strictly serialized we stop here.
    if (batch.length === 0 && !conflicts) {
      batch.push(n)
      break // one mutation per batch, serialized by the controller
    }
    // otherwise leave the mutation for the next batch
  }
  return batch
}

/** True when all non-cancelled nodes are completed. */
export function allComplete(graph) {
  for (const n of graph.nodes.values()) {
    if (n.status === NODE_STATUS.CANCELLED) continue
    if (n.status !== NODE_STATUS.COMPLETED) return false
  }
  return graph.nodes.size > 0
}

/** True when the graph cannot make further progress: no ready/running work and
 *  at least one node is unfinished (failed/blocked/pending) with unfinished
 *  dependents. */
export function isStalled(graph) {
  if (readyNodes(graph).length) return false
  for (const n of graph.nodes.values()) {
    if (n.status === NODE_STATUS.RUNNING) return false
  }
  for (const n of graph.nodes.values()) {
    if ([NODE_STATUS.FAILED, NODE_STATUS.BLOCKED, NODE_STATUS.PENDING].includes(n.status)) {
      // something that depends on this node is itself unfinished → deadlock
      for (const m of graph.nodes.values()) {
        if (m.dependencies.includes(n.id) && [NODE_STATUS.BLOCKED, NODE_STATUS.PENDING, NODE_STATUS.READY].includes(m.status)) return true
      }
      // a failed node with no satisfied path forward is itself a stall
      if (n.status === NODE_STATUS.FAILED) return true
    }
  }
  return false
}

/** Mark a node running. */
export function markRunning(graph, id) {
  const n = graph.nodes.get(id)
  if (!n || n.status !== NODE_STATUS.READY) return false
  n.status = NODE_STATUS.RUNNING
  n.started_at = n.started_at ?? Date.now()
  n.attempts++
  return true
}

/** Mark a node completed with a result; unblocks its dependents. */
export function markCompleted(graph, id, result = null) {
  const n = graph.nodes.get(id)
  if (!n) return false
  n.status = NODE_STATUS.COMPLETED
  n.ended_at = Date.now()
  n.result = result == null ? n.result : String(result).slice(0, 2000)
  // recompute readiness of dependents (pending OR blocked waiting on this node)
  for (const m of graph.nodes.values()) {
    if (m.status !== NODE_STATUS.PENDING && m.status !== NODE_STATUS.BLOCKED) continue
    if (m.dependencies.includes(id) && depsSatisfied(graph, m)) m.status = NODE_STATUS.READY
  }
  return true
}

/** Mark a node failed; recompute downstream instead of blindly continuing. */
export function markFailed(graph, id, error = null) {
  const n = graph.nodes.get(id)
  if (!n) return []
  n.status = NODE_STATUS.FAILED
  n.ended_at = Date.now()
  n.error = error == null ? n.error : String(error).slice(0, 500)
  return recomputeDownstream(graph, id)
}

/** Cancel a node (and, by default, the nodes that depend only on it). */
export function markCancelled(graph, id, { cascade = true } = {}) {
  const n = graph.nodes.get(id)
  if (!n) return []
  n.status = NODE_STATUS.CANCELLED
  n.ended_at = Date.now()
  const cancelled = [id]
  if (cascade) {
    for (const m of graph.nodes.values()) {
      if (m.status === NODE_STATUS.PENDING && m.dependencies.some((d) => cancelled.includes(d))) {
        // only cancel if ALL its deps are cancelled/failed (it can't run)
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

/** Reset a failed node to ready so a repair can retry it. */
export function retryNode(graph, id) {
  const n = graph.nodes.get(id)
  if (!n) return false
  if (![NODE_STATUS.FAILED, NODE_STATUS.BLOCKED].includes(n.status)) return false
  n.status = depsSatisfied(graph, n) ? NODE_STATUS.READY : NODE_STATUS.PENDING
  n.error = null
  return true
}

/** Dependents of `id` that must be reconsidered after `id` failed.
 *  Pending dependents become blocked; ready/running ones are unaffected
 *  (they were scheduled against an earlier satisfied state — the controller
 *  decides whether to cancel running work). */
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

/** Compact progress summary for the UI / journal. */
export function dagStats(graph) {
  const s = { total: 0, completed: 0, failed: 0, running: 0, ready: 0, blocked: 0, pending: 0, cancelled: 0 }
  for (const n of graph.nodes.values()) {
    s.total++
    s[n.status] = (s[n.status] ?? 0) + 1
  }
  return s
}

/**
 * Parse a model-produced plan into DAG node defs.
 * Accepts EITHER an explicit JSON array of node objects OR a numbered/
 * bulleted list of steps (sequential dependencies inferred from order).
 * Lines that begin with "depends on X, Y" / "after:" wire explicit edges.
 */
export function parsePlanToDAG(text) {
  const raw = String(text ?? "").trim()
  if (!raw) return []
  // explicit JSON?
  const json = extractJson(raw)
  if (json) {
    try {
      const arr = JSON.parse(json)
      if (Array.isArray(arr)) {
        return arr.map((n, i) => ({
          id: String(n.id ?? `n${i + 1}`),
          objective: n.objective ?? n.title ?? n.task ?? "",
          dependencies: n.dependencies ?? n.deps ?? [],
          priority: n.priority ?? (arr.length - i),
          risk: n.risk,
          role: n.role ?? inferRole(n.objective ?? n.task ?? ""),
          read_only: n.read_only ?? /research|investigat|review|read|analy|find|search|inspect/i.test(String(n.objective ?? n.task ?? "")),
          required_capabilities: n.required_capabilities ?? [],
        }))
      }
    } catch { /* fall through to list parsing */ }
  }
  // numbered / bulleted list
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean)
  const defs = []
  let idx = 0
  const idOf = new Map()
  for (const line of lines) {
    const m = /^(?:\d+[.)]\s*|[-*]\s+)(.+)$/.exec(line)
    if (!m) continue
    idx++
    const id = `n${idx}`
    let body = m[1].trim()
    // explicit dependency hint: "... (depends on n1, n3)" or "after: n1"
    const deps = []
    const depMatch = /(?:depends on|after|deps?:)\s*([^)]+)\)?$/i.exec(body)
    if (depMatch) {
      for (const d of depMatch[1].split(/[,\s]+/)) {
        const dm = /\b(n\d+|\d+)\b/.exec(d)
        if (dm) deps.push(dm[1].startsWith("n") ? dm[1] : `n${dm[1]}`)
      }
      body = body.slice(0, depMatch.index).replace(/\s*\(?,?\s*$/, "").trim()
    }
    // sequential default: depends on the previous step unless it declares deps
    if (!deps.length && idx > 1) deps.push(`n${idx - 1}`)
    defs.push({
      id,
      objective: body,
      dependencies: deps,
      priority: 100 - idx,
      role: inferRole(body),
      read_only: /research|investigat|review|read|analy|find|search|inspect|explore|locate/i.test(body),
    })
  }
  void idOf
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
