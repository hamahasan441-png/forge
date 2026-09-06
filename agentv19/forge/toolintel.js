/**
 * forge — tool execution intelligence (v20.5, zero dependencies)
 *
 * The pipeline every autonomous tool call goes through (§20):
 *
 *   TOOL ROUTING            router.js decided (or the model asked directly)
 *        ↓
 *   CAPABILITY RESOLUTION   capabilities.js — what IS this tool
 *        ↓
 *   RISK CLASSIFICATION     operationRisk() on the ACTUAL arguments
 *        ↓
 *   SAFETY / PERMISSION     policy gate here + the EXISTING controls inside
 *                           execTool (ShellGuard, SafePath, NetGuard, secret
 *                           redaction). This layer never re-implements or
 *                           relaxes them — it can only refuse earlier.
 *        ↓
 *   EXECUTION               tools.exec (unchanged)
 *        ↓
 *   OBSERVATION             failure classification (diagnose.js)
 *        ↓
 *   STATE UPDATE            per-call record (§15) + cache invalidation
 *        ↓
 *   VERIFICATION            verify.js, proportional to risk (§13)
 *        ↓
 *   SUCCESS │ FAILURE → DIAGNOSE → CHANGE STRATEGY → REPAIR → VERIFY
 *
 * Everything it adds is additive: with `tools.intelligence: false` the call
 * path is exactly the pre-v20.5 one (execute, return the string).
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { createRegistry, registerPlugins, operationRisk, classifyCall, RISK, STATUS, riskRank, maxRisk } from "./capabilities.js"
import { planExecution, cheaperAlternative, nextAction, targetsOf, repeatedFailures, route } from "./router.js"
import { classifyFailure, recoveryPlan, formatDiagnosis, shouldEscalate, FAILURE } from "./diagnose.js"
import { verificationPlan, runVerification, formatVerification, verifyTargets } from "./verify.js"
import { redact } from "./secrets.js"
import { listCheckpoints } from "./checkpoint.js"

/** Structured events (§16) — the UI renders them, the tests assert them. */
export const TOOL_EVENTS = [
  "TOOL_SELECTED", "TOOL_STARTED", "TOOL_OUTPUT", "TOOL_COMPLETED", "TOOL_FAILED",
  "TOOL_RETRY", "TOOL_FALLBACK", "TOOL_BLOCKED", "TOOL_VERIFIED", "TOOL_CACHED",
  "TOOL_ESCALATION",
]

const CACHE_MAX_BYTES = 256 * 1024
const CACHE_MAX_ENTRIES = 64
const NON_CACHEABLE = new Set(["think", "todo", "memory", "delegate", "web_search", "fetch_url", "bash"])

/** Order-independent, DEEP serialization. (v20.5.1: the first implementation
 *  passed a key allow-list to JSON.stringify, which silently erased nested
 *  objects — two completely different multi_edit calls hashed identically and
 *  could be refused as "already failed twice". Never use a replacer array.) */
function stableStringify(value, depth = 0) {
  if (value === null || typeof value !== "object" || depth > 6) return JSON.stringify(value ?? null) ?? "null"
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v, depth + 1)).join(",")}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k], depth + 1)}`).join(",")}}`
}

export function argsHash(name, args) {
  let payload
  try { payload = stableStringify(args ?? {}) } catch { payload = String(args) }
  return crypto.createHash("sha256").update(`${name}\u0000${payload}`).digest("hex").slice(0, 16)
}

/**
 * @param exec       (name, args) => Promise<string>  — tools.exec, unchanged
 * @param ctx        { cwd, root, readOnly, allowSudo, assumeYes }
 * @param config     forge config (tools.intelligence / tools.verify / tools.cache /
 *                   tools.maxRisk / tools.disabled / tools.deprecated)
 * @param onEvent    receives BOTH the structured events above and, when
 *                   legacyEvents is on, the classic tool_start / tool_result
 *                   the agent loop and the terminal UI already understand.
 */
export function createToolIntel({
  exec,
  ctx = {},
  config = {},
  onEvent = null,
  runId = null,
  taskId = null,
  plugins = [],
  registry = null,
  legacyEvents = true,
  journal = null,
  task = "",
} = {}) {
  const cfg = config?.tools ?? {}
  const enabled = cfg.intelligence !== false
  const verifyOn = enabled && cfg.verify !== false
  const cacheOn = enabled && cfg.cache !== false
  const maxRiskCeiling = cfg.maxRisk ?? null
  const reg = registry ?? createRegistry({ config })
  if (plugins?.length) registerPlugins(reg, plugins)

  const cwd = ctx.cwd ?? process.cwd()
  const records = []
  const cache = new Map()
  let generation = 0 // bumped by every mutation → invalidates cached reads
  let seq = 0

  const emit = (ev) => { try { onEvent?.(ev) } catch { /* observability must never break execution */ } }

  function mutationHappened(name) {
    generation++
    if (cache.size) cache.clear()
    void name
  }

  function cacheKey(name, hash) { return `${name}:${hash}` }

  /**
   * §11 context awareness — what this run ALREADY knows, in the shape the
   * router expects. Without this the "skip steps we already answered" logic
   * could only ever fire in tests: nothing was feeding it real state.
   */
  function derivedState() {
    const readFiles = []
    const knownFiles = []
    let testsJustPassed = false
    for (const r of records) {
      if (r.status !== "ok") continue
      if (r.tool === "read_file" && r.arguments_summary) readFiles.push(r.arguments_summary)
      if (r.tool === "grep_files" || r.tool === "glob_files" || r.tool === "list_dir") knownFiles.push(...(r.discovered ?? []))
      for (const f of r.files_changed ?? []) knownFiles.push(f)
      if (r.tool === "bash" && /\b(test|jest|vitest|pytest|cargo test|go test)\b/.test(r.arguments_summary ?? "")) testsJustPassed = true
      if (!r.read_only_call && r.mutation) testsJustPassed = false
    }
    return {
      readFiles: [...new Set(readFiles)].slice(-20),
      knownFiles: [...new Set([...knownFiles, ...readFiles])].slice(-40),
      testsJustPassed,
    }
  }

  function cacheable(meta, name) {
    if (!cacheOn) return false
    if (NON_CACHEABLE.has(name)) return false
    return meta.read_only === true && meta.idempotent === true
  }

  function targetMtime(name, args) {
    const t = targetsOf(name, args, cwd).filter((x) => x !== "*" && !x.startsWith("#"))
    const out = []
    for (const p of t.slice(0, 4)) {
      try { out.push(`${p}:${fs.statSync(p).mtimeMs}`) } catch { out.push(`${p}:none`) }
    }
    return out.join("|")
  }

  /** Policy gate — runs BEFORE the existing security controls, never instead
   *  of them. Returns null when the call may proceed. */
  function gate(name, args, meta, risk) {
    if (meta.status === STATUS.DISABLED) {
      return `BLOCKED: tool "${name}" is disabled by policy (tools.disabled) — use another tool for ${meta.capabilities[0] ?? "this capability"}.`
    }
    // identical to the v16..v20.4 read-only guard (string kept byte-for-byte)
    if (ctx.readOnly && !meta.read_only) return "BLOCKED: write tools are disabled in this read-only agent"
    if (maxRiskCeiling && riskRank(risk) > riskRank(maxRiskCeiling)) {
      return `BLOCKED: operation risk ${risk} exceeds the configured ceiling (tools.maxRisk=${maxRiskCeiling}) — narrow the operation or ask the user.`
    }
    // §8/§14 — never blindly repeat a call that already failed the same way
    if (!enabled) return null
    const hash = argsHash(name, args)
    const priors = records.filter((r) => r.tool === name && r.arguments_hash === hash && r.status === "failed")
    const hard = priors.filter((r) => r.failure && r.failure !== FAILURE.TIMEOUT && r.failure !== FAILURE.NETWORK_FAILURE)
    if (hard.length >= 2) {
      const last = hard[hard.length - 1]
      const plan = recoveryPlan(last.failure, { tool: name, attempts: hard.length, idempotent: meta.idempotent })
      const esc = shouldEscalate({ code: last.failure, attempts: hard.length, tool: name, blockedRepeat: true })
      return `BLOCKED: ${name} already failed ${hard.length}× with identical arguments (${last.failure}: ${last.error ?? "see previous result"}). Repeating it cannot succeed — change strategy: ${plan.summary}.${esc.escalate ? `\n[forge] ask the user: ${esc.question}` : ""}`
    }
    return null
  }

  /** Run ONE tool call through the full pipeline. */
  async function runCall(call, { step = 0, reason = "", mode = "serial", attempt = 0 } = {}) {
    const name = String(call?.name ?? "")
    const args = call?.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {}
    const callId = call?.id ?? `tc-${++seq}-${Math.random().toString(36).slice(2, 6)}`
    const meta = reg.resolve(name)
    const hash = argsHash(name, args)
    const op = operationRisk(name, args, { ...ctx, cwd, registry: reg })
    const cls = classifyCall(name, args, { ...ctx, cwd, registry: reg })
    const t0 = Date.now()

    const record = {
      tool_call_id: callId,
      task_id: taskId,
      run_id: runId,
      tool: name,
      capability: meta.capabilities[0] ?? "unknown",
      klass: cls.klass,
      arguments_hash: hash,
      arguments_summary: summarizeArgs(name, args),
      risk: op.risk,
      mutation: !meta.read_only,
      read_only_call: meta.read_only === true,
      execution_mode: mode,
      start_time: t0,
      end_time: null,
      status: "running",
      result: null,
      error: null,
      failure: null,
      files_changed: [],
      verification: null,
      checkpoint: null,
      attempt,
      cached: false,
      step,
    }

    emit({
      type: "TOOL_SELECTED", tool: name, callId, taskId, runId, step,
      capability: record.capability, klass: cls.klass, risk: op.risk, mode,
      reason: reason || `model-selected • ${op.reasons[0] ?? meta.description}`,
      read_only: meta.read_only, status: meta.status,
    })
    if (meta.status === STATUS.DEPRECATED) {
      emit({ type: "TOOL_FALLBACK", tool: name, callId, reason: `${name} is deprecated — no compatible alternative was available`, step })
    }

    // ---- gate -------------------------------------------------------------
    const blocked = gate(name, args, meta, op.risk)
    if (blocked) {
      const result = blocked
      finish(record, { status: "blocked", result, failure: FAILURE.SAFETY_BLOCK, ms: Date.now() - t0 })
      emit({ type: "TOOL_BLOCKED", tool: name, callId, taskId, runId, step, reason: result, risk: op.risk })
      if (legacyEvents) {
        emit({ type: "tool_start", name, args: JSON.stringify(args), step })
        emit({ type: "tool_result", name, result, step, ms: 0 })
      }
      return { result, ms: 0, record }
    }

    // ---- cache (§11) ------------------------------------------------------
    const key = cacheKey(name, hash)
    if (cacheable(meta, name)) {
      const hit = cache.get(key)
      if (hit && hit.generation === generation && hit.mtime === targetMtime(name, args)) {
        record.cached = true
        finish(record, { status: "ok", result: hit.result, ms: 0 })
        emit({ type: "TOOL_CACHED", tool: name, callId, step, reason: "identical read already answered in this run — no re-execution" })
        if (legacyEvents) {
          emit({ type: "tool_start", name, args: JSON.stringify(args), step })
          emit({ type: "tool_result", name, result: hit.result, step, ms: 0, cached: true })
        }
        return { result: hit.result, ms: 0, record }
      }
    }

    // ---- execute ----------------------------------------------------------
    if (legacyEvents) emit({ type: "tool_start", name, args: JSON.stringify(args), step })
    emit({ type: "TOOL_STARTED", tool: name, callId, taskId, runId, step, args: summarizeArgs(name, args), risk: op.risk, mode })

    let raw
    let threw = false
    try {
      raw = await withWatchdog(() => exec(name, args), meta, ctx)
    } catch (e) {
      threw = true
      raw = `ERROR: ${e?.message ?? e}`
    }
    let result = typeof raw === "string" ? raw : JSON.stringify(raw ?? null)
    let ms = Date.now() - t0

    // ---- observation (§9) -------------------------------------------------
    let d = classifyFailure(result, { tool: name, args, thrown: threw, idempotent: meta.idempotent })

    // safe, bounded auto-retry for transient failures on idempotent reads.
    // (v20.5.1: the abandoned attempt is RECORDED before retrying — a retry
    //  that leaves no trace is invisible in stats, records and the journal.)
    if (d.failed && d.safeToRetry && meta.read_only && attempt < 1) {
      record.retried = true
      finish(record, { status: "failed", result, failure: d.code, error: redact(d.evidence), ms })
      emit({ type: "TOOL_FAILED", tool: name, callId, taskId, runId, step, code: d.code, evidence: redact(String(d.evidence ?? "")).slice(0, 200), ms, willRetry: true })
      emit({ type: "TOOL_RETRY", tool: name, callId, step, attempt: attempt + 1, reason: `${d.code}: ${d.evidence}`.slice(0, 200) })
      const again = await runCall({ ...call, id: `${callId}#r1` }, { step, reason: `retry after ${d.code}`, mode, attempt: attempt + 1 })
      return { ...again, ms: ms + (again.ms ?? 0) }
    }

    // §14 — an edit whose replacement is already in place is a completed
    // operation, not a failure. Detect it instead of looping.
    if (d.failed && (name === "edit_file" || name === "multi_edit") && d.code === FAILURE.NOT_FOUND) {
      const already = alreadyApplied(name, args, cwd)
      if (already) {
        result = `OK (idempotent no-op): ${already} — the change is already present, nothing was rewritten.\n[original tool result] ${result}`
        d = classifyFailure(result, { tool: name, args })
        record.idempotent_noop = true
      }
    }

    const idemNote = !d.failed ? null : idempotencyNote(name, args, result)
    if (idemNote) result += `\n[forge] ${idemNote}`

    // ---- state update -----------------------------------------------------
    // what a discovery tool FOUND is context for the next routing decision
    if (!d.failed && (name === "grep_files" || name === "glob_files" || name === "list_dir")) {
      record.discovered = discoveredPaths(result)
    }
    if (!d.failed && !meta.read_only) {
      mutationHappened(name)
      record.files_changed = verifyTargets(name, args, cwd).map((p) => rel(p, cwd))
      try {
        const ck = listCheckpoints(cwd, 1)[0]
        // only attribute a checkpoint that this call actually created: the
        // right run AND newer than the call start (chat runs have no runId)
        if (ck && (!runId || ck.runId === runId) && Number(ck.ts) >= t0 - 1500) record.checkpoint = ck.id
      } catch { /* checkpoints are best-effort */ }
    }

    // ---- verification (§13) ----------------------------------------------
    let vplan = null
    let vres = null
    if (!d.failed && verifyOn && !meta.read_only) {
      vplan = verificationPlan(name, args, { risk: op.risk, registry: reg, cwd, meta })
      if (vplan.required) {
        vres = await runVerification(vplan, { cwd })
        record.verification = { plan: vplan.summary, ok: vres.ok, checks: vres.checks, recommended: vres.recommended, summary: vres.summary }
        const line = formatVerification(vres)
        if (line) result += `\n${line}`
        emit({
          type: "TOOL_VERIFIED", tool: name, callId, taskId, runId, step,
          ok: vres.ok, checks: vres.checks, summary: vres.summary,
          recommended: vres.recommended.map((r) => r.kind),
        })
        if (!vres.ok) {
          d = { failed: true, code: FAILURE.SYNTAX_FAILURE, evidence: vres.summary, transient: false, retryable: false, safeToRetry: false }
        }
      } else if (vplan.checks.length) {
        record.verification = { plan: vplan.summary, ok: null, checks: [], recommended: vplan.checks.filter((c) => c.executor === "agent").map((c) => ({ kind: c.kind, why: c.why })), summary: "recommended only" }
      }
    }

    // ---- failure hint + cheaper-path advice --------------------------------
    // (advice only — with `tools.intelligence: false` the raw tool string is
    //  returned exactly as pre-v20.5 forge returned it)
    if (d.failed && enabled) {
      const plan = recoveryPlan(d.code, { tool: name, attempts: repeatedFailures(records, { tool: name, argsHash: hash }), idempotent: meta.idempotent })
      const hint = formatDiagnosis({ ...d, plan })
      if (hint) result += `\n${redact(hint)}`
      // §17 — ask a human only where human judgement actually helps
      const esc = shouldEscalate({
        code: d.code,
        attempts: repeatedFailures(records, { tool: name, argsHash: hash }),
        risk: op.risk,
        reversible: meta.reversible,
        tool: name,
      })
      if (esc.escalate) {
        result += `\n[forge] ask the user: ${esc.question}`
        // an escalation is a REQUEST for judgement, not a refusal — the UI must
        // not render it as "blocked" (v20.5.1)
        emit({ type: "TOOL_ESCALATION", tool: name, callId, taskId, runId, step, question: esc.question, why: esc.why, code: d.code })
      }
      const alt = nextAction({ task, history: records, lastResult: { tool: name, argsHash: hash, failure: d.code, status: "failed" }, registry: reg, context: { cwd } })
      if (alt?.specific && alt.tool && alt.tool !== name) {
        emit({ type: "TOOL_FALLBACK", tool: name, callId, step, alternative: alt.tool, reason: alt.why })
        result += `\n[forge] next: ${alt.tool} — ${alt.why}`
      }
    } else if (enabled) {
      const cheaper = cheaperAlternative(name, args, { registry: reg, ctx: { cwd } })
      if (cheaper) {
        emit({ type: "TOOL_FALLBACK", tool: name, callId, step, alternative: cheaper.tool, reason: cheaper.why })
        result += `\n[forge] cheaper next time: ${cheaper.tool} — ${cheaper.why}`
      }
    }

    ms = Date.now() - t0
    finish(record, { status: d.failed ? "failed" : "ok", result, failure: d.failed ? d.code : null, error: d.failed ? redact(d.evidence) : null, ms })

    // ---- cache store ------------------------------------------------------
    if (!d.failed && cacheable(meta, name) && result.length <= CACHE_MAX_BYTES) {
      if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value)
      cache.set(key, { result, generation, mtime: targetMtime(name, args), at: Date.now() })
    }

    emit({ type: "TOOL_OUTPUT", tool: name, callId, step, bytes: result.length, lines: result.split("\n").length })
    if (d.failed && d.code === FAILURE.SAFETY_BLOCK) emit({ type: "TOOL_BLOCKED", tool: name, callId, taskId, runId, step, reason: redact(String(d.evidence ?? "")).slice(0, 200), risk: op.risk, bySafetyControl: true })
    else if (d.failed) emit({ type: "TOOL_FAILED", tool: name, callId, taskId, runId, step, code: d.code, evidence: redact(String(d.evidence ?? "")).slice(0, 200), ms })
    else emit({ type: "TOOL_COMPLETED", tool: name, callId, taskId, runId, step, ms, bytes: result.length, verified: record.verification?.ok ?? null, files: record.files_changed })
    if (legacyEvents) emit({ type: "tool_result", name, result, step, ms })

    try { journal?.tool?.(name, summarizeArgs(name, args), !d.failed) } catch { /* journal is best-effort */ }
    return { result, ms, record }
  }

  function finish(record, { status, result, failure = null, error = null, ms = 0 }) {
    record.status = status
    record.end_time = record.start_time + ms
    record.duration_ms = ms
    // defence in depth: tools.js already redacts every model-facing result, but
    // the RECORD is also surfaced (--json, FORGE_DEBUG, run inspection), so it
    // is redacted here too — a stored secret is a leaked secret.
    record.result = typeof result === "string" ? redact(result.slice(0, 400)) : null
    record.failure = failure
    record.error = error
    records.push(record)
    if (records.length > 500) records.splice(0, records.length - 500)
  }

  /**
   * Run a batch of tool calls the way the router says they may run:
   * independent read-only calls concurrently, everything else serialized in
   * the original order. Results come back index-aligned with `calls`.
   */
  async function runBatch(calls = [], { step = 0 } = {}) {
    const list = calls.map((c) => ({ id: c.id ?? null, name: c.name, args: c.args ?? {} }))
    const out = new Array(list.length)
    if (!list.length) return out
    if (!enabled) {
      // legacy path: reads parallel, writes serial (v16 behaviour), no extras
      const plan = planExecution(list, { registry: reg, ctx: { cwd } })
      return runPlan(plan, list, out, step)
    }
    const plan = planExecution(list, { registry: reg, ctx: { cwd } })
    for (const c of plan.conflicts.slice(0, 3)) {
      emit({ type: "TOOL_BLOCKED", tool: list[c.a]?.name, callId: null, step, conflict: true, serialized: true, reason: c.note })
      if (legacyEvents) emit({ type: "info", text: c.note })
    }
    return runPlan(plan, list, out, step)
  }

  async function runPlan(plan, list, out, step) {
    for (const batch of plan.batches) {
      if (batch.mode === "parallel" && batch.calls.length > 1) {
        await Promise.all(
          batch.calls.map(async (item) => {
            out[item.index] = await runCall(list[item.index], { step, mode: "parallel", reason: "read-only, parallel-safe, no target conflict" })
          })
        )
      } else {
        for (const item of batch.calls) {
          out[item.index] = await runCall(list[item.index], {
            step,
            mode: batch.mode === "parallel" ? "parallel" : "serial",
            reason: item.serializedBecause ?? (item.cls.read_only ? "read-only but not parallel-safe (shared state)" : "mutation — serialized"),
          })
        }
      }
    }
    return out
  }

  /**
   * §19 — never ADVERTISE a tool the policy would refuse. A disabled tool that
   * still appears in the request only teaches the model to call it and collect
   * a BLOCKED string; experimental tools disappear when the project opted out.
   * Deprecated tools stay (they are a last resort, not a refusal).
   */
  function toolDefs(defs = []) {
    if (!Array.isArray(defs)) return defs
    const allowExperimental = cfg.experimental !== false
    const out = defs.filter((d) => {
      const name = d?.function?.name
      if (!name) return true
      const m = reg.get(name)
      if (!m) return true
      if (m.status === STATUS.DISABLED) return false
      if (!allowExperimental && m.status === STATUS.EXPERIMENTAL) return false
      return true
    })
    return out.length ? out : defs
  }

  return {
    registry: reg,
    enabled,
    runCall,
    runBatch,
    toolDefs,
    plan: (calls) => planExecution(calls, { registry: reg, ctx: { cwd } }),
    route: (t, opts = {}) =>
      route({
        ...opts,
        task: t ?? task,
        registry: reg,
        state: { ...derivedState(), ...(opts.state ?? {}) },
        context: { cwd, ...(opts.context ?? {}) },
      }),
    next: (opts = {}) => nextAction({ task, history: records, registry: reg, context: { cwd, state: derivedState() }, ...opts }),
    state: derivedState,
    records: () => records.slice(),
    stats,
    invalidate: () => mutationHappened("manual"),
    cacheSize: () => cache.size,
  }

  function stats() {
    const s = { calls: records.length, ok: 0, failed: 0, blocked: 0, cached: 0, verified: 0, verifyFailed: 0, byTool: {}, byFailure: {}, ms: 0 }
    for (const r of records) {
      const bucket = r.status === "ok" ? "ok" : r.status === "blocked" || r.failure === FAILURE.SAFETY_BLOCK ? "blocked" : "failed"
      s[bucket]++
      if (r.cached) s.cached++
      if (r.verification?.ok === true) s.verified++
      if (r.verification?.ok === false) s.verifyFailed++
      s.ms += r.duration_ms ?? 0
      s.byTool[r.tool] = (s.byTool[r.tool] ?? 0) + 1
      if (r.failure) s.byFailure[r.failure] = (s.byFailure[r.failure] ?? 0) + 1
    }
    return s
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Outer watchdog for read-only tools that have no timeout of their own.
 *  Write tools are never abandoned mid-flight — a half-applied mutation with
 *  no result is worse than a slow one. */
function withWatchdog(fn, meta, ctx) {
  const p = Promise.resolve().then(fn)
  const seconds = Number(meta?.timeout) > 0 ? Number(meta.timeout) : 60
  if (!meta?.read_only || ctx?.watchdog === false) return p
  const ms = Math.max(1000, Math.round(seconds * 1500))
  return new Promise((resolve, reject) => {
    let done = false
    // NOT unref'd: a watchdog that lets the process exit is not a watchdog.
    // It is always cleared when the call settles, so it never holds the loop.
    const t = setTimeout(() => {
      if (done) return
      done = true
      resolve(`ERROR: ${meta.name} timed out after ${Math.round(ms / 1000)}s (tool watchdog) — reduce the scope of the call`)
    }, ms)
    p.then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve(v) } },
      (e) => { if (!done) { done = true; clearTimeout(t); reject(e) } }
    )
  })
}

/** Was this edit already applied? (§14 idempotency) */
function alreadyApplied(name, args, cwd) {
  try {
    const file = args?.path ? path.resolve(cwd, String(args.path)) : null
    if (!file || !fs.existsSync(file)) return null
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return null
    const text = fs.readFileSync(file, "utf8")
    if (name === "edit_file") {
      const oldS = String(args.old ?? "")
      const newS = String(args.new ?? "")
      if (newS && !text.includes(oldS) && text.includes(newS)) return `${path.relative(cwd, file) || file} already contains the replacement text`
      return null
    }
    const edits = Array.isArray(args.edits) ? args.edits : []
    if (!edits.length) return null
    const allApplied = edits.every((e) => {
      const o = String(e?.old ?? "")
      const n = String(e?.new ?? "")
      return n && !text.includes(o) && text.includes(n)
    })
    return allApplied ? `${path.relative(cwd, file) || file} already contains every replacement` : null
  } catch {
    return null
  }
}

/** Recognisable "this was already done" signals in command output (§14). */
function idempotencyNote(name, args, result) {
  if (name !== "bash") return null
  const cmd = String(args?.command ?? "")
  const out = String(result ?? "")
  if (/\bmkdir\b/.test(cmd) && /File exists|already exists/i.test(out)) return "idempotency: the directory already exists — treat this as done, do not retry"
  if (/\b(npm|pnpm|yarn) (i|install|add)\b/.test(cmd) && /up to date|already installed/i.test(out)) return "idempotency: the dependency is already installed — no action needed"
  if (/\bgit (apply|am)\b/.test(cmd) && /patch does not apply|already applied|reverse/i.test(out)) return "idempotency: the patch may already be applied — verify the file state before re-applying"
  if (/\bln -s\b/.test(cmd) && /File exists/i.test(out)) return "idempotency: the symlink already exists"
  return null
}

/** Paths a discovery tool reported — `path:line: text` (grep) or one per line. */
function discoveredPaths(result) {
  const out = []
  for (const line of String(result ?? "").split("\n")) {
    const l = line.trim()
    if (!l || l.startsWith("[") || l.startsWith("(")) continue
    const m = /^([^\s:]+\.[A-Za-z][\w]{0,7})(?::\d+:|$)/.exec(l)
    if (m) out.push(m[1])
    if (out.length >= 20) break
  }
  return [...new Set(out)]
}

function summarizeArgs(name, args) {
  const a = args ?? {}
  const t = a.path ?? a.command ?? a.pattern ?? a.url ?? a.query ?? a.name ?? a.action ?? a.task ?? ""
  return redact(String(t).split("\n")[0].slice(0, 160))
}

function rel(p, cwd) {
  const r = path.relative(cwd, p)
  return r && !r.startsWith("..") ? r : p
}

export { FAILURE, RISK, STATUS, maxRisk }
