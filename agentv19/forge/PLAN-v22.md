# PLAN v22 — Tool Intelligence & Capability Layer

Status: **delivered in v20.5** (this document is the design record: what was
built, why it is shaped this way, what was deliberately *not* built, and what
remains open).

The premise: an agent does not get smarter by being handed more tools. It gets
smarter by **choosing the right tool, at the right time, with the right
arguments, at the lowest risk, and by proving the result**. Before v20.5 forge
had 17 good tools and a model that picked between them from a prompt; selection
knowledge was scattered across `agent.js`, `chat.js` and `tools.js`
(read-vs-write lists, parallel heuristics, ad-hoc retry). v20.5 replaces that
with one pipeline and one source of truth.

```
                       ┌──────────────────────────────────────┐
 task / model call ──► │ 1 capability registry  capabilities.js│
                       │ 2 tool router          router.js      │
                       │ 3 policy gate          toolintel.js   │
                       │ 4 SAFETY (unchanged)   shellguard /   │
                       │                        safepath /     │
                       │                        netguard /     │
                       │                        secrets        │
                       │ 5 execution            tools.js exec  │
                       │ 6 observation + state  toolintel.js   │
                       │ 7 verification         verify.js      │
                       │ 8 failure → recovery   diagnose.js    │
                       └──────────────────────────────────────┘
```

Five new modules, 2,379 lines, zero dependencies, no change to any existing
tool signature, security control, event name or CLI contract.

---

## 1. Capability registry — `capabilities.js` (672 lines)

One structured record per tool, and nothing about tool choice anywhere else:

| field | why it exists |
|---|---|
| `capabilities[]` | routing is by capability (`search`, `mutate_file`, `run_command`), never by hard-coded name lists |
| `class` | READ / WRITE / EXECUTE / NETWORK / SECURITY / VERIFICATION / RECOVERY |
| `risk` | baseline; the *operation* can raise it (see below) |
| `read_only` `reversible` `idempotent` | drive parallelism, undo expectations and "is a retry safe?" |
| `parallel_safe` | drive the batch scheduler |
| `requires_confirmation` `requires_network` `requires_filesystem` | drive the policy gate |
| `timeout` `cost` | drive the watchdog and cheap-alternative advice |
| `verification_required` `verify_after[]` | drive the verification contract |
| `preferred_for[]` `avoid_when[]` | the router's tie-breakers, expressed as data |
| `status` | `enabled` / `disabled` / `deprecated` / `experimental` (§19) |

Two invariants are asserted by tests, not by hope:

1. `read_only === !WRITE_TOOLS.has(name)` for every registered tool — the
   registry can never drift from `tools.js`.
2. Every tool exposed by `TOOL_DEFS` is registered, and every registered tool
   exists (plugins included).

**Risk is derived from the operation.** `operationRisk({name, args})` asks
shellguard to classify the actual command line rather than guessing from the
tool name: `echo hi` LOW, `npm test` LOW, `git commit` MEDIUM, `rm -rf build`
HIGH, `rm -rf /` CRITICAL; a write inside the project is MEDIUM, a write to a
sensitive path inherits the security engine's judgement. Where shellguard says
"confirm", the registry reports HIGH — we never soften an existing verdict.

## 2. Router — `router.js` (680 lines)

`route({task, state, available_tools, constraints, risk, context})` →
`{selected_tool, reason, arguments, execution_mode, verification_plan, chain}`.

- `analyzeTask()` extracts intent (inspect / locate / modify / execute / verify
  / recover / research / plan) plus paths, symbols and scope from the text.
- `planChain()` builds the **smallest effective chain** for that intent and then
  *removes* steps whose answer the run already has (a file already read, a
  search already performed) — recorded as a skip reason, so the reduction is
  auditable.
- Constraints are hard filters: `readOnly` removes every WRITE/EXECUTE tool,
  no-network removes NETWORK tools, a `maxRisk` ceiling removes anything above
  it, `disabled`/`deprecated` are avoided, unavailable tools drop out. If a step
  exists but every candidate is filtered away the mode is `blocked`, never a
  silent "none".
- `planExecution(calls)` schedules a batch: read-only + parallel-safe + no
  target conflict ⇒ one concurrent group; anything else serializes; two writes
  to the same target are reported as a conflict.
- `nextAction(failure, ctx)` is the result-aware half: it only speaks when it
  has something specific to say, so the model never receives generic noise.
- `toolGuidance(task)` renders the compact TOOL POLICY block injected into the
  agent system prompt — generated from the registry, so the prompt cannot drift
  from reality.

## 3. Policy gate & safety — `toolintel.js` (502 lines)

Order is deliberate: **policy first, then the existing security engine, then
execution.** The gate can only ever *add* a refusal; it cannot grant anything
shellguard/safepath/netguard would refuse, and it never re-implements their
checks. The read-only agent message is byte-identical to v20.4 so downstream
tests and users see no change.

Then: execute → classify → record → verify → advise.

- **Watchdog** — read-only tools only (`max(1s, timeout × 1.5)`); abandoning a
  half-finished write is worse than waiting for a slow one.
- **Repeat guard** — the same tool with the same `arguments_hash` that has
  already failed twice is refused with the reason and a concrete alternative.
- **Idempotency** — an edit whose replacement is already present is an
  `idempotent no-op`; `mkdir -p` of an existing directory is "already done".
- **Cache** — identical reads are served from memory, keyed by argument hash
  and invalidated by mtime *and* by any mutation or any `bash` call (because
  `echo x > f` is a mutation that looks like a read).
- **Retry** — exactly one automatic retry, only for idempotent read-only tools,
  only for TIMEOUT/NETWORK_FAILURE.
- **State** — `{tool_call_id, task_id, run_id, tool, arguments_hash, started_at,
  duration_ms, status, result, error, failure, files_changed, checkpoint,
  verification, cached, retried}` per call, flowing into the run journal,
  checkpoints and sessions that already existed.
- **Events** — `TOOL_SELECTED`, `TOOL_STARTED`, `TOOL_OUTPUT`, `TOOL_COMPLETED`,
  `TOOL_FAILED`, `TOOL_RETRY`, `TOOL_FALLBACK`, `TOOL_BLOCKED`, `TOOL_VERIFIED`
  (+ `TOOL_CACHED`). Legacy `tool_start` / `tool_result` are still emitted, so
  every existing consumer keeps working.

## 4. Verification — `verify.js` (266 lines)

Verification is a contract attached to the mutation, proportional to risk:

| operation | proof |
|---|---|
| edit / multi_edit / write_file | the new content is really there **and** the file still parses (`node --check` for JS/MJS/CJS, `JSON.parse` for JSON) |
| apply_patch | every touched file exists in the expected state |
| mkdir / delete | the filesystem shows the intended end state |
| high-risk change | *recommends* the project's test/build command — surfaced to the agent, executed through the normal bash tool, never run behind the user's back |

Unknown file types are reported as **skipped**, never as failures. Checks are
local and offline; a failed check marks the record `failed` and tells the model
what broke, which is what converts "I edited the file" into "the edit works".

## 5. Failure taxonomy & recovery — `diagnose.js` (259 lines)

`INVALID_ARGUMENT · NOT_FOUND · PERMISSION_DENIED · TIMEOUT · NETWORK_FAILURE ·
DEPENDENCY_FAILURE · SYNTAX_FAILURE · TEST_FAILURE · BUILD_FAILURE ·
SAFETY_BLOCK · CANCELLED · UNKNOWN`, each mapped to an ordered strategy:
retry-once (idempotent only) → reduce scope → alternate tool → fix arguments →
escalate → abort. A SAFETY_BLOCK never suggests a retry; a TEST_FAILURE narrows
to the failing test; a DEPENDENCY_FAILURE asks before installing.

**Escalation (§17)** is a function, not a vibe: `shouldEscalate()` returns a
real question only for permission/credential decisions, irreversible high-risk
operations, dependency additions, and strategies that have already failed —
so "ask the human" stays rare enough to still mean something.

## 6. Integration (§21)

`agent.js` and `chat.js` both execute their tool batches through
`createToolIntel(...).runBatch(...)` — one implementation, no competing copies.
The registry feeds the system prompt; the events feed `uistate.js` (tool rows,
the VERIFICATION panel, notices for blocked/retried/cached calls) and
`runlog.js`; checkpoints, sessions, memory, plans, repo map, retrieval and
provider failover are untouched consumers that keep working. `forge tools`
exposes the whole layer from the shell. Plugins self-register (§18) with
conservative defaults.

## 7. What was deliberately not built

- **No LLM-based router.** Selection must be deterministic, testable and free.
- **No automatic `npm test` after every write.** Verification is local and
  cheap; running the suite is *recommended* to the agent, not performed by the
  tool layer.
- **No new sandbox or permission model.** The existing security architecture is
  the authority; the layer routes into it.
- **No parallel writes**, ever — not even "probably disjoint" ones.

## 8. Tests (§22)

| suite | checks | covers |
|---|---|---|
| `test-capabilities.mjs` | 81 | registration, completeness, WRITE_TOOLS invariant, class/risk classification, operation risk, lifecycle, plugin registration, cost, parallel-safety |
| `test-router.mjs` | 83 | intent analysis, smallest chain, context skipping, constraints, `route()` contract, scheduling & conflicts, cost awareness, result-aware next action, guidance rendering |
| `test-toolintel.mjs` | 141 | security integration, secret redaction, read-only enforcement, policy gate, failure classification, recovery, timeout/watchdog, repeat guard, idempotency, cache invalidation, verification pass/fail, escalation, state records, all events, UI bridge, plugin execution, and the `tools.intelligence:false` regression path |

Plus the 22 pre-existing suites, unchanged and green.

## 9. Open items (v22+)

1. **Learned preferences** — persist per-project routing outcomes in memory so
   that "grep first, then read" adapts to a repo where it never pays off.
2. **Verification for more ecosystems** — `python -m py_compile`, `tsc --noEmit`
   when the project already provides them (still local, still offline).
3. **Cross-run cost accounting** — the registry knows relative cost; the run
   journal could report the cheapest chain that would have worked.
4. **Router explanations in the UI** — the chain and skip reasons exist as data;
   the terminal workstation currently shows only the one-line summary.
