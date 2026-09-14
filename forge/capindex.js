/**
 * forge — the unified capability index (v100 "fabricwise", plan phase 01).
 *
 * Forge had FOUR capability registries that did not know about each other:
 *
 *   native tools   tools.js TOOL_DEFS — always offered
 *   skills         SKILL.md packs, relevance-scored in evaluate.js
 *   MCP tools      mcp.js, gated by capfabric.js
 *   created tools  toolcreate.js, loaded when ACTIVE + verified
 *
 * Each had its own shape, its own notion of "is this any good", and its own
 * selection path. capfabric.js unified the MCP side; this module is the read
 * model over ALL FOUR, so one question — "what can forge do right now, from
 * every source, and how much evidence is there for each?" — has one answer.
 *
 * The evidence is deliberately of two KINDS, because that is the truth:
 *
 *   tools  carry COUNTED history (toolintel: samples / ok / failed / ms)
 *   skills carry an EARNED LIFECYCLE (evolve.js: a VERIFIED skill passed a
 *          behavioral gate twice; a STALE one was verified against files that
 *          have since changed)
 *
 * Both are normalized onto the same 0..1 reliability axis so a single ranking
 * can compare them — but an entry always reports WHICH kind of evidence it
 * has (`evidence`), so nothing is presented as measured when it was inferred.
 * A capability with no evidence scores 0.5: unproven, never "bad".
 *
 * This module RANKS and REPORTS. It executes nothing and mutates nothing.
 * Zero dependencies.
 */
import { scoreAgainst } from "./evaluate.js"
import { reliabilityOf, latencyFactorOf, isExternal, bareToolName } from "./capfabric.js"

export const CAP_SOURCE = Object.freeze({
  NATIVE: "native",
  SKILL: "skill",
  MCP: "mcp",
  CREATED: "created",
})

/** Which kind of evidence backs an entry's reliability. */
export const EVIDENCE = Object.freeze({
  COUNTED: "counted",     // real recorded runs (toolintel)
  LIFECYCLE: "lifecycle", // an earned promotion state (evolve.js)
  NONE: "none",           // nothing observed yet — unproven, not bad
})

/**
 * Lifecycle → reliability prior. A skill has no run counters, but its
 * lifecycle IS evidence: VERIFIED means it passed a behavioral gate twice.
 * Unknown maps to 0.5 — exactly the "unproven" value an unmeasured tool gets,
 * so neither kind of capability is structurally favoured.
 */
const LIFECYCLE_PRIOR = Object.freeze({
  VERIFIED: 0.9,
  ACTIVE: 0.65,
  CANDIDATE: 0.45,
  DEPRECATED: 0.2,
  SUPERSEDED: 0.15,
  ARCHIVED: 0.1,
})

export function lifecyclePrior(lifecycle, { stale = false } = {}) {
  const base = LIFECYCLE_PRIOR[String(lifecycle ?? "").toUpperCase()]
  const v = Number.isFinite(base) ? base : 0.5
  // STALE is not a lifecycle — it is a fact layered on top of one: the skill was
  // verified against files that have since changed. Demote hard, never erase:
  // a stale playbook can still be right, it just stopped being proven.
  return stale ? Math.min(v, 0.2) : v
}

function entry({ source, name, description = "", readOnly = false, reliability, evidence, samples = 0, avgMs = 0, lifecycle = null, stale = false }) {
  return {
    id: `${source}:${name}`,
    source, name,
    description: String(description ?? "").slice(0, 300),
    readOnly: readOnly === true,
    reliability, evidence, samples, avgMs,
    ...(lifecycle ? { lifecycle: String(lifecycle) } : {}),
    ...(stale ? { stale: true } : {}),
  }
}

/** Counted evidence for a tool name, or the unproven default. */
function fromStats(stats, name) {
  const stat = stats ? stats[name] : null
  const samples = Number(stat?.samples) || 0
  if (!samples) return { reliability: 0.5, evidence: EVIDENCE.NONE, samples: 0, avgMs: 0 }
  return {
    reliability: reliabilityOf(stat),
    evidence: EVIDENCE.COUNTED,
    samples,
    avgMs: Math.round((Number(stat?.ms) || 0) / samples),
  }
}

/**
 * One index over every capability forge currently has.
 *
 * Every input is optional: a caller that only knows about some sources gets a
 * partial but honest index rather than an error. Nothing here reads the disk —
 * the caller supplies what it already loaded, so this stays cheap enough to
 * build per turn.
 *
 * @returns {Array<object>} entries, deduplicated by id, in source order
 */
export function buildCapabilityIndex({
  nativeDefs = [],
  mcpPlugins = [],
  skills = [],
  createdTools = [],
  stats = null,
} = {}) {
  const out = []
  const seen = new Set()
  const push = (e) => { if (e && !seen.has(e.id)) { seen.add(e.id); out.push(e) } }

  for (const d of nativeDefs || []) {
    const name = d?.function?.name ?? d?.name
    if (!name) continue
    push(entry({
      source: CAP_SOURCE.NATIVE, name,
      description: d?.function?.description ?? "",
      readOnly: d?.readOnly === true,
      ...fromStats(stats, name),
    }))
  }

  for (const p of mcpPlugins || []) {
    if (!p?.name) continue
    push(entry({
      source: CAP_SOURCE.MCP, name: p.name,
      description: p?.def?.function?.description ?? "",
      readOnly: p.readOnly === true,
      ...fromStats(stats, p.name),
    }))
  }

  for (const s of skills || []) {
    if (!s?.name) continue
    const stale = s.stale === true
    push(entry({
      source: CAP_SOURCE.SKILL, name: s.name,
      description: s.desc ?? s.description ?? "",
      readOnly: true, // a skill is a playbook to READ; loading one mutates nothing
      reliability: lifecyclePrior(s.lifecycle, { stale }),
      evidence: s.lifecycle ? EVIDENCE.LIFECYCLE : EVIDENCE.NONE,
      samples: 0, avgMs: 0,
      lifecycle: s.lifecycle ?? null,
      stale,
    }))
  }

  for (const t of createdTools || []) {
    if (!t?.name) continue
    const counted = fromStats(stats, t.name)
    push(entry({
      source: CAP_SOURCE.CREATED, name: t.name,
      description: t.description ?? "",
      // a created tool that has never run falls back to its lifecycle, which is
      // the gate it had to pass to be registered at all
      ...(counted.evidence === EVIDENCE.COUNTED
        ? counted
        : {
          reliability: lifecyclePrior(t.lifecycle),
          evidence: t.lifecycle ? EVIDENCE.LIFECYCLE : EVIDENCE.NONE,
          samples: 0, avgMs: 0,
        }),
      lifecycle: t.lifecycle ?? null,
    }))
  }

  return out
}

/**
 * Rank the index for a task: relevance x reliability x latency, the SAME
 * formula capfabric uses for MCP tools — so a skill and an MCP tool competing
 * for attention are compared on one scale instead of two.
 *
 * Relevance still dominates: a capability unrelated to the task cannot win on
 * having a good record. Entries scoring zero relevance are dropped unless
 * `keepIrrelevant` is set (the full-inventory report wants them).
 */
export function rankCapabilities(index = [], task = "", { limit = 0, sources = null, keepIrrelevant = false } = {}) {
  const want = sources ? new Set(sources) : null
  const scored = []
  for (let i = 0; i < (index || []).length; i++) {
    const e = index[i]
    if (!e) continue
    if (want && !want.has(e.source)) continue
    const relevance = scoreAgainst(task, bareToolName(e.name), e.description)
    if (!keepIrrelevant && relevance <= 0) continue
    // One formula for every source. `reliability` is already normalized on the
    // entry (counted for tools, lifecycle-derived for skills), so it is used
    // directly rather than re-derived; the latency term only applies where real
    // timings were recorded, since a skill has no runtime to be slow at.
    const latency = e.evidence === EVIDENCE.COUNTED
      ? latencyFactorOf({ samples: e.samples, ms: e.avgMs * e.samples })
      : 1
    scored.push({ ...e, relevance, rank: (relevance + 0.5) * e.reliability * latency, order: i })
  }
  scored.sort((a, b) => b.rank - a.rank || a.order - b.order)
  return limit > 0 ? scored.slice(0, limit) : scored
}

/** Counts per source — the one-line answer to "what does forge have?". */
export function indexSummary(index = []) {
  const bySource = {}
  for (const e of index || []) {
    if (!e?.source) continue
    bySource[e.source] = (bySource[e.source] ?? 0) + 1
  }
  const proven = (index || []).filter((e) => e?.evidence === EVIDENCE.COUNTED).length
  const inferred = (index || []).filter((e) => e?.evidence === EVIDENCE.LIFECYCLE).length
  return { total: (index || []).length, bySource, proven, inferred }
}

/** Human-readable inventory, grouped by source. Never invents an entry. */
export function formatCapabilityIndex(index = []) {
  if (!index?.length) return "no capabilities indexed"
  const s = indexSummary(index)
  const lines = [`CAPABILITY INDEX — ${s.total} total (${s.proven} with recorded runs, ${s.inferred} by lifecycle)`]
  for (const source of [CAP_SOURCE.NATIVE, CAP_SOURCE.SKILL, CAP_SOURCE.MCP, CAP_SOURCE.CREATED]) {
    const rows = index.filter((e) => e.source === source)
    if (!rows.length) continue
    lines.push(`  ${source} (${rows.length})`)
    for (const e of rows.slice(0, 12)) {
      const ev = e.evidence === EVIDENCE.COUNTED
        ? `${e.samples} run(s), ${Math.round(e.reliability * 100)}% ok`
        : e.evidence === EVIDENCE.LIFECYCLE
          ? `${e.lifecycle}${e.stale ? " (STALE)" : ""}`
          : "no evidence yet"
      lines.push(`    ${e.name}${e.readOnly ? " [read-only]" : ""} — ${ev}`)
    }
    if (rows.length > 12) lines.push(`    … ${rows.length - 12} more`)
  }
  return lines.join("\n")
}

export { isExternal }
