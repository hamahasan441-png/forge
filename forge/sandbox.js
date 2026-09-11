/**
 * forge — optional bash sandbox (v27, zero dependencies)
 *
 * PLAN-v24 Tier 2 item 5: wrap model bash in bubblewrap when the binary is
 * actually on PATH. Shellguard remains the classifier — this is a process
 * boundary ON TOP, never a replacement. If bwrap is missing we spawn
 * `/bin/sh -c` exactly as v26 did and we never report `sandboxed: true`.
 *
 * The plugin-isolation lesson: a missing isolator is "unsandboxed", not a
 * fake sandbox. Do not unshare the network namespace — npm / git / fetches
 * need it; netguard still owns URL policy.
 *
 * Escape hatch: FORGE_SANDBOX=0 disables the wrap even when bwrap exists.
 * FORGE_BWRAP=/path/to/bwrap pins the binary (tests).
 */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const RO_TRY = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/etc", "/opt"]

function exists(p) {
  try { return !!p && fs.existsSync(p) } catch { return false }
}

function which(name) {
  const pathEnv = process.env.PATH || ""
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    const cand = path.join(dir, name)
    try {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand
    } catch {}
  }
  return null
}

/** Resolve the sandbox binary, or null. Never throws. */
export function findSandboxBinary() {
  const off = process.env.FORGE_SANDBOX
  if (off === "0" || off === "false" || off === "off") return null
  if (process.env.FORGE_BWRAP) {
    return exists(process.env.FORGE_BWRAP) ? process.env.FORGE_BWRAP : null
  }
  return which("bwrap")
}

/**
 * @returns {{ available: boolean, kind: "bwrap"|"none", binary: string|null }}
 * `opts.binary` injects a path (tests). Pass `null` to force unsandboxed.
 */
export function detectSandbox(opts = {}) {
  const binary = Object.prototype.hasOwnProperty.call(opts, "binary")
    ? (opts.binary || null)
    : findSandboxBinary()
  if (!binary) return { available: false, kind: "none", binary: null }
  return { available: true, kind: "bwrap", binary }
}

/**
 * argv for a sandboxed `/bin/sh -c command`. Binds the project (and HOME if
 * it is a real directory) read-write; system prefixes read-only; pid
 * unshared; network left intact. Missing binary → unsandboxed argv.
 *
 * @returns {{ file: string, args: string[], sandboxed: boolean, kind: "bwrap"|"none" }}
 */
export function wrapBash(command, { cwd, root, binary } = {}) {
  const det = detectSandbox(binary !== undefined ? { binary } : {})
  const cmd = String(command ?? "")
  if (!det.available) {
    return { file: "/bin/sh", args: ["-c", cmd], sandboxed: false, kind: "none" }
  }
  const project = path.resolve(root || cwd || process.cwd())
  const chdir = path.resolve(cwd || project)
  const args = [
    "--unshare-pid",
    "--die-with-parent",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
  ]
  for (const p of RO_TRY) {
    if (exists(p)) args.push("--ro-bind-try", p, p)
  }
  args.push("--bind", project, project)
  const home = process.env.HOME || os.homedir()
  if (home && exists(home)) {
    const resolvedHome = path.resolve(home)
    if (resolvedHome !== project) args.push("--bind", resolvedHome, resolvedHome)
  }
  args.push("--chdir", chdir, "/bin/sh", "-c", cmd)
  return { file: det.binary, args, sandboxed: true, kind: "bwrap" }
}
