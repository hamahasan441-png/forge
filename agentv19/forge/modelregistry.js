/**
 * forge — model capability registry (v21.1).
 *
 * Split out of modelstrategy.js so that modules BELOW it in the import graph
 * (providers.js, agent.js, chat.js) can consult the registry without creating
 * a cycle: modelstrategy.js imports agent.js for classifyTaskComplexity, so
 * agent.js must never import modelstrategy.js. This file has NO imports.
 *
 * Each entry: capabilities, tags (fast, cheap, coding, reasoning, largectx),
 * contextWindow, latency, cost, tier. Unknown models get no entry — callers
 * fall back to the provider's declared window and conservative heuristics.
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

/** Registry entry for a model id, tolerating a provider prefix (openai/gpt-4o → gpt-4o). */
export function lookupRegistry(model) {
  const m = String(model ?? "").trim()
  if (MODEL_CAPABILITY_REGISTRY[m]) return MODEL_CAPABILITY_REGISTRY[m]
  const base = m.split("/").pop()
  if (MODEL_CAPABILITY_REGISTRY[base]) return MODEL_CAPABILITY_REGISTRY[base]
  return null
}
