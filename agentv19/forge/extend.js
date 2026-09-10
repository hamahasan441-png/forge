/**
 * forge — isolated plugin / skill self-extension (v42, zero dependencies)
 *
 * L5: after a successful repair, author a project-local isolated plugin
 * that returns the playbook. It is read-only. It declares no capabilities.
 * It never lands in ~/.forge/tools (the user plugin dir). It never writes
 * plugin-host.js. Grants stay empty — declared ∩ granted = nothing extra.
 *
 * Repair text is JSON data, not executable source. MICRO/SMALL skip.
 * Same-run quarantine still applies: a plugin authored this task is
 * skipped until the next task (allowNewPlugins stays false).
 *
 * This is self-extension of isolated tools. It is not kernel self-mod.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { classifyTask, TASK_CLASS } from "./classify.js"
import { projectDir } from "./memory.js"
import { writeStateFile } from "./securefs.js"
import { redact } from "./secrets.js"
import { loadToolPlugins, PLUGINS_DIR } from "./plugins.js"

const STOP = new Set([
  "the", "and", "for", "with", "from", "this", "that", "fix", "add", "please",
  "across", "files", "file", "into", "your", "you", "are", "was", "will", "can",
  "not", "but", "all", "any", "how", "what", "why", "who", "its", "our",
])

const KERNEL_HINT = /(?:^|[^A-Za-z0-9])(agentv19[\\/]forge|classifyTaskComplexity|assumeYes|plugin-host|securefs)\b/i
const NAME_RE = /^[a-z][a-z0-9_]{1,40}$/
const HOST_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "plugin-host.js")
const FORBIDDEN_NAMES = new Set([
  "bash", "write_file", "edit_file", "multi_edit", "apply_patch", "read_file",
  "glob_files", "grep_files", "delegate", "think", "todo", "memory",
  "fetch_url", "web_search", "load_skill",
])

function underDir(p, root) {
  const a = path.resolve(p)
  const b = path.resolve(root)
  const rel = path.relative(b, a)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function looksLikeKernel(task, repair, files) {
  const blob = `${task || ""} ${repair || ""} ${(files || []).join(" ")}`
  return KERNEL_HINT.test(blob)
}

function resolvedKlass(task, klass) {
  if (klass) return klass
  try { return classifyTask(task || "").class } catch { return TASK_CLASS.MEDIUM }
}

export function learnedPluginsDir(cwd = process.cwd()) {
  return path.join(projectDir(cwd), "tools")
}

export function pluginSlug(task = "") {
  const toks = String(task || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t)).slice(0, 3)
  const base = `learned_${toks.join("_") || "repair"}`.replace(/[^a-z0-9_]/g, "_").slice(0, 40)
  if (!NAME_RE.test(base)) return null
  return base
}

/**
 * Fixed-template plugin source. User strings live in JSON, never as code.
 */
export function formatPluginMjs({ name, description, task, repair, files = [], command = "" } = {}) {
  const playbook = {
    tool: String(name || "learned_repair").slice(0, 40),
    description: redact(String(description || repair || task || name)).slice(0, 200),
    task: redact(String(task || "")).slice(0, 400),
    repair: redact(String(repair || "")).slice(0, 800),
    files: (files || []).map((f) => redact(String(f)).slice(0, 160)).slice(0, 8),
    command: redact(String(command || "")).slice(0, 80),
  }
  return [
    "/** forge learned plugin — isolated, read-only, no capabilities. Do not edit the kernel. */",
    `const PLAYBOOK = ${JSON.stringify(playbook, null, 2)}`,
    "export default {",
    "  name: PLAYBOOK.tool,",
    "  description: PLAYBOOK.description,",
    '  parameters: { type: "object", properties: { topic: { type: "string" } } },',
    "  readOnly: true,",
    "  timeoutMs: 8000,",
    "  async run() {",
    "    const lines = [",
    '      "PLAYBOOK " + PLAYBOOK.tool,',
    '      "When: " + PLAYBOOK.task,',
    '      "What worked: " + PLAYBOOK.repair,',
    "    ]",
    '    if (PLAYBOOK.files.length) lines.push("Files: " + PLAYBOOK.files.join(", "))',
    '    if (PLAYBOOK.command) lines.push("Verify (do not invent a toolchain): " + PLAYBOOK.command)',
    '    lines.push("Do not edit forge kernel files. Do not flip assumeYes.")',
    '    return lines.join("\\n")',
    "  },",
    "}",
    "",
  ].join("\n")
}

/**
 * Write a project-local isolated plugin from a successful repair.
 * Never writes ~/.forge/tools, plugin-host.js, or the bundled pack.
 * MICRO/SMALL skip. No capabilities. No grants.
 */
export function authorPlugin({
  cwd = process.cwd(), task = "", klass = null, repair = "", files = [], command = "",
  reserved = null,
} = {}) {
  const k = resolvedKlass(task, klass)
  if (k === TASK_CLASS.MICRO || k === TASK_CLASS.SMALL) return { ok: false, skipped: "micro" }
  const body = String(repair || "").trim()
  if (!body) return { ok: false, skipped: "no-repair" }
  if (looksLikeKernel(task, body, files)) return { ok: false, skipped: "kernel" }
  const name = pluginSlug(task)
  if (!name) return { ok: false, skipped: "bad-name" }
  if (FORBIDDEN_NAMES.has(name) || (reserved && (reserved.has?.(name) || reserved.includes?.(name)))) {
    return { ok: false, skipped: "reserved" }
  }
  const dir = learnedPluginsDir(cwd)
  if (underDir(dir, PLUGINS_DIR) || PLUGINS_DIR === dir) return { ok: false, skipped: "global-tools" }
  const file = path.join(dir, `${name}.mjs`)
  if (underDir(file, path.dirname(HOST_FILE)) || path.resolve(file) === HOST_FILE) {
    return { ok: false, skipped: "host" }
  }
  if (fs.existsSync(file)) return { ok: true, name, path: file, deduped: true }
  const description = `Playbook: ${String(task || name).slice(0, 120)}`
  const src = formatPluginMjs({ name, description, task, repair: body, files, command })
  try {
    fs.mkdirSync(dir, { recursive: true })
    writeStateFile(file, src, { mode: 0o600 })
  } catch (e) {
    return { ok: false, skipped: "write", error: String(e?.message || e).slice(0, 120) }
  }
  return { ok: true, name, path: file, deduped: false, readOnly: true }
}

/**
 * Load isolated plugins from the project-local learned dir.
 * Grants are always {} — learned plugins never inherit user pluginGrants.
 */
export async function loadLearnedPlugins(cwd = process.cwd(), opts = {}) {
  const dir = learnedPluginsDir(cwd)
  return loadToolPlugins(dir, {
    reserved: opts.reserved || [],
    grants: {},
    cwd,
    startedAt: opts.startedAt ?? null,
    allowNewPlugins: opts.allowNewPlugins === true,
  })
}

/**
 * Global ~/.forge/tools names win. Learned extras append. Close both hosts.
 */
export async function mergeLearnedPlugins(loaded, cwd = process.cwd(), opts = {}) {
  const base = loaded && typeof loaded === "object"
    ? loaded
    : { tools: [], errors: [], close: () => {} }
  let extra
  try {
    extra = await loadLearnedPlugins(cwd, opts)
  } catch {
    extra = { tools: [], errors: [], close: () => {} }
  }
  const names = new Set((base.tools || []).map((t) => t && t.name).filter(Boolean))
  const tools = [...(base.tools || [])]
  for (const t of extra.tools || []) {
    if (!t || !t.name || names.has(t.name)) continue
    names.add(t.name)
    tools.push(t)
  }
  return {
    tools,
    errors: [...(base.errors || []), ...(extra.errors || [])],
    close() {
      try { base.close?.() } catch { /* best-effort */ }
      try { extra.close?.() } catch { /* best-effort */ }
    },
  }
}

export { TASK_CLASS, NAME_RE, KERNEL_HINT }
