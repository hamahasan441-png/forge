# forge

Standalone terminal AI agent. CLI only. Zero-dependency Node.js. Talks
straight to providers.

**Version 89.0.0 — "fast".** Agent steps 4.6× faster, CLI boots in ~57ms,
dead providers fail over in 8s, parallel tests. Carries **v88 "noguard +
worker clamp"**: no guards, no blocks, workers 2–8. One folder: `forge/`.

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
  tests/               130 suites (npm test, zero network)
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
