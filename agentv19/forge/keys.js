/**
 * forge — raw terminal input decoder (zero dependencies)
 *
 * Turns the byte stream of a raw-mode TTY into key events:
 *
 *   { type: "text",  text }                     printable characters (batched)
 *   { type: "key",   name, ctrl, alt, shift }   named keys: left right up down
 *                                               home end delete backspace tab
 *                                               enter escape pageup pagedown
 *                                               insert f1…f12, or a letter for
 *                                               Ctrl/Alt chords ("a" with ctrl)
 *   { type: "paste", text }                     one bracketed paste, atomically
 *   { type: "focus", in }                       focus in/out reports (ignored upstream)
 *
 * Robust to the two things naive decoders get wrong:
 *   1. escape sequences split across `data` chunks (SSH, slow links) — an
 *      incomplete CSI/SS3 prefix is buffered until the next chunk or flush();
 *   2. a lone ESC keypress — reported only when flush() is called after a
 *      short quiet period, never by guessing.
 *
 * Bracketed paste (ESC[200~ … ESC[201~) is collected in full — across any
 * number of chunks — and delivered as ONE event. Nothing inside a paste is
 * ever interpreted as a key, so pasted newlines can never submit lines early.
 */
import { StringDecoder } from "node:string_decoder"

const PASTE_START = "\x1b[200~"
const PASTE_END = "\x1b[201~"
const PASTE_CAP = 8 * 1024 * 1024 // a paste larger than 8 MB is truncated, never dropped

const CSI_FINAL = {
  A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "tab", // Z = shift-tab
  P: "f1", Q: "f2", R: "f3", S: "f4",
}
const CSI_TILDE = {
  1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end",
  11: "f1", 12: "f2", 13: "f3", 14: "f4", 15: "f5", 17: "f6", 18: "f7", 19: "f8", 20: "f9", 21: "f10", 23: "f11", 24: "f12",
}
const SS3 = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", P: "f1", Q: "f2", R: "f3", S: "f4", M: "enter" }

function modifiers(n) {
  // xterm: 1 + (shift=1, alt=2, ctrl=4, meta=8)
  const m = Math.max(0, (Number(n) || 1) - 1)
  return { shift: !!(m & 1), alt: !!(m & 2), ctrl: !!(m & 4) }
}

export function createKeyDecoder() {
  const decoder = new StringDecoder("utf8")
  let pending = "" // undecoded tail (partial escape sequence)
  let inPaste = false
  let paste = ""
  let pasteTruncated = false

  /** Parse one escape sequence at str[0] === ESC. Returns [event|null, consumed] or [null, 0] if incomplete. */
  function parseEscape(str) {
    if (str.length === 1) return [null, 0] // need more (or a flush)
    const c1 = str[1]
    if (c1 === "[") {
      // CSI: ESC [ params final(0x40-0x7e)
      let i = 2
      while (i < str.length && ((str.charCodeAt(i) >= 0x30 && str.charCodeAt(i) <= 0x3f) || str[i] === ";")) i++
      // intermediate bytes 0x20-0x2f
      while (i < str.length && str.charCodeAt(i) >= 0x20 && str.charCodeAt(i) <= 0x2f) i++
      if (i >= str.length) return [null, 0]
      const final = str[i]
      const params = str.slice(2, i)
      const seq = str.slice(0, i + 1)
      if (seq === PASTE_START) return [{ type: "paste-start" }, i + 1]
      if (seq === PASTE_END) return [{ type: "paste-end" }, i + 1]
      if (final === "I") return [{ type: "focus", in: true }, i + 1]
      if (final === "O") return [{ type: "focus", in: false }, i + 1]
      const parts = params.split(";")
      if (final === "~") {
        const name = CSI_TILDE[parts[0]]
        if (!name) return [{ type: "unknown", seq }, i + 1]
        return [{ type: "key", name, ...modifiers(parts[1]) }, i + 1]
      }
      if (final === "u") {
        // kitty keyboard protocol: CSI codepoint ; mods u
        const cp = Number(parts[0])
        const mods = modifiers(parts[1])
        if (cp === 13) return [{ type: "key", name: "enter", ...mods }, i + 1]
        if (cp === 9) return [{ type: "key", name: "tab", ...mods }, i + 1]
        if (cp === 27) return [{ type: "key", name: "escape", ...mods }, i + 1]
        if (cp === 127 || cp === 8) return [{ type: "key", name: "backspace", ...mods }, i + 1]
        if (cp > 31) {
          const ch = String.fromCodePoint(cp)
          if (mods.ctrl || mods.alt) return [{ type: "key", name: ch.toLowerCase(), ...mods }, i + 1]
          return [{ type: "text", text: mods.shift ? ch.toUpperCase() : ch }, i + 1]
        }
        return [{ type: "unknown", seq }, i + 1]
      }
      const name = CSI_FINAL[final]
      if (!name) return [{ type: "unknown", seq }, i + 1]
      const mods = final === "Z" ? { shift: true, alt: false, ctrl: false } : modifiers(parts[1] ?? (parts[0] && parts.length === 1 && final !== "~" && Number(parts[0]) > 1 ? parts[0] : undefined))
      return [{ type: "key", name, ...mods }, i + 1]
    }
    if (c1 === "O") {
      // SS3: ESC O final  (application cursor keys, F1-F4, keypad enter)
      if (str.length < 3) return [null, 0]
      const name = SS3[str[2]]
      if (!name) return [{ type: "unknown", seq: str.slice(0, 3) }, 3]
      return [{ type: "key", name, ctrl: false, alt: false, shift: false }, 3]
    }
    if (c1 === "\x1b") {
      // ESC ESC → escape (then the second ESC is re-examined)
      return [{ type: "key", name: "escape", ctrl: false, alt: false, shift: false }, 1]
    }
    // Alt + key: ESC followed by a normal char / control char
    const code = c1.charCodeAt(0)
    if (c1 === "\r" || c1 === "\n") return [{ type: "key", name: "enter", ctrl: false, alt: true, shift: false }, 2]
    if (c1 === "\x7f" || c1 === "\b") return [{ type: "key", name: "backspace", ctrl: false, alt: true, shift: false }, 2]
    if (c1 === "\t") return [{ type: "key", name: "tab", ctrl: false, alt: true, shift: false }, 2]
    if (code < 0x20) return [{ type: "key", name: String.fromCharCode(code + 96), ctrl: true, alt: true, shift: false }, 2]
    // may be a multi-code-unit char (surrogate pair)
    const cp = str.codePointAt(1)
    const ch = String.fromCodePoint(cp)
    return [{ type: "key", name: ch.toLowerCase(), ctrl: false, alt: true, shift: ch !== ch.toLowerCase() }, 1 + ch.length]
  }

  function controlKey(ch) {
    const code = ch.charCodeAt(0)
    switch (code) {
      case 0x0d: return { type: "key", name: "enter", ctrl: false, alt: false, shift: false }
      case 0x0a: return { type: "key", name: "enter", ctrl: true, alt: false, shift: false } // Ctrl+J
      case 0x09: return { type: "key", name: "tab", ctrl: false, alt: false, shift: false }
      case 0x7f: return { type: "key", name: "backspace", ctrl: false, alt: false, shift: false }
      case 0x08: return { type: "key", name: "backspace", ctrl: true, alt: false, shift: false } // Ctrl+H / Ctrl+Backspace
      case 0x1b: return { type: "key", name: "escape", ctrl: false, alt: false, shift: false }
      case 0x00: return { type: "key", name: "space", ctrl: true, alt: false, shift: false }
      default: return { type: "key", name: String.fromCharCode(code + 96), ctrl: true, alt: false, shift: false }
    }
  }

  /** Decode as much as possible; keep an incomplete escape sequence pending. */
  function decode(str, final) {
    const events = []
    let i = 0
    let text = ""
    const flushText = () => { if (text) { events.push({ type: "text", text }); text = "" } }
    while (i < str.length) {
      if (inPaste) {
        const end = str.indexOf(PASTE_END, i)
        if (end === -1) {
          // keep a possible partial PASTE_END prefix at the tail out of the payload
          let keep = 0
          for (let k = Math.min(PASTE_END.length - 1, str.length - i); k > 0; k--) {
            if (str.endsWith(PASTE_END.slice(0, k))) { keep = k; break }
          }
          const chunk = str.slice(i, str.length - keep)
          if (paste.length + chunk.length <= PASTE_CAP) paste += chunk
          else if (!pasteTruncated) { paste += chunk.slice(0, Math.max(0, PASTE_CAP - paste.length)); pasteTruncated = true }
          pending = keep ? str.slice(str.length - keep) : ""
          if (final && pending) { paste += pending; pending = "" }
          return events
        }
        const chunk = str.slice(i, end)
        if (paste.length + chunk.length <= PASTE_CAP) paste += chunk
        else if (!pasteTruncated) { paste += chunk.slice(0, Math.max(0, PASTE_CAP - paste.length)); pasteTruncated = true }
        events.push({ type: "paste", text: paste.replace(/\r\n?/g, "\n"), truncated: pasteTruncated })
        paste = ""; pasteTruncated = false; inPaste = false
        i = end + PASTE_END.length
        continue
      }
      const ch = str[i]
      const code = ch.charCodeAt(0)
      if (code === 0x1b) {
        const [ev, used] = parseEscape(str.slice(i))
        if (used === 0) {
          if (final) {
            // a lone ESC (or an unfinished prefix after a quiet period) → escape key
            flushText()
            events.push({ type: "key", name: "escape", ctrl: false, alt: false, shift: false })
            i += 1
            continue
          }
          flushText()
          pending = str.slice(i)
          return events
        }
        flushText()
        if (ev?.type === "paste-start") { inPaste = true; paste = ""; pasteTruncated = false }
        else if (ev?.type === "paste-end") { /* stray end marker — ignore */ }
        else if (ev) events.push(ev)
        i += used
        continue
      }
      if (code < 0x20 || code === 0x7f) {
        flushText()
        events.push(controlKey(ch))
        i += 1
        continue
      }
      text += ch
      i += 1
    }
    flushText()
    pending = ""
    return events
  }

  return {
    /** Feed a Buffer/string; returns the events decodable so far. */
    feed(chunk) {
      const str = pending + (Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk))
      pending = ""
      return decode(str, false)
    },
    /** Resolve anything still pending (lone ESC after a quiet period). */
    flush() {
      const tail = pending + decoder.end()
      pending = ""
      if (!tail) return []
      return decode(tail, true)
    },
    get pending() { return pending },
    get inPaste() { return inPaste },
  }
}
