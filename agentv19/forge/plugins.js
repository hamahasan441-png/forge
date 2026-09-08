/**
 * forge — tool plugin API (v20.2 P3-5, isolated v21.1).
 *
 * Drop a `*.mjs` file in ~/.forge/tools/ and its exported tool(s) become
 * available to the agent, alongside the built-ins and behind the SAME safety
 * choke point (output redaction; write-class plugins are serialized and blocked
 * in read-only sub-agents). Zero dependencies.
 *
 * A plugin module default-exports one tool object (or exports `tools: [...]`):
 *
 *   export default {
 *     name: "jira_issue",                       // ^[a-z][a-z0-9_]{1,40}$, unique, not a built-in
 *     description: "Fetch a Jira issue by key", // shown to the model
 *     parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
 *     readOnly: true,                           // optional; omit/false → treated as a WRITE tool
 *     capabilities: { network: true },          // optional; what the plugin NEEDS (see below)
 *     timeoutMs: 30000,                         // optional per-call limit (1s–120s)
 *     async run(args, ctx) { return "..." }     // returns a string; ctx = { cwd, readOnly }
 *   }
 *
 * v21.1 P0 — ISOLATION. v20 `import()`ed plugins straight into the agent
 * process: a plugin (or anything that could write ~/.forge/tools/, e.g. a
 * shell command the model ran) had the agent's full authority — API keys in
 * process.env, every file the user can reach, child processes, network.
 * Each plugin file now runs in its own CHILD PROCESS (`node plugin-host.js`)
 * started with Node's permission model (`--permission`; `--experimental-
 * permission` on Node 20), an empty environment, a heap limit, and a per-call
 * timeout. A separate process — not a worker thread — because a worker shares
 * the agent's pid and file descriptors (it could write into MCP servers'
 * stdin pipes, tamper with files the agent holds open, or signal the agent).
 * plugin-host.js closes the network and the escape hatches inside the child.
 * Messages travel over a dedicated pipe (fd 3) as newline-delimited JSON, never
 * Node's IPC channel (a malformed IPC frame crashes the RECEIVER, i.e. the
 * agent). By default a plugin may only READ its own directory and the project
 * it is invoked in. Everything else is a capability
 * the plugin must DECLARE (`capabilities`) AND the user must GRANT in
 * ~/.forge/config.json:
 *
 *   "tools": { "pluginGrants": { "jira.mjs": { "network": true, "env": ["JIRA_TOKEN"] },
 *                                "fmt.mjs":  { "write": ["."] } } }
 *
 * Effective capability = declared ∩ granted. Nothing is granted implicitly.
 * Grants can never cover ~/.forge itself (config.json holds the API keys).
 *
 * KNOWN LIMITATION (documented by Node for the permission model): symbolic
 * links inside a granted path are followed. A symlink placed in the PROJECT
 * that points at ~/.forge/config.json is therefore readable by a plugin through
 * the implicit project read grant. The project is already the model's write
 * surface, so treat plugins as PROJECT-trusted, not merely read-only; the
 * isolation suite prints the observed behaviour on every run.
 *
 * Loading is best-effort: a bad plugin is skipped with a recorded reason, never
 * crashing the agent.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import nodeModule from "node:module"
import { DEFAULT_DIR } from "./config.js"

export const PLUGINS_DIR = path.join(DEFAULT_DIR, "tools")
const HOST_FILE = fileURLToPath(new URL("./plugin-host.js", import.meta.url))

const NAME_RE = /^[a-z][a-z0-9_]{1,40}$/i
const PROBE_TIMEOUT_MS = 8000
const DEFAULT_CALL_TIMEOUT_MS = 30000
const MAX_HEAP_MB = 256
const MAX_OUTBOUND = 4 * 1024 * 1024 // plugin → host frame bound (1 MB result + envelope, with margin)

/**
 * The flag that turns the permission model on for THIS runtime: `--permission`
 * (Node ≥ 22.13 / 23.5, stable) or `--experimental-permission` (Node 20.x,
 * same enforcement, different spelling). null → this Node cannot enforce the
 * boundary and plugins are refused rather than run unprotected.
 */
export const PERMISSION_FLAG = (() => {
  const flags = process.allowedNodeEnvironmentFlags
  if (typeof flags?.has !== "function") return null
  if (flags.has("--permission")) return "--permission"
  if (flags.has("--experimental-permission")) return "--experimental-permission"
  return null
})()
/** True when this Node can enforce the boundary (v20+/v22+ permission model). */
export const PLUGIN_ISOLATION_AVAILABLE = PERMISSION_FLAG !== null
/** Node < 22.15 has no `module.registerHooks`; the child is the same binary. */
const NEEDS_ASYNC_MODULE_HOOKS = typeof nodeModule.registerHooks !== "function"

function validateTool(t, reserved, seen) {
  if (!t || typeof t !== "object") return "export is not a tool object"
  if (typeof t.name !== "string" || !NAME_RE.test(t.name)) return `invalid tool name ${JSON.stringify(t?.name)} (use ^[a-z][a-z0-9_]{1,40}$)`
  if (reserved.has(t.name)) return `name "${t.name}" collides with a built-in tool`
  if (seen.has(t.name)) return `duplicate tool name "${t.name}"`
  if (typeof t.description !== "string" || !t.description.trim()) return `tool "${t.name}" has no description`
  if (!t.parameters || typeof t.parameters !== "object" || t.parameters.type !== "object") {
    return `tool "${t.name}" parameters must be a JSON-schema object ({ type: "object", properties: {…} })`
  }
  if (!t.hasRun) return `tool "${t.name}" run must be a function`
  return null
}

// ---------------------------------------------------------------------------
// grants
// ---------------------------------------------------------------------------

/** Paths a grant may never cover, however it is spelled. */
function forbiddenGrantPath(abs, pluginDir) {
  const home = os.homedir()
  const real = (() => { try { return fs.realpathSync(abs) } catch { return abs } })()
  const inside = (p, dir) => { const rel = path.relative(dir, p); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)) }
  if (real === path.parse(real).root) return "the filesystem root"
  if (real === home) return "the whole home directory"
  if (inside(real, DEFAULT_DIR) || inside(DEFAULT_DIR, real)) return "forge's own state directory (~/.forge)"
  if (inside(real, path.join(home, ".forge")) || inside(path.join(home, ".forge"), real)) return "forge's own state directory (~/.forge)"
  if (pluginDir && (inside(real, pluginDir) || inside(pluginDir, real))) return "the plugin directory itself"
  for (const d of [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config/gcloud"]) if (inside(real, path.join(home, d))) return `credentials (~/${d})`
  return null
}

/**
 * Resolve the effective capability set for one plugin file.
 * @returns {{ network, childProcess, read: string[], write: string[], env: string[], notes: string[] }}
 */
export function resolveGrants(file, declared, granted, { cwd, pluginDir }) {
  const notes = []
  const d = declared || {}
  const g = granted && typeof granted === "object" ? granted : {}
  const eff = { network: false, childProcess: false, read: [], write: [], env: [], notes }
  const want = (cap) => d[cap] === true
  const has = (cap) => g[cap] === true
  if (want("network") || has("network")) {
    if (want("network") && has("network")) eff.network = true
    else notes.push(`${file}: network ${want("network") ? "declared but not granted" : "granted but not declared"} — denied`)
  }
  if (want("childProcess") || has("childProcess")) {
    if (want("childProcess") && has("childProcess")) eff.childProcess = true
    else notes.push(`${file}: childProcess ${want("childProcess") ? "declared but not granted" : "granted but not declared"} — denied`)
  }
  const resolveList = (kind) => {
    const dl = Array.isArray(d[kind]) ? d[kind].map(String) : []
    const gl = Array.isArray(g[kind]) ? g[kind].map(String) : []
    const out = []
    for (const raw of gl) {
      const abs = path.resolve(cwd, raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw)
      if (!dl.some((x) => path.resolve(cwd, x.startsWith("~") ? path.join(os.homedir(), x.slice(1)) : x) === abs)) { notes.push(`${file}: ${kind} grant "${raw}" is not declared by the plugin — ignored`); continue }
      const bad = forbiddenGrantPath(abs, pluginDir)
      if (bad) { notes.push(`${file}: ${kind} grant "${raw}" covers ${bad} — refused`); continue }
      out.push(abs)
    }
    for (const raw of dl) if (!gl.includes(raw)) notes.push(`${file}: ${kind} "${raw}" declared but not granted — denied`)
    return out
  }
  eff.read = resolveList("read")
  eff.write = resolveList("write")
  const de = Array.isArray(d.env) ? d.env.map(String) : []
  const ge = Array.isArray(g.env) ? g.env.map(String) : []
  eff.env = ge.filter((k) => de.includes(k) && /^[A-Z_][A-Z0-9_]*$/i.test(k))
  for (const k of de) if (!ge.includes(k)) notes.push(`${file}: env "${k}" declared but not granted — denied`)
  // implicit, always: read own dir + project
  eff.read = [...new Set([pluginDir, cwd, ...eff.read])]
  return eff
}

// ---------------------------------------------------------------------------
// worker lifecycle
// ---------------------------------------------------------------------------

class PluginWorker {
  constructor(file, full, grants, { cwd }) {
    this.file = file
    this.full = full
    this.grants = grants
    this.cwd = cwd
    this.child = null
    this.chan = null
    this.pending = new Map()
    this.nextId = 1
    this.ready = null
    this.inbuf = ""
  }

  execArgv() {
    const argv = [PERMISSION_FLAG, "--no-warnings", `--max-old-space-size=${MAX_HEAP_MB}`, `--allow-fs-read=${HOST_FILE}`]
    // Runtimes without synchronous module hooks (Node 20) gate ESM imports with
    // `module.register` hooks, which run on a loader thread → need the worker
    // permission. The plugin itself still cannot obtain `worker_threads`
    // (plugin-host.js refuses it on import/require/getBuiltinModule).
    if (NEEDS_ASYNC_MODULE_HOOKS) argv.push("--allow-worker")
    for (const r of this.grants.read) argv.push(`--allow-fs-read=${r}`)
    for (const w of this.grants.write) argv.push(`--allow-fs-write=${w}`)
    if (this.grants.childProcess) argv.push("--allow-child-process")
    return argv
  }

  env() {
    const e = {}
    for (const k of this.grants.env) if (process.env[k] !== undefined) e[k] = process.env[k]
    return e
  }

  /** Start (or restart) the plugin process; resolves when plugin-host says "ready". */
  start() {
    if (this.ready) return this.ready
    this.ready = new Promise((resolve, reject) => {
      let c
      try {
        c = spawn(process.execPath, [...this.execArgv(), HOST_FILE, JSON.stringify({ pluginFile: this.full, grants: { network: this.grants.network, childProcess: this.grants.childProcess } })], {
          cwd: this.cwd,
          env: this.env(), // NOT process.env — no NODE_OPTIONS, no API keys, nothing undeclared
          stdio: ["ignore", "pipe", "pipe", "pipe"], // plugin console output never reaches the user's terminal; fd 3 = protocol channel
          windowsHide: true,
        })
      } catch (e) { this.ready = null; return reject(e) }
      this.child = c
      this.chan = c.stdio[3]
      c.unref(); this.chan.unref?.()
      c.stdout?.on("data", () => {})
      c.stderr?.on("data", () => {})
      const t = setTimeout(() => { this.ready = null; this.kill(); reject(new Error("plugin process did not start in time")) }, PROBE_TIMEOUT_MS)
      let started = false
      this.chan.setEncoding("utf8")
      this.chan.on("data", (d) => {
        this.inbuf += d
        if (this.inbuf.length > MAX_OUTBOUND) { this._failAll(new Error(`plugin ${this.file} sent an oversized frame — process terminated`)); return this.kill() }
        let i
        while ((i = this.inbuf.indexOf("\n")) >= 0) {
          const line = this.inbuf.slice(0, i)
          this.inbuf = this.inbuf.slice(i + 1)
          let msg
          try { msg = JSON.parse(line) } catch { this._failAll(new Error(`plugin ${this.file} sent a malformed frame — process terminated`)); return this.kill() }
          if (!started) {
            if (msg?.op === "ready") { started = true; clearTimeout(t); resolve(c) }
            continue // nothing before "ready" is a reply
          }
          this._onMessage(msg)
        }
      })
      this.chan.on("error", () => {})
      c.on("error", (e) => { clearTimeout(t); this._failAll(e); this.ready = null; this.child = null; reject(e) })
      c.on("exit", (code, signal) => {
        clearTimeout(t)
        const err = new Error(`plugin process exited (${signal ? `signal ${signal}` : `code ${code}`})`)
        this._failAll(err); this.ready = null; this.child = null; this.chan = null
        if (!started) reject(err)
      })
    })
    return this.ready
  }

  _onMessage(msg) {
    if (!msg || typeof msg !== "object" || msg.op === "ready") return
    const key = msg.op === "probe" ? "probe" : msg.id
    const p = this.pending.get(key)
    if (!p) return
    this.pending.delete(key)
    clearTimeout(p.timer)
    if (msg.op === "probe") return msg.ok ? p.resolve(Array.isArray(msg.tools) ? msg.tools : []) : p.reject(new Error(String(msg.error ?? "probe failed")))
    if (msg.error !== undefined) return p.reject(new Error(String(msg.error)))
    p.resolve(typeof msg.result === "string" ? msg.result : String(msg.result ?? ""))
  }

  _failAll(err) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err) }
    this.pending.clear()
  }

  _send(key, payload, timeoutMs, onTimeout) {
    return new Promise((resolve, reject) => {
      if (!this.chan) return reject(new Error(`plugin ${this.file} is not running`))
      const timer = setTimeout(() => {
        this.pending.delete(key)
        onTimeout?.()
        reject(new Error(`plugin ${this.file} timed out after ${timeoutMs}ms — process terminated`))
      }, timeoutMs)
      this.pending.set(key, { resolve, reject, timer })
      try { this.chan.write(JSON.stringify(payload) + "\n") } catch (e) { clearTimeout(timer); this.pending.delete(key); reject(e) }
    })
  }

  async probe() {
    await this.start()
    return this._send("probe", { op: "probe" }, PROBE_TIMEOUT_MS, () => this.kill())
  }

  async call(name, args, ctx, timeoutMs) {
    await this.start()
    const id = this.nextId++
    // a timeout terminates the process: a plugin stuck in a loop cannot keep
    // running (and cannot keep the CPU) after the agent gave up on it. The next
    // call starts a fresh process.
    return this._send(id, { op: "call", id, name, args, ctx }, timeoutMs, () => this.kill())
  }

  kill() {
    const c = this.child
    this.child = null
    this.chan = null
    this.ready = null
    this.inbuf = ""
    if (c) { try { c.kill("SIGKILL") } catch {} }
  }
}

// ---------------------------------------------------------------------------
// loader
// ---------------------------------------------------------------------------

/**
 * Load tool plugins from `dir`.
 * @returns {{ tools: Array<{name, readOnly, def, run, source, capabilities}>, errors: string[], close(): void }}
 * `reserved` is the set/array of built-in tool names a plugin may not shadow.
 * `grants` is config.tools.pluginGrants ({ "<file>": {...} }); `cwd` the project.
 */
export async function loadToolPlugins(dir = PLUGINS_DIR, { reserved = [], grants = {}, cwd = process.cwd() } = {}) {
  const workers = []
  const result = { tools: [], errors: [], close: () => { for (const w of workers) w.kill() } }
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => (f.endsWith(".mjs") || f.endsWith(".js")) && !f.startsWith("."))
  } catch {
    return result // no plugins dir — fine
  }
  if (!files.length) return result
  if (!PLUGIN_ISOLATION_AVAILABLE) {
    // No fake sandbox: without the permission model there is no boundary, and
    // running the plugins in-process would silently hand them the agent's keys.
    result.errors.push(`plugins disabled: this Node (${process.version}) has no permission model (--permission / --experimental-permission); upgrade to Node ≥ 20.16 / 22 to run plugins`)
    return result
  }
  const reservedSet = new Set(reserved)
  const seen = new Set()
  const pluginDir = path.resolve(dir)
  for (const f of files.sort()) {
    const full = path.join(pluginDir, f)
    // grants are resolved twice: first with what the config says, then again
    // once the plugin's declaration is known (declared ∩ granted)
    const granted = grants?.[f] ?? grants?.[path.basename(f, path.extname(f))] ?? {}
    // probe with the MINIMUM (read own dir + project) — the declaration is data
    const probeGrants = resolveGrants(f, {}, {}, { cwd, pluginDir })
    const prober = new PluginWorker(f, full, probeGrants, { cwd })
    let metas
    try {
      metas = await prober.probe()
    } catch (e) {
      result.errors.push(`${f}: import failed — ${String(e?.message ?? e).slice(0, 160)}`)
      prober.kill()
      continue
    }
    prober.kill()
    if (!metas.length) {
      result.errors.push(`${f}: no default export (expected { name, description, parameters, run })`)
      continue
    }
    const declared = metas.reduce((acc, m) => {
      const c = m.capabilities || {}
      return { network: acc.network || c.network, childProcess: acc.childProcess || c.childProcess, read: [...acc.read, ...c.read], write: [...acc.write, ...c.write], env: [...acc.env, ...c.env] }
    }, { network: false, childProcess: false, read: [], write: [], env: [] })
    const eff = resolveGrants(f, declared, granted, { cwd, pluginDir })
    for (const n of eff.notes) result.errors.push(n)
    const runner = new PluginWorker(f, full, eff, { cwd })
    workers.push(runner)
    let accepted = 0
    for (const m of metas) {
      const err = validateTool(m, reservedSet, seen)
      if (err) { result.errors.push(`${f}: ${err}`); continue }
      seen.add(m.name)
      accepted++
      const timeoutMs = m.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
      result.tools.push({
        name: m.name,
        readOnly: m.readOnly === true,
        def: { type: "function", function: { name: m.name, description: String(m.description).slice(0, 500), parameters: m.parameters } },
        run: (args, ctx) => runner.call(m.name, args, { cwd: ctx?.cwd ?? cwd, readOnly: ctx?.readOnly === true }, timeoutMs),
        source: f,
        capabilities: { network: eff.network, childProcess: eff.childProcess, read: eff.read, write: eff.write, env: eff.env },
        isolated: true,
      })
    }
    if (!accepted) { runner.kill(); workers.pop() }
  }
  return result
}
