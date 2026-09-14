#!/usr/bin/env node
/**
 * forge — v94 knowwise: the project gains a living knowledge floor.
 *
 * 1. Auto-KG bootstrap (knowgraph.js) — the first task in a project writes a
 *    deterministic FLOOR .ua/knowledge-graph.json from the world-model
 *    extractors (no LLM, no network, no understand-anything npm deps). The
 *    existing readers (engmemory retrieval bridge, kg_query's shared parser)
 *    light up with zero further wiring. A real understand-anything graph is
 *    NEVER touched; drift (source inventory fingerprint) triggers a rebuild;
 *    corrupt forge graphs are rebuilt; missing dirs fail honestly.
 * 2. Blast-radius prediction (impact.predictBlastRadius + toolintel) — every
 *    successful file mutation carries one bounded advisory line + a record
 *    field + a TOOL_BLAST event. Off with tools.intelligence:false (raw
 *    pre-v20.5 result string preserved verbatim — pinned) or
 *    FORGE_BLAST_RADIUS=0. The note never contains "created"/"deleted" and
 *    never ends in the [exit code: N] shape (journal/UI classification pins).
 * 3. Termux full-power shell resolution (sysshell.js) — one resolver, every
 *    spawn site: FORGE_SHELL > /bin/sh > $PREFIX/bin/sh > $SHELL > "sh".
 *    Default unchanged on normal Linux (test-v27's /bin/sh pin holds).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-knowwise-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_DATA_DIR
const ENV_SAVE = { ...process.env }

const { ensureKnowledgeGraph } = await import("../knowgraph.js")
const { knowledgeGraphFacts } = await import("../engmemory.js")
const { createEngMemory } = await import("../engmemory.js")
const { predictBlastRadius } = await import("../impact.js")
const { resolveShell, pickShell } = await import("../sysshell.js")
const { wrapBash } = await import("../sandbox.js")
const { makeToolContext } = await import("../tools.js")
const { createToolIntel } = await import("../toolintel.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

function project() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-knowwise-p-"))
  fs.writeFileSync(path.join(tmp, "lib.js"), "export function helper() { return 1 }\n")
  fs.writeFileSync(path.join(tmp, "app.js"), "import { helper } from \"./lib.js\"\nexport const a = helper()\n")
  fs.writeFileSync(path.join(tmp, "app.test.js"), "import { a } from \"./app.js\"\nconsole.log(a)\n")
  return tmp
}

console.log("== knowgraph: floor graph build, schema, readers ==")
const P1 = project()
{
  const r1 = ensureKnowledgeGraph({ cwd: P1 })
  eq("first build succeeds", r1.ok, true)
  eq("first build reports built", r1.built, true)
  const doc = JSON.parse(fs.readFileSync(r1.file, "utf8"))
  eq("schema version 1.0.0", doc.version, "1.0.0")
  ok("project identity", typeof doc.project?.name === "string" && !!doc.project?.analyzedAt)
  ok("forge generator marker present", doc.project?.generator === "forge-knowwise/1" && typeof doc.project?.knowwise?.fp === "string")
  ok("nodes use the file:<path> id scheme", doc.nodes.length >= 2 && doc.nodes.every((n) => n.id.startsWith("file:") && n.filePath && n.summary))
  ok("imports resolved to in-project targets", doc.edges.some((e) => e.type === "imports" && e.source === "file:app.js" && e.target === "file:lib.js"), JSON.stringify(doc.edges))
  ok("layers/tour are honest empty arrays", Array.isArray(doc.layers) && doc.layers.length === 0 && Array.isArray(doc.tour) && doc.tour.length === 0)
  ok("no self-inclusion (.ua never graphed)", !doc.nodes.some((n) => String(n.filePath).startsWith(".ua")))
  ok("languages census present", Array.isArray(doc.project.languages) && doc.project.languages.includes("javascript"))
  // readers light up with ZERO further wiring
  const facts = knowledgeGraphFacts(P1)
  eq("kg_query parser reads the floor graph", facts.ok, true)
  ok("overview built", Array.isArray(facts.overview) && facts.overview.length > 0)
  const mem = createEngMemory({ cwd: P1, taskId: "t-kw" })
  const hits = mem.retrieve({ query: "helper module app" })
  ok("retrieval bridge surfaces the graph (keyword-gated, provenance kept)", hits.some((h) => h.source === "knowledge-graph" && h.confidence === 0.55 && h.status === "memory"), JSON.stringify(hits.slice(0, 2)))
  const miss = mem.retrieve({ query: "completely unrelated quantum bananas" })
  ok("unrelated queries pay nothing", !miss.some((h) => h.source === "knowledge-graph"))
}

console.log("== knowgraph: freshness, drift, preservation, honesty ==")
{
  const r2 = ensureKnowledgeGraph({ cwd: P1 })
  eq("second call does NOT rebuild", r2.built, false)
  ok("fresh reason is explicit", /fresh/.test(r2.reason ?? ""))
  await new Promise((r) => setTimeout(r, 30))
  fs.writeFileSync(path.join(P1, "lib.js"), "export function helper() { return 42 }\n")
  const r3 = ensureKnowledgeGraph({ cwd: P1 })
  eq("source drift triggers a rebuild", r3.built, true)
  const r4 = ensureKnowledgeGraph({ cwd: P1 })
  eq("fresh again after rebuild", r4.built, false)

  // a REAL understand-anything graph is never touched (byte-identical after)
  const P2 = project()
  const dir2 = path.join(P2, ".ua")
  fs.mkdirSync(dir2, { recursive: true })
  const external = { version: "1.0.0", project: { name: "authored", languages: ["python"], frameworks: ["fastapi"], description: "hand-authored", analyzedAt: new Date().toISOString(), gitCommitHash: "abc" }, nodes: [{ id: "file:main.py", type: "module", name: "main", summary: "entrypoint", tags: ["entry"] }], edges: [], layers: [{ id: "layer:core", name: "Core", description: "d", nodeIds: ["file:main.py"] }], tour: [{ order: 1, title: "Start", description: "d", nodeIds: ["file:main.py"] }] }
  fs.writeFileSync(path.join(dir2, "knowledge-graph.json"), JSON.stringify(external))
  const before = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir2, "knowledge-graph.json"))).digest("hex")
  const r5 = ensureKnowledgeGraph({ cwd: P2 })
  eq("external graph: no rebuild", r5.built, false)
  ok("external graph: explicit reason", /external/.test(r5.reason ?? ""))
  const after = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir2, "knowledge-graph.json"))).digest("hex")
  eq("external graph: byte-identical after ensure", after, before)

  // corrupt forge-era file → rebuilt (an improvement, never preserved)
  const P3 = project()
  ensureKnowledgeGraph({ cwd: P3 })
  fs.writeFileSync(path.join(P3, ".ua", "knowledge-graph.json"), "{corrupt")
  const r6 = ensureKnowledgeGraph({ cwd: P3 })
  eq("corrupt floor graph rebuilt", r6.built, true)
  ok("rebuilt file parses", !!JSON.parse(fs.readFileSync(r6.file, "utf8")))

  // honesty: missing dir, bounded cap
  const r7 = ensureKnowledgeGraph({ cwd: path.join(P3, "definitely-not-here") })
  eq("missing project dir → honest ok:false", `${r7.ok}:${r7.built}`, "false:false")
  const P4 = project()
  const r8 = ensureKnowledgeGraph({ cwd: P4, maxFiles: 1 })
  eq("maxFiles cap honored", r8.files, 1)
  eq("bounded build reports truncated honestly", r8.truncated, true)
}

console.log("== knowwise: blast-radius prediction (engine) ==")
{
  const P5 = project()
  const b = predictBlastRadius({ cwd: P5, files: ["lib.js"] })
  ok("hub file: radius includes importers", b.radius >= 2 && (b.importers ?? []).length >= 1, JSON.stringify({ radius: b.radius, importers: b.importers }))
  ok("testing scope ladder present", Array.isArray(b.scope) && b.scope.length > 0)
  const leaf = predictBlastRadius({ cwd: P5, files: ["lib.js"], maxFiles: 1 })
  ok("never throws with tiny cap", typeof leaf.radius === "number")
  const empty = predictBlastRadius({ cwd: P5, files: [] })
  eq("no files → empty blast", empty.radius, 0)
}

console.log("== knowwise: blast wiring in the tool-intel pipeline ==")
{
  const P6 = project()
  const tools = makeToolContext({ cwd: P6, root: P6, timeoutSec: 10, maxToolOutput: 8000, memoryPath: path.join(P6, "memory.md"), todoPath: path.join(P6, "todo.json") })
  const mk = () => { const events = []; const intel = createToolIntel({ exec: tools.exec, ctx: { cwd: P6, root: P6 }, config: {}, onEvent: (e) => events.push(e), runId: "run-kw", taskId: "task-kw", task: "knowwise test" }); return { events, intel } }
  const { intel, events } = mk()
  const res = await intel.runCall({ name: "edit_file", args: { path: "lib.js", old: "return 1", new: "return 2" } }, { step: 1 })
  ok("result still OK-first", String(res.result).startsWith("OK"))
  ok("blast note appended", String(res.result).includes("[forge] blast: radius"), String(res.result))
  ok("note names the importer", /app\.js/.test(String(res.result)))
  ok("note NEVER contains journal-classified words", !/created|deleted/i.test(String(res.result).split("\n").slice(1).join("\n")))
  ok("note does not fake an exit-code tail", !/\[exit code: \d+\]\s*$/.test(String(res.result)))
  const rec = intel.records().find((r) => r.tool === "edit_file")
  ok("record.blast additive field", rec?.blast && rec.blast.radius >= 2 && rec.blast.importers.includes("app.js"), JSON.stringify(rec?.blast))
  ok("TOOL_BLAST event emitted", events.some((e) => e.type === "TOOL_BLAST" && e.radius >= 2 && e.tool === "edit_file"))

  // opt-out env
  process.env.FORGE_BLAST_RADIUS = "0"
  try {
    const { intel: intel2, events: events2 } = mk()
    const res2 = await intel2.runCall({ name: "edit_file", args: { path: "lib.js", old: "return 2", new: "return 3" } }, { step: 2 })
    ok("FORGE_BLAST_RADIUS=0 → no note", !String(res2.result).includes("[forge] blast:"), String(res2.result))
    ok("FORGE_BLAST_RADIUS=0 → no event", !events2.some((e) => e.type === "TOOL_BLAST"))
    // intelligence off → the EXACT raw pre-v20.5 string (pin parity with test-toolintel)
    const tools3 = makeToolContext({ cwd: P6, root: P6, timeoutSec: 10, maxToolOutput: 8000, memoryPath: path.join(P6, "memory.md"), todoPath: path.join(P6, "todo.json") })
    const events3 = []
    const intel3 = createToolIntel({ exec: tools3.exec, ctx: { cwd: P6, root: P6 }, config: { tools: { intelligence: false } }, onEvent: (e) => events3.push(e), runId: "run-kw", taskId: "task-kw", task: "knowwise test" })
    const res3 = await intel3.runCall({ name: "edit_file", args: { path: "lib.js", old: "return 3", new: "return 4" } }, { step: 3 })
    eq("intelligence:false → exact raw result (no blast line ever)", res3.result, `OK edited ${path.join(P6, "lib.js")}`)
  } finally {
    process.env.FORGE_BLAST_RADIUS = ENV_SAVE.FORGE_BLAST_RADIUS
  }
}

console.log("== knowwise: behavioral bootstrap through the real meta loop ==")
{
  const WORK = project()
  const prevCwd = process.cwd()
  process.chdir(WORK)
  try {
    const meta = await import("../meta.js")
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
    const kgFile = path.join(WORK, ".ua", "knowledge-graph.json")
    let exists = fs.existsSync(kgFile)
    for (let i = 0; i < 40 && !exists; i++) { await new Promise((r) => setTimeout(r, 50)); exists = fs.existsSync(kgFile) }
    ok(".ua/knowledge-graph.json written by the run", exists)
    ok("KG_BOOTSTRAPPED event emitted", events.some((e) => e.type === "KG_BOOTSTRAPPED" && e.files >= 2), JSON.stringify(events.filter((e) => e.type === "KG_BOOTSTRAPPED")))
    ok("retrieval sees the project graph in the SAME run", knowledgeGraphFacts(WORK).ok === true)
    // source wiring pins (v93l style)
    const metaSrc = fs.readFileSync(new URL("../meta.js", import.meta.url), "utf8")
    ok("meta wiring: ensureKnowledgeGraph at cwd", /ensureKnowledgeGraph\(\{ cwd: process\.cwd\(\) \}\)/.test(metaSrc))
    ok("meta wiring: deferred + unref'd (planning never delayed)", /kgTimer\.unref/.test(metaSrc))
  } finally {
    process.chdir(prevCwd)
  }
}

console.log("== knowwise: Termux full-power shell resolution ==")
{
  process.env.FORGE_SHELL = ""
  process.env.PREFIX = ""
  const prevShell = process.env.SHELL
  try {
    eq("default on Linux is /bin/sh (test-v27 pin parity)", resolveShell(), "/bin/sh")
    process.env.FORGE_SHELL = "/custom/sh-overridden"
    eq("FORGE_SHELL wins verbatim", resolveShell(), "/custom/sh-overridden")
    process.env.FORGE_SHELL = ""
    // the Termux/SHELL/PATH branches are only reachable when /bin/sh is absent
    // (exactly Termux) — exercised through the pure selector with an injected
    // exists() so the test does not depend on the host filesystem
    const noBinSh = (p) => p === "/data/data/com.termux/files/usr/bin/bash" // only the SHELL candidate "exists"
    const fakePrefix = "/data/data/com.termux/files/usr"
    eq("Termux: PREFIX/bin/sh fallback", pickShell({ PREFIX: fakePrefix }, (p) => p === path.join(fakePrefix, "bin", "sh")), path.join(fakePrefix, "bin", "sh"))
    eq("Termux without PREFIX sh → SHELL", pickShell({ PREFIX: fakePrefix, SHELL: "/data/data/com.termux/files/usr/bin/bash" }, noBinSh), "/data/data/com.termux/files/usr/bin/bash")
    eq("nothing anywhere → PATH sh", pickShell({}, () => false), "sh")
    eq("priority: FORGE_SHELL beats a present /bin/sh", pickShell({ FORGE_SHELL: "/custom/sh" }, () => true), "/custom/sh")
    eq("priority: /bin/sh beats PREFIX", pickShell({ PREFIX: fakePrefix }, () => true), "/bin/sh")
    // wrapBash (the model bash path) uses the resolver
    process.env.FORGE_SHELL = "/custom/sh-overridden"
    const w = wrapBash("echo hi", { cwd: os.tmpdir() })
    eq("wrapBash honors the resolved shell", w.file, "/custom/sh-overridden")
    eq("wrapBash stays unsandboxed by default", w.sandboxed, false)
  } finally {
    process.env.FORGE_SHELL = ENV_SAVE.FORGE_SHELL
    process.env.PREFIX = ENV_SAVE.PREFIX
    process.env.SHELL = prevShell
  }
  // additive opt-in flag for private skill mirrors (source pin; no network here)
  const skilldlSrc = fs.readFileSync(new URL("../skilldl.js", import.meta.url), "utf8")
  ok("skilldl: FORGE_SKILL_ALLOW_PRIVATE opt-in wired", /FORGE_SKILL_ALLOW_PRIVATE/.test(skilldlSrc) && /allowPrivate: process\.env\.FORGE_SKILL_ALLOW_PRIVATE === "1"/.test(skilldlSrc))
  const forgeSrc = fs.readFileSync(new URL("../forge.js", import.meta.url), "utf8")
  ok("help documents the power switches", forgeSrc.includes("FORGE_SHELL") && forgeSrc.includes("FORGE_BLAST_RADIUS") && forgeSrc.includes("FORGE_SKILL_ALLOW_PRIVATE"))
}

console.log(`\n== knowwise suite: ${PASS} passed, ${FAIL} failed ==`)
if (FAIL > 0) process.exit(1)
console.log("== knowwise suite: PASSED ==")
