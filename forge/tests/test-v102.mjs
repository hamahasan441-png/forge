#!/usr/bin/env node
/**
 * forge — v102 "reviewwise": the adversarial review reaches the path that
 * everything actually uses.
 *
 * AUDIT FINDING (evidence, not assumption): review.js has existed since the ∞
 * layer and is imported by exactly one module — omega.js — whose kernel is
 * built by exactly one caller, meta.js. `forge agent "..."`, interactive Agent
 * Mode, every sub-agent and every isolated DAG node run through agent.js, and
 * agent.js contains zero references to it (`grep -c adversarialReview agent.js`
 * → 0). Every input the review needs was already being computed on that path
 * and thrown away at run end.
 *
 * The other half of the finding: meta gates the review on the task TEXT
 * (needsReview → LARGE/ARCHITECTURAL). A run is now also reviewed on what it
 * OBSERVABLY did, which is strictly better evidence.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v102-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v102-work-"))
process.chdir(WORK)

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const { reviewRun, changeSetOf, needsReview, ESCALATE_FILES, ESCALATE_RADIUS } = await import("../review.js")
const { TASK_CLASS } = await import("../classify.js")

// ---------------------------------------------------------------------------
console.log("== 1. the change set is FOLDED from records, never re-derived ==")
{
  const recs = [
    { files_changed: ["a.js"], blast: { radius: 3, importers: ["x.js"], tests: ["a.test.js"], unknown: false, scope: "focused_test" } },
    { files_changed: ["b.js", "a.js"], blast: { radius: 11, importers: ["x.js", "y.js"], tests: [], unknown: false, scope: "regression_test" } },
    { files_changed: [] },
  ]
  const cs = changeSetOf(recs)
  eq("files are unioned, in order, without duplicates", cs.files, ["a.js", "b.js"])
  eq("radius takes the WORST, not the last", cs.impact.radius, 11)
  eq("importers are unioned", cs.impact.importers, ["x.js", "y.js"])
  eq("tests are unioned", cs.impact.tests, ["a.test.js"])
  eq("scope is the latest known", cs.impact.scope, ["regression_test"])
  eq("unknown is false when every walk completed", cs.impact.unknown, false)
  ok("ONE unknown walk poisons the whole set — 'no dependents' is not proof",
    changeSetOf([...recs, { files_changed: ["c.js"], blast: { unknown: true } }]).impact.unknown === true)
  eq("garbage in → empty, never a throw", changeSetOf(null).files, [])
  eq("records with no blast contribute files only", changeSetOf([{ files_changed: ["z.js"] }]).impact.radius, 0)
}

console.log("== 2. the review is earned by what the run DID, not only what it was called ==")
{
  const one = [{ files_changed: ["a.js"], blast: { radius: 1, importers: [], tests: [], unknown: false } }]
  ok("a small task with a small change set is still not reviewed", reviewRun({ klass: TASK_CLASS.SMALL, objective: "x", records: one }).required === false)
  ok("LARGE is reviewed as it always was", reviewRun({ klass: TASK_CLASS.LARGE, objective: "x", records: one }).required === true)
  ok("...and is not reported as an escalation", reviewRun({ klass: TASK_CLASS.LARGE, objective: "x", records: one }).escalated === false)

  const wideFiles = Array.from({ length: ESCALATE_FILES }, (_, i) => ({ files_changed: [`f${i}.js`] }))
  const esc = reviewRun({ klass: TASK_CLASS.SMALL, objective: "add a null check", records: wideFiles })
  ok(`${ESCALATE_FILES} changed files escalate a SMALL task into a review`, esc.required === true)
  eq("and the escalation is stated, never disguised as the original class", esc.escalatedFrom, TASK_CLASS.SMALL)
  ok("just under the threshold does not escalate",
    reviewRun({ klass: TASK_CLASS.SMALL, objective: "x", records: wideFiles.slice(0, ESCALATE_FILES - 1) }).required === false)

  const wideRadius = [{ files_changed: ["a.js"], blast: { radius: ESCALATE_RADIUS, importers: [], tests: [], unknown: false } }]
  ok("a wide blast radius escalates too, even for one file",
    reviewRun({ klass: TASK_CLASS.MICRO, objective: "x", records: wideRadius }).required === true)
  ok("escalation can be turned off by the caller",
    reviewRun({ klass: TASK_CLASS.SMALL, objective: "x", records: wideFiles, escalate: false }).required === false)
}

console.log("== 3. what the review actually catches ==")
{
  const secretWrite = [{ files_changed: [".env"], blast: { radius: 0, importers: [], tests: [], unknown: false } }]
  const r = reviewRun({ klass: TASK_CLASS.LARGE, objective: "fix the auth test", records: secretWrite })
  ok("writing a secret-bearing file BLOCKS, it is not a soft finding", r.blockers.some((b) => b.id === "secrets_untouched"))
  ok("and the review is not ok", r.ok === false)

  const unknownWalk = [{ files_changed: ["a.js"], blast: { radius: 0, importers: [], tests: [], unknown: true } }]
  ok("an UNKNOWN impact walk is a finding — radius 0 is not proof of safety",
    reviewRun({ klass: TASK_CLASS.LARGE, objective: "x", records: unknownWalk }).findings.some((f) => f.id === "unknown_impact"))

  const wide = [{ files_changed: ["a.js"], blast: { radius: 20, importers: Array.from({ length: 9 }, (_, i) => `i${i}.js`), tests: [], unknown: false, scope: "focused_test" } }]
  ok("a wide radius with only a focused test is a finding",
    reviewRun({ klass: TASK_CLASS.LARGE, objective: "x", records: wide }).findings.some((f) => f.id === "tests_match_impact"))

  const clean = [{ files_changed: ["a.js"], blast: { radius: 2, importers: ["x.js"], tests: ["a.test.js"], unknown: false, scope: "regression_test" } }]
  const good = reviewRun({ klass: TASK_CLASS.LARGE, objective: "x", records: clean, verificationOk: true, checkpoint: "cp-1" })
  ok("a clean, verified, checkpointed change has no findings", good.findings.length === 0 && good.ok === true, JSON.stringify(good.findings))

  // honesty: a check with nothing to inspect must not read as one that passed
  const noModel = reviewRun({ klass: TASK_CLASS.LARGE, objective: "x", records: clean, verificationOk: true })
  const assumption = noModel.checks.find((c) => c.id === "no_assumption_as_requirement")
  ok("'not inspected' is said out loud, not reported as a pass", /not inspected/.test(assumption.detail), assumption.detail)
}

// ---------------------------------------------------------------------------
console.log("== 4. it runs on the REAL agent path, end to end ==")
{
  const { runAgent } = await import("../agent.js")
  function mkModel(script) {
    let calls = 0
    const server = http.createServer((req, res) => {
      if (!req.url.includes("chat/completions")) { res.writeHead(404).end(); return }
      let b = ""
      req.on("data", (c) => { b += c })
      req.on("end", () => {
        const message = script(++calls)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ id: "m", object: "chat.completion", created: Date.now(), model: "mock-1",
          choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }))
      })
    })
    return server
  }
  const call = (id, name, args) => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] })
  const FILES = ["auth.js", "token.js", "session.js", "user.js", "login.js"]

  async function run(task, script, agentCfg = {}) {
    const server = mkModel(script)
    await new Promise((r) => server.listen(0, "127.0.0.1", r))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v102-run-"))
    // built by concatenation: written out as a literal, the import inside this
    // fixture would be read as one of THIS suite's own imports by the
    // path-hygiene scanner (which scans the whole source, comments included)
    const fixture = `import { x } from ${JSON.stringify("./auth.js")}\nexport const v = 1\n`
    for (const f of FILES) fs.writeFileSync(path.join(dir, f), fixture)
    const prev = process.cwd()
    try {
      process.chdir(dir)
      const res = await runAgent({
        config: { providers: {}, tools: { assumeYes: true }, agent: { autonomous: false, maxSteps: 14, verifyNudge: false, ...agentCfg } },
        provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "k", model: "mock-1" },
        task, journal: false,
      })
      return res
    } finally { process.chdir(prev); server.close() }
  }

  const wideScript = (n) => n <= FILES.length
    ? call(`w${n}`, "write_file", { path: FILES[n - 1], content: `export const v = ${n}\n` })
    : { role: "assistant", content: "Updated the auth modules." }

  const a = await run("add a null check", wideScript)
  ok("a SMALL-classified run that rewrote five files IS reviewed", a.review?.required === true)
  eq("and says which class it was escalated from", a.review.escalatedFrom, TASK_CLASS.SMALL)
  eq("the review saw the real change set", a.review.files.length, FILES.length)
  ok("an unchecked change set is a verification finding", a.review.findings.some((f) => f.id === "verification_present"))

  const secretScript = (n) => n === 1
    ? call("w1", "write_file", { path: ".env", content: "API_KEY=sk-live-0000\n" })
    : { role: "assistant", content: "Added the key. Complete." }

  // v113 audit — THE SECRET IS NOW STOPPED EARLIER, SO THE REVIEW NEVER SEES IT.
  //
  // v102 asserted that writing .env LANDS and the post-hoc review blocks it.
  // v112 criticwise made that unreachable: the critic refuses a secret-bearing
  // path before the write, so `.env` is never created and the review's change
  // set is legitimately empty. Reproduced both ways:
  //
  //   cognition on  → "BLOCKED: governor SEARCH forbids write_file"
  //   cognition off → "BLOCKED: (critique) ASK — .env is a secret-bearing path"
  //                   and the run ends WAITING_FOR_USER, not COMPLETED
  //
  // The invariant "a secret must not be committed" is now enforced harder, not
  // weaker, so the assertion moves to where the enforcement actually is. The
  // review's own secret rule still has direct coverage at line 81 above.
  const b = await run("fix the failing auth test", secretScript, { cognition: false })
  ok("writing .env is REFUSED before it lands, not caught afterwards",
    (b.toolLog ?? []).some((t) => /BLOCKED/.test(String(t.result ?? "")) && /secret/i.test(String(t.result ?? ""))),
    JSON.stringify((b.toolLog ?? []).map((t) => String(t.result ?? "").slice(0, 80))))
  ok("and the secret never reaches the change set", (b.review?.files ?? []).length === 0)
  eq("a refused secret write does not become a COMPLETED run", b.status, "WAITING_FOR_USER")

  const d = await run("fix the failing auth test", secretScript, { review: "off" })
  eq("OFF means not run at all, not run-and-hidden", d.review, null)
  // v115: this used to assert COMPLETED — "exactly what it was before v102".
  // It no longer is, and not because of the review: every attempt this script
  // makes to change a file is refused, and v115 stops calling a run that
  // changed nothing COMPLETED. What this line is actually for is that
  // review:"off" does not influence the verdict, so that is what it pins now.
  ok("the verdict owes nothing to the review when it is off",
    d.review === null && d.completionGate?.checks?.reviewClean === undefined, JSON.stringify(d.completionGate?.checks ?? {}))
  eq("…and the refused write is still what decided it", d.reason, "MUTATIONS_REFUSED")

  const readOnly = (n) => n === 1
    ? call("r1", "read_file", { path: "auth.js" })
    : { role: "assistant", content: "It imports from auth.js." }
  const q = await run("explain what token.js does", readOnly)
  ok("a question that changed nothing is not reviewed", q.review?.required === false)
  ok("a run that wrote nothing counts as verified, not as unverified",
    q.review === null || q.review.required === false)
}

console.log("== 5. the review's evidence STEERS the run, it is not just reported ==")
{
  // A finding nothing consumes is the island this whole audit was hunting.
  // The blast radius the review reads is now also what the verification nudge
  // says — inside the same run, with no extra model call.
  const { runAgent } = await import("../agent.js")
  function mkModel(script) {
    let calls = 0
    const seen = []
    const server = http.createServer((req, res) => {
      if (!req.url.includes("chat/completions")) { res.writeHead(404).end(); return }
      let b = ""
      req.on("data", (c) => { b += c })
      req.on("end", () => {
        seen.push(b)
        const message = script(++calls)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ id: "m", object: "chat.completion", created: Date.now(), model: "mock-1",
          choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }))
      })
    })
    return { server, seen }
  }
  const call = (id, name, args) => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] })

  /** `hub.js` is imported by ten modules; `lonely.js` by none. */
  async function run(target, importerCount) {
    const m = mkModel((n) => n === 1
      ? call("w1", "write_file", { path: target, content: "export const v = 2\n" })
      : { role: "assistant", content: "Changed it. Complete." })
    await new Promise((r) => m.server.listen(0, "127.0.0.1", r))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v102-blast-"))
    fs.writeFileSync(path.join(dir, target), "export const v = 1\n")
    const importLine = `import { v } from ${JSON.stringify(`./${target}`)}\n`
    for (let i = 0; i < importerCount; i++) fs.writeFileSync(path.join(dir, `imp${i}.js`), importLine + `export const u = v\n`)
    const prev = process.cwd()
    try {
      process.chdir(dir)
      const res = await runAgent({
        config: { providers: {}, tools: { assumeYes: true }, agent: { autonomous: false, maxSteps: 8 } },
        provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${m.server.address().port}`, apiKey: "k", model: "mock-1" },
        task: "change the exported value", journal: false,
      })
      const nudge = m.seen.map((b) => { try { return JSON.parse(b).messages.map((x) => String(x.content ?? "")).join("\n") } catch { return b } })
        .find((t) => t.includes("you changed files but never ran a check")) ?? ""
      return { res, nudge }
    } finally { process.chdir(prev); m.server.close() }
  }

  const wide = await run("hub.js", 10)
  ok("the run was nudged", wide.nudge.length > 0)
  ok("and the nudge NAMES the reach the review measured", /import what you changed/.test(wide.nudge), wide.nudge.slice(0, 300))
  ok("and says a focused test is not enough evidence", /regression suite/.test(wide.nudge))
  ok("the review saw the same radius the nudge quoted", (wide.res.review?.impact?.radius ?? 0) >= 8, JSON.stringify(wide.res.review?.impact))

  const narrow = await run("lonely.js", 0)
  ok("a leaf change is still nudged to check", narrow.nudge.length > 0)
  ok("but is NOT told to run a regression suite it does not need", !/regression suite/.test(narrow.nudge))
}

console.log("== 6. compaction now checks its own work ==")
{
  // historyIsWellFormed() has been exported and tested since compaction was
  // rewritten, and nothing ever called it — while the defect it detects is
  // the one named at the top of compaction.js: a history whose tool results
  // are split from the assistant turn that requested them, which every
  // provider rejects. That kills a long run at the moment compaction was
  // supposed to save it.
  const { guardCompaction, historyIsWellFormed, compactHistory } = await import("../compaction.js")

  const good = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", tool_calls: [{ id: "a", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "a", content: "result" },
  ]
  const orphanCall = good.slice(0, 2)                                   // tool_calls with no answer
  const orphanResult = [{ role: "user", content: "go" }, { role: "tool", tool_call_id: "zz", content: "r" }]

  ok("a paired history is well formed", historyIsWellFormed(good) === true)
  ok("an unanswered tool call is not", historyIsWellFormed(orphanCall) === false)
  ok("a result answering nothing is not", historyIsWellFormed(orphanResult) === false)

  const broke = guardCompaction(good, orphanCall)
  ok("breaking a good history is REFUSED", broke.refused === true)
  eq("and the original is what comes back", broke.messages, good)
  ok("with a reason that names the defect", /unanswered tool calls/.test(broke.reason))

  ok("a compaction that keeps it well formed passes through", guardCompaction(good, good).refused === false)
  ok("an already-broken input is not blamed on compaction",
    guardCompaction(orphanCall, orphanCall).refused === false)
  ok("...and that case is stated rather than silently allowed",
    /already malformed/.test(guardCompaction(orphanCall, orphanCall).reason))

  // The guard is worthless if it refuses healthy compactions. This is the
  // real module compacting a real oversized history, with no model available
  // for the summary step (summarize omitted → the deterministic ledger path).
  const big = [{ role: "system", content: "sys" }, { role: "user", content: "audit everything" }]
  for (let i = 0; i < 60; i++) {
    big.push({ role: "assistant", content: "", tool_calls: [{ id: `t${i}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `echo ${i}` }) } }] })
    big.push({ role: "tool", tool_call_id: `t${i}`, content: "out ".repeat(3000) })
  }
  ok("the oversized history starts well formed", historyIsWellFormed(big))
  const r = await compactHistory(big, { window: 16000, force: true })
  ok("it really compacted", r.changed === true && r.messages.length < big.length, `stage=${r.stats.stage} ${big.length}→${r.messages.length}`)
  ok("the compaction was NOT refused", r.stats.stage !== "refused", JSON.stringify(r.stats))
  ok("and the result is well formed", historyIsWellFormed(r.messages) === true)
}

console.log(`\n== v102 reviewwise suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
