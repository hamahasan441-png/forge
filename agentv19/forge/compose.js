/**
 * forge — compose pipeline (v41, zero dependencies)
 *
 * v32+ as one pass, one snapshot:
 *   index (v32) → world (v33 graph + v36 writes)
 *               → memory (stale-dropped against that world)
 *               → skills (v34 evaluator + v40 learned)
 *               → strategy (v40 hard-avoid)
 *               → tools (v34 plugins + v39 focusedVerify)
 *
 * The planner and the context engine used to call those layers independently
 * (and the plan path skipped world / skills / verify entirely). This module
 * is the missing join. It does not spawn a second writer. It does not run
 * tests. It does not invent a toolchain. MICRO/SMALL still get zero auto
 * skill/plugin picks unless named.
 */
import path from "node:path"
import { classifyTask, TASK_CLASS } from "./classify.js"
import { worldFromCwd, filesCited, radiusOf } from "./memgraph.js"
import { relevantMemory } from "./memory.js"
import { hardAvoid, mergeLearnedSkills } from "./evolve.js"
import { evaluateSkills, selectPlugins } from "./evaluate.js"
import { focusedVerify } from "./verify.js"
import { indexSkills, resolveSkillsDir } from "./skills.js"

const RADIUS_SHOW = 16
const FILE_SHOW = 8

function posix(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\.\//, "")
}

function uniq(list) {
  const out = []
  const seen = new Set()
  for (const x of list || []) {
    const s = posix(x)
    if (!s) continue
    const k = s.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(s)
  }
  return out
}

function resolvedKlass(task, klass) {
  if (klass) return klass
  const q = String(task || "").trim()
  if (!q) return null
  try { return classifyTask(q).class } catch { return TASK_CLASS.MEDIUM }
}

function isMicro(klass) {
  return klass === TASK_CLASS.MICRO || klass === TASK_CLASS.SMALL
}

function langOfFile(file) {
  const ext = path.extname(posix(file)).toLowerCase()
  return {
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".tsx": "typescript", ".jsx": "javascript",
    ".rs": "rust", ".py": "python", ".go": "go", ".java": "java",
    ".rb": "ruby", ".php": "php",
  }[ext] || ""
}

function langsFrom(graph, paths) {
  const look = new Set((paths || []).map((p) => posix(p).toLowerCase()))
  const bases = new Set([...look].map((p) => p.split("/").pop()))
  const out = []
  const seen = new Set()
  for (const n of graph?.files || []) {
    const p = posix(n.path || n.rel)
    if (!p) continue
    if (!look.has(p.toLowerCase()) && !bases.has(p.split("/").pop().toLowerCase())) continue
    const lang = n.lang
    if (lang && lang !== "unknown" && !seen.has(lang)) { seen.add(lang); out.push(lang) }
  }
  if (!out.length) {
    for (const f of paths || []) {
      const lang = langOfFile(f)
      if (lang && !seen.has(lang)) { seen.add(lang); out.push(lang) }
    }
  }
  return out
}

export function emptyWorld() {
  return {
    indexed: false,
    files: [],
    radius: [],
    langs: [],
    stats: { files: 0, edges: 0 },
    writes: {},
    graph: { files: [], edges: [] },
  }
}

export function emptyCompose(klass = null) {
  return {
    klass,
    micro: isMicro(klass),
    world: emptyWorld(),
    memory: "",
    memoryCount: 0,
    skills: [],
    avoid: [],
    plugins: [],
    verify: { command: "", tests: [] },
  }
}

/**
 * Cited files (task text + explicit list) plus the v32/v33/v36 world snapshot.
 * Empty index → files still come from the task; radius is just those files.
 */
export function composeWorld(cwd = process.cwd(), { task = "", files = [] } = {}) {
  const cited = uniq([...(Array.isArray(files) ? files : []), ...filesCited(task)]).slice(0, FILE_SHOW)
  let snap
  try { snap = worldFromCwd(cwd) } catch { snap = { writes: {}, graph: { files: [], edges: [] } } }
  const graph = snap.graph && typeof snap.graph === "object" ? snap.graph : { files: [], edges: [] }
  const indexed = Array.isArray(graph.files) && graph.files.length > 0
  let radius = cited.slice()
  if (cited.length && indexed) {
    try { radius = uniq(radiusOf(cited, graph, { max: RADIUS_SHOW })).slice(0, RADIUS_SHOW) } catch { radius = cited.slice() }
  }
  return {
    indexed,
    files: cited,
    radius,
    langs: langsFrom(graph, cited.length ? [...cited, ...radius] : []),
    stats: {
      files: Array.isArray(graph.files) ? graph.files.length : 0,
      edges: Array.isArray(graph.edges) ? graph.edges.length : 0,
    },
    writes: snap.writes && typeof snap.writes === "object" ? snap.writes : {},
    graph,
  }
}

/**
 * One pipeline pass. Empty task → empty compose. Never throws.
 */
export function compose(task = "", opts = {}) {
  const cwd = opts.cwd || process.cwd()
  const q = String(task ?? "").trim()
  const klass = resolvedKlass(q, opts.klass)
  const out = emptyCompose(klass)
  if (!q) return out
  try { out.world = composeWorld(cwd, { task: q, files: opts.files }) } catch { /* keep empty world */ }
  const world = out.world
  if (opts.includeMemory !== false) {
    try {
      const mem = relevantMemory(q, {
        cwd,
        limit: opts.memoryLimit || 6,
        writes: world.writes,
        graph: world.graph,
      })
      out.memory = mem || ""
      out.memoryCount = (out.memory || "").split("\n").filter((l) => l.startsWith("- ")).length
    } catch { /* miss is no memory */ }
  }
  if (opts.includeSkills !== false) {
    let idx = opts.skillsIndex
    if (!Array.isArray(idx)) {
      try {
        const dir = resolveSkillsDir(opts.config?.skills?.dir)
        idx = mergeLearnedSkills(dir ? indexSkills(dir) : [], cwd)
      } catch { idx = [] }
    }
    if (Array.isArray(idx) && idx.length) {
      try { out.skills = evaluateSkills(q, idx, { klass }) } catch { out.skills = [] }
    }
  }
  try { out.avoid = hardAvoid(q, { cwd, limit: 6 }) } catch { out.avoid = [] }
  if (Array.isArray(opts.plugins) && opts.plugins.length) {
    try { out.plugins = selectPlugins(q, opts.plugins, { klass }) } catch { out.plugins = [] }
  }
  if (opts.includeVerify !== false && world.files.length) {
    try { out.verify = focusedVerify(cwd, world.files) } catch { out.verify = { command: "", tests: [] } }
  }
  return out
}

export function formatWorld(world) {
  if (!world) return ""
  const files = world.files || []
  if (!files.length) return ""
  const self = new Set(files.map((f) => f.toLowerCase()))
  const extra = (world.radius || []).filter((p) => !self.has(String(p).toLowerCase())).slice(0, 6)
  const langs = (world.langs || []).filter(Boolean).slice(0, 4).join(", ")
  let s = `[world] ${files.slice(0, 6).join(", ")}`
  if (extra.length) s += ` → ${extra.join(", ")}`
  if (langs) s += ` (${langs})`
  if (world.indexed && world.stats?.files) s += ` [${world.stats.files} indexed]`
  return s
}

/**
 * Compact pipeline block for the planner / system prompt.
 * Memory text is not dumped (the context engine already injects it); a count
 * is enough so the model knows notes survived the world-model filter.
 */
export function formatCompose(c) {
  if (!c) return ""
  const lines = []
  const w = formatWorld(c.world)
  if (w) lines.push(w)
  if (c.memoryCount) lines.push(`[memory] ${c.memoryCount} note${c.memoryCount === 1 ? "" : "s"}`)
  if (c.avoid?.length) lines.push(`[avoid] ${c.avoid.slice(0, 4).join("; ")}`)
  if (c.skills?.length) lines.push(`[skills] ${c.skills.map((s) => s.name).filter(Boolean).slice(0, 3).join(", ")}`)
  const v = c.verify
  if (v && (v.command || (v.tests || []).length)) {
    const tests = (v.tests || []).slice(0, 4).join(", ")
    lines.push(`[verify next] ${v.command || "(none)"}${tests ? " — " + tests : ""}`)
  }
  const isolated = (c.plugins || []).filter((p) => p && p.isolated && p.name).map((p) => p.name)
  if (isolated.length) lines.push(`[plugins] ${isolated.slice(0, 4).join(", ")}`)
  return lines.join("\n")
}

export { TASK_CLASS, filesCited }
