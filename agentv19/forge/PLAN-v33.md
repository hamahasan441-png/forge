# PLAN v33 — vision / multimodal (Forge v30)

Status: **shipped in v30.0.0.** Next leftover after v29 (information-gain +
FORGE-BENCH): PLAN-v24 / PLAN-v31 leftover #1 — a `read_image` tool and
real image message parts, config-only, no new npm dep. Browser is next.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst and v29
experiments are unchanged. This layer lets the agent *see* a screenshot,
diagram, or failing-UI capture when the provider actually accepts images.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH, shellguard, netguard, securefs, plugin
isolation, the 9-check completion gate, `classifyTaskComplexity()` (frozen),
MICRO-only synthesise, TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS,
single-mutating-writer.

v30 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not fetch remote images.

## What v30.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | `read_file` sniffed binary and refused; no way to attach a screenshot | `read_image` (18th tool). Magic-byte png/jpeg/gif/webp. SVG refused. Local files via `safePath` only |
| 2 | User/tool content was always `String(m.content)` on the Anthropic wire | `toAnthropicContent` converts OpenAI `image_url` data-URLs to Anthropic image blocks. Remote http(s) stubbed, never fetched |
| 3 | A vision-less model would get megabytes of base64 | `providerSupportsVision` fail-closed (unknown / ollama text = false). Metadata always; pixels only when capable |
| 4 | Compaction / history would explode on base64 | `stripOldVisionParts` stubs all but the last vision user-message |

## Contract

- `detectImage` recognises png / jpeg / gif / webp magic; SVG is `rejected`
- `read_image` on a URL returns `ERROR: … local files only`
- `read_image` on `.env` is `BLOCKED` (same `safePath` as `read_file`)
- `execTool` result is still a string; pixels live on `ctx._pendingVision`
- `providerSupportsVision({ model: "gpt-4o" }) === true`
- `providerSupportsVision({ model: "llama3.2", baseUrl: "http://127.0.0.1:11434" }) === false`
- `providerSupportsVision({ model: "unknown-coder" }) === false`
- `tools.vision: false` → metadata only, no parts queued
- file larger than `MAX_IMAGE_BYTES` (768 KiB) → `tooBig`, `buf` is null, not attached
- `toAnthropicMessages` of an OpenAI image_url data-URL yields an Anthropic `image` block
- remote `image_url` (`https://…`) becomes a text stub, not a fetch
- `stripOldVisionParts(keep:1)` leaves one vision message, stubs the rest
- `TOOL_DEFS.length === 18` and `read_image` is not in `WRITE_TOOLS`
- `read_image` is in `VERIFICATION_TOOLS.allowed`
- `tools.vision` is not a privileged key (a project may disable it)
- `assumeYes` / `allowSudo` stay false
- `classifyTaskComplexity()` is unchanged

## Bigger map (not this release)

PLAN-v31 leftovers after v30:

| Order | Layer | Why it waits |
|---|---|---|
| 1 | Browser tool | Opt-in binary. Absent → tool reports unavailable. |

Shipped next: **v31.0.0 / PLAN-v34** (browser tool).

Explicitly not next: world-model rewrite, Tree-sitter / language adapters
as a runtime dep, edit-transaction rewrite, a second mutating worker,
flipping `assumeYes`, a fake sandbox.

## Non-goals

- Runtime npm dependencies.
- A second mutating worker.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes`.
- Fetching remote images.
- Inventing a pixel description when the provider cannot see.
- Replanning MICRO/SMALL.
