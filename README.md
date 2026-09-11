# forge

Standalone terminal AI agent. CLI only. Zero-dependency Node.js. Talks
straight to providers.

**Version 77.0.0.** One folder: `forge/`.

## Layout

```
forge/                 the npm package (CLI + tests + bundled skills)
  forge.js
  skills/
  tests/
PACKAGE_INFO.txt
README.md
```

`agentv19/` is gone. History lives in [`forge/CHANGELOG.md`](forge/CHANGELOG.md).
Leftovers: [`forge/TODO.md`](forge/TODO.md).

## Install

```bash
cd forge && bash install.sh      # or: npm i -g .
forge                            # first run: provider → model → key → test
forge doctor
```

Needs Node ≥ 18.

## Daily

```bash
forge                            # AUTOPICK: chat, tools on
forge --pick                     # choose model
forge ask "question"
forge agent "task"
forge agent --plan "task"
forge resume <n|id>
forge undo
forge doctor
```

In chat: Linux commands run in the project folder. Sentences go to the model.
`! cmd` always executes. Risky commands ask y/N. Catastrophic ones are blocked.

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
npm test                         # all suites
FORGE_FAST=1 npm test            # Node suites only
FORGE_SKIP_E2E=1 npm test
```

`npm test` is the source of truth. Suite counts are not duplicated here.

Known reds (not this land): plugin-iso on Node 22; chat-compact flake.
