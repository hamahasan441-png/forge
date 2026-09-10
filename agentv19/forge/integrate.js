/**
 * forge — integrator (v34, zero dependencies)
 *
 * UNIFIED §17: specialized workers share one engineering state. After
 * researcher / tester / reviewer settle, the integrator merges their
 * findings into ONE ordered apply list. The main coder writes it.
 *
 * The integrator NEVER mutates. Empty reports → empty apply (never invented).
 * Overlapping file claims are recorded as conflicts; later report wins so
 * the writer has a single list, and the conflict is visible.
 *
 * Does not import agentmanager (keeps this module a pure merge).
 */

const READ_ONLY = new Set(["researcher", "reviewer", "security", "tester", "architect", "integrator"])
export const INTEGRATOR_ROLE = "integrator"

function relOf(p) {
  const s = String(p ?? "").replace(/\\/g, "/").replace(/^(\.\/)+/, "").trim()
  if (!s || s.includes("\0") || /(^|\/)\.\.(\/|$)/.test(s) || s.startsWith("/")) return null
  return s.slice(0, 240)
}

function filesOf(r) {
  const raw = []
  for (const k of ["files", "targetFiles", "target_files", "affectedFiles"]) {
    if (Array.isArray(r?.[k])) raw.push(...r[k])
  }
  const out = []
  const seen = new Set()
  for (const f of raw) {
    const rel = relOf(f)
    if (!rel || seen.has(rel)) continue
    seen.add(rel)
    out.push(rel)
  }
  return out
}

function extractFilesFromText(text) {
  const out = []
  const seen = new Set()
  const re = /(?:^|[\s`'"(=])([A-Za-z0-9_./-]+\.[A-Za-z][A-Za-z0-9]{0,7})/g
  let m
  const s = String(text ?? "")
  while ((m = re.exec(s)) && out.length < 16) {
    const rel = relOf(m[1])
    if (!rel || seen.has(rel)) continue
    seen.add(rel)
    out.push(rel)
  }
  return out
}

/**
 * Merge worker reports into a single apply list.
 * @param {{ objective?: string, reports?: Array, graph?: {edges?: Array} }}
 * @returns {{ apply, conflicts, skip, text, readOnly: true }}
 */
export function integrateResults({ objective = "", reports = [], graph = null } = {}) {
  const apply = []
  const conflicts = []
  const skip = []
  const byFile = new Map()
  const list = Array.isArray(reports) ? reports : []
  for (const r of list) {
    if (!r) continue
    if (r.ok === false) {
      skip.push({ from: r.role || "worker", why: String(r.error || r.why || "failed").slice(0, 200) })
      continue
    }
    const action = String(r.action || r.recommendation || r.text || r.result || "").trim().slice(0, 800)
    let files = filesOf(r)
    if (!files.length && action) files = extractFilesFromText(action)
    if (!files.length) {
      if (action) skip.push({ from: r.role || "worker", why: "no file target" })
      continue
    }
    for (const file of files) {
      const item = {
        file,
        action: action.slice(0, 400),
        from: r.role || "worker",
        why: String(r.why || action).slice(0, 160),
      }
      const prev = byFile.get(file)
      if (prev && prev.action && item.action && prev.action !== item.action && prev.from !== item.from) {
        conflicts.push({ file, a: prev, b: item })
      }
      byFile.set(file, item)
    }
  }
  for (const item of byFile.values()) apply.push(item)
  if (graph && Array.isArray(graph.edges) && apply.length) {
    const files = new Set(apply.map((a) => a.file))
    for (const e of graph.edges) {
      const from = relOf(e.from || e.src)
      const to = relOf(e.to || e.dst)
      if (from && to && files.has(from) && !files.has(to) && /CONSUMES|IMPLEMENTS|TEST/i.test(String(e.type || e.kind || ""))) {
        apply.push({ file: to, action: `review related (${e.type || e.kind}) of ${from}`, from: "graph", why: "cross-language dependent" })
        files.add(to)
      }
    }
  }
  return {
    apply,
    conflicts,
    skip,
    text: formatIntegrate(objective, apply, conflicts, skip),
    readOnly: true,
  }
}

export function formatIntegrate(objective, apply, conflicts, skip) {
  const lines = ["INTEGRATE (read-only merge — the main writer applies this list, this role does not write):"]
  if (objective) lines.push(`objective: ${String(objective).slice(0, 200)}`)
  if (!apply.length && !conflicts.length && !skip.length) {
    lines.push("(empty — no worker findings to merge; do not invent edits)")
    return lines.join("\n")
  }
  if (apply.length) {
    lines.push("apply:")
    for (const a of apply.slice(0, 24)) {
      lines.push(`- ${a.file}: ${a.action || a.why || ""}`.slice(0, 220) + (a.from ? ` [${a.from}]` : ""))
    }
  }
  if (conflicts.length) {
    lines.push("conflicts (later report wins; writer must reconcile):")
    for (const c of conflicts.slice(0, 8)) {
      lines.push(`- ${c.file}: ${c.a.from} vs ${c.b.from}`)
    }
  }
  if (skip.length) {
    lines.push("skipped:")
    for (const s of skip.slice(0, 8)) lines.push(`- ${s.from}: ${s.why}`)
  }
  return lines.join("\n")
}

/**
 * Harvest completed read-only node results from a DAG (Map or array).
 * Integrator nodes are excluded (they are the merge, not a source).
 */
export function reportsFromGraph(dag) {
  const reports = []
  if (!dag) return reports
  const nodes = dag.nodes instanceof Map ? [...dag.nodes.values()] : Array.isArray(dag.nodes) ? dag.nodes : []
  for (const n of nodes) {
    if (!n) continue
    const role = n.role || ""
    if (role === INTEGRATOR_ROLE || role === "integrator") continue
    if (n.read_only === false) continue
    const status = n.status || ""
    if (status && status !== "completed") continue
    const text = String(n.result ?? n.findings ?? "").trim()
    if (!text && !(n.targetFiles || []).length) continue
    reports.push({
      role: role || "researcher",
      text,
      files: n.targetFiles || n.affectedFiles || [],
      ok: true,
    })
  }
  return reports
}

/**
 * If a plan has 2+ upstream read-only workers and a writer, insert one
 * integrator node before the writer. Idempotent. MICRO-shaped plans (one
 * researcher → coder) are left alone.
 */
export function ensureIntegrator(planDefs = []) {
  if (!Array.isArray(planDefs) || planDefs.length < 3) return Array.isArray(planDefs) ? planDefs : []
  if (planDefs.some((d) => d && (d.role === "integrator" || d.role === INTEGRATOR_ROLE))) {
    return planDefs.map((d) => ({ ...d }))
  }
  const defs = planDefs.map((d) => ({ ...d, dependencies: [...(d.dependencies || d.deps || [])] }))
  const writers = defs.filter((d) => d && (d.role === "coder" || d.read_only === false))
  if (!writers.length) return defs
  const byId = new Map(defs.map((d) => [String(d.id), d]))
  const upstream = new Set()
  const walk = (id, stack = new Set()) => {
    const sid = String(id)
    if (!sid || stack.has(sid)) return
    stack.add(sid)
    const n = byId.get(sid)
    if (!n) return
    for (const dep of n.dependencies || []) {
      upstream.add(String(dep))
      walk(dep, stack)
    }
  }
  for (const w of writers) walk(w.id)
  const workers = defs.filter((d) => {
    if (!upstream.has(String(d.id))) return false
    if (d.role === "coder" || d.read_only === false) return false
    return d.read_only === true || READ_ONLY.has(d.role)
  })
  if (workers.length < 2) return defs
  let id = "integrate"
  if (byId.has(id)) {
    let n = 2
    while (byId.has(`${id}${n}`)) n++
    id = `${id}${n}`
  }
  const node = {
    id,
    title: "Integrate worker findings",
    objective: "Merge researcher/tester/reviewer findings into one apply list. Do not write files.",
    dependencies: workers.map((w) => String(w.id)),
    role: "integrator",
    risk: "low",
    read_only: true,
    verificationRequirements: ["acceptance"],
  }
  const firstWriter = defs.findIndex((d) => d.role === "coder" || d.read_only === false)
  const at = firstWriter < 0 ? defs.length : firstWriter
  defs.splice(at, 0, node)
  for (const d of defs) {
    if (d.id === id) continue
    if (d.role === "coder" || d.read_only === false) {
      if (!d.dependencies.includes(id)) d.dependencies = [...d.dependencies, id]
    }
  }
  return defs
}

export function isIntegratorRole(role) {
  return role === "integrator" || role === INTEGRATOR_ROLE
}
