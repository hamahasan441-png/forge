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
 * Escape hatch became the default in v88: model bash runs UNSANDBOXED unless
 * FORGE_SANDBOX=1 explicitly asks for the wrap. FORGE_BWRAP=/path/to/bwrap
 * pins the binary (tests).
 *
 * v87: a bwrap binary on PATH is NOT enough. Unprivileged bwrap needs the
 * kernel's overflow uid/gid sysctls to build its user namespace; inside
 * containers / hardened kernels it exists but EVERY command dies before it
 * runs with:  bwrap: Can't read /proc/sys/kernel/overflowuid: Permission denied
 * A missing isolator is "unsandboxed", not a fake sandbox — so we probe once
 * and treat such a bwrap as missing (commands then run directly via /bin/sh).
 */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const RO_TRY = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/etc", "/opt"]

let kernProbe = undefined // undefined = not probed yet

/** Can unprivileged bwrap actually build a user namespace on this kernel? */
function bwrapKernelSupport() {
  if (process.platform !== "linux") return false
  if (kernProbe !== undefined) return kernProbe
  const readable = (p) => { try { fs.readFileSync(p); return true } catch { return false } }
  kernProbe = readable("/proc/sys/kernel/overflowuid") && readable("/proc/sys/kernel/overflowgid")
  return kernProbe
}

function isSetuid(p) {
  try { return !!(fs.statSync(p).mode & 0o4000) } catch { return false }
}

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
  // v88 "noguard": sandbox wrapping is OPT-IN. Default is unsandboxed /bin/sh
  // (full control — the owner's standing decision). Set FORGE_SANDBOX=1 to
  // wrap model bash in bwrap again when the binary actually works.
  const want = process.env.FORGE_SANDBOX
  if (want !== "1" && want !== "true" && want !== "on" && want !== "yes") return null
  const bin = process.env.FORGE_BWRAP
    ? (exists(process.env.FORGE_BWRAP) ? process.env.FORGE_BWRAP : null)
    : which("bwrap")
  if (!bin) return null
  // v87: setuid bwrap does not need unprivileged userns; a plain binary on a
  // kernel that hides overflowuid/overflowgid can never start — treat it as
  // missing instead of failing every single command.
  if (!isSetuid(bin) && !bwrapKernelSupport()) return null
  return bin
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
