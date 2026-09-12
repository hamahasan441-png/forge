# ⬢ forge — standalone terminal AI agent (v92)

**v92 "PROCREW"** — `/agent` becomes a team of senior engineers instead of one
agent with a plan. The named crew now **executes**: specialists run as real
sub-agents in parallel under one scheduler, every completed task runs the same
verification pipeline (build → lint → typecheck → test → validate, from the
project's own manifests, recorded in the completion ledger *before* the gate is
judged), and the Memory Agent records accepted and rejected approaches so a
refused solution is never bought twice. `agent.pipeline: false` restores the
exact v91 verification path; `agent.crew: false` turns the fan-out off.

**v91 "ULTIMATE"** — `/agent` becomes an objective-driven engineering system.
A named 13-role crew (exactly one writer), an objective engine that ends a run
on *verified objective satisfaction* instead of a step count, a ten-section
final report, docs & git intelligence, and a self-review → self-upgrade →
rollback loop. All additive: `agent.orchestration|objective|report: false`
restores the exact v90 path.

**v90 "gitwise"** — dedicated git views (git_diff / git_log / git_blame,
token-budgeted, verifier-whitelisted) and the silent-stop fix: an empty model
response is nudged and retried instead of ending the run "completed" with no
result; a persistent empty streak fails loudly (exit 1).

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

## v92 — the crew executes, and every task verifies itself

```bash
forge verify                 # build -> lint -> typecheck -> test -> validate
                             #   from THIS project's manifests; exit 1 on failure
forge verify --only test     # one stage          forge verify --json   # machine-readable
forge agent --auto "<task>"  # crew + pipeline + report, end to end
forge report                 # now includes the crew run and the pipeline table
```

**One scheduler, not two.** `crew.js` decides *what* runs: `workUnits()` turns a
plan into named-specialist units, `dedupeUnits()` refuses duplicate work before
it costs a model call, `waves()` keeps two units that touch the same file out of
the same wave (using `dag.canonicalConflictKeys` — the DAG scheduler's own key
space, so the two cannot disagree), `selfReview()` checks every finding against
the existing adversarial checklist before it may be merged, and `reassignFor()`
retries a failed unit under a *different* specialist (the same role asked twice
is a loop, not a retry) until the ladder is honestly exhausted. *Who* runs it is
still `agentmanager.spawn` → `runAgent`: one tool loop, one set of budgets, and
the executor stays the only mutating role.

**Nothing is faked.** A stage this project cannot really run is reported
`skipped — no <stage> command in this project's manifests`. Pass/fail is
`verifyledger.evaluateVerification`'s call, never a second opinion: an
unobserved exit status, a timeout, a truncated capture, a killed process, or
`exit 0` with a failure shape in the output are all **not** a pass.

**Retry until success — or report a blocking issue.** A failed stage is
diagnosed (`shape` + `hint` + `tail`), the repair phase runs, the evidence is
invalidated, and the next pass re-verifies the *fixed* code. Two bounds, both
measured on attempts: the configured repair budget, and a repeat of the same
failure on the same files. When either trips, the run records
`VERIFICATION_NOT_RECOVERING` as a non-recoverable blocker and stops instead of
repairing one unfixable failure until the segment fuse.

**Memory that changes behaviour.** `recordVerdict` / `verdicts` /
`isRejectedApproach` / `verdictBlock` store accepted and rejected *approaches*
as tagged bullets in the project tier (same file, lock, redaction and dedup as
the rest of memory). A unit whose approach was already rejected is skipped
before a model call is spent on it; a later `accepted` verdict for the same
shape cancels the rejection. `lessons.js` keeps failure *classes*; this records
*decisions*, which had no home before.

## v91 — the autonomous surface

```bash
forge self-review            # deterministic static review: duplicates, dead exports,
                             #   import cycles, oversized modules, security smells, TODOs
forge self-upgrade --plan    # findings → proposals (evidence, impact, risk, verify command)
forge self-upgrade --apply   # apply the reversible ones through a versioned manifest
forge rollback               # undo the last self-upgrade from its recorded inverse
forge report [id|list]       # the final report of an autonomous run
forge docs                   # breaking changes + doc deltas + commit message for the diff
forge roles --crew           # the roster: who owns which phase, who may write (one)
```

In chat the same surface is `/agent crew|self-review|self-upgrade|rollback|report|docs`
(plus `/report`, `/self-review`, `/self-upgrade`, `/rollback`, `/docs`).

**How a run ends.** `objective.js` never declares success. `DONE` requires the
existing 9-check completion gate (`completion.js`) to be satisfied *and* the
required phases (ANALYZE/PLAN/EXECUTE/VERIFY) to have run; an unrecoverable
blocker yields `BLOCKED`; a segment/continuation fuse yields `WAITING` with
reason `FUSE` — a budget is never a result. The same action repeated three
times with identical arguments is treated as a loop: `LOOP_DETECTED`, a
strategy pivot, and a lesson so the next plan skips that approach.

**Who may write.** The crew maps onto `agentmanager.ROLES`; the Executor is the
only mutating member and every other role is dispatched read-only. Where the
platform disagrees (agentmanager lets `debugger` mutate) the roster prints both
answers instead of hiding the difference — repairs still go through the single
writer.

**What a self-upgrade may touch.** Config, project memory and additive files —
each change records its inverse in `~/.forge/projects/<hash>/upgrades.json`, and
`forge rollback` restores it. A payload that would write a source file is
refused. Code changes found by `self-review` are *proposed*, never auto-applied.

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
forge report                     # final report of the last autonomous run
forge self-review                # deterministic static review of this project
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
objective.js  objective engine: phases, checkpoints, resume, loop detection
orchestra.js  the named crew (13 roles, one writer) + advisory packs (0 calls)
report.js     the ten-section final report   docsintel.js  docs & git intelligence
selfup.js     self-review → self-upgrade → rollback (never writes kernel source)
tools.js   19 tools + redaction        shellguard.js  risk classifier (labels only)
providers.js  20 providers, failover   modelstrategy.js  measured routing
memory/lessons/evolve   hierarchical memory + failure learning
verifyledger/completion  evidence ledger + 9-check completion gate
tests/     131 suites, zero network needed (FORGE_FAST=1 npm test)
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
~/.forge/projects/<hash>/   per-project memory, claims, decisions, gaps,
                            objectives/, reports/, upgrades.json
~/.forge/skill-downloads/   CANDIDATE downloads (never auto-trusted)
.forge/plans/               plan-mode plans (project-local)
```

Config precedence: defaults → `~/.forge/config.json` → project
`forge.config.json` (privileged keys like `tools.*` are user-config only —
a project file cannot set them).

## License

MIT. Bundled skills keep their own `LICENSE.txt` where present.
