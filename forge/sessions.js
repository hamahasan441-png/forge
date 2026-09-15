/**
 * forge — sessions (save/resume conversations, zero dependencies)
 *
 * ~/.forge/sessions/<id>.json — { id, ts, provider, model, messages, cwd,
 *                                 title, summary, usage }
 * last.json points at the most recent session for `forge chat --continue`.
 * Files are chmod 600 (sessions may contain sensitive content).
 *
 * v20: sessions are a real task-state record, not just a message list —
 *   - `cwd` (restored on resume), `title` (first user message), rolling
 *     `summary` (written whenever compaction happens — resume shows what the
 *     conversation was about), usage totals, updatedAt.
 *   - `forge resume <n|id>` + `forge chat --resume <n|id>`.
 *   - listing is ordered by timestamp (not by filename).
 *
 * v97 unifiedwise (§5-§8): ChatGPT-like continuity —
 *   - RAW CONVERSATION MEMORY: <id>.transcript.jsonl keeps EVERY user/assistant
 *     turn as its own record { ts, role, content, sessionId, projectId, taskId,
 *     classes } — compaction folds the working context but NEVER destroys the
 *     raw history anymore (the session .json keeps the compacted view).
 *   - per-directory lookup: sessionsForCwd(cwd) → the sessions that belong to
 *     this project, so startup can rehydrate automatically (§6) instead of
 *     requiring --continue.
 *   - projectId (path hash) recorded per session for cross-store joins.
 */
import fs from "node:fs"
import { writeStateFile } from "./securefs.js"
import path from "node:path"
import { SESSIONS_DIR as _SESSIONS_DIR_IMPORT, DEFAULT_DIR } from "./config.js"
import { projectHash } from "./memory.js"
import { projectRoot } from "./projectkey.js"

const SESSIONS_DIR = _SESSIONS_DIR_IMPORT // rebindable via withSessionsDir (test seam)
const TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024 // per-conversation raw history cap (trim-oldest, never silent)

function sessionId() {
  return new Date().toISOString().replace(/[:.]/g, "-") + "-" + Math.random().toString(36).slice(2, 6)
}

/**
 * Save a conversation. Pass a known `id` to overwrite that session file
 * (auto-save after every turn keeps ONE file per conversation, not thousands).
 * v16: optional `usage` ({prompt, completion, requests}) is persisted too.
 * v20: cwd/title/summary round out the task-state record.
 */
export function saveSession({ provider, model, messages, id, usage, cwd, title, summary }) {
  try {
    fs.mkdirSync(sessionStore(), { recursive: true })
    const sid = id || sessionId()
    const file = path.join(sessionStore(), sid + ".json")
    // preserve createdAt/title when overwriting (persist() passes the same id)
    let prev = null
    try { prev = JSON.parse(fs.readFileSync(file, "utf8")) } catch {}
    const firstUser = (messages || []).find((m) => m.role === "user" && typeof m.content === "string" && !String(m.content).startsWith("AUTO-COMPACTED"))
    const derivedTitle = title ?? prev?.title ?? (firstUser ? String(firstUser.content).replace(/\s+/g, " ").slice(0, 60) : null)
    writeStateFile(file, JSON.stringify({
      id: sid,
      createdAt: prev?.createdAt ?? Date.now(),
      ts: Date.now(),
      updatedAt: Date.now(),
      provider,
      model,
      usage: usage ?? prev?.usage ?? null,
      cwd: cwd ?? prev?.cwd ?? null,
      projectId: cwd ? projectHash(cwd) : (prev?.projectId ?? null), // v97 §3: cross-store join key
      title: derivedTitle,
      summary: summary ?? prev?.summary ?? null,
      messages,
    }, null, 1))
    writeStateFile(path.join(sessionStore(), "last.json"), JSON.stringify({ id: sid, file }))
    // v20.2 (P1-6): cap the store when a NEW conversation is created (not on
    // every auto-save of an existing one, which reuses its id)
    if (!id) pruneSessions()
    return file
  } catch {
    return null
  }
}

// v20.2 (P1-6): the session store grew without bound. Keep the newest N.
export const MAX_SESSIONS = 300

/** Delete all but the newest `max` sessions. Returns count removed. Best-effort.
 *  v97 audit A22: a session's RAW TRANSCRIPT (.transcript.jsonl) is removed
 *  together with its session file — pruning must never orphan transcripts. */
export function pruneSessions(max = MAX_SESSIONS) {
  try {
    const files = sessionFiles() // newest-first
    if (files.length <= max) return 0
    let removed = 0
    for (const f of files.slice(max)) {
      try {
        fs.rmSync(f, { force: true })
        try { fs.rmSync(transcriptPath(path.basename(f, ".json")), { force: true }) } catch { }
        removed++
      } catch {}
    }
    return removed
  } catch {
    return 0
  }
}

/**
 * Search sessions by substring (case-insensitive) across title, summary and
 * message text. Returns list-shaped entries (newest-first) with a matching
 * `snippet`. Bounded: scans at most `scan` files, returns at most `max`.
 */
export function searchSessions(query, { max = 20, scan = 600 } = {}) {
  const q = String(query ?? "").trim().toLowerCase()
  if (!q) return []
  const out = []
  for (const file of sessionFiles().slice(0, scan)) {
    if (out.length >= max) break
    let j
    try { j = JSON.parse(fs.readFileSync(file, "utf8")) } catch { continue }
    const hay = []
    if (j.title) hay.push(String(j.title))
    if (j.summary) hay.push(String(j.summary))
    for (const m of j.messages ?? []) if (typeof m.content === "string") hay.push(m.content)
    const joined = hay.join("\n")
    const at = joined.toLowerCase().indexOf(q)
    if (at === -1) continue
    const snippet = joined.slice(Math.max(0, at - 30), at + q.length + 40).replace(/\s+/g, " ").trim()
    out.push({
      file,
      id: j.id ?? path.basename(file, ".json"),
      ts: j.updatedAt ?? j.ts ?? 0,
      provider: j.provider,
      model: j.model,
      turns: Math.floor((j.messages?.length ?? 0) / 2),
      title: j.title ?? null,
      snippet,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// v97 unifiedwise (§5-§7): RAW CONVERSATION MEMORY + per-directory lookup
// ---------------------------------------------------------------------------

export function transcriptPath(id) {
  return path.join(sessionStore(), String(id).replace(/[^A-Za-z0-9._-]/g, "_") + ".transcript.jsonl")
}

/** Append ONE raw turn to the non-destructive transcript (§7). Every record
 *  carries ts/role/content/sessionId/projectId (+ taskId/classes when known)
 *  so compaction can never make history un-reconstructable. Best-effort,
 *  never throws; bounded per conversation (trim-oldest-half on overflow). */
export function appendTranscript({ sessionId: sid, projectId = null, taskId = null, role, content, classes = null }) {
  if (!sid || !role) return false
  const r = String(role)
  if (r !== "user" && r !== "assistant") return true // tool/system rounds stay in the working file
  const text = typeof content === "string" ? content : ""
  if (!text.trim()) return true
  const rec = {
    ts: Date.now(), role: r,
    content: text.slice(0, 24000),
    sessionId: sid, projectId, taskId,
    ...(classes?.length ? { classes } : {}),
  }
  try {
    fs.mkdirSync(sessionStore(), { recursive: true })
    const p = transcriptPath(sid)
    fs.appendFileSync(p, JSON.stringify(rec) + "\n")
    try {
      const st = fs.statSync(p)
      if (st.size > TRANSCRIPT_MAX_BYTES) {
        const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean)
        fs.writeFileSync(p, lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n")
      }
    } catch { }
    return true
  } catch { return false }
}

/** Read the raw transcript (newest-last). Bounded scan. */
export function readTranscript(id, { limit = 400 } = {}) {
  try {
    const lines = fs.readFileSync(transcriptPath(id), "utf8").split("\n").filter(Boolean)
    const out = []
    for (const l of lines.slice(-limit)) {
      try { out.push(JSON.parse(l)) } catch { }
    }
    return out
  } catch { return [] }
}

/** Sessions whose recorded cwd matches this directory (§6 auto-rehydration).
 *  Newest-first, bounded scan of the store. */
export function sessionsForCwd(cwd, { max = 5, scan = 300 } = {}) {
  // v108 rootwise: a session belongs to a PROJECT, not to the exact directory
  // it was started in. Comparing absolute paths made `cd src` hide every
  // session recorded at the repository root (reproduced: latestSessionForCwd
  // returned null from a subdirectory of the very repo it had just worked in).
  const target = projectRoot(cwd)
  const out = []
  for (const file of sessionFiles().slice(0, scan)) {
    if (out.length >= max) break
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"))
      if (j?.cwd && projectRoot(j.cwd) === target) out.push(j)
    } catch { }
  }
  return out
}

/** The most recent session for a directory, or null. */
export function latestSessionForCwd(cwd) {
  return sessionsForCwd(cwd, { max: 1 })[0] ?? null
}

/** Session-id → session-file path (safely namespaced). */
export function projectSessionFile(id) {
  return path.join(sessionStore(), String(id).replace(/[^A-Za-z0-9._-]/g, "_") + ".json")
}

export function lastSessionFile() {
  try {
    const p = path.join(sessionStore(), "last.json")
    const j = JSON.parse(fs.readFileSync(p, "utf8"))
    return j.file
  } catch {
    return null
  }
}

/** Test/bench seam: point the session store at a scratch directory
 *  (FORGE-BENCH case 19 exercises the save→lookup→transcript round-trip
 *  WITHOUT touching the real store). Pair with clearSessionStoreOverride()
 *  in a finally block. */
export function setSessionStoreOverride(dir) {
  SESSIONS_DIR_OVERRIDE = dir
}

export function clearSessionStoreOverride() {
  SESSIONS_DIR_OVERRIDE = null
}

let SESSIONS_DIR_OVERRIDE = null
function sessionStore() {
  return SESSIONS_DIR_OVERRIDE ?? SESSIONS_DIR
}

export function loadSession(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"))
    if (Array.isArray(j.messages)) return j
    return null
  } catch {
    return null
  }
}

/** All session files, newest-first by mtime (robust against clock skew). */
function sessionFiles() {
  try {
    return fs
      .readdirSync(sessionStore())
      .filter((f) => f.endsWith(".json") && f !== "last.json")
      .map((f) => {
        const full = path.join(sessionStore(), f)
        try { return { full, mt: fs.statSync(full).mtimeMs } } catch { return null }
      })
      .filter(Boolean)
      // Newest first. mtime ties are possible on coarse-granularity filesystems,
      // and pruneSessions() DELETES by this order — an undefined order could drop
      // a newer session. Session ids are ISO-timestamp prefixed, so a descending
      // filename tie-break is both deterministic and recency-correct.
      .sort((a, b) => b.mt - a.mt || path.basename(b.full).localeCompare(path.basename(a.full)))
      .map((e) => e.full)
  } catch {
    return []
  }
}

/** Resolve a user-supplied reference (number in the list, session id, or
 *  file path) to a session file. Used by `forge resume` and /resume. */
export function findSession(ref, { listMax = 30 } = {}) {
  if (!ref) return lastSessionFile()
  const r = String(ref).trim()
  if (/^\d+$/.test(r)) {
    const n = Number(r)
    const listed = listSessions(listMax)
    const hit = listed[n - 1]
    return hit ? hit.file : null
  }
  // session id (with or without .json) or a direct path
  const direct = path.resolve(sessionStore(), r.endsWith(".json") ? r : r + ".json")
  if (fs.existsSync(direct)) return direct
  if (fs.existsSync(r)) return path.resolve(r)
  // fall back to unique id prefix match
  const matches = sessionFiles().filter((f) => path.basename(f, ".json").startsWith(r))
  return matches.length === 1 ? matches[0] : null
}

export function listSessions(max = 10) {
  return sessionFiles()
    .slice(0, max)
    .map((file) => {
      try {
        const j = JSON.parse(fs.readFileSync(file, "utf8"))
        return {
          file,
          id: j.id ?? path.basename(file, ".json"),
          ts: j.updatedAt ?? j.ts ?? 0,
          provider: j.provider,
          model: j.model,
          turns: Math.floor((j.messages?.length ?? 0) / 2),
          title: j.title ?? null,
          summary: j.summary ?? null,
          cwd: j.cwd ?? null,
        }
      } catch {
        return null
      }
    })
    .filter(Boolean)
}
