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
import { buildSemanticGraph, buildCrossGraph, listSourceFiles, listSourceFilesAsync, recordToGraphParts } from "./repomap.js"
import { impactRadius } from "./impact.js"
import { consumersOf, testsForFiles, implForFiles } from "./xlang.js"
import { detectLanguage } from "./lang.js"
import { loadIndex, saveIndex, recordFromSource, cacheHit } from "./index.js"
import { projectDir } from "./memory.js"
import { writeStateFile } from "./securefs.js"
import { DEFAULT_DIR } from "./config.js"

export const WORLD_LIMITS = {
  maxQueryResults: 40,
  maxRecent: 30,
}

export const WORLD_SNAPSHOT_VERSION = 3
export const WORLD_DEFAULT_MAX_FILES = 2000

// ---------------------------------------------------------------------------
// v97 unifiedwise §15 — REMOVE THE ARBITRARY CEILING. The cap is now a
// CONFIGURABLE INITIAL BUDGET, not a semantic limit:
//   FORGE_WORLD_MAX_FILES env  >  ~/.forge/config.json {world:{maxFiles}}  >
//   ./forge.config.json {world:{maxFiles}} (non-privileged, perf tuning)  >  2000
// A value of 0 / "unlimited" means NO CAP (the walk completes; incremental
// indexing + the shared index keep re-extraction cheap). When the budget IS
// finite and the repository exceeds it, indexing is PRIORITIZED (manifests,
// entry points, src/, then tests — never plain readdir luck) and the world
// stays HONESTLY truncated — while expand() can page in more on demand, so a
// huge repo takes longer to understand but never becomes semantically invisible.
// ---------------------------------------------------------------------------
let _resolvedMaxFiles
export function resolveWorldMaxFiles() {
  if (_resolvedMaxFiles != null) return _resolvedMaxFiles
  // v98 shipwise FIX: "0" / "unlimited" maps to Infinity — the NO-CAP value the
  // header documents. The old `!Number.isFinite(v)` guard treated Infinity as
  // garbage and silently fell back to 2000, so the documented six-figure
  // configuration was unreachable (verified: FORGE_WORLD_MAX_FILES=0 → 2000).
  // Valid = Infinity (no cap) or a finite positive number; NaN/garbage/negatives
  // fall through to the next source.
  const validCap = (x) => x === Infinity || (Number.isFinite(x) && x > 0)
  let v = null
  const env = String(process.env.FORGE_WORLD_MAX_FILES ?? "").trim().toLowerCase()
  if (env) v = (env === "0" || env === "unlimited" || env === "none" || env === "off") ? Infinity : Number(env)
  if (!validCap(v)) {
    // user config, then project config (world.maxFiles is perf tuning, not a
    // privileged key — a project may legitimately size its own index)
    for (const p of [path.join(DEFAULT_DIR, "config.json"), path.join(process.cwd(), "forge.config.json")]) {
      try {
        const j = JSON.parse(fs.readFileSync(p, "utf8"))
        const n = j?.world?.maxFiles
        if (n != null) { v = (n === 0 || n === "unlimited") ? Infinity : Number(n); if (validCap(v)) break; v = null }
      } catch { }
    }
  }
  if (!validCap(v)) v = WORLD_DEFAULT_MAX_FILES
  _resolvedMaxFiles = v
  return v
}

/** §15 prioritized indexing — which files matter most when the budget bites. */
export function filePriority(rel, { isTest = false, isConfig = false } = {}) {
  const base = rel.split("/").pop() ?? rel
  if (ROOT_MANIFEST_NAMES.has(base)) return 100
  if (isConfig || /^(dockerfile|makefile|cmakelists\.txt|meson\.build)$/i.test(base)) return 90
  if (/^(index|main|app|mod|lib|server|entry)\.[a-z]+$|^__init__\.py$|^mod\.rs$/i.test(base)) return 80
  if (/^(src|lib|app|internal|cmd|pkg|core)\//.test(rel)) return 60
  if (isTest || /^(test|tests|spec|specs|__tests__)\//.test(rel) || /^(test|spec)_|[-.](test|spec)\./i.test(base)) return 20
  if (/^(docs?|examples?|bench|fixtures|assets)\//.test(rel) || /\.md$/i.test(base)) return 10
  return 50 // ordinary source
}
const ROOT_MANIFEST_NAMES = new Set([
  "package.json", "deno.json", "cargo.toml", "go.mod", "pyproject.toml", "requirements.txt",
  "setup.py", "pipfile", "pom.xml", "build.gradle", "build.gradle.kts", "gemfile",
  "composer.json", "mix.exs", "makefile", "cmakelists.txt", "meson.build", "flake.nix",
  "docker-compose.yml", "docker-compose.yaml", "pubspec.yaml", "build.zig", "tsconfig.json",
])

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

export function createWorldModel({ cwd = process.cwd(), maxFiles = null } = {}) {
  let world = null
  let building = false
  const dirty = new Set() // paths explicitly invalidated (§13)
  // v97 §15: null → the CONFIGURED budget (env/config/default), never a
  // hardcoded ceiling. An explicit number still wins (tests pin behavior).
  let budget = maxFiles != null ? maxFiles : resolveWorldMaxFiles()
  let expansions = 0

  /** v97 §15 audit fix: ONE priority-selection semantics shared by fullBuild,
   *  the build() drift scans and expand(). The drift scan MUST select the same
   *  file set the world holds — a walk-ordered scan against a priority-ordered
   *  world would report eternal drift and silently swap the selection.
   *  v98 shipwise: selection is split from the WALK so a completed walk can be
   *  reused (async builders and expand() no longer re-walk per phase). */
  function selectFromScan(scanAll) {
    if (Number.isFinite(budget) && scanAll.files.length > budget) {
      const ranked = scanAll.files
        .map((f, i) => ({ f, i, p: filePriority(f.rel) }))
        .sort((a, b) => b.p - a.p || a.i - b.i) // stable: walk order breaks ties
        .slice(0, budget)
        .map((x) => x.f)
      return { scan: { files: ranked, truncated: true, skippedBySize: scanAll.skippedBySize }, scanAll, prioritized: true }
    }
    return { scan: scanAll, scanAll, prioritized: false }
  }
  function priorityScan() {
    const s = selectFromScan(listSourceFiles(cwd, { maxFiles: 0 }))
    // v98: remember the walk (with its time) so expand()/locate() reuse it
    // within the A3 freshness window
    s.scanAll.at = Date.now()
    lastScanAll = s.scanAll
    return s
  }
  let lastScanAll = null

  function fullBuild(pre = null) {
    // v97 §15: the STAT WALK ALWAYS COMPLETES (maxFiles: 0 = uncapped), then
    // the budget selects the MOST IMPORTANT files first (priority order),
    // then the shared incremental index extracts exactly that list (rels) —
    // unchanged files reuse the index, so expansions only pay for new files.
    // v98: `pre` = a scan the caller already walked (async build / expand) —
    // the selection re-runs against the CURRENT budget, the walk does not.
    const { scan, scanAll, prioritized } = pre ?? priorityScan()
    const rels = scan.files.map((f) => f.rel)
    const g = buildSemanticGraph(cwd, { maxFiles: Number.isFinite(budget) ? budget : scan.files.length || 1, rels })
    const fp = new Map(scan.files.map((f) => [f.rel, { size: f.size, mtime: f.mtime }]))
    const w = emptyWorldModel()
    w.root = path.resolve(cwd)
    w.builtAt = Date.now()
    w.files = (g.files ?? []).map((f) => ({
      path: f.path,
      lang: langId(f.lang) === "unknown" ? langId(detectLanguage(f.path)) : langId(f.lang),
      symbols: f.symbols ?? [],
      symbolDetails: f.symbolDetails ?? null, // v98: tier-3 [{name,kind,line}] when enriched
      imports: f.imports ?? [],
      exports: f.exports ?? [],
      calls: f.calls ?? [],
      types: f.types ?? [],
      isTest: !!f.isTest,
      isConfig: !!f.isConfig,
      contracts: f.contracts ?? [],
      extraction: f.extraction ?? null, // v98: {layer, source} provenance
      fingerprint: fp.get(f.path) ?? null,
    }))
    w.edges = g.edges ?? []
    w.stats = {
      ...(g.stats ?? {}),
      totalScanned: scanAll.files.length,   // §15 honesty: the walk DID complete
      truncated: scan.truncated,            // honest: the budget was hit
      prioritized,                          // honest: how the budget was spent
      skippedBySize: scan.skippedBySize,    // honest: files too large to index
      fullBuilds: ((loadSnapshot(cwd)?.stats?.fullBuilds ?? 0) + 1),
      incremental: null,
      ...(expansions ? { expansions } : {}),
    }
    rebuildDerived(w)
    w.degraded = !w.files.length
    return w
  }

  /** §15 lazy expansion: page MORE of the repository into the model on demand.
   *  Cost is proportional to the NEW files only (shared index reuse). Returns
   *  the world, or null when there was nothing more to expand. */
  function expand({ add = 5000, scanAll = null } = {}) {
    const w = world ?? build()
    if (!Number.isFinite(budget)) return w // already unlimited
    // v98: the caller may hand over a walk it already did (locate's build
    // memoizes lastScanAll) — the 3-walk expand chain becomes 1 walk.
    // A3 audit bound: a memoized walk is only reused for a SHORT window — a
    // stale one must never mask newly added files (under-expansion); beyond
    // the window the walk re-runs.
    const memoUsable = lastScanAll && Date.now() - (lastScanAll.at ?? 0) < 5000
    const all = scanAll ?? (memoUsable ? lastScanAll : null) ?? priorityScan().scanAll
    if (all.files.length <= budget) return w // nothing more to index
    budget = budget + Math.max(1, add)
    expansions++
    const next = fullBuild(selectFromScan(all))
    world = next
    dirty.clear()
    saveSnapshot(cwd, next)
    return next
  }

  /** §13 — extract ONE file's record (same extractor the index uses).
   *  v98 shipwise FIX: the shared index is loaded ONCE per incremental pass
   *  and saved ONCE at the end (the caller passes it in). The old per-file
   *  loadIndex/saveIndex made an N-file incremental rebuild parse and
   *  fsync the ENTIRE index N times — quadratic write amplification that
   *  dominated six-figure-repo rebuilds. */
  function extractOne(rel, sharedIndex = null) {
    const full = path.join(path.resolve(cwd), rel)
    try {
      const st = fs.statSync(full)
      // v98 shipwise: a FRESH index record (fingerprint proves it reflects the
      // current file) is REUSED — the same cacheHit law as walkIndexed. This
      // is what lets tier-3 enrichment survive: the post-segment pass upgrades
      // index records in place, and the next incremental build serves them
      // instead of overwriting them with a lexical re-extraction. Never a
      // private cache: the record came from the shared index and goes back to
      // exactly the same shape a fresh extraction would produce.
      let idx = sharedIndex
      if (!idx) { try { idx = loadIndex(cwd) } catch { idx = null } }
      const cached = idx?.files?.[rel]
      if (cached && cacheHit(cached, st) && Array.isArray(cached.contracts)) {
        return { rel, ...cached }
      }
      const src = fs.readFileSync(full, "utf8")
      const rec = { rel, ...recordFromSource(path.basename(rel), src, full, st) }
      if (!Array.isArray(rec.contracts)) rec.contracts = []
      // keep the shared incremental index in sync (never a private cache)
      try {
        const target = idx ?? loadIndex(cwd)
        target.files = target.files ?? {}
        target.files[rel] = rec
        if (!sharedIndex) saveIndex(cwd, target) // standalone call persists; batched callers save once
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
    // v98: ONE index load + ONE save for the whole batch (was N×N)
    const sharedIndex = (() => { try { return loadIndex(cwd) } catch { return null } })()
    for (const rel of [...changed, ...added]) {
      const rec = extractOne(rel, sharedIndex)
      if (rec) records.push(rec)
    }
    if (sharedIndex && (changed.length || added.length)) {
      try { saveIndex(cwd, sharedIndex) } catch { }
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
        symbolDetails: rec.symbolDetails ?? null, // v98: tier-3 passthrough
        extraction: rec.extraction ?? null,       // v98: provenance passthrough
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
    w.degraded = !w.files.length // v96 unifywise: an empty world is degraded, honestly, on every path (fullBuild already said so)
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

  /** v98 shipwise — the async build surface for await-capable callers (the
   *  fastwise warm pass, meta's plan-time consult, the kg_query/code_context
   * tools). The WALK runs chunked (listSourceFilesAsync — cooperative
   * setImmediate yields, so the TTY/bus/provider traffic never freezes on a
   * six-figure repo), then the sync build() consumes the completed walk.
   * In-flight calls SHARE ONE promise (the fastwise warm-memo law): a second
   * caller awaiting buildAsync() mid-walk joins the first pass instead of
   * racing it. The sync build()/world getters are UNCHANGED for sync callers
   *  — buildAsync is an addition, never a replacement. */
  let buildPromise = null
  let freshUntil = 0 // v98: async-fresh window — set ONLY by buildAsync (see build())
  async function buildAsync(force = false, { signal = null, freshMs = 3000 } = {}) {
    if (buildPromise) return buildPromise
    buildPromise = (async () => {
      try {
        const scanAll = await listSourceFilesAsync(cwd, { maxFiles: 0, signal })
        if (signal?.aborted) return world ?? emptyWorldModel()
        scanAll.at = Date.now()
        lastScanAll = scanAll // the sync build consumes THIS walk — no second walk
        const w = build(force, selectFromScan(scanAll))
        // The follow-up sync queries (summarize/impact/testsFor in the same
        // await-chain) skip their per-query drift walk for a SHORT window:
        // the async build JUST completed one. Only buildAsync sets this —
        // the pure-sync surface (every existing test) keeps per-call drift
        // semantics untouched. invalidate() clears the window immediately.
        freshUntil = Date.now() + Math.max(0, freshMs)
        return w
      } finally {
        buildPromise = null
      }
    })()
    return buildPromise
  }

  /** v98 shipwise — the LAST RECORDED TRUTH for a set of files, read from the
   *  PERSISTED SNAPSHOT with no walk, no drift check, no re-extraction.
   *  This is what contract-drift comparison needed all along: meta's §21
   *  "before" capture went through the world getter, which REBUILDS and
   *  re-extracts from disk — so the "pre-mutation" contracts were actually
   *  post-mutation and CONTRACT_DRIFT could never fire. Callers that need
   *  what the world LAST BELIEVED (not what is on disk now) read it here. */
  function persistedRecords(files) {
    const want = new Set((Array.isArray(files) ? files : [files]).filter(Boolean).map((f) => normalize(f)))
    if (!want.size) return []
    try {
      const snap = loadSnapshot(cwd)
      if (!snap || !Array.isArray(snap.files)) return []
      return snap.files
        .filter((f) => want.has(f.path))
        .map((f) => ({ path: f.path, contracts: f.contracts ?? [], symbols: f.symbols ?? [], extraction: f.extraction ?? null }))
    } catch {
      return []
    }
  }

  function build(force = false, pre = null) {
    if (world && !force && !dirty.size) {
      // v98: inside the async-fresh window the drift walk is skipped — the
      // async builder JUST walked (only buildAsync opens the window; the
      // pure-sync surface keeps per-call drift semantics, test-pinned).
      if (Date.now() < freshUntil) return world
      // even the in-memory world must not go stale: a cheap stat-only walk
      // detects drift; unchanged → reuse (§12 "lazy loading" + §13 freshness)
      // v98: `pre` = a walk the caller already completed (buildAsync) —
      // consumed instead of re-walking
      const scan = (pre ?? priorityScan()).scan
      const stale = scanFilesDiffer(world, scan)
      if (!stale) return world
    }
    if (world && !force) {
      const snap = snapshotFromWorld(world)
      const scan = (pre ?? priorityScan()).scan
      if (!scanFilesDiffer(world, scan) && !dirty.size) return world
      const w = incrementalBuild(snap, scan)
      if (w.files.length || !scan.truncated) { world = w; dirty.clear(); saveSnapshot(cwd, w); return w }
    }
    if (building) return world ?? emptyWorldModel()
    building = true
    try {
      const snapshot = force ? null : loadSnapshot(cwd)
      if (snapshot && !force) {
        const scan = (pre ?? priorityScan()).scan
        const snapWorld = worldFromSnapshot(snapshot)
        if (!scanFilesDiffer(snapWorld, scan) && !dirty.size) {
          world = snapWorld
          world.stats = { ...world.stats, reusedSnapshot: true, truncated: scan.truncated, skippedBySize: scan.skippedBySize }
          return world
        }
        const w = incrementalBuild(snapshot, scan)
        if (w.files.length || !scan.truncated) { world = w; dirty.clear(); saveSnapshot(cwd, w); return w }
      }
      const w = fullBuild(pre)
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
    freshUntil = 0 // v98: an invalidation closes the async-fresh window — mutations must never be masked
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

  /** Files matching a substring (path or symbol). v97 §15: an empty answer
   *  against a TRUNCATED world pages in more of the repository (once per call)
   *  instead of reporting "not found" for a file that exists — a huge repo
   *  takes longer, but never becomes semantically invisible. */
  function locate(query, { limit = WORLD_LIMITS.maxQueryResults } = {}) {
    let w = build()
    const q = String(query ?? "").trim().toLowerCase()
    if (!q) return []
    const scan1 = (() => {
      const out = []
      for (const f of w.files) {
        if (f.path.toLowerCase().includes(q)) { out.push({ kind: "file", path: f.path, lang: f.lang }); continue }
        if ((f.symbols ?? []).some((s) => s.toLowerCase().includes(q))) out.push({ kind: "file", path: f.path, lang: f.lang, via: "symbol" })
        if (out.length >= limit) break
      }
      return out.slice(0, limit)
    })()
    if (scan1.length || !w.stats?.truncated) return scan1
    const expanded = expand({ add: 5000 })
    if (!expanded || expanded === w) return scan1
    w = expanded
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
      return impactRadius({ files: list, cwd, graph: buildCrossGraph(cwd, { maxFiles: Number.isFinite(budget) ? budget : 0 }) })
    } catch {
      return { files: list, importers: [], tests: [], configs: [], radius: list.length, unknown: true, degraded: true }
    }
  }

  /** Which tests exercise this file (xlang cross-graph + graph test flag). */
  function testsFor(files) {
    const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
    if (!list.length) return []
    try {
      return testsForFiles(list, buildCrossGraph(cwd, { maxFiles: Number.isFinite(budget) ? budget : 0 }), { cwd }).slice(0, WORLD_LIMITS.maxQueryResults)
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
      return consumersOf(list, buildCrossGraph(cwd, { maxFiles: Number.isFinite(budget) ? budget : 0 }), { cwd }).slice(0, WORLD_LIMITS.maxQueryResults)
    } catch { return [] }
  }

  /** Implementations behind a contract (interface → impl across langs). */
  function implementations(files) {
    const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
    if (!list.length) return []
    try {
      return implForFiles(list, buildCrossGraph(cwd, { maxFiles: Number.isFinite(budget) ? budget : 0 }), { cwd }).slice(0, WORLD_LIMITS.maxQueryResults)
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
    // v96 unifywise: this answers from the SHARED INDEX (fresh mtimes), not
    // from the world graph — the previous build()-then-discard call was pure
    // waste on every query (a full stat walk whose result was dropped).
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
    // "what will break if X changes" — filler words between the trigger and
    // the target are skipped (v94c: "impact of changing core.js" resolves
    // core.js, not "changing"; previously the filler was captured as target)
    const brk = ql.match(/(?:what breaks?|what will break|impact of|blast radius of)\s+(?:(?:if|when|changing|modifying|editing|updating|removing)\s+)?([\w./@-]+)/)
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
    const lines = [`WORLD MODEL: ${w.stats.totalFiles ?? w.files.length} files, ${w.stats.totalEdges ?? w.edges.length} edges${w.degraded ? " (degraded)" : ""}${w.stats.truncated ? ` (TRUNCATED at ${w.files.length} of ${w.stats.totalScanned ?? "?"} scanned files — expand() pages in more)` : ""}${w.stats.incremental ? ` (incremental: ${w.stats.incremental.reused} reused, ${w.stats.incremental.reextracted} re-extracted)` : ""}`]
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
    build, buildAsync, locate, dependents, dependenciesOf, impact, testsFor, languageOf,
    consumers, implementations, controllingConfig, recentChanges, answer, summarize, snapshot,
    invalidate, expand, persistedRecords,
    get world() { return build() },
    get budget() { return budget },
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
