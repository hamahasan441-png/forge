#!/usr/bin/env node
/**
 * forge — config, health and version checks (v20.3, P2-2 follow-up).
 * These three modules are load-bearing (every command reads config; failover
 * reads/writes health; the version drives the CLI banner and the packaged
 * manifest) yet had no direct unit coverage. Isolated FORGE_HOME, zero network.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cfg-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_CONFIG

const { DEFAULT_DIR, USER_CONFIG_PATH, SESSIONS_DIR, PROJECT_CONFIG_NAME,
        defaultConfig, loadConfig, saveConfig, maskKey, safeView,
        getPath, setPath, pushRecentModel } = await import("../forge/config.js")
const { HEALTH_PATH, readHealth, recordHealth } = await import("../forge/health.js")
const { VERSION } = await import("../forge/version.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }

console.log("== version.js ==")
{
  const pkg = JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8"))
  ok("VERSION matches package.json (single source of truth)", VERSION === pkg.version)
  ok("VERSION looks like a semver", /^\d+\.\d+\.\d+/.test(VERSION))
}

console.log("== config paths honor FORGE_HOME ==")
ok("DEFAULT_DIR is the isolated home", DEFAULT_DIR === HOME)
ok("USER_CONFIG_PATH sits under it", USER_CONFIG_PATH.startsWith(HOME))
ok("SESSIONS_DIR sits under it", SESSIONS_DIR.startsWith(HOME))
ok("PROJECT_CONFIG_NAME is the project file name", PROJECT_CONFIG_NAME === "forge.config.json")

console.log("== defaultConfig / save / load round-trip ==")
{
  const d = defaultConfig()
  ok("defaultConfig has a providers map", d && typeof d.providers === "object")
  d.providers.openai = { apiKey: "sk-abcdef1234567890", model: "gpt-4o-mini" }
  saveConfig(d)
  ok("saveConfig wrote the config file", fs.existsSync(USER_CONFIG_PATH))
  const { config } = loadConfig()
  ok("loadConfig reads it back", config.providers.openai.model === "gpt-4o-mini")
  const mode = fs.statSync(USER_CONFIG_PATH).mode & 0o777
  ok("config file is not world-readable (holds API keys)", (mode & 0o077) === 0)
}

console.log("== maskKey / safeView never leak a key ==")
ok("short key masked", maskKey("sk-123") === "sk***")
ok("long key keeps only head+tail", maskKey("sk-abcdef1234567890") === "sk-abc...7890")
ok("missing key is labelled", maskKey("") === "(not set)")
{
  const view = safeView({ providers: { openai: { apiKey: "sk-abcdef1234567890", model: "m" } } })
  const s = JSON.stringify(view)
  ok("safeView masks the key", !s.includes("sk-abcdef1234567890"))
  ok("safeView keeps other fields", view.providers.openai.model === "m")
}

console.log("== getPath / setPath ==")
{
  const o = {}
  setPath(o, "a.b.c", 1)
  ok("setPath creates nested objects", o.a.b.c === 1)
  ok("getPath reads a dotted path", getPath(o, "a.b.c") === 1)
  ok("getPath on a missing path is undefined", getPath(o, "a.x.y") === undefined)
  setPath(o, "a.b.c", undefined)
  ok("setPath(undefined) deletes the key", !("c" in o.a.b))
  setPath(o, "a", "scalar")
  setPath(o, "a.b", 2)
  ok("setPath replaces a scalar with an object", o.a.b === 2)
}

console.log("== pushRecentModel ==")
{
  const cfg = { providers: { p: { models: ["m1"] } } }
  pushRecentModel(cfg, "p", "m2")
  ok("newest model first", cfg.providers.p.models[0] === "m2")
  pushRecentModel(cfg, "p", "m1")
  ok("re-picking an old model moves it to the front", cfg.providers.p.models[0] === "m1")
  ok("no duplicates", cfg.providers.p.models.filter((m) => m === "m1").length === 1)
  for (let i = 0; i < 12; i++) pushRecentModel(cfg, "p", "x" + i)
  ok("capped at 8", cfg.providers.p.models.length === 8)
  const before = JSON.stringify(cfg)
  pushRecentModel(cfg, "missing-provider", "z")
  ok("unknown provider is a no-op", JSON.stringify(cfg) === before)
}

console.log("== health.js ==")
{
  ok("HEALTH_PATH sits under FORGE_HOME", HEALTH_PATH.startsWith(HOME))
  ok("readHealth on a missing file returns {}", JSON.stringify(readHealth()) === "{}")
  recordHealth("openai", { ok: true, ms: 230, model: "gpt-4o" })
  const h = readHealth()
  ok("recordHealth persists an entry", h.openai.ok === true && h.openai.model === "gpt-4o")
  ok("recordHealth stamps a timestamp", typeof h.openai.ts === "number")
  recordHealth("openai", { ok: false, error: "boom" })
  const h2 = readHealth()
  ok("recordHealth merges rather than replaces", h2.openai.model === "gpt-4o" && h2.openai.ok === false)
  ok("recordHealth with no name is a no-op", (recordHealth("", { ok: true }), Object.keys(readHealth()).length === 1))
  fs.writeFileSync(HEALTH_PATH, "{ not json")
  ok("a corrupt health cache never throws", JSON.stringify(readHealth()) === "{}")
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
console.log(`\n== config suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
