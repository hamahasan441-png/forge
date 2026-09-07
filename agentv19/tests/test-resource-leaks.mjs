#!/usr/bin/env node
/**
 * forge — P1 resource leaks.
 *
 * A long-running agent must not accumulate timers, sockets, child processes or
 * in-memory workers. Defects found and fixed here:
 *   - the DAG fan-out raced the worker promises against a 4s setTimeout that
 *     was never cleared — every segment kept the process alive for 4 extra
 *     seconds
 *   - a timed-out worker's late result could be reported as a success
 *   - worker records were never reaped
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-leak-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-leak-work-"))
process.chdir(WORK)

const meta = await import("../forge/meta.js")
const { createAgentManager } = await import("../forge/agentmanager.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }

console.log("== a completed run leaves no pending timer keeping node alive ==")
{
  const fake = async (args) => {
    if (args.planOnly) return { text: "1. investigate a\n2. implement a", toolRecords: [], commandChecks: [], toolLog: [] }
    return { text: "done", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] }
  }
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const t0 = Date.now()
  const r = await meta.runMeta({
    config: cfg, provider: { name: "x", model: "m" }, task: "check for leaks",
    runAgent: fake, workers: true, maxSegments: 6, signal: new AbortController().signal,
  })
  const work = Date.now() - t0
  ok(`the run itself is fast (${work}ms)`, work < 4000)
  // if any timer were still pending, this would not be reached without a delay
  const handles = process._getActiveHandles ? process._getActiveHandles().length : 0
  const reqs = process._getActiveRequests ? process._getActiveRequests().length : 0
  ok(`no unexpected active handles (${handles})`, handles < 20)
  ok(`no unexpected active requests (${reqs})`, reqs < 20)
  ok("the task finished", ["COMPLETED", "WAITING", "FAILED"].includes(r.status))
}

console.log("== no timer is left holding the event loop open ==")
{
  const info = (process.getActiveResourcesInfo?.() ?? []).filter((x) => x !== "Pipe" && x !== "TTY" && x !== "FSReqCallback")
  const timeouts = info.filter((x) => x === "Timeout")
  ok(`no pending Timeout handles (${JSON.stringify(info)})`, timeouts.length === 0)
  // and a completed run really would let node exit: drain check via a child
  // The probe is written to a temp dir, so it must reach the module by a path
  // that is resolved HERE (the checkout can live anywhere — CI puts it under
  // /home/runner/work/...). A file:// URL is importable and location-proof.
  const metaUrl = new URL("../forge/meta.js", import.meta.url).href
  const probe = `
import { runMeta } from "${metaUrl}"
const fake = async (a) => a.planOnly
  ? { text: "1. investigate a\\n2. implement a", toolRecords: [], commandChecks: [], toolLog: [] }
  : { text: "done", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] }
const t0 = Date.now()
await runMeta({ config: { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} },
  provider: { name: "x", model: "m" }, task: "drain probe", runAgent: fake, workers: true, maxSegments: 6 })
process.stdout.write(String(Date.now() - t0))
`
  const probePath = path.join(HOME, "drain-probe.mjs")
  fs.writeFileSync(probePath, probe)
  const t0 = Date.now()
  let out = ""
  try {
    out = execFileSync(process.execPath, [probePath], { encoding: "utf8", cwd: WORK, env: { ...process.env, FORGE_HOME: HOME }, timeout: 30000 })
  } catch (e) { out = `FAILED: ${e.message}` }
  const wall = Date.now() - t0
  const inner = Number(String(out).trim().split(/\s+/).pop()) || 0
  ok(`the child process exited on its own (wall ${wall}ms, work ${inner}ms)`, !/FAILED/.test(out) && wall < 15000)
  ok(`the child did not linger after finishing (wall - work = ${wall - inner}ms)`, wall - inner < 5000)
}

console.log("== worker records are reaped, not accumulated ==")
{
  const m = createAgentManager({
    maxWorkers: 4, defaultTimeoutMs: 1000, maxRecords: 3,
    runner: async () => "ok",
  })
  for (let i = 0; i < 25; i++) await m.spawn({ role: "researcher", task: `t${i}`, nodeId: `n${i}` }).promise
  const st = m.stats()
  ok(`completed workers are capped (${st.total} records)`, st.total <= 6)
  ok("none are active", st.active === 0)
  ok("none are live", st.live === 0)
}

console.log("== a cancelled worker releases its slot immediately ==")
{
  const starts = []
  const m = createAgentManager({
    maxWorkers: 1, defaultTimeoutMs: 5000,
    runner: async ({ signal, nodeId }) => {
      starts.push({ nodeId, at: Date.now() })
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 3000)
        signal?.addEventListener?.("abort", () => { clearTimeout(t); resolve() }, { once: true })
      })
      return "ok"
    },
  })
  const a = m.spawn({ role: "researcher", task: "a", nodeId: "n1" })
  await new Promise((r) => setTimeout(r, 60))
  const t0 = Date.now()
  ok("cancel was accepted", m.cancel(a.id) === true)
  await a.promise
  const cancelledAt = Date.now() - t0
  ok(`the cancelled worker stopped promptly (${cancelledAt}ms)`, cancelledAt < 500)
  eq("its status is cancelled", a.status, "cancelled")
  const b = m.spawn({ role: "researcher", task: "b", nodeId: "n2" })
  await new Promise((r) => setTimeout(r, 200))
  ok("the next worker STARTED immediately (slot was released)", starts.some((s) => s.nodeId === "n2"))
  await b.promise
  eq("pool idle", m.stats().active, 0)
}

console.log("== repeated runs do not grow memory without bound ==")
{
  const fake = async (args) => {
    if (args.planOnly) return { text: "1. a\n2. b", toolRecords: [], commandChecks: [], toolLog: [] }
    return { text: "done", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] }
  }
  const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  const before = process.memoryUsage().heapUsed
  for (let i = 0; i < 5; i++) {
    await meta.runMeta({
      config: cfg, provider: { name: "x", model: "m" }, task: `run ${i}`,
      runAgent: fake, workers: false, maxSegments: 3, signal: new AbortController().signal,
    })
  }
  if (global.gc) global.gc()
  const after = process.memoryUsage().heapUsed
  const growthMb = (after - before) / 1024 / 1024
  ok(`5 runs grew the heap by only ${growthMb.toFixed(1)}MB`, growthMb < 60)
}

function eq(name, got, want) { ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want)) }

console.log(`\n== resource-leaks suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
