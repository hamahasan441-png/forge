/**
 * forge — config file engine (zero dependencies)
 *
 * Resolution order (highest wins):
 *   1. CLI flags (--provider --model --key --base-url)
 *   2. Environment variables (FORGE_PROVIDER, <PROVIDER>_API_KEY)
 *   3. Project-local  ./forge.config.json
 *   4. User-global    ~/.forge/config.json   ← canonical, wizard writes here
 *   5. Built-in defaults
 */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

export const DEFAULT_DIR = process.env.FORGE_HOME || path.join(os.homedir(), ".forge")
export const USER_CONFIG_PATH = process.env.FORGE_CONFIG || path.join(DEFAULT_DIR, "config.json")
export const PROJECT_CONFIG_NAME = "forge.config.json"
export const SESSIONS_DIR = path.join(DEFAULT_DIR, "sessions")

export function defaultConfig() {
  return {
    version: 1,
    activeProvider: "",
    providers: {}, // name -> { apiKey, baseUrl, model }
    skills: { enabled: true, dir: "" },
    agent: { maxSteps: 25, timeoutSec: 45, maxToolOutput: 12000, maxToolCalls: 80, delegateTimeoutSec: 180, maxParallelSubAgents: 2 },
    chat: { stream: true, system: "", showReasoning: true, maxHistoryMessages: 40, tools: true, compact: true, compactAtChars: 48000, profile: "auto", restoreCwd: true, historySize: 300 },
    tools: { searchUrl: "", allowOutsideProject: false, allowSudo: false, assumeYes: false, fetchPrivateUrls: false },
    retry: { attempts: 3, backoffMs: 1500, connectMs: 30000, firstByteMs: 120000, requestTimeoutMs: 180000 },
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"))
  } catch {
    return null
  }
}

function deepMerge(base, over) {
  if (!over || typeof over !== "object") return base
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out
}

export function loadConfig(explicitPath) {
  const sources = []
  let cfg = defaultConfig()

  const userPath = explicitPath || USER_CONFIG_PATH
  const userCfg = explicitPath ? readJson(explicitPath) : readJson(USER_CONFIG_PATH)
  if (userCfg) {
    cfg = deepMerge(cfg, userCfg)
    sources.push(userPath)
  }

  const projPath = path.join(process.cwd(), PROJECT_CONFIG_NAME)
  const projCfg = readJson(projPath)
  if (projCfg) {
    cfg = deepMerge(cfg, projCfg)
    sources.push(projPath)
  }

  if (process.env.FORGE_PROVIDER && !cfg.activeProvider) {
    cfg.activeProvider = process.env.FORGE_PROVIDER
    sources.push("env:FORGE_PROVIDER")
  }
  return { config: cfg, sources }
}

/** Persist config with 0600 perms — it may hold API keys. */
export function saveConfig(cfg, explicitPath) {
  const p = explicitPath || USER_CONFIG_PATH
  fs.mkdirSync(path.dirname(p), { recursive: true })
  if (fs.existsSync(p)) fs.chmodSync(p, 0o600)
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 })
  fs.chmodSync(p, 0o600)
  return p
}

export function maskKey(k) {
  if (!k) return "(not set)"
  const s = String(k)
  if (s.length <= 10) return s.slice(0, 2) + "***"
  return `${s.slice(0, 6)}...${s.slice(-4)}`
}

export function safeView(cfg) {
  const providers = {}
  for (const [name, p] of Object.entries(cfg.providers || {})) {
    providers[name] = { ...p, apiKey: maskKey(p.apiKey) }
  }
  return { ...cfg, providers }
}

export function getPath(obj, dotted) {
  let cur = obj
  for (const part of dotted.split(".")) {
    if (cur === undefined || cur === null) return undefined
    cur = cur[part]
  }
  return cur
}

export function setPath(obj, dotted, value) {
  const parts = dotted.split(".")
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  if (value === undefined) delete cur[parts[parts.length - 1]]
  else cur[parts[parts.length - 1]] = value
}

/** Remember a model under providers.<name>.models[] (most-recent first, max 8).
 *  This is what makes "choose a working, tested model" lists personal: every
 *  model you ever pick (wizard, /model, forge use --model) is remembered. */
export function pushRecentModel(cfg, providerName, model) {
  if (!model || !cfg?.providers?.[providerName]) return
  const entry = cfg.providers[providerName]
  const prev = Array.isArray(entry.models) ? entry.models.filter((m) => m && m !== model) : []
  entry.models = [model, ...prev].slice(0, 8)
}
