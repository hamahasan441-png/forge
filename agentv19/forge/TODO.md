# TODO — not completed

Completed enhancements **do not keep a PLAN-vN.md**. Ship, delete the plan,
move leftovers here as `- [ ]`. Do not check an item until it has shipped
and tests are green. Never mark complete because a model wrote a spec.

Shipped (gone from this list): v54 knowgap, v55 acquire, v56 ingest,
v57 priority, v58 skilllife, v59 contradict, v60 blast. See CHANGELOG.

Standing rules: no kernel rewrite, no second data root, no page dump,
`assumeYes` stays false, compose never writes. `FORGE_DATA_DIR` aliases
`FORGE_HOME` (`~/.forge`) — never `Forge/data/` under the checkout.

## Next — skill download (v62, not shipped)

Native download. **DOWNLOAD ≠ TRUST.** User-supplied URL only. CANDIDATE
until an explicit later `/skill verify`. Integrate with existing
`skills.js` / `skilllife` / CLI — not a second skill manager.

- [ ] `forge skill download <url> [<url>…]` and TUI `/skill download <url>`
- [ ] HTTPS only; `pinnedFetch` / netguard (no private, no metadata, no file:)
- [ ] Store under `FORGE_HOME/skill-downloads/` (same root as `FORGE_DATA_DIR`)
- [ ] Preserve a safe filename; sha256; size; timestamp; source URL
- [ ] Metadata JSON next to the artifact (`status: DOWNLOADED`, no invented fields)
- [ ] Discover SKILL.md / `.skill` archive; record CANDIDATE in `skilllife.json`
- [ ] Multiple URLs in one command; each stays CANDIDATE; none auto-ACTIVE
- [ ] Duplicate sha256: reuse existing, never overwrite a VERIFIED copy
- [ ] Fail closed: invalid URL, HTTP error, timeout, empty/corrupt body → no candidate
- [ ] Temp files under the Forge data root, cleaned up; never the user project
- [ ] Tests: download → file + metadata in skill-downloads; status CANDIDATE; restart still sees it; SSRF refused; compose never fetches

Out of scope for v62 (keep later): verify-all pipeline, deep learn,
benchmark, version compare, rollback, progress bar, auto-attach on every
task (pickSkills already loads VERIFIED/ACTIVE).

## Skill forge 2.0

- [ ] `/skill verify <name> [name…]` and `/skill verify all` — existing skilllife CANDIDATE → VERIFIED only after parse + tests, never because it downloaded
- [ ] Failed verify stays INACTIVE; one failure does not fail siblings
- [ ] `/skill learn <name>` — extract procedures/patterns into FORGE_HOME knowledge; indexing is not "learned"
- [ ] Research → implement a new skill from a gap (not only `authorSkill` from a repair)
- [ ] Validate a CANDIDATE with generated tests before VERIFIED
- [ ] Benchmark a playbook vs the repair it came from
- [ ] Deprecate / supersede a learned skill when CONTRADICTED
- [ ] Versioned skills (v2 is a new CANDIDATE; v1 stays ACTIVE until v2 beats it)
- [ ] Rollback ACTIVE v2 → v1 on regression; keep both histories

## Knowledge

- [ ] STALE-by-age (VERIFIED past a TTL without re-verify → STALE, not CONTRADICTED)
- [ ] Per-claim subject store (still under `FORGE_HOME/projects/<hash>/`, not a second memory)
- [ ] Drift detector (index/graph vs last verified claim)

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
- [ ] Land v38–v61 stack on `main` (separate merge, not an enhancement)

## Known reds (not features)

- [ ] plugin-iso on Node 22 (`--allow-net` missing)
- [ ] chat-compact empty mock-body flake

## Never

- [ ] Research crawler / webpage dump as VERIFIED
- [ ] Auto-ACTIVE or auto-learn because a download succeeded
- [ ] Second `FORGE_DATA_DIR` tree / `Forge/data/` under the checkout
- [ ] Flip `assumeYes` or `allowNewPlugins` by default
- [ ] Write `~/.forge/tools` from skill authoring or download
