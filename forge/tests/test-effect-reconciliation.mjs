#!/usr/bin/env node
/**
 * forge — P1 effect reconciliation.
 *
 * After a crash the only honest question is "what actually happened?" — not
 * "what did I ask for?". Every effect is reconciled against OBSERVED state and
 * classified as DONE / NOT_DONE / PARTIAL / UNKNOWN. Non-idempotent operations
 * (a migration, a network mutation, a merge in progress) are NEVER blind-retried
 * — they go to the operator.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-effect-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-effect-work-"))
process.chdir(WORK)

const rec = await import("../recovery.js")
const { fullFileHash } = await import("../checkpoint.js")
const { reconcileEffect, reconcileEffectByKind, classifyEffectKind, EFFECT_KIND, EFFECT_STATUS, UNKNOWN_DECISION, observeEffects } = rec

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

console.log("== file effects ==")
{
  const f = path.join(WORK, "a.js")
  fs.writeFileSync(f, "content v1")
  let r = reconcileEffect({ kind: "file_write", path: f, expectedHash: "deadbeef" }, WORK)
  ok("a hash mismatch is NOT a confirmed write", r.effectStatus !== EFFECT_STATUS.DONE)
  r = reconcileEffect({ kind: "file_write", path: f }, WORK)
  ok("reconcile never throws on a partial expectation", typeof r === "object")
  r = reconcileEffect({ kind: "file_write", path: f, expectedHash: fullFileHash(f).sha }, WORK)
  eq("a matching hash confirms the write", r.effectStatus, EFFECT_STATUS.DONE)
  // observed: the file exists
  const obs = observeEffects({ cwd: WORK, files: { [f]: { action: "modified" } } })
  ok("an existing file is observed as modified", obs.modified.includes(f))
  const ghost = path.join(WORK, "never-written.js")
  const obs2 = observeEffects({ cwd: WORK, files: { [ghost]: { action: "modified" } } })
  ok("a missing file is observed as missing", obs2.missing.includes(ghost))
  fs.writeFileSync(ghost, "now it exists")
  const obs3 = observeEffects({ cwd: WORK, files: { [ghost]: { action: "created" } } })
  ok("a newly present file is observed as created", obs3.created.includes(ghost))
}

console.log("== effect kinds are classified ==")
{
  eq("npm install", classifyEffectKind("npm install lodash"), EFFECT_KIND.PACKAGE_INSTALL)
  eq("pip install", classifyEffectKind("pip install requests"), EFFECT_KIND.PACKAGE_INSTALL)
  eq("git commit", classifyEffectKind("git commit -m x"), EFFECT_KIND.GIT)
  eq("git merge", classifyEffectKind("git merge feature"), EFFECT_KIND.GIT)
  eq("migration", classifyEffectKind("prisma migrate deploy"), EFFECT_KIND.DB_MIGRATION)
  eq("rails migrate", classifyEffectKind("rails db:migrate"), EFFECT_KIND.DB_MIGRATION)
  eq("server start", classifyEffectKind("node server.js &"), EFFECT_KIND.PROCESS_LAUNCH)
  eq("curl", classifyEffectKind("curl -X POST https://api.example.com/deploy"), EFFECT_KIND.NETWORK_MUTATION)
  eq("rm", classifyEffectKind("rm -rf build"), EFFECT_KIND.FILE_DELETE)
  eq("plain build", classifyEffectKind("npm run build"), EFFECT_KIND.BASH)
}

console.log("== package installation ==")
{
  const nm = path.join(WORK, "node_modules", "left-pad")
  fs.mkdirSync(nm, { recursive: true })
  fs.writeFileSync(path.join(nm, "package.json"), '{"name":"left-pad","version":"1.0.0"}')
  let r = reconcileEffectByKind({ kind: EFFECT_KIND.PACKAGE_INSTALL, packages: ["left-pad"] }, WORK)
  eq("an installed package is DONE", r.effectStatus, EFFECT_STATUS.DONE)
  eq("the decision is to continue", r.decision, UNKNOWN_DECISION.CONTINUE)
  r = reconcileEffectByKind({ kind: EFFECT_KIND.PACKAGE_INSTALL, packages: ["not-installed"] }, WORK)
  ok("a missing package is NOT DONE", r.effectStatus !== EFFECT_STATUS.DONE)
  ok("it insists on proof before repeating", r.decision === UNKNOWN_DECISION.ASK_USER || r.decision === UNKNOWN_DECISION.RETRY)
  r = reconcileEffectByKind({ kind: EFFECT_KIND.PACKAGE_INSTALL, packages: ["left-pad", "not-installed"] }, WORK)
  eq("a mixed result is PARTIAL", r.effectStatus, EFFECT_STATUS.PARTIAL)
  ok("a retry is allowed for an idempotent install", r.decision === UNKNOWN_DECISION.RETRY)
}

console.log("== database migration is never blind-retried ==")
{
  let r = reconcileEffectByKind({ kind: EFFECT_KIND.DB_MIGRATION }, WORK)
  eq("unproven migration is UNKNOWN", r.effectStatus, EFFECT_STATUS.UNKNOWN)
  eq("the operator is asked", r.decision, UNKNOWN_DECISION.ASK_USER)
  ok("the reason says it is not idempotent", /not idempotent/i.test(r.reason))
  r = reconcileEffectByKind({ kind: EFFECT_KIND.DB_MIGRATION, verified: true, exitCode: 0 }, WORK)
  eq("an observed exit 0 is DONE", r.effectStatus, EFFECT_STATUS.DONE)
  r = reconcileEffectByKind({ kind: EFFECT_KIND.DB_MIGRATION, verified: true, exitCode: 1 }, WORK)
  ok("a failed migration is not DONE", r.effectStatus !== EFFECT_STATUS.DONE)
}

console.log("== process launch ==")
{
  let r = reconcileEffectByKind({ kind: EFFECT_KIND.PROCESS_LAUNCH, pid: process.pid }, WORK)
  eq("a live pid is DONE", r.effectStatus, EFFECT_STATUS.DONE)
  r = reconcileEffectByKind({ kind: EFFECT_KIND.PROCESS_LAUNCH, pid: 999999 }, WORK)
  ok("a dead pid is not DONE", r.effectStatus !== EFFECT_STATUS.DONE)
  r = reconcileEffectByKind({ kind: EFFECT_KIND.PROCESS_LAUNCH }, WORK)
  eq("no pid means unknown", r.effectStatus, EFFECT_STATUS.UNKNOWN)
  eq("and the operator is asked", r.decision, UNKNOWN_DECISION.ASK_USER)
}

console.log("== network mutation ==")
{
  const r = reconcileEffectByKind({ kind: EFFECT_KIND.NETWORK_MUTATION }, WORK)
  eq("a remote effect is UNKNOWN", r.effectStatus, EFFECT_STATUS.UNKNOWN)
  eq("it asks instead of replaying", r.decision, UNKNOWN_DECISION.ASK_USER)
  ok("the reason warns about the unobservable remote effect", /remote/i.test(r.reason))
}

console.log("== every verdict is structured and auditable ==")
{
  for (const kind of Object.values(EFFECT_KIND)) {
    const r = reconcileEffectByKind({ kind }, WORK)
    ok(`${kind}: has a decision`, typeof r.decision === "string")
    ok(`${kind}: has an effect status`, Object.values(EFFECT_STATUS).includes(r.effectStatus))
    ok(`${kind}: carries expected + observed`, "expectedEffects" in r && "observedEffects" in r)
    ok(`${kind}: explains itself`, typeof r.reason === "string" && r.reason.length > 0)
  }
}

console.log("== status vocabulary is complete ==")
{
  for (const k of ["DONE", "NOT_DONE", "PARTIAL", "UNKNOWN"]) ok(`EFFECT_STATUS.${k}`, typeof EFFECT_STATUS[k] === "string")
  for (const k of ["CONTINUE", "RETRY", "ASK_USER", "COMPENSATE"]) ok(`UNKNOWN_DECISION.${k}`, typeof UNKNOWN_DECISION[k] === "string")
}

console.log(`\n== effect-reconciliation suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
