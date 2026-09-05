forge v20 "PRODUCTION" — standalone terminal AI agent (CLI only, no web app)

INSTALL (one command):
  cd agentv19/forge && bash install.sh     # or: cd agentv19/forge && npm i -g .

FIRST RUN:
  forge                              # wizard: provider -> model (FREE models
                                     # listed FIRST on OpenRouter) -> API key -> test
  forge doctor                       # verify environment + connectivity + tested badge

DAILY:
  forge                              # AUTOPICK: best model, zero questions -> chat, all tools ON
  forge --pick                       # classic model chooser (Enter = default, ✓/FREE badges)
  forge --profile auto|fast|balanced|deep   # effort profile (auto = deep for complex tasks)
  forge ask "question"               # quick one-shot (or: echo question | forge ask)
  forge agent "task"                 # coding agent with 17 hardened tools + web + 69 skills
  forge agent --deep "task"          # DEEP THINKING agent (high reasoning effort)
  forge agent --plan "task"          # plan first (read-only), confirm, then execute
  forge resume <n|id>                # resume a session: messages + cwd + usage
  forge config                       # interactive menu: add provider -> model -> key -> test
  forge models openrouter --free     # list ALL free OpenRouter models (live or cached)
  forge use deepseek --model deepseek-chat   # switch provider + model in one line
  forge undo                         # restore files changed by the last tool edit
  forge chat --continue              # resume last session

IN CHAT (v20 terminal mode):
  type Linux commands and they EXECUTE in the same chat, in your folder:
    ls · pwd · cat file.md · git status · python x.py · npm test · mkdir build
  plain sentences stay chat — "find the bug in main.js", "make it work" and
    "node is great" go to the MODEL, never to the shell (v20.0.1)
  ! <command>    force-execute (always works)   cd / export persist per session
  every run is shared with the model (secret-redacted) — ask "what did that print?"
  risky commands ask y/N (FORGE_ASSUME_YES=1 for scripts); catastrophic ones are
  always blocked (rm -rf /, mkfs, dd to raw devices, fork bombs, shutdown)
  /status         session + context + safety snapshot
  /profile [p]    effort profile: fast | balanced | deep | auto
  /deep           toggle DEEP THINKING (reasoning params per provider)
  /shell off      stop auto-detecting commands (the ! prefix keeps working)

v20 "PRODUCTION" hardening:
  shellguard risk engine (parse+classify+path-aware, replaces regex-only guard);
  project-boundary writes with symlink-escape detection; sensitive files
  (.env/.ssh/keys/credentials) protected from model reads; SSRF guard with DNS
  resolution + IPv6/private/metadata checks (DNS-rebinding safe); secret
  redaction in tool results/memory/session notes; skill-name traversal blocks;
  checkpoints track CREATED files (undo removes them, hash-verified);
  context-overflow recovery (400 too-large -> compress -> retry, session kept);
  hierarchical memory (global+project, relevance-retrieved) + failure learning
  (memory action=learn); project profile (langs/pm/test commands, cached);
  sessions store cwd/title/summary; delegate roles + timeout + concurrency cap;
  null-provider crash guards; Retry-After honored; /status, /profile, forge resume.
v20.1 "safe by default" (PLAN-v21 P0 — in progress):
  * P0-1 shellguard unwraps interpreter wrappers: `sh -c "rm -rf /"`,
    `eval`, `timeout/env/nohup`, `python3 -c "os.system(…)"`, `node -e`,
    `xargs rm`, and `$(…)` are classified by their PAYLOAD, not the wrapper
    (they used to be "safe" = run with no confirmation at all)
  * P0-2 `$VAR` / `${VAR}` targets are expanded before classification, so
    `rm -rf $HOME` is blocked like `rm -rf ~` (it used to be a mere "confirm")
  * P0-3 redaction closes four leaks: values under 8 chars (`password=hunter2`),
    escaped JSON values, `Authorization: Bearer <opaque>`, and unprefixed
    high-entropy keys — with a pinned "refuse to over-redact" corpus
  * P0-4 read_file STREAMS a window instead of slurping the file: a 16 MB log
    costs +0 MB RSS (was +30 MB) and a 2 GB log can no longer OOM the agent
  * P0-5 checkpoints gzip their backups: the per-file cap moves 2 MB -> 64 MB,
    so `forge undo` now protects the files it used to refuse
    (6.4 MB log -> 306 KB backup), with a 512 MB total directory budget
v19: AutoPick, terminal-in-chat with session shell state, deep think mode,
tiered long-context reduction, lazy-loaded wizard.
v18: choosing OpenRouter detects EVERY free model through the PUBLIC /models
endpoint (no key needed yet) and lists them FIRST with a FREE badge + context
size; fallback chain live -> cache -> curated offline list means detection
NEVER fails or stalls; explicit "[m] enter a model id manually" line in every
model picker; forge models [provider] --free; SmartStart FREE badges.
v17 fixes the v16 wizard gap-error (hidden key input died silently on Termux and
left no config): no more raw-mode input, incremental saves, per-provider key URLs,
any-model free-text entry, provider-name shortcut for custom URLs, a verify
recovery loop, SmartStart model picker, interactive config menu, token-reduction
(chat + agent auto-compaction at ~55% of the model context window, /tokens gauge),
and global crash handlers (no silent exits).
v16: apply_patch, git_status, checkpoints & rewind, plan mode, parallel tools.
v15: web_search, glob_files, multi_edit (atomic), todo, think, persistent memory,
read-only sub-agent delegate.
Config file: ~/.forge/config.json  (chmod 600, keys stay on your device)
Requirements: Node.js >= 18 only. No bun, no build, no native modules.
ARM64 / Termux / Kali NetHunter / proot: resource-aware (low-RAM devices get
reduced sub-agent concurrency automatically), no systemd/desktop assumptions.

Self-test (optional, needs Node only — one command runs everything):
  cd agentv19/forge && npm test              # every suite; non-zero on any failure
  FORGE_FAST=1 npm test                      # Node suites only (fast inner loop)
  FORGE_SKIP_E2E=1 npm test                  # skip just the slow e2e
  Counts are not repeated here (they drift) — npm test prints the authoritative
  per-suite results. The bash suites (e2e, clean-room install) each start and
  stop their own mock provider, so nothing needs to be launched by hand.
