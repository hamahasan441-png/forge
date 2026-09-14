/**
 * forge — Engineering Memory Core (v94 "masterwise", §11–§18/§30)
 *
 * The layered persistent engineering memory, composed ON TOP of the stores
 * that already exist (memory.md tiers, lessons.json, episodes.json, the
 * world model, sessions, checkpoints) — it duplicates none of them:
 *
 *   L1 HOT       in-process, per run: task, active files, hypothesis,
 *                recent evidence, immediate decisions (never persisted —
 *                hot by definition)
 *   L2 WORKING   per-task session state: plan/DAG/pending live in the
 *                task record (taskstate.js) — this module keeps the
 *                working OBSERVATION stream and the requirement spec
 *                (§18 long-prompt intelligence) durably
 *   L3 PROJECT   memory.md (project tier) + world.json + index.json —
 *                surfaced through retrieval, never re-stored here
 *   L4 EPISODIC  episodes.js (PROBLEM→…→RESULT) — surfaced, not copied
 *   L5 SEMANTIC  lessons.js (reusable engineering knowledge) — surfaced
 *   EVIDENCE     the NEW durable store below: verified facts with full
 *                provenance (memory id, project/conversation/task ids,
 *                source, timestamp, evidence reference, confidence,
 *                freshness, status)
 *
 * Provenance discipline (§12): model output WITHOUT an evidence reference
 * can only ever be OBSERVATION / INFERENCE / HYPOTHESIS. FACT/VERIFIED
 * status requires an evidence reference (a verification record, an
 * observed exit code, a search URL) — unsupported claims are demoted,
 * never promoted.
 *
 * Status lifecycle (§12/§14): observation → verified | rejected;
 * any record touching a changed file becomes stale (POTENTIALLY_STALE →
 * STALE until revalidated); verified knowledge survives as verified,
 * historical on supersession — never silently used while stale.
 *
 * Retrieval (§13): never loads the whole store. Merges this store's
 * records with the project memory pool, lessons and episodes through the
 * shared BM25 ranker (retrieval.rankDocs), dedupes by normalized text,
 * reranks with task/file/symbol/freshness/confidence/evidence bonuses and
 * returns the smallest high-value context. All failures degrade to "no
 * memory" — memory must never break a run.
 *
 * Zero dependencies beyond the existing stores.
 */
import fs from "node:fs"
import path from "node:path"
import { writeStateFile } from "./securefs.js"
import { projectHash, projectDir } from "./memory.js"
import { rankDocs } from "./retrieval.js"
import { filesCited } from "./memgraph.js"
import * as memoryNs from "./memory.js"
import * as lessonsNs from "./lessons.js"
import * as episodesNs from "./episodes.js"

const MAX_RECORDS = 2000
const MAX_OBSERVATIONS = 50
const MAX_TEXT = 500
const MAX_HISTORY = 5
const RETRIEVAL_CACHE_MAX = 64

export const MEM_LAYER = {
  EVIDENCE: "evidence",       // durable verified facts with provenance
  OBSERVATION: "observation", // working-stream records (per task)
  REQUIREMENT: "requirement", // §18 requirement spec entries
}

export const MEM_STATUS = {
  OBSERVATION: "observation",
  INFERENCE: "inference",
  HYPOTHESIS: "hypothesis",
  FACT: "fact",
  VERIFIED: "verified",
  STALE: "stale",
  REJECTED: "rejected",
  HISTORICAL: "historical",
}

/** Statuses that may NEVER be produced from bare model output (§12). */
const EVIDENCE_BACKED = new Set([MEM_STATUS.FACT, MEM_STATUS.VERIFIED])

function storePath(cwd) {
  return path.join(projectDir(cwd), "engmemory.json")
}

export function normalizeMemText(t) {
  return String(t ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160)
}

// ---------------------------------------------------------------------------
// knowledge-graph bridge (v94b, understand-anything pack; v94c "toolwise"
// extracts the PARSER to module level so the kg_query tool and retrieval
// share ONE implementation — never two KG readers)
// ---------------------------------------------------------------------------
// The understand skill writes .ua/knowledge-graph.json (KnowledgeGraph:
// project{languages,frameworks,description}, nodes[{name,type,filePath,
// summary,tags}], edges[], layers[{name}]). Surface its highest-signal
// architecture facts through retrieval so every later task in this project
// starts from the map instead of re-deriving it. mtime-keyed cache, bounded
// output, keyword-gated in retrieval — an unrelated query never pays for it.
const KG_CACHE_MAX = 8
const kgCache = new Map() // abs path -> { sig, at, overview, entries }

/** Locate the project's knowledge-graph file (.ua first, legacy dir second). */
export function knowledgeGraphFile(base) {
  const root = path.resolve(String(base || process.cwd()))
  return [
    path.join(root, ".ua", "knowledge-graph.json"),
    path.join(root, ".understand-anything", "knowledge-graph.json"),
  ].find((p) => { try { return fs.statSync(p).isFile() } catch { return false } }) ?? null
}

/** Parse + cache a knowledge-graph file into bounded, high-signal facts. */
function parseKnowledgeGraph(abs) {
  const raw = JSON.parse(fs.readFileSync(abs, "utf8"))
  if (!raw || !Array.isArray(raw.nodes)) return null
  const proj = raw.project ?? {}
  const overview = []
  const entries = []
  const fw = (proj.frameworks ?? []).slice(0, 5)
  const langs = (proj.languages ?? []).slice(0, 5)
  const kinds = {}
  for (const n of raw.nodes) { const t = String(n?.type ?? "?"); kinds[t] = (kinds[t] ?? 0) + 1 }
  const kindStr = Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, c]) => `${c} ${t}`).join(", ")
  overview.push(`knowledge-graph: ${proj.name ?? path.basename(path.dirname(abs))} — ${fw.length ? `${fw.join(", ")} project` : "project"}${langs.length ? ` (${langs.join(", ")})` : ""}. ${String(proj.description ?? "").slice(0, 200)} Graph: ${raw.nodes.length} nodes, ${(raw.edges ?? []).length} relationships${kindStr ? ` (${kindStr})` : ""}.`)
  const layers = (raw.layers ?? []).filter((l) => l?.name).slice(0, 6)
  if (layers.length) overview.push(`knowledge-graph layers (architecture): ${layers.map((l) => l.name).join(" · ")}.`)
  // hub modules: highest relationship degree (in+out)
  const deg = new Map()
  for (const e of raw.edges ?? []) {
    if (e?.source) deg.set(e.source, (deg.get(e.source) ?? 0) + 1)
    if (e?.target) deg.set(e.target, (deg.get(e.target) ?? 0) + 1)
  }
  const byId = new Map(raw.nodes.map((n) => [n.id, n]))
  const hubs = [...deg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([id, d]) => ({ node: byId.get(id), d })).filter((h) => h.node?.name)
  for (const h of hubs.slice(0, 3)) {
    entries.push({
      text: `knowledge-graph hub: ${h.node.name} (${h.node.type ?? "node"}, ${h.d} relationships) — ${String(h.node.summary ?? "").slice(0, 220)}`,
      files: h.node.filePath ? [String(h.node.filePath)] : [],
    })
  }
  return { at: Date.parse(proj.analyzedAt) || 0, overview, entries }
}

/** Public facts view for the kg_query tool: explicit, not keyword-gated
 *  (the caller ASKED for the graph). Same cache, same parse, bounded. */
export function knowledgeGraphFacts(base) {
  const abs = knowledgeGraphFile(base)
  if (!abs) return { ok: false, note: "no knowledge-graph file (.ua/knowledge-graph.json) — run the understand skill to build one" }
  let st
  try { st = fs.statSync(abs) } catch { return { ok: false, note: "knowledge-graph file disappeared mid-read" } }
  const sig = `${st.mtimeMs}:${st.size}`
  let hit = kgCache.get(abs)
  if (!hit || hit.sig !== sig) {
    let parsed = null
    try { parsed = parseKnowledgeGraph(abs) } catch (e) {
      return { ok: false, note: `knowledge-graph file is unreadable (${String(e?.message ?? e).slice(0, 120)}) — reported honestly, never invented` }
    }
    if (!parsed) return { ok: false, note: "knowledge-graph file has no nodes array — unrecognized shape" }
    if (kgCache.size >= KG_CACHE_MAX) kgCache.clear()
    hit = { sig, ...parsed }
    kgCache.set(abs, hit)
  }
  return { ok: true, file: path.relative(path.resolve(String(base || process.cwd())), abs) || abs, at: hit.at, overview: hit.overview, entries: hit.entries }
}

export function createEngMemory({
  cwd = process.cwd(),
  taskId = null,
  runId = null,
  conversationId = null,
  sessionId = null,
  checkpointId = null,
} = {}) {
  const projectId = projectHash(cwd)
  const conversation = conversationId || `conv-${taskId || "adhoc"}`
  let loaded = false
  let records = []
  let seq = 0
  let generation = 0 // retrieval-cache epoch — bumped on every mutation

  // L1 hot memory (in-process, bounded)
  const hot = { task: "", activeFiles: new Set(), hypothesis: null, recentEvidence: [], decisions: [] }

  // retrieval cache (bounded, generation-invalidated, §15)
  const retrievalCache = new Map()

  function load() {
    if (loaded) return
    loaded = true
    try {
      const raw = JSON.parse(fs.readFileSync(storePath(cwd), "utf8"))
      if (raw && Array.isArray(raw.records)) records = raw.records
    } catch { /* absent or corrupt → empty store (it is a cache of knowledge, never a dependency) */ }
  }

  function persist() {
    try {
      writeStateFile(storePath(cwd), JSON.stringify({ version: 1, records: records.slice(-MAX_RECORDS) }, null, 0))
    } catch { /* memory persistence is best-effort; never break a run */ }
  }

  function bump() {
    generation++
    if (retrievalCache.size) retrievalCache.clear()
  }

  /** One bounded history entry per mutation. */
  function noteHistory(rec, action, note) {
    rec.history = [...(rec.history ?? []), { at: Date.now(), action, note: String(note ?? "").slice(0, 120) }].slice(-MAX_HISTORY)
  }

  /**
   * Record a memory. §12 discipline: a `model`-sourced record without an
   * evidence reference can never be FACT/VERIFIED — it is demoted to
   * HYPOTHESIS and the demotion is recorded.
   */
  function recordMemory({
    text,
    layer = MEM_LAYER.EVIDENCE,
    status = MEM_STATUS.OBSERVATION,
    source = "agent",
    evidenceRef = null,
    confidence = 0.5,
    files = null,
    symbols = null,
    supersededBy = null,
  } = {}) {
    load()
    const t = String(text ?? "").trim()
    if (!t) return null
    const VALID_STATUS = new Set(Object.values(MEM_STATUS))
    let st = VALID_STATUS.has(String(status)) ? String(status) : MEM_STATUS.OBSERVATION
    const hasEvidence = evidenceRef != null
    let demoted = false
    if (EVIDENCE_BACKED.has(st) && (!hasEvidence || source === "model")) {
      // unsupported model output NEVER becomes fact (§12)
      st = MEM_STATUS.HYPOTHESIS
      demoted = true
    }
    const cited = files && files.length ? files : filesCited(t, cwd)
    const rec = {
      id: `mem-${Date.now().toString(36)}-${(++seq).toString(36)}`,
      layer,
      text: t.slice(0, MAX_TEXT),
      status: st,
      projectId,
      conversationId: conversation,
      sessionId,
      taskId,
      checkpointId,
      runId,
      source,
      evidenceRef: hasEvidence ? evidenceRef : null,
      confidence: Math.max(0, Math.min(1, Number(confidence) || 0.5)),
      files: (cited ?? []).slice(0, 12),
      symbols: (symbols ?? []).slice(0, 12),
      at: Date.now(),
      revalidatedAt: null,
      supersededBy,
      history: demoted ? [{ at: Date.now(), action: "demoted", note: "model output without evidence cannot be FACT/VERIFIED" }] : [],
    }
    records.push(rec)
    if (records.length > MAX_RECORDS) {
      // bound: drop oldest STALE/REJECTED/HISTORICAL first, then oldest
      // observations; verified facts and requirements survive longest
      const rank = (r) => (r.layer === MEM_LAYER.REQUIREMENT ? 0 : r.status === MEM_STATUS.VERIFIED || r.status === MEM_STATUS.FACT ? 1 : r.status === MEM_STATUS.STALE || r.status === MEM_STATUS.REJECTED || r.status === MEM_STATUS.HISTORICAL ? 2 : 3)
      const ordered = [...records].sort((a, b) => rank(b) - rank(a) || a.at - b.at)
      records = ordered.slice(records.length - MAX_RECORDS)
    }
    bump()
    persist()
    return rec
  }

  /** §12/§14: promote with evidence (e.g. a verification record landed). */
  function markVerified(id, evidenceRef) {
    load()
    const rec = records.find((r) => r.id === id)
    if (!rec) return null
    if (!evidenceRef) return rec // no evidence → no promotion (never fabricate)
    rec.status = MEM_STATUS.VERIFIED
    rec.evidenceRef = evidenceRef
    rec.confidence = Math.min(1, rec.confidence + 0.2)
    rec.revalidatedAt = Date.now()
    noteHistory(rec, "verified", evidenceRef?.verificationId ?? evidenceRef?.command ?? "evidence")
    bump()
    persist()
    return rec
  }

  function markRejected(id, note) {
    load()
    const rec = records.find((r) => r.id === id)
    if (!rec) return null
    rec.status = MEM_STATUS.REJECTED
    noteHistory(rec, "rejected", note)
    bump()
    persist()
    return rec
  }

  /** §14: CURRENT → POTENTIALLY STALE → REVALIDATE → CURRENT. */
  function revalidate(id, { ok = true, evidenceRef = null } = {}) {
    load()
    const rec = records.find((r) => r.id === id)
    if (!rec) return null
    rec.status = ok ? MEM_STATUS.VERIFIED : MEM_STATUS.REJECTED
    rec.revalidatedAt = Date.now()
    if (evidenceRef) rec.evidenceRef = evidenceRef
    noteHistory(rec, "revalidated", ok ? "current again" : "contradicted by revalidation")
    bump()
    persist()
    return rec
  }

  /**
   * §14 freshness: files changed → every record citing them (directly or
   * through the memgraph citation regex) goes STALE. Never silently used.
   */
  function markFilesChanged(files) {
    load()
    const set = new Set((files ?? []).map((f) => String(f)))
    if (!set.size) return 0
    let n = 0
    for (const rec of records) {
      if (rec.status === MEM_STATUS.STALE || rec.status === MEM_STATUS.REJECTED || rec.status === MEM_STATUS.HISTORICAL) continue
      const touches = (rec.files ?? []).some((f) => set.has(f))
      if (touches) { rec.status = MEM_STATUS.STALE; noteHistory(rec, "stale", "cited file changed"); n++ }
    }
    // hot memory too: active files changed → their evidence is suspect
    for (const f of set) hot.activeFiles.delete(f)
    if (n) { bump(); persist() }
    return n
  }

  /** §11 L1 — hot memory writers (bounded, never persisted). */
  function setTask(t) { hot.task = String(t ?? "").slice(0, 200) }
  function touchFiles(files) { for (const f of (files ?? []).slice(0, 24)) hot.activeFiles.add(String(f)) }
  function setHypothesis(h) { hot.hypothesis = h ? String(h).slice(0, 200) : null }
  function noteEvidence(e) {
    hot.recentEvidence.push(String(e ?? "").slice(0, 200))
    if (hot.recentEvidence.length > 12) hot.recentEvidence.shift()
  }
  function noteDecision(d) {
    hot.decisions.push(String(d ?? "").slice(0, 200))
    if (hot.decisions.length > 12) hot.decisions.shift()
  }

  /** §11 L2 — one bounded working observation per segment. */
  function observeSegment({ segment, status = "ok", files = [], error = null, note = "" } = {}) {
    const parts = [`segment ${segment} ${status}`]
    if (files?.length) parts.push(`files: ${files.slice(0, 6).map((f) => path.basename(String(f))).join(", ")}`)
    if (error) parts.push(`error: ${String(error).slice(0, 120)}`)
    if (note) parts.push(String(note).slice(0, 120))
    touchFiles(files)
    if (error) return recordMemory({ text: parts.join(" — "), layer: MEM_LAYER.OBSERVATION, status: MEM_STATUS.OBSERVATION, source: "agent", files })
    return recordMemory({ text: parts.join(" — "), layer: MEM_LAYER.OBSERVATION, status: MEM_STATUS.OBSERVATION, source: "agent", files, confidence: 0.6 })
  }

  // §18 — long-prompt intelligence: deterministic requirement extraction.
  // Requirements survive compaction because they are RECORDS, retrievable
  // by id, never silently truncated.
  function ingestRequirements(longPrompt) {
    const text = String(longPrompt ?? "")
    if (!text.trim()) return []
    const reqs = []
    const lines = text.split("\n")
    let n = 0
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue
      const numbered = /^(?:\d+[.)]|[-*•])\s+(.{4,300})$/.exec(line)
      const mandatory = /\b(MUST|SHALL|REQUIRED|NEVER|FORBIDDEN|DO NOT|ACCEPTANCE CRITERIA)\b/i.test(line)
      if ((numbered || mandatory) && line.length >= 8 && line.length <= 400) {
        n++
        const r = recordMemory({
          text: `R${n}: ${numbered ? numbered[1] : line}`.slice(0, MAX_TEXT),
          layer: MEM_LAYER.REQUIREMENT,
          status: MEM_STATUS.FACT, // requirements are USER-given facts — legitimate
          source: "user",
          confidence: 0.9,
        })
        if (r) reqs.push(r)
        if (reqs.length >= 40) break // bounded
      }
    }
    return reqs
  }

  function requirementsBlock(query, { limit = 10 } = {}) {
    load()
    const reqs = records.filter((r) => r.layer === MEM_LAYER.REQUIREMENT && r.status !== MEM_STATUS.REJECTED)
    if (!reqs.length) return ""
    let picked = reqs
    if (query) {
      const ranked = rankDocs(query, reqs.map((r, i) => ({ text: r.text, idx: i })), {})
      picked = ranked
        .map((d) => ({ r: reqs[d.idx], s: d.score ?? 0 }))
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map((x) => x.r)
    } else picked = reqs.slice(-limit)
    return `--- requirements (do not silently drop any) ---\n${picked.map((r) => r.text).join("\n")}`.slice(0, 1600)
  }

  /** v96 unifywise: the raw REQUIREMENT records (id/text/files), for the
   *  completion gate's requirement-coverage check (§9 traceability). Bounded
   *  to the ingest cap; STALE requirements are still requirements (staleness
   *  is about the files they cite, not their existence). */
  function requirementRecords() {
    load()
    return records
      .filter((r) => r.layer === MEM_LAYER.REQUIREMENT && r.status !== MEM_STATUS.REJECTED)
      .slice(-40)
      .map((r) => ({ id: r.id, text: r.text, files: r.files ?? [] }))
  }

  /**
   * §13 fast retrieval: merge → dedupe → rerank → smallest high-value
   * context. Composes this store with the project memory pool, lessons and
   * episodes; every source failure degrades independently.
   */
  function retrieve({ query, limit = 8, includeStale = false, includeHistorical = false } = {}) {
    const q = String(query ?? "").trim()
    if (!q) return []
    const cacheKey = `${normalizeMemText(q)}|${limit}|${includeStale ? 1 : 0}`
    const cached = retrievalCache.get(cacheKey)
    if (cached && cached.generation === generation) return cached.results

    const candidates = []
    // this store (evidence + observations + requirements)
    try {
      load()
      for (const r of records) {
        if (!includeStale && r.status === MEM_STATUS.STALE) continue
        if (!includeHistorical && r.status === MEM_STATUS.HISTORICAL) continue
        if (r.status === MEM_STATUS.REJECTED) continue
        candidates.push({ text: r.text, layer: r.layer, status: r.status, source: r.source, confidence: r.confidence, at: r.at, files: r.files ?? [], evidence: r.evidenceRef != null, rec: r, taskId: r.taskId ?? null, conversationId: r.conversationId ?? null })
      }
    } catch { }
    // L3 project memory pool (BM25-ranked by the memory module itself)
    try {
      const mem = relevantMemoryLocal(q)
      for (const m of mem) candidates.push({ text: m.l ?? m.text ?? String(m), layer: "L3", status: "memory", source: m.provenance?.source ?? "memory", confidence: 0.6, at: m.provenance?.at ? Date.parse(m.provenance.at) || 0 : 0, files: [], evidence: false, rec: null })
    } catch { }
    // L5 semantic lessons
    try {
      const les = relevantLessonsLocal(q)
      for (const l of les) candidates.push({ text: `[lesson] ${l.failure ?? l.rootCause ?? l.id}: ${l.solution ?? ""}`.slice(0, MAX_TEXT), layer: "L5", status: l.confidence <= 0.15 ? "retired" : "lesson", source: "lesson", confidence: l.confidence ?? 0.5, at: l.lastUsed ?? l.at ?? 0, files: l.files ?? [], evidence: false, rec: null })
    } catch { }
    // L4 episodic
    try {
      const eps = episodesLocal(q)
      for (const e of eps) candidates.push({ text: `[episode] ${e.problem ?? e.id}${e.lesson ? ` — ${e.lesson}` : ""}`.slice(0, MAX_TEXT), layer: "L4", status: e.result ?? "episode", source: "episode", confidence: 0.6, at: e.updated_at ?? 0, files: e.files ?? [], evidence: false, rec: null })
    } catch { }
    // v94b: knowledge-graph candidates (the bundled understand-anything pack's
    // .ua/knowledge-graph.json). Architecture facts — frameworks, layers, hub
    // modules — join retrieval as L3-style records, keyword-gated, mtime-
    // cached, provenance-tagged as source "knowledge-graph". Never FACT:
    // the graph is derived analysis, not verified evidence.
    try {
      for (const kg of knowledgeGraphLocal(q)) {
        candidates.push({ text: kg.text, layer: "L3", status: "memory", source: "knowledge-graph", confidence: 0.55, at: kg.at, files: kg.files ?? [], evidence: false, rec: null })
      }
    } catch { }

    // dedupe by normalized text (keep the strongest)
    const byKey = new Map()
    for (const c of candidates) {
      const k = normalizeMemText(c.text)
      if (!k) continue
      const prev = byKey.get(k)
      if (!prev || c.confidence > prev.confidence || (c.evidence && !prev.evidence)) byKey.set(k, c)
    }
    const deduped = [...byKey.values()]

    // BM25 base + deterministic bonuses (§13 ranking factors)
    const docs = deduped.map((c, i) => ({ text: c.text, idx: i }))
    const ranked = rankDocs(q, docs, {})
    const qWords = new Set(normalizeMemText(q).split(" "))
    const now = Date.now()
    const scored = deduped.map((c, i) => {
      let s = ranked.find((d) => d.idx === i)?.score ?? 0
      if (c.rec && c.taskId === taskId) s += 0.4                       // task relevance
      if (c.rec && c.conversationId === conversation) s += 0.15        // conversation relevance
      if ((c.files ?? []).some((f) => qWords.has(String(f).toLowerCase()))) s += 0.3
      if (c.evidence) s += 0.35                                        // evidence strength
      s += (Number(c.confidence) || 0) * 0.3                           // confidence
      if (c.status === MEM_STATUS.VERIFIED || c.status === MEM_STATUS.FACT) s += 0.4
      if (c.layer === MEM_LAYER.REQUIREMENT) s += 0.5                  // requirements first-class
      const ageDays = c.at ? (now - c.at) / 86400000 : 30
      s += Math.max(-0.2, 0.2 - ageDays * 0.01)                        // freshness decay
      return { ...c, score: s }
    })
    scored.sort((a, b) => b.score - a.score)
    const results = scored.slice(0, limit)
    if (retrievalCache.size >= RETRIEVAL_CACHE_MAX) retrievalCache.clear()
    retrievalCache.set(cacheKey, { generation, results })
    return results
  }

  /** bounded render for prompts (§13: smallest high-value context) */
  function retrievalBlock(query, { limit = 6, maxChars = 1200 } = {}) {
    const results = retrieve({ query, limit })
    if (!results.length) return ""
    const lines = results.map((r) => {
      const tag = r.rec ? `${r.status}${r.evidence ? "+evidence" : ""}` : r.status
      return `- (${tag}) ${r.text}`
    })
    let out = `--- engineering memory (ranked, provenance-tagged) ---\n${lines.join("\n")}`
    if (out.length > maxChars) out = out.slice(0, maxChars)
    return out
  }

  // --- store adapters (direct namespace references) ---------------------------
  function relevantMemoryLocal(q) {
    // memory.js relevantMemory returns the FORMATTED BLOCK (already BM25-
    // ranked, deduped, capped): bullets "- note" with provenance comments
    // excluded. Parse the bullets — they ARE the ranked L3 shortlist.
    const out = memoryNs.relevantMemory(q, { cwd, limit: 6 })
    if (typeof out !== "string" || !out.trim()) return Array.isArray(out) ? out : []
    return out.split("\n")
      .filter((l) => l.trim().startsWith("- "))
      .map((l) => ({ l: l.replace(/^\s*-\s*/, "").trim().slice(0, 240), provenance: { source: "memory" } }))
  }
  function relevantLessonsLocal(q) {
    return lessonsNs.relevantLessons(q, { cwd, limit: 3 })
  }
  function episodesLocal(q) {
    try {
      const store = episodesNs.createEpisodeStore({ cwd })
      return store.similar(q, { limit: 3 }) ?? []
    } catch { return [] }
  }

  // --- knowledge-graph bridge (v94b; parser shared with kg_query above) ------

  function knowledgeGraphLocal(q) {
    const base = cwd
    const abs = knowledgeGraphFile(base)
    if (!abs) return []
    const qWords = normalizeMemText(q).split(" ").filter((w) => w.length >= 2)
    if (!qWords.length) return []
    let st
    try { st = fs.statSync(abs) } catch { return [] }
    const sig = `${st.mtimeMs}:${st.size}`
    let hit = kgCache.get(abs)
    if (!hit || hit.sig !== sig) {
      let parsed = null
      try { parsed = parseKnowledgeGraph(abs) } catch { return [] }
      if (!parsed) return []
      if (kgCache.size >= KG_CACHE_MAX) kgCache.clear()
      hit = { sig, ...parsed }
      kgCache.set(abs, hit)
    }
    const blob = (t) => normalizeMemText(t)
    const relevant = (text, files) => {
      const hay = `${blob(text)} ${(files ?? []).join(" ").toLowerCase()}`
      return qWords.some((w) => hay.includes(w))
    }
    const out = []
    for (const text of hit.overview) if (relevant(text)) out.push({ text: String(text).slice(0, MAX_TEXT), files: [], at: hit.at })
    for (const e of hit.entries) if (relevant(e.text, e.files)) out.push({ text: String(e.text).slice(0, MAX_TEXT), files: (e.files ?? []).slice(0, 3), at: hit.at })
    return out.slice(0, 4)
  }

  /**
   * §16 consolidation: raw events → observations → verified facts → lessons.
   * Dedupes identical texts (merging provenance), detects contradictions
   * (same subject, verified vs rejected), preserves evidence references.
   */
  function consolidate() {
    load()
    const byKey = new Map()
    let merged = 0
    let contradictions = 0
    for (const rec of records) {
      const k = normalizeMemText(rec.text)
      if (!k) continue
      const prev = byKey.get(k)
      if (!prev) { byKey.set(k, rec); continue }
      merged++
      // merge: keep the stronger record, preserve the other's provenance
      const keep = (rec.status === MEM_STATUS.VERIFIED || rec.status === MEM_STATUS.FACT) && !(prev.status === MEM_STATUS.VERIFIED || prev.status === MEM_STATUS.FACT) ? rec : prev
      const drop = keep === rec ? prev : rec
      keep.confidence = Math.min(1, Math.max(keep.confidence, drop.confidence) + 0.05)
      keep.files = [...new Set([...(keep.files ?? []), ...(drop.files ?? [])])].slice(0, 12)
      noteHistory(keep, "consolidated", `merged with ${drop.id}`)
      drop.status = MEM_STATUS.HISTORICAL
      drop.supersededBy = keep.id
    }
    // contradiction detection: same subject (first 5 normalized words),
    // one VERIFIED and one REJECTED → both get a history note, verified wins
    const subjects = new Map()
    for (const rec of records) {
      if (rec.status !== MEM_STATUS.VERIFIED && rec.status !== MEM_STATUS.REJECTED) continue
      const subj = normalizeMemText(rec.text).split(" ").slice(0, 5).join(" ")
      if (!subj) continue
      const arr = subjects.get(subj) ?? []
      arr.push(rec)
      subjects.set(subj, arr)
    }
    for (const arr of subjects.values()) {
      if (arr.length < 2) continue
      const verified = arr.find((r) => r.status === MEM_STATUS.VERIFIED)
      const rejected = arr.find((r) => r.status === MEM_STATUS.REJECTED)
      if (verified && rejected) {
        contradictions++
        noteHistory(verified, "contradiction", `rejected claim ${rejected.id} superseded`)
      }
    }
    if (merged || contradictions) { bump(); persist() }
    return { merged, contradictions, total: records.length }
  }

  /** §17 conversation continuity: what does this conversation remember? */
  function conversationContext() {
    load()
    const recs = records.filter((r) => r.conversationId === conversation && r.layer !== MEM_LAYER.OBSERVATION).slice(-8)
    return {
      conversationId: conversation,
      taskId,
      sessionId,
      checkpointId,
      records: recs.map((r) => ({ id: r.id, text: r.text, status: r.status, at: r.at })),
    }
  }

  function rememberCheckpoint(cpId) {
    load()
    checkpointId = cpId
    if (!cpId) return
    const last = records[records.length - 1]
    if (last) { last.checkpointId = cpId; persist() }
  }

  /** §16 hook after verified completion: verified facts enter evidence memory. */
  function onTaskCompleted({ verification = null, files = [], summary = "" } = {}) {
    load()
    if (summary) {
      recordMemory({
        text: `completed task ${taskId}: ${summary}`.slice(0, MAX_TEXT),
        layer: MEM_LAYER.EVIDENCE,
        status: MEM_STATUS.VERIFIED,
        source: "verification",
        evidenceRef: { kind: "completion", verificationId: verification?.verification_id ?? null, files: files.slice(0, 8) },
        confidence: 0.8,
        files,
      })
    }
    return consolidate()
  }

  function stats() {
    load()
    const byStatus = {}
    for (const r of records) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    return { total: records.length, byStatus, generation, hotFiles: hot.activeFiles.size }
  }

  return {
    recordMemory, markVerified, markRejected, revalidate, markFilesChanged,
    setTask, touchFiles, setHypothesis, noteEvidence, noteDecision,
    observeSegment, ingestRequirements, requirementsBlock, requirementRecords,
    retrieve, retrievalBlock, consolidate, conversationContext,
    rememberCheckpoint, onTaskCompleted, stats,
    _introspect: () => ({ records, projectId, conversation, hot, generation }),
  }
}
