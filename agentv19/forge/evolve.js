/**
 * forge — strategy evolution (v40, zero dependencies)
 *
 * L4: after a run, score the 9-check, hard-avoid failed strategies, and
 * author a SKILL.md playbook from a successful repair. Skills land under
 * ~/.forge/projects/<hash>/skills/ — never the bundled pack, never the
 * kernel. MICRO/SMALL skip authoring. Disk lessons are not deleted.
 *
 * This is self-improvement of playbooks. It is not kernel self-mod.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { classifyTask, TASK_CLASS } from "./classify.js"
import { ALL_CHECKS } from "./completion.js"
import { ineffectiveStrategies, relevantLessons, setLessonConfidence } from "./lessons.js"
import { projectDir } from "./memory.js"
import { validSkillName, indexSkills, loadSkill, skillDescription } from "./skills.js"
import { writeStateFile } from "./securefs.js"
import { redact } from "./secrets.js"

export const RETIRE_BELOW = 0.25
export const HARD_AVOID_MIN = 0.5
export const PROMOTE_DELTA = 0.1

const STOP = new Set([
  "the", "and", "for", "with", "from", "this", "that", "fix", "add", "please",
  "across", "files", "file", "into", "your", "you", "are", "was", "will", "can",
  "not", "but", "all", "any", "how", "what", "why", "who", "its", "our",
])

const KERNEL_HINT = /(?:^|[^A-Za-z0-9])(agentv19[\\/]forge|classifyTaskComplexity|assumeYes|plugin-host|securefs)\b/i
const BUNDLED_SKILLS = path.join(path.dirname(fileURLToPath(import.meta.url)), "skills")

export function isRetired(confidence) {
  return Number(confidence ?? 0) < RETIRE_BELOW
}

export function scoreRun(gate = {}) {
  const checks = gate && typeof gate.checks === "object" && gate.checks ? gate.checks : {}
  let passed = 0
  for (const k of ALL_CHECKS) if (checks[k] === true) passed++
  const total = ALL_CHECKS.length
  const completed = gate.ok === true && String(gate.status || "").toUpperCase() === "COMPLETED"
  return {
    ok: completed,
    passed,
    total,
    ratio: total ? passed / total : 0,
    status: gate.status || "",
    blockers: (gate.blockers || []).map((b) => b.check || b).filter(Boolean).slice(0, 9),
  }
}

/** Strategies we are confident failed — planner must not repeat them. */
export function hardAvoid(query, { cwd = process.cwd(), limit = 6 } = {}) {
  const hits = ineffectiveStrategies(query, { cwd, minConfidence: HARD_AVOID_MIN, limit: Math.max(limit, 8) })
  const out = []
  const seen = new Set()
  for (const l of hits) {
    const s = String(l.failed_strategy || l.failed_action || l.strategy || "").trim()
    if (!s || seen.has(s.toLowerCase())) continue
    seen.add(s.toLowerCase())
    out.push(s)
    if (out.length >= limit) break
  }
  return out
}

export function learnedSkillsDir(cwd = process.cwd()) {
  return path.join(projectDir(cwd), "skills")
}

function underDir(p, root) {
  const a = path.resolve(p)
  const b = path.resolve(root)
  const rel = path.relative(b, a)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

export function indexLearnedSkills(cwd = process.cwd()) {
  try {
    return indexSkills(learnedSkillsDir(cwd)).map((s) => ({ ...s, learned: true }))
  } catch {
    return []
  }
}

export function mergeLearnedSkills(index, cwd = process.cwd()) {
  const base = Array.isArray(index) ? index : []
  const learned = indexLearnedSkills(cwd)
  if (!learned.length) return base
  const have = new Set(base.map((s) => s.name))
  const extra = learned.filter((s) => s?.name && !have.has(s.name))
  return extra.length ? [...base, ...extra] : base
}

export function readLearnedSkill(cwd, name) {
  const n = validSkillName(name)
  if (!n) return null
  try { return loadSkill(learnedSkillsDir(cwd), n) } catch { return null }
}

export function skillSlug(task = "") {
  const toks = String(task || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t)).slice(0, 3)
  const base = `learned-${toks.join("-") || "repair"}`.slice(0, 48)
  return validSkillName(base)
}

export function formatSkillMd({ name, description, task, repair, files = [], command = "" } = {}) {
  const desc = redact(String(description || repair || task || name)).replace(/"/g, "'").slice(0, 200)
  const lines = [
    "---",
    `name: ${name}`,
    `description: "${desc}"`,
    "---",
    `# ${name}`,
    "",
    "## When",
    redact(String(task || "")).slice(0, 400) || "(unspecified)",
    "",
    "## What worked",
    redact(String(repair || "")).slice(0, 800) || "(unspecified)",
  ]
  if ((files || []).length) {
    lines.push("", "## Files")
    for (const f of files.slice(0, 8)) lines.push(`- ${redact(String(f)).slice(0, 160)}`)
  }
  if (command) {
    lines.push("", "## Verify", `Recommended (do not invent a toolchain): \`${redact(String(command)).slice(0, 80)}\``)
  }
  lines.push("", "Do not edit forge kernel files. Do not flip assumeYes.")
  return lines.join("\n") + "\n"
}

function looksLikeKernel(task, repair, files) {
  const blob = `${task || ""} ${repair || ""} ${(files || []).join(" ")}`
  return KERNEL_HINT.test(blob)
}

function resolvedKlass(task, klass) {
  if (klass) return klass
  try { return classifyTask(task || "").class } catch { return TASK_CLASS.MEDIUM }
}

function bumpLesson(id, from, delta, cwd) {
  const next = Math.max(0, Math.min(1, Number(from ?? 0.6) + delta))
  const r = setLessonConfidence(id, next, cwd)
  return { ...r, confidence: next, retired: isRetired(next) }
}

/**
 * Write a project-local SKILL.md from a successful repair.
 * Never writes into the bundled skills pack. MICRO/SMALL skip.
 */
export function authorSkill({
  cwd = process.cwd(), task = "", klass = null, repair = "", files = [], command = "",
} = {}) {
  const k = resolvedKlass(task, klass)
  if (k === TASK_CLASS.MICRO || k === TASK_CLASS.SMALL) return { ok: false, skipped: "micro" }
  const body = String(repair || "").trim()
  if (!body) return { ok: false, skipped: "no-repair" }
  if (looksLikeKernel(task, body, files)) return { ok: false, skipped: "kernel" }
  const name = skillSlug(task)
  if (!name) return { ok: false, skipped: "bad-name" }
  const dir = path.join(learnedSkillsDir(cwd), name)
  if (underDir(dir, BUNDLED_SKILLS)) return { ok: false, skipped: "bundled" }
  const file = path.join(dir, "SKILL.md")
  if (fs.existsSync(file)) return { ok: true, name, path: file, deduped: true }
  const description = `Playbook: ${String(task || name).slice(0, 120)}`
  const md = formatSkillMd({ name, description, task, repair: body, files, command })
  try {
    fs.mkdirSync(dir, { recursive: true })
    writeStateFile(file, md, { mode: 0o600 })
  } catch (e) {
    return { ok: false, skipped: "write", error: String(e?.message || e).slice(0, 120) }
  }
  return { ok: true, name, path: file, deduped: false, desc: skillDescription(md) }
}

/**
 * Score the gate, merge hard-avoid, promote/demote a lesson, maybe author a skill.
 */
export function evolveRun({
  cwd = process.cwd(), task = "", klass = null, gate = null, files = [], command = "",
} = {}) {
  const score = scoreRun(gate || {})
  const avoid = hardAvoid(task, { cwd })
  const k = resolvedKlass(task, klass)
  const out = { score, avoid, skill: { ok: false, skipped: "not-completed" }, promoted: null, retired: false }
  if (k === TASK_CLASS.MICRO || k === TASK_CLASS.SMALL) {
    out.skill = { ok: false, skipped: "micro" }
    return out
  }
  const hits = relevantLessons(task, { cwd, limit: 1 })
  const les = hits[0] || null
  if (!score.ok) {
    if (les?.id) {
      try {
        out.promoted = bumpLesson(les.id, les.confidence, -PROMOTE_DELTA, cwd)
        out.retired = Boolean(out.promoted?.retired)
      } catch { /* lessons are best-effort */ }
    }
    return out
  }
  if (les?.id) {
    try {
      out.promoted = bumpLesson(les.id, les.confidence, PROMOTE_DELTA, cwd)
      out.retired = Boolean(out.promoted?.retired)
    } catch { /* lessons are best-effort */ }
  }
  const repair = String(les?.successful_repair || les?.solution || "").trim()
  out.skill = authorSkill({
    cwd, task, klass: k, repair,
    files: (les?.files?.length ? les.files : files) || [],
    command,
  })
  return out
}

export function formatEvolve(result) {
  if (!result || !result.score) return ""
  const s = result.score
  const bits = [`[evolve] score=${s.passed}/${s.total} ${s.ok ? "COMPLETED" : (s.status || "open")}`]
  if (result.avoid?.length) bits.push(`avoid: ${result.avoid.slice(0, 3).join("; ")}`)
  if (result.skill?.ok && result.skill.name) bits.push(`skill=${result.skill.name}${result.skill.deduped ? " (exists)" : ""}`)
  else if (result.skill?.skipped && result.skill.skipped !== "not-completed" && result.skill.skipped !== "micro") {
    bits.push(`skill skipped (${result.skill.skipped})`)
  }
  return bits.join(" • ")
}
