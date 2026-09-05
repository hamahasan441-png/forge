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

const { buildProvider, fallbackChain } = await import("../forge/providers.js")
const { runAgent } = await import("../forge/agent.js")

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

bad.close(); good.close()
try { fs.rmSync(process.env.FORGE_HOME, { recursive: true, force: true }) } catch {}
console.log(`\n== failover suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
