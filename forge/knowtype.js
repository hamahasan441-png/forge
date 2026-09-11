/**
 * forge — typed knowledge (v83, zero dependencies)
 *
 * FACT | EXPERIENCE | LESSON | HYPOTHESIS.
 * A hypothesis is never a fact. FACT without evidence is stored as HYPOTHESIS.
 * Not a second memory: FORGE_HOME/projects/<hash>/knowtype.json next to claims.
 * Compose never writes. Never auto-ACTIVE.
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { writeStateFile } from "./securefs.js"
import { projectDir } from "./memory.js"
import { TASK_CLASS } from "./classify.js"
import { namedIn, scoreAgainst } from "./evaluate.js"

export const KNOWTYPE_FILE = "knowtype.json"
export const MAX_KNOW = 64
export const MAX_TEXT = 500

export const KTYPE = Object.freeze({
  FACT: "FACT",
  EXPERIENCE: "EXPERIENCE",
  LESSON: "LESSON",
  HYPOTHESIS: "HYPOTHESIS",
})

const RANK = { FACT: 4, EXPERIENCE: 3, LESSON: 2, HYPOTHESIS: 1 }

export function knowtypePath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), KNOWTYPE_FILE)
}

export function loadKnowtype(cwd = process.cwd()) {
  try {
    const j = JSON.parse(fs.readFileSync(knowtypePath(cwd), "utf8"))
    if (!j || typeof j !== "object") return { v: 1, items: {} }
    if (!j.items || typeof j.items !== "object") j.items = {}
    return j
  } catch {
    return { v: 1, items: {} }
  }
}

function saveKnowtype(cwd, data) {
  writeStateFile(knowtypePath(cwd), JSON.stringify(data, null, 1), { mode: 0o600 })
}

export function normalizeType(raw) {
  const t = String(raw || "").trim().toUpperCase()
  return KTYPE[t] || null
}

function slugId(type, text) {
  const h = crypto.createHash("sha256").update(`${type}:${text}`).digest("hex").slice(0, 10)
  return `${String(type).toLowerCase()}-${h}`
}

/**
 * Record one typed item. Missing FACT evidence → HYPOTHESIS (never silent FACT).
 */
export function recordKnowledge({
  cwd = process.cwd(), type = "", text = "", source = "cli", evidence = "",
} = {}) {
  let k = normalizeType(type)
  if (!k) return { ok: false, error: "type must be FACT|EXPERIENCE|LESSON|HYPOTHESIS" }
  const body = String(text || "").trim().slice(0, MAX_TEXT)
  if (!body) return { ok: false, error: "empty text" }
  if (/assumeYes|plugin-host|classifyTaskComplexity/.test(body)) {
    return { ok: false, error: "kernel path — refused" }
  }
  const ev = String(evidence || "").trim().slice(0, 240)
  let demoted = false
  if (k === KTYPE.FACT && !ev) {
    k = KTYPE.HYPOTHESIS
    demoted = true
  }
  const id = slugId(k, body)
  const all = loadKnowtype(cwd)
  all.items = all.items || {}
  const rec = {
    id, type: k, text: body, source: String(source || "cli").slice(0, 32),
    evidence: ev, demoted,
    at: Date.now(),
  }
  all.items[id] = rec
  const names = Object.keys(all.items)
  if (names.length > MAX_KNOW) {
    names.sort((a, b) => (all.items[b].at ?? 0) - (all.items[a].at ?? 0))
    for (const key of names.slice(MAX_KNOW)) delete all.items[key]
  }
  all.v = 1
  all.updated = Date.now()
  saveKnowtype(cwd, all)
  return { ok: true, ...rec }
}

export function listKnowledge(cwd = process.cwd(), type = null) {
  const want = type ? normalizeType(type) : null
  return Object.values(loadKnowtype(cwd).items || {}).filter((x) => x && (!want || x.type === want))
}

export function pickKnowledge(task = "", { cwd = process.cwd(), klass = null, limit = 4 } = {}) {
  if (klass === TASK_CLASS.MICRO || klass === TASK_CLASS.SMALL) return []
  const rows = listKnowledge(cwd)
  if (!rows.length) return []
  const scored = []
  for (const rec of rows) {
    const hit = (namedIn(task, rec.text) ? 2 : 0) + scoreAgainst(task, rec.text, rec.type)
    if (hit < 1 && rec.type === KTYPE.HYPOTHESIS) continue
    scored.push({ ...rec, hit, rank: RANK[rec.type] || 0 })
  }
  scored.sort((a, b) => (b.rank - a.rank) || (b.hit - a.hit) || ((b.at || 0) - (a.at || 0)))
  return scored.slice(0, Math.max(0, Number(limit) || 4))
}

export function formatKnowtype(rows) {
  const list = Array.isArray(rows) ? rows.filter((x) => x && x.text) : []
  if (!list.length) return ""
  const bits = list.map((x) => {
    const tag = x.type === KTYPE.HYPOTHESIS ? `${x.type} (unproven)` : x.type
    return `${tag} ${String(x.text).slice(0, 80)}`
  })
  return `KNOW: ${bits.join(" | ")}`
}

/** HYPOTHESIS never satisfies a FACT requirement. */
export function asFact(rec) {
  return Boolean(rec && rec.type === KTYPE.FACT && rec.evidence)
}
