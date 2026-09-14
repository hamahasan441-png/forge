#!/usr/bin/env node
/**
 * forge — v94 deepwise: judgment before action.
 *
 * 1. Plan COMPETITION (plannerisk.alternatives) — the ORIGINAL plan is now a
 *    candidate alongside the reshaped variants. The winner is reported
 *    honestly (it may be the original), and a shape-changing winner carries
 *    its real node definitions (winnerDefs) so the planner can adopt it.
 * 2. Adoption gate (plannerisk.adoptDecision) — deterministic: adopt only a
 *    meaningful-margin win at equal-or-better risk and success; never adopt
 *    shapes that drop declared dependencies (conservative-order) or any
 *    candidate that is worse than the original. meta.js wires it: the adopted
 *    defs flow into the real DAG (predictions re-stamped, live risk restarts
 *    at the adopted estimate).
 * 3. Pre-mutation self-critique (critique.js + toolintel) — a deterministic
 *    checklist BEFORE a mutating call runs: secret paths, edit targets that
 *    do not exist, same-file edit thrash, and hub files (importer in-degree
 *    read from the knowwise floor graph — deepwise reuses knowwise output,
 *    no second graph builder). Advisory: one event, one record field, one
 *    result line. Off with tools.intelligence:false (exact raw result parity
 *    is pinned) or FORGE_CRITIQUE=0.
 * 4. Reality→risk closure — experiment outcomes move LIVE risk
 *    (repairSegment → liveRisk.experiment), the last dead path in the
 *    live-risk API.
 *
 * No network, no model calls, no new subsystems — all checks reuse engines
 * that already exist.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-deepwise-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_DATA_DIR
const ENV_SAVE = { ...process.env }

const pr = await import("../plannerisk.js")
const { CRITIQUE_TOOLS, critiqueEnabled, preMutationCritique, targetFilesOf } = await import("../critique.js")
const { makeToolContext } = await import("../tools.js")
const { createToolIntel, TOOL_EVENTS } = await import("../toolintel.js")
const { createLiveRisk } = await import("../plannerisk.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

function project() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-deepwise-p-"))
  fs.writeFileSync(path.join(tmp, "lib.js"), "export function helper() { return 1 }\n")
  fs.writeFileSync(path.join(tmp, "app.js"), "import { helper } from \"./lib.js\"\nexport const a = helper()\n")
  return tmp
}

// the deterministic 6-node serial critical chain (same shape the toolwise
// suite uses to land on the high rung of the ladder — no re-derivation here)
const highChain = [
  { id: "n1", objective: "build the new schema migration", risk: "critical", estimated_cost: 5 },
  { id: "n2", objective: "run the migration against staging", dependencies: ["n1"], risk: "critical", estimated_cost: 4 },
  { id: "n3", objective: "build the data backfill job", dependencies: ["n2"], risk: "high", estimated_cost: 4 },
  { id: "n4", objective: "run the backfill on the live tables", dependencies: ["n3"], risk: "critical", estimated_cost: 5 },
  { id: "n5", objective: "build the cutover runbook", dependencies: ["n4"], risk: "high", estimated_cost: 3 },
  { id: "n6", objective: "run the cutover deploy", dependencies: ["n5"], risk: "critical", estimated_cost: 5 },
]

console.log("== deepwise: plan competition (original competes) ==")
const alts = pr.alternatives({ riskLadder: "high", uncertainty: 0.4 }, highChain)
{
  ok("high-risk plan still produces ≥3 variants", Array.isArray(alts.all) && alts.all.length >= 3, JSON.stringify(alts.all?.map((v) => v.name)))
  ok("original candidate present with a full summary", alts.original && Number.isFinite(alts.original.expectedVerifiedProgress) && alts.original.nodes === 6 && alts.original.name === "original", JSON.stringify(alts.original))
  ok("winner is the honest max over original + variants", alts.winner?.expectedVerifiedProgress === Math.max(alts.original.expectedVerifiedProgress, ...alts.all.map((v) => v.expectedVerifiedProgress)), JSON.stringify({ winner: alts.winner, original: alts.original }))
  eq("bestIsOriginal consistent with the winner", alts.bestIsOriginal, alts.winner.name === "original")
  eq("margin equals winner − original", alts.margin, Number((alts.winner.expectedVerifiedProgress - alts.original.expectedVerifiedProgress).toFixed(3)))
  ok("recommended stays comparable to the variant list (plannerisk pin intact)", alts.recommended?.expectedVerifiedProgress >= alts.all[alts.all.length - 1].expectedVerifiedProgress)
  ok("winnerDefs present iff the winner is an adoption-safe variant", (alts.winnerDefs === null) === (alts.bestIsOriginal || alts.winner.name === "conservative-order"), `winner=${alts.winner?.name} winnerDefs=${alts.winnerDefs ? alts.winnerDefs.length + " nodes" : "null"}`)
  const again = pr.alternatives({ riskLadder: "high", uncertainty: 0.4 }, highChain)
  eq("competition is deterministic", JSON.stringify(again), JSON.stringify(alts))
  const none = pr.alternatives({ riskLadder: "low", uncertainty: 0.2 }, highChain)
  // v96 unifywise: ONE return shape — alternatives() now returns the same
  // object shape for every risk ladder; `needed:false` + empty `all` marks
  // "no reshaping warranted" (previously a bare [] here and an object for
  // high risk — callers had to guard both shapes).
  ok("low-risk plans still get no alternatives", none && none.needed === false && Array.isArray(none.all) && none.all.length === 0 && none.recommended === null, JSON.stringify(none))
}

console.log("== deepwise: winnerDefs structure (adoption-safe by construction) ==")
{
  const defs = alts.winnerDefs
  if (!defs) {
    ok("winner is the original or conservative-order — no defs to check (competition verdict is still honest)", true)
  } else {
    const byId = new Map(defs.map((d) => [d.id, d]))
    ok("no node lost, no node invented", highChain.every((n) => byId.has(n.id)) && defs.length >= highChain.length, `orig ${highChain.length} vs ${defs.length}`)
    ok("added guard nodes are read-only and low-risk", defs.filter((d) => !highChain.some((n) => n.id === d.id)).every((d) => d.read_only === true && d.risk === "low"), JSON.stringify(defs.filter((d) => !highChain.some((n) => n.id === d.id))))
    // every ORIGINAL dependency survives (shapes only ADD dependencies — the
    // conservative-order serialization that DROPS deps is never adoptable)
    const origById = new Map(highChain.map((n) => [n.id, n]))
    ok("original dependencies are a subset of the adopted dependencies", highChain.every((n) => ((origById.get(n.id).dependencies ?? [])).every((d) => (byId.get(n.id).dependencies ?? []).includes(d))), JSON.stringify(highChain.map((n) => [n.id, byId.get(n.id)?.dependencies])))
    // acyclic (the DAG builder would refuse, but the gate must not hand it a cycle)
    const state = new Map()
    let acyclic = true
    const visit = (id) => {
      const s = state.get(id)
      if (s === 1) { acyclic = false; return }
      if (s === 2) return
      state.set(id, 1)
      for (const d of byId.get(id)?.dependencies ?? []) if (byId.has(d)) visit(d)
      state.set(id, 2)
    }
    for (const d of defs) visit(d.id)
    ok("winnerDefs graph is acyclic", acyclic)
    ok("all dependencies resolve inside the adopted plan", defs.every((d) => (d.dependencies ?? []).every((x) => byId.has(x))), JSON.stringify(defs.filter((d) => (d.dependencies ?? []).some((x) => !byId.has(x))).map((d) => d.id)))
  }
}

console.log("== deepwise: adoptDecision (deterministic gate) ==")
{
  eq("null input → no adopt", pr.adoptDecision(null).adopt, false)
  const O = { name: "original", risk: 0.5, successProbability: 0.7, expectedVerifiedProgress: 0.5 }
  const W = { name: "inspect-first", risk: 0.4, successProbability: 0.75, expectedVerifiedProgress: 0.58 }
  const defs = [{ id: "alt_inspect", objective: "inspect", dependencies: [], read_only: true, risk: "low", estimated_cost: 1 }, { id: "n1", objective: "work", dependencies: ["alt_inspect"], read_only: false }]
  eq("original already best → no adopt", pr.adoptDecision({ original: O, winner: O, bestIsOriginal: true, winnerDefs: null, margin: 0 }).adopt, false)
  ok("original already best → honest why", /original plan already matches/.test(pr.adoptDecision({ original: O, winner: O, bestIsOriginal: true, winnerDefs: null, margin: 0 }).why))
  eq("margin below threshold → no adopt", pr.adoptDecision({ original: O, winner: { ...W, expectedVerifiedProgress: 0.51 }, bestIsOriginal: false, winnerDefs: defs, margin: 0.01 }).adopt, false)
  ok("thin margin → honest why", /below the adoption threshold/.test(pr.adoptDecision({ original: O, winner: { ...W, expectedVerifiedProgress: 0.51 }, bestIsOriginal: false, winnerDefs: defs, margin: 0.01 }).why))
  eq("missing winnerDefs (conservative-order) → no adopt", pr.adoptDecision({ original: O, winner: { ...W, name: "conservative-order" }, bestIsOriginal: false, winnerDefs: null, margin: 0.2 }).adopt, false)
  ok("non-adoption-safe shape → honest why", /never auto-adopted/.test(pr.adoptDecision({ original: O, winner: { ...W, name: "conservative-order" }, bestIsOriginal: false, winnerDefs: null, margin: 0.2 }).why))
  eq("lower success than original → never adopt", pr.adoptDecision({ original: O, winner: { ...W, successProbability: 0.6 }, bestIsOriginal: false, winnerDefs: defs, margin: 0.2 }).adopt, false)
  ok("lower success → honest why", /never adopt a less likely plan/.test(pr.adoptDecision({ original: O, winner: { ...W, successProbability: 0.6 }, bestIsOriginal: false, winnerDefs: defs, margin: 0.2 }).why))
  eq("higher risk than original → never adopt", pr.adoptDecision({ original: O, winner: { ...W, risk: 0.8 }, bestIsOriginal: false, winnerDefs: defs, margin: 0.2 }).adopt, false)
  ok("higher risk → honest why", /never adopt a riskier plan/.test(pr.adoptDecision({ original: O, winner: { ...W, risk: 0.8 }, bestIsOriginal: false, winnerDefs: defs, margin: 0.2 }).why))
  const good = pr.adoptDecision({ original: O, winner: W, bestIsOriginal: false, winnerDefs: defs, margin: 0.08 })
  eq("real margin win at equal-or-better risk/success → ADOPT", good.adopt, true)
  eq("adoption names the winning shape", good.name, "inspect-first")
  eq("adoption threshold is the exported constant", pr.ADOPT_MARGIN, 0.03)
}

console.log("== deepwise: pre-mutation critique engine ==")
{
  const P = project()
  eq("critique tools are exactly the mutation surface", [...CRITIQUE_TOOLS].sort().join(","), "apply_patch,edit_file,multi_edit,write_file")
  const secret = preMutationCritique({ tool: "edit_file", args: { path: ".env", old: "A", new: "B" }, cwd: P })
  ok("secret-bearing target flagged", secret.concerns.some((c) => /secret-bearing path/.test(c)), JSON.stringify(secret.concerns))
  const missing = preMutationCritique({ tool: "edit_file", args: { path: "ghost.js", old: "A", new: "B" }, cwd: P })
  ok("missing edit target flagged as a certain failure", missing.concerns.some((c) => /does not exist/.test(c) && /will fail/.test(c)), JSON.stringify(missing.concerns))
  const counts = new Map([["lib.js", 3]])
  const thrash = preMutationCritique({ tool: "edit_file", args: { path: "lib.js", old: "A", new: "B" }, cwd: P, mutationCounts: counts })
  ok("edit thrash flagged with the real count", thrash.concerns.some((c) => /already mutated 3 times/.test(c)), JSON.stringify(thrash.concerns))
  const clean = preMutationCritique({ tool: "edit_file", args: { path: "lib.js", old: "A", new: "B" }, cwd: P, mutationCounts: new Map([["lib.js", 1]]) })
  eq("clean target → no concerns", clean.concerns.length, 0)
  eq("clean target → empty line (silence is the default)", clean.line, "")
  ok("line shape stays in the advisory budget", !clean.line.startsWith("[forge] critique:") || clean.concerns.length > 0)
  // hub check reads the KNOWWISE floor graph — no second graph builder
  fs.mkdirSync(path.join(P, ".ua"), { recursive: true })
  const edges = []
  for (let i = 0; i < 5; i++) edges.push({ source: `file:importer${i}.js`, target: "file:lib.js", type: "imports" })
  fs.writeFileSync(path.join(P, ".ua", "knowledge-graph.json"), JSON.stringify({ nodes: [{ id: "file:lib.js" }], edges, layers: {}, tour: [], project: { generator: "forge" } }))
  const hub = preMutationCritique({ tool: "edit_file", args: { path: "lib.js", old: "A", new: "B" }, cwd: P, mutationCounts: new Map() })
  ok("hub file flagged with the importer count from the .ua graph", hub.concerns.some((c) => /hub file \(5 importers/.test(c)), JSON.stringify(hub.concerns))
  ok("leaf file in the same graph is NOT flagged", !preMutationCritique({ tool: "edit_file", args: { path: "app.js", old: "A", new: "B" }, cwd: P, mutationCounts: new Map() }).concerns.some((c) => /hub file/.test(c)))
  // graph drift (knowwise's own concern) must be seen by the critique cache
  edges.push({ source: "file:importer5.js", target: "file:lib.js", type: "imports" })
  fs.writeFileSync(path.join(P, ".ua", "knowledge-graph.json"), JSON.stringify({ nodes: [{ id: "file:lib.js" }], edges, layers: {}, tour: [], project: { generator: "forge" } }))
  try { fs.utimesSync(path.join(P, ".ua", "knowledge-graph.json"), new Date(), new Date(Date.now() + 1100)) } catch { }
  const hub6 = preMutationCritique({ tool: "edit_file", args: { path: "lib.js", old: "A", new: "B" }, cwd: P, mutationCounts: new Map() })
  ok("stale cache does not pin a stale count", hub6.concerns.some((c) => /hub file \(6 importers/.test(c)), JSON.stringify(hub6.concerns))
  eq("off-switch works", (process.env.FORGE_CRITIQUE = "0", critiqueEnabled()), false)
  eq("default is on", (delete process.env.FORGE_CRITIQUE, critiqueEnabled()), true)
  ok("targetFilesOf reads multi_edit's real shape", targetFilesOf("multi_edit", { edits: [{ file: "a.js" }, { path: "b.js" }] }).join(","), "a.js,b.js")
  ok("targetFilesOf reads apply_patch headers", targetFilesOf("apply_patch", { patch: "*** Update File: src/x.js\n*** Add File: src/y.js" }).join(","), "src/x.js,src/y.js")
  eq("targetFilesOf tolerates junk", targetFilesOf("edit_file", {}).length, 0)
}

console.log("== deepwise: critique wiring in the tool-intel pipeline ==")
{
  const P6 = project()
  const mk = (config = {}) => {
    const tools = makeToolContext({ cwd: P6, root: P6, timeoutSec: 10, maxToolOutput: 8000, memoryPath: path.join(P6, "memory.md"), todoPath: path.join(P6, "todo.json") })
    const events = []
    const intel = createToolIntel({ exec: tools.exec, ctx: { cwd: P6, root: P6 }, config, onEvent: (e) => events.push(e), runId: "run-dw", taskId: "task-dw", task: "deepwise test" })
    return { events, intel }
  }
  ok("TOOL_CRITIQUE is declared in the event registry", TOOL_EVENTS.includes("TOOL_CRITIQUE"))
  const { intel, events } = mk()
  const res = await intel.runCall({ name: "edit_file", args: { path: "ghost.js", old: "a", new: "b" } }, { step: 1 })
  const rec = intel.records().find((r) => r.tool === "edit_file")
  ok("edit on a missing target still reaches the real exec (advisory, never blocked)", String(res.result).startsWith("ERROR"), String(res.result).slice(0, 120))
  ok("critique line reaches the model", String(res.result).includes("[forge] critique:") && /ghost\.js does not exist/.test(String(res.result)), String(res.result))
  ok("record carries the concerns additively", Array.isArray(rec?.critique) && rec.critique.some((c) => /does not exist/.test(c)), JSON.stringify(rec?.critique))
  ok("TOOL_CRITIQUE event emitted", events.some((e) => e.type === "TOOL_CRITIQUE" && e.tool === "edit_file"))
  ok("appended lines never contain journal-classified words", !/created|deleted/i.test(String(res.result).split("\n").slice(1).join("\n")))
  ok("appended lines never fake an exit-code tail", !/\[exit code: \d+\]\s*$/.test(String(res.result)))

  const mk2 = mk()
  const res2 = await mk2.intel.runCall({ name: "edit_file", args: { path: "lib.js", old: "return 1", new: "return 2" } }, { step: 1 })
  ok("clean edit → no critique line, no event", !String(res2.result).includes("[forge] critique:") && !mk2.events.some((e) => e.type === "TOOL_CRITIQUE"), String(res2.result))

  process.env.FORGE_CRITIQUE = "0"
  try {
    const mk3 = mk()
    const res3 = await mk3.intel.runCall({ name: "edit_file", args: { path: "ghost.js", old: "a", new: "b" } }, { step: 1 })
    ok("FORGE_CRITIQUE=0 → no line, no event", !String(res3.result).includes("[forge] critique:") && !mk3.events.some((e) => e.type === "TOOL_CRITIQUE"))
  } finally { process.env.FORGE_CRITIQUE = ENV_SAVE.FORGE_CRITIQUE }

  const mk4 = mk({ tools: { intelligence: false } })
  const res4 = await mk4.intel.runCall({ name: "edit_file", args: { path: "ghost.js", old: "a", new: "b" } }, { step: 1 })
  ok("intelligence:false → no critique ever", !String(res4.result).includes("[forge] critique:") && !mk4.events.some((e) => e.type === "TOOL_CRITIQUE"))
}

console.log("== deepwise: reality→risk closure (experiments move live risk) ==")
{
  const lr = createLiveRisk(0.8)
  const p0 = lr.get()
  lr.experiment(true)
  const p1 = lr.get()
  ok("informative experiment raises live risk", p1 > p0, `${p0} -> ${p1}`)
  lr.experiment(false)
  ok("uninformative experiment lowers live risk", lr.get() < p1, `${p1} -> ${lr.get()}`)
  const meta_src = fs.readFileSync(new URL("../meta.js", import.meta.url), "utf8")
  ok("repairSegment accepts liveRisk (optional — additive signature)", /liveRisk = null/.test(meta_src))
  ok("repair outcomes feed liveRisk.experiment (the closure exists in the real loop)", meta_src.includes("liveRisk?.experiment(fixed)"))
  // v96 unifywise: all three call sites now pass liveRisk AND the episodeSink
  // (the episodic stage recorders wired in v96 — hypotheses/experiments/
  // verification/failed-approaches are fed by the repair loop).
  ok("all three repairSegment call sites pass liveRisk", meta_src.includes("changedFiles: [...changedFiles], liveRisk, episodeSink, verifierReport: lastVerifierReport })") && meta_src.includes("finalRisk: finalRiskLevel, omega, changedFiles: [...changedFiles], liveRisk, episodeSink, verifierReport: lastVerifierReport })") && meta_src.includes("finalRisk: finalRiskLevel, liveRisk, episodeSink, verifierReport: lastVerifierReport,"))
  ok("meta.js wires adoptDecision into the planner", meta_src.includes("adoptDecision(alts)") && meta_src.includes("planDefs = alts.winnerDefs"))
  ok("adoption re-stamps node predictions and restarts live risk", meta_src.includes("preds2") && meta_src.includes("liveRisk = createLiveRisk(planRisk.successProbability)"))
}

console.log("== deepwise: plan_whatif shows the competition honestly ==")
{
  const P7 = project()
  const tools = makeToolContext({ cwd: P7, root: P7, timeoutSec: 10, maxToolOutput: 8000, memoryPath: path.join(P7, "memory.md"), todoPath: path.join(P7, "todo.json") })
  const events = []
  const intel = createToolIntel({ exec: tools.exec, ctx: { cwd: P7, root: P7 }, config: {}, onEvent: (e) => events.push(e), runId: "run-dw2", taskId: "task-dw2", task: "deepwise whatif" })
  const execTool = (name, args) => intel.runCall({ name, args }, { step: 1 }).then((r) => r.result)
  const out = await execTool("plan_whatif", { plan: highChain, task: "production cutover" })
  ok("alternatives still rendered with the pinned prefix", out.includes("alternatives (risk high"), out.slice(0, 300))
  ok("the competition verdict line is present", out.includes("vs original:"), out.split("\n").find((l) => l.includes("vs original")))
  const again = await execTool("plan_whatif", { plan: highChain, task: "production cutover" })
  eq("plan_whatif stays deterministic under competition", again, out)
}

console.log(`\n== deepwise suite: ${PASS} passed, ${FAIL} failed ==`)
if (FAIL > 0) { console.log("== deepwise suite: FAILED =="); process.exit(1) }
console.log("== deepwise suite: PASSED ==")
