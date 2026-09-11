/**
 * forge — knowledge-gap engine (v54, zero dependencies)
 *
 * REQUIRED knowledge (task-derived domains)
 *        ↓
 * CURRENT knowledge (memory / world / skills / lessons / prior verified)
 *        ↓
 * GAPS:  UNKNOWN | UNCERTAIN | PROBABLE | KNOWN | SKIPPABLE
 *
 * Compose is read-only: detectGaps() never writes.
 * persistGaps() writes ~/.forge/projects/<hash>/knowgap.json via writeStateFile
 * (aggregates only — no task text, no secrets, 0600). MICRO/SMALL skip unless
 * a domain is named. No model calls. No research. No fake confidence.
 *
 * v55: planAcquire() names the cheapest source (skill → repo → docs → web).
 * Compose never fetches. Web is last and is a search hint, not a page dump.
 *
 * This is not a second memory, graph, or skill system. It ranks what the
 * existing snapshot does not yet cover and stores that ranking in the
 * existing FORGE_HOME project dir.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { writeStateFile } from "./securefs.js"
import { projectDir, projectHash } from "./memory.js"
import { DEFAULT_DIR } from "./config.js"
import { TASK_CLASS } from "./classify.js"
import { namedIn, scoreAgainst } from "./evaluate.js"

export const GAP_FILE = "knowgap.json"
export const GAP_SCHEMA = 1
export const STATUS = {
  KNOWN: "KNOWN",
  PROBABLE: "PROBABLE",
  UNCERTAIN: "UNCERTAIN",
  UNKNOWN: "UNKNOWN",
  SKIPPABLE: "SKIPPABLE",
}
export const IMPACT = {
  CRITICAL: "CRITICAL",
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
}
export const LIFECYCLE = {
  CANDIDATE: "CANDIDATE",
  ACTIVE: "ACTIVE",
  VERIFIED: "VERIFIED",
  STALE: "STALE",
  DEPRECATED: "DEPRECATED",
}

/** Cheapest reliable source first. Compose never executes these. */
export const METHOD = {
  SKILL: "skill",
  REPO: "repo",
  DOCS: "docs",
  WEB: "web",
}

const SKILL_FOR = {
  payment: "forge-api",
  api: "forge-api",
  auth: "forge-security",
  security: "forge-security",
  database: "forge-sql",
  testing: "forge-test",
  deploy: "forge-devops",
  ui: "forge-frontend",
  architecture: "coding-agent",
  types: "coding-agent",
  config: "coding-agent",
  dependency: "coding-agent",
}

const IMPACT_RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 }
const STATUS_RANK = { UNKNOWN: 4, UNCERTAIN: 3, PROBABLE: 2, KNOWN: 1, SKIPPABLE: 0 }
const MAX_DOMAINS = 24
const MAX_GAPS = 4
const MAX_SKIP = 2
const MIN_SCORE = 2

/**
 * Engineering domains. Lexical only — not a model. `implies` expands
 * MEDIUM+ tasks one hop (payment → api/database/security/testing) so a
 * production payment system is not treated as a single keyword.
 */
export const DOMAINS = [
  { id: "payment", impact: "CRITICAL", tags: ["payment", "payments", "stripe", "billing", "checkout", "invoice", "webhook", "webhooks"], implies: ["api", "database", "security", "testing"] },
  { id: "auth", impact: "HIGH", tags: ["auth", "authentication", "login", "oauth", "jwt", "session", "password", "sso"], implies: ["security", "config"] },
  { id: "security", impact: "CRITICAL", tags: ["security", "ssrf", "xss", "csrf", "secret", "secrets", "encrypt", "vulnerability", "vulnerab"], implies: ["config"] },
  { id: "database", impact: "HIGH", tags: ["database", "sql", "migration", "migrations", "schema", "postgres", "sqlite", "mongo", "prisma"], implies: ["testing"] },
  { id: "api", impact: "HIGH", tags: ["api", "apis", "endpoint", "endpoints", "openapi", "rest", "graphql", "route", "routes", "webhook"], implies: ["testing"] },
  { id: "testing", impact: "MEDIUM", tags: ["test", "tests", "testing", "coverage", "regression", "spec", "pytest", "jest", "vitest"] },
  { id: "deploy", impact: "HIGH", tags: ["deploy", "deployment", "ci", "docker", "k8s", "kubernetes", "production", "release"], implies: ["config"] },
  { id: "config", impact: "MEDIUM", tags: ["config", "configs", "environment", "envvar"] },
  { id: "architecture", impact: "HIGH", tags: ["architecture", "architect", "redesign", "subsystem", "module"] },
  { id: "ui", impact: "LOW", tags: ["css", "animation", "stylesheet", "layout", "frontend"] },
  { id: "types", impact: "LOW", tags: ["typescript", "typecheck", "typedef"] },
  { id: "dependency", impact: "MEDIUM", tags: ["dependency", "dependencies", "package", "npm", "cargo", "pip"] },
]

const DOMAIN_BY_ID = new Map(DOMAINS.map((d) => [d.id, d]))

export function domainIds() {
  return DOMAINS.map((d) => d.id)
}

export function emptyGaps() {
  return { required: [], known: [], gaps: [], skip: [], learn: [] }
}

function isMicro(klass) {
  return klass === TASK_CLASS.MICRO || klass === TASK_CLASS.SMALL
}

function dropImpact(impact) {
  if (impact === IMPACT.CRITICAL) return IMPACT.HIGH
  if (impact === IMPACT.HIGH) return IMPACT.MEDIUM
  if (impact === IMPACT.MEDIUM) return IMPACT.LOW
  return IMPACT.LOW
}

function betterImpact(a, b) {
  return (IMPACT_RANK[a] || 0) >= (IMPACT_RANK[b] || 0) ? a : b
}

function domainNamed(task, d) {
  if (namedIn(task, d.id)) return true
  for (const t of d.tags || []) {
    if (namedIn(task, t)) return true
  }
  return false
}

function domainScore(task, d) {
  const desc = (d.tags || []).join(" ")
  return scoreAgainst(task, d.id, desc)
}

/**
 * Domains this task actually requires. MICRO/SMALL: named only.
 * MEDIUM+: lexical hit, plus one-hop implies.
 */
export function requiredDomains(task = "", { klass = null } = {}) {
  const q = String(task || "").trim()
  if (!q) return []
  const micro = isMicro(klass)
  const hits = new Map()
  for (const d of DOMAINS) {
    const named = domainNamed(q, d)
    if (micro && !named) continue
    const score = named ? 10 : domainScore(q, d)
    if (!named && score < MIN_SCORE) continue
    hits.set(d.id, {
      id: d.id,
      impact: d.impact,
      why: named ? "named" : "lexical",
      score,
      implied: false,
    })
  }
  if (!micro) {
    for (const hit of [...hits.values()]) {
      const src = DOMAIN_BY_ID.get(hit.id)
      for (const id of src?.implies || []) {
        if (hits.has(id)) {
          const cur = hits.get(id)
          cur.impact = betterImpact(cur.impact, dropImpact(src.impact))
          continue
        }
        const d = DOMAIN_BY_ID.get(id)
        if (!d) continue
        hits.set(id, {
          id,
          impact: dropImpact(src.impact),
          why: `implied by ${hit.id}`,
          score: 1,
          implied: true,
        })
      }
    }
  }
  return [...hits.values()].sort((a, b) =>
    (IMPACT_RANK[b.impact] || 0) - (IMPACT_RANK[a.impact] || 0)
    || a.id.localeCompare(b.id))
}

function bestQuery(domain) {
  const d = DOMAIN_BY_ID.get(domain.id) || domain
  const tags = d.tags || [d.id]
  return tags.find((t) => t.length >= 4 && t !== d.id) || d.id
}

function skillIn(opts, name) {
  if (!name) return null
  for (const s of opts.skills || []) {
    if (s && s.name === name) return s
  }
  return null
}

/**
 * Cheapest acquisition method for one blocking gap.
 * Never fetches. Never dumps a page. Skill (already ranked into the
 * snapshot) beats repo grep, which beats glob, which beats web_search.
 */
export function planAcquire(gap, opts = {}) {
  if (!gap || !gap.id || gap.learn === false) return null
  if (gap.status === STATUS.KNOWN || gap.status === STATUS.SKIPPABLE) return null
  const q = bestQuery(gap)
  const files = (opts.world?.files || []).map((f) => String(f || "")).filter(Boolean).slice(0, 2)
  const skillName = SKILL_FOR[gap.id]
  const skill = skillIn(opts, skillName)
  if (skill) {
    const next = files.length
      ? { method: METHOD.REPO, tool: "grep_files", query: q }
      : { method: METHOD.REPO, tool: "glob_files", query: `*${gap.id}*` }
    return {
      id: gap.id,
      method: METHOD.SKILL,
      tool: "load_skill",
      query: skill.name,
      cost: 1,
      then: next,
      why: "existing skill is cheaper than research",
    }
  }
  if (files.length) {
    return {
      id: gap.id,
      method: METHOD.REPO,
      tool: "grep_files",
      query: q,
      cost: 1,
      files,
      why: "repository evidence before the web",
    }
  }
  const docs = (opts.world?.radius || []).filter((f) => /readme|docs?\//i.test(String(f || "")))
  if (docs.length) {
    return {
      id: gap.id,
      method: METHOD.DOCS,
      tool: "read_file",
      query: String(docs[0]).slice(0, 80),
      cost: 2,
      why: "local docs before the web",
    }
  }
  return {
    id: gap.id,
    method: METHOD.WEB,
    tool: "web_search",
    query: `${gap.id} official documentation`,
    cost: 4,
    why: "no local skill or files — search, do not dump the page",
  }
}

function blobOf(opts) {
  const parts = []
  if (opts.memory) parts.push(String(opts.memory))
  for (const s of opts.skills || []) {
    if (s && s.name) parts.push(s.name, s.desc || s.repair || "")
  }
  for (const k of opts.know || []) {
    if (k && k.name) parts.push(k.name, k.repair || "")
  }
  for (const p of opts.playbooks || []) {
    if (p && p.name) parts.push(p.name)
  }
  const world = opts.world || {}
  for (const f of world.files || []) parts.push(f)
  for (const f of world.radius || []) parts.push(f)
  for (const l of world.langs || []) parts.push(l)
  return parts.join("\n").toLowerCase()
}

function evidenceFor(domain, blob, prior) {
  const d = DOMAIN_BY_ID.get(domain.id) || domain
  const tags = [d.id, ...(d.tags || [])]
  const hits = []
  if (prior && prior.lifecycle === LIFECYCLE.VERIFIED) {
    return { status: STATUS.KNOWN, confidence: 0.9, evidence: "verified", provenance: "experimentally-verified" }
  }
  if (prior && prior.lifecycle === LIFECYCLE.STALE) {
    return { status: STATUS.UNCERTAIN, confidence: 0.3, evidence: "stale", provenance: "system-generated" }
  }
  const mem = blob || ""
  for (const t of tags) {
    if (t.length < 3) continue
    if (mem.includes(t)) hits.push(t)
  }
  if (!hits.length) {
    return { status: STATUS.UNKNOWN, confidence: 0, evidence: "none", provenance: "system-generated" }
  }
  const unique = [...new Set(hits)].slice(0, 3)
  // A filename or skill name is probable, not verified fact.
  if (unique.length >= 2) {
    return { status: STATUS.PROBABLE, confidence: 0.55, evidence: unique.join(","), provenance: "repository-derived" }
  }
  return { status: STATUS.PROBABLE, confidence: 0.4, evidence: unique[0], provenance: "repository-derived" }
}

function taskKey(task) {
  const s = String(task || "").trim()
  if (!s) return ""
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 12)
}

export function gapStatsPath(cwd) {
  return path.join(projectDir(cwd || process.cwd()), GAP_FILE)
}

export function loadGapStats(cwd) {
  try {
    const j = JSON.parse(fs.readFileSync(gapStatsPath(cwd), "utf8"))
    if (!j || typeof j !== "object" || Array.isArray(j)) return { v: GAP_SCHEMA, domains: {} }
    const domains = j.domains && typeof j.domains === "object" && !Array.isArray(j.domains) ? j.domains : {}
    return { v: GAP_SCHEMA, domains, updated: j.updated ?? null }
  } catch {
    return { v: GAP_SCHEMA, domains: {} }
  }
}

function saveGapStats(cwd, data) {
  try {
    writeStateFile(gapStatsPath(cwd), JSON.stringify(data, null, 1))
    return true
  } catch {
    return false
  }
}

export function clearGapStats(cwd) {
  try { fs.rmSync(gapStatsPath(cwd), { force: true }); return true } catch { return false }
}

/**
 * Compare required domains against what this snapshot already knows.
 * Never writes. Never claims VERIFIED from lexical evidence.
 */
export function detectGaps(task = "", opts = {}) {
  const empty = emptyGaps()
  const q = String(task || "").trim()
  if (!q) return empty
  const klass = opts.klass || null
  const required = requiredDomains(q, { klass })
  if (!required.length) return empty
  const blob = blobOf(opts)
  const prior = opts.cwd ? loadGapStats(opts.cwd).domains : {}
  const known = []
  const gaps = []
  const skip = []
  for (const req of required) {
    const ev = evidenceFor(req, blob, prior[req.id])
    const row = {
      id: req.id,
      impact: req.impact,
      status: ev.status,
      confidence: ev.confidence,
      evidence: ev.evidence,
      provenance: ev.provenance,
      why: req.why,
    }
    const low = req.impact === IMPACT.LOW
    if (low && ev.status !== STATUS.KNOWN) {
      skip.push({ ...row, status: STATUS.SKIPPABLE, learn: false })
      continue
    }
    if (ev.status === STATUS.KNOWN) {
      known.push(row)
      continue
    }
    if (ev.status === STATUS.PROBABLE) {
      known.push(row)
      continue
    }
    const blocking = req.impact === IMPACT.CRITICAL || req.impact === IMPACT.HIGH
    const rowOut = {
      ...row,
      learn: blocking && ev.status === STATUS.UNKNOWN,
    }
    if (rowOut.learn) {
      const plan = planAcquire(rowOut, opts)
      if (plan) rowOut.acquire = plan
    }
    gaps.push(rowOut)
  }
  const rank = (a, b) =>
    (IMPACT_RANK[b.impact] || 0) - (IMPACT_RANK[a.impact] || 0)
    || (STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0)
    || a.id.localeCompare(b.id)
  const rankedGaps = gaps.sort(rank).slice(0, MAX_GAPS)
  const out = {
    required,
    known: known.sort(rank).slice(0, 6),
    gaps: rankedGaps,
    skip: skip.sort(rank).slice(0, MAX_SKIP),
    learn: rankedGaps.map((g) => g.acquire).filter(Boolean).slice(0, 3),
  }
  if (opts.persist && opts.cwd) persistGaps(opts.cwd, out, { task: q })
  return out
}

/**
 * Merge an assessment into ~/.forge/projects/<hash>/knowgap.json.
 * Aggregates only. Task text is hashed, never stored.
 */
export function persistGaps(cwd, assessment, { task = "" } = {}) {
  if (!cwd || !assessment) return null
  const gaps = assessment.gaps || []
  const known = assessment.known || []
  const skip = assessment.skip || []
  const rows = [...gaps, ...known, ...skip]
  if (!rows.length) return loadGapStats(cwd)
  const all = loadGapStats(cwd)
  const domains = all.domains || (all.domains = {})
  const hash = taskKey(task)
  const now = Date.now()
  for (const row of rows) {
    const id = String(row?.id || "")
    if (!id || !DOMAIN_BY_ID.has(id)) continue
    const rec = domains[id] && typeof domains[id] === "object" ? domains[id] : {
      id, samples: 0, firstSeen: now, lifecycle: LIFECYCLE.CANDIDATE,
    }
    rec.id = id
    rec.impact = row.impact || rec.impact || IMPACT.MEDIUM
    rec.samples = (rec.samples ?? 0) + 1
    rec.lastSeen = now
    rec.lastTask = hash || rec.lastTask || ""
    rec.evidence = String(row.evidence || rec.evidence || "none").slice(0, 80)
    rec.provenance = String(row.provenance || rec.provenance || "system-generated").slice(0, 40)
    rec.confidence = Number(row.confidence ?? rec.confidence ?? 0)
    if (row.acquire && row.acquire.method) {
      rec.acquire = {
        method: String(row.acquire.method).slice(0, 16),
        tool: String(row.acquire.tool || "").slice(0, 24),
        cost: Number(row.acquire.cost ?? 0) || 0,
      }
    }
    if (rec.lifecycle === LIFECYCLE.VERIFIED) {
      rec.status = STATUS.KNOWN
    } else if (rec.lifecycle === LIFECYCLE.DEPRECATED || rec.lifecycle === LIFECYCLE.STALE) {
      rec.status = row.status || rec.status
    } else {
      rec.status = row.status || rec.status || STATUS.UNKNOWN
      rec.lifecycle = rec.lifecycle === LIFECYCLE.CANDIDATE && rec.samples > 1
        ? LIFECYCLE.ACTIVE
        : (rec.lifecycle || LIFECYCLE.CANDIDATE)
    }
    domains[id] = rec
  }
  const names = Object.keys(domains)
  if (names.length > MAX_DOMAINS) {
    names.sort((a, b) => (domains[b].lastSeen ?? 0) - (domains[a].lastSeen ?? 0))
    for (const k of names.slice(MAX_DOMAINS)) delete domains[k]
  }
  all.v = GAP_SCHEMA
  all.updated = now
  all.domains = domains
  saveGapStats(cwd, all)
  return all
}

/**
 * Mark a domain VERIFIED or STALE after real evidence (test, experiment).
 * Never infers verification from a model guess.
 */
export function recordGapOutcome({ cwd, id, status = LIFECYCLE.VERIFIED, evidence = "" } = {}) {
  if (!cwd || !id || !DOMAIN_BY_ID.has(id)) return null
  const life = LIFECYCLE[status] || (status === STATUS.KNOWN ? LIFECYCLE.VERIFIED : status)
  const all = loadGapStats(cwd)
  const domains = all.domains || (all.domains = {})
  const rec = domains[id] && typeof domains[id] === "object" ? domains[id] : {
    id, samples: 0, firstSeen: Date.now(), impact: DOMAIN_BY_ID.get(id).impact,
  }
  rec.id = id
  rec.lifecycle = life
  rec.status = life === LIFECYCLE.VERIFIED ? STATUS.KNOWN
    : life === LIFECYCLE.STALE ? STATUS.UNCERTAIN
    : rec.status || STATUS.UNKNOWN
  rec.confidence = life === LIFECYCLE.VERIFIED ? 0.9 : rec.confidence || 0.3
  rec.evidence = String(evidence || rec.evidence || "outcome").slice(0, 80)
  rec.provenance = life === LIFECYCLE.VERIFIED ? "experimentally-verified" : "system-generated"
  rec.lastSeen = Date.now()
  rec.samples = (rec.samples ?? 0) + 1
  domains[id] = rec
  all.v = GAP_SCHEMA
  all.updated = Date.now()
  all.domains = domains
  saveGapStats(cwd, all)
  return all
}

export function formatGaps(g) {
  if (!g) return ""
  const lines = []
  const gaps = (g.gaps || []).filter((x) => x && x.id)
  if (gaps.length) {
    lines.push(`[gaps] ${gaps.slice(0, MAX_GAPS).map((x) => `${x.id}:${x.impact} ${String(x.status || "").toLowerCase()}`).join("; ")}`)
  }
  const skip = (g.skip || []).filter((x) => x && x.id)
  if (skip.length) {
    lines.push(`[skip] ${skip.slice(0, MAX_SKIP).map((x) => x.id).join(", ")}`)
  }
  const learn = (g.learn || []).filter((x) => x && x.id && x.tool)
  if (learn.length) {
    lines.push(`[learn] ${learn.slice(0, 3).map((x) => {
      let s = `${x.id}: ${x.tool} ${String(x.query || "").slice(0, 40)} (${x.method})`
      if (x.then && x.then.tool) s += ` then ${x.then.tool}`
      return s
    }).join("; ")}`)
  }
  return lines.join("\n")
}

export function formatGapSteer(g) {
  if (!g) return ""
  const lines = []
  const gaps = (g.gaps || []).filter((x) => x && x.id)
  if (gaps.length) {
    const body = gaps.slice(0, MAX_GAPS).map((x) => {
      let s = `${x.id} (${x.impact}, ${String(x.status || "").toLowerCase()}`
      if (x.learn) s += " — research+verify before implementation"
      return s + ")"
    }).join("; ")
    lines.push(`GAPS: ${body}`)
  }
  const skip = (g.skip || []).filter((x) => x && x.id)
  if (skip.length) {
    lines.push(`SKIP: ${skip.slice(0, MAX_SKIP).map((x) => `${x.id} (low impact)`).join(", ")}`)
  }
  const learn = (g.learn || []).filter((x) => x && x.id && x.tool)
  if (learn.length) {
    lines.push(`LEARN: ${learn.slice(0, 3).map((x) => {
      let s = `${x.id} via ${x.tool} "${String(x.query || "").slice(0, 40)}" (${x.method}`
      if (x.then && x.then.tool) s += ` then ${x.then.tool}`
      return s + ")"
    }).join("; ")} — cheapest source, do not dump pages`)
  }
  return lines.join("\n")
}

function listStateFiles(dir, names) {
  const out = []
  for (const name of names) {
    const p = path.join(dir, name)
    try {
      const st = fs.statSync(p)
      if (!st.isFile()) continue
      out.push({ name, bytes: st.size, mtime: st.mtimeMs })
    } catch { /* absent */ }
  }
  return out
}

/**
 * Inspectable view of the Forge-owned data root. Does not invent a second
 * store. Does not walk the user project.
 */
export function dataStatus(cwd = process.cwd()) {
  const root = DEFAULT_DIR
  const via = process.env.FORGE_HOME ? "FORGE_HOME" : "default"
  const hash = projectHash(cwd)
  const pdir = projectDir(cwd)
  const rootFiles = listStateFiles(root, [
    "config.json", "memory.md", "health.json", "models-cache.json", "history",
  ])
  const projectFiles = listStateFiles(pdir, [
    "memory.md", "profile.json", "toolstats.json", "knowgap.json",
  ])
  let sessions = 0, checkpoints = 0
  try { sessions = fs.readdirSync(path.join(root, "sessions")).length } catch {}
  try { checkpoints = fs.readdirSync(path.join(root, "checkpoints")).length } catch {}
  const gaps = loadGapStats(cwd)
  const domainCount = Object.keys(gaps.domains || {}).length
  return {
    root,
    via,
    project: hash,
    projectDir: pdir,
    sessions,
    checkpoints,
    rootFiles,
    projectFiles,
    gaps: domainCount,
  }
}

export function formatDataStatus(s) {
  if (!s) return ""
  const lines = [
    `forge data  root ${s.root}  (${s.via})`,
    `project     ${s.project}  ${s.projectDir}`,
    `sessions    ${s.sessions}   checkpoints ${s.checkpoints}   gap-domains ${s.gaps}`,
  ]
  const files = [...(s.rootFiles || []).map((f) => `root/${f.name}`), ...(s.projectFiles || []).map((f) => `project/${f.name}`)]
  if (files.length) lines.push(`files       ${files.join(", ")}`)
  return lines.join("\n")
}