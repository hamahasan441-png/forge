/**
 * forge — provider catalog + direct HTTP clients (zero dependencies)
 *
 * Two wire protocols:
 *   "openai"    POST {baseUrl}/chat/completions  (Bearer)     — 17 providers
 *   "anthropic" POST {baseUrl}/v1/messages       (x-api-key)  — anthropic
 *
 * streamChat()          → SSE streaming: text / reasoning / tool_calls / usage / done events
 * streamChatResilient() → streamChat + transient retry (429/5xx/network) with backoff
 * chatOnce()            → non-streaming with tool-calls (agent mode), both protocols
 * probe()               → connectivity + latency probe (forge doctor)
 */
export const CATALOG = [
  { name: "openai",        label: "OpenAI",                   protocol: "openai",    baseUrl: "https://api.openai.com/v1",                               envKey: "OPENAI_API_KEY",     needsKey: true,  models: ["gpt-4o", "gpt-4o-mini", "o3-mini"], contextWindow: 128000,  keyUrl: "https://platform.openai.com/api-keys" },
  { name: "anthropic",     label: "Anthropic Claude",         protocol: "anthropic", baseUrl: "https://api.anthropic.com",                               envKey: "ANTHROPIC_API_KEY",  needsKey: true,  models: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-3-5-haiku-latest"], contextWindow: 200000, keyUrl: "https://console.anthropic.com/settings/keys" },
  { name: "zai",           label: "Z.ai (GLM)",               protocol: "openai",    baseUrl: "https://api.z.ai/api/paas/v4",                            envKey: "ZAI_API_KEY",        needsKey: true,  models: ["glm-4.6", "glm-4.5", "glm-4.5-air"], contextWindow: 128000, keyUrl: "https://z.ai/manage-apikey/apikey-list" },
  { name: "deepseek",      label: "DeepSeek",                 protocol: "openai",    baseUrl: "https://api.deepseek.com/v1",                             envKey: "DEEPSEEK_API_KEY",   needsKey: true,  models: ["deepseek-chat", "deepseek-reasoner"], contextWindow: 128000, keyUrl: "https://platform.deepseek.com/api_keys" },
  { name: "groq",          label: "Groq (fastest)",           protocol: "openai",    baseUrl: "https://api.groq.com/openai/v1",                          envKey: "GROQ_API_KEY",       needsKey: true,  models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"], contextWindow: 128000, keyUrl: "https://console.groq.com/keys" },
  { name: "openrouter",    label: "OpenRouter (400+ models)", protocol: "openai",    baseUrl: "https://openrouter.ai/api/v1",                            envKey: "OPENROUTER_API_KEY", needsKey: true,  models: ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4.5"], contextWindow: 128000, keyUrl: "https://openrouter.ai/keys" },
  { name: "gemini",        label: "Google Gemini",            protocol: "openai",    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", envKey: "GEMINI_API_KEY",     needsKey: true,  models: ["gemini-2.5-pro", "gemini-2.5-flash"], contextWindow: 1048576, keyUrl: "https://aistudio.google.com/apikey" },
  { name: "mistral",       label: "Mistral",                  protocol: "openai",    baseUrl: "https://api.mistral.ai/v1",                               envKey: "MISTRAL_API_KEY",    needsKey: true,  models: ["mistral-large-latest", "mistral-small-latest"], contextWindow: 128000, keyUrl: "https://console.mistral.ai/api-keys" },
  { name: "xai",           label: "xAI Grok",                 protocol: "openai",    baseUrl: "https://api.x.ai/v1",                                     envKey: "XAI_API_KEY",        needsKey: true,  models: ["grok-4", "grok-3-mini"], contextWindow: 131072, keyUrl: "https://console.x.ai" },
  { name: "together",      label: "Together AI",              protocol: "openai",    baseUrl: "https://api.together.xyz/v1",                             envKey: "TOGETHER_API_KEY",   needsKey: true,  models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"], contextWindow: 128000, keyUrl: "https://api.together.ai/settings/api-keys" },
  { name: "cerebras",      label: "Cerebras",                 protocol: "openai",    baseUrl: "https://api.cerebras.ai/v1",                              envKey: "CEREBRAS_API_KEY",   needsKey: true,  models: ["llama-3.3-70b", "llama3.1-8b"], contextWindow: 128000, keyUrl: "https://cloud.cerebras.ai" },
  { name: "nvidia",        label: "NVIDIA NIM",               protocol: "openai",    baseUrl: "https://integrate.api.nvidia.com/v1",                     envKey: "NVIDIA_API_KEY",     needsKey: true,  models: ["meta/llama-3.3-70b-instruct"], contextWindow: 128000, keyUrl: "https://build.nvidia.com/settings/api-keys" },
  { name: "siliconflow",   label: "SiliconFlow",              protocol: "openai",    baseUrl: "https://api.siliconflow.cn/v1",                           envKey: "SILICONFLOW_API_KEY", needsKey: true, models: ["deepseek-ai/DeepSeek-V3"], contextWindow: 128000, keyUrl: "https://cloud.siliconflow.cn/account/ak" },
  { name: "qwen",          label: "Qwen (DashScope)",         protocol: "openai",    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",       envKey: "QWEN_API_KEY",       needsKey: true,  models: ["qwen-max", "qwen-plus"], contextWindow: 131072, keyUrl: "https://bailian.console.aliyun.com/?apiKey=1" },
  { name: "github-models", label: "GitHub Models",            protocol: "openai",    baseUrl: "https://models.inference.ai.azure.com",                   envKey: "GITHUB_TOKEN",       needsKey: true,  models: ["gpt-4o", "gpt-4o-mini"], contextWindow: 128000, keyUrl: "https://github.com/settings/tokens" },
  { name: "huggingface",   label: "Hugging Face",             protocol: "openai",    baseUrl: "https://router.huggingface.co/v1",                        envKey: "HF_TOKEN",           needsKey: true,  models: ["meta-llama/Llama-3.3-70B-Instruct"], contextWindow: 128000, keyUrl: "https://huggingface.co/settings/tokens" },
  { name: "ollama",        label: "Ollama (local, no key)",   protocol: "openai",    baseUrl: "http://localhost:11434/v1",                               envKey: "",                   needsKey: false, models: ["llama3.2", "qwen2.5-coder"], contextWindow: 128000, keyUrl: "" },
  { name: "custom",        label: "Custom OpenAI-compatible", protocol: "openai",    baseUrl: "",                                                        envKey: "CUSTOM_API_KEY",     needsKey: true,  models: [], contextWindow: 128000, keyUrl: "" },
]

export function getCatalog(name) {
  return CATALOG.find((p) => p.name === name) || null
}

export function envKeyFor(name) {
  const c = getCatalog(name)
  if (!c || !c.envKey) return null
  return process.env[c.envKey] || null
}

/**
 * Build a runnable provider object from config + catalog for a given name,
 * WITHOUT any CLI flags (used for failover, where the target is not the one the
 * user named on the command line). Returns null when the provider is not usable
 * (no base URL, or a key is required but missing). Mirrors resolveProvider() in
 * forge.js minus the flag overrides.
 */
export function buildProvider(config, name) {
  if (!name) return null
  const cat = getCatalog(name)
  const conf = config?.providers?.[name] || null
  if (!cat && !conf) return null
  const c = conf || {}
  const protocol = cat?.protocol ?? c.protocol ?? "openai"
  const baseUrl = c.baseUrl || cat?.baseUrl || ""
  const apiKey = c.apiKey || envKeyFor(name) || ""
  const model = c.model || cat?.models?.[0] || ""
  if (!baseUrl) return null
  if (!apiKey && name !== "ollama") return null
  return {
    name, label: cat?.label ?? name, protocol, baseUrl, apiKey, model,
    contextWindow: c.contextWindow ?? cat?.contextWindow ?? 128000, keyUrl: cat?.keyUrl ?? "",
  }
}

/**
 * Ordered list of usable fallback providers (excluding `activeName`), for
 * automatic failover. Health-tested providers come first, then the rest in
 * config order. Every entry is a runnable provider object from buildProvider().
 */
export function fallbackChain(config, activeName, { health = {} } = {}) {
  const names = Object.keys(config?.providers || {}).filter((n) => n && n !== activeName)
  const built = []
  const seen = new Set()
  for (const n of names) {
    if (seen.has(n)) continue
    const p = buildProvider(config, n)
    if (p) { built.push(p); seen.add(n) }
  }
  // stable partition: tested-ok providers first
  const tested = built.filter((p) => health[p.name]?.ok)
  const rest = built.filter((p) => !health[p.name]?.ok)
  return [...tested, ...rest]
}

export class ProviderError extends Error {
  constructor(message, { status, retryable, contextOverflow, retryAfterMs } = {}) {
    super(message)
    this.status = status
    this.contextOverflow = Boolean(contextOverflow)
    this.retryAfterMs = retryAfterMs ?? null
    this.retryable = retryable ?? (status === 429 || status === 408 || status >= 500)
  }
}

/** v20: recognize "context too large" rejections across providers so callers
 *  can compress and retry instead of failing the task. Checked against the
 *  error body BEFORE the ProviderError is thrown (see httpError()). */
const CONTEXT_OVERFLOW_RE = /context (?:length|window)|prompt is too long|too long|exceed(?:s|ed)?.{0,24}(?:context|token|prompt|maximum)|maximum.{0,24}(?:context|token|prompt)|token limit|reduce.{0,24}prompt|input length|input tokens?.{0,20}(?:exceed|limit|long)|context_length_exceeded|prompt_tokens.{0,30}max/i

function isContextOverflow(status, bodyText) {
  if (status !== 400 && status !== 413 && status !== 422) return false
  return CONTEXT_OVERFLOW_RE.test(String(bodyText ?? "").slice(0, 800))
}

/** Build a ProviderError from an HTTP response (shared by both protocols,
 *  streaming and non-streaming). Marks context-overflow + captures
 *  Retry-After for polite backoff. */
async function httpError(res, providerName) {
  const body = await readErrorBody(res)
  const overflow = isContextOverflow(res.status, body)
  const retryAfter = res.headers?.get?.("retry-after")
  let retryAfterMs = null
  if (retryAfter) {
    const sec = Number(retryAfter)
    if (Number.isFinite(sec)) retryAfterMs = Math.min(60, Math.max(0, sec)) * 1000
    else {
      const at = Date.parse(retryAfter)
      if (!Number.isNaN(at)) retryAfterMs = Math.min(60_000, Math.max(0, at - Date.now()))
    }
  }
  const e = new ProviderError(
    `provider HTTP ${res.status}: ${body}${overflow ? " [context too large]" : ""}${hintFor(res.status, providerName)}`,
    { status: res.status, contextOverflow: overflow, retryAfterMs },
  )
  return e
}

/** Human-friendly hint appended to provider HTTP errors. providerName (when
 *  known) adds the exact `forge config set` line + where to get a valid key. */
function hintFor(status, providerName) {
  const cat = providerName ? getCatalog(providerName) : null
  const keyHint = cat?.keyUrl ? ` get a valid key: ${cat.keyUrl}` : ""
  const setLine = providerName ? ` forge config set providers.${providerName}.apiKey <KEY>` : " /key"
  if (status === 401 || status === 403) return ` — API key rejected (${providerName ?? "provider"}).${keyHint} fix:${setLine}`
  if (status === 404) return ` — model or URL not found on ${providerName ?? "provider"} (run: forge models, check providers.${providerName ?? "<name>"}.baseUrl)`
  if (status === 429) return " — rate limited, forge retries automatically"
  if (status === 408) return " — provider timeout, forge retries automatically"
  if (status === 402) return ` — quota/billing exhausted on ${providerName ?? "provider"}.${keyHint}`
  return ""
}

/**
 * Phase guard for one request: aborts if the provider never returns headers
 * (connect) or never sends the first byte (firstbyte), so a dead endpoint
 * can NEVER hang forge forever. Also chains the user's Ctrl+C signal.
 * Node >= 18 compatible (no AbortSignal.any needed).
 */
function makeGuard(signal, connectMs, nextMs, nextName) {
  const ctrl = new AbortController()
  let phase = 0 // 0=connect 1=next 2=done
  let timer = null
  const arm = (ms, name) => {
    clearTimeout(timer)
    // v20: a 0/undefined/negative guard value would fire instantly — clamp
    const safe = Number.isFinite(ms) && ms > 0 ? ms : 60000
    timer = setTimeout(() => {
      if (phase < 2) { phase = 2; try { ctrl.abort(new Error(name)) } catch {} }
    }, safe)
  }
  if (signal) {
    if (signal.aborted) { try { ctrl.abort(signal.reason) } catch {} }
    else signal.addEventListener("abort", () => { try { ctrl.abort(signal.reason) } catch {} }, { once: true })
  }
  arm(connectMs, "connect")
  return {
    signal: ctrl.signal,
    gotHeaders() { if (phase === 0) { phase = 1; if (nextMs) arm(nextMs, nextName || "first-byte"); else { phase = 2; clearTimeout(timer) } } },
    gotData() { if (phase < 2) { phase = 2; clearTimeout(timer) } },
    timedOut() { return phase >= 2 },
    dispose() { clearTimeout(timer) },
  }
}

/** Map an abort during a guarded request to a friendly ProviderError. */
function abortToError(e, guard, connectMs, nextMs, nextName, userAborted) {
  if (userAborted) return e // genuine user Ctrl+C — propagate as-is
  const reason = e?.cause?.message ?? e?.message ?? ""
  if (reason === "connect") return new ProviderError(`provider did not respond within ${connectMs / 1000}s (connect guard)`, { retryable: true })
  if (reason && reason === nextName) {
    return nextName === "request"
      ? new ProviderError(`provider request exceeded ${nextMs / 1000}s (request guard)`, { retryable: true })
      : new ProviderError(`provider sent no data within ${nextMs / 1000}s (first-byte guard)`, { retryable: true })
  }
  // v20.0.1: a raw `TypeError: fetch failed` (offline, DNS, TLS, connection
  // reset) is the single most common provider failure and it used to reach the
  // user verbatim. Report it as what it is, with something to check.
  const cause = e?.cause
  const detail = [cause?.code, cause?.message].filter(Boolean).join(" — ") || reason || e?.name || "network error"
  return new ProviderError(`could not reach the provider (${detail}) — check the base URL, your connection, DNS and TLS`, { retryable: true })
}

/** v20.0.1: an HTML page (wrong base URL, captive portal, proxy interstitial)
 *  answers with HTTP 200 — build an honest, non-retryable error for it. */
function nonJsonError(res, rawText, providerName) {
  const ct = String(res?.headers?.get?.("content-type") ?? "").split(";")[0].trim() || "unknown content-type"
  const sniff = String(rawText ?? "").replace(/\s+/g, " ").trim().slice(0, 100)
  const where = providerName ? `providers.${providerName}.baseUrl` : "the provider baseUrl"
  return new ProviderError(
    `provider returned a non-JSON response (HTTP ${res?.status ?? "?"}, ${ct}): ${sniff || "(empty body)"} — check ${where}. A wrong URL, a proxy, or a captive portal looks exactly like this.`,
    { status: res?.status ?? 0, retryable: false },
  )
}

/** v20.0.1: a stream that dies mid-answer used to surface as "terminated". */
function streamError(e) {
  if (e instanceof ProviderError || e?.name === "AbortError") return e
  return new ProviderError(`stream interrupted before the answer completed (${String(e?.message ?? e)}) — check your connection or the provider`, { retryable: true })
}

async function readErrorBody(res) {
  try {
    const text = await res.text()
    try {
      const j = JSON.parse(text)
      return String(j?.error?.message || j?.error || j?.message || text).slice(0, 400)
    } catch {
      return text.slice(0, 400)
    }
  } catch {
    return ""
  }
}

function headersFor(proto, apiKey) {
  if (proto === "anthropic") {
    const h = { "content-type": "application/json", "anthropic-version": "2023-06-01" }
    if (apiKey) h["x-api-key"] = apiKey
    return h
  }
  const h = { "content-type": "application/json" }
  if (apiKey) h["authorization"] = `Bearer ${apiKey}`
  return h
}

// ---------------------------------------------------------------------------
// Models listing (live fetch, catalog fallback)
// v18: listModels also returns `entries` — full metadata when the provider
// sends it (id, name, context, free) — so pickers can badge FREE models.
// ---------------------------------------------------------------------------
export async function listModels({ protocol, baseUrl, apiKey, catalog }) {
  const proto = protocol || "openai"
  const base = (baseUrl || catalog?.baseUrl || "").replace(/\/$/, "")
  if (!base) return { models: catalog?.models ?? [], live: false }
  try {
    const url = proto === "anthropic" ? `${base}/v1/models?limit=100` : `${base}/models`
    const res = await fetch(url, { headers: headersFor(proto, apiKey), signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = await res.json()
    const arr = j?.data ?? j?.models ?? []
    const entries = arr
      .map((m) => normalizeModelEntry(m))
      .filter((m) => m && m.id)
    const ids = entries.map((m) => m.id).sort()
    if (!ids.length) throw new Error("empty model list")
    return { models: ids, live: true, entries }
  } catch (e) {
    return { models: catalog?.models ?? [], live: false, warning: e.message }
  }
}

/** Normalize one /models entry from any OpenAI-compatible or OpenRouter-style
 *  payload: { id, name?, context_length|context?, pricing? } → { id, name,
 *  context, free }. Free = both prices are exactly "0" or the id ends :free. */
function normalizeModelEntry(m) {
  if (!m || typeof m !== "object") return null
  const id = String(m.id || m.name || "").trim()
  if (!id) return null
  const ctxRaw = m.context_length ?? m.context ?? m.top_provider?.context_length
  const context = Number.isFinite(Number(ctxRaw)) ? Number(ctxRaw) : null
  const price = m.pricing ?? {}
  const pZero = (v) => v !== undefined && Number(v) === 0
  const free = id.endsWith(":free") || (pZero(price.prompt) && pZero(price.completion))
  return { id, name: typeof m.name === "string" ? m.name : "", context, free }
}

// ---------------------------------------------------------------------------
// v18 OpenRouter free-models detection — the /models endpoint on OpenRouter is
// PUBLIC (works without an API key), so the wizard can list every free model
// BEFORE the key step. Never throws; 8s guard; falls back to the caller.
// ---------------------------------------------------------------------------
export const OPENROUTER_FREE_FALLBACK = [
  { id: "deepseek/deepseek-chat-v3-0324:free", name: "DeepSeek V3 (free tier)", context: 163840, free: true },
  { id: "deepseek/deepseek-r1-0528:free", name: "DeepSeek R1 reasoning (free tier)", context: 163840, free: true },
  { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Llama 3.3 70B (free tier)", context: 131072, free: true },
  { id: "qwen/qwen3-235b-a22b:free", name: "Qwen3 235B (free tier)", context: 131072, free: true },
  { id: "google/gemma-3-27b-it:free", name: "Gemma 3 27B (free tier)", context: 96000, free: true },
  { id: "mistralai/mistral-small-3.1-24b-instruct:free", name: "Mistral Small 3.1 (free tier)", context: 128000, free: true },
]

export async function listOpenRouterModels({ baseUrl, apiKey, timeoutMs = 8000 } = {}) {
  const base = (baseUrl || "https://openrouter.ai/api/v1").replace(/\/$/, "")
  try {
    const res = await fetch(`${base}/models`, {
      headers: headersFor("openai", apiKey || ""),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = await res.json()
    const entries = (j?.data ?? j?.models ?? []).map(normalizeModelEntry).filter((m) => m && m.id)
    if (!entries.length) throw new Error("empty model list")
    const free = entries.filter((m) => m.free).sort((a, b) => (b.context ?? 0) - (a.context ?? 0))
    return { live: true, free, all: entries, total: entries.length }
  } catch (e) {
    return { live: false, free: [], all: [], warning: String(e?.message ?? e) }
  }
}

// ---------------------------------------------------------------------------
// Streaming chat — yields {type:"text"|"reasoning"|"usage"|"done", ...}
// ---------------------------------------------------------------------------
export async function* streamChat(opts) {
  const { protocol = "openai", baseUrl } = opts
  const base = (baseUrl || "").replace(/\/$/, "")
  if (!base) throw new ProviderError("no baseUrl configured for this provider")
  if (protocol === "anthropic") yield* streamAnthropic(opts, base)
  else yield* streamOpenAI(opts, base)
}

const BASE_HEADERS = { "user-agent": "forge-agent/19.0.0" }

function mergeHeaders(proto, apiKey, baseUrl) {
  const h = { ...BASE_HEADERS, ...headersFor(proto, apiKey) }
  if (/openrouter\.ai/.test(baseUrl || "")) { h["http-referer"] = "https://github.com/forge-cli"; h["x-title"] = "forge" }
  return h
}

/**
 * Resilient wrapper: retries on transient failures (429 / 5xx / network)
 * BEFORE any text was emitted, so retries never duplicate output.
 */
export async function* streamChatResilient(opts, { attempts = 3, backoffMs = 1500, onRetry } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let emitted = false
    try {
      for await (const ev of streamChat(opts)) {
        if (ev.type === "text" || ev.type === "reasoning" || ev.type === "tool_calls") emitted = true
        yield ev
      }
      return
    } catch (e) {
      const retryable = e instanceof ProviderError ? e.retryable : (e?.name === "AbortError" ? false : true)
      if (!retryable || emitted || attempt >= attempts) throw e
      // v20: honor the provider's Retry-After when present (bounded, polite)
      const wait = Math.max(backoffMs * attempt, e instanceof ProviderError ? (e.retryAfterMs ?? 0) : 0)
      onRetry?.({ attempt, attempts, error: e.message, waitMs: wait })
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

async function* streamOpenAI(opts, base) {
  const { apiKey, model, messages, temperature, maxTokens, signal, connectMs = 30000, firstByteMs = 120000 } = opts
  const body = { model, messages, stream: true }
  if (temperature !== undefined) body.temperature = temperature
  if (maxTokens) body.max_tokens = maxTokens
  // v19 deep think: provider-correct reasoning params, opt-in (deep mode only)
  applyReasoning(body, opts, model, base)
  const guard = makeGuard(signal, connectMs, firstByteMs, "first-byte")
  let res
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: mergeHeaders("openai", apiKey, base),
      body: JSON.stringify(body),
      signal: guard.signal,
    })
  } catch (e) {
    guard.dispose()
    throw abortToError(e, guard, connectMs, firstByteMs, "first-byte", signal?.aborted)
  }
  if (!res.ok) { guard.dispose(); throw await httpError(res, opts.providerName) }
  guard.gotHeaders()
  const tcAcc = new Map() // index -> {id, name, args} — streaming tool-call assembly
  try {
    yield* parseSSE(res, (data) => {
    if (data === "[DONE]") return [{ type: "done", finishReason: "stop" }, { type: "__stop__" }]
    let j
    try { j = JSON.parse(data) } catch { return null }
    const evs = []
    const choice = j?.choices?.[0]
    const d = choice?.delta ?? {}
    const rc = d.reasoning_content ?? d.reasoning
    if (rc) evs.push({ type: "reasoning", text: rc })
    if (d.content) evs.push({ type: "text", text: d.content })
    if (Array.isArray(d.tool_calls)) {
      for (const t of d.tool_calls) {
        const i = t.index ?? 0
        const cur = tcAcc.get(i) ?? { id: "", name: "", args: "" }
        if (t.id) cur.id = t.id
        if (t.function?.name) cur.name = t.function.name
        if (t.function?.arguments) cur.args += t.function.arguments
        tcAcc.set(i, cur)
      }
    }
    if (choice?.finish_reason) evs.push({ type: "done", finishReason: choice.finish_reason })
    if (j?.usage) evs.push({ type: "usage", usage: j.usage })
    return evs
  }, guard)
    if (tcAcc.size) {
      const calls = [...tcAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
      yield { type: "tool_calls", calls }
    }
  } catch (e) {
    // v20.0.1: a stream cut mid-answer surfaced as a bare "terminated"
    throw streamError(e)
  } finally { guard.dispose() }
}

async function* streamAnthropic(opts, base) {
  const { apiKey, model, temperature, maxTokens, signal, connectMs = 30000, firstByteMs = 120000 } = opts
  const conv = toAnthropicMessages(opts.messages ?? [])
  const system = opts.system || conv.system
  const messages = conv.messages
  const body = { model, messages, max_tokens: maxTokens || 8192, stream: true }
  if (system) body.system = system
  if (Array.isArray(opts.tools) && opts.tools.length) body.tools = opts.tools.map(toAnthropicTool)
  if (temperature !== undefined) body.temperature = temperature
  // v19 deep think: extended thinking budget (deep mode only)
  if (opts.deep) body.thinking = { type: "enabled", budget_tokens: Math.min(8000, Math.max(1024, (maxTokens || 16384) >> 2)) }
  const guard = makeGuard(signal, connectMs, firstByteMs, "first-byte")
  let res
  try {
    res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: mergeHeaders("anthropic", apiKey, base),
      body: JSON.stringify(body),
      signal: guard.signal,
    })
  } catch (e) {
    guard.dispose()
    throw abortToError(e, guard, connectMs, firstByteMs, "first-byte", signal?.aborted)
  }
  if (!res.ok) { guard.dispose(); throw await httpError(res, opts.providerName) }
  guard.gotHeaders()
  const tcAcc = new Map() // block index -> {id, name, args}
  try {
    yield* parseSSE(res, (data) => {
    let j
    try { j = JSON.parse(data) } catch { return null }
    const evs = []
    if (j?.type === "content_block_start" && j?.content_block?.type === "tool_use") {
      tcAcc.set(j.index ?? 0, { id: j.content_block.id ?? "", name: j.content_block.name ?? "", args: "" })
    } else if (j?.type === "content_block_delta") {
      const d = j.delta || {}
      if (d.type === "text_delta" && d.text) evs.push({ type: "text", text: d.text })
      if (d.type === "thinking_delta" && d.thinking) evs.push({ type: "reasoning", text: d.thinking })
      if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
        const cur = tcAcc.get(j.index ?? 0)
        if (cur) cur.args += d.partial_json
      }
    } else if (j?.type === "message_delta") {
      if (j?.usage) evs.push({ type: "usage", usage: { prompt_tokens: j.usage.input_tokens, completion_tokens: j.usage.output_tokens } })
      if (j?.delta?.stop_reason) evs.push({ type: "done", finishReason: j.delta.stop_reason })
    } else if (j?.type === "message_start" && j?.message?.usage) {
      evs.push({ type: "usage", usage: { prompt_tokens: j.message.usage.input_tokens } })
    } else if (j?.type === "error") {
      evs.push({ type: "error", error: j?.error?.message || "provider error" })
    }
    return evs
  }, guard)
    if (tcAcc.size) {
      const calls = [...tcAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
      yield { type: "tool_calls", calls }
    }
  } catch (e) {
    throw streamError(e)
  } finally { guard.dispose() }
}

/** Generic SSE reader — parseLine(data) returns an array of events (or null). */
async function* parseSSE(res, parseLine, guard) {
  if (!res.body) throw new ProviderError("provider returned empty body")
  const decoder = new TextDecoder()
  let buf = ""
  for await (const chunk of res.body) {
    guard?.gotData()
    buf += decoder.decode(chunk, { stream: true })
    let idx
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, "")
      buf = buf.slice(idx + 1)
      if (!line.startsWith("data:")) continue
      const events = parseLine(line.slice(5).trim())
      if (events && events.length) {
        for (const ev of events) {
          if (ev.type === "__stop__") return
          yield ev
        }
      }
    }
  }
}

/**
 * Convert internal (OpenAI wire format) message history to the Anthropic wire:
 *  - role:"system"  -> top-level system string (the real API rejects system
 *    roles inside the messages array — a latent v14 bug this fixes)
 *  - assistant {tool_calls:[...]} -> content blocks [{type:"tool_use",...}]
 *  - role:"tool" -> user message with [{type:"tool_result",...}]
 *  - drops empty text blocks (Anthropic rejects them)
 *  - already-anthropic-shaped blocks pass through unchanged
 */
export function toAnthropicMessages(messages) {
  let system = ""
  const out = []
  for (const m of messages) {
    if (!m) continue
    if (m.role === "system") {
      system = system ? system + "\n\n" + String(m.content ?? "") : String(m.content ?? "")
      continue
    }
    if (m.role === "tool") {
      out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: String(m.content ?? "") }] })
      continue
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const blocks = []
      const text = String(m.content ?? "")
      if (text) blocks.push({ type: "text", text })
      for (const tc of m.tool_calls) {
        let input = {}
        try { input = JSON.parse(tc.function?.arguments ?? "{}") } catch {}
        blocks.push({ type: "tool_use", id: tc.id ?? "", name: tc.function?.name ?? "", input })
      }
      out.push({ role: "assistant", content: blocks })
      continue
    }
    if (m.role === "assistant" && Array.isArray(m.content)) {
      // already anthropic-shaped (tool_use / tool_result blocks) — pass through
      out.push(m)
      continue
    }
    out.push({ role: m.role === "user" ? "user" : "assistant", content: String(m.content ?? "") })
  }
  return { system, messages: out }
}

// ---------------------------------------------------------------------------
// Non-streaming chat with tool support (agent mode)
// Returns { content, reasoning, toolCalls:[{id,name,args}], usage, finishReason }
// ---------------------------------------------------------------------------
export async function chatOnce(opts) {
  const { protocol = "openai", baseUrl, apiKey, model, messages, tools, temperature, maxTokens, signal, system, connectMs = 30000, requestTimeoutMs = 180000 } = opts
  const _deep = opts.deep
  const base = (baseUrl || "").replace(/\/$/, "")
  if (!base) throw new ProviderError("no baseUrl configured for this provider")
  const isAnthropic = protocol === "anthropic"

  let url, body
  if (isAnthropic) {
    const conv = toAnthropicMessages(messages ?? [])
    url = `${base}/v1/messages`
    body = { model, messages: conv.messages, max_tokens: maxTokens || 8192 }
    const sys = system || conv.system
    if (sys) body.system = sys
    if (tools?.length) body.tools = tools.map(toAnthropicTool)
    if (temperature !== undefined) body.temperature = temperature
    if (_deep) body.thinking = { type: "enabled", budget_tokens: Math.min(8000, Math.max(1024, (maxTokens || 16384) >> 2)) }
  } else {
    url = `${base}/chat/completions`
    // v17 fix: the OpenAI wire dropped the separate `system` opt entirely —
    // compaction summaries were sent WITHOUT their instruction on this protocol.
    const msgs = system ? [{ role: "system", content: system }, ...(messages ?? [])] : (messages ?? [])
    body = { model, messages: msgs }
    if (tools?.length) body.tools = tools
    if (temperature !== undefined) body.temperature = temperature
    if (maxTokens) body.max_tokens = maxTokens
    applyReasoning(body, { deep: _deep }, model, base)
  }

  // guard: connect phase + overall request phase — never hang forever
  const guard = makeGuard(signal, connectMs, requestTimeoutMs, "request")
  let res
  try {
    res = await fetch(url, { method: "POST", headers: mergeHeaders(protocol, apiKey, base), body: JSON.stringify(body), signal: guard.signal })
  } catch (e) {
    guard.dispose()
    throw abortToError(e, guard, connectMs, requestTimeoutMs, "request", signal?.aborted)
  }
  if (!res.ok) { guard.dispose(); throw await httpError(res, opts.providerName) }
  guard.gotHeaders()

  // v20.0.1: read the body as TEXT first. `res.json()` used to throw a bare
  // SyntaxError on an HTML error page (proxy / captive portal / wrong base URL),
  // which surfaced to the user as "Unexpected token '<'". Now the response is
  // inspected and reported as an honest, actionable provider error.
  let raw
  try {
    raw = await res.text()
  } catch (e) {
    guard.dispose()
    throw abortToError(e, guard, connectMs, requestTimeoutMs, "request", signal?.aborted)
  }
  guard.dispose()
  let j
  try {
    j = JSON.parse(raw)
  } catch {
    throw nonJsonError(res, raw, opts.providerName)
  }
  if (isAnthropic) {
    let content = "", reasoning = ""
    const toolCalls = []
    for (const block of j?.content ?? []) {
      if (block.type === "text") content += block.text
      else if (block.type === "thinking") reasoning += block.thinking ?? ""
      else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, args: JSON.stringify(block.input ?? {}) })
    }
    return { content, reasoning, toolCalls, usage: { prompt_tokens: j?.usage?.input_tokens, completion_tokens: j?.usage?.output_tokens }, finishReason: j?.stop_reason }
  }
  const m = j?.choices?.[0]?.message ?? {}
  return {
    content: m.content ?? "",
    reasoning: m.reasoning_content ?? m.reasoning ?? "",
    toolCalls: (m.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc?.function?.name, args: tc?.function?.arguments ?? "{}" })),
    usage: j?.usage,
    finishReason: j?.choices?.[0]?.finish_reason,
  }
}

/**
 * v19 deep think — wire-correct reasoning params, applied ONLY when the caller
 * opts in (deep mode). OpenRouter gets `reasoning.effort`, OpenAI o-series/gpt-5
 * style models get `reasoning_effort`; everyone else just gets the deep system
 * directives (harmless, no unknown-field rejections).
 */
function applyReasoning(body, opts, model, base) {
  if (!opts.deep) return
  if (/openrouter\.ai/i.test(base || "")) body.reasoning = { effort: "high" }
  else if (/^(o\d|gpt-5)/i.test(model || "")) body.reasoning_effort = "high"
}

/** Convert OpenAI tool def → anthropic tool def. */
function toAnthropicTool(t) {
  const f = t.function ?? t
  return { name: f.name, description: f.description ?? "", input_schema: f.parameters ?? { type: "object", properties: {} } }
}

// ---------------------------------------------------------------------------
// Doctor probe — measure TTFB against a provider (tiny "ping" completion)
// ---------------------------------------------------------------------------
export async function probe({ protocol, baseUrl, apiKey, model, signal }) {
  const base = (baseUrl || "").replace(/\/$/, "")
  const t0 = Date.now()
  try {
    let res
    if (protocol === "anthropic") {
      res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: headersFor("anthropic", apiKey),
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
        signal: signal ?? AbortSignal.timeout(12000),
      })
    } else {
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: headersFor("openai", apiKey),
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
        signal: signal ?? AbortSignal.timeout(12000),
      })
    }
    const raw = await res.text().catch(() => "")
    const ms = Date.now() - t0
    if (!res.ok) {
      const detail = await readErrorBody(res).catch(() => "")
      return { ok: false, ms, status: res.status, error: (detail || raw).slice(0, 120) }
    }
    // v20.0.1: an HTML page (wrong baseUrl / captive portal / proxy) answers
    // HTTP 200 — doctor used to report that as a WORKING provider and stamped
    // a "✓ tested" badge on it. Verify the body really is a provider response.
    const body = String(raw ?? "").trim()
    if (body.startsWith("data:")) return { ok: true, ms } // SSE provider
    let parsed = null
    try { parsed = JSON.parse(body) } catch {}
    if (!parsed || typeof parsed !== "object") {
      const sniff = body.replace(/\s+/g, " ").slice(0, 80)
      return { ok: false, ms, status: res.status, error: `unexpected response (${sniff || "empty body"}) — check baseUrl, it did not answer like a chat-completions API` }
    }
    if (parsed.error) {
      return { ok: false, ms, status: res.status, error: String(parsed.error?.message ?? parsed.error).slice(0, 120) }
    }
    return { ok: true, ms }
  } catch (e) {
    // v20.0.1: "fetch failed" / "The operation was aborted due to timeout" are
    // not actionable — name the real cause.
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      return { ok: false, ms: Date.now() - t0, error: `no response within 12s — check the base URL and your connection` }
    }
    const cause = e?.cause
    const detail = [cause?.code, cause?.message].filter(Boolean).join(" — ") || String(e?.message ?? e)
    return { ok: false, ms: Date.now() - t0, error: detail.slice(0, 120) }
  }
}
