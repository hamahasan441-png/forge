/**
 * forge — strategy 3.0 (v93 gap fix §23/§24, zero dependencies)
 *
 * Evidence-scored strategies under FORGE_HOME/projects/<hash>/strategy.json.
 * Beyond v40 evolveRun score/avoid. Compose never writes. MICRO skip.
 * Never auto-ACTIVE. Not a second kernel.
 *
 * v93 STRATEGY 3.0: selection is CONTEXTUAL, not just historical hit-rate.
 * Context factors (task class, language overlap, project shape, resource
 * state, failure history, latency) adjust the score, and every pick carries
 * a JUSTIFICATION: why this one, why not the runner-up, what evidence
 * supports it. Outcomes are stored WITH their context (klass/langs/latency)
 * so future selection learns what worked WHERE. Task-level adaptation only
 * — never a self-modifying kernel.
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

export function recordStrategy({ cwd = process.cwd(), name = "", ok = false, score = null, klass = null, langs = [], latencyMs = null } = {}) {
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
  // v93 §23: the outcome is stored WITH its context — future selection can
  // learn which strategy worked for which class/language/latency envelope
  if (klass) rec.klass = String(klass).slice(0, 24)
  if (Array.isArray(langs) && langs.length) rec.langs = langs.map((l) => String(l).slice(0, 16)).slice(0, 6)
  if (latencyMs != null && Number.isFinite(Number(latencyMs))) rec.avgLatencyMs = Math.round(((rec.avgLatencyMs ?? 0) * (rec.samples - 1) + Number(latencyMs)) / rec.samples)
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

export function pickStrategy(task = "", { cwd = process.cwd(), klass = null, limit = 3, context = null } = {}) {
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
    // --- v93 §23: contextual factors (real data only; absent = unused) ---
    const factors = { hit, rate, samples: rec.samples }
    let boost = 0
    const ctxLangs = Array.isArray(context?.languages) ? context.languages.map(String) : []
    const recLangs = Array.isArray(rec.langs) ? rec.langs.map(String) : []
    if (ctxLangs.length && recLangs.length) {
      const overlap = recLangs.filter((l) => ctxLangs.includes(l)).length
      if (overlap) { factors.languageOverlap = overlap; boost += 0.5 * Math.min(overlap, 2) }
    }
    if (klass && rec.klass && String(klass) === String(rec.klass)) { factors.classMatch = true; boost += 0.4 }
    if (Number(rec.failed ?? 0) >= 3 && rate < 0.3) { factors.recentFailureHistory = true; boost -= 0.6 }
    if (context?.resourceState === "degraded" && Number.isFinite(Number(rec.avgLatencyMs))) {
      factors.avgLatencyMs = rec.avgLatencyMs
      if (rec.avgLatencyMs > 60000) boost -= 0.3 // degraded resources prefer the proven-fast
    }
    scored.push({ name, rate, samples: rec.samples, hit, lastScore: rec.lastScore ?? null, boost: Math.round(boost * 100) / 100, factors })
  }
  scored.sort((a, b) => (b.hit - a.hit) || (b.rate + (b.boost ?? 0) - (a.rate + (a.boost ?? 0))) || (b.samples - a.samples) || a.name.localeCompare(b.name))
  return scored.slice(0, Math.max(0, Number(limit) || 3))
}

/**
 * v93 §23 — the justified pick: WHY this strategy, WHY NOT the alternative,
 * WHAT evidence supports it. Deterministic, bounded, honest about missing
 * evidence (a 1-sample strategy says so).
 */
export function pickStrategyJustified(task = "", opts = {}) {
  const ranked = pickStrategy(task, opts)
  if (!ranked.length) return { chosen: null, why: "no strategy history for this project yet — the first runs create it", whyNot: [], evidence: null, candidates: [] }
  const chosen = ranked[0]
  const whyBits = [
    `${chosen.name}: ${(Math.round(chosen.rate * 100))}% ok over ${chosen.samples} sample(s)`,
    chosen.hit ? "task-name match" : "task similarity",
  ]
  if (chosen.factors?.languageOverlap) whyBits.push(`worked on ${chosen.factors.languageOverlap} of this project's language(s) before`)
  if (chosen.factors?.classMatch) whyBits.push("same task class")
  if (chosen.samples < 3) whyBits.push("LOW SAMPLES — weak evidence, treat with caution")
  const whyNot = ranked.slice(1, 3).map((r) => ({
    name: r.name,
    reason: r.rate < chosen.rate
      ? `${(Math.round(r.rate * 100))}% ok (lower) over ${r.samples} sample(s)`
      : r.hit < chosen.hit ? "weaker task match" : "ranked below on context factors",
  }))
  return {
    chosen: chosen.name,
    why: whyBits.join("; "),
    whyNot,
    evidence: { rate: chosen.rate, samples: chosen.samples, hit: chosen.hit, factors: chosen.factors ?? {} },
    candidates: ranked.map((r) => ({ name: r.name, rate: r.rate, samples: r.samples })),
  }
}

/** §23 — a bounded prompt block: the pick + its justification. */
export function formatStrategyJustified(j = null) {
  if (!j || !j.chosen) return ""
  const lines = [`STRATEGY: ${j.chosen} — ${j.why}`]
  for (const n of j.whyNot ?? []) lines.push(`  not ${n.name}: ${n.reason}`)
  return lines.slice(0, 4).join("\n")
}

export function formatStrategy(rows) {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return ""
  return `STRAT: ${list.map((s) => `${s.name} (${Math.round((s.rate || 0) * 100)}%)`).join(", ")}`
}
