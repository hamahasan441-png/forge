#!/usr/bin/env node
/**
 * forge — standalone terminal AI agent (zero dependencies, Node >= 18)
 *
 * Runs DIRECTLY against AI providers — no localhost server required.
 *
 *   forge                      AutoPick best model (zero questions) → chat, all tools ON
 *   forge --pick               the classic model chooser (Enter = default, ✓/FREE badges)
 *   forge ask "question"       one-shot answer (pipes: echo q | forge ask)
 *   forge chat -m "hi"         one-shot chat        --continue resumes last session
 *   forge chat --deep          DEEP THINKING (high reasoning effort, bigger budgets)
 *   forge agent "fix the bug"  autonomous coding agent with tools (--deep = deep think)
 *   forge agent --plan "task"  read-only plan first, confirm, then execute
 *   forge undo                 restore files changed by the last tool edit
 *   forge onboard              re-run the setup wizard
 *   forge doctor               config + connectivity + latency check (--tools = self-test tools)
 *   forge sessions             list saved conversations
 *   forge config show|path|get|set|unset
 *   forge use <provider>       switch active provider
 *   forge models|providers|skills [name]
 *
 * In chat: type Linux commands (ls, git status, …) — they EXECUTE in the chat
 * like a real terminal; `!` forces. /deep toggles deep thinking.
 *
 * Install anywhere:  cd cli/forge && npm i -g .
 */
import fs from "node:fs"
import path from "node:path"
import { loadConfig, saveConfig, safeView, maskKey, USER_CONFIG_PATH, DEFAULT_DIR, getPath, setPath, pushRecentModel } from "./config.js"
import { CATALOG, getCatalog, envKeyFor, listModels, probe } from "./providers.js"
import { readModelCache, writeModelCache, freeFromCache } from "./modelcache.js"
import { resourceProfile, loadProfile } from "./profile.js"
// v19 performance: onboard.js (readline + probing — the heaviest module) is
// loaded LAZILY, only when a wizard/menu path actually runs.
const loadOnboard = () => import("./onboard.js")
import { readHealth, recordHealth } from "./health.js"
import { runChat } from "./chat.js"
import { runAgent, agentEventPrinter } from "./agent.js"
import { selfTestTools, toolCount } from "./tools.js"
import { resolveSkillsDir, indexSkills, loadSkill } from "./skills.js"
import { lastSessionFile, listSessions, findSession } from "./sessions.js"
import { bold, dim, cyan, green, yellow, red, magenta, info, ok, warn, err, renderMarkdown } from "./ui.js"

const VERSION = "20.0.0"

// v17 global safety net — a crash can NEVER again be silent (the v16 wizard
// gap-error on Termux). Local handlers catch the normal paths; these two catch
// everything that escapes and print a friendly, actionable message.
process.on("unhandledRejection", (e) => {
  err(`unexpected error: ${e?.message ?? String(e)}`)
  console.error(dim(`  run ${cyan("forge doctor")} to diagnose • if this persists: https://github.com/forge-cli/issues`))
  process.exit(1)
})
process.on("uncaughtException", (e) => {
  err(`unexpected error: ${e?.message ?? String(e)}`)
  console.error(dim(`  run ${cyan("forge doctor")} to diagnose • if this persists: https://github.com/forge-cli/issues`))
  process.exit(1)
})

function parseArgs(argv) {
  const positional = [], flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++ }
      else flags[key] = true
    } else positional.push(a)
  }
  return { positional, flags }
}

const { positional, flags } = parseArgs(process.argv.slice(2))
if (flags["no-color"] || !process.stdout.isTTY) process.env.NO_COLOR = "1"

function resolveProvider(config) {
  const name = flags.provider || config.activeProvider || CATALOG.find((c) => c.name !== "custom" && (config.providers[c.name]?.apiKey || (c.envKey && process.env[c.envKey])))?.name || ""
  if (!name) return null
  const cat = getCatalog(name)
  if (!cat && !config.providers[name]) return null
  const conf = config.providers[name] || {}
  const protocol = cat?.protocol ?? conf.protocol ?? "openai"
  const baseUrl = flags["base-url"] || conf.baseUrl || cat?.baseUrl || ""
  const apiKey = flags.key || conf.apiKey || envKeyFor(name) || ""
  const model = flags.model || conf.model || cat?.models?.[0] || ""
  return { name, label: cat?.label ?? name, protocol, baseUrl, apiKey, model, contextWindow: conf.contextWindow ?? cat?.contextWindow ?? 128000, keyUrl: cat?.keyUrl ?? "" }
}

/** v17 SmartStart (v19: only via --pick): bare `forge` asks ONE light question
 *  — which working model to use (Enter = default, type any id to switch, ✓
 *  badges from the health cache, FREE badges from the model cache) — then
 *  drops into chat with all 17 tools + skills ON. Non-TTY never prompts. */
async function smartStart(cfg, p) {
  if (!process.stdin.isTTY) return p
  const conf = cfg.providers?.[p.name] ?? {}
  const cat = getCatalog(p.name)
  const recents = (Array.isArray(conf.models) ? conf.models : []).filter(Boolean)
  const defaults = (cat?.models ?? []).filter(Boolean)
  const freeIds = freeFromCache(p.name).map((m) => m.id)
  const others = [...new Set([...recents, ...defaults, ...freeIds])].filter((m) => m !== p.model)
  if (!others.length) return p
  const health = readHealth()[p.name]
  console.log()
  console.log(bold(`Working models — ${p.name}`) + dim("  (Enter = keep default • number or any model id to switch)"))
  const tagFor = (m) => {
    const tags = []
    if (health?.ok && health?.model === m) tags.push(green("✓ tested"))
    if (freeIds.includes(m)) tags.push(green("FREE"))
    return tags.length ? `   ${tags.join(" ")}` : ""
  }
  console.log(`  ${green("●")} ${bold(p.model)} ${dim("(default)")}${health?.ok && health?.model === p.model ? green("   ✓ tested") : ""}`)
  others.forEach((m, i) => console.log(`  ${bold(String(i + 1).padStart(2))}. ${m}${tagFor(m)}`))
  const { default: rlp } = await import("node:readline/promises")
  const r2 = rlp.createInterface({ input: process.stdin, output: process.stdout })
  let a = ""
  try { a = (await r2.question(bold("model [Enter = default] "))).trim() } catch {} finally { try { r2.close() } catch {} }
  if (!a) return p
  const n = parseInt(a, 10)
  const model = !Number.isNaN(n) && n >= 1 && n <= others.length ? others[n - 1] : a
  if (model === p.model) return p
  p.model = model
  cfg.providers[p.name] = { ...(cfg.providers[p.name] || {}), model }
  pushRecentModel(cfg, p.name, model)
  saveConfig(cfg)
  ok(`model → ${bold(model)}`)
  return p
}

/** v19 AutoPick: ZERO questions. Picks the best working model for the active
 *  provider: your configured default → health-tested → best cached FREE model
 *  → catalog default. One dim notice says what and why. `--pick` gets the
 *  classic chooser instead. Non-TTY never prompts (unchanged). */
function autoPick(cfg, p) {
  const conf = cfg.providers?.[p.name] ?? {}
  const cat = getCatalog(p.name)
  const health = readHealth()[p.name]
  let why = ""
  if (!flags.model && !conf.model) {
    if (health?.ok && health?.model) { p.model = health.model; why = "tested ✓" }
    else {
      const free = freeFromCache(p.name)[0]
      if (free?.id) { p.model = free.id; why = "best free" }
      else if (!p.model && cat?.models?.[0]) { p.model = cat.models[0]; why = "default" }
    }
  } else if (health?.ok && health?.model === p.model) why = "tested ✓"
  else if (conf.model) why = "your default"
  else if (flags.model) why = "--model flag"
  console.log(dim(`auto-picked ${bold(p.model || "(none)")} (${why || "configured"}) — ${cyan("--pick")}${dim(" to choose manually")}`))
  return p
}

function needProvider(config) {
  const p = resolveProvider(config)
  if (p && p.baseUrl && (p.apiKey || p.name === "ollama")) return p
  if (process.stdin.isTTY && !flags.json) {
    err("no provider configured yet — starting onboarding…")
    return null
  }
  // Env auto-detect hint
  const envHit = CATALOG.find((c) => c.envKey && process.env[c.envKey])
  err("no provider configured. Fix with ONE of:")
  console.error(dim(`
  1) wizard:            ${cyan("forge onboard")}
  2) config file:       ${cyan(`$EDITOR ${USER_CONFIG_PATH}`)}
     {
       "activeProvider": "openai",
       "providers": { "openai": { "apiKey": "sk-...", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini" } }
     }
  3) commands:          ${cyan("forge config set providers.openai.apiKey sk-...")}
  4) environment:       ${cyan("OPENAI_API_KEY=sk-... forge config set activeProvider openai")}`))
  if (envHit) console.error(dim(`  (detected ${envHit.envKey} in env — just run: ${cyan(`forge config set activeProvider ${envHit.name}`)})`))
  process.exit(1)
}

async function onboardIfMissing(config) {
  if (resolveProvider(config)) return config
  const { runOnboarding } = await loadOnboard()
  return await runOnboarding(config)
}

const cmd = (positional[0] || "").toLowerCase()

async function main() {
  const { config } = loadConfig(flags.config ? String(flags.config) : undefined)

  if (flags.version || flags.v || cmd === "version") {
    console.log(`forge v${VERSION} (node ${process.version})`)
    return
  }
  if (cmd === "help" || flags.help || flags.h) { printHelp(); return }

  // v20: --profile fast|balanced|deep|auto — persisted before chat starts
  if (typeof flags.profile === "string" && /^[a-z]+$/i.test(flags.profile)) {
    const valid = ["fast", "balanced", "deep", "auto"]
    if (valid.includes(flags.profile.toLowerCase())) {
      config.chat = { ...(config.chat || {}), profile: flags.profile.toLowerCase() }
      saveConfig(config)
    } else {
      err(`unknown profile "${flags.profile}" — use: ${valid.join(" | ")}`)
      process.exit(1)
      return
    }
  }

  switch (cmd) {
    case "": {
      let cfg = await onboardIfMissing(config)
      let p = needProvider(cfg)
      // v16 fix (audit A1): onboarding already ran above — if there is still no
      // usable provider, guide instead of running the wizard a second time.
      if (!p) { return }
      // v19 AutoPick: zero questions — best working model, straight into chat.
      // --pick brings back the v17 chooser.
      p = flags.pick ? await smartStart(cfg, p) : autoPick(cfg, p)
      await runChat({ config: cfg, provider: p, oneShot: null, deep: flags.deep === true ? true : undefined })
      return
    }
    case "onboard": {
      const { runOnboarding } = await loadOnboard()
      await runOnboarding(config)
      return
    }
    case "chat": {
      const cfg = await onboardIfMissing(config)
      let p = needProvider(cfg)
      if (!p) return // v20 fix: wizard aborted — smartStart(null) used to crash
      const msg = flags.m ?? flags.message ?? (positional[1] ? positional.slice(1).join(" ") : null)
      const resume = flags.continue === true || flags.resume === true ? lastSessionFile() : (typeof flags.resume === "string" ? findSession(flags.resume) : null)
      if (typeof flags.resume === "string" && !resume) { err(`no session matches "${flags.resume}" — try: forge sessions`); process.exit(1); return }
      // v19: interactive chat without a message uses AutoPick too (--pick = chooser)
      if (!msg && !resume) p = flags.pick && process.stdin.isTTY ? await smartStart(cfg, p) : autoPick(cfg, p)
      await runChat({ config: cfg, provider: p, oneShot: msg, resumeFile: resume, deep: flags.deep === true ? true : undefined })
      return
    }
    case "resume": {
      // v20: forge resume [n|id] — restore a session (messages + cwd + usage)
      const cfg = await onboardIfMissing(config)
      const p = needProvider(cfg)
      if (!p) return
      const ref = positional[1]
      const file = ref ? findSession(ref) : lastSessionFile()
      if (!file) { err(ref ? `no session matches "${ref}" — try: forge sessions` : "no saved sessions yet"); process.exit(1); return }
      await runChat({ config: cfg, provider: p, resumeFile: file, deep: flags.deep === true ? true : undefined })
      return
    }
    case "ask": {
      const cfg = await onboardIfMissing(config)
      const p = needProvider(cfg)
      if (!p) return // v20 fix: null-provider crash guard (wizard aborted)
      let msg = flags.m ?? flags.message ?? positional.slice(1).join(" ")
      if (!msg && !process.stdin.isTTY) {
        // echo "question" | forge ask
        const raw = fs.readFileSync(0, "utf8").trim()
        if (raw) msg = raw
      }
      if (!msg) { err('usage: forge ask "question"   (or: echo question | forge ask)'); process.exit(1); return }
      await runChat({ config: cfg, provider: p, oneShot: msg, deep: flags.deep === true ? true : undefined })
      return
    }
    case "agent": {
      const cfg = await onboardIfMissing(config)
      const p = needProvider(cfg)
      if (!p) return // v20 fix: null-provider crash guard (wizard aborted)
      const task = positional.slice(1).join(" ") || (typeof flags.task === "string" ? flags.task : "") || (typeof flags.plan === "string" ? flags.plan : "")
      if (!task) { err('usage: forge agent "<task>"   (or: forge agent --plan "<task>")'); process.exit(1); return }
      if (flags.cwd) process.chdir(path.resolve(String(flags.cwd)))
      const planMode = flags.plan !== undefined
      console.log(dim(`forge agent — ${bold(task)}${flags.deep === true ? "  " + green("DEEP") : ""}`))
      console.log(dim(`cwd: ${process.cwd()} • provider: ${p.name}/${p.model} • maxSteps: ${cfg.agent?.maxSteps ?? 25}${planMode ? " • PLAN MODE (read-only)" : ""}`))
      console.log()
      const t0 = Date.now()
      if (planMode) {
        // v16 plan mode: read-only planning pass first, then optional execution
        const res = await runAgent({ config: cfg, provider: p, task, onEvent: agentEventPrinter(), planOnly: true, deep: flags.deep === true ? true : undefined })
        console.log()
        console.log(bold(cyan("── plan " + "─".repeat(54))))
        console.log(renderMarkdown(res.text))
        console.log(dim(`  ${res.steps} steps • ${res.toolLog.length} tool calls • ${((Date.now() - t0) / 1000).toFixed(1)}s`))
        if (!process.stdin.isTTY) {
          warn("plan mode: non-interactive — not executing (re-run without --plan to execute)")
          return
        }
        const { default: rlp } = await import("node:readline/promises")
        const r2 = rlp.createInterface({ input: process.stdin, output: process.stdout })
        const a = (await r2.question(bold("execute this plan now? [y/N] "))).trim().toLowerCase()
        r2.close()
        if (a !== "y" && a !== "yes") { warn("plan not executed"); return }
        console.log()
      }
      const res = await runAgent({ config: cfg, provider: p, task, onEvent: agentEventPrinter(), deep: flags.deep === true ? true : undefined })
      console.log()
      console.log(bold(green("── result " + "─".repeat(50))))
      console.log(renderMarkdown(res.text))
      console.log(dim(`  ${res.steps} steps • ${res.toolLog.length} tool calls • ${((Date.now() - t0) / 1000).toFixed(1)}s`))
      return
    }
    case "undo": {
      // v16: restore the newest checkpoint recorded for this directory
      const { restoreLast, listCheckpoints } = await import("./checkpoint.js")
      const r = restoreLast(process.cwd())
      if (r) {
        ok(`restored ${r.files} file(s) from checkpoint ${r.id}`)
      } else {
        const n = listCheckpoints(process.cwd(), 99).length
        if (n) warn(`no restorable checkpoint (all ${n} consumed or from other directories)`)
        else warn("no checkpoints yet — files are snapshotted automatically before every write/edit/patch")
      }
      return
    }
    case "doctor": {
      console.log(bold("forge doctor"))
      // environment (v16 self-check; v20: full platform + resource view)
      const nodeMajor = Number(process.versions.node.split(".")[0])
      console.log(`  node:      ${nodeMajor >= 18 ? green(process.version + " ok") : red(process.version + " — forge needs Node >= 18")}`)
      const res = resourceProfile()
      console.log(`  platform:  ${process.platform} ${process.arch} • ${res.cores} cores • ${Math.round(res.totalMB / 1024 * 10) / 10}GB RAM (${res.freeMB}MB free) ${dim("tier " + res.tier)}`)
      let gitOk = false
      try { (await import("node:child_process")).execFileSync("git", ["--version"], { stdio: "ignore" }); gitOk = true } catch {}
      console.log(`  terminal:  ${process.stdout.isTTY ? `${process.stdout.columns || "?"}x${process.stdout.rows || "?"} TTY` : "non-TTY (piped)"} • /bin/sh ${fs.existsSync("/bin/sh") ? green("ok") : yellow("missing")} • git ${gitOk ? green("ok") : yellow("missing")}`)
      // config
      const src = flags.config ? String(flags.config) : USER_CONFIG_PATH
      let writable = false
      try { fs.mkdirSync(path.dirname(src), { recursive: true }); fs.accessSync(path.dirname(src), fs.constants.W_OK); writable = true } catch {}
      console.log(`  config:    ${fs.existsSync(src) ? green("found") : yellow("missing")} ${dim(src)} ${writable ? green("(writable)") : red("(directory NOT writable)")}`)
      const checkDir = (label, d) => {
        try {
          fs.mkdirSync(d, { recursive: true })
          fs.accessSync(d, fs.constants.W_OK)
          console.log(`  ${label.padEnd(10)} ${green("writable")} ${dim(d)}`)
        } catch {
          console.log(`  ${label.padEnd(10)} ${red("NOT writable")} ${dim(d)}`)
        }
      }
      checkDir("sessions", path.join(DEFAULT_DIR, "sessions"))
      checkDir("state", path.join(DEFAULT_DIR, "checkpoints"))
      const dir = resolveSkillsDir(config.skills?.dir)
      const idx = dir ? indexSkills(dir) : []
      console.log(`  skills:    ${idx.length ? green(`${idx.length} indexed`) : yellow("none")} ${dim(dir ?? "")} ${config.skills?.enabled === false ? yellow("(disabled)") : ""}`)
      const prof = loadProfile(process.cwd())
      const langList = [...new Set((prof.langs ?? []).map((l) => l.ext))].slice(0, 4).join("/")
      console.log(`  project:   ${langList || prof.packageManager ? green(`${langList || "detected"}${prof.git?.branch ? " on " + prof.git.branch : ""}${prof.scripts?.test ? " • " + prof.scripts.test : ""}`) : dim("not a code project (plain folder)")} ${dim(prof.cached ? "(cached)" : "(fresh)")}`)
      // v17: provider/context line with the tested badge from the health cache
      const pDoc = resolveProvider(config)
      if (pDoc) {
        const h = readHealth()[pDoc.name]
        const tested = h?.ok ? green(`✓ tested ${h.ms ?? "?"}ms`) : yellow("not tested yet (forge doctor probes)")
        console.log(`  provider:  ${bold(pDoc.name)}/${pDoc.model || "?"} ${dim(`context ~${Math.round((pDoc.contextWindow || 128000) / 1000)}k tok`)} ${tested}`)
      }
      if (flags.tools) {
        const results = await selfTestTools({ searchUrl: config.tools?.searchUrl || "", memoryPath: path.join(DEFAULT_DIR, "memory.md"), todoPath: path.join(DEFAULT_DIR, "todo.json") })
        let okN = 0, skipN = 0, failN = 0
        for (const r of results) {
          const tag = r.ok === null ? yellow("skip") : r.ok ? green("ok") : red("FAIL")
          if (r.ok === true) okN++
          else if (r.ok === null) skipN++
          else failN++
          console.log(`  ${dim("tool").padEnd(10)} ${r.name.padEnd(12)} ${tag} ${dim(String(r.ms) + "ms")} ${dim(r.note ?? "")}`)
        }
        console.log(failN === 0 ? `  ${dim("tools:")} ${green(`${okN} ok`)}, ${skipN} skipped, ${failN} failed  ${dim(`(${toolCount()} total)`)}` : `  ${dim("tools:")} ${red(`${failN} FAILED`)}, ${okN} ok, ${skipN} skipped`)
        if (!flags.all) return
      }
      // providers
      const targets = []
      if (flags.all) {
        for (const [name, conf] of Object.entries(config.providers || {})) {
          if (!conf.baseUrl) continue
          const cat = getCatalog(name)
          targets.push({ name, protocol: cat?.protocol ?? "openai", baseUrl: conf.baseUrl, apiKey: conf.apiKey, model: conf.model || cat?.models?.[0] || "unknown" })
        }
      } else {
        const p = resolveProvider(config)
        if (p) targets.push(p)
      }
      if (!targets.length) { warn("no providers to probe — configure one first"); return }
      console.log()
      // v20.0.1: count probe results — a failing probe must NOT end with a "✓"
      let probeOk = 0, probeFail = 0
      const failedNames = []
      for (const t of targets) {
        process.stdout.write(`  ${bold(t.name.padEnd(15))} ${dim((t.model || "?").padEnd(28))} `)
        const r = await probe({ protocol: t.protocol, baseUrl: t.baseUrl, apiKey: t.apiKey, model: t.model })
        if (r.ok) {
          probeOk++
          console.log(green(`ok  ${r.ms}ms`))
          recordHealth(t.name, { ok: true, ms: r.ms, model: t.model, baseUrl: t.baseUrl }) // v17: feeds the ✓ tested badge
        } else {
          probeFail++
          failedNames.push(t.name)
          console.log(red(`fail ${r.ms}ms  ${r.status ? "HTTP " + r.status + " " : ""}${r.error ?? ""}`))
          recordHealth(t.name, { ok: false, model: t.model, baseUrl: t.baseUrl })
          const cat = getCatalog(t.name)
          if (cat?.keyUrl && (r.status === 401 || r.status === 403)) console.log(dim(`         get a valid key: ${cat.keyUrl}`))
          if (r.status === 404) console.log(dim(`         check the model id (${cyan("forge models")}) and providers.${t.name}.baseUrl`))
        }
      }
      console.log()
      // v20.0.1: honest exit line — "✓ doctor done" used to print even when
      // every provider probe had just failed.
      if (probeFail === 0) ok(`doctor done — ${probeOk} provider probe(s) ok`)
      else err(`doctor done — ${probeFail}/${probeOk + probeFail} provider probe(s) FAILED (${[...new Set(failedNames)].join(", ")}) — fix with: forge config set providers.<name>.apiKey <KEY>`)
      return
    }
    case "use": {
      const name = positional[1]
      if (!name || (!getCatalog(name) && !config.providers[name])) {
        err(`unknown provider "${name}". available: ${CATALOG.map((c) => c.name).join(", ")} + any in config`)
        process.exit(1); return
      }
      config.activeProvider = name
      if (!config.providers[name]) config.providers[name] = { apiKey: "", baseUrl: getCatalog(name)?.baseUrl ?? "", model: getCatalog(name)?.models?.[0] ?? "" }
      // v17: forge use <provider> --model <id> — switch AND set model in one line
      const m = typeof flags.model === "string" && flags.model.trim() ? flags.model.trim() : ""
      if (m) { config.providers[name].model = m; pushRecentModel(config, name, m) }
      saveConfig(config)
      const p = resolveProvider(config)
      ok(`active provider → ${bold(name)} ${dim(`(${p.model} @ ${p.baseUrl})`)}`)
      if (!p.apiKey && name !== "ollama") warn(`no API key for ${name} yet — set it: ${cyan(`forge config set providers.${name}.apiKey <KEY>`)}${getCatalog(name)?.keyUrl ? dim(`  (get one: ${getCatalog(name).keyUrl})`) : ""}`)
      return
    }
    case "config": {
      // v17: bare `forge config` on a TTY opens the interactive hub —
      // add provider (→ model → key), switch, set model, set key, show, probe.
      const sub0 = positional[1] || ""
      // TTY opens the interactive hub; FORGE_MENU=1 forces it for piped scripts
      if (!sub0 && (process.stdin.isTTY || process.env.FORGE_MENU === "1")) {
        const { runConfigMenu } = await loadOnboard()
        await runConfigMenu(config)
        return
      }
      const sub = sub0 || "show"
      if (sub === "path") { console.log(USER_CONFIG_PATH); return }
      if (sub === "show") { console.log(JSON.stringify(safeView(config), null, 2)); return }
      if (sub === "get") {
        const key = positional[2]
        if (!key) { err("usage: forge config get <path.to.key>"); process.exit(1); return }
        const v = getPath(config, key)
        console.log(/apikey|token/i.test(key) ? maskKey(v) : (v === undefined ? "(unset)" : String(v)))
        return
      }
      if (sub === "set") {
        const key = positional[2], value = positional.slice(3).join(" ")
        if (!key || value === undefined) { err("usage: forge config set <path.to.key> <value>"); process.exit(1); return }
        setPath(config, key, coerce(value))
        saveConfig(config)
        const masked = /apikey|token|key/i.test(key) ? maskKey(value) : value
        ok(`${key} = ${masked}  (saved to ${USER_CONFIG_PATH})`)
        return
      }
      if (sub === "unset") {
        const key = positional[2]
        if (!key) { err("usage: forge config unset <path.to.key>"); process.exit(1); return }
        setPath(config, key, undefined)
        saveConfig(config)
        ok(`${key} removed`)
        return
      }
      err(`unknown: forge config ${sub} (show|path|get|set|unset)`); process.exit(1); return
    }
    case "models": {
      // v18: `forge models [provider] [--free]` — list for ANY provider (no
      // need to switch first); --free shows only free models with context
      // sizes; live fetches refresh ~/.forge/models-cache.json for offline
      // use and SmartStart FREE badges.
      const nameArg = positional[1]
      let t = null
      if (nameArg && nameArg !== "list") {
        const cat = getCatalog(nameArg)
        const conf = config.providers?.[nameArg] || {}
        if (!cat && !conf.baseUrl) {
          err(`unknown provider "${nameArg}". available: ${CATALOG.map((c) => c.name).join(", ")} + any in config`)
          process.exit(1); return
        }
        t = { name: nameArg, protocol: cat?.protocol ?? conf.protocol ?? "openai", baseUrl: conf.baseUrl || cat?.baseUrl || "", apiKey: conf.apiKey || envKeyFor(nameArg) || "", cat }
      } else {
        const p = resolveProvider(config)
        if (!p) { err("configure a provider first: forge onboard"); process.exit(1); return }
        t = { name: p.name, protocol: p.protocol, baseUrl: p.baseUrl, apiKey: p.apiKey, cat: getCatalog(p.name) }
      }
      if (!t.baseUrl) { err(`no baseUrl known for ${t.name} — set it: forge config set providers.${t.name}.baseUrl <url>`); process.exit(1); return }
      const activeModel = config.providers?.[t.name]?.model || t.cat?.models?.[0] || ""
      info(`fetching models from ${t.name} (${t.baseUrl})…`)
      const { models, live, warning, entries } = await listModels({ protocol: t.protocol, baseUrl: t.baseUrl, apiKey: t.apiKey, catalog: t.cat })
      if (live && entries?.length) writeModelCache(t.name, entries)
      const metaById = new Map((entries || []).map((e) => [e.id, e]))
      let listed = models
      if (!live) {
        const cached = readModelCache(t.name)
        if (cached?.entries?.length) {
          warn(`${warning ?? "offline"} — using cached list (${new Date(cached.ts).toISOString().slice(0, 16).replace("T", " ")})`)
          listed = cached.entries.map((e) => e.id)
          for (const e of cached.entries) metaById.set(e.id, e)
        } else if (warning) {
          warn(`live list failed: ${warning} — built-in suggestions:`)
        }
      }
      if (flags.free === true) {
        const shown = listed
          .filter((m) => metaById.get(m)?.free || m.endsWith(":free"))
          .sort((a, b) => (metaById.get(b)?.context ?? 0) - (metaById.get(a)?.context ?? 0))
        if (!shown.length) {
          warn(`no free models detected for ${t.name} — on OpenRouter free ids end with ":free" (see: forge models ${t.name})`)
          return
        }
        console.log(bold(`free models — ${t.name}`) + dim(live ? "  (live)" : "  (cached)"))
        for (const m of shown) {
          const e = metaById.get(m)
          const ctx = e?.context ? dim(`   ~${Math.round(e.context / 1000)}k tok`) : ""
          const nm = e?.name ? dim(`   ${e.name}`) : ""
          console.log(`${m === activeModel ? green("● ") : "  "}${green("FREE")} ${m}${ctx}${nm}`)
        }
        console.log(dim(`${shown.length} free model(s) — set one: forge use ${t.name} --model <id>`))
        return
      }
      for (const m of listed) {
        const e = metaById.get(m)
        const freeTag = e?.free || m.endsWith(":free") ? green("FREE ") : ""
        const ctxTag = e?.context ? dim(`  ~${Math.round(e.context / 1000)}k`) : ""
        console.log((m === activeModel ? green("● ") : "  ") + freeTag + m + (m === activeModel ? dim("  (active)") : "") + ctxTag)
      }
      console.log(dim(live ? `${listed.length} models (live)` : `${listed.length} suggestions (offline)`))
      return
    }
    case "providers": {
      console.log(bold("providers  (✓ = key set, ● = active)"))
      for (const c of CATALOG) {
        const set = config.providers[c.name]?.apiKey || (c.envKey && process.env[c.envKey])
        const active = config.activeProvider === c.name ? green(" ●") : ""
        console.log(`  ${bold(c.name.padEnd(15))} ${dim(c.label.padEnd(26))} ${set ? green("✓") : dim("·")}${active}`)
      }
      for (const [name, conf] of Object.entries(config.providers || {})) {
        if (getCatalog(name)) continue
        const active = config.activeProvider === name ? green(" ●") : ""
        console.log(`  ${bold(name.padEnd(15))} ${dim(String(conf.baseUrl || "custom").padEnd(26))} ${conf.apiKey ? green("✓") : dim("·")}${active}`)
      }
      return
    }
    case "sessions": {
      const listed = listSessions(15)
      if (!listed.length) { warn("no saved sessions yet — they are auto-saved as you chat"); return }
      console.log(bold(`sessions (${listed.length} newest) — ~/.forge/sessions/`))
      listed.forEach((s, i) => {
        const age = Math.round((Date.now() - (s.ts || Date.now())) / 60000)
        const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`
        const title = s.title ? dim(`  ${s.title.slice(0, 44)}`) : ""
        console.log(`  ${bold(String(i + 1).padStart(2))}. ${dim(s.id ?? s.file)}  ${cyan((s.provider || "?") + "/" + (s.model || "?"))}  ${dim(`${s.turns} turns • ${ageStr}`)}${title}`)
      })
      console.log(dim("  resume: forge resume <n|id>  •  in chat: /resume <n>  •  last: forge chat --continue"))
      return
    }
    case "skills": {
      const dir = resolveSkillsDir(config.skills?.dir)
      if (!dir) { err("no skills directory found (looked in ./skills, repo root, cli/forge/skills, ~/.forge/skills)"); process.exit(1); return }
      const sub = positional[1]
      if (sub && sub !== "list") {
        const md = loadSkill(dir, sub)
        if (!md) { err(`skill "${sub}" not found in ${dir}`); process.exit(1); return }
        console.log(md)
        return
      }
      const idx = indexSkills(dir)
      console.log(bold(`skills (${idx.length}) — ${dir}`))
      for (const s of idx) console.log(`  ${cyan(s.name.padEnd(32))} ${dim(s.desc)}`)
      return
    }
    default:
      err(`unknown command "${cmd}"`)
      printHelp()
      process.exit(1)
  }
}

function coerce(v) {
  if (v === "true") return true
  if (v === "false") return false
  if (v !== "" && !Number.isNaN(Number(v))) return Number(v)
  return v
}

function printHelp() {
  console.log(`
${bold(magenta("⬢ forge"))} v${VERSION} — standalone terminal AI agent (no server needed)

${bold("usage")}
  ${cyan("forge")}                        AutoPick the best working model → chat, all tools ON (zero questions)
  ${cyan("forge --pick")}                 the classic model chooser (Enter = default, ✓ tested / FREE badges)
  ${cyan('forge ask "summarize git log"')} quick one-shot answer ${dim('(or: echo q | forge ask)')}
  ${cyan('forge chat -m "hi"')}           one-shot chat        ${dim("--continue = resume last session")}
  ${cyan('forge resume <n|id>')}          resume a saved session (messages + cwd + usage)
  ${cyan('forge agent "fix the bug"')}    coding agent — auto-uses all 17 tools (bash, files, web, memory, sub-agents)
  ${cyan('forge agent --plan "task"')}    plan first (read-only), confirm, then execute
  ${cyan("forge undo")}                   restore files changed by the last tool edit (auto-checkpoints)
  ${cyan("forge onboard")}                setup wizard (provider → model → API key → verify, saved at every step)
  ${cyan("forge config")}                 interactive config menu (add provider / model / key / test)
  ${cyan("forge config show|path|get|set|unset")}
  ${cyan("forge doctor")}                 connectivity + latency check   ${dim("--all = every provider  --tools = self-test all 17 tools")}
  ${cyan("forge sessions")}               list saved conversations
  ${cyan("forge use <provider> --model <id>")}  switch provider and/or model
  ${cyan("forge models [provider] [--free]")}    list models — --free = OpenRouter free tier only

${bold("terminal + deep (v19/v20)")}
  in chat: type Linux commands (${cyan("ls")}, ${cyan("git status")}, ${cyan("cat file")}) — they EXECUTE in the chat like a real terminal
  ${cyan("!<command>")}               force-execute a shell command • cd/export persist • output shared with the model
  ${cyan("--deep")} / ${cyan("/deep")}             DEEP THINKING — high reasoning effort (OpenRouter/o-series), bigger budgets, verify-first
  ${cyan("--profile")} / ${cyan("/profile")}       effort profile: fast | balanced | deep | auto (auto = deep for complex tasks)

${bold("safety (v20)")}
  writes stay inside the project dir • sensitive files (.env, keys, credentials) protected from the model
  shell commands risk-classified (catastrophic always blocked; risky ones ask y/N) • SSRF-guarded URL fetches
  tool results secret-redacted • sub-agents read-only, depth-capped, timed out

${bold("flags")}
  --provider <name>  --model <id>  --key <api-key>  --base-url <url>  --deep  --pick  --profile <p>
  --config <path>    --cwd <dir> (agent)  --plan (agent)  --continue  --resume <n|id>  -m "message"  --no-color

${bold("config file")}  ${USER_CONFIG_PATH}  (chmod 600, env vars as fallback)
${bold("providers")}     ${CATALOG.map((c) => c.name).join(", ")}
${bold("uninstall")}     ${cyan("npm uninstall -g forge-agent-cli")}
`)
}

main().catch((e) => {
  err(e?.message ?? String(e))
  process.exit(1)
})
