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
  // v94b: understand-anything pack (bundled, Egonex-AI/Understand-Anything) —
  // codebase → knowledge graph. Tags route tasks to the right skill; the
  // playbooks are the authority once loaded via load_skill.
  { name: "understand", tags: ["architecture", "knowledge-graph", "codebase", "analyze", "structure", "map", "overview", "dependencies"], aliases: ["ua", "code-map", "analyze-codebase"], desc: "Analyze a codebase into a knowledge graph of files, symbols, and relationships (.ua/)" },
  { name: "understand-chat", tags: ["ask", "question", "codebase", "qa", "graph", "where", "how-does"], aliases: ["ua-chat"], desc: "Answer questions about a codebase using its knowledge graph" },
  { name: "understand-dashboard", tags: ["dashboard", "visualize", "graph", "explore", "browser"], aliases: ["ua-dashboard"], desc: "Launch the interactive web dashboard for a project's knowledge graph" },
  { name: "understand-diff", tags: ["diff", "pr", "change", "risk", "impact", "affected", "review"], aliases: ["change-impact"], desc: "Analyze a diff/PR for affected components and risks using the knowledge graph" },
  { name: "understand-domain", tags: ["domain", "business", "entities", "flows", "ubiquitous-language"], aliases: ["domain-model"], desc: "Extract business domain knowledge and an interactive domain flow graph" },
  { name: "understand-explain", tags: ["explain", "deep-dive", "module", "function", "walkthrough", "teach"], aliases: ["walkthrough", "explain-code"], desc: "Deep-dive explanation of a specific file, function, or module" },
  { name: "understand-figma", tags: ["figma", "design", "tokens", "ui", "mockup"], aliases: ["design-graph"], desc: "Analyze a Figma file into a design knowledge graph (pages, components, tokens)" },
  { name: "understand-knowledge", tags: ["wiki", "knowledge-base", "entities", "topics", "notes"], aliases: ["kb-graph"], desc: "Turn a knowledge base / LLM wiki into an entity-relationship knowledge graph" },
  { name: "understand-onboard", tags: ["onboarding", "new-team", "guide", "tour", "ramp-up"], aliases: ["onboarding-guide", "onboard-me"], desc: "Generate an onboarding guide for engineers joining the project" },
  // v94 skillwise: obra/superpowers pack (bundled, MIT, github.com/obra/superpowers)
  // — engineering PROCESS discipline: 13 of 14 upstream skills imported
  // byte-identical (upstream `writing-plans` NOT bundled: forge already ships
  // its own adapted writing-plans; no-overwrite policy). 5 skills that touch
  // platform seams (subagent dispatch, script paths, harness mapping) carry an
  // appended "## Forge execution notes" section — upstream content preserved
  // as a byte-identical prefix (v94b precedent). Tags route tasks to the right
  // skill; the playbooks are the authority once loaded via load_skill.
  { name: "brainstorming", tags: ["brainstorm", "requirements", "design", "spec", "creative", "intent"], aliases: ["ideate", "pre-implementation-design"], desc: "Explore user intent, requirements, and design BEFORE any creative work or new feature" },
  { name: "dispatching-parallel-agents", tags: ["parallel", "subagents", "fan-out", "independent-tasks", "concurrency"], aliases: ["parallel-agents", "fan-out"], desc: "Dispatch 2+ independent tasks to parallel subagents with self-contained briefs" },
  { name: "executing-plans", tags: ["execute-plan", "implementation-plan", "checkpoints", "review-gates"], aliases: ["plan-execution"], desc: "Execute a written implementation plan with review checkpoints per task" },
  { name: "finishing-a-development-branch", tags: ["merge", "integration", "branch", "pr", "cleanup"], aliases: ["finish-branch", "merge-branch"], desc: "Decide how to integrate completed, verified work: merge, PR, or keep" },
  { name: "receiving-code-review", tags: ["code-review", "feedback", "critique", "technical-rigor"], aliases: ["review-feedback", "handle-review"], desc: "Receive review feedback with rigor: verify claims before implementing, no performative agreement" },
  // v113 audit: "code-reviewer" was an alias here AND a real skill name (added
  // with the v99 bundled pack). Those are different capabilities — this one
  // DISPATCHES a review subagent, the other REVIEWS a change — so the alias
  // made "code-reviewer" resolve ambiguously. The real skill of that name wins.
  { name: "requesting-code-review", tags: ["code-review", "review-request", "pre-merge", "quality"], aliases: ["request-review"], desc: "Dispatch a thorough code review subagent against your completed work" },
  { name: "subagent-driven-development", tags: ["subagents", "orchestration", "delegation", "plan-execution", "isolation"], aliases: ["sdd", "subagent-development"], desc: "Execute plans task-by-task through specialized subagents with fresh context and inter-task review" },
  { name: "systematic-debugging", tags: ["bug", "root-cause", "debugging", "repro", "isolation", "failure"], aliases: ["root-cause", "debugging-process"], desc: "Four-phase root-cause process for any bug or test failure BEFORE proposing fixes" },
  { name: "test-driven-development", tags: ["tdd", "red-green", "tests-first", "discipline", "unit-tests"], aliases: ["tdd", "red-green-refactor"], desc: "RED-GREEN-REFACTOR: write the failing test first, then implement, then refactor" },
  { name: "using-git-worktrees", tags: ["worktree", "git", "isolation", "workspace", "parallel-work"], aliases: ["worktrees", "git-worktree"], desc: "Isolate feature work in a git worktree before starting or executing plans" },
  { name: "using-superpowers", tags: ["skills", "meta", "discipline", "process", "skill-routing"], aliases: ["superpowers", "skill-discipline"], desc: "Check for a relevant skill BEFORE any response; process skills before implementation skills" },
  { name: "verification-before-completion", tags: ["verification", "evidence", "completion", "claims", "honesty"], aliases: ["verify-before-done", "evidence-first"], desc: "Run verification commands and confirm output BEFORE claiming any work is done" },
  { name: "writing-skills", tags: ["skill-creation", "authoring", "skill-design", "testing-skills"], aliases: ["create-skill", "skill-authoring"], desc: "Create, edit, and test agent skills with rigorous quality gates" },
  // v113 audit: this listed its own name as an alias — redundant, and it made
  // the "no alias steals a catalog name" invariant unsatisfiable.
  { name: "api-design", tags: ["api", "rest", "openapi", "endpoint", "contract"], aliases: ["http-api"], desc: "Design HTTP APIs with validation, errors, and tests" },
  { name: "data-migration", tags: ["migration", "schema", "etl", "backfill", "database"], aliases: ["migrate-data"], desc: "Plan and verify a data or schema migration with rollback" },
  { name: "code-reviewer", tags: ["review", "pr", "diff", "nits", "security"], aliases: ["reviewer"], desc: "Review a change: correctness, security, blast radius, tests" },
  { name: "experiment-suite", tags: ["experiment", "ablation", "eval", "benchmark"], aliases: ["experiments"], desc: "Design a focused experiment with a discriminating metric" },
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
    // v100: markStaleSkills() WROTE this flag whenever the files a skill was
    // verified against changed, but nothing ever read it back — a stale
    // playbook was offered exactly like a fresh one (§44: never silently use
    // stale knowledge). Carry it through so selection can demote and label it.
    stale: Boolean(s.name && life[s.name]?.stale === true),
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
