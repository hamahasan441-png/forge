#!/usr/bin/env node
/**
 * v92 "wirewise" — island wiring, part 1: the units.
 *
 *  1. Prediction ledger (§9): predict → settle → reality delta → persist →
 *     calibration → prompt feedback; honesty rules (objective-only entries,
 *     unknown reality stays null, insufficient evidence stays silent).
 *  2. Language adapter wiring API (§7/§8): languageCoverage is honest about
 *     deep/shallow/unknown; adapterBrief is per-file honest, bounded, and
 *     never throws on garbage input.
 *  3. agent.js plugin TDZ regression (P0): `unrestricted` must be declared
 *     before first use — source order lock + BEHAVIORAL proof: runAgent with
 *     a real plugin in ~/.forge/tools and a local mock provider must load
 *     the plugin (the v91 bug silently swallowed the ReferenceError, so
 *     plugins never loaded in any agent run).
 *  4. chat.js /tools help: honest dynamic tool count (was hardcoded "18").
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v92-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v92-work-"))
process.chdir(WORK)
fs.writeFileSync(path.join(WORK, "a.js"), "export const a = 1\n")
fs.writeFileSync(path.join(WORK, "b.md"), "# readme\n")
fs.writeFileSync(path.join(WORK, "legacy.cob"), "IDENTIFICATION DIVISION.\n")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 220) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const pred = await import("../prediction.js")
const { languageCoverage, adapterBrief, catalogSize, adapterFor } = await import("../langadapter.js")
const { integrateResults } = await import("../integrate.js")
const HERE = path.dirname(new URL(import.meta.url).pathname)
const FORGE = path.resolve(HERE, "..")

// ---------------------------------------------------------------------------
console.log("== 1. prediction ledger: predict → settle → reality delta (§9) ==")
{
  const p = pred.predictForNode({
    node: { id: "n1", targetFiles: [path.join(WORK, "a.js"), path.join(WORK, "b.md")], risk: "low" },
    objective: "edit a and b", riskLevel: "low", segment: 3, segmentId: "seg-3", taskId: "t-92",
  })
  ok("prediction has identity", p.taskId === "t-92" && p.nodeId === "n1" && p.segmentId === "seg-3" && p.segment === 3)
  ok("expected files derived from node targets (relative)", JSON.stringify(p.expectedFiles) === JSON.stringify(["a.js", "b.md"]))
  ok("prediction is deterministic, not model confidence", p.derived === "targets" && p.expectedOutcome === "advance")
  ok("un-settled reality is null, never zero", p.actualFiles === null && p.finalRisk === null && p.status === null)

  const s = pred.settlePrediction(p, {
    actualFiles: [path.join(WORK, "a.js"), path.join(WORK, "c.js")],
    finalRisk: "medium", status: "ok",
  })
  eq("filesHit: predicted ∩ actual", s.filesHit, ["a.js"])
  eq("filesExtra: scope drift is explicit", s.filesExtra, ["c.js"])
  eq("filesMissed: incomplete work is explicit", s.filesMissed, ["b.md"])
  eq("riskDelta is ladder steps", s.riskDelta, 1)
  ok("outcomeCorrect for a clean advance", s.outcomeCorrect === true)
  ok("driftScore 1.0 when reality is fully outside prediction", Math.abs(s.driftScore - 1) < 1e-9)

  const perfect = pred.settlePrediction(
    pred.predictForNode({ node: { id: "n2", targetFiles: [path.join(WORK, "a.js")] }, riskLevel: "low", segment: 4 }),
    { actualFiles: [path.join(WORK, "a.js")], finalRisk: "low", status: "ok" },
  )
  ok("perfect prediction drifts 0", perfect.driftScore === 0 && perfect.filesExtra.length === 0 && perfect.filesMissed.length === 0)

  const errored = pred.settlePrediction(
    pred.predictForNode({ node: { id: "n3", targetFiles: [path.join(WORK, "a.js")] }, riskLevel: "low", segment: 5 }),
    { actualFiles: [], finalRisk: "low", status: "error" },
  )
  ok("errored advance is outcome-mispredicted", errored.outcomeCorrect === false)
  ok("unknown status stays null, not guessed", pred.settlePrediction(p, {}).outcomeCorrect === null)

  const objOnly = pred.predictForNode({ node: null, objective: "do something", riskLevel: null, segment: 1 })
  ok("no targets ⇒ honest objective-only label", objOnly.derived === "objective-only" && objOnly.expectedFiles.length === 0)
  ok("objective-only never fabricates file hits", pred.settlePrediction(objOnly, { actualFiles: ["x.js"], finalRisk: "low", status: "ok" }).filesHit.length === 0)
}

console.log("== 2. prediction ledger: persistence, calibration, prompt feedback ==")
{
  // five settled predictions — enough to cross the calibration minimum
  const mk = (i, exp, act, fr) => pred.settlePrediction(
    pred.predictForNode({ node: { id: `n${i}`, targetFiles: exp.map((f) => path.join(WORK, f)) }, riskLevel: "low", segment: i }),
    { actualFiles: act.map((f) => path.join(WORK, f)), finalRisk: fr, status: "ok" },
  )
  const entries = [
    mk(1, ["a.js"], ["a.js"], "low"),        // perfect
    mk(2, ["a.js"], ["a.js"], "low"),        // perfect
    mk(3, ["a.js"], ["a.js", "zz.js"], "medium"), // drift + risk escalation
    mk(4, ["a.js"], ["a.js"], "low"),        // perfect
    mk(5, ["a.js", "b.md"], [], "high"),     // missed everything + big risk surprise
  ]
  for (const e of entries) ok(`entry ${e.id} persisted`, pred.recordPrediction(e, WORK) === true)
  const loaded = pred.loadPredictions(WORK)
  eq("load returns every settled entry", loaded.length, 5)
  ok("persistence is atomic and round-trips", loaded[4].filesMissed.includes("b.md") && loaded[4].riskDelta === 2)

  const cal = pred.predictionCalibration(WORK)
  ok("calibration is sufficient at 5 samples", cal.sufficient === true && cal.samples === 5)
  ok("file precision computed from targeted entries only", Math.abs(cal.filePrecision - 4 / 6) < 1e-9) // 6 files predicted, 4 hit
  ok("risk escalations counted", cal.riskEscalations === 2 && cal.riskBias > 0)
  ok("scope drift rate reflects the extra file", cal.scopeDriftRate > 0)

  const feedback = pred.predictionsForPrompt(WORK)
  ok("prompt feedback mentions under-predicted risk", /UNDER-predicted/.test(feedback))
  ok("prompt feedback surfaces the worst real misses", /b\.md|left untouched/.test(feedback))
  ok("prompt feedback is bounded", feedback.length <= 420 + 40)

  // honesty: below the minimum, calibration says insufficient and stays silent
  const FRESH = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v92b-"))
  const cal0 = pred.predictionCalibration(FRESH)
  ok("below minimum: insufficient evidence, not zeros", cal0.sufficient === false && /insufficient/.test(cal0.note))
  eq("below minimum: no prompt feedback", pred.predictionsForPrompt(FRESH), "")
  const three = [mk(6, ["a.js"], ["a.js"], "low"), mk(7, ["a.js"], ["a.js"], "low"), mk(8, ["a.js"], ["a.js"], "low")]
  for (const e of three) pred.recordPrediction(e, FRESH)
  eq("still below 5: silent", pred.predictionsForPrompt(FRESH), "")

  // bounded ledger: cap enforced on record
  const BIG = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v92c-"))
  for (let i = 0; i < pred.MAX_PREDICTIONS + 25; i++) {
    pred.recordPrediction(pred.settlePrediction(pred.predictForNode({ node: { id: `x${i}`, targetFiles: [] }, segment: i }), { actualFiles: [], finalRisk: "low", status: "ok" }), BIG)
  }
  ok(`ledger is bounded at ${pred.MAX_PREDICTIONS}`, pred.loadPredictions(BIG).length <= pred.MAX_PREDICTIONS)
  ok("recordPrediction rejects non-records instead of poisoning the ledger", pred.recordPrediction(null, BIG) === false && pred.recordPrediction({}, BIG) === false)
}

// ---------------------------------------------------------------------------
console.log("== 3. language adapter coverage: honest deep/shallow/unknown (§7/§8) ==")
{
  const cov = languageCoverage(["javascript", "python", "kotlin", "Kotlin", "cobol", "plsql", "frobnicate"])
  const byId = Object.fromEntries(cov.map((c) => [c.id, c]))
  ok("deep adapters recognized (js/python/kotlin)", byId.javascript.deep && byId.python.deep && byId.kotlin.deep)
  ok("deep adapters are not conservative", !byId.javascript.conservative && !byId.kotlin.conservative)
  ok("shallow catalog languages are conservative", byId.cobol.conservative && /conservative/.test(byId.cobol.note) && byId.plsql.conservative)
  ok("shallow note carries the toolchain bins when known", /cobc/.test(byId.cobol.note))
  ok("unknown language is honest about not being in the catalog", byId.frobnicate.conservative && /not in the adapter catalog/.test(byId.frobnicate.note))
  ok("duplicates collapsed (Kotlin == kotlin)", cov.filter((c) => c.id === "kotlin").length === 1)
  eq("empty input is empty", languageCoverage([]).length, 0)
  eq("nullish/blank input produces no entries", languageCoverage([null, undefined, "", "unknown"]).length, 0)
  ok("garbage input never throws", Array.isArray(languageCoverage([42, {}, ["x"]])))
  ok("catalog still reports 60+ languages", catalogSize().total >= 60)
}

console.log("== 4. adapterBrief: per-file honesty, bounded, never fatal ==")
{
  const brief = adapterBrief([path.join(WORK, "a.js"), path.join(WORK, "legacy.cob"), path.join(WORK, "deploy.tf")])
  ok("brief carries the header", /language adapter status/.test(brief))
  ok("a.js resolves to its deep adapter", /a\.js: javascript \[deep\]/.test(brief))
  ok("legacy.cob resolves to its shallow adapter (conservative)", /legacy\.cob: cobol \[conservative\]/.test(brief))
  ok("deploy.tf is terraform, deep", /deploy\.tf: terraform/.test(brief))
  ok("brief bounded", brief.length <= 600)
  eq("no files ⇒ no brief (never fabricates)", adapterBrief([]), "")
  ok("garbage file list never throws", typeof adapterBrief([null, "", 42, "/nonexistent/nothing.weird"]) === "string")
  ok("adapterFor keeps the honest capability contract", (() => { const a = adapterFor("x.kt"); return a.capabilities.parser === null && a.id === "kotlin" })())
}

// ---------------------------------------------------------------------------
console.log("== 5. P0 regression: the plugin-load TDZ in agent.js ==")
{
  // (a) source-order lock: `const unrestricted` must precede its first use
  const src = fs.readFileSync(path.join(FORGE, "agent.js"), "utf8")
  const decl = src.indexOf("const unrestricted")
  const firstUse = src.indexOf("unrestricted ||")
  ok("agent.js: `unrestricted` declared before first use", decl !== -1 && firstUse !== -1 && decl < firstUse)
  const loadCall = src.indexOf("loadToolPlugins(undefined")
  ok("agent.js: declaration precedes the plugin load call", decl < loadCall)
  ok("agent.js: exactly one declaration (not re-declared later)", src.split("const unrestricted").length === 2)
}

// (b) BEHAVIORAL: a real plugin in ~/.forge/tools + a local mock provider —
// runAgent must load it. With the v91 TDZ bug the load threw ReferenceError,
// the catch swallowed it and NO plugin ever loaded.
{
  const pluginDir = path.join(HOME, "tools")
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(path.join(pluginDir, "wire.mjs"),
    `export default { name: "hello_wire", description: "wirewise regression probe", parameters: { type: "object", properties: {} }, readOnly: true, async run(){ return "wired" } }`)

  // minimal OpenAI-wire mock: every completion returns final text
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && /chat\/completions$/.test(req.url)) {
      let body = ""
      req.on("data", (c) => { body += c })
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({
          id: "chat_mock", object: "chat.completion", created: Date.now(), model: "mock-1",
          choices: [{ index: 0, message: { role: "assistant", content: "wirewise plugin probe done" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }))
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
      task: "say the probe phrase",
      onEvent: (e) => events.push(e),
      journal: false,
    })
    const infos = events.filter((e) => e.type === "info").map((e) => e.text ?? "")
    ok("runAgent completed against the mock", r.status !== "FAILED", JSON.stringify(r.error ?? ""))
    ok("PLUGIN LOADED in runAgent (the TDZ fix, behaviorally)", infos.some((t) => /tool plugin loaded: hello_wire/.test(t)), infos.join(" | ").slice(0, 200))
    ok("no silent plugin-load failure", !infos.some((t) => /tool plugin skipped/.test(t)))
  } finally {
    server.close()
  }
}

// ---------------------------------------------------------------------------
console.log("== 6. /tools help: honest dynamic tool count ==")
{
  const { toolCount } = await import("../tools.js")
  const src = fs.readFileSync(path.join(FORGE, "chat.js"), "utf8")
  ok("chat.js no longer hardcodes 18 tools", !/the 18 agent tools/.test(src))
  ok("chat.js interpolates the real count (template literal)", new RegExp(`list the \\$\\{toolCount\\(\\)\\} agent tools`).test(src))
  // v94c: 26 -> 29 (toolwise), lock stays exact
  ok("the real count is 29", toolCount() === 29)
}

console.log(`\n== v92 part 1: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
