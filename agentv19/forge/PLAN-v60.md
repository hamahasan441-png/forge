# PLAN v60 — next increment (thin)

Status: **not this release.** Saved for the next enhancement after v56 ingest.
Do not implement until the next "go". One layer. No kernel rewrite. No second
data root. No research crawler. No fake learning.

Source of truth is the tree, not this file.

## Audit (repo, not the 47-section spec)

| Spec P0 | Already in the tree | Gap |
|---|---|---|
| 1. Forge-owned data root | `FORGE_HOME` → `DEFAULT_DIR` (`~/.forge`). `projectDir(cwd)` = `projects/<hash>/`. `forge data status \| gaps`. Atomic `writeStateFile`. | Spec name `FORGE_DATA_DIR` is an alias, not a new tree. **Do not** create `Forge/data/` or `agentv19/forge/data/`. That would be a second store. |
| 2. Self-knowledge states | `STATUS`: KNOWN / PROBABLE / UNCERTAIN / UNKNOWN / SKIPPABLE. `LIFECYCLE`: CANDIDATE → ACTIVE → VERIFIED / STALE. Ingest never VERIFIED. | CONTRADICTED not a state yet. No per-claim subject store — do not invent a second memory. |
| 3. Knowledge gap engine | v54 `detectGaps` / `[gaps]` / `[skip]` | Done. |
| 4. Learning priority | v54 ranks by impact. v55 picks cheapest *source*. v56 skips *tried*. | **Does not rank which gap is worth learning now.** Every CRITICAL/HIGH unknown is LEARN. Recurrence, cost, future value unused. |
| 5. Acquisition | v55 `planAcquire` (skill → repo → docs → web last). v56 `ingestAcquire` (UNCERTAIN + `tried[]`). | Local only. No crawler. No page dump. Enough. |
| 6. Skill forge | v40/v42 `authorSkill` → project `SKILL.md`. v53 `pickSkills` top-k. Lifecycle is file-mtime, not CANDIDATE→PROMOTE. | Later. Do not build a second skill system. |
| 7. Engineering graph | v32 index + v33 cross-language graph. Impact via graph neighbors. | Later. Do not rewrite world-model. |

Also already present (do not duplicate): infogain v29, toolintel v52, modelstrategy, lessons v47, compose v41–v56, classify frozen, MICRO synthesise, single mutating writer, `assumeYes=false`.

## Next increment (v57) — priority

**One job:** rank blocking gaps so LEARN is the gap worth paying for, not every CRITICAL unknown.

```
score = (impact + uncertainty + recurrence)
      / (cost + risk + time)
```

- `impact` — existing IMPACT_RANK
- `uncertainty` — UNKNOWN > UNCERTAIN > PROBABLE (PROBABLE already goes to `known`)
- `recurrence` — `samples` / `tried` from `knowgap.json` (already persisted)
- `cost` — acquire method cost (skill 1 … web 4) from v55
- `risk` — web/fetch higher than repo/skill
- `time` — 1 unless method is web

Surface: still `[learn]` / `LEARN:`, but **cap 1** (maybe 2 if both CRITICAL). Lower-score blocking gaps stay on `[gaps]` with no LEARN. MICRO/SMALL unchanged.

Module: `knowgap.js` (`priorityOf` + slice). `formatSteer` already prints `learn[]`. Compose still never writes, never fetches.

Not: a new file, a new JSON root, a crawler, skill promotion, CONTRADICTED, FORGE_DATA_DIR rename-as-rewrite, TUI, bench 2.0, multi-agent, kernel.

## Contract (when implemented)

- `priorityOf(gap, prior)` is deterministic, no model call
- LEARN cap 1 (2 only if both CRITICAL and score ≥ threshold)
- Recurrence from `samples` / `tried` only — never from raw task text
- Web cost still 4; skill/repo still beat it
- A high-impact one-shot (samples=1, no tried) can still win
- A repeated LOW skip stays skip
- `formatSteer({})` still `""`
- compose write-free; ingest still UNCERTAIN; `recordGapOutcome` still the only VERIFIED path
- `classifyTaskComplexity()` frozen; `assumeYes` / `allowNewPlugins` stay false
- Zero new npm deps; `~/.forge/tools` never written
- `FORGE_HOME` remains the single data root. If `FORGE_DATA_DIR` is set, it **aliases** `FORGE_HOME` — same directory, no migration, no copy.

## Data-root rule (standing, every increment)

```
FORGE_DATA_DIR  =  FORGE_HOME  =  DEFAULT_DIR  =  ~/.forge
                     └── projects/<hash>/knowgap.json   (already)
                     └── projects/<hash>/toolstats.json (already)
                     └── memory.md, sessions/, checkpoints/ (already)
```

Override: `FORGE_HOME` or `FORGE_DATA_DIR` (same resolver). Never `~/.config`, never `/var`, never the user project, never a second `data/` tree under the checkout.

## Explicitly later (do not sneak in)

P0 leftover: CONTRADICTED state, skill CANDIDATE→PROMOTE, graph-as-knowledge.
P1: strategy 2.0, toolintel 2.0, model empirics, test generation, experiment engine upgrade, consolidation.
P2: architecture intel, drift detector, TUI knowledge pane, bench 2.0, multi-agent roles.
P3: kernel evolution — isolated worktree only, never now.

## Acceptance for v57 (when built)

- Payment + CSS task: LEARN is payment (or api), not ui
- Second run after ingest web: LEARN is not web_search again (v56) and may be empty if verify-only
- Typo: no LEARN
- No page dump, no VERIFIED-from-search, no second root
- Existing v54–v56 suites still green
