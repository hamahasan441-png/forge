/**
 * forge — coding-ability evaluation (v101 P0, zero dependencies)
 *
 * bench.js is a deterministic exercise of the Ω kernel with NO LIVE MODEL
 * (bench.js:4). Its 24/24 says nothing about whether forge can actually fix a
 * bug — which means every claim about "engineering intelligence" in this repo
 * has so far been unmeasured.
 *
 * This harness measures the thing that matters, and one metric above all:
 *
 *   FALSE COMPLETION — the agent reported COMPLETED and the hidden test FAILS.
 *
 * A run that solves 6/10 honestly is better than one that "solves" 9/10 with
 * three lies, because the second teaches you to trust it. Everything here is
 * arranged so that number cannot be gamed:
 *
 *   - The verification is HIDDEN. Its files are written into the workspace only
 *     AFTER the agent has finished, so the agent cannot read, edit, satisfy or
 *     delete the test it is being judged by. "Hidden" has to be mechanical, not
 *     a promise.
 *   - The verdict is the TEST's, never the agent's. `solved` comes from the
 *     hidden command's exit code; the agent's own status is recorded separately
 *     and only used to detect the disagreement.
 *   - Each task runs in a fresh temp workspace, so nothing leaks between tasks.
 *
 * The caller supplies the provider and the agent runner, so this works with any
 * live model without this module knowing anything about providers.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
// v122: the A/B runs each task ONCE per arm, so a cost delta is a
// single-sample comparison — exactly what perfbench's widest band is for.
// Reused rather than re-guessed: one threshold, one place, already tested.
import { SINGLE_NOISE_PCT } from "./perfbench.js"

const DEFAULT_TASK_TIMEOUT_MS = 300_000
const VERIFY_TIMEOUT_MS = 60_000

/**
 * The starter task set. Small on purpose: a suite that exists and runs beats a
 * larger one that never ships. Each task is a real repo with a real defect and
 * a test the agent never sees.
 */
/**
 * Every hidden verify starts with the same two lines: import the module under
 * test, and an `eq` that prints what it actually got. Nothing here is clever —
 * a failing oracle has to say WHY, or a red eval teaches nothing.
 */
const VERIFY_HEAD = (file) => `import * as m from "./${file}"
const eq = (got, want, label) => { if (JSON.stringify(got) !== JSON.stringify(want)) { console.error(label + ": got " + JSON.stringify(got) + ", want " + JSON.stringify(want)); process.exit(1) } }
`

/**
 * One task. `broken` is what the agent is handed, `fixed` is the known-good
 * answer, and `checks` is the body of the hidden verification.
 *
 * `fixed` exists so the SET can be tested without a model: the broken state
 * must FAIL its own oracle and the fixed state must PASS it. A task whose bug
 * does not actually fail, or whose oracle cannot be satisfied, is a broken
 * task — and one broken task quietly poisons every number computed from the
 * set. tests/test-v114.mjs proves all of them in milliseconds, no provider.
 */
const t = (id, klass, prompt, file, broken, fixed, checks) => ({
  id,
  class: klass,
  prompt,
  files: { [file]: broken },
  solution: { [file]: fixed },
  hiddenFiles: { "verify.mjs": VERIFY_HEAD(file) + checks + '\nconsole.log("ok")\n' },
  verify: ["node", ["verify.mjs"]],
})

/**
 * The task set.
 *
 * Every task carries a NEGATIVE check as well as a positive one — the oracle
 * asserts the surrounding behaviour still works, so a "fix" that deletes the
 * function or hard-codes the failing case does not pass. Grouped by defect
 * class so the report can say WHERE forge is weak, not only how often.
 */
export const EVAL_TASKS = [
  t("off-by-one", "off-by-one",
    "sum(numbers) in sum.js returns the wrong total - it is missing the last element. Fix it.",
    "sum.js",
    "export function sum(numbers) {\n  let total = 0\n  for (let i = 0; i < numbers.length - 1; i++) total += numbers[i]\n  return total\n}\n",
    "export function sum(numbers) {\n  let total = 0\n  for (let i = 0; i < numbers.length; i++) total += numbers[i]\n  return total\n}\n",
    'eq(m.sum([1,2,3]), 6, "sum([1,2,3])")\neq(m.sum([]), 0, "sum([])")\neq(m.sum([5]), 5, "sum([5])")\neq(m.sum([1,-1,2]), 2, "sum with negatives")'),

  t("missing-guard", "missing-guard",
    "parseConfig(text) in config.js throws on empty input. It should return an empty object instead. Fix it.",
    "config.js",
    "export function parseConfig(text) {\n  return JSON.parse(text)\n}\n",
    "export function parseConfig(text) {\n  if (!text || !String(text).trim()) return {}\n  return JSON.parse(text)\n}\n",
    'let r\ntry { r = m.parseConfig("") } catch (e) { console.error("threw on empty: " + e.message); process.exit(1) }\neq(r, {}, "parseConfig(empty)")\neq(m.parseConfig(\'{"a":1}\').a, 1, "still parses real json")'),

  t("numeric-sort", "wrong-comparator",
    "sortNumbers(xs) in sort.js sorts 10 before 9. It should sort numerically, ascending. Fix it.",
    "sort.js",
    "export function sortNumbers(xs) {\n  return [...xs].sort()\n}\n",
    "export function sortNumbers(xs) {\n  return [...xs].sort((a, b) => a - b)\n}\n",
    'eq(m.sortNumbers([10,9,100]), [9,10,100], "numeric order")\neq(m.sortNumbers([]), [], "empty list")\neq(m.sortNumbers([2,1]), [1,2], "already short")\nconst src = [3,1,2]; m.sortNumbers(src); eq(src, [3,1,2], "input is not mutated")'),

  t("clamp-bounds", "boundary-condition",
    "clamp(x, lo, hi) in clamp.js returns the wrong value - the bounds are applied the wrong way round. Fix it.",
    "clamp.js",
    "export function clamp(x, lo, hi) {\n  return Math.min(lo, Math.max(hi, x))\n}\n",
    "export function clamp(x, lo, hi) {\n  return Math.min(hi, Math.max(lo, x))\n}\n",
    'eq(m.clamp(5, 0, 10), 5, "inside range")\neq(m.clamp(-1, 0, 10), 0, "below low")\neq(m.clamp(99, 0, 10), 10, "above high")\neq(m.clamp(0, 0, 10), 0, "on the low bound")\neq(m.clamp(10, 0, 10), 10, "on the high bound")'),

  t("swallowed-error", "swallowed-error",
    "parseAmount(s) in amount.js returns 0 for input it cannot parse, hiding the problem. It should throw a RangeError for unparseable input and only return 0 for a real zero. Fix it.",
    "amount.js",
    "export function parseAmount(s) {\n  try { return Number(s) || 0 } catch { return 0 }\n}\n",
    "export function parseAmount(s) {\n  const n = Number(s)\n  if (!Number.isFinite(n)) throw new RangeError(\"not a number: \" + s)\n  return n\n}\n",
    'eq(m.parseAmount("12"), 12, "parses a number")\neq(m.parseAmount("0"), 0, "a real zero is still zero")\nlet threw = false\ntry { m.parseAmount("abc") } catch (e) { threw = e instanceof RangeError }\neq(threw, true, "unparseable input throws RangeError")'),

  t("missing-await", "async-race",
    "loadAll(keys, load) in loadall.js resolves to a list of pending promises instead of the loaded values. Fix it.",
    "loadall.js",
    "export async function loadAll(keys, load) {\n  return keys.map((k) => load(k))\n}\n",
    "export async function loadAll(keys, load) {\n  return Promise.all(keys.map((k) => load(k)))\n}\n",
    'const out = await m.loadAll(["a","b"], async (k) => k.toUpperCase())\neq(out, ["A","B"], "resolved values, in order")\neq(await m.loadAll([], async (k) => k), [], "empty list")'),

  t("slugify", "regex",
    "slugify(s) in slug.js leaves punctuation in the slug. It should lowercase, turn every run of non-alphanumeric characters into a single hyphen, and not start or end with a hyphen. Fix it.",
    "slug.js",
    "export function slugify(s) {\n  return String(s).toLowerCase().replace(/ /g, \"-\")\n}\n",
    "export function slugify(s) {\n  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, \"-\").replace(/^-+|-+$/g, \"\")\n}\n",
    'eq(m.slugify("Hello, World!"), "hello-world", "punctuation removed")\neq(m.slugify("a  b"), "a-b", "runs collapse")\neq(m.slugify("keep123"), "keep123", "alphanumerics survive")\neq(m.slugify("  trim me  "), "trim-me", "no leading or trailing hyphen")'),

  t("shared-array", "shared-state",
    "addItem(x) in items.js returns the same growing array on every call - each call should return a list containing only that call's item. Fix it.",
    "items.js",
    "const items = []\nexport function addItem(x) {\n  items.push(x)\n  return items\n}\n",
    "export function addItem(x) {\n  return [x]\n}\n",
    'eq(m.addItem(1), [1], "first call")\neq(m.addItem(2), [2], "second call does not inherit the first")\neq(m.addItem(3), [3], "third call is still clean")'),

  t("listener-off", "resource-leak",
    "The bus in bus.js never actually removes a handler: off(name, fn) leaves it subscribed, so it keeps firing. Fix it.",
    "bus.js",
    "const handlers = {}\nexport function on(name, fn) { (handlers[name] = handlers[name] || []).push(fn) }\nexport function off(name, fn) { /* TODO */ }\nexport function emit(name, v) { for (const fn of handlers[name] || []) fn(v) }\n",
    "const handlers = {}\nexport function on(name, fn) { (handlers[name] = handlers[name] || []).push(fn) }\nexport function off(name, fn) { handlers[name] = (handlers[name] || []).filter((h) => h !== fn) }\nexport function emit(name, v) { for (const fn of handlers[name] || []) fn(v) }\n",
    'let seen = []\nconst h = (v) => seen.push(v)\nm.on("x", h)\nm.emit("x", 1)\neq(seen, [1], "handler fires while subscribed")\nm.off("x", h)\nm.emit("x", 2)\neq(seen, [1], "handler is silent after off")\nconst other = []\nm.on("x", (v) => other.push(v))\nm.emit("x", 3)\neq(other, [3], "other handlers still fire")'),

  t("bool-from-env", "config-parsing",
    'boolFromEnv(v) in env.js treats the string "false" as true. Only "true" and "1" should be true; everything else is false. Fix it.',
    "env.js",
    "export function boolFromEnv(v) {\n  return Boolean(v)\n}\n",
    "export function boolFromEnv(v) {\n  return v === \"true\" || v === \"1\"\n}\n",
    'eq(m.boolFromEnv("false"), false, "the string false is false")\neq(m.boolFromEnv("0"), false, "the string 0 is false")\neq(m.boolFromEnv("true"), true, "the string true is true")\neq(m.boolFromEnv("1"), true, "the string 1 is true")\neq(m.boolFromEnv(""), false, "empty is false")\neq(m.boolFromEnv(undefined), false, "missing is false")'),

  t("null-name", "null-handling",
    "fullName(user) in name.js throws when the user has no last name, or is null. It should return what it can, trimmed, and an empty string for no user. Fix it.",
    "name.js",
    "export function fullName(user) {\n  return user.first + \" \" + user.last\n}\n",
    "export function fullName(user) {\n  if (!user) return \"\"\n  return [user.first, user.last].filter(Boolean).join(\" \").trim()\n}\n",
    'eq(m.fullName({ first: "Ada", last: "Lovelace" }), "Ada Lovelace", "both names")\neq(m.fullName({ first: "Ada" }), "Ada", "first only")\neq(m.fullName({ last: "Lovelace" }), "Lovelace", "last only")\neq(m.fullName(null), "", "no user")'),

  t("strict-int", "integer-parse",
    'toInt(s) in toint.js accepts "12abc" as 12 and returns NaN for empty input. It should return the number only when the whole string is an integer, and null otherwise. Fix it.',
    "toint.js",
    "export function toInt(s) {\n  return parseInt(s)\n}\n",
    "export function toInt(s) {\n  if (typeof s !== \"string\" || !/^-?\\d+$/.test(s.trim())) return null\n  return Number(s.trim())\n}\n",
    'eq(m.toInt("12"), 12, "plain integer")\neq(m.toInt("-3"), -3, "negative integer")\neq(m.toInt("12abc"), null, "trailing junk is rejected")\neq(m.toInt(""), null, "empty is rejected")\neq(m.toInt("1.5"), null, "a decimal is not an integer")'),

  t("normalize-key", "string-trim",
    "normalizeKey(s) in key.js does not trim surrounding whitespace, so the same key arrives under two different names. Fix it.",
    "key.js",
    "export function normalizeKey(s) {\n  return String(s).toLowerCase()\n}\n",
    "export function normalizeKey(s) {\n  return String(s).trim().toLowerCase()\n}\n",
    'eq(m.normalizeKey("  Ab "), "ab", "trimmed and lowercased")\neq(m.normalizeKey("A"), "a", "already tight")\neq(m.normalizeKey("a b"), "a b", "inner space is kept")'),

  t("month-name", "date-boundary",
    "monthName(d) in month.js is off by one - it names the previous month, and crashes for January. Fix it.",
    "month.js",
    "const NAMES = [\"January\",\"February\",\"March\",\"April\",\"May\",\"June\",\"July\",\"August\",\"September\",\"October\",\"November\",\"December\"]\nexport function monthName(d) {\n  return NAMES[d.getMonth() - 1]\n}\n",
    "const NAMES = [\"January\",\"February\",\"March\",\"April\",\"May\",\"June\",\"July\",\"August\",\"September\",\"October\",\"November\",\"December\"]\nexport function monthName(d) {\n  return NAMES[d.getMonth()]\n}\n",
    'eq(m.monthName(new Date(2020, 0, 15)), "January", "first month")\neq(m.monthName(new Date(2020, 11, 1)), "December", "last month")\neq(m.monthName(new Date(2020, 5, 30)), "June", "middle of the year")'),

  t("pagination", "boundary-condition",
    "page(xs, p, size) in page.js treats the page number as zero-based, but pages are 1-based: page 1 must return the first items. Fix it.",
    "page.js",
    "export function page(xs, p, size) {\n  return xs.slice(p * size, p * size + size)\n}\n",
    "export function page(xs, p, size) {\n  const start = Math.max(0, (p - 1) * size)\n  return xs.slice(start, start + size)\n}\n",
    'eq(m.page([1,2,3,4,5], 1, 2), [1,2], "page 1 is the first page")\neq(m.page([1,2,3,4,5], 2, 2), [3,4], "page 2")\neq(m.page([1,2,3,4,5], 3, 2), [5], "a short last page")\neq(m.page([], 1, 2), [], "empty input")'),

  t("unique-by", "dedupe",
    "uniqueBy(xs, key) in unique.js does not deduplicate objects - a Set of objects compares by identity. Deduplicate by the key function, keeping the first occurrence. Fix it.",
    "unique.js",
    "export function uniqueBy(xs, key) {\n  return [...new Set(xs)]\n}\n",
    "export function uniqueBy(xs, key) {\n  const seen = new Set()\n  const out = []\n  for (const x of xs) {\n    const k = key(x)\n    if (seen.has(k)) continue\n    seen.add(k)\n    out.push(x)\n  }\n  return out\n}\n",
    'const r = m.uniqueBy([{ id: 1, n: "a" }, { id: 1, n: "b" }, { id: 2, n: "c" }], (x) => x.id)\neq(r.length, 2, "duplicates collapsed")\neq(r[0].n, "a", "the FIRST occurrence is kept")\neq(r[1].n, "c", "the distinct one survives")\neq(m.uniqueBy([], (x) => x), [], "empty input")'),

  t("retry-attempts", "retry-logic",
    "retry(fn, attempts) in retry.js hides the final failure by returning undefined. It should return the first success, make at most `attempts` calls, and rethrow the last error when they are all used up. Fix it.",
    "retry.js",
    "export async function retry(fn, attempts) {\n  for (let i = 0; i < attempts; i++) {\n    try { return await fn() } catch {}\n  }\n}\n",
    "export async function retry(fn, attempts) {\n  let last\n  for (let i = 0; i < attempts; i++) {\n    try { return await fn() } catch (e) { last = e }\n  }\n  throw last\n}\n",
    'let calls = 0\nconst ok = await m.retry(async () => { calls++; if (calls < 3) throw new Error("later"); return "ok" }, 5)\neq(ok, "ok", "returns the first success")\neq(calls, 3, "stops calling once it succeeds")\ncalls = 0\nlet threw = false\ntry { await m.retry(async () => { calls++; throw new Error("always") }, 2) } catch { threw = true }\neq(threw, true, "rethrows when the attempts run out")\neq(calls, 2, "made exactly the allowed number of attempts")'),

  t("memoize-key", "cache-invalidation",
    "memoize(fn) in memo.js caches a single value and returns it for every argument. It should cache per argument. Fix it.",
    "memo.js",
    "export function memoize(fn) {\n  let cached\n  return (x) => (cached === undefined ? (cached = fn(x)) : cached)\n}\n",
    "export function memoize(fn) {\n  const cache = new Map()\n  return (x) => {\n    if (!cache.has(x)) cache.set(x, fn(x))\n    return cache.get(x)\n  }\n}\n",
    'let calls = 0\nconst f = m.memoize((x) => { calls++; return x * 2 })\neq(f(2), 4, "first argument")\neq(f(3), 6, "a different argument is not the cached one")\neq(f(2), 4, "the first argument is still right")\neq(calls, 2, "each distinct argument computed once")'),

  t("comparator-boolean", "wrong-comparator",
    "byName(xs) in byname.js uses a comparator that returns a boolean, so the order is not reliable. It should sort by the n field, ascending. Fix it.",
    "byname.js",
    "export function byName(xs) {\n  return [...xs].sort((a, b) => a.n > b.n)\n}\n",
    "export function byName(xs) {\n  return [...xs].sort((a, b) => String(a.n).localeCompare(String(b.n)))\n}\n",
    'eq(m.byName([{ n: "c" }, { n: "a" }, { n: "b" }]).map((x) => x.n), ["a","b","c"], "ascending by name")\neq(m.byName([{ n: "b" }, { n: "a" }]).map((x) => x.n), ["a","b"], "a short list")\neq(m.byName([]), [], "empty input")'),

  t("deep-merge", "shallow-merge",
    "merge(a, b) in merge.js overwrites whole nested objects instead of merging into them. Fix it so nested plain objects merge recursively; b wins on conflicts.",
    "merge.js",
    "export function merge(a, b) {\n  return { ...a, ...b }\n}\n",
    "const isObj = (v) => v && typeof v === \"object\" && !Array.isArray(v)\nexport function merge(a, b) {\n  const out = { ...a }\n  for (const [k, v] of Object.entries(b || {})) {\n    out[k] = isObj(v) && isObj(a?.[k]) ? merge(a[k], v) : v\n  }\n  return out\n}\n",
    'eq(m.merge({ a: { x: 1, y: 2 } }, { a: { y: 3 } }), { a: { x: 1, y: 3 } }, "nested keys survive")\neq(m.merge({ a: 1 }, { b: 2 }), { a: 1, b: 2 }, "disjoint keys")\neq(m.merge({ a: 1 }, { a: 2 }), { a: 2 }, "b wins on a scalar")\neq(m.merge({ a: [1] }, { a: [2] }), { a: [2] }, "arrays are replaced, not merged")'),

  t("percent", "rounding",
    "pct(part, total) in pct.js truncates to a whole number and divides by zero. It should return one decimal place, and 0 when the total is 0. Fix it.",
    "pct.js",
    "export function pct(part, total) {\n  return (part / total) * 100 | 0\n}\n",
    "export function pct(part, total) {\n  if (!total) return 0\n  return Math.round((part / total) * 1000) / 10\n}\n",
    'eq(m.pct(1, 3), 33.3, "one decimal place")\neq(m.pct(1, 2), 50, "a whole number stays whole")\neq(m.pct(0, 0), 0, "zero total does not divide by zero")\neq(m.pct(0, 5), 0, "zero part")'),

  t("join-path", "string-join",
    "joinPath(a, b) in joinpath.js produces double slashes when a segment already has one. Join with exactly one slash, keeping a leading slash if the first segment had one. Fix it.",
    "joinpath.js",
    "export function joinPath(a, b) {\n  return a + \"/\" + b\n}\n",
    "export function joinPath(a, b) {\n  const lead = String(a).startsWith(\"/\") ? \"/\" : \"\"\n  const parts = [a, b].map((s) => String(s).replace(/^\\/+|\\/+$/g, \"\")).filter(Boolean)\n  return lead + parts.join(\"/\")\n}\n",
    'eq(m.joinPath("a/", "/b"), "a/b", "no double slash")\neq(m.joinPath("a", "b"), "a/b", "plain segments")\neq(m.joinPath("/a", "b"), "/a/b", "a leading slash is kept")\neq(m.joinPath("a/", "b"), "a/b", "trailing slash on the first")'),

  t("map-limit", "concurrency",
    "mapLimit(xs, limit, fn) in maplimit.js ignores the limit and starts every call at once. It should never run more than `limit` at a time, and must return the results in input order. Fix it.",
    "maplimit.js",
    "export async function mapLimit(xs, limit, fn) {\n  return Promise.all(xs.map((x) => fn(x)))\n}\n",
    "export async function mapLimit(xs, limit, fn) {\n  const out = new Array(xs.length)\n  let next = 0\n  const worker = async () => {\n    while (next < xs.length) {\n      const i = next++\n      out[i] = await fn(xs[i])\n    }\n  }\n  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, xs.length)) }, worker))\n  return out\n}\n",
    'let cur = 0, peak = 0\nconst out = await m.mapLimit([1,2,3,4,5], 2, async (x) => {\n  cur++; peak = Math.max(peak, cur)\n  await new Promise((r) => setTimeout(r, 10))\n  cur--\n  return x * 2\n})\neq(out, [2,4,6,8,10], "results in input order")\nif (peak > 2) { console.error("peak concurrency " + peak + " exceeded the limit of 2"); process.exit(1) }\neq(await m.mapLimit([], 2, async (x) => x), [], "empty input")'),

  t("async-foreach", "error-propagation",
    "processAll(xs, fn) in processall.js uses forEach with an async callback, so it returns before the work is done and swallows every error. It should await the work in order and let errors propagate. Fix it.",
    "processall.js",
    "export async function processAll(xs, fn) {\n  const out = []\n  xs.forEach(async (x) => { out.push(await fn(x)) })\n  return out\n}\n",
    "export async function processAll(xs, fn) {\n  const out = []\n  for (const x of xs) out.push(await fn(x))\n  return out\n}\n",
    'eq(await m.processAll([1,2,3], async (x) => x * 2), [2,4,6], "awaited results, in order")\nlet threw = false\ntry { await m.processAll([1], async () => { throw new Error("boom") }) } catch { threw = true }\neq(threw, true, "an error from fn propagates")\neq(await m.processAll([], async (x) => x), [], "empty input")'),
]

/** Write a {path: content} map into a directory, creating parents. */
function writeFiles(dir, files = {}) {
  for (const [rel, content] of Object.entries(files || {})) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, String(content))
  }
}

/** Run the hidden verification. Its EXIT CODE is the verdict. */
export function runVerification(dir, verify, { exec = execFileSync } = {}) {
  if (!Array.isArray(verify) || !verify.length) return { passed: false, output: "no verification defined" }
  const [cmd, args = []] = verify
  try {
    const out = String(exec(cmd, args, { cwd: dir, encoding: "utf8", timeout: VERIFY_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }))
    return { passed: true, output: out.slice(0, 2000) }
  } catch (e) {
    const out = `${String(e?.stdout ?? "")}${String(e?.stderr ?? "")}` || String(e?.message ?? e)
    return { passed: false, output: out.slice(0, 2000) }
  }
}

/**
 * Run one task end to end.
 *
 * @param task      one EVAL_TASKS entry
 * @param runAgent  the agent runner (injected, so this module knows no providers)
 * @returns a scored result; `solved` is ALWAYS the hidden test's verdict
 */
export async function runEvalTask(task, { runAgent, provider, config = {}, timeoutMs = DEFAULT_TASK_TIMEOUT_MS, exec } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `forge-eval-${task.id}-`))
  writeFiles(dir, task.files)
  const prevCwd = process.cwd()
  const started = Date.now()
  let agentStatus = "ERROR", agentError = null, usage = null, trace = null, steps = 0
  // Which model ACTUALLY ran. v110 put selectModel on the live path, so the
  // model a run ends up on is not always the one it was handed — and in an A/B
  // that difference would quietly become the thing being measured. Recorded
  // per result so the report can say when the arms did not match.
  let modelUsed = `${provider?.name ?? "?"}/${provider?.model ?? "?"}`
  try {
    process.chdir(dir)
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await runAgent({
        config, provider, task: task.prompt, journal: false, signal: ctl.signal,
        onEvent: (e) => { if (e?.type === "MODEL_SELECTED" && e.to) modelUsed = String(e.to) },
      })
      agentStatus = String(res?.status ?? "UNKNOWN")
      usage = res?.usage ?? null
      trace = res?.trace ?? null
      steps = Number(res?.steps ?? 0)
    } finally { clearTimeout(timer) }
  } catch (e) {
    agentError = String(e?.message ?? e).slice(0, 300)
  } finally {
    process.chdir(prevCwd)
  }
  const ms = Date.now() - started

  // HIDDEN: written only now, so the agent could not read, satisfy or delete it
  writeFiles(dir, task.hiddenFiles)
  const verification = runVerification(dir, task.verify, { exec })

  const claimedComplete = agentStatus === "COMPLETED"
  return {
    id: task.id,
    class: task.class ?? null,
    modelUsed,
    solved: verification.passed,          // the TEST's verdict, never the agent's
    claimedComplete,
    falseCompletion: claimedComplete && !verification.passed,
    silentSuccess: !claimedComplete && verification.passed,
    // A run that never reached the model (bad key, HTTP 410, timeout) is NOT
    // "the agent got it wrong" — reporting the two as the same FAIL is exactly
    // the kind of quiet dishonesty this harness exists to catch.
    errored: Boolean(agentError) || agentStatus === "ERROR",
    agentStatus, agentError, steps, ms,
    tokensIn: Number(usage?.promptTokens ?? 0),
    tokensOut: Number(usage?.completionTokens ?? 0),
    toolCalls: Number(usage?.toolCalls ?? 0),
    modelCalls: Number(trace?.phases?.find((p) => p.name === "model")?.calls ?? 0),
    verification: verification.output,
    workspace: dir,
  }
}

/** Run a whole task set. Sequential by design: a shared machine under parallel
 *  load produces latency numbers that measure the machine, not the agent. */
export async function runEval({ tasks = EVAL_TASKS, runAgent, provider, config = {}, timeoutMs, exec, onTask } = {}) {
  const results = []
  for (const t of tasks) {
    const r = await runEvalTask(t, { runAgent, provider, config, timeoutMs, exec })
    results.push(r)
    try { onTask?.(r) } catch { /* reporting must not fail the eval */ }
  }
  return summarize(results)
}

export function summarize(results = []) {
  const n = results.length
  const solved = results.filter((r) => r.solved).length
  const falseCompletions = results.filter((r) => r.falseCompletion).length
  const totalMs = results.reduce((a, r) => a + (r.ms || 0), 0)
  const sorted = results.map((r) => r.ms || 0).sort((a, b) => a - b)
  return {
    tasks: n,
    solved,
    solveRate: n ? Math.round((solved / n) * 1000) / 1000 : 0,
    falseCompletions,
    errored: results.filter((r) => r.errored).length,
    silentSuccesses: results.filter((r) => r.silentSuccess).length,
    medianMs: n ? sorted[Math.floor(n / 2)] : 0,
    totalMs,
    tokensIn: results.reduce((a, r) => a + r.tokensIn, 0),
    tokensOut: results.reduce((a, r) => a + r.tokensOut, 0),
    modelCalls: results.reduce((a, r) => a + r.modelCalls, 0),
    toolCalls: results.reduce((a, r) => a + r.toolCalls, 0),
    // which models actually ran — one entry means the set was consistent
    models: [...new Set(results.map((r) => r.modelUsed).filter(Boolean))],
    // where it is weak, not only how often: solved/total per defect class
    byClass: (() => {
      const out = {}
      for (const r of results) {
        const k = r.class || "unclassified"
        out[k] = out[k] || { solved: 0, tasks: 0, falseCompletions: 0 }
        out[k].tasks++
        if (r.solved) out[k].solved++
        if (r.falseCompletion) out[k].falseCompletions++
      }
      return out
    })(),
    results,
  }
}

/**
 * THE A/B — the reason this file exists at all.
 *
 * v109-v113 each claim that learning improves results: metalearn picks depth
 * from outcomes, selfmodel models forge from measured evidence, caplearn lets
 * capability health change routing. Nothing tested any of it. This runs the
 * SAME task set twice and reports both arms:
 *
 *   ON   defaults
 *   OFF  agent.cognition:false
 *
 * agent.js reads `config.agent?.cognition !== false` on the live path, so OFF
 * turns the real stack off rather than a flag invented for the test.
 *
 * It is built to be able to say "no difference". An A/B that can only confirm
 * is not an A/B.
 */
export async function runAB({ tasks = EVAL_TASKS, runAgent, provider, config = {}, timeoutMs, exec, onTask, lockModel = false } = {}) {
  const arm = async (label, armConfig) => {
    const prevLock = process.env.FORGE_LOCK_MODEL
    if (lockModel) process.env.FORGE_LOCK_MODEL = "1"
    try {
      return await runEval({
        tasks, runAgent, provider, config: armConfig, timeoutMs, exec,
        onTask: onTask ? (r) => onTask(label, r) : null,
      })
    } finally {
      if (lockModel) { if (prevLock === undefined) delete process.env.FORGE_LOCK_MODEL; else process.env.FORGE_LOCK_MODEL = prevLock }
    }
  }
  const on = await arm("on", { ...config, agent: { ...(config.agent || {}), cognition: true } })
  const off = await arm("off", { ...config, agent: { ...(config.agent || {}), cognition: false } })
  const models = [...new Set([...on.models, ...off.models])]
  const out = {
    on, off, lockModel,
    // Same model in both arms, or the comparison is partly about model choice.
    // Reported either way — a confound that is named is a result; one that is
    // hidden is a lie.
    sameModel: models.length <= 1,
    models,
    delta: {
      solved: on.solved - off.solved,
      falseCompletions: on.falseCompletions - off.falseCompletions,
      errored: on.errored - off.errored,
      tokensIn: on.tokensIn - off.tokensIn,
      tokensOut: on.tokensOut - off.tokensOut,
      totalMs: on.totalMs - off.totalMs,
      toolCalls: on.toolCalls - off.toolCalls,
    },
  }
  // v122: the cost verdict travels with the result, so `--json` consumers see
  // the same conclusion the text report draws instead of re-deriving it.
  out.cost = costVerdict(out)
  return out
}

export function formatEvalReport(summary) {
  if (!summary?.results?.length) return "no eval results"
  const ms = (x) => (x >= 1000 ? `${(x / 1000).toFixed(1)}s` : `${x}ms`)
  const lines = [
    `FORGE EVAL — ${summary.solved}/${summary.tasks} solved (${Math.round(summary.solveRate * 100)}%)`,
    "",
  ]
  for (const r of summary.results) {
    const mark = r.falseCompletion ? "LIE " : r.solved ? "PASS" : r.errored ? "ERR " : "FAIL"
    const note = r.falseCompletion
      ? " — claimed COMPLETED but the hidden test failed"
      : r.errored ? ` — the run never completed: ${r.agentError || r.agentStatus}`
      : r.silentSuccess ? " — solved but did not claim completion" : ""
    lines.push(`  ${mark}  ${r.id.padEnd(16)} ${String(ms(r.ms)).padStart(7)}  ${r.steps} step(s), ${r.modelCalls} model call(s)${note}`)
  }
  lines.push("")
  lines.push(`  median ${ms(summary.medianMs)} · ${summary.tokensIn} in / ${summary.tokensOut} out · ${summary.modelCalls} model calls · ${summary.toolCalls} tool calls`)
  // The headline number. Stated even when zero, because "no false completions"
  // is the claim being made and it should be visible, not inferred from silence.
  lines.push("")
  if (summary.errored) {
    // Stated before the headline, because an errored run measures the harness
    // setup, not the agent — and a solve rate computed over errors is a lie of
    // a different kind.
    lines.push(`  ${summary.errored}/${summary.tasks} run(s) NEVER REACHED THE MODEL — those are not agent failures, and the solve rate above does not mean anything until they are fixed.`)
    lines.push("")
  }
  lines.push(summary.falseCompletions
    ? `  FALSE COMPLETIONS: ${summary.falseCompletions} — the agent reported success on work that does not pass. This is the metric that matters most.`
    : "  FALSE COMPLETIONS: 0")
  return lines.join("\n")
}

/**
 * Render the A/B side by side.
 *
 * Written so that "no measurable difference" is a first-class outcome with its
 * own sentence. The whole point is to be able to learn that the learning stack
 * does not help on this set — a report that can only announce a win is not a
 * measurement, it is advertising.
 */
/**
 * v122 costwise — what the tie branch was throwing away.
 *
 * runAB has always computed delta.tokensIn/tokensOut/totalMs/toolCalls, and
 * formatABReport has always PRINTED them in the arm table. But the verdict
 * underneath read `d.solved === 0 && d.falseCompletions === 0` and nothing
 * else, so a run where cognition ON scored the same 23/24 for twice the
 * tokens was reported as:
 *
 *   NO MEASURABLE DIFFERENCE on this set: same solved count, same false
 *   completions.
 *
 * Same correctness at higher cost is not "no difference" — it is a NEGATIVE
 * result, and the eval's whole purpose is to be able to say so. (§27: never
 * call something unchanged when one axis silently got worse.) The numbers
 * were computed and displayed and never reached the conclusion — the same
 * dead wire v121 closed three of.
 *
 * WHAT COUNTS AS EVIDENCE, and what does not:
 *
 *   tokens, tool calls   the verdict. Both are attributable to the stack and
 *                        stable given the same task set.
 *   wall time            reported as context, NEVER the verdict. One run per
 *                        task against a live provider carries network and
 *                        queueing the cognitive stack does not control, so a
 *                        time delta is not evidence about the stack.
 *
 * The band is SINGLE_NOISE_PCT, reused from perfbench: each arm is one sample
 * per task, which is the case that constant already exists for.
 */
export const COST = Object.freeze({
  UNCHANGED: "unchanged",
  COSTLIER: "costlier",
  CHEAPER: "cheaper",
  MIXED: "mixed",
  UNKNOWN: "unknown",
})

export function costVerdict(ab, { band = SINGLE_NOISE_PCT } = {}) {
  const none = { verdict: COST.UNKNOWN, axes: [], why: "", band }
  if (!ab?.on || !ab?.off) return none
  // An errored arm measures the setup, not the stack. No cost claim from it.
  if (ab.on.errored || ab.off.errored) {
    return { ...none, why: "an arm never reached the model" }
  }
  const axis = (label, onV, offV) => {
    const on = Number(onV) || 0, off = Number(offV) || 0
    // No baseline to be a percentage OF: only an exact tie is honest here.
    if (!off) return { label, on, off, pct: null, moved: on !== 0 }
    const pct = (on - off) / off
    return { label, on, off, pct, moved: Math.abs(pct) > band }
  }
  const axes = [
    axis("tokens", ab.on.tokensIn + ab.on.tokensOut, ab.off.tokensIn + ab.off.tokensOut),
    axis("tool calls", ab.on.toolCalls, ab.off.toolCalls),
  ]
  const moved = axes.filter((a) => a.moved)
  if (!moved.length) return { verdict: COST.UNCHANGED, axes, band, why: `every cost axis is inside the ±${Math.round(band * 100)}% single-sample band` }
  const up = moved.filter((a) => (a.pct ?? (a.on - a.off)) > 0)
  const down = moved.filter((a) => (a.pct ?? (a.on - a.off)) < 0)
  const phrase = (a) => `${a.label} ${a.pct == null ? `${a.on} vs ${a.off}` : `${a.pct > 0 ? "+" : ""}${Math.round(a.pct * 100)}%`}`
  if (up.length && down.length) {
    return { verdict: COST.MIXED, axes, band, why: `${up.map(phrase).join(", ")} but ${down.map(phrase).join(", ")}` }
  }
  return {
    verdict: up.length ? COST.COSTLIER : COST.CHEAPER,
    axes, band,
    why: moved.map(phrase).join(", "),
  }
}

export function formatABReport(ab) {
  if (!ab?.on?.results?.length) return "no A/B results"
  const ms = (x) => (x >= 1000 ? `${(x / 1000).toFixed(1)}s` : `${x}ms`)
  const sign = (n) => (n > 0 ? `+${n}` : String(n))
  const row = (label, s) =>
    `  ${label.padEnd(5)} ${String(`${s.solved}/${s.tasks}`).padStart(6)}  ${String(s.falseCompletions).padStart(5)}  ${String(s.errored).padStart(4)}  ${String(ms(s.totalMs)).padStart(8)}  ${String(s.tokensIn + s.tokensOut).padStart(8)}  ${String(s.toolCalls).padStart(6)}`

  const lines = [
    `FORGE EVAL A/B — cognition ON vs OFF over ${ab.on.tasks} task(s)`,
    "",
    `  arm   solved  lies  err       time    tokens   tools`,
    row("ON", ab.on),
    row("OFF", ab.off),
    "",
    `  delta  solved ${sign(ab.delta.solved)} · false completions ${sign(ab.delta.falseCompletions)} · errored ${sign(ab.delta.errored)} · tokens ${sign(ab.delta.tokensIn + ab.delta.tokensOut)} · time ${sign(Math.round(ab.delta.totalMs / 1000))}s`,
  ]

  // An errored arm measures the setup, not the stack. Said before any verdict.
  if (ab.on.errored || ab.off.errored) {
    lines.push("", `  ${ab.on.errored + ab.off.errored} run(s) NEVER REACHED THE MODEL — the comparison above does not mean anything until those are fixed.`)
  }

  if (!ab.sameModel) {
    lines.push("", `  WARNING: the arms did not run on the same model (${ab.models.join(" vs ")}).`,
      `  Model selection runs on the live path, so part of this delta is model choice, not cognition.`,
      `  Re-run with --lock-model to hold the model fixed and isolate the stack.`)
  } else if (ab.lockModel) {
    lines.push("", `  model held fixed (${ab.models[0] ?? "?"}) — this delta is the cognitive stack, not model choice.`)
  }

  const d = ab.delta
  if (d.solved === 0 && d.falseCompletions === 0) {
    // v122: outcomes tied — now ask what it COST to tie, before calling it
    // "no difference". Cost is reported on tokens and tool calls only; wall
    // time is context, never the verdict.
    const cost = costVerdict(ab)
    const timeNote = `  time ${sign(Math.round(d.totalMs / 1000))}s — reported, but a live provider's latency is not evidence about the stack.`
    if (cost.verdict === COST.COSTLIER) {
      lines.push("", `  SAME OUTCOMES AT HIGHER COST: identical solved count and identical false completions, for ${cost.why}.`,
        `  That is a NEGATIVE result for cognition ON on this set, not a neutral one — the stack was paid for and`,
        `  bought nothing measurable here.`, timeNote)
    } else if (cost.verdict === COST.CHEAPER) {
      lines.push("", `  SAME OUTCOMES FOR LESS: identical solved count and identical false completions, for ${cost.why}.`,
        `  Cheaper at equal correctness is a real win, and the only one this set can show at its ceiling.`, timeNote)
    } else if (cost.verdict === COST.MIXED) {
      lines.push("", `  SAME OUTCOMES, MIXED COST: ${cost.why}.`,
        `  The axes disagree, so this set does not support a cost claim either way.`, timeNote)
    } else {
      lines.push("", `  NO MEASURABLE DIFFERENCE on this set: same solved count, same false completions, and ${cost.why}.`,
        `  That is a result. It does not prove the stack is useless — it proves this set does not show it — and`,
        `  the honest next move is a harder set, not a louder claim.`, timeNote)
    }
    // At a ceiling the solved column has no room left to move, so "no
    // difference" there says more about the set than about the stack.
    const ceiling = ab.on.tasks > 0 && (ab.on.solved / ab.on.tasks) >= 0.9 && (ab.off.solved / ab.off.tasks) >= 0.9
    if (ceiling) {
      lines.push("", `  CEILING: both arms solved ${ab.on.solved}/${ab.on.tasks}. With that little headroom the solved column`,
        `  cannot show a difference even if one exists — treat the outcome tie as uninformative, not as evidence.`)
    }
  } else {
    const better = d.solved > 0 || (d.solved === 0 && d.falseCompletions < 0)
    lines.push("", `  ${better ? "cognition ON did better" : "cognition ON did WORSE"} on this set: ` +
      `${sign(d.solved)} solved, ${sign(d.falseCompletions)} false completion(s), for ${sign(d.tokensIn + d.tokensOut)} tokens.`)
  }

  // Per-class, so a difference can be located rather than just totalled.
  const classes = [...new Set([...Object.keys(ab.on.byClass), ...Object.keys(ab.off.byClass)])].sort()
  const moved = classes.filter((c) => (ab.on.byClass[c]?.solved ?? 0) !== (ab.off.byClass[c]?.solved ?? 0))
  if (moved.length) {
    lines.push("", "  classes where the arms disagree:")
    for (const c of moved) {
      lines.push(`    ${c.padEnd(22)} ON ${ab.on.byClass[c]?.solved ?? 0}/${ab.on.byClass[c]?.tasks ?? 0}   OFF ${ab.off.byClass[c]?.solved ?? 0}/${ab.off.byClass[c]?.tasks ?? 0}`)
    }
  }
  return lines.join("\n")
}
