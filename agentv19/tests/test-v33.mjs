#!/usr/bin/env node
/**
 * forge — v33 cross-language graph.
 *
 * UNIFIED §7: source → contract → consumer → test → deploy, from the v32
 * index (no extra full scan of unchanged files). §19: tests along those
 * edges; skip unchanged greens only with a ledger.
 *
 * Does not: flip assumeYes, add a runtime dep, spawn a second writer,
 * change classifyTaskComplexity(), or skip tests without a ledger.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v33-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v33-work-"))
process.chdir(WORK)

const {
  extractContracts, linkRecords, testsForFiles, consumersOf,
  skipUnchangedTests, formatCrossGraph, normRoute, XEDGE,
} = await import("../forge/xlang.js")
const { buildCrossGraph, buildRepoMap, getIndexStats } = await import("../forge/repomap.js")
const { impactRadius } = await import("../forge/impact.js")
const { createContextEngine } = await import("../forge/context.js")
const { defaultConfig, sanitizeProjectConfig } = await import("../forge/config.js")
const { classifyTaskComplexity } = await import("../forge/classify.js")
const { VERSION } = await import("../forge/version.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

console.log("== extractContracts ==")
{
  const js = extractContracts("api.ts", `app.get("/api/users", handler)\napp.post("/api/users/:id", u)\n`)
  ok("js produce /api/users", js.some((c) => c.kind === "route" && c.name === "/api/users" && c.role === "produce"))
  ok(":id normalizes", js.some((c) => c.kind === "route" && c.name === "/api/users/:param"))
  const py = extractContracts("app.py", `@app.get("/api/users")\ndef list_users():\n    return []\n`)
  ok("py produce /api/users", py.some((c) => c.kind === "route" && c.name === "/api/users"))
  const fetch = extractContracts("client.ts", `const r = fetch("/api/users")\n`)
  ok("fetch consumes route", fetch.some((c) => c.kind === "route" && c.name === "/api/users" && c.role === "consume"))
  const sql = extractContracts("init.sql", `CREATE TABLE users (id int);\nSELECT * FROM users;\n`)
  ok("sql produce users", sql.some((c) => c.kind === "table" && c.name === "users" && c.role === "produce"))
  ok("sql consume users", sql.some((c) => c.kind === "table" && c.role === "consume"))
  const proto = extractContracts("u.proto", `service UserService {\n  rpc GetUser (Req) returns (User);\n}\nmessage User {}\n`)
  ok("proto service", proto.some((c) => c.kind === "proto" && c.name === "UserService"))
  ok("proto message", proto.some((c) => c.kind === "proto" && c.name === "User"))
  const oas = extractContracts("openapi.yaml", `openapi: 3.0.0\npaths:\n  /api/users:\n    get: {}\n`)
  ok("openapi path", oas.some((c) => c.kind === "route" && c.name === "/api/users"))
  const compose = extractContracts("docker-compose.yml", `services:\n  api:\n    image: backend:1\n`)
  ok("compose service", compose.some((c) => c.kind === "service" && c.name === "api"))
  ok("compose image", compose.some((c) => c.kind === "image" && c.name === "backend"))
  const ci = extractContracts(".github/workflows/ci.yml", `jobs:\n  test:\n    runs-on: ubuntu-latest\n`)
  ok("ci job", ci.some((c) => c.kind === "job" && c.name === "test"))
  eq("norm {id} == :id", normRoute("/users/{id}"), normRoute("/users/:id"))
  ok("empty src is empty", extractContracts("a.js", "").length === 0)
}

console.log("== linkRecords: IMPLEMENTS / CONSUMES / TEST ==")
{
  const recs = [
    { rel: "api.ts", lang: "typescript", symbols: ["listUsers"], imports: [], test: false, config: false,
      contracts: extractContracts("api.ts", `app.get("/api/users", h)\n`) },
    { rel: "app.py", lang: "python", symbols: ["list_users"], imports: [], test: false, config: false,
      contracts: extractContracts("app.py", `@app.get("/api/users")\ndef list_users():\n    return db.query("SELECT * FROM users")\n`) },
    { rel: "schema.sql", lang: "sql", symbols: ["users"], imports: [], test: false, config: false,
      contracts: extractContracts("schema.sql", `CREATE TABLE users (id int);\n`) },
    { rel: "web.ts", lang: "typescript", symbols: [], imports: ["./api.ts"], test: false, config: false,
      contracts: extractContracts("web.ts", `fetch("/api/users")\n`) },
    { rel: "api.test.ts", lang: "typescript", symbols: [], imports: ["./api.ts"], test: true, config: false, contracts: [] },
    { rel: "docker-compose.yml", lang: "unknown", symbols: [], imports: [], test: false, config: true,
      contracts: extractContracts("docker-compose.yml", `services:\n  api:\n    image: backend\n`) },
  ]
  const g = linkRecords(recs)
  ok("IMPLEMENTS ts ↔ py", g.edges.some((e) => e.kind === XEDGE.IMPLEMENTS && ((e.from === "api.ts" && e.to === "app.py") || (e.from === "app.py" && e.to === "api.ts"))))
  ok("CONSUMES web → api", g.edges.some((e) => e.kind === XEDGE.CONSUMES && e.from === "web.ts" && e.to === "api.ts"))
  ok("TEST api.test → api", g.edges.some((e) => e.kind === XEDGE.TEST && e.from === "api.test.ts" && e.to === "api.ts"))
  ok("DEPLOY compose", g.edges.some((e) => e.kind === XEDGE.DEPLOY))
  ok("table contract on sql", recs[2].contracts.some((c) => c.kind === "table"))
  ok("py consumes users table", recs[1].contracts.some((c) => c.kind === "table" && c.name === "users"))
  const tests = testsForFiles(["api.ts"], g)
  ok("testsForFiles finds api.test.ts", tests.includes("api.test.ts"))
  const cons = consumersOf(["api.ts"], g)
  ok("consumersOf finds web.ts", cons.includes("web.ts"))
  const txt = formatCrossGraph(g)
  ok("format mentions api.ts", /api\.ts/.test(txt))
  ok("format header", /CROSS GRAPH/.test(txt))
}

console.log("== skipUnchangedTests never fakes a green ==")
{
  const tests = ["a.test.js"]
  const none = skipUnchangedTests(tests)
  eq("no ledger skip empty", none.skip.length, 0)
  eq("no ledger run all", none.run[0], "a.test.js")
  const recs = [{ rel: "a.test.js", size: 10, mtime: 5, imports: [] }]
  const hit = skipUnchangedTests(tests, { records: recs, ledger: { "a.test.js": { size: 10, mtime: 5 } } })
  ok("matching ledger skips", hit.skip.includes("a.test.js") && hit.run.length === 0)
  const miss = skipUnchangedTests(tests, { records: recs, ledger: { "a.test.js": { size: 11, mtime: 5 } } })
  ok("stale ledger runs", miss.run.includes("a.test.js") && miss.skip.length === 0)
}

console.log("== buildCrossGraph uses the index; impact finds importers ==")
{
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v33-tree-"))
  fs.mkdirSync(path.join(tree, "src"))
  fs.mkdirSync(path.join(tree, "tests"))
  fs.writeFileSync(path.join(tree, "src", "api.ts"), `export function listUsers(){}\napp.get("/api/users", listUsers)\n`)
  fs.writeFileSync(path.join(tree, "src", "app.py"), `@app.get("/api/users")\ndef list_users():\n    return []\n`)
  fs.writeFileSync(path.join(tree, "src", "web.ts"), `import { listUsers } from './api.ts'\nfetch("/api/users")\n`)
  fs.writeFileSync(path.join(tree, "tests", "api.test.ts"), `import { listUsers } from '../src/api.ts'\n`)
  fs.writeFileSync(path.join(tree, "schema.sql"), `CREATE TABLE users (id int);\n`)
  const g1 = buildCrossGraph(tree)
  ok("graph has api.ts", g1.files.some((f) => /api\.ts$/.test(f.path)))
  ok("graph IMPLEMENTS or CONSUMES", g1.stats.implements + g1.stats.consumes > 0)
  const s1 = getIndexStats()
  ok("first graph parse", s1.parsed >= 3 && s1.reused === 0)
  buildCrossGraph(tree)
  const s2 = getIndexStats()
  eq("second graph parsed 0", s2.parsed, 0)
  ok("second graph reused", s2.reused >= 3)
  const map = buildRepoMap(tree)
  ok("map still has listUsers", /listUsers/.test(map))
  const r = impactRadius({ files: [path.join(tree, "src", "api.ts")], cwd: tree })
  ok("impact finds web importer", r.importers.some((p) => /web\.ts$/.test(p)))
  ok("impact finds test", r.testsAll ? r.testsAll.some((p) => /api\.test/.test(p)) : r.tests.some((p) => /api\.test/.test(p)))
  ok("impact used graph", r.graph === true)
  ok("impact skip empty without ledger", Array.isArray(r.skipped) && r.skipped.length === 0)
  const engine = createContextEngine({ cwd: tree })
  const ctx = engine.build("users api")
  ok("context has cross slice or empty-ok", typeof ctx.text === "string")
  ok("cross graph in context when edges exist", /CROSS GRAPH/.test(ctx.text) || g1.stats.implements + g1.stats.consumes === 0)
  fs.rmSync(tree, { recursive: true, force: true })
}

console.log("== omega fixture still resolves via graph ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v33-omega-"))
  fs.writeFileSync(path.join(dir, "util.js"), "export function add(a,b){return a+b}\n")
  fs.writeFileSync(path.join(dir, "app.js"), "import { add } from './util.js'\nadd(1,2)\n")
  fs.mkdirSync(path.join(dir, "tests"))
  fs.writeFileSync(path.join(dir, "tests", "util.test.js"), "import { add } from '../util.js'\n")
  const r = impactRadius({ files: [path.join(dir, "util.js")], cwd: dir })
  ok("finds the importer", r.importers.some((p) => /app\.js$/.test(p)))
  ok("finds the test", (r.testsAll || r.tests).some((p) => /util\.test/.test(p)))
  ok("scope includes focused_test", r.scope.includes("focused_test"))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log("== frozen kernel + package ==")
{
  const cfg = defaultConfig()
  eq("assumeYes stays false", cfg.tools.assumeYes, false)
  eq("allowSudo stays false", cfg.tools.allowSudo, false)
  const { dropped } = sanitizeProjectConfig({ tools: { assumeYes: true } })
  ok("project cannot flip assumeYes", dropped.includes("tools.assumeYes"))
  eq("classifyTaskComplexity frozen", classifyTaskComplexity("fix a typo"), "trivial")
  eq("VERSION is 47.0.0", VERSION, "47.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8"))
  eq("package.json is 47.0.0", pkg.version, "47.0.0")
  ok("files includes xlang.js", pkg.files.includes("xlang.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
}

console.log(`\n== v33 suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
