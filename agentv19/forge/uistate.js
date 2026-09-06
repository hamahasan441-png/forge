/**
 * forge — central UI state (zero dependencies)
 *
 *   events  →  reduce()  →  UIState  →  renderers (render.js)  →  terminal.js
 *
 * The interactive terminal never guesses what forge is doing: every subsystem
 * reports through events, the reducer folds them into ONE state object, and
 * the renderer derives the screen from that state. Nothing in here touches the
 * terminal, which is what makes the whole model unit-testable.
 *
 * UIState
 * ├─ mode          chat | agent | plan | recovery         (what the user chose)
 * ├─ state         READY THINKING PLANNING EXECUTING VERIFYING RECOVERING
 * │                WAITING COMPLETED FAILED CANCELLED    (what forge is doing)
 * ├─ task          { id, title, kind, startedAt, endedAt, step }
 * ├─ plan          [{ n, text, status: todo|doing|done|failed }]
 * ├─ activity      recent tool executions (ring buffer)
 * ├─ tools         per-tool aggregates
 * ├─ workers       sub-agents
 * ├─ changes       { path: { action, added, removed } }   (session-cumulative)
 * ├─ tests         last test run (real counts, never fabricated)
 * ├─ verification  checks actually performed this task
 * ├─ repair        diagnose → fix → re-verify attempts
 * ├─ checkpoint    newest checkpoint id (+ list for this task)
 * ├─ recovery      interrupted-run prompt, when one is open
 * ├─ cancel        Ctrl-C phase: requested | waiting | stopped
 * ├─ input         { length, lines, cursor, mode }         (metadata only)
 * └─ terminal      { columns, rows, tty }
 *
 * bridgeAgentEvent() adapts the agent loop's existing event stream
 * (tool_start / tool_result / reasoning / retry / failover / info / compacted /
 * run_start / step / run_end) into the structured UI events below, adding what
 * the loop itself does not know: which files changed and by how much, which
 * checkpoint was written, whether a shell command was a test/build/lint run
 * and how it went.
 */
import fs from "node:fs"
import path from "node:path"
import { WRITE_TOOLS } from "./tools.js"
import { listCheckpoints } from "./checkpoint.js"
import { parsePatch } from "./diffpatch.js"
import { diffStats } from "./textdiff.js"
import { redact } from "./secrets.js"

export const STATES = ["READY", "THINKING", "PLANNING", "EXECUTING", "VERIFYING", "RECOVERING", "WAITING", "COMPLETED", "FAILED", "CANCELLED"]
export const MODES = ["chat", "agent", "plan", "recovery"]

export const EVENTS = [
  "TASK_STARTED", "PLAN_UPDATED", "STEP_STARTED", "TOOL_STARTED", "TOOL_OUTPUT", "TOOL_COMPLETED",
  "FILE_CHANGED", "TEST_STARTED", "TEST_COMPLETED", "CHECKPOINT_CREATED", "ERROR",
  "RECOVERY_STARTED", "RECOVERY_COMPLETED", "TASK_COMPLETED", "TASK_FAILED", "USER_INTERRUPTED",
  // supplementary
  "MODE_CHANGED", "STATE_CHANGED", "PROVIDER_CHANGED", "WORKER_STARTED", "WORKER_COMPLETED",
  "NOTICE", "THOUGHT", "TERMINAL_RESIZED", "INPUT_CHANGED", "TASK_RESET", "REPAIR_ATTEMPT", "STREAMING",
  // v20.5 tool intelligence layer
  "VERIFICATION_RECORDED",
]

const ACTIVITY_CAP = 60
const DETAILS_CAP = 12
const DETAILS_BYTES = 256 * 1024
const ERRORS_CAP = 20
const BEFORE_CAP_BYTES = 512 * 1024 // per-file "before" snapshot kept for /diff
const BEFORE_FILES_CAP = 60

export function initialState(over = {}) {
  return {
    mode: "chat",
    state: "READY",
    provider: "",
    model: "",
    cwd: process.cwd(),
    session: null,
    task: null,
    lastTask: null,
    plan: [],
    activity: [],
    tools: {},
    workers: [],
    changes: {},
    tests: null,
    verification: { checks: {} },
    repair: null,
    checkpoint: null,
    checkpoints: [],
    recovery: null,
    cancel: null,
    errors: [],
    lastError: null,
    notices: [],
    thought: "",
    details: [],
    result: null,
    waitingFor: "",
    recoveryNote: "",
    input: { length: 0, lines: 1, cursor: 0, mode: "edit" },
    terminal: { columns: 80, rows: 24, tty: false },
    streaming: false,
    seq: 0,
    ...over,
  }
}

const TERMINAL_STATES = new Set(["READY", "COMPLETED", "FAILED", "CANCELLED"])
export function isBusy(state) {
  return !!state.task && !TERMINAL_STATES.has(state.state)
}

function runningCount(activity) {
  let n = 0
  for (const a of activity) if (!a.endedAt) n++
  return n
}

/** Pure reducer: (state, event) → state. Unknown events are ignored. */
export function reduce(s, ev) {
  const t = ev?.type
  if (!t) return s
  const now = ev.at ?? Date.now()
  switch (t) {
    case "MODE_CHANGED":
      return { ...s, mode: MODES.includes(ev.mode) ? ev.mode : s.mode }
    case "STATE_CHANGED":
      return { ...s, state: STATES.includes(ev.state) ? ev.state : s.state, waitingFor: ev.state === "WAITING" ? ev.waitingFor || s.waitingFor : "", recoveryNote: ev.state === "RECOVERING" ? ev.note || s.recoveryNote : "" }
    case "PROVIDER_CHANGED":
      return { ...s, provider: ev.provider ?? s.provider, model: ev.model ?? s.model }
    case "TERMINAL_RESIZED":
      return { ...s, terminal: { ...s.terminal, columns: ev.columns ?? s.terminal.columns, rows: ev.rows ?? s.terminal.rows, tty: ev.tty ?? s.terminal.tty } }
    case "INPUT_CHANGED":
      return { ...s, input: { ...s.input, ...ev.input } }
    case "NOTICE":
      return { ...s, notices: [...s.notices.slice(-19), { text: ev.text, level: ev.level || "info", at: now }] }
    case "THOUGHT":
      return { ...s, thought: String(ev.text || "").split("\n")[0].slice(0, 160) }
    case "STREAMING":
      return s.streaming === !!ev.on ? s : { ...s, streaming: !!ev.on }

    case "TASK_STARTED": {
      const kind = ev.kind || "agent"
      return {
        ...s,
        task: { id: ev.id || null, title: String(ev.title || "").replace(/\s+/g, " ").trim().slice(0, 200), kind, startedAt: ev.startedAt ?? now, endedAt: null, step: 0, sub: !!ev.sub },
        state: kind === "plan" ? "PLANNING" : "THINKING",
        plan: kind === "chat" ? s.plan : [],
        activity: [],
        tools: {},
        workers: [],
        tests: null,
        verification: { checks: {} },
        repair: null,
        checkpoint: null,
        checkpoints: [],
        cancel: null,
        errors: [],
        lastError: null,
        thought: "",
        result: null,
        recovery: null,
        streaming: false,
      }
    }
    case "STEP_STARTED": {
      if (!s.task) return s
      const running = runningCount(s.activity)
      return { ...s, task: { ...s.task, step: ev.step ?? s.task.step + 1 }, state: running ? s.state : (s.task.kind === "plan" ? "PLANNING" : "THINKING"), thought: "" }
    }
    case "PLAN_UPDATED":
      return { ...s, plan: Array.isArray(ev.items) ? ev.items.map((it, i) => ({ n: it.n ?? i + 1, text: String(it.text || "").slice(0, 160), status: ["todo", "doing", "done", "failed"].includes(it.status) ? it.status : "todo", children: it.children })) : s.plan }

    case "TOOL_STARTED": {
      const entry = {
        id: ev.id || `t${s.seq + 1}`, name: ev.name, label: ev.label || ev.name, target: ev.target || "", startedAt: ev.startedAt ?? now,
        endedAt: null, ms: null, ok: null, exit: null, lines: 0, hidden: 0, summary: [], check: ev.check || null, worker: ev.worker ?? null, step: ev.step ?? s.task?.step ?? 0,
      }
      const activity = [...s.activity, entry].slice(-ACTIVITY_CAP)
      const tools = { ...s.tools, [ev.name]: { ...(s.tools[ev.name] || { calls: 0, ok: 0, fail: 0, lastMs: null }), calls: (s.tools[ev.name]?.calls || 0) + 1, running: true } }
      const isCheck = !!ev.check
      const next = { ...s, activity, tools, seq: s.seq + 1 }
      if (s.task) next.state = isCheck ? "VERIFYING" : (s.task.kind === "plan" ? "PLANNING" : "EXECUTING")
      if (ev.check === "tests") next.tests = { running: true, command: ev.target || "", passed: null, failed: null, ok: null, at: now }
      return next
    }
    case "TOOL_OUTPUT": {
      const i = s.activity.findIndex((a) => a.id === ev.id)
      if (i === -1) return s
      const a = s.activity[i]
      const out = (a.partial || "") + String(ev.chunk || "")
      const activity = s.activity.slice()
      activity[i] = { ...a, partial: out.length > 64 * 1024 ? out.slice(-64 * 1024) : out }
      return { ...s, activity }
    }
    case "TOOL_COMPLETED": {
      const i = s.activity.findIndex((a) => a.id === ev.id)
      const base = i === -1 ? { id: ev.id, name: ev.name, label: ev.name, target: ev.target || "", startedAt: (ev.endedAt ?? now) - (ev.ms || 0), check: ev.check || null, step: s.task?.step ?? 0 } : s.activity[i]
      const done = { ...base, endedAt: ev.endedAt ?? now, ms: ev.ms ?? ((ev.endedAt ?? now) - base.startedAt), ok: ev.ok !== false, exit: ev.exit ?? null, lines: ev.lines ?? 0, hidden: ev.hidden ?? 0, summary: ev.summary ?? [], check: ev.check ?? base.check, partial: undefined }
      const activity = s.activity.slice()
      if (i === -1) activity.push(done); else activity[i] = done
      const agg = s.tools[done.name] || { calls: 1, ok: 0, fail: 0, lastMs: null }
      const tools = { ...s.tools, [done.name]: { ...agg, ok: agg.ok + (done.ok ? 1 : 0), fail: agg.fail + (done.ok ? 0 : 1), lastMs: done.ms, running: activity.some((a) => a.name === done.name && !a.endedAt) } }
      let details = s.details
      if (ev.output) {
        const text = String(ev.output)
        details = [...s.details, { id: done.id, name: done.name, target: done.target, ok: done.ok, text: text.length > DETAILS_BYTES ? text.slice(0, DETAILS_BYTES) + `\n… (${text.length} bytes total)` : text, at: done.endedAt }].slice(-DETAILS_CAP)
      }
      const next = { ...s, activity, tools, details }
      // checks actually performed → verification + tests + repair loop tracking
      const kind = done.check
      if (kind && ev.checkResult) {
        const r = ev.checkResult
        next.verification = { checks: { ...s.verification.checks, [kind]: { ok: r.ok, passed: r.passed ?? null, failed: r.failed ?? null, summary: r.summary || "", command: done.target, at: done.endedAt } } }
        if (kind === "tests") next.tests = { running: false, command: done.target, passed: r.passed ?? null, failed: r.failed ?? null, ok: r.ok, at: done.endedAt }
        next.repair = trackRepair(s.repair, { kind, ok: r.ok, summary: r.summary || "", target: done.target, at: done.endedAt })
      }
      if (s.task && runningCount(activity) === 0 && (next.state === "VERIFYING" || next.state === "EXECUTING")) {
        next.state = s.task.kind === "plan" ? "PLANNING" : "EXECUTING"
      }
      if (!done.ok) {
        const summary = (done.summary || []).join(" ").slice(0, 200)
        next.lastError = { title: `${done.label || done.name} failed`, summary, exit: done.exit, at: done.endedAt, toolId: done.id }
      }
      return next
    }
    case "FILE_CHANGED": {
      const p = String(ev.path)
      const prev = s.changes[p]
      const action = prev?.action === "created" && ev.action !== "deleted" ? "created" : ev.action || "modified"
      const entry = { path: p, action, added: (prev?.added || 0) + (ev.added || 0), removed: (prev?.removed || 0) + (ev.removed || 0), at: now, taskId: s.task?.id ?? null }
      const repair = s.repair && s.repair.open ? { ...s.repair, edits: [...new Set([...(s.repair.edits || []), path.basename(p)])].slice(0, 8) } : s.repair
      return { ...s, changes: { ...s.changes, [p]: entry }, repair }
    }
    // v20.5: a verification check the tool intelligence layer actually ran
    // (syntax / types / lint / tests / build …). Only real checks land here.
    case "VERIFICATION_RECORDED": {
      if (!ev.kind) return s
      const prev = s.verification.checks[ev.kind]
      const entry = { ok: ev.ok ?? null, passed: ev.passed ?? prev?.passed ?? null, failed: ev.failed ?? prev?.failed ?? null, summary: String(ev.summary ?? "").slice(0, 160), command: ev.target ?? prev?.command ?? "", at: now }
      const next = { ...s, verification: { checks: { ...s.verification.checks, [ev.kind]: entry } } }
      next.repair = trackRepair(s.repair, { kind: ev.kind, ok: entry.ok, summary: entry.summary, target: entry.command, at: now })
      return next
    }
    case "TEST_STARTED":
      return { ...s, tests: { running: true, command: ev.command || "", passed: null, failed: null, ok: null, at: now }, state: s.task ? "VERIFYING" : s.state }
    case "TEST_COMPLETED":
      return { ...s, tests: { running: false, command: ev.command || s.tests?.command || "", passed: ev.passed ?? null, failed: ev.failed ?? null, ok: ev.ok !== false, at: now } }
    case "CHECKPOINT_CREATED":
      if (!ev.id || s.checkpoints.includes(ev.id)) return s
      return { ...s, checkpoint: ev.id, checkpoints: [...s.checkpoints, ev.id] }

    case "WORKER_STARTED": {
      const n = s.workers.length + 1
      return { ...s, workers: [...s.workers, { id: ev.id ?? n, n, role: ev.role || "worker", task: String(ev.task || "").slice(0, 200), status: "running", startedAt: ev.startedAt ?? now, endedAt: null, activity: [] }] }
    }
    case "WORKER_COMPLETED": {
      const workers = s.workers.map((w) => (w.id === ev.id && !w.endedAt ? { ...w, status: ev.ok === false ? "failed" : "done", endedAt: ev.endedAt ?? now, report: ev.report ? String(ev.report).slice(0, 4000) : w.report } : w))
      return { ...s, workers }
    }

    case "ERROR": {
      const e = { title: ev.title || "ERROR", summary: ev.summary || "", cause: ev.cause || "", details: ev.details || "", actions: ev.actions || [], at: now }
      return { ...s, errors: [...s.errors, e].slice(-ERRORS_CAP), lastError: e }
    }
    case "REPAIR_ATTEMPT":
      return { ...s, repair: trackRepair(s.repair, { kind: ev.kind || "tests", ok: ev.ok, summary: ev.summary || "", at: now }) }

    case "TASK_COMPLETED": {
      if (!s.task) return s
      const endedAt = ev.endedAt ?? now
      return { ...s, state: "COMPLETED", task: { ...s.task, endedAt }, result: { text: ev.text ?? "", steps: ev.steps ?? s.task.step, toolCalls: ev.toolCalls ?? s.activity.length, wrote: !!ev.wrote, runId: ev.runId ?? s.task.id, endedAt } }
    }
    case "TASK_FAILED": {
      if (!s.task) return s
      const endedAt = ev.endedAt ?? now
      const e = { title: "TASK FAILED", summary: String(ev.reason || "unknown error").slice(0, 400), cause: ev.cause || "", details: ev.details || "", at: endedAt }
      return { ...s, state: "FAILED", task: { ...s.task, endedAt }, lastError: e, errors: [...s.errors, e].slice(-ERRORS_CAP), result: { text: "", steps: ev.steps ?? s.task.step, toolCalls: s.activity.length, wrote: !!ev.wrote, runId: s.task.id, endedAt, failed: true } }
    }
    case "USER_INTERRUPTED": {
      const phase = ev.phase || "requested"
      const cancel = { phase, at: now, tool: ev.tool || runningTool(s.activity) }
      if (phase === "stopped") {
        return { ...s, cancel, state: s.task ? "CANCELLED" : "READY", task: s.task ? { ...s.task, endedAt: now } : null, result: s.task ? { text: "", steps: s.task.step, toolCalls: s.activity.length, wrote: false, runId: s.task.id, endedAt: now, cancelled: true } : s.result }
      }
      return { ...s, cancel }
    }
    case "TASK_RESET": {
      const lastTask = s.task ? { title: s.task.title, status: s.state === "COMPLETED" ? "ok" : s.state === "CANCELLED" ? "cancelled" : s.state === "FAILED" ? "failed" : "ended", id: s.task.id, endedAt: s.task.endedAt } : s.lastTask
      return { ...s, state: "READY", task: null, lastTask, cancel: null, thought: "", recovery: null, waitingFor: "", streaming: false }
    }

    case "RECOVERY_STARTED":
      return { ...s, recovery: { run: ev.run, phase: ev.phase || "prompt", at: now }, state: "RECOVERING", recoveryNote: ev.note || "Interrupted task found" }
    case "RECOVERY_COMPLETED":
      return { ...s, recovery: null, state: s.task && !TERMINAL_STATES.has(s.state) && s.state !== "RECOVERING" ? s.state : "READY", recoveryNote: "" }

    default:
      return s
  }
}

function runningTool(activity) {
  for (let i = activity.length - 1; i >= 0; i--) if (!activity[i].endedAt) return `${activity[i].label || activity[i].name} ${activity[i].target || ""}`.trim()
  return ""
}

/** Repair-loop bookkeeping: a failed check opens a repair; edits are the
 *  diagnosis evidence; the next run of the same check is the next attempt. */
function trackRepair(repair, { kind, ok, summary, target, at }) {
  if (!repair) {
    if (ok) return null
    return { kind, open: true, edits: [], attempts: [{ n: 1, ok: false, summary: `${target ? target + ": " : ""}${summary}`.trim(), at }] }
  }
  if (repair.kind !== kind) return repair
  const n = repair.attempts.length + 1
  const last = repair.attempts[repair.attempts.length - 1]
  const diagnosis = repair.edits?.length ? `edited ${repair.edits.join(", ")}` : ""
  const attempts = [...repair.attempts.slice(0, -1), { ...last, diagnosis: last.diagnosis || diagnosis || last.diagnosis }, { n, ok, summary: `${target ? target + ": " : ""}${summary}`.trim(), at }]
  return { ...repair, open: !ok, edits: [], attempts }
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export function createUIStore(initial) {
  let state = initialState(initial)
  const subs = new Set()
  const store = {
    get state() { return state },
    dispatch(ev) {
      if (!ev || !ev.type) return state
      const next = reduce(state, ev)
      const changed = next !== state
      state = next
      for (const fn of subs) {
        try { fn(state, ev, changed) } catch { /* a listener must never break the loop */ }
      }
      return state
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn) },
    replace(next) { state = next },
  }
  return store
}

// ---------------------------------------------------------------------------
// tool metadata: targets, checks, summaries
// ---------------------------------------------------------------------------

function firstLine(s) { return String(s ?? "").split("\n")[0] }

/** Human target for a tool call: the path / command / pattern it acts on. */
export function toolTarget(name, args) {
  const a = args && typeof args === "object" ? args : {}
  let t = ""
  switch (name) {
    case "bash": t = firstLine(a.command); break
    case "read_file": case "write_file": case "edit_file": case "multi_edit": case "list_dir": t = a.path ?? ""; break
    case "grep_files": t = `${a.pattern ?? ""}${a.path ? "  in " + a.path : ""}`; break
    case "glob_files": t = `${a.pattern ?? ""}${a.path ? "  in " + a.path : ""}`; break
    case "fetch_url": t = a.url ?? ""; break
    case "web_search": t = a.query ?? ""; break
    case "load_skill": t = a.name ?? ""; break
    case "apply_patch": {
      try { t = parsePatch(String(a.patch ?? "")).map((f) => (f.oldPath === "/dev/null" ? f.newPath : f.newPath === "/dev/null" ? f.oldPath : f.newPath || f.oldPath)).filter(Boolean).join(", ") } catch { t = "(patch)" }
      break
    }
    case "todo": t = a.action ?? "list"; break
    case "think": t = firstLine(a.thought); break
    case "memory": t = `${a.action ?? "read"}${a.scope ? " " + a.scope : ""}`; break
    case "delegate": t = `${a.role ?? "researcher"}: ${firstLine(a.task)}`; break
    case "git_status": t = ""; break
    default: t = firstLine(JSON.stringify(a)).slice(0, 80)
  }
  return redact(String(t ?? "")).replace(/\s+/g, " ").slice(0, 160)
}

const CHECK_PATTERNS = [
  ["tests", /(^|[\s;&|])(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|(^|[\s;&|])(pytest|py\.test|jest|vitest|mocha|ava|tap|karma)\b|(^|[\s;&|])go\s+test\b|(^|[\s;&|])cargo\s+test\b|(^|[\s;&|])node\s+(--test|.*test[-_a-z]*\.m?js)|(^|[\s;&|])make\s+(test|check)\b|(^|[\s;&|])(rspec|phpunit|dotnet\s+test|gradle\w*\s+test|mvn\s+test|ctest)\b|(^|[\s;&|])python3?\s+-m\s+(pytest|unittest)\b/],
  ["types", /(^|[\s;&|])(tsc|mypy|pyright|flow)\b|(^|[\s;&|])(npm|pnpm|yarn)\s+run\s+(typecheck|type-check|types)\b/],
  ["lint", /(^|[\s;&|])(eslint|ruff|flake8|pylint|golangci-lint|clippy|stylelint|biome|prettier\s+--check)\b|(^|[\s;&|])cargo\s+clippy\b|(^|[\s;&|])(npm|pnpm|yarn)\s+run\s+lint\b/],
  ["build", /(^|[\s;&|])(npm|pnpm|yarn|bun)\s+run\s+build\b|(^|[\s;&|])(make|cmake|ninja)\b(?!\s+(test|check))|(^|[\s;&|])go\s+build\b|(^|[\s;&|])cargo\s+build\b|(^|[\s;&|])(gradle\w*|mvn)\s+(build|package|compile)\b|(^|[\s;&|])dotnet\s+build\b|(^|[\s;&|])webpack\b|(^|[\s;&|])vite\s+build\b/],
  ["syntax", /(^|[\s;&|])node\s+--check\b|(^|[\s;&|])python3?\s+-m\s+py_compile\b|(^|[\s;&|])(bash|sh)\s+-n\b|(^|[\s;&|])ruby\s+-c\b|(^|[\s;&|])php\s+-l\b/],
]

/** Which verification check (if any) a shell command performs. */
export function classifyCheck(command) {
  const c = String(command ?? "")
  for (const [kind, re] of CHECK_PATTERNS) if (re.test(c)) return kind
  return null
}

const num = (m, i = 1) => (m ? Number(m[i]) : null)

/** Parse real counts out of a check's output. Never invents numbers. */
export function parseCheckOutput(kind, output) {
  const out = String(output ?? "")
  const exitM = out.match(/\[exit code: (\d+)\]\s*$/)
  const exit = exitM ? Number(exitM[1]) : (/\[command timed out/.test(out) ? 124 : 0)
  let passed = null, failed = null
  let m
  if ((m = out.match(/Tests:\s+(?:(\d+) failed, )?(?:(\d+) skipped, )?(?:(\d+) todo, )?(\d+) passed/))) { failed = Number(m[1] || 0); passed = Number(m[4]) }
  else if ((m = out.match(/test result: (ok|FAILED)\. (\d+) passed; (\d+) failed/))) { passed = Number(m[2]); failed = Number(m[3]) }
  else if ((m = out.match(/^# pass (\d+)/m))) { passed = Number(m[1]); const f = out.match(/^# fail (\d+)/m); failed = f ? Number(f[1]) : 0 }
  else if ((m = out.match(/(\d+) passing/))) { passed = Number(m[1]); const f = out.match(/(\d+) failing/); failed = f ? Number(f[1]) : 0 }
  else {
    const p = out.match(/(\d+) passed/), f = out.match(/(\d+) failed/)
    if (p || f) { passed = num(p) ?? 0; failed = num(f) ?? 0 }
    else if (/^(ok|FAIL)\s+\S+/m.test(out) && kind === "tests") {
      const pass = (out.match(/^--- PASS/gm) || []).length, fail = (out.match(/^--- FAIL/gm) || []).length
      if (pass || fail) { passed = pass; failed = fail }
    }
  }
  const ok = exit === 0 && !(failed > 0)
  let summary = ""
  if (passed != null) summary = `${passed} passed${failed ? `, ${failed} failed` : ""}`
  else if (kind === "tests") summary = ok ? "passed" : `failed (exit ${exit})`
  else summary = ok ? "passed" : `exit ${exit}`
  return { ok, exit, passed, failed, summary }
}

/** Parse the todo tool's rendered list into plan items. */
export function parseTodo(result) {
  const items = []
  for (const line of String(result ?? "").split("\n")) {
    const m = line.match(/^\[( |~|x)\]\s+(\d+)\.\s+(.*)$/)
    if (!m) continue
    items.push({ n: Number(m[2]), text: m[3].trim(), status: m[1] === "x" ? "done" : m[1] === "~" ? "doing" : "todo" })
  }
  return items
}

const COLLAPSE_LINES = 12
const COLLAPSE_CHARS = 1200
const ERROR_LINE_RE = /\b(error|failed|failing|exception|traceback|cannot|not found|denied|refused|fatal|panic)\b/i

/** Compact representation of a finished tool call. */
export function summarizeToolResult(name, result) {
  const text = String(result ?? "")
  const ok = !(text.startsWith("ERROR") || text.startsWith("BLOCKED"))
  const exitM = text.match(/\[exit code: (\d+)\]\s*$/)
  const exit = exitM ? Number(exitM[1]) : (/\[command timed out/.test(text) ? 124 : (ok ? 0 : null))
  const allLines = text.split("\n")
  const lines = allLines.length
  const failed = !ok || (exit != null && exit !== 0)
  let summary = []
  if (failed) {
    const errs = allLines.filter((l) => ERROR_LINE_RE.test(l)).slice(-3)
    const head = allLines.filter((l) => l.trim()).slice(0, 2)
    summary = [...new Set([...head, ...errs])].slice(0, 5)
  } else if (name === "bash" && classifyCheck(text) === null) {
    summary = allLines.filter((l) => l.trim()).slice(0, 2)
  } else {
    summary = allLines.filter((l) => l.trim()).slice(0, 2)
  }
  summary = summary.map((l) => l.replace(/\s+/g, " ").slice(0, 120))
  const collapsed = lines > COLLAPSE_LINES || text.length > COLLAPSE_CHARS
  const hidden = collapsed ? Math.max(0, lines - summary.length) : 0
  return { ok: !failed, exit, lines, summary, hidden, text }
}

// ---------------------------------------------------------------------------
// agent-event bridge
// ---------------------------------------------------------------------------

/**
 * Per-bridge context: pending "before" snapshots for write tools (so a
 * completed edit can report +added/-removed), and the cwd used to resolve
 * relative paths and look up checkpoints.
 */
export function createBridgeContext({ cwd = process.cwd(), snapshots = true } = {}) {
  return { cwd, snapshots, before: new Map(), beforeOrder: [], pendingWrites: new Map(), ids: 0, workerIds: new Map() }
}

function resolveWithin(cwd, p) {
  const s = String(p ?? "")
  if (!s) return null
  const home = process.env.HOME || ""
  const expanded = s === "~" ? home : s.startsWith("~/") && home ? path.join(home, s.slice(2)) : s
  return path.resolve(cwd, expanded)
}

function safeArgs(args) {
  if (args && typeof args === "object") return args
  try { return JSON.parse(String(args ?? "{}")) || {} } catch { return {} }
}

function writeTargets(name, args, cwd) {
  const a = safeArgs(args)
  if (name === "write_file" || name === "edit_file" || name === "multi_edit") {
    const p = resolveWithin(cwd, a.path)
    return p ? [p] : []
  }
  if (name === "apply_patch") {
    try {
      return parsePatch(String(a.patch ?? "")).map((f) => resolveWithin(cwd, f.oldPath === "/dev/null" ? f.newPath : f.newPath === "/dev/null" ? f.oldPath : f.newPath || f.oldPath)).filter(Boolean)
    } catch { return [] }
  }
  return []
}

function readBounded(p) {
  try {
    const st = fs.statSync(p)
    if (!st.isFile()) return { exists: false, text: null }
    if (st.size > BEFORE_CAP_BYTES) return { exists: true, text: null, size: st.size }
    return { exists: true, text: fs.readFileSync(p, "utf8"), size: st.size }
  } catch {
    return { exists: false, text: null }
  }
}

function rememberBefore(bctx, p, snap) {
  if (bctx.before.has(p)) return // the FIRST snapshot in a session is the baseline for /diff
  bctx.before.set(p, snap)
  bctx.beforeOrder.push(p)
  while (bctx.beforeOrder.length > BEFORE_FILES_CAP) bctx.before.delete(bctx.beforeOrder.shift())
}

/** Baseline content for /diff (null when unknown or too large). */
export function baselineFor(bctx, p) {
  return bctx?.before.get(path.resolve(bctx.cwd, p)) ?? null
}

/**
 * Adapt one agent event into UI events. Returns the events dispatched (useful
 * in tests). Side effects: reads files for before/after diff stats, reads the
 * newest checkpoint manifest after a write.
 */
export function bridgeAgentEvent(store, ev, bctx = createBridgeContext()) {
  const out = []
  const emit = (e) => { out.push(e); store.dispatch(e) }
  if (!ev || !ev.type) return out
  const now = Date.now()
  // sub-agent events: only run_start / run_end matter (as workers); their
  // inner tool traffic is kept per worker, not in the main activity list.
  if (ev.sub) {
    if (ev.type === "run_start") {
      emit({ type: "WORKER_STARTED", id: ev.sub, role: ev.role || "worker", task: ev.task, startedAt: now })
    } else if (ev.type === "run_end") {
      emit({ type: "WORKER_COMPLETED", id: ev.sub, ok: ev.status === "completed", report: ev.text, endedAt: now })
    }
    return out
  }
  switch (ev.type) {
    case "run_start":
      emit({ type: "TASK_STARTED", id: ev.runId || null, title: ev.task, kind: ev.planOnly ? "plan" : "agent", startedAt: now })
      break
    case "step":
      emit({ type: "STEP_STARTED", step: ev.step })
      break
    case "reasoning":
      emit({ type: "THOUGHT", text: ev.text })
      break
    case "tool_start": {
      const args = safeArgs(ev.args)
      const id = `t${++bctx.ids}`
      const key = `${ev.name}|${ev.step}|${ev.args}`
      bctx.pendingWrites.set(key, id)
      const check = ev.name === "bash" ? classifyCheck(args.command) : null
      if (WRITE_TOOLS.has(ev.name) && ev.name !== "bash" && bctx.snapshots) {
        for (const p of writeTargets(ev.name, args, bctx.cwd)) rememberBefore(bctx, p, readBounded(p))
        // per-call "before" for accurate +/- of THIS edit (baseline above is for /diff)
        bctx.pendingWrites.set(id, writeTargets(ev.name, args, bctx.cwd).map((p) => [p, readBounded(p)]))
      }
      emit({ type: "TOOL_STARTED", id, name: ev.name, target: toolTarget(ev.name, args), check, step: ev.step, startedAt: now })
      break
    }
    case "tool_result": {
      const key = `${ev.name}|${ev.step}|${ev.args ?? ""}`
      // tool_result events do not carry args: match the oldest running entry with the same name
      let id = null
      const st = store.state
      for (const a of st.activity) if (a.name === ev.name && !a.endedAt) { id = a.id; break }
      if (!id) id = bctx.pendingWrites.get(key) || `t${++bctx.ids}`
      const sum = summarizeToolResult(ev.name, ev.result)
      const args = safeArgs(ev.args)
      let check = null, checkResult = null
      const entry = st.activity.find((a) => a.id === id)
      if (entry?.check) { check = entry.check; checkResult = parseCheckOutput(check, ev.result) }
      emit({ type: "TOOL_COMPLETED", id, name: ev.name, ok: sum.ok, exit: sum.exit, ms: ev.ms, lines: sum.lines, summary: sum.summary, hidden: sum.hidden, output: sum.text, check, checkResult, endedAt: now })
      // derived: plan, file changes, checkpoints
      if (ev.name === "todo" && sum.ok) {
        const items = parseTodo(ev.result)
        if (items.length) emit({ type: "PLAN_UPDATED", items })
      }
      if (WRITE_TOOLS.has(ev.name) && ev.name !== "bash" && sum.ok && String(ev.result).startsWith("OK")) {
        const befores = bctx.pendingWrites.get(id) || []
        bctx.pendingWrites.delete(id)
        const seen = new Set()
        for (const [p, before] of befores) {
          seen.add(p)
          const after = readBounded(p)
          let action = before.exists ? (after.exists ? "modified" : "deleted") : "created"
          let added = 0, removed = 0
          if (before.text != null && after.text != null) ({ added, removed } = diffStats(before.text, after.text))
          else if (!before.exists && after.text != null) added = after.text.split("\n").length - (after.text.endsWith("\n") ? 1 : 0)
          else if (before.text != null && !after.exists) removed = before.text.split("\n").length - (before.text.endsWith("\n") ? 1 : 0)
          emit({ type: "FILE_CHANGED", path: p, action, added, removed })
        }
        if (!befores.length) for (const p of writeTargets(ev.name, args, bctx.cwd)) if (!seen.has(p)) emit({ type: "FILE_CHANGED", path: p, action: "modified", added: 0, removed: 0 })
        try {
          const ck = listCheckpoints(bctx.cwd, 1)[0]
          if (ck && (!st.checkpoint || ck.id !== st.checkpoint) && ck.ts >= (st.task?.startedAt ?? 0) - 1000) emit({ type: "CHECKPOINT_CREATED", id: ck.id, runId: ck.runId ?? null })
        } catch { /* best-effort */ }
      }
      break
    }
    case "retry":
      emit({ type: "NOTICE", level: "warn", text: `transient provider error (${ev.error}) — retrying${ev.left != null ? ` (${ev.left} left)` : ""}` })
      break
    case "failover":
      emit({ type: "NOTICE", level: "warn", text: `provider failover: ${ev.from} failed (${String(ev.reason).slice(0, 80)}) → ${ev.to}` })
      if (ev.to) { const [provider, model] = String(ev.to).split("/"); emit({ type: "PROVIDER_CHANGED", provider, model }) }
      break
    case "info":
      emit({ type: "NOTICE", level: "info", text: String(ev.text || "") })
      break
    case "compacted":
      emit({ type: "NOTICE", level: "warn", text: ev.after === -1 ? `${ev.reason ?? "context overflow"} (~${ev.estTok} tok) — compressing and retrying` : `context compacted: ${ev.before} → ${ev.after} messages${ev.shrunk ? ` (tool outputs shrunk ~${Math.round(ev.shrunk / 1024)}KB)` : ""}` })
      break
    // ---- v20.5 tool intelligence layer -----------------------------------
    // TOOL_STARTED/OUTPUT/COMPLETED/FAILED/SELECTED are already derived above
    // from tool_start/tool_result — only the events that carry NEW information
    // are bridged, so no row is ever rendered twice.
    case "TOOL_VERIFIED": {
      for (const c of ev.checks ?? []) {
        if (c.skipped || c.ok === null) continue
        if (c.kind === "syntax") emit({ type: "VERIFICATION_RECORDED", kind: "syntax", ok: c.ok, summary: c.detail, target: c.target })
      }
      if (ev.ok === false) emit({ type: "NOTICE", level: "warn", text: `verification failed after ${ev.tool}: ${String(ev.summary).slice(0, 160)}` })
      else if ((ev.checks ?? []).length) emit({ type: "NOTICE", level: "info", text: `verified ${ev.tool}: ${String(ev.summary).slice(0, 120)}` })
      break
    }
    case "TOOL_BLOCKED":
      emit({ type: "NOTICE", level: ev.conflict ? "info" : "warn", text: `${ev.tool ?? "tool"} ${ev.conflict ? "serialized" : "blocked"}: ${String(ev.reason ?? "").slice(0, 160)}` })
      break
    // §17 — forge wants a human decision. That is a QUESTION, not a refusal.
    case "TOOL_ESCALATION":
      emit({ type: "NOTICE", level: "warn", text: `needs your decision (${ev.tool}): ${String(ev.question ?? "").slice(0, 160)}` })
      break
    case "TOOL_RETRY":
      emit({ type: "NOTICE", level: "warn", text: `${ev.tool} retry ${ev.attempt}: ${String(ev.reason ?? "").slice(0, 120)}` })
      break
    case "TOOL_FALLBACK":
      emit({ type: "NOTICE", level: "info", text: `${ev.tool}${ev.alternative ? ` → ${ev.alternative}` : ""}: ${String(ev.reason ?? "").slice(0, 140)}` })
      break
    case "TOOL_CACHED":
      emit({ type: "NOTICE", level: "info", text: `${ev.tool}: ${String(ev.reason ?? "cached").slice(0, 120)}` })
      break
    case "run_end": {
      if (ev.status === "completed") emit({ type: "TASK_COMPLETED", text: ev.text, steps: ev.steps, toolCalls: ev.toolCalls, wrote: ev.wrote, runId: ev.runId, endedAt: now })
      else if (ev.status === "cancelled") emit({ type: "USER_INTERRUPTED", phase: "stopped" })
      else emit({ type: "TASK_FAILED", reason: ev.error || "agent run failed", steps: ev.steps, wrote: ev.wrote, endedAt: now })
      break
    }
    default:
      break
  }
  return out
}
