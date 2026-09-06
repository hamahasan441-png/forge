#!/usr/bin/env node
/**
 * forge — durable task state + segment orchestration (Phase 2).
 *
 * Proves the things that make long-horizon work honest rather than merely
 * possible:
 *   - a task's history survives the process, written atomically and chmod 600
 *   - token totals COUNT unreported segments instead of folding them in as 0
 *   - a task is never more finished than its last segment says it is
 *   - continuation only ever happens on an explicit CONTINUE_REQUIRED
 *   - a segment that runs out of budget really does resume with context, and
 *     the second segment can actually finish the task
 *   - runAgent throwing marks the record FAILED and re-throws (never swallowed)
 *
 * Uses local stand-in providers; zero external network.
 */
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-task-"))
process.env.FORGE_HOME = HOME

const { AGENT_STATUS, UNKNOWN } = await import("../forge/contract.js")
const ts = await import("../forge/taskstate.js")
const { runTask, resolveMaxSegments, segmentNote, HARD_MAX_SEGMENTS } = await import("../forge/orchestrator.js")

let PASS = 0, FAIL = 0
const ok = (n, c) => { if (c) { PASS++; console.log(`  ok   ${n}`) } else { FAIL++; console.log(`  FAIL ${n}`) } }

function listen(handler) {
  const srv = http.createServer(handler)
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)))
}
const body = (msg, usage) => JSON.stringify({
  choices: [{ message: msg, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }],
  ...(usage ? { usage } : {}),
})
const cfgFor = (port, maxSteps = 3) => ({
  providers: {}, agent: { maxSteps }, skills: { enabled: false }, context: { repoMap: false },
})
const providerFor = (port) => ({ name: "m", protocol: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "m", contextWindow: 128000 })

const fakeResult = (over = {}) => ({
  status: AGENT_STATUS.COMPLETED, text: "done", steps: 2, budgetHit: false, wrote: false,
  toolLog: [], segmentId: "seg-1", runId: "run-1",
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  ...over,
})

console.log("== a task record is created and persisted ==")
{
  const rec = ts.createTask({ task: "refactor the parser", cwd: "/work", provider: "m", model: "mm" })
  ok("has a task id", typeof rec.taskId === "string" && rec.taskId.startsWith("task-"))
  ok("starts WAITING, not COMPLETED", rec.status === AGENT_STATUS.WAITING)
  ok("is on disk", fs.existsSync(ts.taskFile(rec.taskId)))
  ok("file is chmod 600 (it can contain sensitive task text)", (fs.statSync(ts.taskFile(rec.taskId)).mode & 0o777) === 0o600)
  ok("loads back by full id", ts.loadTask(rec.taskId)?.task === "refactor the parser")
  ok("loads back by unambiguous prefix", ts.loadTask(rec.taskId.slice(0, 12))?.taskId === rec.taskId)
  ok("an unknown id is null, not a throw", ts.loadTask("task-nope") === null)
}

console.log("== secrets never reach the task file ==")
{
  const rec = ts.createTask({ task: "use sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA to call the api", cwd: "/work" })
  const raw = fs.readFileSync(ts.taskFile(rec.taskId), "utf8")
  ok("the api key is redacted out of the persisted task", !raw.includes("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"))
}

console.log("== usage totals: UNKNOWN is counted, never summed as 0 ==")
{
  const rec = ts.createTask({ task: "t", cwd: "/work" })
  ts.recordSegment(rec.taskId, fakeResult({ status: AGENT_STATUS.CONTINUE_REQUIRED, budgetHit: true }))
  const after1 = ts.loadTask(rec.taskId)
  ok("known usage accumulates", after1.totals.totalTokens === 15 && after1.totals.unknownSegments === 0)

  ts.recordSegment(rec.taskId, fakeResult({ usage: { promptTokens: UNKNOWN, completionTokens: UNKNOWN, totalTokens: UNKNOWN } }))
  const after2 = ts.loadTask(rec.taskId)
  ok("an unreported segment does not change the token total", after2.totals.totalTokens === 15)
  ok("it is COUNTED as unreported instead", after2.totals.unknownSegments === 1)
  ok("the total is never NaN", Number.isFinite(after2.totals.totalTokens))
  ok("step/tool counts still accumulate", after2.totals.steps === 4 && after2.totals.segments === 2)
}

console.log("== a task is exactly as finished as its last segment ==")
{
  const rec = ts.createTask({ task: "t", cwd: "/work" })
  ts.recordSegment(rec.taskId, fakeResult())
  ok("COMPLETED segment → COMPLETED task", ts.loadTask(rec.taskId).status === AGENT_STATUS.COMPLETED)
  ts.recordSegment(rec.taskId, fakeResult({ status: AGENT_STATUS.CONTINUE_REQUIRED, budgetHit: true }))
  ok("a later unfinished segment un-finishes the task", ts.loadTask(rec.taskId).status === AGENT_STATUS.CONTINUE_REQUIRED)
  ok("and it reports as resumable", ts.isResumable(ts.loadTask(rec.taskId)))
  ok("a COMPLETED task is not resumable", !ts.isResumable({ status: AGENT_STATUS.COMPLETED }))
  const bad = ts.recordSegment(rec.taskId, fakeResult({ status: "TOTALLY_FINE" }))
  ok("an invalid status is recorded as FAILED, not trusted", bad.segments.at(-1).status === AGENT_STATUS.FAILED)
}

console.log("== setTaskStatus + retention caps ==")
{
  const rec = ts.createTask({ task: "t", cwd: "/work" })
  ok("setTaskStatus records a terminal outcome", ts.setTaskStatus(rec.taskId, AGENT_STATUS.FAILED, { note: "provider died" })?.status === AGENT_STATUS.FAILED)
  ok("the note is persisted", ts.loadTask(rec.taskId).lastText.includes("provider died"))
  ok("an invalid status is refused, not written", ts.setTaskStatus(rec.taskId, "NOPE") === null && ts.loadTask(rec.taskId).status === AGENT_STATUS.FAILED)
  ok("an unknown task id is refused", ts.setTaskStatus("task-nope", AGENT_STATUS.FAILED) === null)
  ok("retention caps are real numbers", ts.MAX_TASKS > 0 && ts.MAX_SEGMENTS > 0)

  const long = ts.createTask({ task: "many segments", cwd: "/work" })
  for (let i = 0; i < ts.MAX_SEGMENTS + 5; i++) ts.recordSegment(long.taskId, fakeResult())
  const grown = ts.loadTask(long.taskId)
  ok("segment history is bounded", grown.segments.length === ts.MAX_SEGMENTS)
  ok("but the totals still count every segment that ran", grown.totals.segments === ts.MAX_SEGMENTS + 5)
}

console.log("== continuation prompt carries real context ==")
{
  const rec = ts.createTask({ task: "add a --verbose flag", cwd: "/work" })
  ts.recordSegment(rec.taskId, fakeResult({ status: AGENT_STATUS.CONTINUE_REQUIRED, budgetHit: true, wrote: true, text: "edited cli.js, tests still failing" }),
    { note: "3 step(s), 2 tool call(s) (edit_file), changed files" })
  const prompt = ts.continuationPrompt(ts.loadTask(rec.taskId))
  ok("restates the original task", prompt.includes("add a --verbose flag"))
  ok("says which segment this is", /segment 2/.test(prompt))
  ok("carries where the last segment stopped", prompt.includes("tests still failing"))
  ok("warns that files may already be changed", /ALREADY have been changed/.test(prompt))
  ok("carries the earlier segment's note", prompt.includes("edit_file"))
}

console.log("== listing + pruning are totally ordered ==")
{
  const dir = path.join(HOME, "tasks")
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true })
  const ids = []
  for (let i = 0; i < 5; i++) ids.push(ts.createTask({ task: `t${i}`, cwd: "/work" }).taskId)
  // force an exact updatedAt tie: order must still be deterministic, because
  // pruneTasks DELETES in this order and a tie could otherwise drop the newer.
  for (const id of ids) {
    const f = ts.taskFile(id)
    const rec = JSON.parse(fs.readFileSync(f, "utf8"))
    rec.updatedAt = 1700000000000
    fs.writeFileSync(f, JSON.stringify(rec))
  }
  const a = ts.listTasks({ all: true }).map((r) => r.taskId)
  const b = ts.listTasks({ all: true }).map((r) => r.taskId)
  ok("a tie orders deterministically", JSON.stringify(a) === JSON.stringify(b))
  ok("the tie-break is by id", JSON.stringify(a) === JSON.stringify([...a].sort()))
  ok("cwd filter excludes other directories", ts.listTasks({ cwd: "/elsewhere" }).length === 0)
  ok("cwd filter includes matching ones", ts.listTasks({ cwd: "/work" }).length === 5)

  fs.writeFileSync(path.join(dir, "garbage.json"), "{not json")
  ok("a corrupt record is skipped, not thrown", ts.listTasks({ all: true }).length === 5)

  ok("pruning keeps the newest N", ts.pruneTasks(2) === 3 && ts.listTasks({ all: true }).length === 2)
  ok("pruning under the cap removes nothing", ts.pruneTasks(50) === 0)
}

console.log("== segment budget is a hard ceiling ==")
{
  ok("default is 1 — no continuation unless asked for", resolveMaxSegments({}, undefined) === 1)
  ok("config value is honoured", resolveMaxSegments({ agent: { maxSegments: 4 } }, undefined) === 4)
  ok("an override beats config", resolveMaxSegments({ agent: { maxSegments: 4 } }, 2) === 2)
  ok("a string flag value works", resolveMaxSegments({}, "3") === 3)
  ok("a bare boolean flag is not read as 1-by-accident-of-Number(true)", resolveMaxSegments({}, true) === 1)
  ok("garbage falls back to 1", resolveMaxSegments({}, "banana") === 1 && resolveMaxSegments({}, -5) === 1)
  ok("no config can exceed the hard ceiling", resolveMaxSegments({ agent: { maxSegments: 9999 } }, undefined) === HARD_MAX_SEGMENTS)
}

console.log("== segmentNote summarises what a segment did ==")
{
  const n = segmentNote(fakeResult({ steps: 4, wrote: true, toolLog: [{ name: "edit_file" }, { name: "edit_file" }, { name: "run_shell" }] }))
  ok("counts steps and tool calls", /4 step\(s\)/.test(n) && /3 tool call\(s\)/.test(n))
  ok("names the distinct tools once each", /edit_file, run_shell/.test(n))
  ok("flags that files changed", /changed files/.test(n))
}

console.log("== runTask: one segment by default (existing behavior unchanged) ==")
{
  const srv = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(body({ role: "assistant", content: "" , tool_calls: [
      { id: "c1", type: "function", function: { name: "think", arguments: JSON.stringify({ thought: "spin" }) } },
    ] }))
  })
  const r = await runTask({ config: cfgFor(0, 2), provider: providerFor(srv.address().port), task: "spin", cwd: "/work" })
  ok("stops after one segment", r.segments === 1)
  ok("reports CONTINUE_REQUIRED, not success", r.status === AGENT_STATUS.CONTINUE_REQUIRED)
  ok("says the budget was exhausted", r.budgetExhausted === true)
  ok("the task record is on disk and resumable", ts.isResumable(ts.loadTask(r.taskId)))
  srv.close()
}

console.log("== runTask: a second segment actually finishes the work ==")
{
  // First call: only tool calls (budget runs out). After the continuation
  // prompt arrives, answer for real. The provider decides by looking for the
  // continuation marker, so this proves the NEXT segment really was given the
  // continuation context rather than the bare task.
  let sawContinuation = false
  const srv = await listen((req, res) => {
    let raw = ""
    req.on("data", (d) => { raw += d })
    req.on("end", () => {
      const isCont = raw.includes("continuation context")
      if (isCont) sawContinuation = true
      res.writeHead(200, { "content-type": "application/json" })
      res.end(isCont
        ? body({ role: "assistant", content: "FINISHED IT" }, { prompt_tokens: 3, completion_tokens: 2 })
        : body({ role: "assistant", content: "", tool_calls: [
            { id: "c1", type: "function", function: { name: "think", arguments: JSON.stringify({ thought: "spin" }) } },
          ] }))
    })
  })
  const r = await runTask({ config: cfgFor(0, 2), provider: providerFor(srv.address().port), task: "do the thing", cwd: "/work", maxSegments: 3 })
  ok("the second segment received the continuation context", sawContinuation)
  ok("it ran exactly two segments — it stopped once done", r.segments === 2)
  ok("final status is COMPLETED", r.status === AGENT_STATUS.COMPLETED)
  ok("budgetExhausted is false once finished", r.budgetExhausted === false)
  ok("the final answer is the second segment's", r.text === "FINISHED IT")
  const rec = ts.loadTask(r.taskId)
  ok("both segments are recorded", rec.segments.length === 2)
  ok("segment statuses are recorded in order", rec.segments[0].status === AGENT_STATUS.CONTINUE_REQUIRED && rec.segments[1].status === AGENT_STATUS.COMPLETED)
  ok("totals count only what was reported", rec.totals.totalTokens === 5 && rec.totals.unknownSegments === 1)
  srv.close()
}

console.log("== continuation must not silently escalate cost or mislabel segments ==")
{
  // The continuation prompt is long by construction. Classifying THAT instead
  // of the real task scored it "complex" on word count alone, which would have
  // put every resumed segment on the expensive DEEP path regardless of the task.
  const { classifyTaskComplexity } = await import("../forge/agent.js")
  // "add a --verbose flag" scores SIMPLE on its own; wrapped it scores COMPLEX
  // purely on length, which is exactly the accidental escalation to guard.
  const trivial = "add a --verbose flag"
  const rec = ts.createTask({ task: trivial, cwd: "/work" })
  ts.recordSegment(rec.taskId, fakeResult({ status: AGENT_STATUS.CONTINUE_REQUIRED, budgetHit: true }))
  const wrapped = ts.continuationPrompt(ts.loadTask(rec.taskId))
  ok("the wrapped prompt really would have scored as deep-worthy", ["complex", "critical"].includes(classifyTaskComplexity(wrapped)))
  ok("the real task does not", !["complex", "critical"].includes(classifyTaskComplexity(trivial)))

  // and the segment banner numbers a resumed segment against the task, not the run
  const events = []
  let sawContinuation = false
  const srv = await listen((req, res) => {
    let raw = ""
    req.on("data", (d) => { raw += d })
    req.on("end", () => {
      const isCont = raw.includes("continuation context")
      if (isCont) sawContinuation = true
      res.writeHead(200, { "content-type": "application/json" })
      res.end(isCont
        ? body({ role: "assistant", content: "DONE" })
        : body({ role: "assistant", content: "", tool_calls: [
            { id: "c1", type: "function", function: { name: "think", arguments: JSON.stringify({ thought: "spin" }) } },
          ] }))
    })
  })
  const prov = providerFor(srv.address().port)
  const first = await runTask({ config: cfgFor(0, 2), provider: prov, task: "some job", cwd: "/work" })
  const resumed = await runTask({
    config: cfgFor(0, 2), provider: prov, task: "some job", cwd: "/work",
    resume: ts.loadTask(first.taskId), onEvent: (e) => events.push(e), maxSegments: 1,
  })
  ok("the resume ran and finished", sawContinuation && resumed.status === AGENT_STATUS.COMPLETED)
  const seg = events.find((e) => e.type === "segment")
  ok("a segment banner was emitted", !!seg)
  ok("it numbers the segment against the task", seg?.index === 2)
  ok("and never reports index > of (the old '2/1')", seg && seg.index <= seg.of)
  srv.close()
}

console.log("== runTask: never continues a COMPLETED segment ==")
{
  const srv = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(body({ role: "assistant", content: "ALL DONE" }, { prompt_tokens: 1, completion_tokens: 1 }))
  })
  const r = await runTask({ config: cfgFor(0, 5), provider: providerFor(srv.address().port), task: "easy", cwd: "/work", maxSegments: 5 })
  ok("one segment, even though five were allowed", r.segments === 1)
  ok("status COMPLETED", r.status === AGENT_STATUS.COMPLETED)
  srv.close()
}

console.log("== runTask: a provider failure is recorded and re-thrown, never swallowed ==")
{
  const srv = await listen((req, res) => { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "bad key" } })) })
  const cfg = cfgFor(0, 3)
  cfg.retry = { attempts: 1, backoffMs: 1 }
  let threw = false, taskId = null
  const before = ts.listTasks({ all: true }).map((r) => r.taskId)
  try {
    await runTask({ config: cfg, provider: providerFor(srv.address().port), task: "will fail", cwd: "/work" })
  } catch { threw = true }
  const after = ts.listTasks({ all: true })
  taskId = after.find((r) => !before.includes(r.taskId))?.taskId
  ok("the error reaches the caller", threw)
  ok("a task record exists for the failed run", !!taskId)
  ok("and it is recorded as FAILED, not left WAITING", ts.loadTask(taskId)?.status === AGENT_STATUS.FAILED)
  srv.close()
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
console.log(`\n== taskstate suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
