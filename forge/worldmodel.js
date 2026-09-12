/**
 * forge — semantic project world model (v91 ∞ CORE §5, zero dependencies)
 *
 * The World Model is CURRENT PROJECT TRUTH; Memory is historical knowledge —
 * the two are never conflated (§5). v90 had all the facts scattered across
 * the incremental index (index.js), the semantic graph (repomap.js), the
 * cross-language graph (xlang.js) and impact analysis (impact.js) — joined
 * ad-hoc by compose.js. The spec wants one queryable model that answers:
 *
 *   What exists?  Where is it?  What depends on it?  What does it depend on?
 *   What will break if it changes?  What tests cover it?  Which language
 *   owns it?  Which service consumes it?  Which configuration controls it?
 *   What changed recently?
 *
 * This module OWNS the join and the query API. It builds on the existing
 * builders (never re-scans what they already scanned, never duplicates their
 * parsing), stays bounded like they do, and never throws: a half-built world
 * is returned with `degraded: true` rather than an error.
 */
import path from "node:path"
import { buildSemanticGraph, buildCrossGraph } from "./repomap.js"
import { impactRadius } from "./impact.js"
import { consumersOf, testsForFiles, implForFiles } from "./xlang.js"
import { detectLanguage } from "./lang.js"
import { loadIndex } from "./index.js"

export const WORLD_LIMITS = {
  maxQueryResults: 40,
  maxRecent: 30,
}

export function emptyWorldModel() {
  return {
    root: null,
    builtAt: 0,
    degraded: false,
    files: [],       // [{ path, lang, symbols, imports, exports, calls, types, isTest, isConfig, contracts }]
    edges: [],       // [{ from, to, kind }]
    stats: {},
    langs: {},       // lang → file count
    contracts: [],   // HTTP/SQL/proto/openapi/… contracts
    symbolsIndex: new Map(), // symbol → [paths]
  }
}

export function createWorldModel({ cwd = process.cwd(), maxFiles = 500 } = {}) {
  let world = null
  let building = false

  function build(force = false) {
    if (world && !force) return world
    if (building) return world ?? emptyWorldModel()
    building = true
    try {
      const g = buildSemanticGraph(cwd, { maxFiles })
      const xg = buildCrossGraph(cwd, { maxFiles })
      const w = emptyWorldModel()
      w.root = path.resolve(cwd)
      w.builtAt = Date.now()
      w.files = (g.files ?? []).map((f) => ({
        path: f.path,
        lang: langId(f.lang) === "unknown" ? langId(detectLanguage(f.path)) : langId(f.lang),
        symbols: f.symbols ?? [],
        imports: f.imports ?? [],
        exports: f.exports ?? [],
        calls: f.calls ?? [],
        types: f.types ?? [],
        isTest: !!f.isTest,
        isConfig: !!f.isConfig,
        contracts: f.contracts ?? [],
      }))
      w.edges = g.edges ?? []
      w.stats = { ...(g.stats ?? {}), crossEdges: (xg.edges ?? []).length }
      // language census
      for (const f of w.files) w.langs[f.lang] = (w.langs[f.lang] ?? 0) + 1
      // contracts from both graphs (xlang covers HTTP/SQL/proto across langs)
      const seen = new Set()
      for (const f of w.files) {
        for (const c of f.contracts ?? []) {
          const k = `${c.kind}:${c.name}`
          if (seen.has(k)) continue
          seen.add(k)
          w.contracts.push({ kind: c.kind, name: c.name, file: f.path })
        }
      }
      // symbol index: symbol name → owning files (bounded)
      w.symbolsIndex = new Map()
      for (const f of w.files) {
        for (const s of f.symbols ?? []) {
          if (!w.symbolsIndex.has(s)) w.symbolsIndex.set(s, [])
          const owners = w.symbolsIndex.get(s)
          if (owners.length < 8) owners.push(f.path)
        }
      }
      w.degraded = !w.files.length
      world = w
      return w
    } catch {
      world = { ...emptyWorldModel(), root: path.resolve(cwd), builtAt: Date.now(), degraded: true }
      return world
    } finally {
      building = false
    }
  }

  /** Files matching a substring (path or symbol). */
  function locate(query, { limit = WORLD_LIMITS.maxQueryResults } = {}) {
    const w = build()
    const q = String(query ?? "").trim().toLowerCase()
    if (!q) return []
    const out = []
    for (const f of w.files) {
      if (f.path.toLowerCase().includes(q)) { out.push({ kind: "file", path: f.path, lang: f.lang }); continue }
      if ((f.symbols ?? []).some((s) => s.toLowerCase().includes(q))) out.push({ kind: "file", path: f.path, lang: f.lang, via: "symbol" })
      if (out.length >= limit) break
    }
    return out.slice(0, limit)
  }

  /** Direct importers of a path (who breaks if this change?). Import
   *  specifiers are RESOLVED relative to the importer before matching. */
  function dependents(file) {
    const w = build()
    const rel = normalize(file)
    const out = new Set()
    for (const e of w.edges) {
      if (e.kind !== "IMPORT") continue
      if (e.to === rel || path.basename(e.to) === path.basename(rel)) { out.add(e.from); continue }
      // resolve './x.js' relative to the importer's directory
      try {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(e.from), e.to))
        if (resolved === rel) out.add(e.from)
      } catch { }
    }
    return [...out].slice(0, WORLD_LIMITS.maxQueryResults)
  }

  /** What this file pulls in. */
  function dependenciesOf(file) {
    const w = build()
    const rec = w.files.find((f) => f.path === normalize(file))
    return rec ? [...new Set(rec.imports ?? [])].slice(0, WORLD_LIMITS.maxQueryResults) : []
  }

  /** §5 "what will break" — impact radius through the existing impact engine. */
  function impact(files) {
    const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
    if (!list.length) return null
    try {
      return impactRadius({ files: list, cwd, graph: buildCrossGraph(cwd, { maxFiles }) })
    } catch {
      return { files: list, importers: [], tests: [], configs: [], radius: list.length, unknown: true, degraded: true }
    }
  }

  /** Which tests exercise this file (xlang cross-graph + graph test flag). */
  function testsFor(files) {
    const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
    if (!list.length) return []
    try {
      const g = buildCrossGraph(cwd, { maxFiles })
      return testsForFiles(list, g, { cwd }).slice(0, WORLD_LIMITS.maxQueryResults)
    } catch { return [] }
  }

  function languageOf(file) {
    const w = build()
    const rel = normalize(file)
    const rec = w.files.find((f) => f.path === rel)
    return rec?.lang ?? langId(detectLanguage(rel))
  }

  /** Runtime/service consumers of a contract or file (xlang consumersOf). */
  function consumers(files) {
    const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
    if (!list.length) return []
    try {
      return consumersOf(list, buildCrossGraph(cwd, { maxFiles }), { cwd }).slice(0, WORLD_LIMITS.maxQueryResults)
    } catch { return [] }
  }

  /** Implementations behind a contract (interface → impl across langs). */
  function implementations(files) {
    const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
    if (!list.length) return []
    try {
      return implForFiles(list, buildCrossGraph(cwd, { maxFiles }), { cwd }).slice(0, WORLD_LIMITS.maxQueryResults)
    } catch { return [] }
  }

  /** Config files controlling a path (heuristic: same directory or project root). */
  function controllingConfig(file) {
    const w = build()
    const rel = normalize(file)
    const dir = path.posix.dirname(rel)
    return w.files
      .filter((f) => f.isConfig)
      .filter((f) => f.path === rel || path.posix.dirname(f.path) === dir || !path.posix.dirname(f.path).includes("/"))
      .slice(0, 12)
      .map((f) => f.path)
  }

  /** §5 "what changed recently" — mtime census from the incremental index. */
  function recentChanges(since = Date.now() - 24 * 3600 * 1000, { limit = WORLD_LIMITS.maxRecent } = {}) {
    const w = build()
    void w
    let idx = null
    try { idx = loadIndex(cwd) } catch { }
    const out = []
    const files = idx?.files ?? {}
    for (const [p, rec] of Object.entries(files)) {
      const mt = Number(rec?.mtime ?? 0)
      if (mt >= since) out.push({ path: p, mtime: mt })
    }
    out.sort((a, b) => b.mtime - a.mtime)
    return out.slice(0, limit)
  }

  /** The §5 question answerer — routes natural questions at the queries. */
  function answer(question) {
    const q = String(question ?? "").trim()
    if (!q) return { answer: null, method: "empty" }
    const w = build()
    const ql = q.toLowerCase()
    // "what depends on X" / "who imports X"
    const dep = ql.match(/(?:what depends on|who imports|who uses|consumers of)\s+([\w./@-]+)/)
    if (dep) {
      const target = dep[1]
      const deps = dependents(target)
      const consumersList = consumers(target)
      return { answer: { target, dependents: deps, consumers: consumersList }, method: "dependents" }
    }
    // "what will break if X changes"
    const brk = ql.match(/(?:what breaks?|what will break|impact of|blast radius of)\s+(?:if\s+)?([\w./@-]+)/)
    if (brk) {
      const im = impact(brk[1])
      return { answer: { target: brk[1], ...im }, method: "impact" }
    }
    // "what tests cover X"
    const tst = ql.match(/(?:what tests|which tests|tests (?:for|covering|cover))\s+([\w./@-]+)/)
    if (tst) return { answer: { target: tst[1], tests: testsFor(tst[1]) }, method: "tests" }
    // "where is X"
    const loc = ql.match(/(?:where is|find|locate|show me)\s+([\w./@-]+)/)
    if (loc) return { answer: { target: loc[1], matches: locate(loc[1]) }, method: "locate" }
    // "what language is X"
    const lng = ql.match(/(?:what language|which language)\s+(?:is\s+)?([\w./@-]+)/)
    if (lng) return { answer: { target: lng[1], language: languageOf(lng[1]) }, method: "language" }
    // "what changed recently"
    if (/what changed|recent changes|recently modified/.test(ql)) {
      return { answer: { changes: recentChanges() }, method: "recent" }
    }
    // fallback: locate
    const matches = locate(q.replace(/[?.]/g, ""))
    return { answer: { matches }, method: "locate-fallback" }
  }

  /** Compact summary for the planner/context engine. */
  function summarize({ maxLines = 24 } = {}) {
    const w = build()
    const lines = [`WORLD MODEL: ${w.stats.totalFiles ?? w.files.length} files, ${w.stats.totalEdges ?? w.edges.length} edges${w.degraded ? " (degraded)" : ""}`]
    const langs = Object.entries(w.langs).sort((a, b) => b[1] - a[1]).slice(0, 6)
    if (langs.length) lines.push(`Languages: ${langs.map(([l, n]) => `${l}(${n})`).join(" ")}`)
    if (w.contracts.length) {
      lines.push(`Contracts: ${w.contracts.slice(0, 6).map((c) => `${c.kind}:${c.name}`).join(", ")}${w.contracts.length > 6 ? ` +${w.contracts.length - 6}` : ""}`)
    }
    const tests = w.files.filter((f) => f.isTest).length
    const configs = w.files.filter((f) => f.isConfig).length
    if (tests || configs) lines.push(`Tests: ${tests} · Config: ${configs}`)
    return lines.slice(0, maxLines).join("\n")
  }

  function snapshot() {
    const w = build()
    return {
      root: w.root, builtAt: w.builtAt, degraded: w.degraded,
      stats: w.stats, langs: w.langs, contracts: w.contracts.slice(0, 64),
      files: w.files.length, edges: w.edges.length,
    }
  }

  return {
    build, locate, dependents, dependenciesOf, impact, testsFor, languageOf,
    consumers, implementations, controllingConfig, recentChanges, answer, summarize, snapshot,
    get world() { return build() },
  }
}

function normalize(f) {
  return String(f ?? "").replace(/\\/g, "/").replace(/^\.\//, "")
}

/** detectLanguage returns an adapter object — reduce it to the id string. */
function langId(x) {
  if (typeof x === "string") return x
  return x?.id ?? "unknown"
}
