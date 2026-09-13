#!/usr/bin/env node
/**
 * forge — verification integrity: stale results (v21.1 P1).
 *
 *  - a verification record carries its provenance (command, cwd, env, repo
 *    state, stdout tail, timestamp, files written after it ran)
 *  - "tests passed, THEN the agent edited a covered file" is stale evidence:
 *    the record is invalidated at record time, so the gate is not satisfied
 *  - ledger.touch(files) bumps the epoch and invalidates passing evidence
 *    that covered the touched files (failures stay: a failure is a fact)
 *  - runAgent records writesBefore/filesWrittenAfter per check in call order
 *  - meta: evidence from segment 1 does not verify a file edited in segment 2
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-stale-"))
process.chdir(WORK)
process.env.FORGE_HOME = path.join(WORK, ".forgehome")
fs.mkdirSync(process.env.FORGE_HOME, { recursive: true })

const { createLedger, VERIFICATION_STATUS } = await import("../verifyledger.js")
const { runAgent } = await import("../agent.js")
const meta = await import("../meta.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 200) : ""}`) } }

console.log("== record provenance ==")
{
  const l = createLedger()
  const rec = l.recordCommand("npm test", "12 passed", { exitCode: 0, affectedFiles: ["src/a.js"], cwd: "/w", env: { CI: "1", NODE_ENV: null }, repoState: { head: "abc", dirty: 2 }, stdoutTail: "x".repeat(5000), timestamp: 1234 })
  ok("command/exit/timestamp", rec.command === "npm test" && rec.exitCode === 0 && rec.timestamp === 1234)
  ok("cwd/env/repoState carried", rec.cwd === "/w" && rec.env.CI === "1" && rec.repoState.head === "abc" && rec.repoState.dirty === 2)
  ok("stdout tail bounded to 2000", rec.stdoutTail.length === 2000)
  ok("filesWrittenAfter defaults empty", Array.isArray(rec.filesWrittenAfter) && rec.filesWrittenAfter.length === 0)
  ok("passing record without later writes is valid", !rec.invalidated && l.records().some((r) => r.passed && r.type === "regression_test"))
  const ser = l.serialize()[0]
  ok("provenance survives serialisation", ser.cwd === "/w" && ser.repoState.head === "abc")
}

console.log("== writes after a passing check make it stale ==")
{
  const l = createLedger()
  const rec = l.recordCommand("npm test", "12 passed", { exitCode: 0, affectedFiles: ["src/a.js", "src/b.js"], filesWrittenAfter: ["src/a.js"] })
  ok("record invalidated at record time", rec.invalidated === true && rec.invalidatedBy === "writes-after-check")
  ok("stale reason stated", /written after/.test(rec.staleReason))
  const st = l.status("medium", ["src/a.js"])
  ok("gate NOT satisfied by stale evidence", st.ok === false && st.missing.includes("focused_test"))
  ok("stale record excluded from valid records", l.records().length === 0 && l.all().length === 1)

  const l2 = createLedger()
  l2.recordCommand("npm test", "12 passed", { exitCode: 0, affectedFiles: ["src/a.js"], filesWrittenAfter: ["docs/README.md"] })
  ok("write to an UNRELATED file does not invalidate scoped evidence", l2.records().length === 1)

  const l3 = createLedger()
  l3.recordCommand("npm test", "12 passed", { exitCode: 0, affectedFiles: [], filesWrittenAfter: ["anything.js"] })
  ok("unscoped (project-wide) evidence is stale after ANY later write", l3.records().length === 0)

  const l4 = createLedger()
  l4.recordCommand("npm test", "12 passed", { exitCode: 0, affectedFiles: ["src/a.js"], filesWrittenAfter: ["(shell write)"] })
  ok("a shell redirection with unknown target counts as a write", l4.records().length === 0)

  const l5 = createLedger()
  const f = l5.recordCommand("npm test", "3 failed\n[exit code: 1]", { exitCode: 1, affectedFiles: ["src/a.js"], filesWrittenAfter: ["src/a.js"] })
  ok("a FAILURE is kept even if writes follow (it is a fact until superseded)", !f.invalidated && l5.status("medium", ["src/a.js"]).anyFailure === true)
  const p = l5.recordCommand("npm test", "12 passed", { exitCode: 0, affectedFiles: ["src/a.js"] })
  ok("a later clean PASS supersedes the failure", p.passed && l5.status("medium", ["src/a.js"]).anyFailure === false && l5.records().some((r) => r.passed))
}

console.log("== ledger.touch(files) ==")
{
  const l = createLedger()
  const e0 = l.epoch
  l.recordCommand("node --check src/a.js", "ok", { exitCode: 0, affectedFiles: ["src/a.js"] })
  l.recordCommand("npm test", "12 passed", { exitCode: 0, affectedFiles: ["src/a.js"] })
  l.recordCommand("npm test", "9 passed", { exitCode: 0, affectedFiles: ["src/other.js"] })
  l.recordCommand("npm run lint", "2 errors\n[exit code: 1]", { exitCode: 1, affectedFiles: ["src/a.js"] })
  ok("verified before touch", l.status("medium", ["src/a.js"]).anyFailure === true && l.records().some((r) => r.passed && r.affectedFiles.includes("src/other.js")))
  const n = l.touch(["./src/a.js"])
  ok("touch invalidates exactly the passing records covering the file", n === 2, n)
  ok("epoch bumped", l.epoch > e0 + 4)
  ok("other file's evidence untouched", l.records().some((r) => r.passed && r.affectedFiles.includes("src/other.js")))
  const st = l.status("medium", ["src/a.js"])
  ok("touched file is no longer verified (needs fresh evidence)", st.ok === false && st.missing.includes("syntax") && st.missing.includes("focused_test"))
  ok("failure on the touched file is still reported", st.anyFailure === true)
  ok("touch with no files is a no-op", l.touch([]) === 0)
  ok("invalidated records carry a reason", l.all().filter((r) => r.invalidated).every((r) => r.invalidatedBy === "touch" && r.staleReason))
}

console.log("== runAgent: checks know which writes followed them ==")
{
  // scripted openai-protocol server: test → write → test → write
  const script = [
    { tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo 'ok 1 passed'; true # npm test" }) } }] },
    { tool_calls: [{ id: "c2", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "src/a.js", content: "export const a = 1\n" }) } }] },
    { tool_calls: [{ id: "c3", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo 'ok 2 passed' # npm test" }) } }] },
    { tool_calls: [{ id: "c4", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo hi > notes.txt" }) } }] },
    { content: "done" },
  ]
  let i = 0
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c))
    req.on("end", () => {
      const m = script[Math.min(i++, script.length - 1)]
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: m.content ?? null, tool_calls: m.tool_calls }, finish_reason: m.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  fs.mkdirSync(path.join(WORK, "src"), { recursive: true })
  const cfg = { activeProvider: "p", providers: { p: { protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, apiKey: "k", model: "m" } }, agent: { maxSteps: 10, timeoutSec: 10, modelStrategy: false }, skills: { enabled: false }, tools: {} }
  const { buildProvider } = await import("../providers.js")
  const r = await runAgent({ config: cfg, provider: buildProvider(cfg, "p"), task: "do it", onEvent: () => {} })
  srv.close()
  const checks = r.commandChecks ?? []
  ok("two command checks recorded", checks.length === 2, JSON.stringify(checks.map((c) => c.command)))
  const [c1, c2] = checks
  ok("check 1 ran before any write", c1 && c1.writesBefore.length === 0 && c1.writeIndex === 0)
  ok("check 1 sees the later write_file AND the later shell redirection", c1 && c1.filesWrittenAfter.some((f) => f.endsWith(path.join("src", "a.js"))) && c1.filesWrittenAfter.includes("(shell write)"))
  ok("check 2 ran after src/a.js was written", c2 && c2.writesBefore.some((f) => f.endsWith(path.join("src", "a.js"))))
  ok("check 2 only sees the shell write after it", c2 && c2.filesWrittenAfter.length === 1 && c2.filesWrittenAfter[0] === "(shell write)")
  ok("provenance fields present", c1 && c1.cwd === process.cwd() && typeof c1.at === "number" && "env" in c1 && "repoState" in c1 && typeof c1.stdoutTail === "string")
}

console.log("== meta: evidence from an earlier segment does not verify a later edit ==")
{
  fs.writeFileSync(path.join(WORK, "mod.js"), "export const x = 1\n")
  let call = 0
  const events = []
  const fake = async (args) => {
    call++
    if (args.planOnly) return { text: "1. change the constant", toolRecords: [], commandChecks: [], toolLog: [] }
    if (call === 2) return { // segment 1: edit + full green evidence for medium risk
      text: "edited and tested", budgetHit: true, steps: 3,
      toolRecords: [{ tool: "edit_file", files_changed: ["mod.js"] }],
      commandChecks: [
        { command: "node --check mod.js", exitCode: 0, passed: true, tail: "ok", filesWrittenAfter: [] },
        { command: "npm test -- mod.test.js", exitCode: 0, passed: true, tail: "5 passed", filesWrittenAfter: [] },
      ],
      toolLog: [{ name: "edit_file" }, { name: "bash" }, { name: "bash" }],
    }
    // segment 2: another edit, NO new evidence → must not complete on old evidence
    return { text: "tweaked once more, all good", budgetHit: false, steps: 1, toolRecords: [{ tool: "edit_file", files_changed: ["mod.js"] }], commandChecks: [], toolLog: [{ name: "edit_file" }] }
  }
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const r = await meta.runMeta({ config: cfg, provider: { name: "x", model: "m" }, task: "change the constant in mod.js", runAgent: fake, workers: false, maxSegments: 3, signal: new AbortController().signal, onEvent: (e) => events.push(e) })
  const inv = events.filter((e) => e.type === "VERIFICATION_INVALIDATED")
  ok("VERIFICATION_INVALIDATED emitted when segment 2 edited a covered file", inv.length >= 1, JSON.stringify(events.map((e) => e.type)))
  ok("invalidation names the file", inv.some((e) => (e.files ?? []).includes("mod.js")))
  ok("task did NOT complete on stale evidence", r.status !== "COMPLETED", `status=${r.status}`)
  const lastStatus = [...events].reverse().find((e) => e.type === "VERIFICATION_STATUS")
  ok("final verification status is not ok", lastStatus && lastStatus.ok === false, JSON.stringify(lastStatus))
  console.log(`       (status=${r.status} invalidated=${inv.map((e) => e.count).join(",")})`)
}

console.log(`\n== verification-staleness suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
