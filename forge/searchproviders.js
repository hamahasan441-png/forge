/**
 * forge — adaptive multi-provider web search (v94 "masterwise", §3/§4)
 *
 * Before this module the web_search tool hard-coded exactly two backends
 * (the user's configured endpoint and a DuckDuckGo Lite scrape). A provider
 * failure silently fell through to the next one with no diagnosis, no
 * history, no cache, and Firecrawl did not exist anywhere in the repo.
 *
 * This module is the search intelligence layer of the Engineering
 * Intelligence Core:
 *
 *   SEARCH DECISION
 *     → provider catalog (generic endpoint / Firecrawl / DuckDuckGo)
 *     → adaptive provider order (latency, availability, historical success)
 *     → TTL cache on the normalized query (freshness-bounded)
 *     → execute → parse → dedupe → rank (BM25 over title+snippet)
 *     → SEARCH_FAILED → DIAGNOSE → next provider → REPORT REAL RESULT
 *
 * Hard contracts (inherited from the web_search tool, never weakened):
 *   - every request goes through netguard.pinnedFetch (DNS pinning, SSRF
 *     bounds, redirect validation) — never the global fetch
 *   - failures are honest ERROR strings; results are NEVER fabricated;
 *     `tried[]` is always disclosed
 *   - the configured searchUrl endpoint is USER config, never project
 *     config and never model-controlled (v21 exfil rule)
 *   - provider keys come from the environment (same discipline as the
 *     LLM provider CATALOG in providers.js)
 *
 * Zero dependencies: node:fs + node:path + netguard.js + retrieval.js.
 */
import fs from "node:fs"
import path from "node:path"
import { pinnedFetch, PinnedFetchError } from "./netguard.js"
import { rankDocs } from "./retrieval.js"
import { DEFAULT_DIR } from "./config.js"

const VERSION = "94.0.0"
const UA = `forge-agent/${VERSION}`
/** Forge-owned cache root (same discipline as the embeddings cache). */
const CACHE_ROOT = path.join(DEFAULT_DIR, "cache")

// ---------------------------------------------------------------------------
// Provider catalog — mirrors the shape of providers.js CATALOG (declarative,
// env-key driven, "available when its key is present / config set").
// ---------------------------------------------------------------------------

export const SEARCH_PROVIDERS = [
  {
    name: "generic",
    description: "the user's configured search endpoint (tools.searchUrl)",
    /** available only when the user actually configured an endpoint */
    available: (ctx) => Boolean(ctx.searchUrl),
    priority: 10, // the user explicitly chose this — always tried first
  },
  {
    name: "firecrawl",
    description: "Firecrawl search API (FIRECRAWL_API_KEY)",
    available: () => Boolean(firecrawlKey()),
    priority: 8, // first-class provider when configured
  },
  {
    name: "duckduckgo",
    description: "DuckDuckGo Lite HTML scrape (zero-config fallback)",
    available: () => true,
    priority: 2, // always exists, ranked last unless it proves reliable
  },
]

/** Firecrawl API key — environment only (never project config, never model output). */
export function firecrawlKey() {
  return String(process.env.FIRECRAWL_API_KEY || process.env.FIRECRAWL_KEY || "").trim() || null
}

/** Firecrawl base URL — read per call so tests/ops can point it at a mock. */
export function firecrawlBase() {
  return String(process.env.FIRECRAWL_BASE_URL || "https://api.firecrawl.dev").replace(/\/+$/, "")
}

// ---------------------------------------------------------------------------
// Provider history — persisted stats feed the adaptive ordering
// (latency, availability, historical success). Bounded, honest, optional:
// an unreadable stats file degrades to catalog priority, never to failure.
// ---------------------------------------------------------------------------

const STATS_MAX_PROVIDERS = 16

function statsPath() {
  try { return path.join(CACHE_ROOT, "search-stats.json") } catch { return null }
}

export function providerStats() {
  try {
    const raw = JSON.parse(fs.readFileSync(statsPath(), "utf8"))
    return raw && typeof raw === "object" && raw.providers ? raw.providers : {}
  } catch { return {} }
}

function saveStats(providers) {
  try {
    const p = statsPath()
    if (!p) return
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const tmp = p + ".tmp"
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, providers }, null, 0), { mode: 0o600 })
    fs.renameSync(tmp, p)
  } catch { /* stats are advisory — never fail a search for them */ }
}

/** Record one provider attempt (ok/fail + latency). Bounded, best-effort. */
export function recordProviderOutcome(name, ok, latencyMs, error = null) {
  try {
    const all = providerStats()
    const cur = all[name] || { ok: 0, fail: 0, latencyEwmaMs: null, lastError: null, lastUsed: 0 }
    if (ok) cur.ok += 1
    else { cur.fail += 1; cur.lastError = String(error ?? "failed").slice(0, 200) }
    cur.lastUsed = Date.now()
    cur.latencyEwmaMs = cur.latencyEwmaMs == null
      ? Math.round(latencyMs)
      : Math.round(cur.latencyEwmaMs * 0.7 + latencyMs * 0.3)
    const entries = Object.entries(all)
    if (entries.length >= STATS_MAX_PROVIDERS) {
      // drop the least-recently-used tracked provider to stay bounded
      entries.sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0))
      for (let i = 0; i < entries.length - STATS_MAX_PROVIDERS + 1; i++) delete all[entries[i][0]]
    }
    all[name] = cur
    saveStats(all)
  } catch { /* advisory */ }
}

/**
 * Adaptive provider order (§3): available providers sorted by
 *   primary: catalog priority (user intent)
 *   adjust:  historical success rate (≥3 samples), latency penalty,
 *            last-error penalty for the immediately previous failure.
 * Deterministic for identical history. Never throws.
 */
export function providerOrder(ctx) {
  const stats = providerStats()
  const scored = SEARCH_PROVIDERS
    .filter((p) => { try { return p.available(ctx) } catch { return false } })
    .map((p) => {
      const s = stats[p.name] || {}
      const total = (s.ok || 0) + (s.fail || 0)
      let score = p.priority
      let why = "catalog priority"
      if (total >= 3) {
        const rate = (s.ok || 0) / total
        score += rate * 6 - 3 // ∈ [-3, +3] — history can reorder but not fake availability
        why = `history ${(s.ok || 0)}/${total} ok`
      }
      if (typeof s.latencyEwmaMs === "number") {
        if (s.latencyEwmaMs > 8000) { score -= 1.5; why += ", slow (ewma)" }
        else if (s.latencyEwmaMs < 2500) { score += 0.5; why += ", fast (ewma)" }
      }
      return { name: p.name, score, why, provider: p }
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return scored
}

// ---------------------------------------------------------------------------
// Normalized-query TTL cache (§4): simple searches must not re-hit the
// network. Bounded entry count; TTL defaults to 30 min; the cache is a
// speedup, never a correctness dependency (corrupt file ⇒ empty cache).
// NOTE: the toolintel NON_CACHEABLE list still excludes web_search — that
// list governs the run-scoped tool cache; this is a cross-run, TTL-bounded,
// explicitly-attributed search cache. Cached answers say so.
// ---------------------------------------------------------------------------

const CACHE_FILE = "search-cache.json"
const CACHE_MAX_ENTRIES = 200
export const DEFAULT_TTL_MS = 30 * 60 * 1000

export function normalizeQuery(q) {
  return String(q ?? "")
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .sort()
    .join(" ")
    .slice(0, 240)
}

function cacheFilePath() {
  try { return path.join(CACHE_ROOT, CACHE_FILE) } catch { return null }
}

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFilePath(), "utf8"))
    if (!raw || raw.version !== 1 || !raw.entries || typeof raw.entries !== "object") return {}
    return raw.entries
  } catch { return {} }
}

function writeCache(entries) {
  try {
    const p = cacheFilePath()
    if (!p) return
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const tmp = p + ".tmp"
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 0), { mode: 0o600 })
    fs.renameSync(tmp, p)
  } catch { /* cache is best-effort */ }
}

export function cacheGet(query, { ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  const key = normalizeQuery(query)
  if (!key) return null
  const entries = readCache()
  const hit = entries[key]
  if (!hit || !Array.isArray(hit.results)) return null
  const ageMs = now - (hit.at || 0)
  if (ageMs > ttlMs) return null // stale — caller should search again (§30 freshness)
  return { ...hit, ageSec: Math.max(0, Math.round(ageMs / 1000)) }
}

export function cachePut(query, { results, provider, now = Date.now() } = {}) {
  const key = normalizeQuery(query)
  if (!key || !Array.isArray(results) || !results.length) return
  const entries = readCache()
  entries[key] = { results, provider, at: now }
  const keys = Object.keys(entries)
  if (keys.length > CACHE_MAX_ENTRIES) {
    keys.sort((a, b) => (entries[a].at || 0) - (entries[b].at || 0))
    for (let i = 0; i < keys.length - CACHE_MAX_ENTRIES; i++) delete entries[keys[i]]
  }
  writeCache(entries)
}

export function cacheClear() {
  try { fs.rmSync(cacheFilePath(), { force: true }) } catch {}
}

// ---------------------------------------------------------------------------
// Providers — each returns { results: [{title,url,snippet}] } or THROWS a
// ProviderFailure with a short machine-readable diagnosis. All network I/O
// goes through pinnedFetch with the same bounds the tool always enforced.
// ---------------------------------------------------------------------------

export class ProviderFailure extends Error {
  constructor(code, message) {
    super(message)
    this.name = "ProviderFailure"
    this.code = code // ETIMEOUT | EHTTP | EPARSE | EBLOCKED | ECONFIG
  }
}

function searchFetch(url, headers, allowPrivate, signal) {
  return pinnedFetch(url, {
    headers, timeoutMs: 12000, totalTimeoutMs: 15000,
    maxBytes: 1024 * 1024, maxRedirects: 3, allowPrivate, signal,
  })
}

function stripTags(html) {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .trim()
}

/** Provider: the user's configured endpoint (SearXNG-style JSON or generic HTML). */
async function genericSearch(ctx, query, max) {
  if (!ctx.searchUrl) throw new ProviderFailure("ECONFIG", "no searchUrl configured")
  const url = ctx.searchUrl + (ctx.searchUrl.includes("?") ? "&" : "?") + "q=" + encodeURIComponent(query)
  let res
  try {
    res = await searchFetch(url, { "user-agent": UA, accept: "application/json,text/html;q=0.8" }, ctx.fetchPrivateUrls === true ? true : "first-hop", ctx.signal)
  } catch (e) {
    if (e instanceof PinnedFetchError && e.blocked) throw new ProviderFailure("EBLOCKED", e.message)
    if (e instanceof PinnedFetchError && e.code === "ETIMEDOUT") throw new ProviderFailure("ETIMEOUT", "endpoint timed out")
    throw new ProviderFailure("ETIMEOUT", String(e?.message ?? e).slice(0, 160))
  }
  if (!res.ok) throw new ProviderFailure("EHTTP", `HTTP ${res.status}`)
  const ct = String(res.headers["content-type"] || "")
  const body = res.body.toString("utf8")
  const results = []
  if (/json/i.test(ct)) {
    let j
    try { j = JSON.parse(body) } catch { throw new ProviderFailure("EPARSE", "invalid JSON from endpoint") }
    for (const r of (j.results ?? j ?? [])) {
      if (!r || typeof r !== "object") continue
      const u = String(r.url ?? r.href ?? "")
      if (!/^https?:\/\//i.test(u)) continue
      results.push({ title: stripTags(String(r.title ?? r.name ?? "")).slice(0, 200), url: u, snippet: stripTags(String(r.content ?? r.snippet ?? r.body ?? "")).slice(0, 220) })
      if (results.length >= max) break
    }
  } else {
    const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let m
    while ((m = re.exec(body)) && results.length < max) {
      const href = m[1]
      if (/duckduckgo|google\./i.test(href)) continue
      results.push({ title: stripTags(m[2]).slice(0, 120), url: href, snippet: "" })
    }
  }
  if (!results.length) throw new ProviderFailure("EPARSE", "endpoint returned no usable results")
  return { results, url }
}

/** Provider: Firecrawl Search (first-class when FIRECRAWL_API_KEY is set). */
export async function firecrawlSearch(query, { max = 6, signal } = {}) {
  const key = firecrawlKey()
  if (!key) throw new ProviderFailure("ECONFIG", "FIRECRAWL_API_KEY not set")
  let res
  try {
    res = await pinnedFetch(`${firecrawlBase()}/v1/search`, {
      method: "POST",
      headers: { "user-agent": UA, authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ query, limit: max }),
      timeoutMs: 15000, totalTimeoutMs: 20000, maxBytes: 1024 * 1024, maxRedirects: 2,
      allowPrivate: "first-hop", // operator-configured base (like tools.searchUrl); redirect hops stay strict
      signal,
    })
  } catch (e) {
    if (e instanceof PinnedFetchError && e.blocked) throw new ProviderFailure("EBLOCKED", e.message)
    if (e instanceof PinnedFetchError && e.code === "ETIMEDOUT") throw new ProviderFailure("ETIMEOUT", "firecrawl timed out")
    throw new ProviderFailure("ETIMEOUT", String(e?.message ?? e).slice(0, 160))
  }
  if (!res.ok) throw new ProviderFailure("EHTTP", `firecrawl HTTP ${res.status}`)
  let j
  try { j = JSON.parse(res.body.toString("utf8")) } catch { throw new ProviderFailure("EPARSE", "firecrawl returned invalid JSON") }
  if (j?.error) throw new ProviderFailure("EHTTP", `firecrawl error: ${String(j.error).slice(0, 120)}`)
  const rows = j?.data ?? j?.results ?? []
  const results = []
  for (const r of rows) {
    if (!r || typeof r !== "object") continue
    const u = String(r.url ?? r.sourceURL ?? "")
    if (!/^https?:\/\//i.test(u)) continue
    results.push({
      title: stripTags(String(r.title ?? "")).slice(0, 200),
      url: u,
      snippet: stripTags(String(r.description ?? r.markdown ?? "")).slice(0, 220),
    })
    if (results.length >= max) break
  }
  if (!results.length) throw new ProviderFailure("EPARSE", "firecrawl returned no results")
  return { results, url: `${firecrawlBase()}/v1/search` }
}

/** Provider: Firecrawl Scrape — one URL to clean markdown (used when a real page body is needed). */
export async function firecrawlScrape(url, { signal } = {}) {
  const key = firecrawlKey()
  if (!key) throw new ProviderFailure("ECONFIG", "FIRECRAWL_API_KEY not set")
  if (!/^https?:\/\//i.test(String(url))) throw new ProviderFailure("ECONFIG", "absolute http(s) URL required")
  let res
  try {
    res = await pinnedFetch(`${firecrawlBase()}/v1/scrape`, {
      method: "POST",
      headers: { "user-agent": UA, authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"] }),
      timeoutMs: 20000, totalTimeoutMs: 30000, maxBytes: 2 * 1024 * 1024, maxRedirects: 2,
      allowPrivate: "first-hop",
      signal,
    })
  } catch (e) {
    if (e instanceof PinnedFetchError && e.code === "ETIMEDOUT") throw new ProviderFailure("ETIMEOUT", "firecrawl scrape timed out")
    throw new ProviderFailure("ETIMEOUT", String(e?.message ?? e).slice(0, 160))
  }
  if (!res.ok) throw new ProviderFailure("EHTTP", `firecrawl scrape HTTP ${res.status}`)
  let j
  try { j = JSON.parse(res.body.toString("utf8")) } catch { throw new ProviderFailure("EPARSE", "firecrawl scrape returned invalid JSON") }
  const md = String(j?.data?.markdown ?? "")
  if (!md) throw new ProviderFailure("EPARSE", "firecrawl scrape returned no content")
  return { url, markdown: md }
}

/**
 * Provider: Firecrawl Crawl — multi-page crawl of a site section. Kicks off
 * the job and polls the bounded number of times; only completed jobs return
 * documents. "When actually needed": the caller decides; this module never
 * crawls on its own initiative (§4 selective retrieval).
 */
export async function firecrawlCrawl(url, { limit = 10, pollMs = 2000, maxPolls = 10, signal } = {}) {
  const key = firecrawlKey()
  if (!key) throw new ProviderFailure("ECONFIG", "FIRECRAWL_API_KEY not set")
  if (!/^https?:\/\//i.test(String(url))) throw new ProviderFailure("ECONFIG", "absolute http(s) URL required")
  let start
  try {
    start = await pinnedFetch(`${firecrawlBase()}/v1/crawl`, {
      method: "POST",
      headers: { "user-agent": UA, authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ url, limit, scrapeOptions: { formats: ["markdown"] } }),
      timeoutMs: 15000, totalTimeoutMs: 20000, maxBytes: 1024 * 1024, maxRedirects: 2,
      allowPrivate: "first-hop",
      signal,
    })
  } catch (e) {
    throw new ProviderFailure("ETIMEOUT", String(e?.message ?? e).slice(0, 160))
  }
  if (!start.ok) throw new ProviderFailure("EHTTP", `firecrawl crawl HTTP ${start.status}`)
  let job
  try { job = JSON.parse(start.body.toString("utf8")) } catch { throw new ProviderFailure("EPARSE", "crawl start returned invalid JSON") }
  const jobId = String(job?.id ?? "")
  if (!jobId) throw new ProviderFailure("EPARSE", "crawl job has no id")
  for (let i = 0; i < maxPolls; i++) {
    if (signal?.aborted) throw new ProviderFailure("EBLOCKED", "cancelled")
    await new Promise((r) => setTimeout(r, pollMs))
    let poll
    try {
      poll = await pinnedFetch(`${firecrawlBase()}/v1/crawl/${encodeURIComponent(jobId)}`, {
        headers: { "user-agent": UA, authorization: `Bearer ${key}` },
        timeoutMs: 12000, totalTimeoutMs: 15000, maxBytes: 4 * 1024 * 1024, maxRedirects: 2,
        allowPrivate: "first-hop",
        signal,
      })
    } catch (e) { throw new ProviderFailure("ETIMEOUT", String(e?.message ?? e).slice(0, 160)) }
    if (!poll.ok) throw new ProviderFailure("EHTTP", `crawl status HTTP ${poll.status}`)
    let st
    try { st = JSON.parse(poll.body.toString("utf8")) } catch { throw new ProviderFailure("EPARSE", "crawl status invalid JSON") }
    if (st?.success === false && st?.error) throw new ProviderFailure("EHTTP", `crawl failed: ${String(st.error).slice(0, 120)}`)
    if (st?.status === "completed" || st?.completed === true) {
      const docs = (st?.data ?? []).map((d) => ({ url: String(d?.metadata?.sourceURL ?? d?.metadata?.url ?? d?.url ?? ""), title: stripTags(String(d?.metadata?.title ?? "")).slice(0, 200), markdown: String(d?.markdown ?? "") })).filter((d) => d.url)
      return { url, documents: docs, status: "completed" }
    }
  }
  return { url, documents: [], status: "in_progress", jobId } // honest: not done yet
}

/** Provider: DuckDuckGo Lite (zero-config fallback). */
async function duckduckgoSearch(ctx, query, max) {
  const url = "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query)
  const res = await searchFetch(url, { "user-agent": `Mozilla/5.0 (X11; Linux x86_64) forge/${VERSION}` }, ctx.fetchPrivateUrls === true, ctx.signal)
  if (!res.ok) throw new ProviderFailure("EHTTP", "HTTP " + res.status)
  const body = res.body.toString("utf8")
  const results = []
  const re = /<a[^>]+href="([^"]+)"[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(body)) && results.length < max) results.push({ title: stripTags(m[2]).slice(0, 120), url: m[1], snippet: "" })
  if (!results.length) {
    const re2 = /<a[^>]+rel="nofollow"[^>]+href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    while ((m = re2.exec(body)) && results.length < max) {
      if (/duckduckgo\.com/i.test(m[1])) continue
      results.push({ title: stripTags(m[2]).slice(0, 120), url: m[1], snippet: "" })
    }
  }
  if (!results.length) throw new ProviderFailure("EPARSE", "no results")
  return { results, url }
}

const PROVIDER_FNS = {
  generic: genericSearch,
  firecrawl: (ctx, q, max) => firecrawlSearch(q, { max, signal: ctx.signal }),
  duckduckgo: duckduckgoSearch,
}

// ---------------------------------------------------------------------------
// Normalization + dedup + ranking (§3): same URL twice is one result; the
// BM25 ranker (retrieval.js — the repo's standard ranker) orders by real
// query relevance over title+snippet. Deterministic, zero model calls.
// ---------------------------------------------------------------------------

export function dedupeResults(results) {
  const seen = new Set()
  const out = []
  for (const r of results) {
    if (!r || typeof r !== "object") continue
    let u = String(r.url || "")
    if (!/^https?:\/\//i.test(u)) continue
    try {
      const p = new URL(u)
      p.hash = ""
      p.hostname = p.hostname.toLowerCase().replace(/^www\./, "")
      if (p.pathname !== "/" && p.pathname.endsWith("/")) p.pathname = p.pathname.slice(0, -1)
      u = p.toString()
    } catch { continue }
    const k = u.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ ...r, url: u })
  }
  return out
}

export function rankResults(query, results, max) {
  // rankDocs returns a NEW array sorted by score — pair scores back by
  // identity (idx), never by position, or the ranking silently no-ops.
  const docs = results.map((r, i) => ({ text: `${r.title ?? ""} ${r.snippet ?? ""}`, idx: i }))
  const ranked = rankDocs(query, docs, {})
  return ranked
    .map((d) => ({ ...results[d.idx], score: d.score ?? 0 }))
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
    .slice(0, max)
}

// ---------------------------------------------------------------------------
// The adaptive search entrypoint (§3): cache → provider order → execute →
// diagnose → fallback → honest result. Never throws.
// ---------------------------------------------------------------------------

/**
 * @returns {{ok:true, results, provider, via, cached?:boolean, ageSec?:number}
 *          |{ok:false, error:string, tried:string[], diagnosis:string}}
 */
export async function runWebSearch({ query, max = 6, searchUrl = "", fetchPrivateUrls = false, signal, now = Date.now() } = {}) {
  const q = String(query ?? "").trim()
  if (!q) return { ok: false, error: "ERROR: empty query", tried: [], diagnosis: "empty query" }
  max = Math.max(1, Math.min(10, max))
  const ctx = { searchUrl, fetchPrivateUrls, signal }

  // 1. fresh cache on the normalized query (TTL-based freshness, §4/§30)
  const cached = cacheGet(q, { now })
  if (cached) {
    return { ok: true, results: cached.results.slice(0, max), provider: cached.provider, via: "cache", cached: true, ageSec: cached.ageSec }
  }

  // 2. adaptive provider order
  const order = providerOrder(ctx)
  const tried = []
  const failures = []
  for (const { name, provider, why } of order) {
    if (signal?.aborted) break
    const t0 = Date.now()
    try {
      const fn = PROVIDER_FNS[name]
      if (!fn) continue
      const { results, url } = await fn(ctx, q, max)
      tried.push(url)
      const ms = Date.now() - t0
      recordProviderOutcome(name, true, ms)
      const clean = rankResults(q, dedupeResults(results), max)
      if (!clean.length) {
        recordProviderOutcome(name, false, ms, "empty after normalize")
        failures.push(`${name}: no usable results`)
        continue
      }
      // 3. TTL cache the normalized result set (§4)
      cachePut(q, { results: clean, provider: name, now })
      return { ok: true, results: clean, provider: name, via: url }
    } catch (e) {
      const ms = Date.now() - t0
      const code = e instanceof ProviderFailure ? e.code : "ETIMEOUT"
      const msg = String(e?.message ?? e).slice(0, 160)
      tried.push(name === "generic" && ctx.searchUrl ? ctx.searchUrl : name)
      recordProviderOutcome(name, false, ms, `${code}: ${msg}`)
      failures.push(`${name}: ${code} ${msg}`)
      // SEARCH_FAILED → DIAGNOSE → next provider (loop continues)
    }
  }

  // 4. every provider failed — report the REAL result: an honest error with
  //    diagnosis and the full tried list. NEVER a fabricated "no results".
  const diagnosis = failures.length ? failures.join("; ") : "no provider available"
  const err = `ERROR: web_search failed: ${diagnosis.slice(0, 400)} (tried: ${tried.join(", ") || "nothing"})`
  return { ok: false, error: err, tried, diagnosis }
}

/** Format results exactly like the tool's historical format (parse-stable). */
export function formatSearchResults(q, results, provider = null) {
  const lines = [`web search: "${q}"${provider ? ` (provider: ${provider})` : ""}`]
  results.forEach((r, i) => lines.push(`${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? "\n   " + r.snippet : ""}`))
  let out = lines.join("\n")
  if (out.length > 8000) out = out.slice(0, 8000)
  return out
}
