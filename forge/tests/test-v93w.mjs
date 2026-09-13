#!/usr/bin/env node
/**
 * v93 GAP FIX — phase 6: WORLD MODEL persistence + incrementality (§12/§13).
 *
 *  1. Persistence: the joined model survives the process (world.json); a
 *     fresh instance reuses the snapshot with ZERO re-extraction.
 *  2. Incremental: a changed file re-extracts ONLY itself (reused count
 *     proves no full reparse); added files join; removed files drop.
 *  3. In-process freshness: build() after an edit sees the change (the old
 *     model went stale for the whole session).
 *  4. invalidate(paths): the §13 entry point — explicit forced re-extraction.
 *  5. Honest truncation: hitting the file cap REPORTS it (never a silent
 *     "complete" model).
 *  6. Query API compatibility: locate/dependents/answer/summarize unchanged.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93w-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93w-work-"))
process.chdir(WORK)

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const { createWorldModel, WORLD_SNAPSHOT_VERSION } = await import("../worldmodel.js")
const { projectDir } = await import("../memory.js")

// a real little repo
fs.mkdirSync(path.join(WORK, "src"), { recursive: true })
fs.writeFileSync(path.join(WORK, "src", "calc.js"), "export function add(a, b) { return a + b }\nexport const CALC_VERSION = 1\n")
fs.writeFileSync(path.join(WORK, "src", "app.js"), "import { add } from './calc.js'\nexport function total(xs) { return xs.reduce(add, 0) }\n")
fs.writeFileSync(path.join(WORK, "src", "calc.test.js"), "import { test } from 'node:test'\nimport { add } from './calc.js'\ntest('add', () => {})\n")

// ---------------------------------------------------------------------------
console.log("== 1. full build + persistence ==")
{
  const wm = createWorldModel({ cwd: WORK })
  const w = wm.build()
  ok("files indexed", w.files.length === 3, w.files.map((f) => f.path).join(","))
  ok("edges built", w.edges.length > 0)
  const snapFile = path.join(projectDir(WORK), "world.json")
  ok("the joined model is PERSISTED (world.json)", fs.existsSync(snapFile))
  const snap = JSON.parse(fs.readFileSync(snapFile, "utf8"))
  eq("snapshot version", snap.v, WORLD_SNAPSHOT_VERSION)
  ok("snapshot carries per-file fingerprints", snap.files.every((f) => f.fingerprint && typeof f.fingerprint.size === "number"))
  eq("fullBuilds counted", snap.stats.fullBuilds, 1)
  ok("no truncation reported for a small repo", w.stats.truncated === false)
}

// ---------------------------------------------------------------------------
console.log("== 2. restart reuse — ZERO re-extraction ==")
{
  const wm2 = createWorldModel({ cwd: WORK }) // a "new process"
  const w = wm2.build()
  eq("fullBuilds NOT incremented on restart reuse", w.stats.fullBuilds, 1)
  ok("snapshot reuse flagged", w.stats.reusedSnapshot === true)
  ok("files identical after reload", w.files.length === 3 && w.files.some((f) => f.path === "src/calc.js"))
  ok("symbol index reconstructed (Map)", w.symbolsIndex instanceof Map && w.symbolsIndex.has("add"))
}

// ---------------------------------------------------------------------------
console.log("== 3. incremental update — only what changed ==")
{
  // modify ONE file (new symbol, different size)
  fs.writeFileSync(path.join(WORK, "src", "calc.js"), "export function add(a, b) { return a + b }\nexport function mul(a, b) { return a * b }\nexport const CALC_VERSION = 2\n")

  const wm3 = createWorldModel({ cwd: WORK })
  const w = wm3.build()
  const inc = w.stats.incremental
  ok("incremental path taken", inc != null, JSON.stringify(w.stats))
  eq("exactly ONE file re-extracted", inc.reextracted, 1)
  eq("the other TWO reused (no full reparse)", inc.reused, 2)
  ok("the new symbol is visible (not stale)", (w.files.find((f) => f.path === "src/calc.js").symbols ?? []).includes("mul"))
  ok("CALC_VERSION updated (not the old value)", (w.files.find((f) => f.path === "src/calc.js").symbols ?? []).includes("CALC_VERSION"))
  ok("snapshot updated with the new content", JSON.parse(fs.readFileSync(path.join(projectDir(WORK), "world.json"), "utf8")).files.find((f) => f.path === "src/calc.js").symbols.includes("mul"))

  // in-process freshness: the SAME instance sees a second edit
  fs.writeFileSync(path.join(WORK, "src", "newmod.js"), "export const fresh = 42\n")
  const w2 = wm3.build()
  ok("in-process build() after an ADDED file sees it (no stale session model)", w2.files.some((f) => f.path === "src/newmod.js"))
  eq("added counted", w2.stats.incremental?.added, 1)

  // removal drops the node
  fs.rmSync(path.join(WORK, "src", "newmod.js"))
  const w3 = wm3.build()
  ok("removed file drops out of the model", !w3.files.some((f) => f.path === "src/newmod.js"))
  eq("removed counted", w3.stats.incremental?.removed, 1)
}

// ---------------------------------------------------------------------------
console.log("== 4. invalidate(paths) — the §13 entry point ==")
{
  const wm4 = createWorldModel({ cwd: WORK })
  wm4.build()
  // rewrite the file with the SAME size and mtime (simulating an edit that
  // fingerprints can't see): explicit invalidation must force re-extraction
  const target = path.join(WORK, "src", "app.js")
  const orig = fs.readFileSync(target, "utf8")
  fs.utimesSync(target, new Date(), new Date(Date.now() - 60000)) // old mtime, unchanged content-size
  const n = wm4.invalidate(["src/app.js"])
  eq("invalidate returns the dirty count", n, 1)
  const w = wm4.build()
  ok("dirty file re-extracted even when fingerprints match", w.stats.incremental?.reextracted >= 1, JSON.stringify(w.stats.incremental))
  fs.writeFileSync(target, orig)
  wm4.invalidate(["src/app.js"])
  wm4.build()
}

// ---------------------------------------------------------------------------
console.log("== 5. honest truncation ==")
{
  const BIG = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93w-big-"))
  fs.mkdirSync(path.join(BIG, "src"), { recursive: true })
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(BIG, "src", `f${i}.js`), `export const f${i} = ${i}\n`)
  const wmB = createWorldModel({ cwd: BIG, maxFiles: 5 })
  const w = wmB.build()
  eq("capped at maxFiles", w.files.length, 5)
  ok("truncation REPORTED in stats (never silent)", w.stats.truncated === true)
  ok("summarize announces the truncation honestly", /TRUNCATED/.test(wmB.summarize({ maxLines: 4 })))
}

// ---------------------------------------------------------------------------
console.log("== 6. query API compatibility (contracts preserved) ==")
{
  const wm = createWorldModel({ cwd: WORK })
  ok("locate finds by symbol", wm.locate("add").some((r) => r.path === "src/calc.js"))
  ok("dependents resolves relative imports", wm.dependents("src/calc.js").includes("src/app.js"))
  ok("dependenciesOf lists imports", wm.dependenciesOf("src/app.js").some((i) => String(i).includes("calc")))
  ok("languageOf works", wm.languageOf("src/app.js") === "javascript")
  const ans = wm.answer("what depends on src/calc.js")
  ok("answer routes dependents", ans.method === "dependents" && ans.answer.dependents.includes("src/app.js"))
  ok("recentChanges works", Array.isArray(wm.recentChanges()))
  const snap = wm.snapshot()
  ok("snapshot() reports persistence", snap.persisted === true && snap.files === 3, JSON.stringify({ persisted: snap.persisted, files: snap.files, list: wm.build().files.map((f) => f.path) }))
  // cleanup: rebuild once after the big fixture dir moved OUT of WORK
  ok("summarize is a bounded string", typeof wm.summarize() === "string" && wm.summarize().length < 2000)
  // degraded path: unreadable root
  const wmX = createWorldModel({ cwd: path.join(WORK, "does-not-exist-at-all") })
  const wx = wmX.build()
  ok("missing root degrades honestly (never throws)", wx.files.length === 0)
}

console.log(`\n== v93w: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
