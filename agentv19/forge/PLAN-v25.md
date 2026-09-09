# PLAN v25 — Forge Ω

Status: **shipped in v22.0.0.** This document is the contract the Ω layer
implements, and what it deliberately does *not* rebuild.

## Already in the tree (do not rewrite)

meta.js, dag.js, completion.js, verifyledger.js, diagnose.js, recovery.js,
taskstate.js, agentmanager.js, modelstrategy.js, terminal.js, render.js,
compaction.js, memory.js, lessons.js, checkpoint.js, shellguard, netguard,
securefs, plugin isolation.

Ω is a layer *on top*: classify → hypothesis → impact → evidence → command
result → HUD. Meta still owns the lifecycle. Completion still owns COMPLETED.

## What v22.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | Task class MICRO…ARCHITECTURAL + smallest-sufficient workflow | `classify.js` |
| 2 | MICRO skips the model planner (synthesised 1-node DAG) | `meta.js` + `synthesizePlan` |
| 3 | Hypothesis engine with no-retry-on-reject | `hypothesis.js` |
| 4 | Evidence kinds + staleness on write | `evidence.js` |
| 5 | Impact radius → testing scope | `impact.js` |
| 6 | Structured command result + UI summary | `cmdout.js` / `tools.js` |
| 7 | Premium boxed HUD, width-safe | `renderOmegaPanel` + `/status` |
| 8 | Extra failure classes + specialised recovery | `diagnose.js` |
| 9 | Hypothesis-driven repair prompt + loop escalate | `meta.js` `repairSegment` |
| 10 | Impact radius → verifier ladder | `meta.js` `requestVerification` |
| 11 | Worker cap by class (MICRO/SMALL = 0 unless requested) | `meta.js` |

## Still PLAN-v24 (not this release)

Hybrid repo-map, lessons rerank, vision, browser tool, sandbox bash,
DAG fan-out >2, FORGE-BENCH, mid-task re-plan.

## Non-goals

- Runtime npm dependencies.
- Softening shellguard / netguard / securefs / plugin isolation.
- Replacing the 9-check completion gate.
- Rainbow terminal. Color is optional; symbols carry meaning.
