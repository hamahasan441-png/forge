# Changelog

All notable changes to **forge** are recorded here. The version is defined in
exactly one place — `package.json` — and read at runtime via `version.js`.

## [Unreleased] — v20.5.0 (in progress)

### Added
- **An explicit agent execution contract** (`contract.js`, autonomy Phase 1) — the
  first step toward long-horizon autonomy is that a caller can tell what actually
  happened without guessing. Before this, `runAgent()` returned
  `{ text, steps, toolLog, planOnly, runId, wrote }` and two load-bearing facts
  were only inferable:
  - **"did it finish, or did it run out of budget?"** was answered by
    string-matching the answer text for `"(reached max steps without a final
    answer…)"`. Any rewording of that sentence silently turned a truncated run
    into an apparent success — and nothing was checking, so an orchestrator
    would have marked unfinished work done.
  - **token usage was discarded entirely.** `chatOnce` returns a `usage` object;
    the agent loop dropped it on every call, so there was no cost or budget
    signal at all, and no way to distinguish "the provider reported 0 tokens"
    from "we never learned the token count".

  `runAgent()` now returns `status` (a six-value enum: `COMPLETED`,
  `CONTINUE_REQUIRED`, `FAILED`, `CANCELLED`, `BLOCKED`, `WAITING`), an explicit
  boolean `budgetHit`, accumulated `usage`, and stable `taskId`/`segmentId`
  identity alongside the existing `runId`. Unknown token counts are reported as
  the `UNKNOWN` sentinel, never as `0`. A delegated sub-agent inherits its
  parent's `taskId` and takes a fresh `segmentId`, so one task's segments are
  linkable. `validateAgentResult()` rejects an invented status, a non-boolean
  `budgetHit`, and the specific lie of `budgetHit: true` reported as `COMPLETED`.

  Every pre-existing field is still returned, so all eight call sites keep
  working unchanged. Honesty note, also recorded in the module: only `COMPLETED`
  and `CONTINUE_REQUIRED` are produced by `runAgent` today — the other four are
  defined for the orchestration layer that will consume them, and `runAgent`
  still throws on hard provider errors rather than returning `FAILED`.
  New `tests/test-contract.mjs` (42 checks) against local stand-in providers —
  one answering, one that only emits tool calls in order to exhaust the step
  budget for real — plus a run of the actual CLI asserting the contract reaches
  the terminal.

### Changed
- **`FORGE_DEBUG=1` reports the contract, not just tool counts** — the run
  summary now prints `status`, `budgetHit` and token usage (`UNKNOWN` when the
  provider reported none). Recording usage is only worth anything if it is
  visible somewhere.
- **One run-id generator.** `agent.js` hand-rolled the same `run-<base36>-<rand>`
  format that `contract.js` now owns; it calls `newRunId()` instead, so the id
  format cannot drift between the checkpoint tag and the contract.

## [Unreleased] — v20.4.0 (in progress)

### Added
- **Tests for effort classification, the model cache and skill indexing** —
  `classifyTaskComplexity`/`resolveEffort` decide whether a task gets DEEP
  reasoning (bigger budgets, slower, costlier), a user-visible and cost-relevant
  decision that had no test at all; `modelcache` backs the offline FREE badges;
  `indexSkills` is what puts skills in front of the model. New
  `tests/test-effort.mjs` (37 checks) covers the five complexity levels, every
  profile path (including that a switch is always explained, never silent),
  cache write/read/merge and corrupt-file resilience, and skill indexing with
  H1/intro-line description fallback. Export coverage 67.4% → **72.6%**.

### Changed
- **`PLAN-v21.md` now reflects reality.** It still declared "Status: proposed.
  Nothing here is implemented yet" while nearly all of it had shipped, and its
  measured table still claimed no CI, three copies of the version string and 57%
  uncovered exports. It now carries a delivery ledger (§0.1) recording what
  shipped, what is partial, and what was deliberately NOT done and why — the
  Windows shell item in particular, which stays open because the safety engine is
  POSIX-specific and shipping it without a Windows-aware command classifier would
  reduce safety.

## [Unreleased] — v20.3.0 (in progress)

### Fixed
- **The published package was missing `retrieval.js`** — it was added in the BM25
  change but never added to `package.json` `files[]`, so the npm tarball omitted
  it while `memory.js` and `repomap.js`, which import it, shipped fine. A real
  `npm publish` would therefore have produced a CLI that dies on startup for
  nearly every command. The clean-room suite could not catch it: it installs from
  the *directory*, and npm treats that differently from the tarball a user
  actually receives. Fixed, and guarded by `tests/test-package.mjs` (6 checks)
  which asserts the real invariant — every relative import of a shipped module
  must itself ship — plus files[]/disk agreement and the actual `npm pack`
  listing. Verified by reintroducing the omission and watching all three checks
  fail.
- **`install.sh` ran the global install twice on failure** (P1-10) — the failure
  path re-ran `npm i -g .` in full just to grep its output for `EACCES`, doubling
  an already-slow failure; and because the first attempt used `--silent`, the
  diagnostics it needed had been thrown away. Worse, if that second run happened
  to succeed it was still treated as a failure. The install is now attempted
  once, its output captured and reused for diagnosis (and printed verbatim when
  it fails). Adds `--prefix <dir>` / `FORGE_PREFIX` for a no-sudo user-owned
  install, plus a writability and free-space pre-flight. (No network pre-flight:
  forge has zero dependencies, so installing this local folder never hits the
  registry.) New `tests/test-install.mjs` (8 checks, hermetic via a stub `npm`).
- **Non-deterministic recency ordering in `listPlans()` and `sessionFiles()`** —
  both sorted by mtime alone, which is not a total order: two files written
  inside one filesystem timestamp tick tie, and the resulting order was whatever
  `readdir` happened to yield. This surfaced as a CI-only flake (the plans suite
  failed on a runner whose mtime granularity is coarser than the dev machine's)
  but the session case was worse: `pruneSessions()` **deletes** everything past
  the cap in that order, so a tie could have dropped a newer session. Both now
  tie-break deterministically (plans by slug; sessions by descending
  ISO-timestamped filename, which is also recency-correct). The plans and
  sessions suites assert recency with explicit mtimes instead of wall-clock gaps,
  and pin the tie-break behavior.

### Added
- **Export coverage harness** (P2-2) — `npm run coverage` reports, per module,
  how many exported symbols are named by at least one test, with a total. It is
  deliberately crude (a name-appears-in-tests heuristic that over-counts trivial
  constants and cannot see indirect e2e coverage) and says so in its own output —
  but it makes "this module has no direct test at all" impossible to miss. Runs
  in CI as a non-blocking, informational job. Measured **43% → 67.4%** over this
  release.
- **Direct tests for config.js, health.js and version.js** — three load-bearing
  modules (every command reads config, failover reads/writes the health cache,
  the version drives the banner and the manifest) that had 8%/0%/0% export
  coverage and no direct tests. `tests/test-config.mjs` (32 checks) covers the
  save/load round-trip and its 0600 permissions, key masking in `maskKey` and
  `safeView`, dotted get/set/delete, recent-model capping, and health-cache
  merge semantics plus corrupt-file resilience.
- **Provider failover in the interactive chat loop** (extends P1-3) — failover
  previously covered only the autonomous agent. Now `forge chat` also falls
  through to the next configured provider when the active one fails before any
  output is shown (transient or auth errors), announcing the switch. Still
  opt-in (`failover: true` / `FORGE_FAILOVER=1`); a mid-stream failure after text
  has appeared is not switched (it would duplicate output). The failover-worthy
  check is now shared (`isFailoverWorthy`) between the agent and chat loops.
  `tests/test-failover.mjs` grows to 18 checks (classifier + a live runChat
  recovery run).

## [20.2.0] — "no lost work"

### Added
- **Continuous integration** (P2-1) — `.github/workflows/ci.yml` runs the Node
  unit suites on Node 20 & 22 and the full suite (e2e + clean-room install) on
  every push and pull request, so the tests actually run on GitHub. The repo had
  no CI before.
- **Single-command test runner** (`tests/run-all.mjs`, wired to `npm test`):
  runs all suites (security, providers, diffpatch, memory, e2e, cleanroom) as
  child processes and fails if any suite's exit code is non-zero. Env switches:
  `FORGE_FAST=1` (node suites only), `FORGE_SKIP_E2E=1`, `FORGE_SKIP_CLEANROOM=1`.
- **`forge memory` command** — inspect and curate long-term memory from the CLI:
  `list` (`--project` / `--all`), `add "note"`, `forget <n>`, `clear`, `prune`.
  Multi-line `LEARNING:` blocks are treated as single entries, so `forget` never
  splits one. New `tests/test-memory.mjs` (14 checks).
- **Memory hygiene** — `appendMemory` now skips exact-duplicate notes and
  auto-prunes each tier to the newest `MEMORY_MAX_ENTRIES` (500). Previously the
  memory files were append-only and grew without bound, slowly crowding the
  relevance-scored context injected into every run.
- **Provider failover** (P1-3, opt-in) — in the autonomous agent loop, when the
  active provider keeps failing on transient (429/408/5xx/network) or hard
  auth/not-found (401/403/404) errors and its retries are spent, forge falls
  through to the next configured provider (health-tested ones first) instead of
  killing the task. Every switch is announced and recorded in `health.json`.
  Enable with `forge config set failover true` or `FORGE_FAILOVER=1`; default
  off, so existing single-provider behavior is unchanged. New
  `tests/test-failover.mjs` (8 checks).

- **Never lose work on Ctrl-C** (P1-4) — interrupting a streaming answer used to
  discard it. The partial text is now kept in the session (marked, and `/retry`
  regenerates it); if nothing had streamed yet, the turn rolls back cleanly to a
  pre-turn snapshot instead of a fragile `pop()` that could orphan tool
  messages. New `tests/test-chat.mjs` (15 checks — also chat.js's first direct
  unit coverage, via `interruptedTurnResult` and `isShellLine`).

- **Structured diagnostics** (P2-6) — `--json` on the data commands (`sessions`
  incl. `--search`, `models`, `plugins`, `skills --check`, `memory list`) prints
  one JSON document and nothing else, so forge can be scripted. `FORGE_DEBUG=1`
  prints a compact per-run tool breakdown (steps, tool-call counts, runId) to
  stderr after an agent run. New `tests/test-json.mjs`.
- **Skill linting** (P2-5) — `forge skills --check` validates every installed
  skill: safe directory name, a non-empty SKILL.md with a description, no broken
  relative markdown links (documentation placeholders like `URL`/`path/to/…` are
  ignored), and a size budget. Exits non-zero on any issue. All 69 bundled skills
  pass. New `checkSkills()` + `tests/test-skills.mjs` (10 checks).
- **Session hygiene** (P1-6) — the session store grew without bound. It's now
  auto-capped at the newest 300 (pruned when a new conversation starts), and
  `forge sessions --search "text"` finds a past conversation by title, summary or
  message content, with a snippet. New `tests/test-sessions.mjs`.
- **Relevance-ranked context (BM25)** (P3-2) — new zero-dep `retrieval.js`
  ranks the repo map and long-term memory by BM25 relevance to the current task
  instead of by symbol count / raw token overlap. BM25 down-weights common terms
  (IDF) and saturates term frequency, so the files and notes most relevant to the
  task surface first within the same token budget. New `tests/test-retrieval.mjs`
  (11 checks).
- **Tool plugin API** (P3-5) — drop a `*.mjs` in `~/.forge/tools/` exporting
  `{ name, description, parameters, run }` and it becomes an agent tool alongside
  the built-ins, behind the same choke point: output is secret-redacted, and a
  write-class plugin (the default; set `readOnly: true` to opt out) is serialized
  and blocked in read-only sub-agents. Bad plugins are skipped with a reason,
  never crashing the agent; names can't shadow a built-in. New `forge plugins`
  lists them; disable all with `tools.plugins: false`. Empty by default (no
  behavior change). New `plugins.js` + `tests/test-plugins.mjs` (16 checks).
- **Repo map / symbol index** (P3-1) — the agent's system prompt now includes a
  compact, bounded map of the project's source files and their top-level symbols
  (JS/TS, Python, Go, Rust), so it can locate code without spending tool calls on
  `ls`/`grep`. Respects the shared skip set + root `.gitignore`; bounded in files
  scanned, bytes/file, symbols/file and total size; built once per run; opt-out
  via `context.repoMap: false`. New `repomap.js` + `tests/test-repomap.mjs` (19).
- **Undo a whole agent run** (P3-4) — every checkpoint from one `forge agent`
  run is now tagged with a run id, and `forge undo --run` rolls the entire run
  back atomically (newest→oldest, so files return to their exact pre-run state
  even when the run edited a file several times). Plain `forge undo` still walks
  back one checkpoint at a time. The agent prints an undo-run hint when a run
  changed files. New `tests/test-checkpoint.mjs` (12 checks).
- **Plan persistence** (P1-9) — `forge agent --plan "task"` now saves the plan to
  `.forge/plans/<slug>.md` instead of printing and discarding it. New `forge plan`
  command: `list`, `show <n|slug>`, and `apply <n|slug>` (runs the agent on the
  saved plan) — the autonomous "plan, then execute" loop. New `tests/test-plans.mjs`.
- **Smarter file-tool walks** (P1-2) — `list_dir`, `grep_files` and `glob_files`
  now share one skip policy (they had diverged — `grep_files` was missing
  `.turbo`/`.cache`), broadened to common noise dirs (`.venv`, `venv`,
  `.mypy_cache`, `.pytest_cache`, `.gradle`, `.svelte-kit`, …), and additionally
  skip directories a project's root `.gitignore` ignores (bare-name entries;
  files stay readable). Less wasted context on generated output. New
  `tests/test-walk.mjs` (10 checks).

### Changed
- **Version is now a single source of truth.** `version.js` reads the version
  from `package.json`; `forge.js` and `chat.js` import it instead of each
  hardcoding `"20.0.0"`. A version bump now touches one file, not three, and can
  no longer drift out of sync with the manifest.

## [20.1.0] — "safe by default"
- P0 hardening: interpreter-wrapper unwrapping in shellguard, `$VAR` target
  expansion, four secret-redaction gaps closed, streaming/bounded `read_file`,
  gzip checkpoint backups (per-file cap 2 MB → 64 MB). See `PLAN-v21.md` §3.

## [20.0.1] — patch
- Fixed 11 defects the v20 suite missed (shellguard crash on `mv`/`cp`,
  `glob_files` `**/` root miss, `doctor` false-positive, malformed tool args,
  provider HTML/reset/terminated errors, checkpoint >2 MB silent skip, terminal
  auto-detect swallowing sentences). See `PLAN-v20.md`.

## [20.0.0]
- Standalone terminal AI agent: zero dependencies, direct-to-provider,
  terminal-in-chat, coding agent with 17 hardened tools, 69 skills.
