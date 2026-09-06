/**
 * forge — capability registry (v20.5 tool intelligence layer, zero dependencies)
 *
 * ONE place that knows what every tool IS. Nothing else in forge is allowed to
 * hard-code "read_file is safe" / "edit_file needs verification": the router
 * (router.js), the safety gate and the executor (toolintel.js), the UI and the
 * `forge tools` command all read this registry.
 *
 * Every tool exposes the same structured metadata:
 *
 *   name description capabilities[] klass risk read_only reversible
 *   parallel_safe requires_confirmation requires_network requires_filesystem
 *   timeout cost verification_required preferred_for[] avoid_when[]
 *   idempotent status verify_after[] mutates[]
 *
 * Two kinds of risk exist and they are NOT the same thing:
 *   - the tool's *baseline* risk (metadata, static)          → meta.risk
 *   - the risk of THIS operation with THESE arguments        → operationRisk()
 * `rm -rf /` and `echo hi` are both `bash`; only the second one is LOW.
 * operationRisk() derives the real level from the existing safety engine
 * (shellguard) — it never re-implements it.
 *
 * Compatibility: read/write classification is derived from, and asserted
 * against, tools.js WRITE_TOOLS. The registry adds information, it never
 * contradicts the shipped safety controls.
 */
import path from "node:path"
import fs from "node:fs"
import { classifyCommand } from "./shellguard.js"
import { WRITE_TOOLS } from "./tools.js"

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

/** Risk levels, ordered. */
export const RISK = { LOW: "low", MEDIUM: "medium", HIGH: "high", CRITICAL: "critical" }
export const RISK_ORDER = ["low", "medium", "high", "critical"]
export function riskRank(r) {
  const i = RISK_ORDER.indexOf(String(r || "").toLowerCase())
  return i < 0 ? 1 : i
}
export function maxRisk(...risks) {
  let worst = RISK.LOW
  for (const r of risks.flat()) if (r && riskRank(r) > riskRank(worst)) worst = r
  return worst
}
export function riskAtLeast(r, floor) {
  return riskRank(r) >= riskRank(floor)
}

/** Tool classes (§4). A tool has one primary class and may carry more. */
export const CLASS = {
  READ: "READ",
  WRITE: "WRITE",
  EXECUTE: "EXECUTE",
  NETWORK: "NETWORK",
  SECURITY: "SECURITY",
  VERIFICATION: "VERIFICATION",
  RECOVERY: "RECOVERY",
}
export const CLASSES = Object.values(CLASS)

/** Lifecycle status (§19). */
export const STATUS = { ENABLED: "enabled", DISABLED: "disabled", DEPRECATED: "deprecated", EXPERIMENTAL: "experimental" }
export const STATUSES = Object.values(STATUS)

/** Capability vocabulary — what a tool can DO (§1). Free-form strings are
 *  allowed (plugins may declare their own), these are the ones forge routes on. */
export const CAPABILITY = {
  FILE_READ: "file_read",
  FILE_WRITE: "file_write",
  FILE_CREATE: "file_create",
  FILE_EDITING: "file_editing",
  CODE_MODIFICATION: "code_modification",
  PATCH_APPLICATION: "patch_application",
  FILE_DISCOVERY: "file_discovery",
  DIRECTORY_LISTING: "directory_listing",
  CONTENT_SEARCH: "content_search",
  SYMBOL_LOOKUP: "symbol_lookup",
  COMMAND_EXECUTION: "command_execution",
  TEST_EXECUTION: "test_execution",
  BUILD_EXECUTION: "build_execution",
  VCS_INSPECTION: "vcs_inspection",
  NETWORK_FETCH: "network_fetch",
  WEB_SEARCH: "web_search",
  TASK_TRACKING: "task_tracking",
  REASONING: "reasoning",
  MEMORY_READ: "memory_read",
  MEMORY_WRITE: "memory_write",
  SKILL_LOADING: "skill_loading",
  DELEGATION: "delegation",
  VERIFICATION: "verification",
}

// ---------------------------------------------------------------------------
// metadata defaults — anything unknown is treated conservatively
// ---------------------------------------------------------------------------

const CONSERVATIVE = {
  description: "",
  capabilities: [],
  klass: CLASS.WRITE,
  classes: [CLASS.WRITE],
  risk: RISK.MEDIUM,
  read_only: false,
  reversible: false,
  parallel_safe: false,
  requires_confirmation: false,
  requires_network: false,
  requires_filesystem: true,
  timeout: 60,
  cost: { latency: 500, tokens: 400, output: 4000, cpu: "low", memory: "low", network: false },
  verification_required: true,
  preferred_for: [],
  avoid_when: [],
  idempotent: false,
  status: STATUS.ENABLED,
  verify_after: [],
  mutates: ["filesystem"],
  source: "builtin",
}

/** Cost hints. latency = ms (rough), tokens = typical result size in tokens,
 *  output = typical bytes. Used only to break ties between equivalent tools. */
const C = (latency, tokens, output, extra = {}) => ({ latency, tokens, output, cpu: "low", memory: "low", network: false, ...extra })

// ---------------------------------------------------------------------------
// built-in tool metadata (the 17 shipped tools)
// ---------------------------------------------------------------------------

export const BUILTIN_CAPABILITIES = [
  {
    name: "read_file",
    description: "Read a bounded window of a text file with line numbers.",
    capabilities: [CAPABILITY.FILE_READ],
    klass: CLASS.READ, classes: [CLASS.READ],
    risk: RISK.LOW, read_only: true, reversible: true, parallel_safe: true,
    requires_confirmation: false, requires_network: false, requires_filesystem: true,
    timeout: 20, cost: C(40, 900, 12000), verification_required: false, idempotent: true,
    preferred_for: ["inspect a known file", "read a specific line range", "confirm the exact text before editing"],
    avoid_when: ["the file path is unknown", "you only need to know whether a symbol exists", "the file is huge and a search would answer the question"],
    mutates: [],
  },
  {
    name: "grep_files",
    description: "Regex search across files under a directory (path:line: matches).",
    capabilities: [CAPABILITY.CONTENT_SEARCH, CAPABILITY.SYMBOL_LOOKUP, CAPABILITY.FILE_DISCOVERY],
    klass: CLASS.READ, classes: [CLASS.READ],
    risk: RISK.LOW, read_only: true, reversible: true, parallel_safe: true,
    requires_confirmation: false, requires_network: false, requires_filesystem: true,
    timeout: 30, cost: C(120, 600, 8000, { cpu: "medium" }), verification_required: false, idempotent: true,
    preferred_for: ["find where a symbol is defined or used", "locate code by content", "answer 'where is X' before reading anything"],
    avoid_when: ["the exact file is already known and small"],
    mutates: [],
  },
  {
    name: "glob_files",
    description: "Find files by glob pattern, newest first.",
    capabilities: [CAPABILITY.FILE_DISCOVERY],
    klass: CLASS.READ, classes: [CLASS.READ],
    risk: RISK.LOW, read_only: true, reversible: true, parallel_safe: true,
    requires_confirmation: false, requires_network: false, requires_filesystem: true,
    timeout: 20, cost: C(40, 200, 3000), verification_required: false, idempotent: true,
    preferred_for: ["locate files by name or extension", "discover project layout fast"],
    avoid_when: ["you need file CONTENT (use grep_files)"],
    mutates: [],
  },
  {
    name: "list_dir",
    description: "List a directory (recursive to depth 2).",
    capabilities: [CAPABILITY.DIRECTORY_LISTING, CAPABILITY.FILE_DISCOVERY],
    klass: CLASS.READ, classes: [CLASS.READ],
    risk: RISK.LOW, read_only: true, reversible: true, parallel_safe: true,
    requires_confirmation: false, requires_network: false, requires_filesystem: true,
    timeout: 20, cost: C(40, 250, 3000), verification_required: false, idempotent: true,
    preferred_for: ["orient in an unfamiliar directory"],
    avoid_when: ["a glob or search answers the question more cheaply"],
    mutates: [],
  },
  {
    name: "git_status",
    description: "Branch, changed files, recent commits, diffstat.",
    capabilities: [CAPABILITY.VCS_INSPECTION],
    klass: CLASS.READ, classes: [CLASS.READ, CLASS.EXECUTE],
    risk: RISK.LOW, read_only: true, reversible: true, parallel_safe: true,
    requires_confirmation: false, requires_network: false, requires_filesystem: true,
    timeout: 20, cost: C(150, 350, 4000), verification_required: false, idempotent: true,
    preferred_for: ["understand repo state before editing", "see what the run has already changed"],
    avoid_when: ["the directory is not a git repository"],
    mutates: [],
  },
  {
    name: "think",
    description: "Record a reasoning step (no side effects).",
    capabilities: [CAPABILITY.REASONING],
    klass: CLASS.READ, classes: [CLASS.READ],
    risk: RISK.LOW, read_only: true, reversible: true, parallel_safe: true,
    requires_confirmation: false, requires_network: false, requires_filesystem: false,
    timeout: 5, cost: C(1, 50, 200), verification_required: false, idempotent: true,
    preferred_for: ["plan a complex edit before touching files"],
    avoid_when: ["the next action is obvious"],
    mutates: [],
  },
  {
    name: "todo",
    description: "Read/update the task checklist for the current run.",
    capabilities: [CAPABILITY.TASK_TRACKING],
    klass: CLASS.READ, classes: [CLASS.READ],
    risk: RISK.LOW, read_only: true, reversible: true, parallel_safe: false,
    requires_confirmation: false, requires_network: false, requires_filesystem: true,
    timeout: 10, cost: C(10, 150, 1500), verification_required: false, idempotent: true,
    preferred_for: ["multi-step work: publish the plan and keep it current"],
    avoid_when: ["single-step tasks"],
    mutates: ["todo"],
  },
  {
    name: "memory",
    description: "Read/append hierarchical memory, or record a structured learning.",
    capabilities: [CAPABILITY.MEMORY_READ, CAPABILITY.MEMORY_WRITE],
    klass: CLASS.READ, classes: [CLASS.READ],
    risk: RISK.LOW, read_only: true, reversible: true, parallel_safe: false,
    requires_confirmation: false, requires_network: false, requires_filesystem: true,
    timeout: 10, cost: C(15, 200, 2000), verification_required: false, idempotent: false,
    preferred_for: ["persist a project convention or a verified fix"],
    avoid_when: ["the fact is only relevant to the current step"],
    mutates: ["memory"],
  },
  {
    name: "load_skill",
    description: "Load the full instructions of an installed skill.",
    capabilities: [CAPABILITY.SKILL_LOADING],
    klass: CLASS.READ, classes: [CLASS.READ],
    risk: RISK.LOW, read_only: true, reversible: true, parallel_safe: true,
    requires_confirmation: false, requires_network: false, requires_filesystem: true,
    timeout: 15, cost: C(30, 1200, 16000), verification_required: false, idempotent: true,
    preferred_for: ["a task that matches an installed skill"],
    avoid_when: ["no skill matches the task"],
    mutates: [],
  },
  {
    name: "delegate",
    description: "Run a read-only sub-agent (researcher/reviewer/tester/security/coder).",
    capabilities: [CAPABILITY.DELEGATION, CAPABILITY.CONTENT_SEARCH],
    klass: CLASS.READ, classes: [CLASS.READ],
    risk: RISK.MEDIUM, read_only: true, reversible: true, parallel_safe: true,
    requires_confirmation: false, requires_network: true, requires_filesystem: true,
    timeout: 180, cost: C(30000, 4000, 20000, { cpu: "medium", network: true }), verification_required: false, idempotent: false,
    preferred_for: ["broad read-only investigation that would flood the context"],
    avoid_when: ["the answer needs one grep", "you already know the file", "inside a sub-agent (depth limit)"],
    mutates: [],
  },
  {
    name: "fetch_url",
    description: "Fetch an http(s) page or JSON API (SSRF-guarded, capped, redacted).",
    capabilities: [CAPABILITY.NETWORK_FETCH],
    klass: CLASS.NETWORK, classes: [CLASS.NETWORK, CLASS.READ],
    risk: RISK.MEDIUM, read_only: true, reversible: true, parallel_safe: true,
    requires_confirmation: false, requires_network: true, requires_filesystem: false,
    timeout: 30, cost: C(1200, 2500, 20000, { network: true }), verification_required: false, idempotent: true,
    preferred_for: ["read a documentation page or API response the user linked"],
    avoid_when: ["the information is already in the repository", "offline"],
    mutates: [],
  },
  {
    name: "web_search",
    description: "Search the web and return ranked results.",
    capabilities: [CAPABILITY.WEB_SEARCH],
    klass: CLASS.NETWORK, classes: [CLASS.NETWORK, CLASS.READ],
    risk: RISK.MEDIUM, read_only: true, reversible: true, parallel_safe: true,
    requires_confirmation: false, requires_network: true, requires_filesystem: false,
    timeout: 30, cost: C(1500, 1200, 8000, { network: true }), verification_required: false, idempotent: true,
    preferred_for: ["unknown library/API behaviour that the repo cannot answer"],
    avoid_when: ["the repository or an installed skill already answers it", "offline"],
    mutates: [],
  },
  {
    name: "edit_file",
    description: "Exact string replacement in a file (auto-checkpointed).",
    capabilities: [CAPABILITY.CODE_MODIFICATION, CAPABILITY.FILE_EDITING, CAPABILITY.FILE_WRITE],
    klass: CLASS.WRITE, classes: [CLASS.WRITE],
    risk: RISK.MEDIUM, read_only: false, reversible: true, parallel_safe: false,
    requires_confirmation: false, requires_network: false, requires_filesystem: true,
    timeout: 20, cost: C(30, 200, 500), verification_required: true, idempotent: true,
    preferred_for: ["a small, precise change to an existing file"],
    avoid_when: ["the file does not exist yet (write_file)", "many changes in one file (multi_edit)", "the exact old text is unknown — read it first"],
    verify_after: ["syntax", "content_applied"],
    mutates: ["filesystem"],
  },
  {
    name: "multi_edit",
    description: "Several exact replacements in one file, applied atomically.",
    capabilities: [CAPABILITY.CODE_MODIFICATION, CAPABILITY.FILE_EDITING, CAPABILITY.FILE_WRITE],
    klass: CLASS.WRITE, classes: [CLASS.WRITE],
    risk: RISK.MEDIUM, read_only: false, reversible: true, parallel_safe: false,
    requires_confirmation: false, requires_network: false, requires_filesystem: true,
    timeout: 25, cost: C(40, 250, 700), verification_required: true, idempotent: true,
    preferred_for: ["multiple related edits in the same file"],
    avoid_when: ["a single replacement is enough", "the changes span several files (apply_patch)"],
    verify_after: ["syntax", "content_applied"],
    mutates: ["filesystem"],
  },
  {
    name: "write_file",
    description: "Create or overwrite a file (auto-checkpointed).",
    capabilities: [CAPABILITY.FILE_WRITE, CAPABILITY.FILE_CREATE, CAPABILITY.CODE_MODIFICATION],
    klass: CLASS.WRITE, classes: [CLASS.WRITE],
    risk: RISK.MEDIUM, read_only: false, reversible: true, parallel_safe: false,
    requires_confirmation: false, requires_network: false, requires_filesystem: true,
    timeout: 25, cost: C(35, 200, 500), verification_required: true, idempotent: true,
    preferred_for: ["creating a new file"],
    avoid_when: ["the file exists and only part of it changes — that is edit_file/multi_edit"],
    verify_after: ["file_exists", "syntax"],
    mutates: ["filesystem"],
  },
  {
    name: "apply_patch",
    description: "Apply a unified diff across one or more files.",
    capabilities: [CAPABILITY.PATCH_APPLICATION, CAPABILITY.CODE_MODIFICATION, CAPABILITY.FILE_WRITE],
    klass: CLASS.WRITE, classes: [CLASS.WRITE],
    risk: RISK.MEDIUM, read_only: false, reversible: true, parallel_safe: false,
    requires_confirmation: false, requires_network: false, requires_filesystem: true,
    timeout: 40, cost: C(60, 400, 1200), verification_required: true, idempotent: true,
    preferred_for: ["a structured change spanning several files"],
    avoid_when: ["one small replacement would do"],
    verify_after: ["patch_applied", "syntax"],
    mutates: ["filesystem"],
  },
  {
    name: "bash",
    description: "Run a shell command (builds, tests, git, installs) — risk-classified by shellguard.",
    capabilities: [CAPABILITY.COMMAND_EXECUTION, CAPABILITY.TEST_EXECUTION, CAPABILITY.BUILD_EXECUTION, CAPABILITY.VERIFICATION],
    klass: CLASS.EXECUTE, classes: [CLASS.EXECUTE, CLASS.WRITE, CLASS.VERIFICATION],
    risk: RISK.MEDIUM, read_only: false, reversible: false, parallel_safe: false,
    requires_confirmation: false, requires_network: false, requires_filesystem: true,
    timeout: 45, cost: C(1500, 1500, 12000, { cpu: "high" }), verification_required: false, idempotent: false,
    preferred_for: ["running tests, builds and git", "verifying a change with real evidence"],
    avoid_when: ["a dedicated tool exists (read_file/grep_files/git_status)", "the command mutates state outside the project"],
    verify_after: [],
    mutates: ["filesystem", "processes"],
  },
]

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

function normalizeMeta(meta) {
  const m = { ...CONSERVATIVE, ...meta }
  m.name = String(m.name || "").trim()
  m.capabilities = [...new Set((m.capabilities || []).map(String))]
  m.classes = [...new Set([m.klass, ...(m.classes || [])].filter((c) => CLASSES.includes(c)))]
  if (!m.classes.length) m.classes = [CLASS.WRITE]
  m.klass = m.classes[0]
  m.risk = RISK_ORDER.includes(m.risk) ? m.risk : RISK.MEDIUM
  m.status = STATUSES.includes(m.status) ? m.status : STATUS.ENABLED
  m.cost = { ...CONSERVATIVE.cost, ...(m.cost || {}) }
  m.preferred_for = (m.preferred_for || []).map(String)
  m.avoid_when = (m.avoid_when || []).map(String)
  m.verify_after = (m.verify_after || []).map(String)
  m.mutates = m.read_only ? (m.mutates || []).filter((x) => x !== "filesystem") : (m.mutates || [])
  // invariant: a read-only tool never declares itself a WRITE-class mutation
  // (v20.5.1: fix `classes` too — leaving WRITE first made klass and
  //  classes[0] disagree, and every consumer that reads classes[0] saw WRITE)
  if (m.read_only && m.klass === CLASS.WRITE) {
    m.classes = [CLASS.READ, ...m.classes.filter((c) => c !== CLASS.WRITE)]
    m.klass = CLASS.READ
  }
  return m
}

function validateMeta(m) {
  if (!m.name) return "tool metadata has no name"
  if (!/^[a-z][a-z0-9_]{1,40}$/i.test(m.name)) return `invalid tool name ${JSON.stringify(m.name)}`
  if (!Array.isArray(m.capabilities) || !m.capabilities.length) return `tool "${m.name}" declares no capabilities`
  if (typeof m.timeout !== "number" || m.timeout <= 0) return `tool "${m.name}" has an invalid timeout`
  return null
}

/**
 * Build a registry. `config` is the forge config object (optional):
 *   tools.disabled: ["web_search"]      → status disabled (router avoids them)
 *   tools.deprecated: ["list_dir"]      → status deprecated (last resort only)
 *   tools.experimental: false           → experimental tools are not routed to
 */
export function createRegistry({ metas = BUILTIN_CAPABILITIES, config = {} } = {}) {
  const byName = new Map()
  const errors = []
  const disabled = new Set(config?.tools?.disabled ?? [])
  const deprecated = new Set(config?.tools?.deprecated ?? [])
  const allowExperimental = config?.tools?.experimental !== false

  const applyPolicy = (m) => {
    if (disabled.has(m.name)) m.status = STATUS.DISABLED
    else if (deprecated.has(m.name) && m.status === STATUS.ENABLED) m.status = STATUS.DEPRECATED
    return m
  }

  const reg = {
    /** Register (or replace) a tool's metadata. Returns { ok, error }. */
    register(meta, { source = "builtin", replace = true } = {}) {
      const m = applyPolicy(normalizeMeta({ ...meta, source }))
      const err = validateMeta(m)
      if (err) { errors.push(err); return { ok: false, error: err } }
      if (!replace && byName.has(m.name)) return { ok: false, error: `tool "${m.name}" already registered` }
      byName.set(m.name, m)
      return { ok: true, meta: m }
    },
    /** Metadata for a tool. Unknown tools get conservative defaults so the
     *  pipeline can still gate them (never `undefined` at a decision point). */
    get(name) {
      return byName.get(name) ?? null
    },
    /** Like get(), but never null: unknown → conservative WRITE-class stub. */
    resolve(name) {
      return (
        byName.get(name) ??
        normalizeMeta({
          name: String(name || "unknown"),
          description: "unknown tool — treated conservatively",
          capabilities: ["unknown"],
          source: "unknown",
        })
      )
    },
    has(name) { return byName.has(name) },
    names() { return [...byName.keys()] },
    size() { return byName.size },
    errors() { return [...errors] },
    /** All metadata, optionally filtered. */
    list({ status, capability, klass, includeDisabled = true, readOnly } = {}) {
      let out = [...byName.values()]
      if (!includeDisabled) out = out.filter((m) => m.status !== STATUS.DISABLED)
      if (status) out = out.filter((m) => m.status === status)
      if (capability) out = out.filter((m) => m.capabilities.includes(capability))
      if (klass) out = out.filter((m) => m.classes.includes(klass))
      if (readOnly !== undefined) out = out.filter((m) => m.read_only === readOnly)
      return out.sort((a, b) => a.name.localeCompare(b.name))
    },
    /**
     * Tools that provide `capability`, best first (§2, §10, §19):
     * enabled before experimental before deprecated; then cheaper; then lower
     * baseline risk. Disabled tools are never returned. A deprecated tool is
     * only in the list when nothing else provides the capability.
     */
    providersOf(capability, { available = null, allowDeprecated = true } = {}) {
      const usable = [...byName.values()].filter(
        (m) =>
          m.capabilities.includes(capability) &&
          m.status !== STATUS.DISABLED &&
          (allowExperimental || m.status !== STATUS.EXPERIMENTAL) &&
          (!available || available.includes(m.name))
      )
      const rank = (m) => (m.status === STATUS.ENABLED ? 0 : m.status === STATUS.EXPERIMENTAL ? 1 : 2)
      const fresh = usable.filter((m) => m.status !== STATUS.DEPRECATED)
      const pool = fresh.length ? fresh : allowDeprecated ? usable : []
      return pool.sort(
        (a, b) => rank(a) - rank(b) || costScore(a) - costScore(b) || riskRank(a.risk) - riskRank(b.risk) || a.name.localeCompare(b.name)
      )
    },
    /** Change lifecycle status at runtime (plugin disable, deprecation, …). */
    setStatus(name, status) {
      const m = byName.get(name)
      if (!m) return { ok: false, error: `unknown tool "${name}"` }
      if (!STATUSES.includes(status)) return { ok: false, error: `unknown status "${status}"` }
      byName.set(name, { ...m, status })
      return { ok: true }
    },
    /** JSON-serializable snapshot (used by `forge tools --json`). */
    snapshot() {
      return this.list().map((m) => ({ ...m, cost: { ...m.cost } }))
    },
  }

  for (const m of metas) reg.register(m, { source: "builtin" })
  return reg
}

/** Rough scalar cost, used only to order equivalent tools (§10). */
export function costScore(meta) {
  const c = meta?.cost ?? CONSERVATIVE.cost
  const cpu = { low: 0, medium: 1, high: 3 }[c.cpu] ?? 0
  return (c.latency ?? 0) / 100 + (c.tokens ?? 0) / 100 + cpu + (c.network ? 5 : 0)
}

/**
 * Register user tool plugins (§18) — a new tool joins the SAME capability
 * system with no core change. A plugin may declare any registry field; what it
 * does not declare gets a conservative default derived from `readOnly`.
 */
export function registerPlugins(registry, plugins = []) {
  const added = []
  for (const pl of plugins) {
    if (!pl?.name) continue
    const d = pl.capabilitiesMeta ?? pl.meta ?? pl
    const readOnly = pl.readOnly === true
    const meta = {
      name: pl.name,
      description: pl.def?.function?.description ?? d.description ?? "plugin tool",
      capabilities: Array.isArray(d.capabilities) && d.capabilities.length ? d.capabilities : [readOnly ? "plugin_read" : "plugin_action"],
      klass: d.klass ?? (readOnly ? CLASS.READ : CLASS.WRITE),
      classes: d.classes ?? (readOnly ? [CLASS.READ] : [CLASS.WRITE]),
      risk: d.risk ?? (readOnly ? RISK.LOW : RISK.MEDIUM),
      read_only: readOnly,
      reversible: d.reversible ?? readOnly,
      parallel_safe: d.parallel_safe ?? d.parallelSafe ?? readOnly,
      requires_confirmation: d.requires_confirmation ?? false,
      requires_network: d.requires_network ?? false,
      requires_filesystem: d.requires_filesystem ?? true,
      timeout: d.timeout ?? 60,
      cost: d.cost ?? C(500, 400, 4000),
      verification_required: d.verification_required ?? !readOnly,
      preferred_for: d.preferred_for ?? [],
      avoid_when: d.avoid_when ?? [],
      idempotent: d.idempotent ?? readOnly,
      status: STATUSES.includes(d.status) ? d.status : STATUS.ENABLED,
      verify_after: d.verify_after ?? [],
      mutates: readOnly ? [] : ["filesystem"],
    }
    const r = registry.register(meta, { source: `plugin:${pl.source ?? "user"}` })
    if (r.ok) added.push(r.meta)
  }
  return added
}

// ---------------------------------------------------------------------------
// operation-level risk (§5) — derived from the ACTUAL operation
// ---------------------------------------------------------------------------

const TEST_CMD = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|check|build)\b|\b(pytest|jest|vitest|mocha|go\s+test|cargo\s+test|make\s+test|tsc)\b/
const READ_CMD = /^\s*(ls|cat|head|tail|wc|pwd|echo|which|env|date|git\s+(status|log|diff|show|branch)|node\s+-v|npm\s+(ls|view|outdated))\b/
const INSTALL_CMD = /\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|ci)\b|\bpip3?\s+install\b|\bapt(-get)?\s+install\b|\bbrew\s+install\b|\bcargo\s+(add|install)\b/
const VCS_MUTATE = /\bgit\s+(commit|merge|rebase|reset|checkout|switch|cherry-pick|stash|tag|am|revert)\b/
const VCS_REMOTE = /\bgit\s+(push|pull|fetch|clone|remote)\b/

/**
 * Risk of THIS call. Uses shellguard for shell commands (never re-implements
 * it) and argument shape for everything else.
 * Returns { risk, level, reasons[], klass, network, mutation }.
 */
export function operationRisk(name, args = {}, ctx = {}) {
  const meta = ctx.registry?.resolve ? ctx.registry.resolve(name) : null
  const base = meta?.risk ?? CONSERVATIVE.risk
  const reasons = []
  const cwd = ctx.cwd || process.cwd()
  const root = ctx.root || cwd
  const a = args && typeof args === "object" ? args : {}

  switch (name) {
    case "bash": {
      const command = String(a.command ?? "")
      const v = classifyCommand(command, { cwd, root, allowSudo: ctx.allowSudo === true })
      // shellguard level → forge risk. safe/low stay LOW; anything that needs
      // confirmation is at least HIGH; danger/block are CRITICAL.
      const map = { safe: RISK.LOW, low: RISK.LOW, confirm: RISK.HIGH, danger: RISK.CRITICAL, block: RISK.CRITICAL }
      let risk = map[v.level] ?? RISK.MEDIUM
      if (v.reasons?.length) reasons.push(...v.reasons.slice(0, 3))
      if (risk === RISK.LOW) {
        if (INSTALL_CMD.test(command)) { risk = RISK.MEDIUM; reasons.push("installs or removes dependencies") }
        else if (VCS_MUTATE.test(command)) { risk = RISK.MEDIUM; reasons.push("mutates git history or the working tree") }
        else if (VCS_REMOTE.test(command)) { risk = RISK.MEDIUM; reasons.push("talks to a git remote") }
        else if (TEST_CMD.test(command)) reasons.push("test/build command (read-mostly)")
        else if (READ_CMD.test(command)) reasons.push("inspection command")
      }
      return {
        risk, level: v.level, reasons: reasons.length ? reasons : ["shell command"],
        klass: CLASS.EXECUTE, // a shell command is EXECUTE even when it only reads
        network: VCS_REMOTE.test(command) || INSTALL_CMD.test(command) || /\b(curl|wget)\b/.test(command),
        mutation: !READ_CMD.test(command),
        verify: TEST_CMD.test(command) ? "tests" : INSTALL_CMD.test(command) ? "install" : null,
      }
    }
    case "write_file": {
      const p = a.path ? path.resolve(cwd, String(a.path)) : null
      let exists = false
      try { exists = !!p && fs.existsSync(p) && fs.statSync(p).isFile() } catch { /* ignore */ }
      return {
        risk: exists ? RISK.MEDIUM : RISK.LOW,
        reasons: [exists ? "overwrites an existing file (checkpointed, reversible)" : "creates a new file"],
        klass: CLASS.WRITE, network: false, mutation: true,
      }
    }
    case "edit_file":
    case "multi_edit": {
      const all = a.replace_all === true
      return {
        risk: RISK.MEDIUM,
        reasons: [all ? "replaces every occurrence in the file" : "targeted replacement in an existing file"],
        klass: CLASS.WRITE, network: false, mutation: true,
      }
    }
    case "apply_patch": {
      const patch = String(a.patch ?? "")
      const deletes = /\n\+\+\+ \/dev\/null/.test(patch)
      const files = (patch.match(/^\+\+\+ /gm) || []).length
      return {
        risk: deletes ? RISK.HIGH : RISK.MEDIUM,
        reasons: [deletes ? "the patch deletes one or more files" : `patch touches ${files || 1} file(s)`],
        klass: CLASS.WRITE, network: false, mutation: true,
      }
    }
    case "fetch_url":
      return { risk: RISK.MEDIUM, reasons: ["outbound network request (SSRF-guarded)"], klass: CLASS.NETWORK, network: true, mutation: false }
    case "web_search":
      return { risk: RISK.MEDIUM, reasons: ["outbound search query"], klass: CLASS.NETWORK, network: true, mutation: false }
    case "memory": {
      const act = String(a.action ?? "read")
      const destructive = act === "clear" || act === "forget"
      return {
        risk: destructive ? RISK.MEDIUM : RISK.LOW,
        reasons: [destructive ? "removes remembered facts" : `memory ${act}`],
        klass: CLASS.READ, network: false, mutation: act !== "read",
      }
    }
    case "delegate":
      return { risk: RISK.MEDIUM, reasons: ["spawns a read-only sub-agent (model cost, latency)"], klass: CLASS.READ, network: true, mutation: false }
    case "read_file":
    case "grep_files":
    case "glob_files":
    case "list_dir":
    case "git_status":
    case "think":
    case "todo":
    case "load_skill":
      return { risk: RISK.LOW, reasons: ["read-only inspection"], klass: CLASS.READ, network: false, mutation: false }
    default: {
      if (meta) {
        return {
          risk: base,
          reasons: [meta.source?.startsWith("plugin") ? "plugin tool (declared risk)" : "declared risk"],
          klass: meta.klass, network: meta.requires_network, mutation: !meta.read_only,
        }
      }
      return { risk: RISK.MEDIUM, reasons: ["unknown tool — conservative default"], klass: CLASS.WRITE, network: false, mutation: true }
    }
  }
}

/** READ / WRITE / EXECUTE / … classification of a concrete call (§4). */
export function classifyCall(name, args = {}, ctx = {}) {
  const meta = ctx.registry?.resolve ? ctx.registry.resolve(name) : null
  const op = operationRisk(name, args, ctx)
  const readOnly = meta ? meta.read_only : !op.mutation
  return {
    name,
    classes: meta?.classes ?? [op.klass],
    klass: op.klass ?? meta?.klass ?? CLASS.WRITE,
    read_only: readOnly,
    parallel_safe: (meta?.parallel_safe ?? false) && readOnly,
    risk: op.risk,
    reasons: op.reasons,
    network: op.network || (meta?.requires_network ?? false),
    mutation: op.mutation,
  }
}

/**
 * Compatibility invariant (§22 regression compatibility): the registry's
 * read/write split must agree with tools.js WRITE_TOOLS for every built-in.
 * Exported so the test suite can assert it and `forge doctor` can check it.
 */
export function checkWriteClassification(registry) {
  const problems = []
  for (const m of registry.list()) {
    if (!m.source?.startsWith("builtin")) continue
    const isWrite = WRITE_TOOLS.has(m.name)
    if (isWrite && m.read_only) problems.push(`${m.name}: WRITE_TOOLS says write, registry says read_only`)
    if (!isWrite && !m.read_only) problems.push(`${m.name}: registry says write, WRITE_TOOLS says read-only`)
  }
  return problems
}

/** Default registry for the current config (built-ins only — add plugins with
 *  registerPlugins()). */
export function defaultRegistry(config = {}) {
  return createRegistry({ config })
}
