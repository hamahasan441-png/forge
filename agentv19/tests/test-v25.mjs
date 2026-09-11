#!/usr/bin/env node
/**
 * forge — v25 unbounded autonomous execution.
 *
 * Operational budgets are raised so the agent can finish real work. Safety
 * is not: block-class, outside-project rm, sudo, metadata, apt-get, npm
 * publish, and the project-config privilege strip stay exactly as they were.
 *
 *   B-1  default budgets (steps / timeout / segments / tool calls) raised
 *   B-2  privileged tools.* flags stay false; project config cannot set them
 *   IE-1 classifyCommand still marks node -e / python -c danger without the flag
 *   IE-2 modelMayRun still refuses eval without consent; allowInterpreterEval allows it
 *   AG-1 autonomous allows in-project git reset --hard / clean / checkout -f
 *   AG-2 autonomous still refuses push, filter-branch, outside rm, sudo, publish, apt, metadata
 *   AG-3 assumeYes is still required for those refused danger commands
 *   BK-1 block-class (rm -rf /, mkfs, fork bomb, shutdown) stays refused even with autonomous+assumeYes
 *   RB-1 bash timeout cap is 900s; a 2s context still times out at 2s
 *   XF-1 CODE_DANGER (python os.system rm -rf /) stays refused with eval+autonomous
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v25-"))
const HOME = path.join(ROOT, "home")
const FORGE = path.join(HOME, ".forge")
const PROJ = path.join(ROOT, "proj")
const OUTSIDE = path.join(ROOT, "outside")
for (const d of [HOME, FORGE, PROJ, OUTSIDE]) fs.mkdirSync(d, { recursive: true })
process.env.FORGE_HOME = FORGE
process.chdir(PROJ)

const { classifyCommand, modelMayRun, autonomousWorkAllowed } = await import("../forge/shellguard.js")
const { defaultConfig, sanitizeProjectConfig, AGENT_BUDGETS } = await import("../forge/config.js")
const { makeToolContext } = await import("../forge/tools.js")
const { strategyFor, TASK_CLASS } = await import("../forge/classify.js")
const { VERSION } = await import("../forge/version.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}

const ctx = { cwd: PROJ, root: PROJ, home: HOME }

console.log("== B-1 default budgets raised ==")
{
  const d = defaultConfig()
  ok("AGENT_BUDGETS.maxSteps is 80", AGENT_BUDGETS.maxSteps === 80)
  ok("AGENT_BUDGETS.timeoutSec is 180", AGENT_BUDGETS.timeoutSec === 180)
  ok("AGENT_BUDGETS.segmentSteps is 32", AGENT_BUDGETS.segmentSteps === 32)
  ok("AGENT_BUDGETS.maxSegments is 80", AGENT_BUDGETS.maxSegments === 80)
  ok("AGENT_BUDGETS.maxToolCalls is 250", AGENT_BUDGETS.maxToolCalls === 250)
  ok("AGENT_BUDGETS.maxContinuations is 12", AGENT_BUDGETS.maxContinuations === 12)
  ok("AGENT_BUDGETS.bashTimeoutCapSec is 900", AGENT_BUDGETS.bashTimeoutCapSec === 900)
  ok("defaultConfig uses AGENT_BUDGETS.maxSteps", d.agent.maxSteps === AGENT_BUDGETS.maxSteps)
  ok("defaultConfig uses AGENT_BUDGETS.timeoutSec", d.agent.timeoutSec === AGENT_BUDGETS.timeoutSec)
  ok("defaultConfig uses AGENT_BUDGETS.segmentSteps", d.agent.segmentSteps === AGENT_BUDGETS.segmentSteps)
  ok("defaultConfig uses AGENT_BUDGETS.maxSegments", d.agent.maxSegments === AGENT_BUDGETS.maxSegments)
  ok("defaultConfig uses AGENT_BUDGETS.maxContinuations", d.agent.maxContinuations === AGENT_BUDGETS.maxContinuations)
  ok("budgets beat v24 stalls (25/45/12/40/80)", d.agent.maxSteps > 25 && d.agent.timeoutSec > 45 && d.agent.segmentSteps > 12 && d.agent.maxSegments > 40 && d.agent.maxToolCalls > 80)
  ok("MICRO class fuse raised past 3", strategyFor(TASK_CLASS.MICRO).maxSegments >= 8)
  ok("LARGE class fuse raised past 40", strategyFor(TASK_CLASS.LARGE).maxSegments >= 80)
  ok("ARCH class fuse raised past 60", strategyFor(TASK_CLASS.ARCHITECTURAL).maxSegments >= 120)
}

console.log("== B-2 privileged flags stay false; project config cannot set them ==")
{
  const d = defaultConfig()
  ok("assumeYes stays false", d.tools.assumeYes === false)
  ok("allowSudo stays false", d.tools.allowSudo === false)
  ok("allowInterpreterEval stays false", d.tools.allowInterpreterEval === false)
  ok("allowOutsideProject stays false", d.tools.allowOutsideProject === false)
  ok("fetchPrivateUrls stays false", d.tools.fetchPrivateUrls === false)
  ok("allowNetworkUpload stays false", d.tools.allowNetworkUpload === false)
  const evil = { tools: { allowSudo: true, assumeYes: true, allowOutsideProject: true, fetchPrivateUrls: true, allowNetworkUpload: true, allowInterpreterEval: true, allowNewPlugins: true } }
  const { cfg, dropped } = sanitizeProjectConfig(evil)
  ok("dropped assumeYes", dropped.includes("tools.assumeYes"))
  ok("dropped allowSudo", dropped.includes("tools.allowSudo"))
  ok("dropped allowInterpreterEval", dropped.includes("tools.allowInterpreterEval"))
  ok("keys do not survive", !("assumeYes" in (cfg.tools || {})) && !("allowSudo" in (cfg.tools || {})) && !("allowInterpreterEval" in (cfg.tools || {})))
}

console.log("== IE-1 / IE-2 interpreter eval still needs the flag at the classifier ==")
{
  ok("python3 -c is danger without flag", classifyCommand('python3 -c "print(1)"', ctx).level === "danger")
  ok("node -e is danger without flag", classifyCommand('node -e "console.log(1)"', ctx).level === "danger")
  ok("model refused without consent", modelMayRun('node -e "console.log(1)"', ctx).ok === false)
  ok("autonomous alone does NOT grant eval", modelMayRun('node -e "console.log(1)"', ctx, { autonomous: true }).ok === false)
  ok("allowInterpreterEval grants eval", modelMayRun('node -e "console.log(1)"', ctx, { allowInterpreterEval: true }).ok === true)
  ok("script file stays allowed", modelMayRun("node ./scripts/build.js", ctx).ok === true)
  ok("consent restores classify to low", classifyCommand('python3 -c "print(1)"', { ...ctx, allowInterpreterEval: true }).level === "low")
}

console.log("== AG-1 autonomous in-project git danger ==")
{
  const hard = "git reset --hard HEAD"
  ok("git reset --hard classifies danger", classifyCommand(hard, ctx).level === "danger")
  ok("model refused without autonomous/assumeYes", modelMayRun(hard, ctx).ok === false)
  ok("autonomous allows in-project git reset --hard", modelMayRun(hard, ctx, { autonomous: true }).ok === true)
  ok("autonomous allows git clean -fd", modelMayRun("git clean -fd", ctx, { autonomous: true }).ok === true)
  ok("autonomous allows git checkout -f -- file", modelMayRun("git checkout -f -- src/a.js", ctx, { autonomous: true }).ok === true)
  ok("autonomousWorkAllowed: reset --hard", autonomousWorkAllowed(classifyCommand(hard, ctx), ctx, hard) === true)
  ok("plain git status still safe", modelMayRun("git status", ctx).ok === true && classifyCommand("git status", ctx).level === "safe")
}

console.log("== AG-2 / AG-3 autonomous does NOT grant privilege / publish / outside ==")
{
  const auto = { autonomous: true }
  ok("refused: git push --force", modelMayRun("git push --force origin main", ctx, auto).ok === false)
  ok("refused: git push", modelMayRun("git push", ctx, auto).ok === false)
  ok("refused: git filter-branch", modelMayRun("git filter-branch -- --all", ctx, auto).ok === false)
  ok("refused: outside rm", modelMayRun(`rm -rf ${OUTSIDE}`, ctx, auto).ok === false)
  ok("refused: sudo ls", modelMayRun("sudo ls", ctx, auto).ok === false)
  ok("refused: apt-get install", modelMayRun("apt-get install foo", ctx, auto).ok === false)
  ok("refused: npm publish", modelMayRun("npm publish", ctx, auto).ok === false)
  ok("refused: npm install -g", modelMayRun("npm install -g evil", ctx, auto).ok === false)
  ok("refused: metadata curl", modelMayRun("curl http://169.254.169.254/latest/meta-data/", ctx, auto).ok === false)
  ok("in-project rm still allowed (confirm)", modelMayRun("rm -rf node_modules", ctx, auto).ok === true)
  ok("assumeYes still permits sudo (existing nuclear opt-in)", modelMayRun("sudo ls", ctx, { assumeYes: true }).ok === true)
  ok("allowSudo still permits sudo", modelMayRun("sudo ls", ctx, { allowSudo: true }).ok === true)
}

console.log("== BK-1 block-class never runs, even with every opt-in ==")
{
  const all = { autonomous: true, assumeYes: true, allowSudo: true, allowInterpreterEval: true }
  for (const cmd of ["rm -rf /", "mkfs.ext4 /dev/sda", ":(){ :|:& };:", "shutdown -h now", "dd if=/dev/zero of=/dev/sda"]) {
    ok(`still blocked: ${cmd}`, modelMayRun(cmd, ctx, all).ok === false, JSON.stringify(modelMayRun(cmd, ctx, all)))
  }
}

console.log("== XF-1 CODE_DANGER still fires with eval + autonomous ==")
{
  const cmd = 'python3 -c "import os; os.system(\'rm -rf /\')"'
  ok("CODE_DANGER still danger with consent", classifyCommand(cmd, { ...ctx, allowInterpreterEval: true }).level === "danger")
  ok("model refused with eval+autonomous", modelMayRun(cmd, ctx, { allowInterpreterEval: true, autonomous: true }).ok === false)
}

console.log("== RB-1 timeout cap + real eval execution ==")
{
  const { exec } = makeToolContext({
    cwd: PROJ, root: PROJ, maxToolOutput: 2000, timeoutSec: 2,
    allowInterpreterEval: true, autonomous: true,
  })
  const r = await exec("bash", { command: 'node -e "process.stdout.write(\'v25-eval-ok\')"' })
  ok("autonomous context runs node -e", /v25-eval-ok/.test(r), r.slice(0, 200))
  const blocked = await exec("bash", { command: "rm -rf /" })
  ok("same context still blocks rm -rf /", /BLOCKED/.test(blocked), blocked.slice(0, 200))
  const src = fs.readFileSync(new URL("../forge/tools.js", import.meta.url), "utf8")
  ok("runBash uses AGENT_BUDGETS.bashTimeoutCapSec", /AGENT_BUDGETS\.bashTimeoutCapSec/.test(src) && !/Math\.min\(300,/.test(src))
}

console.log("== runAgent never auto-flips assumeYes ==")
{
  const src = fs.readFileSync(new URL("../forge/agent.js", import.meta.url), "utf8")
  ok("assumeYes is still config.tools.assumeYes === true", /assumeYes:\s*config\.tools\?\.assumeYes === true/.test(src))
  ok("autonomous does not assign assumeYes true", !/assumeYes:\s*true/.test(src) && !/assumeYes:\s*autonomous/.test(src))
  ok("allowInterpreterEval ORs autonomous", /allowInterpreterEval:\s*config\.tools\?\.allowInterpreterEval === true \|\| autonomous/.test(src))
}

console.log("== package version ==")
ok("VERSION is 53.0.0", VERSION === "53.0.0")
ok("package.json is 53.0.0", JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8")).version === "53.0.0")

console.log(`\n== v25 suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
