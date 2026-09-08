#!/usr/bin/env node
/**
 * forge — agent context compaction (v21.1 P1).
 * Pins: structure is never broken (tool_calls ↔ tool results stay paired),
 * errors / exit markers survive shrinking, the fact ledger is deterministic
 * and complete without a model, a failed summary still yields a SMALLER
 * well-formed history, and a fuzz over random histories never produces a
 * malformed or larger result.
 */
import { compactHistory, splitTurns, historyIsWellFormed, shrinkToolOutput, extractLedger, renderLedger } from "../forge/compaction.js"
import { estimateTokens } from "../forge/ui.js"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 200) : ""}`) } }

let idc = 0
const call = (name, args) => ({ id: `c${++idc}`, type: "function", function: { name, arguments: JSON.stringify(args) } })
const turn = (calls, results, text = "") => {
  const a = { role: "assistant", content: text, tool_calls: calls }
  return [a, ...calls.map((c, i) => ({ role: "tool", tool_call_id: c.id, content: results[i] }))]
}
const bigOut = (n, tailLine) => Array.from({ length: n }, (_, i) => `line ${i} of some long output that pads the context nicely`).join("\n") + "\n" + tailLine
const history = () => {
  idc = 0
  const msgs = [{ role: "system", content: "SYS" }, { role: "user", content: "fix the tests" }]
  msgs.push(...turn([call("read_file", { path: "src/a.js" })], [bigOut(400, "end of file")]))
  msgs.push(...turn([call("write_file", { path: "src/a.js", content: "x" })], ["OK wrote src/a.js (12 bytes, replaced)"]))
  msgs.push(...turn([call("bash", { command: "npm test" })], [bigOut(500, "3 tests failed\n[exit code: 1]")]))
  msgs.push(...turn([call("edit_file", { path: "src/b.js" }), call("bash", { command: "rm -rf /" })], ["OK edited src/b.js", "BLOCKED for safety: rm -rf / is catastrophic"]))
  msgs.push({ role: "assistant", content: "The failure is in the date parser; I'll fix b.js next." })
  msgs.push(...turn([call("bash", { command: "npm test" })], [bigOut(300, "all 12 tests passed")]))
  msgs.push(...turn([call("read_file", { path: "src/c.js" })], [bigOut(200, "eof")]))
  return msgs
}

console.log("== structure ==")
{
  const h = history()
  ok("fixture is well-formed", historyIsWellFormed(h))
  const { head, turns } = splitTurns(h)
  ok("head = system + first user", head.length === 2 && head[0].role === "system" && head[1].role === "user")
  ok("every tool result sits in the turn of its assistant", turns.every((t) => t.msgs.filter((m) => m.role === "tool").every((m) => t.ids.has(m.tool_call_id))))
  ok("a two-call turn is one unit", turns.some((t) => t.msgs.length === 3))
  const broken = [...h.slice(0, 3)] // assistant with tool_calls but no result
  ok("detects dangling tool_calls", !historyIsWellFormed(broken))
  ok("detects orphan tool result", !historyIsWellFormed([{ role: "tool", tool_call_id: "zz", content: "x" }]))
}

console.log("== shrinkToolOutput keeps meaning ==")
{
  const s = shrinkToolOutput(bigOut(500, "3 tests failed\n[exit code: 1]"), 1200)
  ok("bounded", s.length <= 1300, s.length)
  ok("exit marker survives", /\[exit code: 1\]/.test(s))
  ok("failure line survives", /3 tests failed/.test(s))
  ok("first lines survive", /line 0 of/.test(s))
  ok("says it was shrunk", /shrunk from/.test(s))
  const e = shrinkToolOutput(["start", ...Array(300).fill("noise noise noise noise noise noise noise"), "TypeError: x is not a function", ...Array(300).fill("noise"), "done"].join("\n"), 1000)
  ok("error line in the middle survives", /TypeError: x is not a function/.test(e))
  const one = shrinkToolOutput("x".repeat(5000), 800)
  ok("single huge line: head+tail kept, bounded", one.length < 950 && one.startsWith("xxx") && /omitted/.test(one))
  ok("small output untouched", shrinkToolOutput("short", 100) === "short")
}

console.log("== deterministic ledger ==")
{
  const { turns } = splitTurns(history())
  const l = extractLedger(turns)
  ok("files written/edited recorded", l.files.get("src/a.js") === "edited" && l.files.get("src/b.js") === "edited")
  ok("commands with exit codes recorded", l.commands.length === 3 && l.commands[0].exitCode === 1 && l.commands[1].exitCode === null && l.commands[2].exitCode === 0)
  ok("failed command keeps its tail", /3 tests failed/.test(l.commands[0].tail))
  ok("blocked action recorded", l.blocked.length === 1 && /rm -rf/.test(l.blocked[0]))
  ok("decision text recorded", l.decisions.some((d) => /date parser/.test(d)))
  const text = renderLedger(l)
  ok("rendered ledger names files, commands, blocked", /FILES CHANGED/.test(text) && /src\/a\.js/.test(text) && /exit 1: npm test/.test(text) && /BLOCKED ACTIONS/.test(text))
}

console.log("== compaction stages ==")
{
  const h = history()
  const before = estimateTokens(JSON.stringify(h))
  // window chosen so the fixture is above 40 % (shrink) but below 55 % (fold)
  const r1 = await compactHistory(h, { window: Math.floor(before / 0.45) })
  ok("stage 1 shrinks old tool outputs", r1.changed && r1.stats.stage === "shrink" && r1.stats.shrunk > 0)
  ok("stage 1 keeps every message", r1.messages.length === h.length)
  ok("stage 1 result well-formed", historyIsWellFormed(r1.messages))
  ok("stage 1 keeps the last turns verbatim", r1.messages[r1.messages.length - 1].content === h[h.length - 1].content)
  ok("stage 1 preserved the exit marker in the shrunk npm test output", r1.messages.some((m) => m.role === "tool" && /shrunk from/.test(m.content) && /\[exit code: 1\]/.test(m.content)))

  let digestSeen = ""
  const r2 = await compactHistory(h, { window: Math.floor(before / 0.9), force: true, summarize: async (d) => { digestSeen = d; return "Narrative: parser bug found and fixed." } })
  ok("stage 2 folds old turns", r2.changed && /fold\+summary/.test(r2.stats.stage) && r2.stats.folded > 0)
  ok("stage 2 result well-formed", historyIsWellFormed(r2.messages), JSON.stringify(r2.messages.map((m) => m.role)))
  ok("stage 2 is smaller", estimateTokens(JSON.stringify(r2.messages)) < before)
  const summary = r2.messages[2]
  ok("summary message follows the head", summary.role === "user" && /CONTEXT COMPACTED/.test(summary.content))
  ok("summary carries the ledger facts", /src\/a\.js/.test(summary.content) && /exit 1: npm test/.test(summary.content) && /BLOCKED/.test(summary.content))
  ok("summary carries the narrative", /Narrative: parser bug/.test(summary.content))
  ok("digest given to the model keeps error tails, not just heads", /3 tests failed/.test(digestSeen))
  ok("the tail turns are intact", r2.messages.slice(3).every((m) => h.includes(m) || m.role !== "user"))

  const r3 = await compactHistory(h, { window: Math.floor(before / 0.9), force: true, summarize: async () => { throw new Error("provider down") } })
  ok("failed summary still compacts (ledger only)", r3.changed && r3.stats.stage.startsWith("fold") && !r3.stats.summarized)
  ok("failed summary still smaller + well-formed", estimateTokens(JSON.stringify(r3.messages)) < before && historyIsWellFormed(r3.messages))
  ok("ledger present without a model", /FILES CHANGED/.test(r3.messages[2].content))

  const r4 = await compactHistory(h, { window: 128000 })
  ok("below threshold → untouched", !r4.changed && r4.messages === h)
  const r5 = await compactHistory(h, { window: 128000, force: true })
  ok("force → compacts even when small", r5.changed && historyIsWellFormed(r5.messages) && estimateTokens(JSON.stringify(r5.messages)) < before)
  // a genuinely oversized history (many large old outputs) with a window it cannot fit: fold happens WITHOUT force
  const long = history()
  for (let i = 0; i < 6; i++) long.push(...turn([call("bash", { command: `npm test -- part${i}` })], [bigOut(400, `part${i} failed\n[exit code: 1]`)]))
  const r7 = await compactHistory(long, { window: 2500 })
  ok("oversized history folds without force", r7.changed && r7.stats.stage.startsWith("fold") && historyIsWellFormed(r7.messages) && /exit 1: npm test -- part0/.test(r7.messages[2].content))

  // only a couple of turns: fold has nothing old enough → tail is tightened, never a no-op
  const short = [...h.slice(0, 2), ...turn([call("bash", { command: "cat big" })], [bigOut(2000, "[exit code: 2]")])]
  const r6 = await compactHistory(short, { window: 1000, force: true })
  ok("tiny history under pressure still shrinks the tail and stays well-formed", r6.changed && historyIsWellFormed(r6.messages) && estimateTokens(JSON.stringify(r6.messages)) < estimateTokens(JSON.stringify(short)) && /\[exit code: 2\]/.test(r6.messages.at(-1).content))
}

console.log("== fuzz: random histories never become malformed or larger ==")
{
  let seed = 1234567
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  let bad = 0
  for (let iter = 0; iter < 200; iter++) {
    idc = 0
    const msgs = [{ role: "system", content: "S" }, { role: "user", content: "task " + iter }]
    const n = 1 + Math.floor(rnd() * 12)
    for (let k = 0; k < n; k++) {
      const kind = rnd()
      if (kind < 0.15) { msgs.push({ role: "assistant", content: "thinking " + k }); continue }
      if (kind < 0.25) { msgs.push({ role: "user", content: "(system) note " + k }); continue }
      const nc = 1 + Math.floor(rnd() * 3)
      const calls = [], results = []
      for (let c = 0; c < nc; c++) {
        const tool = pick(["bash", "read_file", "write_file", "edit_file", "grep_files"])
        calls.push(call(tool, tool === "bash" ? { command: pick(["npm test", "ls", "rm -rf /"]) } : { path: `f${c}.js` }))
        const len = Math.floor(rnd() * 6000)
        results.push(pick(["OK wrote f.js", "ERROR: no such file", "BLOCKED for safety: x", bigOut(len / 50, pick(["[exit code: 1]", "done", "Error: boom"]))]))
      }
      msgs.push(...turn(calls, results))
    }
    const before = estimateTokens(JSON.stringify(msgs))
    for (const [window, force, summarize] of [[Math.max(600, Math.floor(before / 0.5)), false, null], [Math.max(600, Math.floor(before / 0.9)), true, async () => "sum"], [Math.max(600, Math.floor(before / 0.9)), true, async () => { throw new Error("x") }]]) {
      const r = await compactHistory(msgs, { window, force, summarize })
      const after = estimateTokens(JSON.stringify(r.messages))
      // automatic mode: never larger. forced mode: never larger UNLESS old turns were actually folded into a summary (the caller asked for that)
      const sizeOk = after <= before || (force && r.stats.folded > 0)
      if (!historyIsWellFormed(r.messages) || !sizeOk || r.messages[0] !== msgs[0] || r.messages[1] !== msgs[1]) { bad++; if (bad < 4) console.log("   counterexample", iter, window, force, JSON.stringify(r.messages.map((m) => m.role)), before, after, r.stats.stage) }
    }
  }
  ok("200 random histories × 3 modes: always well-formed, never larger (auto) / only larger when forced AND folded, head intact", bad === 0, `${bad} bad`)
}

console.log(`\n== context-compaction suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
