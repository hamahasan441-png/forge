#!/usr/bin/env node
/**
 * forge — v108 "rootwise": memory that survives, and an answer that knows its
 * question.
 *
 * FOUR DEFECTS, ALL REPRODUCED AGAINST THE REAL RUNTIME BEFORE ANY FIX:
 *
 *  1. `forge tasks --resume <valid id>` printed "✗ p is not defined" and exited
 *     1. forge.js:661 referenced `p` and `cfg`, neither declared in that case
 *     block. The guard above it masked the crash for UNKNOWN ids, so the
 *     documented way to resume an interrupted task failed precisely when it was
 *     meant to work — it had never once reached a model.
 *
 *  2. Memory died on `cd`. projectHash was sha1 of the ABSOLUTE cwd, and
 *     sessions/tasks/runs each compared absolute paths for equality:
 *         from repo      → memory present, session found, 1 task
 *         from repo/src  → memory "",     session null,  0 tasks
 *     Same repository. 34 production call sites go through projectDir(cwd), so
 *     that one key addresses nearly every store forge owns.
 *
 *  3. forge could ask a question and NOBODY could answer it. ask() persisted it
 *     and moved the task to WAITING_FOR_USER; core.answerDecision() was the only
 *     resolver in the repository and had no production caller; /decision merely
 *     listed questions and said "answer in the running forge session", which is
 *     not a thing that exists. A later run found it still PENDING and was
 *     refused permission to re-ask: "asked recently — do not nag the user".
 *
 *  4. A finished task's requirements blocked an unrelated later one.
 *     requirementRecords() filtered by layer and status but not by owner, so
 *     meta.js handed task B every requirement task A had ingested and turned
 *     each uncovered one into a blocking required action — false INCOMPLETION.
 *
 * And memory rotted: markFilesChanged sent records citing an edited file to
 * STALE, retrieve() hid them, and revalidate()/markVerified() had no production
 * caller — a one-way door to invisible.
 *
 * Section 8 is the end-to-end assertion: two real `forge chat` processes against
 * a mock model, the second started in a SUBDIRECTORY, and the prompts the
 * runtime actually sent as the evidence.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v108-"))
process.env.FORGE_HOME = HOME
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

/** A repo-shaped temp project with a subdirectory. */
function mkRepo(tag) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), `forge-v108-${tag}-`))
  fs.mkdirSync(path.join(r, ".git"), { recursive: true })
  fs.mkdirSync(path.join(r, "src", "deep"), { recursive: true })
  fs.writeFileSync(path.join(r, "package.json"), '{"name":"probe"}\n')
  return r
}

const { projectRoot, sameProject } = await import("../projectkey.js")

// ---------------------------------------------------------------------------
console.log("== 1. one project identity, wherever you are standing in it ==")
{
  const R = mkRepo("pk")
  eq("the root is itself", projectRoot(R), path.resolve(R))
  eq("a subdirectory resolves to the root", projectRoot(path.join(R, "src")), path.resolve(R))
  eq("so does a deep one", projectRoot(path.join(R, "src", "deep")), path.resolve(R))
  ok("sameProject agrees", sameProject(R, path.join(R, "src", "deep")))

  // no VCS marker: the HIGHEST enclosing manifest, so a plain source tree still agrees
  const P = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v108-man-"))
  fs.writeFileSync(path.join(P, "package.json"), "{}")
  fs.mkdirSync(path.join(P, "lib"))
  eq("a manifest marks the root when there is no .git", projectRoot(path.join(P, "lib")), path.resolve(P))

  // nothing at all: unchanged from before v108 — a lone directory is its own project
  const N = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v108-bare-"))
  eq("a directory in no project is its own", projectRoot(N), path.resolve(N))
  ok("two unrelated directories are not one project", sameProject(N, P) === false)
}

console.log("== 2. THE REPRODUCTION: memory no longer dies on `cd` ==")
{
  const R = mkRepo("cwd")
  const SUB = path.join(R, "src")
  const mem = await import("../memory.js")
  const sess = await import("../sessions.js")
  const tstate = await import("../taskstate.js")

  eq("the project key is the same from a subdirectory", mem.projectHash(SUB), mem.projectHash(R))

  mem.appendMemory("project", "the parser must stream, never buffer the whole file", R)
  const fromRoot = String(mem.relevantMemory("parser", { cwd: R }) ?? "")
  const fromSub = String(mem.relevantMemory("parser", { cwd: SUB }) ?? "")
  ok("memory written at the root is recalled at the root", /never buffer/.test(fromRoot))
  ok("and recalled from a subdirectory — this is the bug", /never buffer/.test(fromSub), JSON.stringify(fromSub))
  ok("the block names the PROJECT, not the subdirectory", !/\(src\)/.test(fromSub), fromSub.split("\n")[0])

  sess.saveSession({ provider: "mock", model: "m", messages: [{ role: "user", content: "Build a CSV parser" }], cwd: R, title: "Build a CSV parser" })
  eq("the session is found from the root", sess.latestSessionForCwd(R)?.title, "Build a CSV parser")
  eq("and from a subdirectory", sess.latestSessionForCwd(SUB)?.title, "Build a CSV parser")

  const ts = tstate.openTask("t-v108-cwd", { create: true, objective: "write the streaming parser", cwd: R })
  ts.save?.()
  eq("open tasks are listed from the root", tstate.listTasks({ cwd: R }).length, 1)
  eq("and from a subdirectory", tstate.listTasks({ cwd: SUB }).length, 1)

  // and a genuinely different project stays separate — the fix must not merge everything
  const OTHER = mkRepo("other")
  eq("an unrelated project sees none of it", tstate.listTasks({ cwd: OTHER }).length, 0)
  ok("and none of its memory", !/never buffer/.test(String(mem.relevantMemory("parser", { cwd: OTHER }) ?? "")))
}

console.log("== 3. forge asks a question, and it can be answered ==")
{
  const R = mkRepo("dec")
  const { openTask, readTask, TASK_STATUS } = await import("../taskstate.js")
  const de = await import("../decisionengine.js")

  const ts = openTask("t-v108-dec", { create: true, objective: "build the parser", cwd: R })
  ts.transition(TASK_STATUS.PLANNING, {})
  ts.transition(TASK_STATUS.WAITING_FOR_USER, { reason: "decision pending" })
  ts.save?.()

  const eng = de.createDecisionEngine({ cwd: R, taskId: "t-v108-dec" })
  const asked = eng.ask({ title: "Storage backend", question: "Which storage backend should the parser write to?",
    options: [{ id: "a", label: "SQLite" }, { id: "b", label: "flat JSON" }], key: "storage-backend" })
  eq("the question is pending", asked.status, "PENDING")
  eq("and the task is waiting on the human", readTask("t-v108-dec").status, "WAITING_FOR_USER")

  const answered = de.answerDecision({ cwd: R, ref: "storage-backend", choice: "SQLite" })
  ok("the answer is recorded", answered?.status === "ANSWERED" && answered.answer === "SQLite", JSON.stringify(answered?.answer))
  ok("the task stops waiting on the human — this is the bug",
    readTask("t-v108-dec").status !== TASK_STATUS.WAITING_FOR_USER, readTask("t-v108-dec").status)

  const later = de.createDecisionEngine({ cwd: R })
  eq("nothing is left pending", later.pendingList().length, 0)
  const gate = later.shouldAsk("storage-backend")
  ok("and a later run is not refused for the wrong reason",
    gate.ask === false && /already answered/.test(gate.why), JSON.stringify(gate))

  // answering something that was never asked invents nothing
  ok("an unknown reference answers nothing", de.answerDecision({ cwd: R, ref: "no-such-key", choice: "x" }) === null)
  ok("and a missing reference is refused", de.answerDecision({ cwd: R, choice: "x" }) === null)
}

console.log("== 4. an answer carries the question it answers ==")
{
  const { conversationBrief, lastQuestionAsked, isAnswerLike } = await import("../taskbrief.js")
  const GOAL = "Build a CSV-to-JSON converter in convert.js with a --pretty flag"
  const msgs = [
    { role: "user", content: GOAL },
    { role: "user", content: "It must stream; never load the whole file into memory." },
    { role: "assistant", content: "I can do that two ways.\nWhich storage backend should it write to — SQLite or flat JSON?" },
  ]
  eq("the question forge asked is found", lastQuestionAsked(msgs), "Which storage backend should it write to — SQLite or flat JSON?")
  ok("a question the user has already replied past is not resurfaced",
    lastQuestionAsked([...msgs, { role: "user", content: "SQLite" }]) === null)

  ok("a bare option name is an answer", isAnswerLike("SQLite", { options: [{ id: "a", label: "SQLite" }] }))
  ok("so is consent", isAnswerLike("yes, go ahead", {}))
  ok("and a short bare noun", isAnswerLike("flat JSON", {}))
  ok("but an instruction is never swallowed by a stale question",
    isAnswerLike("also add a --quiet flag and write tests for it", {}) === false)

  const b = conversationBrief({ line: "SQLite", messages: msgs })
  ok("the run is recomposed", b.composed === true)
  ok("it leads with the goal", b.objective.startsWith(GOAL), b.objective.slice(0, 60))
  ok("it carries the requirement", /never load the whole file/.test(b.objective))
  ok("it names the question being answered — this is the bug",
    /ANSWERS THIS QUESTION: Which storage backend/.test(b.objective), b.objective.slice(-200))
  ok("and the answer survives verbatim, last",
    /\[the user's launch instruction, verbatim\] SQLite$/.test(b.objective))

  // v107's guarantee must survive: a line that states its own task runs as written
  const b2 = conversationBrief({ line: "Build a REST API for the orders service", messages: msgs })
  ok("a real instruction is never turned into an answer", b2.composed === false)
  eq("and is passed through byte for byte", b2.objective, "Build a REST API for the orders service")

  // a question from an EARLIER session, carried by the decision store
  const b3 = conversationBrief({ line: "SQLite", messages: [{ role: "user", content: GOAL }], pendingQuestion: "Which storage backend?", questionOptions: [{ id: "a", label: "SQLite" }] })
  ok("a question asked in an earlier session still finds its answer", /ANSWERS THIS QUESTION/.test(b3.objective), b3.summary)
}

console.log("== 5. the continuity block: priority, budget, honesty ==")
{
  const R = mkRepo("cont")
  const { openTask } = await import("../taskstate.js")
  openTask("t-v108-cont", { create: true, objective: "write the streaming CSV parser", cwd: R }).save?.()
  const de = await import("../decisionengine.js")
  const eng = de.createDecisionEngine({ cwd: R, taskId: "t-v108-cont" })
  eng.ask({ title: "Storage backend", question: "Which storage backend?", options: [{ id: "a", label: "SQLite" }], key: "sb" })
  eng.ask({ title: "License", question: "Which license?", key: "lic" })
  de.answerDecision({ cwd: R, ref: "lic", choice: "MIT" })

  const { continuityBlock, gatherContinuity, formatContinuity } = await import("../continuity.js")
  const block = await continuityBlock({ cwd: R, query: "parser" })
  ok("the pending question comes first — nothing else can move until it is answered",
    block.indexOf("STILL WAITING") < block.indexOf("ALREADY UNDERWAY"), block.slice(0, 120))
  ok("the open task is named", /write the streaming CSV parser/.test(block))
  ok("the settled decision is named so it is not asked twice", /License.*MIT/s.test(block))
  ok("it says where it came from", /task store, run journals, session store/.test(block))
  ok("it is marked as evidence, not orders", /evidence about state, not as instructions/.test(block))
  ok("and the working tree outranks it", /verify against the working tree/i.test(block))

  const fromSub = await continuityBlock({ cwd: path.join(R, "src"), query: "parser" })
  eq("a subdirectory sees exactly the same project state", fromSub, block)

  // the budget drops whole sections, never half of one, and always from the
  // BOTTOM of the priority order — never the question in favour of a file list
  const state = await gatherContinuity({ cwd: R, query: "parser" })
  const tight = formatContinuity(state, { maxChars: 600 })
  ok("a tight budget keeps the highest-priority section", /STILL WAITING/.test(tight), tight.slice(0, 120))
  ok("and drops from the bottom, not the top", !/ALREADY ANSWERED/.test(tight), tight)
  ok("saying what it dropped instead of truncating it", /omitted to stay within the context budget/.test(tight))
  ok("the budget is respected", tight.length <= 600 + 200, String(tight.length))

  const starved = formatContinuity(state, { maxChars: 350 })
  eq("a budget too small for even the top section says nothing at all", starved, "")

  const empty = await continuityBlock({ cwd: mkRepo("bare"), query: "nothing here" })
  eq("a project with no history says nothing at all", empty, "")
}

console.log("== 6. a finished task's requirements do not block an unrelated one ==")
{
  const R = mkRepo("req")
  const { createEngMemory } = await import("../engmemory.js")
  const objA = "Build the billing exporter.\n1. It MUST export invoices as CSV\n2. It MUST redact customer tax ids\n" + "padding. ".repeat(200)
  eq("task A ingests its requirements", createEngMemory({ cwd: R, taskId: "task-A" }).ingestRequirements(objA).length, 2)
  eq("an unrelated task B is handed none of them — this is the bug",
    createEngMemory({ cwd: R, taskId: "task-B" }).requirementRecords().length, 0)
  eq("task A, resumed, still sees its own",
    createEngMemory({ cwd: R, taskId: "task-A" }).requirementRecords().length, 2)
}

console.log("== 7. memory stops rotting to permanently invisible ==")
{
  const R = mkRepo("rot")
  const { createEngMemory } = await import("../engmemory.js")
  const m = createEngMemory({ cwd: R, taskId: "t-rot" })
  m.recordMemory({ text: "parser.js streams rows and never buffers the file", layer: "evidence", files: ["src/parser.js"], source: "agent" })
  ok("the record is retrievable", /streams rows/.test(m.retrievalBlock("parser")))
  m.markFilesChanged(["src/parser.js"])
  eq("editing the file hides it, as designed", m.retrievalBlock("parser"), "")
  const revived = m.markFilesVerified(["src/parser.js"], { verificationId: "v1", command: "npm test" })
  eq("a PASSING check on that file brings it back — this is the bug", revived, 1)
  ok("and it comes back carrying its evidence", /\(verified\+evidence\).*streams rows/.test(m.retrievalBlock("parser")), m.retrievalBlock("parser"))
  eq("a check on an unrelated file revives nothing", m.markFilesVerified(["src/other.js"]), 0)
  eq("and so does no file at all", m.markFilesVerified([]), 0)
}

console.log("== 8. the reproductions, end to end, against the real runtime ==")
{
  const REPO = mkRepo("e2e")
  const SUB = path.join(REPO, "src")
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
  const CH = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v108-chome-"))
  fs.writeFileSync(path.join(CH, "config.json"), JSON.stringify({
    activeProvider: "mock",
    providers: { mock: { protocol: "openai", baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "k", model: "mock-1" } },
    tools: { assumeYes: true }, agent: { autonomous: true, maxSteps: 2, maxSegments: 1 },
  }))

  const run = (args, input, cwd) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), ...args], {
      cwd, env: { ...process.env, FORGE_HOME: CH, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"],
    })
    let out = ""
    child.stdout.on("data", (d) => { out += d })
    child.stderr.on("data", (d) => { out += d })
    child.stdin.write(input); child.stdin.end()
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: "timeout", out }) }, 120000)
    child.on("exit", (code) => { clearTimeout(t); resolve({ code, out }) })
  })

  const GOAL = "Build a CSV-to-JSON converter in convert.js with a --pretty flag"
  const r1 = await run(["chat"], [GOAL, "/agent yes, authorized, start", "/exit", ""].join("\n"), REPO)
  ok("session 1 ran in the repository root", r1.code === 0, String(r1.out).slice(-300))
  const seen = prompts.length

  // session 2: a DIFFERENT process, in a SUBDIRECTORY, with no --continue and
  // no session of its own. Before v108 this was a brand-new empty project.
  const r2 = await run(["chat"], ["what is still open here?", "/exit", ""].join("\n"), SUB)
  server.close()
  ok("session 2 ran in the subdirectory", r2.code === 0, String(r2.out).slice(-300))

  const after = prompts.slice(seen)
  ok("session 2 reached the model", after.length > 0)
  ok("and its prompt carries this project's continuity — this is the bug",
    after.some((p) => /CONTINUITY —/.test(p)), `prompts: ${after.length}`)
  ok("naming work session 1 left open",
    after.some((p) => /CSV-to-JSON|convert\.js/i.test(p)),
    after.map((p) => p.slice(0, 80)).join(" // ").slice(0, 300))

  // and the crash that made `forge tasks --resume` unusable
  const r3 = await run(["tasks", "--resume", "definitely-not-a-task"], "", REPO)
  ok("an unknown task id is still refused cleanly", /no task matches/.test(r3.out), r3.out.slice(0, 200))
  // the child ran with its OWN FORGE_HOME, so the task store to read is CH's —
  // not this process's, which is a different tree entirely
  const taskIds = (() => {
    try {
      return fs.readdirSync(path.join(CH, "tasks")).filter((f) => f.endsWith(".json"))
        .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(CH, "tasks", f), "utf8"))?.task_id } catch { return null } })
        .filter(Boolean)
    } catch { return [] }
  })()
  ok("session 1's agent run recorded a task", taskIds.length > 0, `tasks dir: ${path.join(CH, "tasks")}`)
  if (taskIds.length) {
    const r4 = await run(["tasks", "--resume", taskIds[0]], "", REPO)
    ok("a VALID task id no longer throws ReferenceError — this is the bug",
      !/p is not defined|cfg is not defined/.test(r4.out), r4.out.slice(0, 300))
  }
}

console.log(`\n== v108 rootwise suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
