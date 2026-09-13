#!/usr/bin/env node
/**
 * forge — P1 model routing on real performance history.
 *
 * Routing must use what forge OBSERVED (success rate, repair rate,
 * verification pass rate, latency p50/p95, token efficiency, reliability),
 * damped so a single bad sample cannot blacklist a model. The registry entry is
 * a prior, not the verdict.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-model-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-model-work-"))
process.chdir(WORK)

const ms = await import("../modelstrategy.js")
const { recordOutcome, effectiveStats, loadPerformance, clearPerformance, PERF_FILE, selectModel } = ms

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

clearPerformance()

console.log("== outcomes are recorded with every dimension ==")
{
  const rec = recordOutcome({
    provider: "openai", model: "gpt-4o-mini", taskClass: "coding",
    ok: true, repairs: 1, verificationPassed: true, latencyMs: 1200,
    tokensIn: 900, tokensOut: 300, toolCalls: 4,
  })
  eq("samples", rec.samples, 1)
  eq("successes", rec.successes, 1)
  eq("repairs", rec.repairs, 1)
  ok("verification counted", rec.verificationTotal === 1 && rec.verificationPassed === 1)
  ok("latency recorded", rec.latencyMs.includes(1200))
  ok("tokens recorded", rec.tokensIn === 900 && rec.tokensOut === 300)
  ok("tool calls recorded", rec.toolCalls === 4)
  ok("per-task-class breakdown", rec.byClass.coding.samples === 1)
  ok("persisted to disk", fs.existsSync(PERF_FILE))
  ok("loadPerformance reads it back", !!loadPerformance()["openai:gpt-4o-mini"])
}

console.log("== the metrics the router needs are all present ==")
{
  for (let i = 0; i < 6; i++) {
    recordOutcome({ provider: "anthropic", model: "claude-sonnet-4-5", ok: true, repairs: 0, verificationPassed: true, latencyMs: 1000 + i * 100, tokensIn: 100, tokensOut: 50 })
  }
  const s = effectiveStats("claude-sonnet-4-5", "anthropic")
  for (const k of ["successRate", "repairRate", "verificationPassRate", "reliability", "latencyP50", "latencyP95", "tokenEfficiency", "contextWindow", "samples"]) {
    ok(`effectiveStats.${k} present`, k in s)
  }
  ok("rates are in 0..1", [s.successRate, s.repairRate, s.verificationPassRate, s.reliability].every((v) => v >= 0 && v <= 1))
  ok("p50 <= p95", s.latencyP50 <= s.latencyP95)
  ok("samples counted", s.samples === 6)
  ok("history flag set", s.fromHistory === true)
}

console.log("== one bad sample must NOT dominate ==")
{
  clearPerformance()
  for (let i = 0; i < 12; i++) recordOutcome({ provider: "p", model: "good-model", ok: true, repairs: 0, verificationPassed: true, latencyMs: 800 })
  const before = effectiveStats("good-model", "p").successRate
  recordOutcome({ provider: "p", model: "good-model", ok: false, repairs: 1, verificationPassed: false, latencyMs: 9000 })
  const after = effectiveStats("good-model", "p").successRate
  ok(`a single failure only dents the rate (${before} → ${after})`, before - after < 0.12)
  ok("the model is still considered good", after > 0.7)
}

console.log("== …but a real failure pattern does change routing ==")
{
  clearPerformance()
  for (let i = 0; i < 25; i++) recordOutcome({ provider: "p", model: "bad-model", ok: false, repairs: 3, verificationPassed: false, latencyMs: 5000 })
  const s = effectiveStats("bad-model", "p")
  ok("success rate collapses", s.successRate < 0.3)
  ok("verification pass rate collapses", s.verificationPassRate < 0.35)
  ok("the verdict says history", s.fromHistory === true)
}

console.log("== routing actually uses the history ==")
{
  clearPerformance()
  const config = {
    providers: {
      alpha: { protocol: "openai", baseUrl: "https://alpha.example.com/v1", model: "alpha-model", apiKey: "k", timeoutMs: 1000 },
      beta: { protocol: "openai", baseUrl: "https://beta.example.com/v1", model: "beta-model", apiKey: "k", timeoutMs: 1000 },
    },
    agent: {},
  }
  const clean = selectModel(config, { task: "fix the parser bug", provider: { name: "alpha", model: "alpha-model" } })
  ok("a decision was made", !!clean.decision)
  const alphaBefore = clean.candidates.find((c) => c.model === "alpha-model")?.score ?? 0
  // alpha starts failing repeatedly, beta keeps succeeding
  for (let i = 0; i < 25; i++) {
    recordOutcome({ provider: "alpha", model: "alpha-model", ok: false, repairs: 3, verificationPassed: false, latencyMs: 6000 })
    recordOutcome({ provider: "beta", model: "beta-model", ok: true, repairs: 0, verificationPassed: true, latencyMs: 900 })
  }
  const after = selectModel(config, { task: "fix the parser bug", provider: { name: "alpha", model: "alpha-model" } })
  const alphaAfter = after.candidates.find((c) => c.model === "alpha-model")?.score ?? 0
  const betaAfter = after.candidates.find((c) => c.model === "beta-model")?.score ?? 0
  ok(`history lowered alpha's score (${alphaBefore} → ${alphaAfter})`, alphaAfter < alphaBefore)
  ok(`history ranked beta above alpha (${betaAfter} > ${alphaAfter})`, betaAfter > alphaAfter)
  const alphaPerf = after.candidates.find((c) => c.model === "alpha-model")?.performance
  ok("each candidate carries its performance record", !!alphaPerf)
  ok("the record is built from history", alphaPerf?.fromHistory === true)
  ok("the record carries the measured rates", typeof alphaPerf?.successRate === "number" && typeof alphaPerf?.verificationPassRate === "number")
  ok("the reason mentions measured performance", /measured/.test(after.candidates.find((c) => c.model === "alpha-model")?.reasons.join(" ") ?? ""))
}

console.log("== an unknown model gets the neutral prior, not a fabricated score ==")
{
  clearPerformance()
  const s = effectiveStats("totally-unknown-model", "nobody")
  eq("no samples", s.samples, 0)
  ok("history flag is false", s.fromHistory === false)
  ok("recognized is false", s.recognized === false)
  ok("latency is unknown, not zero", s.latencyP50 === null)
  ok("success rate falls back to the prior", s.successRate > 0 && s.successRate < 1)
}

console.log("== the history store is bounded and isolated per model ==")
{
  clearPerformance()
  for (let i = 0; i < 10; i++) recordOutcome({ provider: "p", model: `m${i}`, ok: i % 2 === 0 })
  const all = loadPerformance()
  ok("every model has its own entry", Object.keys(all).length === 10)
  eq("model keys are provider:model", Object.keys(all)[0], "p:m0")
  recordOutcome({ provider: "p", model: "m0", ok: true })
  recordOutcome({ provider: "q", model: "m0", ok: false })
  ok("the same model on two providers is tracked separately",
    loadPerformance()["p:m0"].successes !== loadPerformance()["q:m0"].successes)
  clearPerformance()
  eq("clearPerformance empties the store", Object.keys(loadPerformance()).length, 0)
}

console.log(`\n== model-routing-history suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
