#!/usr/bin/env node
/**
 * forge — one-command test runner (`npm test` from forge/, or `node tests/run-all.mjs`).
 *
 * Before v20.2 there was no `npm test`: a contributor had to remember to start
 * mock-llm.mjs by hand and then invoke five suites individually. This runner is
 * the single source of truth for "is the build green?": it runs every suite as
 * a child process, judges each by its EXIT CODE (all five already exit non-zero
 * on failure), and returns non-zero if any suite fails.
 *
 * The two bash suites (e2e, cleanroom) each start and stop their own mock
 * provider, so this runner starts nothing itself and simply sequences them.
 *
 * Env switches (all opt-out, default = run everything):
 *   FORGE_SKIP_E2E=1        skip the ~6.5-min e2e suite
 *   FORGE_SKIP_CLEANROOM=1  skip the clean-room npm-install suite
 *   FORGE_FAST=1            fast lane: node suites only (skips both bash suites)
 *
 * Zero dependencies — stdlib only.
 */
import { spawn } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))

const fast = process.env.FORGE_FAST === "1"
const skipE2e = fast || process.env.FORGE_SKIP_E2E === "1"
const skipCleanroom = fast || process.env.FORGE_SKIP_CLEANROOM === "1"

// [label, command, args]. Node suites first (fast, self-contained), then the
// slower bash suites (each manages its own mock-llm on 127.0.0.1:8787).
const suites = [
  ["security", "node", ["test-security.mjs"]],
  ["capabilities", "node", ["test-capabilities.mjs"]],
  ["router", "node", ["test-router.mjs"]],
  ["toolintel", "node", ["test-toolintel.mjs"]],
  ["providers", "node", ["test-providers.mjs"]],
  ["diffpatch", "node", ["test-diffpatch.mjs"]],
  ["memory", "node", ["test-memory.mjs"]],
  ["failover", "node", ["test-failover.mjs"]],
  ["compaction", "node", ["test-context-compaction.mjs"]],
  ["chat-compact", "node", ["test-chat-compaction.mjs"]],
  ["parser-fuzz", "node", ["test-parser-fuzz.mjs"]],
  ["state-writes", "node", ["test-state-writes.mjs"]],
  ["cp-crash", "node", ["test-checkpoint-crash-matrix.mjs"]],
  ["mem-pipeline", "node", ["test-memory-pipeline.mjs"]],
  ["chat", "node", ["test-chat.mjs"]],
  ["walk", "node", ["test-walk.mjs"]],
  ["plans", "node", ["test-plans.mjs"]],
  ["checkpoint", "node", ["test-checkpoint.mjs"]],
  ["repomap", "node", ["test-repomap.mjs"]],
  ["plugins", "node", ["test-plugins.mjs"]],
  ["mcp", "node", ["test-mcp.mjs"]],
  ["lsp", "node", ["test-lsp.mjs"]],
  ["retrieval", "node", ["test-retrieval.mjs"]],
  ["semantic", "node", ["test-semantic.mjs"]],
  ["sessions", "node", ["test-sessions.mjs"]],
  ["skills", "node", ["test-skills.mjs"]],
  ["json", "node", ["test-json.mjs"]],
  ["install", "node", ["test-install.mjs"]],
  ["config", "node", ["test-config.mjs"]],
  ["package", "node", ["test-package.mjs"]],
  ["effort", "node", ["test-effort.mjs"]],
  ["ui", "node", ["test-ui.mjs"]],
  ["autonomy", "node", ["test-autonomy.mjs"]],
  ["chaos", "node", ["test-chaos.mjs"]],
  // ---- P0/P1 audit regression suites (v24 hardening) -------------------
  ["dag-done", "node", ["test-whole-dag-completion.mjs"]],
  ["node-gate", "node", ["test-node-verification-gate.mjs"]],
  ["final-risk", "node", ["test-final-risk-recalculation.mjs"]],
  ["verif-ro", "node", ["test-verifier-readonly.mjs"]],
  ["worker-to", "node", ["test-worker-timeout-cleanup.mjs"]],
  ["node-id", "node", ["test-exact-node-attribution.mjs"]],
  ["conflicts", "node", ["test-dag-conflicts.mjs"]],
  ["readonly", "node", ["test-readonly-state.mjs"]],
  ["bad-plan", "node", ["test-invalid-plan.mjs"]],
  ["continuation", "node", ["test-max-segment-continuation.mjs"]],
  ["verif-scope", "node", ["test-verification-scope.mjs"]],
  ["verif-stale", "node", ["test-verification-staleness.mjs"]],
  ["exit-code", "node", ["test-unknown-exit-code.mjs"]],
  ["cp-integrity", "node", ["test-checkpoint-integrity.mjs"]],
  ["cp-restore", "node", ["test-checkpoint-restore.mjs"]],
  ["crash-resume", "node", ["test-crash-resume.mjs"]],
  ["effects", "node", ["test-effect-reconciliation.mjs"]],
  ["git-recov", "node", ["test-git-recovery.mjs"]],
  ["routing", "node", ["test-model-routing-history.mjs"]],
  ["mcp-life", "node", ["test-mcp-lifecycle.mjs"]],
  ["lsp-life", "node", ["test-lsp-lifecycle.mjs"]],
  ["leaks", "node", ["test-resource-leaks.mjs"]],
  ["version", "node", ["test-version-consistency.mjs"]],
  ["lessons", "node", ["test-lessons-schema.mjs"]],
  ["hygiene", "node", ["test-path-hygiene.mjs"]],
  // ---- v21.1 security audit: adversarial P0 suites ----------------------
  ["ssrf-pin", "node", ["test-ssrf-pinning.mjs"]],
  ["fs-toctou", "node", ["test-fs-toctou.mjs"]],
  ["plugin-iso", "node", ["test-plugin-isolation.mjs"]],
  ["hardening", "node", ["test-hardening-v21.mjs"]],
  ["v21-2", "node", ["test-v21-2.mjs"]],
  ["omega", "node", ["test-omega.mjs"]],
  ["infinity", "node", ["test-infinity.mjs"]],
  ["v25", "node", ["test-v25.mjs"]],
  ["v26", "node", ["test-v26.mjs"]],
  ["v27", "node", ["test-v27.mjs"]],
  ["v28", "node", ["test-v28.mjs"]],
  ["v29", "node", ["test-v29.mjs"]],
  ["v30", "node", ["test-v30.mjs"]],
  ["v31", "node", ["test-v31.mjs"]],
  ["v32", "node", ["test-v32.mjs"]],
  ["v33", "node", ["test-v33.mjs"]],
  ["v34", "node", ["test-v34.mjs"]],
  ["v35", "node", ["test-v35.mjs"]],
  ["v36", "node", ["test-v36.mjs"]],
  ["v37", "node", ["test-v37.mjs"]],
  ["v38", "node", ["test-v38.mjs"]],
  ["v39", "node", ["test-v39.mjs"]],
  ["v40", "node", ["test-v40.mjs"]],
  ["v41", "node", ["test-v41.mjs"]],
  ["v42", "node", ["test-v42.mjs"]],
  ["v43", "node", ["test-v43.mjs"]],
  ["v44", "node", ["test-v44.mjs"]],
  ["v45", "node", ["test-v45.mjs"]],
  ["v46", "node", ["test-v46.mjs"]],
  ["v47", "node", ["test-v47.mjs"]],
  ["v48", "node", ["test-v48.mjs"]],
  ["v49", "node", ["test-v49.mjs"]],
  ["v50", "node", ["test-v50.mjs"]],
  ["v51", "node", ["test-v51.mjs"]],
  ["v52", "node", ["test-v52.mjs"]],
  ["v53", "node", ["test-v53.mjs"]],
  ["v54", "node", ["test-v54.mjs"]],
  ["v55", "node", ["test-v55.mjs"]],
  ["v56", "node", ["test-v56.mjs"]],
  ["v57", "node", ["test-v57.mjs"]],
  ["v58", "node", ["test-v58.mjs"]],
  ["v59", "node", ["test-v59.mjs"]],
  ["v60", "node", ["test-v60.mjs"]],
]
if (!skipE2e) suites.push(["e2e", "bash", ["e2e-forge.sh"]])
if (!skipCleanroom) suites.push(["cleanroom", "bash", ["cleanroom-v20.sh"]])
if (!skipCleanroom) suites.push(["cleanroom-pkg", "node", ["test-clean-room-package.mjs"]])

/** Escape a string for a GitHub Actions workflow command (::error::). */
function wfEscape(s) {
  return String(s ?? "")
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
}

/**
 * Emit a GitHub annotation for a failing suite.
 *
 * CI logs are not always reachable from a workstation, but annotations are
 * exposed through the Checks API — so a red build can be diagnosed without
 * downloading the job log.
 */
function annotate(label, output, limit = 2400) {
  const lines = String(output ?? "").split("\n")
  const interesting = lines.filter((l) => /FAIL|Error|error:|AssertionError|✗|failed|not ok|Traceback/i.test(l))
  const body = (interesting.length ? interesting : lines.slice(-25)).slice(0, 25).join(" ⏎ ")
  console.log(`::error title=suite "${label}" failed::${wfEscape(body.slice(0, limit))}`)
}

function run([label, cmd, args]) {
  return new Promise((resolve) => {
    const target = path.join(here, args[0])
    if (!fs.existsSync(target)) {
      console.log(`\n\x1b[33m▷ ${label} — SKIPPED (${args[0]} not found)\x1b[0m`)
      return resolve({ label, ok: null, ms: 0, output: "" })
    }
    console.log(`\n\x1b[1m\x1b[36m▷ ${label}\x1b[0m  (${cmd} ${args.join(" ")})`)
    const t0 = Date.now()
    let buf = ""
    const child = spawn(cmd, args, { cwd: here, stdio: ["ignore", "pipe", "pipe"] })
    const forward = (chunk) => { const s = String(chunk); buf += s; process.stdout.write(s) }
    child.stdout?.on("data", forward)
    child.stderr?.on("data", forward)
    child.on("error", (e) => {
      console.log(`\x1b[31m  cannot launch ${cmd}: ${e.message}\x1b[0m`)
      resolve({ label, ok: false, ms: Date.now() - t0, output: buf })
    })
    child.on("close", (code) => {
      const ok = code === 0
      if (!ok) annotate(label, buf)
      resolve({ label, ok, ms: Date.now() - t0, output: buf })
    })
  })
}

const results = []
for (const s of suites) results.push(await run(s)) // sequential: bash suites share port 8787

const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`)
console.log("\n" + "─".repeat(48))
console.log("\x1b[1mtest summary\x1b[0m")
let failed = 0
for (const r of results) {
  const tag = r.ok === null ? "\x1b[33mSKIP\x1b[0m" : r.ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"
  if (r.ok === false) failed++
  console.log(`  ${tag}  ${r.label.padEnd(11)} ${fmt(r.ms)}`)
}
console.log("─".repeat(48))
if (failed) {
  console.log(`\x1b[31m${failed} suite(s) failed\x1b[0m`)
  process.exit(1)
}
console.log(`\x1b[32mall ${results.filter((r) => r.ok).length} suite(s) passed\x1b[0m`)
