/**
 * forge — plugin worker host (v21.1 P0: plugin isolation).
 *
 * This file is the ENTRY of every plugin worker. It runs inside a
 * `worker_threads` Worker that plugins.js starts with Node's permission model
 * enabled (`--permission` + an explicit `--allow-fs-read/--allow-fs-write`
 * list, `--allow-child-process` only when granted). The permission model is
 * the hard boundary for filesystem, child processes, nested workers, native
 * addons, WASI and process.binding. Node has no `--allow-net`, so network is
 * closed here by removing every builtin that can open a socket from the module
 * graph BEFORE the plugin's code runs, and by removing the global HTTP APIs.
 * Bypass routes verified closed (see tests/test-plugin-isolation.mjs):
 * `process.getBuiltinModule`, `module.createRequire`, `module.register` /
 * `registerHooks` (short-circuit to a builtin), `new Function("import…")`,
 * `process.binding`, `process.dlopen`, `node:vm`, `node:sqlite` (which can
 * write files outside the permission model — denied outright).
 *
 * Protocol (parentPort):
 *   → { op: "probe" }                       ⇢ { ok, tools:[meta…] | error }
 *   → { op: "call", id, name, args, ctx }   ⇢ { id, result } | { id, error }
 * Never imports anything from forge itself: the worker may only read the
 * plugin's directory (plus what the grants add), so this file must stay
 * dependency-free.
 */
import { parentPort, workerData } from "node:worker_threads"
import mod from "node:module"
import { pathToFileURL } from "node:url"

const { pluginFile, grants } = workerData
const bare = (s) => String(s).replace(/^node:/, "")

// --- capability gates ------------------------------------------------------
const NET_MODULES = ["net", "http", "https", "http2", "tls", "dgram", "dns", "dns/promises"]
const ALWAYS_DENIED = ["child_process", "worker_threads", "cluster", "inspector", "inspector/promises", "v8", "vm", "repl", "module", "sqlite", "wasi", "trace_events"]
const denied = new Set(ALWAYS_DENIED)
if (!grants.network) for (const m of NET_MODULES) denied.add(m)
if (grants.childProcess) denied.delete("child_process")

function deny(what) {
  const e = new Error(`plugin capability denied: ${what} (declare it in the plugin's "capabilities" and grant it in ~/.forge/config.json tools.pluginGrants)`)
  e.code = "ERR_PLUGIN_CAPABILITY"
  throw e
}

// 1. module graph: every later import()/require()/createRequire of a denied
//    builtin fails at resolve AND load time (load catches short-circuited hooks)
mod.registerHooks({
  resolve(spec, ctx, next) { if (denied.has(bare(spec))) deny(spec); return next(spec, ctx) },
  load(url, ctx, next) { if (url.startsWith("node:") && denied.has(bare(url))) deny(url); return next(url, ctx) },
})
// 2. the routes around the module graph
const origGetBuiltin = process.getBuiltinModule
if (typeof origGetBuiltin === "function") {
  Object.defineProperty(process, "getBuiltinModule", { value: (id) => { if (denied.has(bare(id))) deny(id); return origGetBuiltin.call(process, id) }, writable: false, configurable: false })
}
Object.defineProperty(process, "binding", { value: () => deny("process.binding"), writable: false, configurable: false })
Object.defineProperty(process, "_linkedBinding", { value: () => deny("process._linkedBinding"), writable: false, configurable: false })
Object.defineProperty(process, "dlopen", { value: () => deny("process.dlopen"), writable: false, configurable: false })
mod.registerHooks = () => deny("module.registerHooks")
mod.register = () => deny("module.register")
mod.syncBuiltinESMExports()
// 3. global network APIs
if (!grants.network) {
  for (const g of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]) {
    Object.defineProperty(globalThis, g, { value: undefined, writable: false, configurable: false })
  }
}
Object.freeze(mod)

// --- plugin loading ---------------------------------------------------------
const NAME_RE = /^[a-z][a-z0-9_]{1,40}$/i
const MAX_RESULT = 1024 * 1024 // 1 MB of plugin output per call

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

parentPort.on("message", async (msg) => {
  if (!msg || typeof msg !== "object") return
  if (msg.op === "probe") {
    try { parentPort.postMessage({ op: "probe", ok: true, tools: await load() }) }
    catch (e) { parentPort.postMessage({ op: "probe", ok: false, error: String(e?.message ?? e).slice(0, 300) }) }
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
      parentPort.postMessage({ op: "call", id, result })
    } catch (e) {
      parentPort.postMessage({ op: "call", id, error: `${e?.code === "ERR_PLUGIN_CAPABILITY" || e?.code === "ERR_ACCESS_DENIED" ? "capability denied: " : ""}${String(e?.message ?? e).slice(0, 300)}` })
    }
  }
})
parentPort.postMessage({ op: "ready" })
