# PLAN v61 — skilllife (Forge v58 layer on v57)

Status: **this release.** After v57 ranked which gap to learn, v58 gives
learned skills a lifecycle. First `authorSkill` is CANDIDATE. VERIFIED only
after a second 9/9 COMPLETED `evolveRun` on the same playbook. No kernel
rewrite. No second data root. No write to `~/.forge/tools`. No auto-ACTIVE
on first write.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v57
priority are unchanged. This layer sits on `evolve.js` / `skillforge.js`.

## Already in the tree (do not rewrite)

v40 `authorSkill` already writes `~/.forge/projects/<hash>/skills/<name>/SKILL.md`.
v53 `pickSkills` already ranks. Do not invent a second skill system.

## What v58.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | First write was treated as a trusted skill | CANDIDATE in `skilllife.json` |
| 2 | No promote path with evidence | second 9/9 `evolveRun` (deduped) → VERIFIED |
| 3 | Planner could not see candidate vs shipped | `(candidate)` on formatSteer / [skills] |

## Contract

- New `authorSkill` → lifecycle CANDIDATE, samples 1, file still 0600 under `projectDir/skills/`
- Deduped author bumps samples, does **not** VERIFIED
- `recordSkillOutcome` is the only explicit VERIFIED path
- `evolveRun` calls it only when `score.ok && passed === total && skill.deduped`
- First-party / bundled skills stay ACTIVE (not in skilllife)
- MICRO/SMALL still skip authoring
- compose never writes SKILL.md or skilllife.json
- `formatSteer({})` still `""`; `(candidate)` is additive
- `classifyTaskComplexity()` frozen; `assumeYes` / `allowNewPlugins` stay false
- Zero new npm deps; `~/.forge/tools` never written
- `FORGE_HOME` remains the single data root (skilllife.json next to knowgap.json)

## Non-goals

- Research → implement a new skill from a gap
- Benchmark / test-generation of skills
- CONTRADICTED, graph-as-knowledge, crawler, TUI, L6
- Landing the stack on `main`
