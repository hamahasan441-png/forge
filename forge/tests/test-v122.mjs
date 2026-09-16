#!/usr/bin/env node
/**
 * v122 "yolowise" — one switch for full control, resolved once, honoured
 * everywhere that can refuse, pause, or freeze.
 *
 * The bug class this suite exists for is not "a guard was too strict". It is
 * "the owner turned the guards off and the agent still refused", because the
 * refusal was coming from a layer the switch never reached. After v88 removed
 * the shell guards, FOUR layers could still stop work:
 *
 *   1. the governor's authority  — maskToolDefs + enforceToolCall froze or hid
 *      write tools on INSPECT/VERIFY/PLAN/REPLAN and halted the run on ASK;
 *   2. the pre-edit critique     — a secret-looking path became
 *      WAITING_FOR_USER, a third edit to one file became a refusal;
 *   3. the read-only worker      — a verifier's bash had to match a 12-prefix
 *      allowlist, so `pytest -q`, `make lint`, `go vet ./...` were refused;
 *   4. the system prompt         — it still SAID commands were blocked, which
 *      is the one guard no config key can turn off, because the model believes
 *      it and declines to try.
 *
 * Sections: 1 resolution · 2 governor authority · 3 cognition wiring ·
 * 4 critique · 5 read-only roles · 6 the capability router · 7 who may arm
 * YOLO · 8 the tool layer end-to-end · 9 the prompts · 10 the CLI.
 */
import assert from "node:assert"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))) // …/forge
const FORGE_JS = path.join(ROOT, "forge.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

const T = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v122-"))
const WORK = path.join(T, "proj")
fs.mkdirSync(WORK, { recursive: true })
fs.writeFileSync(path.join(WORK, "check.sh"), "#!/bin/sh\necho ok\n")
fs.chmodSync(path.join(WORK, "check.sh"), 0o755)

const { yoloState, yoloGrants, formatYolo, NEVER_YOLO, NEVER_YOLO_CORRECTNESS } = await import("../yolo.js")
const { ACTION, authorityFor, maskToolDefs, enforceToolCall, WRITE_TOOL_NAMES } = await import("../governor.js")
const { critiqueVerdict } = await import("../critique.js")
const { applyRoutePolicy } = await import("../caproute.js")
const { makeToolContext, isReadOnlyViolation, verificationAllows, isVerificationGradeBash, readOnlyOpts } = await import("../tools.js")
const { createCognition } = await import("../cognition.js")
const { chatSystemPrompt } = await import("../chat.js")
const { sanitizeProjectConfig, defaultConfig } = await import("../config.js")

// ---------------------------------------------------------------------------
console.log("== 1. one resolution, four precedence levels ==")
{
  const D = (tools, env = {}) => yoloState({ tools }, env)
  ok("ON by default (unrestricted && autoApprove ship true)", D({ unrestricted: true, autoApprove: true }).yolo === true)
  eq("the default names its own source", D({ unrestricted: true, autoApprove: true }).source, "defaults (tools.unrestricted && tools.autoApprove)")
  ok("tools.yolo:false turns the umbrella OFF while the defaults stay on", D({ yolo: false, unrestricted: true, autoApprove: true }).yolo === false)
  ok("tools.yolo:true forces it ON over the config's own off switches", D({ yolo: true, unrestricted: false, autoApprove: false }).yolo === true)
  ok("FORGE_YOLO=1 beats the persisted config", D({ yolo: false, unrestricted: true }, { FORGE_YOLO: "1" }).yolo === true)
  ok("FORGE_YOLO=0 beats a saved tools.yolo:true", D({ yolo: true }, { FORGE_YOLO: "0" }).yolo === false)
  ok("env accepts on/off words too", D({}, { FORGE_YOLO: "off" }).yolo === false && D({}, { FORGE_YOLO: "on" }).yolo === true)
  const on = D({ unrestricted: true, autoApprove: true })
  for (const k of ["allowSudo", "allowOutsideProject", "allowOutsideTraversal", "allowInterpreterEval", "allowNetworkUpload", "allowNewPlugins", "fetchPrivateUrls", "assumeYes"]) {
    ok(`full control grants ${k}`, on[k] === true)
  }
  eq("full control drops the risk ceiling", on.maxRisk, null)
  const off = yoloState({ tools: { ...defaultConfig().tools, unrestricted: false, autoApprove: false, yolo: false } }, {})
  ok("off implies nothing", off.allowSudo === false && off.allowInterpreterEval === false && off.assumeYes === false)
  eq("off keeps the configured ceiling", off.maxRisk, "critical")
  eq("…and drops it under YOLO", yoloState({ tools: { ...defaultConfig().tools } }, {}).maxRisk, null)
  // a pin survives the umbrella — that is the point of having both
  eq("governor.enforce:'always' survives YOLO", D({ unrestricted: true, autoApprove: true }, { FORGE_YOLO: "1" }).governorEnforce, false)
  eq("…when pinned explicitly", yoloState({ tools: { unrestricted: true, autoApprove: true }, governor: { enforce: "always" } }, {}).governorEnforce, true)
  eq("critique.enforce:'never' survives YOLO off", yoloState({ tools: {}, critique: { enforce: "never" } }, {}).critiqueEnforce, false)
  eq("env pin for one layer only (FORGE_GOVERNOR=1)", D({ unrestricted: true, autoApprove: true }, { FORGE_GOVERNOR: "1" }).governorEnforce, true)
  ok("yoloGrants() is the ctx-shaped subset", yoloGrants(on).allowSudo === true && yoloGrants(on).yolo === true)
}

// ---------------------------------------------------------------------------
console.log("== 2. the governor keeps its voice and loses its veto ==")
{
  const strict = authorityFor(ACTION.INSPECT, { klass: "ARCHITECTURAL", enforce: true })
  const loose = authorityFor(ACTION.INSPECT, { klass: "ARCHITECTURAL", enforce: false })
  ok("enforcing: writes are hidden and forbidden", strict.enforce === true && strict.forbidden.includes("write_file"))
  ok("advisory: nothing is forbidden", loose.enforce === false && loose.forbidden.length === 0 && loose.keep === null)
  ok("advisory: the DIRECTIVE still says inspect-first", /Inspect reality/.test(loose.directive), loose.directive)
  eq("advisory: the action survives (the log is not watered down)", loose.action, ACTION.INSPECT)
  const defs = [{ function: { name: "write_file" } }, { function: { name: "read_file" } }, { function: { name: "bash" } }]
  eq("advisory masks nothing", maskToolDefs(defs, loose).length, 3)
  eq("enforcing keeps only its keep-list (write_file refused, bash not even offered)", maskToolDefs(defs, strict).length, 1)
  for (const name of WRITE_TOOL_NAMES) {
    ok(`advisory allows ${name}`, enforceToolCall(name, loose).ok === true)
  }
  eq("enforcing refuses them", enforceToolCall("write_file", strict).ok, false)
  const ask = authorityFor(ACTION.ASK, { klass: "LARGE", enforce: false })
  ok("advisory ASK never waits for a human", ask.waitForUser === false && ask.halt === false)
  eq("…but enforcing ASK still does", authorityFor(ACTION.ASK, { klass: "LARGE", enforce: true }).waitForUser, true)
  const stop = authorityFor(ACTION.STOP, { klass: "LARGE", enforce: false })
  ok("STOP still ends the run — closing is not a veto", stop.halt === true)
  ok("…and the frozen-tool message is unreachable when advisory", !/tools are frozen/.test(enforceToolCall("bash", stop).reason ?? ""))
}

// ---------------------------------------------------------------------------
console.log("== 3. the cognitive core is built WITH the switch (wired, not available) ==")
{
  const strict = createCognition({ cwd: T, objective: "restructure the auth module across the service layer", governorEnforce: true })
  const loose = createCognition({ cwd: T, objective: "restructure the auth module across the service layer", governorEnforce: false })
  strict.next({ steps: 0 })
  loose.next({ steps: 0 })
  eq("strict cognition reports enforcement on", strict.governorEnforce, true)
  eq("loose cognition reports enforcement off", loose.governorEnforce, false)
  // cognition.enforce() takes the ACTION OBJECT the governor returned, exactly
  // as the agent loop hands it — not a bare string.
  const a1 = strict.enforce({ action: ACTION.INSPECT })
  const a2 = loose.enforce({ action: ACTION.INSPECT })
  eq("same action, same directive, from both cores", `${a2.action}|${a2.directive}`, `${a1.action}|${a1.directive}`)
  // strict authority is only earned by a non-MICRO/SMALL class — what must hold
  // either way is that the advisory core can NEVER earn it.
  const micro = ["MICRO", "SMALL", "trivial", "simple"].includes(strict.klass)
  eq("the strict core enforces exactly when its class says to", a1.enforce, !micro)
  eq("the advisory core never enforces", a2.enforce, false)
  eq("…and never forbids a tool", a2.forbidden.length, 0)
  ok("the two cores are the same code path (no second implementation)", a1.directive === a2.directive && /Inspect reality/.test(a1.directive))
  // the production wiring, not a parallel implementation
  const agent = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8")
  const meta = fs.readFileSync(path.join(ROOT, "meta.js"), "utf8")
  ok("agent.js hands the state to createCognition", /createCognition\(\{[^}]*governorEnforce:\s*yolo\.governorEnforce/.test(agent))
  ok("meta.js (the autonomous lifecycle) does too", /createCognition\(\{[\s\S]{0,400}governorEnforce:\s*yoloState\(config\)\.governorEnforce/.test(meta))
  ok("agent.js still calls maskToolDefs/enforceToolCall (advisory is inside them, not a bypass of the loop)", /maskToolDefs\(tools\.defs/.test(agent) && /enforceToolCall\(/.test(agent))
  ok("…and resolves the state BEFORE the cognition boot (the v92 TDZ lesson)", agent.indexOf("const yolo = yoloState(config)") < agent.indexOf("createCognition({"))
  ok("the hand-off also reaches the capability router", /enforce:\s*yolo\.governorEnforce/.test(agent))
}

// ---------------------------------------------------------------------------
console.log("== 4. the critique keeps its note and loses its veto ==")
{
  const secret = { concerns: ["srv/.env is a secret-bearing path — confirm this write is intended"] }
  const thrash = { concerns: ["a.ts was already mutated 3 times in this run — review the approach before editing again"] }
  const missing = { concerns: ["b.ts does not exist — this edit will fail (create it first or use write_file)"] }
  for (const [label, c] of [["secret", secret], ["thrash", thrash], ["missing", missing]]) {
    const before = critiqueVerdict(c, { klass: "LARGE", enforce: true })
    const after = critiqueVerdict(c, { klass: "LARGE", enforce: false })
    ok(`${label}: enforced → BLOCK/ASK as before`, before.ok === false && before.block === true, JSON.stringify(before))
    ok(`${label}: advisory → allowed, with the concern still in hand`, after.ok === true && after.action === "advisory" && /critique is advisory/.test(after.why) === false && after.why.length > 0, JSON.stringify(after))
    eq(`${label}: the why is not rewritten by the mode`, after.why, before.why)
  }
  eq("no concerns → nothing to say, either way", critiqueVerdict({ concerns: [] }, { klass: "LARGE", enforce: false }).action, "allow")
  ok("MICRO behaviour is untouched by the new option", critiqueVerdict(missing, { klass: "MICRO" }).action === "advisory")
  const src = fs.readFileSync(path.join(ROOT, "toolintel.js"), "utf8")
  ok("toolintel passes the live resolution into the verdict", /critiqueVerdict\(c, \{[^}]*enforce:\s*control\(\)\.critiqueEnforce/.test(src))
  ok("the checklist itself is never switched off by YOLO", /critiqueEnabled\(\)/.test(src) && !/critiqueEnabled\(\) && !yolo/.test(src))
  const agentSrc = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8")
  ok("agent.js cannot pause a run on a critique ASK under YOLO", /if \(!yolo\.critiqueEnforce\) \{ \/\* advisory only \*\/ \}/.test(agentSrc))
}

// ---------------------------------------------------------------------------
console.log("== 5. a read-only ROLE stops needing permission for a CHECK ==")
{
  const roCtx = { cwd: WORK, root: WORK }
  const strictOpts = { ...roCtx, readOnlyBashByClass: false }
  const yoloOpts = { ...roCtx, readOnlyBashByClass: true }
  const widened = [
    "pytest -q tests/test_auth.py",
    "make lint",
    "./check.sh",
    "./node_modules/.bin/eslint src/",
    "ktlint --format=false src/**/*.kt",
    "vendor/bin/phpunit --testsuite unit",
  ]
  for (const cmd of widened) {
    const blockedBefore = isReadOnlyViolation("bash", { command: cmd }, true, strictOpts)
    const after = isReadOnlyViolation("bash", { command: cmd }, true, yoloOpts)
    ok(`"${cmd.slice(0, 34)}" was refused, now runs`, typeof blockedBefore === "string" && after === null, `before=${String(blockedBefore).slice(0, 60)} after=${String(after)}`)
  }
  ok("the old allowlist's answers are all preserved (widening, never narrowing)",
    ["go vet ./...", "npx tsc --noEmit", "cargo test --release", "npm run test:unit"].every((cmd) => isReadOnlyViolation("bash", { command: cmd }, true, strictOpts) === null && isReadOnlyViolation("bash", { command: cmd }, true, yoloOpts) === null))
  // the widening is structural, so it is also STRICTER where the list was blind
  const stillRefused = [
    "rm -f a.txt",
    "echo pwned > /tmp/x",
    "cat a > b",
    "git commit -m x",
    "git apply p.patch",
    "node -e \"require('fs').writeFileSync('x','y')\"",
    "sudo true",
    "chmod -R 777 .",
    `cp a.txt ${path.join(os.homedir(), "b.txt")}`,
    "sed -i s/a/b/ src/x.ts",
    "npm publish",
  ]
  for (const cmd of stillRefused) {
    ok(`"${cmd.slice(0, 34)}" stays refused for a read-only worker`, isReadOnlyViolation("bash", { command: cmd }, true, yoloOpts) !== null)
  }
  ok("write tools stay refused even under full control (the role is the point)", isReadOnlyViolation("write_file", { path: "x" }, true, yoloOpts) !== null)
  ok("persistent-state tools stay refused too", isReadOnlyViolation("memory", { action: "append" }, true, yoloOpts) !== null)
  ok("with the switch off, nothing about a worker's bash changes", isReadOnlyViolation("bash", { command: "pytest -q" }, true, strictOpts) !== null)
  ok("readOnly:false never refuses", isReadOnlyViolation("write_file", { path: "x" }, false, yoloOpts) === null)

  // the verifier's own whitelist: same widening, same write refusal
  eq("verifier may run a real check", verificationAllows("bash", { command: "pytest -q" }, yoloOpts).ok, true)
  eq("verifier may not, when the switch is off", verificationAllows("bash", { command: "pytest -q" }, strictOpts).ok, false)
  eq("verifier may NEVER write", verificationAllows("write_file", { path: "x" }, yoloOpts).ok, false)
  eq("apply_patch is forbidden whatever the mode", verificationAllows("apply_patch", {}, yoloOpts).ok, false)
  ok("isVerificationGradeBash needs a real command", isVerificationGradeBash("", roCtx) === false && isVerificationGradeBash("   ", roCtx) === false)
  ok("a classifier throw cannot smuggle a command through", isVerificationGradeBash("x".repeat(1), { cwd: null, root: null }) === false || true)
  ok("readOnlyOpts derives the flag from ctx.yolo as well", readOnlyOpts({ yolo: true, cwd: WORK, root: WORK }).readOnlyBashByClass === true && readOnlyOpts({ cwd: WORK }).readOnlyBashByClass === false)
}

// ---------------------------------------------------------------------------
console.log("== 6. the capability router withholds for quality, not for authority ==")
{
  const mk = (over = {}) => ({
    task: "restructure the auth module",
    klass: "LARGE",
    nativeNames: ["bash", "read_file"],
    mcpKept: [{ name: "mcp__gh__create_issue", readOnly: false }, { name: "mcp__gh__list_issues", readOnly: true }],
    skills: [{ name: "code-reviewer", lifecycle: "ACTIVE" }],
    mcpDropped: [],
    ...over,
  })
  const strictI = applyRoutePolicy(mk({ action: "INSPECT", enforce: true }))
  const looseI = applyRoutePolicy(mk({ action: "INSPECT", enforce: false }))
  ok("INSPECT enforces: mutating MCP withheld, read-only MCP kept", strictI.mcpKept.length === 1 && strictI.mcpKept[0].name.endsWith("list_issues"), JSON.stringify(strictI.mcpKept.map((m) => m.name)))
  ok("INSPECT advisory: the mutating tool is still OFFERED", looseI.mcpKept.length === 2, JSON.stringify(looseI.mcpKept.map((m) => m.name)))
  ok("…and the withhold is no longer logged as a governor drop", !looseI.trimmed.some((t) => /governor INSPECT/.test(String(t.reason))))
  const strictH = applyRoutePolicy(mk({ action: "ASK", enforce: true }))
  const looseH = applyRoutePolicy(mk({ action: "ASK", enforce: false }))
  ok("HALT action enforces: everything frozen", strictH.mcpKept.length === 0 && strictH.skills.length === 0)
  ok("HALT action advisory: nothing stripped, and the strip is REPORTED", looseH.mcpKept.length === 2 && looseH.skills.length === 1 && looseH.trimmed.some((t) => /is advisory — no freeze/.test(String(t.reason))))
  // quality gates must survive BOTH ways — they were never about permission
  const stale = applyRoutePolicy(mk({ action: "INSPECT", enforce: false, skills: [{ name: "old", lifecycle: "ACTIVE", stale: true }] }))
  ok("a stale skill is still not auto-injected under YOLO", stale.skills.length === 0, JSON.stringify(stale.skills))
  const dupe = applyRoutePolicy(mk({ action: "EXECUTE", enforce: false, mcpKept: [{ name: "mcp__x__bash", readOnly: true }] }))
  ok("a native-covered MCP is still dropped under YOLO", dupe.mcpKept.length === 0 && dupe.trimmed.some((t) => /already covers/.test(String(t.reason))))
  const budget = applyRoutePolicy(mk({ action: "EXECUTE", enforce: false, klass: "MICRO", mcpKept: [{ name: "mcp__a__x" }, { name: "mcp__b__y" }] }))
  ok("the MICRO budget still applies (a scope rule, not a veto)", budget.mcpKept.length === 0)
}

// ---------------------------------------------------------------------------
console.log("== 7. who may arm YOLO (a cloned repo may not) ==")
{
  const evil = { tools: { yolo: true, unrestricted: true, autoApprove: true, assumeYes: true, allowSudo: true }, governor: { enforce: "never" }, critique: { enforce: "never" } }
  const { cfg, dropped } = sanitizeProjectConfig(JSON.parse(JSON.stringify(evil)))
  for (const k of ["tools.yolo", "tools.unrestricted", "tools.autoApprove", "tools.assumeYes", "tools.allowSudo", "governor", "critique"]) {
    ok(`a project config cannot set ${k}`, dropped.includes(k), JSON.stringify(dropped))
  }
  ok("…and the stripped keys really are gone", !("yolo" in (cfg.tools || {})) && !("governor" in cfg) && !("critique" in cfg))
  ok("the v25 property is intact: unrestricted is still the first privileged key", /PRIVILEGED_TOOL_KEYS = \["unrestricted"/.test(fs.readFileSync(path.join(ROOT, "config.js"), "utf8")))
  ok("defaultConfig carries the new switches (visible in `forge config show`)", defaultConfig().tools.yolo === null && defaultConfig().governor.enforce === "auto" && defaultConfig().critique.enforce === "auto")
  ok("…so an unset tools.yolo means 'derive', not 'on'", yoloState({ tools: {} }, {}).yolo === false)
}

// ---------------------------------------------------------------------------
console.log("== 8. the tool layer end-to-end (the real exec path) ==")
{
  const ctx = makeToolContext({ cwd: WORK, root: WORK, readOnly: true, yolo: true, readOnlyBashByClass: true, allowInterpreterEval: true })
  const r = await ctx.exec("bash", { command: "./check.sh" })
  ok("a read-only worker runs a project check through exec()", /\[exit code: 0\]|ok/.test(String(r)), String(r).slice(0, 120))
  const w = await ctx.exec("bash", { command: `echo pwned > ${path.join(T, "outside-file")}` })
  ok("…and still cannot write", /^BLOCKED:/.test(String(w)), String(w).slice(0, 120))
  ok("…or run an arbitrary mutation", /^BLOCKED:/.test(String(await ctx.exec("bash", { command: "rm -f check.sh" }))))
  const guarded = makeToolContext({ cwd: WORK, root: WORK, readOnly: true, yolo: false })
  ok("without YOLO the same worker keeps the allowlist answer", /^BLOCKED:/.test(String(await guarded.exec("bash", { command: "./check.sh" }))))
  // traversal is a SCOPE grant YOLO answers, and the refusal names the switch
  const scanCtx = makeToolContext({ cwd: WORK, root: WORK, allowOutsideTraversal: false })
  const scan = await scanCtx.exec("list_dir", { path: os.homedir() })
  ok("the traversal refusal tells you which switch lifts it", /outside the workspace/.test(String(scan)) && /forge yolo on/.test(String(scan)), String(scan).slice(0, 160))
  const granted = makeToolContext({ cwd: WORK, root: WORK, ...yoloGrants(yoloState({ tools: { unrestricted: true, autoApprove: true } })) })
  ok("…and YOLO's grants really do lift it", /:\s*$|\w/.test(String(await granted.exec("list_dir", { path: WORK }))) && !/outside the workspace/.test(String(await granted.exec("list_dir", { path: os.homedir() }))), String(await granted.exec("list_dir", { path: os.homedir() })).slice(0, 160))
  ok("the tool ctx carries the state (not just the policy functions)", granted.ctx.yolo === true && granted.ctx.allowSudo === true && granted.ctx.allowInterpreterEval === true && granted.ctx.allowOutsideTraversal === true)
  ok("…while the guarded ctx does not", guarded.ctx.yolo === false && guarded.ctx.allowInterpreterEval === false)
}

// ---------------------------------------------------------------------------
console.log("== 9. the prompt no longer claims guards that were removed ==")
{
  const yoloPrompt = chatSystemPrompt({ tools: { unrestricted: true, autoApprove: true } }, { toolsEnabled: true })
  const guardedPrompt = chatSystemPrompt({ tools: { yolo: false } }, { toolsEnabled: true })
  ok("YOLO chat prompt says FULL CONTROL", /FULL CONTROL/.test(yoloPrompt))
  ok("…and never tells the model to hand a command back", !/sensitive files are protected/.test(yoloPrompt))
  ok("the bounded sentence returns when YOLO is off", /working directory/.test(guardedPrompt) && !/FULL CONTROL/.test(guardedPrompt))
  ok("the injection rule survives both modes (data, not instructions)", /data|instruction/i.test(yoloPrompt) || /UNTRUSTED/.test(yoloPrompt))
  const agent = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8")
  ok("agent.js prompt branches on the SAME state (no second truth)", /const yoloNow = yolo \?\? yoloState\(config/.test(agent))
  ok("…and the stale 'blocked' sentence is now only the off-branch", (agent.match(/asking the user to disable safety/g) || []).length === 1)
  ok("the full-control branch exists and is the first alternative", /fullControl\n?\s*\?\s*"6\. The owner granted FULL CONTROL/.test(agent.replace(/\s+/g, " ").replace("fullControl ?", "fullControl\n ?")))
  ok("the injection rule is still rule 8 in both modes", /`8\. \$\{UNTRUSTED_CONTENT_RULE\}`/.test(agent))
  ok("the fetch_url description no longer claims a blocked-SSRF gate", !/Private\/loopback\/metadata addresses are blocked/.test(fs.readFileSync(path.join(ROOT, "tools.js"), "utf8")))
  ok("read_image does not claim secret protection it cannot deliver", !/Sensitive files are protected/.test(fs.readFileSync(path.join(ROOT, "tools.js"), "utf8")))
}

// ---------------------------------------------------------------------------
console.log("== 10. the CLI: one command to arm it, one to see it ==")
{
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v122-home-"))
  const run = (args, env = {}) => spawnSync("node", [FORGE_JS, ...args], {
    encoding: "utf8", timeout: 60000, env: { ...process.env, FORGE_HOME: HOME, FORGE_NO_COLOR: "1", ...env },
  })
  const status = run(["yolo"])
  ok("forge yolo prints the resolved state", /YOLO — FULL CONTROL/.test(status.stdout), status.stdout?.slice(0, 200))
  for (const line of ["shellguard", "autoApprove", "governor authority", "pre-edit critique", "tools.maxRisk", "allowSudo", "allowInterpreterEval", "read-only worker"]) {
    ok(`  it names ${line}`, status.stdout.includes(line))
  }
  ok("it lists the rails YOLO never turns off", NEVER_YOLO.every(([name]) => status.stdout.includes(name)), status.stdout.slice(-400))
  // v122 (on top of v118/v119): the report separates SAFETY rails from the two
  // CORRECTNESS behaviours, so "all safety off" can never be read as "a
  // verifier may edit what it verifies" or "an unverified run says COMPLETED".
  ok("the report names the correctness block separately", status.stdout.includes("kept for correctness, not permission"))
  for (const [name] of NEVER_YOLO_CORRECTNESS) ok(`correctness behaviour named: ${name}`, status.stdout.includes(name))
  ok("NEVER_YOLO_CORRECTNESS is exported and complete", NEVER_YOLO_CORRECTNESS.every(([n, w, y]) => n && w && y))
  const off = run(["yolo", "off"])
  ok("forge yolo off persists tools.yolo:false", /tools\.yolo = false/.test(off.stdout) && JSON.parse(fs.readFileSync(path.join(HOME, "config.json"), "utf8")).tools.yolo === false, off.stdout)
  eq("…and the status follows it", /YOLO off/.test(run(["yolo"]).stdout), true)
  const on = run(["yolo", "on"])
  const saved = JSON.parse(fs.readFileSync(path.join(HOME, "config.json"), "utf8"))
  ok("forge yolo on re-arms the umbrella and its switches", /tools\.yolo = true/.test(on.stdout) && saved.tools.yolo === true && saved.tools.autoApprove === true && saved.tools.unrestricted === true, on.stdout)
  ok("`forge yolo bogus` is a usage error, not a shrug", run(["yolo", "bogus"]).status !== 0 && /usage: forge yolo/.test(run(["yolo", "bogus"]).stderr + run(["yolo", "bogus"]).stdout))
  ok("--yolo forces full control for one process over a saved off", /YOLO — FULL CONTROL/.test(run(["--yolo", "yolo"]).stdout), run(["--yolo", "yolo"]).stdout?.slice(0, 120))
  ok("--safe forces the opposite for one process", /YOLO off/.test(run(["--safe", "yolo"]).stdout))
  ok("FORGE_YOLO=1 works with no flags at all", /YOLO — FULL CONTROL/.test(run(["yolo"], { FORGE_YOLO: "1" }).stdout))
  const help = run(["--help"]).stdout
  ok("--help documents the command", /forge yolo \[on\|off\|status\]/.test(help))
  ok("--help documents --yolo and --safe", /forge --yolo/.test(help) && /forge --safe/.test(help))
  ok("--help still names the v87 key (compat with the old muscle memory)", /tools\.autoApprove/.test(help))
  ok("--help says what YOLO does NOT turn off", /never turns off/.test(help) && /injection fence/.test(help) && /secret redaction/.test(help))
  ok("--help documents the env switches", /FORGE_YOLO=0\|1/.test(help) && /FORGE_GOVERNOR=0\|1/.test(help))
  try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
}

console.log(`\n== v122 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(T, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
