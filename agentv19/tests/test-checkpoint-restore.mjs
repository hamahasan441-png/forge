#!/usr/bin/env node
/**
 * forge — P1 restore correctness (transactional).
 *
 * The protocol: PREFLIGHT → INTEGRITY → RESTORE SET → RESTORE → VERIFY →
 * PERSIST. A partial restore is NEVER reported as a clean one: status becomes
 * PARTIAL/FAILED, the failure list is persisted, and the file that could not be
 * restored is named.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-restore-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-restore-work-"))
process.chdir(WORK)

const cp = await import("../forge/checkpoint.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

console.log("== a clean restore round-trips byte-for-byte ==")
{
  const a = path.join(WORK, "a.txt")
  const b = path.join(WORK, "b.txt")
  fs.writeFileSync(a, "alpha one")
  fs.writeFileSync(b, "beta two")
  const id = cp.snapshotBefore([a, b], WORK, [], "run-1")
  fs.writeFileSync(a, "alpha MUTATED")
  fs.writeFileSync(b, "beta MUTATED")
  const r = cp.restoreTransactional(id)
  eq("status RESTORED", r.status, "RESTORED")
  ok("ok flag", r.ok === true)
  eq("both files restored", r.restored.length, 2)
  eq("nothing failed", r.failed.length, 0)
  eq("verify matched everything", r.phases.verify.matched, 2)
  eq("verify found no mismatch", r.phases.verify.mismatched.length, 0)
  ok("content is byte-identical", fs.readFileSync(a, "utf8") === "alpha one" && fs.readFileSync(b, "utf8") === "beta two")
  ok("result was persisted", r.persisted === true)
}

console.log("== a corrupt backup is caught BEFORE anything is written ==")
{
  const a = path.join(WORK, "c.txt")
  const b = path.join(WORK, "d.txt")
  fs.writeFileSync(a, "clean one")
  fs.writeFileSync(b, "clean two")
  const id = cp.snapshotBefore([a, b], WORK, [], "run-2")
  fs.writeFileSync(a, "dirty one")
  fs.writeFileSync(b, "dirty two")
  // corrupt ONE backup
  const m = JSON.parse(fs.readFileSync(path.join(cp.CHECKPOINTS_DIR, id, "manifest.json"), "utf8"))
  fs.writeFileSync(path.join(cp.CHECKPOINTS_DIR, id, m.files[1].backup), "CORRUPTED")
  const r = cp.restoreTransactional(id)
  eq("status FAILED", r.status, "FAILED")
  ok("not ok", r.ok === false)
  eq("nothing was restored (all-or-nothing)", r.restored.length, 0)
  ok("the failure names the file", r.failed.some((f) => String(f).includes("d.txt")) || r.notes.some((n) => n.includes("d.txt")))
  ok("the other file was NOT touched", fs.readFileSync(a, "utf8") === "dirty one")
  ok("the integrity phase ran", r.phases.integrity && r.phases.integrity.ok === false)
  ok("the restore phase was not reached", r.phases.restore === null)
  ok("the result was persisted", r.persisted === true)
  eq("last restore result is the failed one", cp.lastRestoreResult().status, "FAILED")
}

console.log("== a partial restore is reported as PARTIAL, never as success ==")
{
  const a = path.join(WORK, "e.txt")
  const b = path.join(WORK, "f.txt")
  fs.writeFileSync(a, "e original")
  fs.writeFileSync(b, "f original")
  const id = cp.snapshotBefore([a, b], WORK, [], "run-3")
  fs.writeFileSync(a, "e changed")
  fs.writeFileSync(b, "f changed")
  // make one restore fail at write time. v21.1: restores go through securefs
  // (O_NOFOLLOW temp file + rename onto the target), so the commit syscall for
  // the target path is renameSync — that is where the fault is injected.
  const m = JSON.parse(fs.readFileSync(path.join(cp.CHECKPOINTS_DIR, id, "manifest.json"), "utf8"))
  const realRename = fs.renameSync
  let blocked = false
  fs.renameSync = (from, to, ...rest) => {
    if (!blocked && path.basename(String(to)) === path.basename(m.files[1].path)) { blocked = true; throw new Error("EIO: simulated write failure") }
    return realRename(from, to, ...rest)
  }
  let r
  try { r = cp.restoreTransactional(id) } finally { fs.renameSync = realRename }
  ok("status is PARTIAL or FAILED, never RESTORED", ["PARTIAL", "FAILED"].includes(r.status))
  ok("ok is false", r.ok === false)
  ok("the failed file is named", r.failed.some((f) => String(f).includes("f.txt")) || r.phases.restore.failed.some((f) => String(f.path).includes("f.txt")))
  ok("the notes say a partial restore needs recovery", r.notes.some((n) => /partial|RECOVERING/i.test(n)))
  ok("the file that restored is correct", fs.readFileSync(a, "utf8") === "e original")
}

console.log("== restoring twice is safe ==")
{
  const a = path.join(WORK, "g.txt")
  fs.writeFileSync(a, "g original")
  const id = cp.snapshotBefore([a], WORK, [], "run-4")
  fs.writeFileSync(a, "g changed")
  const r1 = cp.restoreTransactional(id)
  eq("first restore ok", r1.status, "RESTORED")
  const r2 = cp.restoreTransactional(id)
  ok("second restore does not crash", typeof r2.status === "string")
  ok("content is still correct", fs.readFileSync(a, "utf8") === "g original")
}

console.log("== restore is scoped to the checkpoint's own files ==")
{
  const mine = path.join(WORK, "mine.txt")
  const other = path.join(WORK, "other.txt")
  fs.writeFileSync(mine, "mine v1")
  fs.writeFileSync(other, "other v1")
  const id = cp.snapshotBefore([mine], WORK, [], "run-5")
  fs.writeFileSync(mine, "mine v2")
  fs.writeFileSync(other, "other v2")
  const r = cp.restoreTransactional(id)
  eq("restored", r.status, "RESTORED")
  ok("the checkpoint's file was restored", fs.readFileSync(mine, "utf8") === "mine v1")
  ok("an unrelated file was left alone", fs.readFileSync(other, "utf8") === "other v2")
}

console.log("== the restore log keeps a bounded history ==")
{
  for (let i = 0; i < 3; i++) {
    const f = path.join(WORK, `log${i}.txt`)
    fs.writeFileSync(f, `v${i}`)
    const id = cp.snapshotBefore([f], WORK, [], "run-log")
    fs.writeFileSync(f, `changed${i}`)
    cp.restoreTransactional(id)
  }
  const last = cp.lastRestoreResult()
  ok("a last restore result exists", !!last)
  ok("it records the phase protocol", ["preflight", "integrity", "restoreSet", "restore", "verify", "persist"].every((k) => k in last.phases))
  ok("it records a timestamp", typeof last.at === "number")
}

console.log(`\n== checkpoint-restore suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
