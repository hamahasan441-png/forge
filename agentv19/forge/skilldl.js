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
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { resolveDataDir } from "./config.js"
import { pinnedFetch, PinnedFetchError } from "./netguard.js"
import { writeStateFile } from "./securefs.js"
import { validSkillName, skillDescription } from "./skills.js"
import { SKILL_LIFE } from "./evolve.js"

export const SKILL_DOWNLOADS = "skill-downloads"
export const MANIFEST_FILE = "manifest.json"
export const LIFE_FILE = "skilllife.json"
export const DOWNLOAD_STATUS = Object.freeze({
  DOWNLOADED: "DOWNLOADED",
  FAILED: "FAILED",
})
export const MAX_SKILL_BYTES = 8 * 1024 * 1024

export function skillDownloadsDir(env = process.env) {
  return path.join(resolveDataDir(env), SKILL_DOWNLOADS)
}

export function downloadManifestPath(env = process.env) {
  return path.join(skillDownloadsDir(env), MANIFEST_FILE)
}

export function downloadLifePath(env = process.env) {
  return path.join(skillDownloadsDir(env), LIFE_FILE)
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

export function loadDownloadManifest(env = process.env) {
  try {
    const j = JSON.parse(fs.readFileSync(downloadManifestPath(env), "utf8"))
    if (!j || typeof j !== "object") return { v: 1, items: {} }
    if (!j.items || typeof j.items !== "object") j.items = {}
    return j
  } catch {
    return { v: 1, items: {} }
  }
}

function saveManifest(data, env) {
  const file = downloadManifestPath(env)
  ensureDir(path.dirname(file))
  writeStateFile(file, JSON.stringify(data, null, 1), { mode: 0o600 })
}

export function loadDownloadLife(env = process.env) {
  try {
    const j = JSON.parse(fs.readFileSync(downloadLifePath(env), "utf8"))
    if (!j || typeof j !== "object") return { v: 1, skills: {} }
    if (!j.skills || typeof j.skills !== "object") j.skills = {}
    return j
  } catch {
    return { v: 1, skills: {} }
  }
}

function saveLife(data, env) {
  const file = downloadLifePath(env)
  ensureDir(path.dirname(file))
  writeStateFile(file, JSON.stringify(data, null, 1), { mode: 0o600 })
}

function recordCandidate(name, env) {
  if (!name) return null
  const all = loadDownloadLife(env)
  const skills = all.skills || (all.skills = {})
  const rec = skills[name] && typeof skills[name] === "object" ? skills[name] : {
    name, lifecycle: SKILL_LIFE.CANDIDATE, samples: 0, firstSeen: Date.now(),
  }
  rec.name = name
  rec.samples = (rec.samples ?? 0) + 1
  rec.lastSeen = Date.now()
  if (rec.lifecycle !== SKILL_LIFE.VERIFIED && rec.lifecycle !== SKILL_LIFE.ACTIVE) {
    rec.lifecycle = SKILL_LIFE.CANDIDATE
  }
  skills[name] = rec
  all.v = 1
  all.updated = Date.now()
  all.skills = skills
  saveLife(all, env)
  return rec
}

export function listDownloads(env = process.env) {
  const items = Object.values(loadDownloadManifest(env).items || {})
  return items.sort((a, b) => (b.downloadedAt || "").localeCompare(a.downloadedAt || ""))
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

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex")
}

function findByHash(manifest, hash) {
  for (const rec of Object.values(manifest.items || {})) {
    if (rec && rec.sha256 === hash) return rec
  }
  return null
}

function uniqueId(base, manifest) {
  let id = base
  let n = 2
  while (manifest.items?.[id]) {
    id = `${base}-${n}`
    n++
  }
  return id
}

async function defaultFetch(url, opts) {
  return pinnedFetch(url, opts)
}

/**
 * Download one skill URL. `fetchFn` is injectable for tests.
 * Returns { ok, error, reused, record } — never throws for expected failures.
 */
export async function downloadSkill(url, { fetchFn = defaultFetch, env = process.env, now = Date.now } = {}) {
  const checked = validateDownloadUrl(url)
  if (!checked.ok) return { ok: false, error: checked.error, url: String(url ?? "") }

  let res
  try {
    res = await fetchFn(checked.url, {
      method: "GET",
      headers: { "user-agent": "forge-skill-download/62", accept: "*/*" },
      timeoutMs: 20000,
      totalTimeoutMs: 45000,
      maxBytes: MAX_SKILL_BYTES,
      allowPrivate: false,
    })
  } catch (e) {
    const blocked = e instanceof PinnedFetchError && e.blocked
    return {
      ok: false,
      error: blocked ? `refused (${e.message})` : (e?.message || "download failed"),
      url: checked.url,
      blocked: Boolean(blocked),
    }
  }
  if (!res || res.ok === false) {
    const status = res?.status
    return { ok: false, error: status ? `HTTP ${status}` : "download failed", url: checked.url }
  }
  const body = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body || [])
  if (!body.length) return { ok: false, error: "empty download", url: checked.url }

  const fromUrl = safeFilename(new URL(checked.url).pathname, "skill.bin")
  const disp = String(res.headers?.["content-disposition"] || res.headers?.["Content-Disposition"] || "")
  const named = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disp)
  const filename = safeFilename(named?.[1] ? decodeURIComponent(named[1].trim()) : fromUrl, fromUrl)

  const kind = detectSkillArtifact(body, filename)
  if (!kind.type) return { ok: false, error: kind.error, url: checked.url }

  const hash = sha256(body)
  const manifest = loadDownloadManifest(env)
  const existing = findByHash(manifest, hash)
  if (existing) {
    return {
      ok: true,
      reused: true,
      record: existing,
      lifecycle: existing.lifecycle || SKILL_LIFE.CANDIDATE,
      url: checked.url,
    }
  }

  const guessed = kind.type === "markdown" ? nameFromMarkdown(kind.text) : null
  const base = guessed || slugName(filename.replace(/\.(md|skill|zip)$/i, "")) || `skill-${hash.slice(0, 8)}`
  const id = uniqueId(base, manifest)
  const root = skillDownloadsDir(env)
  const dest = path.join(root, id)
  ensureDir(dest)

  try {
    writeStateFile(path.join(dest, filename), body, { mode: 0o600 })
    if (kind.type === "markdown") {
      writeStateFile(path.join(dest, "SKILL.md"), kind.text, { mode: 0o600 })
    }
    const ts = new Date(now()).toISOString()
    const rec = {
      id,
      sourceUrl: checked.url,
      downloadedAt: ts,
      filename,
      sha256: hash,
      size: body.length,
      status: DOWNLOAD_STATUS.DOWNLOADED,
      lifecycle: SKILL_LIFE.CANDIDATE,
      detectedType: kind.type,
      skillName: id,
    }
    const desc = kind.type === "markdown" ? skillDescription(kind.text) : ""
    if (desc) rec.description = desc.slice(0, 240)
    writeStateFile(path.join(dest, "meta.json"), JSON.stringify(rec, null, 1), { mode: 0o600 })
    manifest.v = 1
    manifest.updated = now()
    manifest.items = manifest.items || {}
    manifest.items[id] = rec
    saveManifest(manifest, env)
    recordCandidate(id, env)
    return { ok: true, reused: false, record: rec, lifecycle: SKILL_LIFE.CANDIDATE, url: checked.url }
  } catch (e) {
    try { fs.rmSync(dest, { recursive: true, force: true }) } catch { /* best-effort */ }
    return { ok: false, error: e?.message || "write failed", url: checked.url }
  }
}

export async function downloadSkills(urls, opts = {}) {
  const list = (Array.isArray(urls) ? urls : [urls]).map((u) => String(u || "").trim()).filter(Boolean)
  const results = []
  for (const u of list) results.push(await downloadSkill(u, opts))
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
