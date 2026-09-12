#!/usr/bin/env node
/**
 * forge — v86 providers: gonkarouter + unorouter, doc-true catalog refresh,
 * and the custom-provider auto strategy (env-backed failover, latency order,
 * `forge provider add`).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v86-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_DATA_DIR
const { CATALOG, getCatalog, fallbackChain, buildProvider } = await import("../providers.js")
const { VERSION } = await import("../version.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

console.log("== version ==")
eq("VERSION is 86.0.0", VERSION, "86.0.0")
eq("package.json is 86.0.0", JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version, "86.0.0")

console.log("== new routers: doc-true endpoints ==")
{
  const g = getCatalog("gonkarouter")
  ok("gonkarouter exists", !!g)
  eq("gonkarouter baseUrl", g?.baseUrl, "https://api.gonkarouter.io/v1")
  eq("gonkarouter envKey", g?.envKey, "GONKAROUTER_API_KEY")
  ok("gonkarouter keyUrl is the dashboard", /gonkarouter\.io\/dashboard/.test(g?.keyUrl ?? ""))
  ok("gonkarouter has models", (g?.models ?? []).length >= 2)
  const u = getCatalog("unorouter")
  ok("unorouter exists", !!u)
  eq("unorouter baseUrl", u?.baseUrl, "https://api.unorouter.com/v1")
  eq("unorouter envKey", u?.envKey, "UNOROUTER_API_KEY")
  eq("unorouter protocol", u?.protocol, "openai")
}

console.log("== doc-true catalog refresh ==")
{
  eq("github-models uses models.github.ai/inference", getCatalog("github-models")?.baseUrl, "https://models.github.ai/inference")
  ok("github-models ids are org-prefixed", getCatalog("github-models")?.models?.every((m) => m.includes("/")))
  ok("openai on the 5.6 family", getCatalog("openai")?.models?.some((m) => m.startsWith("gpt-5.6")))
  ok("anthropic on sonnet-5", getCatalog("anthropic")?.models?.includes("claude-sonnet-5"))
  ok("gemini on 3.x", getCatalog("gemini")?.models?.some((m) => m.startsWith("gemini-3")))
  ok("xai on grok-4.6", getCatalog("xai")?.models?.includes("grok-4.6"))
  ok("zai on glm-5.x", getCatalog("zai")?.models?.some((m) => m.startsWith("glm-5")))
  ok("groq has llama-4-scout", getCatalog("groq")?.models?.includes("llama-4-scout"))
  ok("cerebras current two", getCatalog("cerebras")?.models?.join(",") === "gpt-oss-120b,zai-glm-4.7")
  // owner instruction: openrouter is NOT touched
  const or = getCatalog("openrouter")
  eq("openrouter baseUrl untouched", or?.baseUrl, "https://openrouter.ai/api/v1")
  eq("openrouter models untouched", or?.models?.join("|"), "openai/gpt-4o-mini|anthropic/claude-sonnet-4.5")
  // every catalog baseUrl must be an https URL (or deliberately empty for custom)
  const bad = CATALOG.filter((c) => c.name !== "custom" && !/^https:\/\/|^http:\/\/localhost/.test(c.baseUrl))
  eq("all catalog baseUrls are URLs", bad.length, 0)
}

console.log("== auto failover: env-keyed providers join after a green probe ==")
{
  process.env.GROQ_API_KEY = "test-key"
  process.env.GONKAROUTER_API_KEY = "test-key"
  // key in env but never probed → NOT in the chain (no blind switches; a CI
  // GITHUB_TOKEN must never become an inference fallback on its own)
  const cold = fallbackChain({ providers: { zai: { apiKey: "k", baseUrl: "https://cfg.example/v1", model: "m" } } }, "openai", {})
  ok("env key alone does NOT auto-join (no blind switch)", !cold.map((p) => p.name).includes("groq"))
  const chain = fallbackChain(
    { providers: { zai: { apiKey: "k", baseUrl: "https://cfg.example/v1", model: "m" } } },
    "openai",
    { health: { groq: { ok: true, ms: 90 }, gonkarouter: { ok: true, ms: 400 } } },
  )
  const names = chain.map((p) => p.name)
  ok("config provider in chain", names.includes("zai"))
  ok("probed env-backed groq auto-joins", names.includes("groq"))
  ok("probed env-backed gonkarouter auto-joins", names.includes("gonkarouter"))
  ok("active provider excluded", !names.includes("openai"))
  // latency ordering: groq probed faster than gonkarouter → groq first among tested
  const chain2 = fallbackChain({ providers: {} }, "none", { health: { groq: { ok: true, ms: 90 }, gonkarouter: { ok: true, ms: 400 } } })
  const t = chain2.map((p) => p.name)
  ok("tested ordered fastest-first", t.indexOf("groq") < t.indexOf("gonkarouter"), t)
  ok("untested providers come after tested", t.slice(t.indexOf("gonkarouter") + 1).every((n) => !["groq"].includes(n)))
  delete process.env.GROQ_API_KEY
  delete process.env.GONKAROUTER_API_KEY
  // scrub every catalog env key so the sandbox's own GITHUB_TOKEN etc. cannot
  // masquerade as a configured provider here
  for (const c of CATALOG) if (c.envKey) delete process.env[c.envKey]
  const empty = fallbackChain({ providers: {} }, "none", {})
  eq("no keys → no chain (no phantom fallbacks)", empty.length, 0)
}

console.log("== buildProvider for a config-only custom provider ==")
{
  const p = buildProvider({ providers: { mygw: { baseUrl: "https://gw.example/v1", apiKey: "sk", model: "x" } } }, "mygw")
  ok("custom provider resolves", p?.baseUrl === "https://gw.example/v1" && p?.protocol === "openai")
  ok("catalog-less providers get label = name", p?.label === "mygw")
}

console.log("== forge provider CLI (subprocess, isolated config) ==")
{
  const T = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v86-cli-"))
  const cfg = path.join(T, "config.json")
  fs.writeFileSync(cfg, "{}\n")
  const env = { ...process.env, FORGE_CONFIG: cfg, FORGE_HOME: T, NO_COLOR: "1" }
  const forgejs = path.join(path.dirname(new URL("../forge.js", import.meta.url).pathname), "forge.js")
  const run = (...args) => spawnSync(process.execPath, [forgejs, ...args], { env, encoding: "utf8", timeout: 60000 })
  let r = run("provider", "add", "mygw", "https://not-a-real-host.example/v1")
  ok("provider add registers even when unreachable", /mygw → https:\/\/not-a-real-host\.example\/v1/.test(r.stdout), (r.stdout + r.stderr).slice(0, 200))
  r = run("provider", "add", "openai", "https://x.example")
  ok("cannot shadow a built-in name", /built-in provider/.test(r.stderr), r.stderr.slice(0, 160))
  r = run("provider", "add", "bad name", "https://x.example")
  ok("invalid name refused", r.status !== 0)
  r = run("provider", "add", "nokey", "ftp://nope")
  ok("non-http baseUrl refused", r.status !== 0 && /https?:\/\//.test(r.stderr))
  r = run("provider", "set-key", "mygw", "sk-test-1234567890")
  ok("set-key saves", /apiKey for mygw/.test(r.stdout))
  r = run("provider", "test", "mygw")
  ok("probe of a dead host reports fail honestly", /fail/.test(r.stdout) || /fail/.test(r.stderr))
  r = run("provider", "list")
  ok("list shows the custom provider", /mygw/.test(r.stdout) && /not-a-real-host\.example/.test(r.stdout))
  r = run("use", "mygw")
  ok("forge use accepts the custom provider", r.status === 0)
  r = run("provider", "remove", "mygw")
  ok("remove works", /removed/.test(r.stdout))
  const saved = JSON.parse(fs.readFileSync(cfg, "utf8"))
  ok("config no longer has mygw", !saved.providers?.mygw)
  try { fs.rmSync(T, { recursive: true, force: true }) } catch {}
}

console.log(`\n== v86 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
