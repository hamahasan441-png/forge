/**
 * forge — lightweight relevance ranking (v20.2, P3-2).
 *
 * A zero-dependency BM25 ranker used to order the repo map and long-term memory
 * by relevance to the current task, instead of by symbol count or raw token
 * overlap. BM25 beats plain overlap because it (a) down-weights common terms via
 * IDF and (b) saturates term frequency, so one file mentioning a rare query word
 * outranks a huge file that merely repeats a common one.
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
