/**
 * forge — line editor model (zero dependencies, no I/O)
 *
 * A pure text buffer with a cursor, edited by named operations. Unicode-safe:
 * the cursor moves by GRAPHEME (an emoji family or "é" composed of two code
 * points is one step, one backspace), never by UTF-16 code unit. Multiline:
 * the buffer may contain "\n"; up/down move across visual lines when there
 * are several, and fall through to history when on the first/last line.
 *
 * History: persistent, duplicate-suppressed, session-aware (in-memory entries
 * from this session are searched first). Multiline entries are stored intact —
 * the on-disk format escapes newlines so one entry is always one file line.
 *
 * Reverse-incremental search (Ctrl-R): type to narrow, Ctrl-R again for the
 * next older match, Enter accepts, Esc cancels and restores what was typed.
 *
 * Rendering (layout of the buffer into terminal rows given a prompt width
 * and a column count) lives here too, as pure functions — the terminal only
 * paints the rows it is handed.
 */
import { graphemes, displayWidth } from "./render.js"

export const MAX_INPUT_CHARS = 2 * 1024 * 1024 // 2 MB of typed/pasted text is plenty
const WORD_RE = /[\p{L}\p{N}_]/u

export function createEditor({ history = [], maxHistory = 1000 } = {}) {
  let buf = "" // whole text
  let cur = 0 // cursor: code-unit offset into buf (always on a grapheme boundary)
  let hist = dedupe(history.filter((h) => typeof h === "string" && h.length)).slice(-maxHistory)
  let histIdx = hist.length // == hist.length means "editing a new line"
  let draft = "" // what was being typed before browsing history
  let search = null // { query, idx, saved, cursor }
  let killRing = ""
  let yankable = false

  // ---- grapheme helpers -------------------------------------------------
  function prevBoundary(pos) {
    if (pos <= 0) return 0
    const gs = graphemes(buf.slice(0, pos))
    return pos - gs[gs.length - 1].length
  }
  function nextBoundary(pos) {
    if (pos >= buf.length) return buf.length
    const rest = buf.slice(pos)
    const g = graphemes(rest)[0]
    return pos + g.length
  }
  function wordStart(pos) {
    let p = pos
    // skip whitespace/punct backwards, then the word
    while (p > 0) { const q = prevBoundary(p); if (WORD_RE.test(buf.slice(q, p))) break; p = q }
    while (p > 0) { const q = prevBoundary(p); if (!WORD_RE.test(buf.slice(q, p))) break; p = q }
    return p
  }
  function wordEnd(pos) {
    let p = pos
    while (p < buf.length) { const q = nextBoundary(p); if (WORD_RE.test(buf.slice(p, q))) break; p = q }
    while (p < buf.length) { const q = nextBoundary(p); if (!WORD_RE.test(buf.slice(p, q))) break; p = q }
    return p
  }
  function lineBounds(pos) {
    const start = buf.lastIndexOf("\n", pos - 1) + 1
    let end = buf.indexOf("\n", pos)
    if (end === -1) end = buf.length
    return { start, end }
  }
  function column(pos) {
    const { start } = lineBounds(pos)
    return displayWidth(buf.slice(start, pos))
  }
  function posAtColumn(lineStart, lineEnd, col) {
    let p = lineStart, w = 0
    while (p < lineEnd) {
      const q = nextBoundary(p)
      const gw = displayWidth(buf.slice(p, q))
      if (w + gw > col) break
      w += gw; p = q
    }
    return p
  }

  function set(text, cursor) {
    buf = String(text ?? "")
    if (buf.length > MAX_INPUT_CHARS) buf = buf.slice(0, MAX_INPUT_CHARS)
    cur = cursor == null ? buf.length : Math.max(0, Math.min(buf.length, cursor))
  }

  function insert(text) {
    const t = String(text ?? "")
    if (!t) return
    if (buf.length + t.length > MAX_INPUT_CHARS) return
    buf = buf.slice(0, cur) + t + buf.slice(cur)
    cur += t.length
    yankable = false
  }

  function kill(from, to) {
    if (from === to) return
    const [a, b] = from < to ? [from, to] : [to, from]
    killRing = buf.slice(a, b)
    buf = buf.slice(0, a) + buf.slice(b)
    cur = a
    yankable = true
  }

  const api = {
    get text() { return buf },
    get cursor() { return cur },
    get length() { return buf.length },
    get lines() { return buf.split("\n").length },
    get searching() { return !!search },
    get search() { return search ? { query: search.query, match: search.idx >= 0 ? hist[search.idx] : null, failed: search.failed } : null },
    set,
    insert,
    clear() { buf = ""; cur = 0; histIdx = hist.length; draft = ""; search = null },

    // ---- motion --------------------------------------------------------
    left() { cur = prevBoundary(cur) },
    right() { cur = nextBoundary(cur) },
    home() { cur = lineBounds(cur).start },
    end() { cur = lineBounds(cur).end },
    bufferStart() { cur = 0 },
    bufferEnd() { cur = buf.length },
    wordLeft() { cur = wordStart(cur) },
    wordRight() { cur = wordEnd(cur) },
    /** Move to the previous visual line; returns false when already on the first. */
    lineUp() {
      const { start } = lineBounds(cur)
      if (start === 0) return false
      const col = column(cur)
      const prev = lineBounds(start - 1)
      cur = posAtColumn(prev.start, prev.end, col)
      return true
    },
    lineDown() {
      const { end } = lineBounds(cur)
      if (end >= buf.length) return false
      const col = column(cur)
      const next = lineBounds(end + 1)
      cur = posAtColumn(next.start, next.end, col)
      return true
    },

    // ---- editing -------------------------------------------------------
    backspace() {
      if (cur === 0) return false
      const p = prevBoundary(cur)
      buf = buf.slice(0, p) + buf.slice(cur)
      cur = p
      yankable = false
      return true
    },
    delete() {
      if (cur >= buf.length) return false
      const n = nextBoundary(cur)
      buf = buf.slice(0, cur) + buf.slice(n)
      yankable = false
      return true
    },
    deleteWordLeft() { kill(wordStart(cur), cur) },
    deleteWordRight() { kill(cur, wordEnd(cur)) },
    killToEnd() { const { end } = lineBounds(cur); kill(cur, end === cur && end < buf.length ? end + 1 : end) },
    killToStart() { kill(lineBounds(cur).start, cur) },
    killLine() { kill(0, buf.length) },
    yank() { if (killRing) insert(killRing) },
    transpose() {
      if (buf.length < 2) return
      let p = cur >= buf.length ? prevBoundary(cur) : cur
      const a0 = prevBoundary(p)
      if (a0 === p) return
      const b1 = nextBoundary(p)
      buf = buf.slice(0, a0) + buf.slice(p, b1) + buf.slice(a0, p) + buf.slice(b1)
      cur = b1
    },
    newline() { insert("\n") },

    // ---- history -------------------------------------------------------
    get history() { return hist.slice() },
    /** Commit the current text to history (dedupe, no blanks). Returns the text. */
    commit() {
      const t = buf
      const trimmed = t.trim()
      if (trimmed) {
        hist = hist.filter((h) => h !== t)
        hist.push(t)
        if (hist.length > maxHistory) hist = hist.slice(-maxHistory)
      }
      histIdx = hist.length
      draft = ""
      search = null
      return t
    },
    historyPrev() {
      if (!hist.length || histIdx === 0) return false
      if (histIdx === hist.length) draft = buf
      histIdx--
      set(hist[histIdx])
      return true
    },
    historyNext() {
      if (histIdx >= hist.length) return false
      histIdx++
      set(histIdx === hist.length ? draft : hist[histIdx])
      return true
    },
    /** Prefix search (↑ with text typed): previous entry starting with the draft. */
    historyPrevPrefix() {
      if (!hist.length) return false
      if (histIdx === hist.length) draft = buf
      const prefix = draft
      for (let i = histIdx - 1; i >= 0; i--) {
        if (hist[i].startsWith(prefix) && hist[i] !== buf) { histIdx = i; set(hist[i]); return true }
      }
      return false
    },
    historyNextPrefix() {
      if (histIdx >= hist.length) return false
      const prefix = draft
      for (let i = histIdx + 1; i < hist.length; i++) {
        if (hist[i].startsWith(prefix)) { histIdx = i; set(hist[i]); return true }
      }
      histIdx = hist.length
      set(draft)
      return true
    },

    // ---- reverse incremental search -----------------------------------
    searchStart() {
      if (search) return api.searchNext()
      search = { query: "", idx: hist.length, saved: buf, cursor: cur, failed: false }
      return true
    },
    searchType(text) {
      if (!search) return false
      search.query += text
      search.idx = hist.length // restart from newest for the longer query
      return api.searchNext(true)
    },
    searchBackspace() {
      if (!search) return false
      search.query = graphemes(search.query).slice(0, -1).join("")
      search.idx = hist.length
      return api.searchNext(true)
    },
    /** Find the next older match for the current query. */
    searchNext(fromRestart = false) {
      if (!search) return false
      const q = search.query
      if (!q) { search.failed = false; set(search.saved, search.cursor); return true }
      const startAt = fromRestart ? hist.length - 1 : search.idx - 1
      for (let i = startAt; i >= 0; i--) {
        if (hist[i].includes(q)) {
          search.idx = i
          search.failed = false
          set(hist[i], hist[i].indexOf(q) + q.length)
          return true
        }
      }
      search.failed = true
      return false
    },
    /** Accept the match: leave search mode keeping the text. */
    searchAccept() {
      if (!search) return
      search = null
    },
    /** Cancel: restore what was there before Ctrl-R. */
    searchCancel() {
      if (!search) return
      set(search.saved, search.cursor)
      search = null
    },

    /** Snapshot/restore for the render lock. */
    snapshot() { return { buf, cur, histIdx, draft, search: search ? { ...search } : null } },
    restore(s) { if (!s) return; buf = s.buf; cur = s.cur; histIdx = s.histIdx; draft = s.draft; search = s.search ? { ...s.search } : null },
  }
  return api
}

/** Newest-wins dedupe preserving order. */
export function dedupe(list) {
  const seen = new Set()
  const out = []
  for (let i = list.length - 1; i >= 0; i--) {
    if (seen.has(list[i])) continue
    seen.add(list[i])
    out.unshift(list[i])
  }
  return out
}

// ---------------------------------------------------------------------------
// on-disk history format (~/.forge/history): one entry per line, exactly as
// before — a multiline entry is stored as a single line prefixed with \x1f and
// JSON-encoded, so older forge versions still read the file (they see one
// opaque line) and single-line entries stay plain text.
// ---------------------------------------------------------------------------

const ML = "\x1f"
export function encodeHistoryLine(entry) {
  const e = String(entry)
  return /[\n\r]/.test(e) ? ML + JSON.stringify(e) : e
}
export function decodeHistoryLine(line) {
  if (line.startsWith(ML)) {
    try { return String(JSON.parse(line.slice(1))) } catch { return line.slice(1) }
  }
  return line
}
export function parseHistoryFile(text) {
  return String(text ?? "").split("\n").filter((l) => l.length).map(decodeHistoryLine)
}
export function serializeHistory(entries) {
  return entries.map(encodeHistoryLine).join("\n") + (entries.length ? "\n" : "")
}

/** Secrets and one-off noise never belong in a history file. */
export function historyWorthy(entry) {
  const t = String(entry ?? "").trim()
  if (!t) return false
  if (/^\/key\b/.test(t)) return false
  if (/\b(api[_-]?key|token|secret|password|passwd)\s*[=:]\s*\S{6,}/i.test(t)) return false
  if (/\b(sk|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}/.test(t)) return false
  if (t.length > 20000) return false
  return true
}

// ---------------------------------------------------------------------------
// layout: buffer → terminal rows (pure)
// ---------------------------------------------------------------------------

/**
 * Lay the buffer out for a terminal `columns` wide. The first row starts after
 * `promptWidth` cells; continuation rows start after `contWidth` cells.
 * Returns { rows: string[], cursorRow, cursorCol } where rows exclude the
 * prompt strings themselves (the caller prepends prompt / continuation).
 * Wrapping is by grapheme with correct wide-char handling; the cursor is
 * placed on the row that owns it.
 */
export function layout(text, cursor, columns, promptWidth, contWidth = promptWidth) {
  const cols = Math.max(4, columns | 0)
  const rows = []
  let cursorRow = 0, cursorCol = promptWidth
  let row = "", w = promptWidth
  let pos = 0
  let rowIsFirstOfLine = true
  const push = () => { rows.push(row); row = ""; w = contWidth; rowIsFirstOfLine = false }
  const place = () => { cursorRow = rows.length; cursorCol = w }
  const lines = String(text ?? "").split("\n")
  for (let li = 0; li < lines.length; li++) {
    if (li > 0) {
      // logical newline: start a fresh row with the continuation prompt
      if (pos === cursor) place()
      pos += 1 // the "\n"
      rows.push(row); row = ""; w = contWidth; rowIsFirstOfLine = true
    }
    for (const g of graphemes(lines[li])) {
      const gw = displayWidth(g) || (g === "\t" ? 4 : 0)
      const shown = g === "\t" ? "    " : g
      if (w + gw > cols) push()
      if (pos === cursor) place()
      row += shown
      w += gw
      pos += g.length
      // a row that is exactly full keeps its cursor at the wrap column; the
      // next grapheme decides whether a new row starts
    }
  }
  if (pos === cursor) {
    if (w >= cols) { push(); }
    place()
  }
  rows.push(row)
  void rowIsFirstOfLine
  return { rows, cursorRow, cursorCol }
}
