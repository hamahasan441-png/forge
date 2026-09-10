# PLAN v55 — toolmem (Forge v52)

Status: **this release.** After v51's apinex: the tool-intelligence layer
already recorded per-run stats (`intel.stats()` / `intel.records()`) and
returned them from `runAgent`, but they died with the process. Model
outcomes already persist (`modelstrategy.recordOutcome`). Tool outcomes
did not. Compose and `formatSteer` had no `[tools]` / TOOLS line. One
toolmem layer now persists aggregates under
`~/.forge/projects/<hash>/toolstats.json` (0600) and surfaces prefer/avoid
into the existing compose snapshot and steer block. `runCall`,
`cheaperAlternative`, `nextAction`, and `recoveryPlan` stay the in-run
path. Fast on 8-core / 12GB. No kernel rewrite.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v51
apinex are unchanged. This layer sits on `toolintel.js` / `compose.js` /
`evaluate.js` / `agent.js` / `chat.js` / `meta.js`.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH / v30 vision / v31 browser / v32 incremental
index + language adapters / v33 cross-language graph / v34 skill evaluator
+ plugin selector + integrator / v35 language-specific reasoning / v36
graph-aware memory invalidation / v37 language-aware engine / v38 gap-fix
/ v39 focused verification / v40 strategy evolution / v41 compose pipeline
/ v42 isolated plugin self-extension / v43 compose picks learned plugins
/ v44 playbook snapshot / v45 steer / v46 apply / v47 know / v48 hostless
/ v49 check / v50 once / v51 apinex, shellguard, netguard, securefs,
plugin isolation, the 9-check completion gate,
`classifyTaskComplexity()` (frozen), MICRO-only synthesise,
TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS, single-mutating-writer.

v52 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not flip `allowNewPlugins`. It does not add
Tree-sitter. It does not rewrite the world model. It does not persist a
second graph file. It does not auto-run tests. It does not put compose
into the Ω kernel. It is not kernel self-mod (L6). It does not change
`runCall`. It does not wire `skipUnchangedTests` (that would invent
`npm test --` flags). Wizard pick 18 stays `custom`.

## What v52.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | `intel.stats()` / `toolRecords` died with the process | `recordToolRun` → `toolstats.json` (0600, aggregates only) |
| 2 | compose had no tool-outcome field | `emptyCompose.tools` + `relevantTools` + `[tools]` |
| 3 | `formatSteer` could not prefer/avoid tools | additive `tools` arg → `TOOLS:` line |
| 4 | agent/chat never persisted a finished batch | `runAgent` finally + chat `runBatch` |

## Contract

- `recordToolRun` of ok/failed/blocked records writes `toolstats.json` under `projectDir(cwd)`
- mode 0600; no result text; no argument payload
- `think` / `todo` / `memory` are not stored
- one failure does not avoid (PRIOR_WEIGHT=5, min 3 samples)
- 3/3 ok → prefer; 0/3 fail or ≥40% blocked → avoid
- cap 32 tools (most-sampled kept)
- MICRO/SMALL: `relevantTools` is empty (recording is cheap; steering a typo is not)
- `compose` of a MEDIUM task after history emits `[tools] prefer …`
- `formatSteer({})` is still `""`; extra `tools` is additive
- `compose()` stays uncached; `composeOnce` keys include `includeTools`
- `runCall` / `cheaperAlternative` / `nextAction` / `recoveryPlan` unchanged
- `meta.js` does not call `recordToolRun` (agent finally covers segments)
- `CATALOG[17]` is still `custom` (e2e pick 18)
- `assumeYes` / `allowNewPlugins` stay false
- `classifyTaskComplexity()` unchanged
- Zero runtime npm dependencies
- Bundled `agentv19/forge/skills/` is never written
- `~/.forge/tools` is never written
- compose stays synchronous

## Bigger map (not this release)

Unused wiring closed: tool outcomes now persist the same way model
outcomes already did, and they join compose/steer. `skipUnchangedTests`
stays unwired (would invent test flags). L6 kernel self-mod is
explicitly out. World-model rewrite, Tree-sitter as a runtime dep,
edit-transaction rewrite stay explicitly out.

## Non-goals

- Runtime npm dependencies (no Tree-sitter).
- A world-model rewrite / a second persisted graph file.
- A second mutating writer.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes` or `allowNewPlugins`.
- Patching `classifyTaskComplexity` / `plugin-host` / `securefs` / Ω kernel.
- Writing into `~/.forge/tools` or the bundled `agentv19/forge/skills/` pack.
- Auto-running the recommended / recorded command.
- Inventing CLI flags (`npm test -- file.test.js`).
- Wiring `skipUnchangedTests` into VERIFY.
- Changing `runCall` / `cheaperAlternative` / `nextAction`.
- Replanning MICRO/SMALL.
- Relaxing plugin-iso or fs-toctou tests.
- Adding new bundled skills.
- Changing e2e pick-18 custom.
- L6 kernel self-mod.
