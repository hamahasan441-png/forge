# PLAN v36 — cross-language graph (Forge v33)

Status: **shipped in v33.0.0.** First UNIFIED leftover after v32 index +
adapters: §7 treat a real stack as one system
(`TypeScript → HTTP API → Python → SQL → Docker → CI`), plus a small §19
slice (pick tests from those edges; skip unchanged greens only when a
ledger is supplied). Layer on the v32 index. No kernel rewrite.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v32
index are unchanged. This layer sits on `index.js` / `lang.js` /
`repomap.js`.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH / v30 vision / v31 browser / v32 incremental
index + language adapters, shellguard, netguard, securefs, plugin isolation,
the 9-check completion gate, `classifyTaskComplexity()` (frozen), MICRO-only
synthesise, TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS,
single-mutating-writer.

v33 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not add Tree-sitter. It does not fake a skipped
test (no ledger → skip nothing).

## What v33.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | Imports and symbols stop at one language | `xlang.js`: contracts (route / table / proto / OpenAPI / Docker / CI) + IMPLEMENTS / CONSUMES / TEST / DEPLOY edges |
| 2 | Edits do not know cross-language consumers | `buildCrossGraph` on the v32 index (unchanged files not re-read). `formatCrossGraph` in the context engine |
| 3 | Tests re-run blindly | `testsForFiles` follows graph edges. `skipUnchangedTests` only with an explicit ledger (size+mtime of the test and its imports) |
| 4 | `impactRadius` re-read up to 400 files | uses the cross-graph when it connects; string-scan fallback if the graph misses |

## Contract

- `extractContracts("a.ts", 'app.get("/api/users", f)')` includes `{ kind: "route", name: "/api/users" }`
- `{id}` and `:id` normalize to the same route key
- TS `app.get("/users")` + Py `@app.get("/users")` → IMPLEMENTS edge
- `fetch("/users")` + producer route `/users` → CONSUMES edge
- `testsForFiles([util.js], graph)` includes `util.test.js` via IMPORT
- `skipUnchangedTests(tests)` with no ledger → `skip === []`
- `impactRadius` on the omega fixture still finds `app.js` and `util.test.js`
- `classifyTaskComplexity()` unchanged
- `assumeYes` / `allowSudo` stay false
- Zero runtime npm dependencies
- `files[]` includes `xlang.js`

## Bigger map (not this release)

World-model rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite
stay explicitly out.

## Non-goals

- Runtime npm dependencies (no Tree-sitter, no OpenAPI parser package).
- A second mutating writer.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes`.
- Skipping tests without a ledger.
- Replanning MICRO/SMALL.
- Replacing `impactRadius` string-scan when the graph does not connect.
