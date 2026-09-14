#!/usr/bin/env node
/**
 * v94 gapclose — SCRIPTED multi-step behavioral probes (TODO tool creation).
 *
 * Before: verifyTool ran ONE schema-shaped probe — enough for a pure
 * formatter, not enough for a multi-step tool (login → act → verify), which
 * could be promoted on evidence that never exercised its sequence. Now a
 * design may carry a `probeScript`: an ordered list of run() calls executed
 * IN ONE child process (module state carries between steps — the real
 * semantics of a multi-step tool), each step checked against the declared
 * output schema PLUS its own oracle (outputType / outputIncludes). VERIFIED
 * requires EVERY step to pass; a failing step is named in the evidence.
 *
 * Single-probe verification (no probeScript) is unchanged — pinned here too.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-toolms-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-toolms-work-"))
process.chdir(WORK)

const { designTool, implementTool, verifyTool, activateTool, readToolRecord, TOOL_LIFE } = await import("../toolcreate.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}

const INPUT = { type: "object", properties: { user: { type: "string" } }, required: ["user"] }
const OUTPUT = { type: "string" }

console.log("== probeScript validation blocks bad scripts at DESIGN time ==")
{
  const bad = [
    ["not-an-array", "probeScript must be an array"],
    [[], "empty script"],
    [Array.from({ length: 7 }, (_, i) => ({ args: {} })), "7 steps (cap is 6)"],
    [[{ args: {} }, "nope"], "non-object step"],
    [[{ args: {}, expect: { outputType: "banana" } }], "bad expect.outputType"],
  ]
  for (const [script, label] of bad) {
    const r = designTool({ cwd: WORK, name: `bad_${label.replace(/\W+/g, "_").slice(0, 20)}`, description: "a tool that should never be designed", task: "t", inputSchema: INPUT, outputSchema: OUTPUT, probeScript: script })
    ok(`blocked: ${label}`, r.ok === false && Array.isArray(r.blocked) && r.blocked.some((b) => /probeScript/.test(b)), JSON.stringify(r))
  }
}

console.log("== happy path: login → act, both steps pass → VERIFIED → ACTIVE ==")
{
  const d = designTool({
    cwd: WORK, name: "session_flow", description: "multi-step session tool for probe testing", task: "prove scripted verification",
    inputSchema: INPUT, outputSchema: OUTPUT, capabilities: ["session"],
    probeScript: [
      { name: "login", args: { user: "alice" }, expect: { outputType: "string", outputIncludes: "alice" } },
      { name: "act", args: { user: "bob" }, expect: { outputIncludes: "bob" } },
    ],
  })
  ok("design accepted the script", d.ok === true && d.record.probeScript?.length === 2, JSON.stringify(d.blocked ?? d.record?.probeScript))
  ok("record lifecycle CANDIDATE", d.record.lifecycle === TOOL_LIFE.CANDIDATE)
  const impl = implementTool(WORK, "session_flow")
  ok("implementation written", impl.ok === true, JSON.stringify(impl))
  const v = await verifyTool(WORK, "session_flow")
  ok("verification passed", v.ok === true, JSON.stringify(v.evidence ?? v).slice(0, 300))
  ok("evidence says probe-script mode with per-step records", v.evidence.mode === "probe-script" && v.evidence.steps.length === 2, JSON.stringify(v.evidence?.steps?.map((s) => s.name)))
  ok("every step ran and matched its oracle", v.evidence.steps.every((s) => s.ran && s.matched), JSON.stringify(v.evidence.steps))
  ok("step names are the declared ones", v.evidence.steps.map((s) => s.name).join(",") === "login,act")
  const rec = readToolRecord(WORK, "session_flow")
  ok("lifecycle VERIFIED", rec.lifecycle === TOOL_LIFE.VERIFIED)
  ok("tests list carries one entry per step + the overall run", rec.tests.some((t) => t.name === "behavioral-run" && t.mode === "probe-script") && rec.tests.filter((t) => t.name.startsWith("probe-step:")).length === 2, JSON.stringify(rec.tests?.map((t) => t.name)))
  const act = activateTool(WORK, "session_flow")
  ok("VERIFIED activates (promotion gate intact)", act.ok === true && act.lifecycle === TOOL_LIFE.ACTIVE, JSON.stringify(act))
}

console.log("== a step whose oracle fails → INACTIVE, and the step is NAMED ==")
{
  designTool({
    cwd: WORK, name: "broken_flow", description: "multi-step tool with an impossible second step", task: "prove the oracle bites",
    inputSchema: INPUT, outputSchema: OUTPUT,
    probeScript: [
      { name: "login", args: { user: "alice" }, expect: { outputIncludes: "alice" } },
      { name: "act", args: { user: "bob" }, expect: { outputIncludes: "IMPOSSIBLE-TOKEN-42" } },
    ],
  })
  implementTool(WORK, "broken_flow")
  const v = await verifyTool(WORK, "broken_flow")
  ok("verification failed", v.ok === false, JSON.stringify(v).slice(0, 200))
  ok("lifecycle INACTIVE (never quietly promoted)", readToolRecord(WORK, "broken_flow").lifecycle === TOOL_LIFE.INACTIVE)
  ok("the failing step is named", v.failedStep === "act", JSON.stringify(v.failedStep))
  ok("step evidence shows WHICH expectation failed", v.evidence.steps[0].matched === true && v.evidence.steps[1].matched === false && v.evidence.steps[1].expectations.outputIncludes === false, JSON.stringify(v.evidence.steps.map((s) => s.expectations)))
  const act = activateTool(WORK, "broken_flow")
  ok("INACTIVE without passing verification cannot activate", act.ok === false, JSON.stringify(act))
}

console.log("== a step missing required args is caught by the oracle, not by exit code ==")
{
  designTool({
    cwd: WORK, name: "missing_arg_flow", description: "second step forgets the required argument", task: "prove oracles catch soft errors",
    inputSchema: INPUT, outputSchema: OUTPUT,
    probeScript: [
      { name: "login", args: { user: "alice" }, expect: { outputIncludes: "alice" } },
      // the generated run() returns "ERROR: missing required argument: user" —
      // exit 0, string output: only the step oracle catches this
      { name: "act", args: {}, expect: { outputIncludes: "input:" } },
    ],
  })
  implementTool(WORK, "missing_arg_flow")
  const v = await verifyTool(WORK, "missing_arg_flow")
  ok("soft-error step fails verification despite exit 0", v.ok === false && v.failedStep === "act", JSON.stringify({ ok: v.ok, failedStep: v.failedStep }))
  ok("the step DID run (ran=true) — the oracle rejected its output", v.evidence.steps[1].ran === true && v.evidence.steps[1].matched === false, JSON.stringify(v.evidence.steps[1]))
}

console.log("== backward compatibility: single probe (no script) is unchanged ==")
{
  designTool({ cwd: WORK, name: "single_probe", description: "classic single-probe tool", task: "compat", inputSchema: INPUT, outputSchema: OUTPUT })
  implementTool(WORK, "single_probe")
  const v = await verifyTool(WORK, "single_probe", { args: { user: "zoe" } })
  ok("single-probe verification passes", v.ok === true, JSON.stringify(v).slice(0, 200))
  ok("evidence is the classic shape (no probe-script mode)", v.evidence && v.evidence.mode === undefined && v.evidence.outputMatchedSchema === true && Array.isArray(v.evidence.steps) === false, JSON.stringify(Object.keys(v.evidence ?? {})))
  ok("lifecycle VERIFIED", readToolRecord(WORK, "single_probe").lifecycle === TOOL_LIFE.VERIFIED)
}

console.log(`\n== toolcreate-multistep suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
