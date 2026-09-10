# PLAN v53 — once (Forge v50)

Status: **this release.** After v49's check: INTENT.VERIFY uses focusedVerify,
but `runMeta` still walked the v32+ pipeline 3–4 times per task (plan,
evolve, replan, repair). The context engine already caches compose by
generation. Meta did not. One once layer now reuses the snapshot for
identical args. `compose()` stays uncached. Fast on 8-core / 12GB. No
kernel rewrite. No world-model rewrite.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v49
check are unchanged. This layer sits on `compose.js` / `meta.js` /
`agent.js` / `chat.js`. `compose()` (v41) stays the source of truth.

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
/ v49 check, shellguard, netguard, securefs, plugin isolation, the 9-check
completion gate, `classifyTaskComplexity()` (frozen), MICRO-only synthesise,
TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS, single-mutating-writer.

v50 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not flip `allowNewPlugins`. It does not add
Tree-sitter. It does not rewrite the world model. It does not persist a
second graph file. It does not auto-run tests. It does not put compose
into the Ω kernel. It is not kernel self-mod (L6).

## What v50.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | `runMeta` composed the snapshot 3–4 times per task | `composeOnce` + `takeCompose` (plan hits, replan refreshes) |
| 2 | evolve recomposed just to read `verify.command` | `focusedVerify(cwd, changedRel)` — no pipeline walk |
| 3 | `repairSegment` could not see `takeCompose` (top-level fn) | `composeOnce` with the original repair opts |
| 4 | agent / chat recomposed the same query every segment | `composeOnce` on the execute prompt |

## Contract

- `compose()` is uncached: two calls return distinct objects
- `composeOnce` of identical args returns the same object (`===`)
- `refresh: true` recomputes (not `===` the previous hit)
- `clearComposeOnce()` drops the hit
- different `includeMemory` flags are different keys
- cap 8: the 9th unique key evicts the oldest
- `compose()` after a write sees the write; `composeOnce` without refresh does not
- `runMeta` calls `clearComposeOnce` at task start
- `meta.js` does not call `compose(`
- `agent.js` / `chat.js` call `composeOnce`, not `compose(`
- `context.js` still calls `compose()` (generation cache, mtime invalidation)
- evolve does not call `compose(` / `composeOnce`
- `repairSegment` does not reference `takeCompose`
- format of a cached snap still emits `[world]` / `[verify next]`
- compose stays synchronous
- `~/.forge/tools` is never written
- `allowNewPlugins` stays false
- `classifyTaskComplexity()` unchanged
- `assumeYes` / `allowSudo` stay false
- Zero runtime npm dependencies
- Bundled `agentv19/forge/skills/` is never written

## Bigger map (not this release)

The UNIFIED 5-pillar leftover named in PLAN-v52 is this layer. L6 kernel
self-mod is explicitly out. World-model rewrite, Tree-sitter as a runtime
dep, edit-transaction rewrite stay explicitly out. No further named
unused-wiring leftover on the 5 pillars. Further work is evidence-driven
(FORGE-BENCH / production traces), not a sixth pillar.

## Non-goals

- Runtime npm dependencies (no Tree-sitter).
- A world-model rewrite / a second persisted graph file.
- A second mutating writer.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes` or `allowNewPlugins`.
- Patching `classifyTaskComplexity` / `plugin-host` / `securefs` / Ω kernel.
- Writing into `~/.forge/tools` or the bundled `agentv19/forge/skills/` pack.
- Auto-running the recommended / recorded command.
- Inventing CLI flags.
- Replanning MICRO/SMALL.
- Relaxing plugin-iso or fs-toctou tests.
- Adding new bundled skills.
- Putting composeOnce into the context engine (it already has generation invalidation).
- L6 kernel self-mod.
