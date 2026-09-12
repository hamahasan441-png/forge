# ⬢ forge — standalone terminal AI agent (v89)

**v89 "fast"** — agent steps 4.6× faster (adjacency-index graph traversals),
CLI boots 218ms → 57ms (lazy subcommand imports), dead providers fail over in
8s instead of stalling 94s, Anthropic prompt caching on the static prefix,
tests run 4-way parallel. Zero behavior change — results are byte-identical
(proven by a reference-implementation test).

Carries **v88 "noguard + worker clamp"**: zero command gates, zero write
boundaries, sandbox off by default, workers clamped 2–8. Full control,
permanently.

One folder. Zero dependencies. Pure Node (≥ 20, ESM). Talks straight to
providers — no localhost server, no build step, no native modules.

```
npm i -g .        # or: bash install.sh
forge             # first run: provider → model → key → test
```

## What it is

A CLI coding agent + interactive chat that runs entirely in your terminal:

- **`forge`** — interactive chat with terminal-in-chat: type Linux commands and
  they execute in your project folder; plain sentences go to the model
- **`forge agent "task"`** — coding agent, 19 tools (bash, files, edits,
  patches, web, images, browser, memory, sub-agents)
- **`forge agent --auto "task"`** — full autonomous lifecycle: plan → DAG →
  parallel workers → verification ledger → repair → recovery, crash-resumable
- **`forge ask "question"`** — one-shot answer
- 20 providers (OpenAI, Anthropic, Gemini, DeepSeek, Groq, OpenRouter, Z.ai,
  Groq, Cerebras, Mistral, xAI, Qwen, GitHub Models, Ollama, custom + routers)
  with automatic failover and measured model routing

## v88 — full control, no guards

| What used to gate actions | v88 behavior |
|---|---|
| Catastrophic commands (`rm -rf /`, `mkfs`, `dd` to devices, fork bombs) | **Run.** Nothing is refused |
| Risky/confirm commands, sudo, `node -e`/`python -c` | **Run.** No y/N prompts, ever |
| Writes outside the project directory | **Allowed** (no project boundary) |
| Sensitive reads (`.env`, `~/.ssh`, forge config) | **Allowed** |
| SSRF guard on `fetch_url` (loopback/metadata) | **Off** — private URLs fetch like public |
| bwrap sandbox | **Opt-in only** (`FORGE_SANDBOX=1`) |

Still on purpose (correctness features, not guards):

- **Read-only verifier/plan agents can't write** — VERIFY ⇒ READ_ONLY is what
  keeps autonomous verification honest (a verifier that can write its own
  evidence proves nothing)
- **Secret redaction** — known key shapes (`sk-…`, `AKIA…`, JWTs, assignments)
  are masked in tool results before they reach the model or session files
- **Socket pinning** — a fetched connection must match its validated DNS
  addresses (anti-rebinding mechanics); skill/tool downloads keep full
  `netguard` policy
- **Classifiers still label everything** — commands keep their risk level in
  logs, `/status`, and tool-intelligence; the verdict is just always *run*

**Workers:** low-tier / low-RAM machines run **2** parallel read-only workers
(v88 floor), high-tier machines up to **8** — never more, burst scaling
included. A single mutating writer serializes writes.

## Daily use

```bash
forge                            # AUTOPICK best model → chat, all tools ON
forge --pick                     # model chooser (✓ tested / FREE badges)
forge ask "summarize git log"    # one-shot
forge agent "fix the failing test in src/auth.js"
forge agent --plan "task"        # plan first (read-only), confirm, execute
forge agent --auto "task"        # full autonomous lifecycle
forge agent --deep "task"        # DEEP THINKING (high reasoning effort)
forge resume <n|id>              # resume a session (messages + cwd + usage)
forge tasks                      # list autonomous tasks / --resume <id>
forge undo                       # restore files changed by the last tool edit
forge doctor                     # connectivity + latency check (--all, --tools)
forge config                     # interactive config menu
forge provider add <name> <url>  # custom provider, auto model discovery
forge models <provider> --free   # list FREE models (live or cached)
forge use deepseek --model deepseek-chat
```

### In chat

- Linux commands execute in your folder (`ls`, `git status`, `npm test`, …);
  plain sentences go to the model; `! cmd` always executes
- `cd` / `export` persist per session; every run is shared with the model
  (secret-redacted) — ask "what did that print?"
- `/status` — session + context + safety snapshot
- `/profile [fast|balanced|deep|auto]` — effort profile
- `/deep` — toggle deep thinking · `/shell off` — stop command autodetect
- `/skills`, `/skill download <url>`, `/skill verify <name|all>`,
  `/skill learn <name>` — see below

## Skills — DOWNLOAD ≠ TRUST

80 skills ship in the box (coding, git, docs, pdf/docx/xlsx/pptx, web, vision).
Downloaded skills follow a strict lifecycle:

```
download → CANDIDATE → verify → VERIFIED → promote/autopromote → ACTIVE
                └─ fail → INACTIVE          └─ TTL/drift → STALE → re-verify
```

Indexing is not learning. Nothing auto-ACTIVEs because a download succeeded.
Learned plugins are hostless playbooks, never spawned. Data lives under
`~/.forge` (`FORGE_HOME` / `FORGE_DATA_DIR`).

## Architecture (one screen)

```
forge.js   CLI (40+ subcommands)      chat.js   terminal-in-chat + sessions
agent.js   bounded tool loop           meta.js   autonomous controller:
                                          PLAN → DAG → segments → VERIFY →
                                          REPAIR → RECOVER (crash-resumable)
tools.js   19 tools + redaction        shellguard.js  risk classifier (labels only)
providers.js  20 providers, failover   modelstrategy.js  measured routing
memory/lessons/evolve   hierarchical memory + failure learning
verifyledger/completion  evidence ledger + 9-check completion gate
tests/     130 suites, zero network needed (FORGE_FAST=1 npm test)
```

## Self-test (Node only, no network)

```bash
cd forge
npm test                    # all suites incl. e2e (mock provider) + cleanroom
FORGE_FAST=1 npm test       # Node suites only (~39 s, 4-way parallel)
FORGE_TEST_CONCURRENCY=1 npm test   # old sequential behavior
```

## Requirements

- Node.js **≥ 20** (18 is EOL and untested)
- Linux / macOS / Termux / proot (bash required; Windows: use WSL)
- No npm dependencies at runtime; install never touches the registry

## Where things live

```
~/.forge/config.json        provider + model + keys (chmod 600)
~/.forge/sessions/          chat history, resumable
~/.forge/projects/<hash>/   per-project memory, claims, decisions, gaps
~/.forge/skill-downloads/   CANDIDATE downloads (never auto-trusted)
.forge/plans/               plan-mode plans (project-local)
```

Config precedence: defaults → `~/.forge/config.json` → project
`forge.config.json` (privileged keys like `tools.*` are user-config only —
a project file cannot set them).

## License

MIT. Bundled skills keep their own `LICENSE.txt` where present.
