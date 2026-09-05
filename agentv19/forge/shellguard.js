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
    // ${VAR…}, $(cmd), <(cmd), >(cmd) are expansions, not groups — keep them whole
    if ((c === "$" || c === "<" || c === ">") && (cmd[i + 1] === "(" || (c === "$" && cmd[i + 1] === "{"))) {
      const open = cmd[i + 1], close = open === "(" ? ")" : "}"
      let depth = 0, j = i + 1
      for (; j < cmd.length; j++) {
        if (cmd[j] === open) depth++
        else if (cmd[j] === close && --depth === 0) break
      }
      cur += cmd.slice(i, j + 1)
      i = j
      continue
    }
    if (c === "{" && cmd[i + 1] === "}") { cur += "{}"; i++; continue } // find -exec … {} placeholder
    // ( ) and { } group markers are separators — `(rm -rf /)`, `{ rm -rf /; }`
    // then classify as their contents instead of as an unknown program
    if (c === "(" || c === ")" || c === "{" || c === "}") { flush(); continue }
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

/** Normalize one token to an absolute path if it is path-like.
 *  Handles ~ expansion, ./ ../, globs-at-root detection, and strips quotes.
 *  Well-known variables that point OUTSIDE any project ($HOME, $TMPDIR, …)
 *  are expanded like the shell would — `rm -rf $HOME` and `rm -rf ~` are the
 *  same command and must classify the same way. */
const KNOWN_VARS = () => ({
  HOME: os.homedir(),
  TMPDIR: os.tmpdir(),
  TMP: os.tmpdir(),
  TEMP: os.tmpdir(),
  USER: os.userInfo?.().username ?? "",
  LOGNAME: os.userInfo?.().username ?? "",
})

function expandVars(t) {
  const vars = KNOWN_VARS()
  return t.replace(/\$\{([A-Za-z_]\w*)(?::?[-=+?][^}]*)?\}|\$([A-Za-z_]\w*)/g, (m, braced, bare) => {
    const name = braced || bare
    if (Object.prototype.hasOwnProperty.call(vars, name) && vars[name]) return vars[name]
    return m // unknown variable — left as-is (handled by hasUnknownExpansion)
  })
}

/** Does the token still contain shell expansion we cannot resolve statically
 *  ($VAR, $(cmd), `cmd`)? Such a target could be ANYTHING at run time. */
function hasUnknownExpansion(tok) {
  const t = expandVars(tok)
  return /\$[A-Za-z_{(]|`/.test(t)
}

function toAbsPath(tok, cwd) {
  let t = tok.replace(/^['"]|['"]$/g, "")
  t = expandVars(t)
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

// partitions count too: `cat x > /dev/sda1` was not matched by the v20 regex
const DEVICE_RE = /^\/dev\/(sd[a-z]+\d*|hd[a-z]+\d*|xvd[a-z]+\d*|nvme\d+n\d+(p\d+)?|mmcblk\d+(p\d+)?|vd[a-z]+\d*|loop\d+(p\d+)?|md\d+(p\d+)?|dm-\d+|mapper\/[^/]+|mem|port|kmem|disk\d+(s\d+)?|rdisk\d+(s\d+)?|block\/.+|zram\d+|nbd\d+(p\d+)?|ubi\d+(_\d+)?|mtd(block)?\d+)$/
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

/** Programs that just run their arguments as another command: strip them and
 *  classify what they wrap. `nohup rm -rf /`, `time rm -rf /`, `env rm -rf /`,
 *  `timeout 10 rm -rf /`, `xargs rm -rf /`, `busybox rm -rf /` all classified
 *  as "safe" in v20 because the program name was the wrapper, not rm. */
const TRANSPARENT_WRAPPERS = new Set(["nohup", "time", "nice", "ionice", "env", "command", "exec", "builtin", "timeout", "xargs", "busybox", "stdbuf", "unbuffer", "caffeinate", "chrt", "taskset", "setsid", "strace", "ltrace", "watch", "flock", "chroot", "setpriv", "runuser", "doas", "sudo", "su"])
/** Wrapper flags that take a value (skipped together with the value). */
const WRAPPER_VALUE_FLAGS = new Set(["-n", "-u", "-g", "-c", "-s", "-k", "-I", "-L", "-P", "-d", "-a", "-w", "-e", "-o", "-p", "--signal", "--kill-after", "--user", "--group", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace"])

function unwrap(toks) {
  let i = 0
  // strip leading env assignments (FOO=bar BAZ=qux cmd …)
  while (i < toks.length && /^[A-Za-z_]\w*=/.test(toks[i]) && i < toks.length - 1) i++
  let guard = 0
  while (i < toks.length && guard++ < 8) {
    const prog = programOf(toks[i])
    if (!TRANSPARENT_WRAPPERS.has(prog)) break
    if (prog === "sudo" || prog === "doas" || prog === "su") break // handled by the sudo policy below
    i++
    // skip the wrapper's own flags (and their values)
    while (i < toks.length) {
      const t = toks[i]
      if (prog === "timeout" && /^\d+(\.\d+)?[smhd]?$/.test(t)) { i++; continue } // timeout DURATION
      if (prog === "nice" && /^-?\d+$/.test(t)) { i++; continue }
      if (prog === "chroot" && !t.startsWith("-")) { i++; break } // chroot NEWROOT cmd… — skip NEWROOT, classify cmd
      if (t === "--") { i++; break }
      if (t.startsWith("-")) {
        if (WRAPPER_VALUE_FLAGS.has(t) && !/^-[a-zA-Z]\S/.test(t)) i += 2
        else i++
        continue
      }
      if (prog === "env" && /^[A-Za-z_]\w*=/.test(t)) { i++; continue } // env FOO=bar cmd
      break
    }
  }
  return i
}

/** Interpreters that run a script string: sh -c "…", python3 -c "…", node -e "…".
 *  The payload is classified recursively (shells) or by keyword (languages). */
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "csh", "tcsh", "eval"])
const LANG_INTERPRETERS = new Set(["python", "python2", "python3", "perl", "ruby", "node", "nodejs", "php", "lua", "deno", "bun"])
// language payloads: destructive filesystem calls aimed at root/home/system dirs
const LANG_DESTRUCTIVE_RE = /(rmtree|unlink|remove|rmdir|rmSync|rm|rimraf|rm_rf|os\.system|subprocess|child_process|execSync|spawnSync|shutil)\w*\s*\(\s*(['"`])(\/|~|\$HOME|\/home\/|\/etc|\/usr|\/var|\/boot)[^'"`]*\2\s*(,|\))/i

function inlineScript(prog, rest) {
  if (prog === "eval") return rest.join(" ")
  // -c / -e / --eval / -lc / -ic variants: the FIRST non-flag arg after them is the script
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k]
    if (SHELL_INTERPRETERS.has(prog) && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) return rest[k + 1] ?? ""
    if (LANG_INTERPRETERS.has(prog) && (a === "-c" || a === "-e" || a === "--eval" || a === "-p" || a === "--print" || a === "-r")) return rest[k + 1] ?? ""
  }
  return null
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

  const i = unwrap(toks)
  const prog = programOf(toks[i] ?? "")
  const rest = toks.slice(i + 1)
  const fileArgs = rest.filter((a) => !a.startsWith("-")) // non-flag args (rough file operands)

  // inline scripts: sh -c "rm -rf /", eval "…", python3 -c "shutil.rmtree('/')"
  if (SHELL_INTERPRETERS.has(prog) || LANG_INTERPRETERS.has(prog)) {
    const script = inlineScript(prog, rest)
    if (script !== null) {
      if (SHELL_INTERPRETERS.has(prog) && depth < 4) {
        let worst = { level: "safe", reasons: [], program: prog, targets: [] }
        for (const p of splitSubcommands(script)) {
          const r = classifySub(p, ctx, depth + 1)
          if (LEVEL_RANK[r.level] > LEVEL_RANK[worst.level]) worst = { ...r, program: prog, reasons: [...r.reasons] }
          else worst.reasons.push(...r.reasons)
          worst.targets = [...worst.targets, ...r.targets]
        }
        if (LEVEL_RANK[worst.level] < 2) { worst.level = "confirm"; worst.reasons.push(`${prog} runs an inline script`) }
        return worst
      }
      if (LANG_INTERPRETERS.has(prog)) {
        if (LANG_DESTRUCTIVE_RE.test(script)) return { level: "block", reasons: [`${prog} inline script deletes system/home paths`], program: prog, targets: [] }
        if (/rmtree|rimraf|rm_rf|fs\.rm\w*\([^)]*recursive|unlink|remove\(/i.test(script)) bump("confirm", `${prog} inline script deletes files`)
      }
    }
  }

  // collect redirect targets
  const redirects = []
  for (let j = 0; j < toks.length; j++) {
    if (toks[j] === ">" || toks[j] === ">>" || toks[j] === "<") {
      const t = toks[j + 1] ? toAbsPath(toks[j + 1], ctx.cwd) : null
      if (t) redirects.push({ op: toks[j], path: t })
    }
  }
  // collect path-like arguments (bare names resolve against cwd too — they
  // are file operands in context)
  const targets = []
  for (const t of fileArgs) {
    const abs = toAbsPath(t, ctx.cwd) ?? path.resolve(ctx.cwd, t)
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
      if (why && (looksLikeGlobAtRoot(t) || SYSTEM_DIRS.includes(t) || t === ctx.home || t === ctx.home + path.sep || DEVICE_RE.test(t))) { bump("block", `rm ${why}`); break }
    }
    if (level !== "block") {
      for (const t of targets) {
        const why = pathReason(t, ctx.home)
        if (why) { bump("danger", `rm ${why}`); break }
      }
    }
    // a recursive rm whose target is an unresolvable expansion ($(cmd), `cmd`,
    // unknown $VAR) can point anywhere at run time — never autonomous
    if (level !== "block" && recursive && fileArgs.some((a) => hasUnknownExpansion(a))) bump("danger", "rm -r on a dynamically expanded path (cannot verify the target)")
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
    // (v20.0.1 fix: this branch referenced an undefined `why` and threw a
    // ReferenceError for every `mv`/`cp` aimed at a system dir — which took
    // the whole classifier down instead of blocking the command)
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
    // classify the inner command first, then apply sudo policy. Re-quote the
    // tokens so `sudo sh -c "rm -rf /"` keeps its script intact (joining the
    // raw tokens dropped the quotes and hid the payload from the recursion).
    const innerToks = rest.filter((a, k) => !(k === 0 && a === "--"))
    const requote = (a) => (/[\s"'$`|&;<>()]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)
    const inner = depth < 4 ? classifySub(innerToks.map(requote).join(" "), { ...ctx, allowSudo: true }, depth + 1) : { level: "safe", reasons: [] }
    if (LEVEL_RANK[inner.level] >= 4) return { level: "block", reasons: [`sudo + ${inner.reasons[0] ?? "destructive command"}`], program: prog, targets }
    if (LEVEL_RANK[inner.level] >= 3) bump("danger", `sudo + ${inner.reasons[0] ?? "destructive command"}`)
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
    for (let k = 0; k < rest.length; k++) {
      const raw = String(rest[k])
      // metadata / link-local / loopback targets the model should never touch
      if (/169\.254\.169\.254|169\.254\.|metadata\.google\.|instance-data/i.test(raw)) bump("danger", `network request to a cloud metadata/link-local address (${raw.slice(0, 40)})`)
      // upload of a local file (-d @file, --data-binary @file, -F x=@file,
      // -T file, --upload-file file): exfiltration if the file is a credential
      let up = null
      if (/^@/.test(raw) && k > 0 && /^(-d|--data|--data-binary|--data-raw|--data-urlencode|--data-ascii)$/.test(rest[k - 1])) up = raw.slice(1)
      else if (/^(-d|--data|--data-binary|--data-raw|--data-urlencode|--data-ascii)=?@/.test(raw)) up = raw.replace(/^[^@]*@/, "")
      else if (/^-F$/.test(raw) && rest[k + 1]?.includes("=@")) up = rest[k + 1].split("=@")[1]
      else if (/=@/.test(raw) && k > 0 && rest[k - 1] === "-F") up = raw.split("=@")[1]
      else if ((raw === "-T" || raw === "--upload-file") && rest[k + 1]) up = rest[k + 1]
      else if (raw === "--post-file" && rest[k + 1]) up = rest[k + 1]
      else if (/^--(post-file|body-file)=/.test(raw)) up = raw.replace(/^--[a-z-]+=/, "")
      if (up) {
        const abs = toAbsPath(up, ctx.cwd) ?? path.resolve(ctx.cwd, up)
        const why = pathReason(abs, ctx.home)
        const base = path.basename(abs)
        if (why || CREDENTIAL_FILES.some((re) => re.test(base))) bump("danger", `${prog} uploads a credential file (${base})`)
        else if (!insideDir(abs, ctx.root)) bump("confirm", `${prog} uploads a file from outside the project (${base})`)
        else bump("confirm", `${prog} uploads a local file (${base})`)
      }
    }
  }
  if (prog === "env" || prog === "printenv" || prog === "export") bump("safe", null)

  // redirects into raw devices, system files, credential files, or anywhere
  // outside the project. `echo x >> ~/.ssh/authorized_keys` and
  // `printf x > /etc/cron.d/job` classified as SAFE in v20 because only the
  // program name was inspected — the redirect target is the write.
  for (const r of redirects) {
    if (r.op === "<") continue
    if (DEVICE_RE.test(r.path) && !DEVICE_WRITE_OK.test(r.path)) {
      bump("block", `redirect ${r.op} writes to a raw device (${r.path})`)
      continue
    }
    if (["/etc/passwd", "/etc/shadow", "/etc/sudoers", "/boot/vmlinuz", "/etc/group", "/etc/gshadow"].some((f) => r.path === f) || /^\/etc\/sudoers\.d\//.test(r.path)) {
      bump("block", `redirect ${r.op} overwrites ${r.path}`)
      continue
    }
    if (DEVICE_WRITE_OK.test(r.path)) continue
    const why = pathReason(r.path, ctx.home)
    if (why) { bump("danger", `redirect ${r.op} ${why}`); continue }
    if (ctx.home && insideDir(r.path, ctx.home) && !insideDir(r.path, ctx.root)) {
      const rel = path.relative(ctx.home, r.path)
      const first = rel.split(path.sep)[0]
      const base = path.basename(r.path)
      if (CREDENTIAL_DIRS.includes(first) || CREDENTIAL_FILES.some((re) => re.test(base))) { bump("danger", `redirect ${r.op} writes a credential file (~/${rel})`); continue }
      if (/^\.(bashrc|bash_profile|profile|zshrc|zprofile|zshenv|kshrc|cshrc|tcshrc|login|logout|bash_logout|xinitrc|xsession|xprofile|inputrc|gitconfig|git-credentials)$/.test(base) || /^\.(config|local\/share)\/systemd\//.test(rel)) { bump("danger", `redirect ${r.op} modifies a shell/user startup file (~/${rel})`); continue }
    }
    if (ctx.root && !insideDir(r.path, ctx.root)) {
      if (SYSTEM_DIRS.some((d) => d !== "/" && insideDir(r.path, d)) && !insideDir(r.path, os.tmpdir()) && !/^\/tmp\/|^\/var\/tmp\/|^\/dev\/shm\//.test(r.path)) bump("danger", `redirect ${r.op} writes into a system directory (${r.path})`)
      else bump("confirm", `redirect ${r.op} writes outside the project (${path.relative(ctx.root, r.path).slice(0, 40)})`)
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
export function classifyCommand(command, ctx = {}) {
  const raw = String(command ?? "")
  if (isForkBomb(raw)) return { level: "block", reasons: ["fork-bomb pattern (self-piping shell function)"], targets: [], programs: [] }
  const c = {
    cwd: path.resolve(ctx.cwd || process.cwd()),
    root: path.resolve(ctx.root || ctx.cwd || process.cwd()),
    home: ctx.home || os.homedir(),
    allowSudo: ctx.allowSudo === true,
  }
  const subs = splitSubcommands(String(command ?? ""))
  let worst = "safe"
  const reasons = []
  const targets = []
  const programs = []
  for (const sub of subs) {
    const r = classifySub(sub, c)
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
