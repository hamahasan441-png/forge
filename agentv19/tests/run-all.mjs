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
  ["providers", "node", ["test-providers.mjs"]],
  ["diffpatch", "node", ["test-diffpatch.mjs"]],
  ["memory", "node", ["test-memory.mjs"]],
  ["failover", "node", ["test-failover.mjs"]],
  ["chat", "node", ["test-chat.mjs"]],
  ["walk", "node", ["test-walk.mjs"]],
  ["plans", "node", ["test-plans.mjs"]],
  ["checkpoint", "node", ["test-checkpoint.mjs"]],
  ["repomap", "node", ["test-repomap.mjs"]],
  ["plugins", "node", ["test-plugins.mjs"]],
  ["retrieval", "node", ["test-retrieval.mjs"]],
  ["sessions", "node", ["test-sessions.mjs"]],
  ["skills", "node", ["test-skills.mjs"]],
  ["json", "node", ["test-json.mjs"]],
  ["install", "node", ["test-install.mjs"]],
  ["config", "node", ["test-config.mjs"]],
  ["package", "node", ["test-package.mjs"]],
  ["effort", "node", ["test-effort.mjs"]],
]
if (!skipE2e) suites.push(["e2e", "bash", ["e2e-forge.sh"]])
if (!skipCleanroom) suites.push(["cleanroom", "bash", ["cleanroom-v20.sh"]])

function run([label, cmd, args]) {
  return new Promise((resolve) => {
    const target = path.join(here, args[0])
    if (!fs.existsSync(target)) {
      console.log(`\n\x1b[33m▷ ${label} — SKIPPED (${args[0]} not found)\x1b[0m`)
      return resolve({ label, ok: null, ms: 0 })
    }
    console.log(`\n\x1b[1m\x1b[36m▷ ${label}\x1b[0m  (${cmd} ${args.join(" ")})`)
    const t0 = Date.now()
    const child = spawn(cmd, args, { cwd: here, stdio: "inherit" })
    child.on("error", (e) => {
      console.log(`\x1b[31m  cannot launch ${cmd}: ${e.message}\x1b[0m`)
      resolve({ label, ok: false, ms: Date.now() - t0 })
    })
    child.on("close", (code) => resolve({ label, ok: code === 0, ms: Date.now() - t0 }))
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
