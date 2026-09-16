#!/usr/bin/env node
/**
 * forge — v119 "calibratewise": the completion gate learns how many attempts a
 * blocker is worth, and cannot learn its way into a false completion.
 *
 * v118 made the governor's STOP a candidate that must survive a check against
 * reality, and gave every refused candidate a flat three attempts. Three is a
 * reasonable guess and it is only a guess: a blocker that has never once been
 * cleared in this project still burned three model turns before reporting the
 * BLOCKED it was always going to report.
 *
 * The signal needs no oracle. v118 already produces both outcomes inside the
 * run that produced them:
 *
 *   CLEARED    a later candidate passed with the blocker gone — the refusal
 *              caught a genuinely premature stop and earned its cost
 *   ABANDONED  the same blocker refused to the limit — the refusal cleared
 *              nothing and cost the turns anyway
 *
 * THE INVARIANT, asserted here rather than argued: what is learned is the
 * attempt BUDGET, never a verdict. A run that would end BLOCKED still ends
 * BLOCKED, sooner. A run that would complete still completes. Learning may
 * remove wasted work; it may never manufacture a completion.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v119-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 260)}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const ml = await import("../metalearn.js")
const { runAgent } = await import("../agent.js")
const { BLOCKER } = await import("../completion.js")

const tmpProject = () => fs.mkdtempSync(path.join(os.tmpdir(), "forge-v119-proj-"))
const attempts = (cwd, klass, blocker) => ml.completionAttemptsFor({ cwd, klass, blocker, drifted: false })
const abandon = (cwd, klass, blocker, n = 1) => { for (let i = 0; i < n; i++) ml.recordCompletionOutcome({ cwd, klass, blocker, outcome: ml.COMPLETION_OUTCOME.ABANDONED, attempt: 3 }) }

// ---------------------------------------------------------------------------
console.log("== A. the budget is learned, and damped until there is something to learn from ==")
{
  const cwd = tmpProject()
  const B = BLOCKER.MISSING_ARTIFACT

  const cold = attempts(cwd, "MEDIUM", B)
  eq("with no evidence the default stands", cold.attempts, ml.COMPLETION_ATTEMPTS_MAX)
  eq("and says so rather than claiming a measurement", cold.source, "default")

  abandon(cwd, "MEDIUM", B, 2)
  eq("two observations are an anecdote, not a policy", attempts(cwd, "MEDIUM", B).attempts, ml.COMPLETION_ATTEMPTS_MAX)

  abandon(cwd, "MEDIUM", B, 1)
  const learned = attempts(cwd, "MEDIUM", B)
  eq("past the floor, a blocker that never clears gets one turn", learned.attempts, 1)
  eq("and it is reported as measured, not assumed", learned.source, "learned")
  ok("the reason cites the count", /3 attempt\(s\)/.test(learned.why), learned.why)
}

console.log("== A2. the safety floor: an attempt that once cleared can never be squeezed out ==")
{
  const cwd = tmpProject()
  const B = BLOCKER.MISSING_ARTIFACT
  abandon(cwd, "MEDIUM", B, 3)
  eq("shortened by the abandonments", attempts(cwd, "MEDIUM", B).attempts, 1)

  // One clearing on the 3rd attempt is proof that a 1-attempt budget would
  // have reported BLOCKED on work that was about to finish.
  ml.recordCompletionOutcome({ cwd, klass: "MEDIUM", blocker: B, outcome: ml.COMPLETION_OUTCOME.CLEARED, attempt: 3 })
  eq("one clearing on attempt 3 restores the full budget", attempts(cwd, "MEDIUM", B).attempts, 3)

  abandon(cwd, "MEDIUM", B, 6)
  eq("and no number of later abandonments can drop it back below that", attempts(cwd, "MEDIUM", B).attempts, 3)
}

console.log("== A3. what must NOT leak ==")
{
  const cwd = tmpProject()
  abandon(cwd, "MEDIUM", BLOCKER.MISSING_ARTIFACT, 4)
  eq("a different task class is unaffected", attempts(cwd, "LARGE", BLOCKER.MISSING_ARTIFACT).attempts, ml.COMPLETION_ATTEMPTS_MAX)
  eq("a different blocker is unaffected", attempts(cwd, "MEDIUM", BLOCKER.NO_ANSWER).attempts, ml.COMPLETION_ATTEMPTS_MAX)
  eq("a different project is unaffected", attempts(tmpProject(), "MEDIUM", BLOCKER.MISSING_ARTIFACT).attempts, ml.COMPLETION_ATTEMPTS_MAX)

  // §42 — a clearing rate measured on another toolchain is not evidence here.
  eq("a drifted environment discards the stats",
    ml.completionAttemptsFor({ cwd, klass: "MEDIUM", blocker: BLOCKER.MISSING_ARTIFACT, drifted: true }).source, "shift")

  // The v117 bug, pinned so it cannot come back: metalearn's loader must not
  // drop the section it does not name.
  const raw = JSON.parse(fs.readFileSync(ml.metalearnPath(cwd), "utf8"))
  ok("the section is persisted beside the existing one, not instead of it",
    Boolean(raw.completion?.MEDIUM?.[BLOCKER.MISSING_ARTIFACT]) && "byKlass" in raw, Object.keys(raw).join(","))
  ok("and survives a reload", attempts(cwd, "MEDIUM", BLOCKER.MISSING_ARTIFACT).samples === 4)
}

console.log("== A4. it degrades rather than breaking ==")
{
  const cwd = tmpProject()
  eq("an empty blocker name never shortens anything", attempts(cwd, "MEDIUM", "").attempts, ml.COMPLETION_ATTEMPTS_MAX)
  eq("recording an empty blocker is a no-op", ml.recordCompletionOutcome({ cwd, klass: "MEDIUM", blocker: "" }), null)
  // record first, so the project's state dir exists to be corrupted
  abandon(cwd, "MEDIUM", BLOCKER.MISSING_ARTIFACT, 3)
  fs.writeFileSync(ml.metalearnPath(cwd), "{ this is not json")
  eq("a corrupt store falls back to the default, never to zero", attempts(cwd, "MEDIUM", BLOCKER.MISSING_ARTIFACT).attempts, ml.COMPLETION_ATTEMPTS_MAX)
  ok("the budget is never below one whatever is asked for",
    ml.completionAttemptsFor({ cwd, klass: "MEDIUM", blocker: "X", fallback: 0, drifted: false }).attempts >= 1)
  eq("nothing to report when nothing is known", ml.formatCompletionPolicy(tmpProject(), "MEDIUM"), "")
}

// ---------------------------------------------------------------------------
// the live path
// ---------------------------------------------------------------------------
const call = (id, name, args) => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] })
const VERIFY_CMD = "node --check one.js && echo 'test ok'"

/** Run the same scripted model against the SAME project dir, repeatedly. */
async function runIn(work, script, task, { maxSteps = 20 } = {}) {
  const prev = process.cwd()
  process.chdir(work)
  for (const f of fs.readdirSync(work)) fs.rmSync(path.join(work, f), { recursive: true, force: true })
  let calls = 0
  const srv = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      calls++
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: script(calls) }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const r = await runAgent({
    config: { providers: {}, tools: { autoApprove: true }, agent: { autonomous: false }, skills: { enabled: false } },
    provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, apiKey: "k", model: "mock-1", contextWindow: 128000 },
    task, journal: false, maxStepsOverride: maxSteps,
  })
  srv.close()
  process.chdir(prev)
  return { r, calls }
}

const TASK = "create one.js and two.js, both exporting a constant"
// writes one.js, verifies it, never writes two.js, never answers
const NEVER_FINISHES = (i) =>
  i === 1 ? call("c1", "write_file", { path: "one.js", content: "export const one = 1\n" })
  : i === 2 ? call("c2", "bash", { command: VERIFY_CMD })
  : call(`c${i}`, "list_dir", { path: `d${i}` })

console.log("== B. THE ACCEPTANCE TEST: the same input costs less the fourth time ==")
{
  const work = tmpProject()
  const runs = []
  for (let i = 0; i < 5; i++) runs.push(await runIn(work, NEVER_FINISHES, TASK))

  const first = runs[0], last = runs[runs.length - 1]
  // The invariant first, because it is the one that matters.
  ok("every run reaches the SAME verdict",
    runs.every((x) => x.r.status === first.r.status && x.r.reason === first.r.reason),
    JSON.stringify(runs.map((x) => `${x.r.status}/${x.r.reason}`)))
  eq("and that verdict is not a completion", first.r.status, "INCOMPLETE")

  // ...and then the saving, which is the whole point of having learned.
  ok("the early runs pay the full budget", first.r.completionCandidates === 3, String(first.r.completionCandidates))
  ok("the later ones do not", last.r.completionCandidates === 1, String(last.r.completionCandidates))
  ok("which is fewer model calls for the identical input",
    last.calls < first.calls, `${first.calls} → ${last.calls}`)
  ok("the project can say what it learned",
    /MISSING_ARTIFACT/.test(ml.formatCompletionPolicy(work, "SMALL") + ml.formatCompletionPolicy(work, "MEDIUM")),
    ml.formatCompletionPolicy(work, "SMALL") + ml.formatCompletionPolicy(work, "MEDIUM"))
  fs.rmSync(work, { recursive: true, force: true })
}

console.log("== C. ADVERSARIAL: a shortened budget must not manufacture a completion ==")
{
  // Teach the project that MISSING_ARTIFACT never clears, so the budget is 1.
  // Then give it a run that genuinely finishes the work. It must still
  // complete — the budget controls attempts, not verdicts.
  const work = tmpProject()
  for (const k of ["MICRO", "SMALL", "MEDIUM", "LARGE"]) abandon(work, k, BLOCKER.MISSING_ARTIFACT, 4)
  ok("the budget really is shortened before the run", attempts(work, "SMALL", BLOCKER.MISSING_ARTIFACT).attempts === 1)

  const { r } = await runIn(work, (i) =>
    i === 1 ? call("c1", "write_file", { path: "one.js", content: "export const one = 1\n" })
    : i === 2 ? call("c2", "write_file", { path: "two.js", content: "export const two = 2\n" })
    : i === 3 ? call("c3", "bash", { command: VERIFY_CMD })
    : { role: "assistant", content: "Created one.js and two.js, both exporting a constant." }, TASK)

  eq("a run that did the work still completes", r.status, "COMPLETED")
  eq("with no reason attached", r.reason, null)
  ok("both files really exist — the completion is backed by reality",
    fs.existsSync(path.join(work, "one.js")) && fs.existsSync(path.join(work, "two.js")))

  // And the reverse: the shortened budget still refuses an unfinished run.
  const { r: r2 } = await runIn(work, NEVER_FINISHES, TASK)
  ok("an unfinished run is still refused, just sooner", r2.status !== "COMPLETED", r2.status)
  eq("and still names the completion blocker", r2.reason, "COMPLETION_BLOCKED")
  fs.rmSync(work, { recursive: true, force: true })
}

console.log("== D. a cleared blocker teaches the opposite lesson ==")
{
  // A run where the model finishes only AFTER being told what is missing.
  // That is a blocker doing its job, and it must be recorded as such.
  const work = tmpProject()
  const { r } = await runIn(work, (i) => {
    const told = fs.existsSync(path.join(work, "one.js")) && i > 2
    if (i === 1) return call("c1", "write_file", { path: "one.js", content: "export const one = 1\n" })
    if (i === 2) return call("c2", "bash", { command: VERIFY_CMD })
    if (told && !fs.existsSync(path.join(work, "two.js"))) return call(`c${i}`, "write_file", { path: "two.js", content: "export const two = 2\n" })
    return { role: "assistant", content: "Added the missing two.js." }
  }, TASK)

  eq("the run completes once the blocker is cleared", r.status, "COMPLETED")
  const rec = ml.loadMetaLearn(work).completion?.SMALL?.[BLOCKER.MISSING_ARTIFACT]
    ?? ml.loadMetaLearn(work).completion?.MEDIUM?.[BLOCKER.MISSING_ARTIFACT]
  ok("and the clearing is recorded, not just the abandonments",
    (rec?.cleared ?? 0) >= 1, JSON.stringify(ml.loadMetaLearn(work).completion))
  ok("with the attempt it cleared on, which becomes the floor",
    (rec?.maxClearedAttempt ?? 0) >= 1, JSON.stringify(rec))
  fs.rmSync(work, { recursive: true, force: true })
}

console.log(`\n== v119 calibratewise suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
