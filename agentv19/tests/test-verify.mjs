#!/usr/bin/env node
/**
 * forge — the verification gate (Phase 3).
 *
 * The property under test is honesty, not cleverness:
 *   - a project with no checks is NOT_AVAILABLE, never PASSED
 *   - a command the safety engine refuses is recorded BLOCKED and NOT run
 *   - a failing check is FAILED, with the tail of the real output kept
 *   - an agent that claims COMPLETED while the checks fail is DEMOTED to
 *     CONTINUE_REQUIRED in the durable record — its claim does not survive
 *     contact with evidence
 *   - given another segment, the agent is asked to fix the cause and told
 *     explicitly not to weaken the check to make it pass
 *
 * Real subprocesses, real exit codes; zero external network.
 */
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-verify-"))
process.env.FORGE_HOME = HOME

const { AGENT_STATUS } = await import("../forge/contract.js")
const { VERIFY_STATUS, detectChecks, verifyProject, summarizeVerification, repairPrompt, MAX_CHECKS, DEFAULT_TIMEOUT_SEC } = await import("../forge/verify.js")
const ts = await import("../forge/taskstate.js")
const { runTask } = await import("../forge/orchestrator.js")

let PASS = 0, FAIL = 0
const ok = (n, c) => { if (c) { PASS++; console.log(`  ok   ${n}`) } else { FAIL++; console.log(`  FAIL ${n}`) } }

const mkproj = (files) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "forge-proj-"))
  for (const [name, content] of Object.entries(files)) {
    const f = path.join(d, name)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, content)
  }
  return d
}

function listen(handler) {
  const srv = http.createServer(handler)
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)))
}
const body = (msg) => JSON.stringify({ choices: [{ message: msg, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }] })
const providerFor = (port) => ({ name: "m", protocol: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "m", contextWindow: 128000 })
const cfg = (maxSteps = 5) => ({ providers: {}, agent: { maxSteps }, skills: { enabled: false }, context: { repoMap: false } })

console.log("== detection reads the project's OWN config, nothing else ==")
{
  const d = mkproj({ "package.json": JSON.stringify({ name: "x", scripts: { test: "echo t", lint: "echo l", build: "echo b" } }) })
  const found = detectChecks(d)
  ok("finds package.json scripts", found.some((c) => c.id === "test") && found.some((c) => c.id === "lint"))
  ok("uses `npm test` for test and `npm run x` for others", found.find((c) => c.id === "test").cmd === "npm test" && found.find((c) => c.id === "lint").cmd === "npm run lint")
  ok("cheap checks come before the test suite", found.findIndex((c) => c.id === "lint") < found.findIndex((c) => c.id === "test"))
  ok("does not run `build` — it is not a check", !found.some((c) => c.id === "build"))

  ok("an empty project has nothing to run", detectChecks(mkproj({ "readme.md": "hi" })).length === 0)
  ok("a package.json with no scripts finds nothing", detectChecks(mkproj({ "package.json": '{"name":"x"}' })).length === 0)
  ok("a corrupt package.json does not throw", detectChecks(mkproj({ "package.json": "{oops" })).length === 0)

  const mk = mkproj({ "Makefile": "test:\n\techo hi\n\nother:\n\techo no\n" })
  ok("finds Makefile targets", detectChecks(mk).some((c) => c.cmd === "make test"))
  ok("ignores unrelated Makefile targets", !detectChecks(mk).some((c) => c.cmd === "make other"))

  ok("cargo project", detectChecks(mkproj({ "Cargo.toml": "[package]" }))[0]?.cmd === "cargo test")
  ok("go project", detectChecks(mkproj({ "go.mod": "module x" }))[0]?.cmd === "go test ./...")
  ok("python project", detectChecks(mkproj({ "pytest.ini": "[pytest]" }))[0]?.cmd === "pytest -q")

  const many = mkproj({ "package.json": JSON.stringify({ scripts: { test: "a", lint: "b", check: "c", typecheck: "d", tsc: "e" } }) })
  ok("the number of checks is capped", detectChecks(many).length === MAX_CHECKS)
}

console.log("== NOT_AVAILABLE is a real answer, never PASSED ==")
{
  const v = await verifyProject(mkproj({ "readme.md": "hi" }))
  ok("status is NOT_AVAILABLE", v.status === VERIFY_STATUS.NOT_AVAILABLE)
  ok("it is NOT reported as passed", v.status !== VERIFY_STATUS.PASSED)
  ok("no checks are invented", v.checks.length === 0)
  ok("the summary says so plainly", /NOT_AVAILABLE/.test(summarizeVerification(v)))
}

console.log("== a passing project passes, a failing one fails ==")
{
  const good = mkproj({ "package.json": JSON.stringify({ scripts: { test: "exit 0" } }) })
  const vg = await verifyProject(good)
  ok("exit 0 → PASSED", vg.status === VERIFY_STATUS.PASSED)
  ok("the check is recorded as ok", vg.checks[0].ok === true && vg.checks[0].code === 0)

  const bad = mkproj({ "package.json": JSON.stringify({ scripts: { test: "echo 'AssertionError: 2 != 3' >&2; exit 1" } }) })
  const vb = await verifyProject(bad)
  ok("a non-zero exit → FAILED", vb.status === VERIFY_STATUS.FAILED)
  ok("the exit code is recorded", vb.checks[0].code === 1)
  ok("the real output is kept as evidence", /AssertionError: 2 != 3/.test(vb.checks[0].output))
  ok("the summary names the failing check", /FAIL/.test(summarizeVerification(vb)))
}

console.log("== the gate has no private path to the shell ==")
{
  // A script the safety engine refuses must be recorded BLOCKED and NOT run.
  // The marker file proves it: if the command had run, the file would exist.
  const d = mkproj({ "package.json": JSON.stringify({ scripts: { test: "x" } }) })
  const marker = path.join(d, "SHOULD-NOT-EXIST")
  const v = await verifyProject(d, { checks: [{ id: "test", cmd: `rm -rf / --no-preserve-root; touch ${marker}`, source: "test" }] })
  ok("a catastrophic command is blocked", v.checks[0].blocked === true)
  ok("and it really did not run", !fs.existsSync(marker))
  ok("a reason is recorded, not swallowed", typeof v.checks[0].reason === "string" && v.checks[0].reason.length > 0)
  ok("all-blocked verification is BLOCKED, not PASSED", v.status === VERIFY_STATUS.BLOCKED)
}

console.log("== output is secret-redacted and bounded ==")
{
  const d = mkproj({ "package.json": JSON.stringify({ scripts: { test: "echo 'key=sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'; exit 1" } }) })
  const v = await verifyProject(d)
  ok("an api key in test output is redacted", !v.checks[0].output.includes("sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"))

  const big = mkproj({ "package.json": JSON.stringify({ scripts: { test: "for i in $(seq 1 4000); do echo 'noise line padding padding'; done; echo FINAL_SUMMARY_LINE; exit 1" } }) })
  const vb = await verifyProject(big)
  ok("output is bounded", vb.checks[0].output.length < 6000)
  ok("the TAIL is kept — that is where a suite puts its summary", /FINAL_SUMMARY_LINE/.test(vb.checks[0].output))
}

console.log("== a timeout is a failure, not a pass ==")
{
  const d = mkproj({ "package.json": JSON.stringify({ scripts: { test: "sleep 30" } }) })
  const v = await verifyProject(d, { timeoutSec: 1 })
  ok("status FAILED", v.status === VERIFY_STATUS.FAILED)
  ok("recorded as a timeout", v.checks[0].timedOut === true && v.checks[0].code === null)
  ok("there is a bounded default timeout", Number.isFinite(DEFAULT_TIMEOUT_SEC) && DEFAULT_TIMEOUT_SEC > 0 && DEFAULT_TIMEOUT_SEC <= 1800)
}

console.log("== repairPrompt asks for a fix, not a weaker check ==")
{
  const v = { status: VERIFY_STATUS.FAILED, checks: [{ id: "test", cmd: "npm test", ok: false, blocked: false, code: 1, output: "AssertionError: 2 != 3" }] }
  const p = repairPrompt("add a --verbose flag", v)
  ok("restates the task", p.includes("add a --verbose flag"))
  ok("includes the failing command and its output", p.includes("npm test") && p.includes("AssertionError"))
  ok("forbids deleting or skipping the check", /Do NOT delete, skip, weaken or rewrite a check/.test(p))
  ok("forbids editing assertions to match behaviour", /change its assertions to match current behaviour/.test(p))
}

console.log("== runTask gate: a claimed completion does not survive failing checks ==")
{
  const d = mkproj({ "package.json": JSON.stringify({ scripts: { test: "exit 1" } }) })
  const srv = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(body({ role: "assistant", content: "I fixed everything." }))
  })
  const r = await runTask({ config: cfg(), provider: providerFor(srv.address().port), task: "fix it", cwd: d, verify: true, maxSegments: 1 })
  ok("the agent did claim to be done", r.text.includes("fixed"))
  ok("but the run is NOT reported COMPLETED", r.status !== AGENT_STATUS.COMPLETED)
  ok("it is CONTINUE_REQUIRED — demoted by the evidence", r.status === AGENT_STATUS.CONTINUE_REQUIRED)
  ok("verificationFailed is set", r.verificationFailed === true)
  ok("budgetExhausted is NOT set — a different reason entirely", r.budgetExhausted === false)
  const rec = ts.loadTask(r.taskId)
  ok("the durable record carries the evidence", rec.verification.status === VERIFY_STATUS.FAILED)
  ok("the record is demoted too, not just the return value", rec.status === AGENT_STATUS.CONTINUE_REQUIRED)
  ok("and the task reads as resumable", ts.isResumable(rec))
  srv.close()
}

console.log("== runTask gate: verification passing keeps COMPLETED ==")
{
  const d = mkproj({ "package.json": JSON.stringify({ scripts: { test: "exit 0" } }) })
  const srv = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(body({ role: "assistant", content: "done" }))
  })
  const r = await runTask({ config: cfg(), provider: providerFor(srv.address().port), task: "fix it", cwd: d, verify: true, maxSegments: 2 })
  ok("status stays COMPLETED", r.status === AGENT_STATUS.COMPLETED)
  ok("verification PASSED", r.verification.status === VERIFY_STATUS.PASSED)
  ok("it did not burn a second segment", r.segments === 1)
  srv.close()
}

console.log("== runTask gate: NOT_AVAILABLE does not block or demote ==")
{
  const d = mkproj({ "readme.md": "no checks here" })
  const srv = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(body({ role: "assistant", content: "done" }))
  })
  const r = await runTask({ config: cfg(), provider: providerFor(srv.address().port), task: "t", cwd: d, verify: true, maxSegments: 2 })
  ok("COMPLETED is preserved", r.status === AGENT_STATUS.COMPLETED)
  ok("but the record says the evidence was unavailable", ts.loadTask(r.taskId).verification.status === VERIFY_STATUS.NOT_AVAILABLE)
  ok("no extra segment was spent", r.segments === 1)
  srv.close()
}

console.log("== runTask gate: a corrective segment is given the failure and can fix it ==")
{
  // The project's test script reads a file. The "agent" writes that file when
  // it receives the repair prompt — so the check genuinely goes red then green.
  const d = mkproj({
    "package.json": JSON.stringify({ scripts: { test: "test -f fixed.txt" } }),
  })
  let sawRepair = false
  const srv = await listen((req, res) => {
    let raw = ""
    req.on("data", (x) => { raw += x })
    req.on("end", () => {
      if (raw.includes("verification failed")) {
        sawRepair = true
        fs.writeFileSync(path.join(d, "fixed.txt"), "ok") // stand in for the agent's edit
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(body({ role: "assistant", content: "done" }))
    })
  })
  const r = await runTask({ config: cfg(), provider: providerFor(srv.address().port), task: "make the test pass", cwd: d, verify: true, maxSegments: 3 })
  ok("the second segment received the verification failure", sawRepair)
  ok("it took exactly two segments", r.segments === 2)
  ok("the final verification PASSED", r.verification.status === VERIFY_STATUS.PASSED)
  ok("the task ends COMPLETED, on evidence this time", r.status === AGENT_STATUS.COMPLETED)
  srv.close()
}

console.log("== the gate is off by default ==")
{
  const d = mkproj({ "package.json": JSON.stringify({ scripts: { test: "exit 1" } }) })
  const srv = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(body({ role: "assistant", content: "done" }))
  })
  const r = await runTask({ config: cfg(), provider: providerFor(srv.address().port), task: "t", cwd: d })
  ok("no verification runs unless asked for", r.verification === null)
  ok("behavior is unchanged: COMPLETED as before", r.status === AGENT_STATUS.COMPLETED)
  srv.close()
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
console.log(`\n== verify suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
