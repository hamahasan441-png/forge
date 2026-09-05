# forge v17 "SMARTSTART" — plan

## Evidence from the field (user Termux screenshots, v16)

1. **Wizard gap-error (the headline bug)**: the first-run wizard reliably dies right
   after `? API key: (input hidden)` — no model step, no save, silent return to shell.
   `forge doctor` then reports `config: missing`. Root causes in v16 `onboard.js`:
   - `askHidden()` hand-rolls raw-mode stdin + `rl.pause()` — fragile across
     Termux/proot/busybox line disciplines; any hiccup there can hang or lose the
     resolve, and nothing was ever caught.
   - The wizard had **no top-level error handler**: any throw after that point was
     silent (main().catch only catches if the promise rejects — a lost resolve just
     ends the process).
   - Config was saved **once, at the very end** — any interruption = nothing saved.
2. **Confusing custom-provider flow**: the user picked `18 (custom)` and answered the
   `base URL` prompt with `Openrouter` (a provider NAME, not a URL). v16 accepted the
   garbage and later failed confusingly. Users think in provider names first.
3. **Wrong step order**: users want provider → model → API key (key LAST, right before
   the verify step, so a paste mistake is immediately catchable). v16 asked key first.
4. **No API-key documentation**: nothing told the user WHERE to get a key per provider.

## v17 goals

### A. Bulletproof onboarding (`forge` / `forge onboard`)
- **New step order**: provider → base URL (custom only) → model → API key → verify →
  skills → save. Key is entered immediately before verification.
- **Safe hidden input**: replace raw-mode handling with a muted-output readline
  question (no raw-mode handoff — works identically on Termux/proot/SSH).
- **Incremental save**: config is written after EVERY completed step (provider picked,
  model picked, key set). Even a hard kill mid-wizard leaves a usable config.
  Fixes "doctor: config missing" forever.
- **Top-level guard**: the whole wizard runs in try/catch; on any error it prints the
  step it died on + saves everything collected so far + tells how to resume.
- **Per-provider key docs**: catalog carries `keyUrl`; wizard prints
  `get a key: <url>` and env-var name before the key step.
- **Any model, easily**: model step shows ★ tested defaults + recent models + live
  fetched list (when a key/env is already available) and ALWAYS accepts a typed
  model id. Picked models are remembered in `providers.<name>.models[]` (max 8).
- **Custom provider smart URL**: typing a known provider name (e.g. `openrouter`)
  auto-fills its real endpoint; accepts host without scheme; validates and re-asks
  with a concrete example on garbage.
- **Verify loop that cannot dead-end**: probe after key entry; on failure print a
  precise diagnosis (401 → key rejected + keyUrl, 404 → model unknown + "forge
  models", network → URL/host) and offer [retry] [change url] [change key]
  [change model] [save anyway] [quit] — no silent failure path exists.

### B. SmartStart — bare `forge` just works
- No provider configured → wizard.
- Provider configured → a one-line model chooser (Enter = default):
  recent + tested models (✓ badge from the health cache written by probes),
  type any id to switch. Non-TTY/piped: no prompt at all, default model starts.
  Then chat starts with ALL 17 tools + skills ON automatically.
- Single known model + non-interactive → starts instantly (zero questions).

### C. `forge config` becomes an interactive hub
- TTY `forge config` (no sub) opens a menu: add/update provider (the wizard steps),
  switch active provider, change default model, update API key, show masked config,
  test connection. Piped stdin works (deterministic). All existing subcommands
  (show/path/get/set/unset) unchanged and still work.

### D. Token-reduction engine ("best token reducing skill")
- Catalog now carries realistic `contextWindow` per provider (config override:
  `providers.<name>.contextWindow`).
- Chat auto-compaction trigger upgraded: fires on chars OR on est. tokens > 55% of
  the model context window.
- NEW: **agent-loop auto-compaction** — long `forge agent` runs summarize their
  middle history (keep system + first user + recent tail) and keep going instead of
  silently growing context until the provider rejects.
- NEW `/tokens` chat command: context gauge bar (used vs window), session totals,
  est. cost when priceIn/priceOut set.
- `/model x` and SmartStart/wizard picks push into `providers.<name>.models[]`.

### E. No-gap / no-error hardening
- Global `unhandledRejection` + `uncaughtException` handlers print a friendly error
  (+ `forge doctor` hint) — a crash can never again be silent.
- Provider HTTP errors now name the provider and its keyUrl on 401/403.
- `forge doctor` records probe results to `~/.forge/health.json` (the ✓ tested badge
  source for SmartStart) and shows the context window per provider.

## Non-goals
- No new tools in v17 (17 is the set; polish over expansion).
- No dependency added — still zero-dep Node ≥ 18 ESM.

## Verification plan
- E2E battery extended 107 → ~135 checks, including: piped wizard full flow saves a
  working config (the screenshot regression), wizard EOF mid-flow still saves partial
  config, custom name-shortcut URL, config menu piped, SmartStart non-TTY auto-start,
  /tokens output, agent compaction trigger, model recents, health cache.
- Clean-room install from the exact zip (foreign cwd), doctor --tools, packaged zip
  hygiene (unzip -t, no qa pollution).
