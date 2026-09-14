/**
 * autofix.js — v99 "loopwise" deterministic repair fast path.
 *
 * When verification fails with a LINT/FORMAT-class problem, the v98 loop
 * spent a full LLM repair run (tokens, latency, risk of unrelated edits) on
 * something the project's own formatter fixes deterministically. Before the
 * LLM repair fires, try the discovered native fix command ONCE:
 *
 *   - the trigger is a lint/format-shaped failure text (pattern, not a guess)
 *   - the command comes from the project's OWN manifests (langengine stacks)
 *   - only DIRECT formatter invocations are allowlisted (no `npm run x`)
 *   - shellguard must classify it "safe" (no pipes, redirects, sudo, nets)
 *   - bounded: 90s timeout, one command per call, full output tail captured
 *
 * The result is EVIDENCE, not a claim: the caller records the command and
 * its exit code in the verification ledger, exactly like an agent-run check.
 * If the fast path does not apply or fails, the LLM repair runs as before —
 * this is a shortcut on a path that already existed, never a replacement.
 */
import { spawnSync } from "node:child_process"
import { classifyCommand } from "./shellguard.js"
import { inspectProject } from "./langengine.js"

/** Direct formatter/linter-fixer invocations we will run autonomously. */
const ALLOWED_FORMATTERS = new Set([
  "prettier", "eslint", "biome", "standard", "ruff", "black", "isort", "autopep8",
  "gofmt", "goimports", "rustfmt", "cargo", "stylua", "dart", "mix", "dotnet",
  "clang-format", "swift-format", "mix_format", "gci", "gofumpt",
])

/** Failures that a formatter plausibly repairs. */
const LINTISH = /\b(lint|linter|prettier|eslint|biome|ruff|black|isort|flake8|pycodestyle|gofmt|rustfmt|clang-format|formatting|format check|style (error|issue|violation)|code style)\b/i

const TIMEOUT_MS = 90_000

function safeCandidate(cmd) {
  const c = String(cmd ?? "").trim()
  if (!c || c.length > 200) return null
  // never a compound/shell pipeline — classifyCommand would flag it anyway,
  // but the allowlist check below needs a single direct invocation
  if (/[;|&><`]|\$\(/.test(c)) return null
  const parts = c.split(/\s+/)
  const first = parts[0]
  if (!ALLOWED_FORMATTERS.has(first)) return null
  // a linter only qualifies when it actually FIXES; formatters always do
  if (first === "eslint" || first === "ruff" || first === "biome" || first === "standard") {
    if (!/\b--fix\b/.test(c)) return null
  }
  // subcommand families must name their FORMAT subcommand — `cargo run x`
  // or `dotnet build` must never ride the formatter allowlist (audit A10)
  if (first === "cargo" && !/^(cargo\s+fmt)(\s|$)/.test(c)) return null
  if (first === "dotnet" && !/^(dotnet\s+format)(\s|$)/.test(c)) return null
  if (first === "mix" && !/^(mix\s+format)(\s|$)/.test(c)) return null
  const v = classifyCommand(c, { autonomous: true })
  if (v.level !== "safe") return null
  return c
}

/**
 * @param {object} o
 * @param {string} o.cwd
 * @param {object|null} o.config merged config (tools.autofix === false disables)
 * @param {string} o.failureText the failing verification output / error text
 * @param {string[]} [o.changedFiles] relative changed files (language scoping hint)
 * @returns {{tried:boolean, applied:boolean, command:string, exitCode:number|null, tail:string, reason:string}}
 */
export function tryNativeAutoFix({ cwd = process.cwd(), config = null, failureText = "", changedFiles = [] } = {}) {
  const out = { tried: false, applied: false, command: "", exitCode: null, tail: "", reason: "" }
  if (config?.tools?.autofix === false) { out.reason = "autofix disabled by config"; return out }
  const text = String(failureText ?? "")
  if (!LINTISH.test(text)) { out.reason = "failure is not lint/format-shaped"; return out }
  // candidates from the project's own discovered stacks (format beats lint --fix)
  let stacks = []
  try { stacks = inspectProject(cwd).stacks ?? [] } catch { stacks = [] }
  const langs = new Set(changedFiles.map((f) => {
    const ext = String(f).split(".").pop()?.toLowerCase() ?? ""
    return ext
  }))
  const candidates = []
  for (const s of stacks) {
    // prefer stacks whose language matches a changed file's extension family
    const langOf = (l) => String(l ?? "").toLowerCase()
    const relevant = !langs.size || !s.language || langs.size === 0 ? true : (
      (langs.has("js") || langs.has("mjs") || langs.has("cjs") || langs.has("jsx") || langs.has("ts")) && ["javascript", "typescript"].includes(langOf(s.language))
      || (langs.has("py") && langOf(s.language) === "python")
      || (langs.has("go") && langOf(s.language) === "go")
      || (langs.has("rs") && langOf(s.language) === "rust")
    )
    if (s.format && relevant) candidates.push(s.format)
    if (s.lint && /\b--fix\b/.test(String(s.lint)) && relevant) candidates.push(s.lint)
  }
  for (const raw of candidates) {
    const cmd = safeCandidate(raw)
    if (!cmd) continue
    out.tried = true
    out.command = cmd
    try {
      const r = spawnSync(cmd, { cwd, shell: true, timeout: TIMEOUT_MS, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, env: process.env })
      const code = typeof r.status === "number" ? r.status : null
      out.exitCode = code
      out.tail = String((r.stdout ?? "") + (r.stderr ?? "")).split("\n").filter(Boolean).slice(-8).join("\n").slice(0, 1200)
      out.applied = code === 0
      out.reason = code === 0 ? "formatter completed cleanly" : `formatter exited ${code}`
      return out
    } catch (e) {
      out.reason = `formatter could not run: ${String(e?.message ?? e).slice(0, 160)}`
      return out
    }
  }
  out.reason = candidates.length ? "no allowlisted safe fix command" : "no discovered fix command for these files"
  return out
}
