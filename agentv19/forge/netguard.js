/**
 * forge — network guard (v21.1): SSRF protection with DNS PINNING for
 * model-controlled URL fetches.
 *
 * History
 *   v19   compared hostname STRINGS — trivially bypassed, blind to DNS.
 *   v20   resolved the host and validated every address … and then handed the
 *         URL to `fetch()`, which performed its OWN second DNS lookup and
 *         followed redirects on its own. Two holes remained:
 *           1. DNS rebinding: validate(public) → fetch re-resolves → private.
 *           2. Redirects: public URL → 302 → http://169.254.169.254/ (never
 *              re-validated).
 *         The IPv6 classifier was also string-based, so the hex form of an
 *         IPv4-mapped loopback (`[::ffff:7f00:1]`) was "public".
 *   v21.1 this module: the address that is VALIDATED is the address that is
 *         CONNECTED. `pinnedFetch()` resolves once, validates every record,
 *         and pins the socket to the validated set through a custom `lookup`
 *         that never touches DNS again. Every redirect hop is re-resolved,
 *         re-validated and re-pinned. IPv6 is parsed to bytes.
 *
 * Address policy (blocked):
 *   IPv4:  0.0.0.0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16 (link-local
 *          + cloud metadata), 172.16/12, 192.0.0/24, 192.0.2/24, 192.168/16,
 *          198.18/15, 198.51.100/24, 203.0.113/24, 224/4 (multicast), 240/4,
 *          255.255.255.255
 *   IPv6:  ::, ::1, ::ffff:a.b.c.d (IPv4-mapped, any encoding), ::a.b.c.d
 *          (IPv4-compatible), 64:ff9b::/96 (NAT64 — embedded v4 checked),
 *          64:ff9b:1::/48, 2002::/16 (6to4 — embedded v4 checked),
 *          2001::/32 (Teredo — embedded client v4 checked), 2001:db8::/32,
 *          2001:10::/28 (ORCHID), 100::/64 (discard), fc00::/7 (ULA),
 *          fe80::/10 (link-local), fec0::/10 (site-local), ff00::/8 (multicast)
 *   Names: metadata.google.internal, instance-data, metadata, and friends are
 *          refused before resolution too.
 *
 * Escape hatch for local setups (Ollama docs, SearXNG on localhost, tests):
 *   FORGE_ALLOW_PRIVATE_URLS=1  or  config tools.fetchPrivateUrls: true.
 *
 * NOTE: this guards MODEL-chosen URLs (fetch_url). Provider baseUrls are
 * user-configured and trusted — forge talks to whatever endpoint YOU set.
 *
 * Zero dependencies: node:dns, node:http, node:https, node:net only.
 */
import dns from "node:dns/promises"
import http from "node:http"
import https from "node:https"
import net from "node:net"

export const BLOCKED_HOSTNAMES = [/^metadata(\.google)?\.internal$/i, /^instance-data$/i, /^metadata\.azure\.com$/i, /^metadata$/i, /^localhost$/i, /(^|\.)localhost$/i, /\.internal$/i]

// ---------------------------------------------------------------------------
// address parsing — bytes, not strings
// ---------------------------------------------------------------------------

/** Parse dotted-quad IPv4 into 4 bytes, or null. */
export function parseIPv4(ip) {
  const m = String(ip ?? "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  if (parts.some((p) => p > 255)) return null
  return parts
}

/**
 * Parse an IPv6 literal (with or without brackets / zone id, with or without
 * an embedded dotted IPv4 tail) into 16 bytes, or null.
 */
export function parseIPv6(ip) {
  let s = String(ip ?? "").trim().replace(/^\[|\]$/g, "")
  const zone = s.indexOf("%")
  if (zone !== -1) s = s.slice(0, zone)
  if (!s.includes(":")) return null
  // embedded dotted IPv4 tail → two hex groups
  const lastColon = s.lastIndexOf(":")
  const tail = s.slice(lastColon + 1)
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail)
    if (!v4) return null
    s = s.slice(0, lastColon + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16)
  }
  const dbl = s.indexOf("::")
  if (dbl !== -1 && s.indexOf("::", dbl + 1) !== -1) return null // only one ::
  let head = [], rest = []
  if (dbl !== -1) {
    head = s.slice(0, dbl) ? s.slice(0, dbl).split(":") : []
    rest = s.slice(dbl + 2) ? s.slice(dbl + 2).split(":") : []
  } else {
    head = s.split(":")
  }
  const groups = [...head, ...rest]
  if (groups.length > 8) return null
  if (dbl === -1 && groups.length !== 8) return null
  if (!groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null
  const fill = 8 - groups.length
  const words = [...head.map((g) => parseInt(g, 16)), ...new Array(dbl !== -1 ? fill : 0).fill(0), ...rest.map((g) => parseInt(g, 16))]
  if (words.length !== 8) return null
  const bytes = []
  for (const w of words) bytes.push((w >> 8) & 0xff, w & 0xff)
  return bytes
}

function v4ToInt(b) {
  return ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3]
}

function inV4Range(bytes, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return ((v4ToInt(bytes) & mask) >>> 0) === ((v4ToInt(parseIPv4(base)) & mask) >>> 0)
}

const V4_RANGES = [
  ["0.0.0.0", 8, "this-network"], ["10.0.0.0", 8, "private"], ["100.64.0.0", 10, "carrier-grade NAT"],
  ["127.0.0.0", 8, "loopback"], ["169.254.0.0", 16, "link-local / cloud metadata"], ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "IETF protocol assignments"], ["192.0.2.0", 24, "documentation"], ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"], ["198.51.100.0", 24, "documentation"], ["203.0.113.0", 24, "documentation"],
  ["255.255.255.255", 32, "broadcast"], ["224.0.0.0", 4, "multicast"], ["240.0.0.0", 4, "reserved"],
]

/** Reason an IPv4 (bytes) is not a public unicast address, or null. */
function v4BlockReason(bytes) {
  for (const [base, bits, why] of V4_RANGES) if (inV4Range(bytes, base, bits)) return why
  return null
}

function prefixMatches(bytes, prefixBytes, bits) {
  let i = 0
  for (; bits >= 8; bits -= 8, i++) if (bytes[i] !== prefixBytes[i]) return false
  if (bits > 0) {
    const mask = (0xff << (8 - bits)) & 0xff
    if ((bytes[i] & mask) !== (prefixBytes[i] & mask)) return false
  }
  return true
}

const P = (s) => parseIPv6(s)
const V6_RULES = [
  { prefix: P("::"), bits: 128, why: "unspecified" },
  { prefix: P("::1"), bits: 128, why: "loopback" },
  { prefix: P("::ffff:0:0"), bits: 96, embedded: 12, why: "IPv4-mapped" },
  { prefix: P("::"), bits: 96, embedded: 12, why: "IPv4-compatible" },
  { prefix: P("64:ff9b::"), bits: 96, embedded: 12, why: "NAT64" },
  { prefix: P("64:ff9b:1::"), bits: 48, why: "local-use NAT64" },
  { prefix: P("2002::"), bits: 16, embedded: 2, why: "6to4" },
  { prefix: P("2001::"), bits: 32, teredo: true, why: "Teredo" },
  { prefix: P("2001:db8::"), bits: 32, why: "documentation" },
  { prefix: P("2001:10::"), bits: 28, why: "ORCHID" },
  { prefix: P("100::"), bits: 64, why: "discard-only" },
  { prefix: P("fc00::"), bits: 7, why: "unique-local" },
  { prefix: P("fe80::"), bits: 10, why: "link-local" },
  { prefix: P("fec0::"), bits: 10, why: "site-local" },
  { prefix: P("ff00::"), bits: 8, why: "multicast" },
]

/** Reason an IPv6 (bytes) is not a public unicast address, or null. */
function v6BlockReason(bytes) {
  for (const r of V6_RULES) {
    if (!prefixMatches(bytes, r.prefix, r.bits)) continue
    if (r.embedded !== undefined) {
      // transition addresses carry an IPv4 — judge the IPv4
      const v4 = bytes.slice(r.embedded, r.embedded + 4)
      const why = v4BlockReason(v4)
      return why ? `${r.why} of ${why} address ${v4.join(".")}` : null
    }
    if (r.teredo) {
      // Teredo: client IPv4 is the bitwise NOT of the last 32 bits
      const v4 = bytes.slice(12, 16).map((b) => (~b) & 0xff)
      const why = v4BlockReason(v4)
      return why ? `Teredo of ${why} address ${v4.join(".")}` : null
    }
    return r.why
  }
  return null
}

/**
 * Why is this address NOT a public unicast address? Returns a short reason,
 * or null when the address may be connected to. Unparseable input is
 * refused (fail closed).
 */
export function blockedAddressReason(ip) {
  if (ip === undefined || ip === null || ip === "") return "empty address"
  const raw = String(ip).trim()
  const v4 = parseIPv4(raw)
  if (v4) return v4BlockReason(v4)
  const v6 = parseIPv6(raw)
  if (v6) return v6BlockReason(v6)
  return `unparseable address "${raw.slice(0, 40)}"`
}

/** Is this a private/loopback/link-local/reserved/undocumented address? */
export function isPrivateAddress(ip) {
  return blockedAddressReason(ip) !== null
}

// ---------------------------------------------------------------------------
// resolution + validation
// ---------------------------------------------------------------------------

function literalIp(host) {
  if (parseIPv4(host)) return host
  if (host.includes(":")) return host.replace(/^\[|\]$/g, "")
  return null
}

async function defaultResolver(host) {
  const addrs = await dns.lookup(host, { all: true, verbatim: true })
  return addrs.map((a) => ({ address: a.address, family: a.family }))
}

function parseTarget(url) {
  let u
  try {
    u = new URL(String(url))
  } catch {
    return { error: "malformed URL" }
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  // v20.0.1: `new URL("http://")` parses but yields an empty hostname
  if (!host) return { error: "malformed URL (no host)" }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: `unsupported protocol ${u.protocol} (only http/https)` }
  if (u.username || u.password) return { error: "credentials in URL are not allowed" }
  return { url: u, host }
}

/**
 * Resolve a URL to the addresses a connection may be pinned to.
 * Returns { ok: true, host, port, protocol, addresses:[{address,family}] }
 * or { ok: false, reason }. Never throws.
 *
 * opts.allowPrivate  skip the address policy (user opt-in for local stacks)
 * opts.resolver      (host) => Promise<[{address,family}]>   (tests inject)
 * opts.policy        (ip) => reason|null                      (tests inject)
 */
export async function resolvePinnedTarget(url, opts = {}) {
  const t = parseTarget(url)
  if (t.error) return { ok: false, reason: t.error }
  const { url: u, host } = t
  const policy = typeof opts.policy === "function" ? opts.policy : blockedAddressReason
  const allowPrivate = opts.allowPrivate === true
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80
  if (!allowPrivate) {
    for (const re of BLOCKED_HOSTNAMES) {
      if (re.test(host)) return { ok: false, reason: `hostname "${host}" is a local or cloud metadata name` }
    }
  }
  const lit = literalIp(host)
  let addresses
  if (lit) {
    const why = allowPrivate ? null : policy(lit)
    if (why) return { ok: false, reason: `address ${lit} is private/loopback/reserved (${why})` }
    addresses = [{ address: lit, family: parseIPv4(lit) ? 4 : 6 }]
  } else {
    const resolver = typeof opts.resolver === "function" ? opts.resolver : defaultResolver
    let resolved
    try {
      resolved = await resolver(host)
    } catch {
      return { ok: false, reason: `cannot resolve "${host}" (offline or NXDOMAIN)` }
    }
    addresses = (Array.isArray(resolved) ? resolved : [])
      .map((a) => (typeof a === "string" ? { address: a } : a))
      .filter((a) => a && a.address)
      .map((a) => ({ address: String(a.address), family: a.family === 6 || (!a.family && !parseIPv4(a.address)) ? 6 : 4 }))
    if (!addresses.length) return { ok: false, reason: `"${host}" resolves to nothing` }
    if (!allowPrivate) {
      // EVERY record must pass — a name that maps to one public and one
      // private address is refused outright (mixed-record rebinding).
      for (const a of addresses) {
        const why = policy(a.address)
        if (why) return { ok: false, reason: `"${host}" resolves to a private/loopback/reserved address (${a.address}: ${why})` }
      }
    }
  }
  return { ok: true, host, port, protocol: u.protocol, addresses, url: u }
}

/**
 * Validate a URL the model wants to fetch (compatibility API — the pinned
 * fetch below is what actually enforces the boundary at connect time).
 * @returns {ok: true, addresses} or {ok: false, reason}. Never throws.
 */
export async function assertFetchableUrl(url, opts = {}) {
  if (opts.allowPrivate) {
    const t = parseTarget(url)
    return t.error ? { ok: false, reason: t.error } : { ok: true }
  }
  const r = await resolvePinnedTarget(url, opts)
  return r.ok ? { ok: true, addresses: r.addresses } : { ok: false, reason: r.reason }
}

// ---------------------------------------------------------------------------
// pinned fetch — validated destination === connected destination
// ---------------------------------------------------------------------------

export class PinnedFetchError extends Error {
  constructor(message, { code = "EFETCH", blocked = false, url = null, hop = 0 } = {}) {
    super(message)
    this.name = "PinnedFetchError"
    this.code = code
    this.blocked = blocked
    this.url = url
    this.hop = hop
  }
}

/** A `lookup` implementation that returns ONLY the pre-validated addresses. */
function pinnedLookup(addresses, onLookup) {
  return (hostname, options, cb) => {
    if (typeof options === "function") { cb = options; options = {} }
    onLookup?.(hostname)
    if (options && options.all) return cb(null, addresses.map((a) => ({ address: a.address, family: a.family })))
    const first = addresses[0]
    cb(null, first.address, first.family)
  }
}

function isConnError(e) {
  return /^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EPIPE|EAI_AGAIN)$/.test(String(e?.code ?? ""))
}

/**
 * One HTTP(S) request pinned to `target.addresses`. Resolves with
 * { status, headers, body, address } — body capped at maxBytes.
 */
function requestPinned(target, { method, headers, timeoutMs, maxBytes, tls, signal, onSocket, onLookup, hop }) {
  return new Promise((resolve, reject) => {
    const u = target.url
    const allowed = new Set(target.addresses.map((a) => a.address.toLowerCase()))
    const isHttps = u.protocol === "https:"
    const mod = isHttps ? https : http
    const reqOpts = {
      protocol: u.protocol,
      host: target.host, // Host header + SNI derive from the NAME, not the pinned IP
      port: target.port,
      path: `${u.pathname}${u.search}`,
      method,
      headers,
      agent: false, // no pooled sockets: a pooled socket could predate validation
      lookup: pinnedLookup(target.addresses, onLookup),
      timeout: timeoutMs,
      ...(isHttps ? { servername: net.isIP(target.host) ? undefined : target.host, ...tls } : {}),
    }
    let settled = false
    const done = (fn, v) => { if (!settled) { settled = true; fn(v) } }
    const req = mod.request(reqOpts)
    const deadline = setTimeout(() => { req.destroy(new PinnedFetchError(`timeout after ${timeoutMs}ms`, { code: "ETIMEDOUT", url: u.href, hop })) }, timeoutMs)
    const onAbort = () => req.destroy(new PinnedFetchError("cancelled", { code: "ABORT_ERR", url: u.href, hop }))
    if (signal) {
      if (signal.aborted) { clearTimeout(deadline); return done(reject, new PinnedFetchError("cancelled", { code: "ABORT_ERR", url: u.href, hop })) }
      signal.addEventListener("abort", onAbort, { once: true })
    }
    const cleanup = () => { clearTimeout(deadline); signal?.removeEventListener("abort", onAbort) }
    req.on("socket", (socket) => {
      // Post-connect assertion: the kernel-level peer MUST be one of the
      // validated addresses. This cannot be reached through pinnedLookup, but
      // it turns any future regression into a hard failure instead of a leak.
      const check = () => {
        const ra = String(socket.remoteAddress ?? "").toLowerCase().replace(/^::ffff:/, "")
        const ok = allowed.has(ra) || allowed.has(`::ffff:${ra}`) || [...allowed].some((a) => a.replace(/^::ffff:/, "") === ra)
        onSocket?.({ remoteAddress: socket.remoteAddress, ok })
        if (!ok) socket.destroy(new PinnedFetchError(`connected to unvalidated address ${socket.remoteAddress}`, { code: "EPINVIOLATION", blocked: true, url: u.href, hop }))
      }
      if (socket.remoteAddress) check()
      else socket.once("connect", check)
      socket.on("timeout", () => req.destroy(new PinnedFetchError(`socket idle timeout after ${timeoutMs}ms`, { code: "ETIMEDOUT", url: u.href, hop })))
    })
    req.on("error", (e) => { cleanup(); done(reject, e) })
    req.on("response", (res) => {
      const chunks = []
      let size = 0
      res.on("data", (c) => {
        size += c.length
        if (size > maxBytes) {
          res.destroy()
          cleanup()
          return done(reject, new PinnedFetchError(`response too large (> ${Math.round(maxBytes / 1024)}KB)`, { code: "ETOOLARGE", url: u.href, hop }))
        }
        chunks.push(c)
      })
      res.on("error", (e) => { cleanup(); done(reject, e) })
      res.on("end", () => {
        cleanup()
        done(resolve, { status: res.statusCode ?? 0, statusText: res.statusMessage ?? "", headers: res.headers, body: Buffer.concat(chunks), address: res.socket?.remoteAddress ?? null })
      })
    })
    req.end()
  })
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])

/**
 * Fetch a model-chosen URL with the destination pinned to validated
 * addresses on EVERY hop.
 *
 * opts: method, headers, timeoutMs (per hop, default 15000), totalTimeoutMs
 *       (whole chain, default 30000), maxRedirects (default 5), maxBytes
 *       (default 2 MB), allowPrivate, resolver, policy, tls, signal,
 *       onSocket({remoteAddress, ok}), onLookup(hostname), retries (default 1
 *       — connection errors retry against the SAME pinned set, never a fresh
 *       resolution).
 *
 * Resolves { ok, status, statusText, headers, body:Buffer, url, hops:[{url,
 * address, status}] }. Throws PinnedFetchError (blocked=true when a policy
 * refused a hop).
 */
export async function pinnedFetch(url, opts = {}) {
  const {
    method = "GET", headers = {}, timeoutMs = 15000, totalTimeoutMs = 30000, maxRedirects = 5,
    maxBytes = 2 * 1024 * 1024, allowPrivate = false, resolver, policy, tls = {}, signal,
    onSocket, onLookup, retries = 1,
  } = opts
  const started = Date.now()
  const hops = []
  let current = String(url)
  let curMethod = String(method).toUpperCase()
  for (let hop = 0; hop <= maxRedirects; hop++) {
    // allowPrivate: true → every hop may be private (user opted in for this URL
    // class); "first-hop" → only the ORIGIN the user configured may be private,
    // anything it redirects to is held to the public-only rule (a LAN search
    // endpoint must not be able to bounce us to a metadata address)
    const hopAllowsPrivate = allowPrivate === true || (allowPrivate === "first-hop" && hop === 0)
    const target = await resolvePinnedTarget(current, { allowPrivate: hopAllowsPrivate, resolver, policy })
    if (!target.ok) throw new PinnedFetchError(target.reason, { code: "EBLOCKED", blocked: true, url: current, hop })
    const remaining = totalTimeoutMs - (Date.now() - started)
    if (remaining <= 0) throw new PinnedFetchError(`timeout after ${totalTimeoutMs}ms`, { code: "ETIMEDOUT", url: current, hop })
    const hopHeaders = { ...headers, host: target.port === (target.protocol === "https:" ? 443 : 80) ? target.host : `${target.host}:${target.port}` }
    let res
    for (let attempt = 0; ; attempt++) {
      try {
        res = await requestPinned(target, { method: curMethod, headers: hopHeaders, timeoutMs: Math.min(timeoutMs, remaining), maxBytes, tls, signal, onSocket, onLookup, hop })
        break
      } catch (e) {
        if (attempt < retries && isConnError(e) && !signal?.aborted) continue // same pinned set
        throw e
      }
    }
    hops.push({ url: current, address: res.address, status: res.status })
    if (REDIRECT_CODES.has(res.status) && res.headers.location) {
      if (hop === maxRedirects) throw new PinnedFetchError(`too many redirects (> ${maxRedirects})`, { code: "EREDIRECTS", url: current, hop })
      let next
      try {
        next = new URL(String(res.headers.location), current).href
      } catch {
        throw new PinnedFetchError(`invalid redirect location`, { code: "EREDIRECT", url: current, hop })
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && curMethod !== "GET" && curMethod !== "HEAD")) curMethod = "GET"
      current = next
      continue // next hop is resolved, validated and pinned from scratch
    }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, statusText: res.statusText, headers: res.headers, body: res.body, url: current, hops }
  }
  throw new PinnedFetchError(`too many redirects (> ${maxRedirects})`, { code: "EREDIRECTS", url: current, hop: maxRedirects })
}
