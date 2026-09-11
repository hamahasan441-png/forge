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
 * Verified tools are hostless playbooks — never ~/.forge/tools, never plugin-host.
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
export const TOOL_DOWNLOADS = "tool-downloads"
export const MANIFEST_FILE = "manifest.json"
export const LIFE_FILE = "skilllife.json"
export const DOWNLOAD_STATUS = Object.freeze({
  DOWNLOADED: "DOWNLOADED",
  FAILED: "FAILED",
})
export const MAX_SKILL_BYTES = 8 * 1024 * 1024
export const INACTIVE = "INACTIVE"

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

function setLifecycle(name, lifecycle, env, kind = "skill") {
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
  bucket[name] = rec
  all.v = 1
  all.updated = Date.now()
  all[key] = bucket
  saveLife(all, env, kind)
  const man = loadDownloadManifest(env, kind)
  if (man.items?.[name]) {
    man.items[name].lifecycle = lifecycle
    man.updated = Date.now()
    saveManifest(man, env, kind)
    const meta = path.join(rootFor(kind, env), name, "meta.json")
    try { writeStateFile(meta, JSON.stringify(man.items[name], null, 1), { mode: 0o600 }) } catch { /* meta is best-effort */ }
  }
  return rec
}

export function listDownloads(env = process.env, kind = "skill") {
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
async function downloadArtifact(url, { kind = "skill", fetchFn = defaultFetch, env = process.env, now = Date.now } = {}) {
  const checked = validateDownloadUrl(url)
  if (!checked.ok) return { ok: false, error: checked.error, url: String(url ?? "") }

  let res
  try {
    res = await fetchFn(checked.url, {
      method: "GET",
      headers: { "user-agent": `forge-${kind}-download/63`, accept: "*/*" },
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
 * Structural verify. Never fetches, never spawns plugin-host, never writes
 * ~/.forge/tools. Pass → VERIFIED. Fail → INACTIVE. Missing → not ok.
 */
export function verifySkill(name, { env = process.env } = {}) {
  const id = String(name || "").trim()
  const man = loadDownloadManifest(env, "skill")
  const rec = man.items?.[id]
  if (!rec) return { ok: false, error: `skill "${id}" not downloaded`, name: id }
  const issues = issuesForSkill(id, rec, env)
  if (issues.length) {
    setLifecycle(id, INACTIVE, env, "skill")
    return { ok: false, name: id, lifecycle: INACTIVE, issues }
  }
  if (rec.lifecycle === SKILL_LIFE.VERIFIED) {
    return { ok: true, already: true, name: id, lifecycle: SKILL_LIFE.VERIFIED, issues: [] }
  }
  setLifecycle(id, SKILL_LIFE.VERIFIED, env, "skill")
  return { ok: true, name: id, lifecycle: SKILL_LIFE.VERIFIED, issues: [] }
}

export function verifyTool(name, { env = process.env } = {}) {
  const id = String(name || "").trim()
  const man = loadDownloadManifest(env, "tool")
  const rec = man.items?.[id]
  if (!rec) return { ok: false, error: `tool "${id}" not downloaded`, name: id }
  const issues = issuesForTool(id, rec, env)
  if (issues.length) {
    setLifecycle(id, INACTIVE, env, "tool")
    return { ok: false, name: id, lifecycle: INACTIVE, issues }
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
    } else {
      failed++
      lines.push(`✗ ${name.padEnd(20)} ${r.lifecycle || INACTIVE}`)
      for (const iss of r.issues || (r.error ? [r.error] : [])) lines.push(`    • ${iss}`)
    }
  }
  lines.push("", `Verified: ${passed}`, `Failed: ${failed}`)
  return lines.join("\n") + "\n"
}

/** VERIFIED downloads only — CANDIDATE/INACTIVE stay out of pickSkills. */
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
 * Body of a VERIFIED downloaded skill. CANDIDATE/INACTIVE return null.
 * Sync. No fetch. No plugin-host.
 */
export function readDownloadedSkill(name, env = process.env) {
  const n = validSkillName(name)
  if (!n) return null
  const rec = loadDownloadManifest(env, "skill").items?.[n]
  if (!rec || rec.lifecycle !== SKILL_LIFE.VERIFIED) return null
  const file = skillMdPath(n, env)
  try {
    if (!fs.existsSync(file)) return null
    const md = fs.readFileSync(file, "utf8")
    if (!md.trim() || KERNEL_HINT.test(md)) return null
    return md.length > 24000 ? md.slice(0, 24000) + "\n... (truncated)" : md
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


