/**
 * forge — skills engine (reads SKILL.md skill packs, zero dependencies)
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))

export function resolveSkillsDir(cfgDir) {
  // v20 fix: the v19 "repo checkout" candidate joined dirname(HERE)/../../skills
  // — correct for the cli/forge layout but WRONG for the shipped forge/ layout,
  // where it escapes the repo and can pick up a foreign skills/ directory from
  // a parent folder. The bundled dir now wins before any parent-dir guess.
  const candidates = [
    cfgDir,
    path.join(process.cwd(), "skills"),
    path.join(HERE, "skills"), // bundled with the CLI package (most specific)
    path.join(path.dirname(HERE), "skills"), // shipped layout: forge/ at repo root
    path.join(path.dirname(HERE), "..", "skills"), // repo checkout: cli/forge layout
    path.join(process.env.HOME || "", ".forge", "skills"),
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "pdf", "SKILL.md")) || hasAnySkill(c)) return path.resolve(c)
    } catch {}
  }
  return null
}

function hasAnySkill(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    return entries.some((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "SKILL.md")))
  } catch {
    return false
  }
}

/** Index: [{name, desc, path}] — memoized per directory (69 SKILL.md reads happen once per process). */
const indexMemo = new Map() // dir -> { sig, result }

function dirSignature(dir) {
  try {
    const st = fs.statSync(dir)
    return `${st.mtimeMs}:${fs.readdirSync(dir).length}`
  } catch {
    return null
  }
}

export function indexSkills(dir) {
  if (!dir) return []
  const sig = dirSignature(dir)
  const hit = indexMemo.get(dir)
  if (hit && hit.sig === sig) return hit.result
  const result = computeIndex(dir)
  indexMemo.set(dir, { sig, result })
  return result
}

function computeIndex(dir) {
  const out = []
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const skillFile = path.join(dir, e.name, "SKILL.md")
    if (!fs.existsSync(skillFile)) continue
    let desc = ""
    try {
      const md = fs.readFileSync(skillFile, "utf8")
      const h1 = md.match(/^#\s+(.+)$/m)
      const first = md.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#") && !l.startsWith("---"))
      desc = (h1?.[1] || first || "").slice(0, 110)
    } catch {}
    out.push({ name: e.name, desc, path: skillFile })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/**
 * v20.2 (P2-5): validate the installed skills. For each skill directory:
 *  - the directory name must be a safe skill name
 *  - SKILL.md must be non-empty and have a description (H1 or first line)
 *  - relative links in SKILL.md (markdown links + `scripts/…`/`references/…`
 *    style paths) must resolve to a file that exists
 *  - a very large SKILL.md is flagged (it is truncated at load time)
 * Returns { skills: [{name, ok, issues, sizeKB}], ok, total, failed }.
 * Read-only; never throws.
 */
export function checkSkills(dir, { maxSkillKB = 64 } = {}) {
  const result = { skills: [], ok: true, total: 0, failed: 0 }
  if (!dir) return result
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return result }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue
    const skillFile = path.join(dir, e.name, "SKILL.md")
    if (!fs.existsSync(skillFile)) continue // not a skill dir
    result.total++
    const issues = []
    let sizeKB = 0
    if (!validSkillName(e.name)) issues.push(`invalid skill directory name "${e.name}"`)
    let md = null
    try {
      const buf = fs.readFileSync(skillFile)
      sizeKB = Math.round((buf.length / 1024) * 10) / 10
      md = buf.toString("utf8")
    } catch (err) {
      issues.push(`SKILL.md unreadable: ${err?.message ?? err}`)
    }
    if (md !== null) {
      if (!md.trim()) {
        issues.push("SKILL.md is empty")
      } else {
        const h1 = md.match(/^#\s+(.+)$/m)
        const firstLine = md.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#") && !l.startsWith("---"))
        if (!h1 && !firstLine) issues.push("no description (no H1 heading or intro line)")
        if (sizeKB > maxSkillKB) issues.push(`SKILL.md is ${sizeKB} KB (> ${maxSkillKB} KB; loads are truncated at 24 KB)`)
        for (const link of brokenSkillLinks(md, path.join(dir, e.name))) issues.push(`broken link: ${link}`)
      }
    }
    if (issues.length) { result.ok = false; result.failed++ }
    result.skills.push({ name: e.name, ok: issues.length === 0, issues, sizeKB })
  }
  return result
}

/**
 * Relative links in a SKILL.md that do not resolve to an existing file.
 * Only markdown links/images are checked, and obvious documentation
 * placeholders (URL, path/to/…, ellipses, angle brackets) are ignored, so the
 * report is genuine broken references rather than prose examples.
 */
function brokenSkillLinks(md, skillDir) {
  const broken = []
  const seen = new Set()
  const isPlaceholder = (t) =>
    t.includes("...") || t.includes("…") || /[<> ]/.test(t) ||
    /path\/to/i.test(t) || /example\.(com|org)/i.test(t) ||
    /^[A-Z]{2,}$/.test(t) || t.includes("YOUR_") || t.includes("{{")
  const consider = (target) => {
    if (!target) return
    const t = target.trim().split("#")[0].split("?")[0].trim()
    if (!t) return
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || t.startsWith("mailto:") || t.startsWith("#") || t.startsWith("/") || t.startsWith("~")) return
    if (isPlaceholder(t)) return
    if (!/\.[A-Za-z0-9]{1,8}$/.test(t) && !t.endsWith("/")) return // must look like a file or dir path
    if (seen.has(t)) return
    seen.add(t)
    const abs = path.resolve(skillDir, t)
    if (path.relative(skillDir, abs).startsWith("..")) return // escapes the skill dir — not our concern
    try { if (!fs.existsSync(abs)) broken.push(t) } catch {}
  }
  const reMd = /!?\[[^\]]*\]\(([^)]+)\)/g // [text](target) and ![alt](target)
  let m
  while ((m = reMd.exec(md))) consider(m[1])
  return broken
}

/** v20: skill names must be plain directory names — blocks `../` traversal
 *  and absolute-path injection before any filesystem access. */
export function validSkillName(name) {
  const n = String(name ?? "").trim()
  if (!n || n.length > 64) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n)) return null
  if (n.includes("..")) return null
  return n
}

function realPathOf(p) {
  try { return fs.realpathSync(p) } catch { return path.resolve(p) }
}

export function loadSkill(dir, name, maxLen = 24000) {
  const n = validSkillName(name)
  if (!n) return null
  const skillFile = path.join(dir, n, "SKILL.md")
  // traversal guard: the resolved real path must stay inside the skills dir
  const base = realPathOf(dir)
  const real = realPathOf(skillFile)
  const rel = path.relative(base, real)
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null
  if (!fs.existsSync(skillFile)) return null
  const md = fs.readFileSync(skillFile, "utf8")
  return md.length > maxLen ? md.slice(0, maxLen) + "\n... (truncated)" : md
}
