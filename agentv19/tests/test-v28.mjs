#!/usr/bin/env node
/**
 * forge — v28 8-core burst + mid-task replan + lessons-into-planning.
 *
 * A Xiaomi 13T Pro (8 cores / 12GB) is high + burst. Linux MemAvailable
 * is preferred over MemFree so cache does not starve the tier. Mid-task
 * replan rewrites unfinished DAG nodes from verification evidence.
 * Lessons steer the FIRST plan, not just repair.
 *
 * Does not: flip assumeYes, raise block-class, change
 * classifyTaskComplexity(), spawn a second writer, or add a runtime dep.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v28-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v28-work-"))
process.chdir(WORK)

const { resourceProfile, readAvailableMB } = await import("../forge/profile.js")
const { TASK_CLASS, strategyFor, classifyTaskComplexity, resolveEffort, synthesizePlan } = await import("../forge/classify.js")
const { AGENT_BUDGETS, defaultConfig } = await import("../forge/config.js")
const { workerCeiling, createResourceManager, tokenBudgetFor, fanoutWaitMs, scaleWorkers, ADAPT } = await import("../forge/resources.js")
const dag = await import("../forge/dag.js")
const { shouldReplan, maxReplans, replanPrompt, planLessonsPrefix } = await import("../forge/replan.js")
const { recordLesson, lessonsForPlan, lessonsForPrompt } = await import("../forge/lessons.js")
const { VERSION } = await import("../forge/version.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

console.log("== 13T Pro 8-core / 12GB is high + burst; 4-core 12GB stays high not burst ==")
{
  const phone = resourceProfile({ cores: 8, freeMB: 2500, totalMB: 12288 })
  eq("13T Pro is high", phone.tier, "high")
  eq("13T Pro is burst", phone.burst, true)
  eq("13T Pro cores", phone.cores, 8)

  const laptop = resourceProfile({ cores: 4, freeMB: 6000, totalMB: 12288 })
  eq("12GB 4-core still high (v27)", laptop.tier, "high")
  eq("12GB 4-core is NOT burst", laptop.burst, false)

  const ci = resourceProfile({ cores: 2, freeMB: 2000, totalMB: 3930 })
  eq("2-core CI is low", ci.tier, "low")
  eq("2-core CI is not burst", ci.burst, false)

  const starving = resourceProfile({ cores: 8, freeMB: 400, totalMB: 12288 })
  eq("8-core 12GB with <700MB available is low", starving.tier, "low")
  eq("starving is not burst", starving.burst, false)

  const sub2 = resourceProfile({ cores: 8, freeMB: 400, totalMB: 1800 })
  eq("sub-2GB phone is low", sub2.tier, "low")

  const avail = readAvailableMB()
  ok("readAvailableMB is a finite number", Number.isFinite(avail) && avail >= 0)
  const live = resourceProfile()
  ok("live burst is boolean", typeof live.burst === "boolean")
  ok("live tier is low|normal|high", ["low", "normal", "high"].includes(live.tier))
}

console.log("== burst scales class workers; MICRO/SMALL stay 0; ceiling still 8 ==")
{
  const burst = { tier: "high", burst: true, cores: 8, totalMB: 12288 }
  const high4 = { tier: "high", burst: false, cores: 4, totalMB: 12288 }
  eq("MICRO stays 0 on burst", scaleWorkers(strategyFor(TASK_CLASS.MICRO).workers, burst), 0)
  eq("SMALL stays 0 on burst", scaleWorkers(strategyFor(TASK_CLASS.SMALL).workers, burst), 0)
  eq("MEDIUM 4 → 6 on burst", scaleWorkers(4, burst), 6)
  eq("LARGE 6 → 8 on burst", scaleWorkers(6, burst), 8)
  eq("ARCH 8 stays 8 (capped)", scaleWorkers(8, burst), 8)
  eq("RECOVERY 4 → 6 on burst", scaleWorkers(4, burst), 6)
  eq("MEDIUM stays 4 on 4-core high", scaleWorkers(4, high4), 4)
  eq("strategyFor MEDIUM is still 4 (base)", strategyFor(TASK_CLASS.MEDIUM).workers, 4)
  eq("strategyFor LARGE is still 6", strategyFor(TASK_CLASS.LARGE).workers, 6)
  eq("strategyFor ARCH is still 8", strategyFor(TASK_CLASS.ARCHITECTURAL).workers, 8)
  eq("ceiling high is still 8", workerCeiling({}, "high"), 8)
  eq("ceiling low is still 1", workerCeiling({ agent: { maxParallelSubAgents: 8 } }, "low"), 1)
  eq("AGENT_BUDGETS ceiling is 8", AGENT_BUDGETS.maxParallelSubAgents, 8)
}

console.log("== fan-out wait: 1-arg high stays 8s; burst is 5s ==")
{
  eq("fan-out wait normal is 4s", fanoutWaitMs("normal"), 4000)
  eq("fan-out wait high (1-arg) is 8s", fanoutWaitMs("high"), 8000)
  eq("fan-out wait burst is 5s", fanoutWaitMs("high", { burst: true }), 5000)
  eq("tokenBudget high is still 4M", tokenBudgetFor("high"), 4_000_000)
  eq("2-arg auto trivial stays shallow", resolveEffort("auto", "what is this file").deep, false)
  eq("auto moderate on high still deep", resolveEffort("auto", "please add a helper function in this module so later callers can use it", { tier: "high" }).deep, true)
  ok("classifyTaskComplexity is frozen (typo still trivial)", classifyTaskComplexity("fix a typo") === "trivial")
}

console.log("== resource manager carries burst ==")
{
  const rm = createResourceManager({
    config: {},
    cwd: WORK,
    profile: resourceProfile({ cores: 8, freeMB: 4000, totalMB: 12288 }),
  })
  eq("13T Pro manager is high", rm.state.tier, "high")
  eq("13T Pro manager is burst", rm.state.burst, true)
  eq("13T Pro maxWorkers is 8", rm.state.maxWorkers, 8)
  eq("snapshot has burst", rm.snapshot().burst, true)

  rm.setFreeMB(200)
  const ev = rm.evaluate()
  eq("low RAM on 13T Pro still serializes to 1", ev.limits.maxWorkers, 1)
  ok("REDUCE_CONCURRENCY fired", ev.actions.some((a) => a.action === ADAPT.REDUCE_CONCURRENCY))
}

console.log("== shouldReplan policy ==")
{
  eq("MICRO never replans", shouldReplan({ klass: "MICRO", repairCount: 9 }), false)
  eq("SMALL never replans", shouldReplan({ klass: "SMALL", consecutiveFailures: 9 }), false)
  eq("MEDIUM at 0 repairs does not", shouldReplan({ klass: "MEDIUM", repairCount: 0 }), false)
  eq("MEDIUM at 1 repair does not", shouldReplan({ klass: "MEDIUM", repairCount: 1 }), false)
  eq("MEDIUM at 2 repairs does", shouldReplan({ klass: "MEDIUM", repairCount: 2 }), true)
  eq("LARGE at 2 consecutive does", shouldReplan({ klass: "LARGE", consecutiveFailures: 2 }), true)
  eq("cap 1 blocks a second replan", shouldReplan({ klass: "LARGE", repairCount: 4, replanCount: 1 }), false)
  eq("burst cap is 2", maxReplans({ burst: true }), 2)
  eq("burst allows a second replan", shouldReplan({ klass: "LARGE", repairCount: 4, replanCount: 1, profile: { burst: true } }), true)
  eq("burst cap 2 blocks a third", shouldReplan({ klass: "LARGE", repairCount: 4, replanCount: 2, profile: { burst: true } }), false)
  eq("escalate after 1 repair does", shouldReplan({ klass: "MEDIUM", repairCount: 1, escalate: true }), true)
  eq("escalate with nothing done does not", shouldReplan({ klass: "MEDIUM", repairCount: 0, escalate: true }), false)
}

console.log("== replanRemaining keeps completed, prefixes new ids, mutators still serialize ==")
{
  const g = dag.buildDAG([
    { id: "inspect", objective: "read files", role: "researcher", read_only: true, dependencies: [] },
    { id: "patch", objective: "edit src", role: "coder", read_only: false, dependencies: ["inspect"] },
    { id: "verify", objective: "run tests", role: "tester", read_only: true, dependencies: ["patch"] },
  ])
  ok("mark inspect completed", dag.markCompleted(g, "inspect", "looked", { requireVerification: false }))
  const next = dag.replanRemaining(g, [
    { id: "n1", objective: "inspect other files", role: "researcher", read_only: true, dependencies: ["inspect"] },
    { id: "n2", objective: "edit src", role: "coder", read_only: false, dependencies: ["n1"] },
  ], { prefix: "rp1_", reason: "test failed" })
  eq("replan ok", next.ok, true)
  eq("kept the completed inspect", next.kept, 1)
  eq("added 2 remaining", next.added, 2)
  eq("dropped the unfinished 2", next.dropped, 2)
  eq("inspect still completed", next.graph.nodes.get("inspect").status, "completed")
  ok("new ids are prefixed", next.graph.nodes.has("rp1_1") && next.graph.nodes.has("rp1_2"))
  ok("n1 was remapped, not colliding", !next.graph.nodes.has("n1"))
  eq("rp1_1 depends on completed inspect", next.graph.nodes.get("rp1_1").dependencies.includes("inspect"), true)
  eq("rp1_1 is ready (deps done)", next.graph.nodes.get("rp1_1").status, "ready")
  eq("empty replan is not ok", dag.replanRemaining(g, []).ok, false)

  const writers = dag.buildDAG(
    Array.from({ length: 6 }, (_, i) => ({
      id: `w${i}`, objective: `edit ${i}`, role: "coder", targetFiles: [`src/a${i}.js`],
    }))
  )
  eq("six mutators still serialize to 1", dag.scheduleBatch(writers).length, 1)
}

console.log("== lessonsForPlan steers planning (not just repair) ==")
{
  recordLesson({
    failure: "tests failed on helper export",
    cause: "forgot to export the helper",
    failedStrategy: "edit the test instead of the source",
    successfulRepair: "export the helper from src/util.js",
    applicableContext: "add a helper function",
    task: "please add a helper function in this module so later callers can use it",
    confidence: 0.8,
  }, WORK)
  const planL = lessonsForPlan("please add a helper function in this module so later callers can use it", { cwd: WORK })
  ok("lessonsForPlan found a hit", planL.count >= 1)
  ok("lessonsForPlan text is the learned-failures block", /LEARNED FROM PAST FAILURES/.test(planL.text))
  ok("avoided includes the failed strategy", planL.avoided.some((a) => /edit the test/.test(a)))
  const prefix = planLessonsPrefix(planL)
  ok("planLessonsPrefix is non-empty", prefix.length > 20)
  ok("prompt mentions remaining work", /remaining work/.test(replanPrompt({ objective: "fix the helper", reason: "tests failed" })))
  ok("MICRO synthesizePlan still 1 node", synthesizePlan("fix typo", TASK_CLASS.MICRO).length === 1)
}

console.log("== safety + wiring (source) ==")
{
  const meta = fs.readFileSync(new URL("../forge/meta.js", import.meta.url), "utf8")
  ok("meta imports shouldReplan", /shouldReplan/.test(meta))
  ok("meta imports lessonsForPlan", /lessonsForPlan/.test(meta))
  ok("meta imports scaleWorkers", /scaleWorkers/.test(meta))
  ok("meta emits PLAN_REPLAN_STARTED", /PLAN_REPLAN_STARTED/.test(meta))
  ok("meta still filters read_only non-coder workers", /n\.read_only && n\.role && n\.role !== "coder"/.test(meta))
  const cfg = defaultConfig()
  eq("assumeYes stays false", cfg.tools.assumeYes, false)
  eq("allowSudo stays false", cfg.tools.allowSudo, false)
  eq("allowInterpreterEval stays false", cfg.tools.allowInterpreterEval, false)
}

console.log("== package version ==")
{
  eq("VERSION is 52.0.0", VERSION, "52.0.0")
  eq("package.json is 52.0.0", JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8")).version, "52.0.0")
}

console.log(`\n== v28 suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
