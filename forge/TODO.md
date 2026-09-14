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

## v99 "loopwise" — leftovers (completed plan removed, house style)

- [ ] tree-sitter consumption (inherited from v98): the layer-2 probe
      reports the binary but extraction still never uses it (the CLI's
      grammar/output schema is a per-language surface; LSP tier-3 is the
      default structured path)
- [ ] docker-image verification goes no deeper than bringUp health +
      artifact existence (image digest/layer checks are not implemented)
- [ ] the code-review pass trusts the reviewer agent's self-reported line
      numbers (deterministic findings carry observed evidence; reviewer
      findings are advisory-majors unless a deterministic signal confirms)
- [ ] autofix allowlist is a static table — a project using a formatter
      not in the table falls through to the LLM repair (safe, just slower)
- [ ] skill registry URLs are hints, not verified manifests (a moved
      branch fails the download honestly; no periodic revalidation)
- [ ] the reviewer/verifier/repair passes each pay their own model call —
      no shared session (bounded budgets exist; consolidation is future
      work)

CLOSED in v99: gitship PR creation — `gitship.pr = "gh"` opens real PRs
through the user's OWN gh CLI (passthrough; forge never holds a GitHub
token; consent-gated like push; requires the pushed commit). The v98
blocker ("token sourcing unsolved by policy") was solved by NOT sourcing
a token at all.

## v98 "shipwise" — leftovers (superseded by the v99 list above)

CLOSED by v99: gitship PR creation — `gitship.pr = "gh"` (gh CLI passthrough,
never a forge-held token). The v98 blocker ("token sourcing unsolved by
policy") was solved by NOT sourcing a token at all.


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
