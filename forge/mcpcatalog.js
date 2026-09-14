/**
 * mcpcatalog.js — curated top-100 MCP catalog.
 *
 * The data is generated from active official MCP Registry records and GitHub
 * repository health metadata, then vendored with the package. Browsing the
 * catalog is therefore deterministic and offline. Installing remains an
 * explicit, one-server-at-a-time user action; nothing in this module connects
 * to or executes a server.
 */
import { execFileSync } from "node:child_process"
import { GENERATED_MCP_CATALOG } from "./mcpcatalog.generated.js"

export const MCP_CATALOG = GENERATED_MCP_CATALOG

function hasBinary(bin) {
  try { execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 5000 }); return true } catch { return false }
}

function normalized(value) {
  return String(value ?? "").trim().toLowerCase()
}

/** Case-insensitive lookup by short name, canonical registry name, or alias. */
export function catalogEntry(name) {
  const wanted = normalized(name)
  if (!wanted) return null
  return MCP_CATALOG.find((entry) => {
    if (normalized(entry.name) === wanted || normalized(entry.registryName) === wanted) return true
    return (entry.aliases || []).some((alias) => normalized(alias) === wanted)
  }) ?? null
}

/** True when the launcher is available. Hosted HTTPS entries need no binary. */
export function runtimeAvailable(entry) {
  if (!entry) return false
  if (entry.transport === "http" && /^https:\/\//i.test(entry.url || "")) return true
  return typeof entry.command === "string" && entry.command.length > 0 && hasBinary(entry.command)
}

/** Environment names referenced by either stdio env or HTTP header bindings. */
export function requiredEnvironment(entry) {
  if (!entry) return []
  const found = new Map()
  for (const [name, meta] of Object.entries(entry.env || {})) {
    found.set(name, { name, description: typeof meta === "string" ? meta : meta?.description || "", required: typeof meta === "object" ? meta.required === true : true, secret: typeof meta === "object" ? meta.secret === true : true })
  }
  for (const binding of Object.values(entry.headers || {})) {
    if (!binding?.env) continue
    found.set(binding.env, { name: binding.env, description: `credential used by an HTTP header for ${entry.name}`, required: binding.required !== false, secret: binding.secret !== false })
  }
  return [...found.values()]
}

/**
 * Build a user config spec. Credentials are references to process environment
 * variables, never empty placeholders or invented/stored secret values.
 */
export function specForEntry(entry, { args = null } = {}) {
  if (!entry) return null
  const spec = entry.transport === "http"
    ? { url: entry.url }
    : { command: entry.command, args: args && args.length ? [...args] : [...(entry.args || [])] }
  if (Object.keys(entry.env || {}).length) {
    spec.env = {}
    for (const [name, meta] of Object.entries(entry.env)) {
      spec.env[name] = { env: name, required: typeof meta === "object" ? meta.required === true : true }
    }
  }
  if (Object.keys(entry.headers || {}).length) {
    spec.headers = {}
    for (const [name, binding] of Object.entries(entry.headers)) spec.headers[name] = { ...binding }
  }
  return spec
}

/** Shell-neutral guidance: users choose how to supply each environment value. */
export function envInstructions(entry) {
  return requiredEnvironment(entry).map(({ name, description, required }) => ({ name, description, required, instruction: `set ${name} in the environment before running forge` }))
}

/** Bounded, deterministic catalog search used by the CLI and tests. */
export function searchCatalog(query = "", opts = {}) {
  const words = normalized(query).split(/[^a-z0-9]+/).filter(Boolean)
  const category = normalized(opts.category)
  const runtime = normalized(opts.runtime)
  const transport = normalized(opts.transport)
  const auth = normalized(opts.auth)
  const scored = []
  for (const entry of MCP_CATALOG) {
    if (category && normalized(entry.category) !== category) continue
    if (runtime && normalized(entry.runtime) !== runtime) continue
    if (transport && normalized(entry.transport) !== transport) continue
    const needsAuth = requiredEnvironment(entry).some((item) => item.required)
    if (auth === "required" && !needsAuth) continue
    if ((auth === "none" || auth === "free") && needsAuth) continue
    const text = normalized([entry.name, entry.registryName, ...(entry.aliases || []), entry.desc, entry.category].join(" "))
    if (words.some((word) => !text.includes(word))) continue
    const relevance = words.reduce((sum, word) => sum + (normalized(entry.name).includes(word) ? 5 : 1), 0)
    scored.push({ entry, relevance })
  }
  scored.sort((a, b) => b.relevance - a.relevance || b.entry.score - a.entry.score || a.entry.name.localeCompare(b.entry.name))
  const limit = opts.limit == null ? MCP_CATALOG.length : Math.max(0, Number(opts.limit) || 0)
  return scored.slice(0, limit).map(({ entry }) => entry)
}

/** Safe human representation: names environment variables, never their values. */
export function describeSpec(spec = {}) {
  if (spec.url) return spec.url
  return [spec.command, ...(spec.args || [])].filter(Boolean).join(" ")
}
