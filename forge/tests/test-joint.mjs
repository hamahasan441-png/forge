#!/usr/bin/env node
/**
 * forge — v111 "jointwise": one route, not three independent brains.
 *
 * Failing (L4 + bad-model + broken-skill) is not re-offered when a cheaper
 * successful combo is measured. MICRO / lock / named skill still win.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-joint-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + extra : ""}`) }
}

const { VERSION } = await import("../version.js")
const { DEPTH } = await import("../governor.js")
const { scoreRoute, recordRoute, JOINT_VERSION } = await import("../jointroute.js")
const { createCognition } = await import("../cognition.js")
const { recordCapOutcome, shouldWithhold, loadCapLearn } = await import("../caplearn.js")

const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-joint-proj-"))

console.log("== version identity ==")
{
  ok("package version is 113.x", /^113\./.test(VERSION), VERSION)
  ok("joint protocol set", JOINT_VERSION === "1.0.0")
}

console.log("== failing combo is not re-offered ==")
{
  for (let i = 0; i < 3; i++) {
    recordRoute({ cwd: work, klass: "LARGE", depth: DEPTH.L4, model: "alpha-model", skills: ["sketchy-x"], ok: false })
  }
  for (let i = 0; i < 3; i++) {
    recordRoute({ cwd: work, klass: "LARGE", depth: DEPTH.L2, model: "beta-model", skills: ["solid-y"], ok: true })
  }
  const route = scoreRoute({
    cwd: work, klass: "LARGE", task: "rewrite auth",
    depth: DEPTH.L4, model: "alpha-model", skills: ["sketchy-x"],
  })
  ok("prefers measured-successful depth", route.depth === DEPTH.L2, JSON.stringify(route))
  ok("prefers measured-successful model", route.model === "beta-model", route.model)
  ok("source is joint (not three independent hunches)", route.source === "joint", route.source)
}

console.log("== MICRO does not joint-route ==")
{
  const r = scoreRoute({ cwd: work, klass: "MICRO", depth: DEPTH.L1, model: "alpha-model" })
  ok("MICRO source", r.source === "micro")
  ok("MICRO keeps caller model", r.model === "alpha-model")
}

console.log("== lockModel keeps the caller's model ==")
{
  const r = scoreRoute({
    cwd: work, klass: "LARGE", depth: DEPTH.L4, model: "alpha-model",
    skills: ["sketchy-x"], lockModel: true,
  })
  ok("lock keeps alpha", r.model === "alpha-model", r.model)
  ok("lock can still take cheaper measured depth", r.depth === DEPTH.L2, r.depth)
}

console.log("== named skill is not silently dropped ==")
{
  for (let i = 0; i < 3; i++) recordCapOutcome({ cwd: work, name: "sketchy-x", kind: "skill", klass: "LARGE", ok: false })
  const store = loadCapLearn(work)
  ok("un-named withheld", shouldWithhold(store, { name: "sketchy-x", kind: "skill", klass: "LARGE" }) === true)
  const r = scoreRoute({
    cwd: work, klass: "LARGE", model: "alpha-model",
    skills: ["sketchy-x"], namedSkills: ["sketchy-x"],
  })
  ok("named skill still on the route", r.skills.includes("sketchy-x"), JSON.stringify(r.skills))
}

console.log("== cognition uses joint depth on the next LARGE action ==")
{
  const cog = createCognition({ cwd: work, objective: "rewrite the auth module and add regression tests" })
  const k = cog.klass
  if (k !== "MICRO") {
    for (let i = 0; i < 3; i++) recordRoute({ cwd: work, klass: k, depth: DEPTH.L4, model: "alpha-model", skills: ["sketchy-x"], ok: false })
    for (let i = 0; i < 3; i++) recordRoute({ cwd: work, klass: k, depth: DEPTH.L2, model: "beta-model", skills: ["solid-y"], ok: true })
  }
  const a = cog.next({ steps: 0, writes: 0, unverified: [], inspected: true, hasPlan: true, model: "alpha-model", skills: ["sketchy-x"] })
  ok("action depth follows joint L2 for non-MICRO", k === "MICRO" || a.depth === DEPTH.L2 || cog.lastJoint?.depth === DEPTH.L2, JSON.stringify({ klass: k, action: a.depth, joint: cog.lastJoint }))
  ok("prompt names JOINT ROUTE", /JOINT ROUTE/.test(cog.promptBlock()) || k === "MICRO")
}

console.log("== live path is wired; no JointManager ==")
{
  ok("no JointManager module", !fs.existsSync(new URL("../jointmanager.js", import.meta.url)))
  const agent = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  ok("agent calls scoreRoute", /scoreRoute/.test(agent))
  ok("agent records the combo", /recordRoute/.test(agent))
  const cog = fs.readFileSync(new URL("../cognition.js", import.meta.url), "utf8")
  ok("cognition composes scoreRoute", /scoreRoute/.test(cog))
}

console.log(`\n== joint suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
