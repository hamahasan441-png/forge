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
import { makeToolContext, toolCount, BUILTIN_TOOL_NAMES } from "./tools.js"
import { createToolIntel } from "./toolintel.js"
import { loadToolPlugins } from "./plugins.js"
import { classifyCommand, userMayRun } from "./shellguard.js"
import { restoreLast, restoreRun, listCheckpoints } from "./checkpoint.js"
import { indexSkills, loadSkill, resolveSkillsDir } from "./skills.js"
import { saveSession, loadSession, lastSessionFile, listSessions, findSession } from "./sessions.js"
import { relevantMemory } from "./memory.js"
import { profileSummary, resourceProfile, loadProfile } from "./profile.js"
import { classifyTaskComplexity } from "./agent.js"
import { redact } from "./secrets.js"
import { bold, dim, cyan, green, yellow, red, magenta, info, ok, warn, err, renderMarkdown, estimateTokens, printBanner } from "./ui.js"
import { VERSION } from "./version.js"
import { createTerminal } from "./terminal.js"
import { createUIStore, parseCheckOutput } from "./uistate.js"
import { createAgentView } from "./agentview.js"
import { renderDock, renderHeader, renderCheckpoints, renderWorkers, renderChanges, renderDiff, renderVerification, renderRecovery, renderErrorBlock, renderRepair, renderIdle, shortRun, shortCheckpoint, fmtMs, fmtTime, fit, padRight, mark, tildify } from "./render.js"
import { parseHistoryFile, serializeHistory, dedupe, historyWorthy } from "./editor.js"
import { unifiedDiff } from "./textdiff.js"
import { interruptedRuns, verifyRun, markRun, listRuns, resolveRunId } from "./runlog.js"
import { memoryStats, memoryEntries } from "./memory.js"

/** Command palette — one source of truth for /help, Tab completion and "did you mean". */
export const COMMANDS = [
  ["help", "", "this help"],
  ["status", "", "session + context + safety snapshot"],
  ["agent", "[task]", "Agent Mode (or run one task now; Ctrl+C cancels)"],
  ["normal", "", "Normal Chat mode (direct conversation)"],
  ["chat", "", "Normal Chat mode"],
  ["plan", "<task>", "plan first (read-only), confirm, then execute"],
  ["tasks", "", "recent agent runs — interrupted ones are flagged"],
  ["agents", "[n]", "sub-agents of the current/last run (/agent NN for one)"],
  ["checkpoints", "", "file checkpoints for this directory (newest first)"],
  ["diff", "[file]", "what changed this session, as a unified diff"],
  ["verify", "[command]", "run the project's test command (or yours) — shows exactly what ran"],
  ["details", "[n]", "full output of the last failed tool / error (n-th last)"],
  ["undo", "[--run [RUN-x]]", "drop the last exchange + restore its checkpoint • --run rolls back a whole run"],
  ["retry", "", "regenerate the last answer (also after Ctrl-C interrupts one)"],
  ["memory", "", "what forge remembers (global + this project)"],
  ["profile", "[name]", "effort profile: fast | balanced | deep | auto (auto = per-task)"],
  ["model", "[id]", "show or switch model (saved)"],
  ["provider", "[name]", "show or switch provider (env key respected)"],
  ["providers", "", "list providers (key status)"],
  ["models", "", "list models of active provider (live)"],
  ["key", "<api-key>", "set API key for active provider"],
  ["skills", "[name]", "list skills, or load one into the conversation"],
  ["tools", "[on|off]", "list the 17 agent tools, or toggle auto-tools in chat"],
  ["shell", "[on|off]", "terminal mode info / toggle Linux-command auto-detect"],
  ["deep", "", "toggle DEEP THINKING (high reasoning effort + bigger budgets)"],
  ["compact", "", "force context compaction (older turns → summary)"],
  ["usage", "", "session token totals + est. cost"],
  ["tokens", "", "context gauge — % of the model window used (auto-compact at ~55%)"],
  ["export", "[file]", "save the conversation as markdown"],
  ["sessions", "", "list saved conversations"],
  ["resume", "[n|id]", "resume the last (or listed) conversation"],
  ["new", "", "fresh conversation"],
  ["save", "", "save conversation to ~/.forge/sessions/"],
  ["system", "[text]", "show or set extra system prompt"],
  ["stream", "", "toggle streaming"],
  ["settings", "[key [value]]", "UI settings: dock, thinking, ascii, a11y, collapse"],
  ["config", "", "show config (keys masked)"],
  ["clear", "", "clear the screen (state is kept)"],
  ["exit", "", "leave (auto-saves)"],
]
const COMMAND_NAMES = new Set([...COMMANDS.map((c) => c[0]), "quit"])

const HELP = `
${bold("chat")}
  type anything          talk to the model (streaming)
  end a line with \\      multiline input (continuation prompt) • pasted text is inserted as-is
${bold("modes")}
  /agent [task]         activate Agent Mode (or run a task directly; Ctrl+C cancels)
  /normal               switch to Normal Chat mode (direct conversation)
  /chat                 switch to Normal Chat mode
  /plan <task>          plan first (read-only), confirm, then execute
${bold("task & recovery")}
  /status               session + context + safety snapshot
  /tasks                recent agent runs — interrupted ones are flagged
  /agents [n]           sub-agents of the current/last run (/agent NN for one)
  /checkpoints          file checkpoints for this directory (newest first)
  /diff [file]          what changed this session, as a unified diff
  /verify [command]     run the project's test command (or yours) — shows exactly what ran
  /details [n]          full output of the last failed tool / error (n-th last)
  /undo                 drop the last exchange + restore its file checkpoint
  /undo --run [RUN-x]   roll back a whole agent run (newest, or the given run id)
  /retry                regenerate the last answer (also after Ctrl-C interrupts one)
${bold("context")}
  /memory               what forge remembers (global + this project)
  /compact              force context compaction (older turns → summary)
  /usage                session token totals + est. cost
  /tokens               context gauge — % of the model window used (auto-compact at ~55%)
  /export [file]        save the conversation as markdown
  /sessions             list saved conversations
  /resume [n|id]        resume the last (or listed) conversation
  /new                  fresh conversation
  /save                 save conversation to ~/.forge/sessions/
${bold("setup")}
  /profile [name]       effort profile: fast | balanced | deep | auto (auto = per-task)
  /model [id]           show or switch model (saved)
  /provider [name]      show or switch provider (env key respected)
  /providers            list providers (key status)
  /models               list models of active provider (live)
  /key <api-key>        set API key for active provider
  /skills [name]        list skills, or load one into the conversation
  /tools [on|off]       list the 17 agent tools, or toggle auto-tools in chat
  /shell [on|off]       terminal mode info / toggle Linux-command auto-detect
  !<command>            force-execute a shell command right here (always works)
  /deep                 toggle DEEP THINKING (high reasoning effort + bigger budgets)
  /system [text]        show or set extra system prompt
  /stream               toggle streaming
  /settings [k [v]]     UI settings: dock on|off • thinking on|off • ascii on|off • a11y on|off
  /config               show config (keys masked)
  /clear                clear the screen (state is kept)
  /exit                 leave (auto-saves)
${bold("keys")}
  ↑/↓ history (prefix-aware) • Ctrl+R reverse search • Tab completion • Alt+Enter newline
  Ctrl+A/E line start/end • Ctrl+W delete word • Alt+←/→ word jump • Ctrl+U/K kill • Ctrl+Y yank
  Ctrl+C cancel task / clear input / twice to exit • Ctrl+D exit • Ctrl+L redraw
`.trim()

/** "did you mean" for unknown slash commands. */
export function suggestCommand(name) {
  const n = String(name || "").toLowerCase()
  if (!n) return []
  const dist = (a, b) => {
    const m = a.length, k = b.length
    const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(k).fill(0)])
    for (let j = 1; j <= k; j++) d[0][j] = j
    for (let i = 1; i <= m; i++) for (let j = 1; j <= k; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    return d[m][k]
  }
  const names = [...COMMAND_NAMES]
  const scored = names.map((c) => ({ c, d: c.startsWith(n) ? 0 : dist(n, c) })).filter((x) => x.d <= Math.max(1, Math.floor(n.length / 2))).sort((a, b) => a.d - b.d || a.c.localeCompare(b.c))
  return scored.slice(0, 3).map((x) => x.c)
}

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

  // v20.5: chat tool calls go through the same capability registry, router,
  // policy gate, failure classification and verification as the agent loop —
  // one implementation, not a second one. The UI rows below are unchanged.
  // The structured TOOL_* events feed the premium UI exactly as in agent mode
  // (verification results, blocks, retries, escalations, cache hits). The tool
  // ROWS are still emitted by the chat loop below, and `legacyEvents: false`
  // keeps the layer from emitting a second copy of them.
  let chatUIEvent = null // set once the terminal UI exists (declared below)
  const chatIntel = createToolIntel({
    exec: tools.exec,
    ctx: { cwd: process.cwd(), root: process.cwd(), readOnly: false, allowSudo: config.tools?.allowSudo === true, assumeYes },
    config,
    onEvent: (ev) => chatUIEvent?.(ev),
    taskId: "chat",
    plugins,
    legacyEvents: false,
  })

  // ---- v20.4 terminal UI: ONE coordinator owns stdout while interactive ------
  // Piped/non-TTY sessions never touch it: `ui` is null there and every print
  // below falls through to plain console output (byte-identical to v20.3).
  const interactiveUI = process.stdin.isTTY === true && process.stdout.isTTY === true && !oneShot && process.env.FORGE_UI !== "plain"
  const uiCfg = config.ui || {}
  const term = interactiveUI ? createTerminal({ ascii: uiCfg.ascii === true ? true : undefined, a11y: uiCfg.a11y === true ? true : undefined }) : null
  const store = createUIStore({ mode: "chat", provider: p.name, model: p.model, cwd: process.cwd(), terminal: { columns: term?.columns ?? 80, rows: term?.rows ?? 24, tty: !!term } })
  const view = term ? createAgentView({ term, store, cwd: process.cwd(), plain: uiCfg.dock === false, showThinking: uiCfg.thinking !== false }) : null
  const ui = term ? { term, store, view } : null
  // now that the view exists, let the tool intelligence layer talk to it
  chatUIEvent = (ev) => { if (ui) ui.view.onEvent(ev) }
  const out = (line = "") => (ui ? ui.term.line(line) : console.log(line))
  const outLines = (lines) => { if (ui) ui.term.lines(lines); else for (const l of lines) console.log(l) }
  const dispatchUI = (ev) => store.dispatch(ev)
  const o = term?.opts
  const recentRuns = () => listRuns({ cwd: process.cwd(), max: 20 })
  let lastAgentState = null // snapshot of the UI state when the last run ended (for /agents, /diff, /details)

  // v20: chat line log for persistent history (~/.forge/history) — shared by
  // the TTY REPL and the piped line processor, so both persist what was typed.
  // v20.4: multiline entries survive (one encoded line each), secrets never land.
  const chatLineLog = []
  function readHist() {
    try { return parseHistoryFile(fs.readFileSync(HISTORY_PATH, "utf8")) } catch { return [] }
  }
  saveHistory = () => {
    try {
      const live = ui ? ui.term.editor.history : [...shellState.history, ...chatLineLog]
      const all = dedupe([...readHist(), ...live].filter(historyWorthy))
      fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true })
      fs.writeFileSync(HISTORY_PATH, serializeHistory(all.slice(-Math.max(50, config.chat?.historySize ?? 300))), { mode: 0o600 })
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

  const termWidth = () => Math.min((ui ? ui.term.columns : process.stdout.columns) || 80, 120)

  function printTerminal(cmd, result) {
    const w = termWidth()
    const rows = []
    rows.push(dim(`┌─ terminal ${"─".repeat(Math.max(3, Math.min(40, w - cmd.length - 14)))}`))
    rows.push(dim("$ ") + cmd)
    const lines = String(result).split("\n")
    rows.push(lines.slice(0, 40).map((l) => dim("│ ") + l).join("\n"))
    if (lines.length > 40) rows.push(dim(`│ … ${lines.length - 40} more lines (${String(result).length} bytes total)`))
    rows.push(dim("└─"))
    outLines(rows)
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
    if (ui) return ui.term.ask(yellow(`! ${risk} — run it? [y/N] `)).then((a) => /^y(es)?$/i.test(String(a || "").trim()))
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
    if (base === "clear") { if (ui) ui.term.clearScreen(); else process.stdout.write("\x1b[2J\x1b[H"); return }
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
    // the user just ran a command in the same working tree: whatever the tool
    // intelligence layer cached about file contents may now be stale (v20.5.1)
    chatIntel.invalidate()
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

  // Ctrl+C: first press aborts the current stream/agent, second press exits.
  // v20.4: in the interactive UI the raw-mode terminal delivers Ctrl+C as a key
  // (see onCancel below) — SIGINT only fires for the legacy/piped paths.
  let multilineBuf = null
  /** Honest cancellation: request it, show what we are waiting for, never
   *  claim success before the tool/stream has actually stopped. */
  function requestCancel() {
    if (!abort) return false
    const ctrl = abort
    abort = null
    dispatchUI({ type: "USER_INTERRUPTED", phase: "requested" })
    ctrl.abort()
    return true
  }
  function exitNow(code = 0) {
    saveHistory()
    persist()
    if (ui) { try { ui.view.stop(); ui.term.stop() } catch {} }
    process.exit(code)
  }
  process.on("SIGINT", () => {
    if (ui) { if (!requestCancel()) exitNow(0); return }
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
    let started = false
    for await (const ev of streamChatResilient(
      { protocol: p.protocol, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model, providerName: p.name, messages: wire, tools: chatToolsEnabled() ? chatIntel.toolDefs(tools.defs) : undefined, maxTokens: deepEffort ? 16384 : 8192, deep: deepEffort, signal, connectMs: config.retry?.connectMs, firstByteMs: config.retry?.firstByteMs },
      { attempts: config.retry?.attempts ?? 3, backoffMs: config.retry?.backoffMs ?? 1500, onRetry: ({ attempt, attempts, error }) => console.log(yellow(`  ↻ ${error} — retry ${attempt}/${attempts}…`)) }
    )) {
      if (ev.type === "text") {
        if (!started) { started = true; dispatchUI({ type: "STREAMING", on: true }) }
        process.stdout.write(ev.text); text += ev.text; onText?.(ev.text)
      } else if (ev.type === "reasoning") {
        if (config.chat?.showReasoning !== false && uiCfg.thinking !== false) process.stdout.write(dim(ev.text.slice(0, 1600)))
      } else if (ev.type === "tool_calls") toolCalls = ev.calls
      else if (ev.type === "usage") trackUsage(ev.usage)
      else if (ev.type === "error") err(ev.error)
    }
    if (started) dispatchUI({ type: "STREAMING", on: false })
    return { text, toolCalls }
  }

  /** One non-streaming round with tools. */
  async function plainRound(wire, deepEffort) {
    const msg = await chatOnce({ protocol: p.protocol, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model, providerName: p.name, messages: wire, tools: chatToolsEnabled() ? chatIntel.toolDefs(tools.defs) : undefined, maxTokens: deepEffort ? 16384 : 8192, deep: deepEffort, connectMs: config.retry?.connectMs, requestTimeoutMs: config.retry?.requestTimeoutMs })
    if (msg.reasoning && config.chat?.showReasoning !== false) console.log(dim("·thinking· " + msg.reasoning.slice(0, 800)))
    if (msg.content) process.stdout.write(msg.content)
    trackUsage(msg.usage)
    return { text: msg.content ?? "", toolCalls: msg.toolCalls ?? [] }
  }

  /** Execute tool calls (v16: reads in parallel, writes serialized), print
   *  activity, append CANONICAL wire-format messages to history. */
  async function runToolCalls(toolCalls) {
    if (ui) ui.term.endStream(); else process.stdout.write("\n")
    const parsed = toolCalls.map((tc) => {
      let args = {}
      try { args = JSON.parse(tc.args || "{}") } catch {}
      return { tc, args, argStr: JSON.stringify(args).slice(0, 140) }
    })
    // v20.4 interactive: tool rows come from UI state (compact, collapsible,
    // /details expands) — the piped path keeps the classic ┌/└ lines.
    if (ui) {
      if (!store.state.task) dispatchUI({ type: "TASK_STARTED", kind: "chat", title: "chat tools", id: null })
      for (const { tc } of parsed) ui.view.onEvent({ type: "tool_start", name: tc.name, args: tc.args, step: 1 })
    } else for (const { tc, argStr } of parsed) console.log(dim(`  ┌ [chat] ${cyan(tc.name)} ${dim(argStr)}`))
    // v20.5: the router schedules the batch (independent read-only calls
    // concurrently, mutations serialized, conflicting writes never together)
    // and every call passes the same gate + verification as in agent mode.
    const results = await chatIntel.runBatch(parsed.map(({ tc, args }) => ({ id: tc.id, name: tc.name, args })))
    for (let i = 0; i < parsed.length; i++) {
      const { tc } = parsed[i]
      if (!results[i]) results[i] = { result: "ERROR: tool did not run", ms: 0 }
      const { result, ms } = results[i]
      if (ui) { ui.view.onEvent({ type: "tool_result", name: tc.name, result: String(result), step: 1, ms }); continue }
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
    if (!ui) process.stdout.write("\n")
    const eff = effortFor(userText)
    if (eff.notice) out(dim(`  · ${eff.notice}`))
    const systemPrompt = chatSystemPrompt(config, { toolsEnabled: chatToolsEnabled(), deep: eff.deep, query: String(userText).slice(0, 400) })
    abort = new AbortController()
    const signal = abort.signal
    let full = ""
    let overflowTries = 0
    // v20.4: a chat turn is a lightweight task for the UI (status "Thinking 3.2s",
    // Ctrl+C cancels it) — the dock stays minimal for chat-kind tasks.
    if (ui) dispatchUI({ type: "TASK_STARTED", kind: "chat", title: String(userText).slice(0, 80), id: null })
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
          if (ui) dispatchUI({ type: "STREAMING", on: false })
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
      if (ui) ui.term.endStream(); else process.stdout.write("\n")
    } catch (e) {
      if (ui) ui.term.endStream(); else process.stdout.write("\n")
      if (e?.name === "AbortError") {
        if (ui) dispatchUI({ type: "USER_INTERRUPTED", phase: "stopped" })
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
      if (ui && (!full || !full.trim())) dispatchUI({ type: "TASK_RESET" })
    }
    if (full.trim()) messages.push({ role: "assistant", content: full })
    const u = lastUsage
    if (u?.prompt_tokens || u?.completion_tokens) out(dim(`  (${u.prompt_tokens ?? "?"} in / ${u.completion_tokens ?? "?"} out tok) • session: ${sessionUsage.prompt} in / ${sessionUsage.completion} out`))
    else out(dim(`  (~${estimateTokens(JSON.stringify(messages))} tok ctx) • session: ${sessionUsage.prompt} in / ${sessionUsage.completion} out`))
    persist() // auto-save after every turn — crash-safe
    out()
    if (ui) dispatchUI({ type: "TASK_RESET" })
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

  let mode = "normal"
  const getPrompt = () => (mode === "agent" ? bold(magenta("forge")) + cyan(" [agent]") + dim(" ❯ ") : bold(magenta("forge")) + dim(" ❯ "))
  const setMode = (m) => {
    mode = m
    dispatchUI({ type: "MODE_CHANGED", mode: m === "agent" ? "agent" : "chat" })
    if (ui) ui.term.setPrompt(getPrompt())
    else rl?.setPrompt(getPrompt())
  }

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
  // loadHistoryInto pre-populates the readline history (legacy TTY path only).
  loadHistoryInto = () => {
    try {
      const hist = readHist()
      for (let i = hist.length - 1; i >= 0; i--) {
        if (!rl.history.includes(hist[i])) rl.history.unshift(hist[i])
      }
    } catch {}
  }

  // Serialize line handling: a streaming turn must finish before the next
  // line is processed.
  let queue = Promise.resolve()
  let busy = false
  const enqueue = (line) => {
    queue = queue
      .then(async () => { busy = true; try { await handleLine(line) } finally { busy = false } })
      .catch((e) => { err(e?.message ?? String(e)); promptSafe() })
  }

  if (ui) {
    // ---- v20.4 interactive terminal: raw-mode editor + render lock -----------
    ui.term.start({
      prompt: getPrompt(),
      continuation: dim("… ") + " ",
      history: readHist(),
      onSubmit: (text) => enqueue(text),
      completer: uiCompleter,
      onResize: ({ columns, rows }) => dispatchUI({ type: "TERMINAL_RESIZED", columns, rows }),
      onCancel: ({ hadText }) => {
        if (abort) { requestCancel(); return "cancelled" }
        if (hadText) return "cleared"
        if (busy) return "busy" // a command that cannot be cancelled is finishing
        return "exit" // idle + empty: coordinator asks for a second Ctrl+C
      },
      onEOF: () => {
        queue.catch(() => {}).then(() => {
          out(dim("bye"))
          exitNow(0)
        })
      },
    })
    ui.term.setDock((cols, rows) => (uiCfg.dock === false ? [renderHeader(store.state, cols, o)] : renderDock(store.state, cols, rows, o)))
    queue = queue.then(() => startupRecovery()).catch((e) => err(e?.message ?? String(e)))
    return new Promise(() => {}) // the coordinator owns the event loop until exit
  }

  const rl2 = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: getPrompt(),
    completer: completer,
  })
  rl = rl2
  loadHistoryInto()
  rl.prompt()

  rl.on("line", (line) => enqueue(line))
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
    const cmds = COMMANDS.map((c) => "/" + c[0])
    const hits = cmds.filter((c) => c.startsWith(line))
    return [hits.length ? hits : cmds, line]
  }

  /** Tab completion for the v20.4 editor: slash commands (+ their arguments),
   *  shell commands at line start, and file paths after a shell command. */
  function uiCompleter(before) {
    const m = before.match(/^(\s*)(\S*)$/)
    if (m) {
      const word = m[2]
      const from = m[1].length
      if (word.startsWith("/")) {
        const names = COMMANDS.map((c) => "/" + c[0]).filter((c) => c.startsWith(word))
        return { candidates: names, replaceFrom: from }
      }
      if (word.startsWith("!")) {
        const hits = [...SHELL_COMMANDS].filter((c) => c.startsWith(word.slice(1))).sort().map((c) => "!" + c)
        return { candidates: hits, replaceFrom: from }
      }
      if (word && !word.includes("/")) {
        const hits = [...SHELL_COMMANDS].filter((c) => c.startsWith(word)).sort()
        return hits.length ? { candidates: hits, replaceFrom: from } : null
      }
      if (!word) return null
    }
    // slash command arguments
    const sm = before.match(/^\/(\w+)\s+(\S*)$/)
    if (sm) {
      const [, cmd, part] = sm
      const from = before.length - part.length
      const pick = (list) => ({ candidates: list.filter((x) => x.startsWith(part)), replaceFrom: from })
      if (cmd === "profile") return pick(["fast", "balanced", "deep", "auto"])
      if (cmd === "tools" || cmd === "shell") return pick(["on", "off"])
      if (cmd === "settings") return part.includes("=") ? null : pick(["dock", "thinking", "ascii", "a11y", "collapse"])
      if (cmd === "provider") return pick(CATALOG.map((c) => c.name))
      if (cmd === "skills") { try { return pick(indexSkills(resolveSkillsDir(config.skills?.dir)).map((x) => x.name)) } catch { return null } }
      if (cmd === "undo") return pick(["--run"])
      if (cmd === "diff") return pathCandidates(part, from)
      return null
    }
    // shell command argument → path completion
    const pm = before.match(/^!?\S+(?:\s+\S+)*\s+(\S*)$/)
    if (pm && (isShellLine(before) || before.startsWith("!"))) return pathCandidates(pm[1], before.length - pm[1].length)
    return null
  }
  function pathCandidates(part, from) {
    try {
      const expanded = part.startsWith("~/") ? path.join(process.env.HOME || "", part.slice(2)) : part
      const dir = expanded.endsWith("/") ? expanded : path.dirname(expanded || ".")
      const base = expanded.endsWith("/") ? "" : path.basename(expanded)
      const abs = path.resolve(shellState.cwd, dir || ".")
      const ents = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.name.startsWith(base) && (base.startsWith(".") || !e.name.startsWith("."))).slice(0, 200)
      const prefix = part.endsWith("/") || !part ? part : part.slice(0, part.length - base.length)
      return { candidates: ents.map((e) => prefix + e.name + (e.isDirectory() ? "/" : "")).sort(), replaceFrom: from }
    } catch { return null }
  }

  /** v20.4 crash-safe startup: journals left at "running" by a process that no
   *  longer exists are interrupted tasks. Show them, never continue silently. */
  async function startupRecovery() {
    let runs = []
    try { runs = interruptedRuns({ cwd: process.cwd() }) } catch { runs = [] }
    if (!runs.length) return
    for (const run of runs.slice(0, 3)) await recoveryPrompt(run, { startup: true })
  }
  async function recoveryPrompt(run, { startup = false } = {}) {
    dispatchUI({ type: "MODE_CHANGED", mode: "recovery" })
    dispatchUI({ type: "RECOVERY_STARTED", run, note: "Interrupted task found" })
    const cps = listCheckpoints(process.cwd(), 999).filter((c) => c.runId === run.runId).map((c) => c.id)
    const rec = { ...run, checkpoints: run.checkpoints?.length ? run.checkpoints : cps.reverse() }
    outLines(renderRecovery(rec, termWidth(), o, { startup }))
    for (;;) {
      const a = ui ? await ui.term.ask(bold("recovery › "), { single: true, keys: ["r", "v", "u", "c"] }) : "c"
      if (a === "v") {
        const v = verifyRun(rec)
        out(`  ${o.th.muted(padRight("Filesystem", 18))} ${v.filesystem}`)
        out(`  ${o.th.muted(padRight("Checkpoints", 18))} ${v.checkpoints}`)
        rec.verify = { filesystem: v.filesystem, checkpoints: v.checkpoints }
        markRun(run.runId, "running", { verify: rec.verify })
        out(o.th.muted("  [R] Resume   [V] Verify   [U] Undo   [C] Cancel (keep as-is)"))
        continue
      }
      if (a === "u") {
        const r = restoreRun(process.cwd(), run.runId)
        if (r) { ok(`restored ${r.files} file(s) across ${r.checkpoints} checkpoint(s) from ${shortRun(run.runId)}`); for (const n of r.notes ?? []) out(dim(`  · ${n}`)) }
        else warn("nothing to restore — this run left no checkpoints")
        markRun(run.runId, "undone", { note: "undone by user at recovery" })
        break
      }
      if (a === "r") {
        markRun(run.runId, "cancelled", { note: "resumed as a new run" })
        dispatchUI({ type: "RECOVERY_COMPLETED" })
        setMode("agent")
        ok(`resuming ${shortRun(run.runId)} as a new run — the agent re-inspects the tree before touching anything`)
        const task = `Resume this interrupted task. It was stopped at step ${run.step ?? "?"}${run.lastTool ? ` while running ${run.lastTool.name} ${run.lastTool.target || ""}` : ""}; the files it touched so far: ${Object.keys(run.files || {}).map((f) => path.relative(process.cwd(), f)).join(", ") || "(none recorded)"}. First inspect the current state of those files and the repository, then continue from where it stopped. Do not redo work that is already done.\n\nOriginal task: ${run.task}`
        await dispatch(task)
        return
      }
      // cancel / Esc / Ctrl-C: keep the tree as-is, stop asking
      markRun(run.runId, "cancelled", { note: "left as-is by user at recovery" })
      warn(`${shortRun(run.runId)} left as-is — /undo --run ${shortRun(run.runId)} rolls it back later, /tasks lists it`)
      break
    }
    dispatchUI({ type: "RECOVERY_COMPLETED" })
    setMode(mode)
  }

  async function handleLine(line) {
    if (ui) { await dispatch(line); return } // the editor already joined multiline input
    // v20 multiline: a trailing backslash continues the input on the next line
    if (multilineBuf !== null) {
      const joined = multilineBuf + "\n" + line
      if (/\\$/.test(line) && !/\\\\$/.test(line)) { multilineBuf = joined.replace(/\\$/, ""); rl?.setPrompt(dim("… ") + " "); promptSafe(); return }
      multilineBuf = null
      rl?.setPrompt(getPrompt())
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
    if (mode === "agent") {
      await runAgentTask(t)
      promptSafe()
      return
    }
    await turn(t)
    promptSafe()
  }

  /** One autonomous run (Agent Mode line or /agent <task>). In the interactive
   *  UI the run is rendered from UI state (dock, status, compact tool rows,
   *  honest completion summary); piped sessions keep the classic printer. */
  async function runAgentTask(task, { planOnly = false, deep: deepOverride } = {}) {
    const { runAgent, agentEventPrinter } = await import("./agent.js")
    abort = new AbortController()
    const t0 = Date.now()
    const eff = deepOverride === undefined ? effortFor(task) : { deep: deepOverride, notice: "" }
    if (eff.notice) out(dim(`  · ${eff.notice}`))
    if (ui) dispatchUI({ type: "MODE_CHANGED", mode: planOnly ? "plan" : "agent" })
    let res = null
    try {
      res = await runAgent({ config, provider: p, task, onEvent: ui ? ui.view.onEvent : agentEventPrinter(), planOnly, deep: eff.deep, signal: abort.signal })
      if (ui) {
        lastAgentState = store.state
        ui.view.printResult(res, { elapsedMs: Date.now() - t0, planOnly })
        if (!planOnly && !(res.text || "").includes("(reached max steps")) {
          messages.push({ role: "user", content: `[agent task] ${task}` })
          messages.push({ role: "assistant", content: res.text })
          persist()
        }
        out()
      } else {
        console.log()
        console.log(bold(planOnly ? cyan("── plan " + "─".repeat(54)) : green("── result " + "─".repeat(50))))
        console.log(renderMarkdown(res.text))
        console.log(dim(`  ${res.steps} steps • ${res.toolLog.length} tool calls • ${((Date.now() - t0) / 1000).toFixed(1)}s`))
        if (res.wrote && res.runId) console.log(dim(`  undo this whole run: ${cyan("forge undo --run")}`))
        if (!planOnly) {
          messages.push({ role: "user", content: `[agent task] ${task}` })
          messages.push({ role: "assistant", content: res.text })
          persist()
        }
        console.log()
      }
    } catch (e) {
      if (ui) {
        lastAgentState = store.state
        if (e?.name === "AbortError" || abort === null && store.state.cancel) {
          dispatchUI({ type: "USER_INTERRUPTED", phase: "stopped" })
          ui.view.printResult(res, { aborted: true })
        } else {
          dispatchUI({ type: "TASK_FAILED", reason: e?.message ?? String(e) })
          ui.view.printResult(res, { error: e?.message ?? String(e) })
        }
        out()
      } else {
        console.log()
        if (e?.name === "AbortError") err("agent run aborted")
        else err(`agent error: ${e?.message ?? e}`)
      }
    } finally {
      abort = null
      if (ui) { dispatchUI({ type: "TASK_RESET" }); dispatchUI({ type: "MODE_CHANGED", mode: mode === "agent" ? "agent" : "chat" }) }
    }
    return res
  }

  async function handleCommand(t) {
    const [cmd, ...rest] = t.slice(1).split(/\s+/)
    const arg = rest.join(" ")
    switch (cmd) {
      case "help": out(HELP); break
      case "exit": case "quit": {
        persist()
        out(dim("bye"))
        saveHistory()
        if (ui) { try { ui.view.stop(); ui.term.stop() } catch {} }
        setTimeout(() => process.exit(0), 30) // let buffered stdout flush
        break
      }
      case "clear": {
        if (ui) ui.term.clearScreen(); else process.stdout.write("\x1b[2J\x1b[H")
        break
      }
      case "tasks": {
        const runs = recentRuns()
        if (!runs.length) { warn("no agent runs recorded yet for this directory"); break }
        const rows = [bold("TASKS") + dim("  (this directory, newest first)")]
        for (const r of runs.slice(0, 12)) {
          const interrupted = r.status === "running"
          const st = interrupted ? yellow("INTERRUPTED") : r.status === "completed" ? green("completed") : r.status === "cancelled" ? yellow("cancelled") : r.status === "undone" ? dim("undone") : red("failed")
          const files = Object.keys(r.files || {}).length
          rows.push(fit(`  ${padRight(shortRun(r.runId), 9)} ${padRight(st, 22)} ${padRight(fmtTime(r.startedAt), 6)} ${dim(`${r.step ?? 0} steps${files ? ` • ${files} file${files === 1 ? "" : "s"}` : ""}${r.checkpoints?.length ? ` • ${shortCheckpoint(r.checkpoints[r.checkpoints.length - 1])}` : ""}`)}  ${r.task}`, termWidth() - 1))
        }
        const openRuns = runs.filter((r) => r.status === "running")
        if (openRuns.length) rows.push(dim(`  ${openRuns.length} interrupted — /undo --run ${shortRun(openRuns[0].runId)} rolls one back; restart forge to get the recovery prompt`))
        outLines(rows)
        break
      }
      case "agents": {
        const st = store.state.task ? store.state : lastAgentState
        const workers = st?.workers ?? []
        if (!workers.length) { info("no sub-agents in the current/last run — the agent delegates with the `delegate` tool when a task splits"); break }
        if (arg && /^\d+$/.test(arg)) {
          const w = workers.find((x) => x.n === Number(arg))
          if (!w) { err(`no worker ${arg}`); break }
          const rows = [bold(`WORKER ${String(w.n).padStart(2, "0")}`) + `  ${w.role}  ${w.status}  ${dim(fmtMs((w.endedAt || Date.now()) - w.startedAt))}`, `  task: ${w.task}`]
          if (w.report) rows.push("", ...String(w.report).split("\n").slice(0, 40).map((l) => "  " + l))
          outLines(rows)
          break
        }
        outLines(renderWorkers(workers, termWidth(), o ?? (await import("./render.js")).renderOptions({})))
        break
      }
      case "checkpoints": {
        const list = listCheckpoints(process.cwd(), 20)
        outLines(renderCheckpoints(list, termWidth(), o ?? (await import("./render.js")).renderOptions({})))
        if (list.length) out(dim("  /undo restores the newest • /undo --run RUN-x rolls back a whole run • forge undo from the shell"))
        break
      }
      case "diff": {
        const bctx = ui?.view.bctx
        const changes = Object.values(store.state.changes)
        if (!changes.length) { info("no file changes recorded in this session yet"); break }
        const target = arg ? path.resolve(process.cwd(), arg) : null
        const files = target ? changes.filter((c) => c.path === target || c.path.endsWith("/" + arg)) : changes
        if (!files.length) { err(`no recorded change for ${arg}`); break }
        const ro = o ?? (await import("./render.js")).renderOptions({})
        if (!arg) outLines(renderChanges(store.state.changes, termWidth(), ro, { cwd: process.cwd() }))
        let shown = 0
        for (const f of files.slice(0, arg ? 1 : 6)) {
          const before = bctx?.before.get(f.path)
          let after = null
          try { after = fs.existsSync(f.path) ? fs.readFileSync(f.path, "utf8") : "" } catch { after = null }
          const rel = path.relative(process.cwd(), f.path)
          if (before?.text == null && before?.exists) { out(dim(`  ${rel}: original too large to diff (${before.size} bytes) — +${f.added} -${f.removed}`)); continue }
          if (!before || after == null) { out(dim(`  ${rel}: ${f.action} +${f.added} -${f.removed} (no baseline captured — created outside the UI)`)); continue }
          const text = unifiedDiff(before.exists ? before.text : "", after, { path: rel })
          if (!text) { out(dim(`  ${rel}: no textual difference from the session baseline`)); continue }
          outLines(renderDiff(text, termWidth(), ro, { max: arg ? 400 : 60 }))
          shown++
        }
        if (!arg && files.length > 6) out(dim(`  … ${files.length - 6} more files — /diff <file> for one`))
        void shown
        break
      }
      case "verify": {
        let command = arg
        if (!command) {
          try { command = loadProfile(process.cwd()).scripts?.test || "" } catch { command = "" }
        }
        if (!command) { warn("no test command detected for this project — /verify <command> to run one explicitly"); break }
        const verdict = userMayRun(command, { cwd: process.cwd(), root: process.cwd() }, { interactive: !!ui, assumeYes })
        if (!verdict.ok) { err(verdict.reason); break }
        if (verdict.needsConfirm && !(await confirmPrompt(verdict.reason ?? verdict.level))) { warn("skipped"); break }
        info(`verify: ${bold(command)}`)
        const t0 = Date.now()
        if (ui) { dispatchUI({ type: "TASK_STARTED", kind: "chat", title: `verify: ${command}`, id: null }); dispatchUI({ type: "TEST_STARTED", command }) }
        const timeoutMs = Math.min(600, Math.max(1, config.agent?.timeoutSec ?? 45) * 4) * 1000
        const result = await new Promise((resolve) => {
          execFile("/bin/sh", ["-c", command], { cwd: process.cwd(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, killSignal: "SIGKILL", env: { ...process.env, ...shellState.env, TERM: "dumb" } }, (error, stdout, stderr) => {
            let r = ""
            if (stdout) r += stdout
            if (stderr) r += (r ? "\n--- stderr ---\n" : "") + stderr
            if (error && !r) r = String(error.message)
            else if (error && error.killed) r += `\n[command timed out after ${timeoutMs / 1000}s]`
            else if (error && typeof error.code === "number") r += `\n[exit code: ${error.code}]`
            resolve(r || "(no output)")
          })
        })
        const parsed = parseCheckOutput("tests", result)
        const ms = Date.now() - t0
        if (ui) {
          dispatchUI({ type: "TEST_COMPLETED", command, passed: parsed.passed, failed: parsed.failed, ok: parsed.ok })
          store.dispatch({ type: "TOOL_COMPLETED", id: `verify-${t0}`, name: "bash", target: command, ok: parsed.ok, exit: parsed.exit, ms, lines: result.split("\n").length, summary: result.split("\n").filter((l) => l.trim()).slice(-3), output: result, check: "tests", checkResult: parsed })
          dispatchUI({ type: "TASK_RESET" })
        }
        const ro = o ?? (await import("./render.js")).renderOptions({})
        const tail = result.split("\n").filter((l) => l.trim()).slice(-12)
        outLines(tail.map((l) => dim("  │ ") + l))
        outLines(renderVerification({ tests: { ok: parsed.ok, passed: parsed.passed, failed: parsed.failed, summary: parsed.summary, command } }, {}, termWidth(), ro))
        out(dim(`  ${command} • exit ${parsed.exit} • ${fmtMs(ms)}${parsed.ok ? "" : " • /details shows the full output"}`))
        noteTerminal(command, result)
        break
      }
      case "details": {
        const st = store.state
        const pool = [...(st.details || []), ...((store.state.task ? [] : lastAgentState?.details) || [])]
        const failed = pool.filter((d) => d.ok === false)
        const list = failed.length ? failed : pool
        if (!list.length && !st.lastError && !lastAgentState?.lastError) { info("nothing to show — /details expands the last failed tool output or error"); break }
        const n = arg && /^\d+$/.test(arg) ? Number(arg) : 1
        const d = list[list.length - n]
        const ro = o ?? (await import("./render.js")).renderOptions({})
        if (d) {
          const rows = [bold(`DETAILS`) + dim(`  ${d.name} ${d.target || ""}  ${d.ok === false ? red("failed") : green("ok")}  ${fmtTime(d.at)}`)]
          const lines = String(d.text).split("\n")
          const max = 200
          rows.push(...lines.slice(0, max).map((l) => "  " + l))
          if (lines.length > max) rows.push(dim(`  … ${lines.length - max} more lines`))
          outLines(rows)
        }
        const e = st.lastError || lastAgentState?.lastError
        if (e && !d) outLines(renderErrorBlock(e, termWidth(), ro))
        const rep = st.repair || lastAgentState?.repair
        if (rep) outLines(renderRepair(rep, termWidth(), ro))
        break
      }
      case "memory": {
        const stats = memoryStats(process.cwd())
        const rows = [bold("MEMORY") + dim(`  global ${stats.globalLines} lines • project ${stats.projectLines} lines  (forge memory … to edit)`)]
        for (const tier of ["global", "project"]) {
          const entries = memoryEntries(tier, process.cwd())
          if (!entries.length) continue
          rows.push(dim(`  ${tier}`))
          for (const e of entries.slice(-8)) rows.push(fit(`    • ${e.text.split("\n")[0]}`, termWidth() - 1))
          if (entries.length > 8) rows.push(dim(`    … ${entries.length - 8} more`))
        }
        outLines(rows)
        break
      }
      case "settings": {
        const keys = ["dock", "thinking", "ascii", "a11y", "collapse"]
        const [k, v] = arg.split(/\s+/)
        if (!k) {
          const rows = [bold("UI SETTINGS") + dim("  /settings <key> on|off   (saved to config.ui)")]
          rows.push(`  ${padRight("dock", 10)} ${uiCfg.dock === false ? "off" : "on "}   live task panel above the prompt`)
          rows.push(`  ${padRight("thinking", 10)} ${uiCfg.thinking === false ? "off" : "on "}   show model reasoning snippets`)
          rows.push(`  ${padRight("ascii", 10)} ${uiCfg.ascii === true ? "on " : "off"}   ASCII symbols (also FORGE_ASCII=1)`)
          rows.push(`  ${padRight("a11y", 10)} ${uiCfg.a11y === true ? "on " : "off"}   text labels instead of glyphs (also FORGE_A11Y=1)`)
          rows.push(`  ${padRight("collapse", 10)} ${uiCfg.collapse === false ? "off" : "on "}   collapse large tool outputs (/details expands)`)
          rows.push(dim(`  colors: ${process.env.NO_COLOR ? "off (NO_COLOR)" : "on"} • width tier: ${termWidth() < 50 ? "narrow" : termWidth() < 100 ? "medium" : "wide"} (${termWidth()} cols)`))
          outLines(rows)
          break
        }
        if (!keys.includes(k) || !["on", "off"].includes(v)) { err(`usage: /settings <${keys.join("|")}> on|off`); break }
        config.ui = { ...(config.ui || {}), [k]: v === "on" }
        Object.assign(uiCfg, config.ui)
        saveConfig(config)
        ok(`ui.${k} → ${v}${k === "ascii" || k === "a11y" ? " (takes effect on the next start)" : ""}`)
        if (ui) ui.term.render()
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
        // v20.4: /undo --run [RUN-x] rolls back a whole agent run atomically
        if (rest[0] === "--run") {
          const want = rest[1] ? resolveRunId(process.cwd(), rest[1]) : null
          if (rest[1] && !want) { err(`unknown run "${rest[1]}" — /tasks or /checkpoints list the ids`); break }
          const r = restoreRun(process.cwd(), want)
          if (!r) { warn(want ? `no checkpoints for ${shortRun(want)}` : "no agent run with checkpoints yet"); break }
          ok(`restored ${r.files} file(s) across ${r.checkpoints} checkpoint(s) from ${shortRun(r.runId)}`)
          for (const n of r.notes ?? []) out(dim(`  · ${n}`))
          markRun(r.runId, "undone", { note: "rolled back with /undo --run" })
          chatIntel.invalidate() // files moved back on disk — drop cached reads
          if (ui) for (const pth of Object.keys(store.state.changes)) dispatchUI({ type: "FILE_CHANGED", path: pth, action: "modified", added: 0, removed: 0 })
          break
        }
        while (messages.length && (messages[messages.length - 1].role === "assistant" || messages[messages.length - 1].role === "tool")) messages.pop()
        if (messages.length && messages[messages.length - 1].role === "user") messages.pop()
        // v16: also restore the newest file checkpoint for this directory
        const ck = restoreLast(process.cwd())
        if (ck) chatIntel.invalidate() // restored files invalidate cached reads
        ok(messages.length ? "last exchange dropped" : "conversation is empty")
        if (ck) {
          ok(`files restored from checkpoint ${ck.id} (${ck.files} file(s))`)
          for (const n of ck.notes ?? []) out(dim(`  · ${n}`))
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
        console.log(`  mode:       ${mode === "agent" ? cyan("agent (autonomous engineering)") : "normal (conversational)"}`)
        console.log(`  effort:     profile=${cyan(config.chat?.profile ?? "auto")} • deep=${deep ? green("on") : "off"} • tools=${chatToolsEnabled() ? green("on") : "off"} • shell=${config.chat?.shellAuto === false ? yellow("! only") : green("auto")}`)
        console.log(`  memory:     global ${mem.globalLines} lines • project ${mem.projectLines} lines`)
        console.log(`  resources:  ${res.cores} cores • ${res.freeMB}MB free • tier ${res.tier}`)
        console.log(`  safety:     writes in-project only${config.tools?.allowOutsideProject ? yellow(" (boundary OFF)") : green("")} • sudo ${config.tools?.allowSudo ? yellow("allowed") : green("blocked")} • ssrf guard ${config.tools?.fetchPrivateUrls || process.env.FORGE_ALLOW_PRIVATE_URLS === "1" ? yellow("private allowed") : green("on")}`)
        {
          // v20.5: what the tool intelligence layer did in THIS session
          const ts = chatIntel.stats()
          console.log(`  tools:      intelligence ${chatIntel.enabled ? green("on") : yellow("off")} • ${ts.calls} call(s) • ${ts.ok} ok • ${ts.failed} failed • ${ts.blocked} blocked • ${ts.cached} cached • ${ts.verified} verified${ts.verifyFailed ? red(` • ${ts.verifyFailed} verification failure(s)`) : ""}`)
        }
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
        if (ui) {
          const res = await runAgentTask(arg, { planOnly: true })
          if (!res) break
          const a = await ui.term.ask(bold("execute this plan now? [y/N] "))
          if (a && /^y(es)?$/i.test(a.trim())) await runAgentTask(arg)
          else warn("plan not executed")
          break
        }
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
      case "normal":
      case "chat": {
        setMode("normal")
        ok("Normal Chat mode active — direct conversational mode. Switch to Agent Mode with /agent")
        break
      }
      case "agent": {
        if (!arg) {
          setMode("agent")
          ok("Agent Mode active — every request executes autonomously with tools, checkpoints, and verification. Switch back with /normal or /chat")
          break
        }
        if (/^\d+$/.test(arg)) { await handleCommand(`/agents ${arg}`); break } // /agent NN → worker detail
        await runAgentTask(arg)
        break
      }
      default: {
        const sug = suggestCommand(cmd)
        err(`unknown /${cmd} — ${sug.length ? `did you mean ${sug.map((x) => "/" + x).join(", ")}? • ` : ""}/help`)
      }
    }
  }
}

// history persistence hooks (reassigned inside runChat)
let loadHistoryInto = () => {}
let saveHistory = () => {}
