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
 * v23 hardening:
 *   - runAgent accepts explicit taskId, runId, segmentId, nodeId (exact DAG identity)
 *   - every execution event carries taskId, runId, segmentId, nodeId, toolCallId
 *   - deterministic node execution via executeNode/markCompleted
 */
import { chatOnce, ProviderError, fallbackChain, isFailoverWorthy, nextCompatibleFallback } from "./providers.js"
import { readHealth, recordHealth } from "./health.js"
import { makeToolContext, WRITE_TOOLS, BUILTIN_TOOL_NAMES, hasWriteRedirection } from "./tools.js"
import { injectPendingVision } from "./vision.js"
import { closeBrowserSession } from "./browser.js"
import { loadToolPlugins } from "./plugins.js"
import { mergeLearnedPlugins } from "./extend.js"
import { loadMcpTools } from "./mcp.js"
import { createLspSession } from "./lsp.js"
import { createToolIntel } from "./toolintel.js"
import { toolGuidance } from "./router.js"
import { indexSkills, resolveSkillsDir } from "./skills.js"
import { mergeLearnedSkills } from "./evolve.js"
import { evaluateSkills, formatSkillPicks, selectPlugins } from "./evaluate.js"
import { languagesIn, formatLangReason } from "./langreason.js"
import { engineFor } from "./langengine.js"
import { compose, formatCompose } from "./compose.js"
import { classifyTask, classifyTaskComplexity, resolveEffort } from "./classify.js"
import { DEFAULT_DIR, AGENT_BUDGETS } from "./config.js"
import { dim, cyan, green, yellow, red, estimateTokens } from "./ui.js"
import { relevantMemory, relevantLearnings, relevantMemoryAsync, relevantLearningsAsync } from "./memory.js"
import { resolveEmbeddingsConfig, createEmbedder } from "./embeddings.js"
import { profileSummary, resourceProfile } from "./profile.js"
import { buildRepoMap, buildRepoMapAsync } from "./repomap.js"
import { openRun } from "./runlog.js"
import { listCheckpoints } from "./checkpoint.js"
import { compactHistory, shrinkToolOutput } from "./compaction.js"
import path from "node:path"
import fs from "node:fs"
import { execFileSync } from "node:child_process"

export { classifyTaskComplexity, resolveEffort }

const ROLE_DIRECTIVES = {
  researcher: "You are a RESEARCH sub-agent: investigate quickly, read code/docs, and report findings. Zero writes. Keep the report dense and under 400 words.",
  reviewer: "You are a CODE REVIEW sub-agent: inspect the relevant files for bugs, edge cases, and quality issues. Report concrete findings with file:line references. Zero writes.",
  tester: "You are a TEST sub-agent: figure out how this project is tested, run the relevant test/build commands, and report pass/fail evidence. Zero writes.",
  security: "You are a SECURITY sub-agent: look for injection, path traversal, unsafe deserialization, secret exposure, and permission issues. Report concrete risks with file:line references. Zero writes.",
  coder: "You are an ANALYSIS sub-agent for implementation planning: identify exact files and edits needed, but do NOT write — the main agent applies the changes.",
  architect: "You are an ARCHITECTURE sub-agent: map modules, contracts, and dependencies. Report the smallest change set. Zero writes.",
  debugger: "You are a DEBUG sub-agent: trace the failing path, name the root cause with file:line evidence. Zero writes.",
  integrator: "You are the INTEGRATOR: merge the other workers' findings into ONE ordered apply list (file → action). Do NOT write files. Do NOT invent edits. If findings conflict, list the conflict and pick one. Empty findings → empty list.",
}

function agentSystemPrompt({ cwd, skillsDir, skillsEnabled, readOnly = false, planOnly = false, memoryPath, deep = false, role, task, repoMap = true, registry = null, memoryBlock = null, learningsBlock = null, repoMapBlock = null, config = null }) {
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
    "7. Run in-project commands yourself (tests, builds, git, node -e / python -c). Do not stop to ask. Catastrophic commands, writes outside the project, sudo, and publishes are blocked — refine the command instead of asking the user to disable safety.",
    "",
    "TOOLS — all available, use them automatically as needed:",
    "- Multi-step work: keep a `todo` list (set at start, update statuses as you go).",
    "- Complex edits: call `think` first to plan.",
    "- Find files fast with `glob_files`; search the web with `web_search`; read pages with `fetch_url`.",
    "- Read-only research that would flood context: `delegate` it (role=tuner: researcher/reviewer/tester/security/coder).",
    "- Facts worth remembering later: `memory` append (scope=project for repo conventions, global for user preferences).",
  ]
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
  const prof = profileSummary(cwd)
  if (prof) lines.push("", prof)
  if (repoMap) {
    try {
      const map = repoMapBlock !== null ? repoMapBlock : buildRepoMap(cwd, { query: task || "" })
      if (map) lines.push("", map)
    } catch { }
  }
  if (task) {
    // v23: when semantic retrieval is enabled, runAgent precomputes the hybrid
    // (BM25+embeddings) rerank and passes it in; null = compute BM25 here.
    const mem = memoryBlock !== null ? memoryBlock : relevantMemory(task, { cwd })
    if (mem) lines.push("", mem)
    const learnings = learningsBlock !== null ? learningsBlock : relevantLearnings(task, { cwd })
    if (learnings) lines.push("", learnings)
  }
  if (skillsEnabled && skillsDir) {
    const idx = indexSkills(skillsDir)
    if (idx.length) {
      const klass = (() => { try { return classifyTask(task || "").class } catch { return null } })()
      const picks = evaluateSkills(task || "", mergeLearnedSkills(idx, cwd), { klass, skillsDir })
      const block = formatSkillPicks(picks)
      if (block) lines.push("", block)
    }
  }
  if (task) {
    const klass = (() => { try { return classifyTask(task).class } catch { return null } })()
    const langBlock = formatLangReason(languagesIn(task, { cwd, klass }))
    if (langBlock) lines.push("", langBlock)
    const engineBlock = engineFor(task, { cwd, config, klass })
    if (engineBlock) lines.push("", engineBlock)
    try {
      const composed = compose(task, { cwd, config, klass, includeMemory: false, includeSkills: false })
      const composeBlock = formatCompose(composed)
      if (composeBlock) lines.push("", composeBlock)
    } catch { /* compose is best-effort */ }
  }
  return lines.join("\n")
}

/**
 * v21.1 P1: structure- and meaning-preserving compaction (see context.js).
 * The model narrative is optional; the deterministic ledger (files changed,
 * commands + exit codes, errors, blocked actions) is always produced, so a
 * context-overflow retry always gets a SMALLER, well-formed history.
 */
async function compactAgentHistory(messages, p, { onEvent, force = false }) {
  try {
    const summarize = async (digest) => {
      const s = await chatOnce({
        protocol: p.protocol, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model, providerName: p.name,
        system: "Summarize this agent work-log for an AI agent continuing the same task. In <=200 words capture: what was done, key findings, what was tried and failed, and what remains. Do not list files or commands (they are recorded separately). Output only the summary.",
        messages: [{ role: "user", content: digest }],
        maxTokens: 500,
      })
      return s?.content ?? null
    }
    const r = await compactHistory(messages, { window: p.contextWindow ?? 128000, force, summarize })
    if (r.changed) onEvent?.({ type: "compacted", before: r.stats.before, after: r.stats.after, estTok: r.stats.estTokBefore, estTokAfter: r.stats.estTokAfter, budgetTok: Math.floor((p.contextWindow ?? 128000) * 0.55), shrunk: r.stats.shrunk, folded: r.stats.folded, stage: r.stats.stage })
    return r.messages
  } catch {
    return messages
  }
}

/**
 * Exact DAG node identity:
 * runAgent MUST accept taskId, runId, segmentId, nodeId
 * Every execution event carries taskId, runId, segmentId, nodeId, toolCallId
 */
export async function runAgent({ config, provider, task, extraContext = "", onEvent, signal, readOnly = false, planOnly = false, maxStepsOverride, deep, role, sub = null, journal = true, runIdOverride = null, runId: runIdParam = null, suppressRunEvents = false, keepJournalRunning = false, noTools = false, worker = null, taskId = null, segmentId = null, nodeId = null, verifier = false, pluginStartedAt = null }) {
  let p = provider
  const readonly = readOnly || planOnly
  const rawOnEvent = onEvent
  // deterministic identity for this execution — define runId early to avoid TDZ in identityMeta closure (e2e regression)
  const generatedRunId = "run-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6)
  const effectiveRunId = readonly ? null : (runIdParam ?? runIdOverride ?? generatedRunId)
  const effectiveTaskId = taskId ?? null
  const effectiveSegmentId = segmentId ?? null
  const effectiveNodeId = nodeId ?? worker?.dagNode ?? null

  // Wrap onEvent to inject exact identity into every event (hard requirement)
  const identityMeta = () => ({
    taskId: effectiveTaskId,
    runId: effectiveRunId,
    segmentId: effectiveSegmentId,
    nodeId: effectiveNodeId,
  })
  if (sub && rawOnEvent) {
    onEvent = (ev) => {
      try {
        rawOnEvent({ ...identityMeta(), ...ev, sub, role, toolCallId: ev?.callId ?? ev?.toolCallId ?? ev?.tool_call_id ?? null })
      } catch {}
    }
  } else if (rawOnEvent) {
    onEvent = (ev) => {
      try {
        rawOnEvent({ ...identityMeta(), ...ev, toolCallId: ev?.callId ?? ev?.toolCallId ?? ev?.tool_call_id ?? null })
      } catch {}
    }
  }

  const failoverOn = config?.failover === true || process.env.FORGE_FAILOVER === "1"
  const chain = failoverOn && !readonly ? fallbackChain(config, p.name, { health: readHealth() }) : []
  let chainIdx = 0
  const isFailworthy = isFailoverWorthy
  const resProfile = resourceProfile()
  let deepEffort = deep
  if (deepEffort === undefined) {
    const profile = config.chat?.profile ?? "auto"
    const resolved = resolveEffort(profile, task, { tier: resProfile.tier })
    deepEffort = resolved.deep
    if (profile === "auto" && deepEffort) onEvent?.({ type: "info", text: resolved.why, ...identityMeta() })
  }
  const maxSteps = Math.min(maxStepsOverride ?? config.agent?.maxSteps ?? AGENT_BUDGETS.maxSteps, readonly ? 10 : AGENT_BUDGETS.maxStepsHardCap)
  const maxToolCalls = Math.min(AGENT_BUDGETS.maxToolCallsHardCap, Math.max(10, config.agent?.maxToolCalls ?? AGENT_BUDGETS.maxToolCalls))
  const skillsDir = resolveSkillsDir(config.skills?.dir)
  const memoryPath = path.join(DEFAULT_DIR, "memory.md")
  const runId = effectiveRunId
  const log = runId && journal ? openRun({ runId, task, cwd: process.cwd(), kind: "agent", provider: p.name, model: p.model }) : null
  if (!suppressRunEvents) onEvent?.({ type: "run_start", runId, task, planOnly, readOnly: readonly, role, taskId: effectiveTaskId, segmentId: effectiveSegmentId, nodeId: effectiveNodeId })

  const isDelegatedSubAgent = readonly && !planOnly
  let plugins = []
  let pluginHost = null // v21.1: isolated plugin workers, closed in `finally`
  if (config.tools?.plugins !== false) {
    try {
      const loaded = await loadToolPlugins(undefined, {
        reserved: BUILTIN_TOOL_NAMES,
        grants: config.tools?.pluginGrants ?? {},
        cwd: process.cwd(),
        startedAt: pluginStartedAt,
        allowNewPlugins: config.tools?.allowNewPlugins === true,
      })
      const merged = await mergeLearnedPlugins(loaded, process.cwd(), {
        reserved: BUILTIN_TOOL_NAMES,
        startedAt: pluginStartedAt,
        allowNewPlugins: config.tools?.allowNewPlugins === true,
      })
      plugins = merged.tools
      pluginHost = merged
      if (!isDelegatedSubAgent) {
        for (const pp of plugins) onEvent?.({ type: "info", text: `tool plugin loaded: ${pp.name}${pp.readOnly ? " (read-only)" : ""} — ${pp.source}`, ...identityMeta() })
        for (const e of merged.errors) onEvent?.({ type: "info", text: `tool plugin skipped: ${e}`, ...identityMeta() })
      }
    } catch { }
  }
  let mcpClients = []
  if (!isDelegatedSubAgent && !noTools && config.tools?.mcp !== false) {
    try {
      const mcp = await loadMcpTools(config)
      if (mcp.tools.length) {
        plugins = [...plugins, ...mcp.tools]
        mcpClients = mcp.clients
        for (const t of mcp.tools) onEvent?.({ type: "info", text: `mcp tool loaded: ${t.name} — ${t.source}`, ...identityMeta() })
      }
      for (const e of mcp.errors) onEvent?.({ type: "info", text: `mcp server skipped: ${e}`, ...identityMeta() })
    } catch { }
  }
  let lspSession = null
  if (!isDelegatedSubAgent && !noTools && config.tools?.lsp !== false && Object.keys(config.lsp?.servers || {}).length) {
    try {
      lspSession = createLspSession(config, { cwd: process.cwd() })
      plugins = [...plugins, ...lspSession.tools]
      for (const t of lspSession.tools) onEvent?.({ type: "info", text: `lsp tool available: ${t.name}`, ...identityMeta() })
    } catch { lspSession = null }
  }
  let subCounter = 0
  // v25: a mutating autonomous agent may run node -e / python -c and
  // in-project git --hard without tools.assumeYes. Read-only / plan / verifier
  // paths stay on explicit consent. assumeYes is NEVER auto-flipped — that
  // would also permit outside-project rm, sudo, metadata, apt-get, npm publish.
  const autonomous = !readonly && config.agent?.autonomous !== false
  const klass = (() => { try { return classifyTask(task || "").class } catch { return null } })()
  const tools = makeToolContext({
    plugins: selectPlugins(task || "", plugins, { klass }),
    cwd: process.cwd(),
    root: process.cwd(),
    timeoutSec: config.agent?.timeoutSec ?? AGENT_BUDGETS.timeoutSec,
    maxToolOutput: config.agent?.maxToolOutput ?? AGENT_BUDGETS.maxToolOutput,
    skillsDir,
    searchUrl: config.tools?.searchUrl || "",
    memoryPath,
    todoPath: path.join(DEFAULT_DIR, "todo.json"),
    runId,
    readOnly: readonly || verifier,
    mode: verifier ? "verifier" : "default",
    allowOutsideProject: config.tools?.allowOutsideProject === true,
    allowSudo: config.tools?.allowSudo === true,
    allowNetworkUpload: config.tools?.allowNetworkUpload === true,
    allowInterpreterEval: config.tools?.allowInterpreterEval === true || autonomous,
    assumeYes: config.tools?.assumeYes === true,
    autonomous,
    fetchPrivateUrls: config.tools?.fetchPrivateUrls === true || process.env.FORGE_ALLOW_PRIVATE_URLS === "1",
    delegateTimeoutSec: config.agent?.delegateTimeoutSec ?? AGENT_BUDGETS.delegateTimeoutSec,
    maxParallelDelegates: config.agent?.maxParallelSubAgents ?? (resProfile.tier === "low" ? 1 : AGENT_BUDGETS.maxParallelSubAgents),
    signal,
    subAgent: readonly && !planOnly,
    vision: config.tools?.vision !== false,
    visionProvider: { protocol: p.protocol, model: p.model, baseUrl: p.baseUrl },
    browser: config.tools?.browser !== false,
    delegateRunner: readOnly && !planOnly
      ? null
      : (subTask, subRole) =>
        runAgent({
          config, provider: p, task: subTask, onEvent: rawOnEvent ? (ev) => rawOnEvent(ev) : null, signal,
          readOnly: true, maxStepsOverride: 10, role: subRole, sub: `w${++subCounter}`,
          taskId: effectiveTaskId, segmentId: effectiveSegmentId, nodeId: effectiveNodeId, runId: effectiveRunId,
        }).then((r) => r.text),
  })

  const intel = createToolIntel({
    exec: tools.exec,
    ctx: {
      cwd: process.cwd(),
      root: process.cwd(),
      readOnly: readonly,
      allowSudo: config.tools?.allowSudo === true,
      allowInterpreterEval: config.tools?.allowInterpreterEval === true || autonomous,
      assumeYes: config.tools?.assumeYes === true,
      autonomous,
    },
    config,
    onEvent,
    runId,
    taskId: effectiveTaskId ?? runId,
    task,
    plugins,
    legacyEvents: true,
  })
  if (!sub && config.tools?.explainRouting !== false) {
    try {
      const decision = intel.route(task, { constraints: { readOnly: readonly } })
      if (decision?.chain?.active?.length) {
        onEvent?.({ type: "info", text: `routing: ${decision.chain.reason}`, ...identityMeta() })
      }
    } catch { }
  }

  // v24 semantic retrieval: when retrieval.embeddings is enabled, rerank the
  // memory/learnings/repo-map BM25 shortlists with provider embeddings BEFORE
  // the prompt is assembled. Embeddings only REORDER; they never widen.
  // Delegated read-only sub-agents stay on plain BM25. Every failure leaves
  // the *Block null → the exact v20.2 BM25 path.
  let memoryBlock = null
  let learningsBlock = null
  let repoMapBlock = null
  if (!isDelegatedSubAgent && task) {
    try {
      const embCfg = resolveEmbeddingsConfig(config)
      if (embCfg.ok) {
        const embedder = createEmbedder(embCfg)
        const [mem, learn, map] = await Promise.all([
          relevantMemoryAsync(task, { cwd: process.cwd(), embedder, alpha: embCfg.alpha, budgetMs: embCfg.rerankBudgetMs }),
          relevantLearningsAsync(task, { cwd: process.cwd(), embedder, alpha: embCfg.alpha, budgetMs: embCfg.rerankBudgetMs }),
          config.context?.repoMap === false
            ? Promise.resolve(null)
            : buildRepoMapAsync(process.cwd(), {
              query: task,
              embed: (texts) => embedder.embed(texts),
              alpha: embCfg.alpha,
              budgetMs: embCfg.rerankBudgetMs,
            }),
        ])
        memoryBlock = mem
        learningsBlock = learn
        if (map !== null) repoMapBlock = map
        embedder.close()
        onEvent?.({ type: "info", text: `semantic retrieval: memory+repomap ranked by ${embCfg.provider}/${embCfg.model} (alpha ${embCfg.alpha})`, ...identityMeta() })
      }
    } catch { /* BM25 fallback — retrieval must never break a run */ }
  }

  let messages = [
    { role: "system", content: agentSystemPrompt({ cwd: process.cwd(), skillsDir, skillsEnabled: config.skills?.enabled !== false, readOnly: readonly, planOnly, memoryPath, deep: deepEffort, role, task, repoMap: config.context?.repoMap !== false, registry: intel.registry, memoryBlock, learningsBlock, repoMapBlock, config }) },
    { role: "user", content: planOnly ? `${task}\n\n(Produce a plan only — do not execute.)` : (extraContext ? `${task}\n\n${extraContext}` : task) },
  ]

  let steps = 0
  let finalText = ""
  let retryBudget = 3
  let overflowBudget = 2
  let switchedOk = false
  let toolCallCount = 0
  const toolLog = []
  const commandChecks = []
  // v21.1 P1 — verification integrity: every check records WHAT it covered.
  // `writesSoFar` is the ordered list of files this run wrote; a check remembers
  // how many writes preceded it, so meta.js can tell "tests passed, THEN the
  // agent edited src/x.js" apart from "edited, then tests passed". The former
  // is stale evidence for src/x.js and must not verify it.
  const writesSoFar = []
  const repoState = (() => {
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim()
      const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim().split("\n").filter(Boolean).length
      return { head, dirty }
    } catch { return null }
  })()
  const tokenUsage = { prompt: 0, completion: 0, total: 0, estimated: false }
  let ended = false
  const endRun = (status, extra = {}) => {
    if (ended) return
    ended = true
    if (log && !extra.keepRunning) log.end(status, extra)
    else if (log) log.flush()
    if (!suppressRunEvents) onEvent?.({ type: "run_end", runId, status, steps, toolCalls: toolLog.length, text: extra.text ?? "", error: extra.error ?? null, wrote: extra.wrote ?? false, tools: intel.stats(), taskId: effectiveTaskId, segmentId: effectiveSegmentId, nodeId: effectiveNodeId })
  }
  try {
    while (steps < maxSteps) {
      steps++
      log?.step(steps)
      onEvent?.({ type: "step", step: steps, ...identityMeta() })
      let msg
      try {
        msg = await chatOnce({
          protocol: p.protocol,
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          model: p.model,
          providerName: p.name,
          messages,
          tools: noTools ? undefined : intel.toolDefs(tools.defs),
          signal,
          deep: deepEffort,
          maxTokens: deepEffort ? 16384 : undefined,
          connectMs: config.retry?.connectMs,
          requestTimeoutMs: config.retry?.requestTimeoutMs,
        })
      } catch (e) {
        if (e instanceof ProviderError && e.contextOverflow && overflowBudget > 0) {
          overflowBudget--
          onEvent?.({ type: "compacted", before: messages.length, after: -1, estTok: estimateTokens(JSON.stringify(messages)), budgetTok: 0, reason: "context overflow — compressing and retrying", ...identityMeta() })
          messages = await compactAgentHistory(messages, p, { onEvent, force: true })
          messages = hardShrink(messages)
          steps--
          continue
        }
        if (e instanceof ProviderError && e.retryable && retryBudget > 0) {
          retryBudget--
          onEvent?.({ type: "retry", error: e.message, step: steps, left: retryBudget, ...identityMeta() })
          const wait = Math.max(2000 * (3 - retryBudget), e.retryAfterMs ?? 0)
          await new Promise((r) => setTimeout(r, Math.min(60000, wait)))
          steps--
          continue
        }
        if (isFailworthy(e) && chainIdx < chain.length) {
          // v21.1 P1: only switch to a provider that can carry THIS request
          // (context fits, tools supported). If none can, stop with a clear
          // error instead of failing again on an incompatible model.
          // v21.1: window + tool protocol always; a deep-effort (complex/critical)
          // task additionally needs a reasoning-capable model when the registry
          // knows the candidate (unknown models are not rejected on capability).
          const need = { promptTokens: estimateTokens(JSON.stringify(messages)), tools: !noTools && tools.defs.length > 0, capabilities: deepEffort ? ["reasoning"] : [] }
          const pick = nextCompatibleFallback(chain, chainIdx, need)
          chainIdx = pick.idx
          recordHealth(p.name, { ok: false, error: String(e.message).slice(0, 160), model: p.model })
          for (const sk of pick.skipped) onEvent?.({ type: "failover_skipped", from: `${p.name}/${p.model}`, to: `${sk.name}/${sk.model}`, reason: sk.reason, ...identityMeta() })
          if (!pick.next) {
            const why = pick.skipped.map((s) => `${s.name}: ${s.reason}`).join("; ")
            throw new ProviderError(`${e.message} — failover stopped: no compatible fallback provider (${why || "chain exhausted"})`, { status: e.status, retryable: false })
          }
          const next = pick.next
          onEvent?.({ type: "failover", from: `${p.name}/${p.model}`, to: `${next.name}/${next.model}`, reason: e.message, ...identityMeta() })
          p = next
          retryBudget = 3
          steps--
          continue
        }
        throw e
      }

      if (chainIdx > 0 && !switchedOk) { switchedOk = true; recordHealth(p.name, { ok: true, model: p.model }) }

      if (msg.reasoning && onEvent) onEvent({ type: "reasoning", text: msg.reasoning, ...identityMeta() })

      try {
        const u = msg.usage || {}
        const pin = Number(u.prompt_tokens ?? u.input_tokens ?? 0)
        const cpl = Number(u.completion_tokens ?? u.output_tokens ?? 0)
        if (pin || cpl) { tokenUsage.prompt += pin; tokenUsage.completion += cpl; tokenUsage.estimated = false }
        else {
          tokenUsage.estimated = true
          const estIn = estimateTokens(JSON.stringify(messages))
          if (estIn > tokenUsage.prompt) tokenUsage.prompt = estIn
          tokenUsage.completion += estimateTokens(msg.content || "")
        }
        tokenUsage.total = tokenUsage.prompt + tokenUsage.completion
        onEvent?.({ type: "usage", prompt: tokenUsage.prompt, completion: tokenUsage.completion, total: tokenUsage.total, estimated: tokenUsage.estimated, ...identityMeta() })
      } catch { }

      if (msg.toolCalls?.length) {
        toolCallCount += msg.toolCalls.length
        if (toolCallCount > maxToolCalls) {
          messages.push({ role: "user", content: `(system) tool-call budget exhausted (${maxToolCalls} calls) — stop calling tools and produce your final answer now with what you have.` })
          continue
        }
        messages.push({
          role: "assistant",
          content: msg.content || "",
          tool_calls: msg.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.args } })),
        })
        const results = await intel.runBatch(
          msg.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: safeJson(tc.args) })),
          { step: steps }
        )
        for (let i = 0; i < msg.toolCalls.length; i++) {
          const tc = msg.toolCalls[i]
          if (!results[i]) results[i] = { result: "ERROR: tool did not run", ms: 0 }
          const { result, ms } = results[i]
          toolLog.push({ step: steps, name: tc.name, result: String(result).slice(0, 200) })
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
                commandChecks.push({
                  command: command.slice(0, 300), exitCode, timedOut, passed: exitCode === 0 && !timedOut, tail,
                  // verification record context (P1): when/where it ran and what it covered
                  step: steps, at: Date.now(), cwd: process.cwd(), repoState,
                  env: { NODE_ENV: process.env.NODE_ENV ?? null, CI: process.env.CI ?? null },
                  stdoutTail: rstr.slice(-2000),
                  writesBefore: writesSoFar.slice(),
                  writeIndex: writesSoFar.length,
                })
                onEvent?.({ type: "command_check", command: command.slice(0, 200), exitCode, passed: exitCode === 0 && !timedOut, tail, step: steps, ...identityMeta(), toolCallId: tc.id })
              }
            } catch { }
          }
          {
            const r = String(result)
            const okRes = !(r.startsWith("ERROR") || r.startsWith("BLOCKED"))
            if (okRes && WRITE_TOOLS.has(tc.name) && tc.name !== "bash") {
              for (const [fp, action] of journalFiles(tc.name, tc.args, r)) { writesSoFar.push(fp); if (log) log.touched(fp, action) }
            } else if (okRes && tc.name === "bash" && hasWriteRedirection(String(safeJson(tc.args)?.command ?? ""))) {
              writesSoFar.push("(shell write)") // unknown target: conservatively counts as a write after any earlier check
            }
            if (log) log.tool(tc.name, journalTarget(tc.name, tc.args), okRes)
          }
          messages.push({ role: "tool", tool_call_id: tc.id, content: String(result) })
        }
        injectPendingVision(messages, tools.ctx)
        messages = await compactAgentHistory(messages, p, { onEvent })
        continue
      }

      finalText = msg.content || "(empty answer)"
      break
    }

    for (const chk of commandChecks) chk.filesWrittenAfter = writesSoFar.slice(chk.writeIndex)
    const budgetHit = steps >= maxSteps
    if (budgetHit && !finalText) {
      finalText = "(reached the per-segment step budget without a final answer)"
    }
    const wrote = toolLog.some((t) => WRITE_TOOLS.has(t.name) && !String(t.result).startsWith("ERROR") && !String(t.result).startsWith("BLOCKED"))
    if (log) { try { for (const c of listCheckpoints(process.cwd(), 50)) if (c.runId === runId) log.checkpoint(c.id) } catch {} }
    endRun("completed", { text: finalText, wrote })
    return { status: "COMPLETED", text: finalText, steps, taskId: effectiveTaskId ?? null, segmentId: effectiveSegmentId ?? null, nodeId: effectiveNodeId ?? null, runId, toolLog, commandChecks, planOnly, wrote, budgetHit, usage: { promptTokens: tokenUsage.prompt ?? 0, completionTokens: tokenUsage.completion ?? 0, totalTokens: (tokenUsage.prompt ?? 0) + (tokenUsage.completion ?? 0), latencyMs: tokenUsage.latencyMs ?? 0, toolCalls: toolLog?.length ?? 0, ...tokenUsage }, toolStats: intel.stats(), toolRecords: intel.records(), error: null }
  } catch (e) {
    const wrote = toolLog.some((t) => WRITE_TOOLS.has(t.name) && !String(t.result).startsWith("ERROR") && !String(t.result).startsWith("BLOCKED"))
    if (e?.name === "AbortError" || signal?.aborted) endRun("cancelled", { wrote })
    else endRun("failed", { error: e?.message ?? String(e), wrote })
    throw e
  } finally {
    for (const c of mcpClients) { try { c.close() } catch {} }
    if (lspSession) { try { lspSession.close() } catch {} }
    if (pluginHost) { try { pluginHost.close() } catch {} }
    try { await closeBrowserSession(tools.ctx) } catch {}
  }
}

function journalTarget(name, argStr) {
  const a = safeJson(argStr || "{}")
  const t = a.path ?? a.command ?? a.pattern ?? a.url ?? a.query ?? a.name ?? a.action ?? ""
  return String(t).split("\n")[0].slice(0, 160)
}

function journalFiles(name, argStr, result) {
  const a = safeJson(argStr || "{}")
  const out = []
  const abs = (p) => path.resolve(process.cwd(), String(p))
  if (name === "write_file" && a.path) out.push([abs(a.path), /created/i.test(result) ? "created" : "modified"])
  else if ((name === "edit_file" || name === "multi_edit") && a.path) out.push([abs(a.path), "modified"])
  else if (name === "apply_patch") {
    const m = String(result).match(/created ([^•]+?)(?: •|$| \(|)/)
    if (m) for (const f of m[1].split(",")) out.push([abs(f.trim()), "created"])
    const d = String(result).match(/deleted ([^•]+?)(?: •|$| \(|)/)
    if (d) for (const f of d[1].split(",")) out.push([abs(f.trim()), "deleted"])
    try {
      const re = /^\+\+\+ (?:b\/)?(\S+)/gm
      let mm
      while ((mm = re.exec(String(a.patch ?? "")))) if (mm[1] !== "/dev/null" && !out.some((x) => x[0] === abs(mm[1]))) out.push([abs(mm[1]), "modified"])
    } catch {}
  }
  return out
}

function hardShrink(messages) {
  const seen = new Map()
  return messages.map((m, i) => {
    if (m?.role !== "tool" || typeof m.content !== "string") return m
    if (i >= messages.length - 6) return m
    const key = m.content.slice(0, 120)
    if (seen.has(key)) return { ...m, content: "[duplicate tool output removed]" }
    seen.set(key, true)
    if (m.content.length > 600) return { ...m, content: shrinkToolOutput(m.content, 600) } // v21.1: keep head/tail/errors, not a bare stub
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

export function agentEventPrinter() {
  return function onEvent(ev) {
    if (ev.sub) return
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

void fs
