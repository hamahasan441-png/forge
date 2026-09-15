#!/usr/bin/env node
/**
 * forge — v101 P0 "the instrument": phase tracing.
 *
 * telemetry.js counts WHAT happened; nothing measured WHERE THE TIME WENT, so
 * "this task took four minutes" could never be split into model wait vs tool
 * execution vs everything else, and an optimization could never be attributed
 * to the phase it claimed to improve.
 *
 * The property that matters most here is HONESTY: a tracer that reports only
 * the spans you remembered to add makes a partial picture look complete. Every
 * assertion below that touches `unaccountedMs` is really testing that.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v101-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v101-work-"))
process.chdir(WORK)

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const { createTracer, nullTracer, PHASE } = await import("../tracer.js")

/** A controllable clock: timing assertions must not depend on real elapsed time. */
function fakeClock(start = 1000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms }, set: (v) => { t = v } }
}

// ---------------------------------------------------------------------------
console.log("== 1. spans measure, and never double-count ==")
{
  const c = fakeClock()
  const tr = createTracer({ clock: c.now })
  const end = tr.span(PHASE.MODEL)
  c.advance(250)
  eq("a span returns its own duration", end(), 250)
  eq("ending twice is ignored (try/finally safe)", end(), 0)
  const snap = tr.snapshot()
  eq("one call recorded", snap.phases[0].calls, 1)
  eq("with the right total", snap.phases[0].ms, 250)
  eq("and the right max", snap.phases[0].maxMs, 250)

  const end2 = tr.span(PHASE.MODEL)
  c.advance(50)
  end2()
  const s2 = tr.snapshot()
  eq("a second call accumulates", s2.phases[0].ms, 300)
  eq("calls counted", s2.phases[0].calls, 2)
  eq("max keeps the WORST, not the last", s2.phases[0].maxMs, 250)
}

console.log("== 2. unaccounted time is reported, never hidden ==")
{
  const c = fakeClock()
  const tr = createTracer({ clock: c.now })
  const end = tr.span(PHASE.MODEL)
  c.advance(100)
  end()
  c.advance(400) // 400ms nobody claimed
  const snap = tr.snapshot()
  eq("wall-clock is the full elapsed time", snap.wallMs, 500)
  eq("only the span is accounted", snap.accountedMs, 100)
  eq("the rest is reported as untraced", snap.unaccountedMs, 400)
  ok("and it shows in the report", /untraced/.test(tr.format(snap)), tr.format(snap))
  ok("an empty tracer says so plainly", /no phases traced/.test(createTracer({ clock: c.now }).format()))
}

console.log("== 3. a breakdown row does not double-count its parent ==")
{
  // "tool:bash" is time INSIDE the "tool" span. Counting both would inflate
  // accountedMs and shrink unaccountedMs — silently destroying the one number
  // that tells you the instrument is incomplete.
  const c = fakeClock()
  const tr = createTracer({ clock: c.now })
  const end = tr.span(PHASE.TOOL)
  c.advance(100)
  end()
  tr.mark("tool:bash", 60)
  tr.mark("tool:read_file", 40)
  c.advance(100)
  const snap = tr.snapshot()
  eq("accounted counts the PARENT only", snap.accountedMs, 100)
  eq("untraced is therefore still correct", snap.unaccountedMs, 100)
  const details = snap.phases.filter((p) => p.detail).map((p) => p.name)
  eq("breakdown rows are marked as such", details.sort(), ["tool:bash", "tool:read_file"])
  ok("the parent is not marked as a breakdown", snap.phases.find((p) => p.name === "tool").detail === false)
  const txt = tr.format(snap)
  ok("the report nests them under the parent", /↳ bash/.test(txt), txt)
}

console.log("== 4. overlapping spans are reported, not clamped ==")
{
  const c = fakeClock()
  const tr = createTracer({ clock: c.now })
  const a = tr.span("worker-a")
  const b = tr.span("worker-b")
  c.advance(100)
  a(); b()
  const snap = tr.snapshot()
  eq("two 100ms spans over 100ms wall", snap.accountedMs, 200)
  eq("the excess is reported as overlap", snap.overlapMs, 100)
  eq("and untraced is not driven negative", snap.unaccountedMs, 0)
  ok("overlap appears in the report (this is how you SEE parallelism)",
    /overlap/.test(tr.format(snap)), tr.format(snap))
}

console.log("== 5. hostile and sloppy input ==")
{
  const tr = createTracer()
  eq("a negative duration is refused", tr.mark("x", -5), 0)
  eq("NaN is refused", tr.mark("x", NaN), 0)
  eq("a non-numeric duration is refused", tr.mark("x", "abc"), 0)
  eq("zero is a legitimate duration", tr.mark("zero", 0), 0)
  ok("an unnamed span still records", (() => { const e = tr.span(""); e(); return tr.snapshot().phases.some((p) => p.name === "unnamed") })())
  // a runaway name generator must not grow the tracer without bound
  const t2 = createTracer()
  for (let i = 0; i < 500; i++) t2.mark(`phase-${i}`, 1)
  ok("phase count is bounded", t2.snapshot().phases.length <= 200, String(t2.snapshot().phases.length))
  ok("a very long name is truncated, not rejected", (() => { const t3 = createTracer(); t3.mark("z".repeat(500), 1); return t3.snapshot().phases[0].name.length <= 80 })())
}

console.log("== 6. around() closes the span on success AND on throw ==")
{
  const c = fakeClock()
  const tr = createTracer({ clock: c.now })
  const v = await tr.around("ok-path", async () => { c.advance(30); return 42 })
  eq("the value passes through", v, 42)
  let threw = false
  try { await tr.around("bad-path", async () => { c.advance(70); throw new Error("boom") }) } catch { threw = true }
  ok("the error still propagates", threw)
  const snap = tr.snapshot()
  eq("the failing span was still timed", snap.phases.find((p) => p.name === "bad-path").ms, 70)
  eq("and is marked as an error", snap.phases.find((p) => p.name === "bad-path").errors, 1)
  eq("the good span carries no error", snap.phases.find((p) => p.name === "ok-path").errors, 0)
}

console.log("== 7. nullTracer is a real no-op (call sites need no guards) ==")
{
  const n = nullTracer()
  const e = n.span("x")
  eq("span end returns 0", e(), 0)
  eq("mark returns 0", n.mark("x", 100), 0)
  eq("snapshot is empty but well-shaped", n.snapshot().phases, [])
  eq("wall is zero", n.snapshot().wallMs, 0)
  eq("format is empty", n.format(), "")
  eq("around still runs the function", await n.around("x", async () => 7), 7)
  ok("PHASE is exposed so call sites can use the constants", Boolean(n.PHASE?.MODEL))
}

console.log("== 8. the agent loop is actually instrumented ==")
{
  const src = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  ok("agent.js creates a tracer per run", /const tracer = createTracer\(\)/.test(src))
  ok("the model call is spanned", /const endModel = tracer\.span\(PHASE\.MODEL\)/.test(src))
  ok("the span is declared OUTSIDE the try, so failover paths close it too",
    /const endModel = tracer\.span\(PHASE\.MODEL\)\s*\n\s*try \{/.test(src))
  ok("it closes on the error path as an error", /endModel\(\{ error: true \}\)/.test(src))
  ok("the tool batch is spanned", /const endTools = tracer\.span\(PHASE\.TOOL\)/.test(src))
  ok("per-tool time is attributed by NAME", /tracer\.mark\(`tool:\$\{msg\.toolCalls\[i\]\?\.name/.test(src))
  ok("a failing tool is marked as an error", /startsWith\("ERROR"\)/.test(src))
  ok("the run result carries the trace", /trace: tracer\.snapshot\(\)/.test(src))
}

// ---------------------------------------------------------------------------
console.log("== 9. swallowed failures: intent vs accident ==")
{
  const sf = await import("../softfail.js")
  sf.reset()

  // The whole value of this module is this distinction. A best-effort path is
  // WRITTEN to survive ENOENT; a TypeError there is a bug that has been hiding.
  const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" })
  sf.swallowed("memory", "load index", enoent)
  sf.swallowed("memory", "load index", enoent)
  sf.swallowed("runtime", "kill child", Object.assign(new Error("gone"), { code: "ESRCH" }))
  sf.swallowed("worldmodel", "index symbols", new TypeError("Cannot read properties of undefined"))

  const snap = sf.snapshot()
  eq("every swallow is counted", snap.total, 4)
  eq("repeats collapse into one site", snap.distinct, 3)
  eq("exactly the bug-shaped one is suspicious", snap.suspicious, 1)
  eq("and it is listed FIRST", snap.entries[0].where, "worldmodel")
  eq("repeats carry their count", snap.entries.find((e) => e.where === "memory").count, 2)
  ok("an expected code is not suspicious", snap.entries.find((e) => e.kind === "ENOENT").suspicious === false)
  ok("ESRCH (killing a dead child) is not suspicious", snap.entries.find((e) => e.kind === "ESRCH").suspicious === false)

  const rep = sf.format(snap)
  ok("the report marks the suspicious one", /! worldmodel\/index symbols \[TypeError\]/.test(rep), rep)
  ok("and explains what the mark means", /usually mean a real bug was hiding/.test(rep))

  sf.reset()
  eq("reset clears", sf.snapshot().total, 0)
  eq("a quiet run produces NO report at all", sf.format(), "")
}

console.log("== 10. the reporter can never make things worse ==")
{
  const sf = await import("../softfail.js")
  sf.reset()
  ok("a non-Error value is accepted", (() => { sf.swallowed("x", "y", "just a string"); return sf.snapshot().total === 1 })())
  ok("null is accepted", (() => { sf.swallowed("x", "z", null); return sf.snapshot().total === 2 })())
  ok("it returns the error so a call site stays a one-liner", sf.swallowed("x", "w", enoentLike()) instanceof Error)
  ok("a hostile getter cannot take down the reporter", (() => {
    try { sf.swallowed("x", "v", { get code() { throw new Error("hostile") } }); return true } catch { return false }
  })())
  ok("undefined where/what still records", (() => { sf.swallowed(undefined, undefined, new Error("e")); return sf.snapshot().distinct > 0 })())

  // bounded: a runaway loop must not grow the table without limit
  sf.reset()
  for (let i = 0; i < 500; i++) sf.swallowed(`mod${i}`, "op", new Error("e"))
  const s2 = sf.snapshot()
  ok("the table is bounded", s2.distinct <= 300, String(s2.distinct))
  ok("and says how many it could not record", s2.dropped > 0, String(s2.dropped))
  ok("the report admits the truncation", /not recorded - table full/.test(sf.format(s2)))
  sf.reset()

  function enoentLike() { return Object.assign(new Error("nope"), { code: "ENOENT" }) }
}

console.log("== 11. the agent reports what it silently lost ==")
{
  const src = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  // Each of these swallows used to mean the agent ran with LESS CAPABILITY and
  // nobody could tell: no repo overview, no plugins, no MCP tools, no routing.
  for (const [what, re] of [
    ["the repo map", /swallowed\("agent", "build repo map"/],
    ["tool plugins", /swallowed\("agent", "load tool plugins"/],
    ["MCP tools", /swallowed\("agent", "load mcp tools"/],
    ["model routing", /swallowed\("agent", "route model chain"/],
    ["tool stats", /swallowed\("agent", "load tool stats"/],
    ["created tools", /swallowed\("agent", "load created tools"/],
  ]) ok(`losing ${what} is now recorded`, re.test(src))
  ok("the run result carries the swallow report", /softFailures: softfailSnapshot\(\)/.test(src))
  ok("control flow is unchanged — the agent still swallows", /catch \(e\) \{ swallowed\("agent", "build repo map", e\) \}/.test(src))
}

// ---------------------------------------------------------------------------
console.log("== 12. P3: routing learns per task CLASS, not one blended number ==")
{
  const ms = await import("../modelstrategy.js")
  ms.clearPerformance()

  eq("task class is derived from the text", ms.deriveTaskClass("debug the failing login test"), "debugging")
  eq("planning is distinguished", ms.deriveTaskClass("plan the new auth architecture"), "planning")
  eq("review is distinguished", ms.deriveTaskClass("review this diff"), "review")
  eq("refactor is distinguished", ms.deriveTaskClass("rename the helper across files"), "refactor")
  eq("coding is the catch-all for building", ms.deriveTaskClass("add a retry helper"), "coding")
  eq("empty text has no class", ms.deriveTaskClass(""), null)
  eq("unrecognized text has no class (never guessed)", ms.deriveTaskClass("zzz qqq"), null)

  // Two models with IDENTICAL global records but MIRRORED strengths. Global
  // routing cannot tell them apart; that is the evidence being thrown away.
  for (let i = 0; i < 20; i++) {
    ms.recordOutcome({ model: "alpha", provider: "p", ok: i < 15, taskClass: i < 10 ? "debugging" : "planning" })
    ms.recordOutcome({ model: "beta", provider: "p", ok: i < 15, taskClass: i < 10 ? "planning" : "debugging" })
  }
  const gA = ms.effectiveStats("alpha", "p")
  const gB = ms.effectiveStats("beta", "p")
  eq("globally the two models are indistinguishable", gA.successRate, gB.successRate)

  const dA = ms.effectiveStats("alpha", "p", { taskClass: "debugging" })
  const dB = ms.effectiveStats("beta", "p", { taskClass: "debugging" })
  ok("at debugging, the model with that record wins", dA.successRate > dB.successRate, `${dA.successRate} vs ${dB.successRate}`)
  const pA = ms.effectiveStats("alpha", "p", { taskClass: "planning" })
  const pB = ms.effectiveStats("beta", "p", { taskClass: "planning" })
  ok("at planning, the preference REVERSES", pB.successRate > pA.successRate, `${pB.successRate} vs ${pA.successRate}`)
  ok("the separation is large, not noise", Math.abs(dA.successRate - dB.successRate) > 0.2)

  eq("class evidence is reported, not just applied", dA.classSamples, 10)
  eq("and flagged as class-derived", dA.fromClassHistory, true)
  ok("the global rate is still reported alongside", dA.globalSuccessRate === gA.successRate)

  // the safety property: no class evidence must change nothing
  const unknown = ms.effectiveStats("alpha", "p", { taskClass: "nonexistent" })
  eq("an unseen class falls back EXACTLY to global", unknown.successRate, gA.successRate)
  eq("and says it is not class-derived", unknown.fromClassHistory, false)
  const none = ms.effectiveStats("alpha", "p")
  eq("no taskClass at all is unchanged behavior", none.successRate, gA.successRate)
  eq("and carries no class", none.taskClass, null)

  // a single class sample must not swing routing wildly
  ms.clearPerformance()
  for (let i = 0; i < 20; i++) ms.recordOutcome({ model: "gamma", provider: "p", ok: true, taskClass: "coding" })
  ms.recordOutcome({ model: "gamma", provider: "p", ok: false, taskClass: "debugging" })
  const one = ms.effectiveStats("gamma", "p", { taskClass: "debugging" })
  const gGlobal = ms.effectiveStats("gamma", "p")
  ok("one bad run does not collapse the class rate", one.successRate > 0.5, String(one.successRate))
  ok("but it does pull it below the global rate", one.successRate < gGlobal.successRate)
  ms.clearPerformance()
}

console.log("== 13. the router actually consumes the class ==")
{
  const src = fs.readFileSync(new URL("../modelstrategy.js", import.meta.url), "utf8")
  ok("selectModel derives a class when the caller gives none", /const taskClass = opts\.taskClass \?\? deriveTaskClass\(task\)/.test(src))
  ok("the class reaches the scorer", /scoreModel\(\{ model, provider: p, caps, limits, catalogWindow: cat\?\.contextWindow, taskClass \}\)/.test(src))
  ok("the scorer asks for class-aware stats", /effectiveStats\(model, provider\?\.name \?\? null, \{ taskClass \}\)/.test(src))
  ok("the reason names the class, so a choice can be explained", /at \$\{perf\.taskClass\}/.test(src))
  ok("class evidence is shrunk toward the model's OWN global rate", /CLASS_PRIOR_WEIGHT \* globalRate/.test(src))
}

console.log(`\n== v101 instrument suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
