/**
 * forge — provider embeddings for semantic retrieval (v23, Tier 1).
 *
 * BM25 (retrieval.js) remains the zero-config, offline-safe default. This
 * module is the OPTIONAL layer on top: when `retrieval.embeddings.enabled` is
 * true and an OpenAI-compatible embeddings endpoint resolves, callers can
 * rerank BM25 shortlists with a BM25+cosine hybrid (see rankDocsHybrid in
 * retrieval.js). Zero dependencies: stdlib fetch + a JSON disk cache.
 *
 * Trust model: the endpoint is resolved from CONFIG ONLY (never model output)
 * — same rule as plugins, MCP and LSP servers. Failures NEVER break retrieval:
 * every consumer treats a failed embedding step as "fall back to BM25".
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { DEFAULT_DIR } from "./config.js"
import { getCatalog, envKeyFor, ProviderError } from "./providers.js"

/** Providers known to serve an OpenAI-compatible /embeddings endpoint, with a
 *  sane default model. Other providers can still be used — the user must then
 *  name the embedding model explicitly under retrieval.embeddings.model. */
export const DEFAULT_EMBED_MODELS = {
  openai: "text-embedding-3-small",
  gemini: "text-embedding-004",
  mistral: "mistral-embed",
  together: "BAAI/bge-large-en-v1.5",
  ollama: "nomic-embed-text",
  xai: "grok-2-embedding-1018",
  qwen: "text-embedding-v4",
}

/** Stable content key for the embedding cache. */
export function textKey(text) {
  return crypto.createHash("sha1").update(String(text ?? ""), "utf8").digest("hex")
}

function clampNum(v, lo, hi, dflt) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

/**
 * Resolve the embeddings configuration. Returns { ok:false, reason } when
 * semantic retrieval is not usable (the caller then stays on pure BM25), or
 * { ok:true, provider, model, baseUrl, apiKey, protocol, alpha, batchSize,
 *   timeoutMs, rerankBudgetMs, maxTexts, cachePath, cacheMaxEntries }.
 *
 * Resolution: explicit retrieval.embeddings.* fields win; provider defaults to
 * config.activeProvider; baseUrl/apiKey fall back to the provider's own config
 * entry and its env key. The protocol must be OpenAI-compatible — Anthropic's
 * messages API has no embeddings endpoint, so it is reported, not guessed at.
 */
export function resolveEmbeddingsConfig(config) {
  const e = config?.retrieval?.embeddings || {}
  const off = (reason) => ({ ok: false, reason })
  if (e.enabled !== true) return off("disabled — set retrieval.embeddings.enabled true to turn on")

  const providerName = String(e.provider || config?.activeProvider || "").trim()
  if (!providerName) return off("no embeddings provider — set retrieval.embeddings.provider (or an activeProvider)")

  const cat = getCatalog(providerName)
  const provConf = config?.providers?.[providerName] || {}
  const protocol = cat?.protocol ?? provConf.protocol ?? "openai"
  if (protocol !== "openai") {
    return off(`provider "${providerName}" speaks the ${protocol} protocol, which has no embeddings endpoint — point retrieval.embeddings.provider at an OpenAI-compatible embeddings API`)
  }

  const baseUrl = String(e.baseUrl || provConf.baseUrl || cat?.baseUrl || "").replace(/\/$/, "")
  if (!baseUrl) return off(`provider "${providerName}" has no baseUrl — set retrieval.embeddings.baseUrl`)

  const apiKey = String(e.apiKey || provConf.apiKey || envKeyFor(providerName) || "")
  if (!apiKey && providerName !== "ollama") return off(`provider "${providerName}" needs an API key — set retrieval.embeddings.apiKey (or ${cat?.envKey || providerName.toUpperCase() + "_API_KEY"})`)

  const model = String(e.model || DEFAULT_EMBED_MODELS[providerName] || "").trim()
  if (!model) return off(`no default embedding model known for "${providerName}" — set retrieval.embeddings.model`)

  const cacheDir = String(e.cacheDir || "").trim() || path.join(DEFAULT_DIR, "cache")
  const cachePath = path.join(cacheDir, `embeddings-${providerName}-${textKey(model).slice(0, 10)}.json`)
  return {
    ok: true,
    provider: providerName,
    model,
    baseUrl,
    apiKey,
    protocol,
    alpha: clampNum(e.alpha, 0, 1, 0.5),
    batchSize: Math.floor(clampNum(e.batchSize, 1, 64, 16)),
    timeoutMs: Math.floor(clampNum(e.timeoutMs, 1000, 120000, 20000)),
    rerankBudgetMs: Math.floor(clampNum(e.rerankBudgetMs, 0, 60000, 4000)),
    maxTexts: Math.floor(clampNum(e.maxTexts, 1, 256, 64)),
    cachePath,
    cacheMaxEntries: Math.floor(clampNum(e.cacheMaxEntries, 0, 100000, 2000)),
  }
}

// ---------------------------------------------------------------------------
// Disk cache — { version, model, dim, entries: { <sha1>: { v:[...], t:ms } } }.
// Saved atomically (tmp file + rename), pruned to cacheMaxEntries keeping the
// most recently used. A corrupt or partial file is treated as an empty cache —
// the cache is a speedup, never a correctness dependency.
// ---------------------------------------------------------------------------

export function loadEmbeddingCache(cachePath) {
  try {
    const j = JSON.parse(fs.readFileSync(cachePath, "utf8"))
    if (!j || typeof j !== "object" || !j.entries || typeof j.entries !== "object") return { version: 1, model: "", dim: 0, entries: {} }
    return { version: 1, model: String(j.model || ""), dim: Number(j.dim) || 0, entries: j.entries }
  } catch {
    return { version: 1, model: "", dim: 0, entries: {} }
  }
}

/** Drop oldest entries until at most `maxEntries` remain (maxEntries 0 = keep
 *  nothing new beyond what fits; negative = unbounded). Returns the doc. */
export function pruneEmbeddingCache(doc, maxEntries) {
  const keys = Object.keys(doc.entries || {})
  if (!Number.isFinite(maxEntries) || maxEntries < 0 || keys.length <= maxEntries) return doc
  const kept = keys
    .map((k) => ({ k, t: Number(doc.entries[k]?.t) || 0 }))
    .sort((a, b) => b.t - a.t)
    .slice(0, maxEntries)
    .map((x) => x.k)
  const entries = {}
  for (const k of kept) entries[k] = doc.entries[k]
  doc.entries = entries
  return doc
}

export function saveEmbeddingCache(cachePath, doc, maxEntries) {
  try {
    pruneEmbeddingCache(doc, maxEntries)
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    const tmp = cachePath + ".tmp." + process.pid
    fs.writeFileSync(tmp, JSON.stringify(doc))
    fs.renameSync(tmp, cachePath)
    return true
  } catch {
    return false
  }
}

/** Cache stats for `forge embeddings` (never throws). */
export function embeddingCacheStats(cachePath) {
  const doc = loadEmbeddingCache(cachePath)
  const entries = Object.keys(doc.entries).length
  let bytes = 0
  try { bytes = fs.statSync(cachePath).size } catch { }
  return { entries, bytes, model: doc.model || null, dim: doc.dim || null }
}

// ---------------------------------------------------------------------------
// HTTP client — OpenAI-compatible POST {baseUrl}/embeddings.
// ---------------------------------------------------------------------------

/** Combine an optional caller signal with a hard request timeout. Node 18 has
 *  no AbortSignal.any, so this is hand-rolled; dispose() clears the timer. */
function guardedSignal(timeoutMs, signal) {
  const ctrl = new AbortController()
  let timer = null
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20000
  timer = setTimeout(() => { try { ctrl.abort(new Error("embeddings request timed out")) } catch { } }, ms)
  if (signal) {
    if (signal.aborted) { try { ctrl.abort(signal.reason) } catch { } }
    else signal.addEventListener("abort", () => { try { ctrl.abort(signal.reason) } catch { } }, { once: true })
  }
  return {
    signal: ctrl.signal,
    dispose() { clearTimeout(timer) },
  }
}

function isRetryableStatus(s) {
  return s === 429 || s === 408 || s >= 500
}

/**
 * One embeddings request: POST { model, input: texts[] } → number[][].
 * Validates the payload shape hard (a wrong vector count would silently
 * misalign the caller). Throws ProviderError on HTTP/shape failures.
 */
export async function requestEmbeddings({ baseUrl, apiKey, model, texts, timeoutMs = 20000, signal, fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch
  const url = String(baseUrl || "").replace(/\/$/, "") + "/embeddings"
  const headers = { "content-type": "application/json" }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`

  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const guard = guardedSignal(timeoutMs, signal)
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, input: texts }),
        signal: guard.signal,
      })
      guard.dispose()
      if (!res.ok) {
        let body = ""
        try { body = String(await res.text()).slice(0, 300) } catch { }
        const e = new ProviderError(`embeddings HTTP ${res.status}: ${body || "(no body)"}`, { status: res.status, retryable: isRetryableStatus(res.status) })
        if (e.retryable && attempt === 0) { lastErr = e; await sleep(300); continue }
        throw e
      }
      let j = null
      try { j = await res.json() } catch { }
      const data = j?.data
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw new ProviderError(`embeddings response malformed: expected ${texts.length} vector(s), got ${Array.isArray(data) ? data.length : typeof data}`, { status: res.status ?? 0, retryable: false })
      }
      const byIndex = new Array(texts.length)
      for (const d of data) {
        const idx = Number.isInteger(d?.index) ? d.index : data.indexOf(d)
        const v = d?.embedding
        if (!Number.isInteger(idx) || idx < 0 || idx >= texts.length || !Array.isArray(v) || !v.length || v.some((x) => !Number.isFinite(Number(x)))) {
          throw new ProviderError("embeddings response malformed: missing/invalid embedding vector", { status: res.status ?? 0, retryable: false })
        }
        byIndex[idx] = v.map(Number)
      }
      if (byIndex.some((v) => !v)) throw new ProviderError("embeddings response malformed: duplicate/missing indexes", { status: res.status ?? 0, retryable: false })
      return byIndex
    } catch (e) {
      guard.dispose()
      const abortedByCaller = signal?.aborted && !/timed out/.test(String(e?.cause?.message ?? e?.message ?? ""))
      if (abortedByCaller) throw e
      if (e instanceof ProviderError) {
        if (e.retryable && attempt === 0 && e.status !== undefined && e.status !== 0) { lastErr = e; await sleep(300); continue }
        throw e
      }
      // network failure (fetch failed / abort from our own timeout)
      const pe = new ProviderError(`could not reach the embeddings endpoint (${e?.cause?.message ?? e?.message ?? "network error"})`, { retryable: true })
      if (attempt === 0) { lastErr = pe; await sleep(300); continue }
      throw lastErr || pe
    }
  }
  throw lastErr || new ProviderError("embeddings request failed", { retryable: false })
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/**
 * Embedder: cache-first, batched network fill, aligned output.
 * `embed(texts)` resolves to number[][] in input order. Cache hits skip the
 * network entirely; cache misses are fetched in batchSize batches and
 * persisted (best-effort) right away, so a crash never loses learned vectors.
 * An embedder NEVER throws from misuse of empty input — embed([]) is [].
 */
export function createEmbedder(cfg, { fetchImpl, cacheDoc, now } = {}) {
  const clock = typeof now === "function" ? now : () => Date.now()
  const doc = cacheDoc || loadEmbeddingCache(cfg.cachePath)
  if (doc.model && cfg.model && doc.model !== cfg.model) { doc.entries = {}; doc.dim = 0 } // model changed → stale vectors AND dims
  doc.model = cfg.model
  // NOTE on concurrent embedders (meta controller + agent loop may hold one
  // each in the same run): each persists its own loaded snapshot, last writer
  // wins — an entry another embedder added can be evicted from the file and
  // will simply be re-embedded next time. The cache is a speedup, never a
  // correctness dependency, so this is accepted instead of a merge protocol.
  const stats = { calls: 0, texts: 0, hits: 0, misses: 0, requests: 0, errors: 0 }

  async function embed(texts, { signal } = {}) {
    const list = Array.isArray(texts) ? texts.map((t) => String(t ?? "")).slice(0, cfg.maxTexts || 64) : []
    if (!list.length) return []
    stats.calls++; stats.texts += list.length
    const out = new Array(list.length)
    const missIdx = []
    list.forEach((t, i) => {
      const hit = doc.entries[textKey(t)]
      if (hit && Array.isArray(hit.v) && hit.v.length) { out[i] = hit.v; stats.hits++ }
      else missIdx.push(i)
    })
    if (missIdx.length) {
      stats.misses += missIdx.length
      const batch = Math.max(1, cfg.batchSize || 16)
      for (let s = 0; s < missIdx.length; s += batch) {
        const idxs = missIdx.slice(s, s + batch)
        const batchTexts = idxs.map((i) => list[i])
        stats.requests++
        try {
          const vecs = await requestEmbeddings({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, texts: batchTexts, timeoutMs: cfg.timeoutMs, signal, fetchImpl })
          const t = clock()
          idxs.forEach((docIdx, j) => {
            out[docIdx] = vecs[j]
            doc.entries[textKey(list[docIdx])] = { v: vecs[j], t }
          })
          doc.dim = vecs[0].length
          saveEmbeddingCache(cfg.cachePath, doc, cfg.cacheMaxEntries)
        } catch (e) {
          stats.errors++
          throw e
        }
      }
    }
    return out
  }

  return {
    embed,
    stats: () => ({ ...stats }),
    cachePath: cfg.cachePath,
    persist() { return saveEmbeddingCache(cfg.cachePath, doc, cfg.cacheMaxEntries) },
    close() { this.persist() },
  }
}
