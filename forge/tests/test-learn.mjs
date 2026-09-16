#!/usr/bin/env node
/**
 * forge — v103 "learnwise": the system models itself from measured evidence,
 * invalidates a stale plan when the instruction changes, and picks the
 * cheapest information-gain experiment before another patch.
 *
 * Not a personality. Not auto-switching models. Not a second brain.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-learn-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + extra : ""}`) }
}

const { createSelfModel, SELF_VERSION } = await import("../selfmodel.js")
const { createCognition, COGNITION_VERSION, GAP } = await import("../cognition.js")
const { chooseNextAction, ACTION } = await import("../governor.js")
const { VERSION } = await import("../version.js")
const { recordModelOutcome } = await import("../empirics.js")
const { predictForAction, settlePrediction, recordPrediction, MIN_CALIBRATION_SAMPLES } = await import("../prediction.js")

console.log("== version identity ==")
{
  ok("package version is 117.x", /^122\./.test(VERSION), VERSION)
  ok("cognition protocol is 1.5.x", /^1\.5\./.test(COGNITION_VERSION), COGNITION_VERSION)
  ok("self-model protocol set", SELF_VERSION === "1.0.0")
}

console.log("== self-model: insufficient evidence is said out loud ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-self-empty-"))
  const self = createSelfModel({ cwd: dir, env: { FORGE_HOME: path.join(dir, "home") } })
  const snap = self.snapshot()
  ok("not calibrated on an empty ledger", snap.calibrated === false)
  ok("note names insufficient evidence", /insufficient/.test(snap.note || ""))
  const prompt = self.formatForPrompt()
  ok("prompt refuses to claim calibration", /insufficient/.test(prompt))
  ok("prompt forbids auto-switch", /never auto-switch/.test(prompt))
}

console.log("== self-model: measured strengths and weaknesses ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-self-cal-"))
  for (let i = 0; i < MIN_CALIBRATION_SAMPLES; i++) {
    const pred = predictForAction({ action: "EXECUTE", objective: "edit a.js", expectedFiles: ["a.js"] })
    const settled = settlePrediction(pred, { actualFiles: i < 3 ? ["a.js"] : ["b.js", "c.js"], status: "ok" })
    recordPrediction(settled, dir)
  }
  const self = createSelfModel({ cwd: dir, env: { FORGE_HOME: path.join(dir, "home") } })
  const snap = self.snapshot()
  ok("calibration sufficient after enough samples", snap.calibrated === true, `n=${snap.samples}`)
  ok("drift is a real number", typeof snap.avgDrift === "number")
  const advice = self.advise({ klass: "ARCHITECTURAL", driftLevel: "MISS" })
  ok("MISS advice says change hypothesis", advice.lines.some((l) => /change hypothesis/.test(l)))
  ok("never sets autoSwitch", advice.autoSwitch === false)
}

console.log("== empirics recommend, they do not switch ==")
{
  const env = { FORGE_HOME: path.join(HOME, "emp") }
  fs.mkdirSync(env.FORGE_HOME, { recursive: true })
  for (let i = 0; i < 4; i++) recordModelOutcome({ env, provider: "good", model: "good-1", ok: true, ms: 100 })
  for (let i = 0; i < 4; i++) recordModelOutcome({ env, provider: "bad", model: "bad-1", ok: false, ms: 100 })
  const self = createSelfModel({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), "forge-emp-")), env })
  const advice = self.advise({ klass: "LARGE", currentModel: "bad-1" })
  ok("recommends the measured-better model", advice.recommend?.model === "good-1", JSON.stringify(advice.recommend))
  ok("still autoSwitch=false", advice.autoSwitch === false)
  ok("advice names do not auto-switch", advice.lines.some((l) => /do not auto-switch/.test(l)) || /never auto-switch/.test(self.formatForPrompt({ currentModel: "bad-1" })))
}

console.log("== changed instruction does not replace v1 ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-intent-"))
  const cog = createCognition({ cwd: dir, objective: "fix the login timeout in auth.js" })
  const v1 = cog.contract.original().text
  const same = cog.absorbInstruction("fix the login timeout in auth.js")
  ok("identical instruction is a no-op", same.changed === false)
  const out = cog.absorbInstruction("rewrite the session architecture instead")
  ok("a different instruction is a change", out.changed === true)
  ok("v1 original wording is still frozen", cog.contract.original().text === v1)
  ok("current intent is the new instruction", /session architecture/.test(cog.contract.currentIntent().text))
  ok("conflict gap recorded", cog.contract.snapshot().gaps.some((g) => g.kind === GAP.CONFLICT || /instruction changed/.test(g.text)))
  ok("plan was invalidated", cog.events.some((e) => e.type === "USER_INTENT_CONFLICT"))
  ok("prompt still shows original v1", /Intent v1/.test(cog.promptBlock()) && /login timeout/.test(cog.promptBlock()))
}

console.log("== resume with a new objective revises, it does not overwrite ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-resume-"))
  const first = createCognition({ cwd: dir, objective: "add a logout button" })
  first.persist()
  const resumed = createCognition({
    cwd: dir,
    objective: "also hash the session tokens",
    resume: { contract: { originalIntent: "add a logout button" }, user: {}, objective: "add a logout button" },
  })
  ok("resumed original is the first instruction", resumed.contract.original().text === "add a logout button")
  ok("resumed current is the new instruction", /hash the session/.test(resumed.contract.currentIntent().text))
  ok("TASK_RESUMED fired", resumed.events.some((e) => e.type === "TASK_RESUMED"))
  ok("conflict fired on resume+new objective", resumed.events.some((e) => e.type === "USER_INTENT_CONFLICT"))
}

console.log("== VOI experiment is cheaper than another patch ==")
{
  const exp = chooseNextAction({
    klass: "LARGE", failed: true, inspected: true, hasPlan: true, steps: 4, writes: 1,
    unverified: [], experiment: { kind: "discriminate", id: "focused_test", instruction: "Run the smallest focused test", gain: 2.4 },
  })
  ok("discriminate experiment → TEST, not another EXECUTE", exp.action === ACTION.TEST, exp.action)
  const ins = chooseNextAction({
    klass: "LARGE", failed: true, inspected: true, hasPlan: true, steps: 4, writes: 0,
    unverified: [], experiment: { kind: "inspect", id: "read_stack", instruction: "Read the stack", gain: 3 },
  })
  ok("inspect experiment → INSPECT, not REPAIR", ins.action === ACTION.INSPECT, ins.action)
}

console.log("== cognition prompt carries self-model + VOI ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-prompt-"))
  const cog = createCognition({ cwd: dir, objective: "rewrite the auth architecture across files" })
  cog.next({ steps: 0, writes: 0, inspected: false, hasPlan: false })
  const block = cog.promptBlock()
  ok("prompt has SELF-MODEL", /SELF-MODEL/.test(block))
  ok("prompt has VOI or capability router", /VOI EXPERIMENT|CAPABILITY ROUTER/.test(block))
  ok("cognition exposes self", typeof cog.self?.snapshot === "function")
  ok("cognition exposes absorbInstruction", typeof cog.absorbInstruction === "function")
}

console.log("== DEFAULT agent path source is wired ==")
{
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "agent.js"), "utf8")
  ok("agent emits SELF_MODEL", /SELF_MODEL/.test(src))
  ok("agent still does not auto-switch models", /autoSwitch: false/.test(src))
  const cogSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "cognition.js"), "utf8")
  ok("cognition imports selfmodel", /from "\.\/selfmodel\.js"/.test(cogSrc))
  ok("cognition imports infogain", /from "\.\/infogain\.js"/.test(cogSrc))
}

function mkModel(script) {
  const server = http.createServer((req, res) => {
    if (!req.url.includes("chat/completions")) { res.writeHead(404).end(); return }
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      const n = mkModel.n = (mkModel.n || 0) + 1
      const message = script(n)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        id: "m", object: "chat.completion", created: Date.now(), model: "mock-1",
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      }))
    })
  })
  return server
}
const call = (id, name, args) => ({
  role: "assistant", content: "",
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
})

console.log("== SELF_MODEL fires on the REAL agent path ==")
{
  mkModel.n = 0
  const script = (n) => n === 1
    ? call("w1", "write_file", { path: "note.txt", content: "typo fixed\n" })
    : { role: "assistant", content: "Fixed the typo." }
  const server = mkModel(script)
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-learn-run-"))
  const prev = process.cwd()
  const evs = []
  try {
    process.chdir(dir)
    const { runAgent } = await import("../agent.js")
    const res = await runAgent({
      config: {
        providers: {},
        tools: { assumeYes: true, mcp: false, plugins: false, lsp: false, browser: false },
        agent: { autonomous: false, maxSteps: 8, verifyNudge: false, review: "off", continuity: false },
        skills: { enabled: false },
        mcp: { maxTools: 0 },
      },
      provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "k", model: "mock-1" },
      task: "fix a typo in note.txt",
      journal: false,
      onEvent: (e) => evs.push(e),
    })
    ok("SELF_MODEL event fired", evs.some((e) => e.type === "SELF_MODEL"))
    const sm = evs.find((e) => e.type === "SELF_MODEL")
    ok("self-model does not auto-switch on the live path", sm?.autoSwitch === false)
    ok("MICRO still writes", res.toolLog.some((t) => t.name === "write_file" && !String(t.result).startsWith("BLOCKED")))
  } finally {
    process.chdir(prev)
    server.close()
  }
}

console.log(`\n== learn suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
