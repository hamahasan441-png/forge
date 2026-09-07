#!/usr/bin/env node
/**
 * forge — P1 checkpoint integrity.
 *
 * A checkpoint you cannot trust is worse than no checkpoint. This suite proves
 * that every file in a checkpoint is backed by a readable byte-for-byte backup
 * whose SHA-256 matches the manifest, that a checkpoint header records the
 * identity/state needed to resume, and that tampering or truncation is
 * DETECTED rather than silently restored.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cpi-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cpi-work-"))
process.chdir(WORK)

const cp = await import("../forge/checkpoint.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const writeFiles = (n, size = 1024) => {
  const files = []
  for (let i = 0; i < n; i++) {
    const f = path.join(WORK, `f${i}.txt`)
    fs.writeFileSync(f, `${"x".repeat(size)}-${i}`)
    files.push(f)
  }
  return files
}

console.log("== every file is backed up and hash-verified ==")
{
  const files = writeFiles(3)
  const id = cp.snapshotBefore(files, WORK, [], "run-integrity")
  const v = cp.verifyCheckpointIntegrity(id)
  ok("integrity check passes", v.ok === true)
  eq("issues: none", v.issues.length, 0)
  ok("every file is in the manifest", v.files === 3)
  const m = JSON.parse(fs.readFileSync(path.join(cp.CHECKPOINTS_DIR, id, "manifest.json"), "utf8"))
  ok("manifest has an id", typeof m.id === "string")
  ok("manifest has a timestamp", typeof m.ts === "number")
  eq("manifest records the cwd", m.cwd, path.resolve(WORK))
  ok("manifest records the run id", m.runId === "run-integrity")
  ok("every manifest entry has a sha", m.files.every((f) => typeof f.sha === "string" && f.sha.length === 64))
  ok("every manifest entry has a backup name", m.files.every((f) => typeof f.backup === "string"))
  ok("every backup file exists on disk", m.files.every((f) => fs.existsSync(path.join(cp.CHECKPOINTS_DIR, id, f.backup))))
}

console.log("== the hash covers the WHOLE file, not the first MB ==")
{
  const big = path.join(WORK, "big.bin")
  const head = "A".repeat(1024 * 1024 + 10)
  fs.writeFileSync(big, head + "TAIL-MARKER")
  const id = cp.snapshotBefore([big], WORK, [], "run-big")
  const before = cp.verifyCheckpointIntegrity(id)
  ok("fresh checkpoint verifies", before.ok === true)
  // mutate ONLY the tail, past the 1 MB mark that a partial hash would miss
  const fd = fs.openSync(big, "r+")
  fs.writeSync(fd, "TAIL-CHANGED", head.length)
  fs.closeSync(fd)
  const after = fs.readFileSync(big, "utf8")
  ok("the tail really changed", after.endsWith("TAIL-CHANGED"))
  const m = JSON.parse(fs.readFileSync(path.join(cp.CHECKPOINTS_DIR, id, "manifest.json"), "utf8"))
  ok("the manifest hash covers the tail", m.files[0].sha !== cp.fullFileHash(big).sha)
  // restore and confirm the whole file comes back byte-for-byte
  const r = cp.restoreTransactional(id)
  eq("restored", r.status, "RESTORED")
  ok("the tail is back", fs.readFileSync(big, "utf8").endsWith("TAIL-MARKER"))
}

console.log("== tampering is detected ==")
{
  const a = path.join(WORK, "tamper.txt")
  fs.writeFileSync(a, "original content")
  const id = cp.snapshotBefore([a], WORK, [], "run-tamper")
  fs.writeFileSync(a, "changed content")
  // corrupt the backup
  const m = JSON.parse(fs.readFileSync(path.join(cp.CHECKPOINTS_DIR, id, "manifest.json"), "utf8"))
  fs.writeFileSync(path.join(cp.CHECKPOINTS_DIR, id, m.files[0].backup), "CORRUPT")
  const v = cp.verifyCheckpointIntegrity(id)
  ok("corruption is detected", v.ok === false)
  ok("the issue names the file", v.issues.join(" ").includes("tamper.txt"))
  ok("the issue explains the mismatch", /hash/i.test(v.issues.join(" ")))
  const r = cp.restoreTransactional(id)
  ok("restore refuses", r.status !== "RESTORED")
  ok("the file was left alone", fs.readFileSync(a, "utf8") === "changed content")
}

console.log("== a missing backup is detected ==")
{
  const a = path.join(WORK, "gone.txt")
  fs.writeFileSync(a, "keep me")
  const id = cp.snapshotBefore([a], WORK, [], "run-gone")
  const m = JSON.parse(fs.readFileSync(path.join(cp.CHECKPOINTS_DIR, id, "manifest.json"), "utf8"))
  fs.rmSync(path.join(cp.CHECKPOINTS_DIR, id, m.files[0].backup))
  const v = cp.verifyCheckpointIntegrity(id)
  ok("missing backup detected", v.ok === false)
  const r = cp.restoreTransactional(id)
  eq("preflight fails", r.phases.preflight.missing.length, 1)
  ok("restore did not claim success", r.ok === false)
}

console.log("== compression: large backups are gzipped, small ones raw ==")
{
  const small = path.join(WORK, "small.txt")
  fs.writeFileSync(small, "tiny")
  const sid = cp.snapshotBefore([small], WORK, [], "run-small")
  const sm = JSON.parse(fs.readFileSync(path.join(cp.CHECKPOINTS_DIR, sid, "manifest.json"), "utf8"))
  ok("a small file is stored raw", sm.files.every((f) => !String(f.backup).endsWith(".gz")))
  const big2 = path.join(WORK, "compressme.txt")
  fs.writeFileSync(big2, "y".repeat(400 * 1024))
  const bid = cp.snapshotBefore([big2], WORK, [], "run-gz")
  const bm = JSON.parse(fs.readFileSync(path.join(cp.CHECKPOINTS_DIR, bid, "manifest.json"), "utf8"))
  ok("a large file is gzipped", bm.files.every((f) => String(f.backup).endsWith(".gz")))
  ok("gzip backup verifies", cp.verifyCheckpointIntegrity(bid).ok === true)
  fs.writeFileSync(big2, "z".repeat(10))
  const r = cp.restoreTransactional(bid)
  eq("gzipped backup restores", r.status, "RESTORED")
  ok("restored content matches", fs.readFileSync(big2, "utf8") === "y".repeat(400 * 1024))
}

console.log("== created files are recorded for undo, not snapshotted ==")
{
  const created = path.join(WORK, "brand-new.txt")
  // the checkpoint is taken BEFORE the file exists: "created" means the undo
  // has to remove it later, so its post-creation hash is recorded.
  const id = cp.snapshotBefore([], WORK, [created], "run-created")
  ok("a checkpoint exists for the future file", !!id)
  fs.writeFileSync(created, "new")
  const m = JSON.parse(fs.readFileSync(path.join(cp.CHECKPOINTS_DIR, id, "manifest.json"), "utf8"))
  const rec = m.files.find((f) => f.path === created)
  ok("the created file is in the manifest", !!rec)
  eq("it is marked created", rec.created, true)
  ok("it has no backup (there was nothing to back up)", rec.backup === null)
  const r = cp.restoreTransactional(id)
  eq("undo removes the created file", r.status, "RESTORED")
  ok("the file is gone", !fs.existsSync(created))
}

console.log("== an unknown checkpoint id is rejected, not guessed ==")
{
  const v = cp.verifyCheckpointIntegrity("does-not-exist")
  ok("integrity of a missing checkpoint is false", v.ok === false)
  const r = cp.restoreTransactional("does-not-exist")
  eq("restore of a missing checkpoint fails", r.status, "FAILED")
  ok("the failure is recorded", r.notes.length > 0)
}

console.log(`\n== checkpoint-integrity suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
