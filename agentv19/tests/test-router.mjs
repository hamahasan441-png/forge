#!/usr/bin/env node
/**
 * forge — tool router checks (v20.5 tool intelligence layer).
 *
 * Covers: task analysis, chain planning (the SMALLEST effective chain),
 * context-aware skipping, constraints, tool selection, execution scheduling
 * (parallel vs serialized + conflict detection), cost awareness and
 * result-aware routing / strategy change.
 *
 * Zero network. Temp dirs only.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  analyzeTask, planChain, route, planExecution, canRunInParallel, conflicts,
  targetsOf, estimateCost, cheaperAlternative, nextAction, repeatedFailures,
  detectTestCommand, describeRoute, toolGuidance, INTENT,
} from "../forge/router.js"
import { createRegistry, defaultRegistry, RISK } from "../forge/capabilities.js"

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }

const reg = defaultRegistry({})
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "forge-router-"))
fs.mkdirSync(path.join(TMP, "src"), { recursive: true })
fs.writeFileSync(path.join(TMP, "src", "auth.js"), "export function generateToken(){ return 1 }\n")
fs.writeFileSync(path.join(TMP, "package.json"), JSON.stringify({ scripts: { test: "node t.js" } }))
const ctx = { cwd: TMP, root: TMP }

console.log("== task analysis (§3) ==")
{
  const a = analyzeTask("Find where authentication tokens are generated")
  ok("discovery intent detected", a.primary === INTENT.DISCOVER)
  ok("no mutation implied", a.mutating === false)
  const b = analyzeTask("Fix the failing authentication test in tests/auth.test.js")
  ok("recovery beats modification", b.primary === INTENT.RECOVER)
  ok("file target extracted", b.files.includes("tests/auth.test.js"))
  const c = analyzeTask("read src/app.js")
  ok("inspection intent", c.primary === INTENT.INSPECT && c.complexity === "simple")
  const d = analyzeTask("rename fetchUser to loadUser across the codebase")
  ok("modification intent", d.primary === INTENT.MODIFY && d.mutating === true)
  ok("camelCase symbols extracted", d.symbols.includes("fetchUser"))
  ok("plain English words are not treated as symbols", !analyzeTask("find where tokens are made").symbols.includes("find"))
  const e = analyzeTask("what is the latest version of the express documentation online")
  ok("research intent needs network", e.primary === INTENT.RESEARCH && e.needsNetwork === true)
}

console.log("== the smallest effective chain (§2) ==")
{
  const simple = planChain("read src/auth.js", { registry: reg, context: { cwd: TMP } })
  ok("a simple read is ONE step", simple.active.length === 1 && simple.active[0].tool === "read_file")
  ok("minimal chain is flagged", simple.minimal === true)
  ok("no write tool sneaks into a read task", !simple.active.some((s) => ["edit_file", "write_file", "apply_patch", "bash"].includes(s.tool)))

  const discover = planChain("Find where authentication tokens are generated", { registry: reg, context: { cwd: TMP } })
  const dTools = discover.active.map((s) => s.tool)
  ok("discovery starts with a search, not a read", dTools[0] === "grep_files")
  ok("discovery ends by reading the located file", dTools[dTools.length - 1] === "read_file")
  ok("discovery NEVER edits", !dTools.some((t) => ["edit_file", "write_file", "apply_patch"].includes(t)))
  ok("the search pattern comes from the task, not the whole sentence", /authentication|tokens/.test(JSON.stringify(discover.active[0].args ?? {})))

  const fix = planChain("Fix the failing authentication test", { registry: reg, context: { cwd: TMP } })
  const fTools = fix.active.map((s) => s.tool)
  const phases = fix.active.map((s) => s.phase)
  ok("recovery chain inspects before it edits", phases.indexOf("inspect") < phases.indexOf("modify"))
  ok("recovery chain locates the implementation", fTools.includes("grep_files"))
  ok("recovery chain edits exactly once", fTools.filter((t) => t === "edit_file").length === 1)
  ok("recovery chain runs a focused test THEN a regression run", phases.indexOf("verify") < phases.indexOf("regress"))
  ok("verification is the last thing that happens", phases[phases.length - 1] === "regress")
}

console.log("== context awareness: do not rediscover what is known (§11) ==")
{
  const cold = planChain("update the retry logic", { registry: reg, context: { cwd: TMP } })
  const warm = planChain("update the retry logic", { registry: reg, context: { cwd: TMP, knownFiles: ["src/auth.js"] } })
  ok("cold start discovers first", cold.active[0].phase === "discover")
  ok("known file skips discovery", warm.active[0].phase !== "discover")
  ok("the skipped step is reported, not silently dropped", warm.steps.some((s) => s.skipped && /already known/i.test(s.why)))
  const read = planChain("read src/auth.js", { registry: reg, context: { cwd: TMP, readFiles: ["src/auth.js"] } })
  ok("an already-read file is not read again", read.active.every((s) => s.tool !== "read_file"))
  const verified = planChain("fix the retry logic in src/auth.js", { registry: reg, context: { cwd: TMP, testsJustPassed: true } })
  ok("tests that just passed are not re-run", !verified.active.some((s) => s.phase === "verify"))
}

console.log("== constraints ==")
{
  const ro = planChain("fix the bug in src/auth.js", { registry: reg, context: { cwd: TMP }, constraints: { readOnly: true } })
  ok("read-only agents get no mutation step", !ro.active.some((s) => ["edit_file", "write_file", "apply_patch"].includes(s.tool)))
  const nonet = planChain("check the latest express documentation online", { registry: reg, context: { cwd: TMP }, constraints: { network: false } })
  ok("network-free constraint drops web steps", !nonet.active.some((s) => ["web_search", "fetch_url"].includes(s.tool)))
  const limited = planChain("read src/auth.js", { registry: reg, context: { cwd: TMP }, constraints: { availableTools: ["grep_files"] } })
  ok("unavailable tools are not selected", limited.active.every((s) => s.tool === null || s.tool === "grep_files"))
  const disabledReg = createRegistry({ config: { tools: { disabled: ["grep_files"] } } })
  const noGrep = planChain("Find where tokens are generated", { registry: disabledReg, context: { cwd: TMP } })
  ok("a disabled tool is never routed to (§19)", !noGrep.active.some((s) => s.tool === "grep_files"))
}

console.log("== route(): the documented contract (§2) ==")
{
  const d = route({ task: "read src/auth.js", registry: reg, context: { cwd: TMP } })
  for (const k of ["selected_tool", "reason", "arguments", "execution_mode", "verification_plan"]) ok(`route() returns ${k}`, k in d)
  ok("selected tool is the cheapest reader", d.selected_tool === "read_file")
  ok("arguments are synthesized from the task", d.arguments.path === "src/auth.js")
  ok("execution mode is parallel for an independent read", d.execution_mode === "parallel")
  ok("reason names the capability and the risk", /capability=file_read/.test(d.reason) && /risk=low/.test(d.reason))
  ok("a read needs no verification", d.verification_plan.required === false)
  ok("the chain is attached", Array.isArray(d.chain.steps))
  ok("describeRoute renders the decision", /selected_tool/.test(describeRoute(d)))

  const w = route({ task: "add a retry helper to src/auth.js", state: { knownFiles: ["src/auth.js"], readFiles: ["src/auth.js"] }, registry: reg, context: { cwd: TMP } })
  ok("with the file already read, the next step is the edit", w.selected_tool === "edit_file")
  ok("a mutation is serialized, not parallel", w.execution_mode === "serial")
  ok("a mutation declares its verification", w.verification_plan.required === true && /syntax/.test(w.verification_plan.summary))

  const capped = route({ task: "add a retry helper to src/auth.js", state: { knownFiles: ["src/auth.js"], readFiles: ["src/auth.js"] }, registry: reg, context: { cwd: TMP }, risk: RISK.LOW })
  ok("a risk ceiling blocks the decision instead of running it", capped.blocked === true && capped.execution_mode === "blocked")
}

console.log("== scheduling: parallel vs serialized (§4, §12) ==")
{
  const calls = [
    { name: "grep_files", args: { pattern: "auth" } },
    { name: "grep_files", args: { pattern: "test" } },
    { name: "grep_files", args: { pattern: "config" } },
  ]
  const p = planExecution(calls, { registry: reg, ctx })
  ok("three independent searches run concurrently", p.parallel.length === 3 && p.serialized.length === 0)

  const mixed = planExecution([
    { name: "read_file", args: { path: "src/auth.js" } },
    { name: "edit_file", args: { path: "a.js", old: "x", new: "y" } },
    { name: "edit_file", args: { path: "b.js", old: "x", new: "y" } },
  ], { registry: reg, ctx })
  ok("reads run in parallel, writes are serialized", mixed.parallel.length === 1 && mixed.serialized.length === 2)
  ok("edit A and edit B are never concurrent", mixed.batches.find((b) => b.mode === "parallel")?.calls.every((c) => c.cls.read_only) !== false)

  const conflict = planExecution([
    { name: "edit_file", args: { path: "same.js", old: "x", new: "y" } },
    { name: "edit_file", args: { path: "same.js", old: "y", new: "z" } },
  ], { registry: reg, ctx })
  ok("conflicting writes to one file are detected", conflict.conflicts.length === 1 && /same target/.test(conflict.conflicts[0].note))

  const afterWrite = planExecution([
    { name: "edit_file", args: { path: "src/auth.js", old: "x", new: "y" } },
    { name: "read_file", args: { path: "src/auth.js" } },
  ], { registry: reg, ctx })
  ok("a read AFTER a write to the same file is serialized (ordering preserved)", afterWrite.parallel.length === 0)

  const beforeWrite = planExecution([
    { name: "read_file", args: { path: "src/auth.js" } },
    { name: "edit_file", args: { path: "src/auth.js", old: "x", new: "y" } },
  ], { registry: reg, ctx })
  ok("a read BEFORE the write still runs in parallel", beforeWrite.parallel.length === 1)

  ok("bash is never parallelized", planExecution([{ name: "bash", args: { command: "ls" } }, { name: "bash", args: { command: "pwd" } }], { registry: reg, ctx }).parallel.length === 0)
  ok("todo/memory (shared state) are not parallelized", planExecution([{ name: "todo", args: { action: "list" } }, { name: "memory", args: { action: "read" } }], { registry: reg, ctx }).parallel.length === 0)

  ok("canRunInParallel: two searches", canRunInParallel({ name: "grep_files", args: { pattern: "a" } }, { name: "glob_files", args: { pattern: "*.js" } }, { registry: reg, ctx }).ok)
  ok("canRunInParallel: read + write is refused", !canRunInParallel({ name: "read_file", args: { path: "a" } }, { name: "edit_file", args: { path: "a" } }, { registry: reg, ctx }).ok)
  ok("canRunInParallel: two writes refused with a reason", (() => { const r = canRunInParallel({ name: "edit_file", args: { path: "a" } }, { name: "edit_file", args: { path: "b" } }, { registry: reg, ctx }); return !r.ok && r.reason.length > 5 })())
  ok("canRunInParallel: read + bash refused (bash can touch anything)", !canRunInParallel({ name: "read_file", args: { path: "a" } }, { name: "bash", args: { command: "ls" } }, { registry: reg, ctx }).ok)

  ok("targetsOf: file tools resolve to absolute paths", targetsOf("read_file", { path: "src/auth.js" }, TMP)[0] === path.join(TMP, "src/auth.js"))
  ok("targetsOf: bash is filesystem-wide", targetsOf("bash", { command: "ls" }, TMP)[0] === "*")
  ok("targetsOf: apply_patch lists every patched file", targetsOf("apply_patch", { patch: "--- a/x.js\n+++ b/x.js\n--- a/y.js\n+++ b/y.js\n" }, TMP).length === 2)
  ok("conflicts(): nested directories overlap", conflicts({ name: "write_file", args: { path: "src/a.js" } }, { name: "grep_files", args: { path: "src" } }, { ctx }).conflict)
}

console.log("== cost awareness (§10) ==")
{
  const big = path.join(TMP, "big.log")
  fs.writeFileSync(big, "x".repeat(400 * 1024))
  const cheap = estimateCost("grep_files", { pattern: "x" }, { registry: reg, ctx })
  const dear = estimateCost("delegate", { task: "investigate" }, { registry: reg, ctx })
  ok("a sub-agent costs more than a search", dear.score > cheap.score)
  ok("cost carries the operation risk", cheap.risk === RISK.LOW)

  const alt = cheaperAlternative("read_file", { path: "big.log" }, { registry: reg, ctx })
  ok("reading a 400KB file unbounded suggests searching first", alt?.tool === "grep_files")
  ok("a bounded read of the same file is fine", cheaperAlternative("read_file", { path: "big.log", limit: 50, offset: 10 }, { registry: reg, ctx }) === null)
  ok("cat via bash suggests read_file", cheaperAlternative("bash", { command: "cat src/auth.js" }, { registry: reg, ctx })?.tool === "read_file")
  ok("grep via bash suggests grep_files", cheaperAlternative("bash", { command: "grep -r token ." }, { registry: reg, ctx })?.tool === "grep_files")
  ok("a one-line question does not need a sub-agent", cheaperAlternative("delegate", { task: "where is the auth middleware" }, { registry: reg, ctx })?.tool === "grep_files")
  ok("npm test is not second-guessed", cheaperAlternative("bash", { command: "npm test" }, { registry: reg, ctx }) === null)
}

console.log("== result-aware routing (§8) ==")
{
  const history = [
    { tool: "read_file", arguments_hash: "aaa", status: "failed", failure: "NOT_FOUND" },
    { tool: "read_file", arguments_hash: "aaa", status: "failed", failure: "NOT_FOUND" },
  ]
  ok("repeatedFailures counts identical failing calls", repeatedFailures(history, { tool: "read_file", argsHash: "aaa" }) === 2)
  const change = nextAction({ task: "read config", history, lastResult: { tool: "read_file", argsHash: "aaa", status: "failed", failure: "NOT_FOUND" }, registry: reg, context: { cwd: TMP } })
  ok("two identical failures force a strategy change", change.changeStrategy === true)
  ok("the alternative is a different tool", change.tool && change.tool !== "read_file")

  const testFail = nextAction({ task: "fix tests", history: [], lastResult: { tool: "bash", failure: "TEST_FAILURE", status: "failed" }, registry: reg, context: { cwd: TMP } })
  ok("a test failure routes to error classification + search, not a blind re-run", testFail.tool === "grep_files")

  const anchor = nextAction({ task: "edit", history: [], lastResult: { tool: "edit_file", failure: "NOT_FOUND", status: "failed" }, registry: reg, context: { cwd: TMP } })
  ok("a missing edit anchor routes back to reading the file", anchor.tool === "read_file" && anchor.changeStrategy)

  const blocked = nextAction({ task: "delete stuff", history: [], lastResult: { tool: "bash", failure: "SAFETY_BLOCK", status: "failed" }, registry: reg, context: { cwd: TMP } })
  ok("a safety block escalates instead of retrying", blocked.escalate === true && blocked.tool === null)

  const afterWrite = nextAction({ task: "add retry", history: [], lastResult: { tool: "edit_file", status: "ok", mutation: true }, registry: reg, context: { cwd: TMP } })
  ok("a successful mutation routes to verification", afterWrite.tool === "bash")
}

console.log("== project-native verification command ==")
{
  ok("npm test is detected from package.json", detectTestCommand(TMP) === "npm test")
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "forge-router-empty-"))
  ok("no command is invented when the project has none", detectTestCommand(empty) === "")
  fs.rmSync(empty, { recursive: true, force: true })
}

console.log("== model-facing guidance is generated from the registry ==")
{
  const g = toolGuidance("fix the failing auth test", { registry: reg, cwd: TMP })
  ok("guidance mentions the capability-first rule", /capability/i.test(g))
  ok("guidance includes the suggested chain", /Suggested chain/.test(g))
  ok("guidance is bounded", g.split("\n").length <= 14)
  const g2 = toolGuidance("anything", { registry: createRegistry({ config: { tools: { disabled: ["web_search"] } } }), cwd: TMP })
  ok("disabled tools are named to the model", /Disabled in this project/.test(g2) && /web_search/.test(g2))
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n== router suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
