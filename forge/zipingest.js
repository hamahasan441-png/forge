/**
 * forge — ZIP / folder skill ingest (v82, zero dependencies)
 *
 * SKILL.md required. scripts/, examples/, references/ unpacked as text.
 * Never binaries, never ~/.forge/tools, never `..`, never +x.
 * Result is CANDIDATE — DOWNLOAD ≠ TRUST.
 */
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"

const MAX_MD = 64 * 1024
export const MAX_SUPPORT_FILE = 32 * 1024
export const MAX_SUPPORT_FILES = 32
export const SUPPORT_DIRS = Object.freeze(["scripts", "examples", "references"])
const ALLOW_EXT = /\.(md|txt|json|js|mjs|cjs|ts|sh|py|ya?ml|toml|html|css|svg)$/i
const KERNEL_HINT = /assumeYes|plugin-host|classifyTaskComplexity|allowNewPlugins/
const DENY_BASE = /^(plugin-host\.js|forge\.js|agent\.js)$/i

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf) {
  let c = 0xFFFFFFFF
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function u16(n) {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n >>> 0, 0)
  return b
}
function u32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0, 0)
  return b
}

/** Store-method zip (no compression). Test + ingest helper. */
export function makeStoreZip(files = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(String(body || ""), "utf8")
    const n = Buffer.from(String(name).replace(/\\/g, "/"), "utf8")
    const crc = crc32(data)
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(n.length), u16(0), n, data,
    ])
    const central = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(n.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
      n,
    ])
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0), u16(0), u16(centrals.length), u16(centrals.length),
    u32(cd.length), u32(offset), u16(0),
  ])
  return Buffer.concat([...locals, cd, eocd])
}

function decodeEntry(method, data, uncomp) {
  if (uncomp > MAX_MD && uncomp > MAX_SUPPORT_FILE) return { ok: false, error: "entry too large" }
  let textBuf
  if (method === 0) textBuf = data
  else if (method === 8) {
    try { textBuf = zlib.inflateRawSync(data) } catch { return { ok: false, error: "zip inflate failed" } }
  } else return { ok: false, error: `unsupported zip method ${method}` }
  return { ok: true, buf: textBuf }
}

/** Parse local-file entries. Directories skipped. */
export function listZipEntries(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
  if (b.length < 30 || b[0] !== 0x50 || b[1] !== 0x4b) return { ok: false, error: "not a zip" }
  const files = []
  let i = 0
  while (i + 30 <= b.length) {
    if (!(b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x03 && b[i + 3] === 0x04)) { i++; continue }
    const method = b.readUInt16LE(i + 8)
    const comp = b.readUInt32LE(i + 18)
    const uncomp = b.readUInt32LE(i + 22)
    const nlen = b.readUInt16LE(i + 26)
    const elen = b.readUInt16LE(i + 28)
    const nameStart = i + 30
    if (nameStart + nlen + elen + comp > b.length) return { ok: false, error: "truncated zip" }
    const name = b.slice(nameStart, nameStart + nlen).toString("utf8").replace(/\\/g, "/")
    const start = nameStart + nlen + elen
    const data = b.slice(start, start + comp)
    i = start + comp
    if (!name || name.endsWith("/")) continue
    if (name.includes("..") || name.startsWith("/") || name.includes("\0")) continue
    const got = decodeEntry(method, data, uncomp)
    if (!got.ok) return got
    files.push({ name, buf: got.buf })
  }
  if (!files.length) return { ok: false, error: "empty zip" }
  return { ok: true, files }
}

function stripCommonRoot(name, root) {
  if (!root) return name
  if (name === root || name.startsWith(root + "/")) return name.slice(root.length + (name === root ? 0 : 1))
  return name
}

function commonRoot(names) {
  const first = names.map((n) => n.split("/").filter(Boolean)[0]).filter(Boolean)
  if (first.length < 2) return ""
  const cand = first[0]
  if (!first.every((x) => x === cand)) return ""
  if (!names.every((n) => n === cand || n.startsWith(cand + "/"))) return ""
  if (names.some((n) => n.split("/").filter(Boolean).pop() === "SKILL.md" && n.split("/").filter(Boolean).length === 1)) return ""
  return cand
}

export function safeSupportRel(name) {
  const n = String(name || "").replace(/\\/g, "/").replace(/^\/+/, "")
  if (!n || n.includes("..") || n.includes("\0") || n.startsWith("/") || n.startsWith("~")) return null
  const parts = n.split("/").filter(Boolean)
  if (parts.length < 2) return null
  if (!SUPPORT_DIRS.includes(parts[0])) return null
  if (parts.some((p) => p.startsWith(".") || p === "~")) return null
  const rel = parts.join("/")
  if (!ALLOW_EXT.test(rel)) return null
  if (DENY_BASE.test(parts[parts.length - 1])) return null
  if (rel.length > 180) return null
  return rel
}

export function extractSkillMdFromZip(buf) {
  const pack = extractZipPack(buf)
  if (!pack.ok) return pack
  return { ok: true, text: pack.text, name: pack.skillName }
}

/**
 * SKILL.md + allowlisted support files. Binaries / traversal / tools skipped.
 */
export function extractZipPack(buf) {
  const listed = listZipEntries(buf)
  if (!listed.ok) return listed
  const skills = listed.files.filter((f) => {
    const base = f.name.split("/").filter(Boolean).pop()
    return base === "SKILL.md"
  }).sort((a, b) => a.name.split("/").length - b.name.split("/").length || a.name.localeCompare(b.name))
  if (!skills.length) return { ok: false, error: "no SKILL.md in zip" }
  const skillFile = skills[0]
  if (skillFile.buf.length > MAX_MD) return { ok: false, error: "SKILL.md too large" }
  if (skillFile.buf.includes(0)) return { ok: false, error: "SKILL.md is binary" }
  const text = skillFile.buf.toString("utf8")
  if (!text.trim()) return { ok: false, error: "empty SKILL.md" }
  const prefix = (() => {
    const i = skillFile.name.lastIndexOf("/")
    return i < 0 ? "" : skillFile.name.slice(0, i)
  })()
  const extra = []
  for (const f of listed.files) {
    if (f === skillFile) continue
    let rel0 = f.name
    if (prefix && (rel0 === prefix || rel0.startsWith(prefix + "/"))) {
      rel0 = rel0.slice(prefix.length + (rel0 === prefix ? 0 : 1))
    }
    const rel = safeSupportRel(rel0)
    if (!rel) continue
    if (f.buf.length > MAX_SUPPORT_FILE) continue
    if (f.buf.includes(0)) continue
    const body = f.buf.toString("utf8")
    if (!body.trim() || KERNEL_HINT.test(body)) continue
    extra.push({ name: rel, text: body })
    if (extra.length >= MAX_SUPPORT_FILES) break
  }
  return { ok: true, text, skillName: skillFile.name, files: extra }
}

export function readSupportFromFolder(dir) {
  const root = path.resolve(dir)
  const out = []
  for (const top of SUPPORT_DIRS) {
    const base = path.join(root, top)
    walkSupport(base, top, out, 0)
    if (out.length >= MAX_SUPPORT_FILES) break
  }
  return out
}

function walkSupport(abs, rel, out, depth) {
  if (out.length >= MAX_SUPPORT_FILES || depth > 3) return
  let ents = []
  try { ents = fs.readdirSync(abs, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (out.length >= MAX_SUPPORT_FILES) return
    if (e.name.startsWith(".") || e.name === ".." ) continue
    const nextAbs = path.join(abs, e.name)
    const nextRel = `${rel}/${e.name}`
    if (e.isDirectory()) { walkSupport(nextAbs, nextRel, out, depth + 1); continue }
    if (!e.isFile()) continue
    const safe = safeSupportRel(nextRel)
    if (!safe) continue
    let buf
    try { buf = fs.readFileSync(nextAbs) } catch { continue }
    if (buf.length > MAX_SUPPORT_FILE || buf.includes(0)) continue
    const text = buf.toString("utf8")
    if (!text.trim() || KERNEL_HINT.test(text)) continue
    out.push({ name: safe, text })
  }
}

export function readSkillFromFolder(dir) {
  const root = path.join(dir, "SKILL.md")
  try {
    if (fs.existsSync(root) && fs.statSync(root).isFile()) {
      const t = fs.readFileSync(root, "utf8")
      if (t.trim()) return { ok: true, text: t, path: root, folder: dir, files: readSupportFromFolder(dir) }
    }
  } catch { /* next */ }
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return { ok: false, error: "unreadable folder" } }
  for (const e of ents) {
    if (!e.isDirectory() || e.name === "." || e.name === ".." || e.name.startsWith(".")) continue
    const nested = path.join(dir, e.name)
    const p = path.join(nested, "SKILL.md")
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const t = fs.readFileSync(p, "utf8")
        if (t.trim()) return { ok: true, text: t, path: p, folder: nested, files: readSupportFromFolder(nested) }
      }
    } catch { /* next */ }
  }
  return { ok: false, error: "no SKILL.md in folder" }
}

export function isZipBuffer(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)
}
