#!/usr/bin/env node
/**
 * forge — v113 "githubwise": GitHub is evidence, not a second agent.
 * Read via allowlisted gh. Write stays gitship (consent).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-gh-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + extra : ""}`) }
}

const { VERSION } = await import("../version.js")
const { githubImpliedByTask, actionForTask, ghInspect, GITHUB_VERSION } = await import("../github.js")
const { planAcquire, runAcquire, METHOD } = await import("../knowgap.js")
const { TOOL_DEFS } = await import("../tools.js")
const { INSPECT_KEEP, WRITE_TOOL_NAMES } = await import("../governor.js")

console.log("== version identity ==")
{
  ok("package version is 113.x", /^113\./.test(VERSION), VERSION)
  ok("github protocol set", GITHUB_VERSION === "1.0.0")
}

console.log("== GitHub is implied only when the task is GitHub ==")
{
  ok("PR/CI implies GitHub", githubImpliedByTask("fix the failing GitHub Action on PR 12") === true)
  ok("typo does not", githubImpliedByTask("typo fix teh") === false)
  ok("action for PR 12 is pr", actionForTask("review pull request 12").action === "pr" && actionForTask("review pull request 12").id === "12")
  ok("CI task prefers runs/checks", ["runs", "checks"].includes(actionForTask("why is CI failing").action))
}

console.log("== inspect is allowlisted and honest ==")
{
  const bad = ghInspect({ action: "pr merge", id: "1" })
  ok("write action refused", bad.ok === false && /unknown github action/.test(bad.preview), bad.preview)
  const inj = ghInspect({ action: "pr", id: "; rm -rf /" })
  ok("shell-injection id refused", inj.ok === false, inj.preview)
  const fake = ghInspect({
    action: "issues",
    spawn: (cmd, args) => {
      ok("spawn is gh with argv array", cmd === "gh" && Array.isArray(args) && args[0] === "issue")
      return { status: 0, stdout: '[{"number":1,"title":"bug","state":"OPEN"}]', stderr: "", error: null }
    },
  })
  ok("fake spawn returns evidence", fake.ok === true && /bug/.test(fake.preview), fake.preview)
}

console.log("== acquire prefers gh before the web ==")
{
  const plan = planAcquire(
    { id: "github", learn: true, status: "UNKNOWN" },
    { task: "fix the failing GitHub Action on PR 12", tried: [] },
  )
  ok("acquire tool is github", plan?.tool === "github", JSON.stringify(plan))
  ok("method is GITHUB", plan?.method === METHOD.GITHUB)
  const acq = runAcquire({ tool: "github", method: METHOD.GITHUB, query: "status", id: "github" }, { cwd: process.cwd() })
  ok("runAcquire talks to gh or says why not", acq.tool === "github" && (acq.ok === true || Boolean(acq.skipped || acq.preview)), JSON.stringify(acq))
}

console.log("== model can inspect; model cannot push ==")
{
  ok("github is a wire tool", TOOL_DEFS.some((t) => t.function.name === "github"))
  ok("github is on INSPECT keep-list", INSPECT_KEEP.includes("github"))
  ok("github is NOT a write tool", !WRITE_TOOL_NAMES.includes("github"))
  const src = fs.readFileSync(new URL("../github.js", import.meta.url), "utf8")
  ok("no pr create / push in github.js", !/pr create/.test(src) && !/git push/.test(src))
  const ship = fs.readFileSync(new URL("../gitship.js", import.meta.url), "utf8")
  ok("gitship still owns PR create", /pr create/.test(ship))
}

console.log(`\n== github suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
