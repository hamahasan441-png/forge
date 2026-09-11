#!/usr/bin/env node
/**
 * forge — P1 git effect recovery.
 *
 * `git status --porcelain` cannot answer "did the commit land?" after a crash.
 * The git effect model captures HEAD, branch, staged vs unstaged vs untracked,
 * the stash count and any operation in progress, then diffs BEFORE vs AFTER and
 * decides per operation — never blind-replaying a non-idempotent git command.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-git-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-git-work-"))
process.chdir(WORK)

const git = await import("../recovery.js")
const { gitState, gitEffectDiff, reconcileGitOperation, gitOperationInProgress, UNKNOWN_DECISION, EFFECT_STATUS } = git

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const sh = (cmd) => execFileSync("bash", ["-c", cmd], { cwd: WORK, encoding: "utf8" })
const REPO = path.join(WORK, "repo")
fs.mkdirSync(REPO, { recursive: true })
sh(`cd repo && git init -q && git config user.email t@t.t && git config user.name t && echo one > a.txt && git add a.txt && git -c commit.gpgsign=false commit -qm one`)

console.log("== the state model captures everything recovery needs ==")
{
  fs.writeFileSync(path.join(REPO, "b.txt"), "two")
  const st = gitState(REPO)
  ok("is a repo", st.isRepo === true)
  ok("HEAD is recorded", typeof st.head === "string" && st.head.length === 40)
  ok("branch is recorded", st.branch === "master" || st.branch === "main")
  ok("untracked file observed", st.untracked.includes("b.txt"))
  ok("no staged files yet", st.staged.length === 0)
  ok("operation is none yet", st.operation === null)
  ok("dirty count reflects the tree", st.dirty === 1)
  sh("cd repo && git add b.txt")
  const st2 = gitState(REPO)
  ok("staged file observed after add", st2.staged.includes("b.txt"))
  ok("untracked is now empty", st2.untracked.length === 0)
}

console.log("== commit: HEAD movement is the effect ==")
{
  const before = gitState(REPO)
  sh(`cd repo && git -c commit.gpgsign=false commit -qm two`)
  const after = gitState(REPO)
  const diff = gitEffectDiff(before, after)
  ok("HEAD changed", diff.headChanged === true)
  eq("previous HEAD recorded", diff.previousHead, before.head)
  eq("current HEAD recorded", diff.currentHead, after.head)
  let r = reconcileGitOperation({ operation: "commit" }, { before, after, cwd: REPO })
  eq("the commit landed → DONE", r.effectStatus, EFFECT_STATUS.DONE)
  eq("decision is continue", r.decision, UNKNOWN_DECISION.CONTINUE)
  // the same command after it landed is NOT re-run
  r = reconcileGitOperation({ operation: "commit" }, { before: after, after, cwd: REPO })
  eq("a commit that did not move HEAD is NOT_DONE", r.effectStatus, EFFECT_STATUS.NOT_DONE)
  eq("a guarded retry is allowed", r.decision, UNKNOWN_DECISION.RETRY)
}

console.log("== checkout / reset / branch ==")
{
  const before = gitState(REPO)
  sh("cd repo && git checkout -q -b feature")
  const after = gitState(REPO)
  eq("branch changed", after.branch, "feature")
  let r = reconcileGitOperation({ operation: "checkout" }, { before, after, cwd: REPO })
  eq("the checkout landed", r.effectStatus, EFFECT_STATUS.DONE)
  r = reconcileGitOperation({ operation: "checkout" }, { before: after, after, cwd: REPO })
  eq("a checkout that changed nothing is NOT_DONE", r.effectStatus, EFFECT_STATUS.NOT_DONE)

  sh("cd repo && echo three > c.txt && git add c.txt && git -c commit.gpgsign=false commit -qm three")
  const b2 = gitState(REPO)
  sh("cd repo && git reset -q --hard HEAD~1")
  const a2 = gitState(REPO)
  r = reconcileGitOperation({ operation: "reset" }, { before: b2, after: a2, cwd: REPO })
  eq("the reset landed", r.effectStatus, EFFECT_STATUS.DONE)
}

console.log("== stash ==")
{
  sh("cd repo && echo dirty >> a.txt")
  const before = gitState(REPO)
  sh("cd repo && git stash -q")
  const after = gitState(REPO)
  ok("stash count increased", after.stashCount > before.stashCount)
  const r = reconcileGitOperation({ operation: "stash" }, { before, after, cwd: REPO })
  eq("the stash landed", r.effectStatus, EFFECT_STATUS.DONE)
  const r2 = reconcileGitOperation({ operation: "stash" }, { before: after, after, cwd: REPO })
  eq("an unchanged stash count is NOT_DONE", r2.effectStatus, EFFECT_STATUS.NOT_DONE)
}

console.log("== an operation left in progress is PARTIAL, never auto-resolved ==")
{
  // build a real conflict
  sh("cd repo && git checkout -q master 2>/dev/null || git checkout -q main")
  sh("cd repo && echo base > conflict.txt && git add conflict.txt && git -c commit.gpgsign=false commit -qm base")
  sh("cd repo && git checkout -q -b other && echo other > conflict.txt && git add conflict.txt && git -c commit.gpgsign=false commit -qm other")
  sh("cd repo && git checkout -q -")
  sh("cd repo && echo mine > conflict.txt && git add conflict.txt && git -c commit.gpgsign=false commit -qm mine")
  let mergeFailed = false
  try { sh("cd repo && git merge other") } catch { mergeFailed = true }
  ok("the merge conflicts (fixture is valid)", mergeFailed)
  eq("a merge is detected as in progress", gitOperationInProgress(REPO), "merge")
  const st = gitState(REPO)
  eq("the state reports the operation", st.operation, "merge")
  const r = reconcileGitOperation({ operation: "merge" }, { before: null, after: st, cwd: REPO })
  eq("the verdict is PARTIAL", r.effectStatus, EFFECT_STATUS.PARTIAL)
  eq("the controller must compensate, not guess", r.decision, UNKNOWN_DECISION.COMPENSATE)
  ok("it refuses to auto-resolve conflicts", /never auto-resolve|finish or abort/i.test(r.reason))
  // clean up so later checks are unaffected
  sh("cd repo && git merge --abort")
  eq("after abort, no operation is in progress", gitOperationInProgress(REPO), null)
}

console.log("== unknown operations and non-repos are escalated, never guessed ==")
{
  const st = gitState(REPO)
  const r = reconcileGitOperation({ operation: "svn-rebase" }, { before: st, after: st, cwd: REPO })
  eq("an unknown operation is UNKNOWN", r.effectStatus, EFFECT_STATUS.UNKNOWN)
  eq("and the operator is asked", r.decision, UNKNOWN_DECISION.ASK_USER)
  const r2 = reconcileGitOperation({ operation: "commit" }, { before: null, after: null, cwd: path.join(WORK, "not-a-repo") })
  eq("outside a repo the effect is UNKNOWN", r2.effectStatus, EFFECT_STATUS.UNKNOWN)
  eq("and the operator is asked", r2.decision, UNKNOWN_DECISION.ASK_USER)
  const notRepo = gitState(path.join(WORK, "not-a-repo"))
  eq("gitState reports isRepo false", notRepo.isRepo, false)
}

console.log("== the effect diff is structured and complete ==")
{
  const a = gitState(REPO)
  const d = gitEffectDiff(a, a)
  for (const k of ["previousHead", "currentHead", "headChanged", "branch", "staged", "unstaged", "untracked", "stashCount", "operation", "isRepo"]) {
    ok(`diff.${k} present`, k in d)
  }
  ok("staged has before/after", "before" in d.staged && "after" in d.staged)
}

console.log(`\n== git-recovery suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
