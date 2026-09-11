# PLAN v56 — skillforge + plugintel (Forge v53 layer on v37)

Status: **implemented on `forge-v53-skillforge`.** After v37 langengine:
integrate many skills and plugins *intelligently* — tagged ranking,
first-party playbooks, hostless plugin playbooks. No kernel rewrite.
No skill dump. No live plugin-host for learned playbooks.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB).

## What v53 closed

| # | Gap | Module |
|---|---|---|
| 1 | Only lexical name/desc scoring | `skillforge.scoreSkill` adds tags + aliases |
| 2 | No first-party engineering pack | 11 `skills/forge-*` + catalog `coding-agent` |
| 3 | Plugins were all-or-nothing in the schema | `plugintel.pickPlugins` splits live isolated tools vs playbooks |
| 4 | MICRO still protected | typo → zero auto skills / playbooks unless named |

## Contract

- `pickSkills("fix a typo in README", …)` is `[]`
- named `forge-security` on a typo is selected
- default top-k ≤ 3 (v34 suite stays green)
- `ok: false` skills never selected
- plugin playbooks never spawn `plugin-host`
- `assumeYes` / `allowNewPlugins` stay false
- `classifyTaskComplexity()` unchanged
- VERSION stays `37.0.0` (layer, not a bump that reds v34–v37)
- Zero runtime npm dependencies
- `files[]` includes `skillforge.js` and `plugintel.js`

## Non-goals

- Tree-sitter, L6, world-model rewrite
- Writing `~/.forge/tools`
- Flipping `assumeYes`
- Dumping all bundled skills into the prompt (`FORGE_SKILLS_ALL=1` still exists)
- Second mutating writer
