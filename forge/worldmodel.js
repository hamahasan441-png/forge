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
 *
 * v93 GAP FIX §12/§13 — persistent + incremental:
 *   - the joined model is PERSISTED to ~/.forge/projects/<hash>/world.json
 *     (file graph, symbol graph, dependency graph, contract graph) and
 *     survives process restart, model switch and task continuation.
 *   - build() starts with a STAT-ONLY fingerprint walk (listSourceFiles —
 *     the same skip semantics as the full builder). Unchanged files are
 *     reused from the snapshot; only changed/added files are re-extracted
 *     (same recordToGraphParts as the full build — one semantics, §36);
 *     removed files drop their nodes and edges. No full-repository
 *     re-extraction unless forced.
 *   - the small-project ceiling is gone as a *truth limit*: the default cap
 *     is 2000 files and hitting it is REPORTED (stats.truncated) — never a
 *     silent "complete" model.
 *   - invalidate(paths) forces re-extraction of specific files (the §13
 *     chain's entry point; meta can call it after segments that mutate).
 */
import path from "node:path"
import fs from "node:fs"
import { buildSemanticGraph, buildCrossGraph, listSourceFiles, recordToGraphParts } from "./repomap.js"
import { impactRadius } from "./impact.js"
import { consumersOf, testsForFiles, implForFiles } from "./xlang.js"
import { detectLanguage } from "./lang.js"
import { loadIndex, saveIndex, recordFromSource } from "./index.js"
import { projectDir } from "./memory.js"
import { writeStateFile } from "./securefs.js"

export const WORLD_LIMITS = {
  maxQueryResults: 40,
  maxRecent: 30,
}

export const WORLD_SNAPSHOT_VERSION = 2
export const WORLD_DEFAULT_MAX_FILES = 2000

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

function snapshotPath(cwd) {
  return path.join(projectDir(cwd), "world.json")
}

function loadSnapshot(cwd) {
  try {
    const j = JSON.parse(fs.readFileSync(snapshotPath(cwd), "utf8"))
    if (j && j.v === WORLD_SNAPSHOT_VERSION && j.root === path.resolve(cwd) && Array.isArray(j.files) && Array.isArray(j.edges)) return j
  } catch { }
  return null
}

function saveSnapshot(cwd, world) {
  try {
    const payload = {
      v: WORLD_SNAPSHOT_VERSION,
      root: world.root,
      builtAt: world.builtAt,
      degraded: world.degraded,
      files: world.files,         // [{path, fingerprint, ...record}]
      edges: world.edges,
      stats: world.stats,
      langs: world.langs,
      contracts: world.contracts,
    }
    writeStateFile(snapshotPath(cwd), JSON.stringify(payload))
  } catch { /* persistence is best-effort, never breaks a query */ }
}

/** Rebuild the derived structures (langs census, contracts, symbol index)
 *  from the file records — shared by the full and incremental paths. */
function rebuildDerived(world) {
  world.langs = {}
  for (const f of world.files) world.langs[f.lang] = (world.langs[f.lang] ?? 0) + 1
  const seen = new Set()
  world.contracts = []
  for (const f of world.files) {
    for (const c of f.contracts ?? []) {
      const k = `${c.kind}:${c.name}`
      if (seen.has(k)) continue
      seen.add(k)
      world.contracts.push({ kind: c.kind, name: c.name, file: f.path })
    }
  }
  world.symbolsIndex = new Map()
  for (const f of world.files) {
    for (const s of f.symbols ?? []) {
      if (!world.symbolsIndex.has(s)) world.symbolsIndex.set(s, [])
      const owners = world.symbolsIndex.get(s)
      if (owners.length < 8) owners.push(f.path)
    }
  }
}

export function createWorldModel({ cwd = process.cwd(), maxFiles = WORLD_DEFAULT_MAX_FILES } = {}) {
  let world = null
  let building = false
  const dirty = new Set() // paths explicitly invalidated (§13)

  function fullBuild() {
    // the classic path: the shared incremental index does the extraction
    // (unchanged files reuse the index — parsing only what changed since the
    // LAST FULL BUILD), recordToGraphParts gives one edge semantics.
    const g = buildSemanticGraph(cwd, { maxFiles })
    const scan = listSourceFiles(cwd, { maxFiles })
    const fp = new Map(scan.files.map((f) => [f.rel, { size: f.size, mtime: f.mtime }]))
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
      fingerprint: fp.get(f.path) ?? null,
    }))
    w.edges = g.edges ?? []
    w.stats = {
      ...(g.stats ?? {}),
      truncated: scan.truncated,          // honest: the cap was hit
      skippedBySize: scan.skippedBySize,   // honest: files too large to index
      fullBuilds: ((loadSnapshot(cwd)?.stats?.fullBuilds ?? 0) + 1),
      incremental: null,
    }
    rebuildDerived(w)
    w.degraded = !w.files.length
    return w
  }

  /** §13 — extract ONE file's record (same extractor the index uses). */
  function extractOne(rel) {
    const full = path.join(path.resolve(cwd), rel)
    try {
      const st = fs.statSync(full)
      const src = fs.readFileSync(full, "utf8")
      const rec = { rel, ...recordFromSource(path.basename(rel), src, full, st) }
      if (!Array.isArray(rec.contracts)) rec.contracts = []
      // keep the shared incremental index in sync (never a private cache)
      try {
        const idx = loadIndex(cwd)
        idx.files = idx.files ?? {}
        idx.files[rel] = rec
        saveIndex(cwd, idx)
      } catch { }
      return rec
    } catch { return null }
  }

  function incrementalBuild(snapshot, scan) {
    const w = emptyWorldModel()
    w.root = snapshot.root
    const snapFiles = new Map(snapshot.files.map((f) => [f.path, f]))
    const scanFiles = new Map(scan.files.map((f) => [f.rel, f]))

    const changed = []
    const added = []
    const removed = []
    const reused = []

    for (const [rel, scanF] of scanFiles) {
      const snapF = snapFiles.get(rel)
      const fp = { size: scanF.size, mtime: scanF.mtime }
      if (!snapF) { added.push(rel); continue }
      const drifted = !snapF.fingerprint || snapF.fingerprint.size !== fp.size || snapF.fingerprint.mtime !== fp.mtime
      if (drifted || dirty.has(rel)) { changed.push(rel); continue }
      reused.push({ ...snapF, fingerprint: fp })
    }
    for (const [rel, snapF] of snapFiles) {
      if (!scanFiles.has(rel)) removed.push(rel)
    }

    // §13: re-extract ONLY the changed/added areas, reuse everything else
    const records = []
    for (const f of reused) records.push(fileToRecord(f))
    for (const rel of [...changed, ...added]) {
      const rec = extractOne(rel)
      if (rec) records.push(rec)
    }

    w.files = records.map((rec) => {
      const { node, } = recordToGraphParts(rec)
      const scanF = scanFiles.get(rec.rel)
      return {
        path: node.path,
        lang: langId(node.lang) === "unknown" ? langId(detectLanguage(node.path)) : langId(node.lang),
        symbols: node.symbols, imports: node.imports, exports: node.exports,
        calls: node.calls, types: node.types, isTest: node.isTest, isConfig: node.isConfig,
        contracts: node.contracts,
        fingerprint: scanF ? { size: scanF.size, mtime: scanF.mtime } : null,
      }
    })
    w.edges = []
    for (const rec of records) w.edges.push(...recordToGraphParts(rec).edges)
    w.builtAt = Date.now()
    w.stats = {
      ...(snapshot.stats ?? {}),
      totalFiles: w.files.length,
      totalEdges: w.edges.length,
      truncated: scan.truncated,
      skippedBySize: scan.skippedBySize,
      incremental: { reused: reused.length, reextracted: changed.length + added.length, added: added.length, removed: removed.length },
    }
    rebuildDerived(w)
    w.degraded = !w.files.length && !scan.truncated ? true : false
    return w
  }

  /** file snapshot record → extractor-shaped record (one semantics again). */
  function fileToRecord(f) {
    return {
      rel: f.path, lang: f.lang, symbols: f.symbols ?? [], imports: f.imports ?? [],
      exports: f.exports ?? [], calls: f.calls ?? [], types: f.types ?? [],
      test: !!f.isTest, config: !!f.isConfig, contracts: f.contracts ?? [],
    }
  }

  function build(force = false) {
    if (world && !force && !dirty.size) {
      // even the in-memory world must not go stale: a cheap stat-only walk
      // detects drift; unchanged → reuse (§12 "lazy loading" + §13 freshness)
      const scan = listSourceFiles(cwd, { maxFiles })
      const stale = scanFilesDiffer(world, scan)
      if (!stale) return world
    }
    if (world && !force) {
      const snap = snapshotFromWorld(world)
      const scan = listSourceFiles(cwd, { maxFiles })
      if (!scanFilesDiffer(world, scan) && !dirty.size) return world
      const w = incrementalBuild(snap, scan)
      if (w.files.length || !scan.truncated) { world = w; dirty.clear(); saveSnapshot(cwd, w); return w }
    }
    if (building) return world ?? emptyWorldModel()
    building = true
    try {
      const snapshot = force ? null : loadSnapshot(cwd)
      if (snapshot && !force) {
        const scan = listSourceFiles(cwd, { maxFiles })
        const snapWorld = worldFromSnapshot(snapshot)
        if (!scanFilesDiffer(snapWorld, scan) && !dirty.size) {
          world = snapWorld
          world.stats = { ...world.stats, reusedSnapshot: true, truncated: scan.truncated, skippedBySize: scan.skippedBySize }
          return world
        }
        const w = incrementalBuild(snapshot, scan)
        if (w.files.length || !scan.truncated) { world = w; dirty.clear(); saveSnapshot(cwd, w); return w }
      }
      const w = fullBuild()
      world = w
      dirty.clear()
      saveSnapshot(cwd, w)
      return w
    } catch {
      world = { ...emptyWorldModel(), root: path.resolve(cwd), builtAt: Date.now(), degraded: true }
      return world
    } finally {
      building = false
    }
  }

  function snapshotFromWorld(w) {
    return { v: WORLD_SNAPSHOT_VERSION, root: w.root, builtAt: w.builtAt, degraded: w.degraded, files: w.files, edges: w.edges, stats: w.stats, langs: w.langs, contracts: w.contracts }
  }

  function worldFromSnapshot(snap) {
    const w = emptyWorldModel()
    w.root = snap.root
    w.builtAt = snap.builtAt
    w.degraded = !!snap.degraded
    w.files = snap.files
    w.edges = snap.edges
    w.stats = snap.stats ?? {}
    w.langs = snap.langs ?? {}
    w.contracts = snap.contracts ?? []
    rebuildDerived(w)
    return w
  }

  /** fingerprint diff between a world/snapshot and the current file system. */
  function scanFilesDiffer(w, scan) {
    const known = new Map((w.files ?? []).map((f) => [f.path, f.fingerprint]))
    if (scan.files.length !== (w.files ?? []).length) return true
    for (const f of scan.files) {
      const fp = known.get(f.rel)
      if (!fp || fp.size !== f.size || fp.mtime !== f.mtime) return true
      if (dirty.has(f.rel)) return true
    }
    return false
  }

  /** §13 entry point: invalidate paths — DURABLY. The records are dropped
   *  from the PERSISTED snapshot, so ANY future instance (this process, a
   *  restarted forge, the next plan phase) re-extracts exactly these files
   *  instead of trusting stale records. Also marks them dirty in-memory. */
  function invalidate(files) {
    const list = (Array.isArray(files) ? files : [files]).filter(Boolean).map((f) => String(f).replace(/\\/g, "/").replace(/^\.\//, ""))
    for (const rel of list) dirty.add(rel)
    let dropped = 0
    try {
      const snap = loadSnapshot(cwd)
      if (snap && Array.isArray(snap.files)) {
        const before = snap.files.length
        snap.files = snap.files.filter((f) => !list.includes(f.path))
        dropped = before - snap.files.length
        if (dropped > 0) writeStateFile(snapshotPath(cwd), JSON.stringify(snap))
      }
    } catch { /* best-effort; in-memory dirty still forces re-extraction */ }
    // an already-built in-memory world must not keep serving the stale nodes
    if (world && dropped > 0) {
      const drop = new Set(list)
      world.files = world.files.filter((f) => !drop.has(f.path))
      rebuildDerived(world)
    }
    return dirty.size
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
      return testsForFiles(list, buildCrossGraph(cwd, { maxFiles }), { cwd }).slice(0, WORLD_LIMITS.maxQueryResults)
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
    const lines = [`WORLD MODEL: ${w.stats.totalFiles ?? w.files.length} files, ${w.stats.totalEdges ?? w.edges.length} edges${w.degraded ? " (degraded)" : ""}${w.stats.truncated ? ` (TRUNCATED at ${maxFiles} files — this is NOT the complete model)` : ""}${w.stats.incremental ? ` (incremental: ${w.stats.incremental.reused} reused, ${w.stats.incremental.reextracted} re-extracted)` : ""}`]
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
      persisted: fs.existsSync(snapshotPath(cwd)),
    }
  }

  return {
    build, locate, dependents, dependenciesOf, impact, testsFor, languageOf,
    consumers, implementations, controllingConfig, recentChanges, answer, summarize, snapshot,
    invalidate,
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
