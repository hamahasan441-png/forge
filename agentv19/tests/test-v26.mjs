#!/usr/bin/env node
/**
 * forge — v26 DAG fan-out.
 *
 * Read-only workers scale with task class (MEDIUM 2 / LARGE 4 / ARCH 6).
 * MICRO/SMALL stay 0 unless the caller requested workers. A mutating node
 * is still serialized (one writer). Low-RAM / low-tier machines stay at 1.
 *
 * Does not: flip assumeYes, raise block-class, rewrite the DAG kernel,
 * change classifyTaskComplexity(), or add a runtime dependency.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v26-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v26-work-"))
process.chdir(WORK)

const { TASK_CLASS, strategyFor, classifyTaskComplexity } = await import("../forge/classify.js")
const { AGENT_BUDGETS, defaultConfig } = await import("../forge/config.js")
const { workerCeiling, createResourceManager, ADAPT } = await import("../forge/resources.js")
const dag = await import("../forge/dag.js")
const { createAgentManager, roleIsReadOnly } = await import("../forge/agentmanager.js")
const { VERSION } = await import("../forge/version.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

console.log("== class worker caps ==")
{
  eq("MICRO stays 0", strategyFor(TASK_CLASS.MICRO).workers, 0)
  eq("SMALL stays 0", strategyFor(TASK_CLASS.SMALL).workers, 0)
  eq("MEDIUM is 4", strategyFor(TASK_CLASS.MEDIUM).workers, 4)
  eq("LARGE is 6", strategyFor(TASK_CLASS.LARGE).workers, 6)
  eq("RECOVERY is 4", strategyFor(TASK_CLASS.RECOVERY).workers, 4)
  eq("ARCH is 8", strategyFor(TASK_CLASS.ARCHITECTURAL).workers, 8)
  eq("AGENT_BUDGETS ceiling is 8", AGENT_BUDGETS.maxParallelSubAgents, 8)
  eq("defaultConfig uses the ceiling", defaultConfig().agent.maxParallelSubAgents, 8)
  ok("classifyTaskComplexity is frozen (typo still trivial)", classifyTaskComplexity("fix a typo") === "trivial")
}

console.log("== workerCeiling: tier clamp, never above 6 ==")
{
  eq("low tier is always 1", workerCeiling({ agent: { maxParallelSubAgents: 8 } }, "low"), 1)
  eq("low ignores a huge config", workerCeiling({ agent: { maxParallelSubAgents: 99 } }, "low"), 1)
  eq("high with default is 8", workerCeiling({}, "high"), 8)
  eq("normal with default is 4", workerCeiling({}, "normal"), 4)
  eq("config 3 is respected on high", workerCeiling({ agent: { maxParallelSubAgents: 3 } }, "high"), 3)
  eq("config 99 is still capped at 8", workerCeiling({ agent: { maxParallelSubAgents: 99 } }, "high"), 8)
}

console.log("== scheduleBatch: 6 independent readers, one writer ==")
{
  const readers = dag.buildDAG(
    Array.from({ length: 6 }, (_, i) => ({
      id: `r${i}`, objective: `inspect ${i}`, read_only: true, role: "researcher",
      targetFiles: [`src/f${i}.js`],
    }))
  )
  const six = dag.scheduleBatch(readers, { maxParallel: 6 })
  eq("six independent researchers run together", six.length, 6)
  const four = dag.scheduleBatch(readers, { maxParallel: 4 })
  eq("maxParallel 4 is respected", four.length, 4)
  const def = dag.scheduleBatch(readers)
  eq("default maxParallel covers 6 readers", def.length, 6)

  const writers = dag.buildDAG(
    Array.from({ length: 6 }, (_, i) => ({
      id: `w${i}`, objective: `edit ${i}`, role: "coder", targetFiles: [`src/a${i}.js`],
    }))
  )
  const one = dag.scheduleBatch(writers, { maxParallel: 6 })
  eq("six mutators still serialize to 1", one.length, 1)
  ok("the one is a coder", one[0]?.role === "coder")

  const mixed = dag.buildDAG([
    { id: "r1", objective: "read a", read_only: true, role: "researcher", targetFiles: ["src/a.js"] },
    { id: "r2", objective: "read b", read_only: true, role: "researcher", targetFiles: ["src/b.js"] },
    { id: "r3", objective: "read c", read_only: true, role: "researcher", targetFiles: ["src/c.js"] },
    { id: "z_edit", objective: "edit d", role: "coder", targetFiles: ["src/d.js"] },
  ])
  const batch = dag.scheduleBatch(mixed, { maxParallel: 6 })
  ok("mixed batch is all read-only (mutator waits)", batch.length >= 2 && batch.every((n) => n.read_only), JSON.stringify(batch.map((n) => n.id)))
  ok("mutating node is not in the read-only batch", !batch.some((n) => n.id === "z_edit"))
}

console.log("== low RAM still serializes to 1 ==")
{
  const rm = createResourceManager({ config: { agent: { maxParallelSubAgents: 6 } }, cwd: WORK })
  rm.setFreeMB(200)
  const ev = rm.evaluate()
  eq("low RAM reduces workers to 1", ev.limits.maxWorkers, 1)
  ok("REDUCE_CONCURRENCY fired", ev.actions.some((a) => a.action === ADAPT.REDUCE_CONCURRENCY))
}

console.log("== agent manager: 6 read-only workers settle; coder is not read-only ==")
{
  ok("researcher is read-only", roleIsReadOnly("researcher"))
  ok("coder is NOT read-only", !roleIsReadOnly("coder"))
  const runner = async ({ role }) => `${role} ok`
  const m = createAgentManager({ maxWorkers: 6, defaultTimeoutMs: 2000, runner })
  const recs = Array.from({ length: 6 }, (_, i) => m.spawn({ role: "researcher", task: `look at ${i}` }))
  await Promise.all(recs.map((r) => r.promise))
  eq("six researchers completed", recs.filter((r) => r.status === "completed").length, 6)
  ok("two mutators still conflict", m.conflict(
    { role: "coder", readOnly: false, task: "edit src/x.js" },
    { role: "coder", readOnly: false, task: "edit src/y.js" },
  )?.conflict === true)
}

console.log("== meta filter still refuses a coder worker (source) ==")
{
  const src = fs.readFileSync(new URL("../forge/meta.js", import.meta.url), "utf8")
  ok("fan-out filters read_only and excludes coder", /n\.read_only && n\.role && n\.role !== "coder"/.test(src))
  ok("settleWorkers still exists", /const settleWorkers = async/.test(src))
}

console.log("== package version ==")
{
  eq("VERSION is 58.0.0", VERSION, "58.0.0")
  eq("package.json is 58.0.0", JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8")).version, "58.0.0")
}

console.log(`\n== v26 suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
