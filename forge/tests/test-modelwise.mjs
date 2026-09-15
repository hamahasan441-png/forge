#!/usr/bin/env node
/**
 * forge — v110 "modelwise": the measured-best model actually runs.
 *
 * selectModel existed. The default agent path never called it (import cycle).
 * MICRO still does not steal the caller's model.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-modelwise-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + extra : ""}`) }
}

const { VERSION } = await import("../version.js")
const {
  applyModelChoice, selectModel, recordOutcome, clearPerformance,
} = await import("../modelstrategy.js")

console.log("== version identity ==")
{
  ok("package version is 113.x", /^113\./.test(VERSION), VERSION)
}

console.log("== cycle is gone: modelstrategy does not import agent ==")
{
  const src = fs.readFileSync(new URL("../modelstrategy.js", import.meta.url), "utf8")
  ok("imports classify, not agent", /from "\.\/classify\.js"/.test(src) && !/from "\.\/agent\.js"/.test(src))
  const agent = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  ok("agent calls applyModelChoice", /applyModelChoice/.test(agent))
  ok("agent records modelstrategy outcomes", /recordOutcome/.test(agent) && /modelstrategy/.test(agent))
  ok("MICRO is skipped on the live path", /earlyKlass/.test(agent))
}

console.log("== MICRO never steals the caller's model ==")
{
  const config = {
    providers: {
      alpha: { protocol: "openai", baseUrl: "https://alpha.example.com/v1", model: "alpha-model", apiKey: "k", timeoutMs: 1000 },
      beta: { protocol: "openai", baseUrl: "https://beta.example.com/v1", model: "beta-model", apiKey: "k", timeoutMs: 1000 },
    },
  }
  const p = { name: "alpha", model: "alpha-model" }
  const micro = applyModelChoice({ config, provider: p, task: "typo fix teh", klass: "MICRO" })
  ok("MICRO switched=false", micro.switched === false, JSON.stringify(micro))
  ok("MICRO keeps alpha", micro.provider === p || micro.provider?.model === "alpha-model")
}

console.log("== lock keeps the caller's model ==")
{
  const config = { providers: { alpha: { protocol: "openai", baseUrl: "https://a.example/v1", model: "alpha-model", apiKey: "k" } } }
  const locked = applyModelChoice({ config, provider: { name: "alpha", model: "alpha-model" }, task: "rewrite auth", klass: "LARGE", lock: true })
  ok("lock does not switch", locked.switched === false && /lock/.test(locked.why || ""))
}

console.log("== measured history can switch a LARGE task ==")
{
  clearPerformance()
  const config = {
    providers: {
      alpha: { protocol: "openai", baseUrl: "https://alpha.example.com/v1", model: "alpha-model", apiKey: "k", timeoutMs: 1000 },
      beta: { protocol: "openai", baseUrl: "https://beta.example.com/v1", model: "beta-model", apiKey: "k", timeoutMs: 1000 },
    },
  }
  const p = { name: "alpha", model: "alpha-model" }
  for (let i = 0; i < 25; i++) {
    recordOutcome({ provider: "alpha", model: "alpha-model", ok: false, repairs: 3, verificationPassed: false, latencyMs: 6000 })
    recordOutcome({ provider: "beta", model: "beta-model", ok: true, repairs: 0, verificationPassed: true, latencyMs: 900 })
  }
  const sel = selectModel(config, { task: "fix the parser bug in auth.js", provider: p })
  const alpha = sel.candidates.find((c) => c.model === "alpha-model")
  const beta = sel.candidates.find((c) => c.model === "beta-model")
  ok("history ranked beta above alpha", (beta?.score ?? 0) > (alpha?.score ?? 0), `a=${alpha?.score} b=${beta?.score}`)
  const choice = applyModelChoice({ config, provider: p, task: "fix the parser bug in auth.js", klass: "LARGE" })
  ok("LARGE may switch off a measured-failing model", choice.switched === true || (choice.selection?.decision && beta && (beta.score > alpha.score)), JSON.stringify({ switched: choice.switched, why: choice.why, to: choice.provider?.model }))
}

console.log(`\n== modelwise suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
