#!/usr/bin/env node
/**
 * forge — v126 "shapewise": the plan-shape choice never learned.
 *
 * plannerisk.alternatives() reshapes a high-risk plan into one of a small,
 * stable set — inspect-first, incremental-verify, conservative-order, or the
 * original — and meta.js:940 ADOPTS the winner and executes it. That choice ran
 * on expectedVerifiedProgress: a number the planner predicts about itself.
 * Nothing ever looked back at whether the shape it picked was the one that
 * worked. It matters more after v121, which wired settled-prediction error into
 * riskLadder and so makes alternatives() FIRE more often — a decision that
 * happens more often on evidence it never collects is the wrong kind of busy.
 *
 * MEASURED over a sweep of 32 high/critical plans (node counts 2-12, four node
 * risks, chain/fan/flat shapes, three task classes, with and without declared
 * verification):
 *
 *   adopted WITHOUT history : { inspect-first: 32 }      ← every single plan
 *   adopted WITH    history : { incremental-verify: 8, none: 24 }
 *
 * The estimate is effectively deterministic: it picked the SAME shape 32 times
 * out of 32. Generating three alternatives was mostly theatre, because nothing
 * could ever discover that inspect-first does not work in this project.
 *
 * The names are a fixed vocabulary — unlike the IH1/S1 ordinals v121 had to
 * fix, these repeat run after run, so they are a real learning key.
 *
 * The guard that matters more than the feature: history adjusts the ESTIMATE
 * and nothing else. It can never talk adoptDecision into a riskier or
 * less-likely plan — those refusals are absolute and §4 proves it.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v126-"))
process.env.FORGE_HOME = HOME
const ROOT = path.dirname(new URL("../package.json", import.meta.url).pathname)

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const { assessPlan, alternatives, adoptDecision, shapeAdjustment, SHAPE_WEIGHT, ADOPT_MARGIN } = await import("../plannerisk.js")
const { recordPlanShape, planShapeRates } = await import("../metalearn.js")

/** A plan that lands in the band where alternatives() runs at all. */
const planOf = (n = 6, risk = "low", { ver = false, dep = "chain" } = {}) => {
  const d = []
  for (let i = 1; i <= n; i++) d.push({
    id: `n${i}`, objective: `work ${i}`, risk, read_only: false, targetFiles: [`f${i}.js`],
    dependencies: dep === "chain" ? (i > 1 ? [`n${i - 1}`] : []) : (i > 1 ? ["n1"] : []),
    ...(ver ? { verificationRequirements: ["test"] } : {}),
  })
  return d
}
const HIST = { "inspect-first": { samples: 6, ok: 0, rate: 0 }, "incremental-verify": { samples: 6, ok: 6, rate: 1 } }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "v126w-"))

// ---------------------------------------------------------------------------
console.log("== 1. a fresh project plans EXACTLY as it did before ==")
{
  // The regression that would matter most: no history must mean no drift.
  const DAG = planOf(6, "low")
  const a = assessPlan(DAG, { klass: "LARGE", securitySensitive: true })  // reaches the high band where alternatives() runs
  ok("the fixture really is in the band alternatives() runs in",
    a.riskLadder === "high" || a.riskLadder === "critical", `${a.risk} ${a.riskLadder}`)
  const none = alternatives(a, DAG)
  const empty = alternatives(a, DAG, { shapeRates: {} })
  const nullish = alternatives(a, DAG, { shapeRates: null })

  eq("no rates and empty rates give identical candidates",
    none.all.map((c) => [c.name, c.expectedVerifiedProgress]),
    empty.all.map((c) => [c.name, c.expectedVerifiedProgress]))
  eq("null rates too", none.recommended.name, nullish.recommended.name)
  ok("and no candidate claims a measurement it does not have",
    none.all.every((c) => !c.measured), JSON.stringify(none.all.map((c) => c.measured)))
  ok("the original is unmeasured too", !none.original.measured)
}

// ---------------------------------------------------------------------------
console.log("== 2. DAMPED and BOUNDED — sized against the real gaps ==")
{
  eq("no samples, no adjustment", shapeAdjustment({ samples: 0, ok: 0 }), 0)
  eq("undefined is not a measurement", shapeAdjustment(undefined), 0)

  // add-two damping (crewroute's, reused): one result barely moves anything.
  const one = shapeAdjustment({ samples: 1, ok: 1 })
  ok("a single success moves less than half the adoption margin",
    one > 0 && one < ADOPT_MARGIN / 2, `${one} vs margin ${ADOPT_MARGIN}`)

  // Bounded either way, however extreme the record.
  const perfect = shapeAdjustment({ samples: 500, ok: 500 })
  const awful = shapeAdjustment({ samples: 500, ok: 0 })
  ok("a perfect record is capped", perfect <= SHAPE_WEIGHT / 2 + 1e-9, String(perfect))
  ok("an awful one is capped too", awful >= -(SHAPE_WEIGHT / 2) - 1e-9, String(awful))
  ok("and the widest swing between two shapes cannot overturn a clear estimate",
    (perfect - awful) < 0.082, `swing ${(perfect - awful).toFixed(4)} vs the 0.082 original-gap`)
  ok("but IS decisive on the 0.001 near-tie the estimate cannot resolve",
    (perfect - awful) > 0.001)
}

// ---------------------------------------------------------------------------
console.log("== 3. THE POINT: the same estimate, a different choice ==")
{
  const DAG = planOf(6, "low")
  const a = assessPlan(DAG, { klass: "LARGE", securitySensitive: true })  // reaches the high band where alternatives() runs
  const before = adoptDecision(alternatives(a, DAG))
  const after = adoptDecision(alternatives(a, DAG, { shapeRates: HIST }))

  eq("with no history the planner adopts inspect-first", before.name, "inspect-first")
  ok("after six failures it does not adopt inspect-first again",
    after.name !== "inspect-first", `${after.name}: ${after.why}`)

  // The adjustment stays inspectable — the estimate is not silently overwritten.
  const alt = alternatives(a, DAG, { shapeRates: HIST })
  const insp = alt.all.find((c) => c.name === "inspect-first")
  ok("the untouched estimate is kept beside the adjusted one",
    typeof insp.estimatedVerifiedProgress === "number" && insp.expectedVerifiedProgress < insp.estimatedVerifiedProgress,
    JSON.stringify(insp))
  eq("and the evidence is attached", insp.measured.ok + "/" + insp.measured.samples, "0/6")
}

// ---------------------------------------------------------------------------
console.log("== 4. history NEVER buys a riskier or less-likely plan ==")
{
  // adoptDecision's refusals are absolute. A shape with a perfect record must
  // still lose to them — measurement adjusts the estimate, never the guards.
  const DAG = planOf(2, "low", { ver: true })
  const a = assessPlan(DAG, { klass: "MEDIUM", calibration: { sufficient: true, riskSamples: 8, riskBias: 2, riskEscalations: 8, avgDrift: 0.1, filePrecision: 1 } })
  const loud = { "incremental-verify": { samples: 999, ok: 999, rate: 1 }, "conservative-order": { samples: 999, ok: 999, rate: 1 } }
  const d = adoptDecision(alternatives(a, DAG, { shapeRates: loud }))
  if (d.adopt) {
    const alt = alternatives(a, DAG, { shapeRates: loud })
    const w = alt.all.find((c) => c.name === d.name)
    ok("anything adopted is still not less likely than the original", w.successProbability >= alt.original.successProbability)
    ok("and still not riskier", Number(w.risk) <= Number(alt.original.risk))
  } else {
    ok("a perfect record did not override the success/risk guard", /lower success estimate|riskier|below the adoption threshold/.test(d.why), d.why)
  }

  // The guard text itself must survive — these are the sentences that stop a
  // learned preference becoming a licence.
  const src = fs.readFileSync(path.join(ROOT, "plannerisk.js"), "utf8")
  ok("never adopt a less likely plan", /never adopt a less likely plan/.test(src))
  ok("never adopt a riskier plan", /never adopt a riskier plan/.test(src))
}

// ---------------------------------------------------------------------------
console.log("== 5. the store: per task class, so LARGE cannot poison MICRO ==")
{
  const cwd = tmp()
  for (let i = 0; i < 4; i++) recordPlanShape({ cwd, klass: "LARGE", shape: "inspect-first", ok: false })
  recordPlanShape({ cwd, klass: "LARGE", shape: "incremental-verify", ok: true })

  const large = planShapeRates(cwd, "LARGE")
  eq("failures are recorded", [large["inspect-first"].samples, large["inspect-first"].ok], [4, 0])
  eq("and successes", [large["incremental-verify"].samples, large["incremental-verify"].ok], [1, 1])
  eq("a different class is untouched", planShapeRates(cwd, "MICRO"), {})

  ok("an empty shape name records nothing", recordPlanShape({ cwd, klass: "LARGE", shape: "" }) === null)
  ok("the rate is derived, not trusted from input", large["inspect-first"].rate === 0)

  // …and it reaches the ranking through the same door meta uses.
  const DAG = planOf(6, "low")
  const a = assessPlan(DAG, { klass: "LARGE", securitySensitive: true })  // reaches the high band where alternatives() runs
  const d = adoptDecision(alternatives(a, DAG, { shapeRates: planShapeRates(cwd, "LARGE") }))
  ok("four recorded failures already change the adopted shape",
    d.name !== "inspect-first", `${d.name}: ${d.why}`)
}

// ---------------------------------------------------------------------------
console.log("== 6. the wire, so this cannot become another dead one ==")
{
  const meta = fs.readFileSync(path.join(ROOT, "meta.js"), "utf8")
  ok("meta reads measured shape history for the task class", /planShapeRates\(process\.cwd\(\), classified\.class\)/.test(meta))
  ok("and hands it to alternatives", /alternatives\(planRisk, planDefs, \{ shapeRates \}\)/.test(meta))
  ok("it remembers which shape it adopted", /planShape = decision\.name/.test(meta))
  ok("keeping the original counts as a choice", /if \(!planShape\) planShape = "original"/.test(meta))
  ok("and the run's real outcome scores it", /recordPlanShape\(\{[\s\S]{0,200}?ok: finalStatus === FINAL\.COMPLETED/.test(meta))
  ok("only when a choice was actually made", /if \(planShape\) \{/.test(meta))
}

console.log(`\n${PASS} passed, ${FAIL} failed`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch { }
process.exit(FAIL ? 1 : 0)
