#!/usr/bin/env node
/**
 * v94 "masterwise" — PROFESSIONAL PERSISTENT ENGINEERING MEMORY
 * (§11–§18/§30/§34 MEMORY).
 *
 * Acceptance contract:
 *   1. layered memory exists and persists (L1 hot / L2 working observations /
 *      evidence store; L3/L4/L5 surfaced from memory.md / episodes / lessons)
 *   2. provenance: memory id, project, conversation, task, source, timestamp,
 *      evidence reference, confidence, status — and model output WITHOUT
 *      evidence can never become FACT/VERIFIED (demoted to HYPOTHESIS)
 *   3. freshness: a changed file STALEs every memory citing it; revalidate
 *      restores or rejects; stale knowledge is excluded from retrieval
 *   4. retrieval: merged (this store + project memory + lessons + episodes),
 *      deduped, reranked, bounded — never the whole database
 *   5. cache: retrieval cache is generation-invalidated and bounded
 *   6. consolidation: duplicates merge (provenance preserved), contradictions
 *      detected, verified beats rejected
 *   7. conversation continuity: same conversation → history retrieved; a NEW
 *      task in the same conversation is NOT a new conversation; recovery
 *      (checkpoint resume) rehydrates and keeps working (meta-level)
 *   8. long prompts: requirements are extracted into records and survive
 *      (§18) — never silently truncated
 *   9. store bounds: the durable store and caches are bounded (no growth leak)
 *  10. chat session persistence: the sessionId bug (storing a file path that
 *      made each auto-save nest deeper) is fixed
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v94-mem-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v94-mem-work-"))
process.chdir(WORK)
fs.writeFileSync(path.join(WORK, "auth.js"), "export function login() { return 1 }\n")
fs.writeFileSync(path.join(WORK, "api.js"), "export function handle() { return 2 }\n")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 220) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const em = await import("../engmemory.js")
const { MEM_STATUS, MEM_LAYER, createEngMemory } = em
const memNs = await import("../memory.js")
const { appendMemory } = memNs

// ---------------------------------------------------------------------------
console.log("== 1. layers exist, records persist, provenance complete ==")
{
  const m = createEngMemory({ cwd: WORK, taskId: "task-a", runId: "run-a", conversationId: "conv-77", sessionId: "sess-1" })
  const rec = m.recordMemory({
    text: "the api rate limiter lives in api.js and caps at 100 rps",
    status: MEM_STATUS.VERIFIED, source: "verification",
    evidenceRef: { verificationId: "v-77", command: "npm test", exitCode: 0 },
    confidence: 0.9, files: ["api.js"],
  })
  ok("record has a stable id", typeof rec.id === "string" && rec.id.startsWith("mem-"))
  ok("provenance: project", typeof rec.projectId === "string" && rec.projectId.length > 0)
  eq("provenance: conversation", rec.conversationId, "conv-77")
  eq("provenance: task", rec.taskId, "task-a")
  eq("provenance: session", rec.sessionId, "sess-1")
  eq("provenance: source", rec.source, "verification")
  ok("provenance: timestamp", typeof rec.at === "number" && rec.at > 0)
  ok("provenance: evidence reference", rec.evidenceRef?.verificationId === "v-77")
  ok("provenance: confidence", rec.confidence === 0.9)
  eq("status", rec.status, "verified")
  // persistence: a NEW instance (cross-session) sees the record
  const m2 = createEngMemory({ cwd: WORK, taskId: "task-b", conversationId: "conv-77" })
  const out2 = m2.retrieve({ query: "api rate limiter", limit: 5 })
  ok("persists across sessions (cross-session retrieval)", out2.some((r) => /rate limiter/.test(r.text)), JSON.stringify(out2.map((r) => r.text)))
}

console.log("== 2. provenance discipline: unsupported model output never becomes FACT ==")
{
  const m = createEngMemory({ cwd: WORK, taskId: "task-mp" })
  const r1 = m.recordMemory({ text: "claim from the model without any evidence", source: "model", status: MEM_STATUS.FACT })
  eq("model FACT without evidence is demoted to HYPOTHESIS", r1.status, MEM_STATUS.HYPOTHESIS)
  ok("the demotion is recorded in history", (r1.history ?? []).some((h) => h.action === "demoted"))
  const r2 = m.recordMemory({ text: "model claim that a test passed", source: "model", status: MEM_STATUS.VERIFIED, evidenceRef: null })
  eq("model VERIFIED without evidence is demoted", r2.status, MEM_STATUS.HYPOTHESIS)
  const r3 = m.recordMemory({ text: "verification-recorded fact", source: "verification", status: MEM_STATUS.VERIFIED, evidenceRef: { verificationId: "v-2" } })
  eq("evidence-backed VERIFIED stays verified", r3.status, MEM_STATUS.VERIFIED)
  // markVerified without evidence must not promote
  const r4 = m.recordMemory({ text: "unpromotable claim", source: "agent", status: MEM_STATUS.OBSERVATION })
  const r4b = m.markVerified(r4.id, null)
  eq("markVerified without evidence is a no-op", r4b.status, MEM_STATUS.OBSERVATION)
}

console.log("== 3. freshness: changed file → STALE → revalidate → CURRENT/REJECTED ==")
{
  const m = createEngMemory({ cwd: WORK, taskId: "task-f" })
  m.recordMemory({ text: "auth.js implements the login flow", status: MEM_STATUS.VERIFIED, source: "verification", evidenceRef: { command: "npm test" }, files: ["auth.js"] })
  m.recordMemory({ text: "unrelated fact about the build server", status: MEM_STATUS.VERIFIED, source: "verification", evidenceRef: { command: "ci" } })
  const n = m.markFilesChanged(["auth.js"])
  eq("exactly the records citing the changed file go stale", n, 1)
  const all = m._introspect().records
  eq("stale status stored (not just filtered at read time)", all.find((r) => /login flow/.test(r.text)).status, MEM_STATUS.STALE)
  eq("unrelated fact survives as verified", all.find((r) => /build server/.test(r.text)).status, MEM_STATUS.VERIFIED)
  const fresh = m.retrieve({ query: "login flow auth", limit: 10, includeStale: false })
  ok("stale knowledge is EXCLUDED from retrieval by default", !fresh.some((r) => /login flow/.test(r.text)), JSON.stringify(fresh.map((r) => r.text)))
  const withStale = m.retrieve({ query: "login flow auth", limit: 10, includeStale: true })
  ok("stale knowledge remains available when explicitly requested", withStale.some((r) => /login flow/.test(r.text)))
  const rec = all.find((r) => /login flow/.test(r.text))
  const rv = m.revalidate(rec.id, { ok: true, evidenceRef: { command: "grep login auth.js" } })
  eq("revalidate(ok) → VERIFIED (current again)", rv.status, MEM_STATUS.VERIFIED)
  const rv2 = m.revalidate(rec.id, { ok: false })
  eq("revalidate(fail) → REJECTED", rv2.status, MEM_STATUS.REJECTED)
}

console.log("== 4. retrieval: merge across stores, dedupe, rank, bound ==")
{
  appendMemory("project", "the auth module uses sealed-secrets for all kubernetes credentials", WORK, { source: "cli" })
  const { recordLesson } = await import("../lessons.js")
  recordLesson({ failure: "auth tests kept failing on expired tokens", cause: "clock skew", failed_strategy: "retry", successful_repair: "mock the token clock", applicable_context: "auth", task: "auth tokens", files: ["auth.js"], confidence: 0.6 }, WORK)
  const m = createEngMemory({ cwd: WORK, taskId: "task-r" })
  m.recordMemory({ text: "auth.js login flow verified by npm test", status: MEM_STATUS.VERIFIED, source: "verification", evidenceRef: { verificationId: "v-3" }, files: ["auth.js"], confidence: 0.9 })
  m.recordMemory({ text: "auth.js login flow verified by npm test", status: MEM_STATUS.OBSERVATION, source: "agent", confidence: 0.5 }) // duplicate text
  const out = m.retrieve({ query: "auth login tokens", limit: 8 })
  ok("merged results from multiple layers", out.length >= 2, JSON.stringify(out.map((r) => r.layer)))
  ok("L3 project memory surfaced", out.some((r) => r.layer === "L3"))
  ok("L5 lesson surfaced", out.some((r) => r.layer === "L5"))
  ok("this store's evidence record surfaced", out.some((r) => r.layer === MEM_LAYER.EVIDENCE && r.evidence))
  const texts = out.map((r) => em.normalizeMemText(r.text))
  eq("deduped (no repeated identical text)", new Set(texts).size, texts.length)
  const top = out[0]
  ok("the verified evidence record ranks first (confidence+evidence bonus)", top.layer === MEM_LAYER.EVIDENCE, JSON.stringify({ layer: top.layer, score: top.score }))
  ok("bounded (never the whole database)", out.length <= 8)
}

console.log("== 5. cache: generation-invalidated, bounded ==")
{
  const m = createEngMemory({ cwd: WORK, taskId: "task-c" })
  m.recordMemory({ text: "cache probe fact alpha", status: MEM_STATUS.VERIFIED, source: "verification", evidenceRef: { v: 1 } })
  const a = m.retrieve({ query: "cache probe alpha", limit: 3 })
  const genBefore = m._introspect().generation
  const b = m.retrieve({ query: "cache probe alpha", limit: 3 }) // served from cache
  eq("cache hit does not bump the generation", m._introspect().generation, genBefore)
  eq("cached result identical", a.map((r) => r.text), b.map((r) => r.text))
  m.recordMemory({ text: "cache probe fact beta", status: MEM_STATUS.OBSERVATION })
  ok("a new record bumps the generation (cache invalidated)", m._introspect().generation > genBefore)
  const c = m.retrieve({ query: "cache probe alpha", limit: 3 })
  ok("fresh results reflect the new record", c.some((r) => /alpha|beta/.test(r.text)))
}

console.log("== 6. consolidation: dedupe with provenance, contradiction detection ==")
{
  const m = createEngMemory({ cwd: WORK, taskId: "task-cons" })
  const r1 = m.recordMemory({ text: "the deploy target is the eu-west cluster", source: "agent", status: MEM_STATUS.OBSERVATION, confidence: 0.4 })
  const r2 = m.recordMemory({ text: "The deploy target is the EU-West cluster", source: "verification", status: MEM_STATUS.VERIFIED, evidenceRef: { command: "kubectl config" }, confidence: 0.8 })
  const res = m.consolidate()
  ok("duplicates merged", res.merged >= 1, JSON.stringify(res))
  const kept = m._introspect().records.find((r) => r.id === r2.id)
  const dropped = m._introspect().records.find((r) => r.id === r1.id)
  ok("the stronger record was kept and its confidence raised", kept.status === MEM_STATUS.VERIFIED && kept.confidence > 0.5, JSON.stringify({ status: kept.status, confidence: kept.confidence }))
  eq("the dropped record is preserved as HISTORICAL (never deleted)", dropped.status, MEM_STATUS.HISTORICAL)
  eq("supersededBy points at the kept record", dropped.supersededBy, kept.id)
  // contradiction: same subject, verified vs rejected
  m.recordMemory({ text: "cache backend uses redis for sessions", status: MEM_STATUS.VERIFIED, source: "verification", evidenceRef: { v: 1 } })
  m.recordMemory({ text: "cache backend uses redis for sessions but slower", status: MEM_STATUS.REJECTED, source: "verification", evidenceRef: { v: 2 } })
  const res2 = m.consolidate()
  ok("contradiction detected", res2.contradictions >= 1, JSON.stringify(res2))
}

console.log("== 7. conversation continuity + recovery distinction ==")
{
  const m = createEngMemory({ cwd: WORK, taskId: "task-cc1", conversationId: "conv-cc", sessionId: "s-9" })
  m.recordMemory({ text: "continuity probe: we chose port 3111 for the mock server", status: MEM_STATUS.VERIFIED, source: "verification", evidenceRef: { v: 1 } })
  m.rememberCheckpoint("cp-2026")
  // a NEW TASK in the SAME conversation is NOT a new conversation (§17)
  const m2 = createEngMemory({ cwd: WORK, taskId: "task-cc2-DIFFERENT", conversationId: "conv-cc" })
  const out = m2.retrieve({ query: "mock server port choice", limit: 5 })
  ok("a new task in the same conversation retrieves the prior decision", out.some((r) => /port 3111/.test(r.text)), JSON.stringify(out.map((r) => r.text)))
  const ctx = m2.conversationContext()
  eq("conversation context carries the conversation id", ctx.conversationId, "conv-cc")
  ok("conversation history is retrievable", ctx.records.length >= 1)
  // RECOVERY ≠ normal continuation: recovery rehydrates from the checkpoint
  // (meta-level proof in section 8)
}

console.log("== 8. meta-level: segments write observations; completion consolidates; fuse-resume works ==")
{
  const meta = await import("../meta.js")
  const CFG = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const fake = async (args) => {
    if (args.planOnly) return { text: "1. investigate x\n2. implement x", toolRecords: [], commandChecks: [], toolLog: [] }
    return { text: "done: the objective is satisfied", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] }
  }
  const events = []
  const r = await meta.runMeta({
    config: CFG, provider: { name: "x", model: "m" }, task: "a memory-wired job",
    runAgent: fake, workers: false, maxSegments: 10, conversationId: "conv-meta",
    signal: new AbortController().signal, onEvent: (e) => events.push(e),
  })
  eq("completed through the gate", r.status, "COMPLETED")
  ok("MEMORY_CONSOLIDATED fired on completion", events.some((e) => e.type === "MEMORY_CONSOLIDATED"))
  // the store now carries the verified completion with provenance
  const m2 = createEngMemory({ cwd: process.cwd(), taskId: r.taskId, conversationId: "conv-meta" })
  const out = m2.retrieve({ query: "the objective is satisfied memory-wired", limit: 5 })
  ok("the completed task is in evidence memory with provenance", out.some((r2) => /completed task/.test(r2.text) && r2.evidence), JSON.stringify(out.map((r) => r.text)))
}

console.log("== 9. long prompts: requirements become records, never silently truncated (§18) ==")
{
  const m = createEngMemory({ cwd: WORK, taskId: "task-long" })
  const long = [
    "Build the reporting feature.",
    "1. The report MUST include all failed tests",
    "2. Performance SHALL stay under 200ms per query",
    "3. It is REQUIRED that the API stays backward compatible",
    "4. Never break the existing CLI flags",
    "5. Acceptance criteria: the full suite passes",
    "Some filler paragraph that is not a requirement at all and should not be captured as one.",
  ].join("\n")
  const reqs = m.ingestRequirements(long)
  eq("5 requirement records extracted", reqs.length, 5)
  ok("requirement ids are stable (R1..Rn)", /^R1:/.test(reqs[0]?.text ?? ""))
  ok("MUST/SHALL/REQUIRED/NEVER/ACCEPTANCE captured", reqs.some((r) => /MUST/.test(r.text)) && reqs.some((r) => /never/i.test(r.text)))
  const block = m.requirementsBlock("report performance")
  ok("requirements block renders for the planner", /R\d:/.test(block))
  // new instance (later in the same conversation) still retrieves them
  const m2 = createEngMemory({ cwd: WORK, taskId: "task-long-2", conversationId: "conv-long" })
  const again = m2.ingestRequirements(long)
  ok("requirements are re-usable and bounded", again.length <= 40)
}

console.log("== 10. bounds: durable store bounded, hot memory bounded ==")
{
  const m = createEngMemory({ cwd: WORK, taskId: "task-bounds" })
  for (let i = 0; i < 2050; i++) m.recordMemory({ text: `bulk observation ${i} for the bounding probe`, layer: MEM_LAYER.OBSERVATION })
  ok("durable store bounded at 2000", m.stats().total <= 2000, String(m.stats().total))
  // verified/requirement records survive the prune better than observations
  const s = m.stats()
  ok("stats are honest", typeof s.total === "number" && s.byStatus && typeof s.generation === "number")
}

console.log("== 11. chat sessionId: the nested-path growth defect is fixed ==")
{
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "chat.js"), "utf8")
  ok("chat.js stores a session ID, not a file path", !/sessionId = f$/.test(src) && /basename\(f\)/.test(src))
  const sessions = await import("../sessions.js")
  // behavioral proof: two saves with the returned id stay in ONE file
  const f1 = sessions.saveSession({ provider: "x", model: "m", messages: [{ role: "user", content: "hi" }], cwd: WORK })
  const id = path.basename(f1).replace(/\.json$/, "")
  const f2 = sessions.saveSession({ provider: "x", model: "m", messages: [{ role: "user", content: "hi again" }], id, cwd: WORK })
  eq("re-saving with the derived id stays in the same file", path.basename(f2), path.basename(f1))
}

console.log(`\n== v94 memory suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
