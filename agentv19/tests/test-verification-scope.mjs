#!/usr/bin/env node
/**
 * forge — P0 verification scope.
 *
 * Evidence must be scoped to the node and to the files it actually changed:
 *   - a verification record identifies taskId/runId/segmentId/nodeId, epoch,
 *     scope, type and affectedFiles
 *   - running `npm test` after changing only src/parser.js does NOT prove
 *     anything about src/auth.js
 *   - evidence from an earlier verification epoch is stale and must not satisfy
 *     a later one
 *   - node-scoped and task-scoped queries are kept separate
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-vscope-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-vscope-work-"))
process.chdir(WORK)

const { createLedger, VERIFICATION_STATUS } = await import("../forge/verifyledger.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

console.log("== every record is fully scoped ==")
{
  const l = createLedger()
  const rec = l.recordCommand("npx vitest run src/parser.test.js", "2 tests passed\n[exit code: 0]", {
    exitCode: 0,
    affectedFiles: ["src/parser.js"],
    taskId: "t1", runId: "r1", segmentId: "seg-3", nodeId: "n2",
    verificationEpoch: 5,
  })
  eq("taskId", rec.taskId, "t1")
  eq("runId", rec.runId, "r1")
  eq("segmentId", rec.segmentId, "seg-3")
  eq("nodeId", rec.nodeId, "n2")
  eq("epoch", rec.verificationEpoch, 5)
  eq("identity scope", rec.identityScope, "node")
  eq("evidence breadth", rec.scope, "focused")
  eq("type", rec.type, "focused_test")
  ok("affectedFiles", Array.isArray(rec.affectedFiles) && rec.affectedFiles[0] === "src/parser.js")
  ok("evidence captured", typeof rec.evidence === "string" && rec.evidence.length > 0)
  ok("timestamp", typeof rec.timestamp === "number")
  ok("verification_id present", !!rec.verificationId)
}

console.log("== evidence for one file does not satisfy another ==")
{
  const l = createLedger()
  l.recordCommand("node --check src/parser.js", "ok\n[exit code: 0]", { exitCode: 0, affectedFiles: ["src/parser.js"], nodeId: "n1" })
  l.recordCommand("npx vitest run src/parser.test.js", "2 passed\n[exit code: 0]", { exitCode: 0, affectedFiles: ["src/parser.js"], nodeId: "n1" })
  const parser = l.status("medium", ["src/parser.js"], { nodeId: "n1" })
  ok("parser.js is verified", parser.ok === true)
  const auth = l.status("medium", ["src/auth.js"], { nodeId: "n1" })
  ok("auth.js is NOT verified by parser evidence", auth.ok === false)
  ok("the missing scope is named", (auth.missing ?? []).length > 0)
  console.log(`       (parser ok=${parser.ok}, auth ok=${auth.ok}, missing=${JSON.stringify(auth.missing)})`)
}

console.log("== a whole-suite run does not satisfy focused evidence ==")
{
  const l = createLedger()
  l.recordCommand("node --check src/parser.js", "ok\n[exit code: 0]", { exitCode: 0, affectedFiles: ["src/parser.js"], nodeId: "n1" })
  l.recordCommand("npm test", "40 tests passed\n[exit code: 0]", { exitCode: 0, affectedFiles: ["src/parser.js"], nodeId: "n1" })
  const st = l.status("medium", ["src/parser.js"], { nodeId: "n1" })
  ok("medium risk still needs a focused test", st.ok === false)
  ok("focused_test is what is missing", (st.missing ?? []).includes("focused_test") || (st.missing ?? []).some((m) => /focused/.test(String(m))))
}

console.log("== node scope and task scope are separate ==")
{
  const l = createLedger()
  l.recordCommand("node --check src/a.js", "ok\n[exit code: 0]", { exitCode: 0, affectedFiles: ["src/a.js"], nodeId: "n1" })
  l.recordCommand("npx vitest run src/a.test.js", "1 passed\n[exit code: 0]", { exitCode: 0, affectedFiles: ["src/a.js"], nodeId: "n1" })
  ok("node n1 verified", l.status("medium", ["src/a.js"], { nodeId: "n1" }).ok === true)
  ok("node n2 is not verified by n1's evidence", l.status("medium", ["src/a.js"], { nodeId: "n2" }).ok === false)
  ok("an unscoped query sees the records at all", l.status("medium", ["src/a.js"]).ok === true)
}

console.log("== stale epochs do not satisfy the current verification ==")
{
  const l = createLedger()
  l.recordCommand("node --check src/a.js", "ok\n[exit code: 0]", { exitCode: 0, affectedFiles: ["src/a.js"], nodeId: "n1", verificationEpoch: 1 })
  l.recordCommand("npx vitest run src/a.test.js", "1 passed\n[exit code: 0]", { exitCode: 0, affectedFiles: ["src/a.js"], nodeId: "n1", verificationEpoch: 1 })
  ok("epoch 1 verified", l.status("medium", ["src/a.js"], { nodeId: "n1", verificationEpoch: 1 }).ok === true)
  const later = l.status("medium", ["src/a.js"], { nodeId: "n1", verificationEpoch: 7 })
  ok("epoch 7 is NOT satisfied by epoch-1 evidence", later.ok === false)
  ok("the verdict explains that the evidence is stale", JSON.stringify(later).includes("stale") || (later.missing ?? []).length > 0)
  console.log(`       (epoch7 ok=${later.ok}, missing=${JSON.stringify(later.missing)}, reason=${String(later.reason).slice(0, 90)})`)
}

console.log("== a failed record poisons the scope, a later pass heals it ==")
{
  const l = createLedger()
  l.recordCommand("node --check src/a.js", "SyntaxError\n[exit code: 1]", { exitCode: 1, affectedFiles: ["src/a.js"], nodeId: "n1" })
  ok("failed evidence does not verify", l.status("medium", ["src/a.js"], { nodeId: "n1" }).ok === false)
  l.recordCommand("node --check src/a.js", "ok\n[exit code: 0]", { exitCode: 0, affectedFiles: ["src/a.js"], nodeId: "n1" })
  l.recordCommand("npx vitest run src/a.test.js", "1 passed\n[exit code: 0]", { exitCode: 0, affectedFiles: ["src/a.js"], nodeId: "n1" })
  ok("the scope heals once every requirement passes", l.status("medium", ["src/a.js"], { nodeId: "n1" }).ok === true)
}

console.log("== verification statuses are explicit ==")
{
  ok("PASSED", typeof VERIFICATION_STATUS.PASSED === "string")
  ok("FAILED", typeof VERIFICATION_STATUS.FAILED === "string")
  ok("MISSING", typeof VERIFICATION_STATUS.MISSING === "string")
  ok("STALE", typeof VERIFICATION_STATUS.STALE === "string")
  ok("UNKNOWN", typeof VERIFICATION_STATUS.UNKNOWN === "string")
}

console.log("== the ledger never loses an identity-less record ==")
{
  const l = createLedger()
  const rec = l.recordCommand("npm test", "ok\n[exit code: 0]", { exitCode: 0 })
  ok("a record with no identity still records what it can", !!rec && rec.passed === true)
  ok("its scope is task-level", rec.scope !== "node")
}

console.log(`\n== verification-scope suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
