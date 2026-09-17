# forge

Standalone terminal AI agent. CLI only. Zero-dependency Node.js. Talks
straight to providers.

**Version 122.0.0 — "yolowise"** — full control is ONE switch that every refusing layer
reads, and `forge yolo` prints the whole state. CLI only.

**v113 "githubwise"** — GitHub inspect via gh is evidence. Push/PR stay gitship.

**v99 "loopwise"** — the upgrade that makes the agent KEEP GOING, CHECK
ITS OWN WORK, and FIX IT WITH EVIDENCE. No engine rewritten; every change
strengthens an existing loop. **THE STOP FIX (P1)** — the direct one-shot
agent no longer halts dead at its step budget (the "agent stops after
~25 steps" experience): while a run is PRODUCTIVE (fresh successful
writes, passing verification checks, or diverse tool use — and NO
signature loop, no error streak) its step AND tool-call budgets
auto-extend in bounded increments up to the same hard caps (1000 steps /
500 calls), each extension visible as a `step_budget_extended` event with
its evidence; a stalled run stops exactly as before — INCOMPLETE +
checkpoint + resume, budget exhaustion still never completes (§5 law);
segment callers (meta) are untouched, and the meta-side segment table
doubles its bases (MEDIUM 22→40, ARCHITECTURAL 40→88, cap 64→128) so a
healthy run is no longer interrupted every ~25 steps. **THE REVIEWER
(P2)** — codereview.js: after a clean segment that mutated files, ONE
bounded read-only review of the ACTUAL change (working diff vs HEAD, the
gate's LSP diagnostics reused, failing ledger evidence, secret + smell
scan of ADDED lines): deterministic findings stand on their own, a
reviewer agent pass adds strict-JSON findings (parsed honestly — garbage
reports never invent issues), blockers become required actions that block
completion and drive repair, `CODE_REVIEW_*` events persist, review cost
is bounded per task (`review.maxPerTask`, default 4) — and the v94 latent
deadlock is fixed (required actions were add-only until whole-gate
success; recurring prefixes are now re-derived on every completion
attempt). **THE FIXER (P2)** — repairSegment receives a structured DEFECT
REPORT (live LSP diagnostics on the changed files, the most recent
failing verification records, the read-only verifier's own defect text —
requestVerification now returns its report instead of discarding it), and
a deterministic autofix fast path (autofix.js): a lint/format-shaped
failure gets the project's OWN formatter ONCE — allowlisted to direct
formatter invocations, shellguard-classified safe, 90s bound — with the
result recorded as ledger evidence; only if that fails (or the failure is
not mechanical) does the LLM repair run. **THE PLANNER (P2)** —
plancritique.js: the quality gate the planner lacked — coverage against
the objective's own terms, blob/granularity sanity, verification-step
presence for mutating plans, read-only balance; when majors exist, ONE
bounded revision pass that is adopted ONLY if it re-validates (with the
same structural repair the original gets) AND beats the original score;
`PLAN_CRITIQUE` / `PLAN_REVISED` / `PLAN_REVISION_REJECTED` events.
**REACH (P4)** — a curated MCP catalog (mcpcatalog.js: 100 ranked,
GitHub-backed servers from a vendored official-registry snapshot, including
GitHub's maintained server and ECC email/calendar/contacts — searchable with
`forge mcp catalog`, installed one at a time, credentials referenced from the
environment, and the privileged mcp section written only through the sanctioned
config path), a skill
registry (skillregistry.js: the best GitHub skill repos with ready
raw SKILL.md URLs + `forge skill search` local search + `forge skill
recommend` with stemmed matching), and 4 new bundled skills (code-reviewer,
perf-tuning, api-design, data-migration — 106 bundled total). **DELIVERY**
— `gitship.pr = "gh"` opens REAL pull requests through the user's OWN gh
CLI (passthrough: forge never holds a GitHub token; consent-gated like
push; requires the commit pushed; the PR body IS the PR-ready artifact).
FORGE-BENCH grows to 24/24. 164 existing suites stayed green plus the 1
new one (v99: 95 assertions, 9 sections) — 165 total.

**v98 "shipwise"** — closes the six deficits the competitive gap analysis
(Forge vs Claude Code / Devin / Cursor / Codex / OpenHands) called
existential, plus the v97 TODO leftovers, with no engine rewritten:
**tier-3 structured extraction is finally WIRED** (langstruct.js — one
session-cached LSP pass per server enriches the shared index with
`symbolDetails` + provenance `{layer, source}`; honest per-file fallbacks;
JSON gets a genuine layer-1 native parse; INDEX_VERSION bumps once so
lexical-era caches can never masquerade as structured; enriched records
SURVIVE world rebuilds through the extractOne cacheHit law); **verified
git delivery** (gitship.js — kernel policy, never a tool: after the
9-check completion gate says ok the run's verified files are committed
with forge trailers, explicit pathspec only, foreign dirty files named
and never staged, branch "auto" BOOKMARKS forge/<task> without touching
the checkout, push is explicit+consent and force never, PR-ready text
rendered from gate/ledger data — all OFF by default and a checked-in
project config can never enable it); **prompt-injection defense**
(contentfence.js — every tool result rides a constant attribution fence
with an ADVISORY injection-marker scan; the data-not-instructions rule
is in BOTH system prompts; user-only kill switch); **world model at
scale** (0=unlimited finally reachable — the resolver bug; batched index
writes; walk reuse; buildAsync chunked walking with in-flight sharing;
persistedRecords reads the last recorded truth, fixing the CONTRACT_DRIFT
before-capture bug); **artifact evidence** (observed build outputs become
VTYPE.ARTIFACT ledger records, adapter-gated, never invented — and the
declared runtimeValidation flag is finally ENFORCED at critical risk);
**browser visual regression** (`visual_diff` baselines: snapshot text
diff + screenshot hash, evidence-phrased verdicts, full-page capture).
FORGE-BENCH grows to 22/22. 162 existing suites stayed green plus the 2
new ones (gitship 39 + v98 95 assertions) — 164 total.

**v97 "unifiedwise"** — the FORGE ∞ FINAL UNIFIED ENGINEERING INTELLIGENCE
UPGRADE, implemented in the directive's phase order. What was missing was
not more intelligence — it was ONE connected system: **local-first source
resolution** (sourceresolve.js — the §4 ladder: explicit file → folder →
local ZIP → URL → git → workspace; a local archive NEVER loses to a git
remote; ZIPs are inspected, safely extracted and operated on as local
projects; `forge source` + `--source`); **ChatGPT-like session continuity**
(raw per-turn transcripts that compaction can never destroy, deterministic
user-message classification, and AUTOMATIC rehydration — `forge chat` in a
directory with a recent session picks it back up without `--continue`);
**the world-model ceiling removed** (configurable budget, prioritized
indexing, lazy expansion — a locate() miss auto-expands; a huge repo takes
longer, never becomes invisible); **competing hypotheses** (every hard
failure gets a belief distribution, not one guess); **predictions that
cover tests and effort**; **one capability ladder** (native → skill → MCP
→ created tool, honest gaps, `forge caps`); **contract-drift evidence**
(removed routes/tables and orphaned consumers detected after mutations);
**the runtime `up` lifecycle** (launch → wait-ready-by-probe → verdict);
**browser console/network error capture** (`errors` action — a rendering
page with errors is NOT verified); **task replay** (`forge replay` — the
recorded goal→state→action→decision→evidence timeline from the real
ledgers); and FORGE-BENCH at 20/20 with the four missing long-horizon
categories (runtime failure, model switch, session rehydration, ZIP
source). 160 existing fast suites stayed green, plus the 2 new suites (sourceresolve 38 + v97 109 assertions) — 162 total.

**v96 "unifywise"** — the inspection-first upgrade. Five parallel deep
audits of all ~140 modules produced one verdict: v95 already IMPLEMENTED
nearly everything the architecture promised — what it lacked was WIRING.
Intelligence was computed and then ignored; subsystems held state the loop
never read; two copies of one truth drifted apart. v96 reconnects every
disconnected wire, adds the one genuinely missing layer, and pins it all
with the new `tests/test-unifywise.mjs` (72 assertions, 19 sections) and
`tests/test-envfingerprint.mjs` (27 assertions, 7 sections) — 160/160 fast
suites green. Nothing was rewritten; every fix is a repair of an existing
system. The reconnected wires: **engmemory** retrieval's task/conversation
relevance bonuses (+0.4/+0.15) actually fire now (candidates carried no
taskId/conversationId — dead ranking factors); **TTY task-resume goes
through the controller** (the interactive "resume via controller" path
silently dropped resumeTaskId and re-ran the objective as a single-shot
agent — now the persisted DAG/ledger state is reconciled, the honest way);
**the Core lifecycle map speaks meta's real event vocabulary** (four dead
entries — TASK_CREATED/VERIFY_PASSED/REPAIR_COMPLETED/TASK_RESUMED that
meta never emitted — replaced by real mappings, plus meta now emits
TASK_RESUMED after recovery and REPAIR_COMPLETED after a repair, and
COLLECT_EVIDENCE/CONTINUE map from PREDICTION_SETTLED/REALITY_DELTA/
SEGMENT_COMPLETED: every phase is recordable from real traffic);
**empirics and skill-variant outcomes have production writers** (both
ledgers stayed empty in real runs — compose's MODELS line and variant
rates read nothing); **the §24 information-gain experiments ride segment-1
context** (the code comment claimed "the planner prompt carries it" — it
never did; the planner prompt is built before assessment runs); **the
taskmodel origin-tag ledger is fed from the plan** (only seedFromObjective
ever ran, so the adversarial no-assumption-as-requirement check always saw
an empty list — plan nodes speaking in assumptions are now tagged
ASSUMPTION and can never be promoted to REQUIREMENT); **the completion
gate checks REQUIREMENT COVERAGE** (every ingested requirement must be
addressed by a completed node, changed file or verification evidence —
unaddressed requirements block COMPLETED through the existing
required-actions path, no second gate); **the structured §30 handoff
reaches the reassigned worker's context** (it was ledgered onto
successor.handoff and then read by nobody — the failed-approaches list
now travels with the successor); **episode stage recorders receive the Ω
kernel's data** (hypotheses, experiments, verifications, failed
approaches were test-only surface; the durable "never repeat what failed"
story is real now, and episodes persist atomically via securefs like every
other store); **runMany maxParallel is a real per-batch concurrency gate**
(was accepted and ignored); **conflict resolution consults the world
model** (the §31 step was disabled with world:()=>null — now an honest
existence-claim check, behavioral claims still escalate to a
discriminating experiment); **MCP servers connect LAZILY** from a
per-spec inventory cache (~/.forge/cache/mcp-tools.json, TTL 24h, keyed by
name+command so configs never collide): a cold cache behaves exactly like
the old eager path, a warm cache defers the server spawn to the first
tool call, and a vanished tool is an honest error that drops the stale
entry; **LSP autostart servers feed verification diagnostics** on the
default language path (typescript-language-server/pyright/gopls/
rust-analyzer on PATH now produce SYNTAX evidence with zero user config —
the pinned default contract "no user servers → no evidence" is kept for
callers that do not opt in); **one risk ladder**: dag.js accepts "trivial"
(plannerisk/verifyledger already ranked it — a trivial node was silently
coerced to "low", inflating its verification ladder); **external SIGTERM
is KILLED, not TIMEOUT** (only runCommand's own ETIMEDOUT is a timeout);
and the dead code is gone (meta's unused reportConflict import, agent.js's
`void fs`, strategy's duplicated formatStrategy, the chat/agent hardShrink
twins now live once in compaction.js, forge.js's download twins unified).
The NEW layer: **envfingerprint.js (§50)** — the environment fingerprint
and drift engine (process facts free, toolchain presence stat-only,
versions TTL-memoized; per-project env.json through securefs; drift is
ADVISORY: an ENVIRONMENT_DRIFT event with per-signal engineering impact
notes — node major changed → native modules may be ABI-incompatible;
docker gone → runtime verification strategies limited — never a gate
decision; FORGE_ENVFP=0 off-switch). Also new: **core.nextBestAction()**
— the §24 surface as a read-only introspection over the decision
authorities that already exist (pending human decision > terminal
next_action > live phase > idle), exposed in status() for the TUI; NOT a
second decider. And the context engine reports budgetOverflow honestly
when a single section alone exceeds the whole budget.



**v95 "worktreewise"** — the last open KERNEL item of the TODO ledger,
implemented, wired and proven (`tests/test-worktreewise.mjs`, 75 assertions,
9 sections): **mutating DAG nodes with pairwise-disjoint declared targets
now execute in parallel, each inside its own detached git worktree** —
`git worktree add --detach` under `.forge/worktrees/`, a child process
(`worknode.mjs`) whose cwd IS the worktree (agent.js binds everything to
process.cwd(), so one child per node is the only race-free parallelism —
and its writes can only land in its own tree). Parallel segments can never
see each other's partial writes. The **merge back** into the shared tree is
`git apply` CHECKED-then-applied (plain --check, 3-way --check, then apply)
behind a serialized single-writer barrier after the main agent settles — a
conflicting patch never half-applies, the conflicting files are named, the
node honestly FAILS and the worktree is kept for inspection. Ineligible
nodes (undeclared targets, overlap with the current node, dependencies —
a HEAD checkout cannot see merged-but-uncommitted dependency output —
uncommitted drift on the declared targets, non-git repo, no commits,
`FORGE_WORKTREE=0` / `worktree.enabled:false`) stay serialized exactly as
before: worktrees are the FIX for the never-list rule, not a license to
break it. Crashed runs leave orphaned worktrees that the next task start
sweeps (registry + pid evidence, crash-resume pattern). New events:
WORKTREE_MODE/CREATED/MERGED/CONFLICT/FAILED/REMOVED/UNAVAILABLE/ORPHAN_
SWEPT. The version bump also caught a v94 latent bug: searchproviders.js
carried a LOCAL `VERSION = "94.0.0"` that shadowed the single source of
truth — its user-agent advertised a stale version on every search; it now
imports version.js like everyone else. 158/158 fast suites green
(worktreewise: 75 assertions, real git, real child processes, scripted mock
provider).

**Version 94.0.0 — "gapwise" (gap fix / integration patch).

**v94 follow-ons (masterwise + tokenwise)** — no version bump, no rewrite,
same architecture: the **Engineering Intelligence Core** (adaptive search
providers with honest failure, an execution controller that can never mistake
a step budget for completion, the layered engineering memory with provenance,
the predictive risk-aware planner); the **TokenRouter** provider — one
OpenAI-compatible `/v1` key over 300+ upstream models (`TOKENROUTER_API_KEY`);
and the bundled **understand-anything** skills pack (codebase → knowledge
graph: analyze, chat, dashboard, diff, domain, explain, figma, knowledge,
onboard — the graph feeds project memory retrieval on later tasks). **toolwise**
follow-on: three new read-only, deterministic tools — `kg_query` (project
knowledge graph: dependents, blast radius, tests, .ua graph), `plan_whatif`
(simulate plan changes through the predictive risk engine before committing),
`code_context` (semantic hits + structural wiring in one call). 30 tools,
89 bundled skills at that point, 155/155 suites green. **skillwise**
follow-on: the **obra/superpowers** engineering-process pack bundled as
first-party skills (MIT, github.com/obra/superpowers) — brainstorming,
TDD, systematic-debugging, verification-before-completion, plan writing &
execution, code review requesting/receiving, subagent-driven development,
parallel dispatch, git worktrees, skill authoring: 13 of 14 upstream skills
byte-identical (upstream `writing-plans` not re-bundled — forge ships its own
adapted one; the 5 platform-seam skills carry appended forge execution notes
over a byte-identical upstream prefix). 102 bundled skills, 34 first-party
catalog skills, 156/156 suites green at that point. The **knowwise**
follow-on made the project itself a living knowledge source: the first task
in any project auto-writes a deterministic FLOOR knowledge graph
(`.ua/knowledge-graph.json` from the world-model extractors — no LLM, no
network; real understand-anything graphs are never touched; rebuilds only on
fingerprint drift) that feeds memory retrieval and `kg_query` from run one;
every successful file edit now carries a bounded blast-radius prediction
(radius · importers · tests — one advisory line, additive record field +
event, `FORGE_BLAST_RADIUS=0` disables); and shell resolution is
Termux/NetHunter-ready (`FORGE_SHELL` > /bin/sh > $PREFIX/bin/sh > $SHELL),
so every bash call, background process, and typed `!` command works on
Android out of the box. 157/157 suites green at that point.

**v94 "deepwise"** — judgment before action, all deterministic, zero model
calls, zero network: plan **competition + adoption** (the original plan now
competes against its reshaped variants on expected verified progress; when a
variant wins by a real margin at equal-or-better risk and success, the
planner ADOPTS it — the inspect/verify guard node becomes real executed DAG
work, predictions re-stamped, live risk restarted at the adopted estimate;
shapes that drop declared dependencies are advised but never auto-adopted);
a **pre-mutation self-critique** (one deterministic checklist before every
file mutation — secret paths, edit targets that do not exist, same-file edit
thrash, and hub files read straight from the knowwise floor graph; one
advisory line + event, never blocks, `FORGE_CRITIQUE=0` disables); and the
reality→risk loop closed for experiments (repair outcomes move LIVE risk).
158/158 suites green.

**v94 "fastwise"** — same intelligence, less wasted work, all offline
(zero model calls, zero network — Termux-friendly bounded reads, tiny
caches, unref'd timers): a **freshness layer** (fastwise.js) — ONE shared
TTL + file-fingerprint memo utility (the house `${mtimeMs}:${size}`
signature and injectable-clock conventions generalized, drift always
beats the TTL so a stale value can never be served); **likely-next
prefetch** — an idle, deferred, unref'd warm pass (beside the knowwise
KG bootstrap) that persists the world-model snapshot once per freshness
window so later plans/answers pay only a stat-only drift walk, and warms
the semantic chunk cache with ONE bounded offline BM25 pass
(`FORGE_INDEX=0` skips it entirely — never fakes, never writes), guided
by a prediction of the files the task will touch next (plan frontier +
knowwise knowledge-graph hubs, read through engmemory's ONE KG parser);
an **execution lane** resolver (resolveLane in modelstrategy) —
fast/balanced/deep from signals forge already has (task complexity +
device tier from the resource manager), feeding the EXISTING selection
opts (tight latency budget + cost bias for light tasks, no artificial
budget for deep work, cost bias on low-resource devices) — no new
decision path; and a **performance fix with a freshness contract** —
modelstrategy stopped re-reading model-performance.json on every call
(~24 sync reads per selection before; now an mtime+size memo that
re-reads the moment the file changes, never serves stale, forgets on
clear/corruption). `FORGE_FASTWISE=0` turns the warm layer off. This
phase also ships a **dedup audit suite**: tool names, capabilities,
catalog names AND aliases, all 102 bundled skills (frontmatter names,
content hashes, case-insensitive dirs, nested-skill shadowing) are
pinned unique — duplication cannot silently return. 159/159 suites
green.

**v94 "todowise"** — the TODO ledger emptied with proof, one strengthening
patch per repo-declared gap, all offline (zero model calls, zero network): a
**protocol-aware health probe** (runtimesession) — HTTP stays primary, but
when the HTTP exchange fails a REAL TCP connect separates "nothing
listening" (NOT healthy) from "listener confirmed, no HTTP response" (ok at
tcp level with an honest "no HTTP probe available" evidence line — a
TCP/WebSocket service is no longer falsely NOT healthy; the §11 claim gate
and the tool rendering are level-aware); an **evidence-based process-group
kill walk** (runtime) — when `kill(-pgid)` is refused, the members are
enumerated from /proc or a bounded `ps` parse and signaled individually
(`signalGroup`/`groupMembersEvidence`, kill evidence recorded per entry —
the old fallback signaled only the leader and orphaned grandchildren); a
**bwrap kernel re-probe** (sandbox) — the first observed bwrap startup
failure re-probes the overflowuid/overflowgid verdict on the spot
(`reprobeKernelSupport`, counted so tests prove it); a **working-tree drift
phase at restore** (checkpoint) — write tools now seal a post-write hash
(`sealEdited`), and restore classifies every file (clean / forge-owned /
external / unattributed / missing): externally-modified files are KEPT with
status `DRIFT`, never silently clobbered, unattributed changes revert with
a reported drift note, and the legacy `forge undo` path gets the same
protection; a **persistent semantic index** (codesearch) — chunk docs
survive the process under ~/.forge/projects/&lt;hash&gt;,
fingerprint-validated per file (drift always beats the index, deleted files
are dropped, corruption rebuilds, FORGE_INDEX=0 opts out; a fresh process
adopts unchanged files and re-chunks only what drifted); **multi-step
scripted tool probes** (toolcreate) — `probeSteps: [{args, expectOk?,
expectContains?, label?}]` at design time or verify time run a real
sequence in ONE child process (state survives across steps — login → act
finally testable), every step judged on its observed output, a failed step
aborts; and an **LSP auto-start table** (lsp) — first-party specs for
ts/js, python (pyright|pylsp), go, rust used ONLY when the binary is
actually on PATH, user config wins, `lsp.autostart:false` opts out —
documentSymbol extraction becomes the DEFAULT structured path instead of
the lexical exception. 157/157 suites green (todowise: 81 assertions).

**v94 "gapwise"** — the confirmed v93 gaps fixed inside the existing
architecture, zero fake completion: ONE completion contract for every
execution path (budget exhaustion → INCOMPLETE + checkpoint + resume, never
a fabricated COMPLETED); exhausted workers classified and retried; **Runtime
Intelligence** (discovery with per-fact evidence, real health probes,
claim gates, crash reconcile — `runtime` tool #26); **persistent
incremental world model** (survives restart, re-extracts only what changed,
honest truncation); **persisted core bus + engineering-event ledger** with
restart reconstruction; **LSP-first structured extraction** (lexical is a
labeled fallback, not a silent default); **tool creation pipeline** with
behavioral verification in a real child process; **strict learned-skill
promotion** (equivalent to downloads: behavioral evidence + freshness +
staleness); **strategy 3.0** with contextual factors and justifications.
26 tools, 148/148 suites green.

**v93 "sensewise"** — three new senses: a background **process manager**
(dev servers survive the tool call; ports detected from output and the OS
socket table, never guessed; kill hits the whole group; the lifetime fuse
is a resource fuse, never a completion claim), a **persistent Node REPL**
(variables and loaded data survive between calls; timeout = "still
running", never fabricated), and **semantic code search** (BM25 +
embedding hybrid, find code by meaning when grep finds nothing literal).
The last v91 islands (skillforge, embeddings, memgraph) are wired. 25
tools, 140/140 suites green, 99 new assertions.** Nothing rewritten — the
v91 engines remain the source of truth; every module that shipped but was
never consulted is now wired into the living system: a **prediction
ledger** (predict before each segment → settle against observed reality →
calibrate future plans from real prediction errors), **language-adapter
coverage** in every agent prompt (67 languages, honest deep-vs-conservative),
**world-model consultation** at planning (blast radius + covering tests),
**integrator conflicts** reported and resolved instead of discarded, and the
P0 plugin-load TDZ fix (user tool plugins work again). Carries **v91
"corewise"** (∞ CORE), **v90 "gitwise"**, **v89 "fast"** and **v88 "noguard
+ worker clamp"**: no guards, no blocks, workers 2–8. One folder: `forge/`.

## v122 in one line — full control is ONE switch, and it is inspectable

`forge yolo` prints the resolved state of every layer that can refuse, pause or
freeze; `forge yolo on|off` sets it (`tools.yolo`); `--yolo` / `--safe` force it
for one process; `FORGE_YOLO=0|1` for the shell. It is ON by default because
`tools.unrestricted` and `tools.autoApprove` are, and v122 made that umbrella
reach the four layers it used to stop short of:

| layer | what it did after v88 | what YOLO changes |
|---|---|---|
| shellguard | never refused, still labelled | nothing (already off) |
| governor authority | froze/hid write tools on INSPECT/VERIFY/PLAN, halted on ASK | advises only — the directive, the action and the event stay; the veto goes |
| pre-edit critique | secret-looking path → WAITING_FOR_USER, edit thrash → refusal | the note stays, the block goes |
| read-only workers | bash had to match a 12-prefix allowlist | the classifier answers "is this a check, not a change" — writes stay refused |
| capability router | withheld mutating MCP on INSPECT, froze externals on ASK | quality gates stay (stale, measured-broken, budget); permission-shaped ones go |
| system prompt | told the model commands were blocked, so it declined to try | says full control is granted, in both modes truthfully |

Pin one layer without touching the rest:
`forge config set governor.enforce always` (or `never`, or `auto` = YOLO
decides), same for `critique.enforce`; `FORGE_GOVERNOR=1` /
`FORGE_CRITIQUE_ENFORCE=1` for a single run.

**Five rails YOLO never turns off** — they defend you from *other people's
code*, not from yourself, so switching them off would make the agent less free,
not more: the project-config privilege strip (a cloned `forge.config.json` can
never arm the agent), the injection fence on tool results, secret redaction,
atomic/TOCTOU-safe writes, and socket pinning on URL fetches. `forge yolo`
lists them every time, so none of this is a footnote.

Two more things survive it, and they are **correctness, not permission**: a
read-only worker keeps its write refusal (a verifier must not edit what it
verifies) and the v118/v119 completion gate keeps demanding evidence (it
refuses a false DONE, never your command). `forge yolo` prints them in their
own block, so "all safety off" is never read as "results stop meaning
anything".

## v130 in one line — full control has three NAMED modes

`off` (the layers are in charge) · `yolo` (every grant open, the governor and
the pre-edit critique advise only — the default) · `full` (every grant open
**and** those two keep their veto). Set one with `forge yolo full|on|off`,
`--yolo-full` / `--yolo` / `--safe` for a single process, or
`FORGE_YOLO_MODE=full|yolo|off` for the shell; in chat, `/yolo full|on|off`.

`mode=full` is nine flags, printed by `forge yolo` under **YOLO mode flags**:
`yolo · assumeYes · allowSudo · allowOutsideProject · allowInterpreterEval ·
allowNetworkUpload · allowNewPlugins` all true, plus `governorEnforce ·
critiqueEnforce` true. Full control is about the owner's friction, not about
losing the record — so the two layers that produce one are part of the mode.
The cost is printed on the same screen: under `full`, a governor ASK can park a
run in `WAITING_FOR_USER` and a critique BLOCK can stop an edit. One key
(`tools.yoloMode`, privileged — a cloned repo cannot arm it), one patch shape
(`applyYoloMode`), shared by the CLI, chat and the tests.

## v88 in one line

Every command gate is gone (nothing is refused, nothing prompts — block-class
included), the project write boundary is gone, `fetch_url` has no SSRF gate,
the sandbox is opt-in (`FORGE_SANDBOX=1`), and workers are clamped: **low tier
= 2, absolute max = 8**. The risk classifier still labels every command for
logs and `/status` — the verdict is just always *run*.

```
forge/                 the npm package (CLI + tests + bundled skills)
  forge.js             CLI entry
  skills/              106 bundled skills
  tests/               201 suites (npm test, zero network)
LICENSE                MIT
PACKAGE_INFO.txt       capability summary
FORGE-AUDIT-REPORT*.md engineering reports (history)
```

## Install

```bash
cd forge && bash install.sh      # or: npm i -g .
forge                            # first run: provider → model → key → test
forge doctor
```

Needs Node ≥ 20.

## Daily

```bash
forge                            # AUTOPICK: chat, tools on, no prompts
forge --pick                     # choose model
forge ask "question"
forge agent "task"               # coding agent, 19 tools
forge agent --auto "task"        # full autonomous lifecycle (DAG + verify + repair)
forge resume <n|id>
forge undo
forge doctor
```

In chat: Linux commands run in the project folder. Sentences go to the model.
`! cmd` always executes. **v88: nothing is blocked and nothing asks y/N.**

```
/status   /profile [p]   /deep   /shell off
/skills   /skill download <https-url>
/skill verify <name|all>   /skill learn <name>
```

`DOWNLOAD ≠ TRUST`. A download is CANDIDATE until verify. Learn is VERIFIED
only. Indexing is not learned. Nothing auto-ACTIVE. Data lives under
`~/.forge` (`FORGE_DATA_DIR` aliases `FORGE_HOME`).

### Reach surfaces (v99)

```bash
forge mcp catalog                # first 20 of 100 curated GitHub-backed servers
forge mcp catalog browser --all  # search; filter with --runtime/--transport/--auth
forge mcp info ecc               # provenance, pinned version, required environment
forge mcp add ecc                # write one preset (user config only)
MCP_ENCRYPTION_KEY=... forge mcp test ecc
forge mcp remove ecc
forge skill search "debug"       # local search over 106 bundled skills
forge skill recommend testing    # curated GitHub skill repos + raw URLs
```

MCP servers connect lazily (first tool call), never at startup. Adding one never
enables the other 99. Secrets are never invented or stored by catalog presets:
GitHub and ECC reference `GITHUB_PERSONAL_ACCESS_TOKEN` and
`MCP_ENCRYPTION_KEY` from the process environment. Downloads still use the SSRF-guarded,
verify-then-activate path.

## Self-test (Node only, no network)

```bash
cd forge
npm test                         # all suites (e2e + cleanroom included)
FORGE_FAST=1 npm test            # Node suites only (~39 s, 4-way parallel)
```

`npm test` is the source of truth. Suite counts are not duplicated here.
