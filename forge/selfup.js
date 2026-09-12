/**
 * forge — self-review, self-upgrade and rollback (v91 ULTIMATE, zero dependencies)
 *
 * THREE things, deliberately separate:
 *
 *  1. selfReview() — deterministic static review of a project's source. Finds
 *     duplicate logic, dead export surface, import cycles, oversized hotspots,
 *     security smells and unfinished work (TODO/FIXME). No model, no network,
 *     no heuristics that change between runs: the same tree yields the same
 *     findings, so it is safe to run before AND after every edit.
 *
 *  2. upgradePlan() — turns findings into concrete, reversible proposals with
 *     an impact statement, a risk level and a verification command. Proposals
 *     are evidence-driven: no evidence, no proposal.
 *
 *  3. applyUpgrades() / rollbackUpgrades() — applies proposals through a
 *     versioned manifest so every change has a recorded inverse.
 *
 * THE HARD INVARIANT (the same one extend.js holds): a self-upgrade never
 * rewrites forge's own kernel source. It changes configuration, project memory
 * and additive files — all reversible — and it refuses any payload that would
 * touch a .js file. Self-modifying kernel source is not a feature; it is how an
 * agent loses the ability to be audited.
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { execFile } from "node:child_process"
import { projectDir, appendMemory, memoryEntries, replaceMemory } from "./memory.js"
import { writeStateFile } from "./securefs.js"
import { loadConfig, saveConfig, getPath, setPath } from "./config.js"
import { redact } from "./secrets.js"

export const UPGRADES_FILE = "upgrades.json"

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "target", ".next", ".nuxt", "coverage", "__pycache__", ".venv", "venv", ".cache", ".turbo", ".output", "vendor"])
const SOURCE_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rs", ".go", ".sh"])
const MAX_FILES = 4000
const MAX_BYTES_PER_FILE = 2_000_000
const DUP_WINDOW = 6
const MAX_FINDINGS = 200
/** Per-category ceiling: one noisy category must not crowd out the others. */
const CATEGORY_CAP = 400
const LARGE_FILE_LINES = 1200
const LONG_FN_LINES = 150

export const CATEGORY = Object.freeze({
  DUPLICATE: "duplicate_logic",
  DEAD_CODE: "dead_code",
  ARCHITECTURE: "architecture",
  PERFORMANCE: "performance",
  SECURITY: "security",
  UNFINISHED: "unfinished_work",
})

export const SEVERITY = Object.freeze({ HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW", INFO: "INFO" })

/** Sort weight: HIGH first. Used by the review cut and the formatter alike. */
const ORDER = { [SEVERITY.HIGH]: 0, [SEVERITY.MEDIUM]: 1, [SEVERITY.LOW]: 2, [SEVERITY.INFO]: 3 }

export function upgradesPath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), UPGRADES_FILE)
}

/** Walk the project for source files. Bounded, ignore-aware, never follows
 *  symlinks out of the tree. */
export function listSourceFiles(cwd = process.cwd(), { max = MAX_FILES, exts = SOURCE_EXT, includeTests = true } = {}) {
  const root = path.resolve(cwd)
  const out = []
  const walk = (dir, depth) => {
    if (depth > 12 || out.length >= max) return
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (out.length >= max) return
      if (e.name.startsWith(".") && e.name !== ".github") { if (e.isDirectory()) continue }
      const full = path.join(dir, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(full, depth + 1)
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase()
        if (!exts.has(ext)) continue
        const rel = path.relative(root, full)
        if (!includeTests && /(^|[\\/])(tests?|__tests__)([\\/]|$)|[.-_]test[s]?\.(mjs|js|ts|py)$/.test(rel)) continue
        out.push(rel)
      }
    }
  }
  walk(root, 0)
  return out.sort()
}

function readSource(root, rel) {
  try {
    const st = fs.statSync(path.join(root, rel))
    if (st.size > MAX_BYTES_PER_FILE) return null
    return fs.readFileSync(path.join(root, rel), "utf8")
  } catch { return null }
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s+["'](\.[^"']+\.m?js)["']|import\(\s*["'](\.[^"']+\.m?js)["']\s*\)/g
const EXPORT_NAMED_RE = /export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g
const EXPORT_LIST_RE = /export\s*\{([^}]+)\}/g
const REEXPORT_RE = /export\s*\{[^}]*\}\s*from\s*["'][^"']+["']/g

/** Strip comments and blank lines, keeping line numbers aligned via "" placeholders. */
function significantLines(src) {
  const raw = String(src).split("\n")
  const out = []
  let inBlock = false
  for (let i = 0; i < raw.length; i++) {
    let l = raw[i]
    if (inBlock) {
      const end = l.indexOf("*/")
      if (end >= 0) { l = l.slice(end + 2); inBlock = false } else { out.push(""); continue }
    }
    const bs = l.indexOf("/*")
    if (bs >= 0) {
      const be = l.indexOf("*/", bs + 2)
      if (be >= 0) l = l.slice(0, bs) + l.slice(be + 2)
      else { l = l.slice(0, bs); inBlock = true }
    }
    l = l.replace(/\/\/.*$/, "").replace(/#(?!!).*$/, (m, off, s) => (/^\s*#!/.test(s.slice(0, off + 1)) ? m : "")).trim()
    out.push(l)
  }
  return out
}

/** Normalize a code line so formatting differences are not "different logic". */
function normalizeLine(l) {
  return String(l)
    .replace(/\s+/g, " ")
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, "STR")
    .replace(/\b\d+(\.\d+)?\b/g, "N")
    .trim()
}

/**
 * Remove string contents and regex-literal bodies from a line, so pattern
 * checks see calls and not the text they happen to contain.
 */
export function stripLiterals(l) {
  let out = ""
  const src = String(l ?? "")
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === "\"" || c === "'" || c === "`") {
      const q = c
      i++
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++ }
      out += "STR"
      continue
    }
    if (c === "/") {
      const prev = out.trimEnd().slice(-1)
      const startsRegex = prev === "" || "=(,:[!&|?{};".includes(prev)
      const isComment = src[i + 1] === "/" || src[i + 1] === "*"
      if (startsRegex && !isComment) {
        i++
        let cls = false
        while (i < src.length) {
          if (src[i] === "\\") { i += 2; continue }
          if (src[i] === "[") cls = true
          else if (src[i] === "]") cls = false
          else if (src[i] === "/" && !cls) break
          i++
        }
        out += "RE"
        continue
      }
    }
    out += c
  }
  return out
}

/**
 * Duplicate-logic detection: identical windows of N significant lines appearing
 * in more than one place. Formatting-insensitive, string-literal-insensitive.
 */
export function findDuplicates(mods, { window = DUP_WINDOW, max = 40 } = {}) {
  const map = new Map()
  for (const m of mods) {
    const sig = m.significant
    for (let i = 0; i + window <= sig.length; i++) {
      const win = sig.slice(i, i + window).map(normalizeLine)
      if (win.some((l) => !l)) continue
      // require real content: at least 3 lines with an identifier-ish token
      if (win.filter((l) => /[A-Za-z_$][\w$]*\s*[=(.]/.test(l)).length < 3) continue
      const key = crypto.createHash("sha1").update(win.join("\u0001")).digest("hex").slice(0, 16)
      const rec = map.get(key) || { key, lines: window, places: [], sample: win.join("\n") }
      const last = rec.places[rec.places.length - 1]
      // overlapping windows in the same file are one occurrence, not N
      if (!last || last.file !== m.file || i - last.line >= window) rec.places.push({ file: m.file, line: i + 1 })
      map.set(key, rec)
    }
  }
  return [...map.values()]
    .filter((r) => r.places.length >= 2)
    .sort((a, b) => (b.places.length * b.lines) - (a.places.length * a.lines))
    .slice(0, max)
}

/** Exported names per module (JS/TS). */
function exportedNames(src) {
  const names = new Set()
  let m
  const body = String(src).replace(REEXPORT_RE, "")
  EXPORT_NAMED_RE.lastIndex = 0
  while ((m = EXPORT_NAMED_RE.exec(body))) names.add(m[1])
  EXPORT_LIST_RE.lastIndex = 0
  while ((m = EXPORT_LIST_RE.exec(body))) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split(/\s+as\s+/).pop().trim()
      if (n && n !== "default") names.add(n)
    }
  }
  return [...names]
}

function importedFrom(src) {
  const out = []
  let m
  IMPORT_RE.lastIndex = 0
  while ((m = IMPORT_RE.exec(String(src)))) out.push(path.basename(m[1] || m[2]))
  return [...new Set(out)]
}

/** Longest top-level function in a file (column-0 declarations only). */
function longestFunction(src) {
  const lines = String(src).split("\n")
  let best = { name: null, lines: 0, line: 0 }
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const m = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(l)
    if (m && !cur) { cur = { name: m[1], start: i } ; continue }
    if (cur && /^\}/.test(l)) {
      const n = i - cur.start + 1
      if (n > best.lines) best = { name: cur.name, lines: n, line: cur.start + 1 }
      cur = null
    }
  }
  return best
}

const SECURITY_CHECKS = [
  { id: "eval", severity: SEVERITY.HIGH, re: /(^|[^.\w])eval\s*\(|new\s+Function\s*\(/, why: "dynamic code evaluation — anything that reaches this string runs with the process's authority", fix: "replace with an explicit dispatch table or a data-driven parser" },
  { id: "shell-interpolation", severity: SEVERITY.HIGH, re: /exec(?:Sync|File)?\s*\(\s*[`'"][^`'"]*\$\{|exec(?:Sync)?\s*\([^)]*\+\s*[A-Za-z_$]/, why: "shell command built by interpolation — a value with metacharacters becomes a command", fix: "use execFile with an argument array (no shell), as the git_* tools do" },
  { id: "world-writable", severity: SEVERITY.MEDIUM, re: /chmod(?:Sync)?\s*\([^)]*0?o?777|mode\s*:\s*0?o?777/, why: "world-writable file or directory", fix: "use 0o600 for state, 0o700 for directories" },
  { id: "hardcoded-credential", severity: SEVERITY.HIGH, re: /["'`](sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})["'`]|-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: "a credential-shaped literal in source", fix: "read it from config/env and redact it from logs" },
  { id: "weak-random-token", severity: SEVERITY.MEDIUM, re: /Math\.random\(\)[^\n]{0,60}(token|secret|nonce|salt|password|key)|(token|secret|nonce|salt|password)\w*\s*=\s*Math\.random\(\)/i, why: "Math.random() is not a CSPRNG — predictable tokens", fix: "use crypto.randomBytes / crypto.randomUUID" },
]

const TODO_RE = /^\s*(?:\/\/|#|\*|\/\*)\s*(TODO|FIXME|HACK|XXX)\b[:\s]?(.*)$/i

/** A finding sink with a per-category ceiling (see selfReview). */
function sink(maxFindings) {
  const findings = []
  const perCategory = {}
  return {
    findings,
    push(f) {
      perCategory[f.category] = (perCategory[f.category] || 0) + 1
      if (perCategory[f.category] > CATEGORY_CAP) return
      if (findings.length < maxFindings * 4) findings.push(f)
    },
  }
}

/** Duplicate logic: identical significant-line windows in more than one place. */
function duplicateFindings(mods, sink) {
  const dups = findDuplicates(mods)
  for (const d of dups) {
    const crossFile = new Set(d.places.map((p) => p.file)).size > 1
    sink.push({
      id: `dup:${d.key}`, category: CATEGORY.DUPLICATE,
      severity: crossFile ? SEVERITY.MEDIUM : SEVERITY.LOW,
      file: d.places[0].file, line: d.places[0].line,
      evidence: `${d.lines} identical significant lines in ${d.places.length} places: ${d.places.slice(0, 4).map((p) => `${p.file}:${p.line}`).join(", ")}`,
      suggestion: "extract the shared block into one function both call sites import",
      impact: `${d.places.length} copies drift independently — a fix in one is a bug in the others`,
    })
  }
  return dups
}

/** Exported names that nothing imports. Entrypoints are exempt: they export for
 *  humans, not for importers. */
function deadExportFindings(mods, sink) {
  const importersOf = new Map()
  for (const m of mods) for (const dep of m.imports) {
    if (!importersOf.has(dep)) importersOf.set(dep, [])
    importersOf.get(dep).push(m)
  }
  for (const m of mods) {
    if (!m.exports.length) continue
    if (/(^|[\\/])(forge|index|cli|main)\.m?js$/.test(m.file)) continue
    const users = importersOf.get(path.basename(m.file)) || []
    const src = m.raw.join("\n")
    for (const name of m.exports) {
      const needle = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`)
      if (users.some((u) => needle.test(u.raw.join("\n")))) continue
      const selfUses = (src.match(new RegExp(needle.source, "g")) || []).length
      sink.push({
        id: `dead:${m.file}:${name}`, category: CATEGORY.DEAD_CODE,
        severity: selfUses > 1 ? SEVERITY.INFO : SEVERITY.LOW,
        file: m.file, line: m.raw.findIndex((l) => new RegExp(`export[^\\n]*\\b${name}\\b`).test(l)) + 1,
        evidence: `export "${name}" is imported by nothing${selfUses > 1 ? ` (used ${selfUses - 1}× inside the module — export is unnecessary)` : " and unused inside the module"}`,
        suggestion: selfUses > 1 ? `drop the \`export\` keyword on ${name}` : `remove ${name} or wire it up`,
        impact: "an unused export is an API promise nobody keeps — it must still be maintained and tested",
      })
    }
  }
}

/** Architecture: import cycles, which make load order load-bearing. */
function cycleFindings(cycles, sink) {
  for (const c of cycles) {
    sink.push({
      id: `cycle:${c.join(">")}`, category: CATEGORY.ARCHITECTURE, severity: SEVERITY.MEDIUM,
      file: c[0], line: 1,
      evidence: `import cycle: ${c.join(" → ")}`,
      suggestion: "break the cycle by moving the shared piece into a leaf module both sides import",
      impact: "cycles make module load order load-bearing and hide initialization bugs",
    })
  }
}

/** Performance: modules and functions too large to test in isolation. */
function hotspotFindings(mods, sink) {
  for (const m of mods) {
    if (m.lines > LARGE_FILE_LINES) {
      sink.push({
        id: `size:${m.file}`, category: CATEGORY.PERFORMANCE, severity: SEVERITY.LOW,
        file: m.file, line: 1,
        evidence: `${m.lines} lines / ${(m.bytes / 1024).toFixed(0)} KB in one module`,
        suggestion: "split by responsibility — this module costs every importer its full parse",
        impact: "large modules dominate cold-start parse time and are hard to test in isolation",
      })
    }
    if (m.longest.lines > LONG_FN_LINES) {
      sink.push({
        id: `longfn:${m.file}:${m.longest.name}`, category: CATEGORY.PERFORMANCE, severity: SEVERITY.LOW,
        file: m.file, line: m.longest.line,
        evidence: `function ${m.longest.name}() spans ${m.longest.lines} lines`,
        suggestion: "extract the branches into named helpers",
        impact: "long functions cannot be unit-tested branch by branch",
      })
    }
  }
}

/** Security smells and unfinished work, line by line.
 *  Matching runs on the CODE of the line (stripLiterals): comments, string
 *  contents and regex bodies are data, not calls — otherwise the checker flags
 *  its own pattern table and every doc comment that mentions eval(). */
function lineFindings(mods, sink) {
  for (const m of mods) {
    for (let i = 0; i < m.raw.length; i++) {
      const l = m.raw[i]
      const code = stripLiterals(m.significant[i] || "")
      for (const chk of SECURITY_CHECKS) {
        if (!code || !chk.re.test(code)) continue
        // A smell inside a test fixture is real but not shippable-risk: drop it
        // one level and say why, instead of crying HIGH at a fixture.
        const inTest = m.isTest
        const sev = !inTest ? chk.severity
          : chk.severity === SEVERITY.HIGH ? (chk.id === "hardcoded-credential" ? SEVERITY.INFO : SEVERITY.MEDIUM)
            : chk.severity === SEVERITY.MEDIUM ? SEVERITY.LOW : chk.severity
        sink.push({
          id: `sec:${chk.id}:${m.file}:${i + 1}`, category: CATEGORY.SECURITY,
          severity: sev, file: m.file, line: i + 1,
          evidence: `${chk.id}: ${l.trim().slice(0, 140)}${inTest ? "  (test file)" : ""}`,
          suggestion: chk.fix, impact: chk.why,
        })
      }
      const t = TODO_RE.exec(l)
      if (t) {
        sink.push({
          id: `todo:${m.file}:${i + 1}`, category: CATEGORY.UNFINISHED, severity: SEVERITY.INFO,
          file: m.file, line: i + 1,
          evidence: `${t[1].toUpperCase()}: ${redact(t[2] || "").trim().slice(0, 160) || "(no text)"}`,
          suggestion: "either finish it or record it as a tracked task — a bare marker is invisible to planning",
          impact: "unfinished work that only exists as a comment is never scheduled",
        })
      }
    }
  }
}

/**
 * The full static review. Pure over the file tree; identical input ⇒ identical
 * findings, so it can be diffed before/after an edit.
 *
 * @param {{cwd?: string, files?: string[], includeTests?: boolean, maxFindings?: number}} input
 */
export function selfReview({ cwd = process.cwd(), files = null, includeTests = true, maxFindings = MAX_FINDINGS } = {}) {
  const root = path.resolve(cwd)
  const rels = files || listSourceFiles(root, { includeTests })
  const mods = []
  for (const rel of rels) {
    const src = readSource(root, rel)
    if (src == null) continue
    const lines = src.split("\n")
    mods.push({
      file: rel,
      bytes: Buffer.byteLength(src),
      lines: lines.length,
      raw: lines,
      significant: significantLines(src),
      exports: /\.m?js$/.test(rel) ? exportedNames(src) : [],
      imports: /\.m?js$/.test(rel) ? importedFrom(src) : [],
      longest: longestFunction(src),
      isTest: /(^|[\\/])(tests?|__tests__)([\\/]|$)|[.-_]test[s]?\.(mjs|js|ts|py)$/.test(rel),
    })
  }

  const out = sink(maxFindings)
  const dups = duplicateFindings(mods, out)
  deadExportFindings(mods, out)
  const cycles = findCycles(mods)
  cycleFindings(cycles, out)
  hotspotFindings(mods, out)
  lineFindings(mods, out)

  const bySeverity = {}
  const byCategory = {}
  for (const f of out.findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1
    byCategory[f.category] = (byCategory[f.category] || 0) + 1
  }
  // Severity-ordered cut: the most important findings are always the ones kept.
  const ranked = [...out.findings].sort((a, b) =>
    (ORDER[a.severity] - ORDER[b.severity]) || a.file.localeCompare(b.file) || a.line - b.line)
  const kept = ranked.slice(0, maxFindings)

  return {
    schema: 1,
    cwd: root,
    files: mods.length,
    lines: mods.reduce((n, m) => n + m.lines, 0),
    bytes: mods.reduce((n, m) => n + m.bytes, 0),
    duplicates: dups.length,
    cycles,
    findings: kept,
    bySeverity,
    byCategory,
    totalFindings: out.findings.length,
    truncated: out.findings.length > kept.length,
    at: Date.now(),
  }
}

/** Tarjan SCC over the relative-import graph; returns cycles of length ≥ 2. */
export function findCycles(mods) {
  const index = new Map(mods.map((m) => [path.basename(m.file), m.file]))
  const graph = new Map()
  for (const m of mods) graph.set(m.file, m.imports.map((d) => index.get(path.basename(d))).filter(Boolean))
  let idx = 0
  const ids = new Map(), low = new Map(), onStack = new Set(), stack = []
  const sccs = []
  const strongconnect = (v) => {
    ids.set(v, idx); low.set(v, idx); idx++
    stack.push(v); onStack.add(v)
    for (const w of graph.get(v) || []) {
      if (!ids.has(w)) { strongconnect(w); low.set(v, Math.min(low.get(v), low.get(w))) }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), ids.get(w)))
    }
    if (low.get(v) === ids.get(v)) {
      const comp = []
      let w
      do { w = stack.pop(); onStack.delete(w); comp.push(w) } while (w !== v)
      if (comp.length > 1) sccs.push(comp.sort())
    }
  }
  for (const v of graph.keys()) if (!ids.has(v)) strongconnect(v)
  return sccs
}

export function formatSelfReview(r, { limit = 40 } = {}) {
  if (!r) return "(no review)"
  const rows = [
    `self-review — ${r.files} file(s), ${r.lines} lines, ${(r.bytes / 1024).toFixed(0)} KB`,
    `  ${r.totalFindings ?? r.findings.length} finding(s)${r.truncated ? ` (showing the ${r.findings.length} most severe)` : ""} — ${Object.entries(r.bySeverity).sort((a, b) => ORDER[a[0]] - ORDER[b[0]]).map(([k, v]) => `${k} ${v}`).join(" • ") || "clean"}`,
  ]
  const sorted = [...r.findings].sort((a, b) => (ORDER[a.severity] - ORDER[b.severity]) || a.file.localeCompare(b.file) || a.line - b.line)
  let lastCat = null
  for (const f of sorted.slice(0, limit)) {
    if (f.category !== lastCat) { rows.push(`  ${f.category}`); lastCat = f.category }
    rows.push(`    ${f.severity.padEnd(6)} ${f.file}:${f.line}  ${f.evidence}`)
    rows.push(`           → ${f.suggestion}`)
  }
  if (sorted.length > limit) rows.push(`    … ${sorted.length - limit} more`)
  return rows.join("\n")
}

// ---------------------------------------------------------------------------
// self-upgrade: proposals, apply, rollback
// ---------------------------------------------------------------------------

export const RISK = Object.freeze({ LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH" })
/** Apply kinds. Every value MUST be handled by applyOne()/invertOne() — a kind
 *  nobody handles is a latent "unknown apply kind" crash at apply time. */
export const KIND = Object.freeze({ CONFIG_SET: "config.set", MEMORY_APPEND: "memory.append", FILE_CREATE: "file.create" })

function hasTestScript(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"))
    return typeof pkg?.scripts?.test === "string" ? pkg.scripts.test : null
  } catch { return null }
}

/**
 * Build the upgrade plan from evidence. Every proposal carries:
 *  - evidence   what was measured
 *  - impact     what changes if applied
 *  - risk       LOW / MEDIUM / HIGH
 *  - verify     the command that proves it did not break anything
 *  - apply      a reversible descriptor (null when not auto-applicable)
 *
 * @param {{cwd?: string, review?: object, config?: object}} input
 */
export function upgradePlan({ cwd = process.cwd(), review = null, config = null } = {}) {
  const root = path.resolve(cwd)
  const cfg = config || loadConfig().config
  const out = []
  const testCmd = hasTestScript(root)

  // 1. record the project's real test command so the agent never invents one
  if (testCmd) {
    let known = false
    try { known = memoryEntries("project", root).some((e) => /test command:/i.test(e.text)) } catch {}
    if (!known) {
      out.push({
        id: "memory.test-command",
        title: `remember the project's test command (${testCmd})`,
        evidence: `package.json scripts.test = "${testCmd}"; no "test command:" bullet in project memory`,
        impact: "verification stops guessing a test runner; focusedVerify and the verifier prompt get the real command",
        risk: RISK.LOW,
        verify: testCmd,
        apply: { kind: KIND.MEMORY_APPEND, tier: "project", text: `test command: ${testCmd}` },
      })
    }
  }

  // 2. dead export surface found by the review
  const dead = (review?.findings || []).filter((f) => f.category === CATEGORY.DEAD_CODE && f.severity !== SEVERITY.INFO)
  if (dead.length) {
    out.push({
      id: "code.dead-exports",
      title: `shrink the export surface (${dead.length} unused export(s))`,
      evidence: dead.slice(0, 5).map((f) => `${f.file}:${f.line} ${f.evidence}`).join(" | "),
      impact: "less public API to maintain; importers cannot depend on something untested",
      risk: RISK.MEDIUM,
      verify: testCmd || "run the project's test suite",
      apply: null, // a code change — proposed, never auto-applied
      autoApplicable: false,
    })
  }

  // 3. duplicate logic found by the review
  const dups = (review?.findings || []).filter((f) => f.category === CATEGORY.DUPLICATE)
  if (dups.length) {
    out.push({
      id: "code.deduplicate",
      title: `extract ${dups.length} duplicated block(s) into shared helpers`,
      evidence: dups.slice(0, 4).map((f) => f.evidence).join(" | "),
      impact: "one implementation instead of N — a fix applies everywhere",
      risk: RISK.MEDIUM,
      verify: testCmd || "run the project's test suite",
      apply: null,
      autoApplicable: false,
    })
  }

  // 4. import cycles
  const cyc = (review?.cycles || [])
  if (cyc.length) {
    out.push({
      id: "arch.cycles",
      title: `break ${cyc.length} import cycle(s)`,
      evidence: cyc.slice(0, 3).map((c) => c.join(" → ")).join(" | "),
      impact: "module load order stops being load-bearing",
      risk: RISK.MEDIUM,
      verify: testCmd || "run the project's test suite",
      apply: null,
      autoApplicable: false,
    })
  }

  // 5. missing CHANGELOG while the tree has source
  try {
    if (!fs.existsSync(path.join(root, "CHANGELOG.md")) && (review?.files || 0) > 5) {
      out.push({
        id: "docs.changelog",
        title: "create CHANGELOG.md",
        evidence: "no CHANGELOG.md at the project root; docsintel needs it to record breaking changes",
        impact: "releases get a history; breaking changes get a home",
        risk: RISK.LOW,
        verify: "read the file",
        apply: { kind: KIND.FILE_CREATE, path: "CHANGELOG.md", body: "# Changelog\n\nAll notable changes to this project are recorded here.\n" },
      })
    }
  } catch { /* unreadable root: skip */ }

  // 6. orchestration advisories off
  if (cfg?.agent?.orchestration === false) {
    out.push({
      id: "agent.orchestration",
      title: "re-enable orchestration advisories",
      evidence: "config agent.orchestration = false",
      impact: "the deterministic advisory crew (memory, blast radius, ledger, gate) reaches the plan again",
      risk: RISK.LOW,
      verify: "forge report",
      apply: { kind: KIND.CONFIG_SET, key: "agent.orchestration", value: true },
    })
  }

  return out
}

export function formatUpgradePlan(plan = [], { applied = null } = {}) {
  if (!plan.length) return "  no upgrades proposed — nothing measured needs changing"
  const rows = []
  for (const p of plan) {
    const state = applied?.includes(p.id) ? " [applied]" : p.apply ? "" : " [proposal only — not auto-applicable]"
    rows.push(`  ${p.id}${state}`)
    rows.push(`    ${p.title}`)
    rows.push(`    evidence : ${p.evidence}`)
    rows.push(`    impact   : ${p.impact}`)
    rows.push(`    risk     : ${p.risk}   verify: ${p.verify}`)
  }
  return rows.join("\n")
}

export function loadUpgrades(cwd = process.cwd()) {
  try {
    const raw = JSON.parse(fs.readFileSync(upgradesPath(cwd), "utf8"))
    return raw && typeof raw === "object" ? raw : { schema: 1, applied: [], history: [] }
  } catch { return { schema: 1, applied: [], history: [] } }
}

function saveUpgrades(cwd, rec) {
  return writeStateFile(upgradesPath(cwd), JSON.stringify({ schema: 1, applied: rec.applied || [], history: rec.history || [] }, null, 2))
}

/** The invariant, enforced where it matters. */
export function refusesKernelWrite(apply) {
  if (!apply) return false
  if (apply.kind === KIND.FILE_CREATE) return /\.m?js$|\.c?js$|\.ts$|\.tsx$|\.py$|\.rs$|\.go$/i.test(String(apply.path || ""))
  return false
}

/**
 * Apply proposals. Each one records its inverse in the manifest first, so a
 * rollback is data, not a guess.
 * @param {{cwd?: string, plan?: Array, only?: string[], dryRun?: boolean}} input
 */
export function applyUpgrades({ cwd = process.cwd(), plan = null, only = null, dryRun = false } = {}) {
  const root = path.resolve(cwd)
  const wanted = only?.length ? new Set(only) : null
  const results = []
  const rec = loadUpgrades(root)
  for (const p of plan || []) {
    if (wanted && !wanted.has(p.id)) { results.push({ id: p.id, ok: false, skipped: "not selected (--only)" }); continue }
    if (!p.apply) { results.push({ id: p.id, ok: false, skipped: "proposal only — not auto-applicable" }); continue }
    if (refusesKernelWrite(p.apply)) { results.push({ id: p.id, ok: false, skipped: "refused: a self-upgrade never writes source files" }); continue }
    try {
      const inverse = applyOne(root, p.apply, { dryRun })
      if (dryRun) { results.push({ id: p.id, ok: true, dryRun: true }); continue }
      rec.applied.push({ id: p.id, title: p.title, kind: p.apply.kind, at: Date.now(), inverse })
      saveUpgrades(root, rec)
      results.push({ id: p.id, ok: true, ...inverse.summary })
    } catch (e) {
      results.push({ id: p.id, ok: false, error: e?.message ?? String(e) })
    }
  }
  return { ok: results.every((r) => r.ok || r.skipped), results, dryRun, manifest: upgradesPath(root) }
}

function applyOne(root, apply, { dryRun }) {
  switch (apply.kind) {
    case KIND.CONFIG_SET: {
      const { config } = loadConfig()
      const previous = getPath(config, apply.key)
      if (previous === apply.value) return { summary: { unchanged: true }, previous, kind: apply.kind, key: apply.key }
      if (!dryRun) { setPath(config, apply.key, apply.value); saveConfig(config) }
      return { summary: { set: `${apply.key}=${JSON.stringify(apply.value)}`, previous }, previous, kind: apply.kind, key: apply.key }
    }
    case KIND.MEMORY_APPEND: {
      const text = String(apply.text || "")
      const had = (() => { try { return memoryEntries(apply.tier || "project", root).some((e) => e.text === text) } catch { return false } })()
      if (!had && !dryRun) appendMemory(apply.tier || "project", text, root, { source: "self-upgrade" })
      return { summary: { memory: had ? "already present" : `appended to ${apply.tier || "project"} memory` }, previous: had ? null : text, kind: apply.kind, tier: apply.tier || "project" }
    }
    case KIND.FILE_CREATE: {
      const target = path.join(root, apply.path)
      const existed = fs.existsSync(target)
      if (!existed && !dryRun) writeStateFile(target, apply.body || "", { mode: 0o644 })
      return { summary: { file: existed ? "already exists (untouched)" : `created ${apply.path}` }, previous: existed ? "EXISTS" : null, kind: apply.kind, path: apply.path }
    }
    default:
      throw new Error(`unknown apply kind: ${apply.kind}`)
  }
}

/** Roll back applied upgrades, newest first. */
export function rollbackUpgrades({ cwd = process.cwd(), id = null, all = false } = {}) {
  const root = path.resolve(cwd)
  const rec = loadUpgrades(root)
  const undone = []
  const targets = all ? [...rec.applied].reverse() : (id ? rec.applied.filter((a) => a.id === id).reverse() : [rec.applied[rec.applied.length - 1]].filter(Boolean))
  for (const a of targets) {
    try {
      const r = invertOne(root, a)
      rec.applied = rec.applied.filter((x) => x !== a)
      rec.history.push({ ...a, rolledBackAt: Date.now(), result: r })
      undone.push({ id: a.id, ok: true, ...r })
    } catch (e) {
      undone.push({ id: a.id, ok: false, error: e?.message ?? String(e) })
    }
  }
  saveUpgrades(root, rec)
  return { ok: undone.every((u) => u.ok), undone, remaining: rec.applied.length, manifest: upgradesPath(root) }
}

function invertOne(root, a) {
  const inv = a.inverse || {}
  switch (inv.kind) {
    case KIND.CONFIG_SET: {
      const { config } = loadConfig()
      if (inv.previous === undefined) { setPath(config, inv.key, undefined); saveConfig(config); return { restored: `${inv.key} removed` } }
      setPath(config, inv.key, inv.previous); saveConfig(config)
      return { restored: `${inv.key}=${JSON.stringify(inv.previous)}` }
    }
    case KIND.MEMORY_APPEND: {
      if (!inv.previous) return { restored: "nothing to remove" }
      const tier = inv.tier || "project"
      const kept = memoryEntries(tier, root).filter((e) => e.text !== inv.previous).map((e) => `- ${e.text}`)
      replaceMemory(tier, kept.join("\n"), root, { source: "self-upgrade rollback" })
      return { restored: `removed "${inv.previous.slice(0, 60)}" from ${tier} memory` }
    }
    case KIND.FILE_CREATE: {
      if (inv.previous === "EXISTS") return { restored: "file pre-existed — left untouched" }
      const target = path.join(root, inv.path || "")
      if (inv.path && fs.existsSync(target)) fs.rmSync(target)
      return { restored: `deleted ${inv.path}` }
    }
    default:
      return { restored: "no inverse recorded" }
  }
}

export function listUpgrades(cwd = process.cwd()) {
  return loadUpgrades(cwd)
}

/**
 * Verification hook: `node --check` every module in a directory. Real syntax
 * verification of real files — no network, no test framework required.
 * @returns {Promise<{ok: boolean, checked: number, failed: Array}>}
 */
export function syntaxCheck(cwd = process.cwd(), { files = null, concurrency = 4 } = {}) {
  const root = path.resolve(cwd)
  const targets = (files || listSourceFiles(root, { includeTests: false })).filter((f) => /\.m?js$/.test(f)).map((f) => path.join(root, f))
  let i = 0
  const failed = []
  let checked = 0
  const worker = () => new Promise((resolve) => {
    const next = () => {
      if (i >= targets.length) return resolve()
      const file = targets[i++]
      execFile(process.execPath, ["--check", file], { timeout: 20_000 }, (err, _stdout, stderr) => {
        checked++
        if (err) failed.push({ file: path.relative(root, file), error: String(stderr || err.message).split("\n")[0].slice(0, 200) })
        next()
      })
    }
    next()
  })
  return Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, targets.length || 1)) }, worker))
    .then(() => ({ ok: failed.length === 0, checked, failed }))
}
