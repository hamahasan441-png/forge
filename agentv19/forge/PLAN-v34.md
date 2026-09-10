# PLAN v34 — browser tool (Forge v31)

Status: **shipped in v31.0.0.** Last PLAN-v24 / PLAN-v31 leftover after v30
vision: an opt-in `browser` capability that degrades when the binary is
absent. Drive and verify real UIs. No new npm dep.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst, v29
experiments, v30 vision are unchanged. This layer lets the agent *open a
page, snapshot interactive refs, click/fill, and screenshot* when chromium
or `agent-browser` is actually installed.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH / v30 vision, shellguard, netguard, securefs,
plugin isolation, the 9-check completion gate, `classifyTaskComplexity()`
(frozen), MICRO-only synthesise, TASK_STARTED → THINKING,
PRIVILEGED_TOOL_KEYS, single-mutating-writer.

v31 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not fetch a page when no browser binary exists
(that is `fetch_url`). It does not invent a DOM.

## What v31.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | No way to drive or verify a real UI; screenshots were files only | `browser` (19th tool). open / snapshot / click / fill / type / press / screenshot / scroll / back / reload / close / status |
| 2 | A missing playwright would crash a turn or force a runtime dep | `detectBrowser`: absent binary → `UNAVAILABLE`, turn continues. Injected mock driver for tests. `FORGE_BROWSER=0` disables |
| 3 | A model-chosen `http://169.254.169.254` or `javascript:` page is SSRF / XSS | `validateTarget`: `assertFetchableUrl` for http(s); file:// via `safePath`; javascript/data/blob refused |
| 4 | A verifier could submit a form or write a PNG over source | VERIFY whitelist: look (snapshot/screenshot/open/status/close), not drive. Screenshot-with-path is the only filesystem mutation |

## Contract

- `detectBrowser({ binary: null }).available === false`
- `detectBrowser({ binary: null }).kind === "none"`
- `runBrowser({ browser: false }, { action: "open", url: "https://example.com" })` starts with `UNAVAILABLE`
- `validateTarget("javascript:alert(1)")` is refused
- `validateTarget("http://127.0.0.1/")` is BLOCKED without `fetchPrivateUrls`
- `validateTarget("https://example.com")` is ok (public)
- `validateTarget("file:///etc/passwd")` is BLOCKED (escapes project)
- `select`/`execTool` with injected `createMockDriver`: open → snapshot lists `@e1`, click `@e1` records, screenshot queues vision when the provider is capable
- Missing binary: `execTool(..., "browser", { action: "open", url: "https://example.com" })` is `UNAVAILABLE`, not `ERROR`, not a throw
- `TOOL_DEFS.length === 19` and `browser` is not in `WRITE_TOOLS`
- `browser` is in `VERIFICATION_TOOLS.allowed`; `verificationAllows("browser", { action: "click" })` is false; snapshot is true
- screenshot with `path` in read-only mode is a filesystem mutation
- `tools.browser` is not a privileged key (a project may disable it)
- `assumeYes` / `allowSudo` stay false
- `classifyTaskComplexity()` is unchanged
- Zero runtime npm dependencies

## Bigger map (not this release)

PLAN-v24 leftovers after v31: **none.** Shipped next: **v32.0.0 / PLAN-v35**
(incremental code index + language adapters, UNIFIED §23 / §32). World-model
rewrite, Tree-sitter as a runtime dep, edit-transaction rewrite stay
explicitly out.

## Non-goals

- Runtime npm dependencies (no playwright / puppeteer package).
- A second mutating worker.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes`.
- Fetching remote pages when no browser binary exists (that is `fetch_url`).
- Inventing a DOM or screenshot when the binary is absent.
- Replanning MICRO/SMALL.
