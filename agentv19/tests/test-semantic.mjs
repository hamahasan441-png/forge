#!/usr/bin/env node
/**
 * forge — semantic retrieval checks (v23 Tier 1 #3).
 *
 * Covers: cosine/min-max pure helpers; the BM25+embeddings hybrid ranker
 * (fusion order, alpha extremes, graceful fallback, timeout budget);
 * the embedding disk cache; config resolution; the OpenAI-compatible
 * /embeddings client against a local mock server (batching, retry, auth
 * failure, malformed payloads, cache persistence); and the async wiring in
 * memory.js / context.js / agent.js. Isolated FORGE_HOME, zero internet.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sem-"))
process.env.FORGE_HOME = HOME // config.js resolves DEFAULT_DIR from this at import
const SAVED_OPENAI_KEY = process.env.OPENAI_API_KEY
delete process.env.OPENAI_API_KEY

const { cosineSimilarity, minMaxNormalize, rankDocs, rankDocsHybrid } = await import("../forge/retrieval.js")
const {
  textKey, resolveEmbeddingsConfig, loadEmbeddingCache, saveEmbeddingCache,
  pruneEmbeddingCache, embeddingCacheStats, createEmbedder, requestEmbeddings,
  DEFAULT_EMBED_MODELS,
} = await import("../forge/embeddings.js")
const { appendMemory, relevantMemory, relevantMemoryAsync, relevantLearnings, relevantLearningsAsync, recordLearning, memoryPool, parseLearnings } = await import("../forge/memory.js")
const { createContextEngine } = await import("../forge/context.js")
const { defaultConfig } = await import("../forge/config.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }

// ---------------------------------------------------------------------------
console.log("== cosineSimilarity ==")
ok("identical vectors → 1", Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9)
ok("orthogonal vectors → 0", cosineSimilarity([1, 0], [0, 1]) === 0)
ok("opposite vectors → -1", Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-9)
ok("length mismatch → 0", cosineSimilarity([1, 2], [1, 2, 3]) === 0)
ok("empty → 0", cosineSimilarity([], []) === 0)
ok("zero norm → 0", cosineSimilarity([0, 0], [1, 1]) === 0)
ok("non-array → 0", cosineSimilarity(null, [1]) === 0)

console.log("== minMaxNormalize ==")
{
  const n = minMaxNormalize([0, 5, 10])
  ok("min → 0, max → 1", n[0] === 0 && n[2] === 1)
  ok("monotone middle", Math.abs(n[1] - 0.5) < 1e-9)
  ok("all-equal → all-zero (no signal)", JSON.stringify(minMaxNormalize([3, 3, 3])) === "[0,0,0]")
  ok("empty → empty", minMaxNormalize([]).length === 0)
}

// ---------------------------------------------------------------------------
console.log("== rankDocsHybrid: fusion ==")
{
  const docs = [
    { id: "kw", text: "apple fruit orchard harvest" },
    { id: "sem", text: "canine puppy playful" },
    { id: "off", text: "steel beam construction" },
  ]
  // query shares TWO terms with "kw" (clear BM25 winner) but is semantically
  // aligned with "sem" — the fusion must trade these off by alpha.
  const V = { "apple apple orchard": [1, 0], "apple fruit orchard harvest": [0, 1], "canine puppy playful": [1, 0], "steel beam construction": [-1, 0] }
  const embed = async (texts) => texts.map((t) => V[t] ?? [0, 0])

  const h = await rankDocsHybrid("apple apple orchard", docs, { embed, alpha: 0.6 })
  ok("hybrid promotes the semantic match over the keyword match", h[0].id === "sem")
  ok("hybrid mode tagged", h[0].scoreDetail.mode === "hybrid")
  ok("scoreDetail carries raw semantic cosine", h.find((d) => d.id === "sem").scoreDetail.semantic === 1)
  ok("scoreDetail carries raw bm25", h.find((d) => d.id === "kw").scoreDetail.bm25 > 0)
  ok("input docs not mutated", !("score" in docs[0]) && docs[0].text === "apple fruit orchard harvest")

  const a0 = await rankDocsHybrid("apple apple orchard", docs, { embed, alpha: 0 })
  ok("alpha=0 → pure BM25 order", a0[0].id === "kw")
  const a1 = await rankDocsHybrid("apple apple orchard", docs, { embed, alpha: 1 })
  ok("alpha=1 → pure semantic order", a1[0].id === "sem")
  const tie = await rankDocsHybrid("apple apple orchard", docs, { embed, alpha: 0.5 })
  ok("tie at alpha=0.5 keeps input order (kw before sem)", tie[0].id === "kw" && tie[1].id === "sem")
  const scores = (await rankDocsHybrid("apple apple orchard", docs, { embed, alpha: 0.6 })).map((d) => d.score)
  ok("fused scores descending", scores[0] >= scores[1] && scores[1] >= scores[2])
}

console.log("== rankDocsHybrid: graceful degradation ==")
{
  const docs = [{ id: "a", text: "retry backoff network" }, { id: "b", text: "ui colors render" }]
  const embed = async (texts) => texts.map(() => [1, 0])
  const bmOrder = rankDocs("retry network", docs).map((d) => d.id)

  const threw = await rankDocsHybrid("retry network", docs, { embed: async () => { throw new Error("boom") } })
  ok("embedder throwing → BM25 order kept", JSON.stringify(threw.map((d) => d.id)) === JSON.stringify(bmOrder))
  ok("tagged bm25-fallback", threw[0].scoreDetail.mode === "bm25-fallback")

  const hung = await rankDocsHybrid("retry network", docs, { embed: () => new Promise(() => { }), budgetMs: 30 })
  ok("budget exceeded → BM25 order kept", JSON.stringify(hung.map((d) => d.id)) === JSON.stringify(bmOrder))
  ok("tagged bm25-timeout", hung[0].scoreDetail.mode === "bm25-timeout")

  const wrongCount = await rankDocsHybrid("retry network", docs, { embed: async (t) => t.slice(0, 1).map(() => [1]) })
  ok("wrong vector count → BM25 fallback", wrongCount[0].scoreDetail.mode === "bm25-fallback")
  const ragged = await rankDocsHybrid("retry network", docs, { embed: async (t) => t.map((_, i) => (i === 0 ? [1, 0] : [1])) })
  ok("ragged dims → BM25 fallback", ragged[0].scoreDetail.mode === "bm25-fallback")

  const noEmbed = await rankDocsHybrid("retry network", docs, {})
  ok("no embedder → plain BM25, tagged", noEmbed[0].scoreDetail.mode === "bm25" && noEmbed[0].id === bmOrder[0])
  const emptyQ = await rankDocsHybrid("", docs, { embed: async () => [[1], [1], [1]] })
  ok("empty query → scores 0, order kept", emptyQ.every((d) => d.score === 0))
  ok("empty docs → empty", (await rankDocsHybrid("q", [], { embed })).length === 0)
  const emptyEmbed = await rankDocsHybrid("retry network", docs, { embed: async () => [] })
  ok("empty vector list → BM25 fallback", emptyEmbed[0].scoreDetail.mode === "bm25-fallback")
}

// ---------------------------------------------------------------------------
console.log("== cache ==")
{
  ok("textKey stable + distinct", textKey("abc") === textKey("abc") && textKey("abc") !== textKey("abd") && /^[0-9a-f]{40}$/.test(textKey("abc")))
  const cacheFile = path.join(HOME, "cache", "t1.json")
  const doc = { version: 1, model: "m", dim: 2, entries: { a: { v: [1, 0], t: 1 }, b: { v: [0, 1], t: 5 }, c: { v: [1, 1], t: 3 }, d: { v: [2, 2], t: 2 } } }
  pruneEmbeddingCache(doc, 2)
  ok("prune keeps newest by touch time", JSON.stringify(Object.keys(doc.entries).sort()) === JSON.stringify(["b", "c"]))
  ok("saveEmbeddingCache writes atomically", saveEmbeddingCache(cacheFile, doc, -1) === true && fs.existsSync(cacheFile) && !fs.existsSync(cacheFile + ".tmp." + process.pid))
  const loaded = loadEmbeddingCache(cacheFile)
  ok("round-trip preserves entries", JSON.stringify(loaded.entries.b) === JSON.stringify({ v: [0, 1], t: 5 }))
  fs.writeFileSync(cacheFile, "{corrupt")
  ok("corrupt cache loads as empty", Object.keys(loadEmbeddingCache(cacheFile).entries).length === 0)
  ok("missing cache loads as empty", Object.keys(loadEmbeddingCache(path.join(HOME, "nope.json")).entries).length === 0)
  const stats = embeddingCacheStats(path.join(HOME, "nope.json"))
  ok("stats never throw on missing file", stats.entries === 0)
}

// ---------------------------------------------------------------------------
console.log("== resolveEmbeddingsConfig ==")
{
  const off = resolveEmbeddingsConfig(defaultConfig())
  ok("OFF by default", off.ok === false && /disabled/.test(off.reason))
  const noProvider = resolveEmbeddingsConfig({ retrieval: { embeddings: { enabled: true } } })
  ok("enabled but providerless → not ok", noProvider.ok === false)

  const openai = resolveEmbeddingsConfig({ retrieval: { embeddings: { enabled: true, provider: "openai", apiKey: "sk-x" } } })
  ok("openai resolves with default model", openai.ok === true && openai.model === DEFAULT_EMBED_MODELS.openai)
  ok("catalog baseUrl used", openai.baseUrl === "https://api.openai.com/v1")
  ok("alpha defaults to 0.5", openai.alpha === 0.5)

  const clamped = resolveEmbeddingsConfig({ retrieval: { embeddings: { enabled: true, provider: "openai", apiKey: "k", alpha: 5, batchSize: 999, timeoutMs: 1 } } })
  ok("alpha clamped to 1", clamped.alpha === 1)
  ok("batchSize clamped to 64", clamped.batchSize === 64)
  ok("timeoutMs clamped to floor", clamped.timeoutMs === 1000)

  const anth = resolveEmbeddingsConfig({ retrieval: { embeddings: { enabled: true, provider: "anthropic", apiKey: "k" } } })
  ok("anthropic refused (no embeddings endpoint)", anth.ok === false && /no embeddings endpoint/.test(anth.reason))

  const keyless = resolveEmbeddingsConfig({ retrieval: { embeddings: { enabled: true, provider: "openai" } } })
  ok("missing key → not ok", keyless.ok === false && /key/i.test(keyless.reason))

  process.env.OPENAI_API_KEY = "sk-from-env"
  const envKey = resolveEmbeddingsConfig({ retrieval: { embeddings: { enabled: true, provider: "openai" } } })
  ok("env key picked up", envKey.ok === true && envKey.apiKey === "sk-from-env")
  delete process.env.OPENAI_API_KEY

  const active = resolveEmbeddingsConfig({
    activeProvider: "mistral",
    providers: { mistral: { apiKey: "mk" } },
    retrieval: { embeddings: { enabled: true } },
  })
  ok("provider defaults to activeProvider", active.ok === true && active.provider === "mistral" && active.model === DEFAULT_EMBED_MODELS.mistral)

  const custom = resolveEmbeddingsConfig({ retrieval: { embeddings: { enabled: true, provider: "openai", apiKey: "k", baseUrl: "http://localhost:9/v1/", model: "my-embed", alpha: 0.9 } } })
  ok("explicit baseUrl/model/alpha win", custom.baseUrl === "http://localhost:9/v1" && custom.model === "my-embed" && custom.alpha === 0.9)

  const ollama = resolveEmbeddingsConfig({ retrieval: { embeddings: { enabled: true, provider: "ollama" } } })
  ok("ollama needs no key", ollama.ok === true && ollama.apiKey === "")
}

// ---------------------------------------------------------------------------
console.log("== embeddings client (local mock server) ==")
{
  const counts = { ok: 0, flaky: 0, auth: 0, badshape: 0, hang: 0 }
  let flakyFailed = false
  const vecFor = (s) => Array.from({ length: 8 }, (_, i) => ((s.charCodeAt(i % s.length) * (i + 3)) % 97) / 97 - 0.5)
  const server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      if (req.method !== "POST" || !req.url.endsWith("/embeddings")) { res.writeHead(404); res.end(); return }
      const body = JSON.parse(raw || "{}")
      const model = body.model
      if (model === "auth") { counts.auth++; res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "bad key" } })); return }
      if (model === "badshape") { counts.badshape++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ index: 0 }] })); return }
      if (model === "flaky") {
        counts.flaky++
        if (!flakyFailed) { flakyFailed = true; res.writeHead(503); res.end("overloaded"); return }
      }
      if (model === "hang") { counts.hang++; return } // never answer — client timeout guard must fire
      counts.ok++
      const inputs = Array.isArray(body.input) ? body.input : [body.input]
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ model, data: inputs.map((s, i) => ({ object: "embedding", index: i, embedding: vecFor(String(s)) })) }))
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const base = `http://127.0.0.1:${server.address().port}`
  const cacheFile = path.join(HOME, "cache", "client.json")
  const mkCfg = (model, extra = {}) => ({ baseUrl: base, apiKey: "k", model, batchSize: 2, timeoutMs: 4000, rerankBudgetMs: 0, maxTexts: 64, cachePath: cacheFile, cacheMaxEntries: 100, alpha: 0.5, ...extra })

  const e1 = createEmbedder(mkCfg("ok"))
  const vecs = await e1.embed(["alpha", "beta", "gamma", "delta", "epsilon"])
  ok("5 texts → aligned vectors", vecs.length === 5 && JSON.stringify(vecs[0]) === JSON.stringify(vecFor("alpha")) && JSON.stringify(vecs[4]) === JSON.stringify(vecFor("epsilon")))
  ok("batchSize 2 → 3 requests", counts.ok === 3)
  ok("dim recorded", e1.stats().hits === 0 && e1.stats().misses === 5)
  ok("cache persisted eagerly", fs.existsSync(cacheFile) && embeddingCacheStats(cacheFile).entries === 5)

  const e2 = createEmbedder(mkCfg("ok"))
  const before = counts.ok
  const vecs2 = await e2.embed(["alpha", "beta"])
  ok("second embedder serves from cache (no requests)", counts.ok === before)
  ok("cache hits counted", e2.stats().hits === 2 && e2.stats().requests === 0)
  ok("cached vectors identical", JSON.stringify(vecs2[0]) === JSON.stringify(vecs[0]))

  const e3 = createEmbedder(mkCfg("flaky"))
  const fv = await e3.embed(["flakytext"])
  ok("transient 5xx retried once → success", counts.flaky === 2 && JSON.stringify(fv[0]) === JSON.stringify(vecFor("flakytext")))

  const e4 = createEmbedder(mkCfg("auth"))
  let authErr = null
  try { await e4.embed(["x"]) } catch (e) { authErr = e }
  ok("401 → non-retryable ProviderError, single attempt", authErr && authErr.status === 401 && counts.auth === 1)

  const e5 = createEmbedder(mkCfg("badshape"))
  let shapeErr = null
  try { await e5.embed(["x"]) } catch (e) { shapeErr = e }
  ok("malformed payload → honest error", shapeErr && /malformed/.test(shapeErr.message))

  const e6 = createEmbedder(mkCfg("hang", { timeoutMs: 1000, cachePath: path.join(HOME, "cache", "hang.json") }))
  let hangErr = null
  const t0 = Date.now()
  try { await e6.embed(["slowpoke"]) } catch (e) { hangErr = e }
  ok("request timeout guard fires", hangErr && Date.now() - t0 < 2900)

  const direct = await requestEmbeddings({ baseUrl: base, apiKey: "k", model: "ok", texts: ["solo"] })
  ok("requestEmbeddings usable standalone", direct.length === 1 && direct[0].length === 8)
  let emptyErr = null
  const e7 = createEmbedder(mkCfg("ok", { cachePath: path.join(HOME, "cache", "empty.json") }))
  try { const r = await e7.embed([]); ok("embed([]) → [] without network", Array.isArray(r) && r.length === 0) } catch (e) { emptyErr = e; ok("embed([]) should not throw", false) }
  void emptyErr

  server.close()
  try { server.closeAllConnections() } catch { } // drop the dangling "hang" socket
}

// ---------------------------------------------------------------------------
console.log("== memory + learnings async wiring ==")
{
  const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sem-proj-"))
  process.chdir(PROJ)
  appendMemory("global", "deploy pipeline uses docker compose")
  appendMemory("global", "deploy keys rotate every quarter")
  appendMemory("global", "banana bread recipe with walnuts")
  recordLearning({ problem: "deploy timeout in ci", rootCause: "flaky network egress", fix: "raise timeout and retry" }, PROJ)
  recordLearning({ problem: "render glitch in ui", rootCause: "ansi escape ordering", fix: "reset styles before redraw" }, PROJ)

  const query = "deploy rotation policy"
  const L1 = "deploy pipeline uses docker compose"
  const L2 = "deploy keys rotate every quarter"

  const pool = memoryPool(PROJ)
  ok("memoryPool exposes both tiers with text", pool.length >= 3 && pool.every((e) => typeof e.l === "string" && (e.tier === "global" || e.tier === "project")))
  const learnBlocks = parseLearnings(PROJ)
  ok("parseLearnings returns LEARNING blocks", learnBlocks.length === 2 && learnBlocks.every((l) => l.startsWith("LEARNING:")))

  const bm = relevantMemory(query, { cwd: PROJ })
  ok("BM25 baseline finds deploy lines only", bm.includes(L1) && bm.includes(L2) && !bm.includes("banana"))

  const noEmb = await relevantMemoryAsync(query, { cwd: PROJ })
  ok("no embedder → byte-identical to BM25", noEmb === bm)

  // embedder that loves L2's meaning: query ≈ L2, orthogonal to L1
  const V = new Map([[query, [0, 1]], [L1, [1, 0]], [L2, [0, 1]], ["banana bread recipe with walnuts", [1, 1]]])
  const fakeEmbedder = { embed: async (texts) => texts.map((t) => V.get(t) ?? [0, 0]) }
  const hybrid = await relevantMemoryAsync(query, { cwd: PROJ, embedder: fakeEmbedder, alpha: 0.9 })
  ok("hybrid rerank promotes the semantic match", hybrid.includes(L1) && hybrid.includes(L2) && hybrid.indexOf(L2) < hybrid.indexOf(L1))

  const throwing = { embed: async () => { throw new Error("offline") } }
  const fell = await relevantMemoryAsync(query, { cwd: PROJ, embedder: throwing })
  ok("embedder failure → exact BM25 result", fell === bm)

  const bmLearn = relevantLearnings("deploy timeout", { cwd: PROJ })
  ok("learnings BM25 baseline", bmLearn.includes("deploy timeout in ci"))
  const learnNoEmb = await relevantLearningsAsync("deploy timeout", { cwd: PROJ })
  ok("learnings: no embedder → identical", learnNoEmb === bmLearn)
  const learnFell = await relevantLearningsAsync("deploy timeout", { cwd: PROJ, embedder: throwing })
  ok("learnings: embedder failure → BM25 fallback", learnFell === bmLearn)

  // context engine: buildAsync === build without embedder; hybrid slice with one
  const engine = createContextEngine({ cwd: PROJ, config: {} })
  const bSync = engine.build(query, { budgetTokens: 2200 })
  const bAsyncNoEmb = await engine.buildAsync(query, { budgetTokens: 2200 })
  ok("engine.buildAsync without embedder === build", bAsyncNoEmb.text === bSync.text)
  ok("hasEmbedder false by default", engine.hasEmbedder() === false)

  const semEngine = createContextEngine({ cwd: PROJ, config: { retrieval: { embeddings: { alpha: 0.9 } } }, embedder: fakeEmbedder })
  const bSem = await semEngine.buildAsync(query, { budgetTokens: 2200 })
  ok("engine.buildAsync with embedder reranks memory slice", bSem.text.includes(L2) && bSem.text.indexOf(L2) < bSem.text.indexOf(L1))
  const rSync = engine.rank(query, ["deploy keys rotate every quarter", "deploy pipeline uses docker compose"])
  const rAsync = await semEngine.rankAsync(query, ["deploy pipeline uses docker compose", "deploy keys rotate every quarter"])
  ok("rankAsync hybrid promotes semantic match", rAsync[0].i === 1 && rSync.length === 2)
  const rNoEmb = await engine.rankAsync(query, ["a", "b"])
  ok("rankAsync without embedder = BM25 shape", rNoEmb.every((d) => typeof d.score === "number"))

  process.chdir(HOME)
}

// ---------------------------------------------------------------------------
console.log("== runAgent end-to-end (mock chat + mock embeddings) ==")
{
  const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sem-agent-"))
  process.chdir(PROJ)
  appendMemory("global", "kubernetes namespace convention per team")
  appendMemory("global", "kubernetes secrets via sealed-secrets only")

  const counts = { embeddings: 0, chat: 0 }
  let capturedSystem = ""
  const vecFor = (s) => {
    const h = [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 1000, 7)
    return Array.from({ length: 4 }, (_, i) => Math.sin(h + i))
  }
  const server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      if (req.url.endsWith("/embeddings")) {
        counts.embeddings++
        const body = JSON.parse(raw || "{}")
        const inputs = Array.isArray(body.input) ? body.input : [body.input]
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ data: inputs.map((s, i) => ({ index: i, embedding: vecFor(String(s)) })) }))
        return
      }
      if (req.url.endsWith("/chat/completions")) {
        counts.chat++
        const body = JSON.parse(raw || "{}")
        capturedSystem = body.messages.find((m) => m.role === "system")?.content ?? ""
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] }))
        return
      }
      res.writeHead(404); res.end()
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const port = server.address().port

  const { runAgent } = await import("../forge/agent.js")
  const events = []
  const config = {
    providers: {},
    activeProvider: "openai",
    retrieval: { embeddings: { enabled: true, provider: "openai", apiKey: "sk-test", baseUrl: `http://127.0.0.1:${port}/v1`, model: "test-embed", rerankBudgetMs: 4000 } },
    agent: { maxSteps: 1 },
    skills: { enabled: false },
  }
  const provider = { name: "openai", model: "mock-chat", protocol: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "sk-test", contextWindow: 128000 }
  const res = await runAgent({ config, provider, task: "kubernetes namespace conventions", onEvent: (e) => events.push(e), journal: false, noTools: true })
  ok("agent run completes with semantic retrieval on", res.status === "COMPLETED")
  ok("embeddings endpoint was called", counts.embeddings >= 1)
  ok("semantic retrieval announced via event", events.some((e) => e.type === "info" && /semantic retrieval/.test(e.text || "")))
  ok("system prompt still carries memory", /kubernetes/.test(capturedSystem))
  ok("embedding cache now populated", embeddingCacheStats(path.join(HOME, "cache", `embeddings-openai-${textKey("test-embed").slice(0, 10)}.json`)).entries > 0)

  // disabled-by-default regression: same run without embeddings config makes
  // ZERO embeddings requests and still completes
  const before = counts.embeddings
  const configOff = { providers: {}, activeProvider: "openai", agent: { maxSteps: 1 }, skills: { enabled: false } }
  const resOff = await runAgent({ config: configOff, provider, task: "kubernetes namespace conventions", journal: false, noTools: true })
  ok("default config → no embeddings traffic", counts.embeddings === before)
  ok("default config → run unchanged", resOff.status === "COMPLETED")

  server.close()
  process.chdir(HOME)
}

if (SAVED_OPENAI_KEY !== undefined) process.env.OPENAI_API_KEY = SAVED_OPENAI_KEY
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch { }

console.log(`\n== semantic suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
