#!/usr/bin/env node
/**
 * forge — P0 an invalid plan must NEVER fall through.
 *
 * A malformed plan (missing ids, duplicate ids, cycles, self-dependency,
 * unknown dependencies, absolute/forbidden paths, conflicting targets, no
 * verification requirements) is REPAIRED deterministically; if it cannot be
 * repaired the controller WAITS — it never executes a broken plan.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-plan-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-plan-work-"))
process.chdir(WORK)

const dag = await import("../forge/dag.js")
const meta = await import("../forge/meta.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

console.log("== validation catches every malformed shape ==")
{
  eq("empty plan", dag.validatePlan([]).ok, false)
  const noId = dag.validatePlan([{ objective: "do it" }])
  ok("missing id rejected", noId.ok === false)
  const dupId = dag.validatePlan([{ id: "a", objective: "x" }, { id: "a", objective: "y" }])
  ok("duplicate id rejected", dupId.ok === false)
  const selfDep = dag.validatePlan([{ id: "a", objective: "x", dependencies: ["a"] }])
  ok("self-dependency rejected", selfDep.ok === false)
  const unknownDep = dag.validatePlan([{ id: "a", objective: "x", dependencies: ["ghost"] }])
  ok("unknown dependency rejected", unknownDep.ok === false)
  const cycle = dag.validatePlan([
    { id: "a", objective: "x", dependencies: ["b"] },
    { id: "b", objective: "y", dependencies: ["a"] },
  ])
  ok("cycle rejected", cycle.ok === false)
  const abs = dag.validatePlan([{ id: "a", objective: "x", targetFiles: ["/etc/passwd"] }])
  ok("absolute path rejected", abs.ok === false)
  const trav = dag.validatePlan([{ id: "a", objective: "x", targetFiles: ["../../outside.js"] }])
  ok("traversal path rejected", trav.ok === false)
  ok("every stage is reported", typeof dag.validatePlan([{ id: "a" }]).stages === "object")
  ok("recoverable errors are marked", dag.validatePlan([{ id: "a", objective: "x", dependencies: ["ghost"] }]).recoverable === true)
}

console.log("== repair() fixes what can be fixed ==")
{
  const v = dag.validatePlan([{ objective: "do the thing" }, { id: "b", objective: "next", dependencies: ["ghost"] }])
  const rep = dag.repairPlan([{ objective: "do the thing" }, { id: "b", objective: "next", dependencies: ["ghost"] }], "task", v)
  ok("repair succeeded", rep.ok === true)
  ok("ids were assigned", rep.nodes.every((n) => n.id))
  ok("unknown dependencies pruned", rep.nodes.every((n) => (n.dependencies ?? []).every((d) => rep.nodes.some((x) => x.id === d))))
  ok("repair actions are audited", Array.isArray(rep.changes) && rep.changes.length > 0)
  ok("the repaired plan validates", dag.validatePlan(rep.nodes).ok === true)
  // cycles are pruned
  const cyc = [{ id: "a", objective: "x", dependencies: ["b"] }, { id: "b", objective: "y", dependencies: ["a"] }]
  const rep2 = dag.repairPlan(cyc, "task", dag.validatePlan(cyc))
  ok("cycle repaired", rep2.ok === true && dag.validatePlan(rep2.nodes).ok === true)
  // an empty plan becomes a single safe node
  const rep3 = dag.repairPlan([], "just do the work", dag.validatePlan([]))
  ok("empty plan becomes one node", rep3.ok === true && rep3.nodes.length === 1)
  ok("the generated node targets the task", String(rep3.nodes[0].objective).includes("just do the work"))
}

console.log("== verification requirements are part of plan validity ==")
{
  const v = dag.validatePlan([{ id: "a", objective: "rewrite the parser" }])
  ok("a plan without verification requirements is flagged", v.stages?.VERIFICATION === "failed")
  const rep = dag.repairPlan([{ id: "a", objective: "rewrite the parser" }], "rewrite the parser", v)
  ok("repair adds verification requirements", dag.validatePlan(rep.nodes).ok === true)
  ok("the repaired node carries verification requirements", Array.isArray(rep.nodes[0].verificationRequirements) && rep.nodes[0].verificationRequirements.length > 0)
}

console.log("== end-to-end: a malformed plan is repaired, never executed blindly ==")
{
  const events = []
  let executed = 0
  const fake = async (args) => {
    if (args.planOnly) return { text: "1. do the thing\n2. also do the thing\n1. duplicate id", toolRecords: [], commandChecks: [], toolLog: [] }
    executed++
    return { text: "done", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] }
  }
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const r = await meta.runMeta({
    config: cfg, provider: { name: "x", model: "m" }, task: "do the thing",
    runAgent: fake, workers: false, maxSegments: 8,
    signal: new AbortController().signal, onEvent: (e) => events.push(e),
  })
  ok("a DAG was built anyway", !!r.task.dag)
  ok("the plan was repaired", events.some((e) => e.type === "PLAN_REPAIRED"))
  const nodes = r.task.dag?.nodes ?? []
  ok("every node has a unique id", new Set(nodes.map((n) => n.id)).size === nodes.length)
  ok("every node has an objective", nodes.every((n) => n.objective))
  ok("dependencies all resolve", nodes.every((n) => (n.dependencies ?? []).every((d) => nodes.some((x) => x.id === d))))
  ok("the repaired plan is valid", dag.validatePlan(nodes).ok === true)
  console.log(`       (status=${r.status}, nodes=${nodes.length}, planRepaired=${events.some((e) => e.type === "PLAN_REPAIRED")})`)
}

console.log("== end-to-end: an unrepairable plan WAITS instead of executing ==")
{
  let executed = 0
  const fake = async (args) => {
    if (args.planOnly) {
      // UNREPAIRABLE: a node that declares empty conflictKeys would disable
      // conflict detection, and no repair may silently invent keys for it.
      return { text: JSON.stringify([{ id: "a", objective: "x", conflictKeys: [] }]), toolRecords: [], commandChecks: [], toolLog: [] }
    }
    executed++
    return { text: "done", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] }
  }
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const r = await meta.runMeta({
    config: cfg, provider: { name: "x", model: "m" }, task: "impossible plan",
    runAgent: fake, workers: false, maxSegments: 4, signal: new AbortController().signal,
  })
  ok("did not report COMPLETED", r.status !== "COMPLETED")
  eq("task WAITS on an unrepairable plan", r.status, "WAITING")
  ok("no agent execution happened on an invalid plan", executed === 0)
  console.log(`       (status=${r.status}, executed=${executed})`)
}

console.log(`\n== invalid-plan suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
