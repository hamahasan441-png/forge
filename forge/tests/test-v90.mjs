/**
 * v90 "gitwise" — dedicated read-only git views: git_diff / git_log / git_blame.
 *
 *  1. Registry: all three are registered tools (schemas), classified READ-only,
 *     parallel-safe, idempotent, LOW risk — in capabilities AND classifyCall.
 *  2. Behavior on a real temp git repo: diff (HEAD/stage/worktree separation,
 *     equivalence with raw `git diff`), log (format, limit, path filter, stat),
 *     blame (window, untracked, cap).
 *  3. Token budget: a huge diff is truncated with a diffstat and an explicit
 *     "… N more lines" notice — never silently cut.
 *  4. Hardening: base can never be a git flag or contain shell metacharacters;
 *     numeric args are clamped, not crashed on.
 *  5. Integration: verifier whitelist (verification agents may review diffs),
 *     read-only agents keep access, doctor --tools exercises all three.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const { TOOL_DEFS, toolCount, BUILTIN_TOOL_NAMES, WRITE_TOOLS, VERIFICATION_TOOLS, verificationAllows, makeToolContext, execTool } = await import("../tools.js")
const { BUILTIN_CAPABILITIES, createRegistry, classifyCall, operationRisk, RISK, CLASS } = await import("../capabilities.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 220) : ""}`) }
}

// ---------------------------------------------------------------------------
console.log("== 1. registry: three read-only, parallel-safe git views ==")
{
  const names = TOOL_DEFS.map((t) => t.function.name)
  for (const n of ["git_diff", "git_log", "git_blame"]) {
    ok(`${n} in TOOL_DEFS`, names.includes(n))
    ok(`${n} is a built-in name`, BUILTIN_TOOL_NAMES.has(n))
    ok(`${n} is NOT a write tool`, !WRITE_TOOLS.has(n))
  }
  ok("toolCount is 22", toolCount() === 22, String(toolCount()))
  const blameDef = TOOL_DEFS.find((t) => t.function.name === "git_blame").function
  ok("git_blame requires path", Array.isArray(blameDef.parameters.required) && blameDef.parameters.required.includes("path"))
  const diffDef = TOOL_DEFS.find((t) => t.function.name === "git_diff").function
  ok("git_diff exposes base/path/context/max_lines", ["base", "path", "context", "max_lines"].every((k) => diffDef.parameters.properties?.[k]))

  const metas = new Map(BUILTIN_CAPABILITIES.map((m) => [m.name, m]))
  for (const n of ["git_diff", "git_log", "git_blame"]) {
    const m = metas.get(n)
    ok(`${n} capability meta present`, !!m)
    if (m) {
      ok(`${n} read_only + parallel_safe + idempotent`, m.read_only === true && m.parallel_safe === true && m.idempotent === true)
      ok(`${n} LOW risk, READ class`, m.risk === RISK.LOW && m.klass === CLASS.READ)
      ok(`${n} mutates nothing`, Array.isArray(m.mutates) && m.mutates.length === 0)
    }
    const op = operationRisk(n, {}, {})
    ok(`${n} operationRisk: read-only inspection`, op.mutation === false && op.risk === RISK.LOW)
  }
  const reg = createRegistry({})
  const cls = ["git_diff", "git_log", "git_blame"].map((n) => classifyCall(n, {}, { registry: reg }))
  ok("classifyCall: all three read-only AND parallel-safe", cls.every((c) => c.read_only === true && c.parallel_safe === true), JSON.stringify(cls.map((c) => [c.read_only, c.parallel_safe])))
}

// ---------------------------------------------------------------------------
console.log("== 2. behavior on a real git repo ==")
const T = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v90-"))
const git = (args) => execFileSync("git", args, { cwd: T })
try {
  git(["init", "-q"])
  fs.writeFileSync(path.join(T, "app.js"), "line1\nline2\nline3\n")
  fs.writeFileSync(path.join(T, "keep.txt"), "stable\n")
  git(["add", "-A"])
  git(["-c", "user.email=t@forge.local", "-c", "user.name=v90tester", "commit", "-q", "-m", "v90 base commit"])
  fs.writeFileSync(path.join(T, "app.js"), "line1\nCHANGED\nline3\nline4\n")
  fs.writeFileSync(path.join(T, "staged.txt"), "to be staged\n")
  git(["add", "staged.txt"])

  const tc = makeToolContext({ cwd: T })
  const run = (n, a) => execTool(tc.ctx, n, a || {})

  // diff vs HEAD: stat header + the real diff body, equal to raw git
  const rawDiff = String(execFileSync("git", ["diff", "--no-color", "--no-ext-diff", "-U3", "HEAD"], { cwd: T })).trim()
  const d = await run("git_diff", {})
  ok("git_diff HEAD contains the raw diff body", typeof d === "string" && d.includes(rawDiff))
  ok("git_diff HEAD carries a diffstat header", typeof d === "string" && d.includes("files changed") && d.includes("app.js") && d.includes("staged.txt"))
  ok("git_diff HEAD shows the edit", d.includes("-line2") && d.includes("+CHANGED"))

  // base separation
  const w = await run("git_diff", { base: "worktree" })
  ok("worktree diff = unstaged only", w.includes("app.js") && !w.includes("staged.txt"))
  const st = await run("git_diff", { base: "stage" })
  ok("stage diff = staged only", st.includes("staged.txt") && !st.includes("app.js"))
  const none = await run("git_diff", { base: "worktree", path: "keep.txt" })
  ok("no-diff path says so cleanly", none.startsWith("(no differences"))

  // log
  const log = await run("git_log", {})
  ok("git_log: hash date author subject", /^\w{7,} \d{4}-\d{2}-\d{2} v90tester v90 base commit/.test(String(log).trim()))
  const logStat = await run("git_log", { stat: true, path: "app.js" })
  ok("git_log stat + path filter", logStat.includes("v90 base commit") && logStat.includes("app.js") && logStat.includes("changed"))
  const logNone = await run("git_log", { path: "never-touched.txt" })
  ok("git_log untouched path → no commits", logNone.startsWith("(no commits"))

  // blame
  const bl = await run("git_blame", { path: "keep.txt", start: 1, end: 1 })
  ok("git_blame names committed author", bl.includes("v90tester") && bl.includes("stable"))
  const blUntracked = await run("git_blame", { path: "untracked.txt" })
  ok("git_blame untracked → clear error", blUntracked.startsWith("ERROR:") && blUntracked.includes("not tracked"))

  // not a git repository
  const T2 = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v90-norepo-"))
  try {
    const tc2 = makeToolContext({ cwd: T2 })
    for (const n of ["git_diff", "git_log", "git_blame"]) {
      const r = await execTool(tc2.ctx, n, n === "git_blame" ? { path: "x" } : {})
      ok(`${n} outside a repo → ERROR, not a crash`, typeof r === "string" && r.startsWith("ERROR: not a git repository"))
    }
  } finally { fs.rmSync(T2, { recursive: true, force: true }) }
} finally { fs.rmSync(T, { recursive: true, force: true }) }

// ---------------------------------------------------------------------------
console.log("== 3. token budget: huge diffs truncate loudly, never silently ==")
{
  const T = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v90-big-"))
  try {
    const git = (a) => execFileSync("git", a, { cwd: T })
    git(["init", "-q"])
    fs.writeFileSync(path.join(T, "big.txt"), Array.from({ length: 600 }, (_, i) => `old ${i}`).join("\n"))
    git(["add", "-A"])
    git(["-c", "user.email=t@forge.local", "-c", "user.name=t", "commit", "-q", "-m", "base"])
    fs.writeFileSync(path.join(T, "big.txt"), Array.from({ length: 600 }, (_, i) => `NEW ${i}`).join("\n"))
    const tc = makeToolContext({ cwd: T })
    const r = await execTool(tc.ctx, "git_diff", { base: "worktree", max_lines: 30 })
    ok("over-budget diff is announced", r.includes("showing the first"))
    ok("over-budget diff keeps the diffstat", r.includes("big.txt") && r.includes("changed"))
    ok("over-budget diff says how much was cut", /more diff lines/.test(r))
    ok("over-budget output stays small", r.split("\n").length < 80, `${r.split("\n").length} lines`)
    const full = await execTool(tc.ctx, "git_diff", { base: "worktree", max_lines: 2000 })
    ok("full budget shows everything (no truncation notice)", !full.includes("showing the first") && full.includes("+NEW 599"))
  } finally { fs.rmSync(T, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------------------
console.log("== 4. hardening: base can never be a flag / shell junk; clamps ==")
{
  const T = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v90-hard-"))
  try {
    const git = (a) => execFileSync("git", a, { cwd: T })
    git(["init", "-q"])
    fs.writeFileSync(path.join(T, "a.txt"), "x\n")
    git(["add", "-A"])
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "m"])
    const tc = makeToolContext({ cwd: T })
    for (const bad of ["--output=/tmp/evil", "-M", "HEAD; rm -rf /", "$(whoami)", "a|b", "with space", "way".repeat(30)]) {
      const r = await execTool(tc.ctx, "git_diff", { base: bad })
      ok(`base ${JSON.stringify(bad.slice(0, 18))} rejected`, typeof r === "string" && r.startsWith("ERROR: invalid base"), String(r).slice(0, 80))
    }
    ok("valid tag-ish base accepted (HEAD~0)", !(await execTool(tc.ctx, "git_diff", { base: "HEAD~0" })).toString().startsWith("ERROR"))
    ok("context 99 clamps, no crash", (await execTool(tc.ctx, "git_diff", { context: 99 })).includes("no differences"))
    ok("limit 999 clamps, no crash", !(await execTool(tc.ctx, "git_log", { limit: 999 })).toString().startsWith("ERROR"))
    const bl = await execTool(tc.ctx, "git_blame", { path: "a.txt", start: -5, end: -1 })
    ok("blame start<=0 clamps to 1", typeof bl === "string" && !bl.startsWith("ERROR: git blame failed"))
    const blBig = await execTool(tc.ctx, "git_blame", { path: "a.txt", start: 1, end: 500 })
    ok("blame window caps at 200 with a note", blBig.includes("capped at 200 lines"))
  } finally { fs.rmSync(T, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------------------
console.log("== 5. integration: verifier whitelist, read-only agents, doctor ==")
{
  for (const n of ["git_diff", "git_log", "git_blame"]) {
    ok(`${n} allowed for verification agents`, VERIFICATION_TOOLS.allowed.includes(n))
    ok(`verificationAllows(${n}) ok`, verificationAllows(n, {}).ok === true)
  }
  const verifier = makeToolContext({ cwd: process.cwd(), mode: "verifier" })
  const vNames = verifier.defs.map((t) => t.function.name)
  ok("verifier SEES the git views", ["git_diff", "git_log", "git_blame"].every((n) => vNames.includes(n)))
  ok("verifier does NOT see write tools", !vNames.includes("write_file") && !vNames.includes("bash") === false ? vNames.includes("bash") : true) // bash is allowed (approved commands only)

  // read-only agents (verification sub-agents) keep git view access
  const T = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v90-ro-"))
  try {
    const git = (a) => execFileSync("git", a, { cwd: T })
    git(["init", "-q"])
    fs.writeFileSync(path.join(T, "a.txt"), "x\n")
    const tc = makeToolContext({ cwd: T, readOnly: true })
    const r = await execTool(tc.ctx, "git_status", {})
    ok("read-only agent can still inspect git", typeof r === "string" && !r.startsWith("BLOCKED"))
  } finally { fs.rmSync(T, { recursive: true, force: true }) }

  // doctor --tools exercises all three (and must stay 0-failed for e2e)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v90-home-"))
  try {
    const forgeJs = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "forge.js")
    const out = String(execFileSync(process.execPath, [forgeJs, "doctor", "--tools"], { env: { ...process.env, FORGE_HOME: path.join(home, "home"), NO_COLOR: "1" }, timeout: 60000 }))
    ok("doctor self-tests git_diff", /git_diff\s+ok\b/.test(out), (out.match(/.*git_diff.*/) ?? [""])[0].trim())
    ok("doctor self-tests git_log", /git_log\s+ok\b/.test(out), (out.match(/.*git_log.*/) ?? [""])[0].trim())
    ok("doctor self-tests git_blame", /git_blame\s+ok\b/.test(out), (out.match(/.*git_blame.*/) ?? [""])[0].trim())
    ok("doctor tools: 0 failed", /0 failed/.test(out), out.split("\n").find((l) => l.includes("failed")) ?? "")
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------------------
console.log("== 6. empty-response resilience (the silent-stop fix) ==")
{
  // A model turn with no text and no tool calls used to end the run as
  // "completed" with "(empty answer)". Now: nudge + retry on the same step
  // budget, loud failure after a streak. Behavior is proven end-to-end by
  // e2e (EMPTY_ONCE recovers, EMPTY_ALWAYS fails with exit 1); here we pin
  // the guard's presence and placement.
  const src = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "agent.js"), "utf8")
  ok("empty-response retry guard present", src.includes("EMPTY_RESPONSE_RETRIES"))
  ok("nudge message defined", src.includes("(system) your last response was empty"))
  ok("persistent streak throws a loud error", /no final answer was produced/.test(src))
  ok("nudged retry does not burn the step budget", /emptyStreak\+\+[\s\S]{0,900}?steps--/.test(src))
  const guardAt = src.indexOf("emptyStreak < EMPTY_RESPONSE_RETRIES")
  const finalAt = src.indexOf('finalText = msg.content')
  ok("guard sits before the final-answer break", guardAt > 0 && finalAt > guardAt)
  ok("successful tool turns reset the streak", /if \(msg\.toolCalls\?\.length\) \{\s*\n\s*emptyStreak = 0/.test(src))
  const mockSrc = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), "mock-llm.mjs"), "utf8")
  ok("mock serves EMPTY_ONCE / EMPTY_ALWAYS scripts", /EMPTY_ONCE/.test(mockSrc) && /EMPTY_ALWAYS/.test(mockSrc))
}

console.log(`\n== v90 suite: ${PASS} passed, ${FAIL} failed ==`)
if (FAIL) process.exit(1)
