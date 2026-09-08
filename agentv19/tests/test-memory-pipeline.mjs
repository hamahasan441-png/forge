#!/usr/bin/env node
/**
 * forge — memory storage pipeline + provenance (v21.1 P1/P2).
 *  - every entry carries a provenance comment (source / at / run)
 *  - provenance is never injected into prompts nor scored
 *  - legacy files (no comments) read unchanged
 *  - writes are atomic: no temp files left, mode 0600, a crash mid-write
 *    (simulated by failing rename) leaves the previous content intact
 *  - concurrent writers never interleave / corrupt the file
 *  - a symlinked memory file is honoured (written through), a directory or
 *    device at the path is refused
 *  - the memory TOOL's replace/append/learn all go through the same pipeline
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mempipe-"))
process.env.FORGE_HOME = HOME
const WORK = path.join(HOME, "work"); fs.mkdirSync(WORK)

const mem = await import("../forge/memory.js")
const { appendMemory, memoryEntries, forgetMemory, clearMemory, recordLearning, replaceMemory, relevantMemory, parseProvenance, formatProvenance, memoryPathFor, writeMemoryFile, parseLearnings } = mem

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 200) : ""}`) } }

console.log("== provenance ==")
{
  clearMemory("global", WORK)
  appendMemory("global", "prefer tabs", WORK, { source: "cli" })
  appendMemory("global", "uses pnpm", WORK, { source: "tool", runId: "run-42" })
  appendMemory("global", "no provenance given", WORK)
  const es = memoryEntries("global", WORK)
  ok("three entries", es.length === 3)
  ok("cli provenance parsed", es[0].provenance?.source === "cli" && !Number.isNaN(Date.parse(es[0].provenance.at)))
  ok("tool provenance with run id", es[1].provenance?.source === "tool" && es[1].provenance.runId === "run-42")
  ok("missing provenance → source=unknown (never silently trusted)", es[2].provenance?.source === "unknown")
  const raw = fs.readFileSync(memoryPathFor("global", WORK), "utf8")
  ok("comment line precedes each bullet", (raw.match(/<!-- forge: source=/g) ?? []).length === 3)
  ok("bad source is normalised", parseProvenance(formatProvenance({ source: "evil" })).source === "unknown")
  ok("garbage in comment is ignored", parseProvenance("<!-- forge: at=notadate run=r1 -->").at === null)
  ok("unrelated html comment is not provenance", parseProvenance("<!-- hello -->") === null)
  const injected = relevantMemory("tabs pnpm", { cwd: WORK })
  ok("provenance never reaches the prompt", /prefer tabs/.test(injected) && !/forge:/.test(injected) && !/source=/.test(injected))
  forgetMemory("global", 2, WORK)
  const after = memoryEntries("global", WORK)
  ok("forget removes the entry AND its provenance line", after.length === 2 && after.map((e) => e.text).join() === "prefer tabs,no provenance given" && !fs.readFileSync(memoryPathFor("global", WORK), "utf8").includes("run-42"))
}

console.log("== legacy files ==")
{
  const f = memoryPathFor("project", WORK)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, "- old note\nLEARNING: flaky\n  root-cause: port\n  fix: random port\n- another\n")
  const es = memoryEntries("project", WORK)
  ok("legacy entries parse unchanged", es.length === 3 && es[1].text.startsWith("LEARNING:") && es.every((e) => e.provenance === null))
  ok("legacy learnings still retrievable", parseLearnings(WORK).length === 1)
  recordLearning({ problem: "p", rootCause: "r", fix: "f" }, WORK, { source: "repair", runId: "r9" })
  const es2 = memoryEntries("project", WORK)
  ok("new learning appended with provenance, old ones untouched", es2.length === 4 && es2[3].provenance?.source === "repair" && es2[0].provenance === null)
  ok("learning block is one entry with its comment", es2[3].lines.length === 4 && /forge:/.test(es2[3].lines[0]))
}

console.log("== atomicity ==")
{
  const f = memoryPathFor("global", WORK)
  const dir = path.dirname(f)
  const st = fs.statSync(f)
  ok("memory file mode 0600", (st.mode & 0o777) === 0o600, (st.mode & 0o777).toString(8))
  ok("no temp files left behind", !fs.readdirSync(dir).some((n) => /\.tmp$/.test(n)))
  const before = fs.readFileSync(f, "utf8")
  const realRename = fs.renameSync
  fs.renameSync = () => { throw new Error("EIO simulated crash") }
  let r
  try { r = appendMemory("global", "will not land", WORK, { source: "cli" }) } finally { fs.renameSync = realRename }
  ok("failed write reports an error", r.ok === false && /EIO/.test(r.error))
  ok("previous content intact after a failed write", fs.readFileSync(f, "utf8") === before)
  ok("temp file cleaned up after failure", !fs.readdirSync(dir).some((n) => /\.tmp$/.test(n)))
  ok("replaceMemory goes through the same pipeline", replaceMemory("global", "- fresh", WORK, { source: "cli" }).ok && memoryEntries("global", WORK).length === 1 && (fs.statSync(f).mode & 0o777) === 0o600)
  ok("replaceMemory redacts", replaceMemory("global", "- token sk-abcdef1234567890abcdef1234567890", WORK).ok && !fs.readFileSync(f, "utf8").includes("sk-abcdef1234567890"))
}

console.log("== concurrent writers ==")
{
  clearMemory("global", WORK)
  const script = `
    process.env.FORGE_HOME = ${JSON.stringify(HOME)}
    const { appendMemory } = await import(${JSON.stringify(new URL("../forge/memory.js", import.meta.url).href)})
    const w = process.argv[1]
    for (let i = 0; i < 25; i++) appendMemory("global", "w" + w + "-" + i, ${JSON.stringify(WORK)}, { source: "tool", runId: "w" + w })
  `
  const procs = []
  for (let w = 0; w < 4; w++) procs.push(import("node:child_process").then((cp) => new Promise((res) => { const p = cp.spawn(process.execPath, ["--input-type=module", "-e", script, String(w)], { stdio: "inherit" }); p.on("exit", res) })))
  await Promise.all(procs)
  const raw = fs.readFileSync(memoryPathFor("global", WORK), "utf8")
  const lines = raw.split("\n").filter(Boolean)
  const bullets = lines.filter((l) => l.startsWith("- "))
  const comments = lines.filter((l) => l.startsWith("<!-- forge:"))
  const wellFormed = lines.every((l) => /^- w\d-\d+$/.test(l) || /^<!-- forge: source=tool at=\S+ run=w\d -->$/.test(l))
  ok("file is never corrupted by concurrent writers (every line well-formed)", wellFormed, lines.filter((l) => !(/^- w\d-\d+$/.test(l) || /^<!-- forge: /.test(l))).slice(0, 3).join(" | "))
  ok("every bullet has exactly one provenance line", bullets.length === comments.length)
  ok("entries parse cleanly", memoryEntries("global", WORK).every((e) => e.provenance?.source === "tool"))
  ok("NO append is lost: 4 processes × 25 appends = 100 entries (lock serialises writers)", bullets.length === 100, `${bullets.length}/100`)
  ok("lock file released", !fs.existsSync(memoryPathFor("global", WORK).replace(/memory\.md$/, ".memory.md.lock")))
  console.log(`       (${bullets.length} of 100 appends persisted)`)
}

console.log("== stale lock recovery ==")
{
  const f = memoryPathFor("global", WORK)
  const lock = path.join(path.dirname(f), ".memory.md.lock")
  fs.writeFileSync(lock, "999999 0") // dead owner, ancient
  const t0 = Date.now()
  const r = appendMemory("global", "after stale lock", WORK, { source: "cli" })
  ok("stale lock from a dead process is broken and the write proceeds", r.ok && Date.now() - t0 < 1000)
  fs.writeFileSync(lock, `${process.pid} ${Date.now()}`) // live owner (us) — but not held via withMemoryLock
  const t1 = Date.now()
  const r2 = appendMemory("global", "blocked?", WORK, { source: "cli" })
  ok("a live foreign lock is respected until timeout, then errors instead of corrupting", r2.ok === false && /locked/.test(r2.error) && Date.now() - t1 >= 2500)
  fs.unlinkSync(lock)
}

console.log("== symlinks and non-files ==")
{
  const f = memoryPathFor("global", WORK)
  fs.rmSync(f, { force: true })
  const real = path.join(HOME, "real-memory.md")
  fs.writeFileSync(real, "- via link\n")
  fs.symlinkSync(real, f)
  const r = appendMemory("global", "through the link", WORK, { source: "cli" })
  ok("user symlink honoured: write lands in the real file", r.ok && fs.readFileSync(real, "utf8").includes("through the link"))
  ok("the symlink itself is preserved", fs.lstatSync(f).isSymbolicLink())
  fs.unlinkSync(f)
  fs.mkdirSync(f)
  const r2 = appendMemory("global", "into a dir?", WORK)
  ok("directory at the memory path is refused", r2.ok === false && /not a regular file/.test(r2.error))
  fs.rmdirSync(f)
  let threw = null
  try { writeMemoryFile(path.join(HOME, "fifo-or-dev"), "x"); fs.rmSync(path.join(HOME, "fifo-or-dev")) } catch (e) { threw = e }
  ok("plain absent path writes fine", threw === null)
}

console.log("== memory tool uses the pipeline ==")
{
  const { makeToolContext } = await import("../forge/tools.js")
  const memoryPath = path.join(HOME, "tool-global.md")
  const tools = makeToolContext({ cwd: WORK, memoryPath, todoPath: path.join(HOME, "todo.json"), runId: "run-tool-1" })
  const a = await tools.exec("memory", { action: "append", scope: "project", text: "tool note" })
  ok("tool append ok", /^OK/.test(a), a)
  const pe = memoryEntries("project", WORK)
  ok("tool append carries source=tool + run id", pe.at(-1).provenance?.source === "tool" && pe.at(-1).provenance.runId === "run-tool-1")
  const rep = await tools.exec("memory", { action: "replace", text: "- replaced body\nkey sk-abcdef1234567890abcdef1234567890" })
  ok("tool replace ok", /^OK memory replaced/.test(rep), rep)
  const raw = fs.readFileSync(memoryPath, "utf8")
  ok("replace is redacted + provenance-tagged + 0600", !raw.includes("sk-abcdef1234567890") && /source=tool/.test(raw) && (fs.statSync(memoryPath).mode & 0o777) === 0o600)
  const l = await tools.exec("memory", { action: "learn", problem: "p", root_cause: "rc", fix: "fx" })
  ok("tool learn ok", /^OK recorded learning/.test(l), l)
  ok("learn carries provenance", memoryEntries("project", WORK).at(-1).provenance?.runId === "run-tool-1")
  const ro = makeToolContext({ cwd: WORK, memoryPath, todoPath: path.join(HOME, "todo.json"), readOnly: true })
  ok("read-only context still blocks mutation", /^BLOCKED/.test(await ro.exec("memory", { action: "append", text: "x" })))
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
console.log(`\n== memory-pipeline suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
