#!/usr/bin/env node
/**
 * v94 gapclose — checkpoint restore WORKING-TREE RECONCILE (TODO checkpoint).
 *
 * Before: restoreTransactional verified only the files IT wrote. Files the
 * restore could never write — tooLarge skips (recorded sha, no backup) and
 * created files KEPT because they changed since the checkpoint — could drift
 * under an external process between crash and resume, and the result still
 * said "RESTORED" with no hint that the tree as a whole no longer matched the
 * checkpoint's recorded fingerprints. Now phase 5b RECONCILE hashes exactly
 * those files against the manifest and reports `reconcile.drift` +
 * `treeConsistent` — silent divergence is impossible.
 *
 * The tooLarge path uses a REAL >64MB file (the real snapshot ceiling), not a
 * lowered constant: the evidence must come from production behavior.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cpdrift-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cpdrift-work-"))
process.chdir(WORK)

const cp = await import("../checkpoint.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 260) : ""}`) }
}

console.log("== A. tooLarge file touched externally between snapshot and restore ==")
{
  const big = path.join(WORK, "big.bin")
  const small = path.join(WORK, "small.txt")
  // REAL ceiling: MAX_SNAPSHOT_BYTES is 64MB — one byte over is tooLarge
  fs.writeFileSync(big, Buffer.alloc(64 * 1024 * 1024 + 1, 7))
  fs.writeFileSync(small, "original")
  const id = cp.snapshotBefore([big, small], WORK, [], "run-drift")
  ok("checkpoint created", !!id)
  // simulate: forge mutated small (restore will undo it); an EXTERNAL process
  // touched big between crash and resume (restore can never undo that)
  fs.writeFileSync(small, "mutated by the run")
  fs.writeFileSync(big, Buffer.alloc(64 * 1024 * 1024 + 1, 9))
  const r = cp.restoreTransactional(id)
  ok("restore of the snapshotted file still succeeds", r.status === "RESTORED" && r.ok === true, JSON.stringify({ s: r.status, ok: r.ok, f: r.failed }))
  ok("small.txt was restored", r.restored.includes(small) && fs.readFileSync(small, "utf8") === "original")
  ok("reconcile phase ran and CHECKED the unrestorable file", r.phases.reconcile && r.phases.reconcile.checked >= 1, JSON.stringify(r.phases.reconcile))
  ok("reconcile reports the external drift (never silent)", r.phases.reconcile.drift.length === 1 && r.phases.reconcile.drift[0].path === big, JSON.stringify(r.phases.reconcile?.drift))
  ok("drift entry carries recorded+current fingerprint evidence", /^[0-9a-f]{8}$/.test(r.phases.reconcile.drift[0].recorded ?? "") && /^[0-9a-f]{8}$/.test(r.phases.reconcile.drift[0].current ?? ""), JSON.stringify(r.phases.reconcile.drift[0]))
  ok("treeConsistent=false — the tree does NOT match the checkpoint state", r.treeConsistent === false)
  ok("the result NOTES the drift for any consumer/narrative", r.notes.some((n) => /drift/i.test(n)), JSON.stringify(r.notes))
}

console.log("== B. clean control: untouched tooLarge file → tree consistent ==")
{
  const big = path.join(WORK, "big2.bin")
  const small = path.join(WORK, "small2.txt")
  fs.writeFileSync(big, Buffer.alloc(64 * 1024 * 1024 + 1, 3))
  fs.writeFileSync(small, "original2")
  const id = cp.snapshotBefore([big, small], WORK, [], "run-clean")
  fs.writeFileSync(small, "mutated2")
  const r = cp.restoreTransactional(id)
  ok("restore RESTORED", r.status === "RESTORED" && r.ok === true)
  ok("untouched tooLarge file matches its recorded fingerprint", r.phases.reconcile.matched >= 1 && r.phases.reconcile.drift.length === 0, JSON.stringify(r.phases.reconcile))
  ok("treeConsistent=true", r.treeConsistent === true)
  ok("no drift note when there is no drift", !r.notes.some((n) => /drift/i.test(n)), JSON.stringify(r.notes))
}

console.log("== C. created file kept (changed since checkpoint) is drift, honestly ==")
{
  const created = path.join(WORK, "created.txt")
  // snapshotBefore runs BEFORE the mutation: the created file does not exist yet
  const id = cp.snapshotBefore([], WORK, [created], "run-created")
  ok("checkpoint recorded the to-be-created file", !!id)
  fs.writeFileSync(created, "created by the run") // the run creates it
  cp.sealCreated(id, WORK)                        // seal records its fingerprint
  // external edit after the checkpoint — removing it would destroy that work
  fs.writeFileSync(created, "created by the run + external edit")
  const r = cp.restoreTransactional(id)
  ok("restore mechanics succeed (nothing was restorable)", r.status === "RESTORED", JSON.stringify({ s: r.status, f: r.failed, n: r.notes }))
  ok("the kept created file is reported as drift", r.phases.reconcile.drift.length === 1 && r.phases.reconcile.drift[0].path === created && /KEPT/i.test(r.phases.reconcile.drift[0].reason), JSON.stringify(r.phases.reconcile.drift))
  ok("treeConsistent=false", r.treeConsistent === false)
  ok("the file was NOT deleted (external work preserved)", fs.existsSync(created))
}

console.log("== D. created file removed cleanly → consistent ==")
{
  const created = path.join(WORK, "created2.txt")
  const id = cp.snapshotBefore([], WORK, [created], "run-created2")
  fs.writeFileSync(created, "ephemeral")
  cp.sealCreated(id, WORK)
  const r = cp.restoreTransactional(id)
  ok("created file removed by the restore", !fs.existsSync(created))
  ok("reconcile counts it matched", r.phases.reconcile.matched >= 1 && r.phases.reconcile.drift.length === 0, JSON.stringify(r.phases.reconcile))
  ok("treeConsistent=true", r.treeConsistent === true)
}

console.log("== E. missing tooLarge file is drift too (never 'matched by absence') ==")
{
  const big = path.join(WORK, "big3.bin")
  fs.writeFileSync(big, Buffer.alloc(64 * 1024 * 1024 + 1, 5))
  const id = cp.snapshotBefore([big], WORK, [], "run-missing")
  fs.rmSync(big) // external process deleted it between crash and resume
  const r = cp.restoreTransactional(id)
  ok("missing recorded file → drift with MISSING reason", r.phases.reconcile.drift.length === 1 && /MISSING/.test(r.phases.reconcile.drift[0].reason) && r.phases.reconcile.drift[0].current === null, JSON.stringify(r.phases.reconcile.drift))
  ok("treeConsistent=false", r.treeConsistent === false)
}

console.log("== F. the reconcile evidence is PERSISTED for recovery views ==")
{
  const last = cp.lastRestoreResult()
  ok("last restore result carries the reconcile phase", !!last && "reconcile" in (last.phases ?? {}), JSON.stringify(Object.keys(last?.phases ?? {})))
  ok("…and the treeConsistent verdict", typeof last.treeConsistent === "boolean")
}

console.log(`\n== checkpoint-drift suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
