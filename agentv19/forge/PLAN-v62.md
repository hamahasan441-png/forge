# PLAN v62 — contradict (Forge v59 layer on v58)

Status: **this release.** After v58 tagged learned skills CANDIDATE, v59
closes the self-knowledge hole: a VERIFIED domain that later fails an
acquire tool is CONTRADICTED, not KNOWN. `recordGapOutcome(VERIFIED)` is
the only way back. No kernel rewrite. No second data root. No crawler.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v58
skilllife are unchanged. This layer sits on `knowgap.js`.

## Already in the tree (do not rewrite)

v54 detectGaps / v56 ingestAcquire (success → UNCERTAIN, skip VERIFIED) /
v57 priorityOf. VERIFIED was immortal: failed later evidence was ignored.

## What v59.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | Failed acquire on VERIFIED stayed KNOWN | ingestAcquire failed + trusted → CONTRADICTED |
| 2 | Planner still treated it as known | evidenceFor CONTRADICTED before VERIFIED; formatSteer CONTRADICT |
| 3 | Way back was missing | `recordGapOutcome(VERIFIED)` only |

## Contract

- Failed acquire matching a VERIFIED/KNOWN domain → CONTRADICTED, confidence 0.2, evidence `failed:<tool> <id>`
- Failed acquire on CANDIDATE / UNKNOWN / UNCERTAIN still ignored (v56)
- Successful ingest still never VERIFIED; still skips VERIFIED (does not demote to UNCERTAIN)
- persistGaps will not promote CONTRADICTED → KNOWN from lexical evidence
- planAcquire on CONTRADICTED is `verify` (bash), not web
- detectGaps lists CONTRADICTED on `[gaps]`; LEARN may be verify
- MICRO/SMALL unchanged; compose write-free; no page dump
- `formatSteer({})` still `""`; CONTRADICT is additive
- `classifyTaskComplexity()` frozen; `assumeYes` / `allowNewPlugins` stay false
- Zero new npm deps; `FORGE_HOME` remains the single data root

## Non-goals

- Time-based STALE, graph-as-knowledge, skill research pipeline
- Crawler, TUI, L6, landing the stack on `main`
