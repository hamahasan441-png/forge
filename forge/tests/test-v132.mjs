#!/usr/bin/env node
/**
 * forge — v132 "mindwise": one judgment table, and memory that returns.
 *
 * Reproduced against the repository, not the docs.
 *
 * 1. Worker self-review was computed, emitted, then the ledger recorded
 *    `passed: true` anyway. The comment in meta.js said the report "must
 *    survive" before being trusted as evidence. It did not.
 *
 * 2. think() recorded on the tool context (v131) and died with the run.
 *    Nothing durable read it.
 *
 * 3. Failed approaches were stored; the planner hoped BM25 similar-episodes
 *    would retrieve them. A differently-worded next objective forgot them.
 *
 * v132 is not a sixth reviewer. Five review systems still run where they
 * belong. judge.js is the one precedence table the loop actually consults.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v132-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { trustWorkerEvidence, persistThoughts, failedApproachesPrefix } = await import("../judge.js")
const { createEpisodeStore } = await import("../episodes.js")
const { reviewWorkerResult } = await import("../selfreview.js")

console.log("== 1. trustWorkerEvidence: the table the ledger now consults ==")
{
  const passed = trustWorkerEvidence({ ok: true, flags: [], confidence: 0.8 })
  eq("clean self-review is trusted", { trust: passed.trust, fatal: passed.fatal }, { trust: true, fatal: false })

  const unverified = trustWorkerEvidence({ ok: false, flags: ["claims completion without verification"] })
  eq("unverified-claim flag is not trusted, not fatal", { trust: unverified.trust, fatal: unverified.fatal }, { trust: false, fatal: false })

  const empty = trustWorkerEvidence({ ok: false, flags: ["empty result"] })
  eq("empty result is fatal", { trust: empty.trust, fatal: empty.fatal }, { trust: false, fatal: true })

  const noInspect = trustWorkerEvidence({ ok: false, flags: ["no inspection happened (zero tool calls)"] })
  eq("zero-tool inspection is fatal", { trust: noInspect.trust, fatal: noInspect.fatal }, { trust: false, fatal: true })

  const noEvidence = trustWorkerEvidence({ ok: false, flags: ["no evidence produced"] })
  eq("no-evidence is fatal", { trust: noEvidence.trust, fatal: noEvidence.fatal }, { trust: false, fatal: true })

  const okButFatal = trustWorkerEvidence({ ok: true, flags: ["no inspection happened (zero tool calls)"] })
  eq("a fatal flag beats ok:true (the old lie)", { trust: okButFatal.trust, fatal: okButFatal.fatal }, { trust: false, fatal: true })

  const missing = trustWorkerEvidence(null)
  eq("no self-review is fatal", { trust: missing.trust, fatal: missing.fatal }, { trust: false, fatal: true })

  const live = reviewWorkerResult({
    objective: "fix the bug",
    result: "Fixed the bug, all done, works now.",
    ok: true, toolCalls: 0, evidenceCount: 0, verification: "unverified",
  })
  const judged = trustWorkerEvidence(live)
  ok("live self-review of a zero-tool claim is not trusted", judged.trust === false)
  ok("and is fatal (no inspection happened)", judged.fatal === true && judged.flags.some((f) => /no inspection/.test(f)))
}

console.log("== 2. persistThoughts: think() reaches the episode store ==")
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v132-ep-"))
  fs.writeFileSync(path.join(cwd, "auth.js"), "export const cookie = 'sid'\n")
  const empty = persistThoughts({ cwd, task: "fix auth cookie", thoughts: [] })
  eq("empty thoughts are a no-op", { ok: empty.ok, n: empty.n }, { ok: false, n: 0 })

  const store = createEpisodeStore({ cwd })
  const ep = store.start({ problem: "fix auth cookie path", taskId: "run-think" })
  const rec = persistThoughts({
    cwd, task: "fix auth cookie path", runId: "run-think",
    thoughts: [
      { text: "check the cookie path before rewriting session.js" },
      "   ",
      { text: "the Set-Cookie domain is the actual defect" },
    ],
  })
  ok("persist reports success", rec.ok === true && rec.n === 2, JSON.stringify(rec))
  eq("attaches to the run's existing episode, not a new one", rec.episodeId, ep.episode_id)

  const fresh = createEpisodeStore({ cwd })
  const latest = fresh.latest()
  ok("thoughts survived a reload", (latest.thoughts ?? []).some((t) => String(t.text).includes("cookie path")))
  ok("blank thoughts were dropped", (latest.thoughts ?? []).length === 2)
  const block = fresh.contextBlock("fix auth cookie path")
  ok("contextBlock surfaces the thought so the next planner can read it", /cookie path/.test(block), block)
}

console.log("== 3. persistThoughts starts a thin episode when none exists ==")
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v132-thin-"))
  const rec = persistThoughts({ cwd, task: "one-shot thought task", thoughts: ["read the file first"] })
  ok("one-shot still persists", rec.ok === true && rec.n === 1)
  const latest = createEpisodeStore({ cwd }).latest()
  ok("a thin episode was started", latest && /one-shot thought/.test(latest.problem))
  ok("the thought is on it", (latest.thoughts ?? []).some((t) => t.text === "read the file first"))
}

console.log("== 4. failedApproachesPrefix: this objective, not BM25 luck ==")
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v132-fail-"))
  eq("empty store yields empty prefix", failedApproachesPrefix("anything", { cwd }), "")

  const store = createEpisodeStore({ cwd })
  const ep = store.start({ problem: "fix the login cookie race" })
  store.addFailedApproach(ep, "rewriting session.js without reading the cookie path")
  const prefix = failedApproachesPrefix("fix the login cookie race", { cwd })
  ok("prefix names the contract", prefix.startsWith("FAILED APPROACHES FROM THIS PROJECT"))
  ok("stored failure is in the prefix", prefix.includes("rewriting session.js without reading the cookie path"))

  // recency: last-3 episodes return even when the next objective shares no tokens
  store.start({ problem: "unrelated xyzzy plumbing" })
  store.addFailedApproach(store.latest(), "do not retry the xyzzy-trick")
  const recency = failedApproachesPrefix("something completely different", { cwd })
  ok("recent failures surface without token overlap", recency.includes("xyzzy-trick"), recency)
}

console.log("== 5. production callers consume the table ==")
{
  const metaSrc = fs.readFileSync(path.join(ROOT, "meta.js"), "utf8")
  const agentSrc = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8")
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
  ok("meta.js imports trustWorkerEvidence", /import \{[^}]*trustWorkerEvidence[^}]*\} from "\.\/judge\.js"/.test(metaSrc))
  ok("meta.js imports failedApproachesPrefix", /failedApproachesPrefix/.test(metaSrc) && /from "\.\/judge\.js"/.test(metaSrc))
  ok("settleWorkerOutcome asks the judge", /const trust = trustWorkerEvidence\(sr\)/.test(metaSrc))
  ok("ledger.passed is the judge's answer, not a hardcoded true", /passed:\s*trust\.trust/.test(metaSrc))
  const settle = metaSrc.split("settleWorkerOutcome")[1]?.slice(0, 4500) || ""
  ok("the DAG still markCompleted (fatal is ledger honesty, not a stall)", /markCompleted\(dag, n\.id/.test(settle))
  ok("fatal flags do not markFailed (would stall mock inspect workers)", !/trust\.fatal[\s\S]{0,120}markFailed/.test(settle))
  ok("empty result still markFailed (existing honesty)", /worker produced no findings/.test(settle) || /worker produced no findings/.test(metaSrc))
  ok("planner consumes failedApproachesPrefix for THIS objective", /failedApproachesPrefix\(state\.objective/.test(metaSrc))
  ok("failed prefix sits after the first blank line (mock currentTask stays the objective)", /\$\{state\.objective\}\\n\\n\$\{lessonPrefix/.test(metaSrc) && /failedPrefix/.test(metaSrc))
  ok("agent.js imports persistThoughts", /import \{ persistThoughts \} from "\.\/judge\.js"/.test(agentSrc))
  ok("runAgent finally persists thoughts from the tool context", /persistThoughts\(\{[\s\S]*?thoughts:\s*tools\.ctx\?\.thoughts/.test(agentSrc))
  ok("judge.js is in package.json files[]", pkg.files.includes("judge.js"))
  eq("package version stays 122.0.0", pkg.version, "122.0.0")
}

console.log("== 6. five review systems still exist; YOLO and the gate are untouched ==")
{
  const reviewers = ["plancritique.js", "critique.js", "selfreview.js", "codereview.js", "review.js"]
  for (const f of reviewers) {
    ok(`${f} still exists (not merged, not deleted)`, fs.existsSync(path.join(ROOT, f)))
  }
  ok("completion.js still exists (the gate)", fs.existsSync(path.join(ROOT, "completion.js")))
  const metaSrc = fs.readFileSync(path.join(ROOT, "meta.js"), "utf8")
  ok("meta still calls reviewWorkerResult (worker)", /reviewWorkerResult\(/.test(metaSrc))
  ok("meta still calls runCodeReview (post-mutation)", /runCodeReview\(/.test(metaSrc))
  ok("meta still calls critiquePlan (plan)", /critiquePlan\(/.test(metaSrc))
  ok("meta still calls canCompleteTask (gate)", /canCompleteTask\(/.test(metaSrc))
  const agentSrc = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8")
  ok("agent still calls reviewRun (v102 default-path review)", /reviewRun\(/.test(agentSrc))
  const judgeSrc = fs.readFileSync(path.join(ROOT, "judge.js"), "utf8")
  ok("judge.js does not touch YOLO", !/\byolo\b/i.test(judgeSrc))
  ok("judge.js does not weaken the completion gate", !/canCompleteTask|reviewBlockers/.test(judgeSrc))
  const yoloSrc = fs.readFileSync(path.join(ROOT, "yolo.js"), "utf8")
  ok("yolo.js is byte-untouched by this suite (source still ships)", /export function yoloState/.test(yoloSrc))
}

console.log("== 7. CHANGELOG / docs house style ==")
{
  const cl = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8")
  const firstH = /^##\s+.+$/m.exec(cl)?.[0] ?? ""
  ok("CHANGELOG first heading stays the package version", /122\.0\.0/.test(firstH))
  ok("named suite is a ### under it, not a ##", /^### v132 /m.test(cl) && !/^## v132 /m.test(cl))
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8")
  ok("README names v132", /v132/.test(readme) && /mindwise/.test(readme))
  const todo = fs.readFileSync(path.join(ROOT, "TODO.md"), "utf8")
  ok("TODO has v132 leftovers (no PLAN file)", /v132/.test(todo) && /mindwise/.test(todo))
  ok("no PLAN file shipped", !fs.existsSync(path.join(ROOT, "PLAN.md")) && !fs.existsSync(path.join(ROOT, "PLAN-v132.md")))
  const runAll = fs.readFileSync(path.join(ROOT, "tests/run-all.mjs"), "utf8")
  ok("run-all registers the v132 suite", /test-v132\.mjs/.test(runAll))
}

console.log(`\n== v132 mindwise suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
