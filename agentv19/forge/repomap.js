/**
 * forge — repo map / semantic graph (v20.2 hardened v23, zero dependencies)
 *
 * P1 semantic repo graph: FILE → IMPORT → EXPORT → SYMBOL → CALL → TYPE → TEST → CONFIG → DEPENDENCY
 * Before v23: only top-level symbols. Now builds a bounded semantic graph
 * for demand-driven context: each file contributes nodes for imports, exports,
 * symbols, calls, types, test references, config and dependencies.
 *
 * Deliberately bounded, regex-based, best-effort, zero dependencies.
 */

import fs from "node:fs"
import path from "node:path"
import { rankDocs, rankDocsHybrid } from "./retrieval.js"

const SKIP = new Set([
  "node_modules", ".git", ".hg", ".svn", ".next", ".nuxt", ".svelte-kit",
  "dist", "build", "coverage", "__pycache__", ".turbo", ".cache",
  ".venv", "venv", ".mypy_cache", ".pytest_cache", ".gradle", ".forge",
])

const JS_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"])
const PY_EXT = new Set([".py"])
const GO_EXT = new Set([".go"])
const RS_EXT = new Set([".rs"])
const JSON_EXT = new Set([".json"])
const CFG_EXT = new Set([".toml", ".yaml", ".yml", ".ini", ".cfg"])

function jsSymbols(src) {
  const out = []
  const re = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm
  let m
  while ((m = re.exec(src))) out.push(m[1])
  const reNamed = /^\s*export\s*\{([^}]+)\}/gm
  while ((m = reNamed.exec(src))) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/i).pop().trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push(name)
    }
  }
  return out
}
function pySymbols(src) {
  const out = []
  const re = /^(?:def|class)\s+([A-Za-z_]\w*)/gm
  let m
  while ((m = re.exec(src))) out.push(m[1])
  return out
}
function goSymbols(src) {
  const out = []
  const re = /^\s*func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)|^\s*type\s+([A-Z]\w*)/gm
  let m
  while ((m = re.exec(src))) out.push(m[1] || m[2])
  return out
}
function rsSymbols(src) {
  const out = []
  const re = /^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/gm
  let m
  while ((m = re.exec(src))) out.push(m[1])
  return out
}

function extractSymbols(file, src) {
  const ext = path.extname(file).toLowerCase()
  if (JS_EXT.has(ext)) return jsSymbols(src)
  if (PY_EXT.has(ext)) return pySymbols(src)
  if (GO_EXT.has(ext)) return goSymbols(src)
  if (RS_EXT.has(ext)) return rsSymbols(src)
  return []
}

function extractImports(file, src) {
  const ext = path.extname(file).toLowerCase()
  const out = []
  if (JS_EXT.has(ext)) {
    const re = /^\s*import\s+(?:.*?\s+from\s+)?["']([^"']+)["']|require\(["']([^"']+)["']\)/gm
    let m
    while ((m = re.exec(src))) out.push(m[1] || m[2])
  }
  if (PY_EXT.has(ext)) {
    const re = /^\s*(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.]+))/gm
    let m
    while ((m = re.exec(src))) out.push(m[1] || m[2])
  }
  if (GO_EXT.has(ext)) {
    const re = /^\s*import\s+(?:\(\s*)?["']([^"']+)["']/gm
    let m
    while ((m = re.exec(src))) out.push(m[1])
  }
  return [...new Set(out)].slice(0, 20)
}

function extractExports(file, src) {
  const ext = path.extname(file).toLowerCase()
  if (!JS_EXT.has(ext)) return []
  const out = []
  const re = /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g
  let m
  while ((m = re.exec(src))) out.push(m[1])
  return [...new Set(out)].slice(0, 20)
}

function extractCalls(file, src) {
  const ext = path.extname(file).toLowerCase()
  if (!JS_EXT.has(ext)) return []
  const out = []
  const re = /\b([A-Za-z_$][\w$]*)\s*\(/g
  let m
  let count = 0
  while ((m = re.exec(src)) && count < 30) {
    const name = m[1]
    if (!["if", "for", "while", "switch", "catch", "function", "return", "import", "export"].includes(name)) {
      out.push(name)
      count++
    }
  }
  return [...new Set(out)].slice(0, 20)
}

function extractTypes(file, src) {
  const ext = path.extname(file).toLowerCase()
  if (!JS_EXT.has(ext) || !file.endsWith(".ts") && !file.endsWith(".tsx")) return []
  const out = []
  const re = /\b(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g
  let m
  while ((m = re.exec(src))) out.push(m[1])
  return [...new Set(out)].slice(0, 20)
}

function isSource(file) {
  const ext = path.extname(file).toLowerCase()
  return JS_EXT.has(ext) || PY_EXT.has(ext) || GO_EXT.has(ext) || RS_EXT.has(ext)
}
function isConfig(file) {
  const base = path.basename(file).toLowerCase()
  if (["package.json", "tsconfig.json", "cargo.toml", "go.mod", "pyproject.toml", "makefile", ".gitignore"].includes(base)) return true
  const ext = path.extname(file).toLowerCase()
  return CFG_EXT.has(ext) || JSON_EXT.has(ext)
}
function isTest(file) {
  return /\.test\.|\.spec\.|__tests__|test_|_test\.go|\.test\.ts|\.test\.js/i.test(file)
}

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
  let base
  try { base = path.resolve(root || process.cwd()) } catch { return [] }
  const skip = new Set([...SKIP, ...gitignoreDirs(base)])
  const found = []
  let scanned = 0
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
      if (!isSource(e.name) && !isConfig(e.name)) continue
      scanned++
      let src = ""
      try {
        const st = fs.statSync(full)
        if (st.size > maxBytesPerFile) continue
        src = fs.readFileSync(full, "utf8")
      } catch { continue }
      const symbols = [...new Set(extractSymbols(e.name, src))]
      const imports = extractImports(e.name, src)
      const exports = extractExports(e.name, src)
      const calls = extractCalls(e.name, src)
      const types = extractTypes(e.name, src)
      const test = isTest(full)
      const config = isConfig(e.name)
      if (symbols.length || imports.length || config || test) {
        found.push({ rel: path.relative(base, full), symbols, imports, exports, calls, types, test, config })
      }
    }
  }
  walk(base, 0)
  return found
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
  let base
  try { base = path.resolve(root || process.cwd()) } catch { return { files: [], edges: [], stats: {} } }
  const skip = new Set([...SKIP, ...gitignoreDirs(base)])
  const files = []
  const edges = []
  let scanned = 0
  const walk = (dir, depth) => {
    if (scanned >= maxFiles || depth > 8) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (scanned >= maxFiles) return
      if (skip.has(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      if (!isSource(e.name) && !isConfig(e.name)) continue
      scanned++
      let src = ""
      try {
        const st = fs.statSync(full)
        if (st.size > maxBytesPerFile) continue
        src = fs.readFileSync(full, "utf8")
      } catch { continue }
      const rel = path.relative(base, full)
      const node = {
        path: rel,
        imports: extractImports(e.name, src),
        exports: extractExports(e.name, src),
        symbols: extractSymbols(e.name, src),
        calls: extractCalls(e.name, src),
        types: extractTypes(e.name, src),
        isTest: isTest(full),
        isConfig: isConfig(e.name),
        dependencies: [],
      }
      for (const imp of node.imports) {
        edges.push({ from: rel, to: imp, kind: "IMPORT" })
        node.dependencies.push(imp)
      }
      for (const exp of node.exports) {
        edges.push({ from: rel, to: exp, kind: "EXPORT" })
      }
      for (const sym of node.symbols) {
        edges.push({ from: rel, to: sym, kind: "SYMBOL" })
      }
      for (const call of node.calls) {
        edges.push({ from: rel, to: call, kind: "CALL" })
      }
      for (const t of node.types) {
        edges.push({ from: rel, to: t, kind: "TYPE" })
      }
      if (node.isTest) edges.push({ from: rel, kind: "TEST", to: "test" })
      if (node.isConfig) edges.push({ from: rel, kind: "CONFIG", to: "config" })
      for (const dep of node.dependencies) {
        edges.push({ from: rel, to: dep, kind: "DEPENDENCY" })
      }
      files.push(node)
    }
  }
  walk(base, 0)
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
    }
  }
}
