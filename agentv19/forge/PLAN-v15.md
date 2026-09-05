# forge v15 "OMNITOOL" — Best-Tools Integration + Auto-Use-All-Tools Plan (executed)

Date: 2026-09-04 · Baseline: v14 (E2E 41/41) · Result: v15, 15 tools, E2E 63/63

## 0. Research (what the best CLI agents ship)

Benchmarked against Claude Code / Codex CLI / Gemini CLI tool surfaces and the
2026 coding-agent-primitives survey (plan mode, subagents, memory, todo tracking,
web search/fetch as standard equipment):

| primitive | Claude Code | forge v14 | v15 |
|---|---|---|---|
| shell / files / grep | ✓ | ✓ (8 tools) | ✓ |
| glob file finder | ✓ Glob | ✗ | ✓ `glob_files` |
| web search | ✓ WebSearch | ✗ (only fetch) | ✓ `web_search` |
| task/todo tracking | ✓ TodoWrite | ✗ | ✓ `todo` |
| subagent delegation | ✓ Task | ✗ | ✓ `delegate` |
| persistent memory | ✓ CLAUDE.md | ✗ | ✓ `memory` + auto-injection |
| reasoning scratchpad | ✓ think | ✗ | ✓ `think` |
| atomic multi-edit | ✓ MultiEdit | ✗ | ✓ `multi_edit` |
| tools usable in chat (auto) | ✓ | ✗ (agent only) | ✓ streaming inline |

## 1. New tools (8 → 15)

| tool | what it does | safety |
|---|---|---|
| `glob_files` | recursive glob (`**/*.ts`), mtime-sorted, capped 200 | skips node_modules/.git/... |
| `web_search` | zero-dependency search: configured endpoint (SearXNG JSON/HTML) or DuckDuckGo Lite fallback; top 8 results | 12s timeout, SSRF-safe hosts |
| `multi_edit` | N exact replacements in ONE call, all-or-nothing (validates every `old` first, then writes once) | atomic — no partial edits |
| `todo` | task list `set/list/update`, persisted `~/.forge/todo.json`, rendered [ ]/[x] | 100 items cap |
| `think` | structured scratchpad — plan/reflect with zero side effects | none (pure text) |
| `memory` | persistent notes `read/append/replace` in `~/.forge/memory.md`, auto-injected into every chat + agent system prompt | 4000-char read cap |
| `delegate` | spawns a READ-ONLY subagent (read/glob/grep/list/web/think only) for research subtasks | depth ≤ 1, ≤ 10 steps, no write tools |

## 2. Auto-use ALL tools (the headline)

- **Chat is now tool-using** — like Claude Code interactive: in `forge chat` the
  model can call any of the 15 tools mid-conversation; forge executes them
  automatically, feeds results back, and streams the final answer. No `/agent` needed.
- **Streaming tool-call assembly, both wire protocols** — OpenAI `delta.tool_calls`
  fragment assembly and Anthropic `input_json_delta` partial-JSON assembly, so tools
  work while streaming (v14 could only do tool calls in non-streaming agent rounds).
- **`/tools` command** — list all 15 tools + on/off toggle (`/tools off` = plain chat).
  Default ON (`chat.tools: true` in config).
- **Agent guidance** — system prompt now instructs: use `todo` for multi-step work,
  `think` before complex edits, `delegate` for read-only research, `memory` for facts
  worth keeping.
- **`forge doctor --tools`** — self-tests every tool in the actual environment
  (bash/file ops/glob/grep live, network tools SKIP gracefully offline).

## 3. Wire perfection fixes found while building

- **Anthropic message converter** (`toAnthropicMessages`): history is kept in
  OpenAI wire format internally and converted per-request — extracts `role:"system"`
  to top-level `system` (real Anthropic API rejects system messages in the array —
  a latent real-world bug v14 carried), maps `tool_calls` → `tool_use` blocks,
  `role:"tool"` → `tool_result` blocks, drops empty text blocks.
- Agent loop unified to one message format (dual protocol branching removed —
  less code, same E2E coverage on both wires).
- `streamChatResilient` treats tool-call events as emitted output (no retry after
  partial data — prevents double tool execution).

## 4. Performance

- No cold-start regression: tool defs are static arrays; memory/todo files are
  read lazily and capped (2–4 KB). Cold start remains ~40ms.

## 5. Verification

- **E2E battery: 63/63** (was 41) — new: glob/search/multi_edit/todo/memory/think/
  delegate agent loops, chat INLINE auto-tools on BOTH wire protocols (streaming
  assembly proven), /tools list + off, doctor --tools, atomic-edit file assertions.
- Clean-room install: `npm i -g .` → `forge` from any cwd.
