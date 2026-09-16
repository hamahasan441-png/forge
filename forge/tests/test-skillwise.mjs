#!/usr/bin/env node
/**
 * forge — v94 skillwise: bundle the obra/superpowers engineering-process pack
 * (https://github.com/obra/superpowers, MIT) as first-party skills.
 *
 * 1. Bundled + valid — 13 of 14 upstream skills ship in skills/ (upstream
 *    `writing-plans` is NOT bundled: forge ships its own adapted writing-plans
 *    and the no-overwrite policy wins); the whole 102-skill tree validates
 *    under checkSkills.
 * 2. Byte-identity — the 8 pure-process skills are byte-identical upstream;
 *    the 5 platform-seam skills carry an appended "## Forge execution notes"
 *    section with the upstream content preserved as a byte-identical prefix
 *    (v94b precedent). sha256 pins make accidental drift fail loudly (an
 *    INTENTIONAL pack refresh updates the pins with justification — same
 *    discipline as the strictly-stronger count pins).
 * 3. Routing — all 13 are FIRST_PARTY with tags/aliases, names stay unique,
 *    named skills win, MICRO stays zero-auto-pick, and forge's own
 *    writing-plans was not silently replaced.
 * 4. Attribution — the upstream MIT license ships at skills/ root (outside
 *    the skill dirs, so the imported trees stay pristine).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-skillwise-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_DATA_DIR

const { checkSkills, loadSkill, indexSkills, skillDescription } = await import("../skills.js")
const { FIRST_PARTY, pickSkills, firstPartyNames } = await import("../skillforge.js")
const { TASK_CLASS } = await import("../classify.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILLS = path.join(HERE, "..", "skills")

console.log("== superpowers pack: bundled and valid ==")
const PACK = [
  "brainstorming", "dispatching-parallel-agents", "executing-plans",
  "finishing-a-development-branch", "receiving-code-review", "requesting-code-review",
  "subagent-driven-development", "systematic-debugging", "test-driven-development",
  "using-git-worktrees", "using-superpowers", "verification-before-completion",
  "writing-skills",
]
const NOTES_SKILLS = ["using-superpowers", "dispatching-parallel-agents", "subagent-driven-development", "requesting-code-review", "writing-skills"]
const PURE_SKILLS = PACK.filter((n) => !NOTES_SKILLS.includes(n))
{
  for (const name of PACK) ok(`bundled: ${name}`, fs.existsSync(path.join(SKILLS, name, "SKILL.md")))
  const rep = checkSkills(SKILLS)
  ok("all 106 bundled skills validate", rep.ok === true, JSON.stringify(rep.skills.filter((s) => !s.ok).slice(0, 3)))
  eq("106 bundled skills total", rep.total, 106)
  for (const name of PACK) {
    const s = rep.skills.find((x) => x.name === name)
    ok(`pack skill clean: ${name}`, s && s.ok && s.issues.length === 0, JSON.stringify(s?.issues))
  }
  const idx = indexSkills(SKILLS)
  for (const name of PACK) {
    const e = idx.find((s) => s.name === name)
    ok(`indexed with real description: ${name}`, !!e && e.desc.length > 20)
  }
}

console.log("== superpowers pack: byte-identity manifest ==")
{
  // sha256 (first 16 hex) of each shipped SKILL.md + upstream file count per
  // skill dir. The 5 notes skills hash the shipped artifact (upstream prefix +
  // appended forge execution notes); the 8 pure skills hash upstream as-is.
  const MANIFEST = [
    ["brainstorming", "74edf03ea6d24ef5", 8],
    ["dispatching-parallel-agents", "a6f08fd3331d994f", 1],
    ["executing-plans", "c4c3d8b628c51114", 1],
    ["finishing-a-development-branch", "8db5a922b242dd4e", 1],
    ["receiving-code-review", "091df1629510af1b", 1],
    ["requesting-code-review", "a21160a7bfb42d34", 2],
    ["subagent-driven-development", "e9bb3d63d4cb512b", 7],
    ["systematic-debugging", "808fc5717aa88ad6", 11],
    ["test-driven-development", "bf1b8216e523851a", 2],
    ["using-git-worktrees", "8cfb86f121269e8f", 1],
    ["using-superpowers", "3f8e4802d58d63e5", 6],
    ["verification-before-completion", "2befe7fc55bcadaa", 1],
    ["writing-skills", "2f89f82f136bc8c7", 7],
  ]
  for (const [name, hash, files] of MANIFEST) {
    const buf = fs.readFileSync(path.join(SKILLS, name, "SKILL.md"))
    const got = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16)
    eq(`sha256 pin: ${name}`, got, hash)
    const n = (function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? walk(path.join(d, e.name)) : 1), 0) })(path.join(SKILLS, name))
    eq(`upstream file inventory intact: ${name}`, n, files)
  }
  // notes discipline: notes skills carry the marker, pure skills do NOT.
  // Skills that reference bundled files also resolve them via the
  // [skill dir: ...] header; dispatching-parallel-agents is a single-file
  // playbook (no in-dir files), so only the notes marker applies to it.
  for (const name of NOTES_SKILLS) {
    const md = fs.readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf8")
    ok(`forge execution notes appended: ${name}`, md.includes("## Forge execution notes"))
  }
  for (const name of ["subagent-driven-development", "requesting-code-review", "writing-skills", "using-superpowers"]) {
    const md = fs.readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf8")
    ok(`file seams resolved via [skill dir:]: ${name}`, md.includes("[skill dir:"))
  }
  for (const name of PURE_SKILLS) {
    const md = fs.readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf8")
    ok(`pure upstream (no appended notes): ${name}`, !md.includes("## Forge execution notes"))
  }
  // no-overwrite: forge's own adapted writing-plans must still be the bundled one
  const wp = fs.readFileSync(path.join(SKILLS, "writing-plans", "SKILL.md"), "utf8")
  ok("bundled writing-plans is forge's adaptation (upstream not swapped in)", !wp.includes("docs/superpowers/plans/") && wp.includes("worktree"))
  // attribution ships OUTSIDE the skill dirs so imported trees stay pristine
  const lic = path.join(SKILLS, "superpowers-LICENSE")
  ok("superpowers MIT license shipped at skills root", fs.existsSync(lic) && fs.readFileSync(lic, "utf8").includes("Jesse Vincent"))
}

console.log("== superpowers pack: catalog routing ==")
{
  for (const name of PACK) ok(`FIRST_PARTY entry: ${name}`, FIRST_PARTY.some((s) => s.name === name && s.tags?.length >= 3))
  eq("38 first-party skills (34 + v99 bundled pack)", FIRST_PARTY.length, 38)
  eq("names unique", new Set(firstPartyNames()).size, FIRST_PARTY.length)
  // every pack skill exists on disk AND is catalog-registered (no virtuals)
  for (const name of PACK) {
    const v = FIRST_PARTY.find((s) => s.name === name)
    ok(`registered + on disk: ${name}`, v && fs.existsSync(path.join(SKILLS, name, "SKILL.md")))
  }
  const idx = indexSkills(SKILLS).map((s) => ({ name: s.name, desc: s.desc }))
  // named skill wins (even against the older forge-debug for debugging tasks)
  const named = pickSkills("use systematic-debugging on this failing test", idx, { cwd: HOME, klass: TASK_CLASS.MEDIUM })
  ok("named pack skill wins", named.some((p) => p.name === "systematic-debugging"), JSON.stringify(named.map((p) => p.name)))
  const named2 = pickSkills("apply tdd: write the failing test first", idx, { cwd: HOME, klass: TASK_CLASS.MEDIUM })
  ok("tdd alias routes to test-driven-development", named2.some((p) => p.name === "test-driven-development"), JSON.stringify(named2.map((p) => p.name)))
  // tag routing without explicit naming
  const tag = pickSkills("before writing any code, help me explore requirements and design for this feature", idx, { cwd: HOME, klass: TASK_CLASS.MEDIUM })
  ok("requirements/design task routes to brainstorming", tag.some((p) => p.name === "brainstorming"), JSON.stringify(tag.map((p) => p.name)))
  // MICRO guard still holds: no auto-picks without an explicit name
  const micro = pickSkills("fix the typo", idx, { cwd: HOME, klass: TASK_CLASS.MICRO })
  eq("MICRO stays zero-auto-pick", micro.length, 0)
  // v94b understand routing unbroken
  const arch = pickSkills("map the architecture of this codebase", idx, { cwd: HOME, klass: TASK_CLASS.MEDIUM })
  ok("understand routing unbroken", arch.some((p) => p.name === "understand"), JSON.stringify(arch.map((p) => p.name)))
}

console.log("== superpowers pack: load_skill seam ==")
{
  const md = loadSkill(SKILLS, "systematic-debugging")
  ok("load_skill serves the playbook", typeof md === "string" && md.includes("# ") && !md.includes("... (truncated)"))
  const notes = loadSkill(SKILLS, "using-superpowers")
  ok("load_skill includes appended execution notes", typeof notes === "string" && notes.includes("## Forge execution notes") && notes.includes("delegate") === false)
  ok("notes are at the END (prefix intact)", typeof notes === "string" && notes.indexOf("## Forge execution notes") > notes.indexOf("## The Rule"))
  const big = loadSkill(SKILLS, "subagent-driven-development")
  ok("32KB playbook loads intact under the 64KB ceiling", typeof big === "string" && big.length > 30000 && !big.includes("... (truncated)"), String(big?.length))
  eq("load_skill rejects traversal", loadSkill(SKILLS, "../agent"), null)
  // frontmatter name matches the directory for every pack skill
  for (const name of PACK) {
    const md2 = fs.readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf8")
    const fm = md2.match(/^name:\s*(\S+)\s*$/m)
    ok(`frontmatter name matches dir: ${name}`, fm && fm[1] === name, fm?.[1])
    ok(`description resolvable: ${name}`, skillDescription(md2).length > 20)
  }
}

console.log(`\n== skillwise suite: ${PASS} passed, ${FAIL} failed ==`)
if (FAIL > 0) process.exit(1)
console.log("== skillwise suite: PASSED ==")
