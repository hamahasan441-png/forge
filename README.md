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

Defects that the v20 suite missed are fixed here (details in
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

## v20.1 — hardening beyond the shipped build

`agentv19/forge/PLAN-v21.md` is the roadmap (P0 → P1 → P2, plus three P3 bets).
P0, "safe by default", is done:

1. **Interpreter wrappers no longer hide their payload.** `sh -c "rm -rf /"`,
   `eval "…"`, `env FOO=1 rm -rf /`, `timeout 10 rm -rf /`, `xargs rm`,
   `python3 -c "os.system('rm -rf /')"`, `node -e`, `$(…)` and backticks are
   classified by what they RUN, not by the wrapper. They used to be `safe`,
   which for the model's bash tool means "execute, no confirmation".
2. **`$VAR` targets are expanded** before classification, so `rm -rf $HOME` is
   blocked exactly like `rm -rf ~` (it used to be a mere `confirm`).
3. **Redaction gaps closed:** values under 8 characters (`password=hunter2`),
   escaped JSON values, `Authorization: Bearer <opaque>`, and unprefixed
   high-entropy keys — with a pinned "refuse to over-redact" corpus so git
   SHAs, UUIDs, hashes, paths and URLs stay untouched.
4. **`read_file` streams** a bounded window instead of `readFileSync`+`split`
   of the whole file: +0 MB RSS on a 16 MB log (was +30 MB), and a 2 GB log
   can no longer OOM the agent.
5. **Checkpoints gzip their backups** (`node:zlib`, still zero dependencies):
   the per-file cap moves from 2 MB to 64 MB, so `forge undo` now protects
   the files it used to refuse (6.4 MB log → 306 KB backup).

Suites: 222/222 hardening unit checks, 247/247 e2e, 31/31 provider-wire,
13/13 diff-engine, 50/50 clean-room install.
