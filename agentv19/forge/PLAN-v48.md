# PLAN v48 — steer (Forge v45)

Status: **shipped in v45.0.0.** After v44's playbook snapshot: the planner
saw `[playbook]`, but repair still rediscovered from scratch, `load_skill`
could not return a `learned_*` playbook, and the RECOVER tool-chain always
grepped even when the playbook already named the file. One steer block
now ranks playbook → skills → avoid. Repair tries the known fix first.
`load_skill` falls back to PLAYBOOK markdown (no spawn). The RECOVER
chain skips rediscovery when playbook files are known. Fast on 8-core /
12GB. No kernel rewrite.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v44
playbook are unchanged. This layer sits on `evaluate.js` / `compose.js` /
`extend.js` / `router.js` / `tools.js` / `meta.js`.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH / v30 vision / v31 browser / v32 incremental
index + language adapters / v33 cross-language graph / v34 skill evaluator
+ plugin selector + integrator / v35 language-specific reasoning / v36
graph-aware memory invalidation / v37 language-aware engine / v38 gap-fix
/ v39 focused verification / v40 strategy evolution / v41 compose pipeline
/ v42 isolated plugin self-extension / v43 compose picks learned plugins
/ v44 playbook snapshot, shellguard, netguard, securefs, plugin isolation,
the 9-check completion gate, `classifyTaskComplexity()` (frozen),
MICRO-only synthesise, TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS,
single-mutating-writer.

v45 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not flip `allowNewPlugins`. It does not add
Tree-sitter. It does not patch `plugin-host`. It does not write into
`~/.forge/tools` or `agentv19/forge/skills/`. It does not import() a
learned plugin. It does not auto-run the recorded command. It does not
put compose into the Ω kernel. It is not kernel self-mod (L6).

## What v45.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | repair rediscovered from scratch despite a matching playbook | `formatSteer` in `repairSegment` — TRY FIRST |
| 2 | `load_skill(learned_*)` missed the plugin playbook | `readLearnedPlaybookByName` — markdown, no spawn |
| 3 | RECOVER chain always grepped even when playbook named the file | `planChain` short path: inspect → edit → focused verify |
| 4 | passing live plugins into compose dropped `repair`/`files` | `unionPlugins` fills playbook fields from the index |

## Contract

- `formatSteer({})` is `""`
- `formatSteer` of a matching learned plugin starts with `TRY FIRST` and names the repair
- MICRO/SMALL: empty plugins → no TRY FIRST
- `load_skill` of a `learned_*` plugin name returns `## What worked` markdown
- `load_skill` of a kernel-looking playbook is still not found
- `load_skill` of an unknown name still errors
- `planChain("Fix the failing authentication test")` without playbook files still greps (v34 chain frozen)
- `planChain(..., { playbookFiles: ["auth.js"] })` does not grep; inspects `auth.js`; no regress step
- compose of a caller plugin with the same name as a learned plugin keeps the caller object and fills `repair`
- repair does not execute the recorded command
- `compose` stays synchronous
- `~/.forge/tools` is never written
- `allowNewPlugins` stays false
- `classifyTaskComplexity()` unchanged
- `assumeYes` / `allowSudo` stay false
- Zero runtime npm dependencies

## Bigger map (not this release)

Shipped next: **v46.0.0 / PLAN-v49** (apply: learned SKILL.md body + TRY FIRST
on the cold execute path; MODIFY honors playbookFiles). L6 kernel self-mod
is explicitly out. World-model rewrite, Tree-sitter as a runtime dep,
edit-transaction rewrite stay explicitly out.

## Non-goals

- Runtime npm dependencies (no Tree-sitter).
- A second mutating writer.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes` or `allowNewPlugins`.
- Patching `classifyTaskComplexity` / `plugin-host` / `securefs` / Ω kernel.
- Writing into `~/.forge/tools` or the bundled `agentv19/forge/skills/` pack.
- Spawning `plugin-host` from `compose()` / `load_skill`.
- Auto-running the recorded command / inventing CLI flags.
- Auto-granting `pluginGrants`.
- Replanning MICRO/SMALL.
- Relaxing plugin-iso or fs-toctou tests.
