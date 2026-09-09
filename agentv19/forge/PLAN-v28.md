# PLAN v28 — unbounded autonomous execution (Forge v25)

Status: **shipped in v25.0.0.** This is the operational-budget layer: the
agent can run in-project commands and finish real work without the v24
25-step / 45-second / 12-step-segment stall. Catastrophic safety is
untouched.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval, shellguard, netguard, securefs, plugin isolation,
the 9-check completion gate, `classifyTaskComplexity()` (frozen), MICRO-only
synthesise, TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS.

v25 is a layer *on that*. It does not flip `tools.assumeYes`. It does not
disable block-class.

## What v25.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | Default budgets too small to finish tests/builds/multi-file work | `AGENT_BUDGETS` in `config.js` (80 steps, 180s bash, 32 segment steps, 80 segments, 250 tool calls, 12 continuations) |
| 2 | 300s bash hard cap killed long builds | `runBash` cap → 900s |
| 3 | `node -e` / `python -c` stalled autonomous runs | mutating `runAgent` sets `allowInterpreterEval` (config flag stays false; project config still cannot set it) |
| 4 | in-project `git reset --hard` / `clean` / `checkout -f` stalled without assumeYes | `modelMayRun({ autonomous: true })` narrow git exception |
| 5 | Class fuses (MICRO…ARCH) too tight when strategy *is* the budget | `classify.js` strategy maxSegments raised |

## Contract

- `defaultConfig().tools.assumeYes === false` (and allowSudo / allowInterpreterEval / allowOutsideProject / fetchPrivateUrls).
- Project `forge.config.json` still cannot set those keys.
- `classifyCommand('node -e …')` is still `danger` without the flag. `modelMayRun` without opts still refuses it. The agent context passes the flag.
- `autonomous: true` allows in-project git reset/clean/checkout/restore/rebase with destructive flags. It does **not** allow: git push, filter-branch, outside-project rm, sudo, metadata, apt-get, npm publish, npm -g, CODE_DANGER, block-class.
- Block-class (`rm -rf /`, mkfs, fork bombs, dd to disk, shutdown) is refused even with autonomous + assumeYes + allowSudo + allowInterpreterEval.
- Completion is still the 9-check gate. Budgets are fuses, not the definition of done.

## Still PLAN-v24 (not this release)

Vision, browser tool, sandbox bash, DAG fan-out >2, FORGE-BENCH, mid-task re-plan.

## Explicitly not this release

World-model rewrite, incremental full project graph, edit-transaction rewrite.

## Non-goals

- Runtime npm dependencies.
- Softening shellguard block-class / netguard / securefs / plugin isolation.
- Letting project config set `assumeYes` / `allowSudo` / `allowInterpreterEval`.
- Flipping `assumeYes` for the agent (that would also permit outside-project rm, sudo, metadata, apt-get, npm publish).
