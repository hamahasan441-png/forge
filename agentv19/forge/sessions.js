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
 */
import fs from "node:fs"
import path from "node:path"
import { SESSIONS_DIR } from "./config.js"

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
    fs.mkdirSync(SESSIONS_DIR, { recursive: true })
    const sid = id || sessionId()
    const file = path.join(SESSIONS_DIR, sid + ".json")
    // preserve createdAt/title when overwriting (persist() passes the same id)
    let prev = null
    try { prev = JSON.parse(fs.readFileSync(file, "utf8")) } catch {}
    const firstUser = (messages || []).find((m) => m.role === "user" && typeof m.content === "string" && !String(m.content).startsWith("AUTO-COMPACTED"))
    const derivedTitle = title ?? prev?.title ?? (firstUser ? String(firstUser.content).replace(/\s+/g, " ").slice(0, 60) : null)
    fs.writeFileSync(file, JSON.stringify({
      id: sid,
      createdAt: prev?.createdAt ?? Date.now(),
      ts: Date.now(),
      updatedAt: Date.now(),
      provider,
      model,
      usage: usage ?? prev?.usage ?? null,
      cwd: cwd ?? prev?.cwd ?? null,
      title: derivedTitle,
      summary: summary ?? prev?.summary ?? null,
      messages,
    }, null, 1), { mode: 0o600 })
    fs.chmodSync(file, 0o600)
    fs.writeFileSync(path.join(SESSIONS_DIR, "last.json"), JSON.stringify({ id: sid, file }), { mode: 0o600 })
    fs.chmodSync(path.join(SESSIONS_DIR, "last.json"), 0o600)
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

/** Delete all but the newest `max` sessions. Returns count removed. Best-effort. */
export function pruneSessions(max = MAX_SESSIONS) {
  try {
    const files = sessionFiles() // newest-first
    if (files.length <= max) return 0
    let removed = 0
    for (const f of files.slice(max)) {
      try { fs.rmSync(f, { force: true }); removed++ } catch {}
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

export function lastSessionFile() {
  try {
    const p = path.join(SESSIONS_DIR, "last.json")
    const j = JSON.parse(fs.readFileSync(p, "utf8"))
    return j.file
  } catch {
    return null
  }
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
      .readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".json") && f !== "last.json")
      .map((f) => {
        const full = path.join(SESSIONS_DIR, f)
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
  const direct = path.resolve(SESSIONS_DIR, r.endsWith(".json") ? r : r + ".json")
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
