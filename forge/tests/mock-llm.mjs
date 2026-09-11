/**
 * mock-llm — local OpenAI + Anthropic compatible mock for E2E testing forge (no internet).
 *
 * GET  /v1/models                → mock model list (also matches /v1/models for anthropic)
 * GET  /hello                    → plain text page (fetch_url tool test)
 * POST /v1/chat/completions      → scripted replies (OpenAI wire):
 *   - invalid bearer key          → 401
 *   - last message role=tool      → final answer incl. tool output
 *   - FLAKY_CHECK user msg        → 429 twice, then success (retry test)
 *   - OVERFLOW_ONCE user msg      → 400 context_length_exceeded once, then success
 *   - SUBTASK_SLOW user msg       → success after 3s (delegate timeout test)
 *   - user msg USE_TOOL           → tool_call: bash echo forge-e2e-ok
 *   - user msg USE_PATH_ESCAPE    → tool_call: write_file ../../forge-escape-test.txt
 *   - user msg USE_SENSITIVE_READ → tool_call: read_file ~/.ssh/id_rsa
 *   - user msg USE_SKILL_TRAVERSAL→ tool_call: load_skill ../../etc/passwd
 *   - user msg USE_LEARN          → tool_call: memory action=learn
 *   - user msg USE_DELEGATE_SLOW  → tool_call: delegate SUBTASK_SLOW
 *   - user msg USE_URL            → tool_call: fetch_url http://127.0.0.1:8787/hello
 *   - otherwise                   → "Hello from mock!" (SSE or JSON, with reasoning)
 * POST /v1/messages              → scripted replies (Anthropic wire):
 *   - invalid x-api-key           → 401
 *   - tool_result block present   → final text "Anthropic stream OK … TOOL RESULT RECEIVED"
 *   - user msg USE_TOOL_A         → tool_use block: bash echo anthropic-e2e-ok
 *   - otherwise                   → thinking + "Hello from anthropic mock!" SSE
 */
import http from "node:http"

const PORT = Number(process.env.MOCK_PORT || 8787)
const flakyCounts = new Map()
let overflowFired = false // v20: OVERFLOW_ONCE fires exactly once per process
// v19: record the last POST body so E2E can assert the exact wire JSON
// (deep-mode system directives, reasoning params, …)
let LAST_BODY = null

// v16 fixtures: a valid multi-file patch (create + modify) and a bad one
const MOCK_PATCH = `--- /dev/null
+++ b/patch-new.txt
@@ -0,0 +1,2 @@
+patch line one
+patch line two
--- a/patch-base.txt
+++ b/patch-base.txt
@@ -1,3 +1,3 @@
 first
-old line
+NEW LINE
 third
`
const MOCK_PATCH_BAD = `--- a/patch-base.txt
+++ b/patch-base.txt
@@ -1,2 +1,2 @@
 this-context-does-not-exist
-old
+new
`

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
  let i = 0
  const tick = () => {
    if (i >= events.length) { res.write("data: [DONE]\n\n"); res.end(); return }
    res.write(`data: ${JSON.stringify(events[i++])}\n\n`)
    setTimeout(tick, 10)
  }
  tick()
}

/** Anthropic SSE frame sequence for a thinking + text reply. */
function anthropicSse(res, { thinking, text, stopReason = "end_turn" }) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
  const frames = [
    { type: "message_start", message: { usage: { input_tokens: 5 } } },
    { type: "ping" },
  ]
  let idx = 0
  if (thinking) {
    frames.push({ type: "content_block_start", index: 0, content_block: { type: "thinking" } })
    frames.push({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } })
    frames.push({ type: "content_block_stop", index: 0 })
  }
  frames.push({ type: "content_block_start", index: 1, content_block: { type: "text" } })
  frames.push({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text } })
  frames.push({ type: "content_block_stop", index: 1 })
  frames.push({ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 7 } })
  frames.push({ type: "message_stop" })
  const tick = () => {
    if (idx >= frames.length) { res.end(); return }
    res.write(`event: ${frames[idx].type}\ndata: ${JSON.stringify(frames[idx++])}\n\n`)
    setTimeout(tick, 8)
  }
  tick()
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost")
  if (req.method === "GET" && url.pathname.endsWith("/models")) {
    // v18: OpenRouter-style metadata (pricing + context_length) so the
    // free-models detector and `forge models --free` have real data to parse.
    // Legacy consumers only read `.id` — unaffected.
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ data: [
      { id: "mock-mini", name: "Mock Mini (free tier)", context_length: 128000, pricing: { prompt: "0", completion: "0" } },
      { id: "mock-large", name: "Mock Large", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000006" } },
      { id: "mock-coder", name: "Mock Coder", context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000002" } },
      { id: "mock-vision:free", name: "Mock Vision (free tier)", context_length: 300000, pricing: { prompt: "0", completion: "0" } },
    ] }))
    return
  }
  if (req.method === "GET" && url.pathname === "/last-body") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(LAST_BODY ?? {}))
    return
  }
  if (req.method === "GET" && url.pathname === "/hello") {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("MOCK PAGE 42 — hello from mock web")
    return
  }
  if (req.method === "GET" && url.pathname === "/search") {
    res.writeHead(200, { "content-type": "text/html" })
    const q = url.searchParams.get("q") || ""
    res.end(`<html><body><h1>results for ${q}</h1>
<a rel="nofollow" href="https://example.com/forge-docs">forge result one</a>
<p>forge is a terminal agent</p>
<a rel="nofollow" href="https://example.com/forge-github">forge result two</a>
</body></html>`)
    return
  }
  if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      let j
      try { j = JSON.parse(body) } catch { res.writeHead(400); res.end('{"error":{"message":"bad json"}}'); return }
      LAST_BODY = j
      const msgs = j?.messages ?? []
      const last = msgs[msgs.length - 1] ?? {}
      const auth = req.headers["authorization"] || ""
      if (!auth.includes("test-key")) {
        res.writeHead(401, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: "invalid api key" } }))
        return
      }

      // v17: compaction summary requests (chat + agent token reducers) carry a
      // system prompt starting with "Summarize" -> plain-text summary reply
      const sysText = msgs.find((m) => m.role === "system")?.content ?? ""
      if (sysText.includes("Summarize")) {
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "COMPACT-SUMMARY: user is testing forge; earlier steps created files; task is still in progress." }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 30 } }))
      }

      // FLAKY: 429 twice then success (streaming retry test)
      const wantsFlaky = msgs.some((m) => m.role === "user" && String(m.content).includes("FLAKY_CHECK"))
      if (wantsFlaky) {
        const n = (flakyCounts.get("f") ?? 0) + 1
        flakyCounts.set("f", n)
        if (n <= 2) {
          res.writeHead(429, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: { message: "Too many requests (mock)" } }))
          return
        }
      }

      // v20 OVERFLOW: 400 context_length_exceeded ONCE, then normal — the
      // client must compress and retry instead of dying
      if (msgs.some((m) => m.role === "user" && String(m.content).includes("OVERFLOW_ONCE")) && !overflowFired) {
        overflowFired = true
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: "context_length_exceeded: This model's maximum context length is 4096 tokens. However, your messages resulted in 98765 tokens." } }))
        return
      }

      // v20 SLOW: sub-agent that takes 3s (delegate timeout test)
      if (msgs.some((m) => m.role === "user" && String(m.content).includes("SUBTASK_SLOW"))) {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "slow subtask finished" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 3 } }))
        }, 3000)
        return
      }

      // tool result came back → final answer
      if (last.role === "tool") {
        // v17 agent token-reducer test: keep calling the LOUD tool until it ran
        // 3 times (3 big outputs), THEN produce the final answer — so the agent
        // history crosses the tiny contextWindow and mid-run compaction fires.
        const wantsLoud = msgs.some((m) => m.role === "user" && String(m.content).includes("USE_LOUD_COMPACT"))
        const toolCount = msgs.filter((m) => m.role === "tool").length
        const alreadyCompacted = msgs.some((m) => String(m?.content ?? "").includes("COMPACT-SUMMARY"))
        if (wantsLoud && toolCount < 3 && !alreadyCompacted) {
          const msg = { role: "assistant", content: "", tool_calls: [{ id: "call_loud" + toolCount, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf 'x%.0s' $(seq 1 4000)" }) } }] }
          res.writeHead(200, { "content-type": "application/json" })
          return res.end(JSON.stringify({ choices: [{ message: msg, finish_reason: "tool_calls" }] }))
        }
        const content = `Final answer. TOOL RESULT RECEIVED: ${String(last.content).slice(0, 200)}`
        if (j.stream) return sse(res, [
          { choices: [{ delta: { content }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20 } },
        ])
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20 } }))
      }

      // agent asked to use a tool
      const wantsTool = msgs.some((m) => m.role === "user" && String(m.content).includes("USE_TOOL"))
      if (wantsTool) {
        const msg = { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo forge-e2e-ok" }) } }] }
        if (j.stream) return sse(res, [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } }] }, finish_reason: null }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: "echo forge-e2e-ok" }) } }] }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ])
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify({ choices: [{ message: msg, finish_reason: "tool_calls" }] }))
      }

      // agent asked to fetch a URL (fetch_url tool test)
      const wantsUrl = msgs.some((m) => m.role === "user" && String(m.content).includes("USE_URL"))
      if (wantsUrl) {
        const msg = { role: "assistant", content: "", tool_calls: [{ id: "call_2", type: "function", function: { name: "fetch_url", arguments: JSON.stringify({ url: "http://127.0.0.1:8787/hello" }) } }] }
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify({ choices: [{ message: msg, finish_reason: "tool_calls" }] }))
      }

      // v15 tool branches
      const branch = (needle, tool, args, id) => {
        if (!msgs.some((m) => m.role === "user" && String(m.content).includes(needle))) return false
        // stream-aware: streaming rounds get SSE tool_call deltas (fragmented args),
        // non-streaming rounds get the plain JSON message
        if (j.stream) {
          sse(res, [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: id || "call_" + needle, type: "function", function: { name: tool, arguments: "" } }] }, finish_reason: null }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ])
          return true
        }
        const msg = { role: "assistant", content: "", tool_calls: [{ id: id || "call_" + needle, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ choices: [{ message: msg, finish_reason: "tool_calls" }] }))
        return true
      }
      if (branch("SUBTASK", "read_file", { path: "sub.txt" }, "call_sub")) return
      // v20 hardening branches
      if (branch("USE_PATH_ESCAPE", "write_file", { path: "../../forge-escape-test.txt", content: "escaped" }, "call_esc")) return
      if (branch("USE_SENSITIVE_READ", "read_file", { path: "~/.ssh/id_rsa" }, "call_sens")) return
      if (branch("USE_SKILL_TRAVERSAL", "load_skill", { name: "../../etc/passwd" }, "call_trav")) return
      if (branch("USE_LEARN", "memory", { action: "learn", problem: "mock test failure X", root_cause: "missing mock branch", fix: "added the branch" }, "call_learn")) return
      if (branch("USE_DELEGATE_SLOW", "delegate", { task: "SUBTASK_SLOW investigate slowly" }, "call_slowdel")) return
      if (branch("USE_OUTSIDE_RM", "bash", { command: "rm -rf /tmp/forge-e2e-outside-target" }, "call_outrm")) return
      if (branch("USE_GLOB", "glob_files", { pattern: "*.md" }, "call_glob")) return
      // v20.0.1: "**/*.md" must match files in the search ROOT too (the old
      // glob compiler required at least one "/" and silently found nothing).
      if (branch("USE_DEEPGLOB", "glob_files", { pattern: "**/*.md" }, "call_deepglob")) return
      if (branch("USE_SEARCH", "web_search", { query: "forge terminal agent", max: 4 }, "call_search")) return
      if (branch("USE_MULTI_EDIT", "multi_edit", { path: "multi.txt", edits: [{ old: "alpha", new: "ALPHA" }, { old: "gamma", new: "GAMMA" }] }, "call_multi")) return
      if (branch("USE_TODO", "todo", { action: "set", items: [{ content: "write code", status: "doing" }, { content: "run tests", status: "todo" }] }, "call_todo")) return
      if (branch("USE_MEMORY", "memory", { action: "append", text: "likes dark mode" }, "call_mem")) return
      if (branch("USE_THINK", "think", { thought: "plan: inspect then answer" }, "call_think")) return
      if (branch("USE_DELEGATE", "delegate", { task: "SUBTASK read sub.txt and report the token inside" }, "call_deleg")) return
      // v17: huge tool output -> drives the agent token-reducer (compaction) test
      if (branch("USE_LOUD_COMPACT", "bash", { command: "printf 'x%.0s' $(seq 1 4000)" }, "call_loud")) return

      // v16 branches
      if (branch("USE_PATCH", "apply_patch", { patch: MOCK_PATCH }, "call_patch")) return
      if (branch("PATCH_FAIL", "apply_patch", { patch: MOCK_PATCH_BAD }, "call_patchbad")) return
      if (branch("USE_GIT", "git_status", {}, "call_git")) return
      // two read-only tool calls in ONE round → parallel execution test
      if (msgs.some((m) => m.role === "user" && String(m.content).includes("USE_TWO_READS"))) {
        const msg = { role: "assistant", content: "", tool_calls: [
          { id: "call_r1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "sub.txt" }) } },
          { id: "call_r2", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "multi.txt" }) } },
        ] }
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify({ choices: [{ message: msg, finish_reason: "tool_calls" }] }))
      }

      // v19 terminal mode: the model must SEE the user's terminal runs
      if (msgs.some((m) => m.role === "user" && String(m.content ?? "").includes("[terminal]"))) {
        const content = "TERMINAL NOTE SEEN — forge shared the terminal output with me."
        if (j.stream) return sse(res, [
          { choices: [{ delta: { content }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 9 } },
        ])
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 9 } }))
      }

      // plain chat (with reasoning delta to test deep-think rendering)
      if (j.stream) {
        return sse(res, [
          { choices: [{ delta: { reasoning_content: "thinking about it..." }, finish_reason: null }] },
          { choices: [{ delta: { content: "Hello " }, finish_reason: null }] },
          { choices: [{ delta: { content: "from mock!" }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 4 } },
        ])
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Hello from mock!" }, finish_reason: "stop" }] }))
    })
    return
  }
  // Anthropic wire protocol (/v1/messages)
  if (req.method === "POST" && url.pathname.endsWith("/messages")) {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      let j
      try { j = JSON.parse(body) } catch { res.writeHead(400); res.end(JSON.stringify({ type: "error", error: { message: "bad json" } })); return }
      LAST_BODY = j
      const auth = req.headers["x-api-key"] || ""
      if (!auth.includes("test-key")) {
        res.writeHead(401, { "content-type": "application/json" })
        res.end(JSON.stringify({ type: "error", error: { message: "invalid api key" } }))
        return
      }
      const msgs = j?.messages ?? []
      const last = msgs[msgs.length - 1] ?? {}
      const blockText = (m) => Array.isArray(m.content) ? m.content.filter((b) => b.type === "text" || b.type === "tool_result").map((b) => b.text ?? JSON.stringify(b.content ?? "")).join(" ") : String(m.content ?? "")

      let reply = { thinking: "anthropic thinking deeply...", text: "Hello from anthropic mock!" }
      // tool result round-trip → final answer
      if (Array.isArray(last.content) && last.content.some((b) => b.type === "tool_result")) {
        reply = { thinking: "anthropic assembling answer...", text: `Anthropic stream OK. TOOL RESULT RECEIVED: ${blockText(last).slice(0, 160)}` }
      } else if (msgs.some((m) => m.role === "user" && blockText(m).includes("USE_TOOL_A"))) {
        if (j.stream) {
          // streaming tool_use with FRAGMENTED json — tests input_json_delta assembly
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
          const frames = [
            { type: "message_start", message: { usage: { input_tokens: 5 } } },
            { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_s1", name: "bash" } },
            { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":' } },
            { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"echo anthropic-e2e-ok"}' } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 6 } },
            { type: "message_stop" },
          ]
          let i = 0
          const tick = () => {
            if (i >= frames.length) { res.end(); return }
            res.write(`event: ${frames[i].type}\ndata: ${JSON.stringify(frames[i++])}\n\n`)
            setTimeout(tick, 8)
          }
          tick()
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify({
          id: "msg_1", type: "message", role: "assistant", stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: { command: "echo anthropic-e2e-ok" } }],
          usage: { input_tokens: 5, output_tokens: 6 },
        }))
      }

      if (j.stream) return anthropicSse(res, reply)
      // non-streaming request → JSON message (like the real API)
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({
        id: "msg_2", type: "message", role: "assistant", stop_reason: "end_turn",
        content: [...(reply.thinking ? [{ type: "thinking", thinking: reply.thinking }] : []), { type: "text", text: reply.text }],
        usage: { input_tokens: 5, output_tokens: 7 },
      }))
    })
    return
  }
  res.writeHead(404); res.end("not found")
})

server.listen(PORT, "127.0.0.1", () => console.log(`mock-llm listening on 127.0.0.1:${PORT}`))
