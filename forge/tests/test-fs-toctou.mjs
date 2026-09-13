#!/usr/bin/env node
/**
 * forge — filesystem boundary adversarial suite (v21.1 P0).
 *
 * Every test here tries to make a project-scoped write (or delete) land
 * OUTSIDE the project, or through a symlink, using the model-facing tools
 * (write_file / edit_file / multi_edit / apply_patch) and the securefs
 * primitives directly. The assertion is always on the OUTSIDE filesystem:
 * "the file outside the project did not change".
 *
 * Race tests use a fault-injection hook (a monkey-patched fs function that
 * fires once between validation and commit) rather than timing luck, so they
 * are deterministic.
 *
 * Zero network. Temp dirs only.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-toctou-home-"))

const sfs = await import("../securefs.js")
const { secureWriteFile, secureUnlink, secureReadFile, openProjectDir, relativeComponents, SecureFsError, DESCRIPTOR_RELATIVE } = sfs
const { makeToolContext, safePath } = await import("../tools.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`) } }

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-toctou-")))
const PROJ = path.join(T, "proj")
const OUT = path.join(T, "outside")
fs.mkdirSync(path.join(PROJ, "src", "deep"), { recursive: true })
fs.mkdirSync(OUT, { recursive: true })
const VICTIM = path.join(OUT, "victim.txt")
const SENTINEL = "UNTOUCHED-" + Date.now()
const resetVictim = () => fs.writeFileSync(VICTIM, SENTINEL)
const victimIntact = () => { try { return fs.readFileSync(VICTIM, "utf8") === SENTINEL } catch { return false } }
const outsideFiles = () => fs.readdirSync(OUT).sort()
resetVictim()
const tool = makeToolContext({ cwd: PROJ, root: PROJ, maxToolOutput: 4000 })
const clean = () => { for (const e of fs.readdirSync(PROJ)) if (e !== "src") fs.rmSync(path.join(PROJ, e), { recursive: true, force: true }); for (const e of fs.readdirSync(path.join(PROJ, "src"))) if (e !== "deep") fs.rmSync(path.join(PROJ, "src", e), { recursive: true, force: true }); resetVictim(); for (const e of outsideFiles()) if (e !== "victim.txt") fs.rmSync(path.join(OUT, e), { recursive: true, force: true }) }

console.log(`== environment: descriptor-relative ops ${DESCRIPTOR_RELATIVE ? "AVAILABLE" : "unavailable (fallback mode)"} ==`)

// ---------------------------------------------------------------------------
console.log("== direct / encoded / absolute traversal (v88 noguard: outside writes ALLOWED) ==")
{
  // v88: the project write boundary is gone — traversal and absolute outside
  // targets WRITE SUCCESSFULLY. System paths (/etc/passwd, ~/.forge) are
  // checked as VERDICTS only: a test never attempts a real system write.
  const attempts = [
    "../outside/victim.txt", "../../" + path.basename(T) + "/outside/victim.txt", "src/../../outside/victim.txt",
    "src/deep/../../../outside/victim.txt", VICTIM,
  ]
  for (const p of attempts) {
    let r
    try { r = await tool.exec("write_file", { path: p, content: "PWNED" }) } catch (e) { r = "THREW " + e.message }
    ok(`v88 write_file ${JSON.stringify(p).slice(0, 50)} → ALLOWED (writes outside)`, String(r).includes("OK wrote"), String(r).slice(0, 100))
    resetVictim()
  }
  // encoded sequences are NOT decoded by the fs → literal in-project file
  for (const p of ["src/%2e%2e/%2e%2e/outside/victim.txt", "..%2foutside%2fvictim.txt"]) {
    let r
    try { r = await tool.exec("write_file", { path: p, content: "PWNED" }) } catch (e) { r = "THREW " + e.message }
    ok(`write_file ${JSON.stringify(p).slice(0, 50)} → literal name or mechanics error (never a boundary refusal)`, !String(r).startsWith("BLOCKED"), String(r).slice(0, 100))
  }
  // system targets: verdict-only (never executed)
  const { safePath } = await import("../tools.js")
  for (const p of ["~/.forge/tools/pwn.mjs", "/etc/passwd", "src\0/../../outside/victim.txt"]) {
    const v = safePath({ cwd: PROJ, root: PROJ, allowOutsideProject: false }, p, { write: true })
    ok(`v88 safePath verdict for ${JSON.stringify(p).slice(0, 40)} is ALLOWED (no boundary)`, v.ok, v.error)
  }
  ok("/etc/passwd intact (never touched)", fs.statSync("/etc/passwd").size > 0)
  clean()
}

console.log("== symlink to outside (file + dir + nested + dangling) ==")
{
  fs.symlinkSync(VICTIM, path.join(PROJ, "linkfile"))
  fs.symlinkSync(OUT, path.join(PROJ, "linkdir"))
  fs.symlinkSync(path.join(PROJ, "linkdir"), path.join(PROJ, "src", "nested"))
  fs.symlinkSync(path.join(OUT, "dangling-target.txt"), path.join(PROJ, "dangling"))
  fs.symlinkSync("../outside", path.join(PROJ, "rellink"))
  // v88: an EXISTING outside target reached through a symlinked directory now
  // writes (no boundary). A NEW file through a symlinked dir, or a trailing
  // symlink, is still refused by securefs MECHANICS (ESYMLINK) — that is
  // TOCTOU safety, not a permission guard.
  const allowedThrough = ["linkdir/victim.txt", "src/nested/victim.txt", "rellink/victim.txt"]
  for (const p of allowedThrough) {
    const r = await tool.exec("write_file", { path: p, content: "PWNED" })
    ok(`v88 write_file through ${p} → ALLOWED (existing outside target)`, String(r).includes("OK wrote"), String(r).slice(0, 100))
    resetVictim()
  }
  const refusedThrough = ["linkfile", "linkdir/new.txt", "src/nested/new2.txt", "dangling", "rellink/new3.txt"]
  for (const p of refusedThrough) {
    const r = await tool.exec("write_file", { path: p, content: "PWNED" })
    ok(`write_file through ${p} refused (ESYMLINK mechanics)`, String(r).startsWith("ERROR") && victimIntact(), String(r).slice(0, 100))
  }
  // v88: through a trailing FILE symlink the edit still fails on mechanics;
  // through a symlinked DIR to an existing outside file the edit now APPLIES.
  const rLf = await tool.exec("edit_file", { path: "linkfile", old: "UNTOUCHED", new: "PWNED" })
  ok("edit_file through trailing symlink refused (mechanics)", /ERROR|BLOCKED/.test(String(rLf)) && victimIntact(), String(rLf).slice(0, 100))
  const r2Lf = await tool.exec("multi_edit", { path: "linkfile", edits: [{ old: "UNTOUCHED", new: "PWNED" }] })
  ok("multi_edit through trailing symlink refused (mechanics)", /ERROR|BLOCKED/.test(String(r2Lf)) && victimIntact(), String(r2Lf).slice(0, 100))
  for (const p of ["linkdir/victim.txt", "src/nested/victim.txt"]) {
    const r = await tool.exec("edit_file", { path: p, old: "UNTOUCHED", new: "PWNED" })
    ok(`v88 edit_file through ${p} → ALLOWED (existing outside target)`, String(r).includes("OK"), String(r).slice(0, 100))
    resetVictim()
    const r2 = await tool.exec("multi_edit", { path: p, edits: [{ old: "UNTOUCHED", new: "PWNED" }] })
    ok(`v88 multi_edit through ${p} → ALLOWED (existing outside target)`, String(r2).includes("OK"), String(r2).slice(0, 100))
    resetVictim()
  }
  const patch = `--- a/linkfile\n+++ b/linkfile\n@@ -1,1 +1,1 @@\n-${SENTINEL}\n+PWNED\n`
  const r = await tool.exec("apply_patch", { patch })
  ok("apply_patch through trailing symlink refused (mechanics)", String(r).startsWith("ERROR") && victimIntact(), String(r).slice(0, 100))
  const del = `--- a/linkdir/victim.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-${SENTINEL}\n`
  const r2 = await tool.exec("apply_patch", { patch: del })
  ok("v88 apply_patch delete through symlinked dir → ALLOWED (existing outside target)", /OK|deleted|removed/i.test(String(r2)), String(r2).slice(0, 100))
  resetVictim()
  ok("nothing new appeared outside", outsideFiles().join() === "victim.txt")
  clean()
}

console.log("== in-project symlinks still work (no over-blocking) ==")
{
  fs.writeFileSync(path.join(PROJ, "src", "real.txt"), "hello")
  fs.symlinkSync(path.join(PROJ, "src", "real.txt"), path.join(PROJ, "alias.txt"))
  fs.symlinkSync(path.join(PROJ, "src"), path.join(PROJ, "srclink"))
  const r = await tool.exec("write_file", { path: "alias.txt", content: "via alias" })
  ok("write through in-project file symlink allowed", String(r).startsWith("OK"), r)
  ok("…and landed in the real file", fs.readFileSync(path.join(PROJ, "src", "real.txt"), "utf8") === "via alias")
  const r2 = await tool.exec("write_file", { path: "srclink/other.txt", content: "via dir alias" })
  ok("write through in-project dir symlink allowed", String(r2).startsWith("OK"), r2)
  ok("…and landed inside the project", fs.readFileSync(path.join(PROJ, "src", "other.txt"), "utf8") === "via dir alias")
  const r3 = await tool.exec("write_file", { path: "src/deep/a/b/c.txt", content: "nested create" })
  ok("nested directory creation works", String(r3).includes("created") && fs.readFileSync(path.join(PROJ, "src/deep/a/b/c.txt"), "utf8") === "nested create")
  const r4 = await tool.exec("edit_file", { path: "src/deep/a/b/c.txt", old: "nested", new: "edited" })
  ok("edit_file works", String(r4).startsWith("OK") && fs.readFileSync(path.join(PROJ, "src/deep/a/b/c.txt"), "utf8") === "edited create")
  fs.chmodSync(path.join(PROJ, "src", "real.txt"), 0o600)
  await tool.exec("write_file", { path: "src/real.txt", content: "keep mode" })
  ok("existing file mode preserved across atomic replace", (fs.statSync(path.join(PROJ, "src", "real.txt")).mode & 0o777) === 0o600)
  clean()
}

console.log("== symlink replacement RACE: link swapped between validation and write ==")
{
  // Fault injection: the first fs.openSync during the write is intercepted;
  // at that instant we replace the (validated, in-project) target with a
  // symlink to the victim. The old code would have followed it.
  fs.writeFileSync(path.join(PROJ, "target.txt"), "inside")
  const realOpen = fs.openSync
  let fired = false
  fs.openSync = function (p, ...rest) {
    // fire at the LAST possible instant: the temp-file open that precedes the
    // commit rename — i.e. after every validation step has already passed
    if (!fired && /\.target\.txt\.forge-/.test(String(p))) {
      fired = true
      fs.rmSync(path.join(PROJ, "target.txt"))
      fs.symlinkSync(VICTIM, path.join(PROJ, "target.txt"))
    }
    return realOpen.call(fs, p, ...rest)
  }
  let r
  try { r = await tool.exec("write_file", { path: "target.txt", content: "PWNED" }) } finally { fs.openSync = realOpen }
  ok("race hook fired", fired)
  ok("victim intact after symlink swap race", victimIntact(), String(r))
  // the swapped-in symlink is detected at commit time and refused: the link
  // is neither followed nor silently replaced
  // Two acceptable outcomes, one forbidden one. Acceptable: refused with an
  // explicit error, OR the rename REPLACED the symlink entry (rename(2) never
  // follows a symlink at the destination). Forbidden: the victim changed.
  const lst = fs.lstatSync(path.join(PROJ, "target.txt"))
  ok("outcome is refusal or replace-the-link, never follow", (String(r).startsWith("ERROR") && /symbolic link|escapes/.test(String(r))) || (String(r).startsWith("OK") && lst.isFile() && fs.readFileSync(path.join(PROJ, "target.txt"), "utf8") === "PWNED"), String(r))
  ok("no temp file leaked", !fs.readdirSync(PROJ).some((f) => f.endsWith(".tmp")))
  clean()
}

console.log("== directory replacement RACE: parent dir swapped for a symlink mid-write ==")
{
  fs.mkdirSync(path.join(PROJ, "swap"))
  const realOpen = fs.openSync
  let fired = false
  fs.openSync = function (p, ...rest) {
    // fire when the tool is about to open the parent dir component "swap"
    if (!fired && /\/swap$|\/swap\//.test(String(p))) {
      fired = true
      fs.rmSync(path.join(PROJ, "swap"), { recursive: true })
      fs.symlinkSync(OUT, path.join(PROJ, "swap"))
    }
    return realOpen.call(fs, p, ...rest)
  }
  let r
  try { r = await tool.exec("write_file", { path: "swap/victim.txt", content: "PWNED" }) } finally { fs.openSync = realOpen }
  ok("race hook fired", fired)
  ok("directory-swap race refused", String(r).startsWith("ERROR") && victimIntact(), String(r).slice(0, 120))
  ok("nothing new outside", outsideFiles().join() === "victim.txt")
  clean()
}

if (DESCRIPTOR_RELATIVE) {
  console.log("== directory RENAME race (Linux): validated dir moved outside after anchoring ==")
  {
    // Anchor the directory, then move it outside the project. The anchored
    // descriptor now points OUTSIDE — a write through it would escape. The
    // primitive must detect that the anchor no longer lives under the root.
    fs.mkdirSync(path.join(PROJ, "mv"))
    const anchor = openProjectDir(PROJ, ["mv"])
    fs.renameSync(path.join(PROJ, "mv"), path.join(OUT, "mv-moved"))
    let err
    try { sfs.atomicWriteInDir(anchor.fd, anchor.real, "x.txt", "PWNED") } catch (e) { err = e }
    fs.closeSync(anchor.fd)
    // atomicWriteInDir is the low-level step; callers must re-anchor per write
    // (secureWriteFile does). Prove the high-level API refuses NOW:
    let err2
    fs.symlinkSync(path.join(OUT, "mv-moved"), path.join(PROJ, "mv"))
    try { secureWriteFile(PROJ, "mv/y.txt", "PWNED") } catch (e) { err2 = e }
    ok("secureWriteFile refuses the moved+relinked directory", err2 instanceof SecureFsError && err2.code === "ESYMLINK", String(err2?.message))
    ok("nothing landed in the moved directory via the high-level API", !fs.existsSync(path.join(OUT, "mv-moved", "y.txt")))
    // (x.txt via the raw anchored fd is expected to succeed — that is the
    // documented contract: anchor immediately before write, never cache it)
    void err
    clean()
  }
}

console.log("== hard link to an outside file ==")
{
  // A hard link IS the same inode: writing "through" it would change the
  // outside file. The atomic temp+rename strategy replaces the directory
  // entry instead of writing into the inode — the outside file is unaffected.
  try {
    fs.linkSync(VICTIM, path.join(PROJ, "hard.txt"))
    const r = await tool.exec("write_file", { path: "hard.txt", content: "PWNED" })
    ok("write onto hard link does not modify the shared inode", victimIntact(), String(r))
    ok("in-project name has the new content", fs.readFileSync(path.join(PROJ, "hard.txt"), "utf8") === "PWNED")
    ok("link count of victim back to 1", fs.statSync(VICTIM).nlink === 1)
    const r2 = await tool.exec("edit_file", { path: "hard.txt", old: "PWNED", new: "EDITED" })
    ok("edit_file onto hard link likewise", String(r2).startsWith("OK") && victimIntact())
  } catch (e) {
    ok("hard links unsupported on this fs (skipped)", e.code === "EPERM" || e.code === "EXDEV" || e.code === "ENOTSUP", e.code)
  }
  clean()
}

console.log("== deleted / recreated target between checks ==")
{
  fs.writeFileSync(path.join(PROJ, "gone.txt"), "old")
  const realOpen = fs.openSync
  let fired = false
  fs.openSync = function (p, ...rest) {
    if (!fired && /gone\.txt|\/proc\/self\/fd\//.test(String(p))) { fired = true; fs.rmSync(path.join(PROJ, "gone.txt")) }
    return realOpen.call(fs, p, ...rest)
  }
  let r
  try { r = await tool.exec("write_file", { path: "gone.txt", content: "new" }) } finally { fs.openSync = realOpen }
  ok("deleted-mid-write target is recreated cleanly", String(r).startsWith("OK") && fs.readFileSync(path.join(PROJ, "gone.txt"), "utf8") === "new")
  // recreated as a DIRECTORY mid-write
  fs.writeFileSync(path.join(PROJ, "dir.txt"), "old")
  fired = false
  fs.openSync = function (p, ...rest) {
    if (!fired && /dir\.txt|\/proc\/self\/fd\//.test(String(p))) { fired = true; fs.rmSync(path.join(PROJ, "dir.txt")); fs.mkdirSync(path.join(PROJ, "dir.txt")) }
    return realOpen.call(fs, p, ...rest)
  }
  try { r = await tool.exec("write_file", { path: "dir.txt", content: "new" }) } finally { fs.openSync = realOpen }
  ok("target turned into a directory mid-write → clean error", String(r).startsWith("ERROR") && fs.statSync(path.join(PROJ, "dir.txt")).isDirectory(), String(r))
  clean()
}

console.log("== concurrent writers: two tools, one file, no torn content ==")
{
  const A = "A".repeat(200000), B = "B".repeat(200000)
  const ctxs = [makeToolContext({ cwd: PROJ, root: PROJ }), makeToolContext({ cwd: PROJ, root: PROJ })]
  const rounds = 20
  for (let i = 0; i < rounds; i++) {
    await Promise.all([ctxs[0].exec("write_file", { path: "shared.txt", content: A }), ctxs[1].exec("write_file", { path: "shared.txt", content: B })])
    const got = fs.readFileSync(path.join(PROJ, "shared.txt"), "utf8")
    if (got !== A && got !== B) { ok(`round ${i}: torn content observed`, false, `len=${got.length}`); break }
    if (i === rounds - 1) ok("20 rounds of concurrent writes: content is always exactly A or exactly B", true)
  }
  // two agents (separate processes) racing
  const script = `import { makeToolContext } from ${JSON.stringify(new URL("../tools.js", import.meta.url).href)}; const t = makeToolContext({ cwd: ${JSON.stringify(PROJ)}, root: ${JSON.stringify(PROJ)} }); for (let i=0;i<30;i++) await t.exec("write_file", { path: "multi.txt", content: process.argv[2].repeat(50000) }); console.log("done")`
  const sf = path.join(T, "agent.mjs")
  fs.writeFileSync(sf, script)
  const { spawn } = await import("node:child_process")
  const run = (mark) => new Promise((res) => { const c = spawn(process.execPath, [sf, mark], { env: { ...process.env } }); let out = ""; c.stdout.on("data", (d) => (out += d)); c.on("close", (code) => res({ code, out })) })
  const [a, b] = await Promise.all([run("X"), run("Y")])
  ok("two concurrent agent processes both completed", a.code === 0 && b.code === 0)
  const final = fs.readFileSync(path.join(PROJ, "multi.txt"), "utf8")
  ok("final content is exactly one writer's (no interleaving)", /^X+$/.test(final) || /^Y+$/.test(final))
  ok("no temp files leaked", !fs.readdirSync(PROJ).some((f) => f.includes(".forge-") && f.endsWith(".tmp")))
  clean()
}

console.log("== permission failure is explicit, never silent ==")
{
  if (process.getuid && process.getuid() === 0) {
    ok("running as root — permission test not meaningful (skipped)", true)
  } else {
    fs.mkdirSync(path.join(PROJ, "ro"))
    fs.writeFileSync(path.join(PROJ, "ro", "f.txt"), "x")
    fs.chmodSync(path.join(PROJ, "ro"), 0o555)
    const r = await tool.exec("write_file", { path: "ro/f.txt", content: "y" })
    ok("write into read-only dir → explicit permission error", /permission denied|EACCES/i.test(String(r)), String(r))
    ok("original content untouched", fs.readFileSync(path.join(PROJ, "ro", "f.txt"), "utf8") === "x")
    ok("no temp file left behind", fs.readdirSync(path.join(PROJ, "ro")).length === 1)
    fs.chmodSync(path.join(PROJ, "ro"), 0o755)
  }
  clean()
}

console.log("== apply_patch is all-or-nothing on disk ==")
{
  fs.writeFileSync(path.join(PROJ, "p1.txt"), "one\n")
  fs.writeFileSync(path.join(PROJ, "p2.txt"), "two\n")
  // second file's write is sabotaged: turn p2.txt into a directory right
  // before it is written; p1.txt must be rolled back
  const realOpen = fs.openSync
  let fired = false
  fs.openSync = function (p, ...rest) {
    if (!fired && /\.p2\.txt\.forge-|\/proc\/self\/fd\/\d+\/\.p2\.txt/.test(String(p))) { fired = true; fs.rmSync(path.join(PROJ, "p2.txt")); fs.mkdirSync(path.join(PROJ, "p2.txt")) }
    return realOpen.call(fs, p, ...rest)
  }
  const patch = "--- a/p1.txt\n+++ b/p1.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n--- a/p2.txt\n+++ b/p2.txt\n@@ -1,1 +1,1 @@\n-two\n+TWO\n"
  let r
  try { r = await tool.exec("apply_patch", { patch }) } finally { fs.openSync = realOpen }
  ok("sabotage fired", fired)
  ok("patch reported an error", String(r).startsWith("ERROR"), String(r).slice(0, 160))
  ok("first file rolled back to original", fs.readFileSync(path.join(PROJ, "p1.txt"), "utf8") === "one\n", String(r).slice(0, 160))
  clean()
}

console.log("== securefs primitives: direct adversarial calls ==")
{
  const bad = ["../x", "..", "/etc/x", "a/../../x", "a/./../../x"]
  for (const p of bad) {
    let err
    try { relativeComponents(PROJ, p) } catch (e) { err = e }
    ok(`relativeComponents rejects ${p}`, err instanceof SecureFsError && err.code === "EESCAPE")
  }
  let err
  try { secureWriteFile(PROJ, ".", "x") } catch (e) { err = e }
  ok("refuses to write the root itself", err instanceof SecureFsError)
  fs.symlinkSync(OUT, path.join(PROJ, "esc"))
  try { err = null; secureWriteFile(PROJ, "esc/new.txt", "x") } catch (e) { err = e }
  ok("symlinked component refused with ESYMLINK", err?.code === "ESYMLINK" && !fs.existsSync(path.join(OUT, "new.txt")))
  try { err = null; secureUnlink(PROJ, "esc/victim.txt") } catch (e) { err = e }
  ok("unlink through symlinked dir refused", err?.code === "ESYMLINK" && victimIntact())
  fs.symlinkSync(VICTIM, path.join(PROJ, "vlink"))
  try { err = null; secureReadFile(PROJ, "vlink") } catch (e) { err = e }
  ok("read through symlink refused (ESYMLINK)", err?.code === "ESYMLINK")
  try { err = null; secureUnlink(PROJ, "vlink") } catch (e) { err = e }
  ok("unlink of the symlink itself removes the LINK not the target", !err && !fs.existsSync(path.join(PROJ, "vlink")) && victimIntact())
  fs.writeFileSync(path.join(PROJ, "ok.txt"), "fine")
  ok("secureReadFile reads a regular file", secureReadFile(PROJ, "ok.txt") === "fine")
  const w = secureWriteFile(PROJ, "new/dir/file.txt", "created")
  ok("secureWriteFile creates parents and returns the real path", w.real === path.join(PROJ, "new/dir/file.txt") && w.bytes === 7 && !w.replaced)
  const w2 = secureWriteFile(PROJ, "new/dir/file.txt", Buffer.from([1, 2, 3]))
  ok("binary Buffer write, replaced flag", w2.bytes === 3 && w2.replaced === true)
  for (const n of ["a\0b", "a/b"]) {
    try { err = null; sfs.splitComponents(n) } catch (e) { err = e }
    ok(`component ${JSON.stringify(n)} → ${err ? err.code : "split ok"}`, n.includes("\0") ? err?.code === "EBADNAME" : !err)
  }
  clean()
}

console.log("== allowOutsideProject opt-out keeps symlink protection ==")
{
  const loose = makeToolContext({ cwd: PROJ, root: PROJ, allowOutsideProject: true })
  const r = await loose.exec("write_file", { path: path.join(OUT, "allowed.txt"), content: "user allowed" })
  ok("opt-out permits an outside write", String(r).startsWith("OK") && fs.readFileSync(path.join(OUT, "allowed.txt"), "utf8") === "user allowed")
  fs.symlinkSync("/etc/hostname", path.join(OUT, "hostlink"))
  const before = fs.readFileSync("/etc/hostname", "utf8")
  const r2 = await loose.exec("write_file", { path: path.join(OUT, "hostlink"), content: "PWNED" })
  ok("…but a symlink final component is replaced, never followed", fs.readFileSync("/etc/hostname", "utf8") === before && (String(r2).startsWith("ERROR") || !fs.lstatSync(path.join(OUT, "hostlink")).isSymbolicLink()))
  clean()
}

console.log("== no bare writeFileSync remains on model-controlled tool paths ==")
{
  const src = fs.readFileSync(new URL("../tools.js", import.meta.url), "utf8")
  const fnBody = (name) => { const i = src.indexOf(`function ${name}(`); return src.slice(i, src.indexOf("\nfunction ", i + 10)) }
  for (const fn of ["write_file", "edit_file", "multi_edit", "apply_patch"]) {
    ok(`${fn} has no fs.writeFileSync / fs.unlinkSync`, !/fs\.(writeFileSync|unlinkSync|appendFileSync)\(/.test(fnBody(fn)))
    ok(`${fn} routes through projectWrite/projectUnlink`, /projectWrite\(|projectUnlink\(/.test(fnBody(fn)))
  }
}

try { execFileSync("chmod", ["-R", "u+rwx", T]) } catch {}
fs.rmSync(T, { recursive: true, force: true })
fs.rmSync(process.env.FORGE_HOME, { recursive: true, force: true })
console.log(`\n== fs-toctou suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
