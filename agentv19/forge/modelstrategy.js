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

import fs from "node:fs"
import path from "node:path"
import { DEFAULT_DIR } from "./config.js"
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

// ---------------------------------------------------------------------------
// P1 — MODEL PERFORMANCE ROUTING ON REAL HISTORY
// ---------------------------------------------------------------------------
//
// The registry below is a PRIOR: what the model is *believed* to be good at.
// Routing must also use what forge actually OBSERVED — success rate, repair
// rate, verification pass rate, token efficiency, latency percentiles and
// reliability, recorded after every run in ~/.forge/model-performance.json.
//
// One bad sample must never dominate: every rate is shrunk toward its prior
// with a pseudo-count (Bayesian/Additive smoothing), so 0/1 moves a 0.9 prior
// to ~0.75 while 0/10 moves it to ~0.45.
export const PERF_FILE = path.join(DEFAULT_DIR, "model-performance.json")
const PRIOR_WEIGHT = 5 // pseudo-count: samples needed to outweigh the prior
const MAX_MODELS_TRACKED = 200
const MAX_SAMPLES_REMEMBERED = 50

/** What a registry entry claims, expressed as the same rates we measure. */
const PRIOR_RATES = {
  strong: { successRate: 0.9, repairRate: 0.25, verificationPassRate: 0.85, reliability: 0.92 },
  fast: { successRate: 0.82, repairRate: 0.35, verificationPassRate: 0.75, reliability: 0.88 },
  unknown: { successRate: 0.6, repairRate: 0.5, verificationPassRate: 0.5, reliability: 0.6 },
}

export function loadPerformance() {
  try {
    const j = JSON.parse(fs.readFileSync(PERF_FILE, "utf8"))
    return j && typeof j === "object" && !Array.isArray(j) ? j : {}
  } catch { return {} }
}

function savePerformance(data) {
  try {
    fs.mkdirSync(path.dirname(PERF_FILE), { recursive: true })
    const tmp = PERF_FILE + ".tmp"
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 })
    fs.renameSync(tmp, PERF_FILE)
    return true
  } catch { return false }
}

export function modelKey(model, provider = null) {
  return provider ? `${String(provider)}:${String(model)}` : String(model)
}

/**
 * Record what actually happened on a run. Called by the controller after every
 * segment/task so routing improves with real evidence instead of model names.
 *
 * @param {object} o  { provider, model, ok, repairs, verificationPassed,
 *                      verificationTotal, latencyMs, tokensIn, tokensOut,
 *                      toolCalls, taskClass, crashed }
 */
export function recordOutcome(o = {}) {
  const key = modelKey(o.model, o.provider)
  if (!key || key === ":") return null
  const all = loadPerformance()
  const rec = all[key] ?? {
    model: String(o.model ?? ""), provider: o.provider ?? null,
    samples: 0, successes: 0, failures: 0, crashes: 0, repairs: 0,
    verificationPassed: 0, verificationTotal: 0,
    latencyMs: [], tokensIn: 0, tokensOut: 0, toolCalls: 0,
    firstSeen: Date.now(), byClass: {},
  }
  const ok = o.ok === true
  rec.samples++
  if (ok) rec.successes++; else rec.failures++
  if (o.crashed === true) rec.crashes++
  rec.repairs += Number(o.repairs ?? 0) || 0
  const vt = Number(o.verificationTotal ?? 0) || 0
  if (vt > 0) { rec.verificationTotal += vt; rec.verificationPassed += Math.min(vt, Number(o.verificationPassed ?? 0) || 0) }
  else if (o.verificationPassed != null) { rec.verificationTotal += 1; rec.verificationPassed += o.verificationPassed === true ? 1 : 0 }
  if (Number.isFinite(o.latencyMs)) {
    rec.latencyMs.push(Math.round(Number(o.latencyMs)))
    if (rec.latencyMs.length > MAX_SAMPLES_REMEMBERED) rec.latencyMs.shift()
  }
  rec.tokensIn += Number(o.tokensIn ?? 0) || 0
  rec.tokensOut += Number(o.tokensOut ?? 0) || 0
  rec.toolCalls += Number(o.toolCalls ?? 0) || 0
  const cls = o.taskClass ? String(o.taskClass) : "general"
  rec.byClass[cls] = rec.byClass[cls] ?? { samples: 0, successes: 0 }
  rec.byClass[cls].samples++
  if (ok) rec.byClass[cls].successes++
  rec.lastUsed = Date.now()
  all[key] = rec
  // bounded: never let the file grow without limit
  const keys = Object.keys(all)
  if (keys.length > MAX_MODELS_TRACKED) {
    keys.sort((a, b) => (all[b].samples ?? 0) - (all[a].samples ?? 0))
    for (const k of keys.slice(MAX_MODELS_TRACKED)) delete all[k]
  }
  savePerformance(all)
  return rec
}

function percentile(sorted, p) {
  if (!sorted.length) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

export function clearPerformance() {
  try { fs.rmSync(PERF_FILE, { force: true }); return true } catch { return false }
}

/**
 * Merge the registry prior with what was observed, with damping.
 * Rates are shrunk toward the prior by PRIOR_WEIGHT pseudo-observations so a
 * single failure (or a single lucky success) cannot flip routing.
 */
export function effectiveStats(model, provider = null) {
  const reg = lookupRegistry(model)
  const prior = PRIOR_RATES[reg?.tier] ?? PRIOR_RATES.unknown
  const rec = loadPerformance()[modelKey(model, provider)]
    ?? (provider ? null : loadPerformance()[modelKey(model)] ?? null)
  const n = rec?.samples ?? 0
  const shrink = (observedNumerator, observedDenominator, priorRate) => {
    const num = (observedNumerator ?? 0) + PRIOR_WEIGHT * priorRate
    const den = (observedDenominator ?? 0) + PRIOR_WEIGHT
    return den > 0 ? num / den : priorRate
  }
  const successRate = shrink(rec?.successes, n, prior.successRate)
  const repairRate = shrink(rec?.repairs, Math.max(1, n), prior.repairRate)
  const verificationPassRate = shrink(rec?.verificationPassed, rec?.verificationTotal, prior.verificationPassRate)
  const reliability = shrink(Math.max(0, (rec?.samples ?? 0) - (rec?.crashes ?? 0)), n, prior.reliability)
  const lat = [...(rec?.latencyMs ?? [])].sort((a, b) => a - b)
  const tokensTotal = (rec?.tokensIn ?? 0) + (rec?.tokensOut ?? 0)
  return {
    model: String(model ?? ""),
    provider: provider ?? null,
    samples: n,
    recognized: !!reg,
    contextWindow: reg?.contextWindow ?? null,
    latencyP50: percentile(lat, 50),
    latencyP95: percentile(lat, 95),
    successRate: round4(successRate),
    // mean repairs per run, clamped to a 0..1 rate for routing comparisons
    repairRate: Math.min(1, round4(repairRate)),
    verificationPassRate: round4(verificationPassRate),
    reliability: round4(reliability),
    tokenEfficiency: rec?.tokensIn ? round4((rec.tokensIn ?? 0) / Math.max(1, n)) : null,
    tokensTotal,
    fromHistory: n > 0,
  }
}

function round4(x) { return Math.round(Number(x) * 10000) / 10000 }

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

  // P1: routing on MEASURED performance, not only on the model's name.
  // Damped (see effectiveStats) so one failure cannot blacklist a model.
  const perf = effectiveStats(model, provider?.name ?? null)
  if (perf.fromHistory) {
    const delta =
      (perf.successRate - 0.7) * 10 +
      (perf.verificationPassRate - 0.7) * 6 -
      (perf.repairRate - 0.3) * 6 +
      (perf.reliability - 0.8) * 4
    score += Math.max(-8, Math.min(8, delta))
    const pct = (x) => `${Math.round((x ?? 0) * 100)}%`
    if (delta >= 1) reasons.push(`measured: ${pct(perf.successRate)} success, ${pct(perf.verificationPassRate)} verified over ${perf.samples} run(s)`)
    else if (delta <= -1) reasons.push(`measured: only ${pct(perf.successRate)} success, ${pct(perf.verificationPassRate)} verified over ${perf.samples} run(s) — history says avoid`)
  }

  return { score, reasons, window, tags: [...tags], registryEntry: reg, recognized: !!reg, performance: perf }
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
      const { score, reasons, window, tags, recognized, performance: performance_ } = scoreModel({ model, provider: p, caps, limits, catalogWindow: cat?.contextWindow })
      const isActive = active?.name === name && active?.model === model
      candidates.push({
        provider: name, model, score, reasons, window, tags,
        protocol: p.protocol,
        active: isActive,
        recognized,
        performance: performance_,
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
      performance: best.performance ?? null,
    },
    candidates: candidates.map((c) => ({
      provider: c.provider, model: c.model, score: c.score, active: c.active,
      reasons: c.reasons ?? [],
      performance: c.performance ?? null,
    })),
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
