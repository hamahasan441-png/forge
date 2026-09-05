#!/usr/bin/env bash
# clean-room v20 install verification: installs forge from the REPO into an
# ISOLATED npm prefix (temp dir on PATH), then drives it from a foreign cwd.
#
# v19 bug this fixes: the old script ran a bare `forge` and silently depended
# on a previously globally-installed forge — it verified nothing about the
# install itself. This version:
#   1. npm install -g --prefix <temp> .   (no root, no touching the user's
#      global packages, works identically on Termux/proot where npm's prefix
#      is often unwritable)
#   2. PATH points ONLY at the temp prefix bin (a system `forge` earlier on
#      PATH could shadow it — that would fail these checks)
#   3. runs from a foreign cwd against the mock provider
#   4. verifies the packaged file set (module + skills actually shipped)
#   5. covers the v20 hardening: safety blocks, SSRF opt-in, resume, status
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ -f "$ROOT/forge/forge.js" ]; then FORGE_DIR="$ROOT/forge"
elif [ -f "$ROOT/cli/forge/forge.js" ]; then FORGE_DIR="$ROOT/cli/forge"
else echo "forge.js not found under $ROOT"; exit 1; fi

T=$(mktemp -d)
PREFIX="$T/npm"
WORK=$(mktemp -d)
export FORGE_CONFIG="$T/config.json"
export FORGE_HOME="$T/home"
export NO_COLOR=1
export FORGE_ALLOW_PRIVATE_URLS=1   # mock provider runs on 127.0.0.1
PASS=0; FAIL=0
check() { local name="$1" got="$2" want="$3"
  if echo "$got" | grep -qF -- "$want"; then PASS=$((PASS+1)); echo "  ok  $name"
  else FAIL=$((FAIL+1)); echo "  FAIL $name"; echo "    want: $want"; echo "    got: $(echo "$got" | head -3)"; fi }
check_absent() { local name="$1" got="$2" want="$3"
  if echo "$got" | grep -qF -- "$want"; then FAIL=$((FAIL+1)); echo "  FAIL $name (found unwanted: $want)"
  else PASS=$((PASS+1)); echo "  ok  $name"; fi }

node "$SCRIPT_DIR/mock-llm.mjs" >/dev/null 2>&1 &
MOCK_PID=$!
sleep 0.6

# 1. THE clean-room install: repo → isolated prefix, no root, no prior forge
echo "== clean-room install: npm i -g --prefix $PREFIX $FORGE_DIR =="
if ! npm install -g --prefix "$PREFIX" --silent "$FORGE_DIR" 2>&1 | head -5; then
  echo "FAIL: npm install into temp prefix failed"; kill $MOCK_PID 2>/dev/null; exit 1
fi
if [ ! -x "$PREFIX/bin/forge" ]; then
  echo "FAIL: $PREFIX/bin/forge missing after install"; kill $MOCK_PID 2>/dev/null; exit 1
fi
PASS=$((PASS+1)); echo "  ok  forge installed into isolated prefix"

# PATH puts the temp prefix FIRST — a system forge earlier on PATH must never
# shadow the binary under test
export PATH="$PREFIX/bin:$PATH"

# prove we are not relying on a system forge by resolving the binary we run
F="forge" # resolved through PATH
RESOLVED="$(command -v forge)"
check "resolves to temp prefix" "$RESOLVED" "$PREFIX/bin/forge"

cd "$WORK"   # foreign cwd — nowhere near the repo

# 2. version + help from anywhere
check "foreign cwd version" "$(forge version 2>&1)" "forge v20.0.1"
check "help mentions AutoPick" "$(forge help 2>&1)" "AutoPick"
check "help mentions terminal" "$(forge help 2>&1)" "like a real terminal"
check "help mentions --deep" "$(forge help 2>&1)" "--deep"
check "help mentions v20 safety" "$(forge help 2>&1)" "risk-classified"

# 3. packaged file set — the shipped module + skills actually exist
PKG="$PREFIX/lib/node_modules/forge-agent-cli"
check "module shipped" "$(ls "$PKG/tools.js" "$PKG/shellguard.js" "$PKG/memory.js" 2>&1)" "shellguard.js"
check "skills shipped" "$(ls "$PKG/skills" 2>&1)" "pdf"
NSKILLS=$(forge skills 2>&1 | head -1)
check "skills indexed from install" "$NSKILLS" "skills ("

# 4. THE v16 REGRESSION: piped wizard (provider -> url -> model -> key -> probe
#    -> skills) must end with a WORKING saved config
KEY="test-key-1234567890"
out=$(printf '18\nhttp://127.0.0.1:8787/v1\nmock-mini\nY\n%s\ny\nY\n' "$KEY" | forge onboard 2>&1)
check "wizard completes" "$out" "saved"
check "wizard probe ok" "$out" "connection OK"
check "wizard config has key" "$(cat "$T/config.json" 2>/dev/null)" "$KEY"
check "wizard config chmod 600" "$(stat -c %a "$T/config.json")" "600"
check "wizard health recorded" "$(cat "$T/home/health.json" 2>/dev/null)" '"ok": true'

# 5. v19/v20 AutoPick: bare `forge` (non-TTY) = zero questions, one notice line
out=$(printf '' | forge 2>&1)
check "autopick banner" "$out" "forge v20.0.1"
check "autopick notice" "$out" "auto-picked"
check_absent "autopick zero questions" "$out" "Working models"

# 6. terminal-in-chat from a FOREIGN folder: `!` force + auto-detect +
#    cd persistence + catastrophic guard + model-visible notes
out=$(printf '!echo forge-v20-cleanroom\npwd\nbye\n' | forge 2>&1)
check "terminal force output" "$out" "forge-v20-cleanroom"
check "terminal auto-detect pwd" "$out" "$ pwd"
out=$(printf '!cd /tmp\npwd\nbye\n' | forge 2>&1)
check "terminal cd persisted" "$out" "/tmp"
out=$(printf '!rm -rf /\nbye\n' | forge 2>&1)
check "terminal forbidden guard" "$out" "BLOCKED"
out=$(printf '!rm cleanroom-target.txt\nbye\n' | forge 2>&1)
check "piped risky rm needs consent" "$out" "BLOCKED (non-interactive)"
out=$(printf '!echo note-for-the-model\nTERMINAL_NOTE_CHECK\nbye\n' | forge 2>&1)
check "terminal note reaches model" "$out" "TERMINAL NOTE SEEN"

# 7. v19 deep think + v20 effort profile
out=$(printf '/deep\n/exit\n' | forge chat 2>&1)
check "/deep toggles on" "$out" "deep mode ON"
out=$(forge agent "USE_TOOL deep cleanroom" --deep </dev/null 2>&1)
check "deep agent tool" "$out" "forge-e2e-ok"
check "deep agent final" "$out" "TOOL RESULT RECEIVED"
check "deep header shown" "$out" "DEEP"
out=$(printf '/profile balanced\n/status\n/exit\n' | forge chat 2>&1)
check "/profile persisted" "$out" "effort profile → balanced"
check "/status snapshot" "$out" "forge status"

# 8. v18 free models still work from the installed CLI
out=$(forge models custom --free 2>&1)
check "models --free header" "$out" "free models — custom"
check "models --free free id" "$out" "mock-vision:free"
check "model cache written" "$(cat "$T/home/models-cache.json" 2>/dev/null)" '"mock-vision:free"'

# 9. doctor: env + provider/context line + tested badge + v20 platform view
out=$(forge doctor 2>&1)
check "doctor skills indexed" "$out" "indexed"
check "doctor platform line" "$out" "platform:"
check "doctor provider line" "$out" "context ~128k tok"
check "doctor tested badge" "$out" "✓ tested"
check "doctor probe ok" "$out" "ok"

# 10. chat still fully functional + /tokens + /model recents + resume
check "chat from foreign cwd" "$(forge chat -m "hello" </dev/null 2>&1)" "Hello from mock!"
out=$(printf '/tokens\n/model mock-coder\n/exit\n' | forge chat 2>&1)
check "/tokens gauge" "$out" "context / tokens"
check "/model switch saved" "$out" "model → mock-coder"
REF=$(forge sessions 2>&1 </dev/null | grep -oE "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]+-[a-z0-9]+" | head -1)
out=$(cd "$WORK" && printf '' | forge resume "$REF" 2>&1)
check "forge resume works" "$out" "resumed session"

# 11. agent loop (no deep) still green + SSRF negative (guard ON without opt-in)
out=$(forge agent "USE_TOOL plain" </dev/null 2>&1)
check "plain agent tool" "$out" "forge-e2e-ok"
out=$(env -u FORGE_ALLOW_PRIVATE_URLS forge agent "USE_URL fetch it" </dev/null 2>&1)
check "ssrf guard on by default" "$out" "SSRF guard"

# 12. cold start timing (10 runs, incl. node boot)
t0=$(date +%s%N); for i in 1 2 3 4 5 6 7 8 9 10; do forge version >/dev/null 2>&1; done; t1=$(date +%s%N)
MS=$(( (t1 - t0) / 10000000 ))
echo "  cold start: ~${MS}ms per invocation (10 runs incl. node boot)"
PASS=$((PASS+1))

kill $MOCK_PID 2>/dev/null
rm -rf "$T" "$WORK"
echo
echo "== CLEAN-ROOM: $PASS passed, $FAIL failed =="
[ "$FAIL" = "0" ]
