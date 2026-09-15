/**
 * forge — self-audit: find capability that exists but nothing uses (v105)
 *
 * WHY THIS MODULE EXISTS, stated as evidence rather than ambition.
 *
 * Across v100–v104 every shipped improvement but one came from asking the same
 * question by hand, with a throwaway script each time:
 *
 *   "What does this repository already own that nothing reads?"
 *
 *   v100  evaluate.js     `stale` written by markStaleSkills, never read back
 *   v101  modelstrategy   per-class success data written, never routed on
 *   v101  langadapter     tree-sitter PROBED, then the regex used anyway
 *   v102  review.js       adversarialReview reachable only from meta.js
 *   v102  compaction.js   historyIsWellFormed exported, tested, never called
 *   v103  dag.js          invalidateNodes: zero production callers
 *   v104  tools.js        allowOutsideProject threaded everywhere, read nowhere
 *   —     recovery.js     reconcileEffectByKind never called, and the input it
 *                         needs (expected.packages) never produced
 *
 * Eight findings, one repeatable question. A capability that only exists as a
 * habit of whoever is driving is not a capability the system has. This module
 * is that question, mechanized — so it runs on demand, on any repository,
 * including forge's own.
 *
 * WHAT IT IS AND IS NOT. This is a STATIC analyzer over the module graph. It
 * finds DISCONNECTION, which is a structural fact it can prove. It does not
 * find incorrectness, and it never claims to: a function with fifty callers can
 * still be wrong, and this module would call it healthy. Every finding is a
 * lead with its evidence attached, to be confirmed by reading the code — which
 * is exactly how the eight above were confirmed.
 *
 * PRECISION IS THE WHOLE VALUE. An analyzer that cries wolf gets ignored, so
 * the counting is deliberately careful about the ways my own first attempt at
 * this got it wrong:
 *   - intra-module use counts. My first script only counted CROSS-module
 *     references and "found" router.js's planChain dead — it is called by
 *     toolGuidance three lines down, in the same file.
 *   - comments and string literals are stripped before counting, so a name
 *     mentioned in its own doc comment is not mistaken for a caller.
 *   - re-exports and dynamic import() are followed.
 *   - the definition site itself is never counted as a use.
 */
import fs from "node:fs"
import path from "node:path"

export const FINDING = Object.freeze({
  /** Exported, exercised by tests, and no production code calls it. The
   *  highest-signal class: someone built and verified a capability, then it
   *  was never wired in. Six of the eight findings above were this. */
  ORPHANED_CAPABILITY: "orphaned-capability",
  /** Exported and referenced by nothing at all, tests included. Usually dead
   *  weight rather than lost capability — cheaper to confirm, worth less. */
  DEAD_EXPORT: "dead-export",
  /** A module no other module imports. Either an entry point (fine) or an
   *  island (not fine). Entry points are filtered by the caller. */
  ISLAND_MODULE: "island-module",
})

/** Names that are almost never capability — formatters, banners, size probes.
 *  Reporting these as lost capability is how an analyzer trains people to
 *  ignore it. */
const COSMETIC = /^(format|render|print|describe|banner|label|short|pad|fmt|emoji|color|colour)/i
const METRIC = /(Stats|Count|Size|Len|Length)$/

/**
 * Remove doc comments so a name discussed in prose is not counted as a caller.
 *
 * DELIBERATELY LINE-ANCHORED, and that is the whole design. My first version
 * tracked string literals too, and desynchronized on the first regex literal
 * containing a quote — `/["']/` looks like the start of a string to a scanner
 * that does not know about regex literals. It ate 66KB of tools.js, taking
 * `[...TOOL_DEFS]` with it, and reported a heavily-used export as orphaned.
 *
 * So: only comments that START a line are removed. A line beginning with `//`
 * cannot be a regex (`//` is not a valid empty regex), and a line beginning
 * with `/*` cannot be one either, so neither pattern can desync on code. Doc
 * blocks — the ones that actually cause false positives — are all in this
 * shape.
 *
 * String literals are now KEPT. That can cause a name mentioned in a string to
 * be counted as a use, which HIDES a finding. That is the right way to be
 * wrong: this tool's failure mode should be missing a lead, never inventing
 * one, because an analyzer that cries wolf gets switched off.
 */
export function stripNonCode(src) {
  const lines = String(src ?? "").split("\n")
  const out = []
  let inBlock = false
  for (const line of lines) {
    if (inBlock) {
      if (line.includes("*/")) { inBlock = false; out.push("") }
      else out.push("")
      continue
    }
    if (/^\s*\/\//.test(line)) { out.push(""); continue }
    if (/^\s*\/\*/.test(line)) {
      if (!line.includes("*/")) inBlock = true
      out.push("")
      continue
    }
    out.push(line)
  }
  return out.join("\n")
}

/**
 * Every relative module specifier this source imports, static or dynamic.
 * Returns the raw specifiers ("./x.js", "../lib/y.js") — resolution against
 * the importing file's directory is the caller's job, because only the caller
 * knows where the file sits.
 */
export function importsOf(code) {
  const hits = new Set()
  for (const m of code.matchAll(/from\s*["'](\.[^"']+)["']/g)) hits.add(m[1])
  for (const m of code.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g)) hits.add(m[1])
  for (const m of code.matchAll(/require\(\s*["'](\.[^"']+)["']\s*\)/g)) hits.add(m[1])
  return [...hits]
}

/** Source files under `dir`, recursively, skipping the usual noise. */
export function sourceFiles(dir, { exts = [".js", ".mjs"], skip = SKIP_DIRS, maxFiles = 4000 } = {}) {
  const out = []
  const walk = (d, rel) => {
    if (out.length >= maxFiles) return
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= maxFiles) return
      if (e.name.startsWith(".") && e.name !== ".") continue
      const abs = path.join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(abs, r); continue }
      if (exts.some((x) => e.name.endsWith(x))) out.push(r)
    }
  }
  walk(dir, "")
  return out
}

export const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "vendor",
  "coverage", "__pycache__", ".git", ".next", ".forge"])

/** Every top-level export this source declares. */
export function exportsOf(code) {
  const out = []
  for (const m of code.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) out.push({ name: m[1], kind: "function" })
  for (const m of code.matchAll(/^export\s+(?:const|let)\s+(\w+)/gm)) out.push({ name: m[1], kind: "const" })
  for (const m of code.matchAll(/^export\s+class\s+(\w+)/gm)) out.push({ name: m[1], kind: "class" })
  return out
}

/**
 * Count whole-word occurrences of `name` in already-stripped code.
 *
 * The leading guard excludes `.` so `obj.name` is not counted as a use of a
 * free identifier `name`. That guard has one hole worth naming, because it
 * produced a false positive on the very first real run: SPREAD. In
 * `[...TOOL_DEFS]` the character before the identifier is a dot — part of
 * `...`, not a member access — so tools.js's own use of TOOL_DEFS was invisible
 * and a heavily-used export was reported as orphaned capability.
 *
 * Spread/rest is the only JS construct where `...` precedes an identifier, so
 * collapsing it to a space before matching is safe and closes the hole.
 */
export function countRefs(code, name) {
  const flat = String(code ?? "").split("...").join(" ")
  const re = new RegExp(`(^|[^A-Za-z0-9_$.])${name}(?![A-Za-z0-9_$])`, "g")
  return (flat.match(re) || []).length
}


/**
 * The body of `name`'s definition, by brace matching from its declaration.
 * Bounded; returns "" when the shape is not a braced function.
 */
export function bodyOf(code, name) {
  const decl = new RegExp(`^export\\s+(?:async\\s+)?function\\s+${name}\\b`, "m")
  const m = decl.exec(String(code ?? ""))
  if (!m) return ""
  // The body's `{` is NOT simply the first one after the declaration: a default
  // parameter gets there first. `defaultRegistry(config = {})` matched the `{}`
  // in the parameter list, closed immediately, and returned an empty body — so
  // every function with a defaulted object parameter looked like it had no body
  // at all. Take the first brace at parenthesis depth zero instead.
  let open = -1
  let paren = 0
  for (let i = m.index; i < code.length && i - m.index < 4000; i++) {
    const ch = code[i]
    if (ch === "(") paren++
    else if (ch === ")") paren--
    else if (ch === "{" && paren === 0) { open = i; break }
  }
  if (open < 0) return ""
  let depth = 0
  for (let i = open; i < code.length && i - open < 20000; i++) {
    if (code[i] === "{") depth++
    else if (code[i] === "}") { depth--; if (depth === 0) return code.slice(open + 1, i) }
  }
  return ""
}

/**
 * Is this export a THIN ALIAS — a body that does nothing but hand off to
 * something else?
 *
 * Found by USING the analyzer rather than by designing it. The first real run
 * ranked six leads at the top, and four were one-liners delegating to a
 * function that is itself used:
 *
 *   defaultRegistry  → createRegistry({ config })
 *   applyUnifiedDiff → applyParsedPatch(filesMap, parsePatch(patchText))
 *   isPrivateAddress → blockedAddressReason(ip) !== null
 *   canCompleteDAG   → canCompleteTask({ … })
 *
 * Every one is a TRUE positive — nothing calls them — and every one is
 * worthless as a lead, because the capability behind them is wired and
 * working. An unused convenience wrapper is not lost capability. Crowding the
 * top of the report with these is how an analyzer teaches people to skim past
 * it, so they are still reported, and ranked below the real thing.
 */
export function isThinAlias(body) {
  const code = String(body ?? "").trim()
  if (!code) return false
  // strip the delegation's own arguments so a long argument list does not
  // disguise a one-line hand-off
  const statements = code.split(/;|\n/).map((x) => x.trim()).filter(Boolean)
  if (statements.length > 1 && !/^return\b/.test(code)) return false
  return /^return\s+[A-Za-z_$][\w$]*\s*\(/.test(code) || /^return\s+[A-Za-z_$][\w$]*\s*\(/.test(statements[0] ?? "")
}

/**
 * Analyze a directory of modules.
 *
 * Identifier counting uses the comment/string-stripped copy; import-path
 * extraction uses the raw source, because a path is itself a string literal.
 *
 * @param dir         project root; walked recursively, skipping build/vendor dirs
 * @param testDir     directory of test files, or null
 * @param entryPoints modules that are meant to have no importer (CLI, workers)
 * @param skipDirs    extra directory names to ignore, on top of SKIP_DIRS —
 *                    bundled standalone scripts are not part of the graph
 * @param read        injectable reader, for tests
 * @returns { modules, findings, stats }
 */
export function analyzeModules({ dir, testDir = null, entryPoints = [], read = null, skipDirs = [] } = {}) {
  const readFile = read ?? ((p) => fs.readFileSync(p, "utf8"))
  const skip = new Set([...SKIP_DIRS, ...skipDirs])

  const files = sourceFiles(dir, { exts: [".js"], skip })
  const src = new Map()
  const stripped = new Map()
  for (const f of files) {
    let text = ""
    try { text = readFile(path.join(dir, f)) } catch { continue }
    src.set(f, text)
    stripped.set(f, stripNonCode(text))
  }

  // tests are one blob: we only ask "does any test mention this", never which
  const testBlob = testDir
    ? sourceFiles(testDir, { exts: [".mjs", ".js", ".ts"] })
        .map((f) => { try { return stripNonCode(readFile(path.join(testDir, f))) } catch { return "" } })
        .join("\n")
    : ""

  // Who imports whom. NOTE: this reads the RAW source, not the stripped copy —
  // stripNonCode() blanks string literals, and an import path IS a string
  // literal, so running this on stripped code reported 146 of 148 modules as
  // islands. Caught by validating against known-good structure rather than by
  // reading the code.
  const importers = new Map([...src.keys()].map((f) => [f, new Set()]))
  for (const [f, raw] of src) {
    for (const spec of importsOf(raw)) {
      // resolve "./x.js" / "../lib/y.js" against the IMPORTING file's directory,
      // then try the extensionless forms node resolves for you
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec)).replace(/^\.\//, "")
      for (const cand of [base, `${base}.js`, `${base}/index.js`]) {
        if (importers.has(cand)) { importers.get(cand).add(f); break }
      }
    }
  }

  const entry = new Set(entryPoints)
  const findings = []
  const modules = []

  for (const [file, code] of stripped) {
    const loc = String(src.get(file) ?? "").split("\n").length
    const exps = exportsOf(code)
    const importedBy = [...(importers.get(file) ?? [])]
    modules.push({ file, loc, exports: exps.length, importedBy })

    if (!importedBy.length && !entry.has(file)) {
      findings.push({
        kind: FINDING.ISLAND_MODULE, file, name: null, loc,
        testRefs: countRefs(testBlob, file.replace(/\.js$/, "")),
        evidence: `no module in ${path.basename(dir)}/ imports ${file}`,
      })
    }

    for (const { name, kind } of exps) {
      // uses inside its own module, minus the single definition occurrence
      const self = Math.max(0, countRefs(code, name) - 1)
      let cross = 0
      for (const [other, otherCode] of stripped) { if (other !== file) cross += countRefs(otherCode, name) }
      const testRefs = countRefs(testBlob, name)
      if (self > 0 || cross > 0) continue

      const cosmetic = COSMETIC.test(name) || METRIC.test(name)
      const thin = kind === "function" && isThinAlias(bodyOf(code, name))
      findings.push({
        kind: testRefs > 0 ? FINDING.ORPHANED_CAPABILITY : FINDING.DEAD_EXPORT,
        file, name, kind_of_export: kind, loc, testRefs, cosmetic, thin,
        evidence: testRefs > 0
          ? `${file} exports ${name}; ${testRefs} test reference(s) exercise it; NO production code calls it${thin ? " — but it only delegates, so the capability behind it is not lost" : ""}`
          : `${file} exports ${name}; nothing references it anywhere, tests included${thin ? " — a delegating wrapper, not lost capability" : ""}`,
      })
    }
  }

  return {
    modules,
    findings: rankFindings(findings),
    stats: {
      modules: modules.length,
      exports: modules.reduce((a, m) => a + m.exports, 0),
      loc: modules.reduce((a, m) => a + m.loc, 0),
      islands: findings.filter((f) => f.kind === FINDING.ISLAND_MODULE).length,
      orphaned: findings.filter((f) => f.kind === FINDING.ORPHANED_CAPABILITY).length,
      dead: findings.filter((f) => f.kind === FINDING.DEAD_EXPORT).length,
    },
  }
}

/**
 * Rank by how much capability is probably sitting idle.
 *
 * Test references are the strongest signal available: somebody cared enough to
 * verify this, and then it was never wired in. Cosmetic names are pushed down
 * rather than dropped, because the judgment "this is only a formatter" belongs
 * to the reader, not to a regex.
 */
export function rankFindings(findings = []) {
  const weight = (f) => {
    // a thin alias is a true finding and a bad lead: demoted, never dropped
    if (f.kind === FINDING.ORPHANED_CAPABILITY) return 100 + Math.min(60, f.testRefs * 3) - (f.cosmetic ? 80 : 0) - (f.thin ? 70 : 0)
    if (f.kind === FINDING.ISLAND_MODULE) return 50 + Math.min(40, Math.floor(f.loc / 20))
    return 10 + Math.min(10, f.testRefs) - (f.cosmetic ? 8 : 0)
  }
  return [...findings].sort((a, b) => weight(b) - weight(a) || String(a.file).localeCompare(String(b.file)))
}

export function formatAudit(report, { limit = 20 } = {}) {
  if (!report?.findings) return "no audit results"
  const s = report.stats
  const lines = [
    `SELF-AUDIT — ${s.modules} modules, ${s.exports} exports, ${s.loc} lines`,
    `  ${s.orphaned} orphaned capabilit${s.orphaned === 1 ? "y" : "ies"} · ${s.dead} dead export(s) · ${s.islands} island module(s)`,
    "",
  ]
  if (!report.findings.length) {
    lines.push("  nothing disconnected found — every export has a consumer.")
    return lines.join("\n")
  }
  lines.push("  ORPHANED CAPABILITY means: tested, and no production code calls it.")
  lines.push("  These are leads with evidence, not verdicts — confirm by reading the code.")
  lines.push("")
  for (const f of report.findings.slice(0, limit)) {
    const where = f.name ? `${f.file}:${f.name}` : f.file
    lines.push(`  ${f.kind.padEnd(21)} ${where}${f.thin ? "  (thin alias)" : ""}${f.cosmetic ? "  (cosmetic)" : ""}`)
    lines.push(`    ${f.evidence}`)
  }
  if (report.findings.length > limit) lines.push(`  … and ${report.findings.length - limit} more`)
  return lines.join("\n")
}
