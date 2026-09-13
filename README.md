# forge

Standalone terminal AI agent. CLI only. Zero-dependency Node.js. Talks
straight to providers.

**Version 94.0.0 — "gapwise" (gap fix / integration patch).

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
  skills/              80 bundled skills
  tests/               139 suites (npm test, zero network)
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
