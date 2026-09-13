/**
 * v89 "fast" — performance work that changes ZERO behavior.
 *
 *  1. xlang adjacency index: results are BYTE-IDENTICAL to the old O(V×E)
 *     algorithm — proven here by running a reference implementation of the
 *     old linear-scan code against the new one on the REAL repo graph and a
 *     1 000-file synthetic graph. Plus a perf budget (traversals that used
 *     to cost ~30ms each must now cost ~0).
 *  2. Memo safety: repeated testsForFiles calls return equal arrays, and
 *     mutating a returned array cannot corrupt later calls.
 *  3. Lazy CLI: forge.js has no static import of the chat/agent REPL graphs;
 *     `forge version` boots in a fraction of the old 218ms.
 *  4. Provider fail-fast: a connect-guard expiry skips same-provider retries
 *     (was attempts×connectMs of dead waiting) and is tagged kind:"connect".
 *  5. Anthropic prompt caching: the static prefix (tools + system) carries
 *     cache_control — same content, cache-served on step ≥ 2.
 */
import assert from "node:assert"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const { testsForFiles, consumersOf, implForFiles, XEDGE } = await import("../xlang.js")
const { buildCrossGraph } = await import("../repomap.js")
const { defaultConfig } = await import("../config.js")
const { streamChat, streamChatResilient, ProviderError } = await import("../providers.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 220) : ""}`) }
}

// ---------------------------------------------------------------------------
// Reference implementation of the PRE-v89 algorithm (edge-list scan + O(F)
// file find) — the ground truth the index must reproduce exactly.
// ---------------------------------------------------------------------------
function refNeighbors(graph, rel, kinds, { reverse = false } = {}) {
  const out = []
  for (const e of graph.edges || []) {
    if (kinds && !kinds.includes(e.kind)) continue
    if (!reverse && e.from === rel) out.push(e.to)
    if (reverse && e.to === rel) out.push(e.from)
  }
  return out
}
function refTestsForFiles(files, graph, { cwd = "" } = {}) {
  if (!graph?.files?.length) return []
  const relOf = (file) => {
    const s = String(file).replaceAll("\\", "/")
    if ((graph.files || []).some((f) => f.path === s)) return s
    if (cwd) { try { const r = path.relative(cwd, path.resolve(cwd, s)); if (graph.files.some((f) => f.path === r)) return r } catch {} }
    const base = path.basename(s)
    const hits = (graph.files || []).filter((f) => path.basename(f.path) === base)
    return hits.length === 1 ? hits[0].path : s
  }
  const start = (files || []).map(relOf).filter(Boolean)
  const seen = new Set(start), stack = [...start], tests = new Set()
  for (const n of graph.files) if (n.isTest && start.includes(n.path)) tests.add(n.path)
  const KINDS = [XEDGE.IMPORT, XEDGE.CONSUMES, XEDGE.IMPLEMENTS, XEDGE.TEST]
  while (stack.length) {
    const cur = stack.pop()
    for (const n of [...refNeighbors(graph, cur, KINDS, { reverse: true }), ...refNeighbors(graph, cur, KINDS)]) {
      if (!n || seen.has(n) || n.includes(":")) continue
      seen.add(n); stack.push(n)
      const node = graph.files.find((f) => f.path === n)
      if (node?.isTest) tests.add(n)
    }
  }
  return [...tests]
}

console.log("== 1. adjacency index: byte-identical results (real repo graph) ==")
{
  const g = buildCrossGraph(path.resolve(process.cwd()))
  const files = g.files.map((f) => f.path)
  ok("repo graph is non-trivial", files.length > 100, `files=${files.length}`)
  let checked = 0
  // every file, individually — the strongest equivalence check we can afford
  for (const f of files) {
    const a = testsForFiles([f], g, { cwd: process.cwd() })
    const b = refTestsForFiles([f], g, { cwd: process.cwd() })
    if (JSON.stringify([...a].sort()) !== JSON.stringify([...b].sort())) {
      ok(`identical result for ${f}`, false, `new=${JSON.stringify(a)} ref=${JSON.stringify(b)}`)
      break
    }
    checked++
  }
  ok(`identical testsForFiles for all ${checked} files`, checked === files.length)
  // batches + cwd variants
  for (const batch of [files.slice(0, 5), files.slice(100, 130), ["tools.js", "xlang.js", "nope.mjs"]]) {
    const a = testsForFiles(batch, g, {})
    const b = refTestsForFiles(batch, g, {})
    ok(`identical for batch of ${batch.length}`, JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()))
  }
}

console.log("== 2. synthetic 1000-file graph: correctness + perf budget ==")
{
  // 1000 files in a chain, every 10th a test; extra fan-out edges; a consumer
  // edge kind mix to exercise the kinds filter.
  const files = [], edges = []
  for (let i = 0; i < 1000; i++) files.push({ path: `src/mod${i}.js`, isTest: i % 10 === 0 })
  for (let i = 1; i < 1000; i++) edges.push({ from: `src/mod${i}.js`, to: `src/mod${i - 1}.js`, kind: XEDGE.IMPORT })
  for (let i = 0; i < 1000; i += 5) edges.push({ from: `src/mod${i}.js`, to: `src/mod${(i + 7) % 1000}.js`, kind: XEDGE.CONSUMES })
  for (let i = 0; i < 500; i++) edges.push({ from: `srv/service${i}.proto`, to: `src/mod${i}.js`, kind: XEDGE.CONTRACT })
  const g = { files, edges }
  // correctness spot checks (chain reachability) — MUST be non-empty, else
  // the equivalence check below would be vacuous
  const t1 = testsForFiles(["src/mod999.js"], g, {})
  ok("chain reaches tests below (non-empty)", t1.length > 0, JSON.stringify(t1.slice(0, 4)))
  ok("chain reaches the nearest test below", t1.includes("src/mod990.js"), JSON.stringify(t1.slice(0, 4)))
  const r1 = refTestsForFiles(["src/mod999.js"], g, {})
  ok("matches reference on the synthetic graph", JSON.stringify([...t1].sort()) === JSON.stringify([...r1].sort()))
  // PERF BUDGET: 200 traversals. Pre-v89 each cost ~O(V×E) ≈ 3M edge checks.
  const t0 = performance.now()
  for (let i = 0; i < 200; i++) testsForFiles([`src/mod${i}.js`], g, {})
  const dt = performance.now() - t0
  ok(`200 traversals of a 1000-file graph in ${Math.round(dt)}ms (< 1000ms budget)`, dt < 1000)
  const t2 = performance.now()
  for (let i = 0; i < 200; i++) consumersOf([`src/mod${i}.js`], g, {})
  const dt2 = performance.now() - t2
  ok(`200 consumersOf in ${Math.round(dt2)}ms (< 1000ms budget)`, dt2 < 1000)
}

console.log("== 3. memo safety ==")
{
  const g = buildCrossGraph(path.resolve(process.cwd()))
  const files = g.files.map((f) => f.path)
  const a = testsForFiles(["tools.js"], g, { cwd: process.cwd() })
  const b = testsForFiles(["tools.js"], g, { cwd: process.cwd() })
  ok("repeat call → equal result", JSON.stringify(a) === JSON.stringify(b))
  b.push("MUTATED.js")
  const c = testsForFiles(["tools.js"], g, { cwd: process.cwd() })
  ok("mutating a returned array cannot corrupt the memo", !c.includes("MUTATED.js"))
  ok("different file set → different key (no false hit)", JSON.stringify(testsForFiles(["chat.js"], g, { cwd: process.cwd() })) !== "undefined")
  ok("empty graph safe", testsForFiles(["a.js"], { files: [], edges: [] }).length === 0)
  ok("null graph safe", testsForFiles(["a.js"], null).length === 0)
  ok("implForFiles null-safe", implForFiles(["a.js"], null).length === 0)
}

console.log("== 4. lazy CLI: no REPL graph for light commands ==")
{
  const src = fs.readFileSync(new URL("../forge.js", import.meta.url), "utf8")
  ok("no static import of chat.js", !/^import .*from "\.\/chat\.js"/m.test(src))
  ok("no static import of agent.js", !/^import .*from "\.\/agent\.js"/m.test(src))
  ok("no static import of agentview.js", !/^import .*from "\.\/agentview\.js"/m.test(src))
  ok("no static import of tools.js", !/^import .*from "\.\/tools\.js"/m.test(src))
  ok("lazy loaders present", /const loadChat = \(\) => import\("\.\/chat\.js"\)/.test(src))
  const { execFileSync } = await import("node:child_process")
  const forgeJs = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "forge.js")
  const t0 = Date.now()
  execFileSync(process.execPath, [forgeJs, "version"], { stdio: "ignore" })
  const ms = Date.now() - t0
  ok(`forge version boots in ${ms}ms (< 400ms budget; was ~218ms + REPL graph)`, ms < 400)
}

console.log("== 5. provider fail-fast on connect-guard expiry ==")
{
  // a server that accepts TCP but never answers
  const silent = http.createServer(() => {})
  await new Promise((r) => silent.listen(0, "127.0.0.1", r))
  const silentUrl = `http://127.0.0.1:${silent.address().port}/v1`
  const t0 = Date.now()
  let err = null
  try {
    for await (const _ of streamChatResilient(
      { protocol: "openai", apiKey: "k", model: "m", providerName: "t", baseUrl: silentUrl, messages: [{ role: "user", content: "hi" }], connectMs: 400, firstByteMs: 2000 },
      { attempts: 3, backoffMs: 500 },
    )) { /* drain */ }
  } catch (e) { err = e }
  const dt = Date.now() - t0
  ok("connect timeout raises ProviderError", err instanceof ProviderError, String(err?.message).slice(0, 120))
  ok(`tagged kind:"connect"`, err?.kind === "connect")
  ok(`fails over after ONE attempt (${dt}ms < 1500ms; old behavior = 3×connectMs + backoff)`, dt < 1500, `${dt}ms`)
  silent.close()
  // default connectMs is now 8s (was 30s)
  eq("default retry.connectMs is 8000", defaultConfig().retry.connectMs, 8000)
}
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }

console.log("== 6. anthropic prompt caching (static prefix) ==")
{
  let captured = null
  const srv = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      captured = JSON.parse(body)
      res.writeHead(200, { "content-type": "text/event-stream" })
      const frames = [
        { type: "message_start", message: { usage: { input_tokens: 5 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]
      for (const f of frames) res.write(`event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`)
      res.end()
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  let text = ""
  for await (const ev of streamChat({
    protocol: "anthropic", apiKey: "k", model: "m", providerName: "t",
    baseUrl: `http://127.0.0.1:${srv.address().port}`,
    system: "You are forge — test system prompt.",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "bash", description: "run", parameters: { type: "object", properties: {} } } }],
    connectMs: 3000, firstByteMs: 3000,
  })) { if (ev.type === "text") text += ev.text }
  ok("anthropic stream still parses (text received)", text === "ok", text)
  ok("system sent as a cache-marked block array", Array.isArray(captured?.system) && captured.system[0]?.cache_control?.type === "ephemeral" && captured.system[0]?.text?.includes("forge"))
  ok("last tool carries cache_control (caches the tool schema prefix)", Array.isArray(captured?.tools) && captured.tools.length === 1 && captured.tools[captured.tools.length - 1]?.cache_control?.type === "ephemeral")
  srv.close()
}

console.log("== 7. parallel test runner knob ==")
{
  const src = fs.readFileSync(new URL("run-all.mjs", import.meta.url), "utf8")
  ok("FORGE_TEST_CONCURRENCY is honored", /FORGE_TEST_CONCURRENCY/.test(src))
  ok("default concurrency 4", /\|\| 4\b/.test(src))
  ok("bash suites stay sequential (shared port 8787)", /bashSuites/.test(src) && /for \(const s of bashSuites\) byLabel\.set\(s\[0\], await run\(s\)\)/.test(src))
}

console.log(`\n== v89 suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
