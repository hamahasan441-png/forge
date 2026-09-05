/**
 * forge — persistent model cache (zero dependencies)
 *
 * v18: stores the last live /models listing per provider at
 * ~/.forge/models-cache.json. Used to:
 *   - badge FREE models in the wizard and SmartStart WITHOUT a network call
 *   - keep the OpenRouter free-models list available offline
 * Best-effort by design: a broken/unreadable cache can never break the CLI.
 */
import fs from "node:fs"
import path from "node:path"
import { DEFAULT_DIR } from "./config.js"

export const MODEL_CACHE_PATH = path.join(DEFAULT_DIR, "models-cache.json")

export function readModelCache(providerName) {
  try {
    const j = JSON.parse(fs.readFileSync(MODEL_CACHE_PATH, "utf8"))
    const e = j?.[providerName]
    if (!e || !Array.isArray(e.entries)) return null
    return e
  } catch {
    return null
  }
}

/** entries: [{ id, name?, context?, free? }] — cached from a live /models fetch. */
export function writeModelCache(providerName, entries) {
  try {
    if (!providerName || !Array.isArray(entries) || !entries.length) return false
    let root = {}
    try { root = JSON.parse(fs.readFileSync(MODEL_CACHE_PATH, "utf8")) || {} } catch {}
    if (typeof root !== "object" || Array.isArray(root)) root = {}
    root[providerName] = { entries: entries.slice(0, 400), ts: Date.now() }
    fs.mkdirSync(path.dirname(MODEL_CACHE_PATH), { recursive: true })
    fs.writeFileSync(MODEL_CACHE_PATH, JSON.stringify(root, null, 2) + "\n")
    return true
  } catch {
    return false
  }
}

/** Free entries from cache, biggest context first (SmartStart / wizard fallback). */
export function freeFromCache(providerName) {
  const e = readModelCache(providerName)
  if (!e) return []
  return e.entries
    .filter((m) => m && m.id && m.free)
    .sort((a, b) => (b.context ?? 0) - (a.context ?? 0))
}
