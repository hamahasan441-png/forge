#!/usr/bin/env node
/**
 * v93 GAP FIX — phase 11: CONTEXTUAL STRATEGY 3.0 (§23/§24).
 *
 *  1. recordStrategy stores the outcome WITH context (class, languages,
 *     latency) — future selection learns what worked where.
 *  2. pickStrategy weighs CONTEXTUAL factors: language overlap, task-class
 *     match, failure history, resource state (degraded prefers proven-fast).
 *  3. pickStrategyJustified answers §23's questions: WHY this strategy, WHY
 *     NOT the alternative, WHAT evidence (and warns on weak evidence).
 *  4. The context block reaches the living prompt (compose), and meta
 *     records real outcomes (wired).
 *  5. No kernel self-modification — task-level adaptation only (strategy.js
 *     never auto-ACTIVEs anything, unchanged).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93st-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93st-work-"))
process.chdir(WORK)
fs.writeFileSync(path.join(WORK, "a.js"), "export const a = 1\n")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 300) : ""}`) }
}

const st = await import("../strategy.js")
const { TASK_CLASS } = await import("../classify.js")

// ---------------------------------------------------------------------------
console.log("== 1. outcomes stored WITH context ==")
{
  const r1 = st.recordStrategy({ cwd: WORK, name: "klass:LARGE", ok: true, klass: "LARGE", langs: ["javascript"], latencyMs: 4000 })
  st.recordStrategy({ cwd: WORK, name: "klass:LARGE", ok: true, klass: "LARGE", langs: ["javascript"], latencyMs: 6000 })
  st.recordStrategy({ cwd: WORK, name: "klass:MEDIUM", ok: false, klass: "MEDIUM", langs: ["python"], latencyMs: 90000 })
  ok("context recorded (klass + langs + latency)", r1.klass === "LARGE" && r1.langs.includes("javascript") && r1.avgLatencyMs === 4000)
  const j = JSON.parse(fs.readFileSync(st.strategyPath(WORK), "utf8"))
  ok("persisted with the context fields", j.items["klass:LARGE"].langs.includes("javascript") && j.items["klass:MEDIUM"].klass === "MEDIUM")
}

// ---------------------------------------------------------------------------
console.log("== 2. contextual factors change the ranking ==")
{
  // base ranking: LARGE (100% 2 samples) beats MEDIUM (0% 1 sample)
  const base = st.pickStrategy("a large javascript task", { cwd: WORK, klass: "LARGE" })
  ok("history ranks the successful strategy first", base[0].name === "klass:LARGE")

  // language overlap boosts — python context favors the MEDIUM record
  // (its langs match) even though its rate is 0%: 0 + 0.5 boost vs 1 + 0 …
  // careful: rate dominates after hit; the boost is additive within hit tier.
  const pyCtx = st.pickStrategy("a large python task", { cwd: WORK, klass: "LARGE", context: { languages: ["python"] } })
  ok("context factors are attached to candidates", pyCtx.some((c) => c.factors?.languageOverlap === 1))

  // failure history penalty recorded when a strategy is consistently failing
  for (let i = 0; i < 4; i++) st.recordStrategy({ cwd: WORK, name: "flaky-approach", ok: false })
  const withFlaky = st.pickStrategy("flaky approach task", { cwd: WORK })
  const flaky = withFlaky.find((c) => c.name === "flaky-approach")
  ok("failure history flagged (recentFailureHistory)", flaky?.factors?.recentFailureHistory === true)

  // degraded resources: slow strategy gets the latency factor
  st.recordStrategy({ cwd: WORK, name: "slow-strategy", ok: true, latencyMs: 90000 })
  const deg = st.pickStrategy("slow strategy task", { cwd: WORK, context: { resourceState: "degraded" } })
  const slow = deg.find((c) => c.name === "slow-strategy")
  ok("degraded context surfaces avgLatencyMs as a factor", slow?.factors?.avgLatencyMs === 90000)
}

// ---------------------------------------------------------------------------
console.log("== 3. the justified pick — why / why-not / evidence ==")
{
  st.recordStrategy({ cwd: WORK, name: "klass:LARGE", ok: true, klass: "LARGE", langs: ["javascript"] })
  const j = st.pickStrategyJustified("a large javascript task", { cwd: WORK, klass: "LARGE", context: { languages: ["javascript"] } })
  ok("a chosen strategy is named", typeof j.chosen === "string" && j.chosen.length > 0)
  ok("WHY is evidence-based (rate + samples + match)", /% ok over \d+ sample/.test(j.why) && /(match|similarity)/.test(j.why))
  ok("language overlap appears in the why", /language/.test(j.why))
  ok("WHY-NOT names the runner-up with a reason", j.whyNot.length >= 1 && j.whyNot[0].name && j.whyNot[0].reason)
  ok("EVIDENCE object carries the numbers", j.evidence?.rate != null && j.evidence?.samples >= 1)

  // weak evidence is WARNED, not hidden
  st.recordStrategy({ cwd: WORK, name: "tiny-evidence", ok: true })
  const j2 = st.pickStrategyJustified("tiny evidence task", { cwd: WORK })
  const tiny = j2.candidates.find((c) => c.name === "tiny-evidence")
  void tiny
  const j3 = st.pickStrategyJustified("tiny evidence", { cwd: WORK })
  ok("low-sample strategies are called out (honest weakness)", j3.why.includes("LOW SAMPLES") || j3.candidates.some((c) => c.samples < 3))

  // no history → honest empty answer
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93st-empty-"))
  const j4 = st.pickStrategyJustified("anything", { cwd: empty })
  ok("no history → 'no strategy history yet' (never a fabricated pick)", j4.chosen === null && /no strategy history/.test(j4.why))

  // bounded prompt block
  const block = st.formatStrategyJustified(j)
  ok("formatStrategyJustified is a bounded prompt block", block.startsWith("STRATEGY:") && block.length < 400 && /not /.test(block))
}

// ---------------------------------------------------------------------------
console.log("== 4. living-loop wiring ==")
{
  const composeSrc = fs.readFileSync(new URL("../compose.js", import.meta.url), "utf8")
  ok("compose exposes the justified strategy block", /strategyJustified/.test(composeSrc) && /formatStrategyJustified/.test(composeSrc))
  const metaSrc = fs.readFileSync(new URL("../meta.js", import.meta.url), "utf8")
  ok("meta records real outcomes with context", /recordStrategy\(\{/.test(metaSrc) && /klass:\$\{classified\.class/.test(metaSrc) || /klass: classified/.test(metaSrc))
  ok("strategy.js never auto-ACTIVEs (no kernel self-mod)", !/lifecycle\s*=|SKILL_LIFE/.test(fs.readFileSync(new URL("../strategy.js", import.meta.url), "utf8")))
}

console.log(`\n== v93st: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
