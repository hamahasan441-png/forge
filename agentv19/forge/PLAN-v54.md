# PLAN v54 — apinex (Forge v51)

Status: **this release.** Add APInex (`https://api.apinex.bond/v1`) as a
catalog provider. OpenAI-compatible Chat Completions. Live model list
from `GET /v1/models` (auth) or `GET https://apinex.bond/api/public/models`
(no key). Custom model ids still add. Wizard pick 18 stays `custom`.

## Contract

- `getCatalog("apinex")` exists; protocol `openai`; env `APINEX_API_KEY`
- baseUrl `https://api.apinex.bond/v1`
- `CATALOG` index 17 (0-based) is still `custom` (e2e pick 18)
- `listModels` of apinex uses the public catalog when no key
- `extraModels` appear first in the list (custom add)
- `free/…` ids are FREE (same as OpenRouter `:free`)
- wizard `[m]` / `/model` / `forge use --model` still accept any id
- `assumeYes` / `allowNewPlugins` stay false
- `classifyTaskComplexity()` unchanged
- Zero runtime npm dependencies
- No kernel rewrite, no L6

## Non-goals

- Anthropic Messages / Responses / APInex tools (web/twitter/voice) as Forge tools.
- Flipping `assumeYes`.
- Changing e2e pick-18 custom.
- Runtime npm dependencies.
