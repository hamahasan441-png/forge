# forge

Standalone terminal AI agent (CLI only, no web app) — zero-dependency Node.js,
direct-to-provider, with a terminal-in-chat shell, a coding agent with 17
hardened tools, and 69 bundled skills.

## Layout

```
agentv19/
  README.txt          quick start (install, daily use, in-chat commands)
  PACKAGE_INFO.txt    what's in the build
  forge/              the CLI (forge.js + 18 modules + skills/) — this is the npm package
  tests/              e2e + unit + clean-room install suites
forge-v20-production.zip   the upstream release archive (untracked; contents extracted)
```

## Install

```bash
cd agentv19/forge && bash install.sh      # or: npm i -g .
forge                                     # first run: provider → model → key → test
forge doctor                              # verify environment + connectivity
```

## Self-test (needs Node only, no network)

```bash
cd agentv19/tests
node mock-llm.mjs &                       # local stand-in provider (127.0.0.1:8787)
bash e2e-forge.sh                         # 236 checks
node test-security.mjs                    # 151 hardening unit checks
node test-diffpatch.mjs                   # 13 diff-engine checks
bash cleanroom-v20.sh                     # 48 checks — installs into a temp npm prefix
```

## v20.0.1 patch

Four defects that the v20 suite missed are fixed here (details in
`agentv19/forge/PLAN-v20.md`):

1. `shellguard` crashed with `ReferenceError: why is not defined` on `mv`/`cp`
   into a system directory — the safety engine now refuses those commands with
   a proper message (and never throws: it fails closed).
2. `glob_files` compiled `**/*.ts` so that it never matched files in the search
   root.
3. `forge doctor` printed `✓ doctor done` even when every provider probe failed.
4. `execTool` threw a `TypeError` when a model sent malformed tool arguments.
