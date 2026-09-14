#!/usr/bin/env node
/**
 * v95 "worktreewise" — isolated worktree execution for DAG nodes.
 *
 * This is the proof for the kernel TODO item that lived open since the design
 * was written: "nodes would run in a per-node git worktree so parallel
 * segments never see each other's partial writes; design exists, no
 * implementation, no test." One section per guarantee:
 *
 *  1. lifecycle: create → isolate → capture → merge-back → remove, all with
 *     REAL git worktrees in a real repo.
 *  2. isolation invariant: a write inside the worktree NEVER appears in the
 *     shared tree until the serialized merge lands it there.
 *  3. merge-back honesty: a conflicting patch NEVER half-applies — the main
 *     tree stays untouched, the conflicting files are NAMED, the worktree is
 *     kept for inspection.
 *  4. planIsolation eligibility: mutating + DECLARED targets + pairwise
 *     disjoint keys only; undeclared mutators and read-only nodes stay
 *     serialized; the current node's keys are excluded.
 *  5. gates: FORGE_WORKTREE=0 / config off / non-git repo → honestly
 *     unavailable (serialized execution, the old behavior, unchanged).
 *  6. crash-resume: orphaned worktrees (dead run, dead pid) are swept at the
 *     next task start; live ones are kept.
 *  7. child-process runner: runIsolatedNode spawns worknode.mjs with
 *     cwd = the worktree, a REAL agent loop runs against a scripted mock
 *     provider, the write_file lands INSIDE the worktree (never the main
 *     tree), and the result JSON carries the full agent result shape.
 *  8. meta integration: a full runMeta task with a JSON plan declaring
 *     targetFiles dispatches the isolated node to a real worktree child,
 *     merges the changes into the shared tree, completes the node with
 *     ledger evidence, and emits WORKTREE_* events end to end.
 *  9. dedup: no new agent tools, no new first-party skills — worktreewise is
 *     kernel execution policy, not a tool surface (the wire stays 1:1).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { execFileSync } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-worktreewise-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_WORKTREE // default ON for this suite
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-worktreewise-work-"))
process.chdir(WORK)

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const wt = await import("../worktree.js")
const dagLib = await import("../dag.js")

/** A real git repo fixture: init, config, seed files, initial commit. */
function gitRepo(dir, files = { "seed.txt": "seed\n" }) {
  fs.rmSync(dir, { recursive: true, force: true }) // a rerun must not see the last run's repo
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }
  execFileSync("git", ["init", "-q", "."], { cwd: dir })
  execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: dir })
  execFileSync("git", ["config", "user.name", "forge-test"], { cwd: dir })
  execFileSync("git", ["add", "-A"], { cwd: dir })
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir })
  return dir
}

// ---------------------------------------------------------------------------
console.log("== 1. lifecycle: create → capture → merge-back → remove (real git) ==")
{
  const repo = gitRepo(path.join(os.tmpdir(), "wt-life-"), {
    "base.txt": "line1\nline2\nline3\nline4\nline5\n",
    "keep.txt": "untouched\n",
  })
  const c = await wt.createWorktree({ root: repo, nodeId: "n1", runId: "run-1", taskId: "task-1" })
  ok("createWorktree ok", c.ok === true, JSON.stringify(c))
  ok("dir lives under .forge/worktrees", c.dir.startsWith(path.join(repo, ".forge", "worktrees")), c.dir)
  ok("registry entry is live with owner ids", (() => {
    const reg = wt.listRegistry(repo)
    return reg.length === 1 && reg[0].status === "live" && reg[0].nodeId === "n1" && reg[0].runId === "run-1" && reg[0].taskId === "task-1"
  })())
  ok("based on HEAD", /^[0-9a-f]{40}$/.test(c.base ?? ""))

  fs.writeFileSync(path.join(c.dir, "base.txt"), "line1\nline2\nCHANGED\nline4\nline5\n")
  fs.writeFileSync(path.join(c.dir, "new-file.txt"), "brand new\n")
  const cap = await wt.captureChanges({ root: repo, dir: c.dir, nodeId: "n1" })
  ok("capture ok, not clean", cap.ok === true && cap.clean !== true, JSON.stringify(cap))
  eq("capture lists modified + new files sorted-free", [...(cap.files ?? [])].sort(), ["base.txt", "new-file.txt"])
  ok("patch written with content", cap.bytes > 0 && fs.existsSync(cap.patchPath))

  const m = await wt.mergeBack({ root: repo, patchPath: cap.patchPath })
  ok("mergeBack ok", m.ok === true && m.applied === true, JSON.stringify(m))
  eq("files landed in the MAIN tree", (m.files ?? []).sort(), ["base.txt", "new-file.txt"])
  ok("main tree content is the node's version", fs.readFileSync(path.join(repo, "base.txt"), "utf8").includes("CHANGED"))
  ok("new file exists in the main tree", fs.readFileSync(path.join(repo, "new-file.txt"), "utf8") === "brand new\n")

  const rm = await wt.removeWorktree({ root: repo, dir: c.dir })
  ok("remove ok", rm.ok === true, JSON.stringify(rm))
  ok("worktree dir is gone", !fs.existsSync(c.dir))
  ok("no worktree remains registered by git", execFileSync("git", ["worktree", "list"], { cwd: repo }).toString().split("\n").filter((l) => l.includes(".forge")).length === 0)
}

// ---------------------------------------------------------------------------
console.log("== 2. isolation invariant: parallel segments never see each other's writes ==")
{
  const repo = gitRepo(path.join(os.tmpdir(), "wt-iso-"), { "shared.txt": "base\n" })
  const a = await wt.createWorktree({ root: repo, nodeId: "writer-a", runId: "run-iso" })
  const b = await wt.createWorktree({ root: repo, nodeId: "writer-b", runId: "run-iso" })
  ok("two parallel worktrees", a.ok && b.ok && a.dir !== b.dir)
  fs.writeFileSync(path.join(a.dir, "shared.txt"), "written by A\n")
  // node B (and the shared tree) must never see A's partial write
  ok("the shared tree does NOT see A's write", fs.readFileSync(path.join(repo, "shared.txt"), "utf8") === "base\n")
  ok("worktree B does NOT see A's write", fs.readFileSync(path.join(b.dir, "shared.txt"), "utf8") === "base\n")
  // A merges; B's tree is still clean from HEAD
  const capA = await wt.captureChanges({ root: repo, dir: a.dir, nodeId: "writer-a" })
  const mA = await wt.mergeBack({ root: repo, patchPath: capA.patchPath })
  ok("A merges cleanly", mA.ok === true)
  ok("the shared tree now sees A's write", fs.readFileSync(path.join(repo, "shared.txt"), "utf8") === "written by A\n")
  // B writes the SAME file — now the merge must conflict honestly
  fs.writeFileSync(path.join(b.dir, "shared.txt"), "written by B\n")
  const capB = await wt.captureChanges({ root: repo, dir: b.dir, nodeId: "writer-b" })
  const mB = await wt.mergeBack({ root: repo, patchPath: capB.patchPath })
  ok("B's overlapping merge is refused", mB.ok === false && mB.applied !== true, JSON.stringify(mB))
  ok("the conflicting file is NAMED", (mB.conflicts ?? []).includes("shared.txt"), JSON.stringify(mB.conflicts))
  ok("the shared tree keeps A's merged content (no silent overwrite)", fs.readFileSync(path.join(repo, "shared.txt"), "utf8") === "written by A\n")
  ok("B's worktree is KEPT for inspection", fs.existsSync(b.dir))
  await wt.removeWorktree({ root: repo, dir: b.dir })
  await wt.removeWorktree({ root: repo, dir: a.dir })
}

// ---------------------------------------------------------------------------
console.log("== 3. merge-back honesty: checked-then-applied, never half-applied ==")
{
  const repo = gitRepo(path.join(os.tmpdir(), "wt-half-"), { "f.txt": "one\ntwo\nthree\nfour\nfive\n" })
  const c = await wt.createWorktree({ root: repo, nodeId: "n", runId: "r" })
  // multi-hunk patch: one hunk applies, the other conflicts with main drift
  fs.writeFileSync(path.join(c.dir, "f.txt"), "ONE\ntwo\nthree\nfour\nFIVE\n")
  fs.writeFileSync(path.join(repo, "f.txt"), "one\ntwo\nthree\nfour\nFIVE-DRIFTED\n")
  const before = fs.readFileSync(path.join(repo, "f.txt"), "utf8")
  const cap = await wt.captureChanges({ root: repo, dir: c.dir, nodeId: "n" })
  const m = await wt.mergeBack({ root: repo, patchPath: cap.patchPath })
  ok("conflicting multi-hunk patch is refused", m.ok === false)
  ok("the main tree is UNTOUCHED (atomic, never half-applied)", fs.readFileSync(path.join(repo, "f.txt"), "utf8") === before)
  ok("honest reason", /conflict/i.test(m.reason ?? ""))
  await wt.removeWorktree({ root: repo, dir: c.dir })
}

// ---------------------------------------------------------------------------
console.log("== 4. planIsolation: eligibility is conservative and declared ==")
{
  const mk = (id, extra = {}) => ({ id, objective: `o ${id}`, dependencies: [], read_only: false, role: "coder", ...extra })
  const nodes = [
    mk("a", { targetFiles: ["a.js"] }),
    mk("b", { targetFiles: ["a.js"] }),            // overlaps a → serialized
    mk("c", { targetFiles: ["c.js"] }),
    mk("ro", { read_only: true, targetFiles: ["x.js"], role: "researcher" }),
    mk("undeclared", {}),                           // node: fallback → serialized
    mk("lock", { resourceLocks: ["db"] }),
  ]
  const plan = wt.planIsolation({ nodes, maxNodes: 8 })
  eq("picks the disjoint declared mutators", plan.map((p) => p.node.id), ["a", "c", "lock"])
  const capped = wt.planIsolation({ nodes, maxNodes: 1 })
  eq("maxNodes bounds the batch", capped.map((p) => p.node.id), ["a"])
  const excluded = wt.planIsolation({ nodes, excludeIds: ["a"], maxNodes: 8 })
  eq("excludeIds removes a (b becomes eligible — disjoint from the rest)", excluded.map((p) => p.node.id), ["b", "c", "lock"])
  const exclKeys = wt.planIsolation({ nodes, excludeKeys: ["file:a.js"], maxNodes: 8 })
  eq("excludeKeys (the current node's keys) removes both a and b", exclKeys.map((p) => p.node.id), ["c", "lock"])
  const viaConflictKeys = wt.planIsolation({
    nodes: [mk("k1", { conflictKeys: ["file:k1.js"] }), mk("k2", { conflictKeys: ["file:k2.js"] }), mk("k3", { conflictKeys: ["file:k1.js"] })],
    conflictKeys: dagLib.canonicalConflictKeys, maxNodes: 8,
  })
  eq("explicit conflictKeys are honored (k3 overlaps k1)", viaConflictKeys.map((p) => p.node.id), ["k1", "k2"])
  const withDeps = wt.planIsolation({ nodes: [mk("dep", { targetFiles: ["dep.js"], dependencies: ["earlier"] }), mk("free", { targetFiles: ["free.js"] })], maxNodes: 8 })
  eq("a node WITH dependencies stays serialized (a HEAD-only worktree cannot see its dependency output)", withDeps.map((p) => p.node.id), ["free"])
  eq("empty input is empty", wt.planIsolation({ nodes: [] }), [])
  eq("missing input is empty", wt.planIsolation({}), [])
  // uncommittedFiles: the shared-tree in-flight guard
  const repoU = gitRepo(path.join(os.tmpdir(), "wt-dirty-" + Date.now()), { "clean.js": "1\n", "inflight.js": "1\n" })
  fs.writeFileSync(path.join(repoU, "inflight.js"), "2\n")
  fs.writeFileSync(path.join(repoU, "new-untracked.js"), "x\n")
  const dirty = await wt.uncommittedFiles(repoU)
  ok("uncommittedFiles lists tracked drift + untracked, not .forge", dirty.has("inflight.js") && dirty.has("new-untracked.js") && !dirty.has("clean.js"), JSON.stringify([...(dirty ?? [])]))
  const dirtyNull = await wt.uncommittedFiles(path.join(os.tmpdir(), "wt-dirty-none-" + Date.now()))
  eq("uncommittedFiles fails honestly on a non-repo (null → serialize)", dirtyNull, null)
  fs.rmSync(repoU, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
console.log("== 5. gates: honest unavailability, never a silent guess ==")
{
  const repo = gitRepo(path.join(os.tmpdir(), "wt-gate-"))
  eq("git repo: available", wt.isolationAvailable({ root: repo, config: {} }).ok, true)
  eq("non-git dir: unavailable with reason", wt.isolationAvailable({ root: os.tmpdir(), config: {} }).ok, false)
  ok("non-git reason is named", /not a git|unavailable/i.test(wt.isolationAvailable({ root: os.tmpdir(), config: {} }).reason ?? ""))
  eq("FORGE_WORKTREE=0 opts out", wt.isolationEnabled({ config: {}, env: { FORGE_WORKTREE: "0" } }), false)
  eq("FORGE_WORKTREE=false opts out", wt.isolationEnabled({ config: {}, env: { FORGE_WORKTREE: "false" } }), false)
  eq("config worktree.enabled=false opts out", wt.isolationEnabled({ config: { worktree: { enabled: false } }, env: {} }), false)
  eq("default is ON", wt.isolationEnabled({ config: {}, env: {} }), true)
  const empty = await wt.createWorktree({ root: path.join(os.tmpdir(), "wt-empty-nope-" + Date.now()), nodeId: "n" })
  ok("createWorktree refuses a non-git root honestly", empty.ok === false && Boolean(empty.reason))
  const repoNoCommit = path.join(os.tmpdir(), "wt-nocommit-" + Date.now())
  fs.mkdirSync(repoNoCommit, { recursive: true })
  execFileSync("git", ["init", "-q", "."], { cwd: repoNoCommit })
  const nc = await wt.createWorktree({ root: repoNoCommit, nodeId: "n" })
  ok("no HEAD → honest refusal (nothing to check out)", nc.ok === false && /no commits/i.test(nc.reason ?? ""), JSON.stringify(nc))
}

// ---------------------------------------------------------------------------
console.log("== 6. crash-resume: orphaned worktrees are swept, live ones kept ==")
{
  const repo = gitRepo(path.join(os.tmpdir(), "wt-sweep-"))
  const dead = await wt.createWorktree({ root: repo, nodeId: "dead-node", runId: "dead-run" })
  const mine = await wt.createWorktree({ root: repo, nodeId: "my-node", runId: "my-run" })
  // the dead run's process is gone: fake the pid, keep status live
  const regPath = path.join(repo, ".forge", "worktrees", "registry.json")
  const reg = JSON.parse(fs.readFileSync(regPath, "utf8"))
  const deadEntry = reg.find((e) => e.id === dead.id)
  deadEntry.pid = 999999999
  fs.writeFileSync(regPath, JSON.stringify(reg))
  const swept = await wt.sweepOrphans({ root: repo, liveRunIds: ["my-run"] })
  eq("exactly the dead worktree is swept", swept.map((s) => s.id), [dead.id])
  ok("dead worktree dir is gone", !fs.existsSync(dead.dir))
  ok("the LIVE worktree is kept", fs.existsSync(mine.dir))
  const kept = wt.listRegistry(repo).find((e) => e.id === mine.id)
  eq("live registry entry survives", kept?.status, "live")
  const swept2 = await wt.sweepOrphans({ root: repo, liveRunIds: ["my-run"] })
  eq("a second sweep is a no-op", swept2, [])
  // a pid that is alive right now (this process) is also protected
  const pidEntry = wt.listRegistry(repo).find((e) => e.id === mine.id)
  pidEntry.pid = process.pid
  fs.writeFileSync(regPath, JSON.stringify(wt.listRegistry(repo)))
  const swept3 = await wt.sweepOrphans({ root: repo, liveRunIds: [] })
  eq("a live pid is protected even without the run id", swept3, [])
  await wt.removeWorktree({ root: repo, dir: mine.dir })
}

// ---------------------------------------------------------------------------
console.log("== 7. child-process runner: real worknode.mjs in the worktree ==")
{
  // a scripted OpenAI-wire mock: the ISOLATED task triggers one write_file,
  // the tool result triggers the final text. Both stream and non-stream.
  const calls = []
  const mkSse = (res, events) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    let i = 0
    const tick = () => {
      if (i >= events.length) { res.write("data: [DONE]\n\n"); res.end(); return }
      res.write(`data: ${JSON.stringify(events[i++])}\n\n`)
      setTimeout(tick, 5)
    }
    tick()
  }
  const srv = http.createServer((req, res) => {
    let body = ""
    req.on("data", (d) => { body += d })
    req.on("end", () => {
      calls.push({ url: req.url })
      let j = {}
      try { j = JSON.parse(body) } catch {}
      const msgs = j.messages ?? []
      const lastTool = [...msgs].reverse().find((m) => m.role === "tool")
      const userText = msgs.filter((m) => m.role === "user").map((m) => String(m.content)).join(" ")
      const content = "isolated node report: I wrote feat-a.js with the new constant"
      const toolMsg = { role: "assistant", content: "", tool_calls: [{ id: "call_iso", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "feat-a.js", content: "export const A = 41 + 1\n" }) } }] }
      const finish = { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }
      let payload
      if (lastTool) payload = finish
      else if (/ISOLATED git worktree/.test(userText)) payload = { choices: [{ message: toolMsg, finish_reason: "tool_calls" }] }
      else payload = { choices: [{ message: { role: "assistant", content: "main loop answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }
      if (j.stream) {
        if (payload.choices[0].message.tool_calls) {
          mkSse(res, [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_iso", type: "function", function: { name: "write_file", arguments: "" } }] }, finish_reason: null }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: "feat-a.js", content: "export const A = 41 + 1\n" }) } }] }, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ])
        } else {
          mkSse(res, [
            { choices: [{ delta: { content }, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } },
          ])
        }
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const port = srv.address().port

  const repo = gitRepo(path.join(os.tmpdir(), "wt-child-"), { "seed.txt": "seed\n" })
  const c = await wt.createWorktree({ root: repo, nodeId: "iso-node", runId: "child-run" })
  const provider = { name: "mock", label: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test-key", model: "mock-mini", contextWindow: 128000, keyUrl: "" }
  const res = await wt.runIsolatedNode({
    dir: c.dir,
    spec: {
      nodeId: "iso-node", role: "coder",
      task: "Write feature file A inside the ISOLATED git worktree.",
      context: "", config: {}, provider, maxSteps: 6,
      taskId: "t-child", runId: "child-run", segmentId: "worktree-iso-node",
    },
    timeoutMs: 90_000,
  })
  ok("child settles completed", /^completed$/i.test(String(res.status ?? "")), JSON.stringify(res).slice(0, 300))
  ok("child returns the full agent result shape", typeof res.text === "string" && Array.isArray(res.toolRecords) && res.usage && typeof res.steps === "number")
  ok("the child wrote feat-a.js INSIDE the worktree", fs.existsSync(path.join(c.dir, "feat-a.js")))
  ok("the write NEVER landed in the main tree", !fs.existsSync(path.join(repo, "feat-a.js")))
  ok("the mock saw the isolated task", calls.some((x) => x.url.includes("/chat/completions")))

  // the merge lands it in the main tree
  const cap = await wt.captureChanges({ root: repo, dir: c.dir, nodeId: "iso-node" })
  const m = await wt.mergeBack({ root: repo, patchPath: cap.patchPath })
  ok("merge lands the child's write in the main tree", m.ok === true && fs.readFileSync(path.join(repo, "feat-a.js"), "utf8") === "export const A = 41 + 1\n")
  await wt.removeWorktree({ root: repo, dir: c.dir })

  // crash honesty: a spec pointing at a dead mock → honest failure shape
  const dead = { ...provider, baseUrl: "http://127.0.0.1:1/v1" }
  const repo2 = gitRepo(path.join(os.tmpdir(), "wt-child2-"), { "seed.txt": "seed\n" })
  const c2 = await wt.createWorktree({ root: repo2, nodeId: "dead-node", runId: "dead-run" })
  const res2 = await wt.runIsolatedNode({
    dir: c2.dir,
    spec: { nodeId: "dead-node", role: "coder", task: "do the thing in the ISOLATED git worktree", context: "", config: {}, provider: dead, maxSteps: 4, taskId: "t", runId: "dead-run", segmentId: "s" },
    timeoutMs: 60_000,
  })
  ok("dead provider → honest failed status", /^failed$/i.test(String(res2.status ?? "")) && Boolean(res2.error), JSON.stringify(res2).slice(0, 200))
  ok("failed shape matches the worker settlement contract", Array.isArray(res2.toolRecords) && res2.usage && res2.steps === 0)
  await wt.removeWorktree({ root: repo2, dir: c2.dir })
  srv.close()
}

// ---------------------------------------------------------------------------
console.log("== 8. meta integration: the isolated node runs, merges, completes ==")
{
  const meta = await import("../meta.js")
  // the same scripted mock (separate server so call counting is clean)
  const events = []
  const srv = http.createServer((req, res) => {
    let body = ""
    req.on("data", (d) => { body += d })
    req.on("end", () => {
      let j = {}
      try { j = JSON.parse(body) } catch {}
      const msgs = j.messages ?? []
      const lastTool = [...msgs].reverse().find((m) => m.role === "tool")
      const userText = msgs.filter((m) => m.role === "user").map((m) => String(m.content)).join(" ")
      const mkSse2 = (events2) => {
        res.writeHead(200, { "content-type": "text/event-stream" })
        let i = 0
        const tick = () => {
          if (i >= events2.length) { res.write("data: [DONE]\n\n"); res.end(); return }
          res.write(`data: ${JSON.stringify(events2[i++])}\n\n`)
          setTimeout(tick, 5)
        }
        tick()
      }
      const isoArgs = { path: "feat-a.js", content: "export const A = 41 + 1\n" }
      if (lastTool) {
        const content = "I created feat-a.js exporting the new constant A."
        const payload = { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }
        if (j.stream) return mkSse2([{ choices: [{ delta: { content }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }])
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify(payload))
      }
      if (/ISOLATED git worktree/.test(userText)) {
        const payload = { choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "call_iso", type: "function", function: { name: "write_file", arguments: JSON.stringify(isoArgs) } }] }, finish_reason: "tool_calls" }] }
        if (j.stream) return mkSse2([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_iso", type: "function", function: { name: "write_file", arguments: "" } }] }, finish_reason: null }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(isoArgs) } }] }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ])
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify(payload))
      }
      const content = "main loop done"
      const payload = { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }
      if (j.stream) return mkSse2([{ choices: [{ delta: { content }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }])
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const port = srv.address().port

  // the project: a REAL git repo in its own subdir (meta binds to process.cwd())
  const repo = gitRepo(path.join(WORK, "meta-repo"), { "seed.txt": "seed\n", "feat-b.js": "export const B = 1\n" })
  process.chdir(repo)
  eq("meta cwd is a git repo", wt.isolationAvailable({ root: repo, config: {} }).ok, true)

  // the injected main-loop agent: plan → JSON DAG with DECLARED targets.
  // The main loop picks the FIRST mutating ready node (main-n, feat-b.js);
  // the second disjoint mutating node (iso, feat-a.js) is dispatched to an
  // isolated worktree child that runs CONCURRENTLY with the main agent.
  const PLAN_JSON = JSON.stringify([
    { id: "main-n", objective: "Write feature file B (feature B)", targetFiles: ["feat-b.js"], role: "coder", risk: "low", read_only: false, verificationRequirements: ["syntax"] },
    { id: "iso", objective: "Write feature file A (feature A)", targetFiles: ["feat-a.js"], role: "coder", risk: "low", read_only: false, verificationRequirements: ["syntax"] },
  ])
  const fake = async (args) => {
    if (args.planOnly) return { text: PLAN_JSON, toolRecords: [], commandChecks: [], toolLog: [] }
    const task = String(args.task ?? "")
    if (/feature file B/.test(task) && !args.readOnly) {
      fs.writeFileSync(path.join(repo, "feat-b.js"), "export const B = 2\n")
      return {
        text: "feature B written", budgetHit: false, steps: 1,
        toolRecords: [{ tool: "write_file", files_changed: ["feat-b.js"] }],
        commandChecks: [
          { command: "node --check feat-b.js", exitCode: 0, passed: true, tail: "" },
          { command: "npm test -- feat-b.test.js", exitCode: 0, passed: true, tail: "1 passed" },
        ],
        toolLog: [{ name: "write_file" }],
      }
    }
    return { text: "done", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] }
  }

  const provider = { name: "mock", label: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test-key", model: "mock-mini", contextWindow: 128000, keyUrl: "" }
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const r = await meta.runMeta({
    config: cfg, provider, task: "Refactor the exporter across files, then implement feature A in feat-a.js and feature B in feat-b.js",
    runAgent: fake, workers: true, maxSegments: 6,
    signal: new AbortController().signal,
    onEvent: (e) => { try { events.push(e) } catch {} },
  })

  // the isolated node ran as a real child in a real worktree and merged back
  ok("WORKTREE_MODE announced", events.some((e) => e.type === "WORKTREE_MODE" && e.enabled === true))
  const created = events.filter((e) => e.type === "WORKTREE_CREATED")
  ok("WORKTREE_CREATED for the declared node", created.some((e) => e.nodeId === "iso"), JSON.stringify(created.map((e) => e.nodeId)))
  ok("worktree dir was real and under .forge/worktrees", created.every((e) => String(e.dir ?? "").includes(`${path.sep}.forge${path.sep}worktrees${path.sep}`)))
  const merged = events.find((e) => e.type === "WORKTREE_MERGED" && e.nodeId === "iso")
  ok("WORKTREE_MERGED reports the landed files", merged && (merged.files ?? []).includes(path.join(repo, "feat-a.js")), JSON.stringify(merged?.files))
  ok("the child's write is IN the shared tree (merged)", fs.readFileSync(path.join(repo, "feat-a.js"), "utf8") === "export const A = 41 + 1\n")
  ok("worktree removed after merge", !created.some((e) => fs.existsSync(e.dir)))
  ok("no WORKTREE_CONFLICT in the disjoint case", !events.some((e) => e.type === "WORKTREE_CONFLICT"), JSON.stringify(events.filter((e) => /WORKTREE_(CONFLICT|FAILED|UNAVAILABLE)/.test(e.type)).map((e) => ({ t: e.type, n: e.nodeId, r: e.reason, f: e.files }))))

  // node state: completed WITH ledger-backed verification (dag.js node
  // statuses are lowercase strings: "completed", "verifying", …)
  const nodes = r.task?.dag?.nodes ?? []
  const isoNode = nodes.find((n) => n.id === "iso")
  ok("iso node COMPLETED", isoNode?.status === "completed", JSON.stringify(isoNode?.status))
  ok("iso node completion is verification-backed", isoNode?.verificationSatisfied === true && Boolean(isoNode?.verificationId))
  const mainNode = nodes.find((n) => n.id === "main-n")
  ok("main node ran serialized (main loop)", ["completed", "execution_succeeded", "verifying", "repairing"].includes(mainNode?.status), JSON.stringify(mainNode?.status))
  ok("the main-loop write exists too", fs.existsSync(path.join(repo, "feat-b.js")))
  // the worktree merge left ledger evidence
  ok("merge evidence is in the verification ledger", (r.task?.verification_results ?? []).some((v) => String(v.command ?? "").startsWith("worktree-merge:") || String(v.verification_id ?? "").startsWith("ver-worktree-")))
  ok("task ended honestly (terminal or waiting, never a fake)", r.status !== "RUNNING")
  srv.close()
}

// ---------------------------------------------------------------------------
console.log("== 9. dedup: worktreewise adds NO tool/skill surface ==")
{
  const toolsSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "tools.js"), "utf8")
  ok("no worktree agent tool was added (kernel policy, not a tool)", !/name:\s*["']worktree/.test(toolsSrc))
  const capsSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "capabilities.js"), "utf8")
  ok("no worktree capability was registered (the wire stays 1:1)", !/name:\s*["']worktree/i.test(capsSrc))
}

// ---------------------------------------------------------------------------
console.log(`\n${PASS} passed, ${FAIL} failed`)
process.exit(FAIL ? 1 : 0)
