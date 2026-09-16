#!/usr/bin/env node
/**
 * forge — v112 "criticwise": doomed mutations do not run on the default path.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-critic-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"
delete process.env.FORGE_CRITIQUE

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + extra : ""}`) }
}

const { VERSION } = await import("../version.js")
const { critiqueVerdict, preMutationCritique } = await import("../critique.js")
const { createToolIntel } = await import("../toolintel.js")
const { makeToolContext } = await import("../tools.js")

const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-critic-proj-"))
fs.writeFileSync(path.join(work, "lib.js"), "module.exports = 1\n")

console.log("== version identity ==")
{
  ok("package version is 117.x", /^122\./.test(VERSION), VERSION)
}

console.log("== verdicts ==")
{
  const missing = preMutationCritique({ tool: "edit_file", args: { path: "ghost.js", old: "a", new: "b" }, cwd: work })
  const v = critiqueVerdict(missing, { klass: "LARGE" })
  ok("missing edit is BLOCK", v.action === "BLOCK" && v.block === true, JSON.stringify(v))
  const micro = critiqueVerdict(missing, { klass: "MICRO" })
  ok("MICRO missing edit stays advisory", micro.action === "advisory" && !micro.block, JSON.stringify(micro))
  const secret = preMutationCritique({ tool: "edit_file", args: { path: ".env", old: "a", new: "b" }, cwd: work })
  ok("secret is ASK", critiqueVerdict(secret, { klass: "LARGE" }).action === "ASK")
  const thrash = preMutationCritique({
    tool: "edit_file", args: { path: "lib.js", old: "a", new: "b" }, cwd: work,
    mutationCounts: new Map([["lib.js", 3]]),
  })
  ok("thrash is REPLAN", critiqueVerdict(thrash, { klass: "LARGE" }).action === "REPLAN")
  const clean = preMutationCritique({ tool: "edit_file", args: { path: "lib.js", old: "a", new: "b" }, cwd: work })
  ok("clean is allow", critiqueVerdict(clean, { klass: "LARGE" }).action === "allow")
}

console.log("== intel actually blocks before exec ==")
{
  let execs = 0
  const tools = makeToolContext({
    cwd: work, root: work, timeoutSec: 10, maxToolOutput: 4000,
    memoryPath: path.join(work, "memory.md"), todoPath: path.join(work, "todo.json"),
  })
  const exec = async (name, args) => { execs++; return tools.exec(name, args) }
  const events = []
  const intel = createToolIntel({
    exec, ctx: { cwd: work, root: work }, config: {},
    onEvent: (e) => events.push(e), runId: "r", taskId: "t", task: "fix auth",
    klass: "LARGE",
  })
  const res = await intel.runCall({ name: "edit_file", args: { path: "ghost.js", old: "a", new: "b" } }, { step: 1 })
  ok("result is BLOCKED", /^BLOCKED: \(critique\) BLOCK/.test(String(res.result)), String(res.result).slice(0, 200))
  ok("exec never ran", execs === 0, String(execs))
  ok("TOOL_CRITIQUE fired", events.some((e) => e.type === "TOOL_CRITIQUE"))
  ok("TOOL_BLOCKED fired", events.some((e) => e.type === "TOOL_BLOCKED" && e.critique === true))
}

console.log("== MICRO still one-shot (advisory, not blocked) ==")
{
  let execs = 0
  const tools = makeToolContext({
    cwd: work, root: work, timeoutSec: 10, maxToolOutput: 4000,
    memoryPath: path.join(work, "m.md"), todoPath: path.join(work, "t.json"),
  })
  const exec = async (name, args) => { execs++; return tools.exec(name, args) }
  const intel = createToolIntel({
    exec, ctx: { cwd: work, root: work }, config: {},
    klass: "MICRO",
  })
  const res = await intel.runCall({ name: "edit_file", args: { path: "ghost.js", old: "a", new: "b" } }, { step: 1 })
  ok("MICRO reached exec", execs === 1, String(execs))
  ok("MICRO is not critique-BLOCKED", !/^BLOCKED: \(critique\)/.test(String(res.result)), String(res.result).slice(0, 120))
}

console.log("== live path is wired ==")
{
  const agent = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  ok("agent passes klass into tool intel", /klass:\s*earlyKlass/.test(agent))
  ok("agent ASK-halts on critique ASK", /CRITIQUE_ASK/.test(agent))
  ok("no CritiqueManager", !fs.existsSync(new URL("../critiquemanager.js", import.meta.url)))
}

console.log(`\n== critic suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
