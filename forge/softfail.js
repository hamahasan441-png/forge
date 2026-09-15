/**
 * forge — swallowed-failure reporting (v101 P0, zero dependencies)
 *
 * The repository has ~315 `catch {}` blocks in its execution paths. Most are
 * DELIBERATE and correct: memory is a speedup, never a correctness dependency;
 * a checkpoint write must not take down a run; killing an already-dead child
 * throws and nobody cares. Converting them to `throw` would trade robustness
 * for noise, which is why this module exists instead.
 *
 * The problem was never that failures are swallowed. It is that they are
 * swallowed WITHOUT A TRACE, so a run that quietly lost its memory index, its
 * repo map and its checkpoint looks identical to one where everything worked.
 *
 * The insight that makes this useful rather than just more logging: the ERROR
 * KIND separates intent from accident.
 *
 *   ENOENT / EACCES / ECONNREFUSED / ESRCH  - almost always the expected case
 *                                             a best-effort path was written for
 *   TypeError / ReferenceError / SyntaxError - almost always a BUG that has been
 *                                             hiding behind an empty catch
 *
 * So `snapshot()` marks the second group `suspicious`, turning 315
 * undifferentiated catches into a short list worth actually reading.
 *
 * Process-local, in memory, bounded, and it NEVER throws - a reporter that can
 * fail is worse than no reporter, because it would take down the very paths it
 * was added to observe. Control flow is never changed: callers still swallow.
 */

const MAX_ENTRIES = 300
const MAX_MSG = 200
const SEP = " > " // key separator; `where` and `what` are short bounded labels

/** Error classes that normally mean "the thing legitimately wasn't there". */
const EXPECTED_CODES = new Set([
  "ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR", "EEXIST",
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ESRCH", "EAGAIN",
  "ABORT_ERR",
])

/** Error types that normally mean a real defect was hiding in a catch. */
const SUSPICIOUS_NAMES = new Set([
  "TypeError", "ReferenceError", "SyntaxError", "RangeError",
])

const entries = new Map() // key -> record
let dropped = 0

function classify(err) {
  const code = err?.code ? String(err.code) : ""
  if (code && EXPECTED_CODES.has(code)) return { kind: code, suspicious: false }
  const name = err?.name ? String(err.name) : ""
  if (name && SUSPICIOUS_NAMES.has(name)) return { kind: name, suspicious: true }
  if (code) return { kind: code, suspicious: false }
  return { kind: name || "Error", suspicious: false }
}

/**
 * Record a failure a caller is deliberately swallowing.
 *
 * @param where  module or subsystem ("memory", "checkpoint")
 * @param what   the operation that failed ("load index", "snapshot files")
 * @param err    the caught value (anything - never assumed to be an Error)
 * @returns the error, so a call site can stay a one-liner
 */
export function swallowed(where, what, err) {
  try {
    const { kind, suspicious } = classify(err)
    const w = String(where ?? "?").slice(0, 60)
    const o = String(what ?? "?").slice(0, 80)
    const key = w + SEP + o + SEP + kind
    const existing = entries.get(key)
    if (existing) {
      existing.count++
      existing.last = Date.now()
      return err
    }
    if (entries.size >= MAX_ENTRIES) { dropped++; return err }
    entries.set(key, {
      where: w, what: o, kind, suspicious,
      count: 1,
      first: Date.now(),
      last: Date.now(),
      sample: String(err?.message ?? err ?? "").slice(0, MAX_MSG),
    })
  } catch { /* a reporter that can fail is worse than no reporter */ }
  return err
}

/** Everything swallowed so far - suspicious first, then by frequency. */
export function snapshot() {
  const list = [...entries.values()]
  list.sort((a, b) => (b.suspicious - a.suspicious) || (b.count - a.count) || a.where.localeCompare(b.where))
  return {
    total: list.reduce((n, e) => n + e.count, 0),
    distinct: list.length,
    suspicious: list.filter((e) => e.suspicious).length,
    dropped,
    entries: list,
  }
}

/** Readable report. Silence when nothing was swallowed - a quiet run stays quiet. */
export function format(snap = snapshot()) {
  if (!snap.entries.length) return ""
  const lines = [`SWALLOWED FAILURES - ${snap.total} in ${snap.distinct} distinct site(s)${snap.suspicious ? `, ${snap.suspicious} SUSPICIOUS` : ""}`]
  for (const e of snap.entries.slice(0, 20)) {
    const mark = e.suspicious ? "!" : " "
    lines.push(` ${mark} ${e.where}/${e.what} [${e.kind}] x${e.count}${e.sample ? ` - ${e.sample}` : ""}`)
  }
  if (snap.entries.length > 20) lines.push(`   ... ${snap.entries.length - 20} more`)
  if (snap.dropped) lines.push(`   (${snap.dropped} further site(s) not recorded - table full)`)
  if (snap.suspicious) {
    lines.push("", "! = a TypeError/ReferenceError-class failure. Best-effort paths expect")
    lines.push("    ENOENT-class errors; these usually mean a real bug was hiding here.")
  }
  return lines.join("\n")
}

export function reset() { entries.clear(); dropped = 0 }
