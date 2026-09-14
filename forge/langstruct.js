/**
 * forge — bulk structured extraction (v98 shipwise, zero dependencies)
 *
 * THE wiring the ladder was missing since v93: extractStructured() was real
 * but spawned AND closed one language server per file — fine for a single
 * report, catastrophic for an index. This module is the bulk tier-3 pass:
 *
 *   - ONE LSP session per server (user config + the first-party autostart
 *     table), reused across every file it owns, closed at the end.
 *   - every enriched record carries `symbolDetails: [{name, kind, line}]` and
 *     `extraction: {layer: 3, source: "lsp:<server>"}` — the provenance law:
 *     no consumer can mistake parser output for regex output.
 *   - HONEST degradation per file: a server that fails, times out, or returns
 *     zero symbols leaves the lexical record UNTOUCHED with the reason kept.
 *     Partial enrichment is reportable, never fabricated.
 *   - bounded by an overall time budget + a file cap: a cold rust-analyzer on
 *     a huge repo must never wedge the loop (the client's own 12s per-request
 *     timeout is the per-file bound).
 *   - never throws; callers treat the summary as evidence, not a gate.
 *
 * The sync lexical build stays the floor (records exist and answer queries
 * immediately); enrichment UPGRADES records in the shared incremental index
 * (index.js — never a private cache) so every consumer — world model, repo
 * map, impact, knowgraph — sees structured data through the one choke point.
 */
import fs from "node:fs"
import path from "node:path"
import { serverForFile, connectServer, pathToUri, languageIdForFile } from "./lsp.js"
import { loadIndex, saveIndex, recordFromSource, fingerprint } from "./index.js"

const DEFAULTS = {
  budgetMs: 15000,   // overall pass budget — a full pass on a big repo may exceed one warm window
  maxFiles: 400,     // files per pass (priority order is the CALLER's — we take the front)
  concurrency: 4,    // parallel documentSymbol requests per server (the client serializes by id)
}

/** Which index records are enrichment candidates? Deep languages a server
 *  actually resolves (user config or autostart binary on PATH), not already
 *  structured (layer 3), not natively parsed (layer 1). Accepts either bare
 *  records ({rel, symbols, ...}) or {rel, record} pairs; the returned
 *  candidate carries the record REFERENCE so enrichment mutates the caller's
 *  object (the index's own record), never a copy. Pure function. */
export function enrichmentCandidates(records, { config = null, cwd = process.cwd() } = {}) {
  const out = []
  for (const item of Array.isArray(records) ? records : []) {
    const record = item?.record ?? item
    const rel = item?.rel ?? record?.rel
    if (!rel) continue
    if (record?.extraction?.layer === 3) continue
    if (record?.extraction?.layer === 1) continue
    const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel)
    let found = null
    try { found = serverForFile(config, abs) } catch { found = null }
    if (!found) continue
    out.push({ rel, abs, server: found, record })
  }
  return out
}

/** Run the bounded bulk pass over explicit records. Returns a summary and
 *  mutates nothing the caller did not hand it (the enriched fields are set on
 *  the record objects — callers persist them through their own store). */
export async function enrichRecords(cwd, records, { config = null, budgetMs = DEFAULTS.budgetMs, maxFiles = DEFAULTS.maxFiles, concurrency = DEFAULTS.concurrency } = {}) {
  const base = path.resolve(cwd || process.cwd())
  const candidates = enrichmentCandidates(records, { config, cwd: base }).slice(0, Math.max(0, maxFiles))
  const summary = { considered: candidates.length, enriched: 0, failed: 0, noSymbols: 0, skipped: 0, servers: {}, budgetMs }
  if (!candidates.length) return summary

  // group by server name — one session each
  const byServer = new Map()
  for (const c of candidates) {
    if (!byServer.has(c.server.name)) byServer.set(c.server.name, { spec: c.server.spec, files: [] })
    byServer.get(c.server.name).files.push(c)
  }

  const deadline = Date.now() + Math.max(500, budgetMs)
  for (const [name, group] of byServer) {
    if (Date.now() >= deadline) { summary.skipped += group.files.length; continue }
    let client = null
    try {
      client = await connectServer(name, group.spec, { rootUri: pathToUri(base) })
    } catch (e) {
      summary.servers[name] = { started: false, error: String(e?.message ?? e).slice(0, 160) }
      summary.failed += group.files.length
      continue
    }
    const serverStat = { started: true, enriched: 0, failed: 0, noSymbols: 0 }
    try {
      // bounded fan-out; the client serializes by request id — concurrency
      // only overlaps the server's own processing, it never reorders a file.
      // A2 audit fix: the deadline no longer bumps `skipped` per worker (each
      // concurrent worker seeing the deadline would double-count the tail);
      // the unprocessed remainder is computed ONCE from the cursor afterwards.
      let cursor = 0
      const workers = Array.from({ length: Math.max(1, Math.min(concurrency, group.files.length)) }, async () => {
        while (cursor < group.files.length) {
          if (Date.now() >= deadline) return
          const f = group.files[cursor++]
          try {
            // stat BEFORE read (the walkIndexed law): the fingerprint we stamp
            // reflects the state the parsed content was read at or earlier —
            // a concurrent modification can only make us conservatively stale
            let st = null
            try { st = fs.statSync(f.abs) } catch { summary.skipped++; continue }
            let text = ""
            try { text = fs.readFileSync(f.abs, "utf8") } catch { summary.skipped++; continue }
            const syms = await client.documentSymbols(pathToUri(f.abs), languageIdForFile(f.abs, group.spec), text)
            if (Array.isArray(syms) && syms.length) {
              f.record.symbols = syms.map((s) => s.name).slice(0, 500)
              f.record.symbolDetails = syms.slice(0, 500)
              f.record.extraction = { layer: 3, source: `lsp:${name}` }
              const fp = fingerprint(st)
              f.record.size = fp.size
              f.record.mtime = fp.mtime
              summary.enriched++
              serverStat.enriched++
            } else {
              summary.noSymbols++
              serverStat.noSymbols++
            }
          } catch {
            summary.failed++
            serverStat.failed++
          }
        }
      })
      await Promise.all(workers)
      // A2: the unprocessed tail, counted exactly once across all workers
      const unprocessed = group.files.length - cursor
      if (unprocessed > 0) {
        summary.skipped += unprocessed
        serverStat.skipped = unprocessed
      }
    } finally {
      try { await client.close() } catch { }
    }
    summary.servers[name] = serverStat
  }
  return summary
}

/**
 * Enrich the SHARED incremental index in place. Candidates come from the
 * index (layer-8 deep-language records), results are written back through
 * saveIndex — the same store every consumer reads. Optional `files` filter
 * (relative paths) narrows the pass to exactly the files a segment changed.
 * Never throws; returns the summary.
 */
export async function enrichIndex(cwd, { config = null, files = null, budgetMs = DEFAULTS.budgetMs, maxFiles = DEFAULTS.maxFiles, concurrency = DEFAULTS.concurrency } = {}) {
  const base = path.resolve(cwd || process.cwd())
  let idx = null
  try { idx = loadIndex(base) } catch { return { considered: 0, enriched: 0, failed: 0, noSymbols: 0, skipped: 0, servers: {}, persisted: false } }
  if (!idx.files || typeof idx.files !== "object") idx.files = {}
  const filter = Array.isArray(files) && files.length ? files.map((f) => String(f).replace(/\\/g, "/")) : null
  // PRELOAD: when a file filter is given, ensure its records exist and are
  // FRESH in the shared index first (a segment may have mutated files the
  // index last saw pre-mutation — enriching a stale record would stamp the
  // server's fresh symbols with a stale fingerprint and be silently discarded
  // by the next cacheHit). Stale/missing records are re-extracted through the
  // SAME recordFromSource the index path uses — one extraction semantics.
  let preloaded = 0
  if (filter) {
    for (const rel of filter) {
      const abs = path.join(base, rel)
      let fresh = false
      try {
        const st = fs.statSync(abs)
        const cached = idx.files[rel]
        fresh = Boolean(cached && cached.size === st.size && cached.mtime === Math.round(st.mtimeMs || 0))
        if (!fresh) {
          const src = fs.readFileSync(abs, "utf8")
          const rec = { rel, ...recordFromSource(path.basename(rel), src, abs, st) }
          if (!Array.isArray(rec.contracts)) rec.contracts = []
          idx.files[rel] = rec
          preloaded++
        }
      } catch { /* unreadable file: leave any existing record untouched */ }
    }
  }
  // the record objects are the index's own — enrichment mutates them in
  // place, so the write-back persists exactly what the server produced
  const list = []
  for (const [rel, rec] of Object.entries(idx.files)) {
    if (!rec || typeof rec !== "object") continue
    if (filter && !filter.includes(rel)) continue
    list.push({ rel, record: rec })
  }
  const summary = await enrichRecords(base, list, { config, budgetMs, maxFiles, concurrency })
  summary.preloaded = preloaded
  if (summary.enriched > 0 || preloaded > 0) {
    try { summary.persisted = saveIndex(base, { files: idx.files }) } catch { summary.persisted = false }
  } else {
    summary.persisted = false
  }
  return summary
}
