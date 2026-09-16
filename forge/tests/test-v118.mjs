#!/usr/bin/env node
/**
 * forge — v118 "completionwise": the governor's STOP was being spent as a
 * verdict, and it was not one.
 *
 * ROOT CAUSE, reproduced against the real runtime before a line was written.
 * Three layers, each reasonable alone:
 *
 *   1. contract.canComplete() returns ok with the words "goal satisfied OR no
 *      open requirements". That `or` is the bug: a contract with NOTHING
 *      registered in it is a closed contract.
 *   2. governor.chooseNextAction() turns that into ACTION.STOP.
 *   3. agent.js halted on it and wrote `Governor stopped: <why>` into
 *      finalText — which the completion gate downstream then read as the
 *      model's own final answer, and returned COMPLETED.
 *
 * So the task "create one.js and two.js" wrote one.js, never wrote two.js,
 * never produced an answer, and forge reported:
 *
 *     status COMPLETED · reason GOVERNOR_STOP
 *     text: "Governor stopped: goal satisfied or no open requirements"
 *
 * A verdict with an excuse attached, quoting itself as the answer.
 *
 * THE FIX: STOP is a CANDIDATE. A candidate must survive one more question,
 * asked of reality rather than of the contract or the model — is the outcome
 * the user asked for actually true on disk? The fast path for genuinely
 * finished work is untouched, which the tests below pin as hard as the bug.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v118-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 260)}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const { evaluateCompletion, missingNamedArtifacts, formatCompletionBlock, COMPLETION, BLOCKER } = await import("../completion.js")
const { runAgent } = await import("../agent.js")

const has = (list) => (p) => list.includes(p)

// ---------------------------------------------------------------------------
console.log("== A. the evaluation asks reality, not the contract ==")
{
  const base = { namedFiles: [], wrote: true, mutating: true, modelAnswered: true }
  ok("a run with evidence and nothing outstanding is complete", evaluateCompletion(base).ok)

  const missing = evaluateCompletion({ ...base, namedFiles: ["one.js", "two.js"], existsFn: has(["one.js"]) })
  eq("a file the task NAMED that does not exist blocks completion", missing.blockers.map((b) => b.code), [BLOCKER.MISSING_ARTIFACT])
  ok("and the blocker names the missing file, not a generic failure", /two\.js/.test(missing.blockers[0].why), missing.blockers[0].why)
  eq("with the action that would clear it", missing.next, "EXECUTE")
  eq("the status is BLOCKED, never COMPLETED", missing.status, COMPLETION.BLOCKED)

  ok("all named files present → no artifact blocker",
    evaluateCompletion({ ...base, namedFiles: ["one.js", "two.js"], existsFn: has(["one.js", "two.js"]) }).ok)

  // The governor's own note is not an answer. This is the exact laundering
  // that turned a STOP into a COMPLETED.
  const silent = evaluateCompletion({ ...base, modelAnswered: false })
  eq("silence is not an answer", silent.blockers.map((b) => b.code), [BLOCKER.NO_ANSWER])
  ok("and the reason says so in words", /not an answer/.test(silent.blockers[0].why), silent.blockers[0].why)

  const nothing = evaluateCompletion({ ...base, wrote: false })
  eq("a task that asked for a change and made none is not complete", nothing.blockers.map((b) => b.code), [BLOCKER.NOTHING_CHANGED])

  const failing = evaluateCompletion({ ...base, commandChecks: [{ command: "npm test", passed: false }] })
  eq("a check the run itself failed blocks completion", failing.blockers.map((b) => b.code), [BLOCKER.FAILED_CHECK])
  eq("and the next action is repair, not another attempt to stop", failing.next, "REPAIR")

  const unver = evaluateCompletion({ ...base, unverified: ["a.js"], klass: "LARGE" })
  eq("unverified writes block a LARGE task", unver.blockers.map((b) => b.code), [BLOCKER.UNVERIFIED_WRITES])
  ok("but not a MICRO one — the fast path is not taxed", evaluateCompletion({ ...base, unverified: ["a.js"], klass: "MICRO" }).ok)
}

console.log("== A2. the checks a simple task must NOT be punished by (§41) ==")
{
  // A question writes nothing, names nothing, and is complete when answered.
  ok("a read-only question completes",
    evaluateCompletion({ namedFiles: [], wrote: false, mutating: false, modelAnswered: true }).ok)
  // An analysis task that names a file it only READ must not be told the file
  // is missing — the check is existence, and the file exists.
  ok("naming a file that exists is not a blocker",
    evaluateCompletion({ namedFiles: ["src/pager.js"], existsFn: has(["src/pager.js"]), wrote: false, mutating: false, modelAnswered: true }).ok)
  eq("nothing named → nothing claimed", missingNamedArtifacts([], {}), [])
  eq("blank entries are ignored rather than reported missing", missingNamedArtifacts(["", null, "  "], { existsFn: () => false }), [])
}

console.log("== A3. the evidence runs both ways, so 'why complete?' is answerable ==")
{
  const v = evaluateCompletion({
    namedFiles: ["one.js"], existsFn: has(["one.js"]), wrote: true, mutating: true, modelAnswered: true,
    commandChecks: [{ command: "npm test", passed: true }],
  })
  ok("positive evidence is recorded, not just the verdict", v.evidence.positive.length >= 3, JSON.stringify(v.evidence.positive))
  eq("and there is nothing against it", v.evidence.negative, [])
  ok("confidence rises with evidence", v.confidence > evaluateCompletion({ namedFiles: [], wrote: true, mutating: true, modelAnswered: true }).confidence)
  const blocked = evaluateCompletion({ namedFiles: ["gone.js"], existsFn: () => false, wrote: true, mutating: true, modelAnswered: true })
  ok("a blocked candidate is stated as one line for the model, with the action",
    /TASK NOT COMPLETE/.test(formatCompletionBlock(blocked)) && /Next required action: EXECUTE/.test(formatCompletionBlock(blocked)),
    formatCompletionBlock(blocked))
  eq("a passing verdict has nothing to say to the model", formatCompletionBlock(v), "")
}

// ---------------------------------------------------------------------------
// the live path: a scripted model against the real runAgent
// ---------------------------------------------------------------------------
const call = (id, name, args) => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] })

async function runScripted(script, task, { maxSteps = 12 } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v118-work-"))
  const prev = process.cwd()
  process.chdir(work)
  let reqIdx = 0
  const seen = []
  const srv = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      reqIdx++
      try { seen.push(JSON.parse(raw || "{}").messages ?? []) } catch { seen.push([]) }
      const message = script(reqIdx, seen[seen.length - 1])
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const events = []
  const r = await runAgent({
    config: { providers: {}, tools: { autoApprove: true }, agent: { autonomous: false }, skills: { enabled: false } },
    provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, apiKey: "k", model: "mock-1", contextWindow: 128000 },
    task, journal: false, maxStepsOverride: maxSteps, onEvent: (e) => events.push(e),
  })
  srv.close()
  process.chdir(prev)
  return { r, events, work, seen }
}

const TASK = "create one.js and two.js, both exporting a constant"
const VERIFY_CMD = "node --check one.js && echo 'test ok'"

console.log("== B. THE BUG: a governor STOP over unfinished work is not a completion ==")
{
  // writes one.js, verifies it, never writes two.js, never answers.
  const { r, events, work } = await runScripted((i) =>
    i === 1 ? call("c1", "write_file", { path: "one.js", content: "export const one = 1\n" })
    : i === 2 ? call("c2", "bash", { command: VERIFY_CMD })
    : call(`c${i}`, "list_dir", { path: `d${i}` }), TASK)

  ok("two.js really is absent — the premise of the test", !fs.existsSync(path.join(work, "two.js")))
  ok("the run does NOT report COMPLETED", r.status !== "COMPLETED", `${r.status} / ${r.reason}`)
  eq("it reports the completion blocker as the reason", r.reason, "COMPLETION_BLOCKED")
  ok("and the text names the file that is missing", /two\.js/.test(String(r.text ?? "")), r.text)
  ok("a candidate was raised and refused", (r.completionCandidates ?? 0) >= 1, String(r.completionCandidates))

  const cand = events.filter((e) => e.type === "COMPLETION_CANDIDATE")
  const blocked = events.filter((e) => e.type === "COMPLETION_BLOCKED")
  ok("COMPLETION_CANDIDATE is emitted", cand.length >= 1)
  ok("COMPLETION_BLOCKED names the blocker and the next action",
    blocked.length >= 1 && blocked[0].blocker === BLOCKER.MISSING_ARTIFACT && blocked[0].next === "EXECUTE",
    JSON.stringify(blocked[0]))
  ok("GOVERNOR_STOP is NOT emitted for a refused candidate", !events.some((e) => e.type === "GOVERNOR_STOP"))
  fs.rmSync(work, { recursive: true, force: true })
}

console.log("== C. TRUE completion still stops, quickly, with no excuse attached ==")
{
  const { r, events, work } = await runScripted((i) =>
    i === 1 ? call("c1", "write_file", { path: "one.js", content: "export const one = 1\n" })
    : i === 2 ? call("c2", "write_file", { path: "two.js", content: "export const two = 2\n" })
    : i === 3 ? call("c3", "bash", { command: VERIFY_CMD })
    : { role: "assistant", content: "Created one.js and two.js, both exporting a constant." }, TASK)

  eq("the run completes", r.status, "COMPLETED")
  // v115's rule: a completed run carries no reason. A verdict with an excuse
  // attached is exactly the shape the bug had.
  eq("and carries NO reason", r.reason, null)
  ok("both files exist", fs.existsSync(path.join(work, "one.js")) && fs.existsSync(path.join(work, "two.js")))
  ok("the final text is the MODEL's answer, not a governor note",
    /Created one\.js and two\.js/.test(String(r.text ?? "")) && !/Governor stopped/.test(String(r.text ?? "")), r.text)
  ok("it did not burn the budget proving the obvious", r.steps <= 6, `${r.steps} steps`)
  ok("the candidate was accepted on the first ask", (r.completionCandidates ?? 0) <= 2, String(r.completionCandidates))
  ok("the accepted candidate carries its supporting evidence",
    (events.find((e) => e.type === "COMPLETION_CANDIDATE")?.evidence ?? []).length > 0,
    JSON.stringify(events.find((e) => e.type === "COMPLETION_CANDIDATE")))
  fs.rmSync(work, { recursive: true, force: true })
}

console.log("== D. the model is told the real blocker, and can act on it (§48) ==")
{
  // The model goes quiet after one.js. Only once it is told WHAT is missing
  // does it write two.js and answer. This is the difference between "continue"
  // and a reason.
  let toldAboutTwo = false
  const { r, work } = await runScripted((i, messages) => {
    const told = (messages ?? []).some((m) => /TASK NOT COMPLETE/.test(String(m?.content ?? "")) && /two\.js/.test(String(m?.content ?? "")))
    if (told) toldAboutTwo = true
    if (i === 1) return call("c1", "write_file", { path: "one.js", content: "export const one = 1\n" })
    if (i === 2) return call("c2", "bash", { command: VERIFY_CMD })
    if (told && !fs.existsSync(path.join(process.cwd(), "two.js"))) return call(`c${i}`, "write_file", { path: "two.js", content: "export const two = 2\n" })
    if (told) return { role: "assistant", content: "Added the missing two.js; both constants now exist." }
    return call(`c${i}`, "list_dir", { path: `d${i}` })
  }, TASK)

  ok("the blocker reached the model as a concrete instruction", toldAboutTwo)
  ok("which let it finish the work", fs.existsSync(path.join(work, "two.js")))
  eq("and the run then completes honestly", r.status, "COMPLETED")
  eq("with no reason attached", r.reason, null)
  fs.rmSync(work, { recursive: true, force: true })
}

console.log("== E. a read-only task is not taxed by any of this (§41) ==")
{
  const { r, events, work } = await runScripted((i) =>
    i === 1 ? call("c1", "list_dir", { path: "." })
    : { role: "assistant", content: "The directory is empty; there is nothing to report." },
    "explain what is in this directory")
  eq("a question that writes nothing still completes", r.status, "COMPLETED")
  eq("with no reason", r.reason, null)
  ok("and no completion candidate machinery was needed at all",
    !events.some((e) => e.type === "COMPLETION_BLOCKED"), JSON.stringify(events.filter((e) => /COMPLETION/.test(e.type)).slice(0, 3)))
  fs.rmSync(work, { recursive: true, force: true })
}

console.log("== F. a blocker that never clears ends BLOCKED, never COMPLETED (§18) ==")
{
  const { r, events, work } = await runScripted((i) =>
    i === 1 ? call("c1", "write_file", { path: "one.js", content: "export const one = 1\n" })
    : i === 2 ? call("c2", "bash", { command: VERIFY_CMD })
    : call(`c${i}`, "list_dir", { path: `d${i}` }), TASK, { maxSteps: 40 })

  ok("the run stops rather than continuing forever", r.steps < 40, `${r.steps} steps`)
  ok("it is never reported COMPLETED", r.status !== "COMPLETED", r.status)
  ok("the abandonment is announced with the blocker that won",
    events.some((e) => e.type === "COMPLETION_ABANDONED" && e.blocker === BLOCKER.MISSING_ARTIFACT),
    JSON.stringify(events.find((e) => e.type === "COMPLETION_ABANDONED")))
  ok("and the repeats are bounded, not open-ended", (r.completionCandidates ?? 0) <= 4, String(r.completionCandidates))
  fs.rmSync(work, { recursive: true, force: true })
}

console.log(`\n== v118 completionwise suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
