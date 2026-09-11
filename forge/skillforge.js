/**
 * forge — skillforge (v53 rank): first-party playbooks + tagged ranking.
 *
 * Integrates many skills without dumping the pack into every prompt.
 * Bundled + ~/.forge/skills + first-party catalog are merged, then
 * evaluateSkills still caps top-k (default 3) and skips MICRO/SMALL
 * unless the skill is named. compose / agent / chat / context / meta
 * call pickSkills so the planner sees the same top-k as execute.
 *
 * Zero runtime dependencies. Does not write ~/.forge/tools.
 * Does not flip assumeYes / allowNewPlugins.
 */
import { evaluateSkills, formatSkillPicks, scoreAgainst, namedIn } from "./evaluate.js"
import { loadSkillLife, SKILL_LIFE } from "./evolve.js"
import { indexVerifiedSkills } from "./skilldl.js"

/** First-party playbooks shipped as skills/<name>/SKILL.md plus this catalog. */
export const FIRST_PARTY = [
  { name: "coding-agent", tags: ["code", "implement", "patch", "refactor", "test"], aliases: ["coder", "implement"], desc: "Plan, edit, verify, and test a code change" },
  { name: "forge-review", tags: ["review", "pr", "diff", "security", "nits"], aliases: ["review", "code-review"], desc: "Review a diff: correctness, security, blast radius, tests" },
  { name: "forge-test", tags: ["test", "jest", "pytest", "cargo", "coverage"], aliases: ["testing", "unit-test"], desc: "Add or fix tests for the files you just changed" },
  { name: "forge-debug", tags: ["bug", "crash", "stack", "repro", "root-cause"], aliases: ["debug", "diagnose"], desc: "Reproduce, isolate root cause, then one minimal fix" },
  { name: "forge-refactor", tags: ["refactor", "cleanup", "rename", "extract"], aliases: ["cleanup"], desc: "Behavior-preserving refactor with focused verify" },
  { name: "forge-security", tags: ["security", "xss", "ssrf", "secret", "auth"], aliases: ["sec", "audit"], desc: "Threat-model a change: secrets, injection, authz, SSRF" },
  { name: "forge-docs", tags: ["docs", "readme", "changelog", "comment"], aliases: ["documentation"], desc: "Update README, CHANGELOG, and in-code comments to match the change" },
  { name: "forge-git", tags: ["git", "commit", "branch", "pr", "rebase"], aliases: ["vcs"], desc: "Safe git workflow: status, focused commits, no force-push" },
  { name: "forge-api", tags: ["api", "http", "rest", "route", "openapi"], aliases: ["endpoint"], desc: "Design or patch HTTP APIs with validation and tests" },
  { name: "forge-sql", tags: ["sql", "schema", "migration", "index", "query"], aliases: ["database", "postgres"], desc: "Schema and query changes with rollback and indexes" },
  { name: "forge-frontend", tags: ["ui", "css", "react", "dom", "a11y"], aliases: ["ui", "frontend"], desc: "UI change: structure, state, accessibility, no layout regressions" },
  { name: "forge-devops", tags: ["ci", "docker", "deploy", "yaml", "pipeline"], aliases: ["ci", "ops"], desc: "CI/CD and container edits without leaking secrets" },
]

const BY_NAME = new Map(FIRST_PARTY.map((s) => [s.name, s]))

export function catalogEntry(name) {
  return BY_NAME.get(String(name ?? "").trim()) || null
}

/** Merge indexed skills with first-party tags/aliases. Does not invent missing dirs. */
export function enrichSkills(skills = []) {
  const seen = new Set()
  const out = []
  for (const s of Array.isArray(skills) ? skills : []) {
    if (!s || !s.name) continue
    seen.add(s.name)
    const cat = BY_NAME.get(s.name)
    const tags = [...new Set([...(s.tags || []), ...(cat?.tags || [])])]
    const aliases = [...new Set([...(s.aliases || []), ...(cat?.aliases || [])])]
    const desc = String(s.desc || cat?.desc || "").slice(0, 200)
    out.push({ ...s, desc, tags, aliases })
  }
  for (const cat of FIRST_PARTY) {
    if (seen.has(cat.name)) continue
    out.push({ name: cat.name, desc: cat.desc, tags: cat.tags, aliases: cat.aliases, virtual: true })
  }
  return out
}

export function scoreSkill(task, skill) {
  const s = skill || {}
  const tagBlob = [...(s.tags || []), ...(s.aliases || [])].join(" ")
  let score = scoreAgainst(task, s.name, `${s.desc || ""} ${tagBlob}`)
  for (const a of s.aliases || []) {
    if (namedIn(task, a)) score += 6
  }
  return score
}

/**
 * Rank enriched skills. Honors evaluateSkills contract:
 * MICRO/SMALL empty unless named; failed ok:false dropped; default topK 3.
 * Tags and aliases join the description blob so "debug" hits forge-debug.
 */
export function pickSkills(task, skills = [], opts = {}) {
  let base = Array.isArray(skills) ? skills.slice() : []
  try {
    const extra = indexVerifiedSkills()
    const have = new Set(base.map((s) => s?.name))
    for (const s of extra) if (s?.name && !have.has(s.name)) base.push(s)
  } catch { /* downloads are best-effort */ }
  const enriched = enrichSkills(base)
  let life = {}
  if (opts.cwd) {
    try { life = loadSkillLife(opts.cwd).skills || {} } catch { life = {} }
  }
  const tagged = enriched.map((s) => ({
    ...s,
    lifecycle: (s.name && life[s.name]?.lifecycle)
      || s.lifecycle
      || (s.learned ? SKILL_LIFE.CANDIDATE : SKILL_LIFE.ACTIVE),
  }))
  const scored = evaluateSkills(task, tagged.map((s) => ({
    ...s,
    desc: `${s.desc || ""} ${(s.tags || []).join(" ")} ${(s.aliases || []).join(" ")}`.trim(),
  })), opts)
  return scored
}

export function formatForgePicks(picks = []) {
  const body = formatSkillPicks(picks)
  if (!body) return ""
  return `${body}\nCall load_skill(name) for the playbook body. Do not invent a skill name.`
}

export function firstPartyNames() {
  return FIRST_PARTY.map((s) => s.name)
}
