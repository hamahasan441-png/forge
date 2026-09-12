/**
 * forge — documentation & git intelligence (v91 ULTIMATE, zero dependencies)
 *
 * What a change IMPLIES for the docs and the commit message, decided from the
 * diff itself. Deterministic, offline, no model call: a removed export is a
 * removed export whether or not a model feels like mentioning it.
 *
 * Deliberately pure: every function takes text/arrays and returns data. The git
 * plumbing already exists — v90 added git_diff / git_log / git_blame as tools —
 * so this module never shells out to git and never duplicates it. Callers pass
 * the diff text those tools produced (or `git diff` output from bash).
 */

const EXPORT_ADDED_RE = /^\+\s*export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/
const EXPORT_REMOVED_RE = /^-\s*export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/
const EXPORT_DEFAULT_RE = /^[+-]\s*export\s+default\b/
const NAMED_EXPORT_RE = /^[+-]\s*export\s*\{([^}]+)\}/
const PY_DEF_RE = /^([+-])def\s+([A-Za-z_]\w*)\s*\(/
const RUST_PUB_RE = /^([+-])\s*pub\s+(?:async\s+)?fn\s+([A-Za-z_]\w*)/
const CLI_CASE_RE = /^([+-])\s*case\s+"([a-z][a-z0-9:_-]*)"\s*:/
const ENV_RE = /^([+-])[^]*?process\.env\.([A-Z][A-Z0-9_]{2,})/
const CONFIG_KEY_RE = /^([+-])\s*([a-z][A-Za-z0-9]*)\s*:\s*[^,\n]*,?\s*(?:\/\/.*)?$/
const SIG_RE = /^([+-])\s*export\s+(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/
const REQUIRED_ARRAY_RE = /^([+-])\s*required\s*:\s*\[([^\]]*)\]/
const VERSION_RE = /^([+-])\s*"version"\s*:\s*"([^"]+)"/

const DOC_FILES = {
  readme: ["README.md", "README", "readme.md"],
  changelog: ["CHANGELOG.md", "CHANGELOG", "HISTORY.md"],
  api: ["docs/API.md", "API.md", "docs/api.md"],
  migration: ["MIGRATION.md", "docs/MIGRATION.md", "MIGRATIONS.md"],
}

/**
 * Parse a unified diff into per-file facts.
 * @param {string} text unified diff (`git diff` output, or the git_diff tool)
 * @returns {{files: Array, insertions: number, deletions: number, truncated: boolean}}
 */
export function parseUnifiedDiff(text = "") {
  const lines = String(text ?? "").split("\n")
  const files = []
  let cur = null
  let truncated = false
  const newFile = (p) => {
    cur = {
      path: p, added: 0, removed: 0, hunks: 0, newFile: false, deletedFile: false,
      addedExports: [], removedExports: [], addedCases: [], removedCases: [],
      addedEnv: [], removedEnv: [], sigs: { added: {}, removed: {} },
      required: { added: null, removed: null }, version: { added: null, removed: null },
    }
    files.push(cur)
    return cur
  }
  for (const line of lines) {
    if (/^… \d+ more lines/.test(line) || /^\.\.\. \d+ more lines/.test(line)) { truncated = true; continue }
    let m
    if ((m = line.match(/^\+\+\+ (?:b\/)?(.+)$/))) { newFile(m[1].trim()); continue }
    if ((m = line.match(/^--- (?:a\/)?(.+)$/))) { if (!cur || cur.path !== m[1].trim()) { /* keep +++ as the path */ } continue }
    if (/^diff --git /.test(line)) continue
    if (/^new file mode/.test(line) && cur) { cur.newFile = true; continue }
    if (/^deleted file mode/.test(line) && cur) { cur.deletedFile = true; continue }
    if (/^@@/.test(line)) { if (cur) cur.hunks++; continue }
    if (!cur) continue
    if (line.startsWith("+") && !line.startsWith("+++")) {
      cur.added++
      record(cur, line, "+")
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      cur.removed++
      record(cur, line, "-")
    }
  }
  const insertions = files.reduce((n, f) => n + f.added, 0)
  const deletions = files.reduce((n, f) => n + f.removed, 0)
  return { files, insertions, deletions, truncated }
}

/**
 * Record every fact a line carries. Note the missing `return`s: one line can be
 * BOTH "an export changed" and "a signature changed" (`+export function f(a,
 * b, c) {`), and an early return would silently lose the second fact — which is
 * exactly how a tightened signature stopped being detected.
 */
function record(cur, line, sign) {
  let m
  if ((m = line.match(EXPORT_ADDED_RE))) { (sign === "+" ? cur.addedExports : cur.removedExports).push(m[1]) }
  else if ((m = line.match(EXPORT_REMOVED_RE))) { (sign === "-" ? cur.removedExports : cur.addedExports).push(m[1]) }
  else if (EXPORT_DEFAULT_RE.test(line)) { (sign === "+" ? cur.addedExports : cur.removedExports).push("default") }
  else if ((m = line.match(NAMED_EXPORT_RE))) {
    const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop().trim()).filter((s) => s && s !== "default")
    for (const n of names) (sign === "+" ? cur.addedExports : cur.removedExports).push(n)
  } else if ((m = line.match(PY_DEF_RE))) { if (!m[2].startsWith("_")) (m[1] === "+" ? cur.addedExports : cur.removedExports).push(m[2]) }
  else if ((m = line.match(RUST_PUB_RE))) { (m[1] === "+" ? cur.addedExports : cur.removedExports).push(m[2]) }
  // Independent facts — a line may carry several of these at once.
  if ((m = line.match(CLI_CASE_RE))) (m[1] === "+" ? cur.addedCases : cur.removedCases).push(m[2])
  if ((m = line.match(ENV_RE))) (m[1] === "+" ? cur.addedEnv : cur.removedEnv).push(m[2])
  if ((m = line.match(SIG_RE))) cur.sigs[m[1] === "+" ? "added" : "removed"][m[2]] = m[3]
  if ((m = line.match(REQUIRED_ARRAY_RE))) cur.required[m[1] === "+" ? "added" : "removed"] = m[2]
  if ((m = line.match(VERSION_RE))) cur.version[m[1] === "+" ? "added" : "removed"] = m[2]
}

/** Required (non-defaulted, non-optional, non-rest) parameter names of a signature. */
export function requiredParams(sig = "") {
  return String(sig ?? "").split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !p.includes("=") && !p.startsWith("...") && !p.includes("?") && !/=\s*\{?\s*\}?$/.test(p))
    .map((p) => p.replace(/[{}[\]]/g, "").trim().split(/[:\s]/)[0])
    .filter(Boolean)
}

/**
 * Breaking changes implied by a diff.
 *
 * A change is breaking when code that used to work against this project stops
 * compiling/running: a removed export, a removed CLI subcommand, a removed env
 * var, a new required parameter, a tightened tool-schema `required` list, or a
 * major version bump. Everything else is additive.
 *
 * @returns {Array<{kind: string, file: string, symbol?: string, severity: string, why: string}>}
 */
export function detectBreakingChanges(diff = "", { diffParsed = null } = {}) {
  const parsed = diffParsed || parseUnifiedDiff(diff)
  const out = []
  for (const f of parsed.files) {
    // 1. removed exports (a rename shows up as removed + added: still breaking)
    const added = new Set(f.addedExports)
    for (const sym of f.removedExports) {
      // Same name on both sides ⇒ the line was edited, not removed. Calling
      // that a removal (or a rename onto itself) would be a lie.
      if (added.has(sym)) continue
      const renamedTo = added.size ? [...added].find((a) => a !== sym && (a.toLowerCase().includes(sym.toLowerCase()) || sym.toLowerCase().includes(a.toLowerCase()))) : null
      out.push({
        kind: renamedTo ? "EXPORT_RENAMED" : "EXPORT_REMOVED",
        file: f.path, symbol: sym, severity: "MAJOR",
        why: renamedTo ? `exported "${sym}" is gone; "${renamedTo}" appeared — importers must be updated` : `exported "${sym}" was removed — every importer breaks`,
      })
    }
    // 2. removed CLI subcommands
    for (const c of f.removedCases) {
      if (f.addedCases.includes(c)) continue
      out.push({ kind: "COMMAND_REMOVED", file: f.path, symbol: c, severity: "MAJOR", why: `subcommand "${c}" no longer exists — scripts and docs that call it break` })
    }
    // 3. removed environment variables
    for (const e of f.removedEnv) {
      if (f.addedEnv.includes(e)) continue
      out.push({ kind: "ENV_REMOVED", file: f.path, symbol: e, severity: "MAJOR", why: `environment variable ${e} is no longer read — deployments that set it silently change behavior` })
    }
    // 4. signatures that gained a required parameter
    for (const [sym, newSig] of Object.entries(f.sigs.added)) {
      const oldSig = f.sigs.removed[sym]
      if (oldSig == null) continue
      const before = requiredParams(oldSig)
      const after = requiredParams(newSig)
      const gained = after.filter((p) => !before.includes(p))
      if (gained.length) out.push({ kind: "SIGNATURE_TIGHTENED", file: f.path, symbol: sym, severity: "MINOR", why: `${sym}() now requires ${gained.join(", ")} — existing callers pass too few arguments` })
    }
    // 5. a tool/JSON schema that requires more fields
    if (f.required.added && f.required.removed) {
      const before = f.required.removed.split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean)
      const after = f.required.added.split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean)
      const gained = after.filter((x) => !before.includes(x))
      if (gained.length) out.push({ kind: "SCHEMA_TIGHTENED", file: f.path, symbol: gained.join(","), severity: "MINOR", why: `required fields added: ${gained.join(", ")} — previously valid input is now rejected` })
    }
    // 6. a major version bump is a declared break
    if (f.version.added && f.version.removed) {
      const a = f.version.added.split(".")[0]
      const b = f.version.removed.split(".")[0]
      if (a !== b) out.push({ kind: "MAJOR_BUMP", file: f.path, symbol: `${f.version.removed} → ${f.version.added}`, severity: "MAJOR", why: `major version bump ${f.version.removed} → ${f.version.added} declares breaking changes` })
    }
  }
  return out
}

/** Per-file exported-symbol delta, for API docs. */
export function apiDocDelta(diff = "", { diffParsed = null } = {}) {
  const parsed = diffParsed || parseUnifiedDiff(diff)
  return parsed.files
    .filter((f) => f.addedExports.length || f.removedExports.length)
    .map((f) => ({
      file: f.path,
      added: [...new Set(f.addedExports)],
      removed: [...new Set(f.removedExports.filter((s) => !f.addedExports.includes(s)))],
    }))
}

/**
 * Which documents this change obliges you to update, and why.
 * Never invents a doc: it reports what exists in the repo (repoFiles) and what
 * is missing. A missing CHANGELOG with breaking changes is a finding, not a lie.
 *
 * @param {{diff?: string, diffParsed?: object, breaking?: Array, repoFiles?: string[], version?: string, files?: string[]}} input
 * @returns {Array<{doc: string, path: string|null, action: string, why: string, severity: string}>}
 */
export function docPlan({ diff = "", diffParsed = null, breaking = null, repoFiles = [], version = "", files = [] } = {}) {
  const parsed = diffParsed || parseUnifiedDiff(diff)
  const brk = breaking ?? detectBreakingChanges("", { diffParsed: parsed })
  const present = new Set((repoFiles || []).map((f) => String(f).replace(/^\.\//, "")))
  const find = (cands) => cands.find((c) => present.has(c)) || null
  const changed = new Set((files?.length ? files : parsed.files.map((f) => f.path)).map((f) => String(f).replace(/^\.\//, "")))
  const out = []

  const touch = (doc, action, why, severity = "INFO") => {
    const p = find(DOC_FILES[doc] || [])
    out.push({ doc, path: p, action, why, severity, exists: Boolean(p) })
  }

  // `files` is the caller's change set (task state). The diff is not always
  // available — an autonomous run knows WHICH files changed without carrying the
  // hunks — and a plan built only from the diff then claims nothing changed and
  // the documentation writer is told there is nothing to do. Honour both.
  const listedFiles = (files?.length ? files : parsed.files.map((f) => f.path)).map((f) => String(f))
  const codeChanged = parsed.files.some((f) => !/\.(md|txt|json)$/i.test(f.path))
    || listedFiles.some((f) => !/\.(md|txt|json)$/i.test(f))
  const publicApi = apiDocDelta("", { diffParsed: parsed })

  if (brk.length) touch("changelog", "add a BREAKING entry", `${brk.length} breaking change(s): ${brk.slice(0, 3).map((b) => b.kind).join(", ")}${brk.length > 3 ? ", …" : ""}`, "MAJOR")
  else if (codeChanged) touch("changelog", "add an entry", `${parsed.insertions} insertion(s), ${parsed.deletions} deletion(s) across ${parsed.files.length} file(s)`, "INFO")

  if (publicApi.length) {
    touch("api", "update the API reference", `${publicApi.length} module(s) changed their exports: ${publicApi.slice(0, 3).map((a) => `${a.file} (+${a.added.length}/-${a.removed.length})`).join(", ")}`, brk.some((b) => b.kind.startsWith("EXPORT")) ? "MAJOR" : "INFO")
    touch("readme", "check the command/usage table", "public surface changed — the quick-start may name something that moved", "INFO")
  }

  const removedCmds = brk.filter((b) => b.kind === "COMMAND_REMOVED")
  if (removedCmds.length) touch("readme", "remove the documented command(s)", removedCmds.map((b) => b.symbol).join(", "), "MAJOR")

  const envBrk = brk.filter((b) => b.kind === "ENV_REMOVED")
  if (envBrk.length) touch("readme", "update the environment variable list", envBrk.map((b) => b.symbol).join(", "), "MAJOR")

  if (brk.some((b) => b.severity === "MAJOR")) {
    touch("migration", version ? `write the ${version} migration note` : "write a migration note", "users on the previous version need the before/after for each break", "MAJOR")
  }

  const configChanged = [...changed].some((f) => /(^|\/)(config|settings)\.[jt]s$/i.test(f) || /forge\.config\.json$/.test(f))
  if (configChanged) touch("readme", "document the config change", "a config file changed — the precedence table and defaults may be stale", "INFO")

  const missing = out.filter((o) => !o.exists)
  for (const m of missing) m.why += ` (note: no ${m.doc} file found in the repo — create one or record the change in the README)`
  return out
}

/** A CHANGELOG section in the format this repository already uses. */
export function changelogSection({ version = "", title = "", added = [], changed = [], fixed = [], removed = [], breaking = [] } = {}) {
  const rows = [`## v${version || "0.0.0"}${title ? ` — "${title}"` : ""}`, ""]
  const section = (heading, items) => {
    if (!items?.length) return
    rows.push(`### ${heading}`)
    for (const it of items) rows.push(`- ${String(it).replace(/\s+/g, " ").trim()}`)
    rows.push("")
  }
  if (breaking.length) {
    rows.push("### BREAKING")
    for (const b of breaking) rows.push(`- **${b.kind}${b.symbol ? ` \`${b.symbol}\`` : ""}**${b.file ? ` (${b.file})` : ""} — ${b.why}`)
    rows.push("")
  }
  section("Added", added)
  section("Changed", changed)
  section("Fixed", fixed)
  section("Removed", removed)
  return rows.join("\n").trimEnd() + "\n"
}

/** Migration notes: before/after for every break, so nobody has to read the diff. */
export function migrationNotes(breaking = [], { fromVersion = "", toVersion = "" } = {}) {
  if (!breaking?.length) return ""
  const rows = [
    `# Migration${fromVersion && toVersion ? ` ${fromVersion} → ${toVersion}` : ""}`,
    "",
    "Every break in this release, with what to do about it.",
    "",
  ]
  for (const b of breaking) {
    rows.push(`## ${b.kind}${b.symbol ? ` — \`${b.symbol}\`` : ""}`)
    rows.push("")
    rows.push(`- **Where:** \`${b.file}\``)
    rows.push(`- **Severity:** ${b.severity}`)
    rows.push(`- **What broke:** ${b.why}`)
    rows.push(`- **Action:** ${migrationAction(b)}`)
    rows.push("")
  }
  return rows.join("\n")
}

function migrationAction(b) {
  switch (b.kind) {
    case "EXPORT_REMOVED": return `delete the import of \`${b.symbol}\` and use the surviving API; if nothing replaces it, pin the previous version.`
    case "EXPORT_RENAMED": return `rename the import to \`${b.symbol}\`'s replacement (see the diff for the new name).`
    case "COMMAND_REMOVED": return `stop calling \`${b.symbol}\`; the equivalent is in the current \`--help\`.`
    case "ENV_REMOVED": return `remove \`${b.symbol}\` from your environment/deployment config.`
    case "SIGNATURE_TIGHTENED": return `pass the new required argument(s) to \`${b.symbol}()\`.`
    case "SCHEMA_TIGHTENED": return `add the newly required field(s): ${b.symbol}.`
    case "MAJOR_BUMP": return "read the BREAKING section of the CHANGELOG before upgrading."
    default: return "review the diff for this symbol."
  }
}

/**
 * A commit message: imperative subject, evidence body, BREAKING footer.
 * The body cites real numbers from the diff — never invented prose.
 * @returns {{subject: string, body: string, footer: string, text: string, breaking: boolean}}
 */
export function commitMessage({ objective = "", diff = "", diffParsed = null, breaking = null, scope = "", files = [], type = "" } = {}) {
  const parsed = diffParsed || parseUnifiedDiff(diff)
  const brk = breaking ?? detectBreakingChanges("", { diffParsed: parsed })
  const list = (files?.length ? files : parsed.files.map((f) => f.path)).slice(0, 12)
  const kind = type || (brk.length ? "feat" : parsed.files.every((f) => /\.md$/i.test(f.path)) ? "docs" : parsed.files.every((f) => /test/i.test(f.path)) ? "test" : "feat")
  const cleanObjective = String(objective || "update").replace(/\s+/g, " ").trim().replace(/^[\s#>*-]+/, "")
  const subject = `${kind}${scope ? `(${scope})` : ""}${brk.length ? "!" : ""}: ${cleanObjective.slice(0, 72)}`
  const body = [
    parsed.files.length ? `${parsed.files.length} file(s), +${parsed.insertions}/-${parsed.deletions}` : "no file changes recorded",
    ...(list.length ? ["", "Files:", ...list.map((f) => `- ${f}`)] : []),
    ...(parsed.truncated ? ["", "(diff was truncated — counts are a lower bound)"] : []),
  ].join("\n")
  const footer = brk.length
    ? ["", "BREAKING CHANGE:", ...brk.map((b) => `- ${b.kind}${b.symbol ? ` ${b.symbol}` : ""}: ${b.why}`)].join("\n")
    : ""
  return { subject, body, footer, text: [subject, "", body, footer].filter(Boolean).join("\n").trimEnd() + "\n", breaking: brk.length > 0 }
}

/** Human-readable doc plan (for `forge docs --plan` and the final report). */
export function formatDocPlan(plan = [], { commit = null } = {}) {
  const rows = []
  if (!plan.length) rows.push("  (no documentation updates implied by this change)")
  for (const p of plan) {
    rows.push(`  ${p.severity === "MAJOR" ? "!" : "·"} ${String(p.doc).toUpperCase().padEnd(10)} ${p.action}`)
    rows.push(`      ${p.why}`)
    if (!p.exists) rows.push(`      (missing: create ${DOC_FILES[p.doc]?.[0] || p.doc})`)
  }
  if (commit) {
    rows.push("", "  commit message:")
    for (const l of commit.text.trimEnd().split("\n")) rows.push(`    ${l}`)
  }
  return rows.join("\n")
}

/**
 * v93 DOCSMITH — the brief the Documentation Writer works from.
 *
 * Deterministic on purpose: everything in it is derived from the diff and the
 * repo's real files, so the model cannot be told to document something that did
 * not change, and an empty brief means "there is nothing to write" rather than
 * "write something plausible".
 *
 * @returns {{text:string,targets:Array,empty:boolean}}
 */
export function docsBrief({
  objective = "", diff = "", diffParsed = null, breaking = null,
  plan = null, repoFiles = [], files = [], version = "", maxChars = 4000,
} = {}) {
  const parsed = diffParsed || parseUnifiedDiff(diff)
  const brk = breaking ?? detectBreakingChanges("", { diffParsed: parsed })
  const items = plan ?? docPlan({ diffParsed: parsed, breaking: brk, repoFiles, files })
  if (!items.length) return { text: "", targets: [], empty: true }

  const targets = items.map((i) => ({ doc: i.doc, path: i.path, action: i.action, why: i.why, severity: i.severity, exists: i.exists }))
  const lines = []
  lines.push(`Task: ${objective || "document the change below"}.`)
  lines.push("")
  lines.push("You are the Documentation Writer. Update ONLY the files listed here. Every one of")
  lines.push("them is obliged by the diff — do not touch anything else, do not reformat")
  lines.push("unrelated sections, and do not document a feature that is not in the diff.")
  lines.push("")
  lines.push("Required updates:")
  for (const t of targets) {
    lines.push(`  - ${t.doc}${t.path ? ` (${t.path})` : ` (missing — create ${(DOC_FILES[t.doc] || [t.doc])[0]})`}: ${t.action} — ${t.why} [${t.severity}]`)
  }
  if (!brk.length && !parsed.files.length) {
    lines.push("")
    lines.push("No diff was supplied with this brief, so breaking changes and export deltas are")
    lines.push("NOT listed here. Run git_diff yourself before writing: any removed or renamed")
    lines.push("export, command or env var is a BREAKING change and must be recorded.")
  }
  if (brk.length) {
    lines.push("")
    lines.push(`BREAKING changes that MUST be recorded (${brk.length}):`)
    for (const b of brk.slice(0, 12)) lines.push(`  - ${b.kind}${b.symbol ? ` ${b.symbol}` : ""} (${b.file}) — ${b.why}`)
  }
  const api = apiDocDelta("", { diffParsed: parsed })
  if (api.length) {
    lines.push("")
    lines.push("Public API that changed (the reference must match these signatures):")
    for (const a of api.slice(0, 8)) {
      if (a.added.length) lines.push(`  - ${a.file}: added ${a.added.slice(0, 6).join(", ")}`)
      if (a.removed.length) lines.push(`  - ${a.file}: removed ${a.removed.slice(0, 6).join(", ")}`)
    }
  }
  const cl = changelogSection({ version, title: "", changed: parsed.files.slice(0, 6).map((f) => `\`${f.path}\` (+${f.added}/-${f.removed})`), breaking: brk })
  if (cl.trim()) {
    lines.push("")
    lines.push("CHANGELOG section, ready to paste (keep this wording, extend it if you must):")
    lines.push(cl.trimEnd().split("\n").map((l) => `  ${l}`).join("\n"))
  }
  lines.push("")
  lines.push("If a listed file does not exist, create it with the minimum content the change")
  lines.push("requires — never a stub that says TODO. If nothing in a listed file actually")
  lines.push("needs to change, say so plainly instead of editing it for the sake of it.")

  let text = lines.join("\n")
  if (text.length > maxChars) text = text.slice(0, maxChars - 1) + "…"
  return { text, targets, empty: false }
}

export { DOC_FILES }
