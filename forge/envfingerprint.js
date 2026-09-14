/**
 * forge — ENVIRONMENT FINGERPRINT + DRIFT (v96 unifywise §50, zero dependencies)
 *
 * The engineering meaning of a run depends on the environment it ran in: a
 * checkpoint taken under Node 20 restored under Node 24, a native module
 * compiled for arm64 reused on x64, a Docker-dependent verification strategy
 * on a machine without Docker. Until now Forge sampled LIVE resources
 * (resources.js) and classified failure ORIGIN (selfdiag.js), but nothing
 * recorded WHAT environment a task ran in or noticed when it CHANGED.
 *
 * This module is that missing piece — deliberately small and deterministic:
 *
 *   capture()   — a bounded snapshot of the current environment (process
 *                 facts are free; toolchain facts are stat-only presence
 *                 checks + lazily-probed versions, memoized per process so
 *                 a task never pays for the same probe twice)
 *   load(persisted)/save — per-project persistence (env.json under the
 *                 project dir, atomic via securefs, like every other store)
 *   diff(before, after) — the honest drift report: added/removed/changed
 *                 toolchains with a deterministic engineering-impact note
 *                 per signal (advisory, never a gate — drift is a WARNING,
 *                 not a failure)
 *
 * Honesty rules (house style):
 *   - a binary that is not on PATH is ABSENT, never "version unknown"
 *   - a version probe that fails records null — never a guessed string
 *   - drift is advisory: it changes NO completion decision by itself
 *   - everything bounded: one JSON file, ≤ 24 tracked binaries, TTL'd
 *     version probes (a version is re-probed at most once per day)
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { projectDir } from "./memory.js"
import { writeStateFile } from "./securefs.js"

export const ENV_FILE = "env.json"
export const ENV_SCHEMA = 1
/** Tracked toolchains: the ecosystems Forge's language/runtime/verify layers reason about. */
export const TRACKED = [
  "node", "npm", "pnpm", "yarn", "bun",
  "python", "python3", "pip",
  "go", "rustc", "cargo",
  "java", "dotnet",
  "git", "docker",
]
const MAX_TRACKED = 24
/** Version probes are memoized per process AND persisted with a TTL — probing
 *  14 binaries per task start would be waste; per day is drift-relevant. */
const VERSION_TTL_MS = 24 * 60 * 60 * 1000
const PROBE_TIMEOUT_MS = 2500

const enabled = () => {
  const v = String(process.env.FORGE_ENVFP ?? "").toLowerCase()
  return !(v === "0" || v === "false" || v === "off")
}

function binaryOnPath(bin) {
  // stat-only presence check (never executes anything)
  const dirs = String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  for (const d of dirs) {
    try {
      const p = path.join(d, bin + (process.platform === "win32" ? ".exe" : ""))
      fs.accessSync(p, fs.constants.X_OK)
      return true
    } catch { /* keep scanning */ }
  }
  return false
}

/** Probe a toolchain version once per process (bounded, never throws). */
const versionMemo = new Map()
function probeVersion(bin) {
  if (versionMemo.has(bin)) return versionMemo.get(bin)
  let v = null
  try {
    const r = spawnSync(bin, ["--version"], { timeout: PROBE_TIMEOUT_MS, encoding: "utf8", shell: process.platform === "win32" })
    if (!r.error && r.status === 0) {
      const m = String(r.stdout ?? "").match(/(\d+[._]\d+(?:[._]\d+)?)|(\d+)/)
      v = m ? (m[1] ?? m[2]) : String(r.stdout ?? "").trim().slice(0, 24) || null
    }
  } catch { v = null }
  versionMemo.set(bin, v)
  return v
}

/**
 * Capture the current environment fingerprint.
 * @param {{versionTtlMs?: number, persistedVersions?: Object<string, {v: string|null, at: number}>}} opts
 *   persistedVersions lets a caller reuse TTL-fresh version probes from disk
 *   instead of re-probing (the task-start path passes the previous file's).
 */
export function capture({ persistedVersions = null } = {}) {
  if (!enabled()) return null
  const now = Date.now()
  const toolchains = {}
  const count = Math.min(TRACKED.length, MAX_TRACKED)
  for (let i = 0; i < count; i++) {
    const bin = TRACKED[i]
    const present = binaryOnPath(bin)
    if (!present) { toolchains[bin] = { present: false, version: null }; continue }
    // reuse a TTL-fresh persisted probe before spawning anything
    const prev = persistedVersions?.[bin]
    if (prev && typeof prev.at === "number" && now - prev.at < VERSION_TTL_MS && prev.version !== undefined) {
      toolchains[bin] = { present: true, version: prev.version ?? null, at: prev.at }
      versionMemo.set(bin, prev.version ?? null)
      continue
    }
    toolchains[bin] = { present: true, version: probeVersion(bin), at: now }
  }
  return {
    schema: ENV_SCHEMA,
    at: now,
    platform: process.platform,
    os: (os.release() || "").slice(0, 40),
    arch: process.arch,
    cpuModel: (os.cpus()[0]?.model || "").slice(0, 60),
    cpuCount: os.cpus().length,
    memBytes: os.totalmem(),
    node: process.version,
    shell: String(process.env.FORGE_SHELL ?? process.env.SHELL ?? "").slice(0, 60),
    toolchains,
  }
}

export function envPath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), ENV_FILE)
}

export function loadEnv(cwd = process.cwd()) {
  try {
    const raw = JSON.parse(fs.readFileSync(envPath(cwd), "utf8"))
    if (raw && raw.schema === ENV_SCHEMA) return raw
  } catch { /* absent/corrupt → no previous environment */ }
  return null
}

export function saveEnv(fp, cwd = process.cwd()) {
  if (!fp) return false
  try { return Boolean(writeStateFile(envPath(cwd), JSON.stringify(fp, null, 1))) } catch { return false }
}

/** Deterministic impact notes — advisory, one line per drift signal. */
const IMPACT = {
  node: "node major changed — native modules and lockfile engines may be ABI-incompatible; reinstall dependencies before trusting old build/test evidence",
  npm: "npm major changed — lockfile format may differ; a fresh install is the honest baseline",
  python: "python version changed — virtualenvs, wheels and pinned deps may no longer resolve",
  go: "go version changed — module graph and build cache may be invalidated",
  rustc: "rustc version changed — crates.io pinned versions may compile differently; cargo build evidence from the old toolchain is stale",
  cargo: "cargo version changed — lockfile v-format may differ",
  java: "java version changed — bytecode target and vendored jars may mismatch",
  dotnet: ".NET SDK changed — restore/build evidence may not carry over",
  git: "git major changed — worktree/apply behaviors used by merge-back should be re-verified",
  docker: "docker availability changed — runtime/compose verification strategies may be unavailable now",
  arch: "architecture changed — compiled artifacts, checkpoints of native outputs and bench numbers are not comparable",
  platform: "platform changed — path semantics, shell behavior and runtime strategies from the previous environment do not carry over",
}

function impactFor(key) {
  if (IMPACT[key]) return IMPACT[key]
  if (key.startsWith("pnpm") || key.startsWith("yarn") || key.startsWith("bun")) return `${key} availability changed — the package manager assumed by prior evidence may not be the one that runs now`
  return `${key} availability changed — prior evidence that depended on it may be stale`
}

/**
 * Diff two fingerprints into an honest drift report.
 * @returns {{drifted: boolean, signals: Array<{kind: "added"|"removed"|"changed", key: string, from: string, to: string, impact: string}>, note: string}}
 */
export function diff(before, after) {
  if (!before || !after) return { drifted: false, signals: [], note: "" }
  const signals = []
  const push = (kind, key, from, to) => signals.push({ kind, key, from: String(from), to: String(to), impact: impactFor(key) })
  // process-level facts
  const major = (v) => String(v ?? "").split(".").filter(Boolean)[0] ?? ""
  if (major(before.node) !== major(after.node)) push("changed", "node", before.node, after.node)
  if (before.arch !== after.arch) push("changed", "arch", before.arch, after.arch)
  if (before.platform !== after.platform) push("changed", "platform", before.platform, after.platform)
  // toolchains: presence and major version (node is already covered by the
  // process-level check above — skip it here so it cannot double-report)
  const keys = new Set([...Object.keys(before.toolchains ?? {}), ...Object.keys(after.toolchains ?? {})])
  keys.delete("node")
  for (const k of keys) {
    const b = before.toolchains?.[k] ?? { present: false, version: null }
    const a = after.toolchains?.[k] ?? { present: false, version: null }
    if (!b.present && a.present) push("added", k, "absent", a.version ? `${k} ${a.version}` : `${k} present`)
    else if (b.present && !a.present) push("removed", k, b.version ? `${k} ${b.version}` : `${k} present`, "absent")
    else if (b.present && a.present && major(b.version) !== major(a.version)) push("changed", k, `${k} ${b.version ?? "?"}`, `${k} ${a.version ?? "?"}`)
  }
  const drifted = signals.length > 0
  return {
    drifted,
    signals,
    note: drifted
      ? `environment drifted since the last task here (${signals.map((s) => `${s.kind}:${s.key}`).slice(0, 6).join(", ")}) — prior evidence that depended on the old environment is POTENTIALLY STALE, not wrong`
      : "",
  }
}

/**
 * The task-start entry point: capture now, diff against the persisted
 * fingerprint, save the new one. Never throws; returns an honest report.
 * @returns {{ok: boolean, drift: object|null, saved: boolean, fingerprint: object|null}}
 */
export function checkEnvironment({ cwd = process.cwd() } = {}) {
  if (!enabled()) return { ok: false, drift: null, saved: false, fingerprint: null }
  try {
    const prev = loadEnv(cwd)
    // reuse TTL-fresh version probes from the previous file (no re-probe cost)
    const fp = capture({ persistedVersions: prev?.toolchains ?? null })
    if (!fp) return { ok: false, drift: null, saved: false, fingerprint: null }
    const drift = prev ? diff(prev, fp) : { drifted: false, signals: [], note: "" }
    const saved = saveEnv(fp, cwd)
    return { ok: true, drift, saved, fingerprint: fp }
  } catch {
    return { ok: false, drift: null, saved: false, fingerprint: null }
  }
}

/** Bounded one-line drift summary for events/prompts (≤ 300 chars). */
export function formatDrift(drift) {
  if (!drift || !drift.drifted) return ""
  const head = drift.signals.slice(0, 4).map((s) => `${s.key} ${s.from} → ${s.to}`).join("; ")
  return `[env drift] ${head}${drift.signals.length > 4 ? ` (+${drift.signals.length - 4} more)` : ""} — prior environment-dependent evidence is POTENTIALLY STALE`.slice(0, 300)
}
