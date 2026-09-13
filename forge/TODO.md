# forge — TODO (not completed)

This file is the ONLY place where unfinished ideas, known gaps and deferred
work live. A shipped version must not keep a PLAN file: completed plans are
deleted at release time and their leftovers move here. Do not keep a PLAN
file for work that already shipped — if it shipped, the plan is history; if
it did not ship, it belongs on this list.

Status: **not completed** — every item below is open. Nothing on this list
is claimed, promised or half-shipped; an item moves out of here only when a
test proves the behavior exists.

## Open items

- [ ] runtime: process-group kill on platforms without `kill(-pgid)` (the
      group-signal fallback kills only the leader on some non-Linux systems;
      needs an evidence-based walk like groupPids, with a test)
- [ ] runtime: health probes assume HTTP; a TCP-only or WebSocket service
      reports NOT healthy even when it is listening — needs a protocol-aware
      probe or an honest "no HTTP probe available" evidence line
- [ ] sandbox: bwrap detection probes overflowuid/overflowgid once per
      process; a kernel hardened *after* forge started is not re-probed —
      consider a cheap re-probe on the first bwrap startup failure
- [ ] semantic_search: BM25 corpus is rebuilt from scratch per process; a
      persistent inverted index (fingerprint-invalidated like the world
      model) would cut first-query latency on large repos
- [ ] LSP: documentSymbol extraction falls back to lexical scanning when no
      language server is running; a server auto-start table for the top
      languages (ts/js, python, go, rust) would make the structured path the
      default instead of the exception
- [ ] tool creation: behavioral verification runs one schema-shaped probe;
      multi-step tools (login → act → verify) need a scripted probe format
      before they can be promoted safely
- [ ] checkpoint: restore does not currently verify that the working tree
      matches the checkpoint's recorded fingerprints when files were touched
      by an external process between crash and resume

## Skill forge — leftovers (never shipped, never promoted)

- [ ] Research crawler: a multi-source web research skill was prototyped but
      never met the promotion bar (no recorded behavioral evidence, no fresh
      fingerprint). It stays here until it passes the same gates as a
      learned download.

## Kernel — leftovers

- [ ] isolated worktree execution for DAG nodes: nodes would run in a
      per-node git worktree so parallel segments never see each other's
      partial writes; design exists, no implementation, no test.

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
- Never keep a shipped PLAN file — leftovers live here, history lives in
  the CHANGELOG.
- Never run DAG nodes in a shared tree when they mutate the same files
  (the isolated worktree item above is the fix, not a license).
