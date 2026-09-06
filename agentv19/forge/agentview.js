/**
 * forge — agent view: UI state → terminal (zero dependencies)
 *
 * Subscribes to the UI store and decides what becomes DURABLE scrollback and
 * what stays in the live dock:
 *
 *   TTY (dock on)   tool starts, plan, workers, thinking → live dock/status
 *                   tool completions, notices, errors, results → scrollback
 *   plain           everything durable, one compact line per event
 *                   (piped output, `--no-dock`, or a11y mode)
 *
 * The same code path serves interactive chat, `forge agent` in a terminal,
 * and `forge agent` in a pipe — only the sink differs.
 */
import path from "node:path"
import { bridgeAgentEvent, createBridgeContext, isBusy } from "./uistate.js"
import { renderDock, renderToolLine, renderPlan, renderWorkers, renderCompletion, renderFailure, renderCancel, renderVerification, renderChanges, fmtMs, fmtClock, shortCheckpoint, shortRun, fit, padRight, mark } from "./render.js"
import { renderMarkdown } from "./ui.js"
import { createTerminal } from "./terminal.js"
import { createUIStore } from "./uistate.js"

const THINK_VERBS = { THINKING: "Thinking", PLANNING: "Planning", EXECUTING: "Working", VERIFYING: "Verifying", RECOVERING: "Recovering", WAITING: "Waiting" }

/**
 * @param term    terminal coordinator (createTerminal) — or a plain sink with
 *                { tty:false, line(), lines(), out(), setDock(), setStatus(), opts }
 * @param store   createUIStore()
 * @param plain   force durable-only output (no dock)
 */
export function createAgentView({ term, store, cwd = process.cwd(), plain = false, showThinking = true, silent = false, oneShot = false } = {}) {
  const o = term.opts
  const live = !!term.tty && !plain && !o.a11y
  const bctx = createBridgeContext({ cwd })
  let ticker = null
  let lastPlanKey = ""
  let cancelPrinted = ""

  const line = (s = "") => term.line(s)
  const lines = (arr) => term.lines(arr)
  const W = () => term.columns || 80

  function statusText(s) {
    if (!isBusy(s)) return null
    if (s.cancel && s.cancel.phase !== "stopped") return o.th.warn(`${mark("warn", o)} Stopping…`) + o.th.muted(s.cancel.tool ? `  waiting for ${s.cancel.tool}` : "")
    const running = s.activity.filter((a) => !a.endedAt)
    if (s.streaming && !running.length) return null // the streamed text is the progress
    const since = s.stateAt || s.task?.startedAt || Date.now()
    const el = fmtMs(Date.now() - since)
    if (running.length && (s.state === "EXECUTING" || s.state === "VERIFYING")) {
      const a = running[running.length - 1]
      const el2 = Date.now() - a.startedAt
      return o.th.active(`${mark("active", o)} ${a.name}`) + ` ${fit(a.target, Math.max(10, W() - 40))}` + (el2 >= 1000 ? `  ${o.th.muted(fmtMs(el2))}` : "")
    }
    const verb = THINK_VERBS[s.state] || "Working"
    const thought = showThinking && s.thought ? o.th.muted(`  ${fit(s.thought, Math.max(10, W() - 30))}`) : ""
    const elapsed = Date.now() - since
    return o.th.active(`${mark("active", o)} ${verb}${elapsed < 1000 ? "…" : ""}`) + (elapsed >= 1000 ? `  ${o.th.muted(el)}` : "") + thought
  }

  function tick() {
    const s = store.state
    if (!isBusy(s)) { stopTicker(); term.setStatus(null); return }
    term.setStatus(statusText(s))
    term.scheduleRender?.()
  }
  function startTicker() {
    if (ticker || !live) return
    ticker = setInterval(tick, 1000)
    if (typeof ticker.unref === "function") ticker.unref()
  }
  function stopTicker() {
    if (ticker) { clearInterval(ticker); ticker = null }
  }

  function dock(cols, rows) {
    o.now = Date.now()
    return renderDock(store.state, cols, rows, o)
  }

  function planKey(items) { return items.map((i) => `${i.status}:${i.text}`).join("|") }

  function onEvent(s, ev) {
    switch (ev.type) {
      case "TASK_STARTED":
        cancelPrinted = ""
        if (live) { term.setDock(dock); startTicker(); tick() }
        break
      case "TOOL_STARTED": {
        if (!live) {
          const a = s.activity.find((x) => x.id === ev.id)
          if (a && !a.worker) line(fit(`  ${o.sym.bullet} ${padRight(a.name, 11)} ${a.target}`, W() - 1))
        } else tick()
        break
      }
      case "TOOL_COMPLETED": {
        const a = s.activity.find((x) => x.id === ev.id)
        if (!a || a.worker) break
        lines(renderToolLine(a, W() - 2, o).map((l) => "  " + l))
        if (live) tick()
        break
      }
      case "PLAN_UPDATED": {
        const key = planKey(s.plan)
        if (key === lastPlanKey) break
        lastPlanKey = key
        if (!live && s.plan.length && s.plan.length <= 20) lines(renderPlan(s.plan, W(), o).map((l) => "  " + l))
        break
      }
      case "WORKER_STARTED": {
        if (!live) {
          const w = s.workers.find((x) => x.id === ev.id)
          if (w) line(fit(`  ${o.sym.bullet} worker ${String(w.n).padStart(2, "0")} ${w.role}: ${w.task}`, W() - 1))
        }
        break
      }
      case "WORKER_COMPLETED": {
        const w = s.workers.find((x) => x.id === ev.id)
        if (w && !live) line(fit(`  ${mark(w.status === "failed" ? "fail" : "ok", o)} worker ${String(w.n).padStart(2, "0")} ${w.role}  ${o.th.muted(fmtMs((w.endedAt || Date.now()) - w.startedAt))}`, W() - 1))
        break
      }
      case "NOTICE": {
        const n = s.notices[s.notices.length - 1]
        if (!n) break
        line(fit(n.level === "warn" ? `  ${o.th.warn(o.sym.warn)} ${n.text}` : `  ${o.th.muted(o.sym.dot + " " + n.text)}`, W() - 1))
        break
      }
      case "THOUGHT":
        if (live) tick()
        else if (showThinking && s.thought) line(o.th.muted(fit(`  ${o.sym.dot} thinking: ${s.thought}`, W() - 1)))
        break
      case "STEP_STARTED":
      case "STATE_CHANGED":
        if (live) tick()
        break
      case "USER_INTERRUPTED": {
        const phase = ev.phase || "requested"
        if (phase === "requested" && cancelPrinted !== "requested") {
          cancelPrinted = "requested"
          const running = s.activity.find((a) => !a.endedAt)
          lines(renderCancel(running ? "waiting" : "requested", { tool: running ? `${running.name} ${running.target}`.trim() : "" }, W(), o))
          if (live) tick()
        } else if (phase === "stopped") {
          stopTicker(); term.setStatus(null)
        }
        break
      }
      case "TASK_COMPLETED":
      case "TASK_FAILED":
        stopTicker(); term.setStatus(null)
        if (live) term.render?.()
        break
      case "TASK_RESET":
        stopTicker(); term.setStatus(null)
        if (live) term.render?.()
        break
      default:
        break
    }
  }

  const unsubscribe = silent ? () => {} : store.subscribe((s, ev) => { try { onEvent(s, ev) } catch { /* never break the agent */ } })

  /** Print the final result of a run + an honest engineering summary. */
  function printResult(res, { elapsedMs = 0, planOnly = false, aborted = false, error = null, savedPlan = null } = {}) {
    const s = store.state
    const files = Object.values(s.changes).filter((f) => !s.task || f.taskId === s.task.id)
    const checks = s.verification?.checks || {}
    const checkKeys = Object.keys(checks)
    const out = []
    if (aborted) {
      out.push(...renderCancel("stopped", { files: files.length, undoHint: oneShot ? "forge undo --run" : "/undo --run", sessionSaved: !oneShot, inputRestored: !oneShot }, W(), o))
      lines(out)
      return
    }
    if (error) {
      out.push(...renderFailure({ reason: error, steps: res?.steps, checkpoint: s.checkpoint, files: files.length, undoHint: oneShot ? "forge undo --run" : "/undo --run", next: nextStepFor(error, oneShot) }, W(), o))
      lines(out)
      return
    }
    if (res?.text) {
      out.push("")
      out.push(o.th.bold(planOnly ? o.th.active(`${o.sym.rule.repeat(2)} plan ${o.sym.rule.repeat(Math.max(4, Math.min(54, W() - 12)))}`) : o.th.ok(`${o.sym.rule.repeat(2)} result ${o.sym.rule.repeat(Math.max(4, Math.min(50, W() - 12)))}`)))
      out.push(renderMarkdown(res.text))
    }
    const summary = `${res?.steps ?? 0} steps • ${res?.toolLog?.length ?? s.activity.length} tool calls • ${(elapsedMs / 1000).toFixed(1)}s`
    if (planOnly) {
      out.push(o.th.muted(`  ${summary}`))
      if (savedPlan) out.push(o.th.muted(`  saved → ${savedPlan}`))
      lines(out)
      return
    }
    const tests = s.tests && !s.tests.running ? (s.tests.passed != null ? `${s.tests.passed} passed${s.tests.failed ? `, ${s.tests.failed} failed` : ""}` : s.tests.ok ? "passed" : "failed") : undefined
    const build = checks.build ? (checks.build.ok ? "passed" : "failed") : undefined
    const failedCheck = checkKeys.find((k) => checks[k].ok === false)
    out.push("")
    if (failedCheck) out.push(o.th.warn(`${mark("warn", o)} FINISHED WITH FAILING CHECKS`) + o.th.muted(`  ${failedCheck}: ${checks[failedCheck].summary || "failed"}`))
    else out.push(o.th.ok(`${mark("ok", o)} COMPLETED`) + o.th.muted(`  ${summary}`))
    const row = (k, v) => { if (v !== undefined && v !== null && v !== "") out.push(`  ${padRight(k, 12)} ${v}`) }
    if (files.length) row("Changes", `${files.length} file${files.length === 1 ? "" : "s"}` + o.th.muted(oneShot ? `  (forge undo --run rolls back)` : `  (/diff to review${res?.runId ? ", /undo --run to roll back" : ""})`))
    row("Tests", tests)
    row("Build", build)
    if (s.checkpoint) row("Checkpoint", shortCheckpoint(s.checkpoint))
    if (elapsedMs >= 60000) row("Elapsed", fmtClock(elapsedMs))
    if (checkKeys.length) {
      out.push("")
      out.push(...renderVerification(checks, {}, W(), o).filter((l) => l !== "").map((l) => "  " + l))
    }
    lines(out)
  }

  function nextStepFor(error, one = false) {
    const e = String(error || "").toLowerCase()
    if (/context.*(large|length|exceed)/.test(e)) return one ? "switch to a larger-context model (forge use <provider> --model …) and re-run" : "start a new conversation (/new) or switch to a larger-context model (/model)"
    if (/401|403|api key|unauthorized/.test(e)) return one ? "fix the API key (forge onboard) and re-run" : "fix the API key (/key <key>) and /retry"
    if (/429|rate limit|overloaded|503|502|timeout|fetch failed|unreachable/.test(e)) return `wait a moment and ${one ? "re-run" : "/retry"} — or enable failover: forge config set failover true`
    if (/max steps/.test(e)) return "raise agent.maxSteps or split the task"
    return one ? "forge doctor for diagnostics, then re-run" : "/details for diagnostics, then /retry"
  }

  return {
    /** agent onEvent adapter */
    onEvent: (ev) => bridgeAgentEvent(store, ev, bctx),
    bctx,
    printResult,
    printPlan: () => lines(renderPlan(store.state.plan, W(), o)),
    printWorkers: () => lines(renderWorkers(store.state.workers, W(), o)),
    printChanges: () => lines(renderChanges(store.state.changes, W(), o, { cwd })),
    tick,
    stop() { stopTicker(); term.setStatus(null); unsubscribe() },
  }
}

/**
 * One-shot agent console for `forge agent` / `forge plan apply`:
 *   TTY   → live dock + status (monitor mode: no input row), Ctrl+C cancels
 *           the run honestly (second Ctrl+C force-exits)
 *   piped → the classic line printer (byte-identical output)
 */
export async function createAgentConsole({ provider = "", model = "", cwd = process.cwd(), planOnly = false } = {}) {
  const tty = !!(process.stdin.isTTY && process.stdout.isTTY) && process.env.FORGE_UI !== "plain"
  const abort = new AbortController()
  let term = null, store = null, view = null, printer = null
  if (tty) {
    term = createTerminal({})
    store = createUIStore({ mode: planOnly ? "plan" : "agent", provider, model, cwd, terminal: { columns: term.columns, rows: term.rows, tty: true } })
    view = createAgentView({ term, store, cwd, oneShot: true })
    term.start({
      hideInput: true,
      onCancel: () => {
        if (!abort.signal.aborted) { abort.abort(); store.dispatch({ type: "USER_INTERRUPTED", phase: "requested" }); return "cancelled" }
        return "exit" // second Ctrl+C: force
      },
      onEOF: () => { try { view.stop(); term.stop() } catch {} process.exit(130) },
    })
  } else {
    const { agentEventPrinter } = await import("./agent.js")
    printer = agentEventPrinter()
  }
  return {
    tty,
    signal: abort.signal,
    store,
    onEvent: tty ? view.onEvent : printer,
    finish(res, opts = {}) {
      if (!tty) return
      view.printResult(res, opts)
      store.dispatch({ type: "TASK_RESET" })
    },
    ask(question) {
      if (tty) return term.ask(question)
      return import("node:readline/promises").then(async ({ default: rlp }) => {
        const r2 = rlp.createInterface({ input: process.stdin, output: process.stdout })
        try { return (await r2.question(question)).trim() } finally { r2.close() }
      })
    },
    stop() { try { view?.stop(); term?.stop() } catch {} },
  }
}

/** A durable-only sink for non-TTY runs (same interface subset as the terminal). */
export function plainSink(o, write = (s) => process.stdout.write(s)) {
  return {
    tty: false,
    opts: o,
    columns: Math.min(process.stdout.columns || 100, 120),
    rows: process.stdout.rows || 24,
    line: (s = "") => write(String(s) + "\n"),
    lines: (arr) => { if (arr?.length) write(arr.join("\n") + "\n") },
    out: (s) => write(String(s)),
    endStream: () => {},
    setDock: () => {},
    setStatus: () => {},
    setPrompt: () => {},
    render: () => {},
    scheduleRender: () => {},
    stop: () => {},
    ask: null,
  }
}


