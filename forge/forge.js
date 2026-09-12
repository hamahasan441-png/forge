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
import { loadConfig, saveConfig, safeView, maskKey, USER_CONFIG_PATH, DEFAULT_DIR, getPath, setPath, pushRecentModel, AGENT_BUDGETS } from "./config.js"
import { CATALOG, getCatalog, envKeyFor, listModels, probe, isFreeModelId, buildProvider } from "./providers.js"
import { readModelCache, writeModelCache, freeFromCache } from "./modelcache.js"
import { resourceProfile, loadProfile } from "./profile.js"
// v19 performance: onboard.js (readline + probing — the heaviest module) is
// loaded LAZILY, only when a wizard/menu path actually runs.
const loadOnboard = () => import("./onboard.js")
// v89 performance: the interactive surfaces load LAZILY too. chat.js pulls a
// ~38-module graph (terminal, uistate, render, editor, markdown, compaction,
// vision, browser…), agent.js its own ~28 — `forge version|models|sessions|
// config|use|doctor` must not pay ~110ms of module compile for a REPL they
// never open. Loaded once per invocation inside the branch that needs them.
const loadChat = () => import("./chat.js")
const loadAgent = () => import("./agent.js")
const loadAgentView = () => import("./agentview.js")
const loadToolsMod = () => import("./tools.js")
const loadCapabilities = () => import("./capabilities.js")
const loadRouter = () => import("./router.js")
const loadPlugins = () => import("./plugins.js")
const loadExtend = () => import("./extend.js")
import { readHealth, recordHealth } from "./health.js"
import { resolveSkillsDir, indexSkills, loadSkill, checkSkills } from "./skills.js"
import { lastSessionFile, listSessions, findSession, searchSessions } from "./sessions.js"
import { bold, dim, cyan, green, yellow, red, magenta, info, ok, warn, err, renderMarkdown } from "./ui.js"
import { VERSION } from "./version.js"
import { memoryEntries, appendMemory, forgetMemory, clearMemory, pruneMemory, memoryPathFor } from "./memory.js"
import { savePlan, listPlans, readPlan } from "./plans.js"

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

// boolean flags that must NOT consume the following positional argument
const BOOLEAN_FLAGS = new Set(["plan", "deep", "auto", "json", "stream", "no-color", "version", "help", "continue", "all", "list", "yolo", "apply", "dry-run", "crew", "markdown"])

function parseArgs(argv) {
  const positional = [], flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2).split("=")[0]
      const eq = a.includes("=") ? a.slice(a.indexOf("=") + 1) : undefined
      if (eq !== undefined) { flags[key] = coerce(eq); continue }
      const next = argv[i + 1]
      if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) { flags[key] = next; i++ }
      else flags[key] = true
    } else positional.push(a)
  }
  return { positional, flags }
}

const { positional, flags } = parseArgs(process.argv.slice(2))
if (flags["no-color"] || !process.stdout.isTTY) process.env.NO_COLOR = "1"

// v20.2 (P2-6): machine-readable output. `--json` on data commands prints one
// JSON document and nothing else, so forge can be scripted.
const JSON_OUT = flags.json === true || flags.json === "true"

async function runSkillDownload(urls) {
  const { downloadSkills, formatDownloadReport, listDownloads, skillDownloadsDir } = await import("./skilldl.js")
  const { SKILL_LIFE } = await import("./evolve.js")
  const list = (urls || []).map((u) => String(u || "").trim()).filter(Boolean)
  if (!list.length) {
    const have = listDownloads()
    if (JSON_OUT) { emitJson({ dir: skillDownloadsDir(), downloads: have }); return 0 }
    console.log(bold(`skill downloads`) + dim(`  (${have.length}) — ${skillDownloadsDir()}`))
    if (!have.length) {
      console.log(dim('  none yet — forge skill download <https-url>'))
      return 0
    }
    for (const r of have) {
      const life = r.lifecycle || SKILL_LIFE.CANDIDATE
      console.log(`  ${cyan((r.skillName || r.id).padEnd(28))} ${life}  ${dim(r.status || "")}  ${dim(r.sourceUrl || "")}`)
    }
    console.log(dim("  DOWNLOAD ≠ VERIFY. Candidates are not trusted."))
    return 0
  }
  const results = await downloadSkills(list, JSON_OUT ? {} : {
    onProgress: (p) => {
      if (p.phase === "start") process.stderr.write(dim(`  download start ${p.url}\n`))
      else if (p.phase === "read" && p.received) {
        const tot = p.total ? `${p.received}/${p.total}` : `${p.received} B`
        const pct = p.pct == null ? "" : ` ${p.pct}%`
        process.stderr.write(dim(`  download ${tot}${pct}\n`))
      }
    },
  })
  if (JSON_OUT) {
    emitJson({ results: results.map((r) => ({ ok: r.ok, error: r.error || null, reused: r.reused || false, record: r.record || null })) })
  } else {
    for (const r of results) {
      if (r.ok) {
        console.log(formatDownloadReport(r))
        const rec = r.record || {}
        console.log(dim(`  ${rec.filename || ""}  sha256=${String(rec.sha256 || "").slice(0, 12)}…  ${rec.size ?? 0} B`))
        console.log()
      } else {
        err(formatDownloadReport(r).trim())
      }
    }
  }
  return results.every((r) => r.ok) ? 0 : 1
}

async function runToolDownload(urls) {
  const { downloadTools, formatDownloadReport, listToolDownloads, toolDownloadsDir } = await import("./skilldl.js")
  const { SKILL_LIFE } = await import("./evolve.js")
  const list = (urls || []).map((u) => String(u || "").trim()).filter(Boolean)
  if (!list.length) {
    const have = listToolDownloads()
    if (JSON_OUT) { emitJson({ dir: toolDownloadsDir(), downloads: have }); return 0 }
    console.log(bold(`tool downloads`) + dim(`  (${have.length}) — ${toolDownloadsDir()}`))
    if (!have.length) {
      console.log(dim('  none yet — forge tool download <https-url>'))
      return 0
    }
    for (const r of have) {
      const life = r.lifecycle || SKILL_LIFE.CANDIDATE
      console.log(`  ${cyan((r.skillName || r.id).padEnd(28))} ${life}  ${dim(r.status || "")}  ${dim(r.sourceUrl || "")}`)
    }
    console.log(dim("  DOWNLOAD ≠ VERIFY. Candidates are not live tools."))
    return 0
  }
  const results = await downloadTools(list, JSON_OUT ? {} : {
    onProgress: (p) => {
      if (p.phase === "start") process.stderr.write(dim(`  download start ${p.url}\n`))
      else if (p.phase === "read" && p.received) {
        const tot = p.total ? `${p.received}/${p.total}` : `${p.received} B`
        const pct = p.pct == null ? "" : ` ${p.pct}%`
        process.stderr.write(dim(`  download ${tot}${pct}\n`))
      }
    },
  })
  if (JSON_OUT) {
    emitJson({ results: results.map((r) => ({ ok: r.ok, error: r.error || null, reused: r.reused || false, record: r.record || null })) })
  } else {
    for (const r of results) {
      if (r.ok) {
        console.log(formatDownloadReport(r))
        const rec = r.record || {}
        console.log(dim(`  ${rec.filename || ""}  sha256=${String(rec.sha256 || "").slice(0, 12)}…  ${rec.size ?? 0} B`))
        console.log()
      } else {
        err(formatDownloadReport(r).trim())
      }
    }
  }
  return results.every((r) => r.ok) ? 0 : 1
}

async function runVerify(kind, names) {
  const { verifySkills, verifyTools, formatVerifyReport } = await import("./skilldl.js")
  const list = (names || []).map((n) => String(n || "").trim()).filter(Boolean)
  if (!list.length) {
    err(`usage: forge ${kind} verify <name> [<name>…] | all`)
    return 1
  }
  const results = kind === "tool" ? verifyTools(list) : verifySkills(list)
  if (!results.length) {
    if (JSON_OUT) { emitJson({ kind, results: [] }); return 0 }
    console.log(dim(`no ${kind} candidates to verify — download first`))
    return 0
  }
  if (JSON_OUT) { emitJson({ kind, results }); return results.every((r) => r.ok) ? 0 : 1 }
  console.log(formatVerifyReport(results, kind === "tool" ? "TOOL" : "SKILL"))
  return results.every((r) => r.ok) ? 0 : 1
}

async function runLearn(names) {
  const { learnSkill, formatLearnReport } = await import("./skilldl.js")
  const list = (names || []).map((n) => String(n || "").trim()).filter(Boolean)
  if (!list.length) {
    err("usage: forge skill learn <name> [<name>…]")
    return 1
  }
  const results = list.map((n) => learnSkill(n))
  if (JSON_OUT) { emitJson({ results }); return results.every((r) => r.ok) ? 0 : 1 }
  for (const r of results) {
    if (r.ok) console.log(formatLearnReport(r))
    else err(formatLearnReport(r).trim())
  }
  return results.every((r) => r.ok) ? 0 : 1
}

async function runTtl(args) {
  const { setSkillTtl, getSkillTtl, formatTtlReport } = await import("./skilldl.js")
  const name = String(args?.[0] || "").trim()
  const raw = args?.[1]
  if (!name) {
    err("usage: forge skill ttl <name> [<ms>]")
    return 1
  }
  const r = raw == null || raw === "" ? getSkillTtl(name) : setSkillTtl(name, raw)
  if (JSON_OUT) { emitJson(r); return r.ok ? 0 : 1 }
  if (r.ok) console.log(formatTtlReport(r).trimEnd())
  else err(formatTtlReport(r).trim())
  return r.ok ? 0 : 1
}

function emitJson(obj) { console.log(JSON.stringify(obj, null, 2)) }

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
 *  drops into chat with all 22 tools + skills ON. Non-TTY never prompts. */
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
  const { config, ignored: ignoredConfig } = loadConfig(flags.config ? String(flags.config) : undefined)
  // v21.1: say so when a project's forge.config.json tried to widen a security
  // boundary or launch servers — never silently, never honoured
  for (const line of ignoredConfig || []) console.error(`\x1b[33m⚠ ${line}\x1b[0m`)

  // v87: --yolo = FULL CONTROL for this process — every guard off, no
  // permission pauses. tools.autoApprove already defaults ON; this flag is
  // the one-command way to force it (and unrestricted + assumeYes) anywhere.
  if (flags.yolo === true) {
    process.env.FORGE_UNRESTRICTED = "1"
    process.env.FORGE_ASSUME_YES = "1"
    process.env.FORGE_AUTO_APPROVE = "1"
  }

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
      const { runChat } = await loadChat()
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
      const { runChat } = await loadChat()
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
      const { runChat } = await loadChat()
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
      const { runChat } = await loadChat()
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
      console.log(dim(`cwd: ${process.cwd()} • provider: ${p.name}/${p.model} • maxSteps: ${cfg.agent?.maxSteps ?? AGENT_BUDGETS.maxSteps}${planMode ? " • PLAN MODE (read-only)" : ""}`))
      console.log()
      const t0 = Date.now()
      // v20.4: in a terminal the run is rendered from UI state (live dock,
      // honest Ctrl+C); piped runs keep the classic line printer verbatim.
      const { createAgentConsole } = await loadAgentView()
      const { runAgent } = await loadAgent()
      const con = await createAgentConsole({ provider: p.name, model: p.model, cwd: process.cwd(), planOnly: planMode })
      if (planMode) {
        // v16 plan mode: read-only planning pass first, then optional execution
        let res
        try { res = await runAgent({ config: cfg, provider: p, task, onEvent: con.onEvent, planOnly: true, deep: flags.deep === true ? true : undefined, signal: con.signal }) }
        catch (e) { con.stop(); throw e }
        // v20.2 P1-9: persist the plan so it can be reviewed and executed later
        const saved = savePlan(task, res.text, process.cwd())
        if (con.tty) con.finish(res, { elapsedMs: Date.now() - t0, planOnly: true, savedPlan: saved.ok ? `${path.relative(process.cwd(), saved.file)}  (forge plan apply ${saved.slug} to execute later)` : null })
        else {
          console.log()
          console.log(bold(cyan("── plan " + "─".repeat(54))))
          console.log(renderMarkdown(res.text))
          console.log(dim(`  ${res.steps} steps • ${res.toolLog.length} tool calls • ${((Date.now() - t0) / 1000).toFixed(1)}s`))
          if (saved.ok) console.log(dim(`  saved → ${path.relative(process.cwd(), saved.file)}  (${cyan("forge plan apply " + saved.slug)} to execute later)`))
        }
        if (!process.stdin.isTTY) {
          warn("plan mode: non-interactive — not executing (re-run without --plan to execute)")
          con.stop()
          return
        }
        const a = String((await con.ask(bold("execute this plan now? [y/N] "))) ?? "").trim().toLowerCase()
        if (a !== "y" && a !== "yes") { con.stop(); warn("plan not executed"); return }
        if (!con.tty) console.log()
      }
      let res
      try {
        if (!planMode && (flags.auto === true || cfg.agent?.autonomous === "meta")) {
          // v21: full autonomous meta-controller lifecycle (segments, DAG,
          // model strategy, workers, verification ledger, recovery). Opt-in via
          // `--auto` so the default one-shot keeps its classic, pinned output.
          const { runMeta } = await import("./meta.js")
          const m = await runMeta({ config: cfg, provider: p, task, onEvent: con.onEvent, signal: con.signal, deep: flags.deep === true ? true : undefined })
          res = {
            text: m.text || `Task ${m.status.toLowerCase()}.`,
            steps: m.segments,
            toolLog: [],
            runId: m.task?.run_id || null,
            wrote: (m.filesChanged || []).length > 0,
            taskStatus: m.status,
            taskId: m.taskId,
            segments: m.segments,
            repairs: m.repairs,
            toolCallsTotal: m.toolCalls,
            verification: m.verification,
          }
        } else {
          res = await runAgent({ config: cfg, provider: p, task, onEvent: con.onEvent, deep: flags.deep === true ? true : undefined, signal: con.signal })
        }
      }
      catch (e) {
        if (con.tty) { con.finish(null, e?.name === "AbortError" ? { aborted: true } : { error: e?.message ?? String(e) }); con.stop(); process.exit(e?.name === "AbortError" ? 130 : 1) }
        throw e
      }
      if (con.tty) { con.finish(res, { elapsedMs: Date.now() - t0 }); con.stop() }
      else if (res.taskStatus) {
        // meta-controller autonomous run: segment-based summary
        console.log()
        console.log(bold(green("── result " + "─".repeat(50))))
        console.log(renderMarkdown(res.text))
        console.log(dim(`  ${res.steps} segment(s) • ${res.toolCallsTotal ?? 0} tool calls${res.repairs ? ` • ${res.repairs} repair(s)` : ""} • ${((Date.now() - t0) / 1000).toFixed(1)}s • ${res.taskStatus}`))
        if (res.verification && res.wrote) console.log(dim(`  verification: ${res.verification.ok ? green("passed") : yellow(res.verification.reason)}`))
        if (res.wrote && res.runId) console.log(dim(`  undo this whole run: ${cyan("forge undo --run")}`))
      }
      else {
        console.log()
        console.log(bold(green("── result " + "─".repeat(50))))
        console.log(renderMarkdown(res.text))
        console.log(dim(`  ${res.steps} steps • ${res.toolLog.length} tool calls • ${((Date.now() - t0) / 1000).toFixed(1)}s`))
        if (res.wrote && res.runId) console.log(dim(`  undo this whole run: ${cyan("forge undo --run")}`))
      }
      debugRunSummary(res)
      return
    }
    case "undo": {
      // v16: restore the newest checkpoint recorded for this directory.
      // v20.2: --run restores the whole last agent run atomically.
      const { restoreLast, restoreRun, listCheckpoints } = await import("./checkpoint.js")
      if (flags.run !== undefined) {
        let runId = typeof flags.run === "string" ? flags.run : null
        if (runId) {
          // v20.4: accept the short RUN-XXXX id shown in the UI
          const { resolveRunId } = await import("./runlog.js")
          const full = resolveRunId(process.cwd(), runId)
          if (!full) { err(`unknown run "${runId}" — forge checkpoints or /tasks list the ids`); process.exit(1); return }
          runId = full
        }
        const r = restoreRun(process.cwd(), runId)
        if (r) {
          ok(`restored ${r.files} file(s) across ${r.checkpoints} checkpoint(s) from run ${r.runId}`)
          for (const n of r.notes ?? []) console.log(dim(`  · ${n}`))
          // v20.4: the run journal (/tasks) should reflect the rollback
          try { const { markRun } = await import("./runlog.js"); markRun(r.runId, "undone", { note: "rolled back with forge undo --run" }) } catch {}
        } else {
          warn(runId ? `no restorable checkpoints for run ${runId}` : "no restorable agent-run checkpoints for this directory")
        }
        return
      }
      const r = restoreLast(process.cwd())
      if (r) {
        ok(`restored ${r.files} file(s) from checkpoint ${r.id}`)
        for (const n of r.notes ?? []) console.log(dim(`  · ${n}`))
      } else {
        const n = listCheckpoints(process.cwd(), 99).length
        if (n) warn(`no restorable checkpoint (all ${n} consumed or from other directories)`)
        else warn("no checkpoints yet — files are snapshotted automatically before every write/edit/patch")
      }
      return
    }
    case "tasks": {
      // v21: inspect the autonomous task-state engine. `forge tasks` lists
      // recent tasks (--json for machine output); `forge tasks --resume <id>`
      // reconciles an interrupted task and continues it via the meta controller.
      const { listTasks, readTask } = await import("./taskstate.js")
      const { detectInterrupted } = await import("./recovery.js")
      if (typeof flags.resume === "string") {
        const rec = readTask(flags.resume)
        if (!rec) { err(`no task matches "${flags.resume}" — try: forge tasks`); process.exit(1); return }
        const { runMeta } = await import("./meta.js")
        const { createAgentConsole } = await loadAgentView()
        const con = await createAgentConsole({ provider: p.name, model: p.model, cwd: process.cwd() })
        const t0 = Date.now()
        try {
          const m = await runMeta({ config: cfg, provider: p, task: rec.objective, onEvent: con.onEvent, signal: con.signal, resumeTaskId: rec.task_id })
          if (con.tty) { con.finish({ text: m.text, steps: m.segments, toolLog: [] }, { elapsedMs: Date.now() - t0 }); con.stop() }
          else {
            console.log()
            console.log(bold(green("── resumed task " + "─".repeat(48))))
            console.log(renderMarkdown(m.text))
            console.log(dim(`  ${m.segments} segment(s) • ${m.repairs} repair(s) • ${m.status}`))
          }
        } catch (e) {
          if (con.tty) { con.finish(null, { error: e?.message ?? String(e) }); con.stop(); process.exit(1) }
          throw e
        }
        return
      }
      const cwd = flags.all === true ? null : process.cwd()
      const tasks = listTasks({ cwd, max: 30 })
      if (JSON_OUT) { emitJson({ tasks }); return }
      if (!tasks.length) { info("no tasks recorded in this directory yet (autonomous agent runs create them)"); return }
      console.log(bold("tasks") + dim("  (most recent first)"))
      for (const t of tasks.slice(0, 20)) {
        const statusColored = t.status === "COMPLETED" ? green(t.status) : t.status === "FAILED" ? red(t.status) : t.status === "CANCELLED" ? dim(t.status) : yellow(t.status)
        const when = new Date(t.updated_at || t.created_at).toISOString().replace("T", " ").slice(0, 16)
        console.log(`  ${statusColored.padEnd(14)} ${dim(when)} seg=${String(t.segment_count ?? 0).padStart(2)} repair=${String(t.repair_count ?? 0).padStart(2)}  ${String(t.objective ?? "").slice(0, 60)}`)
        console.log(dim(`    ${t.task_id}  • ${t.provider_used ?? "?"}/${t.model_used ?? "?"}`))
      }
      const interrupted = detectInterrupted({ cwd: process.cwd() })
      const nInterrupted = interrupted.tasks.length + interrupted.runs.length
      if (nInterrupted) warn(`${nInterrupted} interrupted run(s) detected — forge tasks --resume <id> continues one (start forge in this dir for the recovery prompt)`)
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
      // v20.5: the capability registry must agree with the shipped safety
      // classification — a drift here would mis-route or mis-gate a tool.
      {
        const { createRegistry, checkWriteClassification } = await loadCapabilities()
        const { BUILTIN_TOOL_NAMES } = await loadToolsMod()
        const regDoc = createRegistry({ config })
        const problems = checkWriteClassification(regDoc)
        const unregistered = [...BUILTIN_TOOL_NAMES].filter((n) => !regDoc.has(n))
        const line = problems.length || unregistered.length
          ? red(`${problems.length + unregistered.length} problem(s)`) + dim(` ${[...problems, ...unregistered.map((n) => `${n}: not in the capability registry`)].slice(0, 3).join(" • ")}`)
          : green(`${regDoc.size()} tools, classification matches tools.js`)
        console.log(`  ${dim("registry:")}  ${line}`)
      }
      if (flags.tools) {
        const { selfTestTools } = await loadToolsMod()
        const results = await selfTestTools({ searchUrl: config.tools?.searchUrl || "", memoryPath: path.join(DEFAULT_DIR, "memory.md"), todoPath: path.join(DEFAULT_DIR, "todo.json") })
        let okN = 0, skipN = 0, failN = 0
        for (const r of results) {
          const tag = r.ok === null ? yellow("skip") : r.ok ? green("ok") : red("FAIL")
          if (r.ok === true) okN++
          else if (r.ok === null) skipN++
          else failN++
          console.log(`  ${dim("tool").padEnd(10)} ${r.name.padEnd(12)} ${tag} ${dim(String(r.ms) + "ms")} ${dim(r.note ?? "")}`)
        }
        const { toolCount } = await loadToolsMod()
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
        // v86 auto strategy: env-keyed catalog providers are probeable too —
        // a green probe here is what puts them FIRST in the failover chain.
        for (const c of CATALOG) {
          if (!c.envKey || !process.env[c.envKey] || !c.baseUrl) continue
          if (targets.some((t) => t.name === c.name)) continue
          targets.push({ name: c.name, protocol: c.protocol, baseUrl: config.providers?.[c.name]?.baseUrl || c.baseUrl, apiKey: config.providers?.[c.name]?.apiKey || process.env[c.envKey] || "", model: config.providers?.[c.name]?.model || c.models?.[0] || "unknown" })
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
        // v20.0.1: objects/arrays printed as JSON, not "[object Object]";
        // secret-ish keys stay masked either way.
        if (/apikey|token/i.test(key)) { console.log(maskKey(v)); return }
        if (v === undefined) { console.log("(unset)"); return }
        console.log(typeof v === "object" && v !== null ? JSON.stringify(v, null, 2) : String(v))
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
      if (!JSON_OUT) info(`fetching models from ${t.name} (${t.baseUrl})…`)
      const { models, live, warning, entries } = await listModels({ protocol: t.protocol, baseUrl: t.baseUrl, apiKey: t.apiKey, catalog: t.cat, extraModels: config.providers?.[t.name]?.models })
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
      if (JSON_OUT) {
        const rows = listed
          .filter((m) => flags.free !== true || isFreeModelId(m, metaById.get(m)))
          .map((m) => { const e = metaById.get(m); return { id: m, free: isFreeModelId(m, e), context: e?.context ?? null, active: m === activeModel } })
        emitJson({ provider: t.name, live: !!live, count: rows.length, models: rows })
        return
      }
      if (flags.free === true) {
        const shown = listed
          .filter((m) => isFreeModelId(m, metaById.get(m)))
          .sort((a, b) => (metaById.get(b)?.context ?? 0) - (metaById.get(a)?.context ?? 0))
        if (!shown.length) {
          warn(`no free models detected for ${t.name} — on OpenRouter free ids end with ":free"; on APInex they start with "free/" (see: forge models ${t.name})`)
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
        const freeTag = isFreeModelId(m, e) ? green("FREE ") : ""
        const ctxTag = e?.context ? dim(`  ~${Math.round(e.context / 1000)}k`) : ""
        console.log((m === activeModel ? green("● ") : "  ") + freeTag + m + (m === activeModel ? dim("  (active)") : "") + ctxTag)
      }
      console.log(dim(live ? `${listed.length} models (live)` : `${listed.length} suggestions (offline)`))
      return
    }
    case "provider": {
      // v86: first-class custom providers. `forge provider add` registers any
      // OpenAI-compatible endpoint under its own name (not the shared
      // "custom" slot), auto-discovers its model list, probes it and records
      // health — after which autopick, failover, doctor and `forge use` treat
      // it exactly like a built-in.
      const sub = (positional[1] || "").toLowerCase()
      if (sub === "add" || sub === "register") {
        const name = (positional[2] || "").trim().toLowerCase()
        const baseUrl = (positional[3] || flags["base-url"] || "").trim().replace(/\/$/, "")
        if (!name || !/^[a-z0-9][a-z0-9._-]{0,30}$/.test(name)) { err("usage: forge provider add <name> <baseUrl> [--model m] [--key k] [--protocol openai|anthropic]"); process.exit(1); return }
        if (!baseUrl || !/^https?:\/\//.test(baseUrl)) { err(`usage: forge provider add ${name} <https://base-url>  (got "${baseUrl || ""}")`); process.exit(1); return }
        if (getCatalog(name)) { err(`"${name}" is a built-in provider — configure it with: forge config set providers.${name}.apiKey <KEY>`); process.exit(1); return }
        const apiKey = flags.key ? String(flags.key) : (config.providers[name]?.apiKey || "")
        const protocol = flags.protocol ? String(flags.protocol) : (config.providers[name]?.protocol || "openai")
        let model = flags.model ? String(flags.model) : (config.providers[name]?.model || "")
        const entry = { apiKey, baseUrl, protocol }
        // auto-discover: with no --model, ask the endpoint for its model list
        // and keep the first chat-sounding id. Best-effort — a gateway without
        // /models still registers; you just set the model yourself.
        let discovered = []
        if (!model) {
          try {
            process.stdout.write(`  discovering models on ${baseUrl} … `)
            const { entries, models, live } = await listModels({ protocol, baseUrl, apiKey })
            discovered = live ? (entries.length ? entries.map((e) => e.id) : models) : []
            const skip = /^(embed|whisper|tts|dall-e|image|rerank|moderation)/i
            model = discovered.find((id) => !skip.test(id)) || discovered[0] || ""
            console.log(model ? green(`${discovered.length} found — using ${model}`) : yellow("no /models endpoint — set --model"))
          } catch { console.log(yellow("unreachable during discovery — registered anyway")) }
        }
        if (model) entry.model = model
        if (discovered.length) entry.models = discovered.slice(0, 64)
        config.providers[name] = entry
        if (!config.activeProvider) config.activeProvider = name
        saveConfig(config)
        ok(`${name} → ${baseUrl}${model ? dim(`  model ${model}`) : ""}${!config.providers[name].apiKey ? yellow("  (no key yet — forge provider set-key " + name + " <KEY>") : ""}`)
        // probe immediately so the ✓ tested badge and failover ordering work
        try {
          const r = await probe({ protocol, baseUrl, apiKey, model: model || undefined })
          recordHealth(name, { ok: !!r.ok, ms: r.ms, model, baseUrl })
          console.log(r.ok ? dim(`  probe: ok ${r.ms}ms`) : dim(`  probe: ${r.status ? "HTTP " + r.status + " " : ""}${r.error ?? "fail"} ${r.ms}ms`))
        } catch {}
        console.log(dim(`  switch to it: ${cyan(`forge use ${name}`)}`))
        return
      }
      if (sub === "remove" || sub === "rm") {
        const name = (positional[2] || "").trim().toLowerCase()
        if (!name || !config.providers[name]) { err(`no such configured provider: ${name || "(none)"}`); process.exit(1); return }
        if (getCatalog(name)) { err(`${name} is built-in — it stays in the catalog; use "forge config unset providers.${name}" to clear its settings`); process.exit(1); return }
        delete config.providers[name]
        if (config.activeProvider === name) config.activeProvider = ""
        saveConfig(config)
        ok(`${name} removed`)
        return
      }
      if (sub === "set-key" || sub === "key") {
        const name = (positional[2] || "").trim().toLowerCase()
        const key = positional.slice(3).join(" ")
        if (!name || !key || !config.providers[name]) { err("usage: forge provider set-key <name> <KEY>"); process.exit(1); return }
        config.providers[name].apiKey = key
        saveConfig(config)
        ok(`apiKey for ${name} = ${maskKey(key)}  (saved to ${USER_CONFIG_PATH})`)
        return
      }
      if (sub === "test" || sub === "probe") {
        const names = positional[2] ? [positional[2].toLowerCase()] : Object.keys(config.providers || {})
        if (!names.length) { warn("no providers configured"); return }
        let okN = 0
        for (const name of names) {
          const p = buildProvider(config, name)
          if (!p) { err(`${name}: not usable (no baseUrl or missing key)`); continue }
          process.stdout.write(`  ${bold(name.padEnd(15))} ${dim((p.model || "?").padEnd(28))} `)
          const r = await probe({ protocol: p.protocol, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model })
          recordHealth(name, { ok: !!r.ok, ms: r.ms, model: p.model, baseUrl: p.baseUrl })
          if (r.ok) { okN++; console.log(green(`ok  ${r.ms}ms`)) }
          else console.log(red(`fail ${r.ms}ms  ${r.status ? "HTTP " + r.status + " " : ""}${r.error ?? ""}`))
        }
        console.log(dim(`  ${okN}/${names.length} probe(s) ok — health feeds failover ordering (fastest first)`))
        return
      }
      if (sub === "list" || sub === "") { /* list == `forge providers` */ }
      else { err(`unknown: forge provider ${sub} (add|remove|set-key|test|list)`); process.exit(1); return }
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
      // v20.2 (P1-6): --search "text" finds sessions by title/summary/content
      const query = typeof flags.search === "string" ? flags.search
        : (flags.search === true ? positional.slice(1).join(" ") : "")
      if (flags.search !== undefined) {
        if (!query) { err('usage: forge sessions --search "text"'); process.exit(1); return }
        const hits = searchSessions(query)
        if (JSON_OUT) { emitJson({ query, count: hits.length, sessions: hits }); return }
        if (!hits.length) { warn(`no sessions match "${query}"`); return }
        console.log(bold(`sessions matching "${query}" (${hits.length})`))
        hits.forEach((s, i) => {
          const age = Math.round((Date.now() - (s.ts || Date.now())) / 60000)
          const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`
          console.log(`  ${bold(String(i + 1).padStart(2))}. ${dim(s.id)}  ${cyan((s.provider || "?") + "/" + (s.model || "?"))}  ${dim(`${s.turns} turns • ${ageStr}`)}${s.title ? dim("  " + s.title.slice(0, 40)) : ""}`)
          if (s.snippet) console.log(dim(`      …${s.snippet}…`))
        })
        console.log(dim("  resume a match: forge resume <id>"))
        return
      }
      const listed = listSessions(JSON_OUT ? 999 : 15)
      if (JSON_OUT) { emitJson({ count: listed.length, sessions: listed }); return }
      if (!listed.length) { warn("no saved sessions yet — they are auto-saved as you chat"); return }
      console.log(bold(`sessions (${listed.length} newest) — ~/.forge/sessions/`))
      listed.forEach((s, i) => {
        const age = Math.round((Date.now() - (s.ts || Date.now())) / 60000)
        const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`
        const title = s.title ? dim(`  ${s.title.slice(0, 44)}`) : ""
        console.log(`  ${bold(String(i + 1).padStart(2))}. ${dim(s.id ?? s.file)}  ${cyan((s.provider || "?") + "/" + (s.model || "?"))}  ${dim(`${s.turns} turns • ${ageStr}`)}${title}`)
      })
      console.log(dim("  resume: forge resume <n|id>  •  search: forge sessions --search \"text\"  •  last: forge chat --continue"))
      return
    }
    case "skill": {
      const sub = (positional[1] || "").toLowerCase()
      if (!sub || sub === "list" || sub === "downloads") {
        const code = await runSkillDownload([])
        if (code) process.exit(code)
        return
      }
      if (sub === "download") {
        const code = await runSkillDownload(positional.slice(2))
        if (code) process.exit(code)
        return
      }
      if (sub === "verify") {
        const code = await runVerify("skill", positional.slice(2))
        if (code) process.exit(code)
        return
      }
      if (sub === "learn") {
        const code = await runLearn(positional.slice(2))
        if (code) process.exit(code)
        return
      }
      if (sub === "ttl") {
        const code = await runTtl(positional.slice(2))
        if (code) process.exit(code)
        return
      }
      if (sub === "promote" || sub === "rollback") {
        const name = positional[2]
        if (!name) { err(`usage: forge skill ${sub} <name>`); process.exit(1); return }
        const { promoteSkill, rollbackSkill } = await import("./evolve.js")
        const r = sub === "promote" ? promoteSkill(process.cwd(), name) : rollbackSkill(process.cwd(), name)
        if (JSON_OUT) { emitJson(r); if (!r.ok) process.exit(1); return }
        if (!r.ok) { err(r.error); process.exit(1); return }
        ok(sub === "promote"
          ? `promoted ${r.name} → ACTIVE${r.predecessor ? ` (superseded ${r.predecessor})` : ""}`
          : `rolled back ${r.name} → SUPERSEDED, restored ${r.restored}`)
        return
      }
      if (sub === "autopromote") {
        const name = positional[2]
        if (!name) { err("usage: forge skill autopromote <name>"); process.exit(1); return }
        const { autoPromote } = await import("./promote.js")
        const r = autoPromote(name, { cwd: process.cwd() })
        if (JSON_OUT) { emitJson(r); if (!r.ok) process.exit(1); return }
        if (!r.ok) { err(r.error || "gates failed"); process.exit(1); return }
        ok(`auto-promoted ${r.name} → ACTIVE${r.already ? " (already)" : ""}`)
        return
      }
      if (sub === "caps") {
        const name = positional[2]
        if (!name) { err("usage: forge skill caps <name>"); process.exit(1); return }
        const { extractCapabilities } = await import("./caps.js")
        const { skillMdPath, readDownloadedSkill } = await import("./skilldl.js")
        const { readLearnedSkill } = await import("./evolve.js")
        let md = readDownloadedSkill(name) || readLearnedSkill(process.cwd(), name)
        if (!md) {
          try { md = fs.readFileSync(skillMdPath(name), "utf8") } catch { md = "" }
        }
        const r = extractCapabilities(md, { name })
        if (JSON_OUT) { emitJson(r); if (!r.ok) process.exit(1); return }
        if (!r.ok) { err(r.error); process.exit(1); return }
        console.log(bold(`caps ${r.identity || name}`))
        for (const c of r.capabilities) console.log(`  • ${c}`)
        if (r.workflow) console.log(dim(`  workflow: ${String(r.workflow).slice(0, 160)}`))
        return
      }
      if (sub === "ingest") {
        const src = positional[2]
        if (!src) { err("usage: forge skill ingest <zip|folder|SKILL.md>"); process.exit(1); return }
        const { ingestLocal, formatDownloadReport } = await import("./skilldl.js")
        const r = ingestLocal(src)
        if (JSON_OUT) { emitJson(r); if (!r.ok) process.exit(1); return }
        if (!r.ok) { err(r.error); process.exit(1); return }
        console.log(formatDownloadReport(r))
        return
      }
      if (sub === "evidence") {
        const name = positional[2]
        if (!name) { err("usage: forge skill evidence <name>"); process.exit(1); return }
        const { readSkillEvidence, evidenceIsFresh } = await import("./skilldl.js")
        const ev = readSkillEvidence(name)
        if (!ev) { err(`no evidence for "${name}"`); process.exit(1); return }
        const fresh = evidenceIsFresh(name)
        if (JSON_OUT) { emitJson({ name, fresh, evidence: ev }); return }
        console.log(bold(`evidence ${name}`) + dim(`  ${fresh ? "fresh" : "stale/missing fingerprint"}`))
        console.log(`  kind: ${ev.kind}  v${ev.evidenceVersion || ev.v || 1}  ok=${ev.ok === true}`)
        if (ev.sourceFingerprint) console.log(`  fingerprint: ${String(ev.sourceFingerprint).slice(0, 16)}…`)
        for (const r of ev.results || []) {
          console.log(`  ${r.status || (r.ok ? "PASS" : "FAIL")}  ${r.cmd || ""}`)
        }
        return
      }
      if (sub === "benchmark") {
        const name = positional[2]
        if (!name) { err("usage: forge skill benchmark <name>"); process.exit(1); return }
        const { benchmarkSkill } = await import("./skilldl.js")
        const r = benchmarkSkill(name)
        if (JSON_OUT) { emitJson(r); if (!r.ok) process.exit(1); return }
        if (!r.ok) { err(r.error); process.exit(1); return }
        const m = r.metrics || {}
        console.log(bold(`benchmark ${r.name}`) + dim(`  ${r.kind}`))
        if (m.status === "UNKNOWN") console.log(dim(`  ${r.reason || "UNKNOWN — not invented"}`))
        else {
          console.log(`  successRate ${m.successRate}  failureRate ${m.failureRate}  medianMs ${m.medianDurationMs}`)
          console.log(dim("  tokens/interventions UNKNOWN unless measured"))
        }
        return
      }
      if (sub === "variant") {
        const skill = positional[2]
        const strat = positional[3]
        if (!skill || !strat) { err("usage: forge skill variant <name> <strategy>"); process.exit(1); return }
        const { variantFromSkill } = await import("./variant.js")
        const r = variantFromSkill(process.cwd(), skill, strat)
        if (JSON_OUT) { emitJson(r); if (!r.ok) process.exit(1); return }
        if (!r.ok) { err(r.error); process.exit(1); return }
        ok(`variant ${r.name}  ${r.strategy} v${r.version}  ${r.lifecycle}${r.reused ? " (reused)" : ""}`)
        return
      }
      err(`unknown: forge skill ${sub} — use: forge skill download <https-url> | forge skill verify <name|all> | forge skill learn <name> | forge skill ttl <name> [<ms>] | forge skill promote <name> | forge skill rollback <name> | forge skill ingest <zip|folder> | forge skill evidence <name> | forge skill benchmark <name> | forge skill variant <name> <strategy> | forge skill autopromote <name> | forge skill caps <name>`)
      process.exit(1)
      return
    }
    case "tool": {
      const sub = (positional[1] || "").toLowerCase()
      if (!sub || sub === "list" || sub === "downloads") {
        const code = await runToolDownload([])
        if (code) process.exit(code)
        return
      }
      if (sub === "download") {
        const code = await runToolDownload(positional.slice(2))
        if (code) process.exit(code)
        return
      }
      if (sub === "verify") {
        const code = await runVerify("tool", positional.slice(2))
        if (code) process.exit(code)
        return
      }
      err(`unknown: forge tool ${sub} — use: forge tool download <https-url> | forge tool verify <name|all>`)
      process.exit(1)
      return
    }
    case "skills": {
      if (positional[1] === "download") {
        const code = await runSkillDownload(positional.slice(2))
        if (code) process.exit(code)
        return
      }
      if (positional[1] === "verify") {
        const code = await runVerify("skill", positional.slice(2))
        if (code) process.exit(code)
        return
      }
      if (positional[1] === "learn") {
        const code = await runLearn(positional.slice(2))
        if (code) process.exit(code)
        return
      }
      const { indexVerifiedSkills, readDownloadedSkill } = await import("./skilldl.js")
      const extra = indexVerifiedSkills()
      const dir = resolveSkillsDir(config.skills?.dir)
      if (!dir && !extra.length) { err("no skills directory found (looked in ./skills, repo root, cli/forge/skills, ~/.forge/skills)"); process.exit(1); return }
      // v20.2 (P2-5): forge skills --check | forge skills check — validate all skills
      if (flags.check !== undefined || positional[1] === "check") {
        if (!dir) { err("no skills directory found"); process.exit(1); return }
        const rep = checkSkills(dir)
        if (JSON_OUT) { emitJson({ dir, ...rep, downloads: extra }); process.exit(rep.failed ? 1 : 0); return }
        console.log(bold(`skill check (${rep.total}) — ${dir}`))
        for (const s of rep.skills) {
          if (s.ok) console.log(`  ${green("✓")} ${cyan(s.name.padEnd(30))} ${dim(s.sizeKB + " KB")}`)
          else {
            console.log(`  ${red("✗")} ${cyan(s.name.padEnd(30))} ${dim(s.sizeKB + " KB")}`)
            for (const iss of s.issues) console.log(`      ${red("•")} ${iss}`)
          }
        }
        if (extra.length) {
          console.log(dim(`  ${extra.length} verified download(s) — forge skill verify already passed`))
          for (const s of extra) console.log(`  ${green("✓")} ${cyan((s.name || "").padEnd(30))} ${dim("verified download")}`)
        }
        if (rep.failed) { err(`${rep.failed} of ${rep.total} skill(s) have issues`); process.exit(1); return }
        ok(`all ${rep.total} skills valid`)
        return
      }
      const sub = positional[1]
      if (sub && sub !== "list") {
        const md = (dir ? loadSkill(dir, sub) : null) || readDownloadedSkill(sub)
        if (!md) { err(`skill "${sub}" not found`); process.exit(1); return }
        console.log(md)
        return
      }
      const idx = dir ? indexSkills(dir) : []
      if (JSON_OUT) { emitJson({ dir, skills: idx, downloads: extra }); return }
      console.log(bold(`skills (${idx.length})`) + (dir ? dim(`  — ${dir}`) : ""))
      for (const s of idx) console.log(`  ${cyan(s.name.padEnd(32))} ${dim(s.desc)}`)
      if (extra.length) {
        console.log(dim(`verified downloads (${extra.length}) — load_skill / forge skills <name>`))
        for (const s of extra) console.log(`  ${cyan((s.name || "").padEnd(32))} ${dim((s.desc || "verified download").slice(0, 60))}`)
      }
      return
    }
    case "plan": {
      // forge plan [list] | show <n|slug> | apply <n|slug>
      const sub = (positional[1] || "list").toLowerCase()
      if (sub === "list") {
        const plans = listPlans(process.cwd())
        if (!plans.length) { warn('no saved plans yet — run: forge agent --plan "task"'); return }
        console.log(bold(`plans (${plans.length}) — ${path.relative(process.cwd(), path.dirname(plans[0].file))}`))
        plans.forEach((pl, i) => {
          const age = Math.round((Date.now() - pl.mtime) / 60000)
          const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`
          console.log(`  ${bold(String(i + 1).padStart(2))}. ${cyan(pl.slug)}  ${dim(ageStr)}${pl.title ? "  " + dim(pl.title.slice(0, 50)) : ""}`)
        })
        console.log(dim("  show: forge plan show <n|slug>  •  execute: forge plan apply <n|slug>"))
        return
      }
      if (sub === "show") {
        const r = readPlan(positional[2], process.cwd())
        if (!r.ok) { err(r.error); process.exit(1); return }
        console.log(renderMarkdown(r.text))
        return
      }
      if (sub === "apply") {
        const r = readPlan(positional[2], process.cwd())
        if (!r.ok) { err(r.error); process.exit(1); return }
        const cfg = await onboardIfMissing(config)
        const p = needProvider(cfg)
        if (!p) return
        if (flags.cwd) process.chdir(path.resolve(String(flags.cwd)))
        console.log(dim(`forge plan apply — ${bold(r.slug)} • provider: ${p.name}/${p.model}`))
        console.log()
        const t0 = Date.now()
        const task = `Execute the following implementation plan step by step. Verify each step (run tests/builds) before moving on, and keep edits minimal.\n\n${r.text}`
        const { createAgentConsole } = await loadAgentView()
        const { runAgent } = await loadAgent()
        const con = await createAgentConsole({ provider: p.name, model: p.model, cwd: process.cwd() })
        let res
        try { res = await runAgent({ config: cfg, provider: p, task, onEvent: con.onEvent, deep: flags.deep === true ? true : undefined, signal: con.signal }) }
        catch (e) {
          if (con.tty) { con.finish(null, e?.name === "AbortError" ? { aborted: true } : { error: e?.message ?? String(e) }); con.stop(); process.exit(e?.name === "AbortError" ? 130 : 1) }
          throw e
        }
        if (con.tty) { con.finish(res, { elapsedMs: Date.now() - t0 }); con.stop() }
        else {
          console.log()
          console.log(bold(green("── result " + "─".repeat(50))))
          console.log(renderMarkdown(res.text))
          console.log(dim(`  ${res.steps} steps • ${res.toolLog.length} tool calls • ${((Date.now() - t0) / 1000).toFixed(1)}s`))
          if (res.wrote && res.runId) console.log(dim(`  undo this whole run: ${cyan("forge undo --run")}`))
        }
        debugRunSummary(res)
        return
      }
      err(`unknown: forge plan ${sub} — use list | show <n|slug> | apply <n|slug>`)
      process.exit(1)
      return
    }
    case "memory": {
      // forge memory [list] | add <text> | forget <n> | clear | prune
      //   --project = the current project's tier (default: global)
      //   --all     = both tiers (list only)
      const sub = (positional[1] || "list").toLowerCase()
      const tier = flags.project ? "project" : "global"
      const cwd = process.cwd()
      const showTier = (t) => {
        const entries = memoryEntries(t, cwd)
        console.log(bold(`${t} memory`) + dim(`  (${entries.length}) — ${memoryPathFor(t, cwd)}`))
        if (!entries.length) { console.log(dim("  (empty)")); return }
        entries.forEach((e, i) => {
          const text = e.text.replace(/\n\s*/g, " ⏎ ")
          const prov = e.provenance ? dim(`  [${e.provenance.source}${e.provenance.at ? " " + e.provenance.at.slice(0, 10) : ""}]`) : ""
          console.log(`  ${bold(String(i + 1).padStart(3))}. ${text.slice(0, 100)}${text.length > 100 ? dim("…") : ""}${prov}`)
        })
      }
      if (sub === "list") {
        if (JSON_OUT) {
          // entries stay plain strings (v20 contract); provenance is a parallel array
          const dump = (t) => memoryEntries(t, cwd).map((e) => e.text)
          const prov = (t) => memoryEntries(t, cwd).map((e) => e.provenance ?? null)
          emitJson(flags.all ? { global: dump("global"), project: dump("project"), provenance: { global: prov("global"), project: prov("project") } } : { tier, entries: dump(tier), provenance: prov(tier) })
          return
        }
        if (flags.all) { showTier("global"); console.log(); showTier("project") }
        else showTier(tier)
        console.log(dim("  add: forge memory add \"note\" [--project]  •  remove: forge memory forget <n>  •  clear: forge memory clear"))
        return
      }
      if (sub === "add") {
        const text = positional.slice(2).join(" ").trim() || (typeof flags.text === "string" ? flags.text : "")
        if (!text) { err('nothing to add — forge memory add "your note" [--project]'); process.exit(1); return }
        const r = appendMemory(tier, text, cwd, { source: "cli" })
        if (!r.ok) { err(`could not save: ${r.error}`); process.exit(1); return }
        ok(r.deduped ? `already in ${tier} memory (no duplicate added)` : `saved to ${tier} memory`)
        return
      }
      if (sub === "forget") {
        const r = forgetMemory(tier, positional[2], cwd)
        if (!r.ok) { err(r.error); process.exit(1); return }
        ok(`forgot from ${tier} memory: ${String(r.removed).slice(0, 80)}`)
        return
      }
      if (sub === "clear") {
        const r = clearMemory(tier, cwd)
        if (!r.ok) { err(r.error); process.exit(1); return }
        ok(`cleared ${tier} memory (${r.removed} entr${r.removed === 1 ? "y" : "ies"} removed)`)
        return
      }
      if (sub === "prune") {
        const r = pruneMemory(tier, cwd)
        if (!r.ok) { err(r.error); process.exit(1); return }
        ok(r.removed ? `pruned ${r.removed} oldest entr${r.removed === 1 ? "y" : "ies"} from ${tier} memory` : `${tier} memory already within limit`)
        return
      }
      if (sub === "consolidate") {
        const { consolidateMemory } = await import("./memory.js")
        const { consolidateLessons } = await import("./lessons.js")
        const mem = consolidateMemory(tier, cwd)
        const les = consolidateLessons(cwd)
        if (JSON_OUT) { emitJson({ memory: mem, lessons: les }); return }
        ok(`memory ${mem.before}→${mem.after}  lessons ${les.before}→${les.after} (provenance kept)`)
        return
      }
      err(`unknown: forge memory ${sub} — use list | add | forget <n> | clear | prune | consolidate`)
      process.exit(1)
      return
    }
    case "data": {
      // forge data [status] | gaps | reset gaps
      // Inspect the Forge-owned data root (FORGE_HOME / ~/.forge). Never walks
      // the user project. Does not invent a second store.
      const { dataStatus, formatDataStatus, loadGapStats, clearGapStats, gapStatsPath } = await import("./knowgap.js")
      const cwd = process.cwd()
      const sub = (positional[1] || "status").toLowerCase()
      if (sub === "status") {
        const s = dataStatus(cwd)
        if (JSON_OUT) { emitJson(s); return }
        console.log(formatDataStatus(s))
        console.log(dim("  gaps: forge data gaps  •  reset gaps: forge data reset gaps"))
        return
      }
      if (sub === "gaps") {
        const g = loadGapStats(cwd)
        const domains = Object.values(g.domains || {})
        if (JSON_OUT) { emitJson({ project: g, count: domains.length }); return }
        if (!domains.length) {
          console.log(dim("no gap assessments stored for this project"))
          return
        }
        console.log(bold(`knowgap`) + dim(`  (${domains.length}) — ${gapStatsPath(cwd)}`))
        for (const d of domains.sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0)).slice(0, 16)) {
          console.log(`  ${bold(d.id)}  ${d.impact || "?"}  ${d.status || "?"}  ${dim(d.lifecycle || "")}  ${dim(d.evidence || "")}`)
        }
        return
      }
      if (sub === "reset") {
        const what = (positional[2] || "").toLowerCase()
        if (what !== "gaps") {
          err("forge data reset gaps  — only gap-domain reset is implemented (not cache / memory / all)")
          process.exit(1)
          return
        }
        clearGapStats(cwd)
        ok("cleared project knowgap.json")
        return
      }
      err(`unknown: forge data ${sub} — use status | gaps | reset gaps`)
      process.exit(1)
      return
    }
    case "tools": {
      // v20.5: the capability registry — what every tool IS, what the router
      // would choose for a task, and how a batch would be scheduled.
      const { createRegistry, registerPlugins, checkWriteClassification } = await loadCapabilities()
      const { BUILTIN_TOOL_NAMES } = await loadToolsMod()
      const reg = createRegistry({ config })
      if (config.tools?.plugins !== false) {
        try {
          const { loadToolPlugins } = await loadPlugins()
          const loaded = await loadToolPlugins(undefined, { reserved: BUILTIN_TOOL_NAMES })
          registerPlugins(reg, loaded.tools)
        } catch { /* best-effort */ }
      }
      const cwd = flags.cwd ? path.resolve(String(flags.cwd)) : process.cwd()

      // forge tools --route "task"  → the routing decision + the chain
      const routeTask = typeof flags.route === "string" ? flags.route : positional.slice(1).join(" ")
      if (flags.route !== undefined && routeTask) {
        const { route, describeRoute } = await loadRouter()
        const decision = route({ task: routeTask, registry: reg, context: { cwd }, constraints: { readOnly: flags["read-only"] === true } })
        if (JSON_OUT) { emitJson({ task: routeTask, ...decision, chain: { ...decision.chain, steps: decision.chain.steps } }); return }
        console.log(bold(`routing — ${routeTask}`))
        console.log(describeRoute(decision))
        return
      }

      // forge tools <name> → one capability card
      const one = positional[1] && positional[1] !== "list" ? positional[1] : null
      if (one === "download" || one === "verify") {
        err(`did you mean: forge tool ${one} …  (singular — DOWNLOAD ≠ live ~/.forge/tools)`)
        process.exit(1)
        return
      }
      if (one) {
        const m = reg.get(one)
        if (!m) { err(`unknown tool "${one}" — run ${cyan("forge tools")} to list them`); process.exit(1); return }
        if (JSON_OUT) { emitJson(m); return }
        console.log(bold(`${m.name}`) + dim(`  ${m.klass} • ${m.status}`))
        console.log(`  ${m.description}`)
        const row = (k, v) => console.log(`  ${dim(k.padEnd(22))} ${v}`)
        row("capabilities", m.capabilities.join(", "))
        row("classes", m.classes.join(", "))
        row("risk (baseline)", m.risk)
        row("read_only", String(m.read_only))
        row("reversible", String(m.reversible))
        row("parallel_safe", String(m.parallel_safe))
        row("idempotent", String(m.idempotent))
        row("requires_confirmation", String(m.requires_confirmation))
        row("requires_network", String(m.requires_network))
        row("requires_filesystem", String(m.requires_filesystem))
        row("timeout", `${m.timeout}s`)
        row("cost", `~${m.cost.latency}ms • ~${m.cost.tokens} tok • cpu ${m.cost.cpu}${m.cost.network ? " • network" : ""}`)
        row("verification_required", String(m.verification_required) + (m.verify_after.length ? ` (${m.verify_after.join(", ")})` : ""))
        if (m.preferred_for.length) { console.log(`  ${dim("preferred_for")}`); for (const x of m.preferred_for) console.log(`    ${green("+")} ${x}`) }
        if (m.avoid_when.length) { console.log(`  ${dim("avoid_when")}`); for (const x of m.avoid_when) console.log(`    ${yellow("-")} ${x}`) }
        return
      }

      // forge tools [--capability x] [--class READ] → the registry
      const filtered = reg.list({
        capability: typeof flags.capability === "string" ? flags.capability : undefined,
        klass: typeof flags.class === "string" ? String(flags.class).toUpperCase() : undefined,
      })
      if (JSON_OUT) {
        emitJson({ count: filtered.length, invariants: checkWriteClassification(reg), tools: filtered })
        return
      }
      console.log(bold(`capability registry (${filtered.length})`) + dim(`  intelligence=${config.tools?.intelligence !== false ? "on" : "off"} • verify=${config.tools?.verify !== false ? "on" : "off"}`))
      const badge = (m) =>
        m.status === "disabled" ? red("disabled") : m.status === "deprecated" ? yellow("deprecated") : m.status === "experimental" ? yellow("experimental") : green("enabled")
      const riskColor = (r) => (r === "critical" || r === "high" ? red(r) : r === "medium" ? yellow(r) : dim(r))
      for (const m of filtered) {
        console.log(
          `  ${cyan(m.name.padEnd(13))} ${dim(m.klass.padEnd(8))} ${riskColor(m.risk.padEnd(8))} ${m.read_only ? dim("read ") : yellow("write")} ${m.parallel_safe ? dim("∥") : " "} ${badge(m).padEnd(9)} ${dim(m.capabilities.slice(0, 3).join(", ").slice(0, 46))}`
        )
      }
      const problems = checkWriteClassification(reg)
      if (problems.length) for (const p2 of problems) console.log(`  ${red("✗")} ${p2}`)
      console.log(dim(`  ${cyan("forge tools <name>")} = full metadata • ${cyan('forge tools --route "task"')} = what the router would do • --json`))
      return
    }
    case "plugins": {
      // list user tool plugins from ~/.forge/tools. Learned playbooks are
      // data (indexLearnedPlugins, no plugin-host), not live tools.
      const { loadToolPlugins, PLUGINS_DIR } = await loadPlugins()
      const { BUILTIN_TOOL_NAMES } = await loadToolsMod()
      const { indexLearnedPlugins, learnedPluginsDir } = await loadExtend()
      const loaded = await loadToolPlugins(undefined, { reserved: BUILTIN_TOOL_NAMES })
      const playbooks = indexLearnedPlugins(process.cwd())
      const learnedDir = learnedPluginsDir(process.cwd())
      const { indexVerifiedToolPlaybooks } = await import("./skilldl.js")
      const downloaded = indexVerifiedToolPlaybooks()
      if (JSON_OUT) {
        emitJson({
          dir: PLUGINS_DIR,
          learned: learnedDir,
          tools: loaded.tools.map((t) => ({ name: t.name, readOnly: t.readOnly, description: t.def.function.description, source: t.source })),
          playbooks: playbooks.map((p) => ({
            name: p.name,
            isolated: true,
            readOnly: true,
            source: "learned",
            repair: p.repair || "",
            files: p.files || [],
            command: p.command || "",
          })),
          downloads: downloaded.map((p) => ({ name: p.name, source: "downloaded", playbook: true, description: p.description || "" })),
          errors: loaded.errors,
        })
        try { loaded.close?.() } catch { /* best-effort */ }
        return
      }
      console.log(bold(`tool plugins — ${PLUGINS_DIR}`))
      console.log(dim(`learned — ${learnedDir}`))
      if (!loaded.tools.length && !loaded.errors.length && !playbooks.length && !downloaded.length) {
        console.log(dim("  (none) — drop a *.mjs exporting { name, description, parameters, run } here to add a tool"))
      }
      for (const t of loaded.tools) {
        console.log(`  ${green("✓")} ${cyan(t.name.padEnd(24))} ${t.readOnly ? dim("[read-only] ") : ""}${dim(t.def.function.description.slice(0, 60))}  ${dim("(" + t.source + ")")}`)
      }
      for (const p of playbooks) {
        const hint = String(p.repair || p.description || "").slice(0, 60)
        console.log(`  ${dim("○")} ${cyan(p.name.padEnd(24))} ${dim("[playbook] ")}${dim(hint)}  ${dim("(learned)")}`)
      }
      for (const p of downloaded) {
        const hint = String(p.description || "").slice(0, 60)
        console.log(`  ${dim("○")} ${cyan(p.name.padEnd(24))} ${dim("[downloaded playbook] ")}${dim(hint)}`)
      }
      for (const e of loaded.errors) console.log(`  ${red("✗")} ${dim(e)}`)
      if (loaded.tools.length) console.log(dim(`  ${loaded.tools.length} plugin tool(s) available to the agent • disable all with: forge config set tools.plugins false`))
      if (playbooks.length) console.log(dim(`  ${playbooks.length} learned playbook(s) — data, not a live plugin-host spawn`))
      if (downloaded.length) console.log(dim(`  ${downloaded.length} verified download(s) — hostless, never ~/.forge/tools`))
      try { loaded.close?.() } catch { /* best-effort */ }
      return
    }
    case "mcp": {
      // v23: inspect Model Context Protocol servers configured under mcp.servers.
      //   forge mcp            list configured servers
      //   forge mcp tools      connect every server and list the tools it exposes
      //   forge mcp test <n>   connect one server and show its tools (diagnostic)
      const { configuredServers, connectServer, mcpToolsToPlugins, loadMcpTools } = await import("./mcp.js")
      const sub = (positional[1] || "list").toLowerCase()

      if (sub === "list") {
        const servers = configuredServers(config)
        const all = Object.entries(config.mcp?.servers || {})
        if (JSON_OUT) { emitJson({ servers: all.map(([name, s]) => ({ name, command: s.command, args: s.args ?? [], disabled: s.disabled === true })) }); return }
        console.log(bold("MCP servers — configured under mcp.servers"))
        if (!all.length) {
          console.log(dim("  (none) — add one with: forge config set mcp.servers.<name>.command <cmd>"))
          console.log(dim("  e.g. forge config set mcp.servers.fs.command npx  then set mcp.servers.fs.args ..."))
          return
        }
        for (const [name, s] of all) {
          const tag = s.disabled === true ? red("disabled") : green("enabled")
          console.log(`  ${cyan(name.padEnd(16))} ${tag}  ${dim([s.command, ...(s.args ?? [])].join(" ").slice(0, 70))}`)
        }
        console.log(dim(`  ${servers.length} enabled • inspect tools: forge mcp tools • test one: forge mcp test <name>`))
        return
      }

      if (sub === "test") {
        const name = positional[2]
        if (!name) { err("usage: forge mcp test <server-name>"); process.exit(1); return }
        const spec = config.mcp?.servers?.[name]
        if (!spec || !spec.command) { err(`no MCP server "${name}" with a command in config`); process.exit(1); return }
        console.log(dim(`connecting to MCP server ${bold(name)} — ${[spec.command, ...(spec.args ?? [])].join(" ")}`))
        let client
        try { client = await connectServer(name, spec, { timeoutMs: spec.timeoutMs }) }
        catch (e) { err(`could not connect: ${e.message}`); process.exit(1); return }
        try {
          const tools = mcpToolsToPlugins(client, await client.listTools())
          ok(`connected — ${client.serverInfo?.name ?? name}${client.serverInfo?.version ? " v" + client.serverInfo.version : ""} • ${tools.length} tool(s)`)
          for (const t of tools) console.log(`  ${green("✓")} ${cyan(t.name.padEnd(32))} ${dim(t.def.function.description.slice(0, 60))}`)
          if (JSON_OUT) emitJson({ server: name, serverInfo: client.serverInfo, tools: tools.map((t) => ({ name: t.name, description: t.def.function.description })) })
        } finally { client.close() }
        return
      }

      if (sub === "tools") {
        const res = await loadMcpTools(config)
        try {
          if (JSON_OUT) { emitJson({ tools: res.tools.map((t) => ({ name: t.name, description: t.def.function.description, source: t.source })), errors: res.errors }); return }
          console.log(bold("MCP tools — across all enabled servers"))
          if (!res.tools.length && !res.errors.length) { console.log(dim("  (none) — configure a server first: forge mcp")); return }
          for (const t of res.tools) console.log(`  ${green("✓")} ${cyan(t.name.padEnd(32))} ${dim(t.def.function.description.slice(0, 56))}`)
          for (const e of res.errors) console.log(`  ${red("✗")} ${dim(e)}`)
          console.log(dim(`  ${res.tools.length} tool(s) from ${res.clients.length} server(s)`))
        } finally { for (const c of res.clients) c.close() }
        return
      }

      err("usage: forge mcp [list|tools|test <name>]"); process.exit(1); return
    }
    case "lsp": {
      // v23: inspect Language Server Protocol servers configured under lsp.servers.
      //   forge lsp             list configured servers
      //   forge lsp test <file> resolve the server for <file>, open it, and show
      //                         its diagnostics (a real end-to-end check)
      const { serverForFile, connectServer, languageIdForFile, pathToUri } = await import("./lsp.js")
      const sub = (positional[1] || "list").toLowerCase()

      if (sub === "list") {
        const all = Object.entries(config.lsp?.servers || {})
        if (JSON_OUT) { emitJson({ servers: all.map(([name, s]) => ({ name, command: s.command, extensions: s.extensions ?? [], disabled: s.disabled === true })) }); return }
        console.log(bold("LSP servers — configured under lsp.servers"))
        if (!all.length) {
          console.log(dim("  (none) — add one, e.g.:"))
          console.log(dim("    forge config set lsp.servers.ts.command typescript-language-server"))
          console.log(dim('    forge config set lsp.servers.ts.args \'["--stdio"]\'  (then set lsp.servers.ts.extensions)'))
          return
        }
        for (const [name, s] of all) {
          const tag = s.disabled === true ? red("disabled") : green("enabled")
          console.log(`  ${cyan(name.padEnd(14))} ${tag}  ${dim((s.extensions ?? []).join(" "))}  ${dim([s.command, ...(s.args ?? [])].join(" ").slice(0, 50))}`)
        }
        return
      }

      if (sub === "test") {
        const file = positional[2]
        if (!file) { err("usage: forge lsp test <file>"); process.exit(1); return }
        const abs = path.resolve(String(file))
        if (!fs.existsSync(abs)) { err(`no such file: ${abs}`); process.exit(1); return }
        const found = serverForFile(config, abs)
        if (!found) { err(`no LSP server configured for ${path.extname(abs) || "this file type"} (forge lsp — to list)`); process.exit(1); return }
        console.log(dim(`connecting ${bold(found.name)} for ${path.basename(abs)} — ${[found.spec.command, ...(found.spec.args ?? [])].join(" ")}`))
        let client
        try { client = await connectServer(found.name, found.spec, { rootUri: pathToUri(process.cwd()) }) }
        catch (e) { err(`could not start language server: ${e.message}`); process.exit(1); return }
        try {
          const uri = pathToUri(abs)
          client.openDoc(uri, languageIdForFile(abs, found.spec), fs.readFileSync(abs, "utf8"))
          const diags = await client.diagnosticsFor(uri, 4000)
          ok(`connected — ${diags.length} diagnostic(s)`)
          for (const d of diags.slice(0, 50)) {
            const sev = ({ 1: red("error"), 2: yellow("warn"), 3: cyan("info"), 4: dim("hint") })[d.severity] || dim("note")
            console.log(`  ${sev} ${dim((d.range?.start?.line ?? 0) + 1 + ":" + ((d.range?.start?.character ?? 0) + 1))}  ${String(d.message).split("\n")[0].slice(0, 100)}`)
          }
          if (JSON_OUT) emitJson({ server: found.name, file: abs, diagnostics: diags })
        } finally { await client.close() }
        return
      }

      err("usage: forge lsp [list|test <file>]"); process.exit(1); return
    }
    case "embeddings": {
      // v23: inspect semantic retrieval (retrieval.embeddings).
      //   forge embeddings            resolved config + cache stats
      //   forge embeddings test ...  embed texts live, show dims/latency/cosine
      const { resolveEmbeddingsConfig, createEmbedder, embeddingCacheStats } = await import("./embeddings.js")
      const { cosineSimilarity } = await import("./retrieval.js")
      const sub = (positional[1] || "list").toLowerCase()
      const resolved = resolveEmbeddingsConfig(config)

      if (sub === "list") {
        if (JSON_OUT) {
          emitJson({ enabled: resolved.ok, reason: resolved.ok ? null : resolved.reason, provider: resolved.provider ?? null, model: resolved.model ?? null, alpha: resolved.alpha ?? null, cache: resolved.ok ? embeddingCacheStats(resolved.cachePath) : null })
          return
        }
        console.log(bold("Semantic retrieval — config under retrieval.embeddings"))
        if (!resolved.ok) {
          console.log(`  ${red("off")} — ${resolved.reason}`)
          console.log(dim("  enable: forge config set retrieval.embeddings.enabled true"))
          console.log(dim("  (BM25 stays the offline-safe default; embeddings only rerank BM25 shortlists)"))
          return
        }
        const cache = embeddingCacheStats(resolved.cachePath)
        console.log(`  ${green("on")}  provider ${cyan(resolved.provider)} • model ${cyan(resolved.model)} • alpha ${resolved.alpha}`)
        console.log(dim(`  endpoint ${resolved.baseUrl}/embeddings • batch ${resolved.batchSize} • timeout ${resolved.timeoutMs / 1000}s • rerank budget ${resolved.rerankBudgetMs / 1000}s`))
        console.log(dim(`  cache ${resolved.cachePath} — ${cache.entries} vector(s)${cache.dim ? `, dim ${cache.dim}` : ""}`))
        console.log(dim("  live check: forge embeddings test \"some text\" \"other text\""))
        return
      }

      if (sub === "test") {
        const texts = positional.slice(2)
        if (!texts.length) { err("usage: forge embeddings test <text> [more texts...]"); process.exit(1); return }
        if (!resolved.ok) { err(`embeddings not usable: ${resolved.reason}`); process.exit(1); return }
        const embedder = createEmbedder(resolved)
        // --json contract: exactly one JSON document, no human lines (test-json.mjs)
        if (!JSON_OUT) console.log(dim(`embedding ${texts.length} text(s) with ${resolved.provider}/${resolved.model}`))
        const t0 = Date.now()
        let vecs
        try { vecs = await embedder.embed(texts) }
        catch (e) { err(`embeddings request failed: ${e.message}`); process.exit(1); return }
        const dt = Date.now() - t0
        const s = embedder.stats()
        const pairs = []
        if (texts.length > 1) {
          for (let i = 0; i < texts.length; i++) {
            for (let j = i + 1; j < texts.length; j++) {
              pairs.push({ i: i + 1, j: j + 1, cosine: Number(cosineSimilarity(vecs[i], vecs[j]).toFixed(4)) })
            }
          }
        }
        if (JSON_OUT) { emitJson({ provider: resolved.provider, model: resolved.model, dim: vecs[0].length, latencyMs: dt, stats: s, pairs }); return }
        ok(`done in ${dt}ms — dim ${vecs[0].length} • ${s.hits} cache hit(s), ${s.requests} request(s)`)
        if (pairs.length) {
          console.log(dim("  cosine similarity (1.0 = identical direction):"))
          for (const p of pairs) {
            console.log(`  ${String(p.i)}↔${String(p.j)}  ${p.cosine >= 0 ? green(p.cosine.toFixed(3)) : red(p.cosine.toFixed(3))}  ${dim(`"${texts[p.i - 1].slice(0, 34)}" × "${texts[p.j - 1].slice(0, 34)}"`)}`)
          }
        }
        return
      }

      err("usage: forge embeddings [list|test <text> ...]"); process.exit(1); return
    }
    case "bench": {
      const { BENCH_CASES, runBench, formatReport } = await import("./bench.js")
      const list = flags.list === true || positional[1] === "list"
      if (list) {
        if (JSON_OUT) {
          emitJson({ version: VERSION, cases: BENCH_CASES.map((c) => ({ id: c.id, name: c.name })) })
          return
        }
        console.log(bold(`FORGE-BENCH v${VERSION}`) + dim("  12 progressive cases, no live model"))
        for (const c of BENCH_CASES) console.log(`  ${cyan(c.id.padEnd(22))} ${c.name}`)
        return
      }
      const summary = runBench()
      if (JSON_OUT) { emitJson(summary); process.exit(summary.failed ? 1 : 0); return }
      console.log(formatReport(summary))
      process.exit(summary.failed ? 1 : 0)
      return
    }
    case "claims": {
      const { listClaims, getClaim, formatClaims, claimsPath } = await import("./claims.js")
      const cwd = process.cwd()
      const subject = (positional[1] || "").trim()
      if (subject) {
        const c = getClaim(cwd, subject)
        if (JSON_OUT) { emitJson({ subject, claim: c }); return }
        if (!c) { err(`no claim for ${subject}`); process.exit(1); return }
        console.log(formatClaims([c], { subject }).trimEnd())
        return
      }
      const rows = listClaims(cwd)
      if (JSON_OUT) { emitJson({ path: claimsPath(cwd), count: rows.length, claims: rows }); return }
      console.log(bold(`claims`) + dim(`  ${claimsPath(cwd)}`))
      console.log(formatClaims(rows).trimEnd())
      return
    }
    case "decisions": {
      const { listDecisions, getDecision, recordDecision, formatDecisions, decisionsPath } = await import("./decisions.js")
      const cwd = process.cwd()
      const sub = (positional[1] || "").trim()
      if (sub === "add") {
        const title = positional[2]
        const reason = positional.slice(3).join(" ")
        if (!title || !reason) { err("usage: forge decisions add <title> <reason>"); process.exit(1); return }
        const r = recordDecision({ cwd, title, reason })
        if (JSON_OUT) { emitJson(r); if (!r.ok) process.exit(1); return }
        if (!r.ok) { err(r.error); process.exit(1); return }
        ok(`decision ${r.title} recorded`)
        return
      }
      if (sub) {
        const d = getDecision(cwd, sub)
        if (JSON_OUT) { emitJson({ title: sub, decision: d }); return }
        if (!d) { err(`no decision for ${sub}`); process.exit(1); return }
        console.log(formatDecisions([d]).trimEnd())
        return
      }
      const rows = listDecisions(cwd)
      if (JSON_OUT) { emitJson({ path: decisionsPath(cwd), count: rows.length, decisions: rows }); return }
      console.log(bold(`decisions`) + dim(`  ${decisionsPath(cwd)}`))
      console.log(formatDecisions(rows).trimEnd())
      return
    }
    case "knowledge": {
      const { listClaims } = await import("./claims.js")
      const { listDecisions, formatKnowledgePane } = await import("./decisions.js")
      const { loadGapStats } = await import("./knowgap.js")
      const { listDownloads } = await import("./skilldl.js")
      const cwd = process.cwd()
      const stats = loadGapStats(cwd)
      const pane = {
        claims: listClaims(cwd),
        decisions: listDecisions(cwd),
        gaps: { gaps: Object.values(stats.domains || {}) },
        downloads: listDownloads(),
      }
      if (JSON_OUT) { emitJson(pane); return }
      console.log(formatKnowledgePane(pane).trimEnd())
      return
    }
    case "experiment": {
      const { runExperiment, formatExperimentReport, benchmarkPlaybook } = await import("./experiment.js")
      const cwd = process.cwd()
      const sub = (positional[1] || "").trim()
      if (sub === "bench") {
        const playbook = positional.slice(2).join("\n")
        const r = benchmarkPlaybook({ playbook, repair: flags.repair || "" })
        if (JSON_OUT) { emitJson(r); return }
        console.log(`benchmark  winner=${r.winner}  playbook=${r.playbookScore}  repair=${r.repairScore}`)
        return
      }
      const id = sub
      if (!id) { err("usage: forge experiment <domain> [--command <cmd>] | forge experiment bench"); process.exit(1); return }
      const command = typeof flags.command === "string" ? flags.command : ""
      const r = runExperiment({ cwd, id, command, task: flags.task || `close knowledge gap ${id}` })
      if (JSON_OUT) { emitJson(r); if (!r.ok) process.exit(1); return }
      console.log(formatExperimentReport(r).trimEnd())
      if (!r.ok && !r.skipped) process.exit(1)
      return
    }
    case "empirics": {
      const { loadEmpirics, pickModelEmpiric, formatEmpiric } = await import("./empirics.js")
      const rows = pickModelEmpiric({ limit: 12 })
      if (JSON_OUT) { emitJson({ path: (await import("./empirics.js")).empiricPath(), items: loadEmpirics().items, pick: rows }); return }
      console.log(bold("model empirics") + dim("  (real outcomes, not the static registry)"))
      if (!rows.length) console.log(dim("  none yet — outcomes record after runs"))
      else console.log(formatEmpiric(rows))
      return
    }
    case "variant":
    case "variants": {
      const { authorVariant, listVariants, pickVariant, formatVariants, recordVariantOutcome } = await import("./variant.js")
      const sub = (positional[1] || "list").toLowerCase()
      const cwd = process.cwd()
      if (sub === "list") {
        const fam = positional[2] || null
        const rows = listVariants(cwd, fam)
        if (JSON_OUT) { emitJson({ variants: rows }); return }
        console.log(bold(`strategy variants (${rows.length})`) + dim("  family+strategy+version+fingerprint — siblings coexist"))
        if (!rows.length) console.log(dim("  none — forge variant add <family> <strategy> --repair \"…\""))
        for (const v of rows) {
          console.log(`  ${String(v.name).padEnd(36)} ${v.lifecycle || "CANDIDATE"}  ${v.strategy} v${v.version}  rate=${Math.round((v.rate || 0) * 100)}%`)
        }
        return
      }
      if (sub === "add") {
        const family = positional[2]
        const strategy = positional[3]
        const repair = typeof flags.repair === "string" ? flags.repair : positional.slice(4).join(" ")
        if (!family || !strategy || !repair) { err("usage: forge variant add <family> <strategy> --repair \"what worked\""); process.exit(1); return }
        const r = authorVariant({ cwd, family, strategy, repair, task: flags.task || "" })
        if (JSON_OUT) { emitJson(r); if (!r.ok) process.exit(1); return }
        if (!r.ok) { err(r.error); process.exit(1); return }
        ok(`variant ${r.name}  CANDIDATE  fp ${String(r.fingerprint).slice(0, 12)}…`)
        return
      }
      if (sub === "pick") {
        const task = positional.slice(2).join(" ") || "medium repair"
        const rows = pickVariant(task, { cwd })
        if (JSON_OUT) { emitJson({ task, variants: rows }); return }
        console.log(formatVariants(rows) || dim("  none"))
        return
      }
      if (sub === "score") {
        const name = positional[2]
        const pass = positional[3] !== "fail"
        if (!name) { err("usage: forge variant score <name> [ok|fail]"); process.exit(1); return }
        const rec = recordVariantOutcome({ cwd, name, ok: pass })
        if (!rec) { err(`unknown variant "${name}"`); process.exit(1); return }
        if (JSON_OUT) { emitJson(rec); return }
        ok(`scored ${name}  ${Math.round((rec.rate || 0) * 100)}% n=${rec.samples}`)
        return
      }
      err("unknown: forge variant — use list | add | pick | score")
      process.exit(1)
      return
    }
    case "knowtype":
    case "knowtypes": {
      const { recordKnowledge, listKnowledge, pickKnowledge, formatKnowtype, KTYPE } = await import("./knowtype.js")
      const sub = (positional[1] || "list").toLowerCase()
      const cwd = process.cwd()
      if (sub === "list") {
        const rows = listKnowledge(cwd, positional[2] || null)
        if (JSON_OUT) { emitJson({ items: rows }); return }
        console.log(bold(`typed knowledge (${rows.length})`) + dim("  FACT > EXPERIENCE > LESSON > HYPOTHESIS (unproven)"))
        if (!rows.length) console.log(dim("  none — forge knowtype add FACT|EXPERIENCE|LESSON|HYPOTHESIS <text>"))
        for (const r of rows) {
          const tag = r.type === KTYPE.HYPOTHESIS ? "HYPOTHESIS (unproven)" : r.type
          console.log(`  ${tag.padEnd(22)} ${r.text}`)
        }
        return
      }
      if (sub === "add") {
        const type = positional[2]
        const text = positional.slice(3).join(" ")
        if (!type || !text) { err("usage: forge knowtype add FACT|EXPERIENCE|LESSON|HYPOTHESIS <text> [--evidence …]"); process.exit(1); return }
        const r = recordKnowledge({ cwd, type, text, evidence: flags.evidence || "", source: "cli" })
        if (JSON_OUT) { emitJson(r); if (!r.ok) process.exit(1); return }
        if (!r.ok) { err(r.error); process.exit(1); return }
        const note = r.demoted ? " (FACT without evidence → HYPOTHESIS)" : ""
        ok(`${r.type} ${r.id}${note}`)
        return
      }
      if (sub === "pick") {
        const task = positional.slice(2).join(" ") || "medium repair"
        const rows = pickKnowledge(task, { cwd })
        if (JSON_OUT) { emitJson({ task, items: rows }); return }
        console.log(formatKnowtype(rows) || dim("  none"))
        return
      }
      err("unknown: forge knowtype — use list | add | pick")
      process.exit(1)
      return
    }
    case "roles": {
      const { roleCatalog } = await import("./agentmanager.js")
      const rows = roleCatalog()
      // v91 ULTIMATE — --crew prints the orchestration roster: which named
      // agent owns which phase, who may write (exactly one), and which roles
      // are deterministic (no model call).
      if (flags.crew === true) {
        const { rosterFor, formatRoster, singleWriterOk, phasesFor, approvalRequired } = await import("./orchestra.js")
        const klass = String(flags.class || "LARGE").toUpperCase()
        const crew = rosterFor(klass)
        if (JSON_OUT) { emitJson({ class: klass, crew, phases: phasesFor(klass), approvalRequired: approvalRequired(klass), singleWriter: singleWriterOk(crew) }); return }
        console.log(bold(`orchestration crew`) + dim(`  class ${klass} • ${crew.length} role(s) • approval ${approvalRequired(klass) ? "required" : "not required"}`))
        console.log(formatRoster(crew))
        const sw = singleWriterOk(crew)
        console.log(sw.ok ? dim(`  single writer: ${green(sw.writers[0])} — every other role is dispatched read-only`) : red(`  WRITER INVARIANT BROKEN: ${sw.writers.join(", ")}`))
        if (!sw.ok) process.exit(1)
        return
      }
      if (JSON_OUT) { emitJson({ roles: rows }); return }
      console.log(bold("agent roles"))
      for (const r of rows) console.log(`  ${r.role.padEnd(12)} ${r.readOnly ? "read-only" : "writer (main only)"}`)
      console.log(dim("  the orchestration roster (named agents per phase): forge roles --crew"))
      return
    }
    case "self-review": {
      // v91 ULTIMATE — deterministic static review (selfup.js). No model, no
      // network: the same tree always yields the same findings, so it is safe
      // to run before AND after an edit and diff the two.
      const { selfReview, formatSelfReview, CATEGORY } = await import("./selfup.js")
      const target = positional[1] ? path.resolve(positional[1]) : process.cwd()
      const r = selfReview({ cwd: target, maxFindings: Number(flags.limit) || 200 })
      if (JSON_OUT) { emitJson(r); return }
      console.log(bold(`self-review`) + dim(`  ${target}`))
      console.log(formatSelfReview(r, { limit: Number(flags.limit) || 40 }))
      const byCat = r.byCategory || {}
      console.log(dim(`  ${r.duplicates} duplicated block(s) • ${r.cycles.length} import cycle(s) • ${byCat[CATEGORY.DEAD_CODE] || 0} dead export(s) • ${byCat[CATEGORY.SECURITY] || 0} security smell(s) • ${byCat[CATEGORY.UNFINISHED] || 0} unfinished marker(s)`))
      console.log(dim(`  upgrade proposals from these findings: ${cyan("forge self-upgrade --plan")}`))
      return
    }
    case "self-upgrade": {
      // v91 ULTIMATE — evidence → proposal → reversible apply. A self-upgrade
      // never rewrites forge's own source: config, project memory and additive
      // files only, each with a recorded inverse (see selfup.js).
      const { selfReview, upgradePlan, applyUpgrades, formatUpgradePlan, listUpgrades, syntaxCheck } = await import("./selfup.js")
      const cwd = process.cwd()
      const review = selfReview({ cwd, maxFindings: 200 })
      const plan = upgradePlan({ cwd, review, config })
      const applied = listUpgrades(cwd).applied.map((a) => a.id)
      const doApply = flags.apply === true
      const dryRun = flags["dry-run"] === true
      if (JSON_OUT) {
        if (!doApply) { emitJson({ mode: "plan", review: { files: review.files, findings: review.totalFindings, bySeverity: review.bySeverity, cycles: review.cycles }, plan, applied }); return }
        const only = String(flags.only || "").split(",").map((x) => x.trim()).filter(Boolean)
        emitJson({ mode: dryRun ? "dry-run" : "apply", ...applyUpgrades({ cwd, plan, only: only.length ? only : null, dryRun }) })
        return
      }
      console.log(bold(`self-upgrade ${doApply ? (dryRun ? "(dry run)" : "(apply)") : "(plan)"}`))
      console.log(formatUpgradePlan(plan, { applied }))
      if (!doApply) {
        console.log(dim(`  apply the reversible ones: ${cyan("forge self-upgrade --apply")}   undo: ${cyan("forge rollback")}`))
        return
      }
      const only = String(flags.only || "").split(",").map((x) => x.trim()).filter(Boolean)
      const res = applyUpgrades({ cwd, plan, only: only.length ? only : null, dryRun })
      for (const r of res.results) {
        if (r.skipped) console.log(yellow(`  · ${r.id} skipped — ${r.skipped}`))
        else if (r.error) console.log(red(`  ✗ ${r.id} — ${r.error}`))
        else console.log(green(`  ✓ ${r.id}${r.dryRun ? " (dry run)" : ""}`))
      }
      // verification is part of the upgrade, not an afterthought
      if (!dryRun && res.results.some((r) => r.ok)) {
        const v = await syntaxCheck(path.dirname(new URL(import.meta.url).pathname))
        console.log(v.ok ? dim(`  verified: node --check on ${v.checked} module(s) — all parse`) : red(`  verification FAILED: ${v.failed.map((f) => `${f.file}: ${f.error}`).join("; ")}`))
        if (!v.ok) process.exitCode = 1
      }
      return
    }
    case "rollback": {
      // v91 ULTIMATE — undo applied self-upgrades from their recorded inverse.
      // (`forge undo` is the FILE rollback for agent edits; this one is for
      // self-upgrade changes.)
      const { rollbackUpgrades, listUpgrades } = await import("./selfup.js")
      const cwd = process.cwd()
      const id = flags.id ? String(flags.id) : (positional[1] || null)
      const res = rollbackUpgrades({ cwd, id, all: flags.all === true })
      if (JSON_OUT) { emitJson(res); if (!res.ok) process.exit(1); return }
      if (!res.undone.length) { warn(`nothing to roll back${id ? ` for "${id}"` : ""} — ${listUpgrades(cwd).applied.length} applied upgrade(s) on record`); return }
      for (const u of res.undone) console.log(u.ok ? green(`  ✓ rolled back ${u.id} — ${u.restored || "ok"}`) : red(`  ✗ ${u.id} — ${u.error}`))
      console.log(dim(`  ${res.remaining} applied upgrade(s) remain • manifest: ${res.manifest}`))
      if (!res.ok) process.exit(1)
      return
    }
    case "report": {
      // v91 ULTIMATE — the final report of an autonomous run (report.js).
      const { latestReport, loadReport, listReports, formatReport } = await import("./report.js")
      const cwd = process.cwd()
      const sub = (positional[1] || "").trim()
      if (sub === "list") {
        const { latestObjective, formatObjective } = await import("./objective.js")
        const rows = listReports(cwd)
        if (JSON_OUT) { emitJson({ reports: rows }); return }
        if (!rows.length) { warn("no reports yet — run an autonomous task first (forge agent --auto \"…\")"); return }
        console.log(bold(`reports`) + dim(`  (newest first)`))
        for (const r of rows) {
          console.log(`  ${cyan(String(r.id).padEnd(22))} ${String(r.status).padEnd(10)} ${String(r.pct + "%").padEnd(5)} ${r.gateOk ? green("gate ok") : yellow("gate open")}  ${dim(String(r.objective || "").slice(0, 60))}`)
          // the objective record behind the report: phases, pivots, blockers
          const o = latestObjective(cwd, r.taskId)
          if (o) console.log(dim(`      ${formatObjective(o)}`))
        }
        return
      }
      const rep = sub ? loadReport(sub, cwd) : latestReport(cwd)
      if (JSON_OUT) { emitJson({ report: rep }); if (!rep) process.exit(1); return }
      if (!rep) { warn("no report found — run an autonomous task first (forge agent --auto \"…\")"); return }
      console.log(formatReport(rep, { markdown: flags.markdown !== false }))
      return
    }
    case "docs": {
      // v91 ULTIMATE — documentation & git intelligence (docsintel.js): what the
      // current diff obliges you to document, plus a commit message and the
      // breaking-change list. The diff comes from the existing git_diff tool.
      const { parseUnifiedDiff, detectBreakingChanges, docPlan, commitMessage, formatDocPlan, changelogSection } = await import("./docsintel.js")
      const { makeToolContext, execTool } = await import("./tools.js")
      const { listSourceFiles } = await import("./selfup.js")
      const cwd = process.cwd()
      // docPlan decides "does this repo have a README/CHANGELOG?" from real
      // files, never from a guess.
      const listRepoFiles = (root) => listSourceFiles(root, { exts: new Set([".md", ".markdown", ".txt", ".js", ".mjs", ".json"]) })
      const base = String(flags.base || "HEAD")
      let diffText = ""
      if (flags.diff) { try { diffText = fs.readFileSync(String(flags.diff), "utf8") } catch (e) { err(`cannot read ${flags.diff}: ${e?.message ?? e}`); process.exit(1); return } }
      else {
        const ctx = makeToolContext({ cwd, root: cwd, readOnly: true, timeoutSec: 20, maxToolOutput: 400_000, signal: null, skillsDir: null })
        diffText = String(await execTool(ctx, "git_diff", { base, context: 3, max_lines: 4000 }) ?? "")
        if (/^(ERROR|BLOCKED|not a git)/i.test(diffText)) { err(diffText.split("\n")[0]); process.exit(1); return }
      }
      const parsed = parseUnifiedDiff(diffText)
      const breaking = detectBreakingChanges("", { diffParsed: parsed })
      const repoFiles = listRepoFiles(cwd)
      const plan = docPlan({ diffParsed: parsed, breaking, repoFiles, files: parsed.files.map((f) => f.path) })
      const commit = commitMessage({ objective: String(flags.message || "update"), diffParsed: parsed, breaking, files: parsed.files.map((f) => f.path) })
      if (JSON_OUT) { emitJson({ files: parsed.files.length, insertions: parsed.insertions, deletions: parsed.deletions, truncated: parsed.truncated, breaking, docPlan: plan, commit }); return }
      console.log(bold(`docs & git intelligence`) + dim(`  ${parsed.files.length} file(s) +${parsed.insertions}/-${parsed.deletions}${parsed.truncated ? " (diff truncated)" : ""} • base ${base}`))
      if (breaking.length) {
        console.log(red(`  ${breaking.length} BREAKING change(s):`))
        for (const b of breaking) console.log(`    ! ${b.kind} ${b.symbol ? cyan(b.symbol) : ""} ${dim(`(${b.file})`)} — ${b.why}`)
      } else console.log(dim("  no breaking changes detected"))
      console.log(formatDocPlan(plan, { commit }))
      const ver = (() => { try { return JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).version } catch { return "" } })()
      if (breaking.length || parsed.files.length) {
        console.log("")
        console.log(bold("  CHANGELOG section (ready to paste)"))
        console.log(changelogSection({ version: ver, title: "", changed: parsed.files.slice(0, 6).map((f) => `\`${f.path}\` (+${f.added}/-${f.removed})`), breaking }).trimEnd().split("\n").map((l) => `    ${l}`).join("\n"))
      }
      return
    }

    case "verify": {
      // v92 PROCREW — run the verification pipeline on demand: the same stages
      // an autonomous run executes before it may claim DONE (build, lint,
      // typecheck, test, validate), taken from THIS project's manifests. A stage
      // with no real command is reported skipped, never faked, and pass/fail is
      // decided by the same verifyledger rules the completion gate uses.
      const { planPipeline, runPipeline, formatPipeline, pipelineVerdict, PIPELINE_DEFAULTS } = await import("./pipeline.js")
      const cwd = process.cwd()
      const files = positional.slice(1).map(String)
      const only = String(flags.only || "").split(",").map((x) => x.trim()).filter(Boolean)
      const skip = String(flags.skip || "").split(",").map((x) => x.trim()).filter(Boolean)
      const plan = planPipeline({ cwd, files, only: only.length ? only : null, skip: skip.length ? skip : null })
      if (!plan.stages.length) {
        if (JSON_OUT) { emitJson({ ok: false, stages: [], skipped: plan.skipped }); process.exit(1); return }
        warn("no verification stage this project can run — nothing faked")
        for (const s of plan.skipped) console.log(dim(`  · ${s.id.padEnd(10)} ${s.reason}`))
        process.exit(1)
        return
      }
      const timeoutMs = Number(flags.timeout) || PIPELINE_DEFAULTS.timeoutMs
      if (!JSON_OUT) console.log(bold(`verification pipeline`) + dim(`  ${plan.stages.map((x) => x.id).join(" → ")}  (per-stage timeout ${Math.round(timeoutMs / 1000)}s)`))
      const res = await runPipeline({
        plan, cwd,
        opts: { timeoutMs, stopOnFailure: flags["fail-fast"] !== false, maxRepairs: 0 },
        onEvent: JSON_OUT ? null : (ev) => {
          if (ev.type === "PIPELINE_STAGE_STARTED") console.log(dim(`  ▶ ${ev.stage}: ${ev.command}`))
        },
      })
      if (JSON_OUT) {
        emitJson({
          ok: res.ok, ms: res.ms, verdict: pipelineVerdict(res),
          stages: res.stages.map((x) => ({ id: x.id, command: x.command, passed: x.passed, skipped: x.skippedRun === true, exitCode: x.exitCode ?? null, failureShape: x.failureShape || null, attempts: x.attempts || 1, evidence: x.evidence || "" })),
          skipped: plan.skipped.map((x) => ({ id: x.id, reason: x.reason })),
        })
        process.exit(res.ok ? 0 : 1)
        return
      }
      console.log(formatPipeline(res))
      process.exit(res.ok ? 0 : 1)
      return
    }

    default:
      err(`unknown command "${cmd}"`)
      printHelp()
      process.exit(1)
  }
}

// v20.2 (P2-6): FORGE_DEBUG=1 prints a compact per-run tool breakdown to stderr.
function debugRunSummary(res) {
  if (process.env.FORGE_DEBUG !== "1" || !res) return
  const counts = {}
  for (const t of res.toolLog ?? []) counts[t.name] = (counts[t.name] || 0) + 1
  const breakdown = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join(" ")
  console.error(dim(`  [debug] steps=${res.steps} toolCalls=${res.toolLog?.length ?? 0} runId=${res.runId ?? "-"} wrote=${!!res.wrote}${breakdown ? " • " + breakdown : ""}`))
  // v20.5: what the tool intelligence layer actually did this run
  const t = res.toolStats
  if (t) {
    const fails = Object.entries(t.byFailure ?? {}).map(([k, v]) => `${k}×${v}`).join(" ")
    console.error(dim(`  [debug] tools: ok=${t.ok} failed=${t.failed} blocked=${t.blocked} cached=${t.cached} verified=${t.verified}${t.verifyFailed ? ` verifyFailed=${t.verifyFailed}` : ""}${fails ? " • " + fails : ""}`))
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
  ${cyan('forge agent "fix the bug"')}    coding agent — auto-uses all 22 tools (bash, files, images, browser, web, git views, memory, sub-agents)
  ${cyan('forge agent --auto "task"')}    full autonomous lifecycle ${dim("(segment loop, DAG, model strategy, verification ledger, repair, recovery)")}
  ${cyan("forge --yolo …")}            FULL CONTROL — all guards off, zero permission pauses ${dim("(tools.autoApprove in ~/.forge/config.json makes it permanent)")}
  ${cyan('forge agent --plan "task"')}    plan first (read-only), confirm, then execute ${dim("(plan saved to .forge/plans/)")}
  ${cyan("forge plan list|show|apply")}   review a saved plan, or execute one later: ${cyan("forge plan apply <n|slug>")}
  ${cyan("forge undo")}                   restore files changed by the last tool edit ${dim("(--run = roll back the whole last agent run)")}
  ${cyan("forge tasks")}                  list autonomous tasks (state/DAG/segments) ${dim("(--resume <id> continue an interrupted one, --json)")}
  ${cyan("forge onboard")}                setup wizard (provider → model → API key → verify, saved at every step)
  ${cyan("forge config")}                 interactive config menu (add provider / model / key / test)
  ${cyan("forge config show|path|get|set|unset")}
  ${cyan("forge doctor")}                 connectivity + latency check   ${dim("--all = every provider  --tools = self-test all 22 tools")}
  ${cyan("forge sessions")}               list saved conversations ${dim("(--search \"text\" to find one; store auto-capped at 300)")}
  ${cyan("forge skills [--check]")}        list skills, or --check to validate them (names, descriptions, links)
  ${cyan("forge skill download <url>")}    download a skill to ~/.forge/skill-downloads (CANDIDATE only — DOWNLOAD ≠ VERIFY)
  ${cyan("forge skill verify <name|all>")}  structurally verify a downloaded skill (pass → VERIFIED, fail → INACTIVE)
  ${cyan("forge skill promote <name>")}   human override VERIFIED → ACTIVE
  ${cyan("forge skill autopromote <name>")}  ACTIVE only if every gate passes ${dim("never on download/structural")}
  ${cyan("forge skill caps <name>")}      extract reusable capabilities from SKILL.md
  ${cyan("forge skill benchmark <name>")}  measured rates from evidence ${dim("UNKNOWN when structural only")}
  ${cyan("forge skill learn <name>")}      extract procedures from a VERIFIED skill (indexing is not learned)
  ${cyan("forge skill ttl <name> [<ms>]")} per-skill TTL override (ms); omit ms to print
  ${cyan("forge tool download <url>")}     download a tool to ~/.forge/tool-downloads (CANDIDATE, never ~/.forge/tools)
  ${cyan("forge tool verify <name|all>")}   structurally verify a downloaded tool (hostless playbook, never plugin-host)
  ${cyan("forge memory")}                 inspect long-term memory   ${dim("list | add \"note\" | forget <n> | clear | prune   (--project / --all)")}
  ${cyan("forge data")}                   Forge-owned data root      ${dim("status | gaps | reset gaps   (FORGE_HOME / ~/.forge, never the user project)")}
  ${cyan("forge claims [subject]")}       per-claim subject store    ${dim("~/.forge/projects/<hash>/claims.json — not a second memory")}
  ${cyan("forge decisions [add]")}        architecture decision log  ${dim("~/.forge/projects/<hash>/decisions.json")}
  ${cyan("forge knowledge")}              knowledge pane             ${dim("claims + decisions + gaps + downloads")}
  ${cyan("forge skill ingest <path>")}     ZIP / folder / SKILL.md → CANDIDATE ${dim("(extracts SKILL.md only; DOWNLOAD ≠ TRUST)")}
  ${cyan("forge variant list")}           strategy variants ${dim("family + strategy + version + fingerprint")}
  ${cyan("forge knowtype list")}          typed knowledge ${dim("FACT | EXPERIENCE | LESSON | HYPOTHESIS — hypothesis is never a fact")}
  ${cyan("forge variant add <fam> <s>")}  author a CANDIDATE sibling ${dim("--repair \"…\"  never overwrites ACTIVE")}
  ${cyan("forge roles")}                  multi-agent roles ${dim("planner is read-only; one writer")}
  ${cyan("forge roles --crew")}           orchestration roster ${dim("(named agent per phase, exactly one writer; --class LARGE)")}

${bold("autonomous intelligence (v91 ULTIMATE)")}
  ${cyan("forge self-review")}            deterministic static review ${dim("(duplicates, dead exports, import cycles, hotspots, security smells, TODO/FIXME; --json)")}
  ${cyan("forge self-upgrade --plan")}    evidence -> reversible proposals ${dim("(impact, risk, verify command)")}
  ${cyan("forge self-upgrade --apply")}   apply them through a versioned manifest ${dim("(config/memory/additive files only - never forge's own source; --dry-run, --only id,id)")}
  ${cyan("forge rollback")}               undo the last self-upgrade from its recorded inverse ${dim("(--all, --id <id>; forge undo = file rollback)")}
  ${cyan("forge report [id]")}            the final report of an autonomous run ${dim("(analysis -> findings -> plan -> progress -> verification -> files -> bugs -> perf -> remaining -> next; report list)")}
  ${cyan("forge verify")}                 run the verification pipeline ${dim("(build -> lint -> typecheck -> test -> validate, from this project's manifests; --only test, --skip lint, --timeout <ms>, --json; exit 1 on failure)")}
  ${cyan("forge docs")}                   docs & git intelligence ${dim("(breaking changes, README/CHANGELOG/API/migration deltas, commit message; --base <ref>, --diff <file>)")}
  ${cyan("forge experiment <domain>")}    hypothesis → focused test → recordGapOutcome ${dim("--command <cmd>  (never invents npm test)")}
  ${cyan("forge embeddings")}             semantic retrieval (BM25+embeddings hybrid) status ${dim("(enable: forge config set retrieval.embeddings.enabled true)")}
  ${cyan("forge bench")}                  FORGE-BENCH — 16 deterministic eval cases, no live model ${dim("(--list, --json)")}
  ${cyan("forge plugins")}                list user tool plugins from ~/.forge/tools ${dim("(*.mjs → agent tools; learned playbooks listed, not hosted)")}
  ${cyan("forge tools")}                   capability registry: risk, read/write, parallel-safety, verification ${dim('(--route "task", <name>, --json)')}
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

${bold("resilience")}
  ${cyan("forge config set failover true")}  agent AND chat fall through to the next configured provider on outages ${dim("(or FORGE_FAILOVER=1)")}
  ${cyan("forge memory")}                  curate long-term memory: list | add | forget <n> | clear | prune

${bold("flags")}
  --provider <name>  --model <id>  --key <api-key>  --base-url <url>  --deep  --pick  --profile <p>
  --json (machine-readable output: sessions/models/plugins/skills --check/memory list)  •  FORGE_DEBUG=1 (agent trace)
  --config <path>    --cwd <dir> (agent)  --plan (agent)  --continue  --resume <n|id>  -m "message"  --no-color

${bold("config file")}  ${USER_CONFIG_PATH}  (chmod 600, env vars as fallback)
${bold("providers")}     ${CATALOG.map((c) => c.name).join(", ")}
${bold("custom provider")}  ${cyan("forge provider add <name> <https://baseUrl>")} ${dim("[--model m] [--key k] [--protocol openai|anthropic]")}
              auto-discovers models, probes, records health → first-class provider
              ${cyan("forge provider test [name]")}  ${cyan("forge provider set-key <name> <KEY>")}  ${cyan("forge provider remove <name>")}
              env keys join failover after a green probe (forge provider test)
${bold("uninstall")}     ${cyan("npm uninstall -g forge-agent-cli")}
`)
}

main().catch((e) => {
  err(e?.message ?? String(e))
  process.exit(1)
})
