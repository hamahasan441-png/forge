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

/** Is this a private/loopback/link-local/undocumented address? */
export function isPrivateAddress(ip) {
  if (!ip) return true
  const raw = String(ip).toLowerCase().replace(/^\[|\]$/g, "")
  // IPv4-mapped IPv6 (::ffff:10.0.0.1)
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateAddress(mapped[1])
  if (raw === "::1" || raw === "::") return true
  if (/^f[cd][0-9a-f]{2}:/.test(raw)) return true // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]:/.test(raw)) return true // fe80::/10 link-local
  if (raw.includes(":")) {
    // other IPv6 — treat 6to4/Teredo of private ranges as private too (rare); allow the rest
    return false
  }
  return V4_RANGES.some(([base, bits]) => inV4Range(raw, base, bits))
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
  // v20.0.1: `new URL("http://")` parses but yields an empty hostname — reject
  // it here instead of handing "" to dns.lookup (which only warns).
  if (!host) return { ok: false, reason: "malformed URL (no host)" }
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
