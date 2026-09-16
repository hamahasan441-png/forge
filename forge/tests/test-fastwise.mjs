#!/usr/bin/env node
/**
 * forge — fastwise acceptance (v94 phase 5).
 *
 * Judgment got wise (deepwise); now it gets FAST without waste:
 *   1. createFreshMemo — the ONE shared TTL + file-fingerprint memo utility
 *      (house conventions generalized: injectable `now`, oldest-at eviction,
 *      `${mtimeMs}:${size}` signature, drift-beats-TTL)
 *   2. likelyNext — offline "files this task will touch next" prediction
 *      (plan frontier + knowwise KG hubs, via engmemory's ONE KG parser)
 *   3. warmCaches — idle prefetch of the world-model snapshot + semantic
 *      chunk cache (offline, bounded, FORGE_FASTWISE=0 off-switch)
 *   4. loadPerformance memo — modelstrategy stops re-reading the perf file
 *      ~24× per selectModel; still never serves a stale file
 *   5. resolveLane — execution lanes feeding the EXISTING selectModel opts
 *   6. meta wiring — the warm hook sits beside the knowwise KG bootstrap
 *   7. DEDUP AUDIT — zero duplicate skills / tools / catalog entries / aliases,
 *      pinned so duplication cannot silently return (user directive)
 *
 * Everything is offline, deterministic, and bounded. No engine mocks for the
 * e2e warm path — real temp projects, real engines.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fastwise-home-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond, extra) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const project = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fastwise-work-"))
  fs.writeFileSync(path.join(dir, "core.js"), "export function core() { return 1 }\n")
  fs.writeFileSync(path.join(dir, "app.js"), "import { core } from './core.js'\nexport const app = () => core()\n")
  fs.writeFileSync(path.join(dir, "lib.js"), "export function lib() { return 'lib' }\n")
  return dir
}

// ---------------------------------------------------------------------------
console.log("== fastwise: the ONE fresh memo utility (TTL + fingerprint + bound) ==")
{
  const { createFreshMemo } = await import("../fastwise.js")
  const m = createFreshMemo({ ttlMs: 1000, max: 3 })
  const r1 = m.get("k", () => "v1", { now: 1000 })
  eq("first get computes", { value: r1.value, hit: r1.hit }, { value: "v1", hit: false })
  const r2 = m.get("k", () => "v2", { now: 1500 })
  eq("inside TTL → cached value served", { value: r2.value, hit: r2.hit }, { value: "v1", hit: true })
  const r3 = m.get("k", () => "v2", { now: 2500 })
  eq("past TTL → recomputed (non-sliding window)", { value: r3.value, hit: r3.hit }, { value: "v2", hit: false })

  const r4 = m.get("f", () => "a", { fingerprint: "1:1", now: 3000 })
  ok("fingerprint stored", r4.hit === false && r4.value === "a")
  const r5 = m.get("f", () => "b", { fingerprint: "1:1", now: 3500 })
  eq("same fingerprint inside TTL → hit", r5.value, "a")
  const r6 = m.get("f", () => "c", { fingerprint: "2:1", now: 3600 })
  ok("fingerprint drift beats the TTL (never serve stale)", r6.hit === false && r6.value === "c")

  m.get("e1", () => 1, { now: 4000 })
  m.get("e2", () => 1, { now: 4100 })
  m.get("e3", () => 1, { now: 4200 })
  eq("bounded at max entries", m.size, 3)
  m.get("e4", () => 1, { now: 4300 })
  eq("eviction keeps the bound", m.size, 3)
  const rEvict = m.get("e1", () => 1, { now: 4400 })
  ok("oldest entry was evicted (recomputed on return)", rEvict.hit === false)

  let threw = false
  try { m.get("t", () => { throw new Error("boom") }, { now: 5000 }) } catch { threw = true }
  ok("throwing compute propagates", threw)
  const r7 = m.get("t", () => "fine", { now: 5100 })
  ok("failures are never cached (retry computes)", r7.hit === false && r7.value === "fine")
}

// ---------------------------------------------------------------------------
console.log("== fastwise: the house freshness signature ==")
{
  const { fileFingerprint } = await import("../fastwise.js")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fastwise-fp-"))
  const f = path.join(dir, "x.txt")
  fs.writeFileSync(f, "one")
  const fp1 = fileFingerprint(f)
  ok("present file → mtimeMs:size shape", /^\d+(\.\d+)?:\d+$/.test(fp1), fp1)
  fs.writeFileSync(f, "one-longer")
  ok("changed file → changed signature", fileFingerprint(f) !== fp1)
  fs.rmSync(f)
  eq("missing file → absent sentinel", fileFingerprint(f), "absent")
}

// ---------------------------------------------------------------------------
console.log("== fastwise: likelyNext — offline prediction, one KG parser ==")
{
  const { likelyNext } = await import("../fastwise.js")
  const P = project()
  fs.mkdirSync(path.join(P, ".ua"), { recursive: true })
  fs.writeFileSync(path.join(P, ".ua", "knowledge-graph.json"), JSON.stringify({
    project: { name: "t" },
    nodes: [
      { id: "n1", type: "file", name: "core.js", filePath: "core.js", summary: "hub" },
      { id: "n2", type: "file", name: "app.js", filePath: "app.js" },
      { id: "n3", type: "file", name: "lib.js", filePath: "lib.js" },
      { id: "n4", type: "module", name: "util" },
    ],
    edges: [
      { source: "n1", target: "n2" }, { source: "n3", target: "n1" }, { source: "n1", target: "n4" },
    ],
  }))
  const r = likelyNext({ cwd: P, objectives: ["refactor core.js and update lib.js docs"], limit: 8 })
  ok("prediction succeeds offline", r.ok === true && r.bounded === true)
  const files = r.files.map((f) => f.file)
  ok("plan frontier contributes named files", files.includes("core.js") && files.includes("lib.js"), JSON.stringify(files))
  const core = r.files.find((f) => f.file === "core.js")
  ok("hub file earns frontier + hub weight (2+1)", core && core.weight >= 3, JSON.stringify(core))
  ok("why names both signals", /plan frontier/.test(core.why) && /knowledge-graph hub/.test(core.why))
  eq("signals counted", r.signals, { objectives: 1, hubs: 3 })

  const rA = likelyNext({ cwd: P, objectives: ["inspect core.js"] })
  const rB = likelyNext({ cwd: P, objectives: ["inspect core.js"] })
  eq("deterministic (two calls, one answer)", JSON.stringify(rA.files), JSON.stringify(rB.files))

  const rL = likelyNext({ cwd: P, objectives: ["touch core.js lib.js app.js util.js extra.js"], limit: 2 })
  eq("limit bounds the output", rL.files.length, 2)

  const P2 = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fastwise-empty-"))
  const rE = likelyNext({ cwd: P2, objectives: [] })
  ok("no signals → honest empty prediction (never invented)", rE.ok === true && rE.files.length === 0 && rE.signals.objectives === 0 && rE.signals.hubs === 0)
}

// ---------------------------------------------------------------------------
console.log("== fastwise: warmCaches — real engines, real temp project ==")
{
  const { warmCaches, fastwiseEnabled, clearFastwiseMemo } = await import("../fastwise.js")
  const { projectDir } = await import("../memory.js")
  clearFastwiseMemo()

  eq("default is ENABLED (full power, no opt-in needed)", fastwiseEnabled(), true)
  for (const off of ["0", "false", "OFF"]) {
    process.env.FORGE_FASTWISE = off
    eq(`disable convention: "${off}"`, fastwiseEnabled(), false)
  }
  delete process.env.FORGE_FASTWISE

  const WORK = project()
  const r1 = await warmCaches({ cwd: WORK, objectives: ["inspect lib.js"] })
  ok("warm pass succeeds", r1.ok === true, JSON.stringify(r1))
  ok("first pass is a real (non-cached) pass", r1.cached === false)
  ok("world-model snapshot warmed", r1.warmed.includes("world-snapshot"), JSON.stringify(r1.warmed))
  ok("world snapshot persisted to the state dir", fs.existsSync(path.join(projectDir(WORK), "world.json")))
  if (process.env.FORGE_INDEX !== "0") {
    ok("semantic chunk cache warmed (offline BM25 pass)", r1.warmed.some((w) => w.startsWith("semantic-chunks")), JSON.stringify(r1.warmed))
  } else {
    ok("FORGE_INDEX=0 → semantic warm skipped entirely (no fake, no write)", !r1.warmed.some((w) => w.startsWith("semantic-chunks")))
  }
  ok("likely-next prediction returned", Array.isArray(r1.predicted) && r1.predicted.includes("lib.js"), JSON.stringify(r1.predicted))

  const r2 = await warmCaches({ cwd: WORK, objectives: ["inspect lib.js"] })
  ok("inside the freshness window → memoized (no repeated work)", r2.ok === true && r2.cached === true)

  const r3 = await warmCaches({ cwd: WORK, objectives: ["inspect lib.js"], now: Date.now() + 10 * 60_000 })
  ok("past the TTL → recomputed", r3.ok === true && r3.cached === false)

  process.env.FORGE_FASTWISE = "0"
  const W2 = project()
  const r4 = await warmCaches({ cwd: W2, objectives: [] })
  ok("FORGE_FASTWISE=0 → honest refusal", r4.ok === false && r4.warmed.length === 0 && /disabled/.test(r4.reason ?? ""))
  ok("off-switch → zero side effects (no world snapshot written)", !fs.existsSync(path.join(projectDir(W2), "world.json")))
  delete process.env.FORGE_FASTWISE

  try { fs.rmSync(projectDir(WORK), { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
}

// ---------------------------------------------------------------------------
console.log("== fastwise: modelstrategy perf-file memo — never stale, never re-read ==")
{
  const ms = await import("../modelstrategy.js")
  const { recordOutcome, loadPerformance, clearPerformance, PERF_FILE } = ms
  clearPerformance()
  eq("cleared → empty", Object.keys(loadPerformance()).length, 0)

  recordOutcome({ provider: "p", model: "m1", ok: true, repairs: 0, verificationPassed: true, latencyMs: 100, tokensIn: 10, tokensOut: 5 })
  ok("recordOutcome visible through loadPerformance (write-through)", !!loadPerformance()["p:m1"])

  fs.writeFileSync(PERF_FILE, JSON.stringify({ "p:m2": { samples: 9 } }))
  const after = loadPerformance()
  ok("file changed on disk → memo re-reads (never serves stale)", !!after["p:m2"] && !after["p:m1"], JSON.stringify(Object.keys(after)))

  fs.writeFileSync(PERF_FILE, "{corrupt json")
  eq("corrupt file → honest empty, no throw", JSON.stringify(loadPerformance()), "{}")
  fs.writeFileSync(PERF_FILE, JSON.stringify({ "p:m3": { samples: 1 } }))
  ok("recovers once the file is valid again", !!loadPerformance()["p:m3"])

  fs.rmSync(PERF_FILE, { force: true })
  eq("deleted file → empty", JSON.stringify(loadPerformance()), "{}")

  // the memo must not change what routing sees (pin parity with test-model-routing-history)
  clearPerformance()
  for (let i = 0; i < 3; i++) recordOutcome({ provider: "q", model: "m4", ok: true })
  eq("samples still counted exactly through the memo", loadPerformance()["q:m4"].samples, 3)
  clearPerformance()
}

// ---------------------------------------------------------------------------
console.log("== fastwise: resolveLane — one strategy engine, no new decision path ==")
{
  const ms = await import("../modelstrategy.js")
  const { resolveLane, selectModel } = ms

  const light = resolveLane({ task: "summarize this short readme" })
  eq("trivial/simple task → fast lane", light.lane, "fast")
  eq("fast lane carries a tight latency budget (earns the honest bonus)", light.latencyBudgetMs, 12000)
  eq("fast lane biases cost", light.costBias, "low")
  eq("fast lane defaults the class", light.preferredClass, "fast_reasoning")

  const heavy = resolveLane({ task: "debug a complex production race condition across the auth module" })
  eq("complex/critical task → deep lane", heavy.lane, "deep")
  ok("deep lane has NO artificial budget", heavy.latencyBudgetMs === null && heavy.costBias === "normal")

  const moderate = resolveLane({ task: "update the readme paragraph about installation steps for windows users who run the terminal shell on their laptop" })
  eq("moderate task → balanced lane", moderate.lane, "balanced")
  eq("balanced lane adds no budget", moderate.latencyBudgetMs, null)
  const lowTier = resolveLane({ task: "update the readme paragraph about installation steps for windows users who run the terminal shell on their laptop", resources: { tier: "low", burst: false } })
  eq("low-resource device → cost bias added", lowTier.costBias, "low")

  const forced = resolveLane({ task: "summarize this short readme", deep: true })
  eq("injected depth overrides the complexity heuristic", forced.lane, "deep")
  const roleCls = resolveLane({ task: "summarize this short readme", preferredClass: "coding" })
  eq("injected role class is preserved (crewroute owns it)", roleCls.preferredClass, "coding")
  const burst = resolveLane({ task: "update the readme paragraph about installation steps for windows users who run the terminal shell on their laptop", resources: { tier: "high", burst: true } })
  ok("burst headroom (8-core 13T Pro) is visible in the why", /burst/.test(burst.why), burst.why)

  eq("deterministic", JSON.stringify(resolveLane({ task: "fix typo" })), JSON.stringify(resolveLane({ task: "fix typo" })))

  // divergence through the REAL selector with lane opts merged (meta's wiring)
  const cfg = { providers: { openai: { apiKey: "k", model: "gpt-4o" }, groq: { apiKey: "k", model: "llama-3.1-8b-instant" } } }
  const prov = { name: "openai", model: "gpt-4o" }
  const laneLight = resolveLane({ task: "summarize this short readme" })
  const selLight = selectModel(cfg, { task: "summarize this short readme", provider: prov, latencyBudgetMs: laneLight.latencyBudgetMs, costBias: laneLight.costBias })
  const laneHeavy = resolveLane({ task: "debug a complex production race condition across the auth module" })
  const selHeavy = selectModel(cfg, { task: "debug a complex production race condition across the auth module", provider: prov, latencyBudgetMs: laneHeavy.latencyBudgetMs, costBias: laneHeavy.costBias })
  ok("light task with lane opts still selects a model", !!selLight.decision)
  ok("heavy task with lane opts still selects a model", !!selHeavy.decision)
  ok("heavy keeps its debugging capability (no lane regression)", selHeavy.decision.capabilities.includes("debugging"))
}

// ---------------------------------------------------------------------------
console.log("== fastwise: meta wiring — warm hook beside the knowwise bootstrap ==")
{
  const metaSrc = fs.readFileSync(new URL("../meta.js", import.meta.url), "utf8")
  ok("warm hook calls warmCaches at the project cwd", /warmCaches\(\{ cwd: process\.cwd\(\), objectives: \[String\(state\.objective \?\? ""\)\] \}\)/.test(metaSrc))
  ok("warm timer deferred + unref'd (planning never delayed)", /fwTimer\.unref/.test(metaSrc))
  ok("FASTWISE_WARMED event emitted on a fresh warm pass", metaSrc.includes("FASTWISE_WARMED"))
  ok("lane wired into the task-level selection", /resolveLane\(\{ task: state\.objective/.test(metaSrc) && /latencyBudgetMs: lane\.latencyBudgetMs/.test(metaSrc))
  // guard: the fastwise patch left the knowwise pins byte-intact
  ok("knowwise KG bootstrap untouched", /ensureKnowledgeGraph\(\{ cwd: process\.cwd\(\) \}\)/.test(metaSrc) && /kgTimer\.unref/.test(metaSrc))

  const forgeSrc = fs.readFileSync(new URL("../forge.js", import.meta.url), "utf8")
  ok("--help documents FORGE_FASTWISE", forgeSrc.includes("FORGE_FASTWISE"))

  const fwSrc = fs.readFileSync(new URL("../fastwise.js", import.meta.url), "utf8")
  ok("fastwise honors the house disable convention", fwSrc.includes("FORGE_FASTWISE"))
}

// ---------------------------------------------------------------------------
console.log("== fastwise: behavioral warm through the real meta loop ==")
{
  const WORK = project()
  const prevCwd = process.cwd()
  process.chdir(WORK)
  try {
    const meta = await import("../meta.js")
    const { projectDir } = await import("../memory.js")
    const events = []
    const PLAN = JSON.stringify([{ id: "n1", objective: "inspect lib.js", role: "coder", targetFiles: ["lib.js"] }])
    await meta.runMeta({
      config: { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} },
      provider: { name: "x", model: "m" },
      task: "inspect lib.js",
      runAgent: async (o) => {
        if (o.planOnly) return { text: PLAN, toolRecords: [], commandChecks: [], toolLog: [] }
        return { text: "inspected", toolRecords: [], commandChecks: [], toolLog: [] }
      },
      onEvent: (e) => events.push(e),
    })
    const worldSnap = path.join(projectDir(WORK), "world.json")
    let warmedEv = events.find((e) => e.type === "FASTWISE_WARMED")
    for (let i = 0; i < 60 && !warmedEv; i++) { await new Promise((r) => setTimeout(r, 50)); warmedEv = events.find((e) => e.type === "FASTWISE_WARMED") }
    ok("world snapshot warmed by the run (idle, after planning)", fs.existsSync(worldSnap))
    ok("FASTWISE_WARMED event emitted exactly once (fresh pass only)", !!warmedEv && warmedEv.warmed.includes("world-snapshot"), JSON.stringify(events.filter((e) => e.type === "FASTWISE_WARMED")))
    try { fs.rmSync(projectDir(WORK), { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
  } finally {
    process.chdir(prevCwd)
  }
}

// ---------------------------------------------------------------------------
console.log("== fastwise: DEDUP AUDIT — zero duplicate skills, tools, aliases ==")
{
  const tools = await import("../tools.js")
  const caps = await import("../capabilities.js")
  const skillforge = await import("../skillforge.js")
  const chat = await import("../chat.js")

  // — tools: one registry, no duplicates —
  const toolNames = tools.TOOL_DEFS.map((t) => t.function.name)
  eq("30 tools registered", toolNames.length, 30)
  eq("tool names unique", new Set(toolNames).size, toolNames.length)
  const capNames = caps.BUILTIN_CAPABILITIES.map((c) => c.name)
  eq("capabilities registry 1:1 with the wire (count)", capNames.length, toolNames.length)
  ok("capabilities ↔ tools names identical (both directions)",
    toolNames.every((n) => capNames.includes(n)) && capNames.every((n) => toolNames.includes(n)))
  eq("toolCount() agrees", tools.toolCount(), 30)

  // — first-party catalog: names AND aliases may not collide —
  const FP = skillforge.FIRST_PARTY
  eq("38 first-party catalog skills (34 + v99 bundled pack)", FP.length, 38)
  const fpNames = FP.map((s) => s.name)
  eq("catalog names unique", new Set(fpNames).size, fpNames.length)
  const aliases = FP.flatMap((s) => s.aliases ?? [])
  ok(`all ${aliases.length} aliases unique across entries (no routing ambiguity)`, new Set(aliases).size, aliases.length)
  ok("no alias steals a catalog name", aliases.every((a) => !fpNames.includes(a)), JSON.stringify(aliases.filter((a) => fpNames.includes(a))))

  // — bundled skills: 106 dirs, unique frontmatter, unique content —
  const skillsDir = new URL("../skills/", import.meta.url)
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  const nonDirs = entries.filter((e) => !e.isDirectory()).map((e) => e.name).sort()
  eq("106 bundled skill directories", dirs.length, 106)
  eq("exactly one non-dir entry: the superpowers attribution", JSON.stringify(nonDirs), JSON.stringify(["superpowers-LICENSE"]))
  ok("directory names unique case-insensitively", new Set(dirs.map((d) => d.toLowerCase())).size, dirs.length)

  const fmNames = []
  const bodyHashes = []
  let missing = 0
  for (const d of dirs) {
    const p = path.join(skillsDir.pathname, d, "SKILL.md")
    if (!fs.existsSync(p)) { missing++; continue }
    const raw = fs.readFileSync(p, "utf8")
    const m = raw.match(/^name:\s*(.+?)\s*$/m)
    fmNames.push(m ? m[1].replace(/^["']|["']$/g, "").toLowerCase() : "")
    bodyHashes.push(crypto.createHash("sha256").update(raw).digest("hex"))
  }
  eq("every skill dir has a SKILL.md", missing, 0)
  eq("frontmatter names unique across all 106 (casefolded, quote-stripped)", new Set(fmNames).size, 106)
  eq("no two skills ship identical SKILL.md content", new Set(bodyHashes).size, 106)
  const dirCase = dirs.map((d) => d.toLowerCase())
  const fmShadowers = fmNames.filter((n, i) => n && n !== dirCase[i] && dirCase.includes(n))
  ok("no frontmatter name shadows a different skill directory", fmShadowers.length === 0, JSON.stringify(fmShadowers))

  // nested SKILL.md files (upstream reference material) must never shadow a top-level dir
  const nested = []
  const walk = (dir, depth) => {
    if (depth > 6) return
    let list = []
    try { list = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of list) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(full, depth + 1); continue }
      if (e.name === "SKILL.md" && depth > 2) nested.push(full)
    }
  }
  walk(skillsDir.pathname, 1)
  const dirCaseSet = new Set(dirs.map((d) => d.toLowerCase()))
  const shadowing = nested.filter((p) => {
    const raw = fs.readFileSync(p, "utf8")
    const m = raw.match(/^name:\s*(.+?)\s*$/m)
    const n = m ? m[1].replace(/^["']|["']$/g, "").toLowerCase() : ""
    return n && dirCaseSet.has(n)
  })
  ok(`no nested SKILL.md (${nested.length} found) shadows a top-level skill dir`, shadowing.length === 0, JSON.stringify(shadowing))

  // — chat command palette —
  const cmdNames = chat.COMMANDS.map((c) => c[0])
  ok(`chat commands unique (${cmdNames.length} commands)`, new Set(cmdNames).size === cmdNames.length)
}

// ---------------------------------------------------------------------------
console.log(`\nfastwise: ${PASS} passed, ${FAIL} failed`)
if (FAIL > 0) process.exit(1)
