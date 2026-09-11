# PLAN v57 — knowgap (Forge v54 layer on v53)

Status: **this release.** After v53's rank-into-plan: required vs known vs
skippable knowledge joins the existing compose snapshot and therefore the
noTools planner. Assessments persist under the existing FORGE_HOME project
hash (`knowgap.json`, 0600, aggregates only). No kernel rewrite. No second
data root. No research engine. No fake confidence.

Target machine still: Xiaomi 13T Pro (8 cores / 12GB). v28 burst … v53
rank are unchanged. This layer sits on `knowgap.js` / `compose.js` /
`evaluate.js` / `agent.js` / `chat.js` / `meta.js` / `forge.js`.

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
/ v49 check / v50 once / v51 apinex / v52 toolmem / v53 rank, shellguard,
netguard, securefs, plugin isolation, the 9-check completion gate,
`classifyTaskComplexity()` (frozen), MICRO-only synthesise,
TASK_STARTED → THINKING, PRIVILEGED_TOOL_KEYS, single-mutating-writer.

v54 is a layer *on that*. It does not spawn a second writer. It does not
flip `assumeYes`. It does not flip `allowNewPlugins`. It does not add
Tree-sitter. It does not rewrite the world model. It does not persist a
second graph file. It does not auto-run tests. It does not put compose
into the Ω kernel. It is not kernel self-mod (L6). It does not dump the
bundled skill pack into the prompt. It does not invent a second
`FORGE_DATA_DIR`. Wizard pick 18 stays `custom`.

## What v54.0 closed

| # | Gap | Module |
|---|---|---|
| 1 | Planner ranked skills/tools but not *what it does not know* | `detectGaps` → compose `[gaps]` / `[skip]` |
| 2 | LOW-impact unknowns treated the same as CRITICAL | skippable vs learn-before-implement |
| 3 | Gap ranking died with the process | `persistGaps` → `~/.forge/projects/<hash>/knowgap.json` |
| 4 | No inspectable Forge data root | `forge data status \| gaps \| reset gaps` |
| 5 | Model-inferred knowledge could look verified | lexical evidence is PROBABLE at most; VERIFIED only via `recordGapOutcome` |

## Contract

- `detectGaps("fix a typo in README")` is empty (MICRO)
- named `payment` on a typo is selected
- CSS/animation is `[skip]` (LOW), never a blocking gap
- production payment system requires `payment` CRITICAL and implies api/database/security/testing
- world/memory hits are PROBABLE, never VERIFIED
- `recordGapOutcome({ id: "payment", status: "VERIFIED" })` makes the next detect KNOWN
- persist is 0600, no task text, under `projectDir(cwd)`, never the user project
- `compose()` does not write `knowgap.json`
- `formatSteer({})` is still `""`; `gaps` is additive
- MICRO/SMALL: gaps empty unless a domain is named
- `compose()` stays uncached; `composeOnce` keys include gaps
- `evaluateSkills` itself is unchanged (v34 contract)
- `CATALOG[17]` is still `custom` (e2e pick 18)
- `assumeYes` / `allowNewPlugins` stay false
- `classifyTaskComplexity()` unchanged
- Zero runtime npm dependencies
- Bundled `agentv19/forge/skills/` is never written at runtime
- `~/.forge/tools` is never written
- compose stays synchronous
- `FORGE_HOME` / `~/.forge` remains the single data root

## Non-goals

- Tree-sitter, L6, world-model rewrite
- A second persistence root
- Autonomous research / skill acquisition (later phases)
- Fake confidence / strategy scores
- Writing `~/.forge/tools`
- Flipping `assumeYes`
- Full `forge data export|backup|restore|reset all`
- Landing the v38–v53 stack onto `main` (separate merge)

## Bigger map (not this release)

Self-reliance spec phases C–M (research engine, skill forge 2.0, strategy
evolution 2.0, bench 2.0, multi-agent roles) stay later. This layer is
phase B only: self-knowledge + knowledge-gap, stored in the existing
Forge data root. L6 kernel self-mod is explicitly out.
