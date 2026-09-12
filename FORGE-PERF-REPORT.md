# FORGE — Performance Report

**Why is it slow, and what makes it faster WITHOUT damaging quality or intelligence.**
Repo: `hamahasan441-png/forge` · forge v88.0.0 · Node v22.22.3 (2-core sandbox) · Date: 2026-09-12
Method: everything below was **measured on this machine** (timings, CPU profiles, payload captures) — not guessed. Mock provider on localhost isolates forge's own overhead from provider latency.

---

## 1. Executive summary

Forge-the-CLI is not uniformly slow — **chat is fast, the agent loop is slow, and a few worst-case paths are very slow.** Ranked by real user impact:

| # | Finding | Impact | Evidence |
|---|---|---|---|
| 1 | **One graph traversal (`testsForFiles` + `neighbors` + `radiusOf`) eats ~60% of every agent run's CPU** — it's O(V×E) and runs ~40× per run (per tool verification, per compose) | every `forge agent` step pays ~1.2 s of pure CPU on a 400-file repo | CPU profile: 35% + 13% + 12.5% of a 1.4 s run |
| 2 | **Agent requests carry a fixed 15.4 KB (~4 k tokens) payload every step** (system prompt + context blocks + 19 tool schemas) | multiplies real provider latency & cost per step; dominates real-world agent time | capture server: chat turn = 747 B, agent turn = 15 415 B |
| 3 | **CLI startup tax 178 ms** — the full ~40-module import graph (chat, agent, tools, TUI, render, uistate…) + undici preload loads even for `forge version` | every command, every e2e call, every scripted loop | `forge version` 218 ms vs bare node 40 ms |
| 4 | **A dead provider can stall ~94 s before failover** (connect guard 30 s × 3 attempts + backoff) | the "it hangs forever" feeling | providers.js defaults |
| 5 | **Dev loop is sleep-bound and sequential**: `npm test` 135 s, fast lane 85 s, `ui` suite alone 42–86 s with **47.2 s of scripted `sleep`s**; the runner runs 131 suites one-by-one | slows every change you make | run-all.mjs + test-ui.mjs counts |

**The single biggest product win is #1** — a pure data-structure fix (adjacency index + memoization) that changes zero behavior. It's also the safest: identical results, just computed in O(V+E) instead of O(V×E).

---

## 2. Measured baseline (all numbers from this machine)

| Measurement | Result |
|---|---|
| Bare `node -e ""` (10-run avg) | 40 ms |
| `forge version` (10-run avg) | **218 ms** |
| `forge --help` (10-run avg) | 222 ms |
| `import('./chat.js')` cold (full static graph) | 110 ms |
| Chat boot + 1 turn + exit (mock provider, 5-run avg) | **326 ms** |
| `forge ask` one-shot (mock, 5-run avg) | 337 ms |
| **`forge agent` 1 tool turn (mock, 5-run avg)** | **1 799 ms — 5.5× a chat turn** |
| Agent runs 1→4 with the SAME `~/.forge` (warm cache) | 1.45 / 1.61 / 1.65 / 1.76 s — **no warm speedup** |
| `buildCrossGraph` on this repo | 190 ms — 400 files, 1 429 edges, **165 of 400 files are bundled `skills/` scripts** |
| `testsForFiles(all files)` once, isolated | 13 ms — but invoked ~40× per agent run |
| Chat turn request payload | 747 B |
| **Agent turn request payload** | **15 415 B (~4 k tokens), 2 messages** |
| Skills indexing (80 skills) | 21 ms — **not** a problem |
| Warm code index reuse | works: `reused: 400, parsed: 0` — **not** a problem |
| `npm test` full / `FORGE_FAST=1` | ~135 s / ~85 s |
| `ui` suite | 42 s (of which **47.2 s of scripted waits** across runs — it is sleep-bound) |
| Cleanroom cold start (installed CLI) | ~129 ms |

### CPU profile of one agent run (1 436 ms sampled)

```
 39%  testsForFiles   @ xlang.js:314   ← graph traversal, ~40 invocations/run
 13%  neighbors       @ xlang.js:301   ← linear scan over ALL edges per visited node
12.5% radiusOf        @ memgraph.js    ← same linear pattern, 154 hits
  3%  garbage collector (traversal garbage)
  2%  ESM compile (startup)
  1.4% spawnSync / readFileSync (verify `node --check`, config)
  hot regexes: SQL FROM/JOIN, gRPC rpc/service, fetch/axios — language adapters
```

---

## 3. Root causes, explained

### RC1 — O(V×E) graph traversal, repeated per tool call (THE big one)

`xlang.neighbors()` finds a node's edges by **scanning the entire edge list** (1 429 edges) for every node it visits. `testsForFiles()` visits up to all 400 nodes → ~570 k edge checks per call. And it is not called once:

- `verify.js` → `focusedVerify()` → `testsForFiles()` — runs **per tool verification** (`tools.verify` default ON — this is the feature that keeps the agent honest)
- `impact.js` → `testsForFiles()` — impact/test-scope analysis
- `memgraph.radiusOf` (compose/world snapshot) — same linear pattern

One simple agent run = ~40 traversals ≈ 1.2 s of CPU. In `forge agent --auto` (segments × nodes × verify + repair loops) this multiplies further. **The warm file-parse cache does not help because the traversals — not the parsing — dominate.** That's why runs 1→4 showed no speedup.

### RC2 — 15.4 KB fixed payload per agent step

Every agent request re-sends: full system prompt (tool rules, read-only policy, terminal contract), compose/world snapshot, skills picks, memory + learnings blocks, repo-map, and 19 JSON tool schemas. On a real provider this is ~4 k prompt tokens **per step** — at 20 steps that's ~80 k tokens of pure preamble processing, which is both latency and cost. Chat turns, by contrast, are 747 B.

### RC3 — 178 ms startup tax on every invocation

`forge.js` statically imports the chat REPL, agent engine, tools, TUI stack, skills, providers… regardless of subcommand. CPU profile of `forge version`: ~50% ESM module resolution/compile of the whole graph, ~8% undici (fetch machinery) preload. Trivial per call — but it multiplies across e2e (hundreds of `forge` invocations = tens of seconds of the 107 s e2e suite) and any scripted use.

### RC4 — worst-case retry policy

Defaults: `attempts: 3`, `backoffMs: 1500` (×attempt), **`connectMs: 30000`**. A provider that accepts TCP slowly or blackholes: 30 s guard → retry → 30 s → retry → 30 s ≈ **94 s** before the failover chain even gets a chance. `ECONNREFUSED` is instant (fine); the silent-drop case is the killer. This is the "forge hangs doing nothing" experience.

### RC5 — the dev loop (why iterating on forge itself is slow)

- `run-all.mjs` executes 131 node suites **sequentially** (one `spawn` at a time).
- `test-ui.mjs` contains **47.2 s of hardcoded `wait` sleeps** — it measures wall-clock patience, not the product.
- e2e spawns `forge` hundreds of times → each pays RC3's 178 ms.

### Measured NON-problems (so we don't "fix" what works)

- ✅ Autopick at boot: reads the health **cache** only — zero network probes at startup.
- ✅ Compaction: v2+ extracts a deterministic ledger locally — **no extra model call**.
- ✅ Warm code index: file parsing is properly mtime-cached (`reused: 400, parsed: 0`).
- ✅ Skills indexing: 80 skills in 21 ms.
- ✅ Chat turn overhead: ~100 ms over bare startup.

---

## 4. The speed plan — fastest wins that cost ZERO quality or intelligence

Every item below is behavior-preserving: same outputs, same checks, same honesty. Ordered by win/effort.

### P0-1 — Adjacency index for the cross-language graph ⭐ (biggest product win)
Replace the linear edge scan in `xlang.neighbors()` with a prebuilt `Map<node, {in[], out[]}>` (built once per graph), and memoize `testsForFiles` / `radiusOf` results keyed by `(graph fingerprint, file set)` — the graph is immutable within a run, and the code index already tracks mtime fingerprints for invalidation.
**Win:** ~60% of agent-step CPU → agent step 1.8 s → **~0.7–0.9 s** on this repo; bigger repos benefit more (O(V×E) → O(V+E)).
**Quality safeguard:** pure data structure — results are byte-identical; existing suites (`xlang`, `impact`, `verify`, `v33`, `v38`) must pass unchanged, plus one new perf-regression test (traversal on a 1 000-file synthetic graph under N ms).

### P0-2 — Compute the graph once per run, share it
`focusedVerify`, `impact`, and `compose` each re-derive/re-walk. Build the cross-graph **once per agent run** (it already lives behind `composeOnce` caching for identical args — extend the same snapshot to verification/impact), invalidating on writes via the existing ledger.
**Win:** removes the remaining repeated work after P0-1; keeps verify-per-tool-call honesty intact.

### P1-1 — Lazy-load subcommand deps in `forge.js`
Convert the static imports of `chat/agent/agentview/tools/uistate/terminal/render/plugins…` to dynamic `import()` inside the `case` branches that need them (`version`, `models`, `sessions`, `undo`, `config get`… don't need the REPL or the TUI). Also defer the undici/fetch preload to first network use.
**Win:** `forge version`-class commands 218 ms → **~80–100 ms**; e2e suite sheds ~15–25 s.
**Quality safeguard:** purely mechanical lazy-loading; every subcommand still exercised by e2e.

### P1-2 — Fail fast on silent-dead providers
Keep 3 attempts for `429/5xx` (honoring Retry-After — already correct), but: drop `connectMs` 30 s → **8 s**, and on `ETIMEDOUT`/connect-guard expiry go **straight to the next provider in the failover chain** instead of retrying the same one twice more.
**Win:** worst-case dead-provider stall 94 s → **≤ 20 s**. Resilience against transient errors unchanged.
**Quality safeguard:** retry semantics for real transient errors (429, 5xx, network blip) untouched.

### P1-3 — Prompt economy (per-step payload 15.4 KB → ~8–10 KB)
- Deduplicate blocks that repeat verbatim every step (tool-schema JSON is unavoidable per request, but static system sections can be shortened without losing rules).
- Cap the repo-map block (currently uncapped contribution) and the compose block per step.
- Where the provider supports it (Anthropic, GitHub Models, OpenAI automatic), mark the stable prefix for **prompt caching** — same tokens, billed/cached once, lower TTFT.
**Win:** real-provider per-step latency & cost drop noticeably (prompt processing ∝ tokens); at 20 steps this is the largest *real-world* saving.
**Quality safeguard:** relevance-ranked content stays (memory, lessons, skills picks are already relevance-selected — keep them); only true duplication/static boilerplate is trimmed or cached. Add a token-count assertion test so the prompt can't silently shrink below an information floor.

### P2-1 — Test-loop speed (developer experience)
- Run the 131 node suites with **concurrency 4–8** in `run-all.mjs` (they're independent; keep the two port-binding bash suites sequential).
- Replace `test-ui.mjs`'s fixed sleeps with the existing `waitfor`-pattern (event-driven waits) where possible.
**Win:** `npm test` 135 s → **~50–60 s**; fast lane 85 s → **~30 s**.
**Quality safeguard:** zero assertion changes; a concurrency knob (`FORGE_TEST_CONCURRENCY=1` restores today's behavior) and CI verification on both lanes.

### P2-2 — Calibration checks (measure before changing)
- `profile: "auto"` → deep: verify the complexity classifier isn't over-triggering deep reasoning (deep = slower generation). Tune only with the bench (`forge bench`) as gatekeeper — the bench exists exactly for this.
- `fanoutWaitMs` 4–8 s: confirm the early-return race actually fires on fast workers.
- Worker clamp 2–8 (v88): on ≥8-core machines confirm `--auto` actually fans out to 8 (the reward for the clamp change).

---

## 5. What NOT to do (would damage quality/intelligence)

These are the tempting "speedups" that would make forge dumber — explicitly rejected:

1. **Don't skip or batch-away per-tool verification** (`tools.verify`) — it's ~40 traversals precisely because it checks every write; fix the traversal cost (P0-1), never the checking.
2. **Don't drop memory / lessons / skills picks from the prompt** — that's the accumulated intelligence; trim duplication only.
3. **Don't cache graph/traversal results across file changes without invalidation** — stale test-mapping = fake green tests. The mtime ledger invalidation must stay the source of truth.
4. **Don't reduce repair/replan budgets or maxSegments** — the completion gate's honesty is the product's core value.
5. **Don't disable streaming** (`chat.stream: true`) — it's what makes turns *feel* fast; latency wins come from prompt economy, not buffering.
6. **Don't parallelize mutating tools** — the single-writer rule is a correctness guarantee, not a performance knob.

---

## 6. Expected end-state after P0+P1

| Metric | Today | After |
|---|---|---|
| `forge agent` step overhead (mock, this repo) | 1.8 s | **~0.6–0.9 s** |
| `forge version` / light commands | 218 ms | **~80–100 ms** |
| Worst-case dead-provider stall | ~94 s | **≤ 20 s** |
| Agent payload per step | 15.4 KB | **~8–10 KB** (+ prompt caching where available) |
| `npm test` full | 135 s | **~50–60 s** |
| Chat turn overhead | ~100 ms | unchanged (already fine) |

*Reproduce every number: mock provider (`node tests/mock-llm.mjs`), the config from §2, `time` loops, `node --cpu-prof`, and the 20-line capture server used for payload sizes.*
