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
 * Each plugin file now runs in its own worker_threads Worker started with
 * Node's permission model (`--permission`), an empty environment, a heap
 * limit, and a per-call timeout. plugin-host.js closes the network and the
 * escape hatches inside the worker. By default a plugin may only READ its own
 * directory and the project it is invoked in. Everything else is a capability
 * the plugin must DECLARE (`capabilities`) AND the user must GRANT in
 * ~/.forge/config.json:
 *
 *   "tools": { "pluginGrants": { "jira.mjs": { "network": true, "env": ["JIRA_TOKEN"] },
 *                                "fmt.mjs":  { "write": ["."] } } }
 *
 * Effective capability = declared ∩ granted. Nothing is granted implicitly.
 * Grants can never cover ~/.forge itself (config.json holds the API keys).
 *
 * Loading is best-effort: a bad plugin is skipped with a recorded reason, never
 * crashing the agent.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { DEFAULT_DIR } from "./config.js"

export const PLUGINS_DIR = path.join(DEFAULT_DIR, "tools")
const HOST_FILE = fileURLToPath(new URL("./plugin-host.js", import.meta.url))

const NAME_RE = /^[a-z][a-z0-9_]{1,40}$/i
const PROBE_TIMEOUT_MS = 8000
const DEFAULT_CALL_TIMEOUT_MS = 30000
const MAX_HEAP_MB = 256
const MAX_STACK_MB = 4

/** True when this Node can enforce the boundary (v20+/v22+ permission model). */
export const PLUGIN_ISOLATION_AVAILABLE = typeof process.allowedNodeEnvironmentFlags?.has === "function" && process.allowedNodeEnvironmentFlags.has("--permission")

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
    this.worker = null
    this.pending = new Map()
    this.nextId = 1
    this.ready = null
  }

  execArgv() {
    const argv = ["--permission", "--no-warnings", `--allow-fs-read=${HOST_FILE}`]
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

  /** Start (or restart) the worker; resolves when plugin-host says "ready". */
  start() {
    if (this.ready) return this.ready
    this.ready = new Promise((resolve, reject) => {
      let w
      try {
        w = new Worker(HOST_FILE, {
          workerData: { pluginFile: this.full, grants: { network: this.grants.network, childProcess: this.grants.childProcess } },
          execArgv: this.execArgv(),
          env: this.env(),
          resourceLimits: { maxOldGenerationSizeMb: MAX_HEAP_MB, stackSizeMb: MAX_STACK_MB },
          stdout: true, stderr: true, // plugin console output never reaches the user's terminal
        })
      } catch (e) { this.ready = null; return reject(e) }
      this.worker = w
      w.unref()
      w.stdout?.on("data", () => {})
      w.stderr?.on("data", () => {})
      const t = setTimeout(() => { this.ready = null; this.kill(); reject(new Error("plugin worker did not start in time")) }, PROBE_TIMEOUT_MS)
      w.once("message", (m) => {
        if (m?.op === "ready") { clearTimeout(t); w.on("message", (msg) => this._onMessage(msg)); resolve(w) }
      })
      w.on("error", (e) => { clearTimeout(t); this._failAll(e); this.ready = null; reject(e) })
      w.on("exit", (code) => { this._failAll(new Error(`plugin worker exited (code ${code})`)); this.ready = null; this.worker = null })
    })
    return this.ready
  }

  _onMessage(msg) {
    if (!msg || msg.op === "ready") return
    const key = msg.op === "probe" ? "probe" : msg.id
    const p = this.pending.get(key)
    if (!p) return
    this.pending.delete(key)
    clearTimeout(p.timer)
    if (msg.op === "probe") return msg.ok ? p.resolve(msg.tools) : p.reject(new Error(msg.error))
    if (msg.error !== undefined) return p.reject(new Error(msg.error))
    p.resolve(msg.result)
  }

  _failAll(err) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err) }
    this.pending.clear()
  }

  _send(key, payload, timeoutMs, onTimeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        onTimeout?.()
        reject(new Error(`plugin ${this.file} timed out after ${timeoutMs}ms — worker terminated`))
      }, timeoutMs)
      this.pending.set(key, { resolve, reject, timer })
      this.worker.postMessage(payload)
    })
  }

  async probe() {
    await this.start()
    return this._send("probe", { op: "probe" }, PROBE_TIMEOUT_MS, () => this.kill())
  }

  async call(name, args, ctx, timeoutMs) {
    await this.start()
    const id = this.nextId++
    // a timeout terminates the worker: a plugin stuck in a loop cannot keep
    // running (and cannot keep the CPU) after the agent gave up on it. The next
    // call starts a fresh worker.
    return this._send(id, { op: "call", id, name, args, ctx }, timeoutMs, () => this.kill())
  }

  kill() {
    const w = this.worker
    this.worker = null
    this.ready = null
    if (w) { try { w.terminate() } catch {} }
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
    result.errors.push(`plugins disabled: this Node (${process.version}) has no permission model (--permission); upgrade to Node ≥ 20.16 / 22 to run plugins`)
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
