/**
 * forge — model strategy engine (v21 hardened v23, zero dependencies)
 *
 * Provider failover (providers.js: fallbackChain) answers a DIFFERENT question
 * — "the current provider just errored, what's the next runnable provider?".
 * It is reactive transport recovery. This module is proactive SELECTION:
 *
 *   task → required capability → context requirements → risk → latency budget
 *        → token budget → cost → available models → best model
 *
 * Hardening v23 P1: capability registry not name heuristic.
 * Instead of substring matching on model names (e.g. /mini/ → fast),
 * we maintain an explicit MODEL_CAPABILITY_REGISTRY that records
 * for each known model its capabilities, performance tier, context,
 * latency and cost. Unknown models get a neutral profile.
 * The registry is the single source for routing decisions.
 */

import { buildProvider, fallbackChain, getCatalog } from "./providers.js"
import { classifyTaskComplexity } from "./agent.js"

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
 * Explicit model capability registry (P1).
 * Each entry: capabilities, tags (fast, cheap, coding, reasoning, largectx),
 * performance tier, contextWindow, latency, cost.
 * This replaces pure name heuristic with structured registry.
 */
export const MODEL_CAPABILITY_REGISTRY = {
  // OpenAI
  "gpt-4o": { capabilities: ["coding", "reasoning"], tags: ["coding", "reasoning"], contextWindow: 128000, latency: "normal", cost: "medium", tier: "strong" },
  "gpt-4o-mini": { capabilities: ["coding", "fast"], tags: ["fast", "cheap", "coding"], contextWindow: 128000, latency: "fast", cost: "low", tier: "fast" },
  "o3-mini": { capabilities: ["coding", "reasoning"], tags: ["coding", "reasoning"], contextWindow: 128000, latency: "normal", cost: "medium", tier: "strong" },
  "o1": { capabilities: ["coding", "reasoning", "largectx"], tags: ["coding", "reasoning", "largectx"], contextWindow: 200000, latency: "slow", cost: "high", tier: "strong" },
  "gpt-5": { capabilities: ["coding", "reasoning", "largectx"], tags: ["coding", "reasoning", "largectx"], contextWindow: 200000, latency: "slow", cost: "high", tier: "strong" },
  // Anthropic
  "claude-sonnet-4-5": { capabilities: ["coding", "reasoning"], tags: ["coding", "reasoning"], contextWindow: 200000, latency: "normal", cost: "medium", tier: "strong" },
  "claude-opus-4-1": { capabilities: ["coding", "reasoning", "largectx"], tags: ["coding", "reasoning", "largectx"], contextWindow: 200000, latency: "slow", cost: "high", tier: "strong" },
  "claude-3-5-haiku-latest": { capabilities: ["coding", "fast"], tags: ["fast", "cheap", "coding"], contextWindow: 200000, latency: "fast", cost: "low", tier: "fast" },
  "claude-3-5-sonnet-latest": { capabilities: ["coding", "reasoning"], tags: ["coding", "reasoning"], contextWindow: 200000, latency: "normal", cost: "medium", tier: "strong" },
  // Google
  "gemini-2.5-pro": { capabilities: ["coding", "reasoning", "largectx"], tags: ["coding", "reasoning", "largectx"], contextWindow: 1048576, latency: "slow", cost: "high", tier: "strong" },
  "gemini-2.5-flash": { capabilities: ["coding", "fast", "largectx"], tags: ["fast", "coding", "largectx"], contextWindow: 1048576, latency: "fast", cost: "low", tier: "fast" },
  "gemini-1.5-pro": { capabilities: ["coding", "reasoning", "largectx"], tags: ["coding", "reasoning", "largectx"], contextWindow: 1048576, latency: "normal", cost: "medium", tier: "strong" },
  // DeepSeek
  "deepseek-chat": { capabilities: ["coding", "reasoning"], tags: ["coding", "reasoning"], contextWindow: 128000, latency: "normal", cost: "low", tier: "strong" },
  "deepseek-reasoner": { capabilities: ["coding", "reasoning"], tags: ["coding", "reasoning"], contextWindow: 128000, latency: "normal", cost: "low", tier: "strong" },
  "deepseek-v3": { capabilities: ["coding", "reasoning"], tags: ["coding", "reasoning"], contextWindow: 128000, latency: "normal", cost: "low", tier: "strong" },
  // Groq / Llama
  "llama-3.3-70b-versatile": { capabilities: ["coding", "reasoning"], tags: ["coding", "reasoning"], contextWindow: 128000, latency: "fast", cost: "low", tier: "strong" },
  "llama-3.1-8b-instant": { capabilities: ["coding", "fast"], tags: ["fast", "cheap", "coding"], contextWindow: 128000, latency: "fast", cost: "low", tier: "fast" },
  "llama-3.3-70b": { capabilities: ["coding", "reasoning"], tags: ["coding", "reasoning"], contextWindow: 128000, latency: "normal", cost: "low", tier: "strong" },
  "llama3.1-8b": { capabilities: ["coding", "fast"], tags: ["fast", "cheap", "coding"], contextWindow: 128000, latency: "fast", cost: "low", tier: "fast" },
  // Mistral
  "mistral-large-latest": { capabilities: ["coding", "reasoning"], tags: ["coding", "reasoning"], contextWindow: 128000, latency: "normal", cost: "medium", tier: "strong" },
  "mistral-small-latest": { capabilities: ["coding", "fast"], tags: ["fast", "cheap", "coding"], contextWindow: 128000, latency: "fast", cost: "low", tier: "fast" },
  // xAI
  "grok-4": { capabilities: ["coding", "reasoning"], tags: ["coding", "reasoning"], contextWindow: 131072, latency: "normal", cost: "medium", tier: "strong" },
  "grok-3-mini": { capabilities: ["coding", "fast"], tags: ["fast", "cheap", "coding"], contextWindow: 131072, latency: "fast", cost: "low", tier: "fast" },
  // Z.ai
  "glm-4.6": { capabilities: ["coding", "reasoning"], tags: ["coding", "reasoning"], contextWindow: 128000, latency: "normal", cost: "medium", tier: "strong" },
  "glm-4.5": { capabilities: ["coding", "reasoning"], tags: ["coding", "reasoning"], contextWindow: 128000, latency: "normal", cost: "medium", tier: "strong" },
  "glm-4.5-air": { capabilities: ["coding", "fast"], tags: ["fast", "cheap", "coding"], contextWindow: 128000, latency: "fast", cost: "low", tier: "fast" },
  // Qwen
  "qwen-max": { capabilities: ["coding", "reasoning"], tags: ["coding", "reasoning"], contextWindow: 131072, latency: "normal", cost: "medium", tier: "strong" },
  "qwen-plus": { capabilities: ["coding", "reasoning"], tags: ["coding", "reasoning"], contextWindow: 131072, latency: "normal", cost: "medium", tier: "strong" },
  // Ollama local
  "llama3.2": { capabilities: ["coding", "fast"], tags: ["fast", "cheap", "coding"], contextWindow: 128000, latency: "fast", cost: "low", tier: "fast" },
  "qwen2.5-coder": { capabilities: ["coding", "reasoning"], tags: ["coding", "reasoning"], contextWindow: 128000, latency: "normal", cost: "low", tier: "strong" },
}

function lookupRegistry(model) {
  const m = String(model ?? "").trim()
  if (MODEL_CAPABILITY_REGISTRY[m]) return MODEL_CAPABILITY_REGISTRY[m]
  // try base model without provider prefix (e.g. openai/gpt-4o-mini → gpt-4o-mini)
  const base = m.split("/").pop()
  if (MODEL_CAPABILITY_REGISTRY[base]) return MODEL_CAPABILITY_REGISTRY[base]
  return null
}

function profileFor(model) {
  const reg = lookupRegistry(model)
  if (reg) return new Set(reg.tags)
  // fallback for unknown: neutral, not preferred for anything
  // still apply conservative heuristic for truly unknown to avoid breakage,
  // but mark as unrecognized via separate flag
  const tags = new Set()
  const mm = String(model).toLowerCase()
  if (/mini|haiku|flash|instant|8b|small|air|fast/.test(mm)) { tags.add("fast"); tags.add("cheap") }
  if (/coding|code/.test(mm)) tags.add("coding")
  return tags
}

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

  if (contextTokens > 90_000 || files > 40) add(CAPABILITY_CLASS.LARGE_CONTEXT, 3)
  else if (contextTokens > 40_000) add(CAPABILITY_CLASS.LARGE_CONTEXT, 1)

  add(CAPABILITY_CLASS.TOOL_SELECTION, 1)

  if (complexity === "complex" || complexity === "critical") add(CAPABILITY_CLASS.FAST_REASONING, 0)
  else add(CAPABILITY_CLASS.FAST_REASONING, 2)

  if (risk === "critical" || risk === "high") add(CAPABILITY_CLASS.PLANNING, 1)

  return needs.sort((a, b) => b.weight - a.weight)
}

function scoreModel({ model, provider, caps, limits, catalogWindow }) {
  const reg = lookupRegistry(model)
  const tags = reg ? new Set(reg.tags) : profileFor(model)
  let score = 0
  const reasons = []
  const top = caps[0]?.class
  const wants = (cls) => caps.some((c) => c.class === cls)

  const window = reg?.contextWindow ?? provider.contextWindow ?? catalogWindow ?? 128000
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
  if (limits.latencyBudgetMs && limits.latencyBudgetMs < 15_000 && tags.has("fast")) { score += 2; reasons.push("meets tight latency budget") }
  if (limits.costBias === "low" && tags.has("cheap")) { score += 3; reasons.push("low cost") }
  if (!tags.size) score += 0

  return { score, reasons, window, tags: [...tags], registryEntry: reg, recognized: !!reg }
}

export function selectModel(config, opts = {}) {
  const {
    task = "", provider: active = null, risk = "medium", files = 0,
    contextTokens = 0, latencyBudgetMs = null, preferredClass = null,
    excludeModel = null,
  } = opts

  const caps = requiredCapabilities(task, { risk, files, contextTokens })
  if (preferredClass) caps.unshift({ class: preferredClass, weight: 4 })
  const limits = { latencyBudgetMs, costBias: opts.costBias ?? "normal" }

  const candidates = []
  const providerNames = Object.keys(config?.providers || {})
  const ordered = active?.name && providerNames.includes(active.name)
    ? [active.name, ...providerNames.filter((n) => n !== active.name)]
    : providerNames
  for (const name of ordered) {
    const p = buildProvider(config, name)
    if (!p) continue
    const cat = getCatalog(name)
    const remembered = config.providers[name]?.models ?? []
    const models = [...new Set([p.model, ...remembered, ...(cat?.models ?? [])].filter(Boolean))]
    for (const model of models.slice(0, 6)) {
      if (excludeModel && model === excludeModel && name === active?.name) continue
      const { score, reasons, window, tags, recognized } = scoreModel({ model, provider: p, caps, limits, catalogWindow: cat?.contextWindow })
      const isActive = active?.name === name && active?.model === model
      candidates.push({
        provider: name, model, score, reasons, window, tags,
        protocol: p.protocol,
        active: isActive,
        recognized,
      })
    }
  }

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

  const next = candidates[1]
  const margin = best.score - (next?.score ?? best.score)
  const confidence = best.score <= 0 ? "low" : margin >= 4 ? "high" : margin >= 1 ? "medium" : "low"

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

export function reconsiderModel(config, opts = {}) {
  const { provider = null, failures = 0, failureKind = null, resourceLimits = null, task = "" } = opts
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
