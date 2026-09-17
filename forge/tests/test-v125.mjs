#!/usr/bin/env node
/**
 * forge — v125 "memoryworth": the one retrieval surface that never learned.
 *
 * Every other retrieval surface in forge closes its loop — skills through
 * caplearn, tools through toolintel, strategies through metalearn, models
 * through empirics, variants and lessons through their own recorders.
 * Engineering memory had none, while putting up to 1200 characters into EVERY
 * segment prompt (meta.js). retrieve() ranked on nine terms — BM25, same task,
 * same conversation, file-in-query, evidence, confidence, VERIFIED/FACT,
 * REQUIREMENT, freshness — and every one of them is a PRIOR. A record
 * retrieved into fifty prompts that never once contributed ranked exactly like
 * one that was decisive every time.
 *
 * The reproduction, and the whole point, is §1: a record that WINS on priors
 * and never contributes must end up BELOW one that loses on priors and always
 * does. If the order never changes, nothing was learned.
 *
 * Two invariants matter more than the feature:
 *
 *   TRUTH IS NOT USEFULNESS   a record that never helped is still TRUE. Nothing
 *                             here may set STALE or REJECTED — those keep
 *                             meaning what markStale/markRejected mean.
 *   A FAILED SEGMENT JUDGES   NOTHING. Blaming memory for a run that fell over
 *                             for its own reasons would demote correct records
 *                             that never got the chance to be cited.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v125-"))
process.env.FORGE_HOME = HOME
const ROOT = path.dirname(new URL("../package.json", import.meta.url).pathname)

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const { createEngMemory, MEM_LAYER, MEM_STATUS } = await import("../engmemory.js")

const fresh = () => createEngMemory({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), "v125w-")) })
const obs = (m, text, files, confidence = 0.5) => m.recordMemory({
  text, layer: MEM_LAYER.OBSERVATION, status: MEM_STATUS.OBSERVATION,
  source: "model", confidence, files,
})
const recOf = (m, id) => m._introspect().records.find((r) => r.id === id)
/** run N segments that all SUCCEED and change `changed` */
const segments = (m, ids, n, { ok: okFlag = true, changed = ["/repo/client.js"] } = {}) => {
  for (let i = 0; i < n; i++) { m.noteRetrieved(ids); m.settleRetrieval({ ok: okFlag, changedFiles: changed }) }
}

// ---------------------------------------------------------------------------
console.log("== 1. THE POINT: outcomes beat priors, or nothing was learned ==")
{
  const m = fresh()
  // The dud is BUILT to win on priors: higher confidence, same lexical match.
  // The proven one cites the file the work actually touches.
  const proven = obs(m, "retry backoff doubles per attempt", ["client.js"], 0.5)
  const dud = obs(m, "retry backoff was raised in planning", ["notes.md"], 0.95)
  const Q = "retry backoff"
  const at = (id) => m.retrieve({ query: Q, limit: 5 }).findIndex((r) => r.rec?.id === id)

  ok("before any outcome the useless record ranks FIRST, on confidence alone",
    at(dud.id) === 0 && at(proven.id) === 1, `proven@${at(proven.id)} dud@${at(dud.id)}`)

  segments(m, [proven.id, dud.id], 5)

  ok("after five settled retrievals the proven record ranks first",
    at(proven.id) === 0 && at(dud.id) === 1, `proven@${at(proven.id)} dud@${at(dud.id)}`)
  ok("…because it was measured, not because a prior changed",
    recOf(m, proven.id).helped === 5 && recOf(m, dud.id).helped === 0)
  ok("the useless one is demoted, not deleted — it is still retrievable",
    at(dud.id) >= 0)
}

// ---------------------------------------------------------------------------
console.log("== 2. DAMPED — an anecdote moves nothing ==")
{
  const m = fresh()
  const r = obs(m, "retry backoff doubles per attempt", ["client.js"])
  segments(m, [r.id], 4)
  eq("four fair chances is still an anecdote", m.worth(recOf(m, r.id)), 0)
  segments(m, [r.id], 1)
  ok("the fifth makes it evidence", m.worth(recOf(m, r.id)) > 0, String(m.worth(recOf(m, r.id))))

  const d = obs(m, "unrelated planning note", ["notes.md"])
  segments(m, [d.id], 4)
  eq("and a never-cited record is not demoted on four either", m.worth(recOf(m, d.id)), 0)
}

// ---------------------------------------------------------------------------
console.log("== 3. A FAILED SEGMENT JUDGES NOTHING ==")
{
  // A run that fell over for its own reasons says nothing about the memory it
  // happened to be carrying — the record never got its chance to be cited.
  const m = fresh()
  const r = obs(m, "retry backoff notes", ["notes.md"])
  segments(m, [r.id], 8, { ok: false })
  const rec = recOf(m, r.id)
  eq("every retrieval is still counted", rec.uses, 8)
  eq("but none of them is a fair chance", rec.chances, 0)
  eq("so eight failures demote nothing", m.worth(rec), 0)

  // …and once segments start succeeding, judgement resumes.
  segments(m, [r.id], 5, { ok: true })
  ok("five SUCCESSFUL segments that never cite it do demote it",
    m.worth(recOf(m, r.id)) < 0, String(m.worth(recOf(m, r.id))))
}

// ---------------------------------------------------------------------------
console.log("== 4. TRUTH IS NOT USEFULNESS ==")
{
  const m = fresh()
  const r = obs(m, "a true fact nobody needed", ["notes.md"])
  segments(m, [r.id], 10)
  const rec = recOf(m, r.id)
  ok("a record that never helped is demoted", m.worth(rec) < 0)
  eq("but its status is untouched", rec.status, MEM_STATUS.OBSERVATION)
  ok("it is not STALE", rec.status !== MEM_STATUS.STALE)
  ok("it is not REJECTED", rec.status !== MEM_STATUS.REJECTED)
  ok("and it still comes back from retrieval",
    m.retrieve({ query: "true fact nobody needed", limit: 5 }).some((x) => x.rec?.id === r.id))

  // The source-level guard: usefulness must never write a status.
  const src = fs.readFileSync(path.join(ROOT, "engmemory.js"), "utf8")
  const body = src.slice(src.indexOf("function settleRetrieval"), src.indexOf("function retrieve("))
  ok("settleRetrieval never assigns a status", !/\.status\s*=/.test(body), body.slice(0, 200))
}

// ---------------------------------------------------------------------------
console.log("== 5. BOUNDED — usefulness adjusts the priors, never replaces them ==")
{
  const m = fresh()
  // A requirement the task asked for, versus a wildly popular observation.
  const req = m.recordMemory({
    text: "the client must retry three times", layer: MEM_LAYER.REQUIREMENT,
    status: MEM_STATUS.OBSERVATION, source: "task", confidence: 0.5, files: ["client.js"],
  })
  const pop = obs(m, "the client must retry three times or so", ["client.js"], 0.5)
  segments(m, [pop.id], 40)
  const order = m.retrieve({ query: "client must retry three times", limit: 5 })
  ok("a popular observation cannot outrank a REQUIREMENT",
    order.findIndex((r) => r.rec?.id === req.id) < order.findIndex((r) => r.rec?.id === pop.id),
    JSON.stringify(order.map((r) => r.rec?.layer)))

  ok("the promotion term is capped", m.worth(recOf(m, pop.id)) <= 0.35, String(m.worth(recOf(m, pop.id))))
  const dead = obs(m, "never useful at all", ["nowhere.md"])
  segments(m, [dead.id], 200)
  ok("and so is the demotion term", m.worth(recOf(m, dead.id)) >= -0.30, String(m.worth(recOf(m, dead.id))))
}

// ---------------------------------------------------------------------------
console.log("== 6. REQUIREMENTS ARE NEVER DEMOTED ==")
{
  // The task ASKED for it. That is not a popularity question.
  const m = fresh()
  const req = m.recordMemory({
    text: "must keep the public API stable", layer: MEM_LAYER.REQUIREMENT,
    status: MEM_STATUS.OBSERVATION, source: "task", confidence: 0.5, files: ["api.js"],
  })
  segments(m, [req.id], 20, { changed: ["/repo/other.js"] })
  const rec = recOf(m, req.id)
  ok("twenty successful segments never cited it", rec.helped === 0 && rec.chances === 20)
  eq("and it is still not demoted", m.worth(rec), 0)
}

// ---------------------------------------------------------------------------
console.log("== 7. only what REACHED a prompt is counted ==")
{
  // A candidate that lost the ranking cost nothing and proves nothing, so it
  // must not accrue a use. retrievalBlock marks what it rendered.
  const m = fresh()
  const ids = []
  for (let i = 0; i < 8; i++) ids.push(obs(m, `retry backoff note number ${i}`, [`f${i}.js`]).id)
  const block = m.retrievalBlock("retry backoff note", { limit: 3 })
  ok("the block rendered something", block.length > 0)
  const used = ids.filter((id) => (recOf(m, id).uses ?? 0) > 0)
  ok("exactly the rendered records were counted", used.length === 3, `${used.length} of 8`)
  ok("the rest were considered and cost nothing", ids.length - used.length === 5)
}

// ---------------------------------------------------------------------------
console.log("== 8. memory never breaks a run ==")
{
  const m = fresh()
  const r = obs(m, "x", ["a.js"])
  m.noteRetrieved([r.id])
  let threw = false
  try {
    m.settleRetrieval({ ok: true, changedFiles: [null, undefined, "", "/repo/a.js"] })
    m.settleRetrieval({})                       // nothing open — must be a no-op
    m.noteRetrieved([])                         // empty
    m.noteRetrieved(["does-not-exist"])
  } catch { threw = true }
  ok("malformed input is survived, not thrown", !threw)
  eq("and a second settle with nothing open changes nothing", m.settleRetrieval({ ok: true }), { settled: 0, helped: 0 })
}

// ---------------------------------------------------------------------------
console.log("== 9. the wire, so this cannot quietly become another dead one ==")
{
  const meta = fs.readFileSync(path.join(ROOT, "meta.js"), "utf8")
  ok("meta settles the retrieval", /engMem\.settleRetrieval\(\{/.test(meta))
  ok("with the real segment outcome", /ok: !res\.error && !res\.budgetHit/.test(meta))
  ok("and the files that were really changed", /changedFiles: \[\.\.\.segChanged\]/.test(meta))
  ok("it reports what it settled", /MEMORY_SETTLED/.test(meta))

  const src = fs.readFileSync(path.join(ROOT, "engmemory.js"), "utf8")
  ok("retrievalBlock marks what it rendered", /noteRetrieved\(results\.map/.test(src))
  ok("the ranking actually reads the measured term", /s \+= worth\(c\.rec\)/.test(src))
  // Eviction: a source guard, not a behavioural one — MAX_RECORDS is 2000 and
  // building that many records per assertion would cost more than it proves.
  ok("eviction prefers a proven record over a never-used peer (source)",
    /proven\(a\) - proven\(b\) \|\| a\.at - b\.at/.test(src))
}

console.log(`\n${PASS} passed, ${FAIL} failed`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch { }
process.exit(FAIL ? 1 : 0)
