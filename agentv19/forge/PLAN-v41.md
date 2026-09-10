# PLAN v41 — gap-fix layer (Forge v38)

Status: **shipped in v38.0.0.** After v37's language-aware engine: close
real holes, not a UNIFIED rewrite. Trailing-symlink writes with
`allowOutsideProject` must not follow a host link onto `/etc/hostname`.
Generated dirs listed in the engine dump are refused as write targets.
`verificationPlan` HIGH TESTS recommends the inspectProject-native
command for the file's language. No kernel rewrite.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v37
langengine are unchanged. This layer sits on `tools.js` / `securefs.js`
/ `langengine.js` / `verify.js`.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH / v30 vision / v31 browser / v32 incremental
index + language adapters / v33 cross-language graph / v34 skill evaluator
+ plugin selector + integrator / v35 language-specific reasoning / v36
graph-aware memory invalidation / v37 language-aware engine, shellguard,
netguard, securefs, plugin isolation, the 9-check completion gate,
`classifyTaskComplexity()` (frozen), MICRO-only synthesise,
TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS, single-mutating-writer.

v38 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not add Tree-sitter. It does not weaken
plugin-iso or fs-toctou assertions. It does not invent a test command.

## What v38.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | `allowOutsideProject` realpath'd a trailing symlink onto `/etc/hostname` | `resolveWriteAnchor`: follow trailing symlink only when dest is in-project; otherwise pass the logical name so `atomicWriteInDir` throws ESYMLINK |
| 2 | Engine listed `dist`/`.next`/`target`/`node_modules` but writes still landed there | `generatedBoundary` in `safePath` write; `ctx.allowGeneratedWrites` opts out |
| 3 | HIGH TESTS said "run the focused test" even on mixed npm+cargo | `verificationPlan.command = recommendedVerify(cwd, files)` — rust file → `cargo test` |

## Contract

- write to `OUT/hostlink` → `/etc/hostname` with `allowOutsideProject: true` leaves hostname unchanged and returns ERROR (or replaces the link, never the host file)
- in-project file symlink (`alias.txt` → `src/real.txt`) still writes the real file
- `generatedBoundary(abs, cwd)` is `"dist"` for `dist/bundle.js`, `""` for `src/app.js` and for a file named `dist.js`
- `write_file` into `dist/` / `node_modules/` / `.next/` / `target/` is ERROR unless `allowGeneratedWrites`
- `recommendedVerify(mixed, ['src/lib.rs'])` is `cargo test`
- `recommendedVerify(mixed, ['app.js'])` is `npm test`
- `recommendedVerify(empty)` is `''`
- HIGH `verificationPlan` for a rust write in a mixed repo has `command: "cargo test"`
- 1-arg `detectTestCommand(mixed)` stays `npm test`
- plugin-iso assertions are unchanged (Node 22 has no `--allow-net`; not this layer)
- `classifyTaskComplexity()` unchanged
- `assumeYes` / `allowSudo` stay false
- Zero runtime npm dependencies

## Bigger map (not this release)

§4 semantic world model beyond the v32 index (still no Tree-sitter
runtime dep). Edit-transaction rewrite stays explicitly out.

## Non-goals

- Runtime npm dependencies (no Tree-sitter).
- A second mutating writer.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes`.
- Relaxing plugin-iso or fs-toctou tests to make reds green.
- Changing `discoverToolchain` / 1-arg `detectTestCommand`.
- Replanning MICRO/SMALL.
- Replacing a trailing outside symlink by following it.
