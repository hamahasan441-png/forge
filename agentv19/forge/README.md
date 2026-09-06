# ⬢ forge — standalone terminal AI agent (v20 "PRODUCTION")

One binary folder, zero dependencies, pure Node.js. **No web app, no server, no localhost.**
Chat and a tool-using coding agent run directly against your AI provider from any terminal.

```bash
bash install.sh      # or: cd forge && npm i -g .
forge                # first run: setup wizard — then it just starts
```

## New in v20 "PRODUCTION" — hardening, memory, resume

- **Shell safety engine** — every command (agent bash AND terminal-in-chat) is
  structurally parsed and risk-classified: `block` (root wipe, mkfs, dd to raw
  devices, fork bombs, shutdown, redirects over `/etc/passwd` — always refused),
  `danger` (destructive outside the project / credentials — refused for the model,
  y/N for you), `confirm` (rm, git reset --hard, installs — y/N on a TTY;
  `FORGE_ASSUME_YES=1` when piped). Path-aware: `rm -rf node_modules` inside your
  project works, `rm -rf ~/.ssh` never does. No more regex-only blocking.
- **Project boundary for writes** — write_file/edit/multi_edit/apply_patch cannot
  escape your working directory (`../`, absolute paths, and SYMLINK escapes are all
  caught). Reads outside the project are allowed, but sensitive files
  (`.env`, `.ssh`, keys, credentials, `~/.forge/config.json`) are protected from
  the model. `tools.allowOutsideProject: true` opts out.
- **SSRF guard** — fetch_url resolves the hostname and validates EVERY address
  (loopback, private ranges, CGNAT, link-local + cloud metadata, IPv6 ULA /
  IPv4-mapped) — DNS-rebinding safe. Local stacks (Ollama, SearXNG) opt in with
  `tools.fetchPrivateUrls: true` or `FORGE_ALLOW_PRIVATE_URLS=1`.
- **Secret redaction** — tool results, memory writes, and terminal notes shared
  with the model are scrubbed (sk-/AKIA/ghp_/xox/AIza/JWTs/private keys +
  `KEY=value` patterns). Your terminal still shows real output; the model never
  sees raw credentials, and sessions never store them.
- **Hierarchical memory** — global (`~/.forge/memory.md`) + per-project
  (`~/.forge/projects/<hash>/memory.md`) tiers, retrieved by RELEVANCE to the
  current task (scored, deduped — never a full dump), plus structured failure
  learning (`memory action=learn`) so past fixes are retrievable by symptom.
- **Project profile** — languages, package manager, test/build/lint commands,
  git branch, frameworks detected once and cached (`~/.forge/projects/<hash>/profile.json`),
  refreshed on repo change, injected compactly into agent context.
- **Sessions that actually resume** — sessions store cwd + title + rolling
  summary + usage; `forge resume <n|id>` (and `/resume`, `--resume`) restore the
  conversation AND the working directory.
- **Context-overflow recovery** — a 400 "context too large" response triggers
  shrink + compact + bounded retry instead of killing the task. The session is
  persisted before any failure — work is never lost.
- **Effort profiles** — `--profile fast|balanced|deep|auto` (and `/profile`):
  `auto` classifies each task and gives complex/critical ones deep thinking
  (announced — model switches are never silent).
- **Undo now removes created files** — checkpoints track file CREATIONS
  (hash-verified), so `forge undo` after an apply_patch that created + modified
  files restores both atomically.
- **Delegate upgrades** — read-only sub-agents get roles
  (researcher/reviewer/tester/security/coder), a timeout
  (`agent.delegateTimeoutSec`), a concurrency cap (resource-aware: 1 on
  low-RAM devices), and plan mode can delegate research (depth still capped at 2).
- **Terminal UX** — persistent command history (`~/.forge/history`, arrow keys
  across sessions), backslash multiline input, `/status` snapshot, resize-aware
  output, and `forge doctor` now reports platform/RAM/cores/terminal/git/project
  profile + writable-state checks.
- **Skills path hardening** — skill names are validated (no `../` traversal),
  and the skills dir resolution bug that could pick a foreign `skills/` folder
  from a parent directory is fixed.

## First run — the wizard (v17: saved at EVERY step • v18: free models FIRST)

`forge` asks once, in this order:
1. **Choose provider** — 18 built-in: openai, anthropic, zai, deepseek, groq, openrouter,
   gemini, mistral, xai, together, cerebras, nvidia, siliconflow, qwen, github-models,
   huggingface, ollama (local), custom (any OpenAI-compatible URL)
2. **Choose model** — for **OpenRouter** forge now auto-detects **ALL free models first**
   via the public `/models` endpoint (no key needed yet) and lists them at the TOP with a
   green `FREE` badge + context size; then ★ tested defaults, your recents, live models —
   and an explicit **`[m] enter a model id manually`** line for any custom id (every provider)
3. **API key** — entered last, with the exact URL where to get one shown inline
   (hidden input, saved chmod 600)
4. **Test connection** — a live probe verifies key + URL + model right now;
   if it fails you get a precise diagnosis and `[r]etry [u]rl [k]ey [m]odel [s]ave [q]uit`
5. **Enable all 69 skills?** — Enter = yes

**Nothing can be lost anymore:** the config is written to disk after *every* step, the
hidden input no longer uses fragile raw-mode handling (the v16 Termux bug), and if
anything unexpected happens the wizard prints exactly where it stopped — with
everything you entered already saved.

For **custom** providers you can literally type a provider NAME at the URL prompt
(e.g. `openrouter`) and the real endpoint is filled in for you.

Everything is stored in **`~/.forge/config.json`** — the single config file:

```json
{
  "activeProvider": "openai",
  "providers": {
    "openai": { "apiKey": "sk-...", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini", "models": ["gpt-4o-mini"] }
  },
  "skills": { "enabled": true, "dir": "" },
  "agent": { "maxSteps": 25, "timeoutSec": 45 },
  "chat":  { "stream": true }
}
```

Edit it any time, or use commands: `forge config set providers.openai.apiKey sk-...`

## Daily use

| command | what it does |
|---|---|
| `forge` | **AutoPick** (v19): the best working model is picked automatically — zero questions — and chat starts with all tools + skills ON. `forge --pick` = the classic chooser (Enter = default, ✓ tested / FREE badges) |
| `forge ask "summarize git log"` | quick one-shot answer (pipes too: `echo q \| forge ask`) |
| `forge chat -m "explain git rebase"` | one-shot answer |
| `forge chat --continue` | resume last session |
| `forge resume <n\|id>` | resume a saved session — messages + working directory + usage (v20) |
| `forge --profile fast\|balanced\|deep\|auto` | effort profile: auto gives complex tasks deep thinking (v20) |
| `forge agent "fix the failing test"` | autonomous coding agent — auto-uses all **17 tools** (bash, files, patches, git, web search+fetch, todo, memory, sub-agent, 69 skills); add `--deep` for deep think |
| `forge agent --deep "task"` | DEEP THINKING agent — structured reasoning, high reasoning effort, verify-first |
| `forge agent --plan "task"` | plan first (read-only), confirm, then execute |
| `forge undo` | restore files changed by the last tool edit (auto-checkpoints; v20 also removes files the edit CREATED) |
| `forge undo --run` | roll back an ENTIRE agent run atomically — every checkpoint from that run, newest→oldest (v20.2) |
| `forge agent "task" --cwd /path/to/project` | run agent in a project |
| `forge config` | **interactive config menu**: add provider → model → key, switch, test |
| `forge config set providers.openai.apiKey sk-...` | direct config editing (also: show/path/get/unset) |
| `forge use deepseek --model deepseek-chat` | switch provider and model in one line |
| `forge doctor` | config check + provider latency + ✓ tested badge (`--all` every provider, `--tools` self-tests all 17 tools) |
| `forge sessions` | list saved conversations |
| `forge models [provider]` | list models of any provider (FREE badges + context sizes, no switch needed) |
| `forge models openrouter --free` | **OpenRouter free tier only** — live, or cached when offline |
| `forge models` / `forge providers` | list models / providers |
| `forge skills` / `forge skills pdf` | list skills / read one |
| `forge skills --check` | validate every skill: name, description, broken relative links, size budget (v20.2) |
| `forge memory list\|add\|forget <n>\|clear\|prune` | inspect and curate long-term memory (`--project` / `--all`) (v20.2) |
| `forge plan list\|show\|apply <n\|slug>` | saved plans from `agent --plan` — review one, or execute it later (v20.2) |
| `forge plugins` | list user tool plugins from `~/.forge/tools/*.mjs` (+ why any were skipped) (v20.2) |
| `forge sessions --search "text"` | find a past conversation by title, summary or message content (v20.2) |
| any data command `--json` | machine-readable output for scripting: sessions, models, plugins, skills --check, memory list (v20.2) |

Inside chat: `/help` `/status` `/profile` `/tools` `/shell` `/deep` `/plan` `/compact` `/tokens` `/usage` `/retry` `/undo` `/export` `/sessions` `/resume` `/model` `/key` `/skills` `/agent` `/save` `/new` `/stream` `/config` — end a line with `\` for multiline input

v20.4 adds: `/tasks` `/checkpoints` `/diff [file]` `/undo --run [RUN-xxxx]` `/details [N]` `/agents` `/verify [cmd]` `/memory` `/settings` `/clear` `/normal` — Tab completes commands, typos get a hint.

## The terminal workstation (v20.4)

Interactive `forge chat` (and `forge agent` in a terminal) is a state-driven
console, not a scrolling log:

```
FORGE  AGENT  RUN-4F2A  ● EXECUTING 50%  02:41  openai/gpt-4o
TASK   Refactor authentication system
PLAN   ✓ Inspect architecture  ✓ Map dependencies  ● Refactor auth  ○ Run tests
ACTIVITY
  ✓ read   src/auth/session.js            400ms
  ● shell  npm test                       running
forge [agent] ❯ █
```

- **Header** — mode (CHAT/AGENT/PLAN/RECOVERY), short run id, state
  (READY · THINKING · PLANNING · EXECUTING · VERIFYING · RECOVERING · WAITING ·
  COMPLETED · FAILED · CANCELLED), elapsed time. It adapts to width: 40 columns
  shows `● EXECUTING 50%`, 80 adds a one-line summary, 100+ the full dashboard.
  Progress is only ever real plan items done/total — never a guess.
- **Input** — cursor keys, Home/End, Ctrl+A/E/K/U/W/Y, Backspace/Delete that
  understand emoji and CJK, ↑↓ history (prefix-aware), Ctrl+R reverse search,
  Tab completion, multiline (`\` at end of line or Alt+Enter). Pasting is
  bracketed: a 300-line paste is inserted as one block and submitted once,
  never executed line by line. Streaming output never corrupts what you type —
  the draft and cursor are restored after every frame.
- **Tool rows** — `✓ shell  npm test  1.2s` with exit code; large outputs are
  collapsed to a line count + error lines; `/details` expands.
- **Changes & checkpoints** — `/diff` shows a real unified diff of the run,
  `/checkpoints` lists snapshots, `/undo --run RUN-xxxx` rolls a whole run back.
- **Honest cancel** — Ctrl+C shows `Stopping… waiting for current tool to
  terminate`, then `✓ execution stopped safely` only once it actually has.
- **Crash-safe** — every write run is journaled in `~/.forge/runs/`. If Forge
  died mid-run, the next start shows `FORGE RECOVERY` with
  `[R]esume [V]erify [U]ndo [C]ancel` — nothing is replayed silently.
  `/tasks` lists past runs and their status.
- **Terminals & accessibility** — `NO_COLOR`, `FORGE_ASCII=1` (ASCII glyphs),
  `FORGE_A11Y=1` (`SUCCESS:`/`ERROR:`/`ACTIVE:` labels instead of symbols),
  `/settings` to persist dock/thinking/ascii/a11y/collapse. Meaning is never
  carried by colour alone. `FORGE_UI=plain` restores the classic line output;
  piped/non-TTY use is unchanged.

## New in v19 "TERMINAL"

- **Terminal-in-chat** — type Linux commands as chat lines and they EXECUTE right there,
  in the folder you started forge from: `ls`, `pwd`, `cat notes.md`, `git status`,
  `python x.py`, `npm test`, `mkdir build`… The output is drawn in a terminal block in
  the SAME chat. `!` forces (`!git push`), and a natural sentence like
  "find the bug in this code" still goes to the AI.
- **Session shell state** — `cd` moves your session working directory, `export K=V`
  persists into every later command, `history` replays, `clear` clears — like a real shell.
- **The AI sees your terminal** — every command + trimmed output is shared with the model
  on your next message, so you can run things and then just ask "what did that print?".
- **Safe (v20)** — the shellguard risk engine classifies every typed command:
  catastrophic ones are always refused with the reason; risky ones ask y/N first
  (`FORGE_ASSUME_YES=1` for scripts). `/shell off` disables auto-detect; the `!`
  prefix always works. Terminal notes shared with the model are secret-redacted.
- **Deep think (`--deep` / `/deep`)** — big-model reasoning: structured
  understand → consider → plan → answer → verify directives, provider-correct reasoning
  params (OpenRouter `reasoning.effort: high`, OpenAI o-series/gpt-5 `reasoning_effort:
  high`, Anthropic extended `thinking` budget), bigger token budgets and more tool rounds.
- **AutoPick** — bare `forge` picks the best working model with zero questions:
  your configured default → health-tested ✓ → best cached FREE model → catalog default.
  One dim line says what was picked; `--pick` brings back the chooser.
- **Tiered long-context reduction** — before any lossy summary, big OLD tool outputs are
  shrunk to stubs (full history kept, ~40% window trigger); summarize only fires if
  still over budget (~55%). Chat and agent both. Long sessions keep their facts.
- **Faster startup** — the onboarding/menu module now loads only when a wizard actually
  runs (lazy import); the everyday path skips it entirely.

## New in v18 "FREESTART"

- **OpenRouter free models FIRST** — choosing OpenRouter auto-detects every free model
  (pricing `0/0` or id ending `:free`) through the PUBLIC `/models` endpoint — **before**
  any API key is entered. Free models are listed at the top with `FREE` badge + context
  size, sorted biggest-context-first. Picking one = a $0 start.
- **Never stalls on detection** — fallback chain: live fetch → `~/.forge/models-cache.json`
  (last good list, marked *cached*) → curated built-in free list (marked *offline
  suggestions*) → manual entry. Offline, rate-limited, behind a proxy — the wizard always
  completes.
- **Manual / custom model add** — the model picker ends with an explicit
  `[m] enter a model id manually` line for EVERY provider (v17 accepted free-typed ids;
  v18 makes the option visible). Any format works: `vendor/model`, `vendor/model:variant`.
- **`forge models [provider] [--free]`** — list models for any provider without switching;
  `--free` filters the free tier with context sizes; live fetches refresh the model cache.
- **SmartStart FREE badges** — bare `forge` marks cached free models with `FREE` next to
  the ✓ tested badges (cache-only, startup stays instant).
- **OpenRouter-compatible proxies** — free detection uses `providers.openrouter.baseUrl`,
  so pointing it at a proxy/auto-aggregator detects against that endpoint instead.

## New in v17

- **Bulletproof wizard** — the v16 hidden-key input died silently on Termux/proot and
  left no config. v17: no raw-mode handling, incremental saves after every step,
  top-level error guard that keeps partial progress, SIGINT that exits gracefully.
- **New step order** — provider → model → API key → verify → skills.
- **API docs inline** — every provider shows its "get a key" URL + env var name.
- **Any model, easily** — type any model id at the model step; every model you pick is
  remembered per provider (`providers.<name>.models[]`) and offered again.
- **Smart custom URLs** — type `openrouter` (or any known provider name) at the URL
  prompt; scheme-less hosts get `https://`.
- **Verify-recovery loop** — probe failures print the exact cause (401 key rejected +
  key URL, 404 model unknown + `forge models`, 429 quota, network) and a recovery menu.
- **SmartStart** — bare `forge` shows one model line (Enter = default, ✓ badges from
  the health cache `~/.forge/health.json`), then starts chat with full power. Non-TTY
  starts instantly with zero questions.
- **`forge config` interactive menu** — add/update provider, switch, change model,
  update key, show masked, probe. (`forge config show|get|set|unset` unchanged;
  piped scripts can force the menu with `FORGE_MENU=1`.)
- **Token-reduction engine** — context windows per provider; chat compaction also
  fires at ~55% of the model window; **agent runs auto-compact mid-flight** (work-log
  summary, loop never breaks); `/tokens` shows a live context gauge.
- **No silent failures** — global `unhandledRejection`/`uncaughtException` handlers
  print friendly errors; provider 401/403 errors name the provider and its key URL.
- **Model history** — `/model x`, `forge use <p> --model <id>` and wizard picks all
  land in the recents list.

## API keys — per-provider documentation

Every provider shows this table inline during the wizard (key step). Keys can be set in
**three ways**: wizard/`forge config` (saved chmod 600 to `~/.forge/config.json`),
environment variable, or `forge config set providers.<name>.apiKey <KEY>`.

| provider | env variable | get a key | protocol |
|---|---|---|---|
| openai | `OPENAI_API_KEY` | https://platform.openai.com/api-keys | openai |
| anthropic | `ANTHROPIC_API_KEY` | https://console.anthropic.com/settings/keys | anthropic |
| zai (GLM) | `ZAI_API_KEY` | https://z.ai/manage-apikey/apikey-list | openai |
| deepseek | `DEEPSEEK_API_KEY` | https://platform.deepseek.com/api_keys | openai |
| groq | `GROQ_API_KEY` | https://console.groq.com/keys | openai |
| **openrouter** | `OPENROUTER_API_KEY` | https://openrouter.ai/keys | openai |
| gemini | `GEMINI_API_KEY` | https://aistudio.google.com/apikey | openai |
| mistral | `MISTRAL_API_KEY` | https://console.mistral.ai/api-keys | openai |
| xai | `XAI_API_KEY` | https://console.x.ai | openai |
| together | `TOGETHER_API_KEY` | https://api.together.ai/settings/api-keys | openai |
| cerebras | `CEREBRAS_API_KEY` | https://cloud.cerebras.ai | openai |
| nvidia | `NVIDIA_API_KEY` | https://build.nvidia.com/settings/api-keys | openai |
| siliconflow | `SILICONFLOW_API_KEY` | https://cloud.siliconflow.cn/account/ak | openai |
| qwen | `QWEN_API_KEY` | https://bailian.console.aliyun.com/?apiKey=1 | openai |
| github-models | `GITHUB_TOKEN` | https://github.com/settings/tokens | openai |
| huggingface | `HF_TOKEN` | https://huggingface.co/settings/tokens | openai |
| ollama (local) | — no key needed | — | openai |
| custom | `CUSTOM_API_KEY` | your gateway's console | openai |

**OpenRouter quick start (free):** `forge onboard` → pick `openrouter` → pick any model
with the `FREE` badge → paste a key from https://openrouter.ai/keys (a free account key
works for all `:free` models). List the free tier any time: `forge models openrouter --free`.

## 17 tools, used automatically

The agent AND the chat can call every tool mid-conversation — the model decides,
forge executes and streams the result back. Read-only tools run in parallel;
write tools are serialized; every write is auto-checkpointed:

| group | tools |
|---|---|
| web | `web_search` (SearXNG endpoint or DuckDuckGo fallback), `fetch_url` |
| files | `read_file` `write_file` `edit_file` `multi_edit` (atomic) `apply_patch` (unified diff, atomic, multi-file) `glob_files` `list_dir` `grep_files` |
| shell | `bash` (v20: risk-classified — catastrophic refused, destructive-outside-project refused, sudo needs consent), `git_status` (repo snapshot) |
| agent-brain | `think` (scratchpad) `todo` (task tracking) `memory` (v20: hierarchical global+project, relevance-retrieved, failure learning) `delegate` (v20: read-only sub-agent with roles, timeout + concurrency cap) `load_skill` (v20: traversal-safe) |

Toggle in chat with `/tools off` / `/tools on`. Everything is on by default.

## Tool intelligence (v20.5) — the *right* tool, not more tools

More tools do not make an agent smarter; picking correctly does. Every tool call
— in `forge agent`, in chat, from a plugin — now goes through one pipeline:

```
select → capability check → policy gate → SAFETY (shellguard/safepath/netguard)
       → execute → observe → record → verify → repair
```

- **Capability registry.** Each tool is described once, centrally: what it can
  do, its class (READ / WRITE / EXECUTE / NETWORK / SECURITY / VERIFICATION /
  RECOVERY), risk, reversibility, parallel-safety, cost, timeout, what must be
  verified afterwards, what it is preferred for and when to avoid it.
- **Router.** Chooses the **smallest effective chain** for the task ("read
  file X" is one read, not a search + read + summarize), skips steps whose
  answer forge already has, avoids disabled/deprecated tools, and re-routes
  when a previous result changes the picture.
- **Risk from the operation, not the name.** `bash echo hi` is LOW,
  `git commit` MEDIUM, `rm -rf build` HIGH, `rm -rf /` CRITICAL — decided by
  the same shellguard that has always guarded the shell. Cap it per project
  with `forge config set tools.maxRisk medium`.
- **Verification contracts.** An edit is proven: the change is really in the
  file *and* the file still parses (`node --check`, JSON parse). You see
  `[verified] …` or `[verification FAILED] …` — no silent "done!".
- **Never repeat a failed call.** Failures are classified (NOT_FOUND,
  PERMISSION_DENIED, TIMEOUT, NETWORK_FAILURE, DEPENDENCY_FAILURE,
  SYNTAX_FAILURE, TEST_FAILURE, BUILD_FAILURE, SAFETY_BLOCK …), each with a
  recovery strategy. The same call with the same arguments a third time is
  blocked with an explanation of what to change instead.
- **Idempotency + cache.** An edit already applied is a no-op, not an error;
  `mkdir` of an existing directory is "already done"; an identical read is
  served from cache and the cache is dropped the moment anything mutates.
- **Real parallelism rules.** Read-only, conflict-free calls run concurrently;
  writes serialize; two writes to the same file are a detected conflict.
- **Ask a human only when it matters** — permissions, irreversible high-risk
  operations, adding a dependency, or a strategy that has repeatedly failed.

Inspect all of it from the shell:

```bash
forge tools                                   # the registry, with class + risk
forge tools edit_file                         # one tool's full metadata card
forge tools --route "fix the failing auth test"   # what would be selected, and why
forge tools --capability search --json        # scriptable
```

Switches: `tools.intelligence` (master, `false` restores the pre-v20.5 path),
`tools.verify`, `tools.cache`, `tools.maxRisk`, `tools.explainRouting`,
`tools.disabled[]`, `tools.deprecated[]`, `tools.experimental`.

Plugins in `~/.forge/tools/*.mjs` join the same system by declaring
`capabilities`, `risk`, `parallel_safe`, `verification_required`, … — they are
routed, gated and verified exactly like built-ins, with conservative defaults.

## Carried from v16

- **Checkpoints & rewind** — before any write/edit/patch the original is snapshotted
  to `~/.forge/checkpoints/`; `forge undo` / `/undo` restores (repeat walks back).
  v20: files CREATED by an edit are tracked too (content-hash verified) — undo
  removes them, so a patch that creates + modifies is fully reversible.
- **`apply_patch`** — Codex-style unified diffs: multi-file, create/delete, atomic.
- **`git_status`**, **plan mode** (`--plan`), **parallel read tools**.
- **Auto-compaction** — long chats summarize older turns (`/compact` forces,
  `/usage` shows session tokens + est. cost).

## Smart by default

- **Streaming everywhere** — SSE parsed locally; thinking/reasoning deltas render dim (OpenAI **and** Anthropic wire protocols)
- **Never hangs** — connect guard (30s), first-byte guard, request timeout; dead endpoints fail fast and auto-retry
- **Transient-failure retry** — 429/408/5xx auto-retries with backoff (Retry-After
  honored) before anything is printed
- **Context-overflow recovery** — 400 "too large" → shrink + compact + bounded retry
- **Web-aware** — `web_search` + `fetch_url` (SSRF-guarded, size-capped)
- **Persistent memory** — `~/.forge/memory.md` + per-project memory, retrieved by
  relevance to the current task (not injected wholesale)
- **Atomic multi-edit / patches** — validate everything, write once
- **Sub-agent delegation** — read-only research sub-agent (roles, timeout,
  resource-aware concurrency, depth-capped ≤10 steps; plan mode can delegate)
- **Session memory** — auto-saved after EVERY turn (crash-safe)
- **All 69 skills bundled** — pdf, pptx, docx, xlsx, charts, design, coding, research…
- **Fast** — ~40ms cold start, memoized skill indexing

## Requirements

- Node.js ≥ 18 (v22+ recommended). **No bun. No build step. No native modules.**
- Works on: Linux desktop/server, Kali NetHunter (proot), Termux native, macOS, WSL.

## Where things live

```
~/.forge/config.json       config + API keys (chmod 600)
~/.forge/sessions/         saved conversations (chmod 600; cwd + title + summary)
~/.forge/memory.md         persistent GLOBAL memory (memory tool)
~/.forge/projects/<hash>/  per-project memory + cached project profile
~/.forge/todo.json         agent task lists (todo tool)
~/.forge/checkpoints/      automatic pre-edit snapshots (incl. created files)
~/.forge/health.json       last probe result per provider (✓ tested badges)
~/.forge/models-cache.json last live model list per provider (FREE badges offline)
~/.forge/history           persistent chat command history (arrow keys, Ctrl+R; multiline-safe, no secrets)
~/.forge/runs/             agent-run journals — power /tasks, /undo --run and crash recovery (v20.4)
<package>/skills/          the 69 bundled skills
./forge.config.json        optional per-project overrides (merged on top)
```

Optional tuning (all in the config file — defaults are sensible, start empty):

```json
"retry":  { "attempts": 3, "backoffMs": 1500, "connectMs": 30000, "requestTimeoutMs": 180000 },
"agent":  { "maxSteps": 25, "timeoutSec": 45, "maxToolOutput": 12000, "maxToolCalls": 80, "delegateTimeoutSec": 180, "maxParallelSubAgents": 2 },
"chat":   { "tools": true, "compact": true, "compactAtChars": 48000, "shellAuto": true, "deep": false, "profile": "auto", "restoreCwd": true },
"ui":     { "dock": true, "thinking": true, "ascii": false, "a11y": false, "collapse": true },
"tools":  { "searchUrl": "http://your-searxng/search", "allowOutsideProject": false, "allowSudo": false, "assumeYes": false, "fetchPrivateUrls": false },
"providers": { "openai": { "contextWindow": 128000, "priceIn": 2.5, "priceOut": 10 } }
```

**Safety flags (v20):** `tools.allowOutsideProject` lets the agent write outside
the project dir · `tools.allowSudo` permits agent sudo · `tools.assumeYes` auto-
confirms risky terminal commands (same as `FORGE_ASSUME_YES=1`) ·
`tools.fetchPrivateUrls` allows fetch_url to reach loopback/private hosts
(same as `FORGE_ALLOW_PRIVATE_URLS=1`). All default to **off**.

## Installation help & uninstall

| problem | fix |
|---|---|
| `forge: command not found` after install | add npm's bin dir: `export PATH="$(npm prefix -g)/bin:$PATH"` (put it in `~/.bashrc`) — install.sh prints this exact line automatically |
| `EACCES` during `npm i -g .` | `sudo bash install.sh`, or use a per-user prefix: `npm config set prefix ~/.npm-global` + `export PATH="$HOME/.npm-global/bin:$PATH"`, or just run `node forge.js` from the folder |
| cryptic `SyntaxError: Unexpected token` on old Node | forge needs **Node ≥ 18** — check `node --version` |
| Windows | run `npm i -g .` in PowerShell from the forge folder (npm creates the `forge` shim); or `node forge.js` |
| skills not found after global install | `forge doctor` shows the resolved skills dir; the bundled `<package>/skills` is found automatically |
| wizard interrupted (Ctrl+C, connection drop) | everything entered so far is already saved — run `forge` again and continue |

**Uninstall:** `npm uninstall -g forge-agent-cli` (your `~/.forge` data stays).
