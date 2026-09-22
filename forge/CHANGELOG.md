# forge — CHANGELOG

One version, one place: the version lives ONLY in `package.json`; `version.js`
reads it at runtime and every user-agent is built from that single source.
Historical entries below are kept honest and short; completed plans are not
preserved — leftovers live in TODO.md.

## 122.0.0 — yolowise (full control is one switch, and it is inspectable)

### v131 — onewise (the controller is the default loop)

Package version stays **122.0.0** (dozens of suites pin the string; bumping it
is its own release). This is the named suite, same shape as v123–v130.

The default config has shipped `agent.autonomous: true` since v21. Two callers
disagreed about what that meant:

- `chat.js` ran the controller only when there was no TTY (`&& !ui`). Interactive
  Agent Mode was a one-shot. Resume already used Core; every other `/agent` line
  did not.
- `forge.js` required `--auto` or the string `"meta"`. Boolean `true` — the
  shipped value — was ignored. `forge agent "fix the bug"` never reached the
  DAG, plan critique, code review, gitship or requirement invalidation.

`useController()` in config.js is the one predicate. Chat and the CLI both
call it. The path is printed (`loop: controller` / `loop: direct`). Plan-only
stays one-shot. `agent.autonomous: false` / `"off"` / `"direct"` opts out.
`--auto` still means yes.

`think()` appends to `ctx.thoughts` and emits a `reasoning` event (the dock
already renders that vocabulary). The return string "Noted. Reasoning recorded"
was a lie; it now reports the recorded length. The agent loop hands `onEvent`
into the tool context so the event actually leaves the tool. The TTY result
card reads `toolCallsTotal` so a controller run no longer prints "0 tool calls"
because the adapter's `toolLog` is empty.

Ctrl+C during planning is CANCELLED, not a parked WAITING task — that early
return used to skip the function-end abort rewrite, so the next chat start
popped FORGE RECOVERY for a user who just cancelled. TTY CANCELLED uses the
same cancel card as the one-shot (`execution stopped safely`). The result
card no longer prints ✓ COMPLETED for a non-COMPLETED controller status.
Controller recovery [C] parks the task WAITING (excluded from
`interruptedTasks`) so "leave as-is" does not re-nag on every subsequent
start.

Pinned by `tests/test-v131.mjs`. The historical e2e printer contract
(`[step 1] bash`, `TOOL RESULT RECEIVED`) opts out with `agent.autonomous:
false`; the shipped default is still the controller.

CLI only. No Web OS. No SafetyManager. The owner's decision, recorded once.

v88 removed the shell guards and v87 defaulted `autoApprove` ON, so "all guards
off" was already the shipped posture — and work still got refused. Four layers
the switch never reached were doing the refusing, and a fifth (the prompt) made
the model refuse on the owner's behalf:

- **the governor's authority** (v101) froze or hid every write tool on
  INSPECT/SEARCH/PLAN/REPAIR-adjacent actions and turned ASK into
  WAITING_FOR_USER. Its `enforce` flag existed; nothing outside `governor.js`
  ever set it. `authorityFor(action, { klass, enforce })` now takes the owner's
  state: under YOLO the action, the depth, the directive and the
  `GOVERNOR_ACTION` event all survive, `forbidden`/`keep` are empty,
  `maskToolDefs` offers the full tool set, `enforceToolCall` never refuses, and
  ASK no longer waits. STOP still ends the run — closing a verified run is not
  a veto. `createCognition({ governorEnforce })` carries it to both the
  one-shot agent and `runMeta`, which had been building its own cognition with
  no idea who was in charge.
- **the pre-edit critique** (v112) made a path that merely *looks* secret-bearing
  (`SECRET_HINT` matches a file named `token.ts`) pause the whole run, and a
  third edit to one file a refusal. `critiqueVerdict(c, { klass, enforce })`
  keeps every concern as a note and drops the block; `agent.js` cannot pause on
  a critique ASK when enforcement is off. The checklist itself is never
  disabled by YOLO — the sentence is the useful part.
- **read-only workers** (verifier / reviewer / planner) had to match a
  12-prefix bash allowlist, so `pytest -q tests/test_auth.py`, `make lint`,
  `./check.sh`, `vendor/bin/phpunit` were refused mid-verification while `cat`
  of any file was allowed. `isVerificationGradeBash()` answers the same question
  structurally — no write redirection, classification ≤ `low`, no mutating
  program, no mutating git subcommand, every operand inside the project or
  scratch — which is *stricter* where the list was blind (`git commit`,
  `cp a ~/b`) and correct where it was merely small. The role itself is
  untouched: `write_file`/`edit_file`/`memory`/`todo` stay refused for a
  read-only agent, because "verification cannot change the artifact it
  verifies" is the verification contract, not a permission.
- **the capability router** (v105) withheld mutating MCP on INSPECT/VERIFY and
  froze all externals on ASK/WAIT/STOP — permission rules wearing a routing
  costume, since the model is never told the tool exists. `applyRoutePolicy` /
  `selectForTurn` take `enforce`; under YOLO the action-keyed drops stop while
  every quality gate (stale, measured UNRELIABLE/BROKEN, klass budget,
  native-already-covers) keeps working.
- **the system prompt** still said "catastrophic commands, writes outside the
  project, sudo and publishes are blocked — refine the command instead of
  asking the user to disable safety", four releases after v88 stopped blocking
  them. That is the one guard no config key can turn off: the model believes it
  and never tries. Both prompts (agent + chat) now branch on the same resolved
  state, and the stale `fetch_url`/`read_image` descriptions that claimed a
  protection the code no longer has were corrected.

`yolo.js` is the single resolution (`tools.yolo` ⇒ unrestricted, autoApprove,
assumeYes, sudo, outside-project, traversal, interpreter-eval, network upload,
new plugins, private URLs, no risk ceiling, governor+critique advisory), read
from `agent.js`, `chat.js`, `meta.js`, `toolintel.js` and `tools.js` — never
re-derived per file, and read LIVE in the two places a session can change it
(`/yolo` mid-chat no longer needs a restart to drop the ceiling).

Surface: **`forge yolo [on|off|status]`** — the status table names each layer
and its state, the grants implied, and the **five rails YOLO deliberately never
turns off** (project-config privilege strip, tool-result injection fence, secret
redaction, atomic/TOCTOU-safe writes, socket pinning) with the reason for each,
plus a second block, **kept for correctness, not permission** — a read-only
worker's write refusal and the v118/v119 completion gate. Listing them separately
is the point: `all safety off` must never be silently readable as `a result no
longer has to be true`.
Those are defences against *other people's code*, not friction for the owner: a
cloned repository must never be able to arm the agent that runs on the machine
that cloned it, so `tools.yolo`, `governor.*` and `critique.*` are privileged
keys (`sanitizeProjectConfig` strips them and says so). `--yolo` forces it for
one process; **`--safe`** is the opposite; `FORGE_YOLO=0|1` for the shell;
`FORGE_GOVERNOR=1` / `FORGE_CRITIQUE_ENFORCE=1` pin exactly one layer;
`governor.enforce` / `critique.enforce` accept `auto|always|never` so structure
can be kept without keeping the vetoes. `/status` in chat replaced its single
"NO GUARDS (v88 noguard)" line with the same per-layer truth, since that line
was the part of the UI that was wrong.

FORGE-BENCH unchanged at 24/24. `tests/test-v122.mjs` (158 assertions, 10
sections: resolution, governor authority, cognition wiring, critique, read-only
roles, router, who may arm it, the real exec path, the prompts, the CLI) joins
the run; three v85/v25/v27 source-grep pins that asserted the OLD shape of the
unrestricted implication were rewritten to assert the property — plus a new
behavioural section proving the implication is behaviour, not a grep.

Landing on top of v118–v121 changed two things about this release, and both are
reported rather than smoothed over. It was numbered **v117** while it was being
built; main had already spent v117 on searchwise and shipped through v121, so the
number moved and the suite is `test-v122.mjs` (the name collision was the
discovery — a per-release suite name is a shared namespace, and only a test run
across the real merge proves the two do not fight). And v118's completion work
made `cognition.enforce(gov)` a second path into `authorityFor`: that call is
threaded through the same `governorEnforce`, so a completion candidate that moves
the authority cannot re-arm a veto YOLO already removed. The gate itself is
untouched on purpose — it refuses a *claim*, never a command — and the run report
now says so: `authorityFor`'s enforced branch returns `enforce: true`, which v118
began surfacing in `GOVERNOR_ACTION`, the run's `governor:` field and the
AUTHORITY prompt line, where it had been reading `false` since the day it was
added because no branch ever set the key.

The third finding is the one that made a check go RED, and it was not this
release's code: Actions runs the `push` copy and the `pull_request` copy of the
same commit at the same time, and `test-v93r`'s health assertion slept a FIXED
2500ms and then read the OS socket table exactly once. `npm run dev` does not
own the socket — npm boots, node boots, the grandchild binds — so under doubled
load the port simply was not there yet at 2500ms, `health` said "no port
detected", and the sibling run of the identical SHA was green. A test that
depends on wall-clock luck is not a test. The sleep became a deadline, and the
root cause got fixed where it lives: `health()` (and `claim`, which shares it)
now waits a BOUNDED `HEALTH_DETECT_GRACE_MS` for a launched process to OPEN its
port — `grace_ms` is exposed on the `runtime` tool so a slow Vite app is a
parameter and not a false "not healthy" — while a boot that has already exited
fails at once with its exit code as the diagnosis, so the wait is never paid for
a crash. What no amount of waiting can do is turn a missing listener into a
pass; the refusal keeps its wording and gains the reason. v93r grew 54 → 72
assertions, including the proof that the wait happened, that it is bounded, that
it is switchable off, and that eight concurrent copies of the suite pass under
14-way load (they did not before).

## 113.0.0 — githubwise (GitHub is evidence)

CLI only. No forge-held GitHub token. No GitHubManager.

```
gh inspect (issues / PRs / checks / runs / repo)
        ↓
   Evidence (contract.noteEvidence)
        ↓
   Governor INSPECT / SEARCH
```

Writes (commit / push / `gh pr create`) stay in gitship: opt-in, consent-gated.

- one read-only `github` tool (allowlisted `gh` argv)
- knowledge-gap acquire prefers gh before the web when the task is GitHub/CI
- MICRO does not fetch GitHub
- shell-injection ids refused

## 112.0.0 — criticwise (doomed mutations do not run)


CLI only. No Web OS. No CritiqueManager.

`preMutationCritique` already existed and was advisory-only. The default
agent still executed missing-file edits, secret-path writes, and edit-thrash.

- missing edit target → BLOCK before exec
- same file mutated ≥ 3 times → REPLAN (no 4th patch)
- secret-bearing path → ASK (WAITING_FOR_USER)
- hub file → VERIFY (advisory, write still allowed)
- MICRO stays one-shot (advisory, not blocked)
- `FORGE_CRITIQUE=0` still disables the checklist

## 111.0.0 — jointwise (one route: depth + model + skill)


CLI only. No Web OS. The LLM is an instrument. No JointManager.

The leftover gap after v110: governor, metalearn, modelstrategy, and caplearn
picked independently, so a cheap-failing combo could still be assembled.

- `scoreRoute` composes the three pickers, then prefers a measured-better combo
- MICRO / `FORGE_LOCK_MODEL` / named skill still win
- live agent may switch model only when joint evidence says so
- cognition uses joint depth on the next similar task

## 110.0.0 — modelwise (measured-best model actually runs)


CLI only. No Web OS. The LLM is an instrument.

What was forgotten: `selectModel` / performance history already existed, but
the default agent never called them (modelstrategy imported agent → cycle).
Unrecognized custom model ids were also pinned forever, so history could not
switch.

- modelstrategy imports classify.js, not agent.js
- `applyModelChoice` on the live path (LARGE/SMALL)
- MICRO and `FORGE_LOCK_MODEL=1` keep the caller's model
- measured margin ≥ 3 can switch even for unregistered ids
- outcomes recorded into the existing modelstrategy ledger on close

## 109.0.0 — metawise (reasoning depth is learned)


CLI only. No Web OS. The LLM is an instrument. No second brain.

v106 learned which skill to use. v109 learns how HARD to think:

- record (klass, depth, ok) on cognition.close
- next similar task uses cheaper depth when success is equal
- LARGE cheap-depth failure keeps the deeper governor default
- MICRO never learns extra depth
- env drift (existing envfingerprint) discounts old cheap-depth stats
- ASK/STOP/PLAN authority unchanged
- strategy outcomes rank future PLAN lists (failed strategy is not preferred)
- env drift option discounts learned cheap depth
- retired lessons (confidence ≤ 0.15) no longer retrieve into default routing
- metalearn.json is project-local and survives restart

Not implemented (already exist or not this layer): lesson store, calibration
ledger, capability routing, 20 new event types, counterfactual replay UI.

## 108.0.0 — performwise (layers that planned now run)


CLI only. No Web OS. The LLM is an instrument.

What was forgotten: SEARCH, created tools, and model empirics *existed* but
did not perform.

- governor SEARCH runs `runAcquire` (local grep/glob/read/skill) once
- web is never auto-fetched; acquire is read-only
- after acquire, SEARCH does not fire again
- created tools search the tree; they no longer echo "designed for"
- failover chain is ranked by recorded model empirics (user's chosen model stays)

## 107.0.0 — createwise (gap → verified tool → future route)


CLI only. No Web OS. The LLM is an instrument.

v106 learned which existing capability to use. v107 extends that:

- a *repeated* capability gap (not a single miss) may design/implement/verify
  a project-local tool via the existing toolcreate pipeline
- only VERIFIED tools activate; CANDIDATE never reaches the agent
- MICRO/SMALL never create
- an ACTIVE created tool is reused, not duplicated
- created tools join `selectForTurn` and caplearn (kind: `created`)
- if X then fails on LARGE, the next LARGE turn withholds X
- no ToolManager, no co-router, no RFC crawler, no provenance UI

## 106.0.0 — capabilitywise (measured routing + free knowledge VOI)


CLI only. No Web OS. The LLM is an instrument.

v105 routed catalogs. v106 makes routing LEARN:

- `caplearn.js` records skill/MCP outcomes per task class (conditional
  reputation — strong for A, broken for B)
- UNRELIABLE/BROKEN capabilities are withheld on the next similar turn
  unless the user named them. That is the acceptance test: behavior change.
- Credit assignment from real `load_skill` / `mcp__*` records, not from
  "something failed somewhere"
- Knowledge gaps (existing knowgap engine) feed governor SEARCH — cheapest
  acquire (skill/repo) before a patch; the web is last and never auto-fetched
- Cognition prompt shows measured capability health
- Native / models stay in toolintel / empirics; this does not duplicate them

## 105.0.0 — routewise (smart skill + MCP routing)


CLI only. No Web OS. The LLM is an instrument.

107 bundled skills and a curated 100-server MCP catalog already existed.
Dumping them into every prompt is not intelligence. v105 is the router:

- klass budgets: MICRO/SMALL auto-inject nothing unless named
- quality gate: CANDIDATE skills are not auto-injected; stale playbooks
  are withheld by the turn router unless named
- INSPECT/VERIFY withhold mutating MCP; read-only MCP may stay via allow
- capability gaps recommend `forge mcp add` / `forge skill download` —
  never auto-install, never auto-connect
- load_skill stays available under INSPECT (skills are how the list is used)
- first-party tags for api-design, data-migration, code-reviewer, experiment-suite

## 104.0.0 — bindwise (wire the gaps, close the blind spots)


CLI only. No Web OS. The LLM is an instrument.

v103 learned. Several engines still sat idle on the default path, and one
heuristic silently treated `echo ok` as verification.

v104 binds what already existed:

- `isCoveringCheck` — a covering check is a real test/lint command that
  passed. `echo ok` / `ls` / a body containing the word "pass" is not
  verification. The live `observeTools` path uses this, not a regex.
- VOI experiments are recorded on the omega infogain ledger when a
  bash/test result lands, so the same experiment is not re-picked forever.
- PLAN ranks competing strategies (intent hypotheses, or smallest-reversible
  vs broader) instead of leaving the strategy list empty.
- World-model `testsFor` fills `expectedTests` on a live prediction;
  `invalidate` runs on every successful write so the world cannot stay stale.
- Dead `predictionCalibration` import removed (the prompt already used
  `predictionsForPrompt`).

## 103.0.0 — learnwise (self-model + intent invalidation + VOI)


CLI only. No Web OS. The LLM is an instrument.

v102 predicted and calibrated. The system still did not know itself, still
treated a changed instruction as a new original, and still patched before
the cheapest discriminating experiment.

v103:

- `selfmodel.js` — measured strengths/weaknesses from the prediction ledger
  and model empirics. Insufficient evidence is said out loud. Never a
  personality. Never auto-switches models.
- `absorbInstruction` — a changed instruction becomes v2 discovery; v1
  wording stays frozen; the prior plan is invalidated; a CONFLICT gap is
  recorded. Resume with a new objective uses this path.
- VOI — omega's information-gain catalog now feeds the governor: a
  discriminate experiment is TEST, an inspect experiment is INSPECT, not
  another identical patch.
- Default `forge agent` emits `SELF_MODEL` (calibrated, weaknesses,
  recommend, autoSwitch=false).
- Prompt carries SELF-MODEL + VOI EXPERIMENT on the live path.

## 102.0.0 — intelwise (prediction-calibrated intelligence)


CLI only. No Web OS. The LLM is an instrument.

v101 made the governor the authority. It still chose VERIFY/REPLAN with no
expected observation — so it could not tell a miss from a hit. `prediction.js`
already predicted DAG nodes for `--auto`. Default `forge agent` never opened
a prediction, never settled one, never recorded model empirics.

v102 closes the loop on the live path:

- `predictForAction` — deterministic prediction from intent/reads/scope,
  never from the model's self-reported confidence
- every EXECUTE/REPAIR on default `forge agent` opens a prediction
- settlement against actual writes emits `PREDICTION_SETTLED`
- file drift MISS → governor REPLAN (bounded, never MICRO)
- SCOPE drift → VERIFY before more writes
- objective-only predictions are UNSCORED (honest: "no files named" is not
  "I predicted zero files")
- competing strategies ranked by expected value (reversible + cheap first)
- cheapest-first capability router in the live prompt (native → skill → MCP
  → generated → model)
- default agent records `empirics` (model-outcomes.json) like meta already did
- calibration from the real ledger is injected when samples suffice

Not a rewrite. prediction.js, empirics.js, capfabric.js, omega stay the
engines they were. They now share the contract on the path everything uses.

## 101.0.0 — authoritywise (governor is the authority)


CLI only. No Web OS. The LLM is an instrument.

v100 put a cognitive core on the default `forge agent` path. The governor
chose INSPECT / VERIFY / ASK / STOP — and the loop ignored it. The model
still picked every tool. ASK emitted an event. VERIFY was a comment.
STOP never stopped.

v101 enforces the action:

- ASK / WAIT freeze the run as `WAITING_FOR_USER` (decisionengine.ask,
  no silent goal substitution)
- STOP ends the loop — but only after real verified work; a run that has
  not started is never halted
- VERIFY / INSPECT / PLAN / REPLAN on MEDIUM+ hide write tools and
  BLOCK a forbidden call (`TOOL_BLOCKED`) even if the model ignores the mask
- MICRO / SMALL keep mutation available (existing one-shot paths and the
  verify-nudge stay honest); ASK / STOP still always halt
- every step injects `(governor) GOVERNOR: ACTION [depth] — why` into the
  model request, replacing the previous governor turn so context does not grow
- `cognition.enforce()` / `authorityFor()` / `maskToolDefs()` /
  `enforceToolCall()` are the authority surface; agent.js is the live path

Not a rewrite. Omega, world model, verifyledger, completion, engmemory stay
the engines they were. The governor is no longer a narrator.

## 100.0.0 — cognitionwise (unified cognitive core)

CLI only. No Web OS. The LLM is an instrument.

Default `forge agent` used to skip the kernel entirely — the model picked
every tool, omega lived only on `--auto`, and `core.nextBestAction` was a
read-only view. v100 puts ONE cognitive core on the live path:

- `usermodel.js` — explicit vs inferred, competing intent hypotheses,
  preference provenance + decay, structured feedback, negative knowledge,
  decision authority, attention economics (ask only when inspect cannot)
- `contract.js` — versioned intent (v1 frozen), requirements that refuse
  ASSUMPTION→REQUIREMENT, gap analysis, IMPLEMENTED ≠ VERIFIED ≠ CLOSED
- `governor.js` — chooses THINK/INSPECT/…/ASK/STOP from that state
  (VOI-directed; MICRO stays L1; looping forces REPLAN)
- `cognition.js` — composes those with the existing omega kernel
  (hypothesis/evidence/causal/infogain). Persist `cognition.json`.
- `forge cognition` — inspect the core without a model
- `agent.js` loads cognition on the DEFAULT path (sub-agents stay executors)
- `meta.js` uses `createCognition` instead of a second kernel; DAG node
  objectives actually reach the segment task

Not a rewrite. Omega, world model, verifyledger, completion, engmemory,
prediction stay the engines they were. They now share a contract.

## 99.0.0 — loopwise (the agency release)

- Expanded the offline MCP catalog from 12 hand-written presets to a generated,
  pinned top 100 sourced from active official MCP Registry records and GitHub
  repository health metadata. GitHub's maintained hosted MCP server and MCP ECC
  are explicit inclusions. Catalog search/filtering, `forge mcp info`,
  transport-aware list/test output, and environment-referenced credentials keep
  discovery useful without writing token values into Forge config.

The user-facing verdict on v98 was blunt: the agent STOPS too soon (~25
steps), nothing reviews the code it writes, repairs fly blind, plans are
never questioned, and reaching the wider skill/MCP ecosystem is manual.
v99 answers each in the house way — strengthen existing loops, never
rewrite, every behavior pinned.

- THE STOP FIX: the direct one-shot agent now auto-extends its step AND
  tool-call budgets while PRODUCTIVE (fresh successful writes, passing
  verification checks, or ≥4 distinct tool signatures in the last 10
  steps — and never with a 4× signature loop or a 6-error streak), in
  increments bounded by the same hard caps (1000 steps / 500 calls).
  Each extension emits `step_budget_extended` with its evidence; a
  stalled run still stops honestly (INCOMPLETE + checkpoint + resume) and
  budget exhaustion still never completes (§5). Segment callers
  (maxStepsOverride) are untouched — meta's segment table instead DOUBLES
  (MEDIUM 22→40, LARGE 32→60, ARCHITECTURAL 40→88, RECOVERY 20→30,
  MICRO 8→14, SMALL 14→24, fallback 24→40, cap 64→128; shrink factors
  and floor unchanged).
- THE REVIEWER: codereview.js — after a clean mutating segment, ONE
  bounded read-only review of the actual change: working diff vs HEAD
  (per-file caps, working-tree truth — never the index), the gate's LSP
  diagnostics REUSED (one spawn serves both), failing ledger evidence,
  secret + debugger + TODO + mega-edit smells on ADDED lines.
  Deterministic findings stand alone; a reviewer agent pass adds
  strict-JSON findings (honest parse: garbage never invents); blockers
  become required actions; `CODE_REVIEW_*` events persist; cost bounded
  by `review.maxPerTask` (default 4). Also fixes the v94 latent deadlock:
  required actions were add-only until whole-gate success — recurring
  prefixes (review:/requirement /codereview:/critical-risk runtime
  validation:) are now dropped and re-derived on every completion
  attempt.
- THE FIXER: repairSegment gets a structured DEFECT REPORT (live LSP
  diagnostics on changed files, the last 5 failing verification records,
  the read-only verifier's report — requestVerification now RETURNS it
  instead of discarding) and a deterministic fast path (autofix.js): a
  lint/format-shaped failure runs the project's OWN formatter once —
  allowlisted direct invocations only (no `npm run`), shellguard "safe"
  classified, 90s bound, result recorded as ledger evidence; the LLM
  repair runs only when the failure is not mechanical or the fix failed.
- THE PLANNER: plancritique.js — deterministic plan-QUALITY gate
  (coverage vs the objective's own terms, blob-node detection,
  verification-step presence for mutating plans, read-only balance,
  blind-first-step) plus ONE bounded revision pass when majors exist;
  the revision is adopted only if it re-validates (with the same
  structural repair the original plan gets) AND beats the original
  critique score. `PLAN_CRITIQUE` / `PLAN_REVISED` /
  `PLAN_REVISION_REJECTED` events; fast-path synthesized plans exempt.
- REACH: mcpcatalog.js — 12 curated well-known MCP servers
  (filesystem, memory, sequential-thinking, git, sqlite, postgres,
  playwright, puppeteer, brave-search, github, context7, fetch) with
  `forge mcp add/catalog/remove`: presets write the USER config through
  the same path `forge config set` uses (the privileged mcp section has
  exactly one sanctioned write path), required env vars become explicit
  empty placeholders with the exact fill command printed — secrets are
  never invented, prompted for, or stored by the catalog. skillregistry.js
  — curated best GitHub skill repos (obra/superpowers, anthropics/skills,
  Egonex-AI/Understand-Anything, zai-org/GLM-Skills) with raw SKILL.md
  URLs ready for the existing SSRF-guarded download path, `forge skill
  search` (local index, deterministic scoring) and `forge skill
  recommend` (stemmed matching). 4 new bundled skills: code-reviewer,
  perf-tuning, api-design, data-migration (106 total).
- DELIVERY: gitship.pr = "gh" opens real pull requests through the
  user's OWN gh CLI — passthrough, not an API client: forge never holds
  a GitHub token; requires explicit config + live consent (like push) +
  the commit actually pushed + gh authenticated; the PR body IS the
  PR-ready artifact; "PR already exists" is reported, never fatal to the
  delivery.
- PROOF: FORGE-BENCH 22→24 (+23-step-extension, +24-reviewer-fixer-
  planner); new suite tests/test-v99.mjs (95 assertions, 9 sections:
  raised table, real-loop extension/loop/kill-switch/override behavior,
  reviewer units + meta wiring, planner gate behavior, autofix gating,
  catalog/registry integrity, gitship pr honesty, source pins for the
  deadlock fix). 165 fast suites green; e2e/cleanroom pins updated.

## 98.0.0 — shipwise (the delivery release)

The competitive gap analysis (Forge vs Claude Code / Devin / Cursor / Codex /
OpenHands) named three existential deficits — regex-only language
intelligence, no git delivery, no injection defense — plus two v97 TODO
leftovers (artifact verification, visual regression) and one scale problem
(synchronous walking). v98 closes all six in the house way: nothing
rewritten, every fix wired into the existing systems, every behavior pinned
by a test.

- STRUCTURED EXTRACTION WIRED (the #1 gap since v93): langstruct.js — ONE
  LSP session per server (user config + the autostart table), bounded fan-out
  (time budget, file cap, concurrency), honest per-file fallbacks (server
  failure / zero symbols keep the lexical record and say so). Enriched
  records carry `symbolDetails: [{name, kind, line}]` + `extraction:
  {layer: 3, source: "lsp:<server>"}` and are written into the SHARED
  incremental index; the world model serves them to every consumer (repo
  map, locate, impact, knowgraph). The wiring is honest about cache
  semantics: enriched records are fingerprint-stamped at read time, and
  extractOne now reuses fresh index records (the same cacheHit law as
  walkIndexed) so a rebuild SERVES the structured record instead of
  overwriting it with a lexical re-extraction. INDEX_VERSION bumps 1→2 once
  (one-time re-extraction per project); memgraph's cycle-avoiding INDEX_VER
  copy moves in lockstep (the bump caught it drifting — compose/world
  lessons silently read empty until it was fixed).
- NATIVE JSON TIER (layer 1, the first above-regex production parse):
  .json records get JSON.parse with top-level keys as symbols; invalid JSON
  is reported as a failed native parse, never an empty success.
- VERIFIED GIT DELIVERY (gitship.js — kernel policy, never a tool; the wire
  stays 1:1): after the 9-check completion gate says ok, maybeShip() commits
  ONLY the run's verified files (explicit pathspec, never -A; .forge/**
  never ships; foreign dirty files are named and never staged), with
  forge trailers (Forge-Task-Id / Forge-Run) for crash reconciliation and
  an honest nothing-to-commit skip when the files already match HEAD.
  Identity: repo config wins, else per-invocation `forge-agent <forge@local>`
  (repo/global config NEVER written). branch:"auto" BOOKMARKS forge/<task>
  at the delivery commit (git branch — the user's checkout is never
  switched). push:"explicit" requires a live AUTHORIZATION ask; force is
  structurally absent from the arg arrays. A PR-ready text artifact is
  rendered from gate/ledger data (no remote API, no token trust). All OFF
  by default; `gitship` is a PRIVILEGED config section so a checked-in
  project config can never turn delivery on for everyone who clones. A
  delivery failure NEVER flips the task status — pre-v98 behavior (verified
  files in the working tree) is exactly the fallback. Events: GITSHIP_MODE/
  SKIPPED/COMMITTED (persisted to events.jsonl).
- PROMPT-INJECTION DEFENSE (contentfence.js, G4): every tool result enters
  the conversation through ONE constant attribution fence (header-only —
  the v20.0.1 exit-marker law is pinned by test), with an ADVISORY marker
  scan (instruction-override, role spoofing, identity rewrite, exfiltration
  prompt, policy disarm — surfaced in the header, never fatal). The shared
  data-not-instructions rule rides BOTH system prompts (agent RULES 8 +
  chat). `tools.contentFence` is a privileged key — a project config
  cannot strip the fence.
- WORLD MODEL AT SCALE (the TODO leftover): the documented 0/"unlimited" =
  NO CAP was UNREACHABLE (the resolver's !isFinite guard destroyed
  Infinity and silently fell back to 2000 — verified, fixed, pinned).
  extractOne batches index writes (one load + one save per incremental
  pass — was a quadratic N×N fsync amplification). expand()/locate()
  reuse their completed walk (the 3-walk chain became 1). buildAsync():
  the stat walk runs CHUNKED (cooperative setImmediate yields), in-flight
  callers share ONE promise (the fastwise warm-memo law), and a short
  async-fresh window collapses the per-query drift walks — invalidate()
  closes it immediately so mutations are never masked. The pure-sync
  surface (every existing test) keeps per-call drift semantics untouched.
- CONTRACT_DRIFT BEFORE-CAPTURE FIX (a real v97 bug): the §21 "pre-mutation"
  contracts were captured through the world getter, which REBUILDS and
  re-extracts from disk — so "before" was actually AFTER and drift could
  never fire. worldmodel.persistedRecords() reads the LAST RECORDED TRUTH
  from the persisted snapshot (no walk, no re-extraction), which is what
  the comment always claimed.
- ARTIFACT EVIDENCE (the TODO leftover): runtimesession.artifactRuntimeEvidence()
  observes what a build ACTUALLY produced in the conventional output
  locations for the matched adapter (dist/, build/, app/build/outputs/,
  target/ …) — bounded, read-only, never invented (no adapter → not
  applicable). Observed artifacts become VTYPE.ARTIFACT ledger records
  with positive evidence; their absence at critical risk (where
  verificationPlanForRisk has ALWAYS declared runtimeValidation that
  nothing enforced) is now a required action the gate refuses to complete
  over — the declared-then-ignored flag is enforced.
- BROWSER VISUAL REGRESSION (the TODO leftover): `browser visual_diff
  {name}` — first run CREATES the baseline (snapshot text + screenshot
  sha256) in the project state dir; later runs COMPARE (unifiedDiff of the
  canonical node text + pixel-exact hash verdict) with §42-style evidence
  phrasing (MATCH = positive evidence, DIFF = evidence AGAINST, re-baseline
  only via update:true). CDP screenshots gain captureBeyondViewport
  (full-page). visual_diff is a verification action (verifier agents may
  use it; page-mutating actions stay blocked).
- AGENT LSP TOOL GATE: the read-only LSP tools (definition/references/
  hover/diagnostics) now light up on the AUTOSTART table too — the last
  surface still gated on user config alone, matching what layer 3 reports.
- Tests: tests/test-v98.mjs (95 assertions, 7 sections) +
  tests/test-gitship.mjs (39 assertions, 9 sections) registered in
  run-all; FORGE-BENCH grows to 22 cases (+21-artifact-evidence,
  +22-injection-fence), 22/22 green. Version pins updated across the
  suites (131 test pins + e2e + cleanroom).

## 97.0.0 — unifiedwise (the one-brain release)

FORGE ∞ v97 FINAL UNIFIED ENGINEERING INTELLIGENCE UPGRADE, implemented in
the directive's own phase order (inspect first; no engine rewritten — new
modules where nothing existed, wiring where things were disconnected):

- §4 LOCAL-FIRST SOURCE RESOLUTION (non-negotiable): sourceresolve.js — the
  resolution ladder (explicit file → folder → local ZIP → https URL → git
  repo → workspace; remote search NEVER happens implicitly). ZIP-as-project
  is real: inspect (root/manifests/languages/tests/git metadata) → safe
  extraction (zip-slip guarded, CRC-checked, capped) → operate on the LOCAL
  project. Source records persist (sourceType/sourceId/origin/authority/
  reason/evidence/history) under the project dir; an explicit local archive
  WINS over a git cwd and the conflict is recorded; unresolvable inputs are
  refused, never guessed. CLI: `forge source`, `--source` on agent/chat/ask.
- §3 CANONICAL ENGINEERING STATE: core.engineeringState() — one read-only
  aggregate over the existing stores (identity, source, goal, work/DAG,
  verification, blockers, knowledge, resources, next-best-action). No second
  truth, no private copies.
- §5-§8 SESSION CONTINUITY: raw conversation transcripts (per-turn
  <id>.transcript.jsonl with ts/role/content/sessionId/projectId/classes —
  compaction folds the working context but NEVER destroys history anymore);
  per-message user classification (goal/requirement/correction/decision/
  preference/…, msgclass.js); AUTOMATIC rehydration — a normal `forge chat`
  in a directory with a recent session reattaches without --continue
  (chat.autoRehydrate:false or --new to opt out); §8 reconstruction with
  reality reconciliation (files that vanished are reported stale) in
  rehydrate.js.
- §15 WORLD MODEL CEILING REMOVED: the cap is a CONFIGURABLE BUDGET
  (FORGE_WORLD_MAX_FILES / world.maxFiles; 0 = unlimited), indexing is
  PRIORITIZED (manifests → entry points → src → rest → tests — never readdir
  luck), the stat walk always completes (stats.totalScanned), expand() pages
  in more on demand, and a locate() miss against a truncated world
  auto-expands once — a huge repo takes longer, never becomes invisible.
  semantic search follows the same budget.
- §26 COMPETING HYPOTHESES: a hard failure creates a belief DISTRIBUTION
  (diagnosis 0.5 / structural causal candidate 0.3 / environment-or-tooling
  0.2 when origin is unknown) — never one guess; hypothesisDistribution()
  exposes the normalized ranked set.
- §29 PREDICTIONS EXTENDED: expectedTests + expectedSteps declared up front,
  settled against reality (testsDelta/stepsDelta), calibration reports
  testBias/stepBias and the planner prompt names them.
- §33 UNIFIED CAPABILITY LADDER: one resolver across native tools → skills →
  MCP inventory → created tools (ACTIVE+verified only), with honest GAPS.
  Wired into the agent system prompt (gap line) and `forge caps <capability>`.
  §35: the created-tool lifecycle is CLI-reachable (`forge tool
  life|create|activate|deactivate`) — unverified tools still NEVER activate.
- §21 CONTRACT DRIFT: after a mutating segment, removed producers (renamed
  routes/tables/protos) and orphaned consumers are detected against the
  pre-mutation world and emitted as CONTRACT_DRIFT evidence.
- §41 RUNTIME LIFECYCLE: runtime `up` — (build) → launch → WAIT-READY
  (bounded health polling with backoff; readiness is EARNED by a probe) →
  verdict with per-stage evidence; a process that dies while waiting fails
  fast with the process evidence.
- §42 UI VERIFICATION EVIDENCE: the browser captures console errors, page-log
  errors and failed network loads (CDP Runtime.consoleAPICalled, Log.
  entryAdded, Network.loadingFailed); new `errors` action surfaces them — a
  rendering page with errors is NOT verified.
- §56/§88 TASK REPLAY: replay.js + `forge replay <run|task>` renders the
  recorded timeline (goal → state → action → decision → evidence → result)
  from the run journal, events ledger and task record — read-only, never a
  reconstructed story. CONTRACT_DRIFT/WORLD_INVALIDATED/ENVIRONMENT_DRIFT
  now persist to events.jsonl.
- §49 ZERO-WASTE: identical CONCURRENT model requests coalesce into ONE
  network call (in-flight only; nothing cached after completion).
- §52 ADAPTIVE PARALLELISM: the worktree writer ceiling is configurable
  (worktree.maxNodes / FORGE_WORKTREE_WRITERS, default 2, cap 8); conflict
  keys and the serialized merge lane are unchanged.
- §86 FORGE-BENCH 20/20: the four missing long-horizon categories added
  (runtime-failure, model-switch, session-rehydration, ZIP/local-source) and
  two new metrics (evidence quality — a runtime failure must yield a
  competing hypothesis set; memory continuity — transcript + classification
  survive, keyed by cwd).
- Tests: test-sourceresolve.mjs (38) + test-v97.mjs (109), all 162 fast
  suites green.

## 96.0.0 — unifywise (the wiring release)

Inspection first: five parallel audits of all ~140 modules found v95 had
implemented nearly everything — what was missing was WIRING. This version
reconnects the disconnected (no engine rewritten, every fix a repair):
engmemory task/conversation relevance bonuses fire; TTY resume goes through
the controller (resumeTaskId was silently dropped in the interactive path);
the Core lifecycle map matches meta's real events and meta emits TASK_RESUMED
+ REPAIR_COMPLETED (every phase recordable); empirics + variant outcomes have
production writers; §24 infogain experiments ride segment-1 context (the
"planner prompt carries it" comment was false); the taskmodel origin ledger is
fed from the plan (the no-assumption-as-requirement review check sees real
data); the completion gate checks requirement coverage (unaddressed
requirements block COMPLETED via required actions); the §30 structured handoff
reaches the reassigned worker; episode stage recorders receive the Ω kernel's
hypotheses/experiments/verifications/failed-approaches (and episodes persist
via securefs); runMany maxParallel is a real gate; conflict resolution
consults the world model (honest existence-claims only); MCP connects lazily
from a per-spec inventory cache (cold cache = the old eager behavior, warm
cache defers the spawn to first call, vanished tools are honest errors);
LSP autostart feeds verification diagnostics on the default path (opt-in
flag, pinned default kept); dag accepts "trivial" risk (one ladder with
plannerisk/verifyledger); external SIGTERM is KILLED not TIMEOUT; dead code
removed (reportConflict import, void fs, formatStrategy, hardShrink twins,
download twins). NEW: envfingerprint.js — the §50 environment fingerprint +
drift layer (advisory ENVIRONMENT_DRIFT with per-signal engineering impact,
FORGE_ENVFP=0 off); core.nextBestAction() — the §24 surface as read-only
introspection (pending decision > terminal next_action > live phase > idle),
in status() for the TUI, NOT a second decider; context budgetOverflow is
reported. Proven by tests/test-unifywise.mjs (72 assertions, 19 sections)
and tests/test-envfingerprint.mjs (27 assertions, 7 sections); 160/160 fast
suites green.

## 95.0.0 — worktreewise (isolated worktree execution for DAG nodes)

The last open KERNEL item of the TODO ledger — "nodes would run in a per-node
git worktree so parallel segments never see each other's partial writes;
design exists, no implementation, no test" — implemented, wired and proven by
the new `tests/test-worktreewise.mjs` (75 assertions, 9 sections, suite
"worktreewise", registered in run-all). No engine was rewritten: the fan-out
gains one dispatch lane, the single-writer discipline is kept per tree, and
every fallback is honest.

- worktree.js (NEW) — the worktree lifecycle over git plumbing (execFile with
  argument arrays, never a shell string): `createWorktree` (detached checkout
  of HEAD under .forge/worktrees/<run>-<node>), `captureChanges` (one
  binary-safe patch via `git add -A -N` + `git diff --binary`, .forge state
  excluded by pathspec so forge's own bookkeeping can never be merged into a
  project), `mergeBack` (CHECKED then applied: plain `--check`, 3-way
  `--check`, then apply — a conflicting patch NEVER half-applies; the
  conflicting files are NAMED; the tree stays untouched), `removeWorktree`
  (force + prune, registry updated to a terminal status so a removed
  worktree can never look live), `sweepOrphans` (crash-resume pattern: a
  worktree whose run AND owning pid are gone is swept at the next task
  start), `planIsolation` (eligibility: mutating, NO dependencies — a
  dependent node builds on shared-tree output a HEAD checkout cannot see —
  DECLARED conflict keys, pairwise disjoint, disjoint from the current
  node's keys, bounded by `worktree.maxNodes`, default 2), and
  `uncommittedFiles` (the shared-tree in-flight guard). Gates: default ON in
  a git repo; `FORGE_WORKTREE=0|false|off` or `config.worktree.enabled=false`
  opts out; non-git and no-HEAD are honest refusals.
- worknode.mjs (NEW) — the child-process worker entry. agent.js binds every
  subsystem to process.cwd(), so an isolated node runs as a CHILD PROCESS
  whose cwd IS its worktree — parallel agents can never chdir-race in one
  process, and the child's writes can only land in its own tree. The spec
  (mode 600 — it carries the provider key) and the result JSON live OUTSIDE
  the worktree so captureChanges never sees them; any non-zero exit means
  NO result — the parent maps that to an honest worker failure, never a
  fabricated completion.
- meta.js — the dispatch lane: after the read-only fan-out, READY MUTATING
  nodes that pass `planIsolation` AND whose declared targets have no
  uncommitted shared-tree changes are dispatched to per-node worktrees
  (role: coder — the one mutating role). They run CONCURRENTLY with the main
  agent (disjoint trees; true parallelism), and the MERGE BACK is serialized
  behind a post-agent barrier: `isoJobs` settle (capture → merge → ledger
  evidence → markCompleted with the merge record → removeWorktree) only
  after the main agent's writes are done and before the segment's
  verification accounting — the main tree has exactly one writer at every
  instant, so a lost update is impossible. Honest failure paths: worker
  failed/timed_out/exhausted → worktree discarded, node FAILED with the
  worker's reason; merge conflict → WORKTREE_CONFLICT event + bus mirror,
  the conflicting files named, the node FAILED, the worktree KEPT for
  inspection; clean worktree with a report → acceptance evidence; nothing
  at all → "outcome unverifiable". Creation failure or an ineligible node
  emits WORKTREE_UNAVAILABLE and stays serialized exactly as before — the
  never-list rule ("never run DAG nodes in a shared tree when they mutate
  the same files") is the reason this exists, not a license to break it.
  Task start sweeps orphaned worktrees from crashed runs
  (WORKTREE_ORPHAN_SWEPT). New events: WORKTREE_MODE, WORKTREE_CREATED,
  WORKTREE_MERGED, WORKTREE_CONFLICT, WORKTREE_FAILED, WORKTREE_REMOVED,
  WORKTREE_UNAVAILABLE, WORKTREE_ORPHAN_SWEPT.
- searchproviders.js — the v94 latent bug the version bump caught: a LOCAL
  `const VERSION = "94.0.0"` shadowed the single source of truth, so the
  search provider's user-agent advertised a stale version on every request
  (proven live by the version-consistency suite's real local HTTP server).
  It now imports VERSION from version.js — the v20.2 one-file rule restored.
- package.json — worktree.js + worknode.mjs added to files[]; version
  95.0.0. Test pins updated with intent preserved (VERSION assertions now
  expect 95.0.0 across the v2x–v9x suites and e2e-forge.sh).

## 94.0.0 — todowise (the TODO ledger, closed with proof)

One strengthening patch per open TODO.md item, each proven by the new
`tests/test-todowise.mjs` (81 assertions, suite #160, registered in
run-all). No engine was rewritten; every fix strengthens the module that
owned the gap:

- runtimesession — PROTOCOL-AWARE health probe: HTTP stays primary (status
  + latency evidence); on HTTP failure a real TCP connect (new
  `tcpConnectProbe`) separates "nothing listening" (ok:false, level
  "none") from "listener confirmed, no HTTP response" (ok:true, level
  "tcp", honest "no HTTP probe available" note). The §11 claim gate, the
  session evidence log and the `runtime` tool rendering are level-aware —
  a TCP/WebSocket service is no longer falsely NOT healthy, and "server
  started" is provable for it (process + listener). healthProbe is now
  async (it awaits the TCP fallback).
- runtime — EVIDENCE-BASED group kill: new `signalGroup`,
  `groupMembersEvidence`, `parsePsMembers` (exported). When kill(-pgid) is
  refused, members are enumerated from /proc (Linux) or a bounded `ps`
  parse (portable) and signaled individually; per-entry `killEvidence`
  records the method; the kill note names the walk. The old fallback
  signaled only the leader and orphaned grandchildren — same fix wired
  into tools.js runBash killTree. createProcessManager accepts a test
  `signalFn` injection.
- sandbox — KERNEL RE-PROBE: new `reprobeKernelSupport()` /
  `kernelProbeCount()`; the first observed bwrap startup failure re-probes
  the overflowuid/overflowgid verdict on the spot (tools.js v87 fallback
  path), so a kernel hardened after forge started stops burning a failed
  bwrap start per command. resetKernelProbe stays as the test affordance.
- checkpoint — WORKING-TREE DRIFT VERIFICATION: write tools seal a
  post-write hash (`sealEdited` — write_file, edit_file, multi_edit,
  apply_patch), and `restoreTransactional` gains a DRIFT phase that
  classifies each file against the manifest's (sha, postSha) pair:
  clean / forge-owned (undo proceeds) / EXTERNAL (kept, status "DRIFT",
  ok:false — unattributable work is never clobbered) / unattributed
  (reverts, drift REPORTED) / missing (recreated). The checkpoint is not
  retired on DRIFT. The legacy restoreOne (`forge undo` / restoreRun)
  gets the same external-work protection.
- codesearch — PERSISTENT SEMANTIC INDEX: chunk docs persist under
  ~/.forge/projects/<hash>/semantic-index.json (atomic write, versioned,
  bounded), fingerprint-validated per file with the house
  `${mtimeMs}:${size}` signature — drift beats the index (changed files
  re-chunk), deleted files are dropped, corruption rebuilds, small corpora
  (< 64 docs) skip persistence by design, FORGE_INDEX=0 opts out of load
  AND save. A fresh process adopts unchanged chunks and pays only the stat
  walk (cross-process, proven with real child processes). The module's
  writes are now only its own cache files under ~/.forge (honesty note
  updated); search results are unchanged — adopted docs feed the SAME
  rankDocs pipeline.
- toolcreate — MULTI-STEP SCRIPTED PROBES: designTool accepts
  `probeSteps: [{args, expectOk?, expectContains?, label?}]` (validated,
  capped at 12), verifyTool accepts an explicit `steps` override. The
  child imports the plugin ONCE and runs the sequence in order — module
  state survives across steps, so login → act tools are finally
  promotion-testable. Per-step evidence (ran/threw/error/matchedSchema/
  expectOk/expectContains/preview), a throwing step aborts the sequence,
  `passed` requires ALL steps green; no script → the classic single-probe
  contract, byte-for-byte.
- lsp — FIRST-PARTY AUTO-START TABLE: ts/js (typescript-language-server),
  python (pyright-langserver | pylsp), go (gopls), rust (rust-analyzer).
  A spec is used ONLY when the binary is actually on PATH (presence
  probed, memoized); user config always wins; `lsp.autostart:false` opts
  out. serverForFile falls back to the table, lspAvailability counts it,
  and extractStructured now runs the structured path by default on
  machines with a real server (proven end-to-end against a stand-in LSP
  over real stdio). Trust model unchanged: forge-shipped commands, never
  model output.
- TODO.md — all seven open items closed (each had exactly the test the
  item demanded); the two policy-gated leftovers (research crawler skill,
  DAG worktree isolation) stay open by their own promotion rules.
- Tests: test-v27 import pin and test-v93r healthProbe call updated for
  the async probe + wider sandbox import (intent unchanged). 157/157 fast
  suites, full suite green.

## 94.0.0 — fastwise (same intelligence, less wasted work)

What changed vs the deepwise build (deepwise made judgment wise; fastwise
makes the same judgment cheap and keeps it honest):

- NEW fastwise.js — ONE shared freshness layer, composed of house
  conventions instead of a second cache subsystem: createFreshMemo
  (fixed-window TTL like searchproviders' cacheGet, injectable `now` for
  deterministic tests, oldest-at eviction, the engmemory/critique
  `${mtimeMs}:${size}` signature as an optional drift check — drift beats
  the TTL, failures are never cached, a rejected pass is forgotten);
  fileFingerprint (the house signature with the "absent" sentinel).
- NEW likely-next prefetch: warmCaches runs ONE idle, deferred, unref'd
  warm pass per project per freshness window (60s TTL, FASTWISE_TTL_MS) —
  persists the world-model snapshot (later createWorldModel instances pay
  only the stat-only drift walk) and warms the semantic chunk cache with
  one bounded offline BM25 pass (embed=null; FORGE_INDEX=0 skips it —
  never fakes, never writes). Guided by likelyNext: plan-frontier file
  paths + knowwise knowledge-graph hubs, read through engmemory's ONE KG
  parser (no second graph implementation; the knowwise KG bootstrap is
  NOT duplicated — meta owns it, fastwise never touches it). Wired in
  meta beside the KG bootstrap timer; emits FASTWISE_WARMED once per
  fresh pass.
- modelstrategy.resolveLane: execution lanes (fast/balanced/deep) from
  signals forge already had — task complexity (classifyTaskComplexity),
  device tier/burst (injected from the resource manager), optional role
  class (crewroute stays the owner) — feeding the EXISTING selectModel
  opts (latencyBudgetMs 12s + costBias low for light tasks, nothing
  artificial for deep work, cost bias on low-tier devices). One strategy
  engine; no new decision path; deterministic.
- modelstrategy performance fix with a freshness contract:
  loadPerformance used to re-read model-performance.json on EVERY call
  (effectiveStats calls it twice per candidate — up to ~24 sync reads in
  one selectModel); now an mtime+size memo that re-reads the moment the
  file actually changes and never serves a stale or corrupt file.
  recordOutcome/clearPerformance behavior unchanged (pins re-verified).
- docs: forge --help documents FORGE_FASTWISE=0; README (root + inner)
  fastwise paragraph; PACKAGE_INFO fastwise bullet; package.json files[]
  += fastwise.js.
- DEDUP AUDIT (new test-fastwise.mjs section): tool names unique (29),
  capabilities 1:1 both directions, 34 catalog names unique, all 58
  aliases unique and disjoint from names, 102 skill dirs with unique
  case-insensitive names, unique frontmatter names, unique SKILL.md
  content hashes, no nested SKILL.md shadowing a top-level dir, chat
  commands unique — zero duplicates found, and now guarded so they cannot
  silently return. Suite count 158 → 159 (86 assertions in the new
  suite); no existing assertion weakened.
- doc repair inherited from deepwise: removed a stray duplicated
  `**v94 "gapwise"**` heading line in both READMEs.

## 94.0.0 — deepwise (judgment before action, continued)

- Plan competition + adoption (plannerisk.alternatives + adoptDecision,
  wired in meta): the ORIGINAL plan now competes as a candidate against
  the inspect-first / incremental-verify / conservative-order shapes on
  expected VERIFIED progress — the same thin-prior options for everyone,
  an apples-to-apples comparison. The winner is reported honestly (it may
  be the original), and when a shape-changing variant wins by >= 0.03
  expected verified progress at equal-or-better risk AND success, the
  planner ADOPTS it: the winner's real node definitions flow into the DAG
  (the read-only guard node becomes executed work, not advice), node
  predictions are re-stamped, and live risk restarts at the adopted
  estimate. conservative-order is excluded from adoption (it drops
  declared dependencies) — advised in plan_whatif, never auto-executed.
  plan_whatif renders the honest verdict ("vs original: ... by +N").
  PLAN_ALTERNATIVES carries adopted/why/successProbability; the
  not-adopted note text is unchanged.
- Pre-mutation self-critique (critique.js + toolintel): a deterministic
  checklist BEFORE a mutating call executes — secret-bearing target paths,
  edit-family targets that do not exist on disk (a certain failure, said
  before the wasted call), same-file edit thrash (>= 3 mutations of one
  file in this run, counted from REAL successful mutations only), and hub
  files (in-degree read from the knowwise floor graph
  .ua/knowledge-graph.json — deepwise reuses knowwise output instead of
  building a second graph; absent/stale/unreadable graph = check silently
  skipped). Advisory only: one TOOL_CRITIQUE event (declared in
  TOOL_EVENTS), one additive record.critique field, one result line in
  the same budget as the blast note (never "created"/"deleted", never an
  [exit code] tail, appended AFTER failure classification so it can never
  influence retry decisions). Off with tools.intelligence:false (exact
  raw pre-v20.5 string preserved — pin parity) or FORGE_CRITIQUE=0.
- Reality-to-risk closure: repairSegment outcomes now move LIVE risk
  (liveRisk.experiment) — the last dead path of the live-risk API; all
  three repair call sites pass the live risk through.
- 158 suites (test-deepwise.mjs: competition determinism, winnerDefs
  structural safety — no node lost, original deps preserved, acyclic,
  guard nodes read-only — the full adoption gate branch coverage, the
  critique engine + wiring + both off-switches + exact-parity, and the
  live-risk closure). package.json files[] ships critique.js.

## 94.0.0 — knowwise (living project knowledge + blast radius + Termux, continued)

- Auto-KG bootstrap (knowgraph.js): the FIRST task in any project writes a
  deterministic FLOOR `.ua/knowledge-graph.json` from the world-model
  extractors (repomap buildSemanticGraph over the persistent index — no LLM,
  no network, no understand-anything npm deps, which are absent). Schema-
  conforming (nodes file:<path>, resolved in-project import edges, honest
  empty layers/tour, truncated flag at the 500-file cap). A REAL
  understand-anything graph is detected by its (missing) forge generator
  marker and NEVER touched. Rebuilds only when the source inventory
  fingerprint (file count + size/mtime sum, self-excluded) drifts; corrupt
  floor graphs are rebuilt; atomic tmp+rename; never throws. Deferred +
  unref'd in meta (planning is never delayed; KG_BOOTSTRAPPED event). The
  existing readers — engmemory retrieval bridge (keyword-gated, confidence
  0.55, never fact) and kg_query's shared parser — light up with zero
  further wiring.
- Blast-radius prediction (impact.predictBlastRadius + toolintel): every
  successful write_file / edit_file / multi_edit / apply_patch gets a
  bounded prediction (buildCrossGraph at a 400-file cap) delivered as ONE
  advisory note line + record.blast + a TOOL_BLAST event (declared in
  TOOL_EVENTS). The note never contains "created"/"deleted" (journal
  classification pins) and never ends in `[exit code: N]`. Off with
  tools.intelligence:false (raw pre-v20.5 string preserved verbatim — pin
  parity tested) or FORGE_BLAST_RADIUS=0/False/off.
- Termux/NetHunter full-power shell (sysshell.js): every shell spawn site
  (model bash plainWrap, sandbox wrapBash incl. ro-bind of the shell's dir,
  process_spawn, both chat `!` exec paths) now resolves through ONE
  resolver: FORGE_SHELL (verbatim override) > /bin/sh > $PREFIX/bin/sh
  (Termux) > $SHELL > PATH "sh". Default on normal Linux is unchanged
  /bin/sh (v27 pin parity). forge doctor reports the resolved shell; the
  help text gained an honest "safety" rewrite (v88 noguard reality) + an
  "environment" section (FORGE_SHELL / FORGE_ALLOW_PRIVATE_URLS /
  FORGE_SKILL_ALLOW_PRIVATE / FORGE_BLAST_RADIUS / FORGE_INDEX /
  FORGE_FAILOVER). skilldl gained the additive FORGE_SKILL_ALLOW_PRIVATE=1
  opt-in for private skill mirrors (default behavior unchanged).
- New tests/test-knowwise.mjs (56 assertions): floor-graph schema + readers
  (retrieval + kg parser) + freshness/drift/preservation/corruption/honesty,
  blast engine + full pipeline wiring incl. both opt-outs and the exact-raw
  intelligence:false pin, behavioral KG_BOOTSTRAPPED through the real
  runMeta loop, shell priority matrix incl. the Termux branches via the pure
  pickShell selector. Registered in run-all.mjs (156 → 157 suites).

## 94.0.0 — skillwise (obra/superpowers engineering-process pack, continued)

The second external skills pack bundled as first-party skills (v94b
understand-anything precedent): **obra/superpowers** (MIT,
github.com/obra/superpowers) — the engineering PROCESS discipline layer on
top of forge's existing code/review/debug playbooks:

- 13 of 14 upstream skills bundled (brainstorming, test-driven-development,
  systematic-debugging, verification-before-completion, executing-plans,
  finishing-a-development-branch, receiving-code-review,
  requesting-code-review, subagent-driven-development,
  dispatching-parallel-agents, using-git-worktrees, using-superpowers,
  writing-skills). Upstream `writing-plans` is NOT re-bundled: forge ships
  its own adapted writing-plans already — the no-overwrite policy wins, and
  a test pins that the bundled copy was not silently swapped.
- Byte-identity: the 8 pure-process skills are byte-identical upstream; the
  5 platform-seam skills (using-superpowers, dispatching-parallel-agents,
  subagent-driven-development, requesting-code-review, writing-skills) carry
  an appended "## Forge execution notes" section with the upstream content
  preserved as a byte-identical PREFIX (subagent dispatch maps to forge's
  delegate tool, bundled templates/scripts resolve via the load_skill
  [skill dir:] header). sha256 manifest pins all 13 SKILL.md files against
  silent drift; the MIT license ships at skills/superpowers-LICENSE (outside
  the skill dirs, so imported trees stay pristine).
- Routing: FIRST_PARTY 21 → 34 (tags/aliases per skill, names unique, named
  skill wins, MICRO stays zero-auto-pick, understand-anything routing
  unbroken). 89 → 102 bundled skills; checkSkills validates all 102.
- Strictly-stronger pins: test-v53 (catalog 21 → 34, all 12 v53 + 9
  understand + 13 superpowers must stay), test-v94b (bundled skills
  89 → 102). New tests/test-skillwise.mjs (150 assertions: bundling,
  validity, sha256 manifest, file inventories, notes discipline, routing,
  load_skill seam, frontmatter/dir match).

## 94.0.0 — toolwise (read-only intelligence tools, continued)

Three new agent-facing tools (26 → 29), each a thin composition over engines
that already exist — no new subsystem, no model calls, no network, fully
deterministic reads over real indexes; all three are verification-safe
(READ class, verifier-allowed, MUTATION_CLASS.NONE) and doctor-self-tested:

- `kg_query` — natural questions over the project knowledge graph: who
  imports/depends on a file (worldmodel), blast radius, covering tests,
  symbol locate, recent changes, plus the understand-anything knowledge
  graph (.ua/knowledge-graph.json) via the engmemory bridge (the KG parser
  moved to module level so retrieval and the tool share ONE implementation).
- `plan_whatif` — simulate a plan (or a plan change: add/remove/update
  nodes) through plannerisk BEFORE committing: risk ladder, success
  estimate, factor breakdown, critical path + SPOF, alternatives for
  high-risk shapes, real failure lessons + prediction calibration as
  evidence. Estimates, never proof; it computes, it never executes.
- `code_context` — one-call context pack: semantic hits (codesearch, the
  same BM25/embeddings ladder as semantic_search) + the structural wiring
  of the top files (importers/tests/radius from the world model).

Capabilities registry stays 1:1 with the wire (29 entries, READ/low/
read_only). Strictly-stronger count pins in the existing suites (v30, v31,
v90, v92, v93, v93r, v94a, security, e2e /tools) now lock 29; the new
tests/test-toolwise.mjs proves the three tools against real engines.

## 94.0.0 — masterwise + tokenwise (Engineering Intelligence Core, continued)

No rewrite, no duplicate subsystems — composed over the existing engines:

- Engineering Intelligence Core (searchproviders.js, execcontroller.js,
  engmemory.js, plannerisk.js): adaptive search providers with honest failure
  (never a fabricated "no results"), the execution controller that can never
  mistake a step/segment budget for completion, the layered engineering memory
  (L1–L5 + evidence provenance), and the predictive risk-aware planner
  (plan risk, node predictions, reality delta, live risk updates,
  risk-based verification).
- TokenRouter provider: one OpenAI-compatible `/v1` gateway
  (`https://api.tokenrouter.com/v1`, Bearer key `TOKENROUTER_API_KEY`).
  Verified live (401 "Token not provided" without a key). Free-tier defaults
  (DeepSeek / Qwen / NVIDIA ids); `listModels()` returns the live model list
  once the key is set. 22 catalog providers.
- understand-anything skills pack bundled (89 bundled skills): understand,
  understand-chat, understand-dashboard, understand-diff, understand-domain,
  understand-explain, understand-figma, understand-knowledge,
  understand-onboard — with the subagent definitions shipped inside the
  referencing skills and forge execution notes appended to them. The
  knowledge graph (.ua/knowledge-graph.json) feeds engineering-memory
  retrieval (provenance-tagged, keyword-gated, never fact/verified).
- load_skill serves up to 64KB (the checkSkills ceiling) and prefixes the
  resolved skill directory; skills.js loadSkill ceiling matches.
- test-v53's first-party pin updated strictly stronger (all 12 v53 skills
  must remain + the pack registered); new test-v94b suite (71 assertions).

## 94.0.0 — gapwise (gap fix / integration patch on sensewise)

No rewrite — the confirmed v93 gaps, fixed in place:

- ONE completion contract for every execution path: `canCompleteFastPath`
  shares the whole-task gate's module/shape/invariants; budget exhaustion
  without a final answer is INCOMPLETE (RESOURCE_LIMIT) + boundary
  checkpoint + resume — never a fabricated COMPLETED. Run journals gain
  `incomplete` as a terminal state.
- workers: EXHAUSTED status (settled, `ok:false`, reassignable); meta's
  runner returns the full agent outcome; §35 retries an exhausted worker
  once, then the node FAILS honestly.
- Runtime Intelligence: `runtimesession.js` (evidence-based discovery,
  real health probes, the "server started" claim gate, an ownership ledger
  with pid-reuse-guarded crash reconcile) + the `runtime` tool (#26),
  verifier-gated.
- World model: persistent `world.json`, fingerprint-diff incremental
  builds, honest truncation, durable `invalidate()` wired to meta
  (WORLD_INVALIDATED).
- Core bus persists (bindTask + history replay) + a bounded events.jsonl
  engineering ledger with restart reconstruction.
- Language: documentSymbol structured extraction, LSP-first with a labeled
  lexical fallback; the layer-3 availability bug is fixed.
- Tool creation: `toolcreate.js` lifecycle with behavioral verification in
  a real child process; only ACTIVE+verified tools reach the agent.
- Learned skills: promotion requires recorded behavioral evidence + a fresh
  fingerprint; markStaleSkills wired into meta.
- Strategy 3.0: contextual factors + justification; outcomes stored with
  their context; meta records real outcomes.

## v93.0.0 — sensewise (three new senses, 25 tools)

- `process`: background process manager (spawn/poll/status/kill/list).
  Dev servers survive the tool call; poll returns only NEW output; ports
  are DETECTED from output and the OS socket table — never guessed; kill
  signals the whole process group; the lifetime fuse is a resource fuse
  (timeout-killed, never "exited 0"); live cap 8; children reaped and
  killed at forge exit.
- `repl`: persistent real Node REPL sessions — variables, imports and
  loaded data survive between calls; incomplete input is reset with
  `.break` (reported); timeout reports "still running", never fabricates;
  dead sessions restart transparently (reported).
- `semantic_search`: code search by meaning — BM25 (retrieval.js) reranked
  with provider embeddings when they resolve; any embedding failure
  degrades to plain BM25; truncated scans are reported; verifier-
  whitelisted and read-only.
- Island wiring completed: skillforge (agent/chat/compose/context),
  embeddings (agent/meta), memgraph (memory/lessons/compose), retrieval
  (+codesearch).

## v92.0.0 — wirewise (islands consulted by the living system)

- P0 FIX: agent.js plugin-load TDZ — `unrestricted` was referenced before
  its const declaration; the swallowed ReferenceError meant user tool
  plugins (~/.forge/tools) never loaded in any runAgent invocation.
- prediction ledger (§9): predict before every segment (DAG node targets +
  planning risk — never model self-confidence), settle against observed
  reality, persist bounded per project, feed real prediction errors back
  into planning as calibration.
- language adapters wired (§7/§8): every agent system prompt carries honest
  deep-vs-conservative coverage per language; the 8-layer parse ladder
  stays honest (absent = UNAVAILABLE, never invented).
- world-model consultation at planning (§5/§10): project shape, blast
  radius and covering tests of objective-named files (PLAN_WORLD_CONSULTED).
- integrator conflicts reported (§31): integrateResults overlaps were
  computed and discarded and the core handler was dead code — meta now
  emits INTEGRATION_CONFLICT in the exact claims shape with the evidence
  ladder, plus a bus WARNING mirror.
- /tools help shows the real (dynamic) tool count.

## v91.0.0 — corewise

- core bus + causal chains + episodes + decisions: the conversation-level
  intelligence islands became consulted subsystems instead of shelves.
- decisions.js records the why behind autonomous choices; causal.js links
  tool effects to outcomes; episodes bound and persist run narratives.

## v90.0.0 — gitwise

- git_diff / git_log / git_blame: dedicated read-only git views (HEAD /
  stage / worktree / any ref, path filter, context, line budget with loud
  truncation; blame window capped at 200 lines). execFile argument arrays
  only; base can never be a git flag; LOW-risk READ class, parallel-safe,
  verifier-whitelisted, doctor-self-tested. 19 → 22 tools.
- silent-stop fix: an empty model response (no text, no tool calls) used to
  end the run as "completed" with "(empty answer)". Now: nudge + retry on
  the same step budget (3 attempts); a persistent streak fails loudly with
  exit 1.

## v89.0.0 — fast (zero behavior change, byte-identical results)

- xlang traversals adjacency-indexed + memoized: was O(V×E) repeated ~40×
  per agent run (~60% of agent-step CPU) — a 400-file repo went 1.80s →
  0.39s per step.
- forge.js lazy-loads chat REPL / agent engine / tool registry per
  subcommand: CLI startup 218ms → 57ms.
- provider fail-fast: connect-guard expiry skips same-provider retries and
  goes straight to the failover chain (worst-case dead-provider stall ~94s
  → 8s).
- Anthropic prompt caching on the static prefix (tool schemas + system
  prompt) — cache-served from step 2.
- parallel test runner: FORGE_TEST_CONCURRENCY (default 4); bash suites
  stay sequential (shared port).

## v88.0.0 — noguard (owner's standing decision) + worker clamp

- nothing is refused and nothing prompts: block-class, danger/confirm,
  sudo, interpreter eval — all run; the refusal code paths are gone. No
  project write boundary, no sensitive-read block, no SSRF gate on
  fetch_url.
- bwrap sandbox is OPT-IN (FORGE_SANDBOX=1); default is direct /bin/sh.
- kept on purpose (correctness, not guards): read-only verifier/plan agents
  cannot write (VERIFY ⇒ READ_ONLY), secret redaction of key shapes, socket
  pinning, netguard policy on downloads.
- worker clamp: low-tier / low-RAM machines run 2 parallel read-only
  workers (floor, was 1); the absolute ceiling is 8 on any machine; burst
  scaling included; mutators serialize through a single writer.

## v87.0.0 — full control (broken-bwrap auto-fallback, zero pauses)

- sandbox: a bwrap that cannot build a user namespace (kernel hides
  overflowuid/overflowgid) is probed once and treated as missing; a bwrap
  that dies at startup is detected, the command re-runs UNSANDBOXED, the
  real output is returned (the wrapper error never leaks into results),
  the fallback is announced once, and the broken wrapper is skipped for
  the rest of the session.
- tools.autoApprove (default ON, owner-only): no failure class hands a
  decision back to the user — no "[forge] ask the user:" line, no
  TOOL_ESCALATION event. `--yolo` forces full control for the process.

## v61.0.0 — leftovers live in TODO.md

- completed PLAN files are retired: no PLAN-vN.md ships with the repo;
  unfinished ideas and known gaps live in TODO.md (open items only, nothing
  checked), and the CHANGELOG no longer points at a living PLAN file.
- kernel + package frozen against side writes: assumeYes stays false,
  allowNewPlugins stays false, and a cloned repo's forge.config.json cannot
  flip owner-only switches.

## v60.0.0 and earlier (abridged)

- v85: guarded install (y/N prompts, block list) — the shipped default
  later moved to unrestricted in v88; the cleanroom pins the guards OFF to
  keep testing them.
- v84 → v62: the autonomy hardening ladder — worker timeouts with
  cleanup, exact node attribution, DAG conflict detection, read-only state
  enforcement, invalid-plan refusal, max-segment continuation, verification
  scope and staleness (evidence epochs: stale evidence cannot pass),
  unknown-exit-code honesty, checkpoint integrity + restore + crash matrix,
  effect reconciliation, git recovery, model-routing history, MCP/LSP
  lifecycles, resource-leak audits.
- v21.1: security audit — securefs.js (TOCTOU-proof descriptor-relative
  writes, O_NOFOLLOW per component, symlink refusal), SSRF pinning,
  plugin isolation, shellguard classification split from execution.
- v20.3: installer checks (P1-10): a failing install runs npm exactly once,
  surfaces the real error, and offers the --prefix escape hatch.
- v20.2: `npm test` exists — one command runs every suite by exit code.
