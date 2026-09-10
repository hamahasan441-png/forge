/**
 * forge — skill evaluator + plugin selector (v34, zero dependencies)
 *
 * UNIFIED §17 / skills+plugins used the right way:
 *   - score SKILL.md packs against the current task; inject top-k, not 40 names
 *   - MICRO/SMALL get zero auto-picks (a typo does not load coding-agent)
 *   - a checkSkills failure is never selected
 *   - user plugins (isolated children) join the tool schema only when they
 *     match the task or are named in it; MCP/LSP always pass through
 *
 * Skills are markdown playbooks. Plugins are isolated tools. Not the same.
 * No implicit grants. FORGE_SKILLS_ALL=1 restores the dump for debugging.
 */
import { classifyTask, TASK_CLASS } from "./classify.js"

const STOP = new Set([
  "the", "and", "for", "with", "from", "this", "that", "use", "using", "when",
  "skill", "agent", "into", "your", "you", "are", "was", "were", "will", "can",
  "not", "but", "all", "any", "how", "what", "why", "who", "its", "our", "out",
])

const TOP_K = 3
const MIN_SCORE = 2

export function tokens(s) {
  return String(s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t))
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function namedIn(task, name) {
  const n = String(name ?? "").trim()
  if (!n) return false
  const t = String(task ?? "")
  if (new RegExp(`(?:^|[^A-Za-z0-9])${escapeRe(n)}(?:[^A-Za-z0-9]|$)`, "i").test(t)) return true
  const slug = n.replace(/[_-]+/g, " ")
  if (slug !== n && new RegExp(`(?:^|[^A-Za-z0-9])${escapeRe(slug)}(?:[^A-Za-z0-9]|$)`, "i").test(t)) return true
  return false
}

/** Lexical score: name hits weigh more than description hits. */
export function scoreAgainst(task, name, desc) {
  const q = tokens(task)
  if (!q.length) return 0
  let score = 0
  const nameTok = tokens(name)
  const descTok = tokens(desc)
  const nameSet = new Set(nameTok)
  const descSet = new Set(descTok)
  const hay = `${String(name ?? "")} ${String(desc ?? "")}`.toLowerCase()
  for (const t of q) {
    if (nameSet.has(t)) score += 3
    else if (descSet.has(t)) score += 2
    else if (hay.includes(t)) score += 1
  }
  if (namedIn(task, name)) score += 10
  return score
}

function resolvedKlass(task, opts = {}) {
  if (opts.klass) return opts.klass
  try { return classifyTask(task).class } catch { return TASK_CLASS.MEDIUM }
}

function failedNames(skills) {
  const bad = new Set()
  for (const s of skills) if (s && s.ok === false) bad.add(s.name)
  return bad
}

/**
 * Pick the skills that actually match this task.
 * @param task  {string}
 * @param skills {Array<{name, desc, path, ok?}>}
 * @param opts  {klass, topK, minScore, skillsDir, all}
 * @returns {Array<{name, desc, score}>}
 */
export function evaluateSkills(task, skills = [], opts = {}) {
  const list = Array.isArray(skills) ? skills : []
  const q = String(task ?? "").trim()
  if (!q || !list.length) return []
  if (opts.all === true || process.env.FORGE_SKILLS_ALL === "1") {
    return list.filter((s) => s && s.name).slice(0, opts.topK ?? 40).map((s) => ({
      name: s.name, desc: String(s.desc ?? "").slice(0, 110), score: 0,
    }))
  }
  const klass = resolvedKlass(q, opts)
  const micro = klass === TASK_CLASS.MICRO || klass === TASK_CLASS.SMALL
  const bad = failedNames(list)
  const topK = Math.max(0, Number(opts.topK) || TOP_K)
  const min = opts.minScore == null ? MIN_SCORE : Number(opts.minScore)
  const scored = []
  for (const s of list) {
    if (!s || !s.name) continue
    if (bad.has(s.name)) continue
    const explicit = namedIn(q, s.name)
    if (micro && !explicit) continue
    const score = scoreAgainst(q, s.name, s.desc || "")
    if (explicit || score >= min) scored.push({ name: s.name, desc: String(s.desc ?? "").slice(0, 160), score })
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return scored.slice(0, topK)
}

export function formatSkillPicks(picks = []) {
  if (!Array.isArray(picks) || !picks.length) return ""
  const lines = [`SKILLS FOR THIS TASK (${picks.length}) — call load_skill(name) before using one:`]
  for (const s of picks) lines.push(`- ${s.name}: ${s.desc || ""}`.trim())
  return lines.join("\n")
}

/**
 * Compact "use these, in this order" block for repair / execute.
 * Playbook first (known repair — fast). Then matching skills. Then avoid.
 * Never dumps the 40-name pack. MICRO callers pass empty plugins.
 */
export function formatSteer({ skills = [], plugins = [], avoid = [] } = {}) {
  const lines = []
  const books = (plugins || []).filter((p) => p && p.isolated && p.repair).slice(0, 2)
  if (books.length) {
    lines.push("TRY FIRST (known repair — apply it, then verify; do not rediscover):")
    for (const p of books) {
      const files = (p.files || []).filter(Boolean).slice(0, 3).join(", ")
      const cmd = String(p.command || "").trim()
      let s = `- ${p.name}: ${String(p.repair).slice(0, 160)}`
      if (files) s += ` — ${files}`
      if (cmd) s += ` — then ${cmd}`
      lines.push(s)
    }
  }
  const skillNames = (skills || []).map((s) => s && s.name).filter(Boolean).slice(0, 3)
  if (skillNames.length) {
    lines.push(`SKILLS (call load_skill before using): ${skillNames.join(", ")}`)
  }
  const isolated = (plugins || []).filter((p) => p && p.isolated && p.name).map((p) => p.name)
  if (isolated.length && !books.length) {
    lines.push(`PLUGINS (isolated, matching): ${isolated.slice(0, 4).join(", ")}`)
  }
  if (avoid?.length) lines.push(`AVOID: ${avoid.slice(0, 4).join("; ")}`)
  return lines.join("\n")
}

/**
 * User plugins (isolated === true) are omitted from this-turn schema unless
 * they match. MCP / LSP / anything not isolated always stays.
 * MICRO/SMALL: only a plugin whose name is in the task.
 */
export function selectPlugins(task, plugins = [], opts = {}) {
  const list = Array.isArray(plugins) ? plugins : []
  const always = []
  const candidates = []
  for (const p of list) {
    if (!p || !p.name) continue
    if (p.isolated === true) candidates.push(p)
    else always.push(p)
  }
  if (!candidates.length) return [...always]
  const q = String(task ?? "").trim()
  const klass = resolvedKlass(q, opts)
  const micro = klass === TASK_CLASS.MICRO || klass === TASK_CLASS.SMALL
  const picked = []
  for (const p of candidates) {
    const desc = p.def?.function?.description || p.description || ""
    const explicit = namedIn(q, p.name)
    if (explicit) { picked.push(p); continue }
    if (micro) continue
    if (scoreAgainst(q, p.name, desc) >= (opts.minScore == null ? MIN_SCORE : Number(opts.minScore))) {
      picked.push(p)
    }
  }
  return [...always, ...picked]
}

export { TASK_CLASS }
