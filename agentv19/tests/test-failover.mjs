#!/usr/bin/env node
/**
 * forge — provider failover unit + integration checks (v20.2).
 * Two local HTTP servers stand in for providers: "bad" always rejects, "good"
 * answers. Verifies buildProvider/fallbackChain ordering and that runAgent
 * switches to the fallback (only when opted in) and produces the good answer.
 * Zero external network.
 */
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fo-"))

const { buildProvider, fallbackChain, isFailoverWorthy, ProviderError, providerCompatible, nextCompatibleFallback } = await import("../forge/providers.js")
const { runAgent } = await import("../forge/agent.js")
const { runChat } = await import("../forge/chat.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }

function listen(handler) {
  const srv = http.createServer(handler)
  return new Promise((res) => srv.listen(0, "127.0.0.1", () => res(srv)))
}
const answer = (content) => JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })

// "bad" provider: always 401 (hard auth failure → failworthy, non-retryable = fast)
const bad = await listen((req, res) => { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":{"message":"invalid api key (mock)"}}') })
// "good" provider: answers on the first call
const good = await listen((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(answer("FAILOVER-ANSWER-OK")) })
})
const badBase = `http://127.0.0.1:${bad.address().port}/v1`
const goodBase = `http://127.0.0.1:${good.address().port}/v1`

const cfg = (failover) => ({
  failover,
  activeProvider: "bad",
  providers: {
    bad: { protocol: "openai", baseUrl: badBase, apiKey: "k1", model: "bad-model" },
    good: { protocol: "openai", baseUrl: goodBase, apiKey: "k2", model: "good-model" },
  },
  agent: { maxSteps: 6, timeoutSec: 5 },
  skills: { enabled: false },
})

console.log("== isFailoverWorthy ==")
ok("429 (retryable) is failover-worthy", isFailoverWorthy(new ProviderError("rate", { status: 429 })))
ok("503 (retryable) is failover-worthy", isFailoverWorthy(new ProviderError("down", { status: 503 })))
ok("401 (auth) is failover-worthy", isFailoverWorthy(new ProviderError("bad key", { status: 401 })))
ok("404 (not found) is failover-worthy", isFailoverWorthy(new ProviderError("no model", { status: 404 })))
ok("400 (bad request) is NOT failover-worthy", !isFailoverWorthy(new ProviderError("bad req", { status: 400, retryable: false })))
ok("context overflow is NOT failover-worthy", !isFailoverWorthy(new ProviderError("too big", { status: 400, contextOverflow: true })))
ok("a plain Error is NOT failover-worthy", !isFailoverWorthy(new Error("boom")))

console.log("== buildProvider ==")
const bp = buildProvider(cfg(true), "good")
ok("buildProvider returns runnable object", bp && bp.baseUrl === goodBase && bp.model === "good-model")
ok("buildProvider null for unknown/unusable", buildProvider(cfg(true), "nope") === null)

console.log("== fallbackChain ==")
const chain = fallbackChain(cfg(true), "bad", { health: {} })
ok("chain excludes the active provider", !chain.some((p) => p.name === "bad"))
ok("chain includes the configured fallback", chain.some((p) => p.name === "good"))
const chain2 = fallbackChain(cfg(true), "bad", { health: { good: { ok: true } } })
ok("tested providers come first", chain2[0]?.name === "good")

console.log("== runAgent failover ON ==")
{
  const events = []
  const provider = buildProvider(cfg(true), "bad")
  const r = await runAgent({ config: cfg(true), provider, task: "say hi", onEvent: (e) => events.push(e) })
  ok("agent recovers via failover and answers", /FAILOVER-ANSWER-OK/.test(r.text))
  ok("a failover event was emitted", events.some((e) => e.type === "failover" && /good/.test(e.to)))
}

console.log("== runAgent failover OFF ==")
{
  let threw = false
  const provider = buildProvider(cfg(false), "bad")
  try { await runAgent({ config: cfg(false), provider, task: "say hi", onEvent: () => {} }) }
  catch { threw = true }
  ok("without opt-in, a dead provider still fails the task", threw)
}

console.log("== runChat failover ON (interactive loop) ==")
{
  // capture stdout while runChat streams its one-shot answer
  const chunks = []
  const orig = process.stdout.write.bind(process.stdout)
  process.stdout.write = (s, ...a) => { chunks.push(String(s)); return true }
  try {
    const cfgChat = { ...cfg(true), chat: { stream: false, tools: false }, skills: { enabled: false } }
    const provider = buildProvider(cfgChat, "bad")
    await runChat({ config: cfgChat, provider, oneShot: "say hi" })
  } finally {
    process.stdout.write = orig
  }
  const out = chunks.join("")
  ok("chat recovers via failover and prints the good answer", /FAILOVER-ANSWER-OK/.test(out))
  ok("chat announces the provider switch", /switching to good/.test(out))
}

console.log("== runChat failover OFF ==")
{
  const chunks = []
  const orig = process.stdout.write.bind(process.stdout)
  process.stdout.write = (s, ...a) => { chunks.push(String(s)); return true }
  try {
    const cfgChat = { ...cfg(false), chat: { stream: false, tools: false }, skills: { enabled: false } }
    const provider = buildProvider(cfgChat, "bad")
    await runChat({ config: cfgChat, provider, oneShot: "say hi" })
  } finally {
    process.stdout.write = orig
  }
  const out = chunks.join("")
  ok("without opt-in, chat does not switch providers", !/switching to good/.test(out) && !/FAILOVER-ANSWER-OK/.test(out))
}

console.log("== v21.1 P1: failover only to a COMPATIBLE provider ==")
{
  const big = { name: "big", model: "m", protocol: "openai", contextWindow: 200000 }
  const small = { name: "small", model: "tiny", protocol: "openai", contextWindow: 8000 }
  const notool = { name: "raw", model: "x", protocol: "completions", contextWindow: 128000 }
  ok("fits: small prompt on a small window", providerCompatible(small, { promptTokens: 1000, tools: false }).ok)
  ok("does not fit: prompt larger than window", !providerCompatible(small, { promptTokens: 9000 }).ok)
  ok("headroom respected (prompt = window - 100 is refused)", !providerCompatible(small, { promptTokens: 7900 }).ok)
  ok("fits on the big window", providerCompatible(big, { promptTokens: 9000 }).ok)
  ok("tools required → protocol without tool calls is refused", !providerCompatible(notool, { promptTokens: 10, tools: true }).ok)
  ok("no tools needed → any protocol", providerCompatible(notool, { promptTokens: 10, tools: false }).ok)
  const registry = { m: { capabilities: ["coding"], contextWindow: 200000 }, tiny: { capabilities: ["fast"], contextWindow: 8000 } }
  ok("registry capability requirement enforced", !providerCompatible(small, { promptTokens: 10, capabilities: ["coding"] }, { registry }).ok && providerCompatible(big, { promptTokens: 10, capabilities: ["coding"] }, { registry }).ok)
  ok("registry window overrides provider window", !providerCompatible({ ...big, model: "tiny" }, { promptTokens: 9000 }, { registry }).ok)
  ok("a user-configured window overrides the registry", providerCompatible({ ...big, model: "tiny", configuredContextWindow: 64000 }, { promptTokens: 9000 }, { registry }).ok)
  // v21.1: the built-in registry is consulted by default (no {registry} needed)
  const { MODEL_CAPABILITY_REGISTRY, lookupRegistry } = await import("../forge/modelregistry.js")
  ok("built-in registry is import-free and knows common models", lookupRegistry("openai/gpt-4o-mini")?.capabilities?.includes("fast") && Object.keys(MODEL_CAPABILITY_REGISTRY).length > 20)
  const mini = { name: "x", protocol: "openai", model: "gpt-4o-mini", contextWindow: 128000 }
  const strong = { name: "y", protocol: "openai", model: "claude-sonnet-4-5", contextWindow: 200000 }
  const unknown = { name: "z", protocol: "openai", model: "my-local-llm", contextWindow: 32000 }
  ok("default registry: fast-tier model refused when reasoning is required", !providerCompatible(mini, { promptTokens: 10, capabilities: ["reasoning"] }).ok)
  ok("default registry: reasoning model accepted", providerCompatible(strong, { promptTokens: 10, capabilities: ["reasoning"] }).ok)
  ok("unknown model is NOT refused on capability (no registry entry → no claim)", providerCompatible(unknown, { promptTokens: 10, capabilities: ["reasoning"] }).ok)
  ok("unknown model still refused on window", !providerCompatible(unknown, { promptTokens: 31000 }).ok)
  ok("buildProvider derives the window from the registry when config omits it", buildProvider({ providers: { anth: { protocol: "anthropic", baseUrl: "http://127.0.0.1:1/", apiKey: "k", model: "claude-sonnet-4-5" } } }, "anth").contextWindow === 200000)
  ok("buildProvider keeps an explicit config window", buildProvider({ providers: { anth: { protocol: "anthropic", baseUrl: "http://127.0.0.1:1/", apiKey: "k", model: "claude-sonnet-4-5", contextWindow: 50000 } } }, "anth").contextWindow === 50000)
  const pick = nextCompatibleFallback([small, notool, big], 0, { promptTokens: 9000, tools: true })
  ok("skips incompatible candidates and names why", pick.next === big && pick.skipped.length === 2 && /does not fit/.test(pick.skipped[0].reason) && /tool calls/.test(pick.skipped[1].reason))
  ok("index advances past the chosen one", pick.idx === 3)
  const none = nextCompatibleFallback([small, notool], 0, { promptTokens: 9000, tools: true })
  ok("no compatible fallback → next is null (caller must STOP)", none.next === null && none.skipped.length === 2)
  ok("empty chain → null", nextCompatibleFallback([], 0, {}).next === null)
}

console.log("== runAgent: incompatible fallback is skipped / stops safely ==")
{
  // "good" would answer but its window is tiny → agent must NOT switch to it
  const cfgSmall = { ...cfg(true), providers: { bad: { ...cfg(true).providers.bad }, good: { ...cfg(true).providers.good, contextWindow: 64 } } }
  const events = []
  let threw = null
  try { await runAgent({ config: cfgSmall, provider: buildProvider(cfgSmall, "bad"), task: "say hi", onEvent: (e) => events.push(e) }) } catch (e) { threw = e }
  ok("did not switch to a model that cannot hold the context", !events.some((e) => e.type === "failover"))
  ok("the skip is observable", events.some((e) => e.type === "failover_skipped" && /does not fit/.test(e.reason)))
  ok("stops with an explicit error naming the reason", threw && /no compatible fallback/.test(threw.message) && /does not fit/.test(threw.message))
  // with a compatible third provider it still recovers
  const cfg3 = { ...cfgSmall, providers: { ...cfgSmall.providers, good2: { protocol: "openai", baseUrl: goodBase, apiKey: "k3", model: "good-model" } } }
  const ev2 = []
  const r = await runAgent({ config: cfg3, provider: buildProvider(cfg3, "bad"), task: "say hi", onEvent: (e) => ev2.push(e) })
  ok("skips the incompatible one and lands on the compatible one", /FAILOVER-ANSWER-OK/.test(r.text) && ev2.some((e) => e.type === "failover" && /good2/.test(e.to)) && ev2.some((e) => e.type === "failover_skipped"))
}

console.log("== runAgent: deep-effort task needs a reasoning-capable fallback ==")
{
  // fallback "good" serves gpt-4o-mini (registry: fast, no reasoning); the task is complex → deep effort
  const cfgMini = { ...cfg(true), providers: { bad: { ...cfg(true).providers.bad }, good: { ...cfg(true).providers.good, model: "gpt-4o-mini" } } }
  const events = []
  let threw = null
  try { await runAgent({ config: cfgMini, provider: buildProvider(cfgMini, "bad"), task: "say hi", deep: true, onEvent: (e) => events.push(e) }) } catch (e) { threw = e }
  ok("fast-tier fallback skipped for a deep-effort run", events.some((e) => e.type === "failover_skipped" && /lacks required capability reasoning/.test(e.reason)))
  ok("stops instead of downgrading the model silently", threw && /no compatible fallback/.test(threw.message))
  // same config, standard effort → the fast model is fine
  const r = await runAgent({ config: cfgMini, provider: buildProvider(cfgMini, "bad"), task: "say hi", deep: false, onEvent: () => {} })
  ok("standard effort still fails over to the fast model", /FAILOVER-ANSWER-OK/.test(r.text))
  // deep effort with a reasoning-capable fallback → recovers
  const cfgStrong = { ...cfgMini, providers: { ...cfgMini.providers, good: { ...cfgMini.providers.good, model: "claude-sonnet-4-5", protocol: "openai" } } }
  const r2 = await runAgent({ config: cfgStrong, provider: buildProvider(cfgStrong, "bad"), task: "say hi", deep: true, onEvent: () => {} })
  ok("deep effort fails over to a reasoning-capable model", /FAILOVER-ANSWER-OK/.test(r2.text))
}

bad.close(); good.close()
try { fs.rmSync(process.env.FORGE_HOME, { recursive: true, force: true }) } catch {}
console.log(`\n== failover suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
