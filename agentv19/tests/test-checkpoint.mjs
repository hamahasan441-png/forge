#!/usr/bin/env node
/**
 * forge — run-grouped checkpoint restore (v20.2 P3-4). A whole agent run (many
 * edits, possibly to the same file) rolls back atomically via restoreRun, while
 * other runs are untouched. Isolated FORGE_HOME, zero network.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ckpt-"))
const { snapshotBefore, restoreRun, restoreLast, listCheckpoints } = await import("../forge/checkpoint.js")

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ckwork-"))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const A = path.join(WORK, "a.txt"), B = path.join(WORK, "b.txt"), C = path.join(WORK, "c.txt")
const read = (f) => { try { return fs.readFileSync(f, "utf8") } catch { return "<none>" } }

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }

// run1: two edits to a.txt + one edit to b.txt
fs.writeFileSync(A, "A0")
snapshotBefore([A], WORK, [], "run1"); fs.writeFileSync(A, "A1"); await sleep(4)
snapshotBefore([A], WORK, [], "run1"); fs.writeFileSync(A, "A2"); await sleep(4)
fs.writeFileSync(B, "B0")
snapshotBefore([B], WORK, [], "run1"); fs.writeFileSync(B, "B1"); await sleep(4)
// run2: one edit to c.txt
fs.writeFileSync(C, "C0")
snapshotBefore([C], WORK, [], "run2"); fs.writeFileSync(C, "C1"); await sleep(4)

console.log("== restoreRun rolls back an entire run ==")
const r1 = restoreRun(WORK, "run1")
ok("restoreRun reports the run", r1 && r1.runId === "run1")
ok("all run1 checkpoints consumed at once", r1 && r1.checkpoints === 3)
ok("a.txt restored to pre-run state (through 2 edits)", read(A) === "A0")
ok("b.txt restored to pre-run state", read(B) === "B0")
ok("other run (c.txt) untouched", read(C) === "C1")

console.log("== the other run survives and is now newest ==")
const left = listCheckpoints(WORK, 99)
ok("only run2 checkpoints remain", left.length === 1 && left[0].runId === "run2")
const r2 = restoreRun(WORK) // no id → newest run
ok("no-id restoreRun picks the newest run", r2 && r2.runId === "run2")
ok("c.txt restored", read(C) === "C0")
ok("no checkpoints left", listCheckpoints(WORK, 99).length === 0)

console.log("== restoreLast still works (backward compat) ==")
fs.writeFileSync(A, "Z0")
snapshotBefore([A], WORK, [], "run3"); fs.writeFileSync(A, "Z1")
const rl = restoreLast(WORK)
ok("restoreLast restored one checkpoint", rl && rl.files === 1)
ok("a.txt back to Z0", read(A) === "Z0")

console.log("== empty ==")
ok("restoreRun with no checkpoints returns null", restoreRun(WORK, "nope") === null)

try { fs.rmSync(WORK, { recursive: true, force: true }); fs.rmSync(process.env.FORGE_HOME, { recursive: true, force: true }) } catch {}
console.log(`\n== checkpoint suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
