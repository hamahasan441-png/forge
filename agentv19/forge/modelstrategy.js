/**
 * forge — model strategy engine (v21, zero dependencies)
 *
 * Provider failover (providers.js: fallbackChain) answers a DIFFERENT question
 * — "the current provider just errored, what's the next runnable provider?".
 * It is reactive transport recovery. This module is proactive SELECTION:
 *
 *   task → required capability → context requirements → risk → latency budget
 *        → token budget → cost → available models → best model
 *
 * It never moves keys or opens sockets. It ranks the models the user has ALREADY
 * configured/tested (no surprises, no billing the user for a provider they never
 * set up) and returns a structured decision with a confidence and a fallback
 * chain. Failover still handles hard errors at request time; this chooses the
 * starting model and when a STRATEGY change (not a transport error) warrants a
 * different model mid-task.
 */
import { buildProvider, fallbackChain, getCatalog } from "./providers.js"
import { classifyTaskComplexity } from "./agent.js"

/** Capability classes a model choice is made for. */
export const CAPABILITY_CLASS = {
  FAST_REASONING: "fast_reasoning",
  CODING: "coding",
  LARGE_CONTEXT: "large_context",
  REPOSITORY_ANALYSIS: "repository_analysis",
  DEBUGGING: "debugging",
  SECURITY_REVIEW: "security_review",
  PLANNING: "planning",
  SUMMARIZATION: "summarization",
  TOOL_SELECTION: "tool_selection",
}

/**
 * Heuristic capability tags for models we know by name. Unknown models get a
 * neutral profile so they are never preferred for work they may not be good at.
 * Tags: fast, coding, largectx, reasoning, cheap.
 */
const MODEL_PROFILES = [
  { match: /gpt-4o-mini|haiku|flash|mini|instant|8b|small|air/i, tags: ["fast", "cheap", "coding"] },
  { match: /o3-mini|o3|reasoner|grok-4|gpt-4o|sonnet|deepseek-v3|deepseek-chat|qwen-max|glm-4\.6|llama-3\.3-70b|mistral-large/i, tags: ["coding", "reasoning"] },
  { match: /opus|pro|o1|gpt-5|gemini-2\.5-pro/i, tags: ["coding", "reasoning", "largectx"] },
  { match: /gemini|1m|large/i, tags: ["largectx"] },
]

function profileFor(model) {
  const tags = new Set()
  for (const p of MODEL_PROFILES) if (p.match.test(String(model))) p.tags.forEach((t) => tags.add(t))
  return tags
}

/**
 * Determine which capability classes this task needs.
 * Returns [{ class, weight }] sorted by weight.
 */
export function requiredCapabilities(task, { risk = "medium", files = 0, contextTokens = 0 } = {}) {
  const t = String(task ?? "").toLowerCase()
  const complexity = classifyTaskComplexity(task)
  const needs = []
  const add = (cls, w) => needs.push({ class: cls, weight: w })

  if (/debug|not working|failing|broken|regression|error|exception|stack trace|root cause/i.test(t)) add(CAPABILITY_CLASS.DEBUGGING, 3)
  if (/security|vulnerab|injection|auth|exploit|secret|sanitiz/i.test(t)) add(CAPABILITY_CLASS.SECURITY_REVIEW, 3)
  if (/plan|architect|design|migrat|refactor across|multi-file|design the/i.test(t)) add(CAPABILITY_CLASS.PLANNING, 2)
  if (/summar|tl;dr|overview|explain (the )?codebase|what does/i.test(t)) add(CAPABILITY_CLASS.SUMMARIZATION, 2)
  if (/repo|repository|codebase|across (files|the project)|whole project/i.test(t)) add(CAPABILITY_CLASS.REPOSITORY_ANALYSIS, 2)
  if (/implement|write|edit|fix|add |create |build |code|function|patch/i.test(t)) add(CAPABILITY_CLASS.CODING, 2)

  // context pressure → large context matters
  if (contextTokens > 90_000 || files > 40) add(CAPABILITY_CLASS.LARGE_CONTEXT, 3)
  else if (contextTokens > 40_000) add(CAPABILITY_CLASS.LARGE_CONTEXT, 1)

  // debugging/coding/security are always tool-selection heavy
  add(CAPABILITY_CLASS.TOOL_SELECTION, 1)

  // complex/critical tasks want strong reasoning; trivial ones want speed
  if (complexity === "complex" || complexity === "critical") add(CAPABILITY_CLASS.FAST_REASONING, 0) // don't force FAST — force strong
  else add(CAPABILITY_CLASS.FAST_REASONING, 2)

  // security/critical risk bumps reasoning
  if (risk === "critical" || risk === "high") add(CAPABILITY_CLASS.PLANNING, 1)

  return needs.sort((a, b) => b.weight - a.weight)
}

/** Score a candidate model for the requirement set. Higher is better. */
function scoreModel({ model, provider, caps, limits, catalogWindow }) {
  const tags = profileFor(model)
  let score = 0
  const reasons = []
  const top = caps[0]?.class
  const wants = (cls) => caps.some((c) => c.class === cls)

  const window = provider.contextWindow || catalogWindow || 128_000
  if (wants(CAPABILITY_CLASS.LARGE_CONTEXT)) {
    if (window >= 200_000) { score += 5; reasons.push("large context window") }
    else if (window < 128_000) { score -= 3; reasons.push("small context window for this task") }
  }
  if (wants(CAPABILITY_CLASS.CODING) || wants(CAPABILITY_CLASS.DEBUGGING)) {
    if (tags.has("coding")) { score += 4; reasons.push("strong at coding") }
    if (tags.has("reasoning")) { score += 3; reasons.push("strong reasoning") }
  }
  if (wants(CAPABILITY_CLASS.SECURITY_REVIEW)) {
    if (tags.has("reasoning")) { score += 4; reasons.push("strong reasoning for security review") }
  }
  if (wants(CAPABILITY_CLASS.PLANNING)) {
    if (tags.has("reasoning")) score += 3
  }
  if (top === CAPABILITY_CLASS.FAST_REASONING || wants(CAPABILITY_CLASS.SUMMARIZATION)) {
    if (tags.has("fast")) { score += 4; reasons.push("fast + cheap for this light task") }
  }
  // latency budget pressure
  if (limits.latencyBudgetMs && limits.latencyBudgetMs < 15_000 && tags.has("fast")) { score += 2; reasons.push("meets tight latency budget") }
  // cost pressure
  if (limits.costBias === "low" && tags.has("cheap")) { score += 3; reasons.push("low cost") }
  // a model with no recognized tags is a safe neutral choice, never preferred
  if (!tags.size) score += 0

  return { score, reasons, window, tags: [...tags] }
}

/**
 * The main entry: choose the best model among the user's configured providers.
 *
 * @param config    forge config
 * @param opts      { task, provider, risk, files, contextTokens, latencyBudgetMs,
 *                   tokenBudget, preferredClass, excludeModel }
 * @returns { decision: {model, provider, reason, capabilities, estimated_cost,
 *            estimated_latency, confidence, fallback}, candidates:[…] }
 */
export function selectModel(config, opts = {}) {
  const {
    task = "", provider: active = null, risk = "medium", files = 0,
    contextTokens = 0, latencyBudgetMs = null, preferredClass = null,
    excludeModel = null,
  } = opts

  const caps = requiredCapabilities(task, { risk, files, contextTokens })
  if (preferredClass) caps.unshift({ class: preferredClass, weight: 4 })
  const limits = { latencyBudgetMs, costBias: opts.costBias ?? "normal" }

  // gather runnable candidates from configured providers (the active one first)
  const candidates = []
  const providerNames = Object.keys(config?.providers || {})
  const ordered = active?.name && providerNames.includes(active.name)
    ? [active.name, ...providerNames.filter((n) => n !== active.name)]
    : providerNames
  for (const name of ordered) {
    const p = buildProvider(config, name)
    if (!p) continue
    const cat = getCatalog(name)
    // models the user has explicitly used/picked come first, then catalog defaults
    const remembered = config.providers[name]?.models ?? []
    const models = [...new Set([p.model, ...remembered, ...(cat?.models ?? [])].filter(Boolean))]
    for (const model of models.slice(0, 6)) {
      if (excludeModel && model === excludeModel && name === active?.name) continue
      const { score, reasons, window, tags } = scoreModel({ model, provider: p, caps, limits, catalogWindow: cat?.contextWindow })
      const isActive = active?.name === name && active?.model === model
      candidates.push({
        provider: name, model, score, reasons, window, tags,
        protocol: p.protocol,
        active: isActive,
        // an active model whose name we do NOT recognize cannot be meaningfully
        // out-ranked by a tag heuristic on another provider — it's the user's
        // explicit choice, so it is never switched away on a heuristic tie.
        recognized: tags.length > 0,
      })
    }
  }

  // The ACTIVE provider is the user's explicit choice. It wins ties and stays
  // default unless another candidate beats it by a clear margin — switching
  // providers is disruptive (different wire protocol, latency, billing) and
  // must not happen on a heuristic tie. When the active model's name is not
  // recognized at all, we cannot meaningfully rank it, so it stays default.
  const activeCandidate = candidates.find((c) => c.active) ?? null
  candidates.sort((a, b) => b.score - a.score)
  let best = candidates[0] ?? null
  const SWITCH_MARGIN = 3
  if (activeCandidate && best && best !== activeCandidate) {
    const margin = best.score - activeCandidate.score
    const activeUnrecognized = !activeCandidate.recognized
    if (margin < SWITCH_MARGIN || activeUnrecognized) best = activeCandidate
  }
  if (!best && activeCandidate) best = activeCandidate

  // fallback chain = other runnable providers (transport failover), preferred
  // after the current one in score order.
  const fallback = fallbackChain(config, active?.name ?? best?.provider ?? "", { health: opts.health ?? {} })
    .map((p) => ({ provider: p.name, model: p.model }))

  if (!best) {
    return {
      decision: null,
      capabilities: caps.map((c) => c.class),
      reason: "no configured provider/model available",
      candidates: [],
      fallback,
    }
  }

  // confidence: how decisively the top candidate beat the next
  const next = candidates[1]
  const margin = best.score - (next?.score ?? best.score)
  const confidence = best.score <= 0 ? "low" : margin >= 4 ? "high" : margin >= 1 ? "medium" : "low"

  // rough, relative estimates (no pricing table shipped — order of magnitude only)
  const cheap = best.tags.includes("cheap")
  const estimated_cost = cheap ? "low" : best.tags.includes("fast") ? "low-medium" : "medium"
  const estimated_latency = best.tags.includes("fast") ? "fast" : best.tags.includes("reasoning") ? "slower (deeper reasoning)" : "normal"

  return {
    decision: {
      model: best.model,
      provider: best.provider,
      reason: best.reasons.slice(0, 3).join("; ") || "best available match for the task",
      capabilities: caps.map((c) => c.class),
      estimated_cost,
      estimated_latency,
      confidence,
      fallback,
      score: best.score,
    },
    candidates: candidates.map((c) => ({ provider: c.provider, model: c.model, score: c.score, active: c.active })),
  }
}

/**
 * Decide whether a mid-task STRATEGY change warrants switching model. This is
 * NOT transport failover (that stays in providers.js) — it is "the model keeps
 * failing at this kind of work, or resources demand a cheaper/faster class".
 * Returns a decision or null when the current model should stay.
 */
export function reconsiderModel(config, opts = {}) {
  const { provider = null, failures = 0, failureKind = null, resourceLimits = null, task = "" } = opts
  // repeated model-attributed failures → try a stronger/different model
  const modelAttributed = failureKind === "model_failure" || failureKind === "reasoning"
  if ((modelAttributed && failures >= 2) || resourceLimits?.preferredClass) {
    const res = selectModel(config, {
      task, provider, preferredClass: resourceLimits?.preferredClass ?? null,
      excludeModel: modelAttributed ? provider?.model : null,
    })
    if (!res.decision) return null
    if (res.decision.provider === provider?.name && res.decision.model === provider?.model) return null
    return res.decision
  }
  return null
}
