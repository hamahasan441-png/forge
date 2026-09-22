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

## v132 "mindwise" — leftovers (completed plan removed, house style)

- [ ] package.json is still 122.0.0 while named suites run through v132.
      Dozens of historical tests pin the literal `122.0.0` / `/^122\./`.
      A versionwise release that updates every pin (and only that) is the
      honest bump; this release refused to mix it in.
- [ ] five review systems remain (`review.js`, `codereview.js`, `selfreview.js`,
      `critique.js`, `plancritique.js`). v132 made the worker self-review's
      verdict actually reach the ledger (`passed: trust.trust`). Merging the
      five into one module is still future work.
- [ ] `think()` now persists onto the episode store. It is not in the tracer
      or engmemory. A compacted transcript still cannot re-read the scratchpad
      except via `contextBlock` / `failedApproachesPrefix`.
- [ ] journal recovery is still a second prompt on a crashed run that also
      left a runlog entry (v131 leftover, unchanged).

## v131 "onewise" — leftovers (completed plan removed, house style)

- [ ] package.json is still 122.0.0 while named suites run through v131.
      Dozens of historical tests pin the literal `122.0.0` / `/^122\./`.
      A versionwise release that updates every pin (and only that) is the
      honest bump; this release refused to mix it in.
- [ ] five review systems remain (`review.js`, `codereview.js`, `selfreview.js`,
      `critique.js`, `plancritique.js`). Routing TTY through the controller
      means interactive runs now HIT the meta-side ones; merging them is still
      future work. (v132 made worker evidence honest; the merge is not done.)
- [ ] `think()` records on the tool context of one run and emits `reasoning`
      (the dock's existing thought line). v132 persists it to the episode
      store. It is still not in the tracer / engmemory.
- [ ] default `forge agent` now uses Core, so piped output is the controller
      card (`loop: controller`, segment summary) rather than `[step 1] bash`.
      `agent.autonomous: false` restores the one-shot printer. e2e-forge.sh
      pins that opt-out so the historical printer contract stays a regression
      net; a v131 block at the end still runs the shipped default.
- [ ] Ctrl+C during Core planning is CANCELLED (was WAITING). Recovery [C]
      parks WAITING so the nag stops. Journal recovery is still a second
      prompt on a crashed run that also left a runlog entry.


## v130 "yolomode" — leftovers (completed plan removed, house style)


- [ ] `agent.js` and `chat.js` still OR the resolved grants with the
      historical `unrestricted` when they build the tool ctx
      (`allowSudo: yoloNow.allowSudo || unrestricted`, and five more). With
      mode=off and the SHIPPED `tools.unrestricted: true`, the ctx can carry
      `allowSudo: true` while `yoloState()` reports `allowSudo: false` — the
      report is the honest one, but two answers to one question is the exact
      shape v122 set out to end. Left alone here because closing it turns
      `--safe` from "no confirmations" into "no sudo", which is a behaviour
      change that deserves its own release and its own test.
- [ ] no mode reaches `gitship` consent (see the v122 list): "full control"
      still stops at an outward act, so `push`/`pr` keep their AUTHORIZATION
      ask in every mode. Correct, but it means `mode=full` is not literally
      "nothing asks".
- [ ] `--yolo-full` sets the mode for one process but there is no
      `--yolo-mode <m>` for the third value: `FORGE_YOLO_MODE=off` is the only
      way to force `off` for a single run besides `--safe` (which also clears
      autoApprove). One flag with a value would replace both.
- [ ] the mode is not shown in the agent's per-step event stream, only in
      `forge yolo`, `/yolo status`, `/status` and `forge doctor`. A
      `CONTROL_MODE` event at run start would put it in the transcript next to
      the governor directive it now controls.

## v122 "yolowise" — leftovers (completed plan removed, house style)

- [ ] YOLO never touches `gitship` consent, by decision: `push`/`pr` are
      OUTWARD acts (a remote and a team see them), so they keep their live
      AUTHORIZATION ask even under full control. A zero-ask delivery mode needs
      its own explicit key (`gitship.push: "auto"`), not a YOLO consequence.
      Today `gitship.*` ships `"off"`, so nothing is blocked — only the shape
      of "full control" is incomplete until that key exists.
- [ ] `isVerificationGradeBash` is conservative about operands: ANY named path
      outside the project refuses the command, so a read-only worker cannot run
      `pytest -c /etc/pytest.ini` or `tsc -p ../shared/tsconfig.json`. Splitting
      read operands from write operands needs the classifier to distinguish them
      first (it collects `targets` for both).
- [ ] the read-only bash widening is not applied to `autofix.js`, which still
      uses its own static formatter table — safe (it only picks a formatter),
      but it is now the last hand-written command allowlist in the engine.
- [ ] the v118/v119 completion gate is deliberately NOT relaxed by YOLO (it
      refuses a false DONE, not a command), which leaves no key for the owner who
      genuinely wants "finish and tell me the truth later": that needs an
      explicit `completion.requireEvidence: false`, reported as
      `COMPLETED_UNVERIFIED` — never as a clean COMPLETED.
- [ ] `sandbox.js` stays opt-in and YOLO does NOT enable it: the switch is about
      refusal, not isolation, and silently starting a bwrap sandbox because a
      flag was flipped would be exactly the surprise this release is removing.
      A pairing (`forge yolo --sandbox`, "run everything, inside a jail") is the
      missing combination.
- [ ] the `block` classification level is computed and reported but honoured by
      nothing (v88 made that permanent). Fine as a label; a future hard-stop
      would need its own key, and it must not be a side effect of `yolo:false`.

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
