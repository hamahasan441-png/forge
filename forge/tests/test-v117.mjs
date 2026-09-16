#!/usr/bin/env node
/**
 * forge — v117 "searchwise": forge knew WHICH tool could search. It did not
 * know WHAT KIND of question it was being asked, and it never found out
 * whether the search had worked.
 *
 * Three things, all inside subsystems that already existed:
 *
 *  A. SEARCH INTENT. router.analyzeTask() classified the TASK ("discover"),
 *     which is the right granularity for picking a capability and the wrong
 *     one for picking a search: "where is parseConfig", "what calls
 *     parseConfig" and "how does config loading work" are all DISCOVER and
 *     want three different tools. classifySearch() classifies the QUERY.
 *
 *  B. CHEAPEST SUFFICIENT, NOT CHEAPEST. Measured with `forge perf`: a warm
 *     semantic_search costs ~128ms, a grep_files ~2.6ms. For an exact
 *     identifier the grep is cheaper AND right. For "how does this work" it
 *     is cheaper and WRONG — so no hint is given there. The asymmetry is the
 *     rule; "always cheaper" is what this project does not do.
 *
 *  C. NOBODY MEASURED WHETHER A SEARCH WORKED. toolstats.json recorded that a
 *     search RAN. A search is useful when something it discovered was then
 *     read or changed — and forge had that signal in its records the whole
 *     time and never used it. Now it does, per intent, and the measurement
 *     outranks the static rule.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v117-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 260)}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const router = await import("../router.js")
const ti = await import("../toolintel.js")
const { SEARCH_INTENT, classifySearch, cheapestFor, cheaperAlternative } = router

// ---------------------------------------------------------------------------
console.log("== A. the query says what kind of question it is ==")
{
  const intent = (q, tool = null) => classifySearch(q, { tool }).intent
  eq("where is X → symbol", intent("where is parseConfig"), SEARCH_INTENT.SYMBOL)
  eq("a bare identifier → symbol", intent("parseConfig"), SEARCH_INTENT.SYMBOL)
  eq("what calls X → reference", intent("what calls parseConfig"), SEARCH_INTENT.REFERENCE)
  eq("who uses X → reference", intent("who uses the retry helper"), SEARCH_INTENT.REFERENCE)
  eq("who imports X → import", intent("who imports ./config.js"), SEARCH_INTENT.IMPORT)
  eq("an exception message → error", intent("TypeError: cannot read properties of undefined"), SEARCH_INTENT.ERROR)
  eq("a setting → config", intent("the retry backoff setting"), SEARCH_INTENT.CONFIG)
  eq("a spec file → test", intent("find the test for the pager"), SEARCH_INTENT.TEST)
  eq("a glob is always a filename question", intent("anything at all", "glob_files"), SEARCH_INTENT.FILENAME)

  // The precedence that matters: question SHAPE beats the nouns in it. "how
  // does config loading work" contains "config" and is not a config lookup.
  eq("how does X work → architecture, despite the word 'config'", intent("how does config loading work"), SEARCH_INTENT.ARCHITECTURE)
  eq("how is X wired → architecture", intent("how is the retry wired"), SEARCH_INTENT.ARCHITECTURE)

  ok("an exact need is marked exact", classifySearch("where is parseConfig").exact === true)
  ok("an architecture question is NOT exact — that is the whole distinction",
    classifySearch("how does the agent loop fit together").exact === false)
  ok("an empty query never throws", classifySearch("").intent === SEARCH_INTENT.TEXT)
  ok("a null query never throws", classifySearch(null).intent === SEARCH_INTENT.TEXT)
}

console.log("== A2. the cascade starts where the question can actually be answered ==")
{
  eq("a symbol starts structural", cheapestFor(SEARCH_INTENT.SYMBOL)[0], "grep_files")
  eq("a filename starts with glob", cheapestFor(SEARCH_INTENT.FILENAME)[0], "glob_files")
  // ...and the two intents semantic search EXISTS for start there. A cascade
  // that always started cheap would be a cascade that answers architecture
  // questions with a regex.
  eq("a semantic question starts semantic", cheapestFor(SEARCH_INTENT.SEMANTIC)[0], "semantic_search")
  eq("an architecture question starts semantic", cheapestFor(SEARCH_INTENT.ARCHITECTURE)[0], "semantic_search")
  ok("an unknown intent still returns a usable order", cheapestFor("nonsense").length > 0)
}

console.log("== B. cheapest SUFFICIENT — the hint appears only when cheaper still answers ==")
{
  const hint = (tool, q, evidence = null) => cheaperAlternative(tool, { query: q, pattern: q }, { searchEvidence: evidence })
  eq("an exact lookup done semantically gets a structural hint", hint("semantic_search", "where is parseConfig")?.tool, "grep_files")
  eq("so does a reference lookup", hint("semantic_search", "what calls parseConfig")?.tool, "grep_files")
  ok("an ARCHITECTURE question gets NO hint — grep would be cheaper and wrong",
    hint("semantic_search", "how does the agent loop fit together") === null)
  ok("a SEMANTIC question gets no hint either",
    hint("semantic_search", "explain the way retries interact with the budget") === null)
  ok("the hint never swaps the tool, it only advises — the result is a suggestion object",
    typeof hint("semantic_search", "where is parseConfig")?.why === "string")
  ok("grep_files with no evidence is never second-guessed (it is already the cheap one)",
    hint("grep_files", "where is parseConfig") === null)
}

console.log("== C. a search is useful when the run ACTED on what it found ==")
{
  const { searchWasUseful } = ti
  const found = { tool: "grep_files", discovered: ["src/config.js"], search_intent: "symbol" }
  ok("discovered then read → useful",
    searchWasUseful(found, [{ tool: "read_file", arguments_summary: "src/config.js" }]))
  ok("discovered then edited → useful",
    searchWasUseful(found, [{ tool: "edit_file", files_changed: ["src/config.js"] }]))
  ok("discovered and ignored → NOT useful (200 hits nobody opened taught nothing)",
    !searchWasUseful(found, [{ tool: "read_file", arguments_summary: "src/other.js" }]))
  ok("found nothing → not useful",
    !searchWasUseful({ tool: "grep_files", discovered: [] }, [{ tool: "read_file", arguments_summary: "src/config.js" }]))
  // Only what happened AFTER counts: a file already open does not retroactively
  // credit a later search for finding it.
  ok("a file that was already open does not credit a later search",
    !searchWasUseful(found, []))
  ok("path shapes match across relative forms",
    searchWasUseful({ discovered: ["config.js"] }, [{ tool: "read_file", arguments_summary: "src/config.js" }]))
}

console.log("== C2. the evidence is per-intent, damped, and survives a reload ==")
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v117-proj-"))
  // a search cannot credit itself: usefulness is a LATER record touching what
  // it found, so the fixture has to interleave the search with the action
  const rec = (n, intent, tool, useful) => Array.from({ length: n }, (_, i) => [
    { tool, status: "ok", duration_ms: 4, search_intent: intent, discovered: [`hit${i}.js`], files_changed: [] },
    ...(useful ? [{ tool: "read_file", status: "ok", arguments_summary: `hit${i}.js`, files_changed: [] }] : []),
  ]).flat()

  eq("nothing known yet", ti.searchStrategyFor("symbol", { cwd: work }).samples, 0)

  ti.recordToolRun({ cwd: work, klass: "MEDIUM", records: rec(2, "symbol", "grep_files", false) })
  eq("two observations are an anecdote, not a verdict", ti.searchStrategyFor("symbol", { cwd: work }).avoid, [])

  ti.recordToolRun({ cwd: work, klass: "MEDIUM", records: rec(3, "symbol", "grep_files", false) })
  const v = ti.searchStrategyFor("symbol", { cwd: work })
  eq("past the floor, a tool that never reached the answer is avoided", v.avoid, ["grep_files"])
  eq("and the sample count is real", v.samples, 5)

  ti.recordToolRun({ cwd: work, klass: "MEDIUM", records: rec(4, "symbol", "semantic_search", true) })
  const v2 = ti.searchStrategyFor("symbol", { cwd: work })
  eq("a tool that did reach the answer is preferred", v2.prefer.map((p) => p.tool), ["semantic_search"])

  // one intent's evidence must never leak into another's
  eq("a different intent is still unknown", ti.searchStrategyFor("reference", { cwd: work }).samples, 0)

  // the store has to survive the normalizer that used to drop it
  const raw = JSON.parse(fs.readFileSync(path.join(ti.toolStatsPath ? path.dirname(ti.toolStatsPath(work)) : work, "toolstats.json"), "utf8"))
  ok("it is persisted under the ONE existing tool-stats file, not a second store",
    Boolean(raw.search?.symbol?.grep_files) && Boolean(raw.tools), Object.keys(raw).join(","))
  ok("formatted for a human when there is something to say",
    /symbol/.test(ti.formatSearchStrategy(work)), ti.formatSearchStrategy(work))
  eq("and silent when there is not", ti.formatSearchStrategy(fs.mkdtempSync(path.join(os.tmpdir(), "forge-v117-empty-"))), "")
  fs.rmSync(work, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
console.log("== D. the acceptance test: measured evidence CHANGES the next run ==")
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v117-live-"))
  const mk = () => {
    const hints = []
    const exec = async (name) => name === "semantic_search"
      ? 'SEMANTIC SEARCH "where is parseConfig" — 1 hit(s)\nconfig.js:12: export function parseConfig'
      : "ok"
    const intel = ti.createToolIntel({
      exec, ctx: { cwd }, config: {}, klass: "MEDIUM", legacyEvents: false,
      onEvent: (e) => { if (e.type === "TOOL_FALLBACK") hints.push({ to: e.alternative, why: e.reason }) },
    })
    return { intel, hints }
  }
  const call = { id: "c1", name: "semantic_search", args: { query: "where is parseConfig" } }

  const run1 = mk()
  const out1 = await run1.intel.runBatch([call], { step: 1 })
  eq("run 1, no evidence: the static rule advises the structural tool", run1.hints.map((h) => h.to), ["grep_files"])
  ok("and the advice reaches the model in the tool result, not only an event",
    /cheaper next time: grep_files/.test(String(out1[0]?.result ?? "")), String(out1[0]?.result ?? "").slice(-120))

  // Teach this project that grep does NOT reach the answer for symbol lookups
  // here — four searches whose hits nobody ever opened.
  ti.recordToolRun({
    cwd, klass: "MEDIUM",
    records: Array.from({ length: 4 }, (_, i) => ({
      tool: "grep_files", status: "ok", duration_ms: 3, search_intent: "symbol",
      discovered: [`never-opened-${i}.js`], files_changed: [],
    })),
  })
  eq("the project now says so", ti.searchStrategyFor("symbol", { cwd }).avoid, ["grep_files"])

  const run2 = mk()
  await run2.intel.runBatch([call], { step: 1 })
  // Identical query, identical code, different behaviour — which is the only
  // definition of learning this project accepts.
  eq("run 2: the advice is withheld, because it was measured not to work here", run2.hints.map((h) => h.to), [])

  // ...and the reverse direction: once a tool is measured to work, it is named.
  ti.recordToolRun({
    cwd, klass: "MEDIUM",
    records: Array.from({ length: 4 }, (_, i) => [
      { tool: "code_context", status: "ok", duration_ms: 9, search_intent: "symbol", discovered: [`found${i}.js`], files_changed: [] },
      { tool: "edit_file", status: "ok", files_changed: [`found${i}.js`] },
    ]).flat(),
  })
  const run3 = mk()
  await run3.intel.runBatch([{ id: "c2", name: "grep_files", args: { pattern: "where is parseConfig" } }], { step: 1 })
  eq("run 3: a grep is now redirected to the tool that measurably worked", run3.hints.map((h) => h.to), ["code_context"])
  ok("and the reason cites the measurement, not a rule",
    /measured in this project/.test(run3.hints[0]?.why ?? ""), run3.hints[0]?.why)
  fs.rmSync(cwd, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
console.log("== E. adversarial: the fast path must lose when it would be wrong ==")
{
  const hint = (tool, q, evidence = null) => cheaperAlternative(tool, { query: q, pattern: q }, { searchEvidence: evidence })

  // The tempting-but-wrong fast path: an architecture question is the single
  // most expensive kind of search and forge must not talk itself out of it.
  ok("no cheap hint for an architecture question even with evidence favouring grep",
    hint("semantic_search", "how does the governor decide depth", { architecture: { prefer: [{ tool: "grep_files", rate: 1, samples: 9 }], avoid: [] } }) === null)

  // Evidence that names the SAME tool must never advise calling it again.
  const selfEv = { symbol: { prefer: [{ tool: "semantic_search", rate: 0.9, samples: 8 }], avoid: ["semantic_search"] } }
  const h = hint("semantic_search", "where is parseConfig", selfEv)
  ok("a tool is never advised to replace itself", !h || h.tool !== "semantic_search", JSON.stringify(h))

  // Evidence with an `avoid` but no `prefer` must not invent a destination.
  const noDest = hint("grep_files", "where is parseConfig", { symbol: { prefer: [], avoid: ["grep_files"] } })
  ok("an avoid with nowhere better to go stays silent rather than guessing", noDest === null, JSON.stringify(noDest))

  // Malformed / partial evidence must degrade to the static rule, never throw.
  ok("garbage evidence degrades to the rule", hint("semantic_search", "where is parseConfig", { symbol: null })?.tool === "grep_files")
  ok("evidence for an unrelated intent is ignored", hint("semantic_search", "where is parseConfig", { error: { avoid: ["grep_files"] } })?.tool === "grep_files")
}

console.log("== F. nothing that already worked was changed ==")
{
  // The pre-v117 rules in cheaperAlternative are load-bearing and untouched.
  const big = cheaperAlternative("bash", { command: "grep -rn foo ." }, {})
  eq("bash grep still points at grep_files", big?.tool, "grep_files")
  eq("bash cat still points at read_file", cheaperAlternative("bash", { command: "cat x.js" }, {})?.tool, "read_file")
  eq("a one-line delegate is still called out", cheaperAlternative("delegate", { task: "where is the retry helper" }, {})?.tool, "grep_files")
  ok("a plain read_file is still left alone", cheaperAlternative("read_file", { path: "package.json" }, { ctx: { cwd: process.cwd() } }) === null)

  // And the task-level analysis this builds beside is unchanged.
  const a = router.analyzeTask("fix the off-by-one in src/pager.js")
  eq("analyzeTask still classifies the TASK", a.primary, router.INTENT.MODIFY)
}

console.log(`\n== v117 searchwise suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
