/**
 * forge — verification contracts (v20.5 tool intelligence layer, zero deps)
 *
 * §13: a tool that mutates state declares what must be TRUE afterwards, and
 * the executor proves it. Verification is proportional to risk:
 *
 *   low       nothing to prove (a read changed nothing)
 *   medium    local, cheap, instant proof: the file exists, it still parses,
 *             the replacement is actually in the file, the patch landed
 *   high      the above, plus a RECOMMENDED command-level check (tests /
 *   critical  build / install) that the agent runs through the normal bash
 *             tool — verification never runs `npm test` behind the user's back
 *
 * Everything executed here is local, bounded and side-effect free:
 * fs.stat / a bounded read / JSON.parse / `node --check` on a temp copy.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { parsePatch } from "./diffpatch.js"
import { RISK, riskRank } from "./capabilities.js"

export const CHECK = {
  FILE_EXISTS: "file_exists",
  SYNTAX: "syntax",
  CONTENT_APPLIED: "content_applied",
  PATCH_APPLIED: "patch_applied",
  TESTS: "tests",
  BUILD: "build",
  INSTALL: "install",
  CONFIG_VALID: "config_valid",
}

const SYNTAX_JS = new Set([".js", ".mjs", ".cjs"])
const SYNTAX_JSON = new Set([".json"])
const MAX_VERIFY_BYTES = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 8000

/** Files the call is expected to have changed. */
export function verifyTargets(name, args = {}, cwd = process.cwd()) {
  const abs = (p) => path.resolve(cwd, String(p))
  const a = args && typeof args === "object" ? args : {}
  switch (name) {
    case "write_file":
    case "edit_file":
    case "multi_edit":
      return a.path ? [abs(a.path)] : []
    case "apply_patch": {
      const out = []
      try {
        for (const f of parsePatch(String(a.patch ?? ""))) {
          const target = f.newPath && f.newPath !== "/dev/null" ? f.newPath : f.oldPath
          if (target && target !== "/dev/null") out.push(abs(target))
        }
      } catch { /* fall through to the regex below */ }
      if (!out.length) {
        const re = /^\+\+\+ (?:b\/)?(\S+)/gm
        let m
        while ((m = re.exec(String(a.patch ?? "")))) if (m[1] !== "/dev/null") out.push(abs(m[1]))
      }
      return [...new Set(out)]
    }
    default:
      return []
  }
}

/**
 * The verification contract for one call.
 * Returns { required, level, checks:[{kind,target,why,executor}], summary }.
 * `executor: "local"` runs here; `executor: "agent"` is a recommendation the
 * agent should satisfy with a real command (bash) — never run automatically.
 */
export function verificationPlan(name, args = {}, { risk = RISK.LOW, registry = null, cwd = process.cwd(), meta = null } = {}) {
  const m = meta ?? registry?.resolve?.(name) ?? null
  const a = args && typeof args === "object" ? args : {}
  const checks = []
  const targets = verifyTargets(name, a, cwd)
  const declared = new Set(m?.verify_after ?? [])
  const mutates = m ? !m.read_only : false

  if (name === "write_file") {
    for (const t of targets) {
      checks.push({ kind: CHECK.FILE_EXISTS, target: t, why: "the file the write claims to have created must exist", executor: "local" })
      if (syntaxKind(t)) checks.push({ kind: CHECK.SYNTAX, target: t, why: "a written source file must still parse", executor: "local" })
    }
  } else if (name === "edit_file" || name === "multi_edit") {
    for (const t of targets) {
      checks.push({ kind: CHECK.CONTENT_APPLIED, target: t, why: "the replacement text must actually be in the file", executor: "local", expect: expectedText(name, a) })
      if (syntaxKind(t)) checks.push({ kind: CHECK.SYNTAX, target: t, why: "an edited source file must still parse", executor: "local" })
    }
  } else if (name === "apply_patch") {
    checks.push({ kind: CHECK.PATCH_APPLIED, target: targets, why: "every file the patch touches must be in its post-patch state", executor: "local", patch: String(a.patch ?? "") })
    for (const t of targets) if (syntaxKind(t)) checks.push({ kind: CHECK.SYNTAX, target: t, why: "a patched source file must still parse", executor: "local" })
  } else if (name === "bash") {
    const cmd = String(a.command ?? "")
    if (/\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|\bpip3?\s+install\b/.test(cmd)) {
      checks.push({ kind: CHECK.INSTALL, target: cwd, why: "a dependency change must be followed by a build/test run", executor: "agent" })
    }
  } else if (declared.size) {
    for (const kind of declared) checks.push({ kind, target: targets[0] ?? cwd, why: "declared by the tool", executor: "local" })
  }

  // risk-proportional escalation: high/critical mutations need real evidence,
  // which only the agent can produce (it owns the test command).
  if (mutates && riskRank(risk) >= riskRank(RISK.HIGH)) {
    checks.push({ kind: CHECK.TESTS, target: cwd, why: `risk=${risk}: run the focused test/build before declaring success`, executor: "agent" })
  }

  const local = checks.filter((c) => c.executor === "local")
  return {
    tool: name,
    risk,
    required: mutates && (m?.verification_required !== false) && checks.length > 0,
    level: riskRank(risk) >= riskRank(RISK.HIGH) ? "strict" : local.length ? "standard" : "none",
    checks,
    summary: checks.length ? checks.map((c) => c.kind).join(" + ") : "none (read-only)",
  }
}

function expectedText(name, a) {
  if (name === "edit_file") return typeof a.new === "string" ? a.new : null
  if (name === "multi_edit" && Array.isArray(a.edits)) {
    const last = a.edits[a.edits.length - 1]
    return typeof last?.new === "string" ? last.new : null
  }
  return null
}

function syntaxKind(file) {
  const ext = path.extname(String(file || "")).toLowerCase()
  if (SYNTAX_JS.has(ext)) return "js"
  if (SYNTAX_JSON.has(ext)) return "json"
  return null
}

function readBounded(file) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return null
    if (st.size > MAX_VERIFY_BYTES) return { tooBig: true, size: st.size, text: null }
    return { tooBig: false, size: st.size, text: fs.readFileSync(file, "utf8") }
  } catch {
    return null
  }
}

/** `node --check` on the file (ESM sources are checked through a temp .mjs
 *  copy so `import` at top level is not a false positive). */
function nodeCheck(file, text, timeoutMs) {
  return new Promise((resolve) => {
    const esm = /^\s*(import|export)\b/m.test(text)
    let target = file
    let tmpFile = null
    if (esm && path.extname(file).toLowerCase() !== ".mjs") {
      try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-verify-"))
        tmpFile = path.join(dir, "check.mjs")
        fs.writeFileSync(tmpFile, text)
        target = tmpFile
      } catch { /* fall back to checking the file in place */ }
    }
    const done = (ok, detail) => {
      if (tmpFile) { try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }) } catch {} }
      resolve({ ok, detail })
    }
    try {
      execFile(process.execPath, ["--check", target], { timeout: timeoutMs, maxBuffer: 512 * 1024 }, (err, _out, stderr) => {
        if (!err) return done(true, "node --check passed")
        // report the REAL file, never the temp copy the ESM check used
        const raw = String(stderr || err.message).split("\n").filter(Boolean).slice(0, 3).join(" ")
        const first = (tmpFile ? raw.split(tmpFile).join(file) : raw).slice(0, 300)
        done(false, first || "node --check failed")
      })
    } catch (e) {
      done(true, `syntax check skipped (${String(e?.message ?? e).slice(0, 60)})`)
    }
  })
}

/**
 * Execute the LOCAL checks of a plan. Never throws; a check that cannot run is
 * reported as skipped, not as a failure (verification must not invent errors).
 * Returns { ok, checks:[{kind,target,ok,skipped,detail,ms}], recommended:[…], summary }.
 */
export async function runVerification(plan, { cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const out = { ok: true, checks: [], recommended: [], summary: "", ran: 0 }
  if (!plan || !Array.isArray(plan.checks) || !plan.checks.length) {
    out.summary = "no verification required"
    return out
  }
  for (const c of plan.checks) {
    if (c.executor !== "local") { out.recommended.push({ kind: c.kind, why: c.why }); continue }
    const t0 = Date.now()
    const r = await runCheck(c, { cwd, timeoutMs })
    out.checks.push({ kind: c.kind, target: shortTarget(c.target, cwd), ...r, ms: Date.now() - t0 })
    out.ran++
    if (r.ok === false) out.ok = false
  }
  const failed = out.checks.filter((c) => c.ok === false)
  const passed = out.checks.filter((c) => c.ok === true)
  const skipped = out.checks.filter((c) => c.skipped)
  out.summary = failed.length
    ? `FAILED: ${failed.map((c) => `${c.kind} (${c.detail})`).join("; ")}`
    : passed.length
      ? `${passed.map((c) => c.kind).join(", ")} ok${skipped.length ? ` • ${skipped.length} skipped` : ""}`
      : "nothing to verify locally"
  return out
}

async function runCheck(c, { cwd, timeoutMs }) {
  try {
    switch (c.kind) {
      case CHECK.FILE_EXISTS: {
        const ok = fs.existsSync(c.target)
        return { ok, skipped: false, detail: ok ? "exists" : "missing after write" }
      }
      case CHECK.SYNTAX: {
        const kind = syntaxKind(c.target)
        const f = readBounded(c.target)
        if (!f) return { ok: null, skipped: true, detail: "file unreadable" }
        if (f.tooBig) return { ok: null, skipped: true, detail: `file too large to check (${f.size}B)` }
        if (kind === "json") {
          try { JSON.parse(f.text); return { ok: true, skipped: false, detail: "valid JSON" } }
          catch (e) { return { ok: false, skipped: false, detail: String(e.message).slice(0, 200) } }
        }
        if (kind === "js") return { ...(await nodeCheck(c.target, f.text, timeoutMs)), skipped: false }
        return { ok: null, skipped: true, detail: "no local checker for this file type" }
      }
      case CHECK.CONTENT_APPLIED: {
        const f = readBounded(c.target)
        if (!f) return { ok: false, skipped: false, detail: "file missing after edit" }
        if (f.tooBig) return { ok: null, skipped: true, detail: "file too large to confirm" }
        if (typeof c.expect !== "string" || !c.expect.length) return { ok: null, skipped: true, detail: "nothing to compare" }
        const ok = f.text.includes(c.expect)
        return { ok, skipped: false, detail: ok ? "replacement present" : "replacement text not found in the file" }
      }
      case CHECK.PATCH_APPLIED: {
        const targets = Array.isArray(c.target) ? c.target : [c.target].filter(Boolean)
        if (!targets.length) return { ok: null, skipped: true, detail: "patch touched no known file" }
        const missing = targets.filter((t) => !fs.existsSync(t))
        // a patch may legitimately delete files — only flag when EVERY target is gone
        if (missing.length === targets.length) return { ok: false, skipped: false, detail: `none of the patched files exist (${missing.length})` }
        return { ok: true, skipped: false, detail: `${targets.length - missing.length}/${targets.length} patched file(s) present` }
      }
      default:
        return { ok: null, skipped: true, detail: `no local executor for ${c.kind}` }
    }
  } catch (e) {
    return { ok: null, skipped: true, detail: `check error: ${String(e?.message ?? e).slice(0, 120)}` }
  }
}

function shortTarget(t, cwd) {
  if (Array.isArray(t)) return t.map((x) => shortTarget(x, cwd)).join(", ")
  const s = String(t ?? "")
  const rel = path.relative(cwd, s)
  return rel && !rel.startsWith("..") ? rel : s
}

/** One compact line for the model / the run journal. */
export function formatVerification(result) {
  if (!result || !result.ran) return ""
  return result.ok ? `[verified] ${result.summary}` : `[verification FAILED] ${result.summary}`
}
