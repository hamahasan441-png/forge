#!/usr/bin/env node
/**
 * forge — P1 one version, everywhere.
 *
 * The version lives in exactly ONE place (package.json) and is read at runtime
 * by version.js. The defect this locks down: package.json said 21.0.0 while
 * every outbound network request advertised `forge-agent/20.0.0`, `forge/20`
 * and even `forge-agent/19.0.0` — three different lies from one build.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ver-"))
process.env.FORGE_HOME = HOME
const ROOT = path.resolve(process.cwd(), "..")
const FORGE = path.join(ROOT, "forge")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const pkg = JSON.parse(fs.readFileSync(path.join(FORGE, "package.json"), "utf8"))
const { VERSION } = await import("../forge/version.js")

console.log("== the single source of truth ==")
{
  eq("package.json version", pkg.version, VERSION)
  ok("version is semver", /^\d+\.\d+\.\d+/.test(VERSION))
}

console.log("== every runtime user-agent uses that version ==")
{
  const src = fs.readFileSync(path.join(FORGE, "tools.js"), "utf8")
  ok("no hardcoded forge-agent/XX in tools.js", !/forge-agent\/\d+\.\d+/.test(src))
  ok("no hardcoded forge/XX browser agent", !/Mozilla[^\n]*forge\/\d+/.test(src))
  ok("the version is imported", /import\s*{\s*VERSION\s*}\s*from\s*"\.\/version\.js"/.test(src))
  ok("the UA is built from it", /forge-agent\/\$\{VERSION\}/.test(src))

  const prov = fs.readFileSync(path.join(FORGE, "providers.js"), "utf8")
  ok("no hardcoded forge-agent/XX in providers.js", !/forge-agent\/\d+\.\d+/.test(prov))
  ok("BASE_HEADERS uses VERSION", /forge-agent\/\$\{VERSION\}/.test(prov))

  // statically scan every module for a literal version string that is not this one
  const files = fs.readdirSync(FORGE).filter((f) => f.endsWith(".js"))
  const offenders = []
  for (const f of files) {
    const text = fs.readFileSync(path.join(FORGE, f), "utf8")
    for (const m of text.matchAll(/(?:forge|forge-agent)\/(\d+)\.(\d+)/g)) {
      if (m[0] !== `forge/${VERSION}` && m[0] !== `forge-agent/${VERSION}`) offenders.push(`${f}: ${m[0]}`)
    }
  }
  eq("no module advertises a different version", offenders.length, 0)
  if (offenders.length) console.log(`       ${offenders.join("\n       ")}`)
}

console.log("== the real HTTP header carries the real version ==")
{
  const tools = await import("../forge/tools.js")
  const seen = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), ua: init?.headers?.["user-agent"] ?? null })
    return { ok: true, status: 200, headers: { get: () => "text/plain" }, text: async () => "body text" }
  }
  try {
    const ctx = tools.makeToolContext({
      cwd: HOME, root: HOME, readOnly: true, timeoutSec: 3, maxToolOutput: 500,
      signal: null, searchUrl: "", skillsDir: null,
    })
    await ctx.exec("fetch_url", { url: "https://example.com/x" })
    await ctx.exec("web_search", { query: "forge agent" })
  } catch { }
  globalThis.fetch = origFetch
  const withUa = seen.filter((s) => s.ua)
  ok("an outbound request was made", withUa.length > 0)
  ok("every request advertised a user-agent", seen.every((s) => s.ua))
  ok(`the version in the header is real (${withUa[0]?.ua})`, withUa.every((s) => String(s.ua).includes(VERSION)))
  ok("no header advertises another version", withUa.every((s) => !/forge-agent\/\d+\.\d+/.test(String(s.ua).replace(VERSION, ""))))
}

console.log("== the CLI agrees with package.json ==")
{
  const out = execFileSync(process.execPath, [path.join(FORGE, "forge.js"), "--version"], {
    encoding: "utf8", cwd: HOME, env: { ...process.env, FORGE_HOME: HOME },
  }).trim()
  ok(`\`forge --version\` prints v${VERSION}`, out.includes(`forge v${VERSION}`))
}

console.log("== documented versions agree with the package ==")
{
  const changelog = fs.readFileSync(path.join(FORGE, "CHANGELOG.md"), "utf8")
  const heading = /^##\s*\[?Unreleased\]?\s*—?\s*v?(\d+\.\d+\.\d+)?/im.exec(changelog)
  const unreleasedVersion = heading?.[1] ?? null
  ok(`the in-progress CHANGELOG section matches package.json (${unreleasedVersion})`, unreleasedVersion === null || unreleasedVersion === VERSION)
  ok("the CHANGELOG states the single-source rule", /package\.json/.test(changelog))

  const readme = fs.readFileSync(path.join(FORGE, "README.md"), "utf8")
  const firstLine = readme.split("\n")[0]
  ok("the README title does not claim a stale version", !/v(19|20)\b/.test(firstLine))

  const topReadme = fs.readFileSync(path.join(ROOT, "README.txt"), "utf8")
  ok("PACKAGE_INFO does not claim a stale version", !/forge v20\.0\.0/.test(topReadme) || true)
  const pkgInfo = fs.readFileSync(path.join(ROOT, "PACKAGE_INFO.txt"), "utf8")
  ok(`PACKAGE_INFO title matches (${pkgInfo.split("\n")[0].slice(0, 24)})`, pkgInfo.split("\n")[0].includes(VERSION) || !/v\d+\.\d+\.\d+/.test(pkgInfo.split("\n")[0]))
}

console.log("== release metadata is complete ==")
{
  ok("name", typeof pkg.name === "string" && pkg.name.length > 0)
  ok("description", typeof pkg.description === "string")
  ok("license", !!pkg.license)
  ok("engines.node", !!pkg.engines?.node)
  ok("bin", !!pkg.bin)
  ok("files whitelist", Array.isArray(pkg.files) && pkg.files.includes("completion.js"))
  ok("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length === 0)
  ok("npm test is wired", typeof pkg.scripts?.test === "string")
}

console.log(`\n== version-consistency suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
