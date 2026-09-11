/**
 * tests/vtscreen.mjs — a tiny VT100 screen emulator for UI tests.
 *
 * Feeds raw terminal bytes and keeps a rows×cols character grid, so tests can
 * assert what the USER SEES after a sequence of frames — not what bytes were
 * written. LF is treated as CR+LF, exactly like a PTY with ONLCR (which libuv
 * leaves enabled in raw mode). Supports exactly what forge's coordinator emits: CR, LF, BS, CSI
 * cursor moves (A B C D H), erase (J K, 2J), SGR (ignored), private modes
 * (?25 cursor, ?2004 bracketed paste — recorded), and scrolling when the
 * cursor moves past the last row.
 */
export function createScreen(cols = 80, rows = 24) {
  let grid = Array.from({ length: rows }, () => new Array(cols).fill(" "))
  let x = 0, y = 0
  let cursorVisible = true
  let bracketedPaste = false
  const scrolled = [] // rows that scrolled off the top (durable history)

  function scroll() {
    scrolled.push(grid.shift().join("").replace(/\s+$/, ""))
    grid.push(new Array(cols).fill(" "))
  }
  function lf() {
    if (y === rows - 1) scroll()
    else y++
  }
  function put(ch) {
    if (x >= cols) { x = 0; lf() }
    grid[y][x] = ch
    x++
  }
  function eraseBelow() {
    for (let i = x; i < cols; i++) grid[y][i] = " "
    for (let r = y + 1; r < rows; r++) grid[r].fill(" ")
  }

  function feed(input) {
    const s = Buffer.isBuffer(input) ? input.toString("utf8") : String(input)
    const chars = [...s]
    let i = 0
    while (i < chars.length) {
      const c = chars[i]
      if (c === "\x1b") {
        const next = chars[i + 1]
        if (next === "[") {
          let j = i + 2
          let params = ""
          while (j < chars.length && /[0-9;?<=>]/.test(chars[j])) params += chars[j++]
          while (j < chars.length && chars[j] >= " " && chars[j] <= "/") j++
          const final = chars[j]
          i = j + 1
          const nums = params.replace(/^\?/, "").split(";").map((n) => (n === "" ? null : Number(n)))
          const n1 = nums[0] ?? 1
          switch (final) {
            case "A": y = Math.max(0, y - n1); break
            case "B": y = Math.min(rows - 1, y + n1); break
            case "C": x = Math.min(cols - 1, x + n1); break
            case "D": x = Math.max(0, x - n1); break
            case "G": x = Math.max(0, Math.min(cols - 1, (nums[0] ?? 1) - 1)); break
            case "H": case "f": y = Math.max(0, Math.min(rows - 1, (nums[0] ?? 1) - 1)); x = Math.max(0, Math.min(cols - 1, (nums[1] ?? 1) - 1)); break
            case "J": {
              const mode = nums[0] ?? 0
              if (mode === 0) eraseBelow()
              else if (mode === 2 || mode === 3) { for (const r of grid) r.fill(" ") }
              else if (mode === 1) { for (let r = 0; r < y; r++) grid[r].fill(" "); for (let k = 0; k <= x && k < cols; k++) grid[y][k] = " " }
              break
            }
            case "K": {
              const mode = nums[0] ?? 0
              if (mode === 0) for (let k = x; k < cols; k++) grid[y][k] = " "
              else if (mode === 1) for (let k = 0; k <= x && k < cols; k++) grid[y][k] = " "
              else grid[y].fill(" ")
              break
            }
            case "h": if (params === "?25") cursorVisible = true; if (params === "?2004") bracketedPaste = true; break
            case "l": if (params === "?25") cursorVisible = false; if (params === "?2004") bracketedPaste = false; break
            case "m": default: break // SGR and anything else: ignored
          }
          continue
        }
        if (next === "]") { // OSC … BEL/ST
          let j = i + 2
          while (j < chars.length && chars[j] !== "\x07" && !(chars[j] === "\x1b" && chars[j + 1] === "\\")) j++
          i = chars[j] === "\x07" ? j + 1 : j + 2
          continue
        }
        i += 2 // ESC + one char (e.g. ESC 7 / ESC 8): ignore
        continue
      }
      if (c === "\r") { x = 0; i++; continue }
      if (c === "\n") { x = 0; lf(); i++; continue } // ONLCR: the PTY turns LF into CR+LF (libuv keeps it on in raw mode)
      if (c === "\b") { x = Math.max(0, x - 1); i++; continue }
      if (c === "\x07") { i++; continue }
      if (c < " ") { i++; continue }
      put(c)
      // wide characters occupy two cells
      const cp = c.codePointAt(0)
      if (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd))) put("")
      i++
    }
  }

  return {
    feed,
    get cursor() { return { x, y } },
    get cursorVisible() { return cursorVisible },
    get bracketedPaste() { return bracketedPaste },
    get scrolled() { return scrolled.slice() },
    line(r) { return grid[r].join("").replace(/\s+$/, "") },
    lines() { return grid.map((r) => r.join("").replace(/\s+$/, "")) },
    /** Visible rows (trailing blanks trimmed) as one string. */
    text() { return this.lines().join("\n").replace(/\n+$/, "") },
    /** Everything the user has ever seen: scrolled-off rows + current screen. */
    all() { return [...scrolled, ...this.lines()].join("\n").replace(/\n+$/, "") },
    count(str) { return this.all().split(str).length - 1 },
    /** The row the cursor is on. */
    cursorLine() { return this.line(y) },
    resize(c, r) {
      const old = grid
      cols = c; rows = r
      grid = Array.from({ length: rows }, (_, i) => { const src = old[i] || []; const row = new Array(cols).fill(" "); for (let k = 0; k < Math.min(cols, src.length); k++) row[k] = src[k]; return row })
      x = Math.min(x, cols - 1); y = Math.min(y, rows - 1)
    },
  }
}
