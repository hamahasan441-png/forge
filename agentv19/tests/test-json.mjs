#!/usr/bin/env node
/**
 * forge — structured output checks (v20.2 P2-6): `--json` on data commands
 * emits exactly one valid JSON document. Runs the real CLI with an isolated
 * FORGE_HOME. Zero network (only offline-safe commands are exercised).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-json-"))
const FORGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "forge", "forge.js")
const env = { ...process.env, FORGE_HOME: HOME, NO_COLOR: "1" }

// seed a session and a memory note and a plugin so listings are non-empty
fs.mkdirSync(path.join(HOME, "sessions"), { recursive: true })
fs.writeFileSync(path.join(HOME, "sessions", "s1.json"), JSON.stringify({ id: "s1", ts: 1, updatedAt: 1, provider: "mock", model: "m", title: "fix the parser bug", messages: [{ role: "user", content: "the parser crashes on empty input" }] }))
fs.mkdirSync(path.join(HOME, "tools"), { recursive: true })
fs.writeFileSync(path.join(HOME, "tools", "t.mjs"), 'export default { name: "demo_tool", description: "demo", parameters: { type: "object", properties: {} }, readOnly: true, run(){ return "ok" } }')

const run = (args) => execFileSync("node", [FORGE, ...args], { env, encoding: "utf8" })
const runOk = (args) => { try { return { out: run(args), code: 0 } } catch (e) { return { out: String(e.stdout ?? ""), code: e.status ?? 1 } } }

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const parse = (s) => { try { return JSON.parse(s) } catch { return null } }

console.log("== sessions --json ==")
{
  const j = parse(run(["sessions", "--json"]))
  ok("valid JSON", !!j)
  ok("has count + sessions array", j && j.count === 1 && Array.isArray(j.sessions))
  ok("session fields present", j && j.sessions[0].id === "s1" && j.sessions[0].title === "fix the parser bug")
}
console.log("== sessions --search --json ==")
{
  const j = parse(run(["sessions", "--search", "parser", "--json"]))
  ok("search json has query + hits", j && j.query === "parser" && j.count === 1 && /parser/.test(j.sessions[0].snippet))
  const empty = parse(run(["sessions", "--search", "zzzznope", "--json"]))
  ok("no matches → count 0, empty array", empty && empty.count === 0 && empty.sessions.length === 0)
}
console.log("== plugins --json ==")
{
  const j = parse(run(["plugins", "--json"]))
  ok("valid JSON with tools", j && Array.isArray(j.tools) && j.tools.some((t) => t.name === "demo_tool"))
  ok("plugin readOnly flag present", j && j.tools.find((t) => t.name === "demo_tool").readOnly === true)
}
console.log("== skills --check --json ==")
{
  const r = runOk(["skills", "--check", "--json"])
  const j = parse(r.out)
  ok("valid JSON report", j && typeof j.total === "number" && Array.isArray(j.skills))
  ok("bundled skills clean → exit 0", j && j.ok === true && r.code === 0)
}
console.log("== memory list --json ==")
{
  run(["memory", "add", "prefer tabs over spaces"])
  const j = parse(run(["memory", "list", "--json"]))
  ok("valid JSON with entries", j && Array.isArray(j.entries) && j.entries.includes("prefer tabs over spaces"))
}
console.log("== --json emits nothing but JSON ==")
{
  const out = run(["sessions", "--json"]).trim()
  ok("output is a single JSON document", out.startsWith("{") && out.endsWith("}") && !!parse(out))
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
console.log(`\n== json suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
