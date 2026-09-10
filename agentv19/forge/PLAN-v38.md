# PLAN v38 — language-specific reasoning (Forge v35)

Status: **shipped in v35.0.0.** After v34's skill evaluator + integrator:
UNIFIED §8 — adapt planning / repair / verify to the language actually in
play. Never apply JavaScript patterns to Rust. Layer on `lang.js`. No
kernel rewrite.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v34
skills are unchanged. This layer sits on `langreason.js`.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH / v30 vision / v31 browser / v32 incremental
index + language adapters / v33 cross-language graph / v34 skill evaluator
+ plugin selector + integrator, shellguard, netguard, securefs, plugin
isolation, the 9-check completion gate, `classifyTaskComplexity()` (frozen),
MICRO-only synthesise, TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS,
single-mutating-writer.

v35 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not add Tree-sitter. It does not invent a test
command for a missing ecosystem.

## What v35.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | Planner used the same advice for Rust and JavaScript | `langreason.js`: per-language constraints (ownership, GIL, event loop, …) |
| 2 | MICRO typo still got a language lecture | MICRO/SMALL → no constraints unless the task names a language |
| 3 | `detectTestCommand` always preferred package.json | `verifyFor`: language-native command when that manifest exists; 1-arg `detectTestCommand` frozen |
| 4 | Mixed-stack edits mixed patterns | `formatLangReason` says do not mix; `mixedWarning` when 2+ langs |

## Contract

- `languagesIn('fix a typo in README')` is `[]`
- `languagesIn('fix a rust borrow checker error across files')` includes `rust`
- `namedLangIn('please cargo test this')` includes `rust`
- `semanticsFor('rust').constraints` mentions ownership
- `formatLangReason(['javascript'])` does not mention ownership
- `formatLangReason(['rust'])` mentions ownership
- `formatLangReason([])` is `''`
- `verifyFor(['rust'])` is `''` (no cwd → do not invent)
- `verifyFor(['rust'], { cwd: cargoDir })` is `cargo test`
- `verifyFor(['rust'], { cwd: npmAndCargo })` is `cargo test`
- `detectTestCommand(npmAndCargo)` stays `npm test` (1-arg frozen)
- `verifyFor(['python'], { cwd: pyDir })` is `pytest -q`
- `classifyTaskComplexity()` unchanged
- `assumeYes` / `allowSudo` stay false
- Zero runtime npm dependencies
- `files[]` includes `langreason.js`

## Bigger map (not this release)

§9 graph-aware memory invalidation beyond lesson mtime (Memory ↔ World
Model). World-model rewrite, Tree-sitter as a runtime dep, edit-transaction
rewrite stay explicitly out.

## Non-goals

- Runtime npm dependencies (no Tree-sitter).
- A second mutating writer.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes`.
- Inventing `cargo test` in a repo with no `Cargo.toml`.
- Replanning MICRO/SMALL.
- Changing 1-arg `detectTestCommand` / `discoverToolchain`.
