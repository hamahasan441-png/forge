/**
 * forge — compose pipeline (v41, v43 learned-plugin index, v44 playbook, v50 once-cache, zero dependencies)
 *
 * v32+ as one pass, one snapshot:
 *   index (v32) → world (v33 graph + v36 writes)
 *               → memory (stale-dropped against that world)
 *               → skills (v34 evaluator + v40 learned)
 *               → strategy (v40 hard-avoid)
 *               → tools (v34 plugins + v42 learned index + v39 focusedVerify)
 *
 * The planner and the context engine used to call those layers independently
 * (and the plan path skipped world / skills / verify entirely). This module
 * is the missing join. It does not spawn a second writer. It does not run
 * tests. It does not invent a toolchain. MICRO/SMALL still get zero auto
 * skill/plugin picks unless named. Learned plugins are indexed by reading
 * PLAYBOOK JSON — never imported, never hosted. Matching playbooks cite
 * their files into the world snapshot so the noTools planner sees what
 * worked (repair / files / command) without spawning plugin-host.
 * v47: long-term lessons and the v32 index locate files; the v33 graph
 * names the implementation a test already imports. Deterministic-first —
 * skip rediscovery when the knowledge graph already knows the file.
 * v50: composeOnce() reuses the snapshot for identical args (cap 8).
 * compose() stays uncached so a write is visible on the next plain call.
 * The context engine keeps its own generation cache and does not go
 * through composeOnce (mtime invalidation stays there).
 * v52: persisted tool outcomes join the snapshot as [tools] prefer/avoid.
 * MICRO/SMALL skip. compose() stays uncached. runCall is unchanged.
 * v53: pickSkills (tags/aliases) + hostless playbooks + ranked MCP names
 * join the same snapshot. Planner and execute share it. No skill dump.
 * compose never connects an MCP server.
 * v54: knowledge-gap ranking (required vs known vs skippable) joins the
 * snapshot as [gaps]/[skip]. Compose never writes knowgap.json — persist
 * is meta/CLI. MICRO/SMALL skip unless a domain is named. No second data root.
 * v55: [learn] names the cheapest acquisition method (skill → repo → docs
 * → web_search last). Compose never fetches, never dumps a page.
 * v56: ingestAcquire (agent/chat) records real tool runs as UNCERTAIN.
 * Compose still never writes. Next [learn] skips tried methods.
 * v57: [learn] is priority-capped (1, or 2 if both CRITICAL). Compose
 * still never writes or fetches.
 * v58: learned skills tagged CANDIDATE until a second 9/9 evolveRun.
 * v60: [blast] from the v33 graph (importers + tests + scope). Compose
 * never walks the repo and never writes. A miss is UNKNOWN, not "none".
 * v73: [claims] from the project subject store. Compose never writes
 * claims.json. MICRO/SMALL skip unless the subject is named.
 */
import path from "node:path"
import fs from "node:fs"
import { classifyTask, TASK_CLASS } from "./classify.js"
import { worldFromCwd, filesCited, radiusOf, indexSnapshot, implOf } from "./memgraph.js"
import { relevantMemory } from "./memory.js"
import { hardAvoid, mergeLearnedSkills, readLearnedSkill, HARD_AVOID_MIN } from "./evolve.js"
import { selectPlugins, scoreAgainst } from "./evaluate.js"
import { pickSkills } from "./skillforge.js"
import { pickPlugins, rankMcp, mcpCatalog, isMcpTool } from "./plugintel.js"
import { focusedVerify } from "./verify.js"
import { indexSkills, resolveSkillsDir, parseSkillPlaybook } from "./skills.js"
import { indexLearnedPlugins, KERNEL_HINT } from "./extend.js"
import { relevantLessons } from "./lessons.js"
import { relevantTools, formatToolMem, emptyTools } from "./toolintel.js"
import { detectGaps, emptyGaps, formatGaps } from "./knowgap.js"
import { listClaims, pickClaims, formatClaimLines } from "./claims.js"
import { blastFromWorld, emptyBlast, formatBlast } from "./impact.js"

const RADIUS_SHOW = 16
const FILE_SHOW = 8
const INDEX_SCAN = 200
const INDEX_HITS = 2
const SKIP_REL = /(?:^|\/)(node_modules|dist|\.next|target|vendor|coverage)(?:\/|$)/i

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

/** Caller names win. Fill repair/files/command from the learned index when the caller object lacks them. */
function unionPlugins(caller, extra) {
  const learned = new Map()
  for (const p of extra || []) {
    if (p && p.name) learned.set(p.name, p)
  }
  const out = []
  const seen = new Set()
  for (const p of caller || []) {
    if (!p || !p.name || seen.has(p.name)) continue
    seen.add(p.name)
    const hit = learned.get(p.name)
    if (hit && !p.repair && hit.repair) {
      out.push({
        ...p,
        repair: hit.repair,
        files: Array.isArray(p.files) && p.files.length ? p.files : hit.files,
        command: p.command || hit.command,
      })
    } else {
      out.push(p)
    }
  }
  for (const p of extra || []) {
    if (!p || !p.name || seen.has(p.name)) continue
    seen.add(p.name)
    out.push(p)
  }
  return out
}

function filesFromPlugins(plugins) {
  const out = []
  for (const p of plugins || []) {
    if (!p || p.isolated !== true) continue
    for (const f of p.files || []) out.push(f)
  }
  return uniq(out).slice(0, FILE_SHOW)
}

function filesFromSkills(skills) {
  const out = []
  for (const s of skills || []) {
    if (!s || !s.repair) continue
    for (const f of s.files || []) out.push(f)
  }
  return uniq(out).slice(0, FILE_SHOW)
}

function relKnowFile(f) {
  const s = posix(f).replace(/^\.\//, "").trim()
  if (!s || s.length > 160) return ""
  if (s.startsWith("/") || s.startsWith("~") || s.includes("://")) return ""
  if (s.split("/").some((p) => p === ".." || p === "")) return ""
  return s
}

function filesFromKnow(know) {
  const out = []
  for (const k of know || []) {
    if (!k || !k.repair) continue
    for (const f of k.files || []) out.push(f)
  }
  return uniq(out).slice(0, FILE_SHOW)
}

/** High-confidence lessons with a successful repair + files. Read-only. */
function indexKnow(cwd, task, klass) {
  if (isMicro(klass)) return []
  let hits = []
  try {
    hits = relevantLessons(task, { cwd, limit: 4, minConfidence: HARD_AVOID_MIN })
  } catch { return [] }
  const out = []
  for (const l of hits) {
    if (out.length >= 2) break
    const repair = String(l.successful_repair || l.solution || "").trim()
    if (!repair) continue
    if (KERNEL_HINT.test(repair)) continue
    const files = (Array.isArray(l.files) ? l.files : []).map(relKnowFile).filter(Boolean).slice(0, 4)
    if (!files.length) continue
    const stem = (files[0] || "repair").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 24).toLowerCase()
    out.push({
      name: `lesson-${stem || "repair"}`,
      repair: repair.slice(0, 240),
      files,
      command: "",
      source: "lesson",
    })
  }
  return out
}

/** Locate indexed files by symbol/basename overlap. MICRO skip. */
function filesFromIndex(cwd, task, klass) {
  if (isMicro(klass)) return []
  const q = String(task || "").trim()
  if (!q) return []
  let idx
  try { idx = indexSnapshot(cwd) } catch { return [] }
  const files = idx?.files
  if (!files || typeof files !== "object") return []
  const scored = []
  let n = 0
  for (const [rel, rec] of Object.entries(files)) {
    if (n >= INDEX_SCAN) break
    if (!rel || SKIP_REL.test(rel)) continue
    if (rec && rec.config) continue
    n++
    const base = String(rel.split("/").pop() || rel).replace(/\.[^.]+$/, "")
    const desc = Array.isArray(rec?.symbols) ? rec.symbols.slice(0, 24).join(" ") : ""
    const score = scoreAgainst(q, base, desc)
    if (score < 2) continue
    scored.push({ rel: posix(rel), score })
  }
  scored.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
  return scored.slice(0, INDEX_HITS).map((s) => s.rel)
}

/** Attach What-worked / files / command from learned SKILL.md. Never bundled pack.
 *  v64: also attach VERIFIED downloaded skills (path under skill-downloads). */
function attachSkillBodies(skills, cwd) {
  if (!Array.isArray(skills) || !skills.length) return skills || []
  for (const s of skills) {
    if (!s || !s.name || s.repair) continue
    let md = null
    if (s.downloaded && s.path) {
      try {
        const abs = path.resolve(String(s.path))
        const norm = abs.replace(/\\/g, "/")
        if (norm.includes("/skill-downloads/") && norm.endsWith("/SKILL.md") && !norm.includes("/../")) {
          md = fs.readFileSync(abs, "utf8")
        }
      } catch { md = null }
    } else if (s.learned === true) {
      try { md = readLearnedSkill(cwd, s.name) } catch { md = null }
    }
    if (!md) continue
    let parsed
    try { parsed = parseSkillPlaybook(md) } catch { parsed = { repair: "", files: [], command: "" } }
    let repair = String(parsed.repair || "").trim()
    if (!repair && s.downloaded) {
      const first = md.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#") && !l.startsWith("---") && !l.startsWith("-") && !/^name:|^description:/.test(l))
      if (first) repair = first.slice(0, 240)
    }
    if (!repair) continue
    if (KERNEL_HINT.test(repair)) continue
    s.repair = repair.slice(0, 240)
    s.files = Array.isArray(parsed.files) ? parsed.files.slice(0, 4) : []
    s.command = String(parsed.command || "").slice(0, 80)
  }
  return skills
}

export function playbookFilesOf(c) {
  return uniq([
    ...filesFromPlugins(c?.plugins),
    ...filesFromSkills(c?.skills),
    ...filesFromKnow(c?.know),
    ...(c?.world?.files || []),
  ]).slice(0, FILE_SHOW)
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
    playbooks: [],
    mcp: [],
    know: [],
    verify: { command: "", tests: [] },
    tools: emptyTools(),
    gaps: emptyGaps(),
    blast: emptyBlast(),
    claims: [],
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
  if (opts.includePlugins !== false) {
    let catalog = Array.isArray(opts.plugins) ? opts.plugins : []
    try {
      const learned = indexLearnedPlugins(cwd)
      if (learned.length) catalog = unionPlugins(catalog, learned)
    } catch { /* keep caller catalog */ }
    if (catalog.length) {
      try { out.plugins = selectPlugins(q, catalog, { klass }) } catch { out.plugins = [] }
    }
  }
  if (opts.includeSkills !== false) {
    let idx = opts.skillsIndex
    if (!Array.isArray(idx)) {
      try {
        const dir = resolveSkillsDir(opts.config?.skills?.dir)
        idx = mergeLearnedSkills(dir ? indexSkills(dir) : [], cwd)
      } catch { idx = [] }
    }
    if (Array.isArray(idx)) {
      try { out.skills = pickSkills(q, idx, { klass, cwd }) } catch { out.skills = [] }
      try { attachSkillBodies(out.skills, cwd) } catch { /* body is best-effort */ }
    }
  }
  if (opts.includeLessons !== false) {
    try { out.know = indexKnow(cwd, q, klass) } catch { out.know = [] }
  }
  const extraFiles = uniq([
    ...filesFromPlugins(out.plugins),
    ...filesFromSkills(out.skills),
    ...filesFromKnow(out.know),
    ...filesFromIndex(cwd, q, klass),
    ...(Array.isArray(opts.files) ? opts.files : []),
  ])
  try {
    out.world = composeWorld(cwd, {
      task: q,
      files: extraFiles,
    })
  } catch { /* keep empty world */ }
  const impl = implOf(out.world.files, out.world.graph, { max: FILE_SHOW })
  if (impl.length) {
    out.world.files = uniq([...out.world.files, ...impl]).slice(0, FILE_SHOW)
  }
  const world = out.world
  if (!isMicro(klass) && opts.includeBlast !== false) {
    try { out.blast = blastFromWorld({ files: world.files, graph: world.graph, cwd }) } catch { out.blast = emptyBlast() }
  }
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
  try { out.avoid = hardAvoid(q, { cwd, limit: 6 }) } catch { out.avoid = [] }
  if (opts.includeVerify !== false && world.files.length) {
    try { out.verify = focusedVerify(cwd, world.files) } catch { out.verify = { command: "", tests: [] } }
  }
  if (opts.includeTools !== false) {
    try { out.tools = relevantTools(q, { cwd, klass, limit: 4 }) } catch { out.tools = emptyTools() }
  }
  if (opts.includePlaybooks !== false) {
    try {
      const picked = pickPlugins(q, [], { klass })
      out.playbooks = (picked.playbooks || []).map((p) => (
        p?.downloaded && !p.repair
          ? { ...p, repair: String(p.description || "").slice(0, 240) }
          : p
      ))
    } catch { out.playbooks = [] }
  }
  if (opts.includeMcp !== false) {
    try {
      const live = Array.isArray(opts.mcp) ? opts.mcp : (opts.plugins || []).filter(isMcpTool)
      out.mcp = rankMcp(q, mcpCatalog(opts.config, live), { klass, limit: 4 })
    } catch { out.mcp = [] }
  }
  if (opts.includeGaps !== false) {
    try {
      out.gaps = detectGaps(q, {
        cwd, klass,
        memory: out.memory,
        skills: out.skills,
        know: out.know,
        world: out.world,
        playbooks: out.playbooks,
        blast: out.blast,
      })
    } catch { out.gaps = emptyGaps() }
  }
  if (opts.includeClaims !== false) {
    try { out.claims = pickClaims(q, listClaims(cwd), { klass, limit: 3 }) } catch { out.claims = [] }
  }
  return out
}

const ONCE_CAP = 8
const onceStore = new Map()

function onceKey(task, opts = {}) {
  const cwd = path.resolve(opts.cwd || process.cwd())
  const q = String(task ?? "").trim()
  const klass = opts.klass == null ? "" : String(opts.klass)
  const files = Array.isArray(opts.files) ? opts.files.map(String).filter(Boolean).slice(0, 16).join("\n") : ""
  const flags = [
    opts.includeMemory !== false ? "m" : "-",
    opts.includeSkills !== false ? "s" : "-",
    opts.includePlugins !== false ? "p" : "-",
    opts.includeLessons !== false ? "l" : "-",
    opts.includeVerify !== false ? "v" : "-",
    opts.includeTools !== false ? "t" : "-",
    opts.includePlaybooks !== false ? "b" : "-",
    opts.includeMcp !== false ? "c" : "-",
    opts.includeGaps !== false ? "g" : "-",
    opts.includeBlast !== false ? "r" : "-",
    opts.includeClaims !== false ? "k" : "-",
  ].join("")
  const plugs = Array.isArray(opts.plugins)
    ? opts.plugins.map((p) => p && p.name).filter(Boolean).slice(0, 8).join(",")
    : ""
  const mcp = Array.isArray(opts.mcp)
    ? opts.mcp.map((p) => p && p.name).filter(Boolean).slice(0, 8).join(",")
    : (opts.config?.mcp?.servers && typeof opts.config.mcp.servers === "object"
      ? Object.keys(opts.config.mcp.servers).slice(0, 8).join(",")
      : "")
  const skillsDir = opts.config?.skills?.dir ? String(opts.config.skills.dir) : ""
  return `${cwd}\0${q}\0${klass}\0${flags}\0${files}\0${plugs}\0${mcp}\0${skillsDir}`
}

/** Drop the in-process snapshot cache. Tests / a new task call this. */
export function clearComposeOnce() {
  onceStore.clear()
}

/**
 * Same as compose(), but identical args reuse the snapshot. refresh:true
 * recomputes. compose() itself stays uncached so a write is visible on the
 * next plain call. Cap 8. LRU bump on hit. Never spawns, never writes.
 */
export function composeOnce(task = "", opts = {}) {
  const refresh = opts && opts.refresh === true
  const clean = opts && typeof opts === "object" ? { ...opts } : {}
  delete clean.refresh
  const key = onceKey(task, clean)
  if (!refresh) {
    const hit = onceStore.get(key)
    if (hit) {
      onceStore.delete(key)
      onceStore.set(key, hit)
      return hit
    }
  }
  const snap = compose(task, clean)
  onceStore.delete(key)
  onceStore.set(key, snap)
  while (onceStore.size > ONCE_CAP) {
    const oldest = onceStore.keys().next().value
    if (oldest === undefined || oldest === key) break
    onceStore.delete(oldest)
  }
  return snap
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
  if (c.skills?.length) lines.push(`[skills] ${c.skills.map((s) => {
    if (!s || !s.name) return ""
    return s.lifecycle === "CANDIDATE" ? `${s.name} (candidate)` : s.name
  }).filter(Boolean).slice(0, 3).join(", ")}`)
  if (c.playbooks?.length) lines.push(`[playbooks] ${c.playbooks.map((p) => p.name).filter(Boolean).slice(0, 3).join(", ")}`)
  let bookN = 0
  for (const p of c.playbooks || []) {
    if (bookN >= 2) break
    if (!p?.downloaded) continue
    const hint = String(p.description || p.repair || "").trim()
    if (!hint) continue
    lines.push(`[playbook] ${p.name}: ${hint.slice(0, 160)}`)
    bookN++
  }
  let skillN = 0
  for (const s of c.skills || []) {
    if (skillN >= 2) break
    const repair = String(s.repair || "").trim()
    if (!repair) continue
    if (KERNEL_HINT.test(repair)) continue
    let line = `[skill] ${s.name}: ${repair.slice(0, 160)}`
    const files = (s.files || []).filter(Boolean).slice(0, 3).join(", ")
    if (files) line += ` — ${files}`
    const cmd = String(s.command || "").trim().slice(0, 80)
    if (cmd) line += ` — ${cmd}`
    lines.push(line)
    skillN++
  }
  let knowN = 0
  for (const k of c.know || []) {
    if (knowN >= 2) break
    const repair = String(k.repair || "").trim()
    if (!repair) continue
    if (KERNEL_HINT.test(repair)) continue
    let line = `[know] ${k.name}: ${repair.slice(0, 160)}`
    const files = (k.files || []).filter(Boolean).slice(0, 3).join(", ")
    if (files) line += ` — ${files}`
    lines.push(line)
    knowN++
  }
  const v = c.verify
  if (v && (v.command || (v.tests || []).length)) {
    const tests = (v.tests || []).slice(0, 4).join(", ")
    lines.push(`[verify next] ${v.command || "(none)"}${tests ? " — " + tests : ""}`)
  }
  const isolated = (c.plugins || []).filter((p) => p && p.isolated && p.name)
  if (isolated.length) lines.push(`[plugins] ${isolated.map((p) => p.name).slice(0, 4).join(", ")}`)
  let playN = 0
  for (const p of isolated) {
    if (playN >= 2) break
    const repair = String(p.repair || "").trim()
    if (!repair) continue
    if (KERNEL_HINT.test(repair)) continue
    let s = `[playbook] ${p.name}: ${repair.slice(0, 160)}`
    const files = (p.files || []).filter(Boolean).slice(0, 3).join(", ")
    if (files) s += ` — ${files}`
    const cmd = String(p.command || "").trim().slice(0, 80)
    if (cmd) s += ` — ${cmd}`
    lines.push(s)
    playN++
  }
  const toolsLine = formatToolMem(c.tools)
  if (toolsLine) lines.push(toolsLine)
  const mcpNames = (c.mcp || []).map((m) => m && m.name).filter(Boolean).slice(0, 4)
  if (mcpNames.length) lines.push(`[mcp] ${mcpNames.join(", ")}`)
  const blastLine = formatBlast(c.blast)
  if (blastLine) lines.push(blastLine)
  const gapBlock = formatGaps(c.gaps)
  if (gapBlock) lines.push(gapBlock)
  for (const line of formatClaimLines(c.claims)) lines.push(line)
  return lines.join("\n")
}

export { TASK_CLASS, filesCited }
