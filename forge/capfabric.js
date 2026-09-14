/**
 * forge — capability fabric (v100 "fabricwise").
 *
 * The problem this solves: forge had FOUR capability registries that did not
 * know about each other. Skills were relevance-scored and injected top-k
 * (evaluate.js), but MCP tools were not filtered at all — every tool of every
 * configured server went into every model context. Ten servers at ~30 tools
 * each is ~300 tool definitions on every single request, and the official
 * filesystem/git servers ship tools whose names (`read_file`, `write_file`,
 * `edit_file`, `git_status`, `git_diff`, `git_log`) COLLIDE exactly with
 * forge's own native tools — so the model saw the same capability twice under
 * two names.
 *
 * This module is the gate in front of the model context. Two rules, both
 * conservative:
 *
 *   1. DEDUPE — an external tool whose bare name exactly matches a native tool
 *      is dropped. Native wins: it is cheaper (no child process), already
 *      policy-routed, and already covered by forge's own tests. Exact-match
 *      only — never fuzzy, so a genuinely different tool is never removed.
 *
 *   2. BUDGET — when externals exceed `maxExternal`, they are scored against
 *      the actual task and only the best survive. Below that threshold nothing
 *      is filtered, so small/normal setups behave EXACTLY as before.
 *
 * Nothing is dropped silently: the result carries `dropped` with a reason per
 * tool, so the caller can report it as evidence (§71) rather than a claim.
 *
 * Native tools are never gated — they are the 29-tool core the agent loop and
 * its tests depend on. Zero dependencies.
 */
import { parseMcpToolName } from "./mcp.js"
import { scoreAgainst } from "./evaluate.js"

/** Default ceiling on EXTERNAL (MCP/created) tool defs offered per request.
 *  Chosen to sit above a normal 2-4 server setup so those are untouched. */
export const DEFAULT_MAX_EXTERNAL = 24

/** True for a capability that came from an MCP server. */
export function isExternal(p) {
  return typeof p?.source === "string" && p.source.startsWith("mcp:")
}

/** The tool's own name with forge's `mcp__<server>__` namespace removed.
 *  A non-namespaced name is returned unchanged. */
export function bareToolName(name) {
  const parsed = parseMcpToolName(name)
  return parsed ? parsed.tool : String(name || "")
}

/** Does the task text explicitly name this capability or its server?
 *  An explicitly requested tool is never budgeted away. */
export function namedInTask(task, plugin) {
  const t = String(task || "").toLowerCase()
  if (!t) return false
  const full = String(plugin?.name || "").toLowerCase()
  if (full && t.includes(full)) return true
  const parsed = parseMcpToolName(plugin?.name)
  if (parsed) {
    const server = parsed.server.toLowerCase()
    // a bare server mention ("use the github server") pins its whole toolset
    if (server.length >= 3 && t.includes(server)) return true
    const bare = parsed.tool.toLowerCase()
    if (bare.length >= 4 && t.includes(bare)) return true
  }
  return false
}

/**
 * Select the capabilities that go into this request's context.
 *
 * @returns {{ kept: Array, dropped: Array<{name, reason}>, gated: boolean }}
 */
export function selectCapabilities({
  task = "",
  plugins = [],
  nativeNames = [],
  maxExternal = DEFAULT_MAX_EXTERNAL,
  dedupe = true,
} = {}) {
  const list = Array.isArray(plugins) ? plugins.filter(Boolean) : []
  const native = new Set((nativeNames || []).map((n) => String(n)))
  const dropped = []

  // Everything that is not an MCP capability passes through untouched.
  const passthrough = list.filter((p) => !isExternal(p))
  let externals = list.filter(isExternal)

  if (dedupe && native.size) {
    externals = externals.filter((p) => {
      const bare = bareToolName(p.name)
      if (native.has(bare)) {
        dropped.push({ name: p.name, reason: `duplicates the native tool "${bare}"` })
        return false
      }
      return true
    })
  }

  const cap = Number.isFinite(maxExternal) && maxExternal > 0 ? Math.floor(maxExternal) : DEFAULT_MAX_EXTERNAL
  if (externals.length <= cap) {
    return { kept: [...passthrough, ...externals], dropped, gated: false }
  }

  // Over budget: score against the real task. Explicitly named tools are
  // pinned first, then the highest scoring fill the remaining slots. Ordering
  // among equals follows the original (config) order — stable, never random.
  const scored = externals.map((p, i) => ({
    p, i,
    pinned: namedInTask(task, p),
    score: scoreAgainst(task, bareToolName(p.name), String(p?.def?.function?.description ?? "")),
  }))
  scored.sort((a, b) => (b.pinned - a.pinned) || (b.score - a.score) || (a.i - b.i))

  const keep = scored.slice(0, cap)
  for (const s of scored.slice(cap)) {
    dropped.push({ name: s.p.name, reason: `over the ${cap}-tool external budget for this task (score ${s.score})` })
  }
  // restore config order among the survivors
  keep.sort((a, b) => a.i - b.i)
  return { kept: [...passthrough, ...keep.map((s) => s.p)], dropped, gated: true }
}

/** One-line, user-facing summary of what the gate did. Empty when it did
 *  nothing, so a quiet setup stays quiet. */
export function formatSelection({ dropped = [], gated = false } = {}) {
  if (!dropped.length) return ""
  const dup = dropped.filter((d) => /duplicates the native/.test(d.reason)).length
  const bud = dropped.length - dup
  const parts = []
  if (dup) parts.push(`${dup} duplicate of a native tool`)
  if (bud) parts.push(`${bud} over the relevance budget`)
  return `capability fabric: ${dropped.length} MCP tool(s) withheld — ${parts.join(", ")}${gated ? "" : ""}`
}
