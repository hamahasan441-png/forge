# PLAN v32 — information-gain + FORGE-BENCH (Forge v29)

Status: **shipped in v29.0.0.** First slice of the UNIFIED AUTONOMOUS
SOFTWARE ENGINEERING UPGRADE that is not a kernel rewrite: pick the next
experiment by information gain (spec §11) and prove the loop with
FORGE-BENCH (spec §27 / PLAN-v31 leftover #1).

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst is
unchanged. This layer makes repair *smarter* (stop repeating cheap-to-skip
experiments) and makes the agent *measurable*.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning, shellguard,
netguard, securefs, plugin isolation, the 9-check completion gate,
`classifyTaskComplexity()` (frozen), MICRO-only synthesise,
TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS, single-mutating-writer.

v29 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. `nextRepair().action` stays the Ω/∞ contract.

## What v29.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | Repair ranked hypotheses by confidence only — ignored cost/risk/time, so a full suite or a mutating fix could beat a 1-line inspect | `infogain.js` `informationGain` + catalog. Inspect/read-stack win while uncertain. Mutating experiments require a prior inspect/test |
| 2 | The same uninformative probe could be retried forever (only hypothesis-id looping was detected) | Engine history: tried-once ×0.2 gain, tried-twice excluded. `noteExperiment` from `repairSegment` |
| 3 | FORGE origin / SAFETY_BLOCK could still suggest a project edit | Policy: FORGE → escalate, SAFETY_BLOCK → abort, looping → different_cause. Forced items are not in the normal rank |
| 4 | No repeatable eval scored by the 9-check gate | `bench.js` 12 progressive cases, `forge bench`. Incomplete DAG + missing verification is NOT COMPLETED. Crash-resume is RECOVERY. Replan keeps completed nodes |

## Contract

- `informationGain({ uncertainty:5, diagnostic:5, impact:5, reliability:5, cost:1, risk:1, time:1 })` is finite and > a cost-5 equivalent
- `selectExperiment({ code: "SAFETY_BLOCK" }).id === "abort"`
- `selectExperiment({ origin: { origin: "FORGE" } }).id === "escalate"`
- `selectExperiment({ looping: true, action: "escalate" }).id === "different_cause"`
- MICRO/SMALL never rank `full_suite`
- `selectExperiment` after recording `inspect_file` twice does not pick `inspect_file`
- Mutating `minimal_fix` is not first while no inspect has been recorded
- `nextRepair().action === "escalate"` still holds for FORGE origin and looping (Ω/∞)
- `nextRepair().experiment` is always present after `observeCommand` of a failure
- FORGE-BENCH 12/12 on a stock kernel, no provider, no network
- Case 12: `canCompleteTask` with missing verification is not COMPLETED; `replanRemaining` keeps the completed node
- Case 10: `classifyTask(task, { resume: true }).class === "RECOVERY"`
- `classifyTaskComplexity()` is unchanged
- `assumeYes` / `allowSudo` stay false
- A mixed `scheduleBatch` is still all read-only or one mutator

## Bigger map (not this release)

PLAN-v31 leftovers after v29:

| Order | Layer | Why it waits |
|---|---|---|
| 1 | Vision / multimodal | Provider must accept image parts. Config-only, no new npm dep. |
| 2 | Browser tool | Opt-in binary. Absent → tool reports unavailable. |

Explicitly not next: world-model rewrite, Tree-sitter / language adapters
as a runtime dep, edit-transaction rewrite, a second mutating worker,
flipping `assumeYes`, a fake sandbox.

## Non-goals

- Runtime npm dependencies.
- A second mutating worker.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes`.
- Changing `nextRepair().action` semantics.
- Replanning MICRO/SMALL.
- Declaring COMPLETED because a step counter was not hit.
