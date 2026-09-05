/**
 * forge — repo map / symbol index (v20.2, P3-1).
 *
 * A cheap, bounded map of the project's source files and their top-level
 * symbols, injected into the agent's system prompt so it can locate code
 * without spending tool calls on ls + grep. Zero dependencies, regex-based,
 * best-effort: an unparseable file just contributes nothing.
 *
 * Deliberately bounded in every direction (files scanned, bytes read per file,
 * symbols per file, total output) so it costs a predictable, small number of
 * tokens and never stalls on a huge monorepo. Built once per agent run.
 */
import fs from "node:fs"
import path from "node:path"

// self-contained skip set (mirrors tools.js DEFAULT_SKIP; kept local so this
// module has no dependency on the tool layer)
const SKIP = new Set([
  "node_modules", ".git", ".hg", ".svn", ".next", ".nuxt", ".svelte-kit",
  "dist", "build", "coverage", "__pycache__", ".turbo", ".cache",
  ".venv", "venv", ".mypy_cache", ".pytest_cache", ".gradle", ".forge",
])

// extension → symbol extractor. Each returns an array of top-level names.
const JS_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"])
const PY_EXT = new Set([".py"])
const GO_EXT = new Set([".go"])
const RS_EXT = new Set([".rs"])

function jsSymbols(src) {
  const out = []
  const re = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm
  let m
  while ((m = re.exec(src))) out.push(m[1])
  // export { a, b as c } — take the exported (post-"as") names
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
  const re = /^(?:def|class)\s+([A-Za-z_]\w*)/gm // top-level only (no leading space)
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

function isSource(file) {
  const ext = path.extname(file).toLowerCase()
  return JS_EXT.has(ext) || PY_EXT.has(ext) || GO_EXT.has(ext) || RS_EXT.has(ext)
}

/** Directory names ignored by the root .gitignore (bare-name entries only). */
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

/**
 * Build a compact repo map for `root`. Returns a prompt-ready string ("" when
 * nothing useful was found). Options are all bounded with sane defaults.
 */
export function buildRepoMap(root, {
  maxFiles = 400,        // stop walking after this many source files
  maxListed = 60,        // files shown in the map
  maxSymbols = 12,       // symbols shown per file
  maxBytesPerFile = 256 * 1024, // never read more than this from one file
  maxChars = 4000,       // total output cap
} = {}) {
  let base
  try { base = path.resolve(root || process.cwd()) } catch { return "" }
  const skip = new Set([...SKIP, ...gitignoreDirs(base)])
  const found = [] // { rel, symbols }
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
      if (!isSource(e.name)) continue
      scanned++
      let src = ""
      try {
        const st = fs.statSync(full)
        if (st.size > maxBytesPerFile) continue
        src = fs.readFileSync(full, "utf8")
      } catch { continue }
      const symbols = [...new Set(extractSymbols(e.name, src))]
      if (symbols.length) found.push({ rel: path.relative(base, full), symbols })
    }
  }
  walk(base, 0)
  if (!found.length) return ""
  // most informative files first (more exported symbols), then path order
  found.sort((a, b) => b.symbols.length - a.symbols.length || a.rel.localeCompare(b.rel))
  const lines = ["REPO MAP (top-level symbols — use this to locate code before ls/grep):"]
  let used = lines[0].length
  let shown = 0
  for (const f of found) {
    if (shown >= maxListed) break
    const syms = f.symbols.slice(0, maxSymbols).join(", ")
    const more = f.symbols.length > maxSymbols ? `, +${f.symbols.length - maxSymbols} more` : ""
    const line = `- ${f.rel}: ${syms}${more}`
    if (used + line.length + 1 > maxChars) break
    lines.push(line)
    used += line.length + 1
    shown++
  }
  if (found.length > shown) lines.push(`… (+${found.length - shown} more source files)`)
  return lines.join("\n")
}
