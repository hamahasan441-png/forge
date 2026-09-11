/**
 * forge — ZIP / folder skill ingest (v79, zero dependencies)
 *
 * Extract SKILL.md only. Never unpack binaries, never ~/.forge/tools,
 * never follow `..`. Result is CANDIDATE — DOWNLOAD ≠ TRUST.
 */
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"

const MAX_MD = 64 * 1024

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

export function extractSkillMdFromZip(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
  if (b.length < 30 || b[0] !== 0x50 || b[1] !== 0x4b) return { ok: false, error: "not a zip" }
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
    if (name.includes("..") || name.startsWith("/")) continue
    const base = name.split("/").filter(Boolean).pop()
    if (base !== "SKILL.md") continue
    if (uncomp > MAX_MD) return { ok: false, error: "SKILL.md too large" }
    let textBuf
    if (method === 0) textBuf = data
    else if (method === 8) {
      try { textBuf = zlib.inflateRawSync(data) } catch { return { ok: false, error: "zip inflate failed" } }
    } else return { ok: false, error: `unsupported zip method ${method}` }
    const text = textBuf.toString("utf8")
    if (!text.trim()) return { ok: false, error: "empty SKILL.md" }
    return { ok: true, text, name }
  }
  return { ok: false, error: "no SKILL.md in zip" }
}

export function readSkillFromFolder(dir) {
  const root = path.join(dir, "SKILL.md")
  try {
    if (fs.existsSync(root) && fs.statSync(root).isFile()) {
      const t = fs.readFileSync(root, "utf8")
      if (t.trim()) return { ok: true, text: t, path: root }
    }
  } catch { /* next */ }
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return { ok: false, error: "unreadable folder" } }
  for (const e of ents) {
    if (!e.isDirectory() || e.name === "." || e.name === ".." || e.name.startsWith(".")) continue
    const p = path.join(dir, e.name, "SKILL.md")
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const t = fs.readFileSync(p, "utf8")
        if (t.trim()) return { ok: true, text: t, path: p }
      }
    } catch { /* next */ }
  }
  return { ok: false, error: "no SKILL.md in folder" }
}

export function isZipBuffer(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)
}
