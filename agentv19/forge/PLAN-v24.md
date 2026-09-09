# PLAN v24 — After the loops closed

Status: **roadmap.** v21.2 closed the leftover loops from PLAN-v23 that were
already in the tree but not wired: MCP in the interactive chat loop, LSP
diagnostics feeding the verification ledger, and the audit-2 leftovers
(interpreter eval consent, same-run plugin quarantine, plugin grant
symlink refusal). This document is what remains — and what must not be
rebuilt.

## Where v21.2 stands

forge already has, and this plan does **not** rebuild:

- MCP client + agent-loop wiring + **chat-loop wiring** (`loadChatPlugins` /
  `closeChatPlugins`, stdin-close + SIGKILL fallback on every exit path).
- LSP client + agent tools + **automatic SYNTAX evidence**
  (`collectDiagnosticsForFiles` → verification ledger after a mutating
  segment). Off when `lsp.servers` is empty.
- Plugin isolation in a child process (v21.1) + **same-run quarantine**
  (`startedAt`) + **symlink-escaping plugin files / grants refused**.
- Inline interpreter eval (`node -e` / `python -c` / …) classified `danger`
  unless `tools.allowInterpreterEval` (user config only). Script-file
  execution stays `low`.
- Semantic retrieval (BM25 default; embeddings reorder the shortlist only).
- The orchestration brain, shellguard, securefs, DNS-pinned fetch, secret
  redaction, project-config privilege strip.

Design constraints, unchanged: **zero runtime dependencies, direct-to-provider,
security-first, deterministic where possible. Safety is never softened to
make a demo pass.**

## What this plan closes (ordered by leverage)

| # | Gap | Why it matters | Tier |
|---|---|---|---|
| 1 | **Hybrid repo-map** | embeddings currently rerank memory + learnings; file snippets / repo-map still BM25-only | 1 |
| 2 | **Lessons rerank** | `lessons.js` is not yet passed through `rankDocsHybrid` | 1 |
| 3 | **Vision / multimodal** | act on screenshots, diagrams, failing-UI captures | 2 |
| 4 | **Browser tool** | drive and verify real UIs; opt-in, degrades when absent | 2 |
| 5 | **Sandbox execution** | bwrap/container when present, *atop* (never replacing) shellguard | 2 |
| 6 | **DAG worker fan-out** | read-only workers beyond 2; single-mutating-writer intact | 2 |
| 7 | **FORGE-BENCH** | a repeatable eval harness scored by the verification gate | 3 |
| 8 | **Deeper learning loop** | feed `lessons.js` back into planning, not just repair | 3 |
| 9 | **Mid-task re-plan** | re-plan from verification evidence, not just repair | 3 |

## Tier 1 — finish the retrieval surface

### 1. Hybrid repo-map / file snippets
`rankDocsHybrid` is already the fusion primitive. The repo-map and the
file-snippet shortlist that land in the system prompt are still BM25.
Same contract: embeddings only REORDER, never widen; a dead endpoint
degrades to the v21 BM25 result. `test-semantic.mjs` grows; no new
retrieval library.

### 2. Lessons rerank
`lessons.js` retrieval is BM25. Pass the same hybrid path the context
engine already uses for memory/learnings. No schema change.

## Tier 2 — reach

3. Vision/multimodal message parts + a `read_image` tool. Config-only
   (provider must actually accept image parts); never a new runtime dep.
4. Opt-in `browser` capability. Absent binary → tool reports unavailable,
   does not crash the turn.
5. Opt-in sandboxed `bash` (bwrap / bubblewrap / container when present).
   Shellguard remains the classifier; the sandbox is a process boundary
   on top. No fake sandbox when the runtime cannot provide one — the
   plugin-isolation lesson.
6. DAG-aware read-only worker fan-out beyond 2, single-mutating-writer
   intact.

## Tier 3 — intelligence

7. FORGE-BENCH: a repeatable eval harness scored by the verification
   gate, not by "the model said it worked".
8. Deeper learning loop feeding `lessons.js` back into planning.
9. Mid-task re-planning from verification evidence.

## Non-goals (still)

- Runtime npm dependencies.
- Softening shellguard / netguard / securefs / plugin isolation to make
  a benchmark green.
- MCP / LSP servers from model output or from project `forge.config.json`.
- In-process plugins on Node without a permission model.

## Delivery ledger

- **v21.2.0 — close the loops.** MCP in chat; LSP → verification ledger;
  interpreter-eval consent; same-run plugin quarantine; plugin/grant
  symlink refusal. Unreleased v21.1 security perimeter ships in the same
  bump. Tests: `test-v21-2.mjs` + WRAP_OK inversion in
  `test-security.inner.mjs` + privileged-key additions in
  `test-hardening-v21.mjs`.
