# TODO — not completed

Completed enhancements **do not keep a PLAN-vN.md**. Ship, delete the plan,
move leftovers here as `- [ ]`. Do not check an item until it has shipped
and tests are green. Never mark complete because a model wrote a spec.

Shipped (gone from this list): v54–v83, v84 gated auto-promote (behavioral
VERIFIED only) + capability extract, v88 noguard + worker clamp (2..8),
v91 ULTIMATE (objective engine + 13-role crew + final report + docs/git
intelligence + self-review/self-upgrade/rollback), v92 PROCREW (the crew
executes in parallel under one scheduler + verification pipeline + accepted/
rejected approach memory). See CHANGELOG.

v91 standing rules (same spirit as above): the completion gate — never a step
count — decides DONE; a self-upgrade never writes source files (config, project
memory and additive files only, each with a recorded inverse); the advisory
crew adds zero model calls; objectives, reports and the upgrade manifest live
under the ONE forge data root.

v92 standing rules: ONE scheduler for sub-agent work (no second fan-out loop);
a verification stage with no real command is skipped with a reason, never
faked; pass/fail belongs to verifyledger alone; a repair budget counts
ATTEMPTS, not successes; a sub-agent is never promoted to writer.

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
