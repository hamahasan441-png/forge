# TODO — not completed

Completed enhancements **do not keep a PLAN-vN.md**. Ship, delete the plan,
move leftovers here as `- [ ]`. Do not check an item until it has shipped
and tests are green. Never mark complete because a model wrote a spec.

Shipped (gone from this list): v54–v79, v80 verify2 (structured exec
results, truncated/unknown never PASS, evidence fingerprint, generated-test
provenance, skill benchmark UNKNOWN-when-unmeasured). See CHANGELOG.

Standing rules: no kernel rewrite, no second data root, no page dump,
`assumeYes` stays false, compose never writes. `FORGE_DATA_DIR` aliases
`FORGE_HOME` (`~/.forge`) — never `Forge/data/` under the checkout.
DOWNLOAD ≠ TRUST.

## Skill forge 2.0

- [ ] Full ZIP unpack of scripts/examples (SKILL.md extract only in v79/v80)

## Bench / agents / kernel

- [ ] Kernel evolution **only** in an isolated worktree (L6 — not now)
- [ ] Named strategy variants (skill + strategy + version + fingerprint)

## Known reds (not features)

- [ ] chat-compact empty mock-body flake

## Never

- [ ] Research crawler / webpage dump as VERIFIED
- [ ] Auto-ACTIVE or auto-learn because a download succeeded
- [ ] Second `FORGE_DATA_DIR` tree / `Forge/data/` under the checkout
- [ ] Flip `assumeYes` or `allowNewPlugins` by default
- [ ] Write `~/.forge/tools` from skill authoring or download
