#!/usr/bin/env node
/**
 * forge — v120 "honestcheck": three defects found by watching one real run.
 *
 * A read-only task ("Do not implement anything… Return only…") took 6:30, 19
 * steps and 28 tool calls. Chasing the slowness turned up something worse than
 * slowness.
 *
 *  1. A `grep` COUNTED AS A PASSING TEST. The check detector matched
 *     /\b(test|…)\b/ anywhere in the command, so
 *     `grep -n riskBias tests/test-plannerisk.mjs` was recorded as a passing
 *     verification — and completion.unverifiedWrites() treats writes before a
 *     passing check as covered. A file written, nothing run, gate satisfied.
 *
 *  2. NEGATION DID NOT EXIST. "Do not implement anything" scored exactly like
 *     "implement the retry": intent=modify, mutating=true. The read-only task
 *     was planned as grep → read → EDIT → BASH on the deep path.
 *
 *  3. `model undefined/undefined (low) —`. Two emitters of one event with two
 *     field namings; the renderer knew only one of them.
 *
 * Each section reproduces the defect before asserting the fix, and each carries
 * the guard that matters more than the fix: the narrow behaviour must survive.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v120-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 260)}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const { looksLikeCheck } = await import("../agent.js")
const { analyzeTask, INTENT, route } = await import("../router.js")
const { unverifiedWrites } = await import("../completion.js")
const caps = await import("../capabilities.js")
const uistate = await import("../uistate.js")

// ---------------------------------------------------------------------------
console.log("== 1. a command is a check because of what it RUNS, not what it mentions ==")
{
  // The exact command from the run that started this.
  ok("grepping a file whose NAME contains 'test' is not a test",
    !looksLikeCheck('grep -n "riskBias" tests/test-plannerisk.mjs'))
  ok("neither is listing a tests directory", !looksLikeCheck("cd /x && ls tests | grep foo"))
  ok("nor reading a test helper", !looksLikeCheck("cat test-helper.js"))
  ok("nor a git log over a test path", !looksLikeCheck("git log --oneline tests/test-v1.mjs"))
  ok("nor find over a test glob", !looksLikeCheck('find . -name "*test*"'))
  ok("nor echoing the word", !looksLikeCheck("echo test ok"))

  // ...and everything that IS a check must still be one. A detector that
  // stopped recognising real tests would be a far worse bug than the one it
  // replaced: unverified writes would silently become the norm.
  for (const cmd of ["npm test", "cd /x && npm test", "npx vitest run", "pytest -q",
                     "cargo test", "go test ./...", "node --check one.js",
                     "CI=1 npm run build", "make lint", "eslint .", "time npm test",
                     "yarn test --watch=false", "python -m pytest"]) {
    ok(`still a check: ${cmd}`, looksLikeCheck(cmd))
  }
  ok("a bare script run is not a check", !looksLikeCheck("node script.js"))
  ok("empty input never throws", !looksLikeCheck("") && !looksLikeCheck(null))
}

console.log("== 1b. and the reason it mattered: a grep could mark writes verified ==")
{
  const grepped = unverifiedWrites({
    writesSoFar: ["src/pager.js"],
    commandChecks: [{ command: "grep -n riskBias tests/test-plannerisk.mjs", passed: true, writeIndex: 1 }],
  })
  // This is the shape the OLD detector produced: a write reported as covered
  // by a grep. The gate itself is unchanged and correct — it trusts whatever
  // was recorded as a check, which is exactly why the detector must be right.
  eq("the gate trusts a recorded check, so a false check hides a real write", grepped.unverified, [])
  ok("which is why the grep is no longer recorded as one", !looksLikeCheck("grep -n riskBias tests/test-plannerisk.mjs"))

  const real = unverifiedWrites({
    writesSoFar: ["src/pager.js"],
    commandChecks: [{ command: "npm test", passed: true, writeIndex: 1 }],
  })
  eq("a real passing test still covers the write", real.unverified, [])
  const failed = unverifiedWrites({
    writesSoFar: ["src/pager.js"],
    commandChecks: [{ command: "npm test", passed: false, writeIndex: 1 }],
  })
  eq("a FAILING test covers nothing", failed.unverified, ["src/pager.js"])
}

// ---------------------------------------------------------------------------
console.log("== 2. 'do not implement' is not a request to implement ==")
{
  const a = (s) => analyzeTask(s)
  eq("the plain verb is still a mutation", a("implement the retry").primary, INTENT.MODIFY)

  for (const s of ["Do not implement anything", "do NOT change any file", "never write any code",
                   "don't modify anything", "without changing anything, explain the retry"]) {
    const r = a(s)
    ok(`negated → not a mutation: ${JSON.stringify(s.slice(0, 44))}`, r.mutating === false, `${r.primary}/${r.mutating}`)
  }

  // The real task, whole. It is an ANALYSIS request that happens to be about a
  // change, so it is full of the word "change" — subject matter, not an
  // instruction, and it must not buy the mutation pipeline.
  const REAL = `Do not implement anything.

From the 3 gaps you just identified, determine which ONE can produce the largest measurable improvement in Forge's future behavior with the smallest code change.

Trace the actual source and runtime wiring.

Return only:

1. Selected gap
2. Exact files/functions involved
3. Minimal change required
4. What future behavior will change
5. One concrete test proving the learning actually changes the next run

Do not propose new modules or duplicate existing intelligence.`
  const real = a(REAL)
  eq("the real task is an inspection", real.primary, INTENT.INSPECT)
  eq("and is not mutating", real.mutating, false)
  ok("MODIFY is not among its intents at all", !real.intents.includes(INTENT.MODIFY), JSON.stringify(real.intents))

  // The consequence the user actually paid for: the planned tool chain.
  const reg = caps.createRegistry({ config: {} })
  const chain = (route({ task: REAL, registry: reg, context: { cwd: process.cwd() } }).chain?.active ?? []).map((c) => c.tool)
  ok("the planned chain no longer contains a write tool",
    !chain.some((t) => ["edit_file", "write_file", "multi_edit", "apply_patch"].includes(t)), chain.join(" → "))
  ok("nor bash", !chain.includes("bash"), chain.join(" → "))
}

console.log("== 2b. THE GUARD: a scoped caveat must not disarm a real mutation task ==")
{
  // "do not change THE TESTS" is a caveat inside real work. Reading it as a
  // global prohibition would make forge refuse to do what it was asked —
  // worse than the bug being fixed here.
  for (const s of ["fix the off-by-one in src/pager.js",
                   "fix the off-by-one but do not change the tests",
                   "implement retry backoff, do not modify the public API",
                   "add a flag to the CLI without changing the default",
                   "refactor the loader",
                   "rename parseConfig to loadConfig, never touching the docs"]) {
    const r = analyzeTask(s)
    ok(`still a mutation: ${JSON.stringify(s.slice(0, 52))}`, r.mutating === true, `${r.primary}/${r.mutating}`)
  }
}

// ---------------------------------------------------------------------------
console.log("== 3. one event, one field naming ==")
{
  const render = (ev) => {
    const store = uistate.createUIStore(uistate.initialState())
    uistate.bridgeAgentEvent(store, ev)
    const st = store.get ? store.get() : store.state
    return String((st.notices ?? []).slice(-1)[0]?.text ?? "")
  }
  // meta.js's shape — the one the renderer was written for.
  ok("the meta shape renders", /model good\/fast/.test(render({ type: "MODEL_SELECTED", provider: "good", model: "fast", reason: "cheap", confidence: "high" })))
  // the agent's shape, as it is emitted now
  const agentLine = render({
    type: "MODEL_SELECTED", from: "a/x", to: "good/fast",
    provider: "good", model: "fast", reason: "cheap for this class", why: "cheap for this class", confidence: "low",
  })
  ok("so does the agent shape", /model good\/fast/.test(agentLine), agentLine)
  ok("with a real reason, not an empty tail", /cheap for this class/.test(agentLine), agentLine)
  ok("and never the old undefined line", !/undefined/.test(agentLine), agentLine)

  // Pin the contract so the two emitters cannot drift apart again.
  const src = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  const emitters = src.split('type: "MODEL_SELECTED"').slice(1)
  ok("every agent emitter carries the renderer's field names",
    emitters.length > 0 && emitters.every((e) => {
      const block = e.slice(0, 900)   // the first emitter carries a long comment
      return /provider:/.test(block) && /model:/.test(block) && /reason:/.test(block)
    }), `${emitters.length} emitter(s)`)
}

// ---------------------------------------------------------------------------
console.log("== 4. the two follow-ups, root-caused before being touched ==")
{
  // FIRST, THE CORRECTION. The trace showed "59 lines hidden" per read and I
  // read that as forge returning 60-line windows. It is the CLI collapsing the
  // transcript. read_file's default limit is 400 lines, and prediction.js
  // (353 lines) comes back WHOLE in one call — so those three re-reads were
  // the model's choice, not a forge limit. Nothing to fix there, and the
  // assertion below is what proves it rather than my say-so.
  const tools = await import("../tools.js")
  // the suite may run from tests/ — read against the forge root, not the cwd
  const ROOT = path.dirname(new URL("../package.json", import.meta.url).pathname)
  const ctx = { cwd: ROOT, root: ROOT, timeoutSec: 10, maxToolOutput: 32000, readOnly: true, _plugins: new Map() }

  const whole = String(await tools.execTool(ctx, "read_file", { path: "prediction.js" }))
  ok("a 353-line file needs exactly one default read", /^\s*353\|/m.test(whole) && !/continue with offset/.test(whole),
    whole.split("\n").slice(-1)[0])

  // What IS a real gap: a file past the 400-line window said "there is more"
  // without saying where. The next offset is the one fact the note exists for.
  const partial = String(await tools.execTool(ctx, "read_file", { path: "cognition.js" }))
  const m = /continue with offset: (\d+)/.exec(partial)
  ok("a partial read names the offset to continue from", Boolean(m), partial.split("\n").slice(-1)[0])
  eq("and it is the line after the last one shown", m && Number(m[1]), 401)

  // ...and following it actually works, in one hop rather than a guess.
  const rest = String(await tools.execTool(ctx, "read_file", { path: "cognition.js", offset: Number(m[1]) }))
  ok("following that offset resumes exactly where the first read stopped", /^\s*401\|/m.test(rest), rest.split("\n")[0])
  ok("and reaches the end of the file", !/continue with offset/.test(rest), rest.split("\n").slice(-1)[0])
}

console.log("== 4b. the 60s of connect guards was a stale CONFIG, not a forge default ==")
{
  // providers.js ships connectMs: 8000. The run reported 30s — the default
  // before it was lowered. v89 already stops connect failures from stacking
  // (they skip retry and fail over), so there was nothing to fix in the guard;
  // the cost came from a value an older forge wrote and nothing ever revisits.
  const { defaultConfig } = await import("../config.js")
  eq("the shipped connect guard is 8s", defaultConfig().retry.connectMs, 8000)

  const src = fs.readFileSync(new URL("../providers.js", import.meta.url), "utf8")
  ok("a connect failure still skips the retry loop rather than stacking waits",
    /kind === "connect"\) throw e/.test(src))

  // So the fix is visibility: a stale value announces itself in `forge doctor`.
  const forgeSrc = fs.readFileSync(new URL("../forge.js", import.meta.url), "utf8")
  ok("doctor compares the live retry settings against the shipped ones",
    /shipped = defaultConfig\(\)\.retry/.test(forgeSrc) && /well above the shipped default/.test(forgeSrc))
  ok("and only flags a value well clear of the default, not every difference",
    /mine\[k\] > v \* 2/.test(forgeSrc))
}

console.log(`\n== v120 honestcheck suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
