# forge

Standalone terminal AI agent (CLI only, no web app) — zero-dependency Node.js,
direct-to-provider, with a terminal-in-chat shell, a coding agent with 19
hardened tools, and bundled skills.

**Last version: 66.0.0.** One folder: `forge/`.

## Layout

```
forge/                 the CLI (npm package) + tests/ + skills/
PACKAGE_INFO.txt
README.md
```

`agentv19/` is gone.

## Install

```bash
cd forge && bash install.sh      # or: npm i -g .
forge                            # first run: provider → model → key → test
forge doctor
```

## Self-test (needs Node only, no network)

```bash
cd forge
npm test                         # all suites
FORGE_FAST=1 npm test            # Node suites only
FORGE_SKIP_E2E=1 npm test
```

Full history: [`forge/CHANGELOG.md`](forge/CHANGELOG.md).
Remaining work: [`forge/TODO.md`](forge/TODO.md).
