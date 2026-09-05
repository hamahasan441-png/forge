/**
 * forge — network guard (v20): SSRF protection for model-controlled URL fetches.
 *
 * The v19 check compared hostname STRINGS (169.254. prefix + a few names) —
 * trivially bypassed and blind to DNS. This module resolves the host like the
 * fetch would and validates EVERY returned address:
 *
 *   IPv4:  0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10 (CGNAT), 127.0.0.0/8,
 *          169.254.0.0/16 (link-local + cloud metadata), 172.16.0.0/12,
 *          192.168.0.0/16, 192.0.2.0/24, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4
 *   IPv6:  ::1, ::, fc00::/7 (ULA), fe80::/10 (link-local),
 *          ::ffff:<any private IPv4> (IPv4-mapped)
 *   Names: metadata.google.internal, instance-data, and friends are blocked
 *          before resolution too.
 *
 * DNS-rebinding: after resolution each address is checked — a hostname that
 * resolves to a public IP FIRST and a private IP later still fails, because we
 * validate every record of the lookup.
 *
 * Escape hatch for local setups (Ollama docs, SearXNG on localhost, tests):
 *   FORGE_ALLOW_PRIVATE_URLS=1  or  config tools.fetchPrivateUrls: true.
 *
 * NOTE: this guards MODEL-chosen URLs (fetch_url). Provider baseUrls are
 * user-configured and trusted — forge talks to whatever endpoint YOU set.
 */
import dns from "node:dns/promises"

export const BLOCKED_HOSTNAMES = [/^metadata(\.google)?\.internal$/i, /^instance-data$/i, /^metadata\.azure\.com$/i, /^metadata$/i]

function ipv4ToInt(ip) {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  if (parts.some((p) => p > 255)) return null
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}

function inV4Range(ip, base, bits) {
  const n = ipv4ToInt(ip)
  if (n === null) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return ((n & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0)
}

const V4_RANGES = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
]

/** Expand an IPv6 literal to 8 hextets (handles ::, embedded IPv4 tail,
 *  zone ids). Returns null when it is not a valid IPv6 literal. */
function expandV6(raw) {
  let s = String(raw).toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "")
  // embedded dotted IPv4 tail (::ffff:127.0.0.1, 64:ff9b::10.0.0.1)
  const tail = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (tail) {
    const n = ipv4ToInt(tail[1])
    if (n === null) return null
    s = s.slice(0, -tail[1].length) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16)
  }
  if (!/^[0-9a-f:]+$/.test(s)) return null
  const dbl = s.split("::")
  if (dbl.length > 2) return null
  const head = dbl[0] ? dbl[0].split(":") : []
  const rest = dbl.length === 2 && dbl[1] ? dbl[1].split(":") : []
  if (head.concat(rest).some((h) => h.length === 0 || h.length > 4)) return null
  const missing = 8 - head.length - rest.length
  if (dbl.length === 2 ? missing < 0 : missing !== 0) return null
  const parts = [...head, ...(dbl.length === 2 ? Array(missing).fill("0") : []), ...rest]
  return parts.map((h) => parseInt(h, 16))
}

/** Is this a private/loopback/link-local/undocumented address?
 *  v20.0.1: IPv6 is parsed structurally. The v20 check only caught the
 *  DOTTED form of IPv4-mapped addresses (::ffff:127.0.0.1) — the hex form
 *  (::ffff:7f00:1), NAT64 (64:ff9b::7f00:1), 6to4 (2002:7f00:0001::) and
 *  Teredo all reached loopback/private services. */
export function isPrivateAddress(ip) {
  if (!ip) return true
  const raw = String(ip).toLowerCase().replace(/^\[|\]$/g, "")
  if (!raw.includes(":")) return V4_RANGES.some(([base, bits]) => inV4Range(raw, base, bits))
  const h = expandV6(raw)
  if (!h) return true // unparseable IPv6 literal — never fetch what we cannot classify
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  const allZero = (from, to) => h.slice(from, to).every((x) => x === 0)
  if (allZero(0, 7) && (h[7] === 0 || h[7] === 1)) return true // :: and ::1
  if (allZero(0, 5) && h[5] === 0xffff) return isPrivateAddress(v4(h[6], h[7])) // ::ffff:a.b.c.d (IPv4-mapped)
  if (allZero(0, 4) && h[4] === 0xffff && h[5] === 0) return isPrivateAddress(v4(h[6], h[7])) // ::ffff:0:a.b.c.d (IPv4-translated, RFC 2765)
  if (allZero(0, 6)) return isPrivateAddress(v4(h[6], h[7])) // ::a.b.c.d (IPv4-compatible, deprecated)
  if (h[0] === 0x64 && h[1] === 0xff9b && allZero(2, 6)) return isPrivateAddress(v4(h[6], h[7])) // 64:ff9b::/96 NAT64
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return isPrivateAddress(v4(h[6], h[7])) // 64:ff9b:1::/48 local-use NAT64
  if (h[0] === 0x2002) return isPrivateAddress(v4(h[1], h[2])) // 2002::/16 6to4 — embeds the IPv4
  if (h[0] === 0x2001 && h[1] === 0) return isPrivateAddress(v4(h[6] ^ 0xffff, h[7] ^ 0xffff)) // 2001::/32 Teredo — client IPv4 is XOR-obfuscated
  if ((h[0] & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
  if ((h[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((h[0] & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (deprecated)
  if ((h[0] & 0xff00) === 0xff00) return true // ff00::/8 multicast
  if (h[0] === 0x2001 && h[1] === 0xdb8) return true // 2001:db8::/32 documentation
  if (h[0] === 0x100 && allZero(1, 4)) return true // 100::/64 discard-only
  return false
}

function hostnameOf(u) {
  try {
    const host = new URL(u).hostname.toLowerCase()
    return host.replace(/^\[|\]$/g, "")
  } catch {
    return null
  }
}

function literalIp(host) {
  // v4 literal, v6 literal (with or without brackets)
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return host
  if (host.includes(":")) return host
  return null
}

/**
 * Validate a URL the model wants to fetch.
 * @returns {ok: true} or {ok: false, reason}
 * Never throws. `allowPrivate` opts out (local LLM stacks, tests).
 */
export async function assertFetchableUrl(url, { allowPrivate } = {}) {
  if (allowPrivate) return { ok: true }
  let host
  try {
    host = new URL(String(url)).hostname.toLowerCase().replace(/^\[|\]$/g, "")
  } catch {
    return { ok: false, reason: "malformed URL" }
  }
  for (const re of BLOCKED_HOSTNAMES) {
    if (re.test(host)) return { ok: false, reason: `hostname "${host}" is a cloud metadata service` }
  }
  const lit = literalIp(host)
  if (lit) {
    return isPrivateAddress(lit)
      ? { ok: false, reason: `address ${lit} is private/loopback/link-local` }
      : { ok: true }
  }
  // resolve like the fetch would — validate EVERY address (rebinding-safe)
  let addrs
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true })
  } catch {
    return { ok: false, reason: `cannot resolve "${host}" (offline or NXDOMAIN)` }
  }
  if (!addrs.length) return { ok: false, reason: `"${host}" resolves to nothing` }
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      return { ok: false, reason: `"${host}" resolves to a private/loopback address (${a.address})` }
    }
  }
  return { ok: true }
}
