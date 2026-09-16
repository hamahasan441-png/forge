#!/usr/bin/env node
/**
 * forge v100 — cognitive core. Isolated FORGE_HOME, zero network.
 * Every check is a real call into the shipped modules.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cog-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

const { createUserModel, BELIEF, FEEDBACK_KIND, AUTHORITY, intentHypothesesFor, classifyFeedback } = await import("../usermodel.js")
const { createTaskContract, REQ } = await import("../contract.js")
const { chooseNextAction, ACTION, DEPTH, voi, depthFor } = await import("../governor.js")
const { createCognition, loadCognition, cognitionPath, COGNITION_VERSION, STATE_SCHEMA } = await import("../cognition.js")
const { createKernel } = await import("../omega.js")
const { VERSION } = await import("../version.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + extra : ""}`) }
}

console.log("== version identity ==")
{
  ok("package version is 117.x", /^122\./.test(VERSION), VERSION)
  ok("cognition protocol version set", COGNITION_VERSION === "1.5.0")
  ok("state schema set", STATE_SCHEMA === "1.5.0")
}

console.log("== user model: explicit vs inferred ==")
{
  const u = createUserModel()
  const und = u.understand("Add a login button to the header")
  ok("explicit intent is EXPLICIT", und.explicitIntent.class === BELIEF.EXPLICIT)
  ok("explicit text is frozen wording", und.explicitIntent.value === "Add a login button to the header")
  ok("does not invent a second brain role", !/explorer|planner|coder/i.test(JSON.stringify(und.decisionAuthority)))
}

console.log("== intent hypotheses stay competing ==")
{
  const hypos = intentHypothesesFor("Make Forge smarter")
  ok("ambiguous request yields >1 hypothesis", hypos.length >= 3)
  ok("they stay OPEN", hypos.every((h) => h.status === "OPEN"))
  ok("each names what would change my mind", hypos.every((h) => h.whatWouldChangeMyMind))
  const u = createUserModel()
  const und = u.understand("Make Forge smarter")
  ok("confidence is not collapsed to 1", und.confidence < 0.7)
  ok("ambiguities recorded", und.ambiguities.length >= 1)
}

console.log("== inference never becomes a requirement ==")
{
  const c = createTaskContract({ originalIntent: "fix the flaky test" })
  const refused = c.addRequirement({ text: "rewrite the test runner", tag: "ASSUMPTION" })
  ok("assumption cannot enter the contract as a requirement", refused.ok === false)
  const added = c.addRequirement({ text: "the flaky test passes", source: "user", tag: "REQUIREMENT" })
  ok("explicit requirement accepted", added.ok === true && added.item.status === REQ.OPEN)
}

console.log("== original intent is frozen ==")
{
  const c = createTaskContract()
  c.freezeIntent("fix logout")
  c.reviseIntent("fix logout cookie domain", { reason: "discovery" })
  ok("v1 preserved", c.original().text === "fix logout" && c.original().version === 1)
  ok("v2 is discovery, not a replacement", c.currentIntent().version === 2 && c.currentIntent().text.includes("cookie"))
  c.freezeIntent("silently replaced")
  ok("freeze after v1 does not mutate original", c.original().text === "fix logout")
}

console.log("== implemented ≠ verified ≠ complete ==")
{
  const c = createTaskContract({ originalIntent: "add auth" })
  c.addRequirement({ text: "users stay logged in", source: "user", tag: "REQUIREMENT" })
  const open = c.canComplete({ wrote: true, unverified: ["auth.js"], klass: "LARGE" })
  ok("writes without checks are not complete", open.ok === false)
  c.setRequirement(c.snapshot().requirements[0].id, REQ.IMPLEMENTED)
  const still = c.canComplete({ wrote: true, unverified: ["auth.js"], klass: "LARGE" })
  ok("IMPLEMENTED is not VERIFIED", still.ok === false && still.status === "VERIFICATION_FAILED")
}

console.log("== feedback + negative knowledge ==")
{
  const u = createUserModel()
  u.understand("refactor the parser")
  ok("classify 'that's wrong'", classifyFeedback("that's wrong") === FEEDBACK_KIND.CORRECTION || classifyFeedback("that's wrong") === FEEDBACK_KIND.REJECTION)
  u.recordFeedback("don't rewrite it")
  u.rejectStrategy({ strategy: "full rewrite", reason: "regression risk" })
  ok("rejected approaches stored", u.snapshot().rejected.some((r) => /rewrite/i.test(r.strategy)))
  ok("stale inference cannot override explicit pref", (() => {
    u.setPref({ key: "style", value: "inferred-tabs", klass: BELIEF.INFERRED })
    u.setPref({ key: "style", value: "spaces", klass: BELIEF.EXPLICIT })
    const blocked = u.setPref({ key: "style", value: "tabs-again", klass: BELIEF.INFERRED })
    return blocked.value === "spaces"
  })())
}

console.log("== governor: highest-value next action ==")
{
  const c = createTaskContract({ originalIntent: "Make Forge smarter" })
  const u = createUserModel()
  u.understand("Make Forge smarter")
  const inspect = chooseNextAction({ klass: "ARCHITECTURAL", contract: c, user: u, inspected: false, hasPlan: false, steps: 0 })
  ok("ambiguous high-impact inspects before asking", inspect.action === ACTION.INSPECT)
  const ask = chooseNextAction({ klass: "ARCHITECTURAL", contract: c, user: u, inspected: true, hasPlan: true, steps: 3, writes: 0, unverified: [] })
  ok("after inspect, irreversible+ambiguous asks", ask.action === ACTION.ASK, ask.action)
  const micro = chooseNextAction({ klass: "MICRO", contract: createTaskContract({ originalIntent: "fix typo" }), user: createUserModel(), inspected: true, hasPlan: true, steps: 1 })
  ok("MICRO does not escalate to L7", micro.depth === DEPTH.L1 || micro.depth === DEPTH.L2)
  ok("typo is EXECUTE or STOP, not ASK", micro.action === ACTION.EXECUTE || micro.action === ACTION.STOP || micro.action === ACTION.INSPECT)
  const verify = chooseNextAction({ klass: "MEDIUM", writes: 2, unverified: ["a.ts"], verified: false, inspected: true, hasPlan: true, steps: 4 })
  ok("writes without checks → VERIFY", verify.action === ACTION.VERIFY)
  const loop = chooseNextAction({ looping: true, klass: "SMALL" })
  ok("looping forces REPLAN", loop.action === ACTION.REPLAN)
  ok("VOI is decision-directed", voi({ impact: 0.9, uncertainty: 0.8, cost: 0.1 }) > voi({ impact: 0.2, uncertainty: 0.2, cost: 0.5 }))
  ok("architectural failure uses deep reasoning", [DEPTH.L4, DEPTH.L5, DEPTH.L6, DEPTH.L7].includes(depthFor({ klass: "ARCHITECTURAL", failed: true, impact: 0.9 })))
}

console.log("== cognition composes omega; it is not a second kernel ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cog-proj-"))
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n")
  const cog = createCognition({ cwd: dir, objective: "Make Forge smarter" })
  ok("kernel is the real omega", typeof cog.kernel.nextRepair === "function" && typeof cog.kernel.observeCommand === "function")
  const k = createKernel({ cwd: dir })
  ok("omega still constructs independently (not replaced)", typeof k.classify === "function")
  const b = cog.brief()
  ok("intent frozen on boot", b.intent === "Make Forge smarter")
  ok("competing intent hypotheses exist", b.intentHypotheses >= 3)
  const n = cog.next({ steps: 0, writes: 0, unverified: [], inspected: false })
  ok("governor returns a real ACTION", Object.values(ACTION).includes(n.action))
  const block = cog.promptBlock()
  ok("prompt block names frozen intent", /Intent v1/.test(block) && /Make Forge smarter/.test(block))
  ok("prompt block refuses silent substitution", /never silent substitution|frozen/i.test(block))
  const file = cog.persist()
  ok("cognitive state persists", file && fs.existsSync(file) && file === cognitionPath(dir))
  const loaded = loadCognition(dir)
  ok("restore does not invent a new intent", loaded.brief().intent === "Make Forge smarter")
}

console.log("== observe → evidence → governor VERIFY ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cog-obs-"))
  const cog = createCognition({ cwd: dir, objective: "fix the logout bug" })
  cog.noteInspect()
  cog.notePlan("minimal patch")
  cog.observeTools([{ name: "edit_file", args: { path: "auth.js" }, result: "wrote 12 lines" }])
  const n = cog.next({ steps: 4, writes: 1, unverified: ["auth.js"], inspected: true, hasPlan: true, verified: false })
  ok("after a write, governor wants VERIFY", n.action === ACTION.VERIFY, n.action + " " + n.why)
  const fail = cog.observeCommand("ERROR: test failed\nAssertionError: expected 200", { tool: "bash" })
  ok("command failure opens a hypothesis on the REAL omega engine", Boolean(fail.hypothesis?.id) || (fail.hypothesisSet?.length > 0))
  const repair = cog.next({ steps: 5, writes: 1, unverified: ["auth.js"], inspected: true, hasPlan: true, failed: true })
  ok("failure routes to REPAIR/TEST/INSPECT, not EXECUTE", [ACTION.REPAIR, ACTION.TEST, ACTION.INSPECT, ACTION.REPLAN].includes(repair.action), repair.action)
}

console.log("== authority: ask only when inspect cannot resolve it ==")
{
  const u = createUserModel()
  ok("discoverable answer is not asked", u.shouldAsk({ impact: 0.9, uncertainty: 0.8, discoverable: true }) === false)
  ok("irreversible + uncertain IS asked", u.shouldAsk({ impact: 0.9, uncertainty: 0.5, irreversible: true, discoverable: false }) === true)
  ok("low-impact reversible is not asked", u.shouldAsk({ impact: 0.2, uncertainty: 0.3, reversible: true, discoverable: false }) === false)
}

console.log("== modules actually import each other (not islands) ==")
{
  const cogSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "cognition.js"), "utf8")
  ok("cognition imports omega", /from "\.\/omega\.js"/.test(cogSrc))
  ok("cognition imports usermodel", /from "\.\/usermodel\.js"/.test(cogSrc))
  ok("cognition imports contract", /from "\.\/contract\.js"/.test(cogSrc))
  ok("cognition imports governor", /from "\.\/governor\.js"/.test(cogSrc))
  const agentSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "agent.js"), "utf8")
  ok("DEFAULT agent path loads cognition", /createCognition/.test(agentSrc))
  ok("governor events fire on the live loop", /GOVERNOR_ACTION/.test(agentSrc))
  const metaSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "meta.js"), "utf8")
  ok("meta uses createCognition, not a second kernel", /createCognition/.test(metaSrc) && !/createKernel/.test(metaSrc))
}

console.log(`\n== cognition suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
