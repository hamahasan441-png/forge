/**
 * forge — per-claim subject store (v72, zero dependencies)
 *
 * One JSON file next to knowgap.json:
 *   FORGE_HOME/projects/<hash>/claims.json
 * Not a second memory, graph, or skill system. Compose never writes.
 * LEARN of a VERIFIED skill upserts a claim keyed by subject (skill id).
 */
import fs from "node:fs"
import path from "node:path"
import { writeStateFile } from "./securefs.js"
import { projectDir } from "./memory.js"

export const CLAIMS_FILE = "claims.json"
export const MAX_CLAIMS = 48
export const MAX_CLAIM_TEXT = 2000

const SUBJECT_RE = /^[a-z][a-z0-9-]{1,39}$/

export function claimsPath(cwd) {
  return path.join(projectDir(cwd || process.cwd()), CLAIMS_FILE)
}

export function validSubject(raw) {
  const s = String(raw || "").trim().toLowerCase()
  return SUBJECT_RE.test(s) ? s : ""
}

function loadClaims(cwd) {
  try {
    const j = JSON.parse(fs.readFileSync(claimsPath(cwd), "utf8"))
    if (!j || typeof j !== "object" || Array.isArray(j)) return { v: 1, items: {} }
    return { v: 1, items: j.items && typeof j.items === "object" ? j.items : {} }
  } catch {
    return { v: 1, items: {} }
  }
}

function saveClaims(cwd, all) {
  const dir = projectDir(cwd || process.cwd())
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeStateFile(claimsPath(cwd), JSON.stringify({ v: 1, updated: Date.now(), items: all.items || {} }, null, 1), { mode: 0o600 })
}

/**
 * Upsert one claim. Never ACTIVE. Never writes memory.md.
 */
export function recordClaim({ cwd, subject, text, source = "skill", skill = "" } = {}) {
  const id = validSubject(subject)
  if (!id) return { ok: false, error: "invalid subject" }
  const body = String(text || "").trim().slice(0, MAX_CLAIM_TEXT)
  if (!body) return { ok: false, error: "empty claim" }
  const src = String(source || "skill").slice(0, 16)
  const all = loadClaims(cwd)
  const items = all.items || (all.items = {})
  items[id] = {
    subject: id,
    text: body,
    source: src,
    skill: String(skill || id).slice(0, 40),
    at: Date.now(),
  }
  const keys = Object.keys(items)
  if (keys.length > MAX_CLAIMS) {
    const oldest = keys.sort((a, b) => (items[a].at || 0) - (items[b].at || 0))
    for (const k of oldest.slice(0, keys.length - MAX_CLAIMS)) delete items[k]
  }
  all.items = items
  saveClaims(cwd, all)
  return { ok: true, subject: id, claim: items[id] }
}

export function getClaim(cwd, subject) {
  const id = validSubject(subject)
  if (!id) return null
  return loadClaims(cwd).items?.[id] || null
}

export function listClaims(cwd) {
  const items = Object.values(loadClaims(cwd).items || {})
  return items.sort((a, b) => (b.at || 0) - (a.at || 0))
}

export function formatClaims(rows, { subject = "" } = {}) {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return subject ? `no claim for ${subject}\n` : "no claims stored for this project\n"
  const lines = [`claims (${list.length})`, ""]
  for (const c of list.slice(0, 24)) {
    lines.push(`${c.subject}  ${c.source || ""}  ${(c.text || "").split("\n")[0].slice(0, 80)}`)
  }
  return lines.join("\n") + "\n"
}
