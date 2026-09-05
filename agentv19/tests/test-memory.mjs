#!/usr/bin/env node
/**
 * forge — memory hygiene unit checks (v20.2).
 * Covers dedup-on-append, prune cap, forget-by-index (LEARNING blocks kept
 * intact), clear, and entry parsing. Isolated FORGE_HOME, zero network.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mem-"))
process.env.FORGE_HOME = HOME // config.js resolves DEFAULT_DIR from this at import

const {
  appendMemory, memoryEntries, forgetMemory, clearMemory, pruneMemory,
  recordLearning, MEMORY_MAX_ENTRIES,
} = await import("../forge/memory.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want))
const cwd = process.cwd()

console.log("== memory: dedup ==")
appendMemory("global", "prefer tabs")
const d = appendMemory("global", "prefer tabs")
ok("second identical append is deduped", d.deduped === true)
eq("only one entry stored", memoryEntries("global", cwd).length, 1)

console.log("== memory: redaction on append ==")
appendMemory("global", "token is sk-abcdef1234567890abcdef1234567890")
const red = memoryEntries("global", cwd).map((e) => e.text).join("\n")
ok("secret redacted in stored memory", !/sk-abcdef1234567890/.test(red))

console.log("== memory: forget by index ==")
clearMemory("global", cwd)
appendMemory("global", "one"); appendMemory("global", "two"); appendMemory("global", "three")
const f = forgetMemory("global", 2, cwd)
ok("forget returns removed text", /two/.test(String(f.removed)))
eq("forget removed the middle entry", memoryEntries("global", cwd).map((e) => e.text), ["one", "three"])
ok("forget out-of-range errors", forgetMemory("global", 99, cwd).ok === false)

console.log("== memory: LEARNING blocks stay intact ==")
clearMemory("project", cwd)
recordLearning({ problem: "flaky test", rootCause: "shared port", fix: "use random port" }, cwd)
appendMemory("project", "a bullet note", cwd)
const pe = memoryEntries("project", cwd)
eq("learning + bullet = 2 entries", pe.length, 2)
ok("learning entry kept as one multi-line block", /LEARNING:/.test(pe[0].text) && /fix:/.test(pe[0].text))
forgetMemory("project", 1, cwd) // remove the whole learning block
const pe2 = memoryEntries("project", cwd)
eq("forgetting a learning block leaves only the bullet", pe2.map((e) => e.text), ["a bullet note"])

console.log("== memory: prune cap ==")
clearMemory("global", cwd)
for (let i = 0; i < MEMORY_MAX_ENTRIES + 25; i++) appendMemory("global", "note-" + i)
const after = memoryEntries("global", cwd)
ok("append auto-prunes to the cap", after.length === MEMORY_MAX_ENTRIES)
ok("prune keeps the newest entries", after[after.length - 1].text === "note-" + (MEMORY_MAX_ENTRIES + 24))
ok("prune drops the oldest entries", !after.some((e) => e.text === "note-0"))

console.log("== memory: clear ==")
const c = clearMemory("global", cwd)
ok("clear reports a count", typeof c.removed === "number")
eq("clear empties the tier", memoryEntries("global", cwd).length, 0)

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
console.log(`\n== memory suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
