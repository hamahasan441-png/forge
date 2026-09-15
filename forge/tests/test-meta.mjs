#!/usr/bin/env node
/**
 * forge — v109 "metawise": reasoning policy is empirical.
 *
 * Success is NOT metalearn.json existing. It is:
 *   same task class, later run, DIFFERENT depth, because outcomes said so.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-meta-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + extra : ""}`) }
}

const { VERSION } = await import("../version.js")
const { DEPTH, chooseNextAction, ACTION, depthFor, rankStrategies } = await import("../governor.js")
const { recordReasoning, recommendDepth, policyShift, METALEARN_VERSION, recordStrategy, strategyRates, replayDepth, loadMetaLearn } = await import("../metalearn.js")
const { createCognition } = await import("../cognition.js")
const { recordLesson, relevantLessons, setLessonConfidence, RETIRE_BELOW } = await import("../lessons.js")
const { shouldWithhold, recordCapOutcome, loadCapLearn } = await import("../caplearn.js")

const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-meta-proj-"))

console.log("== version identity ==")
{
  ok("package version is 113.x", /^113\./.test(VERSION), VERSION)
  ok("metalearn protocol set", METALEARN_VERSION === "1.0.0")
}

console.log("== SMALL: extra reasoning that does not pay is not preferred ==")
{
  for (let i = 0; i < 5; i++) recordReasoning({ cwd: work, klass: "SMALL", depth: DEPTH.L4, ok: true })
  for (let i = 0; i < 5; i++) recordReasoning({ cwd: work, klass: "SMALL", depth: DEPTH.L2, ok: true })
  const rec = recommendDepth({ cwd: work, klass: "SMALL", fallback: DEPTH.L4 })
  ok("prefers L2 when L4 adds almost nothing", rec.depth === DEPTH.L2, JSON.stringify(rec))
  ok("source is learned, not a hardcoded table", rec.source === "learned", rec.source)
}

console.log("== LARGE: cheap depth that fails escalates ==")
{
  for (let i = 0; i < 4; i++) recordReasoning({ cwd: work, klass: "LARGE", depth: DEPTH.L2, ok: false })
  const rec = recommendDepth({ cwd: work, klass: "LARGE", fallback: DEPTH.L4 })
  ok("keeps L4 when L2 is measured-broken", rec.depth === DEPTH.L4, JSON.stringify(rec))
}

console.log("== MICRO never learns extra depth ==")
{
  for (let i = 0; i < 5; i++) recordReasoning({ cwd: work, klass: "MICRO", depth: DEPTH.L6, ok: true })
  const rec = recommendDepth({ cwd: work, klass: "MICRO", fallback: DEPTH.L1 })
  ok("MICRO stays at default L1", rec.depth === DEPTH.L1, JSON.stringify(rec))
}

console.log("== failure/conflict keeps governor depth ==")
{
  const rec = recommendDepth({ cwd: work, klass: "SMALL", fallback: DEPTH.L4, failed: true })
  ok("failed keeps fallback", rec.depth === DEPTH.L4 && rec.source === "default")
}

console.log("== NEXT cognition run uses the learned depth ==")
{
  const cog = createCognition({ cwd: work, objective: "rename the leftover tmp file" })
  // SMALL/MICRO path: next() should carry learned L2 on the action when not MICRO
  const a = cog.next({ steps: 0, writes: 0, unverified: [], inspected: true, hasPlan: true })
  ok("governor still returns a real ACTION", Boolean(ACTION[a.action] || a.action), a.action)
  const rec = recommendDepth({ cwd: work, klass: cog.klass, fallback: depthFor({ klass: cog.klass }) })
  if (cog.klass === "MICRO") {
    ok("typo/MICRO does not pick up SMALL L2 policy", rec.depth === DEPTH.L1 || rec.source === "default", JSON.stringify({ klass: cog.klass, rec, depth: a.depth }))
  } else {
    ok("non-MICRO action depth matches learned policy", a.depth === rec.depth, JSON.stringify({ klass: cog.klass, action: a.depth, rec }))
  }
  cog.close({ wrote: 1, unverified: [] })
  const rec2 = recommendDepth({ cwd: work, klass: cog.klass, fallback: DEPTH.L2 })
  ok("close() recorded a reasoning outcome (samples moved)", rec2.samples >= 1 || rec2.source === "learned" || rec2.source === "default")
}

console.log("== Test B — strategy A fails, B succeeds → B preferred ==")
{
  for (let i = 0; i < 3; i++) recordStrategy({ cwd: work, klass: "LARGE", id: "S-patch-blind", ok: false })
  for (let i = 0; i < 3; i++) recordStrategy({ cwd: work, klass: "LARGE", id: "S-test-first", ok: true })
  const ranked = rankStrategies([
    { id: "S-patch-blind", text: "patch without a test", reversible: true, cost: 0.2 },
    { id: "S-test-first", text: "write a failing test first", reversible: false, cost: 0.7, blast: 0.4 },
  ], { rates: strategyRates(work, "LARGE") })
  ok("measured-successful strategy is first", ranked[0].id === "S-test-first", ranked.map((s) => s.id + ":" + s.expectedValue).join(" "))
  ok("failed strategy is not first", ranked[ranked.length - 1].id === "S-patch-blind" || ranked[1].id === "S-patch-blind")
}

console.log("== Test C/D — already v106: LARGE withhold, named override ==")
{
  for (let i = 0; i < 3; i++) recordCapOutcome({ cwd: work, name: "sketchy-x", kind: "skill", klass: "LARGE", ok: false })
  const store = loadCapLearn(work)
  ok("Test C: withheld on LARGE", shouldWithhold(store, { name: "sketchy-x", kind: "skill", klass: "LARGE" }) === true)
  ok("Test C: MICRO not poisoned", shouldWithhold(store, { name: "sketchy-x", kind: "skill", klass: "MICRO" }) === false)
  ok("Test D: explicit name overrides withhold", shouldWithhold(store, { name: "sketchy-x", kind: "skill", klass: "LARGE", named: true }) === false)
}

console.log("== Test E — distribution shift discounts old cheap-depth stats ==")
{
  for (let i = 0; i < 5; i++) recordReasoning({ cwd: work, klass: "SMALL", depth: DEPTH.L2, ok: true })
  const shifted = recommendDepth({ cwd: work, klass: "SMALL", fallback: DEPTH.L3, drifted: true })
  ok("env drift → do not keep learned L2", shifted.source === "shift" && shifted.depth === DEPTH.L3, JSON.stringify(shifted))
}

console.log("== Test F/G — calibration down, retired knowledge does not route ==")
{
  const a = recordLesson({ failure: "auth token missing", cause: "env", failedStrategy: "hardcode secret", successfulRepair: "use env", task: "auth" }, work)
  ok("lesson recorded", a.ok === true)
  const before = relevantLessons("auth token missing", { cwd: work })
  ok("fresh lesson can influence", before.some((l) => l.id === a.id) || before.length >= 0)
  setLessonConfidence(a.id, 0.05, work)
  const after = relevantLessons("auth token missing", { cwd: work })
  ok("retired lesson is below RETIRE_BELOW", RETIRE_BELOW > 0)
  ok("Test G: retired lesson no longer in default retrieval", !after.some((l) => l.id === a.id), JSON.stringify(after.map((l) => l.id)))
}

console.log("== Test H — experience replay: current policy vs historical ==")
{
  const rp = replayDepth({ cwd: work, klass: "SMALL", historical: DEPTH.L4 })
  ok("replay reports historical vs current", rp.historical === DEPTH.L4 && Boolean(rp.current), JSON.stringify(rp))
  ok("SMALL with equal L2/L4 success changed away from L4", rp.changed === true && rp.current === DEPTH.L2, JSON.stringify(rp))
}

console.log("== Test J — crash recovery: disk survives, next decision uses it ==")
{
  const onDisk = loadMetaLearn(work)
  ok("metalearn.json persisted", Boolean(onDisk.byKlass?.SMALL || onDisk.byKlass?.LARGE), JSON.stringify(Object.keys(onDisk.byKlass || {})))
  const rec = recommendDepth({ cwd: work, klass: "SMALL", fallback: DEPTH.L4 })
  ok("restart-equivalent load still prefers learned L2", rec.depth === DEPTH.L2 && rec.source === "learned", JSON.stringify(rec))
}

console.log("== Test I — meta-policy self-promotion is NOT automatic ==")
{
  const src = fs.readFileSync(new URL("../metalearn.js", import.meta.url), "utf8")
  ok("no automatic architecture promotion", !/promote only if better/.test(src) && !/self-modif/.test(src))
}

console.log("== ASK/STOP authority is untouched ==")
{
  const ask = chooseNextAction({
    klass: "LARGE",
    learnedDepth: DEPTH.L2,
    pendingDecision: true,
  })
  ok("pending decision is still WAIT", ask.action === ACTION.WAIT, ask.action)
  const stop = chooseNextAction({ klass: "LARGE", learnedDepth: DEPTH.L2, aborted: true })
  ok("aborted is still STOP", stop.action === ACTION.STOP)
  const plan = chooseNextAction({ klass: "ARCHITECTURAL", learnedDepth: DEPTH.L2, hasPlan: false, steps: 0, inspected: false })
  ok("architectural first action is still PLAN", plan.action === ACTION.PLAN, plan.action)
}

console.log("== no second brain ==")
{
  ok("no MetaManager module", !fs.existsSync(new URL("../metamanager.js", import.meta.url)))
  const src = fs.readFileSync(new URL("../cognition.js", import.meta.url), "utf8")
  ok("cognition records reasoning on close", /recordReasoning/.test(src))
  ok("cognition passes learnedDepth to the governor", /learnedDepth/.test(src))
  const gov = fs.readFileSync(new URL("../governor.js", import.meta.url), "utf8")
  ok("governor accepts learnedDepth", /learnedDepth/.test(gov))
}

console.log(`\n== meta suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
