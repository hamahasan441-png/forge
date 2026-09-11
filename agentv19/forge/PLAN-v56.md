# PLAN v56 — rank-into-plan (Forge v53 layer on v52)

Status: **this release.** After v52's toolmem: first-party skill ranking
(`skillforge.pickSkills`), hostless plugin playbooks
(`plugintel.pickPlugins`), and configured MCP names (`rankMcp`) join the
existing compose snapshot and therefore the noTools planner — the same
8–12 lines execute already sees. No kernel rewrite. No skill dump. No
live MCP connect from compose. No live plugin-host for playbooks.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v52
toolmem are unchanged. This layer sits on `skillforge.js` / `plugintel.js`
/ `compose.js` / `evaluate.js` / `agent.js` / `chat.js` / `context.js` /
`meta.js`.

The v37-divergent skillforge PR on `main` (VERSION 37.0.0) shipped the
catalog unwired. This layer ports that ranking onto the intelligence
stack and **wires it**.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH / v30 vision / v31 browser / v32 incremental
index + language adapters / v33 cross-language graph / v34 skill evaluator
+ plugin selector + integrator / v35 language-specific reasoning / v36
graph-aware memory invalidation / v37 language-aware engine / v38 gap-fix
/ v39 focused verification / v40 strategy evolution / v41 compose pipeline
/ v42 isolated plugin self-extension / v43 compose picks learned plugins
/ v44 playbook snapshot / v45 steer / v46 apply / v47 know / v48 hostless
/ v49 check / v50 once / v51 apinex / v52 toolmem, shellguard, netguard,
securefs, plugin isolation, the 9-check completion gate,
`classifyTaskComplexity()` (frozen), MICRO-only synthesise,
TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS, single-mutating-writer.

v53 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not flip `allowNewPlugins`. It does not add
Tree-sitter. It does not rewrite the world model. It does not persist a
second graph file. It does not auto-run tests. It does not put compose
into the Ω kernel. It is not kernel self-mod (L6). It does not dump the
bundled skill pack into the prompt. It does not connect MCP servers from
compose. Wizard pick 18 stays `custom`.

## What v53.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | `evaluateSkills` was lexical-only; tags/aliases unused | `pickSkills` → compose / agent / chat / context |
| 2 | First-party engineering pack unwired | 11 `skills/forge-*` + catalog `coding-agent` |
| 3 | Hostless plugin playbooks existed, unused | `pickPlugins` → compose `[playbooks]` + `formatSteer` |
| 4 | MCP always-passed execute schema, never ranked into plan | `rankMcp` / `mcpCatalog` → `[mcp]` (cap 4, no connect) |
| 5 | Planner already got `formatCompose` but the snapshot lacked rank | same prefix, richer snapshot |

## Contract

- `pickSkills("fix a typo in README", …)` is `[]`
- named `forge-security` on a typo is selected
- default top-k ≤ 3 (v34 suite stays green)
- `ok: false` skills never selected
- plugin playbooks never spawn `plugin-host`
- MCP ranking never calls `connectServer` / `loadMcpTools`
- live MCP tools (already loaded) beat config server stubs
- MICRO/SMALL: playbooks + mcp empty unless named
- `formatSteer({})` is still `""`; `playbooks` / `mcp` are additive
- `compose()` stays uncached; `composeOnce` keys include playbooks + mcp
- `evaluateSkills` itself is unchanged (v34 contract)
- `CATALOG[17]` is still `custom` (e2e pick 18)
- `assumeYes` / `allowNewPlugins` stay false
- `classifyTaskComplexity()` unchanged
- Zero runtime npm dependencies
- Bundled `agentv19/forge/skills/` is never written at runtime
- `~/.forge/tools` is never written
- compose stays synchronous

## Non-goals

- Tree-sitter, L6, world-model rewrite
- Writing `~/.forge/tools`
- Flipping `assumeYes`
- Dumping all bundled skills into the prompt (`FORGE_SKILLS_ALL=1` still exists)
- Second mutating writer
- Auto-installing MCP servers
- Landing the v38–v52 stack onto `main` (separate merge)

## Bigger map (not this release)

Unused wiring closed: ranked skills, hostless playbooks, and MCP names
now reach the planner through the snapshot execute already used.
Community SKILL.md stays on disk for `load_skill` / named hits.
L6 kernel self-mod is explicitly out.
