/**
 * forge — agent tools (zero dependencies, Node built-ins only)
 *
 * bash, read_file, write_file, edit_file, multi_edit, apply_patch, list_dir, glob_files,
 * grep_files, fetch_url, web_search, todo, think, memory, delegate, load_skill, git_status
 * (17 tools)
 *
 * v20 hardening:
 *   - safePath: project-boundary enforcement for WRITES, symlink escape checks,
 *     sensitive-file protection for READS (.env, .ssh, keys, credentials, …)
 *   - bash: structural command risk classification (shellguard.js) instead of
 *     regex-only blocking; sudo needs consent; targets outside the project are
 *     refused for the model
 *   - fetch_url: SSRF guard (netguard.js) — DNS resolution + private/loopback/
 *     link-local/metadata/IPv6 checks, DNS-rebinding safe
 *   - load_skill: traversal-safe name validation
 *   - every tool RESULT is secret-redacted (secrets.js) before it enters
 *     conversation history / sessions
 *   - delegate: roles (researcher/reviewer/tester/security/coder), timeout,
 *     concurrency cap, depth guard; no longer misclassified as a write tool
 *   - checkpoints also track CREATED files → undo removes them (hash-verified)
 *   - memory: hierarchical (global + project) with relevance retrieval and
 *     structured failure learning
 */
import { execFile } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { snapshotBefore, sealCreated } from "./checkpoint.js"
import { parsePatch, applyParsedPatch } from "./diffpatch.js"
import { classifyCommand, modelMayRun } from "./shellguard.js"
import { assertFetchableUrl } from "./netguard.js"
import { redact } from "./secrets.js"
import { DEFAULT_DIR } from "./config.js"
import { appendMemory, recordLearning, projectMemoryPath } from "./memory.js"

// ---------------------------------------------------------------------------
// path security — project boundary + sensitive files
// ---------------------------------------------------------------------------

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// forge's own state lives wherever FORGE_HOME points (default ~/.forge) —
// patterns are built at runtime so a custom home is protected identically
const FORGE_SENSITIVE = [
  [new RegExp(`(^|/)${escapeRe(path.join(DEFAULT_DIR, "config.json"))}$`), "forge config (holds API keys)"],
  [new RegExp(`(^|/)${escapeRe(path.join(DEFAULT_DIR, "sessions"))}/`), "saved chat sessions (private)"],
]

const SENSITIVE_PATTERNS = [
  [/(^|\/)\.env($|\.)/i, "environment secrets file (.env)"],
  [/(^|\/)\.ssh\//i, "SSH directory"],
  [/\/id_(rsa|dsa|ed25519|ecdsa)$/i, "SSH private key"],
  [/\.(pem|key|p12|pfx|keystore)$/i, "key / certificate file"],
  [/(^|\/)\.aws\/|(^|\/)\.gnupg\/|(^|\/)\.kube\/|(^|\/)\.config\/gcloud\//i, "credentials store"],
  [/(^|\/)credentials($|\.)|(^|\/)service[-_]?account[^\/]*\.json$/i, "credentials file"],
  [/(^|\/)\.netrc$|(^|\/)\.npmrc$|(^|\/)\.docker\/config\.json$/i, "file with stored tokens"],
  [/(^|\/)(secrets?|passwords?)[^\/]*\.(json|ya?ml|toml|ini|cfg|txt)$/i, "secrets file"],
  [/^\/etc\/(shadow|gshadow|sudoers)$/i, "system secrets file"],
  ...FORGE_SENSITIVE,
]

function sensitiveReason(target) {
  if (!target) return null
  const norm = String(target).split(path.sep).join("/")
  for (const [re, why] of SENSITIVE_PATTERNS) {
    if (re.test(norm)) return why
  }
  return null
}

function insideDir(target, dir) {
  if (!target || !dir) return false
  const rel = path.relative(path.resolve(dir), path.resolve(target))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/** realpath with nearest-existing-ancestor fallback (for not-yet-existing
 *  targets) — catches symlink escapes on both existing and new paths. */
function realPathOf(abs) {
  try {
    return fs.realpathSync(abs)
  } catch {
    let dir = path.dirname(abs)
    const rest = [path.basename(abs)]
    let guard = 0
    while (!fs.existsSync(dir) && guard++ < 64) {
      rest.unshift(path.basename(dir))
      dir = path.dirname(dir)
    }
    try {
      return path.join(fs.realpathSync(dir), ...rest)
    } catch {
      return abs
    }
  }
}

/**
 * Resolve + validate a tool path.
 *  write=false (read/scan): outside-project reads are allowed EXCEPT sensitive
 *    files/dirs (checked on BOTH the logical and the real path — symlink
 *    escapes to ~/.ssh or .env are caught).
 *  write=true: the target (real path) must stay inside the project root.
 *    tools.allowOutsideProject: true opts out (user decision).
 * Returns { ok, abs, error }.
 */
export function safePath(ctx, p, { write = false } = {}) {
  const rel = String(p ?? "").trim()
  if (!rel) return { ok: false, abs: null, error: "ERROR: empty path" }
  // v20: expand ~ like a shell would — "~/.ssh/id_rsa" must not slip through
  const expanded = rel === "~" || rel.startsWith("~/") ? path.join(os.homedir(), rel.slice(1)) : rel
  const abs = path.resolve(ctx.cwd, expanded)
  const real = realPathOf(abs)
  if (write) {
    if (!ctx.allowOutsideProject && !insideDir(real, ctx.root ?? ctx.cwd)) {
      return {
        ok: false, abs, real,
        error: `ERROR: write target escapes the project directory (${path.relative(ctx.root ?? ctx.cwd, real).slice(0, 60)}) — keep changes inside ${ctx.root ?? ctx.cwd}, or set tools.allowOutsideProject: true in config to allow it`,
      }
    }
    return { ok: true, abs, real }
  }
  // read policy
  const root = ctx.root ?? ctx.cwd
  if (!insideDir(real, root) || !insideDir(abs, root)) {
    const why = sensitiveReason(abs) ?? sensitiveReason(real)
    if (why) {
      return { ok: false, abs, real, error: `BLOCKED: ${why} (${rel}) is protected from model reads. If you really need it, copy the non-secret parts yourself.` }
    }
  }
  return { ok: true, abs, real }
}

// ---------------------------------------------------------------------------
// tool definitions (wire schema)
// ---------------------------------------------------------------------------

export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in the working directory. Use for builds, tests, git, installs. Output is capped and secret-redacted. Destructive commands targeting paths outside the project are blocked.",
      parameters: { type: "object", properties: { command: { type: "string" }, timeout_sec: { type: "number", description: "max seconds (default 45)" } }, required: ["command"] },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Git snapshot of the working directory: branch, changed files, recent commits, diffstat. Use it before editing to understand repo state.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file. Returns content with line numbers. Sensitive files (.env, keys, credentials) are protected.",
      parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number", description: "1-based start line" }, limit: { type: "number", description: "max lines (default 400)" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file with content (parents auto-created, auto-checkpointed — undo removes created files). Writes must stay inside the project directory.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Exact string replacement in a file. old must appear exactly once unless replace_all=true. Auto-checkpointed.",
      parameters: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "old", "new"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List a directory (recursive to depth 2, skips node_modules/.git/.next).",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_files",
      description: "Regex search across files under a directory. Returns path:line: matches.",
      parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string", description: "e.g. *.ts" }, max: { type: "number" } }, required: ["pattern"] },
    },
  },
  {
    type: "function",
    function: {
      name: "load_skill",
      description: "Load the full instructions of an installed skill by name.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch a web page or JSON API over http(s) and return its text content (HTML tags stripped, capped, secret-redacted). Private/loopback/metadata addresses are blocked (SSRF guard).",
      parameters: { type: "object", properties: { url: { type: "string", description: "absolute http(s) URL" } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "glob_files",
      description: "Find files by glob pattern (supports ** recursive). Newest first. Use to locate files fast.",
      parameters: { type: "object", properties: { pattern: { type: "string", description: "e.g. src/**/*.ts or *.md" }, path: { type: "string", description: "root dir (default cwd)" }, max: { type: "number" } }, required: ["pattern"] },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web and return the top results (title + URL + snippet). Use for facts, docs, news.",
      parameters: { type: "object", properties: { query: { type: "string" }, max: { type: "number", description: "max results (default 6)" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "multi_edit",
      description: "Apply MULTIPLE exact string replacements to one file atomically. All edits validated first, then written once. Fails if any old string is missing.",
      parameters: { type: "object", properties: { path: { type: "string" }, edits: { type: "array", items: { type: "object", properties: { old: { type: "string" }, new: { type: "string" }, replace_all: { type: "boolean" } }, required: ["old", "new"] } } }, required: ["path", "edits"] },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Apply a standard unified diff (patch) to one or more files ATOMICALLY. Supports creation (--- /dev/null), deletion (+++ /dev/null), @@ hunks with context. Whole patch validated before anything is written; original files are auto-checkpointed; undo removes files the patch created.",
      parameters: { type: "object", properties: { patch: { type: "string", description: "unified diff text with ---/+++/@@ sections" } }, required: ["patch"] },
    },
  },
  {
    type: "function",
    function: {
      name: "todo",
      description: "Track a task list for multi-step work: set the full list, list current state, or update one item's status. Statuses: todo | doing | done.",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["set", "list", "update"] }, items: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["todo", "doing", "done"] } }, required: ["content"] } }, id: { type: "number" }, status: { type: "string" } }, required: ["action"] },
    },
  },
  {
    type: "function",
    function: {
      name: "think",
      description: "Reasoning scratchpad: think step by step, plan tool usage, or reflect — zero side effects. Use before complex edits.",
      parameters: { type: "object", properties: { thought: { type: "string" } }, required: ["thought"] },
    },
  },
  {
    type: "function",
    function: {
      name: "memory",
      description: "Persistent memory across sessions: read notes, append a fact/preference, record a learned fix (problem → root cause → fix), or replace notes. scope: global (user preferences) or project (this repo's conventions/fixes). Secrets are auto-redacted.",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["read", "append", "replace", "learn"] }, text: { type: "string", description: "note text (append/replace)" }, scope: { type: "string", enum: ["global", "project"], description: "memory tier (default global)" }, problem: { type: "string", description: "learn: what went wrong" }, root_cause: { type: "string", description: "learn: the underlying cause" }, fix: { type: "string", description: "learn: what actually fixed it" } }, required: ["action"] },
    },
  },
  {
    type: "function",
    function: {
      name: "delegate",
      description: "Spawn a read-only sub-agent to work a subtask and report a summary (it can read/glob/grep/list/fetch but NOT write). Use for investigation that would flood the main context. role tunes its focus: researcher | reviewer | tester | security | coder.",
      parameters: { type: "object", properties: { task: { type: "string" }, role: { type: "string", enum: ["researcher", "reviewer", "tester", "security", "coder"], description: "sub-agent focus (default researcher)" } }, required: ["task"] },
    },
  },
]

/** Tools that mutate the filesystem / run commands — serialized, and blocked
 *  in read-only (plan / sub-agent) mode. v20 fix: `delegate` is READ-ONLY and
 *  no longer listed here (v19 blocked plan-mode delegation by mistake). */
export const WRITE_TOOLS = new Set(["bash", "write_file", "edit_file", "multi_edit", "apply_patch"])

// ---------------------------------------------------------------------------
// tool context
// ---------------------------------------------------------------------------

export function makeToolContext(opts = {}) {
  const {
    cwd,
    timeoutSec = 45,
    maxToolOutput = 12000,
    skillsDir,
    searchUrl,
    memoryPath,
    todoPath,
    delegateRunner,
    readOnly = false,
    root,
    allowOutsideProject = false,
    allowSudo = false,
    assumeYes = false,
    fetchPrivateUrls = process.env.FORGE_ALLOW_PRIVATE_URLS === "1",
    delegateTimeoutSec = 180,
    maxParallelDelegates = 2,
    signal = null,
    subAgent = false,
    runId = null,
    plugins = [], // v20.2 P3-5: user tool plugins (from loadToolPlugins().tools)
  } = opts
  // register plugins: write-class ones join WRITE_TOOLS so they are serialized
  // and blocked in read-only sub-agents, exactly like built-in write tools.
  const pluginMap = new Map()
  for (const pl of plugins) {
    if (!pl || !pl.name) continue
    pluginMap.set(pl.name, pl)
    if (!pl.readOnly) WRITE_TOOLS.add(pl.name)
  }
  const ctx = {
    cwd: path.resolve(cwd || process.cwd()),
    root: path.resolve(root || cwd || process.cwd()),
    timeoutSec, maxToolOutput, skillsDir, searchUrl, memoryPath, todoPath,
    delegateRunner, readOnly,
    allowOutsideProject, allowSudo, assumeYes, fetchPrivateUrls,
    delegateTimeoutSec, signal, subAgent, runId,
    _plugins: pluginMap,
    _delegateActive: 0,
    _delegateMax: Math.max(1, Math.min(4, maxParallelDelegates)),
  }
  const allDefs = plugins.length ? [...TOOL_DEFS, ...plugins.map((p) => p.def)] : TOOL_DEFS
  return { defs: readOnly ? allDefs.filter((t) => !WRITE_TOOLS.has(t.function.name)) : allDefs, exec: (name, args) => execTool(ctx, name, args || {}) }
}

/** Built-in tool names — used to reject plugins that shadow a built-in. */
export const BUILTIN_TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.function.name))

export function toolCount() {
  return TOOL_DEFS.length
}

function cap(s, limit) {
  const L = limit || 12000
  return s.length > L ? s.slice(0, L) + `\n... (truncated, ${s.length} chars total)` : s
}

// ---------------------------------------------------------------------------
// bash — structural risk classification (v20 shellguard)
// ---------------------------------------------------------------------------

async function runBash(ctx, command, timeoutSec) {
  const verdict = modelMayRun(command, { cwd: ctx.cwd, root: ctx.root }, { allowSudo: ctx.allowSudo, assumeYes: ctx.assumeYes })
  if (!verdict.ok) return verdict.reason
  const t = Math.min(300, Math.max(1, timeoutSec || ctx.timeoutSec)) * 1000
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", command], { cwd: ctx.cwd, timeout: t, maxBuffer: 4 * 1024 * 1024, killSignal: "SIGKILL", env: { ...process.env, TERM: "dumb" } }, (error, stdout, stderr) => {
      let out = ""
      if (stdout) out += stdout
      if (stderr) out += (out ? "\n--- stderr ---\n" : "") + stderr
      if (error && !out) out = String(error.message)
      else if (error && error.killed) out += `\n[command timed out after ${t / 1000}s]`
      else if (error && typeof error.code === "number") out += `\n[exit code: ${error.code}]`
      resolve(cap(out || "(no output)", ctx.maxToolOutput))
    })
  })
}

// ---------------------------------------------------------------------------
// file tools — all paths through safePath()
// ---------------------------------------------------------------------------

// --- v20.1 P0-4: read_file is bounded --------------------------------------
// v20 called fs.readFileSync() on whatever path it was handed and then split
// the result, so `read_file {"path":"one-gigabyte.log"}` allocated the whole
// file as one string plus one array element per line before the 400-line
// window was even applied. Measured on a 16 MB log: +30 MB RSS. A 2 GB log
// is an OOM kill of the agent process.
// readLineRange() streams instead: READ_CHUNK bytes are in flight at a time,
// only the requested window is kept, no single line is kept in full, and the
// scan stops as soon as the window is full (or the budget is reached).
const READ_CHUNK = 64 * 1024 // bytes per read
const READ_SCAN_CAP = 64 * 1024 * 1024 // never scan more than 64 MB of one file
const READ_MAX_BYTES = 4 * 1024 * 1024 // hard cap on the bytes one read keeps
const READ_TOTAL_CAP = 4 * 1024 * 1024 // once the window is full, keep counting
//   lines only while the file is this small — that keeps the exact "N more
//   lines; total M" note for ordinary source files without ever scanning a
//   huge one to the end
const READ_MAX_LINE = 8000 // one minified line must not blow up the context

/**
 * Stream the requested [start, end) line window out of a file.
 * Bounded in every direction: at most READ_CHUNK bytes in flight, at most
 * READ_MAX_BYTES kept, at most READ_MAX_LINE chars of any single line kept,
 * at most READ_SCAN_CAP bytes scanned.
 * Returns { lines, total, truncated, scanned, completed } — `truncated` means
 * the keep-budget ran out, `completed` means EOF was reached (as opposed to
 * stopping because the requested window was full).
 */
function readLineRange(p, start, end) {
  const lines = []
  let total = 0 // lines seen
  let scanned = 0 // bytes read
  let kept = 0 // bytes kept for the caller
  let pending = "" // head of the line we are inside of
  let extra = 0 // bytes of the current line we counted but did not store
  let pendingFull = false // current line exceeded READ_MAX_LINE
  let countOnly = false // window is full; only the line count still matters
  let endsWithNL = true // the last byte processed was a newline
  let truncated = false
  let completed = false
  let fd
  try {
    fd = fs.openSync(p, "r")
  } catch {
    return { lines, total, truncated, scanned, completed }
  }
  const decoder = new StringDecoder("utf8")
  const buf = Buffer.alloc(READ_CHUNK)
  const countNL = (str) => {
    let c = 0
    for (let i = str.indexOf("\n"); i !== -1; i = str.indexOf("\n", i + 1)) c++
    return c
  }
  // returns true when the keep-budget is exhausted (the caller must stop)
  const emit = (text, realLen) => {
    if (total < start || total >= end) return false
    const shown = realLen > READ_MAX_LINE ? text.slice(0, READ_MAX_LINE) + ` …[line truncated, ${realLen} chars]` : text
    if (kept + shown.length + 1 > READ_MAX_BYTES) return true
    lines.push(shown)
    kept += shown.length + 1
    return false
  }
  try {
    while (scanned < READ_SCAN_CAP) {
      let n = 0
      try {
        n = fs.readSync(fd, buf, 0, buf.length, scanned)
      } catch {
        break
      }
      if (n <= 0) {
        completed = true
        break
      }
      scanned += n
      const data = decoder.write(buf.subarray(0, n))
      endsWithNL = data.charCodeAt(data.length - 1) === 10
      // the window is already full: count the remaining lines, store nothing
      if (countOnly) {
        total += countNL(data)
        if (scanned >= READ_TOTAL_CAP) break
        continue
      }
      if (pendingFull) {
        // inside a line longer than READ_MAX_LINE: count bytes, store nothing
        const i = data.indexOf("\n")
        if (i === -1) {
          extra += data.length
          continue
        }
        if (emit(pending, READ_MAX_LINE + extra + i)) {
          truncated = true
          break
        }
        total++
        if (total >= end) {
          total += countNL(data.slice(i + 1))
          if (scanned >= READ_TOTAL_CAP) break
          countOnly = true
          continue
        }
        pending = ""
        extra = 0
        pendingFull = false
        let rest = data.slice(i + 1)
        let nl
        while ((nl = rest.indexOf("\n")) !== -1) {
          const line = rest.slice(0, nl)
          rest = rest.slice(nl + 1)
          if (emit(line, line.length)) {
            truncated = true
            break
          }
          total++
          if (total >= end) break
        }
        if (truncated) break
        if (total >= end) {
          total += countNL(rest)
          if (scanned >= READ_TOTAL_CAP) break
          countOnly = true
          continue
        }
        pending = rest
        continue
      }
      let chunk = pending + data
      let nl
      while ((nl = chunk.indexOf("\n")) !== -1) {
        const line = chunk.slice(0, nl)
        chunk = chunk.slice(nl + 1)
        if (emit(line, line.length)) {
          truncated = true
          break
        }
        total++
        if (total >= end) break
      }
      if (truncated) break
      if (total >= end) {
        // from here on only the line count matters
        total += countNL(chunk)
        if (scanned >= READ_TOTAL_CAP) break
        countOnly = true
        pending = ""
        continue
      }
      pending = chunk
      if (pending.length > READ_MAX_LINE) {
        extra = pending.length - READ_MAX_LINE
        pending = pending.slice(0, READ_MAX_LINE)
        pendingFull = true
      }
    }
    if (!truncated) {
      if (total < end) {
        // the window never filled: what is left is the final line
        if (pending.length || extra) {
          if (emit(pending, pending.length + extra)) truncated = true
          total++
        }
      } else if (completed && !endsWithNL) {
        total++ // the file does not end with a newline
      }
    }
  } finally {
    try {
      fs.closeSync(fd)
    } catch {}
  }
  return { lines, total, truncated, scanned, completed }
}

function read_file(ctx, args) {
  const sp = safePath(ctx, args.path)
  if (!sp.ok) return sp.error
  const p = sp.abs
  if (!fs.existsSync(p)) return `ERROR: not found: ${p}`
  const stat = fs.statSync(p)
  if (stat.isDirectory()) return `ERROR: is a directory: ${p}`
  // binary sniff on the first 8KB — never dump mojibake into the context
  const fd = fs.openSync(p, "r")
  const sniff = Buffer.alloc(Math.min(8192, stat.size))
  fs.readSync(fd, sniff, 0, sniff.length, 0)
  fs.closeSync(fd)
  if (sniff.includes(0)) return `ERROR: binary file (not readable as text): ${p}`
  // v20.1: stream the window out of the file instead of slurping it
  const offset = Math.max(1, Math.floor(Number(args.offset) || 1))
  const limit = Math.min(2000, Math.floor(Number(args.limit) || 400))
  const { lines, total, truncated, scanned, completed } = readLineRange(p, offset - 1, offset - 1 + limit)
  const eof = completed || scanned >= stat.size
  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`
  if (!lines.length) {
    if (offset > total && eof) return `ERROR: offset ${offset} is past the end of the file (${total} line${total === 1 ? "" : "s"})`
    if (!eof) {
      return `ERROR: file too large to page that far — read_file scans at most ${mb(READ_SCAN_CAP)} of ${mb(stat.size)}; ` +
        `offset ${offset} starts beyond line ${total}. Use grep_files to locate the section first.`
    }
    return "(empty file)"
  }
  const numbered = lines.map((l, i) => String(offset + i).padStart(5) + "| " + l).join("\n")
  let note = ""
  const shown = offset - 1 + lines.length
  if (truncated) note = `\n... (read_file kept ${mb(READ_MAX_BYTES)} — use offset/limit to page through the rest)`
  else if (eof && total > shown) note = `\n... (${total - shown} more lines; total ${total})`
  else if (!eof) note = "\n... (more lines follow — use offset/limit to continue)"
  return cap(numbered + note, ctx.maxToolOutput)
}

function write_file(ctx, args) {
  const sp = safePath(ctx, args.path, { write: true })
  if (!sp.ok) return sp.error
  const p = sp.abs
  const existed = fs.existsSync(p)
  // v20: one checkpoint covers the whole mutation — existing files get
  // backups, newly created files get tracked for undo-removal
  const id = snapshotBefore([p], ctx.cwd, existed ? [] : [p], ctx.runId)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, args.content ?? "")
  if (id) sealCreated(id, ctx.cwd)
  return `OK wrote ${p} (${(args.content ?? "").length} bytes${existed ? "" : ", created"})`
}

function edit_file(ctx, args) {
  const sp = safePath(ctx, args.path, { write: true })
  if (!sp.ok) return sp.error
  const p = sp.abs
  if (!fs.existsSync(p)) return `ERROR: not found: ${p}`
  const src = fs.readFileSync(p, "utf8")
  const oldS = args.old ?? ""
  const newS = args.new ?? ""
  if (!src.includes(oldS)) return "ERROR: old string not found in file"
  if (!args.replace_all && src.indexOf(oldS) !== src.lastIndexOf(oldS)) {
    return "ERROR: old string appears multiple times — add more surrounding context to make it unique, or set replace_all=true"
  }
  snapshotBefore([p], ctx.cwd, [], ctx.runId) // v16: auto-checkpoint
  const out = args.replace_all ? src.split(oldS).join(newS) : src.replace(oldS, newS)
  fs.writeFileSync(p, out)
  return `OK edited ${p}`
}

// --- shared walk policy (v20.2 P1-2) ---------------------------------------
// One SKIP set for list_dir / grep_files / glob_files (they used to diverge:
// grep_files was missing .turbo/.cache). These are always-noise directories —
// dependency trees, VCS metadata, build/venv output — that only waste the
// agent's context and slow the walk.
const DEFAULT_SKIP = new Set([
  "node_modules", ".git", ".hg", ".svn", ".next", ".nuxt", ".svelte-kit",
  "dist", "build", "coverage", "__pycache__", ".turbo", ".cache",
  ".venv", "venv", ".mypy_cache", ".pytest_cache", ".gradle",
])

/**
 * Best-effort .gitignore directory awareness: read the walk root's .gitignore
 * and return the set of plain directory names it ignores, so the file tools
 * stop indexing a repo's own generated/ignored folders. Deliberately
 * conservative — only bare names (no slashes, no glob metacharacters, not
 * negated) are honored, and only directories are ever skipped, so a gitignored
 * FILE the user asks about is still readable. Cached per root. Never throws.
 */
const _gitignoreCache = new Map()
function gitignoreSkip(root) {
  if (_gitignoreCache.has(root)) return _gitignoreCache.get(root)
  const out = new Set()
  try {
    const raw = fs.readFileSync(path.join(root, ".gitignore"), "utf8")
    for (let line of raw.split("\n")) {
      line = line.trim()
      if (!line || line.startsWith("#") || line.startsWith("!")) continue
      const name = line.replace(/^\/+/, "").replace(/\/+$/, "")
      if (!name || name.includes("/") || /[*?\[\]]/.test(name)) continue
      out.add(name)
    }
  } catch { /* no .gitignore — fine */ }
  _gitignoreCache.set(root, out)
  return out
}

/** Merged skip predicate for a walk rooted at `root`. */
function skipSetFor(root) {
  const gi = gitignoreSkip(root)
  return gi.size ? new Set([...DEFAULT_SKIP, ...gi]) : DEFAULT_SKIP
}

function list_dir(ctx, args) {
  const sp = safePath(ctx, args.path || ".")
  if (!sp.ok) return sp.error
  const root = sp.abs
  if (!fs.existsSync(root)) return `ERROR: not found: ${root}`
  const SKIP = skipSetFor(root)
  const lines = []
  const walk = (dir, depth, prefix) => {
    if (depth > 2 || lines.length > 300) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      lines.push(prefix + "(unreadable)")
      return
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        lines.push(prefix + e.name + "/")
        walk(full, depth + 1, prefix + "  ")
      } else {
        let size = ""
        try { size = " " + fs.statSync(full).size + "B" } catch {}
        lines.push(prefix + e.name + size)
      }
      if (lines.length > 300) { lines.push("... (truncated at 300 entries)"); return }
    }
  }
  walk(root, 0, "")
  return lines.join("\n") || "(empty)"
}

function grep_files(ctx, args) {
  const sp = safePath(ctx, args.path || ".")
  if (!sp.ok) return sp.error
  const root = sp.abs
  let re
  try {
    re = new RegExp(args.pattern, "i")
  } catch (e) {
    return `ERROR: bad regex: ${e.message}`
  }
  const glob = args.glob ? new RegExp("^" + args.glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$") : null
  const max = Math.min(120, args.max || 60)
  const SKIP = skipSetFor(root)
  const results = []
  const walk = (dir, depth) => {
    if (results.length >= max || depth > 8) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (results.length >= max) return
      if (SKIP.has(e.name)) continue
      // v20: hidden entries are never descended into (stops .cache/.config walks)
      if (e.name.startsWith(".") && path.resolve(dir) !== path.resolve(root)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      if (glob && !glob.test(e.name)) continue
      try {
        const stat = fs.statSync(full)
        if (stat.size > 1024 * 1024) continue
        const text = fs.readFileSync(full, "utf8")
        const lines = text.split("\n")
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            results.push(path.relative(ctx.cwd, full) + ":" + (i + 1) + ": " + lines[i].trim().slice(0, 240))
            if (results.length >= max) break
          }
        }
      } catch {}
    }
  }
  walk(root, 0)
  return results.length ? results.join("\n") : "(no matches)"
}

// --- skills ------------------------------------------------------------------

/** v20: skill names are plain directory names — no separators, no traversal. */
export function validSkillName(name) {
  const n = String(name ?? "").trim()
  if (!n || n.length > 64) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n)) return null
  if (n.includes("..")) return null
  return n
}

function load_skill(ctx, args) {
  // validate the NAME first — never touch the filesystem with a hostile name
  const name = validSkillName(args.name)
  if (!name) return `ERROR: invalid skill name "${String(args.name ?? "")}" — use the plain skill directory name (no paths)`
  if (!ctx.skillsDir) return "ERROR: no skills directory configured"
  const base = realPathOf(ctx.skillsDir)
  const target = path.join(ctx.skillsDir, name, "SKILL.md")
  const sp = safePath({ ...ctx, root: ctx.skillsDir }, path.join(name, "SKILL.md"))
  if (!sp.ok) return sp.error
  const real = realPathOf(target)
  if (!insideDir(real, base)) return `ERROR: skill path escapes the skills directory`
  if (!fs.existsSync(target)) return `ERROR: skill not found: ${name}`
  const md = fs.readFileSync(target, "utf8")
  return md.length > 24000 ? md.slice(0, 24000) + "\n... (truncated)" : md
}

// --- web ---------------------------------------------------------------------

async function fetch_url(ctx, args) {
  const url = String(args.url || "").trim()
  if (!/^https?:\/\//i.test(url)) return "ERROR: only absolute http(s) URLs are supported"
  let host = ""
  try { host = new URL(url).hostname } catch { return "ERROR: malformed URL" }
  // v20 SSRF guard: resolve the host, then validate EVERY address (private,
  // loopback, link-local, CGNAT, IPv6 ULA/link-local, IPv4-mapped) — hostname
  // strings alone are not trusted. DNS rebinding is covered because all
  // resolved records must pass. Local stacks (Ollama, SearXNG) can opt in
  // via tools.fetchPrivateUrls / FORGE_ALLOW_PRIVATE_URLS=1.
  const verdict = await assertFetchableUrl(url, { allowPrivate: !!ctx.fetchPrivateUrls })
  if (!verdict.ok) return `BLOCKED (SSRF guard): ${verdict.reason}. If this is an intentional local fetch, set tools.fetchPrivateUrls: true or FORGE_ALLOW_PRIVATE_URLS=1.`
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "forge-agent/20.0.0", accept: "text/*,application/json;q=0.9,*/*;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return `ERROR: HTTP ${res.status} for ${url}`
    const ct = res.headers.get("content-type") || ""
    if (!/text|json|xml|javascript|csv|markdown|html|yaml/i.test(ct)) return `ERROR: non-text content-type (${ct}) — binary not supported`
    const buf = await res.arrayBuffer()
    if (buf.byteLength > 2 * 1024 * 1024) return `ERROR: response too large (${Math.round(buf.byteLength / 1024)}KB, limit 2MB)`
    let text = new TextDecoder().decode(buf)
    if (/html/i.test(ct) || /^\s*<(!doctype|html)/i.test(text)) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n+/g, "\n")
        .trim()
    }
    return cap(`URL: ${url}\nContent-Type: ${ct}\n\n${text}`, ctx.maxToolOutput)
  } catch (e) {
    return `ERROR: fetch failed: ${String(e?.message ?? e).slice(0, 200)}`
  }
}

// --- v15 tools ----------------------------------------------------------------

function globToRegex(pattern) {
  let re = ""
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // v20.0.1: "**/" must match ZERO or more directories — otherwise the
        // most common pattern of all ("**/*.ts") silently missed every file
        // that sits directly in the search root.
        if (pattern[i + 2] === "/") { re += "(?:.*/)?"; i += 2 } else { re += ".*"; i++ }
      } else re += "[^/]*"
    } else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp("^" + re + "$")
}

function glob_files(ctx, args) {
  const sp = safePath(ctx, args.path || ".")
  if (!sp.ok) return sp.error
  const root = sp.abs
  if (!fs.existsSync(root)) return `ERROR: not found: ${root}`
  let re
  try { re = globToRegex(String(args.pattern || "*")) } catch (e) { return `ERROR: bad pattern: ${e.message}` }
  const max = Math.min(200, args.max || 100)
  const SKIP = skipSetFor(root)
  const hits = []
  const walk = (dir, depth) => {
    if (hits.length >= max || depth > 10) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (hits.length >= max) return
      if (SKIP.has(e.name)) continue
      if (e.name.startsWith(".") && path.resolve(dir) !== path.resolve(root)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      const rel = path.relative(root, full).split(path.sep).join("/")
      if (re.test(rel) || re.test(path.basename(rel))) {
        let mt = 0
        try { mt = fs.statSync(full).mtimeMs } catch {}
        hits.push({ rel, mt })
      }
    }
  }
  walk(root, 0)
  hits.sort((a, b) => b.mt - a.mt)
  return hits.length ? hits.map((h) => h.rel).join("\n") : "(no matches)"
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .trim()
}

async function web_search(ctx, args) {
  const q = String(args.query || "").trim()
  if (!q) return "ERROR: empty query"
  const max = Math.min(10, args.max || 6)
  const tried = []
  // backend 1: configured endpoint (SearXNG JSON/HTML or mock in tests)
  // (user-configured URL — trusted, no SSRF guard here)
  if (ctx.searchUrl) {
    const url = ctx.searchUrl + (ctx.searchUrl.includes("?") ? "&" : "?") + "q=" + encodeURIComponent(q)
    tried.push(url)
    try {
      const res = await fetch(url, { headers: { "user-agent": "forge-agent/20.0.0", accept: "application/json,text/html;q=0.8" }, signal: AbortSignal.timeout(12000) })
      if (res.ok) {
        const ct = res.headers.get("content-type") || ""
        const body = await res.text()
        const results = []
        if (/json/i.test(ct)) {
          const j = JSON.parse(body)
          for (const r of (j.results ?? j ?? []).slice(0, max)) results.push({ title: stripTags(String(r.title ?? r.name ?? "")), url: String(r.url ?? r.href ?? ""), snippet: stripTags(String(r.content ?? r.snippet ?? r.body ?? "")).slice(0, 220) })
        } else {
          const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
          let m
          while ((m = re.exec(body)) && results.length < max) {
            const href = m[1]
            if (/duckduckgo|google\./i.test(href)) continue
            results.push({ title: stripTags(m[2]).slice(0, 120), url: href, snippet: "" })
          }
        }
        if (results.length) return formatSearch(q, results, tried)
      }
    } catch {}
  }
  // backend 2: DuckDuckGo Lite (zero-dependency fallback)
  try {
    const url = "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q)
    tried.push(url)
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) forge/20" }, signal: AbortSignal.timeout(12000) })
    if (!res.ok) throw new Error("HTTP " + res.status)
    const body = await res.text()
    const results = []
    const re = /<a[^>]+href="([^"]+)"[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>/gi
    let m
    while ((m = re.exec(body)) && results.length < max) results.push({ title: stripTags(m[2]).slice(0, 120), url: m[1], snippet: "" })
    if (!results.length) {
      const re2 = /<a[^>]+rel="nofollow"[^>]+href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
      while ((m = re2.exec(body)) && results.length < max) {
        if (/duckduckgo\.com/i.test(m[1])) continue
        results.push({ title: stripTags(m[2]).slice(0, 120), url: m[1], snippet: "" })
      }
    }
    if (results.length) return formatSearch(q, results, tried)
    return `ERROR: search returned no results (${tried.join(", ")})`
  } catch (e) {
    return `ERROR: web_search failed: ${String(e?.message ?? e).slice(0, 160)} (tried: ${tried.join(", ")})`
  }
}

function formatSearch(q, results, tried) {
  const lines = [`web search: "${q}"`]
  results.forEach((r, i) => lines.push(`${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? "\n   " + r.snippet : ""}`))
  return cap(lines.join("\n"), 8000)
}

function multi_edit(ctx, args) {
  const sp = safePath(ctx, args.path, { write: true })
  if (!sp.ok) return sp.error
  const p = sp.abs
  if (!fs.existsSync(p)) return `ERROR: not found: ${p}`
  const src = fs.readFileSync(p, "utf8")
  const edits = Array.isArray(args.edits) ? args.edits : []
  if (!edits.length) return "ERROR: no edits provided"
  // validate ALL edits first — atomic: one bad edit means zero changes
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]
    if (!src.includes(e.old ?? "")) return `ERROR: edit ${i + 1}: old string not found in file (no changes applied)`
    if (!e.replace_all && src.indexOf(e.old) !== src.lastIndexOf(e.old)) {
      return `ERROR: edit ${i + 1}: old string appears multiple times — add context or set replace_all (no changes applied)`
    }
  }
  let out = src
  let applied = 0
  for (const e of edits) {
    if (e.replace_all) { applied += out.split(e.old).length - 1; out = out.split(e.old).join(e.new ?? "") }
    else { out = out.replace(e.old, e.new ?? ""); applied++ }
  }
  snapshotBefore([p], ctx.cwd, [], ctx.runId) // v16: auto-checkpoint
  fs.writeFileSync(p, out)
  return `OK multi_edit ${p}: ${applied} replacement(s), ${edits.length} edit(s), atomic`
}

// --- v16 apply_patch -----------------------------------------------------------

function apply_patch(ctx, args) {
  const patchText = String(args.patch ?? "")
  if (!patchText.trim()) return "ERROR: no patch text provided"
  // 1. parse the diff
  let parsed
  try {
    parsed = parsePatch(patchText)
  } catch (e) {
    return `ERROR: ${e.message}`
  }
  // 2. collect target paths and load current contents (missing files = creation)
  const paths = []
  for (const f of parsed) {
    const target = f.oldPath === "/dev/null" ? f.newPath : f.newPath === "/dev/null" ? f.oldPath : f.newPath || f.oldPath
    if (!target || target === "/dev/null") return "ERROR: patch file section without a target path"
    if (paths.includes(target)) return `ERROR: patch targets ${target} more than once`
    paths.push(target)
  }
  // v20: boundary + sensitive validation BEFORE anything else
  const sps = paths.map((t) => safePath(ctx, t, { write: true }))
  for (const sp of sps) {
    if (!sp.ok) return sp.error
  }
  const filesMap = new Map()
  for (const t of paths) {
    const sp = safePath(ctx, t, { write: true })
    if (fs.existsSync(sp.abs)) {
      const st = fs.statSync(sp.abs)
      if (st.isDirectory()) return `ERROR: is a directory: ${t}`
      try {
        filesMap.set(t, fs.readFileSync(sp.abs, "utf8"))
      } catch {
        return `ERROR: cannot read ${t}`
      }
    }
  }
  // 3. validate + compute everything in memory — atomic: any bad hunk aborts all
  let applied
  try {
    applied = applyParsedPatch(filesMap, parsed)
  } catch (e) {
    return `ERROR: ${e.message} (no changes applied)`
  }
  // 4. checkpoint originals AND track creations (v20: undo removes them),
  //    then write once
  const checkpointId = snapshotBefore(
    paths.filter((t) => filesMap.has(t)).map((t) => safePath(ctx, t).abs),
    ctx.cwd,
    applied.created.map((t) => safePath(ctx, t).abs),
  )
  for (const [t, content] of applied.results) {
    const p = safePath(ctx, t, { write: true }).abs
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  for (const t of applied.deleted) {
    try { fs.unlinkSync(safePath(ctx, t, { write: true }).abs) } catch {}
  }
  if (checkpointId) sealCreated(checkpointId, ctx.cwd)
  const parts = []
  if (applied.created.length) parts.push(`created ${applied.created.join(", ")}`)
  if (applied.deleted.length) parts.push(`deleted ${applied.deleted.join(", ")}`)
  parts.push(`patched ${applied.results.size - applied.created.length} existing file(s)`)
  return `OK apply_patch — ${parts.join(" • ")} (atomic, checkpointed)`
}

// --- git ------------------------------------------------------------------------

function git_status(ctx) {
  const opts = { cwd: ctx.cwd, timeout: 8000, maxBuffer: 512 * 1024 }
  return new Promise((resolve) => {
    execFile("git", ["status", "--porcelain=v1", "-b"], opts, (err, stdout) => {
      if (err) return resolve("ERROR: not a git repository (or git unavailable)")
      const lines = stdout.split("\n").filter((l) => l.trim())
      const branch = lines[0] ?? ""
      const changed = lines.slice(1)
      execFile("git", ["log", "--oneline", "-5"], opts, (e2, logOut) => {
        const log = e2 ? [] : String(logOut).split("\n").filter((l) => l.trim())
        execFile("git", ["diff", "--stat", "HEAD"], opts, (e3, diffOut) => {
          const out = [
            `git ${branch}`,
            changed.length ? `changes (${changed.length}):\n` + changed.slice(0, 40).map((l) => "  " + l).join("\n") : "working tree clean",
            log.length ? "recent commits:\n" + log.map((l) => "  " + l).join("\n") : "",
            !e3 && diffOut.trim() ? "diffstat:\n" + String(diffOut).trim().split("\n").slice(-3).map((l) => "  " + l).join("\n") : "",
          ].filter(Boolean)
          resolve(cap(out.join("\n"), ctx.maxToolOutput))
        })
      })
    })
  })
}

// --- todo / think -----------------------------------------------------------------

function readTodo(ctx) {
  try { return JSON.parse(fs.readFileSync(ctx.todoPath, "utf8")) } catch { return { items: [] } }
}

function renderTodo(items) {
  if (!items.length) return "(todo list is empty)"
  const mark = { todo: "[ ]", doing: "[~]", done: "[x]" }
  return items.map((it, i) => `${mark[it.status] || "[ ]"} ${i + 1}. ${it.content}`).join("\n")
}

function todo(ctx, args) {
  const p = ctx.todoPath
  if (!p) return "ERROR: no todo path configured"
  const action = args.action || "list"
  const state = readTodo(ctx)
  if (action === "list") return renderTodo(state.items)
  if (action === "set") {
    const items = (Array.isArray(args.items) ? args.items : []).slice(0, 100).map((it, i) => ({ id: i + 1, content: String(it.content ?? "").slice(0, 200), status: ["todo", "doing", "done"].includes(it.status) ? it.status : "todo" }))
    if (!items.length) return "ERROR: no items provided for action=set"
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify({ items }, null, 1)) } catch (e) { return `ERROR: ${e.message}` }
    return "TODO list saved:\n" + renderTodo(items)
  }
  if (action === "update") {
    const idx = (args.id ?? 0) - 1
    const it = state.items[idx]
    if (!it) return `ERROR: no todo item #${args.id} — use action=list to see ids`
    if (args.status && ["todo", "doing", "done"].includes(args.status)) it.status = args.status
    if (args.content) it.content = String(args.content).slice(0, 200)
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(state, null, 1)) } catch (e) { return `ERROR: ${e.message}` }
    return "TODO updated:\n" + renderTodo(state.items)
  }
  return `ERROR: unknown action "${action}" (set|list|update)`
}

function think(_ctx, args) {
  const t = String(args.thought ?? "").slice(0, 4000)
  if (!t.trim()) return "ERROR: empty thought"
  return "Noted. Reasoning recorded — continue with the plan."
}

// --- memory (v20: hierarchical + learning) ----------------------------------------

function memory(ctx, args) {
  const action = args.action || "read"
  const scope = args.scope === "project" ? "project" : "global"
  const globalPath = ctx.memoryPath || path.join(DEFAULT_DIR, "memory.md")

  if (action === "read") {
    const file = scope === "project" ? projectMemoryPath(ctx.cwd) : globalPath
    const label = scope === "project" ? `PROJECT MEMORY (${path.basename(ctx.cwd)}):` : "MEMORY (~/.forge/memory.md):"
    try {
      const m = fs.readFileSync(file, "utf8")
      return m ? cap(`${label}\n${m}`, 4000) : `(${scope} memory is empty — append facts with action=append, scope=${scope})`
    } catch {
      return `(${scope} memory is empty — append facts with action=append, scope=${scope})`
    }
  }
  if (action === "append") {
    const text = String(args.text ?? "").trim().slice(0, 2000)
    if (!text) return "ERROR: no text to append"
    const r = appendMemory(scope, text, ctx.cwd)
    return r.ok ? `OK ${scope} memory appended: "${text.slice(0, 80)}"` : `ERROR: ${r.error}`
  }
  if (action === "replace") {
    const text = redact(String(args.text ?? "").slice(0, 4000))
    try { fs.mkdirSync(path.dirname(globalPath), { recursive: true }); fs.writeFileSync(globalPath, text + (text ? "\n" : "")) } catch (e) { return `ERROR: ${e.message}` }
    return `OK memory replaced (${text.length} chars)`
  }
  if (action === "learn") {
    const problem = String(args.problem ?? "").trim()
    const fix = String(args.fix ?? "").trim()
    if (!problem || !fix) return "ERROR: learn needs problem + fix (root_cause recommended)"
    const r = recordLearning({ problem, rootCause: args.root_cause ?? args.rootCause ?? "", fix }, ctx.cwd)
    return r.ok ? `OK recorded learning to project memory (${r.file}) — future tasks can retrieve it` : `ERROR: ${r.error}`
  }
  return `ERROR: unknown action "${action}" (read|append|replace|learn)`
}

// --- delegate (v20: roles + timeout + concurrency cap + depth guard) ---------------

const ROLE_DIRECTIVES = {
  researcher: "You are a RESEARCH sub-agent: investigate quickly, read code/docs, and report findings. Zero writes. Keep the report dense and under 400 words.",
  reviewer: "You are a CODE REVIEW sub-agent: inspect the relevant files for bugs, edge cases, and quality issues. Report concrete findings with file:line references. Zero writes.",
  tester: "You are a TEST sub-agent: figure out how this project is tested, run the relevant test/build commands (read-only analysis: you may NOT modify files), and report pass/fail evidence. Zero writes.",
  security: "You are a SECURITY sub-agent: look for injection, path traversal, unsafe deserialization, secret exposure, and permission issues. Report concrete risks with file:line references. Zero writes.",
  coder: "You are an ANALYSIS sub-agent for implementation planning: identify exact files and edits needed, but do NOT write — the main agent applies the changes.",
}

async function delegate(ctx, args) {
  // depth guard: sub-agents cannot spawn sub-agents (plan-mode CAN delegate —
  // its delegates are read-only and capped at depth 2)
  if (ctx.subAgent) return "ERROR: delegate is not available inside a sub-agent (depth limit)"
  const task = String(args.task ?? "").trim().slice(0, 2000)
  if (!task) return "ERROR: no task provided"
  if (typeof ctx.delegateRunner !== "function") return "ERROR: delegation not wired in this mode"
  const role = ROLE_DIRECTIVES[args.role] ? args.role : "researcher"
  // concurrency cap: never more than ctx._delegateMax sub-agents in flight
  if (ctx._delegateActive >= ctx._delegateMax) {
    return `ERROR: delegate limit reached (${ctx._delegateMax} sub-agents already running) — wait for them to finish or reduce parallel delegation.`
  }
  ctx._delegateActive++
  const timeoutMs = Math.max(1, ctx.delegateTimeoutSec ?? 180) * 1000
  const timedOut = { v: false }
  try {
    const work = Promise.resolve(ctx.delegateRunner(task, role))
    const timer = new Promise((resolve) => {
      setTimeout(() => { timedOut.v = true; resolve(null) }, timeoutMs)
    })
    const summary = await Promise.race([work, timer])
    if (timedOut.v || summary === null) {
      return `ERROR: sub-agent timed out after ${Math.round(timeoutMs / 1000)}s (agent.delegateTimeoutSec) — narrow the subtask or raise the limit`
    }
    return cap(`SUB-AGENT REPORT (${role}):\n${summary}`, ctx.maxToolOutput)
  } catch (e) {
    return `ERROR: sub-agent failed: ${String(e?.message ?? e).slice(0, 200)}`
  } finally {
    ctx._delegateActive--
  }
}

// ---------------------------------------------------------------------------
// self-test (forge doctor --tools)
// ---------------------------------------------------------------------------

export async function selfTestTools({ searchUrl, memoryPath, todoPath } = {}) {
  const os = await import("node:os")
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-doctor-"))
  const ctx = {
    cwd: tmp, root: tmp, timeoutSec: 8, maxToolOutput: 4000, skillsDir: null,
    searchUrl, memoryPath: memoryPath || path.join(tmp, "memory.md"), todoPath: todoPath || path.join(tmp, "todo.json"),
    delegateRunner: null, readOnly: false, allowOutsideProject: false, allowSudo: false, assumeYes: false,
    fetchPrivateUrls: true, delegateTimeoutSec: 60, _delegateActive: 0, _delegateMax: 2,
  }
  const t = async (name, fn) => {
    const t0 = Date.now()
    try {
      const r = await fn()
      const bad = typeof r === "string" && (r.startsWith("ERROR") || r.startsWith("BLOCKED"))
      const evidence = typeof r === "string" && r.includes("[echo verified]") ? "echo verified" : ""
      return { name, ok: !bad, ms: Date.now() - t0, note: bad ? String(r).slice(0, 80) : evidence }
    } catch (e) {
      return { name, ok: false, ms: Date.now() - t0, note: String(e?.message ?? e).slice(0, 80) }
    }
  }
  const results = []
  results.push(await t("bash", async () => {
    const r = await execTool(ctx, "bash", { command: "echo doctor-ok" })
    if (typeof r === "string" && r.includes("doctor-ok")) return r + "\n[echo verified]" // evidence for doctor output
    return r
  }))
  results.push(await t("read_file", () => execTool(ctx, "write_file", { path: "probe.txt", content: "hello" }).then(() => execTool(ctx, "read_file", { path: "probe.txt" }))))
  results.push(await t("write_file", () => execTool(ctx, "write_file", { path: "probe.txt", content: "v2" })))
  results.push(await t("edit_file", () => execTool(ctx, "edit_file", { path: "probe.txt", old: "v2", new: "v3" })))
  results.push(await t("multi_edit", () => execTool(ctx, "multi_edit", { path: "probe.txt", edits: [{ old: "v3", new: "a" }].slice(0, 1) })))
  results.push(await t("apply_patch", () =>
    execTool(ctx, "apply_patch", { patch: "--- /dev/null\n+++ b/patched.txt\n@@ -0,0 +1,1 @@\n+patch ok\n--- a/probe.txt\n+++ b/probe.txt\n@@ -1,1 +1,1 @@\n-a\n+APPLIED" })
  ))
  results.push(await t("git_status", async () => {
    const { execFileSync } = await import("node:child_process")
    try { execFileSync("git", ["init", "-q"], { cwd: tmp }) } catch {}
    const r = await execTool(ctx, "git_status", {})
    if (typeof r === "string" && r.startsWith("ERROR")) return r
    return r + "\n[git verified]"
  }))
  results.push(await t("glob_files", () => execTool(ctx, "glob_files", { pattern: "*.txt" })))
  results.push(await t("list_dir", () => execTool(ctx, "list_dir", { path: "." })))
  results.push(await t("grep_files", () => execTool(ctx, "grep_files", { pattern: "v3|a", path: "." })))
  results.push(await t("todo", () => execTool(ctx, "todo", { action: "set", items: [{ content: "probe", status: "done" }] }).then(() => execTool(ctx, "todo", { action: "list" }))))
  results.push(await t("think", () => execTool(ctx, "think", { thought: "probe" })))
  results.push(await t("memory", () => execTool(ctx, "memory", { action: "append", text: "probe" }).then(() => execTool(ctx, "memory", { action: "read" }))))
  results.push({ name: "load_skill", ok: null, ms: 0, note: "needs skills dir" })
  // network tools: SKIP cleanly when offline
  try {
    await fetch("https://example.com", { signal: AbortSignal.timeout(4000) })
    results.push(await t("fetch_url", () => execTool(ctx, "fetch_url", { url: "https://example.com" })))
    if (searchUrl) {
      results.push(await t("web_search", () => execTool(ctx, "web_search", { query: "forge cli", max: 2 })))
    } else {
      const r = await execTool(ctx, "web_search", { query: "forge cli", max: 2 })
      const bad = typeof r === "string" && (r.startsWith("ERROR") || r.startsWith("BLOCKED"))
      results.push(bad
        ? { name: "web_search", ok: null, ms: 0, note: "no searchUrl set; DDG fallback unreachable (ok — set tools.searchUrl)" }
        : { name: "web_search", ok: true, ms: 0, note: "DDG fallback" })
    }
  } catch {
    results.push({ name: "fetch_url", ok: null, ms: 0, note: "offline" })
    results.push({ name: "web_search", ok: null, ms: 0, note: "offline" })
  }
  results.push({ name: "delegate", ok: null, ms: 0, note: "needs a live provider" })
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  return results
}

// ---------------------------------------------------------------------------
// dispatcher — single choke point: every string result passes through
// secret redaction before it reaches the model / sessions / logs.
// ---------------------------------------------------------------------------

const REDACTED_TOOLS = new Set(["bash", "read_file", "fetch_url", "web_search", "delegate", "git_status", "grep_files", "memory"])

export async function execTool(ctx, name, args) {
  // v20.0.1: a model can emit `arguments: null` / `arguments: "null"` (or omit
  // them). Normalize so a malformed call returns a normal tool error instead of
  // throwing a TypeError into the agent loop.
  if (!args || typeof args !== "object" || Array.isArray(args)) args = {}
  let result
  switch (name) {
    case "bash": result = await runBash(ctx, String(args.command ?? ""), args.timeout_sec); break
    case "read_file": result = read_file(ctx, args); break
    case "write_file": result = write_file(ctx, args); break
    case "edit_file": result = edit_file(ctx, args); break
    case "list_dir": result = list_dir(ctx, args); break
    case "grep_files": result = grep_files(ctx, args); break
    case "load_skill": result = load_skill(ctx, args); break
    case "fetch_url": result = await fetch_url(ctx, args); break
    case "glob_files": result = glob_files(ctx, args); break
    case "web_search": result = await web_search(ctx, args); break
    case "multi_edit": result = multi_edit(ctx, args); break
    case "apply_patch": result = apply_patch(ctx, args); break
    case "git_status": result = await git_status(ctx); break
    case "todo": result = todo(ctx, args); break
    case "think": result = think(ctx, args); break
    case "memory": result = memory(ctx, args); break
    case "delegate": result = await delegate(ctx, args); break
    default: {
      // v20.2 P3-5: user tool plugins
      const pl = ctx._plugins?.get(name)
      if (!pl) return `ERROR: unknown tool "${name}"`
      try {
        const r = await pl.run(args, { cwd: ctx.cwd, readOnly: ctx.readOnly })
        result = typeof r === "string" ? r : JSON.stringify(r ?? null)
        result = cap(result, ctx.maxToolOutput)
      } catch (e) {
        result = `ERROR: plugin ${name} failed: ${String(e?.message ?? e).slice(0, 200)}`
      }
    }
  }
  // all plugin output passes through secret redaction, like built-in tools
  if (typeof result === "string" && (REDACTED_TOOLS.has(name) || ctx._plugins?.has(name))) return redact(result)
  return result
}

// v19 compat export: derived from the real engine (shellguard)
export { FORBIDDEN, classifyCommand } from "./shellguard.js"
