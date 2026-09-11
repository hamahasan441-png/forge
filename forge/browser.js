/**
 * forge — optional browser tool (v31, zero dependencies)
 *
 * PLAN-v24 Tier 2 item 4: drive and verify real UIs. Opt-in binary
 * (chromium / chrome / agent-browser). Missing binary → UNAVAILABLE, never
 * a crash and never a fake browser. Same lesson as sandbox.js.
 *
 * Backends, first match:
 *   1. injected driver (tests) — ctx._browserDriver
 *   2. agent-browser CLI if on PATH (or FORGE_BROWSER points at it)
 *   3. CDP against chromium/chrome (Node net WebSocket, no npm dep)
 *
 * Safety:
 *   - http(s) URLs go through assertFetchableUrl (SSRF / DNS pin)
 *   - file:// only via a path checker the caller supplies (safePath)
 *   - javascript: / data: / blob: / vbscript: refused
 *   - tools.browser false → UNAVAILABLE
 *   - FORGE_BROWSER=0 disables discovery
 *   - screenshot bytes never land in the tool-result string
 */
import { execFile, spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { assertFetchableUrl } from "./netguard.js"
import { queuePendingVision, providerSupportsVision, MAX_IMAGE_BYTES, MAX_PENDING, MIME } from "./vision.js"

export const ACTIONS = Object.freeze([
  "open", "snapshot", "click", "fill", "type", "press",
  "screenshot", "scroll", "back", "reload", "close", "status",
])
export const VERIFY_ACTIONS = Object.freeze(["open", "snapshot", "screenshot", "status", "close", "reload", "back"])
export const PAGE_MUTATING = Object.freeze(["click", "fill", "type", "press", "scroll"])

const CHROME_NAMES = [
  "chromium", "chromium-browser", "google-chrome", "google-chrome-stable",
  "chrome", "msedge", "microsoft-edge",
]
const AGENT_NAMES = ["agent-browser"]

const PNG_1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da63000000020001e221bc330000000049454e44ae426082",
  "hex",
)

function exists(p) {
  try { return !!p && fs.existsSync(p) } catch { return false }
}

function which(name) {
  const pathEnv = process.env.PATH || ""
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    const cand = path.join(dir, name)
    try {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand
    } catch {}
  }
  return null
}

function basenameOf(p) {
  return String(p || "").split(/[/\\]/).pop().toLowerCase()
}

function looksLikeAgent(p) {
  return /agent-browser/.test(basenameOf(p))
}

function looksLikeChrome(p) {
  const n = basenameOf(p)
  return CHROME_NAMES.some((c) => n === c || n.replace(/\.exe$/, "") === c) || /chrom|msedge/.test(n)
}

/** Resolve the browser binary, or null. Never throws. */
export function findBrowserBinary() {
  const off = process.env.FORGE_BROWSER
  if (off === "0" || off === "false" || off === "off") return null
  if (process.env.FORGE_BROWSER && off !== "1" && off !== "true" && off !== "on") {
    return exists(process.env.FORGE_BROWSER) ? process.env.FORGE_BROWSER : null
  }
  for (const n of AGENT_NAMES) {
    const p = which(n)
    if (p) return p
  }
  for (const n of CHROME_NAMES) {
    const p = which(n)
    if (p) return p
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  if (process.platform === "darwin" && exists(mac)) return mac
  return null
}

/**
 * @returns {{ available: boolean, kind: "cdp"|"agent-browser"|"none", binary: string|null, hint: string }}
 * `opts.binary` injects a path (tests). Pass `null` to force unavailable.
 */
export function detectBrowser(opts = {}) {
  const binary = Object.prototype.hasOwnProperty.call(opts, "binary")
    ? (opts.binary || null)
    : findBrowserBinary()
  if (!binary) {
    return {
      available: false, kind: "none", binary: null,
      hint: "install chromium or agent-browser, or set FORGE_BROWSER",
    }
  }
  if (looksLikeAgent(binary)) return { available: true, kind: "agent-browser", binary, hint: "agent-browser CLI" }
  if (looksLikeChrome(binary) || exists(binary)) return { available: true, kind: "cdp", binary, hint: "chromium CDP" }
  return { available: false, kind: "none", binary: null, hint: "binary not executable" }
}

export function isPageMutating(action) {
  return PAGE_MUTATING.includes(String(action || "").toLowerCase())
}

export function isVerifyAction(action) {
  return VERIFY_ACTIONS.includes(String(action || "").toLowerCase())
}

/** Screenshot-with-path is a filesystem write; everything else is the page. */
export function browserMutatesFilesystem(args = {}) {
  const action = String(args.action || "").toLowerCase()
  if (action !== "screenshot") return false
  return !!String(args.path || "").trim()
}

/**
 * Classify a navigation target. Never fetches. file:// uses checkPath
 * (safePath) so .env / outside-project stays blocked.
 */
export async function validateTarget(raw, ctx = {}) {
  const url = String(raw ?? "").trim()
  if (!url) return { ok: false, error: "ERROR: url is required for action=open" }
  const lower = url.toLowerCase()
  if (/^(javascript|data|blob|vbscript):/i.test(lower)) {
    return { ok: false, error: `ERROR: ${lower.split(":")[0]}: URLs are refused` }
  }
  if (lower === "about:blank" || lower.startsWith("about:blank")) return { ok: true, url: "about:blank", kind: "about" }
  if (lower.startsWith("file:")) {
    let filePath = url.replace(/^file:\/\//i, "")
    try { filePath = decodeURIComponent(filePath) } catch { /* keep */ }
    if (process.platform === "win32" && /^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1)
    if (typeof ctx.checkPath === "function") {
      const sp = ctx.checkPath(filePath, { write: false })
      if (!sp?.ok) return { ok: false, error: sp?.error || "BLOCKED: file:// path refused" }
      return { ok: true, url: `file://${sp.abs}`, kind: "file", abs: sp.abs }
    }
    const root = path.resolve(ctx.root || ctx.cwd || process.cwd())
    const abs = path.resolve(root, filePath)
    const rel = path.relative(root, abs)
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return { ok: false, error: "BLOCKED: file:// target escapes the project directory" }
    }
    return { ok: true, url: `file://${abs}`, kind: "file", abs }
  }
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "ERROR: only http(s), file:// inside the project, or about:blank" }
  let host = ""
  try { host = new URL(url).hostname } catch { return { ok: false, error: "ERROR: malformed URL" } }
  const pinned = await assertFetchableUrl(url, { allowPrivate: !!ctx.fetchPrivateUrls })
  if (!pinned.ok) {
    return { ok: false, error: `BLOCKED (SSRF guard): ${pinned.reason}. If this is an intentional local UI, set tools.fetchPrivateUrls: true or FORGE_ALLOW_PRIVATE_URLS=1.` }
  }
  return { ok: true, url, kind: "http", host }
}

export function sanitizeRef(ref) {
  const s = String(ref ?? "").trim()
  if (!s) return { error: "ref or selector is required" }
  if (/^@?e\d{1,4}$/i.test(s)) return { kind: "ref", id: s.replace(/^@/, "").toLowerCase() }
  if (s.length > 240) return { error: "selector too long" }
  if (/[\n\r<>\\]/.test(s)) return { error: "selector has forbidden characters" }
  return { kind: "css", selector: s }
}

function formatNodes(nodes) {
  const list = Array.isArray(nodes) ? nodes.slice(0, 80) : []
  if (!list.length) return "(no interactive nodes)"
  return list.map((n) => {
    const ref = n.ref || n.id || "?"
    const tag = n.tag || n.role || "node"
    const text = String(n.text || n.name || "").replace(/\s+/g, " ").slice(0, 80)
    const extra = n.href ? ` href=${n.href}` : ""
    return `  ${ref}  <${tag}>${text ? " " + text : ""}${extra}`
  }).join("\n")
}

function formatResult(kind, payload) {
  const bits = [`browser ${kind}`]
  if (payload.url) bits.push(payload.url)
  if (payload.title) bits.push(`title: ${payload.title}`)
  let s = bits.join(" • ")
  if (payload.nodes) s += "\n" + formatNodes(payload.nodes)
  if (payload.note) s += "\n" + payload.note
  if (payload.closed) s += "\nclosed"
  if (payload.clicked) s += `\nclicked ${payload.clicked}`
  if (payload.filled) s += `\nfilled ${payload.filled}`
  if (payload.typed) s += `\ntyped ${String(payload.typed).length} chars`
  if (payload.pressed) s += `\npressed ${payload.pressed}`
  if (payload.screenshot) s += `\nscreenshot: ${payload.screenshot}`
  return s
}

export function createMockDriver(state = {}) {
  const st = state
  if (!st.nodes) st.nodes = [{ ref: "@e1", tag: "button", text: "Submit" }, { ref: "@e2", tag: "input", text: "" }]
  return {
    kind: "mock",
    async open(url) {
      st.url = url
      st.title = st.title || "mock"
      return { url: st.url, title: st.title, nodes: st.nodes }
    },
    async snapshot() {
      if (!st.url) return { error: "no open page" }
      return { url: st.url, title: st.title || "mock", nodes: st.nodes }
    },
    async click(ref) { st.lastClick = ref; return { clicked: ref, url: st.url } },
    async fill(ref, text) { st.lastFill = { ref, text }; return { filled: ref, url: st.url } },
    async type(text) { st.lastType = text; return { typed: text, url: st.url } },
    async press(key) { st.lastKey = key; return { pressed: key, url: st.url } },
    async scroll(amount) { st.lastScroll = amount; return { url: st.url, note: `scrolled ${amount}` } },
    async back() { return { url: st.url, note: "back" } },
    async reload() { return { url: st.url, title: st.title, nodes: st.nodes } },
    async screenshot() {
      return { mime: MIME.png, buf: PNG_1x1, width: 1, height: 1, bytes: PNG_1x1.length, kind: "png" }
    },
    async status() { return { url: st.url || null, title: st.title || null, open: !!st.url, kind: "mock" } },
    async close() { st.url = null; st.closed = true; return { closed: true } },
  }
}

function execFileText(file, args, { timeoutMs = 15000, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout || "")
      const errText = String(stderr || "")
      if (err) resolve({ ok: false, error: (errText || err.message || "exec failed").slice(0, 240), stdout: out, stderr: errText })
      else resolve({ ok: true, stdout: out, stderr: errText })
    })
  })
}

function createAgentDriver(binary) {
  return {
    kind: "agent-browser",
    binary,
    async open(url) {
      const r = await execFileText(binary, ["open", url])
      if (!r.ok) return { error: r.error }
      return { url, note: (r.stdout || "").trim().slice(0, 400) }
    },
    async snapshot() {
      const r = await execFileText(binary, ["snapshot", "-i"])
      if (!r.ok) return { error: r.error }
      return { note: (r.stdout || "").trim().slice(0, 24000) }
    },
    async click(ref) {
      const r = await execFileText(binary, ["click", ref.startsWith("@") ? ref : "@" + ref])
      if (!r.ok) return { error: r.error }
      return { clicked: ref }
    },
    async fill(ref, text) {
      const r = await execFileText(binary, ["fill", ref.startsWith("@") ? ref : "@" + ref, text])
      if (!r.ok) return { error: r.error }
      return { filled: ref }
    },
    async type(text) {
      const r = await execFileText(binary, ["type", String(text)])
      if (!r.ok) return { error: r.error }
      return { typed: text }
    },
    async press(key) {
      const r = await execFileText(binary, ["press", String(key)])
      if (!r.ok) return { error: r.error }
      return { pressed: key }
    },
    async scroll(amount) {
      const r = await execFileText(binary, ["scroll", "down", String(amount ?? 500)])
      if (!r.ok) return { error: r.error }
      return { note: `scrolled ${amount ?? 500}` }
    },
    async back() {
      const r = await execFileText(binary, ["back"])
      if (!r.ok) return { error: r.error }
      return { note: "back" }
    },
    async reload() {
      const r = await execFileText(binary, ["reload"])
      if (!r.ok) return { error: r.error }
      return { note: "reloaded" }
    },
    async screenshot() {
      const tmp = path.join(os.tmpdir(), `forge-browser-${process.pid}-${Date.now()}.png`)
      const r = await execFileText(binary, ["screenshot", tmp])
      if (!r.ok) return { error: r.error }
      try {
        const buf = fs.readFileSync(tmp)
        try { fs.unlinkSync(tmp) } catch {}
        if (!buf.length) return { error: "empty screenshot" }
        return { mime: MIME.png, buf, bytes: buf.length, kind: "png" }
      } catch (e) {
        return { error: String(e?.message ?? e).slice(0, 160) }
      }
    },
    async status() {
      const url = await execFileText(binary, ["get", "url"])
      const title = await execFileText(binary, ["get", "title"])
      return { url: (url.stdout || "").trim() || null, title: (title.stdout || "").trim() || null, open: url.ok, kind: "agent-browser" }
    },
    async close() {
      await execFileText(binary, ["close"], { timeoutMs: 5000 })
      return { closed: true }
    },
  }
}

// ---------------------------------------------------------------------------
// tiny client-masked WebSocket (CDP). Zero deps, Node 18+.
// ---------------------------------------------------------------------------

function connectWs(wsUrl, { timeoutMs = 8000 } = {}) {
  const u = new URL(wsUrl)
  return new Promise((resolve, reject) => {
    const port = Number(u.port) || (u.protocol === "wss:" ? 443 : 80)
    const sock = net.connect({ host: u.hostname, port })
    const key = crypto.randomBytes(16).toString("base64")
    const timer = setTimeout(() => { try { sock.destroy() } catch {}; reject(new Error("ws connect timeout")) }, timeoutMs)
    let buf = Buffer.alloc(0)
    let open = false
    const pending = new Map()
    const events = new Map()
    let nextId = 1

    function sendFrame(payload, opcode = 1) {
      const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
      const mask = crypto.randomBytes(4)
      const masked = Buffer.alloc(data.length)
      for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4]
      let h
      if (data.length < 126) {
        h = Buffer.alloc(6)
        h[0] = 0x80 | opcode
        h[1] = 0x80 | data.length
        mask.copy(h, 2)
      } else if (data.length < 65536) {
        h = Buffer.alloc(8)
        h[0] = 0x80 | opcode
        h[1] = 0x80 | 126
        h.writeUInt16BE(data.length, 2)
        mask.copy(h, 4)
      } else {
        h = Buffer.alloc(14)
        h[0] = 0x80 | opcode
        h[1] = 0x80 | 127
        h.writeUInt32BE(0, 2)
        h.writeUInt32BE(data.length, 6)
        mask.copy(h, 10)
      }
      sock.write(Buffer.concat([h, masked]))
    }

    function onMessage(text) {
      let msg
      try { msg = JSON.parse(text) } catch { return }
      if (msg.id != null && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        clearTimeout(p.t)
        if (msg.error) p.rej(new Error(msg.error.message || JSON.stringify(msg.error)))
        else p.res(msg.result ?? msg)
        return
      }
      if (msg.method && events.has(msg.method)) {
        for (const fn of events.get(msg.method)) try { fn(msg.params || {}) } catch {}
      }
    }

    function decodeFrames() {
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f
        const isMasked = (buf[1] & 0x80) !== 0
        let len = buf[1] & 0x7f
        let off = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          off = 4
        } else if (len === 127) {
          if (buf.length < 10) return
          const hi = buf.readUInt32BE(2)
          const lo = buf.readUInt32BE(6)
          if (hi !== 0) return
          len = lo
          off = 10
        }
        const need = off + (isMasked ? 4 : 0) + len
        if (buf.length < need) return
        let maskKey = null
        if (isMasked) {
          maskKey = buf.subarray(off, off + 4)
          off += 4
        }
        const payload = Buffer.from(buf.subarray(off, off + len))
        buf = buf.subarray(off + len)
        if (maskKey) {
          for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]
        }
        if (opcode === 8) { try { sock.destroy() } catch {}; return }
        if (opcode === 9) { sendFrame(payload, 10); continue }
        if (opcode === 1 || opcode === 2) onMessage(payload.toString("utf8"))
      }
    }

    sock.on("connect", () => {
      const resource = `${u.pathname}${u.search || ""}` || "/"
      sock.write(
        `GET ${resource} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`,
      )
    })
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (!open) {
        const idx = buf.indexOf("\r\n\r\n")
        if (idx < 0) return
        const head = buf.subarray(0, idx).toString("utf8")
        buf = buf.subarray(idx + 4)
        if (!/^HTTP\/1\.\d 101/i.test(head)) {
          clearTimeout(timer)
          try { sock.destroy() } catch {}
          reject(new Error("ws upgrade failed: " + head.split("\r\n")[0]))
          return
        }
        open = true
        clearTimeout(timer)
        resolve({
          send(method, params = {}, sessionId) {
            const id = nextId++
            const msg = { id, method, params }
            if (sessionId) msg.sessionId = sessionId
            sendFrame(JSON.stringify(msg))
            return new Promise((res, rej) => {
              const t = setTimeout(() => { pending.delete(id); rej(new Error(`cdp timeout ${method}`)) }, 20000)
              pending.set(id, { res, rej, t })
            })
          },
          on(method, fn) {
            if (!events.has(method)) events.set(method, [])
            events.get(method).push(fn)
          },
          close() {
            try { sendFrame(Buffer.alloc(0), 8) } catch {}
            try { sock.destroy() } catch {}
          },
        })
        if (buf.length) decodeFrames()
        return
      }
      decodeFrames()
    })
    sock.on("error", (e) => { clearTimeout(timer); reject(e) })
    sock.on("close", () => {
      for (const p of pending.values()) { clearTimeout(p.t); p.rej(new Error("ws closed")) }
      pending.clear()
    })
  })
}

const SNAPSHOT_JS = `(() => {
  const sel = 'a,button,input,textarea,select,[role="button"],[contenteditable="true"]';
  const els = [...document.querySelectorAll(sel)].slice(0, 80);
  return els.map((el, i) => {
    const id = 'e' + (i + 1);
    el.setAttribute('data-forge-ref', id);
    const text = String(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    return { ref: '@' + id, tag: el.tagName.toLowerCase(), text, href: el.href || null };
  });
})()`

async function createCdpDriver(binary) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "forge-browser-"))
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--mute-audio",
    "--hide-scrollbars",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=1280,720",
    "about:blank",
  ]
  if (process.getuid && process.getuid() === 0) args.splice(1, 0, "--no-sandbox")
  if (process.env.PREFIX || process.env.TERMUX_VERSION) args.splice(1, 0, "--no-sandbox")

  const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] })
  let stderr = ""
  const wsUrl = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("chromium did not print DevTools URL")), 12000)
    const onData = (chunk) => {
      stderr += chunk.toString("utf8")
      const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (m) { clearTimeout(t); resolve(m[1].trim()) }
    }
    child.stderr.on("data", onData)
    child.on("error", (e) => { clearTimeout(t); reject(e) })
    child.on("exit", (code) => {
      clearTimeout(t)
      reject(new Error(`chromium exited ${code}: ${stderr.slice(0, 200)}`))
    })
  })

  const ws = await connectWs(wsUrl)
  const created = await ws.send("Target.createTarget", { url: "about:blank" })
  const targetId = created.targetId
  const attached = await ws.send("Target.attachToTarget", { targetId, flatten: true })
  const sessionId = attached.sessionId
  const send = (method, params = {}) => ws.send(method, params, sessionId)
  await send("Page.enable")
  await send("Runtime.enable")

  async function evaluate(expression) {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
    if (r?.exceptionDetails) return { error: r.exceptionDetails.text || "evaluate failed" }
    return r?.result?.value
  }

  return {
    kind: "cdp",
    binary,
    child,
    profile,
    async open(url) {
      await send("Page.navigate", { url })
      await new Promise((r) => setTimeout(r, 400))
      const title = await evaluate("document.title")
      const href = await evaluate("location.href")
      const nodes = await evaluate(SNAPSHOT_JS)
      return { url: href || url, title: title || "", nodes: Array.isArray(nodes) ? nodes : [] }
    },
    async snapshot() {
      const title = await evaluate("document.title")
      const href = await evaluate("location.href")
      const nodes = await evaluate(SNAPSHOT_JS)
      return { url: href, title, nodes: Array.isArray(nodes) ? nodes : [] }
    },
    async click(ref) {
      const info = sanitizeRef(ref)
      if (info.error) return { error: info.error }
      const sel = info.kind === "ref" ? `[data-forge-ref="${info.id}"]` : info.selector
      const r = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return { ok: false }; el.click(); return { ok: true, tag: el.tagName }; })()`)
      if (!r || r.ok === false) return { error: `no element ${ref}` }
      return { clicked: ref }
    },
    async fill(ref, text) {
      const info = sanitizeRef(ref)
      if (info.error) return { error: info.error }
      const sel = info.kind === "ref" ? `[data-forge-ref="${info.id}"]` : info.selector
      const payload = JSON.stringify(String(text ?? ""))
      const r = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return { ok: false }; el.focus(); el.value = ${payload}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }; })()`)
      if (!r || r.ok === false) return { error: `no element ${ref}` }
      return { filled: ref }
    },
    async type(text) {
      await evaluate(`document.execCommand && document.execCommand('insertText', false, ${JSON.stringify(String(text ?? ""))})`)
      return { typed: text }
    },
    async press(key) {
      await evaluate(`document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(String(key ?? ""))}, bubbles: true }))`)
      return { pressed: key }
    },
    async scroll(amount) {
      await evaluate(`window.scrollBy(0, ${Number(amount) || 500})`)
      return { note: `scrolled ${amount || 500}` }
    },
    async back() { await evaluate("history.back()"); return { note: "back" } },
    async reload() { await send("Page.reload", {}); return { note: "reloaded" } },
    async screenshot() {
      const r = await send("Page.captureScreenshot", { format: "png" })
      const b64 = r?.data
      if (!b64) return { error: "no screenshot data" }
      const buf = Buffer.from(b64, "base64")
      if (buf.length > MAX_IMAGE_BYTES) {
        return { mime: MIME.png, buf: null, bytes: buf.length, kind: "png", tooBig: true }
      }
      return { mime: MIME.png, buf, bytes: buf.length, kind: "png" }
    },
    async status() {
      const href = await evaluate("location.href").catch(() => null)
      const title = await evaluate("document.title").catch(() => null)
      return { url: href, title, open: true, kind: "cdp" }
    },
    async close() {
      try { ws.close() } catch {}
      try { child.kill("SIGTERM") } catch {}
      setTimeout(() => { try { child.kill("SIGKILL") } catch {} }, 1500)
      try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
      return { closed: true }
    },
  }
}

async function launchDriver(det) {
  if (det.kind === "agent-browser") return createAgentDriver(det.binary)
  if (det.kind === "cdp") return createCdpDriver(det.binary)
  throw new Error("no driver for " + det.kind)
}

function detectFromCtx(ctx) {
  return ctx && ctx.browserBinary !== undefined
    ? detectBrowser({ binary: ctx.browserBinary })
    : detectBrowser()
}

async function ensureSession(ctx) {
  if (ctx._browser?.driver) return { ok: true, driver: ctx._browser.driver, kind: ctx._browser.kind }
  if (ctx._browserDriver) {
    ctx._browser = { driver: ctx._browserDriver, kind: ctx._browserDriver.kind || "mock" }
    return { ok: true, driver: ctx._browserDriver, kind: ctx._browser.kind }
  }
  const det = detectFromCtx(ctx)
  if (!det.available) {
    return { ok: false, error: `UNAVAILABLE: no browser binary (${det.hint}). The turn continues without a browser.` }
  }
  try {
    const driver = await launchDriver(det)
    ctx._browser = { driver, kind: det.kind, binary: det.binary }
    return { ok: true, driver, kind: det.kind }
  } catch (e) {
    return { ok: false, error: `UNAVAILABLE: browser failed to start (${String(e?.message ?? e).slice(0, 180)})` }
  }
}

function attachScreenshot(ctx, rec) {
  if (!rec?.buf) return { attached: false, reason: rec?.tooBig ? `too large to attach (cap ${MAX_IMAGE_BYTES} bytes)` : "no pixels" }
  const visionOn = ctx.vision !== false
  const capable = visionOn && providerSupportsVision(ctx.visionProvider)
  if (!visionOn) return { attached: false, reason: "tools.vision is false (metadata only)" }
  if (!capable) return { attached: false, reason: "provider/model does not accept image parts (metadata only — never fake vision)" }
  if ((ctx._pendingVision?.length ?? 0) >= MAX_PENDING) return { attached: false, reason: `pending vision cap (${MAX_PENDING} per turn)` }
  if (queuePendingVision(ctx, rec)) return { attached: true, reason: "" }
  return { attached: false, reason: "could not queue image part" }
}

/**
 * Run one browser action against ctx. Result is always a string.
 * Does not throw.
 */
export async function runBrowser(ctx, args = {}) {
  try {
    const action = String(args.action || args.command || "").trim().toLowerCase()
    if (!action) return `ERROR: action is required. Use: ${ACTIONS.join(", ")}`
    if (!ACTIONS.includes(action)) return `ERROR: unknown browser action "${action}". Use: ${ACTIONS.join(", ")}`
    if (ctx.browser === false) return "UNAVAILABLE: tools.browser is false (disabled in config)"

    if (action === "status" && !ctx._browser && !ctx._browserDriver) {
      const det = detectFromCtx(ctx)
      if (!det.available) return `UNAVAILABLE: no browser binary (${det.hint}). The turn continues without a browser.`
      return `browser idle • ${det.kind} • ${det.binary}`
    }

    if (action === "close") {
      const r = await closeBrowserSession(ctx)
      return r || "browser closed"
    }

    const sess = await ensureSession(ctx)
    if (!sess.ok) return sess.error
    const driver = sess.driver

    if (action === "open") {
      const checked = await validateTarget(args.url, ctx)
      if (!checked.ok) return checked.error
      const r = await driver.open(checked.url)
      if (r?.error) return `ERROR: open failed: ${r.error}`
      return formatResult("open", r)
    }

    if (action === "snapshot") {
      const r = await driver.snapshot()
      if (r?.error) return `ERROR: snapshot failed: ${r.error}`
      if (r.note && !r.nodes) return `browser snapshot\n${r.note}`.slice(0, 24000)
      return formatResult("snapshot", r)
    }

    if (action === "click") {
      const ref = String(args.ref || args.selector || "").trim()
      const info = sanitizeRef(ref)
      if (info.error) return `ERROR: ${info.error}`
      const r = await driver.click(info.kind === "ref" ? "@" + info.id : info.selector)
      if (r?.error) return `ERROR: click failed: ${r.error}`
      return formatResult("click", r)
    }

    if (action === "fill") {
      const ref = String(args.ref || args.selector || "").trim()
      const info = sanitizeRef(ref)
      if (info.error) return `ERROR: ${info.error}`
      const r = await driver.fill(info.kind === "ref" ? "@" + info.id : info.selector, String(args.text ?? args.value ?? ""))
      if (r?.error) return `ERROR: fill failed: ${r.error}`
      return formatResult("fill", r)
    }

    if (action === "type") {
      const r = await driver.type(String(args.text ?? args.value ?? ""))
      if (r?.error) return `ERROR: type failed: ${r.error}`
      return formatResult("type", r)
    }

    if (action === "press") {
      const key = String(args.key || args.text || "").trim()
      if (!key) return "ERROR: key is required"
      const r = await driver.press(key)
      if (r?.error) return `ERROR: press failed: ${r.error}`
      return formatResult("press", r)
    }

    if (action === "scroll") {
      const r = await driver.scroll(args.amount ?? 500)
      if (r?.error) return `ERROR: scroll failed: ${r.error}`
      return formatResult("scroll", r)
    }

    if (action === "back") {
      const r = await driver.back()
      if (r?.error) return `ERROR: back failed: ${r.error}`
      return formatResult("back", r)
    }

    if (action === "reload") {
      const r = await driver.reload()
      if (r?.error) return `ERROR: reload failed: ${r.error}`
      return formatResult("reload", r)
    }

    if (action === "screenshot") {
      const r = await driver.screenshot()
      if (r?.error) return `ERROR: screenshot failed: ${r.error}`
      const rec = {
        mime: r.mime || MIME.png,
        buf: r.buf || null,
        bytes: r.bytes || r.buf?.length || 0,
        kind: r.kind || "png",
        width: r.width ?? null,
        height: r.height ?? null,
        abs: null,
        tooBig: !!r.tooBig,
      }
      const vis = attachScreenshot(ctx, rec)
      let note = vis.attached
        ? "attached: yes (image part queued for the next model turn)"
        : `attached: no — ${vis.reason}`
      if (args.path && rec.buf && typeof ctx.writeScreenshot === "function") {
        const wrote = ctx.writeScreenshot(String(args.path), rec.buf)
        if (wrote?.ok) note += `\nsaved ${wrote.abs}`
        else if (wrote?.error) return wrote.error
      } else if (args.path && !rec.buf) {
        note += "\n(not saved — no pixels)"
      }
      return formatResult("screenshot", { screenshot: `${rec.bytes} bytes ${rec.kind}`, note })
    }

    if (action === "status") {
      const r = await driver.status()
      if (r?.error) return `ERROR: status failed: ${r.error}`
      return formatResult("status", r)
    }

    return `ERROR: unhandled action "${action}"`
  } catch (e) {
    return `ERROR: browser failed: ${String(e?.message ?? e).slice(0, 200)}`
  }
}

export async function closeBrowserSession(ctx) {
  const s = ctx?._browser
  if (!s) return "browser idle (nothing to close)"
  ctx._browser = null
  try { await s.driver.close() } catch {}
  return "browser closed"
}
