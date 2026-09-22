#!/usr/bin/env node
/**
 * forge — v131 "onewise": the controller is the default loop, and think() records.
 *
 * Reproduced against the repository, not the docs.
 *
 * 1. TWO PREDICATES, TWO ANSWERS. chat.js used
 *    `autonomous !== false && !ui` so interactive Agent Mode was one-shot.
 *    forge.js used `flags.auto || autonomous === "meta"` so boolean true —
 *    the value defaultConfig ships — never entered the controller. Piped
 *    chat used Core; `forge agent` and TTY /agent did not. The DAG, plan
 *    critique, code review, gitship and invalidateNodes this repo already
 *    owns were a different product.
 *
 * 2. think() SAID it recorded and did not. The return string was a lie.
 *
 * v131 is one predicate (useController) consumed by both call sites, a
 * printed `loop: controller|direct` so the path is inspectable, and a
 * think() that appends to ctx.thoughts.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v131-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { useController, defaultConfig } = await import("../config.js")
const { makeToolContext } = await import("../tools.js")

console.log("== 1. useController: one predicate, the cases that used to disagree ==")
{
  const shipped = defaultConfig().agent.autonomous
  eq("defaultConfig still ships autonomous: true", shipped, true)
  eq("that boolean NOW means controller (forge.js used to ignore it)", useController({ autonomous: shipped }), true)
  eq("the historical string 'meta' still means controller", useController({ autonomous: "meta" }), true)
  eq("--auto still means controller even if autonomous is off", useController({ autonomous: false, auto: true }), true)
  eq("plan-only never takes the controller", useController({ planOnly: true, autonomous: true, auto: true }), false)
  eq("autonomous:false is the one-shot opt-out", useController({ autonomous: false }), false)
  eq("'off' is the same opt-out", useController({ autonomous: "off" }), false)
  eq("'direct' is the same opt-out", useController({ autonomous: "direct" }), false)
  eq("resume always takes the controller (v96 law, kept)", useController({ planOnly: false, resumeTaskId: "t-1", autonomous: false }), true)
  eq("resume does not override plan-only", useController({ planOnly: true, resumeTaskId: "t-1" }), false)
  eq("undefined autonomous defaults to controller (product default)", useController({}), true)
  ok("TTY is not an argument of the predicate — that was the split", !/ui/.test(Function.prototype.toString.call(useController)))
}

console.log("== 2. both production callers consume the SAME function ==")
{
  const chatSrc = fs.readFileSync(path.join(ROOT, "chat.js"), "utf8")
  const forgeSrc = fs.readFileSync(path.join(ROOT, "forge.js"), "utf8")
  ok("chat.js imports useController", /import \{[^}]*useController[^}]*\} from "\.\/config\.js"/.test(chatSrc))
  ok("forge.js imports useController", /import \{[^}]*useController[^}]*\} from "\.\/config\.js"/.test(forgeSrc))
  ok("chat.js calls it (not a comment)", /useController\(\{ planOnly, resumeTaskId, autonomous:/.test(chatSrc))
  ok("forge.js calls it", /useController\(\{ planOnly: planMode, autonomous:/.test(forgeSrc))
  ok("chat.js no longer has the TTY exemption", !/autonomous !== false && !ui/.test(chatSrc))
  ok("forge.js no longer requires the string 'meta' to enter Core", !/autonomous === ["']meta["']/.test(forgeSrc))
  ok("chat.js prints the loop it took", /loop: controller/.test(chatSrc) && /loop: direct/.test(chatSrc))
  ok("forge.js prints the loop it took", /loop: controller/.test(forgeSrc) && /loop: direct/.test(forgeSrc))
  ok("chat.js adapter carries the controller's tool count (empty toolLog used to print 0)", /toolCallsTotal:\s*m\.toolCalls/.test(chatSrc))
  ok("forge.js adapter carries the controller's tool count", /toolCallsTotal:\s*m\.toolCalls/.test(forgeSrc))
  const viewSrc = fs.readFileSync(path.join(ROOT, "agentview.js"), "utf8")
  ok("printResult prefers toolCallsTotal over an empty adapted toolLog", /toolCallsTotal/.test(viewSrc) && /nTools/.test(viewSrc))
  const agentSrc = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8")
  ok("the agent loop hands onEvent to the tool context (think() can emit)", /makeToolContext\(\{[\s\S]*?\bonEvent,/.test(agentSrc))
  const mockSrc = fs.readFileSync(path.join(ROOT, "tests/mock-llm.mjs"), "utf8")
  ok("mock matches tool needles against the current-task head (Core extraContext cannot steal the branch)", mockSrc.includes("currentTask") && mockSrc.includes('t.indexOf("\\n\\n")'))
  ok("OpenAI USE_TOOL does not steal the Anthropic USE_TOOL_A needle", mockSrc.includes('!currentTask.includes("USE_TOOL_A")'))
  ok("Anthropic mock matches USE_TOOL_A against the current-task head, not whole history", mockSrc.includes("currentTaskA") && mockSrc.includes("USE_TOOL_A"))
  ok("mock still answers TOOL RESULT RECEIVED after a verify-nudge (write-tool e2e)", mockSrc.includes("wantsVerifyNudge") && mockSrc.includes("you changed files"))
  const e2eSrc = fs.readFileSync(path.join(ROOT, "tests/e2e-forge.sh"), "utf8")
  ok("e2e pins the one-shot printer for the historical contract", e2eSrc.includes('"agent":{"autonomous":false}') || e2eSrc.includes("autonomous\":false"))
  ok("e2e still proves the shipped default is the controller", e2eSrc.includes("v131 default loop is controller") && e2eSrc.includes("loop: controller"))
  ok("e2e still proves the controller executes (bash + v88 outside rm)", e2eSrc.includes("v131 controller still runs bash") && e2eSrc.includes("v131 controller still removes outside target"))
  const cl = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8")
  const firstH = /^##\s+.+$/m.exec(cl)?.[0] ?? ""
  ok("CHANGELOG first heading stays the package version (named suite is ###)", /122\.0\.0/.test(firstH) && /^### v131 /m.test(cl))
  const metaSrc = fs.readFileSync(path.join(ROOT, "meta.js"), "utf8")
  const planCatch = metaSrc.split("PLAN_FAILED")[1]?.slice(0, 1200) || ""
  ok("planning abort is CANCELLED, not a parked WAITING recovery", planCatch.includes("AbortError") && planCatch.includes("FINAL.CANCELLED") && planCatch.includes("cancelled by user"))
  ok("TTY CANCELLED uses the abort renderer, not ✓ COMPLETED", /m\.status === "CANCELLED"[\s\S]{0,250}aborted: true/.test(chatSrc))
  ok("controller recovery [C] parks WAITING so the nag does not repeat", /left as-is at recovery[\s\S]{0,200}TASK_STATUS\.WAITING/.test(chatSrc) || /TASK_STATUS\.WAITING[\s\S]{0,200}left as-is at recovery/.test(chatSrc))
}

console.log("== 3. think() records, and the old lie is gone ==")
{
  const src = fs.readFileSync(path.join(ROOT, "tools.js"), "utf8")
  ok("the 'Noted. Reasoning recorded' lie is gone", !src.includes("Noted. Reasoning recorded"))
  const events = []
  const tools = makeToolContext({ cwd: HOME, root: HOME, onEvent: (e) => events.push(e) })
  const ctx = tools.ctx
  eq("a fresh context has an empty thoughts log", ctx.thoughts, [])
  const { execTool } = await import("../tools.js")
  const miss = await execTool(ctx, "think", { thought: "   " })
  ok("empty thought is still an error", String(miss).startsWith("ERROR:"))
  eq("empty does not append", ctx.thoughts.length, 0)
  const thought = "check the auth cookie path before rewriting session.js"
  const hit = await execTool(ctx, "think", { thought })
  ok("a real thought returns Recorded with a length", String(hit).includes(`Recorded (${thought.length} chars)`), String(hit))
  eq("ctx.thoughts has one entry", ctx.thoughts.length, 1)
  ok("the text is the thought, not a paraphrase", ctx.thoughts[0].text === thought)
  ok("an event was emitted on the live reasoning vocabulary (the dock already renders it)", events.some((e) => e.type === "reasoning" && e.source === "think" && e.chars === thought.length), JSON.stringify(events))
}

console.log(`\n== v131 onewise suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
