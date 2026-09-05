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
