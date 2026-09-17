#!/usr/bin/env node
/**
 * forge — v129 "dupewise": 21 export names defined in two or more modules.
 *
 * I first called this cosmetic churn. Reading each one properly, three were not
 * naming hazards but live traps:
 *
 *  1. RISK_ORDER WAS TWO INCOMPATIBLE TYPES UNDER ONE NAME.
 *       capabilities.js  ["low","medium","high","critical"]     ARRAY, no "trivial"
 *       plannerisk.js    { trivial:0, low:1, … critical:4 }     OBJECT
 *       verifyledger.js  { trivial:0, low:1, … critical:4 }     OBJECT, byte-identical
 *     RISK_ORDER["medium"] was 2 on one and undefined on the other, silently,
 *     and both shapes were already live in one process — router.js imported the
 *     array while prediction.js imported the object. Two of this repo's own
 *     tests prove the split: test-capabilities used .includes(), while
 *     test-final-risk-recalculation used [key].
 *
 *  2. RETIRE_BELOW WAS ONE NAME FOR TWO NUMBERS — 0.25 for skills (evolve.js),
 *     0.15 for lessons (lessons.js). Import the wrong one and a retirement
 *     threshold moves 67% with nothing to notice.
 *
 *  3. pidAlive WAS COPY-PASTED. The two exported copies (runlog, taskstate)
 *     were character-identical.
 *
 * The rest are renamed only where both sides are imported or the name is a bare
 * verb. The others stay, on the ALLOWED list below, so "left alone" is a
 * recorded decision instead of an oversight.
 *
 * This suite is the durable half. Without it the list simply regrows.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v129-"))
process.env.FORGE_HOME = HOME
const ROOT = path.dirname(new URL("../package.json", import.meta.url).pathname)

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 400)}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

/**
 * Names deliberately shared by two modules. Each is domain-scoped and never
 * imported into the same file, so renaming would be churn against working code.
 * Adding to this list is allowed — doing it silently is what this test prevents.
 */
const ALLOWED = new Set([
  "tokenize",        // retrieval (BM25 terms) vs shellguard (argv) — unrelated domains
  "catalogEntry",    // mcpcatalog vs skillforge — each its own catalog
  "namedInTask",     // capfabric vs caproute — same question, both private in practice
  "summarize",       // evalbench (eval run) vs perfbench (timing samples)
  "DRIFT",           // prediction (scope drift) vs skilldl (skill drift)
  "verifyTool",      // skilldl (downloaded) vs toolcreate (generated)
  "connectServer",   // lsp vs mcp — two protocols, two clients
  "PERF_FILE",       // modelstrategy model-performance.json vs perfbench perf-baseline.json
  "STATUS",          // capabilities vs knowgap
  "effectiveStats",  // crewroute vs modelstrategy
  "runVerification", // evalbench vs verify
  "validSkillName",  // skills vs tools
])

const files = fs.readdirSync(ROOT).filter((f) => f.endsWith(".js"))
const exportsOf = (t) => {
  const n = new Set()
  for (const m of t.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) n.add(m[1])
  for (const m of t.matchAll(/^export\s+(?:const|let|class)\s+([A-Za-z0-9_$]+)/gm)) n.add(m[1])
  return n
}
const byName = new Map()
for (const f of files) {
  for (const n of exportsOf(fs.readFileSync(path.join(ROOT, f), "utf8"))) {
    if (!byName.has(n)) byName.set(n, [])
    byName.get(n).push(f)
  }
}

// ---------------------------------------------------------------------------
console.log("== 1. no two modules export the same name ==")
{
  const collisions = [...byName].filter(([n, owners]) => owners.length > 1 && !ALLOWED.has(n))
  ok(`no unallowed duplicate export names (${byName.size} names across ${files.length} modules)`,
    collisions.length === 0,
    collisions.map(([n, o]) => `${n} in ${o.join(" + ")}`).join(" | "))

  // The allowlist must not rot: an entry that no longer collides is stale.
  const stale = [...ALLOWED].filter((n) => (byName.get(n) ?? []).length < 2)
  ok("every allowlist entry still names a real, deliberate collision", stale.length === 0,
    `stale: ${stale.join(", ")} — remove them`)
}

// ---------------------------------------------------------------------------
console.log("== 2. RISK_ORDER is one type, in one place ==")
{
  const vl = await import("../verifyledger.js")
  const pr = await import("../plannerisk.js")
  const cap = await import("../capabilities.js")

  ok("verifyledger owns the ladder object", typeof vl.RISK_ORDER === "object" && !Array.isArray(vl.RISK_ORDER))
  ok("plannerisk re-exports the SAME object, not a copy", pr.RISK_ORDER === vl.RISK_ORDER)
  eq("and it is the complete ladder", Object.keys(vl.RISK_ORDER), ["trivial", "low", "medium", "high", "critical"])

  ok("capabilities no longer exports a RISK_ORDER of a different type", cap.RISK_ORDER === undefined)
  ok("its tier list is named for what it is", Array.isArray(cap.RISK_TIERS))
  ok("and riskRank still works through it", cap.riskRank("high") === 2 && cap.riskRank("low") === 0)

  // The confusion, stated as the test that would have caught it: one shape
  // answers [key], the other answers .includes() — and they must not share a name.
  ok("object lookup works on the ladder", vl.RISK_ORDER.medium === 2)
  ok("membership works on the tier list", cap.RISK_TIERS.includes("medium"))
  ok("the ladder is NOT an array and the tiers are NOT keyed",
    !Array.isArray(vl.RISK_ORDER) && cap.RISK_TIERS.medium === undefined)
}

// ---------------------------------------------------------------------------
console.log("== 3. two thresholds, two names, two values ==")
{
  const ev = await import("../evolve.js")
  const le = await import("../lessons.js")
  eq("skills retire below 0.25", ev.SKILL_RETIRE_BELOW, 0.25)
  eq("lessons retire below 0.15", le.LESSON_RETIRE_BELOW, 0.15)
  ok("the ambiguous name is gone from both", ev.RETIRE_BELOW === undefined && le.RETIRE_BELOW === undefined)
  ok("the values really do differ — which is why one name was a trap",
    ev.SKILL_RETIRE_BELOW !== le.LESSON_RETIRE_BELOW)
}

// ---------------------------------------------------------------------------
console.log("== 4. pidAlive is one function ==")
{
  const rl = await import("../runlog.js")
  const ts = await import("../taskstate.js")
  ok("both modules still expose it", typeof rl.pidAlive === "function" && typeof ts.pidAlive === "function")
  ok("but it is the SAME function, not a copy", rl.pidAlive === ts.pidAlive)
  ok("and it still answers correctly for this process", rl.pidAlive(process.pid) === true)
  ok("and for a pid that cannot exist", rl.pidAlive(0) === false)
}

// ---------------------------------------------------------------------------
console.log("== 5. the renamed six resolve, and the old names are gone ==")
{
  const cases = [
    ["../usermodel.js", "userAuthorityFor", "authorityFor"],
    ["../lessons.js", "classifyLessonFailure", "classifyFailure"],
    ["../decisions.js", "ADR_STATUS", "DECISION_STATUS"],
    ["../verifyledger.js", "classifyCheckCommand", "classifyCommand"],
    ["../strategy.js", "recordProjectStrategy", "recordStrategy"],
    ["../verify.js", "VERIFY_CHECK", "CHECK"],
  ]
  for (const [mod, now, before] of cases) {
    const m = await import(mod)
    ok(`${mod.slice(3)}: ${now} exists`, m[now] !== undefined)
    ok(`${mod.slice(3)}: ${before} is gone`, m[before] === undefined)
  }
  // …and the modules that kept the original name still have it.
  ok("governor keeps authorityFor", (await import("../governor.js")).authorityFor !== undefined)
  ok("diagnose keeps classifyFailure", (await import("../diagnose.js")).classifyFailure !== undefined)
  ok("shellguard keeps classifyCommand", (await import("../shellguard.js")).classifyCommand !== undefined)
  ok("metalearn keeps recordStrategy", (await import("../metalearn.js")).recordStrategy !== undefined)
  ok("completion keeps CHECK", (await import("../completion.js")).CHECK !== undefined)
  ok("decisionengine keeps DECISION_STATUS", (await import("../decisionengine.js")).DECISION_STATUS !== undefined)
}

// ---------------------------------------------------------------------------
// v129: the check that SHOULD have caught this change's own breakage.
//
// The rename audit I ran while writing §1-§5 resolved static named imports
// across the 163 source modules and reported zero dangling references. It was
// telling the truth about the wrong set of files: seven TEST suites broke,
// because a test reaches a symbol in two ways a named-import scan cannot see —
// `import * as ns` property access, and `await import()` destructuring. The
// audit also lived in a scratch directory, so it could not fail anyone's build.
//
// So it lives here now, and it covers every reference form, in source AND in
// tests, resolved against each target's REAL runtime export list — not a regex
// guess, because a bare `export { … } from` re-export is invisible to one.
console.log("== 6. every local import in the tree resolves to a real export ==")
{
  const TESTS_DIR = path.dirname(new URL(import.meta.url).pathname)
  const srcFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith(".js")).map((f) => path.join(ROOT, f))
  const testFiles = fs.readdirSync(TESTS_DIR).filter((f) => f.endsWith(".mjs")).map((f) => path.join(TESTS_DIR, f))
  const all = [...srcFiles, ...testFiles]

  // plugin-host.js is the ENTRY of a spawned plugin process: it installs Node's
  // permission model and rewrites the module loader at import time, so it can
  // only be loaded as its own process. Nothing imports it — plugins.js spawns
  // it — so skipping it as a TARGET strands no reference. It is still scanned
  // as a referrer.
  const UNIMPORTABLE = new Set(["plugin-host.js"])

  // `ns.NAME` is scanned with strings and comments blanked out. Without that,
  // the literal "dag.js" inside a test reads as a property access `dag.js`, and
  // every source-text assertion that quotes a dotted expression becomes a
  // reference the module never makes. Offsets are preserved (spaces, not "").
  const stripLiterals = (t) => t.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
    (m) => m.replace(/[^\n]/g, " "))

  // The imported name is whatever precedes the rename: `a as b` in an import
  // clause, `a: b` in a destructure. test-v121 broke on exactly the second form
  // — `{ recordStrategy: recordProjectStrategy } = await import(strategy)`,
  // so dropping it as unparseable would leave the hole this section exists for.
  const names = (clause) => clause.split(",").map((s) => s.trim()).filter(Boolean)
    .map((s) => s.split(/\s+as\s+|:/)[0].trim()).filter((s) => /^[A-Za-z0-9_$]+$/.test(s))

  // file -> [{ target, name, how }]
  const refs = []
  for (const file of all) {
    const src = fs.readFileSync(file, "utf8")
    const code = stripLiterals(src)
    const dir = path.dirname(file)
    const resolve = (spec) => (spec.startsWith("./") || spec.startsWith("../")) && spec.endsWith(".js")
      ? path.resolve(dir, spec) : null

    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
      const t = resolve(m[2]); if (t) for (const n of names(m[1])) refs.push({ file, target: t, name: n, how: "import {}" })
    }
    for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
      const t = resolve(m[2]); if (t) for (const n of names(m[1])) refs.push({ file, target: t, name: n, how: "export {} from" })
    }
    // The `(?!\s*\.)` matters: `await import(mod).then((m) => ({ … }))`
    // destructures the THEN result, not the module, and reading it as a module
    // destructure invents a dangling name that is not there (test-v65 does this).
    for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)(?!\s*\.)/g)) {
      const t = resolve(m[2]); if (t) for (const n of names(m[1])) refs.push({ file, target: t, name: n, how: "await import()" })
    }
    // Whole-namespace bindings + every `ns.NAME` in the same file. BOTH forms
    // count: the static `import * as ns from` form that source modules use,
    // and `const ns = await import(mod)`, which is what the tests use — and
    // which is exactly how test-lessons-schema and test-v93st broke under v129
    // while a named-import scan reported the tree clean. Only the dotted form is
    // checked; `ns[key]` is dynamic by design and cannot be resolved here.
    const nsBindings = [
      ...src.matchAll(/import\s*\*\s*as\s+([A-Za-z0-9_$]+)\s+from\s*["']([^"']+)["']/g),
      ...src.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)(?!\s*\.)/g),
    ]
    for (const m of nsBindings) {
      const t = resolve(m[2]); if (!t) continue
      const ns = m[1]
      // Two trailing forms are EXISTENCE PROBES, not uses, and flagging them
      // would punish code for being careful: `ns.maybe?.(…)` says out loud that
      // the property may be absent (test-todowise and test-v93s both do this),
      // and `ns.gone === undefined` is an assertion that it is absent — which is
      // how §2 and §3 above prove the old names are really gone.
      const probe = /^(?:\s*\?\.|\s*[!=]==\s*undefined)/
      for (const u of code.matchAll(new RegExp(`(?<![A-Za-z0-9_$.])${ns}\\.([A-Za-z0-9_$]+)`, "g"))) {
        if (probe.test(code.slice(u.index + u[0].length))) continue
        refs.push({ file, target: t, name: u[1], how: `${ns}.` })
      }
    }
  }

  const exportCache = new Map()
  const exportsAt = async (target) => {
    if (exportCache.has(target)) return exportCache.get(target)
    let set = null
    try { set = new Set(Object.keys(await import(target))) } catch { set = null }
    exportCache.set(target, set)
    return set
  }

  const dangling = []
  let checked = 0, skipped = 0
  for (const r of refs) {
    if (UNIMPORTABLE.has(path.basename(r.target)) || !fs.existsSync(r.target)) { skipped++; continue }
    const set = await exportsAt(r.target)
    if (!set) { skipped++; continue }
    checked++
    if (r.name !== "default" && !set.has(r.name)) {
      dangling.push(`${path.basename(r.file)} → ${path.basename(r.target)} has no "${r.name}" (${r.how})`)
    }
  }

  ok(`every local import resolves (${checked} references across ${all.length} files, ${exportCache.size} modules loaded)`,
    dangling.length === 0, dangling.slice(0, 12).join(" | "))

  // A guard that never looked at anything passes for free. These pin the
  // audit's REACH: if a future refactor stops it seeing tests, or stops it
  // seeing namespace access, it must fail here rather than go quietly blind.
  ok("the audit reached the test suites too, not just src",
    refs.some((r) => r.file.endsWith(".mjs")) && checked > 500, `checked=${checked}`)
  ok("the audit resolves namespace property access — in tests, not only in src",
    refs.some((r) => r.how.endsWith(".") && r.file.endsWith(".mjs")) &&
    refs.some((r) => r.how.endsWith(".") && r.file.endsWith(".js")))
  ok("the audit resolves dynamic-import destructuring",
    refs.some((r) => r.how === "await import()"))
  ok("nothing was silently skipped except the known process entry",
    skipped === refs.filter((r) => UNIMPORTABLE.has(path.basename(r.target)) || !fs.existsSync(r.target)).length,
    `skipped=${skipped}`)
}

console.log(`\n${PASS} passed, ${FAIL} failed`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch { }
process.exit(FAIL ? 1 : 0)
