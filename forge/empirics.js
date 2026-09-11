/**
 * forge — model empirics (v79, zero dependencies)
 *
 * Real outcomes under FORGE_HOME/model-outcomes.json. Not a static registry.
 * Compose never writes. MICRO skip. Never auto-picks an untested model.
 */
import fs from "node:fs"
import path from "node:path"
import { writeStateFile } from "./securefs.js"
import { resolveDataDir } from "./config.js"

export const EMPIRIC_FILE = "model-outcomes.json"
export const MAX_MODELS = 48

export function empiricPath(env = process.env) {
  return path.join(resolveDataDir(env), EMPIRIC_FILE)
}

export function loadEmpirics(env = process.env) {
  try {
    const j = JSON.parse(fs.readFileSync(empiricPath(env), "utf8"))
    if (!j || typeof j !== "object") return { v: 1, items: {} }
    if (!j.items || typeof j.items !== "object") j.items = {}
    return j
  } catch {
    return { v: 1, items: {} }
  }
}

function saveEmpirics(env, data) {
  writeStateFile(empiricPath(env), JSON.stringify(data, null, 1), { mode: 0o600 })
}

function keyOf(provider, model) {
  return `${String(provider || "?").slice(0, 32)}/${String(model || "?").slice(0, 64)}`
}

export function recordModelOutcome({ env = process.env, provider = "", model = "", ok = false, ms = 0, klass = "" } = {}) {
  const id = keyOf(provider, model)
  if (!model) return null
  const all = loadEmpirics(env)
  const items = all.items || (all.items = {})
  const rec = items[id] && typeof items[id] === "object" ? items[id] : {
    provider, model, samples: 0, ok: 0, failed: 0, ms: 0, firstSeen: Date.now(),
  }
  rec.provider = provider || rec.provider
  rec.model = model
  rec.samples = (rec.samples ?? 0) + 1
  if (ok) rec.ok = (rec.ok ?? 0) + 1
  else rec.failed = (rec.failed ?? 0) + 1
  rec.ms = (rec.ms ?? 0) + (Number(ms) || 0)
  rec.rate = rec.samples ? rec.ok / rec.samples : 0
  rec.lastKlass = String(klass || rec.lastKlass || "").slice(0, 24)
  rec.lastSeen = Date.now()
  items[id] = rec
  const names = Object.keys(items)
  if (names.length > MAX_MODELS) {
    names.sort((a, b) => (items[b].lastSeen ?? 0) - (items[a].lastSeen ?? 0))
    for (const k of names.slice(MAX_MODELS)) delete items[k]
  }
  all.v = 1
  all.updated = Date.now()
  all.items = items
  saveEmpirics(env, all)
  return rec
}

export function pickModelEmpiric({ env = process.env, candidates = [], limit = 3 } = {}) {
  const items = loadEmpirics(env).items || {}
  const want = new Set((candidates || []).map((c) => keyOf(c.provider, c.model || c)))
  const scored = []
  for (const [id, rec] of Object.entries(items)) {
    if (want.size && !want.has(id) && !want.has(rec.model)) continue
    if ((rec.samples ?? 0) < 1) continue
    scored.push({
      id, provider: rec.provider, model: rec.model,
      rate: Number(rec.rate ?? 0), samples: rec.samples,
      avgMs: rec.samples ? Math.round(rec.ms / rec.samples) : 0,
    })
  }
  scored.sort((a, b) => (b.rate - a.rate) || (b.samples - a.samples) || a.id.localeCompare(b.id))
  return scored.slice(0, Math.max(0, Number(limit) || 3))
}

export function formatEmpiric(rows) {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return ""
  return `MODELS: ${list.map((s) => `${s.model} (${Math.round((s.rate || 0) * 100)}%, n=${s.samples})`).join(", ")}`
}
