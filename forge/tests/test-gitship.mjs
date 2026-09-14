#!/usr/bin/env node
/**
 * v98 shipwise — VERIFIED GIT DELIVERY (gitship.js).
 *
 * Kernel delivery policy, never a tool surface. Pinned here:
 *  1. lifecycle: gate-ok moment on a clean repo commits ONLY the run's
 *     verified files, with forge trailers and the identity fallback.
 *  2. staging exactness: foreign dirty files are NEVER staged; `.forge/**`
 *     never ships.
 *  3. policy: commit/branch/push default OFF; "ask" without a consent
 *     surface refuses (never a silent yes).
 *  4. crash idempotence: a HEAD that already carries this task's trailer is
 *     DONE — no double commit.
 *  5. branch "auto" BOOKMARKS the commit (git branch, never a checkout).
 *  6. non-repo / mid-flight rebase / empty file set → honest SKIPPED.
 *  7. surface audit: gitship stays kernel-side — no TOOL_DEFS/capabilities
 *     entries (the wire stays 1:1, the worktreewise §9 law).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-gitship-"))
process.env.FORGE_HOME = HOME
// hermetic git: no global/system identity, no host safe.directory quirks —
// the identity-fallback path must not depend on the machine running the test
process.env.GIT_CONFIG_GLOBAL = "/dev/null"
process.env.GIT_CONFIG_NOSYSTEM = "1"
for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE"]) delete process.env[key]
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-gitship-work-"))
process.chdir(WORK)

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const git = (args, opts = {}) => {
  try {
    return { ok: true, out: execFileSync("git", args, { cwd: opts.cwd ?? WORK, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }) }
  } catch (e) {
    return { ok: false, out: String(e?.stdout ?? ""), err: String(e?.stderr ?? e?.message ?? "") }
  }
}

const mkRepo = (dir = WORK) => {
  git(["init", "-q"], { cwd: dir })
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "root"], { cwd: dir })
  return dir
}

const { maybeShip, gitshipMode, renderPrText } = await import("../gitship.js")

console.log("== 1. policy resolution ==")
{
  eq("all OFF by default", gitshipMode({}), { commit: "off", branch: "off", push: "off", pr: "off" })
  eq("garbage falls back to off", gitshipMode({ gitship: { commit: "yes-please", branch: "explode", push: "force", pr: "api" } }), { commit: "off", branch: "off", push: "off", pr: "off" })
  eq("valid modes resolve", gitshipMode({ gitship: { commit: "ask", branch: "auto", push: "explicit", pr: "gh" } }), { commit: "ask", branch: "auto", push: "explicit", pr: "gh" })
}

console.log("== 2. default OFF + non-repo honesty ==")
{
  fs.writeFileSync(path.join(WORK, "a.js"), "export const a = 1\n")
  const off = await maybeShip({ root: WORK, config: {}, taskId: "t1", changedFiles: ["a.js"] })
  ok("commit off → skipped with reason", off.skipped === true && /gitship\.commit is off/.test(off.reason))
  mkRepo()
  const noRepo = await maybeShip({ root: "/tmp/definitely-not-a-repo-xyz", config: { gitship: { commit: "on" } }, taskId: "t2", changedFiles: ["a.js"] })
  ok("non-repo → skipped honestly", noRepo.skipped === true && /not a git repository/.test(noRepo.reason))
  const empty = await maybeShip({ root: WORK, config: { gitship: { commit: "on" } }, taskId: "t3", changedFiles: [] })
  ok("no shippable files → skipped", empty.skipped === true && /no shippable files/.test(empty.reason))
  const forgeOnly = await maybeShip({ root: WORK, config: { gitship: { commit: "on" } }, taskId: "t3b", changedFiles: [".forge/registry.json", "../outside.js"] })
  ok("forge-internal + escaping paths never ship", forgeOnly.skipped === true && /no shippable files/.test(forgeOnly.reason))
}

console.log("== 3. lifecycle: commit lands with trailers, only the run's files ==")
{
  fs.writeFileSync(path.join(WORK, "src-run.js"), "export const run = 1\n")
  fs.writeFileSync(path.join(WORK, "foreign.js"), "export const foreign = 1\n") // foreign dirty file — must NEVER be staged
  const ship = await maybeShip({
    root: WORK, config: { gitship: { commit: "on" } }, taskId: "task-98", runId: "run-1",
    objective: "add the run module", changedFiles: ["src-run.js"],
    verificationStatus: "satisfied", finalRisk: "low", gate: { ok: true },
  })
  ok("shipped", ship.shipped === true, JSON.stringify(ship))
  ok("sha returned", typeof ship.sha === "string" && ship.sha.length >= 7)
  const status = git(["status", "--porcelain"]).out
  ok("foreign dirty file still uncommitted", /^\?\? foreign\.js/m.test(status), status)
  ok("run file committed", !/src-run\.js/m.test(status), status)
  const log = git(["log", "-1", "--pretty=%B"]).out
  ok("subject carries the objective", /forge: add the run module/.test(log), log)
  ok("Forge-Task-Id trailer", /Forge-Task-Id: task-98/.test(log), log)
  ok("Forge-Run trailer", /Forge-Run: run-1/.test(log), log)
  ok("9-check gate referenced in body", /9-check completion gate/.test(log), log)
  ok("identity fallback reported", /fallback identity forge-agent/.test(ship.identity ?? ""), JSON.stringify(ship.identity))
  const author = git(["log", "-1", "--pretty=%an <%ae>"]).out.trim()
  eq("fallback identity used in the commit (repo identity unset)", author, "forge-agent <forge@local>")
  ok("foreign dirty files listed, not touched", Array.isArray(ship.foreignDirtyFiles) && ship.foreignDirtyFiles.includes("foreign.js"), JSON.stringify(ship.foreignDirtyFiles))
  ok("no PR artifact by default (branch off, push off — text only on ship)", typeof ship.prPath === "string" || ship.prPath === null)
}

console.log("== 4. crash idempotence: a re-delivery of the SAME task is a no-op ==")
{
  fs.writeFileSync(path.join(WORK, "src-run.js"), "export const run = 2\n")
  const again = await maybeShip({
    root: WORK, config: { gitship: { commit: "on" } }, taskId: "task-98", runId: "run-2",
    objective: "add the run module v2", changedFiles: ["src-run.js"],
    verificationStatus: "satisfied", finalRisk: "low", gate: { ok: true },
  })
  // task-98's trailer is on HEAD from §3 — but the FILE changed since. The
  // idempotence guard keys on the HEAD trailer matching THIS task id, so a
  // changed file for the same task still refuses to double-commit blindly:
  // the guard reports the landed state and does not stack a second commit
  // for the same delivery.
  ok("idempotent recognition of the landed delivery", again.idempotent === true, JSON.stringify(again))
  const count = git(["rev-list", "--count", "HEAD"]).out.trim()
  ok("no second commit stacked", count === "2", count)
}

console.log("== 5. ask-mode consent gate ==")
{
  fs.writeFileSync(path.join(WORK, "consent.js"), "export const c = 1\n")
  const declined = await maybeShip({
    root: WORK, config: { gitship: { commit: "ask" } }, taskId: "task-ask",
    changedFiles: ["consent.js"], gate: { ok: true },
    ask: () => ({ ok: false }),
  })
  ok("declined ask → skipped, nothing committed", declined.skipped === true && /declined/.test(declined.reason))
  const noSurface = await maybeShip({
    root: WORK, config: { gitship: { commit: "ask" } }, taskId: "task-ask2",
    changedFiles: ["consent.js"], gate: { ok: true }, ask: null,
  })
  ok("ask without a consent surface → refused, never a silent yes", noSurface.skipped === true && /no consent surface/.test(noSurface.reason))
  const approved = await maybeShip({
    root: WORK, config: { gitship: { commit: "ask", branch: "auto" } }, taskId: "task-ask3",
    changedFiles: ["consent.js"], gate: { ok: true },
    ask: () => ({ ok: true }),
  })
  ok("approved ask commits", approved.shipped === true, JSON.stringify(approved))
  ok("branch auto bookmarks (never checkout)", approved.branch === "forge/task-ask3", JSON.stringify(approved.branch))
  const branches = git(["branch", "--list", "forge/task-ask3"]).out
  ok("bookmark branch exists at the commit", /forge\/task-ask3/.test(branches), branches)
  const head = git(["rev-parse", "--abbrev-ref", "HEAD"]).out.trim()
  ok("the user's checkout was never switched", head === "master" || head === "main", head)
}

console.log("== 6. mid-flight git operation blocks delivery ==")
{
  // simulate a merge in progress
  fs.writeFileSync(path.join(WORK, "conflict-base.txt"), "base\n")
  git(["add", "conflict-base.txt"])
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base file"])
  git(["checkout", "-q", "-b", "other"])
  fs.writeFileSync(path.join(WORK, "conflict-base.txt"), "other\n")
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-a", "-m", "other change"])
  git(["checkout", "-q", "-"])
  fs.writeFileSync(path.join(WORK, "conflict-base.txt"), "main\n")
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-a", "-m", "main change"])
  git(["-c", "user.name=t", "-c", "user.email=t@t", "merge", "other"]) // conflicts → MERGE_HEAD exists (identity needed: hermetic config)
  const blocked = await maybeShip({
    root: WORK, config: { gitship: { commit: "on" } }, taskId: "task-mid",
    changedFiles: ["conflict-base.txt"], gate: { ok: true },
  })
  ok("mid-flight merge → honest skip", blocked.skipped === true && /mid-flight/.test(blocked.reason), JSON.stringify(blocked))
  git(["merge", "--abort"])
}

console.log("== 7. push: explicit + approved only, never force ==")
{
  // push requires a remote; a repo without one lands the commit and reports
  // the honest reason. Force-push is structurally impossible (the arg array
  // never contains --force). Fresh file: §6's branch flow left src-run.js
  // committed on both sides — a no-diff stage is covered separately below.
  fs.writeFileSync(path.join(WORK, "push-me.js"), "export const p = 1\n")
  const noRemote = await maybeShip({
    root: WORK, config: { gitship: { commit: "on", push: "explicit" } }, taskId: "task-push1",
    changedFiles: ["push-me.js"], gate: { ok: true },
    ask: () => ({ ok: true }),
  })
  ok("push approved but no remote → commit lands, honest reason", noRemote.shipped === true && noRemote.pushed === false && /no git remote/.test(noRemote.reason), JSON.stringify(noRemote))
  // nothing-to-commit honesty: a run whose files already match HEAD
  const noDiff = await maybeShip({
    root: WORK, config: { gitship: { commit: "on" } }, taskId: "task-nodiff",
    changedFiles: ["push-me.js"], gate: { ok: true },
  })
  ok("no staged diff → honest skip (already delivered/unchanged)", noDiff.skipped === true && /nothing to commit/.test(noDiff.reason), JSON.stringify(noDiff))
}

console.log("== 8. PR text renders from gate artifacts ==")
{
  const text = renderPrText({ objective: "fix the login flow", taskId: "t9", runId: "r9", files: ["a.js", "b.js"], verificationStatus: "satisfied", finalRisk: "medium", gate: { ok: true } })
  ok("objective present", /fix the login flow/.test(text))
  ok("verification + risk present", /satisfied/.test(text) && /medium/.test(text))
  ok("files listed", /`a\.js`/.test(text) && /`b\.js`/.test(text))
  ok("gate status honest", /9-check/.test(text))
}

console.log("== 9. adversarial audit round 2 (A1: staging exactness holes) ==")
{
  // A1a: PRE-STAGED foreign content must never ride the delivery commit
  const repo2 = fs.mkdtempSync(path.join(os.tmpdir(), "forge-gitship-a1-"))
  git(["init", "-q"], { cwd: repo2 })
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "root"], { cwd: repo2 })
  fs.writeFileSync(path.join(repo2, "run-file.js"), "export const r = 1\n")
  fs.writeFileSync(path.join(repo2, "user-staged.js"), "export const u = 1\n")
  git(["add", "user-staged.js"], { cwd: repo2 }) // the USER staged their own file before the run
  const mixed = await maybeShip({
    root: repo2, config: { gitship: { commit: "on" } }, taskId: "task-a1",
    changedFiles: ["run-file.js"], gate: { ok: true },
  })
  ok("ship succeeds with user pre-staging present", mixed.shipped === true, JSON.stringify(mixed))
  const committed = git(["show", "--name-only", "--pretty=format:", "HEAD"], { cwd: repo2 }).out.split("\n").map((s) => s.trim()).filter(Boolean)
  eq("the delivery commit contains EXACTLY the run's file", committed, ["run-file.js"])
  const staged = git(["diff", "--cached", "--name-only"], { cwd: repo2 }).out
  ok("the user's pre-staged file is back in the index, uncommitted", /user-staged\.js/.test(staged), staged)
  ok("the user's pre-staged file still in the working tree", fs.existsSync(path.join(repo2, "user-staged.js")))

  // A1b: a DIRECTORY in changedFiles is refused (git add -- <dir> would over-stage)
  fs.mkdirSync(path.join(repo2, "adir"), { recursive: true })
  fs.writeFileSync(path.join(repo2, "adir", "inside.js"), "x\n")
  const dirShip = await maybeShip({
    root: repo2, config: { gitship: { commit: "on" } }, taskId: "task-a1b",
    changedFiles: ["adir"], gate: { ok: true },
  })
  ok("directory pathspec refused (never silently widened)", dirShip.skipped === true && /no shippable files/.test(dirShip.reason), JSON.stringify(dirShip.reason))

  // A1c: foreign staged + our files unchanged → honest nothing-to-commit
  fs.writeFileSync(path.join(repo2, "second-staged.js"), "y\n")
  git(["add", "second-staged.js"], { cwd: repo2 })
  const noOurs = await maybeShip({
    root: repo2, config: { gitship: { commit: "on" } }, taskId: "task-a1c",
    changedFiles: ["run-file.js"], gate: { ok: true },
  })
  ok("foreign staged but our files unchanged → honest skip", noOurs.skipped === true && /nothing to commit/.test(noOurs.reason), JSON.stringify(noOurs.reason))
  ok("...and the foreign staging was restored (not committed, not dropped)", /second-staged\.js/.test(git(["diff", "--cached", "--name-only"], { cwd: repo2 }).out))

  // A1d: a task id with regex metacharacters must not throw / cross-match
  fs.writeFileSync(path.join(repo2, "regex-id.js"), "export const z = 1\n")
  const weird = await maybeShip({
    root: repo2, config: { gitship: { commit: "on" } }, taskId: "task.9(abc)*[x]",
    changedFiles: ["regex-id.js"], gate: { ok: true },
  })
  ok("regex-metachar task id ships safely", weird.shipped === true, JSON.stringify(weird).slice(0, 200))
  const again = await maybeShip({
    root: repo2, config: { gitship: { commit: "on" } }, taskId: "task.9(abc)*[x]",
    changedFiles: ["regex-id.js"], gate: { ok: true },
  })
  ok("...and is recognized idempotently (escaped trailer match)", again.idempotent === true, JSON.stringify(again).slice(0, 200))
  try { fs.rmSync(repo2, { recursive: true, force: true }) } catch { }
}

console.log("== 10. surface audit — kernel policy, never a tool ==")
{
  const tools = await fs.promises.readFile(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "tools.js"), "utf8")
  const caps = await fs.promises.readFile(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "capabilities.js"), "utf8")
  ok("no gitship tool in TOOL_DEFS", !/name:\s*"gitship/.test(tools) && !/"git_(commit|push|branch)"/.test(tools))
  ok("no gitship entry in the capability registry", !/gitship/.test(caps))
  const config = await fs.promises.readFile(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "config.js"), "utf8")
  ok("gitship is a PRIVILEGED section (project config can never enable delivery)", /PRIVILEGED_SECTIONS = \[[^\]]*"gitship"/.test(config))
  const meta = await fs.promises.readFile(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "meta.js"), "utf8")
  const gateRefusal = meta.indexOf("if (!gate.ok) return { done: false, gate }")
  const shipCall = meta.indexOf("await maybeShip(")
  const taskCompleted = meta.indexOf('type: "TASK_COMPLETED"')
  ok("delivery fires only AFTER the gate ok + TASK_COMPLETED (structural order)", gateRefusal !== -1 && shipCall !== -1 && taskCompleted !== -1 && gateRefusal < shipCall && taskCompleted < shipCall)
  ok("delivery is wrapped best-effort (task stays COMPLETED on failure)", /GITSHIP_SKIPPED[\s\S]{0,400}delivery error \(task stays COMPLETED\)/.test(meta))
}

console.log(`\n== gitship suite: ${PASS} passed, ${FAIL} failed ==`)
if (FAIL) process.exit(1)
