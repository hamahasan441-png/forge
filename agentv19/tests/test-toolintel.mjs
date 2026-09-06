#!/usr/bin/env node
/**
 * forge — tool intelligence pipeline checks (v20.5).
 *
 * The end of the chain: capability check → policy gate → EXISTING safety
 * controls → execution → observation → state → verification → repair advice.
 *
 * Covers §6 security integration (nothing is bypassed or weakened), §8
 * result-aware routing, §9 failure classification, §11 caching, §12 parallel
 * execution, §13 verification, §14 idempotency, §15 tool state, §16 events,
 * plus the regression guarantee that turning the layer off restores the exact
 * pre-v20.5 call path.
 *
 * Zero network. Everything runs in a temp project.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createToolIntel, argsHash } from "../forge/toolintel.js"
import { classifyFailure, recoveryPlan, diagnose, formatDiagnosis, shouldEscalate, FAILURE, STRATEGY } from "../forge/diagnose.js"
import { verificationPlan, runVerification, verifyTargets, CHECK } from "../forge/verify.js"
import { createRegistry, RISK, STATUS } from "../forge/capabilities.js"
import { makeToolContext } from "../forge/tools.js"
import { createUIStore, bridgeAgentEvent, createBridgeContext } from "../forge/uistate.js"

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }

function project() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-intel-"))
  fs.writeFileSync(path.join(tmp, "app.js"), "export function hi() { return 1 }\n")
  fs.writeFileSync(path.join(tmp, "data.json"), '{"a":1}\n')
  fs.writeFileSync(path.join(tmp, "notes.txt"), "plain text\n")
  return tmp
}
function realIntel(tmp, opts = {}) {
  const tools = makeToolContext({
    cwd: tmp, root: tmp, timeoutSec: 10, maxToolOutput: 8000,
    memoryPath: path.join(tmp, "memory.md"), todoPath: path.join(tmp, "todo.json"),
    readOnly: opts.readOnly === true,
  })
  const events = []
  const intel = createToolIntel({
    exec: tools.exec,
    ctx: { cwd: tmp, root: tmp, readOnly: opts.readOnly === true },
    config: opts.config ?? {},
    onEvent: (e) => events.push(e),
    runId: "run-test", taskId: "task-test", task: opts.task ?? "test task",
    ...opts.intel,
  })
  return { intel, events, tools }
}

// ---------------------------------------------------------------------------
console.log("== §9 failure classification ==")
{
  const cases = [
    ["ERROR: not found: /tmp/x.js", FAILURE.NOT_FOUND],
    ["ERROR: old string not found in file", FAILURE.NOT_FOUND],
    ["ERROR: EACCES: permission denied, open '/etc/shadow'", FAILURE.PERMISSION_DENIED],
    ["ERROR: empty path", FAILURE.INVALID_ARGUMENT],
    ['ERROR: unknown tool "banana"', FAILURE.INVALID_ARGUMENT],
    ["BLOCKED for safety: rm targets the system root (/)", FAILURE.SAFETY_BLOCK],
    ["BLOCKED: write tools are disabled in this read-only agent", FAILURE.SAFETY_BLOCK],
    ["ERROR: fetch failed", FAILURE.NETWORK_FAILURE],
    ["ERROR: getaddrinfo ENOTFOUND api.example.com", FAILURE.NETWORK_FAILURE],
    ["ERROR: request timed out after 30s", FAILURE.TIMEOUT],
    ["ERROR: Cannot find module 'left-pad'", FAILURE.DEPENDENCY_FAILURE],
    ["ERROR: SyntaxError: Unexpected token '}'", FAILURE.SYNTAX_FAILURE],
    ["ERROR: cancelled — command terminated by user interrupt", FAILURE.CANCELLED],
  ]
  for (const [text, code] of cases) {
    const d = classifyFailure(text, { tool: "read_file" })
    ok(`${code.padEnd(19)} ← ${text.slice(0, 46)}`, d.failed && d.code === code)
  }
  ok("a normal result is not a failure", classifyFailure("OK wrote /tmp/a.js (12 bytes)", { tool: "write_file" }).failed === false)
  ok("an empty search result is not a failure", classifyFailure("(no matches)", { tool: "grep_files" }).failed === false)
  ok("bash exit 1 running tests is TEST_FAILURE", classifyFailure("2 tests failed\n[exit code: 1]", { tool: "bash", args: { command: "npm test" } }).code === FAILURE.TEST_FAILURE)
  ok("bash exit 1 running a build is BUILD_FAILURE", classifyFailure("oh no\n[exit code: 2]", { tool: "bash", args: { command: "npm run build" } }).code === FAILURE.BUILD_FAILURE)
  ok("tsc diagnostics are BUILD_FAILURE", classifyFailure("src/a.ts(3,1): error TS2554: wrong args\n[exit code: 2]", { tool: "bash", args: { command: "tsc -p ." } }).code === FAILURE.BUILD_FAILURE)
  ok("an unrecognized error is UNKNOWN, not a guess", classifyFailure("ERROR: the flux capacitor disagreed", { tool: "bash" }).code === FAILURE.UNKNOWN)
  ok("evidence is captured", classifyFailure("ERROR: not found: /tmp/x.js", { tool: "read_file" }).evidence.includes("/tmp/x.js"))
  ok("transient failures are marked retryable", classifyFailure("ERROR: fetch failed", { tool: "fetch_url" }).retryable === true)
  ok("non-transient failures are not", classifyFailure("ERROR: not found: x", { tool: "read_file" }).retryable === false)
  ok("a thrown error is classified too", classifyFailure(new Error("ETIMEDOUT"), { tool: "bash", thrown: true }).code === FAILURE.TIMEOUT)
}

console.log("== §9 recovery strategy ==")
{
  const t = recoveryPlan(FAILURE.TIMEOUT, { tool: "read_file", idempotent: true, attempts: 0 })
  ok("TIMEOUT: retry once → reduce scope → alternate → escalate", t.strategies.map((s) => s.action).join(",").startsWith(`${STRATEGY.RETRY},${STRATEGY.REDUCE_SCOPE}`))
  const t2 = recoveryPlan(FAILURE.TIMEOUT, { tool: "bash", idempotent: false, attempts: 0 })
  ok("TIMEOUT on a non-idempotent op NEVER suggests a blind retry", !t2.strategies.some((s) => s.action === STRATEGY.RETRY))
  ok("TIMEOUT on a non-idempotent op inspects state first", t2.strategies[0].action === STRATEGY.INSPECT_FIRST)
  ok("SAFETY_BLOCK aborts first and never retries", (() => { const p = recoveryPlan(FAILURE.SAFETY_BLOCK, {}); return p.strategies[0].action === STRATEGY.ABORT && !p.strategies.some((s) => s.action === STRATEGY.RETRY) })())
  ok("PERMISSION_DENIED escalates to a human", recoveryPlan(FAILURE.PERMISSION_DENIED, {}).strategies.some((s) => s.action === STRATEGY.ESCALATE))
  ok("NOT_FOUND inspects instead of guessing again", recoveryPlan(FAILURE.NOT_FOUND, {}).strategies[0].action === STRATEGY.INSPECT_FIRST)
  ok("DEPENDENCY_FAILURE can install, but asks first", (() => { const p = recoveryPlan(FAILURE.DEPENDENCY_FAILURE, {}); return p.strategies.some((s) => s.action === STRATEGY.INSTALL_DEPENDENCY) && p.strategies.some((s) => s.action === STRATEGY.ESCALATE) })())
  ok("TEST_FAILURE reduces scope to the failing test", recoveryPlan(FAILURE.TEST_FAILURE, {}).strategies.some((s) => s.action === STRATEGY.REDUCE_SCOPE))
  ok("diagnose() bundles classification + plan", (() => { const d = diagnose("ERROR: fetch failed", { tool: "fetch_url", idempotent: true }); return d.code === FAILURE.NETWORK_FAILURE && d.plan.strategies.length > 0 })())
  ok("formatDiagnosis is one compact line", (() => { const s = formatDiagnosis(diagnose("ERROR: not found: x", { tool: "read_file" })); return s.startsWith("[forge] failure=NOT_FOUND") && !s.includes("\n") })())
}

console.log("== §13 verification contracts ==")
{
  const tmp = project()
  const p1 = verificationPlan("read_file", { path: "app.js" }, { risk: RISK.LOW, cwd: tmp })
  ok("a read declares no verification", p1.required === false && p1.checks.length === 0)
  const p2 = verificationPlan("edit_file", { path: "app.js", old: "1", new: "2" }, { risk: RISK.MEDIUM, cwd: tmp, meta: { read_only: false, verification_required: true, verify_after: [] } })
  ok("an edit verifies content + syntax", p2.required && p2.checks.some((c) => c.kind === CHECK.CONTENT_APPLIED) && p2.checks.some((c) => c.kind === CHECK.SYNTAX))
  const p3 = verificationPlan("apply_patch", { patch: "--- a/app.js\n+++ b/app.js\n" }, { risk: RISK.HIGH, cwd: tmp, meta: { read_only: false, verification_required: true, verify_after: [] } })
  ok("high risk escalates to a recommended test run", p3.checks.some((c) => c.kind === CHECK.TESTS && c.executor === "agent"))
  ok("verification is proportional to risk", p3.level === "strict" && p2.level === "standard")
  ok("verifyTargets resolves patched files", verifyTargets("apply_patch", { patch: "--- a/x.js\n+++ b/x.js\n" }, tmp)[0] === path.join(tmp, "x.js"))

  // real local checks
  fs.writeFileSync(path.join(tmp, "broken.js"), "export function x( { \n")
  const bad = await runVerification(verificationPlan("write_file", { path: "broken.js" }, { risk: RISK.MEDIUM, cwd: tmp, meta: { read_only: false, verification_required: true } }), { cwd: tmp })
  ok("a syntax error is caught locally", bad.ok === false && /syntax/.test(bad.summary))
  const good = await runVerification(verificationPlan("write_file", { path: "app.js" }, { risk: RISK.MEDIUM, cwd: tmp, meta: { read_only: false, verification_required: true } }), { cwd: tmp })
  ok("valid ESM passes node --check", good.ok === true)
  fs.writeFileSync(path.join(tmp, "bad.json"), "{oops")
  const badJson = await runVerification(verificationPlan("write_file", { path: "bad.json" }, { risk: RISK.MEDIUM, cwd: tmp, meta: { read_only: false, verification_required: true } }), { cwd: tmp })
  ok("invalid JSON is caught", badJson.ok === false)
  const txtPlan = verificationPlan("write_file", { path: "notes.txt" }, { risk: RISK.MEDIUM, cwd: tmp, meta: { read_only: false, verification_required: true } })
  const txt = await runVerification(txtPlan, { cwd: tmp })
  ok("a file type with no local checker is never failed", txt.ok === true && !txtPlan.checks.some((c) => c.kind === CHECK.SYNTAX))
  ok("verification never throws on a missing file", (await runVerification(verificationPlan("write_file", { path: "ghost.js" }, { risk: RISK.MEDIUM, cwd: tmp, meta: { read_only: false, verification_required: true } }), { cwd: tmp })).ok === false)
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log("== §6 security: the existing controls still decide ==")
{
  const tmp = project()
  const { intel, events } = realIntel(tmp)
  const rm = await intel.runCall({ name: "bash", args: { command: "rm -rf /" } })
  ok("ShellGuard still blocks a catastrophic command", rm.result.startsWith("BLOCKED for safety"))
  ok("the block is classified as SAFETY_BLOCK", rm.record.failure === FAILURE.SAFETY_BLOCK)
  ok("a TOOL_BLOCKED event is emitted for the UI", events.some((e) => e.type === "TOOL_BLOCKED" && e.bySafetyControl))
  ok("recovery advice never says 'retry'", !/recovery: retry/.test(rm.result))

  const esc = await intel.runCall({ name: "write_file", args: { path: "../escape.txt", content: "x" } })
  ok("SafePath still blocks writes outside the project", esc.result.startsWith("ERROR: write target escapes the project directory"))

  const ssh = await intel.runCall({ name: "read_file", args: { path: "~/.ssh/id_rsa" } })
  ok("sensitive reads are still blocked", ssh.result.startsWith("BLOCKED"))

  const priv = await intel.runCall({ name: "fetch_url", args: { url: "http://127.0.0.1:1/" } })
  ok("NetGuard still blocks loopback fetches", /BLOCKED|ERROR/.test(priv.result))

  const secret = await intel.runCall({ name: "bash", args: { command: "echo 'export OPENAI_API_KEY=sk-abcdef0123456789abcdef0123456789'" } })
  ok("secret redaction still applies through the layer", !/sk-abcdef0123456789/.test(secret.result) && /REDACTED|\*\*\*/i.test(secret.result))
  ok("the record never stores the raw secret", !/sk-abcdef0123456789/.test(JSON.stringify(intel.records())))
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log("== policy gate: read-only, disabled tools, risk ceiling ==")
{
  const tmp = project()
  const ro = realIntel(tmp, { readOnly: true })
  const w = await ro.intel.runCall({ name: "write_file", args: { path: "x.txt", content: "y" } })
  ok("read-only agents cannot write (message unchanged from v16)", w.result === "BLOCKED: write tools are disabled in this read-only agent")
  ok("nothing was written", !fs.existsSync(path.join(tmp, "x.txt")))
  ok("a read still works in read-only mode", (await ro.intel.runCall({ name: "read_file", args: { path: "app.js" } })).result.includes("hi"))

  const dis = realIntel(tmp, { config: { tools: { disabled: ["grep_files"] } } })
  const g = await dis.intel.runCall({ name: "grep_files", args: { pattern: "hi" } })
  ok("a disabled tool is refused by the gate", g.result.startsWith('BLOCKED: tool "grep_files" is disabled'))
  ok("the refusal is a TOOL_BLOCKED event", dis.events.some((e) => e.type === "TOOL_BLOCKED"))

  const capped = realIntel(tmp, { config: { tools: { maxRisk: "low" } } })
  const e = await capped.intel.runCall({ name: "edit_file", args: { path: "app.js", old: "1", new: "2" } })
  ok("a configured risk ceiling refuses a medium-risk mutation", e.result.startsWith("BLOCKED: operation risk medium exceeds"))
  ok("low-risk work still runs under the ceiling", (await capped.intel.runCall({ name: "read_file", args: { path: "app.js" } })).record.status === "ok")
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log("== §8 never blindly repeat a failed call ==")
{
  const tmp = project()
  const { intel, events } = realIntel(tmp)
  const call = { name: "read_file", args: { path: "ghost.js" } }
  const a = await intel.runCall(call)
  const b = await intel.runCall(call)
  const c = await intel.runCall(call)
  ok("the first failure is a real tool error", a.result.startsWith("ERROR: not found"))
  ok("the failure carries a recovery hint", /\[forge\] failure=NOT_FOUND/.test(a.result))
  ok("the failure suggests a different tool", /\[forge\] next: glob_files/.test(b.result))
  ok("the third identical call is refused, not executed", c.result.startsWith("BLOCKED:") && /already failed 2×/.test(c.result))
  ok("the refusal names a new strategy", /change strategy/.test(c.result))
  ok("a different argument set is still allowed", (await intel.runCall({ name: "read_file", args: { path: "app.js" } })).record.status === "ok")
  ok("blocked repeats are observable", events.filter((e) => e.type === "TOOL_BLOCKED").length >= 1)
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log("== §14 idempotency ==")
{
  const tmp = project()
  const { intel } = realIntel(tmp)
  const first = await intel.runCall({ name: "edit_file", args: { path: "app.js", old: "return 1", new: "return 2" } })
  ok("the edit applies", first.record.status === "ok" && fs.readFileSync(path.join(tmp, "app.js"), "utf8").includes("return 2"))
  const again = await intel.runCall({ name: "edit_file", args: { path: "app.js", old: "return 1", new: "return 2" } })
  ok("repeating an applied edit is detected as a no-op, not an error", /idempotent no-op/.test(again.result))
  ok("the original tool error is still shown (no fabrication)", /original tool result/.test(again.result))
  ok("the file was not corrupted by the repeat", (fs.readFileSync(path.join(tmp, "app.js"), "utf8").match(/return 2/g) || []).length === 1)
  const mk = await intel.runCall({ name: "bash", args: { command: "mkdir sub && mkdir sub" } })
  ok("mkdir of an existing directory is reported as already done", /idempotency: the directory already exists/.test(mk.result))
  ok("argsHash is stable and argument-order independent", argsHash("read_file", { a: 1, b: 2 }) === argsHash("read_file", { b: 2, a: 1 }))
  ok("argsHash separates different arguments", argsHash("read_file", { path: "a" }) !== argsHash("read_file", { path: "b" }))
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log("== §11 context reuse: cache + invalidation ==")
{
  const tmp = project()
  const { intel, events } = realIntel(tmp)
  const r1 = await intel.runCall({ name: "read_file", args: { path: "app.js" } })
  const r2 = await intel.runCall({ name: "read_file", args: { path: "app.js" } })
  ok("an identical read is served from cache", r2.record.cached === true && r2.result === r1.result)
  ok("the cache hit is observable", events.some((e) => e.type === "TOOL_CACHED"))
  await intel.runCall({ name: "edit_file", args: { path: "app.js", old: "return 1", new: "return 42" } })
  const r3 = await intel.runCall({ name: "read_file", args: { path: "app.js" } })
  ok("a mutation invalidates the cache", r3.record.cached === false && r3.result.includes("42"))
  await intel.runCall({ name: "bash", args: { command: "echo hello >> app.js" } })
  const r4 = await intel.runCall({ name: "read_file", args: { path: "app.js" } })
  ok("a shell mutation invalidates the cache too", r4.record.cached === false && r4.result.includes("hello"))
  ok("write results are never cached", intel.cacheSize() <= 2)
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log("== §12 parallel execution is real, and only where it is safe ==")
{
  const slow = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms))
  const calls = []
  const exec = async (name, args) => {
    calls.push(name)
    if (name === "read_file") return slow(120, `    1| content of ${args.path}`)
    if (name === "grep_files") return slow(120, `hit: ${args.pattern}`)
    if (name === "edit_file") return slow(60, `OK edited ${args.path}`)
    return "ok"
  }
  const tmp = project()
  const intel = createToolIntel({ exec, ctx: { cwd: tmp, root: tmp }, config: { tools: { verify: false } }, runId: "r", taskId: "t" })
  let t0 = Date.now()
  await intel.runBatch([
    { name: "grep_files", args: { pattern: "auth" } },
    { name: "grep_files", args: { pattern: "test" } },
    { name: "grep_files", args: { pattern: "config" } },
  ])
  const parallelMs = Date.now() - t0
  ok(`three searches ran concurrently (${parallelMs}ms < 300ms)`, parallelMs < 300)

  t0 = Date.now()
  await intel.runBatch([
    { name: "edit_file", args: { path: "a.js", old: "x", new: "y" } },
    { name: "edit_file", args: { path: "b.js", old: "x", new: "y" } },
  ])
  const serialMs = Date.now() - t0
  ok(`two edits were serialized (${serialMs}ms >= 110ms)`, serialMs >= 110)

  const order = []
  const execOrder = async (name, args) => { order.push(`${name}:${args.path ?? args.pattern}`); return "ok" }
  const intel2 = createToolIntel({ exec: execOrder, ctx: { cwd: tmp, root: tmp }, config: { tools: { verify: false } } })
  const out = await intel2.runBatch([
    { name: "edit_file", args: { path: "z.js", old: "a", new: "b" } },
    { name: "read_file", args: { path: "q.js" } },
  ])
  ok("results stay index-aligned with the model's call order", out.length === 2 && out[0].record.tool === "edit_file" && out[1].record.tool === "read_file")
  ok("a read after a write to another file still runs", order.length === 2)
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log("== timeout handling + bounded retry ==")
{
  const tmp = project()
  let attempts = 0
  const exec = async (name) => {
    attempts++
    if (name === "fetch_url") return attempts === 1 ? "ERROR: fetch failed" : "OK page body"
    if (name === "read_file") return new Promise(() => {}) // hangs forever
    return "ok"
  }
  const intel = createToolIntel({ exec, ctx: { cwd: tmp, root: tmp }, config: {}, onEvent: null })
  const r = await intel.runCall({ name: "fetch_url", args: { url: "https://example.com" } })
  ok("a transient network failure is retried exactly once, then succeeds", attempts === 2 && r.result.startsWith("OK page body"))

  const events = []
  const reg = createRegistry({})
  reg.register({ ...reg.get("read_file"), timeout: 0.1 })
  const intel2 = createToolIntel({ exec, ctx: { cwd: tmp, root: tmp }, registry: reg, config: {}, onEvent: (e) => events.push(e) })
  const t = await intel2.runCall({ name: "read_file", args: { path: "app.js" } })
  ok("a hung read-only tool hits the watchdog instead of hanging the run", /timed out/.test(t.result))
  ok("the timeout is classified as TIMEOUT", t.record.failure === FAILURE.TIMEOUT || /TIMEOUT/.test(t.result))
  ok("a retry event is emitted", events.some((e) => e.type === "TOOL_RETRY"))
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log("== §13 verification inside the pipeline ==")
{
  const tmp = project()
  const { intel, events } = realIntel(tmp)
  const good = await intel.runCall({ name: "edit_file", args: { path: "app.js", old: "return 1", new: "return 2" } })
  ok("a good edit reports verified evidence to the model", /\[verified\]/.test(good.result))
  ok("the verification is recorded in the tool state", good.record.verification?.ok === true)
  ok("a TOOL_VERIFIED event is emitted", events.some((e) => e.type === "TOOL_VERIFIED" && e.ok === true))

  const bad = await intel.runCall({ name: "edit_file", args: { path: "app.js", old: "return 2", new: "return ((( " } })
  ok("a syntax-breaking edit is caught by verification", /\[verification FAILED\]/.test(bad.result))
  ok("a failed verification marks the call failed", bad.record.status === "failed")
  ok("the failing check names the real file (not a temp copy)", /app\.js/.test(bad.record.verification.summary))

  const jsonBad = await intel.runCall({ name: "write_file", args: { path: "conf.json", content: "{nope" } })
  ok("invalid JSON is caught after a write", /verification FAILED/.test(jsonBad.result))

  const noVerify = realIntel(tmp, { config: { tools: { verify: false } } })
  const q = await noVerify.intel.runCall({ name: "write_file", args: { path: "q.json", content: "{nope" } })
  ok("verification can be turned off", !/verified|verification/.test(q.result))
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log("== §15 tool state ==")
{
  const tmp = project()
  const { intel } = realIntel(tmp)
  await intel.runCall({ name: "read_file", args: { path: "app.js" } }, { step: 3 })
  await intel.runCall({ name: "edit_file", args: { path: "app.js", old: "return 1", new: "return 3" } }, { step: 4 })
  const recs = intel.records()
  const REQUIRED = ["tool_call_id", "task_id", "run_id", "tool", "arguments_hash", "start_time", "end_time", "status", "result", "error", "files_changed", "verification"]
  const missing = []
  for (const r of recs) for (const f of REQUIRED) if (!(f in r)) missing.push(`${r.tool}.${f}`)
  ok(`every record carries the full state${missing.length ? " — " + missing.join(", ") : ""}`, missing.length === 0)
  ok("run_id and task_id are propagated", recs.every((r) => r.run_id === "run-test" && r.task_id === "task-test"))
  ok("files_changed lists the mutated file", recs.find((r) => r.tool === "edit_file").files_changed.includes("app.js"))
  ok("reads change no files", recs.find((r) => r.tool === "read_file").files_changed.length === 0)
  ok("durations are recorded", recs.every((r) => typeof r.duration_ms === "number"))
  ok("the step is recorded", recs.find((r) => r.tool === "edit_file").step === 4)
  ok("risk is recorded per call", recs.find((r) => r.tool === "edit_file").risk === RISK.MEDIUM)
  ok("checkpoint linkage is attempted for mutations", "checkpoint" in recs.find((r) => r.tool === "edit_file"))
  const s = intel.stats()
  ok("stats aggregate the run", s.calls === recs.length && s.ok >= 1 && typeof s.byTool.read_file === "number")
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log("== §16 observability ==")
{
  const tmp = project()
  const { intel, events } = realIntel(tmp)
  await intel.runCall({ name: "read_file", args: { path: "app.js" } })
  const types = events.map((e) => e.type)
  ok("TOOL_SELECTED comes first", types[0] === "TOOL_SELECTED")
  for (const t of ["TOOL_SELECTED", "TOOL_STARTED", "TOOL_OUTPUT", "TOOL_COMPLETED"]) ok(`${t} is emitted`, types.includes(t))
  ok("legacy tool_start/tool_result stay on the wire (UI compatibility)", types.includes("tool_start") && types.includes("tool_result"))
  ok("TOOL_SELECTED explains the choice", events[0].reason.length > 5 && events[0].capability === "file_read")
  ok("events carry the call id, run id and task id", events.find((e) => e.type === "TOOL_COMPLETED").callId && events.find((e) => e.type === "TOOL_COMPLETED").runId === "run-test")

  const failing = await intel.runCall({ name: "read_file", args: { path: "ghost.js" } })
  ok("TOOL_FAILED carries the classified code", events.some((e) => e.type === "TOOL_FAILED" && e.code === FAILURE.NOT_FOUND))
  ok("a failing call still emits a legacy tool_result", events.filter((e) => e.type === "tool_result").length === 2)
  void failing

  const noLegacy = createToolIntel({ exec: async () => "ok", ctx: { cwd: tmp }, legacyEvents: false, onEvent: (e) => events.push(e) })
  const before = events.length
  await noLegacy.runCall({ name: "read_file", args: { path: "app.js" } })
  ok("legacy events can be turned off (chat mode)", !events.slice(before).some((e) => e.type === "tool_start"))
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log("== unknown tools and plugins ==")
{
  const tmp = project()
  const { intel } = realIntel(tmp)
  const u = await intel.runCall({ name: "definitely_not_a_tool", args: {} })
  ok("an unknown tool still reaches the dispatcher's error (compat)", u.result.startsWith('ERROR: unknown tool'))
  ok("an unknown tool is classified, not crashed on", u.record.failure === FAILURE.INVALID_ARGUMENT)

  const pluginIntel = createToolIntel({
    exec: async (name) => (name === "jira_issue" ? "ISSUE-1: open" : "ERROR: unknown tool"),
    ctx: { cwd: tmp },
    plugins: [{ name: "jira_issue", readOnly: true, source: "jira.mjs", def: { function: { description: "Fetch an issue" } }, capabilities: ["issue_lookup"] }],
  })
  const pr = await pluginIntel.runCall({ name: "jira_issue", args: { key: "ISSUE-1" } })
  ok("a plugin tool runs through the same pipeline", pr.record.status === "ok" && pr.result.includes("ISSUE-1"))
  ok("the plugin is in the registry with its capability", pluginIntel.registry.get("jira_issue").capabilities.includes("issue_lookup"))
  ok("the router can select the plugin for its capability", pluginIntel.registry.providersOf("issue_lookup")[0].name === "jira_issue")
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log("== regression: the layer can be switched off ==")
{
  const tmp = project()
  const off = realIntel(tmp, { config: { tools: { intelligence: false } } })
  const r = await off.intel.runCall({ name: "edit_file", args: { path: "app.js", old: "return 1", new: "return 9" } })
  ok("with intelligence off the result is the raw tool output", r.result === `OK edited ${path.join(tmp, "app.js")}`)
  const rep = await off.intel.runCall({ name: "read_file", args: { path: "ghost.js" } })
  const rep2 = await off.intel.runCall({ name: "read_file", args: { path: "ghost.js" } })
  const rep3 = await off.intel.runCall({ name: "read_file", args: { path: "ghost.js" } })
  ok("no hints are appended", !/\[forge\]/.test(rep.result))
  ok("no repeat guard when the layer is off (pre-v20.5 behaviour)", rep3.result === rep2.result && !rep3.result.startsWith("BLOCKED"))

  const roOff = realIntel(tmp, { readOnly: true, config: { tools: { intelligence: false } } })
  const w = await roOff.intel.runCall({ name: "write_file", args: { path: "nope.txt", content: "x" } })
  ok("SECURITY controls are NOT part of the switch: read-only still blocks writes", w.result === "BLOCKED: write tools are disabled in this read-only agent")
  const disOff = realIntel(tmp, { config: { tools: { intelligence: false, disabled: ["bash"] } } })
  ok("a disabled tool stays disabled with the layer off", (await disOff.intel.runCall({ name: "bash", args: { command: "echo hi" } })).result.startsWith("BLOCKED: tool"))
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log("== §17 human escalation only where judgement helps ==")
{
  ok("an ordinary edit never asks", shouldEscalate({ code: null, risk: RISK.MEDIUM, reversible: true, tool: "edit_file" }).escalate === false)
  ok("a first NOT_FOUND does not ask", shouldEscalate({ code: FAILURE.NOT_FOUND, attempts: 0, tool: "read_file" }).escalate === false)
  ok("a permission decision asks", shouldEscalate({ code: FAILURE.PERMISSION_DENIED, tool: "bash" }).escalate === true)
  ok("a repeatedly blocked operation asks", shouldEscalate({ code: FAILURE.SAFETY_BLOCK, attempts: 1, tool: "bash" }).escalate === true)
  ok("installing a dependency asks", shouldEscalate({ code: FAILURE.DEPENDENCY_FAILURE, attempts: 1 }).escalate === true)
  ok("an irreversible high-risk operation asks", shouldEscalate({ risk: "high", reversible: false, tool: "bash" }).escalate === true)
  ok("an irreversible LOW-risk operation does not", shouldEscalate({ risk: "low", reversible: false, tool: "bash" }).escalate === false)
  ok("a user interrupt is never turned into a question", shouldEscalate({ code: FAILURE.CANCELLED, attempts: 5 }).escalate === false)
  ok("the question is a real question", /\?$/.test(shouldEscalate({ code: FAILURE.PERMISSION_DENIED, tool: "bash" }).question))

  const tmp = project()
  const { intel, events } = realIntel(tmp)
  const call = { name: "read_file", args: { path: "ghost.js" } }
  await intel.runCall(call); await intel.runCall(call)
  const blocked = await intel.runCall(call)
  ok("a blocked repeat hands the decision back to the user", /\[forge\] ask the user:/.test(blocked.result))
  ok("the escalation is observable", events.some((e) => e.type === "TOOL_BLOCKED" && (e.escalation || /already failed/.test(String(e.reason)))))
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log("== the premium UI consumes the events (§16 + §21) ==")
{
  const tmp = project()
  const store = createUIStore({ mode: "agent", cwd: tmp })
  const bctx = createBridgeContext({ cwd: tmp })
  const { intel } = realIntel(tmp, { intel: { onEvent: null } })
  const forwarded = []
  const { intel: intel2 } = realIntel(tmp, { intel: { onEvent: (ev) => { forwarded.push(ev); bridgeAgentEvent(store, ev, bctx) } } })
  void intel
  store.dispatch({ type: "TASK_STARTED", id: "run-test", title: "verify the bridge", kind: "agent", startedAt: Date.now() })
  await intel2.runCall({ name: "edit_file", args: { path: "app.js", old: "return 1", new: "return 2" } }, { step: 1 })
  ok("the tool row reached the UI store", Object.keys(store.state.tools).includes("edit_file"))
  ok("the syntax verification reached the VERIFICATION panel", store.state.verification.checks.syntax?.ok === true)
  ok("the changed file reached the CHANGES panel", Object.keys(store.state.changes).some((p) => p.endsWith("app.js")))

  await intel2.runCall({ name: "edit_file", args: { path: "app.js", old: "return 2", new: "return ((( " } }, { step: 2 })
  ok("a failed verification is recorded, not hidden", store.state.verification.checks.syntax?.ok === false)
  ok("the failure produced a warning notice", store.state.notices.some((n) => /verification failed/i.test(n.text)))
  ok("unknown structured events never break the store", (() => { bridgeAgentEvent(store, { type: "TOOL_SELECTED", tool: "read_file" }, bctx); return store.state.state !== undefined })())
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n== toolintel suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
