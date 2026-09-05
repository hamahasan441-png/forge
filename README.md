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
bash e2e-forge.sh                         # 247 checks
node test-security.mjs                    # 153 hardening unit checks
node test-providers.mjs                   # 31 provider-wire robustness checks
node test-diffpatch.mjs                   # 13 diff-engine checks
bash cleanroom-v20.sh                     # 50 checks — installs into a temp npm prefix
```

## v20.0.1 patch

Four defects that the v20 suite missed are fixed here (details in
`agentv19/forge/PLAN-v20.md`):

1. `shellguard` crashed with `ReferenceError: why is not defined` on `mv`/`cp`
   into a system directory — the safety engine now refuses those commands with
   a proper message (and never throws: it fails closed).
2. `glob_files` compiled `**/*.ts` so that it never matched files in the search
   root.
3. `forge doctor` printed `✓ doctor done` even when every provider probe
   failed — and called a provider that answered with an HTML page *working*.
4. `execTool` threw a `TypeError` when a model sent malformed tool arguments.
5. A provider answering HTTP 200 with HTML (wrong URL, proxy, captive portal)
   surfaced as `SyntaxError: Unexpected token '<'`; an unreachable host as
   `fetch failed`; a stream cut mid-answer as `terminated`.
6. Files larger than 2 MB were silently skipped when checkpointing, so
   `forge undo` claimed a clean restore it had not made — it now names the
   file it could not protect.
7. Terminal auto-detect swallowed ordinary sentences: `find the bug in
   main.js` ran `find`, `node is great` ran `node`, `make it work` ran `make`
   — and the model never saw the message. Sentences now go to the model;
   real commands still execute.

Details in `agentv19/forge/PLAN-v20.md`; every fix has a regression test.
