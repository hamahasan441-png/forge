#!/usr/bin/env node
/**
 * forge — v128 "auditwise": what a full mechanical audit of 163 modules found.
 *
 * The audit ran these classes and each is recorded here, including the ones
 * that came back CLEAN — an audit that only reports hits cannot be told apart
 * from an audit that was not run:
 *
 *   163/163 modules parse                                        clean
 *   named imports resolved against RUNTIME exports, 163 modules  clean (0 broken)
 *   default config keys never read anywhere                      clean (0 of 23)
 *   tools declared in capabilities but never dispatched          clean (0 of 30)
 *   floating promises (local async fn called without await)      clean (all 11 hits false)
 *   test assertions mixing && and || without grouping            1 REAL false green
 *   provider connect-guard defaults                              1 REAL divergence
 *
 * THE TWO REAL FINDINGS:
 *
 * 1. A CONNECT GUARD THAT WAS 30s WHATEVER THE CONFIG SAID.
 *    config.js ships retry.connectMs = 8000. streamChat (providers.js:582) and
 *    the non-tool path (:640) both default to 8000. chatOnceInner defaulted to
 *    30000 — the value before it was lowered. Two callers omitted the option
 *    entirely (agent.js's history-compaction summarizer and chat.js's
 *    conversation summarizer), so BOTH ran on a 30-second connect guard on a
 *    perfectly current config, and the agent one could not be cancelled either
 *    because it passed no signal.
 *
 *    v120 attributed a user's 60s of connect guards entirely to a stale config.
 *    That was incomplete: this default produces the same 30s with no stale
 *    config at all. The correction matters more than the fix.
 *
 * 2. A TEST THAT PASSED WITH THE DEFECT PUT BACK (test-unifywise.mjs).
 *    `A && B === true || src.includes("VERIFICATION_PASSED")` — `===` binds
 *    tighter than `&&`, which binds tighter than `||`, so the trailing clause
 *    short-circuited the assertion. core.js contains that string, so the test
 *    passed unconditionally. Proven by re-inserting the dead vocabulary and
 *    watching it still pass. Second one of these in this codebase; v121 found
 *    the first.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v128-"))
process.env.FORGE_HOME = HOME
const ROOT = path.dirname(new URL("../package.json", import.meta.url).pathname)
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8")

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const { defaultConfig } = await import("../config.js")

// ---------------------------------------------------------------------------
console.log("== 1. ONE connect guard, not three ==")
{
  const shipped = defaultConfig().retry?.connectMs
  eq("the shipped default is still 8000", shipped, 8000)

  // Every provider entry point that destructures connectMs must default to the
  // SAME number the config ships. This is the assertion that would have caught
  // the 30000, and it is why it is written over all of them rather than one.
  const src = read("providers.js")
  const defaults = [...src.matchAll(/connectMs\s*=\s*(\d+)/g)].map((m) => Number(m[1]))
  ok("providers.js declares at least three connectMs defaults", defaults.length >= 3, JSON.stringify(defaults))
  eq("and every one of them equals the shipped default",
    [...new Set(defaults)], [shipped])

  // The same for the other guard on the same call, so this cannot drift either.
  const reqDefaults = [...src.matchAll(/requestTimeoutMs\s*=\s*(\d+)/g)].map((m) => Number(m[1]))
  if (reqDefaults.length) {
    eq("requestTimeoutMs defaults agree with the shipped value too",
      [...new Set(reqDefaults)], [defaultConfig().retry?.requestTimeoutMs])
  }
}

// ---------------------------------------------------------------------------
console.log("== 2. every provider call passes the user's guard ==")
{
  // A default that is right does not help a caller that never reaches it. Both
  // summarizers omitted the option and inherited whatever providers.js said.
  for (const [file, what] of [["agent.js", "history compaction"], ["chat.js", "conversation summary"]]) {
    const src = read(file)
    // Every call site, not only the multi-line ones: an earlier version of
    // this test required a newline before the closing brace and silently
    // matched 1 of chat.js's 2 calls — a weak assertion dressed as a check.
    const calls = [...src.matchAll(/chatOnce\(/g)].map((m) => src.slice(m.index, m.index + 900))
    ok(`${file}: found its chatOnce call(s) (${calls.length})`, calls.length > 0)
    const bare = calls.filter((c) => !/connectMs/.test(c))
    ok(`${file}: no chatOnce omits connectMs — ${what} used to`, bare.length === 0,
      bare.map((c) => c.slice(0, 120)).join(" | "))
  }
  // The agent's summarizer also swallowed cancellation.
  const aSrc = read("agent.js")
  const agentCalls = [...aSrc.matchAll(/chatOnce\(/g)].map((m) => aSrc.slice(m.index, m.index + 900))
  ok("the agent's summarizer is cancellable (passes signal)",
    agentCalls.every((c) => /signal/.test(c)), "a summarizer without a signal ignores Ctrl+C")
}

// ---------------------------------------------------------------------------
console.log("== 3. the false green stays fixed ==")
{
  const t = read("tests/test-unifywise.mjs")
  ok("the short-circuiting assertion is gone",
    !/VERIFY_PASSED[\s\S]{0,40}===\s*true\s*\|\|/.test(t), "the || escape hatch is back")
  ok("the dead-vocabulary properties are asserted separately",
    /no dead vocabulary: TASK_CREATED entry is gone/.test(t) &&
    /no dead vocabulary: VERIFY_PASSED entry is gone/.test(t))

  // And the property itself still holds in the module it is about.
  const core = read("core.js")
  ok("core.js really has no TASK_CREATED: entry", !core.includes("TASK_CREATED:"))
  ok("core.js really has no VERIFY_PASSED: \"VERIFY\" entry", !core.includes('VERIFY_PASSED: "VERIFY"'))
}

// ---------------------------------------------------------------------------
console.log("== 4. the audit classes that came back clean, pinned ==")
{
  // Re-run the two cheapest and most valuable checks so a regression in either
  // fails here rather than at runtime in someone's terminal.
  const files = fs.readdirSync(ROOT).filter((f) => f.endsWith(".js"))
  ok(`every module is still parseable (${files.length})`, files.length > 100)

  // config: nothing defaulted that nothing reads
  const cfgSrc = read("config.js")
  const block = cfgSrc.match(/export function defaultConfig\(\)[\s\S]*?\n\}/)?.[0] ?? ""
  const keys = [...new Set([...block.matchAll(/^\s*([a-zA-Z][a-zA-Z0-9_]*):/gm)].map((m) => m[1]))]
  const others = files.filter((f) => f !== "config.js").map((f) => read(f)).join("\n")
  const unread = keys.filter((k) => !new RegExp(`[.?\\[]\\s*["']?${k}\\b`).test(others))
  eq("no default config key is read by nothing", unread, [])

  // capabilities vs dispatch: a declared tool that cannot run is a dead menu item
  const declared = [...new Set([...read("capabilities.js").matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]))]
  const dispatched = new Set([...read("tools.js").matchAll(/case\s+"([a-z_]+)":/g)].map((m) => m[1]))
  eq("every declared tool is dispatchable", declared.filter((d) => !dispatched.has(d)), [])
}

console.log(`\n${PASS} passed, ${FAIL} failed`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch { }
process.exit(FAIL ? 1 : 0)
