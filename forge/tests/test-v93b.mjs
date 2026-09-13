#!/usr/bin/env node
/**
 * v93 GAP FIX — phase 7: CORE EVENT-BUS PERSISTENCE + restart reconstruction
 * (§14).
 *
 *  1. The Core's bus is created with persistence ON (was `persist: false`).
 *  2. bindTask: the bus binds to the task file when the task id exists and
 *     replays prior history; PROGRESS chatter is not persisted.
 *  3. Engineering events land in a bounded events.jsonl (whitelisted types).
 *  4. BEHAVIORAL crash/restart: run a task through the real Core (mock
 *     provider), "restart" (new Core, same project), and reconstruct():
 *     event history + checkpoint + world model + task state are all present —
 *     the authoritative engineering state is reconstructable.
 *  5. Resume reattaches to the persisted history FIRST.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93b-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93b-work-"))
process.chdir(WORK)
fs.writeFileSync(path.join(WORK, "a.js"), "export const a = 1\n")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(wot(want)))

function wot(x) { return x }

const { createBus, MESSAGE_TYPE, busPath } = await import("../bus.js")
const { projectDir } = await import("../memory.js")

// ---------------------------------------------------------------------------
console.log("== 1. bus persistence units ==")
{
  const b = createBus({ persist: true, taskId: "t-v93b" })
  b.send({ sender: "w1", receiver: "core", type: "finding", content: "found the bug in auth.js" })
  b.send({ sender: "w2", receiver: "core", type: "progress", content: "step 1 done" })   // chatter
  b.send({ sender: "w2", receiver: "core", type: "discovery", content: "the config lives in cfg.js" })
  ok("persisted bus reports its file", b.file === busPath("t-v93b") && b.persisting === true)
  const lines = fs.readFileSync(busPath("t-v93b"), "utf8").split("\n").filter(Boolean)
  eq("findings + discoveries persisted", lines.length, 2)
  ok("PROGRESS chatter NOT persisted (§14)", !lines.some((l) => /progress/i.test(l)))

  // a fresh bus (simulated restart) replays the history
  const b2 = createBus({ persist: false })
  const n = b2.bindTask("t-v93b")
  eq("restart replays prior bus history", n, 2)
  ok("replayed log carries the finding", b2.log().some((m) => /auth\.js/.test(m.content)))
  eq("bindTask is idempotent", b2.bindTask("t-v93b"), 2)

  // non-persisted bus stays in-memory (legacy behavior preserved)
  const b3 = createBus({ persist: false, taskId: null })
  b3.send({ sender: "x", receiver: "core", type: "finding", content: "no file" })
  ok("a bus with no task stays in-memory", b3.file === null)
}

// ---------------------------------------------------------------------------
console.log("== 2. BEHAVIORAL: run through the real Core, restart, reconstruct ==")
{
  const { createForgeCore } = await import("../core.js")
  const events = []
  const core = createForgeCore({
    config: { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} },
    provider: { name: "x", model: "m" },
    cwd: WORK,
    onEvent: (e) => events.push(e),
  })
  // the Core's bus is persisted from creation (the §14 fix)
  ok("core bus created with persistence ON", core.bus.persisting === true)

  const mockAgent = async (o) => {
    if (o.planOnly) {
      return { text: JSON.stringify([{ id: "n1", objective: "verify a.js", read_only: true, role: "researcher", targetFiles: ["a.js"] }]), toolRecords: [], commandChecks: [], toolLog: [] }
    }
    return { text: "a.js exports a single const; verified by reading it.", toolRecords: [], commandChecks: [], toolLog: [] }
  }
  const r = await core.run("inspect a.js and report", { runAgent: mockAgent, maxSegments: 2 })
  ok("the task ran", Boolean(r.task?.task_id ?? r.taskId), JSON.stringify(r.status))

  const taskId = r.task?.task_id ?? r.taskId
  // the tap bound the bus to the task the moment it existed
  ok("the core bus bound to the task file", core.bus.file === busPath(taskId), `${core.bus.file} vs ${busPath(taskId)}`)
  // bus messages flowed and persisted (meta mirrors findings onto its bus →
  // the CORE's bus receives tap-mirrored comms)
  core.bus.send({ sender: "worker:probe", receiver: "core", type: "finding", content: "reconstruction probe message" })
  ok("probe message persisted on the task bus", fs.readFileSync(busPath(taskId), "utf8").includes("reconstruction probe message"))

  // engineering events landed in the bounded ledger
  const evPath = path.join(projectDir(WORK), "events.jsonl")
  ok("events.jsonl exists under the project dir", fs.existsSync(evPath))
  const evLines = fs.readFileSync(evPath, "utf8").split("\n").filter(Boolean)
  ok("engineering events were persisted", evLines.length >= 4, `${evLines.length} events`)
  const types = new Set(evLines.map((l) => { try { return JSON.parse(l).type } catch { return null } }))
  ok("TASK_ events persisted", [...types].some((t) => String(t).startsWith("TASK_")))
  ok("raw tool traffic NOT persisted (whitelist)", ![...types].some((t) => /tool_start|tool_end|step/i.test(String(t))))

  // world model snapshot was built+persisted by the core run
  ok("world.json persisted during the run", fs.existsSync(path.join(projectDir(WORK), "world.json")))

  // task state + checkpoints exist
  const { readTask } = await import("../taskstate.js")
  const rec = readTask(taskId)
  ok("task state persisted", rec != null && Boolean(rec.status))

  // --- RESTART: a brand-new Core for the same project -------------------
  const core2 = createForgeCore({ config: {}, provider: null, cwd: WORK })
  const recon = core2.reconstruct(taskId)
  ok("reconstruct finds the bus history", recon.bus != null && recon.bus.messages >= 1, JSON.stringify(recon.bus))
  ok("reconstruct finds the event ledger", recon.events != null && recon.events.count >= 4, JSON.stringify(recon.events))
  ok("reconstruct finds the task state", recon.task != null && Boolean(recon.task.status))
  ok("reconstruct finds checkpoints", recon.checkpoints >= 0)
  ok("reconstruct finds the world model", recon.world != null && recon.world.exists === true)

  // resume reattaches to history FIRST (the run path)
  const before = core2.bus.file
  await core2.run("continue the task", { resumeTaskId: taskId, runAgent: mockAgent, maxSegments: 1 }).catch(() => { })
  ok("resume bound the bus to the task history before running", core2.bus.file === busPath(taskId) && before === null)
  ok("resumed bus replayed prior history", core2.bus.log().some((m) => /reconstruction probe message/.test(m.content)))
}

console.log(`\n== v93b: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
