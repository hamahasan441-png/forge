/**
 * forge — smart capability router (v105 routewise, zero dependencies)
 *
 * The catalogs already exist (107 bundled skills, 100 MCP servers). Dumping
 * them into every prompt is the opposite of intelligence. This module decides
 * WHAT is offered on THIS turn:
 *
 *   native deterministic → verified skill → MCP → created → model
 *
 * Rules:
 *   MICRO/SMALL  — nothing auto-injected unless named in the task
 *   MEDIUM+      — tiny top-k, quality-gated (no CANDIDATE/stale unless named)
 *   INSPECT      — read-only externals only
 *   a capability native already covers is not re-offered as MCP/skill
 *   a gap recommends `forge mcp add` / `forge skill download` — never auto-installs
 *
 * v106: measured health (caplearn) withholds UNRELIABLE/BROKEN capabilities
 * for this task class unless the user named them. Reputation is conditional.
 *
 * Does not connect servers. Does not download skills. Ranks and withholds.
 */
import { namedIn, scoreAgainst } from "./evaluate.js"
import { TASK_CLASS } from "./classify.js"
import { searchCatalog } from "./mcpcatalog.js"
import { recommendRepos } from "./skillregistry.js"
import { isExternal, bareToolName } from "./capfabric.js"
import { shouldWithhold, reputation } from "./caplearn.js"

export const ROUTE_VERSION = "1.0.0"

export const KLASS_BUDGET = Object.freeze({
  MICRO: { skills: 0, mcp: 0 },
  SMALL: { skills: 0, mcp: 0 },
  trivial: { skills: 0, mcp: 0 },
  simple: { skills: 0, mcp: 0 },
  MEDIUM: { skills: 2, mcp: 4 },
  LARGE: { skills: 3, mcp: 6 },
  ARCHITECTURAL: { skills: 3, mcp: 8 },
  critical: { skills: 3, mcp: 6 },
})

const INSPECT_ACTIONS = new Set(["INSPECT", "SEARCH", "PLAN", "REPLAN"])
const VERIFY_ACTIONS = new Set(["VERIFY", "TEST", "REVIEW", "EXPERIMENT"])
const HALT_ACTIONS = new Set(["ASK", "WAIT", "STOP"])
const BAD_LIFE = new Set(["CANDIDATE", "DEPRECATED", "SUPERSEDED", "ARCHIVED"])

const MUTATING = /^(write|create|update|delete|push|commit|patch|edit|remove|insert|drop|destroy|publish|deploy|put|post|set|add|merge|close|approve)/i

export function budgetFor(klass = "MEDIUM") {
  return KLASS_BUDGET[klass] || KLASS_BUDGET.MEDIUM
}

export function isMutatingName(name) {
  const n = String(name || "")
  if (!n) return false
  const bare = n.includes("__") ? n.split("__").pop() : n
  return MUTATING.test(bare) || /_(write|create|update|delete|push|commit|patch|edit|remove)$/i.test(bare)
}

export function namedInTask(task, plugin) {
  const t = String(task || "")
  if (!t) return false
  const full = plugin?.name || plugin
  if (namedIn(t, full)) return true
  const bare = bareToolName(full)
  if (bare && bare !== full && namedIn(t, bare)) return true
  if (isExternal(plugin) || String(full).startsWith("mcp__")) {
    const parts = String(full).split("__")
    if (parts[1] && namedIn(t, parts[1])) return true
  }
  return false
}

/**
 * Apply klass + quality + inspect-safety policy to an already-selected
 * skill/MCP offer. Native tools are never touched.
 */
export function applyRoutePolicy({
  task = "",
  klass = "MEDIUM",
  action = "EXECUTE",
  skills = [],
  mcpKept = [],
  mcpDropped = [],
  nativeNames = [],
  store = null,
} = {}) {
  const budget = budgetFor(klass)
  const dropped = Array.isArray(mcpDropped) ? mcpDropped.slice() : []
  const trimmed = []
  const native = new Set((nativeNames || []).map(String))
  let skillsOut = Array.isArray(skills) ? skills.slice() : []
  let mcpOut = Array.isArray(mcpKept) ? mcpKept.slice() : []

  const dropMcp = (p, reason) => {
    dropped.push({ name: p?.name || p, reason })
    trimmed.push({ name: p?.name || p, kind: "mcp", reason })
  }
  const dropSkill = (s, reason) => {
    trimmed.push({ name: s?.name || s, kind: "skill", reason })
  }

  if (HALT_ACTIONS.has(action)) {
    for (const p of mcpOut) dropMcp(p, `governor ${action} — externals frozen`)
    for (const s of skillsOut) dropSkill(s, `governor ${action}`)
    return { skills: [], mcpKept: [], mcpDropped: dropped, trimmed, budget, policy: action }
  }

  // quality: CANDIDATE/stale never auto-injected; measured UNRELIABLE/BROKEN withheld
  skillsOut = skillsOut.filter((s) => {
    const named = namedIn(task, s?.name)
    if (s?.stale && !named) { dropSkill(s, "stale playbook — not named in the task"); return false }
    if (BAD_LIFE.has(String(s?.lifecycle || "").toUpperCase()) && !named) {
      dropSkill(s, `${s.lifecycle} skill — not named in the task`)
      return false
    }
    if (store && shouldWithhold(store, { name: s?.name, kind: "skill", klass, named })) {
      dropSkill(s, `measured ${klass || "task"} health is UNRELIABLE/BROKEN — withheld`)
      return false
    }
    return true
  })
  if (store) {
    skillsOut.sort((a, b) =>
      reputation(store, { name: b?.name, kind: "skill", klass }) - reputation(store, { name: a?.name, kind: "skill", klass })
      || String(a?.name || "").localeCompare(String(b?.name || ""))
    )
  }

  // native already covers this name → drop the duplicate external
  mcpOut = mcpOut.filter((p) => {
    const bare = bareToolName(p?.name)
    if (bare && native.has(bare) && !namedInTask(task, p)) {
      dropMcp(p, `native "${bare}" already covers this`)
      return false
    }
    const named = namedInTask(task, p)
    if (store && shouldWithhold(store, { name: p?.name, kind: "mcp", klass, named })) {
      dropMcp(p, `measured ${klass || "task"} health is UNRELIABLE/BROKEN — withheld`)
      return false
    }
    return true
  })

  // klass budget — MICRO/SMALL keep only what the user named
  if (budget.mcp === 0) {
    mcpOut = mcpOut.filter((p) => {
      if (namedInTask(task, p)) return true
      dropMcp(p, `${klass} does not auto-inject MCP`)
      return false
    })
  }
  if (budget.skills === 0) {
    skillsOut = skillsOut.filter((s) => {
      if (namedIn(task, s?.name)) return true
      dropSkill(s, `${klass} does not auto-inject skills`)
      return false
    })
  }

  // INSPECT/VERIFY: mutating MCP is withheld (read-only MCP may stay)
  if (INSPECT_ACTIONS.has(action) || VERIFY_ACTIONS.has(action)) {
    mcpOut = mcpOut.filter((p) => {
      const mutating = p?.readOnly === false || isMutatingName(p?.name)
      if (mutating && p?.readOnly !== true) {
        dropMcp(p, `governor ${action} — mutating MCP withheld`)
        return false
      }
      return true
    })
  }

  // cap to klass budget (named items are pinned)
  const cap = (list, n, kind, nameOf) => {
    if (n <= 0 || list.length <= n) return list
    const pinned = []
    const rest = []
    for (const item of list) {
      const nm = nameOf(item)
      if (namedIn(task, nm) || namedInTask(task, item)) pinned.push(item)
      else rest.push(item)
    }
    const keep = [...pinned, ...rest.slice(0, Math.max(0, n - pinned.length))]
    const keepSet = new Set(keep.map(nameOf))
    for (const item of list) {
      if (!keepSet.has(nameOf(item))) {
        if (kind === "mcp") dropMcp(item, `over the ${n}-${kind} budget for ${klass}`)
        else dropSkill(item, `over the ${n}-${kind} budget for ${klass}`)
      }
    }
    return keep
  }
  skillsOut = cap(skillsOut, budget.skills || (skillsOut.length && budget.skills === 0 ? 0 : budget.skills), "skill", (s) => s?.name)
  mcpOut = cap(mcpOut, budget.mcp, "mcp", (p) => p?.name)

  return { skills: skillsOut, mcpKept: mcpOut, mcpDropped: dropped, trimmed, budget, policy: `${klass}/${action}` }
}

/**
 * When native/skill/MCP/created all miss a capability, recommend an install
 * path. Never connects, never downloads.
 */
export function recommendForGaps({ task = "", gaps = [], limit = 3 } = {}) {
  const q = [task, ...(Array.isArray(gaps) ? gaps : [])].filter(Boolean).join(" ")
  const out = []
  try {
    for (const e of searchCatalog(q, { limit: Math.max(1, limit) })) {
      out.push({
        kind: "mcp",
        name: e.name,
        how: `forge mcp add ${e.name}`,
        desc: String(e.desc || "").slice(0, 140),
        score: e.score ?? 0,
      })
    }
  } catch { /* catalog is offline data */ }
  try {
    for (const r of recommendRepos(q).slice(0, limit)) {
      const ex = r.examples?.[0]
      out.push({
        kind: "skill",
        name: ex?.name || r.repo,
        how: ex?.url ? `forge skill download ${ex.url}` : `forge skill recommend ${r.repo}`,
        desc: String(r.desc || "").slice(0, 140),
        score: r.score ?? 0,
      })
    }
  } catch { /* repos are data */ }
  out.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name))
  const seen = new Set()
  const uniq = []
  for (const r of out) {
    const k = `${r.kind}:${r.name}`
    if (seen.has(k)) continue
    seen.add(k)
    uniq.push(r)
    if (uniq.length >= limit) break
  }
  return uniq
}

export function formatRecommendations(recs = []) {
  const list = Array.isArray(recs) ? recs : []
  if (!list.length) return ""
  const lines = ["CAPABILITY RECOMMENDATIONS (not installed — explicit add/download only):"]
  for (const r of list) lines.push(`- [${r.kind}] ${r.name}: ${r.how}${r.desc ? ` — ${r.desc}` : ""}`)
  return lines.join("\n")
}

export function formatRoute(result) {
  if (!result) return ""
  const s = result.skills?.length ?? 0
  const m = result.mcpKept?.length ?? 0
  const t = result.trimmed?.length ?? 0
  return `ROUTE ${result.policy || ""}: ${s} skill(s), ${m} mcp, ${t} withheld`
}

/** Score a skill against a task with tag/alias boost. Used by tests + callers. */
export function skillRelevance(task, skill) {
  return scoreAgainst(task, skill?.name, `${skill?.desc || ""} ${(skill?.tags || []).join(" ")}`)
}
