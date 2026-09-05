# forge v18 "FREESTART" — plan

User ask (decoded): "make v18 smarter, easier, more professional; detect OpenRouter
ALL free models FIRST; add the option to add a model manually/custom after choosing
OpenRouter."

v17 baseline: 139/139 E2E, clean-room 24/24, wizard saved-at-every-step, SmartStart,
config menu, token reduction. v18 builds on top of it — no regressions allowed.

## F1 — OpenRouter free-models detection FIRST (the headline feature)

- `listOpenRouterModels({ baseUrl, apiKey? })` in providers.js:
  - GET `{baseUrl}/models` — PUBLIC on OpenRouter (no key required), so free-model
    detection runs BEFORE the API-key step (order stays: provider → model → key).
  - Parses the OpenRouter-style payload: `data[].{ id, name, context_length,
    pricing:{ prompt, completion } }`.
  - FREE rule: `String(pricing.prompt) === "0" && String(pricing.completion) === "0"`
    OR id ends with `:free`.
  - Free models sorted by context_length desc (biggest context first).
  - Short 8s timeout, never throws — returns `{ live, free: [...], all: [...], warning }`.
- Wizard: when the chosen provider is `openrouter`, the model step becomes
  **free-first**: all detected free models are listed at the TOP with a green
  `FREE` badge + context size (`~128k tok`), then ★ tested defaults, then ● personal
  recents, then paid live models — then the manual entry line (F2).
- Fallback chain (no fail, no gap): live fetch → `~/.forge/models-cache.json`
  (last good list, marked "cached") → curated built-in free list (marked
  "offline suggestions") → manual entry. The wizard can NEVER stall here.
- Also works for OpenRouter-compatible proxies: free detection uses
  `providers.openrouter.baseUrl`, so pointing it at a proxy auto-detects against it.

## F2 — Manual / custom model add (explicit, discoverable)

- Model picker (EVERY provider, not just OpenRouter) ends with an explicit line:
  `[m] enter a model id manually` — choosing `m` prompts for any id, validated
  non-empty, always accepted (same as free-typed text, but now discoverable).
- Free-typed ids keep working exactly as in v17 (back-compat with all flows).

## F3 — `forge models [provider] [--free]`

- `forge models` upgrades: optional provider NAME argument (no need to switch
  active provider first), and `--free` to show only free models with context
  sizes — live when reachable, cache when offline (marked).
- Successful live fetches refresh the model cache.

## F4 — SmartStart gets FREE badges

- Bare `forge` model line: cached free models for the active provider are shown
  first with a `FREE` badge (cache-only — startup stays instant, zero network).
- Health `✓ tested` badges unchanged.

## F5 — Professional docs

- forge README.md: new "OpenRouter free models" section + per-provider API-key
  table (env var + key URL + wire protocol) — the "good API documentation" ask.
- help text + PACKAGE_INFO updated; version 18.0.0 everywhere (UA included).

## Mock + E2E

- mock-llm.mjs `/models` returns OpenRouter-style metadata: `mock-mini` FREE
  (context 128000), `mock-large` paid, `mock-coder` paid, `mock-vision:free` FREE
  (context 300000). Legacy `{id}` consumers unaffected.
- New E2E checks (~18): `forge models openrouter --free` (live FREE badge +
  context + cache write), cache file contents, piped wizard on openrouter
  (base → mock) picks the FREE model first, manual `[m]` entry saves a custom id,
  offline fallback wizard still completes, `models <provider>` by name,
  free-first order, version/banner bumps. Existing 139 keep green.

## Packaging

- scripts/cleanroom-v18.sh (adapted from v17 + a free-models check),
  package-cli.sh → download/agentv18.zip (rm -f, pollution guard, unzip -t,
  no secrets, single START COMMAND), worklog + English report.
