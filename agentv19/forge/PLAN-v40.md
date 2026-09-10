# PLAN v40 — language-aware engine (Forge v37)

Status: **shipped in v37.0.0.** After v36's graph-aware memory:
UNIFIED §6 — language, version, framework, package manager, compiler,
formatter, linter, typechecker, generated-code boundaries from files
that exist. LSP and compiler binaries are optional (present or
UNAVAILABLE). No Tree-sitter. Layer on `lang.js` / `lsp.js`. No kernel
rewrite.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v36
memgraph are unchanged. This layer sits on `langengine.js`.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH / v30 vision / v31 browser / v32 incremental
index + language adapters / v33 cross-language graph / v34 skill evaluator
+ plugin selector + integrator / v35 language-specific reasoning / v36
graph-aware memory invalidation, shellguard, netguard, securefs, plugin
isolation, the 9-check completion gate, `classifyTaskComplexity()` (frozen),
MICRO-only synthesise, TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS,
single-mutating-writer.

v37 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not add Tree-sitter. It does not invent `cargo`
in a repo with no `Cargo.toml`. It does not run `rustc --version`.

## What v37.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | `discoverToolchain` reports one test command, first ecosystem wins | `inspectProject`: mixed npm+cargo reports both stacks |
| 2 | Version / framework / pm guessed or omitted | read from `package.json` engines, `go.mod`, `Cargo.toml` edition, lockfiles |
| 3 | Missing compiler faked as available | `binaryOnPath`: `rustc UNAVAILABLE` when absent; never spawned |
| 4 | MICRO typo got a toolchain lecture | MICRO/SMALL → empty unless the task names a language |

## Contract

- `inspectProject(emptyDir).stacks` is `[]`
- `inspectProject(cargoDir)` includes `{ id: "rust", pm: "cargo", test: "cargo test" }`
- mixed npm+cargo reports both `javascript`/`typescript` and `rust`
- `inspectProject(npmDir)` pm is `pnpm` when `pnpm-lock.yaml` exists
- next in `dependencies` → `framework: "next"`
- `formatLangEngine(info, { task: "fix a typo in README" })` is `""`
- named rust on MICRO still formats rust
- `binaryOnPath("definitely-not-a-bin-xyz")` is `false`
- missing rustc → format contains `UNAVAILABLE`
- `discoverToolchain` 1-arg behaviour unchanged
- `classifyTaskComplexity()` unchanged
- `assumeYes` / `allowSudo` stay false
- Zero runtime npm dependencies
- `files[]` includes `langengine.js`

## Bigger map (not this release)

Shipped next: **v38.0.0 / PLAN-v41** (gap-fix: trailing-symlink writes,
generated-dir refuse, language-native HIGH TESTS). World-model rewrite,
Tree-sitter as a runtime dep, edit-transaction rewrite stay explicitly out.

## Non-goals

- Runtime npm dependencies (no Tree-sitter, no TOML parser package).
- A second mutating writer.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes`.
- Spawning compilers or LSP to scrape `--version`.
- Inventing `pytest` without pytest.ini / conftest / `[tool.pytest]`.
- Replanning MICRO/SMALL.
- Changing `discoverToolchain` / 1-arg `detectTestCommand`.
