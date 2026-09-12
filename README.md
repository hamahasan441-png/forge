# forge

Standalone terminal AI agent. CLI only. Zero-dependency Node.js. Talks
straight to providers.

**Version 93.0.0 — "DOCSMITH".** The Documentation Writer finally writes: the
DOCUMENT phase builds a deterministic brief from what the change actually
obliges (real file paths, breaking changes, a ready-to-paste CHANGELOG section),
drafts it read-only on LARGE/ARCHITECTURAL, and the executor — the roster's
single writer — applies it. An empty brief spends zero model calls, and
`agent.docsAgent: false` restores v92.

**v92 "PROCREW".** `/agent` is now a team of senior engineers, not
one agent with a plan: the named 13-role crew **executes** as real sub-agents in
parallel under one scheduler (duplicate work refused before it costs a call,
clashing edits split into waves, every finding self-reviewed before merge, a
failed unit retried under a different specialist), every task runs the same
verification pipeline — build → lint → typecheck → test → validate, from the
project's own manifests, recorded in the completion ledger *before* the gate is
judged — and the Memory Agent remembers accepted and rejected approaches so a
refused solution is never bought twice. Carries **v91 "ULTIMATE"** (objective
engine: verified objective satisfaction instead of a step count, checkpoints,
resume, loop detection, ten-section final report, docs & git intelligence,
self-review → self-upgrade → rollback) and **v88 "noguard"**: no guards, no
blocks. One folder: `forge/`.

## v93 in one line

```bash
forge docs                   # what this diff obliges you to document
forge agent --auto "<task>"  # …and the DOCUMENT phase now writes those files
```

Only the listed files are touched, an existing file is never reported
"missing — create", a docs-only change costs no model call, and a writer that
fails is reported instead of thrown.

## v92 in one line

```bash
forge verify                   # build -> lint -> typecheck -> test -> validate (from THIS project's manifests)
forge verify --only test --json # one stage, machine-readable, exit 1 on failure
forge agent --auto "<task>"    # the crew runs: parallel specialists, self-review, reassignment, pipeline, report
forge report                   # the final report — now with the crew run and the pipeline table
```

A stage this project cannot really run is reported skipped with the reason and
**never faked**; pass/fail is the completion ledger's call, so `exit 0` with a
failure in the output still fails. `agent.pipeline: false` restores v91 verification; `agent.crew: false` turns the fan-out off.

## v91 in one line

```bash
forge self-review              # deterministic static review (dupes, dead code, cycles, hotspots, security)
forge self-upgrade --plan      # evidence → reversible proposals (impact, risk, verify)
forge self-upgrade --apply     # apply through a versioned manifest (never writes forge's own source)
forge rollback                 # undo the last self-upgrade from its recorded inverse
forge report [id]              # the final report of an autonomous run (10 sections)
forge docs                     # breaking changes + doc deltas + commit message for the current diff
forge roles --crew             # who does what, and who is allowed to write (exactly one)
```

Additive by construction: `agent.orchestration|objective|report: false` in
`~/.forge/config.json` restores the exact v90 path. Self-upgrades touch config,
project memory and additive files only — code changes are proposed, never
auto-applied, and never to the kernel.

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
  tests/               131 suites (npm test, zero network)
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
forge agent "task"               # coding agent, 22 tools
forge report                     # final report of the last autonomous run
forge agent --auto "task"        # full autonomous lifecycle (DAG + verify + repair)
forge resume <n|id>
forge undo
forge doctor
```

In chat: Linux commands run in the project folder. Sentences go to the model.
`! cmd` always executes. **v88: nothing is blocked and nothing asks y/N.**

```
/status   /profile [p]   /deep   /shell off
/report   /self-review   /self-upgrade   /rollback   /docs
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
