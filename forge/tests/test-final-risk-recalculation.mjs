#!/usr/bin/env node
/**
 * forge — P0 final risk recalculation.
 *
 * Planning risk comes from the OBJECTIVE; final risk must come from what the
 * agent ACTUALLY changed. The canonical failure: initialRisk = trivial, the
 * agent then edits 7 files including package.json and an authentication
 * module, and final verification still ran as "trivial" (i.e. not at all).
 *
 * finalRiskForChange() inspects changed/created/deleted files, affected
 * symbols, security-sensitive paths, command and tool mutations, dependency
 * changes, configuration changes and database changes — and can only raise
 * risk, never lower it.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-risk-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-risk-work-"))
process.chdir(WORK)

const {
  riskForChange, finalRiskForChange, detectAffectedSymbols, RISK_ORDER, RISK_PROFILE,
} = await import("../verifyledger.js")
const meta = await import("../meta.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

console.log("== the documented case: trivial plan, dangerous change ==")
{
  const r = finalRiskForChange({
    task: "add a comment",
    initialRisk: "trivial",
    changedFiles: ["src/a.js", "src/b.js", "src/c.js", "package.json", "src/auth/session.js", "db/migrations/002_add_users.sql", "src/util.js"],
    affectedSymbols: ["authenticate"],
    commands: ["npm install lodash"],
  })
  eq("final risk is critical", r.risk, "critical")
  eq("initial risk preserved", r.initialRisk, "trivial")
  ok("escalated flag", r.escalated === true)
  ok("dependency signal", r.signals.includes("dependency manifest"))
  ok("auth signal", r.signals.includes("authentication/authorization module"))
  ok("database signal", r.signals.includes("database migration/schema"))
  ok("package-manager command signal", r.signals.includes("package manager mutation"))
  ok("reasons are recorded", r.reasons.length > 0)
}

console.log("== risk can only go UP, never down ==")
{
  const hi = finalRiskForChange({ initialRisk: "high", changedFiles: ["README.md"] })
  ok("a docs-only change keeps the high initial risk", RISK_ORDER[hi.risk] >= RISK_ORDER.high)
  const crit = finalRiskForChange({ initialRisk: "critical" })
  eq("critical stays critical", crit.risk, "critical")
  ok("not marked escalated when unchanged", crit.escalated === false)
}

console.log("== security-sensitive paths ==")
{
  for (const [file, min] of [
    ["src/auth/login.ts", "critical"],
    ["src/crypto/signing.js", "critical"],
    [".env.production", "critical"],
    ["package-lock.json", "high"],
    ["requirements.txt", "high"],
    ["db/schema.sql", "high"],
    [".github/workflows/ci.yml", "high"],
    ["Dockerfile", "high"],
    ["tsconfig.json", "high"],
    ["scripts/install.sh", "high"],
    ["src/shellguard.js", "high"],
  ]) {
    const r = finalRiskForChange({ initialRisk: "trivial", changedFiles: [file] })
    ok(`${file} ≥ ${min} (got ${r.risk})`, RISK_ORDER[r.risk] >= RISK_ORDER[min])
  }
}

console.log("== command / tool mutations escalate ==")
{
  const cases = [
    ["npm install express", "high"],
    ["git push origin main", "medium"],
    ["kubectl apply -f deploy.yaml", "high"],
    ["prisma migrate deploy", "high"],
    ["rm -rf build", "medium"],
    ["curl https://api.example.com/deploy", "medium"],
  ]
  for (const [cmd, min] of cases) {
    const r = finalRiskForChange({ initialRisk: "low", commands: [cmd] })
    ok(`"${cmd}" ≥ ${min} (got ${r.risk})`, RISK_ORDER[r.risk] >= RISK_ORDER[min])
  }
}

console.log("== breadth and deletion ==")
{
  const many = finalRiskForChange({ initialRisk: "low", changedFiles: Array.from({ length: 9 }, (_, i) => `src/f${i}.js`) })
  ok("9 files ≥ high", RISK_ORDER[many.risk] >= RISK_ORDER.high)
  const four = finalRiskForChange({ initialRisk: "low", changedFiles: ["a.js", "b.js", "c.js", "d.js"] })
  ok("4 files ≥ medium", RISK_ORDER[four.risk] >= RISK_ORDER.medium)
  const del = finalRiskForChange({ initialRisk: "trivial", deletedFiles: ["src/legacy.js"] })
  ok("a deletion is at least medium", RISK_ORDER[del.risk] >= RISK_ORDER.medium)
}

console.log("== affected symbols are detected from real file contents ==")
{
  const f = path.join(WORK, "authcore.js")
  fs.writeFileSync(f, "export async function authenticate(user, pw) {}\nconst authorize = async () => {}\nexport const harmless = 1\n")
  const syms = detectAffectedSymbols([f], WORK)
  ok("authenticate detected", syms.includes("authenticate"))
  ok("authorize detected", syms.includes("authorize"))
  const r = finalRiskForChange({ initialRisk: "trivial", changedFiles: ["authcore.js"], affectedSymbols: syms })
  ok("auth symbol escalates to critical", r.risk === "critical")
  ok("symbol signal recorded", r.signals.includes("auth/crypto symbol"))
  const execSym = finalRiskForChange({ initialRisk: "low", affectedSymbols: ["execSync"] })
  ok("exec-family symbol escalates", RISK_ORDER[execSym.risk] >= RISK_ORDER.high)
}

console.log("== the recalculated risk drives the verification requirement ==")
{
  ok("trivial needs syntax only", RISK_PROFILE.trivial.length === 1)
  ok("critical needs five evidence types", RISK_PROFILE.critical.length === 5)
  const r = finalRiskForChange({ initialRisk: "trivial", changedFiles: ["src/auth.js"] })
  ok("a trivial plan that touched auth now demands security evidence", RISK_PROFILE[r.risk].includes("security"))
}

console.log("== end-to-end: meta reports the FINAL risk, not the planning risk ==")
{
  const authFile = path.join(WORK, "session.js")
  fs.writeFileSync(authFile, "export function authenticate() { return null }\n")
  let call = 0
  const fake = async (args) => {
    call++
    if (args.planOnly) return { text: "1. add a comment", toolRecords: [], commandChecks: [], toolLog: [] }
    return {
      text: "done", budgetHit: false, steps: 2,
      toolRecords: [{ tool: "edit_file", files_changed: ["session.js", "package.json"] }],
      commandChecks: [{ command: "npm install lodash", exitCode: 0, passed: true, tail: "added 1 package" }],
      toolLog: [{ name: "edit_file" }],
    }
  }
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const r = await meta.runMeta({
    config: cfg, provider: { name: "x", model: "m" }, task: "add a comment to the module",
    runAgent: fake, workers: false, maxSegments: 2, signal: new AbortController().signal,
  })
  ok("planning risk was trivial/low", ["trivial", "low"].includes(r.initialRisk), )
  ok("final risk was recalculated upward", r.riskEscalated === true)
  ok("final risk is high or critical", ["high", "critical"].includes(r.risk))
  ok("risk signals were captured", (r.riskSignals ?? []).length > 0)
  ok("task did NOT complete: high risk demands real evidence", r.status !== "COMPLETED")
  console.log(`       (initial=${r.initialRisk} final=${r.risk} status=${r.status} signals=${(r.riskSignals ?? []).join("|")})`)
}

console.log(`\n== final-risk-recalculation suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
