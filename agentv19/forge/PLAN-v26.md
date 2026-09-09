# PLAN v26 — Forge ∞

Status: **shipped in v23.0.0.** This document is the contract the ∞ layer
implements, and what it deliberately does *not* rebuild.

## Already in the tree (do not rewrite)

meta.js, dag.js, completion.js, verifyledger.js, diagnose.js, recovery.js,
taskstate.js, agentmanager.js, modelstrategy.js, terminal.js, render.js,
compaction.js, memory.js, lessons.js, checkpoint.js, shellguard, netguard,
securefs, plugin isolation.

Ω (v22): classify, hypothesis, evidence, impact, cmdout, omega kernel, HUD.
∞ is a layer *on top of Ω*. Meta still owns the lifecycle. Completion still
owns COMPLETED. `classifyTaskComplexity()` stays frozen.

## What v23.0 closed (P0 / P1)

| # | Gap | Module |
|---|---|---|
| 1 | Causal engine: SYMPTOM / PROXIMATE / ROOT / CONTRIBUTING / SECONDARY | `causal.js` |
| 2 | Self-diagnostics: PROJECT vs FORGE origin | `selfdiag.js` |
| 3 | Task model origin tags; ASSUMPTION never promotes to REQUIREMENT | `taskmodel.js` |
| 4 | RECOVERY class on resume only — never steals MICRO scoring | `classify.js` |
| 5 | Counterfactual from impact radius | `causal.counterfactual` + `omega.counterfactualOf` |
| 6 | Adversarial review checklist for LARGE / ARCH (no extra model call) | `review.js` + `meta.attemptCompletion` |
| 7 | Process-local telemetry counters | `telemetry.js` |
| 8 | Extra diagnose codes CONFIGURATION / RUNTIME / INTEGRATION (after TEST/BUILD) | `diagnose.js` |
| 9 | HUD shows class / cause / origin; banner `∞ autonomous engineering` | `renderOmegaPanel` / `ui.js` |

## Still PLAN-v24 (not this release)

Hybrid repo-map, lessons rerank, vision, browser tool, sandbox bash,
DAG fan-out >2, FORGE-BENCH, mid-task re-plan.

## Explicitly not this release

World-model rewrite, incremental full project graph, edit-transaction
rewrite. Those stay future work; the existing recovery/checkpoint/DAG
paths remain authoritative.

## Non-goals

- Runtime npm dependencies.
- Softening shellguard / netguard / securefs / plugin isolation.
- Replacing the 9-check completion gate.
- A second agent call to "review" LARGE/ARCH work (would break call-count tests).
- Changing TASK_STARTED → THINKING (test-ui asserts THINKING).
