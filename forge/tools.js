/**
 * forge — agent tools (zero dependencies, Node built-ins only)
 *
 * bash, read_file, read_image, write_file, edit_file, multi_edit, apply_patch, list_dir, glob_files,
 * grep_files, fetch_url, web_search, browser, todo, think, memory, delegate, load_skill, git_status,
 * git_diff, git_log, git_blame
 * (19 tools)
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
import { execFile, spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import fs from "node:fs"
import { VERSION } from "./version.js"
import os from "node:os"
import path from "node:path"
import { snapshotBefore, sealCreated, restoreTransactional } from "./checkpoint.js"
import { parsePatch, applyParsedPatch } from "./diffpatch.js"
import { classifyCommand, modelMayRun } from "./shellguard.js"
import { wrapBash } from "./sandbox.js"
import { pinnedFetch, PinnedFetchError } from "./netguard.js"
import { redact } from "./secrets.js"
import { DEFAULT_DIR, AGENT_BUDGETS } from "./config.js"
import { appendMemory, recordLearning, replaceMemory, projectMemoryPath } from "./memory.js"
import { secureWriteFile, secureUnlink, SecureFsError, writeStateFile } from "./securefs.js"
import { generatedBoundary } from "./langengine.js"
import { readLearnedSkill } from "./evolve.js"
import { readLearnedPlaybookByName } from "./extend.js"
import { readDownloadedSkill, readDownloadedToolPlaybook } from "./skilldl.js"
import { createCommandResult, formatCommandResult } from "./cmdout.js"
import {
  loadLocalImage, formatImageToolResult, queuePendingVision,
  providerSupportsVision, MAX_IMAGE_BYTES, MAX_PENDING, isRemotePath,
} from "./vision.js"
import {
  runBrowser, createMockDriver, browserMutatesFilesystem, isPageMutating, isVerifyAction,
} from "./browser.js"

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
 *  write=false (read/scan): allowed anywhere (v88 noguard — sensitive-file
 *    read protection removed with the rest of the guards; secrets.js redaction
 *    still masks known key shapes in tool RESULTS before the model sees them).
 *  write=true: allowed anywhere (v88 noguard — the project write boundary is
 *    gone). Generated dirs (dist/.next/target/node_modules/…) are still
 *    refused unless ctx.allowGeneratedWrites is set — that is a correctness
 *    guard (edit the source, not the build output), not a permission gate.
 * Returns { ok, abs, error }.
 */
export function safePath(ctx, p, { write = false } = {}) {
  const rel = String(p ?? "").trim()
  if (!rel) return { ok: false, abs: null, error: "ERROR: empty path" }
  // v20: expand ~ like a shell would
  const expanded = rel === "~" || rel.startsWith("~/") ? path.join(os.homedir(), rel.slice(1)) : rel
  const abs = path.resolve(ctx.cwd, expanded)
  const real = realPathOf(abs)
  if (write) {
    if (!ctx.allowGeneratedWrites) {
      const gen = generatedBoundary(abs, ctx.root ?? ctx.cwd) || generatedBoundary(real, ctx.root ?? ctx.cwd)
      if (gen) {
        return {
          ok: false, abs, real,
          error: `ERROR: write target is inside generated directory ${gen} (${path.relative(ctx.root ?? ctx.cwd, abs).slice(0, 60)}) — edit the source, not ${gen}`,
        }
      }
    }
    return { ok: true, abs, real }
  }
  // v88 noguard: reads are unrestricted
  return { ok: true, abs, real }
}

// ---------------------------------------------------------------------------
// v21.1 P0 — secure project writes (TOCTOU / symlink-race resistant)
// ---------------------------------------------------------------------------
//
// safePath() is the POLICY check (boundary, sensitive files, opt-outs). It is
// not, by itself, a safe write: it computes realpath at validation time and a
// later writeFileSync() follows whatever the path resolves to at WRITE time.
// projectWrite()/projectUnlink() close that window by anchoring the parent
// directory with O_NOFOLLOW component-by-component, verifying the anchored
// directory is still inside the project, and committing through a
// descriptor-relative temp → fsync → rename (see securefs.js).
//
// In-project symlinks are still honoured the way the old code honoured them:
// a link whose target is INSIDE the project is followed once (via realpath,
// then re-verified). v88 noguard: a link that points outside is written
// through its parent anchor (atomic, no final-component following) instead
// of being refused.

function resolveWriteAnchor(ctx, abs) {
  const root = ctx.root ?? ctx.cwd
  let rootReal
  try { rootReal = fs.realpathSync(root) } catch { rootReal = path.resolve(root) }
  const logical = path.resolve(abs)

  // Trailing symlink: never follow the final component unless the dest is
  // inside the project (in-project aliases). allowOutsideProject does not
  // follow a trailing symlink that lands outside — atomicWriteInDir then
  // refuses ESYMLINK on the logical name, so /etc/hostname is never opened.
  let trailingLink = false
  try { trailingLink = fs.lstatSync(logical).isSymbolicLink() } catch {}
  if (trailingLink) {
    const dest = realPathOf(logical)
    if (insideDir(dest, rootReal)) return { root: rootReal, target: dest }
    const parent = path.dirname(logical)
    let parentReal
    try { parentReal = fs.realpathSync(parent) } catch { parentReal = parent }
    if (insideDir(parentReal, rootReal)) return { root: rootReal, target: logical }
    // v88 noguard: no project boundary — anchored at the target's real parent,
    // still no symlink-following on the final component, still atomic.
    return { root: parentReal, target: logical }
  }

  const real = realPathOf(abs)
  if (insideDir(real, rootReal)) return { root: rootReal, target: real }
  if (insideDir(logical, rootReal) && !fs.existsSync(abs)) return { root: rootReal, target: logical }
  // v88 noguard: writes outside the project are allowed — anchored at the
  // target's real parent, atomic, still no trailing-symlink following.
  return { root: path.dirname(real), target: real }
}

/** Secure, atomic write of `abs` (already policy-checked by safePath). Returns the physical path written. */
function projectWrite(ctx, abs, content) {
  const { root, target } = resolveWriteAnchor(ctx, abs)
  return secureWriteFile(root, target, content).real
}

/** Secure unlink of `abs` (already policy-checked). Returns true when removed. */
function projectUnlink(ctx, abs) {
  const { root, target } = resolveWriteAnchor(ctx, abs)
  return secureUnlink(root, target)
}

function writeErrorText(e, p) {
  if (e instanceof SecureFsError) {
    if (e.code === "EESCAPE") return `ERROR: write target escapes the project directory — ${e.message}`
    if (e.code === "ESYMLINK") return `ERROR: refusing to write through a symbolic link (${e.component ?? path.basename(p)}) — the path changed underneath the tool`
    if (e.code === "ENOTDIR") return `ERROR: a path component is not a directory (${e.component ?? p})`
    if (e.code === "EISDIR") return `ERROR: is a directory: ${p}`
    return `ERROR: ${e.message}`
  }
  if (e?.code === "EACCES" || e?.code === "EPERM") return `ERROR: permission denied writing ${p}`
  if (e?.code === "ENOSPC") return `ERROR: no space left on device writing ${p}`
  if (e?.code === "ELOOP") return `ERROR: refusing to write through a symbolic link (${p})`
  return `ERROR: write failed (${e?.code ?? "?"}): ${String(e?.message ?? e).slice(0, 160)}`
}

// ---------------------------------------------------------------------------
// tool definitions (wire schema)
// ---------------------------------------------------------------------------

export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in the working directory. Use for builds, tests, git, installs. Output is capped and secret-redacted. No command restrictions (v88 full control).",
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
      name: "git_diff",
      description: "Unified diff of changes, token-budgeted. base: 'HEAD' (default — all uncommitted changes), 'stage' (staged only), 'worktree' (unstaged only), or any commit/branch/tag (working tree vs it). Optional path filter, context lines, max_lines budget — long diffs are truncated with a diffstat so context is never blown. Use it to review exactly what changed (yours or the run's) before answering or committing.",
      parameters: { type: "object", properties: {
        base: { type: "string", description: "what to diff against: 'HEAD' (default), 'stage', 'worktree', or a commit/branch/tag" },
        path: { type: "string", description: "limit the diff to this file or directory" },
        context: { type: "number", description: "context lines around hunks (default 3, 0–10)" },
        max_lines: { type: "number", description: "diff line budget (default 400, max 2000)" },
      } },
    },
  },
  {
    type: "function",
    function: {
      name: "git_log",
      description: "Compact commit history: hash, date, author, subject. Optional path filter and per-commit diffstat (stat=true). Use it to read recent intent before editing an area.",
      parameters: { type: "object", properties: {
        path: { type: "string", description: "only commits touching this file or directory" },
        limit: { type: "number", description: "max commits (default 15, max 50)" },
        stat: { type: "boolean", description: "include a diffstat per commit (default false)" },
      } },
    },
  },
  {
    type: "function",
    function: {
      name: "git_blame",
      description: "Line provenance for a tracked file: commit, author, date per line (start/end window, max 200 lines). Use it to find when and why a line changed. Untracked files are reported as such.",
      parameters: { type: "object", properties: {
        path: { type: "string", description: "file to blame (required)" },
        start: { type: "number", description: "first line (default 1)" },
        end: { type: "number", description: "last line (default start+39)" },
      }, required: ["path"] },
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
      name: "read_image",
      description: "Read a local raster image (png/jpeg/gif/webp) and attach it for vision-capable models. Returns mime, pixel size, and byte size. Sensitive files are protected. Remote URLs and SVG are refused. When the provider cannot accept image parts, only metadata is returned — pixels are never faked.",
      parameters: { type: "object", properties: { path: { type: "string", description: "local file path (not a URL)" } }, required: ["path"] },
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
      name: "browser",
      description: "Drive a real browser to open, snapshot, click, fill, and screenshot pages. Opt-in binary (chromium or agent-browser). Missing binary returns UNAVAILABLE — the turn continues. http(s) URLs are SSRF-guarded; file:// stays inside the project; javascript:/data: refused. Screenshot pixels attach as vision parts when the provider can see.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["open", "snapshot", "click", "fill", "type", "press", "screenshot", "scroll", "back", "reload", "close", "status"], description: "open | snapshot | click | fill | type | press | screenshot | scroll | back | reload | close | status" },
          url: { type: "string", description: "absolute http(s) URL, file:// inside the project, or about:blank (open)" },
          ref: { type: "string", description: "interactive ref from snapshot, e.g. @e1" },
          selector: { type: "string", description: "CSS selector when no ref" },
          text: { type: "string", description: "fill/type text" },
          key: { type: "string", description: "key to press (Enter, Tab, Escape, …)" },
          path: { type: "string", description: "optional project path to save a screenshot" },
          amount: { type: "number", description: "scroll pixels (default 500)" },
        },
        required: ["action"],
      },
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
export const FORGE_STATE_MUTATING_TOOLS = new Set(["memory", "todo"])

export const MUTATION_CLASS = {
  FILESYSTEM: "filesystem_mutation",
  FORGE_STATE: "forge_state_mutation",
  NONE: "none",
}

const READONLY_ALLOWED_BASH_PATTERNS = [
  /\b(test|jest|vitest|mocha|pytest|cargo|go)\s+(test|run)\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|check|build)\b/i,
  /\btsc\b/i,
  /\bnode\s+--check\b/i,
  /\b(cargo|go)\s+(build|vet|check)\b/i,
  /\b(make|gradle|mvn)\b.*\b(test|check|verify)\b/i,
  /\b(git\s+status|git\s+log|git\s+diff|ls|cat|pwd|echo|which|env|date)\b/i,
]

/**
 * P0 — "read-only" means NO artifact mutation, and a shell redirection IS an
 * artifact mutation.
 *
 * Before this, `echo hi > stolen.txt` and `cat a.js > b.js` were allowed in
 * read-only mode: the allow-list matched on the command PREFIX (`echo`, `cat`)
 * and never looked at what the command wrote to. A verifier could therefore
 * overwrite the very file it was supposed to be verifying.
 *
 * Quoted text is stripped first so `node -e "console.log(2>1)"` and
 * `grep "a > b"` are not misread as writes; `2>&1` (an fd duplication, not a
 * file write) and `> /dev/null` are explicitly not writes.
 */
export function hasWriteRedirection(command) {
  let s = String(command ?? "")
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''")
  s = s.replace(/\d*>&\d*/g, " ")
  const re = />>?\s*([^\s;&|]+)/g
  let m
  while ((m = re.exec(s))) {
    const target = m[1] ?? ""
    if (target.startsWith("&")) continue
    if (target === "/dev/null") continue
    return true
  }
  // `… | tee out.txt` writes a file even though the prefix looks harmless
  if (/(^|[\s|;&(])tee\s+/i.test(s)) return true
  return false
}

function isReadOnlyAllowedBash(command) {
  const cmd = String(command ?? "")
  // redirections are never allowed, whatever the command prefix says
  if (hasWriteRedirection(cmd)) return false
  if (/^\s*(ls|cat|head|tail|wc|pwd|echo|which|env|date|git\s+(status|log|diff|show|branch)|node\s+-v|npm\s+(ls|view|outdated))\b/i.test(cmd)) return true
  for (const re of READONLY_ALLOWED_BASH_PATTERNS) if (re.test(cmd)) return true
  return false
}

// ---------------------------------------------------------------------------
// P0 — VERIFY ⇒ READ_ONLY, REPAIR ⇒ WRITE
// ---------------------------------------------------------------------------
//
// Verification must not be able to change the artifact it verifies. `readOnly`
// alone already blocks the write tools and persistent-state tools; the
// verifier additionally gets a WHITELIST of tools it may even see, so it
// cannot stumble into a mutating plugin either.

export const VERIFICATION_TOOLS = {
  allowed: [
    "read_file", "read_image", "list_dir", "glob_files", "grep_files", "git_status",
    "git_diff", "git_log", "git_blame",   // read-only git views — verify what changed
    "bash",            // approved verification commands only (test/build/lint)
    "think",           // reasoning never mutates
    "load_skill",      // read-only skill docs
    "browser",         // snapshot / screenshot / open / status / close only
  ],
  forbidden: [
    "write_file", "edit_file", "multi_edit", "apply_patch",
    "memory", "todo",               // persistent Forge state
    "delegate",                     // no recursive write-capable sub-agent
  ],
}

/** Is this tool permitted for a verification (READ_ONLY) agent? */
export function verificationAllows(name, args) {
  const n = String(name ?? "")
  if (VERIFICATION_TOOLS.forbidden.includes(n)) return { ok: false, reason: `${n} is forbidden for a verification agent` }
  if (n === "bash") {
    if (isReadOnlyAllowedBash(String(args?.command ?? ""))) return { ok: true }
    return { ok: false, reason: `bash command is not an approved verification command: ${String(args?.command ?? "").slice(0, 80)}` }
  }
  if (n === "browser") {
    const action = String(args?.action ?? "")
    if (browserMutatesFilesystem(args)) return { ok: false, reason: "browser screenshot with path writes a file" }
    if (isPageMutating(action)) return { ok: false, reason: `browser ${action} drives the page — verification may snapshot/screenshot/open/status/close only` }
    if (action && !isVerifyAction(action)) return { ok: false, reason: `browser ${action} is not a verification action` }
    return { ok: true }
  }
  if (!VERIFICATION_TOOLS.allowed.includes(n)) return { ok: false, reason: `${n} is not in the verification tool set` }
  return { ok: true }
}

function getMutationClass(name, args) {
  if (WRITE_TOOLS.has(name)) return MUTATION_CLASS.FILESYSTEM
  if (name === "bash") {
    const cmd = String(args?.command ?? "")
    if (isReadOnlyAllowedBash(cmd)) return MUTATION_CLASS.NONE
    return MUTATION_CLASS.FILESYSTEM
  }
  if (FORGE_STATE_MUTATING_TOOLS.has(name)) {
    if (name === "memory") {
      const action = String(args?.action ?? "read")
      if (action === "read") return MUTATION_CLASS.NONE
      return MUTATION_CLASS.FORGE_STATE
    }
    if (name === "todo") {
      const action = String(args?.action ?? "list")
      if (action === "list") return MUTATION_CLASS.NONE
      return MUTATION_CLASS.FORGE_STATE
    }
    return MUTATION_CLASS.FORGE_STATE
  }
  if (name === "browser" && browserMutatesFilesystem(args)) return MUTATION_CLASS.FILESYSTEM
  return MUTATION_CLASS.NONE
}

export function isReadOnlyViolation(name, args, readOnly) {
  if (!readOnly) return null
  const mutationClass = getMutationClass(name, args)
  if (mutationClass === MUTATION_CLASS.FILESYSTEM) {
    if (name === "bash" && isReadOnlyAllowedBash(args?.command)) return null
    return `BLOCKED: ${name} is a filesystem mutation and is disabled in this read-only agent (mutation class: ${mutationClass})`
  }
  if (mutationClass === MUTATION_CLASS.FORGE_STATE) {
    return `BLOCKED: ${name} mutates persistent Forge state (${args?.action ?? "write"}) and is disabled in read-only mode — read-only workers may only inspect/search/analyze/read/verify`
  }
  return null
}

// ---------------------------------------------------------------------------
// tool context
// ---------------------------------------------------------------------------

export function makeToolContext(opts = {}) {
  const {
    cwd,
    /** "default" | "verifier" — a verifier sees only verificationTools. */
    mode = "default",
    timeoutSec = AGENT_BUDGETS.timeoutSec,
    maxToolOutput = AGENT_BUDGETS.maxToolOutput,
    skillsDir,
    searchUrl,
    memoryPath,
    todoPath,
    delegateRunner,
    readOnly = false,
    root,
    allowOutsideProject = false,
    allowGeneratedWrites = false,
    allowSudo = false,
    assumeYes = false,
    allowNetworkUpload = false, // v21.1: curl -d / wget --post-file / scp … from the model
    allowInterpreterEval = false, // v21.2: node -e / python -c / perl -e …
    autonomous = false, // v25: in-project git danger without assumeYes
    unrestricted = false, // v85: owner master switch — every shell guard off
    fetchPrivateUrls = process.env.FORGE_ALLOW_PRIVATE_URLS === "1",
    delegateTimeoutSec = AGENT_BUDGETS.delegateTimeoutSec,
    maxParallelDelegates = 2,
    signal = null,
    subAgent = false,
    runId = null,
    plugins = [], // v20.2 P3-5: user tool plugins (from loadToolPlugins().tools)
    vision = true,
    visionProvider = null,
    browser = true,
    browserBinary,
    browserDriver = null,
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
    mode,
    allowOutsideProject, allowGeneratedWrites, allowSudo, assumeYes, allowNetworkUpload, allowInterpreterEval, autonomous, unrestricted, fetchPrivateUrls,
    delegateTimeoutSec, signal, subAgent, runId,
    _plugins: pluginMap,
    _delegateActive: 0,
    _delegateMax: Math.max(1, Math.min(AGENT_BUDGETS.maxParallelSubAgents, maxParallelDelegates)),
    vision: vision !== false,
    visionProvider: visionProvider || null,
    _pendingVision: [],
    browser: browser !== false,
    _browserDriver: browserDriver || null,
    _browser: null,
  }
  if (browserBinary !== undefined) ctx.browserBinary = browserBinary
  ctx.checkPath = (p, opts2) => safePath(ctx, p, opts2)
  ctx.writeScreenshot = (rel, buf) => {
    const sp = safePath(ctx, rel, { write: true })
    if (!sp.ok) return sp
    try {
      fs.mkdirSync(path.dirname(sp.abs), { recursive: true })
      fs.writeFileSync(sp.abs, buf)
      return { ok: true, abs: sp.abs }
    } catch (e) {
      return { ok: false, error: `ERROR: screenshot write failed: ${String(e?.message ?? e).slice(0, 160)}` }
    }
  }
  const allDefs = plugins.length ? [...TOOL_DEFS, ...plugins.map((p) => p.def)] : TOOL_DEFS
  let filteredDefs = allDefs
  if (mode === "verifier") {
    // whitelist: the verifier never even sees a mutating tool
    filteredDefs = allDefs.filter((t) => VERIFICATION_TOOLS.allowed.includes(t.function.name))
  } else if (readOnly) {
    filteredDefs = allDefs.filter((t) => {
      const n = t.function.name
      if (WRITE_TOOLS.has(n)) {
        if (n === "bash") return true
        return false
      }
      return true
    })
  }
  return { defs: filteredDefs, exec: (name, args) => execTool(ctx, name, args || {}), ctx }
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

/**
 * Truncate a command's output while KEEPING its trailing status marker.
 * v20 appended `[exit code: N]` and then ran the whole string through cap():
 * once the output exceeded maxToolOutput the marker was cut off, agent.js
 * (`/\[exit code: (-?\d+)\]/`) saw none, recorded exitCode 0 / passed:true and
 * a failing test-suite counted as verified. The marker now travels outside the
 * truncation window.
 */
function capWithMarker(body, marker, limit) {
  const capped = cap(body || "(no output)", limit)
  return marker ? `${capped}\n${marker}` : capped
}

/**
 * Terminate a child AND everything it spawned. The command runs via
 * /bin/sh -c inside its own process group (detached:true), so a single
 * negative-PID signal reaches `sleep 300 &`-style grandchildren that used to
 * survive the parent's SIGKILL and leak after a timeout.
 */
function killTree(child, signal = "SIGKILL") {
  if (!child || child.pid == null) return
  try { process.kill(-child.pid, signal); return } catch {}
  try { child.kill(signal) } catch {}
}

// ---------------------------------------------------------------------------
// v87 — broken-bwrap auto-fallback
//
// Some kernels/containers ship a bwrap binary that can never start (hidden
// overflowuid, userns disabled): every sandboxed command exits 1 with a
// `bwrap: …` setup error before the real command runs. Detect that exact
// signature ONCE, remember it for the session, and re-run the command
// directly through /bin/sh. A missing isolator is "unsandboxed", never a
// fake sandbox — and never a permission prompt the user has to answer.
// ---------------------------------------------------------------------------
let bwrapBroken = false // session-wide: once bwrap fails to start, stop wrapping

function isBwrapStartFailure(out) {
  const s = String(out || "")
  return /\[exit code: 1\]\s*$/.test(s) && /^\s*bwrap:\s/m.test(s)
}

const plainWrap = (command) => ({ file: "/bin/sh", args: ["-c", command], sandboxed: false, kind: "none" })

async function runBash(ctx, command, timeoutSec) {
  if (ctx.readOnly) {
    const mutationCheck = getMutationClass("bash", { command })
    if (mutationCheck === MUTATION_CLASS.FILESYSTEM && !isReadOnlyAllowedBash(command)) {
      return `BLOCKED: write tools are disabled in this read-only agent — bash command "${String(command).slice(0, 80)}" is a filesystem mutation. Read-only workers may run approved verification commands (test/build/lint) but not arbitrary mutations.`
    }
  }
  const verdict = modelMayRun(command, { cwd: ctx.cwd, root: ctx.root }, { allowSudo: ctx.allowSudo, assumeYes: ctx.assumeYes, allowNetworkUpload: ctx.allowNetworkUpload, allowInterpreterEval: ctx.allowInterpreterEval, autonomous: ctx.autonomous === true, unrestricted: ctx.unrestricted === true })
  if (!verdict.ok) return verdict.reason
  const t = Math.min(AGENT_BUDGETS.bashTimeoutCapSec, Math.max(1, timeoutSec || ctx.timeoutSec)) * 1000
  if (ctx.signal?.aborted) return "ERROR: cancelled — command not started (user interrupt)"

  const attempt = (wrapped) => new Promise((resolve) => {
    const MAX_BUF = 4 * 1024 * 1024
    let stdout = "", stderr = "", bytes = 0, overflow = false, done = false
    let timedOut = false, aborted = false
    const startedAt = Date.now()
    // detached → own process group, so killTree() can reach grandchildren
    const child = spawn(wrapped.file, wrapped.args, { cwd: ctx.cwd, env: { ...process.env, TERM: "dumb" }, stdio: ["ignore", "pipe", "pipe"], detached: true })
    const timer = setTimeout(() => { timedOut = true; killTree(child) }, t)
    const onAbort = () => { aborted = true; killTree(child) }
    if (ctx.signal) ctx.signal.addEventListener("abort", onAbort, { once: true })
    const collect = (which) => (chunk) => {
      if (overflow) return
      bytes += chunk.length
      if (bytes > MAX_BUF) { overflow = true; killTree(child); return }
      if (which === "out") stdout += chunk; else stderr += chunk
    }
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8")
    child.stdout.on("data", collect("out")); child.stderr.on("data", collect("err"))
    const finish = (code, sig, spawnErr) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort)
      const finishedAt = Date.now()
      let out = ""
      if (stdout) out += stdout
      if (stderr) out += (out ? "\n--- stderr ---\n" : "") + stderr
      if (aborted) return resolve(`ERROR: cancelled — command terminated by user interrupt${out ? `\n${cap(out, 2000)}` : ""}`)
      if (spawnErr) return resolve(`ERROR: ${spawnErr.message}\n[exit code: 127]`)
      const rec = createCommandResult({
        command,
        exitCode: typeof code === "number" ? code : null,
        signal: sig || null,
        timedOut,
        killed: timedOut || overflow || !!sig,
        stdout,
        stderr,
        durationMs: finishedAt - startedAt,
        truncated: false,
        processId: child.pid ?? null,
        processGroupId: child.pid ?? null,
        startedAt,
        finishedAt,
        overflow,
        aborted: false,
        timeoutSec: t / 1000,
        maxBuf: MAX_BUF,
      })
      resolve(formatCommandResult(rec, { max: ctx.maxToolOutput }))
    }
    child.on("error", (e) => finish(null, null, e))
    child.on("close", (code, sig) => finish(code, sig, null))
  })

  // v87: wrap only while the sandbox has not proven broken; if the sandboxed
  // spawn dies with a bwrap setup error, re-run the same command unsandboxed
  // and remember — later commands skip the dead wrapper entirely.
  let wrapped = bwrapBroken ? plainWrap(command) : wrapBash(command, { cwd: ctx.cwd, root: ctx.root })
  let out = await attempt(wrapped)
  if (wrapped.sandboxed && isBwrapStartFailure(out)) {
    bwrapBroken = true
    const why = (out.split("\n").find((l) => /^\s*bwrap:/.test(l)) || "bwrap failed to start").trim().slice(0, 160)
    out = await attempt(plainWrap(command))
    out += `\n[forge] sandbox skipped: ${why} — command re-run WITHOUT the sandbox (FORGE_SANDBOX=0 makes this permanent).`
  }
  return out
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

function read_image(ctx, args) {
  const rel = String(args.path ?? "").trim()
  if (isRemotePath(rel)) return "ERROR: read_image is local files only (no remote fetch)"
  const sp = safePath(ctx, rel)
  if (!sp.ok) return sp.error
  const rec = loadLocalImage(sp.abs)
  if (!rec.ok) return rec.error
  const visionOn = ctx.vision !== false
  const capable = visionOn && providerSupportsVision(ctx.visionProvider)
  let attached = false
  let reason = ""
  if (!visionOn) reason = "tools.vision is false (metadata only)"
  else if (!capable) reason = "provider/model does not accept image parts (metadata only — never fake vision)"
  else if (rec.tooBig || !rec.buf) reason = `too large to attach (cap ${MAX_IMAGE_BYTES} bytes)`
  else if ((ctx._pendingVision?.length ?? 0) >= MAX_PENDING) reason = `pending vision cap (${MAX_PENDING} per turn)`
  else if (queuePendingVision(ctx, rec)) attached = true
  else reason = "could not queue image part"
  return formatImageToolResult(rec, { attached, reason })
}

function write_file(ctx, args) {
  const sp = safePath(ctx, args.path, { write: true })
  if (!sp.ok) return sp.error
  const p = sp.abs
  const existed = fs.existsSync(p)
  // v20: one checkpoint covers the whole mutation — existing files get
  // backups, newly created files get tracked for undo-removal
  const id = snapshotBefore([p], ctx.cwd, existed ? [] : [p], ctx.runId)
  try {
    projectWrite(ctx, p, args.content ?? "")
  } catch (e) {
    return writeErrorText(e, p)
  }
  if (id) sealCreated(id, ctx.cwd)
  const cpNote = !id && existed ? " — ⚠ checkpoint failed: this change cannot be undone" : ""
  return `OK wrote ${p} (${(args.content ?? "").length} bytes${existed ? "" : ", created"})${cpNote}`
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
  const cpId = snapshotBefore([p], ctx.cwd, [], ctx.runId) // v16: auto-checkpoint
  const out = args.replace_all ? src.split(oldS).join(newS) : src.replace(oldS, newS)
  try {
    projectWrite(ctx, p, out)
  } catch (e) {
    return writeErrorText(e, p)
  }
  return `OK edited ${p}${cpId ? "" : " — ⚠ checkpoint failed: this change cannot be undone"}`
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
  if (ctx.skillsDir) {
    const base = realPathOf(ctx.skillsDir)
    const target = path.join(ctx.skillsDir, name, "SKILL.md")
    const sp = safePath({ ...ctx, root: ctx.skillsDir }, path.join(name, "SKILL.md"))
    if (!sp.ok) return sp.error
    const real = realPathOf(target)
    if (!insideDir(real, base)) return `ERROR: skill path escapes the skills directory`
    if (fs.existsSync(target)) {
      const md = fs.readFileSync(target, "utf8")
      return md.length > 24000 ? md.slice(0, 24000) + "\n... (truncated)" : md
    }
  }
  const learned = ctx.cwd ? readLearnedSkill(ctx.cwd, name) : null
  if (learned) return learned
  const play = ctx.cwd ? readLearnedPlaybookByName(ctx.cwd, name) : null
  if (play) return play
  const downloaded = readDownloadedSkill(name)
  if (downloaded) return downloaded
  const toolPlay = readDownloadedToolPlaybook(name)
  if (toolPlay) return toolPlay
  if (!ctx.skillsDir) return "ERROR: no skills directory configured"
  return `ERROR: skill not found: ${name}`
}

// --- web ---------------------------------------------------------------------

async function fetch_url(ctx, args) {
  const url = String(args.url || "").trim()
  if (!/^https?:\/\//i.test(url)) return "ERROR: only absolute http(s) URLs are supported"
  let host = ""
  try { host = new URL(url).hostname } catch { return "ERROR: malformed URL" }
  // v21.1 SSRF guard with DNS PINNING (netguard.pinnedFetch): the host is
  // resolved ONCE, every record is validated (private, loopback, link-local,
  // CGNAT, multicast, IPv6 ULA/link-local, IPv4-mapped/NAT64/6to4/Teredo…),
  // and the socket is pinned to exactly those addresses — the fetch never
  // performs a second, uncontrolled DNS lookup (no rebinding window). Every
  // redirect hop is resolved, validated and pinned again. Local stacks
  // (Ollama, SearXNG) can opt in via tools.fetchPrivateUrls /
  // FORGE_ALLOW_PRIVATE_URLS=1.
  try {
    const res = await pinnedFetch(url, {
      headers: { "user-agent": `forge-agent/${VERSION}`, accept: "text/*,application/json;q=0.9,*/*;q=0.5" },
      allowPrivate: true, // v88 noguard: local/private fetches allowed — no SSRF gate on fetch_url
      timeoutMs: 15000,
      totalTimeoutMs: 30000,
      maxRedirects: 5,
      maxBytes: 2 * 1024 * 1024,
      signal: ctx.signal ?? undefined,
    })
    if (!res.ok) return `ERROR: HTTP ${res.status} for ${res.url}`
    const ct = String(res.headers["content-type"] || "")
    if (!/text|json|xml|javascript|csv|markdown|html|yaml/i.test(ct)) return `ERROR: non-text content-type (${ct}) — binary not supported`
    let text = new TextDecoder().decode(res.body)
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
    const via = res.hops.length > 1 ? `\n(redirected ${res.hops.length - 1}× → ${res.url})` : ""
    return cap(`URL: ${url}${via}\nContent-Type: ${ct}\n\n${text}`, ctx.maxToolOutput)
  } catch (e) {
    if (e instanceof PinnedFetchError && e.blocked) {
      const hop = e.hop ? ` (redirect hop ${e.hop} → ${String(e.url).slice(0, 120)})` : ""
      return `ERROR: fetch integrity failure: ${e.message}${hop} (the socket must connect to exactly the validated addresses — v88 noguard removed the private-URL gate, not socket pinning)`
    }
    if (e instanceof PinnedFetchError && e.code === "ETOOLARGE") return `ERROR: ${e.message} (limit 2MB)`
    if (e instanceof PinnedFetchError && e.code === "ABORT_ERR") return "ERROR: cancelled — fetch stopped by user interrupt"
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
  // v21.1: both backends go through pinnedFetch — same DNS pinning, redirect
  // validation and size/time bounds as fetch_url. The configured endpoint is
  // the USER's (config-level, never model-controlled) so a private/loopback
  // SearXNG on the LAN is allowed for it; the query string is model-controlled
  // but cannot change the host. Redirects from either backend are validated
  // like any other hop (a public search endpoint may not bounce us to a
  // metadata address).
  const searchFetch = (url, headers, allowPrivate) => pinnedFetch(url, { headers, timeoutMs: 12000, totalTimeoutMs: 15000, maxBytes: 1024 * 1024, maxRedirects: 3, allowPrivate, signal: ctx.signal ?? undefined })
  if (ctx.searchUrl) {
    const url = ctx.searchUrl + (ctx.searchUrl.includes("?") ? "&" : "?") + "q=" + encodeURIComponent(q)
    tried.push(url)
    try {
      const res = await searchFetch(url, { "user-agent": `forge-agent/${VERSION}`, accept: "application/json,text/html;q=0.8" }, ctx.fetchPrivateUrls === true ? true : "first-hop")
      if (res.ok) {
        const ct = String(res.headers["content-type"] || "")
        const body = res.body.toString("utf8")
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
    const res = await searchFetch(url, { "user-agent": `Mozilla/5.0 (X11; Linux x86_64) forge/${VERSION}` }, ctx.fetchPrivateUrls === true)
    if (!res.ok) throw new Error("HTTP " + res.status)
    const body = res.body.toString("utf8")
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
  const cpId = snapshotBefore([p], ctx.cwd, [], ctx.runId) // v16: auto-checkpoint
  try {
    projectWrite(ctx, p, out)
  } catch (e) {
    return writeErrorText(e, p)
  }
  return `OK multi_edit ${p}: ${applied} replacement(s), ${edits.length} edit(s), atomic${cpId ? "" : " — ⚠ checkpoint failed: this change cannot be undone"}`
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
    ctx.runId, // v20.4 fix: patch checkpoints were the only ones missing the run tag (→ /undo --run skipped them)
  )
  // Per-file writes are atomic (temp → fsync → rename, symlink-safe). If one
  // file cannot be written the already-written files are rolled back from
  // the checkpoint so the patch stays all-or-nothing on disk too.
  const written = []
  for (const [t, content] of applied.results) {
    const p = safePath(ctx, t, { write: true }).abs
    try {
      projectWrite(ctx, p, content)
      written.push(p)
    } catch (e) {
      let rolled = ""
      if (checkpointId) {
        try {
          const r = restoreTransactional(checkpointId, { cwd: ctx.cwd })
          rolled = r?.ok ? " — earlier files of this patch were rolled back" : ` — ROLLBACK ${r?.status ?? "FAILED"}: ${written.length} file(s) may be partially patched, run forge undo`
        } catch { rolled = ` — ROLLBACK FAILED: ${written.length} file(s) may be partially patched, run forge undo` }
      }
      return `${writeErrorText(e, p)}${rolled}`
    }
  }
  const unlinkFailed = []
  for (const t of applied.deleted) {
    const p = safePath(ctx, t, { write: true }).abs
    try { projectUnlink(ctx, p) } catch (e) { unlinkFailed.push(`${t} (${e?.code ?? e?.message})`) }
  }
  if (checkpointId) sealCreated(checkpointId, ctx.cwd)
  if (unlinkFailed.length) return `ERROR: patch applied but could not delete ${unlinkFailed.join(", ")} — files were written; run forge undo to revert`
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

// --- git inspection (v90): git_diff / git_log / git_blame -----------------------
// All three are read-only views over git plumbing, executed via execFile with
// argument arrays (never a shell string), output secret-redacted by cap() and
// token-budgeted so a huge diff can never blow the context.

function gitExec(ctx, args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: ctx.cwd, timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, out: String(stdout ?? ""), errText: String(stderr ?? "") })
    })
  })
}

const GIT_REF_RE = /^[A-Za-z0-9._/~^-]{1,64}$/

async function git_diff(ctx, args = {}) {
  const base = String(args.base ?? "HEAD")
  const pathFilter = args.path ? String(args.path) : null
  const context = Math.max(0, Math.min(10, Number(args.context ?? 3) || 0))
  const maxLines = Math.max(20, Math.min(2000, Number(args.max_lines ?? 400) || 400))
  if (!GIT_REF_RE.test(base) || base.startsWith("-")) return "ERROR: invalid base — use 'HEAD', 'stage', 'worktree', or a commit/branch/tag name"

  // target selection: HEAD = staged+unstaged vs HEAD · stage = staged only ·
  // worktree = unstaged only · anything else = working tree vs that ref
  const target = []
  if (base === "stage") target.push("--cached")
  else if (base !== "worktree") target.push(base)
  const tail = pathFilter ? ["--", pathFilter] : []

  const stat = await gitExec(ctx, ["diff", "--no-color", "--no-ext-diff", "--stat", ...target, ...tail])
  const d = await gitExec(ctx, ["diff", "--no-color", "--no-ext-diff", `-U${context}`, ...target, ...tail])
  if (d.err && /not a git repository/i.test(d.errText)) return "ERROR: not a git repository (or git unavailable)"
  if (d.err) return "ERROR: git diff failed: " + d.errText.trim().split("\n")[0].slice(0, 200)

  const body = d.out.replace(/\n$/, "")
  const where = base === "stage" ? "staged" : base === "worktree" ? "in the working tree" : "vs " + base
  if (!body) return `(no differences ${where}${pathFilter ? " for " + pathFilter : ""})`

  const statLine = stat.err ? "" : String(stat.out).trim()
  const lines = body.split("\n")
  if (lines.length <= maxLines) return cap([statLine, body].filter(Boolean).join("\n\n"), ctx.maxToolOutput)

  // over budget: diffstat + head of the diff + how to narrow. Never silently
  // drop the middle of a diff the model believes it saw in full.
  const head = lines.slice(0, maxLines).join("\n")
  return cap(
    [
      `diff ${where}${pathFilter ? " — " + pathFilter : ""} is ${lines.length} lines; showing the first ${maxLines}`,
      statLine,
      "",
      head,
      "",
      `… ${lines.length - maxLines} more diff lines — narrow with path=, a lower context=, or read specific files`,
    ].filter(Boolean).join("\n"),
    ctx.maxToolOutput
  )
}

async function git_log(ctx, args = {}) {
  const limit = Math.max(1, Math.min(50, Number(args.limit ?? 15) || 15))
  const pathFilter = args.path ? String(args.path) : null
  const a = ["log", "--no-color", "--date=short", "--pretty=format:%h %ad %an %s", "-n", String(limit)]
  if (args.stat === true) a.push("--stat")
  if (pathFilter) a.push("--", pathFilter)
  const r = await gitExec(ctx, a)
  if (r.err && /not a git repository/i.test(r.errText)) return "ERROR: not a git repository (or git unavailable)"
  if (r.err) return "ERROR: git log failed: " + r.errText.trim().split("\n")[0].slice(0, 200)
  const body = r.out.replace(/\n+$/, "")
  if (!body) return `(no commits${pathFilter ? " touching " + pathFilter : ""})`
  return cap(body, ctx.maxToolOutput)
}

async function git_blame(ctx, args = {}) {
  const file = String(args.path ?? "")
  if (!file) return "ERROR: path is required"
  const start = Math.max(1, Number(args.start ?? 1) || 1)
  let end = Number(args.end ?? start + 39)
  if (!Number.isFinite(end) || end < start) end = start
  const WINDOW = 200
  let clamped = false
  if (end - start + 1 > WINDOW) { end = start + WINDOW - 1; clamped = true }

  const r = await gitExec(ctx, ["blame", "--date=short", "-w", "-L", `${start},${end}`, "--", file])
  if (r.err && /not a git repository/i.test(r.errText)) return "ERROR: not a git repository (or git unavailable)"
  if (r.err && /no such path|does not exist/i.test(r.errText)) return `ERROR: ${file} is not tracked by git (untracked or missing)`
  if (r.err) return "ERROR: git blame failed: " + r.errText.trim().split("\n")[0].slice(0, 200)

  const body = r.out.replace(/\n$/, "")
  if (!body) return `(nothing to blame for ${file} lines ${start}-${end})`
  return cap((clamped ? `… blame window capped at ${WINDOW} lines (use start=/end= to move it)\n` : "") + body, ctx.maxToolOutput)
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
  if (ctx.readOnly && action !== "list") {
    return `BLOCKED: todo ${action} mutates persistent Forge state and is disabled in read-only mode — read-only workers may only inspect/search/analyze/read/verify`
  }
  const state = readTodo(ctx)
  if (action === "list") return renderTodo(state.items)
  if (action === "set") {
    const items = (Array.isArray(args.items) ? args.items : []).slice(0, 100).map((it, i) => ({ id: i + 1, content: String(it.content ?? "").slice(0, 200), status: ["todo", "doing", "done"].includes(it.status) ? it.status : "todo" }))
    if (!items.length) return "ERROR: no items provided for action=set"
    try { writeStateFile(p, JSON.stringify({ items }, null, 1)) } catch (e) { return `ERROR: ${e.message}` }
    return "TODO list saved:\n" + renderTodo(items)
  }
  if (action === "update") {
    const idx = (args.id ?? 0) - 1
    const it = state.items[idx]
    if (!it) return `ERROR: no todo item #${args.id} — use action=list to see ids`
    if (args.status && ["todo", "doing", "done"].includes(args.status)) it.status = args.status
    if (args.content) it.content = String(args.content).slice(0, 200)
    try { writeStateFile(p, JSON.stringify(state, null, 1)) } catch (e) { return `ERROR: ${e.message}` }
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

/** Who is writing memory: the model via a tool (sub-agent or not), tagged with the run. */
function memoryProvenance(ctx) {
  return { source: ctx.subAgent ? "subagent" : "tool", runId: ctx.runId ?? null }
}

function memory(ctx, args) {
  const action = args.action || "read"
  if (ctx.readOnly && action !== "read") {
    return `BLOCKED: memory ${action} mutates persistent Forge state and is disabled in read-only mode — read-only workers may only inspect/search/analyze/read/verify. Memory mutations: append, replace, learn are blocked.`
  }
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
    const r = appendMemory(scope, text, ctx.cwd, memoryProvenance(ctx))
    return r.ok ? `OK ${scope} memory appended: "${text.slice(0, 80)}"` : `ERROR: ${r.error}`
  }
  if (action === "replace") {
    const text = String(args.text ?? "").slice(0, 4000)
    const r = replaceMemory(globalPath, text, ctx.cwd, memoryProvenance(ctx)) // v21.1: atomic + provenance, same pipeline as append
    return r.ok ? `OK memory replaced (${r.chars} chars)` : `ERROR: ${r.error}`
  }
  if (action === "learn") {
    const problem = String(args.problem ?? "").trim()
    const fix = String(args.fix ?? "").trim()
    if (!problem || !fix) return "ERROR: learn needs problem + fix (root_cause recommended)"
    const r = recordLearning({ problem, rootCause: args.root_cause ?? args.rootCause ?? "", fix }, ctx.cwd, memoryProvenance(ctx))
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
  let timerId = null
  try {
    const work = Promise.resolve(ctx.delegateRunner(task, role))
    const timer = new Promise((resolve) => {
      timerId = setTimeout(() => { timedOut.v = true; resolve(null) }, timeoutMs)
    })
    const summary = await Promise.race([work, timer])
    if (timedOut.v || summary === null) {
      return `ERROR: sub-agent timed out after ${Math.round(timeoutMs / 1000)}s (agent.delegateTimeoutSec) — narrow the subtask or raise the limit`
    }
    return cap(`SUB-AGENT REPORT (${role}):\n${summary}`, ctx.maxToolOutput)
  } catch (e) {
    if (e?.name === "AbortError" || ctx.signal?.aborted) return "ERROR: cancelled — sub-agent stopped by user interrupt"
    return `ERROR: sub-agent failed: ${String(e?.message ?? e).slice(0, 200)}`
  } finally {
    if (timerId) clearTimeout(timerId)
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
  {
    // 1×1 PNG (IHDR 1x1, IDAT, IEND) — doctor proves read_image without a provider
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da63000000020001e221bc330000000049454e44ae426082", "hex")
    fs.writeFileSync(path.join(tmp, "probe.png"), png)
    results.push(await t("read_image", () => execTool(ctx, "read_image", { path: "probe.png" })))
  }
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
  results.push(await t("git_diff", async () => {
    const { execFileSync } = await import("node:child_process")
    try {
      execFileSync("git", ["add", "-A"], { cwd: tmp })
      execFileSync("git", ["-c", "user.email=doctor@forge.local", "-c", "user.name=forge-doctor", "commit", "-q", "-m", "doctor probe"], { cwd: tmp })
    } catch {}
    await execTool(ctx, "write_file", { path: "probe.txt", content: "diff probe v2" })
    const r = await execTool(ctx, "git_diff", {})
    if (typeof r === "string" && r.startsWith("ERROR")) return r
    return typeof r === "string" && r.includes("diff probe v2") ? r + "\n[diff verified]" : "ERROR: git_diff showed no probe change"
  }))
  results.push(await t("git_log", async () => {
    const r = await execTool(ctx, "git_log", { limit: 5 })
    if (typeof r === "string" && r.startsWith("ERROR")) return r
    return typeof r === "string" && r.includes("doctor probe") ? r + "\n[log verified]" : "ERROR: git_log missed the probe commit"
  }))
  results.push(await t("git_blame", async () => {
    // patched.txt was committed by the doctor and NOT modified after — its
    // blame lines carry the probe author (probe.txt was rewritten post-commit,
    // so it would blame to "Not Committed Yet").
    const r = await execTool(ctx, "git_blame", { path: "patched.txt", start: 1, end: 1 })
    if (typeof r === "string" && r.startsWith("ERROR")) return r
    return typeof r === "string" && r.includes("forge-doctor") ? r + "\n[blame verified]" : "ERROR: git_blame missed the probe author"
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
    await pinnedFetch("https://example.com", { timeoutMs: 4000, totalTimeoutMs: 4000, maxBytes: 65536 })
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
  {
    const r = await execTool({ ...ctx, _browserDriver: createMockDriver(), browser: true, vision: false }, "browser", { action: "status" })
    const bad = typeof r === "string" && r.startsWith("ERROR")
    results.push({ name: "browser", ok: bad ? false : true, ms: 0, note: String(r).slice(0, 80) })
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  return results
}

// ---------------------------------------------------------------------------
// dispatcher — single choke point: every string result passes through
// secret redaction before it reaches the model / sessions / logs.
// ---------------------------------------------------------------------------

const REDACTED_TOOLS = new Set(["bash", "read_file", "read_image", "fetch_url", "web_search", "browser", "delegate", "git_status", "grep_files", "memory"])

export async function execTool(ctx, name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) args = {}
  // VERIFY ⇒ READ_ONLY: enforce the whitelist even if a tool definition leaks
  // through (a plugin, a direct call, or a future refactor).
  if (ctx.mode === "verifier") {
    const allowed = verificationAllows(name, args)
    if (!allowed.ok) return `BLOCKED: ${allowed.reason} — verification is read-only (VERIFY ⇒ READ_ONLY, REPAIR ⇒ WRITE)`
  }
  if (ctx.readOnly) {
    const violation = isReadOnlyViolation(name, args, true)
    if (violation) return violation
    const pl = ctx._plugins?.get(name)
    if (pl && !pl.readOnly) {
      return `BLOCKED: write tools are disabled in this read-only agent — plugin ${name} is not read-only`
    }
  }
  let result
  switch (name) {
    case "bash": result = await runBash(ctx, String(args.command ?? ""), args.timeout_sec); break
    case "read_file": result = read_file(ctx, args); break
    case "read_image": result = read_image(ctx, args); break
    case "write_file": result = write_file(ctx, args); break
    case "edit_file": result = edit_file(ctx, args); break
    case "list_dir": result = list_dir(ctx, args); break
    case "grep_files": result = grep_files(ctx, args); break
    case "load_skill": result = load_skill(ctx, args); break
    case "fetch_url": result = await fetch_url(ctx, args); break
    case "glob_files": result = glob_files(ctx, args); break
    case "web_search": result = await web_search(ctx, args); break
    case "browser": result = await runBrowser(ctx, args); break
    case "multi_edit": result = multi_edit(ctx, args); break
    case "apply_patch": result = apply_patch(ctx, args); break
    case "git_status": result = await git_status(ctx); break
    case "git_diff": result = await git_diff(ctx, args); break
    case "git_log": result = await git_log(ctx, args); break
    case "git_blame": result = await git_blame(ctx, args); break
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
