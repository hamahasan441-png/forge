# PLAN v63 — blast (Forge v60 layer on v59)

Status: **this release.** After v59 contradicted immortal VERIFIED, v60
surfaces the existing v33 graph as planner knowledge: blast radius,
importers, mapped tests, testing scope. Compose never walks the repo.
A miss is UNKNOWN, not "no dependents". No kernel rewrite. No second
data root. No new graph.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v59
contradict are unchanged. This layer sits on `impact.js` + `compose.js`.

## Already in the tree (do not rewrite)

v32 index, v33 `linkRecords` / `consumersOf` / `testsForFiles`, Ω
`impactRadius` (may walk). Compose already had `[world] → radius`. The
planner did **not** see importers, mapped tests, or scope, and LEARN
could still pick `web_search` when the graph already named a test.

## What v60.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | Graph unused as knowledge | `blastFromWorld` (graph only, never walks) |
| 2 | Planner treated a hub as a leaf | `[blast]` / `BLAST:` + testing scope |
| 3 | LEARN ignored mapped tests | `planAcquire` prefers graph tests over web |

## Contract

- `blastFromWorld` never calls `buildCrossGraph`, never walks, never writes
- Empty graph → `unknown: true` (not "no dependents")
- MICRO/SMALL skip blast (empty)
- `formatSteer({})` still `""`; BLAST is additive
- Graph-mapped tests beat `web_search`; skill/repo still beat tests
- Compose write-free; ingest still UNCERTAIN; `recordGapOutcome` only VERIFIED
- `classifyTaskComplexity()` frozen; `assumeYes` / `allowNewPlugins` stay false
- Zero new npm deps; `FORGE_HOME` remains the single data root
- Do not persist a second graph JSON — the v32 index is current truth

## Non-goals

- Rewriting xlang / repomap / Tree-sitter
- Drift detector, architecture-decision store, TUI graph pane
- Crawler, L6, landing the stack on `main`
