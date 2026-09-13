/**
 * forge — plugin host (v21.1 P0: plugin isolation, child-process edition).
 *
 * This file is the ENTRY of every plugin process. plugins.js spawns it as a
 * separate `node` CHILD PROCESS (not a worker thread — a worker shares the
 * agent's file descriptors and pid, so a worker-hosted plugin could write into
 * the MCP servers' stdin pipes, tamper with files the agent has open, or
 * `process.kill(process.pid)` the agent; a child process can do none of that)
 * with Node's permission model enabled (`--permission` / Node 20's
 * `--experimental-permission`) and an explicit `--allow-fs-read/--allow-fs-write`
 * list (`--allow-child-process` only when granted). The permission model is
 * the hard boundary for filesystem, child processes, workers, native addons,
 * WASI, inspector and process.binding.
 *
 * Node has no `--allow-net` on 20/22, so NETWORK is closed here, in layers,
 * before any plugin code runs:
 *   1. builtin ALLOW-list: only plain library builtins resolve; net/tls/http/
 *      https/http2/dgram/dns AND their `_http_*` / `_tls_*` internals are
 *      refused unless the network capability is granted (module hooks where the
 *      runtime has them, `Module._load` for require/createRequire,
 *      `process.getBuiltinModule` always);
 *   2. the terminal primitives every network path ends in are replaced with
 *      throwing stubs (`net.Socket#connect`, `net.Server#listen/_listen2`,
 *      dgram bind/send/connect, dns lookup/resolve/reverse, tls/http/https/
 *      http2 connect/request/get) — this holds even on runtimes where an ESM
 *      `import("node:net")` cannot be intercepted (Node 20 has no sync hooks);
 *   3. the global HTTP APIs (fetch, WebSocket, EventSource, XMLHttpRequest).
 *
 * Bypass routes verified closed (tests/test-plugin-isolation.mjs):
 * `process.getBuiltinModule`, `module.createRequire`, `module.register` /
 * `registerHooks`, `new Function("import…")`, `import.meta.resolve`,
 * `process.binding` / `_linkedBinding` / `dlopen`, `process.kill` / `_kill` /
 * `_debugProcess` (signals to the agent), `v8.setHeapSnapshotNearHeapLimit` +
 * OOM and `trace_events` (both write files into cwd BEHIND the permission
 * model), `process.report`, `node:sqlite` (same), `node:_http_agent` /
 * `_tls_wrap` (internal network modules), a garbage or oversized protocol
 * frame (kills only this process).
 *
 * Runtime note: Node 20 has no synchronous module hooks, so there an ESM
 * `import("node:vm")` / `import("node:net")` still RESOLVES; every dangerous
 * operation inside those modules is nevertheless closed by layer 2 and by the
 * permission model. On Node ≥ 22.15 the import itself is refused as well.
 *
 * Protocol — newline-delimited JSON on fd 3 (never Node's IPC channel, whose
 * deserializer crashes the PARENT on a malformed frame):
 *   → { op: "probe" }                       ⇢ { op: "probe", ok, tools:[meta…] | error }
 *   → { op: "call", id, name, args, ctx }   ⇢ { op: "call", id, result } | { op: "call", id, error }
 * argv[2] is JSON: { pluginFile, grants: { network, childProcess } }.
 * Never imports anything from forge itself: the process may only read the
 * plugin's directory (plus what the grants add), so this file stays
 * dependency-free.
 */
import net from "node:net"
import tls from "node:tls"
import http from "node:http"
import https from "node:https"
import http2 from "node:http2"
import dgram from "node:dgram"
import dns from "node:dns"
import v8 from "node:v8"
import traceEvents from "node:trace_events"
import mod from "node:module"
import { pathToFileURL } from "node:url"

const { pluginFile, grants } = JSON.parse(process.argv[2] || "{}")
const bare = (s) => String(s).replace(/^node:/, "")

function deny(what) {
  const e = new Error(`plugin capability denied: ${what} (declare it in the plugin's "capabilities" and grant it in ~/.forge/config.json tools.pluginGrants)`)
  e.code = "ERR_PLUGIN_CAPABILITY"
  throw e
}
const denyFn = (what) => function () { deny(what) }
const seal = (obj, key, value) => { try { Object.defineProperty(obj, key, { value, writable: false, configurable: false, enumerable: false }) } catch { /* already sealed */ } }

// --- 1. builtin allow-list --------------------------------------------------
// Plain library builtins a plugin may use. Everything not listed is refused:
// vm, v8, inspector*, trace_events, report, repl, module, worker_threads,
// cluster, sqlite, sea, wasi, test, every `_`-prefixed internal — and the
// network / child_process families unless granted.
const SAFE_BUILTINS = [
  "assert", "assert/strict", "async_hooks", "buffer", "console", "constants", "crypto", "diagnostics_channel", "domain", "events",
  "fs", "fs/promises", "os", "path", "path/posix", "path/win32", "perf_hooks", "process", "punycode", "querystring",
  "readline", "readline/promises", "stream", "stream/consumers", "stream/promises", "stream/web", "string_decoder", "sys",
  "timers", "timers/promises", "tty", "url", "util", "util/types", "zlib",
  "_stream_duplex", "_stream_passthrough", "_stream_readable", "_stream_transform", "_stream_writable",
]
const NETWORK_BUILTINS = [
  "net", "tls", "http", "https", "http2", "dgram", "dns", "dns/promises",
  "_http_agent", "_http_client", "_http_common", "_http_incoming", "_http_outgoing", "_http_server", "_tls_common", "_tls_wrap",
]
const allowed = new Set(SAFE_BUILTINS)
if (grants?.network === true) for (const m of NETWORK_BUILTINS) allowed.add(m)
if (grants?.childProcess === true) allowed.add("child_process")
const isBuiltin = typeof mod.isBuiltin === "function" ? (s) => mod.isBuiltin(s) : (s) => mod.builtinModules.includes(bare(s))
const gate = (spec) => { if (isBuiltin(spec) && !allowed.has(bare(spec))) deny(spec) }

// module graph: ESM import() / static imports / import.meta.resolve.
// Node ≥ 22.15 has synchronous in-thread hooks. Older runtimes (Node 20) only
// have `module.register` hooks on the loader thread — those need the worker
// permission, which plugins.js grants ONLY on such runtimes; the plugin still
// cannot reach `worker_threads` (module gate below on all three routes).
if (typeof mod.registerHooks === "function") {
  mod.registerHooks({
    resolve(spec, ctx, next) { gate(spec); return next(spec, ctx) },
    load(url, ctx, next) { if (url.startsWith("node:")) gate(url); return next(url, ctx) },
  })
} else {
  const hooks = `import { isBuiltin } from "node:module"
let allowed
export function initialize(list) { allowed = new Set(list) }
const bare = (s) => String(s).replace(/^node:/, "")
function gate(spec) {
  if (isBuiltin(spec) && !allowed.has(bare(spec))) {
    const e = new Error("plugin capability denied: " + spec + " (declare it in the plugin capabilities and grant it in ~/.forge/config.json tools.pluginGrants)")
    e.code = "ERR_PLUGIN_CAPABILITY"
    throw e
  }
}
export async function resolve(spec, ctx, next) { gate(spec); return next(spec, ctx) }
export async function load(url, ctx, next) { if (url.startsWith("node:")) gate(url); return next(url, ctx) }`
  mod.register("data:text/javascript," + encodeURIComponent(hooks), { data: [...allowed] })
}
// require() / createRequire() / CJS plugins (all Node versions)
const origLoad = mod.Module._load
mod.Module._load = function (request, ...rest) { gate(request); return origLoad.call(this, request, ...rest) }
// the routes around the module graph
const origGetBuiltin = process.getBuiltinModule
if (typeof origGetBuiltin === "function") seal(process, "getBuiltinModule", (id) => { gate(id); return origGetBuiltin.call(process, id) })
seal(process, "binding", denyFn("process.binding"))
seal(process, "_linkedBinding", denyFn("process._linkedBinding"))
seal(process, "dlopen", denyFn("process.dlopen"))
// signals: a plugin must not be able to signal the agent (or the process group)
seal(process, "kill", denyFn("process.kill"))
seal(process, "_kill", denyFn("process.kill"))
seal(process, "_debugProcess", denyFn("process._debugProcess"))
seal(process, "_debugEnd", denyFn("process._debugEnd"))
seal(process, "report", undefined) // diagnostic reports are files written outside the fs grants
// diagnostics that write files WITHOUT going through the permission model:
// a heap snapshot near the heap limit lands in cwd (the project), a trace
// session writes node_trace.N.log into cwd, V8 flags can point logs anywhere.
for (const k of ["setHeapSnapshotNearHeapLimit", "writeHeapSnapshot", "getHeapSnapshot", "setFlagsFromString", "startCpuProfile", "takeCoverage", "stopCoverage"]) if (typeof v8[k] === "function") seal(v8, k, denyFn(`v8.${k}`))
seal(traceEvents, "createTracing", denyFn("trace_events.createTracing"))
mod.registerHooks = denyFn("module.registerHooks")
mod.register = denyFn("module.register")
mod.syncBuiltinESMExports()
Object.freeze(mod.Module) // `Module._load` (the require() gate) can no longer be swapped back
Object.freeze(mod)

// --- 2./3. network primitives + globals -------------------------------------
if (grants?.network !== true) {
  const stub = (obj, key, what) => { if (obj && typeof obj[key] === "function") seal(obj, key, denyFn(what)) }
  stub(net.Socket.prototype, "connect", "network (net.Socket#connect)")
  stub(net.Server.prototype, "listen", "network (net.Server#listen)")
  stub(net.Server.prototype, "_listen2", "network (net.Server#listen)")
  for (const k of ["connect", "createConnection"]) stub(net, k, "network (net.connect)")
  stub(tls, "connect", "network (tls.connect)")
  for (const m of [http, https]) {
    for (const k of ["request", "get"]) stub(m, k, "network (http.request)")
    stub(m.Agent?.prototype, "createConnection", "network (http.Agent#createConnection)")
  }
  stub(http2, "connect", "network (http2.connect)")
  for (const k of ["bind", "send", "connect"]) stub(dgram.Socket?.prototype, k, "network (dgram)")
  stub(dgram, "createSocket", "network (dgram)")
  const dnsp = dns.promises
  for (const o of [dns, dnsp]) for (const k of Object.keys(o)) if (typeof o[k] === "function" && /^(lookup|resolve|reverse)/.test(k)) stub(o, k, "network (dns)")
  for (const R of [dns.Resolver, dnsp?.Resolver]) if (R) for (const k of Object.getOwnPropertyNames(R.prototype)) if (k !== "constructor" && /^(resolve|reverse|lookup)/.test(k)) stub(R.prototype, k, "network (dns)")
  mod.syncBuiltinESMExports()
  for (const g of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]) seal(globalThis, g, undefined)
}

// --- plugin loading ---------------------------------------------------------
const NAME_RE = /^[a-z][a-z0-9_]{1,40}$/i
const MAX_RESULT = 1024 * 1024 // 1 MB of plugin output per call
const MAX_INBOUND = 4 * 1024 * 1024 // host → plugin frame bound

function meta(t) {
  // only plain data crosses the boundary — never functions or prototypes
  const caps = t && typeof t === "object" && t.capabilities && typeof t.capabilities === "object" ? t.capabilities : {}
  return {
    name: t?.name, description: t?.description, parameters: safeJson(t?.parameters), readOnly: t?.readOnly === true, hasRun: typeof t?.run === "function",
    capabilities: {
      network: caps.network === true,
      childProcess: caps.childProcess === true,
      read: Array.isArray(caps.read) ? caps.read.map(String).slice(0, 32) : [],
      write: Array.isArray(caps.write) ? caps.write.map(String).slice(0, 32) : [],
      env: Array.isArray(caps.env) ? caps.env.map(String).slice(0, 32) : [],
    },
    timeoutMs: Number.isFinite(t?.timeoutMs) ? Math.max(1000, Math.min(120000, t.timeoutMs)) : null,
  }
}
function safeJson(v) { try { return JSON.parse(JSON.stringify(v)) } catch { return null } }

let tools = new Map()
async function load() {
  const m = await import(pathToFileURL(pluginFile).href)
  const candidates = []
  if (m.default) candidates.push(m.default)
  if (Array.isArray(m.tools)) candidates.push(...m.tools)
  const out = []
  for (const t of candidates) {
    const md = meta(t)
    out.push(md)
    if (typeof md.name === "string" && NAME_RE.test(md.name) && md.hasRun) tools.set(md.name, t)
  }
  return out
}

// --- channel (fd 3) ---------------------------------------------------------
// fd 3 is the pipe plugins.js opened; wrapping an EXISTING fd never calls the
// (stubbed) connect(). The plugin cannot reach `chan` — it is module-local.
const chan = new net.Socket({ fd: 3, readable: true, writable: true })
chan.setEncoding("utf8")
const send = (o) => { try { chan.write(JSON.stringify(o) + "\n") } catch { process.exit(0) } }
let inbuf = ""
chan.on("data", (d) => {
  inbuf += d
  if (inbuf.length > MAX_INBOUND) process.exit(2)
  let i
  while ((i = inbuf.indexOf("\n")) >= 0) {
    const line = inbuf.slice(0, i)
    inbuf = inbuf.slice(i + 1)
    let msg
    try { msg = JSON.parse(line) } catch { process.exit(2) }
    handle(msg).catch(() => {})
  }
})
// when the agent goes away (even by SIGKILL) the pipe closes and we exit
chan.on("end", () => process.exit(0))
chan.on("close", () => process.exit(0))
chan.on("error", () => process.exit(0))

async function handle(msg) {
  if (!msg || typeof msg !== "object") return
  if (msg.op === "probe") {
    try { send({ op: "probe", ok: true, tools: await load() }) }
    catch (e) { send({ op: "probe", ok: false, error: String(e?.message ?? e).slice(0, 300) }) }
    return
  }
  if (msg.op === "call") {
    const { id, name, args, ctx } = msg
    try {
      if (!tools.size) await load()
      const t = tools.get(name)
      if (!t) throw new Error(`plugin tool "${name}" not found in ${pluginFile}`)
      const r = await t.run(args ?? {}, { cwd: ctx?.cwd, readOnly: ctx?.readOnly === true })
      let result = typeof r === "string" ? r : JSON.stringify(r ?? null)
      if (typeof result !== "string") result = String(result)
      if (result.length > MAX_RESULT) result = result.slice(0, MAX_RESULT) + `\n... (plugin output truncated at ${MAX_RESULT} chars)`
      send({ op: "call", id, result })
    } catch (e) {
      send({ op: "call", id, error: `${e?.code === "ERR_PLUGIN_CAPABILITY" || e?.code === "ERR_ACCESS_DENIED" ? "capability denied: " : ""}${String(e?.message ?? e).slice(0, 300)}` })
    }
  }
}
send({ op: "ready" })
