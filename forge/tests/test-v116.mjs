#!/usr/bin/env node
/**
 * forge — v116 "measurewise-2": forge can finally measure itself, and the
 * first thing it measured was wasted work.
 *
 *  A. NOTHING IN FORGE MEASURED HOW LONG FORGE TAKES. `grep -rn hrtime` over
 *     the production tree returned nothing. bench.js scores decision quality,
 *     evalbench.js scores whether a task was solved — neither reports a
 *     millisecond. So every claim about speed rested on nobody's measurement.
 *     perfbench.js is the substrate, and its rules are the point: an errored
 *     case is EXCLUDED, and a delta inside a case's own measured noise is
 *     reported as "unchanged", never as an improvement.
 *
 *  B. A PARALLEL TOOL BATCH HAD NO CEILING. The router decided WHICH calls may
 *     run together; nothing decided HOW MANY. `Promise.all` executed whatever
 *     the model emitted, on any machine. resources.workerCeiling() — the
 *     documented "read-only worker ceiling ... the cap the scheduler cannot
 *     exceed" — was already used for sub-agent fan-out and never for this one.
 *
 *  C. EVERY SEMANTIC SEARCH REWROTE ITS OWN INDEX. Measured, not guessed: a
 *     warm semantic_search on this repo spent ~30ms of its ~163ms serializing
 *     3.2MB of chunks back over a file that already held exactly those bytes.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v116-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 260)}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const perf = await import("../perfbench.js")

// ---------------------------------------------------------------------------
console.log("== A. the measurement substrate, and the honesty rules that make it worth having ==")
{
  const cases = [
    { id: "fast", group: "t", label: "cheap sync work", reps: 5, warmup: 1, run: () => { let x = 0; for (let i = 0; i < 1000; i++) x += i; return x } },
    { id: "slow", group: "t", label: "measurably slower work", reps: 3, warmup: 0, run: async () => { await new Promise((r) => setTimeout(r, 12)) } },
    { id: "broken", group: "t", label: "a case that throws", reps: 3, warmup: 0, run: () => { throw new Error("boom") } },
  ]
  const run = await perf.runPerf({ cwd: process.cwd(), cases })

  const fast = run.cases.find((c) => c.id === "fast")
  const slow = run.cases.find((c) => c.id === "slow")
  const broken = run.cases.find((c) => c.id === "broken")

  ok("a measured case reports real wall time", fast.p50 >= 0 && Number.isFinite(fast.p50) && fast.reps === 5, JSON.stringify(fast))
  ok("p95 is never below p50", fast.p95 >= fast.p50 && slow.p95 >= slow.p50)
  ok("a 12ms sleep measures as roughly 12ms — the clock is real", slow.p50 >= 10 && slow.p50 < 60, String(slow.p50))

  // The rule that matters most: a benchmark must never report the speed of
  // failing. A case that threw has no number at all.
  eq("a throwing case reports no timing", broken.p50, undefined)
  ok("a throwing case is reported as ERR with the reason", /boom/.test(broken.err ?? ""), broken.err)
  const s = perf.summarize(run)
  eq("errored cases are counted separately", { measured: s.measured, errored: s.errored }, { measured: 2, errored: 1 })
  ok("the errored case is EXCLUDED from the total, not counted as instant",
    Math.abs(s.totalP50 - (fast.p50 + slow.p50)) < 0.01, `${s.totalP50} vs ${fast.p50 + slow.p50}`)
  ok("and it is named in the report so it cannot pass unnoticed", /broken/.test(perf.formatPerfReport(run)))
}

console.log("== A1b. a cold path is repeated in fresh processes, and an unmeasurable rep is an error ==")
{
  // A cold path is only cold once per process, so the first version of this
  // benchmark measured it ONCE and let a single sample stand. It promptly
  // reported a 145ms "regression" that was really the on-disk index having
  // been invalidated by an unrelated test run — three reps later it was back.
  // Two fixes, both asserted here: a precondition the case does not want to
  // measure is prepared untimed, and a rep that produces no number is an
  // error, never a zero.
  let prepared = 0
  const run = await perf.runPerf({ cwd: process.cwd(), cases: [
    { id: "cold", group: "t", label: "cold-ish", reps: 3, innerMs: true, prepare: () => { prepared++ }, run: () => 7 },
    { id: "unmeasurable", group: "t", label: "reports nothing", reps: 2, innerMs: true, run: () => Number.NaN },
  ] })
  const cold = run.cases.find((c) => c.id === "cold")
  eq("the precondition runs once, not once per rep", prepared, 1)
  ok("a cold case is no longer a single sample", cold.reps === 3 && cold.single === false, JSON.stringify(cold))
  eq("and its own reported timing is what is recorded", cold.p50, 7)
  const bad = run.cases.find((c) => c.id === "unmeasurable")
  ok("a rep that produced no number is an ERROR, never a zero", Boolean(bad.err) && bad.p50 === undefined, JSON.stringify(bad))
}

console.log("== A2. a delta inside the noise is NOT an improvement ==")
{
  // A case that naturally swings 40ms cannot report a 10ms win.
  const noisy = { id: "x", p50: 100, p95: 140, reps: 5, single: false }
  const tight = { id: "x", p50: 100, p95: 101, reps: 200, single: false }
  ok("the band includes the baseline's own p50→p95 spread", perf.noiseBand(noisy) >= 40, String(perf.noiseBand(noisy)))
  ok("a tight case gets a tight band", perf.noiseBand(tight) <= 8.1, String(perf.noiseBand(tight)))
  ok("a single-sample case gets a WIDER band than a repeated one",
    perf.noiseBand({ ...tight, single: true }) > perf.noiseBand(tight))

  const base = { ts: 1, machine: { cores: 4 }, cases: [noisy, { id: "y", p50: 50, p95: 51, reps: 50, single: false }] }
  const better = { machine: { cores: 4 }, cases: [{ id: "x", p50: 90, p95: 130, reps: 5 }, { id: "y", p50: 20, p95: 21, reps: 50 }] }
  const cmp = perf.comparePerf(base, better)
  eq("10ms off a case that swings 40ms → unchanged", cmp.rows.find((r) => r.id === "x").verdict, "unchanged")
  eq("30ms off a case that swings 1ms → faster", cmp.rows.find((r) => r.id === "y").verdict, "faster")
  ok("nothing is reported as regressed when nothing got slower", cmp.regressed === false)

  const worse = { machine: { cores: 4 }, cases: [{ id: "x", p50: 300, p95: 320, reps: 5 }, { id: "y", p50: 50, p95: 51, reps: 50 }] }
  const cmp2 = perf.comparePerf(base, worse)
  eq("a real regression is named", cmp2.rows.find((r) => r.id === "x").verdict, "slower")
  ok("and the run as a whole is marked regressed", cmp2.regressed === true)
  ok("the report states the rule in words, not only in the verdicts",
    /never as an improvement/.test(perf.formatComparison(cmp2)))
}

console.log("== A3. a comparison that cannot be trusted says so ==")
{
  const base = { ts: 1, machine: { cores: 8, tier: "high" }, cases: [{ id: "a", p50: 10, p95: 11, reps: 5 }, { id: "gone", p50: 5, p95: 5, reps: 5 }] }
  const cur = { machine: { cores: 2, tier: "low" }, cases: [{ id: "a", p50: 10, p95: 11, reps: 5 }, { id: "new", p50: 1, p95: 1, reps: 5 }] }
  const cmp = perf.comparePerf(base, cur)
  eq("a case the baseline never had is 'new', not an improvement", cmp.rows.find((r) => r.id === "new").verdict, "new")
  eq("a case the baseline had but this run skipped is reported missing", cmp.missing, ["gone"])
  ok("a baseline from a different machine is flagged as not comparable",
    cmp.sameMachine === false && /DIFFERENT machine/.test(perf.formatComparison(cmp)))

  const errCmp = perf.comparePerf(
    { ts: 1, machine: {}, cases: [{ id: "a", p50: 10, p95: 11, reps: 5 }] },
    { machine: {}, cases: [{ id: "a", err: "exploded", reps: 0 }] })
  eq("a case that errored THIS run is not comparable — never 'faster'", errCmp.rows[0].verdict, "n/a")
}

console.log("== A4. the baseline round-trips ==")
{
  const run = await perf.runPerf({ cwd: process.cwd(), cases: [{ id: "k", group: "t", label: "k", reps: 2, run: () => 1 }] })
  const at = perf.savePerfBaseline(process.cwd(), run)
  ok("a baseline is written under the project's own state dir", typeof at === "string" && at.endsWith(perf.PERF_FILE), String(at))
  const back = perf.loadPerfBaseline(process.cwd())
  eq("and reads back with the same cases", back?.cases?.map((c) => c.id), ["k"])
  ok("a missing/garbage baseline returns null instead of throwing", (() => {
    try { fs.writeFileSync(at, "{ not json") } catch { return false }
    return perf.loadPerfBaseline(process.cwd()) === null
  })())
}

// ---------------------------------------------------------------------------
console.log("== B. a parallel tool batch now has a ceiling ==")
{
  const { createToolIntel } = await import("../toolintel.js")
  const mkCalls = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: "read_file", args: { path: `f${i}.js` } }))

  const probe = (config) => {
    let cur = 0, peak = 0
    const events = []
    const exec = async () => {
      cur++; peak = Math.max(peak, cur)
      await new Promise((r) => setTimeout(r, 8))
      cur--
      return "ok"
    }
    const intel = createToolIntel({ exec, ctx: { cwd: process.cwd() }, config, legacyEvents: false, onEvent: (e) => events.push(e) })
    return { intel, peak: () => peak, events }
  }

  {
    const p = probe({ tools: { maxParallel: 3 } })
    const out = await p.intel.runBatch(mkCalls(12), { step: 1 })
    ok("12 parallel-safe calls never exceed the ceiling of 3", p.peak() <= 3, `peak=${p.peak()}`)
    eq("every call still ran", out.length, 12)
    ok("results stay aligned with the ORIGINAL order — the conversation shape never changes",
      out.every((r, i) => r?.record?.tool_call_id === `c${i}`), JSON.stringify(out.map((r) => r?.record?.tool_call_id)))
    const thr = p.events.find((e) => e.type === "TOOL_THROTTLED")
    ok("the clamp is announced, not silent", Boolean(thr) && thr.requested === 12 && thr.limit === 3, JSON.stringify(thr))
  }

  {
    // The other half of the contract: a batch that FITS must not be slowed
    // down. A ceiling that serializes work it did not need to is a regression
    // dressed as a safety feature.
    const p = probe({ tools: { maxParallel: 8 } })
    const t0 = Date.now()
    await p.intel.runBatch(mkCalls(5), { step: 1 })
    const ms = Date.now() - t0
    eq("a batch under the ceiling runs fully parallel", p.peak(), 5)
    ok("and pays one call's latency, not five", ms < 40, `${ms}ms`)
    ok("no throttle event when nothing was throttled", !p.events.some((e) => e.type === "TOOL_THROTTLED"))
  }

  {
    const p = probe({ tools: { maxParallel: 1 } })
    const out = await p.intel.runBatch(mkCalls(4), { step: 1 })
    eq("maxParallel:1 means strictly one at a time", p.peak(), 1)
    eq("and still returns every result", out.length, 4)
  }

  {
    const p = probe({ tools: { maxParallel: 0 } })
    await p.intel.runBatch(mkCalls(4), { step: 1 })
    ok("a nonsense ceiling of 0 falls back to the machine's own, never to zero workers", p.peak() >= 1, `peak=${p.peak()}`)
  }

  {
    // Regression guard: the ceiling must not change WHICH calls are parallel.
    // A mutation in the batch is still serialized after the reads.
    let order = []
    const exec = async (name) => { order.push(name); await new Promise((r) => setTimeout(r, 2)); return "ok" }
    const intel = createToolIntel({ exec, ctx: { cwd: process.cwd() }, config: { tools: { maxParallel: 2 } }, legacyEvents: false })
    const out = await intel.runBatch([
      { id: "r1", name: "read_file", args: { path: "a.js" } },
      { id: "w1", name: "write_file", args: { path: "b.js", content: "x" } },
      { id: "r2", name: "read_file", args: { path: "c.js" } },
    ], { step: 1 })
    eq("mixed batch still returns one result per call", out.length, 3)
    ok("the write did not run inside the parallel wave", order.indexOf("write_file") >= order.lastIndexOf("read_file") - 1, order.join(","))
  }
}

// ---------------------------------------------------------------------------
console.log("== C. a search that changed nothing no longer rewrites its index ==")
{
  const cs = await import("../codesearch.js")
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v116-proj-"))
  // enough real content that the corpus clears MIN_PERSIST_DOCS
  for (let i = 0; i < 40; i++) {
    fs.writeFileSync(path.join(work, `mod${i}.js`), Array.from({ length: 40 }, (_, l) =>
      `export function handler${i}_${l}(input) { // completion gate ${i} ${l}\n  return verify(input) && commit(input)\n}`).join("\n"))
  }
  const q = "where is the completion gate decided"
  const stats = () => cs.semanticIndexStats()

  const first = await cs.semanticSearch(work, q, { limit: 5 })
  const afterFirst = { ...stats() }
  ok("the first search builds and persists an index", afterFirst.saved >= 1, JSON.stringify(afterFirst))

  const second = await cs.semanticSearch(work, q, { limit: 5 })
  const afterSecond = { ...stats() }
  eq("the second identical search does NOT rewrite it", afterSecond.saved, afterFirst.saved)
  ok("and says so, rather than silently doing nothing", afterSecond.skippedSaves > afterFirst.skippedSaves,
    `${afterFirst.skippedSaves} → ${afterSecond.skippedSaves}`)
  // The whole justification: the answer must be identical. A faster search
  // that returns something else is not a faster search.
  eq("the hits are byte-identical to the search that did write",
    second.hits.map((h) => [h.path, h.start, h.score]), first.hits.map((h) => [h.path, h.start, h.score]))
  eq("as is the corpus it searched", [second.files, second.chunks], [first.files, first.chunks])

  // ...and the skip is never taken when the project actually moved.
  await new Promise((r) => setTimeout(r, 12))
  fs.writeFileSync(path.join(work, "mod0.js"), "export function movedOn() { return 'the completion gate changed' }\n")
  const afterEdit = await cs.semanticSearch(work, q, { limit: 5 })
  ok("an edited file re-chunks and the index IS rewritten", stats().saved > afterSecond.saved,
    `${afterSecond.saved} → ${stats().saved}`)
  ok("the edited content is actually searchable — freshness beats the cache",
    afterEdit.chunks > 0 && stats().rechunked > afterSecond.rechunked)

  const savedBeforeDelete = stats().saved
  fs.rmSync(path.join(work, "mod1.js"))
  await cs.semanticSearch(work, q, { limit: 5 })
  ok("a deleted file leaves a stale entry, so the index is rewritten to prune it",
    stats().saved > savedBeforeDelete, `${savedBeforeDelete} → ${stats().saved}`)

  fs.rmSync(work, { recursive: true, force: true })
}

console.log(`\n== v116 measurewise-2 suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
