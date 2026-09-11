/**
 * forge — gap experiment engine (v78, zero dependencies)
 *
 * Blocking gap → hypothesis → focused test (shellguard) → recordGapOutcome.
 * Pass may author a CANDIDATE skill from the gap (not only from a repair).
 * Fail → CONTRADICTED. Never invent npm test. Never skip without a ledger.
 * Never auto-ACTIVE. Compose never writes. Not a second infogain/hypothesis.
 */
import { classifyCommand } from "./shellguard.js"
import { recordGapOutcome, loadGapStats, LIFECYCLE, domainIds } from "./knowgap.js"
import { authorSkill, SKILL_LIFE } from "./evolve.js"
import { parseSkillPlaybook } from "./skills.js"
import { TASK_CLASS } from "./classify.js"
import { recordStrategy } from "./strategy.js"
import { runCommand, EXEC_STATUS, generatedTestProvenance } from "./execresult.js"

const TEST_TIMEOUT_MS = 15_000
const REFUSE = new Set(["block", "danger", "confirm"])

const INVENTED = /^(npm test|yarn test|pnpm test|cargo test|pytest|go test)\b/i

export function generateGapTest(gap, { command, blast } = {}) {
  const explicit = String(command || "").trim()
  if (explicit) {
    return {
      ok: true, command: explicit.slice(0, 200), source: "explicit",
      provenance: generatedTestProvenance({ command: explicit, sourceGap: gap?.id, reason: "explicit --command", generator: "forge-generateGapTest" }),
    }
  }
  const mapped = (blast?.tests || gap?.acquire?.tests || []).map((t) => String(t || "").trim()).find(Boolean)
  if (mapped) {
    if (INVENTED.test(mapped)) {
      return { ok: false, skipped: "no-focused-test", reason: "mapped toolchain is invented — pass --command to run it" }
    }
    return {
      ok: true, command: mapped.slice(0, 200), source: "graph",
      provenance: generatedTestProvenance({ command: mapped, sourceGap: gap?.id, reason: "mapped from blast/acquire tests", generator: "forge-generateGapTest" }),
    }
  }
  const q = String(gap?.acquire?.query || "").trim()
  if (gap?.acquire?.method === "verify" && q && !/^verify\s/i.test(q) && q !== "verify with a focused test, do not re-search") {
    if (INVENTED.test(q)) {
      return { ok: false, skipped: "no-focused-test", reason: "acquire query invents a toolchain — pass --command" }
    }
    return {
      ok: true, command: q.slice(0, 200), source: "acquire",
      provenance: generatedTestProvenance({ command: q, sourceGap: gap?.id, reason: "acquire verify query", generator: "forge-generateGapTest" }),
    }
  }
  return {
    ok: false,
    skipped: "no-focused-test",
    reason: "no mapped test and no command — never invent npm test",
  }
}

export function hypothesize(gap, { command, blast } = {}) {
  const id = String(gap?.id || "").trim()
  const gen = generateGapTest(gap, { command, blast })
  return {
    id,
    hypothesis: id
      ? `If a focused test for ${id} passes, the domain is VERIFIED; if it fails, CONTRADICTED.`
      : "",
    command: gen.ok ? gen.command : "",
    source: gen.source || null,
    skipped: gen.ok ? null : gen.skipped,
    reason: gen.reason || null,
  }
}

function refuseLevel(level) {
  return REFUSE.has(level)
}

export function runExperiment({
  cwd = process.cwd(), id = "", command = "", task = "", klass = null, blast = null, generateSkill = true,
} = {}) {
  const domain = String(id || "").trim()
  const ledger = []
  if (!domain || !domainIds().includes(domain)) {
    return { ok: false, error: `unknown domain "${domain}"`, ledger }
  }
  const rec = loadGapStats(cwd).domains?.[domain] || { id: domain }
  const hypo = hypothesize({ ...rec, id: domain }, { command, blast })
  ledger.push({ hypothesis: hypo.hypothesis, command: hypo.command, source: hypo.source, skipped: hypo.skipped })
  if (!hypo.command) {
    return { ok: false, skipped: hypo.skipped || "no-focused-test", reason: hypo.reason, ledger, id: domain }
  }
  const cls = classifyCommand(hypo.command, { cwd, root: cwd })
  if (refuseLevel(cls.level)) {
    ledger.push({ skipped: "shellguard", command: hypo.command, level: cls.level })
    return { ok: false, skipped: "shellguard", command: hypo.command, level: cls.level, ledger, id: domain }
  }
  const exec = runCommand(hypo.command, { cwd, timeoutMs: TEST_TIMEOUT_MS })
  const passed = exec.status === EXEC_STATUS.PASS
  ledger.push({
    command: hypo.command,
    ok: passed,
    code: exec.exitCode,
    timed: exec.timedOut,
    status: exec.status,
    truncated: exec.truncated,
    killed: exec.killed,
    level: cls.level,
  })
  const life = passed ? LIFECYCLE.VERIFIED : LIFECYCLE.CONTRADICTED
  let outcome = null
  try {
    outcome = recordGapOutcome({
      cwd, id: domain, status: life,
      evidence: `experiment ${hypo.command} ${passed ? "pass" : exec.timedOut ? "timeout" : exec.status === EXEC_STATUS.TRUNCATED ? "truncated" : exec.status === EXEC_STATUS.UNKNOWN ? "unknown" : `exit ${exec.exitCode}`}`,
    })
  } catch { /* persist is best-effort */ }
  try { recordStrategy({ cwd, name: "experiment", ok: passed }) } catch { /* best-effort */ }
  let skill = { ok: false, skipped: passed ? "not-requested" : "not-verified" }
  if (passed && generateSkill) {
    try {
      skill = authorSkill({
        cwd,
        task: task || `close knowledge gap ${domain}`,
        klass: klass || TASK_CLASS.MEDIUM,
        repair: `Focused experiment \`${hypo.command}\` passed for domain ${domain}. Reuse this check before expanding scope.`,
        command: hypo.command,
      })
    } catch (e) {
      skill = { ok: false, skipped: "write", error: String(e?.message || e).slice(0, 120) }
    }
  }
  return {
    ok: passed,
    id: domain,
    command: hypo.command,
    lifecycle: life,
    skill,
    ledger,
    outcome: outcome?.domains?.[domain] || null,
  }
}

/**
 * Playbook vs the repair it came from. Distinct bodies win. Empty playbook loses.
 */
export function benchmarkPlaybook({ playbook = "", repair = "" } = {}) {
  const p = parseSkillPlaybook(playbook)
  const repairBody = String(repair || "").trim()
  const playBody = String(p.repair || "").trim()
  const playbookScore = (playBody ? 2 : 0) + ((p.files || []).length ? 1 : 0) + (p.command ? 1 : 0)
  const repairScore = repairBody ? 2 : 0
  const winner = playbookScore > repairScore ? "playbook" : playbookScore < repairScore ? "repair" : "tie"
  return {
    playbookScore,
    repairScore,
    winner,
    files: (p.files || []).length,
    command: p.command || "",
    distinct: playBody.length > 0 && playBody !== repairBody,
  }
}

export function formatExperimentReport(r) {
  if (!r) return "experiment: (empty)\n"
  if (r.error) return `experiment: ${r.error}\n`
  const lines = [`experiment  ${r.id || ""}  ${r.ok ? "PASS" : (r.skipped || "FAIL")}`]
  if (r.command) lines.push(`  command   ${r.command}`)
  if (r.lifecycle) lines.push(`  gap       ${r.lifecycle}`)
  if (r.skill?.ok) lines.push(`  skill     ${r.skill.name}  ${r.skill.lifecycle || SKILL_LIFE.CANDIDATE}`)
  else if (r.skill?.skipped) lines.push(`  skill     skipped (${r.skill.skipped})`)
  if (r.reason) lines.push(`  reason    ${r.reason}`)
  lines.push("  DOWNLOAD ≠ TRUST. Never auto-ACTIVE. Never invent npm test.")
  return lines.join("\n") + "\n"
}
