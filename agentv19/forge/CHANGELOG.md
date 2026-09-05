# Changelog

All notable changes to **forge** are recorded here. The version is defined in
exactly one place — `package.json` — and read at runtime via `version.js`.

## [Unreleased] — v20.2.0 "no lost work" (in progress)

### Added
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
