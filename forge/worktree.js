/**
 * forge — v95 "worktreewise": isolated worktree execution for DAG nodes.
 *
 * The kernel TODO (open since the design was written) said: "nodes would run
 * in a per-node git worktree so parallel segments never see each other's
 * partial writes; design exists, no implementation, no test." This module is
 * that implementation. Mutating DAG nodes whose declared targets are
 * pairwise-disjoint can execute in parallel, each inside its own
 * `git worktree add --detach` checkout of HEAD. Writes land in the worktree
 * (never the shared tree), and the merge back into the main tree is
 * SERIALIZED through the single-writer lane (`git apply --3way`, checked
 * first, honest conflict evidence when it fails — never a silent overwrite).
 *
 * Design invariants (house law, kept):
 *  - Never run DAG nodes in a shared tree when they mutate the same files.
 *    Worktrees are the FIX for that, not a license: an undeclared overlap
 *    surfaces as an honest merge conflict, the node FAILS with evidence, and
 *    the serialized retry path takes over.
 *  - Single-writer discipline per tree. The main tree is mutated only by the
 *    serialized merge-back (one node at a time, core-owned). A worktree has
 *    exactly one writer (its child-process worker).
 *  - agent.js binds to process.cwd(), so an isolated node runs in a CHILD
 *    PROCESS whose cwd IS the worktree (worknode.mjs). Parallel agents can
 *    never chdir-race in one process.
 *  - Fallback is honest: not a git repo / git unusable / opt-out flag /
 *    worktree creation failure → the node stays serialized exactly as before
 *    (never dispatched mutating into the shared tree).
 *  - Registry: .forge/worktrees/registry.json (mode 600) tracks every live
 *    worktree with owner ids; a crashed run's worktrees are swept at the
 *    next task start (crash-resume house pattern).
 *
 * Zero dependencies. git is executed via execFile with ARGUMENT ARRAYS (never
 * a shell string), 15s timeout, bounded buffers — same law as tools.js's
 * gitExec, kept kernel-side because this is execution policy, not a tool.
 */
import { execFile, execFileSync, spawn as childSpawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { canonicalConflictKeys as defaultConflictKeys } from "./dag.js"

const FORGE_DIR = path.dirname(fileURLToPath(import.meta.url))
const GIT_TIMEOUT_MS = 15000
const GIT_MAX_BUFFER = 16 * 1024 * 1024
const REGISTRY_MAX = 64

/** Run git with argument arrays; never throws, always settles.
 *  v98 shipwise: exported as runGit — gitship.js (kernel delivery policy)
 *  reuses THIS law instead of duplicating it (one implementation per
 *  responsibility; tools.js's gitExec is the tool-side twin). */
export function runGit(args, { cwd, timeoutMs = GIT_TIMEOUT_MS, maxBuffer = GIT_MAX_BUFFER } = {}) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer }, (err, stdout, stderr) => {
      resolve({
        err: Boolean(err),
        code: err?.code ?? 0,
        out: String(stdout ?? ""),
        errText: String(stderr ?? (err?.message ?? "")),
      })
    })
  })
}

// --- availability / gates ---------------------------------------------------

const gitProbeCache = new Map() // root → { ok, reason, at }

/** Is `root` a usable git repository (with worktree support)? Memoized per process. */
export function probeGit(root) {
  const key = String(root)
  const cached = gitProbeCache.get(key)
  if (cached && Date.now() - cached.at < 60_000) return cached
  // do NOT cache failures forever: a repo can be `git init`-ed mid-process
  // (tests do exactly that). Success caches 60s; failure caches 1s.
  const fresh = { ok: false, reason: "not probed", at: Date.now() }
  try {
    const top = execFileSyncSafe("git", ["rev-parse", "--show-toplevel"], { cwd: root })
    if (top.err) {
      fresh.reason = /not a git repository|not in a git/i.test(top.errText) ? "not a git repository" : "git unavailable or failed"
    } else {
      // worktree support exists since git 2.5 (2015) — probe it once anyway;
      // an exotic built without it must fall back to serialization, not break.
      const wt = execFileSyncSafe("git", ["worktree", "list", "--porcelain"], { cwd: root })
      if (wt.err) fresh.reason = "git worktree support missing"
      else { fresh.ok = true; fresh.reason = "ok"; fresh.top = String(top.out).trim() || key }
    }
  } catch (e) {
    fresh.reason = "git unavailable: " + String(e?.message ?? e).slice(0, 120)
  }
  gitProbeCache.set(key, fresh)
  if (!fresh.ok) setTimeout(() => gitProbeCache.delete(key), 1000).unref?.()
  return fresh
}

function execFileSyncSafe(file, args, opts) {
  // a synchronous probe wrapper that can't throw into the caller
  try {
    const out = execFileSync(file, args, { ...opts, timeout: 5000, stdio: ["ignore", "pipe", "pipe"] })
    return { err: false, out: String(out), errText: "" }
  } catch (e) {
    return { err: true, out: "", errText: String(e?.stderr ?? e?.message ?? e) }
  }
}

/** Config/env gate — default ON, opt-out via FORGE_WORKTREE=0|false or config.worktree.enabled=false. */
export function isolationEnabled({ config = null, env = process.env } = {}) {
  if (config?.worktree?.enabled === false) return false
  const v = String(env?.FORGE_WORKTREE ?? "").trim().toLowerCase()
  if (v === "0" || v === "false" || v === "off") return false
  return true
}

/** Full availability: gate AND a usable git repo at `root`. */
export function isolationAvailable({ root, config = null, env = process.env } = {}) {
  if (!isolationEnabled({ config, env })) return { ok: false, reason: "disabled by config/env" }
  const probe = probeGit(root)
  return probe.ok ? { ok: true, reason: "ok" } : { ok: false, reason: probe.reason }
}

// --- planning ----------------------------------------------------------------

/**
 * Which READY MUTATING nodes may execute in isolated worktrees.
 * Eligibility (all must hold):
 *  - node is mutating (read_only !== true) and has an id
 *  - node has NO dependencies (dependent nodes build on prior work whose
 *    output lives in the shared tree — a HEAD-only worktree cannot see
 *    merged-but-uncommitted dependency output, so they stay serialized)
 *  - not excluded (the current node, already-running nodes, …)
 *  - declares REAL conflict keys — a node whose keys degenerate to the
 *    `node:<id>` fallback declared nothing and stays serialized (conservative)
 *  - keys are pairwise disjoint inside the isolated batch
 *  - keys do not overlap the excludeKeys set (the current node's keys)
 *  - bounded by maxNodes (default 2 — measured parallelism, not a fan-out bomb)
 *
 * The dispatch side ALSO refuses nodes whose declared target files have
 * UNCOMMITTED changes in the shared tree (see uncommittedFiles) — in-flight
 * shared-tree work must never be double-booked by a parallel checkout.
 * @param {Array} nodes ready nodes (plain node objects or graph nodes)
 * @returns {Array<{ node, keys }>} the isolated batch, in priority order
 */
export function planIsolation({ nodes, excludeIds = [], excludeKeys = [], conflictKeys = null, maxNodes = 2 } = {}) {
  const keysOf = typeof conflictKeys === "function" ? conflictKeys : null
  const exclude = new Set((excludeIds ?? []).map(String))
  const held = new Set((excludeKeys ?? []).map(String))
  const picked = []
  for (const n of nodes ?? []) {
    if (!n || !n.id) continue
    if (n.read_only === true) continue
    if (exclude.has(String(n.id))) continue
    // a node WITH dependencies builds on prior work whose output lives in the
    // shared tree (merged, possibly uncommitted) — it must run serialized in
    // the shared tree, never in a HEAD-only checkout that cannot see it
    if (Array.isArray(n.dependencies) && n.dependencies.length) continue
    let keys
    try {
      keys = keysOf ? keysOf(n) : null
      if (!Array.isArray(keys) || !keys.length) keys = defaultConflictKeys(n)
    } catch {
      continue
    }
    // no declared targets → conservative fallback key → NOT eligible
    if (!keys.some((k) => /^(file|symbol|dir|resource):/.test(String(k)))) continue
    let conflict = false
    for (const k of keys) {
      if (held.has(String(k))) { conflict = true; break }
    }
    if (conflict) continue
    for (const k of keys) held.add(String(k))
    picked.push({ node: n, keys })
    if (picked.length >= Math.max(1, maxNodes)) break
  }
  return picked
}

/** Files with uncommitted changes in the shared tree (tracked drift + untracked). */
export async function uncommittedFiles(root) {
  const st = await runGit(["status", "--porcelain", "--", ".", ":(exclude).forge", ":(exclude).forge/**"], { cwd: root })
  if (st.err) return null // not a repo / git failure → caller must serialize honestly
  const files = new Set()
  for (const line of String(st.out).split("\n")) {
    if (!line.trim()) continue
    const m = line.slice(3).match(/^(?:"([^"]+)"|(\S+))(?: -> (?:"([^"]+)"|(\S+)))?$/)
    if (m) files.add((m[3] ?? m[4] ?? m[1] ?? m[2] ?? "").trim())
  }
  return files
}

// --- registry (crash-resume pattern) ----------------------------------------

export function worktreesRoot(root) {
  return path.join(String(root), ".forge", "worktrees")
}

function registryPath(root) {
  return path.join(worktreesRoot(root), "registry.json")
}

function readRegistry(root) {
  try {
    const raw = fs.readFileSync(registryPath(root), "utf8")
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

function writeRegistry(root, entries) {
  try {
    const dir = worktreesRoot(root)
    fs.mkdirSync(dir, { recursive: true })
    // bounded: newest first, cap REGISTRY_MAX
    const bounded = entries.slice(-REGISTRY_MAX)
    fs.writeFileSync(registryPath(root), JSON.stringify(bounded, null, 2), { mode: 0o600 })
    return true
  } catch { return false }
}

export function listRegistry(root) {
  return readRegistry(root)
}

function registryAdd(root, entry) {
  const entries = readRegistry(root)
  entries.push(entry)
  writeRegistry(root, entries)
}

function registryUpdate(root, id, patch) {
  const entries = readRegistry(root)
  for (const e of entries) if (e.id === id) Object.assign(e, patch)
  writeRegistry(root, entries)
}

/** Sweep worktrees whose owning run is gone (crash-resume honesty). Returns the swept ids. */
export async function sweepOrphans({ root, liveRunIds = [] } = {}) {
  const live = new Set((liveRunIds ?? []).map(String))
  const entries = readRegistry(root)
  const swept = []
  const kept = []
  for (const e of entries) {
    const stillLive = e.status === "live" && (live.has(String(e.runId)) || isPidAlive(e.pid))
    if (e.status === "live" && !stillLive && e.dir) {
      const r = await removeWorktree({ root, dir: e.dir })
      swept.push({ id: e.id, dir: e.dir, removed: r.ok, reason: r.ok ? "orphan swept" : "orphan sweep failed: " + r.reason })
      kept.push({ ...e, status: r.ok ? "orphan-swept" : "orphan-stuck", sweptAt: Date.now() })
    } else {
      kept.push(e)
    }
  }
  writeRegistry(root, kept)
  return swept
}

function isPidAlive(pid) {
  const n = Number(pid)
  if (!n || n <= 0) return false
  try { process.kill(n, 0); return true } catch { return false }
}

// --- lifecycle ----------------------------------------------------------------

function sanitizeId(s) {
  return String(s ?? "n").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64)
}

/**
 * Create a detached worktree for one node at HEAD.
 * @returns {Promise<{ok:boolean, dir?:string, id?:string, base?:string, reason?:string, error?:string}>}
 */
export async function createWorktree({ root, nodeId, runId = null, taskId = null } = {}) {
  if (!root || !nodeId) return { ok: false, reason: "root and nodeId are required" }
  const probe = probeGit(root)
  if (!probe.ok) return { ok: false, reason: probe.reason }
  const base = await runGit(["rev-parse", "HEAD"], { cwd: root })
  if (base.err || !String(base.out).trim()) return { ok: false, reason: "no commits — HEAD is empty (nothing to check out)" }
  const sha = String(base.out).trim()
  const id = `${sanitizeId(runId)}-${sanitizeId(nodeId)}`
  const dir = path.join(worktreesRoot(root), id)
  // a retry of the same node reuses the slot: remove any leftover first
  await removeWorktree({ root, dir })
  fs.mkdirSync(worktreesRoot(root), { recursive: true })
  const add = await runGit(["worktree", "add", "--detach", dir, sha], { cwd: root })
  if (add.err) return { ok: false, reason: "git worktree add failed: " + firstLine(add.errText || add.out), error: firstLine(add.errText) }
  const entry = {
    id, dir, nodeId: String(nodeId), runId: runId ? String(runId) : null,
    taskId: taskId ? String(taskId) : null, pid: process.pid,
    createdAt: Date.now(), status: "live", base: sha,
  }
  registryAdd(root, entry)
  return { ok: true, dir, id, base: sha }
}

// pathspec exclusions for capture: forge's own state dir must NEVER be
// captured as project changes (the child agent writes .forge state inside
// the worktree: checkpoints, tool-run records, diagnosis caches).
const CAPTURE_EXCLUDE = [":(exclude).forge", ":(exclude).forge/**"]

/**
 * Capture everything the node changed inside its worktree as ONE binary-safe
 * patch (modifications, additions, deletions, renames, binaries).
 * `git add -A -N` (intent-to-add) makes untracked files diffable first —
 * this only touches the worktree's PRIVATE index, never the main tree.
 * @returns {Promise<{ok:boolean, patchPath?:string, files?:string[], bytes?:number, reason?:string}>}
 */
export async function captureChanges({ root, dir, nodeId } = {}) {
  if (!root || !dir) return { ok: false, reason: "root and dir are required" }
  const intent = await runGit(["add", "-A", "-N", "--", ".", ...CAPTURE_EXCLUDE], { cwd: dir })
  if (intent.err) return { ok: false, reason: "git add -N failed: " + firstLine(intent.errText) }
  const status = await runGit(["status", "--porcelain", "--", ".", ...CAPTURE_EXCLUDE], { cwd: dir })
  const files = []
  for (const line of String(status.out).split("\n")) {
    if (!line.trim()) continue
    // XY <path> — path may be a quoted "a -> b" rename; take the target
    const m = line.slice(3).match(/^(?:"([^"]+)"|(\S+))(?: -> (?:"([^"]+)"|(\S+)))?$/)
    if (m) files.push((m[3] ?? m[4] ?? m[1] ?? m[2] ?? "").trim())
  }
  const diff = await runGit(["diff", "--binary", "--", ".", ...CAPTURE_EXCLUDE], { cwd: dir })
  if (diff.err) return { ok: false, reason: "git diff failed: " + firstLine(diff.errText) }
  const patch = String(diff.out)
  if (!patch.trim()) return { ok: true, patchPath: null, files: [], bytes: 0, clean: true }
  const patchDir = path.join(worktreesRoot(root), ".patches")
  fs.mkdirSync(patchDir, { recursive: true })
  const patchPath = path.join(patchDir, `${sanitizeId(nodeId)}-${Date.now().toString(36)}.patch`)
  fs.writeFileSync(patchPath, patch, { mode: 0o600 })
  return { ok: true, patchPath, files, bytes: Buffer.byteLength(patch) }
}

/**
 * Merge a worktree's captured patch back into the MAIN tree — the serialized
 * single-writer lane. Checked BEFORE applied (--check, then --3way --check),
 * so a conflicting patch NEVER half-applies: either it lands or the tree is
 * untouched and the conflict is reported honestly.
 * @returns {Promise<{ok:boolean, applied?:boolean, files?:string[], reason?:string, conflicts?:string[]}>}
 */
export async function mergeBack({ root, patchPath }) {
  if (!root || !patchPath || !fs.existsSync(patchPath)) return { ok: false, reason: "patch file missing" }
  // 1) plain 2-way check (fast path: the common disjoint case)
  const plain = await runGit(["apply", "--check", "--whitespace=nowarn", patchPath], { cwd: root })
  if (!plain.err) {
    const apply = await runGit(["apply", "--whitespace=nowarn", patchPath], { cwd: root })
    if (apply.err) return { ok: false, reason: "apply failed after clean check: " + firstLine(apply.errText), conflicts: [] }
    return { ok: true, applied: true, files: filesInPatch(patchPath) }
  }
  // 2) 3-way check (drifted main tree, but the merge is still well-defined)
  const three = await runGit(["apply", "--3way", "--check", "--whitespace=nowarn", patchPath], { cwd: root })
  if (three.err) {
    // honest conflict: name the files git refused (observed shapes:
    // "error: shared.txt: does not match index",
    // "error: shared.txt: patch does not apply",
    // "error: patch failed: shared.txt:1"; the patch's own file list is
    // the honest fallback when nothing parses)
    const parsed = parseApplyConflicts(three.errText)
    const conflicts = parsed.length ? parsed : filesInPatch(patchPath)
    return { ok: false, applied: false, reason: "merge conflict — the node's changes overlap changes already in the main tree", conflicts }
  }
  const apply3 = await runGit(["apply", "--3way", "--whitespace=nowarn", patchPath], { cwd: root })
  if (apply3.err) {
    // --check passed but apply failed (should not happen — same tree, sequential) — report, never guess
    return { ok: false, reason: "3-way apply failed after passing check: " + firstLine(apply3.errText), conflicts: parseApplyConflicts(apply3.errText) }
  }
  return { ok: true, applied: true, files: filesInPatch(patchPath), merged: true }
}

function parseApplyConflicts(text) {
  const files = new Set()
  for (const line of String(text).split("\n")) {
    const m = /^error:\s+(?:patch failed:\s+|could not apply\s+)?(\S+?)(?::\s|$)/.exec(line)
    if (m && m[1] && !/^(patch|could|error|fatal|usage)$/i.test(m[1])) files.add(m[1])
  }
  return [...files]
}

function filesInPatch(patchPath) {
  try {
    const text = fs.readFileSync(patchPath, "utf8")
    const files = new Set()
    for (const m of text.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) {
      if (m[2]) files.add(m[2])
    }
    // binary patches use GIT binary patch blocks but still carry the diff --git line
    return [...files]
  } catch { return [] }
}

/**
 * Remove a worktree (force — its content was either merged or deliberately
 * discarded) and prune the admin metadata. The registry entry is updated to
 * the terminal status so a removed worktree can never look live. NEVER throws.
 */
export async function removeWorktree({ root, dir, status = "removed" } = {}) {
  if (!root || !dir) return { ok: false, reason: "root and dir are required" }
  const markRegistry = (ok) => {
    try {
      const entries = readRegistry(root)
      let touched = false
      for (const e of entries) {
        if (e.dir && path.resolve(e.dir) === path.resolve(dir)) {
          e.status = ok ? status : "remove-failed"
          e.removedAt = Date.now()
          touched = true
        }
      }
      if (touched) writeRegistry(root, entries)
    } catch { }
  }
  try {
    if (!fs.existsSync(dir)) {
      await runGit(["worktree", "prune"], { cwd: root })
      markRegistry(true)
      return { ok: true, removed: true, reason: "already gone (pruned)" }
    }
    const rm = await runGit(["worktree", "remove", "--force", dir], { cwd: root })
    await runGit(["worktree", "prune"], { cwd: root })
    if (rm.err) {
      // last resort: the directory exists but git already forgot it — drop the
      // directory itself so the slot is reusable, then prune again
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { }
      await runGit(["worktree", "prune"], { cwd: root })
      if (fs.existsSync(dir)) {
        markRegistry(false)
        return { ok: false, reason: "worktree removal failed: " + firstLine(rm.errText) }
      }
    }
    markRegistry(true)
    return { ok: true, removed: true }
  } catch (e) {
    markRegistry(false)
    return { ok: false, reason: "removeWorktree threw: " + String(e?.message ?? e).slice(0, 160) }
  }
}

// --- isolated execution (child process, cwd = worktree) ----------------------

/**
 * Run one isolated node in a CHILD PROCESS whose cwd is the worktree.
 *
 * agent.js binds every subsystem to process.cwd(); a child process per node
 * is the only race-free way to give parallel agents different trees. The spec
 * is written to disk (mode 600 — it carries the provider key) OUTSIDE the
 * worktree (so it never leaks into captureChanges), and the result JSON is
 * written by the child to a sibling path, also outside the worktree.
 *
 * @returns the runAgent result shape ({ status, text, steps, ... }) — the same
 * contract the in-process runner returns, so worker settlement is unchanged.
 */
export async function runIsolatedNode({ dir, spec, forgeDir = FORGE_DIR, timeoutMs = 120_000, signal = null } = {}) {
  if (!dir || !spec) return failedResult("runIsolatedNode: dir and spec are required")
  const stamp = Date.now().toString(36)
  const specPath = path.join(path.dirname(dir), `.spec-${sanitizeId(spec.nodeId)}-${stamp}.json`)
  const resultPath = path.join(path.dirname(dir), `.result-${sanitizeId(spec.nodeId)}-${stamp}.json`)
  const full = { ...spec, dir, resultPath }
  try {
    fs.mkdirSync(path.dirname(specPath), { recursive: true })
    fs.writeFileSync(specPath, JSON.stringify(full), { mode: 0o600 })
  } catch (e) {
    return failedResult("worktree spec write failed: " + String(e?.message ?? e))
  }
  const cleanupFiles = () => { for (const f of [specPath, resultPath]) { try { fs.rmSync(f, { force: true }) } catch {} } }

  return await new Promise((resolve) => {
    const child = childSpawn(process.execPath, [path.join(forgeDir, "worknode.mjs"), specPath], {
      cwd: dir,
      env: { ...process.env, FORGE_WORKTREE_CHILD: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stderr = ""
    let settled = false
    const finish = (res) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanupFiles()
      try { signal?.removeEventListener?.("abort", onAbort) } catch {}
      resolve(res)
    }
    child.stderr?.on("data", (d) => { if (stderr.length < 8000) stderr += String(d) })
    child.on("exit", (code) => {
      if (code === 0) {
        try {
          const raw = fs.readFileSync(resultPath, "utf8")
          const res = JSON.parse(raw)
          finish(res)
        } catch (e) {
          finish(failedResult("worktree worker exited 0 but wrote no result: " + String(e?.message ?? e)))
        }
      } else {
        finish(failedResult(`worktree worker exited ${code}: ${firstLine(stderr) || "no stderr"}`))
      }
    })
    child.on("error", (e) => finish(failedResult("worktree worker spawn failed: " + String(e?.message ?? e))))
    const onAbort = () => {
      try { child.kill("SIGTERM") } catch {}
      setTimeout(() => { try { child.kill("SIGKILL") } catch {} }, 2000).unref?.()
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener?.("abort", onAbort, { once: true })
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM") } catch {}
      setTimeout(() => { try { child.kill("SIGKILL") } catch {} }, 2000).unref?.()
    }, Math.max(1000, timeoutMs))
    if (timer?.unref) timer.unref()
  })
}

function failedResult(error) {
  return {
    status: "failed", error, text: "", steps: 0,
    toolLog: [], toolRecords: [], toolStats: {},
    commandChecks: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 0, toolCalls: 0 },
    budgetHit: false, wrote: false, aborted: false,
  }
}

function firstLine(s) {
  return String(s ?? "").trim().split("\n")[0]?.slice(0, 200) ?? ""
}
