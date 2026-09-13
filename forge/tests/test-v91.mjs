/**
 * v91 "corewise" — ∞ CORE part 1: the collaboration layer.
 *
 *  1. Bus (§27-29): schema, topologies, dedupe, inboxes, ask/reply, broadcast,
 *     view filtering, bounded log, normalization rejects garbage.
 *  2. Handoffs (§30): the ten spec fields, validation, acknowledgment,
 *     supersede, latestContextFor, context block for the receiver.
 *  3. Self-review (§34): honest verified report passes; empty/unverified/
 *     zero-inspection reports fail with explicit flags; uncertainty extracted.
 *  4. Conflict resolution (§31): evidence wins (never majority vote), both
 *     findings preserved, rejected reasoning kept, ties ESCALATE to an
 *     experiment instead of guessing.
 *  5. Crew routing (§36-37): role → capability class mapping, damped
 *     performance memory (one failure never blacklists), record→pick loop.
 *  6. Decision engine (§40): schema, WAITING_FOR_USER lifecycle, anti-nag
 *     cooldown, resolve→ANSWERED, panel rendering.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v91-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 200) : ""}`) }
}

const { MESSAGE_TYPE, PRIORITY, createBus, normalizeMessage, formatMessage, busPath, validMessageType } = await import("../bus.js")
const { HANDOFF_STATUS, createHandoff, validateHandoff, handoffContextBlock, formatHandoff, createHandoffLedger } = await import("../handoff.js")
const { reviewWorkerResult, extractUncertainties, formatSelfReview, REVIEW_QUESTION_KEYS } = await import("../selfreview.js")
const { CONFLICT_STATUS, reportConflict, resolveConflict, scorePosition, formatConflict } = await import("../crewconflict.js")
const { ROLE_ROUTE, preferredClassFor, createCrewRouter, effectiveStats, crewPerfPath } = await import("../crewroute.js")
const { DECISION_TYPE, DECISION_STATUS, createDecisionEngine, buildDecision, formatDecisionPanel, formatDecisionLine, shouldAsk } = await import("../decisionengine.js")

// ---------------------------------------------------------------------------
console.log("== 1. bus: schema + topologies (§27) ==")
{
  const b = createBus({ taskId: "t-bus-1" })
  b.register("core", { kind: "core" })
  b.register("crew", { kind: "crew" })
  b.register("w1", { role: "explorer" })
  b.register("w2", { role: "coder" })

  const m = b.send({ sender: "w1", receiver: "core", type: "DISCOVERY", content: "API contract found in users.ts", file_refs: ["users.ts"], node_id: "n1", confidence: 0.9 })
  ok("send returns a normalized message", Boolean(m?.message_id))
  ok("message_type preserved", m.message_type === "DISCOVERY")
  ok("file_refs kept", m.file_refs[0] === "users.ts")
  ok("core inbox has it", b.inbox("core").length === 1)
  ok("sender inbox empty (never self-deliver)", b.inbox("w1").length === 0)

  // Agent → Agent
  const m2 = b.send({ sender: "w1", receiver: "w2", type: "QUESTION", content: "does utils.js export parseDate?", requires_action: true })
  ok("A→A delivery", b.inbox("w2").some((x) => x.message_id === m2.message_id))
  // Core → Agent
  b.send({ sender: "core", receiver: "w1", type: "REQUEST", content: "check the auth boundary", priority: PRIORITY.HIGH })
  ok("Core→Agent delivery", b.inbox("w1").some((x) => x.message_type === "REQUEST"))
  // Agent → Crew
  b.send({ sender: "w2", receiver: "crew", type: "PROGRESS", content: "half done" })
  ok("A→Crew delivery", b.inbox("crew").some((x) => x.message_type === "PROGRESS"))

  // broadcast
  b.send({ sender: "core", receiver: "*", type: "WARNING", content: "verification epoch bumped" })
  ok("broadcast reaches w1", b.inbox("w1").some((x) => x.message_type === "WARNING"))
  ok("broadcast reaches w2", b.inbox("w2").some((x) => x.message_type === "WARNING"))
  ok("broadcast never echoes to sender", !b.inbox("core").some((x) => x.content === "verification epoch bump"))

  // dedupe: same (from,to,type,content) inside the window is dropped
  const dupe = b.send({ sender: "w1", receiver: "core", type: "DISCOVERY", content: "API contract found in users.ts" })
  ok("duplicate dropped", dupe === null)

  // invalid messages rejected
  ok("unknown type rejected", b.send({ sender: "w1", receiver: "core", type: "GOSSIP", content: "x" }) === null)
  ok("missing receiver rejected", b.send({ sender: "w1", type: "FINDING", content: "x" }) === null)
  ok("normalizeMessage rejects null", normalizeMessage(null) === null)

  // drain clears
  const drained = b.drain("w2")
  ok("drain returns and clears", drained.length > 0 && b.inbox("w2").length === 0)

  // stats + view
  const st = b.stats()
  ok("stats counts messages", st.messages > 0)
  ok("view hides PROGRESS noise", !b.view().every((x) => x.message_type === "PROGRESS"))
  ok("formatMessage renders", formatMessage(m).includes("w1") && formatMessage(m).includes("DISCOVERY"))

  // ask/reply (§29)
  const askPromise = b.ask({ from: "w2", to: "w1", content: "which symbol owns the route?", timeoutMs: 500 })
  // find the question in w1's inbox and reply to it
  await new Promise((r) => setTimeout(r, 10))
  const q = b.inbox("w1").find((x) => x.message_type === "QUESTION" && x.content.includes("which symbol"))
  const rep = q ? b.reply(q.message_id, { from: "w1", content: "routeHandler in server.js" }) : null
  const answer = await askPromise
  ok("ask → reply resolves", Boolean(answer) && answer.content === "routeHandler in server.js")
  ok("reply is addressed back to the asker", Boolean(rep) && rep.receiver === "w2")
  const timedOut = await b.ask({ from: "w2", to: "w1", content: "nobody home?", timeoutMs: 60 })
  ok("unanswered question resolves null", timedOut === null)

  // persistence round-trip
  const b2 = createBus({ taskId: "t-bus-persist", persist: true })
  b2.send({ sender: "a", receiver: "b", type: "FINDING", content: "persisted" })
  const b3 = createBus({ taskId: "t-bus-persist" })
  const n = b3.load()
  ok("bus JSONL persists and reloads", n >= 1 && b3.log().some((x) => x.content === "persisted"))
  ok("busPath is task-scoped", busPath("t-bus-persist").includes("t-bus-persist"))
}

console.log("== 2. handoffs: ten fields + acknowledgment (§30) ==")
{
  const h = createHandoff({
    from: "w1", to: "w2", taskId: "t1", nodeId: "n7", reason: "timeout",
    currentState: "mid-investigation", completedWork: ["mapped imports"], remainingWork: ["locate root cause"],
    files: ["a.js"], symbols: ["parseDate"], hypotheses: ["cache staleness"], evidence: ["tests pass"],
    failedApproaches: ["grepping the minified bundle"], recommendedNextAction: "run the focused test",
    verificationStatus: "unverified",
  })
  ok("handoff has all spec fields", ["current_state", "completed_work", "remaining_work", "files", "symbols", "hypotheses", "evidence", "failed_approaches", "recommended_next_action", "verification_status"].every((k) => k in h))
  ok("starts PENDING", h.status === HANDOFF_STATUS.PENDING)
  ok("validate ok", validateHandoff(h).ok === true)
  const bad = validateHandoff({ ...h, to: "" })
  ok("missing receiver rejected", bad.ok === false && bad.errors.some((e) => e.includes("receiver")))

  const block = handoffContextBlock(h)
  ok("context block names failed approaches", block.includes("Do NOT repeat") && block.includes("grepping the minified bundle"))
  ok("context block carries next action", block.includes("run the focused test"))

  const ledger = createHandoffLedger()
  ledger.add(h)
  ok("acknowledge → ACKNOWLEDGED", ledger.acknowledge(h.handoff_id, { accepted: true })?.status === HANDOFF_STATUS.ACKNOWLEDGED)
  ok("latestContextFor finds it", ledger.latestContextFor("n7")?.handoff_id === h.handoff_id)
  ok("pending() empty after ack", ledger.pending().length === 0)
  const h2 = createHandoff({ from: "w3", to: "w4" })
  ledger.add(h2)
  ledger.supersede(h2.handoff_id)
  ok("supersede preserves history", ledger.get(h2.handoff_id)?.status === HANDOFF_STATUS.SUPERSEDED)
  ok("formatHandoff renders", formatHandoff(h).includes("w1") && formatHandoff(h).includes("w2"))
  let threw = false
  try { ledger.add({ garbage: true }) } catch { threw = true }
  ok("invalid handoff into ledger throws loudly", threw)
}

console.log("== 3. self-review: no empty success (§34) ==")
{
  ok("all 7 spec questions present", REVIEW_QUESTION_KEYS.length === 7)

  const good = reviewWorkerResult({
    objective: "fix the bug in a.js",
    result: "Fixed the bug in a.js: the cache key was unsorted. Tests pass (exit code 0). Note: I am uncertain whether the edge case with unicode keys is covered.",
    ok: true, toolCalls: 5, evidenceCount: 2, verification: "verified",
  })
  ok("honest verified report passes", good.ok === true && good.confidence >= 0.55)
  const goodUnc = reviewWorkerResult({ objective: "x", result: "Fixed it. Uncertain about unicode keys.", ok: true, toolCalls: 2, verification: "verified" })
  ok("explicit uncertainty is rewarded, not punished", goodUnc.answered.uncertainty === 1)

  const empty = reviewWorkerResult({ objective: "do a thing", result: "", ok: true, toolCalls: 5, verification: "verified" })
  ok("empty result can never pass", empty.ok === false && empty.flags.some((f) => f.includes("empty")))

  const lazy = reviewWorkerResult({ objective: "fix the bug", result: "Fixed the bug, all done, works now.", ok: true, toolCalls: 0, evidenceCount: 0, verification: "unverified" })
  ok("zero-inspection claim fails", lazy.ok === false)
  ok("flags name the defects", lazy.flags.some((f) => f.includes("no inspection")) && lazy.flags.some((f) => f.includes("without verification")))

  const failedRun = reviewWorkerResult({ objective: "x", result: "Fixed everything.", ok: false, toolCalls: 9, verification: "verified" })
  ok("runner failure caps confidence hard", failedRun.ok === false && failedRun.confidence <= 0.15)

  const unverified = reviewWorkerResult({ objective: "x", result: "Implemented the feature, done.", ok: true, toolCalls: 4, verification: "unverified" })
  ok("unverified completion claim is flagged", unverified.flags.some((f) => f.includes("without verification")))
  ok("formatSelfReview marks flags", formatSelfReview(unverified).includes("FLAGS") || formatSelfReview(unverified).includes("flags"))
}

console.log("== 4. conflict resolution: evidence wins (§31) ==")
{
  const c = reportConflict(
    { claimant: "tester", claim: "the bug is a race", evidence: [{ kind: "VERIFICATION", value: "fails only under parallel load, exit code non-zero", asOf: Date.now(), files: [] }] },
    { claimant: "coder", claim: "the bug is a typo", evidence: ["I think it is a typo"] },
    { topic: "root cause of flaky test", taskId: "t1", nodeId: "n2" }
  )
  ok("both positions preserved verbatim", c.a.claimant === "tester" && c.b.claimant === "coder")
  ok("starts OPEN", c.status === CONFLICT_STATUS.OPEN)

  resolveConflict(c)
  ok("evidence-supported side wins", c.status === CONFLICT_STATUS.RESOLVED && c.resolution.winner === "tester")
  ok("rejected reasoning preserved", c.resolution.rejected.claimant === "coder" && Array.isArray(c.resolution.rejected.preservedReasoning))
  ok("history records the comparison", c.history.some((h) => h.step === "compared evidence"))

  // tie without evidence → ESCALATED to a discriminating experiment, never voted
  const tie = reportConflict({ claimant: "a", claim: "X", evidence: [] }, { claimant: "b", claim: "Y", evidence: [] }, { topic: "which module leaks" })
  resolveConflict(tie)
  ok("tie escalates to experiment (no vote)", tie.status === CONFLICT_STATUS.ESCALATED)
  ok("suggested experiment exists", typeof tie.resolution.suggestedExperiment === "string" && tie.resolution.suggestedExperiment.length > 0)

  // world model breaks the tie
  const tie2 = reportConflict({ claimant: "a", claim: "config wins", evidence: [] }, { claimant: "b", claim: "env wins", evidence: [] }, { topic: "config precedence" })
  resolveConflict(tie2, { world: (claim) => claim.includes("config") ? true : false })
  ok("world model agreement decides", tie2.status === CONFLICT_STATUS.RESOLVED && tie2.resolution.winner === "a")

  // scoring: a verified record beats any amount of self-confidence
  const strong = scorePosition({ claimant: "x", claim: "", evidence: [{ kind: "VERIFIED", value: "tests ran", asOf: Date.now(), files: [], confidence: 1 }], confidence: 0.3 })
  const weak = scorePosition({ claimant: "y", claim: "", evidence: [], confidence: 0.99 })
  ok("evidence beats self-confidence", strong.score > weak.score)
  ok("formatConflict renders resolved", formatConflict(c).includes("RESOLVED"))
}

console.log("== 5. crew routing: specialists get their class (§36-37) ==")
{
  ok("explorer → fast", preferredClassFor("explorer") === ROLE_ROUTE.explorer && ROLE_ROUTE.explorer === "fast_reasoning")
  ok("coder → coding", preferredClassFor("coder") === "coding")
  ok("debugger → debugging", preferredClassFor("debugger") === "debugging")
  ok("reviewer → security_review", preferredClassFor("reviewer") === "security_review")
  ok("unknown heuristic role degrades sanely", ["fast_reasoning", "coding"].includes(preferredClassFor("widget_whisperer")))

  const router = createCrewRouter({ cwd: process.cwd() })
  const pick = router.pick({ role: "debugger", candidates: [{ provider: "p1", model: "m-fast" }, { provider: "p1", model: "m-big" }] })
  ok("pick returns a candidate + class", Boolean(pick.model) && pick.cls === "debugging")
  ok("why is honest about no history", pick.why.includes("no history"))

  router.record({ klass: "MEDIUM", role: "debugger", model: "m-big", ok: true, verified: true, latencyMs: 1000 })
  router.record({ klass: "MEDIUM", role: "debugger", model: "m-big", ok: true, verified: true, latencyMs: 1200 })
  router.record({ klass: "MEDIUM", role: "debugger", model: "m-fast", ok: false, verified: false, latencyMs: 9000 })
  const pick2 = router.pick({ role: "debugger", klass: "MEDIUM", candidates: [{ provider: "p1", model: "m-fast" }, { provider: "p1", model: "m-big" }] })
  ok("measured performance flips the choice", pick2.model === "m-big" && pick2.why.includes("measured"))

  // damping: one failure must not blacklist
  const data = { "ANY|tester|m1": { runs: 1, ok: 0, verified: 0, latencyMs: 0, tokens: 0 } }
  const st = effectiveStats(data, "ANY", "tester", "m1")
  ok("one failure keeps ~50%+ success (damped)", st.successRate >= 0.33 && st.successRate < 0.67)

  ok("crewperf path is per-project", crewPerfPath(process.cwd()).includes(path.join("projects")))
  ok("stats expose entries", router.stats().length > 0)
}

console.log("== 6. decision engine: ask well, never nag (§40) ==")
{
  ok("decision types are the spec's four", Object.values(DECISION_TYPE).sort().join() === ["AUTHORIZATION", "CLARIFICATION", "DECISION", "INFORMATION"].sort().join())

  const engine = createDecisionEngine({ cwd: process.cwd(), taskId: "t-dec" })
  let waited = null
  const engine2 = createDecisionEngine({
    cwd: process.cwd(), taskId: "t-dec-2",
    onWait: (d) => { waited = d },
  })
  const d = engine2.ask({
    type: DECISION_TYPE.DECISION,
    title: "Breaking API change",
    question: "Ship v2 with a breaking rename, or keep v1 compat?",
    options: [
      { id: "v2", label: "Ship v2", consequences: "cleaner API, migration needed" },
      { id: "v1", label: "Keep compat", consequences: "slower progress, no breakage" },
    ],
    recommendation: "v2",
    reason: "two consumers, both updatable",
    key: "api-v2",
  })
  ok("ask creates a pending decision", d && !d.skipped && d.status === DECISION_STATUS.PENDING)
  ok("onWait fired (Core → WAITING_FOR_USER)", waited?.decision_id === d.decision_id)
  ok("all spec fields present", ["title", "options", "recommendation", "reason", "status", "answer"].every((k) => k in d))

  // anti-nag: same key refused while pending/recent
  const again = engine2.ask({ type: DECISION_TYPE.DECISION, title: "Breaking API change", key: "api-v2" })
  ok("same key is not re-asked", again.skipped === true)
  ok("refusal explains why", typeof again.why === "string" && again.why.length > 0)

  const resolved = engine2.resolve(d.decision_id, { choice: "v2", note: "go" })
  ok("resolve → ANSWERED with the choice", resolved?.status === DECISION_STATUS.ANSWERED && resolved.answer === "v2")
  ok("answered questions are never re-asked", engine2.shouldAsk("api-v2").ask === false)

  // rendering (§68)
  const panel = formatDecisionPanel(buildDecision({ title: "Pick a DB", question: "which?", options: ["postgres", "sqlite"], recommendation: "opt1", reason: "scale" }), { width: 60 })
  ok("panel shows DECISION REQUIRED", panel.includes("DECISION REQUIRED"))
  ok("panel marks the recommendation", panel.includes("Recommended:"))
  ok("panel lists options with letters", panel.includes("[A]") && panel.includes("[B]"))
  ok("formatDecisionLine one-liner", formatDecisionLine(d).includes("answered"))
}

console.log(`\n== v91 part 1: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
