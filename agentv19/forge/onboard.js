/**
 * forge — onboarding wizard + interactive config menu (zero dependencies)
 *
 * v17 "SMARTSTART" rewrite. The v16 wizard had a fatal gap on Termux/proot:
 * hand-rolled raw-mode hidden input could die silently and nothing was saved
 * (users saw "config: missing" in doctor). v17 fixes this structurally:
 *
 *   1. NEW STEP ORDER   provider → base URL (custom) → model → API key →
 *                       verify → skills → done   (key LAST, right before verify)
 *   2. SAFE HIDDEN INPUT  muted-output readline — no raw-mode handoff at all
 *   3. INCREMENTAL SAVE  config is written after EVERY step; an interruption
 *                       can never again leave "config missing"
 *   4. TOP-LEVEL GUARD   the whole wizard is wrapped; errors print the failed
 *                       step + everything entered so far is kept
 *   5. API DOCS INLINE   per-provider "get a key" URL + env var name
 *   6. ANY MODEL         tested ★ defaults + your recent models + live list
 *                       (when a key is known) — free-typed ids always accepted
 *   7. SMART CUSTOM URL  typing a provider NAME (e.g. "openrouter") auto-fills
 *                       its real endpoint; scheme-less hosts get https://
 *   8. VERIFY LOOP       probe with [r]etry/[u]rl/[k]ey/[m]odel/[s]ave/[q]uit
 *                       — no dead ends, no silent failures
 *
 * v18 "FREESTART":
 *   9. FREE FIRST       choosing OpenRouter auto-detects ALL free models via
 *                       the PUBLIC /models endpoint (no key needed) and lists
 *                       them at the TOP with a FREE badge + context size.
 *                       Fallback chain: live → models-cache.json → curated
 *                       offline list → manual entry. Never stalls, never fails.
 *  10. MANUAL ENTRY     the picker ends with an explicit "enter a model id
 *                       manually" line for EVERY provider (v17 accepted
 *                       free-typed ids; v18 makes the option discoverable).
 */
import readline from "node:readline/promises"
import { saveConfig, maskKey, USER_CONFIG_PATH, pushRecentModel, safeView } from "./config.js"
import { CATALOG, getCatalog, envKeyFor, listModels, listOpenRouterModels, OPENROUTER_FREE_FALLBACK, probe } from "./providers.js"
import { writeModelCache, freeFromCache } from "./modelcache.js"
import { resolveSkillsDir, indexSkills } from "./skills.js"
import { recordHealth } from "./health.js"
import { bold, dim, cyan, green, yellow, magenta, info, ok, warn, err } from "./ui.js"

// ---------------------------------------------------------------------------
// piped (non-TTY) input support — slurp stdin once, lazily, with a short grace
// timer so an inherited-but-empty pipe never blocks interactive use
// ---------------------------------------------------------------------------
function slurpStdin(ms = 400) {
  return new Promise((resolve) => {
    const chunks = []
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { process.stdin.pause() } catch {}
      try { process.stdin.removeAllListeners("data") } catch {}
      try { process.stdin.removeAllListeners("end") } catch {}
      resolve(Buffer.concat(chunks).toString("utf8"))
    }
    const timer = setTimeout(finish, ms)
    process.stdin.once("end", finish)
    process.stdin.on("data", (c) => chunks.push(c))
    process.stdin.resume()
  })
}

let PIPED_LINES = null

async function initPipedLines() {
  if (process.stdin.isTTY) { PIPED_LINES = null; return }
  const raw = await slurpStdin(400)
  const lines = raw.split("\n")
  if (lines.length && lines[lines.length - 1] === "") lines.pop()
  PIPED_LINES = raw.length > 0 ? lines : null
}

// ---------------------------------------------------------------------------
// primitive prompts
// ---------------------------------------------------------------------------
async function ask(rl, q, fallback) {
  const suffix = fallback !== undefined && fallback !== "" ? dim(` [${fallback}]`) : ""
  process.stdout.write(cyan("?") + " " + q + suffix + " ")
  let a
  if (PIPED_LINES) {
    a = PIPED_LINES.length ? PIPED_LINES.shift() : null
    process.stdout.write((a ?? "") + "\n")
  } else {
    a = await rl.question("")
  }
  if (a === null) throw new Error("input ended — run `forge onboard` again (progress is saved automatically)")
  return a
}

/** Hidden input WITHOUT raw-mode handoff: temporarily mute stdout so readline's
 *  keystroke echo disappears. Identical behaviour on Termux/proot/SSH/Windows —
 *  the v16 raw-mode version is what died silently on the user's device. */
async function askHidden(rl, q) {
  process.stdout.write(cyan("? ") + q + dim(" (input hidden — paste, then Enter) ") + " ")
  if (PIPED_LINES) {
    const a = PIPED_LINES.length ? PIPED_LINES.shift() : null
    process.stdout.write(a === null ? "(end)\n" : "*".repeat(Math.min(a.length, 12)) + "\n")
    if (a === null) throw new Error("input ended — run `forge onboard` again (progress is saved automatically)")
    return a
  }
  if (!process.stdin.isTTY) {
    const line = await ask(rl, "")
    return String(line ?? "").trim()
  }
  const orig = process.stdout.write.bind(process.stdout)
  let muted = true
  process.stdout.write = (chunk, ...rest) => {
    if (!muted) return orig(chunk, ...rest)
    const s = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)
    if (s === "\n" || s === "\r\n") return orig(chunk, ...rest) // let the final Enter land
    return true // swallow echoed keys / control sequences
  }
  try {
    const a = await rl.question("")
    muted = false
    return String(a ?? "")
  } finally {
    muted = false
    process.stdout.write = orig
    orig("\n")
  }
}

async function pickFromList(rl, title, items, format) {
  console.log()
  console.log(bold(title))
  items.forEach((it, i) => console.log(`  ${bold(String(i + 1).padStart(2))}. ${format(it)}`))
  while (true) {
    const a = await ask(rl, `pick 1-${items.length} (name or number)`)
    const t = String(a ?? "").trim()
    if (!t) continue
    const n = parseInt(t, 10)
    if (!Number.isNaN(n) && n >= 1 && n <= items.length) return items[n - 1]
    const byName = items.find((it) => it.name === t || (it.label ?? "").toLowerCase() === t.toLowerCase())
    if (byName) return byName
    err(`unknown choice "${t}"`)
  }
}

/** All selectable providers: catalog + any custom entries already in config. */
function allProviders(config) {
  const customs = Object.entries(config.providers || {})
    .filter(([n]) => !getCatalog(n))
    .map(([name, c]) => ({
      name,
      label: String(c.baseUrl || "custom"),
      protocol: c.protocol || "openai",
      baseUrl: c.baseUrl || "",
      envKey: "",
      needsKey: true,
      models: Array.isArray(c.models) ? c.models : [],
      keyUrl: "",
    }))
  return [...CATALOG.map((c) => ({ ...c })), ...customs]
}

async function pickProvider(rl, config, { configuredOnly = false } = {}) {
  let items = allProviders(config)
  if (configuredOnly) {
    items = items.filter((c) => config.providers?.[c.name]?.apiKey || (c.envKey && process.env[c.envKey]) || !c.needsKey)
    if (!items.length) { err("no configured providers yet — pick from the full list instead"); items = allProviders(config) }
  }
  const detected = (p) => {
    const hasKey = config.providers?.[p.name]?.apiKey
      ? green("key set ✓")
      : (p.envKey && process.env[p.envKey] ? green(`env ${p.envKey} ✓`) : "")
    return `${bold(p.name.padEnd(15))} ${dim(p.label.padEnd(26))} ${hasKey}`
  }
  return await pickFromList(rl, bold("Choose a provider:"), items, detected)
}

/** Base URL with the v17 smart handling:
 *  - typing a known provider NAME auto-fills its real endpoint (the v16 field
 *    screenshot bug: user answered "Openrouter" where a URL was expected)
 *  - scheme-less hosts get https:// prefixed
 *  - garbage is re-asked with a concrete example */
async function askBaseUrl(rl, prov, current) {
  if (prov.name !== "custom" && current) return current
  while (true) {
    const a = String(await ask(rl, "base URL (OpenAI-compatible)", current || undefined) ?? "").trim()
    if (!a && current) return current
    if (!a) { err("a base URL is required for a custom provider"); continue }
    const byName = CATALOG.find((c) => c.baseUrl && (c.name === a.toLowerCase() || c.label.toLowerCase() === a.toLowerCase() || c.name === a.toLowerCase().replace(/\s+/g, "-")))
    if (byName) { ok(`→ ${byName.name} endpoint: ${byName.baseUrl}`); return byName.baseUrl }
    let u = a
    if (!/^https?:\/\//i.test(u)) {
      if (/^[\w.-]+\.\w{2,}(:\d+)?(\/\S*)?$/.test(u)) { u = "https://" + u; ok(`→ assuming ${u}`) }
      else { err(`that is not a URL — example: ${cyan("https://api.example.com/v1")} — or just type a provider name like ${cyan("openrouter")}`); continue }
    }
    return u.replace(/\/+$/, "")
  }
}

/** v18: free-model detection for a provider.
 *  OpenRouter's /models endpoint is PUBLIC — detection needs NO key and runs
 *  BEFORE the key step. Fallback chain (never fails, never stalls):
 *    live fetch → models-cache.json → curated offline list
 *  Returns { entries, source: "live"|"cached"|"offline" } (entries may be []). */
async function detectFreeEntries(prov, { baseUrl, apiKey } = {}) {
  if (prov.name !== "openrouter") return { entries: [], source: "none" }
  const base = baseUrl || prov.baseUrl || ""
  info(`detecting free models from ${base || "openrouter"}…`)
  const r = await listOpenRouterModels({ baseUrl: base, apiKey })
  if (r.live && r.free.length) {
    writeModelCache("openrouter", r.all) // remember for offline + SmartStart badges
    ok(`${r.free.length} free models detected (of ${r.total} total) — listed first below`)
    return { entries: r.free, source: "live" }
  }
  const cached = freeFromCache("openrouter")
  if (cached.length) {
    warn(`live detection unavailable (${r.warning ?? "offline"}) — using last cached list`)
    return { entries: cached, source: "cached" }
  }
  warn(`live detection unavailable (${r.warning ?? "offline"}) — showing built-in free suggestions`)
  return { entries: OPENROUTER_FREE_FALLBACK, source: "offline" }
}

/** Model picker (v18): FREE models first (OpenRouter), then ★ tested defaults,
 *  ● your recent models, live list when a key is known — and the picker ALWAYS
 *  ends with an explicit manual-entry line; free-typed ids are still accepted. */
async function pickModel(rl, prov, { recents = [], apiKey = "", baseUrl = "", freeEntries = [] } = {}) {
  const tested = (prov.models ?? []).filter(Boolean)
  const recent = (Array.isArray(recents) ? recents : []).filter((m) => m && !tested.includes(m))
  const free = (freeEntries || []).filter((m) => m && m.id && !tested.includes(m.id) && !recent.includes(m.id))
  let live = []
  if (apiKey && baseUrl) {
    info(`fetching live model list from ${prov.name}…`)
    const r = await listModels({ protocol: prov.protocol, baseUrl, apiKey, catalog: prov })
    if (r.live) {
      live = (r.models || []).filter((m) => !tested.includes(m) && !recent.includes(m) && !free.some((f) => f.id === m))
      ok(`${r.models.length} models available (live)`)
      if (r.entries?.length) writeModelCache(prov.name, r.entries)
    } else {
      warn(`live list unavailable (${r.warning}) — showing built-in suggestions`)
    }
  }
  const items = [
    ...free.map((m) => ({ m: m.id, kind: "free", meta: m })),
    ...tested.map((m) => ({ m, kind: "tested" })),
    ...recent.map((m) => ({ m, kind: "recent" })),
    ...live.slice(0, 12).map((m) => ({ m, kind: "live" })),
  ]
  const askManual = async () => {
    while (true) {
      const id = String(await ask(rl, `model id for ${prov.name} (any format, e.g. vendor/model:variant)`) ?? "").trim()
      if (id) return id
      err("a model id is required")
    }
  }
  if (!items.length) return await askManual()
  console.log()
  console.log(bold(`Choose a model for ${prov.name} — pick a number, [m] manual, or type ANY model id:`))
  items.forEach((it, i) => {
    let badge
    if (it.kind === "free") {
      const ctx = it.meta?.context ? dim(` · ~${Math.round(it.meta.context / 1000)}k tok`) : ""
      const nm = it.meta?.name ? dim(` · ${it.meta.name}`) : ""
      badge = green("FREE") + ctx + nm
    } else if (it.kind === "tested") badge = green("★ tested default")
    else if (it.kind === "recent") badge = cyan("● your recent")
    else badge = dim("live")
    console.log(`  ${bold(String(i + 1).padStart(2))}. ${it.m.padEnd(42)} ${badge}`)
  })
  console.log(`  ${bold(" m")}. enter a model id manually ${dim("(any custom id — validated non-empty)")}`)
  while (true) {
    const a = String(await ask(rl, `pick 1-${items.length}, m = manual, or type any model id`) ?? "").trim()
    if (!a) continue
    if (/^(m|manual)$/i.test(a)) return await askManual()
    const n = parseInt(a, 10)
    if (!Number.isNaN(n) && n >= 1 && n <= items.length) return items[n - 1].m
    return a // free text — ANY model id works
  }
}

/** API key step (v17: comes AFTER model, right before verify) with inline docs. */
async function askApiKey(rl, prov, config) {
  const conf = config.providers?.[prov.name] ?? {}
  let apiKey = envKeyFor(prov.name) || ""
  if (apiKey) ok(`using ${prov.envKey} from environment (${maskKey(apiKey)})`)
  if (!apiKey && conf.apiKey) {
    const reuse = String(await ask(rl, `reuse saved key ${maskKey(conf.apiKey)}? (Y/n)`) ?? "").trim().toLowerCase()
    if (reuse !== "n") apiKey = conf.apiKey
  }
  if (!apiKey && prov.needsKey) {
    if (prov.keyUrl) console.log(`  ${dim("get a key:")} ${cyan(prov.keyUrl)}`)
    if (prov.envKey) console.log(`  ${dim("or export:")} ${cyan(`${prov.envKey}=<your-key>`)}`)
    const want = String(await ask(rl, `enter ${prov.label} API key now? (Y/n)`, "Y") ?? "").trim().toLowerCase()
    if (want === "n") {
      warn(`skipped — set later with: ${cyan(`forge config set providers.${prov.name}.apiKey <KEY>`)} or /key in chat`)
    } else {
      apiKey = String(await askHidden(rl, "API key:") ?? "").trim()
      if (!apiKey) warn("empty key — this provider will not work until a key is set")
    }
  }
  if (!apiKey && !prov.needsKey) apiKey = "not-needed"
  return apiKey
}

function diagFor(r, prov, model) {
  const status = r.status
  if (status === 401 || status === 403) return `API key rejected by ${prov.name}${prov.keyUrl ? ` — get/check a valid key: ${cyan(prov.keyUrl)}` : ""}`
  if (status === 404) return `model "${model}" not found or wrong base URL — run ${cyan("forge models")} for valid ids`
  if (status === 402) return `quota/billing exhausted on ${prov.name} — top up or switch key`
  if (status === 429) return "rate limited — the key WORKS, quota is hit (safe to save and retry later)"
  if (status && status >= 500) return "provider server error (transient — retry usually fixes it)"
  return `cannot reach ${prov.baseUrl || "(no url)"} — ${r.error ?? "check URL / internet"}`
}

/** One probe + recovery menu. Returns {ok, action?, ms?}. */
async function verifyOnce(rl, { prov, baseUrl, apiKey, model }) {
  info(`probing ${prov.name} (${model || "(no model)"})…`)
  const r = await probe({ protocol: prov.protocol, baseUrl, apiKey, model: model || (prov.models?.[0] ?? "unknown") })
  if (r.ok) {
    ok(`connection OK — first response in ${r.ms}ms`)
    return { ok: true, ms: r.ms }
  }
  err(`probe failed${r.status ? ` (HTTP ${r.status})` : ""}: ${diagFor(r, { ...prov, baseUrl }, model)}`)
  return { ok: false }
}

// ---------------------------------------------------------------------------
// wizard core — runs the FULL provider setup and SAVES AFTER EVERY STEP
// ---------------------------------------------------------------------------
export async function wizardProviderSteps(rl, config, prov) {
  // v17: mutate the PASSED config directly and save after EVERY step — if
  // anything throws mid-wizard, the catch handler saves an object that already
  // contains every completed step (the v16 clone approach lost them).
  config.providers = config.providers || {}
  const entry = (config.providers[prov.name] = { ...(config.providers[prov.name] || {}) })

  const save = () => {
    try {
      config.activeProvider = prov.name
      return saveConfig(config)
    } catch (e) {
      warn(`could not save progress (${e?.message ?? e}) — continuing`)
      return null
    }
  }

  // 1. base URL (custom / missing only)
  let baseUrl = entry.baseUrl || prov.baseUrl || ""
  baseUrl = await askBaseUrl(rl, prov, baseUrl)
  entry.baseUrl = baseUrl
  save()

  // 2. model (BEFORE the key — suggestions come from catalog + your recents;
  //    live fetch happens automatically when an env key already exists).
  //    v18: OpenRouter gets free-model detection FIRST (public endpoint, no
  //    key needed) — free models are listed at the top of the picker.
  let freeEntries = []
  if (prov.name === "openrouter") {
    const det = await detectFreeEntries(prov, { baseUrl, apiKey: envKeyFor(prov.name) || "" })
    freeEntries = det.entries
  }
  let model = await pickModel(rl, prov, { recents: entry.models, apiKey: envKeyFor(prov.name) || "", baseUrl, freeEntries })
  entry.model = model
  pushRecentModel(config, prov.name, model)
  save()

  // 3. API key (LAST — with get-a-key docs inline)
  let apiKey = await askApiKey(rl, prov, config)
  entry.apiKey = apiKey || ""
  save()

  // 4. verify + recovery loop — no dead ends
  let verified = false
  if (!apiKey && prov.needsKey) {
    warn("no key yet — skipping the live probe (run `forge doctor` after setting one)")
  } else {
    const wantTest = String(await ask(rl, `test connection to ${prov.name} now? (Y/n)`, "Y") ?? "").trim().toLowerCase()
    if (wantTest === "n") {
      warn("skipped — run `forge doctor` to probe later")
    } else {
      while (true) {
        const v = await verifyOnce(rl, { prov, baseUrl, apiKey, model })
        if (v.ok) {
          verified = true
          recordHealth(prov.name, { ok: true, ms: v.ms, model, baseUrl })
          break
        }
        const a = String(await ask(rl, "[r]etry  [u]rl  [k]ey  [m]odel  [s]ave anyway  [q]uit — choose", "r") ?? "").trim().toLowerCase()
        if (a === "u") baseUrl = await askBaseUrl(rl, prov, baseUrl)
        else if (a === "k") apiKey = String(await askHidden(rl, "API key:") ?? "").trim()
        else if (a === "m") model = await pickModel(rl, prov, { recents: entry.models, apiKey, baseUrl })
        else if (a === "q" || a === "n") { warn("progress saved — rerun `forge` or `forge onboard` anytime"); break }
        else if (a !== "r") break // s / y / enter → save anyway
        entry.apiKey = apiKey
        entry.baseUrl = baseUrl
        entry.model = model
        save()
      }
    }
  }

  entry.apiKey = apiKey || ""
  entry.baseUrl = baseUrl
  entry.model = model
  save()
  return config
}

// ---------------------------------------------------------------------------
// SIGINT guard for wizard scopes — graceful exit with progress kept
// ---------------------------------------------------------------------------
function wizardSigint() {
  const h = () => {
    console.log()
    warn("setup cancelled — everything entered so far is saved; run `forge` to continue")
    process.exit(130)
  }
  process.on("SIGINT", h)
  return () => { try { process.removeListener("SIGINT", h) } catch {} }
}

/** Full first-run onboarding. */
export async function runOnboarding(config) {
  await initPipedLines()
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const offSig = wizardSigint()
  console.log()
  console.log(bold(magenta("Welcome to forge — terminal AI agent")))
  console.log(dim("Setup: provider → model → API key → verify — every step is saved as you go"))
  console.log(dim(`Config file: ${USER_CONFIG_PATH}`))
  let next = config
  try {
    const prov = await pickProvider(rl, config)
    next = await wizardProviderSteps(rl, config, prov)

    // skills (wizard-only step)
    const skillsDir = config.skills?.dir ? resolveSkillsDir(config.skills.dir) : resolveSkillsDir()
    const nSkills = skillsDir ? indexSkills(skillsDir).length : 0
    let skillsEnabled = config.skills?.enabled !== false
    if (nSkills > 0) {
      const a = String(await ask(rl, `enable all ${nSkills} skills (pdf, charts, coding, research…)? (Y/n)`, "Y") ?? "").trim().toLowerCase()
      skillsEnabled = a !== "n"
    } else {
      warn("no skills directory found next to the CLI — skills disabled")
      skillsEnabled = false
    }
    next.skills = { enabled: skillsEnabled, dir: skillsDir || (next.skills?.dir ?? "") }
    const savedPath = saveConfig(next)
    ok(`saved ${savedPath} (chmod 600 — keys stay on this device)`)

    console.log()
    console.log(bold(green("Ready. Start now:")))
    console.log(`  ${cyan("forge")}                    ${dim("# picks a working model, starts chat with all tools")}`)
    console.log(`  ${cyan('forge chat -m "hi"')}     ${dim("# one-shot")}`)
    console.log(`  ${cyan('forge agent "task"')}     ${dim("# autonomous coding agent")}`)
    console.log(dim(`  later: forge config (menu) • forge doctor • forge use <provider> --model <id>`))
    console.log()
    return next
  } catch (e) {
    // v17 guarantee: the wizard can NEVER exit silently with nothing saved.
    err(`setup interrupted: ${e?.message ?? e}`)
    try {
      const savedPath = saveConfig(next)
      warn(`everything entered so far is saved to ${savedPath} — run ${cyan("forge")} to continue`)
    } catch {
      warn(`could not write ${USER_CONFIG_PATH} — check permissions, then rerun ${cyan("forge onboard")}`)
    }
    return next
  } finally {
    offSig()
    try { rl.close() } catch {}
  }
}

// ---------------------------------------------------------------------------
// forge config — interactive hub (TTY, or piped for scripts/tests)
// ---------------------------------------------------------------------------
export async function runConfigMenu(config) {
  await initPipedLines()
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const offSig = wizardSigint()
  try {
    while (true) {
      const active = config.activeProvider || "(none)"
      console.log()
      console.log(bold(magenta("forge config")) + dim(`  active: ${active} • ${USER_CONFIG_PATH}`))
      console.log(`  ${bold("1")}. add / update a provider   ${dim("(provider → model → API key → verify)")}`)
      console.log(`  ${bold("2")}. switch active provider`)
      console.log(`  ${bold("3")}. change default model`)
      console.log(`  ${bold("4")}. update API key`)
      console.log(`  ${bold("5")}. show config (keys masked)`)
      console.log(`  ${bold("6")}. test connection (probe)`)
      console.log(`  ${bold("7")}. quit`)
      const a = String(await ask(rl, "choose 1-7", "7") ?? "").trim()
      if (a === "1") {
        const prov = await pickProvider(rl, config)
        await wizardProviderSteps(rl, config, prov) // mutates + saves config incrementally
        ok(`${prov.name} is configured and active`)
      } else if (a === "2") {
        const prov = await pickProvider(rl, config)
        config.activeProvider = prov.name
        if (!config.providers?.[prov.name]) {
          config.providers = { ...(config.providers || {}), [prov.name]: { apiKey: "", baseUrl: prov.baseUrl || "", model: prov.models?.[0] ?? "" } }
        }
        saveConfig(config)
        ok(`active provider → ${bold(prov.name)}`)
      } else if (a === "3") {
        const prov = await pickProvider(rl, config)
        const conf = config.providers?.[prov.name] ?? {}
        const det = await detectFreeEntries(prov, { baseUrl: conf.baseUrl || prov.baseUrl || "", apiKey: conf.apiKey || envKeyFor(prov.name) || "" })
        const model = await pickModel(rl, prov, { recents: conf.models, apiKey: conf.apiKey || envKeyFor(prov.name) || "", baseUrl: conf.baseUrl || prov.baseUrl || "", freeEntries: det.entries })
        config.providers = { ...(config.providers || {}), [prov.name]: { ...(config.providers?.[prov.name] || {}), model } }
        pushRecentModel(config, prov.name, model)
        if (config.activeProvider === prov.name) saveConfig(config)
        else { config.activeProvider = prov.name; saveConfig(config) }
        ok(`model for ${prov.name} → ${bold(model)}`)
      } else if (a === "4") {
        const prov = await pickProvider(rl, config)
        if (prov.keyUrl) console.log(`  ${dim("get a key:")} ${cyan(prov.keyUrl)}`)
        const key = String(await askHidden(rl, `API key for ${prov.name}:`) ?? "").trim()
        if (!key) { warn("empty — nothing changed") }
        else {
          config.providers = { ...(config.providers || {}), [prov.name]: { ...(config.providers?.[prov.name] || {}), apiKey: key } }
          config.activeProvider = prov.name
          saveConfig(config)
          ok(`key saved for ${prov.name} (${maskKey(key)})`)
          const v = await verifyOnce(rl, { prov, baseUrl: config.providers[prov.name].baseUrl || prov.baseUrl || "", apiKey: key, model: config.providers[prov.name].model || prov.models?.[0] })
          if (v.ok) recordHealth(prov.name, { ok: true, ms: v.ms, model: config.providers[prov.name].model, baseUrl: config.providers[prov.name].baseUrl })
        }
      } else if (a === "5") {
        console.log(JSON.stringify(safeView(config), null, 2))
      } else if (a === "6") {
        const prov = await pickProvider(rl, config, { configuredOnly: true })
        const conf = config.providers?.[prov.name] ?? {}
        const v = await verifyOnce(rl, { prov, baseUrl: conf.baseUrl || prov.baseUrl || "", apiKey: conf.apiKey || envKeyFor(prov.name) || "", model: conf.model || prov.models?.[0] })
        recordHealth(prov.name, v.ok ? { ok: true, ms: v.ms, model: conf.model, baseUrl: conf.baseUrl } : { ok: false })
      } else {
        break
      }
    }
  } catch (e) {
    err(`config menu: ${e?.message ?? e}`)
    warn("changes made so far are saved")
  } finally {
    offSig()
    try { rl.close() } catch {}
  }
  return config
}
