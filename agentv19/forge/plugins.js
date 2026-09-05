/**
 * forge — tool plugin API (v20.2, P3-5).
 *
 * Drop a `*.mjs` file in ~/.forge/tools/ and its exported tool(s) become
 * available to the agent, alongside the 17 built-ins and behind the SAME safety
 * choke point (output redaction; write-class plugins are serialized and blocked
 * in read-only sub-agents). Zero dependencies.
 *
 * A plugin module default-exports one tool object (or exports `tools: [...]`):
 *
 *   export default {
 *     name: "jira_issue",                       // ^[a-z][a-z0-9_]{1,40}$, unique, not a built-in
 *     description: "Fetch a Jira issue by key", // shown to the model
 *     parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
 *     readOnly: true,                           // optional; omit/false → treated as a WRITE tool
 *     async run(args, ctx) { return "..." }     // returns a string; ctx = { cwd, readOnly }
 *   }
 *
 * Loading is best-effort: a bad plugin is skipped with a recorded reason, never
 * crashing the agent. Plugins are the user's own code on their own machine —
 * forge runs them at the user's request, exactly like any local script.
 */
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { DEFAULT_DIR } from "./config.js"

export const PLUGINS_DIR = path.join(DEFAULT_DIR, "tools")

const NAME_RE = /^[a-z][a-z0-9_]{1,40}$/i

function validateTool(t, reserved, seen) {
  if (!t || typeof t !== "object") return "export is not a tool object"
  if (typeof t.name !== "string" || !NAME_RE.test(t.name)) return `invalid tool name ${JSON.stringify(t?.name)} (use ^[a-z][a-z0-9_]{1,40}$)`
  if (reserved.has(t.name)) return `name "${t.name}" collides with a built-in tool`
  if (seen.has(t.name)) return `duplicate tool name "${t.name}"`
  if (typeof t.description !== "string" || !t.description.trim()) return `tool "${t.name}" has no description`
  if (!t.parameters || typeof t.parameters !== "object" || t.parameters.type !== "object") {
    return `tool "${t.name}" parameters must be a JSON-schema object ({ type: "object", properties: {…} })`
  }
  if (typeof t.run !== "function") return `tool "${t.name}" run must be a function`
  return null
}

/**
 * Load tool plugins from `dir`. Returns { tools: [{name, readOnly, def, run, source}], errors: [str] }.
 * `reserved` is the set/array of built-in tool names a plugin may not shadow.
 */
export async function loadToolPlugins(dir = PLUGINS_DIR, { reserved = [] } = {}) {
  const result = { tools: [], errors: [] }
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => (f.endsWith(".mjs") || f.endsWith(".js")) && !f.startsWith("."))
  } catch {
    return result // no plugins dir — fine
  }
  const reservedSet = new Set(reserved)
  const seen = new Set()
  for (const f of files.sort()) {
    const full = path.join(dir, f)
    let mod
    try {
      mod = await import(pathToFileURL(full).href)
    } catch (e) {
      result.errors.push(`${f}: import failed — ${String(e?.message ?? e).slice(0, 160)}`)
      continue
    }
    const candidates = []
    if (mod.default) candidates.push(mod.default)
    if (Array.isArray(mod.tools)) candidates.push(...mod.tools)
    if (!candidates.length) {
      result.errors.push(`${f}: no default export (expected { name, description, parameters, run })`)
      continue
    }
    for (const t of candidates) {
      const err = validateTool(t, reservedSet, seen)
      if (err) { result.errors.push(`${f}: ${err}`); continue }
      seen.add(t.name)
      result.tools.push({
        name: t.name,
        readOnly: t.readOnly === true,
        def: { type: "function", function: { name: t.name, description: String(t.description).slice(0, 500), parameters: t.parameters } },
        run: t.run,
        source: f,
      })
    }
  }
  return result
}
