/**
 * forge — phase tracing (v101, zero dependencies)
 *
 * telemetry.js counts WHAT happened. Nothing measured WHERE THE TIME WENT.
 * A run reported total model latency and a tool-call count, so "this task took
 * four minutes" could never be broken down into model wait vs tool execution vs
 * context assembly vs verification — and an optimization could never be
 * attributed to the thing it supposedly improved.
 *
 * This is the missing half: wall-clock accumulated per named phase.
 *
 * The honesty rule that shapes the whole module: a tracer that reports only
 * what you instrumented LIES BY OMISSION — it makes a partial picture look
 * complete. So `snapshot()` always reports `unaccountedMs`, the wall-clock that
 * no span claimed. A trace whose phases sum to 30% of the run is telling you
 * the instrument is incomplete, which is information you need.
 *
 * Concurrency: spans accumulate by name, so overlapping spans (parallel tool
 * calls, concurrent retrieval) can sum to MORE than wall-clock. That is not a
 * bug and is reported as `overlapMs` rather than hidden — it is exactly how you
 * see that parallelism is working.
 *
 * Process-local, in memory, no files and no network — same contract as
 * telemetry.js. Persistence belongs to runlog.js, which already owns it.
 */

/** Canonical phase names. Free-form names are allowed; these keep the common
 *  ones from drifting into three spellings across three call sites. */
export const PHASE = {
  MODEL: "model",            // waiting on a provider
  TOOL: "tool",              // executing a tool (suffixed: tool:bash)
  CONTEXT: "context",        // assembling the prompt / retrieval
  RETRIEVAL: "retrieval",    // search + ranking specifically
  INDEX: "index",            // repo/symbol indexing
  VERIFY: "verify",          // verification commands
  REVIEW: "review",          // the reviewer pass
  REPAIR: "repair",          // the repair pass
  PLAN: "plan",              // planning / critique
  CHECKPOINT: "checkpoint",  // snapshot + persist
}

const MAX_PHASES = 200 // bounded: a runaway name generator cannot grow this

export function createTracer({ now = Date.now, clock = null } = {}) {
  const readClock = typeof clock === "function" ? clock : now
  const started = readClock()
  const phases = Object.create(null)

  const bucket = (name) => {
    const k = String(name || "").slice(0, 80) || "unnamed"
    if (!phases[k]) {
      if (Object.keys(phases).length >= MAX_PHASES) return null
      phases[k] = { ms: 0, calls: 0, maxMs: 0, errors: 0 }
    }
    return phases[k]
  }

  /**
   * Open a span. Returns an `end(opts)` function that is SAFE TO CALL TWICE
   * (the second call is ignored) so a span inside a try/finally that also ends
   * on an error path cannot double-count.
   */
  function span(name) {
    const t0 = readClock()
    let done = false
    return function end({ error = false } = {}) {
      if (done) return 0
      done = true
      const ms = Math.max(0, readClock() - t0)
      const b = bucket(name)
      if (b) {
        b.ms += ms
        b.calls++
        if (ms > b.maxMs) b.maxMs = ms
        if (error) b.errors++
      }
      return ms
    }
  }

  /** Record a duration measured elsewhere (a provider that already timed itself). */
  function mark(name, ms, { error = false } = {}) {
    const n = Number(ms)
    if (!Number.isFinite(n) || n < 0) return 0
    const b = bucket(name)
    if (!b) return 0
    b.ms += n
    b.calls++
    if (n > b.maxMs) b.maxMs = n
    if (error) b.errors++
    return n
  }

  /** Time an async function under a span, ending it on success AND on throw. */
  async function around(name, fn) {
    const end = span(name)
    try {
      const out = await fn()
      end()
      return out
    } catch (e) {
      end({ error: true })
      throw e
    }
  }

  function snapshot() {
    const wallMs = Math.max(0, readClock() - started)
    const out = []
    let sum = 0
    for (const [name, b] of Object.entries(phases)) {
      // A name like "tool:bash" is a BREAKDOWN of the "tool" phase, not another
      // phase beside it — its time is already inside the parent's span. Adding
      // both would double-count, which would in turn understate `unaccountedMs`
      // — and that number is the whole point of the instrument.
      const detail = name.includes(":")
      if (!detail) sum += b.ms
      out.push({ name, ms: b.ms, calls: b.calls, maxMs: b.maxMs, errors: b.errors, detail })
    }
    // phases first (widest first), each followed by its own breakdown rows
    out.sort((a, b) => {
      const ap = a.detail ? a.name.split(":")[0] : a.name
      const bp = b.detail ? b.name.split(":")[0] : b.name
      if (ap !== bp) {
        const aw = phases[ap]?.ms ?? a.ms
        const bw = phases[bp]?.ms ?? b.ms
        return bw - aw || ap.localeCompare(bp)
      }
      if (a.detail !== b.detail) return a.detail ? 1 : -1
      return b.ms - a.ms || a.name.localeCompare(b.name)
    })
    // Spans may overlap (parallel work), so the sum can EXCEED wall-clock.
    // Report both facts rather than clamping one of them away.
    const overlapMs = Math.max(0, sum - wallMs)
    const unaccountedMs = Math.max(0, wallMs - sum)
    for (const p of out) p.pct = wallMs > 0 ? Math.round((p.ms / wallMs) * 1000) / 10 : 0
    return { wallMs, phases: out, accountedMs: sum, unaccountedMs, overlapMs }
  }

  /** Human-readable, widest phase first. Always states what is NOT accounted
   *  for, so a thin trace reads as thin instead of as complete. */
  function format(snap = snapshot()) {
    if (!snap.phases.length) return `no phases traced (${snap.wallMs}ms wall)`
    const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`)
    const lines = [`WHERE THE TIME WENT — ${ms(snap.wallMs)} wall`]
    for (const p of snap.phases) {
      const err = p.errors ? `, ${p.errors} err` : ""
      const label = p.detail ? `  ↳ ${p.name.split(":").slice(1).join(":")}` : p.name
      lines.push(`  ${label.padEnd(18)} ${String(ms(p.ms)).padStart(7)}  ${String(p.pct).padStart(5)}%  (${p.calls} call${p.calls === 1 ? "" : "s"}, max ${ms(p.maxMs)}${err})`)
    }
    if (snap.overlapMs > 0) lines.push(`  ${"— overlap".padEnd(18)} ${String(ms(snap.overlapMs)).padStart(7)}         (parallel work; spans exceed wall-clock)`)
    if (snap.unaccountedMs > 0) {
      const pct = snap.wallMs > 0 ? Math.round((snap.unaccountedMs / snap.wallMs) * 1000) / 10 : 0
      lines.push(`  ${"— untraced".padEnd(18)} ${String(ms(snap.unaccountedMs)).padStart(7)}  ${String(pct).padStart(5)}%  (no span claimed this time)`)
    }
    return lines.join("\n")
  }

  function reset() {
    for (const k of Object.keys(phases)) delete phases[k]
  }

  return { span, mark, around, snapshot, format, reset, PHASE }
}

/** A tracer that records nothing, for callers that were not given one. Keeps
 *  every call site free of `tracer?.` guards and optional-chaining noise. */
export function nullTracer() {
  const end = () => 0
  return {
    span: () => end,
    mark: () => 0,
    around: async (_n, fn) => fn(),
    snapshot: () => ({ wallMs: 0, phases: [], accountedMs: 0, unaccountedMs: 0, overlapMs: 0 }),
    format: () => "",
    reset: () => {},
    PHASE,
  }
}
