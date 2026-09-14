/**
 * forge — knowwise: deterministic per-project knowledge-graph bootstrap
 *
 * Writes <project>/.ua/knowledge-graph.json in the understand-anything
 * schema — composed ONLY from the existing extractors (repomap.buildSemanticGraph
 * over the persistent index; no second parser, no LLM, no network, no
 * understand-anything scripts which need missing npm packages). The moment
 * the file exists, every existing reader lights up with zero further wiring:
 *   - engmemory retrieval bridge (keyword-gated L3-style records)
 *   - kg_query tool (shared mtime+size-cached parser)
 *
 * Honesty rules:
 *   - a REAL understand-anything graph (no forge generator marker) is NEVER
 *     touched — forge writes only the deterministic FLOOR graph; the skill
 *     authors the richer one
 *   - the file carries project.generator + project.knowwise.{fp,files,maxFiles}
 *     so a rebuild happens only when the source inventory actually drifted
 *     (fp = file count + size/mtime sum over the same bounded stat walk)
 *   - bounded: maxFiles cap (default 500), 512 KB/file, edges resolved to
 *     in-project targets only, honest truncated flag
 *   - never throws; corrupt forge-generated graphs are rebuilt, unreadable
 *     projects return { ok:false }
 */
import fs from "node:fs"
import path from "node:path"
import { buildSemanticGraph, listSourceFiles } from "./repomap.js"
import { knowledgeGraphFile } from "./engmemory.js"

const GENERATOR = "forge-knowwise/1"
const KNOW_MAX_FILES = 500
const KNOW_MAX_BYTES = 512 * 1024
const KNOW_MAX_EDGES = 4000
const EXT_ATTEMPTS = ["", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", "/index.js", "/index.mjs", "/index.ts", ".py", ".go", ".rs"]

function canReadDir(dir) {
  try { return fs.statSync(dir).isDirectory() } catch { return false }
}

/** Order-independent drift fingerprint over the same bounded stat walk the
 * build uses. Cheap: stat-only, no parsing. The .ua data dir itself is
 * excluded so the graph can never graph itself (self-inclusion would drift
 * the fingerprint and force a rebuild every run). */
function inventoryFingerprint(cwd, maxFiles) {
  const inv = listSourceFiles(cwd, { maxFiles, maxBytesPerFile: KNOW_MAX_BYTES })
  const files = inv.files.filter((f) => !/^\.u(a|nderstand-anything)\//.test(String(f.rel).split(path.sep).join("/")))
  let sum = 0
  for (const f of files) sum = (sum + Number(f.size ?? 0) + Number(f.mtime ?? f.mtimeMs ?? 0)) % 9007199254740883
  return { fp: `${files.length}:${sum}`, count: files.length, truncated: !!inv.truncated }
}

function pkgName(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"))
    if (typeof pkg?.name === "string" && pkg.name.trim()) return pkg.name.trim()
  } catch { /* not a package — basename is honest */ }
  return path.basename(cwd)
}

/** Resolve an IMPORT specifier against the known in-project node paths.
 * Anything unresolved is external (node_modules / url / alias) and dropped. */
function resolveTarget(fromRel, spec, paths) {
  const s = String(spec ?? "").trim()
  if (!s || !s.startsWith(".")) {
    // some extractors already emit project-relative paths
    return paths.has(s) ? s : null
  }
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel.split(path.sep).join("/")), s.split(path.sep).join("/")))
  for (const attempt of EXT_ATTEMPTS) {
    const candidate = base + attempt
    if (paths.has(candidate)) return candidate
  }
  return null
}

/** Build (or rebuild) the floor graph and write it atomically. */
function buildKnowledgeGraph({ cwd, maxFiles }) {
  const inv = inventoryFingerprint(cwd, maxFiles)
  if (!inv.count) return { ok: false, reason: "no source files found (nothing to graph)" }
  const graph = buildSemanticGraph(cwd, { maxFiles, maxBytesPerFile: KNOW_MAX_BYTES })
  const isData = (p) => /^\.u(a|nderstand-anything)\//.test(String(p).split(path.sep).join("/"))
  const files = graph.files.filter((n) => !isData(n.path))
  const paths = new Set(files.map((n) => n.path))

  const nodes = []
  const langs = new Map()
  for (const n of files) {
    langs.set(n.lang, (langs.get(n.lang) ?? 0) + 1)
    const summaryBits = []
    if (n.exports?.length) summaryBits.push(`exports: ${n.exports.slice(0, 6).join(", ")}`)
    else if (n.symbols?.length) summaryBits.push(`symbols: ${n.symbols.slice(0, 6).join(", ")}`)
    else summaryBits.push("no exports detected")
    nodes.push({
      id: `file:${n.path}`,
      type: n.isConfig ? "config" : "file",
      name: path.basename(n.path),
      filePath: n.path,
      summary: `${n.lang}${n.isTest ? " (test)" : ""} — ${summaryBits.join("; ")}`,
      tags: [n.lang, ...(n.isTest ? ["test"] : []), ...(n.isConfig ? ["config"] : [])],
      complexity: (n.calls?.length ?? 0) + (n.imports?.length ?? 0),
    })
  }

  const edges = []
  for (const e of graph.edges) {
    if (e.kind !== "IMPORT") continue // DEPENDENCY duplicates IMPORT; CALL/TYPE/SYMBOL are symbol-level, not file-level
    const target = resolveTarget(e.from, e.to, paths)
    if (!target) continue
    edges.push({ source: `file:${e.from}`, target: `file:${target}`, type: "imports" })
    if (edges.length >= KNOW_MAX_EDGES) break
  }

  const languages = [...langs.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l)
  const doc = {
    version: "1.0.0",
    project: {
      name: pkgName(cwd),
      languages,
      frameworks: [], // honest: the deterministic floor cannot infer frameworks; the understand-anything skill can
      description: "Deterministic floor knowledge graph built by forge (knowwise) from the world-model extractors — no LLM, no network. A richer graph can be authored on top with the understand skill.",
      analyzedAt: new Date().toISOString(),
      gitCommitHash: "",
      generator: GENERATOR,
      knowwise: { files: nodes.length, fp: inv.fp, truncated: inv.truncated || nodes.length >= maxFiles, maxFiles },
    },
    nodes,
    edges,
    layers: [],
    tour: [],
    stats: { files: nodes.length, edges: edges.length, languages: languages.length, truncated: inv.truncated || nodes.length >= maxFiles },
  }

  const dir = path.join(cwd, ".ua")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "knowledge-graph.json")
  const tmp = path.join(dir, `.knowledge-graph.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(doc))
  fs.renameSync(tmp, file) // atomic; readers never see a partial file
  return { ok: true, built: true, file, files: nodes.length, edges: edges.length, truncated: doc.stats.truncated }
}

/**
 * Ensure the project has a forge floor knowledge graph.
 * @returns {{ ok: boolean, built: boolean, file?: string, reason?: string,
 *             files?: number, edges?: number, truncated?: boolean }}
 */
export function ensureKnowledgeGraph({ cwd = process.cwd(), maxFiles = KNOW_MAX_FILES, force = false } = {}) {
  try {
    if (!canReadDir(cwd)) return { ok: false, built: false, reason: "project directory unreadable" }
    const existing = knowledgeGraphFile(cwd)
    if (existing && !force) {
      let parsed = null
      try { parsed = JSON.parse(fs.readFileSync(existing, "utf8")) } catch { parsed = null }
      if (parsed && parsed?.project?.generator !== GENERATOR) {
        return { ok: true, built: false, file: existing, reason: "external knowledge graph present — left untouched" }
      }
      if (parsed) {
        // forge-generated: rebuild only when the source inventory drifted
        const stored = parsed?.project?.knowwise
        const inv = inventoryFingerprint(cwd, stored?.maxFiles ?? maxFiles)
        if (inv.fp === stored?.fp) {
          return { ok: true, built: false, file: existing, reason: "fresh (source inventory unchanged)" }
        }
      }
      // corrupt or drifted → fall through to a rebuild (a broken file is
      // improved, never preserved)
    }
    const built = buildKnowledgeGraph({ cwd, maxFiles })
    if (!built.ok) return { ...built, built: false }
    return built
  } catch (e) {
    return { ok: false, built: false, reason: String(e?.message ?? e).slice(0, 140) }
  }
}
