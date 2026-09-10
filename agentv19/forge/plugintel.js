/**
 * forge — plugin intelligence (v53).
 *
 * Rank isolated user plugins + first-party plugin *playbooks* (markdown,
 * never spawned) against the task. Learned plugins stay hostless.
 * User ~/.forge/tools still load through plugins.js isolation.
 *
 * Zero runtime dependencies. Does not write ~/.forge/tools.
 */
import { selectPlugins, scoreAgainst, namedIn } from "./evaluate.js"

/** Playbooks the model can follow without a live plugin-host. */
export const PLUGIN_PLAYBOOKS = [
  { name: "repo_map", description: "Walk the repo map and name the files that matter", readOnly: true, tags: ["map", "index", "symbols"] },
  { name: "focused_verify", description: "Run the stack-native test command on changed files", readOnly: true, tags: ["test", "verify", "cargo", "npm"] },
  { name: "secret_scan", description: "Scan the diff for keys, tokens, and private URLs", readOnly: true, tags: ["secret", "security", "redact"] },
  { name: "impact_trace", description: "Follow importers, tests, and deploy edges for a file", readOnly: true, tags: ["impact", "graph", "depend"] },
  { name: "patch_apply", description: "Apply one atomic unified diff and checkpoint", readOnly: false, tags: ["patch", "edit", "apply"] },
  { name: "pr_notes", description: "Draft a PR summary from the verify ledger", readOnly: true, tags: ["pr", "review", "summary"] },
]

export function scorePlugin(task, plugin) {
  const p = plugin || {}
  const desc = p.def?.function?.description || p.description || ""
  const tags = (p.tags || []).join(" ")
  let score = scoreAgainst(task, p.name, `${desc} ${tags}`)
  if (namedIn(task, p.name)) score += 10
  return score
}

/**
 * Isolated plugins via selectPlugins + matching playbooks (not live tools).
 * MICRO/SMALL: only named. Playbooks never become executable tools.
 */
export function pickPlugins(task, plugins = [], opts = {}) {
  const live = selectPlugins(task, plugins, opts)
  const q = String(task ?? "").trim()
  const micro = opts.klass === "micro" || opts.klass === "small"
  const books = []
  for (const b of PLUGIN_PLAYBOOKS) {
    const explicit = namedIn(q, b.name)
    if (micro && !explicit) continue
    const score = scorePlugin(q, b)
    if (explicit || score >= (opts.minScore ?? 2)) books.push({ ...b, score, playbook: true })
  }
  books.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return { tools: live, playbooks: books.slice(0, opts.topK ?? 3) }
}

export function formatPluginPicks({ tools = [], playbooks = [] } = {}) {
  const lines = []
  if (playbooks.length) {
    lines.push(`PLUGIN PLAYBOOKS (${playbooks.length}) — follow the steps, do not spawn plugin-host:`)
    for (const p of playbooks) lines.push(`- ${p.name}: ${p.description}`)
  }
  const isolated = tools.filter((t) => t && t.isolated)
  if (isolated.length) {
    lines.push(`ISOLATED PLUGINS (${isolated.length}) — already granted this turn:`)
    for (const t of isolated) lines.push(`- ${t.name}`)
  }
  return lines.join("\n")
}
