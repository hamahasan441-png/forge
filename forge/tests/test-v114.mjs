#!/usr/bin/env node
/**
 * forge — v114 "measurewise": the learning claims become falsifiable.
 *
 * v109–v113 each assert that learning improves results — metalearn picks
 * reasoning depth from outcomes, selfmodel models forge from measured evidence,
 * caplearn lets capability health change routing, jointroute scores depth,
 * model and skill together. Nothing in the repository tested any of it.
 * `evalbench.js` shipped TWO tasks and `forge eval` had never been run against
 * a live model; bench.js says in its own header that it uses no live model.
 *
 * This suite covers the two things that make an eval number mean anything.
 *
 * 1. THE TASK SET IS REAL. For every task: the broken state must FAIL its own
 *    hidden oracle, and the known-good `solution` must PASS it. A task whose
 *    bug does not actually fail, or whose oracle cannot be satisfied, silently
 *    poisons every number computed from the set. This needs no model and runs
 *    in milliseconds, so there is no excuse for not knowing.
 *
 * 2. THE ORACLE CANNOT BE GAMED. Hidden files are written only after the agent
 *    stops, and every task carries a negative check, so a "fix" that deletes
 *    the function does not pass.
 *
 * The A/B is asserted for SHAPE and HONESTY, not for a verdict: whether
 * cognition helps is an empirical question that needs a live model and the
 * user's API key. What is pinned here is that the harness can say "no
 * difference" and that it reports a model confound instead of hiding it.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v114-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const { EVAL_TASKS, runVerification, runEvalTask, runEval, runAB, summarize, formatEvalReport, formatABReport } = await import("../evalbench.js")

const writeAll = (dir, files) => {
  for (const [rel, content] of Object.entries(files || {})) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, String(content))
  }
}
const scratch = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `forge-v114-${tag}-`))

// ---------------------------------------------------------------------------
console.log("== 1. THE GATE: every task is real ==")
{
  ok(`the set is worth running (${EVAL_TASKS.length} tasks)`, EVAL_TASKS.length >= 20, String(EVAL_TASKS.length))

  let realBugs = 0, satisfiable = 0
  const broken = [], unsatisfiable = []
  for (const t of EVAL_TASKS) {
    const b = scratch("b"); writeAll(b, t.files); writeAll(b, t.hiddenFiles)
    const bugFails = runVerification(b, t.verify)
    if (bugFails.passed === false) realBugs++; else broken.push(t.id)

    const f = scratch("f"); writeAll(f, t.solution); writeAll(f, t.hiddenFiles)
    const fixPasses = runVerification(f, t.verify)
    if (fixPasses.passed === true) satisfiable++
    else unsatisfiable.push(`${t.id}: ${String(fixPasses.output).replace(/\s+/g, " ").slice(0, 100)}`)
  }
  eq("every task's BUG fails its own hidden oracle", realBugs, EVAL_TASKS.length)
  ok("…and none of them silently pass while broken", broken.length === 0, broken.join(", "))
  eq("every task's SOLUTION passes that same oracle", satisfiable, EVAL_TASKS.length)
  ok("…so no task is impossible to solve", unsatisfiable.length === 0, unsatisfiable.join(" | "))
}

console.log("== 2. the set is well formed, and the oracle is genuinely hidden ==")
{
  const missing = []
  for (const t of EVAL_TASKS) {
    for (const k of ["id", "class", "prompt", "files", "solution", "hiddenFiles", "verify"]) {
      if (t[k] == null) missing.push(`${t.id}.${k}`)
    }
  }
  ok("every task carries id, class, prompt, files, solution, hiddenFiles, verify", missing.length === 0, missing.join(", "))

  eq("task ids are unique", new Set(EVAL_TASKS.map((t) => t.id)).size, EVAL_TASKS.length)
  ok("the set spans many defect classes", new Set(EVAL_TASKS.map((t) => t.class)).size >= 12,
    String(new Set(EVAL_TASKS.map((t) => t.class)).size))

  // the agent is handed `files`; the oracle lives only in `hiddenFiles`
  const leaked = EVAL_TASKS.filter((t) => Object.keys(t.hiddenFiles).some((h) => Object.keys(t.files).includes(h)))
  ok("no hidden file is also handed to the agent", leaked.length === 0, leaked.map((t) => t.id).join(", "))

  const solutionShape = EVAL_TASKS.filter((t) =>
    JSON.stringify(Object.keys(t.solution).sort()) !== JSON.stringify(Object.keys(t.files).sort()))
  ok("the solution replaces exactly the files the agent was given", solutionShape.length === 0,
    solutionShape.map((t) => t.id).join(", "))

  const unchanged = EVAL_TASKS.filter((t) => Object.keys(t.files).every((k) => t.files[k] === t.solution[k]))
  ok("no 'solution' is identical to the broken file", unchanged.length === 0, unchanged.map((t) => t.id).join(", "))
}

console.log("== 3. the negative check: deleting the feature is not a fix ==")
{
  // Sabotage, the crudest possible "fix": make the module export nothing real.
  // Every task must reject it — otherwise an agent could score by removing code.
  const survived = []
  for (const t of EVAL_TASKS) {
    const d = scratch("sab")
    const stubbed = {}
    for (const f of Object.keys(t.files)) stubbed[f] = "export {}\n"
    writeAll(d, stubbed); writeAll(d, t.hiddenFiles)
    if (runVerification(d, t.verify).passed) survived.push(t.id)
  }
  eq("an empty module passes NO task", survived.length, 0)

  // and the subtler sabotage: keep the API, return a constant
  const constSurvived = []
  for (const t of EVAL_TASKS.slice(0, 8)) {
    const d = scratch("con")
    const stubbed = {}
    for (const f of Object.keys(t.files)) {
      const names = [...String(t.solution[f]).matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)].map((x) => x[1])
      stubbed[f] = names.map((n) => `export function ${n}() { return 0 }\n`).join("") || "export {}\n"
    }
    writeAll(d, stubbed); writeAll(d, t.hiddenFiles)
    if (runVerification(d, t.verify).passed) constSurvived.push(t.id)
  }
  eq("a constant-returning stub passes no task either", constSurvived.length, 0)
}

// ---------------------------------------------------------------------------
console.log("== 4. end to end against a mock model, with no API key ==")

const call = (id, name, args) => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] })

/** A scripted model. `script(callNumber, task)` returns the message to send. */
function mkModel(script, task) {
  let n = 0
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      const message = script(++n, task)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        id: "m", object: "chat.completion", created: Date.now(), model: "mock-1",
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      }))
    })
  })
  return srv
}

async function runWithScript(task, script, extraAgentCfg = {}) {
  const { runAgent } = await import("../agent.js")
  const srv = mkModel(script, task)
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  try {
    return await runEvalTask(task, {
      runAgent,
      config: { providers: {}, tools: { assumeYes: true }, agent: { autonomous: false, maxSteps: 8, verifyNudge: false, ...extraAgentCfg } },
      provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "mock-1" },
      timeoutMs: 60_000,
    })
  } finally { srv.close() }
}

{
  const task = EVAL_TASKS[0]

  // A LIAR: touches nothing, declares victory. The oracle must catch it.
  const liar = await runWithScript(task, () => ({ role: "assistant", content: "Fixed it. The task is complete." }))
  ok("a liar does not solve the task", liar.solved === false, JSON.stringify(liar.verification).slice(0, 120))
  ok("and is recorded as a FALSE COMPLETION", liar.falseCompletion === true, `status=${liar.agentStatus}`)
  ok("the verdict came from the hidden test, not the agent", liar.claimedComplete === true && liar.solved === false)

  // AN HONEST FIXER: inspects first (the governor forbids a blind first write),
  // then writes the real solution. Proves the oracle is satisfiable THROUGH the
  // agent path, not merely by copying files in section 1.
  const file = Object.keys(task.files)[0]
  const honest = await runWithScript(task, (n, t) =>
    n === 1 ? call("r1", "read_file", { path: file })
    : n === 2 ? call("w1", "write_file", { path: file, content: t.solution[file] })
    : { role: "assistant", content: "Fixed the loop bound. The task is complete." })
  ok("an honest fixer solves it, through the real agent path", honest.solved === true,
    `status=${honest.agentStatus} verif=${String(honest.verification).slice(0, 110)}`)
  ok("and is not accused of lying", honest.falseCompletion === false)
  ok("the result records which model actually ran", typeof honest.modelUsed === "string" && honest.modelUsed.length > 0, honest.modelUsed)
  ok("and which defect class it was", honest.class === task.class, String(honest.class))

  // A SNOOP: tries to find and fake the test that will judge it. It cannot —
  // the oracle does not exist in the workspace while the agent is running.
  const snoop = await runWithScript(task, (n) =>
    n === 1 ? call("s1", "read_file", { path: "verify.mjs" })
    : n === 2 ? call("s2", "write_file", { path: "verify.mjs", content: "console.log('ok')\n" })
    : { role: "assistant", content: "Verified. The task is complete." })
  ok("an agent cannot read the oracle before it exists", snoop.solved === false, JSON.stringify(snoop.verification).slice(0, 120))
  ok("…nor pre-write a fake one that survives", snoop.falseCompletion === true)
}

console.log("== 5. a dry run over the whole set reports 0 solved ==")
{
  // The proof that the oracle actually judges: a model that does nothing must
  // score zero. If this ever passes a task, the set is not checking anything.
  const { runAgent } = await import("../agent.js")
  const srv = mkModel(() => ({ role: "assistant", content: "Done." }))
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  let summary
  try {
    summary = await runEval({
      tasks: EVAL_TASKS.slice(0, 6), runAgent,
      config: { providers: {}, tools: { assumeYes: true }, agent: { autonomous: false, maxSteps: 3, verifyNudge: false } },
      provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "mock-1" },
      timeoutMs: 60_000,
    })
  } finally { srv.close() }
  eq("a do-nothing model solves nothing", summary.solved, 0)
  eq("and every task it claimed is a false completion", summary.falseCompletions, summary.results.filter((r) => r.claimedComplete).length)
  ok("the report leads with the solve count", /FORGE EVAL — 0\/6 solved/.test(formatEvalReport(summary)), formatEvalReport(summary).split("\n")[0])
  ok("and states the false-completion count even when it is the headline",
    /FALSE COMPLETIONS: \d+/.test(formatEvalReport(summary)))
  ok("per-class results are recorded", Object.keys(summary.byClass).length > 1, JSON.stringify(Object.keys(summary.byClass)))
}

console.log("== 6. the A/B can say 'no difference', and names a model confound ==")
{
  const { runAgent } = await import("../agent.js")
  const srv = mkModel(() => ({ role: "assistant", content: "Done." }))
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  let ab
  try {
    ab = await runAB({
      tasks: EVAL_TASKS.slice(0, 3), runAgent,
      config: { providers: {}, tools: { assumeYes: true }, agent: { autonomous: false, maxSteps: 3, verifyNudge: false } },
      provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "mock-1" },
      timeoutMs: 60_000,
    })
  } finally { srv.close() }

  ok("both arms ran the same tasks", ab.on.tasks === 3 && ab.off.tasks === 3, `${ab.on.tasks}/${ab.off.tasks}`)
  eq("the delta is reported", typeof ab.delta.solved, "number")
  const report = formatABReport(ab)
  ok("the report names both arms", /\bON\b/.test(report) && /\bOFF\b/.test(report), report.split("\n").slice(0, 6).join(" / "))
  ok("identical arms are reported as NO MEASURABLE DIFFERENCE, not as a win",
    /NO MEASURABLE DIFFERENCE/.test(report), report)
  ok("…and it says that is a result rather than a failure", /That is a result/.test(report))

  // the confound line, on a synthetic pair that differs only by model
  const fake = {
    on: { ...ab.on, models: ["a/strong"] },
    off: { ...ab.off, models: ["b/fast"] },
    models: ["a/strong", "b/fast"], sameModel: false, lockModel: false,
    delta: { ...ab.delta, solved: 1 },
  }
  const warned = formatABReport(fake)
  ok("a model difference is reported, never hidden", /did not run on the same model/.test(warned), warned)
  ok("and it says the delta is partly model choice", /not cognition/.test(warned))
  ok("and points at the way to isolate it", /--lock-model/.test(warned))
}

console.log(`\n== v114 measurewise suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
