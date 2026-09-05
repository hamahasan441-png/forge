/**
 * forge — shell safety engine (v20): defense-in-depth command risk classification.
 *
 * Replaces the v19 regex-only FORBIDDEN list with a structural pass:
 *   1. split the command into sub-commands (; && || | newlines — quote aware)
 *   2. tokenize each sub-command (quote aware), strip env-assignment prefixes
 *   3. resolve the program name + normalize every path-like argument/redirect
 *      target against the working directory
 *   4. classify with layered rules: program identity, flags, and WHERE the
 *      targets live (inside the project vs. system dirs vs. $HOME vs. devices)
 *
 * Levels:
 *   "block"   catastrophic — refused everywhere, always (root wipe, mkfs,
 *             dd to raw devices, fork bombs, shutdown, device redirects…)
 *   "danger"  destructive outside the project / credentials — refused for the
 *             MODEL's bash tool; the interactive terminal asks y/N
 *   "confirm" plausible damage (rm, git reset --hard, sudo, installs…) — the
 *             interactive terminal asks y/N; the model may run it only when
 *             its file targets stay inside the project (normal dev work)
 *   "low"     ordinary mutating dev commands (mkdir, npm test, make…)
 *   "safe"    read-only-ish commands
 *
 * Zero dependencies. Pure functions — trivially testable.
 */
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

export const LEVELS = ["safe", "low", "confirm", "danger", "block"]
const LEVEL_RANK = { safe: 0, low: 1, confirm: 2, danger: 3, block: 4 }

/** Split a raw command line into sub-commands on ; && || | and newlines,
 *  respecting single/double quotes. (Pipes split too: every stage of a
 *  pipeline gets classified — `curl x | sh` must see BOTH parts.) */
export function splitSubcommands(cmd) {
  const out = []
  let cur = ""
  let quote = null
  const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = "" }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote) {
      cur += c
      if (c === quote && cmd[i - 1] !== "\\") quote = null
      continue
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue }
    if (c === "\\" && cmd[i + 1]) { cur += c + cmd[i + 1]; i++; continue }
    if (c === ";" || c === "\n" || c === "\r") { flush(); continue }
    if (c === "&" && cmd[i + 1] === "&") { flush(); i++; continue }
    if (c === "|") {
      // || is a separator, | is a pipeline stage — both split here
      flush()
      if (cmd[i + 1] === "|") i++
      continue
    }
    if (c === "&") { flush(); continue } // background &
    cur += c
  }
  flush()
  return out
}

/** Quote-aware tokenizer for one sub-command. Redirects (> >> < 2>) are kept
 *  as tokens so target extraction can see them. */
export function tokenize(sub) {
  const toks = []
  let cur = ""
  let quote = null
  const flush = () => { if (cur !== "") toks.push(cur); cur = "" }
  for (let i = 0; i < sub.length; i++) {
    const c = sub[i]
    if (quote) {
      if (c === quote && sub[i - 1] !== "\\") { quote = null; continue } // closing quote — not part of the token
      cur += c
      continue
    }
    if (c === "'" || c === '"') {
      if (quote === null) { quote = c; continue }
      if (c === quote && sub[i - 1] !== "\\") { quote = null; continue }
    }
    if (c === "\\") { cur += sub[i + 1] ?? ""; i++; continue }
    if (/\s/.test(c) && quote === null) { flush(); continue }
    if ((c === ">" || c === "<") && quote === null) {
      flush()
      let t = c
      if (sub[i + 1] === ">") { t = ">>"; i++ }
      toks.push(t)
      continue
    }
    cur += c
  }
  flush()
  return toks
}

const PATH_RE = /^(?:[A-Za-z0-9._~-]*\/|\/|~\/|~$|\.{1,2}\/)/ // looks path-ish

/** Expand $VAR / ${VAR} like a shell would (v20.1).
 *  Returns { text, unknown } — `unknown` is true when a variable could not be
 *  resolved, so callers can refuse to trust the resulting path. */
function expandVars(tok, env) {
  let t = String(tok ?? "")
  if (!t.includes("$")) return { text: t, unknown: false }
  const e = env || process.env
  let unknown = false
  t = t.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (_m, braced, bare) => {
    const name = braced || bare
    const v = e?.[name]
    if (v === undefined || v === "") { unknown = true; return "" }
    return String(v)
  })
  return { text: t, unknown }
}

/** Normalize one token to an absolute path if it is path-like.
 *  Handles ~ expansion, $VAR expansion, ./ ../, globs-at-root detection,
 *  and strips quotes. */
function toAbsPath(tok, cwd, env) {
  let t = tok.replace(/^['"]|['"]$/g, "")
  if (t.includes("$")) t = expandVars(t, env).text
  if (t.startsWith("~")) t = path.join(os.homedir(), t.slice(1))
  else if (PATH_RE.test(t)) t = path.resolve(cwd, t)
  else if (t.includes("/")) t = path.resolve(cwd, t)
  else return null
  return t
}

/** Program name of a token: basename after the last "/" (handles ./node, /bin/rm). */
function programOf(tok) {
  const t = tok.replace(/^['"]|['"]$/g, "")
  return t.split("/").filter(Boolean).pop() ?? t
}

const SYSTEM_DIRS = ["/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64", "/lib32", "/libx32", "/media", "/mnt", "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/tmp?", "/usr", "/var"].filter((d) => d !== "/tmp?")

const DEVICE_RE = /^\/dev\/(sd[a-z]|hd[a-z]|nvme\d+n\d+(p\d+)?|mmcblk\d+(p\d+)?|vd[a-z]|loop\d+|md\d+|dm-\d+|mem|port|kmem|disk\d+)$/
const DEVICE_WRITE_OK = /^\/dev\/(null|zero|stdout|stderr|tty|full|random|urandom)$/
const CREDENTIAL_DIRS = [".ssh", ".aws", ".gnupg", ".config/gcloud", ".kube", ".docker"]
const CREDENTIAL_FILES = [/^\.env($|\.)/, /^id_(rsa|dsa|ed25519|ecdsa)$/, /\.(pem|key|p12|pfx|crt|keystore)$/, /^credentials$/, /^\.netrc$/, /^\.npmrc$/, /^\.docker\/config\.json$/, /^authorized_keys$/]

function looksLikeGlobAtRoot(p) {
  return p === "/" || /^\/\*+$/.test(p) || /^\/[^/]*\*/.test(p) // /, /*, /*.something
}

function insideDir(target, dir) {
  if (!target || !dir) return false
  const rel = path.relative(path.resolve(dir), path.resolve(target))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function pathReason(p, home) {
  if (!p) return null
  if (looksLikeGlobAtRoot(p) || SYSTEM_DIRS.includes(p)) return `targets the system root (${p})`
  if (home && (p === home || p === home + "/" )) return "targets your entire HOME directory"
  if (home) {
    const rel = path.relative(home, p)
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      const first = rel.split(path.sep)[0]
      if (CREDENTIAL_DIRS.includes(first)) return `targets credentials (${rel.split(path.sep)[0]}/)`
      if (CREDENTIAL_FILES.some((re) => re.test(path.basename(p)))) return `targets a credential file (${path.basename(p)})`
    }
  }
  if (DEVICE_RE.test(p)) return `targets a raw device (${p})`
  return null
}

// --- per-program rule tables ------------------------------------------------

const BLOCK_PROGRAMS = new Set(["mkfs", "mkfs.ext2", "mkfs.ext3", "mkfs.ext4", "mkfs.bfs", "mkfs.xfs", "mkfs.vfat", "mkfs.fat", "mkfs.ntfs", "mkfs.exfat", "mkfs.minix", "mkfs.f2fs", "mkswap", "wipefs", "fdisk", "sfdisk", "cfdisk", "parted", "partprobe", "badblocks", "shutdown", "reboot", "halt", "poweroff", "zpool", "pvcreate", "vgremove"])

const POWER_WORDS = new Set(["poweroff", "reboot", "halt", "shutdown", "suspend", "hibernate", "power-off", "kexec"])

/** git subcommands that are risky */
const GIT_CONFIRM = new Set(["reset", "clean", "push", "checkout", "restore", "rebase", "filter-branch", "branch -D"])

// ---------------------------------------------------------------------------
// v20.1 P0-1 — wrapper unwrapping
//
// A command whose payload is ANOTHER command used to be judged by its wrapper
// alone: `sh -c "rm -rf /"` saw only `sh`, which is in no rule table, so the
// level stayed "safe" and the model ran it with no confirmation. These tables
// name the programs that carry a command line as an argument.
// ---------------------------------------------------------------------------

/** `prog -c "<shell command>"` / `prog -e "<code>"` — argument is a payload. */
const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "busybox", "eval", "source", "."])
/** Scripting runtimes: the payload is CODE, not shell — scan it for markers. */
const CODE_WRAPPERS = new Set(["python", "python2", "python3", "py", "perl", "ruby", "node", "nodejs", "deno", "bun", "lua", "php", "Rscript", "groovy", "osascript"])
/** Prefix programs: everything after their own flags is the real command. */
const PREFIX_WRAPPERS = new Set(["env", "nohup", "nice", "timeout", "time", "command", "stdbuf", "setsid", "xargs", "script", "watch", "unbuffer", "parallel"])
/** Flags that take a value, so unwrapping must skip the value too. */
const VALUE_FLAGS = new Set(["-c", "-e", "--eval", "-p", "--print", "-n", "-I", "-i", "-u", "-d", "-s", "--command", "--separator", "--delimiter", "-R", "-L", "-P", "--max-procs", "-t", "--timeout", "-k", "--kill-after"])

/** Things a script can do that a user (or the model) must not do silently. */
const CODE_DANGER = [
  [/\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*[fF]?[a-zA-Z]*\s+[/~]/, "deletes outside the working directory"],
  [/mkfs(\.|\s|\()/, "formats a filesystem"],
  [/\bdd\s+[^|&]*of=\/dev\/(sd|hd|nvme|mmcblk|vd|loop|md|dm-)/, "writes to a raw device"],
  [/\b(shutdown|reboot|poweroff|halt|init\s+[06])\b/, "controls system power"],
  [/:\s*\(\s*\)\s*\{/, "fork-bomb pattern"],
  [/>\s*\/etc\/|>>\s*\/etc\//, "overwrites system configuration"],
  [/\bos\.system\s*\(|\bsubprocess\b|child_process|execSync|spawnSync|Runtime\.getRuntime|\bexec\s*\(|shutil\.rmtree|\bsystem\s*\(/, "runs shell commands from a script"],
]

/**
 * Return the level/reason contributed by a wrapped payload, or null when the
 * program is not a wrapper (or there is nothing to unwrap).
 */
function unwrapWrapper(prog, rest, sub, ctx, depth) {
  const p = String(prog ?? "").toLowerCase()
  const env = ctx.env

  // 1. `$( … )` and backticks — command substitution hides a whole command
  const subs = []
  for (const m of String(sub).matchAll(/\$\(([^)]*)\)/g)) if (m[1].trim()) subs.push(m[1])
  for (const m of String(sub).matchAll(/`([^`]*)`/g)) if (m[1].trim()) subs.push(m[1])
  let worst = null
  for (const sc of subs) {
    const r = classifyCommand(sc, { ...ctx, env }, depth + 1)
    if (!worst || LEVEL_RANK[r.level] > LEVEL_RANK[worst.level]) {
      worst = { level: r.level, reason: `command substitution runs "${sc.trim().slice(0, 40)}" (${r.reasons[0] ?? r.level})` }
    }
  }

  // 2. shell wrappers: -c/--command carries a real shell command line
  if (SHELL_WRAPPERS.has(p)) {
    const idx = rest.findIndex((a) => a === "-c" || a === "--command" || a === "-e")
    const payload = idx >= 0 ? rest.slice(idx + 1).join(" ") : rest.join(" ")
    if (String(payload).trim()) {
      const r = classifyCommand(payload, { ...ctx, env }, depth + 1)
      const cand = { level: r.level, reason: `${prog} runs "${payload.trim().slice(0, 40)}" (${r.reasons[0] ?? r.level})` }
      if (!worst || LEVEL_RANK[cand.level] > LEVEL_RANK[worst.level]) worst = cand
    } else {
      const cand = { level: "confirm", reason: `${prog} with no readable payload` }
      if (!worst || LEVEL_RANK[cand.level] > LEVEL_RANK[worst.level]) worst = cand
    }
  }

  // 3. scripting runtimes: the payload is code — scan it for destructive calls
  if (CODE_WRAPPERS.has(p)) {
    const code = rest.join(" ")
    const hit = CODE_DANGER.find(([re]) => re.test(code))
    const cand = hit
      ? { level: "danger", reason: `${prog} script ${hit[1]}` }
      : { level: "low", reason: null }
    if (!worst || LEVEL_RANK[cand.level] > LEVEL_RANK[worst.level]) worst = cand
  }

  // 4. prefix wrappers: skip their own flags/values, classify what follows
  if (PREFIX_WRAPPERS.has(p)) {
    let k = 0
    while (k < rest.length && (rest[k].startsWith("-") || /^\d+(\.\d+)?[smhd]?$/.test(rest[k]) || /^[A-Za-z_]\w*=/.test(rest[k]))) {
      if (VALUE_FLAGS.has(rest[k])) k += 2
      else k += 1
    }
    const inner = rest.slice(k).join(" ")
    if (inner.trim()) {
      const r = classifyCommand(inner, { ...ctx, env }, depth + 1)
      const cand = { level: r.level, reason: `${prog} → ${r.reasons[0] ?? r.level}` }
      if (!worst || LEVEL_RANK[cand.level] > LEVEL_RANK[worst.level]) worst = cand
    } else {
      const cand = { level: "confirm", reason: `${prog} with a payload we cannot see (arguments come from stdin)` }
      if (!worst || LEVEL_RANK[cand.level] > LEVEL_RANK[worst.level]) worst = cand
    }
  }

  // 5. placeholder targets (xargs -I{} rm -rf {}) — the real paths arrive later
  if (/\b(rm|rmdir|shred|srm|find|chmod|chown|chgrp|mv|cp|tee|dd)\b/.test(p) === false && rest.some((a) => /\{\}|\$\{?[0-9@*]\}?|%s|%@/.test(a))) {
    const cand = { level: "confirm", reason: "one or more targets are placeholders resolved at run time" }
    if (!worst || LEVEL_RANK[cand.level] > LEVEL_RANK[worst.level]) worst = cand
  }

  return worst
}

function classifySub(sub, ctx, depth = 0) {
  const reasons = []
  let level = "safe"
  const bump = (lv, why) => {
    if (LEVEL_RANK[lv] > LEVEL_RANK[level]) level = lv
    if (why) reasons.push(why)
  }
  const toks = tokenize(sub)
  if (!toks.length) return { level: "safe", reasons: [], program: "", targets: [] }

  // strip leading env assignments (FOO=bar BAZ=qux cmd …)
  let i = 0
  while (i < toks.length && /^[A-Za-z_]\w*=/.test(toks[i]) && i < toks.length - 1) i++
  const prog = programOf(toks[i] ?? "")
  const rest = toks.slice(i + 1)
  const fileArgs = rest.filter((a) => !a.startsWith("-")) // non-flag args (rough file operands)

  // v20.1 P0-1: a wrapper must never HIDE its payload. `sh -c "rm -rf /"`,
  // `python -c "os.system('rm -rf /')"`, `xargs rm -rf /` and `eval` used to
  // classify as "safe" (only the wrapper was examined) and therefore ran
  // unsupervised. Unwrap, classify the payload, take the WORST level.
  const wrapped = depth < 3 ? unwrapWrapper(prog, rest, sub, ctx, depth) : null
  if (wrapped) bump(wrapped.level, wrapped.reason)

  // collect redirect targets
  const redirects = []
  for (let j = 0; j < toks.length; j++) {
    if (toks[j] === ">" || toks[j] === ">>" || toks[j] === "<") {
      const t = toks[j + 1] ? toAbsPath(toks[j + 1], ctx.cwd, ctx.env) : null
      if (t) redirects.push({ op: toks[j], path: t })
    }
  }
  // collect path-like arguments (bare names resolve against cwd too — they
  // are file operands in context)
  const targets = []
  for (const t of fileArgs) {
    const abs = toAbsPath(t, ctx.cwd, ctx.env) ?? path.resolve(ctx.cwd, t)
    targets.push(abs)
  }
  for (const r of redirects) targets.push(r.path)

  // 1. fork bombs — a function whose body pipes itself into itself (any name)
  if (/\(\)\s*\{/.test(sub) && /\|\s*&|&\s*\|/.test(sub.replace(/[^:|&{}()\w]\s/g, ""))) {
    return { level: "block", reasons: ["fork-bomb pattern (self-piping shell function)"], program: prog, targets }
  }
  if (/^:\s*\(\)\s*\{/.test(sub.trim())) {
    return { level: "block", reasons: ["fork bomb"], program: prog, targets }
  }
  const fnSelf = sub.match(/(\w+)\s*\(\)\s*\{[^}]*\1[^}]*\|[^}]*\}/)
  if (fnSelf) return { level: "block", reasons: [`fork-bomb-like function (${fnSelf[1]})`], program: prog, targets }

  // 2. identity-based blocks
  if (BLOCK_PROGRAMS.has(prog)) bump("block", `${prog} destroys/rewrites disk or boot state`)
  if (prog === "init" && (rest[0] === "0" || rest[0] === "6")) bump("block", `init ${rest[0]} halts/reboots the machine`)
  if (prog === "systemctl") {
    const hasPower = rest.some((a) => POWER_WORDS.has(String(a).toLowerCase()))
    if (hasPower) bump("block", "systemctl power control")
    else bump("confirm", "systemctl changes system service state")
  }
  if (prog === "rm") {
    const flags = rest.filter((a) => a.startsWith("-")).join("")
    const recursive = /r/i.test(flags)
    const forced = /f/i.test(flags)
    const hasTargets = fileArgs.length > 0
    // root/system/home wipe → always block
    for (const t of targets) {
      const why = pathReason(t, ctx.home)
      if (why && (looksLikeGlobAtRoot(t) || SYSTEM_DIRS.includes(t) || t === ctx.home || DEVICE_RE.test(t))) { bump("block", `rm ${why}`); break }
    }
    if (level !== "block") {
      for (const t of targets) {
        const why = pathReason(t, ctx.home)
        if (why) { bump("danger", `rm ${why}`); break }
      }
    }
    // v20.1: a placeholder target (`xargs -I{} rm -rf {}`) is filled in at run
    // time — we cannot prove where it points, so it is never merely "confirm".
    if (targets.some((t) => /\{\}|\$\{?[0-9@*]\}?|%s|%@/.test(path.basename(String(t))))) {
      bump("danger", "rm targets are placeholders resolved at run time")
    }
    if (LEVEL_RANK[level] < 2) {
      if (!hasTargets) bump("danger", "rm without a file argument")
      else bump("confirm", `rm ${recursive ? "-r " : ""}${forced ? "-f " : ""}deletes ${hasTargets ? "files/directories" : "arguments"}`)
    }
  }
  if (prog === "rmdir") bump("low", "rmdir removes empty directories only")
  if (prog === "shred" || prog === "srm" || prog === "srm-rm") {
    for (const t of targets) { const why = pathReason(t, ctx.home); if (why) { bump("danger", `shred ${why}`); break } }
    if (LEVEL_RANK[level] < 2) bump("confirm", "shred overwrites file contents irrecoverably")
  }
  if (prog === "dd") {
    const of = rest.find((a) => /^of=/.test(a))
    if (of) {
      const dest = toAbsPath(of.slice(3), ctx.cwd)
      if (dest && DEVICE_RE.test(dest) && !DEVICE_WRITE_OK.test(dest)) bump("block", `dd writes to a raw device (${dest})`)
      else if (dest && /^\/dev\/(mem|port|kmem)$/.test(dest)) bump("block", `dd writes to kernel memory (${dest})`)
      else bump("confirm", "dd writes raw data")
    } else bump("confirm", "dd writes raw data")
  }
  if (prog === "chmod" || prog === "chown" || prog === "chgrp") {
    const recursive = rest.some((a) => /^-[a-zA-Z]*R/.test(a) || a === "--recursive")
    const mode = rest.find((a) => /^[0-7]{3,4}$/.test(a) || /^--[a-z=]+/.test(a))
    for (const t of targets) {
      if (looksLikeGlobAtRoot(t) || SYSTEM_DIRS.includes(t)) {
        bump("block", `${prog} ${mode ?? ""} ${recursive ? "-R " : ""}on the system root (${t})`)
        break
      }
    }
    if (level === "safe") {
      if (recursive) bump("confirm", `${prog} -R changes permissions recursively`)
      else bump("low", `${prog} changes permissions`)
    }
  }
  if (prog === "mv" || prog === "cp") {
    for (const t of targets) {
      if (looksLikeGlobAtRoot(t) || SYSTEM_DIRS.includes(t)) { bump("block", `${prog} targets a system directory (${t})`); break }
    }
    if (level === "safe" && prog === "mv") bump("low", "mv moves/renames files")
  }
  if (prog === "find") {
    const destructive = rest.includes("-delete") || /-exec\s+rm/.test(rest.join(" "))
    if (destructive) {
      const root = targets[0] ?? null
      const why = root ? pathReason(root, ctx.home) : null
      if (!root || looksLikeGlobAtRoot(root) || SYSTEM_DIRS.includes(root)) bump("block", `find ${root ?? "/"} -delete/-exec rm wipes system files`)
      else if (why) bump("danger", `find ${why}`)
      else bump("confirm", `find ${root} -delete removes files recursively`)
    }
  }
  if (prog === "sudo" || prog === "doas" || prog === "su") {
    // classify the inner command first, then apply sudo policy
    const inner = classifySub(rest.join(" "), { ...ctx, allowSudo: true }, depth + 1) // inner program decides its own level
    if (LEVEL_RANK[inner.level] >= 4) return { level: "block", reasons: [`sudo + ${inner.reasons[0] ?? "destructive command"}`], program: prog, targets }
    if (!ctx.allowSudo) bump("danger", "sudo runs commands with elevated privileges")
  }
  if (prog === "kill" || prog === "pkill" || prog === "killall") bump("confirm", `${prog} terminates processes`)
  if (prog === "crontab") bump("confirm", "crontab edits scheduled jobs")
  if (prog === "useradd" || prog === "userdel" || prog === "usermod" || prog === "passwd") bump("danger", `${prog} modifies system accounts`)

  // package managers / installs
  if (prog === "npm" || prog === "yarn" || prog === "pnpm" || prog === "bun" || prog === "npm.cmd") {
    const sub2 = rest[0] ?? ""
    if (sub2 === "publish") bump("danger", `${prog} publish uploads a package publicly`)
    else if (["install", "i", "add", "remove", "uninstall", "update", "upgrade", "ci", "link", "unlink"].includes(sub2)) {
      const global = rest.includes("-g") || rest.includes("--global")
      bump(global ? "danger" : "confirm", `${prog} ${sub2}${global ? " -g (global)" : ""} changes installed packages`)
    } else if (sub2 === "test" || sub2 === "run" || sub2 === "run-script" || sub2 === "exec" || sub2 === "ls" || sub2 === "list" || sub2 === "view" || sub2 === "info" || sub2 === "outdated") bump("safe", null)
    else bump("low", null)
  }
  if (prog === "pip" || prog === "pip3" || prog === "pipx") {
    const sub2 = rest[0] ?? ""
    if (["install", "uninstall", "upgrade"].includes(sub2)) {
      const user = rest.includes("--user")
      const global = !user && !insideDir(path.resolve(ctx.cwd), ctx.cwd) // pip default targets site-packages
      bump(global || rest.includes("--break-system-packages") ? "danger" : "confirm", `pip ${sub2} modifies the Python environment`)
    } else bump("low", null)
  }
  if (prog === "apt" || prog === "apt-get" || prog === "apk" || prog === "dnf" || prog === "yum" || prog === "zypper" || prog === "pacman" || prog === "pkg") {
    const sub2 = rest[0] ?? ""
    if (["install", "remove", "purge", "autoremove", "upgrade", "full-upgrade", "dist-upgrade", "update"].includes(sub2)) bump("danger", `${prog} ${sub2} modifies system packages`)
    else bump("low", null)
  }
  if (prog === "brew") bump("confirm", "brew changes installed packages")
  if (prog === "docker") {
    const sub2 = rest[0] ?? ""
    if (["rm", "rmi", "prune", "system", "volume", "kill", "stop"].includes(sub2)) bump("confirm", `docker ${sub2} removes containers/images/volumes`)
    else bump("low", null)
  }

  // git risky subcommands
  if (prog === "git") {
    const sub2 = rest[0] ?? ""
    if (GIT_CONFIRM.has(sub2)) {
      const hard = rest.includes("--hard") || rest.includes("-f") || rest.includes("--force") || sub2 === "push" || sub2 === "clean" || sub2 === "filter-branch"
      const forcePush = sub2 === "push" && (rest.includes("-f") || rest.includes("--force") || rest.includes("--force-with-lease"))
      bump(hard || forcePush ? "danger" : "confirm", `git ${sub2}${hard ? " (destructive flag)" : ""}`)
    } else bump("safe", null)
  }

  // shell piping an arbitrary download into a shell (detected at the pipeline
  // level in classifyCommand — kept here for single-string redirects)
  if (prog === "curl" || prog === "wget" || prog === "fetch") {
    for (const a of rest) {
      const raw = String(a)
      // metadata / link-local / loopback targets the model should never touch
      if (/169\.254\.169\.254|169\.254\.|metadata\.google\.|instance-data/i.test(raw)) bump("danger", `network request to a cloud metadata/link-local address (${raw.slice(0, 40)})`)
    }
  }
  if (prog === "env" || prog === "printenv" || prog === "export") bump("safe", null)

  // redirects into raw devices or system files
  for (const r of redirects) {
    if (DEVICE_RE.test(r.path) && !DEVICE_WRITE_OK.test(r.path) && r.op !== "<") {
      bump("block", `redirect ${r.op} writes to a raw device (${r.path})`)
    }
    if (["/etc/passwd", "/etc/shadow", "/etc/sudoers", "/boot/vmlinuz"].some((f) => r.path === f) && r.op !== "<") {
      bump("block", `redirect ${r.op} overwrites ${r.path}`)
    }
  }

  // common mutating dev programs default to low (confirmation never needed)
  if (LEVEL_RANK[level] < 1 && ["mkdir", "touch", "ln", "sed", "awk", "make", "gcc", "g++", "cc", "cargo", "go", "rsync", "patch", "cmake"].includes(prog)) {
    bump("low", null)
  }

  // writes outside the project for otherwise-mutating programs. Only the WRITE
  // operand matters (cp/mv LAST arg, redirect target, rm all args) — reading
  // from /usr/share is fine, writing to /etc is not.
  const WRITE_LAST = new Set(["cp", "mv", "ln", "rsync", "install", "tee", "truncate", "dd", "chmod", "chown", "chgrp"])
  const WRITE_ALL = new Set(["rm", "find", "shred", "srm"])
  const mutating = LEVEL_RANK[level] >= 1 || WRITE_LAST.has(prog) || WRITE_ALL.has(prog) || ["sed", "awk", "patch", "make", "g++", "gcc", "cc", "cargo", "go"].includes(prog)
  if (mutating && ctx.root) {
    const writeTargets = WRITE_LAST.has(prog) ? [targets[targets.length - 1]].filter(Boolean) : targets
    for (const t of writeTargets) {
      if (!insideDir(t, ctx.root)) {
        const why = pathReason(t, ctx.home)
        if (why) bump("danger", `${prog || "command"} ${why}`)
        else if (WRITE_LAST.has(prog) || WRITE_ALL.has(prog)) bump("danger", `${prog} writes outside the project (${path.relative(ctx.root, t).slice(0, 40)})`)
        break
      }
    }
  }

  return { level, reasons: reasons.filter(Boolean), program: prog, targets }
}

/** Fork-bomb detection on the RAW command (before sub-splitting — the `&`
 *  inside a function body would otherwise split the pattern apart). */
function isForkBomb(raw) {
  if (/^:\s*\(\)\s*\{/.test(raw.trim())) return true
  // f(){ f|f& };f — a function whose body pipes itself into itself
  if (/\(\)\s*\{[^}]*\|[^}]*&/.test(raw.replace(/\s+/g, " "))) return true
  const m = raw.match(/(\w+)\s*\(\)\s*\{[^}]*\b\1\b[^}]*\|[^}]*\}/)
  if (m) return true
  return false
}

/** Classify a full command line. Returns the WORST level found plus reasons.
 *  ctx: { cwd, root (project boundary — defaults to cwd), home, allowSudo } */
export function classifyCommand(command, ctx = {}, depth = 0) {
  // v20.0.1: the classifier is the safety choke point — it must NEVER throw.
  // Any unexpected parser error fails CLOSED (danger = ask the user / refuse
  // for the model) instead of bubbling a raw JS error into the chat.
  try {
    return classifyCommandUnsafe(command, ctx, depth)
  } catch (e) {
    return {
      level: "danger",
      reasons: [`command could not be analyzed safely (${e?.message ?? e}) — treated as risky`],
      targets: [], programs: [], unsafe: true,
    }
  }
}

function classifyCommandUnsafe(command, ctx = {}, depth = 0) {
  const raw = String(command ?? "")
  if (isForkBomb(raw)) return { level: "block", reasons: ["fork-bomb pattern (self-piping shell function)"], targets: [], programs: [] }
  const c = {
    cwd: path.resolve(ctx.cwd || process.cwd()),
    root: path.resolve(ctx.root || ctx.cwd || process.cwd()),
    home: ctx.home || os.homedir(),
    allowSudo: ctx.allowSudo === true,
    env: ctx.env || process.env, // v20.1: $VAR targets are expanded with this
  }
  const subs = splitSubcommands(String(command ?? ""))
  let worst = "safe"
  const reasons = []
  const targets = []
  const programs = []
  for (const sub of subs) {
    const r = classifySub(sub, c, depth)
    programs.push(r.program)
    targets.push(...r.targets)
    if (LEVEL_RANK[r.level] > LEVEL_RANK[worst]) worst = r.level
    reasons.push(...r.reasons)
  }
  // pipeline-level rule: download piped straight into a shell/interpreter
  const fetchish = /^(curl|wget|fetch|http|https)$/
  const shellish = /^(sh|bash|zsh|dash|ksh|fish|python|python3|node|eval|sudo|tee)$/
  const hasFetch = programs.some((p) => fetchish.test(p))
  const hasShell = programs.some((p) => shellish.test(p))
  let level = worst
  if (hasFetch && hasShell && LEVEL_RANK[level] < 2) {
    level = "confirm"
    reasons.push("pipes a downloaded payload straight into a shell")
  }
  return { level, reasons: [...new Set(reasons.filter(Boolean))], targets, programs }
}

/** Policy: may the MODEL's bash tool run this? (block/danger refused;
 *  confirm allowed only when file targets stay inside the project). */
export function modelMayRun(command, ctx, opts = {}) {
  const c = classifyCommand(command, { ...ctx, allowSudo: opts.allowSudo })
  if (c.level === "block") return { ok: false, reason: `BLOCKED for safety: ${c.reasons[0] ?? "catastrophic command"}. Refine the command.` }
  if (c.level === "danger") {
    if (opts.assumeYes) return { ok: true, reason: c.reasons[0], level: c.level }
    return { ok: false, reason: `BLOCKED for safety: ${c.reasons[0] ?? "destructive outside the project"}. This needs explicit user consent — ask the user to run it in the terminal (or set tools.assumeYes: true).`, level: c.level }
  }
  if (c.level === "confirm") {
    // targets must stay inside the project boundary for autonomous execution
    const root = path.resolve((ctx && (ctx.root || ctx.cwd)) || process.cwd())
    const outside = c.targets.find((t) => !insideDir(t, root))
    if (outside) return { ok: false, reason: `BLOCKED for safety: ${c.reasons[0] ?? "command"} targets a path outside the project (${outside}). Ask the user, or keep changes inside the working directory.`, level: c.level }
    if (c.programs.includes("sudo") && !opts.allowSudo) return { ok: false, reason: "BLOCKED: sudo needs explicit consent — set tools.allowSudo: true in config to permit agent sudo use.", level: c.level }
    return { ok: true, level: c.level }
  }
  return { ok: true, level: c.level }
}

/** Policy: may the USER's typed terminal line run this? (block always refused;
 *  danger/confirm need a TTY y/N or FORGE_ASSUME_YES=1 when piped). */
export function userMayRun(command, ctx, opts = {}) {
  const c = classifyCommand(command, ctx)
  if (c.level === "block") return { ok: false, reason: `BLOCKED for safety: ${c.reasons[0] ?? "catastrophic command"}`, needsConfirm: false, level: c.level }
  if (c.level === "danger" || c.level === "confirm") {
    if (opts.assumeYes) return { ok: true, needsConfirm: false, level: c.level, reason: c.reasons[0] }
    if (opts.interactive) return { ok: true, needsConfirm: true, level: c.level, reason: c.reasons[0] }
    return { ok: false, needsConfirm: false, level: c.level, reason: `BLOCKED (non-interactive): ${c.reasons[0] ?? "risky command"} — needs confirmation. Re-run with FORGE_ASSUME_YES=1 to allow it.` }
  }
  return { ok: true, needsConfirm: false, level: c.level }
}

/** v19 compat: the old FORBIDDEN export — now derived from the real engine. */
export const FORBIDDEN = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*r[a-zA-Z]*f?[a-zA-Z]*\s+\/(\s|$)/, why: "rm -rf / (root wipe)" },
  { re: /mkfs(\.|\s)/, why: "mkfs (filesystem format)" },
  { re: /:\(\)\s*\{.*\}\s*;\s*:/, why: "fork bomb" },
  { re: /\bdd\s+[^|]*of=\/dev\/(sd|hd|nvme|mmcblk)/, why: "dd to raw disk" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, why: "system power control" },
  { re: /chmod\s+-R\s+0?0?0\s+\//, why: "chmod 000 /" },
]

// keep fs import used (future: real symlink resolution for targets)
void fs
