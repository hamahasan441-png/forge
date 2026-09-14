# forge — TODO (not completed)

This file is the ONLY place where unfinished ideas, known gaps and deferred
work live. A shipped version must not keep a PLAN file: completed plans are
deleted at release time and their leftovers move here. Do not keep a PLAN
file for work that already shipped — if it shipped, the plan is history; if
it did not ship, it belongs on this list.

Status: **not completed** — the deferred items below remain open. The seven
runtime/sandbox/search/checkpoint/LSP/tool-creation gaps that lived here
through v94 "fastwise" are CLOSED (v94 "todowise": `tests/test-todowise.mjs`,
81 assertions, suite registered in run-all — an item only moves out of this
file when a test proves the behavior exists, and each one now has exactly
that). The kernel item — isolated worktree execution for DAG nodes — is
CLOSED by v95 "worktreewise" (`tests/test-worktreewise.mjs`, 75 assertions,
9 sections: lifecycle, isolation invariant, conflict honesty, eligibility,
gates, orphan sweep, child-process runner, meta integration, surface-dedup
audit). v96 "unifywise" additionally closed the WIRING ledger — the
computed-then-ignored surfaces, dropped resume state, dead event vocabulary,
unfed ledgers and duplicated implementations found by the five-module deep
audit — each pinned by `tests/test-unifywise.mjs` (72 assertions) and
`tests/test-envfingerprint.mjs` (27 assertions). v98 "shipwise" closed the
v97 leftovers — LSP structured extraction wired into the index path
(langstruct.js, pinned by `tests/test-v98.mjs`), browser visual regression
(visual_diff baselines), artifact verification (observed build outputs as
VTYPE.ARTIFACT ledger evidence), and chunked/async world-model walking
(buildAsync + the 0=unlimited resolver fix). History in the CHANGELOG.

## v98 "shipwise" — leftovers (completed plan removed, house style)

- [ ] tree-sitter consumption: the layer-2 probe reports the binary but
      extraction still never uses it (the CLI's grammar/output schema is a
      per-language surface; LSP tier-3 is the default structured path now)
- [ ] docker-image verification goes no deeper than bringUp health + artifact
      existence (image digest/layer checks are not implemented)
- [ ] gitship PR CREATION (not just PR text) — needs a consented remote API
      path (token sourcing is unsolved by policy, providers.js:104)


## Open items

(none — the seven former items shipped and closed in v94 "todowise"; the
kernel worktree item shipped and closed in v95 "worktreewise"; the remaining
deferred work is policy-gated, not implementable-by-decision)

## Skill forge — leftovers (never shipped, never promoted)

- [ ] Research crawler: a multi-source web research skill was prototyped but
      never met the promotion bar (no recorded behavioral evidence, no fresh
      fingerprint). It stays here until it passes the same gates as a
      learned download.

## Learned skills — policy reminders

- A learned skill never becomes Auto-ACTIVE by itself. Promotion requires
  recorded behavioral evidence plus a fresh fingerprint; being usable is
  not being trusted, and a skill must never be auto-approved just
  because a download succeeded.
- markStaleSkills runs on every world-model fingerprint change; a stale
  skill drops back to candidate until it re-earns evidence.

## Never list (permanent)

- Never ship a skill that fetches arbitrary URLs beyond the netguard
  pinnedFetch policy (Research crawler stays on this list until its fetch
  surface is proven pinned).
- Never make a learned skill Auto-ACTIVE without behavioral evidence.
- Never keep a shipped PLAN file — leftovers live here, history lives in the
  CHANGELOG.
- Never run DAG nodes in a shared tree when they mutate the same files —
  v95 "worktreewise" IS the fix: mutating nodes with pairwise-disjoint
  declared targets execute in per-node git worktrees, the merge back into
  the shared tree is checked-then-applied behind the single-writer barrier,
  and anything ineligible (undeclared targets, overlap, dependencies,
  uncommitted target drift, non-git repo, opt-out) stays serialized exactly
  as before. The rule stands; the fix enforces it.
