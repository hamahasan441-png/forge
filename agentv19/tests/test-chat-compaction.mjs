#!/usr/bin/env node
/**
 * forge — chat.js auto-compaction uses the structure-preserving pipeline (v21.1).
 * Resumes a session whose history is over the token budget, runs one turn against
 * a mock provider and inspects the REQUEST the provider actually received:
 *  - tool_calls ↔ tool results are still paired (no dangling / orphaned ids)
 *  - the compacted summary carries the deterministic ledger (files, failed command)
 *  - the summary still works when the summary model call itself fails
 *  - the prompt got smaller
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-chatcompact-"))
process.env.FORGE_HOME = HOME
process.env.FORGE_UI = "plain"
const { runChat } = await import("../forge/chat.js")
const { historyIsWellFormed } = await import("../forge/compaction.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 300) : ""}`) } }

let idc = 0
const call = (name, args) => ({ id: `c${++idc}`, type: "function", function: { name, arguments: JSON.stringify(args) } })
const turn = (calls, results) => [{ role: "assistant", content: "", tool_calls: calls }, ...calls.map((c, i) => ({ role: "tool", tool_call_id: c.id, content: results[i] }))]
const big = (n, tail) => Array.from({ length: n }, (_, i) => `line ${i} — some output that pads the history`).join("\n") + "\n" + tail
function history() {
  idc = 0
  const m = [{ role: "user", content: "please fix the failing tests" }]
  m.push(...turn([call("read_file", { path: "src/a.js" })], [big(300, "eof")]))
  m.push(...turn([call("write_file", { path: "src/a.js", content: "x" })], ["OK wrote src/a.js (12 bytes, replaced)"]))
  m.push(...turn([call("bash", { command: "npm test" })], [big(400, "2 tests failed\n[exit code: 1]")]))
  m.push({ role: "assistant", content: "The date parser is wrong; fixing." })
  for (let i = 0; i < 6; i++) m.push(...turn([call("bash", { command: `npm test -- part${i}` })], [big(300, `part${i} ok`)]))
  m.push(...turn([call("read_file", { path: "src/z.js" })], [big(100, "eof")]))
  return m
}

async function runOnce({ summaryFails }) {
  const requests = []
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c))
    req.on("end", () => {
      const j = JSON.parse(body); requests.push(j)
      const isSummary = /Summarize this conversation/.test(j.messages?.[0]?.content ?? "")
      if (isSummary && summaryFails) { res.writeHead(500, { "content-type": "application/json" }); return res.end('{"error":{"message":"summary model down"}}') }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: isSummary ? "NARRATIVE-FROM-MODEL" : "FINAL-ANSWER" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const sess = path.join(HOME, `sess-${summaryFails ? "b" : "a"}.json`)
  fs.writeFileSync(sess, JSON.stringify({ id: "s1", provider: "p", model: "m", messages: history(), usage: {} }))
  const cfg = { activeProvider: "p", providers: { p: { protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, apiKey: "k", model: "m", contextWindow: 4000 } }, chat: { stream: false, tools: false, restoreCwd: false }, skills: { enabled: false } }
  const chunks = []
  const orig = process.stdout.write.bind(process.stdout)
  process.stdout.write = (s) => { chunks.push(String(s)); return true }
  try { await runChat({ config: cfg, provider: { name: "p", ...cfg.providers.p }, oneShot: "what did we change?", resumeFile: sess }) } finally { process.stdout.write = orig; srv.close() }
  return { requests, out: chunks.join("") }
}

console.log("== compaction with a working summary model ==")
{
  const { requests, out } = await runOnce({ summaryFails: false })
  const main = requests.find((r) => !/Summarize this conversation/.test(r.messages?.[0]?.content ?? ""))
  ok("summary model was consulted", requests.some((r) => /Summarize this conversation/.test(r.messages?.[0]?.content ?? "")))
  ok("a main request was sent", !!main)
  const msgs = main?.messages ?? []
  ok("request history is well-formed (tool_calls ↔ results paired)", historyIsWellFormed(msgs), JSON.stringify(msgs.map((m) => m.role)))
  const summary = msgs.find((m) => m.role === "user" && /CONTEXT COMPACTED/.test(String(m.content)))
  ok("compacted summary present", !!summary)
  ok("summary carries the file ledger", summary && /src\/a\.js/.test(summary.content))
  ok("summary carries the failed command with its exit code", summary && /exit 1: npm test/.test(summary.content))
  ok("summary carries the model narrative", summary && /NARRATIVE-FROM-MODEL/.test(summary.content))
  ok("summary is tagged for session titles", summary && /^AUTO-COMPACTED SUMMARY/.test(summary.content))
  ok("prompt got smaller than the raw history", JSON.stringify(msgs).length < JSON.stringify(history()).length)
  ok("user saw the compaction notice", /context compacted/.test(out))
  ok("final answer produced", /FINAL-ANSWER/.test(out))
}

console.log("== compaction when the summary model fails ==")
{
  const { requests, out } = await runOnce({ summaryFails: true })
  const main = requests.find((r) => !/Summarize this conversation/.test(r.messages?.[0]?.content ?? ""))
  const msgs = main?.messages ?? []
  ok("still well-formed", historyIsWellFormed(msgs))
  const summary = msgs.find((m) => m.role === "user" && /CONTEXT COMPACTED/.test(String(m.content)))
  ok("ledger-only summary still present (no model needed)", summary && /src\/a\.js/.test(summary.content) && /exit 1: npm test/.test(summary.content))
  ok("no narrative claimed", summary && !/NARRATIVE SUMMARY/.test(summary.content))
  ok("still smaller", JSON.stringify(msgs).length < JSON.stringify(history()).length)
  ok("user told it was ledger-only", /ledger only/.test(out))
  ok("final answer still produced", /FINAL-ANSWER/.test(out))
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
console.log(`\n== chat-compaction suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
