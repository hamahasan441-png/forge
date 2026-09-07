# FORGE — FINAL AUDIT REPORT

**Branch:** `arena/01a07c59-forge` · **Base:** `b093dcf` · **Head:** `d175992` (pushed, **CI green**)
**CI:** `gh pr checks 17` → `node suites (Node 20) pass · node suites (Node 22) pass · full suite (e2e + cleanroom) pass · export coverage pass`
**Scope:** `agentv19/` — `forge-agent-cli` v21.0.0 (ESM, zero runtime deps, Node ≥18; local Node v22.22.3)
**Date:** 2026-09-07
**Method:** audit → locate root cause → reproduce → patch → regression test → run → repair failures → re-run → harden.
Every claim below is backed by a command that was actually executed; results are quoted verbatim from its output.

---

## 0. The baseline in one line

`npm test` before this work: **28 suites, all green, ~16 s.**
`npm test` now: **55 suites, 2 432 assertions, 0 failures, ~120 s** — the original 28 suites still pass
with their original assertion counts (nothing was weakened to make a new test pass).
CI (`.github/workflows/ci.yml`, both Node 20 and Node 22, plus the e2e + clean-room lane) is **green**.

**Correction to the first version of this report:** the audit branch initially turned CI **red**. The
cause was not a product defect — it was `test-resource-leaks.mjs` (§2). Fixed and guarded; see §2.1.

---

## 1. FIXED

Root cause → fix. Each item has a regression suite; the suite name is in brackets.

### 1.1 Completion was declared before the work was done (P0)

| # | Defect (reproduced) | Fix | Suite |
|---|---|---|---|
| 1 | **1 of 3 DAG nodes finished ⇒ task reported COMPLETED.** Completion was derived ad hoc at the call site instead of asking the graph. | New `completion.js` → `canCompleteTask(task)` is the **single authoritative gate** (9 checks, §5). `dag.allComplete()` is the canonical "all required nodes complete" test and works on a live graph *or* a serialized task record. | `test-whole-dag-completion` (39) |
| 2 | **Execution success was treated as node completion.** A node went RUNNING → COMPLETED as soon as its tools ran cleanly — before anything was verified, so a node reported "completed" while its own test run had just failed. | State machine is now `RUNNING → EXECUTION_SUCCEEDED → VERIFYING → COMPLETED ⎮ REPAIRING`. `dag.markCompleted()` **refuses** to complete a node without evidence (`requireVerification`, default true). | `test-node-verification-gate` (42) |
| 3 | **Node attribution by guesswork.** Filename/keyword overlap decided which DAG node a segment had completed. | The explicit `nodeId` is carried Meta → Agent → Tools → Events → Verification → TaskState → DAG. `attributeSegment` still runs but is **diagnostic only** (`applied: false`, emitted as `DAG_DIAGNOSTIC_ATTRIBUTION`). | `test-exact-node-attribution` (43) |
| 4 | **Invalid plan fell through into execution.** A plan that failed validation was "repaired" and then executed anyway; an empty plan silently collapsed into one generic mutation node. | TASK → PLAN → SCHEMA → DEPENDENCIES → TARGETS → CONFLICTS → VERIFICATION PLAN → DAG → EXECUTION, with a real repair + **re-validation**; still invalid ⇒ `WAITING` with the reasons recorded. Execution is unreachable with an invalid plan. | `test-invalid-plan` (30) |
| 5 | **The segment safety fuse reported FAILED.** Hitting `maxSegments` was treated as task failure and threw away the work. | Fuse = CHECKPOINT → PERSIST → **WAITING / `CONTINUE_REQUIRED`**, bounded by `agent.maxContinuations` (default 5) and recorded in the task (`continuation_count` + `noteContinuation()`); past the budget the task genuinely is FAILED. | `test-max-segment-continuation` (18) |

### 1.2 Verification could be satisfied by nothing (P0)

| # | Defect | Fix | Suite |
|---|---|---|---|
| 6 | **An unobserved exit status counted as success.** A command killed by a signal, OOM-killed, or that never reported a code was stored as `exitCode: 0 ⇒ passed: true`. | `UNKNOWN_EXIT_CODE = null` (falsy *and* distinct from 0). Passing requires an **observed** exit status of 0, no timeout, and no failure shape. Shapes (`FAILURE_SHAPES`: signal / killed / timeout / oom / panic / permission / not_found / no_tests / build / test / generic) are classified and stored; `resolveExitCode` reconstructs 124 / 137 / 128+SIGSEGV from output. | `test-unknown-exit-code` (48) |
| 7 | **Final risk was the planning risk.** A task described as "add a comment" was verified as `trivial` even after editing `package.json`, a migration and an auth module. | `finalRiskForChange()` recalculates risk from files changed/created/deleted, affected symbols, security-sensitive paths, mutating commands/tool calls, dependency/config/db/auth changes. Monotonically upwards (`trivial → critical`). Emits `FINAL_RISK_RECALCULATED`. | `test-final-risk-recalculation` (44) |
| 8 | **The verifier could write.** Read-only blocked write tools but not `bash`; `cat a.js > b.js` and `\| tee out` were allowed because the allow-list matched the command *prefix*. | `hasWriteRedirection()` (quotes stripped, `2>&1` and `/dev/null` excluded, `tee` handled) blocks redirections in read-only mode. `VERIFICATION_TOOLS` allow-list + `verificationAllows()`; `runAgent({verifier:true})` forces `readOnly` + `mode:"verifier"`. **VERIFY ⇒ READ_ONLY, REPAIR ⇒ WRITE.** | `test-verifier-readonly` (52), `test-verification-scope` (32) |
| 9 | **Evidence produced before the artifact changed still satisfied the gate.** | Verification epochs + staleness: evidence older than the artifact change is `STALE`; missing evidence is `MISSING`. Scope (`focused/regression/syntax/…`) is separated from identity (`node` vs `task`). | `test-verification-scope` (32) |

### 1.3 Timeouts, orphans, cancellation (P0)

| # | Defect | Fix | Suite |
|---|---|---|---|
| 10 | A timed-out worker's **late result could be reported as success**; an orphan that ignored cancellation vanished from the books. | Worker records carry `workerId/taskId/nodeId/segmentId/status/cancellationToken/startedAt/finishedAt`. Lifecycle = REQUEST_CANCEL → WAIT_FOR_SHUTDOWN → CONFIRM_NOT_RUNNING → PERSIST → RECOVER. A result produced after the deadline is discarded; an orphan stays counted **active**. | `test-worker-timeout-cleanup` (50) |
| 11 | **Settled worker records were never reaped** — unbounded map growth in a long session. | `reapSettled()` drops settled records beyond `maxRecords` (200), oldest-first; live/unsettled records are never removed. | `test-resource-leaks` (16) |
| 12 | A hung language server stalled an agent step for **20 s**. | `lsp.js` `DEFAULT_TIMEOUT_MS` 20 000 → 12 000 (callers may override via `spec.timeoutMs`). | `test-lsp-lifecycle` (17) |

### 1.4 Durability, state, recovery (P0/P1)

| # | Defect | Fix | Suite |
|---|---|---|---|
| 13 | **A terminal state that failed to reach disk was still reported COMPLETED.** | Every CRITICAL flush is accounted (`criticalPersistenceSucceeded`); a failed terminal write emits `CRITICAL_PERSISTENCE_FAILED` and **downgrades COMPLETED → WAITING** with an explicit message. | `test-checkpoint-integrity` (37) |
| 14 | **A resumed task re-planned from scratch**, discarding the DAG the interrupted run was executing. | Resume restores the recorded DAG (`PLAN_RESTORED`); the model is not asked to contradict work already done. | `test-crash-resume` (19), `test-checkpoint-restore` (31) |
| 15 | Side effects were assumed, not observed (a "successful" git commit that never happened). | `recovery.js` effect reconciliation: `EFFECT_STATUS = {DONE, PARTIAL, NOT_DONE, UNKNOWN}` over files, git operations and command kinds; a conflicted merge ⇒ PARTIAL + compensation. | `test-effect-reconciliation` (82), `test-git-recovery` (46) |
| 16 | DAG conflict locking compared ad-hoc target sets. | Canonical keys `file:` / `symbol:` / `dir:` / `resource:`; an explicit `conflictKeys` declaration wins, and an **empty** one is rejected by validation instead of silently ignored. Conflicting nodes are conservatively serialized. | `test-dag-conflicts` (37) |
| 17 | "Read-only" still mutated persistent agent state (memory / todo / config / plugins). | Read-only now blocks those writes too. | `test-readonly-state` (58) |

### 1.5 Honesty, routing, learning (P1)

| # | Defect | Fix | Suite |
|---|---|---|---|
| 18 | **Outbound requests advertised the wrong version** — `forge-agent/19.0.0` / `forge/20` hardcoded while `package.json` said 21.0.0. | User-agent built from the single `VERSION` source in `version.js`; a suite fails the build if any module advertises another. | `test-version-consistency` (27) |
| 19 | **Model routing was decided by model names.** | `modelstrategy` records what a model actually achieved (provider, task class, ok/crashed, repairs, verification pass rate, latency, tokens, tool calls) and routes on that history — measured `0.8824 → 0.8333` for a model after one failure. | `test-model-routing-history` (44) |
| 20 | **A lesson was a sentence, not a record** — retrieval was fuzzy text matching. | Lessons carry a derived failure class, symptoms, root cause, solution, files, symbols, ecosystem, model, strategy + usage accounting (confidence decays, retirement at ≤0.15). Added `TOOL_MISUSE` class, PHP and `error[E0xxx]` (Rust) ecosystem detection, and fuzzy `strategyHint` matching so "re-run" still warns about "re-run until green". | `test-lessons-schema` (49) |
| 21 | MCP/LSP process lifecycles were untested. | Suites spawn real stub servers and assert PID liveness, per-language server reuse, clean shutdown and timeout behaviour. | `test-mcp-lifecycle` (32), `test-lsp-lifecycle` (17) |

---

## 2. TESTED — commands actually executed and their real output

Environment: `agentv19/forge/`, Node v22.22.3, zero dependencies installed.

| Command | Result |
|---|---|
| `npm test` (full: 52 node suites + e2e bash + cleanroom bash + cleanroom-pkg) | `all 55 suite(s) passed` — 118.5 s, **2 432 assertions** |
| `npm test` (repeat, determinism check) | `all 55 suite(s) passed` — 119.8 s |
| `FORGE_FAST=1 npm test` (node-only fast lane) | `all 52 suite(s) passed` — 36.8 s |
| `FORGE_FAST=1 node ../tests/run-all.mjs` **from a relocated checkout** (`/tmp/altpath/deep/forge/agentv19/forge`) | `all 52 suite(s) passed` — 36.8 s |
| `node tests/test-<name>.mjs` (each new suite standalone, during development) | all 0 failures |
| `gh pr checks 17` (GitHub Actions, Ubuntu, Node 20 + 22) | **4/4 pass** — node suites 47 s / 42 s, full suite 2 m 12 s, coverage 9 s |

### Per-suite assertion counts (from the run logged to `/tmp/full-test-3.log`)

**New suites added by this audit — 923 assertions, 0 failures:**

```
whole-dag-completion 39   node-verification-gate 42   final-risk-recalculation 44
verifier-readonly 52      worker-timeout-cleanup 50   exact-node-attribution 43
dag-conflicts 37          readonly-state 58           invalid-plan 30
max-segment-continuation 18   verification-scope 32   unknown-exit-code 48
checkpoint-integrity 37   checkpoint-restore 31       crash-resume 19
effect-reconciliation 82  git-recovery 46             model-routing-history 44
mcp-lifecycle 32          lsp-lifecycle 17            clean-room-package 30
resource-leaks 16         version-consistency 27      lessons-schema 49
```

**Pre-existing suites — unchanged and still green (1 499 assertions)** + `path-hygiene 10`:
`security 241`, `ui 271`, `toolintel 172`, `semantic 93`, `capabilities 87`, `router 87`,
`provider 40`, `lsp 41`, `mcp 30`, `effort 37`, `plugins 24`, `autonomy 127`, `chaos 44`,
`repomap 19`, `memory 14`, `sessions 14`, `failover 18`, `plans 18`, `chat 20`,
`checkpoint 12`, `config 32`, `json 13`, `skills 10`, `install 8`, `package 6`,
`retrieval 11`, `walk 10`, `diffpatch`.

**Total: 2 432 assertions, 0 failures.**

### 2.1 The CI failure this branch caused, and how it was found and fixed

The sandbox cannot download GitHub Actions logs (`results-receiver.actions.githubusercontent.com` and
`*.blob.core.windows.net` are blocked), and the App token may not modify `.github/workflows/*`. So the
runner was taught to report on itself: `run-all.mjs` now emits a GitHub **annotation** (`::error::`) for a
failing suite, and annotations are readable through the Checks API (`gh api …/check-runs/<id>/annotations`).
That produced the answer verbatim:

```
failure  suite "leaks" failed
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/home/user/forge/agentv19/forge/meta.js'
imported from /tmp/forge-leak-K47KRA/drain-probe.mjs
  FAIL the child process exited on its own (wall 32ms, work 0ms)
== resource-leaks suite: 15 passed, 1 failed ==
```

**Root cause:** the child "drain probe" in `test-resource-leaks.mjs` imported `meta.js` by the *literal
sandbox path*. CI checks out under `/home/runner/work/forge/forge`, so the path did not exist — the suite
passed on the author's machine and failed every CI job. **A test that only passes in one directory is not
a test.**

**Fix:** the probe resolves the module from `import.meta.url` (`new URL("../forge/meta.js", import.meta.url).href`
— a `file://` URL is importable wherever the checkout lives).

**Guard (new suite `test-path-hygiene.mjs`, 10 assertions):** fails the build if any test bakes in a
machine-specific absolute path, if a relative import does not resolve, if a suite is missing from
`run-all.mjs`, or if a suite touches a home directory it did not create. Verified by re-introducing the
literal path in a scratch copy: `FAIL no hardcoded absolute paths (got 1, want 0)`.

**Also checked and cleared:** the suites were re-run under `LC_ALL=C`/`LANG=C`, `TZ=UTC`, `CI=true`, a
`HOME` outside the project, and 4× CPU load — the `ui` suite's PTY assertions are locale-sensitive
(they expect `✓`), which is worth knowing but is not what CI hit (CI sets `LANG=C.UTF-8`).

Repairs made during this audit (suite → failure → resolution, all re-run green):

| Suite | Failure seen | Root cause | Resolution |
|---|---|---|---|
| `test-resource-leaks` | `completed workers are capped (25 records)` | real defect: no reaping | added `reapSettled()` (fix #11) |
| `test-resource-leaks` | `next worker started after cancel (3002ms)` | **test** bug: fixture slept a fixed 3 s | runner now resolves on abort; slot measured, not sleep |
| `test-lsp-lifecycle` | `call did not hang forever (8002ms)` | 20 s default timeout | lowered default to 12 s; fixture passes `timeoutMs: 1500` |
| `test-clean-room-package` | `help lists commands` | real `--help` prints lowercase `usage` + ANSI | strip ANSI before asserting |
| `test-lessons-schema` | 11 failures | my expectations didn't match the real API | corrected the tests; the 3 real gaps found (PHP/Rust detection, `TOOL_MISUSE`, fuzzy strategy hint) were **fixed in the product** |
| `test-version-consistency` | `an outbound request was made` | tool is named `fetch_url`, not `fetch` | switched to `makeToolContext` + `fetch_url`/`web_search` |

---

## 3. SECURITY

Preserved and re-verified (no guard was removed — the diff's `-` lines are the *old* buggy
implementations being replaced; `git show HEAD --stat`: **6 580 insertions, 322 deletions**):

* **ShellGuard / SafePath / NetGuard** — `security` suite **241 assertions**, 0 failures (path escape, symlink
  escape, shell metacharacters, sudo, network egress, env allow-list).
* **Secret redaction** — asserted in `toolintel` ("a secret never lands in the tool record") and
  `security`; config keys are masked in `config show` and files are `chmod 600` (e2e).
* **Permission policy** — `assumeYes` / allow-lists / tool disablement still enforced; a disabled tool is
  removed from the model request rather than refused late.
* **New hardening in this audit:**
  * read-only mode now rejects shell **redirection** and `tee` (a verifier can no longer overwrite the file it verifies);
  * verification agents run under an explicit **tool allow-list** (no `write_file`/`edit_file`/`multi_edit`/`apply_patch`/`memory`/`todo`/`delegate`/mutating bash);
  * MCP servers are launched **only** from config, namespaced `mcp__<server>__<tool>`, treated as WRITE-class by default, and are off unless enabled;
  * LSP/MCP child processes are proven dead after `close()` (PID liveness checks, 5 connect/close cycles ⇒ 0 survivors);
  * a crafted `.mjs` / hostile LSP input / broken MCP command never throws — it is reported as an `ERROR…` string or an `errors[]` entry.
* **Outbound identity** is now truthful (fix #18), which is also a security property: you cannot audit traffic you mislabel.

---

## 4. DAG

* Canonical states: `PENDING → READY → RUNNING → EXECUTION_SUCCEEDED → VERIFYING → COMPLETED ⎮ REPAIRING`,
  plus `FAILED / BLOCKED / CANCELLED`. `UNFINISHED_STATUS` makes the gate's semantics explicit.
* `allComplete(graph, {optionalPolicy})` is the single source of truth; `incompleteRequiredNodes()` reports
  *which* nodes block; `graphNodes()` accepts a live graph, a serialized graph, or a plain array — so the
  gate can judge a task record loaded from disk without rehydrating it.
* Optional-node policy is explicit (`ignore` / `allow` / `block`); cancelled nodes never block.
* Conflict keys are canonical: `file:` / `symbol:` / `dir:` / `resource:`; `scheduleBatch()` serializes
  conservatively (a mutating worker never runs concurrently with a conflicting one).
* Provenance fields for future adaptive re-planning exist (`createdBy`, `createdReason`, `createdEvidence`,
  `parentNode`) — see REMAINING.
* Every transition is observable: `DAG_NODE_STARTED`, `DAG_NODE_EXECUTION_SUCCEEDED`, `DAG_NODE_AWAITING_VERIFICATION`,
  `DAG_NODE_COMPLETED`, `PLAN_VALIDATION_FAILED`, `PLAN_REPAIRED`, `PLAN_RESTORED`, `FINAL_RISK_RECALCULATED`.

---

## 5. VERIFICATION

`completion.canCompleteTask(task)` — the one gate, all nine checks:

```
validPlan · validDAG · allRequiredNodesComplete (dag.allComplete) · allWorkersSettled
verificationSatisfied (for the FINAL recalculated risk) · recoveryClear
noPendingRequiredActions · finalStateReconciled · criticalPersistenceSucceeded
```

Evidence model (`verifyledger.js`):

* `passed = observed && exitCode === 0 && !timedOut && !failureShape` — **unknown is never success**.
* Statuses: `PASSED / FAILED / PENDING / STALE / MISSING`.
* `scope` = evidence breadth, `identityScope` = whose evidence it is (node vs task) — a task-level test run
  no longer satisfies a node-level requirement by accident.
* Verifier context exposes only: `bash, git_status, glob_files, grep_files, list_dir, load_skill, read_file, think`.
* Node completion requires node verification (fix #2); repair loops back to VERIFYING, never to COMPLETED.

---

## 6. RECOVERY

* **Checkpoint**: full-file SHA-256 of every touched file before/after, with `PARTIAL` / `FAILED` semantics
  (`test-checkpoint-integrity`, `test-checkpoint-restore`).
* **Crash resume** — verified end-to-end, not just unit-tested:

  ```
  detected: 1 | task: crash-demo | status: EXECUTING | seg: seg-3
  canResume: true | recommended: "resume"
  prompt: Resuming an interrupted task (status was EXECUTING, 0 segment(s) done). …
          Do NOT blindly re-run the last command. First inspect the current state…
  ```

  A task left in a non-terminal state with a **dead pid** is detected by `detectInterrupted()` at startup
  (`forge tasks` also offers `forge tasks --resume <id>`); `WAITING / CONTINUE_REQUIRED` tasks are *deliberately*
  paused, so they are correctly **not** reported as crashes.
* **Segment safety fuse**: CHECKPOINT → PERSIST → WAITING / `CONTINUE_REQUIRED` → RESUME, with
  `continuation_count` persisted and bounded by `agent.maxContinuations`. Verified:
  `WAITING transition accepted: true | status on disk: WAITING | waiting_reason: "safety fuse: 8 segments reached — CONTINUE_REQUIRED"`.
* **Effect reconciliation**: files, git operations (commit verified by HEAD movement; a conflicted merge ⇒
  `PARTIAL` + compensation) and command kinds are *observed*, not assumed (82 + 46 assertions).

---

## 7. PACKAGING

`npm pack` tarball audited by `test-clean-room-package` (30 assertions):

* **1 011 entries**; ships `package.json`, `forge.js`, `completion.js`, `dag.js`, `verifyledger.js`, …
* **No** `tests/`, `.git/`, `PLAN*.md`, `node_modules/`, `.map` or `.tsbuildinfo` in the tarball.
* **Zero runtime dependencies**; `files[]` whitelist includes `completion.js`.
* Pristine `npm install` into a temp dir from a **foreign cwd**: `forge --version` → `forge v21.0.0`,
  `--help` OK, `config --json` valid JSON, `doctor` and `skills --check` exit 0/1.
* A clean `FORGE_HOME` is left behind — no test artifacts leak into the user's home.

---

## 8. PERFORMANCE

Measured by `test-resource-leaks` (16 assertions) and the runner's own timings:

| Metric | Measured |
|---|---|
| A full run's own work | **32–44 ms** (no hidden waiting) |
| Active handles after a run | **2** (`PipeWrap` ×2 = stdio), **0** requests |
| Pending `Timeout` handles left behind | **0** (child process exits on its own: wall − work = **70–77 ms**) |
| Heap growth over 5 `runMeta` runs | **+1.4 MB** (bounded) |
| Worker records after 25 spawns | capped at `maxRecords` (was: unbounded) |
| Cancelled worker stops and frees its slot | **1 ms**, next worker starts immediately |
| Hung LSP request returns | **1 501 ms** with `timeoutMs: 1500` (was 8 002 ms via the 20 s default) |
| MCP connect/close × 5 | **0** surviving child processes |
| Full `npm test` | **119.8 s** (54 suites); fast lane `FORGE_FAST=1` **36.9 s** (51 node suites) |

No performance regression was introduced; the two dominant costs are deliberate fixtures
(`ui` 41.2 s, `worker-to` 10.1 s).

---

## 9. RELEASE

* **Version:** `21.0.0` — single source of truth in `package.json`, read via `version.js`; now used by every
  user-agent, the banner and `--version` (fix #18). `CHANGELOG.md` states the rule and documents every fix above.
* **Changes:** 45 files, **+6 580 / −322**. 20 modules patched, 1 new module (`completion.js`),
  **24 new regression suites** (3 566 lines) plus registration in `tests/run-all.mjs`.
* **Commits:** `47434f4` (audit fixes + 24 suites), `d446205` (this report), `0af4074` (CI annotations),
`d175992` (location-independent tests + `test-path-hygiene`).
* **Pushed** to `origin/arena/01a07c59-forge`; **CI green on all four checks**.
* **PR:** https://github.com/hamahasan441-png/forge/pull/new/arena/01a07c59-forge
* **Release gate:** `npm test` green three times consecutively (55/55, 2 432 assertions) **and**
  `gh pr checks` green on Node 20 and Node 22.

---

## 10. REMAINING — known gaps, honestly stated

Nothing below is a claim of success; none of it is hidden by a test.

1. **No live-model end-to-end DAG run.** The controller is exercised through in-process fixtures and a mock
   provider; a real-provider multi-node run (with real latency, real tool failures, real streaming) is not part
   of `npm test`. Recommended next: a nightly `FORGE_E2E_LIVE=1` job against a cheap model.
2. **Adaptive DAG is prepared, not implemented.** `createdBy / createdReason / createdEvidence / parentNode`
   exist, but no controller path *adds or removes* nodes mid-run yet. Until then, re-planning after a wrong
   decomposition still means a new task.
3. **Verification commands are not sandboxed.** They run in the project directory with the normal shell,
   guarded only by ShellGuard/permission policy. A container/namespace sandbox remains the right fix.
4. **`attributeSegment` still exists** as a diagnostic. It cannot mutate DAG state (`applied: false`), but it is
   dead weight if observability never consumes it — candidate for deletion once dashboards use the events.
5. **Worker-record reaping is a cap, not an archive.** Beyond 200 settled records the oldest are dropped from
   `stats()`; long-session forensics must read the on-disk journal, not the manager.
6. **Model routing history is local and unweighted by cost.** It records outcomes (fix #19) but has no cost
   model and no cross-project aggregation; there is no external benchmark harness (SWE-bench style).
7. **Recovery of a partially applied multi-file edit** is file-level (SHA + PARTIAL), not semantic: forge can
   tell you a file is half-written, not that an edit was applied to the wrong symbol.
8. **No vision / browser / multimodal tool**; LSP has no auto-install of language servers and no cross-session
   server persistence (by design — a server is owned by its session and proven dead after `close()`).
9. **Two suites are wall-clock sensitive** (`worker-timeout-cleanup` 10.1 s, `ui` 41.2 s). They passed
   under a deliberate 4× CPU load in this environment, but timing assertions are inherently fragile.
10. **The `ui` PTY assertions depend on the locale.** Under `LC_ALL=C` (no UTF-8) the banner glyph `✓` is
    not rendered as expected and 5 PTY assertions fail; GitHub sets `LANG=C.UTF-8`, so CI is fine, but a
    contributor with a non-UTF-8 locale will see red. The right fix is for the UI to choose ASCII glyphs
    when the locale cannot represent them (or for the suite to force `LC_ALL=C.UTF-8` itself).
11. **POSIX-only validation.** Path handling, `chmod 600` and process-tree liveness are exercised on Linux only;
    Windows is untested.
