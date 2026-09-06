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
| 3 | **Semantic retrieval** | embeddings-ranked context beyond BM25 keyword overlap | 1 |
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

### 2. LSP bridge — `lsp.js` (planned)
Zero-dep JSON-RPC to a language server the user already has installed. New
read-only tools: `definition`, `references`, `hover_type`, `diagnostics`,
`rename_symbol`; diagnostics feed the verification ledger. Closes the
code-understanding gap.

### 3. Semantic retrieval (planned)
Optional provider-embedding ranking added to `retrieval.js`, with BM25 kept as
the zero-config, offline-safe default (hybrid when embeddings are available).

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
