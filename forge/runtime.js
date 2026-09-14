/**
 * forge — background process manager (v93 "sensewise", §28 runtime intelligence)
 *
 * bash is a 45-second one-shot: it cannot keep a dev server alive while the
 * agent browser-tests the app it just built. This module is the missing piece
 * of §28 PROJECT RUNTIME INTELLIGENCE — launch, observe, poll, restart:
 *
 *   spawn  → /bin/sh -c <command>, detached (own process group), pipes kept
 *   poll   → the NEW stdout/stderr since the last poll (bounded), waits up to
 *            wait_ms for fresh output, returns early once output goes quiet
 *   status → pid, state, exit code, runtime, ports, byte counts
 *   kill   → signal to the whole process group (a dev server spawned a tree)
 *   list   → live processes + bounded history of dead ones
 *
 * Honesty rules (the v93 contract):
 *   - ports are DETECTED, never guessed: /proc socket tables where available
 *     (Linux) + explicit "listening on …" patterns in process output. An empty
 *     ports list means "none detected", not "none exist".
 *   - ring buffers cap memory per process; totals are reported so truncation
 *     is visible, never silent.
 *   - kill reports "signal sent" — it does not wait for the exit event, so the
 *     NEXT poll is the evidence the process actually died.
 *   - the lifetime fuse is a resource fuse, never a completion claim: state
 *     becomes "timeout-killed", never "exited 0".
 *   - every child is reaped (exit listeners) and every live child is killed
 *     when forge exits (exit handler + conditional signal handlers), because
 *     orphan processes are a §10 audit finding, not a feature.
 *
 * Zero dependencies: node:child_process + node:fs only.
 */
import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
import { resolveShell } from "./sysshell.js" // v94 knowwise: Termux-safe shell

const MAX_LIVE = 8
const MAX_OUTPUT_PER_STREAM = 256 * 1024
const MAX_HISTORY = 16
const MAX_LIFETIME_SEC = 3600
const POLL_TICK_MS = 25
const QUIET_MS = 150
const PORT_HEURISTIC_CAP = 8
const SIGNALS = ["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]

let signalHandlersInstalled = false

/** Port numbers mentioned as "listening" in free-form process output.
 *  Pure + deterministic — the cheap first line of port detection. */
export function parseListeningPorts(text) {
  const s = String(text ?? "")
  const found = new Set()
  const patterns = [
    /listen(?:ing|s)?(?:\s+(?:on|at|port|:))?\s*(?:port\s*)?(\d{2,5})\b/gi,
    /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::|\s+)(\d{2,5})\b/gi,
    /\bport\s*[:=]\s*(\d{2,5})\b/gi,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(s))) {
      const p = Number(m[1])
      if (p >= 1 && p <= 65535) found.add(p)
    }
  }
  return [...found].sort((a, b) => a - b).slice(0, PORT_HEURISTIC_CAP)
}

/** All pids in a process GROUP (pgid), including the leader. /proc-only,
 *  best-effort — unreadable or non-Linux → just the leader pid. */
function groupPids(pgid) {
  const pids = [Number(pgid)]
  if (process.platform !== "linux" || !fs.existsSync("/proc")) return pids
  try {
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue
      const pid = Number(entry)
      if (pid === pgid) continue
      try {
        // stat = "pid (comm) state ppid pgrp session …" — comm may contain
        // spaces, so parse AFTER the last ')'
        const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8")
        const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
        if (Number(rest[2]) === Number(pgid)) pids.push(pid)
      } catch { /* raced — process gone */ }
    }
  } catch { /* unreadable /proc — leader only */ }
  return pids
}

/** v94 todowise: EVIDENCE-BASED group member walk for the kill path.
 *  `kill(-pgid)` group signaling is not reliable everywhere (some hardened /
 *  non-Linux kernels refuse it); the old fallback signaled only the LEADER and
 *  orphaned grandchildren. This walk enumerates the group's members with real
 *  evidence — /proc stat first (cheap, Linux), then a bounded `ps` parse
 *  (portable) when /proc is not available. Never guesses: if neither source
 *  yields members, the result is honestly leader-only.
 *  `opts.runPs` injects the ps runner (tests); default: bounded execFileSync. */
export function parsePsMembers(text, leader) {
  const members = [Number(leader)]
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!m) continue
    const pid = Number(m[1]), grp = Number(m[2])
    if (grp === Number(leader) && pid !== Number(leader) && !members.includes(pid)) members.push(pid)
  }
  return members
}

export function groupMembersEvidence(pgid, { runPs } = {}) {
  const leader = Number(pgid)
  if (!Number.isInteger(leader) || leader <= 0) return { members: [], source: "invalid-pgid" }
  const procMembers = groupPids(leader)
  if (procMembers.length > 1) return { members: procMembers, source: "/proc" }
  if (process.platform === "linux" && fs.existsSync("/proc")) {
    // /proc WAS available and still found only the leader: the group truly has
    // no other members — no ps needed (never burn a subprocess on evidence we
    // already have).
    return { members: procMembers, source: "/proc" }
  }
  const ps = runPs ?? (() => {
    try { return execFileSync("ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }) } catch { return null }
  })
  let out = null
  try { out = ps() } catch { out = null }
  if (!out) return { members: procMembers, source: "leader-only (ps unavailable)" }
  const members = parsePsMembers(out, leader)
  return { members, source: members.length > 1 ? "ps" : "leader-only (ps found no members)" }
}

/** Signal every member of a process group, with evidence of what was actually
 *  delivered. Strategy: group signal first (one syscall); when the platform
 *  refuses it, walk the members (groupMembersEvidence) and signal each pid
 *  individually — a member that already died reports ESRCH and is counted as
 *  gone, not as failure. Returns { sent, method, delivered, gone }. */
export function signalGroup(pgid, signal, { signalFn = (pid, sig) => process.kill(pid, sig), runPs } = {}) {
  const leader = Number(pgid)
  if (!Number.isInteger(leader) || leader <= 0) return { sent: false, method: "invalid-pgid", delivered: 0, gone: 0 }
  try {
    signalFn(-leader, signal)
    return { sent: true, method: "group-signal", delivered: 0, gone: 0 }
  } catch { /* group signal refused/unavailable — evidence walk below */ }
  const ev = groupMembersEvidence(leader, { runPs })
  let delivered = 0
  let gone = 0
  for (const member of ev.members) {
    try { signalFn(member, signal); delivered++ } catch { gone++ }
  }
  return { sent: delivered > 0, method: `pid-walk(${ev.source}) — ${ev.members.length} member(s)`, delivered, gone }
}

/** Listening TCP ports actually held by a pid, read from the Linux /proc
 *  socket tables (LISTEN state) via the pid's socket inode set. Best-effort:
 *  non-Linux or unreadable /proc → [] (never a guess, never a throw). */
export function listeningPortsForPid(pid) {
  const p = Number(pid)
  if (!Number.isInteger(p) || p <= 0) return []
  if (process.platform !== "linux" || !fs.existsSync("/proc/net/tcp")) return []
  try {
    const inodes = new Set()
    for (const q of groupPids(p)) collectSocketInodes(q, inodes)
    if (!inodes.size) return []
    return portsFromProcNet(inodes)
  } catch {
    return []
  }
}

/** Listening TCP ports held by a whole process GROUP (the detached child is
 *  its leader, and `sh -c` typically forks the real server as a grandchild —
 *  the socket lives in the GRANDCHILD's fd table, so pid-only detection
 *  would miss it). Best-effort; never guesses, never throws. */
export function listeningPortsForGroup(pgid) {
  return listeningPortsForPid(pgid)
}

function collectSocketInodes(pid, into) {
  try {
    const fdDir = `/proc/${pid}/fd`
    for (const fd of fs.readdirSync(fdDir)) {
      try {
        const link = fs.readlinkSync(`${fdDir}/${fd}`)
        const m = /^socket:\[(\d+)\]$/.exec(link)
        if (m) into.add(m[1])
      } catch { /* fd closed between readdir and readlink — skip it */ }
    }
  } catch { /* process gone — skip */ }
}

function portsFromProcNet(inodes) {
  const ports = new Set()
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let txt
    try { txt = fs.readFileSync(f, "utf8") } catch { continue }
    for (const line of txt.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 12 || parts[3] !== "0A") continue // 0A = LISTEN
      if (!inodes.has(parts[9])) continue // column 9 = inode
      const hex = (parts[1] || "").split(":")[1]
      const port = parseInt(hex, 16)
      if (port > 0 && port <= 65535) ports.add(port)
    }
  }
  return [...ports].sort((a, b) => a - b).slice(0, PORT_HEURISTIC_CAP)
}

function ringPush(stream, chunk) {
  stream.total += chunk.length
  stream.buf += chunk
  stream.lastGrowth = Date.now()
  if (stream.buf.length > stream.max) {
    stream.buf = stream.buf.slice(stream.buf.length - stream.max)
    stream.truncated = true
  }
}

function snapshotStream(stream, from, maxChars) {
  const delta = stream.buf.length > from ? stream.buf.slice(from) : ""
  return {
    text: delta.length > maxChars ? delta.slice(delta.length - maxChars) : delta,
    newBytes: delta.length,
    totalBytes: stream.total,
    truncated: stream.truncated,
  }
}

/**
 * Build a process manager. opts:
 *   maxLive            — concurrent live process cap (default 8)
 *   maxOutputPerStream — ring buffer bytes per stream (default 256 KB)
 *   maxHistory         — dead entries kept (default 16)
 *   maxLifetimeSec     — auto-kill fuse when spawned without an explicit
 *                        timeout (default 3600; a resource fuse, never a
 *                        completion claim — the state stays "timeout-killed")
 *   installSignalHandlers — default true; tests pass false to keep the global
 *                        signal table untouched.
 */
export function createProcessManager({
  maxLive = MAX_LIVE,
  maxOutputPerStream = MAX_OUTPUT_PER_STREAM,
  maxHistory = MAX_HISTORY,
  maxLifetimeSec = MAX_LIFETIME_SEC,
  installSignalHandlers = true,
  signalFn = (pid, sig) => process.kill(pid, sig), // tests simulate platforms without kill(-pgid)
} = {}) {
  /** id → entry: { id, command, child, state, exitCode, signal, timedOut,
   *  startedAt, endedAt, out, err, outCursor, errCursor, portsSeen,
   *  lifetimeTimer }. state: running | exited | killed | timeout-killed | failed */
  const entries = new Map()
  let autoId = 0
  let disposed = false

  const killTree = (e, signal) => {
    if (e.state !== "running" || !e.child) return { sent: false, method: "not-running", delivered: 0, gone: 0 }
    const r = signalGroup(e.child.pid, signal, { signalFn })
    e.killEvidence = { signal, method: r.method, delivered: r.delivered, gone: r.gone, at: Date.now() }
    return r
  }

  const reap = () => {
    const dead = [...entries.values()].filter((x) => x.state !== "running")
    if (dead.length > maxHistory) {
      dead.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
      for (const d of dead.slice(0, dead.length - maxHistory)) entries.delete(d.id)
    }
  }

  const portsOf = (e) => {
    // /proc lookup only works while the process lives; the output-text
    // heuristic works for both live AND already-exited processes (a server
    // that printed "listening on 3000" then died still leaves the evidence).
    if (e.state === "running") {
      let live = []
      try { live = listeningPortsForPid(e.child?.pid) } catch { live = [] }
      for (const p of live) e.portsSeen.add(p)
    }
    for (const p of parseListeningPorts(e.out.buf)) e.portsSeen.add(p)
    return [...e.portsSeen].sort((a, b) => a - b).slice(0, PORT_HEURISTIC_CAP)
  }

  const entryView = (e) => ({
    id: e.id,
    command: e.command.length > 120 ? e.command.slice(0, 117) + "…" : e.command,
    state: e.state,
    pid: e.state === "running" ? e.child?.pid ?? null : null,
    exitCode: e.exitCode,
    signal: e.signal ?? null,
    timedOut: e.timedOut === true,
    startedAt: e.startedAt,
    runtimeSec: Math.round(((e.state === "running" ? Date.now() : e.endedAt ?? Date.now()) - e.startedAt) / 100) / 10,
    ports: portsOf(e),
    stdoutBytes: e.out.total,
    stderrBytes: e.err.total,
    outputTruncated: e.out.truncated || e.err.truncated,
  })

  const pollResult = (e, maxChars) => {
    const out = snapshotStream(e.out, e.outCursor, maxChars)
    const err = snapshotStream(e.err, e.errCursor, maxChars)
    e.outCursor = e.out.buf.length
    e.errCursor = e.err.buf.length
    return {
      ok: true,
      entry: entryView(e),
      out: out.text,
      outNewBytes: out.newBytes,
      err: err.text,
      errNewBytes: err.newBytes,
      totalBytes: out.totalBytes + err.totalBytes,
      truncated: out.truncated || err.truncated,
    }
  }

  const onExitHandler = () => {
    // hard exit path — no time for graceful SIGTERM: SIGKILL the groups
    for (const e of entries.values()) {
      if (e.state === "running" && e.child) killTree(e, "SIGKILL")
    }
  }

  const mySigHandlers = []
  process.once("exit", onExitHandler)
  if (installSignalHandlers && !signalHandlersInstalled) {
    signalHandlersInstalled = true
    for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
      if (process.listenerCount(sig) > 0) continue // forge already owns this signal
      const h = () => {
        for (const e of entries.values()) killTree(e, "SIGKILL")
        process.exit(code)
      }
      process.once(sig, h)
      mySigHandlers.push([sig, h])
    }
  }

  const validName = (n) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(String(n ?? ""))

  const api = {
    spawn({ command, name, cwd, timeoutSec } = {}) {
      const cmd = String(command ?? "")
      if (!cmd.trim()) return { ok: false, error: "ERROR: process spawn requires a non-empty command" }
      if (cmd.length > 4000) return { ok: false, error: "ERROR: process spawn command too long (> 4000 chars)" }
      if (disposed) return { ok: false, error: "ERROR: process manager is disposed" }
      const live = [...entries.values()].filter((e) => e.state === "running")
      if (live.length >= maxLive) {
        return { ok: false, error: `ERROR: process limit reached (${maxLive} live) — kill one first: ${live.map((e) => e.id).join(", ")}` }
      }
      const id = validName(name) ? String(name) : `p${++autoId}`
      const existing = entries.get(id)
      if (existing && existing.state === "running") {
        return { ok: false, error: `ERROR: process id "${id}" is already running (kill it or pick another name)` }
      }
      let child
      try {
        child = spawn(resolveShell(), ["-c", cmd], {
          cwd: cwd ? String(cwd) : undefined,
          detached: true, // own group: kill(-pid) takes the whole tree
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, TERM: "dumb" },
        })
      } catch (e) {
        return { ok: false, error: `ERROR: spawn failed: ${String(e?.message ?? e).slice(0, 200)}` }
      }
      const mkStream = () => ({ buf: "", total: 0, truncated: false, max: maxOutputPerStream, lastGrowth: 0 })
      const e = {
        id, command: cmd, child, state: "running", exitCode: null, signal: null, timedOut: false,
        startedAt: Date.now(), endedAt: null,
        out: mkStream(), err: mkStream(), outCursor: 0, errCursor: 0,
        portsSeen: new Set(), lifetimeTimer: null,
      }
      entries.set(id, e)
      child.stdout.on("data", (c) => ringPush(e.out, c.toString()))
      child.stderr.on("data", (c) => ringPush(e.err, c.toString()))
      child.on("error", (err) => {
        // spawn-level failure after the fact (shell gone, group killed, …)
        if (e.lifetimeTimer) clearTimeout(e.lifetimeTimer)
        e.state = "failed"
        e.endedAt = Date.now()
        e.signal = err?.code ?? String(err?.message ?? err).slice(0, 80)
        reap()
      })
      child.on("exit", (code, sig) => {
        if (e.lifetimeTimer) clearTimeout(e.lifetimeTimer)
        e.exitCode = typeof code === "number" ? code : null
        e.signal = sig ?? null
        e.state = e.timedOut ? "timeout-killed" : sig ? "killed" : "exited"
        e.endedAt = Date.now()
        reap()
      })
      const fuseSec = Number.isFinite(Number(timeoutSec)) && Number(timeoutSec) > 0
        ? Math.min(Number(timeoutSec), 86400)
        : maxLifetimeSec
      e.lifetimeTimer = setTimeout(() => {
        if (e.state === "running") {
          e.timedOut = true
          killTree(e, "SIGTERM")
          setTimeout(() => { if (e.state === "running") killTree(e, "SIGKILL") }, 2000).unref?.()
        }
      }, fuseSec * 1000)
      e.lifetimeTimer.unref?.()
      return { ok: true, entry: entryView(e) }
    },

    /** New output since the last poll. Resolves early once fresh output has
     *  been quiet for QUIET_MS; otherwise waits out waitMs (≤ 10 s). A dead
     *  process resolves immediately (its exit info is the evidence). */
    poll(id, { waitMs = 800, maxChars = 4000 } = {}) {
      const e = entries.get(String(id ?? ""))
      if (!e) return { ok: false, error: `ERROR: no process "${id}" — call process list first` }
      const deadline = Date.now() + Math.min(Math.max(1, Number(waitMs) || 800), 10000)
      const baseline = e.out.buf.length + e.err.buf.length
      return new Promise((resolve) => {
        const tick = () => {
          if (e.state !== "running") return resolve(pollResult(e, maxChars))
          const grew = e.out.buf.length + e.err.buf.length > baseline
          const lastGrowth = Math.max(e.out.lastGrowth, e.err.lastGrowth)
          if (grew && lastGrowth && Date.now() - lastGrowth >= QUIET_MS) return resolve(pollResult(e, maxChars))
          if (Date.now() >= deadline) return resolve(pollResult(e, maxChars))
          setTimeout(tick, POLL_TICK_MS)
        }
        tick()
      })
    },

    status(id) {
      const e = entries.get(String(id ?? ""))
      if (!e) return { ok: false, error: `ERROR: no process "${id}"` }
      return { ok: true, entry: entryView(e) }
    },

    kill(id, signal = "SIGTERM") {
      const e = entries.get(String(id ?? ""))
      if (!e) return { ok: false, error: `ERROR: no process "${id}"` }
      const sig = SIGNALS.includes(signal) ? signal : "SIGTERM"
      if (e.state !== "running") return { ok: true, entry: entryView(e), note: `already ${e.state} (exit ${e.exitCode ?? "?"})` }
      const r = killTree(e, sig)
      return {
        ok: true, entry: entryView(e),
        note: r.sent
          ? `${sig} sent to the process group${r.method && r.method !== "group-signal" ? ` via ${r.method}` : ""} — poll for the actual exit (evidence, not assumption)`
          : "process group already gone",
      }
    },

    list() {
      const view = [...entries.values()].map(entryView)
      view.sort((a, b) => b.startedAt - a.startedAt)
      return { ok: true, live: view.filter((v) => v.state === "running"), history: view.filter((v) => v.state !== "running").slice(0, maxHistory) }
    },

    /** Kill everything and remove global handlers. Idempotent. */
    dispose() {
      if (disposed) return
      disposed = true
      for (const e of entries.values()) {
        if (e.lifetimeTimer) clearTimeout(e.lifetimeTimer)
        if (e.state === "running") {
          killTree(e, "SIGTERM")
          setTimeout(() => { if (e.state === "running") killTree(e, "SIGKILL") }, 300).unref?.()
        }
      }
      try { process.removeListener("exit", onExitHandler) } catch {}
      for (const [sig, h] of mySigHandlers) { try { process.removeListener(sig, h) } catch {} }
      if (mySigHandlers.length) signalHandlersInstalled = false
    },

    // test affordances — never used by the tool layer
    _size: () => entries.size,
    _liveCount: () => [...entries.values()].filter((e) => e.state === "running").length,
    _entry: (id) => entries.get(String(id ?? "")),
  }
  return api
}
