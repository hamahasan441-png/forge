# PLAN v35 — incremental code index + language adapters (Forge v32)

Status: **shipped in v32.0.0.** First UNIFIED leftover after PLAN-v24 was
empty: §23 persist an incremental code index so unchanged files are not
re-read, and §32 grow language coverage without Tree-sitter as a runtime
dep. Faster on a 13T Pro. Smarter polyglot map. No kernel rewrite.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst, v29
experiments, v30 vision, v31 browser are unchanged. This layer sits on
`repomap.js`.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH / v30 vision / v31 browser, shellguard,
netguard, securefs, plugin isolation, the 9-check completion gate,
`classifyTaskComplexity()` (frozen), MICRO-only synthesise,
TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS, single-mutating-writer.

v32 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not add a runtime parser. It does not fake a
cache hit (sandbox.js lesson).

## What v32.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | Every `buildRepoMap` re-read up to 400 files | `index.js`: size+mtime fingerprint, persist `~/.forge/projects/<hash>/index.json` via `writeStateFile`. Unchanged files reused. `FORGE_INDEX=0` disables |
| 2 | Symbols only for JS/PY/GO/RS | `lang.js`: adapters (Java, Kotlin, Ruby, PHP, C/C++, C#, Swift, Dart, Zig, Elixir, Shell, SQL, Terraform, Docker, Make, …). Unknown language discovered, not refused. JS/PY/GO/RS regexes frozen |
| 3 | Test command invented only for npm/pytest/go/cargo/make | `discoverToolchain` + `detectTestCommand`: Gemfile / composer / pom / gradle, still `test \|\| build` so npm-build-as-test is unchanged |

## Contract

- `detectLanguage("Foo.java").id === "java"`
- `detectLanguage("a.ts").family === "js"`
- `jsSymbols("export function alpha(){}")` includes `alpha` (byte-stable v23)
- `extractSymbols("A.java", "class Foo {}\n")` includes `Foo`
- second `buildRepoMap` on an unchanged tree: `getIndexStats().parsed === 0` and `reused > 0`
- touch one file → `parsed === 1`
- `FORGE_INDEX=0` → always parse, never persist, never a fake hit
- corrupt / wrong-version `index.json` → empty index, never a throw
- `cacheHit` requires `Array.isArray(symbols)` (fingerprint alone is not a hit)
- `detectTestCommand(emptyDir) === ""`
- `detectTestCommand` with `scripts.test` → `npm test`
- `detectTestCommand` with only `scripts.build` → `npm run build`
- `tools.assumeYes` / `allowSudo` stay false
- `classifyTaskComplexity()` is unchanged
- Zero runtime npm dependencies
- `files[]` includes `lang.js` and `index.js`

## Bigger map (not this release)

Shipped next: **v33.0.0 / PLAN-v36** (cross-language graph, UNIFIED §7 +
§19 test selection). World-model rewrite, Tree-sitter as a runtime dep,
edit-transaction rewrite stay explicitly out.

## Non-goals

- Runtime npm dependencies (no Tree-sitter, no language-server package).
- A second mutating worker.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes`.
- Hashing every file (mtime+size is the phone-speed fingerprint).
- Re-reading extensionless shebang files on every walk.
- Replanning MICRO/SMALL.
- Faking a cache hit when `FORGE_INDEX=0` or the record has no symbols array.
