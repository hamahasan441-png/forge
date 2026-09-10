# PLAN v42 — focused verification (Forge v39)

Status: **shipped in v39.0.0.** After v38's gap-fix: UNIFIED §13 leftover
+ §19 remainder. The HIGH TESTS command v38 named (`cargo test` vs
`npm test`) actually reaches the model. The v33 graph lists the
connected test files. Verification never runs that command. No kernel
rewrite.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v38
gaps are unchanged. This layer sits on `verify.js` / `toolintel.js` /
`xlang.js`.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH / v30 vision / v31 browser / v32 incremental
index + language adapters / v33 cross-language graph / v34 skill evaluator
+ plugin selector + integrator / v35 language-specific reasoning / v36
graph-aware memory invalidation / v37 language-aware engine / v38 gap-fix,
shellguard, netguard, securefs, plugin isolation, the 9-check completion
gate, `classifyTaskComplexity()` (frozen), MICRO-only synthesise,
TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS, single-mutating-writer.

v39 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not add Tree-sitter. It does not auto-run tests.
It does not invent `npm test -- file.test.js` flags.

## What v39.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | v38 put `command` on HIGH TESTS; `formatVerification` never showed it | `formatVerification` emits `[verify next] cargo test` |
| 2 | HIGH TESTS ignored the v33 graph | `focusedVerify`: `testsForFiles` (cap 8); empty graph → `tests: []` |
| 3 | toolintel stripped recommended to kind-only | recommended records keep `command` + `tests` |

## Contract

- `focusedVerify(empty)` is `{ command: "", tests: [] }`
- `focusedVerify(cargoDir, [lib.rs])` is `{ command: "cargo test", tests: [] }` when no test file is connected
- `focusedVerify(jsDir, [util.js])` command is `npm test` and tests includes `util.test.js` when that file imports util
- HIGH `verificationPlan` for that write carries `command` and `tests`
- `formatVerification` of that plan includes `[verify next] npm test`
- `runVerification` does not execute the recommended command
- 1-arg `detectTestCommand(mixed)` stays `npm test`
- `classifyTaskComplexity()` unchanged
- `assumeYes` / `allowSudo` stay false
- Zero runtime npm dependencies

## Bigger map (not this release)

Shipped next: **v40.0.0 / PLAN-v43** (strategy evolution: score the
9-check, hard-avoid failed strategies, author a project SKILL.md from a
successful repair — never the kernel, never the bundled pack).
World-model rewrite, Tree-sitter as a runtime dep, edit-transaction
rewrite stay explicitly out. L6 kernel self-mod is explicitly out.

## Non-goals

- Runtime npm dependencies (no Tree-sitter).
- A second mutating writer.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes`.
- Auto-running `npm test` / `cargo test`.
- Inventing CLI flags (`npm test -- file.test.js`, `cargo test foo::bar`).
- Changing `discoverToolchain` / 1-arg `detectTestCommand`.
- Replanning MICRO/SMALL.
- Relaxing plugin-iso or fs-toctou tests.
