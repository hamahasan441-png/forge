/**
 * forge — provider-wire robustness tests (v20.0.1).
 * Run: node tests/test-providers.mjs
 *
 * No internet needed: a hostile HTTP server on 127.0.0.1 replays the provider
 * failures people actually hit — an HTML page answered with HTTP 200 (wrong
 * base URL / captive portal / proxy), an empty body, a stream cut mid-answer,
 * a connection reset, 429 + Retry-After, and a 400 context-overflow.
 *
 * Before v20.0.1 every one of these surfaced as a raw error:
 *   SyntaxError: Unexpected token '<' … · TypeError: fetch failed · terminated
 * and `forge doctor` reported the HTML-200 case as a WORKING provider.
 */
import http from "node:http"
import { chatOnce, streamChat, streamChatResilient, toAnthropicMessages, probe, ProviderError, CATALOG, getCatalog, envKeyFor, listModels, OPENROUTER_FREE_FALLBACK, listOpenRouterModels } from "../forge/providers.js"

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log("  ok  ", name) } else { FAIL++; console.log("  FAIL", name) } }

const server = http.createServer((req, res) => {
  const mode = String(req.url).split("/")[2] ?? "ok"
  const json = { "content-type": "application/json" }
  const send = (code, body, headers = json) => { res.writeHead(code, headers); res.end(body) }
  switch (mode) {
    case "ok": return send(200, JSON.stringify({ choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }))
    case "html": return send(200, "<html>captive portal</html>", { "content-type": "text/html" })
    case "empty": return send(200, "")
    case "garbage": return send(200, "<not json>")
    case "reset": return req.socket.destroy()
    case "429ra": return send(429, JSON.stringify({ error: { message: "rate limited" } }), { ...json, "retry-after": "2" })
    case "overflow": return send(400, JSON.stringify({ error: { message: "maximum context length is 128000 tokens, yours is 900000", code: "context_length_exceeded" } }))
    case "trunc": {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write('data: {"choices":[{"delta":{"content":"half an ans')
      setTimeout(() => res.destroy(), 30)
      return
    }
    case "stream-ok": {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
      res.write("data: [DONE]\n\n")
      return res.end()
    }
    case "stream-tools": {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}\n\n')
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a.md\\"}"}}]}}]}\n\n')
      res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')
      res.write("data: [DONE]\n\n")
      return res.end()
    }
    default: return send(200, JSON.stringify({ choices: [{ message: { role: "assistant", content: "hello" } }] }))
  }
})

await new Promise((r) => server.listen(0, "127.0.0.1", r))
const base0 = `http://127.0.0.1:${server.address().port}`
const url = (m) => `${base0}/m/${m}`
const base = { protocol: "openai", apiKey: "k", model: "m", providerName: "test", messages: [{ role: "user", content: "hi" }], connectMs: 5000, requestTimeoutMs: 5000 }

console.log("== non-JSON HTTP 200 (wrong URL / proxy / captive portal) ==")
for (const [m, sniff] of [["html", "captive portal"], ["empty", "(empty body)"], ["garbage", "<not json>"]]) {
  let e = null
  try { await chatOnce({ ...base, baseUrl: url(m) }) } catch (err) { e = err }
  ok(`${m}: throws ProviderError`, e instanceof ProviderError)
  ok(`${m}: names the problem (non-JSON)`, /non-JSON response/.test(e?.message ?? ""))
  ok(`${m}: shows what came back (${sniff})`, (e?.message ?? "").includes(sniff))
  ok(`${m}: not retried in a loop`, e?.retryable === false)
}

console.log("== stream cut mid-answer ==")
{
  let e = null
  try { for await (const _ of streamChat({ ...base, baseUrl: url("trunc"), firstByteMs: 4000 })) { /* drain */ } } catch (err) { e = err }
  ok("truncated stream → ProviderError", e instanceof ProviderError)
  ok("truncated stream explains itself", /stream interrupted/.test(e?.message ?? ""))
  ok("truncated stream is retryable", e?.retryable === true)
}

console.log("== connection reset / unreachable host ==")
{
  let e = null
  try { await chatOnce({ ...base, baseUrl: url("reset") }) } catch (err) { e = err }
  ok("reset → ProviderError", e instanceof ProviderError)
  ok("reset names the real cause", /could not reach the provider/.test(e?.message ?? ""))
  ok("reset is retryable", e?.retryable === true)
}

console.log("== streaming still assembles text + fragmented tool calls ==")
{
  let text = "", calls = null, done = false
  for await (const ev of streamChat({ ...base, baseUrl: url("stream-ok"), firstByteMs: 4000 })) {
    if (ev.type === "text") text += ev.text
    if (ev.type === "done") done = true
  }
  ok("stream-ok text", text === "hi")
  ok("stream-ok finish_reason", done)
  for await (const ev of streamChat({ ...base, baseUrl: url("stream-tools"), firstByteMs: 4000 })) {
    if (ev.type === "tool_calls") calls = ev.calls
  }
  ok("fragmented tool_call assembled", calls?.[0]?.name === "read_file" && calls?.[0]?.args === '{"path":"a.md"}')
}

console.log("== 429 + Retry-After, 400 context overflow ==")
{
  let e = null
  try { await chatOnce({ ...base, baseUrl: url("429ra") }) } catch (err) { e = err }
  ok("429 is retryable", e?.retryable === true)
  ok("Retry-After honored (2s → 2000ms)", e?.retryAfterMs === 2000)
  let o = null
  try { await chatOnce({ ...base, baseUrl: url("overflow") }) } catch (err) { o = err }
  ok("context overflow flagged", o?.contextOverflow === true)
  ok("context overflow is not retried blindly", o?.retryable === false)
}

console.log("== doctor probe ==")
{
  const good = await probe({ protocol: "openai", baseUrl: url("ok"), apiKey: "k", model: "m" })
  ok("probe: real JSON → ok", good.ok === true)
  const bad = await probe({ protocol: "openai", baseUrl: url("html"), apiKey: "k", model: "m" })
  ok("probe: HTML 200 → NOT ok", bad.ok === false)
  ok("probe: HTML 200 explains why", /did not answer like a chat-completions API/.test(bad.error ?? ""))
  const dead = await probe({ protocol: "openai", baseUrl: url("reset"), apiKey: "k", model: "m" })
  ok("probe: connection reset → NOT ok", dead.ok === false)
  ok("probe: reset message is actionable", /ECONNRESET|closed|fetch|socket|UND_ERR/i.test(dead.error ?? ""))
  const errBody = await probe({ protocol: "openai", baseUrl: url("429ra"), apiKey: "k", model: "m" })
  ok("probe: error status surfaced", errBody.ok === false && errBody.status === 429)
}

console.log("== catalog and model listing ==")
{
  ok("CATALOG is populated array", Array.isArray(CATALOG) && CATALOG.length >= 10)
  ok("getCatalog finds openai", getCatalog("openai")?.name === "openai")
  ok("getCatalog returns null for unknown", getCatalog("nonexistent_provider") === null)
  ok("envKeyFor returns null when env unset", envKeyFor("openai") === (process.env.OPENAI_API_KEY || null))
  ok("OPENROUTER_FREE_FALLBACK contains free models", Array.isArray(OPENROUTER_FREE_FALLBACK) && OPENROUTER_FREE_FALLBACK.length > 0)
  
  // listModels offline fallback
  const lm = await listModels({ protocol: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", catalog: getCatalog("openai") })
  ok("listModels returns catalog defaults when offline", lm.live === false && Array.isArray(lm.models) && lm.models.length > 0)

  // listOpenRouterModels offline fallback
  const lorm = await listOpenRouterModels({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", timeoutMs: 500 })
  ok("listOpenRouterModels fails gracefully when offline", lorm.live === false && lorm.warning !== null)

  // toAnthropicMessages conversion check
  const conv = toAnthropicMessages([{ role: "system", content: "sys" }, { role: "user", content: "hi" }])
  ok("toAnthropicMessages extracts system and translates messages", conv.system === "sys" && conv.messages.length === 1)

  // streamChatResilient smoke test
  let resilientText = ""
  for await (const ev of streamChatResilient({ ...base, baseUrl: url("stream-ok"), firstByteMs: 4000 }, { attempts: 1 })) {
    if (ev.type === "text") resilientText += ev.text
  }
  ok("streamChatResilient streams response", resilientText === "hi")
}

server.close()
console.log(`\n== provider suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
