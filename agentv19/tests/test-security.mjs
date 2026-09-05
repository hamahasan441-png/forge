/**
 * forge — v20 hardening unit tests (zero dependencies, no network needed).
 * Run: node tests/test-security.mjs
 *
 * This is the LAUNCHER: config-dependent modules read FORGE_HOME at import
 * time, so the env + scratch dirs are prepared BEFORE the inner test module
 * (and its static imports) are evaluated. Keeps the real ~/.forge untouched.
 */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const T = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sec-"))
process.env.FORGE_HOME = path.join(T, "home")
process.env.FORGE_CONFIG = path.join(T, "config.json")
process.env.NO_COLOR = "1"

try {
  await import("./test-security.inner.mjs")
} catch (e) {
  console.error("suite crashed:", e?.message ?? e)
  process.exit(1)
} finally {
  try { fs.rmSync(T, { recursive: true, force: true }) } catch {}
}
