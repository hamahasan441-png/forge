# forge v19 "TERMINAL" — plan

User ask (decoded): "make v19 smarter, easier, more professional; AUTOPICK the model;
when I run the CLI in any folder the AI must act like a real terminal — execute any
command like a normal CLI, edit/see/make files; the CLI must recognize Linux commands
typed in chat and execute them in the SAME chat with the terminal output shown;
think deeper like the big models; best performance; handle LONG context."

v18 baseline: 159/159 E2E, clean-room 29/29, free-models-first wizard, manual model
entry. v19 builds on top of it — no regressions allowed.

## F1 — AutoPick (zero-question start)

- Bare `forge` and interactive `forge chat` NO LONGER ask which model: the best
  working model is picked automatically:
    1. config model for the active provider (what you chose — stays)
    2. health-tested model (✓ from ~/.forge/health.json)
    3. best FREE model from the model cache (OpenRouter-first, biggest context)
    4. catalog default
  One dim line says what was picked and why. Zero questions, zero stalls.
- `--pick` restores the v17/v18 SmartStart chooser on demand (Enter = default,
  ✓ tested / FREE badges). Non-TTY behaviour unchanged (never prompts).

## F2 — Terminal-in-chat (the headline feature)

- The chat REPL recognizes shell commands typed as chat lines and runs them
  LOCALLY in the current directory, printing output in the same chat:
  - `!` prefix → ALWAYS executed (force; e.g. `!git status`).
  - Auto-detect: first token in a curated ~50-command Linux/macOS set
    (ls pwd cd cat echo mkdir touch rm cp mv grep head tail wc chmod git npm
    npx node python python3 pip curl wget tar zip unzip make docker env export
    printenv which uname whoami date diff sed awk file stat df du ps free kill
    history clear ln sort uniq tee find less man ip ifconfig ping apt brew …)
    → executed directly, no model call.
- Persistent shell state per session: `cd` changes the session working
  directory (validated), `export K=V` persists into every later command,
  `history` replays the session, `clear` clears the screen.
- Safety: the same FORBIDDEN catastrophic list as the bash tool (rm -rf /,
  mkfs, fork bombs, dd to raw disk, shutdown…) is applied to pass-through
  commands; matches are refused with the reason.
- The AI stays in the loop: every executed command + trimmed output is appended
  to the conversation as a compact `[terminal]` note, so the model KNOWS what
  you ran and can act on it (ask "what did that print?" right after).
- `/shell on|off` toggles auto-detect (config `chat.shellAuto`, default on);
  `!` force-prefix always works.

## F3 — Deep think (big-model reasoning)

- `--deep` flag on chat/agent + `/deep` toggle in chat (persisted as
  `chat.deep`) + `deep` respect everywhere.
- Deep system directives: structured reasoning contract (understand → consider
  alternatives → plan → answer → verify), explicit "think before each tool
  batch, verify after edits" for the agent.
- Provider reasoning params (wire-correct, opt-in only when deep):
  - OpenRouter: `reasoning: { effort: "high" }`
  - OpenAI o-series / gpt-5 style: `reasoning_effort: "high"`
  - Anthropic: `thinking: { type: "enabled", budget_tokens }` (+ max_tokens raised)
- Deep budgets: chat maxTokens 8192 → 16384, tool rounds 8 → 12.

## F4 — Long context (tiered token reduction)

- Agent + chat reducers become TWO-STAGE before any summarize:
  1. SHRINK — big tool outputs in history (outside the recent tail) are
     replaced with `[tool output shrunk: N chars]` stubs (~40% window trigger).
  2. SUMMARIZE — only if still over budget (~55% window), as in v17/v18.
  Shrinking preserves far more real information for deep long-context work and
  often avoids lossy summaries entirely. Same "compacted" event surface, so
  v18 E2E stays green.

## F5 — Performance

- onboard.js (the heaviest module: readline + provider probing) is now loaded
  lazily only when a wizard/menu path actually runs — measurable cold-start
  cut for the 99% path (`forge`, `forge ask`, `forge agent`).
- UA 19.0.0; no other hot-path changes (keepalive fetch + parallel tools from
  v16 already in place).

## F6 — Docs, mock, E2E, packaging

- README.md: "terminal mode", "deep mode", "autopick" sections + updated
  command table; help text updated.
- mock-llm.mjs: records the last request body (GET /last-body) so E2E can
  assert the exact wire JSON (deep directives, reasoning params); new
  TERMINAL NOTE SEEN branch proves pass-through results reach the model.
- E2E 159 → ~175 checks: autopick notice + --pick, `!` force, auto-detect,
  cd/export persistence, FORBIDDEN block, terminal note reaching the model,
  /deep + /shell toggles, deep wire params (mock + last-body), agent --deep,
  shrink-stage firing with a bigger window (no summarize needed), version
  bumps. All 159 existing checks stay green.
- scripts/cleanroom-v19.sh (from-zip verification incl. terminal mode),
  package-cli.sh → download/agentv19.zip (rm -f, pollution guard, unzip -t,
  no secrets, single START COMMAND), worklog + English report.
