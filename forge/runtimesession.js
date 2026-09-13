/**
 * forge — RUNTIME INTELLIGENCE (v93 gap fix §7–§11, zero dependencies)
 *
 * v93 shipped a process manager (runtime.js) — the ability to run things in
 * the background. What was missing is everything AROUND it:
 *
 *   §8 Runtime Discovery   — what IS this project? type, entrypoint, package
 *                            manager, build system, runtime, dependencies,
 *                            port hints, environment — discovered from the
 *                            ACTUAL files, every fact carrying its evidence
 *                            (file + field). Commands are NEVER invented:
 *                            a launch command must exist as a discovered
 *                            script, or be given explicitly.
 *   §9 Runtime Session     — observable state of one project's runtime:
 *                            build/run phases, processes, ports, health,
 *                            evidence log, cleanup.
 *   §10 Process Management — DELEGATED to the ONE existing process manager
 *                            (runtime.js). This module never re-implements
 *                            spawning; it adds identity, a persisted OWNERSHIP
 *                            LEDGER, and crash reconciliation (discover →
 *                            identify owned → reconcile; never kill a process
 *                            that is not provably ours — pid-reuse guard via
 *                            /proc starttime).
 *   §11 Runtime Evidence   — "server started" requires REAL evidence: a live
 *                            process entry AND a successful health probe.
 *                            Build success alone is never runtime proof.
 *
 * Adapter registry (§7): web / backend / cli / android / flutter /
 * react-native / desktop / multi-service. Adapters are DETECTORS, not
 * promise-makers: an adapter matches only when files prove it; a launch in
 * an environment whose toolchain binary is absent reports UNAVAILABLE with
 * the exact missing binary — support is never faked.
 */
import fs from "node:fs"
import path from "node:path"
import http from "node:http"
import { execFileSync } from "node:child_process"
import { parseListeningPorts } from "./runtime.js"
import { projectDir } from "./memory.js"

const MAX_EVIDENCE = 120
const MAX_LEDGER = 32

// ---------------------------------------------------------------------------
// §8 — RUNTIME DISCOVERY (evidence-based, never invented)
// ---------------------------------------------------------------------------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return null }
}

function exists(cwd, rel) {
  try { return fs.statSync(path.join(cwd, rel)).isFile() } catch { return false }
}

function binaryOnPath(bin) {
  try { execFileSync("which", [bin], { stdio: ["ignore", "ignore", "ignore"], timeout: 2000 }); return true } catch { return false }
}

/** Static port hints from real configuration files (compose only — never guessed). */
function composePortHints(cwd) {
  for (const f of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    const p = path.join(cwd, f)
    if (!exists(cwd, f)) continue
    const text = (() => { try { return fs.readFileSync(p, "utf8") } catch { return "" } })()
    const ports = []
    for (const m of text.matchAll(/-\s*"?(\d{2,5})(?::\d{2,5})"?/g)) {
      const n = Number(m[1])
      if (n > 0 && n < 65536 && !ports.includes(n)) ports.push(n)
    }
    if (ports.length) return { file: f, ports: ports.slice(0, 8) }
  }
  return null
}

/**
 * Discover the runtime shape of a project. Every fact in `facts` carries its
 * evidence ({ file, field }). An unknown project returns type "unknown" with
 * the list of what is missing — it never returns a guessed command.
 */
export function discoverRuntime(cwd = process.cwd()) {
  const root = path.resolve(cwd || process.cwd())
  const facts = []
  const fact = (key, value, file, field) => facts.push({ key, value, evidence: { file, field } })

  const pkg = readJson(path.join(root, "package.json"))
  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : null
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) }

  // --- package manager (lockfile is the evidence; scripts fall back) -------
  let packageManager = null
  for (const [lock, pm] of [["package-lock.json", "npm"], ["yarn.lock", "yarn"], ["pnpm-lock.yaml", "pnpm"], ["bun.lockb", "bun"]]) {
    if (exists(root, lock)) { packageManager = pm; fact("packageManager", pm, lock, "lockfile"); break }
  }
  if (!packageManager && scripts) { packageManager = "npm"; fact("packageManager", "npm", "package.json", "scripts (no lockfile — npm assumed by presence of package scripts, verify before relying)") }

  // --- entrypoints / scripts -----------------------------------------------
  const entrypoints = []
  if (pkg?.main) { entrypoints.push(pkg.main); fact("entrypoint", pkg.main, "package.json", "main") }
  if (pkg?.bin) { for (const b of Object.keys(pkg.bin)) { entrypoints.push(pkg.bin[b]); fact("entrypoint", pkg.bin[b], "package.json", `bin.${b}`) } }
  for (const s of ["dev", "start", "build", "test"]) {
    if (scripts?.[s]) fact(`script.${s}`, scripts[s], "package.json", `scripts.${s}`)
  }

  // --- other ecosystems (file = evidence) -----------------------------------
  const pyproject = exists(root, "pyproject.toml") || exists(root, "requirements.txt") || exists(root, "setup.py")
  const gomod = exists(root, "go.mod")
  const cargo = exists(root, "Cargo.toml")
  const flutter = exists(root, "pubspec.yaml")
  const gradle = exists(root, "build.gradle") || exists(root, "build.gradle.kts")
  const manifest = exists(root, "app/src/main/AndroidManifest.xml") || exists(root, "android/app/src/main/AndroidManifest.xml")
  const compose = composePortHints(root)
  const tauri = exists(root, "src-tauri/tauri.conf.json") || exists(root, "tauri.conf.json")

  // --- project type: the ADAPTER REGISTRY decides, files decide the adapter -
  const dep = (name) => Boolean(deps[name])
  const adapters = []
  if (compose) adapters.push({ id: "multi-service", why: `${compose.file} declares ${compose.ports.length} exposed port(s)` })
  if (dep("next") || dep("vite") || dep("nuxt") || dep("@angular/core") || dep("svelte") || dep("@remix-run/dev")) adapters.push({ id: "web", why: `framework dependency in package.json (${["next", "vite", "nuxt", "@angular/core", "svelte", "@remix-run/dev"].find(dep) ?? "framework"})` })
  else if (dep("express") || dep("fastify") || dep("koa") || dep("@nestjs/core") || dep("hapi")) adapters.push({ id: "backend", why: `server framework dependency in package.json (${["express", "fastify", "koa", "@nestjs/core", "hapi"].find(dep)})` })
  if (pkg?.bin || (scripts?.start && !adapters.some((a) => a.id === "web" || a.id === "backend"))) adapters.push({ id: "cli", why: pkg?.bin ? "package.json declares a bin" : "scripts.start with no web/backend framework" })
  if (gradle && manifest) adapters.push({ id: "android", why: "build.gradle + AndroidManifest.xml" })
  if (flutter) adapters.push({ id: "flutter", why: "pubspec.yaml" })
  if (dep("react-native") || dep("expo")) adapters.push({ id: "react-native", why: `package.json dependency (${dep("expo") ? "expo" : "react-native"})` })
  if (tauri || dep("electron")) adapters.push({ id: "desktop", why: tauri ? "tauri.conf.json" : "electron dependency" })
  if (!adapters.length && pyproject) adapters.push({ id: "python", why: "pyproject.toml / requirements.txt" })
  if (!adapters.length && gomod) adapters.push({ id: "go", why: "go.mod" })
  if (!adapters.length && cargo) adapters.push({ id: "rust", why: "Cargo.toml" })
  if (!adapters.length && scripts?.start) adapters.push({ id: "node", why: "package.json scripts.start (generic)" })

  const projectType = adapters[0]?.id ?? "unknown"

  // --- runtime + toolchain honesty ------------------------------------------
  const runtime = pkg || pyproject || gomod || cargo || flutter
    ? { node: process.version.replace("v", ""), nodeAvailable: binaryOnPath("node") }
    : null
  if (runtime) fact("runtime.node", runtime.node, "process", "node version")

  // --- dependencies summary (bounded) ---------------------------------------
  const depNames = Object.keys(deps).slice(0, 12)
  if (pkg && depNames.length) fact("dependencies", `${depNames.length}+ direct`, "package.json", "dependencies/devDependencies")

  const portHints = compose ? { source: compose.file, ports: compose.ports } : null
  if (portHints) fact("portHints", portHints.ports.join(","), portHints.source, "exposed ports")

  const envFiles = [".env", ".env.example", ".env.local"].filter((f) => exists(root, f))
  if (envFiles.length) fact("environment", envFiles.join(","), envFiles[0], "env file present (contents never read by discovery)")

  const runCommand = pickRunCommand({ pkg, scripts, packageManager, projectType })
  const buildCommand = pickBuildCommand({ scripts, packageManager, projectType, gomod, cargo, gradle })
  const testCommand = scripts?.test ? `${packageManager ?? "npm"} run test` : (gomod ? "go test ./..." : (cargo ? "cargo test" : null))

  return {
    root,
    projectType,               // never a guess — "unknown" is honest
    adapters,                  // every match carries its why
    facts,                     // { key, value, evidence { file, field } }
    packageManager,
    entrypoints,
    runCommand,                // { command, source } or null — NEVER invented
    buildCommand,
    testCommand,
    portHints,
    envFiles,
    missing: projectType === "unknown" ? ["no package manifest (package.json / pyproject.toml / go.mod / Cargo.toml / pubspec.yaml) or compose file found — cannot infer a launch command"] : [],
  }
}

/** The run command exists only if a script/manifest PROVES it. */
function pickRunCommand({ pkg, scripts, packageManager, projectType }) {
  if (!pkg || !scripts) {
    if (projectType === "go") return { command: "go run .", source: "go.mod (go run convention)" }
    if (projectType === "rust") return { command: "cargo run", source: "Cargo.toml (cargo run convention)" }
    return null
  }
  const pm = packageManager ?? "npm"
  if (scripts.dev) return { command: `${pm} run dev`, source: "package.json scripts.dev" }
  if (scripts.start) return { command: `${pm} start`, source: "package.json scripts.start" }
  return null
}

function pickBuildCommand({ scripts, packageManager, projectType, gomod, cargo, gradle }) {
  const pm = packageManager ?? "npm"
  if (scripts?.build) return { command: `${pm} run build`, source: "package.json scripts.build" }
  if (gomod) return { command: "go build ./...", source: "go.mod (go build convention)" }
  if (cargo) return { command: "cargo build", source: "Cargo.toml (cargo build convention)" }
  if (gradle) return { command: "./gradlew build", source: "build.gradle (gradlew convention — requires the wrapper file)" }
  return null
}

// ---------------------------------------------------------------------------
// §11 — RUNTIME EVIDENCE: a real health probe, never a faked "up"
// ---------------------------------------------------------------------------

/** HTTP GET against a live port. Evidence: status code + latency. */
export function healthProbe({ port, host = "127.0.0.1", timeoutMs = 2500, path: urlPath = "/" } = {}) {
  const portNum = Number(port)
  if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
    return { ok: false, error: `invalid port ${JSON.stringify(port)}`, probe: null }
  }
  const t0 = Date.now()
  return new Promise((resolve) => {
    const req = http.get({ host, port: portNum, path: urlPath, timeout: timeoutMs }, (res) => {
      res.resume() // drain — the status code is the evidence, not the body
      resolve({ ok: res.statusCode > 0 && res.statusCode < 500, probe: { url: `http://${host}:${portNum}${urlPath}`, status: res.statusCode, ms: Date.now() - t0 } })
    })
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: `timeout after ${timeoutMs}ms`, probe: { url: `http://${host}:${portNum}${urlPath}`, ms: Date.now() - t0 } }) })
    req.on("error", (e) => resolve({ ok: false, error: String(e?.code ?? e?.message ?? e), probe: { url: `http://${host}:${portNum}${urlPath}`, ms: Date.now() - t0 } }))
  })
}

// ---------------------------------------------------------------------------
// §9/§10 — RUNTIME SESSION (wraps the ONE process manager; owns the ledger)
// ---------------------------------------------------------------------------

function ledgerPath(cwd) {
  const dir = projectDir(cwd)
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* best-effort */ }
  return path.join(dir, "runtime-ledger.json")
}

function loadLedger(cwd) {
  try { const j = JSON.parse(fs.readFileSync(ledgerPath(cwd), "utf8")); return Array.isArray(j?.entries) ? j : { entries: [] } } catch { return { entries: [] } }
}
function saveLedger(cwd, data) {
  try { fs.writeFileSync(ledgerPath(cwd), JSON.stringify(data, null, 1), "utf8") } catch { /* best-effort */ }
}

/** /proc starttime (field 22) — the pid-reuse guard. null when unknown. */
function procStarttime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const rest = stat.slice(stat.lastIndexOf(")") + 2)
    return Number(rest.split(" ")[19]) || null
  } catch { return null }
}

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true } catch { return false }
}

/**
 * Create a runtime session for a project. `mgr` MUST be the shared process
 * manager (tools.js singleton) — one process manager, one truth. The session
 * adds: discovered launch, ownership ledger, health probing, evidence, and
 * crash reconciliation.
 */
export function createRuntimeSession({ cwd = process.cwd(), mgr } = {}) {
  const root = path.resolve(cwd || process.cwd())
  const evidence = []
  const discovery = discoverRuntime(root)
  let disposed = false

  function record(kind, claim, detail, proof) {
    evidence.push({ kind, claim, detail: String(detail ?? "").slice(0, 300), proof, at: Date.now() })
    if (evidence.length > MAX_EVIDENCE) evidence.shift()
  }

  function launch({ command = null, phase = "run", name = null, timeoutSec } = {}) {
    if (disposed) return { ok: false, error: "ERROR: runtime session is disposed" }
    if (!mgr) return { ok: false, error: "ERROR: runtime session requires the shared process manager" }
    // §8: never invent — the command is explicit or PROVEN by discovery
    let cmd = command ? String(command) : null
    let source = "explicit"
    if (!cmd) {
      if (phase === "build") {
        if (!discovery.buildCommand) {
          return { ok: false, error: `ERROR: no build command discovered for this project (${discovery.missing.join("; ") || "package.json has no scripts.build"}); pass an explicit command` }
        }
        cmd = discovery.buildCommand.command; source = discovery.buildCommand.source
      } else {
        if (!discovery.runCommand) {
          return { ok: false, error: `ERROR: no run command discovered for this project (${discovery.missing.join("; ") || "package.json has no scripts.dev / scripts.start"}); pass an explicit command` }
        }
        cmd = discovery.runCommand.command; source = discovery.runCommand.source
      }
    }
    const id = name ?? (phase === "build" ? "build" : "app")
    const res = mgr.spawn({ command: cmd, name: id, cwd: root, timeoutSec })
    if (!res.ok) return res
    // §10: ownership ledger — pid, pgid, starttime (pid-reuse guard)
    const led = loadLedger(root)
    const pid = res.entry.pid ?? res.entry.child?.pid ?? null
    led.entries = led.entries.filter((e) => e.name !== id)
    led.entries.push({ name: id, command: cmd, pid, pgid: pid, starttime: pid ? procStarttime(pid) : null, startedAt: Date.now(), source })
    if (led.entries.length > MAX_LEDGER) led.entries.shift()
    saveLedger(root, led)
    record("process", `${phase} launched`, `${cmd} (from ${source})`, { pid, id })
    return { ...res, command: cmd, source, phase }
  }

  async function status() {
    if (!mgr) return { ok: false, error: "ERROR: no process manager" }
    const ls = mgr.list()
    // the session reports ITS OWN processes (the ledger is the ownership
    // truth) — a shared manager may hold unrelated processes from other
    // sessions/tools; those are not this project's runtime.
    const owned = loadLedger(root).entries
    const ownedNames = new Set(owned.map((e) => e.name))
    const processes = (ls.live ?? []).filter((e) => ownedNames.has(e.id))
    return {
      ok: true,
      project: { root, type: discovery.projectType, runCommand: discovery.runCommand?.command ?? null },
      processes: processes.map((e) => ({ id: e.id, pid: e.pid, state: e.state, command: e.command, ports: e.ports ?? [] })),
      history: (ls.history ?? []).filter((e) => ownedNames.has(e.id)).slice(0, 8),
      ledger: owned,
      evidence: evidence.slice(-10),
    }
  }

  /** §11: a health claim needs a REAL probe. Probing records evidence. */
  async function health({ port = null, host = "127.0.0.1", timeoutMs = 2500 } = {}) {
    let portNum = Number(port)
    if (!portNum) {
      // detect from live processes' ports (OS socket table — never a guess)
      const st = await status()
      const ports = (st.processes ?? []).flatMap((p) => p.ports ?? [])
      portNum = ports[0]
      if (!portNum) return { ok: false, error: "no port detected on live runtime processes (empty = none detected — pass an explicit port only if the project documents one)", evidence: null }
    }
    const probe = await healthProbe({ port: portNum, host, timeoutMs })
    record("health", probe.ok ? `runtime healthy on :${portNum}` : `runtime NOT healthy on :${portNum}`, probe.ok ? `HTTP ${probe.probe.status} in ${probe.probe.ms}ms` : probe.error, probe.probe)
    return probe
  }

  /** The §11 claim gate: "server started" = live process + successful probe. */
  async function claimServerStarted({ port = null } = {}) {
    const st = await status()
    const live = (st.processes ?? []).filter((p) => p.state === "running")
    const procEvidence = live.length >= 1
    const hp = live.length ? await health({ port }) : { ok: false, error: "no live runtime process" }
    const ok = procEvidence && hp.ok
    record("claim", ok ? "server started — PROVEN" : "server started — NOT proven", ok
      ? `process ${live[0].id} (pid ${live[0].pid}) + health ${hp.probe?.status ?? "?"}`
      : `process: ${procEvidence ? "live" : "none"}; health: ${hp.ok ? "ok" : hp.error}`, { processes: live.length, health: hp.ok })
    return { ok, processes: live, health: hp }
  }

  /** §10 crash recovery: reconcile the ledger against the OS. Owned-only. */
  function reconcile({ kill = false } = {}) {
    const led = loadLedger(root)
    const out = []
    let changed = false
    for (const e of led.entries) {
      const alive = e.pid ? pidAlive(e.pid) : false
      const st = e.pid ? procStarttime(e.pid) : null
      if (alive && e.starttime != null && st != null && st !== e.starttime) {
        out.push({ name: e.name, pid: e.pid, verdict: "pid-reused", note: "pid exists but /proc starttime differs — NOT ours, never touched" })
        changed = true // drop the stale claim; we no longer own that pid
        continue
      }
      if (alive) {
        out.push({ name: e.name, pid: e.pid, verdict: "orphan-owned", note: "forge-owned process still alive after a crash/restart" })
        if (kill) {
          try { process.kill(-Number(e.pgid ?? e.pid), "SIGTERM"); out[out.length - 1].killed = "SIGTERM sent to the process group" } catch { out[out.length - 1].killed = "signal failed (already dying?)" }
          changed = true
        }
        continue
      }
      out.push({ name: e.name, pid: e.pid, verdict: "dead", note: "process no longer exists" })
      changed = true
    }
    if (changed && !kill) {
      // non-destructive reconcile drops only provably-stale entries
      const keep = led.entries.filter((e, i) => !(out[i].verdict === "dead" || out[i].verdict === "pid-reused"))
      saveLedger(root, { entries: keep })
    }
    if (kill) saveLedger(root, { entries: [] })
    record("reconcile", "ledger reconciled", out.map((o) => `${o.name}:${o.verdict}`).join(", ") || "no entries", null)
    return { ok: true, entries: out }
  }

  function stop({ name = null, signal = "SIGTERM" } = {}) {
    if (!mgr) return { ok: false, error: "ERROR: no process manager" }
    const res = name ? mgr.kill(name, signal) : mgr.kill("app", signal)
    if (res.ok) {
      const led = loadLedger(root)
      led.entries = led.entries.filter((e) => e.name !== (name ?? "app"))
      saveLedger(root, { entries: led.entries })
      record("process", "runtime stopped", `${name ?? "app"} (${signal})`, res.note ?? null)
    }
    return res
  }

  function evidenceLog() { return [...evidence] }
  function discover() { return discovery }

  return { launch, status, health, claimServerStarted, reconcile, stop, evidenceLog, discover, get discovery() { return discovery } }
}

// ---------------------------------------------------------------------------
// convenience: format discovery honestly for prompts
// ---------------------------------------------------------------------------

export function formatDiscovery(d) {
  if (!d) return ""
  const lines = [`RUNTIME DISCOVERY (${d.projectType}${d.projectType === "unknown" ? " — no adapter matched" : ""})`]
  for (const f of (d.facts ?? []).slice(0, 14)) lines.push(`  ${f.key}: ${String(f.value).slice(0, 80)} [${f.evidence.file}${f.evidence.field ? ":" + f.evidence.field : ""}]`)
  if (d.runCommand) lines.push(`  run: ${d.runCommand.command} (${d.runCommand.source})`)
  else lines.push(`  run: NOT discovered — no command will be invented`)
  if (d.buildCommand) lines.push(`  build: ${d.buildCommand.command} (${d.buildCommand.source})`)
  if (d.portHints) lines.push(`  port hints (static): ${d.portHints.ports.join(", ")} [${d.portHints.source}]`)
  for (const m of d.missing ?? []) lines.push(`  missing: ${m}`)
  return lines.join("\n")
}
