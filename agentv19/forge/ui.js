/**
 * forge — terminal UI helpers (zero dependencies)
 *
 * Centralized design system: one place decides which COLOR CAPABILITY is
 * available (none / 16 / 256 / truecolor), and one semantic palette maps
 * design tokens (primary, muted, success, warning, error, info, accent) to
 * ANSI output. Every module styles through this theme — UI code never emits
 * a raw escape sequence of its own, so NO_COLOR, TERM=dumb, pipes and
 * screen readers all degrade identically.
 */
// v18 fix: color support is decided LAZILY (first use), not at import time —
// forge.js sets NO_COLOR for non-TTY output only AFTER its imports run, so the
// old import-time check let ANSI codes leak into pipes/files (forge models > list.txt).
let _useColor
export function useColor() {
  if (_useColor === undefined) {
    _useColor = process.env.NO_COLOR === undefined && process.stdout.isTTY !== false && !process.argv.includes("--no-color") && String(process.env.TERM || "").toLowerCase() !== "dumb"
  }
  return _useColor
}

/** Terminal color capability: "none" | "16" | "256" | "truecolor".
 *  NO_COLOR / non-TTY / TERM=dumb always mean "none" (FORCE_COLOR=1 wins). */
export function colorCapability(env = process.env, tty = process.stdout.isTTY) {
  if (env.FORCE_COLOR !== "1" && (env.NO_COLOR !== undefined || tty === false || String(env.TERM || "").toLowerCase() === "dumb")) return "none"
  const colorTerm = String(env.COLORTERM || "").toLowerCase()
  if (colorTerm === "truecolor" || colorTerm === "24bit") return "truecolor"
  if (/256color/.test(String(env.TERM || "")) || colorTerm === "256color") return "256"
  return "16"
}

/** Semantic palette: token → {16, "256", truecolor} SGR body (without ESC[ / m). */
const PALETTE = {
  primary: { c16: "1", c256: "1", tc: "1" }, // bold
  success: { c16: "32", c256: "38;5;40", tc: "38;2;80;200;120" },
  warning: { c16: "33", c256: "38;5;214", tc: "38;2;255;200;80" },
  error:   { c16: "31", c256: "38;5;203", tc: "38;2;255;110;110" },
  info:    { c16: "36", c256: "38;5;51", tc: "38;2;90;215;255" },
  accent:  { c16: "36", c256: "38;5;45", tc: "38;2;80;200;255" },
  muted:   { c16: "2", c256: "2", tc: "2" }, // dim
}

/**
 * Build a theme object: every token is a function s → styled string (identity
 * when color is unavailable). `paint(kind, s)` is the generic accessor.
 */
export function makeTheme(capability = colorCapability()) {
  const maybe = (body) => (s) => (capability === "none" ? s : `\x1b[${body}m${s}\x1b[0m`)
  const t = {}
  for (const [kind, code] of Object.entries(PALETTE)) {
    const body = code[capability === "none" ? "c16" : capability] ?? code.c16
    t[kind] = maybe(body)
  }
  t.paint = (kind, s) => (t[kind] || ((x) => x))(s)
  return t
}

let _theme = null
export function theme() {
  if (!_theme) _theme = makeTheme()
  return _theme
}

// Compatibility exports — the historical named helpers, now delegated to the
// semantic theme so every color in the app flows through one palette.
export const bold = (s) => theme().paint("primary", s)
export const dim = (s) => theme().paint("muted", s)
export const cyan = (s) => theme().paint("info", s)
export const green = (s) => theme().paint("success", s)
export const yellow = (s) => theme().paint("warning", s)
export const red = (s) => theme().paint("error", s)
export const magenta = (s) => theme().paint("accent", s)

export function info(msg) { console.log(cyan("● ") + msg) }
export function ok(msg) { console.log(green("✓ ") + msg) }
export function warn(msg) { console.log(yellow("! ") + msg) }
export function err(msg) { console.error(red("✗ ") + msg) }

/**
 * Light markdown rendering for the terminal (fenced code, headings, bullets,
 * inline). Kept for non-TTY / one-shot paths; the interactive UI streams
 * through markdown.js for incremental, structured rendering.
 */
export function renderMarkdown(text) {
  if (!useColor()) return text
  let inFence = false
  return String(text).split("\n").map((line) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return dim(line) }
    if (inFence) return cyan(line)
    return line
      .replace(/^#{1,6}\s+(.+)$/gm, (_, t) => bold(t))
      .replace(/^(\s*)[-*]\s+/, "$1• ")
      .replace(/\*\*([^*]+)\*\*/g, (_, t) => bold(t))
      .replace(/`([^`\n]+)`/g, (_, t) => cyan(t))
  }).join("\n")
}

export function estimateTokens(s) {
  return Math.max(1, Math.round((s || "").length / 4))
}

/** Compact premium banner — identity, provider, one hint line. No ASCII art.
 *  The literal `forge v${version}` stays first so scripts/tests that grep the
 *  banner (e2e, clean-room, PTY) keep working. */
export function printBanner(version, provider, model, extra) {
  console.log()
  console.log(bold(magenta("forge")) + dim(` v${version} — Ω autonomous engineering`))
  console.log(dim(`  provider: ${provider || "(none)"}   model: ${model || "(none)"}${extra ? "   " + extra : ""}`))
  console.log(dim("  /help commands • Alt+P palette • Ctrl+C cancel • Ctrl+C again exit"))
  console.log()
}
