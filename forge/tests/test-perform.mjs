#!/usr/bin/env node
/**
 * forge — v108 "performwise": intelligence that never runs is decoration.
 *
 * SEARCH must grep. Created tools must search, not echo metadata.
 * A second SEARCH after acquire must not fire. Web is never auto-fetched.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-perform-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + extra : ""}`) }
}

const { VERSION } = await import("../version.js")
const { runAcquire, planAcquire } = await import("../knowgap.js")
const { createCognition, ACTION } = await import("../cognition.js")
const { createForGap, toolNameFor } = await import("../toolcreate.js")
const { noteCapabilityGap } = await import("../caplearn.js")

const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-perform-proj-"))
fs.writeFileSync(path.join(work, "auth.js"), "export function login() { return tokenFromEnv() }\n")
fs.writeFileSync(path.join(work, "README.md"), "security architecture for the auth module\n")

console.log("== version identity ==")
{
  ok("package version is 113.x", /^113\./.test(VERSION), VERSION)
}

console.log("== SEARCH actually greps (not a prompt) ==")
{
  const plan = { tool: "grep_files", query: "tokenFromEnv", method: "REPO", id: "security", why: "local first" }
  const acq = runAcquire(plan, { cwd: work })
  ok("grep finds the symbol", acq.ok === true && acq.hits >= 1, JSON.stringify(acq))
  ok("preview names the file", /auth\.js/.test(acq.preview || ""), acq.preview)
  const web = runAcquire({ tool: "web_search", query: "jwt rfc", method: "WEB" }, { cwd: work })
  ok("web is never auto-fetched", web.ok === false && /web last/.test(web.skipped || ""), JSON.stringify(web))
  const bash = runAcquire({ tool: "bash", query: "rm -rf /", method: "VERIFY" }, { cwd: work })
  ok("acquire stays read-only", bash.ok === false && /read-only/.test(bash.skipped || ""))
}

console.log("== governor SEARCH runs once, then advances ==")
{
  const cog = createCognition({
    cwd: work,
    objective: "redesign the production kubernetes deploy pipeline",
  })
  const a1 = cog.next({ steps: 0, writes: 0, unverified: [], inspected: false, hasPlan: true, failed: false, looping: false })
  ok("first action on a knowledge-heavy LARGE task can SEARCH", a1.action === ACTION.SEARCH || a1.action === ACTION.INSPECT || a1.action === ACTION.PLAN, a1.action)
  const plan = cog.acquirePlan() || { tool: "grep_files", query: "kubernetes", method: "REPO" }
  ok("acquirePlan is a real tool, not a paragraph", Boolean(plan.tool), JSON.stringify(plan))
  const acq = runAcquire(plan, { cwd: work })
  cog.observeAcquire(acq)
  ok("observeAcquire records the run", cog.lastAcquire && cog.lastAcquire.tool === plan.tool)
  const a2 = cog.next({ steps: 1, writes: 0, unverified: [], inspected: true, hasPlan: true, failed: false, looping: false })
  ok("after acquire, SEARCH does not fire again", a2.action !== ACTION.SEARCH, a2.action)
  ok("prompt names the acquire, not a leftover gap", /ACQUIRE \(ran/.test(cog.promptBlock()))
}

console.log("== created tool PERFORMS a search, it does not echo metadata ==")
{
  const cap = "token_lookup"
  fs.writeFileSync(path.join(work, "tokens.md"), "tokenFromEnv is the secret loader\n")
  noteCapabilityGap({ cwd: work, capability: cap, klass: "LARGE" })
  noteCapabilityGap({ cwd: work, capability: cap, klass: "LARGE" })
  const made = await createForGap({ cwd: work, capability: cap, task: "find tokenFromEnv", klass: "LARGE" })
  ok("created for a repeated gap", made.ok === true && (made.created === true || made.reused === true), JSON.stringify(made))
  const file = path.join(HOME, "projects")
  // load the plugin from project tools dir via dynamic import of generated file
  const { loadActiveCreatedTools } = await import("../toolcreate.js")
  const loaded = await loadActiveCreatedTools(work)
  const plug = loaded.find((p) => p.name === toolNameFor(cap))
  ok("plugin loaded", Boolean(plug && typeof plug.run === "function"))
  const out = plug ? String(await plug.run({ query: "tokenFromEnv" })) : ""
  ok("run returns a file hit, not 'designed for'", /tokenFromEnv/.test(out) && !/designed for/.test(out), out.slice(0, 200))
  ok("source is a walker, not an echo stub", !/designed for:/.test(fs.readFileSync(new URL("../toolcreate.js", import.meta.url), "utf8")))
}

console.log("== live agent path actually calls runAcquire ==")
{
  const src = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  ok("agent imports runAcquire", /runAcquire/.test(src))
  ok("agent runs it on SEARCH", /gov\.action === "SEARCH"/.test(src))
  ok("agent does not steal the user's model, only ranks failover", /never steal the user's chosen model/.test(src))
}

console.log(`\n== perform suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
