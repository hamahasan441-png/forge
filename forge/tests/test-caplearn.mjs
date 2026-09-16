#!/usr/bin/env node
/**
 * forge — v106 "capabilitywise": learning is a BEHAVIOR CHANGE.
 *
 * A database of stats that never changes routing is not learning.
 * This suite proves: fail with skill X under LARGE → the next LARGE route
 * withholds X; the same skill stays available for a class with no evidence.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-caplearn-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + extra : ""}`) }
}

const { VERSION } = await import("../version.js")
const {
  recordCapOutcome, loadCapLearn, healthOf, HEALTH, shouldWithhold, reputation,
  recordRunOutcomes, CAPLEARN_VERSION,
} = await import("../caplearn.js")
const { applyRoutePolicy } = await import("../caproute.js")
const { selectForTurn } = await import("../capindex.js")
const { chooseNextAction, ACTION } = await import("../governor.js")
const { createCognition, COGNITION_VERSION } = await import("../cognition.js")

const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-caplearn-proj-"))

console.log("== version identity ==")
{
  ok("package version is 117.x", /^122\./.test(VERSION), VERSION)
  ok("cognition protocol is 1.5.x", /^1\.5\./.test(COGNITION_VERSION), COGNITION_VERSION)
  ok("caplearn protocol set", CAPLEARN_VERSION === "1.0.0")
}

console.log("== reputation is task-class conditional ==")
{
  for (let i = 0; i < 3; i++) {
    recordCapOutcome({ cwd: work, name: "sketchy-review", kind: "skill", klass: "LARGE", ok: false, why: "missed the security hole" })
  }
  recordCapOutcome({ cwd: work, name: "sketchy-review", kind: "skill", klass: "MICRO", ok: true })
  recordCapOutcome({ cwd: work, name: "solid-review", kind: "skill", klass: "LARGE", ok: true })
  recordCapOutcome({ cwd: work, name: "solid-review", kind: "skill", klass: "LARGE", ok: true })
  const store = loadCapLearn(work)
  const sketchy = store.items["skill:sketchy-review"]
  ok("three LARGE failures recorded", sketchy.byKlass.LARGE.samples === 3 && sketchy.byKlass.LARGE.ok === 0)
  ok("LARGE health is BROKEN or UNRELIABLE", [HEALTH.BROKEN, HEALTH.UNRELIABLE].includes(healthOf(sketchy.byKlass.LARGE)), healthOf(sketchy.byKlass.LARGE))
  ok("withheld on LARGE", shouldWithhold(store, { name: "sketchy-review", kind: "skill", klass: "LARGE" }) === true)
  ok("NOT withheld when named", shouldWithhold(store, { name: "sketchy-review", kind: "skill", klass: "LARGE", named: true }) === false)
  ok("MICRO bucket is not poisoned by LARGE failures", shouldWithhold(store, { name: "sketchy-review", kind: "skill", klass: "MICRO" }) === false)
  ok("solid-review reputation beats sketchy on LARGE",
    reputation(store, { name: "solid-review", kind: "skill", klass: "LARGE" })
    > reputation(store, { name: "sketchy-review", kind: "skill", klass: "LARGE" }))
}

console.log("== FUTURE ROUTE changes because of the lesson ==")
{
  const store = loadCapLearn(work)
  const r = applyRoutePolicy({
    task: "review the auth architecture",
    klass: "LARGE",
    action: "EXECUTE",
    skills: [
      { name: "sketchy-review", lifecycle: "VERIFIED", desc: "review" },
      { name: "solid-review", lifecycle: "VERIFIED", desc: "review" },
    ],
    mcpKept: [],
    store,
  })
  ok("broken skill is withheld on the next LARGE route", !r.skills.some((s) => s.name === "sketchy-review"), JSON.stringify(r.skills))
  ok("healthy skill is kept", r.skills.some((s) => s.name === "solid-review"))
  ok("the withhold is explained", r.trimmed.some((t) => t.name === "sketchy-review" && /UNRELIABLE|BROKEN/.test(t.reason)))

  const again = selectForTurn({
    task: "review the auth architecture",
    klass: "LARGE",
    cwd: work,
    pickSkillsFn: () => [
      { name: "sketchy-review", lifecycle: "VERIFIED", desc: "review" },
      { name: "solid-review", lifecycle: "VERIFIED", desc: "review" },
    ],
    nativeNames: ["read_file"],
  })
  ok("selectForTurn on a later task uses the lesson", !again.skills.some((s) => s.name === "sketchy-review"))
  ok("and still offers the measured-better skill", again.skills.some((s) => s.name === "solid-review"))
}

console.log("== credit assignment from real tool records ==")
{
  recordRunOutcomes({
    cwd: work,
    klass: "LARGE",
    ok: false,
    records: [
      { name: "load_skill", args: { name: "wip-sql" } },
      { name: "mcp__pg__run_query", result: "ERROR: timeout" },
    ],
  })
  const store = loadCapLearn(work)
  ok("load_skill attributed to the skill name", store.items["skill:wip-sql"]?.failed >= 1)
  ok("mcp call attributed", store.items["mcp:mcp__pg__run_query"]?.failed >= 1)
}

console.log("== governor: knowledge gap is SEARCH, not another patch ==")
{
  const a = chooseNextAction({
    klass: "LARGE", hasPlan: true, inspected: false, writes: 0, steps: 1,
    knowledgeGap: true, contract: { canComplete: () => ({ ok: false }) },
  })
  ok("SEARCH on a high-value knowledge gap", a.action === ACTION.SEARCH, a.action + " " + a.why)
  const micro = chooseNextAction({
    klass: "MICRO", hasPlan: true, inspected: false, writes: 0, steps: 1,
    knowledgeGap: true,
  })
  ok("MICRO does not escalate a knowledge gap", micro.action === ACTION.EXECUTE, micro.action)
  const cap = chooseNextAction({
    klass: "LARGE", hasPlan: true, inspected: false, writes: 0, steps: 1,
    capabilityGap: true, contract: { canComplete: () => ({ ok: false }) },
  })
  ok("capability gap → INSPECT, not EXECUTE", cap.action === ACTION.INSPECT, cap.action)
}

console.log("== cognition prompt carries measured health ==")
{
  const cog = createCognition({ cwd: work, objective: "review the auth architecture across files" })
  const block = cog.promptBlock()
  ok("prompt can name capability health", /CAPABILITY HEALTH|KNOWLEDGE GAP|VOI EXPERIMENT|CAPABILITY ROUTER/.test(block))
}

console.log("== live agent path records outcomes ==")
{
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "agent.js"), "utf8")
  ok("agent records cap outcomes", /recordRunOutcomes/.test(src))
  ok("agent passes cwd into selectForTurn", /cwd: process\.cwd\(\)/.test(src))
  ok("governor has knowledgeGap", /knowledgeGap/.test(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "governor.js"), "utf8")))
}

console.log(`\n== caplearn suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
