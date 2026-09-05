/**
 * forge — provider health cache (zero dependencies)
 *
 * Records the last probe/verify result per provider to ~/.forge/health.json.
 * This is what puts a "✓ tested" badge next to working models in the
 * SmartStart picker and `forge doctor`. Never throws — a broken cache must
 * not break the CLI.
 */
import fs from "node:fs"
import path from "node:path"
import { DEFAULT_DIR } from "./config.js"

export const HEALTH_PATH = path.join(DEFAULT_DIR, "health.json")

export function readHealth() {
  try {
    const j = JSON.parse(fs.readFileSync(HEALTH_PATH, "utf8"))
    return j && typeof j === "object" ? j : {}
  } catch {
    return {}
  }
}

/** Merge an entry: recordHealth("openai", { ok: true, ms: 230, model: "gpt-4o" }) */
export function recordHealth(name, entry) {
  try {
    if (!name || !entry) return
    const h = readHealth()
    h[name] = { ...(h[name] || {}), ...entry, ts: Date.now() }
    fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true })
    fs.writeFileSync(HEALTH_PATH, JSON.stringify(h, null, 2) + "\n")
  } catch {
    /* health cache is best-effort */
  }
}
