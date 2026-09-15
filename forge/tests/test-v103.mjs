#!/usr/bin/env node
/**
 * forge — v103 "taskintel": WHERE am I working, and WHAT still holds?
 *
 * Two audited findings, both reproduced before anything was written.
 *
 * FINDING 1 (P0, workspace identity). `grep -rn "forgeRoot\|isForgeRuntime\|
 * runtimeRoot" *.js` returned nothing: no module knew the difference between
 * forge's own source tree and the user's project. Reproduced by running the
 * REAL runAgent from forge's checkout with the task "Build a REST API for my
 * project" — it wrote server.js into forge's own repository, reported
 * COMPLETED, and nothing warned.
 *
 * FINDING 2 (requirement evolution). msgclass.js classifies a user turn and
 * chat.js:1076 prints it as "· noted:" — advisory, never planned with. At the
 * other end dag.js:459 invalidateNodes() preserves completed work that does
 * not rest on invalidated ground truth, and had ZERO production callers. There
 * was no path from "change the target to Flutter" to the plan.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v103-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v103-work-"))
process.chdir(WORK)

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const {
  resolveWorkspace, formatWorkspace, forgeRuntimeRoot, isForgeRuntime,
  taskTargetsForge, repositoryRootOf, CONFIDENCE, RESOLUTION,
} = await import("../workspace.js")

// ---------------------------------------------------------------------------
console.log("== 1. the forge runtime knows where it lives ==")
{
  const root = forgeRuntimeRoot()
  ok("forgeRuntimeRoot() is forge's own directory", Boolean(root) && fs.existsSync(path.join(root, "agent.js")), String(root))
  ok("its own source files are inside it", isForgeRuntime(path.join(root, "tools.js")))
  ok("a temp dir is not", isForgeRuntime(WORK) === false)
  ok("a sibling directory is not", isForgeRuntime(path.dirname(root)) === false, path.dirname(root))
  ok("nothing at all is not", isForgeRuntime(null) === false)
}

console.log("== 2. 'is this task about forge?' is narrow on purpose ==")
{
  // A bare mention is not consent to write into forge's own source.
  for (const t of ["Improve Forge itself", "upgrade forge", "fix forge/router.js",
    "refactor the forge repository", "audit forge", "debug the forge cli"])
    ok(`names forge as the subject: ${JSON.stringify(t)}`, taskTargetsForge(t) === true)
  for (const t of ["Build a REST API for my project", "forge a plan for the migration",
    "add a login screen", "", "write tests for the payment module"])
    ok(`does NOT: ${JSON.stringify(t)}`, taskTargetsForge(t) === false)
}

console.log("== 3. the resolver separates runtime from target ==")
{
  const forge = forgeRuntimeRoot()

  const danger = resolveWorkspace({ cwd: forge, task: "Build a REST API for my project" })
  eq("cwd is forge + task is not about forge → AMBIGUOUS", danger.workspaceConfidence, CONFIDENCE.AMBIGUOUS)
  ok("and the conflict is named, not implied", danger.conflict?.kind === "target-is-forge-runtime")
  ok("the warning tells the model not to create project files here", /Do not create project files here/.test(formatWorkspace(danger)))

  const self = resolveWorkspace({ cwd: forge, task: "Improve Forge itself: fix the router" })
  ok("cwd is forge + task SAYS forge → no conflict", self.conflict === null)
  ok("and the model is told it is editing the agent's own code", /working ON forge itself/.test(formatWorkspace(self)))

  const explicit = resolveWorkspace({ cwd: forge, task: "Build a REST API", explicit: WORK })
  eq("an explicit target wins over the working directory", explicit.targetWorkspace, fs.realpathSync(WORK) === WORK ? WORK : path.resolve(WORK))
  eq("and is CERTAIN, not guessed", explicit.workspaceConfidence, CONFIDENCE.CERTAIN)
  eq("with the source stated", explicit.resolutionSource, RESOLUTION.EXPLICIT)
  ok("an explicit target outside forge is not flagged", explicit.conflict === null)

  const taskCtx = resolveWorkspace({ cwd: forge, task: "Build a REST API", taskWorkspace: WORK })
  eq("an active task's workspace also outranks cwd", taskCtx.resolutionSource, RESOLUTION.TASK_CONTEXT)
  ok("...and is never overridden back to cwd", taskCtx.targetIsForge === false)

  const ordinary = resolveWorkspace({ cwd: WORK, task: "Build a REST API for my project" })
  eq("an ordinary project is LIKELY — good enough, and said so", ordinary.workspaceConfidence, CONFIDENCE.LIKELY)
  eq("nothing is printed when there is nothing worth saying", formatWorkspace(ordinary), "")

  ok("the runtime is reported even when the target is elsewhere", explicit.forgeRoot === forge)
  ok("repositoryRootOf finds the enclosing repo", String(repositoryRootOf(forge)).length > 0)
  ok("and returns null outside one", repositoryRootOf(WORK) === null, String(repositoryRootOf(WORK)))
}

// ---------------------------------------------------------------------------
console.log("== 4. the REAL agent path: the reproduction, and its counter-cases ==")
{
  const { runAgent } = await import("../agent.js")
  const FORGE = forgeRuntimeRoot()

  function mkModel(target, content) {
    let n = 0
    const seen = []
    const server = http.createServer((req, res) => {
      if (!req.url.includes("chat/completions")) { res.writeHead(404).end(); return }
      let b = ""
      req.on("data", (c) => { b += c })
      req.on("end", () => {
        seen.push(b)
        n++
        const message = n === 1
          ? { role: "assistant", content: "", tool_calls: [{ id: "w1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: target, content }) } }] }
          : { role: "assistant", content: "Done." }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ id: "m", object: "chat.completion", created: Date.now(), model: "mock-1",
          choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }))
      })
    })
    return { server, seen }
  }

  /** Runs the real agent FROM forge's own checkout — the reproduction's setup. */
  async function runInForge(task, target, content, agentCfg = {}) {
    const m = mkModel(target, content)
    await new Promise((r) => m.server.listen(0, "127.0.0.1", r))
    const prev = process.cwd()
    try {
      process.chdir(FORGE)
      const res = await runAgent({
        config: { providers: {}, tools: { assumeYes: true }, agent: { autonomous: false, maxSteps: 5, verifyNudge: false, ...agentCfg } },
        provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${m.server.address().port}`, apiKey: "k", model: "mock-1" },
        task, journal: false,
      })
      const sys = (() => { try { return JSON.parse(m.seen[0]).messages.find((x) => x.role === "system")?.content ?? "" } catch { return "" } })()
      return { res, sys }
    } finally { process.chdir(prev); m.server.close() }
  }
  const cleanup = (name) => { try { fs.unlinkSync(path.join(FORGE, name)) } catch { /* never written */ } }

  // (a) THE REPRODUCTION
  const stray = await runInForge("Build a REST API for my project", "v103_probe_api.js", "// api\n")
  cleanup("v103_probe_api.js")
  ok("the run is told, in its system prompt, that cwd IS forge's own tree",
    /\[workspace\] WARNING/.test(stray.sys), stray.sys.slice(0, 80))
  eq("the result carries the resolved workspace", stray.res.workspace?.workspaceConfidence, CONFIDENCE.AMBIGUOUS)
  ok("a new file created there is a review BLOCKER",
    stray.res.review?.blockers?.some((b) => b.id === "workspace_matches_task"), JSON.stringify(stray.res.review?.blockers))
  ok("and the blocker names the file", /v103_probe_api\.js/.test(stray.res.review.blockers.find((b) => b.id === "workspace_matches_task").detail))

  // (b) legitimate self-development must NOT be obstructed
  const self = await runInForge("Improve Forge itself: add a helper module", "v103_probe_self.js", "export const x = 1\n")
  cleanup("v103_probe_self.js")
  ok("a task that names forge gets no workspace blocker",
    !(self.res.review?.blockers ?? []).some((b) => b.id === "workspace_matches_task"))
  eq("and still completes", self.res.status, "COMPLETED")

  // (c) the common case that must not become a false positive: editing an
  //     existing forge file while developing forge, with a task that never
  //     says the word "forge"
  const edit = await runInForge("fix the failing test", "version.js", fs.readFileSync(path.join(FORGE, "version.js"), "utf8"))
  ok("EDITING an existing file in forge's tree is not flagged",
    !(edit.res.review?.blockers ?? []).some((b) => b.id === "workspace_matches_task"), JSON.stringify(edit.res.review?.blockers))
  eq("only CREATED files count as 'a new project is being built here'", edit.res.created?.length ?? 0, 0)

  // (d) enforcement is the existing opt-in, not a new one
  const enforced = await runInForge("Build a REST API for my project", "v103_probe_enf.js", "// api\n", { review: "enforce" })
  cleanup("v103_probe_enf.js")
  eq("under agent.review=enforce the stray write is INCOMPLETE", enforced.res.status, "INCOMPLETE")
  ok("and the gate says which check refused it",
    enforced.res.completionGate.reasons.some((r) => /workspace_matches_task/.test(r)), JSON.stringify(enforced.res.completionGate.reasons))
}

// ---------------------------------------------------------------------------
const { requirementDelta, detectPlatformChange, stackTokensIn, saysKeepEverythingElse, formatDelta } = await import("../reqdelta.js")

console.log("== 5. SCENARIO §6: Android → Flutter keeps the product, drops the stack ==")
{
  const previous = [
    "paper trading with a virtual balance",
    "live market data feed",
    "order placement and lifecycle",
    "portfolio tracking and P&L",
    "candlestick charts",
    "works offline with cached data",
    "unit tests for the trading engine",
    "Jetpack Compose UI",
    "Kotlin MVVM architecture",
    "Hilt dependency injection",
    "Room local database",
    "WorkManager background sync",
  ]
  const d = requirementDelta({ previous, message: "Change the target from Android to Flutter, but keep the same trading requirements." })

  eq("the platform change is read off the sentence", d.platformChange, { from: "android", to: "flutter" })
  ok("and 'keep the same' is heard", d.keepEverythingElse === true)

  const inv = d.invalidated.map((i) => i.text)
  const retargeted = d.changed.map((i) => i.text)
  const kept = d.preserved.map((i) => i.text)

  // The property that matters is NOT which label a platform-bound decision
  // gets — it is that it does not SURVIVE UNTOUCHED. A library dies with the
  // platform; the role it filled ("dependency injection", "background sync")
  // still has to be solved on the new one, so those land in CHANGED
  // (retargeted) rather than INVALIDATED. Pinning the label would freeze a
  // distinction the replanner does not need; pinning survival is the contract.
  const notPreserved = (t) => inv.includes(t) || retargeted.includes(t)
  for (const dead of ["Jetpack Compose UI", "Kotlin MVVM architecture", "Hilt dependency injection", "Room local database", "WorkManager background sync"])
    ok(`does NOT survive the platform change: ${dead}`, notPreserved(dead) && !kept.includes(dead), JSON.stringify({ inv, retargeted }))

  ok("the pure-library decisions are outright INVALIDATED", inv.includes("Jetpack Compose UI"), JSON.stringify(inv))
  ok("a decision whose ROLE outlives the library is retargeted, not discarded",
    retargeted.includes("Hilt dependency injection") && retargeted.includes("Room local database"), JSON.stringify(retargeted))

  for (const live of ["paper trading with a virtual balance", "live market data feed", "order placement and lifecycle",
    "portfolio tracking and P&L", "candlestick charts", "works offline with cached data", "unit tests for the trading engine"])
    ok(`PRESERVED: ${live}`, kept.includes(live), JSON.stringify(kept))

  eq("nothing is both preserved and invalidated", kept.filter((k) => inv.includes(k)), [])
  eq("nothing is both preserved and retargeted", kept.filter((k) => retargeted.includes(k)), [])
  eq("every requirement is accounted for exactly once", kept.length + inv.length + retargeted.length, previous.length)
  ok("each invalidation carries the token that caused it",
    d.invalidated.every((i) => i.tokens.length > 0 && /belong/.test(i.reason)), JSON.stringify(d.invalidated[0]))
  ok("each retarget says the requirement still stands",
    d.changed.every((i) => /still stands/.test(i.reason)), JSON.stringify(d.changed[0]))
}

console.log("== 6. SCENARIO §7: an added requirement invalidates nothing ==")
{
  const previous = ["Build a REST API for the project", "CRUD endpoints for resources", "online write operations", "request validation"]
  const nodes = [
    { id: "n1", text: "define REST routes" },
    { id: "n2", text: "implement write endpoints" },
    { id: "n3", text: "add local persistence layer" },
    { id: "n4", text: "request validation middleware" },
    { id: "n5", text: "caching for read responses" },
  ]
  const d = requirementDelta({ previous, message: "It must also work offline for read-only data.", nodes })

  eq("no platform changed", d.platformChange, null)
  eq("nothing is invalidated by an ADDITION", d.invalidated.length, 0)
  eq("the REST objective survives", d.preserved.length, previous.length)
  ok("the new requirement is recorded as ADDED", d.added.some((a) => /offline/i.test(a.text)))
  ok("online writes are NOT touched", d.unaffectedNodes.some((n) => n.id === "n2"))
  ok("persistence and caching ARE affected", d.affectedNodes.map((n) => n.id).includes("n3") && d.affectedNodes.map((n) => n.id).includes("n5"),
    JSON.stringify(d.affectedNodes.map((n) => n.id)))
  ok("the consequences are labeled INFERRED, never observed", /inferred, not observed/.test(formatDelta(d)))
  for (const t of ["local persistence", "caching", "read path", "synchronization", "API/client boundary"])
    ok(`implication listed: ${t}`, d.implications.includes(t))
}

console.log("== 7. silence never invalidates, and a question is not an order ==")
{
  const prev = ["Kotlin MVVM architecture", "order lifecycle"]
  const quiet = requirementDelta({ previous: prev, message: "Also add a dark theme." })
  eq("an unrelated addition invalidates nothing", quiet.invalidated.length, 0)
  eq("...and preserves everything", quiet.preserved.length, 2)

  ok("merely mentioning a platform is not a platform change",
    detectPlatformChange("Does Flutter handle this case too?") === null)
  ok("an explicit redirection is", detectPlatformChange("switch to Flutter").to === "flutter")
  ok("'use X instead of Y' reads in the right direction",
    JSON.stringify(detectPlatformChange("use Flutter instead of Android")) === JSON.stringify({ from: "android", to: "flutter" }))
  ok("a non-platform 'from A to B' is ignored",
    detectPlatformChange("move the config from staging to production") === null)

  const removal = requirementDelta({ previous: prev, message: "Drop the dark theme requirement." })
  ok("a removal is recorded as REMOVED, not as a new requirement", removal.removed.length === 1 && removal.added.length === 0,
    JSON.stringify({ removed: removal.removed, added: removal.added }))

  ok("word boundaries hold: 'bathroom' is not Room",
    stackTokensIn("clean the bathroom").every((h) => h.token !== "room"), JSON.stringify(stackTokensIn("clean the bathroom")))
  ok("but 'Room local database' is", stackTokensIn("Room local database").some((h) => h.token === "room"))
  ok("'keep the rest the same' is understood", saysKeepEverythingElse("keep the rest the same") === true)
  eq("garbage in → empty, never a throw", requirementDelta({ previous: null, message: null, nodes: null }).preserved, [])
}

console.log("== 8. §17: the delta drives dag.invalidateNodes, which had no caller ==")
{
  const { buildDAG, invalidateNodes, markRunning, markExecutionSucceeded, markCompleted, NODE_STATUS } = await import("../dag.js")
  const g = buildDAG([
    { id: "n1", objective: "trading engine: order lifecycle and P&L", dependencies: [] },
    { id: "n2", objective: "market data client", dependencies: [] },
    { id: "n3", objective: "Jetpack Compose screens for the portfolio", dependencies: ["n1"] },
    { id: "n4", objective: "Room database for local orders", dependencies: ["n1"] },
    { id: "n5", objective: "WorkManager background price sync", dependencies: ["n2", "n4"] },
  ])
  for (const id of ["n1", "n2", "n3", "n4"]) {
    markRunning(g, id); markExecutionSucceeded(g, id); markCompleted(g, id, null, { requireVerification: false })
  }

  // DAG nodes are handed to the delta directly — no adapter, because reqdelta
  // reads dag.js's own `objective` field (dag.js:95).
  const d = requirementDelta({ previous: [], message: "Change the target from Android to Flutter, but keep the same trading requirements.", nodes: [...g.nodes.values()] })
  eq("the platform-bound nodes are the affected ones", d.affectedNodes.map((n) => n.id).sort(), ["n3", "n4", "n5"])
  eq("the platform-independent ones are not", d.unaffectedNodes.map((n) => n.id).sort(), ["n1", "n2"])

  const r = invalidateNodes(g, d.affectedNodes.map((n) => n.id), { reason: d.summary })
  eq("invalidateNodes accepts the delta's ids verbatim", r.invalidated.sort(), ["n3", "n4", "n5"])
  eq("COMPLETED platform-independent work is PRESERVED", g.nodes.get("n1").status, NODE_STATUS.COMPLETED)
  eq("...both of them", g.nodes.get("n2").status, NODE_STATUS.COMPLETED)
  eq("the Compose node is invalidated", g.nodes.get("n3").status, NODE_STATUS.INVALIDATED)
  eq("the Room node is invalidated", g.nodes.get("n4").status, NODE_STATUS.INVALIDATED)
  ok("and the invalidation carries its reason", /android/.test(String(g.nodes.get("n3").invalidation_reason ?? "")),
    String(g.nodes.get("n3").invalidation_reason))
  ok("the task is not restarted: completed work outnumbers invalidated where it should",
    [...g.nodes.values()].filter((n) => n.status === NODE_STATUS.COMPLETED).length === 2)
}

console.log("== 9. the classifier can SEE the turns that matter (and the wiring fires) ==")
{
  // Found by testing the chat wiring instead of assuming it: msgclass returned
  // ZERO classes for "Create a paper-trading Android app." and for "Change the
  // target from Android to Flutter" — the goal of a project and the message
  // that invalidates half its plan. `goal` needed a polite prefix ("please
  // build", "I want you to"), and no rule covered a retarget or a removal. The
  // delta wiring in chat.js would have been an island.
  const { classifyUserMessage, isEngineeringRelevant } = await import("../msgclass.js")
  const classesOf = (m) => classifyUserMessage(m).classes.map((c) => c.cls)

  // TRIGGER/RECORD are the exact sets chat.js keys the delta off, so these
  // assertions fail if that wiring is ever silently disconnected.
  const TRIGGER = new Set(["scope_change", "correction", "requirement", "constraint"])
  const RECORD = new Set(["goal", "requirement", "constraint"])
  const triggers = (m) => classesOf(m).some((c) => TRIGGER.has(c))
  const recorded = (m) => classesOf(m).some((c) => RECORD.has(c))

  ok("a bare imperative IS a goal", classesOf("Create a paper-trading Android app.").includes("goal"))
  ok("...and so is the REST one", classesOf("Build a REST API for the project.").includes("goal"))
  ok("a goal is recorded as a requirement for later deltas", recorded("Create a paper-trading Android app."))
  ok("a retarget is a scope change", classesOf("Change the target from Android to Flutter, but keep the same trading requirements.").includes("scope_change"))
  ok("...and it triggers the delta", triggers("Change the target from Android to Flutter, but keep the same trading requirements."))
  ok("a removal is a scope change too", classesOf("Drop the dark theme requirement.").includes("scope_change"))
  ok("the offline requirement triggers the delta", triggers("It must also work offline for read-only data."))

  // the negative controls matter more than the positives: a classifier that
  // fires on everything is the same as one that fires on nothing
  for (const q of ["what does this function do?", "what is the build command?",
    "you could build a cache here if you wanted", "hi", "thanks, that worked"])
    eq(`still plain chat: ${JSON.stringify(q)}`, classesOf(q).length, 0)

  ok("a goal now reaches engineering memory", isEngineeringRelevant(classifyUserMessage("Build a REST API for the project.")) === true)
  ok("a retarget does too", isEngineeringRelevant(classifyUserMessage("Change the target from Android to Flutter.")) === true)

  // end to end on the pair of turns the spec names: goal recorded, then the
  // retarget measured against it — the sequence chat.js performs per turn.
  const recordedReqs = []
  const turn = (text) => {
    const k = new Set(classesOf(text))
    let delta = null
    if ([...k].some((c) => TRIGGER.has(c)) && recordedReqs.length) delta = requirementDelta({ previous: recordedReqs, message: text })
    if ([...k].some((c) => RECORD.has(c))) recordedReqs.push(text)
    return delta
  }
  eq("turn 1 records the goal and computes no delta", turn("Create a paper-trading Android app with Jetpack Compose, Room, Hilt and WorkManager."), null)
  const d2 = turn("Change the target from Android to Flutter, but keep the same trading requirements.")
  ok("turn 2 produces a real delta against turn 1", Boolean(d2) && d2.platformChange?.to === "flutter", JSON.stringify(d2?.platformChange))
  // The goal arrived as ONE compound sentence, the way a person actually types
  // it — the delta has to split it, or the product dies with the platform.
  ok("the stack clauses inside the single goal sentence are invalidated",
    ["Jetpack Compose", "Room", "Hilt", "WorkManager"].every((t) => d2.invalidated.some((i) => i.text === t)),
    JSON.stringify(d2.invalidated.map((i) => i.text)))
  ok("and the product clause is RETARGETED, not thrown away",
    d2.changed.some((c) => /paper-trading/.test(c.text)), JSON.stringify(d2.changed.map((c) => c.text)))
  ok("the sentence announcing the retarget is not itself a retargeted requirement",
    !d2.changed.some((c) => /^Change the target/.test(c.text)), JSON.stringify(d2.changed.map((c) => c.text)))
}

console.log(`\n== v103 taskintel suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
