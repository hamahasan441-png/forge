#!/usr/bin/env node
import { MCP_CATALOG, catalogEntry, describeSpec, envInstructions, requiredEnvironment, runtimeAvailable, searchCatalog, specForEntry } from "../mcpcatalog.js"
import { resolveMcpEnvironment, resolveMcpHeaders } from "../mcp.js"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

console.log("== top-100 catalog integrity ==")
eq("exactly 100 entries", MCP_CATALOG.length, 100)
ok("catalog array is frozen", Object.isFrozen(MCP_CATALOG))
eq("short names unique", new Set(MCP_CATALOG.map((entry) => entry.name)).size, 100)
eq("registry names unique", new Set(MCP_CATALOG.map((entry) => entry.registryName)).size, 100)
const aliasOwners = new Map()
for (const entry of MCP_CATALOG) for (const alias of [entry.name, entry.registryName, ...(entry.aliases || [])]) {
  const key = alias.toLowerCase()
  if (!aliasOwners.has(key)) aliasOwners.set(key, new Set())
  aliasOwners.get(key).add(entry.name)
}
ok("aliases never resolve ambiguously", [...aliasOwners.values()].every((owners) => owners.size === 1))
ok("every homepage is a GitHub repository", MCP_CATALOG.every((entry) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/i.test(entry.homepage)), MCP_CATALOG.find((entry) => !/^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/i.test(entry.homepage))?.homepage)
ok("every entry is stdio or HTTPS Streamable HTTP", MCP_CATALOG.every((entry) => (entry.transport === "stdio" && entry.command && Array.isArray(entry.args)) || (entry.transport === "http" && /^https:\/\//.test(entry.url))))
ok("stdio package versions are pinned", MCP_CATALOG.filter((entry) => entry.transport === "stdio").every((entry) => !entry.args.some((arg) => /(?:@latest|:latest)$/i.test(arg))))

console.log("== explicit GitHub + ECC inclusions ==")
const github = catalogEntry("github")
const ecc = catalogEntry("ecc")
ok("official GitHub server is included", github?.homepage === "https://github.com/github/github-mcp-server")
eq("GitHub hosted URL", specForEntry(github).url, "https://api.githubcopilot.com/mcp/")
eq("GitHub canonical alias resolves", catalogEntry("github/github-mcp-server")?.name, "github")
eq("ECC registry alias resolves", catalogEntry("io.github.karljsamuel/mcp-ecc")?.name, "ecc")
eq("ECC short alias resolves", catalogEntry("mcp-ecc")?.name, "ecc")
ok("ECC package is pinned", specForEntry(ecc).args.includes("mcp-ecc@0.6.0"))
eq("ECC requires its encryption key", requiredEnvironment(ecc).map((item) => item.name), ["MCP_ENCRYPTION_KEY"])
ok("ECC config stores an env reference, not a credential", specForEntry(ecc).env.MCP_ENCRYPTION_KEY.env === "MCP_ENCRYPTION_KEY")

console.log("== discovery and filtering ==")
eq("bounded search", searchCatalog("", { limit: 7 }).length, 7)
eq("email/calendar search finds ECC first", searchCatalog("email calendar")[0]?.name, "ecc")
ok("transport filter is exact", searchCatalog("", { transport: "http" }).every((entry) => entry.transport === "http"))
ok("runtime filter is exact", searchCatalog("", { runtime: "python" }).every((entry) => entry.runtime === "python"))
ok("auth=required returns required environment entries", searchCatalog("", { auth: "required" }).every((entry) => requiredEnvironment(entry).some((item) => item.required)))
ok("auth=none excludes required environment entries", searchCatalog("", { auth: "none" }).every((entry) => !requiredEnvironment(entry).some((item) => item.required)))
ok("remote runtime needs no local binary", runtimeAvailable(github))
eq("describeSpec handles HTTP", describeSpec(specForEntry(github)), github.url)
ok("environment guidance never includes a value", envInstructions(ecc)[0].instruction === "set MCP_ENCRYPTION_KEY in the environment before running forge")

console.log("== environment-backed credential bindings ==")
eq("legacy literal stdio env remains compatible", resolveMcpEnvironment({ A: "literal" }, {}, "s"), { A: "literal" })
eq("stdio env reference resolves", resolveMcpEnvironment({ TOKEN: { env: "SOURCE", required: true } }, { SOURCE: "secret-value" }, "s"), { TOKEN: "secret-value" })
eq("HTTP header reference applies prefix", resolveMcpHeaders({ Authorization: { env: "TOKEN", prefix: "Bearer ", required: true } }, { TOKEN: "secret-value" }, "s"), { Authorization: "Bearer secret-value" })
eq("optional missing binding is omitted", resolveMcpHeaders({ Authorization: { env: "TOKEN" } }, {}, "s"), {})
let missing = null
try { resolveMcpHeaders({ Authorization: { env: "TOKEN", prefix: "Bearer ", required: true } }, {}, "github") } catch (error) { missing = error }
ok("required missing binding fails before network", /requires environment variable TOKEN/.test(missing?.message || ""))
ok("missing-binding error contains no credential value", !/secret-value/.test(missing?.message || ""))

console.log("== CLI discovery and opt-in install ==")
const forgeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mcp-catalog-"))
const cli = (...args) => execFileSync(process.execPath, [path.join(forgeDir, "forge.js"), ...args], { cwd: forgeDir, env: { ...process.env, FORGE_HOME: cliHome, NO_COLOR: "1" }, encoding: "utf8" })
const catalogJson = JSON.parse(cli("mcp", "catalog", "email", "calendar", "--json"))
eq("CLI search returns ECC", catalogJson.catalog.map((entry) => entry.name), ["ecc"])
const infoJson = JSON.parse(cli("mcp", "info", "mcp-ecc", "--json"))
eq("CLI info resolves aliases", infoJson.entry.name, "ecc")
ok("CLI info exposes an env reference, not a value", infoJson.spec.env.MCP_ENCRYPTION_KEY.env === "MCP_ENCRYPTION_KEY")
cli("mcp", "add", "ecc")
const saved = JSON.parse(fs.readFileSync(path.join(cliHome, "config.json"), "utf8"))
ok("CLI add writes only the selected server", Object.keys(saved.mcp.servers).length === 1 && saved.mcp.servers.ecc)
eq("saved ECC package remains pinned", saved.mcp.servers.ecc.args, ["-y", "mcp-ecc@0.6.0"])
ok("saved config contains no encryption key value", saved.mcp.servers.ecc.env.MCP_ENCRYPTION_KEY.env === "MCP_ENCRYPTION_KEY")

console.log(`\n== top-100 MCP catalog suite: ${PASS} passed, ${FAIL} failed ==`)
if (FAIL) process.exit(1)
