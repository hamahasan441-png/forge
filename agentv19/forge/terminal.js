/**
 * forge — terminal rendering coordinator (zero dependencies)
 *
 * THE single owner of the terminal while forge is interactive. Every byte that
 * reaches the screen passes through here, which is what makes the following
 * guarantees possible:
 *
 *   render lock     output arriving while the user types never corrupts the
 *                   prompt: the live region (status, dock, input) is erased,
 *                   the durable output is written, the live region is redrawn
 *                   with the same text and cursor — in ONE write() call.
 *   streaming       a partial line (no "\n" yet) lives in the live region and
 *                   is redrawn in place; completed lines are promoted to the
 *                   durable scrollback. No "Thinking… Thinking… Thinking…".
 *   bracketed paste ESC[200~ … ESC[201~ is captured whole (any size, any
 *                   number of chunks) and inserted atomically — pasted
 *                   newlines never submit lines early.
 *   input           raw-mode key decoding → editor.js (Unicode-safe cursor,
 *                   multiline, history, Ctrl-R search, completion).
 *   resize          SIGWINCH recomputes the layout and redraws; input and
 *                   cursor survive.
 *   console capture console.log / console.error / process.stdout.write from
 *                   any module are routed through the coordinator while it is
 *                   active, so no subsystem can write behind its back.
 *
 * Screen model (bottom of the terminal, redrawn as a unit):
 *
 *   ┌ durable scrollback (already written, never touched again)
 *   │ …
 *   ├ live region ─────────────────────────────────────────────
 *   │  partial streamed line (wrapped)          ← optional
 *   │  dock rows (header, task panel)           ← from setDock()
 *   │  status row (● Thinking 14.2s)            ← from setStatus()
 *   │  completion candidates                    ← transient
 *   │  prompt + input rows (wrapped, multiline) ← editor
 *   │  search row (reverse-i-search)            ← while Ctrl-R is active
 *   └───────────────────────────────────────────────────────────
 *
 * Every live row is pre-wrapped to columns-1 cells so the terminal never
 * enters its pending-wrap state — which is the one situation where the
 * cursor arithmetic used to erase the region would drift.
 *
 * In non-TTY (piped) mode the coordinator degrades to plain writes: no raw
 * mode, no live region, no capture — output is byte-identical to a plain
 * console.log() program, which the e2e suite depends on.
 */
import util from "node:util"
import readline from "node:readline"
import { createKeyDecoder } from "./keys.js"
import { createEditor, layout } from "./editor.js"
import { displayWidth, fit, wrapAnsi, stripAnsi, renderColumns, detectDialect, renderOptions } from "./render.js"

const ESC = "\x1b"
const CSI = ESC + "["
const HIDE = CSI + "?25l", SHOW = CSI + "?25h"
const PASTE_ON = CSI + "?2004h", PASTE_OFF = CSI + "?2004l"
const CLEAR_BELOW = CSI + "J"
const CLEAR_SCREEN = CSI + "2J" + CSI + "H"
const MAX_PARTIAL_ROWS = 6 // a streamed paragraph longer than this is soft-flushed to scrollback
const RENDER_DEBOUNCE_MS = 16
const ESC_TIMEOUT_MS = 40

export function createTerminal({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  columns,
  rows,
  ascii,
  a11y,
  forceTTY,
} = {}) {
  const tty = forceTTY ?? !!(input && input.isTTY && output && output.isTTY)
  const dialect = detectDialect(env)
  const opts = renderOptions({ ascii: ascii ?? dialect.ascii, a11y: a11y ?? dialect.a11y })
  const rawWrite = output.write.bind(output)

  let cols = Math.max(20, columns || output.columns || 80)
  let lines = Math.max(6, rows || output.rows || 24)

  // live region state
  let liveRows = 0 // rows currently occupied by the live region
  let liveCursorRow = 0 // which of those rows the cursor is on
  let partial = "" // streamed text without a trailing newline (durable-in-waiting)
  let dockFn = null // () => string[]
  let status = null // string | null
  let hint = [] // completion candidate rows
  let prompt = "forge > "
  let contPrompt = "... "
  let active = false // raw-mode interactive session running
  let visible = true // live region drawn (false while an external program owns the screen)
  let renderTimer = null
  let escTimer = null
  let lastFrame = [] // rows of the last live render (for tests / redraw-on-resize)
  let question = null // { resolve, single, keys, saved, promptText }
  let editor = createEditor()
  let callbacks = {}
  let closed = false
  let suspended = false
  let pendingCtrlC = 0
  let hideInput = false // monitor mode (forge agent in a TTY): dock + status only
  let pendingDurable = "" // durable text waiting for the next frame (batches console.log bursts)
  let flushTimer = null
  let exitHook = null

  const decoder = createKeyDecoder()

  // ---- helpers -----------------------------------------------------------
  const width = () => cols
  const rowsAvail = () => lines

  function eraseLive() {
    if (!liveRows) return ""
    let s = "\r"
    if (liveCursorRow > 0) s += CSI + liveCursorRow + "A"
    s += CLEAR_BELOW
    liveRows = 0
    liveCursorRow = 0
    return s
  }

  /** Compose the live region rows + the cursor position within them. */
  function composeLive() {
    const w = cols - 1
    const out = []
    let cursorRow = 0, cursorCol = 0
    if (partial) for (const r of wrapAnsi(partial, w, { words: false })) out.push(r)
    if (dockFn && visible) {
      let rowsForDock = []
      try { rowsForDock = dockFn(cols, lines) || [] } catch { rowsForDock = [] }
      for (const r of rowsForDock) out.push(fit(r, w))
    }
    if (status) out.push(fit(status, w))
    for (const h of hint) out.push(fit(h, w))
    const q = question
    if (hideInput && !q) {
      // monitor mode: no input row; park the cursor at the end of the region
      if (!out.length) out.push("")
      lastFrame = out
      return { rows: out, cursorRow: out.length - 1, cursorCol: displayWidth(out[out.length - 1]) }
    }
    const pText = q ? q.promptText : prompt
    const pw = displayWidth(pText)
    const cw = displayWidth(contPrompt)
    const lay = layout(editor.text, editor.cursor, w, pw, cw)
    const inputRows = lay.rows.map((r, i) => (i === 0 ? pText : contPrompt) + r)
    // keep an oversized input within the screen: window around the cursor
    const budget = Math.max(3, lines - 2 - out.length)
    let first = 0
    if (inputRows.length > budget) {
      first = Math.max(0, Math.min(lay.cursorRow - Math.floor(budget / 2), inputRows.length - budget))
    }
    const shown = inputRows.slice(first, first + budget)
    cursorRow = out.length + (lay.cursorRow - first)
    cursorCol = lay.cursorCol
    for (const r of shown) out.push(r)
    if (editor.searching) {
      const s = editor.search
      const label = s.failed ? "(failed reverse-i-search)" : "(reverse-i-search)"
      out.push(fit(opts.th.muted(`${label}'${s.query}': `) + (s.match != null ? fit(s.match.split("\n")[0], 40) : ""), w))
    }
    // the whole region must fit on screen; drop from the top (partial rows) if it does not
    while (out.length > lines - 1 && out.length > shown.length) { out.shift(); cursorRow-- }
    return { rows: out, cursorRow: Math.max(0, cursorRow), cursorCol }
  }

  function drawLive(prefix = "") {
    const { rows: live, cursorRow, cursorCol } = composeLive()
    let s = prefix
    s += live.join("\n")
    const up = live.length - 1 - cursorRow
    if (up > 0) s += CSI + up + "A"
    s += "\r"
    if (cursorCol > 0) s += CSI + cursorCol + "C"
    liveRows = live.length
    liveCursorRow = cursorRow
    lastFrame = live
    return s
  }

  /** Full frame: erase live → durable → redraw live. One write. */
  function frame(durable = "") {
    if (flushTimer) { clearImmediate(flushTimer); flushTimer = null }
    const all = pendingDurable + durable
    pendingDurable = ""
    if (!tty || !active || suspended) {
      if (all) rawWrite(all)
      return
    }
    let s = HIDE + eraseLive()
    if (all) s += all
    s += drawLive()
    s += SHOW
    rawWrite(s)
  }

  /** Queue durable text; a burst of synchronous lines becomes ONE frame. */
  function queueDurable(text) {
    pendingDurable += text
    if (pendingDurable.length > 64 * 1024) { frame(); return }
    if (!flushTimer) flushTimer = setImmediate(() => { flushTimer = null; if (!closed) frame() })
  }

  function scheduleRender() {
    if (!tty || !active) return
    if (renderTimer) return
    renderTimer = setTimeout(() => { renderTimer = null; if (!closed) frame() }, RENDER_DEBOUNCE_MS)
  }

  /** Split incoming text into durable complete lines + the pending partial. */
  function ingest(text) {
    const t = String(text ?? "")
    if (!t) return ""
    const joined = partial + t.replace(/\r\n?/g, "\n")
    const nl = joined.lastIndexOf("\n")
    let durable = ""
    if (nl === -1) {
      partial = joined
    } else {
      durable = joined.slice(0, nl + 1)
      partial = joined.slice(nl + 1)
    }
    // soft-flush an over-long partial paragraph at a word boundary
    const maxCells = (cols - 1) * MAX_PARTIAL_ROWS
    if (displayWidth(partial) > maxCells) {
      const cut = partial.lastIndexOf(" ", Math.min(partial.length - 1, maxCells))
      const at = cut > maxCells / 2 ? cut + 1 : partial.length
      durable += partial.slice(0, at).replace(/ $/, "") + "\n"
      partial = partial.slice(at)
    }
    return durable
  }

  // ---- key handling ------------------------------------------------------
  function echoSubmitted(text) {
    // the input row becomes a durable transcript line
    const pText = question ? question.promptText : prompt
    const rowsOut = text.split("\n").map((l, i) => (i === 0 ? pText : contPrompt) + l)
    return rowsOut.join("\n") + "\n"
  }

  function submit() {
    hint = []
    if (editor.searching) editor.searchAccept()
    const text = editor.text
    if (question) {
      const q = question
      const echo = q.echo === false ? "" : echoSubmitted(q.mask ? "*".repeat(text.length) : text)
      question = null
      editor = q.saved
      frame(echo)
      q.resolve(text)
      return
    }
    // backslash continuation (legacy multiline) → newline instead of submit
    if (/\\$/.test(text) && !/\\\\$/.test(text) && text.trim()) {
      editor.set(text.slice(0, -1) + "\n", text.length)
      scheduleRender()
      return
    }
    const echo = echoSubmitted(text)
    const committed = text.trim() ? editor.commit() : text
    editor.clear()
    frame(echo)
    if (callbacks.onSubmit) callbacks.onSubmit(committed)
  }

  function handleCtrlC() {
    hint = []
    if (editor.searching) { editor.searchCancel(); scheduleRender(); return }
    if (question) {
      const q = question
      question = null
      editor = q.saved
      frame("\n")
      q.resolve(null)
      return
    }
    const hadText = !hideInput && editor.text.length > 0
    if (hadText) { editor.clear(); pendingCtrlC = 0; scheduleRender() }
    const r = callbacks.onCancel ? callbacks.onCancel({ hadText }) : "exit"
    if (r === "exit" && hideInput) { callbacks.onEOF?.(); return }
    if (r === "exit" && !hadText) {
      pendingCtrlC++
      if (pendingCtrlC >= 2) { callbacks.onEOF?.(); return }
      setStatus(opts.th.muted("press Ctrl+C again to exit, Ctrl+D also exits"))
      setTimeout(() => { if (pendingCtrlC) { pendingCtrlC = 0; if (status && /again to exit/.test(stripAnsi(status))) setStatus(null) } }, 2000)
    } else pendingCtrlC = 0
  }

  function complete() {
    if (!callbacks.completer) return
    const before = editor.text.slice(0, editor.cursor)
    let res
    try { res = callbacks.completer(before, editor.text) } catch { res = null }
    if (!res) return
    const { candidates = [], replaceFrom = 0 } = res
    if (!candidates.length) { hint = []; scheduleRender(); return }
    const stem = before.slice(replaceFrom)
    if (candidates.length === 1) {
      const c = candidates[0]
      editor.set(editor.text.slice(0, replaceFrom) + c + (c.endsWith("/") ? "" : " ") + editor.text.slice(editor.cursor), replaceFrom + c.length + (c.endsWith("/") ? 0 : 1))
      hint = []
      scheduleRender()
      return
    }
    // common prefix
    let pref = candidates[0]
    for (const c of candidates) { let i = 0; while (i < pref.length && i < c.length && pref[i] === c[i]) i++; pref = pref.slice(0, i) }
    if (pref.length > stem.length) {
      editor.set(editor.text.slice(0, replaceFrom) + pref + editor.text.slice(editor.cursor), replaceFrom + pref.length)
    }
    hint = renderColumns(candidates.slice(0, 40), cols, opts)
    if (candidates.length > 40) hint.push(opts.th.muted(`  … ${candidates.length - 40} more`))
    scheduleRender()
  }

  function onKey(ev) {
    if (closed) return
    if (ev.type === "paste") {
      if ((question && question.single) || (hideInput && !question)) return
      editor.insert(ev.text)
      hint = []
      scheduleRender()
      return
    }
    if (ev.type === "text") {
      if (hideInput && !question) return
      if (question && question.single) {
        const k = ev.text.toLowerCase()
        if (question.keys.includes(k)) {
          const q = question
          question = null
          editor = q.saved
          frame(q.promptText + k + "\n")
          q.resolve(k)
        }
        return
      }
      if (editor.searching) { editor.searchType(ev.text); scheduleRender(); return }
      editor.insert(ev.text)
      hint = []
      pendingCtrlC = 0
      if (status && /again to exit/.test(stripAnsi(status))) status = null
      scheduleRender()
      return
    }
    if (ev.type !== "key") return
    const { name, ctrl, alt } = ev
    if (hideInput && !question) {
      if (ctrl && name === "c") handleCtrlC()
      else if (ctrl && name === "d") callbacks.onEOF?.()
      else if (ctrl && name === "l") clearScreen()
      return
    }
    if (question && question.single) {
      if (name === "enter" && question.dflt) { const q = question; question = null; editor = q.saved; frame(q.promptText + q.dflt + "\n"); q.resolve(q.dflt); return }
      if (name === "escape" || (ctrl && name === "c") || (ctrl && name === "d")) { const q = question; question = null; editor = q.saved; frame("\n"); q.resolve(null) }
      return
    }
    // search mode captures most keys
    if (editor.searching) {
      if (ctrl && name === "r") { editor.searchNext(); scheduleRender(); return }
      if (name === "backspace") { editor.searchBackspace(); scheduleRender(); return }
      if (name === "escape" || (ctrl && name === "g")) { editor.searchCancel(); scheduleRender(); return }
      if (name === "enter") { submit(); return }
      if (ctrl && name === "c") { handleCtrlC(); return }
      // any other key accepts the match and is then processed normally
      editor.searchAccept()
    }
    if (ctrl) {
      switch (name) {
        case "c": handleCtrlC(); return
        case "d":
          if (editor.text.length === 0) { callbacks.onEOF?.(); return }
          editor.delete(); scheduleRender(); return
        case "a": editor.home(); break
        case "e": editor.end(); break
        case "b": editor.left(); break
        case "f": editor.right(); break
        case "w": case "backspace": editor.deleteWordLeft(); break
        case "k": editor.killToEnd(); break
        case "u": editor.killToStart(); break
        case "y": editor.yank(); break
        case "t": editor.transpose(); break
        case "l": clearScreen(); return
        case "r": editor.searchStart(); break
        case "j": case "enter": editor.newline(); break
        case "z": suspend(); return
        case "left": editor.wordLeft(); break
        case "right": editor.wordRight(); break
        case "p": if (!editor.historyPrev()) return; break
        case "n": if (!editor.historyNext()) return; break
        default: return
      }
      hint = []
      scheduleRender()
      return
    }
    if (alt) {
      switch (name) {
        case "b": case "left": editor.wordLeft(); break
        case "f": case "right": editor.wordRight(); break
        case "d": editor.deleteWordRight(); break
        case "backspace": editor.deleteWordLeft(); break
        case "enter": editor.newline(); break
        default: return
      }
      hint = []
      scheduleRender()
      return
    }
    switch (name) {
      case "enter": submit(); return
      case "backspace": editor.backspace(); break
      case "delete": editor.delete(); break
      case "left": editor.left(); break
      case "right": editor.right(); break
      case "home": editor.home(); break
      case "end": editor.end(); break
      case "up":
        if (editor.lines > 1 && editor.lineUp()) break
        if (editor.text && editor.history.length && !editor.text.includes("\n") && editor.cursor === editor.text.length ? !editor.historyPrevPrefix() : !editor.historyPrev()) return
        break
      case "down":
        if (editor.lines > 1 && editor.lineDown()) break
        if (!editor.historyNext()) return
        break
      case "tab": complete(); return
      case "escape": hint = []; break
      case "pageup": case "pagedown": case "insert": return
      default: return
    }
    hint = []
    pendingCtrlC = 0
    scheduleRender()
  }

  function onData(chunk) {
    if (closed || suspended) return
    let events
    try { events = decoder.feed(chunk) } catch { events = [] }
    for (const ev of events) onKey(ev)
    if (escTimer) { clearTimeout(escTimer); escTimer = null }
    if (decoder.pending) escTimer = setTimeout(() => { escTimer = null; for (const ev of decoder.flush()) onKey(ev) }, ESC_TIMEOUT_MS)
  }

  function onResize() {
    const prevCols = cols
    cols = Math.max(20, output.columns || cols)
    lines = Math.max(6, output.rows || lines)
    callbacks.onResize?.({ columns: cols, rows: lines })
    if (!tty || !active || suspended) return
    // After a resize the terminal has reflowed (or clipped) the live region,
    // so its old geometry is unreliable. A narrower terminal rewraps our rows
    // into MORE rows (cursor row drifts); a shorter one may have scrolled
    // rows away. Redraw from a clean slate: erase from the best-known top of
    // the region (never more than the screen height) and paint again with the
    // same editor text and cursor — nothing the user typed is lost.
    if (cols < prevCols || liveRows > lines - 1) {
      // rows above the cursor may have wrapped: estimate how many extra rows
      const wrapped = lastFrame.reduce((n, r) => n + Math.max(0, Math.ceil(Math.max(1, displayWidth(stripAnsi(r))) / cols) - 1), 0)
      liveCursorRow = Math.min(lines - 1, liveCursorRow + wrapped)
      liveRows = Math.min(lines - 1, liveRows + wrapped)
    }
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null }
    frame()
  }

  function onEnd() { if (!closed) callbacks.onEOF?.() }

  // ---- public surface ----------------------------------------------------
  function setStatus(text) {
    const next = text ? String(text) : null
    if (next === status) return
    status = next
    scheduleRender()
  }

  function clearScreen() {
    if (!tty || !active) { rawWrite(CLEAR_SCREEN); return }
    liveRows = 0
    liveCursorRow = 0
    rawWrite(CLEAR_SCREEN)
    frame()
  }

  function suspend() {
    if (!tty || !active) return
    try {
      const saved = eraseLive()
      rawWrite(saved + PASTE_OFF + SHOW)
      input.setRawMode(false)
      suspended = true
      process.once("SIGCONT", () => {
        try { input.setRawMode(true) } catch {}
        suspended = false
        rawWrite(PASTE_ON)
        frame()
      })
      process.kill(process.pid, "SIGTSTP")
    } catch { suspended = false }
  }

  let hooked = null
  function hookConsole() {
    if (hooked || !tty) return
    hooked = { log: console.log, error: console.error, warn: console.warn, info: console.info, write: output.write, ewrite: process.stderr.write }
    const toLine = (...a) => term.line(util.format(...a))
    console.log = toLine
    console.info = toLine
    console.error = toLine
    console.warn = toLine
    output.write = (chunk, enc, cb) => {
      term.out(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk))
      if (typeof enc === "function") enc()
      else if (typeof cb === "function") cb()
      return true
    }
    if (process.stderr.isTTY) {
      process.stderr.write = (chunk, enc, cb) => {
        term.out(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk))
        if (typeof enc === "function") enc()
        else if (typeof cb === "function") cb()
        return true
      }
    }
  }
  function unhookConsole() {
    if (!hooked) return
    console.log = hooked.log; console.error = hooked.error; console.warn = hooked.warn; console.info = hooked.info
    output.write = hooked.write
    process.stderr.write = hooked.ewrite
    hooked = null
  }

  const term = {
    tty,
    opts,
    get columns() { return cols },
    get rows() { return lines },
    get editor() { return editor },
    get active() { return active },
    get partial() { return partial },
    get lastFrame() { return lastFrame },
    get busyQuestion() { return !!question },
    get hideInput() { return hideInput },
    setHideInput(v) { hideInput = !!v; scheduleRender() },

    /** Enter interactive mode. */
    start({ prompt: p, continuation, history = [], onSubmit, onCancel, onEOF, completer, onResize: onRs, hideInput: hide = false } = {}) {
      callbacks = { onSubmit, onCancel, onEOF, completer, onResize: onRs }
      hideInput = !!hide
      if (p) prompt = p
      if (continuation) contPrompt = continuation
      editor = createEditor({ history })
      if (!tty) return term
      active = true
      try { input.setRawMode(true) } catch {}
      input.resume()
      input.on("data", onData)
      input.on("end", onEnd)
      output.on("resize", onResize)
      rawWrite(PASTE_ON)
      hookConsole()
      // crash safety: whatever ends the process, the user's shell gets a sane
      // terminal back (cooked mode, cursor visible, bracketed paste off) and no
      // queued output is lost
      exitHook = () => { try { term.stop() } catch {} }
      process.once("exit", exitHook)
      frame()
      return term
    },

    /** Leave interactive mode, restoring the terminal. */
    stop() {
      if (closed) return
      closed = true
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null }
      if (escTimer) { clearTimeout(escTimer); escTimer = null }
      if (flushTimer) { clearImmediate(flushTimer); flushTimer = null }
      unhookConsole()
      if (exitHook) { process.removeListener("exit", exitHook); exitHook = null }
      if (!tty || !active) { if (pendingDurable) { rawWrite(pendingDurable); pendingDurable = "" } return }
      active = false
      const flushed = pendingDurable + (partial ? partial + "\n" : "")
      pendingDurable = ""
      partial = ""
      let s = eraseLive() + flushed + PASTE_OFF + SHOW
      rawWrite(s)
      try { input.setRawMode(false) } catch {}
      input.removeListener("data", onData)
      input.removeListener("end", onEnd)
      output.removeListener("resize", onResize)
      try { input.pause() } catch {}
    },

    /** Durable output; text without a trailing newline stays live (streaming). */
    out(text) {
      const durable = ingest(text)
      if (!tty || !active || suspended) {
        if (durable) rawWrite(durable)
        // in plain mode the partial is written straight through
        if (partial) { rawWrite(partial); partial = "" }
        return
      }
      if (durable) queueDurable(durable)
      else scheduleRender()
    },
    /** One complete durable line (flushes any pending partial first). */
    line(text = "") {
      const s = String(text ?? "")
      const head = partial ? "\n" : ""
      term.out(head + s + "\n")
    },
    /** Several lines at once (one frame). */
    lines(list) {
      if (!list?.length) return
      term.out((partial ? "\n" : "") + list.join("\n") + "\n")
    },
    /** End a streamed paragraph: promote the partial to scrollback. */
    endStream() {
      if (partial) term.out("\n")
    },
    /** Force queued durable output onto the screen now. */
    flush() { if (pendingDurable || flushTimer) frame() },

    setDock(fn) { dockFn = typeof fn === "function" ? fn : null; scheduleRender() },
    setStatus,
    setPrompt(p) { prompt = String(p ?? prompt); scheduleRender() },
    setContinuation(p) { contPrompt = String(p ?? contPrompt); scheduleRender() },
    /** Hide the live region (another program owns the screen) / show it again. */
    setVisible(v) { visible = !!v; if (tty && active) frame() },
    render() { if (tty && active) frame() },
    scheduleRender,
    clearScreen,

    /**
     * Ask a question inline. Resolves with the typed text, `null` on Ctrl-C /
     * Esc. `{ single: true, keys: ["r","v"] }` resolves on one keypress.
     */
    ask(promptText, { single = false, keys = [], dflt = "", mask = false, echo = true } = {}) {
      if (!tty || !active) {
        return new Promise((resolve) => {
          const r = readline.createInterface({ input, output })
          r.question(promptText, (a) => { r.close(); resolve(String(a ?? "").trim()) })
        })
      }
      return new Promise((resolve) => {
        const saved = editor
        editor = createEditor()
        question = { resolve, single, keys: keys.map((k) => String(k).toLowerCase()), saved, promptText: String(promptText), dflt, mask, echo }
        hint = []
        frame()
      })
    },

    /** Pause interactive rendering around an external full-screen program. */
    async withRawSuspended(fn) {
      if (!tty || !active) return fn()
      const s = eraseLive()
      rawWrite(s + PASTE_OFF + SHOW)
      try { input.setRawMode(false) } catch {}
      input.removeListener("data", onData)
      suspended = true
      try { return await fn() } finally {
        suspended = false
        try { input.setRawMode(true) } catch {}
        input.on("data", onData)
        rawWrite(PASTE_ON)
        frame()
      }
    },

    /** Test hook: feed raw bytes as if typed. */
    _feed(bytes) { onData(Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "utf8")) },
    _flushEsc() { if (escTimer) { clearTimeout(escTimer); escTimer = null } for (const ev of decoder.flush()) onKey(ev) },
    _renderNow() { if (renderTimer) { clearTimeout(renderTimer); renderTimer = null } frame() },
    _resize(c, r) { cols = Math.max(20, c || cols); lines = Math.max(6, r || lines); onResize() },
    _state() { return { liveRows, liveCursorRow, partial, status, prompt, cols, lines, question: !!question } },
  }
  return term
}
