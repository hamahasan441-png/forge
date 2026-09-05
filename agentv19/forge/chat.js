/**
 * forge — chat REPL (streaming + sessions + abort + compaction, zero deps)
 *
 * v20 "PRODUCTION":
 *   - terminal-in-chat runs through the shellguard risk engine: catastrophic
 *     commands are always blocked, risky ones ask for confirmation (TTY) or
 *     need FORGE_ASSUME_YES=1 when piped — never silently destructive
 *   - context engine: per-turn system prompt assembles PROJECT PROFILE +
 *     relevant memory (scored, not dumped) + terminal notes + skills
 *   - context-overflow recovery: 400 "too large" → shrink + compact + retry
 *     (bounded), instead of killing the turn — work is never lost
 *   - sessions restore cwd/title/summary/usage; /resume <n>; forge resume
 *   - adaptive effort (profile: fast|balanced|deep|auto — auto classifies the
 *     task; deep effort is announced, never silent)
 *   - /status, /profile; persistent command history (~/.forge/history);
 *     backslash multiline input; /agent + /plan are Ctrl+C-abortable
 *   - tool results are secret-redacted (tools.js), writes boundary-checked
 *
 * v19 "TERMINAL": shell pass-through IN the chat, deep think mode, tiered
 * context reduction (shrink big tool outputs BEFORE summarizing).
 * v16: auto-compaction + /compact, /usage, /plan, parallel tools.
 * v15: INLINE AUTO-TOOLS in chat (streaming tool-calls both wires).
 */
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { execFile } from "node:child_process"
import { streamChatResilient, chatOnce, listModels, CATALOG, getCatalog, envKeyFor, ProviderError, fallbackChain, isFailoverWorthy } from "./providers.js"
import { readHealth, recordHealth } from "./health.js"
import { saveConfig, maskKey, DEFAULT_DIR, pushRecentModel } from "./config.js"
import { makeToolContext, toolCount, WRITE_TOOLS, BUILTIN_TOOL_NAMES } from "./tools.js"
import { loadToolPlugins } from "./plugins.js"
import { classifyCommand, userMayRun } from "./shellguard.js"
import { restoreLast } from "./checkpoint.js"
import { indexSkills, loadSkill, resolveSkillsDir } from "./skills.js"
import { saveSession, loadSession, lastSessionFile, listSessions, findSession } from "./sessions.js"
import { relevantMemory } from "./memory.js"
import { profileSummary, resourceProfile } from "./profile.js"
import { classifyTaskComplexity } from "./agent.js"
import { redact } from "./secrets.js"
import { bold, dim, cyan, green, yellow, red, magenta, info, ok, warn, err, renderMarkdown, estimateTokens, printBanner } from "./ui.js"
import { VERSION } from "./version.js"

const HELP = `
${bold("chat")}
  type anything          talk to the model (streaming)
  end a line with \\      multiline input (continuation prompt)
${bold("commands")}
  /help                 this help
  /status               session + context + safety snapshot
  /profile [name]       effort profile: fast | balanced | deep | auto (auto = per-task)
  /model [id]           show or switch model (saved)
  /provider [name]      show or switch provider (env key respected)
  /providers            list providers (key status)
  /models               list models of active provider (live)
  /key <api-key>        set API key for active provider
  /skills [name]        list skills, or load one into the conversation
  /agent <task>         run the coding agent inside chat (Ctrl+C aborts)
  /plan <task>          plan first (read-only), confirm, then execute
  /tools [on|off]       list the 17 agent tools, or toggle auto-tools in chat
  /shell [on|off]       terminal mode info / toggle Linux-command auto-detect
  !<command>            force-execute a shell command right here (always works)
  /deep                 toggle DEEP THINKING (high reasoning effort + bigger budgets)
  /compact              force context compaction (older turns → summary)
  /usage                session token totals + est. cost
  /tokens               context gauge — % of the model window used (auto-compact at ~55%)
  /retry                regenerate the last answer (also after Ctrl-C interrupts one)
  /undo                 drop the last exchange + restore its file checkpoint
  /export [file]        save the conversation as markdown
  /sessions             list saved conversations
  /resume [n|id]        resume the last (or listed) conversation
  /new                  fresh conversation
  /save                 save conversation to ~/.forge/sessions/
  /system [text]        show or set extra system prompt
  /stream               toggle streaming
  /config               show config (keys masked)
  /exit                 leave (auto-saves)
`.trim()

// ---------------------------------------------------------------------------
// v19/v20 terminal mode — Linux commands typed as chat lines execute LOCALLY
// ---------------------------------------------------------------------------
// Auto-detect set: if the line's first token is one of these, it runs as a
// shell command instead of going to the model. The `!` prefix ALWAYS forces
// execution. `/shell off` disables auto-detect (force-prefix keeps working).
export const SHELL_COMMANDS = new Set(("ls pwd cd cat less head tail echo printf mkdir rmdir touch rm cp mv ln " +
  "grep egrep fgrep find sed awk sort uniq wc cut tr diff patch chmod chown df du free ps kill jobs " +
  "which whereis whoami id uname uptime date cal env export printenv history clear file stat " +
  "md5sum sha256sum tar gzip gunzip zip unzip make cmake git svn npm npx yarn pnpm node " +
  "python python3 pip pip3 curl wget ssh scp rsync ping ifconfig ip netstat man info " +
  "apt apt-get brew docker kubectl helm terraform jq sqlite3 tree watch bc xargs tee screen tmux").split(" "))

// Words that read like a SENTENCE, not like arguments. Checked on everything
// after the command name (the command itself is a legitimate word too —
// "make build" is a command, "make it work" is not). Strong words are worth 2.
const CHAT_STRONG = new Set(("is are was were am be been being it its i me my we our you your he she they them his her " +
  "please thanks thank what whats why how when where who whom which do does did dont doesnt " +
  "should could would shall may might must like likes want wants need needs think thinks seems mean means " +
  "explain tell show finds find make makes made fix use using used vs").split(" "))
const CHAT_WEAK = new Set(("a an the this that these those to of in on for with and or but not no out up down over under " +
  "again very just also about into from by at as if then than so because there here all any some more").split(" "))
// tokens that make a line unmistakably a command: flags, paths, shell operators
const FLAG_RE = /^--?[A-Za-z0-9]/
// path-ish = "~", a slash, or a dot-relative/dotfile token. A bare
// "file.txt" is NOT enough on its own: sentences mention filenames too
// ("find the bug in main.js"), and a real command like `cat file.txt`
// scores 0 on the sentence test anyway, so it still runs.
const PATHISH_RE = /^~|^\.{1,2}(?:\/|$)|\//

/** Score how English-like the ARGUMENTS of a line are (0 = pure command). */
function chatWordScore(tokens) {
  let s = 0
  for (const w of tokens.slice(1)) {
    const lw = w.toLowerCase().replace(/[^a-z']/g, "")
    if (!lw) continue
    if (CHAT_STRONG.has(lw)) s += 2
    else if (CHAT_WEAK.has(lw)) s += 1
  }
  return s
}

/**
 * Decide whether a typed line is a shell command. `!` forces; otherwise the
 * first token must be a known command AND the line must not read like a
 * natural-language request.
 *
 * v20.0.1: "SHELL_COMMANDS.has(firstWord)" alone swallowed ordinary sentences —
 * "find the bug in main.js", "make it work", "node is great" and "cat is my
 * favorite animal" were all EXECUTED in the shell (and the model never saw
 * them). A line is now only auto-executed when it has no flag/path/operator
 * AND does not read like a sentence.
 */
export function isShellLine(t) {
  const line = String(t ?? "").trim()
  if (line.startsWith("!")) return true
  if (line.endsWith("?")) return false
  if (/^(please|can|could|would|should|what|whats|how|why|when|where|who|tell|explain|help|give|make me|write)\b/i.test(line)) return false
  const tokens = line.split(/\s+/).filter(Boolean)
  const first = (tokens[0] || "").split("/").pop()
  if (!SHELL_COMMANDS.has(first)) return false
  if (tokens.length < 2) return true // bare command: `ls`, `pwd`, `date`
  // unmistakably a command: flags, paths/files, redirects, pipes, chains
  if (tokens.slice(1).some((w) => FLAG_RE.test(w) || PATHISH_RE.test(w))) return true
  if (/[|;&<>]/.test(line) || line.includes("$(") || line.includes("`")) return true
  // otherwise it is a command only if it does NOT read like a sentence
  return chatWordScore(tokens) < 2
}

/** v19 tiered context reduction, stage 1: replace BIG tool outputs outside the
 *  recent tail with stubs — real history is kept, only the bulk is dropped.
 *  Often removes the need for a lossy summary entirely. */
function shrinkToolOutputs(msgs, { tail = 4, maxKeep = 2400 } = {}) {
  let bytes = 0
  const out = msgs.map((m, i) => {
    if (m?.role === "tool" && typeof m.content === "string" && m.content.length > maxKeep && i < msgs.length - tail) {
      bytes += m.content.length
      return { ...m, content: `[tool output shrunk: ${m.content.length} chars]` }
    }
    return m
  })
  return { messages: out, bytes }
}

/** Overflow-recovery shrink (v20): stub ALL old tool outputs + dedupe. */
function hardShrink(msgs) {
  const seen = new Map()
  return msgs.map((m, i) => {
    if (m?.role !== "tool" || typeof m.content !== "string" || i >= msgs.length - 6) return m
    const key = m.content.slice(0, 120)
    if (seen.has(key)) return { ...m, content: "[duplicate tool output removed]" }
    seen.set(key, true)
    if (m.content.length > 600) return { ...m, content: `[tool output shrunk: ${m.content.length} chars]` }
    return m
  })
}

export function chatSystemPrompt(config, { toolsEnabled = false, deep = false, query = "" } = {}) {
  const lines = [
    "You are forge — a sharp, concise AI assistant in the user's terminal.",
    `Date: ${new Date().toISOString().slice(0, 10)}   OS: ${process.platform}   Node: ${process.version}`,
    "Answer in the user's language. Use markdown. Be direct; skip filler.",
  ]
  if (toolsEnabled) {
    lines.push("", `TOOLS: you can use tools automatically (web_search, fetch_url, bash, read_file, glob_files, grep_files, apply_patch, git_status, todo, think, memory, delegate and more — ${toolCount()} total). Use them whenever they help; results arrive automatically. Writes stay inside the working directory; sensitive files are protected.`)
  }
  if (deep) {
    lines.push("",
      "DEEP THINKING MODE: reason carefully before answering —",
      "1. restate what is actually being asked; 2. consider alternatives and edge cases;",
      "3. lay out a short plan; 4. answer; 5. verify claims against evidence before asserting.",
      "Prefer being correct over being fast. When facts are missing, investigate instead of guessing.")
  }
  // v20 context engine: project profile (cheap, cached) instead of re-discovery
  const prof = profileSummary(process.cwd())
  if (prof) lines.push("", prof)
  // v20: relevant memory only — scored against the current query, never a dump
  if (query) {
    const mem = relevantMemory(query, { cwd: process.cwd() })
    if (mem) lines.push("", mem)
  }
  if (config.chat?.system) lines.push("", "USER INSTRUCTIONS: " + config.chat.system)
  const skillsDir = resolveSkillsDir(config.skills?.dir)
  if (config.skills?.enabled !== false && skillsDir) {
    const idx = indexSkills(skillsDir)
    if (idx.length) {
      lines.push("", `INSTALLED SKILLS (${idx.length}) — if the user's request matches one, mention it and offer: /skills <name>`)
      for (const s of idx.slice(0, 40)) lines.push(`- ${s.name}: ${s.desc}`)
    }
  }
  return lines.join("\n")
}

/**
 * v20.2 never-lose-work: decide what a Ctrl-C'd turn leaves in the session.
 * If any text was streamed, keep it as a marked assistant message (so /retry can
 * regenerate); otherwise roll back to the pre-turn snapshot so no orphaned
 * user/tool messages linger. Pure — unit-tested independently of the chat loop.
 */
export function interruptedTurnResult(messages, preTurnSnapshot, partial) {
  const p = String(partial ?? "").trim()
  if (p) {
    return { messages: [...messages, { role: "assistant", content: p + "\n\n_[interrupted — /retry to regenerate]_" }], kept: true }
  }
  return { messages: preTurnSnapshot, kept: false }
}

/** Cap conversation history (keep most recent turns) to protect context.
 *  Always trims to a safe boundary: history must start with a user message,
 *  never with a tool result or an assistant tool_calls turn (provider 400s). */
function compact(messages, maxMessages) {
  const cap = maxMessages ?? 40
  let out = messages.length <= cap ? messages.slice() : messages.slice(messages.length - cap)
  while (out.length && out[0].role !== "user") out.shift()
  return out
}

/** Piped (non-TTY) stdin: slurp ONCE with a short grace timer so an
 *  inherited-but-empty pipe never blocks. Returns "" if nothing arrives. */
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

const HISTORY_PATH = path.join(DEFAULT_DIR, "history")

export async function runChat({ config, provider, oneShot, resumeFile, deep: deepFlag }) {
  let p = provider
  // v20.2: provider failover (opt-in) for the interactive loop — when the active
  // provider fails before any output is shown, switch to the next configured
  // provider instead of dropping the turn. Default OFF; each switch is announced.
  const failoverOn = config?.failover === true || process.env.FORGE_FAILOVER === "1"
  const foChain = failoverOn ? fallbackChain(config, p.name, { health: readHealth() }) : []
  let foIdx = 0
  // v19 deep think: --deep flag or persisted chat.deep; v20 profile resolves
  // the default when nothing explicit is set (auto → per-task classification)
  let deep = !!(deepFlag || config.chat?.deep)
  const chatToolsEnabled = () => config.chat?.tools !== false
  const memoryPath = path.join(DEFAULT_DIR, "memory.md")
  const resolvedSkillsDir = resolveSkillsDir(config.skills?.dir)
  const res = resourceProfile()
  const assumeYes = config.tools?.assumeYes === true || process.env.FORGE_ASSUME_YES === "1"
  // v20.2 P3-5: user tool plugins from ~/.forge/tools (empty by default)
  let plugins = []
  if (config.tools?.plugins !== false) {
    try {
      const loaded = await loadToolPlugins(undefined, { reserved: BUILTIN_TOOL_NAMES })
      plugins = loaded.tools
      for (const e of loaded.errors) warn(`tool plugin skipped: ${e}`)
    } catch { /* best-effort */ }
  }
  const tools = makeToolContext({
    plugins,
    cwd: process.cwd(),
    root: process.cwd(),
    timeoutSec: config.agent?.timeoutSec ?? 45,
    maxToolOutput: config.agent?.maxToolOutput ?? 12000,
    skillsDir: resolvedSkillsDir,
    searchUrl: config.tools?.searchUrl || "",
    memoryPath,
    todoPath: path.join(DEFAULT_DIR, "todo.json"),
    readOnly: false,
    allowOutsideProject: config.tools?.allowOutsideProject === true,
    allowSudo: config.tools?.allowSudo === true,
    assumeYes,
    fetchPrivateUrls: config.tools?.fetchPrivateUrls === true || process.env.FORGE_ALLOW_PRIVATE_URLS === "1",
    delegateTimeoutSec: config.agent?.delegateTimeoutSec ?? 180,
    maxParallelDelegates: config.agent?.maxParallelSubAgents ?? (res.tier === "low" ? 1 : 2),
    delegateRunner: (subTask, subRole) =>
      import("./agent.js").then(({ runAgent }) =>
        runAgent({ config, provider: p, task: subTask, readOnly: true, maxStepsOverride: 10, role: subRole }).then((r) => r.text)
      ),
  })

  // v20: chat line log for persistent history (~/.forge/history) — shared by
  // the TTY REPL and the piped line processor, so both persist what was typed
  const chatLineLog = []
  function readHist() {
    try { return fs.readFileSync(HISTORY_PATH, "utf8").split("\n").filter(Boolean) } catch { return [] }
  }
  saveHistory = () => {
    try {
      const all = [...new Set([...readHist(), ...shellState.history, ...chatLineLog])]
      fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true })
      fs.writeFileSync(HISTORY_PATH, all.slice(-Math.max(50, config.chat?.historySize ?? 300)).join("\n") + "\n", { mode: 0o600 })
    } catch {}
  }

  let messages = []
  let sessionId = null
  let sessionSummary = null
  let restoredUsage = { prompt: 0, completion: 0, requests: 0 }
  if (resumeFile) {
    const s = loadSession(resumeFile)
    if (s) {
      messages = s.messages.filter((m) => m.role !== "system")
      sessionId = s.id ?? null
      sessionSummary = s.summary ?? null
      if (s.usage) restoredUsage = { ...s.usage }
      if (s.cwd && config.chat?.restoreCwd !== false) {
        try {
          const st = fs.statSync(s.cwd)
          if (st.isDirectory()) { process.chdir(s.cwd); ok(`resumed in ${s.cwd}`) }
        } catch { /* cwd gone — stay in the current one */ }
      }
      ok(`resumed session ${s.id ?? ""} (${messages.length} messages${s.title ? ` • ${dim('"')}${s.title.slice(0, 48)}${dim('"')}` : ""})`)
    } else warn("could not load session — starting fresh")
  }

  let lastUsage = null
  let abort = null
  const sessionUsage = { ...restoredUsage } // v16: /usage — v20: survives resume

  // ---- v19/v20 terminal mode state -------------------------------------------
  const shellState = { cwd: process.cwd(), env: {}, history: [] }
  let pendingNotes = [] // terminal runs shared with the model on the next turn

  const termWidth = () => Math.min(process.stdout.columns || 80, 120)

  function printTerminal(cmd, out) {
    const w = termWidth()
    console.log(dim(`┌─ terminal ${"─".repeat(Math.max(3, Math.min(40, w - cmd.length - 14)))}`))
    console.log(dim("$ ") + cmd)
    const lines = String(out).split("\n")
    console.log(lines.slice(0, 40).map((l) => dim("│ ") + l).join("\n"))
    if (lines.length > 40) console.log(dim(`│ … ${lines.length - 40} more lines (${String(out).length} bytes total)`))
    console.log(dim("└─"))
  }

  /** Queue a compact, SECRET-REDACTED note for the model. The raw output is
   *  still shown to the user in the terminal (real terminal semantics) — only
   *  what crosses into the model context / session storage gets masked. */
  function noteTerminal(cmd, out) {
    const s = redact(String(out))
    pendingNotes.push(`$ ${redact(cmd)}\n${s.length > 1500 ? s.slice(0, 1500) + `\n… (${s.length} bytes total)` : s}`)
  }

  /** y/N confirmation for risky terminal commands (TTY only). */
  function confirmPrompt(risk) {
    return new Promise((resolve) => {
      const r2 = readline.createInterface({ input: process.stdin, output: process.stdout })
      r2.question(yellow(`! ${risk} — run it? [y/N] `), (a) => { r2.close(); resolve(/^y(es)?$/i.test(String(a || "").trim())) })
    })
  }

  /** Execute one shell line locally — output shown in the same chat and
   *  queued as a compact note for the model. cd/export/history/clear are
   *  handled in-process so state persists across the session.
   *  v20: every line goes through the shellguard classifier first:
   *    block  → always refused (rm -rf /, mkfs, dd of=/dev/sd*, fork bombs…)
   *    danger/confirm → y/N on a TTY; FORGE_ASSUME_YES=1 or tools.assumeYes
   *    when piped. Nothing risky runs silently. */
  async function runShellLine(raw) {
    const cmd = raw.startsWith("!") ? raw.slice(1).trim() : raw
    if (!cmd) { warn("usage: !<command> — or just type a Linux command"); return }
    const force = raw.startsWith("!")
    const interactive = process.stdin.isTTY === true
    const verdict = userMayRun(cmd, { cwd: shellState.cwd, root: process.cwd() }, { interactive, assumeYes })
    if (!verdict.ok) {
      err(verdict.reason)
      noteTerminal(cmd, `BLOCKED for safety: ${verdict.reason}`)
      return
    }
    if (verdict.needsConfirm) {
      const risk = verdict.reason ?? verdict.level
      const yes = await confirmPrompt(risk)
      if (!yes) { warn("skipped"); noteTerminal(cmd, "(user declined to run this command)"); return }
    }
    shellState.history.push(cmd)
    const base = path.basename(cmd.split(/\s+/)[0] || "")
    if (base === "cd") {
      const target = cmd.split(/\s+/).slice(1).join(" ")
        ? path.resolve(shellState.cwd, cmd.split(/\s+/).slice(1).join(" "))
        : (shellState.env.HOME || process.env.HOME || "/")
      try {
        const st = fs.statSync(target)
        if (!st.isDirectory()) throw new Error("not a directory")
        shellState.cwd = target
        try { process.chdir(target) } catch {}
        printTerminal(cmd, shellState.cwd)
        noteTerminal(cmd, shellState.cwd)
      } catch (e) { err(`cd: ${target}: ${e.message}`) }
      return
    }
    if (base === "export") {
      const m = cmd.match(/^export\s+([A-Za-z_]\w*)=(.*)$/)
      if (m) {
        shellState.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
        printTerminal(cmd, `${m[1]}=${shellState.env[m[1]]}  ${dim("(persisted for this session)")}`)
        noteTerminal(cmd, `${m[1]}=${shellState.env[m[1]]} (session env)`)
        return
      }
    }
    if (base === "clear") { process.stdout.write("\x1b[2J\x1b[H"); return }
    if (base === "history") {
      printTerminal(cmd, shellState.history.map((h, i) => `${String(i + 1).padStart(4)}  ${h}`).join("\n"))
      return
    }
    const timeoutMs = Math.min(300, Math.max(1, config.agent?.timeoutSec ?? 45)) * 1000
    const out = await new Promise((resolve) => {
      execFile("/bin/sh", ["-c", cmd], { cwd: shellState.cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, killSignal: "SIGKILL", env: { ...process.env, ...shellState.env, TERM: "dumb" } }, (error, stdout, stderr) => {
        let o = ""
        if (stdout) o += stdout
        if (stderr) o += (o ? "\n--- stderr ---\n" : "") + stderr
        if (error && !o) o = String(error.message)
        else if (error && error.killed) o += `\n[command timed out after ${timeoutMs / 1000}s]`
        else if (error && typeof error.code === "number") o += `\n[exit code: ${error.code}]`
        resolve(o || "(no output)")
      })
    })
    printTerminal(cmd, out)
    noteTerminal(cmd, out)
  }

  function trackUsage(u) {
    if (!u) return
    lastUsage = u
    sessionUsage.requests++
    sessionUsage.prompt += Number(u.prompt_tokens ?? 0)
    sessionUsage.completion += Number(u.completion_tokens ?? 0)
  }

  /** v16: auto-compaction — summarize older turns when history grows too big.
   *  Always leaves a user-first history (same invariant as compact()).
   *  v17: ALSO fires on a TOKEN BUDGET — est. tokens > 55% of the model's
   *  context window — so the reducer adapts to small/large-window models.
   *  v19: TIERED — stage 1 SHRINKS big old tool outputs (no information is
   *  summarized away); stage 2 summarizes only if still over budget.
   *  v20: the summary is remembered for session resume (session.summary). */
  async function maybeCompact(force = false) {
    const enabled = force || config.chat?.compact !== false
    if (!enabled) {
      if (force) warn("auto-compaction is disabled (chat.compact: false)")
      return false
    }
    const window = p.contextWindow ?? 128000
    const budgetTok = Math.floor((window * 55) / 100)
    const shrinkTok = Math.floor((window * 40) / 100)
    const chars = JSON.stringify(messages).length
    let estTok = estimateTokens(JSON.stringify(messages))
    if (!force && chars < (config.chat?.compactAtChars ?? 48000) && estTok < shrinkTok) return false
    // stage 1 — shrink (keeps the real history, drops the bulk)
    const sh = shrinkToolOutputs(messages)
    if (sh.bytes > 0) {
      messages = sh.messages
      estTok = estimateTokens(JSON.stringify(messages))
      ok(`tool outputs shrunk: ~${Math.round(sh.bytes / 1024)}KB of old tool results stubbed (full history kept) ${dim(`~${estTok.toLocaleString()} tok now`)}`)
      if (!force && estTok < budgetTok) return true
    }
    if (messages.length < 6) return false
    // stage 2 — summarize when over the CHAR cap (v16) or the TOKEN budget (v17)
    if (!force && chars < (config.chat?.compactAtChars ?? 48000) && estTok < budgetTok) return false
    const keep = Math.min(6, messages.length - 1)
    const old = messages.slice(0, messages.length - keep)
    const recent = messages.slice(messages.length - keep).filter((m) => m.role === "user" || (m.role === "assistant" && !m.tool_calls && typeof m.content === "string"))
    try {
      const digest = old.map((m) => `[${m.role}] ${String(typeof m.content === "string" ? m.content : "(tool activity)").slice(0, 500)}`).join("\n").slice(0, 24000)
      const s = await chatOnce({
        protocol: p.protocol, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model, providerName: p.name,
        system: "Summarize this conversation for an AI assistant that will continue it. In <=250 words capture: the user's goals, decisions made, files created or changed, facts to remember, and open tasks. Output only the summary.",
        messages: [{ role: "user", content: digest }],
        maxTokens: 600,
      })
      const before = messages.length
      const summaryText = (s.content || "(no summary produced)").trim()
      sessionSummary = summaryText.slice(0, 600) // v20: remembered for resume
      messages = [{ role: "user", content: `AUTO-COMPACTED SUMMARY of earlier conversation:\n${summaryText}` }, ...recent.filter((m) => m.role === "user")]
      if (!messages.length) { messages = [{ role: "user", content: `AUTO-COMPACTED SUMMARY of earlier conversation:\n${summaryText}` }] }
      ok(`context compacted: ${before} → ${messages.length} messages (${chars} → ${JSON.stringify(messages).length} chars)`)
      return true
    } catch (e) {
      if (force) err(`compaction failed: ${e?.message ?? e}`)
      return false // graceful: keep full history
    }
  }

  /** Persist the conversation — one file per conversation, updated in place. */
  function persist() {
    if (!messages.length) return
    const f = saveSession({ provider: p.name, model: p.model, messages, id: sessionId, usage: { ...sessionUsage }, cwd: process.cwd(), summary: sessionSummary })
    if (f && !sessionId) sessionId = f
    return f
  }

  // Ctrl+C: first press aborts the current stream/agent, second press exits
  let multilineBuf = null
  process.on("SIGINT", () => {
    multilineBuf = null
    if (abort) {
      abort.abort()
      abort = null
      process.stdout.write(dim("\n(aborted)\n"))
    } else {
      console.log(dim("\nbye"))
      saveHistory()
      persist()
      process.exit(0)
    }
  })

  /** One streaming round: returns {text, toolCalls}. Prints text as it arrives.
   *  onText (optional) receives each delta so the caller can preserve partial
   *  output if the stream is interrupted (Ctrl-C) — v20.2 "never lose work". */
  async function streamRound(wire, signal, deepEffort, onText) {
    let text = ""
    let toolCalls = []
    for await (const ev of streamChatResilient(
      { protocol: p.protocol, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model, providerName: p.name, messages: wire, tools: chatToolsEnabled() ? tools.defs : undefined, maxTokens: deepEffort ? 16384 : 8192, deep: deepEffort, signal, connectMs: config.retry?.connectMs, firstByteMs: config.retry?.firstByteMs },
      { attempts: config.retry?.attempts ?? 3, backoffMs: config.retry?.backoffMs ?? 1500, onRetry: ({ attempt, attempts, error }) => console.log(yellow(`  ↻ ${error} — retry ${attempt}/${attempts}…`)) }
    )) {
      if (ev.type === "text") { process.stdout.write(ev.text); text += ev.text; onText?.(ev.text) }
      else if (ev.type === "reasoning") {
        if (config.chat?.showReasoning !== false) process.stdout.write(dim(ev.text.slice(0, 1600)))
      } else if (ev.type === "tool_calls") toolCalls = ev.calls
      else if (ev.type === "usage") trackUsage(ev.usage)
      else if (ev.type === "error") err(ev.error)
    }
    return { text, toolCalls }
  }

  /** One non-streaming round with tools. */
  async function plainRound(wire, deepEffort) {
    const msg = await chatOnce({ protocol: p.protocol, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model, providerName: p.name, messages: wire, tools: chatToolsEnabled() ? tools.defs : undefined, maxTokens: deepEffort ? 16384 : 8192, deep: deepEffort, connectMs: config.retry?.connectMs, requestTimeoutMs: config.retry?.requestTimeoutMs })
    if (msg.reasoning && config.chat?.showReasoning !== false) console.log(dim("·thinking· " + msg.reasoning.slice(0, 800)))
    if (msg.content) process.stdout.write(msg.content)
    trackUsage(msg.usage)
    return { text: msg.content ?? "", toolCalls: msg.toolCalls ?? [] }
  }

  /** Execute tool calls (v16: reads in parallel, writes serialized), print
   *  activity, append CANONICAL wire-format messages to history. */
  async function runToolCalls(toolCalls) {
    process.stdout.write("\n")
    const parsed = toolCalls.map((tc) => {
      let args = {}
      try { args = JSON.parse(tc.args || "{}") } catch {}
      return { tc, args, argStr: JSON.stringify(args).slice(0, 140) }
    })
    for (const { tc, argStr } of parsed) console.log(dim(`  ┌ [chat] ${cyan(tc.name)} ${dim(argStr)}`))
    const isWrite = (n) => WRITE_TOOLS.has(n)
    const results = new Array(parsed.length)
    await Promise.all(
      parsed.map(async ({ tc, args }, i) => {
        if (isWrite(tc.name)) return
        const t0 = Date.now()
        let result
        try { result = await tools.exec(tc.name, args) } catch (e) { result = `ERROR: ${e.message}` }
        results[i] = { result, ms: Date.now() - t0 }
      })
    )
    for (let i = 0; i < parsed.length; i++) {
      const { tc, args } = parsed[i]
      if (isWrite(tc.name)) {
        const t0 = Date.now()
        let result
        try { result = await tools.exec(tc.name, args) } catch (e) { result = `ERROR: ${e.message}` }
        results[i] = { result, ms: Date.now() - t0 }
      }
      const { result, ms } = results[i]
      const one = String(result).split("\n").slice(0, 2).join(" ⏎ ").slice(0, 160)
      console.log(dim(`  └ `) + (String(result).startsWith("ERROR") || String(result).startsWith("BLOCKED") ? red(one) : green(one)) + dim(` ${ms}ms`))
    }
    // canonical history: ONE assistant tool_calls message, then one tool result each
    messages.push({ role: "assistant", content: "", tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.args } })) })
    for (let i = 0; i < parsed.length; i++) messages.push({ role: "tool", tool_call_id: parsed[i].tc.id, content: String(results[i].result) })
  }

  /** v20: resolve effort for this turn. Explicit --deep/chat.deep wins; the
   *  profile decides otherwise (auto classifies each message — announced). */
  let lastDeepNotice = ""
  function effortFor(userText) {
    if (deepFlag || config.chat?.deep) return { deep: true, notice: "" }
    const profile = config.chat?.profile ?? "auto"
    if (profile === "deep") return { deep: true, notice: "" }
    if (profile === "fast" || profile === "balanced") return { deep: false, notice: "" }
    const level = classifyTaskComplexity(userText)
    const d = level === "complex" || level === "critical"
    const notice = d && lastDeepNotice !== userText ? `auto → ${level} task: deep effort for this turn` : ""
    lastDeepNotice = d ? userText : ""
    return { deep: d, notice }
  }

  async function turn(userText) {
    // v20.2 never-lose-work: snapshot the history before this turn mutates it,
    // so an interrupt with no output rolls back cleanly (rather than a fragile
    // pop that can orphan tool messages).
    const preTurnSnapshot = messages.slice()
    let streamedPartial = "" // visible text streamed so far this turn
    await maybeCompact().catch(() => {}) // v16: auto-compaction check
    // v19 terminal mode: notes from shell commands the user ran since the last
    // message ride along, so the model KNOWS what happened in the terminal.
    if (pendingNotes.length) {
      const notes = pendingNotes.join("\n\n")
      pendingNotes = []
      userText = `[terminal] ${notes}\n\n${userText}`
    }
    messages.push({ role: "user", content: userText })
    messages = compact(messages, config.chat?.maxHistoryMessages)
    process.stdout.write("\n")
    const eff = effortFor(userText)
    if (eff.notice) console.log(dim(`  · ${eff.notice}`))
    const systemPrompt = chatSystemPrompt(config, { toolsEnabled: chatToolsEnabled(), deep: eff.deep, query: String(userText).slice(0, 400) })
    abort = new AbortController()
    const signal = abort.signal
    let full = ""
    let overflowTries = 0
    try {
      // auto-tools loop: stream a round; if the model asks for tools, execute
      // them automatically, feed results back, and stream the next round.
      // v19: deep mode gets a bigger round budget (12 vs 8).
      // v20: a 400 "context too large" triggers compress + retry (bounded).
      for (let round = 0; round < (eff.deep ? 12 : 8); round++) {
        const wire = [{ role: "system", content: systemPrompt }, ...messages]
        let out
        try {
          out = config.chat?.stream !== false
            ? await streamRound(wire, signal, eff.deep, (t) => { streamedPartial += t })
            : await plainRound(wire, eff.deep)
        } catch (e) {
          if (e instanceof ProviderError && e.contextOverflow && overflowTries < 2) {
            overflowTries++
            warn(`context too large for ${p.model} — compressing history and retrying (${overflowTries}/2)`)
            messages = hardShrink(messages)
            await maybeCompact(true).catch(() => {})
            round--
            continue
          }
          // v20.2 chat failover: only before any text was shown this turn (a
          // mid-stream switch would duplicate output). Switch provider, retry.
          if (failoverOn && !streamedPartial && isFailoverWorthy(e) && foIdx < foChain.length) {
            const next = foChain[foIdx++]
            recordHealth(p.name, { ok: false, error: String(e.message).slice(0, 160), model: p.model })
            warn(`provider ${p.name} failed (${String(e.message).slice(0, 80)}) — switching to ${next.name}/${next.model}`)
            p = next
            round--
            continue
          }
          throw e
        }
        const { text, toolCalls } = out
        if (toolCalls.length && chatToolsEnabled()) {
          await runToolCalls(toolCalls)
          full = "" // the final answer comes in a later round
          continue
        }
        full = text || full
        break
      }
      process.stdout.write("\n")
    } catch (e) {
      process.stdout.write("\n")
      if (e?.name === "AbortError") {
        // v20.2: an interrupted answer is no longer thrown away. If any text was
        // streamed, keep it in the session (marked, and /retry regenerates);
        // if nothing was produced, roll the turn back cleanly.
        const r = interruptedTurnResult(messages, preTurnSnapshot, streamedPartial)
        messages = r.messages
        if (r.kept) {
          warn("interrupted — partial answer kept in the session (/retry to regenerate)")
          persist()
        } else {
          err("aborted")
        }
        return
      }
      if (e instanceof ProviderError && e.contextOverflow) {
        err(`context still too large after compression — start a new conversation (/new) or switch to a bigger-window model`)
        messages.pop()
        persist() // v20: keep the work — never lose the session on overflow
        return
      }
      err(e instanceof ProviderError ? e.message : (e?.message ?? String(e)))
      messages.pop()
      return
    } finally {
      abort = null
    }
    if (full.trim()) messages.push({ role: "assistant", content: full })
    const u = lastUsage
    if (u?.prompt_tokens || u?.completion_tokens) console.log(dim(`  (${u.prompt_tokens ?? "?"} in / ${u.completion_tokens ?? "?"} out tok) • session: ${sessionUsage.prompt} in / ${sessionUsage.completion} out`))
    else console.log(dim(`  (~${estimateTokens(JSON.stringify(messages))} tok ctx) • session: ${sessionUsage.prompt} in / ${sessionUsage.completion} out`))
    persist() // auto-save after every turn — crash-safe
    console.log()
  }

  if (oneShot) {
    await turn(oneShot)
    return
  }

  printBanner(VERSION, p.name, p.model)
  const nSkills = indexSkills(resolvedSkillsDir).length
  console.log(dim(`cwd: ${process.cwd()}`))
  console.log(dim(`skills: ${nSkills ? (config.skills?.enabled !== false ? `${nSkills} enabled` : "disabled") : "none found"} • auto-tools: ${chatToolsEnabled() ? green(toolCount() + " ON") : yellow("off")} • terminal: ${config.chat?.shellAuto === false ? yellow("! only") : green("on")} • deep: ${deep ? green("ON") : "off"} • profile: ${cyan(config.chat?.profile ?? "auto")} • resources: ${res.tier} • /status, /help`))
  if (sessionSummary) console.log(dim(`resumed summary: ${sessionSummary.replace(/\s+/g, " ").slice(0, 140)}`))

  // Piped / scripted sessions: skip readline entirely — deterministic line
  // processing in order, no EOF-vs-close races, natural (flushing) exit.
  // `rl` stays null here (v16 fix: handleLine must not touch the TTY readline
  // — v15 threw "Cannot access 'rl' before initialization" on every piped run).
  let rl = null
  const promptSafe = () => { try { rl?.prompt() } catch {} }

  if (!process.stdin.isTTY) {
    const raw = await slurpStdin(400)
    const lines = raw.length ? raw.split("\n") : []
    if (lines.length && lines[lines.length - 1] === "") lines.pop()
    for (const line of lines) {
      try { await handleLine(line) } catch (e) { err(e?.message ?? String(e)) }
    }
    persist()
    saveHistory()
    console.log(dim("bye"))
    return
  }

  // v20: persistent command history across sessions (arrow keys remember).
  // loadHistoryInto pre-populates the readline history (TTY only).
  loadHistoryInto = () => {
    try {
      const hist = readHist()
      for (let i = hist.length - 1; i >= 0; i--) {
        if (!rl.history.includes(hist[i])) rl.history.unshift(hist[i])
      }
    } catch {}
  }

  const rl2 = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: bold(magenta("forge")) + dim(" ❯ "),
    completer: completer,
  })
  rl = rl2
  loadHistoryInto()
  rl.prompt()

  // Serialize line handling: a streaming turn must finish before the next
  // line is processed.
  let queue = Promise.resolve()
  rl.on("line", (line) => {
    queue = queue
      .then(() => handleLine(line))
      .catch((e) => { err(e?.message ?? String(e)); rl.prompt() })
  })
  // Ctrl+D (interactive EOF): drain the queue, then leave.
  rl.on("close", () => {
    queue.catch(() => {}).then(() => {
      console.log(dim("bye"))
      saveHistory()
      persist()
      setTimeout(() => process.exit(0), 30)
    })
  })

  function completer(line) {
    const cmds = ["/help", "/status", "/profile", "/model", "/provider", "/providers", "/models", "/key", "/skills", "/agent", "/plan", "/tools", "/shell", "/deep", "/compact", "/usage", "/tokens", "/retry", "/undo", "/export", "/sessions", "/resume", "/new", "/save", "/system", "/stream", "/config", "/exit"]
    const hits = cmds.filter((c) => c.startsWith(line))
    return [hits.length ? hits : cmds, line]
  }

  async function handleLine(line) {
    // v20 multiline: a trailing backslash continues the input on the next line
    if (multilineBuf !== null) {
      const joined = multilineBuf + "\n" + line
      if (/\\$/.test(line) && !/\\\\$/.test(line)) { multilineBuf = joined.replace(/\\$/, ""); rl?.setPrompt(dim("… ") + " "); promptSafe(); return }
      multilineBuf = null
      rl?.setPrompt(bold(magenta("forge")) + dim(" ❯ "))
      await dispatch(joined)
      return
    }
    if (/\\$/.test(line) && !/\\\\$/.test(line) && line.trim()) {
      multilineBuf = line.replace(/\\$/, "")
      rl?.setPrompt(dim("… ") + " ")
      promptSafe()
      return
    }
    await dispatch(line)
  }

  async function dispatch(line) {
    const t = line.trim()
    if (!t) { promptSafe(); return }
    if (t.startsWith("/")) { chatLineLog.push(t); await handleCommand(t); promptSafe(); return }
    // v19 terminal mode: Linux commands typed as chat lines run locally in the
    // same chat (output shown here + shared with the model on the next turn)
    if (isShellLine(t)) { await runShellLine(t); promptSafe(); return }
    chatLineLog.push(t)
    await turn(t)
    promptSafe()
  }

  async function handleCommand(t) {
    const [cmd, ...rest] = t.slice(1).split(/\s+/)
    const arg = rest.join(" ")
    switch (cmd) {
      case "help": console.log(HELP); break
      case "exit": case "quit": {
        persist()
        console.log(dim("bye"))
        saveHistory()
        setTimeout(() => process.exit(0), 30) // let buffered stdout flush
        break
      }
      case "new": messages = []; sessionId = null; sessionSummary = null; ok("fresh conversation"); break
      case "save": {
        const f = persist()
        f ? ok(`saved: ${f}`) : err("save failed")
        break
      }
      case "resume": {
        const listed = listSessions(10)
        let target = null
        if (arg && /^\d+$/.test(arg)) target = listed[Number(arg) - 1]?.file
        else if (arg) target = findSession(arg)
        else target = lastSessionFile()
        if (!target) { err("no saved sessions yet"); break }
        const s = loadSession(target)
        if (!s) { err("could not load " + target); break }
        messages = s.messages.filter((m) => m.role !== "system")
        sessionId = s.id ?? null
        sessionSummary = s.summary ?? null
        if (s.usage) { sessionUsage.prompt = s.usage.prompt ?? 0; sessionUsage.completion = s.usage.completion ?? 0; sessionUsage.requests = s.usage.requests ?? 0 }
        if (s.cwd && config.chat?.restoreCwd !== false) {
          try { const st = fs.statSync(s.cwd); if (st.isDirectory()) { process.chdir(s.cwd); ok(`cwd → ${s.cwd}`) } } catch {}
        }
        ok(`resumed (${messages.length} messages) — continue chatting`)
        if (sessionSummary) console.log(dim(`summary: ${sessionSummary.replace(/\s+/g, " ").slice(0, 200)}`))
        break
      }
      case "sessions": {
        const listed = listSessions(10)
        if (!listed.length) { warn("no saved sessions yet — they are auto-saved as you chat"); break }
        console.log(bold("sessions (newest first)"))
        listed.forEach((s, i) => {
          const age = Math.round((Date.now() - (s.ts || Date.now())) / 60000)
          const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`
          const title = s.title ? dim(`  ${s.title.slice(0, 40)}`) : ""
          console.log(`  ${bold(String(i + 1).padStart(2))}. ${dim(path.basename(s.file, ".json"))}  ${cyan(s.provider + "/" + s.model)}  ${dim(`${s.turns} turns • ${ageStr}`)}${title}`)
        })
        console.log(dim("  /resume <n> to continue one"))
        break
      }
      case "retry": {
        // drop the last assistant answer + trailing tool messages, then re-send
        while (messages.length && (messages[messages.length - 1].role === "assistant" || messages[messages.length - 1].role === "tool")) messages.pop()
        if (!messages.length || messages[messages.length - 1].role !== "user") { err("nothing to retry yet"); break }
        const text = messages.pop().content
        await turn(text)
        break
      }
      case "undo": {
        while (messages.length && (messages[messages.length - 1].role === "assistant" || messages[messages.length - 1].role === "tool")) messages.pop()
        if (messages.length && messages[messages.length - 1].role === "user") messages.pop()
        // v16: also restore the newest file checkpoint for this directory
        const ck = restoreLast(process.cwd())
        ok(messages.length ? "last exchange dropped" : "conversation is empty")
        if (ck) {
          ok(`files restored from checkpoint ${ck.id} (${ck.files} file(s))`)
          for (const n of ck.notes ?? []) console.log(dim(`  · ${n}`))
        }
        break
      }
      case "compact": {
        const did = await maybeCompact(true)
        if (!did && config.chat?.compact !== false) ok("history is small — nothing to compact")
        break
      }
      case "usage": {
        const conf = config.providers?.[p.name] || {}
        const cost = conf.priceIn != null || conf.priceOut != null
          ? `$${((sessionUsage.prompt / 1e6) * (conf.priceIn ?? 0) + (sessionUsage.completion / 1e6) * (conf.priceOut ?? 0)).toFixed(4)}`
          : null
        console.log(bold("session usage"))
        console.log(`  requests:   ${sessionUsage.requests}`)
        console.log(`  tokens in:  ${sessionUsage.prompt}`)
        console.log(`  tokens out: ${sessionUsage.completion}`)
        if (cost) console.log(`  est. cost:  ${cost}  ${dim("(providers." + p.name + ".priceIn/priceOut per 1M tok)")}`)
        else console.log(dim("  set providers." + p.name + ".priceIn/priceOut (USD per 1M tokens) for cost estimate"))
        break
      }
      case "tokens": {
        // v17: context gauge — how much of the model window this conversation uses
        const ctx = estimateTokens(JSON.stringify([{ role: "system", content: chatSystemPrompt(config, { toolsEnabled: chatToolsEnabled(), query: "" }) }, ...messages]))
        const window = p.contextWindow ?? 128000
        const pct = Math.min(100, Math.round((ctx / window) * 100))
        const N = 24
        const filled = Math.min(N, Math.round((pct / 100) * N))
        const bar = (pct > 85 ? red : green)("█".repeat(filled)) + dim("░".repeat(N - filled))
        const conf = config.providers?.[p.name] || {}
        const cost = conf.priceIn != null || conf.priceOut != null
          ? `$${((sessionUsage.prompt / 1e6) * (conf.priceIn ?? 0) + (sessionUsage.completion / 1e6) * (conf.priceOut ?? 0)).toFixed(4)}`
          : null
        console.log(bold("context / tokens"))
        console.log(`  ${bar}  ${pct}%   ~${ctx.toLocaleString()} / ${Math.round(window / 1000)}k tok   ${dim("(auto-compact fires at ~55%)")}`)
        console.log(`  session: ${sessionUsage.prompt} in / ${sessionUsage.completion} out • ${sessionUsage.requests} requests${cost ? ` • est. ${cost}` : ""}`)
        break
      }
      case "status": {
        const window = p.contextWindow ?? 128000
        const ctx = estimateTokens(JSON.stringify(messages))
        const pct = Math.min(100, Math.round((ctx / window) * 100))
        const mem = (await import("./memory.js")).memoryStats(process.cwd())
        console.log(bold("forge status"))
        console.log(`  provider:   ${cyan(p.name)} / ${bold(p.model)}  ${dim(`context ~${Math.round(window / 1000)}k tok`)}`)
        console.log(`  session:    ${sessionId ? dim(sessionId) : dim("(unsaved)")}`)
        console.log(`  cwd:        ${process.cwd()}`)
        console.log(`  turns:      ${Math.floor(messages.length / 2)} • ~${ctx.toLocaleString()} tok (${pct}% of window)`)
        console.log(`  effort:     profile=${cyan(config.chat?.profile ?? "auto")} • deep=${deep ? green("on") : "off"} • tools=${chatToolsEnabled() ? green("on") : "off"} • shell=${config.chat?.shellAuto === false ? yellow("! only") : green("auto")}`)
        console.log(`  memory:     global ${mem.globalLines} lines • project ${mem.projectLines} lines`)
        console.log(`  resources:  ${res.cores} cores • ${res.freeMB}MB free • tier ${res.tier}`)
        console.log(`  safety:     writes in-project only${config.tools?.allowOutsideProject ? yellow(" (boundary OFF)") : green("")} • sudo ${config.tools?.allowSudo ? yellow("allowed") : green("blocked")} • ssrf guard ${config.tools?.fetchPrivateUrls || process.env.FORGE_ALLOW_PRIVATE_URLS === "1" ? yellow("private allowed") : green("on")}`)
        break
      }
      case "profile": {
        const arg2 = (arg || "").trim().toLowerCase()
        const valid = ["fast", "balanced", "deep", "auto"]
        if (arg2 && valid.includes(arg2)) {
          config.chat.profile = arg2
          saveConfig(config)
          deep = arg2 === "deep" && !deepFlag ? true : deep
          ok(`effort profile → ${bold(arg2)}${arg2 === "auto" ? dim(" (complex tasks automatically get deep thinking)") : ""}`)
        } else if (arg2) {
          err(`unknown profile "${arg2}" — use: ${valid.join(" | ")}`)
        } else {
          console.log(bold("effort profile"))
          console.log(`  active:  ${cyan(config.chat?.profile ?? "auto")}`)
          console.log(`  fast     minimal reasoning, small budgets — quick answers`)
          console.log(`  balanced default — streaming chat, standard budgets`)
          console.log(`  deep     DEEP THINKING always on (reasoning params + 16k budgets)`)
          console.log(`  auto     classify each task: complex/critical → deep, rest → balanced`)
          console.log(dim(`  set with /profile <name> or forge --profile <name>`))
        }
        break
      }
      case "plan": {
        if (!arg) { err("usage: /plan <task>"); break }
        info("planning pass (read-only)…")
        const { runAgent, agentEventPrinter } = await import("./agent.js")
        abort = new AbortController()
        let res
        try {
          res = await runAgent({ config, provider: p, task: arg, onEvent: agentEventPrinter(), planOnly: true, deep: undefined, signal: abort.signal })
        } finally { abort = null }
        console.log()
        console.log(renderMarkdown(res.text))
        console.log()
        if (!process.stdin.isTTY) { warn("plan mode: non-interactive — not executing"); break }
        const confirm = await new Promise((resolve) => {
          const r2 = readline.createInterface({ input: process.stdin, output: process.stdout })
          r2.question(bold("execute this plan now? [y/N] "), (a) => { r2.close(); resolve(String(a || "").trim().toLowerCase()) })
        })
        if (confirm === "y" || confirm === "yes") {
          abort = new AbortController()
          let full
          try {
            full = await runAgent({ config, provider: p, task: arg, onEvent: agentEventPrinter(), deep: undefined, signal: abort.signal })
          } finally { abort = null }
          console.log()
          console.log(renderMarkdown(full.text))
          console.log(dim(`  (${full.steps} steps, ${full.toolLog.length} tool calls)`))
        } else warn("plan not executed")
        break
      }
      case "export": {
        if (!messages.length) { err("nothing to export yet"); break }
        const file = path.resolve(arg || `forge-session-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`)
        const md = [
          `# forge conversation`, "",
          `- date: ${new Date().toISOString()}`,
          `- provider: ${p.name} / ${p.model}`,
          `- session: ${sessionId ?? "(unsaved)"}`, "",
          ...messages.map((m) => {
            if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
              const calls = m.tool_calls.map((tc) => `  - \`${tc.function?.name}\` ${dim(String(tc.function?.arguments ?? "").slice(0, 120))}`).join("\n")
              return `## assistant (tool calls)\n\n${calls}\n`
            }
            if (m.role === "tool") return `## tool result (${m.tool_call_id ?? ""})\n\n\`\`\`\n${m.content}\n\`\`\`\n`
            return `## ${m.role}\n\n${m.content}\n`
          }),
        ].join("\n")
        fs.writeFileSync(file, md)
        ok(`exported ${messages.length} messages → ${file}`)
        break
      }
      case "model":
        if (arg) { p.model = arg; config.providers[p.name] = { ...(config.providers[p.name] || {}), model: arg }; pushRecentModel(config, p.name, arg); saveConfig(config); ok(`model → ${arg} (saved — it now tops your /model recents)`) }
        else console.log(`model: ${bold(p.model)}  ${dim(p.name + " • context ~" + Math.round((p.contextWindow ?? 128000) / 1000) + "k tok")}`)
        break
      case "provider":
        if (arg) {
          const c = getCatalog(arg)
          if (!c && !config.providers[arg]) { err(`unknown provider "${arg}"`); break }
          const name = c ? c.name : arg
          const conf = config.providers[name] || {}
          p.name = name; p.protocol = c?.protocol ?? conf.protocol ?? "openai"; p.baseUrl = conf.baseUrl || c?.baseUrl || ""; p.apiKey = conf.apiKey || envKeyFor(name) || ""; p.model = conf.model || c?.models?.[0] || ""
          config.activeProvider = name
          saveConfig(config)
          ok(`provider → ${name} (${p.model})`)
        } else console.log(`provider: ${bold(p.name)}`)
        break
      case "providers":
        for (const c of CATALOG) {
          const set = config.providers[c.name]?.apiKey || (c.envKey && process.env[c.envKey])
          console.log(`  ${bold(c.name.padEnd(15))} ${dim(c.label.padEnd(26))} ${set ? green("key ✓") : dim("no key")}`)
        }
        break
      case "models": {
        info(`fetching models from ${p.name}…`)
        const { models, live, warning } = await listModels({ protocol: p.protocol, baseUrl: p.baseUrl, apiKey: p.apiKey, catalog: getCatalog(p.name) })
        if (warning) warn(warning)
        console.log(dim(live ? "(live)" : "(built-in list)"))
        for (const m of models.slice(0, 50)) console.log("  " + (m === p.model ? green("● " + m) : "  " + m))
        if (models.length > 50) console.log(dim(`  … ${models.length - 50} more`))
        break
      }
      case "key": {
        if (!arg) { err("usage: /key <api-key>  (saved chmod 600)"); break }
        config.providers[p.name] = { ...(config.providers[p.name] || {}), apiKey: arg.trim() }
        p.apiKey = arg.trim()
        saveConfig(config)
        ok(`key saved for ${p.name} (${maskKey(p.apiKey)})`)
        break
      }
      case "skills": {
        const dir = resolveSkillsDir(config.skills?.dir)
        if (!dir) { err("no skills dir found"); break }
        if (arg) {
          const md = loadSkill(dir, arg)
          if (!md) { err(`skill "${arg}" not found`); break }
          messages.push({ role: "user", content: `Use this skill for my next requests. Acknowledge briefly.\n\n<skill name="${arg}">\n${md}\n</skill>` })
          ok(`skill "${arg}" loaded (${md.length} chars)`)
        } else {
          const idx = indexSkills(dir)
          console.log(bold(`skills (${idx.length}) — /skills <name> to load one`))
          for (const s of idx) console.log(`  ${cyan(s.name.padEnd(30))} ${dim(s.desc)}`)
        }
        break
      }
      case "tools": {
        const arg2 = (arg || "").trim().toLowerCase()
        if (arg2 === "on" || arg2 === "off") {
          config.chat.tools = arg2 === "on"
          saveConfig(config)
          ok(`auto-tools ${config.chat.tools ? "ON" : "OFF"} (${toolCount()} tools available to the model)`)
          break
        }
        console.log(bold(`forge tools (${toolCount()}) — auto-use ${chatToolsEnabled() ? "ON" : "OFF"}`))
        console.log(`  ${dim("web").padEnd(13)} web_search, fetch_url`)
        console.log(`  ${dim("files").padEnd(13)} read_file, write_file, edit_file, multi_edit, apply_patch, glob_files, list_dir, grep_files`)
        console.log(`  ${dim("shell").padEnd(13)} bash, git_status`)
        console.log(`  ${dim("agent-brain").padEnd(13)} think, todo, memory, delegate, load_skill`)
        console.log(dim("  /tools off = plain chat • /tools on = model auto-calls tools mid-chat • writes auto-checkpointed (/undo restores)"))
        break
      }
      case "shell": {
        // v19 terminal mode
        const arg2 = (arg || "").trim().toLowerCase()
        if (arg2 === "on" || arg2 === "off") {
          config.chat.shellAuto = arg2 === "on"
          saveConfig(config)
          ok(`shell auto-detect ${arg2.toUpperCase()}  ${dim("the ! prefix always works")}`)
          break
        }
        console.log(bold("terminal mode"))
        console.log(`  type any Linux command — ${SHELL_COMMANDS.size} commands auto-recognized — or prefix with ${cyan("!")} to force`)
        console.log(`  cd / export persist for this session • output shows here AND is shared with the model`)
        console.log(`  risky commands ask y/N first • catastrophic ones are always blocked`)
        console.log(`  auto-detect is ${config.chat?.shellAuto === false ? yellow("OFF") : green("ON")}  ${dim("(/shell on|off)")}`)
        break
      }
      case "deep": {
        // v19 deep think
        deep = !deep
        config.chat.deep = deep
        saveConfig(config)
        if (deep) ok("deep mode ON — structured reasoning, high reasoning effort where the provider supports it, bigger budgets")
        else ok("deep mode OFF")
        break
      }
      case "system":
        if (arg) { config.chat.system = arg; saveConfig(config); ok("system prompt updated") }
        else console.log(config.chat?.system ? dim(config.chat.system) : dim("(no extra system prompt)"))
        break
      case "stream":
        config.chat.stream = config.chat?.stream === false
        saveConfig(config)
        ok(`streaming ${config.chat.stream ? "on" : "off"}`)
        break
      case "config": {
        const safe = JSON.parse(JSON.stringify(config))
        for (const v of Object.values(safe.providers || {})) if (v.apiKey) v.apiKey = maskKey(v.apiKey)
        console.log(JSON.stringify(safe, null, 2))
        break
      }
      case "agent": {
        if (!arg) { err("usage: /agent <task>"); break }
        const { runAgent, agentEventPrinter } = await import("./agent.js")
        abort = new AbortController()
        let res
        try {
          res = await runAgent({ config, provider: p, task: arg, onEvent: agentEventPrinter(), deep: undefined, signal: abort.signal })
        } finally { abort = null }
        console.log()
        console.log(renderMarkdown(res.text))
        console.log(dim(`  (${res.steps} steps, ${res.toolLog.length} tool calls)`))
        console.log()
        break
      }
      default: err(`unknown /${cmd} — /help`)
    }
  }
}

// history persistence hooks (reassigned inside runChat)
let loadHistoryInto = () => {}
let saveHistory = () => {}
