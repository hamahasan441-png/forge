#!/usr/bin/env node
/**
 * forge — v121 "deadwire": three learning loops that never reached a decision.
 *
 * The §44 dead-wire audit ran against the real source: 162 modules, 1580
 * exports, 28 per-project stores. Most of the premise did NOT hold — caplearn
 * reaches shouldWithhold/reputation, jointroute reaches a real model switch in
 * agent.js, crewroute reaches role/model scoring, empirics reaches
 * pickModelEmpiric, episodes reach engmemory's L4 retrieval, skilllife reaches
 * pickSkills. Those are closed and stay closed.
 *
 * Three were not, and each is reproduced here before the fix is asserted:
 *
 *  1. MEASURED RISK ERROR NEVER REACHED THE RISK NUMBER. predictionCalibration
 *     computes eight signals; plannerisk consumed one (avgDrift). Eight settled
 *     predictions that each ended TWO ladder steps above what was predicted
 *     produced byte-identical risk to a project with no history: 0.278 "low".
 *     The prompt said "risk was UNDER-predicted 8/8 times"; the number the
 *     planner decides on never moved — and riskLadder gates alternatives().
 *
 *  2. strategy.json RECORDED A TASK CLASS, NOT A STRATEGY. meta.js wrote every
 *     segment as `klass:<CLASS>`, so the store held one row per class and the
 *     prompt offered "STRATEGY: klass:MEDIUM … not klass:LARGE (lower)" — a
 *     choice between task classes, which is not choosable.
 *
 *  3. STRATEGY OUTCOMES WERE KEYED BY ORDINAL. usermodel assigns IH1..IHn
 *     positionally per cue branch, so IH1 is "make the failing check pass" for
 *     one task and "raise quality" for another, sharing one metalearn row that
 *     rankStrategies weights at ±0.85 EV.
 *
 * The guard matters more than the fix: learning must stay damped, raise-only
 * and bounded, or it is enthusiasm with a ledger.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v121-"))
process.env.FORGE_HOME = HOME
const ROOT = path.dirname(new URL("../package.json", import.meta.url).pathname)

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 260)}` : ""}`) } }

const { recordPrediction, predictionCalibration, MIN_CALIBRATION_SAMPLES } = await import("../prediction.js")
const { assessPlan, predictNodes, alternatives, calibrationPressure, CALIBRATION_MIN_SAMPLES } = await import("../plannerisk.js")
const { pickStrategy, recordProjectStrategy, LEGACY_CLASS_ROW } = await import("../strategy.js")
const { rankStrategies, strategyKey } = await import("../governor.js")
const { recordStrategy, strategyRates } = await import("../metalearn.js")
const { intentHypothesesFor } = await import("../usermodel.js")

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `v121-${tag}-`))

/** A settled prediction shaped exactly as settlePrediction() emits one. */
const settled = (i, over) => ({
  id: `p${i}`, settledAt: Date.now(), derived: "targets",
  expectedFiles: ["a.js"], filesHit: ["a.js"], filesExtra: [], filesMissed: [],
  driftScore: 0.1, expectedRisk: "low", finalRisk: "high", riskDelta: over,
  outcomeCorrect: true, testsDelta: 0, stepsDelta: 0,
})

/** Two mutating nodes with declared verification — deliberately unremarkable,
 *  so any movement in the number comes from calibration and nothing else. */
const DAG = [
  { id: "n1", objective: "edit a.js", risk: "low", read_only: false, targetFiles: ["a.js"], dependencies: [], verificationRequirements: ["test"] },
  { id: "n2", objective: "edit b.js", risk: "low", read_only: false, targetFiles: ["b.js"], dependencies: ["n1"], verificationRequirements: ["test"] },
]
const calFor = (n, over) => {
  const cwd = tmp("cal")
  for (let i = 0; i < n; i++) recordPrediction(settled(i, over), cwd)
  return predictionCalibration(cwd)
}
const riskOf = (cal) => assessPlan(DAG, { klass: "MEDIUM", calibration: cal, lessons: [] })

// ---------------------------------------------------------------------------
console.log("== 1. measured risk error reaches the risk NUMBER ==")
{
  const none = riskOf(null)
  const under = riskOf(calFor(8, 2))

  // The reproduction, as it read before v121.
  ok("the uncalibrated plan is still assessed exactly as before (0.278 / low)",
    none.risk === 0.278 && none.riskLadder === "low", `${none.risk} ${none.riskLadder}`)

  ok("8 settled predictions at +2 ladder steps now raise the risk",
    under.risk > none.risk, `${under.risk} vs ${none.risk}`)

  // riskLadder is not cosmetic: meta.js only generates and adopts
  // alternatives() at high/critical. This is the decision that was dead.
  ok("and the lift crosses into the band that triggers alternatives()",
    under.riskLadder === "high" || under.riskLadder === "critical", under.riskLadder)

  ok("the uncalibrated estimate stays visible as shapeRisk",
    under.shapeRisk === none.risk, `${under.shapeRisk} vs ${none.risk}`)

  ok("and the lift explains itself from the evidence",
    /under-predicted/.test(under.calibrationPressure.why.join(" ")), JSON.stringify(under.calibrationPressure.why))

  // The whole point, end to end. meta.js:926 is `riskLadder === "high" ||
  // riskLadder === "critical"` — so this is the decision that was dead, run
  // exactly as the controller runs it. Past experience must not merely be
  // stored: it must change what forge does next, for the better.
  const fires = (a) => a.riskLadder === "high" || a.riskLadder === "critical"
  ok("with no history the planner never even considers an alternative plan", !fires(none))
  ok("after eight under-predicted runs it does", fires(under))

  const alts = alternatives(under, DAG)
  ok("and it produces a concrete alternative shape", alts.needed === true && alts.recommended?.name,
    JSON.stringify(alts.recommended))
  // Compared like with like: alternatives() scores every candidate — the
  // original included — on thin priors, so the fair comparison is against
  // `original` inside that same result, on the criterion the module ranks by.
  ok("that beats the original on the module's own criterion",
    alts.bestIsOriginal === false &&
    alts.recommended.expectedVerifiedProgress > alts.original.expectedVerifiedProgress,
    `${alts.recommended.name} ${alts.recommended.expectedVerifiedProgress} vs original ${alts.original.expectedVerifiedProgress}`)
}

// ---------------------------------------------------------------------------
console.log("== 1b. DAMPED — nothing is claimed below the sample floor ==")
{
  ok("plannerisk's floor is prediction.js's floor, not a second opinion",
    CALIBRATION_MIN_SAMPLES === MIN_CALIBRATION_SAMPLES, `${CALIBRATION_MIN_SAMPLES} vs ${MIN_CALIBRATION_SAMPLES}`)

  // 4 settled predictions is below MIN_CALIBRATION_SAMPLES, so calibration
  // reports insufficient and NOTHING may move.
  const thin = calFor(4, 2)
  ok("4 samples of the same +2 bias produce no calibration at all", thin.sufficient !== true)
  ok("and therefore no movement in the number", riskOf(thin).risk === riskOf(null).risk)

  // Exactly at the floor the evidence counts.
  const atFloor = calFor(5, 2)
  ok("5 samples do count", atFloor.sufficient === true && riskOf(atFloor).risk > riskOf(null).risk)
}

// ---------------------------------------------------------------------------
console.log("== 1c. RAISE-ONLY — being wrong safely is not evidence for optimism ==")
{
  const none = riskOf(null)

  // Risk ended BELOW what was predicted, eight times running.
  const over = calFor(8, -2)
  ok("the over-prediction is measured", over.riskBias === -2, String(over.riskBias))
  ok("and it never lowers the estimate below the uncalibrated value",
    riskOf(over).risk >= none.risk, `${riskOf(over).risk} vs ${none.risk}`)

  // Perfectly calibrated history must not drift the number either way.
  const exact = calFor(8, 0)
  ok("a perfectly calibrated history leaves the number identical",
    riskOf(exact).risk === none.risk, `${riskOf(exact).risk} vs ${none.risk}`)

  ok("pressure is never negative", (() => {
    for (const c of [over, exact, calFor(8, 2), null, { sufficient: false }]) {
      const p = calibrationPressure(c)
      if (p.risk < 0 || p.complexity < 0 || p.uncertainty < 0) return false
    }
    return true
  })())
}

// ---------------------------------------------------------------------------
console.log("== 1d. BOUNDED — calibration adjusts the shape model, never replaces it ==")
{
  const huge = calibrationPressure({
    sufficient: true, riskSamples: 40, riskBias: 4, riskEscalations: 40,
    scopeDriftRate: 1, stepBias: 20, testBias: 20,
    outcomeSamples: 40, outcomeAccuracy: 0,
  })
  ok("risk pressure caps well below a full ladder", huge.risk <= 0.3, String(huge.risk))
  ok("complexity pressure is capped", huge.complexity <= 0.12, String(huge.complexity))
  ok("uncertainty pressure is capped", huge.uncertainty <= 0.12, String(huge.uncertainty))

  // Even absurd evidence cannot push an unremarkable plan to critical.
  const r = assessPlan(DAG, { klass: "MEDIUM", calibration: {
    sufficient: true, riskSamples: 40, riskBias: 4, riskEscalations: 40,
    scopeDriftRate: 1, stepBias: 20, testBias: 20, avgDrift: 1,
    outcomeSamples: 40, outcomeAccuracy: 0, filePrecision: 0.1,
  } })
  ok("a two-node plan cannot be driven to critical by calibration alone",
    r.riskLadder !== "critical", `${r.risk} ${r.riskLadder}`)
}

// ---------------------------------------------------------------------------
console.log("== 1e. the other signals reach their own numbers ==")
{
  // outcomeAccuracy measured how often the outcome CALL was right, and reached
  // nothing at all before v121.
  const base = assessPlan(DAG, { klass: "MEDIUM", calibration: { sufficient: true, avgDrift: 0.2, outcomeSamples: 8, outcomeAccuracy: 1 } })
  const wrong = assessPlan(DAG, { klass: "MEDIUM", calibration: { sufficient: true, avgDrift: 0.2, outcomeSamples: 8, outcomeAccuracy: 0.1 } })
  ok("a planner that keeps calling outcomes wrong reports wider uncertainty",
    wrong.uncertainty > base.uncertainty, `${wrong.uncertainty} vs ${base.uncertainty}`)

  // scopeDriftRate set the scope_drift failure probability that was the
  // constant 0.3 no matter what had actually been measured.
  const drifty = [{ id: "n1", objective: "edit", risk: "low", read_only: false, targetFiles: [], dependencies: ["n0"] }]
  const withDrift = predictNodes(drifty, { klass: "MEDIUM", calibration: { sufficient: true, avgDrift: 0.2, scopeDriftRate: 0.62 } })
  const modes = withDrift.get("n1").failureModes.filter((m) => m.mode === "scope_drift")
  ok("the scope_drift probability comes from the measured rate",
    modes.length === 1 && modes[0].probability === 0.62, JSON.stringify(modes))
  const noDrift = predictNodes(drifty, { klass: "MEDIUM", calibration: null })
  ok("and falls back to the shape prior with no evidence",
    noDrift.get("n1").failureModes.find((m) => m.mode === "scope_drift").probability === 0.3)
  // Raise-only here too: a low measured rate must not talk the planner out of
  // a caution it has not earned.
  const lowDrift = predictNodes(drifty, { klass: "MEDIUM", calibration: { sufficient: true, avgDrift: 0.2, scopeDriftRate: 0.05 } })
  ok("a low measured rate leaves the prior alone rather than lowering it",
    lowDrift.get("n1").failureModes.find((m) => m.mode === "scope_drift").probability === 0.3)
}

// ---------------------------------------------------------------------------
console.log("== 2. a task class is not a strategy ==")
{
  const cwd = tmp("strat")
  // Exactly what meta.js wrote, segment after segment, before v121.
  for (let i = 0; i < 7; i++) recordProjectStrategy({ cwd, name: "klass:MEDIUM", ok: i < 5, klass: "MEDIUM", langs: ["javascript"], latencyMs: 40000 })
  for (let i = 0; i < 4; i++) recordProjectStrategy({ cwd, name: "klass:LARGE", ok: i < 2, klass: "LARGE", langs: ["javascript"], latencyMs: 90000 })

  ok("the legacy rows are still on disk — nothing is deleted behind the user",
    fs.readFileSync(path.join(HOME, "projects", fs.readdirSync(path.join(HOME, "projects")).find((d) => fs.existsSync(path.join(HOME, "projects", d, "strategy.json"))), "strategy.json"), "utf8").includes("klass:MEDIUM"))

  ok("but they are never surfaced as a choice",
    pickStrategy("add a retry to the http client", { cwd, klass: "MEDIUM", limit: 3 }).length === 0)

  ok("the legacy shape is recognised by pattern, not by a hardcoded list",
    LEGACY_CLASS_ROW.test("klass:MEDIUM") && LEGACY_CLASS_ROW.test("klass:RECOVERY") && !LEGACY_CLASS_ROW.test("smallest-reversible-change"))

  // A real strategy name still ranks — the store is kept, only the key went.
  recordProjectStrategy({ cwd, name: "bisect-then-patch", ok: true, klass: "MEDIUM" })
  recordProjectStrategy({ cwd, name: "bisect-then-patch", ok: true, klass: "MEDIUM" })
  const picked = pickStrategy("bisect-then-patch the regression", { cwd, klass: "MEDIUM", limit: 3 })
  ok("a genuinely named strategy is still picked and still justified",
    picked.length === 1 && picked[0].name === "bisect-then-patch", JSON.stringify(picked.map((p) => p.name)))

  const meta = fs.readFileSync(path.join(ROOT, "meta.js"), "utf8")
  ok("and meta.js no longer records a class as a strategy",
    !/recordStrategy\(\{[\s\S]{0,200}?name: `klass:/.test(meta))
}

// ---------------------------------------------------------------------------
console.log("== 3. the learning key identifies what was learned ==")
{
  const fix = intentHypothesesFor("fix it")
  const imp = intentHypothesesFor("improve the parser")

  ok("the ordinal id collides across cue branches, as it always did",
    fix[0].id === imp[0].id && fix[0].goal !== imp[0].goal, `${fix[0].id}: "${fix[0].goal}" vs "${imp[0].goal}"`)
  ok("the stable key does not",
    strategyKey(fix[0].goal) !== strategyKey(imp[0].goal))

  // The cap is not arbitrary: metalearn truncates the stored id at 40, so a
  // longer key would be written truncated and read in full — every lookup of a
  // long goal would miss and the row would read as "never tried" forever.
  ok("the key never exceeds what metalearn actually stores",
    intentHypothesesFor("make forge smarter").concat(fix, imp)
      .every((h) => strategyKey(h.goal).length <= 40))
  ok("and it is a slug, not a sentence", /^[a-z0-9]+(-[a-z0-9]+)*$/.test(strategyKey(fix[0].goal)))

  const cwd = tmp("meta")
  const kFix = strategyKey(fix[0].goal), kImp = strategyKey(imp[0].goal)
  for (let i = 0; i < 5; i++) recordStrategy({ cwd, klass: "MEDIUM", id: kFix, ok: false })
  for (let i = 0; i < 5; i++) recordStrategy({ cwd, klass: "MEDIUM", id: kImp, ok: true })

  const rates = strategyRates(cwd, "MEDIUM")
  ok("two strategies that share an ordinal get separate rows",
    Object.keys(rates).length === 2 && rates[kFix] && rates[kImp], JSON.stringify(Object.keys(rates)))
  ok("written under the key the ranker will look up",
    rates[kFix].rate === 0 && rates[kImp].rate === 1)

  const mk = (h) => ({ id: h.id, key: strategyKey(h.goal), text: h.meaning, reversible: true, cost: 0.35, confidence: h.confidence })
  const fixRank = rankStrategies([mk(fix[0]), mk(fix[1])], { rates })
  ok("a strategy that failed 5/5 loses first place to an untried alternative",
    fixRank[0].key !== kFix && fixRank.find((r) => r.key === kFix).measured.samples === 5,
    JSON.stringify(fixRank.map((r) => [r.key, r.expectedValue])))

  const impRank = rankStrategies([mk(imp[0]), mk(imp[1])], { rates })
  ok("a strategy that succeeded 5/5 is preferred on measured evidence, not confidence",
    impRank[0].key === kImp && impRank[0].measured?.rate === 1,
    JSON.stringify(impRank.map((r) => [r.key, r.expectedValue])))

  // Task-class isolation (§6): a failure on one class must not poison another.
  ok("and a MEDIUM failure does not poison LARGE",
    Object.keys(strategyRates(cwd, "LARGE")).length === 0)

  // Rows written before v121 carry the ordinal id and must still read.
  const legacy = tmp("legacy")
  for (let i = 0; i < 4; i++) recordStrategy({ cwd: legacy, klass: "MEDIUM", id: "IH1", ok: true })
  const byId = rankStrategies([{ id: "IH1", key: "a-key-nothing-has-recorded-yet", text: "x", reversible: true, cost: 0.3 }], { rates: strategyRates(legacy, "MEDIUM") })
  ok("pre-v121 rows keyed by ordinal are still read through the id fallback",
    byId[0].measured?.samples === 4, JSON.stringify(byId[0].measured))

  // cognition must actually attach the key, or none of the above runs live.
  const cog = fs.readFileSync(path.join(ROOT, "cognition.js"), "utf8")
  ok("cognition attaches the stable key to every strategy it builds",
    /key: strategyKey\(h\.goal/.test(cog) && /key: "smallest-reversible-change"/.test(cog))
  ok("and records under it", /recordStrategy\(\{ cwd, klass, id: ranked\[0\]\.key \|\| ranked\[0\]\.id/.test(cog))
}

// ---------------------------------------------------------------------------
console.log("== 4. the loops the audit found ALREADY closed must stay closed ==")
{
  // These are the §44 shapes that did not hold. A regression here would be a
  // dead wire re-opening, which is exactly what the audit exists to catch.
  const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8")
  const wired = [
    ["caplearn outcomes reach capability withholding", "caproute.js", /shouldWithhold|reputation/],
    ["jointroute reaches a real model switch", "agent.js", /joint\.model && joint\.model !== p\.model/],
    ["crew outcomes reach role/model scoring", "core.js", /crewRouter\.record\(/],
    ["model outcomes reach model routing", "agent.js", /pickModelEmpiric\(/],
    ["episodes reach memory retrieval", "engmemory.js", /episodesNs\.createEpisodeStore/],
    ["skill lifecycle reaches skill selection", "skillforge.js", /loadSkillLife\(opts\.cwd\)/],
    ["predictions are settled in the same segment that made them", "meta.js", /settlePrediction\(segPrediction/],
  ]
  for (const [name, file, re] of wired) ok(name, re.test(read(file)))
}

console.log(`\n${PASS} passed, ${FAIL} failed`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch { }
process.exit(FAIL ? 1 : 0)
