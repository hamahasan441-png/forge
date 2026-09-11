#!/usr/bin/env node
/**
 * forge — v27 high-capacity 12GB + sandbox bash.
 *
 * A 12GB / 4-core machine is high (harder/smarter/deeper/faster). 2-core
 * phones and this CI stay low. Sandbox bash wraps after shellguard when
 * bwrap is present; missing binary → unsandboxed, never a fake sandbox.
 *
 * Does not: flip assumeYes, raise block-class, change
 * classifyTaskComplexity(), or add a runtime dependency.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v27-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v27-work-"))
process.chdir(WORK)

const { resourceProfile } = await import("../profile.js")
const { TASK_CLASS, strategyFor, classifyTaskComplexity, resolveEffort } = await import("../classify.js")
const { AGENT_BUDGETS, defaultConfig } = await import("../config.js")
const { workerCeiling, createResourceManager, tokenBudgetFor, fanoutWaitMs, ADAPT } = await import("../resources.js")
const { detectSandbox, wrapBash, findSandboxBinary } = await import("../sandbox.js")
const { modelMayRun } = await import("../shellguard.js")
const dag = await import("../dag.js")
const { VERSION } = await import("../version.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

console.log("== 12GB / 4-core is high; 2-core CI stays low ==")
{
  const laptop = resourceProfile({ cores: 4, freeMB: 6000, totalMB: 12288 })
  eq("12GB 4-core is high", laptop.tier, "high")
  eq("12GB reports totalMB", laptop.totalMB, 12288)
  eq("12GB reports cores", laptop.cores, 4)

  const eight = resourceProfile({ cores: 4, freeMB: 3000, totalMB: 8192 })
  eq("8GB 4-core with room is high", eight.tier, "high")

  const ci = resourceProfile({ cores: 2, freeMB: 2000, totalMB: 3930 })
  eq("2-core ~4GB CI is low", ci.tier, "low")

  const phone = resourceProfile({ cores: 8, freeMB: 400, totalMB: 1800 })
  eq("sub-2GB phone is low", phone.tier, "low")

  const starving = resourceProfile({ cores: 4, freeMB: 500, totalMB: 12288 })
  eq("12GB with <700MB free is low (pressure)", starving.tier, "low")

  const mid = resourceProfile({ cores: 4, freeMB: 2000, totalMB: 4096 })
  eq("4-core 4GB is normal, not high", mid.tier, "normal")

  const beefy = resourceProfile({ cores: 8, freeMB: 5000, totalMB: 16384 })
  eq("8-core 16GB is high", beefy.tier, "high")

  const live = resourceProfile()
  ok("live tier is low|normal|high", ["low", "normal", "high"].includes(live.tier))
}

console.log("== class caps + ceiling 8 ==")
{
  eq("MICRO stays 0", strategyFor(TASK_CLASS.MICRO).workers, 0)
  eq("SMALL stays 0", strategyFor(TASK_CLASS.SMALL).workers, 0)
  eq("MEDIUM is 4", strategyFor(TASK_CLASS.MEDIUM).workers, 4)
  eq("LARGE is 6", strategyFor(TASK_CLASS.LARGE).workers, 6)
  eq("RECOVERY is 4", strategyFor(TASK_CLASS.RECOVERY).workers, 4)
  eq("ARCH is 8", strategyFor(TASK_CLASS.ARCHITECTURAL).workers, 8)
  eq("AGENT_BUDGETS ceiling is 8", AGENT_BUDGETS.maxParallelSubAgents, 8)
  eq("defaultConfig uses the ceiling", defaultConfig().agent.maxParallelSubAgents, 8)
  eq("low tier is always 1", workerCeiling({ agent: { maxParallelSubAgents: 8 } }, "low"), 1)
  eq("low ignores a huge config", workerCeiling({ agent: { maxParallelSubAgents: 99 } }, "low"), 1)
  eq("high with default is 8", workerCeiling({}, "high"), 8)
  eq("normal with default is 4", workerCeiling({}, "normal"), 4)
  eq("config 3 is respected on high", workerCeiling({ agent: { maxParallelSubAgents: 3 } }, "high"), 3)
  eq("config 99 is still capped at 8", workerCeiling({ agent: { maxParallelSubAgents: 99 } }, "high"), 8)
  ok("classifyTaskComplexity is frozen (typo still trivial)", classifyTaskComplexity("fix a typo") === "trivial")
}

console.log("== high-tier: deeper auto, bigger budgets ==")
{
  eq("2-arg auto trivial stays shallow", resolveEffort("auto", "what is this file").deep, false)
  eq("2-arg auto complex still deep", resolveEffort("auto", "refactor the database schema and fix the failing test suite").deep, true)
  eq("fast never deep even on high", resolveEffort("fast", "refactor the whole security layer", { tier: "high" }).deep, false)

  const moderate = "please add a helper function in this module so later callers can use it"
  eq("moderate text is moderate", classifyTaskComplexity(moderate), "moderate")
  eq("auto moderate on normal stays standard", resolveEffort("auto", moderate).deep, false)
  eq("auto moderate on high goes deep", resolveEffort("auto", moderate, { tier: "high" }).deep, true)
  eq("auto trivial on high stays shallow", resolveEffort("auto", "what is this file", { tier: "high" }).deep, false)

  eq("tokenBudget low is 600k", tokenBudgetFor("low"), 600_000)
  eq("tokenBudget normal is 2M", tokenBudgetFor("normal"), 2_000_000)
  eq("tokenBudget high is 4M", tokenBudgetFor("high"), 4_000_000)
  eq("fan-out wait normal is 4s", fanoutWaitMs("normal"), 4000)
  eq("fan-out wait high is 8s", fanoutWaitMs("high"), 8000)

  const rm = createResourceManager({
    config: {},
    cwd: WORK,
    profile: resourceProfile({ cores: 4, freeMB: 8000, totalMB: 12288 }),
  })
  eq("12GB resource manager is high", rm.state.tier, "high")
  eq("12GB token budget is 4M", rm.state.tokenBudget, 4_000_000)
  eq("12GB maxWorkers is 8", rm.state.maxWorkers, 8)

  rm.setFreeMB(200)
  const ev = rm.evaluate()
  eq("low RAM on a 12GB box still serializes to 1", ev.limits.maxWorkers, 1)
  ok("REDUCE_CONCURRENCY fired", ev.actions.some((a) => a.action === ADAPT.REDUCE_CONCURRENCY))
}

console.log("== scheduleBatch default follows the ceiling; mutators still serialize ==")
{
  const readers = dag.buildDAG(
    Array.from({ length: 8 }, (_, i) => ({
      id: `r${i}`, objective: `inspect ${i}`, read_only: true, role: "researcher",
      targetFiles: [`src/f${i}.js`],
    }))
  )
  const eight = dag.scheduleBatch(readers)
  eq("default maxParallel is 8", eight.length, 8)
  const writers = dag.buildDAG(
    Array.from({ length: 8 }, (_, i) => ({
      id: `w${i}`, objective: `edit ${i}`, role: "coder", targetFiles: [`src/a${i}.js`],
    }))
  )
  eq("eight mutators still serialize to 1", dag.scheduleBatch(writers).length, 1)
}

console.log("== sandbox: missing bwrap is unsandboxed, never a lie ==")
{
  const none = detectSandbox({ binary: null })
  eq("injected-null is unavailable", none.available, false)
  eq("injected-null kind is none", none.kind, "none")

  const wrapped = wrapBash("echo hi", { cwd: WORK, root: WORK, binary: null })
  eq("no binary → file is /bin/sh", wrapped.file, "/bin/sh")
  ok("no binary → args are -c command", wrapped.args[0] === "-c" && wrapped.args[1] === "echo hi")
  eq("no binary → sandboxed false", wrapped.sandboxed, false)

  const live = detectSandbox()
  if (!findSandboxBinary()) {
    eq("this environment has no bwrap → available false", live.available, false)
    const liveWrap = wrapBash("true", { cwd: WORK, root: WORK })
    eq("live wrap is not sandboxed", liveWrap.sandboxed, false)
    eq("live wrap does not claim bwrap", liveWrap.kind, "none")
  } else {
    ok("bwrap present → available", live.available === true && live.kind === "bwrap")
  }
}

console.log("== sandbox: wrap shape (fake bwrap) — no net unshare, after classifier ==")
{
  const fake = path.join(HOME, "fake-bwrap")
  fs.writeFileSync(fake, `#!/bin/sh
# argv echoer: last "-c" payload is executed so wrapBash is actually runnable
cmd=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-c" ]; then cmd="$a"; fi
  prev="$a"
done
if [ -n "$cmd" ]; then exec /bin/sh -c "$cmd"; fi
exit 0
`)
  fs.chmodSync(fake, 0o755)

  const w = wrapBash("echo sandboxed-ok", { cwd: WORK, root: WORK, binary: fake })
  eq("fake bwrap is sandboxed", w.sandboxed, true)
  eq("fake bwrap is the file", w.file, fake)
  ok("unshare-pid is set", w.args.includes("--unshare-pid"))
  ok("die-with-parent is set", w.args.includes("--die-with-parent"))
  ok("project is bound rw", w.args.includes("--bind") && w.args.includes(WORK))
  ok("chdir is the cwd", w.args.includes("--chdir") && w.args.includes(WORK))
  ok("does NOT unshare-net", !w.args.includes("--unshare-net"))
  ok("command is still the last -c payload", w.args[w.args.lastIndexOf("-c") + 1] === "echo sandboxed-ok")

  const ran = spawnSync(w.file, w.args, { encoding: "utf8", timeout: 5000 })
  ok("fake-bwrap wrap actually runs", (ran.status === 0) && /sandboxed-ok/.test(ran.stdout || ""), `status=${ran.status} out=${(ran.stdout || "").slice(0, 80)} err=${(ran.stderr || "").slice(0, 80)}`)

  const blocked = modelMayRun("rm -rf /", { cwd: WORK, root: WORK }, {})
  ok("block-class still refused before any wrap", blocked.ok === false)
}

console.log("== runBash still classifies before wrapping (source) ==")
{
  const src = fs.readFileSync(new URL("../tools.js", import.meta.url), "utf8")
  const may = src.indexOf("modelMayRun(")
  const wrap = src.indexOf("wrapBash(")
  ok("tools.js imports wrapBash", /import\s*\{\s*wrapBash\s*\}\s*from\s*"\.\/sandbox\.js"/.test(src))
  ok("modelMayRun appears before wrapBash in tools.js", may >= 0 && wrap > may)
  const meta = fs.readFileSync(new URL("../meta.js", import.meta.url), "utf8")
  ok("meta uses fanoutWaitMs", /fanoutWaitMs\(/.test(meta))
  const agent = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  ok("runAgent passes tier into resolveEffort", /resolveEffort\([^)]*tier:\s*resProfile\.tier/.test(agent) || /resolveEffort\(profile,\s*task,\s*\{\s*tier:/.test(agent))
  ok("assumeYes is still not auto-flipped", /assumeYes:\s*config\.tools\?\.assumeYes === true/.test(agent) && !/assumeYes:\s*true/.test(agent) && !/assumeYes:\s*autonomous/.test(agent))
}

console.log("== package version ==")
{
  eq("VERSION is 67.0.0", VERSION, "67.0.0")
  eq("package.json is 67.0.0", JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version, "67.0.0")
}

console.log(`\n== v27 suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
