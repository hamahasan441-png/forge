/**
 * forge — strategy 2.0 (v79, zero dependencies)
 *
 * Evidence-scored strategies under FORGE_HOME/projects/<hash>/strategy.json.
 * Beyond v40 evolveRun score/avoid. Compose never writes. MICRO skip.
 * Never auto-ACTIVE. Not a second kernel.
 */
import fs from "node:fs"
import path from "node:path"
import { writeStateFile } from "./securefs.js"
import { projectDir } from "./memory.js"
import { TASK_CLASS } from "./classify.js"
import { namedIn, scoreAgainst } from "./evaluate.js"

export const STRATEGY_FILE = "strategy.json"
export const MAX_STRATEGIES = 24

export function strategyPath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), STRATEGY_FILE)
}

export function loadStrategies(cwd = process.cwd()) {
  try {
    const j = JSON.parse(fs.readFileSync(strategyPath(cwd), "utf8"))
    if (!j || typeof j !== "object") return { v: 1, items: {} }
    if (!j.items || typeof j.items !== "object") j.items = {}
    return j
  } catch {
    return { v: 1, items: {} }
  }
}

function saveStrategies(cwd, data) {
  writeStateFile(strategyPath(cwd), JSON.stringify(data, null, 1), { mode: 0o600 })
}

export function recordStrategy({ cwd = process.cwd(), name = "", ok = false, score = null } = {}) {
  const id = String(name || "").trim().slice(0, 48)
  if (!cwd || !id) return null
  const all = loadStrategies(cwd)
  const items = all.items || (all.items = {})
  const rec = items[id] && typeof items[id] === "object" ? items[id] : {
    name: id, samples: 0, ok: 0, failed: 0, firstSeen: Date.now(),
  }
  rec.name = id
  rec.samples = (rec.samples ?? 0) + 1
  if (ok) rec.ok = (rec.ok ?? 0) + 1
  else rec.failed = (rec.failed ?? 0) + 1
  if (score != null && Number.isFinite(Number(score))) rec.lastScore = Number(score)
  rec.rate = rec.samples ? rec.ok / rec.samples : 0
  rec.lastSeen = Date.now()
  items[id] = rec
  const names = Object.keys(items)
  if (names.length > MAX_STRATEGIES) {
    names.sort((a, b) => (items[b].lastSeen ?? 0) - (items[a].lastSeen ?? 0))
    for (const k of names.slice(MAX_STRATEGIES)) delete items[k]
  }
  all.v = 1
  all.updated = Date.now()
  all.items = items
  saveStrategies(cwd, all)
  return rec
}

export function pickStrategy(task = "", { cwd = process.cwd(), klass = null, limit = 3 } = {}) {
  if (klass === TASK_CLASS.MICRO || klass === TASK_CLASS.SMALL) return []
  const items = loadStrategies(cwd).items || {}
  const names = Object.keys(items)
  if (!names.length) return []
  const scored = []
  for (const name of names) {
    const rec = items[name]
    if (!rec || (rec.samples ?? 0) < 1) continue
    const hit = namedIn(task, name) ? 2 : scoreAgainst(task, name, name)
    const rate = Number(rec.rate ?? 0)
    scored.push({ name, rate, samples: rec.samples, hit, lastScore: rec.lastScore ?? null })
  }
  scored.sort((a, b) => (b.hit - a.hit) || (b.rate - a.rate) || (b.samples - a.samples) || a.name.localeCompare(b.name))
  return scored.slice(0, Math.max(0, Number(limit) || 3))
}

export function formatStrategy(rows) {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return ""
  return `STRAT: ${list.map((s) => `${s.name} (${Math.round((s.rate || 0) * 100)}%)`).join(", ")}`
}
