/**
 * forge — repo map / semantic graph (v20.2 hardened v23, incremental v32)
 *
 * P1 semantic repo graph: FILE → IMPORT → EXPORT → SYMBOL → CALL → TYPE → TEST → CONFIG → DEPENDENCY
 * v32: language adapters (lang.js) + incremental index (index.js). Unchanged
 * files are not re-read. JS/PY/GO/RS extractors are unchanged.
 *
 * Deliberately bounded, regex-based, best-effort, zero dependencies.
 */

import fs from "node:fs"
import path from "node:path"
import { rankDocs, rankDocsHybrid } from "./retrieval.js"
import {
  isSourceFile, isConfigFile,
} from "./lang.js"
import { loadIndex, saveIndex, cacheHit, recordFromSource, indexEnabled } from "./index.js"

const SKIP = new Set([
  "node_modules", ".git", ".hg", ".svn", ".next", ".nuxt", ".svelte-kit",
  "dist", "build", "coverage", "__pycache__", ".turbo", ".cache",
  ".venv", "venv", ".mypy_cache", ".pytest_cache", ".gradle", ".forge",
])

let lastIndexStats = { reused: 0, parsed: 0, files: 0, persisted: false }
export function getIndexStats() { return { ...lastIndexStats } }

function gitignoreDirs(root) {
  const out = new Set()
  try {
    for (let line of fs.readFileSync(path.join(root, ".gitignore"), "utf8").split("\n")) {
      line = line.trim()
      if (!line || line.startsWith("#") || line.startsWith("!")) continue
      const name = line.replace(/^\/+/, "").replace(/\/+$/, "")
      if (name && !name.includes("/") && !/[*?\[\]]/.test(name)) out.add(name)
    }
  } catch {}
  return out
}

export function buildRepoMap(root, {
  maxFiles = 400,
  maxListed = 60,
  maxSymbols = 12,
  maxBytesPerFile = 256 * 1024,
  maxChars = 4000,
  query = "",
} = {}) {
  const found = collectRepoFiles(root, { maxFiles, maxBytesPerFile })
  if (!found.length) return ""
  return formatRepoMap(orderRepoFiles(found, query), { maxListed, maxSymbols, maxChars })
}

/**
 * v24: same scan + BM25 shortlist as buildRepoMap. When `embed` is supplied,
 * embeddings only REORDER that list — they never widen it (no extra files,
 * no extra scan). Embedder failure / timeout / no query → byte-identical to
 * buildRepoMap. Never throws.
 */
export async function buildRepoMapAsync(root, {
  maxFiles = 400,
  maxListed = 60,
  maxSymbols = 12,
  maxBytesPerFile = 256 * 1024,
  maxChars = 4000,
  query = "",
  embed = null,
  alpha,
  budgetMs = 4000,
} = {}) {
  const found = collectRepoFiles(root, { maxFiles, maxBytesPerFile })
  if (!found.length) return ""
  const ordered = orderRepoFiles(found, query)
  const q = String(query || "").trim()
  if (!q || typeof embed !== "function") {
    return formatRepoMap(ordered, { maxListed, maxSymbols, maxChars })
  }
  try {
    const ranked = await rankDocsHybrid(q, ordered.map((f) => ({
      text: f.rel + " " + f.symbols.join(" ") + " " + f.imports.join(" "),
      ref: f,
    })), { embed, alpha, budgetMs })
    // reorder only: drop anything that is not one of the scanned files
    const known = new Set(ordered)
    const next = []
    const seen = new Set()
    for (const r of ranked) {
      const f = r.ref
      if (!f || !known.has(f) || seen.has(f)) continue
      seen.add(f)
      next.push(f)
    }
    for (const f of ordered) if (!seen.has(f)) next.push(f)
    return formatRepoMap(next, { maxListed, maxSymbols, maxChars })
  } catch {
    return formatRepoMap(ordered, { maxListed, maxSymbols, maxChars })
  }
}

function collectRepoFiles(root, { maxFiles = 400, maxBytesPerFile = 256 * 1024 } = {}) {
  const walked = walkIndexed(root, { maxFiles, maxBytesPerFile })
  lastIndexStats = walked.stats
  const found = []
  for (const rec of walked.records) {
    if (rec.symbols.length || rec.imports.length || rec.config || rec.test) {
      found.push({
        rel: rec.rel, symbols: rec.symbols, imports: rec.imports,
        exports: rec.exports, calls: rec.calls, types: rec.types,
        test: rec.test, config: rec.config, lang: rec.lang,
      })
    }
  }
  return found
}

function walkIndexed(root, { maxFiles = 400, maxBytesPerFile = 256 * 1024 } = {}) {
  let base
  try { base = path.resolve(root || process.cwd()) } catch {
    return { records: [], stats: { reused: 0, parsed: 0, files: 0, persisted: false } }
  }
  const skip = new Set([...SKIP, ...gitignoreDirs(base)])
  const cache = loadIndex(base)
  const nextFiles = {}
  const records = []
  let scanned = 0, reused = 0, parsed = 0
  const walk = (dir, depth) => {
    if (scanned >= maxFiles || depth > 8) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (scanned >= maxFiles) return
      if (e.name.startsWith(".") && e.name !== ".") { if (skip.has(e.name)) continue }
      if (skip.has(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      if (!isSourceFile(e.name) && !isConfigFile(e.name)) continue
      scanned++
      let st
      try { st = fs.statSync(full) } catch { continue }
      if (st.size > maxBytesPerFile) continue
      const rel = path.relative(base, full)
      const cached = cache.files?.[rel]
      let rec
      if (cacheHit(cached, st)) {
        rec = { ...cached, rel }
        reused++
      } else {
        let src = ""
        try { src = fs.readFileSync(full, "utf8") } catch { continue }
        rec = { rel, ...recordFromSource(e.name, src, full, st) }
        parsed++
      }
      nextFiles[rel] = rec
      records.push(rec)
    }
  }
  walk(base, 0)
  const persisted = saveIndex(base, { files: nextFiles })
  const stats = { reused, parsed, files: records.length, persisted: persisted && indexEnabled() }
  lastIndexStats = stats
  return { records, stats }
}

function orderRepoFiles(found, query) {
  const q = String(query || "").trim()
  if (!q) {
    return [...found].sort((a, b) => b.symbols.length - a.symbols.length || a.rel.localeCompare(b.rel))
  }
  const ranked = rankDocs(q, found.map((f, i) => ({ i, text: f.rel + " " + f.symbols.join(" ") + " " + f.imports.join(" ") })))
  return ranked.map((r) => found[r.i])
}

function formatRepoMap(found, { maxListed = 60, maxSymbols = 12, maxChars = 4000 } = {}) {
  const lines = ["REPO MAP (top-level symbols — use this to locate code before ls/grep):"]
  let used = lines[0].length
  let shown = 0
  for (const f of found) {
    if (shown >= maxListed) break
    const syms = f.symbols.slice(0, maxSymbols).join(", ")
    const more = f.symbols.length > maxSymbols ? `, +${f.symbols.length - maxSymbols} more` : ""
    const imp = f.imports.length ? ` [imports: ${f.imports.slice(0, 5).join(", ")}]` : ""
    const exp = f.exports.length ? ` [exports: ${f.exports.slice(0, 5).join(", ")}]` : ""
    const typeInfo = f.types.length ? ` [types: ${f.types.slice(0, 5).join(", ")}]` : ""
    const tag = f.test ? " (test)" : f.config ? " (config)" : ""
    const line = `- ${f.rel}${tag}: ${syms}${more}${imp}${exp}${typeInfo}`
    if (used + line.length + 1 > maxChars) break
    lines.push(line)
    used += line.length + 1
    shown++
  }
  if (found.length > shown) lines.push(`… (+${found.length - shown} more source files)`)
  return lines.join("\n")
}

/**
 * Build full semantic graph: FILE → IMPORT → EXPORT → SYMBOL → CALL → TYPE → TEST → CONFIG → DEPENDENCY
 * Returns { files: [{ path, imports, exports, symbols, calls, types, isTest, isConfig }], edges: [...] }
 */
export function buildSemanticGraph(root, opts = {}) {
  const maxFiles = opts.maxFiles ?? 500
  const maxBytesPerFile = opts.maxBytesPerFile ?? 512 * 1024
  const walked = walkIndexed(root, { maxFiles, maxBytesPerFile })
  const files = []
  const edges = []
  for (const rec of walked.records) {
    const rel = rec.rel
    const node = {
      path: rel,
      imports: rec.imports || [],
      exports: rec.exports || [],
      symbols: rec.symbols || [],
      calls: rec.calls || [],
      types: rec.types || [],
      isTest: !!rec.test,
      isConfig: !!rec.config,
      lang: rec.lang,
      dependencies: [],
    }
    for (const imp of node.imports) {
      edges.push({ from: rel, to: imp, kind: "IMPORT" })
      node.dependencies.push(imp)
    }
    for (const exp of node.exports) edges.push({ from: rel, to: exp, kind: "EXPORT" })
    for (const sym of node.symbols) edges.push({ from: rel, to: sym, kind: "SYMBOL" })
    for (const call of node.calls) edges.push({ from: rel, to: call, kind: "CALL" })
    for (const t of node.types) edges.push({ from: rel, to: t, kind: "TYPE" })
    if (node.isTest) edges.push({ from: rel, kind: "TEST", to: "test" })
    if (node.isConfig) edges.push({ from: rel, kind: "CONFIG", to: "config" })
    for (const dep of node.dependencies) edges.push({ from: rel, to: dep, kind: "DEPENDENCY" })
    files.push(node)
  }
  return {
    files,
    edges,
    stats: {
      totalFiles: files.length,
      totalEdges: edges.length,
      imports: edges.filter(e => e.kind === "IMPORT").length,
      exports: edges.filter(e => e.kind === "EXPORT").length,
      symbols: edges.filter(e => e.kind === "SYMBOL").length,
      calls: edges.filter(e => e.kind === "CALL").length,
      types: edges.filter(e => e.kind === "TYPE").length,
      tests: edges.filter(e => e.kind === "TEST").length,
      configs: edges.filter(e => e.kind === "CONFIG").length,
      dependencies: edges.filter(e => e.kind === "DEPENDENCY").length,
      reused: walked.stats.reused,
      parsed: walked.stats.parsed,
    },
  }
}
