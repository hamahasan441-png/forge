#!/usr/bin/env node
/**
 * forge — v101 "authoritywise": the governor CONTROLS the live loop.
 *
 * v100 chose INSPECT/VERIFY/ASK/STOP and emitted an event. The model still
 * picked every tool. This suite proves the action is now authority:
 *
 *   ASK  → run ends WAITING_FOR_USER, no further writes
 *   VERIFY → write tools are hidden AND a post-write write is BLOCKED
 *   STOP → requires real verified work (never halt before the first mutation)
 *   per-step (governor) directive is in the model request
 *
 * Isolated FORGE_HOME. Mock LLM. Zero network.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-auth-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + extra : ""}`) }
}

const {
  ACTION, authorityFor, maskToolDefs, enforceToolCall, chooseNextAction,
  GOV_PREFIX, formatGovernorMessage, WRITE_TOOL_NAMES,
} = await import("../governor.js")
const { createCognition, COGNITION_VERSION } = await import("../cognition.js")
const { createTaskContract } = await import("../contract.js")
const { createUserModel } = await import("../usermodel.js")
const { VERSION } = await import("../version.js")

console.log("== version identity ==")
{
  ok("package version is 113.x", /^113\./.test(VERSION), VERSION)
  ok("cognition protocol is 1.5.x", /^1\.5\./.test(COGNITION_VERSION), COGNITION_VERSION)
}

console.log("== STOP never fires before work exists ==")
{
  const c = createTaskContract({ originalIntent: "fix typo" })
  const stop = chooseNextAction({
    klass: "MICRO", contract: c, user: createUserModel(),
    inspected: true, hasPlan: true, steps: 2, writes: 0, unverified: [],
  })
  ok("MICRO with no writes is EXECUTE, not STOP", stop.action === ACTION.EXECUTE, stop.action)
  const after = chooseNextAction({
    klass: "MICRO", contract: c, inspected: true, hasPlan: true,
    steps: 4, writes: 1, unverified: [], verified: true,
  })
  ok("MICRO after a verified write MAY stop", after.action === ACTION.STOP || after.action === ACTION.EXECUTE, after.action)
}

console.log("== authority scales with class ==")
{
  const microI = authorityFor(ACTION.INSPECT, { klass: "SMALL" })
  ok("SMALL INSPECT is directive-only (existing one-shot paths keep writes)", microI.enforce === false && microI.hideWrites === false)
  const largeI = authorityFor(ACTION.INSPECT, { klass: "ARCHITECTURAL" })
  ok("ARCHITECTURAL INSPECT hides writes", largeI.enforce === true && largeI.hideWrites === true)
  ok("...and forbids write_file", largeI.forbidden.includes("write_file"))

  const ask = authorityFor(ACTION.ASK, { klass: "SMALL" })
  ok("ASK always halts, even on SMALL", ask.halt === true && ask.waitForUser === true && ask.enforce === true)
  const stop = authorityFor(ACTION.STOP, { klass: "MICRO" })
  ok("STOP always halts", stop.halt === true && stop.enforce === true)

  const vSmall = authorityFor(ACTION.VERIFY, { klass: "SMALL" })
  ok("SMALL VERIFY is not a hard write-block (verify-nudge already exists)", vSmall.enforce === false)
  const vLarge = authorityFor(ACTION.VERIFY, { klass: "LARGE" })
  ok("LARGE VERIFY hard-blocks write_file", vLarge.enforce === true && enforceToolCall("write_file", vLarge).ok === false)
  ok("LARGE VERIFY still allows bash", enforceToolCall("bash", vLarge).ok === true)
  ok("LARGE VERIFY still allows read_file", enforceToolCall("read_file", vLarge).ok === true)
}

console.log("== maskToolDefs actually drops writes ==")
{
  const defs = [
    { function: { name: "read_file" } },
    { function: { name: "write_file" } },
    { function: { name: "edit_file" } },
    { function: { name: "bash" } },
    { function: { name: "think" } },
  ]
  const masked = maskToolDefs(defs, authorityFor(ACTION.INSPECT, { klass: "ARCHITECTURAL" }))
  const names = masked.map((d) => d.function.name)
  ok("INSPECT advertises read_file", names.includes("read_file"))
  ok("INSPECT advertises think", names.includes("think"))
  ok("INSPECT does not advertise write_file", !names.includes("write_file"))
  ok("INSPECT does not advertise edit_file", !names.includes("edit_file"))
  const asked = maskToolDefs(defs, authorityFor(ACTION.ASK, { klass: "SMALL" }))
  ok("ASK advertises no tools", asked.length === 0)
  const untouched = maskToolDefs(defs, authorityFor(ACTION.INSPECT, { klass: "SMALL" }))
  ok("SMALL INSPECT does not mask (enforce=false)", untouched.length === defs.length)
}

console.log("== cognition.enforce matches governor ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-auth-cog-"))
  const cog = createCognition({ cwd: dir, objective: "Make Forge smarter" })
  const n = cog.next({ steps: 0, writes: 0, unverified: [], inspected: false })
  ok("first action on ambiguous forge-self is INSPECT", n.action === ACTION.INSPECT, n.action)
  const after = cog.next({ steps: 2, writes: 0, unverified: [], inspected: true, hasPlan: true })
  ok("after inspect, ASK (do not silently pick a meaning)", after.action === ACTION.ASK, after.action)
  const auth = cog.enforce(after)
  ok("ASK authority waits for the user", auth.waitForUser === true && auth.halt === true)
  ok("step directive carries the GOV_PREFIX", cog.stepDirective(after, auth).startsWith(GOV_PREFIX))
  ok("formatGovernorMessage is the same shape", formatGovernorMessage(after, auth).includes("GOVERNOR: ASK"))
}

console.log("== DEFAULT agent path source is wired ==")
{
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "agent.js"), "utf8")
  ok("agent imports maskToolDefs", /maskToolDefs/.test(src))
  ok("agent imports enforceToolCall", /enforceToolCall/.test(src))
  ok("agent sets WAITING_FOR_USER", /WAITING_FOR_USER/.test(src))
  ok("agent emits TOOL_BLOCKED on governor refuse", /TOOL_BLOCKED/.test(src))
  ok("agent injects per-step governor message", /upsertGovernorMessage/.test(src))
  ok("agent does not only narrate GOVERNOR_ACTION", /lastAuth\.waitForUser/.test(src) && /enforceToolCall/.test(src))
}

function mkModel(script, seen) {
  let calls = 0
  const server = http.createServer((req, res) => {
    if (!req.url.includes("chat/completions")) { res.writeHead(404).end(); return }
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      seen.push(b)
      const message = script(++calls)
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

async function run(task, script, { events } = {}) {
  const seen = []
  const server = mkModel(script, seen)
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-auth-run-"))
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n")
  fs.writeFileSync(path.join(dir, "auth.js"), "export const x = 1\n")
  const prev = process.cwd()
  const evs = events || []
  try {
    process.chdir(dir)
    const { runAgent } = await import("../agent.js")
    const res = await runAgent({
      config: {
        providers: {},
        tools: { assumeYes: true, mcp: false, plugins: false, lsp: false, browser: false },
        agent: { autonomous: false, maxSteps: 10, verifyNudge: false, review: "off", continuity: false },
        skills: { enabled: false },
        mcp: { maxTools: 0 },
      },
      provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "k", model: "mock-1" },
      task,
      journal: false,
      onEvent: (e) => evs.push(e),
    })
    return { res, seen, dir, evs }
  } finally {
    process.chdir(prev)
    server.close()
  }
}

console.log("== ASK on the REAL agent path freezes the run ==")
{
  let writes = 0
  const script = (n) => {
    if (n === 1) return call("r1", "read_file", { path: "README.md" })
    writes++
    return call("w1", "write_file", { path: "smart.js", content: "export const smarter = true\n" })
  }
  const { res, seen, evs } = await run("Make Forge smarter", script)
  ok("status is WAITING_FOR_USER, not COMPLETED", res.status === "WAITING_FOR_USER", res.status)
  ok("reason is GOVERNOR_ASK", res.reason === "GOVERNOR_ASK", res.reason)
  ok("governor reports ASK", res.governor?.action === ACTION.ASK, JSON.stringify(res.governor))
  ok("write_file was never executed (no smart.js mutation in toolLog)", !res.toolLog.some((t) => t.name === "write_file" && !String(t.result).startsWith("BLOCKED")))
  ok("a DECISION_NEEDED event fired", evs.some((e) => e.type === "DECISION_NEEDED"))
  ok("a GOVERNOR_ACTION ASK event fired", evs.some((e) => e.type === "GOVERNOR_ACTION" && e.action === "ASK"))
  const bodies = seen.join("\n")
  ok("a per-step (governor) directive reached the model", bodies.includes(GOV_PREFIX) || bodies.includes("GOVERNOR:"))
  ok("the model was not asked to keep going after ASK", writes === 0 || res.toolLog.filter((t) => t.name === "write_file").length === 0, `writes=${writes}`)
}

console.log("== VERIFY on the REAL agent path blocks a second write ==")
{
  const script = (n) => {
    if (n === 1) return call("t1", "think", { thought: "plan: smallest rewrite of auth.js" })
    if (n === 2) return call("r1", "read_file", { path: "auth.js" })
    if (n === 3) return call("w1", "write_file", { path: "auth.js", content: "export const x = 2\n" })
    if (n === 4) return call("w2", "write_file", { path: "auth.js", content: "export const x = 3\n" })
    return { role: "assistant", content: "rewrote auth" }
  }
  const evs = []
  const { res } = await run("rewrite the auth architecture across files", script, { events: evs })
  const blocked = res.toolLog.filter((t) => t.name === "write_file" && String(t.result).startsWith("BLOCKED"))
  const okWrites = res.toolLog.filter((t) => t.name === "write_file" && !String(t.result).startsWith("BLOCKED") && !String(t.result).startsWith("ERROR"))
  ok("at least one write landed before VERIFY", okWrites.length >= 1, `ok=${okWrites.length} blocked=${blocked.length} log=${res.toolLog.map((t) => t.name).join(",")}`)
  ok("a later write was BLOCKED by the governor", blocked.length >= 1, `blocked=${blocked.length} actions=${evs.filter((e) => e.type === "GOVERNOR_ACTION").map((e) => e.action).join(",")}`)
  ok("TOOL_BLOCKED event fired", evs.some((e) => e.type === "TOOL_BLOCKED"))
  ok("VERIFY or REPLAN froze further writes", evs.some((e) => e.type === "GOVERNOR_ACTION" && (e.action === "VERIFY" || e.action === "REPLAN")))
}

console.log("== MICRO path is not frozen by INSPECT ==")
{
  const script = (n) => n === 1
    ? call("w1", "write_file", { path: "note.txt", content: "typo fixed\n" })
    : { role: "assistant", content: "Fixed the typo in note.txt." }
  const { res } = await run("fix a typo in note.txt", script)
  ok("MICRO write was not blocked", res.toolLog.some((t) => t.name === "write_file" && !String(t.result).startsWith("BLOCKED")))
  ok("MICRO is not WAITING_FOR_USER", res.status !== "WAITING_FOR_USER", res.status)
}

console.log(`\n== authority suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
