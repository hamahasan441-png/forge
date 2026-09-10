# PLAN v47 — playbook snapshot (Forge v44)

Status: **shipped in v44.0.0.** After v43's sync index: compose listed
learned plugin *names*, but the planner is `noTools` and cannot call the
plugin to read the playbook. `indexLearnedPlugins` already parsed
`repair` / `files` / `command` and threw them away. Matching playbooks
now cite their files into the world snapshot and `[playbook]` reaches
the plan prompt. Never spawn. Never auto-run tests. No kernel rewrite.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v43
pluginpick are unchanged. This layer sits on `extend.js` / `compose.js`
/ `verify.js`.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH / v30 vision / v31 browser / v32 incremental
index + language adapters / v33 cross-language graph / v34 skill evaluator
+ plugin selector + integrator / v35 language-specific reasoning / v36
graph-aware memory invalidation / v37 language-aware engine / v38 gap-fix
/ v39 focused verification / v40 strategy evolution / v41 compose pipeline
/ v42 isolated plugin self-extension / v43 compose picks learned plugins,
shellguard, netguard, securefs, plugin isolation, the 9-check completion
gate, `classifyTaskComplexity()` (frozen), MICRO-only synthesise,
TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS, single-mutating-writer.

v44 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not flip `allowNewPlugins`. It does not add
Tree-sitter. It does not patch `plugin-host`. It does not write into
`~/.forge/tools` or `agentv19/forge/skills/`. It does not import() a
learned plugin from `compose()`. It does not auto-run the recorded
command. It is not kernel self-mod (L6).

## What v44.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | PLAYBOOK `repair`/`files`/`command` parsed then dropped | keep them on the index entry |
| 2 | planner is `noTools` so it cannot call the plugin for the body | `[playbook]` in `formatCompose` |
| 3 | task text with no filename skipped world/verify even when a matching playbook named the file | playbook files union into `composeWorld` |
| 4 | a dropped kernel-looking playbook could still be indexed | `KERNEL_HINT` skip in `indexLearnedPlugins` |

## Contract

- `indexLearnedPlugins` after `authorPlugin` includes `repair`, `files`, `command`
- absolute / `..` / `~` paths in playbook files are dropped
- a kernel-looking playbook is not indexed
- `compose(task, { cwd })` of a matching learned plugin cites playbook files even when the task text has no filename
- `formatCompose` includes `[playbook] learned_…: <repair> — <files> — <command>`
- MICRO/SMALL do not cite playbook files and do not emit `[playbook]` unless the plugin is named
- `includePlugins: false` does not cite playbook files
- `[verify next]` still comes from `focusedVerify` (current stack), not blindly from playbook.command
- compose does not execute the recorded command
- `compose` stays synchronous
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
- Auto-running the recorded command / inventing CLI flags.
- Auto-granting `pluginGrants` (network / childProcess / write / env).
- Replanning MICRO/SMALL.
- Relaxing plugin-iso or fs-toctou tests.
