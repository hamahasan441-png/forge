# PLAN v50 — know (Forge v47)

Status: **shipped in v47.0.0.** After v46's apply: playbooks and learned
SKILL.md bodies steered the first pass, but only when token-overlap picked
them. The v32 index never located a file without a filename in the task.
The v33 graph already knew which source a test imports, and the router
still grepped. High-confidence lessons with a successful repair sat on
disk unused as a playbook. One know layer now treats index + graph +
lessons as the engineering knowledge graph: locate, link, apply.
Deterministic-first. Fast on 8-core / 12GB. No world-model rewrite.
No kernel rewrite.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v46
apply are unchanged. This layer sits on `xlang.js` / `memgraph.js` /
`compose.js` / `evaluate.js` / `lessons.js`.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH / v30 vision / v31 browser / v32 incremental
index + language adapters / v33 cross-language graph / v34 skill evaluator
+ plugin selector + integrator / v35 language-specific reasoning / v36
graph-aware memory invalidation / v37 language-aware engine / v38 gap-fix
/ v39 focused verification / v40 strategy evolution / v41 compose pipeline
/ v42 isolated plugin self-extension / v43 compose picks learned plugins
/ v44 playbook snapshot / v45 steer / v46 apply, shellguard, netguard,
securefs, plugin isolation, the 9-check completion gate,
`classifyTaskComplexity()` (frozen), MICRO-only synthesise,
TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS, single-mutating-writer.

v47 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not flip `allowNewPlugins`. It does not add
Tree-sitter. It does not rewrite the world model. It does not persist a
second graph file (lessons.json + index.json already persist). It does
not auto-run the recorded command. It does not put compose into the Ω
kernel. It is not kernel self-mod (L6). It does not author SKILL.md from
compose (compose stays read-only).

## What v47.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | v32 index was never queried to find files (Deep World Model leftover) | `filesFromIndex` — symbol/basename overlap, cap 2 |
| 2 | v33 TEST→source edges unused by the router (Engineering KG leftover) | `implForFiles` / `implOf` union into world files |
| 3 | high-confidence lessons with repair+files never became a playbook (Skill Forge / meta-learning leftover) | `indexKnow` → `[know]` / TRY FIRST |
| 4 | first pass still grepped when the graph already named the impl (deterministic-first leftover) | `playbookFilesOf` includes world files + know |

## Contract

- `implForFiles([], graph)` is `[]`
- `implForFiles` of a test that imports `auth.js` includes `auth.js`
- a non-test start file does not invent impl files
- `compose` of a matching high-confidence lesson includes `[know]` and cites its files
- absolute / `..` / `~` lesson files are dropped
- a kernel-looking lesson repair is not attached
- confidence below 0.5 does not become know
- MICRO/SMALL do not index know and do not locate from the index
- `includeLessons: false` skips know
- `formatSteer` of a know hit (no plugin/skill playbook) starts with TRY FIRST
- plugin playbook still ranks above know
- compose of an indexed symbol match cites that file even when the task text has no filename
- `planChain("update the retry logic")` without files still greps (v34 MODIFY frozen)
- DISCOVER still greps
- compose stays synchronous
- `~/.forge/tools` is never written
- compose does not write lessons.json / SKILL.md / learned plugins
- `allowNewPlugins` stays false
- `classifyTaskComplexity()` unchanged
- `assumeYes` / `allowSudo` stay false
- Zero runtime npm dependencies
- Bundled `agentv19/forge/skills/` is never written

## Bigger map (not this release)

Shipped next: **v48.0.0 / PLAN-v51** (hostless: learned plugins are
playbooks, never a live plugin-host spawn). L6 kernel self-mod is
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
- Authoring SKILL.md / learned plugins from `compose()`.
- Spawning `plugin-host` from `compose()` / `load_skill`.
- Auto-running the recorded command / inventing CLI flags.
- Auto-granting `pluginGrants`.
- Replanning MICRO/SMALL.
- Relaxing plugin-iso or fs-toctou tests.
- Adding new bundled skills.
