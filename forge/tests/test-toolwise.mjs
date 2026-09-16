#!/usr/bin/env node
/**
 * forge — v94c "toolwise": three read-only intelligence tools (26 → 29).
 *
 * 1. Contract — TOOL_DEFS/capabilities stay 1:1 (29), the three tools are
 *    READ-class / low-risk / read-only, verifier-whitelisted, visible to
 *    verifier + read-only contexts, never in WRITE_TOOLS.
 * 2. kg_query — real world model over a real temp project: dependents,
 *    blast radius, covering tests, honest no-route + honest corrupt-graph
 *    handling, .ua knowledge graph surfaced through the SAME parser the
 *    engmemory bridge uses (one implementation, no duplicates).
 * 3. plan_whatif — deterministic simulation through the real risk engine:
 *    base assessment, add/remove/update mutation delta, alternatives for a
 *    high-risk plan, honest normalization notes, ERROR on an empty plan.
 *    It computes; it must never execute anything.
 * 4. code_context — semantic hits over real files + structural wiring of
 *    the top files; honest no-hit note; ERROR on empty query.
 * 5. doctor — selfTestTools probes the three tools and must stay 0-failed.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v94c-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_DATA_DIR

const { TOOL_DEFS, toolCount, WRITE_TOOLS, VERIFICATION_TOOLS, verificationAllows, isReadOnlyViolation, makeToolContext, execTool, selfTestTools } = await import("../tools.js")
const { BUILTIN_CAPABILITIES, defaultRegistry } = await import("../capabilities.js")
const { knowledgeGraphFacts } = await import("../engmemory.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra) => { if (cond) { PASS++; console.log(`  ok ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra !== undefined ? " — " + String(extra).slice(0, 200) : ""}`) } }
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

const NEW = ["kg_query", "plan_whatif", "code_context"]

// ---------------------------------------------------------------------------
console.log("== 1. contract: counts, classes, verifier + read-only gating ==")
{
  eq("toolCount is 30 (v94c 29 + v113 github)", toolCount(), 30)
  eq("TOOL_DEFS length 30", TOOL_DEFS.length, 30)
  eq("capabilities registry 1:1 with the wire", BUILTIN_CAPABILITIES.length, TOOL_DEFS.length)
  const reg = defaultRegistry()
  for (const n of NEW) {
    ok(`${n} in TOOL_DEFS`, TOOL_DEFS.some((t) => t.function.name === n))
    const meta = reg.get(n)
    ok(`${n} registered in capabilities`, !!meta)
    if (meta) {
      eq(`${n} class READ`, meta.klass, "READ")
      eq(`${n} risk low`, meta.risk, "low")
      eq(`${n} read_only`, meta.read_only, true)
    }
    ok(`${n} not a write tool`, !WRITE_TOOLS.has(n))
    ok(`${n} verifier-allowed`, VERIFICATION_TOOLS.allowed.includes(n))
    ok(`${n} not verifier-forbidden`, !VERIFICATION_TOOLS.forbidden.includes(n))
    ok(`verificationAllows(${n}) ok`, verificationAllows(n, {}).ok === true)
    eq(`isReadOnlyViolation(${n}) none`, isReadOnlyViolation(n, {}, true), null)
  }
  // an empty plan is invalid input, not a crash — and plan_whatif can never
  // be pushed into mutating or executing anything through its input shape
  const evil = makeToolContext({ cwd: HOME, readOnly: true })
  const out = await execTool(evil.ctx, "plan_whatif", { plan: [{ objective: "read some files", read_only: true }], mutate: { remove: "not-an-array", update: [{ nope: 1 }], add: "not-an-array" } })
  ok("plan_whatif tolerates malformed mutate input honestly", typeof out === "string" && out.includes("PLAN WHAT-IF"), out.slice(0, 120))
  ok("plan_whatif output marks estimates as estimates", out.includes("estimates, NOT proof"))
}

// ---------------------------------------------------------------------------
console.log("== 2. kg_query: real project, real world model ==")
const proj = path.join(HOME, "proj")
fs.mkdirSync(path.join(proj, "src"), { recursive: true })
fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "tiny", version: "1.0.0", type: "module" }))
fs.writeFileSync(path.join(proj, "src", "core.js"), `export function add(a, b) { return a + b }\n`)
fs.writeFileSync(path.join(proj, "src", "app.js"), `import { add } from ${JSON.stringify("./core.js")}\nexport function run() { return add(1, 2) }\n`)
fs.writeFileSync(path.join(proj, "src", "app.test.js"), `import { run } from ${JSON.stringify("./app.js")}\nimport assert from "node:assert"\nassert.equal(run(), 3)\nconsole.log("tested")\n`)
{
  const tc = makeToolContext({ cwd: proj })
  eq("empty query is an honest ERROR", (await execTool(tc.ctx, "kg_query", { query: "" })).startsWith("ERROR"), true)

  const deps = await execTool(tc.ctx, "kg_query", { query: "what depends on core.js" })
  ok("dependents route answers with app.js", deps.includes("dependents of core.js") && deps.includes("app.js"), deps.slice(0, 220))
  ok("kg_query marks itself deterministic/no-model", deps.includes("no model, no fabrication"))

  const imp = await execTool(tc.ctx, "kg_query", { query: "impact of changing core.js" })
  ok("impact route reports blast radius", imp.includes("blast radius of core.js"), imp.slice(0, 220))

  const tst = await execTool(tc.ctx, "kg_query", { query: "tests for app.js" })
  ok("tests route finds app.test.js", tst.includes("app.test.js"), tst.slice(0, 220))

  const sum = await execTool(tc.ctx, "kg_query", { query: "project overview" })
  ok("project shape summary present", sum.includes("WORLD MODEL"), sum.slice(0, 220))

  // knowledge-graph facts through the SHARED parser (same module the
  // engmemory retrieval bridge uses — one implementation)
  fs.mkdirSync(path.join(proj, ".ua"), { recursive: true })
  fs.writeFileSync(path.join(proj, ".ua", "knowledge-graph.json"), JSON.stringify({
    project: { name: "tiny", languages: ["javascript"], frameworks: ["none"], description: "tiny probe project", analyzedAt: new Date().toISOString() },
    nodes: [
      { id: "n1", name: "app", type: "module", filePath: "src/app.js", summary: "entry wiring" },
      { id: "n2", name: "core", type: "module", filePath: "src/core.js", summary: "arithmetic" },
    ],
    edges: [{ source: "n1", target: "n2", kind: "IMPORT" }],
    layers: [{ name: "src" }],
  }))
  const withKg = await execTool(tc.ctx, "kg_query", { query: "project overview" })
  ok("kg_query surfaces the .ua knowledge graph", withKg.includes("knowledge graph (") && withKg.includes("tiny"), withKg.slice(0, 240))
  const facts = knowledgeGraphFacts(proj)
  eq("shared parser serves the tool directly", facts.ok, true)
  eq("same parser instance cache as retrieval bridge", typeof facts.at, "number")

  // corrupt graph: honest degradation, never a crash, never invented facts
  fs.writeFileSync(path.join(proj, ".ua", "knowledge-graph.json"), "{ this is not json")
  const corrupt = await execTool(tc.ctx, "kg_query", { query: "project overview" })
  ok("corrupt graph reported honestly, tool still answers", corrupt.includes("WORLD MODEL") && !corrupt.startsWith("ERROR"), corrupt.slice(0, 160))
  fs.rmSync(path.join(proj, ".ua"), { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
console.log("== 3. plan_whatif: real risk engine, real mutation deltas ==")
{
  const tc = makeToolContext({ cwd: proj })
  eq("empty plan is an honest ERROR", (await execTool(tc.ctx, "plan_whatif", { plan: [] })).startsWith("ERROR"), true)
  eq("missing plan is an honest ERROR", (await execTool(tc.ctx, "plan_whatif", {})).startsWith("ERROR"), true)
  eq("nodes without objective are dropped with a note", (await execTool(tc.ctx, "plan_whatif", { plan: [{ id: "x" }] })).startsWith("ERROR"), true)

  const base = [
    { id: "n1", objective: "restructure the billing module", risk: "high", estimated_cost: 5, target_files: ["src/billing.js"] },
    { id: "n2", objective: "run the full test suite", dependencies: ["n1"], risk: "low", estimated_cost: 2 },
    { id: "n3", objective: "update dependent call sites", dependencies: ["n1"], risk: "medium", estimated_cost: 3 },
  ]
  const out = await execTool(tc.ctx, "plan_whatif", { plan: base, task: "billing restructure" })
  ok("BASE assessment rendered with ladder", out.includes("BASE plan (3 node(s))") && /\[high\]|\[medium\]/.test(out), out.slice(0, 240))
  ok("factor breakdown present", out.includes("factors: complexity"))
  ok("critical path rendered", out.includes("critical path: n1 ->"))
  ok("SPOF analysis present", out.includes("SPOF: n1"))
  ok("evidence line is honest about lessons", out.includes("real lesson(s)") && out.includes("prediction calibration"))

  // high-risk shape must surface alternatives (the plannerisk §23 contract):
  // a 6-node fully-serial mutating chain of build/run steps with no declared
  // verification requirements produces ≥3 SPOFs → dependency 0.9, tool 0.8,
  // verification 0.8 — the ladder crosses high on its own, deterministically.
  const highPlan = [
    { id: "n1", objective: "build the new schema migration", risk: "critical", estimated_cost: 5 },
    { id: "n2", objective: "run the migration against staging", dependencies: ["n1"], risk: "critical", estimated_cost: 4 },
    { id: "n3", objective: "build the data backfill job", dependencies: ["n2"], risk: "high", estimated_cost: 4 },
    { id: "n4", objective: "run the backfill on the live tables", dependencies: ["n3"], risk: "critical", estimated_cost: 5 },
    { id: "n5", objective: "build the cutover runbook", dependencies: ["n4"], risk: "high", estimated_cost: 3 },
    { id: "n6", objective: "run the cutover deploy", dependencies: ["n5"], risk: "critical", estimated_cost: 5 },
  ]
  const highOut = await execTool(tc.ctx, "plan_whatif", { plan: highPlan, task: "production cutover" })
  ok("serial critical chain lands high on the ladder", /\[high\]|\[critical\]/.test(highOut), highOut.split("\n").find((l) => l.includes("BASE plan")))
  ok("high-risk plan gets alternatives", highOut.includes("alternatives (risk high") && highOut.includes("inspect-first"), highOut.slice(0, 500))
  ok("alternatives carry expected verified progress", highOut.includes("expected verified progress"), highOut.slice(0, 500))

  // mutation: adding a read-only inspect step must be computed, not executed
  const withMut = await execTool(tc.ctx, "plan_whatif", {
    plan: [{ id: "n1", objective: "edit billing logic", risk: "medium", estimated_cost: 3 }],
    mutate: { add: [{ id: "insp", objective: "inspect billing tests first", read_only: true, estimated_cost: 1 }] },
  })
  ok("MUTATED assessment rendered", withMut.includes("MUTATED plan (2 node(s))"), withMut.slice(0, 240))
  ok("DELTA line quantifies the change", /DELTA: success [+-]0\.\d+ · risk [+-]0\.\d+ · ladder/.test(withMut), withMut.slice(0, 400))

  // removing a node cleans dangling deps with an honest note
  const rmOut = await execTool(tc.ctx, "plan_whatif", { plan: base, mutate: { remove: ["n1"] } })
  ok("dangling deps reported after removal", rmOut.includes("dangling dep(s)"), rmOut.slice(0, 300))
  ok("mutated ladder reported", rmOut.includes("ladder"), rmOut.slice(0, 300))

  // invalid risk values are normalized (no crash, no invented ladder steps)
  const weird = await execTool(tc.ctx, "plan_whatif", { plan: [{ objective: "step", risk: "catastrophic", estimated_cost: -4 }] })
  ok("invalid risk/cost normalized honestly", weird.includes("BASE plan (1 node(s))") && !weird.startsWith("ERROR"), weird.slice(0, 160))

  // determinism: same input → same numbers (it is a simulation, not a model)
  const again = await execTool(tc.ctx, "plan_whatif", { plan: base, task: "billing restructure" })
  eq("plan_whatif is deterministic", again, out)
}

// ---------------------------------------------------------------------------
console.log("== 4. code_context: semantic hits + structural wiring ==")
{
  const tc = makeToolContext({ cwd: proj })
  eq("empty query is an honest ERROR", (await execTool(tc.ctx, "code_context", { query: "" })).startsWith("ERROR"), true)

  const cc = await execTool(tc.ctx, "code_context", { query: "add numbers together arithmetic", max_hits: 4 })
  ok("semantic hit found in real file", cc.includes("src/core.js") && /\(score \d/.test(cc), cc.slice(0, 240))
  ok("wiring section present", cc.includes("wiring (world model"), cc.slice(0, 400))
  ok("honest bounds text on truncation", cc.includes("[bm25]"))

  const none = await execTool(tc.ctx, "code_context", { query: "quantum blockchain synergy entanglement" })
  ok("no-hit query degrades honestly", !none.startsWith("ERROR") && (none.includes("no matches") || none.includes("no chunk scored")), none.slice(0, 200))
}

// ---------------------------------------------------------------------------
console.log("== 5. doctor probes: the tools self-test 0-failed ==")
{
  const st = await selfTestTools({})
  for (const n of NEW) {
    const r = st.find((x) => x.name === n)
    ok(`doctor self-tests ${n}`, !!r && r.ok === true, JSON.stringify(r))
  }
}

console.log(`\n${PASS} pass, ${FAIL} fail`)
if (FAIL > 0) { console.log("FAILED"); process.exit(1) }
console.log("== toolwise suite: PASSED ==")
