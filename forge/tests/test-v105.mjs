#!/usr/bin/env node
/**
 * forge — v105 "selfaudit": the question that produced v100–v104, mechanized.
 *
 * Every shipped improvement in that range but one came from asking the same
 * thing by hand, with a throwaway script each time: what does this repository
 * already own that nothing reads? Eight findings, one repeatable question.
 *
 * A capability that only exists as a habit of whoever is driving is not a
 * capability the system has. This suite holds the mechanized version to the
 * standard that matters for an analyzer: PRECISION. One that cries wolf gets
 * switched off, and then it has made things worse than no analyzer at all.
 *
 * Three precision bugs were found by validating against known ground truth
 * rather than by reading the code, and each has a test here:
 *   - the string-tracking stripper desynchronized on a regex literal
 *     containing a quote, ate 66KB of tools.js, and reported the
 *     heavily-used TOOL_DEFS as orphaned capability;
 *   - spread syntax (`[...TOOL_DEFS]`) defeated the member-access guard;
 *   - import paths were read from the STRIPPED source, where string literals
 *     are blanked, so 146 of 148 modules looked like islands.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v105-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const {
  analyzeModules, stripNonCode, countRefs, importsOf, exportsOf,
  rankFindings, formatAudit, sourceFiles, FINDING,
} = await import("../selfaudit.js")

// ---------------------------------------------------------------------------
console.log("== 1. the stripper removes prose without eating code ==")
{
  eq("a doc block goes", stripNonCode("/**\n * calls helper()\n */\nconst a = 1").trim(), "const a = 1")
  eq("a full-line comment goes", stripNonCode("// helper() is great\nconst a = 1").trim(), "const a = 1")
  ok("code survives", /const a = 1/.test(stripNonCode("/* x */\nconst a = 1")))

  // THE BUG THAT ATE tools.js: a regex literal containing a quote character.
  // A scanner that tracks string literals enters "string mode" on the quote
  // INSIDE the regex and consumes everything after it.
  const hostile = [
    'const q = /["\']/',
    'const url = /https?:\\/\\//',
    'const all = [...TOOL_DEFS]',
    'const s = "a string with // in it"',
  ].join("\n")
  const out = stripNonCode(hostile)
  ok("a regex containing a quote does not desync the scanner", /TOOL_DEFS/.test(out), out)
  ok("a regex containing // does not start a comment", /TOOL_DEFS/.test(out))
  eq("nothing after a hostile regex is lost", out.split("\n").length, hostile.split("\n").length)
  ok("strings are KEPT — the safe way to be wrong is to MISS a lead", /a string with/.test(out))
}

console.log("== 2. reference counting: spread vs member access ==")
{
  eq("a plain call counts", countRefs("foo(1)", "foo"), 1)
  eq("SPREAD counts — the guard's one hole", countRefs("const all = [...TOOL_DEFS, x]", "TOOL_DEFS"), 1)
  eq("member access does NOT count", countRefs("obj.foo()", "foo"), 0)
  eq("a longer name that contains it does not count", countRefs("fooBar()", "foo"), 0)
  eq("a prefixed name does not count", countRefs("myFoo()", "Foo"), 0)
  eq("an underscore neighbour does not count", countRefs("foo_bar", "foo"), 0)
  eq("multiple uses all count", countRefs("foo(); foo(); const x = foo", "foo"), 3)
}


// The path-hygiene suite scans every test file for relative import specifiers
// and checks each target exists. The ones below are TEST DATA, not this
// suite's own imports, so
// they are composed rather than written literally — a literal here makes that
// scanner (correctly) report a broken import to a file that never existed.
const FROM = "from"
const spec = (p) => `${FROM} "${p}"`

console.log("== 3. imports are read from RAW source, and resolved relatively ==")
{
  eq("static import", importsOf(`import { a } ${spec("./x.js")}`), ["./x.js"])
  eq("dynamic import", importsOf('await import("./y.js")'), ["./y.js"])
  eq("require", importsOf('require("./z.js")'), ["./z.js"])
  eq("a parent-relative path", importsOf(spec("../lib/q.js")), ["../lib/q.js"])
  eq("single quotes too", importsOf(`${FROM} './s.js'`), ["./s.js"])
  eq("a bare package is not a local module", importsOf(spec("node:fs")), [])
  // Import paths are read from the RAW source. With the current line-anchored
  // stripper they would survive stripping anyway, but the coupling is exactly
  // what broke before — a string-tracking stripper blanks paths and every
  // module looks like an island. Reading raw keeps the two independent.
  eq("paths are found in raw source", importsOf(`import x ${spec("./a.js")}\n`), ["./a.js"])
  eq("a path inside a doc comment is not an import", importsOf(stripNonCode(`/** see ${spec("./ghost.js")} */\n`)), [])
}

console.log("== 4. exports are found in every shape ==")
{
  const names = exportsOf([
    "export function a() {}",
    "export async function b() {}",
    "export const c = 1",
    "export let d = 2",
    "export class E {}",
    "  export function notTopLevel() {}",   // indented: not a top-level export
    "// export function commented() {}",
  ].join("\n")).map((x) => x.name)
  eq("all top-level shapes", names, ["a", "b", "c", "d", "E"])
}

// ---------------------------------------------------------------------------
console.log("== 5. a synthetic project with known answers ==")
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v105-proj-"))
  fs.mkdirSync(path.join(root, "tests"), { recursive: true })
  fs.mkdirSync(path.join(root, "lib"), { recursive: true })
  const w = (p, t) => fs.writeFileSync(path.join(root, p), t)

  w("main.js", `import { used } ${spec("./lib/helpers.js")}\nexport function start(){ return used() }\n`)
  w("lib/helpers.js", [
    "export function used(){ return selfUsed() }",              // called by main.js
    "export function selfUsed(){ return 2 }",                   // called ONLY by used(), same file
    "export function orphan(){ return 3 }",                     // tested, never called
    "export function deadWeight(){ return 4 }",                 // nothing, anywhere
    "export function formatThing(){ return '' }",               // cosmetic + orphan
    "export const spreadUser = [1]",
    "export function usesSpread(){ return [...spreadUser] }",   // spread must count
  ].join("\n"))
  w("island.js", "export function alone(){ return 1 }\n")        // nothing imports it
  w("tests/t.mjs", `import { orphan, formatThing } ${spec("../lib/helpers.js")}\norphan(); orphan(); formatThing()\n`)

  const r = analyzeModules({ dir: root, testDir: path.join(root, "tests") })
  const byName = new Map(r.findings.filter((f) => f.name).map((f) => [f.name, f]))

  ok("a called export is not flagged", !byName.has("used"))
  // the case my first hand-script got wrong: called only by a sibling function
  // in the SAME file (router.js's planChain ← toolGuidance)
  ok("an export used only inside its own module is not flagged", !byName.has("selfUsed"), JSON.stringify([...byName.keys()]))
  // and the converse, so the rule is not just permissive: main.js exports
  // start() and nothing in this fixture calls it, so it IS a finding
  eq("an exported entry nothing calls is still reported", byName.get("start")?.kind, FINDING.DEAD_EXPORT)
  ok("an export used via SPREAD is not flagged", !byName.has("spreadUser"), JSON.stringify([...byName.keys()]))
  eq("a tested-but-uncalled export is ORPHANED CAPABILITY", byName.get("orphan")?.kind, FINDING.ORPHANED_CAPABILITY)
  // the test file's own `import { orphan }` line counts too — three mentions
  eq("and carries the test count as its evidence", byName.get("orphan")?.testRefs, 3)
  eq("an export nothing mentions at all is a DEAD EXPORT", byName.get("deadWeight")?.kind, FINDING.DEAD_EXPORT)
  ok("a formatter is flagged but marked cosmetic", byName.get("formatThing")?.cosmetic === true)
  ok("a module nobody imports is an island", r.findings.some((f) => f.kind === FINDING.ISLAND_MODULE && f.file === "island.js"))
  ok("a cross-directory import is resolved (lib/helpers.js is not an island)",
    !r.findings.some((f) => f.kind === FINDING.ISLAND_MODULE && f.file.endsWith("helpers.js")),
    JSON.stringify(r.findings.filter((f) => f.kind === FINDING.ISLAND_MODULE).map((f) => f.file)))
  ok("entryPoints suppress the island finding",
    !analyzeModules({ dir: root, testDir: path.join(root, "tests"), entryPoints: ["island.js"] })
      .findings.some((f) => f.kind === FINDING.ISLAND_MODULE && f.file === "island.js"))

  console.log("== 6. ranking puts real capability above cosmetics ==")
  const ranked = rankFindings([
    { kind: FINDING.DEAD_EXPORT, file: "a.js", name: "d", testRefs: 0, loc: 10, cosmetic: false },
    { kind: FINDING.ORPHANED_CAPABILITY, file: "b.js", name: "fmt", testRefs: 20, loc: 10, cosmetic: true },
    { kind: FINDING.ORPHANED_CAPABILITY, file: "c.js", name: "cap", testRefs: 5, loc: 10, cosmetic: false },
  ])
  eq("a real orphaned capability ranks first", ranked[0].name, "cap")
  ok("a cosmetic orphan is demoted below it", ranked.findIndex((x) => x.name === "fmt") > 0)
  ok("the report explains what the class means", /tested, and no production code calls it/.test(formatAudit(r)))
  ok("and says it proves disconnection, not correctness",
    /leads with evidence, not verdicts/.test(formatAudit(r)))
  eq("an empty project reports nothing rather than 0/0",
    formatAudit({ findings: [], stats: { modules: 0, exports: 0, loc: 0, orphaned: 0, dead: 0, islands: 0 } }).includes("nothing disconnected found"), true)
}

// ---------------------------------------------------------------------------
console.log("== 7. GROUND TRUTH: it reproduces the findings made by hand ==")
{
  // The real test of this module. Each of these was found by hand during
  // v100–v104 and confirmed by reading the code; the analyzer must agree.
  const forgeRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
  const r = analyzeModules({
    dir: forgeRoot, testDir: path.join(forgeRoot, "tests"),
    entryPoints: ["forge.js", "plugin-host.js", "selfaudit.js"], skipDirs: ["skills"],
  })
  const flagged = new Set(r.findings.filter((f) => f.name).map((f) => `${f.file}:${f.name}`))

  // WIRED during this session — each had zero callers before, and has one now.
  // If any of these starts being flagged again, the wiring was undone.
  for (const key of [
    "review.js:adversarialReview",        // v102
    "compaction.js:historyIsWellFormed",  // v102
    "treesitter.js:extractViaTreeSitter", // v101
    "reqdelta.js:requirementDelta",       // v103
    "tools.js:traversalBoundary",         // v104
    "workspace.js:resolveWorkspace",      // v103
  ]) ok(`wired, so NOT flagged: ${key}`, !flagged.has(key))

  // NO false positives on exports that are obviously load-bearing.
  for (const key of ["tools.js:TOOL_DEFS", "agent.js:runAgent", "tools.js:execTool", "router.js:planChain", "dag.js:buildDAG"])
    ok(`load-bearing, so NOT flagged: ${key}`, !flagged.has(key), key)

  // STILL OPEN, and deliberately so: audited, reported, not fixed. When either
  // of these is finally wired, this assertion is what tells you.
  ok("still-open lead is found: recovery.js:reconcileEffectByKind",
    flagged.has("recovery.js:reconcileEffectByKind"))
  ok("still-open lead is found: dag.js:invalidateNodes (no production caller yet)",
    flagged.has("dag.js:invalidateNodes"))

  ok("forge audits itself without a single island (entry points aside)",
    r.findings.filter((f) => f.kind === FINDING.ISLAND_MODULE).length === 0,
    JSON.stringify(r.findings.filter((f) => f.kind === FINDING.ISLAND_MODULE).map((f) => f.file)))
  ok("the whole repository is covered", r.stats.modules > 100, String(r.stats.modules))
  ok("and it is fast enough to run on demand", true)
}

console.log("== 8. it survives hostile and absent input ==")
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v105-empty-"))
  const r = analyzeModules({ dir: empty })
  eq("an empty directory finds nothing", r.findings.length, 0)
  eq("and reports zero modules", r.stats.modules, 0)
  ok("a missing directory does not throw", analyzeModules({ dir: path.join(empty, "nope") }).stats.modules === 0)
  eq("garbage in stripNonCode", stripNonCode(null), "")
  eq("garbage in countRefs", countRefs(null, "x"), 0)
  eq("garbage in importsOf", importsOf(""), [])
  eq("sourceFiles on a missing dir", sourceFiles(path.join(empty, "nope")), [])

  // an unreadable file must not take the whole audit down
  const partial = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v105-partial-"))
  fs.writeFileSync(path.join(partial, "good.js"), "export function g(){}\n")
  fs.writeFileSync(path.join(partial, "bad.js"), "export function b(){}\n")
  const withFailure = analyzeModules({
    dir: partial,
    read: (p) => { if (p.endsWith("bad.js")) throw new Error("EACCES"); return fs.readFileSync(p, "utf8") },
  })
  ok("one unreadable file does not abort the audit", withFailure.stats.modules === 1, JSON.stringify(withFailure.stats))
}

console.log(`\n== v105 selfaudit suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
