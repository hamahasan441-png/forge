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

- [ ] semantic_search: the persistent CHUNK CORPUS shipped in v94 gapclose
      (fingerprint-invalidated per file, ~/.forge/projects/<hash>/
      semantic-index.json — a fresh process re-reads only changed files).
      The BM25 inverted structure itself is still built per query from the
      cached chunks (milliseconds of CPU, no I/O); persisting the inverted
      structure too is a further step, not justified at current repo sizes.
- [ ] runtime: the kill-fallback walk enumerates win32 process trees via
      PowerShell CIM / wmic; neither exists on this repo's test hosts, so the
      win32 branch is only pinned for its honest leader-only degradation —
      the full tree walk there needs a Windows host to prove behaviorally.
- [ ] runtime: for a non-HTTP service the TCP floor proves LISTENING, not
      application health; protocol-specific probes (TLS handshake, WebSocket
      upgrade, Redis PING-style) as runtime-adapter capabilities would
      strengthen the evidence beyond "it answered the connect"
- [ ] LSP: extractStructured spawns and closes one server PER CALL (fine for
      on-demand tool use); a bulk structured-extraction path should reuse a
      session (createLspSession caches clients per language) instead of
      paying a server start per file
- [ ] checkpoint: reconcile covers the files the CHECKPOINT recorded; a
      whole-tree reconcile at crash-resume (every world-model fingerprint vs
      disk, so external edits to files no checkpoint ever touched are also
      surfaced before planning continues) is the larger open step

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
