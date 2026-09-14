/**
 * mcpcatalog.js — v99 "loopwise" well-known MCP server catalog.
 *
 * v98 could USE configured MCP servers (stdio JSON-RPC client, lazy connect,
 * inventory cache) but adding one meant hand-writing config paths — there
 * was no catalog, no presets, nothing to discover. This module is a curated,
 * DATA-ONLY catalog of the best-known MCP servers (official reference
 * servers plus high-quality first-party ones). `forge mcp add <name>` writes
 * the preset into the USER config through the same setPath/saveConfig path
 * `forge config set` uses — the mcp section stays privileged (project
 * configs can never inject a server), secrets are never invented or
 * prompted for (a required env var becomes an explicit placeholder the user
 * fills), and nothing here EXECUTES anything: adding a server only writes
 * configuration. Lazy connect (v96) means an added server costs nothing
 * until an agent actually calls one of its tools.
 *
 * House rules: zero dependencies, pure data + config write, no network
 * access at catalog time, honest "unknown server" errors.
 */

import { execFileSync } from "node:child_process"

function hasBinary(bin) {
  try { execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 5000 }); return true } catch { return false }
}

/**
 * Catalog entries. `env` maps required variable names to what they are for —
 * values are descriptions, never secrets. `args` may contain placeholders
 * the add command resolves (or the user edits afterwards).
 */
export const MCP_CATALOG = Object.freeze([
  {
    name: "filesystem", category: "files", runtime: "node",
    desc: "read/write files scoped to allowed directories",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    env: {}, note: 'the trailing "." is the allowed directory — edit mcp.servers.filesystem.args to scope it',
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    name: "memory", category: "knowledge", runtime: "node",
    desc: "persistent knowledge-graph memory across sessions",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"],
    env: {}, note: "stores its graph in a JSON file in the server's working dir",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
  },
  {
    name: "sequential-thinking", category: "reasoning", runtime: "node",
    desc: "structured step-by-step problem solving with revision",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    env: {}, note: "no configuration needed",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
  },
  {
    name: "git", category: "dev", runtime: "node",
    desc: "git operations (status, diff, log, branches) on a repository",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-git", "--repository", "."],
    env: {}, note: 'the "." after --repository is the repo path — edit to point elsewhere',
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
  },
  {
    name: "sqlite", category: "data", runtime: "node",
    desc: "SQL queries and schema inspection for a SQLite database",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-sqlite", "--db-path", "app.db"],
    env: {}, note: "edit --db-path to your database file",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite",
  },
  {
    name: "postgres", category: "data", runtime: "node",
    desc: "read-only SQL access to a PostgreSQL database",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost:5432/mydb"],
    env: {}, note: "replace the connection string argument with yours (reads are schema + SELECT-oriented)",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
  },
  {
    name: "playwright", category: "browser", runtime: "node",
    desc: "browser automation and web testing (official Playwright MCP)",
    command: "npx", args: ["-y", "@playwright/mcp@latest"],
    env: {}, note: "downloads browsers on first use; headless by default",
    homepage: "https://github.com/microsoft/playwright-mcp",
  },
  {
    name: "puppeteer", category: "browser", runtime: "node",
    desc: "browser automation, screenshots and web scraping via Puppeteer",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    env: {}, note: "downloads Chromium on first use",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
  },
  {
    name: "brave-search", category: "web", runtime: "node",
    desc: "web and local search via the Brave Search API",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"],
    env: { BRAVE_API_KEY: "Brave Search API key (free tier available)" },
    note: "requires a Brave Search API key",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
  },
  {
    name: "github", category: "dev", runtime: "node",
    desc: "GitHub API — repos, issues, PRs, code search",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "GitHub personal access token (repo scope as needed)" },
    note: "requires a GitHub personal access token; the reference server is archived but functional — GitHub's own Go server ships via Docker",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
  },
  {
    name: "context7", category: "docs", runtime: "node",
    desc: "up-to-date, version-accurate documentation for libraries and frameworks",
    command: "npx", args: ["-y", "@upstash/context7-mcp"],
    env: {}, note: "no configuration needed; great for current API docs",
    homepage: "https://github.com/upstash/context7",
  },
  {
    name: "fetch", category: "web", runtime: "uvx",
    desc: "fetch and process web content as markdown (reference server, Python)",
    command: "uvx", args: ["mcp-server-fetch"],
    env: {}, note: "requires uv (astral.sh/uv) installed on PATH",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },
])

/** Case-insensitive catalog lookup by preset name. */
export function catalogEntry(name) {
  const n = String(name ?? "").trim().toLowerCase()
  if (!n) return null
  return MCP_CATALOG.find((e) => e.name === n) ?? null
}

/** True when the entry's runtime launcher is available on PATH (cheap probe). */
export function runtimeAvailable(entry) {
  if (!entry) return false
  return hasBinary(entry.runtime === "uvx" ? "uvx" : "npx")
}

/**
 * Build the config spec for a catalog entry. Secrets are NEVER invented: a
 * required env var becomes an empty-string placeholder the user fills via
 * `forge config set mcp.servers.<name>.env.<VAR> <value>` (or deletes).
 */
export function specForEntry(entry, { args = null } = {}) {
  if (!entry) return null
  const spec = { command: entry.command, args: args && args.length ? args : [...entry.args] }
  const envVars = Object.keys(entry.env ?? {})
  if (envVars.length) {
    spec.env = {}
    for (const k of envVars) spec.env[k] = ""
  }
  return spec
}

/** Human-readable env instructions for an added entry. */
export function envInstructions(entry, name) {
  const vars = Object.keys(entry?.env ?? {})
  if (!vars.length) return []
  return vars.map((v) => `forge config set mcp.servers.${name}.env.${v} <${v}>`)
}
