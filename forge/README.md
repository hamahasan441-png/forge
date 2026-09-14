# forge

Standalone terminal AI agent. CLI only. Zero-dependency Node.js. Talks
straight to providers.

**Version 94.0.0 — "gapwise" (gap fix / integration patch).

**v94 "gapclose"** — the TODO burn-down: seven documented open gaps closed
with evidence, no rewrite, no version bump. The kill fallback is now an
**evidence-based process-table walk** (/proc · ps · PowerShell/wmic — a
failed group signal never again means "leader only" with orphaned
grandchildren); **health probes are protocol-aware** (a TLS/WebSocket/raw-TCP
service is reported LISTENING with an honest "app health not provable over
HTTP" label instead of a false NOT-healthy; a hung listener is distinguished
from a dead port); **checkpoint restore reconciles the working tree**
(files the restore could never write — >64MB skips, kept created files — are
hashed against the manifest and any external drift is reported with
fingerprints, `treeConsistent`); the **bwrap kernel probe re-probes** after a
real start failure; **semantic search persists its chunk corpus**
(fingerprint-invalidated per file, outside the repo, FORGE_INDEX=0 opts out —
a fresh process re-reads only what changed); **created tools may carry a
scripted multi-step probe** (login → act → verify in one child process,
per-step oracles, a failing step is named — a soft error can no longer ride
exit 0 to promotion); and an **LSP auto-start table** (typescript, python,
go, rust) makes structured documentSymbol extraction the default when the
binary actually exists on PATH — user config always wins,
FORGE_LSP_AUTOSTART=0 opts out, and the segment-verification gate stays
config-only on purpose. 7 new suites, 138 new assertions, 165/165 green.

**v94 follow-ons (masterwise + tokenwise)** — no version bump, no rewrite,
same architecture: the **Engineering Intelligence Core** (adaptive search
providers with honest failure, an execution controller that can never mistake
a step budget for completion, the layered engineering memory with provenance,
the predictive risk-aware planner); the **TokenRouter** provider — one
OpenAI-compatible `/v1` key over 300+ upstream models (`TOKENROUTER_API_KEY`);
and the bundled **understand-anything** skills pack (codebase → knowledge
graph: analyze, chat, dashboard, diff, domain, explain, figma, knowledge,
onboard — the graph feeds project memory retrieval on later tasks). **toolwise**
follow-on: three new read-only, deterministic tools — `kg_query` (project
knowledge graph: dependents, blast radius, tests, .ua graph), `plan_whatif`
(simulate plan changes through the predictive risk engine before committing),
`code_context` (semantic hits + structural wiring in one call). 29 tools,
89 bundled skills at that point, 155/155 suites green. **skillwise**
follow-on: the **obra/superpowers** engineering-process pack bundled as
first-party skills (MIT, github.com/obra/superpowers) — brainstorming,
TDD, systematic-debugging, verification-before-completion, plan writing &
execution, code review requesting/receiving, subagent-driven development,
parallel dispatch, git worktrees, skill authoring: 13 of 14 upstream skills
byte-identical (upstream `writing-plans` not re-bundled — forge ships its own
adapted one; the 5 platform-seam skills carry appended forge execution notes
over a byte-identical upstream prefix). 102 bundled skills, 34 first-party
catalog skills, 156/156 suites green at that point. The **knowwise**
follow-on made the project itself a living knowledge source: the first task
in any project auto-writes a deterministic FLOOR knowledge graph
(`.ua/knowledge-graph.json` from the world-model extractors — no LLM, no
network; real understand-anything graphs are never touched; rebuilds only on
fingerprint drift) that feeds memory retrieval and `kg_query` from run one;
every successful file edit now carries a bounded blast-radius prediction
(radius · importers · tests — one advisory line, additive record field +
event, `FORGE_BLAST_RADIUS=0` disables); and shell resolution is
Termux/NetHunter-ready (`FORGE_SHELL` > /bin/sh > $PREFIX/bin/sh > $SHELL),
so every bash call, background process, and typed `!` command works on
Android out of the box. 157/157 suites green at that point.

**v94 "deepwise"** — judgment before action, all deterministic, zero model
calls, zero network: plan **competition + adoption** (the original plan now
competes against its reshaped variants on expected verified progress; when a
variant wins by a real margin at equal-or-better risk and success, the
planner ADOPTS it — the inspect/verify guard node becomes real executed DAG
work, predictions re-stamped, live risk restarted at the adopted estimate;
shapes that drop declared dependencies are advised but never auto-adopted);
a **pre-mutation self-critique** (one deterministic checklist before every
file mutation — secret paths, edit targets that do not exist, same-file edit
thrash, and hub files read straight from the knowwise floor graph; one
advisory line + event, never blocks, `FORGE_CRITIQUE=0` disables); and the
reality→risk loop closed for experiments (repair outcomes move LIVE risk).
158/158 suites green.

**v94 "gapwise"**

**v94 "gapwise"** — the confirmed v93 gaps fixed inside the existing
architecture, zero fake completion: ONE completion contract for every
execution path (budget exhaustion → INCOMPLETE + checkpoint + resume, never
a fabricated COMPLETED); exhausted workers classified and retried; **Runtime
Intelligence** (discovery with per-fact evidence, real health probes,
claim gates, crash reconcile — `runtime` tool #26); **persistent
incremental world model** (survives restart, re-extracts only what changed,
honest truncation); **persisted core bus + engineering-event ledger** with
restart reconstruction; **LSP-first structured extraction** (lexical is a
labeled fallback, not a silent default); **tool creation pipeline** with
behavioral verification in a real child process; **strict learned-skill
promotion** (equivalent to downloads: behavioral evidence + freshness +
staleness); **strategy 3.0** with contextual factors and justifications.
26 tools, 148/148 suites green.

**v93 "sensewise"** — three new senses: a background **process manager**
(dev servers survive the tool call; ports detected from output and the OS
socket table, never guessed; kill hits the whole group; the lifetime fuse
is a resource fuse, never a completion claim), a **persistent Node REPL**
(variables and loaded data survive between calls; timeout = "still
running", never fabricated), and **semantic code search** (BM25 +
embedding hybrid, find code by meaning when grep finds nothing literal).
The last v91 islands (skillforge, embeddings, memgraph) are wired. 25
tools, 140/140 suites green, 99 new assertions.** Nothing rewritten — the
v91 engines remain the source of truth; every module that shipped but was
never consulted is now wired into the living system: a **prediction
ledger** (predict before each segment → settle against observed reality →
calibrate future plans from real prediction errors), **language-adapter
coverage** in every agent prompt (67 languages, honest deep-vs-conservative),
**world-model consultation** at planning (blast radius + covering tests),
**integrator conflicts** reported and resolved instead of discarded, and the
P0 plugin-load TDZ fix (user tool plugins work again). Carries **v91
"corewise"** (∞ CORE), **v90 "gitwise"**, **v89 "fast"** and **v88 "noguard
+ worker clamp"**: no guards, no blocks, workers 2–8. One folder: `forge/`.

## v88 in one line

Every command gate is gone (nothing is refused, nothing prompts — block-class
included), the project write boundary is gone, `fetch_url` has no SSRF gate,
the sandbox is opt-in (`FORGE_SANDBOX=1`), and workers are clamped: **low tier
= 2, absolute max = 8**. The risk classifier still labels every command for
logs and `/status` — the verdict is just always *run*.

```
forge/                 the npm package (CLI + tests + bundled skills)
  forge.js             CLI entry
  skills/              102 bundled skills
  tests/               158 suites (npm test, zero network)
LICENSE                MIT
PACKAGE_INFO.txt       capability summary
FORGE-AUDIT-REPORT*.md engineering reports (history)
```

## Install

```bash
cd forge && bash install.sh      # or: npm i -g .
forge                            # first run: provider → model → key → test
forge doctor
```

Needs Node ≥ 20.

## Daily

```bash
forge                            # AUTOPICK: chat, tools on, no prompts
forge --pick                     # choose model
forge ask "question"
forge agent "task"               # coding agent, 19 tools
forge agent --auto "task"        # full autonomous lifecycle (DAG + verify + repair)
forge resume <n|id>
forge undo
forge doctor
```

In chat: Linux commands run in the project folder. Sentences go to the model.
`! cmd` always executes. **v88: nothing is blocked and nothing asks y/N.**

```
/status   /profile [p]   /deep   /shell off
/skills   /skill download <https-url>
/skill verify <name|all>   /skill learn <name>
```

`DOWNLOAD ≠ TRUST`. A download is CANDIDATE until verify. Learn is VERIFIED
only. Indexing is not learned. Nothing auto-ACTIVE. Data lives under
`~/.forge` (`FORGE_DATA_DIR` aliases `FORGE_HOME`).

## Self-test (Node only, no network)

```bash
cd forge
npm test                         # all suites (e2e + cleanroom included)
FORGE_FAST=1 npm test            # Node suites only (~39 s, 4-way parallel)
```

`npm test` is the source of truth. Suite counts are not duplicated here.
