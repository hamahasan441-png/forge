#!/usr/bin/env node
/**
 * forge — v115 "honestwise": three ways a run lied about what happened.
 *
 * All three were found by auditing v113, all three reproduced against the real
 * runtime before a line was written, and all three are the same failure in
 * different clothes — forge reporting something other than what occurred.
 *
 *  A. NOTHING STOPPED A RUN REPEATING ITSELF. A model that re-issued one tool
 *     call ran it 40/40 steps — one distinct signature, forty round trips, all
 *     paid for. toolSigCounts already existed and already called a repeated
 *     signature "a spin", but it was consulted ONLY to withhold extra budget,
 *     never to stop.
 *
 *  B. A RUN WHOSE EVERY MUTATION WAS REFUSED REPORTED COMPLETED. The governor
 *     blocked the single write_file, the model said "the task is complete",
 *     and the gate believed it: status COMPLETED, wrote=false.
 *
 *  C. A USER'S CANCEL WAS RECORDED AS A NODE FAILURE. The task level was right
 *     (CANCELLED at three abort points); the DAG was not. dag.markCancelled —
 *     written for this, cascade included — had NO caller anywhere, so the
 *     in-flight node stayed RUNNING on disk. empirics, lessons, metalearn and
 *     selfmodel all learn from node outcomes, so a person changing their mind
 *     was being learned from as the agent failing.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v115-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 260)}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const { runAgent } = await import("../agent.js")
const call = (id, n, a) => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: n, arguments: JSON.stringify(a) } }] })

/** A scripted model; `script(n)` is the message for the nth request. */
async function run(script, { task = "do the thing", agent = {}, files = { "auth.js": "export const x = 1\n" } } = {}) {
  let i = 0
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      const m = script(++i)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: m, finish_reason: m.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const w = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v115-w-"))
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(w, f), c)
  const prev = process.cwd()
  process.chdir(w)
  try {
    const r = await runAgent({
      config: { providers: {}, tools: { assumeYes: true }, agent: { autonomous: false, maxSteps: 40, verifyNudge: false, ...agent } },
      provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "mock-1" },
      task, journal: false,
    })
    return { r, dir: w }
  } finally { process.chdir(prev); srv.close() }
}

// ---------------------------------------------------------------------------
console.log("== A. a run that repeats itself stops, instead of buying 40 round trips ==")
{
  const same = () => call("c" + Math.random(), "bash", { command: "echo same-thing" })
  const { r } = await run(same)
  const sigs = (r.toolLog || []).map((t) => `${t.name}:${t.result}`)

  ok("the run stops early instead of burning the budget", r.steps <= 5, `steps=${r.steps}`)
  ok("…and it really was the same call every time", new Set(sigs).size === 1, `${new Set(sigs).size} distinct`)
  eq("the status is honest", r.status, "INCOMPLETE")
  eq("and names the loop, not a budget it never hit", r.reason, "LOOP_DETECTED")
  ok("the report says what actually happened", /repeating the same bash call with the same result/.test(String(r.text)), String(r.text).slice(0, 140))
  ok("the loop is described with evidence, not adjectives", r.loopHalt?.repeats >= 3 && r.loopHalt?.tool === "bash", JSON.stringify(r.loopHalt))

  // the guard must not fire on ordinary varied work
  const varied = (n) =>
    n === 1 ? call("a", "bash", { command: "echo one" })
    : n === 2 ? call("b", "bash", { command: "echo two" })
    : n === 3 ? call("c", "bash", { command: "echo three" })
    : { role: "assistant", content: "Looked at all three. Done." }
  const v = await run(varied)
  ok("three DIFFERENT calls are not a loop", v.r.reason !== "LOOP_DETECTED", `reason=${v.r.reason}`)
  ok("…and that run is allowed to finish", v.r.status === "COMPLETED", `status=${v.r.status} text=${String(v.r.text).slice(0, 80)}`)

  // twice is a retry, not yet a loop
  const twice = (n) =>
    n <= 2 ? call("t" + n, "bash", { command: "echo twice" })
    : { role: "assistant", content: "Ran it twice on purpose. Done." }
  const t2 = await run(twice)
  ok("the SECOND identical call is still allowed — a retry is not a loop", t2.r.reason !== "LOOP_DETECTED", `reason=${t2.r.reason}`)
}

console.log("== B. a run whose every mutation was refused is not COMPLETED ==")
{
  const refused = (n) =>
    n === 1 ? call("w1", "write_file", { path: ".env", content: "API_KEY=sk-live-0\n" })
    : { role: "assistant", content: "Added the key. The task is complete." }
  const { r } = await run(refused, { task: "fix the failing auth test", agent: { maxSteps: 8 } })

  ok("the write really was refused", (r.toolLog || []).some((t) => /^BLOCKED/.test(String(t.result))), JSON.stringify((r.toolLog || []).map((t) => String(t.result).slice(0, 40))))
  eq("nothing was written", r.wrote, false)
  eq("so the run is NOT completed — this is the bug", r.status, "INCOMPLETE")
  eq("and the reason says why, not 'resource limit'", r.reason, "MUTATIONS_REFUSED")
  ok("the text states it plainly", /every attempt to change a file was refused/.test(String(r.text)), String(r.text).slice(0, 140))
  ok("the flag is on the result for callers", r.mutationsRefused === true)

  // the narrow part: a read-only run writes nothing and must still complete
  const readOnly = (n) =>
    n === 1 ? call("r1", "read_file", { path: "auth.js" })
    : { role: "assistant", content: "auth.js exports a constant. That is the answer." }
  const ro = await run(readOnly, { task: "what does auth.js export?", agent: { maxSteps: 6 } })
  eq("a read-only run still completes", ro.r.status, "COMPLETED")
  ok("…and is not accused of refused mutations", ro.r.mutationsRefused === false, String(ro.r.reason))

  // and a run that DID write is unaffected, even if a later write is refused
  const partly = (n) =>
    n === 1 ? call("p1", "read_file", { path: "auth.js" })
    : n === 2 ? call("p2", "write_file", { path: "auth.js", content: "export const x = 2\n" })
    : n === 3 ? call("p3", "write_file", { path: ".env", content: "K=v\n" })
    : { role: "assistant", content: "Updated auth.js. Done." }
  const pw = await run(partly, { task: "bump the constant", agent: { maxSteps: 10 } })
  ok("a run that really wrote something is not called refused-only", pw.r.mutationsRefused === false, `wrote=${pw.r.wrote} reason=${pw.r.reason}`)
}

console.log("== C. a cancel is CANCELLED at the node level, never a failure ==")
{
  const { openTask, readTask } = await import("../taskstate.js")
  const dagLib = await import("../dag.js")
  const { runMeta } = await import("../meta.js")

  const g = dagLib.buildDAG([
    { id: "n1", objective: "write the parser", dependencies: [] },
    { id: "n2", objective: "write the tests", dependencies: ["n1"] },
  ])
  dagLib.markRunning(g, "n1")            // in flight when the user hits Ctrl+C

  const W = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v115-c-"))
  fs.writeFileSync(path.join(W, "package.json"), '{"name":"probe"}\n')
  const ts = openTask("t-v115-cancel", { create: true, objective: "build the parser", cwd: W })
  ts.setDAG(dagLib.serializeDAG(g))
  ts.save?.()

  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "1. do it\nEND" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const ctl = new AbortController()
  setTimeout(() => ctl.abort(), 250)
  const events = []
  const prev = process.cwd()
  process.chdir(W)
  try {
    await runMeta({
      config: { providers: {}, tools: { assumeYes: true }, agent: { autonomous: true, maxSteps: 2, maxSegments: 1 } },
      provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "mock-1" },
      task: "build the parser", resumeTaskId: "t-v115-cancel", signal: ctl.signal, onEvent: (e) => events.push(e),
    })
  } catch { /* the run ending early is the point */ }
  finally { process.chdir(prev); srv.close() }

  const rec = readTask("t-v115-cancel")
  eq("the TASK is cancelled, as it always was", rec?.status, "CANCELLED")

  const saved = rec?.dag ? dagLib.deserializeDAG(rec.dag) : null
  ok("the persisted graph exists", Boolean(saved))
  eq("the in-flight node is CANCELLED, not left RUNNING", saved?.nodes?.get("n1")?.status, dagLib.NODE_STATUS.CANCELLED)
  ok("work that never started is cancelled too, not left pending",
    saved?.nodes?.get("n2")?.status === dagLib.NODE_STATUS.CANCELLED, String(saved?.nodes?.get("n2")?.status))
  ok("NOTHING is marked FAILED — a person changing their mind is not a failure",
    saved && ![...saved.nodes.values()].some((n) => n.status === dagLib.NODE_STATUS.FAILED),
    JSON.stringify([...(saved?.nodes?.values() ?? [])].map((n) => `${n.id}:${n.status}`)))

  const ev = events.find((e) => e.type === "PLAN_CANCELLED")
  ok("a PLAN_CANCELLED event is emitted", Boolean(ev), JSON.stringify(events.map((e) => e.type).slice(-10)))
  ok("naming the nodes it cancelled", (ev?.cancelledNodes ?? []).includes("n1"), JSON.stringify(ev?.cancelledNodes))
}

console.log("== D. dag.markCancelled finally has a production caller ==")
{
  // forge's own selfaudit reported it as dead across every version that had it.
  // This is the assertion that says it no longer is.
  const { analyzeModules } = await import("../selfaudit.js")
  const forgeRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
  const r = analyzeModules({
    dir: forgeRoot, testDir: path.join(forgeRoot, "tests"),
    entryPoints: ["forge.js", "plugin-host.js", "selfaudit.js"], skipDirs: ["skills"],
  })
  const flagged = new Set(r.findings.filter((f) => f.name).map((f) => `${f.file}:${f.name}`))
  ok("selfaudit no longer reports dag.js:markCancelled as dead", !flagged.has("dag.js:markCancelled"))
  ok("the audit still works (it did not simply stop finding things)",
    r.findings.length > 0 && r.stats.modules > 100, JSON.stringify(r.stats))
}

console.log("== E. `forge undo` walks past resume markers instead of eating an undo step ==")
{
  // Fallout of (A)/(B), and a latent bug older than both: a run that ends
  // INCOMPLETE writes a BOUNDARY checkpoint — a resume marker with `files: []`.
  // restoreLast took the newest checkpoint unconditionally, so that empty
  // marker consumed the user's undo: "nothing to restore", while the real
  // pre-edit snapshot sat one step further back, uncounted.
  const { snapshotBefore, boundaryCheckpoint, restoreLast, listCheckpoints } = await import("../checkpoint.js")
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v115-undo-"))
  const file = path.join(work, "kept.txt")
  fs.writeFileSync(file, "ORIGINAL\n")

  const snap = snapshotBefore([file], work)
  fs.writeFileSync(file, "EDITED\n")
  const marker = boundaryCheckpoint(work, { runId: "r-undo", label: "budget-incomplete", objective: "t" })
  ok("the resume marker was written and holds no file content",
    Boolean(marker) && listCheckpoints(work, 99).find((c) => c.id === marker)?.files.length === 0)

  const r = restoreLast(work)
  ok("one undo restores the real snapshot, not the marker", r?.files === 1 && r?.id === snap, JSON.stringify(r))
  eq("the file is actually back", fs.readFileSync(file, "utf8"), "ORIGINAL\n")
  ok("the resume marker survives — `forge tasks --resume` still needs it",
    listCheckpoints(work, 99).some((c) => c.id === marker))
  ok("a second undo finds nothing to restore (markers are never restorable)", restoreLast(work) === null)
  fs.rmSync(work, { recursive: true, force: true })
}

console.log(`\n== v115 honestwise suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
