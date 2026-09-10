# PLAN v49 — apply (Forge v46)

Status: **shipped in v46.0.0.** After v45's steer: repair / `load_skill` /
RECOVER used the playbook, but the cold execute path still grepped.
`formatSteer` never reached the first-pass system prompt. Learned
`SKILL.md` bodies (What worked / Files / Verify) never reached the
noTools planner — names only, so the model had to guess `load_skill`.
MODIFY ignored `playbookFiles`. One apply layer now injects the skill
body, ranks TRY FIRST on execute, and short-circuits MODIFY when the
file is already known. Fast on 8-core / 12GB. No kernel rewrite.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v45
steer are unchanged. This layer sits on `skills.js` / `evolve.js` /
`evaluate.js` / `compose.js` / `router.js` / `agent.js` / `chat.js`.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH / v30 vision / v31 browser / v32 incremental
index + language adapters / v33 cross-language graph / v34 skill evaluator
+ plugin selector + integrator / v35 language-specific reasoning / v36
graph-aware memory invalidation / v37 language-aware engine / v38 gap-fix
/ v39 focused verification / v40 strategy evolution / v41 compose pipeline
/ v42 isolated plugin self-extension / v43 compose picks learned plugins
/ v44 playbook snapshot / v45 steer, shellguard, netguard, securefs, plugin
isolation, the 9-check completion gate, `classifyTaskComplexity()` (frozen),
MICRO-only synthesise, TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS,
single-mutating-writer.

v46 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not flip `allowNewPlugins`. It does not add
Tree-sitter. It does not patch `plugin-host`. It does not write into
`~/.forge/tools` or `agentv19/forge/skills/`. It does not import() a
learned plugin. It does not auto-run the recorded command. It does not
put compose into the Ω kernel. It is not kernel self-mod (L6).

## What v46.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | `formatSteer` only fired on repair — first pass grepped | `agentSystemPrompt` + chat inject TRY FIRST |
| 2 | learned `SKILL.md` body never reached the noTools planner | `parseSkillPlaybook` → `[skill]` in `formatCompose` |
| 3 | skill files never cited into world (only plugin playbooks did) | `filesFromSkills` union into `composeWorld` |
| 4 | MODIFY ignored `playbookFiles` so IMPLEMENT rediscovered | `planChain` short path: inspect → edit → focused verify |

## Contract

- `parseSkillPlaybook("")` is `{ repair: "", files: [], command: "" }`
- `parseSkillPlaybook` of a v40 SKILL.md returns What worked / Files / Verify
- absolute / `..` / `~` paths in skill files are dropped
- `compose` of a matching learned skill includes `repair`/`files`/`command` on the pick
- `formatCompose` includes `[skill] learned-…: <repair> — <files> — <command>`
- skill files cite into `[world]` even when the task text has no filename
- MICRO/SMALL do not attach skill bodies unless the skill is named
- a kernel-looking skill repair is not attached
- `formatSteer` of a skill with `repair` (and no plugin playbook) starts with TRY FIRST
- plugin playbook still ranks above skill body
- `planChain("implement the login header", { playbookFiles: ["auth.js"] })` does not grep; inspects `auth.js`
- `planChain("update the retry logic")` without playbook files still greps (v34 MODIFY frozen)
- `planChain("Find where tokens are generated", { playbookFiles: ["auth.js"] })` still greps (DISCOVER frozen)
- cold RECOVER without playbook files still greps (v45 frozen)
- `load_skill` still returns the full markdown
- compose stays synchronous
- `~/.forge/tools` is never written
- `allowNewPlugins` stays false
- `classifyTaskComplexity()` unchanged
- `assumeYes` / `allowSudo` stay false
- Zero runtime npm dependencies
- Bundled `agentv19/forge/skills/` is never written

## Bigger map (not this release)

L6 kernel self-mod is explicitly out. World-model rewrite, Tree-sitter as
a runtime dep, edit-transaction rewrite stay explicitly out. Dropping
learned plugins from the live tool schema (they still spawn plugin-host
if selected) is a follow-on, not this layer.

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
- Adding new bundled skills.
