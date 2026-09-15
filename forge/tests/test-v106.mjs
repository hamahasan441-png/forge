#!/usr/bin/env node
/**
 * forge — v106 "resumewise": a resumed task finally hears the new instruction.
 *
 * REPRODUCED FIRST, against the real runMeta. meta.js reads
 * `objective: resumeRec?.objective ?? task` and every later consumer reads
 * state.objective — so resuming a task with a CHANGED requirement discarded
 * the new instruction outright. An Android task resumed with "change the
 * target from Android to Flutter" never showed the model the word Flutter; it
 * carried on building the Android app. The user's correction vanished between
 * two lines of code.
 *
 * The same change closes the other half: dag.invalidateNodes() — "COMPLETED
 * nodes that do not depend on invalidated ground truth are PRESERVED" — had
 * NO production caller anywhere, which forge's own `selfaudit` reports. A
 * requirement change is exactly what it was built for.
 *
 * Ordering is the whole trick, and it took two failed attempts to get right:
 *   1. applying the delta after the DAG was built was too late — the planner
 *      had already run from the old objective;
 *   2. updating state.objective alone was still wrong, because a resumed
 *      run's first segment is built by resumePrompt() from `resumeRec`, the
 *      snapshot read off disk BEFORE the update. The one prompt a resume
 *      actually sends still carried the superseded objective.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v106-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const { openTask, readTask } = await import("../taskstate.js")
const { runMeta } = await import("../meta.js")
const dagLib = await import("../dag.js")

const ANDROID = "Create a paper-trading Android app with Jetpack Compose and Room"
const RETARGET = "Change the target from Android to Flutter, but keep the same trading requirements."

/** A mock model that records every prompt it is sent. */
function mkModel() {
  const prompts = []
  const server = http.createServer((req, res) => {
    if (!req.url.includes("chat/completions")) { res.writeHead(404).end(); return }
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      try { prompts.push(JSON.parse(b).messages.map((m) => String(m.content ?? "")).join("\n")) } catch { /* shape probes are not the assertion */ }
      const message = { role: "assistant", content: "1. inspect the project\n2. report findings\nEND" }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "m", object: "chat.completion", created: Date.now(), model: "mock-1",
        choices: [{ index: 0, message, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }))
    })
  })
  return { server, prompts }
}

/** Seed a task on disk, then resume it with `instruction`. */
async function resumeWith(taskId, objective, instruction, { dag = null } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v106-work-"))
  fs.writeFileSync(path.join(work, "package.json"), '{"name":"probe"}\n')
  const prev = process.cwd()
  process.chdir(work)
  const ts = openTask(taskId, { create: true, objective, cwd: work })
  if (dag) ts.setDAG(dagLib.serializeDAG(dag))
  ts.save?.()

  const m = mkModel()
  await new Promise((r) => m.server.listen(0, "127.0.0.1", r))
  const events = []
  try {
    await runMeta({
      config: { providers: {}, tools: { assumeYes: true }, agent: { autonomous: true, maxSteps: 2, maxSegments: 1 } },
      provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${m.server.address().port}`, apiKey: "k", model: "mock-1" },
      task: instruction, resumeTaskId: taskId, onEvent: (e) => events.push(e),
    })
  } catch { /* the run ending early is fine; the prompts and events are the evidence */ }
  finally { process.chdir(prev); m.server.close() }
  return { prompts: m.prompts.join("\n"), events, record: readTask(taskId), work }
}

// ---------------------------------------------------------------------------
console.log("== 1. THE REPRODUCTION: a changed requirement reaches the model ==")
{
  const r = await resumeWith("t-v106-a", ANDROID, RETARGET)
  ok("the model is shown the new instruction", /Flutter/i.test(r.prompts))
  ok("the original objective is still there — appended, never replaced",
    /Android/i.test(r.prompts), r.prompts.slice(0, 120))
  ok("the stored objective records the change", /requirement change/i.test(r.record?.objective ?? ""))
  ok("and names what is no longer valid",
    /NO LONGER VALID/.test(r.record?.objective ?? "") && /Jetpack Compose/i.test(r.record?.objective ?? ""),
    String(r.record?.objective ?? "").slice(0, 200))
  const changed = r.events.find((e) => e.type === "REQUIREMENTS_CHANGED")
  ok("a REQUIREMENTS_CHANGED event is emitted", Boolean(changed))
  eq("carrying the platform change it detected", changed?.platformChange, { from: "android", to: "flutter" })
  ok("and marked applied", changed?.applied === true)
}

console.log("== 2. silence and consent do NOT disturb a resumed plan ==")
{
  const same = await resumeWith("t-v106-b", ANDROID, ANDROID)
  ok("resuming with the SAME objective changes nothing",
    !same.events.some((e) => e.type === "REQUIREMENTS_CHANGED"))
  ok("and the objective is untouched", same.record?.objective === ANDROID, String(same.record?.objective ?? "").slice(0, 120))

  const go = await resumeWith("t-v106-c", ANDROID, "continue")
  ok("'continue' is consent, not a requirement change",
    !go.events.some((e) => e.type === "REQUIREMENTS_CHANGED"))
  eq("the objective survives verbatim", go.record?.objective, ANDROID)

  const empty = await resumeWith("t-v106-d", ANDROID, "")
  ok("an empty instruction changes nothing", !empty.events.some((e) => e.type === "REQUIREMENTS_CHANGED"))
}

console.log("== 3. the plan is REVISED, not restarted ==")
{
  // four nodes already COMPLETED: two platform-independent, two Android-bound
  const g = dagLib.buildDAG([
    { id: "n1", objective: "trading engine: order lifecycle and P&L", dependencies: [] },
    { id: "n2", objective: "market data client", dependencies: [] },
    { id: "n3", objective: "Jetpack Compose portfolio screens", dependencies: ["n1"] },
    { id: "n4", objective: "Room database for local orders", dependencies: ["n1"] },
  ])
  for (const id of ["n1", "n2", "n3", "n4"]) {
    dagLib.markRunning(g, id); dagLib.markExecutionSucceeded(g, id)
    dagLib.markCompleted(g, id, null, { requireVerification: false })
  }

  const r = await resumeWith("t-v106-e", ANDROID, RETARGET, { dag: g })
  const inval = r.events.find((e) => e.type === "PLAN_INVALIDATED")
  ok("a PLAN_INVALIDATED event is emitted", Boolean(inval), JSON.stringify(r.events.map((e) => e.type).slice(0, 12)))
  eq("the platform-bound nodes are invalidated", (inval?.invalidatedNodes ?? []).sort(), ["n3", "n4"])
  eq("the platform-independent ones are preserved", (inval?.preservedNodes ?? []).sort(), ["n1", "n2"])

  // and the persisted graph agrees — this is the part that survives the run
  const saved = r.record?.dag ? dagLib.deserializeDAG(r.record.dag) : null
  ok("the persisted DAG kept the completed trading work",
    saved && saved.nodes.get("n1").status === dagLib.NODE_STATUS.COMPLETED, String(saved?.nodes?.get("n1")?.status))
  ok("...and both of them", saved && saved.nodes.get("n2").status === dagLib.NODE_STATUS.COMPLETED)
  ok("while the Compose node is invalidated",
    saved && saved.nodes.get("n3").status === dagLib.NODE_STATUS.INVALIDATED, String(saved?.nodes?.get("n3")?.status))
  ok("and the Room node too", saved && saved.nodes.get("n4").status === dagLib.NODE_STATUS.INVALIDATED)
  ok("the invalidation carries its reason", /android/i.test(String(saved?.nodes?.get("n3")?.invalidation_reason ?? "")),
    String(saved?.nodes?.get("n3")?.invalidation_reason ?? ""))

  // the point of the whole exercise: this is a revision, not a restart
  const completed = saved ? [...saved.nodes.values()].filter((n) => n.status === dagLib.NODE_STATUS.COMPLETED).length : 0
  eq("half the finished work survived the requirement change", completed, 2)
}

console.log("== 4. dag.invalidateNodes finally has a production caller ==")
{
  // forge's own selfaudit reported it with zero callers across v100–v105.
  // This is the assertion that says it no longer does.
  const { analyzeModules } = await import("../selfaudit.js")
  const forgeRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
  const r = analyzeModules({
    dir: forgeRoot, testDir: path.join(forgeRoot, "tests"),
    entryPoints: ["forge.js", "plugin-host.js", "selfaudit.js"], skipDirs: ["skills"],
  })
  const flagged = new Set(r.findings.filter((f) => f.name).map((f) => `${f.file}:${f.name}`))
  ok("selfaudit no longer reports dag.js:invalidateNodes as orphaned",
    !flagged.has("dag.js:invalidateNodes"))
  ok("and requirementDelta is wired too", !flagged.has("reqdelta.js:requirementDelta"))
  ok("the audit still works (it did not simply stop finding things)",
    r.findings.length > 0 && r.stats.modules > 100, JSON.stringify(r.stats))
}

console.log(`\n== v106 resumewise suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
