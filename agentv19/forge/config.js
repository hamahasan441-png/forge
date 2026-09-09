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
import { writeStateFile } from "./securefs.js"
import path from "node:path"
import os from "node:os"

export const DEFAULT_DIR = process.env.FORGE_HOME || path.join(os.homedir(), ".forge")
export const USER_CONFIG_PATH = process.env.FORGE_CONFIG || path.join(DEFAULT_DIR, "config.json")
export const PROJECT_CONFIG_NAME = "forge.config.json"
export const SESSIONS_DIR = path.join(DEFAULT_DIR, "sessions")

/**
 * v25 operational budgets. These are SAFETY FUSES, not the definition of
 * completion (verified objective satisfaction is). Raised so a real coding
 * agent can run tests, builds, and multi-file work without the v24 25-step /
 * 45-second / 12-step-segment stall. Catastrophic shellguard / SSRF /
 * project-write / plugin isolation boundaries are independent of these numbers
 * and are not relaxed here.
 *
 * `assumeYes`, `allowSudo`, `allowInterpreterEval`, `allowOutsideProject`,
 * `fetchPrivateUrls` stay FALSE in defaultConfig — project forge.config.json
 * still cannot set them. Autonomous runs opt into interpreter-eval and
 * in-project git danger at the agent/tool-context layer, never by flipping
 * those privileged keys.
 */
export const AGENT_BUDGETS = Object.freeze({
  maxSteps: 80,
  timeoutSec: 180,
  maxToolOutput: 32000,
  maxToolCalls: 250,
  delegateTimeoutSec: 300,
  maxParallelSubAgents: 6,
  segmentSteps: 32,
  maxSegments: 80,
  maxContinuations: 12,
  bashTimeoutCapSec: 900,
  maxStepsHardCap: 1000,
  maxToolCallsHardCap: 500,
})

export function defaultConfig() {
  const b = AGENT_BUDGETS
  return {
    version: 1,
    activeProvider: "",
    providers: {}, // name -> { apiKey, baseUrl, model }
    skills: { enabled: true, dir: "" },
    agent: {
      maxSteps: b.maxSteps, timeoutSec: b.timeoutSec, maxToolOutput: b.maxToolOutput, maxToolCalls: b.maxToolCalls,
      delegateTimeoutSec: b.delegateTimeoutSec, maxParallelSubAgents: b.maxParallelSubAgents,
      // v21 autonomous orchestration: autonomous runs through the meta
      // controller (segment loop, DAG, model strategy, workers, resources,
      // verification ledger, recovery). maxSteps remains the PER-SEGMENT safety
      // bound; maxSegments is the task-level fuse (never the definition of
      // completion — verified objective satisfaction is).
      // v26: maxParallelSubAgents is the CEILING for read-only DAG workers
      // (class strategy picks a smaller number; low-RAM still clamps to 1).
      // Privileged tools.* flags stay false.
      autonomous: true, segmentSteps: b.segmentSteps, maxSegments: b.maxSegments, maxContinuations: b.maxContinuations, modelStrategy: true,
    },
    chat: { stream: true, system: "", showReasoning: true, maxHistoryMessages: 40, tools: true, compact: true, compactAtChars: 48000, profile: "auto", restoreCwd: true, historySize: 300 },
    // v20.5: `intelligence` is the master switch for the capability/router/
    // verification layer; everything below it only matters while it is on.
    // v21.1: `pluginGrants` maps a plugin FILE in ~/.forge/tools to the
    // capabilities the user grants it ({ network, childProcess, read:[], write:[],
    // env:[] }); plugins run isolated and get declared ∩ granted, nothing else.
    tools: { searchUrl: "", allowOutsideProject: false, allowSudo: false, assumeYes: false, allowNetworkUpload: false, fetchPrivateUrls: false, allowInterpreterEval: false, allowNewPlugins: false, intelligence: true, verify: true, cache: true, maxRisk: "critical", explainRouting: true, disabled: [], deprecated: [], experimental: true, pluginGrants: {} },
    // v23: Model Context Protocol servers. OFF by default (no servers). Each
    // entry: { command, args?, env?, disabled?, timeoutMs? }. A server's tools
    // become agent tools namespaced mcp__<name>__<tool>, behind the same safety
    // choke point as local plugins. Launched from THIS config only, never model
    // output.
    mcp: { servers: {} },
    // v23: Language Server Protocol servers for real code understanding
    // (definition/references/hover/diagnostics). OFF by default. Each entry keys
    // a language: { command, args?, extensions:[".ts",...], languageId?, env?,
    // disabled? }. Read-only; launched from THIS config only, never model output.
    lsp: { servers: {} },
    // v23: semantic retrieval. BM25 (retrieval.js) remains the zero-config,
    // offline-safe default for ranking memory/learnings. When embeddings.enabled
    // is true and an OpenAI-compatible embeddings endpoint resolves, BM25
    // shortlists are reranked by a BM25+cosine hybrid (alpha = weight of the
    // semantic score). Embeddings are cached under ~/.forge/cache and are only
    // ever resolved from THIS config, never model output. OFF by default.
    retrieval: {
      embeddings: {
        enabled: false, provider: "", model: "", baseUrl: "", apiKey: "",
        alpha: 0.5, batchSize: 16, timeoutMs: 20000, rerankBudgetMs: 4000,
        maxTexts: 64, cacheMaxEntries: 2000,
      },
    },

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

// ---------------------------------------------------------------------------
// v21.1 P0 — project-local config is UNTRUSTED input.
//
// ./forge.config.json is committed to the repository the user just cloned:
// whoever wrote it is not the user. v20 deep-merged it with full authority,
// so a checked-in file could set tools.allowSudo / assumeYes /
// allowOutsideProject / fetchPrivateUrls (turning every guard off before the
// first prompt) and register mcp/lsp `servers` — arbitrary commands spawned on
// start-up. Project config may still tune the agent (models, steps, skills,
// retrieval knobs); it may never WIDEN a security boundary or launch processes.
// ---------------------------------------------------------------------------

/** tools.* switches that only the user-level config (or env) may set. */
const PRIVILEGED_TOOL_KEYS = ["allowSudo", "assumeYes", "allowOutsideProject", "fetchPrivateUrls", "allowNetworkUpload", "allowInterpreterEval", "allowNewPlugins", "mcp", "lsp", "plugins", "pluginGrants", "maxRisk", "intelligence", "verify"]
/** top-level sections a project file may not touch at all. */
const PRIVILEGED_SECTIONS = ["mcp", "lsp", "providers", "activeProvider", "retrieval"]

/**
 * Strip everything a project-local config is not allowed to set.
 * Returns { cfg, dropped } — `dropped` lists the ignored dotted keys so the
 * user is told, instead of silently getting a different configuration.
 */
export function sanitizeProjectConfig(proj) {
  const dropped = []
  if (!proj || typeof proj !== "object" || Array.isArray(proj)) return { cfg: null, dropped }
  const out = { ...proj }
  for (const k of PRIVILEGED_SECTIONS) if (k in out) { dropped.push(k); delete out[k] }
  if (out.tools && typeof out.tools === "object" && !Array.isArray(out.tools)) {
    out.tools = { ...out.tools }
    for (const k of PRIVILEGED_TOOL_KEYS) if (k in out.tools) { dropped.push(`tools.${k}`); delete out.tools[k] }
    // a project may DISABLE tools (narrowing) but may not un-deprecate or
    // re-enable experimental ones for everyone who clones it
    if ("experimental" in out.tools && out.tools.experimental === true) { dropped.push("tools.experimental"); delete out.tools.experimental }
  } else if ("tools" in out && out.tools !== undefined) {
    dropped.push("tools"); delete out.tools
  }
  // a project may not point the search tool at an arbitrary URL that then
  // receives the model's queries (exfil channel)
  if (out.tools && "searchUrl" in out.tools) { dropped.push("tools.searchUrl"); delete out.tools.searchUrl }
  return { cfg: out, dropped }
}

export function loadConfig(explicitPath) {
  const sources = []
  const ignored = []
  let cfg = defaultConfig()

  const userPath = explicitPath || USER_CONFIG_PATH
  const userCfg = explicitPath ? readJson(explicitPath) : readJson(USER_CONFIG_PATH)
  if (userCfg) {
    cfg = deepMerge(cfg, userCfg)
    sources.push(userPath)
  }

  const projPath = path.join(process.cwd(), PROJECT_CONFIG_NAME)
  const projRaw = readJson(projPath)
  if (projRaw) {
    const { cfg: projCfg, dropped } = sanitizeProjectConfig(projRaw)
    if (projCfg) {
      cfg = deepMerge(cfg, projCfg)
      sources.push(projPath)
    }
    for (const k of dropped) ignored.push(`${PROJECT_CONFIG_NAME}: "${k}" ignored — only ~/.forge/config.json may set it`)
  }

  if (process.env.FORGE_PROVIDER && !cfg.activeProvider) {
    cfg.activeProvider = process.env.FORGE_PROVIDER
    sources.push("env:FORGE_PROVIDER")
  }
  return { config: cfg, sources, ignored }
}

/** Persist config with 0600 perms — it may hold API keys. */
export function saveConfig(cfg, explicitPath) {
  const p = explicitPath || USER_CONFIG_PATH
  writeStateFile(p, JSON.stringify(cfg, null, 2) + "\n") // v21.1: atomic, 0600 — a crash mid-write cannot lose the API keys
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
