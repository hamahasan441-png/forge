# PLAN v39 — graph-aware memory invalidation (Forge v36)

Status: **shipped in v36.0.0.** After v35's language-specific reasoning:
UNIFIED §9 + §33 Memory ↔ World Model. Historical notes drop when the
v32 index or a v33 graph neighbor is newer. Layer on lessons.js /
memory.js / xlang.js. No kernel rewrite. No memory.js storage rewrite.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v35
langreason are unchanged. This layer sits on `memgraph.js`.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH / v30 vision / v31 browser / v32 incremental
index + language adapters / v33 cross-language graph / v34 skill evaluator
+ plugin selector + integrator / v35 language-specific reasoning,
shellguard, netguard, securefs, plugin isolation, the 9-check completion
gate, `classifyTaskComplexity()` (frozen), MICRO-only synthesise,
TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS, single-mutating-writer.

v36 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not add Tree-sitter. It does not delete memory
from disk (retrieval drops STALE; history remains).

## What v36.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | Lessons stale only on the cited file's mtime | `expandWrites`: importers / consumers / tests inherit the changed mtime |
| 2 | Project memory still injected after the file moved | `relevantMemory` drops project notes whose cited files (or neighbors) are newer |
| 3 | "prefer tabs" treated like a file fact | no files cited → not stale (global prefs stay) |
| 4 | Empty graph invented a miss | no index / no edges / no asOf → not stale |

## Contract

- `filesCited('prefer tabs')` is `[]`
- `filesCited('util.js add overflow')` includes `util.js`
- `filesCited('see https://example.com/app.js')` does not include `app.js`
- `radiusOf(['util.js'], graph)` includes `app.js` and `util.test.js` when those IMPORT it
- `radiusOf(['util.js'], { files: [], edges: [] })` is `['util.js']`
- `expandWrites({ 'util.js': 2000 }, graph)['app.js'] === 2000`
- `entryIsStale` on a note about `app.js` is true when `util.js` is newer
- `entryIsStale` with no files / no writes / no asOf is false
- `relevantMemory` keeps global prefs; drops the stale project note
- `lessonIsStale` still true for the v34 same-file case
- `classifyTaskComplexity()` unchanged
- `assumeYes` / `allowSudo` stay false
- Zero runtime npm dependencies
- `files[]` includes `memgraph.js`

## Bigger map (not this release)

§6 language-aware engine beyond regex adapters (LSP / compiler as
optional, never a runtime dep). World-model rewrite, Tree-sitter as a
runtime dep, edit-transaction rewrite stay explicitly out.

## Non-goals

- Runtime npm dependencies (no Tree-sitter).
- A second mutating writer.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes`.
- Deleting stale memory from disk.
- Replanning MICRO/SMALL.
- Rewriting `memory.js` locks / provenance / append pipeline.
