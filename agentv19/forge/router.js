/**
 * forge — tool router (v20.5 tool intelligence layer, zero dependencies)
 *
 * The single place that answers, for one concrete situation:
 *
 *   "What capability is required?  Which tool provides it?  Is it safe?
 *    Can it run now?  Can it run in parallel?  What evidence do I need?"
 *
 * Input  : task, current_state, available_tools, constraints, risk, context
 * Output : selected_tool, reason, arguments, execution_mode, verification_plan
 *          (+ the chain it belongs to, and the alternatives that lost)
 *
 * Two independent jobs live here:
 *
 *   1. PLANNING     — analyzeTask() → planChain() → route(): what SHOULD run,
 *                     in the smallest chain that can actually finish the task.
 *                     `read the config` is one read_file, not a five-tool
 *                     discovery dance; `fix the failing auth test` is a real
 *                     chain (inspect → locate → inspect deps → edit → focused
 *                     test → regression).
 *
 *   2. SCHEDULING   — planExecution(): given the tool calls a model actually
 *                     emitted, which may run concurrently (read-only, parallel
 *                     safe, no target conflict) and which must be serialized.
 *
 * The router NEVER executes anything and never bypasses a safety control — it
 * produces decisions that toolintel.js runs through the existing gates.
 */
import path from "node:path"
import fs from "node:fs"
import {
  CLASS, RISK, RISK_ORDER, riskRank, maxRisk, STATUS, CAPABILITY,
  operationRisk, classifyCall, costScore,
} from "./capabilities.js"
import { verificationPlan } from "./verify.js"

// ---------------------------------------------------------------------------
// 1. task analysis (§3)
// ---------------------------------------------------------------------------

export const INTENT = {
  DISCOVER: "discover",
  INSPECT: "inspect",
  MODIFY: "modify",
  EXECUTE: "execute",
  VERIFY: "verify",
  RESEARCH: "research",
  RECOVER: "recover",
  EXPLAIN: "explain",
  REMEMBER: "remember",
}

const SIGNALS = [
  [INTENT.RECOVER, /\b(failing|fails?|failed|broken|crash(es|ing)?|error|exception|stack ?trace|regression|bug|not working|doesn'?t work|red test)\b/],
  [INTENT.MODIFY, /\b(fix|add|implement|create|write|refactor|rename|update|change|modify|remove|delete|migrate|port|introduce|extract|replace|support|wire up|hook up)\b/],
  [INTENT.DISCOVER, /\b(find|where|locate|which file|search|look for|discover|list all|who calls|references?|usages?)\b/],
  [INTENT.VERIFY, /\b(test|tests|verify|check|typecheck|lint|build|compile|ci|coverage)\b/],
  [INTENT.EXECUTE, /\b(run|execute|start|install|npm |yarn |pnpm |make |script)\b/],
  [INTENT.RESEARCH, /\b(docs?|documentation|api reference|changelog|release notes|upstream|internet|online|google|latest version)\b/],
  [INTENT.EXPLAIN, /\b(explain|describe|summar|what does|how does|why does|walk me through|understand)\b/],
  [INTENT.INSPECT, /\b(read|show|open|inspect|print|cat|look at|review|view)\b/],
  [INTENT.REMEMBER, /\b(remember|note that|from now on|convention|preference)\b/],
]

const FILE_RE = /(?:^|[\s"'`(=])((?:\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)*\.[A-Za-z][\w]{0,7})\b/g
// a "symbol" is a token that could not be an ordinary English word: PascalCase
// with an internal capital, snake_case, or camelCase.
const SYMBOL_RE = /\b([A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*)\b/g
const QUOTED_RE = /[`"']([^`"']{2,60})[`"']/g
const STOP_SYMBOLS = new Set(["README", "TODO", "JSON", "HTTP", "HTTPS", "API", "CLI", "URL"])

/**
 * Cheap, deterministic task analysis. No model call: the router must be able to
 * reason about intent before (and without) spending a token.
 */
export function analyzeTask(task, context = {}) {
  const text = String(task ?? "")
  const t = text.toLowerCase()
  const intents = []
  for (const [intent, re] of SIGNALS) if (re.test(t)) intents.push(intent)

  const files = []
  let m
  FILE_RE.lastIndex = 0
  while ((m = FILE_RE.exec(text))) files.push(m[1])
  const symbols = []
  QUOTED_RE.lastIndex = 0
  while ((m = QUOTED_RE.exec(text))) symbols.push(m[1])
  SYMBOL_RE.lastIndex = 0
  while ((m = SYMBOL_RE.exec(text))) if (!STOP_SYMBOLS.has(m[1]) && !files.some((f) => f.includes(m[1]))) symbols.push(m[1])

  // primary intent: recovery beats modification beats discovery beats reading
  const order = [INTENT.RECOVER, INTENT.MODIFY, INTENT.DISCOVER, INTENT.RESEARCH, INTENT.VERIFY, INTENT.EXECUTE, INTENT.EXPLAIN, INTENT.INSPECT, INTENT.REMEMBER]
  const primary = order.find((i) => intents.includes(i)) ?? INTENT.INSPECT

  const words = t.split(/\s+/).filter(Boolean).length
  const complexity = intents.includes(INTENT.RECOVER) || (intents.includes(INTENT.MODIFY) && words > 12) ? "complex" : words <= 6 && files.length <= 1 ? "simple" : "moderate"

  return {
    task: text,
    intents: [...new Set([primary, ...intents])],
    primary,
    files: [...new Set(files)].slice(0, 8),
    symbols: [...new Set(symbols)].slice(0, 8),
    complexity,
    needsNetwork: intents.includes(INTENT.RESEARCH),
    mutating: intents.includes(INTENT.MODIFY) || intents.includes(INTENT.RECOVER),
    capabilities: capabilitiesFor(primary, intents),
    context: { knownFiles: context.knownFiles ?? [], readFiles: context.readFiles ?? [] },
  }
}

function capabilitiesFor(primary, intents) {
  const caps = new Set()
  const add = (...c) => c.forEach((x) => caps.add(x))
  switch (primary) {
    case INTENT.DISCOVER: add(CAPABILITY.CONTENT_SEARCH, CAPABILITY.FILE_DISCOVERY, CAPABILITY.FILE_READ); break
    case INTENT.INSPECT: add(CAPABILITY.FILE_READ); break
    case INTENT.EXPLAIN: add(CAPABILITY.FILE_READ, CAPABILITY.CONTENT_SEARCH); break
    case INTENT.MODIFY: add(CAPABILITY.CONTENT_SEARCH, CAPABILITY.FILE_READ, CAPABILITY.CODE_MODIFICATION, CAPABILITY.TEST_EXECUTION); break
    case INTENT.RECOVER: add(CAPABILITY.FILE_READ, CAPABILITY.CONTENT_SEARCH, CAPABILITY.CODE_MODIFICATION, CAPABILITY.TEST_EXECUTION); break
    case INTENT.VERIFY: add(CAPABILITY.TEST_EXECUTION); break
    case INTENT.EXECUTE: add(CAPABILITY.COMMAND_EXECUTION); break
    case INTENT.RESEARCH: add(CAPABILITY.WEB_SEARCH, CAPABILITY.NETWORK_FETCH); break
    case INTENT.REMEMBER: add(CAPABILITY.MEMORY_WRITE); break
    default: add(CAPABILITY.FILE_READ)
  }
  if (intents.includes(INTENT.VERIFY) && primary !== INTENT.VERIFY) caps.add(CAPABILITY.TEST_EXECUTION)
  return [...caps]
}

// ---------------------------------------------------------------------------
// 2. chain planning (§2, §7) — the SMALLEST effective chain
// ---------------------------------------------------------------------------

/**
 * Build the tool chain for a task. Steps already satisfied by what forge
 * already knows (§11) are dropped with a reason instead of being re-run.
 *
 *   "read src/app.js"                    → read_file                (1 step)
 *   "find where tokens are generated"    → grep_files → read_file   (no edit!)
 *   "fix the failing auth test"          → read → search → read →
 *                                          edit → focused test → regression
 */
export function planChain(task, { registry, context = {}, constraints = {} } = {}) {
  const a = typeof task === "object" && task?.intents ? task : analyzeTask(task, context)
  const known = new Set([...(context.knownFiles ?? []), ...(context.readFiles ?? [])])
  const steps = []
  const step = (phase, capability, why, extra = {}) => steps.push({ phase, capability, why, optional: false, ...extra })
  const fileKnown = a.files.some((f) => known.has(f)) || a.files.some((f) => existsRel(f, context.cwd))

  switch (a.primary) {
    case INTENT.INSPECT:
    case INTENT.EXPLAIN:
      if (!a.files.length && !fileKnown) step("discover", CAPABILITY.CONTENT_SEARCH, "no concrete file named — locate it before reading")
      step("inspect", CAPABILITY.FILE_READ, a.files.length ? `read ${a.files[0]}` : "read what discovery found", { target: a.files[0] ?? null })
      break
    case INTENT.DISCOVER:
      step("discover", CAPABILITY.CONTENT_SEARCH, "search the repository for the named concept", { args: { pattern: searchPattern(a) } })
      if (a.symbols.length) step("analyze", CAPABILITY.SYMBOL_LOOKUP, "resolve the definition and its references", { args: { pattern: a.symbols[0] } })
      step("inspect", CAPABILITY.FILE_READ, "read only the file the search pointed at")
      break
    case INTENT.RESEARCH:
      step("research", CAPABILITY.WEB_SEARCH, "the repository cannot answer this — search the web")
      step("inspect", CAPABILITY.NETWORK_FETCH, "read the most relevant result", { optional: true })
      break
    case INTENT.VERIFY:
      step("verify", CAPABILITY.TEST_EXECUTION, "run the project's tests/build and read the real output")
      break
    case INTENT.EXECUTE:
      step("execute", CAPABILITY.COMMAND_EXECUTION, "run the requested command")
      break
    case INTENT.REMEMBER:
      step("remember", CAPABILITY.MEMORY_WRITE, "persist the fact for future sessions")
      break
    case INTENT.RECOVER:
      if (!a.files.length) step("discover", CAPABILITY.FILE_DISCOVERY, "no test file named — locate the failing test first", { args: { pattern: searchPattern(a) } })
      step("inspect", CAPABILITY.FILE_READ, "read the failing test to learn what it asserts", { target: a.files[0] ?? null })
      step("discover", CAPABILITY.CONTENT_SEARCH, "locate the implementation under test", { args: { pattern: searchPattern(a) } })
      step("analyze", CAPABILITY.FILE_READ, "inspect the implementation and its dependencies")
      step("modify", CAPABILITY.CODE_MODIFICATION, "apply the smallest fix that can work")
      step("verify", CAPABILITY.TEST_EXECUTION, "re-run the FOCUSED test first (fast signal)")
      step("regress", CAPABILITY.TEST_EXECUTION, "then the wider suite, to prove nothing else broke")
      break
    case INTENT.MODIFY:
    default:
      if (!fileKnown) step("discover", CAPABILITY.CONTENT_SEARCH, "locate the code to change", { args: { pattern: searchPattern(a) } })
      step("inspect", CAPABILITY.FILE_READ, "read the exact text before replacing it", { target: a.files[0] ?? null })
      step("modify", CAPABILITY.CODE_MODIFICATION, "apply a minimal, surgical edit")
      step("verify", CAPABILITY.TEST_EXECUTION, "verify with a real command before claiming success")
      break
  }

  // §11: drop steps whose answer is already in context
  const pruned = []
  for (const s of steps) {
    const satisfied = isSatisfied(s, a, context)
    if (satisfied) { pruned.push({ ...s, skipped: true, why: satisfied }); continue }
    pruned.push(s)
  }

  // constraints: a read-only agent gets no mutation steps at all
  const readOnly = constraints.readOnly === true
  const noNetwork = constraints.network === false
  const finalSteps = pruned.filter((s) => {
    if (readOnly && (s.capability === CAPABILITY.CODE_MODIFICATION || s.capability === CAPABILITY.FILE_WRITE)) return false
    if (noNetwork && (s.capability === CAPABILITY.WEB_SEARCH || s.capability === CAPABILITY.NETWORK_FETCH)) return false
    return true
  })

  // resolve a tool for every step (may be null when nothing provides it)
  const available = constraints.availableTools ?? null
  for (const s of finalSteps) {
    const pick = pickTool(s.capability, { registry, available, constraints, analysis: a })
    s.tool = pick.tool
    s.alternatives = pick.alternatives
    if (pick.note) s.note = pick.note
  }

  return {
    task: a.task,
    intent: a.primary,
    complexity: a.complexity,
    steps: finalSteps,
    active: finalSteps.filter((s) => !s.skipped),
    reason: chainReason(a, finalSteps),
    minimal: finalSteps.filter((s) => !s.skipped).length <= 1,
  }
}

function existsRel(f, cwd) {
  try { return fs.existsSync(path.resolve(cwd || process.cwd(), f)) } catch { return false }
}

function isSatisfied(step, analysis, context) {
  const readFiles = new Set(context.readFiles ?? [])
  if (step.phase === "discover") {
    if ((context.knownFiles ?? []).length || analysis.files.length) return "target already known from context — no rediscovery"
    if (context.knownSymbols?.length) return "symbol already located earlier in this run"
  }
  if (step.phase === "inspect" && step.target && readFiles.has(step.target)) return `already read ${step.target} in this run`
  if (step.phase === "verify" && context.testsJustPassed) return "tests already passed after the last mutation"
  return null
}

function searchPattern(a) {
  if (a.symbols.length) return a.symbols[0]
  const words = String(a.task)
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !/^(find|where|which|file|that|this|from|with|into|about|generate|generated|the|are|for)$/.test(w))
  return words.slice(0, 2).join("|") || String(a.task).slice(0, 40)
}

function chainReason(a, steps) {
  const active = steps.filter((s) => !s.skipped)
  const skipped = steps.filter((s) => s.skipped)
  const head = `intent=${a.primary} → ${active.length} step chain: ${active.map((s) => s.tool ?? s.capability).join(" → ")}`
  return skipped.length ? `${head} (${skipped.length} step(s) skipped: already known)` : head
}

/** Pick the best tool for a capability (§2, §10, §19). */
function pickTool(capability, { registry, available = null, constraints = {}, analysis = null } = {}) {
  if (!registry) return { tool: null, alternatives: [], note: "no registry" }
  let cands = registry.providersOf(capability, { available })
  if (constraints.readOnly) cands = cands.filter((m) => m.read_only)
  if (constraints.network === false) cands = cands.filter((m) => !m.requires_network)
  if (constraints.maxRisk) cands = cands.filter((m) => riskRank(m.risk) <= riskRank(constraints.maxRisk))
  if (!cands.length) return { tool: null, alternatives: [], note: `no enabled tool provides ${capability}` }
  // avoid_when: a soft de-prioritisation based on the task text
  const scored = cands.map((m) => ({ m, penalty: avoidPenalty(m, analysis) }))
  scored.sort((a, b) => a.penalty - b.penalty || costScore(a.m) - costScore(b.m) || riskRank(a.m.risk) - riskRank(b.m.risk))
  const best = scored[0].m
  const note = best.status === STATUS.DEPRECATED ? `${best.name} is deprecated — used because nothing else provides ${capability}` : ""
  return { tool: best.name, alternatives: scored.slice(1, 4).map((s) => s.m.name), note }
}

function avoidPenalty(meta, analysis) {
  if (!analysis) return 0
  const t = String(analysis.task ?? "").toLowerCase()
  let p = 0
  for (const a of meta.avoid_when) {
    const key = a.toLowerCase()
    if (key.includes("offline") && analysis.needsNetwork === false) p += 1
    if (key.includes("file path is unknown") && !analysis.files.length) p += 2
    if (key.includes("does not exist") && analysis.files.some((f) => existsRel(f, analysis.context?.cwd))) p += 0
  }
  // creating something new? write_file beats edit_file, and vice versa
  if (/\b(create|new file|scaffold|generate a file)\b/.test(t) && meta.name === "write_file") p -= 2
  if (/\b(fix|tweak|adjust|replace|rename)\b/.test(t) && meta.name === "edit_file") p -= 1
  return p
}

// ---------------------------------------------------------------------------
// 3. route() — one decision for the current step (§2)
// ---------------------------------------------------------------------------

/**
 * @param task            the user/agent task text (or an analyzeTask() result)
 * @param state           { readFiles, knownFiles, lastResults, history, testsJustPassed }
 * @param availableTools  names the executor may actually call (null = all)
 * @param constraints     { readOnly, network, maxRisk, allowDeprecated }
 * @param risk            caller-imposed risk ceiling (same as constraints.maxRisk)
 * @param context         { cwd, root, registry }
 */
export function route({ task, state = {}, availableTools = null, constraints = {}, risk = null, context = {}, registry = null } = {}) {
  const reg = registry ?? context.registry ?? null
  const cons = { ...constraints, availableTools, maxRisk: risk ?? constraints.maxRisk ?? null }
  const analysis = analyzeTask(task, { ...state, cwd: context.cwd })
  const chain = planChain(analysis, { registry: reg, context: { ...state, cwd: context.cwd }, constraints: cons })
  const next = chain.active[0] ?? null

  if (!next || !next.tool) {
    return {
      selected_tool: null,
      reason: next ? `no enabled tool provides ${next.capability}` : "nothing left to do — the chain is already satisfied",
      arguments: {},
      execution_mode: next ? "blocked" : "none",
      verification_plan: { required: false, checks: [], summary: "n/a" },
      chain,
      alternatives: [],
      risk: RISK.LOW,
      blocked: !!next,
    }
  }

  const args = synthesizeArgs(next, analysis, context)
  const meta = reg?.resolve(next.tool) ?? null
  const op = operationRisk(next.tool, args, { ...context, registry: reg })
  const call = classifyCall(next.tool, args, { ...context, registry: reg })
  const ceiling = cons.maxRisk
  const overRisk = ceiling && riskRank(op.risk) > riskRank(ceiling)
  const mode = overRisk
    ? "blocked"
    : meta?.requires_confirmation || riskRank(op.risk) >= riskRank(RISK.HIGH)
      ? "confirm"
      : call.parallel_safe
        ? "parallel"
        : "serial"

  return {
    selected_tool: next.tool,
    reason: `${next.why} • capability=${next.capability} • ${meta ? `${meta.klass}/${meta.risk} baseline` : "unknown tool"} • operation risk=${op.risk} (${op.reasons[0] ?? "n/a"})${next.note ? ` • ${next.note}` : ""}`,
    arguments: args,
    execution_mode: mode,
    verification_plan: verificationPlan(next.tool, args, { risk: op.risk, registry: reg, cwd: context.cwd, meta }),
    chain,
    alternatives: next.alternatives ?? [],
    risk: op.risk,
    blocked: overRisk,
    capability: next.capability,
  }
}

function synthesizeArgs(step, analysis, context) {
  const cwd = context.cwd || process.cwd()
  switch (step.tool) {
    case "read_file": return { path: step.target ?? analysis.files[0] ?? null }
    case "grep_files": return { pattern: step.args?.pattern ?? searchPattern(analysis), path: "." }
    case "glob_files": return { pattern: step.args?.pattern ?? "**/*" }
    case "list_dir": return { path: "." }
    case "web_search": return { query: analysis.task.slice(0, 200) }
    case "fetch_url": return {}
    case "bash": return { command: detectTestCommand(cwd) }
    case "edit_file": return { path: step.target ?? analysis.files[0] ?? null }
    case "write_file": return { path: step.target ?? analysis.files[0] ?? null }
    case "memory": return { action: "append", text: analysis.task.slice(0, 200) }
    default: return {}
  }
}

/** The project's own test command, read from real files (never invented). */
export function detectTestCommand(cwd = process.cwd()) {
  try {
    const pkgPath = path.join(cwd, "package.json")
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
      if (pkg.scripts?.test) return "npm test"
      if (pkg.scripts?.build) return "npm run build"
    }
    if (fs.existsSync(path.join(cwd, "pytest.ini")) || fs.existsSync(path.join(cwd, "pyproject.toml"))) return "pytest -q"
    if (fs.existsSync(path.join(cwd, "go.mod"))) return "go test ./..."
    if (fs.existsSync(path.join(cwd, "Cargo.toml"))) return "cargo test"
    if (fs.existsSync(path.join(cwd, "Makefile"))) return "make test"
  } catch { /* fall through */ }
  return ""
}

// ---------------------------------------------------------------------------
// 4. scheduling (§4, §12) — what may run concurrently
// ---------------------------------------------------------------------------

/** Paths (or the FS-wide sentinel "*") a call touches. */
export function targetsOf(name, args = {}, cwd = process.cwd()) {
  const a = args && typeof args === "object" ? args : {}
  const abs = (p) => path.resolve(cwd, String(p))
  switch (name) {
    case "read_file":
    case "write_file":
    case "edit_file":
    case "multi_edit":
      return a.path ? [abs(a.path)] : []
    case "list_dir":
    case "grep_files":
    case "glob_files":
      return a.path ? [abs(a.path)] : [abs(".")]
    case "apply_patch": {
      const out = []
      const re = /^(?:---|\+\+\+) (?:[ab]\/)?(\S+)/gm
      let m
      while ((m = re.exec(String(a.patch ?? "")))) if (m[1] !== "/dev/null") out.push(abs(m[1]))
      return [...new Set(out)]
    }
    case "bash":
      return ["*"] // a shell command may touch anything
    case "todo": return ["#todo"]
    case "memory": return ["#memory"]
    default:
      return a.path ? [abs(a.path)] : ["*"]
  }
}

function overlaps(a, b) {
  if (a === "*" || b === "*") return true
  if (a === b) return true
  if (a.startsWith("#") || b.startsWith("#")) return a === b
  return a.startsWith(b + path.sep) || b.startsWith(a + path.sep)
}

/**
 * May these two calls run at the same time? (§12)
 * Both read-only + parallel_safe + no shared mutable state → yes.
 * Anything else → no, with a reason the UI/log can show.
 */
export function canRunInParallel(callA, callB, { registry, ctx = {} } = {}) {
  const a = classifyCall(callA.name, callA.args, { ...ctx, registry })
  const b = classifyCall(callB.name, callB.args, { ...ctx, registry })
  if (!a.read_only || !b.read_only) return { ok: false, reason: `${a.read_only ? callB.name : callA.name} mutates state — writes are serialized` }
  if (!a.parallel_safe || !b.parallel_safe) return { ok: false, reason: `${!a.parallel_safe ? callA.name : callB.name} is not parallel-safe (shared state)` }
  const ta = targetsOf(callA.name, callA.args, ctx.cwd)
  const tb = targetsOf(callB.name, callB.args, ctx.cwd)
  for (const x of ta) for (const y of tb) if (overlaps(x, y) && (x === "*" || y === "*")) return { ok: false, reason: "one of the calls can touch the whole filesystem" }
  return { ok: true, reason: "both read-only, parallel-safe, no shared mutable state" }
}

/** Do two MUTATING calls conflict (same or nested target)? (§12) */
export function conflicts(callA, callB, { ctx = {} } = {}) {
  const ta = targetsOf(callA.name, callA.args, ctx.cwd)
  const tb = targetsOf(callB.name, callB.args, ctx.cwd)
  for (const x of ta) for (const y of tb) if (overlaps(x, y)) return { conflict: true, on: x === "*" || y === "*" ? "*" : x }
  return { conflict: false, on: null }
}

/**
 * Turn the tool calls a model emitted into an execution plan:
 *
 *   batch 0  parallel  read-only, parallel-safe, independent calls
 *   batch 1  serial    everything else, in the ORIGINAL order
 *
 * Results are reassembled by the caller in the original index order, so the
 * conversation history never changes shape. Conflicting mutations are flagged
 * (they are already serialized, but the log should say why).
 */
export function planExecution(calls = [], { registry, ctx = {} } = {}) {
  const items = calls.map((c, index) => {
    const cls = classifyCall(c.name, c.args, { ...ctx, registry })
    return { index, name: c.name, args: c.args, id: c.id ?? null, cls, targets: targetsOf(c.name, c.args, ctx.cwd) }
  })
  const parallel = []
  const serial = []
  for (const it of items) {
    const ok = it.cls.read_only && it.cls.parallel_safe && riskRank(it.cls.risk) <= riskRank(RISK.MEDIUM)
    if (!ok) { serial.push(it); continue }
    // parallel reads always run BEFORE the serialized calls, so a later write
    // cannot affect them. A write the model put EARLIER in the batch can: that
    // read is serialized so it observes the mutation the model intended.
    const clash = items.find((o) => o.index < it.index && !o.cls.read_only && o.targets.some((x) => it.targets.some((y) => overlaps(x, y))))
    if (clash) { it.serializedBecause = `${clash.name} mutates the same target in this batch`; serial.push(it); continue }
    parallel.push(it)
  }
  const conflictNotes = []
  for (let i = 0; i < serial.length; i++) {
    for (let j = i + 1; j < serial.length; j++) {
      if (serial[i].cls.read_only || serial[j].cls.read_only) continue
      const c = conflicts(serial[i], serial[j], { ctx })
      if (c.conflict && conflictNotes.length < 8) conflictNotes.push({ a: serial[i].index, b: serial[j].index, on: c.on, note: `${serial[i].name} and ${serial[j].name} write the same target — serialized` })
    }
  }
  const batches = []
  if (parallel.length) batches.push({ mode: "parallel", calls: parallel })
  if (serial.length) batches.push({ mode: "serial", calls: serial })
  return {
    batches,
    parallel: parallel.map((i) => i.index),
    serialized: serial.map((i) => i.index),
    conflicts: conflictNotes,
    summary: `${parallel.length} parallel • ${serial.length} serialized${conflictNotes.length ? ` • ${conflictNotes.length} write conflict(s)` : ""}`,
  }
}

// ---------------------------------------------------------------------------
// 5. cost awareness (§10)
// ---------------------------------------------------------------------------

export function estimateCost(name, args = {}, { registry, ctx = {} } = {}) {
  const meta = registry?.resolve(name) ?? null
  const base = meta?.cost ?? { latency: 500, tokens: 400, output: 4000, cpu: "low", memory: "low", network: false }
  const est = { ...base, risk: operationRisk(name, args, { ...ctx, registry }).risk }
  if (name === "read_file") {
    const limit = Number(args?.limit) || 400
    const size = fileSize(args?.path, ctx.cwd)
    est.tokens = Math.min(limit * 12, size ? Math.ceil(size / 4) : limit * 12)
    est.output = Math.min(size || limit * 60, limit * 60)
    est.latency = 20 + Math.min(200, (size || 0) / 50000)
  }
  if (name === "bash") est.latency = /\btest|build|install\b/.test(String(args?.command ?? "")) ? 20000 : 800
  est.score = est.latency / 100 + est.tokens / 100 + (est.network ? 5 : 0) + riskRank(est.risk)
  return est
}

function fileSize(p, cwd) {
  if (!p) return 0
  try { return fs.statSync(path.resolve(cwd || process.cwd(), String(p))).size } catch { return 0 }
}

/**
 * "Do not read 5,000 lines if symbol search can locate the function first."
 * Advisory only — the router never silently swaps the model's tool; it returns
 * a hint the executor surfaces (TOOL_FALLBACK) so the next call is cheaper.
 */
export function cheaperAlternative(name, args = {}, { registry, ctx = {}, context = {} } = {}) {
  if (name === "read_file") {
    const size = fileSize(args?.path, ctx.cwd)
    const bounded = Number(args?.limit) > 0 || Number(args?.offset) > 0
    if (!bounded && size > 200 * 1024) {
      return { tool: "grep_files", why: `${args?.path} is ${Math.round(size / 1024)}KB — grep for the symbol first, then read the matching window with offset/limit`, saves: "context" }
    }
  }
  if (name === "delegate") {
    const t = String(args?.task ?? "").toLowerCase()
    if (t.length < 80 && /\b(where|find|which file|grep|search)\b/.test(t)) {
      return { tool: "grep_files", why: "a sub-agent costs a full model run — this question is one search", saves: "tokens+latency" }
    }
  }
  if (name === "bash") {
    const cmd = String(args?.command ?? "").trim()
    if (/^(cat|head|tail)\s+\S+$/.test(cmd)) return { tool: "read_file", why: "read_file is bounded, line-numbered and redacted", saves: "context" }
    if (/^(ls|find)\b/.test(cmd)) return { tool: "glob_files", why: "glob_files is faster and respects ignore rules", saves: "latency" }
    if (/^grep\b|^rg\b/.test(cmd)) return { tool: "grep_files", why: "grep_files is bounded and secret-redacted", saves: "context" }
  }
  if (name === "web_search" && context.repoAnswers) {
    return { tool: "grep_files", why: "the repository already contains the answer", saves: "network" }
  }
  return null
}

// ---------------------------------------------------------------------------
// 6. result-aware routing (§8)
// ---------------------------------------------------------------------------

/**
 * Given what just happened, what should happen next?
 * `history` is the executor's record list (see toolintel.js): the router reads
 * it instead of guessing, so a failed strategy is never repeated blindly.
 */
export function nextAction({ task = "", history = [], lastResult = null, registry = null, context = {} } = {}) {
  const last = lastResult ?? history[history.length - 1] ?? null
  if (!last) {
    const r = route({ task, registry, context })
    return { capability: r.capability ?? null, tool: r.selected_tool, why: r.reason, changeStrategy: false, specific: false }
  }
  const failure = last.failure ?? null
  const repeated = repeatedFailures(history, last)

  if (repeated >= 2) {
    const alt = alternativeFor(last.tool, { registry, failure })
    return {
      capability: null,
      tool: alt?.tool ?? null,
      why: `${last.tool} failed ${repeated}× with the same arguments (${failure ?? "unknown"}) — change strategy: ${alt?.why ?? "escalate to the user"}`,
      changeStrategy: true,
      escalate: !alt,
      specific: true,
    }
  }

  if (failure === "TEST_FAILURE" || failure === "BUILD_FAILURE") {
    return { capability: CAPABILITY.CONTENT_SEARCH, tool: "grep_files", why: "classify the error, then locate the failing symbol before editing again", changeStrategy: false, specific: true }
  }
  if (failure === "NOT_FOUND" && last.tool === "read_file") {
    return { capability: CAPABILITY.FILE_DISCOVERY, tool: "glob_files", why: "the path does not exist — discover the real path instead of guessing again", changeStrategy: true, specific: true }
  }
  if (failure === "NOT_FOUND" && (last.tool === "edit_file" || last.tool === "multi_edit")) {
    return { capability: CAPABILITY.FILE_READ, tool: "read_file", why: "the anchor text was not found — re-read the file and copy the exact text", changeStrategy: true, specific: true }
  }
  if (failure === "SAFETY_BLOCK") {
    return { capability: null, tool: null, why: "blocked by a safety control — do not retry; ask the user or use a permitted approach", changeStrategy: true, escalate: true, specific: true }
  }
  if (!failure && last.mutation) {
    return { capability: CAPABILITY.TEST_EXECUTION, tool: "bash", why: "a mutation landed — verify it with the project's real test/build command", changeStrategy: false, specific: true }
  }
  const r = route({ task, state: context.state ?? {}, registry, context })
  return { capability: r.capability ?? null, tool: r.selected_tool, why: r.reason, changeStrategy: false, specific: false }
}

export function repeatedFailures(history, last) {
  if (!last || !last.tool) return 0
  const hashOf = (r) => r?.argsHash ?? r?.arguments_hash ?? null
  const want = hashOf(last)
  let n = 0
  for (const h of history) {
    if (h.tool === last.tool && hashOf(h) === want && h.status === "failed") n++
  }
  return n
}

function alternativeFor(tool, { registry, failure } = {}) {
  const map = {
    read_file: { tool: "grep_files", why: "search for the content instead of reading a guessed path" },
    grep_files: { tool: "glob_files", why: "widen to filename discovery" },
    glob_files: { tool: "list_dir", why: "list the directory tree directly" },
    edit_file: { tool: "apply_patch", why: "apply a structured patch instead of an exact-string replacement" },
    multi_edit: { tool: "edit_file", why: "make the changes one at a time to find the failing anchor" },
    apply_patch: { tool: "edit_file", why: "fall back to targeted replacements" },
    fetch_url: { tool: "web_search", why: "the URL failed — search for an alternative source" },
    web_search: { tool: "fetch_url", why: "search failed — fetch a known documentation URL directly" },
    bash: { tool: "read_file", why: "inspect state with a bounded read instead of re-running the command" },
  }
  const alt = map[tool]
  if (!alt) return null
  if (registry && registry.get(alt.tool)?.status === STATUS.DISABLED) return null
  return alt
}

/**
 * The tool-selection policy the MODEL sees, generated from the registry (§1,
 * §21) instead of being hard-coded in the prompt: capabilities, the risk/
 * verification contract, the parallelism rule, and the concrete chain this
 * task suggests. Bounded to a dozen lines — a prompt, not a manual.
 */
export function toolGuidance(task, { registry, cwd = process.cwd(), readOnly = false, maxLines = 14 } = {}) {
  if (!registry) return ""
  const lines = ["TOOL POLICY (capability-first — pick the smallest effective chain):"]
  lines.push("- Ask 'what capability do I need?', not 'which tool do I have'. One tool per capability, cheapest first.")
  lines.push("- Discover (glob/grep) before reading; read before editing; verify every mutation with a real command.")
  lines.push("- Independent read-only calls may be issued in the SAME message — they run in parallel. Never batch two edits to the same file.")
  if (!readOnly) lines.push("- After an edit forge checks syntax automatically; a failed check comes back in the tool result — fix it before moving on.")
  lines.push("- A failed call is classified (NOT_FOUND / TIMEOUT / SAFETY_BLOCK / TEST_FAILURE …) and the result carries the recommended recovery. Never repeat an identical failing call.")
  const disabled = registry.list({ status: "disabled" }).map((m) => m.name)
  if (disabled.length) lines.push(`- Disabled in this project (do not call): ${disabled.join(", ")}.`)
  const deprecated = registry.list({ status: "deprecated" }).map((m) => m.name)
  if (deprecated.length) lines.push(`- Deprecated (only if nothing else provides the capability): ${deprecated.join(", ")}.`)
  if (task) {
    try {
      const chain = planChain(task, { registry, context: { cwd }, constraints: { readOnly } })
      const active = chain.active.map((s) => `${s.tool ?? s.capability}`).join(" → ")
      if (active) lines.push(`- Suggested chain for this task (${chain.intent}): ${active}. Deviate when the evidence says otherwise.`)
    } catch { /* guidance is best-effort */ }
  }
  return lines.slice(0, maxLines).join("\n")
}

/** Human-readable rendering of a routing decision (used by `forge tools --route`). */export function describeRoute(decision) {
  const lines = []
  lines.push(`selected_tool     ${decision.selected_tool ?? "(none)"}`)
  lines.push(`reason            ${decision.reason}`)
  lines.push(`arguments         ${JSON.stringify(decision.arguments)}`)
  lines.push(`execution_mode    ${decision.execution_mode}`)
  lines.push(`risk              ${decision.risk}`)
  lines.push(`verification      ${decision.verification_plan?.summary ?? "n/a"}`)
  if (decision.alternatives?.length) lines.push(`alternatives      ${decision.alternatives.join(", ")}`)
  lines.push(`chain             ${decision.chain?.reason ?? ""}`)
  for (const s of decision.chain?.steps ?? []) {
    lines.push(`  ${s.skipped ? "·" : "→"} ${String(s.phase).padEnd(9)} ${String(s.tool ?? s.capability).padEnd(14)} ${s.skipped ? "(skipped) " : ""}${s.why}`)
  }
  return lines.join("\n")
}

export { RISK, RISK_ORDER, CLASS, maxRisk }
