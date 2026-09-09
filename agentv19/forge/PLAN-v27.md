# PLAN v27 — retrieval surface (Forge v24)

Status: **shipped in v24.0.0.** This is PLAN-v24 Tier 1: hybrid repo-map,
lessons rerank, and extra-file snippet reorder. Embeddings only REORDER a
BM25 shortlist. They never widen it. A dead endpoint is the v23 BM25 result.

## Already in the tree (do not rewrite)

`rankDocsHybrid` (retrieval.js), the embeddings client, memory/learnings
async rerank (v23), meta `buildAsync`, the Ω/∞ kernel, shellguard / netguard
/ securefs / plugin isolation.

v24 is a layer *on that*. `buildRepoMap()` stays the synchronous BM25
path. `classifyTaskComplexity()` stays frozen. MICRO-only synthesise and
TASK_STARTED → THINKING are untouched.

## What v24.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | Hybrid repo-map (BM25 scan, embeddings reorder) | `repomap.js` `buildRepoMapAsync` |
| 2 | Lessons rerank through the same fusion | `lessons.js` `relevantLessonsAsync` / `lessonsForPromptAsync` / `ineffectiveStrategiesAsync` |
| 3 | Context engine wires repo-map + lessons + extraFiles | `context.js` `buildAsync` |
| 4 | Agent system prompt uses the precomputed repo-map | `agent.js` `repoMapBlock` |
| 5 | Meta uses hybrid ineffective-strategy lookup when embeddings are on | `meta.js` |

## Contract

- No embedder → `buildRepoMapAsync` === `buildRepoMap` (byte-identical).
- Embedder throw / timeout / ragged vectors → BM25.
- The listed file *set* of a hybrid repo-map is a subset of the scanned
  set; hybrid cannot surface a file the walk did not find.
- `relevantLessonsAsync` returns a subset of the BM25 shortlist, never a
  lesson the keyword ranker did not already have.
- extraFiles: reorder the *caller* list, never append.

## Still PLAN-v24 (not this release)

Vision, browser tool, sandbox bash, DAG fan-out >2, FORGE-BENCH,
deeper learning loop, mid-task re-plan.

## Explicitly not this release

World-model rewrite, incremental full project graph, edit-transaction
rewrite.

## Non-goals

- Runtime npm dependencies.
- Softening shellguard / netguard / securefs / plugin isolation.
- Replacing BM25 as the default (embeddings stay opt-in).
- A second agent call to "review" or "re-rank".
