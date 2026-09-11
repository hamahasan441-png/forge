/**
 * forge — streaming structured-markdown renderer (zero dependencies)
 *
 * The interactive UI streams model output token by token. Raw walls of text
 * are hard to read, so this renderer turns the stream into structure WITHOUT
 * stopping the stream:
 *
 *   - complete lines are rendered (headings, lists, quotes, fences, tables)
 *     and promoted to durable scrollback as soon as their newline arrives;
 *   - the current incomplete line stays LIVE through the terminal's partial
 *     mechanism (term.setPartial), so streaming never stalls;
 *   - block state (code fence, list, quote) survives chunk boundaries;
 *   - nothing here does I/O on its own — the caller owns the terminal
 *     coordinator, which keeps the render lock intact.
 *
 * Styling is theme-driven (o.th) and symbol-driven (o.sym), so the same
 * structure reads correctly with NO_COLOR, FORGE_ASCII and FORGE_A11Y.
 */
import { displayWidth, stripAnsi } from "./render.js"

const TOKEN_RE = /`[^`\n]*`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\)/g
const HEAD_RE = /^(#{1,6})\s+(.+)$/
const UL_RE = /^(\s*)[-*+]\s+(.*)$/
const OL_RE = /^(\s*)(\d+)[.)]\s+(.*)$/
const TASK_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/
const QUOTE_RE = /^>\s?(.*)$/
const HR_RE = /^(\s*)(?:-{3,}|\*{3,}|_{3,})\s*$/
const FENCE_RE = /^\s*```(\S*)\s*$/
const TABLE_RE = /^\s*\|.*\|\s*$/

/** Render inline spans: `code`, **bold**, [text](url). Never throws. */
export function renderInline(s, o) {
  const str = String(s ?? "")
  if (!str) return str
  let out = ""
  let last = 0
  TOKEN_RE.lastIndex = 0
  let m
  while ((m = TOKEN_RE.exec(str))) {
    out += str.slice(last, m.index)
    const tok = m[0]
    if (tok.startsWith("`")) out += o.th.info(tok.slice(1, -1))
    else if (tok.startsWith("**")) out += o.th.primary(tok.slice(2, -2))
    else {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)
      if (mm) out += mm[1] + o.th.muted(` (${mm[2]})`)
      else out += tok
    }
    last = m.index + tok.length
  }
  out += str.slice(last)
  return out
}

/** Render one COMPLETE line (no "\n") given the current block context.
 *  Returns { text, next } — `next` is the block state for the next line. */
export function renderLine(line, state, o) {
  const s = state || { fence: null, list: 0, quote: false }
  // ---- inside a fence ----------------------------------------------------
  if (s.fence !== null) {
    if (FENCE_RE.test(line)) return { text: o.th.muted("```"), next: { ...s, fence: null } }
    const lang = s.fence.toLowerCase()
    if (lang === "diff" || lang === "patch") {
      if (line.startsWith("+++") || line.startsWith("---")) return { text: o.th.accent(line), next: s }
      if (line.startsWith("+")) return { text: o.th.success(line), next: s }
      if (line.startsWith("-")) return { text: o.th.error(line), next: s }
      if (line.startsWith("@@")) return { text: o.th.accent(line), next: s }
      return { text: o.th.info(line), next: s }
    }
    if (lang === "bash" || lang === "sh" || lang === "shell" || lang === "console") return { text: o.th.info(line), next: s }
    return { text: s.fence.startsWith("diff") ? o.th.info(line) : o.th.info(line), next: s }
  }
  // ---- fences ------------------------------------------------------------
  const fm = FENCE_RE.exec(line)
  if (fm) return { text: o.th.muted(`\`\`\`${fm[1] ? " " + fm[1] : ""}`), next: { ...s, fence: fm[1] || "text" } }
  if (HR_RE.test(line)) return { text: o.th.muted((o.sym?.rule || "─").repeat(Math.min(24, 36))), next: s }
  // ---- headings ----------------------------------------------------------
  const hm = HEAD_RE.exec(line)
  if (hm) {
    const lvl = hm[1].length
    const label = renderInline(hm[2].trim(), o)
    if (lvl <= 2) return { text: o.th.accent(o.sym.bullet) + " " + o.th.primary(label), next: s }
    if (lvl <= 4) return { text: o.th.primary(label), next: s }
    return { text: label, next: s }
  }
  // ---- task / bullet / ordered lists -------------------------------------
  const tm = TASK_RE.exec(line)
  if (tm) {
    const mark = /x/i.test(tm[2]) ? o.th.success(`${o.sym.ok} `) : o.th.muted(`${o.sym.todo} `)
    return { text: "  ".repeat(Math.floor(tm[1].length / 2)) + mark + renderInline(tm[3], o), next: { ...s, list: 1 } }
  }
  const um = UL_RE.exec(line)
  if (um) {
    return { text: "  ".repeat(Math.floor(um[1].length / 2)) + o.sym.bullet + " " + renderInline(um[2], o), next: { ...s, list: 1 } }
  }
  const om = OL_RE.exec(line)
  if (om) {
    return { text: "  ".repeat(Math.floor(om[1].length / 2)) + om[2] + ". " + renderInline(om[3], o), next: { ...s, list: 1 } }
  }
  // ---- blockquote --------------------------------------------------------
  const qm = QUOTE_RE.exec(line)
  if (qm) return { text: o.th.muted(`${o.sym.branch} ${renderInline(qm[1], o)}`), next: { ...s, quote: true } }
  // ---- tables (light: keep cells, dim separators, no full alignment) -----
  if (TABLE_RE.test(line)) {
    const cells = line.replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => c.trim())
    if (!cells.some((c) => /^:?-{2,}:?$/.test(c))) return { text: cells.join(o.th.muted(` ${o.sym.branch} `)), next: s }
    return { text: "", next: s }
  }
  // ---- paragraph ---------------------------------------------------------
  return { text: renderInline(line, o), next: { ...s, list: 0, quote: false } }
}

/** Stateful streaming renderer bound to a terminal coordinator. */
export function createMarkdownStream({ term, o } = {}) {
  let buf = "" // raw text still waiting for a newline
  let seeded = false // adopted the terminal's existing partial on first feed
  let state = { fence: null, list: 0, quote: false }
  const MAX_TAIL = 64 * 1024

  function emitLine(raw) {
    const { text, next } = renderLine(raw, state, o)
    state = next
    term.setPartial("")
    term.out(text + "\n")
  }

  /** Feed a text delta. Complete lines are styled and promoted; the
   *  incomplete tail stays live via term.setPartial. The FIRST feed of a
   *  round adopts any text already sitting in the terminal partial (e.g.
   *  reasoning streamed before the answer) so nothing is lost on promote. */
  function feed(text) {
    if (!seeded) {
      seeded = true
      buf = stripAnsi(term.partial ?? "")
      term.setPartial(buf)
    }
    buf += String(text ?? "")
    if (buf.length > MAX_TAIL) { // a pathological line: flush raw, never grow
      term.setPartial("")
      term.out(buf + "\n")
      buf = ""
      return
    }
    let nl
    while ((nl = buf.indexOf("\n")) !== -1) {
      const raw = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      emitLine(raw)
    }
    if (buf) term.setPartial(buf)
  }

  /** Promote any incomplete tail as a final styled line. */
  function finish() {
    if (buf) {
      const raw = buf
      buf = ""
      emitLine(raw)
    } else {
      term.setPartial("")
    }
    seeded = false
    state = { fence: null, list: 0, quote: false }
  }

  /** Drop everything (used when the caller aborts the answer). */
  function reset() {
    buf = ""
    seeded = false
    state = { fence: null, list: 0, quote: false }
    term.setPartial("")
  }

  return { feed, finish, reset, get state() { return state }, get tail() { return buf } }
}

/** Render a complete text block (non-streaming, for tests / replays). */
export function renderBlock(text, o, width = 80) {
  const out = []
  let state = { fence: null, list: 0, quote: false }
  for (const line of String(text ?? "").split("\n")) {
    const r = renderLine(line, state, o)
    state = r.next
    if (r.text && displayWidth(r.text) > width - 1) {
      // keep rows within the terminal; terminal wrapping handles the rest
      out.push(r.text.slice(0, Math.max(0, width)))
    } else out.push(r.text)
  }
  return out
}
