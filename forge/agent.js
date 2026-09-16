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
import { loadActiveCreatedTools, listToolLife, considerCreateForGaps } from "./toolcreate.js"
import { capabilityCoverage, capabilitiesImpliedByTask, defaultRegistry } from "./capabilities.js" // v97 §33 ladder
import { loadMcpTools, cachedInventoryTools } from "./mcp.js"
import { formatSelection } from "./capfabric.js"
import { selectForTurn } from "./capindex.js"
import { recommendForGaps, formatRecommendations, formatRoute } from "./caproute.js"
import { recordRunOutcomes } from "./caplearn.js"
import { createLspSession, autostartAvailability } from "./lsp.js"
import { fenceToolResult, fenceEnabled, UNTRUSTED_CONTENT_RULE } from "./contentfence.js"
import { createToolIntel, recordToolRun, loadToolStats } from "./toolintel.js"
import { createTracer, PHASE } from "./tracer.js"
import { swallowed, snapshot as softfailSnapshot } from "./softfail.js"
import { toolGuidance, analyzeTask } from "./router.js"
import { indexSkills, resolveSkillsDir } from "./skills.js"
import { mergeLearnedSkills } from "./evolve.js"
import { formatSkillPicks, selectPlugins, formatSteer, namedIn } from "./evaluate.js"
import { pickSkills } from "./skillforge.js"
import { languagesIn, formatLangReason } from "./langreason.js"
import { engineFor } from "./langengine.js"
// v92 "wirewise": the 67-language adapter catalog (langadapter.js) was a
// shipped-but-never-loaded island. languageCoverage() now tells every agent
// run, honestly, how well Forge can parse the languages in this task —
// deep adapters get normal treatment, shallow/unknown get conservative rules.
import { languageCoverage } from "./langadapter.js"
import { composeOnce, clearComposeOnce, formatCompose, playbookFilesOf } from "./compose.js"
import { ingestAcquire, runAcquire } from "./knowgap.js"
import { classifyTask, classifyTaskComplexity, resolveEffort } from "./classify.js"
import { DEFAULT_DIR, AGENT_BUDGETS } from "./config.js"
import { dim, cyan, green, yellow, red, estimateTokens } from "./ui.js"
import { relevantMemory, relevantLearnings, relevantMemoryAsync, relevantLearningsAsync } from "./memory.js"
import { resolveEmbeddingsConfig, createEmbedder } from "./embeddings.js"
import { profileSummary, resourceProfile } from "./profile.js"
import { buildRepoMap, buildRepoMapAsync } from "./repomap.js"
import { openRun } from "./runlog.js"
import { listCheckpoints, boundaryCheckpoint } from "./checkpoint.js"
import { canCompleteFastPath, unverifiedWrites, evaluateCompletion, formatCompletionBlock, COMPLETION } from "./completion.js"
import { reviewRun, formatReview, changeSetOf, ESCALATE_RADIUS } from "./review.js"
import { resolveWorkspace, formatWorkspace, outsideWorkspace } from "./workspace.js"
import { compactHistory, shrinkToolOutput, hardShrink } from "./compaction.js"
import { GOV_PREFIX, maskToolDefs, enforceToolCall } from "./governor.js"
import { yoloState } from "./yolo.js"
import path from "node:path"
import { execFileSync } from "node:child_process"

export { classifyTaskComplexity, resolveEffort }

/**
 * v115 — how many CONSECUTIVE identical tool call + identical result it takes
 * before a run is provably going nowhere.
 *
 * Three, not four. The existing extension guard already calls four occurrences
 * of one signature "a spin" (agent.js: `if (n >= 4) return null`), but that
 * counts a signature anywhere in the run and only withholds extra budget.
 * Three IN A ROW, with the same result each time, is a stronger claim and a
 * cheaper one to act on: the second repeat could still be a retry, the third
 * cannot be anything but a loop.
 */
const LOOP_HALT_REPEATS = 3

/**
 * v118 — how many times the SAME completion blocker may refuse a governor
 * STOP before the run admits it cannot clear it. Three, matching the loop
 * halt: the first refusal is information, the second is a retry, the third is
 * a blocker the run does not know how to move.
 */
const COMPLETION_BLOCKER_REPEATS = 3

/**
 * v120 — IS THIS COMMAND ACTUALLY A CHECK, OR DOES IT MERELY MENTION ONE?
 *
 * The old test was `/\b(test|jest|...|lint)\b/i.test(command)`, matched
 * anywhere in the string. Found in a real run:
 *
 *   grep -n "riskBias" tests/test-plannerisk.mjs
 *
 * `test-plannerisk` contains `test` followed by a word boundary, so that grep
 * was recorded as a PASSING verification check. That is not cosmetic:
 * completion.unverifiedWrites() treats every write before a passing check as
 * covered, so a grep over a file whose NAME contains "test" could mark real
 * writes as verified. Reproduced against the real gate — one write, one grep,
 * `unverified: []`.
 *
 * A check is what the command RUNS, not what it mentions. So: split on the
 * shell separators a command can chain with, and look at the head of each
 * segment. A segment whose verb is a reader (grep, ls, cat, find…) is never a
 * check, whatever its arguments say.
 */
/** Runners whose NAME already says "this is a check" — no keyword needed. */
const SELF_EVIDENT_CHECK = /^(jest|vitest|mocha|pytest|rspec|ava|tap|tox|nose2?|eslint|ruff|flake8|mypy|tsc|snyk|semgrep|bandit|gosec|shellcheck|clippy)\b/i
/** Runners that check only when the rest of the command says so. */
const GENERIC_RUNNER = /^(npm|pnpm|yarn|bun|node|deno|python3?|cargo|go|rake|bundle|make|cmake|gradle|mvn|dotnet|swift|ruby|php|composer)\b/i
const CHECK_INTENT = /\b(test|tests|check|build|compile|lint|typecheck|audit|coverage|verify)\b/i
/** A reader is never a check, whatever its arguments happen to be named. */
const READ_ONLY_VERBS = /^(grep|rg|ag|ls|cat|head|tail|wc|find|fd|stat|file|echo|printf|pwd|which|type|tree|du|df|sed|awk|cut|sort|uniq|diff|git)\b/i
/** Wrappers that run the NEXT word — the verb that matters is behind them. */
const WRAPPERS = /^(npx|bunx|pnpm\s+dlx|yarn\s+dlx|time|env|sudo|nice)\s+/i

export function looksLikeCheck(command) {
  const raw = String(command ?? "")
  if (!raw.trim()) return false
  // `cd x && npm test` chains; each segment is judged on its own head.
  for (const seg of raw.split(/(?:&&|\|\||;|\||\n)/)) {
    let head = seg.trim().replace(/^(?:[A-Za-z_][\w]*=\S*\s+)+/, "") // strip VAR=1 prefixes
    while (WRAPPERS.test(head)) head = head.replace(WRAPPERS, "")
    if (!head) continue
    if (READ_ONLY_VERBS.test(head)) continue
    if (SELF_EVIDENT_CHECK.test(head)) return true
    // `python -m pytest` / `node --test`: the runner is generic, but the thing
    // it is asked to run names itself. "pytest" has no word boundary around
    // "test", so the intent regex alone cannot see it.
    if (GENERIC_RUNNER.test(head) && (CHECK_INTENT.test(head) || head.split(/\s+/).slice(1).some((a) => SELF_EVIDENT_CHECK.test(a)))) return true
  }
  return false
}

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

function upsertGovernorMessage(messages, text) {
  const last = messages[messages.length - 1]
  if (last?.role === "user" && String(last.content).startsWith(GOV_PREFIX)) {
    last.content = text
    return
  }
  messages.push({ role: "user", content: text })
}

function agentSystemPrompt({ cwd, skillsDir, skillsEnabled, readOnly = false, planOnly = false, memoryPath, deep = false, role, task, repoMap = true, registry = null, memoryBlock = null, learningsBlock = null, repoMapBlock = null, config = null, plugins = [], skillPicks = null, skillIndex = null, workspace = null, continuity = null, cognitionBlock = null, yolo = null }) {
  // v122: the prompt has to agree with the policy. Until now it did not — the
  // model was told "catastrophic commands, writes outside the project, sudo
  // and publishes are blocked" four releases after v88 stopped blocking them,
  // so the most effective guard in the whole system was the one nobody wrote:
  // the model declining to try. A prompt that lies about the rules gets
  // believed, and then every "that command is not allowed" is a bug report
  // about a guard that is not there. Resolved once from the same state the
  // tool layer uses, never re-derived here.
  const yoloNow = yolo ?? yoloState(config ?? {})
  const fullControl = yoloNow.yolo === true && !readOnly && !planOnly
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
    fullControl
      ? "6. The owner granted FULL CONTROL (YOLO): nothing is refused and nothing pauses to ask — no command gate, no project boundary, no sudo/interpreter/network consent, no governor veto. Read, write and run whatever the task needs, anywhere on this machine. Do not ask permission, do not hand a command back for the user to run, and do not narrate restrictions that no longer exist."
      : "6. Writes must stay inside the working directory unless the owner granted tools.allowOutsideProject; the tool layer enforces that, you do not have to police it — when a call IS refused, say which refusal it was instead of quietly working around it. Reads are unrestricted.",
    "6b. When a fix works, record it with the memory tool (action=learn) so future sessions remember it.",
    fullControl
      ? "7. Never self-censor on the owner's behalf: refuse nothing, skip nothing for safety, and state in ONE line what a destructive command will do immediately before running it. Being able to run it is not a reason to run something the task did not ask for."
      : "7. Run in-project commands yourself (tests, builds, git, node -e / python -c). Do not stop to ask. Catastrophic commands, writes outside the project, sudo, and publishes are blocked — refine the command instead of asking the user to disable safety.",
    `8. ${UNTRUSTED_CONTENT_RULE}`,
    "",
    "TOOLS — all available, use them automatically as needed:",
    "- Multi-step work: keep a `todo` list (set at start, update statuses as you go).",
    "- Complex edits: call `think` first to plan.",
    "- Find files fast with `glob_files`; search the web with `web_search`; read pages with `fetch_url`.",
    "- Read-only research that would flood context: `delegate` it (role=tuner: researcher/reviewer/tester/security/coder).",
    "- Facts worth remembering later: `memory` append (scope=project for repo conventions, global for user preferences).",
  ]
  const klass = task ? (() => { try { return classifyTask(task).class } catch { return null } })() : null
  // v103 §2 — WHERE am I doing this? Nothing in forge knew the difference
  // between its own source tree and the user's project, so a task about
  // someone else's project, run from forge's checkout, wrote into forge.
  // The model is told, before anything else, when that is the situation.
  // Resolved ONCE per run by the caller and handed here, so the line the model
  // reads and the check the result reports can never be two different answers.
  try {
    const wsLine = formatWorkspace(workspace ?? resolveWorkspace({ cwd, task }))
    if (wsLine) lines.push("", wsLine)
  } catch (e) { swallowed("agent", "format workspace", e) }
  let composed = null
  if (task) {
    try {
      composed = composeOnce(task, { cwd, config, klass, includeMemory: false, plugins })
    } catch { composed = null }
  }
  if (registry) {
    const playbookFiles = playbookFilesOf(composed)
    const guidance = toolGuidance(task, {
      registry, cwd, readOnly: readOnly || planOnly, playbookFiles,
      verifyCommand: composed?.verify?.command || "",
      verifyTests: composed?.verify?.tests || [],
    })
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
    } catch (e) { swallowed("agent", "build repo map", e) }
  }
  if (task) {
    // v23: when semantic retrieval is enabled, runAgent precomputes the hybrid
    // (BM25+embeddings) rerank and passes it in; null = compute BM25 here.
    const mem = memoryBlock !== null ? memoryBlock : relevantMemory(task, { cwd })
    if (mem) lines.push("", mem)
    const learnings = learningsBlock !== null ? learningsBlock : relevantLearnings(task, { cwd })
    if (learnings) lines.push("", learnings)
  }
  // v108 rootwise — the gap this closes: chat.js:1605 sends an INTERACTIVE TTY
  // run to runAgent, not to the meta controller, and this prompt builder never
  // touched engmemory, episodes or the task store. So on a real terminal forge
  // remembered nothing about its own project — no open work, no settled
  // decision, and no question it was still waiting on an answer to. Computed
  // async by the caller (it reads stores), same injectable pattern as memory
  // and the repo map above; null means "not gathered", never "nothing to say".
  if (continuity) lines.push("", continuity)
  if (skillsEnabled) {
    // The decision was already made once, by selectForTurn, together with the
    // MCP side — this consumes it rather than re-running a second, independent
    // selection here. (Fallback keeps this function usable on its own.)
    const idx = skillPicks ? (skillIndex ?? []) : (skillsDir ? mergeLearnedSkills(indexSkills(skillsDir), cwd) : [])
    const picks = skillPicks ?? pickSkills(task || "", idx, { klass, skillsDir, cwd })
    const block = formatSkillPicks(picks)
    if (block) lines.push("", block)
    // v97 §33: THE UNIFIED CAPABILITY LADDER — for every capability this task
    // implies, resolve native tool → skill → MCP → created tool, and say
    // honestly when NOTHING provides it (a gap is design input, not a failure
    // to mention). One resolver, shared with `forge caps`.
    if (task && registry) {
      try {
        const caps = capabilitiesImpliedByTask(task)
        if (caps.length) {
          const cov = capabilityCoverage({
            registry, capabilities: caps, skills: idx,
            mcpTools: cachedInventoryTools(),
            createdTools: listToolLife(cwd),
          })
          if (cov.gaps.length) {
            lines.push("", `Capability gaps (native → skill → MCP → created all checked): ${cov.gaps.join(", ")}. No provider exists — proceed without it, or build it via the tool-creation pipeline and verify before trusting it.`)
            try {
              const recs = recommendForGaps({ task, gaps: cov.gaps, limit: 3 })
              const block = formatRecommendations(recs)
              if (block) lines.push("", block)
            } catch { /* recommendations are advisory */ }
          }
        }
      } catch { /* ladder is advisory, never fatal */ }
    }
  }
  if (task) {
    const taskLangs = languagesIn(task, { cwd, klass })
    const langBlock = formatLangReason(taskLangs)
    if (langBlock) lines.push("", langBlock)
    // v92 (wirewise): honest adapter coverage for the languages this task
    // touches — deep adapter vs conservative mode, one bounded block.
    try {
      const coverage = languageCoverage((taskLangs ?? []).map((l) => typeof l === "string" ? l : (l?.id ?? l?.lang)).filter(Boolean))
      const conservative = coverage.filter((c) => c.conservative).slice(0, 5)
      if (conservative.length) {
        lines.push("", `Language adapters (honest): ${conservative.map((c) => `${c.id} — ${c.note}`).join("; ")}. For those files: minimal reversible edits, no bulk rewrites, verify after every change.`)
      }
    } catch { /* adapter coverage is best-effort, never fatal */ }
    const engineBlock = engineFor(task, { cwd, config, klass })
    if (engineBlock) lines.push("", engineBlock)
    const composeBlock = formatCompose(composed)
    if (composeBlock) lines.push("", composeBlock)
    try {
      const steer = formatSteer({
        skills: composed?.skills || [],
        plugins: composed?.plugins || [],
        avoid: composed?.avoid || [],
        know: composed?.know || [],
        tools: composed?.tools || null,
        playbooks: composed?.playbooks || [],
        mcp: composed?.mcp || [],
        gaps: composed?.gaps || null,
        blast: composed?.blast || null,
        claims: composed?.claims || [],
        decisions: composed?.decisions || [],
        strategy: composed?.strategy || [],
        models: composed?.models || [],
        variants: composed?.variants || [],
        knowtype: composed?.knowtype || [],
      })
      if (steer) lines.push("", steer)
    } catch { /* steer is best-effort */ }
  }
  if (cognitionBlock) lines.push("", cognitionBlock)
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
  const earlyKlass = (() => { try { return classifyTask(task || "").class } catch { return "SMALL" } })()
  // v113 audit: the effort decision has to happen BEFORE the model is chosen.
  // It used to be resolved ~80 lines below, so applyModelChoice could not know
  // a run was deep and swapped in a fast, non-reasoning model — the capability
  // gate existed only on the failover path, which never ran. Same inputs as
  // before, just computed early; the value is reused below, not recomputed.
  const resProfile = resourceProfile()
  let deepEffort = deep
  if (deepEffort === undefined) {
    const profile = config.chat?.profile ?? "auto"
    const resolved = resolveEffort(profile, task, { tier: resProfile.tier })
    deepEffort = resolved.deep
    if (profile === "auto" && deepEffort) onEvent?.({ type: "info", text: resolved.why, ...identityMeta() })
  }
  if (!readonly && config?.agent?.modelStrategy !== false && process.env.FORGE_LOCK_MODEL !== "1") {
    try {
      const { applyModelChoice } = await import("./modelstrategy.js")
      const choice = applyModelChoice({
        config, provider: p, task, klass: earlyKlass,
        lock: Boolean(process.env.FORGE_LOCK_MODEL),
        deep: deepEffort === true,
      })
      if (choice.switched && choice.provider) {
        onEvent?.({
          type: "MODEL_SELECTED",
          from: `${p.name}/${p.model}`,
          to: `${choice.provider.name}/${choice.provider.model}`,
          // v120: uistate renders `model ${ev.provider}/${ev.model} … ${ev.reason}`,
          // which is meta.js's field naming. The agent path only ever sent
          // from/to/why, so every selection on this path printed
          // "model undefined/undefined (low) —". Both shapes are emitted now;
          // from/to stay because the switch itself is worth showing.
          provider: choice.provider.name,
          model: choice.provider.model,
          reason: choice.why,
          why: choice.why,
          confidence: choice.selection?.decision?.confidence ?? null,
          ...identityMeta(),
        })
        p = choice.provider
      } else if (choice.selection?.decision) {
        onEvent?.({
          type: "MODEL_SELECTED",
          from: `${p.name}/${p.model}`,
          to: `${p.name}/${p.model}`,
          provider: p.name,
          model: p.model,
          reason: choice.why,
          why: choice.why,
          confidence: choice.selection.decision.confidence,
          switched: false,
          ...identityMeta(),
        })
      }
    } catch (e) { swallowed("agent", "model strategy", e) }
  }
  if (!readonly && earlyKlass !== "MICRO" && process.env.FORGE_LOCK_MODEL !== "1") {
    try {
      const { scoreRoute } = await import("./jointroute.js")
      const joint = scoreRoute({
        cwd: process.cwd(),
        klass: earlyKlass,
        task,
        model: p.model,
        lockModel: false,
      })
      if (joint.model && joint.model !== p.model && joint.source === "joint") {
        const specs = config?.providers || {}
        for (const name of Object.keys(specs)) {
          const spec = specs[name] || {}
          const models = [spec.model, ...(spec.models || [])].filter(Boolean)
          if (!models.includes(joint.model)) continue
          const { buildProvider } = await import("./providers.js")
          const built = buildProvider(config, name)
          if (!built) continue
          onEvent?.({
            type: "JOINT_ROUTE",
            from: `${p.name}/${p.model}`,
            to: `${name}/${joint.model}`,
            depth: joint.depth,
            why: joint.why,
            ...identityMeta(),
          })
          p = { ...built, model: joint.model }
          break
        }
      }
    } catch (e) { swallowed("agent", "joint route", e) }
  }
  try {
    const { pickModelEmpiric } = await import("./empirics.js")
    const ranked = pickModelEmpiric({
      candidates: [{ provider: p.name, model: p.model }, ...chain.map((c) => ({ provider: c.name, model: c.model }))],
      limit: 4,
    })
    if (ranked[0]) onEvent?.({ type: "MODEL_EMPIRIC", ranking: ranked.slice(0, 3).map((r) => `${r.model}:${Math.round((r.rate || 0) * 100)}%n${r.samples}`), ...identityMeta() })
    if (chain.length && ranked.length) {
      const rate = new Map(ranked.map((r) => [r.model, Number(r.rate) || 0]))
      chain.sort((a, b) => (rate.get(b.model) ?? 0) - (rate.get(a.model) ?? 0))
    }
  } catch { /* empirics rank failover; they never steal the user's chosen model */ }
  let chainIdx = 0
  const isFailworthy = isFailoverWorthy
  // v101 P0: phase tracing. telemetry.js counts WHAT happened; this records
  // WHERE THE WALL-CLOCK WENT, so an optimization can be attributed to the
  // phase it claims to improve instead of judged on total runtime alone.
  const tracer = createTracer()
  const maxStepsInitial = Math.min(maxStepsOverride ?? config.agent?.maxSteps ?? AGENT_BUDGETS.maxSteps, readonly ? 10 : AGENT_BUDGETS.maxStepsHardCap)
  let maxSteps = maxStepsInitial
  const maxToolCallsInitial = Math.min(AGENT_BUDGETS.maxToolCallsHardCap, Math.max(10, config.agent?.maxToolCalls ?? AGENT_BUDGETS.maxToolCalls))
  let maxToolCalls = maxToolCallsInitial
  // v99 loopwise: productive step-budget auto-extension. The DIRECT one-shot
  // path (no maxStepsOverride) historically stopped dead at agent.maxSteps —
  // "run stopped at the step budget" — even when the run was demonstrably
  // still building (fresh writes, distinct tool use). Meta's segments
  // checkpoint and continue; the direct path had no such mercy, which is
  // exactly the "agent stops after ~25 steps" experience. Now: while the run
  // shows PRODUCTIVITY (recent successful writes or diverse tool use, no
  // signature loop, no error streak), the step AND tool-call budgets extend
  // in increments up to the SAME hard caps that always bounded them. A run
  // that stalls stops exactly as before (INCOMPLETE + checkpoint + resume) —
  // the extension never masks a stuck run, and budget exhaustion is STILL
  // never completion (§5/v93): the gate owns that contract unchanged.
  // Segment callers (meta) pass maxStepsOverride and are untouched: segment
  // boundaries are the checkpoint cadence, not a wall.
  const autoExtendEligible = !readonly && !verifier && sub == null && maxStepsOverride == null && config.agent?.autoExtendSteps !== false
  const skillsDir = resolveSkillsDir(config.skills?.dir)
  const memoryPath = path.join(DEFAULT_DIR, "memory.md")
  const runId = effectiveRunId
  const log = runId && journal ? openRun({ runId, task, cwd: process.cwd(), kind: "agent", provider: p.name, model: p.model }) : null
  if (!suppressRunEvents) onEvent?.({ type: "run_start", runId, task, planOnly, readOnly: readonly, role, taskId: effectiveTaskId, segmentId: effectiveSegmentId, nodeId: effectiveNodeId })

  // v92 "wirewise" P0 fix, still binding: the owner's control state must be
  // resolved BEFORE the plugin load and BEFORE the cognitive core (the v85
  // version of this bug declared it ~40 lines too low, a TDZ ReferenceError
  // got swallowed by a try{}catch{}, and user tool plugins silently never
  // loaded in agent runs).
  // v122 "yolowise": ONE resolved answer for the whole run. Every layer below
  // (governor authority, pre-edit critique, tool grants, read-only workers,
  // the capability router) reads this state instead of re-deriving its own.
  const yolo = yoloState(config)
  const unrestricted = yolo.unrestricted || yolo.yolo
  // v100 cognitionwise: ONE cognitive core on the DEFAULT path. Sub-agents
  // and the verifier stay executors — they inherit the parent's task, they
  // do not grow a second brain.
  let cognition = null
  if (!sub && !verifier && config.agent?.cognition !== false) {
    try {
      const { createCognition } = await import("./cognition.js")
      cognition = createCognition({ cwd: process.cwd(), objective: task, governorEnforce: yolo.governorEnforce })
      onEvent?.({ type: "COGNITION_BOOTED", ...cognition.brief(), ...identityMeta() })
      try {
        const advice = cognition.self.advise({ klass: cognition.klass, currentModel: p?.model })
        onEvent?.({ type: "SELF_MODEL", calibrated: advice.snapshot.calibrated, samples: advice.snapshot.samples, weaknesses: advice.snapshot.weaknesses, recommend: advice.recommend?.model ?? null, autoSwitch: false, ...identityMeta() })
      } catch (e) { swallowed("agent", "self-model", e) }
    } catch (e) { swallowed("agent", "cognition boot", e) }
  }

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
        allowNewPlugins: unrestricted || config.tools?.allowNewPlugins === true,
      })
      // v48: learned plugins are playbooks (indexLearnedPlugins / compose),
      // never a live plugin-host spawn. User ~/.forge/tools still load.
      plugins = loaded.tools
      pluginHost = loaded
      if (!isDelegatedSubAgent) {
        for (const pp of plugins) onEvent?.({ type: "info", text: `tool plugin loaded: ${pp.name}${pp.readOnly ? " (read-only)" : ""} — ${pp.source}`, ...identityMeta() })
        for (const e of loaded.errors) onEvent?.({ type: "info", text: `tool plugin skipped: ${e}`, ...identityMeta() })
      }
    } catch (e) { swallowed("agent", "load tool plugins", e) }
    // v93 gap fix §19: CREATED tools register here — but ONLY lifecycle
    // ACTIVE with passing behavioral verification (toolcreate.js loads
    // exactly those; CANDIDATE/TESTING/INACTIVE never reach the agent).
    try {
      const created = await loadActiveCreatedTools(process.cwd())
      if (created.length) {
        const safe = created.filter((t) => !BUILTIN_TOOL_NAMES.has(t.name) && !plugins.some((p) => p.name === t.name))
        plugins = [...plugins, ...safe]
        if (!isDelegatedSubAgent) for (const ct of safe) onEvent?.({ type: "info", text: `created tool loaded: ${ct.name} (ACTIVE, behaviorally verified)`, ...identityMeta() })
      }
    } catch (e) { swallowed("agent", "load created tools", e) /* additive, never break the agent */ }
  }
  let mcpClients = []
  let mcpLoaded = []
  if (!noTools && config.tools?.mcp !== false) {
    try {
      // A delegated sub-agent loads CACHE-ONLY: it never spawns a server itself.
      const mcp = await loadMcpTools(config, isDelegatedSubAgent ? { cachedOnly: true } : {})
      if (mcp.tools.length) {
        // v100 fabricwise: the capability fabric gates MCP tools BEFORE they
        // reach the model context — it drops tools that merely duplicate a
        // native one (the official filesystem/git servers collide exactly on
        // read_file/write_file/edit_file/git_status/git_diff/git_log) and, only
        // when a setup exceeds the external budget, keeps the ones relevant to
        // THIS task. Clients are unaffected: a withheld tool's server is still
        // connected/closed exactly as before, so nothing leaks and a later
        // segment with a different objective can surface it again.
        // v100: a delegated sub-agent is READ-ONLY by construction
        // (isDelegatedSubAgent = readonly && !planOnly). Before ToolAnnotations
        // existed, every MCP tool was hardcoded mutating, so the only safe
        // choice was to give the crew none at all. Now a server that DECLARES
        // readOnlyHint:true can be offered: those tools are exactly the ones
        // the read-only contract already permits (tools.js only adds a plugin
        // to WRITE_TOOLS when !readOnly), so this widens capability without
        // widening authority.
        mcpLoaded = isDelegatedSubAgent ? mcp.tools.filter((t) => t.readOnly === true) : mcp.tools
        mcpClients = mcp.clients
      }
      for (const e of mcp.errors) onEvent?.({ type: "info", text: `mcp server skipped: ${e}`, ...identityMeta() })
    } catch (e) { swallowed("agent", "load mcp tools", e) }
  }

  // ── THE SINGLE SELECTION ──────────────────────────────────────────────────
  // One call decides what capabilities this turn offers, across every registry.
  // Both underlying selectors are still the ones doing their own job (MCP
  // dedupe / circuit-breaker / budget; skill lifecycle / staleness) — what is
  // unified is the DECISION: one place, one combined view, one optional shared
  // ceiling. Previously these ran at two points in the loop with no shared
  // accounting, so nothing knew the combined context cost being offered.
  const turnKlass = (() => { try { return classifyTask(task || "").class } catch { return null } })()
  const turnSkillIndex = (config.skills?.enabled !== false && skillsDir)
    ? (() => { try { return mergeLearnedSkills(indexSkills(skillsDir), process.cwd()) } catch { return [] } })()
    : []
  const turnSelection = selectForTurn({
    task: String(task ?? ""),
    mcpPlugins: mcpLoaded,
    skillIndex: turnSkillIndex,
    pickSkillsFn: pickSkills,
    skillOptions: { klass: turnKlass, skillsDir, cwd: process.cwd() },
    nativeDefs: [],
    nativeNames: [...BUILTIN_TOOL_NAMES],
    createdTools: (() => { try { return listToolLife(process.cwd()) } catch { return [] } })(),
    stats: (() => { try { return loadToolStats(process.cwd())?.tools ?? null } catch (e) { swallowed("agent", "load tool stats", e); return null } })(),
    mcpOptions: {
      maxExternal: Number(config.mcp?.maxTools) > 0 ? Number(config.mcp.maxTools) : undefined,
      dedupe: config.mcp?.dedupe !== false,
      breaker: config.mcp?.breaker !== false,
    },
    contextBudget: Number(config.agent?.capabilityBudget) > 0 ? Number(config.agent.capabilityBudget) : 0,
    klass: turnKlass,
    cwd: process.cwd(),
    enforce: yolo.governorEnforce,
  })
  if (turnSelection.mcp.kept.length) {
    plugins = [...plugins, ...turnSelection.mcp.kept]
    for (const t of turnSelection.mcp.kept) onEvent?.({ type: "info", text: `mcp tool loaded: ${t.name} — ${t.source}`, ...identityMeta() })
  }
  {
    const keepCreated = new Set((turnSelection.created || []).map((t) => t.name))
    if (keepCreated.size || (turnSelection.trimmed || []).some((t) => t.kind === "created")) {
      plugins = plugins.filter((p) => !p.created || keepCreated.has(p.name) || namedIn(task, p.name))
    }
  }
  {
    const summary = formatSelection(turnSelection.mcp)
    if (summary && !isDelegatedSubAgent) onEvent?.({ type: "info", text: summary, ...identityMeta() })
    try {
      const line = formatRoute({ skills: turnSelection.skills, mcpKept: turnSelection.mcp.kept, trimmed: turnSelection.trimmed, policy: String(turnKlass || "") })
      if (line && !isDelegatedSubAgent) onEvent?.({ type: "info", text: line, ...identityMeta() })
    } catch { /* route summary is a view */ }
    for (const d of turnSelection.mcp.dropped) onEvent?.({ type: "mcp_tool_withheld", tool: d.name, reason: d.reason, ...identityMeta() })
    for (const t of turnSelection.trimmed) onEvent?.({ type: "capability_trimmed", capability: t.name, kind: t.kind, reason: t.reason, ...identityMeta() })
  }
  if (!isDelegatedSubAgent && (turnKlass === "LARGE" || turnKlass === "ARCHITECTURAL")) {
    try {
      const caps = capabilitiesImpliedByTask(task)
      if (caps.length) {
        const cov = capabilityCoverage({
          registry: defaultRegistry(),
          capabilities: caps,
          skills: turnSelection.skills,
          mcpTools: turnSelection.mcp.kept,
          createdTools: listToolLife(process.cwd()),
        })
        if (cov.gaps.length) {
          for (const g of cov.gaps) onEvent?.({ type: "CAPABILITY_GAP_DETECTED", capability: g, ...identityMeta() })
          const made = await considerCreateForGaps({ cwd: process.cwd(), gaps: cov.gaps, task, klass: turnKlass })
          for (const m of made) {
            if (m.created) {
              onEvent?.({ type: "TOOL_CREATED", tool: m.name, capability: m.capability, ...identityMeta() })
              onEvent?.({ type: "info", text: `created tool ${m.name} for gap ${m.capability} (verified + ACTIVE)`, ...identityMeta() })
            } else if (m.reused) {
              onEvent?.({ type: "info", text: `reused created tool ${m.name} for gap ${m.capability}`, ...identityMeta() })
            }
          }
          if (made.some((m) => m.created || m.reused)) {
            const fresh = await loadActiveCreatedTools(process.cwd())
            const safe = fresh.filter((t) => !BUILTIN_TOOL_NAMES.has(t.name) && !plugins.some((p) => p.name === t.name))
            plugins = [...plugins, ...safe]
          }
        }
      }
    } catch (e) { swallowed("agent", "create for gap", e) }
  }
  let lspSession = null
  // v98 shipwise: the autostart table counts too — the read-only LSP tools
  // (definition/references/hover/diagnostics) light up on any machine with a
  // first-party server binary on PATH, matching what layer 3 already reports
  // in the ladder (v96 wired autostart diagnostics; the TOOL surface was the
  // last surface still gated on user config alone).
  const lspConfigured = Object.keys(config.lsp?.servers || {}).length > 0
  const lspAutostart = (() => { try { return autostartAvailability(config).length > 0 } catch { return false } })()
  if (!isDelegatedSubAgent && !noTools && config.tools?.lsp !== false && (lspConfigured || lspAutostart)) {
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
  // v103 §2/§3: WHERE this run is allowed to be. Resolved once, here, and used
  // by both the system prompt and the completion review.
  const runWorkspace = (() => {
    try { return resolveWorkspace({ cwd: process.cwd(), task }) }
    catch (e) { swallowed("agent", "resolve workspace", e); return null }
  })()
  const pickedPlugins = selectPlugins(task || "", plugins, { klass })
  const tools = makeToolContext({
    plugins: pickedPlugins,
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
    // v122: every grant comes from the resolved YOLO state (yolo.js) — the
    // agent loop and the tool layer can no longer disagree about what the
    // owner allowed, which is exactly how `--yolo` used to leak.
    allowOutsideProject: yolo.allowOutsideProject || unrestricted,
    // v104 §5: traversal is a SCOPE grant, not a risk grant — YOLO answers it,
    // a bare `unrestricted` still may not silently scan the whole home tree.
    allowOutsideTraversal: yolo.allowOutsideTraversal,
    allowSudo: yolo.allowSudo || unrestricted,
    allowNetworkUpload: yolo.allowNetworkUpload || unrestricted,
    allowInterpreterEval: yolo.allowInterpreterEval || unrestricted || autonomous,
    assumeYes: yolo.assumeYes || unrestricted,
    autonomous,
    unrestricted,
    yolo: yolo.yolo,
    readOnlyBashByClass: yolo.readOnlyBashByClass,
    fetchPrivateUrls: yolo.fetchPrivateUrls || unrestricted,
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
      allowSudo: yolo.allowSudo || unrestricted,
      allowInterpreterEval: yolo.allowInterpreterEval || unrestricted || autonomous,
      assumeYes: yolo.assumeYes || unrestricted,
      autonomous,
      unrestricted,
      yolo: yolo.yolo,
    },
    config,
    onEvent,
    runId,
    taskId: effectiveTaskId ?? runId,
    task,
    plugins,
    legacyEvents: true,
    klass: earlyKlass,
  })
  if (!sub && config.tools?.explainRouting !== false) {
    try {
      const decision = intel.route(task, { constraints: { readOnly: readonly } })
      if (decision?.chain?.active?.length) {
        onEvent?.({ type: "info", text: `routing: ${decision.chain.reason}`, ...identityMeta() })
      }
    } catch (e) { swallowed("agent", "route model chain", e) }
  }

  // v24 semantic retrieval: when retrieval.embeddings is enabled, rerank the
  // memory/learnings/repo-map BM25 shortlists with provider embeddings BEFORE
  // the prompt is assembled. Embeddings only REORDER; they never widen.
  // Delegated read-only sub-agents stay on plain BM25. Every failure leaves
  // the *Block null → the exact v20.2 BM25 path.
  let memoryBlock = null
  let learningsBlock = null
  let repoMapBlock = null
  // v108: gathered here because it reads the task store, run journals and
  // engineering memory. A delegated sub-agent is deliberately excluded — it is
  // answering a narrow question inside a run that already has this context, and
  // paying for it again in every sub-agent is how a context budget disappears.
  let continuityBlockText = null
  if (!isDelegatedSubAgent && task && config?.agent?.continuity !== false) {
    try {
      const { continuityBlock } = await import("./continuity.js")
      continuityBlockText = (await continuityBlock({ cwd: process.cwd(), query: task, maxChars: 1600 })) || null
    } catch { /* continuity is context, never a gate — a run must not depend on it */ }
  }
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
        // v93 sensewise: the same embedder powers the semantic_search tool's
        // hybrid rerank (BM25 stays the offline default; embeddings only
        // reorder). Delegated read-only sub-agents never get it — they stay
        // on plain BM25, same as their repo-map/memory shortlists.
        tools.ctx.semanticEmbed = (texts) => embedder.embed(texts)
        embedder.close()
        onEvent?.({ type: "info", text: `semantic retrieval: memory+repomap ranked by ${embCfg.provider}/${embCfg.model} (alpha ${embCfg.alpha})`, ...identityMeta() })
      }
    } catch { /* BM25 fallback — retrieval must never break a run */ }
  }

  // v101 P2: the prompt build is where the untraced time was hiding. When
  // embeddings are not configured (the default), agentSystemPrompt computes the
  // repo map, memory and learnings SYNCHRONOUSLY inside itself — three
  // independent retrievals, one after another, on the event loop.
  const endContext = tracer.span(PHASE.CONTEXT)
  let messages = [
    { role: "system", content: agentSystemPrompt({ cwd: process.cwd(), workspace: runWorkspace, skillsDir, skillsEnabled: config.skills?.enabled !== false, readOnly: readonly, planOnly, memoryPath, deep: deepEffort, role, task, repoMap: config.context?.repoMap !== false, registry: intel.registry, memoryBlock, learningsBlock, repoMapBlock, config, plugins: pickedPlugins, skillPicks: turnSelection.skills, skillIndex: turnSelection.skillIndex, continuity: continuityBlockText, cognitionBlock: cognition && !readonly ? cognition.promptBlock() : null }) },
    { role: "user", content: planOnly ? `${task}\n\n(Produce a plan only — do not execute.)` : (extraContext ? `${task}\n\n${extraContext}` : task) },
  ]
  endContext()
  // v89 perf: FORGE_DEBUG_PROMPT=<path> dumps the exact first request payload —
  // the ground truth for prompt-economy work (sizes per block, no guessing).
  if (process.env.FORGE_DEBUG_PROMPT) {
    try {
      const fsD = await import("node:fs")
      const payload = { systemChars: messages[0].content.length, systemPrompt: messages[0].content, userChars: messages[1].content.length, toolDefsChars: JSON.stringify((pickedPlugins.length ? null : null) ?? []).length }
      fsD.writeFileSync(process.env.FORGE_DEBUG_PROMPT, JSON.stringify(payload, null, 2))
    } catch { /* debug aid — never break a run */ }
  }

  let steps = 0
  let finalText = ""
  let retryBudget = 3
  let overflowBudget = 2
  // v90 empty-response resilience: a model turn with NO text and NO tool calls
  // used to end the run as "completed" with "(empty answer)" — a single
  // provider hiccup silently killed the task. Now the model is nudged and the
  // turn retried (same step budget); a persistent streak fails the run loudly.
  const EMPTY_RESPONSE_RETRIES = 2 // + the initial attempt = 3 empty turns in a row before failing
  const EMPTY_NUDGE_PREFIX = "(system) your last response was empty"
  const BUDGET_NUDGE_PREFIX = "(system) tool-call budget exhausted"
  const VERIFY_NUDGE_PREFIX = "(system) you changed files but never ran a check"
  // v101 P4: fires AT MOST ONCE per run, and only on a run that actually
  // changed something without ever checking it. See the gate below.
  let verifyNudgeFired = false
  // the answer the nudge withdrew, kept ONLY as a fallback (see below)
  let withdrawnText = ""
  let emptyStreak = 0
  // v94 masterwise (§6/§7): budget-nudge coercion tracking — see below
  let budgetNudgeFired = false
  let coercedByNudge = false
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
  const readsSoFar = []
  const createdFiles = []   // v103 §2 — a subset of writesSoFar: brand-new files
  const outsideWrites = [] // v104 §4 — writes that landed outside the workspace
  // v99 loopwise extension evidence: step-numbered writes, bounded tool
  // signature counts (loop detection, execcontroller §10 rule), and the
  // extension bookkeeping itself.
  const writeSteps = []
  const toolSigCounts = new Map()
  // v115: the SAME call producing the SAME result, back to back. toolSigCounts
  // already existed and already encoded the judgement that a repeated
  // signature is a spin — but it was only ever consulted to withhold extra
  // budget, never to stop. Reproduced: a model that re-issued one bash call
  // ran it 40/40 steps, 1 distinct signature, and forge paid for every round
  // trip. Consecutive identical call AND identical result is not a heuristic:
  // no new information is arriving, so another turn cannot help.
  // v118: a governor STOP is a CANDIDATE. These track how often the candidate
  // was refused and why, so a blocker that never clears cannot spin forever.
  let completionCandidates = 0
  let completionAbandoned = false
  let completionBlockedThisTurn = false
  const completionBudget = new Map()
  let lastCompletionBlocker = null
  let sameBlockerRun = 0
  let completionVerdict = null
  let governorNote = null
  let lastSigResult = null
  let sameSigResultRun = 0
  let loopHalt = null
  let stepExtensions = 0
  let lastExtensionEvidence = null
  const repoState = (() => {
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim()
      const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim().split("\n").filter(Boolean).length
      return { head, dirty }
    } catch { return null }
  })()
  const tokenUsage = { prompt: 0, completion: 0, total: 0, estimated: false }
  let waitingForUser = false
  let runOk = false
  let waitWhy = ""
  let waitDecision = null
  let governorHalt = false
  let lastGov = null
  let lastAuth = null
  let ended = false
  const endRun = (status, extra = {}) => {
    if (ended) return
    ended = true
    if (log && !extra.keepRunning) log.end(status, extra)
    else if (log) log.flush()
    if (!suppressRunEvents) onEvent?.({ type: "run_end", runId, status, steps, toolCalls: toolLog.length, text: extra.text ?? "", error: extra.error ?? null, wrote: extra.wrote ?? false, tools: intel.stats(), taskId: effectiveTaskId, segmentId: effectiveSegmentId, nodeId: effectiveNodeId })
  }
  try {
    // v99 loopwise: the loop gate. `steps >= maxSteps` no longer ends the run
    // unconditionally on the DIRECT path — first ask whether the run is still
    // PRODUCTIVE (see productiveExtension). Productive runs get more budget
    // (bounded by the same hard caps); unproductive or ineligible runs break
    // to the honest budget-hit handling below, exactly as v98 did.
    const EXT_WINDOW = 10 // steps of recent behavior the judgment reads
    const productiveExtension = () => {
      if (!autoExtendEligible) return null
      if (signal?.aborted) return null
      if (maxSteps >= AGENT_BUDGETS.maxStepsHardCap) return null
      // (a) signature loop — execcontroller §10 rule: the same tool+args
      // signature 4+ times total is a spin; more budget cannot help it
      for (const [, n] of toolSigCounts) if (n >= 4) return null
      // (b) recent error streak — the last 6 tool results all failed
      const recent = toolLog.slice(-6)
      if (recent.length === 6 && recent.every((t) => String(t.result).startsWith("ERROR") || String(t.result).startsWith("BLOCKED"))) return null
      // (c) productivity: a successful write or a passing verification
      // command in the window, OR diverse tool use (>= 4 distinct
      // signatures) — read-heavy exploration counts as progress too
      const sinceStep = steps - EXT_WINDOW
      const wroteRecently = writeSteps.some((s) => s > sinceStep)
      const verifiedRecently = commandChecks.some((c) => c.passed && (c.step ?? 0) > sinceStep)
      const recentSigs = new Set()
      for (const t of toolLog) if ((t.step ?? 0) > sinceStep) recentSigs.add(`${t.name}:${String(t.result).slice(0, 40)}`)
      const diverse = recentSigs.size >= 4
      if (!(wroteRecently || verifiedRecently || diverse)) return null
      return { wroteRecently, verifiedRecently, diverse, distinctRecent: recentSigs.size }
    }
    while (true) {
      // v115: a run that is provably repeating itself stops here. Detected at
      // the tool-result site below (same call, same result, LOOP_HALT_REPEATS
      // times in a row) and acted on at the top of the next turn, so the loop
      // never pays for another model round trip to learn nothing.
      if (loopHalt) break
      if (steps >= maxSteps) {
        const evidence = productiveExtension()
        if (!evidence) break
        const prevSteps = maxSteps
        maxSteps = Math.min(maxSteps + Math.max(maxStepsInitial, 32), AGENT_BUDGETS.maxStepsHardCap)
        // tool-call budget grows with it (same increment, same hard cap) so a
        // healthy long run is not nudge-choked one extension in
        maxToolCalls = Math.min(maxToolCalls + Math.max(maxStepsInitial, 32), AGENT_BUDGETS.maxToolCallsHardCap)
        stepExtensions++
        lastExtensionEvidence = evidence
        onEvent?.({ type: "step_budget_extended", from: prevSteps, to: maxSteps, extension: stepExtensions, evidence, ...identityMeta() })
      }
      steps++
      log?.step(steps)
      onEvent?.({ type: "step", step: steps, ...identityMeta() })
      if (cognition && !readonly) {
        try {
          completionBlockedThisTurn = false
          let gov = cognition.next({
            steps,
            writes: writesSoFar.length,
            unverified: unverifiedWrites({ writesSoFar, commandChecks }).unverified,
            inspected: toolLog.some((t) => t.name === "read_file" || t.name === "glob_files" || t.name === "grep" || t.name === "grep_files" || t.name === "git_status"),
            hasPlan: planOnly || toolLog.some((t) => t.name === "todo" || t.name === "think"),
            failed: toolLog.slice(-3).every((t) => String(t.result).startsWith("ERROR")) && toolLog.length >= 3,
            looping: [...toolSigCounts.values()].some((n) => n >= 4),
            pendingDecision: waitingForUser,
          })
          lastGov = gov
          lastAuth = cognition.enforce(gov)
          onEvent?.({ type: "GOVERNOR_ACTION", action: gov.action, why: gov.why, depth: gov.depth, voi: gov.voi, enforce: lastAuth.enforce, halt: lastAuth.halt, ...identityMeta() })
          if (lastAuth.waitForUser) {
            onEvent?.({ type: "USER_INTENT_CONFLICT", why: gov.why, ...identityMeta() })
            let proceed = false
            try {
              const { createDecisionEngine, DECISION_TYPE } = await import("./decisionengine.js")
              const eng = createDecisionEngine({ cwd: process.cwd(), taskId: effectiveTaskId })
              const hypos = cognition.user?.understanding?.intentHypotheses || []
              const asked = eng.ask({
                type: DECISION_TYPE.CLARIFICATION,
                key: `governor-intent-${String(task).slice(0, 40)}`,
                title: "Ambiguous or irreversible intent — decision required",
                question: gov.why || "which interpretation should I execute?",
                options: hypos.length
                  ? hypos.slice(0, 6).map((h) => ({ id: h.id, label: String(h.meaning || h.goal || h.id).slice(0, 200) }))
                  : [{ id: "clarify", label: "clarify the intended outcome" }, { id: "smallest", label: "proceed with the smallest reversible interpretation" }],
                reason: "governor ASK — inspect cannot collapse competing intent hypotheses",
                taskId: effectiveTaskId,
              })
              if (asked?.skipped && eng.pendingList().length === 0) {
                proceed = true
                onEvent?.({ type: "DECISION_NEEDED", skipped: true, why: asked.why, ...identityMeta() })
              } else {
                waitDecision = asked
                onEvent?.({ type: "DECISION_NEEDED", id: asked?.decision_id, skipped: !!asked?.skipped, ...identityMeta() })
                try {
                  const { openTask, TASK_STATUS } = await import("./taskstate.js")
                  if (effectiveTaskId) {
                    const ts = openTask(effectiveTaskId, { create: false, cwd: process.cwd() })
                    ts?.transition?.(TASK_STATUS.WAITING_FOR_USER, { reason: gov.why })
                  }
                } catch { /* task record is optional on one-shot agent */ }
              }
            } catch (e) { swallowed("agent", "governor ask", e) }
            if (!proceed) {
              waitingForUser = true
              waitWhy = gov.why || "governor ASK"
              try { cognition.persist() } catch { }
              break
            }
          }
          if (lastAuth.halt && gov.action === "STOP") {
            // v118 — STOP IS A CANDIDATE, NOT A VERDICT.
            //
            // It used to halt here and, because the halt wrote its own reason
            // into finalText, the completion gate downstream then read that
            // sentence as the model's answer and returned COMPLETED.
            // Reproduced: "create one.js and two.js" wrote one.js, never wrote
            // two.js, never answered — and reported COMPLETED, reason
            // GOVERNOR_STOP, with the governor quoting itself as the answer.
            //
            // The contract cannot catch this: its own verdict is "goal
            // satisfied OR no open requirements", so an EMPTY contract is a
            // closed one. So the candidate is now asked the question the
            // contract cannot ask — is the outcome true on disk?
            completionCandidates++
            const cov = unverifiedWrites({ writesSoFar, commandChecks })
            const named = (() => { try { return analyzeTask(task || "").files ?? [] } catch { return [] } })()
            const mutating = (() => { try { return Boolean(analyzeTask(task || "").mutating) } catch { return false } })()
            completionVerdict = evaluateCompletion({
              task, namedFiles: named, cwd: process.cwd(),
              wrote: writesSoFar.length > 0, mutating,
              // the governor's note is explicitly NOT an answer
              modelAnswered: String(finalText ?? "").trim().length > 0,
              unverified: cov.unverified, commandChecks,
              requireVerification: config.agent?.requireVerification === true,
              klass: turnKlass ?? klass ?? "SMALL",
            })
            onEvent?.({
              type: "COMPLETION_CANDIDATE", why: gov.why, attempt: completionCandidates,
              ok: completionVerdict.ok, evidence: completionVerdict.evidence.positive.slice(0, 4),
              ...identityMeta(),
            })
            if (completionVerdict.ok) {
              // v119: this candidate passed. If an earlier one was refused,
              // that refusal just proved it was catching a real premature stop
              // — record WHICH attempt cleared it, because that becomes the
              // floor the budget can never be squeezed below.
              if (lastCompletionBlocker) {
                try {
                  const { recordCompletionOutcome, COMPLETION_OUTCOME } = await import("./metalearn.js")
                  recordCompletionOutcome({
                    cwd: process.cwd(), klass: turnKlass ?? klass ?? "SMALL",
                    blocker: lastCompletionBlocker, outcome: COMPLETION_OUTCOME.CLEARED, attempt: sameBlockerRun,
                  })
                } catch { /* calibration is a view, never a gate */ }
              }
              governorHalt = true
              onEvent?.({ type: "GOVERNOR_STOP", why: gov.why, ...identityMeta() })
              // Kept OUT of finalText: a note about stopping is not an answer,
              // and the gate must not be able to mistake one for the other.
              governorNote = `Governor stopped: ${gov.why}`
              try { cognition.persist() } catch { }
              break
            }
            const code = completionVerdict.blockers[0].code
            if (code === lastCompletionBlocker) sameBlockerRun++
            else { lastCompletionBlocker = code; sameBlockerRun = 1 }
            onEvent?.({
              type: "COMPLETION_BLOCKED", attempt: completionCandidates, blocker: code,
              why: completionVerdict.blockers[0].why, next: completionVerdict.next,
              repeats: sameBlockerRun, ...identityMeta(),
            })
            // §18: continuing forever on a blocker that never clears is the
            // other way to be wrong. Three refusals of the SAME blocker means
            // the run cannot clear it by itself — end INCOMPLETE and say which
            // blocker won, never COMPLETED.
            // v119: how many attempts this blocker gets is what THIS project
            // measured, not a constant. Read once per run per blocker.
            if (!completionBudget.has(code)) {
              let budget = COMPLETION_BLOCKER_REPEATS
              try {
                const { completionAttemptsFor } = await import("./metalearn.js")
                budget = completionAttemptsFor({
                  cwd: process.cwd(), klass: turnKlass ?? klass ?? "SMALL",
                  blocker: code, fallback: COMPLETION_BLOCKER_REPEATS,
                }).attempts
              } catch { /* an unreadable store means the default, never zero */ }
              completionBudget.set(code, Math.max(1, Number(budget) || COMPLETION_BLOCKER_REPEATS))
            }
            if (sameBlockerRun >= completionBudget.get(code)) {
              governorHalt = true
              onEvent?.({ type: "COMPLETION_ABANDONED", blocker: code, repeats: sameBlockerRun, ...identityMeta() })
              completionAbandoned = true
              try {
                const { recordCompletionOutcome, COMPLETION_OUTCOME } = await import("./metalearn.js")
                recordCompletionOutcome({
                  cwd: process.cwd(), klass: turnKlass ?? klass ?? "SMALL",
                  blocker: code, outcome: COMPLETION_OUTCOME.ABANDONED, attempt: sameBlockerRun,
                })
              } catch { /* calibration is a view, never a gate */ }
              governorNote = `stopped BLOCKED: ${completionVerdict.blockers[0].why} — ${sameBlockerRun} completion attempts did not clear it`
              try { cognition.persist() } catch { }
              break
            }
            // §48/§49: the model is told the real reason, not "continue" — and
            // then execution falls THROUGH to the model call below. Restarting
            // the loop here would re-ask the governor before the model ever got
            // the chance to clear the blocker, which is its own kind of spin.
            //
            // And the authority has to move with the decision. authorityFor(STOP)
            // forbids every write tool, which is correct for a STOP and absurd
            // for a REFUSED one: the model would be told "next required action:
            // EXECUTE — create two.js" on a turn where write_file is masked out
            // of its tool list. The governing action is now the blocker's, so
            // the authority is re-derived from it.
            completionBlockedThisTurn = true
            lastGov = { ...gov, action: completionVerdict.next, why: completionVerdict.blockers[0].why, stop: false }
            lastAuth = cognition.enforce(lastGov)
            gov = lastGov
          }
          if (!noTools) {
            // v118: a refused completion candidate replaces the generic step
            // directive with the actual blocker — the model is told what is
            // missing, not merely told to keep going.
            const blocked = completionBlockedThisTurn && completionVerdict && !completionVerdict.ok
            upsertGovernorMessage(messages, blocked
              ? `${GOV_PREFIX} ${formatCompletionBlock(completionVerdict)}`
              : cognition.stepDirective(gov, lastAuth))
          }
          if (gov.action === "SEARCH" && !cognition.lastAcquire) {
            try {
              const plan = cognition.acquirePlan?.() || { tool: "grep_files", query: String(task).slice(0, 80), method: "REPO", why: "governor SEARCH" }
              const acq = runAcquire(plan, { cwd: process.cwd() })
              cognition.observeAcquire(acq)
              ingestAcquire({
                cwd: process.cwd(),
                task,
                klass: turnKlass,
                records: [{ name: acq.tool, tool: acq.tool, result: acq.preview || acq.skipped || "", status: acq.ok ? "ok" : "error" }],
              })
              const body = acq.skipped
                ? `(acquire skipped) ${acq.tool} — ${acq.skipped}`
                : `(acquire ${acq.ok ? "ok" : "empty"}) ${acq.tool} ${acq.query || ""}\n${String(acq.preview || "").slice(0, 1800)}`
              messages.push({ role: "user", content: body })
              onEvent?.({ type: "ACQUIRE_RAN", tool: acq.tool, ok: acq.ok === true, skipped: acq.skipped || null, hits: acq.hits ?? 0, ...identityMeta() })
            } catch (e) { swallowed("agent", "governor SEARCH acquire", e) }
          }
          if ((gov.action === "EXECUTE" || gov.action === "REPAIR") && !cognition.openPrediction) {
            const pred = cognition.predict({
              action: gov.action,
              objective: task,
              reads: readsSoFar,
              writes: writesSoFar,
              taskId: effectiveTaskId,
            })
            onEvent?.({ type: "PREDICTION_MADE", id: pred.id, files: pred.expectedFiles, derived: pred.derived, action: pred.action, ...identityMeta() })
          }
        } catch (e) { swallowed("agent", "governor next", e) }
      }
      let msg
      // declared OUTSIDE the try so every exit path — success, provider error,
      // failover, retry — closes the span exactly once (end() is idempotent).
      const endModel = tracer.span(PHASE.MODEL)
      try {
        const offered = noTools ? undefined : intel.toolDefs(lastAuth ? maskToolDefs(tools.defs, {
          ...lastAuth,
          allow: (plugins || []).filter((p) => p && p.readOnly).map((p) => p.name),
        }) : tools.defs)
        msg = await chatOnce({
          protocol: p.protocol,
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          model: p.model,
          providerName: p.name,
          messages,
          tools: offered,
          signal,
          deep: deepEffort,
          maxTokens: deepEffort ? 16384 : undefined,
          connectMs: config.retry?.connectMs,
          requestTimeoutMs: config.retry?.requestTimeoutMs,
        })
        endModel()
      } catch (e) {
        endModel({ error: true })
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
        emptyStreak = 0
        toolCallCount += msg.toolCalls.length
        if (toolCallCount > maxToolCalls) {
          budgetNudgeFired = true
          messages.push({ role: "user", content: `(system) tool-call budget exhausted (${maxToolCalls} calls) — stop calling tools and produce your final answer now with what you have.` })
          continue
        }
        messages.push({
          role: "assistant",
          content: msg.content || "",
          tool_calls: msg.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.args } })),
        })
        const endTools = tracer.span(PHASE.TOOL)
        const mapped = msg.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: safeJson(tc.args) }))
        const results = new Array(mapped.length)
        const runnable = []
        for (let i = 0; i < mapped.length; i++) {
          const verdict = lastAuth ? enforceToolCall(mapped[i].name, lastAuth) : { ok: true }
          if (!verdict.ok) {
            results[i] = { result: verdict.reason, ms: 0, blocked: true }
            onEvent?.({ type: "TOOL_BLOCKED", tool: mapped[i].name, reason: verdict.reason, governor: lastAuth?.action, ...identityMeta(), toolCallId: mapped[i].id })
          } else {
            runnable.push(i)
          }
        }
        if (runnable.length) {
          const batch = await intel.runBatch(runnable.map((i) => mapped[i]), { step: steps })
          for (let j = 0; j < runnable.length; j++) results[runnable[j]] = batch[j]
        }
        endTools()
        if (cognition) {
          try {
            cognition.observeTools(msg.toolCalls.map((tc, i) => ({
              name: tc.name,
              args: safeJson(tc.args),
              result: results?.[i]?.result,
            })))
          } catch (e) { swallowed("agent", "cognition observe", e) }
        }
        // per-tool attribution: "tools took 40s" is far less useful than
        // knowing WHICH tool did. runBatch already timed each call.
        for (let i = 0; i < msg.toolCalls.length; i++) {
          const ms = Number(results?.[i]?.ms)
          if (Number.isFinite(ms)) tracer.mark(`tool:${msg.toolCalls[i]?.name ?? "unknown"}`, ms,
            { error: String(results?.[i]?.result ?? "").startsWith("ERROR") })
        }
        for (let i = 0; i < msg.toolCalls.length; i++) {
          const tc = msg.toolCalls[i]
          if (!results[i]) results[i] = { result: "ERROR: tool did not run", ms: 0 }
          const { result, ms } = results[i]
          toolLog.push({ step: steps, name: tc.name, result: String(result).slice(0, 200) })
          // v99 loopwise: bounded signature count for the extension's loop
          // guard (same shape as execcontroller §10: tool + primary arg)
          {
            let argsKey = ""
            try { const a = safeJson(tc.args); argsKey = a ? JSON.stringify(a).slice(0, 120) : "" } catch { argsKey = "" }
            const sig = `${tc.name}:${argsKey}`
            toolSigCounts.set(sig, (toolSigCounts.get(sig) ?? 0) + 1)
            if (toolSigCounts.size > 256) toolSigCounts.delete(toolSigCounts.keys().next().value)
            // v115 loop halt: same signature AND same result, consecutively.
            const sigResult = `${sig}\u0000${String(result).slice(0, 200)}`
            if (sigResult === lastSigResult) sameSigResultRun++
            else { lastSigResult = sigResult; sameSigResultRun = 1 }
            if (sameSigResultRun >= LOOP_HALT_REPEATS && !loopHalt) {
              loopHalt = { tool: tc.name, repeats: sameSigResultRun, step: steps }
              onEvent?.({ type: "LOOP_HALT", tool: tc.name, repeats: sameSigResultRun, step: steps, sig: sig.slice(0, 120), ...identityMeta() })
            }
          }
          if (tc.name === "bash" && !sub) {
            try {
              const rawArgs = safeJson(tc.args)
              const command = typeof rawArgs === "object" && rawArgs ? String(rawArgs.command ?? "") : ""
              if (looksLikeCheck(command)) {
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
              for (const [fp, action] of journalFiles(tc.name, tc.args, r)) {
                writesSoFar.push(fp); writeSteps.push(steps)
                // v103 §2: files CREATED are the signature of "a new project is
                // being built here" — editing an existing file in forge's tree
                // while developing forge is ordinary and must not be flagged.
                if (action === "created") createdFiles.push(fp)
                // v104 §4: a write that lands OUTSIDE the resolved workspace.
                // v88 removed the write boundary on purpose, so this does not
                // block the write — but a task that edits a tree it was never
                // pointed at is exactly what the completion report exists for.
                if (outsideWorkspace(runWorkspace, fp)) outsideWrites.push(fp)
                if (log) log.touched(fp, action)
              }
            } else if (okRes && tc.name === "bash" && hasWriteRedirection(String(safeJson(tc.args)?.command ?? ""))) {
              writesSoFar.push("(shell write)") // unknown target: conservatively counts as a write after any earlier check
              writeSteps.push(steps)
            } else if (okRes && (tc.name === "read_file" || tc.name === "read_image")) {
              const rp = safeJson(tc.args)?.path
              if (rp) readsSoFar.push(path.resolve(process.cwd(), String(rp)))
            }
            if (log) log.tool(tc.name, journalTarget(tc.name, tc.args), okRes)
          }
          // v98 shipwise: the ONE fence choke point for agent tool results —
          // after cap/shrink/redaction (budget math unchanged), before the
          // provider sees it. Advisory marker scan rides the header.
          messages.push({ role: "tool", tool_call_id: tc.id, content: fenceToolResult(tc.name, String(result), { enabled: fenceEnabled(config) }) })
          const rblock = String(result)
          // v122: under YOLO the critique keeps its NOTE and loses its veto —
          // toolintel already refuses to emit a BLOCK line, so this is the
          // second door shut (a pinned FORGE_CRITIQUE path cannot pause a run
          // the owner told never to pause).
          if (!yolo.critiqueEnforce) { /* advisory only */ }
          else if (/^BLOCKED: \(critique\) ASK/.test(rblock) && earlyKlass !== "MICRO") {
            waitingForUser = true
            waitWhy = rblock.replace(/^BLOCKED: \(critique\) ASK\s*—\s*/, "").slice(0, 240) || "secret-bearing path"
            onEvent?.({ type: "DECISION_NEEDED", reason: "CRITIQUE_ASK", why: waitWhy, ...identityMeta(), toolCallId: tc.id })
          } else if (/^BLOCKED: \(critique\) REPLAN/.test(rblock)) {
            messages.push({ role: "user", content: `(critique) REPLAN — stop editing the same file. ${rblock.slice(0, 280)}` })
          }
        }
        if (waitingForUser) {
          try { cognition?.persist?.() } catch { }
          break
        }
        if (cognition?.openPrediction && writesSoFar.length) {
          try {
            const anyFail = results.some((r) => /^ERROR|^BLOCKED/.test(String(r?.result ?? "")))
            const settled = cognition.settle({
              actualFiles: writesSoFar.filter((f) => f !== "(shell write)"),
              status: anyFail ? "error" : "ok",
              actualSteps: 1,
            })
            if (settled?.drift) {
              onEvent?.({ type: "PREDICTION_SETTLED", id: settled.settled?.id, drift: settled.drift.level, driftScore: settled.drift.driftScore, extra: settled.settled?.filesExtra, missed: settled.settled?.filesMissed, ...identityMeta() })
            }
          } catch (e) { swallowed("agent", "cognition settle", e) }
        }
        injectPendingVision(messages, tools.ctx)
        messages = await compactAgentHistory(messages, p, { onEvent })
        continue
      }

      // v90: an empty model response (no tool calls, no text) is a provider
      // hiccup, not a final answer. Nudge and retry on the same step budget;
      // only a persistent streak (3 in a row) ends the run — as a real error,
      // never as a silent "completed".
      if (!String(msg.content ?? "").trim()) {
        if (emptyStreak < EMPTY_RESPONSE_RETRIES) {
          emptyStreak++
          onEvent?.({ type: "retry", error: `empty model response (attempt ${emptyStreak} of ${EMPTY_RESPONSE_RETRIES + 1}) — nudging the model to answer`, step: steps, left: EMPTY_RESPONSE_RETRIES + 1 - emptyStreak, ...identityMeta() })
          // replace the previous nudge instead of stacking duplicates
          const lastMsg = messages[messages.length - 1]
          if (lastMsg?.role === "user" && String(lastMsg.content).startsWith(EMPTY_NUDGE_PREFIX)) messages.pop()
          messages.push({ role: "user", content: `${EMPTY_NUDGE_PREFIX} — no text and no tool calls. Continue the task: call a tool or write your final answer now.` })
          steps--
          continue
        }
        // v101 P4: if the verification nudge withdrew a real answer and the
        // provider then died, the run must not FAIL where it would have
        // COMPLETED before the nudge existed. Restore the withdrawn answer and
        // end honestly — the result still reports the changes as unverified,
        // which is the whole point, and that is strictly better than losing
        // the work to a provider hiccup the nudge caused.
        if (withdrawnText) {
          finalText = withdrawnText
          onEvent?.({ type: "info", text: "the provider stopped responding after the verification nudge — restoring the answer it gave before, still reported as unverified", ...identityMeta() })
          break
        }
        throw new ProviderError(`model returned an empty response ${EMPTY_RESPONSE_RETRIES + 1} times in a row — provider or model issue (or the response was filtered); no final answer was produced`, { retryable: false })
      }
      emptyStreak = 0
      finalText = msg.content || "(empty answer)"
      // v94 masterwise (§6/§7): an answer produced IMMEDIATELY after the
      // tool-call-budget nudge is coerced, not chosen — the model was told to
      // "stop calling tools and produce your final answer NOW". If the STEP
      // budget also ended, this run must not report COMPLETED: the honest
      // status is INCOMPLETE + checkpoint + resume (same as no answer).
      // Walk backwards over the empty assistant turn(s); the first substantive
      // message before the answer decides whether the answer was forced.
      if (budgetNudgeFired) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i]
          if (m.role === "assistant") continue
          // v113 audit: THE GOVERNOR'S OWN TURN IS NOT THE USER'S.
          //
          // This walks back for the last real user turn to decide whether the
          // final answer was FORCED by the budget nudge — the guard behind
          // "budget exhaustion is never completion". The v101 governor appends
          // its own `user` directive after every step, so the last user
          // message became "(governor) GOVERNOR: EXECUTE ..." and never the
          // nudge. coercedByNudge stayed false, `exhausted` stayed false, and
          // a run that burned its whole budget and answered only because it
          // was told to reported COMPLETED. Reproduced: budgetHit=true,
          // status=COMPLETED, reason=null, no checkpoint.
          if (m.role === "user" && String(m.content ?? "").startsWith(GOV_PREFIX)) continue
          if (m.role === "user") { coercedByNudge = String(m.content ?? "").startsWith(BUDGET_NUDGE_PREFIX); break }
          if (m.role === "tool") continue
          break
        }
      }

      // v101 P4 — the false-completion gate. The eval (evalbench.js) puts ONE
      // number above solve rate: an agent that reports COMPLETED on work that
      // does not pass. The cheapest honest defence is to not let the run end
      // on an UNCHECKED change: every write this run made, with no passing
      // check covering it, gets one chance to be checked before the answer
      // stands.
      //
      // Deliberately narrow, because a nudge costs a model call:
      //   - at most ONCE per run, never a loop
      //   - only when files were actually written and NONE is covered
      //   - never on read-only / plan / verifier runs (they write nothing)
      //   - never once the step or tool-call budget is gone — there is no room
      //     to act on it, and a coerced answer is already handled above
      //   - off with config.agent.verifyNudge === false
      // It never runs a command itself: the agent chooses, exactly as
      // verify.js's "executor: agent" contract has always required.
      if (!verifyNudgeFired && config.agent?.verifyNudge !== false && !readonly && !planOnly && !verifier
          && !budgetNudgeFired && steps < maxSteps && !signal?.aborted) {
        const gap = unverifiedWrites({ writesSoFar, commandChecks })
        if (gap.unverified.length) {
          verifyNudgeFired = true
          // The answer is WITHDRAWN, not kept: the model must restate it after
          // checking. Otherwise a run that spent its remaining budget verifying
          // would report the pre-check answer as if it had survived the check.
          withdrawnText = finalText
          finalText = ""
          let hint = ""
          try {
            const { focusedVerify } = await import("./verify.js")
            const fv = focusedVerify(process.cwd(), gap.unverified.filter((f) => f !== "(shell write)"))
            // recommendedVerify NEVER invents a command; an empty one stays empty
            if (fv?.command) hint = ` The project's own check is: ${fv.command}${fv.tests?.length ? ` (tests connected to your changes: ${fv.tests.slice(0, 4).join(", ")})` : ""}.`
          } catch { /* a missing hint must never cost the nudge itself */ }
          // v102: the review's evidence steers the nudge instead of being
          // reported after the fact. The blast radius is already on the tool
          // records, so "run a check" becomes "a focused test is not enough
          // here, and here is why" — at no extra cost and no extra model call.
          let reach = ""
          try {
            const { impact } = changeSetOf(intel.records())
            if (impact.unknown) reach = ` The impact walk came back UNKNOWN for these files — "no importers found" is not proof that nothing depends on them, so check the callers you can find by hand.`
            else if (impact.radius >= ESCALATE_RADIUS) reach = ` ${impact.radius} module(s) import what you changed${impact.importers.length ? ` (${impact.importers.slice(0, 4).join(", ")})` : ""} — a focused test on one file is not enough evidence here; run the regression suite if this project has one.`
          } catch (e) { swallowed("agent", "nudge blast reach", e) }
          const names = gap.unverified.slice(0, 6).map((f) => path.relative(process.cwd(), f) || f).join(", ")
          onEvent?.({ type: "verify_nudge", files: gap.unverified.length, names, step: steps, ...identityMeta() })
          messages.push({ role: "user", content: `${VERIFY_NUDGE_PREFIX}: ${names}${gap.unverified.length > 6 ? ` (+${gap.unverified.length - 6} more)` : ""}.${hint}${reach} Run a real check that covers those changes now and report what it printed. If this repository genuinely has no way to check them, say so explicitly in your final answer instead — do not claim the work is verified.` })
          continue
        }
      }
      break
    }

    for (const chk of commandChecks) chk.filesWrittenAfter = writesSoFar.slice(chk.writeIndex)
    const budgetHit = steps >= maxSteps
    const wrote = toolLog.some((t) => WRITE_TOOLS.has(t.name) && !String(t.result).startsWith("ERROR") && !String(t.result).startsWith("BLOCKED"))
    if (log) { try { for (const c of listCheckpoints(process.cwd(), 50)) if (c.runId === runId) log.checkpoint(c.id) } catch {} }
    // v93 gap fix (§4/§5): budget exhaustion is NEVER completion. The direct
    // fast path no longer invents its own definition of done — the SAME
    // completion module that owns the whole-task gate owns this contract
    // (canCompleteFastPath). A run that spent its budget WITHOUT a final
    // answer returns INCOMPLETE (RESOURCE_LIMIT), checkpoints what exists,
    // and is resumable; only the Core's gate may ever decide COMPLETED.
    // ("only because" is the §5 wording: a REAL final answer produced on the
    // last allowed step completes the run — the budgetHit flag is still
    // reported so meta may continue the segment if it wants more work.)
    const answerPresent = String(finalText ?? "").trim().length > 0
    // v94 masterwise (§6/§7): a step-budget end may only complete on a REAL,
    // uncoerced final answer. A coerced answer (produced because the tool-call
    // budget nudge ordered it) on the budget step is a resource limit, exactly
    // like no answer at all: INCOMPLETE + checkpoint + resume. meta continues
    // on budgetHit either way; direct callers get the honest status.
    const exhausted = budgetHit && (!answerPresent || coercedByNudge)

    // v115 — A RUN WHOSE ONLY MUTATING ATTEMPTS WERE REFUSED IS NOT COMPLETE.
    //
    // Reproduced: the governor refused the single write_file ("BLOCKED:
    // governor SEARCH forbids write_file"), the model then said "Added the
    // key. The task is complete." — and the run reported COMPLETED with
    // wrote=false. Nothing happened and forge agreed it was done.
    //
    // The signal has to be narrow, because a read-only task legitimately
    // writes nothing and must still be able to complete. What is NOT
    // legitimate is claiming completion when every mutating call you made was
    // refused: the agent tried to change something, was told no, and said it
    // was finished anyway.
    // WRITE_TOOLS includes `bash`, which is mostly used read-only (git status,
    // ls, a test run), so a refused `bash ls` would be miscounted as a refused
    // mutation. Only the tools that exist to change files count here.
    const FILE_WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"])
    const mutatingAttempts = toolLog.filter((t) => FILE_WRITE_TOOLS.has(t.name))
    const mutationsRefused = mutatingAttempts.length > 0 &&
      mutatingAttempts.every((t) => String(t.result).startsWith("BLOCKED") || String(t.result).startsWith("ERROR"))
    // ...and nothing else landed either. A run whose apply_patch was refused
    // but which then wrote through `bash` DID change the workspace, so it is
    // not a refused-only run and must not be judged as one.
    const refusedOnly = mutationsRefused && !wrote
    if (refusedOnly) {
      onEvent?.({ type: "MUTATIONS_ALL_REFUSED", attempts: mutatingAttempts.length,
        reasons: [...new Set(mutatingAttempts.map((t) => String(t.result).slice(0, 80)))].slice(0, 3), ...identityMeta() })
    }

    const verificationGap = unverifiedWrites({ writesSoFar, commandChecks })
    // v102 — the adversarial review finally runs on the path everything uses.
    // It has always existed (review.js) and has always been reachable ONLY
    // through the Ω kernel, which only meta.js builds; `forge agent`,
    // interactive Agent Mode, every sub-agent and every DAG node come through
    // here and were never reviewed. No model call, no new computation: the
    // change set and its blast radius are already on the tool records.
    // ROLLBACK_POSSIBLE asks whether this run can be undone — the write tools
    // already checkpointed, so the answer is on disk rather than invented.
    const rollbackPoint = (() => {
      try { return listCheckpoints(process.cwd(), 50).find((c) => c.runId === runId)?.id ?? null }
      catch (e) { swallowed("agent", "find rollback point", e); return null }
    })()
    const reviewMode = String(config.agent?.review ?? "report").toLowerCase()
    const runReview = reviewMode === "off" ? null : (() => {
      try {
        return reviewRun({
          klass, objective: task, records: intel.records(),
          workspace: runWorkspace, created: createdFiles, outside: outsideWrites,
          // P4's gap is the review's verification evidence: files changed with
          // no passing check covering them is exactly "verification not satisfied"
          verificationOk: writesSoFar.length === 0 ? true : verificationGap.unverified.length === 0,
          checkpoint: rollbackPoint,
        })
      } catch (e) { swallowed("agent", "adversarial review", e); return null }
    })()
    if (runReview?.required) {
      onEvent?.({ type: "review", ok: runReview.ok, klass: runReview.klass, escalated: runReview.escalated,
        findings: runReview.findings.map((f) => f.id), blockers: runReview.blockers.map((b) => b.id),
        text: formatReview(runReview), ...identityMeta() })
    }
    const fastGate = canCompleteFastPath({
      // v115: a refused-only run and a provably looping run are both reported
      // to the ONE completion module the same way budget exhaustion is — as a
      // reason this run did not finish, not as a separate private verdict.
      finalText: answerPresent ? finalText : "", error: null,
      budgetHit: exhausted || refusedOnly || Boolean(loopHalt),
      toolLog, commandChecks,
      unverified: verificationGap.unverified,
      requireVerification: config.agent?.requireVerification === true,
      // "report" (the default) surfaces blockers without changing the verdict —
      // v88 deliberately removed the write guards these checks shadow, and
      // silently reversing that decision is not this change's call to make.
      reviewBlockers: reviewMode === "enforce" ? (runReview?.blockers ?? []).map((b) => b.id) : [],
    })
    // v118: the governor's note is reportable but is NOT an answer — it is
    // attached only AFTER the gate has judged the run, so it can never be
    // mistaken for the model having said something (which is how a governor
    // STOP used to launder itself into COMPLETED).
    if (governorHalt && !answerPresent && governorNote) finalText = governorNote
    let resStatus = fastGate.ok ? "COMPLETED" : fastGate.status
    runOk = resStatus === "COMPLETED" && !waitingForUser && !governorHalt
    if (waitingForUser) {
      resStatus = "WAITING_FOR_USER"
      if (!finalText) finalText = `Waiting for user decision: ${waitWhy}`
    }
    if (cognition && !readonly && !planOnly && !verifier) {
      try {
        if (!waitingForUser) {
          const cg = cognition.close({ wrote, unverified: verificationGap.unverified })
          onEvent?.({ type: cg.ok ? "TASK_COMPLETED" : "TASK_INCOMPLETE", why: cg.why, status: cg.status, ...identityMeta() })
          // Contract may only DOWNGRADE a BLOCKED false completion (a user
          // decision is pending). Unverified writes are the completion gate's
          // job (`requireVerification`) — v101 authority already blocked more
          // writes during VERIFY; it must not silently reverse report-mode.
          if (fastGate.ok && !cg.ok && cg.status === "BLOCKED" && !governorHalt && !waitingForUser) {
            resStatus = "BLOCKED"
          }
        }
        cognition.persist()
      } catch (e) { swallowed("agent", "cognition close", e) }
    }
    // v119: a run that was refused and then COMPLETED cleared its blocker —
    // and it usually exits here rather than through another STOP candidate,
    // because the model simply answered. Recording the clearing only at the
    // candidate site would have counted the abandonments and missed the
    // successes, which is the worst possible half of the evidence to keep.
    if (lastCompletionBlocker && resStatus === "COMPLETED") {
      try {
        const { recordCompletionOutcome, COMPLETION_OUTCOME } = await import("./metalearn.js")
        recordCompletionOutcome({
          cwd: process.cwd(), klass: klass ?? "SMALL",
          blocker: lastCompletionBlocker, outcome: COMPLETION_OUTCOME.CLEARED,
          attempt: Math.max(1, sameBlockerRun),
        })
      } catch { /* calibration is a view, never a gate */ }
    }
    try {
      const { recordModelOutcome } = await import("./empirics.js")
      recordModelOutcome({
        provider: p?.name, model: p?.model,
        ok: resStatus === "COMPLETED",
        ms: Number(tokenUsage.latencyMs) || 0,
        klass,
      })
    } catch { /* empirics is a view, never a gate */ }
    try {
      const { recordOutcome } = await import("./modelstrategy.js")
      recordOutcome({
        provider: p?.name, model: p?.model,
        ok: resStatus === "COMPLETED",
        latencyMs: Number(tokenUsage.latencyMs) || 0,
        tokensIn: tokenUsage.prompt ?? 0,
        tokensOut: tokenUsage.completion ?? 0,
        toolCalls: toolLog?.length ?? 0,
        taskClass: klass,
        verificationPassed: verificationGap?.unverified?.length === 0,
      })
    } catch { /* modelstrategy ledger is best-effort */ }
    let checkpointId = null
    if (!waitingForUser && !governorHalt && !fastGate.ok && fastGate.status === "INCOMPLETE") {
      // §32: a resource limit is an execution control — checkpoint so the
      // work can resume (the same checkpoint module meta uses at segment
      // boundaries; no second checkpoint system).
      try {
        checkpointId = boundaryCheckpoint(process.cwd(), { runId, label: "budget-incomplete", objective: task })
        if (checkpointId && log) log.checkpoint(checkpointId)
      } catch { /* checkpoint is best-effort, never breaks the run */ }
      // v115: say which of the three it actually was. The refused-mutation and
      // loop cases ride the same gate input as budget exhaustion, so without
      // this they inherited its wording and the run reported "stopped at the
      // step budget" after two steps of an eight-step budget — a false reason
      // attached to an honest verdict, which is its own kind of lie.
      const resume = checkpointId ? `; checkpoint ${checkpointId} saved for resume` : ""
      if (loopHalt) {
        finalText = `(run stopped after repeating the same ${loopHalt.tool} call with the same result ${loopHalt.repeats} times in a row at step ${loopHalt.step} — it was making no progress, so continuing would only have cost more model calls; status INCOMPLETE, not completed${resume})`
      } else if (refusedOnly) {
        const why = [...new Set(mutatingAttempts.map((t) => String(t.result).replace(/^(BLOCKED|ERROR):\s*/, "").slice(0, 90)))][0] ?? "refused"
        finalText = `(every attempt to change a file was refused — ${mutatingAttempts.length} attempt(s), the last: ${why}. Nothing was written, so this run did NOT complete whatever it claimed; status INCOMPLETE${resume})`
      } else {
        finalText = `(run stopped at the step budget — ${steps}/${maxSteps} steps${stepExtensions ? ` after ${stepExtensions} productive extension(s) from ${maxStepsInitial}` : ""} — ${coercedByNudge ? "the final answer was forced by the tool-call budget and does not prove completion" : "before a final answer"}; status INCOMPLETE, not completed${resume})`
      }
    }
    const endStatus = waitingForUser ? "waiting_for_user" : (fastGate.ok && !waitingForUser ? "completed" : "incomplete")
    endRun(endStatus, { text: finalText, wrote })
    // v115: name the real reason. Everything that is not completion used to
    // come back as RESOURCE_LIMIT, so a refused-mutation run and a looping run
    // both reported a budget problem they never had.
    const stopReason = fastGate.ok ? null
      : loopHalt ? "LOOP_DETECTED"
      : refusedOnly ? "MUTATIONS_REFUSED"
      : "RESOURCE_LIMIT"
    // v118: a COMPLETED run carries no reason (v115's rule) — a verdict and an
    // excuse together is the shape the old GOVERNOR_STOP bug had. And a halt
    // that gave up on a blocker is COMPLETION_BLOCKED, not a clean stop.
    const govReason = waitingForUser
      ? "GOVERNOR_ASK"
      : (governorHalt ? (completionAbandoned ? "COMPLETION_BLOCKED" : (fastGate.ok ? null : "GOVERNOR_STOP")) : stopReason)
    return { status: resStatus, reason: waitingForUser || governorHalt ? govReason : stopReason, resource: waitingForUser || governorHalt ? null : (stopReason === "RESOURCE_LIMIT" ? "steps" : null), loopHalt: loopHalt ?? null, mutationsRefused: refusedOnly, completion: completionVerdict ?? null, completionCandidates, completionGate: fastGate, verification: verificationGap, verifyNudged: verifyNudgeFired, review: runReview, workspace: runWorkspace, created: createdFiles, outsideWrites, resume: checkpointId ? { checkpointId, steps, maxSteps } : null, text: finalText, steps, taskId: effectiveTaskId ?? null, segmentId: effectiveSegmentId ?? null, nodeId: effectiveNodeId ?? null, runId, toolLog, commandChecks, planOnly, wrote, budgetHit, stepExtensions, maxStepsInitial, lastExtensionEvidence, governor: lastGov ? { action: lastGov.action, why: lastGov.why, depth: lastGov.depth, enforce: lastAuth?.enforce ?? false, halt: lastAuth?.halt ?? false, waitForUser: waitingForUser, decisionId: waitDecision?.decision_id ?? null } : null, usage: { promptTokens: tokenUsage.prompt ?? 0, completionTokens: tokenUsage.completion ?? 0, totalTokens: (tokenUsage.prompt ?? 0) + (tokenUsage.completion ?? 0), latencyMs: tokenUsage.latencyMs ?? 0, toolCalls: toolLog?.length ?? 0, ...tokenUsage }, toolStats: intel.stats(), toolRecords: intel.records(), trace: tracer.snapshot(), softFailures: softfailSnapshot(), error: null }
  } catch (e) {
    const wrote = toolLog.some((t) => WRITE_TOOLS.has(t.name) && !String(t.result).startsWith("ERROR") && !String(t.result).startsWith("BLOCKED"))
    if (e?.name === "AbortError" || signal?.aborted) endRun("cancelled", { wrote })
    else endRun("failed", { error: e?.message ?? String(e), wrote })
    throw e
  } finally {
    try { recordToolRun({ cwd: process.cwd(), task, klass, records: intel.records() }) } catch { /* persist is best-effort */ }
    try {
      recordRunOutcomes({
        cwd: process.cwd(),
        klass,
        ok: runOk,
        records: intel.records(),
        createdNames: (plugins || []).filter((p) => p && p.created).map((p) => p.name),
      })
    } catch { /* caplearn is a view, never a gate */ }
    try {
      const { recordRoute } = await import("./jointroute.js")
      const skillNames = (intel.records() || []).flatMap((r) => {
        if (r.name === "load_skill" && r.args?.name) return [String(r.args.name)]
        return []
      })
      recordRoute({
        cwd: process.cwd(),
        klass,
        depth: lastGov?.depth || "L2",
        model: p?.model || "*",
        skills: skillNames,
        ok: runOk,
      })
    } catch { /* joint ledger is best-effort */ }
    try {
      if (ingestAcquire({ cwd: process.cwd(), task, klass, records: intel.records() })) clearComposeOnce()
    } catch { /* ingest is best-effort */ }
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
    } else if (ev.type === "step_budget_extended") {
      // v99 loopwise: visible mercy — the run is productive, so it continues
      const why = ev.evidence ? [ev.evidence.wroteRecently ? "fresh writes" : null, ev.evidence.verifiedRecently ? "passing checks" : null, ev.evidence.diverse ? `${ev.evidence.distinctRecent} distinct tools` : null].filter(Boolean).join(", ") : "productive"
      console.log(dim(`  ∞ step budget extended ${ev.from} → ${ev.to} (#${ev.extension}) — still productive (${why})`))
    } else if (ev.type === "compacted") {
      if (ev.after === -1) {
        console.log(yellow(`  ✂ ${ev.reason ?? "context overflow"} (~${ev.estTok} tok) — compressing and retrying`))
      } else {
        console.log(yellow(`  ✂ context compacted: ${ev.before} → ${ev.after} messages (~${ev.estTok} tok was over the ${ev.budgetTok} budget)${ev.shrunk ? ` • tool outputs shrunk (~${Math.round(ev.shrunk / 1024)}KB stubbed)` : ""}`))
      }
    }
  }
}
