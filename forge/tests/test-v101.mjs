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

console.log(`\n== v101 instrument suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
