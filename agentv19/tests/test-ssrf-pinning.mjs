#!/usr/bin/env node
/**
 * forge — SSRF / DNS-pinning adversarial suite (v21.1 P0).
 *
 * The property under test: the address that was VALIDATED is the address the
 * socket CONNECTS to — for the first request AND every redirect hop — and no
 * private/loopback/link-local/reserved destination is ever connected to
 * unless the user opted in.
 *
 * Every test runs against real local HTTP servers on loopback aliases
 * (127.0.0.1 / 127.0.0.2 / ::1). Because loopback is itself a blocked range,
 * the "public" side of each scenario is simulated by injecting a `policy`
 * that treats ONE specific loopback address as public. The socket assertion
 * is then made on the kernel-level `remoteAddress`, not on what the guard
 * *said* it would do.
 *
 * Zero external network.
 */
import http from "node:http"
import net from "node:net"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ssrf-"))

const ng = await import("../forge/netguard.js")
const { pinnedFetch, resolvePinnedTarget, assertFetchableUrl, blockedAddressReason, isPrivateAddress, parseIPv6, PinnedFetchError } = ng
const { makeToolContext } = await import("../forge/tools.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`) } }

// --- local servers -----------------------------------------------------------
const connections = [] // every accepted socket: { local, remote }
function serve(host, handler) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler)
    srv.on("connection", (s) => connections.push({ local: s.localAddress, remote: s.remoteAddress, port: s.localPort }))
    srv.on("error", reject)
    srv.listen(0, host, () => resolve(srv))
  })
}
const PUBLIC_SIM = "127.0.0.2" // pretend this one is public
const PRIVATE_REAL = "127.0.0.1"
const publicPolicy = (ip) => (String(ip).replace(/^\[|\]$/g, "") === PUBLIC_SIM ? null : blockedAddressReason(ip))

const hits = { pub: 0, priv: 0, v6: 0 }
const pub = await serve(PUBLIC_SIM, (req, res) => {
  hits.pub++
  if (req.url.startsWith("/redirect-private")) { res.writeHead(302, { location: `http://${PRIVATE_REAL}:${priv.address().port}/secret` }); return res.end() }
  if (req.url.startsWith("/redirect-name")) { res.writeHead(302, { location: `http://rebind.test:${priv.address().port}/secret` }); return res.end() }
  if (req.url.startsWith("/redirect-v6")) { res.writeHead(302, { location: `http://[::1]:${v6port}/secret` }); return res.end() }
  if (req.url.startsWith("/redirect-mapped")) { res.writeHead(302, { location: `http://[::ffff:7f00:1]:${priv.address().port}/secret` }); return res.end() }
  if (req.url.startsWith("/redirect-relative")) { res.writeHead(301, { location: "/final" }); return res.end() }
  if (req.url.startsWith("/redirect-loop")) { res.writeHead(302, { location: "/redirect-loop" }); return res.end() }
  if (req.url.startsWith("/redirect-metadata")) { res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); return res.end() }
  if (req.url.startsWith("/big")) { res.writeHead(200, { "content-type": "text/plain" }); return res.end(Buffer.alloc(3 * 1024 * 1024, 65)) }
  if (req.url.startsWith("/slow")) { return setTimeout(() => { try { res.end("late") } catch {} }, 3000) }
  if (req.url.startsWith("/final")) { res.writeHead(200, { "content-type": "text/plain" }); return res.end("final-ok host=" + req.headers.host) }
  res.writeHead(200, { "content-type": "text/plain" })
  res.end("public-ok host=" + req.headers.host)
})
const priv = await serve(PRIVATE_REAL, (req, res) => { hits.priv++; res.writeHead(200, { "content-type": "text/plain" }); res.end("PRIVATE-LEAK") })
let v6srv = null, v6port = 0
try { v6srv = await serve("::1", (req, res) => { hits.v6++; res.end("V6-LEAK") }); v6port = v6srv.address().port } catch { /* no IPv6 loopback here */ }
const P = pub.address().port
const PP = priv.address().port

// ---------------------------------------------------------------------------
console.log("== address classifier: bytes, not strings ==")
const BLOCKED = [
  ["127.0.0.1", "loopback"], ["127.255.255.254", "loopback"], ["0.0.0.0", "this-network"], ["10.1.2.3", "private"], ["172.16.0.1", "private"],
  ["172.31.255.255", "private"], ["192.168.0.1", "private"], ["169.254.169.254", "link-local"], ["100.64.0.1", "NAT"], ["224.0.0.1", "multicast"],
  ["255.255.255.255", "broadcast"], ["192.0.0.1", "IETF"], ["198.18.0.1", "benchmarking"], ["240.0.0.1", "reserved"],
  ["::1", "loopback"], ["::", "unspecified"], ["::ffff:127.0.0.1", "IPv4-mapped"], ["::ffff:7f00:1", "IPv4-mapped"], ["::FFFF:7F00:0001", "IPv4-mapped"],
  ["::ffff:a00:1", "IPv4-mapped"], ["::ffff:c0a8:1", "IPv4-mapped"], ["::ffff:a9fe:a9fe", "IPv4-mapped"], ["::7f00:1", "IPv4-compatible"],
  ["64:ff9b::7f00:1", "NAT64"], ["64:ff9b::a00:1", "NAT64"], ["64:ff9b:1::1", "NAT64"], ["2002:7f00:1::", "6to4"], ["2002:a00:1::", "6to4"], ["2002:c0a8:101::", "6to4"],
  ["2001:0:0:0:0:0:8080:fefe", "Teredo"], ["2001:db8::1", "documentation"], ["2001:10::1", "ORCHID"], ["100::1", "discard"],
  ["fc00::1", "unique-local"], ["fd12:3456::1", "unique-local"], ["fe80::1", "link-local"], ["febf::1", "link-local"], ["fec0::1", "site-local"], ["ff02::1", "multicast"],
  ["[::1]", "loopback"], ["fe80::1%eth0", "link-local"],
]
for (const [ip, why] of BLOCKED) {
  const r = blockedAddressReason(ip)
  ok(`blocked ${ip} (${why})`, r !== null && new RegExp(why.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "i").test(r), `got ${r}`)
}
const PUBLIC = ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.255.255", "192.169.0.1", "11.0.0.1", "2606:4700::1111", "2a00:1450:4001::1", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::", "2001:4860:4860::8888"]
for (const ip of PUBLIC) ok(`public ${ip}`, blockedAddressReason(ip) === null, `got ${blockedAddressReason(ip)}`)
const UNPARSEABLE = ["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1::2::3", "12345::", "gggg::1", "hello", "::ffff:1.2.3", "0x7f000001", "2130706433"]
for (const ip of UNPARSEABLE) ok(`unparseable "${ip}" fails closed`, isPrivateAddress(ip) === true)
ok("parseIPv6 rejects double ::", parseIPv6("1::2::3") === null)
ok("parseIPv6 handles embedded dotted quad", JSON.stringify(parseIPv6("::ffff:1.2.3.4").slice(12)) === "[1,2,3,4]")
ok("parseIPv6 handles zone id", parseIPv6("fe80::1%eth0") !== null)

// ---------------------------------------------------------------------------
console.log("== URL-level validation (compat API) ==")
const url = async (u, o) => assertFetchableUrl(u, o)
for (const u of ["http://localhost/", "http://LOCALHOST:8080/", "http://a.localhost/", "http://127.0.0.1/", "http://127.1/", "http://0x7f000001/", "http://2130706433/", "http://[::1]/", "http://[::ffff:7f00:1]/", "http://[::ffff:127.0.0.1]/", "http://10.0.0.1/", "http://192.168.1.1/", "http://169.254.169.254/latest/", "http://[fd00::1]/", "http://[fe80::1]/", "http://metadata.google.internal/", "http://metadata/", "http://instance-data/", "http://foo.internal/", "http://[64:ff9b::7f00:1]/", "http://[2002:7f00:1::]/", "http://0.0.0.0/", "http://[::]/", "http://224.0.0.1/"]) {
  const r = await url(u)
  ok(`blocked ${u}`, r.ok === false, JSON.stringify(r))
}
for (const u of ["not a url", "http://", "file:///etc/passwd", "ftp://1.1.1.1/", "javascript:alert(1)", "http://user:pw@1.1.1.1/", "http://[fe80::1%25eth0]/"]) {
  const r = await url(u)
  ok(`rejected ${u}`, r.ok === false, JSON.stringify(r))
}
{
  const r = await url("http://1.1.1.1/")
  ok("public literal passes", r.ok === true && r.addresses?.[0]?.address === "1.1.1.1")
  const r2 = await url("http://127.0.0.1/", { allowPrivate: true })
  ok("opt-in allows loopback", r2.ok === true)
  const r3 = await url("http://", { allowPrivate: true })
  ok("opt-in still rejects malformed", r3.ok === false)
}

// ---------------------------------------------------------------------------
console.log("== resolver-driven validation (injected DNS) ==")
{
  const resolver = (h) => Promise.resolve({ "pub.test": [{ address: "1.1.1.1", family: 4 }], "mixed.test": [{ address: "1.1.1.1", family: 4 }, { address: "10.0.0.5", family: 4 }], "v6mixed.test": [{ address: "2606:4700::1111", family: 6 }, { address: "::1", family: 6 }], "manya.test": [{ address: "1.1.1.1", family: 4 }, { address: "8.8.8.8", family: 4 }, { address: "9.9.9.9", family: 4 }], "manyaaaa.test": [{ address: "2606:4700::1111", family: 6 }, { address: "2001:4860:4860::8888", family: 6 }], "mapped.test": [{ address: "::ffff:127.0.0.1", family: 6 }], "empty.test": [] }[h] ?? Promise.reject(new Error("ENOTFOUND")))
  const r1 = await resolvePinnedTarget("http://pub.test/", { resolver })
  ok("public hostname resolves + passes", r1.ok && r1.addresses.length === 1)
  const r2 = await resolvePinnedTarget("http://mixed.test/", { resolver })
  ok("mixed public+private A records refused", !r2.ok && /10\.0\.0\.5/.test(r2.reason))
  const r3 = await resolvePinnedTarget("http://v6mixed.test/", { resolver })
  ok("mixed AAAA (public + ::1) refused", !r3.ok && /::1/.test(r3.reason))
  const r4 = await resolvePinnedTarget("http://manya.test/", { resolver })
  ok("multiple public A records all kept for pinning", r4.ok && r4.addresses.length === 3)
  const r5 = await resolvePinnedTarget("http://manyaaaa.test/", { resolver })
  ok("multiple public AAAA records all kept", r5.ok && r5.addresses.every((a) => a.family === 6))
  const r6 = await resolvePinnedTarget("http://mapped.test/", { resolver })
  ok("AAAA answer that is IPv4-mapped loopback refused", !r6.ok)
  const r7 = await resolvePinnedTarget("http://empty.test/", { resolver })
  ok("empty answer refused", !r7.ok && /nothing/.test(r7.reason))
  const r8 = await resolvePinnedTarget("http://nx.test/", { resolver })
  ok("DNS failure refused (fail closed)", !r8.ok && /cannot resolve/.test(r8.reason))
  const r9 = await resolvePinnedTarget("http://pub.test/", { resolver: () => { throw new Error("boom") } })
  ok("throwing resolver refused, never throws out", !r9.ok)
}

// ---------------------------------------------------------------------------
console.log("== pinned fetch: the socket connects ONLY to the validated address ==")
{
  const sockets = []
  const lookups = []
  const r = await pinnedFetch(`http://pin.test:${P}/`, { resolver: () => [{ address: PUBLIC_SIM, family: 4 }], policy: publicPolicy, onSocket: (s) => sockets.push(s), onLookup: (h) => lookups.push(h) })
  ok("fetch succeeded through the pinned address", r.ok && r.body.toString().startsWith("public-ok"))
  ok("socket connected to the validated address", sockets.length === 1 && sockets[0].remoteAddress === PUBLIC_SIM && sockets[0].ok)
  ok("Host header carries the NAME, not the pinned IP", r.body.toString().includes(`host=pin.test:${P}`))
  ok("the pinned lookup replaced Node's resolver (no second DNS query)", lookups.length === 1 && lookups[0] === "pin.test")
  ok("server saw the connection from loopback", connections.some((c) => c.local === PUBLIC_SIM))
}

console.log("== DNS rebinding: second resolution returns private → still pinned to validated address ==")
{
  const before = hits.priv
  let calls = 0
  const rebinding = () => { calls++; return calls === 1 ? [{ address: PUBLIC_SIM, family: 4 }] : [{ address: PRIVATE_REAL, family: 4 }] }
  const sockets = []
  const r = await pinnedFetch(`http://rebind.test:${P}/`, { resolver: rebinding, policy: publicPolicy, onSocket: (s) => sockets.push(s) })
  ok("resolver consulted exactly once for one hop", calls === 1)
  ok("connected to the first (validated) answer", sockets[0]?.remoteAddress === PUBLIC_SIM)
  ok("private server never received a connection", hits.priv === before && r.body.toString().startsWith("public-ok"))
}

console.log("== rebinding across a retry: connection error retries the SAME pinned set ==")
{
  // a server that drops the first connection, answers the second
  let n = 0
  const flaky = http.createServer((req, res) => { res.end("second-try") })
  flaky.on("connection", (s) => { n++; if (n === 1) s.destroy() })
  await new Promise((r) => flaky.listen(0, PUBLIC_SIM, r))
  let calls = 0
  const rebinding = () => { calls++; return calls === 1 ? [{ address: PUBLIC_SIM, family: 4 }] : [{ address: PRIVATE_REAL, family: 4 }] }
  const sockets = []
  const before = hits.priv
  let res, err
  try { res = await pinnedFetch(`http://flaky.test:${flaky.address().port}/`, { resolver: rebinding, policy: publicPolicy, retries: 2, onSocket: (s) => sockets.push(s) }) } catch (e) { err = e }
  ok("retry succeeded", !err && res?.body?.toString() === "second-try", String(err?.message))
  ok("still resolved once (retry re-used the pinned set)", calls === 1)
  ok("every attempt went to the validated address", sockets.every((s) => s.remoteAddress === PUBLIC_SIM) && sockets.length >= 2)
  ok("private server untouched during retries", hits.priv === before)
  flaky.close()
}

console.log("== redirects: public → private is refused at the hop ==")
{
  const cases = [
    ["/redirect-private", /loopback|127\.0\.0\.1/],
    ["/redirect-name", /rebind\.test|127\.0\.0\.1|loopback/],
    ["/redirect-mapped", /IPv4-mapped|loopback/],
    ["/redirect-metadata", /169\.254|link-local/],
  ]
  if (v6srv) cases.push(["/redirect-v6", /::1|loopback/])
  for (const [pth, re] of cases) {
    const before = { priv: hits.priv, v6: hits.v6 }
    const sockets = []
    let err
    try { await pinnedFetch(`http://pin.test:${P}${pth}`, { resolver: (h) => (h === "pin.test" ? [{ address: PUBLIC_SIM, family: 4 }] : [{ address: PRIVATE_REAL, family: 4 }]), policy: publicPolicy, onSocket: (s) => sockets.push(s) }) } catch (e) { err = e }
    ok(`${pth} → blocked`, err instanceof PinnedFetchError && err.blocked && re.test(err.message), String(err?.message))
    ok(`${pth} → blocked on hop 1 (after the public hop)`, err?.hop === 1)
    ok(`${pth} → private/v6 servers never connected`, hits.priv === before.priv && hits.v6 === before.v6)
    ok(`${pth} → only the public socket was opened`, sockets.length === 1 && sockets[0].remoteAddress === PUBLIC_SIM)
  }
}

console.log("== redirects: legitimate hops are re-validated and followed ==")
{
  const r = await pinnedFetch(`http://pin.test:${P}/redirect-relative`, { resolver: () => [{ address: PUBLIC_SIM, family: 4 }], policy: publicPolicy })
  ok("relative redirect followed", r.ok && r.body.toString().startsWith("final-ok"))
  ok("hop chain recorded", r.hops.length === 2 && r.hops[0].status === 301 && r.hops[1].status === 200)
  ok("Host header correct on the second hop", r.body.toString().includes(`host=pin.test:${P}`))
  let err
  try { await pinnedFetch(`http://pin.test:${P}/redirect-loop`, { resolver: () => [{ address: PUBLIC_SIM, family: 4 }], policy: publicPolicy, maxRedirects: 3 }) } catch (e) { err = e }
  ok("redirect loop bounded", err instanceof PinnedFetchError && err.code === "EREDIRECTS")
}

console.log("== the guard cannot be bypassed by opting the lookup out ==")
{
  // A raw http.request to a private literal proves the servers are reachable
  // (i.e. the negative tests above were meaningful, not a dead network).
  const reachable = await new Promise((res) => { http.get(`http://${PRIVATE_REAL}:${PP}/`, (r) => { r.resume(); res(true) }).on("error", () => res(false)) })
  ok("control: private server IS reachable without the guard", reachable && hits.priv >= 1)
  const before = hits.priv
  let err
  try { await pinnedFetch(`http://${PRIVATE_REAL}:${PP}/secret`) } catch (e) { err = e }
  ok("pinnedFetch refuses the same private literal", err?.blocked === true && hits.priv === before)
  try { err = null; await pinnedFetch(`http://[::ffff:7f00:1]:${PP}/secret`) } catch (e) { err = e }
  ok("pinnedFetch refuses hex-mapped loopback", err?.blocked === true && hits.priv === before)
  if (v6srv) {
    try { err = null; await pinnedFetch(`http://[::1]:${v6port}/secret`) } catch (e) { err = e }
    ok("pinnedFetch refuses IPv6 loopback", err?.blocked === true && hits.v6 === 0)
  }
  // post-connect assertion: a hostile lookup would be caught at socket level
  const s2 = []
  try { err = null; await pinnedFetch(`http://evil.test:${PP}/`, { resolver: () => [{ address: PUBLIC_SIM, family: 4 }], policy: publicPolicy, onSocket: (s) => s2.push(s) }) } catch (e) { err = e }
  ok("control: a pinned request to the wrong port fails (nothing listening on PUBLIC_SIM:PP)", err && !err.blocked)
}

console.log("== bounds: size, time, cancellation ==")
{
  let err
  try { await pinnedFetch(`http://pin.test:${P}/big`, { resolver: () => [{ address: PUBLIC_SIM, family: 4 }], policy: publicPolicy, maxBytes: 1024 * 1024 }) } catch (e) { err = e }
  ok("oversized body aborted mid-stream", err instanceof PinnedFetchError && err.code === "ETOOLARGE")
  const t0 = Date.now()
  try { err = null; await pinnedFetch(`http://pin.test:${P}/slow`, { resolver: () => [{ address: PUBLIC_SIM, family: 4 }], policy: publicPolicy, timeoutMs: 400, retries: 0 }) } catch (e) { err = e }
  ok("per-hop timeout enforced", err instanceof PinnedFetchError && err.code === "ETIMEDOUT" && Date.now() - t0 < 2500)
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 100)
  try { err = null; await pinnedFetch(`http://pin.test:${P}/slow`, { resolver: () => [{ address: PUBLIC_SIM, family: 4 }], policy: publicPolicy, signal: ac.signal, retries: 0 }) } catch (e) { err = e }
  ok("abort signal cancels", err instanceof PinnedFetchError && err.code === "ABORT_ERR")
}

console.log("== fetch_url tool integration ==")
{
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ssrf-proj-"))
  const t = makeToolContext({ cwd: proj, root: proj, fetchPrivateUrls: false })
  const before = hits.priv
  for (const u of [`http://${PRIVATE_REAL}:${PP}/`, `http://[::ffff:7f00:1]:${PP}/`, `http://localhost:${PP}/`, "http://169.254.169.254/latest/meta-data/", "http://metadata.google.internal/", `http://0x7f000001:${PP}/`]) {
    const r = await t.exec("fetch_url", { url: u })
    ok(`fetch_url blocks ${u}`, String(r).startsWith("BLOCKED (SSRF guard)"), String(r).slice(0, 100))
  }
  ok("no private connection was made through the tool", hits.priv === before)
  const r = await t.exec("fetch_url", { url: "not-a-url" })
  ok("fetch_url rejects non-http", String(r).startsWith("ERROR"))
  const tOpt = makeToolContext({ cwd: proj, root: proj, fetchPrivateUrls: true })
  const r2 = await tOpt.exec("fetch_url", { url: `http://${PRIVATE_REAL}:${PP}/` })
  ok("opt-in fetches loopback", /PRIVATE-LEAK/.test(String(r2)))
  // opt-in + redirect to a second local server also works (redirects re-validated under the same policy)
  const r3 = await tOpt.exec("fetch_url", { url: `http://${PUBLIC_SIM}:${P}/redirect-private` })
  ok("opt-in follows redirects", /PRIVATE-LEAK/.test(String(r3)) && /redirected 1×/.test(String(r3)))
  fs.rmSync(proj, { recursive: true, force: true })
}

console.log("== no raw fetch() remains on the model-controlled URL path ==")
{
  const src = fs.readFileSync(new URL("../forge/tools.js", import.meta.url), "utf8")
  const fn = src.slice(src.indexOf("async function fetch_url"), src.indexOf("// --- v15 tools"))
  ok("fetch_url does not call global fetch()", !/\bfetch\(/.test(fn.replace(/pinnedFetch\(/g, "")))
  ok("fetch_url uses pinnedFetch", /pinnedFetch\(/.test(fn))
}

pub.close(); priv.close(); v6srv?.close()
fs.rmSync(process.env.FORGE_HOME, { recursive: true, force: true })
console.log(`\n== ssrf-pinning suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
