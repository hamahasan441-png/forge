# PLAN v60 — priority (Forge v57 layer on v56)

Status: **this release.** After v56 recorded tried methods, v57 ranks which
blocking gap is worth LEARN this turn. Cap 1 (2 only if both CRITICAL).
Lower-score gaps stay on `[gaps]`. No kernel rewrite. No second data root.
No crawler. No fake learning.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v56
ingest are unchanged. This layer sits on `knowgap.js`.

## Already in the tree (do not rewrite)

Ω / ∞ / v24–v56, `classifyTaskComplexity()` (frozen), MICRO-only synthesise,
single-mutating-writer, `planAcquire` / `ingestAcquire`, `recordGapOutcome`
(the only VERIFIED path). `FORGE_HOME` is the data root; `FORGE_DATA_DIR`
aliases it via `resolveDataDir()` — not a second tree.

v57 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not flip `allowNewPlugins`. It does not add
Tree-sitter. It does not fetch, scrape, or inject webpage text. It does
not claim VERIFIED from a search. It is not kernel self-mod (L6).

## What v57.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | Every CRITICAL/HIGH unknown became LEARN | `priorityOf` + `pickLearn` cap 1 |
| 2 | Recurrence/cost unused | samples/tried vs acquire cost/risk/time |
| 3 | Spec name FORGE_DATA_DIR vs existing root | `resolveDataDir`: FORGE_HOME wins, else FORGE_DATA_DIR, else ~/.forge |

## Contract

- `priorityOf(gap, prior)` = (impact + uncertainty + recurrence) / (cost + risk + time)
- Recurrence from `samples` / `tried` only — never raw task text
- LEARN cap 1; 2 only if both CRITICAL and second score ≥ 1
- Lower-score blocking gaps stay on `[gaps]` with `learn: false`
- Web cost 4; skill/repo still beat it
- A high-impact one-shot (samples=0) can still win
- LOW skip stays skip; typo LEARN empty
- compose write-free; ingest still UNCERTAIN; `recordGapOutcome` only VERIFIED path
- `formatSteer({})` still `""`
- `classifyTaskComplexity()` frozen; `assumeYes` / `allowNewPlugins` stay false
- Zero new npm deps; `~/.forge/tools` never written
- `FORGE_HOME` remains the single data root

## Non-goals

- CONTRADICTED state, skill CANDIDATE→PROMOTE, graph-as-knowledge
- Research crawler / page dump / auto-VERIFIED
- TUI, bench 2.0, multi-agent, kernel rewrite
- A second `data/` tree under the checkout
- Landing the v38–v56 stack onto `main`

## Bigger map (not this release)

P1–P3 of the professional-intelligence spec stay later. This is P0 #4 only:
rank which gap is worth paying for.
