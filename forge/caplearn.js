/**
 * forge — empirical capability learning (v106 capabilitywise, zero dependencies)
 *
 * Stats that never change routing are not learning. This module records what
 * a capability DID under a task class, then the router withholds or prefers
 * on the NEXT turn.
 *
 * Conditional: skill X can be HEALTHY for LARGE review and UNRELIABLE for
 * ARCHITECTURAL rewrites. One global number is a lie.
 *
 * Project-local: ~/.forge/projects/<hash>/caplearn.json
 * Native tools stay in toolintel. Models stay in empirics. This is skills,
 * MCP, and compositions — the things caproute actually offers.
 */
import fs from "node:fs"
import path from "node:path"
import { writeStateFile } from "./securefs.js"
import { projectDir } from "./memory.js"

export const CAPLEARN_FILE = "caplearn.json"
export const CAPLEARN_VERSION = "1.0.0"
export const MAX_ITEMS = 80
export const MAX_NEGATIVES = 8

export const HEALTH = Object.freeze({
  UNKNOWN: "UNKNOWN",
  HEALTHY: "HEALTHY",
  DEGRADED: "DEGRADED",
  UNRELIABLE: "UNRELIABLE",
  BROKEN: "BROKEN",
})

export function caplearnPath(cwd) {
  return path.join(projectDir(cwd || process.cwd()), CAPLEARN_FILE)
}

export function loadCapLearn(cwd) {
  try {
    const j = JSON.parse(fs.readFileSync(caplearnPath(cwd), "utf8"))
    if (!j || typeof j !== "object" || Array.isArray(j)) return emptyStore()
    if (!j.items || typeof j.items !== "object") j.items = {}
    return j
  } catch {
    return emptyStore()
  }
}

function emptyStore() {
  return { v: 1, schema: CAPLEARN_VERSION, items: {}, updated: 0 }
}

function saveStore(cwd, data) {
  writeStateFile(caplearnPath(cwd), JSON.stringify(data, null, 1), { mode: 0o600 })
}

function keyOf(kind, name) {
  return `${String(kind || "cap").slice(0, 16)}:${String(name || "").slice(0, 80)}`
}

function emptyRec(kind, name) {
  return { kind, name, samples: 0, ok: 0, failed: 0, byKlass: {}, compositions: {}, negatives: [], firstSeen: Date.now() }
}

export function healthOf(rec) {
  if (!rec || (rec.samples ?? 0) < 2) return HEALTH.UNKNOWN
  const rate = rec.samples ? rec.ok / rec.samples : 0
  if (rate <= 0.2 && rec.samples >= 3) return HEALTH.BROKEN
  if (rate < 0.45) return HEALTH.UNRELIABLE
  if (rate < 0.7) return HEALTH.DEGRADED
  return HEALTH.HEALTHY
}

function sliceFor(rec, klass) {
  if (!rec) return null
  const k = String(klass || "")
  if (k) return rec.byKlass?.[k] || { samples: 0, ok: 0, failed: 0 }
  return rec
}

export function reputation(store, { name, kind = "skill", klass = "" } = {}) {
  const rec = store?.items?.[keyOf(kind, name)]
  const slice = sliceFor(rec, klass)
  const h = healthOf(slice)
  if (h === HEALTH.BROKEN) return 0.05
  if (h === HEALTH.UNRELIABLE) return 0.2
  if (h === HEALTH.DEGRADED) return 0.45
  if (h === HEALTH.HEALTHY) return 0.9
  return 0.5
}

export function shouldWithhold(store, { name, kind = "skill", klass = "", named = false } = {}) {
  if (named) return false
  const rec = store?.items?.[keyOf(kind, name)]
  const h = healthOf(sliceFor(rec, klass))
  return h === HEALTH.BROKEN || h === HEALTH.UNRELIABLE
}

export function recordCapOutcome({
  cwd = process.cwd(),
  name = "",
  kind = "skill",
  klass = "",
  ok = false,
  why = "",
  composition = null,
} = {}) {
  const n = String(name || "").trim()
  if (!n) return null
  const store = loadCapLearn(cwd)
  const id = keyOf(kind, n)
  const rec = store.items[id] && typeof store.items[id] === "object"
    ? store.items[id]
    : emptyRec(kind, n)
  rec.kind = kind
  rec.name = n
  rec.samples += 1
  if (ok) rec.ok += 1
  else rec.failed += 1
  rec.lastKlass = String(klass || rec.lastKlass || "").slice(0, 24)
  rec.lastSeen = Date.now()
  rec.health = healthOf(rec)
  if (klass) {
    rec.byKlass = rec.byKlass || {}
    const bucket = rec.byKlass[klass] && typeof rec.byKlass[klass] === "object"
      ? rec.byKlass[klass]
      : { samples: 0, ok: 0, failed: 0 }
    bucket.samples += 1
    if (ok) bucket.ok += 1
    else bucket.failed += 1
    bucket.health = healthOf(bucket)
    rec.byKlass[klass] = bucket
  }
  if (!ok && why) {
    rec.negatives = Array.isArray(rec.negatives) ? rec.negatives : []
    rec.negatives.unshift({ klass: String(klass || ""), why: String(why).slice(0, 160), at: Date.now() })
    rec.negatives = rec.negatives.slice(0, MAX_NEGATIVES)
  }
  if (composition) {
    const cid = String(composition).slice(0, 120)
    rec.compositions = rec.compositions || {}
    const c = rec.compositions[cid] || { samples: 0, ok: 0, failed: 0 }
    c.samples += 1
    if (ok) c.ok += 1
    else c.failed += 1
    rec.compositions[cid] = c
  }
  store.items[id] = rec
  const names = Object.keys(store.items)
  if (names.length > MAX_ITEMS) {
    names.sort((a, b) => (store.items[b].lastSeen ?? 0) - (store.items[a].lastSeen ?? 0))
    for (const k of names.slice(MAX_ITEMS)) delete store.items[k]
  }
  store.updated = Date.now()
  store.v = 1
  store.schema = CAPLEARN_VERSION
  saveStore(cwd, store)
  return rec
}

export function recordRunOutcomes({ cwd, klass = "", ok = false, records = [], createdNames = [] } = {}) {
  const list = Array.isArray(records) ? records : []
  const created = new Set((createdNames || []).map(String))
  const used = []
  for (const r of list) {
    const name = r?.name || r?.tool || ""
    if (name === "load_skill") {
      const skill = r.args?.name || r.args?.skill || ""
      if (skill) {
        recordCapOutcome({ cwd, name: skill, kind: "skill", klass, ok, why: ok ? "" : "run failed after load_skill" })
        used.push(`skill:${skill}`)
      }
    } else if (String(name).startsWith("mcp__")) {
      recordCapOutcome({ cwd, name, kind: "mcp", klass, ok, why: ok ? "" : "mcp call on a failed run" })
      used.push(`mcp:${name}`)
    } else if (created.has(name)) {
      recordCapOutcome({ cwd, name, kind: "created", klass, ok, why: ok ? "" : "created tool ran on a failed task" })
      used.push(`created:${name}`)
    }
  }
  if (used.length >= 2) {
    const composition = used.slice(0, 4).join("+")
    recordCapOutcome({ cwd, name: used[0].split(":")[1] || used[0], kind: used[0].split(":")[0] || "skill", klass, ok, composition })
  }
  return used
}

/** A missing capability is an observation, not a tool failure. */
export function noteCapabilityGap({ cwd = process.cwd(), capability = "", klass = "" } = {}) {
  const cap = String(capability || "").trim()
  if (!cap) return null
  return recordCapOutcome({ cwd, name: cap, kind: "gap", klass, ok: false, why: "required capability missing from native/skill/MCP/created" })
}

export function gapRepeats({ cwd = process.cwd(), capability = "", klass = "", min = 2 } = {}) {
  const cap = String(capability || "").trim()
  if (!cap) return false
  const rec = loadCapLearn(cwd).items?.[keyOf("gap", cap)]
  const slice = (klass && rec?.byKlass?.[klass]?.samples) ? rec.byKlass[klass] : rec
  return (slice?.samples ?? 0) >= Math.max(2, Number(min) || 2)
}

export function formatCapLearn(store, { klass = "", limit = 4 } = {}) {
  const items = Object.values(store?.items || {})
  if (!items.length) return ""
  const rows = items
    .map((rec) => {
      const slice = sliceFor(rec, klass) || rec
      return { rec, slice, health: healthOf(slice), rep: reputation({ items: { [keyOf(rec.kind, rec.name)]: rec } }, { name: rec.name, kind: rec.kind, klass }) }
    })
    .filter((r) => r.slice?.samples)
    .sort((a, b) => a.rep - b.rep)
  if (!rows.length) return ""
  const lines = ["CAPABILITY HEALTH (measured, task-class conditional — not a static rank):"]
  for (const r of rows.slice(0, limit)) {
    const s = r.slice
    const rate = s.samples ? (s.ok / s.samples) : 0
    lines.push(`- ${r.rec.kind}:${r.rec.name} [${r.health}] ${s.ok}/${s.samples} ok (${(rate * 100).toFixed(0)}%)${klass ? ` @${klass}` : ""}`)
  }
  return lines.join("\n")
}
