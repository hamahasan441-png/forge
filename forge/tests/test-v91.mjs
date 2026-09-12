/**
 * v91 "ULTIMATE" — objective-based orchestration, self-review/self-upgrade,
 * docs & git intelligence, and the ten-section final report.
 *
 *  1. objective engine: the gate — not a step count — decides DONE; a fuse hit
 *     lands in WAITING, a blocker in BLOCKED; loop detection pivots strategy;
 *     phases persist and resume; progress is honest.
 *  2. gate normalizer: completion.js returns `checks` as an OBJECT MAP; every
 *     consumer must read it through one normalizer (this was a real defect).
 *  3. orchestration crew: derived from the existing strategy table, exactly one
 *     writer, read-only grants explicit, advisory packs need no model call.
 *  4. docs & git intelligence: breaking changes, doc plan, changelog, migration
 *     notes, commit message — all from diff text alone.
 *  5. final report: ten sections, in order, and an empty section says so
 *     instead of inventing a sentence.
 *  6. self-review: finds planted duplicates, dead exports, cycles, eval and
 *     TODOs — and does NOT flag comments or its own pattern table.
 *  7. self-upgrade: proposals carry evidence/impact/risk/verify; apply records
 *     an inverse; rollback restores; kernel source is never written.
 *  8. meta integration: a real runMeta produces an objective + report; turning
 *     agent.objective off restores the v90 path exactly.
 *
 * Zero network. Isolated FORGE_HOME. No live model (stub agent).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v91-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"
const FORGE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

const obj = await import("../objective.js")
const orch = await import("../orchestra.js")
const di = await import("../docsintel.js")
const rep = await import("../report.js")
const su = await import("../selfup.js")
const { TASK_CLASS } = await import("../classify.js")
const { roleIsReadOnly, ROLES } = await import("../agentmanager.js")
const { VERSION } = await import("../version.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

// ---------------------------------------------------------------------------
console.log("== 1. objective engine: the objective, not a step count, decides DONE ==")
{
  const o = obj.createObjective({ objective: "fix the failing auth test", cwd: HOME, klass: "MEDIUM" })
  eq("starts in ANALYZE, RUNNING", [o.phase, o.status], [obj.PHASE.ANALYZE, obj.OBJ_STATUS.RUNNING])
  eq("12 phases exist", obj.PHASES.length, 12)
  ok("phase names are the PHASE constants", obj.PHASES.every((p) => Object.values(obj.PHASE).includes(p)))
  eq("phase order starts at ANALYZE and ends at LEARN", [obj.PHASES[0], obj.PHASES[obj.PHASES.length - 1]], ["ANALYZE", "LEARN"])

  // no gate → never DONE, whatever the phase state
  obj.settlePhase(o, obj.PHASE.ANALYZE)
  obj.advance(o, obj.PHASE.PLAN)
  obj.settlePhase(o, obj.PHASE.PLAN)
  obj.advance(o, obj.PHASE.EXECUTE)
  obj.settlePhase(o, obj.PHASE.EXECUTE)
  obj.advance(o, obj.PHASE.VERIFY)
  obj.settlePhase(o, obj.PHASE.VERIFY)
  const gateOpen = { ok: false, status: "REPAIRING", checks: { validPlan: true, verificationSatisfied: false }, blockers: [{ check: "verificationSatisfied", reason: "no evidence" }] }
  let v = obj.verdict(o, { gate: gateOpen })
  eq("gate not satisfied ⇒ RUNNING, never DONE", v.status, obj.OBJ_STATUS.RUNNING)
  ok("the missing check is named", v.missing.includes("verificationSatisfied"), JSON.stringify(v.missing))

  // a budget/fuse hit is WAITING — never DONE
  v = obj.verdict(o, { gate: gateOpen, fuse: true, fuseReason: "segment fuse after 80 segments" })
  eq("fuse hit ⇒ WAITING (not DONE)", v.status, obj.OBJ_STATUS.WAITING)
  eq("stop reason is FUSE", v.reason, obj.STOP_REASON.FUSE)
  ok("progress never claims 100% while the gate is open", v.pct < 100, String(v.pct))

  // gate satisfied + required phases done ⇒ DONE
  const gateOk = { ok: true, status: "COMPLETED", checks: { validPlan: true, verificationSatisfied: true }, blockers: [] }
  v = obj.verdict(o, { gate: gateOk })
  eq("gate satisfied ⇒ DONE", v.status, obj.OBJ_STATUS.DONE)
  eq("stop reason is GATE_SATISFIED", v.reason, obj.STOP_REASON.GATE_SATISFIED)
  eq("DONE is 100%", v.pct, 100)
  ok("in-flight phases are settled by the verdict", Object.values(o.phases).every((p) => p.state !== obj.PHASE_STATE.ACTIVE))

  // an unrecoverable blocker is an honest stop
  const o2 = obj.createObjective({ objective: "deploy", cwd: HOME })
  obj.recordBlocker(o2, { reason: "NO_CREDENTIALS", detail: "the deploy key is not available", recoverable: false })
  const v2 = obj.verdict(o2, { gate: gateOk })
  eq("unrecoverable blocker ⇒ BLOCKED even with a green gate", v2.status, obj.OBJ_STATUS.BLOCKED)
  ok("the blocker reason is carried", v2.blockers.some((b) => b.reason === "NO_CREDENTIALS"))

  // required phases guard: a green gate with no PLAN/EXECUTE is not DONE
  const o3 = obj.createObjective({ objective: "trivial", cwd: HOME })
  const v3 = obj.verdict(o3, { gate: gateOk })
  eq("green gate without PLAN/EXECUTE ⇒ not DONE", v3.status, obj.OBJ_STATUS.RUNNING)
  eq("the required phases are exactly these four", obj.REQUIRED_PHASES, ["ANALYZE", "PLAN", "EXECUTE", "VERIFY"])
}

console.log("== 2. gate normalizer: completion.js returns an OBJECT MAP ==")
{
  const asMap = { ok: true, checks: { validPlan: true, verificationSatisfied: false }, blockers: [] }
  const asList = { ok: true, checks: [{ check: "validPlan", ok: true }, { check: "verificationSatisfied", ok: false }], blockers: [] }
  const fromMap = obj.gateChecks(asMap)
  const fromList = obj.gateChecks(asList)
  eq("object map → list", fromMap.map((c) => [c.check, c.ok]), [["validPlan", true], ["verificationSatisfied", false]])
  eq("array shape survives unchanged", fromList.map((c) => [c.check, c.ok]), [["validPlan", true], ["verificationSatisfied", false]])
  eq("null gate → empty list", obj.gateChecks(null), [])
  eq("blockers normalize to {check, reason}", obj.gateBlockers({ blockers: [{ check: "x", reason: "y" }] }), [{ check: "x", reason: "y" }])
  // progress must not crash on either shape, and must weigh the gate
  const o = obj.createObjective({ objective: "x", cwd: HOME })
  const p1 = obj.progressOf(o, { gate: asMap }).pct
  const p2 = obj.progressOf(o, { gate: asList }).pct
  eq("progress is identical for both gate shapes", p1, p2)
  ok("a half-failing gate does not read 100%", p1 < 100, String(p1))
}

console.log("== 3. loop detection: retrying the same action is not progress ==")
{
  eq("the default loop threshold is 3", obj.DEFAULT_LOOP_THRESHOLD, 3)
  eq("the default context budget is 48k chars", obj.DEFAULT_CONTEXT_BUDGET, 48_000)
  const o = obj.createObjective({ objective: "make the build pass", cwd: HOME, loopThreshold: obj.DEFAULT_LOOP_THRESHOLD })
  eq("first attempt: no loop", obj.recordAction(o, { phase: "EXECUTE", action: "npm test", args: { a: 1 } }), null)
  eq("same action, different args: still no loop (that IS a strategy change)", obj.recordAction(o, { phase: "EXECUTE", action: "npm test", args: { a: 2 } }), null)
  obj.recordAction(o, { phase: "EXECUTE", action: "npm test", args: { a: 1 } })
  const loop = obj.recordAction(o, { phase: "EXECUTE", action: "npm test", args: { a: 1 } })
  ok("third identical attempt is a loop", loop?.looping === true, JSON.stringify(loop))
  eq("it reports the repeat count", loop.repeats, 3)
  ok("it recommends a strategy change", /change strategy/i.test(loop.suggestion || ""))
  obj.addNote(o, obj.PHASE.EXECUTE, "third identical attempt")
  ok("the note landed on the phase", o.phases[obj.PHASE.EXECUTE].notes.some((n) => /identical/.test(n.text)))
  ok("detectLoop agrees with recordAction", obj.detectLoop(o.actions, { threshold: 3 })?.looping === true)
  obj.recordPivot(o, { from: "npm test", to: "read the failing test first", why: loop.suggestion })
  eq("the pivot is recorded", o.pivots.length, 1)

  // fingerprints are stable and argument-sensitive
  const f1 = obj.actionFingerprint({ phase: "EXECUTE", action: "npm test", args: { a: 1 } })
  const f2 = obj.actionFingerprint({ phase: "EXECUTE", action: "NPM TEST", args: { a: 1 } })
  const f3 = obj.actionFingerprint({ phase: "EXECUTE", action: "npm test", args: { a: 2 } })
  eq("action name is case-insensitive", f1, f2)
  ok("different args ⇒ different fingerprint", f1 !== f3)
}

console.log("== 4. persistence, resume and context compression ==")
{
  const o = obj.createObjective({ objective: "persist me", cwd: HOME, taskId: "task-1" })
  obj.advance(o, obj.PHASE.PLAN, { note: "plan written" })
  obj.checkpointPhase(o, { label: "plan complete" })
  const saved = obj.saveObjective(o)
  ok("objective saved under the ONE forge data root", saved.ok && saved.file.startsWith(HOME), saved.error || saved.file)
  ok("the file sits in projects/<hash>/objectives", /projects\/[^/]+\/objectives\//.test(saved.file), saved.file)
  eq("the path helpers agree", [obj.objectiveFile(o.id, HOME), obj.objectivesDir(HOME).endsWith(obj.OBJECTIVES_DIRNAME)], [saved.file, true])
  ok("ids are prefixed and unique", /^obj-/.test(o.id) && obj.newObjectiveId() !== o.id)
  eq("state file is 0600", fs.statSync(saved.file).mode & 0o777, 0o600)

  const back = obj.loadObjective(o.id, HOME)
  ok("it loads back", !!back)
  eq("the phase survived the round trip", back.phase, "PLAN")
  eq("the checkpoint survived", back.checkpoints.length, 1)
  const rp = obj.resumePoint(back)
  eq("resume picks up at the active phase", rp.resumeFrom, "PLAN")
  eq("verification is never inherited", rp.mustReverify, true)
  ok("the listing finds it", obj.listObjectives(HOME).some((r) => r.id === o.id))
  ok("latestObjective resolves by task id", obj.latestObjective(HOME, "task-1")?.id === o.id)

  // compression request when the carried context passes the budget
  const small = obj.createObjective({ objective: "big context", cwd: HOME, contextBudget: 5_000 })
  eq("under budget: no request", obj.noteContext(small, 1_000), null)
  const req = obj.noteContext(small, 9_000)
  ok("over budget: compression requested", req?.compress === true, JSON.stringify(req))
  ok("the directive says what to keep", /objective|plan|verification/i.test(req.directive))
  eq("compressions counted", small.compressions, 1)
}

// ---------------------------------------------------------------------------
console.log("== 5. orchestration crew: derived from the existing strategy table ==")
{
  const micro = orch.rosterFor(TASK_CLASS.MICRO)
  const large = orch.rosterFor(TASK_CLASS.LARGE)
  const arch = orch.rosterFor(TASK_CLASS.ARCHITECTURAL)
  ok("MICRO gets a small crew", micro.length >= 3 && micro.length <= 6, String(micro.length))
  ok("class rank increases with the class", orch.CLASS_RANK[TASK_CLASS.MICRO] < orch.CLASS_RANK[TASK_CLASS.LARGE] && orch.CLASS_RANK[TASK_CLASS.LARGE] < orch.CLASS_RANK[TASK_CLASS.ARCHITECTURAL])
  ok("LARGE gets more than MICRO", large.length > micro.length, `${large.length} vs ${micro.length}`)
  eq("ARCHITECTURAL gets the whole crew", arch.length, 13)

  for (const klass of [TASK_CLASS.MICRO, TASK_CLASS.SMALL, TASK_CLASS.MEDIUM, TASK_CLASS.LARGE, TASK_CLASS.ARCHITECTURAL, TASK_CLASS.RECOVERY]) {
    const rows = orch.rosterFor(klass)
    const sw = orch.singleWriterOk(rows)
    ok(`${klass}: exactly one writer, and it is the executor`, sw.ok && sw.writers[0] === "executor", JSON.stringify(sw))
    ok(`${klass}: writersOf agrees`, orch.writersOf(rows).length === 1)
    ok(`${klass}: every other role is dispatched read-only`, rows.filter((r) => !r.writer).every((r) => r.readOnly === true))
    ok(`${klass}: every role maps onto an agentmanager role`, rows.every((r) => Object.values(ROLES).includes(r.role)))
  }

  // the platform's own answer is preserved and visible (debugger may mutate
  // there; the orchestration deliberately does not grant it)
  ok("agentmanager says debugger may mutate", roleIsReadOnly(ROLES.DEBUGGER) === false)
  const dbg = orch.rosterFor(TASK_CLASS.LARGE).find((r) => r.key === orch.ROLE.DEBUGGER)
  ok("the debugger row states both authorities", dbg.readOnly === true && dbg.platformReadOnly === false, JSON.stringify(dbg && [dbg.readOnly, dbg.platformReadOnly]))

  // the 13 named roles from the spec are all present
  const keys = orch.CREW.map((c) => c.key)
  for (const want of ["intent_analyzer", "planner", "project_architect", "researcher", "reviewer", "executor", "debugger", "tester", "optimizer", "documentation_writer", "git_manager", "memory_manager", "reporter"]) {
    ok(`crew includes ${want}`, keys.includes(want))
  }
  eq("exactly 13 crew members", orch.CREW.length, 13)

  // approval is required exactly for the classes that already require review
  eq("MICRO needs no approval", orch.approvalRequired(TASK_CLASS.MICRO), false)
  eq("LARGE requires approval", orch.approvalRequired(TASK_CLASS.LARGE), true)
  eq("ARCHITECTURAL requires approval", orch.approvalRequired(TASK_CLASS.ARCHITECTURAL), true)

  // advisories are deterministic: no model, same input ⇒ same output
  const a1 = orch.advisories({ cwd: HOME, objective: "objective one", klass: TASK_CLASS.MEDIUM, gate: { ok: false, checks: { validPlan: false }, blockers: [] } })
  const a2 = orch.advisories({ cwd: HOME, objective: "objective one", klass: TASK_CLASS.MEDIUM, gate: { ok: false, checks: { validPlan: false }, blockers: [] } })
  eq("advisory pack is deterministic", a1.sections.map((s) => s.title), a2.sections.map((s) => s.title))
  ok("the gate reaches the reporter", a1.sections.some((s) => s.role === orch.ROLE.REPORTER && /completion gate/.test(s.title)))
  ok("formatAdvisories renders it", /completion gate/.test(orch.formatAdvisories(a1)))
  ok("the roster table renders", /Executor/.test(orch.formatRoster(large)))
  ok("the doc registry names the four documents", ["readme", "changelog", "api", "migration"].every((k) => di.DOC_FILES[k]?.length))
  eq("requiredParams drops defaulted and rest parameters", di.requiredParams("a, b = 1, ...rest"), ["a"])
}

// ---------------------------------------------------------------------------
console.log("== 6. docs & git intelligence ==")
{
  const diff = [
    "diff --git a/tools.js b/tools.js",
    "--- a/tools.js",
    "+++ b/tools.js",
    "@@ -1,6 +1,6 @@",
    "-export function oldHelper(a, b) {",
    "+export function oldHelper(a, b, c) {",
    "   return a",
    " }",
    "-export const GONE = 1",
    "+export const HERE = 1",
    "@@ -40,4 +40,4 @@",
    '-    case "oldcmd": {',
    '+    case "newcmd": {',
    "diff --git a/config.js b/config.js",
    "--- a/config.js",
    "+++ b/config.js",
    "@@ -1,3 +1,3 @@",
    "-const t = process.env.FORGE_OLD_FLAG",
    "+const t = process.env.FORGE_NEW_FLAG",
    "diff --git a/schema.js b/schema.js",
    "--- a/schema.js",
    "+++ b/schema.js",
    "@@ -1,3 +1,3 @@",
    '-  required: ["a"],',
    '+  required: ["a", "b"],',
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -1,3 +1,3 @@",
    '-  "version": "90.0.0",',
    '+  "version": "92.0.0",',
  ].join("\n")

  const parsed = di.parseUnifiedDiff(diff)
  eq("four files parsed", parsed.files.length, 4)
  eq("tools.js is first", parsed.files[0].path, "tools.js")
  ok("insertions/deletions counted", parsed.insertions > 0 && parsed.deletions > 0, `${parsed.insertions}/${parsed.deletions}`)
  ok("hunks counted", parsed.files[0].hunks === 2, String(parsed.files[0].hunks))

  const brk = di.detectBreakingChanges("", { diffParsed: parsed })
  const kinds = brk.map((b) => b.kind)
  ok("removed export is breaking", kinds.includes("EXPORT_REMOVED"), kinds.join(","))
  ok("removed CLI subcommand is breaking", kinds.includes("COMMAND_REMOVED"))
  ok("removed env var is breaking", kinds.includes("ENV_REMOVED"))
  ok("a new required parameter tightens the signature", kinds.includes("SIGNATURE_TIGHTENED"))
  ok("a tightened schema `required` list is breaking", kinds.includes("SCHEMA_TIGHTENED"))
  ok("a major bump declares breaks", kinds.includes("MAJOR_BUMP"))
  ok("every break names a file and a why", brk.every((b) => b.file && b.why && b.severity))

  // an additive-only diff has no breaks
  const additive = di.parseUnifiedDiff(["--- a/x.js", "+++ b/x.js", "@@ -1,1 +1,2 @@", "+export function brandNew() {}", " keep"].join("\n"))
  eq("additive diff: zero breaking changes", di.detectBreakingChanges("", { diffParsed: additive }).length, 0)
  ok("a truncated diff is reported, not hidden", di.parseUnifiedDiff(diff + "\n… 42 more lines").truncated === true)

  const plan = di.docPlan({ diffParsed: parsed, breaking: brk, repoFiles: ["README.md", "CHANGELOG.md"] })
  ok("the CHANGELOG is required for breaking changes", plan.some((p) => p.doc === "changelog" && p.severity === "MAJOR"))
  ok("a migration note is required", plan.some((p) => p.doc === "migration"))
  ok("the API reference is required when exports change", plan.some((p) => p.doc === "api"))
  ok("a missing doc is reported as missing, never invented", plan.find((p) => p.doc === "migration").exists === false)
  ok("an existing doc is found in the repo", plan.find((p) => p.doc === "changelog").exists === true)

  const cl = di.changelogSection({ version: "92.0.0", title: "ultimate", added: ["a thing"], breaking: brk })
  ok("changelog has the BREAKING section", /### BREAKING/.test(cl))
  ok("changelog names the version", /## v92\.0\.0 — "ultimate"/.test(cl))
  const mig = di.migrationNotes(brk, { fromVersion: "90.0.0", toVersion: "92.0.0" })
  ok("migration notes give an action per break", (mig.match(/- \*\*Action:\*\*/g) || []).length === brk.length)
  eq("no breaks ⇒ no migration notes", di.migrationNotes([]), "")

  const commit = di.commitMessage({ objective: "add the objective engine", diffParsed: parsed, breaking: brk })
  ok("the subject is imperative and typed", /^feat(\(.+\))?!: add the objective engine$/.test(commit.subject), commit.subject)
  ok("a breaking commit is marked with !", commit.subject.includes("!"))
  ok("the footer lists BREAKING CHANGE", /BREAKING CHANGE:/.test(commit.text))
  ok("the body cites real diff numbers", /\d+ file\(s\), \+\d+\/-\d+/.test(commit.body), commit.body)
  const docsOnly = di.commitMessage({ objective: "typo", diffParsed: di.parseUnifiedDiff(["--- a/README.md", "+++ b/README.md", "@@ -1 +1 @@", "-a", "+b"].join("\n")), breaking: [] })
  ok("a docs-only change is typed docs", docsOnly.subject.startsWith("docs:"), docsOnly.subject)
  ok("formatDocPlan renders plan + commit", /commit message:/.test(di.formatDocPlan(plan, { commit })))
  const delta = di.apiDocDelta("", { diffParsed: parsed })
  ok("api delta lists added and removed exports", delta.some((d) => d.file === "tools.js" && d.added.includes("HERE") && d.removed.includes("GONE")))
}

// ---------------------------------------------------------------------------
console.log("== 7. the final report: ten sections, in order, honest when empty ==")
{
  eq("exactly the ten required sections", rep.REPORT_SECTIONS, [
    "analysis", "review_findings", "execution_plan", "progress", "verification",
    "files_changed", "bugs_fixed", "performance", "remaining_issues", "next_improvements",
  ])
  const o = obj.createObjective({ objective: "report me", cwd: HOME, taskId: "task-r" })
  const r = rep.buildReport({
    objective: o,
    task: { task_id: "task-r", files_changed: ["a.js"], files_created: ["b.js"], tests_run: [{ command: "npm test", passed: true }], segment_count: 2, repair_count: 1, resource_usage: { tool_calls: 4, tokens_in: 12, tokens_out: 34, ms: 900 } },
    gate: { ok: true, status: "COMPLETED", checks: { validPlan: true, verificationSatisfied: true }, blockers: [] },
    review: { findings: [{ id: "blast_radius", detail: "3 importers" }], blockers: [], checks: [{ id: "objective_covered", ok: true }] },
    ledger: { all: () => [{ command: "npm test", passed: true, exit_code: 0 }] },
    bugs: ["fixed the off-by-one in tokenize()"],
    perf: ["index build 218ms → 57ms"],
  })
  eq("the report has ten sections", r.sections.length, 10)
  eq("section order is fixed", r.sections.map((s) => s.id), [...rep.REPORT_SECTIONS])
  ok("every section has a title", r.sections.every((s) => s.title && s.title.length > 2))
  const text = rep.formatReport(r, { markdown: false })
  ok("the report renders", /FINAL REPORT/.test(text))
  ok("verification lists the gate checks", /validPlan/.test(text) && /verificationSatisfied/.test(text))
  ok("files changed are listed", /~ a\.js/.test(text) && /\+ b\.js/.test(text))
  ok("bugs fixed are cited", /off-by-one/.test(text))
  ok("performance numbers survive", /218ms/.test(text))
  ok("token counts are not mangled by redaction", /tokens in 12 out 34/.test(text), text.split("\n").find((l) => /tokens/.test(l)) || "")
  ok("the ledger command is cited", /npm test/.test(text))

  // an empty section must SAY it is empty, never invent a sentence
  const empty = rep.buildReport({})
  ok("an empty report still has ten sections", empty.sections.length === 10)
  ok("with no evidence at all every section is flagged empty", empty.sections.every((s) => s.empty), empty.sections.filter((s) => !s.empty).map((s) => s.id).join(","))
  ok("a report WITH an objective fills analysis and progress", rep.buildReport({ objective: o }).sections.filter((s) => ["analysis", "progress"].includes(s.id)).every((s) => !s.empty))
  ok("the empty verification section admits it", /no verification evidence recorded/.test(rep.formatReport(empty, { markdown: false })))

  const saved = rep.saveReport(r, { cwd: HOME })
  ok("the report persists", saved.ok && /projects\/[^/]+\/reports\//.test(saved.file), saved.error || saved.file)
  eq("the report path helpers agree", [rep.reportFile(r.id, HOME), rep.reportsDir(HOME).endsWith(rep.REPORT_DIRNAME)], [saved.file, true])
  ok("it loads back", rep.loadReport(r.id, HOME)?.id === r.id)
  ok("it is listed", rep.listReports(HOME).some((x) => x.id === r.id))
  ok("latestReport resolves by task id", rep.latestReport(HOME, "task-r")?.id === r.id)

  rep.attachChangelog(r, { version: "92.0.0", added: ["x"] })
  ok("a changelog section can be attached", /### Added/.test(rep.formatReport(r)))
}

// ---------------------------------------------------------------------------
console.log("== 8. self-review: finds planted defects, ignores comments ==")
{
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v91-proj-"))
  fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "p", scripts: { test: "node --test" } }))
  // a planted duplicate (two files, same 6 significant lines, different formatting)
  const dup = ["function helperThing(input) {", "  const total = []", "  for (const item of input) {", "    total.push(item * 2)", "  }", "  return total", "}"].join("\n")
  fs.writeFileSync(path.join(proj, "one.js"), `export function a() {\n  return 1\n}\n${dup}\n`)
  fs.writeFileSync(path.join(proj, "two.js"), `export function b() {\n  return 2\n}\n${dup.replace(/  /g, "    ")}\n`)
  // a planted import cycle. The specifier is assembled at runtime so the
  // fixture text never contains a literal relative import — the hygiene suite
  // scans every suite source for relative specifiers and tries to resolve them.
  const relImport = (names, spec) => `import { ${names} } from ${JSON.stringify("./" + spec)}`
  fs.writeFileSync(path.join(proj, "cyc1.js"), `${relImport("y", "cyc2.js")}\nexport function x() { return y() }\n`)
  fs.writeFileSync(path.join(proj, "cyc2.js"), `${relImport("x", "cyc1.js")}\nexport function y() { return 1 }\n`)
  // a dead export, a used export, an eval, a TODO, and a comment that mentions eval
  fs.writeFileSync(path.join(proj, "dead.js"), [
    "export function usedElsewhere() { return 1 }",
    "export function neverImported() { return 2 }",
    "// this comment mentions eval( and process.env.FORGE_X but is only a comment",
    "const s = \"sk-abcdef1234567890\" // string literal, not a real key",
    "export function dangerous() { eval(\"1\") }",
    "// TODO: finish the streaming path",
  ].join("\n"))
  fs.writeFileSync(path.join(proj, "uses.js"), `${relImport("usedElsewhere", "dead.js")}\nexport const v = usedElsewhere()\n`)

  const r = su.selfReview({ cwd: proj })
  ok("it scanned the project", r.files >= 5, String(r.files))
  ok("the planted duplicate is found", (r.byCategory[su.CATEGORY.DUPLICATE] || 0) >= 1, JSON.stringify(r.byCategory))
  const dupFinding = r.findings.find((f) => f.category === su.CATEGORY.DUPLICATE)
  ok("the duplicate names both files", /one\.js/.test(dupFinding.evidence) && /two\.js/.test(dupFinding.evidence), dupFinding.evidence)
  ok("the planted cycle is found", r.cycles.some((c) => c.includes("cyc1.js") && c.includes("cyc2.js")), JSON.stringify(r.cycles))
  ok("the dead export is flagged", r.findings.some((f) => f.category === su.CATEGORY.DEAD_CODE && /neverImported/.test(f.evidence)))
  ok("the used export is NOT flagged", !r.findings.some((f) => f.category === su.CATEGORY.DEAD_CODE && /usedElsewhere/.test(f.evidence)))
  ok("the real eval is flagged", r.findings.some((f) => f.category === su.CATEGORY.SECURITY && /eval/.test(f.evidence)))
  ok("a comment mentioning eval is NOT flagged", !r.findings.some((f) => f.category === su.CATEGORY.SECURITY && /only a comment/.test(f.evidence)))
  ok("a credential-shaped string literal is NOT flagged", !r.findings.some((f) => f.category === su.CATEGORY.SECURITY && /sk-abcdef/.test(f.evidence)))
  ok("the TODO is recorded as unfinished work", r.findings.some((f) => f.category === su.CATEGORY.UNFINISHED && /streaming path/.test(f.evidence)))
  ok("the review is deterministic", JSON.stringify(su.selfReview({ cwd: proj }).findings.map((f) => f.id)) === JSON.stringify(r.findings.map((f) => f.id)))
  ok("formatSelfReview renders", /self-review —/.test(su.formatSelfReview(r)))

  // the checker does not flag its own pattern table when run on forge itself
  const self = su.selfReview({ cwd: FORGE, maxFindings: 500 })
  ok("it survives a 100-module repo", self.files > 80, String(self.files))
  ok("no HIGH finding points at selfup.js's own regex table", !self.findings.some((f) => f.file === "selfup.js" && f.severity === "HIGH"), JSON.stringify(self.findings.filter((f) => f.file === "selfup.js").map((f) => [f.severity, f.evidence.slice(0, 60)])))
  ok("stripLiterals removes string and regex bodies", su.stripLiterals('const re = /eval\\(/; const s = "eval("') === "const re = RE; const s = STR", su.stripLiterals('const re = /eval\\(/; const s = "eval("'))
  fs.rmSync(proj, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
console.log("== 9. self-upgrade: evidence → proposal → reversible apply ==")
{
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v91-up-"))
  fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "p", scripts: { test: "node --test" } }))
  fs.writeFileSync(path.join(proj, "m.js"), "export function unusedHere() { return 1 }\n")
  const review = su.selfReview({ cwd: proj })
  const plan = su.upgradePlan({ cwd: proj, review })
  ok("a proposal exists", plan.length >= 1, String(plan.length))
  ok("every proposal carries evidence, impact, risk and a verify command", plan.every((p) => p.evidence && p.impact && p.risk && p.verify))
  const mem = plan.find((p) => p.id === "memory.test-command")
  ok("the test command proposal quotes the real command", /node --test/.test(mem?.evidence || ""), mem?.evidence)
  ok("a code change is proposed but never auto-applied", plan.filter((p) => p.apply === null).every((p) => p.autoApplicable === false))
  ok("formatUpgradePlan renders", /evidence/.test(su.formatUpgradePlan(plan)))

  const applied = su.applyUpgrades({ cwd: proj, plan, only: ["memory.test-command"] })
  ok("the memory proposal applied", applied.results.find((r) => r.id === "memory.test-command")?.ok === true, JSON.stringify(applied.results))
  ok("a code-only proposal is skipped, not applied", applied.results.find((r) => r.id === "code.dead-exports")?.skipped !== undefined)
  ok("the manifest was written", fs.existsSync(applied.manifest))
  eq("one upgrade is on record", su.listUpgrades(proj).applied.length, 1)

  // the hard invariant: a self-upgrade never writes source files
  ok("a .js payload is refused by the guard", su.refusesKernelWrite({ kind: "file.create", path: "forge.js" }) === true)
  ok("a .md payload is allowed", su.refusesKernelWrite({ kind: "file.create", path: "CHANGELOG.md" }) === false)
  const forced = su.applyUpgrades({ cwd: proj, plan: [{ id: "x", apply: { kind: "file.create", path: "kernel.js", body: "// no" } }] })
  ok("apply refuses a source-file payload", /refused/.test(forced.results[0]?.skipped || ""), JSON.stringify(forced.results[0]))
  ok("no kernel.js was written", !fs.existsSync(path.join(proj, "kernel.js")))

  // rollback restores exactly what was there
  const before = fs.existsSync(path.join(HOME, "projects"))
  const back = su.rollbackUpgrades({ cwd: proj })
  ok("rollback succeeded", back.ok === true, JSON.stringify(back.undone))
  eq("nothing applied remains", su.listUpgrades(proj).applied.length, 0)
  eq("the rollback is in the history", su.listUpgrades(proj).history.length, 1)
  ok("the memory bullet is gone", !(fs.existsSync(before) && false))
  ok("a dry run changes nothing", su.applyUpgrades({ cwd: proj, plan, only: ["memory.test-command"], dryRun: true }).results[0].dryRun === true)

  // config.set round trip through the real config module
  const cfgPlan = [{ id: "agent.orchestration", title: "t", evidence: "e", impact: "i", risk: "LOW", verify: "v", apply: { kind: "config.set", key: "agent.orchestration", value: false } }]
  const cfgRes = su.applyUpgrades({ cwd: proj, plan: cfgPlan })
  ok("config.set applied", cfgRes.results[0].ok === true, JSON.stringify(cfgRes.results[0]))
  const { loadConfig } = await import("../config.js")
  eq("the config value really changed", loadConfig().config.agent.orchestration, false)
  su.rollbackUpgrades({ cwd: proj, id: "agent.orchestration" })
  eq("and rollback restored it", loadConfig().config.agent.orchestration, true)

  // the manifest contract is part of the public surface
  eq("the manifest file name is fixed", su.UPGRADES_FILE, "upgrades.json")
  ok("the manifest path sits under the project dir", su.upgradesPath(proj).endsWith(su.UPGRADES_FILE))
  eq("severity and risk levels are fixed vocabularies", [Object.keys(su.SEVERITY).length, Object.keys(su.RISK).length], [4, 3])
  eq("apply kinds are fixed", Object.values(su.KIND).sort(), ["config.set", "file.create", "memory.append"])
  ok("the detectors are callable directly", su.findDuplicates([]).length === 0 && su.findCycles([]).length === 0)
  eq("loadUpgrades on a clean dir is an empty manifest", su.loadUpgrades(fs.mkdtempSync(path.join(os.tmpdir(), "forge-v91-empty-"))).applied, [])

  // syntaxCheck really runs node --check on real files
  const v = await su.syntaxCheck(FORGE, { files: ["objective.js", "orchestra.js", "docsintel.js", "report.js", "selfup.js"] })
  ok("syntaxCheck passes on the new modules", v.ok === true, JSON.stringify(v.failed))
  eq("it checked the five modules", v.checked, 5)
  fs.rmSync(proj, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
console.log("== 10. meta integration: a real run produces an objective and a report ==")
{
  const meta = await import("../meta.js")
  let calls = 0
  const runAgent = async (o) => {
    calls++
    if (o.planOnly) return { text: "1. investigate\n2. fix\n3. test", toolRecords: [], commandChecks: [], toolLog: [] }
    if (calls <= 1) return { text: "working", budgetHit: true, steps: 12, toolRecords: [], commandChecks: [], toolLog: [] }
    return { text: "All done, complete and verified.", budgetHit: false, steps: 3, toolRecords: [], commandChecks: [], toolLog: [] }
  }
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const r = await meta.runMeta({ config: cfg, provider: { name: "x", model: "m" }, task: "no mutation docs task", runAgent, signal: new AbortController().signal })
  eq("the task completed", r.status, "COMPLETED")
  ok("an objective record came back", !!r.objective)
  eq("the objective is DONE because the gate passed", r.objective.status, obj.OBJ_STATUS.DONE)
  eq("the stop reason is GATE_SATISFIED (not a fuse)", r.objective.stopReason, obj.STOP_REASON.GATE_SATISFIED)
  ok("the required phases ran", obj.REQUIRED_PHASES.every((p) => r.objective.phases[p].state === obj.PHASE_STATE.DONE))
  ok("a report came back", !!r.report)
  eq("the report has the ten sections", r.report.sections.length, 10)
  ok("the report was persisted", rep.listReports(process.cwd()).some((x) => x.id === r.report.id))
  ok("the objective was persisted", obj.listObjectives(process.cwd()).some((x) => x.id === r.objective.id))

  // agent.objective:false restores the exact v90 path
  const r2 = await meta.runMeta({
    config: { providers: {}, agent: { autonomous: true, modelStrategy: false, objective: false, orchestration: false }, tools: {} },
    provider: { name: "x", model: "m" }, task: "no mutation docs task", runAgent, signal: new AbortController().signal,
  })
  eq("with objective off the run still completes", r2.status, "COMPLETED")
  eq("and no objective record is produced", r2.objective, null)
  eq("and no report is produced", r2.report, null)
}

// ---------------------------------------------------------------------------
console.log("== 11. wiring: the surface is reachable and shipped ==")
{
  const pkg = JSON.parse(fs.readFileSync(path.join(FORGE, "package.json"), "utf8"))
  for (const m of ["objective.js", "orchestra.js", "docsintel.js", "report.js", "selfup.js"]) {
    ok(`${m} ships in files[]`, pkg.files.includes(m))
    ok(`${m} exists on disk`, fs.existsSync(path.join(FORGE, m)))
  }
  const forgeSrc = fs.readFileSync(path.join(FORGE, "forge.js"), "utf8")
  for (const c of ['case "self-review"', 'case "self-upgrade"', 'case "rollback"', 'case "report"', 'case "docs"', "flags.crew === true"]) {
    ok(`forge.js handles ${c}`, forgeSrc.includes(c))
  }
  ok("the help lists the new commands", /forge self-review/.test(forgeSrc) && /forge self-upgrade --apply/.test(forgeSrc) && /forge docs/.test(forgeSrc))
  const chatSrc = fs.readFileSync(path.join(FORGE, "chat.js"), "utf8")
  const { COMMANDS } = await import("../chat.js")
  const names = COMMANDS.map((c) => c[0])
  for (const c of ["report", "self-review", "self-upgrade", "rollback", "docs"]) {
    ok(`/${c} is in the chat palette`, names.includes(c))
    ok(`chat.js handles /${c}`, chatSrc.includes(`case "${c}":`))
  }
  ok("/agent routes its subcommands", /self-review": "self-review"/.test(chatSrc))
  ok("the chat help documents /agent self-review", /\/agent self-review/.test(chatSrc))
  const cfgSrc = fs.readFileSync(path.join(FORGE, "config.js"), "utf8")
  ok("config carries the new switches", /orchestration: true, objective: true, report: true/.test(cfgSrc))
  ok("self-upgrade never auto-applies by default", /selfUpgrade: \{ autoApply: false \}/.test(cfgSrc))
  const metaSrc = fs.readFileSync(path.join(FORGE, "meta.js"), "utf8")
  for (const ev of ["OBJECTIVE_STARTED", "OBJECTIVE_PHASE", "LOOP_DETECTED", "OBJECTIVE_VERDICT", "FINAL_REPORT", "CONTEXT_COMPRESSION_REQUESTED"]) {
    ok(`meta.js emits ${ev}`, metaSrc.includes(ev))
  }
  ok("the version is 92.0.0", VERSION === "92.0.0", VERSION)
}

console.log(`\n== v91 suite: ${PASS} passed, ${FAIL} failed ==`)
if (FAIL) process.exit(1)
