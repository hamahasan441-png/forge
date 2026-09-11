/**
 * forge — vision / multimodal helpers (v30, zero dependencies)
 *
 * Raster images only (png / jpeg / gif / webp). No SVG (XML, can carry
 * script). Local files only — never fetch a URL (SSRF). Magic-byte detect,
 * never trust the extension. When the provider cannot accept image parts
 * we return metadata only and never dump pixels or invent a description.
 *
 * Image parts are OpenAI-shaped on the internal wire
 *   { type: "image_url", image_url: { url: "data:image/png;base64,…" } }
 * and converted to Anthropic `{ type: "image", source: { type: "base64", … } }`
 * by toAnthropicContent / providers.toAnthropicMessages.
 *
 * Pending attachments live on the tool context (`ctx._pendingVision`), not
 * in the tool-result string (execTool stays a string). The agent/chat loop
 * injects one user message after the tool batch.
 */
import fs from "node:fs"
import { lookupRegistry } from "./modelregistry.js"

/** Raw-byte cap. Base64 is ~4/3, so 768 KiB stays near 1 MiB on the wire. */
export const MAX_IMAGE_BYTES = 768 * 1024
/** Images attached in a single tool batch. The rest stay metadata-only. */
export const MAX_PENDING = 4
/** How many vision user-messages survive compaction. Older parts are stubbed. */
export const KEEP_VISION = 1

export const MIME = Object.freeze({
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
})

const RASTER = new Set(Object.values(MIME))

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

/**
 * Sniff a buffer. Returns { kind, mime } or { kind:"svg", rejected:true }
 * or null. Extension is ignored.
 */
export function detectImage(buf) {
  if (!buf || buf.length < 8) return null
  const b0 = buf[0], b1 = buf[1], b2 = buf[2], b3 = buf[3]
  if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) return { kind: "png", mime: MIME.png }
  if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return { kind: "jpeg", mime: MIME.jpeg }
  if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46 && b3 === 0x38) return { kind: "gif", mime: MIME.gif }
  if (buf.length >= 12 && b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return { kind: "webp", mime: MIME.webp }
  }
  const head = buf.subarray(0, Math.min(256, buf.length)).toString("utf8").replace(/^\uFEFF/, "").trimStart()
  if (/^<svg\b/i.test(head) || (/^<\?xml/i.test(head) && /<svg\b/i.test(head))) {
    return { kind: "svg", mime: "image/svg+xml", rejected: true }
  }
  return null
}

export function imageDimensions(buf, mime) {
  if (!buf || buf.length < 10) return null
  const m = mime || detectImage(buf)?.mime
  try {
    if (m === MIME.png) return pngSize(buf)
    if (m === MIME.jpeg) return jpegSize(buf)
    if (m === MIME.gif) return gifSize(buf)
    if (m === MIME.webp) return webpSize(buf)
  } catch { /* truncated / hostile header */ }
  return null
}

function pngSize(buf) {
  if (buf.length < 24) return null
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (!width || !height || width > 1e7 || height > 1e7) return null
  return { width, height }
}

function gifSize(buf) {
  if (buf.length < 10) return null
  const width = buf.readUInt16LE(6)
  const height = buf.readUInt16LE(8)
  if (!width || !height) return null
  return { width, height }
}

function jpegSize(buf) {
  let i = 2
  while (i + 8 < buf.length) {
    if (buf[i] !== 0xff) return null
    const marker = buf[i + 1]
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    if (marker === 0x00 || marker === 0xff) { i += 1; continue }
    const len = buf.readUInt16BE(i + 2)
    if (len < 2) return null
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      const height = buf.readUInt16BE(i + 5)
      const width = buf.readUInt16BE(i + 7)
      if (!width || !height) return null
      return { width, height }
    }
    i += 2 + len
  }
  return null
}

function webpSize(buf) {
  if (buf.length < 30) return null
  const tag = buf.toString("ascii", 12, 16)
  if (tag === "VP8X") {
    const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16)
    const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16)
    if (!width || !height) return null
    return { width, height }
  }
  if (tag === "VP8 " && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
    const width = buf.readUInt16LE(26) & 0x3fff
    const height = buf.readUInt16LE(28) & 0x3fff
    if (!width || !height) return null
    return { width, height }
  }
  if (tag === "VP8L" && buf[20] === 0x2f) {
    const bits = buf[21] | (buf[22] << 8) | (buf[23] << 16) | (buf[24] << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

// ---------------------------------------------------------------------------
// load (local files, bounded read)
// ---------------------------------------------------------------------------

function isRemotePath(p) {
  const s = String(p ?? "").trim()
  return /^(https?|file|ftp|data):/i.test(s)
}

/**
 * Read a local raster image. Does not follow a URL. Does not slurp a file
 * larger than maxBytes (header only, for dimensions). `buf` is null when
 * the file is too big — callers must not invent pixels.
 */
export function loadLocalImage(abs, { maxBytes = MAX_IMAGE_BYTES } = {}) {
  if (isRemotePath(abs)) return { ok: false, error: "ERROR: read_image is local files only (no remote fetch)" }
  if (!abs) return { ok: false, error: "ERROR: empty path" }
  let stat
  try { stat = fs.statSync(abs) } catch {
    return { ok: false, error: `ERROR: not found: ${abs}` }
  }
  if (stat.isDirectory()) return { ok: false, error: `ERROR: is a directory: ${abs}` }
  if (stat.size === 0) return { ok: false, error: "ERROR: empty file" }

  const sniffLen = Math.min(64, stat.size)
  const sniff = Buffer.alloc(sniffLen)
  const fd = fs.openSync(abs, "r")
  try { fs.readSync(fd, sniff, 0, sniffLen, 0) } finally { try { fs.closeSync(fd) } catch {} }

  const det = detectImage(sniff)
  if (!det) return { ok: false, error: `ERROR: not a png/jpeg/gif/webp image: ${abs}` }
  if (det.rejected || det.kind === "svg") {
    return { ok: false, error: "ERROR: svg is not a raster image (read_image refuses SVG)" }
  }

  const tooBig = stat.size > maxBytes
  let buf = null
  if (!tooBig) {
    buf = fs.readFileSync(abs)
  } else {
    const header = Buffer.alloc(Math.min(stat.size, 65536))
    const fd2 = fs.openSync(abs, "r")
    try { fs.readSync(fd2, header, 0, header.length, 0) } finally { try { fs.closeSync(fd2) } catch {} }
    buf = header // dimensions only; discarded below
  }
  const det2 = detectImage(buf) || det
  if (det2.rejected || det2.kind === "svg") {
    return { ok: false, error: "ERROR: svg is not a raster image (read_image refuses SVG)" }
  }
  const dim = imageDimensions(buf, det2.mime)
  return {
    ok: true,
    abs,
    mime: det2.mime,
    kind: det2.kind,
    bytes: stat.size,
    width: dim?.width ?? null,
    height: dim?.height ?? null,
    tooBig,
    buf: tooBig ? null : buf,
  }
}

export function formatImageToolResult(rec, extra = {}) {
  const size = rec.width && rec.height ? `${rec.width}×${rec.height}` : null
  const bits = [`image ${rec.kind || rec.mime}`, size, `${rec.bytes} bytes`, rec.abs].filter(Boolean)
  let s = bits.join(" • ")
  if (extra.attached) s += "\nattached: yes (image part queued for the next model turn)"
  else s += `\nattached: no — ${extra.reason || "not attached"}`
  return s
}

// ---------------------------------------------------------------------------
// parts
// ---------------------------------------------------------------------------

export function openaiImagePart(rec) {
  if (!rec?.buf || !rec.mime || !RASTER.has(rec.mime)) return null
  return { type: "image_url", image_url: { url: `data:${rec.mime};base64,${rec.buf.toString("base64")}` } }
}

export function anthropicImagePart(rec) {
  if (!rec?.buf || !rec.mime || !RASTER.has(rec.mime)) return null
  return { type: "image", source: { type: "base64", media_type: rec.mime, data: rec.buf.toString("base64") } }
}

/** Parse a data:image/…;base64,… URL. Remote http(s) returns null. */
export function parseDataUrl(url) {
  const s = String(url ?? "")
  if (!s.startsWith("data:")) return null
  const sep = s.indexOf(";base64,")
  if (sep < 0) return null
  const mime = s.slice(5, sep).toLowerCase()
  if (!RASTER.has(mime)) return null
  const data = s.slice(sep + 8)
  if (!data) return null
  return { mime, data }
}

/**
 * Convert internal (OpenAI-shaped) content to Anthropic blocks.
 * Strings pass through. Remote image_url → a text stub (never fetched).
 */
export function toAnthropicContent(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return String(content ?? "")
  const blocks = []
  for (const part of content) {
    if (!part) continue
    if (typeof part === "string") {
      if (part) blocks.push({ type: "text", text: part })
      continue
    }
    if (part.type === "text") {
      if (part.text) blocks.push({ type: "text", text: String(part.text) })
      continue
    }
    if (part.type === "image" && part.source?.type === "base64") {
      const mime = String(part.source.media_type || "").toLowerCase()
      if (RASTER.has(mime) && part.source.data) {
        blocks.push({ type: "image", source: { type: "base64", media_type: mime, data: String(part.source.data) } })
      } else {
        blocks.push({ type: "text", text: "[image omitted: unsupported media type]" })
      }
      continue
    }
    if (part.type === "image_url") {
      const url = String(part.image_url?.url ?? part.image_url ?? "")
      const parsed = parseDataUrl(url)
      if (parsed) {
        blocks.push({ type: "image", source: { type: "base64", media_type: parsed.mime, data: parsed.data } })
      } else {
        blocks.push({ type: "text", text: "[image omitted: remote or non-data URL refused]" })
      }
      continue
    }
    // already-anthropic blocks (tool_use / tool_result / thinking) pass through
    if (part.type === "tool_use" || part.type === "tool_result" || part.type === "thinking") {
      blocks.push(part)
    }
  }
  return blocks
}

// ---------------------------------------------------------------------------
// capability heuristic — fail closed (unknown = no vision)
// ---------------------------------------------------------------------------

const VISION_NAME = /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|gpt-5|claude-|gemini-|grok-2-vision|grok-4|pixtral|qwen[-.]?vl|llava|bakllava|moondream|minicpm-v|llama.*vision|\bvision\b/i
const OLLAMA_VISION = /llava|bakllava|vision|moondream|minicpm-v|qwen[-.]?vl|pixtral/i

export function providerSupportsVision(p = {}) {
  if (p && p.vision === true) return true
  if (p && p.vision === false) return false
  const model = String(p.model ?? "")
  const protocol = String(p.protocol ?? "").toLowerCase()
  const baseUrl = String(p.baseUrl ?? "").toLowerCase()
  const entry = lookupRegistry(model)
  if (entry?.capabilities?.includes("vision")) return true
  if (/ollama|:11434\b/.test(baseUrl)) return OLLAMA_VISION.test(model)
  if (VISION_NAME.test(model)) return true
  if (protocol === "anthropic" && /claude/i.test(model)) return true
  return false
}

// ---------------------------------------------------------------------------
// pending queue on the tool context
// ---------------------------------------------------------------------------

export function queuePendingVision(ctx, rec) {
  if (!ctx || !rec?.buf) return false
  if (!Array.isArray(ctx._pendingVision)) ctx._pendingVision = []
  if (ctx._pendingVision.length >= MAX_PENDING) return false
  ctx._pendingVision.push({
    mime: rec.mime,
    kind: rec.kind,
    bytes: rec.bytes,
    width: rec.width,
    height: rec.height,
    abs: rec.abs,
    buf: rec.buf,
  })
  return true
}

export function drainPendingVision(ctx) {
  const pending = Array.isArray(ctx?._pendingVision) ? ctx._pendingVision.splice(0) : []
  return pending
}

export function visionUserMessage(pending, { capable = true } = {}) {
  if (!pending?.length) return null
  if (!capable) return null
  const parts = []
  const names = []
  for (const rec of pending) {
    const part = openaiImagePart(rec)
    if (!part) continue
    names.push(`${rec.kind}${rec.width && rec.height ? ` ${rec.width}×${rec.height}` : ""} ${rec.bytes}B`)
    parts.push(part)
  }
  if (!parts.length) return null
  parts.unshift({ type: "text", text: `(vision) attached ${parts.length} local image(s): ${names.join("; ")}. Describe what you actually see; do not invent pixels.` })
  return { role: "user", content: parts }
}

/** Drain ctx._pendingVision and push a user image message when capable. */
export function injectPendingVision(messages, ctx) {
  const pending = drainPendingVision(ctx)
  if (!pending.length) return messages
  const capable = ctx?.vision !== false && providerSupportsVision(ctx?.visionProvider)
  const msg = visionUserMessage(pending, { capable })
  if (msg) messages.push(msg)
  return messages
}

// ---------------------------------------------------------------------------
// compaction — drop old base64 so it cannot explode the context
// ---------------------------------------------------------------------------

export function contentHasVision(content) {
  if (!Array.isArray(content)) return false
  return content.some((p) => p && (p.type === "image_url" || p.type === "image"))
}

export function stubVisionPart(part) {
  if (part?.type === "image_url") {
    const url = String(part.image_url?.url ?? "")
    const parsed = parseDataUrl(url)
    const bytes = parsed ? Math.round(parsed.data.length * 3 / 4) : 0
    return { type: "text", text: `[image stripped: ${parsed?.mime || "image"} ~${bytes} bytes]` }
  }
  if (part?.type === "image") {
    const mime = part.source?.media_type || "image"
    const n = String(part.source?.data || "").length
    return { type: "text", text: `[image stripped: ${mime} ~${Math.round(n * 3 / 4)} bytes]` }
  }
  return part
}

/**
 * Replace image parts on all but the last `keep` vision messages with a
 * short text stub. Returns the same array reference when nothing changed.
 */
export function stripOldVisionParts(messages, { keep = KEEP_VISION } = {}) {
  if (!Array.isArray(messages) || !messages.length) return messages
  const idx = []
  for (let i = 0; i < messages.length; i++) {
    if (contentHasVision(messages[i]?.content)) idx.push(i)
  }
  if (idx.length <= keep) return messages
  const keepSet = new Set(idx.slice(-keep))
  let changed = false
  const out = messages.map((m, i) => {
    if (keepSet.has(i) || !contentHasVision(m.content)) return m
    changed = true
    return { ...m, content: m.content.map(stubVisionPart) }
  })
  return changed ? out : messages
}

export { isRemotePath }
