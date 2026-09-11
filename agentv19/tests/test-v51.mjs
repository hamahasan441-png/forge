#!/usr/bin/env node
/**
 * forge — v51 apinex: OpenAI-compatible provider at api.apinex.bond/v1.
 * Live catalog (auth /v1/models or public /api/public/models). Custom ids
 * union onto the list. Wizard pick 18 stays custom.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v51-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v51-work-"))
process.chdir(WORK)

const {
  CATALOG, getCatalog, envKeyFor, listModels, listApinexModels,
  APINEX_FREE_FALLBACK, isFreeModelId, isApinexProvider,
} = await import("../forge/providers.js")
const { lookupRegistry } = await import("../forge/modelregistry.js")
const { defaultConfig, sanitizeProjectConfig } = await import("../forge/config.js")
const { classifyTaskComplexity, classifyTask, TASK_CLASS } = await import("../forge/classify.js")
const { VERSION } = await import("../forge/version.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

const HERE = path.dirname(fileURLToPath(import.meta.url))

console.log("== catalog: apinex after custom (pick 18 stays custom) ==")
{
  const names = CATALOG.map((c) => c.name)
  ok("apinex is in CATALOG", names.includes("apinex"))
  eq("custom is still index 17 (pick 18)", names[17], "custom")
  eq("apinex is index 18 (pick 19)", names[18], "apinex")
  const c = getCatalog("apinex")
  eq("protocol openai", c.protocol, "openai")
  eq("baseUrl", c.baseUrl, "https://api.apinex.bond/v1")
  eq("envKey", c.envKey, "APINEX_API_KEY")
  eq("needsKey", c.needsKey, true)
  ok("default model gpt-5.6-luna", c.models[0] === "gpt-5.6-luna")
  ok("seed includes a free/ id", c.models.some((m) => m.startsWith("free/")))
  eq("1M-class window", c.contextWindow, 1048576)
  eq("isApinexProvider catalog", isApinexProvider(c), true)
  ok("isApinexProvider by url", isApinexProvider(null, "https://api.apinex.bond/v1"))
  eq("envKeyFor unset", envKeyFor("apinex"), process.env.APINEX_API_KEY || null)
}

console.log("== free id rules + registry ==")
{
  ok("free/ prefix is free", isFreeModelId("free/gemini-3.8-flash"))
  ok(":free suffix still free", isFreeModelId("openai/gpt-4o-mini:free"))
  ok("paid id is not free", !isFreeModelId("gpt-5.6-luna"))
  ok("entry.free wins", isFreeModelId("gpt-5.6-luna", { free: true }))
  ok("registry via free/ prefix", lookupRegistry("free/gemini-3.8-flash")?.contextWindow === 1048576)
  ok("registry grok-4.6", lookupRegistry("grok-4.6")?.contextWindow === 500000)
}

console.log("== public catalog fetch + custom extraModels ==")
{
  const payload = {
    models: [
      { id: "free/gemini-3.8-flash", name: "Gemini 3.8 Flash", contextWindow: "1M", dollarsPer1M: 1, provider: "Free" },
      { id: "gpt-5.6-luna", name: "Gpt 5.6 Luna", contextWindow: "1M", dollarsPer1M: 0.075, provider: "OpenAI" },
      { id: "grok-4.6", name: "Grok 4.6", contextWindow: "500K", dollarsPer1M: 0.25, provider: "xAI" },
    ],
  }
  const srv = http.createServer((req, res) => {
    if (req.url === "/api/public/models") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify(payload))
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ data: [{ id: "auth-only-model", context_length: 128000 }] }))
    }
    res.writeHead(404); res.end("no")
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const port = srv.address().port
  const publicUrl = `http://127.0.0.1:${port}/api/public/models`
  const authBase = `http://127.0.0.1:${port}/v1`

  const pub = await listApinexModels({ publicUrl, timeoutMs: 2000 })
  eq("public live", pub.live, true)
  eq("public source", pub.source, "public")
  eq("public total", pub.total, 3)
  ok("parsed 1M context", pub.all.find((e) => e.id === "gpt-5.6-luna")?.context === 1_000_000)
  ok("parsed 500K context", pub.all.find((e) => e.id === "grok-4.6")?.context === 500_000)
  ok("free/ flagged free", pub.free.some((e) => e.id === "free/gemini-3.8-flash"))
  ok("paid not in free", !pub.free.some((e) => e.id === "gpt-5.6-luna"))

  const auth = await listApinexModels({ baseUrl: authBase, apiKey: "sk-apx-test", publicUrl, timeoutMs: 2000 })
  eq("auth live", auth.live, true)
  eq("auth source", auth.source, "auth")
  ok("auth sees auth-only-model", auth.all.some((e) => e.id === "auth-only-model"))

  const listed = await listModels({
    catalog: getCatalog("apinex"),
    extraModels: ["my-org/custom-coder", "free/gemini-3.8-flash"],
    publicUrl,
  })
  eq("listModels live via public", listed.live, true)
  eq("custom id is first", listed.models[0], "my-org/custom-coder")
  ok("live ids still present", listed.models.includes("gpt-5.6-luna"))
  ok("duplicate extra not doubled", listed.models.filter((m) => m === "free/gemini-3.8-flash").length === 1)
  ok("custom extra is not marked missing", listed.entries.some((e) => e.id === "my-org/custom-coder"))

  const offline = await listApinexModels({ publicUrl: `http://127.0.0.1:${port}/missing`, timeoutMs: 400 })
  eq("offline live false", offline.live, false)
  ok("offline uses fallback", offline.free.length === APINEX_FREE_FALLBACK.length)

  srv.close()
}

console.log("== source wiring ==")
{
  const prov = fs.readFileSync(new URL("../forge/providers.js", import.meta.url), "utf8")
  const forge = fs.readFileSync(new URL("../forge/forge.js", import.meta.url), "utf8")
  const onboard = fs.readFileSync(new URL("../forge/onboard.js", import.meta.url), "utf8")
  const chat = fs.readFileSync(new URL("../forge/chat.js", import.meta.url), "utf8")
  ok("providers has api.apinex.bond/v1", /api\.apinex\.bond\/v1/.test(prov))
  ok("providers has public catalog URL", /apinex\.bond\/api\/public\/models/.test(prov))
  ok("forge models passes extraModels", /extraModels: config\.providers/.test(forge))
  ok("forge --free uses isFreeModelId", /isFreeModelId\(m/.test(forge))
  ok("onboard detects apinex free", /prov\.name === "apinex"/.test(onboard))
  ok("onboard still detects openrouter", /prov\.name === "openrouter"/.test(onboard))
  ok("chat /models passes extraModels", /extraModels: config\.providers/.test(chat))
  ok("wizard [m] manual still present", /m = manual/.test(onboard))
}

console.log("== frozen kernel + package ==")
{
  const cfg = defaultConfig()
  eq("assumeYes stays false", cfg.tools.assumeYes, false)
  eq("allowNewPlugins stays false", cfg.tools.allowNewPlugins, false)
  const { dropped } = sanitizeProjectConfig({ tools: { assumeYes: true, allowNewPlugins: true } })
  ok("project cannot flip assumeYes", dropped.includes("tools.assumeYes"))
  eq("classifyTaskComplexity frozen", classifyTaskComplexity("fix a typo"), "trivial")
  eq("typo still MICRO", classifyTask("fix a typo in README").class, TASK_CLASS.MICRO)
  eq("VERSION is 54.0.0", VERSION, "54.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8"))
  eq("package.json is 54.0.0", pkg.version, "54.0.0")
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
  ok("files includes providers.js", pkg.files.includes("providers.js"))
}

console.log(`\n== v51 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
