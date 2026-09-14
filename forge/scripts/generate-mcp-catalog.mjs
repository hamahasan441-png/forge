#!/usr/bin/env node
/**
 * Generate the vendored MCP catalog from the official MCP Registry plus
 * GitHub repository health signals. This is a maintainer tool: normal forge
 * commands never contact either service just to browse the catalog.
 *
 * Usage: GITHUB_TOKEN=... node scripts/generate-mcp-catalog.mjs
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REGISTRY = "https://registry.modelcontextprotocol.io"
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "mcpcatalog.generated.js")
const LIMIT = 100
const REQUIRED = new Map([
  ["github/github-mcp-server", "github"],
  ["karljsamuel/mcp-ecc", "ecc"],
])
const MANUAL = [{
  server: {
    name: "github/github-mcp-server",
    title: "GitHub MCP Server",
    description: "GitHub's official MCP server for repositories, issues, pull requests, Actions, code security, and collaboration.",
    version: "hosted",
    repository: { source: "github", url: "https://github.com/github/github-mcp-server" },
  },
  repo: "github/github-mcp-server",
  install: {
    runtime: "remote",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    env: {},
    headers: {
      Authorization: { env: "GITHUB_PERSONAL_ACCESS_TOKEN", prefix: "Bearer ", required: true, secret: true },
    },
  },
}, {
  server: {
    name: "io.github.karljsamuel/mcp-ecc",
    title: "MCP ECC",
    description: "Unified MCP server for email, calendars, and contacts across Google, Microsoft 365, Zoho, IMAP/SMTP, CalDAV, and CardDAV.",
    version: "0.6.0",
    repository: { source: "github", url: "https://github.com/karljsamuel/mcp-ecc" },
  },
  repo: "karljsamuel/mcp-ecc",
  install: {
    runtime: "node",
    transport: "stdio",
    command: "npx",
    args: ["-y", "mcp-ecc@0.6.0"],
    env: {
      MCP_ENCRYPTION_KEY: {
        description: "Master key used to encrypt stored credentials (generate a dedicated 32-byte random value)",
        required: true,
        secret: true,
      },
    },
  },
}]

async function json(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { accept: "application/json", "user-agent": "forge-mcp-catalog-generator", ...(options.headers || {}) },
  })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.json()
}

function githubRepo(repository) {
  if (repository?.source !== "github" || !repository.url) return null
  try {
    const u = new URL(repository.url)
    if (u.hostname.toLowerCase() !== "github.com") return null
    const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/")
    if (parts.length < 2) return null
    const repo = `${parts[0]}/${parts[1].replace(/\.git$/i, "")}`
    // The registry repository is metadata infrastructure, never the source of
    // a third-party server. Some records incorrectly point at it and would
    // otherwise inherit its stars.
    if (repo.toLowerCase() === "modelcontextprotocol/registry") return null
    return repo
  } catch { return null }
}

function valueOf(arg) {
  if (!arg || typeof arg !== "object") return null
  if (Object.hasOwn(arg, "value")) return String(arg.value)
  if (Object.hasOwn(arg, "default")) return String(arg.default)
  return null
}

function argsFor(list = []) {
  const out = []
  for (const arg of list) {
    const value = valueOf(arg)
    if (arg?.type === "named") {
      if (!arg.name) return null
      if (value == null && arg.isRequired) return null
      if (value != null) out.push(String(arg.name), value)
    } else if (arg?.type === "positional") {
      if (value == null && arg.isRequired) return null
      if (value != null) out.push(value)
    }
  }
  return out
}

function envFor(list = []) {
  const out = {}
  for (const item of list) {
    if (!item?.name) continue
    out[item.name] = {
      description: String(item.description || `${item.name} required by this MCP server`).slice(0, 240),
      required: item.isRequired === true,
      secret: item.isSecret === true,
    }
  }
  return out
}

function packageInstall(pkg) {
  if (!pkg || pkg.transport?.type !== "stdio") return null
  const runtimeArgs = argsFor(pkg.runtimeArguments)
  const packageArgs = argsFor(pkg.packageArguments)
  if (!runtimeArgs || !packageArgs) return null
  const env = envFor(pkg.environmentVariables)
  if (pkg.registryType === "npm" && pkg.identifier && pkg.version) {
    return { runtime: "node", transport: "stdio", command: "npx", args: [...runtimeArgs, "-y", `${pkg.identifier}@${pkg.version}`, ...packageArgs], env }
  }
  if (pkg.registryType === "pypi" && pkg.identifier && pkg.version) {
    return { runtime: "python", transport: "stdio", command: "uvx", args: [...runtimeArgs, `${pkg.identifier}==${pkg.version}`, ...packageArgs], env }
  }
  if (pkg.registryType === "oci" && pkg.identifier) {
    const passEnv = Object.keys(env).flatMap((name) => ["-e", name])
    return { runtime: "docker", transport: "stdio", command: "docker", args: ["run", "-i", "--rm", ...passEnv, ...runtimeArgs, pkg.identifier, ...packageArgs], env }
  }
  return null
}

function remoteInstall(remote) {
  if (!remote || remote.type !== "streamable-http" || !/^https:\/\//i.test(remote.url || "")) return null
  // Header/URL variable expansion is intentionally not guessed. A catalog
  // entry is installable only when its published remote is complete as-is.
  if ((remote.headers?.length || 0) > 0 || (remote.variables?.length || 0) > 0 || /\{[^}]+\}/.test(remote.url)) return null
  return { runtime: "remote", transport: "http", url: remote.url, env: {} }
}

function installFor(server) {
  for (const pkg of server.packages || []) {
    const install = packageInstall(pkg)
    if (install) return install
  }
  for (const remote of server.remotes || []) {
    const install = remoteInstall(remote)
    if (install) return install
  }
  return null
}

function categoryFor(server) {
  const text = `${server.name} ${server.title || ""} ${server.description || ""}`.toLowerCase()
  const groups = [
    ["browser", /browser|playwright|puppeteer|chrome|web automation/],
    ["data", /database|postgres|mysql|sqlite|redis|sql|warehouse|analytics/],
    ["communication", /email|calendar|contact|slack|discord|teams|message/],
    ["dev", /github|gitlab|repository|code|developer|ci\/cd|issue|pull request/],
    ["cloud", /aws|azure|google cloud|kubernetes|docker|vercel|cloudflare/],
    ["docs", /documentation|docs|knowledge base|notion|confluence/],
    ["search", /search|crawl|scrap|fetch|web content/],
    ["observability", /monitor|observability|sentry|log|incident|metric/],
    ["productivity", /project|task|linear|jira|workflow|productivity/],
    ["finance", /payment|stripe|finance|market|trading|crypto/],
    ["media", /image|video|audio|design|figma/],
  ]
  return groups.find(([, pattern]) => pattern.test(text))?.[0] || "other"
}

function slugFor(server, repo) {
  if (REQUIRED.has(repo.toLowerCase())) return REQUIRED.get(repo.toLowerCase())
  const tail = String(server.name || "").split("/").pop()
  return tail.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "mcp-server"
}

function score(repo, install, server) {
  const pushed = Date.parse(repo.pushedAt || "")
  const ageDays = Number.isFinite(pushed) ? Math.max(0, (Date.now() - pushed) / 86400000) : 3650
  const popularity = Math.log10((repo.stargazerCount || 0) + 1) * 24 + Math.log10((repo.forkCount || 0) + 1) * 8
  const maintenance = Math.max(0, 28 * (1 - ageDays / 730))
  const release = repo.latestRelease ? 6 : 0
  const trust = (repo.licenseInfo?.spdxId ? 5 : 0) + (repo.hasVulnerabilityAlertsEnabled ? 3 : 0)
  const installable = install.transport === "http" ? 8 : 6
  const docs = server.description && server.description.length >= 40 ? 3 : 0
  return Number((popularity + maintenance + release + trust + installable + docs).toFixed(3))
}

async function registryServers() {
  const rows = []
  let cursor = ""
  for (let page = 0; page < 100; page++) {
    const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
    const data = await json(`${REGISTRY}/v0.1/servers?limit=100${suffix}`)
    rows.push(...(data.servers || []))
    cursor = data.metadata?.nextCursor || ""
    if (!cursor) break
  }
  return rows
}

async function githubMetadata(repos) {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error("GITHUB_TOKEN is required to rank catalog repositories")
  const result = new Map()
  for (let start = 0; start < repos.length; start += 40) {
    const batch = repos.slice(start, start + 40)
    const fields = batch.map((full, i) => {
      const [owner, name] = full.split("/")
      return `r${i}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}) { nameWithOwner stargazerCount forkCount isArchived pushedAt hasVulnerabilityAlertsEnabled licenseInfo { spdxId } latestRelease { publishedAt } }`
    }).join("\n")
    const data = await json("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `bearer ${token}` },
      body: JSON.stringify({ query: `query CatalogRepos { ${fields} }` }),
    })
    // Deleted/renamed repositories produce a partial GraphQL response. Keep
    // every repository GitHub did resolve and let the missing one fall out of
    // eligibility instead of aborting the whole refresh.
    batch.forEach((full, i) => { if (data.data?.[`r${i}`]) result.set(full.toLowerCase(), data.data[`r${i}`]) })
  }
  return result
}

function render(entries, sourceCount) {
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
  return `/**\n * Generated MCP catalog. DO NOT EDIT BY HAND.\n * Source: official MCP Registry + GitHub repository metadata.\n * Generated: ${stamp}; eligible candidates: ${sourceCount}; selected: ${entries.length}.\n * Refresh: GITHUB_TOKEN=... node scripts/generate-mcp-catalog.mjs\n */\nexport const GENERATED_MCP_CATALOG = Object.freeze(${JSON.stringify(entries, null, 2)})\n`
}

async function main() {
  const records = await registryServers()
  const candidates = []
  for (const record of records) {
    const meta = record?._meta?.["io.modelcontextprotocol.registry/official"] || {}
    const server = record?.server
    if (!server || meta.status !== "active" || meta.isLatest !== true) continue
    const repo = githubRepo(server.repository)
    const install = installFor(server)
    if (!repo || !install) continue
    candidates.push({ server, repo, install })
  }
  for (const manual of MANUAL) {
    const i = candidates.findIndex((candidate) => candidate.repo.toLowerCase() === manual.repo.toLowerCase())
    if (i === -1) candidates.push(manual)
    else if (REQUIRED.has(manual.repo.toLowerCase())) candidates[i] = manual
  }

  const repos = [...new Set(candidates.map((c) => c.repo))]
  const gh = await githubMetadata(repos)
  const ranked = candidates.flatMap((candidate) => {
    const repoMeta = gh.get(candidate.repo.toLowerCase())
    if (!repoMeta || repoMeta.isArchived) return []
    const aliases = [candidate.server.name, candidate.repo]
    const forced = REQUIRED.get(candidate.repo.toLowerCase())
    if (forced === "ecc") aliases.push("mcp-ecc")
    return [{
      name: slugFor(candidate.server, candidate.repo),
      aliases,
      registryName: candidate.server.name,
      category: categoryFor(candidate.server),
      desc: String(candidate.server.description || candidate.server.title || candidate.server.name).slice(0, 300),
      homepage: candidate.server.repository.url,
      version: candidate.server.version,
      stars: repoMeta.stargazerCount || 0,
      score: score(repoMeta, candidate.install, candidate.server),
      ...candidate.install,
    }]
  }).sort((a, b) => b.score - a.score || b.stars - a.stars || a.registryName.localeCompare(b.registryName))

  const selected = []
  const names = new Set()
  const perRepo = new Map()
  const add = (entry) => {
    if (!entry || names.has(entry.registryName)) return
    const repo = entry.aliases[1].toLowerCase()
    if ((perRepo.get(repo) || 0) >= 3) return
    let name = entry.name
    if (selected.some((e) => e.name === name)) name = `${name}-${repo.split("/")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
    selected.push({ ...entry, name })
    names.add(entry.registryName)
    perRepo.set(repo, (perRepo.get(repo) || 0) + 1)
  }
  for (const [repo] of REQUIRED) add(ranked.find((e) => e.aliases[1].toLowerCase() === repo))
  for (const entry of ranked) {
    if (selected.length >= LIMIT) break
    add(entry)
  }
  if (selected.length !== LIMIT) throw new Error(`only ${selected.length} eligible entries; expected ${LIMIT}`)
  for (const repo of REQUIRED.keys()) {
    if (!selected.some((e) => e.aliases[1].toLowerCase() === repo)) throw new Error(`required catalog entry missing: ${repo}`)
  }
  const aliasOwners = new Map()
  for (const entry of selected) {
    for (const alias of new Set(entry.aliases || [])) {
      const key = alias.toLowerCase()
      if (!aliasOwners.has(key)) aliasOwners.set(key, new Set())
      aliasOwners.get(key).add(entry.name)
    }
  }
  for (const entry of selected) {
    entry.aliases = [...new Set(entry.aliases || [])].filter((alias) => aliasOwners.get(alias.toLowerCase())?.size === 1)
  }
  fs.writeFileSync(OUT, render(selected, ranked.length))
  process.stdout.write(`wrote ${selected.length} MCP entries to ${OUT}\n`)
}

await main()
