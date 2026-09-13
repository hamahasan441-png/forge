#!/usr/bin/env node
/**
 * forge — v94b: TokenRouter provider + understand-anything skills pack +
 * knowledge-graph memory bridge.
 *
 * 1. TokenRouter — doc-true catalog entry (verified live: GET
 *    https://api.tokenrouter.com/v1/models without a key → 401 "Token not
 *    provided"), buildProvider wiring, env-key failover auto-join, and a real
 *    chatOnce against a local mock /chat/completions asserting the Bearer key
 *    and the OpenAI wire shape.
 * 2. understand-anything pack — the 9 bundled skills validate, the subagent
 *    definitions ship inside the referencing skills, FIRST_PARTY routes tasks
 *    to them, load_skill serves the 58KB understand playbook INTACT (64KB
 *    ceiling) prefixed with its skill dir.
 * 3. knowledge-graph bridge — a project with .ua/knowledge-graph.json feeds
 *    provenance-tagged candidates into engmemory retrieval (keyword-gated,
 *    stale-safe, never fact/verified); the legacy .understand-anything dir and
 *    a corrupt file are handled honestly.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v94b-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_DATA_DIR

const { CATALOG, getCatalog, buildProvider, fallbackChain, chatOnce, ProviderError } = await import("../providers.js")
const { checkSkills, loadSkill, indexSkills } = await import("../skills.js")
const { FIRST_PARTY, pickSkills } = await import("../skillforge.js")
const { execTool } = await import("../tools.js")
const { createEngMemory } = await import("../engmemory.js")
const { TASK_CLASS } = await import("../classify.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

console.log("== tokenrouter: doc-true catalog entry ==")
{
  const t = getCatalog("tokenrouter")
  ok("tokenrouter exists", !!t)
  eq("tokenrouter baseUrl", t?.baseUrl, "https://api.tokenrouter.com/v1")
  eq("tokenrouter envKey", t?.envKey, "TOKENROUTER_API_KEY")
  eq("tokenrouter protocol", t?.protocol, "openai")
  eq("tokenrouter needsKey", t?.needsKey, true)
  ok("tokenrouter keyUrl points at the site", /tokenrouter\.com/.test(t?.keyUrl ?? ""))
  ok("tokenrouter has models", (t?.models ?? []).length >= 2)
  ok("tokenrouter appended AFTER the pinned indexes (custom@17, apinex@18 untouched)",
    CATALOG[17]?.name === "custom" && CATALOG[18]?.name === "apinex" && CATALOG[CATALOG.length - 1]?.name === "tokenrouter")
  const bad = CATALOG.filter((c) => c.name !== "custom" && !/^https:\/\/|^http:\/\/localhost/.test(c.baseUrl))
  eq("all catalog baseUrls are URLs", bad.length, 0)
}

console.log("== tokenrouter: buildProvider + failover ==")
{
  const conf = { providers: { tokenrouter: { apiKey: "cfg-key" } } }
  const p = buildProvider(conf, "tokenrouter")
  ok("config provider builds", p?.baseUrl === "https://api.tokenrouter.com/v1" && p?.apiKey === "cfg-key")
  eq("default model is the first catalog model", p?.model, getCatalog("tokenrouter").models[0])
  eq("no key → not buildable", buildProvider({ providers: {} }, "tokenrouter"), null)
  process.env.TOKENROUTER_API_KEY = "env-key"
  const envP = buildProvider({ providers: {} }, "tokenrouter")
  eq("env key builds", envP?.apiKey, "env-key")
  // never a blind switch: env key without a green probe stays out of the chain
  const cold = fallbackChain({ providers: {} }, "none", {})
  ok("env key alone does NOT auto-join", !cold.map((x) => x.name).includes("tokenrouter"))
  const chain = fallbackChain({ providers: {} }, "none", { health: { tokenrouter: { ok: true, ms: 120 } } })
  ok("probed env-backed tokenrouter auto-joins", chain.map((x) => x.name).includes("tokenrouter"))
  for (const c of CATALOG) if (c.envKey) delete process.env[c.envKey]
  eq("scrubbed env → no phantom chain", fallbackChain({ providers: {} }, "none", {}).length, 0)
}

console.log("== tokenrouter: real wire call (mock upstream) ==")
{
  const seen = { auth: "", path: "", model: "", body: "" }
  const srv = http.createServer((req, res) => {
    let buf = ""
    req.on("data", (c) => { buf += c })
    req.on("end", () => {
      seen.auth = req.headers.authorization ?? ""
      seen.path = req.url ?? ""
      try { const b = JSON.parse(buf || "{}"); seen.model = b.model; seen.body = buf } catch {}
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        id: "chatcmpl-tr", object: "chat.completion", model: seen.model,
        choices: [{ index: 0, message: { role: "assistant", content: " routed " }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const url = `http://127.0.0.1:${srv.address().port}/v1`
  try {
    const p = { name: "tokenrouter", label: "TokenRouter", protocol: "openai", baseUrl: url, apiKey: "tr-test-key", model: "deepseek-chat", contextWindow: 128000 }
    const out = await chatOnce({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model, protocol: "openai", messages: [{ role: "user", content: "ping" }] })
    ok("chatOnce returns content", typeof out?.content === "string" && out.content.includes("routed"), JSON.stringify(out).slice(0, 120))
    eq("Bearer auth sent", seen.auth, "Bearer tr-test-key")
    ok("chat/completions path used", /\/chat\/completions$/.test(seen.path), seen.path)
    eq("model passed through", seen.model, "deepseek-chat")
  } catch (e) {
    ok("chatOnce against mock succeeds", false, e?.message ?? e)
  } finally {
    srv.close()
  }
}

console.log("== understand-anything pack: bundled and valid ==")
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILLS = path.join(HERE, "..", "skills")
const PACK = ["understand", "understand-chat", "understand-dashboard", "understand-diff", "understand-domain", "understand-explain", "understand-figma", "understand-knowledge", "understand-onboard"]
{
  const rep = checkSkills(SKILLS)
  ok("all bundled skills valid", rep.ok === true, JSON.stringify(rep.skills.filter((s) => !s.ok).slice(0, 3)))
  // v94 skillwise: strictly stronger — the superpowers pack joined the bundled
  // skills, so the total moved 89 → 102. The understand pack must still all be
  // there (checked below) and everything must still validate.
  eq("102 bundled skills", rep.total, 102)
  const idx = indexSkills(SKILLS)
  for (const name of PACK) {
    const e = idx.find((s) => s.name === name)
    ok(`skill indexed with description: ${name}`, !!e && e.desc.length > 10)
  }
  // subagent definitions ship inside the referencing skills
  ok("understand bundles 6 agent defs", ["architecture-analyzer", "assemble-reviewer", "file-analyzer", "graph-reviewer", "project-scanner", "tour-builder"].every((a) => fs.existsSync(path.join(SKILLS, "understand", "agents", `${a}.md`))))
  ok("understand-domain bundles domain-analyzer", fs.existsSync(path.join(SKILLS, "understand-domain", "agents", "domain-analyzer.md")))
  ok("understand-figma bundles design-analyzer", fs.existsSync(path.join(SKILLS, "understand-figma", "agents", "design-analyzer.md")))
  ok("understand scripts are self-contained on disk", ["scan-project.mjs", "extract-structure.mjs", "compute-batches.mjs", "build-fingerprints.mjs", "prepare-incremental.mjs", "finalize-incremental.mjs"].every((s) => fs.existsSync(path.join(SKILLS, "understand", s))))
  // forge execution notes present in the subagent-dispatching skills
  for (const name of ["understand", "understand-dashboard", "understand-domain", "understand-figma"]) {
    const md = fs.readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf8")
    ok(`forge execution notes appended: ${name}`, md.includes("## Forge execution notes") && md.includes("[skill dir:"))
  }
}

console.log("== understand pack: catalog routing ==")
{
  // the agent's real call passes the classified task class (agent.js pickSkills
  // opts.klass) — MICRO/SMALL tasks intentionally get zero auto-picks unless a
  // skill is explicitly named, so exercise the MEDIUM path here
  const idx = indexSkills(SKILLS).map((s) => ({ name: s.name, desc: s.desc }))
  for (const name of PACK) ok(`FIRST_PARTY entry: ${name}`, FIRST_PARTY.some((s) => s.name === name && s.tags?.length >= 3))
  const picks = pickSkills("map the architecture of this codebase and explain the module structure", idx, { cwd: HOME, klass: TASK_CLASS.MEDIUM })
  ok("architecture task routes to understand", picks.some((p) => p.name === "understand"), JSON.stringify(picks.map((p) => p.name)))
  const picks2 = pickSkills("write an onboarding guide for new engineers", idx, { cwd: HOME, klass: TASK_CLASS.MEDIUM })
  ok("onboarding task routes to understand-onboard", picks2.some((p) => p.name === "understand-onboard"), JSON.stringify(picks2.map((p) => p.name)))
  const picks3 = pickSkills("understand-diff the PR and list affected components", idx, { cwd: HOME, klass: TASK_CLASS.MEDIUM })
  ok("explicitly named skill always wins", picks3.some((p) => p.name === "understand-diff"), JSON.stringify(picks3.map((p) => p.name)))
  const microPicks = pickSkills("explain billing", idx, { cwd: HOME, klass: TASK_CLASS.MICRO })
  ok("MICRO tasks still get zero auto-picks", !microPicks.some((p) => p.name === "understand-explain"), JSON.stringify(microPicks.map((p) => p.name)))
}

console.log("== load_skill: skill dir prefix + 64KB ceiling ==")
{
  const ctx = { cwd: HOME, root: HOME, skillsDir: SKILLS, readOnly: false }
  const big = await execTool(ctx, "load_skill", { name: "understand" })
  ok("understand playbook loads intact (no 24KB truncation)", typeof big === "string" && big.length > 40000 && !big.includes("... (truncated)"), String(big?.length))
  ok("response carries the skill dir header", /^\[skill dir: .+\]\n\n/.test(big), big.slice(0, 60))
  const dir = big.match(/^\[skill dir: (.+?)\]/)?.[1] ?? ""
  eq("skill dir header resolves to the real skill directory", dir, path.join(SKILLS, "understand"))
  ok("playbook keeps the 7-phase pipeline", big.includes("Phase") && big.includes("knowledge-graph.json"))
  const err = await execTool(ctx, "load_skill", { name: "../../etc/passwd" })
  ok("traversal still rejected", String(err).startsWith("ERROR"))
  // skills.js loadSkill default ceiling matches (64KB), no prefix there
  const viaLib = loadSkill(SKILLS, "understand")
  ok("skills.js loadSkill loads 58KB+ intact", typeof viaLib === "string" && viaLib.length > 40000 && !viaLib.includes("... (truncated)"), String(viaLib?.length))
  ok("skills.js loadSkill stays unprefixed", typeof viaLib === "string" && !viaLib.startsWith("[skill dir:"))
}

console.log("== knowledge-graph bridge: retrieval ==")
{
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v94b-kg-"))
  const graph = {
    version: "2.9.7", kind: "codebase",
    project: { name: "checkout-service", languages: ["typescript"], frameworks: ["fastify", "prisma"], description: "Payments and checkout API", analyzedAt: new Date().toISOString(), gitCommitHash: "abc1234" },
    nodes: [
      { id: "n1", type: "module", name: "billing-core", filePath: "src/billing/core.ts", summary: "Invoice calculation engine", tags: ["billing"], complexity: "complex" },
      { id: "n2", type: "service", name: "payment-gateway", filePath: "src/billing/gateway.ts", summary: "External payment provider adapter", tags: ["payments"], complexity: "moderate" },
      { id: "n3", type: "endpoint", name: "health-route", filePath: "src/health.ts", summary: "Liveness probe", tags: [], complexity: "simple" },
    ],
    edges: [
      { source: "n1", target: "n2", type: "calls", direction: "forward", weight: 0.9 },
      { source: "n2", target: "n1", type: "reads_from", direction: "forward", weight: 0.5 },
      { source: "n3", target: "n1", type: "imports", direction: "forward", weight: 0.4 },
      { source: "n3", target: "n2", type: "imports", direction: "forward", weight: 0.4 },
    ],
    layers: [{ id: "l1", name: "Billing domain", description: "money paths", nodeIds: ["n1", "n2"] }, { id: "l2", name: "Ops", description: "health", nodeIds: ["n3"] }],
    tour: [],
  }
  fs.mkdirSync(path.join(proj, ".ua"), { recursive: true })
  fs.writeFileSync(path.join(proj, ".ua", "knowledge-graph.json"), JSON.stringify(graph))
  const mem = createEngMemory({ cwd: proj, taskId: "t-kg" })
  const hits = mem.retrieve({ query: "billing payment module architecture" })
  const kg = hits.filter((h) => h.source === "knowledge-graph")
  ok("knowledge-graph candidates retrieved", kg.length >= 1, JSON.stringify(hits.map((h) => h.source)))
  ok("overview fact surfaced", kg.some((h) => /checkout-service/.test(h.text) && /fastify/.test(h.text)))
  ok("hub module surfaced with degree", kg.some((h) => /hub: .+\(\w+, \d+ relationships\)/.test(h.text)))
  ok("layer names surfaced", kg.some((h) => /Billing domain/.test(h.text)))
  ok("provenance-tagged, never fact/verified", kg.every((h) => h.source === "knowledge-graph" && h.status === "memory" && h.confidence === 0.55 && !h.evidence))
  ok("bounded output (≤4 candidates)", kg.length <= 4, String(kg.length))
  const block = mem.retrievalBlock("billing payment module architecture", { limit: 8 })
  ok("retrievalBlock carries the graph facts", block.includes("knowledge-graph"))
  // keyword gate: an unrelated query must NOT pay for graph noise
  const unrelated = mem.retrieve({ query: "kubernetes cluster autoscaling yaml pipeline" })
  ok("unrelated query gets no graph candidates", !unrelated.some((h) => h.source === "knowledge-graph"))
  // a file-path query surfaces the hub with its file reference
  const byFile = mem.retrieve({ query: "core.ts billing" })
  ok("file-path keyword surfaces hub with files", byFile.some((h) => h.source === "knowledge-graph" && (h.files ?? []).includes("src/billing/core.ts")))

  console.log("== knowledge-graph bridge: legacy dir + corrupt file ==")
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v94b-legacy-"))
  fs.mkdirSync(path.join(legacy, ".understand-anything"), { recursive: true })
  fs.writeFileSync(path.join(legacy, ".understand-anything", "knowledge-graph.json"), JSON.stringify(graph))
  const mem2 = createEngMemory({ cwd: legacy, taskId: "t-kg2" })
  ok("legacy .understand-anything dir honored", mem2.retrieve({ query: "billing payment" }).some((h) => h.source === "knowledge-graph"))
  const corrupt = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v94b-corrupt-"))
  fs.mkdirSync(path.join(corrupt, ".ua"), { recursive: true })
  fs.writeFileSync(path.join(corrupt, ".ua", "knowledge-graph.json"), "{ not json")
  const mem3 = createEngMemory({ cwd: corrupt, taskId: "t-kg3" })
  eq("corrupt graph degrades to no candidates", mem3.retrieve({ query: "billing" }).filter((h) => h.source === "knowledge-graph").length, 0)
  ok("corrupt graph does not break retrieval", Array.isArray(mem3.retrieve({ query: "billing" })))
}

console.log(`\n${PASS} pass, ${FAIL} fail`)
if (FAIL > 0) { console.log("FAILED"); process.exit(1) }
console.log("PASSED")
