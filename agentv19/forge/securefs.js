/**
 * forge — secure filesystem primitives (v21.1 P0).
 *
 * The v20 boundary was:  safePath(p) → (time passes) → fs.writeFileSync(p)
 * That is a classic TOCTOU: `realpath` was computed at validation time and the
 * write followed whatever the path resolved to at WRITE time. A symlink or a
 * directory swapped in between (by a backgrounded shell child, another forge
 * worker, a postinstall script, …) redirected the write outside the project.
 *
 * This module makes the boundary hold at the syscall that matters:
 *
 *   openProjectDir(root, relDir)
 *     walks from the ROOT one component at a time, opening each directory with
 *     O_NOFOLLOW | O_DIRECTORY (a symlinked component fails with ELOOP/ENOTDIR),
 *     and re-verifies through /proc/self/fd (Linux) that the opened directory
 *     is still inside the real root. The returned descriptor is the anchor.
 *
 *   atomicWriteInDir(dirfd, name, data)
 *     creates a temp file INSIDE the anchored directory with
 *     O_CREAT | O_EXCL | O_NOFOLLOW, writes, fsyncs, renames onto `name`
 *     (rename replaces a symlink at the target instead of following it),
 *     fsyncs the directory. The path used for these calls is
 *     /proc/self/fd/<dirfd>/<name> on Linux — a *descriptor-relative* path
 *     that cannot be redirected by renaming any ancestor.
 *
 *   secureWriteFile(root, target, data)     = the two above + mkdir walk
 *   secureUnlink(root, target)              = unlinkat-equivalent, no follow
 *   secureReadFile / secureOpenRead         = O_NOFOLLOW read anchored the same way
 *
 * On platforms without /proc (macOS, Windows) we fall back to per-component
 * lstat + O_NOFOLLOW opens against absolute paths. That still defeats symlink
 * final components and detects symlinked ancestors at open time; it cannot
 * defeat an ancestor *rename* race, which is documented as the remaining risk.
 *
 * Every function here throws `SecureFsError` with a stable `.code`:
 *   EESCAPE   the target resolved outside the root
 *   ESYMLINK  a path component is a symbolic link
 *   ENOTDIR   a component is not a directory
 *   EBADNAME  an invalid component ("", ".", "..", contains "/" or NUL)
 *
 * Zero dependencies. Node >= 18.
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_TRUNC, O_NOFOLLOW, O_DIRECTORY } = fs.constants
const HAS_PROC_FD = process.platform === "linux" && (() => { try { fs.readlinkSync("/proc/self/fd/0"); return true } catch { return false } })()

export class SecureFsError extends Error {
  constructor(message, code, extra = {}) {
    super(message)
    this.name = "SecureFsError"
    this.code = code
    Object.assign(this, extra)
  }
}

export function fdPath(fd, name) {
  return name === undefined ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${name}`
}

function checkName(name) {
  const n = String(name ?? "")
  if (!n || n === "." || n === ".." || n.includes("/") || n.includes("\0") || (path.sep !== "/" && n.includes(path.sep))) {
    throw new SecureFsError(`invalid path component ${JSON.stringify(n)}`, "EBADNAME")
  }
  return n
}

/** Split a relative path into validated components (rejects "" / "." / ".."). */
export function splitComponents(rel) {
  const parts = String(rel ?? "").split(/[\\/]+/).filter((p) => p !== "" && p !== ".")
  for (const p of parts) checkName(p)
  return parts
}

function insideDir(target, dir) {
  const rel = path.relative(dir, target)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/** Resolve `target` (absolute or relative to root) to components under root, or throw EESCAPE. */
export function relativeComponents(root, target) {
  const rootAbs = path.resolve(root)
  const abs = path.resolve(rootAbs, String(target ?? ""))
  if (!insideDir(abs, rootAbs)) throw new SecureFsError(`path escapes the project root (${path.relative(rootAbs, abs)})`, "EESCAPE")
  const rel = path.relative(rootAbs, abs)
  return rel ? splitComponents(rel) : []
}

/** Where does this fd currently live? (Linux). null when unavailable. */
function whereIs(fd) {
  if (!HAS_PROC_FD) return null
  try { return fs.readlinkSync(fdPath(fd)) } catch { return null }
}

/**
 * Open the ROOT directory itself. The root may legitimately be behind a
 * symlink (e.g. /tmp → /private/tmp on macOS), so it is resolved with realpath
 * once and the descriptor is verified against that real path.
 */
export function openRoot(root) {
  const real = fs.realpathSync(path.resolve(root))
  const fd = fs.openSync(real, O_RDONLY | O_DIRECTORY)
  const loc = whereIs(fd)
  if (loc !== null && loc !== real) { fs.closeSync(fd); throw new SecureFsError("project root moved during open", "EESCAPE") }
  return { fd, real }
}

/**
 * Open the directory `components` below root (creating missing directories
 * when `create` is set), one O_NOFOLLOW component at a time.
 * Returns { fd, real } where `real` is the verified physical path.
 * The caller MUST close fd.
 */
export function openProjectDir(root, components = [], { create = false, mode = 0o755 } = {}) {
  const parts = Array.isArray(components) ? components.map(checkName) : splitComponents(components)
  const rootInfo = openRoot(root)
  let cur = rootInfo.fd
  let curPath = rootInfo.real
  try {
    for (const name of parts) {
      const rel = HAS_PROC_FD ? fdPath(cur, name) : path.join(curPath, name)
      let next
      for (let attempt = 0; ; attempt++) {
        try {
          next = fs.openSync(rel, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
          break
        } catch (e) {
          // Linux returns ENOTDIR (not ELOOP) for O_NOFOLLOW|O_DIRECTORY on a
          // symlink — lstat decides which it really is. Either way: refused.
          if (e.code === "ELOOP" || e.code === "ENOTDIR") {
            let isLink = e.code === "ELOOP"
            try { isLink = fs.lstatSync(rel).isSymbolicLink() } catch {}
            if (isLink) throw new SecureFsError(`path component "${name}" is a symbolic link`, "ESYMLINK", { component: name })
            throw new SecureFsError(`path component "${name}" is not a directory`, "ENOTDIR", { component: name })
          }
          if (e.code === "ENOENT" && create && attempt === 0) {
            try { fs.mkdirSync(rel, { mode }) } catch (me) { if (me.code !== "EEXIST") throw me }
            continue
          }
          throw e
        }
      }
      // verify: the directory we opened is physically where we expect
      const expect = path.join(curPath, name)
      const loc = whereIs(next)
      if (loc !== null && loc !== expect) {
        fs.closeSync(next)
        throw new SecureFsError(`directory "${name}" moved during open (${loc})`, "EESCAPE", { component: name })
      }
      if (loc === null) {
        // no /proc — best effort: the component must not be a symlink now
        try { if (fs.lstatSync(expect).isSymbolicLink()) { fs.closeSync(next); throw new SecureFsError(`path component "${name}" is a symbolic link`, "ESYMLINK", { component: name }) } } catch (e) { if (e instanceof SecureFsError) throw e }
      }
      fs.closeSync(cur)
      cur = next
      curPath = expect
    }
    if (!insideDir(curPath, rootInfo.real)) throw new SecureFsError("resolved directory escapes the root", "EESCAPE")
    return { fd: cur, real: curPath }
  } catch (e) {
    try { fs.closeSync(cur) } catch {}
    throw e
  }
}

function tmpName(name) {
  return `.${name}.forge-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`
}

/**
 * Atomically replace `name` inside the anchored directory with `data`.
 * temp(O_EXCL|O_NOFOLLOW) → write → fsync → rename → fsync(dir).
 * Preserves the mode of an existing regular file; refuses to replace a
 * directory. Returns { bytes, replaced }.
 */
export function atomicWriteInDir(dirfd, dirReal, name, data, { mode } = {}) {
  checkName(name)
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""), "utf8")
  const at = (n) => (HAS_PROC_FD ? fdPath(dirfd, n) : path.join(dirReal, n))
  let existing = null
  try { existing = fs.lstatSync(at(name)) } catch {}
  if (existing?.isDirectory()) throw new SecureFsError(`"${name}" is a directory`, "EISDIR")
  // The final component must be a regular file or absent. Callers resolve
  // legitimate in-project symlinks to their real target BEFORE calling us, so
  // a symlink here is either dangling or was swapped in after validation —
  // refuse rather than silently replace it.
  if (existing?.isSymbolicLink()) throw new SecureFsError(`"${name}" is a symbolic link`, "ESYMLINK", { component: name })
  if (existing && !existing.isFile()) throw new SecureFsError(`"${name}" is not a regular file`, "ENOTFILE", { component: name })
  const useMode = mode ?? (existing?.isFile() ? existing.mode & 0o7777 : 0o644)
  const tmp = tmpName(name)
  let fd = null
  try {
    fd = fs.openSync(at(tmp), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, useMode)
    let off = 0
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    // rename replaces a symlink AT the target rather than following it
    fs.renameSync(at(tmp), at(name))
    try { fs.fsyncSync(dirfd) } catch {}
    return { bytes: buf.length, replaced: Boolean(existing) }
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
    try { fs.unlinkSync(at(tmp)) } catch {}
    throw e
  }
}

/**
 * Write `data` to `target` (absolute or root-relative) with the full secure
 * pipeline: validate → anchor parent (creating dirs) → temp → fsync → rename.
 * Returns { real, bytes, replaced }.
 */
export function secureWriteFile(root, target, data, { createDirs = true, mode } = {}) {
  const parts = relativeComponents(root, target)
  if (!parts.length) throw new SecureFsError("cannot write to the project root itself", "EISDIR")
  const name = parts.pop()
  const dir = openProjectDir(root, parts, { create: createDirs })
  try {
    const r = atomicWriteInDir(dir.fd, dir.real, name, data, { mode })
    return { real: path.join(dir.real, name), ...r }
  } finally {
    try { fs.closeSync(dir.fd) } catch {}
  }
}

/** Remove `target` without following symlinks in any component. Returns true when removed. */
export function secureUnlink(root, target) {
  const parts = relativeComponents(root, target)
  if (!parts.length) throw new SecureFsError("refusing to unlink the project root", "EISDIR")
  const name = parts.pop()
  const dir = openProjectDir(root, parts)
  try {
    const at = HAS_PROC_FD ? fdPath(dir.fd, name) : path.join(dir.real, name)
    let st
    try { st = fs.lstatSync(at) } catch (e) { if (e.code === "ENOENT") return false; throw e }
    if (st.isDirectory()) throw new SecureFsError(`"${name}" is a directory`, "EISDIR")
    fs.unlinkSync(at)
    try { fs.fsyncSync(dir.fd) } catch {}
    return true
  } finally {
    try { fs.closeSync(dir.fd) } catch {}
  }
}

/**
 * Open `target` for reading with O_NOFOLLOW on every component.
 * Returns { fd, real, stat } — caller closes fd.
 */
export function secureOpenRead(root, target) {
  const parts = relativeComponents(root, target)
  if (!parts.length) throw new SecureFsError("target is the project root", "EISDIR")
  const name = parts.pop()
  const dir = openProjectDir(root, parts)
  try {
    const at = HAS_PROC_FD ? fdPath(dir.fd, name) : path.join(dir.real, name)
    let fd
    try {
      fd = fs.openSync(at, O_RDONLY | O_NOFOLLOW)
    } catch (e) {
      if (e.code === "ELOOP") throw new SecureFsError(`"${name}" is a symbolic link`, "ESYMLINK", { component: name })
      throw e
    }
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) { fs.closeSync(fd); throw new SecureFsError(`"${name}" is not a regular file`, "ENOTFILE") }
    return { fd, real: path.join(dir.real, name), stat }
  } finally {
    try { fs.closeSync(dir.fd) } catch {}
  }
}

export function secureReadFile(root, target, encoding = "utf8") {
  const { fd } = secureOpenRead(root, target)
  try {
    const st = fs.fstatSync(fd)
    const buf = Buffer.alloc(st.size)
    let off = 0
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off)
      if (n <= 0) break
      off += n
    }
    const out = buf.subarray(0, off)
    return encoding ? out.toString(encoding) : out
  } finally {
    fs.closeSync(fd)
  }
}

/** True when descriptor-relative (rename-race-proof) operation is available. */
export const DESCRIPTOR_RELATIVE = HAS_PROC_FD

void O_TRUNC

/**
 * v21.1 — the ONE writer for forge's own state files under ~/.forge (sessions,
 * health, model cache, plans, profiles, run logs, task state, lessons, todo,
 * history, config). These paths are never model-controlled, so no root
 * anchoring is needed — what they need is crash safety: a reader must see
 * either the previous complete file or the new complete file, never a torn
 * one, and a failure must not leave temp files behind. Temp is created with
 * O_EXCL in the same directory, fsynced, renamed over the target, then the
 * directory is fsynced. Mode defaults to 0600 (state may hold personal data).
 * Existing symlinks are honoured (written through to their real target) so
 * users who relocate ~/.forge/sessions keep working.
 */
export function writeStateFile(file, data, { mode = 0o600, fsyncDir = true } = {}) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""), "utf8")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let target = file
  try { target = fs.realpathSync(file) } catch { /* absent — create in place */ }
  let existing = null
  try { existing = fs.lstatSync(target) } catch {}
  if (existing && !existing.isFile()) throw new SecureFsError(`state path is not a regular file: ${target}`, "ENOTFILE")
  const dir = path.dirname(target)
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`)
  let fd = null
  try {
    fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL, mode)
    let off = 0
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off)
    fs.fsyncSync(fd)
    fs.closeSync(fd); fd = null
    fs.renameSync(tmp, target)
    if (existing) { try { fs.chmodSync(target, mode) } catch {} }
    if (fsyncDir) { try { const dfd = fs.openSync(dir, "r"); try { fs.fsyncSync(dfd) } finally { fs.closeSync(dfd) } } catch {} }
    return { file: target, bytes: buf.length, replaced: Boolean(existing) }
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
    try { fs.unlinkSync(tmp) } catch {}
    throw e
  }
}
