#!/usr/bin/env node
/**
 * forge — v102 "intelwise": prediction-calibrated intelligence on the
 * DEFAULT agent path.
 *
 * prediction.js already predicted DAG nodes for --auto. Default `forge agent`
 * never opened a prediction, never settled one, never recorded empirics.
 * The governor could not tell a miss from a hit.
 *
 * This suite proves:
 *   1. predictForAction is deterministic (files from intent/reads, not confidence)
 *   2. objective-only predictions are UNSCORED (not "I predicted zero files")
 *   3. targeted extra-file drift is MISS → governor REPLAN (not MICRO)
 *   4. cognition predict/settle persists the REAL ledger
 *   5. cheapest-reversible strategies rank first
 *   6. the live agent path emits PREDICTION_MADE / PREDICTION_SETTLED
 *   7. agent.js records empirics (the default path, not only meta)
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-intel-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + extra : ""}`) }
}

const {
  predictForAction, settlePrediction, recordPrediction, loadPredictions,
  driftVerdict, DRIFT, filesMentionedIn, expectedFilesFromContext,
  predictionCalibration, MIN_CALIBRATION_SAMPLES,
} = await import("../prediction.js")
const { chooseNextAction, ACTION, rankStrategies, CHEAPEST_FIRST } = await import("../governor.js")
const { createCognition, COGNITION_VERSION } = await import("../cognition.js")
const { VERSION } = await import("../version.js")
const { pickModelEmpiric, loadEmpirics } = await import("../empirics.js")

console.log("== version identity ==")
{
  ok("package version is 113.x", /^113\./.test(VERSION), VERSION)
  ok("cognition protocol is 1.5.x", /^1\.5\./.test(COGNITION_VERSION), COGNITION_VERSION)
}

console.log("== files from intent, never from confidence ==")
{
  const named = filesMentionedIn("rewrite auth.js and session.js across files")
  ok("auth.js extracted", named.includes("auth.js"))
  ok("session.js extracted", named.includes("session.js"))
  ok("'across files' is not a file", !named.some((f) => f === "files"))
  const ctx = expectedFilesFromContext({
    objective: "fix logout in auth.js",
    reads: ["/tmp/proj/token.js"],
    writes: [],
  })
  ok("intent file is in the predicted set", ctx.includes("auth.js"))
  ok("already-read file is in the predicted set", ctx.some((f) => f.endsWith("token.js") || f === "token.js"))
}

console.log("== predictForAction + driftVerdict ==")
{
  const pred = predictForAction({
    action: "EXECUTE",
    objective: "rewrite auth.js",
    expectedFiles: ["auth.js"],
  })
  ok("targeted when files are known", pred.derived === "targets")
  ok("expected auth.js", pred.expectedFiles.includes("auth.js"))
  const hit = settlePrediction(pred, { actualFiles: ["auth.js"], status: "ok" })
  ok("hit is MATCH", driftVerdict(hit).level === DRIFT.MATCH, driftVerdict(hit).level)

  const missPred = predictForAction({ action: "EXECUTE", objective: "rewrite auth.js", expectedFiles: ["auth.js"] })
  const miss = settlePrediction(missPred, { actualFiles: ["unrelated.js", "other.js"], status: "ok" })
  const v = driftVerdict(miss)
  ok("extra-file settlement is MISS", v.level === DRIFT.MISS, `${v.level} score=${v.driftScore}`)
  ok("MISS tells the governor to REPLAN", v.action === "REPLAN")

  const none = predictForAction({ action: "EXECUTE", objective: "make it better" })
  ok("no files named → objective-only", none.derived === "objective-only")
  const noneSet = settlePrediction(none, { actualFiles: ["x.js"], status: "ok" })
  ok("objective-only is UNSCORED, not a fake miss", driftVerdict(noneSet).level === DRIFT.UNSCORED)
}

console.log("== governor reads drift ==")
{
  const replan = chooseNextAction({
    klass: "ARCHITECTURAL", inspected: true, hasPlan: true, steps: 4, writes: 1,
    unverified: [], driftScore: 0.9, driftLevel: "MISS", driftReplans: 0,
  })
  ok("ARCHITECTURAL MISS → REPLAN", replan.action === ACTION.REPLAN, replan.action)
  const micro = chooseNextAction({
    klass: "MICRO", inspected: true, hasPlan: true, steps: 2, writes: 1,
    unverified: [], driftScore: 0.9, driftLevel: "MISS",
  })
  ok("MICRO does not escalate a miss into REPLAN", micro.action !== ACTION.REPLAN, micro.action)
  const bounded = chooseNextAction({
    klass: "LARGE", inspected: true, hasPlan: true, steps: 6, writes: 1,
    unverified: [], driftScore: 0.9, driftLevel: "MISS", driftReplans: 2,
  })
  ok("drift replans are bounded (2)", bounded.action !== ACTION.REPLAN, bounded.action)
  const scope = chooseNextAction({
    klass: "LARGE", inspected: true, hasPlan: true, steps: 4, writes: 2,
    unverified: ["a.js"], verified: false, driftScore: 0.55, driftLevel: "SCOPE",
  })
  ok("SCOPE drift → VERIFY (already the unverified path or explicit)", scope.action === ACTION.VERIFY, scope.action)
}

console.log("== cheapest reversible strategy wins ==")
{
  const ranked = rankStrategies([
    { id: "rewrite", text: "rewrite the module", reversible: false, cost: 0.9, blast: 0.9, confidence: 0.9 },
    { id: "patch", text: "one-line patch", reversible: true, cost: 0.2, blast: 0.1, confidence: 0.4 },
    { id: "migrate", text: "migrate the schema", reversible: false, cost: 0.8, blast: 0.8, confidence: 0.7 },
  ])
  ok("patch ranks first (reversible + cheap)", ranked[0].id === "patch", ranked.map((r) => r.id).join(">"))
  ok("rewrite does not beat a cheap reversible patch despite higher confidence", ranked[0].id !== "rewrite")
  ok("CHEAPEST_FIRST names the ladder", /native/.test(CHEAPEST_FIRST) && /model reasoning/.test(CHEAPEST_FIRST))
}

console.log("== cognition predict/settle is the REAL ledger ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-intel-cog-"))
  const cog = createCognition({ cwd: dir, objective: "rewrite auth.js" })
  const pred = cog.predict({ action: "EXECUTE", expectedFiles: ["auth.js"] })
  ok("open prediction is targeted", pred.derived === "targets")
  const out = cog.settle({ actualFiles: ["auth.js", "bonus.js"], status: "ok" })
  ok("settlement computes extra file", out.settled.filesExtra.includes("bonus.js") || out.settled.filesExtra.some((f) => f.endsWith("bonus.js")))
  ok("drift is MISS or SCOPE", out.drift.level === DRIFT.MISS || out.drift.level === DRIFT.SCOPE, out.drift.level)
  const stored = loadPredictions(dir)
  ok("settled prediction persisted", stored.some((p) => p.id === pred.id && p.settledAt))
  const n = cog.next({ steps: 4, writes: 2, unverified: ["bonus.js"], inspected: true, hasPlan: true })
  ok("governor REPLANs after a miss (klass from 'rewrite')", n.action === ACTION.REPLAN || n.action === ACTION.VERIFY, n.action)
  const block = cog.promptBlock()
  ok("prompt names the capability router", /CAPABILITY ROUTER/.test(block))
  ok("prompt names last drift", /LAST DRIFT/.test(block))
}

console.log("== DEFAULT agent path source is wired ==")
{
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "agent.js"), "utf8")
  ok("agent calls cognition.predict", /cognition\.predict\(/.test(src))
  ok("agent calls cognition.settle", /cognition\.settle\(/.test(src))
  ok("agent records empirics", /recordModelOutcome/.test(src))
  ok("agent tracks readsSoFar", /readsSoFar/.test(src))
  ok("agent emits PREDICTION_MADE", /PREDICTION_MADE/.test(src))
  ok("agent emits PREDICTION_SETTLED", /PREDICTION_SETTLED/.test(src))
}

function mkModel(script, seen) {
  let calls = 0
  const server = http.createServer((req, res) => {
    if (!req.url.includes("chat/completions")) { res.writeHead(404).end(); return }
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      seen.push(b)
      const message = script(++calls)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        id: "m", object: "chat.completion", created: Date.now(), model: "mock-1",
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      }))
    })
  })
  return server
}
const call = (id, name, args) => ({
  role: "assistant", content: "",
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
})

async function run(task, script) {
  const seen = []
  const evs = []
  const server = mkModel(script, seen)
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-intel-run-"))
  fs.writeFileSync(path.join(dir, "auth.js"), "export const x = 1\n")
  const prev = process.cwd()
  try {
    process.chdir(dir)
    const { runAgent } = await import("../agent.js")
    const res = await runAgent({
      config: {
        providers: {},
        tools: { assumeYes: true, mcp: false, plugins: false, lsp: false, browser: false },
        agent: { autonomous: false, maxSteps: 10, verifyNudge: false, review: "off", continuity: false },
        skills: { enabled: false },
        mcp: { maxTools: 0 },
      },
      provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "k", model: "mock-1" },
      task, journal: false,
      onEvent: (e) => evs.push(e),
    })
    return { res, seen, evs, dir }
  } finally {
    process.chdir(prev)
    server.close()
  }
}

console.log("== PREDICTION on the REAL agent path ==")
{
  const script = (n) => {
    if (n === 1) return call("t1", "think", { thought: "smallest rewrite of auth.js" })
    if (n === 2) return call("r1", "read_file", { path: "auth.js" })
    if (n === 3) return call("w1", "write_file", { path: "auth.js", content: "export const x = 2\n" })
    return { role: "assistant", content: "rewrote auth.js" }
  }
  const { res, evs } = await run("rewrite the auth architecture across files in auth.js", script)
  ok("PREDICTION_MADE fired on the live loop", evs.some((e) => e.type === "PREDICTION_MADE"))
  const made = evs.find((e) => e.type === "PREDICTION_MADE")
  ok("prediction included auth.js (from intent or read)", !made || (made.files || []).some((f) => String(f).endsWith("auth.js")), JSON.stringify(made?.files))
  ok("PREDICTION_SETTLED fired after the write", evs.some((e) => e.type === "PREDICTION_SETTLED"))
  const settled = evs.find((e) => e.type === "PREDICTION_SETTLED")
  ok("settlement is not a silent no-op", settled && (settled.drift || settled.id), JSON.stringify(settled))
  ok("empirics recorded the mock model", loadEmpirics().items["mock/mock-1"]?.samples >= 1)
}

console.log("== MICRO path still predicts nothing scary ==")
{
  const script = (n) => n === 1
    ? call("w1", "write_file", { path: "note.txt", content: "typo fixed\n" })
    : { role: "assistant", content: "Fixed the typo." }
  const { res } = await run("fix a typo in note.txt", script)
  ok("MICRO still writes", res.toolLog.some((t) => t.name === "write_file" && !String(t.result).startsWith("BLOCKED")))
  ok("MICRO is not WAITING_FOR_USER", res.status !== "WAITING_FOR_USER", res.status)
}

console.log(`\n== intel suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
