/**
 * forge — architecture decision log (v74, zero dependencies)
 *
 * FORGE_HOME/projects/<hash>/decisions.json next to knowgap.json / claims.json.
 * Not a second memory. Compose never writes. Status is recorded, never ACTIVE.
 */
import fs from "node:fs"
import path from "node:path"
import { writeStateFile } from "./securefs.js"
import { projectDir } from "./memory.js"
import { scoreAgainst, namedIn } from "./evaluate.js"
import { TASK_CLASS } from "./classify.js"

export const DECISIONS_FILE = "decisions.json"
export const MAX_DECISIONS = 32
export const MAX_DECISION_TEXT = 800
export const DECISION_STATUS = Object.freeze({
  ACCEPTED: "accepted",
  SUPERSEDED: "superseded",
  REJECTED: "rejected",
})

const TITLE_RE = /^[a-z][a-z0-9-]{1,47}$/

export function decisionsPath(cwd) {
  return path.join(projectDir(cwd || process.cwd()), DECISIONS_FILE)
}

export function validDecisionTitle(raw) {
  const s = String(raw || "").trim().toLowerCase().replace(/\s+/g, "-")
  return TITLE_RE.test(s) ? s : ""
}

function loadDecisions(cwd) {
  try {
    const j = JSON.parse(fs.readFileSync(decisionsPath(cwd), "utf8"))
    if (!j || typeof j !== "object" || Array.isArray(j)) return { v: 1, items: {} }
    return { v: 1, items: j.items && typeof j.items === "object" ? j.items : {} }
  } catch {
    return { v: 1, items: {} }
  }
}

function saveDecisions(cwd, all) {
  const dir = projectDir(cwd || process.cwd())
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeStateFile(decisionsPath(cwd), JSON.stringify({ v: 1, updated: Date.now(), items: all.items || {} }, null, 1), { mode: 0o600 })
}

export function recordDecision({ cwd, title, reason, status = DECISION_STATUS.ACCEPTED } = {}) {
  const id = validDecisionTitle(title)
  if (!id) return { ok: false, error: "invalid title" }
  const body = String(reason || "").trim().slice(0, MAX_DECISION_TEXT)
  if (!body) return { ok: false, error: "empty reason" }
  const st = DECISION_STATUS[String(status || "").toUpperCase()] || String(status || DECISION_STATUS.ACCEPTED).toLowerCase()
  if (!Object.values(DECISION_STATUS).includes(st)) return { ok: false, error: "invalid status" }
  const all = loadDecisions(cwd)
  const items = all.items || (all.items = {})
  items[id] = { title: id, reason: body, status: st, at: Date.now() }
  const keys = Object.keys(items)
  if (keys.length > MAX_DECISIONS) {
    const oldest = keys.sort((a, b) => (items[a].at || 0) - (items[b].at || 0))
    for (const k of oldest.slice(0, keys.length - MAX_DECISIONS)) delete items[k]
  }
  all.items = items
  saveDecisions(cwd, all)
  return { ok: true, title: id, decision: items[id] }
}

export function getDecision(cwd, title) {
  const id = validDecisionTitle(title)
  if (!id) return null
  return loadDecisions(cwd).items?.[id] || null
}

export function listDecisions(cwd) {
  return Object.values(loadDecisions(cwd).items || {}).sort((a, b) => (b.at || 0) - (a.at || 0))
}

export function pickDecisions(task, rows, { klass, limit = 3 } = {}) {
  const list = Array.isArray(rows) ? rows : []
  const q = String(task || "")
  const scored = []
  for (const d of list) {
    if (d?.status === DECISION_STATUS.REJECTED) continue
    const n = String(d?.title || "")
    if (!n) continue
    const s = scoreAgainst(q, n, String(d?.reason || ""))
    if (s <= 0) continue
    scored.push({ title: n, reason: String(d.reason || "").slice(0, MAX_DECISION_TEXT), status: d.status, score: s })
  }
  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
  const cap = Math.max(1, Math.min(3, Number(limit) || 3))
  if (klass === TASK_CLASS.MICRO || klass === TASK_CLASS.SMALL) {
    return scored.filter((d) => namedIn(q, d.title)).slice(0, 1)
  }
  return scored.slice(0, cap)
}

export function formatDecisions(rows) {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return "no decisions recorded for this project\n"
  const lines = [`decisions (${list.length})`, ""]
  for (const d of list.slice(0, 16)) {
    lines.push(`${d.title}  ${d.status || ""}  ${String(d.reason || "").split("\n")[0].slice(0, 80)}`)
  }
  return lines.join("\n") + "\n"
}

export function formatDecisionLines(rows) {
  const out = []
  for (const d of (rows || []).slice(0, 3)) {
    const hint = String(d.reason || "").split("\n")[0].slice(0, 160)
    if (!d.title || !hint) continue
    out.push(`[decisions] ${d.title} (${d.status || "accepted"}): ${hint}`)
  }
  return out
}

/** TUI / CLI knowledge pane. Read-only. Never fakes progress. */
export function formatKnowledgePane({ claims = [], decisions = [], gaps = null, downloads = [] } = {}) {
  const lines = ["KNOWLEDGE", ""]
  const claimN = Array.isArray(claims) ? claims.length : 0
  lines.push(`claims     ${claimN}`)
  for (const c of (claims || []).slice(0, 4)) {
    lines.push(`  ${c.subject}: ${String(c.text || "").split("\n")[0].slice(0, 72)}`)
  }
  const decN = Array.isArray(decisions) ? decisions.length : 0
  lines.push(`decisions  ${decN}`)
  for (const d of (decisions || []).slice(0, 4)) {
    lines.push(`  ${d.title} (${d.status || ""}): ${String(d.reason || "").split("\n")[0].slice(0, 64)}`)
  }
  const gapRows = Array.isArray(gaps?.gaps) ? gaps.gaps : Array.isArray(gaps) ? gaps : []
  lines.push(`gaps       ${gapRows.length}`)
  for (const g of gapRows.slice(0, 4)) {
    const id = g.id || g
    lines.push(`  ${id}  ${g.impact || ""}  ${g.status || ""}`)
  }
  const dl = Array.isArray(downloads) ? downloads : []
  lines.push(`downloads  ${dl.length}`)
  for (const r of dl.slice(0, 6)) {
    lines.push(`  ${(r.skillName || r.id || "?").slice(0, 28)}  ${r.lifecycle || "CANDIDATE"}`)
  }
  if (claimN + decN + gapRows.length + dl.length === 0) lines.push("  (empty — learn a skill, record a decision, or run a task)")
  return lines.join("\n") + "\n"
}
