/**
 * forge — native skill download (v62, zero dependencies)
 *
 * DOWNLOAD ≠ TRUST. User-supplied HTTPS URL only. Artifact lands under
 * FORGE_HOME/skill-downloads/ (FORGE_DATA_DIR alias). Status is always
 * CANDIDATE. Never ACTIVE, never VERIFIED, never ~/.forge/tools, never
 * the user project. pinnedFetch / netguard — no private, no file:, no
 * HTML dump. Duplicate sha256 reuses the existing record and will not
 * overwrite a VERIFIED copy.
 *
 * Verify / learn / rollback are later TODO items.
 *
 * v63: tool download (`FORGE_HOME/tool-downloads`) and structural verify.
 * VERIFY ≠ DOWNLOAD. Failed verify is INACTIVE; siblings stay independent.
 * v67: ## Tests run through shellguard (block/danger/confirm refused).
 * No ## Tests → structural VERIFIED + evidence.json. Fail → INACTIVE.
 * Never ACTIVE. Compose never fetches. Never ~/.forge/tools.
 *
 * v68: VERIFIED past FORGE_SKILL_TTL_MS (default 30d) → STALE, not
 * CONTRADICTED. Re-verify restores VERIFIED. STALE is hidden from pick.
 *
 * v69: STALE + N failed re-verifies (FORGE_SKILL_FAIL_LIMIT, default 2)
 * → CONTRADICTED. CANDIDATE/VERIFIED fail is still INACTIVE. Hidden from
 * pick. Success restores VERIFIED and clears failCount. Never ACTIVE.
 *
 * v70: per-skill `ttlMs` on the download record overrides FORGE_SKILL_TTL_MS.
 * Missing/invalid ttlMs still uses the env default. Never ACTIVE.
 *
 * v71: VERIFIED body sha mismatch vs last verifiedSha → DRIFT (not STALE,
 * not CONTRADICTED). Hidden from pick. Re-verify restores. Never ACTIVE.
 *
 * v72: learnSkill upserts a project claim (FORGE_HOME/projects/<hash>/claims.json).
 * Not a second memory. Compose never writes claims.
 */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import { resolveDataDir } from "./config.js"
import { pinnedFetch, PinnedFetchError } from "./netguard.js"
import { writeStateFile } from "./securefs.js"
import { validSkillName, skillDescription, parseSkillPlaybook } from "./skills.js"
import { SKILL_LIFE } from "./evolve.js"
import { classifyCommand } from "./shellguard.js"
import { recordClaim } from "./claims.js"

export const SKILL_DOWNLOADS = "skill-downloads"
export const TOOL_DOWNLOADS = "tool-downloads"
export const MANIFEST_FILE = "manifest.json"
export const LIFE_FILE = "skilllife.json"
export const KNOWLEDGE_FILE = "knowledge.json"
export const EVIDENCE_FILE = "evidence.json"
export const TEST_TIMEOUT_MS = 8000
export const MAX_TEST_COMMANDS = 4
export const DOWNLOAD_STATUS = Object.freeze({
  DOWNLOADED: "DOWNLOADED",
  FAILED: "FAILED",
})
export const MAX_SKILL_BYTES = 8 * 1024 * 1024
export const INACTIVE = "INACTIVE"
export const STALE = "STALE"
export const CONTRADICTED = "CONTRADICTED"
export const DRIFT = "DRIFT"
export const DEFAULT_SKILL_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const DEFAULT_STALE_FAILS = 2
export const MAX_SKILL_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000

export function skillTtlMs(env = process.env) {
  const n = Number(env?.FORGE_SKILL_TTL_MS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SKILL_TTL_MS
}

/** Per-record override, else env/default. Invalid ttlMs is ignored. */
export function skillTtlFor(rec, env = process.env) {
  const n = Number(rec?.ttlMs)
  if (Number.isFinite(n) && n > 0 && n <= MAX_SKILL_TTL_MS) return Math.floor(n)
  return skillTtlMs(env)
}

export function skillFailLimit(env = process.env) {
  const n = Number(env?.FORGE_SKILL_FAIL_LIMIT)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_STALE_FAILS
}

const KERNEL_HINT = /(?:^|[^A-Za-z0-9])(agentv19[\\/]forge|classifyTaskComplexity|assumeYes|plugin-host|securefs)\b/i
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,40}$/
const TOOL_FORBIDDEN = new Set([
  "bash", "write_file", "edit_file", "multi_edit", "apply_patch", "read_file",
  "glob_files", "grep_files", "delegate", "think", "todo", "memory",
  "fetch_url", "web_search", "load_skill", "read_image", "list_dir", "git_status",
])
const TOOL_DENY = /\b(child_process|worker_threads|plugin-host|process\.binding|Function\s*\(|\beval\s*\()/

export function skillDownloadsDir(env = process.env) {
  return path.join(resolveDataDir(env), SKILL_DOWNLOADS)
}

export function toolDownloadsDir(env = process.env) {
  return path.join(resolveDataDir(env), TOOL_DOWNLOADS)
}

function rootFor(kind, env) {
  return kind === "tool" ? toolDownloadsDir(env) : skillDownloadsDir(env)
}

export function downloadManifestPath(env = process.env, kind = "skill") {
  return path.join(rootFor(kind, env), MANIFEST_FILE)
}

export function downloadLifePath(env = process.env, kind = "skill") {
  return path.join(rootFor(kind, env), LIFE_FILE)
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

export function loadDownloadManifest(env = process.env, kind = "skill") {
  try {
    const j = JSON.parse(fs.readFileSync(downloadManifestPath(env, kind), "utf8"))
    if (!j || typeof j !== "object") return { v: 1, items: {} }
    if (!j.items || typeof j.items !== "object") j.items = {}
    return j
  } catch {
    return { v: 1, items: {} }
  }
}

function saveManifest(data, env, kind = "skill") {
  const file = downloadManifestPath(env, kind)
  ensureDir(path.dirname(file))
  writeStateFile(file, JSON.stringify(data, null, 1), { mode: 0o600 })
}

export function loadDownloadLife(env = process.env, kind = "skill") {
  try {
    const j = JSON.parse(fs.readFileSync(downloadLifePath(env, kind), "utf8"))
    if (!j || typeof j !== "object") return { v: 1, skills: {}, tools: {} }
    if (!j.skills || typeof j.skills !== "object") j.skills = {}
    if (!j.tools || typeof j.tools !== "object") j.tools = {}
    return j
  } catch {
    return { v: 1, skills: {}, tools: {} }
  }
}

function saveLife(data, env, kind = "skill") {
  const file = downloadLifePath(env, kind)
  ensureDir(path.dirname(file))
  writeStateFile(file, JSON.stringify(data, null, 1), { mode: 0o600 })
}

function lifeBucket(kind) {
  return kind === "tool" ? "tools" : "skills"
}

function recordCandidate(name, env, kind = "skill") {
  if (!name) return null
  const all = loadDownloadLife(env, kind)
  const key = lifeBucket(kind)
  const bucket = all[key] || (all[key] = {})
  const rec = bucket[name] && typeof bucket[name] === "object" ? bucket[name] : {
    name, lifecycle: SKILL_LIFE.CANDIDATE, samples: 0, firstSeen: Date.now(),
  }
  rec.name = name
  rec.samples = (rec.samples ?? 0) + 1
  rec.lastSeen = Date.now()
  if (rec.lifecycle !== SKILL_LIFE.VERIFIED && rec.lifecycle !== SKILL_LIFE.ACTIVE) {
    rec.lifecycle = SKILL_LIFE.CANDIDATE
  }
  bucket[name] = rec
  all.v = 1
  all.updated = Date.now()
  all[key] = bucket
  saveLife(all, env, kind)
  return rec
}

function setLifecycle(name, lifecycle, env, kind = "skill", extra = {}) {
  const all = loadDownloadLife(env, kind)
  const key = lifeBucket(kind)
  const bucket = all[key] || (all[key] = {})
  const rec = bucket[name] && typeof bucket[name] === "object" ? bucket[name] : {
    name, lifecycle: SKILL_LIFE.CANDIDATE, samples: 0, firstSeen: Date.now(),
  }
  rec.name = name
  rec.lifecycle = lifecycle
  rec.lastSeen = Date.now()
  rec.samples = rec.samples || 1
  if (lifecycle === SKILL_LIFE.VERIFIED) {
    rec.verifiedAt = Date.now()
    rec.failCount = 0
    const sha = bodySha(name, kind, env)
    if (sha) rec.verifiedSha = sha
  }
  if (extra.failCount != null) rec.failCount = extra.failCount
  bucket[name] = rec
  all.v = 1
  all.updated = Date.now()
  all[key] = bucket
  saveLife(all, env, kind)
  const man = loadDownloadManifest(env, kind)
  if (man.items?.[name]) {
    man.items[name].lifecycle = lifecycle
    if (lifecycle === SKILL_LIFE.VERIFIED) {
      man.items[name].verifiedAt = rec.verifiedAt
      man.items[name].failCount = 0
      if (rec.verifiedSha) man.items[name].verifiedSha = rec.verifiedSha
    }
    if (extra.failCount != null) man.items[name].failCount = extra.failCount
    man.updated = Date.now()
    saveManifest(man, env, kind)
    const meta = path.join(rootFor(kind, env), name, "meta.json")
    try { writeStateFile(meta, JSON.stringify(man.items[name], null, 1), { mode: 0o600 }) } catch { /* meta is best-effort */ }
  }
  return rec
}

/** CANDIDATE/VERIFIED fail → INACTIVE. STALE fail N times → CONTRADICTED. */
function recordVerifyFail(name, env, kind = "skill") {
  const man = loadDownloadManifest(env, kind)
  const rec = man.items?.[name] || {}
  const n = (Number(rec.failCount) || 0) + 1
  const prev = rec.lifecycle
  const next = (prev === STALE || prev === CONTRADICTED)
    ? (n >= skillFailLimit(env) ? CONTRADICTED : STALE)
    : INACTIVE
  setLifecycle(name, next, env, kind, { failCount: n })
  return next
}

/**
 * VERIFIED past TTL → STALE (not CONTRADICTED, not INACTIVE).
 * Missing verifiedAt is stamped now (TTL starts; no instant demote).
 */
export function sweepStale(env = process.env, kind = "skill") {
  const man = loadDownloadManifest(env, kind)
  const now = Date.now()
  const demoted = []
  for (const [id, rec] of Object.entries(man.items || {})) {
    if (!rec || rec.lifecycle !== SKILL_LIFE.VERIFIED) continue
    const at = Number(rec.verifiedAt) || 0
    if (!at) {
      rec.verifiedAt = now
      man.items[id] = rec
      man.updated = now
      saveManifest(man, env, kind)
      continue
    }
    if (now - at <= skillTtlFor(rec, env)) continue
    setLifecycle(id, STALE, env, kind)
    demoted.push(id)
  }
  return demoted
}

function bodyPath(id, kind, env) {
  return kind === "tool"
    ? path.join(toolDownloadsDir(env), id, `${id}.mjs`)
    : skillMdPath(id, env)
}

function bodySha(id, kind, env) {
  try { return sha256(fs.readFileSync(bodyPath(id, kind, env))) } catch { return "" }
}

/**
 * VERIFIED body no longer matches verifiedSha → DRIFT (not STALE).
 * Missing verifiedSha is stamped now — no instant demote.
 */
export function sweepDrift(env = process.env, kind = "skill") {
  const man = loadDownloadManifest(env, kind)
  const demoted = []
  for (const [id, rec] of Object.entries(man.items || {})) {
    if (!rec || rec.lifecycle !== SKILL_LIFE.VERIFIED) continue
    const now = bodySha(id, kind, env)
    const was = String(rec.verifiedSha || "")
    if (!was) {
      if (now) {
        rec.verifiedSha = now
        man.items[id] = rec
        man.updated = Date.now()
        saveManifest(man, env, kind)
      }
      continue
    }
    if (now && now === was) continue
    setLifecycle(id, DRIFT, env, kind)
    demoted.push(id)
  }
  return demoted
}

export function setSkillTtl(name, ttlMs, { env = process.env, kind = "skill" } = {}) {
  const id = String(name || "").trim()
  const man = loadDownloadManifest(env, kind)
  const rec = man.items?.[id]
  if (!rec) return { ok: false, error: `${kind} "${id}" not downloaded`, name: id }
  const n = Number(ttlMs)
  if (!Number.isFinite(n) || n <= 0 || n > MAX_SKILL_TTL_MS) {
    return { ok: false, error: `ttlMs must be 1..${MAX_SKILL_TTL_MS}`, name: id, ttlMs: rec.ttlMs || null, effective: skillTtlFor(rec, env) }
  }
  rec.ttlMs = Math.floor(n)
  man.items[id] = rec
  man.updated = Date.now()
  saveManifest(man, env, kind)
  const meta = path.join(rootFor(kind, env), id, "meta.json")
  try { writeStateFile(meta, JSON.stringify(rec, null, 1), { mode: 0o600 }) } catch { /* meta is best-effort */ }
  sweepStale(env, kind)
  const after = loadDownloadManifest(env, kind).items?.[id] || rec
  return { ok: true, name: id, ttlMs: after.ttlMs, effective: skillTtlFor(after, env), lifecycle: after.lifecycle }
}

export function getSkillTtl(name, { env = process.env, kind = "skill" } = {}) {
  const id = String(name || "").trim()
  const rec = loadDownloadManifest(env, kind).items?.[id]
  if (!rec) return { ok: false, error: `${kind} "${id}" not downloaded`, name: id }
  return { ok: true, name: id, ttlMs: rec.ttlMs || null, effective: skillTtlFor(rec, env), lifecycle: rec.lifecycle }
}

export function formatTtlReport(r) {
  if (!r?.ok) return `TTL FAILED\n\n${r?.error || "unknown"}\n`
  const set = r.ttlMs != null ? `${r.ttlMs} ms` : "default"
  return `ttl ${r.name}: ${set} (effective ${r.effective} ms)${r.lifecycle ? `  ${r.lifecycle}` : ""}\n`
}

export function listDownloads(env = process.env, kind = "skill") {
  sweepDrift(env, kind)
  sweepStale(env, kind)
  const items = Object.values(loadDownloadManifest(env, kind).items || {})
  return items.sort((a, b) => (b.downloadedAt || "").localeCompare(a.downloadedAt || ""))
}

export function listToolDownloads(env = process.env) {
  return listDownloads(env, "tool")
}

export function validateDownloadUrl(raw) {
  const s = String(raw ?? "").trim()
  if (!s) return { ok: false, error: "missing URL" }
  let u
  try { u = new URL(s) } catch { return { ok: false, error: "invalid URL" } }
  if (u.protocol !== "https:") return { ok: false, error: "HTTPS only" }
  if (u.username || u.password) return { ok: false, error: "URL must not contain credentials" }
  const host = String(u.hostname || "").toLowerCase()
  if (!host || host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]") {
    return { ok: false, error: "refused host" }
  }
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|255\.)/.test(host)) {
    return { ok: false, error: "refused private host" }
  }
  if (host === "metadata" || host === "metadata.google.internal" || host === "instance-data") {
    return { ok: false, error: "refused metadata host" }
  }
  return { ok: true, url: u.href, host }
}

export function safeFilename(raw, fallback = "skill.bin") {
  let n = path.basename(String(raw || "").split("?")[0] || "")
  n = n.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^\.+/, "").replace(/-+/g, "-")
  if (!n || n === "." || n === ".." || /^(meta|manifest|skilllife)\.json$/i.test(n)) n = fallback
  if (n.length > 80) {
    const ext = path.extname(n).slice(0, 12)
    n = n.slice(0, 80 - ext.length) + ext
  }
  return n
}

function slugName(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
  return validSkillName(s) || null
}

function nameFromMarkdown(text) {
  const src = String(text || "")
  const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (fm) {
    const n = fm[1].match(/^name:\s*(?:"([^"]+)"|'([^']+)'|(.+))$/m)
    const val = (n?.[1] || n?.[2] || n?.[3] || "").trim()
    const slug = slugName(val)
    if (slug) return slug
  }
  const h1 = src.match(/^#\s+(.+)$/m)
  if (h1?.[1]) {
    const slug = slugName(h1[1])
    if (slug) return slug
  }
  return null
}

function looksLikeSkillMarkdown(text, filename = "") {
  const src = String(text || "")
  if (src.length < 12) return false
  if (/^---\r?\n/.test(src) && /(?:^|\n)(?:name|description):/i.test(src.slice(0, 1200))) return true
  if (/\.(md|skill)$/i.test(filename) && /^#\s+\S/m.test(src)) return true
  if (/^#\s+\S/m.test(src) && /\b(skill|you will|instructions|procedure)\b/i.test(src.slice(0, 2500))) return true
  return false
}

function tryUtf8(buf) {
  const text = buf.toString("utf8")
  if (text.includes("\uFFFD") && buf.includes(0)) return null
  const sample = buf.slice(0, Math.min(buf.length, 800))
  let odd = 0
  for (const b of sample) if (b < 9 || (b > 13 && b < 32 && b !== 27)) odd++
  if (odd > sample.length * 0.15) return null
  return text
}

export function detectSkillArtifact(buf, filename = "") {
  if (!buf || !buf.length) return { type: null, error: "empty download" }
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) {
    return { type: "archive" }
  }
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c) {
    return { type: null, error: "unsupported package" }
  }
  const text = tryUtf8(buf)
  if (text == null) return { type: null, error: "unsupported package" }
  const head = text.trimStart().slice(0, 220).toLowerCase()
  if (head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<head")) {
    return { type: null, error: "invalid content (HTML page, not a skill)" }
  }
  if (looksLikeSkillMarkdown(text, filename)) return { type: "markdown", text }
  return { type: null, error: "unsupported package" }
}

function toolSlug(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
  return TOOL_NAME_RE.test(s) ? s : null
}

function nameFromPlugin(text) {
  const m = String(text || "").match(/\bname\s*:\s*["'`]([a-z][a-z0-9_]{1,40})["'`]/i)
  return m ? toolSlug(m[1]) : null
}

function looksLikePlugin(text, filename = "") {
  const src = String(text || "")
  if (src.length < 20) return false
  if (!/export\s+default/.test(src)) return false
  if (!/\bname\s*:/.test(src)) return false
  if (!/\b(run|execute)\s*\(/.test(src) && !/\bdescription\s*:/.test(src)) return false
  if (/\.(mjs|js)$/i.test(filename) || /export\s+default/.test(src)) return true
  return false
}

export function detectToolArtifact(buf, filename = "") {
  if (!buf || !buf.length) return { type: null, error: "empty download" }
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) {
    return { type: "archive" }
  }
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c) {
    return { type: null, error: "unsupported package" }
  }
  const text = tryUtf8(buf)
  if (text == null) return { type: null, error: "unsupported package" }
  const head = text.trimStart().slice(0, 220).toLowerCase()
  if (head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<head")) {
    return { type: null, error: "invalid content (HTML page, not a tool)" }
  }
  if (looksLikePlugin(text, filename)) return { type: "plugin", text }
  return { type: null, error: "unsupported package" }
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex")
}

function findByHash(manifest, hash) {
  for (const rec of Object.values(manifest.items || {})) {
    if (rec && rec.sha256 === hash) return rec
  }
  return null
}

function uniqueId(base, manifest, kind = "skill") {
  let id = base
  let n = 2
  while (manifest.items?.[id]) {
    id = kind === "tool" ? `${base}_${n}` : `${base}-${n}`
    n++
  }
  return id
}

async function defaultFetch(url, opts) {
  return pinnedFetch(url, opts)
}

/**
 * Download one skill or tool URL. `fetchFn` is injectable for tests.
 * Returns { ok, error, reused, record } — never throws for expected failures.
 */
async function downloadArtifact(url, { kind = "skill", fetchFn = defaultFetch, env = process.env, now = Date.now, onProgress } = {}) {
  const checked = validateDownloadUrl(url)
  if (!checked.ok) return { ok: false, error: checked.error, url: String(url ?? "") }

  const progress = (p) => { try { onProgress?.(p) } catch { /* UI only */ } }
  progress({ phase: "start", url: checked.url, received: 0, total: 0, pct: null, done: false })

  let res
  try {
    res = await fetchFn(checked.url, {
      method: "GET",
      headers: { "user-agent": `forge-${kind}-download/63`, accept: "*/*" },
      timeoutMs: 20000,
      totalTimeoutMs: 45000,
      maxBytes: MAX_SKILL_BYTES,
      allowPrivate: false,
      onBytes: (p) => progress({ phase: "read", url: checked.url, ...p, done: false, pct: p?.pct == null ? null : Math.min(99, p.pct) }),
    })
  } catch (e) {
    const blocked = e instanceof PinnedFetchError && e.blocked
    progress({ phase: "error", url: checked.url, received: 0, total: 0, pct: null, done: false })
    return {
      ok: false,
      error: blocked ? `refused (${e.message})` : (e?.message || "download failed"),
      url: checked.url,
      blocked: Boolean(blocked),
    }
  }
  if (!res || res.ok === false) {
    const status = res?.status
    progress({ phase: "error", url: checked.url, received: 0, total: 0, pct: null, done: false })
    return { ok: false, error: status ? `HTTP ${status}` : "download failed", url: checked.url }
  }
  const body = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body || [])
  if (!body.length) {
    progress({ phase: "error", url: checked.url, received: 0, total: 0, pct: null, done: false })
    return { ok: false, error: "empty download", url: checked.url }
  }

  const fallback = kind === "tool" ? "tool.mjs" : "skill.bin"
  const fromUrl = safeFilename(new URL(checked.url).pathname, fallback)
  const disp = String(res.headers?.["content-disposition"] || res.headers?.["Content-Disposition"] || "")
  const named = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disp)
  const filename = safeFilename(named?.[1] ? decodeURIComponent(named[1].trim()) : fromUrl, fromUrl)

  const kinded = kind === "tool" ? detectToolArtifact(body, filename) : detectSkillArtifact(body, filename)
  if (!kinded.type) return { ok: false, error: kinded.error, url: checked.url }

  const hash = sha256(body)
  const manifest = loadDownloadManifest(env, kind)
  const existing = findByHash(manifest, hash)
  if (existing) {
    progress({ phase: "done", url: checked.url, received: body.length, total: body.length, pct: 100, done: true })
    return {
      ok: true,
      reused: true,
      record: existing,
      lifecycle: existing.lifecycle || SKILL_LIFE.CANDIDATE,
      url: checked.url,
    }
  }

  const guessed = kind === "tool"
    ? (kinded.type === "plugin" ? nameFromPlugin(kinded.text) : null)
    : (kinded.type === "markdown" ? nameFromMarkdown(kinded.text) : null)
  const stripped = filename.replace(/\.(md|skill|zip|mjs|js)$/i, "")
  const base = guessed
    || (kind === "tool" ? (toolSlug(stripped) || `tool_${hash.slice(0, 8)}`) : slugName(stripped))
    || `${kind === "tool" ? "tool_" : "skill-"}${hash.slice(0, 8)}`
  const id = uniqueId(base, manifest, kind)
  const dest = path.join(rootFor(kind, env), id)
  ensureDir(dest)

  try {
    writeStateFile(path.join(dest, filename), body, { mode: 0o600 })
    if (kinded.type === "markdown") {
      writeStateFile(path.join(dest, "SKILL.md"), kinded.text, { mode: 0o600 })
    }
    if (kinded.type === "plugin") {
      writeStateFile(path.join(dest, `${id}.mjs`), kinded.text, { mode: 0o600 })
    }
    const ts = new Date(now()).toISOString()
    const rec = {
      id,
      kind,
      sourceUrl: checked.url,
      downloadedAt: ts,
      filename,
      sha256: hash,
      size: body.length,
      status: DOWNLOAD_STATUS.DOWNLOADED,
      lifecycle: SKILL_LIFE.CANDIDATE,
      detectedType: kinded.type,
      skillName: id,
    }
    if (kinded.type === "markdown") {
      const desc = skillDescription(kinded.text)
      if (desc) rec.description = desc.slice(0, 240)
    } else if (kinded.type === "plugin") {
      const d = String(kinded.text).match(/\bdescription\s*:\s*["'`]([^"'`]{1,200})["'`]/)
      if (d?.[1]) rec.description = d[1].slice(0, 240)
    }
    writeStateFile(path.join(dest, "meta.json"), JSON.stringify(rec, null, 1), { mode: 0o600 })
    manifest.v = 1
    manifest.updated = now()
    manifest.items = manifest.items || {}
    manifest.items[id] = rec
    saveManifest(manifest, env, kind)
    recordCandidate(id, env, kind)
    progress({ phase: "done", url: checked.url, received: body.length, total: body.length, pct: 100, done: true })
    return { ok: true, reused: false, record: rec, lifecycle: SKILL_LIFE.CANDIDATE, url: checked.url }
  } catch (e) {
    try { fs.rmSync(dest, { recursive: true, force: true }) } catch { /* best-effort */ }
    return { ok: false, error: e?.message || "write failed", url: checked.url }
  }
}

export async function downloadSkill(url, opts = {}) {
  return downloadArtifact(url, { ...opts, kind: "skill" })
}

export async function downloadTool(url, opts = {}) {
  return downloadArtifact(url, { ...opts, kind: "tool" })
}

export async function downloadSkills(urls, opts = {}) {
  const list = (Array.isArray(urls) ? urls : [urls]).map((u) => String(u || "").trim()).filter(Boolean)
  const results = []
  for (const u of list) results.push(await downloadSkill(u, opts))
  return results
}

export async function downloadTools(urls, opts = {}) {
  const list = (Array.isArray(urls) ? urls : [urls]).map((u) => String(u || "").trim()).filter(Boolean)
  const results = []
  for (const u of list) results.push(await downloadTool(u, opts))
  return results
}

export function formatDownloadReport(result) {
  if (!result?.ok) {
    return `DOWNLOAD FAILED\n\nReason:\n${result?.error || "unknown"}\n`
  }
  const rec = result.record || {}
  const name = rec.skillName || rec.id || "skill"
  const reused = result.reused ? " (existing copy)" : ""
  return [
    `Downloaded successfully${reused}.`,
    "",
    "Candidate:",
    name,
    "",
    "Status:",
    rec.lifecycle || SKILL_LIFE.CANDIDATE,
    "",
    "Not trusted. DOWNLOAD ≠ VERIFY.",
  ].join("\n") + "\n"
}

function skillMdPath(id, env) {
  return path.join(skillDownloadsDir(env), id, "SKILL.md")
}

function evidencePath(id, env) {
  return path.join(skillDownloadsDir(env), id, EVIDENCE_FILE)
}

/**
 * Commands under a `## Tests` heading only (not ## Verify — that's playbook
 * advice). Fenced sh/bash blocks and `- \`cmd\`` bullets. Cap 4.
 */
export function extractTestCommands(md) {
  const text = String(md || "")
  const m = text.match(/^##\s+Tests\s*$/im)
  if (!m) return []
  const start = m.index + m[0].length
  const rest = text.slice(start)
  const next = rest.search(/^##\s+/m)
  const body = next === -1 ? rest : rest.slice(0, next)
  const cmds = []
  const fence = /```(?:sh|bash|shell)?\n([\s\S]*?)```/gi
  let fm
  while ((fm = fence.exec(body))) {
    for (const line of String(fm[1] || "").split("\n")) {
      const c = line.trim()
      if (c && !c.startsWith("#")) cmds.push(c)
    }
  }
  for (const line of body.split("\n")) {
    const tick = line.trim().match(/^(?:[-*]\s+)?`([^`]+)`\s*$/)
    if (tick) cmds.push(tick[1].trim())
  }
  const seen = new Set()
  const out = []
  for (const c of cmds) {
    if (!c || c.length > 200 || seen.has(c)) continue
    seen.add(c)
    out.push(c)
    if (out.length >= MAX_TEST_COMMANDS) break
  }
  return out
}

function refuseTestLevel(level) {
  return level === "block" || level === "danger" || level === "confirm"
}

export function runSkillTests(commands, { cwd, env = process.env } = {}) {
  const dir = cwd || fs.mkdtempSync(path.join(os.tmpdir(), "forge-ev-"))
  const results = []
  for (const cmd of commands) {
    const cls = classifyCommand(cmd, { cwd: dir, root: dir, env })
    if (refuseTestLevel(cls.level)) {
      results.push({
        cmd, ok: false, skipped: true, level: cls.level,
        reason: (cls.reasons && cls.reasons[0]) || cls.level,
      })
      continue
    }
    const r = spawnSync("sh", ["-c", cmd], {
      cwd: dir,
      env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: dir, LANG: "C" },
      timeout: TEST_TIMEOUT_MS,
      encoding: "utf8",
    })
    const timed = r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM"
    results.push({
      cmd,
      ok: r.status === 0 && !timed,
      code: r.status,
      level: cls.level,
      timed: !!timed,
    })
  }
  return results
}

export function readSkillEvidence(name, env = process.env) {
  try {
    const j = JSON.parse(fs.readFileSync(evidencePath(name, env), "utf8"))
    return j && typeof j === "object" ? j : null
  } catch {
    return null
  }
}

function saveEvidence(id, evidence, env) {
  try {
    writeStateFile(evidencePath(id, env), JSON.stringify(evidence, null, 1), { mode: 0o600 })
  } catch { /* best-effort */ }
}

function toolMjsPath(id, env) {
  return path.join(toolDownloadsDir(env), id, `${id}.mjs`)
}

function issuesForSkill(id, rec, env) {
  const issues = []
  if (!validSkillName(id)) issues.push(`invalid name "${id}"`)
  if (rec?.detectedType === "archive") issues.push("cannot verify archive (unpack not this release)")
  const file = skillMdPath(id, env)
  if (!fs.existsSync(file)) {
    issues.push("SKILL.md missing")
    return issues
  }
  let md = ""
  try { md = fs.readFileSync(file, "utf8") } catch (e) { issues.push(`unreadable: ${e.message}`); return issues }
  if (!md.trim()) issues.push("SKILL.md is empty")
  if (KERNEL_HINT.test(md)) issues.push("kernel path / assumeYes / plugin-host — refused")
  const h1 = md.match(/^#\s+(.+)$/m)
  const first = md.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#") && !l.startsWith("---"))
  if (!h1 && !first) issues.push("no description")
  if (md.length > 64 * 1024) issues.push("SKILL.md too large")
  return issues
}

function issuesForTool(id, rec, env) {
  const issues = []
  if (!TOOL_NAME_RE.test(id)) issues.push(`invalid tool name "${id}"`)
  if (TOOL_FORBIDDEN.has(id)) issues.push("reserved builtin name")
  if (rec?.detectedType === "archive") issues.push("cannot verify archive (unpack not this release)")
  const file = toolMjsPath(id, env)
  if (!fs.existsSync(file)) {
    issues.push("plugin .mjs missing")
    return issues
  }
  let src = ""
  try { src = fs.readFileSync(file, "utf8") } catch (e) { issues.push(`unreadable: ${e.message}`); return issues }
  if (!src.trim()) issues.push("empty plugin")
  if (!/export\s+default/.test(src)) issues.push("no export default")
  if (!/\bname\s*:/.test(src)) issues.push("no name")
  if (!/\bdescription\s*:/.test(src)) issues.push("no description")
  if (!/\b(run|execute)\s*\(/.test(src)) issues.push("no run()")
  if (KERNEL_HINT.test(src)) issues.push("kernel path / assumeYes / plugin-host — refused")
  if (TOOL_DENY.test(src)) issues.push("forbidden API (child_process / eval / plugin-host)")
  if (/PLUGINS_DIR|~\/\.forge\/tools|forge\/tools/.test(src)) issues.push("writes ~/.forge/tools — refused")
  return issues
}

/**
 * Structural + optional ## Tests. Never fetches, never plugin-host, never
 * ~/.forge/tools. Pass → VERIFIED. Fail → INACTIVE. Missing → not ok.
 * No ## Tests → structural evidence. Dangerous commands are not executed.
 */
export function verifySkill(name, { env = process.env } = {}) {
  const id = String(name || "").trim()
  const man = loadDownloadManifest(env, "skill")
  const rec = man.items?.[id]
  if (!rec) return { ok: false, error: `skill "${id}" not downloaded`, name: id }
  const issues = issuesForSkill(id, rec, env)
  if (issues.length) {
    const life = recordVerifyFail(id, env, "skill")
    saveEvidence(id, { v: 1, kind: "failed", issues, at: Date.now() }, env)
    return { ok: false, name: id, lifecycle: life, issues }
  }
  let md = ""
  try { md = fs.readFileSync(skillMdPath(id, env), "utf8") } catch { /* issuesForSkill already read */ }
  const commands = extractTestCommands(md)
  if (!commands.length) {
    const evidence = { v: 1, kind: "structural", commands: [], results: [], at: Date.now() }
    saveEvidence(id, evidence, env)
    const already = rec.lifecycle === SKILL_LIFE.VERIFIED
    setLifecycle(id, SKILL_LIFE.VERIFIED, env, "skill")
    return { ok: true, already, name: id, lifecycle: SKILL_LIFE.VERIFIED, issues: [], evidence }
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ev-"))
  let results = []
  try {
    results = runSkillTests(commands, { cwd: work, env })
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }) } catch { /* tmp */ }
  }
  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    const why = failed.map((r) => r.skipped
      ? `test refused (${r.level}): ${r.cmd}`
      : `test failed (${r.timed ? "timeout" : r.code}): ${r.cmd}`)
    const evidence = { v: 1, kind: "behavioral", ok: false, commands, results, at: Date.now() }
    saveEvidence(id, evidence, env)
    const life = recordVerifyFail(id, env, "skill")
    return { ok: false, name: id, lifecycle: life, issues: why, evidence }
  }
  const evidence = { v: 1, kind: "behavioral", ok: true, commands, results, at: Date.now() }
  saveEvidence(id, evidence, env)
  const already = rec.lifecycle === SKILL_LIFE.VERIFIED
  setLifecycle(id, SKILL_LIFE.VERIFIED, env, "skill")
  return { ok: true, already, name: id, lifecycle: SKILL_LIFE.VERIFIED, issues: [], evidence }
}

export function verifyTool(name, { env = process.env } = {}) {
  const id = String(name || "").trim()
  const man = loadDownloadManifest(env, "tool")
  const rec = man.items?.[id]
  if (!rec) return { ok: false, error: `tool "${id}" not downloaded`, name: id }
  const issues = issuesForTool(id, rec, env)
  if (issues.length) {
    const life = recordVerifyFail(id, env, "tool")
    return { ok: false, name: id, lifecycle: life, issues }
  }
  if (rec.lifecycle === SKILL_LIFE.VERIFIED) {
    return { ok: true, already: true, name: id, lifecycle: SKILL_LIFE.VERIFIED, issues: [] }
  }
  setLifecycle(id, SKILL_LIFE.VERIFIED, env, "tool")
  return { ok: true, name: id, lifecycle: SKILL_LIFE.VERIFIED, issues: [] }
}

export function verifySkills(names, opts = {}) {
  const man = loadDownloadManifest(opts.env, "skill")
  let list = (Array.isArray(names) ? names : [names]).map((n) => String(n || "").trim()).filter(Boolean)
  if (list.length === 1 && list[0].toLowerCase() === "all") {
    list = Object.keys(man.items || {})
  }
  return list.map((n) => verifySkill(n, opts))
}

export function verifyTools(names, opts = {}) {
  const man = loadDownloadManifest(opts.env, "tool")
  let list = (Array.isArray(names) ? names : [names]).map((n) => String(n || "").trim()).filter(Boolean)
  if (list.length === 1 && list[0].toLowerCase() === "all") {
    list = Object.keys(man.items || {})
  }
  return list.map((n) => verifyTool(n, opts))
}

export function formatVerifyReport(results, label = "SKILL") {
  const rows = Array.isArray(results) ? results : [results]
  const lines = [`${label} VERIFICATION RESULT`, ""]
  let passed = 0, failed = 0
  for (const r of rows) {
    const name = r.name || "?"
    if (r.ok) {
      passed++
      lines.push(`✓ ${name.padEnd(20)} ${r.lifecycle || SKILL_LIFE.VERIFIED}`)
      if (r.evidence?.kind) lines.push(`    evidence: ${r.evidence.kind}`)
    } else {
      failed++
      lines.push(`✗ ${name.padEnd(20)} ${r.lifecycle || INACTIVE}`)
      for (const iss of r.issues || (r.error ? [r.error] : [])) lines.push(`    • ${iss}`)
    }
  }
  lines.push("", `Verified: ${passed}`, `Failed: ${failed}`)
  return lines.join("\n") + "\n"
}

/** VERIFIED downloads only — CANDIDATE/INACTIVE/STALE/CONTRADICTED/DRIFT stay out of pickSkills. */
export function indexVerifiedSkills(env = process.env) {
  const out = []
  for (const rec of listDownloads(env, "skill")) {
    if (rec.lifecycle !== SKILL_LIFE.VERIFIED) continue
    const p = skillMdPath(rec.id, env)
    if (!fs.existsSync(p)) continue
    out.push({
      name: rec.id,
      desc: rec.description || "",
      path: p,
      downloaded: true,
      lifecycle: SKILL_LIFE.VERIFIED,
      extracted: rec.learned === true,
      evidence: readSkillEvidence(rec.id, env)?.kind || "structural",
    })
  }
  return out
}

/** VERIFIED tools as hostless playbooks. Never plugin-host. */
export function indexVerifiedToolPlaybooks(env = process.env) {
  const out = []
  for (const rec of listDownloads(env, "tool")) {
    if (rec.lifecycle !== SKILL_LIFE.VERIFIED) continue
    if (!TOOL_NAME_RE.test(rec.id) || TOOL_FORBIDDEN.has(rec.id)) continue
    out.push({
      name: rec.id,
      description: rec.description || `downloaded tool ${rec.id}`,
      readOnly: true,
      tags: ["downloaded"],
      playbook: true,
      downloaded: true,
    })
  }
  return out
}

/**
 * Body of a VERIFIED downloaded skill. CANDIDATE/INACTIVE/STALE/CONTRADICTED/DRIFT return null.
 * Sync. No fetch. No plugin-host.
 */
export function readDownloadedSkill(name, env = process.env) {
  const n = validSkillName(name)
  if (!n) return null
  sweepDrift(env, "skill")
  sweepStale(env, "skill")
  const rec = loadDownloadManifest(env, "skill").items?.[n]
  if (!rec || rec.lifecycle !== SKILL_LIFE.VERIFIED) return null
  const file = skillMdPath(n, env)
  try {
    if (!fs.existsSync(file)) return null
    const md = fs.readFileSync(file, "utf8")
    if (!md.trim() || KERNEL_HINT.test(md)) return null
    let out = md.length > 24000 ? md.slice(0, 24000) + "\n... (truncated)" : md
    if (rec.learned === true) {
      const know = readSkillKnowledge(n, env)
      if (know?.procedures?.length) {
        out += "\n\n## Learned procedures\n"
        for (const p of know.procedures.slice(0, 6)) {
          out += `- ${p.title}${p.body ? ": " + String(p.body).slice(0, 160) : ""}\n`
        }
      }
    }
    return out
  } catch {
    return null
  }
}

/**
 * Hostless markdown playbook for a VERIFIED downloaded tool.
 * Never returns the .mjs source. Never spawns plugin-host.
 */
export function readDownloadedToolPlaybook(name, env = process.env) {
  const n = String(name || "").trim()
  if (!TOOL_NAME_RE.test(n) || TOOL_FORBIDDEN.has(n)) return null
  sweepDrift(env, "tool")
  sweepStale(env, "tool")
  const rec = loadDownloadManifest(env, "tool").items?.[n]
  if (!rec || rec.lifecycle !== SKILL_LIFE.VERIFIED) return null
  const desc = String(rec.description || n).slice(0, 240)
  const url = String(rec.sourceUrl || "").slice(0, 200)
  const lines = [
    `# ${n} (verified download)`,
    "",
    desc,
    "",
    "## When",
    "The task matches this tool's name or description.",
    "",
    "## What to run",
    "Follow the description as a hostless playbook. Do not spawn plugin-host.",
    "Do not write ~/.forge/tools. Do not flip assumeYes.",
  ]
  if (url) lines.push("", `Source: ${url}`)
  return lines.join("\n") + "\n"
}

function knowledgePath(id, env) {
  return path.join(skillDownloadsDir(env), id, KNOWLEDGE_FILE)
}

/**
 * Deterministic extract. Headings become procedures; bullets become patterns.
 * A name+description-only skill has nothing to learn.
 */
export function extractKnowledge(md) {
  const src = String(md || "")
  const play = parseSkillPlaybook(src)
  const procedures = []
  const heads = []
  const re = /^##\s+(.+)\s*$/gm
  let m
  while ((m = re.exec(src))) heads.push({ title: m[1].trim(), index: m.index, len: m[0].length })
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]
    if (/^(files|verify|references|learned procedures)$/i.test(h.title)) continue
    const start = h.index + h.len
    const end = i + 1 < heads.length ? heads[i + 1].index : src.length
    const body = src.slice(start, end).trim().split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .join(" ")
      .slice(0, 400)
    procedures.push({ title: h.title.slice(0, 80), body })
  }
  const patterns = []
  for (const line of src.split("\n")) {
    const t = line.trim()
    if (!/^[-*]\s+\S/.test(t)) continue
    const b = t.replace(/^[-*]\s+/, "").replace(/^`([^`]+)`$/, "$1").trim()
    if (b.length < 12 || b.length > 200) continue
    if (/^src\/|^https?:/i.test(b)) continue
    patterns.push(b.slice(0, 160))
  }
  return {
    procedures: procedures.slice(0, 8),
    patterns: [...new Set(patterns)].slice(0, 8),
    files: play.files || [],
    command: play.command || "",
    repair: play.repair || "",
  }
}

export function readSkillKnowledge(name, env = process.env) {
  const n = validSkillName(name)
  if (!n) return null
  try {
    const j = JSON.parse(fs.readFileSync(knowledgePath(n, env), "utf8"))
    if (!j || typeof j !== "object") return null
    return j
  } catch {
    return null
  }
}

/**
 * LEARN ≠ INDEX. VERIFIED only. Writes knowledge.json under the download
 * dir. Lifecycle stays VERIFIED (not ACTIVE). Never ~/.forge/tools.
 */
export function learnSkill(name, { env = process.env, now = Date.now, cwd = process.cwd() } = {}) {
  const id = String(name || "").trim()
  const man = loadDownloadManifest(env, "skill")
  const rec = man.items?.[id]
  if (!rec) return { ok: false, error: `skill "${id}" not downloaded`, name: id }
  if (rec.lifecycle === INACTIVE) return { ok: false, error: "INACTIVE — verify first", name: id, lifecycle: INACTIVE }
  if (rec.lifecycle !== SKILL_LIFE.VERIFIED) {
    return { ok: false, error: "not verified (indexing is not learned)", name: id, lifecycle: rec.lifecycle || SKILL_LIFE.CANDIDATE }
  }
  const file = skillMdPath(id, env)
  let md = ""
  try { md = fs.readFileSync(file, "utf8") } catch {
    return { ok: false, error: "SKILL.md missing", name: id }
  }
  if (KERNEL_HINT.test(md)) return { ok: false, error: "kernel path — refused", name: id }
  const knowledge = extractKnowledge(md)
  const substance = (knowledge.procedures.length + (knowledge.repair ? 1 : 0) + knowledge.patterns.length)
  if (substance < 1) {
    return { ok: false, error: "nothing to extract (indexing is not learned)", name: id, lifecycle: SKILL_LIFE.VERIFIED }
  }
  const payload = {
    v: 1,
    name: id,
    learnedAt: new Date(now()).toISOString(),
    sourceUrl: rec.sourceUrl || "",
    sha256: rec.sha256 || "",
    ...knowledge,
  }
  try {
    writeStateFile(knowledgePath(id, env), JSON.stringify(payload, null, 1), { mode: 0o600 })
  } catch (e) {
    return { ok: false, error: e?.message || "write failed", name: id }
  }
  rec.learned = true
  rec.learnedAt = payload.learnedAt
  rec.procedures = knowledge.procedures.length
  rec.patterns = knowledge.patterns.length
  man.items[id] = rec
  man.updated = now()
  saveManifest(man, env, "skill")
  try { writeStateFile(path.join(skillDownloadsDir(env), id, "meta.json"), JSON.stringify(rec, null, 1), { mode: 0o600 }) } catch { /* meta best-effort */ }
  let claim = null
  try {
    const text = (knowledge.procedures || [])
      .map((p) => typeof p === "string" ? p : [p?.title, p?.body].filter(Boolean).join(": "))
      .filter(Boolean)
      .join("\n") || knowledge.repair || id
    claim = recordClaim({ cwd, subject: id, text, source: "skill", skill: id })
  } catch { /* claims are best-effort */ }
  return {
    ok: true,
    name: id,
    lifecycle: SKILL_LIFE.VERIFIED,
    learned: true,
    knowledge: payload,
    claim: claim?.ok ? claim.claim : null,
  }
}

export function formatLearnReport(result) {
  if (!result?.ok) {
    return `LEARN FAILED\n\nReason:\n${result?.error || "unknown"}\n`
  }
  const k = result.knowledge || {}
  return [
    "Learned.",
    "",
    "Skill:",
    result.name,
    "",
    `Procedures: ${k.procedures?.length ?? 0}`,
    `Patterns: ${k.patterns?.length ?? 0}`,
    "",
    "Not ACTIVE. LEARN ≠ INDEX. DOWNLOAD ≠ VERIFY.",
  ].join("\n") + "\n"
}



