# TODO — not completed

Completed enhancements **do not keep a PLAN-vN.md**. Ship, delete the plan,
move leftovers here as `- [ ]`. Do not check an item until it has shipped
and tests are green. Never mark complete because a model wrote a spec.

Shipped (gone from this list): v54 knowgap, v55 acquire, v56 ingest,
v57 priority, v58 skilllife, v59 contradict, v60 blast, v62 skilldl,
v63 verify, v64 wire, v65 discover, v66 learn, v67 evidence, v68 stale,
v69 contradict (STALE fails N times → CONTRADICTED).
See CHANGELOG.

Standing rules: no kernel rewrite, no second data root, no page dump,
`assumeYes` stays false, compose never writes. `FORGE_DATA_DIR` aliases
`FORGE_HOME` (`~/.forge`) — never `Forge/data/` under the checkout.
DOWNLOAD ≠ TRUST.

## Skill forge 2.0

- [ ] Research → implement a new skill from a gap (not only `authorSkill` from a repair)
- [ ] Validate a CANDIDATE with generated tests before VERIFIED (v67 runs author `## Tests` only)
- [ ] Benchmark a playbook vs the repair it came from
- [ ] Deprecate / supersede a learned skill when CONTRADICTED
- [ ] Versioned skills (v2 is a new CANDIDATE; v1 stays ACTIVE until v2 beats it)
- [ ] Rollback ACTIVE v2 → v1 on regression; keep both histories

## Knowledge

- [ ] Per-claim subject store (still under `FORGE_HOME/projects/<hash>/`, not a second memory)
- [ ] Drift detector (index/graph vs last verified claim)
- [ ] Configurable per-skill TTL (override `FORGE_SKILL_TTL_MS` on a record)

## Strategy / tools / models

- [ ] Strategy 2.0 (beyond v40 `evolveRun` score/avoid)
- [ ] Toolintel 2.0 (beyond v52 aggregates)
- [ ] Model empirics from real outcomes (not a static registry)
- [ ] Experiment engine: hypothesis → focused test → `recordGapOutcome`
- [ ] Consolidate lessons + memory without dropping provenance

## Tests / architecture

- [ ] Test generation for a blocking gap (still never skip tests without a ledger)
- [ ] Architecture decision log (`decisions.json` under the project hash)
- [ ] TUI knowledge pane (gaps / blast / candidate skills)
- [ ] TUI download progress (`/skill download` status line; not a fake 100%)

## Bench / agents / kernel

- [ ] Bench 2.0
- [ ] Multi-agent roles
- [ ] Kernel evolution **only** in an isolated worktree (L6 — not now)

## Known reds (not features)

- [ ] plugin-iso on Node 22 (`--allow-net` missing)
- [ ] chat-compact empty mock-body flake

## Never

- [ ] Research crawler / webpage dump as VERIFIED
- [ ] Auto-ACTIVE or auto-learn because a download succeeded
- [ ] Second `FORGE_DATA_DIR` tree / `Forge/data/` under the checkout
- [ ] Flip `assumeYes` or `allowNewPlugins` by default
- [ ] Write `~/.forge/tools` from skill authoring or download
