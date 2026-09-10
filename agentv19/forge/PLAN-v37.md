# PLAN v37 — skill evaluator + integrator + plugin selection (Forge v34)

Status: **shipped in v34.0.0.** After v33's cross-language graph: use the
*right* skill and the *right* plugin, then one integrator, then one writer.
Layer on skills.js / plugins.js / agentmanager.js. No kernel rewrite.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v33
xlang are unchanged. This layer sits on `evaluate.js` / `integrate.js`.

## Already in the tree (do not rewrite)

Ω / ∞ / v24 retrieval / v25 unbounded / v26 DAG fan-out / v27 high-capacity
/ v28 8-core burst + mid-task replan + lessons-into-planning / v29
information-gain + FORGE-BENCH / v30 vision / v31 browser / v32 incremental
index + language adapters / v33 cross-language graph, shellguard, netguard,
securefs, plugin isolation, the 9-check completion gate,
`classifyTaskComplexity()` (frozen), MICRO-only synthesise,
TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS, single-mutating-writer.

v34 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not auto-grant plugins. It does not dump 69
skills into a typo fix.

## What v34.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | Up to 40 of ~69 skill names dumped every turn | `evaluate.js`: top-3 by score; MICRO/SMALL → 0 unless named |
| 2 | Every granted plugin in the schema | `selectPlugins`: isolated tools only when they match; MCP/LSP pass through |
| 3 | Workers report; nobody merges | `integrate.js` + `ROLES.INTEGRATOR` (read-only). Fan-out short-circuits to `integrateResults` |
| 4 | Stale lessons still land in the prompt | `lessonIsStale` via v32 index mtime vs `lastUsed` |

## Contract

- `evaluateSkills('fix a typo in README', skills).length === 0`
- `evaluateSkills('implement a Next.js API with prisma', skills)` includes `fullstack-dev` or `coding-agent`
- `evaluateSkills('read my fortune', skills)` does not include `coding-agent` as the only pick
- a skill with `ok: false` is never selected
- `namedIn(task, 'coding-agent')` still loads that skill on MICRO
- `selectPlugins(task, plugins)` keeps `isolated: false` (MCP/LSP) always
- `selectPlugins('fix a typo', [{name:'jira_issue', isolated:true, ...}])` is empty for that plugin
- `roleIsReadOnly('integrator') === true` and `roleIsReadOnly('coder') === false`
- `integrateResults({reports:[]}).apply.length === 0`
- overlapping file claims → `conflicts.length >= 1` and apply has one entry
- `ensureIntegrator` on inspect→patch→verify (SMALL) is unchanged (1 upstream RO)
- `ensureIntegrator` on two researchers → coder inserts `integrator`
- `classifyTaskComplexity()` unchanged
- `assumeYes` / `allowSudo` stay false
- Zero runtime npm dependencies
- `files[]` includes `evaluate.js` and `integrate.js`

## Bigger map (not this release)

§8 language-specific reasoning (Rust ownership / Python packaging as planner
constraints). World-model rewrite, Tree-sitter as a runtime dep,
edit-transaction rewrite stay explicitly out.

## Non-goals

- Runtime npm dependencies.
- A second mutating writer.
- Softening shellguard / netguard / securefs / plugin isolation.
- Flipping `assumeYes`.
- Auto-granting plugin capabilities.
- Dumping all skills when `FORGE_SKILLS_ALL` is unset.
- Replanning MICRO/SMALL.
- In-process plugins on Node without the permission model.
