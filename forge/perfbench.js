/**
 * forge — FORGE-PERF (v116 "measurewise-2", zero dependencies)
 *
 * Why this module exists, stated plainly: until now nothing in forge measured
 * how long forge takes. `bench.js` scores decision QUALITY against a fixed
 * ladder; `evalbench.js` scores whether a task was actually solved (and needs
 * a live model). Neither reports a millisecond, and `grep -rn hrtime` over the
 * production tree returned nothing. That means every past claim about forge
 * being "faster" rested on nobody's measurement, and every future optimization
 * would have had nothing to prove itself against.
 *
 * So this is not an optimization. It is the thing an optimization has to pass.
 *
 *   forge perf                  measure the hot paths, print the report
 *   forge perf --save           store the numbers as this project's baseline
 *   forge perf --compare        measure again and diff against that baseline
 *   forge perf --json           machine output
 *
 * HONESTY RULES (the whole point — see the project's "never fake a hit" line):
 *
 *   1. A case that throws is reported ERR and is EXCLUDED from every summary.
 *      A benchmark that "passes" because the work never ran is worse than no
 *      benchmark: it reports the speed of failing.
 *   2. A difference smaller than the case's OWN measured noise is reported as
 *      "unchanged". Never "faster". The baseline's p95−p50 spread is part of
 *      the band, so a case that jitters by 40ms cannot be declared a 10ms win.
 *   3. Single-sample cases (a cold path is only cold once per process) are
 *      labelled and get a wider band. They are indicative, not conclusive, and
 *      the report says so instead of pretending otherwise.
 *   4. Every number is wall time actually observed here, on this machine, with
 *      this project. Nothing is extrapolated, normalized or scaled.
 *
 * No model. No network. Read-only with respect to the measured project: the
 * only writes are forge's own caches under ~/.forge/projects/<hash>/, exactly
 * as a normal run would write them (FORGE_INDEX=0 disables those).
 */
import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { writeStateFile } from "./securefs.js"
import { projectDir } from "./memory.js"
import { VERSION } from "./version.js"

export const PERF_FILE = "perf-baseline.json"
export const PERF_VERSION = 1

/** Default noise band. A delta must clear ALL of these to be called a change. */
export const NOISE_MS = 2
export const NOISE_PCT = 0.08
/** A single-sample case has no spread to measure, so it gets a wider band. */
export const SINGLE_NOISE_PCT = 0.25

const FORGE_DIR = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// timing
// ---------------------------------------------------------------------------

function quantile(sorted, q) {
  if (!sorted.length) return null
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

const round2 = (x) => Math.round(Number(x) * 100) / 100

/**
 * Measure a genuinely cold path: a path is only cold once per process, so the
 * only honest way to repeat it is a fresh process each time. The child times
 * the work ITSELF and prints the number, so node's own startup is excluded —
 * what comes back is the work, not the spawn.
 */
function childMs(expr, cwd) {
  const code = `
    const t0 = process.hrtime.bigint()
    await (${expr})
    process.stdout.write(String(Number(process.hrtime.bigint() - t0) / 1e6))
  `
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd, encoding: "utf8" })
  const ms = Number(String(r.stdout ?? "").trim())
  if (!Number.isFinite(ms)) throw new Error(`cold measurement failed: ${String(r.stderr ?? "").trim().slice(0, 120)}`)
  return ms
}

/**
 * Time one case. Warmup runs are executed and DISCARDED (they are not faster
 * numbers, they are a different measurement: a cold path). A throw at any
 * point ends the case — a partially measured case reports no number at all.
 */
async function timeCase(c, ctx) {
  const warmup = Math.max(0, Number(c.warmup ?? 0))
  const reps = Math.max(1, Number(c.reps ?? 5))
  const samples = []
  try {
    // A case may need a precondition it does not want to measure. `repomap` and
    // `semantic_search` both read an index off disk: without warming it first,
    // whichever rep happens to run after the tree changed pays a rebuild and
    // the case reports a regression that is really just its own precondition
    // moving. Measured, not theorized — the first run after the test suite
    // reported repo-map-first at 175ms and the next three at ~34ms.
    if (typeof c.prepare === "function") await c.prepare(ctx)
    for (let i = 0; i < warmup; i++) await c.run(ctx)
    for (let i = 0; i < reps; i++) {
      if (c.innerMs) { samples.push(Number(await c.run(ctx))); continue }
      const t0 = process.hrtime.bigint()
      await c.run(ctx)
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6)
    }
    if (samples.some((x) => !Number.isFinite(x))) throw new Error("a rep produced no measurement")
  } catch (e) {
    return { id: c.id, group: c.group, label: c.label, reps: 0, err: String(e?.message ?? e).slice(0, 200) }
  }
  const sorted = samples.slice().sort((a, b) => a - b)
  return {
    id: c.id,
    group: c.group,
    label: c.label,
    reps: samples.length,
    single: samples.length === 1,
    p50: round2(quantile(sorted, 0.5)),
    p95: round2(quantile(sorted, 0.95)),
    mean: round2(samples.reduce((a, b) => a + b, 0) / samples.length),
    min: round2(sorted[0]),
    max: round2(sorted[sorted.length - 1]),
    err: null,
  }
}

// ---------------------------------------------------------------------------
// the cases — the paths a real run actually pays for (§86)
// ---------------------------------------------------------------------------

const TASK = "fix the off-by-one in the pager so the last page is not dropped"

const MIXED_BATCH = [
  { id: "a", name: "read_file", args: { path: "agent.js", limit: 80 } },
  { id: "b", name: "grep_files", args: { pattern: "runAgent", path: "." } },
  { id: "c", name: "glob_files", args: { pattern: "*.js" } },
  { id: "d", name: "list_dir", args: { path: "." } },
  { id: "e", name: "read_file", args: { path: "meta.js", limit: 80 } },
  { id: "f", name: "write_file", args: { path: "out.txt", content: "x" } },
  { id: "g", name: "read_file", args: { path: "tools.js", limit: 80 } },
  { id: "h", name: "bash", args: { command: "npm test" } },
]

const TOOL_LOG = [
  { name: "read_file", result: "ok" },
  { name: "grep_files", result: "3 matches" },
  { name: "edit_file", result: "edited src/pager.js" },
  { name: "bash", result: "PASS 12 tests" },
]

export const PERF_CASES = [
  // ---- startup: what the user waits for before anything happens ----------
  {
    id: "startup-help", group: "startup", label: "CLI cold start (forge --help)",
    reps: 3, warmup: 1,
    run: () => { spawnSync(process.execPath, [path.join(FORGE_DIR, "forge.js"), "--help"], { stdio: "ignore" }) },
  },
  {
    id: "startup-status", group: "startup", label: "CLI cold start (forge status)",
    reps: 3, warmup: 1,
    run: () => { spawnSync(process.execPath, [path.join(FORGE_DIR, "forge.js"), "status"], { stdio: "ignore" }) },
  },

  // ---- decision paths: cheap, but run on EVERY step ----------------------
  {
    id: "classify-task", group: "decide", label: "task classification",
    reps: 200, warmup: 20,
    run: (ctx) => { ctx.classify.classifyTask(TASK) },
  },
  {
    id: "route-plan", group: "decide", label: "tool-batch scheduling (8 calls)",
    reps: 200, warmup: 20,
    run: (ctx) => { ctx.router.planExecution(MIXED_BATCH, { registry: ctx.registry, ctx: { cwd: ctx.cwd } }) },
  },
  {
    id: "route-select", group: "decide", label: "tool selection (router.route)",
    reps: 100, warmup: 10,
    run: (ctx) => { ctx.router.route({ task: TASK, registry: ctx.registry, context: { cwd: ctx.cwd } }) },
  },
  {
    id: "classify-search", group: "decide", label: "search intent classification",
    reps: 200, warmup: 20,
    // v117 runs this before every search hint, so it has to be free. If it is
    // not, the thing meant to remove wasted work becomes wasted work.
    run: (ctx) => { ctx.router.classifySearch("what calls parseConfig in the loader") },
  },
  {
    id: "gate-fastpath", group: "decide", label: "completion gate (fast path)",
    reps: 200, warmup: 20,
    run: (ctx) => { ctx.completion.canCompleteFastPath({ finalText: "fixed and tested", toolLog: TOOL_LOG, commandChecks: [] }) },
  },

  // ---- discovery: the paths that touch the filesystem --------------------
  {
    id: "list-source-files", group: "search", label: "source-file walk",
    reps: 5, warmup: 1,
    run: (ctx) => { ctx.repomap.listSourceFiles(ctx.cwd, { maxFiles: 400 }) },
  },
  {
    id: "glob-js", group: "search", label: "glob_files **/*.js",
    reps: 5, warmup: 1,
    run: (ctx) => ctx.tools.execTool(ctx.toolCtx, "glob_files", { pattern: "**/*.js" }),
  },
  {
    id: "grep-symbol", group: "search", label: "grep_files (symbol)",
    reps: 5, warmup: 1,
    run: (ctx) => ctx.tools.execTool(ctx.toolCtx, "grep_files", { pattern: "export function", path: "." }),
  },
  {
    id: "semantic-first", group: "search", label: "semantic_search (cold process)",
    reps: 3, warmup: 0, innerMs: true,
    // warm the ON-DISK index first: this case measures the cold PROCESS, not a
    // cold index. Without this it silently measures whichever of the two the
    // machine happened to be in.
    prepare: (ctx) => ctx.codesearch.semanticSearch(ctx.cwd, "warm the on-disk index", { limit: 1, maxFiles: 200 }),
    run: (ctx) => childMs(`import("${JSON.stringify(path.join(FORGE_DIR, "codesearch.js")).slice(1, -1)}").then((m) => m.semanticSearch(process.cwd(), "where is the completion gate decided", { limit: 5, maxFiles: 200 }))`, ctx.cwd),
  },
  {
    id: "semantic-warm", group: "search", label: "semantic_search (chunks cached)",
    reps: 3, warmup: 1,
    run: (ctx) => ctx.codesearch.semanticSearch(ctx.cwd, "where is the completion gate decided", { limit: 5, maxFiles: 200 }),
  },

  // ---- index + context: the expensive per-run construction ---------------
  {
    id: "repomap-first", group: "context", label: "repo map (cold process)",
    reps: 3, warmup: 0, innerMs: true,
    prepare: (ctx) => { ctx.repomap.buildRepoMap(ctx.cwd, { maxFiles: 400 }) },
    run: (ctx) => childMs(`import("${JSON.stringify(path.join(FORGE_DIR, "repomap.js")).slice(1, -1)}").then((m) => m.buildRepoMap(process.cwd(), { maxFiles: 400 }))`, ctx.cwd),
  },
  {
    id: "repomap-warm", group: "context", label: "repo map (incremental)",
    reps: 3, warmup: 1,
    run: (ctx) => { ctx.repomap.buildRepoMap(ctx.cwd, { maxFiles: 400 }) },
  },
  {
    id: "compose-context", group: "context", label: "prompt composition",
    reps: 10, warmup: 2,
    run: (ctx) => { ctx.compose.compose(TASK, { cwd: ctx.cwd }) },
  },
]

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function buildContext(cwd) {
  const [router, classify, completion, repomap, compose, codesearch, tools, capabilities] = await Promise.all([
    import("./router.js"), import("./classify.js"), import("./completion.js"),
    import("./repomap.js"), import("./compose.js"), import("./codesearch.js"),
    import("./tools.js"), import("./capabilities.js"),
  ])
  return {
    cwd,
    router, classify, completion, repomap, compose, codesearch, tools,
    registry: capabilities.createRegistry({ config: {} }),
    toolCtx: { cwd, root: cwd, timeoutSec: 10, maxToolOutput: 20000, readOnly: true, _plugins: new Map() },
  }
}

export async function runPerf({ cwd = process.cwd(), only = null, cases = PERF_CASES, onCase = null } = {}) {
  const wanted = only
    ? cases.filter((c) => c.id === only || c.group === only || c.id.startsWith(only))
    : cases
  const ctx = await buildContext(cwd)
  let tier = "unknown", burst = false, cores = os.cpus()?.length ?? 0, totalMB = Math.round(os.totalmem() / 1048576)
  try {
    const { resourceProfile } = await import("./profile.js")
    const p = resourceProfile()
    tier = p.tier; burst = Boolean(p.burst); cores = p.cores; totalMB = p.totalMB
  } catch { /* an unreadable /proc must not stop a measurement */ }
  const results = []
  for (const c of wanted) {
    const r = await timeCase(c, ctx)
    results.push(r)
    onCase?.(r)
  }
  return {
    v: PERF_VERSION,
    forge: VERSION,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    machine: { cores, totalMB, tier, burst },
    cwd,
    ts: Date.now(),
    cases: results,
  }
}

export function summarize(run) {
  const cases = run?.cases ?? []
  const ok = cases.filter((c) => !c.err)
  const errored = cases.filter((c) => c.err)
  const byGroup = {}
  for (const c of ok) {
    byGroup[c.group] = byGroup[c.group] ?? { group: c.group, cases: 0, totalP50: 0 }
    byGroup[c.group].cases++
    byGroup[c.group].totalP50 = round2(byGroup[c.group].totalP50 + c.p50)
  }
  return {
    measured: ok.length,
    errored: errored.length,
    // The sum is NOT a score: it is the total of one pass over the measured
    // cases, and it only means anything compared against the same case set.
    totalP50: round2(ok.reduce((a, c) => a + c.p50, 0)),
    groups: Object.values(byGroup),
    errors: errored.map((c) => ({ id: c.id, err: c.err })),
  }
}

// ---------------------------------------------------------------------------
// baseline + comparison (§89/§90 — an optimization must prove itself)
// ---------------------------------------------------------------------------

export function perfBaselinePath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), PERF_FILE)
}

export function savePerfBaseline(cwd, run) {
  try {
    writeStateFile(perfBaselinePath(cwd), JSON.stringify(run, null, 1))
    return perfBaselinePath(cwd)
  } catch { return null }
}

export function loadPerfBaseline(cwd = process.cwd()) {
  try {
    const j = JSON.parse(fs.readFileSync(perfBaselinePath(cwd), "utf8"))
    return j && typeof j === "object" && Array.isArray(j.cases) ? j : null
  } catch { return null }
}

/**
 * The band a delta must clear before it is called anything at all.
 *
 * It is the widest of: an absolute floor, a percentage of the baseline, and —
 * the part that matters — the baseline case's OWN p95−p50 spread. A case that
 * naturally varies by 40ms cannot report a 10ms improvement, because that
 * "improvement" is indistinguishable from the case having a good day.
 */
export function noiseBand(base, { noiseMs = NOISE_MS, noisePct = NOISE_PCT } = {}) {
  if (!base || base.err) return Infinity
  const spread = Math.max(0, (Number(base.p95) || 0) - (Number(base.p50) || 0))
  const pct = base.single ? Math.max(noisePct, SINGLE_NOISE_PCT) : noisePct
  return Math.max(noiseMs, (Number(base.p50) || 0) * pct, spread)
}

export function comparePerf(baseline, current, opts = {}) {
  const baseById = new Map((baseline?.cases ?? []).map((c) => [c.id, c]))
  const rows = []
  for (const cur of current?.cases ?? []) {
    const base = baseById.get(cur.id) ?? null
    if (!base) { rows.push({ id: cur.id, group: cur.group, label: cur.label, verdict: "new", base: null, cur: cur.err ? null : cur.p50 }); continue }
    if (cur.err || base.err) {
      rows.push({ id: cur.id, group: cur.group, label: cur.label, verdict: "n/a", base: base.err ? null : base.p50, cur: cur.err ? null : cur.p50, err: cur.err ?? base.err })
      continue
    }
    const band = noiseBand(base, opts)
    const delta = round2(cur.p50 - base.p50)
    const pct = base.p50 > 0 ? round2((delta / base.p50) * 100) : 0
    const verdict = delta < -band ? "faster" : delta > band ? "slower" : "unchanged"
    rows.push({ id: cur.id, group: cur.group, label: cur.label, base: base.p50, cur: cur.p50, delta, pct, band: round2(band), single: Boolean(base.single || cur.single), verdict })
  }
  const missing = [...baseById.keys()].filter((id) => !(current?.cases ?? []).some((c) => c.id === id))
  const count = (v) => rows.filter((r) => r.verdict === v).length
  return {
    rows,
    faster: count("faster"),
    slower: count("slower"),
    unchanged: count("unchanged"),
    unusable: count("n/a") + count("new"),
    missing,
    // The only verdict that matters for a merge decision: did anything get
    // measurably worse? "No improvement" is a result; a regression is a stop.
    regressed: count("slower") > 0,
    baselineAt: baseline?.ts ?? null,
    sameMachine: JSON.stringify(baseline?.machine ?? null) === JSON.stringify(current?.machine ?? null),
  }
}

// ---------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n)
const padL = (s, n) => String(s).padStart(n)

export function formatPerfReport(run, { json = false } = {}) {
  if (json) return JSON.stringify(run, null, 1)
  const s = summarize(run)
  const out = []
  out.push(`FORGE-PERF ${run.forge} • node ${run.node} • ${run.platform}`)
  out.push(`machine: ${run.machine.cores} cores • ${run.machine.totalMB}MB • tier ${run.machine.tier}${run.machine.burst ? " (burst)" : ""}`)
  out.push(`project: ${run.cwd}`)
  out.push("")
  out.push(`${pad("case", 34)}${padL("p50", 9)}${padL("p95", 9)}${padL("reps", 6)}`)
  out.push("─".repeat(58))
  let group = null
  for (const c of run.cases) {
    if (c.group !== group) { group = c.group; out.push(`${group}:`) }
    if (c.err) { out.push(`  ${pad(c.label, 32)}${padL("ERR", 9)}  ${c.err.slice(0, 60)}`); continue }
    const note = c.single ? " *" : ""
    out.push(`  ${pad(c.label, 32)}${padL(c.p50.toFixed(1) + "ms", 9)}${padL(c.p95.toFixed(1) + "ms", 9)}${padL(c.reps + note, 6)}`)
  }
  out.push("─".repeat(58))
  out.push(`${s.measured} measured • ${s.errored} errored • one pass ≈ ${s.totalP50.toFixed(1)}ms`)
  if (run.cases.some((c) => c.single && !c.err)) out.push("* single sample — a cold path is only cold once per process; indicative, not conclusive")
  if (s.errored) {
    out.push("")
    out.push("errored (EXCLUDED from every number above):")
    for (const e of s.errors) out.push(`  ${e.id}: ${e.err}`)
  }
  return out.join("\n")
}

export function formatComparison(cmp, { json = false } = {}) {
  if (json) return JSON.stringify(cmp, null, 1)
  const out = []
  out.push(`${pad("case", 34)}${padL("base", 10)}${padL("now", 10)}${padL("delta", 10)}  verdict`)
  out.push("─".repeat(74))
  for (const r of cmp.rows) {
    if (r.verdict === "new") { out.push(`  ${pad(r.label ?? r.id, 32)}${padL("—", 10)}${padL(r.cur == null ? "ERR" : r.cur.toFixed(1), 10)}${padL("—", 10)}  new case`); continue }
    if (r.verdict === "n/a") { out.push(`  ${pad(r.label ?? r.id, 32)}${padL(r.base ?? "ERR", 10)}${padL(r.cur ?? "ERR", 10)}${padL("—", 10)}  not comparable`); continue }
    const d = `${r.delta > 0 ? "+" : ""}${r.delta.toFixed(1)}ms`
    out.push(`  ${pad(r.label ?? r.id, 32)}${padL(r.base.toFixed(1), 10)}${padL(r.cur.toFixed(1), 10)}${padL(d, 10)}  ${r.verdict}${r.single ? " *" : ""}`)
  }
  out.push("─".repeat(74))
  out.push(`${cmp.faster} faster • ${cmp.slower} slower • ${cmp.unchanged} unchanged${cmp.unusable ? ` • ${cmp.unusable} not comparable` : ""}`)
  out.push("a delta inside the case's own measured noise is reported as unchanged, never as an improvement")
  if (!cmp.sameMachine) out.push("WARNING: the baseline was recorded on a DIFFERENT machine profile — these numbers are not comparable")
  if (cmp.missing.length) out.push(`baseline has ${cmp.missing.length} case(s) this run did not measure: ${cmp.missing.slice(0, 5).join(", ")}`)
  if (cmp.regressed) out.push("REGRESSION: at least one case is measurably slower than the baseline")
  return out.join("\n")
}
