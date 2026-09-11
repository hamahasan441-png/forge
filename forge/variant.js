/**
 * forge — strategy variants (v81, zero dependencies)
 *
 * A skill is not a strategy. Identity is
 *   family + strategy + version + content fingerprint.
 * Siblings coexist. A new variant never overwrites ACTIVE/VERIFIED.
 * Always CANDIDATE. Never auto-ACTIVE. Compose never writes.
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { writeStateFile } from "./securefs.js"
import { projectDir } from "./memory.js"
import { TASK_CLASS } from "./classify.js"
import { namedIn, scoreAgainst } from "./evaluate.js"
import {
  SKILL_LIFE, familyName, learnedSkillsDir, formatSkillMd, recordSkillCandidate,
  skillLifecycle, readLearnedSkill,
} from "./evolve.js"
import { validSkillName, skillDescription } from "./skills.js"

export const VARIANT_FILE = "variants.json"
export const MAX_VARIANTS = 48

export function variantPath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), VARIANT_FILE)
}

export function slugStrategy(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
  return s && /^[a-z][a-z0-9-]*$/.test(s) ? s : null
}

export function variantName(family, strategy, version) {
  const fam = familyName(family) || String(family || "").slice(0, 24)
  const strat = slugStrategy(strategy)
  const v = Math.max(1, Number(version) || 1)
  if (!fam || !strat) return null
  return validSkillName(`${fam}--${strat}-v${v}`)
}

export function parseVariantName(name) {
  const n = String(name || "")
  const m = n.match(/^(.+)--([a-z][a-z0-9-]*)-v(\d+)$/)
  if (!m) return null
  return { family: m[1], strategy: m[2], version: Number(m[3]), name: n }
}

export function loadVariants(cwd = process.cwd()) {
  try {
    const j = JSON.parse(fs.readFileSync(variantPath(cwd), "utf8"))
    if (!j || typeof j !== "object") return { v: 1, items: {} }
    if (!j.items || typeof j.items !== "object") j.items = {}
    return j
  } catch {
    return { v: 1, items: {} }
  }
}

function saveVariants(cwd, data) {
  writeStateFile(variantPath(cwd), JSON.stringify(data, null, 1), { mode: 0o600 })
}

function fingerprintOf(md) {
  return crypto.createHash("sha256").update(String(md || "")).digest("hex")
}

export function listVariants(cwd = process.cwd(), family = null) {
  const fam = family ? (familyName(family) || family) : null
  const items = loadVariants(cwd).items || {}
  return Object.values(items).filter((v) => v && (!fam || v.family === fam))
}

export function authorVariant({
  cwd = process.cwd(), family = "", strategy = "", repair = "", files = [], command = "", task = "",
} = {}) {
  const fam = familyName(family) || slugStrategy(family)
  const strat = slugStrategy(strategy)
  if (!fam || !validSkillName(fam)) return { ok: false, error: "invalid family" }
  if (!strat) return { ok: false, error: "invalid strategy" }
  const body = String(repair || "").trim()
  if (!body) return { ok: false, error: "no repair" }
  if (/assumeYes|plugin-host|classifyTaskComplexity/.test(`${task} ${body}`)) {
    return { ok: false, error: "kernel path — refused" }
  }
  const siblings = listVariants(cwd, fam).filter((v) => v.strategy === strat)
  const description = `Strategy ${strat} for ${fam}`
  const bodyFp = fingerprintOf(`${fam}\n${strat}\n${body}`)
  const same = siblings.find((v) => v.bodyFingerprint === bodyFp || v.fingerprint === bodyFp)
  if (same) return { ok: true, reused: true, name: same.name, fingerprint: same.fingerprint, lifecycle: same.lifecycle || SKILL_LIFE.CANDIDATE }

  let version = 1
  for (const s of siblings) version = Math.max(version, Number(s.version) || 1)
  if (siblings.length) version += 1
  const name = variantName(fam, strat, version)
  if (!name) return { ok: false, error: "invalid variant name" }
  const protectedLife = new Set([SKILL_LIFE.ACTIVE, SKILL_LIFE.VERIFIED])
  for (const s of siblings) {
    const life = skillLifecycle(s.name, cwd) || s.lifecycle
    if (protectedLife.has(life) && s.version === version) {
      return { ok: false, error: "would overwrite known-good sibling", name: s.name, lifecycle: life }
    }
  }
  const dir = path.join(learnedSkillsDir(cwd), name)
  const file = path.join(dir, "SKILL.md")
  const mdNamed = formatSkillMd({
    name, description, task: task || `${fam} via ${strat}`, repair: body, files, command,
  }).replace("---\n", `---\nstrategy: ${strat}\nfamily: ${fam}\nversion: ${version}\n`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    writeStateFile(file, mdNamed, { mode: 0o600 })
  } catch (e) {
    return { ok: false, error: e?.message || "write failed" }
  }
  try {
    recordSkillCandidate(cwd, name, { family: fam, version, predecessor: siblings.at(-1)?.name })
  } catch { /* life is best-effort */ }
  const rec = {
    name, family: fam, strategy: strat, version,
    fingerprint: fingerprintOf(mdNamed),
    bodyFingerprint: bodyFp,
    lifecycle: SKILL_LIFE.CANDIDATE,
    path: file,
    samples: 0, ok: 0, failed: 0, rate: 0,
    firstSeen: Date.now(), lastSeen: Date.now(),
  }
  const all = loadVariants(cwd)
  all.items = all.items || {}
  all.items[name] = rec
  const names = Object.keys(all.items)
  if (names.length > MAX_VARIANTS) {
    names.sort((a, b) => (all.items[b].lastSeen ?? 0) - (all.items[a].lastSeen ?? 0))
    for (const k of names.slice(MAX_VARIANTS)) delete all.items[k]
  }
  all.v = 1
  all.updated = Date.now()
  saveVariants(cwd, all)
  return { ok: true, reused: false, name, family: fam, strategy: strat, version, fingerprint: rec.fingerprint, lifecycle: SKILL_LIFE.CANDIDATE, path: file, desc: skillDescription(mdNamed) }
}

/** Copy an existing learned skill into a named strategy variant. Never overwrites ACTIVE. */
export function variantFromSkill(cwd, skillName, strategy) {
  const src = String(skillName || "").trim()
  const md = readLearnedSkill(cwd, src)
  if (!md) return { ok: false, error: `skill "${src}" not learned` }
  const repair = (md.match(/## What worked\n([\s\S]*?)(?:\n## |\nDo not edit|$)/) || [, ""])[1].trim()
  const fam = familyName(src).replace(/--[a-z].*$/, "") || src
  return authorVariant({ cwd, family: fam, strategy, repair: repair || md.slice(0, 400), task: src })
}

export function recordVariantOutcome({ cwd = process.cwd(), name = "", ok = false, durationMs = null } = {}) {
  const id = String(name || "").trim()
  if (!id) return null
  const all = loadVariants(cwd)
  const rec = all.items?.[id]
  if (!rec) return null
  rec.samples = (rec.samples ?? 0) + 1
  if (ok) rec.ok = (rec.ok ?? 0) + 1
  else rec.failed = (rec.failed ?? 0) + 1
  rec.rate = rec.samples ? rec.ok / rec.samples : 0
  if (durationMs != null && Number.isFinite(Number(durationMs))) {
    rec.ms = (rec.ms ?? 0) + Number(durationMs)
  }
  rec.lastSeen = Date.now()
  all.items[id] = rec
  all.updated = Date.now()
  saveVariants(cwd, all)
  return rec
}

export function pickVariant(task = "", { cwd = process.cwd(), klass = null, family = null, limit = 3 } = {}) {
  if (klass === TASK_CLASS.MICRO || klass === TASK_CLASS.SMALL) return []
  const rows = listVariants(cwd, family)
  if (!rows.length) return []
  const scored = []
  for (const rec of rows) {
    if ((rec.samples ?? 0) < 1 && !namedIn(task, rec.strategy) && !namedIn(task, rec.family)) {
      const hit = scoreAgainst(task, rec.strategy, rec.family)
      if (hit < 1) continue
    }
    const hit = (namedIn(task, rec.strategy) ? 2 : 0) + (namedIn(task, rec.family) ? 2 : 0)
      + scoreAgainst(task, rec.strategy, rec.family)
    scored.push({
      name: rec.name, family: rec.family, strategy: rec.strategy, version: rec.version,
      fingerprint: rec.fingerprint, rate: Number(rec.rate ?? 0), samples: rec.samples ?? 0,
      lifecycle: rec.lifecycle, hit,
    })
  }
  scored.sort((a, b) => (b.hit - a.hit) || (b.rate - a.rate) || (b.samples - a.samples) || a.name.localeCompare(b.name))
  return scored.slice(0, Math.max(0, Number(limit) || 3))
}

export function formatVariants(rows) {
  const list = Array.isArray(rows) ? rows.filter((v) => v && v.name) : []
  if (!list.length) return ""
  return `VARIANTS: ${list.map((v) => `${v.family}/${v.strategy}-v${v.version}`).join(", ")} — distinct strategies, do not overwrite`
}
