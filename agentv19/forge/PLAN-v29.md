# PLAN v29 — DAG fan-out (Forge v26)

Status: **shipped in v26.0.0.** This is PLAN-v24 Tier 2 item 6: read-only
DAG workers beyond 2. A mutating node still runs alone. Low-RAM still
clamps to 1.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded execution, shellguard, netguard,
securefs, plugin isolation, the 9-check completion gate,
`classifyTaskComplexity()` (frozen), MICRO-only synthesise,
TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS, single-mutating-writer
(`scheduleBatch` serializes mutators; meta filter drops `coder` workers;
`settleWorkers` before a mutation boundary).

v26 is a layer *on that*. It raises the read-only fan-out cap. It does
not spawn a second writer.

## What v26.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | Class worker caps stuck at 1–2 | `classify.js` strategyFor: MEDIUM 2, LARGE 4, RECOVERY 2, ARCH 6. MICRO/SMALL stay 0 |
| 2 | `maxParallelSubAgents` ceiling of 2 made class caps a no-op | `AGENT_BUDGETS.maxParallelSubAgents` → 6 |
| 3 | Resource manager hardcoded 2/3 and INCREASE_CONCURRENCY cap of 3 | `workerCeiling()` — low tier = 1, normal ≤ 4, high ≤ 6, never above the budget |
| 4 | `scheduleBatch` default maxParallel 2 | default 6; callers still pass the class cap |

## Contract

- MICRO/SMALL `strategy.workers === 0`. Fan-out only if the caller passed `workers`.
- A batch from `scheduleBatch` contains either N read-only non-conflicting nodes or exactly one mutator, never both.
- Meta still filters `n.read_only && n.role !== "coder"` before `manager.spawn`.
- `workerCeiling(..., "low") === 1` even if config asks for 6.
- `freeMB < 400` still forces `limits.maxWorkers = 1`.
- `classifyTaskComplexity()` is unchanged.

## Still PLAN-v24 (not v26)

Vision, browser tool, FORGE-BENCH, mid-task re-plan, deeper lessons-into-planning.
Sandbox bash shipped in v27 (PLAN-v30).

## Explicitly not this release

World-model rewrite, incremental full project graph, edit-transaction rewrite.

## Non-goals

- Runtime npm dependencies.
- A second mutating worker.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes`.
