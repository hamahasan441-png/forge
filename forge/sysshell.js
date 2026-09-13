/**
 * forge — resolved shell path (v94 knowwise: Termux/NetHunter readiness)
 *
 * Every shell forge used to spawn was hardcoded "/bin/sh", which does not
 * exist on Termux (prefix /data/data/com.termux/files/usr). On such systems
 * EVERY model bash call, background process, and typed `!` line ENOENTed.
 * One resolver, every spawn site:
 *
 *   1. FORGE_SHELL env — explicit override, returned verbatim (owner knows)
 *   2. /bin/sh — every normal Linux/CI/NetHunter-proot (unchanged default)
 *   3. $PREFIX/bin/sh — Termux
 *   4. $SHELL — last absolute fallback
 *   5. "sh" — PATH-resolved last resort
 *
 * Zero imports beyond node builtins (leaf module: importable from sandbox,
 * tools, runtime, chat, forge without cycles). Never throws.
 */
import fs from "node:fs"
import path from "node:path"

function exists(p) {
  try { return typeof p === "string" && p.length > 0 && fs.existsSync(p) } catch { return false }
}

/**
 * Pure selection logic (unit-testable without touching the real fs):
 *   1. env.FORGE_SHELL — explicit override, verbatim (owner knows best)
 *   2. /bin/sh — every normal Linux/CI/NetHunter-proot (unchanged default)
 *   3. env.PREFIX + /bin/sh — Termux
 *   4. env.SHELL — last absolute fallback
 *   5. "sh" — PATH-resolved last resort
 */
export function pickShell(env, existsFn = exists) {
  const forced = env?.FORGE_SHELL
  if (forced) return forced
  if (existsFn("/bin/sh")) return "/bin/sh"
  const prefix = env?.PREFIX
  if (prefix && existsFn(path.join(prefix, "bin", "sh"))) return path.join(prefix, "bin", "sh")
  if (env?.SHELL && existsFn(env.SHELL)) return env.SHELL
  return "sh"
}

export function resolveShell() {
  return pickShell(process.env, exists)
}
