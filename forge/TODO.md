# TODO — not completed

Completed enhancements **do not keep a PLAN-vN.md**. Ship, delete the plan,
move leftovers here as `- [ ]`. Do not check an item until it has shipped
and tests are green. Never mark complete because a model wrote a spec.

Shipped (gone from this list): v54–v83, v84 gated auto-promote (behavioral
VERIFIED only) + capability extract. See CHANGELOG.

Standing rules: no kernel rewrite, no second data root, no page dump,
`assumeYes` stays false, compose never writes. `FORGE_DATA_DIR` aliases
`FORGE_HOME` (`~/.forge`) — never `Forge/data/` under the checkout.
DOWNLOAD ≠ TRUST.

## Bench / agents / kernel

- [ ] Kernel evolution **only** in an isolated worktree (L6 — not now)
- [ ] Strategy 3.0 contextual pick (task/lang/variant/cost, not raw win-rate)

## Known reds (not features)

- [ ] chat-compact empty mock-body flake

## Never

- [ ] Research crawler / webpage dump as VERIFIED
- [ ] Auto-ACTIVE or auto-learn because a download succeeded
- [ ] Second `FORGE_DATA_DIR` tree / `Forge/data/` under the checkout
- [ ] Flip `assumeYes` or `allowNewPlugins` by default
- [ ] Write `~/.forge/tools` from skill authoring or download
- [ ] Tree-sitter / extra parser dependency
