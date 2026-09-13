#!/usr/bin/env node
/**
 * v93 "sensewise" — the units + the wiring, proven.
 *
 *  1. runtime.js — background process manager: spawn/poll/status/kill/list,
 *     exit-code evidence, ring-buffer honesty, live cap, lifetime fuse,
 *     port detection (heuristic + live /proc), dispose.
 *  2. repl.js — persistent Node REPL: state persistence across calls,
 *     top-level await, console capture, incomplete-input reset (.break),
 *     timeout honesty (never fabricates), session cap, kill/restart.
 *  3. codesearch.js — meaning-ranked search: relevance, honest zero-hits,
 *     bounded scan, hybrid rerank with a controlled embed fn.
 *  4. tools.js wiring — 25 defs, dispatch round-trips, READ-ONLY gating
 *     (spawn/repl-run blocked, observation allowed), VERIFIER gating
 *     (§29 observation allowed, execution forbidden), secret redaction.
 *  5. capabilities — registry 1:1 with the wire, WRITE_TOOLS agreement.
 *  6. BEHAVIORAL: runAgent against a local mock provider drives the real
 *     `process` tool end-to-end — the tool def reaches the provider, the
 *     dispatcher executes, the result flows back into the conversation.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93-work-"))
process.chdir(WORK)
fs.writeFileSync(path.join(WORK, "auth-session.js"), "export function validateSession(token) {\n  // session validation logic for user auth\n  return token ? true : false\n}\n")
fs.writeFileSync(path.join(WORK, "billing.js"), "export function chargeCard(amount) {\n  // charge the customer credit card\n  return { charged: amount }\n}\n")
fs.writeFileSync(path.join(WORK, "util.js"), "export const pad = (s) => String(s).padStart(2, '0')\n")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 260) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const runtime = await import("../runtime.js")
const replmod = await import("../repl.js")
const cs = await import("../codesearch.js")
const { execTool, makeToolContext, disposeToolManagers, toolCount, TOOL_DEFS, VERIFICATION_TOOLS, verificationAllows } = await import("../tools.js")
const { BUILTIN_CAPABILITIES, checkWriteClassification, defaultRegistry } = await import("../capabilities.js")

// ---------------------------------------------------------------------------
console.log("== 1. runtime.js — background process manager ==")
{
  // pure heuristic
  eq("parseListeningPorts finds 'listening on port N'", runtime.parseListeningPorts("server listening on port 3000\n"), [3000])
  eq("parseListeningPorts finds localhost:5173", runtime.parseListeningPorts("ready at http://localhost:5173/"), [5173])
  eq("parseListeningPorts dedupes", runtime.parseListeningPorts("listening on 8080 and port 8080"), [8080])
  eq("parseListeningPorts: no noise without evidence", runtime.parseListeningPorts("hello world"), [])
  eq("parseListeningPorts: garbage never throws", runtime.parseListeningPorts(null), [])

  const mgr = runtime.createProcessManager({ installSignalHandlers: false, maxHistory: 4 })

  // spawn → poll → exit code evidence
  const sp = mgr.spawn({ command: "echo proc-probe-ok" })
  ok("spawn returns ok with an id and pid", sp.ok && /^p\d+$/.test(sp.entry.id) && sp.entry.pid > 0)
  ok("spawn state is running", sp.entry.state === "running")
  const poll = await mgr.poll(sp.entry.id, { waitMs: 2000 })
  ok("poll collects the output", poll.ok && /proc-probe-ok/.test(poll.out), JSON.stringify(poll.out))
  ok("poll reports new bytes", poll.outNewBytes > 0)
  await new Promise((r) => setTimeout(r, 250))
  const st = mgr.status(sp.entry.id)
  ok("exit code is captured as evidence (exited 0)", st.entry.state === "exited" && st.entry.exitCode === 0)
  ok("runtime seconds are recorded", typeof st.entry.runtimeSec === "number" && st.entry.runtimeSec >= 0)

  // second poll returns NO new output (cursor advanced)
  const poll2 = await mgr.poll(sp.entry.id, { waitMs: 200 })
  eq("second poll: no duplicated output", poll2.outNewBytes, 0)

  // named spawn + rejection of a live-name collision… after death it's reusable
  const n1 = mgr.spawn({ command: "sleep 5", name: "watcher" })
  ok("named spawn works", n1.ok && n1.entry.id === "watcher")
  const dup = mgr.spawn({ command: "sleep 5", name: "watcher" })
  ok("duplicate live id is rejected honestly", !dup.ok && /already running/.test(dup.error))
  const killed = mgr.kill("watcher", "SIGKILL")
  ok("kill reports the signal was sent", killed.ok && /SIGKILL sent/.test(killed.note))
  await new Promise((r) => setTimeout(r, 300))
  const stK = mgr.status("watcher")
  ok("killed state is evidence, not assumption", stK.entry.state === "killed" && stK.entry.signal === "SIGKILL")

  // empty command rejected
  ok("empty command rejected", !mgr.spawn({ command: "   " }).ok)

  // list: live + bounded history
  const ls = mgr.list()
  ok("list separates live and history", Array.isArray(ls.live) && Array.isArray(ls.history) && ls.history.length >= 2)
  ok("history is bounded", ls.history.length <= 4)

  // live cap
  const capped = runtime.createProcessManager({ installSignalHandlers: false, maxLive: 2 })
  const a = capped.spawn({ command: "sleep 5", name: "c1" })
  const b = capped.spawn({ command: "sleep 5", name: "c2" })
  const c = capped.spawn({ command: "sleep 5", name: "c3" })
  ok("live cap enforced with the honest error listing ids", a.ok && b.ok && !c.ok && /limit reached/.test(c.error) && /c1, c2/.test(c.error))
  capped.dispose()
  await new Promise((r) => setTimeout(r, 400))
  eq("dispose kills everything", capped._liveCount(), 0)

  // lifetime fuse — resource fuse, never a completion claim
  const fused = runtime.createProcessManager({ installSignalHandlers: false })
  const f = fused.spawn({ command: "sleep 60", name: "fuse" })
  const fuse2 = fused.spawn({ command: "sleep 60", name: "fuse2", timeoutSec: 1 })
  await new Promise((r) => setTimeout(r, 1600))
  const stF = fused.status("fuse2")
  ok("timeout fuse kills and states timeout-killed (NOT exited 0)", stF.entry.state === "timeout-killed" && stF.entry.timedOut === true, stF.entry.state)
  ok("the other process is untouched", fused.status("fuse").entry.state === "running")
  fused.dispose()
  mgr.dispose()

  // port detection — heuristic on dead processes, /proc on live ones (Linux)
  {
    const pm = runtime.createProcessManager({ installSignalHandlers: false })
    const srvFile = path.join(WORK, ".v93-srv.js")
    fs.writeFileSync(srvFile, "require('node:http').createServer((q,s)=>s.end('ok')).listen(0,'127.0.0.1',()=>console.log('up'))\nsetInterval(()=>{},10000)\n")
    const live = pm.spawn({ command: `node ${srvFile}`, name: "srv" })
    await new Promise((r) => setTimeout(r, 900))
    const stv = pm.status("srv")
    if (process.platform === "linux") {
      ok("live port DETECTED from the OS socket table (no 'listening' text printed)", stv.entry.state === "running" && stv.entry.ports.length === 1 && stv.entry.ports[0] > 0, JSON.stringify(stv.entry.ports))
    } else {
      ok("non-Linux: ports stay empty, never guessed", stv.entry.ports.length === 0)
    }
    pm.kill("srv", "SIGKILL")
    await new Promise((r) => setTimeout(r, 300))
    // heuristic: text evidence survives the process
    const dead = runtime.createProcessManager({ installSignalHandlers: false })
    dead.spawn({ command: "echo listening on port 45999" })
    await new Promise((r) => setTimeout(r, 500))
    const d = dead.list().history[0]
    ok("heuristic ports from output survive process death", d.ports.includes(45999), JSON.stringify(d.ports))
    dead.dispose()
    pm.dispose()
  }
}

// ---------------------------------------------------------------------------
console.log("== 2. repl.js — persistent Node REPL ==")
{
  // pure prompt stripping
  eq("stripReplPrompts removes the ready prompt", replmod.stripReplPrompts("Welcome to Node.js v24.19.0.\nType \".help\" for more information.\n> undefined\n> "), "undefined")
  ok("stripReplPrompts removes continuation prompt prefixes", replmod.stripReplPrompts("| | undefined\n") === "undefined")
  eq("stripReplPrompts: garbage never throws", replmod.stripReplPrompts(null), "")

  const rm = replmod.createReplManager({ installSignalHandlers: false })

  const r1 = await rm.run("main", "const data = [1,2,3,4,5]")
  ok("run 1 ok (session auto-starts)", r1.ok)
  ok("fresh-session note is reported, not hidden", /session started fresh/.test(r1.note ?? ""))
  const r2 = await rm.run("main", "data.reduce((a,b)=>a+b,0)")
  ok("const persistence across calls (sum 15)", r2.ok && /15/.test(r2.output), JSON.stringify(r2.output))
  const r3 = await rm.run("main", "let doubled = data.map(x => x * 2); doubled.length")
  ok("let persistence + completion value (5)", r3.ok && /5/.test(r3.output), JSON.stringify(r3.output))
  const r4 = await rm.run("main", "console.log('log-line'); 'ret-value'")
  ok("console.log captured AND completion value returned", r4.ok && /log-line/.test(r4.output) && /ret-value/.test(r4.output), JSON.stringify(r4.output))
  const r5 = await rm.run("main", "await Promise.resolve('await-ok')")
  ok("top-level await works (real Node REPL semantics)", r5.ok && /await-ok/.test(r5.output), JSON.stringify(r5.output))
  const r6 = await rm.run("main", "function mk() {\n  return 7\n}\nmk()")
  ok("multiline input evaluated in one call (7)", r6.ok && /7/.test(r6.output), JSON.stringify(r6.output))

  // incomplete input → honest error + .break reset + usable after
  const r7 = await rm.run("main", "function broken( {")
  ok("incomplete input reported as an error", !r7.ok && /incomplete JavaScript input/.test(r7.error))
  const r8 = await rm.run("main", "data.length")
  ok("session usable after the .break reset (5)", r8.ok && /5/.test(r8.output), JSON.stringify(r8.output))

  // timeout honesty — never fabricates a result
  const rm2 = replmod.createReplManager({ installSignalHandlers: false, timeoutMs: 1000 })
  const t1 = await rm2.run("t", "const slow = await new Promise(r => setTimeout(r, 30000))")
  ok("timeout is an ERROR, never a fake result", !t1.ok && /still running/.test(t1.error))
  const t2 = await rm2.run("t", "1+1")
  ok("busy session refuses concurrent runs honestly", !t2.ok && /still evaluating/.test(t2.error))
  rm2.kill("t")
  const t3 = await rm2.run("t", "2+2")
  ok("kill resets: next run starts fresh (4)", t3.ok && /4/.test(t3.output))

  // status / list / kill
  const sl = rm.list()
  ok("list shows the session with call count", sl.ok && sl.sessions.some((s) => s.name === "main" && s.calls >= 8))
  const stt = rm.status("main")
  ok("status is ready after clean evaluations", stt.ok && stt.session.state === "ready")
  ok("status of unknown session is an honest error", !rm.status("nope").ok)

  // session cap
  const rm3 = replmod.createReplManager({ installSignalHandlers: false, maxSessions: 1 })
  const s1 = await rm3.run("a", "1")
  const s2 = await rm3.run("b", "1")
  ok("session cap enforced with the ids listed", s1.ok && !s2.ok && /session limit/.test(s2.error) && /a/.test(s2.error))
  rm3.dispose()
  rm.dispose()
  rm2.dispose()
}

// ---------------------------------------------------------------------------
console.log("== 3. codesearch.js — meaning-ranked search ==")
{
  const r = await cs.semanticSearch(WORK, "where do we validate user sessions for auth")
  ok("relevant file ranked first", r.ok && r.hits[0]?.path === "auth-session.js", JSON.stringify(r.hits?.[0]?.path))
  ok("hits carry line ranges and real scores", r.hits[0]?.start === 1 && typeof r.hits[0]?.score === "number" && r.hits[0]?.score > 0)
  ok("snippet lines are trimmed content", Array.isArray(r.hits[0]?.snippet) && r.hits[0].snippet.length > 0 && r.hits[0].snippet[0].startsWith("export function"))
  ok("mode is bm25 without an embed fn", r.mode === "bm25")

  const wrong = await cs.semanticSearch(WORK, "credit card charge billing")
  ok("a different query finds the OTHER file first", wrong.ok && wrong.hits[0]?.path === "billing.js")

  const zero = await cs.semanticSearch(WORK, "kubernetes helm chart deployment")
  ok("zero hits are honest, not empty arrays", zero.ok === false && /no chunk scored above zero/.test(zero.note ?? ""))

  const empty = await cs.semanticSearch(WORK, "   ")
  ok("empty query is an error", !empty.ok)

  const none = await cs.semanticSearch(path.join(WORK, "nope"), "anything")
  ok("missing root reports no files honestly", !none.ok && /no source\/config files/.test(none.note ?? ""))

  // hybrid: a controlled embed fn that makes the query vector point at
  // billing.js chunks (query and billing docs get the SAME vector)
  const fake = (texts) => texts.map((t) => (t.includes("billing.js") || /session validation auth/.test(t) ? [0, 1] : [1, 0]))
  const hy = await cs.semanticSearch(WORK, "session validation auth", { embed: fake, alpha: 1 })
  ok("hybrid rerank reorders the shortlist (embed fn honored)", hy.ok && hy.hits[0]?.path === "billing.js" && hy.mode === "hybrid", `${hy.mode} ${hy.hits?.[0]?.path}`)

  const fail = (texts) => { throw new Error("embeddings endpoint down") }
  const fb = await cs.semanticSearch(WORK, "session validation auth", { embed: fail })
  ok("embedding failure degrades to BM25, never breaks search", fb.ok && fb.mode === "bm25-fallback" && fb.hits[0]?.path === "auth-session.js")

  const fmt = cs.formatSemanticSearch(r, "query text")
  ok("format is bounded text with header, path:lines and snippet bars", /SEMANTIC SEARCH "query text"/.test(fmt) && /auth-session\.js:1-5/.test(fmt) && /\n  \| /.test(fmt))
  ok("format of a zero-hit result explains itself", /no chunk scored/.test(cs.formatSemanticSearch(zero, "q")))
}

// ---------------------------------------------------------------------------
console.log("== 4. tools.js wiring — defs, dispatch, gating, redaction ==")
{
  const names = TOOL_DEFS.map((t) => t.function.name)
  eq("toolCount is 26", toolCount(), 26)
  eq("TOOL_DEFS length is 26", TOOL_DEFS.length, 26)
  for (const n of ["process", "repl", "semantic_search"]) ok(`${n} in TOOL_DEFS`, names.includes(n))

  const tools = makeToolContext({ cwd: WORK, root: WORK, skillsDir: null })
  const ctx = tools.ctx

  // process round-trip through the REAL dispatcher
  const sp = await execTool(ctx, "process", { action: "spawn", command: "echo tool-probe-ok", name: "tp" })
  ok("execTool process spawn", typeof sp === "string" && /spawned tp/.test(sp))
  await new Promise((r) => setTimeout(r, 300))
  const po = await execTool(ctx, "process", { action: "poll", id: "tp", wait_ms: 1200 })
  ok("execTool process poll returns the output", typeof po === "string" && /tool-probe-ok/.test(po))
  // kill on a LIVE process (echo already exited) — signal-sent evidence
  const spLive = await execTool(ctx, "process", { action: "spawn", command: "sleep 30", name: "tKill" })
  ok("execTool process spawn (live)", typeof spLive === "string" && /spawned tKill/.test(spLive))
  const ki = await execTool(ctx, "process", { action: "kill", id: "tKill", signal: "SIGKILL" })
  ok("execTool process kill (SIGKILL sent to a live process)", typeof ki === "string" && /SIGKILL sent/.test(ki))
  const ls = await execTool(ctx, "process", { action: "list" })
  ok("execTool process list", typeof ls === "string" && /live:/.test(ls))
  const bad = await execTool(ctx, "process", { action: "explode" })
  ok("unknown process action is an error", /ERROR: unknown process action/.test(bad))

  // repl through the dispatcher
  const rr = await execTool(ctx, "repl", { action: "run", session: "wire", code: "6 * 7" })
  ok("execTool repl run (42)", typeof rr === "string" && /42/.test(rr))
  const rl = await execTool(ctx, "repl", { action: "list" })
  ok("execTool repl list", typeof rl === "string" && /wire: ready/.test(rl))

  // semantic_search through the dispatcher
  const ss = await execTool(ctx, "semantic_search", { query: "session validation auth", limit: 2 })
  ok("execTool semantic_search", typeof ss === "string" && /auth-session\.js/.test(ss))
  const sempty = await execTool(ctx, "semantic_search", { query: "" })
  ok("execTool semantic_search empty query error", /ERROR/.test(sempty))

  // READ-ONLY gating: observation allowed, action blocked
  const ro = makeToolContext({ cwd: WORK, root: WORK, skillsDir: null, readOnly: true })
  ok("read-only: process spawn BLOCKED", /BLOCKED/.test(await execTool(ro.ctx, "process", { action: "spawn", command: "echo x" })))
  ok("read-only: process list ALLOWED", !(await execTool(ro.ctx, "process", { action: "list" })).startsWith("BLOCKED"))
  ok("read-only: process status ALLOWED (observation)", !(await execTool(ro.ctx, "process", { action: "status", id: "tp" })).startsWith("BLOCKED"))
  ok("read-only: repl run BLOCKED", /BLOCKED/.test(await execTool(ro.ctx, "repl", { action: "run", code: "1" })))
  ok("read-only: repl list ALLOWED", !(await execTool(ro.ctx, "repl", { action: "list" })).startsWith("BLOCKED"))
  ok("read-only: semantic_search ALLOWED", !(await execTool(ro.ctx, "semantic_search", { query: "auth" })).startsWith("BLOCKED"))

  // VERIFIER gating (§29): observation is verification, execution is not
  const vf = makeToolContext({ cwd: WORK, root: WORK, skillsDir: null, mode: "verifier" })
  ok("verifier defs include process + semantic_search, NOT repl", vf.defs.some((t) => t.function.name === "process") && vf.defs.some((t) => t.function.name === "semantic_search") && !vf.defs.some((t) => t.function.name === "repl"))
  ok("verifier: process spawn BLOCKED", /BLOCKED.*poll\/status\/list only/.test(await execTool(vf.ctx, "process", { action: "spawn", command: "echo x" })))
  ok("verifier: process list ALLOWED", !(await execTool(vf.ctx, "process", { action: "list" })).startsWith("BLOCKED"))
  ok("verifier: repl run BLOCKED (not in the verification set)", /BLOCKED/.test(await execTool(vf.ctx, "repl", { action: "run", code: "1" })))
  ok("verifier: semantic_search ALLOWED", !(await execTool(vf.ctx, "semantic_search", { query: "auth" })).startsWith("BLOCKED"))
  ok("verificationAllows: process poll ok / spawn not", verificationAllows("process", { action: "poll" }).ok === true && verificationAllows("process", { action: "spawn" }).ok === false)

  // secret redaction — process output is redacted like bash
  const sec = await execTool(ctx, "process", { action: "spawn", command: "echo sk-live-abcdefghijklmnop1234", name: "sec" })
  await new Promise((r) => setTimeout(r, 300))
  const secp = await execTool(ctx, "process", { action: "poll", id: "sec", wait_ms: 1000 })
  ok("process output passes secret redaction", typeof secp === "string" && !/sk-live-abcdefghijklmnop1234/.test(secp) && /redact/i.test(secp), String(secp).slice(0, 160))
  await execTool(ctx, "process", { action: "kill", id: "sec", signal: "SIGKILL" })

  disposeToolManagers()
}

// ---------------------------------------------------------------------------
console.log("== 5. capabilities — registry invariants hold with the 3 new tools ==")
{
  const reg = defaultRegistry({})
  eq("registry 1:1 with the wire (26)", BUILTIN_CAPABILITIES.length, TOOL_DEFS.length)
  eq("checkWriteClassification: no disagreement", checkWriteClassification(reg).length, 0)
  for (const n of ["process", "repl", "semantic_search"]) ok(`${n} registered`, reg.has(n))
  ok("process/repl are read_only baselines (action-gated like memory)", reg.get("process").read_only === true && reg.get("repl").read_only === true)
  ok("semantic_search is read-only AND parallel-safe", reg.get("semantic_search").read_only === true && reg.get("semantic_search").parallel_safe === true)
  ok("process carries the EXECUTE class", reg.get("process").classes.includes("EXECUTE"))
  ok("process/repl are NOT parallel-safe (shared state)", reg.get("process").parallel_safe === false && reg.get("repl").parallel_safe === false)
}

// ---------------------------------------------------------------------------
console.log("== 6. BEHAVIORAL: runAgent drives the real process tool end-to-end ==")
{
  // a real HTTP server the agent will spawn in the background, then poll
  const srvFile = path.join(WORK, "v93-agent-srv.js")
  fs.writeFileSync(srvFile, "require('node:http').createServer((q,s)=>s.end('sensewise-agent-ok')).listen(0,'127.0.0.1',()=>console.log('agent srv up'))\nsetInterval(()=>{},10000)\n")

  // mock OpenAI-compatible provider: turn 1 = process spawn tool call,
  // turn 2 = final text. Every request must SHOW the tool defs (proof the
  // 25 defs reach the provider). The TEST then polls the server itself.
  let turn = 0
  let sawDefs = false
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && /chat\/completions$/.test(req.url)) {
      let body = ""
      req.on("data", (c) => { body += c })
      req.on("end", () => {
        try {
          const j = JSON.parse(body)
          if (j.tools?.some((t) => t.function?.name === "process") && j.tools?.some((t) => t.function?.name === "semantic_search") && j.tools?.some((t) => t.function?.name === "repl")) sawDefs = true
        } catch {}
        turn++
        const mk = (message, finish) => JSON.stringify({
          id: "chat_mock", object: "chat.completion", created: Date.now(), model: "mock-1",
          choices: [{ index: 0, message, finish_reason: finish }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        })
        res.writeHead(200, { "content-type": "application/json" })
        if (turn === 1) {
          res.end(mk({ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "process", arguments: JSON.stringify({ action: "spawn", command: `node ${srvFile}`, name: "agentsrv" }) } }] }, "tool_calls"))
        } else {
          res.end(mk({ role: "assistant", content: "sensewise behavioral probe done" }, "stop"))
        }
      })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port

  const { runAgent } = await import("../agent.js")
  const events = []
  try {
    const r = await runAgent({
      config: { providers: {}, tools: {}, agent: { autonomous: false } },
      provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", model: "mock-1" },
      task: "spawn the probe server and report",
      onEvent: (e) => events.push(e),
      journal: false,
    })
    ok("runAgent completed against the mock", r.status !== "FAILED", JSON.stringify(r.error ?? ""))
    ok("the 25 tool defs reached the provider (incl. the 3 new ones)", sawDefs)
    const toolEvents = events.filter((e) => /TOOL_STARTED|TOOL_COMPLETED|tool_start|tool_done/i.test(String(e.type)))
    ok("process tool events fired through the intel pipeline", toolEvents.some((e) => JSON.stringify(e).includes("process")), events.map((e) => e.type).join(","))
    // the decisive evidence: the SINGLETON process manager actually holds the
    // server the agent spawned — the tool did not just "respond ok"
    const { getProcessManager } = await import("../tools.js")
    const mgr = getProcessManager()
    const live = mgr.status("agentsrv")
    ok("the spawned server EXISTS in the real process manager (behavioral proof)", live.ok && live.entry.command.includes("v93-agent-srv.js"), JSON.stringify(live.entry ?? live.error))
    const poll2 = await mgr.poll("agentsrv", { waitMs: 1200 })
    ok("polling it returns the real startup line", /agent srv up/.test(poll2.out), JSON.stringify(poll2.out.slice(0, 120)))
    // re-fetch AFTER the server provably booted (the earlier snapshot raced boot)
    const live2 = mgr.status("agentsrv")
    ok("its listening port was detected from the OS", live2.entry.ports.length >= 1, JSON.stringify(live2.entry.ports))
  } finally {
    server.close()
    try { disposeToolManagers() } catch {}
  }
}

console.log(`\n== v93: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
