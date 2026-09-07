/**
 * forge — lightweight relevance ranking (v20.2, P3-2; v23 hybrid).
 *
 * A zero-dependency BM25 ranker used to order the repo map and long-term memory
 * by relevance to the current task, instead of by symbol count or raw token
 * overlap. BM25 beats plain overlap because it (a) down-weights common terms via
 * IDF and (b) saturates term frequency, so one file mentioning a rare query word
 * outranks a huge file that merely repeats a common one.
 *
 * v23 (Tier 1): BM25 stays the zero-config, offline-safe DEFAULT. When an
 * embeddings provider is configured (embeddings.js), rankDocsHybrid() fuses the
 * BM25 score with a cosine-similarity score from provider embeddings:
 *   fused = (1 - alpha) * bm25_normalized + alpha * semantic_normalized
 * Every failure mode (no embedder, HTTP error, malformed vectors, timeout)
 * falls back to the plain BM25 ordering — hybrid can never break retrieval.
 */

const STOP = new Set(
  "a an the is are was were be been being to of in on for with and or not it this that these those i you he she we they do does did how what why when where which who if then as at by from into over under out up down off no yes can will would should could may might must have has had get got make made use used using code file files function functions".split(" ")
)

/** Tokenize for ranking: lowercase, split on non-identifier chars, drop stops. */
export function tokenize(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
}

/**
 * Rank docs by BM25 relevance to `query`.
 * @param query  string
 * @param docs   [{ id, text }]
 * @param opts   { k1=1.5, b=0.75, limit }
 * @returns      docs sorted by descending score (stable for ties), each with .score.
 *               An empty query returns the docs unchanged (score 0).
 */
export function rankDocs(query, docs, { k1 = 1.5, b = 0.75, limit } = {}) {
  const list = Array.isArray(docs) ? docs : []
  const q = [...new Set(tokenize(query))]
  if (!q.length || !list.length) {
    const out = list.map((d) => ({ ...d, score: 0 }))
    return limit ? out.slice(0, limit) : out
  }
  // per-doc term frequencies + lengths
  const tfs = new Array(list.length)
  const lens = new Array(list.length)
  const df = new Map()
  for (let i = 0; i < list.length; i++) {
    const toks = tokenize(list[i].text)
    lens[i] = toks.length || 1
    const tf = new Map()
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1)
    tfs[i] = tf
    for (const t of tf.keys()) if (q.includes(t)) df.set(t, (df.get(t) || 0) + 1)
  }
  const N = list.length
  const avgdl = lens.reduce((a, b2) => a + b2, 0) / N
  const idf = new Map()
  for (const t of q) {
    const n = df.get(t) || 0
    // BM25 idf, floored at a small positive value so a term present everywhere
    // still contributes a little rather than going negative
    idf.set(t, Math.max(1e-6, Math.log(1 + (N - n + 0.5) / (n + 0.5))))
  }
  const scored = list.map((d, i) => {
    let s = 0
    const tf = tfs[i]
    const dl = lens[i]
    for (const t of q) {
      const f = tf.get(t) || 0
      if (!f) continue
      s += idf.get(t) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgdl)))
    }
    return { ...d, score: s, _i: i }
  })
  scored.sort((a, b2) => b2.score - a.score || a._i - b2._i) // stable on ties
  const out = scored.map(({ _i, ...rest }) => rest)
  return limit ? out.slice(0, limit) : out
}

// ---------------------------------------------------------------------------
// v23: semantic fusion helpers (pure + deterministic given an `embed` fn)
// ---------------------------------------------------------------------------

/** Cosine similarity of two equal-length numeric vectors; 0 for degenerate
 *  input (empty, mismatched length, or zero norm) — never NaN. */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0, y = Number(b[i]) || 0
    dot += x * y; na += x * x; nb += y * y
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Min-max normalize a score list to [0, 1]. All-equal scores normalize to
 *  all-zeros (no signal to exploit); empty input → empty output. */
export function minMaxNormalize(scores) {
  const arr = Array.isArray(scores) ? scores.map((s) => Number(s) || 0) : []
  if (!arr.length) return []
  let lo = Infinity, hi = -Infinity
  for (const s of arr) { if (s < lo) lo = s; if (s > hi) hi = s }
  if (hi === lo) return arr.map(() => 0)
  return arr.map((s) => (s - lo) / (hi - lo))
}

function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)) }
const TIMEOUT = Symbol("hybrid-timeout")

/**
 * Hybrid BM25 + semantic ranking.
 *
 * @param query  string
 * @param docs   [{ text, ... }] — extra fields are preserved on output
 * @param opts   { embed: (texts) => Promise<number[][]>,  // injected; query first
 *                 alpha = 0.5,     // 0 = pure BM25, 1 = pure semantic
 *                 budgetMs = 0 }   // >0 = hard wall-clock budget, then BM25
 * @returns docs sorted by fused score desc (stable on ties), each with .score
 *          and .scoreDetail { mode, bm25, semantic, alpha } where mode is one
 *          of "hybrid", "bm25" (no embedder/empty query), "bm25-fallback"
 *          (embedding failed), "bm25-timeout" (budget exceeded).
 *
 * Determinism note: given the same vectors, ordering is exact; ties keep input
 * order. The function never throws — embedding failures degrade to BM25.
 */
export async function rankDocsHybrid(query, docs, { embed, alpha = 0.5, budgetMs = 0 } = {}) {
  const list = Array.isArray(docs) ? docs : []
  const a = Math.min(1, Math.max(0, Number(alpha) || 0))
  // NOTE: rankDocs strips its own `_i` tag on output, so carry the index
  // through under a distinct key.
  const tagged = list.map((d, i) => ({ ...(d && typeof d === "object" ? d : { text: String(d) }), __ri: i }))
  const bm = rankDocs(query, tagged) // BM25 ordering, each entry keeps __ri
  const bmByIndex = new Map(bm.map((r) => [r.__ri, r.score]))
  const bmScores = list.map((_, i) => bmByIndex.get(i) ?? 0)

  const plain = (mode) => bm.map(({ __ri, ...rest }) => ({
    ...rest, scoreDetail: { mode, bm25: rest.score, semantic: null, alpha: a },
  }))

  if (!String(query ?? "").trim() || typeof embed !== "function") return plain("bm25")

  let vecs = null
  try {
    const texts = [String(query), ...list.map((d) => String(d?.text ?? ""))]
    const p = Promise.resolve().then(() => embed(texts))
    vecs = budgetMs > 0 ? await Promise.race([p, sleepMs(budgetMs).then(() => TIMEOUT)]) : await p
    if (vecs === TIMEOUT) return plain("bm25-timeout")
    if (!Array.isArray(vecs) || vecs.length !== list.length + 1) return plain("bm25-fallback")
    const dim = Array.isArray(vecs[0]) ? vecs[0].length : 0
    if (!dim || vecs.some((v) => !Array.isArray(v) || v.length !== dim)) return plain("bm25-fallback")
  } catch {
    return plain("bm25-fallback")
  }

  // cosine(query, doc) ∈ [-1, 1]. Negative cosine means "less similar than
  // orthogonal" and carries no retrieval signal, so it is clamped to 0 before
  // min-max — otherwise an orthogonal doc would score a free 0.5 and outrank
  // a genuine keyword match at mid alpha.
  const semRaw = list.map((_, i) => cosineSimilarity(vecs[0], vecs[i + 1]))
  const semN = minMaxNormalize(semRaw.map((c) => Math.max(0, c)))
  const bmN = minMaxNormalize(bmScores)
  const out = list.map((d, i) => ({
    ...(d && typeof d === "object" ? d : { text: String(d) }),
    _i: i,
    score: (1 - a) * bmN[i] + a * semN[i],
    scoreDetail: { mode: "hybrid", bm25: bmScores[i], semantic: semRaw[i], alpha: a },
  }))
  out.sort((x, y) => y.score - x.score || x._i - y._i)
  return out.map(({ _i, ...rest }) => rest)
}
