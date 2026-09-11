# PLAN v59 — ingest (Forge v56 layer on v55)

Status: **this release.** After v55 named the cheapest source, v56 records
that a real acquire tool actually ran. Status becomes UNCERTAIN (never
VERIFIED). Next `[learn]` skips tried methods. No page dump. No kernel
rewrite. No second data root.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v55
acquire are unchanged. This layer sits on `knowgap.js` / `agent.js` /
`chat.js`.

## Already in the tree (do not rewrite)

Ω / ∞ / v24–v55, `classifyTaskComplexity()` (frozen), MICRO-only synthesise,
single-mutating-writer, `recordToolRun` (v52 — tool stats, not this),
`recordGapOutcome` (the only VERIFIED path — not this).

v56 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not flip `allowNewPlugins`. It does not add
Tree-sitter. It does not fetch, scrape, or inject webpage text. It does
not claim VERIFIED from a search or a `load_skill`. It is not kernel
self-mod (L6).

## What v56.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | LEARN named a source, then forgot the run | `ingestAcquire` after `recordToolRun` |
| 2 | Next plan re-suggested the same `web_search` | `tried[]` skipped in `planAcquire` |
| 3 | Risk of dumping `fetch_url` bodies into the store | evidence is `${tool} ${id}` only |

## Contract

- Successful `load_skill` / `grep_files` / `glob_files` / `read_file` /
  `web_search` / `fetch_url` matching a domain → `tried` += method,
  status UNCERTAIN, lifecycle ACTIVE, confidence ≤ 0.5
- Failed / blocked records ignored
- `bash` / `write_file` / `think` ignored
- Never VERIFIED from ingest — `recordGapOutcome` stays the only path
- Never stores result text, URLs, or task text
- Next `planAcquire` skips `tried` methods; all tried → `verify` hint
- `persistGaps` will not demote UNCERTAIN → UNKNOWN
- compose never writes, never fetches, never calls `ingestAcquire`
- agent/chat call ingest after `recordToolRun`, then `clearComposeOnce`
  so the next segment sees the new `tried`
- MICRO/SMALL: detectGaps still empty unless a domain is named
- `formatSteer({})` is still `""`
- `evaluateSkills` unchanged; `classifyTaskComplexity()` unchanged
- `CATALOG[17]` is still `custom`
- `assumeYes` / `allowNewPlugins` stay false
- Zero runtime npm dependencies
- `~/.forge/tools` is never written
- `FORGE_HOME` remains the single data root

## Non-goals

- A research crawler / page extractor
- Auto-running tests after ingest
- Skill acquisition / promotion
- Fake confidence / auto-VERIFIED
- Tree-sitter, L6, world-model rewrite
- Landing the v38–v55 stack onto `main`

## Bigger map (not this release)

Self-reliance spec phases D–M (skill forge 2.0, strategy evolution 2.0,
bench 2.0) stay later. This is phase C *close the loop*: decide → run →
remember the method, not the page.
