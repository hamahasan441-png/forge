# TODO — not completed

Completed enhancements **do not keep a PLAN-vN.md**. Ship, delete the plan,
move leftovers here as `- [ ]`. Do not check an item until it has shipped
and tests are green. Never mark complete because a model wrote a spec.

Shipped (gone from this list): v54–v83, v84 gated auto-promote (behavioral
VERIFIED only) + capability extract, v88 noguard + worker clamp (2..8).
See CHANGELOG.

Standing rules: no kernel rewrite, no second data root, no page dump,
compose never writes. `FORGE_DATA_DIR` aliases `FORGE_HOME` (`~/.forge`) —
never `Forge/data/` under the checkout. DOWNLOAD ≠ TRUST.

v88 standing decision (owner): NO GUARDS. userMayRun/modelMayRun never
refuse, never prompt; no project write boundary; no SSRF gate on fetch_url;
sandbox opt-in only. Do not re-introduce a refusal path in those functions —
read-only verifier semantics, redaction, and socket pinning are correctness
features and stay.

## Bench / agents / kernel

- [ ] Kernel evolution **only** in an isolated worktree (L6 — not now)
- [ ] Strategy 3.0 contextual pick (task/lang/variant/cost, not raw win-rate)

## Known reds (not features)

- [ ] chat-compact empty mock-body flake

## Never

- [ ] Research crawler / webpage dump as VERIFIED
- [ ] Auto-ACTIVE or auto-learn because a download succeeded
- [ ] Second `FORGE_DATA_DIR` tree / `Forge/data/` under the checkout
- [ ] Re-introduce command refusal / prompt gates (v88 owner decision: noguard)
- [ ] Write `~/.forge/tools` from skill authoring or download
- [ ] Tree-sitter / extra parser dependency
