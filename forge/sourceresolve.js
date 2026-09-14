/**
 * forge — local-first source resolution (v97 "unifiedwise", ∞ §4, zero dependencies)
 *
 * THE rule this module enforces: before engineering work begins, determine what
 * source the user actually means — and the LOCAL artifact always outranks a
 * remote one unless the user explicitly selected the remote.
 *
 * Resolution ladder (highest authority first):
 *   1. explicitly provided local file        → sourceType "file"
 *   2. explicitly provided local folder      → "folder"
 *   3. explicitly provided local ZIP/archive → "archive" (extracted, inspected)
 *   4. explicitly provided URL (https)       → "url"     (downloaded zip)
 *   5. explicitly provided git repository    → "git"     (shallow clone)
 *   6. current workspace / project (cwd)     → "workspace" / "git-repo"
 *   7. remote discovery/search — NEVER automatic. This module does not search
 *      the web for a repo that "looks like" the task; that would be the exact
 *      GitHub-bias failure §4 forbids.
 *
 * ZIP handling follows the §4 pipeline: inspect archive → identify project
 * root → detect languages / manifests / build systems / tests / configuration /
 * git metadata → extract safely (zip-slip guarded, entry + size caps) → operate
 * on the extracted LOCAL project.
 *
 * Persistence: ~/.forge/projects/<hash>/source.json records sourceType,
 * sourceId, localPath, archivePath, projectId, origin, authority, discovery
 * evidence and the REASON the source was selected — so a resumed session, the
 * meta controller and the world model all agree on what "the project" is.
 *
 * Conflict rule: if a local ZIP/folder is explicitly provided while the cwd is
 * a git repository, the EXPLICIT local selection wins and the conflict is
 * recorded with both candidates — never silently, never the other way around.
 */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import zlib from "node:zlib"
import crypto from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { DEFAULT_DIR } from "./config.js"
import { projectDir, projectHash } from "./memory.js"
import { writeStateFile } from "./securefs.js"
import { pinnedFetch, assertFetchableUrl } from "./netguard.js"

const execFileP = promisify(execFile)

export const SOURCES_DIR = path.join(DEFAULT_DIR, "sources")

// extraction safety caps (a project archive, not a skill pack — bigger, still bounded)
const MAX_ZIP_ENTRIES = 20000
const MAX_ZIP_TOTAL_BYTES = 512 * 1024 * 1024 // 512 MB extracted
const MAX_ZIP_FILE_BYTES = 64 * 1024 * 1024   // 64 MB per entry
const MAX_URL_BYTES = 256 * 1024 * 1024       // download cap
const GIT_CLONE_TIMEOUT_MS = 120000

/** Manifests that identify a project root / build system (basename → label). */
export const ROOT_MANIFESTS = [
  ["package.json", "node"], ["deno.json", "node"], ["bun.lockb", "node"],
  ["Cargo.toml", "rust"], ["go.mod", "go"], ["pyproject.toml", "python"],
  ["requirements.txt", "python"], ["setup.py", "python"], ["Pipfile", "python"],
  ["pom.xml", "java"], ["build.gradle", "java"], ["build.gradle.kts", "java"],
  ["Gemfile", "ruby"], ["composer.json", "php"], ["mix.exs", "elixir"],
  ["Makefile", "make"], ["CMakeLists.txt", "cmake"], ["meson.build", "meson"],
  ["flake.nix", "nix"], ["docker-compose.yml", "compose"], ["docker-compose.yaml", "compose"],
  ["pubspec.yaml", "dart"], ["build.zig", "zig"], ["tsconfig.json", "node"],
]

const LANG_BY_EXT = {
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript",
  ".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust", ".java": "java",
  ".kt": "kotlin", ".swift": "swift", ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp",
  ".cs": "csharp", ".php": "php", ".ex": "elixir", ".exs": "elixir", ".erl": "erlang",
  ".scala": "scala", ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".sql": "sql",
  ".lua": "lua", ".dart": "dart", ".zig": "zig", ".vue": "vue", ".svelte": "svelte",
}

function sha12(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 12)
}

// ---------------------------------------------------------------------------
// ZIP inspection + safe extraction (project-grade, zero dependencies)
// ---------------------------------------------------------------------------

/** Minimal ZIP local-file-header walker (store + deflate). Same technique as
 *  zipingest.js but project-scale: entry caps, total-size caps, zip-slip guard.
 *  Returns [{ name, size, compressedSize, method }] or null when not a zip. */
export function listProjectZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null
  if (buf.readUInt32LE(0) !== 0x04034b50) return null // PK\x03\x04
  const out = []
  let off = 0
  let total = 0
  while (off + 30 <= buf.length) {
    if (buf.readUInt32LE(off) !== 0x04034b50) break // central directory / garbage
    const method = buf.readUInt16LE(off + 8)
    const compSize = buf.readUInt32LE(off + 18)
    const size = buf.readUInt32LE(off + 22)
    const nameLen = buf.readUInt16LE(off + 26)
    const extraLen = buf.readUInt16LE(off + 28)
    if (off + 30 + nameLen > buf.length) break
    const name = buf.toString("utf8", off + 30, off + 30 + nameLen)
    if (out.length >= MAX_ZIP_ENTRIES) return { entries: out, truncated: true }
    if (size <= MAX_ZIP_FILE_BYTES && !name.endsWith("/")) {
      out.push({ name, size, compressedSize: compSize, method })
      total += size
      if (total > MAX_ZIP_TOTAL_BYTES) return { entries: out, truncated: true }
    }
    off += 30 + nameLen + extraLen + compSize
  }
  if (!out.length) return null
  return { entries: out, truncated: false }
}

export function isZipFile(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50
}

/** Identify the project root inside an archive: the shallowest directory that
 *  contains a root manifest. Falls back to the shallowest common prefix.
 *  SECURITY: a "root" that is or contains `..` (or is absolute) is rejected —
 *  the root-prefix logic must never launder a zip-slip path into a safe one. */
export function identifyZipRoot(entries) {
  const safe = (root) => {
    if (!root) return ""
    if (root === ".." || root.startsWith("../") || root.startsWith("/") || root.includes("\0")) return ""
    return root
  }
  const names = entries.map((e) => e.name)
  const manifestHit = {} // dirDepth → name
  for (const n of names) {
    const base = n.split("/").pop()
    if (ROOT_MANIFESTS.some(([m]) => m === base)) {
      const dir = n.includes("/") ? n.slice(0, n.lastIndexOf("/")) : ""
      const depth = dir ? dir.split("/").length : 0
      if (manifestHit.depth == null || depth < manifestHit.depth) manifestHit.depth = depth
    }
  }
  if (manifestHit.depth != null) {
    // find the actual dir name at that depth with a manifest
    for (const n of names) {
      const base = n.split("/").pop()
      if (!ROOT_MANIFESTS.some(([m]) => m === base)) continue
      const dir = n.includes("/") ? n.slice(0, n.lastIndexOf("/")) : ""
      if ((dir ? dir.split("/").length : 0) === manifestHit.depth) return safe(dir)
    }
  }
  // fallback: shallowest common directory prefix
  const first = names[0] ?? ""
  const prefix = first.includes("/") ? first.slice(0, first.lastIndexOf("/") + 1) : ""
  if (prefix && names.every((n) => n.startsWith(prefix))) return safe(prefix.slice(0, -1))
  return ""
}

/** Extract a project zip into `dest` (created). Zip-slip guarded; entry +
 *  byte caps; returns { files, root, truncated, skipped } — honest counts. */
export function extractProjectZip(buf, dest) {
  const listing = listProjectZipEntries(buf)
  if (!listing) return { ok: false, error: "not a zip archive" }
  const root = identifyZipRoot(listing.entries)
  const rootPrefix = root ? root + "/" : ""
  fs.mkdirSync(dest, { recursive: true })
  const files = []
  let skipped = 0
  let off = 0
  let written = 0
  while (off + 30 <= buf.length) {
    if (buf.readUInt32LE(off) !== 0x04034b50) break
    const method = buf.readUInt16LE(off + 8)
    const compSize = buf.readUInt32LE(off + 18)
    const size = buf.readUInt32LE(off + 22)
    const crc = buf.readUInt32LE(off + 14)
    const nameLen = buf.readUInt16LE(off + 26)
    const extraLen = buf.readUInt16LE(off + 28)
    const name = buf.toString("utf8", off + 30, off + 30 + nameLen)
    const dataStart = off + 30 + nameLen + extraLen
    off = dataStart + compSize
    if (name.endsWith("/")) continue
    const rel = name.startsWith(rootPrefix) && name !== rootPrefix ? name.slice(rootPrefix.length) : name
    if (!rel || rel.includes("..") || path.isAbsolute(rel) || rel.includes("\0")) { skipped++; continue }
    if (size > MAX_ZIP_FILE_BYTES || written + size > MAX_ZIP_TOTAL_BYTES) { skipped++; continue }
    if (files.length >= MAX_ZIP_ENTRIES) return { ok: true, files, root, truncated: true, skipped }
    const raw = buf.subarray(dataStart, dataStart + compSize)
    let data
    try {
      if (method === 0) data = raw
      else if (method === 8) data = zlib.inflateRawSync(raw)
      else { skipped++; continue }
    } catch { skipped++; continue }
    if (data.length !== size || (size > 0 && crc32(data) !== crc)) { skipped++; continue }
    const target = path.join(dest, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data)
    files.push(rel)
    written += size
  }
  return { ok: true, files, root, truncated: listing.truncated, skipped }
}

// crc32 (same table approach as zipingest; zlib.crc32 may not exist on older node)
let CRC_TABLE = null
function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// project discovery (shared by archive + folder + workspace)
// ---------------------------------------------------------------------------

/** Inspect a LOCAL directory: languages census, manifests, build systems,
 *  tests, CI, git metadata. Facts only — never a guess dressed as a fact. */
export function inspectProjectDir(dir) {
  const base = path.resolve(dir)
  const out = { dir: base, exists: false, manifests: [], languages: {}, tests: [], buildSystems: [], ci: [], git: false, gitRemote: null, fileCount: 0 }
  try { fs.statSync(base); out.exists = true } catch { return out }
  const walk = (d, depth) => {
    if (depth > 3) return
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      // v97 fix: only the workspace ROOT is "a git repo" — a nested checkout
      // (submodule clone, sibling project) must not relabel the parent.
      if (e.name === ".git" && d === base) { out.git = true; continue }
      if (e.name === "node_modules" || e.name === ".forge" || e.name === "target" || e.name === "__pycache__") continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      out.fileCount++
      if (depth <= 1 && ROOT_MANIFESTS.some(([m]) => m === e.name)) out.manifests.push(e.name)
      const ext = path.extname(e.name).toLowerCase()
      const lang = LANG_BY_EXT[ext]
      if (lang) out.languages[lang] = (out.languages[lang] ?? 0) + 1
      if (/^(test|spec)_|[-.](test|spec)\./i.test(e.name)) out.tests.push(path.relative(base, full))
      if (depth <= 1 && /^(Dockerfile|Makefile|CMakeLists\.txt|meson\.build)$/.test(e.name)) out.buildSystems.push(e.name)
      if (e.name.endsWith(".yml") || e.name.endsWith(".yaml")) {
        const rel = path.relative(base, full).replace(/\\/g, "/")
        if (/^\.github\/workflows\//.test(rel) || /^\.gitlab-ci\.yml$/.test(rel)) out.ci.push(rel)
      }
    }
  }
  walk(base, 0)
  out.tests = out.tests.slice(0, 40)
  out.gitRemote = gitRemoteUrl(base)
  return out
}

/** Read-only: the configured origin URL of a git repo (never mutates). */
export function gitRemoteUrl(dir) {
  try {
    const cfg = fs.readFileSync(path.join(dir, ".git", "config"), "utf8")
    const m = /\[remote "origin"\][^\[]*url\s*=\s*(\S+)/.exec(cfg)
    return m ? m[1] : null
  } catch { return null }
}

// ---------------------------------------------------------------------------
// source records (§4 persistence)
// ---------------------------------------------------------------------------

export function sourceRecordPath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), "source.json")
}

/** Persist the authoritative source record for a project directory. */
export function saveSourceRecord(cwd, record) {
  try {
    const prev = readSourceRecord(cwd)
    const rec = {
      version: 1,
      projectId: projectHash(cwd),
      resolvedAt: Date.now(),
      ...record,
      history: [...(prev?.history ?? []), { resolvedAt: Date.now(), sourceType: record?.sourceType ?? null, localPath: record?.localPath ?? null }].slice(-8),
    }
    writeStateFile(sourceRecordPath(cwd), JSON.stringify(rec, null, 1))
    return rec
  } catch { return null }
}

export function readSourceRecord(cwd = process.cwd()) {
  try {
    const j = JSON.parse(fs.readFileSync(sourceRecordPath(cwd), "utf8"))
    return j && typeof j === "object" ? j : null
  } catch { return null }
}

// ---------------------------------------------------------------------------
// THE resolver
// ---------------------------------------------------------------------------

function evidence(kind, detail) {
  return { kind, detail: String(detail).slice(0, 240) }
}

/**
 * Resolve what source the user means. `input` is the explicit source argument
 * (path / zip / https URL / git URL) or null (→ the current workspace).
 * Never contacts the network unless `input` is an explicit URL; NEVER searches
 * for a remote that "looks like" the task (§4: no GitHub bias).
 */
export function resolveSource(input, { cwd = process.cwd(), downloadUrl = null } = {}) {
  const base = path.resolve(cwd)
  const ev = []
  const raw = String(input ?? "").trim()

  // --- explicit local file / folder / zip -----------------------------------
  if (raw) {
    const p = path.resolve(base, raw)
    let st = null
    try { st = fs.statSync(p) } catch { /* fall through to URL/git handling */ }
    if (st?.isFile()) {
      const buf = fs.readFileSync(p)
      if (isZipFile(buf) || /\.zip$/i.test(p)) {
        const id = sha12(`${p}:${buf.length}:${crc32(buf.subarray(0, Math.min(buf.length, 1 << 20)))}`)
        ev.push(evidence("archive", `local zip ${p} (${buf.length} bytes, ${listProjectZipEntries(buf)?.entries.length ?? 0} entries)`))
        const inspect = inspectZipBuffer(buf)
        ev.push(evidence("detect", `root=${inspect.root || "(top)"} manifests=[${inspect.manifests.slice(0, 6).join(",")}] langs=[${Object.keys(inspect.languages).slice(0, 6).join(",")}] git=${inspect.git}`))
        const cwdIsGit = gitRemoteUrl(base) != null || fs.existsSync(path.join(base, ".git"))
        if (cwdIsGit) ev.push(evidence("conflict", `cwd ${base} is a git repo — the EXPLICIT local archive wins (user-selected source overrides workspace)`))
        return {
          sourceType: "archive", sourceId: id, localPath: null, archivePath: p,
          origin: `file://${p}`, authority: "explicit-local-archive",
          reason: "explicitly provided local ZIP archive — local-first ladder tier 3",
          evidence: ev, inspect, extract: { needed: true, buffer: () => buf, dest: path.join(SOURCES_DIR, id) },
          conflict: cwdIsGit ? { candidates: ["local-archive", "workspace-git"], winner: "local-archive", why: "explicit user selection" } : null,
        }
      }
      ev.push(evidence("file", `explicit local file ${p}`))
      return {
        sourceType: "file", sourceId: sha12(p), localPath: p, archivePath: null,
        origin: `file://${p}`, authority: "explicit-local-file",
        reason: "explicitly provided local file — local-first ladder tier 1",
        evidence: ev, inspect: null, extract: null, conflict: null,
      }
    }
    if (st?.isDirectory()) {
      const inspect = inspectProjectDir(p)
      ev.push(evidence("folder", `explicit local folder ${p} (${inspect.fileCount} files, manifests=[${inspect.manifests.slice(0, 6).join(",")}])`))
      const st2 = inspect.git ? "git-repo" : "folder"
      return {
        sourceType: st2, sourceId: sha12(p), localPath: p, archivePath: null,
        origin: inspect.gitRemote ?? `file://${p}`, authority: "explicit-local-folder",
        reason: `explicitly provided local folder — local-first ladder tier 2${inspect.git ? " (contains .git)" : ""}`,
        evidence: ev, inspect, extract: null, conflict: null,
      }
    }
    // --- explicit URL (https zip) or git remote -----------------------------
    if (/^https?:\/\//i.test(raw)) {
      if (/\.git$/i.test(raw) || /^https?:\/\/git@/i.test(raw)) {
        return {
          sourceType: "git-url", sourceId: sha12(raw), localPath: null, archivePath: null,
          origin: raw, authority: "explicit-git-url",
          reason: "explicitly provided git repository — local-first ladder tier 5 (shallow clone)",
          evidence: [...ev, evidence("git-url", raw)], inspect: null,
          extract: { needed: true, git: raw, dest: path.join(SOURCES_DIR, sha12(raw)) }, conflict: null,
        }
      }
      return {
        sourceType: "url", sourceId: sha12(raw), localPath: null, archivePath: null,
        origin: raw, authority: "explicit-url",
        reason: "explicitly provided https URL — local-first ladder tier 4 (download + inspect)",
        evidence: [...ev, evidence("url", raw)], inspect: null,
        extract: { needed: true, url: raw, dest: path.join(SOURCES_DIR, sha12(raw)) }, conflict: null,
      }
    }
    return {
      sourceType: "unresolved", sourceId: null, localPath: null, archivePath: null,
      origin: raw, authority: "none",
      reason: `input "${raw}" does not exist locally and is not a URL — refusing to guess (never fabricate a source)`,
      evidence: [...ev, evidence("miss", `stat failed for ${p}; not a URL`)], inspect: null, extract: null, conflict: null,
    }
  }

  // --- implicit: the current workspace -------------------------------------
  const inspect = inspectProjectDir(base)
  ev.push(evidence("workspace", `cwd ${base} (${inspect.fileCount} files, manifests=[${inspect.manifests.slice(0, 6).join(",")}])`))
  const st = inspect.git ? "git-repo" : "workspace"
  return {
    sourceType: st, sourceId: sha12(base), localPath: base, archivePath: null,
    origin: inspect.gitRemote ?? `file://${base}`,
    authority: inspect.git ? "current-git-workspace" : "current-workspace",
    reason: `no explicit source — the current workspace is authoritative for active local work (§4)${inspect.gitRemote ? `; git remote ${inspect.gitRemote} recorded as origin, NOT as authority` : ""}`,
    evidence: ev, inspect, extract: null, conflict: null,
  }
}

/** Inspect a zip buffer WITHOUT extracting: root, manifests, languages, tests, git. */
export function inspectZipBuffer(buf) {
  const listing = listProjectZipEntries(buf)
  if (!listing) return { ok: false, root: "", manifests: [], languages: {}, tests: 0, git: false, entries: 0, truncated: false }
  const root = identifyZipRoot(listing.entries)
  const rootPrefix = root ? root + "/" : ""
  const manifests = []
  const languages = {}
  let tests = 0
  let git = false
  for (const e of listing.entries) {
    const rel = e.name.startsWith(rootPrefix) ? e.name.slice(rootPrefix.length) : e.name
    if (rel.startsWith(".git/")) git = true
    const base = rel.split("/").pop()
    if (!rel.includes("/") && ROOT_MANIFESTS.some(([m]) => m === base)) manifests.push(base)
    const ext = path.extname(base).toLowerCase()
    const lang = LANG_BY_EXT[ext]
    if (lang) languages[lang] = (languages[lang] ?? 0) + 1
    if (/^(test|spec)_|[-.](test|spec)\./i.test(base)) tests++
  }
  return { ok: true, root, manifests, languages, tests, git, entries: listing.entries.length, truncated: listing.truncated }
}

/**
 * Materialize a resolved source: extract the archive / clone the repo /
 * download the URL into ~/.forge/sources/<id>/ and return the LOCAL project
 * directory. Idempotent — an existing extraction is REUSED and re-validated,
 * never blindly re-done (§49 zero waste). Never throws; returns { ok, error }.
 */
export async function materializeSource(res) {
  if (!res?.extract?.needed) return { ok: true, localPath: res?.localPath ?? null, reused: true }
  const dest = res.extract.dest
  try {
    if (res.extract.git) {
      if (fs.existsSync(path.join(dest, ".git"))) return { ok: true, localPath: dest, reused: true }
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      await execFileP("git", ["clone", "--depth", "1", "--single-branch", res.extract.git, dest], { timeout: GIT_CLONE_TIMEOUT_MS })
      return { ok: true, localPath: dest, reused: false }
    }
    if (res.extract.url) {
      await assertFetchableUrl(res.extract.url, { allowPrivate: false })
      if (fs.existsSync(dest) && fs.readdirSync(dest).length) return { ok: true, localPath: dest, reused: true }
      const buf = await pinnedFetch(res.extract.url, { maxBytes: MAX_URL_BYTES })
      if (!isZipFile(buf)) return { ok: false, error: "URL did not return a zip archive (PK header missing)" }
      const r = extractProjectZip(buf, dest)
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, localPath: dest, reused: false, files: r.files.length, root: r.root }
    }
    if (res.extract.buffer) {
      const buf = res.extract.buffer()
      const r = extractProjectZip(buf, dest)
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, localPath: dest, reused: false, files: r.files.length, root: r.root }
    }
    return { ok: false, error: "no materialization strategy for this source" }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 300) }
  }
}

/**
 * One-shot helper for CLI/chat/agent entry points: resolve `input` (or the
 * workspace), materialize when needed, persist the source record for the
 * FINAL local directory, and return { resolution, localPath, record }.
 * On an unresolvable input the result is { ok:false, error } — the caller
 * must stop, never proceed on a guessed source.
 */
export async function activateSource(input, { cwd = process.cwd() } = {}) {
  const res = resolveSource(input, { cwd })
  if (res.sourceType === "unresolved") return { ok: false, error: res.reason, resolution: res }
  const mat = await materializeSource(res)
  if (!mat.ok) return { ok: false, error: mat.error, resolution: res }
  const localPath = mat.localPath ?? res.localPath
  const record = saveSourceRecord(localPath, {
    sourceType: res.sourceType,
    sourceId: res.sourceId,
    localPath,
    archivePath: res.archivePath,
    origin: res.origin,
    authority: res.authority,
    reason: res.reason,
    evidence: res.evidence,
    conflict: res.conflict,
  })
  return { ok: true, resolution: res, localPath, record, reused: mat.reused === true }
}

/** Human-readable one-line summary of a resolution (CLI/banner). */
export function formatSource(res, { maxChars = 200 } = {}) {
  if (!res) return ""
  const bits = [`source: ${res.sourceType}`, res.localPath ? `local: ${res.localPath}` : null, res.archivePath ? `archive: ${res.archivePath}` : null, res.origin ? `origin: ${res.origin}` : null, `authority: ${res.authority}`]
  let s = bits.filter(Boolean).join(" • ")
  if (res.reason) s += `\n  why: ${res.reason}`
  return s.slice(0, maxChars * 2)
}

/**
 * Ensure the workspace has a source record (§4 persistence on the implicit
 * path too). Idempotent: an existing record is NEVER overwritten by an
 * implicit resolution — only explicit --source runs re-record authority.
 * Best-effort; returns the record or null.
 */
export function ensureWorkspaceSource(cwd = process.cwd()) {
  try {
    const existing = readSourceRecord(cwd)
    if (existing) return existing
    const res = resolveSource(null, { cwd })
    return saveSourceRecord(cwd, {
      sourceType: res.sourceType,
      sourceId: res.sourceId,
      localPath: res.localPath,
      archivePath: res.archivePath,
      origin: res.origin,
      authority: res.authority,
      reason: res.reason,
      evidence: res.evidence,
      conflict: res.conflict,
    })
  } catch { return null }
}
