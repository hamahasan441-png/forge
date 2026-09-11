# PLAN v58 — acquire (Forge v55 layer on v54)

Status: **this release.** After v54's knowledge-gap ranking: each blocking
gap gets a cheapest-source acquisition plan (existing skill → repo grep →
local docs → web_search last). The plan joins compose as `[learn]` and
formatSteer as `LEARN:`. Compose never fetches. Never dumps a page. No
kernel rewrite. No second data root. No fake "I learned X".

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v54
knowgap are unchanged. This layer sits on `knowgap.js` / `compose.js` /
`evaluate.js`.

## Already in the tree (do not rewrite)

Ω / ∞ / v24–v54, `classifyTaskComplexity()` (frozen), MICRO-only synthesise,
single-mutating-writer, infogain (v29 — failure experiments, not this),
`fetch_url` / `web_search` (tools the model already has — this layer only
*names* them as last resort).

v55 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not flip `allowNewPlugins`. It does not add
Tree-sitter. It does not fetch, scrape, or inject webpage text. It does
not claim VERIFIED from a search. It is not kernel self-mod (L6).

## What v55.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | `[gaps]` said "research+verify" but named no source | `planAcquire` cheapest method |
| 2 | External search was implied even when a skill/file existed | skill → repo → docs → web |
| 3 | Risk of dumping pages into context | compose never fetches; LEARN says "do not dump pages" |

## Contract

- `planAcquire` of a KNOWN / SKIPPABLE / `learn:false` gap is null
- payment + `forge-api` in the snapshot → `load_skill forge-api` (cost 1)
- payment + files, no skill → `grep_files` (repo)
- payment + no skill + no files → `web_search "payment official documentation"` (cost 4)
- compose never calls `fetch_url` / `web_search` / `https`
- MICRO/SMALL: learn empty unless a domain is named (same as gaps)
- `formatSteer({})` is still `""`; LEARN is additive
- persist stores `{ method, tool, cost }` aggregates, no page text
- `recordGapOutcome` is still the only VERIFIED path
- `evaluateSkills` unchanged; `classifyTaskComplexity()` unchanged
- `CATALOG[17]` is still `custom`
- `assumeYes` / `allowNewPlugins` stay false
- Zero runtime npm dependencies
- `~/.forge/tools` is never written
- compose stays synchronous
- `FORGE_HOME` remains the single data root

## Non-goals

- A research crawler / page extractor / source-quality scorer
- Auto-running `web_search` or `fetch_url` from compose
- Skill acquisition / promotion (later phase)
- Fake confidence
- Tree-sitter, L6, world-model rewrite
- Landing the v38–v54 stack onto `main`

## Bigger map (not this release)

Self-reliance spec phases D–M (skill forge 2.0, strategy evolution,
bench 2.0) stay later. This is phase C *local*: decide how to learn,
prefer the cheapest source, do not dump. Verified acquisition after a
real tool result remains `recordGapOutcome`.
