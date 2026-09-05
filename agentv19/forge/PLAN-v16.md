# forge v16 "RESILIENT+" — enhancement & improvement plan

Base: v15 "OMNITOOL" (shipped: 17-provider direct CLI, 15 auto-used tools, streaming
tool-calls on both wires, 75/75 E2E). v16 makes the agent **safer to change things,
harder to blow up context, and easier to install** — the three things real daily
drivers hit first.

## 1. Audit findings on v15 (fixed in this release)

| # | Finding | Fix |
|---|---------|-----|
| A1 | `forge` (bare, TTY, unconfigured) could run the onboarding wizard TWICE (onboardIfMissing → needProvider→null → runOnboarding again) | single onboarding path; second pass just prints guidance |
| A2 | install.sh had no Node ≥ 18 version guard → old Node dies with a cryptic ESM SyntaxError | explicit version check with human message |
| A3 | install.sh printed nothing useful when npm's global bin dir is not on PATH ("forge: command not found" after a "successful" install) | installer now resolves `npm prefix -g`/bin, verifies `forge` is reachable, and prints the exact PATH line to add |
| A4 | Global npm install under a root-owned prefix (common on Linux) failed with EACCES and no guidance | detect EACCES → print the 3 working options (sudo / user prefix / direct run) |
| A5 | No documented uninstall | README + help: `npm uninstall -g forge-agent-cli` |
| A6 | `doctor` never validated the environment (node version, config writability) | doctor now reports node ≥ 18, config file writable, skills dir found |
| A7 | One assistant message per tool call was pushed to history (N assistant messages for N calls) — works, but not canonical wire format | single assistant message carrying ALL tool_calls (OpenAI-strict-safe) |

## 2. New capabilities (7)

### 2.1 Checkpoints & rewind (headline)
- Every file mutation (`write_file`, `edit_file`, `multi_edit`, `apply_patch`)
  auto-snapshots the original file(s) BEFORE writing → `~/.forge/checkpoints/<id>/`
  (manifest.json + raw backups, cwd recorded, 2MB/file cap, last 30 kept).
- `forge undo` / chat `/undo` restores the most recent checkpoint **for the current
  working directory**; repeated calls walk back through history (checkpoint consumed
  on restore). `/undo` in chat ALSO drops the last exchange as before.

### 2.2 `apply_patch` tool (Codex-CLI-style unified diff)
- Input: a standard unified diff (one or more files). Supports creation
  (`--- /dev/null`) and deletion (`+++ /dev/null`), `@@` hunks with context,
  `\ No newline at end of file`.
- Robust anchoring: hunk applies at its declared line, else fuzz-searches ±40 lines
  for the context block; whole patch validated (dry-run) before ANY file is written —
  atomic across files. Fuzzy mismatch > tolerance → clear error, zero changes.
- Implementation: new `diffpatch.js` (pure functions, zero deps).

### 2.3 `git_status` tool
- Read-only repo awareness: branch, porcelain status (capped), last 5 commits,
  diffstat vs HEAD. Lets the agent check repo state before editing instead of
  burning `bash` calls. Errors cleanly outside a repo.

### 2.4 Parallel tool execution
- Read-only tools in one round run concurrently (`Promise.all`); write tools
  (`bash`, `write_file`, `edit_file`, `multi_edit`, `apply_patch`) stay serialized
  to avoid write conflicts. Results reassembled in the ORIGINAL call order so the
  wire stays deterministic. Applies to the agent loop AND chat auto-tools.
- Latency win: a round with k independent reads costs max(t) instead of sum(t).

### 2.5 Auto-compaction (context engine)
- When chat history exceeds `chat.compactAtChars` (default 48,000 ≈ 12k tokens) and
  has enough turns, older turns are summarized by the model into a single
  `AUTO-COMPACTED SUMMARY` user message; the recent tail stays verbatim; tool
  fragments are dropped on the boundary (provider-safe).
- `/compact` forces it; `chat.compact: false` disables. Summarizer failure →
  graceful continue with full history.

### 2.6 `/usage` — session tokens & cost
- Cumulative prompt/completion tokens + request count for the running chat session.
- Optional cost estimate when `providers.<name>.priceIn` / `priceOut` (USD per 1M
  tokens) are set in config. Usage also persisted into the session file.

### 2.7 Plan mode (`forge agent --plan`, chat `/plan`)
- First pass runs a READ-ONLY agent (same 17 tools minus all write tools) with a
  planning brief → prints a step-by-step plan.
- Interactive TTY: confirm to execute the real run. Non-TTY: prints the plan and
  exits (script-friendly). `/plan <task>` does the same inside chat.

## 3. Tool surface: 15 → 17

| tool | type | notes |
|------|------|-------|
| `apply_patch` | write | unified diff, atomic, multi-file, create/delete |
| `git_status` | read | branch + status + log + diffstat |

`doctor --tools` self-tests both (git_status inits a throwaway repo; apply_patch
round-trips a real patch in a temp dir).

## 4. Wire & correctness hardening

- Canonical tool_calls history (one assistant message per round).
- Checkpoint-on-write is inside the tool layer → BOTH chat auto-tools and the agent
  loop are covered with zero duplicated logic.
- Compaction trims to a user-message boundary (no leading tool/tool_call turns →
  no provider 400s, same invariant as v15's `compact()`).
- `streamChatResilient` unchanged (v15 guarantee holds: no retry after partial
  output, tool-call events count as emitted).

## 5. Installation fixes (the "make install just work" release)

- install.sh rewritten: version guard → npm install → EACCES fallback guidance →
  PATH verification with the exact export line → final `forge version` proof.
- forge.js: no double onboarding; `forge doctor` env section (node version, config
  writable, skills found); uninstall documented.
- Clean-room re-verified: `npm i -g .` from a fresh shell, `forge` from a foreign
  cwd, `forge doctor`, skills resolved from the global package dir.

## 6. Verification

- E2E battery extended: **75 → 97 checks** — new: apply_patch create+modify round
  trip, atomic-failure assertion (bad patch = zero changes), `forge undo` restores
  previous file content, git_status inside a throwaway repo, parallel dual-read
  round, `/usage`, `/compact`, auto-compaction trigger, plan mode (prints plan,
  does not execute, non-TTY exits), install checks.
- `node --check` on every module; clean-room `npm i -g .` install test; cold-start
  timing; final `agentv16.zip` (rm -f + pollution guard + `unzip -t`).
