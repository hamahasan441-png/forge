# PLAN v23 — Toward best-in-class: reaching "big agent" parity

Status: **in progress.** This document is the roadmap and the delivery ledger.
It follows the v20.5/v21 layers (tool intelligence, capability router,
verification, recovery, DAG, model strategy, agent manager) — which already make
forge a disciplined autonomous agent — and targets the specific capabilities
that still separate it from the largest agents (Claude Code, Cursor, Codex,
Devin).

## Where v21 already stands

forge is not starting from zero. It already has, and this plan does **not**
rebuild:

- an orchestration brain (`meta.js`): PLAN → DISCOVER → DAG → SELECT MODEL →
  EXECUTE → OBSERVE → CHECKPOINT → VERIFY → CONTINUE, with DIAGNOSE → REPAIR on
  failure and RECOVER → RECONCILE → RESUME on interrupt; a task always reaches a
  terminal state.
- a deterministic tool-intelligence pipeline: capability registry → router →
  policy gate → safety → execute → verify → recover.
- discipline the big agents charge for: risk-classified shell, project-boundary
  writes, secret redaction, checkpoint/undo, a verification ledger, effect
  reconciliation, a failure taxonomy, a per-role read-only worker pool, model
  strategy and provider failover, and a full TUI.

## The gaps this plan closes

Confirmed absent in the v21 tree (zero references), ordered by leverage:

| # | Gap | Why it matters | Tier |
|---|---|---|---|
| 1 | **MCP client** | the industry-standard extensibility layer; unlocks a whole ecosystem of external tools/data | 1 |
| 2 | **LSP bridge** | real code understanding — go-to-def, references, hover types, diagnostics, rename — vs. regex repo-map | 1 |
| 3 | **Semantic retrieval** ✅ | embeddings-ranked context beyond BM25 keyword overlap — delivered below | 1 |
| 4 | **Vision / multimodal** | act on screenshots, diagrams, failing-UI captures | 2 |
| 5 | **Browser tool** | drive and verify real UIs | 2 |
| 6 | **Sandbox execution** | isolation on top of (never replacing) shellguard | 2 |
| 7 | **Benchmark harness** | make "is it a good agent?" a number you can move | 3 |

Design constraints, unchanged: **zero runtime dependencies, direct-to-provider,
security-first, deterministic where possible.** Each gap below is closed in a
way that honours them.

## Tier 0 — finish what v22 started (cheap)
- Learned per-project routing preferences (persist routing outcomes in memory).
- More verification ecosystems (`tsc --noEmit`, `python -m py_compile`) when the
  project already provides them.
- Cross-run cost accounting; router explanations surfaced in the TUI.

## Tier 1 — the parity movers

### 1. MCP client — `mcp.js`  ✅ delivered (this PR)
A zero-dependency Model Context Protocol client (stdio, newline-delimited
JSON-RPC 2.0): initialize handshake, `tools/list`, `tools/call`, per-request
timeouts, clean shutdown, best-effort multi-server load. Servers are configured
under `mcp.servers` (OFF by default) and launched from **config only, never
model output** — the same trust model as local plugins.

`mcpToolsToPlugins()` adapts a server's tools into the exact object shape
`plugins.js` already produces (`{ name, readOnly, def, run, source }`), tool
names namespaced `mcp__<server>__<tool>` so they can never shadow a built-in,
and treated as WRITE-class by default (the protocol does not reliably declare
side-effect freedom, so we assume the unsafe case). `forge mcp [list|tools|test
<name>]` inspects servers from the shell.

**Agent-loop wiring (delivered).** MCP tools are loaded at the top of a run
(never for a delegated read-only sub-agent — that would re-spawn servers, and
MCP tools are write-class so they are blocked there anyway) and joined to the
`plugins` array, so they flow through the EXACT existing plugin path:
`makeToolContext` for the defs, the capability registry (`registerPlugins`
classes them WRITE / verification-required), and the policy gate + safety engine
for execution. No second execution path. Servers are shut down in a `finally`
on every exit (success, failure, cancellation), gracefully (stdin close) with a
SIGKILL fallback, so a run never leaks a child process. `test-mcp.mjs` (30
checks) proves this end-to-end: the real `runAgent` invokes an MCP tool, the
result flows back, and the server is confirmed shut down.

**Still deferred (a follow-up):** the interactive `chat.js` tool loop. It calls
`process.exit()` at session end and has several exit paths, so a correct
MCP-server lifecycle there needs its own synchronous-cleanup handling and can't
be integration-tested in-process the way the agent loop can. Rather than ship
untested process-management code into the interactive path, it is a separate
change. Autonomous runs (`forge agent`, the meta controller, delegates, plan
mode) — where MCP tools matter most — are fully covered.

### 2. LSP bridge — `lsp.js`  ✅ client delivered (PR #12); agent tools next
Zero-dependency JSON-RPC client over the LSP stdio transport (Content-Length
framing, byte-accurate): initialize handshake, document sync (`didOpen`),
`textDocument/definition` · `references` · `hover`, server-pushed
`publishDiagnostics` captured and awaitable, and a polite `shutdown`/`exit` with
a SIGKILL fallback. Servers are configured per language under `lsp.servers`
(OFF by default), resolved by file extension, launched from config only —
read-only, since a language server observes code, never mutates it.
`forge lsp [list|test <file>]` resolves the server for a file, opens it, and
prints real diagnostics. `test-lsp.mjs` (25 checks) proves it against a stand-in
language server, including byte-accurate framing on a multi-byte document.

**Agent tools (delivered).** `lsp_definition`, `lsp_references`, `lsp_hover`,
`lsp_diagnostics` — read-only, plugin-shaped — over a per-run session manager
that lazily starts one language server per language, keeps documents synced with
the file on disk (so results reflect edits the agent just made), and is closed
with the run. They flow through the same plugin path and capability registry as
every other tool, and are wired into `agent.js` end-to-end (`test-lsp.mjs`, 41
checks, includes the real `runAgent` calling `lsp_diagnostics` and the server
being shut down afterward). Symbol-based tools locate the identifier's first
word-boundary occurrence, so the model passes a name, not a line/column.

**Still open:** feeding diagnostics automatically into the verification ledger
(running `lsp_diagnostics` on changed files as part of the post-write gate). The
tool makes the evidence available now; the automatic gate hook is a separate
change so it can be designed against `verifyledger.js` without widening this PR.

### 3. Semantic retrieval — `embeddings.js` + `retrieval.js` hybrid  ✅ delivered (this PR)
Provider-embedding ranking added on top of BM25, with BM25 kept as the
zero-config, **offline-safe default**. The design rule that makes it safe:
**embeddings only ever REORDER the BM25 shortlist — they never widen it.**
So a dead/offline/wrong embeddings endpoint degrades to exactly the v20.2
BM25 result, and a corrupt cache is treated as empty. Every failure path
(HTTP error, malformed vectors, timeout, throw) falls back to BM25 —
semantic retrieval can never break retrieval.

- `embeddings.js`: zero-dep OpenAI-compatible `/embeddings` client
  (`requestEmbeddings` — batching, one transient retry, request-timeout guard,
  hard payload validation) + a sha1-keyed JSON disk cache under `~/.forge/cache`
  (atomic tmp+rename writes, pruned to `cacheMaxEntries`, model-change aware),
  and `createEmbedder()` (cache-first, eager persist, aligned output, stats).
  `resolveEmbeddingsConfig()` resolves provider/model/key/baseUrl from
  `retrieval.embeddings` + catalog + env, refuses Anthropic (no embeddings
  endpoint) rather than guessing, and is OFF unless `enabled: true`.
- `retrieval.js`: `rankDocsHybrid(query, docs, { embed, alpha, budgetMs })`
  fuses min-max-normalized BM25 and cosine scores
  (`fused = (1-α)·bm25 + α·semantic`, negative cosine clamped to 0). Pure +
  deterministic given an `embed` fn; tagged `hybrid` / `bm25` /
  `bm25-fallback` / `bm25-timeout` so callers can see which path ran.
- **Wiring:** `memory.js` (`relevantMemoryAsync` / `relevantLearningsAsync`),
  `context.js` (`buildAsync` / `rankAsync` — no embedder ⇒ the exact sync BM25
  path), `agent.js` (precomputes the hybrid memory/learnings block for the
  system prompt; delegated read-only sub-agents stay on BM25) and `meta.js`
  (context engine gets an embedder; `RETRIEVAL_MODE` event). New
  `forge embeddings [list|test <text>...]` inspects config/cache/live latency.
- `test-semantic.mjs` (83 checks) proves: fusion ordering across alpha,
  graceful fallback on throw/timeout/malformed/ragged, cache round-trip +
  prune + corruption, config resolution (defaults, clamps, anthropic refusal,
  env key), the client against a local mock server (batching, retry, 401,
  malformed, timeout), the memory/context async wiring, and — end-to-end —
  the real `runAgent` calling a real `/embeddings` endpoint, the system prompt
  carrying the reranked memory, and **zero embeddings traffic when disabled**.

**Still open:** embedding the repo-map / file snippets (hybrid currently covers
memory + learnings, the highest-value injected slices), and rerank of
`lessons.js`. Both reuse `rankDocsHybrid` unchanged when scheduled.

## Tier 2 — reach & robustness
4. Vision/multimodal message parts + a `read_image` tool.
5. An opt-in `browser` capability that degrades gracefully when absent.
6. Opt-in sandboxed `bash` (bwrap/container when present), atop shellguard.
7. DAG-aware read-only worker fan-out beyond 2, single-mutating-writer intact.

## Tier 3 — intelligence & self-improvement
8. FORGE-BENCH: a repeatable eval harness scored by the verification gate.
9. Deeper learning loop feeding `lessons.js` back into planning.
10. Mid-task re-planning from verification evidence, not just repair.

## Delivery ledger
- **v23.0 — MCP client (`mcp.js`) + `forge mcp` + `test-mcp.mjs`.** Client and
  adapter only; agent-loop tool injection is the next PR. Zero dependencies; no
  existing tool, security control, event or CLI contract changed.
- **v23 Tier 1: MCP — client + agent-loop integration** (merged). Agent-loop
  wiring from §1.1, incl. shutdown-in-finally and the 30-check e2e.
- **v23 Tier 1: LSP — client + agent tools** (merged). §1.2: client +
  `lsp_definition/references/hover/diagnostics` over a per-run session manager.
- **v23.1 — Semantic retrieval (`embeddings.js` + `retrieval.js` hybrid).**
  §1.3 as delivered above: embeddings client + disk cache, `rankDocsHybrid`,
  async memory/learnings rerank wired through context engine, agent loop and
  meta controller, `forge embeddings` CLI, 83-check suite. BM25 remains the
  default; embeddings reorder BM25 shortlists only; disabled by default.
- **v23.1.1 — audit of the semantic layer (4 defects fixed, each with a
  regression test; suite 83 → 93 checks).**
  1. `forge embeddings test --json` printed human lines before the JSON —
     violates the repo's "--json = exactly one JSON document" contract
     (test-json.mjs). Now pure JSON; the contract check is pinned there.
  2. `rankDocsHybrid` carried the doc index under the string key `__ri` — a
     caller doc with its own `__ri`/`_i` field could corrupt the score mapping.
     Now a symbol-keyed tag (collision-proof; pinned by test).
  3. The context engine's memory cache key ignored `precision` — a precise
     build could be served the normal-precision slice (limit 10 where 6 was
     asked) and vice versa. Latent since v21; the key now carries precision on
     both the BM25 and the hybrid paths (pinned by test).
  4. Switching the embedding model cleared stale cache vectors but kept the
     stale `dim`. Both reset now (pinned by test).

  Verified-not-bugs during the audit: the budget-timeout race already absorbs
  late embed rejections (`Promise.race` attaches handlers to both promises —
  proven empirically, now pinned by a regression test, since an unhandled
  rejection crashes Node ≥15); `forge config set ... enabled true` stores a
  real boolean via `coerce()`; `agentview` ignores unknown event types
  (`RETRIEVAL_MODE` safe); no API key ever reaches CLI output or error
  strings; the embeddings endpoint is config-only (same trust model as
  provider baseUrl). Accepted by design: two embedders alive in one run
  (meta + agent) persist last-writer-wins cache snapshots — an entry may be
  evicted and re-embedded; the cache is a speedup, never a correctness
  dependency.
