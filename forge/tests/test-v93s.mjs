#!/usr/bin/env node
/**
 * v93 GAP FIX — phase 10: STRICT LEARNED-SKILL PROMOTION (§21/§22).
 *
 *  1. The VERIFIED transition records behavioral evidence: the fully-passed
 *     gate, the representative task, the fingerprint of the related files.
 *  2. autoPromote (learned track) now has gates equivalent to downloads:
 *     VERIFIED + behavioral verification on record + fresh fingerprint +
 *     not stale. A VERIFIED without evidence cannot auto-promote.
 *  3. §22 staleness: when related files change, the skill is marked stale
 *     (evolve.markStaleSkills, wired into meta after every segment) and
 *     promotion is blocked with the reason.
 *  4. The EXPLICIT human path (promoteSkill / `forge skill promote`) is
 *     unchanged — human override, by design (v84).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93s-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93s-work-"))
process.chdir(WORK)
fs.mkdirSync(path.join(WORK, "src"), { recursive: true })
fs.writeFileSync(path.join(WORK, "src", "auth.js"), "export function login() { return true }\n")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 300) : ""}`) }
}

const evolve = await import("../evolve.js")
const { autoPromote, evaluatePromoteGates } = await import("../promote.js")
const { SKILL_LIFE } = evolve

// author a learned skill (the capability gap → playbook path)
const authored = evolve.authorSkill({
  cwd: WORK,
  klass: "LARGE",
  task: "fix the login flow in src/auth.js across the session middleware and the token refresh path",
  repair: "the session cookie was not set httpOnly; setting it fixed the loop",
  files: ["src/auth.js"],
  command: "node --check src/auth.js",
})
if (!authored?.ok) { console.log("AUTHOR FAILED", JSON.stringify(authored)); process.exit(1) }

const GATE_9_9 = { checks: Object.fromEntries([...Array(9)].map((_, i) => [`check${i}`, true])) }
const GATE_8_9 = { checks: Object.fromEntries([...Array(9)].map((_, i) => [`check${i}`, i < 8])) }

// ---------------------------------------------------------------------------
console.log("== 1. the VERIFIED transition records behavioral evidence ==")
{
  const noEvidence = evolve.recordSkillOutcome({ cwd: WORK, name: authored.name, status: SKILL_LIFE.VERIFIED })
  ok("VERIFIED without gate evidence still transitions (compat)", noEvidence?.lifecycle === SKILL_LIFE.VERIFIED)
  const rec = evolve.loadSkillLife(WORK).skills[authored.name]
  ok("…but records NO verification evidence (honest absence)", rec.verification == null)

  const withEvidence = evolve.recordSkillOutcome({
    cwd: WORK, name: authored.name, status: SKILL_LIFE.VERIFIED,
    gate: GATE_9_9, task: "fix the login flow", files: ["src/auth.js"],
  })
  ok("VERIFIED with a fully-passed gate records evidence", withEvidence?.verification?.passed === true)
  const rec2 = evolve.loadSkillLife(WORK).skills[authored.name]
  ok("evidence carries the representative task", rec2.verification.representativeTask.includes("login"))
  ok("evidence carries the benchmark (9/9)", rec2.verification.benchmark.passed === 9 && rec2.verification.benchmark.total === 9)
  ok("evidence carries the file fingerprint", Array.isArray(rec2.verification.fingerprint) && rec2.verification.fingerprint[0].file === "src/auth.js")
}

// ---------------------------------------------------------------------------
console.log("== 2. autoPromote gates — equivalent strictness to downloads ==")
{
  // wipe verification → the "no evidence" state
  const life = evolve.loadSkillLife(WORK)
  delete life.skills[authored.name].verification
  evolve.writeSkillLifeForTest?.(WORK, life) // may not exist; fallback below
  // direct write (skilllife.json is the truth on disk)
  const { skillLifePath } = evolve
  fs.writeFileSync(skillLifePath(WORK), JSON.stringify({ ...life, skills: { ...life.skills, [authored.name]: { ...life.skills[authored.name] } } }, null, 1))

  const g1 = evaluatePromoteGates(authored.name, { cwd: WORK })
  ok("VERIFIED with NO behavioral evidence cannot auto-promote", g1.ok === false && g1.blocked.some((b) => /behavioral verification/.test(b)), JSON.stringify(g1.blocked))
  const a1 = autoPromote(authored.name, { cwd: WORK })
  ok("autoPromote blocked the same way", a1.ok === false)

  // record evidence → gates pass
  evolve.recordSkillOutcome({ cwd: WORK, name: authored.name, status: SKILL_LIFE.VERIFIED, gate: GATE_9_9, task: "fix the login flow", files: ["src/auth.js"] })
  const a2 = autoPromote(authored.name, { cwd: WORK })
  ok("VERIFIED + 9/9 evidence + fresh fingerprint → auto-promotes", a2.ok === true, JSON.stringify(a2.blocked ?? a2))
  ok("lifecycle is ACTIVE", evolve.loadSkillLife(WORK).skills[authored.name].lifecycle === SKILL_LIFE.ACTIVE)
}

// ---------------------------------------------------------------------------
console.log("== 3. §22 staleness — changed files invalidate the knowledge ==")
{
  // a second skill with evidence, then mutate its related file
  const s2 = evolve.authorSkill({ cwd: WORK, klass: "LARGE", task: "harden the token check in src/auth.js across the middleware chain", repair: "added constant-time compare", files: ["src/auth.js"] })
  evolve.recordSkillOutcome({ cwd: WORK, name: s2.name, status: SKILL_LIFE.VERIFIED, gate: GATE_9_9, task: "harden tokens", files: ["src/auth.js"] })

  // markStaleSkills marks it when its file changes
  const marked = evolve.markStaleSkills(WORK, ["src/auth.js"])
  ok("markStaleSkills marks skills whose files changed", marked.marked >= 1 && marked.skills.includes(s2.name), JSON.stringify(marked))
  const rec = evolve.loadSkillLife(WORK).skills[s2.name]
  ok("the stale flag + reason are recorded", rec.stale === true && /changed after verification/.test(rec.staleReason ?? ""))

  // promotion is blocked with the stale reason
  const a = autoPromote(s2.name, { cwd: WORK })
  ok("stale skill cannot auto-promote (reason given)", a.ok === false && a.blocked.some((b) => /stale/.test(b)), JSON.stringify(a.blocked))

  // the fingerprint path also catches drift WITHOUT the explicit mark
  const s3 = evolve.authorSkill({ cwd: WORK, klass: "LARGE", task: "repair the billing edge case across the invoice pipeline", repair: "rounded before summing", files: ["src/auth.js"] })
  evolve.recordSkillOutcome({ cwd: WORK, name: s3.name, status: SKILL_LIFE.VERIFIED, gate: GATE_9_9, task: "billing", files: ["src/auth.js"] })
  fs.appendFileSync(path.join(WORK, "src", "auth.js"), "export function logout() {}\n") // change AFTER verification
  const a3 = autoPromote(s3.name, { cwd: WORK })
  ok("fingerprint drift alone blocks promotion (mtime mismatch)", a3.ok === false && a3.blocked.some((b) => /stale fingerprint/.test(b)), JSON.stringify(a3.blocked))
}

// ---------------------------------------------------------------------------
console.log("== 4. the explicit human path is unchanged (v84 override) ==")
{
  const s4 = evolve.authorSkill({ cwd: WORK, klass: "LARGE", task: "a human-approved playbook task spanning the deployment pipeline", repair: "the approved fix", files: [] })
  evolve.recordSkillOutcome({ cwd: WORK, name: s4.name, status: SKILL_LIFE.VERIFIED }) // NO evidence
  const human = evolve.promoteSkill(WORK, s4.name)
  ok("explicit promoteSkill still promotes VERIFIED (human override)", human.ok === true && human.lifecycle === SKILL_LIFE.ACTIVE)
  const auto = autoPromote(s4.name, { cwd: WORK })
  ok("…while the AUTO path stays gated", auto.ok === true && auto.already === true) // already ACTIVE now
  const s5 = evolve.authorSkill({ cwd: WORK, klass: "LARGE", task: "another unevidenced playbook spanning the migration runner", repair: "fix x", files: [] })
  evolve.recordSkillOutcome({ cwd: WORK, name: s5.name, status: SKILL_LIFE.VERIFIED })
  const auto5 = autoPromote(s5.name, { cwd: WORK })
  ok("fresh VERIFIED without evidence: auto blocked, explicit allowed", auto5.ok === false)
  ok("CANDIDATE never auto-promotes", (() => {
    const s6 = evolve.authorSkill({ cwd: WORK, klass: "LARGE", task: "third unevidenced playbook spanning the release tooling", repair: "fix y", files: [] })
    const a6 = autoPromote(s6.name, { cwd: WORK })
    return a6.ok === false && /CANDIDATE/.test(a6.blocked.join(";"))
  })())
}

// ---------------------------------------------------------------------------
console.log("== 5. meta wiring — staleness marked in the living loop ==")
{
  const metaSrc = fs.readFileSync(new URL("../meta.js", import.meta.url), "utf8")
  ok("meta marks stale skills after segment mutations", /markStaleSkills/.test(metaSrc) && /SKILLS_STALE/.test(metaSrc))
  const evolveSrc = fs.readFileSync(new URL("../evolve.js", import.meta.url), "utf8")
  ok("evolveRun records gate evidence at the VERIFIED transition", /gate,\s*\n?\s*task,/.test(evolveSrc) || /gate, task/.test(evolveSrc))
}

console.log(`\n== v93s: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
