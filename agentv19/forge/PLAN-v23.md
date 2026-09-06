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

**Deliberately deferred to the next PR:** wiring MCP tools into the agent loop.
Because they already arrive in plugin shape, that step reuses the existing
plugin choke point — output redaction, write-class serialization, read-only
sub-agent blocking, and registration into the capability registry — rather than
opening a second, unreviewed path to tool execution. Shipping the client first,
proven against a stand-in server (`test-mcp.mjs`, 26 checks), keeps the
security-sensitive integration a small, isolated, reviewable change.

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
