# PLAN v45 — isolated plugin / skill self-extension (Forge v42)

Status: **shipped in v42.0.0.** After v41's compose pipeline: L5 of
the SEASE ladder. A successful repair becomes a project-local isolated
plugin as well as a SKILL.md. Read-only. No capabilities. No grants.
Never `~/.forge/tools`. Never `plugin-host.js`. MICRO/SMALL skip.
Same-run quarantine still applies. No kernel rewrite.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v41
compose are unchanged. This layer sits on `evolve.js` / `plugins.js` /
`securefs.js`.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH / v30 vision / v31 browser / v32 incremental
index + language adapters / v33 cross-language graph / v34 skill evaluator
+ plugin selector + integrator / v35 language-specific reasoning / v36
graph-aware memory invalidation / v37 language-aware engine / v38 gap-fix
/ v39 focused verification / v40 strategy evolution / v41 compose pipeline,
shellguard, netguard, securefs, plugin isolation, the 9-check completion
gate, `classifyTaskComplexity()` (frozen), MICRO-only synthesise,
TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS, single-mutating-writer.

v42 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not flip `allowNewPlugins`. It does not add
Tree-sitter. It does not patch `plugin-host`. It does not write into
`~/.forge/tools` or `agentv19/forge/skills/`. It is not kernel self-mod (L6).

## What v42.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | v40 authored SKILL.md, never an isolated tool | `authorPlugin` → `~/.forge/projects/<hash>/tools/learned_*.mjs` |
| 2 | Repair text as executable JS would be an injection | `formatPluginMjs` puts user strings in `JSON.stringify` |
| 3 | Learned plugins invisible to the loader | `mergeLearnedPlugins` (global names win; grants always `{}`) |
| 4 | A generated plugin could declare network/childProcess | template is `readOnly: true` with no `capabilities` |

## Contract

- `authorPlugin` MICRO/SMALL → `{ ok: false, skipped: "micro" }`
- `authorPlugin` with empty repair → `{ ok: false, skipped: "no-repair" }`
- `authorPlugin` whose repair/files look like the kernel → `{ ok: false, skipped: "kernel" }`
- `authorPlugin` writes under `~/.forge/projects/<hash>/tools/learned_….mjs`
- a second `authorPlugin` of the same task is `{ ok: true, deduped: true }`
- `~/.forge/tools` is never written
- `plugin-host.js` is never written
- generated source has `readOnly: true` and no `capabilities` field
- user strings are JSON data, not template interpolation
- `mergeLearnedPlugins`: global `~/.forge/tools` names win; extras append
- learned plugins are loaded with `grants: {}` (no inherited pluginGrants)
- `allowNewPlugins` stays false; same-run quarantine still skips a plugin authored this task
- `evolveRun` COMPLETED authors a plugin; MICRO never does
- `classifyTaskComplexity()` unchanged
- `assumeYes` / `allowSudo` stay false
- Zero runtime npm dependencies

## Bigger map (not this release)

Shipped next: **v43.0.0 / PLAN-v46** (compose picks learned plugins:
sync `PLAYBOOK` index, no spawn, planner lists isolated names).
L6 kernel self-mod is explicitly out. World-model rewrite, Tree-sitter as
a runtime dep, edit-transaction rewrite stay explicitly out.

## Non-goals

- Runtime npm dependencies (no Tree-sitter).
- A second mutating writer.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes` or `allowNewPlugins`.
- Patching `classifyTaskComplexity` / `plugin-host` / `securefs`.
- Writing into `~/.forge/tools` or the bundled `agentv19/forge/skills/` pack.
- Auto-granting `pluginGrants` (network / childProcess / write / env).
- Loading a plugin the same task just wrote (quarantine stays).
- Replanning MICRO/SMALL.
- Relaxing plugin-iso or fs-toctou tests.
