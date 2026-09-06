/**
 * forge — pure terminal renderers for the interactive UI (zero dependencies)
 *
 * Every function here is a function of (data, width, options) → string[] and
 * performs NO I/O. That is what makes the layout testable at 20, 80 and 200
 * columns without a terminal: tests assert that no rendered line is ever wider
 * than the terminal, that symbols carry meaning without color, and that the
 * same state renders identically twice (no duplicated lines, no drift).
 *
 * Width is DISPLAY width (East Asian wide characters count 2, combining marks
 * and zero-width joiners count 0, ANSI escapes count 0) — the only measure a
 * terminal cares about.
 *
 * Three visual dialects share one layout:
 *   unicode  ✓ ● ○ ✗ ▸ ├─ └─ ─   (default)
 *   ascii    + * o x > |- `- -   (FORGE_ASCII=1, or a non-UTF-8 locale)
 *   a11y     SUCCESS: / ACTIVE: / ERROR: text labels, no decoration
 *            (FORGE_A11Y=1 — screen-reader friendly)
 * Meaning is never carried by color alone: every state has a symbol or a word.
 */
import { bold, dim, cyan, green, yellow, red } from "./ui.js"

// ---------------------------------------------------------------------------
// width primitives
// ---------------------------------------------------------------------------

/** CSI / OSC / two-byte escapes — everything a terminal swallows silently. */
export const ANSI_RE = /\x1b\[[0-9;?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78NODEHMc]/g

export function stripAnsi(s) {
  return String(s ?? "").replace(ANSI_RE, "")
}

// [from, to] inclusive ranges — kept short on purpose (major blocks only).
const ZERO_WIDTH = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x05bf, 0x05bf], [0x05c1, 0x05c2], [0x05c4, 0x05c5], [0x05c7, 0x05c7],
  [0x0610, 0x061a], [0x064b, 0x065f], [0x0670, 0x0670], [0x06d6, 0x06dc], [0x06df, 0x06e4], [0x06e7, 0x06e8], [0x06ea, 0x06ed],
  [0x0711, 0x0711], [0x0730, 0x074a], [0x07a6, 0x07b0], [0x0816, 0x082d], [0x0900, 0x0902], [0x093a, 0x093a], [0x093c, 0x093c],
  [0x0941, 0x0948], [0x094d, 0x094d], [0x0951, 0x0957], [0x0962, 0x0963], [0x0981, 0x0981], [0x09bc, 0x09bc], [0x09c1, 0x09c4],
  [0x09cd, 0x09cd], [0x0a01, 0x0a02], [0x0a3c, 0x0a3c], [0x0a41, 0x0a42], [0x0a47, 0x0a48], [0x0a4b, 0x0a4d], [0x0b01, 0x0b01],
  [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e], [0x0eb1, 0x0eb1], [0x0eb4, 0x0ebc], [0x0ec8, 0x0ecd], [0x0f18, 0x0f19],
  [0x0f35, 0x0f35], [0x0f37, 0x0f37], [0x0f39, 0x0f39], [0x0f71, 0x0f7e], [0x0f80, 0x0f84], [0x102d, 0x1030], [0x1032, 0x1037],
  [0x1039, 0x103a], [0x1160, 0x11ff], [0x135d, 0x135f], [0x1712, 0x1714], [0x17b4, 0x17b5], [0x17b7, 0x17bd], [0x17c6, 0x17c6],
  [0x17c9, 0x17d3], [0x180b, 0x180d], [0x18a9, 0x18a9], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x2064], [0x20d0, 0x20ff], [0x302a, 0x302d], [0x3099, 0x309a], [0xa66f, 0xa672], [0xa674, 0xa67d], [0xa69e, 0xa69f],
  [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff], [0x1f3fb, 0x1f3ff], [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
]
const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe],
  [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa],
  [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4], [0x17000, 0x18aff],
  [0x1b000, 0x1b2ff], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f251],
  [0x1f260, 0x1f265], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
]
function inRanges(cp, table) {
  let lo = 0, hi = table.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [a, b] = table[mid]
    if (cp < a) hi = mid - 1
    else if (cp > b) lo = mid + 1
    else return true
  }
  return false
}

/** Terminal cell width of one code point: 0, 1 or 2. */
export function charWidth(cp) {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (cp < 0x300) return 1
  if (inRanges(cp, ZERO_WIDTH)) return 0
  if (inRanges(cp, WIDE)) return 2
  return 1
}

/** Display width of a string (ANSI stripped, wide=2, combining=0). */
export function displayWidth(s) {
  const str = stripAnsi(s)
  let w = 0, prev = 0, joined = false
  for (const ch of str) {
    const cp = ch.codePointAt(0)
    if (cp === 0xfe0f) { // VS16 asks for emoji presentation → a width-1 pictograph becomes 2
      if (prev === 1) w += 1
      prev = 0
      continue
    }
    if (cp === 0x200d) { joined = true; continue } // ZWJ: the next pictograph fuses into the previous cell pair
    const cw = charWidth(cp)
    if (joined) { joined = false; if (cw === 2) continue }
    w += cw
    if (cw) prev = cw
  }
  return w
}

/** Split a string into visible graphemes (Intl.Segmenter when available). */
let _seg = null
export function graphemes(s) {
  const str = String(s ?? "")
  if (!str) return []
  // fast path: pure ASCII
  let ascii = true
  for (let i = 0; i < str.length; i++) { if (str.charCodeAt(i) > 0x7e || str.charCodeAt(i) < 0x20) { ascii = false; break } }
  if (ascii) return str.split("")
  try {
    if (_seg === null) _seg = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : false
    if (_seg) { const out = []; for (const g of _seg.segment(str)) out.push(g.segment); return out }
  } catch { /* fall through */ }
  return Array.from(str)
}

/**
 * Truncate to `width` display cells, preserving ANSI sequences and closing
 * them. Appends an ellipsis when something was cut (if there is room).
 */
export function fit(s, width, { ellipsis = "…" } = {}) {
  const str = String(s ?? "")
  if (width <= 0) return ""
  if (displayWidth(str) <= width) return str
  const ell = width > 3 ? ellipsis : ""
  const ellW = displayWidth(ell)
  const limit = Math.max(0, width - ellW)
  let out = "", w = 0, sawAnsi = false
  const re = new RegExp(ANSI_RE.source, "g")
  let i = 0
  let cut = false
  while (i < str.length) {
    re.lastIndex = i
    const m = re.exec(str)
    if (m && m.index === i) { out += m[0]; sawAnsi = true; i += m[0].length; continue }
    const cp = str.codePointAt(i)
    const ch = String.fromCodePoint(cp)
    const cw = cp === 0xfe0f ? 0 : charWidth(cp)
    if (w + cw > limit) { cut = true; break }
    out += ch
    w += cw
    i += ch.length
  }
  if (cut) {
    // drop trailing zero-width pieces already appended? they are harmless
    out += (sawAnsi ? "\x1b[0m" : "") + ell
  }
  return out
}

const SGR_RE = /^\x1b\[[0-9;]*m$/

/**
 * Wrap text to `width` cells, ANSI-aware: escape sequences are zero-width,
 * active SGR styling is closed at the end of a row and re-opened on the next,
 * and rows break at the last space when `words` is on (hard-break otherwise,
 * or when a single word is longer than the row). "\n" always breaks. Returns
 * rows whose display width never exceeds `width`.
 */
export function wrapAnsi(text, width, { words = true } = {}) {
  const w = Math.max(1, width | 0)
  const out = []
  for (const line of String(text ?? "").replace(/\t/g, "    ").split("\n")) {
    // tokenize into ANSI + graphemes
    const tokens = []
    let last = 0
    const re = new RegExp(ANSI_RE.source, "g")
    let m
    while ((m = re.exec(line))) {
      if (m.index > last) for (const g of graphemes(line.slice(last, m.index))) tokens.push(g)
      tokens.push({ ansi: m[0] })
      last = m.index + m[0].length
    }
    if (last < line.length) for (const g of graphemes(line.slice(last))) tokens.push(g)
    let row = "", rowW = 0
    let sgr = []
    let spaceAt = -1, spaceSgr = null, spaceW = 0
    const reopen = (list) => list.join("")
    for (const tok of tokens) {
      if (typeof tok !== "string") {
        row += tok.ansi
        if (SGR_RE.test(tok.ansi)) { if (tok.ansi === "\x1b[0m" || tok.ansi === "\x1b[m") sgr = []; else sgr.push(tok.ansi) }
        continue
      }
      const gw = displayWidth(tok)
      if (rowW + gw > w && rowW > 0) {
        if (words && spaceAt > 0 && spaceW >= Math.min(8, w >> 1)) {
          const head = row.slice(0, spaceAt)
          const tail = row.slice(spaceAt + 1)
          out.push(head + (spaceSgr.length ? "\x1b[0m" : ""))
          row = reopen(spaceSgr) + tail
          rowW = displayWidth(tail)
        } else {
          out.push(row + (sgr.length ? "\x1b[0m" : ""))
          row = reopen(sgr)
          rowW = 0
        }
        spaceAt = -1
      }
      if (tok === " " && rowW > 0) { spaceAt = row.length; spaceSgr = sgr.slice(); spaceW = rowW }
      row += tok
      rowW += gw
    }
    out.push(row)
  }
  return out
}

export function padRight(s, width) {
  const w = displayWidth(s)
  return w >= width ? String(s) : String(s) + " ".repeat(width - w)
}
export function padLeft(s, width) {
  const w = displayWidth(s)
  return w >= width ? String(s) : " ".repeat(width - w) + String(s)
}

/** left ....... right — right stays aligned to the edge, left is truncated. */
export function columns2(left, right, width, gap = 2) {
  const rw = displayWidth(right)
  if (!right || rw + gap + 4 > width) return fit(left, width)
  const lw = width - rw - gap
  return padRight(fit(left, lw), lw) + " ".repeat(gap) + right
}

export function rule(width, ch = "─") {
  return ch.repeat(Math.max(0, Math.min(width, 72)))
}

export function fmtMs(ms) {
  const n = Math.max(0, Number(ms) || 0)
  if (n < 1000) return `${Math.round(n)}ms`
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`
  const m = Math.floor(n / 60000), s = Math.round((n % 60000) / 1000)
  if (m < 60) return `${m}m${String(s).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`
}

export function fmtClock(ms) {
  const t = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0")
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function fmtInt(n) {
  return Number(n || 0).toLocaleString("en-US")
}

export function fmtTime(ts) {
  const d = new Date(ts || Date.now())
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** Shorten a home-relative path: /home/me/x → ~/x */
export function tildify(p, home = process.env.HOME || "") {
  const s = String(p ?? "")
  return home && s.startsWith(home) ? "~" + s.slice(home.length) : s
}

// ---------------------------------------------------------------------------
// dialects: symbols + theme
// ---------------------------------------------------------------------------

const UNICODE = { ok: "✓", fail: "✗", active: "●", todo: "○", warn: "⚠", bullet: "▸", mid: "├─", end: "└─", rule: "─", ell: "…", full: "█", empty: "░", prompt: "›", cont: "…", dot: "·", branch: "│" }
const ASCII = { ok: "+", fail: "x", active: "*", todo: "o", warn: "!", bullet: ">", mid: "|-", end: "`-", rule: "-", ell: "...", full: "#", empty: ".", prompt: ">", cont: "...", dot: ".", branch: "|" }

export function symbolsFor({ ascii = false } = {}) {
  return ascii ? ASCII : UNICODE
}

/** Decide the dialect from environment: FORGE_ASCII, locale, FORGE_A11Y. */
export function detectDialect(env = process.env, cfg = {}) {
  const a11y = env.FORGE_A11Y === "1" || cfg.a11y === true
  const lang = `${env.LC_ALL || env.LC_CTYPE || env.LANG || ""}`.toLowerCase()
  const nonUtf = lang && !/utf-?8/.test(lang) && lang !== "c.utf8"
  const ascii = env.FORGE_ASCII === "1" || cfg.ascii === true || (nonUtf && lang !== "" && lang !== "c" && lang !== "posix" ? true : false) || (cfg.ascii !== false && (lang === "c" || lang === "posix"))
  return { a11y, ascii: !!ascii }
}

const IDENT = (s) => s
export const THEME = { bold, dim, ok: green, warn: yellow, fail: red, active: cyan, info: IDENT, muted: dim }

/** Options bag every renderer takes; build once per UI. */
export function renderOptions({ ascii = false, a11y = false, now } = {}) {
  return { sym: symbolsFor({ ascii }), th: THEME, a11y, ascii, now: now ?? Date.now() }
}

const STATE_KIND = {
  READY: "muted", THINKING: "active", PLANNING: "active", EXECUTING: "active", VERIFYING: "active",
  RECOVERING: "warn", WAITING: "warn", COMPLETED: "ok", FAILED: "fail", CANCELLED: "warn",
}
export function stateSymbol(state, o) {
  const { sym } = o
  switch (state) {
    case "READY": return sym.todo
    case "COMPLETED": return sym.ok
    case "FAILED": return sym.fail
    case "CANCELLED": return sym.warn
    case "WAITING": return sym.warn
    case "RECOVERING": return sym.warn
    default: return sym.active
  }
}
function paint(kind, s, o) {
  const f = o.th[kind] || IDENT
  return f(s)
}
function statusWord(kind, o) {
  // a11y: words instead of glyphs
  if (!o.a11y) return null
  return { ok: "SUCCESS:", fail: "ERROR:", active: "ACTIVE:", warn: "WARNING:", muted: "PENDING:", todo: "PENDING:", info: "" }[kind] ?? ""
}
/** Status mark for a list item: "✓" | "●" | "○" | "✗" (or a11y word). */
export function mark(kind, o) {
  const { sym } = o
  const w = statusWord(kind, o)
  if (w !== null) return w
  return { ok: sym.ok, fail: sym.fail, active: sym.active, todo: sym.todo, warn: sym.warn, muted: sym.todo }[kind] ?? sym.todo
}

// ---------------------------------------------------------------------------
// header + dock
// ---------------------------------------------------------------------------

/** Width tiers shared by every adaptive renderer. */
export function tierFor(width) {
  if (width < 50) return "narrow"
  if (width < 100) return "medium"
  return "wide"
}

export function shortRun(runId) {
  if (!runId) return ""
  const s = String(runId)
  const tail = s.split("-").pop() || s
  return "RUN-" + tail.slice(-4).toUpperCase()
}
export function shortCheckpoint(id) {
  if (!id) return ""
  const s = String(id)
  const tail = s.split("-").pop() || s
  return "CP-" + tail.slice(-4).toUpperCase()
}

const MODE_LABEL = { chat: "CHAT", agent: "AGENT", plan: "PLAN", recovery: "RECOVERY" }

/** Progress fraction from a plan (never fabricated: null when no plan). */
export function progressOf(state) {
  const items = state?.plan ?? []
  if (!items.length) return null
  const done = items.filter((i) => i.status === "done").length
  return { done, total: items.length, pct: Math.round((done / items.length) * 100) }
}

/**
 * One-line persistent header. Segments are dropped from the RIGHT until the
 * line fits: provider → elapsed → run id. FORGE + mode + state always stay.
 */
export function renderHeader(state, width, o) {
  const st = state.state || "READY"
  const kind = STATE_KIND[st] || "info"
  const prog = progressOf(state)
  const elapsed = state.task?.startedAt ? fmtClock((state.task.endedAt ?? o.now) - state.task.startedAt) : ""
  if (tierFor(width) === "narrow") {
    const s = o.a11y ? `STATE: ${st}` : `${stateSymbol(st, o)} ${st}`
    const p = prog && st !== "READY" ? `  ${prog.pct}%` : ""
    return fit(paint(kind, s, o) + p, width - 1)
  }
  const stateSeg = o.a11y ? `STATE: ${st}` : paint(kind, `${stateSymbol(st, o)} ${st}`, o)
  const pctSeg = prog && !["READY", "COMPLETED", "FAILED", "CANCELLED"].includes(st) ? ` ${prog.pct}%` : ""
  const modeSeg = paint(state.mode === "agent" ? "active" : "info", MODE_LABEL[state.mode] || String(state.mode || "CHAT").toUpperCase(), o)
  const must = [o.th.bold("FORGE"), modeSeg]
  const optional = []
  if (state.task?.id) optional.push(o.th.muted(shortRun(state.task.id)))
  const core = stateSeg + pctSeg
  const tail = []
  if (elapsed && st !== "READY") tail.push(o.th.muted(elapsed))
  if (state.provider || state.model) tail.push(o.th.muted([state.provider, state.model].filter(Boolean).join("/")))
  // try richest first, then drop tail pieces, then the run id
  const attempts = []
  for (let t = tail.length; t >= 0; t--) attempts.push([...must, ...optional, core, ...tail.slice(0, t)])
  attempts.push([...must, core])
  for (const segs of attempts) {
    const line = segs.join("  ")
    if (displayWidth(line) <= width - 1) return line
  }
  return fit([...must, core].join("  "), width - 1)
}

/** Current step text: plan item in progress → running tool → state word. */
export function currentStepText(state, o) {
  const doing = (state.plan ?? []).find((i) => i.status === "doing")
  if (doing) return doing.text
  const running = (state.activity ?? []).filter((a) => !a.endedAt)
  if (running.length) {
    const a = running[running.length - 1]
    return `${verbFor(a.name)} ${a.target || a.name}`.trim()
  }
  switch (state.state) {
    case "THINKING": return "Thinking"
    case "PLANNING": return "Planning"
    case "VERIFYING": return "Verifying"
    case "RECOVERING": return state.recoveryNote || "Recovering"
    case "WAITING": return state.waitingFor || "Waiting for input"
    default: return ""
  }
}
function verbFor(name) {
  switch (name) {
    case "read_file": return "Reading"
    case "write_file": return "Writing"
    case "edit_file": case "multi_edit": case "apply_patch": return "Editing"
    case "bash": return "Running"
    case "grep_files": case "glob_files": case "web_search": return "Searching"
    case "fetch_url": return "Fetching"
    case "delegate": return "Delegating"
    case "list_dir": return "Listing"
    case "git_status": return "Checking git"
    case "think": return "Thinking"
    case "todo": return "Planning"
    default: return name || ""
  }
}

export function progressBar(pct, width, o) {
  const n = Math.max(4, width)
  const filled = Math.max(0, Math.min(n, Math.round((pct / 100) * n)))
  return o.th.active(o.sym.full.repeat(filled)) + o.th.muted(o.sym.empty.repeat(n - filled))
}

function changeCounts(state) {
  const files = Object.values(state.changes ?? {})
  const m = files.filter((f) => f.action === "modified").length
  const a = files.filter((f) => f.action === "created").length
  const d = files.filter((f) => f.action === "deleted").length
  return { m, a, d, total: files.length }
}
function testsText(state, o) {
  const t = state.tests
  if (!t) return ""
  if (t.running) return "running"
  const parts = []
  if (t.passed != null) parts.push(`${t.passed} ${mark("ok", o)}`.trim())
  if (t.failed != null && t.failed > 0) parts.push(`${t.failed} ${mark("fail", o)}`.trim())
  if (!parts.length) return t.ok ? `passed` : `failed`
  return parts.join(" ")
}

export function taskActive(state) {
  return !!state.task && !["READY", "COMPLETED", "FAILED", "CANCELLED"].includes(state.state)
}

/**
 * The live region above the input. Height is bounded (never more than ~⅓ of
 * the screen) and adapts to width:
 *   narrow  → header only
 *   medium  → header + one summary line
 *   wide    → header + TASK / PLAN / progress / ACTIVITY / WORKERS
 */
export function renderDock(state, width, rows, o) {
  const lines = [renderHeader(state, width, o)]
  if (!taskActive(state) || state.state === "WAITING") return lines
  const tier = tierFor(width)
  if (tier === "narrow") return lines
  // a chat turn is not a task: header only, unless inline tools are running
  if (state.task?.kind === "chat" && !(state.activity ?? []).some((a) => !a.endedAt)) return lines
  const maxBody = Math.max(1, Math.min(9, Math.floor((rows || 24) / 3) - 1))
  const step = currentStepText(state, o)
  const cc = changeCounts(state)
  const tt = testsText(state, o)
  if (tier === "medium" || maxBody < 3 || o.a11y) {
    const bits = []
    if (step) bits.push(`${o.a11y ? "step:" : o.sym.bullet} ${step}`)
    if (cc.total) bits.push(`files ${cc.total}`)
    if (tt) bits.push(`tests ${tt}`)
    if (state.checkpoint) bits.push(shortCheckpoint(state.checkpoint))
    if (bits.length) lines.push(fit("  " + bits.join(`  ${o.sym.dot}  `), width - 1))
    return lines
  }
  const body = []
  const label = (s) => o.th.muted(s.padEnd(9))
  if (state.task?.title) body.push(fit(label("TASK") + state.task.title, width - 1))
  const plan = state.plan ?? []
  if (plan.length) body.push(fit(label("PLAN") + inlinePlan(plan, width - 10, o), width - 1))
  const prog = progressOf(state)
  const meta = []
  if (prog) meta.push(progressBar(prog.pct, 20, o) + ` ${prog.pct}%  ${prog.done}/${prog.total} steps`)
  else if (state.task?.step) meta.push(`step ${state.task.step}`)
  if (step) meta.push(fit(step, 40))
  if (cc.total) meta.push(`files ${cc.total}`)
  if (tt) meta.push(`tests ${tt}`)
  if (state.checkpoint) meta.push(shortCheckpoint(state.checkpoint))
  if (meta.length) body.push(fit(label("") + meta.join(`  ${o.sym.dot}  `), width - 1))
  const act = (state.activity ?? []).slice(-3)
  if (act.length) {
    body.push(o.th.muted("ACTIVITY"))
    for (const l of renderActivity(act, width, o)) body.push(l)
  }
  const workers = (state.workers ?? []).filter((w) => w.status === "running")
  if (workers.length) body.push(fit(label("WORKERS") + workers.map((w) => `${String(w.n).padStart(2, "0")} ${w.role} ${mark("active", o)}`).join(`  ${o.sym.dot}  `), width - 1))
  // bound by rows: drop activity first, then workers, then plan
  while (body.length > maxBody) {
    const i = body.findIndex((l) => stripAnsi(l).startsWith("ACTIVITY"))
    if (i !== -1) { body.splice(i, body.length - i); continue }
    body.pop()
  }
  return [...lines, ...body]
}

/** ✓ a · ✓ b · ● c · ○ d  (+3) — a plan as one line. */
export function inlinePlan(items, width, o) {
  const parts = items.map((it) => `${mark(it.status === "done" ? "ok" : it.status === "doing" ? "active" : it.status === "failed" ? "fail" : "todo", o)} ${it.text}`)
  let out = ""
  let shown = 0
  const cur = Math.max(0, items.findIndex((i) => i.status === "doing"))
  // window: keep the current item visible
  const order = items.map((_, i) => i).sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur))
  const visible = new Set()
  let used = 0
  for (const i of order) {
    const piece = fit(parts[i], 36)
    const w = displayWidth(piece) + (visible.size ? 3 : 0)
    if (used + w + 6 > width) break
    visible.add(i); used += w
  }
  const seq = [...visible].sort((a, b) => a - b)
  out = seq.map((i) => fit(parts[i], 36)).join(` ${o.sym.dot} `)
  shown = seq.length
  if (shown < items.length) out += o.th.muted(`  (+${items.length - shown})`)
  return out
}

// ---------------------------------------------------------------------------
// panels
// ---------------------------------------------------------------------------

function section(title, width, o) {
  return [o.th.bold(title), o.th.muted(rule(Math.min(width - 1, 24), o.sym.rule))]
}

export function renderPlan(items, width, o, { title = "PLAN" } = {}) {
  const out = section(title, width, o)
  if (!items?.length) { out.push(o.th.muted("  (no plan yet)")); return out }
  const walk = (list, depth) => {
    list.forEach((it, idx) => {
      const kind = it.status === "done" ? "ok" : it.status === "doing" ? "active" : it.status === "failed" ? "fail" : "todo"
      const num = it.n != null ? String(it.n) : String(idx + 1).padStart(2, "0")
      const indent = depth ? "   ".repeat(depth) : ""
      const tree = depth ? (idx === list.length - 1 ? o.sym.end + " " : o.sym.mid + " ") : ""
      const label = `${indent}${tree}${num.padStart(2, "0")} ${mark(kind, o)} ${it.text}`
      out.push(fit(label, width - 1))
      if (it.children?.length) walk(it.children, depth + 1)
    })
  }
  walk(items, 0)
  return out
}

/** ├─ ✓ read_file  src/auth.js        42ms */
export function renderActivity(entries, width, o, now = o.now) {
  const out = []
  entries.forEach((a, i) => {
    const last = i === entries.length - 1
    const tree = last ? o.sym.end : o.sym.mid
    const kind = a.endedAt ? (a.ok === false ? "fail" : "ok") : "active"
    const dur = a.endedAt ? fmtMs(a.ms ?? a.endedAt - a.startedAt) : fmtMs(now - a.startedAt)
    const left = `  ${tree} ${mark(kind, o)} ${padRight(a.label || a.name, 10)} ${a.target || ""}`
    out.push(columns2(left, o.th.muted(dur), width - 1))
  })
  return out
}

export function renderWorkers(workers, width, o) {
  const out = section("WORKERS", width, o)
  if (!workers?.length) { out.push(o.th.muted("  (no sub-agents in this session)")); return out }
  for (const w of workers) {
    const kind = w.status === "running" ? "active" : w.status === "failed" ? "fail" : w.status === "queued" ? "todo" : "ok"
    const word = w.status === "done" ? "complete" : w.status
    const left = `  ${String(w.n).padStart(2, "0")}  ${padRight(w.role, 14)} ${mark(kind, o)}  ${word}`
    const right = w.endedAt ? fmtMs(w.endedAt - w.startedAt) : fmtMs(o.now - w.startedAt)
    out.push(columns2(left, o.th.muted(right), width - 1))
    if (w.task) out.push(fit(`      ${o.th.muted(w.task)}`, width - 1))
  }
  return out
}

export function renderChanges(changes, width, o, { cwd = process.cwd() } = {}) {
  const out = section("CHANGES", width, o)
  const files = Object.values(changes ?? {})
  if (!files.length) { out.push(o.th.muted("  (no files changed in this session)")); return out }
  const rel = (p) => { const s = String(p); return s.startsWith(cwd + "/") ? s.slice(cwd.length + 1) : tildify(s) }
  const nameW = Math.min(48, Math.max(8, ...files.map((f) => displayWidth(rel(f.path)))))
  for (const f of files) {
    const code = f.action === "created" ? o.th.ok("A") : f.action === "deleted" ? o.th.fail("D") : o.th.warn("M")
    const plus = f.added ? o.th.ok(`+${f.added}`) : ""
    const minus = f.removed ? o.th.fail(`-${f.removed}`) : ""
    out.push(fit(`${code}  ${padRight(rel(f.path), nameW)}  ${[plus, minus].filter(Boolean).join(" ")}`, width - 1))
  }
  return out
}

const CHECK_LABEL = { syntax: "Syntax", types: "Types", lint: "Lint", tests: "Unit tests", integration: "Integration", build: "Build", security: "Security", regression: "Regression" }

/** Only checks that were actually performed are listed — never a claim. */
export function renderVerification(checks, meta = {}, width, o) {
  const out = section("VERIFICATION", width, o)
  const keys = ["syntax", "types", "lint", "tests", "integration", "build", "security", "regression"].filter((k) => checks && checks[k])
  if (!keys.length) out.push(o.th.muted("  no checks were run"))
  for (const k of keys) {
    const c = checks[k]
    const kind = c.ok === false ? "fail" : c.ok ? "ok" : "todo"
    let detail = ""
    if (k === "tests" && c.passed != null) detail = c.failed ? `${c.passed}/${c.passed + c.failed}` : `${c.passed}/${c.passed}`
    else if (c.summary) detail = c.summary
    out.push(fit(`  ${padRight(CHECK_LABEL[k], 14)} ${mark(kind, o)}  ${detail}`, width - 1))
  }
  out.push("")
  if (meta.files != null) out.push(`  ${padRight("Files changed", 14)} ${meta.files}`)
  if (meta.checkpoint) out.push(`  ${padRight("Checkpoint", 14)} ${shortCheckpoint(meta.checkpoint)}`)
  return out
}

export function renderCompletion(info, width, o) {
  const out = []
  out.push(o.th.ok(`${mark("ok", o)} COMPLETED`))
  if (info.title) out.push(fit(info.title, width - 1))
  out.push("")
  const row = (k, v) => { if (v !== undefined && v !== null && v !== "") out.push(`  ${padRight(k, 12)} ${v}`) }
  row("Changes", info.files != null ? `${info.files} file${info.files === 1 ? "" : "s"}` : undefined)
  row("Tests", info.tests)
  row("Build", info.build)
  row("Checkpoint", info.checkpoint ? shortCheckpoint(info.checkpoint) : undefined)
  row("Steps", info.steps != null ? `${info.steps} step${info.steps === 1 ? "" : "s"}${info.toolCalls != null ? ` ${o.sym.dot} ${info.toolCalls} tool call${info.toolCalls === 1 ? "" : "s"}` : ""}` : undefined)
  row("Elapsed", info.elapsedMs != null ? fmtClock(info.elapsedMs) : undefined)
  if (info.undoHint) row("Undo", info.undoHint)
  return out
}

export function renderFailure(info, width, o) {
  const out = []
  out.push(o.th.fail(`${mark("fail", o)} TASK FAILED`))
  out.push("")
  const row = (k, v) => { if (v !== undefined && v !== null && v !== "") out.push(fit(`  ${padRight(k, 12)} ${v}`, width - 1)) }
  row("Reason", info.reason)
  if (info.completed != null && info.total != null) row("Completed", `${info.completed}/${info.total} steps`)
  else if (info.steps != null) row("Steps", `${info.steps}`)
  row("Checkpoint", info.checkpoint ? shortCheckpoint(info.checkpoint) : undefined)
  row("Changes", info.files ? `${info.files} file${info.files === 1 ? "" : "s"} ${o.sym.dot} preserved safely (${info.undoHint || "/undo --run"} rolls back)` : "none")
  row("Next", info.next)
  return out
}

export function renderCancel(phase, info = {}, width, o) {
  const out = []
  if (phase === "requested") {
    out.push(o.th.warn("CANCEL REQUESTED"))
    out.push(o.th.muted("Stopping current operation…"))
  } else if (phase === "waiting") {
    out.push(o.th.warn("Stopping…"))
    out.push(o.th.muted(`waiting for current tool to terminate${info.tool ? ` (${info.tool})` : ""}`))
  } else {
    out.push(`${o.th.ok(mark("ok", o))} execution stopped safely`)
    if (info.files) out.push(`${o.th.ok(mark("ok", o))} ${info.files} changed file${info.files === 1 ? "" : "s"} checkpointed ${o.th.muted(`(${info.undoHint || "/undo --run"} rolls back)`)}`)
    if (info.partialKept) out.push(`${o.th.ok(mark("ok", o))} partial answer kept ${o.th.muted("(/retry regenerates)")}`)
    if (info.sessionSaved) out.push(`${o.th.ok(mark("ok", o))} session saved`)
    if (info.inputRestored !== false) out.push(`${o.th.ok(mark("ok", o))} input restored`)
  }
  return out.map((l) => fit(l, width - 1))
}

export function renderRecovery(run, width, o, { startup = false } = {}) {
  const out = []
  out.push(o.th.warn(`${mark("warn", o)} ${startup ? "FORGE RECOVERY — an interrupted task was found" : "INTERRUPTED TASK"}`))
  out.push("")
  const row = (k, v) => { if (v !== undefined && v !== null && v !== "") out.push(fit(`  ${padRight(k, 18)} ${v}`, width - 1)) }
  row("Run", shortRun(run.runId) + (run.startedAt ? o.th.muted(`  started ${fmtTime(run.startedAt)}`) : ""))
  row("Task", run.task)
  row("Status", run.status === "running" ? "INTERRUPTED" : String(run.status || "").toUpperCase())
  row("Last checkpoint", run.checkpoints?.length ? shortCheckpoint(run.checkpoints[run.checkpoints.length - 1]) : "none (no files were changed)")
  row("Last known step", run.step != null ? `${run.step}${run.lastTool ? ` ${o.sym.dot} ${run.lastTool.name} ${run.lastTool.target || ""}` : ""}` : undefined)
  if (run.verify) {
    row("Filesystem", run.verify.filesystem)
    row("Checkpoints", run.verify.checkpoints)
    row("Tests", run.verify.tests)
  } else {
    row("Filesystem", "not verified yet")
  }
  const files = run.files ? Object.keys(run.files).length : 0
  row("Changes", files ? `${files} file${files === 1 ? "" : "s"} touched` : "none recorded")
  row("Recovery", run.checkpoints?.length ? "safe undo available; resume re-inspects the tree first" : "resume available")
  out.push("")
  const keys = width >= 70
    ? `  ${o.th.bold("[R]")} Resume   ${o.th.bold("[V]")} Verify   ${o.th.bold("[U]")} Undo   ${o.th.bold("[C]")} Cancel (keep as-is)`
    : `  ${o.th.bold("[R]")}esume  ${o.th.bold("[V]")}erify  ${o.th.bold("[U]")}ndo  ${o.th.bold("[C]")}ancel`
  out.push(fit(keys, width - 1))
  return out
}

export function renderIdle(info, width, o) {
  const out = []
  out.push(o.th.bold("FORGE") + o.th.muted(`  v${info.version || ""}`))
  out.push("")
  out.push("Ready.")
  out.push("")
  const row = (k, v) => { if (v) out.push(fit(`  ${padRight(k, 10)} ${v}`, width - 1)) }
  row("Project", info.project)
  row("Branch", info.branch)
  row("Session", info.session)
  row("Provider", info.provider)
  row("Mode", info.mode)
  if (info.lastTask) row("Last task", info.lastTask)
  if (info.hint) { out.push(""); out.push(o.th.muted(fit(info.hint, width - 1))) }
  return out
}

/** Compact durable line for a finished tool: ✓ shell  npm test   2.8s */
export function toolLabel(name) {
  return name === "bash" ? "shell" : name === "web_search" ? "search" : name === "fetch_url" ? "fetch" : name === "glob_files" ? "glob" : name === "grep_files" ? "grep" : name === "list_dir" ? "ls" : name === "git_status" ? "git" : String(name || "")
}
export function renderToolLine(entry, width, o) {
  const kind = entry.ok === false ? "fail" : entry.endedAt ? "ok" : "active"
  const dur = entry.endedAt ? fmtMs(entry.ms ?? 0) : ""
  const left = `${mark(kind, o)} ${padRight(toolLabel(entry.name), 9)} ${entry.target || ""}`
  const main = columns2(left, o.th.muted(dur), width - 1)
  const out = [main]
  for (const s of entry.summary ?? []) out.push(fit(`  ${s}`, width - 1))
  if (entry.exit != null && entry.exit !== 0) out.push(fit(`  exit ${entry.exit}`, width - 1))
  if (entry.hidden) out.push(fit(o.th.muted(`  ${fmtInt(entry.hidden)} lines hidden  ${o.sym.dot}  /details to expand`), width - 1))
  return out
}

export function renderCheckpoints(list, width, o, { runFilter } = {}) {
  const out = section("CHECKPOINTS", width, o)
  const items = (list ?? []).filter((c) => !runFilter || c.runId === runFilter)
  if (!items.length) { out.push(o.th.muted("  (none for this directory)")); return out }
  for (const c of items) {
    const files = (c.files ?? []).length
    const names = (c.files ?? []).slice(0, 2).map((f) => String(f.path).split("/").pop()).join(", ")
    const more = files > 2 ? ` +${files - 2}` : ""
    out.push(fit(`  ${padRight(shortCheckpoint(c.id), 8)} ${fmtTime(c.ts)}  ${padRight(String(files) + " file" + (files === 1 ? "" : "s"), 8)} ${o.th.muted(names + more)}${c.runId ? o.th.muted(`  ${shortRun(c.runId)}`) : ""}`, width - 1))
  }
  return out
}

export function renderErrorBlock(err, width, o) {
  const out = []
  out.push(o.th.fail(`${mark("fail", o)} ${err.title || "ERROR"}`))
  if (err.command) { out.push(""); out.push(fit(err.command, width - 1)) }
  if (err.summary) { out.push(""); out.push(fit(err.summary, width - 1)) }
  if (err.cause) { out.push(""); out.push(o.th.muted("Root cause:")); out.push(fit(err.cause, width - 1)) }
  if (err.actions?.length) {
    out.push(""); out.push(o.th.muted("Forge:"))
    for (const a of err.actions) out.push(fit(`${o.sym.bullet} ${a}`, width - 1))
  }
  if (err.hasDetails) out.push(o.th.muted(`  /details for the full output`))
  return out
}

export function renderRepair(repair, width, o) {
  const out = section("REPAIR", width, o)
  const attempts = repair?.attempts ?? []
  if (!attempts.length) { out.push(o.th.muted("  (no repair attempts)")); return out }
  attempts.forEach((a) => {
    out.push(`  Attempt ${a.n}`)
    out.push(fit(`  ${mark(a.ok ? "ok" : "fail", o)} ${a.summary || (a.ok ? "verification passed" : "verification failed")}`, width - 1))
    if (a.diagnosis) { out.push(o.th.muted("  Diagnosis:")); out.push(fit(`  ${a.diagnosis}`, width - 1)) }
    out.push("")
  })
  out.pop()
  return out
}

/** Unified-diff text → colored lines, capped. */
export function renderDiff(text, width, o, { max = 120 } = {}) {
  const lines = String(text ?? "").split("\n")
  const out = []
  for (const l of lines.slice(0, max)) {
    let s = l
    if (l.startsWith("+++") || l.startsWith("---")) s = o.th.bold(l)
    else if (l.startsWith("@@")) s = o.th.active(l)
    else if (l.startsWith("+")) s = o.th.ok(l)
    else if (l.startsWith("-")) s = o.th.fail(l)
    out.push(fit(s, width - 1))
  }
  if (lines.length > max) out.push(o.th.muted(`  ${fmtInt(lines.length - max)} more lines ${o.sym.dot} /details to expand`))
  return out
}

/** Full vertical task panel (for /status and /tasks). */
export function renderTaskPanel(state, width, o) {
  const out = section("TASK", width, o)
  const row = (k, v) => { if (v !== undefined && v !== null && v !== "") out.push(fit(`  ${padRight(k, 11)} ${v}`, width - 1)) }
  row("Objective", state.task?.title || o.th.muted("(none)"))
  const prog = progressOf(state)
  if (prog) row("Progress", `${progressBar(prog.pct, 18, o)} ${prog.pct}%  ${o.th.muted(`${prog.done}/${prog.total} steps`)}`)
  else if (state.task?.step) row("Progress", `step ${state.task.step}`)
  const step = currentStepText(state, o)
  if (step) row("Step", step)
  const cc = changeCounts(state)
  if (cc.total) row("Files", [cc.m ? `${cc.m} modified` : "", cc.a ? `${cc.a} created` : "", cc.d ? `${cc.d} deleted` : ""].filter(Boolean).join(` ${o.sym.dot} `))
  const tt = testsText(state, o)
  if (tt) row("Tests", tt)
  if (state.checkpoint) row("Checkpoint", shortCheckpoint(state.checkpoint))
  if (state.task?.startedAt) row("Elapsed", fmtClock((state.task.endedAt ?? o.now) - state.task.startedAt))
  row("State", state.state)
  return out
}

/** Columns for completion candidates. */
export function renderColumns(items, width, o) {
  if (!items.length) return []
  const w = Math.max(...items.map((s) => displayWidth(s))) + 2
  const per = Math.max(1, Math.floor((width - 1) / w))
  const out = []
  for (let i = 0; i < items.length; i += per) out.push(fit(items.slice(i, i + per).map((s) => padRight(s, w)).join(""), width - 1))
  return out
}
