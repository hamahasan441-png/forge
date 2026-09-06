/**
 * forge — agent loop (tool-using coding agent, zero dependencies)
 *
 * v16: parallel tool execution (read-only tools concurrent, write tools
 * serialized), canonical tool_calls history, --plan mode (read-only planning
 * pass), git_status/apply_patch awareness.
 *
 * v20:
 *   - delegate is correctly a READ-ONLY tool: plan-mode agents can delegate
 *     research; sub-agents cannot (depth cap 2 stays)
 *   - delegate sub-agents get ROLE directives (researcher/reviewer/tester/
 *     security/coder) and run under a timeout + concurrency cap
 *   - context-overflow recovery: a 400 "context too large" triggers shrink +
 *     compact + one bounded retry instead of killing the task
 *   - project profile + relevant memory + learned fixes are injected into the
 *     system prompt (context engine) instead of raw memory dumps
 *   - adaptive effort: profile auto → deep thinking for complex tasks
 *   - Retry-After honored on transient provider errors
 */
import { chatOnce, ProviderError, fallbackChain, isFailoverWorthy } from "./providers.js"
import { readHealth, recordHealth } from "./health.js"
import { makeToolContext, WRITE_TOOLS, BUILTIN_TOOL_NAMES } from "./tools.js"
import { loadToolPlugins } from "./plugins.js"
import { createToolIntel } from "./toolintel.js"
import { toolGuidance } from "./router.js"
import { indexSkills, resolveSkillsDir } from "./skills.js"
import { DEFAULT_DIR } from "./config.js"
import { dim, cyan, green, yellow, red, estimateTokens } from "./ui.js"
import { relevantMemory, relevantLearnings } from "./memory.js"
import { profileSummary, resourceProfile } from "./profile.js"
import { buildRepoMap } from "./repomap.js"
import { openRun } from "./runlog.js"
import { listCheckpoints } from "./checkpoint.js"
import path from "node:path"
import fs from "node:fs"

/** v20 adaptive effort: cheap task-complexity classifier.
 *  TRIVIAL/SIMPLE → fast path (no deep reasoning), MODERATE → normal,
 *  COMPLEX/CRITICAL → deep. Transparent: the choice is printed, never hidden. */
export function classifyTaskComplexity(task) {
  const t = String(task ?? "").toLowerCase()
  const words = t.split(/\s+/).length
  let score = 0
  if (words > 12) score++
  if (words > 30) score++
  const complexSignals = ["architect", "refactor", "migrat", "security", "vulnerab", "production", "deploy", "database", "schema", "performance", "optimize", "race condition", "concurrency", "multi-file", "across files", "redesign", "rewrite", "debug", "not working", "failing", "broken", "regression", "test suite", "fix all", "end to end", "e2e"]
  const trivialSignals = ["what is", "explain", "summar", "rename", "one line", "typo", "comment", "docs for", "read me", "list "]
  for (const s of complexSignals) if (t.includes(s)) score += 2
  for (const s of trivialSignals) if (t.includes(s)) score -= 2
  if (score <= -1) return "trivial"
  if (score <= 0) return "simple"
  if (score <= 1) return "moderate"
  if (score <= 3) return "complex"
  return "critical"
}

/** Map a profile + task to the effort actually used. Returns {deep, why}. */
export function resolveEffort(profile, task) {
  switch (profile) {
    case "fast": return { deep: false, why: "profile=fast" }
    case "deep": return { deep: true, why: "profile=deep" }
    case "auto": {
      const level = classifyTaskComplexity(task)
      const deep = level === "complex" || level === "critical"
      return { deep, why: `profile=auto → ${level} task → ${deep ? "deep" : "standard"} effort` }
    }
    default: return { deep: false, why: "profile=balanced" }
  }
}

const ROLE_DIRECTIVES = {
  researcher: "You are a RESEARCH sub-agent: investigate quickly, read code/docs, and report findings. Zero writes. Keep the report dense and under 400 words.",
  reviewer: "You are a CODE REVIEW sub-agent: inspect the relevant files for bugs, edge cases, and quality issues. Report concrete findings with file:line references. Zero writes.",
  tester: "You are a TEST sub-agent: figure out how this project is tested, run the relevant test/build commands, and report pass/fail evidence. Zero writes.",
  security: "You are a SECURITY sub-agent: look for injection, path traversal, unsafe deserialization, secret exposure, and permission issues. Report concrete risks with file:line references. Zero writes.",
  coder: "You are an ANALYSIS sub-agent for implementation planning: identify exact files and edits needed, but do NOT write — the main agent applies the changes.",
}

function agentSystemPrompt({ cwd, skillsDir, skillsEnabled, readOnly = false, planOnly = false, memoryPath, deep = false, role, task, repoMap = true, registry = null }) {
  const lines = [
    "You are forge — an autonomous terminal coding agent running directly on the user's machine.",
    `Working directory: ${cwd}`,
    "Platform: " + process.platform + ", Node " + process.version,
    "",
    "RULES:",
    "1. Think step by step. Use tools to inspect reality before claiming things.",
    "2. Check `git_status` first when working in a repo; prefer read/grep/list to understand, then edit precisely, then VERIFY with bash (run tests/builds).",
    "3. Keep edits minimal and surgical — never rewrite whole files unless creating new ones. Prefer multi_edit for several changes in one file and apply_patch for larger structured changes.",
    "4. When done, reply with a concise final summary: what changed, files touched, verification result.",
    "5. If a task is impossible, say exactly why and what you tried.",
    "6. Write operations must stay inside the working directory; sensitive files (.env, keys, credentials) are protected. When a fix works, record it with the memory tool (action=learn) so future sessions remember it.",
    "",
    "TOOLS — all available, use them automatically as needed:",
    "- Multi-step work: keep a `todo` list (set at start, update statuses as you go).",
    "- Complex edits: call `think` first to plan.",
    "- Find files fast with `glob_files`; search the web with `web_search`; read pages with `fetch_url`.",
    "- Read-only research that would flood context: `delegate` it (role=tuner: researcher/reviewer/tester/security/coder).",
    "- Facts worth remembering later: `memory` append (scope=project for repo conventions, global for user preferences).",
  ]
  // v20.5: the capability registry speaks for itself — one compact policy
  // block instead of tool-selection rules scattered through the prompt.
  if (registry) {
    const guidance = toolGuidance(task, { registry, cwd, readOnly: readOnly || planOnly })
    if (guidance) lines.push("", guidance)
  }
  if (role && ROLE_DIRECTIVES[role]) lines.push("", ROLE_DIRECTIVES[role])
  if (readOnly && !planOnly) lines.push("", "You are a READ-ONLY sub-agent: write tools are disabled. Investigate and report.")
  if (deep) {
    lines.push("",
      "DEEP THINKING MODE: think like the big models — before EACH tool batch, reason about what to do and why; consider alternatives and failure modes; after edits, VERIFY with tests/builds before claiming success. Prefer correctness over speed.")
  }
  if (planOnly) lines.push("", "PLAN MODE: investigate and produce a numbered, step-by-step implementation plan (files to touch, edits to make, how to verify). Do NOT execute any changes — read-only tools only. End with 'END OF PLAN'.")
  // v20 context engine: project profile + repo map + relevant memory + learned fixes
  const prof = profileSummary(cwd)
  if (prof) lines.push("", prof)
  // v20.2 (P3-1): a compact symbol map so the agent locates code without ls/grep
  if (repoMap) {
    try {
      const map = buildRepoMap(cwd, { query: task || "" }) // P3-2: rank by task relevance
      if (map) lines.push("", map)
    } catch { /* repo map is best-effort — never break the prompt */ }
  }
  if (task) {
    const mem = relevantMemory(task, { cwd })
    if (mem) lines.push("", mem)
    const learnings = relevantLearnings(task, { cwd })
    if (learnings) lines.push("", learnings)
  }
  if (skillsEnabled && skillsDir) {
    const idx = indexSkills(skillsDir)
    if (idx.length) {
      lines.push("", `SKILLS AVAILABLE (${idx.length}) — call load_skill(name) to read full instructions before using one:`)
      for (const s of idx.slice(0, 40)) lines.push(`- ${s.name}: ${s.desc}`)
    }
  }
  return lines.join("\n")
}

/** v17 token reducer, v19 TIERED: stage 1 SHRINKS big tool outputs in the
 *  history (keeps the real work-log, drops the bulk) at ~40% of the window;
 *  stage 2 (unchanged) summarizes the middle at ~55% — long agent runs no
 *  longer march into a 400, and shrinking preserves far more information.
 *  v20: `force` lets context-overflow recovery trigger it explicitly. */
async function compactAgentHistory(messages, p, { onEvent, force = false }) {
  try {
    const estTok0 = estimateTokens(JSON.stringify(messages))
    const window = p.contextWindow ?? 128000
    const shrinkBudget = Math.floor((window * 40) / 100)
    const budgetTok = Math.floor((window * 55) / 100)
    if (!force && estTok0 < shrinkBudget) return messages
    const tail = 4 // keep the 4 most recent messages verbatim
    // stage 1 — shrink big tool outputs outside the recent tail
    let next = messages
    let shrunk = 0
    if (messages.length > tail + 2) {
      next = messages.map((m, i) => {
        if (m?.role === "tool" && typeof m.content === "string" && m.content.length > 2400 && i < messages.length - tail) {
          shrunk += m.content.length
          return { ...m, content: `[tool output shrunk: ${m.content.length} chars]` }
        }
        return m
      })
    }
    const estTok = estimateTokens(JSON.stringify(next))
    if (!force && estTok < budgetTok) {
      if (shrunk > 0) onEvent?.({ type: "compacted", before: messages.length, after: next.length, estTok: estTok0, budgetTok, shrunk })
      return next
    }
    if (next.length < 2 + tail + 2) return next // need a real middle to summarize
    const middle = next.slice(2, next.length - tail)
    const digest = middle
      .map((m) => `[${m.role}] ${String(typeof m.content === "string" ? m.content : "(tool activity)").slice(0, 400)}`)
      .join("\n")
      .slice(0, 20000)
    const s = await chatOnce({
      protocol: p.protocol, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model, providerName: p.name,
      system: "Summarize this agent work-log for an AI agent continuing the same task. In <=200 words capture: what was done, files created or changed, key findings, and what remains. Output only the summary.",
      messages: [{ role: "user", content: digest }],
      maxTokens: 500,
    })
    const summarized = [...next.slice(0, 2), { role: "user", content: `(work-log summary of steps so far)\n${(s.content || "(no summary)").trim()}` }, ...next.slice(next.length - tail)]
    onEvent?.({ type: "compacted", before: messages.length, after: summarized.length, estTok: estTok0, budgetTok, shrunk })
    return summarized
  } catch {
    return messages // graceful — compaction must never break the agent loop
  }
}

export async function runAgent({ config, provider, task, onEvent, signal, readOnly = false, planOnly = false, maxStepsOverride, deep, role, sub = null, journal = true, runIdOverride = null, suppressRunEvents = false, keepJournalRunning = false, noTools = false }) {
  let p = provider
  const readonly = readOnly || planOnly // plan mode is always read-only
  // v20.4 UI events: every event from a delegated sub-agent is tagged with its
  // worker id so the terminal can show it as a worker instead of interleaving
  // it with the main run's activity.
  const rawOnEvent = onEvent
  if (sub && rawOnEvent) onEvent = (ev) => rawOnEvent({ ...ev, sub, role })
  // v20.2 provider failover (opt-in): when the active provider keeps failing on
  // transient/auth errors, fall through to the next configured+tested provider
  // instead of killing the task. Default OFF — a switch is always announced.
  const failoverOn = config?.failover === true || process.env.FORGE_FAILOVER === "1"
  const chain = failoverOn && !readonly ? fallbackChain(config, p.name, { health: readHealth() }) : []
  let chainIdx = 0
  const isFailworthy = isFailoverWorthy
  const res = resourceProfile()
  // v20 adaptive effort: deep may be resolved from the profile when unset
  let deepEffort = deep
  if (deepEffort === undefined) {
    const profile = config.chat?.profile ?? "auto"
    deepEffort = profile === "deep"
    if (profile === "auto") {
      const level = classifyTaskComplexity(task)
      deepEffort = level === "complex" || level === "critical"
      if (deepEffort) onEvent?.({ type: "info", text: `auto profile → ${level} task → deep effort` })
    }
  }
  const maxSteps = Math.min(maxStepsOverride ?? config.agent?.maxSteps ?? 25, readonly ? 10 : 1000)
  const maxToolCalls = Math.min(500, Math.max(10, config.agent?.maxToolCalls ?? 80)) // v20: hard stop for runaway tool loops
  const skillsDir = resolveSkillsDir(config.skills?.dir) // bundled skills work in agent mode too
  const memoryPath = path.join(DEFAULT_DIR, "memory.md")
  // v20.2 (P3-4): tag every checkpoint from this run with one runId so the whole
  // run can be rolled back atomically (`forge undo --run`). Sub-agents are
  // read-only and never write, so they get no runId.
  // v21: the meta controller shares ONE runId across every segment of a task so
  // the whole autonomous task is a single atomic undo (`forge undo --run`).
  const runId = readonly ? null : runIdOverride || "run-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6)
  // v20.4 crash-safe journal (~/.forge/runs/<runId>.json): what the run touched,
  // updated after every tool result, closed with a terminal status. An
  // interrupted run (crash / kill) stays "running" → startup recovery screen.
  const log = runId && journal ? openRun({ runId, task, cwd: process.cwd(), kind: "agent", provider: p.name, model: p.model }) : null
  if (!suppressRunEvents) onEvent?.({ type: "run_start", runId, task, planOnly, readOnly: readonly, role })
  // v20.2 P3-5: load user tool plugins from ~/.forge/tools (empty by default).
  // Sub-agents inherit the same plugins the main run sees.
  let plugins = []
  if (config.tools?.plugins !== false) {
    try {
      const loaded = await loadToolPlugins(undefined, { reserved: BUILTIN_TOOL_NAMES })
      plugins = loaded.tools
      const isDelegatedSubAgent = readonly && !planOnly
      if (!isDelegatedSubAgent) {
        for (const p of plugins) onEvent?.({ type: "info", text: `tool plugin loaded: ${p.name}${p.readOnly ? " (read-only)" : ""} — ${p.source}` })
        for (const e of loaded.errors) onEvent?.({ type: "info", text: `tool plugin skipped: ${e}` })
      }
    } catch { /* plugins are best-effort */ }
  }
  let subCounter = 0
  const tools = makeToolContext({
    plugins,
    cwd: process.cwd(),
    root: process.cwd(),
    timeoutSec: config.agent?.timeoutSec ?? 45,
    maxToolOutput: config.agent?.maxToolOutput ?? 12000,
    skillsDir,
    searchUrl: config.tools?.searchUrl || "",
    memoryPath,
    todoPath: path.join(DEFAULT_DIR, "todo.json"),
    runId,
    readOnly: readonly,
    allowOutsideProject: config.tools?.allowOutsideProject === true,
    allowSudo: config.tools?.allowSudo === true,
    assumeYes: config.tools?.assumeYes === true,
    fetchPrivateUrls: config.tools?.fetchPrivateUrls === true || process.env.FORGE_ALLOW_PRIVATE_URLS === "1",
    delegateTimeoutSec: config.agent?.delegateTimeoutSec ?? 180,
    // low-RAM devices (Termux/proot) get 1 concurrent sub-agent, not a stall
    maxParallelDelegates: config.agent?.maxParallelSubAgents ?? (res.tier === "low" ? 1 : 2),
    signal,
    subAgent: readonly && !planOnly,
    // plan-mode agents may delegate read-only research; sub-agents may not
    // (their delegateRunner is null) → delegation depth is capped at 2.
    delegateRunner: readOnly && !planOnly
      ? null
      : (subTask, subRole) =>
        runAgent({
          config, provider: p, task: subTask, onEvent: onEvent ? (ev) => onEvent(ev) : null, signal,
          readOnly: true, maxStepsOverride: 10, role: subRole, sub: `w${++subCounter}`,
        }).then((r) => r.text),
  })

  // v20.5: capability registry → router → policy gate → execution →
  // observation → verification, wrapped around the UNCHANGED tools.exec (so
  // ShellGuard / SafePath / NetGuard / secret redaction stay exactly where
  // they are). Opt out with `forge config set tools.intelligence false`.
  const intel = createToolIntel({
    exec: tools.exec,
    ctx: {
      cwd: process.cwd(),
      root: process.cwd(),
      readOnly: readonly,
      allowSudo: config.tools?.allowSudo === true,
      assumeYes: config.tools?.assumeYes === true,
    },
    config,
    onEvent,
    runId,
    taskId: runId,
    task,
    plugins,
    legacyEvents: true,
  })
  if (!sub && config.tools?.explainRouting !== false) {
    try {
      const decision = intel.route(task, { constraints: { readOnly: readonly } })
      if (decision?.chain?.active?.length) {
        onEvent?.({ type: "info", text: `routing: ${decision.chain.reason}` })
      }
    } catch { /* routing advice is best-effort */ }
  }

  let messages = [
    { role: "system", content: agentSystemPrompt({ cwd: process.cwd(), skillsDir, skillsEnabled: config.skills?.enabled !== false, readOnly: readonly, planOnly, memoryPath, deep: deepEffort, role, task, repoMap: config.context?.repoMap !== false, registry: intel.registry }) },
    { role: "user", content: planOnly ? `${task}\n\n(Produce a plan only — do not execute.)` : task },
  ]

  let steps = 0
  let finalText = ""
  let retryBudget = 3 // transient-error retries do NOT burn maxSteps
  let overflowBudget = 2 // v20: context-overflow compress+retry attempts
  let switchedOk = false // recorded health-ok after a successful failover
  let toolCallCount = 0
  const toolLog = []
  const commandChecks = [] // v21: actual exit-code verification evidence from bash
  let ended = false
  const endRun = (status, extra = {}) => {
    if (ended) return
    ended = true
    // v21: an intermediate segment of a multi-segment task keeps the shared
    // journal "running" — only the controller closes it when the task ends.
    if (log && !extra.keepRunning) log.end(status, extra)
    else if (log) log.flush()
    if (!suppressRunEvents) onEvent?.({ type: "run_end", runId, status, steps, toolCalls: toolLog.length, text: extra.text ?? "", error: extra.error ?? null, wrote: extra.wrote ?? false, tools: intel.stats() })
  }
  try {
    while (steps < maxSteps) {
      steps++
      log?.step(steps)
      onEvent?.({ type: "step", step: steps })
      let msg
      try {
        msg = await chatOnce({
          protocol: p.protocol,
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          model: p.model,
          providerName: p.name,
          messages,
          // v20.5: a tool disabled by policy is never advertised to the model.
          // v21: a pure-planning request sends NO tools at all so the model
          // produces a plan instead of trying to execute one.
          tools: noTools ? undefined : intel.toolDefs(tools.defs),
          signal,
          deep: deepEffort,
          maxTokens: deepEffort ? 16384 : undefined,
          connectMs: config.retry?.connectMs,
          requestTimeoutMs: config.retry?.requestTimeoutMs,
        })
      } catch (e) {
        if (e instanceof ProviderError && e.contextOverflow && overflowBudget > 0) {
          // v20 recovery: compress hard, then retry the SAME step
          overflowBudget--
          onEvent?.({ type: "compacted", before: messages.length, after: -1, estTok: estimateTokens(JSON.stringify(messages)), budgetTok: 0, reason: "context overflow — compressing and retrying" })
          messages = await compactAgentHistory(messages, p, { onEvent, force: true })
          messages = hardShrink(messages)
          steps--
          continue
        }
        if (e instanceof ProviderError && e.retryable && retryBudget > 0) {
          retryBudget--
          onEvent?.({ type: "retry", error: e.message, step: steps, left: retryBudget })
          // v20: honor Retry-After when the provider sent one
          const wait = Math.max(2000 * (3 - retryBudget), e.retryAfterMs ?? 0)
          await new Promise((r) => setTimeout(r, Math.min(60000, wait)))
          steps-- // retry does not consume a step
          continue
        }
        // v20.2: retries on THIS provider are spent (or the error is a hard
        // auth/not-found) — fall through to the next configured provider if one
        // is available. Each provider in the chain is tried once.
        if (isFailworthy(e) && chainIdx < chain.length) {
          const next = chain[chainIdx++]
          recordHealth(p.name, { ok: false, error: String(e.message).slice(0, 160), model: p.model })
          onEvent?.({ type: "failover", from: `${p.name}/${p.model}`, to: `${next.name}/${next.model}`, reason: e.message })
          p = next
          retryBudget = 3 // fresh budget for the new provider
          steps-- // switching does not consume a step
          continue
        }
        throw e
      }

      // a request that succeeded on a switched-to provider confirms it works —
      // record it once so the health cache and future runs prefer it
      if (chainIdx > 0 && !switchedOk) { switchedOk = true; recordHealth(p.name, { ok: true, model: p.model }) }

      if (msg.reasoning && onEvent) onEvent({ type: "reasoning", text: msg.reasoning })

      if (msg.toolCalls?.length) {
        // v20: runaway guard — stop spawning tool rounds past the budget
        toolCallCount += msg.toolCalls.length
        if (toolCallCount > maxToolCalls) {
          messages.push({ role: "user", content: `(system) tool-call budget exhausted (${maxToolCalls} calls) — stop calling tools and produce your final answer now with what you have.` })
          continue
        }
        // canonical wire history: ONE assistant message carrying ALL tool_calls
        messages.push({
          role: "assistant",
          content: msg.content || "",
          tool_calls: msg.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.args } })),
        })
        // v20.5 tool intelligence layer: the router decides what may run
        // concurrently (read-only, parallel-safe, no target conflict) and what
        // must be serialized; every call passes the capability check, the
        // policy gate and the EXISTING safety controls, is classified on
        // failure and verified after a mutation. Results are reassembled in
        // the ORIGINAL call order, so the wire history never changes shape.
        // (v16 behaviour — reads concurrent, writes serialized — is preserved;
        //  `tools.intelligence: false` reverts to the plain execute path.)
        const results = await intel.runBatch(
          msg.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: safeJson(tc.args) })),
          { step: steps }
        )
        for (let i = 0; i < msg.toolCalls.length; i++) {
          const tc = msg.toolCalls[i]
          if (!results[i]) results[i] = { result: "ERROR: tool did not run", ms: 0 }
          const { result, ms } = results[i]
          toolLog.push({ step: steps, name: tc.name, result: String(result).slice(0, 200) })
          // v21: capture ACTUAL verification evidence from bash runs (exit code
          // + output), not command names. The meta controller feeds this to the
          // structured verification ledger. Test/build/lint/audit commands only.
          if (tc.name === "bash" && !sub) {
            try {
              const rawArgs = safeJson(tc.args)
              const command = typeof rawArgs === "object" && rawArgs ? String(rawArgs.command ?? "") : ""
              if (/\b(test|jest|vitest|mocha|pytest|cargo|go test|rspec|build|tsc|make|compile|audit|snyk|semgrep|bandit|gosec|lint)\b/i.test(command)) {
                const rstr = String(result)
                const exitM = /\[exit code: (-?\d+)\]/.exec(rstr)
                const timedOut = /timed out after/i.test(rstr)
                const exitCode = timedOut ? 124 : exitM ? Number(exitM[1]) : 0
                const tail = rstr.split("\n").filter(Boolean).slice(-6).join(" ").slice(0, 500)
                commandChecks.push({ command: command.slice(0, 300), exitCode, timedOut, passed: exitCode === 0 && !timedOut, tail })
                onEvent?.({ type: "command_check", command: command.slice(0, 200), exitCode, passed: exitCode === 0 && !timedOut, tail, step: steps })
              }
            } catch { /* evidence capture is best-effort */ }
          }
          if (log) {
            const r = String(result)
            const okRes = !(r.startsWith("ERROR") || r.startsWith("BLOCKED"))
            log.tool(tc.name, journalTarget(tc.name, tc.args), okRes)
            if (okRes && WRITE_TOOLS.has(tc.name) && tc.name !== "bash") for (const [fp, action] of journalFiles(tc.name, tc.args, r)) log.touched(fp, action)
          }
          // tool_start / tool_result events are emitted by the intelligence
          // layer (same shape as v16–v20.4), together with the structured
          // TOOL_* events the premium UI consumes.
          messages.push({ role: "tool", tool_call_id: tc.id, content: String(result) })
        }
        // v17 token reducer: summarize mid-run when approaching the window budget
        messages = await compactAgentHistory(messages, p, { onEvent })
        continue
      }

      finalText = msg.content || "(empty answer)"
      break
    }

    // v21: distinguish "segment budget spent, task not necessarily finished"
    // from a genuine final answer. The meta controller continues automatically;
    // a standalone runAgent caller gets the old message.
    const budgetHit = steps >= maxSteps
    if (budgetHit && !finalText) {
      finalText = "(reached the per-segment step budget without a final answer)"
    }
    const wrote = toolLog.some((t) => WRITE_TOOLS.has(t.name) && !String(t.result).startsWith("ERROR") && !String(t.result).startsWith("BLOCKED"))
    if (log) { try { for (const c of listCheckpoints(process.cwd(), 50)) if (c.runId === runId) log.checkpoint(c.id) } catch {} }
    endRun("completed", { text: finalText, wrote })
    return { text: finalText, steps, toolLog, commandChecks, planOnly, runId, wrote, budgetHit, toolStats: intel.stats(), toolRecords: intel.records() }
  } catch (e) {
    const wrote = toolLog.some((t) => WRITE_TOOLS.has(t.name) && !String(t.result).startsWith("ERROR") && !String(t.result).startsWith("BLOCKED"))
    if (e?.name === "AbortError" || signal?.aborted) endRun("cancelled", { wrote })
    else endRun("failed", { error: e?.message ?? String(e), wrote })
    throw e
  }
}

/** Compact target string for the run journal (never the full args). */
function journalTarget(name, argStr) {
  const a = safeJson(argStr || "{}")
  const t = a.path ?? a.command ?? a.pattern ?? a.url ?? a.query ?? a.name ?? a.action ?? ""
  return String(t).split("\n")[0].slice(0, 160)
}

/** Files a successful write tool touched, for the run journal. */
function journalFiles(name, argStr, result) {
  const a = safeJson(argStr || "{}")
  const out = []
  const abs = (p) => path.resolve(process.cwd(), String(p))
  if (name === "write_file" && a.path) out.push([abs(a.path), /created/i.test(result) ? "created" : "modified"])
  else if ((name === "edit_file" || name === "multi_edit") && a.path) out.push([abs(a.path), "modified"])
  else if (name === "apply_patch") {
    const m = String(result).match(/created ([^•]+?)(?: •|$| \()/)
    if (m) for (const f of m[1].split(",")) out.push([abs(f.trim()), "created"])
    const d = String(result).match(/deleted ([^•]+?)(?: •|$| \()/)
    if (d) for (const f of d[1].split(",")) out.push([abs(f.trim()), "deleted"])
    try {
      const re = /^\+\+\+ (?:b\/)?(\S+)/gm
      let mm
      while ((mm = re.exec(String(a.patch ?? "")))) if (mm[1] !== "/dev/null" && !out.some((x) => x[0] === abs(mm[1]))) out.push([abs(mm[1]), "modified"])
    } catch {}
  }
  return out
}

/** Aggressive in-place shrink used only for overflow recovery: stub ALL tool
 *  outputs outside the last 6 messages regardless of size, dedupe repeated
 *  tool results, and drop oversized single messages. Never drops task state. */
function hardShrink(messages) {
  const seen = new Map()
  return messages.map((m, i) => {
    if (m?.role !== "tool" || typeof m.content !== "string") return m
    if (i >= messages.length - 6) return m
    const key = m.content.slice(0, 120)
    if (seen.has(key)) return { ...m, content: "[duplicate tool output removed]" }
    seen.set(key, true)
    if (m.content.length > 600) return { ...m, content: `[tool output shrunk: ${m.content.length} chars]` }
    return m
  })
}

function safeJson(s) {
  try {
    return JSON.parse(s)
  } catch {
    return { _raw: s }
  }
}

/** Pretty-print agent events to the terminal. */
export function agentEventPrinter() {
  return function onEvent(ev) {
    if (ev.sub) return // sub-agent traffic is summarized by the delegate tool result
    if (ev.type === "tool_start") {
      const args = String(ev.args || "").slice(0, 160)
      console.log(dim(`  ┌ [step ${ev.step}] ${cyan(ev.name)} ${dim(args)}`))
    } else if (ev.type === "tool_result") {
      const r = String(ev.result)
      const one = r.split("\n").slice(0, 3).join(" ⏎ ").slice(0, 200)
      const more = r.length > 200 || r.split("\n").length > 3 ? dim(` (+${r.length}B)`) : ""
      const ms = ev.ms !== undefined ? dim(` ${ev.ms}ms`) : ""
      console.log(dim(`  └ `) + (r.startsWith("ERROR") || r.startsWith("BLOCKED") ? red(one) : green(one)) + more + ms)
    } else if (ev.type === "reasoning") {
      const t = ev.text.trim().split("\n")[0].slice(0, 140)
      if (t) console.log(dim(`  ☍ thinking: ${t}`))
    } else if (ev.type === "retry") {
      console.log(yellow(`  ↻ transient provider error (${ev.error}) — retrying… ${ev.left ?? ""}`))
    } else if (ev.type === "failover") {
      console.log(yellow(`  ⇄ provider failover: ${ev.from} failed (${String(ev.reason).slice(0, 80)}) → switching to ${green(ev.to)}`))
    } else if (ev.type === "TOOL_VERIFIED") {
      const label = ev.ok ? green(`✓ verified: ${ev.summary}`) : red(`✗ verification failed: ${ev.summary}`)
      console.log(dim("  ⌁ ") + label)
    } else if (ev.type === "TOOL_RETRY") {
      console.log(yellow(`  ↻ ${ev.tool} — ${ev.reason} → retry ${ev.attempt}`))
    } else if (ev.type === "TOOL_FALLBACK") {
      console.log(dim(`  ⇢ ${ev.tool}: ${ev.alternative ? `try ${ev.alternative} — ` : ""}${ev.reason}`))
    } else if (ev.type === "TOOL_BLOCKED" && !ev.bySafetyControl && !ev.conflict) {
      console.log(yellow(`  ⛔ ${ev.tool} blocked — ${String(ev.reason).slice(0, 160)}`))
    } else if (ev.type === "TOOL_SELECTED") {
      if (process.env.FORGE_DEBUG === "1") console.log(dim(`  ◦ route: ${ev.tool} [${ev.capability}/${ev.klass}/${ev.risk}/${ev.mode}] ${String(ev.reason).slice(0, 100)}`))
    } else if (ev.type === "TOOL_ESCALATION") {
      console.log(yellow(`  ? ${ev.tool} needs your decision — ${String(ev.question).slice(0, 160)}`))
    } else if (ev.type === "TOOL_CACHED") {
      console.log(dim(`  ⚡ ${ev.tool}: ${ev.reason}`))
    } else if (ev.type === "info") {
      console.log(dim(`  · ${ev.text}`))
    } else if (ev.type === "compacted") {
      if (ev.after === -1) {
        console.log(yellow(`  ✂ ${ev.reason ?? "context overflow"} (~${ev.estTok} tok) — compressing and retrying`))
      } else {
        console.log(yellow(`  ✂ context compacted: ${ev.before} → ${ev.after} messages (~${ev.estTok} tok was over the ${ev.budgetTok} budget)${ev.shrunk ? ` • tool outputs shrunk (~${Math.round(ev.shrunk / 1024)}KB stubbed)` : ""}`))
      }
    }
  }
}

// keep fs import used (profile reads may be added here)
void fs
