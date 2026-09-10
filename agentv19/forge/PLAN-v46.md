# PLAN v46 — compose picks learned plugins (Forge v43)

Status: **shipped in v43.0.0.** After v42's L5 author: a successful repair
became a project-local `learned_*.mjs`, but `compose()` only listed plugins
the caller passed — and the planner / system prompt never passed any.
The snapshot now indexes the learned dir by reading `PLAYBOOK` JSON.
Sync. No spawn. No `plugin-host`. MICRO/SMALL still skip isolated unless
named. No kernel rewrite.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v42
extend are unchanged. This layer sits on `extend.js` / `compose.js` /
`evaluate.js`.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH / v30 vision / v31 browser / v32 incremental
index + language adapters / v33 cross-language graph / v34 skill evaluator
+ plugin selector + integrator / v35 language-specific reasoning / v36
graph-aware memory invalidation / v37 language-aware engine / v38 gap-fix
/ v39 focused verification / v40 strategy evolution / v41 compose pipeline
/ v42 isolated plugin self-extension, shellguard, netguard, securefs,
plugin isolation, the 9-check completion gate, `classifyTaskComplexity()`
(frozen), MICRO-only synthesise, TASK_STARTED → THINKING,
PRIVILEGED_TOOL_KEYS, single-mutating-writer.

v43 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not flip `allowNewPlugins`. It does not add
Tree-sitter. It does not patch `plugin-host`. It does not write into
`~/.forge/tools` or `agentv19/forge/skills/`. It does not import() a
learned plugin from `compose()`. It is not kernel self-mod (L6).

## What v43.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | v42 authored plugins; compose never listed them | `indexLearnedPlugins` → `compose()` |
| 2 | compose is sync; `loadLearnedPlugins` spawns plugin-host | brace-match `PLAYBOOK` JSON, never execute |
| 3 | planner `PLAN_COMPOSE` omitted plugin names | emit up to 4 isolated names |
| 4 | a symlink / trap file could have been imported | skip symlinks, dotfiles; never `import()` |

## Contract

- `indexLearnedPlugins` of an empty project is `[]`
- `indexLearnedPlugins` after `authorPlugin` lists `{ name, isolated: true, readOnly: true, source: "learned" }`
- a file whose body is valid `PLAYBOOK` JSON plus `process.exit` is still indexed (never executed)
- a symlink in the learned dir is skipped
- a dotfile / non-`learned_*.mjs` is skipped
- cap 24 (caller may pass `{ limit }`)
- `compose(task, { cwd })` with no `opts.plugins` still picks a matching learned plugin
- `formatCompose` of that result includes `[plugins] learned_…`
- MICRO/SMALL skip isolated learned plugins unless named in the task
- `includePlugins: false` skips the index even when files exist
- caller `opts.plugins` names win over the learned index
- `compose` stays synchronous (not a Promise)
- `compose.js` does not import `child_process` and does not call `loadLearnedPlugins` / `loadToolPlugins`
- `~/.forge/tools` is never written
- `plugin-host.js` is never written / spawned from compose
- `allowNewPlugins` stays false
- `classifyTaskComplexity()` unchanged
- `assumeYes` / `allowSudo` stay false
- Zero runtime npm dependencies

## Bigger map (not this release)

L6 kernel self-mod is explicitly out. World-model rewrite, Tree-sitter as
a runtime dep, edit-transaction rewrite stay explicitly out.

## Non-goals

- Runtime npm dependencies (no Tree-sitter).
- A second mutating writer.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes` or `allowNewPlugins`.
- Patching `classifyTaskComplexity` / `plugin-host` / `securefs`.
- Writing into `~/.forge/tools` or the bundled `agentv19/forge/skills/` pack.
- Spawning `plugin-host` from `compose()`.
- Importing or executing a learned plugin to index it.
- Auto-granting `pluginGrants` (network / childProcess / write / env).
- Replanning MICRO/SMALL.
- Relaxing plugin-iso or fs-toctou tests.
