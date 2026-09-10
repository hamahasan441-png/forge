# PLAN v44 — compose pipeline (Forge v41)

Status: **shipped in v41.0.0.** After v40's strategy evolution: the v32+
layers existed but the planner called them independently (and skipped
world / skills / verify on the plan path). One snapshot now runs
index → world → memory → skills → strategy → tools. The compact
`[world]` / `[avoid]` / `[verify next]` block reaches the model.
Never auto-runs tests. No kernel rewrite.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v40
evolve are unchanged. This layer sits on `memgraph.js` / `memory.js` /
`evaluate.js` / `evolve.js` / `verify.js`.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH / v30 vision / v31 browser / v32 incremental
index + language adapters / v33 cross-language graph / v34 skill evaluator
+ plugin selector + integrator / v35 language-specific reasoning / v36
graph-aware memory invalidation / v37 language-aware engine / v38 gap-fix
/ v39 focused verification / v40 strategy evolution, shellguard, netguard,
securefs, plugin isolation, the 9-check completion gate,
`classifyTaskComplexity()` (frozen), MICRO-only synthesise,
TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS, single-mutating-writer.

v41 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not add Tree-sitter. It does not auto-run tests.
It does not invent `npm test -- file.test.js` flags. It does not write
into `agentv19/forge/skills/`. It is not kernel self-mod (L6).

## What v41.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | v32–v40 called independently; plan skipped world/skills/verify | `compose()` one snapshot |
| 2 | Memory did not reuse the world snapshot the planner just built | `relevantMemory({ writes, graph })` from `composeWorld` |
| 3 | Context engine had no compact world/avoid/verify join | `formatCompose` section in `context.js` |
| 4 | Learned skills + hard-avoid + focusedVerify never shared a prompt block | `[world]` `[avoid]` `[skills]` `[verify next]` `[plugins]` |

## Contract

- `compose("")` is empty: no files, no skills, no avoid, `{ command: "", tests: [] }`
- `compose` of a MICRO typo has `micro: true` and zero auto skill picks
- cited `util.js` in a js tree → `world.files` includes `util.js`
- same tree: `verify.command` is `npm test` and `verify.tests` includes `util.test.js` when that file imports util
- empty graph → `verify.tests` is `[]` (never invented)
- `formatCompose` of that result includes `[world]` and `[verify next] npm test`
- hard-avoid (confidence ≥ 0.5) appears in `compose.avoid` and `[avoid]`
- `selectPlugins` MICRO still skips isolated plugins unless named
- `createContextEngine().build` of a cited-file task carries a `compose` section
- `compose` never executes the recommended command
- `classifyTaskComplexity()` unchanged
- `assumeYes` / `allowSudo` stay false
- Zero runtime npm dependencies

## Bigger map (not this release)

Shipped next: **v42.0.0 / PLAN-v45** (L5 isolated plugin / skill
self-extension: author a project-local read-only plugin from a successful
repair — never `~/.forge/tools`, never the kernel, never auto-grants).
L6 kernel self-mod is explicitly out. World-model rewrite, Tree-sitter as
a runtime dep, edit-transaction rewrite stay explicitly out.

## Non-goals

- Runtime npm dependencies (no Tree-sitter).
- A second mutating writer.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes`.
- Patching `classifyTaskComplexity` / `plugin-host` / `securefs`.
- Writing into the bundled `agentv19/forge/skills/` pack.
- Auto-running tests.
- Inventing CLI flags.
- Replanning MICRO/SMALL.
- Relaxing plugin-iso or fs-toctou tests.
