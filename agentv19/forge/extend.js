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

const PLAYBOOK_MARK = "const PLAYBOOK"
const INDEX_CAP = 24
const PLAYBOOK_MAX_BYTES = 64 * 1024

function relFile(f) {
  const s = String(f || "").replace(/\\/g, "/").replace(/^\.\//, "").trim()
  if (!s || s.length > 160) return ""
  if (s.startsWith("/") || s.startsWith("~") || s.includes("://")) return ""
  if (s.split("/").some((p) => p === ".." || p === "")) return ""
  return s
}

/**
 * Pull the JSON object after `const PLAYBOOK =` without executing the file.
 * Brace-matched with string/escape awareness. Never eval.
 */
function extractJsonObject(src, marker = PLAYBOOK_MARK) {
  const i = String(src || "").indexOf(marker)
  if (i < 0) return null
  const eq = src.indexOf("=", i + marker.length)
  if (eq < 0 || eq > i + marker.length + 24) return null
  let start = -1
  for (let j = eq + 1; j < src.length; j++) {
    const c = src[j]
    if (c === "{") { start = j; break }
    if (c !== " " && c !== "\n" && c !== "\r" && c !== "\t") return null
  }
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let j = start; j < src.length; j++) {
    const c = src[j]
    if (inStr) {
      if (esc) { esc = false; continue }
      if (c === "\\") { esc = true; continue }
      if (c === "\"") inStr = false
      continue
    }
    if (c === "\"") { inStr = true; continue }
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) return src.slice(start, j + 1)
    }
  }
  return null
}

/**
 * Read a learned plugin's PLAYBOOK as data. Never import(), eval, or spawn.
 * Symlinks, directories, and oversized files return null.
 */
export function readLearnedPlaybook(file) {
  try {
    const st = fs.lstatSync(file)
    if (st.isSymbolicLink() || !st.isFile()) return null
    if (st.size <= 0 || st.size > PLAYBOOK_MAX_BYTES) return null
    const src = fs.readFileSync(file, "utf8")
    const json = extractJsonObject(src)
    if (!json) return null
    const data = JSON.parse(json)
    if (!data || typeof data !== "object" || Array.isArray(data)) return null
    return data
  } catch {
    return null
  }
}

/**
 * Sync catalog of project-local learned plugins. No plugin-host, no import().
 * Skip dotfiles, symlinks, non-learned_*.mjs, reserved names, and the
 * global ~/.forge/tools dir. Cap 24. Caller can pass { limit }.
 */
export function indexLearnedPlugins(cwd = process.cwd(), opts = {}) {
  const dir = learnedPluginsDir(cwd)
  if (underDir(dir, PLUGINS_DIR) || path.resolve(PLUGINS_DIR) === path.resolve(dir)) return []
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const cap = Math.min(64, Math.max(0, Number(opts.limit) || INDEX_CAP))
  const out = []
  const seen = new Set()
  const sorted = entries.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))
  for (const e of sorted) {
    if (out.length >= cap) break
    const name = String(e.name || "")
    if (!name || name.startsWith(".")) continue
    if (!name.endsWith(".mjs")) continue
    const stem = name.slice(0, -4)
    if (!stem.startsWith("learned_")) continue
    if (!NAME_RE.test(stem) || FORBIDDEN_NAMES.has(stem)) continue
    const full = path.join(dir, name)
    let st
    try { st = fs.lstatSync(full) } catch { continue }
    if (st.isSymbolicLink() || !st.isFile()) continue
    const book = readLearnedPlaybook(full)
    if (!book) continue
    if (looksLikeKernel(book.task, book.repair, book.files)) continue
    const tool = NAME_RE.test(String(book.tool || "")) ? String(book.tool) : stem
    if (!NAME_RE.test(tool) || FORBIDDEN_NAMES.has(tool) || seen.has(tool)) continue
    seen.add(tool)
    const desc = String(book.description || book.task || "").slice(0, 200)
    const files = (Array.isArray(book.files) ? book.files : []).map(relFile).filter(Boolean).slice(0, 4)
    out.push({
      name: tool,
      description: desc,
      desc,
      isolated: true,
      readOnly: true,
      source: "learned",
      path: full,
      repair: String(book.repair || "").slice(0, 240),
      files,
      command: String(book.command || "").slice(0, 80),
    })
  }
  return out
}

/**
 * Render a learned PLAYBOOK as markdown so load_skill can return it
 * without spawning plugin-host. Never executes the file.
 */
export function formatPlaybookMd(book, name = "") {
  if (!book || typeof book !== "object") return null
  const title = String(name || book.tool || "playbook").slice(0, 40)
  const lines = [
    `# ${title}`,
    "",
    String(book.description || "").slice(0, 200),
    "",
    "## When",
    String(book.task || "").slice(0, 400) || "(unspecified)",
    "",
    "## What worked",
    String(book.repair || "").slice(0, 800) || "(unspecified)",
  ]
  const files = (Array.isArray(book.files) ? book.files : []).map(relFile).filter(Boolean).slice(0, 8)
  if (files.length) {
    lines.push("", "## Files")
    for (const f of files) lines.push(`- ${f}`)
  }
  if (book.command) {
    lines.push("", "## Verify", `Recommended (do not invent a toolchain): \`${String(book.command).slice(0, 80)}\``)
  }
  lines.push("", "Do not edit forge kernel files. Do not flip assumeYes.")
  return lines.join("\n") + "\n"
}

/**
 * load_skill fallback for a learned_* plugin name. Sync. No import(). No spawn.
 * Symlinks / kernel-looking playbooks / reserved names return null.
 */
export function readLearnedPlaybookByName(cwd, name) {
  const n = String(name || "").trim()
  if (!n.startsWith("learned_") || !NAME_RE.test(n) || FORBIDDEN_NAMES.has(n)) return null
  const file = path.join(learnedPluginsDir(cwd), `${n}.mjs`)
  const book = readLearnedPlaybook(file)
  if (!book) return null
  if (looksLikeKernel(book.task, book.repair, book.files)) return null
  return formatPlaybookMd(book, n)
}
