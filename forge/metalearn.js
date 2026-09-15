/**
 * forge — meta-learning for REASONING POLICY (v109 metawise)
 *
 * Not a second brain. Not a MetaManager.
 * Governor still owns ASK/STOP/VERIFY. This only answers:
 *   "for this task class, did extra reasoning pay for itself?"
 *
 * EXPERIENCE → record → recommendDepth → next similar task uses a
 * different DEPTH (not a different slogan). MICRO never learns upward.
 *
 * Env drift (envfingerprint) discounts old stats — do not trust L2
 * success from a different Node/toolchain.
 */
import fs from "node:fs"
import path from "node:path"
import { projectDir } from "./memory.js"
import { writeStateFile } from "./securefs.js"
import { DEPTH } from "./governor.js"
import { loadEnv, capture, diff } from "./envfingerprint.js"

export const METALEARN_VERSION = "1.0.0"
export const METALEARN_FILE = "metalearn.json"
export const DEPTH_ORDER = [DEPTH.L1, DEPTH.L2, DEPTH.L3, DEPTH.L4, DEPTH.L5, DEPTH.L6]

const MICRO = new Set(["MICRO", "trivial"])
const MAX_KLASS = 12
const MAX_RECENT = 8

export function metalearnPath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), METALEARN_FILE)
}

function emptySlice() {
  return { samples: 0, ok: 0, failed: 0, repairs: 0, replans: 0, recent: [] }
}

export function loadMetaLearn(cwd = process.cwd()) {
  try {
    const j = JSON.parse(fs.readFileSync(metalearnPath(cwd), "utf8"))
    if (j && typeof j === "object" && j.byKlass && typeof j.byKlass === "object") return j
  } catch { /* first run */ }
  return { v: METALEARN_VERSION, byKlass: {}, updated: 0 }
}

function saveMetaLearn(cwd, store) {
  writeStateFile(metalearnPath(cwd), JSON.stringify(store, null, 1), { mode: 0o600 })
}

function depthIndex(d) {
  const i = DEPTH_ORDER.indexOf(String(d))
  return i < 0 ? 1 : i
}

export function recordReasoning({
  cwd = process.cwd(),
  klass = "SMALL",
  depth = DEPTH.L2,
  ok = false,
  repairs = 0,
  replans = 0,
} = {}) {
  const k = String(klass || "SMALL").slice(0, 24)
  const d = DEPTH_ORDER.includes(String(depth)) ? String(depth) : DEPTH.L2
  const store = loadMetaLearn(cwd)
  const row = store.byKlass[k] && typeof store.byKlass[k] === "object" ? store.byKlass[k] : {}
  const slice = row[d] && typeof row[d] === "object" ? row[d] : emptySlice()
  slice.samples = (slice.samples || 0) + 1
  if (ok) slice.ok = (slice.ok || 0) + 1
  else slice.failed = (slice.failed || 0) + 1
  slice.repairs = (slice.repairs || 0) + (Number(repairs) || 0)
  slice.replans = (slice.replans || 0) + (Number(replans) || 0)
  slice.recent = Array.isArray(slice.recent) ? slice.recent : []
  slice.recent.push(ok ? 1 : 0)
  if (slice.recent.length > MAX_RECENT) slice.recent = slice.recent.slice(-MAX_RECENT)
  row[d] = slice
  store.byKlass[k] = row
  const keys = Object.keys(store.byKlass)
  if (keys.length > MAX_KLASS) {
    // drop the oldest-looking klass with fewest samples
    keys.sort((a, b) => {
      const sa = Object.values(store.byKlass[a] || {}).reduce((n, s) => n + (s.samples || 0), 0)
      const sb = Object.values(store.byKlass[b] || {}).reduce((n, s) => n + (s.samples || 0), 0)
      return sa - sb
    })
    for (const drop of keys.slice(0, keys.length - MAX_KLASS)) delete store.byKlass[drop]
  }
  store.v = METALEARN_VERSION
  store.updated = Date.now()
  saveMetaLearn(cwd, store)
  return slice
}

function rateOf(slice) {
  const n = slice?.samples || 0
  if (!n) return null
  return (slice.ok || 0) / n
}

function scoreDepth(slice, depth) {
  const r = rateOf(slice)
  if (r == null || (slice.samples || 0) < 3) return null
  return r - 0.08 * depthIndex(depth)
}

export function policyShift({ cwd = process.cwd(), klass = "SMALL", depth = "" } = {}) {
  const row = loadMetaLearn(cwd).byKlass?.[String(klass)] || {}
  const slice = depth ? row[depth] : Object.values(row)[0]
  if (!slice || (slice.samples || 0) < 6) return { shifted: false }
  const recent = Array.isArray(slice.recent) ? slice.recent : []
  if (recent.length < 4) return { shifted: false }
  const hist = rateOf(slice)
  const rec = recent.reduce((a, b) => a + b, 0) / recent.length
  if (hist >= 0.6 && rec <= 0.25) return { shifted: true, why: `recent ${depth || "policy"} success ${Math.round(rec * 100)}% vs historical ${Math.round(hist * 100)}%` }
  return { shifted: false }
}

/**
 * Recommend a reasoning depth. Never below L1, never L7, never raise MICRO.
 * Failed/conflict paths should keep the governor's depthFor (caller decides).
 */
export function recommendDepth({
  cwd = process.cwd(),
  klass = "SMALL",
  fallback = DEPTH.L2,
  failed = false,
  conflict = false,
  drifted = null,
} = {}) {
  const fb = DEPTH_ORDER.includes(String(fallback)) ? String(fallback) : DEPTH.L2
  if (MICRO.has(klass)) return { depth: fb, why: "MICRO does not learn extra reasoning", source: "default" }
  if (failed || conflict) return { depth: fb, why: "failure/conflict keeps governor depth", source: "default" }

  let envShifted = drifted === true
  if (drifted == null) {
    try {
      const prev = loadEnv(cwd)
      if (prev) {
        const fp = capture({ persistedVersions: prev.toolchains ?? null })
        const d = prev && fp ? diff(prev, fp) : null
        envShifted = Boolean(d?.drifted)
      }
    } catch { /* fingerprint is advisory */ }
  }
  if (envShifted) return { depth: fb, why: "environment drifted — do not trust old cheap-depth stats", source: "shift", shifted: true }

  const row = loadMetaLearn(cwd).byKlass?.[String(klass)] || {}
  const scored = []
  for (const d of DEPTH_ORDER) {
    const s = scoreDepth(row[d], d)
    if (s != null) scored.push({ depth: d, score: s, rate: rateOf(row[d]), samples: row[d].samples })
  }
  if (!scored.length) return { depth: fb, why: "insufficient evidence — default depth", source: "default" }

  scored.sort((a, b) => (b.score - a.score) || (depthIndex(a.depth) - depthIndex(b.depth)))
  const best = scored[0]
  const shift = policyShift({ cwd, klass, depth: fb })
  if (shift.shifted) {
    const up = DEPTH_ORDER[Math.min(DEPTH_ORDER.length - 1, depthIndex(fb) + 1)]
    return { depth: up, why: shift.why, source: "shift", shifted: true }
  }
  if (klass === "ARCHITECTURAL" && depthIndex(best.depth) < 2) {
    return { depth: DEPTH.L3, why: "ARCHITECTURAL never below L3", source: "floor" }
  }
  if (best.rate < 0.4 && depthIndex(fb) > depthIndex(best.depth)) {
    return { depth: fb, why: `learned ${best.depth} succeeds only ${Math.round(best.rate * 100)}% — keep ${fb}`, source: "default" }
  }
  return {
    depth: best.depth,
    why: `${klass} ${best.depth} measured ${Math.round(best.rate * 100)}% n=${best.samples} (cheaper-if-equal)`,
    source: "learned",
    rate: best.rate,
    samples: best.samples,
  }
}

export function formatMetaPolicy(rec) {
  if (!rec) return ""
  return `META POLICY (reasoning depth): ${rec.depth} — ${rec.why}`
}

export function recordStrategy({ cwd = process.cwd(), klass = "SMALL", id = "", ok = false } = {}) {
  const name = String(id || "").slice(0, 40)
  if (!name) return null
  const store = loadMetaLearn(cwd)
  const row = store.byKlass[String(klass)] && typeof store.byKlass[String(klass)] === "object"
    ? store.byKlass[String(klass)] : {}
  const strats = row.strategies && typeof row.strategies === "object" ? row.strategies : {}
  const rec = strats[name] && typeof strats[name] === "object" ? strats[name] : { samples: 0, ok: 0, failed: 0 }
  rec.samples = (rec.samples || 0) + 1
  if (ok) rec.ok = (rec.ok || 0) + 1
  else rec.failed = (rec.failed || 0) + 1
  rec.rate = rec.samples ? rec.ok / rec.samples : 0
  strats[name] = rec
  row.strategies = strats
  store.byKlass[String(klass)] = row
  store.updated = Date.now()
  saveMetaLearn(cwd, store)
  return rec
}

export function strategyRates(cwd = process.cwd(), klass = "SMALL") {
  const row = loadMetaLearn(cwd).byKlass?.[String(klass)] || {}
  return row.strategies && typeof row.strategies === "object" ? row.strategies : {}
}

/** Would current policy pick the same depth as a historical run? */
export function replayDepth({ cwd = process.cwd(), klass = "SMALL", historical = "" } = {}) {
  const now = recommendDepth({ cwd, klass, fallback: historical || DEPTH.L2 })
  return {
    historical: String(historical || ""),
    current: now.depth,
    changed: now.depth !== String(historical || ""),
    why: now.why,
    source: now.source,
  }
}
