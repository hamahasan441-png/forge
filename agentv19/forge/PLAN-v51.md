# PLAN v51 — hostless (Forge v48)

Status: **shipped in v48.0.0.** After v47's know: index locate, graph impl,
and lesson playbooks steered the first pass, but a matching learned plugin
still entered the live tool schema. Selecting it spawned `plugin-host` for
text that was already in `[playbook]` / `[skill]` / `[know]` / TRY FIRST /
`load_skill` markdown. One hostless cut now drops learned plugins from the
execute-path schema. User `~/.forge/tools` still load. Fast on 8-core /
12GB. No kernel rewrite.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v47
know are unchanged. This layer sits on `agent.js` / `chat.js` / `forge.js`
/ `extend.js`. `indexLearnedPlugins` (v43) and `load_skill` playbook
fallback (v45) stay the read path.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH / v30 vision / v31 browser / v32 incremental
index + language adapters / v33 cross-language graph / v34 skill evaluator
+ plugin selector + integrator / v35 language-specific reasoning / v36
graph-aware memory invalidation / v37 language-aware engine / v38 gap-fix
/ v39 focused verification / v40 strategy evolution / v41 compose pipeline
/ v42 isolated plugin self-extension / v43 compose picks learned plugins
/ v44 playbook snapshot / v45 steer / v46 apply / v47 know, shellguard,
netguard, securefs, plugin isolation, the 9-check completion gate,
`classifyTaskComplexity()` (frozen), MICRO-only synthesise,
TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS, single-mutating-writer.

v48 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not flip `allowNewPlugins`. It does not add
Tree-sitter. It does not patch `plugin-host`. It does not write into
`~/.forge/tools` or `agentv19/forge/skills/`. It does not delete
`mergeLearnedPlugins` / `loadLearnedPlugins` (v42 tests still load). It
does not auto-run the recorded command. It does not put compose into the
Ω kernel. It is not kernel self-mod (L6).

## What v48.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | `runAgent` merged learned plugins into the live schema → plugin-host spawn | `agent.js` loads `~/.forge/tools` only |
| 2 | chat loop same merge | `loadChatPlugins` loads `~/.forge/tools` only |
| 3 | `forge tools` registered learned plugins as callable tools | `registerPlugins` of user tools only |
| 4 | `forge plugins` spawned plugin-host to list playbooks | `indexLearnedPlugins` (sync); JSON `playbooks` array |

## Contract

- `agent.js` / `chat.js` / `forge.js` do not call `mergeLearnedPlugins` or `loadLearnedPlugins`
- `mergeLearnedPlugins` / `loadLearnedPlugins` still exist (v42 contract)
- `indexLearnedPlugins` after `authorPlugin` still lists `{ name, isolated, readOnly, source: "learned" }`
- `compose` of a matching learned plugin still emits `[plugins] learned_…`
- `load_skill` of a `learned_*` name still returns PLAYBOOK markdown
- `learnedPluginsDir(cwd) !== PLUGINS_DIR`
- `forge plugins --json` lists user tools under `tools` and learned entries under `playbooks`
- user `~/.forge/tools` still load via `loadToolPlugins(undefined)`
- compose stays synchronous
- compose does not import `child_process` and does not call `loadLearnedPlugins`
- `~/.forge/tools` is never written
- `plugin-host.js` is never written
- `allowNewPlugins` stays false
- `classifyTaskComplexity()` unchanged
- `assumeYes` / `allowSudo` stay false
- Zero runtime npm dependencies
- Bundled `agentv19/forge/skills/` is never written

## Bigger map (not this release)

L6 kernel self-mod is explicitly out. World-model rewrite, Tree-sitter as
a runtime dep, edit-transaction rewrite stay explicitly out.

## Non-goals

- Runtime npm dependencies (no Tree-sitter).
- A world-model rewrite / a second persisted graph file.
- A second mutating writer.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes` or `allowNewPlugins`.
- Patching `classifyTaskComplexity` / `plugin-host` / `securefs` / Ω kernel.
- Writing into `~/.forge/tools` or the bundled `agentv19/forge/skills/` pack.
- Deleting `mergeLearnedPlugins` / `loadLearnedPlugins`.
- Spawning `plugin-host` from `compose()` / `load_skill` / the execute path for learned plugins.
- Auto-running the recorded command / inventing CLI flags.
- Auto-granting `pluginGrants`.
- Replanning MICRO/SMALL.
- Relaxing plugin-iso or fs-toctou tests.
- Adding new bundled skills.
- Mixing INTENT.VERIFY / focusedVerify or a compose-once cache into this layer.
