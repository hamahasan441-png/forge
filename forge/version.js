/**
 * forge — single source of truth for the version string.
 *
 * Before v20.2 the version was hardcoded in three places (package.json,
 * forge.js and chat.js) and the e2e/cleanroom suites asserted the literal
 * `forge v20.0.0`; the next bump would have silently reddened them. This module
 * reads it once from package.json (the canonical manifest, always shipped next
 * to the code) so a bump touches exactly one file. Zero dependencies, fails
 * closed to "0.0.0" if the manifest is somehow unreadable.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"))
    if (typeof pkg.version === "string" && pkg.version) return pkg.version
  } catch {}
  return "0.0.0"
}

export const VERSION = readVersion()
