/**
 * forge — fastwise freshness layer (v94 phase 5, zero dependencies)
 *
 * The Sharp-Six "fastwise" phase: same intelligence, less wasted work.
 * Three capabilities, ONE engine, fully offline (no model calls, no network —
 * Termux/aarch64 friendly: bounded reads, tiny caches, unref'd timers):
 *
 *   1. createFreshMemo — the ONE shared TTL + file-fingerprint memo utility.
 *      It generalizes the house freshness conventions that already exist
 *      (searchproviders' injectable `now` + oldest-at eviction, the
 *      `${mtimeMs}:${size}` signature used by engmemory/critique/index,
 *      profile's timestamp+signature dual check) instead of duplicating them.
 *      TTL bounds HOW OFTEN a value is recomputed; a caller-supplied
 *      fingerprint beats the TTL so drift is never served (same discipline as
 *      the FORGE_INDEX=0 "never fake a hit" contract).
 *
 *   2. likelyNext — offline "what will this task touch next" prediction from
 *      signals forge already has: the plan frontier (files named in
 *      objectives) and the knowwise knowledge-graph hub modules (read through
 *      engmemory's ONE KG parser — no second graph implementation).
 *
 *   3. warmCaches — idle-time prefetch of the expensive read paths the rest
 *      of the engine pays for later: the persistent world-model snapshot
 *      (worldmodel persists it; later builds pay only a stat-only drift walk)
 *      and the semantic chunk cache (ONE bounded BM25 pass, embed=null →
 *      pure offline; FORGE_INDEX=0 skips it entirely — never writes, never
 *      fakes). The knowwise KG floor graph is NOT warmed here — meta already
 *      bootstraps it (knowwise), and fastwise never duplicates another
 *      engine's job.
 *
 * Off switch: FORGE_FASTWISE=0/false/off (same disable convention as
 * FORGE_CRITIQUE / FORGE_BLAST_RADIUS). Every path is best-effort: failures
 * are swallowed or returned honestly, never thrown into the result path.
 */

import fs from "node:fs"
import path from "node:path"
import { createWorldModel } from "./worldmodel.js"
import { semanticSearch } from "./codesearch.js"
import { knowledgeGraphFacts } from "./engmemory.js"

export const FASTWISE_TTL_MS = 60_000 // one warm pass per minute per project, max
const MEMO_MAX = 32
const WARM_MAX_FILES = 400 // matches codesearch MAX_FILES — one warm = one bounded pass

/** House disable convention: 0/false/off (any case) turns fastwise off. */
export function fastwiseEnabled() {
  const v = String(process.env.FORGE_FASTWISE ?? "").toLowerCase()
  return !(v === "0" || v === "false" || v === "off")
}

/** The house freshness signature: `${mtimeMs}:${size}`, "absent" sentinel. */
export function fileFingerprint(abs) {
  try {
    const st = fs.statSync(abs)
    return `${st.mtimeMs}:${st.size}`
  } catch { return "absent" }
}

/**
 * The ONE freshness memo. `get(key, compute, opts)` returns { value, hit }.
 *   opts.ttlMs        fixed window from write time (non-sliding, like
 *                     searchproviders' cacheGet) — default FASTWISE_TTL_MS
 *   opts.fingerprint  caller-supplied drift signal; a MISMATCH invalidates
 *                     even inside the TTL (drift beats time); null skips
 *   opts.now          injectable clock for deterministic tests
 * Bounded: oldest-`at` eviction at `max` entries. Failures are NOT cached —
 * a throwing compute propagates and the next call retries.
 */
export function createFreshMemo({ ttlMs = FASTWISE_TTL_MS, max = MEMO_MAX, now: defaultNow } = {}) {
  const store = new Map() // key → { value, at, fingerprint }
  const nowOf = (n) => Number.isFinite(n) ? n : (typeof defaultNow === "function" ? defaultNow() : Date.now())
  function get(key, compute, opts = {}) {
    const t = nowOf(opts.now)
    const ttl = Number.isFinite(opts.ttlMs) ? opts.ttlMs : ttlMs
    const fp = opts.fingerprint ?? null
    const hit = store.get(key)
    if (hit
      && t - hit.at < ttl
      && (fp === null || hit.fingerprint === null || hit.fingerprint === fp)) {
      return { value: hit.value, hit: true }
    }
    const value = compute()
    if (store.size >= max) {
      let oldest = null
      for (const [k, v] of store) if (oldest === null || v.at < store.get(oldest).at) oldest = k
      if (oldest !== null) store.delete(oldest)
    }
    store.set(key, { value, at: t, fingerprint: fp })
    return { value, hit: false }
  }
  return {
    get,
    get size() { return store.size },
    clear() { store.clear() },
    forget(key) { store.delete(key) },
  }
}

// ---------------------------------------------------------------------------
// likelyNext — offline prediction of the files a task will touch next
// ---------------------------------------------------------------------------

const PATH_TOKEN = /[\w./\\~-]+\.(?:js|mjs|cjs|jsx|ts|tsx|py|rs|go|java|rb|php|c|h|cpp|cc|hpp|cs|swift|kt|sh|bash|lua|dart|md|json|ya?ml|toml|sql)/g

/**
 * Predict the likely-next files from two offline signals:
 *   1. plan frontier — path-like tokens named in the given objectives
 *      (the DAG's not-yet-done node objectives; weight 2)
 *   2. knowwise hubs — files of the highest-degree knowledge-graph modules,
 *      via engmemory's ONE cached KG parser (weight 1)
 * Deterministic (weight desc, then lexicographic), bounded by `limit`,
 * never throws (an unreadable/absent KG just contributes no hubs).
 */
export function likelyNext({ cwd = process.cwd(), objectives = [], limit = 8 } = {}) {
  const out = new Map() // lowercase file → { file, why, weight }
  const add = (raw, why, w) => {
    const f = String(raw ?? "").replace(/\\/g, "/").replace(/^\.\//, "").trim()
    if (!f || f.length > 200 || f.includes("..")) return
    const key = f.toLowerCase()
    const cur = out.get(key)
    if (cur) {
      cur.weight += w
      if (!cur.why.includes(why)) cur.why += ` + ${why}`
    } else {
      out.set(key, { file: f, why, weight: w })
    }
  }
  let frontier = 0
  for (const o of (Array.isArray(objectives) ? objectives : [objectives])) {
    const text = String(o ?? "")
    if (!text) continue
    frontier++
    for (const m of text.matchAll(PATH_TOKEN)) add(m[0], "named in the plan frontier", 2)
  }
  let hubs = 0
  try {
    const facts = knowledgeGraphFacts(cwd)
    if (facts?.ok) {
      for (const e of facts.entries ?? []) {
        for (const f of e.files ?? []) { add(f, "knowledge-graph hub", 1); hubs++ }
      }
    }
  } catch { /* KG hubs are optional — absent graph contributes nothing */ }
  const files = [...out.values()]
    .sort((a, b) => b.weight - a.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .slice(0, Math.max(1, Math.min(32, Number(limit) || 8)))
  return { ok: true, files, signals: { objectives: frontier, hubs }, bounded: true }
}

// ---------------------------------------------------------------------------
// warmCaches — idle-time prefetch (world snapshot + semantic chunks)
// ---------------------------------------------------------------------------

const warmMemo = createFreshMemo({ ttlMs: FASTWISE_TTL_MS, max: 4 })

async function doWarm(base, objectives) {
  const warmed = []
  const predicted = likelyNext({ cwd: base, objectives })
  // 1 — world-model snapshot: build it now (bounded, persisted into the forge
  //     state dir) so the NEXT plan/answer instance pays only the stat-only
  //     drift walk instead of full extraction. Self-correcting: build()
  //     re-extracts anything whose size/mtime drifted, so a stale warm can
  //     never be served. v98 shipwise: the walk runs CHUNKED (buildAsync) —
  //     the idle warm pass must never freeze an interactive session, and the
  //     in-flight promise share means a concurrent meta consult joins THIS
  //     pass instead of racing it.
  try {
    const world = await createWorldModel({ cwd: base }).buildAsync()
    if (world && Array.isArray(world.files)) warmed.push("world-snapshot")
  } catch { /* best-effort */ }
  // 2 — semantic chunk cache: ONE bounded BM25 pass (embed=null → offline by
  //     construction). Honors FORGE_INDEX=0 by being skipped entirely — the
  //     no-fake-hit / no-write discipline is codesearch's own, and fastwise
  //     never circumvents it. semanticSearch is async — awaited here so the
  //     memoized pass reflects the REAL result, never a pending promise.
  if (process.env.FORGE_INDEX !== "0") {
    try {
      const q = predicted.files[0]?.file ?? "project"
      const r = await semanticSearch(base, q, { maxFiles: WARM_MAX_FILES, embed: null })
      if (r && typeof r.chunks === "number") warmed.push(r.chunks > 0 ? `semantic-chunks:${r.chunks}` : "semantic-chunks")
    } catch { /* best-effort */ }
  }
  return { warmed, predicted: predicted.files.map((f) => f.file).slice(0, 5) }
}

/**
 * Warm the expensive read paths once per freshness window per project.
 * Best-effort and honest: { ok:false } with a reason when disabled or the
 * pass failed; `cached:true` when the TTL memo served a previous pass.
 * The memo stores the IN-FLIGHT promise, so concurrent callers share ONE
 * warm pass; a failed pass is forgotten (failures are never cached).
 */
export async function warmCaches({ cwd = process.cwd(), objectives = [], ttlMs = null, now = null } = {}) {
  const fail = (reason) => ({ ok: false, warmed: [], predicted: [], cached: false, reason })
  if (!fastwiseEnabled()) return fail("fastwise disabled (FORGE_FASTWISE)")
  const base = path.resolve(String(cwd || process.cwd()))
  const key = `warm:${base}`
  const opts = { fingerprint: fileFingerprint(base) }
  if (Number.isFinite(ttlMs)) opts.ttlMs = ttlMs
  if (now !== null) opts.now = now
  let res
  try {
    res = warmMemo.get(key, () => doWarm(base, objectives), opts)
  } catch {
    return fail("warm pass failed (best-effort, nothing cached)")
  }
  try {
    const out = await res.value
    return { ok: true, warmed: out.warmed, predicted: out.predicted, cached: res.hit }
  } catch {
    warmMemo.forget(key) // a rejected pass must not poison the freshness window
    return fail("warm pass failed (best-effort, nothing cached)")
  }
}

/** Test/diagnostic hook: forget every memoized warm pass. */
export function clearFastwiseMemo() {
  warmMemo.clear()
}
