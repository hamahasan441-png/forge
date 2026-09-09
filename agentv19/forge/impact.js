/**
 * forge — impact radius (Ω, zero dependencies)
 *
 * Before a significant edit, approximate:
 *   what changes, who imports it, who tests it, which config depends on it.
 * The radius decides testing scope: a one-file leaf stays focused; a module
 * imported by 40 files expands to regression.
 *
 * Bounded: never walks the whole repo. Caps on files scanned and bytes read.
 * A miss is UNKNOWN, not "no dependents".
 */
import fs from "node:fs"
import path from "node:path"

const SCAN_FILES = 400
const SCAN_BYTES = 80_000
const MAX_IMPORTS = 40

const IMPORT_RE = /(?:import\s+(?:[^'"\n]+from\s+)?|require\s*\(\s*|from\s+)['"]([^'"]+)['"]/g
const TEST_HINT = /(?:\.test|\.spec|test_|_test|tests?[\\/])/i

export function parseImports(src, filename = "") {
  const out = []
  const text = String(src ?? "")
  IMPORT_RE.lastIndex = 0
  let m
  while ((m = IMPORT_RE.exec(text))) {
    const spec = m[1]
    if (!spec) continue
    out.push(resolveSpec(spec, filename))
    if (out.length >= MAX_IMPORTS) break
  }
  return unique(out)
}

function resolveSpec(spec, filename) {
  if (spec.startsWith(".")) {
    const dir = filename ? path.dirname(filename) : ""
    return path.normalize(dir ? path.join(dir, spec) : spec)
  }
  return spec
}

/**
 * @param {{ files: string[], cwd?: string, maxFiles?: number }} input
 * @returns {{ files, importers, tests, configs, radius, scope, unknown }}
 */
export function impactRadius(input = {}) {
  const files = unique((input.files || []).map((f) => String(f)).filter(Boolean)).slice(0, 40)
  const cwd = input.cwd || process.cwd()
  const importers = []
  const tests = []
  const configs = []
  let scanned = 0
  let unknown = files.length === 0

  const basenames = new Set(files.map((f) => stem(f)))
  const rels = new Set(files.map((f) => rel(cwd, f)))

  if (files.length && canRead(cwd)) {
    walk(cwd, (abs, relPath) => {
      scanned++
      if (scanned > (input.maxFiles || SCAN_FILES)) return false
      let src = ""
      try {
        const st = fs.statSync(abs)
        if (!st.isFile() || st.size > SCAN_BYTES) return true
        src = fs.readFileSync(abs, "utf8").slice(0, SCAN_BYTES)
      } catch { return true }
      const hits = parseImports(src, abs)
      const mentions = hits.some((h) => basenames.has(stem(h)) || rels.has(rel(cwd, h)))
        || [...basenames].some((b) => b && src.includes(b))
      if (mentions) {
        if (TEST_HINT.test(relPath)) tests.push(relPath)
        else if (/\.(json|ya?ml|toml|ini|config\.[cm]?js)$/i.test(relPath)) configs.push(relPath)
        else importers.push(relPath)
      }
      if (TEST_HINT.test(relPath) && files.some((f) => src.includes(path.basename(f)))) {
        if (!tests.includes(relPath)) tests.push(relPath)
      }
      return true
    })
  } else if (files.length) {
    unknown = true
  }

  const radius = files.length + importers.length + tests.length
  const scope = testingScope({ radius, importers: importers.length, tests: tests.length, files: files.length })
  return {
    files,
    importers: importers.slice(0, 40),
    tests: tests.slice(0, 20),
    configs: configs.slice(0, 12),
    radius,
    scope,
    unknown,
    scanned,
  }
}

/**
 * Map a radius onto the verification ladder:
 *   syntax → focused_test → module → integration → regression
 */
export function testingScope({ radius = 0, importers = 0, tests = 0, files = 0 } = {}) {
  if (files <= 1 && importers === 0) return ["syntax", "focused_test"]
  if (radius <= 3 && importers <= 2) return ["syntax", "focused_test"]
  if (importers <= 8) return ["syntax", "focused_test", "module_test"]
  if (importers <= 20) return ["syntax", "focused_test", "module_test", "integration"]
  return ["syntax", "focused_test", "module_test", "integration", "regression_test"]
}

function stem(p) {
  const b = path.basename(String(p || ""))
  return b.replace(/\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs)$/i, "")
}
function rel(cwd, p) {
  const s = String(p || "")
  if (s.startsWith(cwd)) return s.slice(cwd.length).replace(/^[\\/]/, "")
  return s
}
function unique(arr) {
  return [...new Set(arr)]
}
function canRead(dir) {
  try { return fs.statSync(dir).isDirectory() } catch { return false }
}

const SKIP_DIR = new Set([".git", "node_modules", "dist", "build", "coverage", ".forge", "__pycache__", ".next"])
function walk(root, visit) {
  const stack = [root]
  let n = 0
  while (stack.length) {
    const dir = stack.pop()
    let ents
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      if (e.name.startsWith(".") && e.name !== ".github") {
        if (SKIP_DIR.has(e.name)) continue
      }
      if (SKIP_DIR.has(e.name)) continue
      const abs = path.join(dir, e.name)
      const relPath = rel(root, abs)
      if (e.isDirectory()) {
        stack.push(abs)
        continue
      }
      n++
      if (visit(abs, relPath) === false) return
      if (n > SCAN_FILES) return
    }
  }
}
