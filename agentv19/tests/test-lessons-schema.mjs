#!/usr/bin/env node
/**
 * forge — P1: a lesson is a STRUCTURED record, not a sentence.
 *
 * Before this, the controller wrote `failure / cause / failedStrategy /
 * successfulRepair / applicableContext`. Retrieval was fuzzy text matching, so
 * a lesson learned while fixing `tests/auth.spec.ts` was invisible to the next
 * task touching that file unless it happened to share words with it.
 *
 * The schema now also carries: failureClass (derived), symptoms, rootCause,
 * solution, files[], symbols[], framework (derived), model, strategy, plus
 * usage accounting (successCount / failureCount / lastUsed / uses / retired).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lessons-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const L = await import("../forge/lessons.js")

const write = (l) => L.recordLesson(l, HOME)
const load = () => L.loadLessons(HOME)

console.log("== deriving the failure class ==")
{
  eq("a failing test suite", L.classifyFailure("npm test failed: 3 tests failed in auth.spec.ts"), "test_failure")
  eq("a missing module", L.classifyFailure("Error: Cannot find module 'crypto'"), "dependency_failure")
  eq("a segfault", L.classifyFailure("segmentation fault (core dumped)"), L.FAILURE_CLASS.TOOL_CRASH)
  eq("an OOM kill", L.classifyFailure("JavaScript heap out of memory"), L.FAILURE_CLASS.TOOL_CRASH)
  eq("a compile error", L.classifyFailure("src/a.ts(4,7): error TS2322"), "build_failure")
  eq("a timeout", L.classifyFailure("command timed out after 120000ms"), L.FAILURE_CLASS.TOOL_TIMEOUT)
  eq("a permission error", L.classifyFailure("EACCES: permission denied"), L.FAILURE_CLASS.SECURITY_BLOCK)
  eq("a tool misuse", L.classifyFailure("arguments did not match the schema for edit_file"), L.FAILURE_CLASS.TOOL_MISUSE)
  eq("an unclassifiable failure falls back", L.classifyFailure("the widget was malformed"), L.FAILURE_CLASS.UNKNOWN)
}

console.log("== deriving the ecosystem ==")
{
  eq("a phpunit test file", L.detectFramework(["tests/UserTest.php"]), "php")
  eq("a pytest file + traceback", L.detectFramework(["tests/test_x.py"], "Traceback (most recent call last)"), "python")
  eq("a go test file", L.detectFramework(["pkg/a/a_test.go"]), "go")
  eq("a cargo project", L.detectFramework([], "error[E0308]: mismatched types"), "rust")
  eq("a node project", L.detectFramework(["src/a.js"], "at Object.<anonymous> (/x/a.js:1:1)"), "node")
  eq("an unknown project", L.detectFramework(["notes.txt"], "hmm"), null)
}

console.log("== the recorded record is fully structured ==")
{
  write({
    failure: "npm test failed: 3 tests failed in auth.spec.ts",
    cause: "token refresh raced with expiry",
    failedStrategy: "re-ran the suite",
    successfulRepair: "awaited the refresh before the assertions",
    applicableContext: "auth token suite",
    task: "fix the flaky auth test",
    symptoms: "AssertionError: expected 200, received 401",
    rootCause: "the refresh promise was never awaited",
    files: ["tests/auth.spec.ts", "src/auth/token.ts"],
    symbols: ["refreshToken"],
    model: "gpt-5",
    strategy: "re-run until green",
  })
  const r = load()[0]
  ok("one lesson recorded", load().length === 1)
  eq("failureClass derived", r.failureClass, "test_failure")
  eq("framework derived", r.framework, "node")
  eq("symptoms kept", r.symptoms, "AssertionError: expected 200, received 401")
  eq("rootCause kept", r.rootCause, "the refresh promise was never awaited")
  eq("files kept", r.files, ["tests/auth.spec.ts", "src/auth/token.ts"])
  eq("symbols kept", r.symbols, ["refreshToken"])
  eq("model kept", r.model, "gpt-5")
  eq("strategy kept", r.strategy, "re-run until green")
  ok("legacy fields survive", r.failure.includes("auth.spec.ts") && r.successful_repair.includes("awaited"))
  ok("it has an id", !!r.id)
  ok("it has timestamps", r.at > 0 && r.firstSeen > 0)
  eq("usage counters start at zero", [r.successCount, r.failureCount, r.uses], [0, 0, 0])
}

console.log("== retrieval is structured, not fuzzy ==")
{
  write({
    failure: "Cannot find module 'zod'",
    cause: "dependency not installed",
    successfulRepair: "",
    applicableContext: "", task: "add validation",
    files: ["src/validate.ts"], symbols: ["parseInput"], model: "gpt-5", strategy: "",
  })
  const stats = L.lessonStats(HOME)
  eq("two lessons stored", stats.total, 2)
  eq("grouped by failure class", stats.byClass.test_failure, 1)
  ok("dependency_failure is its own class", stats.byClass.dependency_failure === 1)
  eq("only one has a repair", stats.withRepair, 1)

  const hits = L.relevantLessons("tests failed in the auth suite", { cwd: HOME, limit: 5 })
  ok("a test-failure query finds the test lesson", hits.some((h) => h.failureClass === "test_failure"))

  const ineff = L.ineffectiveStrategies("add validation", { cwd: HOME, strategyHint: "re-run" })
  ok("a near-miss strategy hint still warns (re-run)", ineff.some((s) => /re-?run/i.test(`${s.strategy ?? ""} ${s.failed_strategy ?? ""}`)))
  const none = L.ineffectiveStrategies("add validation", { cwd: HOME, strategyHint: "kubernetes rollout" })
  ok("an unrelated hint reports nothing", none.length === 0)
  const byText = L.ineffectiveStrategies("flaky auth token suite", { cwd: HOME })
  ok("without a hint the failure text decides", byText.length >= 1)
  const noMatch = L.ineffectiveStrategies("kubernetes rollout yaml", { cwd: HOME })
  eq("an unrelated query matches nothing", noMatch.length, 0)
}

console.log("== usage feedback moves confidence, and lessons retire ==")
{
  const before = load().find((r) => r.failureClass === "test_failure")
  const conf0 = before.confidence
  // re-recording the SAME failure merges into the existing lesson
  for (let i = 0; i < 6; i++) {
    L.recordLesson({
      failure: before.failure, cause: before.cause, failedStrategy: before.failed_strategy,
      successfulRepair: "", applicableContext: before.applicable_context, task: before.task,
      files: [], symbols: [], model: "gpt-5", strategy: before.strategy,
    }, HOME)
  }
  const after = load().find((r) => r.id === before.id)
  eq("the record was merged, not duplicated", after.uses, 6)
  ok(`confidence decayed with use (${conf0} → ${after.confidence})`, after.confidence < conf0)
  ok("it is still a valid record", typeof after.failureClass === "string")
  ok("repeated failures are counted against it", (after.failureCount ?? 0) >= 6)
  ok("a lesson proven useless is retired", (L.lessonStats(HOME).retired ?? 0) >= 1)
}

console.log("== garbage in, no crash out ==")
{
  let threw = false
  try {
    write({})
    write({ failure: null, files: "not-an-array", symbols: [1, {}], model: undefined })
    write({ failure: "x".repeat(5000), files: new Array(500).fill("f.ts"), rootCause: "y".repeat(5000) })
  } catch { threw = true }
  ok("recording hostile lessons never throws", !threw)
  const all = load()
  ok("every stored lesson is an object", all.every((r) => r && typeof r === "object"))
  ok("every stored lesson has a class", all.every((r) => typeof r.failureClass === "string"))
  ok("every stored lesson has an array of files", all.every((r) => Array.isArray(r.files)))
  ok("oversized fields were truncated", all.every((r) => String(r.failure ?? "").length <= 2000))
  ok("the file list is bounded", all.every((r) => r.files.length <= 50))
  let threw2 = false
  try { L.lessonStats(HOME); L.relevantLessons("", { cwd: HOME }) } catch { threw2 = true }
  ok("statistics survive malformed records", !threw2)
}

console.log(`\n== lessons-schema suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
