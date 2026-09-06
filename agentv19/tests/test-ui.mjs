/**
 * tests/test-ui.mjs — v20.4 terminal UI (zero network, isolated FORGE_HOME)
 *
 * Covers the four layers of the interactive terminal WITHOUT a real TTY:
 *
 *   render.js    pure renderers: width tiers 20/80/200, ANSI-safe fitting,
 *                wide/combining characters, header segment dropping, honest
 *                progress (never fabricated), a11y words, verification shows
 *                only checks that ran
 *   keys.js      raw byte decoding: split escape sequences, lone ESC, kitty
 *                keys, bracketed paste in one/many chunks (atomic), CRLF
 *   editor.js    grapheme cursor, word ops, multiline, history dedupe,
 *                prefix history, reverse search, layout/wrapping, history
 *                file format round-trip, secret filtering
 *   uistate.js   reducer/store semantics, agent-event bridge (tool rows,
 *                plan from todo, file changes with real +/- counts,
 *                checkpoints, workers, cancel phases), check parsing
 *   terminal.js  the coordinator against a VT100 screen emulator
 *                (tests/vtscreen.mjs): render lock (streaming never corrupts
 *                the prompt), single-region status, paste atomicity, resize,
 *                Ctrl+C semantics, bracketed-paste mode on/off, console capture
 *   runlog.js    crash-safe journal: interrupted-run detection, verify, prune
 *   textdiff.js  unified diff round-trips through applyUnifiedDiff
 *
 * Then, when a PTY is available (python3 + pty module), an end-to-end run of
 * `forge chat` in a real pseudo-terminal against the mock provider: startup,
 * typing while streaming, huge paste, Ctrl+C during a tool, recovery screen
 * after a simulated crash, /undo --run.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { EventEmitter } from "node:events"
import { spawnSync, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ui-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"
delete process.env.FORGE_ASCII
delete process.env.FORGE_A11Y

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FORGE_DIR = path.resolve(__dirname, "../forge")

const {
  stripAnsi, displayWidth, graphemes, fit, wrapAnsi, renderHeader, renderDock, renderOptions, renderPlan, renderChanges,
  renderVerification, renderRecovery, renderCancel, renderToolLine, progressOf, tierFor, shortRun, shortCheckpoint, detectDialect, renderColumns,
} = await import("../forge/render.js")
const { createKeyDecoder } = await import("../forge/keys.js")
const { createEditor, layout, parseHistoryFile, serializeHistory, historyWorthy, dedupe } = await import("../forge/editor.js")
const { createUIStore, reduce, initialState, bridgeAgentEvent, createBridgeContext, classifyCheck, parseCheckOutput, parseTodo, summarizeToolResult, toolTarget, isBusy } = await import("../forge/uistate.js")
const { createTerminal } = await import("../forge/terminal.js")
const { openRun, interruptedRuns, verifyRun, listRuns, markRun, pruneRuns, RUNS_DIR, resolveRunId } = await import("../forge/runlog.js")
const { unifiedDiff, diffStats } = await import("../forge/textdiff.js")
const { applyUnifiedDiff } = await import("../forge/diffpatch.js")
const { createScreen } = await import("./vtscreen.mjs")
const { suggestCommand, COMMANDS } = await import("../forge/chat.js")

let PASS = 0, FAIL = 0
// terminal.js hooks console.log while a coordinator is active — keep the real one for reporting
const realLog = console.log.bind(console)
const ok = (name, cond, extra = "") => { if (cond) { PASS++; realLog(`  ok   ${name}`) } else { FAIL++; realLog(`  FAIL ${name}${extra ? `  (${extra})` : ""}`) } }
const o = renderOptions({})
const oA = renderOptions({ a11y: true })
const oAscii = renderOptions({ ascii: true })

function sampleState(over = {}) {
  let s = initialState({ mode: "agent", provider: "openai", model: "gpt-4o" })
  s = reduce(s, { type: "TASK_STARTED", id: "run-abc-de12", title: "Refactor authentication system" })
  s = reduce(s, { type: "PLAN_UPDATED", items: [{ text: "Inspect architecture", status: "done" }, { text: "Map dependencies", status: "done" }, { text: "Refactor authentication", status: "doing" }, { text: "Run tests", status: "todo" }] })
  s = reduce(s, { type: "TOOL_STARTED", id: "t1", name: "read_file", target: "src/auth/session.js" })
  s = reduce(s, { type: "TOOL_COMPLETED", id: "t1", ms: 400, ok: true })
  s = reduce(s, { type: "TOOL_STARTED", id: "t2", name: "bash", target: "npm test", check: "tests" })
  s = reduce(s, { type: "FILE_CHANGED", path: "/x/src/agent.js", action: "modified", added: 42, removed: 17 })
  s = reduce(s, { type: "CHECKPOINT_CREATED", id: "2026-09-06T10-00-00-000Z-ab12" })
  s = { ...s, task: { ...s.task, startedAt: Date.now() - 161000 }, ...over }
  return s
}

// ---------------------------------------------------------------------------
realLog("== render: width + unicode primitives ==")
{
  ok("displayWidth ascii", displayWidth("hello") === 5)
  ok("displayWidth CJK is 2 per char", displayWidth("日本語") === 6)
  ok("displayWidth combining mark is 0", displayWidth("e\u0301") === 1)
  ok("displayWidth ZWJ family emoji is 2", displayWidth("👨‍👩‍👧") === 2)
  ok("displayWidth ignores ANSI", displayWidth("\x1b[32mok\x1b[0m") === 2)
  ok("stripAnsi removes CSI + OSC", stripAnsi("\x1b[1ma\x1b]8;;http://x\x07b\x1b]8;;\x07\x1b[0m") === "ab")
  ok("graphemes keeps clusters", graphemes("a👨‍👩‍👧é").length === 3)
  ok("fit truncates with ellipsis", fit("hello world this is long", 10) === "hello wor…" && displayWidth(fit("hello world this is long", 10)) === 10)
  ok("fit never splits a wide char", displayWidth(fit("日本語日本語", 5)) <= 5 && fit("日本語日本語", 5).endsWith("…"))
  ok("fit keeps short text", fit("ok", 10) === "ok")
  ok("fit closes open ANSI and stays within width", fit("\x1b[31mred text that is long\x1b[0m", 8).includes("\x1b[0m") && displayWidth(fit("\x1b[31mred text that is long\x1b[0m", 8)) === 8)
  const w = wrapAnsi("the quick brown fox jumps over the lazy dog", 12)
  ok("wrapAnsi word-wraps within width", w.every((r) => displayWidth(r) <= 12) && w.join(" ") === "the quick brown fox jumps over the lazy dog")
  const w2 = wrapAnsi("\x1b[32m" + "x".repeat(30) + "\x1b[0m", 10)
  ok("wrapAnsi hard-breaks long words and re-opens style", w2.length === 3 && w2[1].startsWith("\x1b[32m"))
  ok("tierFor thresholds", tierFor(20) === "narrow" && tierFor(80) === "medium" && tierFor(200) === "wide")
  ok("shortRun/shortCheckpoint", shortRun("run-mtpc429i-nx28") === "RUN-NX28" && shortCheckpoint("2026-09-06T10-00-00-000Z-ab12") === "CP-AB12")
  ok("detectDialect env flags", detectDialect({ FORGE_ASCII: "1" }).ascii && detectDialect({ FORGE_A11Y: "1" }).a11y && !detectDialect({ LANG: "en_US.UTF-8" }).ascii && detectDialect({ LANG: "en_US.ISO-8859-1" }).ascii)
  const cols = renderColumns(["alpha", "beta", "gamma", "delta", "epsilon"], 30, o)
  ok("renderColumns fits width", cols.every((l) => displayWidth(l) <= 30) && cols.join(" ").includes("epsilon"))
}

realLog("== render: header + dock adapt to width ==")
{
  const s = sampleState()
  for (const width of [20, 40, 80, 120, 200]) {
    const h = renderHeader(s, width, o)
    ok(`header fits at ${width}`, displayWidth(h) <= width - 1, `${displayWidth(h)}`)
    const dock = renderDock(s, width, 30, o)
    ok(`dock rows fit at ${width}`, dock.every((l) => displayWidth(l) <= width - 1))
    ok(`dock bounded at ${width}`, dock.length <= 10)
  }
  ok("narrow header = state + real %", stripAnsi(renderHeader(s, 30, o)) === "● VERIFYING  50%")
  const wide = stripAnsi(renderHeader(s, 120, o))
  ok("wide header has all segments", wide.includes("FORGE") && wide.includes("AGENT") && wide.includes("RUN-DE12") && wide.includes("VERIFYING 50%") && wide.includes("02:4") && wide.includes("openai/gpt-4o"))
  const mid = stripAnsi(renderHeader(s, 55, o))
  ok("header drops provider/elapsed before mode/state", mid.includes("FORGE") && mid.includes("VERIFYING") && !mid.includes("openai"))
  ok("a11y header uses words", stripAnsi(renderHeader(s, 120, oA)).includes("STATE: VERIFYING"))
  ok("ascii header has no unicode glyphs", /^[\x20-\x7e]*$/.test(stripAnsi(renderHeader(s, 120, oAscii))))
  const noPlan = { ...s, plan: [] }
  ok("progress is null without a plan (never fabricated)", progressOf(noPlan) === null && !stripAnsi(renderHeader(noPlan, 120, o)).includes("%"))
  ok("progress is real done/total", progressOf(s).pct === 50 && progressOf(s).done === 2 && progressOf(s).total === 4)
  const wideDock = renderDock(s, 120, 30, o).map(stripAnsi)
  ok("wide dock has TASK/PLAN/ACTIVITY", wideDock.some((l) => l.startsWith("TASK")) && wideDock.some((l) => l.startsWith("PLAN")) && wideDock.includes("ACTIVITY"))
  const medDock = renderDock(s, 70, 30, o).map(stripAnsi)
  ok("medium dock = header + one summary line", medDock.length === 2 && medDock[1].includes("files 1") && medDock[1].includes("tests running"))
  ok("narrow dock = header only", renderDock(s, 30, 30, o).length === 1)
  ok("dock respects small row count", renderDock(s, 120, 8, o).length <= 3)
  ok("idle state dock is header only", renderDock(initialState(), 120, 30, o).length === 1)
  const chatTask = reduce(initialState(), { type: "TASK_STARTED", kind: "chat", title: "hi" })
  ok("chat turn keeps dock minimal", renderDock(chatTask, 120, 30, o).length === 1)
}

realLog("== render: panels ==")
{
  const s = sampleState()
  const plan = renderPlan(s.plan, 80, o).map(stripAnsi)
  ok("plan lists numbered items with marks", plan.some((l) => /01 ✓ Inspect architecture/.test(l)) && plan.some((l) => /03 ● Refactor/.test(l)) && plan.some((l) => /04 ○ Run tests/.test(l)))
  const planA = renderPlan(s.plan, 80, oA).map(stripAnsi)
  ok("a11y plan uses SUCCESS:/ACTIVE:/PENDING:", planA.some((l) => l.includes("SUCCESS:")) && planA.some((l) => l.includes("ACTIVE:")) && planA.some((l) => l.includes("PENDING:")))
  const nested = renderPlan([{ n: 1, text: "parent", status: "doing", children: [{ n: 1, text: "child a", status: "done" }, { n: 2, text: "child b", status: "todo" }] }], 80, o).map(stripAnsi)
  ok("nested plan renders children indented", nested.some((l) => /^\s+.*child a/.test(l)) && nested.length >= 4)
  const ch = renderChanges(s.changes, 80, o, { cwd: "/x" }).map(stripAnsi)
  ok("changes panel shows M path +42 -17", ch.some((l) => l.includes("M") && l.includes("src/agent.js") && l.includes("+42") && l.includes("-17")))
  const ver = renderVerification({ tests: { ok: true, passed: 247, failed: 0 }, syntax: { ok: true } }, {}, 80, o).map(stripAnsi)
  ok("verification shows only executed checks", ver.some((l) => l.includes("Unit tests")) && ver.some((l) => l.includes("Syntax")) && !ver.some((l) => /Lint|Build|Types/.test(l)))
  ok("verification shows real counts", ver.some((l) => l.includes("247/247")))
  const none = renderVerification({}, {}, 80, o).map(stripAnsi)
  ok("no checks → says so, never claims a pass", none.some((l) => /no checks were run/i.test(l)))
  const rec = renderRecovery({ runId: "run-1-a018", task: "Implement recovery engine", status: "running", checkpoints: ["x-0024"], step: 23, files: { a: 1 }, startedAt: Date.now() }, 80, o).map(stripAnsi)
  ok("recovery screen has the four actions", rec.some((l) => l.includes("[R]") && l.includes("[V]") && l.includes("[U]") && l.includes("[C]")))
  ok("recovery screen shows run + status + checkpoint", rec.some((l) => l.includes("RUN-A018")) && rec.some((l) => l.includes("INTERRUPTED")) && rec.some((l) => l.includes("CP-0024")))
  const recNarrow = renderRecovery({ runId: "run-1-a018", task: "t", status: "running", files: {} }, 40, o)
  ok("recovery fits narrow", recNarrow.every((l) => displayWidth(l) <= 39))
  const c1 = renderCancel("waiting", { tool: "bash npm test" }, 80, o).map(stripAnsi)
  ok("cancel waiting phase is honest", c1.some((l) => l.includes("waiting for current tool to terminate")) && !c1.some((l) => l.includes("stopped safely")))
  const c2 = renderCancel("stopped", { files: 2 }, 80, o).map(stripAnsi)
  ok("cancel stopped phase reports checkpointed files", c2.some((l) => l.includes("stopped safely")) && c2.some((l) => l.includes("2 changed files")))
  const tl = renderToolLine({ name: "bash", target: "npm test", endedAt: 1, ms: 1234, ok: false, exit: 1, summary: ["3 failed"], hidden: 120, lines: 130 }, 80, o).map(stripAnsi)
  ok("tool line: label, target, duration, exit, collapsed count", tl[0].includes("shell") && tl[0].includes("npm test") && tl[0].includes("1.2s") && tl.some((l) => l.includes("exit 1")) && tl.some((l) => l.includes("120 lines hidden")))
  const tlA = renderToolLine({ name: "bash", target: "x", endedAt: 1, ms: 5, ok: true }, 80, oA).map(stripAnsi)
  ok("a11y tool line uses SUCCESS:", tlA[0].startsWith("SUCCESS:"))
}

// ---------------------------------------------------------------------------
realLog("== keys: raw decoding ==")
{
  const kd = createKeyDecoder()
  const ev = kd.feed("a\x1b[Ab\x1b[200~npm install\nnpm test\x1b[201~")
  ok("text / key / text / paste sequence", ev.length === 4 && ev[0].type === "text" && ev[1].name === "up" && ev[2].text === "b" && ev[3].type === "paste")
  ok("paste is delivered whole", ev[3].text === "npm install\nnpm test")
  const kd2 = createKeyDecoder()
  ok("split CSI waits for the rest", kd2.feed("\x1b[").length === 0 && kd2.feed("3~")[0].name === "delete")
  const kd3 = createKeyDecoder()
  const p1 = kd3.feed("\x1b[200~ab"), p2 = kd3.feed("c\x1b[20"), p3 = kd3.feed("1~x")
  ok("paste across three chunks is one event", p1.length === 0 && p2.length === 0 && p3[0].type === "paste" && p3[0].text === "abc" && p3[1].text === "x")
  const kd4 = createKeyDecoder()
  ok("lone ESC only after flush", kd4.feed("\x1b").length === 0 && kd4.flush()[0].name === "escape")
  const kd5 = createKeyDecoder()
  const m = kd5.feed("\x1b[1;5D\x1b[1;3C\x1bb\x1b\r\x7f\x08\x17\x12\x01\x05\x0b\x15\x19\x0c\x04\x03\t\x1b[Z\x1bOH\x1b[F")
  const names = m.map((e) => `${e.ctrl ? "C-" : ""}${e.alt ? "M-" : ""}${e.name}`)
  ok("modifiers + control chords decode", JSON.stringify(names) === JSON.stringify(["C-left", "M-right", "M-b", "M-enter", "backspace", "C-backspace", "C-w", "C-r", "C-a", "C-e", "C-k", "C-u", "C-y", "C-l", "C-d", "C-c", "tab", "tab", "home", "end"]), names.join(","))
  const kd6 = createKeyDecoder()
  const k = kd6.feed("\x1b[13;5u\x1b[97;3u")
  ok("kitty protocol enter/alt-a", k[0].name === "enter" && k[0].ctrl && k[1].name === "a" && k[1].alt)
  const kd7 = createKeyDecoder()
  ok("CRLF inside paste normalized", kd7.feed("\x1b[200~a\r\nb\rc\x1b[201~")[0].text === "a\nb\nc")
  const kd8 = createKeyDecoder()
  const u = kd8.feed(Buffer.from("héllo 日本 👨‍👩‍👧"))
  ok("utf8 text batched as one event", u.length === 1 && u[0].text === "héllo 日本 👨‍👩‍👧")
  const kd9 = createKeyDecoder()
  const b = Buffer.from("日本")
  const s1 = kd9.feed(b.subarray(0, 2)), s2 = kd9.feed(b.subarray(2))
  ok("utf8 split across chunks", (s1.length === 0 || s1[0].text === "") && s2.map((e) => e.text).join("") === "日本")
  const kd10 = createKeyDecoder()
  const f = kd10.feed("\x1b[I\x1b[O")
  ok("focus events decoded, not typed", f.every((e) => e.type === "focus"))
  const big = "x".repeat(2_000_000) + "\n" + "y".repeat(100)
  const kd11 = createKeyDecoder()
  const bp = kd11.feed("\x1b[200~" + big + "\x1b[201~")
  ok("2MB paste survives intact", bp.length === 1 && bp[0].text.length === big.length)
}

// ---------------------------------------------------------------------------
realLog("== editor: cursor, unicode, multiline, history, search ==")
{
  const ed = createEditor({ history: ["ls", "git status", "npm test", "git log"] })
  ed.insert("héllo 👨‍👩‍👧 wörld")
  ed.left(); ed.left(); ed.backspace()
  ok("backspace removes one grapheme before cursor", ed.text === "héllo 👨‍👩‍👧 wöld")
  ed.home(); ed.right(); ed.right(); ed.right(); ed.right(); ed.right(); ed.right(); ed.delete()
  ok("delete removes the whole ZWJ emoji", ed.text === "héllo  wöld")
  ed.end(); ed.deleteWordLeft()
  ok("Ctrl+W deletes the last word", ed.text === "héllo  ")
  ed.yank()
  ok("Ctrl+Y yanks it back", ed.text === "héllo  wöld")
  ed.home(); ed.wordRight()
  ok("word right lands after the word", ed.cursor === "héllo".length)
  ed.killToEnd()
  ok("Ctrl+K kills to end", ed.text === "héllo")
  ed.clear(); ed.insert("line1\nline2"); ed.home()
  ok("home goes to start of the current line", ed.cursor === 6)
  ok("lineUp moves to previous line", ed.lineUp() === true && ed.cursor === 0)
  ok("lineUp on first line returns false", ed.lineUp() === false)
  ed.end()
  ok("lineDown keeps the column", ed.lineDown() === true && ed.cursor === 11)
  ok("lines counts logical lines", ed.lines === 2)
  // history
  ed.clear()
  ok("historyPrev walks back", ed.historyPrev() && ed.text === "git log" && ed.historyPrev() && ed.text === "npm test")
  ok("historyNext returns to draft", ed.historyNext() && ed.historyNext() && ed.text === "")
  ed.clear(); ed.insert("git")
  ok("prefix history matches typed prefix", ed.historyPrevPrefix() && ed.text === "git log" && ed.historyPrevPrefix() && ed.text === "git status")
  ed.clear(); ed.insert("npm test"); ed.commit()
  const h = ed.history
  ok("commit dedupes (moves to newest)", h.filter((x) => x === "npm test").length === 1 && h[h.length - 1] === "npm test")
  ed.clear(); ed.insert("   "); ed.commit()
  ok("blank lines are not committed", ed.history.length === h.length)
  // reverse search
  ed.clear(); ed.insert("typed draft")
  ed.searchStart(); ed.searchType("git")
  ok("Ctrl+R finds newest match", ed.searching && ed.search.match === "git log" && ed.text === "git log")
  ed.searchNext()
  ok("Ctrl+R again finds older match", ed.search.match === "git status")
  ed.searchType("zzz")
  ok("no match flagged as failed", ed.search.failed === true)
  ed.searchCancel()
  ok("Esc restores the draft", !ed.searching && ed.text === "typed draft")
  ed.searchStart(); ed.searchType("npm"); ed.searchAccept()
  ok("Enter accepts the match", !ed.searching && ed.text === "npm test")
  // snapshot/restore
  ed.clear(); ed.insert("abc"); ed.left()
  const snap = ed.snapshot(); ed.clear(); ed.restore(snap)
  ok("snapshot/restore keeps text+cursor", ed.text === "abc" && ed.cursor === 2)
  // layout
  const lay = layout("hello world foo", 15, 10, 3)
  ok("layout wraps by width with prompt offset", JSON.stringify(lay.rows) === JSON.stringify(["hello w", "orld fo", "o"]) && lay.cursorRow === 2 && lay.cursorCol === 4)
  const lay2 = layout("日本語日本語", 6, 8, 2)
  ok("layout never splits wide chars", lay2.rows.every((r) => displayWidth(r) <= 6))
  const lay3 = layout("a\nb", 2, 20, 4, 2)
  ok("layout: cursor after newline sits on second row", lay3.cursorRow === 1 && lay3.cursorCol === 2)
  // history file format
  const entries = ["ls -la", "multi\nline\nentry", "back\\slash", "日本語"]
  const round = parseHistoryFile(serializeHistory(entries))
  ok("history file round-trips multiline + backslashes", JSON.stringify(round) === JSON.stringify(entries))
  ok("legacy history lines still parse", JSON.stringify(parseHistoryFile("one\ntwo\n")) === JSON.stringify(["one", "two"]))
  ok("history filters secrets", !historyWorthy("/key sk-abcdefghijklmnop") && !historyWorthy("export OPENAI_API_KEY=sk-1234567890abcdef") && historyWorthy("git status"))
  ok("dedupe keeps newest order", JSON.stringify(dedupe(["a", "b", "a", "c"])) === JSON.stringify(["b", "a", "c"]))
}

// ---------------------------------------------------------------------------
realLog("== uistate: reducer + bridge ==")
{
  const store = createUIStore({ mode: "chat" })
  let events = 0
  store.subscribe(() => events++)
  store.dispatch({ type: "MODE_CHANGED", mode: "agent" })
  ok("mode changes immediately", store.state.mode === "agent" && events === 1)
  store.dispatch({ type: "MODE_CHANGED", mode: "bogus" })
  ok("invalid mode ignored", store.state.mode === "agent")
  ok("unknown events are ignored", reduce(store.state, { type: "NOPE" }) === store.state)
  store.dispatch({ type: "TASK_STARTED", id: "run-1-aaaa", title: "  do   things  " })
  ok("task start → THINKING with normalized title", store.state.state === "THINKING" && store.state.task.title === "do things" && isBusy(store.state))
  store.dispatch({ type: "TOOL_STARTED", id: "a", name: "bash", target: "ls" })
  ok("tool start → EXECUTING", store.state.state === "EXECUTING")
  store.dispatch({ type: "TOOL_STARTED", id: "b", name: "bash", target: "npm test", check: "tests" })
  ok("check tool → VERIFYING + tests running", store.state.state === "VERIFYING" && store.state.tests.running)
  store.dispatch({ type: "TOOL_COMPLETED", id: "b", ok: false, exit: 1, ms: 10, checkResult: { ok: false, passed: 3, failed: 1, summary: "3 passed, 1 failed" } })
  ok("failed check recorded in verification + tests + repair opened", store.state.verification.checks.tests.ok === false && store.state.tests.failed === 1 && store.state.repair?.open === true)
  store.dispatch({ type: "FILE_CHANGED", path: "/p/a.js", action: "modified", added: 3, removed: 1 })
  store.dispatch({ type: "TOOL_STARTED", id: "c", name: "bash", target: "npm test", check: "tests" })
  store.dispatch({ type: "TOOL_COMPLETED", id: "c", ok: true, exit: 0, ms: 10, checkResult: { ok: true, passed: 4, failed: 0, summary: "4 passed" } })
  ok("repair loop: attempt 2 passes, diagnosis = edited files", store.state.repair.open === false && store.state.repair.attempts.length === 2 && store.state.repair.attempts[0].diagnosis.includes("a.js") && store.state.repair.attempts[1].ok)
  store.dispatch({ type: "TOOL_COMPLETED", id: "a", ok: true, ms: 5 })
  ok("all tools done → back to EXECUTING", store.state.state === "EXECUTING" && store.state.tools.bash.calls === 3 && store.state.tools.bash.ok === 2 && store.state.tools.bash.fail === 1)
  store.dispatch({ type: "FILE_CHANGED", path: "/p/a.js", action: "modified", added: 2, removed: 0 })
  ok("file changes accumulate per path", store.state.changes["/p/a.js"].added === 5 && Object.keys(store.state.changes).length === 1)
  store.dispatch({ type: "FILE_CHANGED", path: "/p/new.js", action: "created", added: 10 })
  store.dispatch({ type: "FILE_CHANGED", path: "/p/new.js", action: "modified", added: 1 })
  ok("created stays created after later edits", store.state.changes["/p/new.js"].action === "created")
  store.dispatch({ type: "CHECKPOINT_CREATED", id: "cp1" })
  store.dispatch({ type: "CHECKPOINT_CREATED", id: "cp1" })
  ok("checkpoints deduped", store.state.checkpoints.length === 1 && store.state.checkpoint === "cp1")
  store.dispatch({ type: "WORKER_STARTED", id: "w1", role: "researcher", task: "look" })
  store.dispatch({ type: "WORKER_COMPLETED", id: "w1", ok: true, report: "found it" })
  ok("workers tracked", store.state.workers[0].status === "done" && store.state.workers[0].report === "found it")
  store.dispatch({ type: "USER_INTERRUPTED", phase: "requested" })
  ok("cancel requested keeps the task running (honest)", store.state.cancel.phase === "requested" && isBusy(store.state))
  store.dispatch({ type: "USER_INTERRUPTED", phase: "stopped" })
  ok("cancel stopped → CANCELLED", store.state.state === "CANCELLED" && !isBusy(store.state) && store.state.result.cancelled)
  store.dispatch({ type: "TASK_RESET" })
  ok("reset → READY with lastTask", store.state.state === "READY" && store.state.task === null && store.state.lastTask.status === "cancelled")
  // failure path
  store.dispatch({ type: "TASK_STARTED", id: "run-2-bbbb", title: "x" })
  store.dispatch({ type: "TASK_FAILED", reason: "provider exploded" })
  ok("task failed → FAILED + lastError", store.state.state === "FAILED" && store.state.lastError.summary === "provider exploded")
  store.dispatch({ type: "TASK_RESET" })
  // bounded buffers
  store.dispatch({ type: "TASK_STARTED", id: "run-3-cccc", title: "x" })
  for (let i = 0; i < 200; i++) { store.dispatch({ type: "TOOL_STARTED", id: `t${i}`, name: "read_file", target: `f${i}` }); store.dispatch({ type: "TOOL_COMPLETED", id: `t${i}`, ok: true, ms: 1, output: "o".repeat(1000) }) }
  ok("activity ring buffer bounded", store.state.activity.length <= 60 && store.state.details.length <= 12)
  store.dispatch({ type: "TASK_RESET" })
}

realLog("== uistate: check classification + output parsing ==")
{
  ok("classifyCheck tests", classifyCheck("npm test") === "tests" && classifyCheck("cd x && pytest -q") === "tests" && classifyCheck("go test ./...") === "tests" && classifyCheck("node --test") === "tests")
  ok("classifyCheck lint/types/build/syntax", classifyCheck("npx eslint .") === "lint" && classifyCheck("tsc --noEmit") === "types" && classifyCheck("npm run build") === "build" && classifyCheck("node --check a.js") === "syntax")
  ok("classifyCheck none for plain commands", classifyCheck("ls -la") === null && classifyCheck("cat package.json") === null && classifyCheck("echo testing") === null)
  const jest = parseCheckOutput("tests", "Tests:       2 failed, 10 passed, 12 total\n[exit code: 1]")
  ok("parses jest counts + exit", jest.passed === 10 && jest.failed === 2 && jest.ok === false && jest.exit === 1)
  const tap = parseCheckOutput("tests", "# tests 5\n# pass 5\n# fail 0\n")
  ok("parses node TAP", tap.passed === 5 && tap.failed === 0 && tap.ok)
  const cargo = parseCheckOutput("tests", "test result: ok. 12 passed; 0 failed; 0 ignored")
  ok("parses cargo", cargo.passed === 12 && cargo.ok)
  const forge = parseCheckOutput("tests", "== ui suite: 247 passed, 0 failed ==")
  ok("parses 'N passed, M failed'", forge.passed === 247 && forge.failed === 0 && forge.ok)
  const noNums = parseCheckOutput("tests", "everything fine")
  ok("no numbers → no counts, exit-based verdict", noNums.passed === null && noNums.ok === true && noNums.summary === "passed")
  const timeout = parseCheckOutput("tests", "…\n[command timed out after 45s]")
  ok("timeout is a failure", timeout.ok === false && timeout.exit === 124)
  const todo = parseTodo("[x] 1. Inspect\n[~] 2. Refactor\n[ ] 3. Test")
  ok("parseTodo → plan items", todo.length === 3 && todo[0].status === "done" && todo[1].status === "doing" && todo[2].status === "todo")
  const sum = summarizeToolResult("bash", Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\nERROR: boom\n[exit code: 2]")
  ok("summarizeToolResult collapses + surfaces error lines", sum.ok === false && sum.exit === 2 && sum.hidden > 0 && sum.summary.some((l) => l.includes("ERROR: boom")))
  const short = summarizeToolResult("read_file", "one\ntwo")
  ok("short outputs are not collapsed", short.hidden === 0 && short.ok)
  ok("toolTarget redacts secrets", !toolTarget("bash", { command: "curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456' x" }).includes("sk-abcdefghijklmnopqrstuvwxyz123456"))
  ok("toolTarget patch lists files", toolTarget("apply_patch", { patch: "--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\n" }) === "x.js")
}

realLog("== uistate: agent-event bridge (real files) ==")
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ui-work-"))
  const f = path.join(work, "a.txt")
  fs.writeFileSync(f, "one\ntwo\nthree\n")
  const store = createUIStore({ mode: "agent" })
  const bctx = createBridgeContext({ cwd: work })
  const seen = []
  store.subscribe((_s, ev) => seen.push(ev.type))
  bridgeAgentEvent(store, { type: "run_start", runId: "run-1-zzzz", task: "edit a" }, bctx)
  bridgeAgentEvent(store, { type: "step", step: 1 }, bctx)
  bridgeAgentEvent(store, { type: "tool_start", name: "todo", args: JSON.stringify({ action: "add", items: ["x", "y"] }), step: 1 }, bctx)
  bridgeAgentEvent(store, { type: "tool_result", name: "todo", result: "[~] 1. x\n[ ] 2. y", step: 1, ms: 1 }, bctx)
  ok("todo result → PLAN_UPDATED", store.state.plan.length === 2 && store.state.plan[0].status === "doing")
  bridgeAgentEvent(store, { type: "tool_start", name: "edit_file", args: JSON.stringify({ path: "a.txt", old: "two", new: "2\n2b" }), step: 2 }, bctx)
  fs.writeFileSync(f, "one\n2\n2b\nthree\n") // what the tool did
  bridgeAgentEvent(store, { type: "tool_result", name: "edit_file", result: `OK edit_file ${f}: 1 replacement`, step: 2, ms: 3 }, bctx)
  const ch = store.state.changes[f]
  ok("edit → FILE_CHANGED with real +2 -1", ch && ch.action === "modified" && ch.added === 2 && ch.removed === 1, JSON.stringify(ch))
  ok("baseline kept for /diff", bctx.before.get(f)?.text === "one\ntwo\nthree\n")
  bridgeAgentEvent(store, { type: "tool_start", name: "write_file", args: JSON.stringify({ path: "new.txt", content: "a\nb\n" }), step: 3 }, bctx)
  fs.writeFileSync(path.join(work, "new.txt"), "a\nb\n")
  bridgeAgentEvent(store, { type: "tool_result", name: "write_file", result: "OK wrote new.txt (created)", step: 3, ms: 1 }, bctx)
  ok("write → created +2", store.state.changes[path.join(work, "new.txt")]?.action === "created" && store.state.changes[path.join(work, "new.txt")].added === 2)
  bridgeAgentEvent(store, { type: "tool_start", name: "bash", args: JSON.stringify({ command: "npm test" }), step: 4 }, bctx)
  ok("bash npm test classified as tests check", store.state.activity.at(-1).check === "tests" && store.state.state === "VERIFYING")
  bridgeAgentEvent(store, { type: "tool_result", name: "bash", result: "== suite: 3 passed, 0 failed ==", step: 4, ms: 50 }, bctx)
  ok("test output → verification.tests with counts", store.state.verification.checks.tests?.passed === 3 && store.state.tests.ok === true)
  bridgeAgentEvent(store, { type: "run_start", sub: "w1", role: "researcher", task: "look around" }, bctx)
  bridgeAgentEvent(store, { type: "tool_start", sub: "w1", name: "read_file", args: "{}", step: 1 }, bctx)
  ok("sub-agent tool traffic does not pollute main activity", !store.state.activity.some((a) => a.worker) && store.state.workers.length === 1)
  bridgeAgentEvent(store, { type: "run_end", sub: "w1", status: "completed", text: "report" }, bctx)
  ok("sub-agent end → worker done", store.state.workers[0].status === "done")
  bridgeAgentEvent(store, { type: "failover", from: "a/m1", to: "b/m2", reason: "500" }, bctx)
  ok("failover → notice + provider change", store.state.provider === "b" && store.state.model === "m2" && store.state.notices.at(-1).text.includes("failover"))
  bridgeAgentEvent(store, { type: "run_end", runId: "run-1-zzzz", status: "completed", text: "done", steps: 4, toolCalls: 4, wrote: true }, bctx)
  ok("run_end → COMPLETED with result", store.state.state === "COMPLETED" && store.state.result.wrote && store.state.result.runId === "run-1-zzzz")
  fs.rmSync(work, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
realLog("== textdiff ==")
{
  const a = "one\ntwo\nthree\nfour\nfive\n", b = "one\n2\nthree\nfour\nfive\nsix\n"
  const d = unifiedDiff(a, b, { path: "f.txt" })
  ok("diffStats counts", JSON.stringify(diffStats(a, b)) === JSON.stringify({ added: 2, removed: 1 }))
  const m = new Map([["f.txt", a]])
  const r = applyUnifiedDiff(m, d)
  ok("unified diff round-trips through applyUnifiedDiff", r.results.get("f.txt") === b)
  ok("identical texts → empty diff", unifiedDiff("x\n", "x\n") === "")
  const big1 = Array.from({ length: 25000 }, (_, i) => `l${i}`).join("\n"), big2 = big1 + "\nextra"
  ok("huge inputs fall back to counts (bounded)", diffStats(big1, big2).added === 1 && unifiedDiff(big1, big2).includes("too large"))
  const base = Array.from({ length: 30 }, (_, i) => `l${i}`)
  const edited = base.map((l, i) => (i === 4 || i === 24 ? l.toUpperCase() : l))
  const moved = unifiedDiff(base.join("\n") + "\n", edited.join("\n") + "\n", { path: "p" })
  ok("hunks split when changes are far apart", (moved.match(/^@@/gm) || []).length === 2)
  ok("split hunks still apply", applyUnifiedDiff(new Map([["p", base.join("\n") + "\n"]]), moved).results.get("p") === edited.join("\n") + "\n")
}

// ---------------------------------------------------------------------------
realLog("== runlog: crash-safe journal ==")
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ui-run-"))
  const h = openRun({ runId: "run-1-j001", task: "journal me", cwd })
  h.step(3); h.tool("bash", "npm test", true); h.touched(path.join(cwd, "x.js"), "modified"); h.checkpoint("cp-1"); h.flush()
  const rec = JSON.parse(fs.readFileSync(h.file, "utf8"))
  ok("journal written atomically with step/tool/files", rec.status === "running" && rec.step === 3 && rec.lastTool.name === "bash" && Object.keys(rec.files).length === 1 && rec.checkpoints[0] === "cp-1")
  ok("running run with live pid is NOT interrupted", interruptedRuns({ cwd }).length === 0)
  // simulate a crash: rewrite with a dead pid
  rec.pid = 999999
  fs.writeFileSync(h.file, JSON.stringify(rec))
  const dead = interruptedRuns({ cwd })
  ok("dead pid + running → interrupted", dead.length === 1 && dead[0].runId === "run-1-j001")
  const v = verifyRun(dead[0])
  ok("verifyRun reports missing files honestly", v.missing === 1 && /missing/.test(v.filesystem))
  fs.writeFileSync(path.join(cwd, "x.js"), "x")
  ok("verifyRun reports present files", verifyRun(dead[0]).missing === 0)
  ok("resolveRunId accepts RUN-XXXX", resolveRunId(cwd, "RUN-J001") === "run-1-j001" && resolveRunId(cwd, "run-1-j001") === "run-1-j001" && resolveRunId(cwd, "RUN-NOPE") === null)
  markRun("run-1-j001", "cancelled", { note: "left" })
  ok("markRun closes the run", interruptedRuns({ cwd }).length === 0 && listRuns({ cwd })[0].status === "cancelled")
  h.end("completed", { steps: 5 })
  ok("end() after markRun is harmless", JSON.parse(fs.readFileSync(h.file, "utf8")).status === "completed")
  ok("other cwd is not listed", listRuns({ cwd: "/nonexistent-xyz" }).length === 0)
  for (let i = 0; i < 205; i++) openRun({ runId: `run-p-${String(i).padStart(4, "0")}`, task: "p", cwd }).end("completed")
  pruneRuns(200)
  ok("pruneRuns keeps ≤200", fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")).length <= 200)
  fs.rmSync(cwd, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
realLog("== terminal coordinator against a VT screen ==")
function fakeTTY(cols = 60, rows = 12) {
  const screen = createScreen(cols, rows)
  const input = new EventEmitter(); input.isTTY = true; input.setRawMode = () => {}; input.resume = () => {}; input.pause = () => {}
  const output = new EventEmitter(); output.isTTY = true; output.columns = cols; output.rows = rows
  output.write = (chunk) => { screen.feed(chunk); return true }
  return { screen, input, output }
}
{
  const { screen, input, output } = fakeTTY()
  const term = createTerminal({ input, output, forceTTY: true })
  const submitted = []
  term.start({ prompt: "forge > ", onSubmit: (t) => submitted.push(t), onEOF: () => {} })
  term.setDock(() => ["FORGE  CHAT  READY"])
  term._renderNow()
  ok("bracketed paste mode enabled on start", screen.bracketedPaste === true)
  ok("initial frame: dock above prompt, cursor after prompt", screen.line(0) === "FORGE  CHAT  READY" && screen.line(1) === "forge >" && screen.cursor.x === 8 && screen.cursor.y === 1)
  term._feed("hello wörld"); term._renderNow()
  ok("typed text echoes with cursor at end", screen.line(1) === "forge > hello wörld" && screen.cursor.x === 19)
  term.out("streamed part one "); term._renderNow()
  term.out("and two\nline done\n"); term._renderNow()
  ok("render lock: streamed output lands ABOVE the live region", screen.line(0) === "streamed part one and two" && screen.line(1) === "line done" && screen.line(2) === "FORGE  CHAT  READY" && screen.line(3) === "forge > hello wörld")
  ok("cursor restored after stream", screen.cursor.x === 19 && screen.cursor.y === 3)
  term._feed("\x1b[D\x1b[D\x1b[DXYZ"); term._renderNow()
  ok("cursor keys + insert in the middle", screen.line(3) === "forge > hello wöXYZrld" && screen.cursor.x === 19)
  term._feed("\x1b[200~pasted\nlines\x1b[201~"); term._renderNow()
  ok("paste with newline is inserted, not submitted", submitted.length === 0 && screen.line(3) === "forge > hello wöXYZpasted" && screen.line(4) === "... linesrld")
  term._feed("\r"); term._renderNow()
  ok("Enter submits the multiline buffer once", submitted.length === 1 && submitted[0] === "hello wöXYZpasted\nlinesrld")
  ok("submitted input becomes a transcript line", screen.all().includes("forge > hello wöXYZpasted") && screen.count("FORGE  CHAT  READY") === 1)
  term.setStatus("● Thinking 2.1s"); term._renderNow()
  term.setStatus("● Thinking 3.1s"); term._renderNow()
  term.setStatus("● Thinking 4.1s"); term._renderNow()
  ok("status is a single updating region (no repeated lines)", screen.count("Thinking") === 1 && screen.all().includes("Thinking 4.1s"))
  for (let i = 0; i < 5; i++) console.log("line " + i)
  term.flush()
  ok("console.log is captured and ordered above the live region", screen.all().includes("line 0\nline 1\nline 2\nline 3\nline 4\nFORGE  CHAT  READY") && screen.count("FORGE  CHAT  READY") === 1)
  output.write("partial via stdout") // the coordinator hooks the stream's write while active
  term._renderNow()
  ok("stdout.write partial stays live (no newline yet)", screen.all().includes("partial via stdout") && term.partial === "partial via stdout")
  output.write("\n"); term._renderNow()
  ok("newline promotes the partial to scrollback", term.partial === "")
  // Ctrl+C semantics
  let cancels = 0
  const t2 = fakeTTY(60, 12)
  const term2 = createTerminal({ input: t2.input, output: t2.output, forceTTY: true })
  let eof = 0
  term2.start({ prompt: "> ", onSubmit: () => {}, onCancel: ({ hadText }) => { cancels++; return hadText ? "cleared" : "exit" }, onEOF: () => eof++ })
  term2._feed("abc"); term2._feed("\x03"); term2._renderNow()
  ok("Ctrl+C with text clears the input", term2.editor.text === "" && cancels === 1 && eof === 0)
  term2._feed("\x03"); term2._renderNow()
  ok("Ctrl+C on empty idle input asks for a second press", eof === 0 && t2.screen.all().includes("press Ctrl+C again"))
  term2._feed("\x03")
  ok("second Ctrl+C exits", eof === 1)
  term2._feed("\x04")
  ok("Ctrl+D on empty input is EOF", eof === 2)
  // Ctrl+R search rendering
  const t3 = fakeTTY(60, 12)
  const term3 = createTerminal({ input: t3.input, output: t3.output, forceTTY: true })
  term3.start({ prompt: "> ", history: ["git status", "npm test"], onSubmit: () => {}, onEOF: () => {} })
  term3._feed("\x12"); term3._feed("np"); term3._renderNow()
  ok("reverse search row shown with match", t3.screen.all().includes("(reverse-i-search)'np': npm test") && term3.editor.text === "npm test")
  term3._feed("\x1b"); term3._flushEsc(); term3._renderNow()
  ok("Esc cancels search and restores", !term3.editor.searching && term3.editor.text === "")
  // Tab completion
  const t4 = fakeTTY(60, 12)
  const term4 = createTerminal({ input: t4.input, output: t4.output, forceTTY: true })
  term4.start({ prompt: "> ", onSubmit: () => {}, onEOF: () => {}, completer: (before) => ({ candidates: ["/help", "/history"].filter((c) => c.startsWith(before)), replaceFrom: 0 }) })
  term4._feed("/h"); term4._feed("\t"); term4._renderNow()
  ok("Tab completes the common prefix and lists candidates", term4.editor.text === "/h" && t4.screen.all().includes("/help") && t4.screen.all().includes("/history"))
  term4._feed("e\t"); term4._renderNow()
  ok("unique completion inserts + trailing space", term4.editor.text === "/help ")
  // resize keeps input
  const t5 = fakeTTY(80, 12)
  const term5 = createTerminal({ input: t5.input, output: t5.output, forceTTY: true })
  let resized = null
  term5.start({ prompt: "> ", onSubmit: () => {}, onEOF: () => {}, onResize: (g) => (resized = g) })
  term5._feed("keep this text"); term5._renderNow()
  t5.output.columns = 40; t5.output.rows = 10; t5.screen.resize(40, 10); term5._resize(40, 10)
  ok("resize recomputes layout and preserves input", resized.columns === 40 && term5.editor.text === "keep this text" && t5.screen.text().includes("> keep this text") && term5.columns === 40)
  // oversized input is windowed, never overflows the screen
  const t6 = fakeTTY(40, 8)
  const term6 = createTerminal({ input: t6.input, output: t6.output, forceTTY: true })
  term6.start({ prompt: "> ", onSubmit: () => {}, onEOF: () => {} })
  term6._feed("\x1b[200~" + Array.from({ length: 50 }, (_, i) => "row " + i).join("\n") + "\x1b[201~"); term6._renderNow()
  ok("50-line paste is windowed to the screen height", term6.lastFrame.length <= 7 && term6.editor.lines === 50 && t6.screen.text().includes("row 49"))
  // a11y / ascii dialect flows through the terminal opts
  const t7 = fakeTTY(60, 12)
  const term7 = createTerminal({ input: t7.input, output: t7.output, forceTTY: true, env: { FORGE_A11Y: "1" } })
  ok("terminal picks up a11y dialect from env", term7.opts.a11y === true)
  // ask(): single-key question
  const t8 = fakeTTY(60, 12)
  const term8 = createTerminal({ input: t8.input, output: t8.output, forceTTY: true })
  term8.start({ prompt: "> ", onSubmit: () => {}, onEOF: () => {} })
  term8._feed("draft"); term8._renderNow()
  const q = term8.ask("recovery > ", { single: true, keys: ["r", "v", "u", "c"] })
  term8._renderNow()
  term8._feed("x"); term8._feed("V")
  const answer = await q
  term8._renderNow()
  ok("single-key ask ignores other keys and restores the draft", answer === "v" && term8.editor.text === "draft" && t8.screen.all().includes("recovery > v"))
  const q2 = term8.ask("name? ")
  term8._feed("\x1b[200~multi\nline\x1b[201~"); term8._feed("\r")
  const a2 = await q2
  ok("line ask returns pasted text whole", a2 === "multi\nline")
  term.stop(); term2.stop(); term3.stop(); term4.stop(); term5.stop(); term6.stop(); term8.stop()
  ok("stop restores cooked terminal state (paste off, cursor visible)", screen.bracketedPaste === false && screen.cursorVisible === true)
  // non-TTY: plain passthrough
  const chunks = []
  const plainOut = { isTTY: false, write: (c) => { chunks.push(String(c)); return true }, on() {}, removeListener() {} }
  const plainIn = new EventEmitter(); plainIn.isTTY = false
  const plain = createTerminal({ input: plainIn, output: plainOut })
  plain.start({ onSubmit: () => {} })
  plain.line("hello"); plain.out("a"); plain.out("b\n")
  ok("non-TTY coordinator writes plain bytes only", chunks.join("") === "hello\nab\n" && !chunks.join("").includes("\x1b"))
  plain.stop()
}

realLog("== command palette ==")
{
  ok("suggestCommand fixes typos", suggestCommand("hepl").includes("help") && suggestCommand("statsu").includes("status") && suggestCommand("chekpoints").includes("checkpoints"))
  ok("suggestCommand prefix match", suggestCommand("ag").includes("agent") && suggestCommand("ag").includes("agents"))
  ok("suggestCommand no wild guesses", suggestCommand("zzzzzzzz").length === 0)
  const names = COMMANDS.map((c) => c[0])
  for (const req of ["help", "status", "plan", "tasks", "agents", "memory", "sessions", "checkpoints", "diff", "undo", "retry", "verify", "clear", "settings", "normal", "chat", "details", "agent"]) ok(`palette has /${req}`, names.includes(req))
}

// ---------------------------------------------------------------------------
// PTY end-to-end (python3 + pty) against the mock provider. Skipped cleanly
// when python3/pty is unavailable or the mock port is busy.
realLog("== PTY end-to-end (real pseudo-terminal) ==")
const hasPy = spawnSync("python3", ["-c", "import pty, termios, fcntl"], { stdio: "ignore" }).status === 0
if (process.env.FORGE_FAST === "1") {
  realLog("  skip PTY e2e (FORGE_FAST=1)")
} else if (!hasPy) {
  realLog("  skip PTY e2e (python3 pty module unavailable)")
} else {
  const MOCK = fs.existsSync(path.join(__dirname, "mock-llm.mjs")) ? path.join(__dirname, "mock-llm.mjs") : null
  const PORT = 8797
  const mock = MOCK ? spawn(process.execPath, [MOCK], { env: { ...process.env, MOCK_PORT: String(PORT) }, stdio: "ignore" }) : null
  await new Promise((r) => setTimeout(r, 700))
  const cfgFile = path.join(HOME, "config.json")
  const env = { ...process.env, FORGE_HOME: HOME, FORGE_CONFIG: cfgFile, FORGE_ALLOW_PRIVATE_URLS: "1", HOME, NO_COLOR: "1" }
  const forge = (...args) => spawnSync(process.execPath, [path.join(FORGE_DIR, "forge.js"), ...args], { env, encoding: "utf8" })
  forge("config", "set", "activeProvider", "mock")
  forge("config", "set", "providers.mock.apiKey", "test-key-1234567890")
  forge("config", "set", "providers.mock.baseUrl", `http://127.0.0.1:${PORT}/v1`)
  forge("config", "set", "providers.mock.model", "mock-mini")
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ui-pty-"))
  const driver = `
import os, pty, sys, time, select, json, struct, fcntl, termios, signal
spec = json.load(open(sys.argv[1]))
pid, fd = pty.fork()
if pid == 0:
    os.environ.update(spec.get("env") or {})
    os.environ["TERM"] = "xterm-256color"
    os.chdir(spec["cwd"])
    os.execvp(spec["cmd"][0], spec["cmd"])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", spec.get("rows", 30), spec.get("cols", 100), 0, 0))
out = b""
def read_for(sec):
    global out
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            out += data
    return True
alive = True
for step in spec["script"]:
    k = step[0]
    if k == "wait": alive = read_for(step[1])
    elif k == "send":
        read_for(0.05); os.write(fd, step[1].encode())
    elif k == "resize":
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", step[2], step[1], 0, 0)); os.kill(pid, signal.SIGWINCH)
    elif k == "waitfor":
        end = time.time() + step[2]
        while time.time() < end and step[1].encode() not in out:
            if not read_for(0.1): break
    elif k == "kill":
        os.kill(pid, signal.SIGKILL)
    if not alive: break
read_for(0.4)
try: os.kill(pid, signal.SIGKILL)
except Exception: pass
try: os.waitpid(pid, 0)
except Exception: pass
sys.stdout.buffer.write(out)
`
  const driverFile = path.join(HOME, "drive.py")
  fs.writeFileSync(driverFile, driver)
  const run = (script, { cols = 100, rows = 30, cmd = ["chat"], timeout = 60000 } = {}) => {
    const specFile = path.join(HOME, `spec-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    fs.writeFileSync(specFile, JSON.stringify({ cmd: [process.execPath, path.join(FORGE_DIR, "forge.js"), ...cmd], env, cwd: work, cols, rows, script }))
    const r = spawnSync("python3", [driverFile, specFile], { timeout, maxBuffer: 64 * 1024 * 1024 })
    const raw = r.stdout || Buffer.alloc(0)
    const screen = createScreen(cols, rows)
    screen.feed(raw)
    return { raw: raw.toString("utf8"), screen, text: screen.all() }
  }
  const big = Array.from({ length: 300 }, (_, i) => `pasted line ${i} with some text`).join("\n")

  // 1. startup, typing while streaming, huge paste, Ctrl+C clears, Ctrl+R history, exit
  const r1 = run([
    ["wait", 2.5], ["send", "hello there\r"], ["send", "typed while streaming"], ["waitfor", "Hello from mock!", 15], ["wait", 1.0],
    ["send", "\x15"], ["send", "\x1b[200~" + big + "\x1b[201~"], ["wait", 1.0],
    ["send", "\x03"], ["wait", 0.5],
    ["send", "\x12hello"], ["wait", 0.5], ["send", "\r"], ["waitfor", "session: 10 in", 15], ["wait", 0.8],
    ["send", "/exit\r"], ["wait", 1.2],
  ])
  ok("pty: banner + answer streamed", r1.text.includes("forge v21") && r1.text.includes("Hello from mock!"))
  ok("pty: typing during streaming did not corrupt output", !r1.text.includes("typed while streamingHello") && r1.text.includes("thinking about it...Hello from mock!"))
  ok("pty: huge paste never executed line by line", !r1.text.includes("forge ❯ pasted line") && (r1.text.match(/Hello from mock!/g) || []).length === 2)
  ok("pty: Ctrl+R history recall re-sent the first message", r1.text.split("forge ❯ hello there").length === 3)
  ok("pty: raw mode released at exit", r1.raw.includes("\x1b[?2004l") && r1.text.trim().endsWith("bye"))
  ok("pty: status never repeated as lines", (r1.text.match(/Thinking/g) || []).length <= 1)

  // 2. agent run in Agent Mode → compact tool row + honest summary; /tasks
  const r2 = run([
    ["wait", 2.5], ["send", "/agent\r"], ["wait", 0.6], ["send", "USE_TOOL please run echo\r"], ["waitfor", "COMPLETED", 20], ["wait", 0.8],
    ["send", "/tasks\r"], ["wait", 0.8], ["send", "/unknowncmd\r"], ["wait", 0.5], ["send", "/exit\r"], ["wait", 1.2],
  ], { cols: 110 })
  ok("pty: mode switch acknowledged + prompt shows [agent]", r2.text.includes("Agent Mode active") && r2.text.includes("forge [agent] ❯"))
  ok("pty: compact tool row with duration", /✓ shell\s+echo forge-e2e-ok\s+\d+ms/.test(r2.text))
  ok("pty: result + COMPLETED summary", r2.text.includes("TOOL RESULT RECEIVED") && /✓ COMPLETED\s+2 steps • 1 tool calls/.test(r2.text))
  ok("pty: /tasks lists the run as completed", /RUN-[A-Z0-9]{4}\s+completed/.test(r2.text))
  ok("pty: unknown command gets a hint", r2.text.includes("unknown /unknowncmd"))

  // 3. Ctrl+C during a slow tool: honest phases
  const r3 = run([
    ["wait", 2.5], ["send", "/agent USE_DELEGATE_SLOW dispatch the slow job\r"], ["wait", 1.5], ["send", "\x03"], ["wait", 2.5], ["send", "/exit\r"], ["wait", 1.2],
  ], { cols: 110 })
  const iStop = r3.text.indexOf("Stopping"), iSafe = r3.text.indexOf("execution stopped safely")
  ok("pty: Ctrl+C shows waiting-for-tool BEFORE stopped-safely", iStop !== -1 && iSafe !== -1 && iStop < iSafe && r3.text.includes("waiting for current tool to terminate"))
  ok("pty: cancelled tool row is marked failed/cancelled", /✗ delegate/.test(r3.text) && r3.text.includes("cancelled"))
  ok("pty: prompt comes back after cancel", r3.text.includes("input restored") && r3.text.trim().endsWith("bye"))

  // 4. crash mid-run (SIGKILL) → recovery screen on next start; V then C; /tasks flags it
  run([["wait", 2.5], ["send", "/agent USE_DELEGATE_SLOW dispatch the slow job\r"], ["wait", 1.2], ["kill"]], { timeout: 20000 })
  const r4 = run([["wait", 3], ["send", "v"], ["wait", 0.8], ["send", "c"], ["wait", 0.8], ["send", "/tasks\r"], ["wait", 0.8], ["send", "/exit\r"], ["wait", 1.2]])
  ok("pty: recovery screen after crash", r4.text.includes("FORGE RECOVERY") && r4.text.includes("INTERRUPTED") && r4.text.includes("[R] Resume"))
  ok("pty: [V] verifies without running anything", r4.text.includes("nothing to verify (no files touched)"))
  ok("pty: [C] keeps as-is and says how to undo later", r4.text.includes("left as-is") && r4.text.includes("/undo --run RUN-"))
  ok("pty: nothing was replayed automatically", !r4.text.includes("SUB-AGENT REPORT") && (r4.text.match(/USE_DELEGATE_SLOW/g) || []).length <= 3)

  // 5. file-changing run → /diff, /checkpoints, /undo --run restores files
  fs.writeFileSync(path.join(work, "patch-base.txt"), "first\nold line\nthird\n")
  try { fs.unlinkSync(path.join(work, "patch-new.txt")) } catch {}
  const r5 = run([
    ["wait", 2.5], ["send", "/agent USE_PATCH apply the patch\r"], ["waitfor", "COMPLETED", 20], ["wait", 0.8],
    ["send", "/diff\r"], ["wait", 0.8], ["send", "/checkpoints\r"], ["wait", 0.8], ["send", "/undo --run\r"], ["wait", 1.2], ["send", "/exit\r"], ["wait", 1.2],
  ], { cols: 120, rows: 40 })
  ok("pty: completion shows Changes + Checkpoint", /Changes\s+2 files/.test(r5.text) && /Checkpoint\s+CP-[A-Z0-9]{4}/.test(r5.text))
  ok("pty: /diff shows a real unified diff", r5.text.includes("+++ b/patch-base.txt") && r5.text.includes("-old line") && r5.text.includes("+NEW LINE") && r5.text.includes("A  patch-new.txt"))
  ok("pty: /checkpoints lists the checkpoint", /CP-[A-Z0-9]{4}\s+\d\d:\d\d\s+2 files/.test(r5.text))
  ok("pty: /undo --run restored the files", r5.text.includes("restored 2 file(s)") && fs.readFileSync(path.join(work, "patch-base.txt"), "utf8") === "first\nold line\nthird\n" && !fs.existsSync(path.join(work, "patch-new.txt")))

  // 6. narrow terminal: header collapses, nothing overflows
  const r6 = run([["wait", 2.5], ["send", "/agent USE_TOOL please run echo\r"], ["waitfor", "COMPLETED", 20], ["wait", 0.5], ["send", "/exit\r"], ["wait", 1.0]], { cols: 40, rows: 16 })
  ok("pty: narrow terminal still completes and shows the result", r6.text.includes("COMPLETED") && r6.text.includes("forge-e2e-ok"))

  // 7. `forge agent` one-shot in a TTY: monitor mode + completion; piped stays classic
  const r7 = run([["wait", 4]], { cmd: ["agent", "USE_TOOL please run echo"], timeout: 20000 })
  ok("pty: forge agent in a TTY renders compact rows + COMPLETED", /✓ shell\s+echo forge-e2e-ok/.test(r7.text) && r7.text.includes("✓ COMPLETED"))
  const piped = spawnSync(process.execPath, [path.join(FORGE_DIR, "forge.js"), "agent", "USE_TOOL please run echo"], { env, encoding: "utf8", cwd: work, input: "" })
  ok("piped forge agent keeps the classic printer", piped.stdout.includes("[step 1] bash") && piped.stdout.includes("── result") && piped.stdout.includes("tool calls •") && !piped.stdout.includes("COMPLETED"))
  const pipedChat = spawnSync(process.execPath, [path.join(FORGE_DIR, "forge.js"), "chat"], { env, encoding: "utf8", cwd: work, input: "USE_TOOL inline please\n/exit\n" })
  ok("piped chat keeps [chat] tool lines + bye", pipedChat.stdout.includes("[chat] bash") && pipedChat.stdout.trim().endsWith("bye") && !pipedChat.stdout.includes("\x1b[?2004h"))

  try { mock?.kill() } catch {}
  fs.rmSync(work, { recursive: true, force: true })
}

realLog(`\n== ui suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
