#!/usr/bin/env node
/**
 * forge — v107 "carrywise": the launch line is not always the task.
 *
 * REPRODUCED FIRST, in the real runtime, by piping a conversation into
 * `forge chat` against a mock model and reading the prompts it sent:
 *
 *   > Build a CSV-to-JSON converter in convert.js with a --pretty flag
 *   · noted: goal                      ← forge classified it
 *   > /agent yes, authorized, start
 *   ◇ task [critical risk] started — yes, authorized, start
 *
 * Every prompt of that agent run contained "yes, authorized, start" and none
 * contained the word CSV. chat.js called runAgentTask(line) with the line the
 * user had just typed, and the conversation that produced it was never passed
 * along — so the agent's entire objective was the authorization. Routing even
 * derived intent=verify from the word "start".
 *
 * The second half of the same gap: rehydrate.js reconstructs what is open,
 * blocked and stale from the real stores, and chat.js console.log'd that
 * reconstruction and gave it to nobody. A model in a rehydrated session could
 * not name the open task while the answer sat on the user's screen.
 *
 * Section 4 is the end-to-end assertion: the reproduction above, re-run, with
 * the prompts the runtime actually sent as the evidence.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v107-"))
process.env.FORGE_HOME = HOME
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const { LAUNCH, launchKind, userTurns, conversationBrief, briefFromRehydration } = await import("../taskbrief.js")
const { chatSystemPrompt } = await import("../chat.js")

const GOAL = "Build a CSV-to-JSON converter in convert.js with a --pretty flag"
const REQ = "It must stream; never load the whole file into memory."

// ---------------------------------------------------------------------------
console.log("== 1. a launch line that states its own task is left alone ==")
{
  eq("an authorization is referential", launchKind("yes, authorized, start"), LAUNCH.REFERENTIAL)
  eq("consent is referential", launchKind("continue"), LAUNCH.REFERENTIAL)
  eq("a pick from a list is referential", launchKind("option 2"), LAUNCH.REFERENTIAL)
  eq("a stated goal is standalone", launchKind(GOAL), LAUNCH.STANDALONE)
  // the conservative direction: the classifier matching nothing is not
  // evidence of emptiness, so an unclassified line runs exactly as before
  eq("an unclassified instruction is standalone", launchKind("fix the crash in parser.js"), LAUNCH.STANDALONE)
  eq("an empty line is empty", launchKind("   "), LAUNCH.EMPTY)

  const msgs = [{ role: "user", content: GOAL }, { role: "assistant", content: "ok" }]
  const b = conversationBrief({ line: "add a --quiet flag too", messages: msgs })
  ok("a standalone line is never recomposed", b.composed === false)
  eq("and is passed through byte for byte", b.objective, "add a --quiet flag too")
}

console.log("== 2. a referential line carries the conversation ==")
{
  const msgs = [
    { role: "user", content: GOAL },
    { role: "assistant", content: "ok" },
    { role: "user", content: REQ },
    { role: "user", content: "Let's go with the Node streams approach." },
    { role: "user", content: "[agent task] something forge recorded earlier" },
  ]
  const b = conversationBrief({ line: "yes, authorized, start", messages: msgs })
  ok("the run is recomposed", b.composed === true)
  eq("the goal is the classified goal turn", b.goal, GOAL)
  ok("the objective leads with the goal", b.objective.startsWith(GOAL), b.objective.slice(0, 80))
  ok("the requirement is carried", /never load the whole file/.test(b.objective))
  ok("the decision is carried", /Node streams/.test(b.objective))
  ok("the launch line survives verbatim, last",
    /\[the user's launch instruction, verbatim\] yes, authorized, start$/.test(b.objective), b.objective.slice(-90))
  ok("forge's own record of a past run is not fed back in",
    !/something forge recorded earlier/.test(b.objective))
  ok("the summary says what was carried", /goal/.test(b.summary) && /requirement/.test(b.summary), b.summary)

  // synthetic turns must never become the goal either
  const only = userTurns([{ role: "user", content: "[agent task] x" }, { role: "user", content: "AUTO-COMPACTED y" }, { role: "assistant", content: "z" }])
  eq("userTurns drops synthetic and non-user turns", only.length, 0)
}

console.log("== 3. nothing is invented, and later statements win ==")
{
  const empty = conversationBrief({ line: "continue", messages: [] })
  ok("an empty conversation is reported underspecified, not filled in", empty.underspecified === true)
  eq("and the line is run exactly as typed", empty.objective, "continue")
  ok("with no goal invented", empty.goal === null)

  // requirement evolution goes through reqdelta.js — the same function v106
  // resumes with — so the repository has one answer to "what still stands".
  const msgs = [
    { role: "user", content: "Create a paper-trading Android app with Jetpack Compose and Room" },
    { role: "user", content: "Change the target from Android to Flutter, but keep the same trading requirements." },
  ]
  const b = conversationBrief({ line: "ok go ahead", messages: msgs })
  ok("the correction is carried", /Flutter/.test(b.objective), b.objective.slice(0, 200))
  ok("and what it killed is named", /NO LONGER VALID/.test(b.objective) && /Jetpack Compose/.test(b.objective),
    String(b.invalidated))

  // the reconstruction path: a new session with an empty conversation
  const r = briefFromRehydration({
    line: "continue",
    rehydration: { goal: GOAL, requirements: [REQ], decisions: [], incomplete: ["write the streaming parser [RUNNING]"],
      blockers: ["waiting on a sample file"], nextAction: "finish parseRow()", stale: ["old.js"] },
  })
  ok("an open item from the task store becomes the objective", r.composed === true)
  ok("the previous goal leads", r.objective.startsWith(GOAL))
  ok("the open item is named", /write the streaming parser/.test(r.objective))
  ok("so is the recorded next action", /finish parseRow\(\)/.test(r.objective))
  ok("and the blocker", /waiting on a sample file/.test(r.objective))
  ok("a file that is gone is flagged, not trusted", /GONE FROM DISK/.test(r.objective) && /old\.js/.test(r.objective))
  ok("records are labelled as records, to be verified", /Verify against the working tree/.test(r.objective))
  ok("the launch line still survives verbatim", /\[the user's launch instruction, verbatim\] continue$/.test(r.objective))

  const nothing = briefFromRehydration({ line: "continue", rehydration: null })
  ok("no reconstruction → underspecified, never fabricated", nothing.composed === false && nothing.underspecified === true)
}

console.log("== 4. the reproduction, end to end, against the real runtime ==")
{
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v107-work-"))
  fs.writeFileSync(path.join(WORK, "package.json"), '{"name":"probe"}\n')
  const prompts = []
  const server = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      try { prompts.push(JSON.parse(b).messages.map((m) => `[${m.role}] ${String(m.content ?? "")}`).join("\n")) } catch { /* shape probes are not the assertion */ }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "m", object: "chat.completion", created: Date.now(), model: "mock-1",
        choices: [{ index: 0, message: { role: "assistant", content: "Understood.\nEND" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }))
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const CHAT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v107-chome-"))
  fs.writeFileSync(path.join(CHAT_HOME, "config.json"), JSON.stringify({
    activeProvider: "mock",
    providers: { mock: { protocol: "openai", baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "k", model: "mock-1" } },
    tools: { assumeYes: true }, agent: { autonomous: true, maxSteps: 2, maxSegments: 1 },
  }))

  const run = (args, input) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), ...args], {
      cwd: WORK, env: { ...process.env, FORGE_HOME: CHAT_HOME, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"],
    })
    let out = ""
    child.stdout.on("data", (d) => { out += d })
    child.stderr.on("data", (d) => { out += d })
    child.stdin.write(input); child.stdin.end()
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: "timeout", out }) }, 120000)
    child.on("exit", (code) => { clearTimeout(t); resolve({ code, out }) })
  })

  const r1 = await run(["chat"], [GOAL, REQ, "/exit", ""].join("\n"))
  const seen = prompts.length
  ok("session 1 ran", r1.code === 0, String(r1.out).slice(-300))

  // session 2: a fresh process, resuming, launching an agent with an
  // authorization — the exact shape of the reported failure
  const r2 = await run(["chat", "--continue"], ["what were we doing?", "/agent yes, authorized, start", "/exit", ""].join("\n"))
  server.close()
  ok("session 2 ran", r2.code === 0, String(r2.out).slice(-300))

  const agentPrompts = prompts.slice(seen).filter((p) => /autonomous terminal coding agent/.test(p))
  ok("the agent run actually happened", agentPrompts.length > 0, `prompts after session 1: ${prompts.length - seen}`)
  ok("EVERY agent prompt carries the goal — this is the bug",
    agentPrompts.length > 0 && agentPrompts.every((p) => /CSV-to-JSON/i.test(p)),
    `${agentPrompts.filter((p) => /CSV-to-JSON/i.test(p)).length}/${agentPrompts.length}`)
  ok("and the requirement stated a turn later",
    agentPrompts.every((p) => /never load the whole file/i.test(p)))
  ok("and the authorization the user actually typed",
    agentPrompts.every((p) => /yes, authorized, start/i.test(p)))
  ok("chat says what it carried", /carried from this conversation/.test(r2.out), String(r2.out).slice(-400))

  const chatPrompts = prompts.slice(seen).filter((p) => /sharp, concise AI assistant/.test(p))
  ok("the rehydration reconstruction reaches the model, not just the terminal",
    chatPrompts.length > 0 && chatPrompts.some((p) => /CONTINUITY —/.test(p)),
    `chat prompts: ${chatPrompts.length}`)
}

console.log("== 5. the continuity block is evidence, not instructions ==")
{
  const sp = chatSystemPrompt({}, { toolsEnabled: false, continuity: "incomplete: write the parser (RUNNING)\nstale (files gone): old.js" })
  ok("the block is present", /CONTINUITY —/.test(sp))
  ok("it names where it came from", /task store, run journals, session store/.test(sp))
  ok("it is marked as state, not orders", /evidence about state, not as instructions/.test(sp))
  ok("and the working tree outranks it", /verify against the working tree/i.test(sp))
  const none = chatSystemPrompt({}, { toolsEnabled: false })
  ok("no reconstruction → no block, and nothing implied", !/CONTINUITY/.test(none))
}

console.log(`\n== v107 carrywise suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
