/**
 * v93 "DOCSMITH" — the Documentation Writer actually writes.
 *
 *  1. the brief is deterministic: every target is obliged by the diff, a
 *     present file is never reported "missing — create", and an empty diff
 *     yields an empty brief instead of an invitation to invent something.
 *  2. the single-writer invariant survives: the documentation specialist stays
 *     read-only; the executor is still the only writer.
 *  3. a real runMeta runs the DOCUMENT phase: brief → (draft, read-only, for
 *     LARGE+) → apply, records what it wrote, and the report tells the truth.
 *  4. agent.docsAgent:false restores the v92 behaviour exactly.
 *
 * Zero network. Isolated FORGE_HOME. No live model (stub agent).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"
const FORGE_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

const di = await import("../docsintel.js")
const orch = await import("../orchestra.js")
const { TASK_CLASS } = await import("../classify.js")
const { VERSION } = await import("../version.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const DIFF = `diff --git a/forge.js b/forge.js
index 111..222 100644
--- a/forge.js
+++ b/forge.js
@@ -10,7 +10,6 @@
-export function oldHelper(a) { return a }
+export function newHelper(a, b, c) { return a + b + c }
diff --git a/lib.js b/lib.js
index 333..444 100644
--- a/lib.js
+++ b/lib.js
@@ -1,3 +1,4 @@
-old line
+new line
+another line
`

// ---------------------------------------------------------------------------
console.log("== 1. the brief is deterministic and grounded in the diff ==")
{
  const b = di.docsBrief({ objective: "replace oldHelper with newHelper", diff: DIFF, version: "93.0.0", repoFiles: ["README.md", "CHANGELOG.md", "forge.js", "lib.js"] })
  eq("the brief is not empty", b.empty, false)
  ok("it names real targets", b.targets.length >= 3, JSON.stringify(b.targets.map((t) => t.doc)))
  ok("every target carries an action and a severity", b.targets.every((t) => t.action && t.severity))
  ok("the breaking removal is recorded", /EXPORT_REMOVED oldHelper/.test(b.text), b.text.slice(0, 200))
  ok("the changelog section is ready to paste", /CHANGELOG section, ready to paste/.test(b.text))
  ok("the changed public API is named", /newHelper/.test(b.text))
  ok("the objective is in the brief", /replace oldHelper with newHelper/.test(b.text))
  ok("it forbids touching anything else", /Update ONLY the files listed/.test(b.text))

  // a file that EXISTS is never reported missing — that lie would be acted on
  const existing = b.targets.find((t) => t.doc === "changelog")
  eq("an existing CHANGELOG resolves to its real path", existing.path, "CHANGELOG.md")
  eq("and is marked as existing", existing.exists, true)
  ok("the brief does not tell the writer to create it", !/changelog \(missing/.test(b.text))

  // a file that does NOT exist is reported as create, with a concrete filename
  const migration = b.targets.find((t) => t.doc === "migration")
  eq("a missing migration note is marked missing", migration.exists, false)
  ok("and names the file to create", /migration \(missing — create MIGRATION\.md\)/.test(b.text), b.text.slice(0, 400))

  // an empty diff must not invite invention
  const none = di.docsBrief({ diff: "", repoFiles: ["README.md"] })
  eq("an empty diff yields an empty brief", none.empty, true)
  eq("and no text at all", none.text, "")
  eq("and no targets", none.targets.length, 0)

  // a docs-only change obliges nothing
  const docsOnly = di.docsBrief({ diff: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n", repoFiles: ["README.md"] })
  ok("a docs-only diff produces no code targets", !docsOnly.targets.some((t) => t.doc === "api"), JSON.stringify(docsOnly.targets.map((t) => t.doc)))

  // the brief is bounded
  const big = di.docsBrief({ diff: DIFF, repoFiles: ["README.md"], maxChars: 300 })
  ok("maxChars is respected", big.text.length <= 300, String(big.text.length))
}

// ---------------------------------------------------------------------------
console.log("== 2. the single-writer invariant survives the docs agent ==")
{
  for (const klass of [TASK_CLASS.MEDIUM, TASK_CLASS.LARGE, TASK_CLASS.ARCHITECTURAL]) {
    const rows = orch.rosterFor(klass)
    const docs = rows.find((r) => r.key === "documentation_writer")
    if (docs) {
      eq(`${klass}: the documentation writer is read-only`, docs.readOnly, true)
      eq(`${klass}: and maps to a read-only platform role`, docs.platformReadOnly, true)
    }
    const sw = orch.singleWriterOk(rows)
    ok(`${klass}: exactly one writer, and it is the executor`, sw.ok && sw.writers[0] === "executor", JSON.stringify(sw))
  }
}

// ---------------------------------------------------------------------------
console.log("== 3. the DOCUMENT phase: brief -> draft -> apply ==")
{
  const { runDocsPhase } = await import("../meta.js")

  const mkProject = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93-docs-"))
    fs.writeFileSync(path.join(dir, "README.md"), "# demo\n\nusage here\n")
    fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n")
    fs.writeFileSync(path.join(dir, "lib.js"), "export const add = (a, b) => a + b\n")
    return dir
  }
  /** stub agent: drafts when read-only, writes when it is the writer */
  const stub = (log) => async (o = {}) => {
    const readOnly = o.readOnly === true
    log.calls.push({ readOnly, maxSteps: o.maxStepsOverride, task: String(o.task ?? "") })
    if (readOnly) return { text: "## CHANGELOG.md\n\n## Unreleased\n- replaced oldHelper with newHelper\n", toolRecords: [], commandChecks: [], toolLog: [] }
    fs.appendFileSync(path.join(process.cwd(), "CHANGELOG.md"), "\n## Unreleased\n- replaced oldHelper with newHelper\n")
    return { text: "Updated the changelog.", toolRecords: [{ tool: "edit_file", files_changed: ["CHANGELOG.md"] }], commandChecks: [], toolLog: [{ name: "edit_file" }] }
  }
  const call = async ({ klass, enabled = true, withChange = true } = {}) => {
    const dir = mkProject()
    const prev = process.cwd()
    process.chdir(dir)
    const events = []
    const log = { calls: [] }
    const changedFiles = new Set(withChange ? [path.join(dir, "lib.js")] : [])
    const noted = []
    try {
      const out = await runDocsPhase({
        agent: stub(log), config: {}, provider: { name: "x", model: "m" },
        signal: new AbortController().signal, emit: (ev) => events.push(ev),
        objective: "replace oldHelper with newHelper in lib.js", klass,
        changedFiles, noteFiles: (f) => noted.push(f),
        taskId: "task-1", runId: "run-1", cwd: dir, enabled,
      })
      return { out, events, types: events.map((e) => e.type), log, dir, changedFiles, noted }
    } finally { process.chdir(prev) }
  }

  // A. ARCHITECTURAL: a read-only drafting pass, then the writer applies
  const a = await call({ klass: "ARCHITECTURAL" })
  ok("DOCS_BRIEF was emitted", a.types.includes("DOCS_BRIEF"))
  ok("DOCS_DRAFTED was emitted", a.types.includes("DOCS_DRAFTED"), JSON.stringify(a.types))
  ok("DOCS_APPLIED was emitted", a.types.includes("DOCS_APPLIED"))
  eq("two agent calls: draft then apply", a.log.calls.length, 2)
  eq("the first was read-only", a.log.calls[0].readOnly, true)
  eq("the second was the writer", a.log.calls[1].readOnly, false)
  ok("the draft call was step-bounded", a.log.calls[0].maxSteps <= 6, String(a.log.calls[0].maxSteps))
  ok("the brief reached the writer", /You are the Documentation Writer/.test(a.log.calls[1].task))
  ok("and the draft was handed to the writer", /replaced oldHelper with newHelper/.test(a.log.calls[1].task))
  ok("the apply call says to change only the listed files", /Change ONLY the listed files/.test(a.log.calls[1].task))
  eq("one file written", a.out.result.wrote.length, 1)
  ok("the file really changed on disk", /newHelper/.test(fs.readFileSync(path.join(a.dir, "CHANGELOG.md"), "utf8")))
  ok("the write is recorded in the task state", a.noted.length === 1 && /CHANGELOG/.test(a.noted[0]), JSON.stringify(a.noted))
  ok("and in the run's changed files", [...a.changedFiles].some((f) => /CHANGELOG/.test(f)))
  ok("the note names what happened", /doc target/.test(a.out.note) && /CHANGELOG/.test(a.out.note), a.out.note)
  ok("the draft length is reported", a.out.result.draftChars > 0)

  // B. SMALL: no drafting pass (it costs a model call), but the docs still land
  const b = await call({ klass: "SMALL" })
  eq("a small task makes exactly one agent call", b.log.calls.length, 1)
  eq("and it is the writer, not a drafter", b.log.calls[0].readOnly, false)
  ok("no DOCS_DRAFTED event", !b.types.includes("DOCS_DRAFTED"))
  ok("but the docs were applied", b.types.includes("DOCS_APPLIED"))

  // C. nothing changed -> nothing to document, and no model call at all
  const c = await call({ withChange: false })
  eq("no agent call was made", c.log.calls.length, 0)
  eq("the note says so", c.out.note, "no files changed — nothing to document")
  eq("and no result is claimed", c.out.result, null)
  ok("no docs events", c.types.length === 0, JSON.stringify(c.types))

  // D. the switch off restores v92
  const d = await call({ enabled: false, klass: "ARCHITECTURAL" })
  eq("no agent call was made", d.log.calls.length, 0)
  eq("the note says the agent is off", d.out.note, "documentation deltas listed in the report (docs agent off)")
  ok("no docs events", d.types.length === 0, JSON.stringify(d.types))

  // E. an agent that fails must not break the run — it reports instead
  const dir = mkProject()
  const prev = process.cwd()
  process.chdir(dir)
  try {
    const events = []
    const out = await runDocsPhase({
      agent: async () => { throw new Error("provider exploded") },
      config: {}, provider: { name: "x", model: "m" }, emit: (ev) => events.push(ev),
      objective: "x", klass: "SMALL", changedFiles: new Set([path.join(dir, "lib.js")]),
      taskId: "t", runId: "r", cwd: dir, enabled: true,
    })
    ok("a failing docs agent does not throw", true)
    ok("and it reports the failure honestly", /documentation not written/.test(out.note), out.note)
    ok("with an event", events.some((e) => e.type === "DOCS_APPLY_FAILED"), JSON.stringify(events.map((e) => e.type)))
  } finally { process.chdir(prev) }
}

// ---------------------------------------------------------------------------
console.log("== 3b. runMeta calls the DOCUMENT phase with the switch respected ==")
{
  const meta = await import("../meta.js")
  // A run that reaches COMPLETED (the completion gate is what opens DOCUMENT).
  const stub = (log) => {
    let n = 0
    return async (o = {}) => {
      n += 1
      if (o.planOnly) return { text: "1. do it\n2. verify", toolRecords: [], commandChecks: [], toolLog: [] }
      if (/You are the Documentation Writer/.test(String(o.task ?? ""))) { log.docsCalls += 1; return { text: "draft", toolRecords: [], commandChecks: [], toolLog: [] } }
      if (n <= 2) return { text: "working", budgetHit: true, steps: 12, toolRecords: [], commandChecks: [], toolLog: [] }
      return { text: "All done, complete and verified.", toolRecords: [], commandChecks: [], toolLog: [] }
    }
  }
  const run = async (agentCfg) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93-meta-"))
    const prev = process.cwd()
    process.chdir(dir)
    const events = []
    const log = { docsCalls: 0 }
    try {
      const r = await meta.runMeta({
        config: { providers: {}, agent: { autonomous: true, modelStrategy: false, ...agentCfg }, tools: {} },
        provider: { name: "x", model: "m" }, task: "no mutation docs task",
        runAgent: stub(log), onEvent: (ev) => events.push(ev.type), signal: new AbortController().signal,
      })
      return { r, events, log }
    } finally { process.chdir(prev) }
  }

  const on = await run({})
  eq("the run completed, so DOCUMENT ran", on.r.status, "COMPLETED")
  eq("with nothing changed there is nothing to document", on.r.objective.phases.DOCUMENT.notes[0]?.text ?? on.r.objective.phases.DOCUMENT.note, "no files changed — nothing to document")
  eq("no model call was spent on docs", on.log.docsCalls, 0)
  eq("and no docs result is claimed", on.r.docs, null)

  const off = await run({ docsAgent: false })
  eq("the run still completes", off.r.status, "COMPLETED")
  const offNotes = JSON.stringify(off.r.objective.phases.DOCUMENT)
  ok("the phase records that the agent is off", /docs agent off/.test(offNotes), offNotes)
  ok("no docs events were emitted", !off.events.some((t) => String(t).startsWith("DOCS_")), JSON.stringify(off.events.filter((t) => /DOCS/.test(t))))
}

// ---------------------------------------------------------------------------
console.log("== 4. wiring and metadata ==")
{
  const { defaultConfig } = await import("../config.js")
  const meta = await import("../meta.js")
  eq("the docs agent is on by default", defaultConfig().agent.docsAgent, true)
  const metaSrc = fs.readFileSync(path.join(FORGE_DIR, "meta.js"), "utf8")
  for (const ev of ["DOCS_BRIEF", "DOCS_DRAFTED", "DOCS_DRAFT_FAILED", "DOCS_APPLIED", "DOCS_APPLY_FAILED"]) {
    ok(`meta.js emits ${ev}`, metaSrc.includes(ev))
  }
  ok("the drafting pass is read-only in the source", /readOnly: true, maxStepsOverride: 6/.test(metaSrc))
  ok("the brief uses the REAL repo file list", /listSourceFiles\(cwd, \{ exts: new Set\(\["\.md"/.test(metaSrc))
  ok("runDocsPhase is a module-level seam, not inline in runMeta", /export async function runDocsPhase/.test(metaSrc))
  eq("only LARGE and ARCHITECTURAL pay for a drafting pass", [...meta.DOCS_DRAFT_CLASSES].sort(), ["ARCHITECTURAL", "LARGE"])
  ok("runMeta calls it", /await runDocsPhase\(\{/.test(metaSrc))
  ok("there is exactly one call site", (metaSrc.match(/runDocsPhase\(/g) || []).length === 2)
  const pkg = JSON.parse(fs.readFileSync(path.join(FORGE_DIR, "package.json"), "utf8"))
  eq("the version is 93.0.0", VERSION, "93.0.0")
  eq("package.json agrees", pkg.version, "93.0.0")
}

console.log(`\n== v93 suite: ${PASS} passed, ${FAIL} failed ==`)
if (FAIL) process.exit(1)
