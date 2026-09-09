# PLAN v31 — 8-core burst + mid-task replan (Forge v28)

Status: **shipped in v28.0.0.** Target machine: Xiaomi 13T Pro (8 cores /
12GB, ARM, Termux). Faster (burst workers, MemAvailable, 5s fan-out hang
ceiling) and smarter (lessons steer the first plan; verification evidence
rewrites the remaining DAG).

This is also the **bigger remaining map** after v27. v28 ships the
intelligence + 8-core layer. What stays on the board is listed at the
bottom — not this release.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded execution / v26 DAG fan-out /
v27 high-capacity 12GB + sandbox bash, shellguard, netguard, securefs,
plugin isolation, the 9-check completion gate, `classifyTaskComplexity()`
(frozen), MICRO-only synthesise, TASK_STARTED → THINKING,
PRIVILEGED_TOOL_KEYS, single-mutating-writer.

v28 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. Cycle replan (PLAN_CYCLE_DETECTED) stays.

## What v28.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | 13T Pro looked starved: `os.freemem()` is MemFree (often <700MB when 12GB is cached) so v27 classified the phone **low** (1 worker) | `readAvailableMB()` from `/proc/meminfo` MemAvailable. Injected `freeMB` still wins in tests |
| 2 | 8 cores sat idle on MEDIUM/LARGE (class caps 4/6, no burst) | `burst = cores>=8 && totalMB>=8192 && !low`. `scaleWorkers` +2 on burst, still capped at 8. MICRO/SMALL stay 0 |
| 3 | Fan-out hang ceiling 8s even on 8 cores | `fanoutWaitMs(tier, profile)` burst = 5s. 1-arg high stays 8s (v27 tests) |
| 4 | Lessons rerank retrieval / repair only — first plan was blind | `lessonsForPlan` → PLAN_LESSONS prefix on the model planner. Never ASSUMPTION→REQUIREMENT |
| 5 | Agent repaired in place; only re-planned on a DAG **cycle** | `shouldReplan` after 2 failed repairs / 2 consecutive failures / omega escalate. `replanRemaining` keeps COMPLETED nodes, prefixes new ids |

## Contract

- `resourceProfile({ cores: 8, freeMB: 2500, totalMB: 12288 }).tier === "high"`
- `resourceProfile({ cores: 8, freeMB: 2500, totalMB: 12288 }).burst === true`
- `resourceProfile({ cores: 4, freeMB: 6000, totalMB: 12288 }).burst === false` (v27 laptop)
- `resourceProfile({ cores: 2, freeMB: 2000, totalMB: 3930 }).tier === "low"`
- `resourceProfile({ cores: 8, freeMB: 400, totalMB: 12288 }).tier === "low"` (pressure)
- `scaleWorkers(0, burst) === 0`
- `scaleWorkers(4, burst) === 6` and `scaleWorkers(8, burst) === 8`
- `scaleWorkers(4, { burst: false }) === 4`
- `fanoutWaitMs("high") === 8000`
- `fanoutWaitMs("high", { burst: true }) === 5000`
- `shouldReplan({ klass: "MICRO", repairCount: 9 }) === false`
- `shouldReplan({ klass: "MEDIUM", repairCount: 2 }) === true`
- `maxReplans({ burst: true }) === 2` else 1
- A mixed `scheduleBatch` is still all read-only or one mutator
- `classifyTaskComplexity()` is unchanged
- `assumeYes` / `allowSudo` stay false

## Bigger map (not this release)

PLAN-v24 leftovers after v28:

| Order | Layer | Why it waits |
|---|---|---|
| 1 | FORGE-BENCH | Repeatable eval scored by the 9-check gate. Needs a harness, not more kernel. |
| 2 | Vision / multimodal | Provider must accept image parts. Config-only, no new npm dep. |
| 3 | Browser tool | Opt-in binary. Absent → tool reports unavailable. |

Explicitly not next: world-model rewrite, edit-transaction rewrite, runtime
npm deps, a second mutating worker, flipping `assumeYes`, a fake sandbox.

## Non-goals

- Runtime npm dependencies.
- A second mutating worker.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes`.
- Raising workers above 8 on an 8-core phone (thermal oversubscription).
- Replanning MICRO/SMALL.
