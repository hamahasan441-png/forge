/**
 * forge — terminal UI helpers (zero dependencies)
 */
// v18 fix: color support is decided LAZILY (first use), not at import time —
// forge.js sets NO_COLOR for non-TTY output only AFTER its imports run, so the
// old import-time check let ANSI codes leak into pipes/files (forge models > list.txt).
let _useColor
function useColor() {
  if (_useColor === undefined) {
    _useColor = process.env.NO_COLOR === undefined && process.stdout.isTTY !== false && !process.argv.includes("--no-color")
  }
  return _useColor
}

const code = (c, s) => (useColor() ? `\x1b[${c}m${s}\x1b[0m` : s)
export const bold = (s) => code("1", s)
export const dim = (s) => code("2", s)
export const cyan = (s) => code("36", s)
export const green = (s) => code("32", s)
export const yellow = (s) => code("33", s)
export const red = (s) => code("31", s)
export const magenta = (s) => code("35", s)

export function info(msg) { console.log(cyan("● ") + msg) }
export function ok(msg) { console.log(green("✓ ") + msg) }
export function warn(msg) { console.log(yellow("! ") + msg) }
export function err(msg) { console.error(red("✗ ") + msg) }

/** Light markdown rendering for the terminal (fenced code, headings, bullets, inline). */
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

export function printBanner(version, provider, model, extra) {
  console.log()
  console.log(bold(magenta("  ⬢ forge")) + dim(` v${version} — terminal AI agent`))
  console.log(dim(`  provider: ${provider || "(none)"}   model: ${model || "(none)"}${extra ? "   " + extra : ""}`))
  console.log(dim("  /help commands • Ctrl+C abort stream • Ctrl+C again exit"))
  console.log()
}
