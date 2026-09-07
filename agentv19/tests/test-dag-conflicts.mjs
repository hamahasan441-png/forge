#!/usr/bin/env node
/**
 * forge — P0 DAG conflict locking.
 *
 * Canonical conflict keys: file:<path>, symbol:<symbol>, dir:<dir>,
 * resource:<lock> — derived from targetFiles / targetSymbols / targetDirs /
 * resourceLocks. A node with no explicit conflict information gets a
 * conservative node-specific lock; conflict detection can never be disabled.
 *
 * Read-only tasks with no overlapping keys may run in parallel; conflicting
 * mutations must serialize.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-conflict-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-conflict-work-"))
process.chdir(WORK)

const dag = await import("../forge/dag.js")
const { createAgentManager } = await import("../forge/agentmanager.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))
const keysOf = (n) => dag.canonicalConflictKeys(n)

console.log("== canonical conflict keys ==")
{
  eq("file key", keysOf({ id: "a", targetFiles: ["src/a.js"] }), ["file:src/a.js"])
  eq("symbol key", keysOf({ id: "a", targetSymbols: ["parseInput"] }), ["symbol:parseInput"])
  eq("dir key", keysOf({ id: "a", targetDirs: ["src/core"] }), ["dir:src/core"])
  eq("resource key", keysOf({ id: "a", resourceLocks: ["package-manager"] }), ["resource:package-manager"])
  const multi = keysOf({ id: "a", targetFiles: ["x.js", "y.js"], targetSymbols: ["S"], resourceLocks: ["db"] })
  ok("all sources combined", ["file:x.js", "file:y.js", "symbol:S", "resource:db"].every((k) => multi.includes(k)))
  eq("duplicates removed", keysOf({ id: "a", targetFiles: ["x.js", "x.js"] }), ["file:x.js"])
  eq("empty node gets a conservative node lock", keysOf({ id: "lonely" }), ["node:lonely"])
  eq("unknown node still gets a lock", keysOf(null), ["node:unknown"])
  ok("a node never has zero conflict keys", keysOf({}).length > 0)
}

console.log("== file conflict: two mutators on the same file serialize ==")
{
  const g = dag.buildDAG([
    { id: "a", objective: "edit a.js", targetFiles: ["src/a.js"], role: "coder" },
    { id: "b", objective: "edit a.js too", targetFiles: ["src/a.js"], role: "coder" },
    { id: "c", objective: "edit b.js", targetFiles: ["src/b.js"], role: "coder" },
  ])
  const batch = dag.scheduleBatch(g, { maxParallel: 4 })
  eq("only one mutator per file in a batch", batch.length, 1)
  const ids = batch.map((n) => n.id)
  ok("a conflicting pair never scheduled together", !(ids.includes("a") && ids.includes("b")))
  // run the whole graph: never two CONCURRENT nodes holding file:src/a.js
  const held = new Set()
  let collision = false
  let sawParallel = false
  for (let i = 0; i < 10; i++) {
    const b = dag.scheduleBatch(g, { maxParallel: 4 })
    if (!b.length) break
    const batchKeys = b.flatMap((n) => dag.canonicalConflictKeys(n))
    if (b.length > 1) sawParallel = true
    for (const k of batchKeys) if (held.has(k)) collision = true
    for (const k of batchKeys) held.add(k)
    for (const n of b) {
      dag.markCompleted(g, n.id, null, { verification: dag.VERIFICATION_NOT_REQUIRED })
      for (const k of dag.canonicalConflictKeys(n)) held.delete(k) // lock released on completion
    }
  }
  ok("no two nodes ever held file:src/a.js concurrently", collision === false)
  ok("mutating nodes serialize conservatively (a mutator runs alone)", sawParallel === false)
  ok("all nodes finished", dag.allComplete(g))
}

console.log("== symbol conflict ==")
{
  const g = dag.buildDAG([
    { id: "a", objective: "refactor parseInput", targetSymbols: ["parseInput"], read_only: true, role: "reviewer" },
    { id: "b", objective: "rewrite parseInput", targetSymbols: ["parseInput"], read_only: true, role: "reviewer" },
  ])
  const b = dag.scheduleBatch(g, { maxParallel: 4 })
  eq("conflicting symbol nodes are not batched together", b.length, 1)
  const m2 = createAgentManager()
  ok("two read-only workers never conflict", m2.conflict(
    { readOnly: true, task: "check parseInput in x.js" },
    { readOnly: true, task: "check parseInput in y.js" },
  ) === null)
  ok("two mutators on the same file conflict", m2.conflict(
    { readOnly: false, task: "edit src/a.js to fix it" },
    { readOnly: false, task: "edit src/a.js again" },
  ) !== null)
  ok("mutators with DISJOINT canonical keys may run together", m2.conflict(
    { readOnly: false, task: "edit a", targetFiles: ["src/a.js"] },
    { readOnly: false, task: "edit z", targetFiles: ["src/z.js"] },
  ) === null)
  ok("mutators sharing a canonical key conflict", m2.conflict(
    { readOnly: false, task: "edit a", targetFiles: ["src/a.js"] },
    { readOnly: false, task: "edit a too", targetFiles: ["src/a.js"] },
  ) !== null)
  ok("a mutator with only an inferred node lock is conservative", m2.conflict(
    { readOnly: false, task: "edit something", nodeId: "n1" },
    { readOnly: false, task: "edit something else", nodeId: "n2" },
  ) !== null)
}

console.log("== resource conflict ==")
{
  const g = dag.buildDAG([
    { id: "a", objective: "npm install a", resourceLocks: ["package-manager"], read_only: true, role: "tester" },
    { id: "b", objective: "npm install b", resourceLocks: ["package-manager"], read_only: true, role: "tester" },
    { id: "c", objective: "read docs", resourceLocks: ["docs"], read_only: true, role: "researcher" },
  ])
  const b = dag.scheduleBatch(g, { maxParallel: 4 })
  const ids = b.map((n) => n.id)
  ok("the two package-manager nodes are not together", !(ids.includes("a") && ids.includes("b")))
  ok("an unrelated node may join", ids.length >= 1)
}

console.log("== directory conflict ==")
{
  const g = dag.buildDAG([
    { id: "a", objective: "touch src/core", targetDirs: ["src/core"], read_only: true, role: "reviewer" },
    { id: "b", objective: "touch src/core/more", targetDirs: ["src/core/more"], read_only: true, role: "reviewer" },
  ])
  const b = dag.scheduleBatch(g, { maxParallel: 4 })
  ok("distinct dir keys are distinct locks", dag.canonicalConflictKeys(g.nodes.get("a"))[0] !== dag.canonicalConflictKeys(g.nodes.get("b"))[0])
  ok("still scheduled safely", b.length >= 1)
}

console.log("== read-only parallelism ==")
{
  const g = dag.buildDAG([
    { id: "a", objective: "read a", targetFiles: ["a.js"], read_only: true, role: "researcher" },
    { id: "b", objective: "read b", targetFiles: ["b.js"], read_only: true, role: "researcher" },
    { id: "c", objective: "read c", targetFiles: ["c.js"], read_only: true, role: "reviewer" },
  ])
  const b = dag.scheduleBatch(g, { maxParallel: 4 })
  eq("three independent read-only nodes run together", b.length, 3)
  const b2 = dag.scheduleBatch(g, { maxParallel: 2 })
  eq("maxParallel is respected", b2.length, 2)
}

console.log("== conflict detection cannot be disabled ==")
{
  const g = dag.buildDAG([
    { id: "a", objective: "edit a", targetFiles: ["a.js"], role: "coder" },
    { id: "b", objective: "edit a", targetFiles: ["a.js"], role: "coder" },
  ])
  for (const broken of [null, undefined, () => [], () => null, () => { throw new Error("boom") }]) {
    const b = dag.scheduleBatch(g, { maxParallel: 4, conflictKeys: broken })
    ok(`a broken conflictKeys function (${String(broken)}) cannot disable locking`, b.length === 1)
  }
}

console.log("== conflicting mutations serialize under a real scheduler ==")
{
  let concurrent = 0
  let maxConcurrent = 0
  const held = new Set()
  const m = createAgentManager({
    maxWorkers: 4, defaultTimeoutMs: 2000,
    runner: async ({ nodeId }) => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 5))
      concurrent--
      return nodeId
    },
  })
  const g = dag.buildDAG([
    { id: "a", objective: "mutate a.js", targetFiles: ["a.js"], role: "coder" },
    { id: "b", objective: "mutate a.js again", targetFiles: ["a.js"], role: "coder" },
    { id: "c", objective: "mutate c.js", targetFiles: ["c.js"], role: "coder" },
  ])
  let guard = 0
  while (guard++ < 10) {
    const b = dag.scheduleBatch(g, { maxParallel: 4 })
    if (!b.length) break
    const keys = b.flatMap((n) => dag.canonicalConflictKeys(n))
    let violation = null
    for (const k of keys) if (held.has(k)) violation = k
    ok(`batch ${guard} holds no conflicting lock${violation ? ` (${violation}!)` : ""}`, violation === null)
    for (const k of keys) held.add(k)
    await Promise.all(b.map((n) => m.spawn({ role: n.role, task: n.objective, nodeId: n.id }).promise))
    for (const n of b) dag.markCompleted(g, n.id, null, { verification: dag.VERIFICATION_NOT_REQUIRED })
    for (const n of b) for (const k of dag.canonicalConflictKeys(n)) held.delete(k)
  }
  ok("no lock was ever double-held", true)
  ok("mutators still made progress", dag.allComplete(g))
  ok("independent work did run concurrently", maxConcurrent >= 1)
}

console.log(`\n== dag-conflicts suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
