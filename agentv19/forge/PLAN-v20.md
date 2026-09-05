# PLAN v20 — "PRODUCTION" hardening pass

Input: v19 TERMINAL (186/186 E2E green, but security-thin and with 11 known
issues). Goal: audit → fix → harden → verify, with ZERO regressions to
working v19 functionality. Priority order when requirements conflict:
correctness > safety > reliability > data preservation > compatibility >
maintainability > performance > features.

## Audit findings (all verified against the actual code)

| # | Issue | Status |
|---|---|---|
| 1 | `safePath()` = `path.resolve(cwd, p)` — no boundary, symlink, or sensitive-file validation | FIXED — full policy engine |
| 2 | `load_skill` name traversal (`../../x`) | FIXED — name validation + realpath containment |
| 3 | Shell safety = 6 regexes (`FORBIDDEN`) | REPLACED — structural shellguard engine |
| 4 | SSRF = hostname string regex (no DNS, no IPv6/private ranges, no rebinding) | FIXED — netguard resolves + validates every address |
| 5 | `tests/test-diffpatch.mjs` imports `../cli/forge/diffpatch.js` (dead path) | FIXED → `../forge/diffpatch.js` (13/13 green) |
| 6 | `tests/cleanroom-v19.sh` depends on a prior global `forge` | REPLACED by `cleanroom-v20.sh` — installs into an isolated temp npm prefix (45/45 green) |
| 7 | `delegate` misclassified as a WRITE tool → plan mode could not delegate | FIXED — read-only, roles, depth cap preserved |
| 8 | `forge chat/ask/agent` crash (`smartStart(cfg, null)`) when wizard aborted | FIXED — null guards in all three cases |
| 9 | timeout/cancellation paths | AUDITED — guard clamps fixed (ms<=0), delegate timeout added, Ctrl+C aborts /agent + /plan |
| 10 | session persistence/resume | UPGRADED — cwd/title/summary/usage persisted; `forge resume`; ts-ordered listing |
| 11 | compaction destroying task state | VERIFIED + STRENGTHENED — tiered shrink keeps history; overflow recovery keeps the session even on failure |

Additional bugs found during audit (not in the known list):
- Checkpoint undo could not remove files CREATED by an edit (apply_patch left
  created files behind) → created-file tracking with content-hash verification.
- `resolveSkillsDir()` "repo checkout" candidate computed `dirname(HERE)/../../skills`
  — wrong for the shipped `forge/` layout; could resolve a FOREIGN `skills/`
  directory from a parent folder → candidate order fixed.
- Chat history persistence vars referenced from the piped path (TDZ crash on
  every non-TTY chat) → restructured.
- `makeGuard` armed instantly with `connectMs <= 0` → clamped.

## New modules

| module | role |
|---|---|
| `shellguard.js` | command parsing (quote-aware split/tokenize), path-aware risk classification (safe/low/confirm/danger/block), model + user policies |
| `netguard.js` | SSRF guard: DNS resolution, every-address validation (IPv4+IPv6 private/loopback/link-local/CGNAT/metadata), rebinding-safe |
| `secrets.js` | redaction engine: token shapes (sk-, AKIA, ghp_, xox, AIza, JWT, private keys) + JSON/env credential assignments; applied to ALL tool results, memory writes, terminal notes |
| `memory.js` | hierarchical memory: global + project tiers, relevance-scored retrieval, structured failure learning |
| `profile.js` | project profile (langs, pm, scripts, git, frameworks) with signature-based cache refresh; resourceProfile (cores/RAM → tier) |

## Changed modules

- `tools.js` — safePath policy (boundary writes, sensitive reads, symlink + ~
  handling), shellguard in bash, netguard in fetch_url, redaction choke point in
  `execTool`, delegate (roles/timeout/concurrency/depth), memory scope+learn,
  checkpoint created-file tracking, WRITE_TOOLS fixed (no delegate)
- `checkpoint.js` — created-file manifests + sha verification, sealCreated()
- `chat.js` — per-turn context engine (profile + relevant memory + terminal
  notes), overflow recovery loop, session resume (cwd/usage/summary), persistent
  history, multiline input, /status, /profile, shellguard terminal flow with
  y/N confirm + FORGE_ASSUME_YES, abortable /agent + /plan, redacted notes
- `agent.js` — subAgent flag, role directives, adaptive effort (profile auto →
  complexity classifier), overflow recovery, maxToolCalls runaway guard,
  Retry-After-aware backoff, profile/memory/learnings in system prompt
- `providers.js` — contextOverflow detection (both wires), Retry-After capture,
  shared httpError(), guard clamp
- `sessions.js` — richer records, findSession(), ts ordering, titles
- `skills.js` — traversal-safe loadSkill + resolution order fix
- `forge.js` — `resume` command, `--profile` flag, doctor expansion
  (platform/RAM/terminal/git/dirs/project), null-provider guards, v20 help
- `config.js` — v20 defaults (tools.*, agent.*, chat.profile/restoreCwd/historySize)
- `package.json` — 20.0.0, `files` whitelist (drops pyc/PLAN cruft from installs)

## Test matrix (all green at the time of writing)

| suite | result |
|---|---|
| syntax (node --check, all 19 modules) | PASS |
| `tests/test-diffpatch.mjs` | 13/13 PASS |
| `tests/test-security.mjs` (v20 unit) | 128/128 PASS (launcher-isolated FORGE_HOME) |
| `tests/e2e-forge.sh` | 221/221 PASS (incl. 31 new v20 checks) |
| `tests/cleanroom-v20.sh` | 45/45 PASS (isolated npm prefix, no prior forge) |

New E2E coverage: SSRF default-block + opt-in, write-escape block, sensitive
read block, skill traversal block, bash outside-project block, failure learning
round-trip, created-file undo, terminal confirm/ASSUME_YES flow, context
overflow recovery, /status + /profile, sessions with title + `forge resume`
(cwd restore), export tool-call rendering, delegate timeout, terminal-note
redaction (verified on the wire via the mock's body recorder), plan-mode
delegation.

## Known limitations (honest)

- Shell parsing is a quote-aware tokenizer, not a full POSIX shell grammar;
  exotic constructs (heredocs, process substitution) are treated conservatively
  (confirm/danger bias) but are not "parsed".
- The task-complexity classifier is a transparent keyword heuristic, not a model.
- `delegate` sub-agent reports are capped by `maxToolOutput` like any tool.
- Sensitive-file read protection uses filename patterns; a secret renamed to
  `notes.txt` is not caught (redaction still applies to its CONTENT if it
  matches credential shapes).
- Model routing picks the configured/tested/free model (AutoPick); it does not
  benchmark latency across providers automatically.
