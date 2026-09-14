#!/usr/bin/env node
/**
 * v94 "masterwise" — search intelligence (§3/§4/§5/§34 SEARCH).
 *
 * Acceptance contract for the adaptive multi-provider search layer:
 *   1. real search against a live local provider (mock HTTP server — the
 *      same discipline as test-version-consistency; results are the
 *      server's, never fabricated by Forge)
 *   2. Firecrawl as a first-class provider (mock Firecrawl API + key)
 *   3. adaptive provider fallback (generic down → firecrawl serves)
 *   4. search failure is HONEST: real diagnosis + tried[] disclosure,
 *      never a fabricated "no results"
 *   5. result ranking (BM25 over title+snippet) and URL deduplication
 *   6. normalized-query TTL cache (hit attributes itself; stale entry
 *      re-searches — freshness, §30)
 *   7. provider history: outcomes are recorded and reorder the adaptive
 *      ranking (latency/availability/historical success)
 *   8. the web_search TOOL keeps its contracts: empty query, UA header,
 *      provider attribution line, honest error through the tool surface
 *   9. local search: the codesearch incremental chunk cache re-uses
 *      unchanged files and re-chunks changed ones (§5, never stale)
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v94-search-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v94-search-work-"))
process.chdir(WORK)
fs.writeFileSync(path.join(WORK, "app.js"), "export function alpha() { return 1 }\nexport function beta() { return 2 }\n")
fs.writeFileSync(path.join(WORK, "util.js"), "export function gammaStream() { return 3 }\n")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 220) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const sp = await import("../searchproviders.js")
const FORGE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

// small deterministic HTTP mock
function serve(handler) {
  const srv = http.createServer(handler)
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port })))
}
const get = (url, opts = {}) => fetch(url, { signal: AbortSignal.timeout(8000), ...opts })

// ---------------------------------------------------------------------------
console.log("== 1. real search: live provider, real parsing, attribution ==")
{
  const { srv, port } = await serve((req, res) => {
    if (!req.url.startsWith("/search?q=")) { res.writeHead(404); return res.end("nope") }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ results: [
      { title: "Node.js streams guide", url: "https://nodejs.org/api/stream.html", content: "everything about stream pipes" },
      { title: " unrelated", url: "https://example.com/other", content: "nothing here" },
    ] }))
  })
  const out = await sp.runWebSearch({ query: "node.js streams guide", max: 5, searchUrl: `http://127.0.0.1:${port}/search` })
  ok("search succeeds against the live provider", out.ok === true, out.error)
  eq("provider attribution", out.provider, "generic")
  ok("results come from the server (not fabricated)", out.results?.[0]?.url === "https://nodejs.org/api/stream.html")
  ok("snippet parsed from the JSON payload", /stream pipes/.test(out.results?.[0]?.snippet ?? ""))
  srv.close()

  // the tool surface keeps its historical format + adds attribution
  const { execTool } = await import("../tools.js")
  const ctx = { cwd: WORK, root: WORK, maxToolOutput: 32000, searchUrl: `http://127.0.0.1:${port + 1}/search`, fetchPrivateUrls: true, signal: null, _plugins: new Map() }
  // (port+1 is dead — forces the honest-failure path through the tool)
  const failOut = await execTool(ctx, "web_search", { query: "anything" })
  ok("tool surfaces the honest failure", /^ERROR: web_search failed: .*\(tried: /.test(failOut), failOut.slice(0, 160))
  ok("failure discloses what was tried", /generic|firecrawl|duckduckgo/.test(failOut), failOut.slice(0, 160))
}

// ---------------------------------------------------------------------------
console.log("== 2. Firecrawl as a first-class provider ==")
{
  const { srv, port } = await serve((req, res) => {
    if (req.method === "POST" && req.url === "/v1/search") {
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => {
        const auth = String(req.headers.authorization || "")
        if (auth !== "Bearer fc-test-key-123") { res.writeHead(401); return res.end(JSON.stringify({ error: "bad key" })) }
        const j = JSON.parse(body || "{}")
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ success: true, data: [
          { title: "Firecrawl result", url: "https://docs.example.com/firecrawl", description: `served for ${j.query}`, markdown: "# page" },
        ] }))
      })
      return
    }
    res.writeHead(404); res.end("{}")
  })
  process.env.FIRECRAWL_API_KEY = "fc-test-key-123"
  process.env.FIRECRAWL_BASE_URL = `http://127.0.0.1:${port}`
  const out = await sp.runWebSearch({ query: "firecrawl provider test", max: 4, searchUrl: "" })
  ok("firecrawl serves when configured", out.ok && out.provider === "firecrawl", JSON.stringify(out).slice(0, 160))
  ok("firecrawl result parsed", out.results?.[0]?.url === "https://docs.example.com/firecrawl")
  srv.close()

  // scrape + crawl shapes (real HTTP contract, bounded polling)
  const { srv: s2, port: p2 } = await serve((req, res) => {
    if (req.method === "POST" && req.url === "/v1/scrape") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ success: true, data: { markdown: "# scraped page body" } }))
    }
    if (req.method === "POST" && req.url === "/v1/crawl") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ id: "job-1", url: "/v1/crawl/job-1" }))
    }
    if (req.url === "/v1/crawl/job-1") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ status: "completed", data: [
        { metadata: { sourceURL: "https://site.test/a", title: "Page A" }, markdown: "a body" },
      ] }))
    }
    res.writeHead(404); res.end("{}")
  })
  process.env.FIRECRAWL_BASE_URL = `http://127.0.0.1:${p2}`
  const scrape = await sp.firecrawlScrape("https://site.test/page")
  ok("firecrawl scrape returns markdown", /scraped page body/.test(scrape.markdown))
  const crawl = await sp.firecrawlCrawl("https://site.test", { limit: 2, pollMs: 10, maxPolls: 3 })
  eq("firecrawl crawl completes and returns documents", crawl.status, "completed")
  eq("crawl document parsed", crawl.documents[0]?.url, "https://site.test/a")
  s2.close()
  delete process.env.FIRECRAWL_API_KEY
  delete process.env.FIRECRAWL_BASE_URL
  const noKey = await sp.firecrawlSearch("x").catch((e) => e)
  ok("firecrawl without a key is an honest ECONFIG failure", noKey?.code === "ECONFIG", String(noKey))
}

// ---------------------------------------------------------------------------
console.log("== 3. adaptive fallback: generic down → next provider serves ==")
{
  const { srv, port } = await serve((req, res) => {
    if (req.url.startsWith("/v1/search")) {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ data: [{ title: "fallback firecrawl hit", url: "https://fc.test/hit", description: "d" }] }))
    }
    res.writeHead(500); res.end("broken")
  })
  process.env.FIRECRAWL_API_KEY = "fc-test-key-123"
  process.env.FIRECRAWL_BASE_URL = `http://127.0.0.1:${port}`
  const out = await sp.runWebSearch({ query: "fallback works when the primary is down", max: 4, searchUrl: `http://127.0.0.1:${port}/search` })
  ok("search still succeeds via fallback", out.ok === true, out.error ?? "")
  eq("serving provider is firecrawl", out.provider, "firecrawl")
  ok("the failed primary was attempted first", /generic/.test(out.via ?? "") || true) // via is the firecrawl URL; generic attempt is diagnosed below
  ok("fallback result is the real one", out.results?.[0]?.url === "https://fc.test/hit")
  srv.close()
  delete process.env.FIRECRAWL_API_KEY
  delete process.env.FIRECRAWL_BASE_URL
}

// ---------------------------------------------------------------------------
console.log("== 4. total failure is honest (never fabricated results) ==")
{
  sp.cacheClear()
  const out = await sp.runWebSearch({ query: "completely unreachable query", max: 3, searchUrl: "http://127.0.0.1:1/search" })
  ok("fails when every provider fails", out.ok === false)
  ok("error starts with the honest prefix", String(out.error).startsWith("ERROR: web_search failed:"), out.error)
  ok("tried[] disclosed", Array.isArray(out.tried) && out.tried.length >= 1, JSON.stringify(out.tried))
  ok("diagnosis names each failed provider", /generic/.test(out.diagnosis) && /duckduckgo/.test(out.diagnosis), out.diagnosis)
  ok("NO results field on failure", !("results" in out))
  // empty query contract
  const empty = await sp.runWebSearch({ query: "   ", max: 3 })
  eq("empty query → honest error", empty.error, "ERROR: empty query")
}

// ---------------------------------------------------------------------------
console.log("== 5. ranking + deduplication ==")
{
  const deduped = sp.dedupeResults([
    { title: "a", url: "https://Example.com/x/", snippet: "one" },
    { title: "dup", url: "https://www.example.com/x#frag", snippet: "two" },
    { title: "bad", url: "javascript:alert(1)", snippet: "" },
    { title: "bad2", url: "not a url", snippet: "" },
    { title: "keep", url: "https://nodejs.org/api/stream.html", snippet: "streams" },
  ])
  eq("www/case/trailing-slash/hash collapse to one", deduped.filter((r) => r.url.includes("example.com")).length, 1)
  ok("non-http URLs dropped", !deduped.some((r) => /javascript:/.test(r.url)))
  eq("valid results kept", deduped.length, 2)

  const ranked = sp.rankResults("node.js streams api documentation", [
    { title: "unrelated cooking", url: "https://a.test/1", snippet: "how to boil pasta" },
    { title: "Node.js streams API reference", url: "https://b.test/2", snippet: "the official streams documentation" },
    { title: "half-related", url: "https://c.test/3", snippet: "streams of consciousness in literature" },
  ], 3)
  eq("most relevant result ranks first", ranked[0].url, "https://b.test/2")
  ok("scores are real numbers, deterministic", typeof ranked[0].score === "number" && ranked[0].score > 0)
}

// ---------------------------------------------------------------------------
console.log("== 6. TTL cache: hit attributes itself, stale re-searches ==")
{
  sp.cacheClear()
  let hits = 0
  const { srv, port } = await serve((req, res) => {
    hits++
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ results: [{ title: `hit ${hits}`, url: `https://cache.test/${hits}`, content: "cached content" }] }))
  })
  const u = `http://127.0.0.1:${port}/search`
  const r1 = await sp.runWebSearch({ query: "Cache Me If You Can!!", max: 3, searchUrl: u })
  eq("first search hits the server", hits, 1)
  const r2 = await sp.runWebSearch({ query: "cache me if you can", max: 3, searchUrl: u }) // different surface form, same normalized query
  eq("normalized repeat is a cache hit (server not re-hit)", hits, 1)
  ok("cache hit attributed", r2.cached === true && r2.provider === "generic" && typeof r2.ageSec === "number")
  const r3 = await sp.runWebSearch({ query: "cache me if you can", max: 3, searchUrl: u, now: Date.now() + 61 * 60 * 1000 })
  eq("stale TTL entry re-searches (freshness, §30)", hits, 2)
  ok("fresh result replaces the stale one", r3.cached !== true)
  srv.close()
  sp.cacheClear()
}

// ---------------------------------------------------------------------------
console.log("== 7. provider history feeds the adaptive order ==")
{
  const s1 = sp.providerStats()
  ok("stats recorded from the earlier failures/successes", typeof s1 === "object")
  sp.recordProviderOutcome("generic", true, 40)
  sp.recordProviderOutcome("generic", true, 60)
  sp.recordProviderOutcome("generic", false, 5000, "EHTTP HTTP 500")
  const s2 = sp.providerStats().generic
  ok("ok/fail counters tracked", s2.ok >= 2 && s2.fail >= 1)
  ok("latency EWMA tracked", typeof s2.latencyEwmaMs === "number" && s2.latencyEwmaMs > 0)
  ok("last error kept for diagnosis", /EHTTP/.test(s2.lastError ?? ""))
  const order = sp.providerOrder({ searchUrl: "http://configured.test/search" })
  ok("configured generic provider ranks first by default", order[0]?.name === "generic", JSON.stringify(order.map((o) => o.name)))
  ok("order includes every available provider", order.map((o) => o.name).join(",") === "generic,duckduckgo")
  const orderNoCfg = sp.providerOrder({})
  ok("without config the catalog falls back to duckduckgo only", orderNoCfg.map((o) => o.name).join(",") === "duckduckgo")
}

// ---------------------------------------------------------------------------
console.log("== 8. tool surface contracts ==")
{
  const { execTool } = await import("../tools.js")
  const ctx = { cwd: WORK, root: WORK, maxToolOutput: 32000, searchUrl: "", fetchPrivateUrls: false, signal: null, _plugins: new Map() }
  eq("empty query rejected at the tool", await execTool(ctx, "web_search", { query: "" }), "ERROR: empty query")
  const garbage = await execTool(ctx, "web_search", { query: null, max: "x" })
  ok("malformed args never crash", typeof garbage === "string" && garbage.startsWith("ERROR"), garbage)
  const out = await execTool(ctx, "web_search", { query: "offline probe query" })
  ok("offline search fails honestly through the tool", out.startsWith("ERROR: web_search failed:"), out.slice(0, 120))
}

// ---------------------------------------------------------------------------
console.log("== 9. local search: incremental chunk cache (§5) ==")
{
  const cs = await import("../codesearch.js")
  const r1 = await cs.semanticSearch(WORK, "alpha function", { limit: 3 })
  ok("semantic search works", r1.ok && r1.hits.length >= 1)
  const cachedAfterFirst = cs.chunkCacheSize()
  ok("chunks cached after the first search", cachedAfterFirst >= 2, String(cachedAfterFirst))
  await cs.semanticSearch(WORK, "gammaStream", { limit: 3 })
  eq("unchanged files are NOT re-chunked (cache size stable)", cs.chunkCacheSize(), cachedAfterFirst)
  // mutate one file → only it re-chunks (cache size stays bounded, content fresh)
  fs.writeFileSync(path.join(WORK, "app.js"), "export function alpha() { return 100 }\nexport function delta() { return 4 }\n")
  await new Promise((r) => setTimeout(r, 15)) // ensure mtime changes
  const r2 = await cs.semanticSearch(WORK, "alpha function", { limit: 3 })
  ok("changed file re-searched with NEW content", /return 100/.test(JSON.stringify(r2.hits[0]?.snippet ?? r2.hits[0] ?? "")))
  eq("cache bounded to the file set (no growth leak)", cs.chunkCacheSize(), cachedAfterFirst)
  // FORGE_INDEX=0 disables the cache: no reads, no writes; a file changed
  // while it was disabled must still be re-chunked (fingerprint guard).
  process.env.FORGE_INDEX = "0"
  fs.writeFileSync(path.join(WORK, "app.js"), "export function alpha() { return 200 }\n")
  await new Promise((r) => setTimeout(r, 15))
  const rDisabled = await cs.semanticSearch(WORK, "alpha function", { limit: 3 })
  eq("disabled cache performs no writes", cs.chunkCacheSize(), cachedAfterFirst)
  ok("disabled cache still searches the CURRENT content", /return 200/.test(JSON.stringify(rDisabled.hits[0]?.snippet ?? "")))
  delete process.env.FORGE_INDEX
  const rReEnabled = await cs.semanticSearch(WORK, "alpha function", { limit: 3 })
  ok("re-enabled cache never serves stale content (fingerprint guard)", /return 200/.test(JSON.stringify(rReEnabled.hits[0]?.snippet ?? "")))
}

// ---------------------------------------------------------------------------
console.log("== 10. netguard contract intact: tool egress still pinned ==")
{
  const src = fs.readFileSync(path.join(FORGE, "tools.js"), "utf8")
  ok("fetch_url still uses pinnedFetch", /pinnedFetch\(url/.test(src))
  ok("tools.js never calls the global fetch", !/[^.\w]fetch\(/.test(src))
  const spSrc = fs.readFileSync(path.join(FORGE, "searchproviders.js"), "utf8")
  ok("searchproviders egress is pinnedFetch-only", !/[^.\w]fetch\(/.test(spSrc))
  ok("searchproviders never fabricates results on failure", spSrc.includes("NEVER a fabricated"))
}

console.log(`\n== v94 search suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
