/**
 * forge — persistent Node REPL sessions (v93 "sensewise")
 *
 * bash is stateless: every call re-spawns a shell, so iterative data analysis
 * re-loads the data, re-imports, re-computes — ten times over. This module
 * keeps REAL `node -i` child processes alive across calls: variables,
 * imports and loaded data survive. It is the real Node REPL, so semantics
 * are the battle-tested ones — top-level await (Node 22+ by default, older
 * via --experimental-repl-await), let/const persistence, multiline input.
 *
 * Wire protocol (verified against Node 20–24, piped stdin):
 *   - the REPL prints "> " when ready for input, "| " while accumulating an
 *     incomplete multiline input
 *   - evaluation output (completion value, console.log, thrown errors) is
 *     written to stdout, followed by the next "> "
 *   - ".break" aborts an incomplete multiline state and returns to "> "
 *   - ".exit" terminates the session
 *
 * Honesty rules:
 *   - a timeout reports "still running" — it NEVER fabricates a result; the
 *     session stays busy until the evaluation finishes or is killed
 *   - an incomplete input is reset with .break and reported as an error
 *   - a dead session is transparently restarted on the next run, and the
 *     restart is REPORTED, not hidden
 *   - output is capped with a visible truncation marker
 *
 * Zero dependencies: node:child_process only.
 */
import { execFileSync, spawn } from "node:child_process"

const DEFAULT_TIMEOUT_MS = 15000
const MAX_TIMEOUT_MS = 60000
const STARTUP_TIMEOUT_MS = 10000
const TICK_MS = 20
const QUIET_MS = 250 // how long the continuation prompt must be stable to declare "incomplete"
// Node's non-TTY REPL emits "... " (dot-dot-dot-space) as the continuation
// prompt while it accumulates an incomplete multiline statement — NOT "| ".
// The "| " matcher this replaced never matched any Node version, so incomplete
// input was misread as a timeout and the .break recovery never fired. "| " is
// kept as a defensive fallback in case a wrapped runtime ever uses it.
const CONT_PROMPTS = ["... ", "| "]
const tailIsCont = (buf) => CONT_PROMPTS.some((p) => buf.endsWith(p))
const MAX_OUTPUT_BYTES = 65536
const MAX_SESSIONS = 2

let _nodeMajor = null
/** Node major version of the REPL binary (cached; 0 on detection failure). */
function nodeMajorOf(nodeBin) {
  if (_nodeMajor !== null) return _nodeMajor
  try {
    const out = execFileSync(nodeBin, ["-e", "process.stdout.write(String(Number(process.versions.node.split('.')[0])))"], { timeout: 5000 }).toString().trim()
    _nodeMajor = Number(out) || 0
  } catch {
    _nodeMajor = 0
  }
  return _nodeMajor
}

const PROMPT_LINE = /^> $/
const PROMPT_PREFIX = /^(?:> |\| )+/
const BANNER = [/^Welcome to Node\.js/, /^Type "\.help"/]

/** Strip REPL prompt noise from raw stdout: leading "> "/"/| " runs per line,
 *  pure-prompt lines, and the Node welcome banner. Pure + deterministic. */
export function stripReplPrompts(text) {
  const lines = String(text ?? "").split("\n")
  const out = []
  for (let raw of lines) {
    if (PROMPT_LINE.test(raw)) continue
    if (BANNER.some((re) => re.test(raw))) continue
    raw = raw.replace(PROMPT_PREFIX, "")
    if (/^(?:\| )+$/.test(raw)) continue
    out.push(raw)
  }
  // the trailing ready prompt never belongs to the result
  while (out.length && out[out.length - 1] === "") out.pop()
  return out.join("\n")
}

const validSessionName = (n) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(String(n ?? ""))

/**
 * Build a REPL manager. opts:
 *   nodeBin        — the node binary for the REPL children (default: this process)
 *   maxSessions    — concurrent session cap (default 2)
 *   timeoutMs      — default per-run evaluation timeout (default 15 s, ≤ 60 s)
 *   maxOutputBytes — per-run output cap (default 64 KB)
 *   installSignalHandlers — default true; tests pass false.
 */
export function createReplManager({
  nodeBin = process.execPath,
  maxSessions = MAX_SESSIONS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  installSignalHandlers = true,
} = {}) {
  /** name → session: { name, child, buf, errBuf, state, busy, startedAt,
   *  calls, restarted, lastError } — state: ready | busy | dead */
  const sessions = new Map()
  let disposed = false

  const onExitHandler = () => {
    for (const s of sessions.values()) {
      if (s.child) { try { s.child.kill("SIGKILL") } catch {} }
    }
  }
  const mySigHandlers = []
  process.once("exit", onExitHandler)
  if (installSignalHandlers) {
    for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
      if (process.listenerCount(sig) > 0) continue // forge already owns this signal
      const h = () => {
        for (const s of sessions.values()) { if (s.child) { try { s.child.kill("SIGKILL") } catch {} } }
        process.exit(code)
      }
      process.once(sig, h)
      mySigHandlers.push([sig, h])
    }
  }

  const createSession = (name) => {
    const major = nodeMajorOf(nodeBin)
    const args = major && major < 22 ? ["--experimental-repl-await", "-i"] : ["-i"]
    const child = spawn(nodeBin, args, { stdio: ["pipe", "pipe", "pipe"] })
    const s = {
      name, child, buf: "", errBuf: "", state: "busy" /* busy until the first prompt */,
      busy: false, startedAt: Date.now(), calls: 0, restarted: false, lastError: null,
    }
    child.stdout.on("data", (c) => { s.buf += c.toString(); s.lastLenAt = Date.now() })
    child.stderr.on("data", (c) => { s.errBuf += c.toString() })
    child.on("exit", () => { s.state = "dead" })
    child.on("error", () => { s.state = "dead" })
    sessions.set(name, s)
    return s
  }

  const tailIs = (s, suffix) => s.buf.endsWith(suffix)

  const waitFor = (s, predicate, deadlineMs) =>
    new Promise((resolve) => {
      const deadline = Date.now() + deadlineMs
      const tick = () => {
        if (predicate(s)) return resolve(true)
        if (s.state === "dead" || Date.now() >= deadline) return resolve(false)
        setTimeout(tick, TICK_MS)
      }
      tick()
    })

  const sessionView = (s) => ({
    name: s.name,
    state: s.state === "dead" ? "dead" : s.busy ? "busy" : "ready",
    pid: s.child?.pid ?? null,
    startedAt: s.startedAt,
    calls: s.calls,
    restarted: s.restarted,
    lastError: s.lastError,
  })

  const capOutput = (text) => {
    if (text.length <= maxOutputBytes) return { text, truncated: false }
    return { text: text.slice(text.length - maxOutputBytes) + "\n… (output truncated)", truncated: true }
  }

  const api = {
    /** Evaluate code in a (lazily created) session. State persists across
     *  calls. Returns { ok, output, error?, restarted?, note? }. */
    async run(sessionName = "main", code, { timeoutMs: tmo } = {}) {
      if (disposed) return { ok: false, error: "ERROR: repl manager is disposed" }
      const codeStr = String(code ?? "")
      if (!codeStr.trim()) return { ok: false, error: "ERROR: repl run requires non-empty code" }
      const name = validSessionName(sessionName) ? String(sessionName) : "main"

      // session cap only counts live sessions; dead ones are transparently replaced
      const liveCount = [...sessions.values()].filter((s) => s.state !== "dead").length
      let s = sessions.get(name)
      if (s && s.state === "dead") { sessions.delete(name); s = undefined }
      if (!s && liveCount >= maxSessions) {
        const live = [...sessions.values()].filter((x) => x.state !== "dead").map((x) => x.name)
        return { ok: false, error: `ERROR: repl session limit reached (${maxSessions}) — kill one first: ${live.join(", ")}` }
      }
      let restarted = false
      if (!s) { s = createSession(name); restarted = true }

      // first use (or restart): wait for the banner + first ready prompt
      if (s.state === "busy" && !s.busy && s.calls === 0) {
        const up = await waitFor(s, (x) => tailIs(x, "> "), STARTUP_TIMEOUT_MS)
        if (!up) {
          s.lastError = "REPL did not become ready within 10s"
          return { ok: false, error: `ERROR: ${s.lastError}` }
        }
        s.state = "ready"
      }

      // a previous timed-out evaluation may have finished by now — recover it
      if (s.busy) {
        if (tailIs(s, "> ")) { s.busy = false; s.buf = "" } // late completion — drain silently
        else {
          return {
            ok: false,
            error: `ERROR: repl session "${name}" is still evaluating (a previous call timed out) — wait, or kill it to reset`,
            session: sessionView(s),
          }
        }
      }

      s.buf = ""
      s.errBuf = ""
      s.busy = true
      s.state = "busy"
      s.calls++
      try { s.child.stdin.write(codeStr + "\n") } catch (e) {
        s.busy = false
        s.state = "dead"
        return { ok: false, error: `ERROR: could not write to the REPL: ${String(e?.message ?? e).slice(0, 120)}` }
      }

      const budget = Math.min(Math.max(1000, Number(tmo) || timeoutMs), MAX_TIMEOUT_MS)
      // done = ready prompt ("> "), or an incomplete state ("| ") whose buffer
      // has been quiet for QUIET_MS, or the budget/death runs out
      await waitFor(
        s,
        (x) => tailIs(x, "> ") || (tailIsCont(x.buf) && Date.now() - (x.lastLenAt ?? Date.now()) >= QUIET_MS),
        budget,
      )
      // distinguish: ready ("> "), incomplete ("| "), dead, timeout
      if (tailIs(s, "> ")) {
        s.busy = false
        s.state = "ready"
        const raw = s.buf
        s.buf = ""
        const errRaw = s.errBuf
        s.errBuf = ""
        let text = stripReplPrompts(raw)
        if (errRaw.trim()) text += (text ? "\n" : "") + `stderr: ${errRaw.trim().slice(0, 2000)}`
        const capped = capOutput(text)
        return { ok: true, output: capped.text, truncated: capped.truncated, session: sessionView(s), ...(restarted ? { note: "session started fresh for this call" } : {}) }
      }

      if (tailIsCont(s.buf)) {
        // incomplete multiline input — reset the REPL with its own .break command
        try { s.child.stdin.write(".break\n") } catch {}
        await waitFor(s, (x) => tailIs(x, "> "), 2000)
        s.buf = ""
        s.errBuf = ""
        s.busy = false
        s.state = "ready"
        s.lastError = "incomplete JavaScript input (the multiline state was reset with .break)"
        return {
          ok: false,
          error: "ERROR: incomplete JavaScript input — send complete statements in ONE call (the multiline state was reset)",
          session: sessionView(s),
        }
      }

      // timeout or death — never fabricate a result
      if (s.state === "dead") {
        s.lastError = "the REPL process exited during evaluation"
        return { ok: false, error: `ERROR: the REPL process exited during evaluation — the session restarts on the next call`, session: sessionView(s) }
      }
      s.lastError = `evaluation exceeded ${budget}ms (still running)`
      return {
        ok: false,
        error: `ERROR: repl evaluation exceeded ${budget}ms and is still running — the session stays busy; wait and retry, or kill "${name}" to reset`,
        session: sessionView(s),
      }
    },

    status(sessionName) {
      if (sessionName !== undefined) {
        const s = sessions.get(String(sessionName ?? ""))
        if (!s) return { ok: false, error: `ERROR: no repl session "${sessionName}"` }
        return { ok: true, session: sessionView(s) }
      }
      return { ok: true, sessions: [...sessions.values()].map(sessionView) }
    },

    kill(sessionName = "main") {
      const s = sessions.get(String(sessionName ?? ""))
      if (!s) return { ok: false, error: `ERROR: no repl session "${sessionName}"` }
      try { s.child.kill("SIGTERM") } catch {}
      sessions.delete(String(sessionName))
      return { ok: true, note: `repl session "${sessionName}" killed — the next run starts fresh` }
    },

    list() {
      return { ok: true, sessions: [...sessions.values()].map(sessionView) }
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const s of sessions.values()) { if (s.child) { try { s.child.kill("SIGKILL") } catch {} } }
      sessions.clear()
      try { process.removeListener("exit", onExitHandler) } catch {}
      for (const [sig, h] of mySigHandlers) { try { process.removeListener(sig, h) } catch {} }
    },

    _sessions: () => sessions,
  }
  return api
}
