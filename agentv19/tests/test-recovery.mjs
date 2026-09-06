#!/usr/bin/env node
/**
 * forge — recovery + effect reconciliation (Phase 4).
 *
 * The failure this closes: a segment that changed files and then died (provider
 * dropped, process killed) left partial edits and NO record of which files it
 * had touched. Nobody — user or a resuming agent — could tell.
 *
 * What is proven here, against real checkpoints on real temp files:
 *   - checkpoint manifests are the source of truth for what a run changed, and
 *     several runs of one task roll back as a single, correctly-ordered unit
 *   - a task records the files each segment changed (from the manifests)
 *   - reconcileTask names the divergence between the record and the disk, and
 *     flags ABANDONED when a writing segment FAILED — but never repairs
 *   - end to end: a real write through the agent's own write tool is recorded,
 *     reconciles CLEAN, and `forge tasks undo` removes it
 *
 * Zero external network (a local stand-in provider drives the real write tool).
 */
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-recov-"))
process.env.FORGE_HOME = HOME

const { AGENT_STATUS } = await import("../forge/contract.js")
const cp = await import("../forge/checkpoint.js")
const ts = await import("../forge/taskstate.js")
const { runTask } = await import("../forge/orchestrator.js")

let PASS = 0, FAIL = 0
const ok = (n, c) => { if (c) { PASS++; console.log(`  ok   ${n}`) } else { FAIL++; console.log(`  FAIL ${n}`) } }

const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "forge-work-"))
function listen(handler) {
  const srv = http.createServer(handler)
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)))
}
const body = (msg) => JSON.stringify({ choices: [{ message: msg, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }] })
const providerFor = (port) => ({ name: "m", protocol: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "m", contextWindow: 128000 })
const cfg = (maxSteps = 5) => ({ providers: {}, agent: { maxSteps }, skills: { enabled: false }, context: { repoMap: false } })

console.log("== checkpoint: filesFromRun reads the manifests, across edits ==")
{
  const d = mkdir()
  const a = path.join(d, "a.txt"), b = path.join(d, "b.txt")
  fs.writeFileSync(a, "A0")
  cp.snapshotBefore([a], d, [], "run-1")           // edit existing a
  fs.writeFileSync(a, "A1")
  const id2 = cp.snapshotBefore([], d, [b], "run-1") // create b
  fs.writeFileSync(b, "B0"); cp.sealCreated(id2, d)
  cp.snapshotBefore([a], d, [], "run-1")           // edit a again, same run
  fs.writeFileSync(a, "A2")

  const files = cp.filesFromRun(d, "run-1")
  ok("both files are reported once each", files.length === 2)
  ok("a is not marked created (it pre-existed)", files.find((f) => f.path === a).created === false)
  ok("b is marked created", files.find((f) => f.path === b).created === true)
  ok("an unknown run reports nothing", cp.filesFromRun(d, "run-nope").length === 0)
  ok("a null run id reports nothing, not a throw", cp.filesFromRun(d, null).length === 0)
}

console.log("== checkpoint: restoreRuns unwinds several runs newest→oldest ==")
{
  const d = mkdir()
  const f = path.join(d, "f.txt")
  fs.writeFileSync(f, "ORIGINAL")
  // run-1 edits it, run-2 edits it again — two segments touching one file
  cp.snapshotBefore([f], d, [], "run-1"); fs.writeFileSync(f, "AFTER-RUN-1")
  cp.snapshotBefore([f], d, [], "run-2"); fs.writeFileSync(f, "AFTER-RUN-2")
  ok("file holds the latest content before undo", fs.readFileSync(f, "utf8") === "AFTER-RUN-2")

  const r = cp.restoreRuns(d, ["run-1", "run-2"])
  ok("restore reports both runs", r && r.runIds.length === 2)
  // The ordering claim: unwinding newest→oldest across runs returns the file to
  // its TRUE pre-task state, not run-1's intermediate content.
  ok("the file is back to its original pre-task content", fs.readFileSync(f, "utf8") === "ORIGINAL")
  ok("an empty run list is null, not a throw", cp.restoreRuns(d, []) === null)
}

console.log("== checkpoint: same-millisecond checkpoints unwind in creation order ==")
{
  // Regression: ids used to tie on the ms timestamp and sort by a RANDOM
  // suffix, so a tight burst of checkpoints could roll back out of order and
  // leave intermediate content. Make many edits in one tight loop (same ms) and
  // demand the file returns to its exact original.
  const d = mkdir()
  const f = path.join(d, "burst.txt")
  fs.writeFileSync(f, "V0")
  for (let i = 1; i <= 12; i++) { cp.snapshotBefore([f], d, [], "burst"); fs.writeFileSync(f, "V" + i) }
  ok("file holds the last write", fs.readFileSync(f, "utf8") === "V12")
  const r = cp.restoreRuns(d, ["burst"])
  ok("all 12 checkpoints were replayed", r && r.checkpoints === 12)
  ok("the file is back to its exact original despite same-ms ids", fs.readFileSync(f, "utf8") === "V0")
}

console.log("== checkpoint: a created file is removed on restore ==")
{
  const d = mkdir()
  const n = path.join(d, "new.txt")
  const id = cp.snapshotBefore([], d, [n], "run-x")
  fs.writeFileSync(n, "created"); cp.sealCreated(id, d)
  ok("the file exists after creation", fs.existsSync(n))
  cp.restoreRuns(d, ["run-x"])
  ok("undo removes a file the run created", !fs.existsSync(n))
}

console.log("== taskstate: a task records the files each segment changed ==")
{
  const rec = ts.createTask({ task: "t", cwd: "/work" })
  ts.recordSegment(rec.taskId, { status: AGENT_STATUS.CONTINUE_REQUIRED, text: "", steps: 1, budgetHit: true, wrote: true, toolLog: [], runId: "run-1", segmentId: "s1", usage: {} },
    { files: [{ path: "/work/x.js", created: true }] })
  ts.recordSegment(rec.taskId, { status: AGENT_STATUS.COMPLETED, text: "done", steps: 1, budgetHit: false, wrote: true, toolLog: [], runId: "run-2", segmentId: "s2", usage: {} },
    { files: [{ path: "/work/x.js", created: false }, { path: "/work/y.js", created: true }] })
  const loaded = ts.loadTask(rec.taskId)
  ok("run ids are collected in order", JSON.stringify(ts.taskRunIds(loaded)) === JSON.stringify(["run-1", "run-2"]))
  const files = ts.taskFiles(loaded)
  ok("files are deduplicated across segments", files.length === 2)
  ok("created-ness is sticky: a file created then edited stays created", files.find((f) => f.path === "/work/x.js").created === true)
}

console.log("== taskstate: reconcile reports CLEAN / DIVERGED / ABANDONED, never repairs ==")
{
  const d = mkdir()
  const present = path.join(d, "here.js"), gone = path.join(d, "gone.js")
  fs.writeFileSync(present, "x")

  const clean = ts.createTask({ task: "t", cwd: d })
  ts.recordSegment(clean.taskId, { status: AGENT_STATUS.COMPLETED, text: "", steps: 1, budgetHit: false, wrote: true, toolLog: [], runId: "r1", segmentId: "s", usage: {} },
    { files: [{ path: present, created: true }] })
  const rc1 = ts.reconcileTask(ts.loadTask(clean.taskId))
  ok("all files present → CLEAN", rc1.status === ts.RECONCILE.CLEAN)
  ok("it lists the present file", rc1.present.includes(present) && rc1.missing.length === 0)

  const div = ts.createTask({ task: "t", cwd: d })
  ts.recordSegment(div.taskId, { status: AGENT_STATUS.COMPLETED, text: "", steps: 1, budgetHit: false, wrote: true, toolLog: [], runId: "r2", segmentId: "s", usage: {} },
    { files: [{ path: present, created: false }, { path: gone, created: true }] })
  const rc2 = ts.reconcileTask(ts.loadTask(div.taskId))
  ok("a changed file that no longer exists → DIVERGED", rc2.status === ts.RECONCILE.DIVERGED)
  ok("the missing file is named", rc2.missing.includes(gone))

  const ab = ts.createTask({ task: "t", cwd: d })
  ts.recordSegment(ab.taskId, { status: AGENT_STATUS.FAILED, text: "died", steps: 0, budgetHit: false, wrote: true, toolLog: [], runId: "r3", segmentId: "s", usage: {} },
    { files: [{ path: present, created: false }] })
  ts.setTaskStatus(ab.taskId, AGENT_STATUS.FAILED)
  const rc3 = ts.reconcileTask(ts.loadTask(ab.taskId))
  ok("a writing segment that FAILED → ABANDONED", rc3.status === ts.RECONCILE.ABANDONED)
  ok("the note warns about partial edits", rc3.notes.some((n) => /partial edits/.test(n)))
  ok("reconcile did NOT touch the file (report, never repair)", fs.readFileSync(present, "utf8") === "x")
  ok("it reports the task as undoable", rc3.undoable === true)
}

console.log("== continuationPrompt names abandoned partial edits ==")
{
  const d = mkdir()
  const f = path.join(d, "half.js"); fs.writeFileSync(f, "partial")
  const rec = ts.createTask({ task: "finish the refactor", cwd: d })
  ts.recordSegment(rec.taskId, { status: AGENT_STATUS.FAILED, text: "died mid-edit", steps: 0, budgetHit: false, wrote: true, toolLog: [], runId: "r", segmentId: "s", usage: {} },
    { files: [{ path: f, created: false }] })
  ts.setTaskStatus(rec.taskId, AGENT_STATUS.FAILED)
  const prompt = ts.continuationPrompt(ts.loadTask(rec.taskId))
  ok("names the changed file", prompt.includes(f))
  ok("warns the edits may be partial", /PARTIAL/.test(prompt))
}

console.log("== end to end: a real write is recorded, reconciles CLEAN, and undo removes it ==")
{
  const d = mkdir()
  const target = path.join(d, "created-by-agent.txt")
  // The stand-in provider writes a file via the agent's OWN write tool, then
  // (on the follow-up round) gives a final answer.
  const srv = await listen((req, res) => {
    let raw = ""
    req.on("data", (x) => { raw += x })
    req.on("end", () => {
      const wroteAlready = raw.includes("OK wrote") || raw.includes("created-by-agent")
      res.writeHead(200, { "content-type": "application/json" })
      if (wroteAlready) {
        res.end(body({ role: "assistant", content: "done — file created" }))
      } else {
        res.end(body({ role: "assistant", content: "", tool_calls: [
          { id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: target, content: "hello from the agent" }) } },
        ] }))
      }
    })
  })
  const r = await runTask({ config: cfg(6), provider: providerFor(srv.address().port), task: "create the file", cwd: d, maxSegments: 1 })
  srv.close()

  ok("the file was actually written", fs.existsSync(target))
  ok("the run completed", r.status === AGENT_STATUS.COMPLETED)
  const rec = ts.loadTask(r.taskId)
  ok("the segment recorded the file it wrote", ts.taskFiles(rec).some((f) => f.path === target))
  ok("the written file is marked created", ts.taskFiles(rec).find((f) => f.path === target)?.created === true)
  const rc = ts.reconcileTask(rec)
  ok("reconcile is CLEAN — record matches disk", rc.status === ts.RECONCILE.CLEAN)

  // now undo the whole task's file effects, the way `forge tasks undo` does
  const undo = cp.restoreRuns(d, ts.taskRunIds(rec))
  ok("undo restored something", undo && undo.files >= 1)
  ok("the agent-created file is gone after undo", !fs.existsSync(target))
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
console.log(`\n== recovery suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
