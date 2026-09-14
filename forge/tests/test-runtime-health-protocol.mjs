#!/usr/bin/env node
/**
 * v94 gapclose — PROTOCOL-AWARE runtime health probes (TODO runtime #2).
 *
 * Before: healthProbe was HTTP-only, so a TCP-only / TLS / WebSocket-upgrade
 * service was reported "NOT healthy" even while it was demonstrably listening
 * — false evidence in the wrong direction. Now:
 *
 *   - HTTP reply (any status)            → HTTP evidence, unchanged semantics
 *   - non-HTTP reply + TCP connect ok    → ok:true, protocol "tcp", labeled
 *                                          "listening PROVEN, app health NOT"
 *   - GET timeout + TCP connect ok       → ok:false, "listening but hung"
 *   - refused                            → ok:false, nothing listening
 *   - protocol:"tcp" / "http"            → explicit, no fallback guessing
 *
 * Real servers on real ports; no mocks of the probe itself. Zero network
 * (127.0.0.1 only).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-health-proto-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-health-work-"))

const { healthProbe, createRuntimeSession } = await import("../runtimesession.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 260) : ""}`) }
}
const listen = (server) => new Promise((res) => server.listen(0, "127.0.0.1", () => res(server.address().port)))
const closeAll = []
function track(server, sockets = null) {
  closeAll.push(async () => {
    if (sockets) for (const s of sockets) { try { s.destroy() } catch {} }
    await new Promise((res) => { try { server.close(res) } catch { res() } })
  })
  return server
}

console.log("== HTTP services: unchanged evidence semantics ==")
{
  const srv = track(http.createServer((req, res) => res.end("ok")))
  const port = await listen(srv)
  const r = await healthProbe({ port, timeoutMs: 2000 })
  ok("HTTP 200 → ok, protocol http, status 200", r.ok === true && r.probe.protocol === "http" && r.probe.status === 200, JSON.stringify(r))
  ok("HTTP probe carries the real url", r.probe.url === `http://127.0.0.1:${port}/`)
}
{
  const srv = track(http.createServer((req, res) => { res.statusCode = 500; res.end("boom") }))
  const port = await listen(srv)
  const r = await healthProbe({ port, timeoutMs: 2000 })
  ok("HTTP 500 → NOT ok (status is the evidence)", r.ok === false && r.probe.status === 500, JSON.stringify(r))
}
{
  // a WebSocket-style server answers a bare GET with 426 Upgrade Required —
  // that IS an HTTP reply: healthy under the 1xx–4xx contract, protocol http
  const srv = track(http.createServer((req, res) => { res.statusCode = 426; res.end("upgrade required") }))
  const port = await listen(srv)
  const r = await healthProbe({ port, timeoutMs: 2000 })
  ok("HTTP 426 (WS upgrade server) → ok via the HTTP path", r.ok === true && r.probe.protocol === "http" && r.probe.status === 426, JSON.stringify(r))
}

console.log("== non-HTTP services: TCP floor, honestly labeled ==")
{
  // raw TCP service that replies with non-HTTP bytes and closes — the old
  // probe called this NOT healthy; the honest answer is "listening, non-HTTP"
  const sockets = new Set()
  const srv = track(net.createServer((s) => { sockets.add(s); s.on("error", () => {}); s.end("220 not-http\r\n") }), sockets)
  const port = await listen(srv)
  const r = await healthProbe({ port, timeoutMs: 2000 })
  ok("raw TCP service (non-HTTP reply) → ok:true", r.ok === true, JSON.stringify(r))
  ok("…and the probe says WHICH protocol proved it (tcp)", r.probe.protocol === "tcp", JSON.stringify(r.probe))
  ok("…with an honest detail: listening proven, app health not", /LISTENING/i.test(String(r.probe.detail)) && /not provable over HTTP/i.test(String(r.probe.detail)), r.probe.detail)
  ok("…no fake HTTP status is invented", r.probe.status === null)
}
{
  // a service that accepts and immediately resets — ECONNRESET on the HTTP side
  const sockets = new Set()
  const srv = track(net.createServer((s) => { sockets.add(s); s.on("error", () => {}); s.destroy() }), sockets)
  const port = await listen(srv)
  const r = await healthProbe({ port, timeoutMs: 2000 })
  ok("reset-on-connect TCP service → ok:true protocol tcp", r.ok === true && r.probe.protocol === "tcp", JSON.stringify(r))
}
{
  // explicit protocol:"tcp" skips HTTP entirely — even against an HTTP server
  const srv = track(http.createServer((req, res) => res.end("ok")))
  const port = await listen(srv)
  const r = await healthProbe({ port, timeoutMs: 2000, protocol: "tcp" })
  ok("protocol:'tcp' against an HTTP server → connect-only evidence", r.ok === true && r.probe.protocol === "tcp" && r.probe.status === null, JSON.stringify(r))
}
{
  // explicit protocol:"http" never falls back — a non-HTTP service is a failure
  const sockets = new Set()
  const srv = track(net.createServer((s) => { sockets.add(s); s.on("error", () => {}); s.end("220 not-http\r\n") }), sockets)
  const port = await listen(srv)
  const r = await healthProbe({ port, timeoutMs: 2000, protocol: "http" })
  ok("protocol:'http' against a non-HTTP service → NOT ok (no silent fallback)", r.ok === false, JSON.stringify(r))
}

console.log("== failure evidence stays failure evidence ==")
{
  // nothing listening: refused is refused — never upgraded to "healthy"
  const probeSrv = net.createServer((s) => { s.on("error", () => {}) })
  const port = await listen(probeSrv)
  await new Promise((res) => probeSrv.close(res))
  const r = await healthProbe({ port, timeoutMs: 1500 })
  ok("dead port → NOT ok", r.ok === false, JSON.stringify(r))
  ok("dead port → probe records tcpListening:false (evidence, not a guess)", r.probe && r.probe.tcpListening === false, JSON.stringify(r.probe))
}
{
  // accepts the connection but never answers the GET: LISTENING ≠ HEALTHY
  const sockets = new Set()
  const srv = track(net.createServer((s) => { sockets.add(s); s.on("error", () => {}) /* never write, never end */ }), sockets)
  const port = await listen(srv)
  const r = await healthProbe({ port, timeoutMs: 400 })
  ok("silent listener → NOT ok (a hang is never healthy)", r.ok === false, JSON.stringify(r))
  ok("…and the error distinguishes 'listening but hung' from 'nothing there'", r.probe.tcpListening === true && /listening/i.test(String(r.error)), JSON.stringify({ err: r.error, probe: r.probe }))
}
{
  const r = await healthProbe({ port: "not-a-port" })
  ok("invalid port → NOT ok, no probe fabricated", r.ok === false && r.probe === null)
}

console.log("== session-level evidence lines are protocol-aware ==")
{
  const sockets = new Set()
  const srv = track(net.createServer((s) => { sockets.add(s); s.on("error", () => {}); s.end("220 not-http\r\n") }), sockets)
  const port = await listen(srv)
  const stubMgr = { list: () => ({ live: [], history: [] }), spawn: () => ({ ok: false }), kill: () => ({ ok: false }) }
  const session = createRuntimeSession({ cwd: WORK, mgr: stubMgr })
  const r = await session.health({ port, timeoutMs: 2000 })
  ok("session.health on a non-HTTP port → ok (reachable)", r.ok === true && r.probe.protocol === "tcp", JSON.stringify(r))
  const ev = session.evidenceLog()
  const healthEv = ev.filter((e) => e.kind === "health").pop()
  ok("evidence claim says LISTENING (non-HTTP), never 'healthy' over HTTP", /LISTENING/.test(healthEv.claim) && /non-HTTP/.test(healthEv.claim), JSON.stringify(healthEv))
  ok("evidence detail says what was proven and what was not", /TCP connect/.test(healthEv.detail) && /not provable/i.test(healthEv.detail), JSON.stringify(healthEv))
  // and an HTTP service still records classic HTTP evidence
  const hsrv = track(http.createServer((req, res) => res.end("ok")))
  const hport = await listen(hsrv)
  const r2 = await session.health({ port: hport, timeoutMs: 2000 })
  const ev2 = session.evidenceLog().filter((e) => e.kind === "health").pop()
  ok("session.health on HTTP → unchanged 'runtime healthy' + HTTP status evidence", r2.ok === true && /healthy/.test(ev2.claim) && /HTTP 200/.test(ev2.detail), JSON.stringify(ev2))
}

for (const c of closeAll.reverse()) { try { await c() } catch {} }
console.log(`\n== runtime-health-protocol suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
