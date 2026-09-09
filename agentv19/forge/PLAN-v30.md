# PLAN v30 — high-capacity 12GB + sandbox bash (Forge v27)

Status: **shipped in v27.0.0.** A 12GB / 4-core laptop is high-capacity
(harder, smarter, deeper, faster). Sandbox bash is bwrap *when present*,
on top of shellguard. Missing binary → unsandboxed, never a fake sandbox.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded execution / v26 DAG fan-out,
shellguard, netguard, securefs, plugin isolation, the 9-check completion
gate, `classifyTaskComplexity()` (frozen), MICRO-only synthesise,
TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS, single-mutating-writer.

v27 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`.

## What v27.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | 12GB/4-core never reached `high` (`cores >= 6 && freeMB > 4000`) | `resourceProfile`: 8GB+ total is high unless low (2 cores / <2GB / free < 700MB). 2-core CI stays low. Sample inject for tests |
| 2 | High-tier worker ceiling stuck at 6 | `AGENT_BUDGETS.maxParallelSubAgents` → 8. LARGE 6, ARCH 8, MEDIUM 4, RECOVERY 4. `workerCeiling` high = 8, normal ≤ 4, low = 1 |
| 3 | Auto effort never deep on moderate, even on 12GB | `resolveEffort(profile, task, { tier })` — high + moderate → deep. 2-arg auto (trivial stays shallow, complex goes deep) unchanged |
| 4 | Token / fan-out / context budgets ignore high RAM | high: 4M tokens, 8s fan-out wait, 4000 context tokens |
| 5 | bash was unsandboxed even when bwrap exists | `sandbox.js` wrap after `modelMayRun`. No net unshare. Absent binary → `/bin/sh -c`, `sandboxed: false` |

## Contract

- `resourceProfile({ cores: 4, freeMB: 6000, totalMB: 12288 }).tier === "high"`
- `resourceProfile({ cores: 2, freeMB: 2000, totalMB: 3930 }).tier === "low"` (this CI, phones)
- `workerCeiling({}, "low") === 1` even if config asks for 8
- `freeMB < 400` still forces `limits.maxWorkers = 1`
- `resolveEffort("auto", "what is this file").deep === false` (2-arg, frozen)
- `resolveEffort("auto", <moderate>, { tier: "high" }).deep === true`
- `classifyTaskComplexity()` is unchanged
- MICRO/SMALL `strategy.workers === 0`
- A mixed `scheduleBatch` is still all read-only or one mutator, never both
- `wrapBash` with no bwrap → `{ sandboxed: false, file: "/bin/sh" }`
- `wrapBash` never includes `--unshare-net`
- `modelMayRun` still runs *before* the wrap; block-class never reaches bwrap
- `assumeYes` / `allowSudo` stay false; project config cannot set them

## Still PLAN-v24 (not this release)

Vision, browser tool, FORGE-BENCH, mid-task re-plan, deeper lessons-into-planning.

## Explicitly not this release

World-model rewrite, incremental full project graph, edit-transaction rewrite.

## Non-goals

- Runtime npm dependencies.
- A second mutating worker.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes`.
- Claiming a sandbox when bwrap is absent.
