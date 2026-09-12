# Changelog

All notable changes to **forge** are recorded here. The version is defined in
exactly one place — `package.json` — and read at runtime via `version.js`.

## v92.0.0 — "PROCREW"

`/agent` becomes a team of senior engineers instead of one agent with a plan.
The named crew from v91 was advisory — it produced text. In v92 it **executes**:
specialists run as real sub-agents, in parallel, under one scheduler; every
completed task runs the same verification pipeline; and the Memory Agent records
what worked and what was refused, so a rejected approach is never bought twice.
`agent.pipeline:false` restores the exact v91 verification path, and
`agent.crew:false` turns the sub-agent fan-out off.

### Added (v92.0)

- **`crew.js` — the crew as an executable scheduler.** `workUnits()` turns a plan
  into named-specialist units (the plan's own role wins; otherwise the wording
  picks the specialist). `dedupeUnits()` refuses duplicate work *before* it costs
  a model call. `waves()` groups units so two units that touch the same file are
  never in flight together — using `dag.canonicalConflictKeys`, the same key
  space the DAG scheduler uses, so the two schedulers cannot disagree.
  `reassignFor()` retries a failed unit under a *different* specialist (the same
  role asked twice is a loop, not a retry) and returns `null` when the ladder is
  honestly exhausted. `selfReview()` reviews each finding against the existing
  adversarial checklist before it may be merged; a finding that fails review is
  re-run once with the issues attached. A sub-agent is never promoted to writer —
  the executor stays the only mutating role.
- **`pipeline.js` — the verification pipeline.** Every task runs
  build → lint → typecheck → test → validate, taken from the project's OWN
  manifests. A stage with no real command is reported **skipped with the reason**
  and never faked. Pass/fail is `verifyledger.evaluateVerification`'s call, not a
  second opinion: an unobserved exit status, a timeout, a truncated capture or a
  killed process is still not a pass, and `exit 0` with a failure shape in the
  output still fails. A repair hook re-runs the stage; without one there is
  exactly one attempt, because re-running an unchanged command is not a strategy.
  `diagnose()` returns shape + hint + tail from the ledger's own vocabulary.
- **Memory Agent verdicts (`memory.js`).** `recordVerdict`, `verdicts`,
  `isRejectedApproach`, `verdictBlock`: accepted and rejected *approaches*,
  stored as tagged bullets in the project tier (same file, lock, redaction and
  dedup as the rest of memory, still plain text a human can edit). A later
  `accepted` verdict for the same shape cancels the rejection. `lessons.js` keeps
  failure *classes*; this records *decisions*, which had no home before.
- **`forge verify`** — run the pipeline on demand
  (`--only`, `--skip`, `--timeout`, `--json`; exits 1 on failure).

### Changed (v92.0)

- **meta.js**: the read-only fan-out is now routed through `crew.runCrew` — one
  scheduler for sub-agent work instead of a per-call-site loop. What did NOT
  change: the runner is still `agentmanager.spawn` → `runAgent` (one tool loop,
  one set of budgets), evidence still lands in the same ledger, a node still
  completes only WITH evidence, and the fan-out is still bounded by the same
  deadline. New events: `CREW_DISPATCH`, `CREW_UNIT`, `CREW_REASSIGNED`,
  `CREW_UNIT_SKIPPED`, `CREW_MERGED`, `CREW_DUPLICATE_SKIPPED`,
  `CREW_REJECTED_APPROACH`, `CREW_DEADLINE`, `CREW_FAILED`, `PIPELINE_PLANNED`,
  `PIPELINE_STAGE(_STARTED)`, `PIPELINE_REPAIR`, `PIPELINE_RESULT`,
  `PIPELINE_DIAGNOSIS`, `PIPELINE_ERROR`. `runMeta` now returns `crew` and
  `pipeline` alongside `objective` and `report`.
- **The pipeline runs BEFORE the completion gate is judged**, so its evidence is
  in the ledger the gate reads. A repair invalidates it (`pipelineStale`) and the
  next verification pass re-runs it on the fixed code instead of trusting
  evidence that predates the fix.
- **report.js**: the final report's Analysis section now carries the crew run
  (findings/units, model calls, reassignments, duplicates refused, rejected
  approaches skipped) and its Verification section carries the pipeline table.
  An empty report still says so — neither is ever invented.
- **langengine.js**: `stackFor(cwd, files)` extracted from `recommendedVerify` so
  the pipeline can ask for the whole stack (test AND lint AND typecheck AND
  build) instead of only the first command that happens to exist. The matching
  rule stays in exactly one place; `recommendedVerify` is unchanged.
- **config.js**: `agent.crew`, `agent.pipeline`, `agent.verifyTimeoutMs`
  (default 300s per stage). `agent.pipeline:false` restores the exact v91
  verification behaviour. `agent.crew:false` turns the sub-agent fan-out OFF —
  there is one scheduler, so there is no second code path to fall back to; the
  DAG's read-only nodes are then executed one at a time by the main agent
  through the existing no-mutating-node-ready path, so nothing is orphaned.

### Fixed (v92.0)

- Duplicate DAG nodes were never completed: the duplicate record carried the
  *unit* id while the graph is keyed by *node* id, so the lookup silently matched
  nothing. Duplicates now carry `stepId` and the node completes with its twin as
  the recorded evidence.
- `runMeta` referenced a `planOnly` binding that does not exist in its scope —
  a `ReferenceError` on every autonomous run the moment the pipeline was enabled
  (plan-only runs never reach `runMeta` at all).
- `crew.js` and `pipeline.js` were missing from `package.json` `files[]`, so a
  published tarball would have shipped `meta.js` importing two files that were
  not there.
- "run the unit tests and report which fail" was dispatched to the debugger
  because the debug pattern matched `fail` first; the tester's pattern is now
  narrow ("run the tests", "test suite", "coverage") and ordered first.
- `forge verify --json` exited 0 when the project defines no runnable stage. It
  now exits 1 — "nothing to verify" is not a pass.

### Verified

`npm test` — 137 suites, including `e2e` and `cleanroom` (npm install from the
packed tarball). `tests/test-v92.mjs` adds 150 assertions covering work units,
dedupe, conflict waves, reassignment, self-review, the verdict store, every
pipeline branch (pass, fail, lying-green, unknown status, repair, no-repair,
stop-on-failure, empty plan), the `stackFor` refactor, and the CLI exit codes.

## v91.0.0 — "ULTIMATE"

`/agent` becomes a permanent autonomous engineering intelligence: a named crew,
an objective engine that stops on *verified objective satisfaction* instead of a
step count, a ten-section final report, docs & git intelligence, and a
self-review → self-upgrade → rollback loop. Everything is **additive**:
`agent.orchestration` / `agent.objective` / `agent.report` set to `false`
restore the exact v90 path (pinned in test-v91 §10). No new dependency, no new
model call in the deterministic paths, no second data root.

### Added (v91.0)

- **`objective.js` — the objective-based task engine.** A run ends when the
  existing 9-check completion gate says the objective is met (`DONE`,
  `GATE_SATISFIED`), when an unrecoverable blocker is recorded (`BLOCKED`), or
  when the operator cancels. A budget or segment fuse lands in `WAITING` /
  `FUSE` — **never** in `DONE`. Twelve explicit phases
  (ANALYZE → RESEARCH → REVIEW → PLAN → APPROVE → EXECUTE → VERIFY → REPAIR →
  OPTIMIZE → DOCUMENT → REPORT → LEARN) with per-phase state, timing and
  checkpoints persisted under the one forge data root
  (`~/.forge/projects/<hash>/objectives/`, atomic 0600 via `securefs`), so a
  crashed run resumes from the last completed phase and re-verifies instead of
  trusting inherited evidence. Loop detection fingerprints
  `(phase, action, args)`: the same action three times with identical arguments
  is a stuck agent, not progress — it emits `LOOP_DETECTED`, records a strategy
  pivot, and writes a lesson so the next plan skips that approach. Progress is
  derived from phase state + gate checks (never steps burned), and a
  `CONTEXT_COMPRESSION_REQUESTED` event fires when carried context passes the
  budget instead of silently dropping history.
- **`orchestra.js` — the master orchestrator roster.** Thirteen named roles
  (Intent Analyzer, Researcher, Reviewer, Planner, Project Architect, Executor,
  Tester, Debugger, Optimizer, Documentation Writer, Git Manager, Memory
  Manager, Reporter) mapped onto the **existing** `agentmanager.ROLES`, so
  read-only/write authority cannot drift between two vocabularies. The crew is
  derived from `strategyFor(klass).workflow` plus a class floor (MICRO 5 →
  LARGE/ARCHITECTURAL 13) — no second strategy table. Exactly one mutating
  member, always the Executor; every other role is dispatched read-only, and the
  row states both authorities where they differ (agentmanager allows `debugger`
  to mutate; the orchestration does not grant it — repairs go through the single
  writer). `advisories()` assembles the deterministic evidence pack (memory,
  learnings, typed knowledge, claims, decisions, blast radius from the compose
  graph, verification ledger, worker findings, gate) with **zero** model calls.
- **`report.js` — the final report.** Ten sections in a fixed order (Analysis,
  Review Findings, Execution Plan, Progress, Verification Results, Files
  Changed, Bugs Fixed, Performance Improvements, Remaining Issues, Recommended
  Next Improvements), built from evidence that already exists (objective record,
  task state, gate, ledger, review checklist, advisory crew, doc deltas). A
  section with no evidence says so in one line — it never invents a plausible
  sentence. Persisted to `~/.forge/projects/<hash>/reports/`.
- **`docsintel.js` — documentation & git intelligence.** Pure over diff text
  (the v90 `git_diff` view supplies it; nothing here shells out to git).
  Detects breaking changes — removed/renamed exports, removed CLI subcommands,
  removed environment variables, newly required parameters, tightened schema
  `required` lists, major version bumps — and turns them into a doc plan
  (README / CHANGELOG / API / migration, each saying whether the file actually
  exists), a CHANGELOG section in this repo's format, per-break migration notes,
  and a conventional commit message with a `BREAKING CHANGE:` footer and real
  diff numbers.
- **`selfup.js` — self-review, self-upgrade, rollback.** `selfReview()` is
  deterministic static analysis (same tree ⇒ same findings, so it can be diffed
  before and after an edit): duplicate logic (formatting- and literal-insensitive
  6-line windows), dead export surface (with importers resolved across
  multi-line import lists), import cycles (Tarjan SCC), oversized modules and
  over-long functions, security smells (eval, shell interpolation, world-writable
  modes, credential-shaped literals, weak randomness for security values) and
  unfinished work (TODO/FIXME/HACK/XXX). Comments, string contents and regex
  literals are stripped before pattern matching, so the checker never flags its
  own pattern table. `upgradePlan()` turns findings into proposals that each
  carry evidence, impact, risk and a verification command; `applyUpgrades()`
  writes through a versioned manifest whose entries record their **inverse**,
  and `rollbackUpgrades()` restores from it. **Hard invariant:** a self-upgrade
  never writes source files — config, project memory and additive files only
  (code changes are proposed, never auto-applied). `syntaxCheck()` verifies with
  real `node --check` runs.
- **CLI:** `forge self-review`, `forge self-upgrade --plan|--apply`
  (`--dry-run`, `--only`), `forge rollback` (`--all`, `--id`),
  `forge report [id|list]`, `forge docs` (`--base`, `--diff`, `--message`),
  `forge roles --crew [--class]`.
- **Chat:** `/agent crew|self-review|self-upgrade|rollback|report|docs` plus the
  same five as top-level commands, in the palette, Tab completion and `/help`.
- **meta.js integration:** `OBJECTIVE_STARTED`, `OBJECTIVE_PHASE`,
  `LOOP_DETECTED`, `CONTEXT_COMPRESSION_REQUESTED`, `OBJECTIVE_VERDICT` and
  `FINAL_REPORT` events; `runMeta()` now returns `objective` and `report`.
  A planning failure is recorded as a blocker with a report, not swallowed.

### Fixed (v91.0 — found by the new suites, before release)

- **`gate.checks` is an object map, not an array.** `completion.js` returns
  `{ checkName: bool }`; three new consumers assumed a list and threw
  (`x.map is not a function`), which silently suppressed the final report.
  Every consumer now reads gates through one normalizer
  (`objective.gateChecks` / `gateBlockers`) that accepts either shape.
- **A changed signature line lost its second fact.** `+export function f(a, b, c)`
  matched the export-name rule and returned early, so the tightened signature
  was never recorded and no `SIGNATURE_TIGHTENED` break was reported. One line
  can now carry several facts.
- **Multi-line import lists were invisible to dead-export analysis**, inflating
  findings with false positives (e.g. `riskAtLeast`, imported by
  `tests/test-capabilities.mjs`, was reported dead). The import matcher now
  crosses newlines but never a `;`.
- **A truncated finding list could drop every HIGH finding.** The review cut is
  now severity-ordered after a per-category ceiling, so the most severe findings
  always survive.
- **Token counts were mangled by secret redaction** (`12in/34out` matches a
  key/value shape). The report phrases them as words; `secrets.js` is unchanged
  and stays exactly as strict.
- **A re-run verdict left negative phase durations**; the phase table now clamps
  and `finish()` always stamps the current time.

## v90.0.0 — "gitwise"

### Fixed (v90.0 — the silent stop)
- **An empty model response no longer ends the run as "completed".** If a
  provider returned a turn with NO text and NO tool calls (hiccup, truncated
  stream, filtered content), the agent loop broke out and reported success
  with "(empty answer)" — the task silently died mid-run, steps just ended
  without a result. Now the model is nudged ("your last response was empty —
  continue the task") and the turn retried on the SAME step budget (up to 3
  attempts, nudges replace each other instead of stacking); a persistent
  empty streak fails the run loudly with a clear provider error and
  exit code 1. Successful tool turns reset the streak. Covered end-to-end
  (EMPTY_ONCE recovers → exit 0, EMPTY_ALWAYS fails → exit 1) in e2e,
  pinned in test-v90 §6.

### Added (v90.0)
- **`git_diff` / `git_log` / `git_blame`** — dedicated read-only git views so
  the agent stops parsing raw git output through bash. `git_diff`: HEAD /
  stage / worktree / any ref, path filter, context lines, and a line budget —
  over-budget diffs are truncated WITH the diffstat and an explicit "… N more
  lines" notice, never silently cut. `git_log`: compact history with optional
  path filter and per-commit diffstat. `git_blame`: windowed line provenance,
  capped at 200 lines. All three: execFile argument arrays (no shell), base
  can never be a git flag, LOW-risk READ class, parallel-safe (join the
  existing read-only parallel batch), verifier-whitelisted (verification
  agents can review what changed), doctor-self-tested, mock + e2e covered.
  19 → 22 tools.

## v89.0.0 — "fast"

Performance work with ZERO behavior change — every result is byte-identical,
proven by a reference implementation of the old algorithm in `test-v89.mjs`.

### Fixed (v89.0 — the agent loop was 5× slower than it needed to be)
- **Cross-language graph traversals were O(V×E), repeated ~40× per agent run**
  (~60% of agent-step CPU: `testsForFiles` 35% + `neighbors` 13% +
  `radiusOf` 12.5%). xlang.js now builds an adjacency index (by-path,
  by-basename, in/out edge lists) once per graph object (WeakMap — graphs are
  immutable once built) and memoizes `testsForFiles` per (graph, file-set,
  cwd). A 400-file repo agent step: **1.80s → 0.39s**; 200 traversals of a
  1000-file graph: ~6s (est.) → 143ms. `test-v89.mjs` proves the new results
  equal the old linear-scan algorithm on the real repo graph (all 400 files)
  and a synthetic 1000-file graph, and pins the perf budget.
- **CLI startup tax 218ms → 57ms.** `forge.js` statically imported the chat
  REPL (a ~38-module graph), the agent engine, the agent console, the tool
  registry and the router for EVERY subcommand. They now load lazily in the
  branches that need them (same pattern as the existing `loadOnboard`).
  `forge version`-class commands no longer pay for a REPL they never open.

### Added (v89.0)
- **Provider fail-fast.** A connect-guard expiry (endpoint accepted nothing
  for `connectMs`) now skips the two remaining same-provider retries and goes
  straight to the failover chain — worst-case dead-provider stall was
  `attempts × 30s + backoff ≈ 94s`, now `8s` once (default `retry.connectMs`
  30s → 8s). Transient errors (429/5xx/Retry-After) retry exactly as before.
- **Anthropic prompt caching.** The static request prefix (19 tool schemas
  ≈ 8.6 KB + system prompt ≈ 7.4 KB, re-sent on every agent step) now carries
  `cache_control` breakpoints on the Anthropic wire: same content, cache-served
  from step 2 — lower per-step latency and cost with zero information change.
- **`FORGE_DEBUG_PROMPT=<path>`** dumps the exact first-request payload from
  `forge agent` — ground truth for prompt-size work (system prompt chars,
  full text).
- **Parallel test runner.** The 130 node suites run through a worker pool
  (`FORGE_TEST_CONCURRENCY`, default 4; `1` restores the old sequential
  behavior). They are independent (per-suite mkdtemp `FORGE_HOME`, ephemeral
  ports). The two bash suites share port 8787 and stay sequential. Fast lane:
  **~85s → ~39s**. Suite output is buffered and printed in full on failure
  (live interleaved output from 4 suites was unreadable); the summary table
  and GitHub annotations are unchanged.

## v88.0.0 — "noguard + worker clamp"

### Changed (v88.0 — the owner's standing decision, made permanent)
- **Every command gate is GONE.** `userMayRun()` / `modelMayRun()` always return
  `ok: true` — no block class, no danger/confirm refusals, no sudo consent, no
  interpreter-eval consent, no project-boundary refusal, no y/N prompt, in any
  mode, whatever the config says (a config that sets `tools.unrestricted: false`
  cannot bring a gate back — the refusal code paths no longer exist).
  `classifyCommand()` is UNTOUCHED: every command is still labeled
  block/danger/confirm/low/safe for logs, `/status`, tool-intelligence and
  verification risk. v88 suite pins all of this.
- **No project write boundary.** `safePath` write checks allow any target
  (inside or outside the project); sensitive-file READ protection (.env/.ssh/
  keys) is removed too. securefs MECHANICS are unchanged — atomic writes, no
  final-component symlink following (ESYMLINK), TOCTOU anchoring, race
  detection. Those are correctness, not permission gates.
- **No SSRF gate on `fetch_url`.** Private/loopback/metadata URLs fetch like
  public ones (`allowPrivate: true`). Pinned-socket integrity remains (a
  connection must match the validated addresses — that is anti-rebinding
  mechanics, not a gate) and skill/tool downloads still go through the full
  netguard `pinnedFetch` policy.
- **Sandbox is OPT-IN.** Model bash runs unsandboxed `/bin/sh` unless
  `FORGE_SANDBOX=1` asks for the bwrap wrap (when bwrap actually works).
- **Worker clamp: low tier = 2, absolute max = 8.** `workerCeiling()` gives
  low-tier/low-RAM machines 2 workers (was 1); RAM-pressure adaptation clamps
  to the same floor; nothing ever exceeds `AGENT_BUDGETS.maxParallelSubAgents`
  (8) — burst scaling included.
- **Kept on purpose (correctness, not guards):** read-only verifier/plan agents
  still cannot write (VERIFY ⇒ READ_ONLY is the anti-fake-evidence contract),
  secret redaction still masks key shapes in tool results, checkpoints/undo and
  the verification ledger are unchanged.

### Fixed (v88.0 — test honesty)
- Test suites that used to assert guard refusals now assert the v88 behavior —
  and **no test executes a destructive command any more**: root wipes and
  system-file writes that were previously "safe" because a guard refused them
  are now checked as VERDICTS (`modelMayRun(...).ok`), never run.

## v87.0.0 — "full control"

### Fixed (v87.0 — bash works on kernels where bwrap cannot)
- **Broken-bwrap auto-fallback.** Containers and hardened kernels often ship a `bwrap` binary that can never start (`bwrap: Can't read /proc/sys/kernel/overflowuid: Permission denied`), so EVERY model bash command died before running — and the error text mis-classified as PERMISSION_DENIED, stalling the agent on "needs your decision" forever. `sandbox.js` now probes the kernel once (overflowuid/overflowgid readable; setuid bwrap exempt) and treats an unusable bwrap as missing; `tools.js` `runBash` additionally detects the bwrap-startup signature at runtime, re-runs the command directly through `/bin/sh`, and remembers for the session. A missing isolator is "unsandboxed", never a fake sandbox.

### Added (v87.0 — FULL CONTROL: zero permission pauses)
- **`tools.autoApprove` (default ON, owner-only key).** The agent decides and continues on its own — no "[forge] ask the user:" lines, no `TOOL_ESCALATION`/`needs your decision` pauses, no `!`-command y/N (shellguard block-class refusals still apply). Set `tools.autoApprove:false` in `~/.forge/config.json` (never project config) to be asked again.
- **`/yolo [on|off]`** — live FULL CONTROL toggle in chat; persists to the user config and flips the running session (guards, terminal confirm, tool ctx) immediately.
- **`forge --yolo …`** — force full control for any invocation (implies unrestricted + assumeYes + autoApprove via env).
- **v87 suite** covers the kernel probe, the unsandboxed re-run, the escalation suppression, the privileged-key guard, and the CLI flag.

## v86.0.0 — "gonka-uno"

### Fixed (v86.0 — provider URLs & models verified against official docs)
- **github-models was dead.** The Azure endpoint `models.inference.ai.azure.com` was retired (GitHub shutdown it Oct 17 2025). Now `https://models.github.ai/inference` with org-prefixed ids (`openai/gpt-4o`).
- **Model IDs refreshed to the current (Sep 2026) lineups:** OpenAI `gpt-5.6-{terra,luna,sol}`; Anthropic `claude-sonnet-5`, `claude-opus-4-8`, `claude-haiku-4-5`; Gemini `gemini-3.5-flash` / `gemini-3.1-pro-preview` / `gemini-3.1-flash-lite`; xAI `grok-4.6` / `grok-4.5` (500k window); Z.ai `glm-5.3-flash` / `glm-5.2` (1M); Groq `llama-3.3-70b-versatile`, `llama-4-scout`, `gpt-oss-120b`; Cerebras `gpt-oss-120b`, `zai-glm-4.7`; Qwen `qwen3-max`; SiliconFlow `DeepSeek-V3.2`; DeepSeek window now 1M (V4-backed aliases); Mistral 256k. **openrouter untouched** (owner instruction).

### Added (v86.0 — routers + custom-provider auto strategy)
- **`gonkarouter`** — GonkaRouter (Gonka Network): `https://api.gonkarouter.io/v1`, `GONKAROUTER_API_KEY`, keys at gonkarouter.io/dashboard. Featured models from their own docs (`deepseek-ai/DeepSeek-V4-Flash-0731`, `moonshotai/Kimi-K2.6`).
- **`unorouter`** — UnoRouter: `https://api.unorouter.com/v1`, `UNOROUTER_API_KEY`, 300+ models, automatic upstream failover.
- **`forge provider add <name> <baseUrl>`** — first-class custom providers: auto-discovers the model list (`/models`), keeps a chat-capable default, probes and records health, then autopick/failover/doctor/`forge use` treat it like a built-in. Plus `forge provider set-key|remove|test|list`.
- **Auto failover widened.** Any catalog provider whose API key is in the environment joins the failover chain automatically once it has a green probe (`forge provider test` / `forge doctor --all`) — zero-config, but never a blind switch (a CI GITHUB_TOKEN alone must not become an inference fallback). Tested providers are ordered fastest-first by probed latency.
- **`forge doctor --all`** probes env-keyed providers too, so the health cache reflects your real failover options.
- **v86 suite** covers the new catalog entries, the env-backed chain, latency ordering, and `provider add/remove` end-to-end.

## v85.0.0 — "unrestricted"

### Changed (v85.0 — the owner's master switch, by explicit owner request)
- **`tools.unrestricted` (default `true`).** One user-config switch that implies every privileged flag — `assumeYes`, `allowSudo`, `allowOutsideProject`, `allowInterpreterEval`, `allowNetworkUpload`, `fetchPrivateUrls`, `allowNewPlugins` — and bypasses both shellguard policy gates (`modelMayRun` / `userMayRun`), block class included. Fresh installs run with zero command guards; the interactive y/N prompt is gone.
- **`FORGE_UNRESTRICTED=1`** env alias for one-shot runs.
- **Off switch.** `forge config set tools.unrestricted false` restores the exact v84 guarded behavior (prompts, project boundary, sudo gate, catastrophic block list).
- **Still user-config only.** `unrestricted` joined `PRIVILEGED_TOOL_KEYS`: a project-local `forge.config.json` cannot set it (either way). Only the machine owner decides.
- **Classifier untouched.** `classifyCommand` still labels every command; unrestricted only changes the verdict, so logs keep the level. Read-only/plan/verifier agent modes keep their own no-write semantics.
- **v85 suite** covers: default-on, project-config immunity, all-blocker bypass at both gates, and unchanged v84 semantics when the switch is off.

## v84.0.0 — "promote"

### Added (v84.0 — gated auto-promote + capability extract, kernel still frozen)
- **`forge skill autopromote`.** ACTIVE only when every gate passes: VERIFIED, authored **behavioral** tests all PASS, fresh fingerprint, reusable caps. Structural-only, generated-only, CANDIDATE, and download-without-verify stay put.
- **Explicit `forge skill promote`** is unchanged (human override from VERIFIED).
- **Capability extract.** `forge skill caps` / `extractCapabilities` — procedures, workflow, examples, fingerprint. Indexing a name is not a capability.
- **ACTIVE downloads** stay in the verified index; TTL/drift still demote them.

Never auto-ACTIVE because a download succeeded. Compose still never writes.

## v83.0.0 — "knowtype"

### Added (v83.0 — typed knowledge, kernel still frozen)
- **FACT | EXPERIENCE | LESSON | HYPOTHESIS.** `FORGE_HOME/projects/<hash>/knowtype.json` next to claims. Not a second memory.
- **Hypothesis is never a fact.** FACT without evidence is stored as HYPOTHESIS. `asFact()` requires type FACT and evidence.
- **Compose `[KNOW]`.** Read-only pick. MICRO skip. Hypotheses labeled `(unproven)`.
- **CLI.** `forge knowtype list|add|pick` and `/knowtype`. Never auto-ACTIVE.

Compose still never writes.

## v82.0.0 — "zipunpack"

### Added (v82.0 — ZIP/folder support files, kernel still frozen)
- **Unpack `scripts/`, `examples/`, `references/`.** Text allowlist only (md/txt/js/sh/py/…). SKILL.md still required.
- **Traversal / binaries skipped.** `..`, absolute paths, NULs, kernel hints, `plugin-host.js` never land.
- **Never `~/.forge/tools`.** Mode 0600, no +x. Always CANDIDATE. DOWNLOAD ≠ TRUST.
- **Folder ingest** copies the same allowlisted dirs next to SKILL.md.

Never auto-ACTIVE. Compose still never writes.

## v81.0.0 — "variants"

### Added (v81.0 — named strategy variants, kernel still frozen)
- **Identity.** A skill is not a strategy. `family + strategy + version + fingerprint` (e.g. `web-design/component-first-v2`).
- **Siblings coexist.** A new variant never overwrites ACTIVE or VERIFIED. Same body is reused. Different body bumps version.
- **Independent scores.** `recordVariantOutcome` / `forge variant score` — not a shared skill score.
- **Compose `[VARIANTS]`.** Read-only pick. MICRO skip.
- **CLI.** `forge variant list|add|pick|score` and `forge skill variant <name> <strategy>`. Always CANDIDATE.

No ZIP unpack. Never auto-ACTIVE. Compose still never writes.

## v80.0.0 — "verify2"

### Added (v80.0 — P0 verification integrity, kernel still frozen)
- **Execution result model.** `execresult.js`: stdout/stderr/exitCode/timedOut/killed/truncated/duration/signal/status. Status is PASS | FAIL | TIMEOUT | KILLED | BLOCKED | TRUNCATED | UNKNOWN.
- **UNKNOWN and TRUNCATED never PASS.** Ledger `evaluateVerification` refuses truncated/killed as success. Skill tests and experiments use the same classifier.
- **Evidence v2.** `evidence.json` carries `sourceFingerprint`, `evidenceVersion`, structured results, environment. Changed SKILL.md → fingerprint mismatch → dropped from verified index (stale evidence is not reused).
- **Generated-test provenance.** `generated: true` + sourceGap/reason/generator/fingerprint. Not evidence until executed.
- **`forge skill evidence` / `forge skill benchmark`.** Benchmark metrics are UNKNOWN when only structural verify ran. Never invented scores.

Never auto-ACTIVE. Compose still never writes. Full ZIP unpack and named strategy variants stay leftovers.

## v79.0.0 — "complete"

### Added (v79.0 — remaining feature TODOs, kernel still frozen)
- **ZIP/folder ingest.** `forge skill ingest <zip|folder|SKILL.md>` extracts `SKILL.md` only (store or deflate). URL downloads that are zips extract the same way. CANDIDATE. Never `~/.forge/tools`. Never ACTIVE.
- **Strategy 2.0.** `strategy.json` evidence scores. Compose `[STRAT]` is read-only.
- **Toolintel 2.0.** Recency-weighted prefer/avoid.
- **Model empirics.** `FORGE_HOME/model-outcomes.json`. `forge empirics`. Not the static registry.
- **Consolidate.** `forge memory consolidate` merges duplicate lessons and memory bullets. Provenance kept.
- **Gap tests.** Mapped `npm test` / `cargo test` / … are skipped unless `--command` is explicit.
- **Bench 2.0.** Cases 13–16 (no-invent, planner role, explicit command, coder is the writer).
- **Planner role.** Read-only. `forge roles`. One mutating writer.
- **Knowledge on `/status`.** Idle chat prints the dock line without a live omega task.
- **Node 22 `--allow-net`.** Passed only when the runtime exposes the flag and the plugin grant is on.

Kernel evolution (L6), the Never list, and the chat-compact flake stay unchecked. `assumeYes` stays false. TODO.md is the living list.

## v78.0.0 — "experiment"

### Added (v78.0 — gap experiment → outcome → CANDIDATE skill)
- **Experiment engine.** `forge experiment <domain> [--command <cmd>]` / `/experiment`. Hypothesis → shellguard-focused test → `recordGapOutcome` (VERIFIED or CONTRADICTED). Skip is a ledger entry, never silent, never invented `npm test`.
- **Skill from a gap.** A passing experiment may `authorSkill` a CANDIDATE playbook. Not only from a repair. Never auto-ACTIVE.
- **Benchmark.** `benchmarkPlaybook` scores a SKILL.md against the repair it came from (files + command + distinct body).
- Compose still never writes. Never `~/.forge/tools`.

ZIP unpack, Strategy 2.0, and auto-ACTIVE are not this release. `assumeYes` stays false. TODO.md is the living list.

## v77.0.0 — "skillver"

### Added (v77.0 — versioned skills, rollback, generated tests, tool progress)
- **Versions.** A second author of a VERIFIED/ACTIVE learned skill writes `{name}-v2` as CANDIDATE. v1 stays. `forge skill promote <name>` makes v2 ACTIVE and v1 SUPERSEDED. `forge skill rollback <name>` restores v1. Both histories kept. Never auto-ACTIVE.
- **Supersede.** A downloaded skill that becomes CONTRADICTED supersedes a learned sibling of the same name.
- **Generated tests.** `generateSkillTests` derives a shellguard-safe command from `## Verify` when `verifySkill({ generate: true })`. Default verify is still v67 (`## Tests` only; no tests → structural). Fail → INACTIVE.
- **Tool download progress.** `/tool download` and `forge tool download` print `received/total`, max 99% until stored.
- **Idle header.** Omega header and idle screen can show the knowledge dock line.

Research-from-gap, ZIP unpack, and auto-ACTIVE are not this release. `assumeYes` stays false. TODO.md is the living list.

## v76.0.0 — "live"

### Added (v76.0 — dock refresh without PLAN_COMPOSE)
- **Live dock.** `/claims`, `/decisions`, `/knowledge`, and `/skill learn` push `KNOWLEDGE_UPDATED` from `snapshotKnowledge(cwd)`. No new compose pass. Compose still never writes.
- Never ACTIVE. Never `~/.forge/tools`.

Tool-download progress, generated tests, and auto-ACTIVE are not this release. `assumeYes` stays false. TODO.md is the living list.

## v75.0.0 — "dock"

### Added (v75.0 — claims/decisions on the omega TUI dock)
- **Dock.** `KNOWLEDGE_UPDATED` folds claims and decisions into UI state. The omega panel and `/status` task panel show `know claims … · decisions …`. `PLAN_COMPOSE` from meta is the source. Compose still never writes.
- Never ACTIVE. Never `~/.forge/tools`.

Tool-download progress, generated tests, and auto-ACTIVE are not this release. `assumeYes` stays false. TODO.md is the living list.

## v74.0.0 — "cockpit"

### Added (v74.0 — steer + decisions + knowledge pane + honest download progress)
- **TRY FIRST from claims.** If no plugin/skill/know playbook, matching claims become the steer. `CLAIMS` / `DECISIONS` lines. Agent, chat, and meta pass them through.
- **Architecture log.** `FORGE_HOME/projects/<hash>/decisions.json`. `forge decisions add <title> <reason>`, TUI `/decisions`. Compose `[decisions]` is read-only. MICRO skip unless named.
- **Knowledge pane.** `forge knowledge` / `/knowledge` lists claims, decisions, gaps, downloads. Not a second memory.
- **Download progress.** `onBytes` on pinnedFetch (cap 99% until the body is complete). `/skill download` prints `received/total`. Never a fake 100% on failure. Compose still never fetches.

Generated tests from a gap, ZIP unpack, and auto-ACTIVE are not this release. `assumeYes` stays false. TODO.md is the living list.

## v73.0.0 — "cite"

### Added (v73.0 — claims join compose, read-only)
- **Cite.** Matching project claims surface as `[claims]` in the compose snapshot. MICRO/SMALL skip unless the subject is named. Compose still never writes `claims.json`. Never ACTIVE.

Architecture decision log, ZIP unpack, and auto-ACTIVE are not this release. `assumeYes` stays false. TODO.md is the living list.

## v72.0.0 — "claims"

### Added (v72.0 — per-claim subject store)
- **Claims.** `FORGE_HOME/projects/<hash>/claims.json` next to knowgap.json. Not a second memory. `forge skill learn` upserts a claim keyed by skill id. `forge claims [subject]` and TUI `/claims`.
- Compose still never writes. Never ACTIVE. Never `~/.forge/tools`.

Architecture decision log, ZIP unpack, and auto-ACTIVE are not this release. `assumeYes` stays false. TODO.md is the living list.

## v71.0.0 — "drift"

### Added (v71.0 — body sha vs last verifiedSha)
- **Drift.** A VERIFIED download whose SKILL.md / tool `.mjs` no longer matches `verifiedSha` becomes **DRIFT**, not STALE, not CONTRADICTED. Hidden from `pickSkills` / `load_skill`. Missing `verifiedSha` is stamped now — no instant demote. Re-verify restores VERIFIED.
- Never ACTIVE. Compose still never fetches. Never `~/.forge/tools`.

Per-claim subject store, ZIP unpack, and auto-ACTIVE are not this release. `assumeYes` stays false. TODO.md is the living list.

## v70.0.0 — "ttl"

### Added (v70.0 — per-skill TTL override)
- **Record TTL.** `ttlMs` on a download overrides `FORGE_SKILL_TTL_MS`. `forge skill ttl <name> [<ms>]` and TUI `/skill ttl`. Invalid/missing `ttlMs` still uses the env default (30d). Short override can STALE a sibling while others stay VERIFIED.
- Never ACTIVE. Compose still never fetches. Never `~/.forge/tools`.

Drift detector, ZIP unpack, and auto-ACTIVE are not this release. `assumeYes` stays false. TODO.md is the living list.

## v69.0.0 — "contradict"

### Added (v69.0 — STALE fails N times → CONTRADICTED)
- **Fail limit.** `FORGE_SKILL_FAIL_LIMIT` (default **2**). A STALE download that fails re-verify that many times becomes **CONTRADICTED**, not INACTIVE. Hidden from `pickSkills` / `load_skill`.
- CANDIDATE / VERIFIED fail is still **INACTIVE** (v63). Success restores VERIFIED and clears `failCount`. Never ACTIVE. Compose still never fetches.

Per-skill TTL override, ZIP unpack, and auto-ACTIVE are not this release. `assumeYes` stays false. TODO.md is the living list.

## v68.0.0 — "stale"

### Added (v68.0 — VERIFIED past TTL is STALE, not CONTRADICTED)
- **TTL.** A download that stays VERIFIED longer than `FORGE_SKILL_TTL_MS` (default 30 days) becomes **STALE**. Not CONTRADICTED, not INACTIVE. Hidden from `pickSkills` / `load_skill`. Listed with its lifecycle.
- **Re-verify restores VERIFIED** and resets the clock (`verifiedAt`). Missing `verifiedAt` is stamped now — no instant demote.
- Compose still never fetches. Never ACTIVE. Never `~/.forge/tools`.

Generated tests from a gap, ZIP unpack, and auto-ACTIVE are not this release. `assumeYes` stays false. TODO.md is the living list.

## v67.0.0 — "evidence"

### Added (v67.0 — ## Tests are executed; DOWNLOAD still ≠ TRUST)
- **Evidence.** `forge skill verify` writes `evidence.json` next to the download. No `## Tests` heading → `kind: structural` and VERIFIED (same as v63). A `## Tests` block runs up to 4 commands through **shellguard** (`block`/`danger`/`confirm` refused, not executed). Non-zero or timeout → INACTIVE. Never ACTIVE. Never `~/.forge/tools`.
- **## Verify is not a test.** Playbook "how to verify in a project" is not executed. Compose still never fetches.

Generated tests from a gap, ZIP unpack, and auto-ACTIVE are not this release. `assumeYes` stays false. TODO.md is the living list.

## Layout (PR 68) — still v66.0.0

Repo is one folder: `forge/` (CLI + `tests/` + `skills/`). `agentv19/` is gone.
Kernel version is unchanged (**66.0.0**). This is a land-on-`main` flatten, not a feature bump.

## v66.0.0 — "learn"

### Added (v66.0 — extract procedures; indexing is not learned)
- **Learn.** `forge skill learn <name>` and TUI `/skill learn <name>` extract headings → procedures and bullets → patterns into `knowledge.json` next to the VERIFIED download. Name+description-only fails: indexing is not learned.
- **CANDIDATE/INACTIVE refused.** Lifecycle stays VERIFIED (not ACTIVE). Never `~/.forge/tools`. `load_skill` appends learned procedures. Compose still never fetches.

Single mutating writer is unchanged. TODO.md is the living list. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. Generated tests, rollback, research-from-gap, and landing the stack on `main` are not this release. `assumeYes` stays false. Wizard pick 18 stays `custom`.

## v65.0.0 — "discover"

### Fixed (v65.0 — verified downloads show up in lists and `forge skills <name>`)
- **CLI.** `forge skills <name>` prints a VERIFIED download. `forge skills` / `check` list them. `forge plugins` lists hostless downloaded playbooks. `forge tools download|verify` hints at `forge tool …`.
- **TUI.** `/skills` lists verified downloads. `/skills download|verify` aliases `/skill`. Empty `verify all` says download first.
- **Compose.** Downloaded playbooks get a `[playbook]` line. Skills without `## What worked` still attach the first paragraph. Context compose now includes skill bodies.
- **Re-verify.** Already-VERIFIED is re-checked; missing/kernel SKILL.md demotes to INACTIVE.

Single mutating writer is unchanged. TODO.md is the living list. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. Deep learn, generated tests, rollback, and landing the stack on `main` are not this release. `assumeYes` stays false. Wizard pick 18 stays `custom`.

## v64.0.0 — "wire"

### Fixed (v64.0 — verified downloads actually load)
- **load_skill.** VERIFIED skill-downloads and hostless tool playbooks resolve even when the bundled skills dir is missing. CANDIDATE/INACTIVE still 404. Never returns `.mjs` source. Never writes `~/.forge/tools`.
- **Compose.** `evaluateSkills` keeps `downloaded` + `path`. `attachSkillBodies` reads `SKILL.md` under `skill-downloads` so `[skills]` carries repair/files/command. Compose still never imports skilldl and never fetches.
- **Data CLI.** `forge data status` lists skill/tool download counts. Empty `verify all` says there are no candidates.

Single mutating writer is unchanged. TODO.md is the living list. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. Deep learn, generated tests, rollback, and landing the stack on `main` are not this release. `assumeYes` stays false. Wizard pick 18 stays `custom`.

## v63.0.0 — "verify"

### Added (v63.0 — tool download + structural verify)
- **Tools.** `forge tool download <https-url>` stores a CANDIDATE under `~/.forge/tool-downloads/` (same FORGE_HOME root). Never `~/.forge/tools`, never plugin-host.
- **Verify.** `forge skill verify <name|all>` and `forge tool verify <name|all>` (TUI `/skill verify`, `/tool verify`). Parse + validate only. Pass → VERIFIED. Fail → INACTIVE. One failure does not fail siblings. DOWNLOAD ≠ VERIFY.
- **Planner.** `pickSkills` / `pickPlugins` see VERIFIED downloads only (hostless playbooks). CANDIDATE stays out.

Single mutating writer is unchanged. TODO.md is the living list. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. Deep learn, generated tests, rollback, and landing the stack on `main` are not this release. `assumeYes` stays false. Wizard pick 18 stays `custom`.

## v62.0.0 — "skilldl"

### Added (v62.0 — native skill download, CANDIDATE only)
- **Download.** `forge skill download <https-url> [<url>…]` and TUI `/skill download <url>` fetch via `pinnedFetch` into `~/.forge/skill-downloads/` (FORGE_DATA_DIR alias). Metadata + sha256. Markdown becomes `SKILL.md`. Archives stored, not unpacked. Status is always CANDIDATE.
- **Fail closed.** HTTPS only. HTML pages, empty bodies, HTTP errors, private/metadata hosts, `file:` — no candidate. Duplicate sha256 reuses the existing record and will not overwrite VERIFIED.
- **Not trusted.** Download does not verify, learn, or activate. Compose never fetches. Nothing lands in the user project or `~/.forge/tools`.

Single mutating writer is unchanged. TODO.md is the living list. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. `/skill verify`, deep learn, rollback, and landing the stack on `main` are not this release. `assumeYes` stays false. Wizard pick 18 stays `custom`.

## v61.0.0 — "todo"

### Changed (v61.0 — completed PLAN files removed; leftovers live in TODO.md)
- **Plans.** Shipped `PLAN-v*.md` files are deleted. Remaining work is `[agentv19/forge/TODO.md](TODO.md)` — every item is `- [ ]` until it ships. Do not keep a plan file after the enhancement lands. CHANGELOG remains the history.

Single mutating writer is unchanged. TODO.md is the living list. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. `assumeYes` stays false. Wizard pick 18 stays `custom`.

## v60.0.0 — "blast"

### Added (v60.0 — v33 graph as planner knowledge: radius, importers, mapped tests)
- **Blast.** `blastFromWorld` reads the existing v33 graph only (never walks, never writes). Compose snapshot `[blast] radius=N importers=M tests=T scope=…`. A miss is UNKNOWN, not "no dependents". MICRO/SMALL skip.
- **Steer.** formatSteer `BLAST:` names importers, mapped tests, and testing scope so a hub is not treated as a leaf. `planAcquire` prefers graph-mapped tests over `web_search`. Skill/repo still cheaper. CONTRADICT from v59 now also prints on formatSteer.

Single mutating writer is unchanged. PLAN-v63 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. Drift detector, architecture store, crawler, L6, and landing the stack on `main` are not this release. `assumeYes` stays false. Wizard pick 18 stays `custom`.

## v59.0.0 — "contradict"

### Added (v59.0 — failed evidence on a VERIFIED domain is CONTRADICTED)
- **Contradict.** A failed acquire tool matching a VERIFIED/KNOWN domain sets status CONTRADICTED (confidence 0.2). Failed records on unverified domains stay ignored. Successful ingest still never VERIFIED and still skips VERIFIED.
- **Steer.** `evidenceFor` ranks CONTRADICTED above VERIFIED. `planAcquire` on CONTRADICTED is `verify`, not web. formatSteer `CONTRADICT:` is additive. `recordGapOutcome(VERIFIED)` is the only way back to KNOWN. persistGaps will not promote CONTRADICTED from a filename.

Single mutating writer is unchanged. PLAN-v62 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. STALE-by-age, skill research, crawler, L6, and landing the stack on `main` are not this release. `assumeYes` stays false. Wizard pick 18 stays `custom`.

## v58.0.0 — "skilllife"

### Added (v58.0 — learned skills are CANDIDATE until a second verified run)
- **Lifecycle.** First `authorSkill` records CANDIDATE in `~/.forge/projects/<hash>/skilllife.json` (0600). A second 9/9 COMPLETED `evolveRun` on the same playbook is the only auto-VERIFIED path. `recordSkillOutcome` is the explicit path. First-party skills stay ACTIVE.
- **Steer.** `pickSkills` attaches lifecycle. formatSteer / `[skills]` mark `(candidate)` so the planner does not treat a first-write playbook as trusted.

Single mutating writer is unchanged. PLAN-v61 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. Skill research pipeline, CONTRADICTED, crawler, L6, and landing the stack on `main` are not this release. `assumeYes` stays false. Wizard pick 18 stays `custom`.

## v57.0.0 — "priority"

### Added (v57.0 — LEARN is the gap worth paying for, not every unknown)
- **Priority.** `priorityOf` = (impact + uncertainty + recurrence) / (cost + risk + time). Recurrence from existing `samples`/`tried`. `pickLearn` caps LEARN at 1 (2 only if both CRITICAL). Lower-score gaps stay on `[gaps]`.
- **Data-root alias.** `resolveDataDir()`: `FORGE_HOME` wins, else `FORGE_DATA_DIR`, else `~/.forge`. Same directory — not a second tree, no migration, no copy.

Single mutating writer is unchanged. PLAN-v60 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. Skill-forge 2.0, CONTRADICTED, crawler, L6, and landing the stack on `main` are not this release. `assumeYes` stays false. Wizard pick 18 stays `custom`.

## v56.0.0 — "ingest"

### Added (v56.0 — record real acquire-tool runs as UNCERTAIN, never VERIFIED)
- **Ingest.** `ingestAcquire` runs after `recordToolRun` in agent/chat. Successful `load_skill` / `grep_files` / `glob_files` / `read_file` / `web_search` / `fetch_url` matching a domain append the method to `tried[]` and set status UNCERTAIN (confidence ≤ 0.5). Failed/blocked/write tools ignored.
- **Skip tried.** Next `planAcquire` skips methods already run. All tried → `verify` hint, do not re-search. `persistGaps` will not demote UNCERTAIN → UNKNOWN.
- **No dump.** Evidence is `${tool} ${id}` only. No result text, no URLs, no task text. Compose still never writes. `recordGapOutcome` stays the only VERIFIED path. Cache bust via `clearComposeOnce` after a real ingest.

Single mutating writer is unchanged. PLAN-v59 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. Research crawler, skill-forge 2.0, L6, and landing the stack on `main` are not this release. `assumeYes` stays false. Wizard pick 18 stays `custom`.

## v55.0.0 — "acquire"

### Added (v55.0 — cheapest-source acquisition plan into compose / planner)
- **Learn.** `planAcquire` picks the cheapest reliable source for each blocking gap: existing snapshot skill (`load_skill`) → repo `grep_files` → local docs → `web_search` last. Surfaces as `[learn]` and `LEARN:`.
- **No dump.** Compose never fetches. Never injects webpage text. A search hint is not VERIFIED knowledge. `recordGapOutcome` stays the only VERIFIED path.
- **Persist.** `knowgap.json` stores `{ method, tool, cost }` aggregates. No page text, no task text.

Single mutating writer is unchanged. PLAN-v58 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. Research crawler, skill-forge 2.0, L6, and landing the stack on `main` are not this release. `assumeYes` stays false. Wizard pick 18 stays `custom`.

## v54.0.0 — "knowgap"

### Added (v54.0 — required vs known vs skippable into compose / planner)
- **Gaps.** `detectGaps` ranks engineering domains the task requires against memory / world / skills / lessons / prior verified state. CRITICAL/HIGH unknowns surface as `[gaps]` + `GAPS:` (research+verify before implementation). LOW unknowns are `[skip]`. MICRO/SMALL stay empty unless a domain is named.
- **Store.** `persistGaps` writes aggregates to `~/.forge/projects/<hash>/knowgap.json` (0600, task hashed, never stored). `recordGapOutcome` is the only path to VERIFIED. Compose never writes. Meta persists after PLAN_COMPOSE. Existing `FORGE_HOME` is the single data root — no second store, nothing in the user project.
- **CLI.** `forge data status | gaps | reset gaps` inspects the Forge-owned root.
- **Steer.** `formatSteer({ gaps })` adds additive `GAPS:` / `SKIP:` lines. Empty steer is still empty.

Single mutating writer is unchanged. PLAN-v57 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite, research engine, and L6 kernel self-mod are not this release. `assumeYes` stays false. Wizard pick 18 stays `custom`. Lexical evidence is never claimed VERIFIED.

## v53.0.0 — "rank"

### Added (v53.0 — ranked skills / playbooks / MCP into compose and the planner)
- **Skills.** `pickSkills` (tags + aliases, still top-k 3) replaces lexical-only `evaluateSkills` at compose / agent / chat / context. MICRO/SMALL still skip unless named. 11 first-party `skills/forge-*` playbooks. Community pack stays on disk — not dumped.
- **Playbooks.** `pickPlugins` hostless playbooks join compose as `[playbooks]` and `formatSteer` as `PLAYBOOKS:`. Never spawn `plugin-host`.
- **MCP.** `rankMcp` / `mcpCatalog` rank configured or already-loaded MCP names into `[mcp]` (cap 4). Compose never connects a server. Live tools beat config stubs.
- **Planner.** MEDIUM+ `formatCompose` prefix already existed; the snapshot now carries ranked skills, playbooks, and MCP so the noTools plan names what to use. MICRO synthesise unchanged.

Single mutating writer is unchanged. PLAN-v56 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite, and L6 kernel self-mod are not this release. `assumeYes` stays false. Wizard pick 18 stays `custom`. `evaluateSkills` itself is unchanged.

## v52.0.0 — "toolmem"

### Added (v52.0 — persist tool outcomes into compose / steer)
- **Persist.** `recordToolRun` writes aggregates to `~/.forge/projects/<hash>/toolstats.json` (0600, no result text). `think` / `todo` / `memory` skipped. Cap 32. Damped (PRIOR_WEIGHT=5): one sample cannot prefer or avoid.
- **Compose.** `emptyCompose.tools` + `relevantTools` → `[tools] prefer grep_files (91%); avoid bash SAFETY_BLOCK`. MICRO/SMALL skip. `includeTools` joins the composeOnce key.
- **Steer.** `formatSteer({ tools })` adds an additive `TOOLS:` line. Empty steer is still empty. Agent / chat / repair pass `composed.tools`.
- **Record path.** `runAgent` persists in `finally`; chat persists each `runBatch`. `runCall` / cheaperAlternative / nextAction unchanged.

Single mutating writer is unchanged. PLAN-v55 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite, and L6 kernel self-mod are not this release. `assumeYes` stays false. Wizard pick 18 stays `custom`.

## v51.0.0 — "apinex"

### Added (v51.0 — APInex provider, live catalog, custom model ids)
- **Provider.** `apinex` talks to `https://api.apinex.bond/v1` (OpenAI Chat Completions). Env `APINEX_API_KEY` (`sk-apx…`). Appended after `custom` so wizard pick **18 stays custom** (e2e/cleanroom).
- **Auto models.** `forge models apinex` / onboard / `/models` fetch `GET /v1/models` when a key is set, else the public catalog `GET https://apinex.bond/api/public/models` (no key). `free/…` ids badge FREE. Offline fallback is a curated free list.
- **Custom ids.** Wizard `[m]`, `/model <id>`, `forge use apinex --model <id>`, and `providers.apinex.models[]` still add any id. Extra ids are unioned onto the live list.

Single mutating writer is unchanged. Kernel, `assumeYes`, `allowNewPlugins` unchanged. Not L6.

## v50.0.0 — "once"

### Added (v50.0 — compose snapshot reused for identical args)
- **`composeOnce`.** Identical args return the same snapshot (`===`). Cap 8, LRU bump on hit, `refresh: true` recomputes. `compose()` stays uncached so a write is visible on the next plain call. `clearComposeOnce()` drops the store.
- **Meta walks the pipeline once.** Plan hits `takeCompose`. Mid-task replan refreshes. Evolve reads `focusedVerify(cwd, changedRel)` instead of recomposing. `repairSegment` (top-level) calls `composeOnce` with its original opts — it cannot close over `takeCompose`.
- **Execute path.** `agent.js` / `chat.js` use `composeOnce` so segments of the same query reuse. The context engine keeps its generation cache and still calls `compose()`.

Single mutating writer is unchanged. PLAN-v53 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite, and L6 kernel self-mod are not this release. `assumeYes` stays false.

## v49.0.0 — "check"

### Added (v49.0 — INTENT.VERIFY uses focusedVerify)
- **VERIFY chain.** `planChain("run the tests")` / `verify src/lib.rs` now carry the native command (`cargo test` vs `npm test`) from `focusedVerify`. Graph-connected tests join the why-string. Never auto-run. Never invent flags.
- **Verify-phase bash.** `synthesizeArgs` prefers `step.args.command` / `context.verifyCommand` on the verify step. EXECUTE and regress stay on `detectTestCommand` (1-arg frozen).
- **Guidance.** `toolGuidance` passes compose's `[verify next]` command into the suggested chain.

Single mutating writer is unchanged. PLAN-v52 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite, and L6 kernel self-mod are not this release. `assumeYes` stays false.

## v48.0.0 — "hostless"

### Added (v48.0 — learned plugins are playbooks, never a live plugin-host spawn)
- **Execute path is hostless.** `runAgent` / `loadChatPlugins` / `forge tools` load `~/.forge/tools` only. A learned plugin is not a live schema entry, so selecting it cannot spawn `plugin-host`.
- **List as data.** `forge plugins` lists learned entries via `indexLearnedPlugins` (sync). JSON carries a `playbooks` array. User `~/.forge/tools` still load.
- **v42 loader kept.** `mergeLearnedPlugins` / `loadLearnedPlugins` still exist for tests. Compose still emits `[plugins] learned_…`. `load_skill` still returns PLAYBOOK markdown.

Single mutating writer is unchanged. PLAN-v51 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite, and L6 kernel self-mod are not this release. `assumeYes` stays false.

## v47.0.0 — "know"

### Added (v47.0 — index + graph + lessons as the knowledge graph)
- **Index locate.** The v32 index finds files by symbol/basename overlap when the task has no filename. MICRO skip. Cap 2.
- **Graph impl.** `implForFiles` follows TEST→source. Cited tests pull the implementation into the world snapshot so the router does not grep.
- **Lesson playbook.** High-confidence lessons with a successful repair + files join compose as `[know]` / TRY FIRST. Kernel-looking bodies skipped. Compose stays read-only (does not author SKILL.md).

Single mutating writer is unchanged. PLAN-v50 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite, and L6 kernel self-mod are not this release. `assumeYes` stays false.

## v46.0.0 — "apply"

### Added (v46.0 — skill body + TRY FIRST on execute, MODIFY honors playbookFiles)
- **Skill snapshot.** `parseSkillPlaybook` reads What worked / Files / Verify from a learned SKILL.md. `compose` attaches the body; `formatCompose` emits `[skill]`. Skill files cite into the world. Kernel-looking bodies are skipped. Bundled pack is not dumped.
- **TRY FIRST on execute.** `formatSteer` joins the agent / chat system prompt, not only repair. A skill with a body ranks as TRY FIRST when no plugin playbook is present. Plugin playbooks still win.
- **MODIFY short chain.** When playbook files are known: inspect → edit → focused verify. No grep. DISCOVER and cold MODIFY/RECOVER stay frozen.

Single mutating writer is unchanged. PLAN-v49 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite, and L6 kernel self-mod are not this release. `assumeYes` stays false.

## v45.0.0 — "steer"

### Added (v45.0 — playbook first, skip rediscovery)
- **`formatSteer`.** Ranks known repair → matching skills → hard-avoid. Repair prompt says TRY FIRST instead of rediscovering.
- **`load_skill` playbook fallback.** A `learned_*` name returns PLAYBOOK markdown. No spawn, no import(), no `plugin-host`.
- **RECOVER short chain.** When playbook files are known: inspect → edit → focused verify. No grep, no regress. Cold path (no playbook) is unchanged.
- **unionPlugins fills the body.** Caller plugin objects keep identity; `repair`/`files`/`command` come from the learned index when missing.

Single mutating writer is unchanged. PLAN-v48 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite, and L6 kernel self-mod are not this release. `assumeYes` stays false.

## v44.0.0 — "playbook"

### Added (v44.0 — playbook snapshot)
- **Index keeps the body.** `indexLearnedPlugins` now carries `repair`, `files`, and `command` from `PLAYBOOK` JSON. Absolute / `..` / `~` files are dropped. Kernel-looking playbooks are skipped.
- **Planner sees what worked.** `formatCompose` emits `[playbook] learned_…: <repair> — <files> — <command>`. The plan path is `noTools` — it cannot call the plugin — so the snapshot has to carry the body. `PLAN_COMPOSE` includes `playbook`.
- **Playbook files join the world.** Matching learned plugins cite their files into `composeWorld`, so `[world]` / `[verify next]` fire even when the task text has no filename. `[verify next]` is still `focusedVerify` (current stack), not the recorded command. The recorded command is never auto-run.

Single mutating writer is unchanged. PLAN-v47 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite, and L6 kernel self-mod are not this release. `assumeYes` stays false.

## v43.0.0 — "pluginpick"

### Added (v43.0 — compose picks learned plugins)
- **Sync learned-plugin index.** `indexLearnedPlugins` reads `PLAYBOOK` JSON from `~/.forge/projects/<hash>/tools/learned_*.mjs` without executing, spawning, or importing the file. Symlinks, dotfiles, and `~/.forge/tools` are skipped. Cap 24.
- **Planner sees the pick.** `compose()` unions the index with caller plugins (caller names win) and runs `selectPlugins`. `PLAN_COMPOSE` emits up to 4 isolated names. MICRO/SMALL still skip isolated unless named.
- **Never a host.** compose stays sync. `plugin-host.js` is not spawned. `allowNewPlugins` stays false. Learned plugins still do not land in `~/.forge/tools`.

Single mutating writer is unchanged. PLAN-v46 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite, and L6 kernel self-mod are not this release. `assumeYes` stays false.

## v42.0.0 — "extend"

### Added (v42.0 — isolated plugin / skill self-extension, L5)
- **Learned isolated plugin.** A successful repair becomes a project-local `learned_*.mjs` under `~/.forge/projects/<hash>/tools/`. Read-only. No `capabilities`. Grants always `{}`.
- **Repair is data.** `formatPluginMjs` puts user strings in `JSON.stringify`. The template never interpolates repair text as code.
- **Never the user plugin dir.** `~/.forge/tools` and `plugin-host.js` are not written. Bundled pack is not written. MICRO/SMALL skip. Kernel-looking repairs are refused.
- **Loader merge.** `mergeLearnedPlugins` appends extras; global names win. Same-run quarantine still skips a plugin authored this task. `allowNewPlugins` stays false.

Single mutating writer is unchanged. PLAN-v45 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite, and L6 kernel self-mod are not this release. `assumeYes` stays false.

## v41.0.0 — "compose"

### Added (v41.0 — v32+ pipeline as one snapshot)
- **`compose()`.** Index → world (graph + writes) → memory (stale-dropped against that world) → skills (v34 + learned) → strategy (`hardAvoid`) → tools (plugins + `focusedVerify`). One snapshot, not five independent calls.
- **Planner sees the join.** `PLAN_COMPOSE` injects `[world]`, `[avoid]`, `[skills]`, `[verify next]` into the plan prompt. MICRO/SMALL still skip the model plan path.
- **Context engine section.** `createContextEngine().build` carries a compact `compose` slice so the executing agent sees the same world/avoid/verify the planner did.
- **Memory reuses the world.** `relevantMemory` is called with the snapshot's `writes`/`graph`, not a second `worldFromCwd`.

Single mutating writer is unchanged. PLAN-v44 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite, and L6 kernel self-mod are not this release. `assumeYes` stays false.

## v40.0.0 — "evolve"

### Added (v40.0 — strategy evolution, L4)
- **9-check score.** After COMPLETED, `scoreRun` counts the nine gate checks. `STRATEGY_EVOLVED` is best-effort and never blocks COMPLETED.
- **Hard-avoid.** Strategies with lesson confidence ≥ 0.5 join the planner's avoid list (`hardAvoid`). Below that they stay advisory.
- **Promote / demote.** A successful run raises the relevant lesson by 0.1; a failed run lowers it. Confidence below 0.25 is retired. Disk is not deleted.
- **Learned SKILL.md.** A successful repair becomes a project-local playbook under `~/.forge/projects/<hash>/skills/learned-…/`. MICRO/SMALL skip. Kernel-looking repairs (`classifyTaskComplexity`, `assumeYes`, `plugin-host`, `securefs`) are refused. The bundled pack is never written.
- **Evaluator + `load_skill`.** Learned skills merge into the v34 evaluator (bundled names win). `load_skill` falls back to the learned dir when the bundled SKILL.md is missing.

Single mutating writer is unchanged. PLAN-v43 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite, and L6 kernel self-mod are not this release. `assumeYes` stays false.

## v39.0.0 — "focusverify"

### Added (v39.0 — focused verification reaches the model)
- **`[verify next]`**. HIGH TESTS already named `cargo test` vs `npm test` (v38); `formatVerification` now shows that command to the model. Verification still never runs it.
- **Graph-connected tests.** `focusedVerify` lists up to 8 test files from the v33 graph (`testsForFiles`). Empty graph → `tests: []`. No invented CLI flags (`npm test -- file.test.js`).
- **toolintel keeps command + tests** on recommended records.

Single mutating writer is unchanged. PLAN-v42 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite are not this release. `assumeYes` stays false.

## v38.0.0 — "gaps"

### Added (v38.0 — close real holes, do not weaken tests)
- **Trailing-symlink writes.** `allowOutsideProject` no longer realpath's a final-component symlink onto the host (`OUT/hostlink` → `/etc/hostname`). In-project aliases still follow. `atomicWriteInDir` then refuses ESYMLINK. fs-toctou assertion is unchanged.
- **Generated-dir refuse.** `dist` / `.next` / `target` / `node_modules` / … listed by the v37 engine are now blocked as write targets (`generatedBoundary` in `safePath`). `ctx.allowGeneratedWrites` opts out. A file *named* `dist.js` is not a generated dir.
- **Language-native HIGH TESTS.** `verificationPlan` recommends `cargo test` for a rust file in a mixed npm+cargo repo. 1-arg `detectTestCommand` stays first-wins. Empty stack → no invented command.

Single mutating writer is unchanged. PLAN-v41 is the contract. Plugin-iso reds (Node 22 has no `--allow-net`) are not this release. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite are not this release. `assumeYes` stays false.

## v37.0.0 — "langengine"

### Added (v37.0 — language-aware engine from real files)
- **Project stacks** (`langengine.js`). Language, version, framework, package manager, test/build/lint/format/typecheck, generated-code dirs — from manifests that exist. Mixed npm+cargo reports both. `discoverToolchain` (one test command, first ecosystem) stays frozen.
- **Optional LSP / compiler.** `binaryOnPath` never executes. Missing `rustc` / configured language server → `UNAVAILABLE`, never faked. No `rustc --version` spawn.
- **MICRO/SMALL skip.** A typo does not get a toolchain dump unless the task names the language.

Single mutating writer is unchanged. PLAN-v40 is the contract. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite are not this release. `assumeYes` stays false.

## v36.0.0 — "memgraph"

### Added (v36.0 — Memory ↔ World Model)
- **Graph-aware invalidation** (`memgraph.js`). A project note or lesson about `app.js` is stale when `util.js` (imported) moved — the v33 graph expands the v32 write ledger to importers, consumers, and tests. Empty graph / no files / no asOf → not stale (never invented).
- **Retrieval drops STALE.** `relevantMemory` / `relevantLearnings` omit project notes whose cited files (or neighbors) are newer than provenance. Global prefs with no file cites stay. Disk is not deleted; history remains, current truth wins in the prompt.
- **Lessons follow the graph.** `lessonIsStale` uses the same expansion, so the v34 same-file case still fires and a neighbor change now does too.

Single mutating writer is unchanged. PLAN-v39 is the contract. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite are not this release. `assumeYes` stays false.

## v35.0.0 — "langreason"

### Added (v35.0 — reason in the language you are editing)
- **Language-specific reasoning** (`langreason.js`). Planner, context, and repair get per-language constraints: Rust ownership/borrowing/unsafe, Python packaging/GIL/imports, JS/TS event loop and types, Go goroutines, C/C++ UB/RAII, JVM nullability, Swift ARC, C# async/LINQ, SQL isolation, shell quoting, Terraform state, Kubernetes reconciliation. Never apply one language's patterns to another.
- **MICRO/SMALL skip.** A typo does not get a Rust lecture unless the task names the language (`rust`, `cargo`, `pytest`, …).
- **Native verify, never invented.** `verifyFor(['rust'], { cwd })` is `cargo test` only when `Cargo.toml` exists. 1-arg `detectTestCommand` still prefers `package.json` (v32 frozen). Optional 2nd arg is the v35 path.

Single mutating writer is unchanged. PLAN-v38 is the contract. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite are not this release. `assumeYes` stays false.

## v34.0.0 — "skills"

### Added (v34.0 — right skill, right plugin, one integrator)
- **Skill evaluator** (`evaluate.js`). Score `name + description` against the task. Inject top 3. MICRO/SMALL get none unless the skill is named. `ok: false` hygiene failures are never selected. Fortune / gaokao / gift-evaluator no longer sit in a coding prompt. `load_skill("coding-agent")` still works when you name it. `FORGE_SKILLS_ALL=1` restores the dump.
- **Plugin selector.** Isolated user plugins join this-turn schema only when they match the task or are named. MCP and LSP always pass through. No implicit grants. Isolation / symlink refusal / same-run quarantine unchanged.
- **Integrator** (`integrate.js`, new read-only role). After 2+ upstream workers, one merge node produces a single apply list. The main coder writes. Empty reports → empty list (never invented). Conflicts recorded; later report wins. Fan-out short-circuits the integrator to this function — it is not a second model writer.
- **Stale lessons.** A lesson that cites files whose v32 index mtime is newer than `lastUsed` is dropped from retrieval. No files / no index → not stale.

Single mutating writer is unchanged. PLAN-v37 is the contract. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite are not this release. `assumeYes` stays false.

## v33.0.0 — "xlang"

### Added (v33.0 — one connected system, not per-language silos)
- **Cross-language graph** (`xlang.js`). Contracts from regex (HTTP routes, SQL tables, proto/GraphQL, OpenAPI paths, Docker services, CI jobs). Edges: IMPLEMENTS (same contract, different languages), CONSUMES (fetch/requests → producer), TEST, DEPLOY. `{id}` and `:id` routes normalize to one key. Built from the v32 index — unchanged files are not re-read.
- **Context slice.** `CROSS GRAPH (source → contract → consumer → test → deploy)` after the repo map. Empty graph is omitted, never invented.
- **Impact uses the graph.** `impactRadius` follows IMPORT/CONSUMES/IMPLEMENTS when the index connects; the v22 string-scan remains the fallback. `testsForFiles` picks tests along those edges. `skipUnchangedTests` only skips when a ledger of size+mtime is supplied (no ledger → skip nothing).

Single mutating writer is unchanged. PLAN-v36 is the contract. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite are not this release. `assumeYes` stays false.

## v32.0.0 — "index"


### Added (v32.0 — skip unchanged reads, map more languages)
- **Incremental code index** (`index.js`). Persist file fingerprints (size + mtime) plus extracted symbols under `~/.forge/projects/<hash>/index.json` via `writeStateFile`. Unchanged files are not re-read. Missing / corrupt / wrong-version cache → full parse, never a throw. `FORGE_INDEX=0` disables persist+reuse (always parse). A fingerprint without a `symbols` array is not a hit.
- **Language adapters** (`lang.js`). Regex adapters, no Tree-sitter. JS / Python / Go / Rust extractors moved here unchanged so `test-repomap` stays green. Extra adapters: Java, Kotlin, Ruby, PHP, C/C++, C#, Swift, Dart, Zig, Elixir, Shell, SQL, Terraform, Docker, Make. Unknown language is discovered (ext / basename / shebang), not refused. Extensionless shebang files are not opened on the walk (Termux-speed).
- **Project-native toolchain** (`discoverToolchain`). `detectTestCommand` is now `test || build` from real manifests, including Gemfile / composer / pom / gradle, still never invented. `package.json` with only `scripts.build` is still `npm run build`.

Single mutating writer is unchanged. PLAN-v35 is the contract. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite are not this release. `assumeYes` stays false.

## v31.0.0 — "browser"

### Added (v31.0 — drive and verify real UIs)
- **`browser` tool** (`browser.js`, 19th built-in). Actions: open, snapshot, click, fill, type, press, screenshot, scroll, back, reload, close, status. Opt-in binary: `agent-browser` or chromium/chrome (`FORGE_BROWSER` pins). Missing binary → `UNAVAILABLE`, the turn continues — never a fake browser (sandbox.js lesson).
- **SSRF + path policy.** http(s) goes through `assertFetchableUrl` (same pin as fetch_url). `file://` only via `safePath` inside the project. `javascript:` / `data:` / `blob:` refused. `about:blank` allowed. Local UIs: `tools.fetchPrivateUrls` / `FORGE_ALLOW_PRIVATE_URLS=1`.
- **Injected driver for tests.** `createMockDriver` / `ctx._browserDriver` so FORGE-BENCH and unit tests never need chromium. Live CDP talks to chromium over a zero-dep WebSocket; `agent-browser` CLI is used when that binary is the one on PATH.
- **Verifier may look, not drive.** snapshot / screenshot (no path) / open / status / close / reload / back. click/fill/type/press/scroll and screenshot-with-path are blocked in VERIFY. Screenshot-with-path is the only filesystem mutation; `browser` is not in `WRITE_TOOLS`.
- **Screenshots attach as vision parts** when the provider can see (v30). Pixels never land in the tool-result string.
- **`tools.browser`** default true. Not privileged — a project `forge.config.json` may set it false. `assumeYes` stays false.

Single mutating writer is unchanged. PLAN-v34 is the contract.

## v30.0.0 — "vision"

### Added (v30.0 — see screenshots, diagrams, failing-UI captures)
- **`read_image` tool** (`vision.js`, 18th built-in). Local raster files only (png/jpeg/gif/webp, magic-byte detect). SVG refused. Remote URLs refused (no fetch, no SSRF). Same `safePath` as `read_file` (`.env` / keys stay blocked). Result is still a string (mime, pixels, bytes); pixels live on `ctx._pendingVision` and are injected as a user message after the tool batch.
- **Real image parts, only when the provider accepts them.** OpenAI-shaped `image_url` data-URLs on the internal wire; `toAnthropicMessages` converts them to Anthropic `{ type: "image", source: { type: "base64" } }`. Remote `https://` image_url is a text stub, never fetched. Unknown / ollama text models → metadata only. Never invent a description of pixels the model cannot see.
- **768 KiB cap, 4 pending per turn.** Larger files return dimensions from the header and do not attach. Compaction (`stripOldVisionParts`) stubs all but the last vision message so base64 cannot explode the context.
- **`tools.vision`** default true. Not privileged — a project `forge.config.json` may set it false. `assumeYes` stays false.

Single mutating writer is unchanged. PLAN-v33 is the contract. Browser is not this release.

## v29.0.0 — "information-gain + FORGE-BENCH"


### Added (v29.0 — smarter experiments, prove it actually works)
- **Information-gain experiment picker** (`infogain.js`). After Ω names a hypothesis and ∞ names a causal layer, repair picks the next experiment by
  `(uncertainty + diagnostic + impact + reliability) / (cost + risk + time)`. Cheap read-only inspections beat expensive mutating repairs while the cause is uncertain. An experiment already run twice is excluded. FORGE-origin failures escalate; SAFETY_BLOCK aborts. MICRO/SMALL never get a full-suite experiment. `nextRepair().action` is unchanged (Ω/∞ tests stay green); `experiment` is additive.
- **Repair prompt gets the experiment.** `repairSegment` injects `Next experiment (id, gain, kind)` and emits `EXPERIMENT_SELECTED`. Avoided ids are listed so the model does not retry an uninformative probe.
- **FORGE-BENCH** (`bench.js`, `forge bench`). 12 deterministic cases, no live model: simple bug, multi-file, dependency, concurrency, state corruption, architecture change, cross-language, large repo, provider failure, crash recovery, adversarial hidden bug, long-running (9-check gate refuses false COMPLETED; replan keeps completed nodes). Scores correctness, root-cause, time, tokens, tool calls, regressions, false completion, recovery, replanning, resource efficiency. `--list` / `--json`.

Single mutating writer is unchanged. PLAN-v32 is the contract. Vision and browser are not this release. `assumeYes` stays false.

## v28.0.0 — "8-core burst"

### Added (v28.0 — 13T Pro 8-core / 12GB: faster, smarter)
- **MemAvailable, not MemFree.** `readAvailableMB()` reads `/proc/meminfo` so an 8-core 12GB phone is not classified low just because the kernel filled RAM with cache. Injected `{ freeMB }` still wins in tests. Starving (`freeMB < 700`) stays low.
- **Burst profile.** `cores >= 8 && totalMB >= 8192 && !low` → `burst`. Xiaomi 13T Pro is burst. A 12GB / 4-core laptop stays high, not burst (v27).
- **Burst workers.** `scaleWorkers` raises MEDIUM 4→6, LARGE 6→8, RECOVERY 4→6 on burst, capped at 8. MICRO/SMALL stay 0. `strategyFor` base numbers unchanged. Mutators still serialize.
- **Faster fan-out hang ceiling on burst:** `fanoutWaitMs("high", { burst: true })` is 5s. 1-arg `fanoutWaitMs("high")` stays 8s.
- **Lessons steer the first plan.** `lessonsForPlan` injects LEARNED FROM PAST FAILURES + avoided strategies into the model planner (`PLAN_LESSONS`). Never ASSUMPTION→REQUIREMENT.
- **Mid-task replan from verification evidence.** After 2 failed repairs / 2 consecutive failures / omega escalate, `replanRemaining` keeps COMPLETED nodes and prefixes new ids (`rp1_…`). MICRO/SMALL never replan. Burst may replan twice. Cycle replan is unchanged.

Single mutating writer is unchanged. PLAN-v31 is the contract. Vision, browser, FORGE-BENCH are not this release. `assumeYes` stays false.

## v27.0.0 — "high-capacity"

### Added (v27.0 — 12GB is high: harder, smarter, deeper, faster)
- **12GB / 4-core is high-capacity.** `resourceProfile` treats `totalMB >= 8192` as high (the user's 12GB laptop) unless the box is low: 2 cores, <2GB total, or <700MB free. 2-core CI and phones stay low. Tests inject `{ cores, freeMB, totalMB }`.
- **More workers on high:** `AGENT_BUDGETS.maxParallelSubAgents` → 8. Class caps MEDIUM 4 / LARGE 6 / RECOVERY 4 / ARCH 8. `workerCeiling` high = 8, normal ≤ 4, low = 1. Mutators still serialize. MICRO/SMALL stay 0.
- **Deeper auto on high:** `resolveEffort("auto", task, { tier: "high" })` deeps moderate work. 2-arg auto is unchanged (trivial stays shallow, complex goes deep) so `test-effort.mjs` stays green. `runAgent` passes the live tier.
- **Bigger high-tier budgets:** 4M tokens, 8s fan-out wait, 4000 context tokens.
- **Sandbox bash when bwrap exists** (`sandbox.js`): wrap *after* `modelMayRun`. Pid unshare, project bind, no net unshare. Missing binary → `/bin/sh -c` and `sandboxed: false`. Never a fake sandbox. `FORGE_SANDBOX=0` disables.

Single mutating writer is unchanged. PLAN-v30 is the contract. Vision, browser, FORGE-BENCH, mid-task re-plan are not this release. `assumeYes` stays false.

## v26.0.0 — "DAG fan-out"

### Added (v26.0 — read-only workers beyond 2)
- **Class worker caps**: MEDIUM 2, LARGE 4, RECOVERY 2, ARCH 6. MICRO/SMALL stay 0 unless the caller requested workers.
- **`AGENT_BUDGETS.maxParallelSubAgents` → 6** so the class cap is not silently min()'d back to 2.
- **`workerCeiling()`** in `resources.js`: low-tier / low-RAM (`freeMB < 400`) still 1. Normal ≤ 4, high ≤ 6. Config cannot exceed the budget. INCREASE_CONCURRENCY no longer hard-caps at 3.
- **`scheduleBatch` default maxParallel is 6**. Mutators still serialize one-at-a-time. Meta still filters `read_only` and drops `coder` workers.

Single mutating writer is unchanged. PLAN-v29 is the contract. Vision, browser, sandbox, FORGE-BENCH, mid-task re-plan are not this release.

## v25.0.0 — "unbounded execution"

### Added (v25.0 — operational budgets + in-project autonomy)
- **Raised default budgets** (`AGENT_BUDGETS`): 80 steps/segment, 180s bash timeout, 32 segment steps, 80 segments, 250 tool calls, 12 continuations, 32 KB tool output. The fuse is still a fuse — completion is the 9-check gate.
- **Bash timeout cap 900s** so a long test/build the user configured for is not killed at 5 minutes.
- **Autonomous interpreter eval**: a mutating `runAgent` pass may run `node -e` / `python -c` / `perl -e`. `tools.allowInterpreterEval` stays false in defaultConfig and is still stripped from project `forge.config.json`. Classifier tests that omit the flag stay green. CODE_DANGER (`os.system('rm -rf /')`) is still refused.
- **Autonomous in-project git danger**: `git reset --hard`, `git clean -fd`, `git checkout -f` run without `tools.assumeYes`. `git push`, `filter-branch`, outside-project rm, sudo, metadata, apt-get, npm publish, npm -g stay refused.
- **Class fuses raised** (MICRO 8 / SMALL 16 / MEDIUM 40 / LARGE 80 / RECOVERY 40 / ARCH 120). `classifyTaskComplexity()` is unchanged.

### Safety (unchanged, still tested)
- Block-class (`rm -rf /`, mkfs, fork bombs, dd to disk, shutdown) refused even with autonomous + assumeYes.
- `assumeYes` / `allowSudo` / `allowOutsideProject` / `fetchPrivateUrls` stay false. Project config cannot set them.
- SSRF, securefs write boundary, plugin isolation, PRIVILEGED_TOOL_KEYS — not this release.

PLAN-v28 is the contract. PLAN-v24 Tier 2–3 (vision, browser, sandbox, FORGE-BENCH) are not this release.

## v24.0.0 — "retrieval surface"

### Added (v24.0 — hybrid repo-map + lessons rerank)
- **Hybrid repo-map** (`buildRepoMapAsync`): the file walk and BM25 shortlist are unchanged. When an embeddings provider is configured, vectors only REORDER that list. A miss is the v23 BM25 map, never a wider scan.
- **Lessons rerank** (`relevantLessonsAsync`, `lessonsForPromptAsync`, `ineffectiveStrategiesAsync`): same contract — BM25 shortlist, embeddings reorder, throw/timeout → BM25.
- **Context engine** `buildAsync` now hybrid-ranks repo-map, lessons, and extra-file snippets (caller list only). `build()` stays synchronous BM25.
- **Agent prompt** precomputes `repoMapBlock` next to memory/learnings when embeddings are on. Delegated sub-agents stay on BM25.

∞ (v23.0.0) and Ω (v22.0.0) ship in this line; PLAN-v25 / PLAN-v26 still hold. PLAN-v24 Tier 2–3 (vision, browser, sandbox, FORGE-BENCH, mid-task re-plan) are not this release.

## v23.0.0 — "Forge ∞"

### Added (v23.0 — causal engine, self-diagnostics, adversarial review)
- **Causal engine** (`causal.js`): SYMPTOM / PROXIMATE / ROOT / CONTRIBUTING / SECONDARY. Repair targets a live ROOT when one exists; a REJECTED root is never retried. Counterfactual of an impact radius names `ifFixed` vs `stillAtRisk` (a miss is UNKNOWN, never "no dependents").
- **Self-diagnostics** (`selfdiag.js`): a failure is PROJECT or FORGE. Plugin/host death and safety blocks are FORGE — the repair prompt is told not to patch the user's repo around a forge failure.
- **Task model** (`taskmodel.js`): REQUIREMENT / IMPLEMENTATION / ASSUMPTION / INFERENCE / FACT. An ASSUMPTION never promotes to a REQUIREMENT.
- **RECOVERY class**: `classifyTask(task, { resume: true })` only. A typo is still MICRO; resume of a typo is RECOVERY with the underlying class preserved. `classifyTaskComplexity()` is unchanged.
- **Adversarial review** (`review.js`): LARGE / ARCHITECTURAL get a deterministic checklist before COMPLETED (secrets, assumption-as-requirement, blast radius, unknown impact). No extra model call. Findings warn; blockers become required actions.
- **Telemetry** (`telemetry.js`): process-local counters (`classify`, `command.fail`, `origin.forge`, `repair.loop_escalate`, …). No network, no files, no PII.
- **Failure taxonomy** expanded: CONFIGURATION, RUNTIME, INTEGRATION — patterns sit after TEST/BUILD so they cannot steal SyntaxError, TypeError, "unknown tool", or plugin crash.
- **HUD / banner**: `FORGE ∞`, cause + origin lines, `forge v${version} — ∞ autonomous engineering`. The `forge v${version}` prefix is unchanged.

Ω (v22.0.0) ships in this bump when stacked; the Ω contract in PLAN-v25 still holds.

## v22.0.0 — "Forge Ω"

### Added (v22.0 — autonomous software engineering system)
- **Task classifier** (`classify.js`): MICRO / SMALL / MEDIUM / LARGE / ARCHITECTURAL. The meta controller picks the smallest sufficient workflow. MICRO skips the model planner and synthesises a one-node DAG (inspect→patch→verify). `classifyTaskComplexity()` (trivial…critical) is unchanged — effort and model-strategy tests stay green.
- **Hypothesis engine** (`hypothesis.js`): OPEN → SUPPORTED / REJECTED / CONFIRMED / STALE. A rejected cause is never the next repair. Repeating the same (hypothesis, test) pair is a loop and is escalated, not retried.
- **Evidence log** (`evidence.js`): FACT / INFERENCE / HYPOTHESIS / UNKNOWN / VERIFIED / STALE, with provenance. A fact covering a file is stale the moment that file is written after `asOf`.
- **Impact radius** (`impact.js`): bounded import/test walk over changed files; testing scope grows from syntax → focused → module → integration → regression.
- **Structured command results** (`cmdout.js`): exitCode, signal, timedOut, killed, stdout/stderr, durationMs, truncated, pid/pgid. Success is the process result, never inferred from truncated stdout. The `[exit code: N]` marker still travels *outside* the truncation window. Long output is summarised (counts, first failure, duration) for the HUD; full text stays for diagnosis.
- **Ω kernel** (`omega.js`) + **HUD** (`renderOmegaPanel`): boxed, width-safe panel (FORGE Ω / Task / PLAN / ACTIVE / footer). Narrow terminals drop the box. `/status` renders the HUD. Meaning is never carried by color alone.
- **Failure taxonomy** expanded: TYPE, STATE, CONCURRENCY, ENVIRONMENT, PERFORMANCE, RESOURCE, TOOL — each has a specialised recovery plan. Existing codes keep their patterns.
- **Repair loop** feeds the hypothesis engine: a rejected cause is injected as "do not retry"; a looping (hypothesis, test) pair escalates. Impact radius of changed files is emitted as `IMPACT_ANALYZED` and passed to the read-only verifier as the testing ladder.
- **Worker cap by class**: MICRO/SMALL spawn no parallel workers unless the caller explicitly requested them.

v21.2.0 (MCP in chat, LSP SYNTAX ledger, eval consent, plugin quarantine) ships in this bump.

## v21.2.0 — "close the loops"

### Added (v21.2)
- **MCP in the interactive chat loop.** `chat.js` loads configured MCP servers through the same `loadMcpTools` path as `runAgent`, joins them to the plugin list, and closes every client on `/exit`, Ctrl+C, EOF and `process.exit` (stdin-close + SIGKILL fallback). Autonomous runs were already covered; the REPL no longer leaks MCP children.
- **LSP diagnostics feed the verification ledger.** After a mutating segment, `collectDiagnosticsForFiles` runs `lsp_diagnostics` on each changed file that has a configured language server and records the result as `SYNTAX` evidence. Error-severity diagnostics fail the hard gate for HIGH/CRITICAL the same way a failed `node --check` does. Off when `lsp.servers` is empty.
- **Inline interpreter eval defaults to `danger`.** `node -e` / `python -c` / `perl -e` / `ruby -e` need `tools.allowInterpreterEval` (user config only — stripped from project `forge.config.json`). Script-file execution (`node ./scripts/build.js`) stays `low`. The CODE_DANGER text scan remains an extra `block` layer, not the primary gate.
- **Same-run plugin quarantine.** `loadToolPlugins({ startedAt })` skips a `*.mjs` whose mtime is newer than the task/chat start, so a model that writes `~/.forge/tools/pwn.mjs` in segment 1 cannot have it `import()`ed in segment 2. `runMeta` stamps `pluginStartedAt` once and every segment inherits it.
- **Plugin grant symlink refusal.** A `read`/`write` grant that is a symlink whose realpath leaves the project (or plugin dir) is dropped. Plugin files that are symlinks escaping `~/.forge/tools` are skipped.

## v21.1.0 — "security perimeter + autonomous correctness"


_The version lives in exactly one place — `package.json` — and is read at runtime
via `version.js`. Every user-agent, banner and `--version` derives from it._


### Security (P0 audit — each item has a BEFORE/AFTER regression test)
- **Real DNS pinning for outbound fetches** (`netguard.js` rewritten;
  `tests/test-ssrf-pinning.mjs`, 166 checks). `fetch_url`, `web_search` and the
  doctor probe go through `pinnedFetch`: every A/AAAA record is resolved, any
  private / loopback / link-local / multicast / reserved / metadata address
  (IPv4, IPv6, v4-mapped, NAT64) rejects the whole request, the socket is
  pinned to the validated address (Host header and TLS SNI preserved), every
  redirect is re-validated, and a resolver that answers differently on the
  second lookup (DNS rebinding) can no longer reach the private address.
  Non-canonical IPv4 literals (`010.0.0.1`) are not addresses.
- **Secure filesystem pipeline** (`securefs.js` new; `tests/test-fs-toctou.mjs`,
  86 checks). Tool writes and checkpoint restores anchor on the project root's
  real path, walk components with `O_NOFOLLOW` / descriptor-relative opens,
  and write temp → fsync → rename. Traversal, encoded and absolute paths,
  symlinks and hardlinks pointing outside, nested symlinks, symlink/directory
  swaps between validation and write, and concurrent writers are all refused
  or serialised; a permission failure leaves the original file intact.
- **Plugin isolation** (`plugins.js` rewritten, `plugin-host.js` new;
  `tests/test-plugin-isolation.mjs`, 80 checks). Each `~/.forge/tools/*.mjs`
  plugin runs in its own **child process** under Node's permission model
  (`--permission`, or `--experimental-permission` on Node 20 — same
  enforcement) with a timeout, heap cap, scrubbed environment and no
  filesystem/network/child-process access unless the plugin declares the
  capability AND the user grants it in `tools.pluginGrants`. A child process
  rather than a worker thread because a worker shares the agent's pid and
  file descriptors: a worker-hosted plugin could write into MCP servers'
  stdin pipes, tamper with files the agent held open, or signal the agent.
  Messages travel over a dedicated fd-3 pipe as newline-delimited JSON (Node's
  IPC deserializer crashes the *receiver* on a malformed frame); a garbage or
  oversized frame only kills that plugin. Network is closed at three layers
  (builtin allow-list incl. `_http_*`/`_tls_*` internals, throwing stubs on
  `Socket#connect` / `Server#listen` / dgram / dns / tls / http2, no global
  `fetch`); file writers that bypass the permission model (`process.report`,
  `trace_events`, V8 heap snapshots / flags, `node:sqlite`) are refused;
  `Module._load` is frozen. Malicious plugins (reading `~/.ssh`, spawning
  shells, reaching the network via internal modules, spoofing protocol frames,
  exhausting memory, blocking forever, signalling the agent) are contained on
  Node 20 and 22. Known limitation (Node): symlinks inside a granted path are
  followed — a symlink planted in the project can expose files to a plugin.
- **Shell guard**: writes/deletes aimed at protected destinations are refused
  regardless of the program; uploads carrying data (`curl -d/-T/-F`, `wget
  --post-file`, `scp`, `rsync` to a remote) need `tools.allowNetworkUpload`;
  `( cmd )` / `{ cmd; }` grouping cannot hide a payload; `runBash` runs in its
  own process group and kills the whole group on timeout or abort.
- **Secrets**: prefixed credential names (`DB_PASS`, `REDIS_PASSWORD`,
  `DATABASE_URL`, …) and URL userinfo are redacted; MCP/LSP children get a
  scrubbed environment (`childenv.js`); project-level `.forge.json` can no
  longer set privileged keys (`allowSudo`, `assumeYes`, `allowOutsideProject`,
  `fetchPrivateUrls`, `allowNetworkUpload`, `mcp`, `lsp`, `plugins`, …) — they
  are dropped and reported (`loadConfig().ignored`, warned at startup).

### Changed (P1 autonomous correctness — behaviour changes, intentional)
- **DAG cycles are never "repaired" by dropping dependencies.** `repairPlan`
  reports `cycle{members,edges}` / `needsReplan`; `meta.js` re-plans once
  (`PLAN_CYCLE_DETECTED`, `PLAN_REPLANNED`) and WAITs for the user if the plan
  is still cyclic. Before: the back-edge was silently removed and the node ran
  before its dependency.
- **Failover checks compatibility and stops safely.** A fallback provider is
  skipped (`failover_skipped` event / warning) when its context window cannot
  carry the current prompt or its protocol cannot carry tool calls; when no
  compatible fallback exists the run fails with an explicit `ProviderError`
  instead of switching blindly in config order.
- **Context compaction is structure-preserving** (`compaction.js` new, used
  by both the agent loop and chat `/compact`). Turns are never split (a
  `tool_calls` message and its results move together), old tool outputs keep
  their first lines, error/exit-code lines and tail instead of being replaced
  by a stub, and a deterministic ledger (files changed, commands + exit codes,
  blocked actions, decisions) is folded in even when the summary model fails.
  Automatic compaction never returns a larger history. Before: index `slice()`
  + 400-character heads; a failed summary left the history unchanged so the
  overflow retry overflowed again.
- **Verification evidence is stale once the artifact changes.** Records carry
  cwd, env, repo state, stdout tail, timestamp and the writes that followed
  them; a passing check followed by writes to a file it covered — in the same
  segment or a later one — is invalidated (`VERIFICATION_INVALIDATED`) and no
  longer completes the task. Before: "tests passed, then edited the file"
  completed as verified.
- **Memory has one storage pipeline with provenance.** Every append / learn /
  forget / prune / replace goes through lock + temp + fsync + rename (mode
  0600), and each entry records who stored it (`cli` / `tool` / `subagent` /
  `agent` / `repair`), when and from which run on a comment line that is never
  injected into prompts. Legacy files read unchanged; `forge memory list
  --json` gains a parallel `provenance` array.

- **Failover consults the model capability registry.** `MODEL_CAPABILITY_REGISTRY`
  moved to the import-free `modelregistry.js` (re-exported from
  `modelstrategy.js`), so `providers.js`/`agent.js`/`chat.js` can use it without
  an import cycle. `providerCompatible` now defaults to it: a deep-effort
  (complex/critical) run only fails over to a `reasoning`-capable model; an
  unknown model is never rejected on capability, only on window/protocol.
  `buildProvider` derives `contextWindow` from the registry when the config
  omits it; an explicit config window always wins.
- **One crash-safe writer for `~/.forge` state** (`securefs.writeStateFile`):
  sessions, config, health, model cache, plans, profiles, run logs, task
  state, lessons, embeddings cache, todo, chat history and checkpoint
  manifests all go through O_EXCL temp → fsync → rename → dir fsync, mode
  0600, temp removed on failure. Before: several of these were plain
  `writeFileSync` (a crash could truncate `config.json` with the API keys).

### Added (tests)
- `test-state-writes.mjs` — fault-injection over the state writer (rename /
  fsync / ENOSPC / EACCES faults, real SIGKILL between temp and rename, 4
  concurrent writers with a torn-read detector, task-state critical flush).
- `test-checkpoint-crash-matrix.mjs` — restore of an M-file checkpoint killed
  after N = 1..M writes and during retirement: no torn file, manifest kept
  until a complete verified restore, resumed restore reaches RESTORED.
- `test-parser-fuzz.mjs` — 20 properties × 2500 random inputs over the plan
  parser, DAG repair, unified-diff parser, shell classifier, address parsing,
  provenance lines, compaction and verification evaluation.
- `test-hardening-v21.mjs`, `test-context-compaction.mjs`,
  `test-chat-compaction.mjs`, `test-verification-staleness.mjs`,
  `test-memory-pipeline.mjs`; extended failover / invalid-plan / checkpoint /
  version-consistency suites. `run-all.mjs` now drives 61 suites.

### Added
- **Model Context Protocol (MCP) client** (`mcp.js`, autonomy v23 Tier 1) — the
  industry-standard way to extend an agent with tools and data from an external
  process (filesystems, issue trackers, databases, browsers, internal APIs).
  Before this, forge could only be extended with local `*.mjs` plugins; MCP
  opens the whole ecosystem. Zero dependencies: an MCP stdio transport
  (newline-delimited JSON-RPC 2.0) with the initialize handshake, `tools/list`,
  `tools/call`, per-request timeouts, and clean shutdown — plus best-effort
  multi-server loading that records a failed server instead of throwing.

  Servers are configured under `mcp.servers` (**off by default**) and launched
  from that config only, never from model output — the same trust model as
  plugins. `mcpToolsToPlugins()` adapts a server's tools into the exact shape
  `plugins.js` already produces, with names namespaced `mcp__<server>__<tool>`
  (so they can never shadow a built-in) and treated as WRITE-class by default
  (the protocol does not reliably declare side-effect freedom, so the unsafe
  case is assumed). New `forge mcp [list|tools|test <name>]` inspects servers
  from the shell.

  **Wired into the agent loop.** MCP tools are loaded at the top of a run (never
  for a delegated read-only sub-agent) and joined to the plugin list, so they
  flow through the exact existing plugin path — `makeToolContext`, the capability
  registry (which classes them WRITE / verification-required), and the policy
  gate + safety engine — with no second execution path. Servers are shut down in
  a `finally` on every exit (success/failure/cancellation), gracefully via stdin
  close with a SIGKILL fallback, so a run never leaks a child process. The
  interactive `chat.js` loop is a deliberate follow-up (it `process.exit()`s at
  session end, so its server lifecycle needs separate handling and can't be
  integration-tested in-process). New `tests/test-mcp.mjs` (30 checks) proves
  the protocol against a stand-in MCP server — handshake, list/call, `isError`,
  namespacing, the plugin adapter, timeout on a hung server, launch failure —
  and, end-to-end, that the real `runAgent` invokes an MCP tool, the result
  flows back, and the server is shut down afterward.
- **Language Server Protocol (LSP) client** (`lsp.js`, autonomy v23 Tier 1) —
  the biggest *code-understanding* gain: real go-to-definition, find-references,
  hover types and compiler diagnostics from the same engine the user's editor
  uses, instead of a regex repo-map. Zero dependencies: an LSP stdio client with
  byte-accurate `Content-Length` framing (not MCP's newline framing), the
  initialize handshake, document sync (`didOpen`), `textDocument/definition`,
  `references`, `hover`, server-pushed `publishDiagnostics` captured and
  awaitable, and a polite `shutdown`/`exit` with a SIGKILL fallback so a run
  never leaks a child process. Servers are configured per language under
  `lsp.servers` (**off by default**), resolved by file extension, launched from
  config only — read-only, since a language server observes code, never mutates
  it. New `forge lsp [list|test <file>]` resolves the server for a file, opens
  it, and prints real diagnostics.

  **Agent tools wired in.** `lsp_definition`, `lsp_references`, `lsp_hover` and
  `lsp_diagnostics` — read-only, plugin-shaped — run over a per-run session
  manager that lazily starts one language server per language, keeps open
  documents synced with the file on disk (so results reflect edits the agent
  just made), and is closed with the run. They flow through the same plugin path
  and capability registry as every other tool; symbol-based tools take a name
  and locate its first word-boundary occurrence, so the model never computes a
  line/column. Loaded only at the top level (never per delegated sub-agent).
  Automatic feeding of diagnostics into the verification ledger is a separate
  follow-up; the tool exposes the evidence today. `test-lsp.mjs` (41 checks)
  proves the protocol and the tools against a stand-in language server —
  byte-accurate framing on a multi-byte document, diagnostics capture, symbol
  location, and end-to-end: the real `runAgent` invokes `lsp_diagnostics`, the
  result flows back, and the server is shut down afterward (no leaked child).
- **Semantic retrieval** (`embeddings.js` + hybrid `retrieval.js`, autonomy v23
  Tier 1) — embeddings-ranked relevance on top of BM25, with BM25 kept as the
  zero-config, **offline-safe default**. The safety rule: embeddings only ever
  **reorder the BM25 shortlist — they never widen it**, and every failure mode
  (disabled/unresolved config, HTTP error, malformed vectors, timeout, corrupt
  cache) degrades to exactly the v20.2 BM25 behaviour. Semantic retrieval can
  never break retrieval.

  `embeddings.js` is a zero-dependency OpenAI-compatible `/embeddings` client
  (batched, one transient retry, hard request-timeout guard, strict payload
  validation) with a sha1-keyed JSON disk cache under `~/.forge/cache`
  (atomic tmp+rename writes, pruned to `cacheMaxEntries`, invalidated on model
  change), and `resolveEmbeddingsConfig()` which resolves provider/model/key
  from `retrieval.embeddings` + catalog + env and refuses Anthropic (no
  embeddings endpoint) rather than guessing. `rankDocsHybrid()` fuses
  min-max-normalized BM25 and cosine scores
  (`fused = (1-α)·bm25 + α·semantic`, negative cosine clamped to 0) and tags
  every result `hybrid` / `bm25` / `bm25-fallback` / `bm25-timeout`.

  **Wired in:** `memory.js` (`relevantMemoryAsync`, `relevantLearningsAsync`),
  `context.js` (`buildAsync`, `rankAsync` — without an embedder these ARE the
  sync BM25 paths), the agent loop (precomputes the hybrid memory/learnings
  block for the system prompt; delegated read-only sub-agents stay on BM25,
  same trade-off as MCP/LSP) and the meta controller (`RETRIEVAL_MODE` event).
  New `forge embeddings [list|test <text>...]` shows resolved config, cache
  stats and live latency/cosine. OFF by default:
  `forge config set retrieval.embeddings.enabled true` turns it on.
  `test-semantic.mjs` (83 checks) proves fusion ordering across alpha, every
  fallback path, the cache, config resolution, the client against a local mock
  server, the async wiring — and end-to-end that the real `runAgent` calls a
  real `/embeddings` endpoint while **default config makes zero embeddings
  requests**.
- **`PLAN-v23.md`** — the review of the v21 agent and the roadmap to
  best-in-class (MCP, LSP, semantic retrieval, vision, browser, sandbox,
  benchmark), with MCP, LSP and semantic retrieval marked delivered.

### Fixed (audit of the semantic-retrieval layer — each with a regression test)
- **`forge embeddings test --json` broke the `--json` contract.** It printed
  human progress lines before the JSON document; the repo's contract
  (test-json.mjs) is exactly one JSON document. Now pure JSON, with the
  embeddings status pinned in test-json.mjs.
- **`rankDocsHybrid` index tag could collide with caller fields.** The doc
  index traveled under the string key `__ri`; a doc carrying its own
  `__ri`/`_i` field could corrupt the BM25↔doc mapping. Now a symbol-keyed
  tag — collision-proof by construction.
- **Context-engine memory slices bled across precision modes.** The cache key
  omitted `precision`, so a precise build (limit 6) could be served a
  normal-precision slice (limit 10) and vice versa. Latent since v21; fixed on
  both the BM25 and the hybrid paths.
- **Model change kept a stale cache `dim`.** Switching the embedding model
  discarded stale vectors but not their dimension; both are reset now.
- Audit also **proved safe** (and pinned where crash-worthy): the rerank
  budget-timeout absorbs late embed rejections — no unhandled rejection
  (which crashes Node ≥15); `coerce()` makes
  `forge config set retrieval.embeddings.enabled true` a real boolean;
  `agentview` ignores unknown events (`RETRIEVAL_MODE`); no API key ever
  reaches CLI output or error strings; endpoint resolution stays config-only.

### Fixed (full-system audit — P0 correctness, verification and recovery)

Every item below was reproduced first, then fixed, then pinned with a
regression test in `agentv19/tests/` (24 new suites, all registered in
`tests/run-all.mjs`).

**Completion could be declared before the work was done**
- **One of three DAG nodes finished ⇒ the task was reported COMPLETED.** The
  completion test was derived ad hoc at the call site instead of asking the
  graph. `dag.allComplete()` is now the single canonical check (works on a live
  graph *or* a serialized one), and `completion.canCompleteTask(task)` is the
  one authoritative gate: valid plan, valid DAG, all required nodes complete,
  all workers settled, verification satisfied for the final risk, recovery
  clear, no pending required actions, final state reconciled, and critical
  persistence flushed.
- **Execution success was treated as node completion.** A node went
  RUNNING → COMPLETED the moment its tools ran cleanly, before anything was
  verified — so a node could report "completed" while its own test run had just
  failed. The state machine is now
  `RUNNING → EXECUTION_SUCCEEDED → VERIFYING → COMPLETED | REPAIRING`, and
  `markCompleted()` refuses to complete a node without evidence.
- **A node was attributed to a segment by guessing.** Filename/keyword overlap
  decided which DAG node a segment had completed. Attribution is now always the
  explicit `nodeId` carried through Meta → Agent → Tools → Events →
  Verification → TaskState → DAG; `attributeSegment` still runs, but only as a
  labelled diagnostic (`applied: false`).
- **An invalid plan fell through into execution.** A plan that failed
  validation was "repaired", then executed anyway — and an empty plan silently
  collapsed into one generic mutation node. Failure now follows
  TASK → PLAN → SCHEMA → DEPENDENCIES → TARGETS → CONFLICTS → VERIFICATION PLAN
  → DAG → EXECUTION with a real repair + re-validation; if it is still invalid
  the task goes to WAITING with the reasons recorded, never to execution.

**Verification could be satisfied by nothing**
- **An unobserved exit status counted as success.** A command killed by a
  signal, OOM-killed, or never reporting a code was stored as `exitCode: 0 ⇒
  passed: true`. `UNKNOWN_EXIT_CODE` is now `null` (falsy *and* distinct from
  0), success requires an **observed** exit status of 0, and a failure shape
  (signal / killed / timeout / OOM / panic / build / test / …) is recorded.
- **Final risk was the planning risk.** A task described as "add a comment"
  was verified as `trivial` even after editing `package.json`, a migration and
  an authentication module. `finalRiskForChange()` recalculates risk from the
  files actually changed/created/deleted, the affected symbols, the security-
  sensitive paths hit, and the mutating commands/tool calls — monotonically
  upwards (`trivial → critical`).
- **The verifier could write.** "Read-only" blocked the write tools but not
  `bash`, and a shell redirection (`cat a.js > b.js`, `| tee out`) was allowed
  because the allow-list matched on the command *prefix*. Redirections and
  `tee` are now refused in read-only mode, a verification agent gets an
  explicit `VERIFICATION_TOOLS` allow-list (VERIFY ⇒ READ_ONLY), and repair
  agents get writes back (REPAIR ⇒ WRITE).

**Timeouts, orphans and cancellation**
- **A timed-out worker's late result could be reported as success**, and an
  orphan that ignored cancellation vanished from the books. Workers now carry
  `workerId/taskId/nodeId/segmentId/status/cancellationToken/startedAt/finishedAt`
  and follow REQUEST_CANCEL → WAIT_FOR_SHUTDOWN → CONFIRM_NOT_RUNNING →
  PERSIST → RECOVER; a result produced after the deadline is discarded and an
  orphan stays counted as active.
- **Settled worker records were never reaped**, so a long session grew the
  record map without bound. Settled records beyond `maxRecords` (200) are now
  dropped oldest-first; live records are never removed.

**Durability and recovery**
- **A segment that merely hit the safety budget was reported FAILED.** The fuse
  is now CHECKPOINT → PERSIST → WAITING / `CONTINUE_REQUIRED`, bounded by
  `agent.maxContinuations` (default 5) and recorded in the task
  (`continuation_count`) — past the budget the task genuinely is FAILED.
- **A terminal state that failed to reach disk was still reported COMPLETED.**
  Every CRITICAL flush is accounted; if the terminal write fails the task is
  downgraded to WAITING and says so.
- **A resumed task re-planned from scratch**, discarding the DAG the
  interrupted run was executing. A resume now restores the recorded DAG.
- **DAG conflict locking** uses the canonical `file:` / `symbol:` / `dir:` /
  `resource:` keys (an explicit `conflictKeys` declaration wins; an empty one
  is rejected by validation rather than silently ignored), and a node that
  conflicts conservatively blocks instead of running in parallel.

**Retrieval, routing and honesty of the artifact**
- **Model routing was decided by model names.** `modelstrategy` now records
  what a model actually achieved (provider, task class, ok/crashed, repairs,
  verification pass rate, latency, tokens, tool calls) and routes on that
  history, degrading a model after failures instead of trusting its label.
- **Outbound requests advertised the wrong version** — `forge-agent/20.0.0`
  and `forge/19` were hardcoded while `package.json` said 21.0.0. The user
  agent is built from the single `VERSION` source; a new suite fails the build
  if any module advertises a different one.
- **A lesson was a sentence, not a record.** Lessons now carry a derived
  failure class, symptoms, root cause, solution, files, symbols, ecosystem,
  model and strategy, with usage accounting — so a fix learned in
  `tests/auth.spec.ts` is retrievable by that file next time. A lesson that
  keeps failing loses confidence and is retired.
- **A hung language server stalled an agent step for 20s.** The default LSP
  request timeout is 12s (every caller may override it).

## v21.0.0 — "autonomous orchestration"

forge becomes a genuinely **autonomous, recoverable, long-running coding
agent**. Every existing boundary (ShellGuard, SafePath, NetGuard, secret
redaction, checkpoints, undo, provider failover, the terminal UI, sessions,
memory, skills, plugins) is preserved; the new code is wrapped **around** it.
New zero-dependency modules:

- **`taskstate.js` — task state engine.** One authoritative persistent record
  (`~/.forge/tasks/<taskId>.json`) with a validated 12-state lifecycle
  (IDLE → PLANNING → DISCOVERING → EXECUTING → VERIFYING → REPAIRING →
  CHECKPOINTING → WAITING / RECOVERING → COMPLETED / FAILED / CANCELLED).
  Impossible transitions are rejected, never made silently. Persists plan, DAG,
  completed/pending steps, files changed/created, tests run, verification
  evidence, errors, decisions, model/provider, checkpoints, resource usage,
  retry/repair counts, next action and timestamps.
- **`meta.js` — meta controller.** Replaces `Task → maxSteps → stop` with
  **bounded segments** that continue automatically: execute → observe →
  checkpoint → verify → continue, until the objective is satisfied. A fixed
  step count is never the definition of completion (only a per-segment safety
  bound and a generous task-level fuse). Failure drives diagnose → strategy
  change → repair → verify; interruption drives recover → reconcile → resume.
  Terminal status is always COMPLETED / FAILED / CANCELLED / WAITING.
- **`dag.js` — DAG planner.** Tasks are a dependency graph (id, objective,
  dependencies, status, priority, risk, cost, capabilities, result). Independent
  read-only nodes run concurrently; mutating nodes serialize and never race.
  Survives interruption via the task record; a failed node recomputes
  downstream instead of blindly continuing. `parsePlanToDAG` turns a model plan
  into nodes with inferred roles/dependencies.
- **`modelstrategy.js` — model strategy engine.** Separates proactive
  **model selection** (task → required capability → context → risk → latency /
  token budget → cost → best model among configured providers, with a
  structured decision + confidence + fallback) from reactive **provider
  failover** (which stays in `providers.js`). The active provider is never
  switched on a heuristic tie.
- **`agentmanager.js` — agent manager.** First-class worker pool: creation,
  scheduling, role assignment (researcher/coder/tester/reviewer/security/
  debugger/architect), priority, timeout, cancellation, pause/resume,
  concurrency, budget enforcement and conflict detection. Read-only roles for
  research/review/security/test; exactly one mutating context that still flows
  through Tool Intelligence + the Security Gate.
- **`resources.js` — resource manager.** Live RAM/CPU/disk/token/latency/
  workers/time tracking with adaptive decisions (reduce concurrency under low
  RAM, compact context near token budget, prefer a fast model on slow streaks,
  narrow retrieval on large repos). Adaptations never widen a security
  boundary.
- **`verifyledger.js` — structured verification ledger.** Evidence from actual
  execution results (exit code + output), never command names — `npm test` that
  exits 1 is a failure. Risk-proportional depth (docs → syntax; single function
  → focused test; core → focused + regression + build; security-sensitive →
  security checks too). Later **mutations invalidate prior evidence**; a later
  passing check supersedes an earlier failure.
- **`recovery.js` — recovery & effect reconciliation.** Unknown results are
  never blindly retried: inspect state → reconcile effect → decide
  (continue / compensate / retry / ask). Crash recovery loads task + journal +
  checkpoints, compares expected vs actual filesystem/git state, and produces a
  resume prompt that forbids replaying the last command.
- **`lessons.js` — failure learning.** Structured lessons (failure, cause,
  failed strategy, successful repair, applicable context, confidence) stored per
  project, redacted; the controller checks for previously-ineffective strategies
  before repeating an operation.
- **`context.js` — context engine.** Unifies RepoMap, Retrieval, Memory,
  Sessions, cache and the project profile behind one demand-driven,
  token-budgeted entry point; mutations invalidate affected cached state.

Integration:
- `runAgent` accepts a shared `runId` across segments (one `forge undo --run`
  rolls back a whole task), emits real exit-code verification evidence, and
  supports a no-tools planning mode.
- `runlog.openRun` merges across segments instead of clobbering.
- New `forge tasks` command (list / `--resume <id>` / `--all` / `--json`);
  interactive startup also surfaces interrupted tasks.
- New `forge agent --auto` runs the full meta-controller lifecycle; the default
  agent one-shot keeps its classic pinned output. New tests: `test-autonomy.mjs`
  (112 checks) added to the authoritative runner.

### Orchestration wiring (controllers now drive the modules for real)
- **Token & latency accounting is real.** `runAgent` accumulates per-round
  provider usage (`prompt_tokens` / `completion_tokens`, with an mtime-stable
  estimate when a provider omits usage) and returns it as `usage`; the meta
  controller feeds real tokens, tool calls, worker count and segment latency
  into the resource manager and the persisted task record (`resource_usage`),
  instead of `ms: 0`.
- **The DAG now drives execution and survives progress.** The persisted DAG is
  rehydrated on resume (completed nodes stay complete); each completed segment
  is attributed to its best-matching node and marked complete/failed (downstream
  nodes become READY); independent read-only READY nodes fan out to real
  **worker sub-agents** (researcher/reviewer/security) through the same
  security gate, while mutating nodes stay serialized on the main agent. Worker
  findings feed the segment context; the pool defaults off for injected/test
  agents and on for production (`agent.workers: false` disables it).
- **Boundaries take real checkpoints.** Risky segments and the first segment
  now call the checkpoint layer (`snapshotBefore` over touched files, or a new
  `boundaryCheckpoint` recording git HEAD + run label when nothing is touched
  yet), link the checkpoint id to the task record, and emit it with
  `CHECKPOINT_CREATED` — no more checkpoint events with no checkpoint behind
  them.
- **The demand-driven context reaches the model.** The context engine's block
  (plus completed DAG findings) is attached to every segment, repair and
  verification prompt via a separate `extraContext` channel, keeping the task
  prompt recognizable to the planner/failover logic.
- **Mid-task model reconsideration is live.** When the resource manager
  signals token/latency pressure (or the streak of slow segments trips it), the
  controller asks the model-strategy engine to reconsider and switches only on
  its margin-gated decision, emitting `MODEL_SELECTED` / `STRATEGY_CHANGED`.
- The worker manager accepts an injected `runner` (and re-`configure` of it),
  so the production pool and tests share one scheduling/timeout/concurrency
  path.

## [Unreleased] — v20.5.0 (in progress) — "tool intelligence"

### Added
- **Tool intelligence & capability layer.** forge no longer thinks "I have 17
  tools"; it thinks *"what capability is required, which tool provides it, is
  it safe, can it run now, can it run in parallel, how do I verify it, and what
  is the safest recovery if it fails"*. Five new zero-dependency modules, each
  wrapped **around** the existing safety architecture — ShellGuard, SafePath,
  NetGuard, secret redaction, checkpoints and the run journal are untouched and
  still have the last word.
  - *`capabilities.js` — capability registry.* One central place that describes
    every tool: `capabilities[]`, class (READ/WRITE/EXECUTE/NETWORK/SECURITY/
    VERIFICATION/RECOVERY), baseline `risk`, `read_only`, `reversible`,
    `parallel_safe`, `requires_confirmation`, `requires_network`,
    `requires_filesystem`, `timeout`, `cost`, `verification_required`,
    `idempotent`, `preferred_for[]`, `avoid_when[]`, `verify_after[]` and a
    lifecycle `status` (enabled / disabled / deprecated / experimental).
    Tool-selection knowledge lives here, not scattered through the agent.
    `operationRisk()` classifies the **actual operation**, not the tool name:
    `bash echo hi` is LOW, `bash npm test` is LOW, `bash git commit` is MEDIUM,
    `rm -rf build` is HIGH and `rm -rf /` is CRITICAL — the level is derived
    from shellguard, never re-implemented. A registry invariant is asserted in
    CI: the read/write split must agree with `tools.js` `WRITE_TOOLS`.
  - *`router.js` — tool router.* Takes task, state, available tools,
    constraints, risk and context; returns `selected_tool`, `reason`,
    `arguments`, `execution_mode` and a `verification_plan`, plus the chain the
    step belongs to. It prefers the **smallest effective chain**: "read
    src/app.js" is one `read_file`; "find where auth tokens are generated" is
    search → symbol search → read (and never an edit); "fix the failing auth
    test" is inspect test → locate implementation → inspect deps → edit →
    focused test → regression. Steps whose answer forge already has are skipped
    with a reason instead of being re-run. The router also schedules a batch:
    independent read-only calls run concurrently, mutations are serialized, and
    two writes to the same target are flagged as a conflict.
  - *`diagnose.js` — failure classification & recovery.* Every tool result is
    classified as INVALID_ARGUMENT / NOT_FOUND / PERMISSION_DENIED / TIMEOUT /
    NETWORK_FAILURE / DEPENDENCY_FAILURE / SYNTAX_FAILURE / TEST_FAILURE /
    BUILD_FAILURE / SAFETY_BLOCK / CANCELLED / UNKNOWN, and mapped to an ordered
    recovery strategy (retry once *only when the operation is idempotent* →
    reduce scope → alternate tool → fix arguments → escalate → abort). A safety
    block never suggests a retry. §17 escalation is explicit: forge asks a human
    for permission/credential decisions, irreversible high-risk operations,
    dependency additions and strategies that have already failed — not for
    ordinary coding work.
  - *`verify.js` — verification contracts.* Mutations declare what must be true
    afterwards and forge proves it, proportionally to risk: an edit is checked
    for "the replacement is really in the file" plus a real syntax check
    (`node --check`, ESM-aware; `JSON.parse` for JSON), a patch for "the files
    it touched exist", and high-risk changes additionally *recommend* a test or
    build run that the agent performs through the normal bash tool. Verification
    never runs `npm test` behind the user's back and never invents a failure:
    a file type with no local checker is reported as skipped.
  - *`toolintel.js` — the execution pipeline.* SELECT → capability check →
    policy gate → **existing** security controls → execute → observe → state
    update → verify → repair advice, emitting `TOOL_SELECTED`, `TOOL_STARTED`,
    `TOOL_OUTPUT`, `TOOL_COMPLETED`, `TOOL_FAILED`, `TOOL_RETRY`,
    `TOOL_FALLBACK`, `TOOL_BLOCKED`, `TOOL_VERIFIED` and `TOOL_CACHED` for the
    UI. It never repeats a call that already failed twice with identical
    arguments (it explains what to change instead), detects already-completed
    mutations (an edit whose replacement is already present is an idempotent
    no-op, not an error; `mkdir` of an existing directory is "already done"),
    serves identical reads from a mtime- and mutation-invalidated cache,
    retries a transient network/timeout failure exactly once for idempotent
    read-only tools, and records the full per-call state (`tool_call_id`,
    `task_id`, `run_id`, `arguments_hash`, timings, status, error,
    `files_changed`, `checkpoint`, `verification`).
- **`forge tools`** — inspect the capability registry: the table with class,
  risk, read/write, parallel-safety and status; `forge tools <name>` for the
  full metadata card; `forge tools --route "task"` to see exactly what the
  router would select, why, in which mode and how it would be verified;
  `--capability`, `--class` and `--json` for scripting.
- **Plugins register through the same system (§18).** A `~/.forge/tools/*.mjs`
  plugin may declare `capabilities`, `risk`, `parallel_safe`, `timeout`,
  `verification_required`, `status`, … and is routed, gated, classified and
  verified exactly like a built-in. Anything it does not declare gets a
  conservative default (write-class, not parallel-safe, verification required).
  No core change is needed to add a tool.
- **Config knobs** (all default to the safe/on setting):
  `tools.intelligence` (master switch — off restores the pre-v20.5 call path),
  `tools.verify`, `tools.cache`, `tools.maxRisk`, `tools.disabled[]`,
  `tools.deprecated[]`, `tools.experimental`, `tools.explainRouting`.

### Changed
- The agent loop and interactive chat now execute tool batches through the
  intelligence layer instead of their own copies of "reads parallel, writes
  serial". Behaviour is preserved (same ordering, same wire history, same
  `BLOCKED: write tools are disabled in this read-only agent` message) and both
  modes gain gating, classification, verification and observability.
- The agent system prompt carries a compact TOOL POLICY block generated *from
  the registry* (including which tools are disabled/deprecated in this project
  and the suggested chain for the task) instead of hard-coded tool advice.
- The terminal UI shows real verification results (the VERIFICATION panel is
  fed by checks that actually ran) and notices for blocks, retries, fallbacks
  and cache hits. `FORGE_DEBUG=1` prints a per-run tool-intelligence summary.

### Fixed (full-review audit of the new layer)
- **Argument hashing erased nested arguments.** `argsHash` passed a key
  allow-list to `JSON.stringify`, so `{edits:[{old,new}]}` serialized as
  `{"edits":[{}]}`: two completely different `multi_edit` calls produced the
  same hash, and a legitimate third edit could be refused as "already failed
  2× with identical arguments". Hashing is now a deep, order-stable
  serialization (array order still matters, because it is meaningful).
- **A retried call left no trace.** The abandoned first attempt was never
  finished or recorded, so a transient failure was invisible in `records()`,
  `stats()` and the debug summary, and the reported duration excluded it. The
  attempt is now recorded (`status: "failed"`, `retried: true`, plus a
  `TOOL_FAILED{willRetry:true}` event) and the durations are summed.
- **Escalation was reported as a block.** Asking the user for a judgement call
  emitted `TOOL_BLOCKED`, so the UI said "blocked" for a call that actually
  ran. It now emits its own `TOOL_ESCALATION` event, rendered as "needs your
  decision".
- **Chat dropped every structured event.** `createToolIntel` was constructed
  with `onEvent: null`, so verification results, blocks, retries, escalations
  and cache hits never reached the chat UI. They are bridged now (tool rows are
  still emitted once, by the chat loop).
- **Chat could serve a stale cached read.** The in-chat shell pass-through and
  `/undo` change files behind the layer's back; both now invalidate the cache.
- **Disabled tools were still advertised to the model.** A tool disabled by
  policy was sent in the request and only refused after the model called it —
  which teaches the model to keep calling it. `tools.disabled` (and
  `tools.experimental: false`) now filter the tool definitions in both agent
  and chat mode.
- **Context awareness was never fed.** The "skip a step the run already
  answered" logic (§11) had no producer in production: the layer now derives
  `readFiles` / `knownFiles` / `testsJustPassed` from its own records — a file
  that was read, or found by a search, is not rediscovered.
- **`intel.route(task, opts)`** lost the working directory when options were
  passed (the raw options overwrote the merged context).
- **Result-aware routing after a mutation was dead code** — it looked for a
  `mutation` field that no record carried. Records now carry `mutation` (and
  the router also accepts a WRITE/EXECUTE class).
- **Registry normalization left `klass` and `classes[0]` disagreeing** for a
  read-only tool that declared itself WRITE; both are corrected now.
- **Checkpoint attribution** could credit a call with an unrelated older
  checkpoint (in chat, where runs have no `runId`); it must now also be newer
  than the call.
- **Tool records are secret-redacted.** `tools.js` already redacts every
  model-facing result, but the per-call record is surfaced too (`--json`,
  `FORGE_DEBUG`, run inspection) and stored the raw slice — a stored secret is
  a leaked secret.
- `forge doctor` reports the registry invariant it always documented
  (`registry: 17 tools, classification matches tools.js`), `/status` shows the
  per-session tool-intelligence counters, and `describeRoute` is no longer glued
  to the end of a doc comment.

### Tests
- Three new suites in `npm test`: `capabilities` (metadata completeness, the
  WRITE_TOOLS invariant, lifecycle, plugin registration, operation risk),
  `router` (intent analysis, smallest chain, context skipping, constraints,
  scheduling/conflicts, cost awareness, result-aware routing) and `toolintel`
  (security integration, secret redaction, failure classification, recovery,
  timeout/watchdog, idempotency, caching, verification, escalation, tool state,
  events, UI bridge, the "layer switched off" regression path, and a dedicated
  block pinning every audit fix above).

## [Unreleased] — v20.4.0 (in progress)

### Added
- **Premium terminal workstation (interactive chat + `forge agent` in a TTY).**
  The interactive terminal is now state-driven, crash-safe and keyboard-first
  while the piped/non-TTY path, every command, tool, safety control and test
  keeps working byte-for-byte as before (`FORGE_UI=plain` forces the classic
  line renderer in a TTY).
  - *Architecture* — one central `UIState` (`uistate.js`: mode, task, plan,
    execution state, workers, tools, changes, tests, checkpoint, recovery,
    input, terminal) fed by explicit events (`TASK_STARTED`, `PLAN_UPDATED`,
    `TOOL_STARTED/OUTPUT/COMPLETED`, `FILE_CHANGED`, `TEST_*`,
    `CHECKPOINT_CREATED`, `ERROR`, `RECOVERY_*`, `TASK_COMPLETED/FAILED`,
    `USER_INTERRUPTED`, `STREAMING`); pure renderers (`render.js`); a single
    terminal output coordinator (`terminal.js`) that owns stdout while
    interactive — it hooks `console.*`/`stdout.write`, so *nothing* prints
    below the prompt; the agent is bridged into the store by `agentview.js`.
    Nothing in the UI is fabricated: progress % comes only from real plan
    items, the verification panel lists only checks that actually ran (parsed
    from their real output), `+/-` counts are real diffs.
  - *Header + adaptive layout* — persistent compact header
    `FORGE · MODE · RUN-xxxx · ● STATE · elapsed · provider/model` with the
    states READY/THINKING/PLANNING/EXECUTING/VERIFYING/RECOVERING/WAITING/
    COMPLETED/FAILED/CANCELLED. Very narrow terminals get `● EXECUTING 72%`,
    medium ones a one-line step/files/tests summary, wide ones the TASK/PLAN/
    ACTIVITY(/WORKERS) dashboard — all live above a prompt that never moves.
  - *Input layer* — grapheme-aware editor (`editor.js`): cursor keys,
    Home/End, Ctrl+A/E/K/U/W/Y, word jumps, Backspace/Delete on emoji and
    CJK, multiline (`\` continuation, Alt+Enter), ↑↓ prefix-aware history,
    Ctrl+R reverse search, Tab command completion (`/hel` → `/help`), inputs up
    to 200k chars windowed to the screen. Real **bracketed paste** (`keys.js`):
    pasted text — any size, any number of lines — is inserted atomically and
    never executed line by line. History is deduped, multiline-safe and never
    stores secrets (`/key …`, `sk-…`, `export *_KEY=`).
  - *Render lock* — streaming output, tool rows, console.log from plugins,
    even `process.stdout.write` from a tool all land *above* the live region;
    the typed draft and cursor are restored after every frame. Status is a
    single updating row (`● Thinking 14.2s`), never repeated lines.
  - *Tool rows* — `✓ shell  npm test  1.2s` with target, duration, exit code
    and a collapsed body (`120 lines hidden — /details`) that surfaces error
    lines; `/details [N]` expands the last/N-th tool output.
  - *Agent console* — objective, current step, workers (`/agents`,
    `/agent NN`), plan with nested steps, CHANGES panel (`/diff [file]` shows a
    real unified diff against the pre-run baseline), verification panel,
    repair loop (attempt · diagnosis · verification), completion/failure/
    cancel panels with concrete next steps. Also used by `forge agent` and
    `forge plan apply` when run in a TTY (piped output unchanged).
  - *Honest cancellation* — Ctrl+C during a run shows `Stopping…` →
    `waiting for current tool to terminate (name)` → `✗ tool … cancelled` →
    `✓ execution stopped safely` (+ checkpointed files, session saved, input
    restored). Bash and sub-agents honour the abort signal; nothing claims to
    have stopped before it has. Ctrl+C with text clears it; twice on an empty
    prompt exits; Ctrl+D EOF; Ctrl+L redraw.
  - *Crash-safe recovery* — every write run keeps a journal
    (`~/.forge/runs/<runId>.json`, `runlog.js`). A run whose process died
    mid-flight is detected on the next start (dead pid) and shown as a
    `FORGE RECOVERY` panel with `[R]esume [V]erify [U]ndo [C]ancel`; nothing is
    replayed automatically. `/tasks` lists runs (running/completed/failed/
    cancelled/undone), `/checkpoints` lists snapshots, `/undo --run [RUN-xxxx]`
    and `forge undo --run RUN-xxxx` roll a whole run back by its short id.
  - *Command palette* — `/help` `/status` `/plan` `/tasks` `/agents`
    `/memory` `/sessions` `/checkpoints` `/diff` `/undo` `/retry` `/verify`
    `/clear` `/settings` `/details` `/normal` `/chat` with Tab completion and
    "did you mean" hints for typos (`/statsu` → `/status`).
  - *Accessibility & terminals* — restrained semantic colours, meaning never
    carried by colour alone; `NO_COLOR`; `FORGE_ASCII=1` (or a non-UTF-8
    locale) swaps glyphs for ASCII; `FORGE_A11Y=1` uses text labels
    (`SUCCESS:` `ERROR:` `ACTIVE:` `PENDING:`); `/settings dock|thinking|ascii|
    a11y|collapse on|off` persists to `config.ui`. Resize recomputes the
    layout and repaints without duplicating rows or losing the draft.
  - *Security* — the UI only renders what tools return through the existing
    ShellGuard/SafePath/NetGuard/redaction path; tool targets shown in rows
    are redacted (`Bearer [REDACTED]`).
  - *Tests* — new `tests/test-ui.mjs` (233 checks; registered in `run-all.mjs`
    as `ui`): text-width/Unicode primitives, header/dock at 20–200 cols,
    panels, key decoding (split escapes, kitty keys, 2 MB paste, CRLF), editor
    (graphemes, word ops, multiline, history, Ctrl+R), reducer + agent bridge
    on real files, unified-diff round trips, journal/recovery, and the
    coordinator driven against a VT100 emulator (`tests/vtscreen.mjs`) —
    render lock, single-region status, paste atomicity, Ctrl+C states, Tab,
    resize, `ask()`. When `python3` is available it also drives `forge chat`
    in a real pseudo-terminal: typing while streaming, 300-line paste, Ctrl+C
    mid-tool, SIGKILL → recovery screen, `/diff` + `/undo --run`, 40-column
    terminals, and asserts the piped path is unchanged. Existing suites
    (FAST 20/20, e2e 247/247, clean-room 56/56) stay green.
- **Session Operating Modes (`/agent`, `/normal`, `/chat`)** — Forge now supports
  seamless session-level switching between Normal Chat (conversational mode) and
  Agent Mode (autonomous engineering execution with full tool loops, checkpoints,
  planning, and verification). `/agent` activates Agent Mode or executes a task
  directly, while `/normal` and `/chat` return to Normal Chat mode. The prompt
  dynamically reflects the active mode (`[agent]`), and `/status` reports it.
- **Complete Export Coverage across all modules (100%)** — Every exported symbol
  across all 23 modules (135/135) is now directly named and verified by unit test
  suites (including `ui.js`, `onboard.js`, `providers.js`, `tools.js`, `memory.js`,
  `shellguard.js`, `netguard.js`, `diffpatch.js`, `plugins.js`, and `agent.js`).
- **Tests for effort classification, the model cache and skill indexing** —
  `classifyTaskComplexity`/`resolveEffort` decide whether a task gets DEEP
  reasoning (bigger budgets, slower, costlier), a user-visible and cost-relevant
  decision that had no test at all; `modelcache` backs the offline FREE badges;
  `indexSkills` is what puts skills in front of the model. New
  `tests/test-effort.mjs` (37 checks) covers the five complexity levels, every
  profile path (including that a switch is always explained, never silent),
  cache write/read/merge and corrupt-file resilience, and skill indexing with
  H1/intro-line description fallback. Export coverage 67.4% → 72.6% → **100%**.

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
