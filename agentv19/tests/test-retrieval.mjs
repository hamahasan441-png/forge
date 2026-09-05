#!/usr/bin/env node
/**
 * forge — BM25 retrieval checks (v20.2 P3-2): relevance ordering, IDF
 * down-weighting of common terms, tf saturation, stability, and edge cases.
 */
import { tokenize, rankDocs } from "../forge/retrieval.js"

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }

console.log("== tokenize ==")
ok("splits identifiers and drops stops", JSON.stringify(tokenize("The retryFetch is in the_fetch layer")) === JSON.stringify(["retryfetch", "the_fetch", "layer"]))
ok("drops short tokens", !tokenize("a bc def").includes("bc"))

console.log("== relevance ordering ==")
{
  const docs = [
    { id: "auth", text: "authentication login session token password" },
    { id: "fetch", text: "http fetch retry backoff timeout network" },
    { id: "ui", text: "render terminal colors banner prompt" },
  ]
  const r = rankDocs("retry the network fetch timeout", docs)
  ok("most relevant doc ranks first", r[0].id === "fetch")
  ok("scores are descending", r[0].score >= r[1].score && r[1].score >= r[2].score)
  ok("irrelevant doc scores zero", r.find((d) => d.id === "ui").score === 0)
}

console.log("== IDF down-weights common terms ==")
{
  // "config" appears in every doc (common); "webhook" is rare — a doc with the
  // rare term should win over one that only repeats the common term.
  const docs = [
    { id: "common", text: "config config config config settings" },
    { id: "rare", text: "config webhook dispatch" },
  ]
  const r = rankDocs("config webhook", docs)
  ok("doc with the rare query term ranks first", r[0].id === "rare")
}

console.log("== tf saturation (BM25) ==")
{
  const docs = [
    { id: "spam", text: ("alpha ").repeat(50) + "beta" },
    { id: "balanced", text: "alpha beta gamma" },
  ]
  const r = rankDocs("alpha beta", docs)
  ok("repeating one term does not dominate a balanced match", r[0].id === "balanced")
}

console.log("== edge cases ==")
ok("empty query returns docs unchanged, score 0", (() => { const r = rankDocs("", [{ id: "x", text: "y" }]); return r.length === 1 && r[0].score === 0 })())
ok("empty docs → empty", rankDocs("q", []).length === 0)
ok("limit respected", rankDocs("a b c", [{ id: 1, text: "a" }, { id: 2, text: "b" }, { id: 3, text: "c" }], { limit: 2 }).length === 2)
ok("stable on ties (equal/zero scores keep input order)", (() => {
  const r = rankDocs("zzz", [{ id: "first", text: "a" }, { id: "second", text: "b" }])
  return r[0].id === "first" && r[1].id === "second"
})())

console.log(`\n== retrieval suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
