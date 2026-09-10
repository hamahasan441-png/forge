# PLAN v52 — check (Forge v49)

Status: **shipped in v49.0.0.** After v48's hostless cut: learned plugins
are playbooks, but INTENT.VERIFY still guessed the test command.
`focusedVerify` already knew `cargo test` vs `npm test` and the
graph-connected tests. `[verify next]` showed them. The VERIFY chain and
bash synthesis ignored both. One check layer now feeds the native
command into VERIFY (and the verify step of MODIFY/RECOVER). Never
auto-run. Never invent flags. Fast on 8-core / 12GB. No kernel rewrite.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v48
hostless are unchanged. This layer sits on `router.js` / `verify.js` /
`agent.js`. `focusedVerify` (v39) and `recommendedVerify` (v38) stay
the source of the command.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH / v30 vision / v31 browser / v32 incremental
index + language adapters / v33 cross-language graph / v34 skill evaluator
+ plugin selector + integrator / v35 language-specific reasoning / v36
graph-aware memory invalidation / v37 language-aware engine / v38 gap-fix
/ v39 focused verification / v40 strategy evolution / v41 compose pipeline
/ v42 isolated plugin self-extension / v43 compose picks learned plugins
/ v44 playbook snapshot / v45 steer / v46 apply / v47 know / v48 hostless,
shellguard, netguard, securefs, plugin isolation, the 9-check completion
gate, `classifyTaskComplexity()` (frozen), MICRO-only synthesise,
TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS, single-mutating-writer.

v49 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not flip `allowNewPlugins`. It does not add
Tree-sitter. It does not patch `plugin-host`. It does not write into
`~/.forge/tools` or `agentv19/forge/skills/`. It does not auto-run the
recommended command. It does not put compose into the Ω kernel. It is
not kernel self-mod (L6). It does not invent `npm test --` flags.

## What v49.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | INTENT.VERIFY was a generic bash; focusedVerify never became the command | `planChain` VERIFY sets `args.command` from `focusedVerify` |
| 2 | mixed npm+cargo VERIFY ignored the named file's stack | rust file → `cargo test`; js file → `npm test` |
| 3 | `synthesizeArgs` bash ignored `step.args.command` | verify-phase bash prefers the hint; regress/execute stay frozen |
| 4 | toolGuidance did not pass compose's `[verify next]` into the chain | `verifyCommand` / `verifyTests` |

## Contract

- `planChain("run the tests")` on a JS project suggests `npm test`
- `planChain("verify src/lib.rs")` on mixed npm+cargo suggests `cargo test`
- `planChain("verify app.js")` on mixed npm+cargo suggests `npm test`
- `context.verifyCommand` wins over the focused guess
- 1-arg `detectTestCommand` on mixed still prefers `package.json` (frozen)
- DISCOVER still greps
- cold MODIFY/RECOVER still grep when playbook files are unknown
- regress step does not inherit the focused command
- EXECUTE bash does not inherit `verifyCommand`
- no invented `npm test --` flag
- the recommended command is never auto-run
- `compose` stays synchronous
- `~/.forge/tools` is never written
- `allowNewPlugins` stays false
- `classifyTaskComplexity()` unchanged
- `assumeYes` / `allowSudo` stay false
- Zero runtime npm dependencies
- Bundled `agentv19/forge/skills/` is never written

## Bigger map (not this release)

L6 kernel self-mod is explicitly out. World-model rewrite, Tree-sitter as
a runtime dep, edit-transaction rewrite stay explicitly out. A
compose-once cache (meta currently composes the snapshot more than once
per run) is a follow-on, not this layer.

## Non-goals

- Runtime npm dependencies (no Tree-sitter).
- A world-model rewrite / a second persisted graph file.
- A second mutating writer.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes` or `allowNewPlugins`.
- Patching `classifyTaskComplexity` / `plugin-host` / `securefs` / Ω kernel.
- Writing into `~/.forge/tools` or the bundled `agentv19/forge/skills/` pack.
- Auto-running the recommended / recorded command.
- Inventing CLI flags (`npm test -- file.test.js`).
- Changing 1-arg `detectTestCommand` (package.json still wins).
- Replanning MICRO/SMALL.
- Relaxing plugin-iso or fs-toctou tests.
- Adding new bundled skills.
- A compose-once cache in meta.js.
