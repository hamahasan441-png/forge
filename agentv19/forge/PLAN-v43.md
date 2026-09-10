# PLAN v43 — strategy evolution (Forge v40)

Status: **shipped in v40.0.0.** After v39's focused verification: L4 of
the SEASE ladder. Score the 9-check. Hard-avoid failed strategies
(confidence ≥ 0.5). Promote a successful lesson; demote a failed one
(disk is never deleted). Author a project-local SKILL.md from a
successful repair. Never the bundled pack. Never the kernel.
MICRO/SMALL skip authoring. No kernel rewrite.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v39
focusverify are unchanged. This layer sits on `lessons.js` / `skills.js`
/ `evaluate.js` / the 9-check.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH / v30 vision / v31 browser / v32 incremental
index + language adapters / v33 cross-language graph / v34 skill evaluator
+ plugin selector + integrator / v35 language-specific reasoning / v36
graph-aware memory invalidation / v37 language-aware engine / v38 gap-fix
/ v39 focused verification, shellguard, netguard, securefs, plugin isolation,
the 9-check completion gate, `classifyTaskComplexity()` (frozen), MICRO-only
synthesise, TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS,
single-mutating-writer.

v40 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not add Tree-sitter. It does not patch
`classifyTaskComplexity`, `plugin-host`, or `securefs`. It does not write
into `agentv19/forge/skills/`. It is not kernel self-mod (L6).

## What v40.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | 9-check result never scored after COMPLETED | `scoreRun` → `STRATEGY_EVOLVED` |
| 2 | `lessonsForPlan.avoided` was advisory only | `hardAvoid` (minConfidence 0.5) unioned into the plan |
| 3 | successful repairs recorded, never a playbook | `authorSkill` → `~/.forge/projects/<hash>/skills/` |
| 4 | learned skills invisible to evaluator / `load_skill` | `mergeLearnedSkills` + fallback in `load_skill` |
| 5 | no promote / demote of a lesson without deleting it | `setLessonConfidence`; `RETIRE_BELOW` 0.25 |

## Contract

- `scoreRun({})` is `{ ok: false, passed: 0, total: 9 }`
- `scoreRun` of all-true + `ok` + `COMPLETED` is `{ ok: true, passed: 9, total: 9 }`
- `hardAvoid` omits lessons below confidence 0.5
- `authorSkill` MICRO/SMALL → `{ ok: false, skipped: "micro" }`
- `authorSkill` with empty repair → `{ ok: false, skipped: "no-repair" }`
- `authorSkill` whose repair/files look like the kernel → `{ ok: false, skipped: "kernel" }`
- `authorSkill` writes under `~/.forge/projects/<hash>/skills/learned-…/SKILL.md`
- a second `authorSkill` of the same task is `{ ok: true, deduped: true }` (no overwrite)
- the bundled pack is never written
- `mergeLearnedSkills`: bundled names win; extras append
- `load_skill` falls back to the learned dir when the bundled SKILL.md is missing
- MICRO/SMALL still get zero auto-picks from `evaluateSkills` unless named
- `evolveRun` MICRO never authors, even on COMPLETED
- failed gate demotes the relevant lesson; COMPLETED promotes it (`PROMOTE_DELTA` 0.1)
- confidence below `RETIRE_BELOW` does not delete the lesson file
- `classifyTaskComplexity()` unchanged
- `assumeYes` / `allowSudo` stay false
- Zero runtime npm dependencies

## Bigger map (not this release)

Shipped next: **v41.0.0 / PLAN-v44** (compose pipeline: v32 index → world →
memory → skills → strategy → tools as one snapshot). L5 isolated plugin /
skill self-extension is not this release. L6 kernel self-mod is explicitly
out. World-model rewrite, Tree-sitter as a runtime dep, edit-transaction
rewrite stay explicitly out.

## Non-goals

- Runtime npm dependencies (no Tree-sitter).
- A second mutating writer.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes`.
- Patching `classifyTaskComplexity` / `plugin-host` / `securefs` from a lesson.
- Writing into the bundled `agentv19/forge/skills/` pack.
- Deleting lesson files (retire = low confidence, disk stays).
- Replanning MICRO/SMALL.
- Relaxing plugin-iso or fs-toctou tests.
- Auto-running tests.
