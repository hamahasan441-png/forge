#!/usr/bin/env bash
# E2E test for the forge CLI (v20) against a mock OpenAI + Anthropic provider.
# Covers: config, provider resolution, live models, streaming chat (both wire
# protocols), reasoning deltas, transient retry (429), agent tool loop (bash +
# fetch_url), skills, doctor, sessions, ask, /retry, /export, piped onboarding,
# missing/bad key guidance, v15 omnitools, v16 (apply_patch, checkpoints/undo,
# git_status, parallel tools, /usage, /compact, auto-compaction, plan mode),
# v17 (wizard saved-at-every-step, config menu, SmartStart, /tokens, token
# reducers, health badges), v18 (OpenRouter free-models detection FIRST, manual
# model entry, models [provider] --free, model cache, offline fallback),
# v19 (AutoPick zero-question start, terminal-in-chat shell pass-through with
# cd/export persistence + catastrophic-command guard + model-visible notes,
# deep think mode with wire-level reasoning params, tiered shrink-then-summarize
# context reduction).
# v20 (shellguard risk classification + FORGE_ASSUME_YES, project-boundary
# writes, sensitive-file read blocks, skill traversal blocks, SSRF guard with
# opt-in private fetches, secret redaction, created-file undo, session resume
# with cwd/title, context-overflow recovery, /status + /profile + forge resume,
# delegate timeout, effort profiles).
set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"
# v18 fix: work in BOTH layouts — repo (cli/forge + scripts/) and the shipped
# zip (forge/ + tests/) — so the self-test instructions in README.txt are true.
if [ -f "$ROOT/forge.js" ]; then FORGE_DIR="$ROOT"
elif [ -f "$ROOT/cli/forge/forge.js" ]; then FORGE_DIR="$ROOT/cli/forge"
elif [ -f "$ROOT/forge/forge.js" ]; then FORGE_DIR="$ROOT/forge"
else echo "forge.js not found under $ROOT"; exit 1; fi
MOCK="$ROOT/scripts/mock-llm.mjs"; [ -f "$MOCK" ] || MOCK="$ROOT/tests/mock-llm.mjs"
T=$(mktemp -d)
export FORGE_CONFIG="$T/config.json"
export FORGE_HOME="$T/home"
export NO_COLOR=1
# v85: the e2e exercises the GUARDED install (prompts, block list, SSRF guard,
# project boundary). Since v85 the shipped default is tools.unrestricted:true
# (the owner's master switch — every guard off). Pin it OFF here so those
# checks keep testing the guards; test-v85.mjs covers the unrestricted path.
printf '{"tools":{"unrestricted":false}}\n' > "$T/config.json"
# v20: the mock lives on 127.0.0.1 — fetch_url tests opt INTO private fetches
# (the negative test below unsets it to prove the guard blocks by default)
export FORGE_ALLOW_PRIVATE_URLS=1
PASS=0; FAIL=0
check() {
  local name="$1" got="$2" want="$3"
  if echo "$got" | grep -qF -- "$want"; then PASS=$((PASS+1)); echo "  ok  $name"
  else FAIL=$((FAIL+1)); echo "  FAIL $name"; echo "    want: $want"; echo "    got: $(echo "$got" | head -4)"; fi
}
check_absent() {
  local name="$1" got="$2" want="$3"
  if echo "$got" | grep -qF -- "$want"; then FAIL=$((FAIL+1)); echo "  FAIL $name (found unwanted: $want)"; else PASS=$((PASS+1)); echo "  ok  $name"; fi
}

node "$MOCK" >/dev/null 2>&1 &
MOCK_PID=$!
sleep 0.6
F="node $FORGE_DIR/forge.js"
KEY="test-key-1234567890"

echo "== forge E2E (v19) =="

# 0. version
out=$($F version 2>&1); check "forge version" "$out" "forge v93.0.0"

# 1. config
out=$($F config set activeProvider mock 2>&1); check "config set provider" "$out" "saved"
out=$($F config set providers.mock.apiKey $KEY 2>&1); check "config set key (masked)" "$out" "test-k...7890"
$F config set providers.mock.baseUrl http://127.0.0.1:8787/v1 >/dev/null 2>&1
$F config set providers.mock.model mock-mini >/dev/null 2>&1
out=$($F config show 2>&1); check "config show masks key" "$out" "test-k...7890"
check "config file chmod 600" "$(stat -c %a "$T/config.json")" "600"
out=$($F config get activeProvider 2>&1); check "config get" "$out" "mock"

# 2. providers (custom provider shown + active dot)
out=$($F providers 2>&1); check "providers shows custom+active" "$out" "●"

# 3. models live
out=$($F models 2>&1); check "models live fetch" "$out" "mock-coder"

# 4. one-shot streaming chat (SSE + reasoning, openai wire)
out=$($F chat -m "hello there" 2>&1 </dev/null); check "chat streams answer" "$out" "Hello from mock!"
check "openai reasoning delta" "$out" "thinking about it..."

# 5. transient retry: mock 429s twice then succeeds
out=$($F chat -m "FLAKY_CHECK please answer" 2>&1 </dev/null); check "stream retry survives 429" "$out" "Hello from mock!"

# 6. agent tool loop (bash)
out=$($F agent "USE_TOOL please run echo" 2>&1 </dev/null); check "agent tool call" "$out" "bash"
check "agent executed tool" "$out" "forge-e2e-ok"
check "agent final answer" "$out" "TOOL RESULT RECEIVED"
check "agent steps+duration" "$out" "tool calls •"

# 7. skills
out=$($F skills 2>&1 | head -3); check "skills index" "$out" "skills ("

# 8. doctor (probe hits mock)
out=$($F doctor 2>&1); check "doctor ok+latency" "$out" "ok"
check "doctor shows model" "$out" "mock-mini"

# 9. missing key → clear guidance
$F config set providers.mock.apiKey "" >/dev/null 2>&1
out=$($F chat -m "hi" 2>&1 </dev/null); check "missing key guidance" "$out" "no provider configured"
check "onboarding hint" "$out" "forge onboard"

# 10. bad key → provider error surfaced with fix hint
$F config set providers.mock.apiKey wrong-key >/dev/null 2>&1
out=$($F chat -m "hi" 2>&1 </dev/null); check "bad key surfaced" "$out" "HTTP 401"
check "bad key fix hint" "$out" "API key rejected"

# ---- v14 additions ----

# 11. restore key
$F config set providers.mock.apiKey $KEY >/dev/null 2>&1

# 12. forge ask (one-shot alias)
out=$($F ask "hello" 2>&1 </dev/null); check "forge ask one-shot" "$out" "Hello from mock!"

# 13. sessions (auto-saved after each turn)
out=$($F sessions 2>&1 </dev/null); check "sessions listed" "$out" "mock/mock-mini"

# 14. anthropic wire protocol: streaming + reasoning deltas
$F config set providers.mocka.baseUrl http://127.0.0.1:8787 >/dev/null 2>&1
$F config set providers.mocka.apiKey $KEY >/dev/null 2>&1
$F config set providers.mocka.model mock-a >/dev/null 2>&1
$F config set providers.mocka.protocol anthropic >/dev/null 2>&1
$F config set activeProvider mocka >/dev/null 2>&1
out=$($F chat -m "hello" 2>&1 </dev/null); check "anthropic streaming" "$out" "Hello from anthropic mock!"
check "anthropic thinking delta" "$out" "anthropic thinking deeply..."

# 15. agent tool loop on the anthropic wire (tool_use / tool_result blocks)
out=$($F agent "USE_TOOL_A please run echo" 2>&1 </dev/null); check "anthropic agent tool" "$out" "anthropic-e2e-ok"
check "anthropic agent final" "$out" "TOOL RESULT RECEIVED"

# 16. agent fetch_url loop (web tool) — back on openai mock
$F config set activeProvider mock >/dev/null 2>&1
out=$($F agent "USE_URL fetch the page please" 2>&1 </dev/null); check "agent fetch_url tool" "$out" "fetch_url"
check "fetch_url got page" "$out" "MOCK PAGE 42"
check "fetch_url final answer" "$out" "TOOL RESULT RECEIVED"

# 17. chat /retry regenerates the answer
out=$(printf 'hello\n/retry\n/exit\n' | $F chat 2>&1)
n=$(echo "$out" | grep -c "Hello from mock!")
if [ "${n:-0}" -ge 2 ]; then PASS=$((PASS+1)); echo "  ok  chat /retry regenerates"
else FAIL=$((FAIL+1)); echo "  FAIL chat /retry regenerates (got $n answers)"; fi
check "banner v30" "$out" "forge v93"

# 18. chat /export writes markdown transcript
mkdir -p "$T/work"
out=$(printf 'hello\n/export %s\n/exit\n' "$T/work/export.md" | $F chat 2>&1)
check "export command" "$out" "exported"
check "export file has answer" "$(cat "$T/work/export.md" 2>/dev/null)" "Hello from mock!"

# 19. piped onboarding (fresh config) — v17 ORDER: provider → url → model → key → probe → skills
ONB="$T/onb.json"
out=$(printf '18\nhttp://127.0.0.1:8787/v1\nmock-mini\nY\n%s\ny\nY\n' "$KEY" | FORGE_CONFIG="$ONB" FORGE_HOME="$T/home2" $F onboard 2>&1)
check "onboard wizard completes" "$out" "saved"
check "onboard live probe" "$out" "connection OK"
check "onboard model saved" "$(cat "$ONB" 2>/dev/null)" "mock-mini"
check "onboard baseUrl saved" "$(cat "$ONB" 2>/dev/null)" "http://127.0.0.1:8787/v1"
check "onboard key saved" "$(cat "$ONB" 2>/dev/null)" "$KEY"
check "onboard recents saved" "$(cat "$ONB" 2>/dev/null)" '"models"'
check "onboard config chmod 600" "$(stat -c %a "$ONB")" "600"

# 20. doctor catches anthropic provider too (switch + --all)
out=$($F doctor --all 2>&1); check "doctor --all probes every provider" "$out" "mocka"

# ---- v15 OMNITOOL additions ----

# 21. point web_search at the mock backend
$F config set tools.searchUrl http://127.0.0.1:8787/search >/dev/null 2>&1
mkdir -p "$T/work"
printf 'hello doc\n' > "$T/work/FORGE_GLOB_ME.md"
printf 'alpha beta gamma\n' > "$T/work/multi.txt"
printf 'DELEGATE-TOKEN-7 inside\n' > "$T/work/sub.txt"

# 22. agent glob_files loop
out=$($F agent --cwd "$T/work" "USE_GLOB find the markdown file" 2>&1 </dev/null)
check "agent glob_files tool" "$out" "glob_files"
check "glob found file" "$out" "FORGE_GLOB_ME.md"
check "glob final answer" "$out" "TOOL RESULT RECEIVED"

# 23. agent web_search loop (configured mock backend)
out=$($F agent "USE_SEARCH search the web please" 2>&1 </dev/null)
check "agent web_search tool" "$out" "web_search"
check "web_search parsed results" "$out" "forge result one"
check "web_search final answer" "$out" "TOOL RESULT RECEIVED"

# 24. agent multi_edit (atomic, 2 replacements)
out=$($F agent --cwd "$T/work" "USE_MULTI_EDIT fix the file" 2>&1 </dev/null)
check "agent multi_edit tool" "$out" "multi_edit"
check "multi_edit final answer" "$out" "TOOL RESULT RECEIVED"
check "multi_edit applied edit 1" "$(cat "$T/work/multi.txt")" "ALPHA"
check "multi_edit applied edit 2" "$(cat "$T/work/multi.txt")" "GAMMA"

# 25. agent todo tracking
out=$($F agent "USE_TODO track the steps" 2>&1 </dev/null)
check "agent todo tool" "$out" "todo"
check "todo persisted" "$(cat "$T/home/todo.json" 2>/dev/null)" "write code"
check "todo final answer" "$out" "TOOL RESULT RECEIVED"

# 26. agent persistent memory
out=$($F agent "USE_MEMORY remember a fact" 2>&1 </dev/null)
check "agent memory tool" "$out" "memory"
check "memory persisted" "$(cat "$T/home/memory.md" 2>/dev/null)" "likes dark mode"

# 27. agent think scratchpad
out=$($F agent "USE_THINK plan first" 2>&1 </dev/null)
check "agent think tool" "$out" "think"
check "think final answer" "$out" "TOOL RESULT RECEIVED"

# 28. agent delegate (read-only sub-agent, nested tool loop)
out=$($F agent --cwd "$T/work" "USE_DELEGATE dispatch the nested job" 2>&1 </dev/null)
check "agent delegate tool" "$out" "delegate"
check "sub-agent ran nested read_file" "$out" "DELEGATE-TOKEN-7"
check "delegate report arrived" "$out" "SUB-AGENT REPORT"
check "delegate final answer" "$out" "TOOL RESULT RECEIVED"

# 29. chat INLINE auto-tools (streaming tool-call assembly, openai wire)
out=$(printf 'USE_TOOL inline please\n/exit\n' | $F chat 2>&1)
check "chat inline tool call" "$out" "[chat] bash"
check "chat inline tool executed" "$out" "forge-e2e-ok"
check "chat inline final streamed" "$out" "TOOL RESULT RECEIVED"

# 30. /tools lists the 18 tools
out=$(printf '/tools\n/exit\n' | $F chat 2>&1)
check "/tools lists tools" "$out" "forge tools (22)"
check "/tools shows glob" "$out" "glob_files"
check "/tools shows apply_patch" "$out" "apply_patch"

# 31. /tools off = plain chat
out=$(printf 'USE_TOOL first\n/tools off\nUSE_TOOL second\n/exit\n' | $F chat 2>&1)
n=$(echo "$out" | grep -c "TOOL RESULT RECEIVED")
if [ "${n:-0}" = "1" ]; then PASS=$((PASS+1)); echo "  ok  /tools off disables auto-tools"
else FAIL=$((FAIL+1)); echo "  FAIL /tools off (got $n tool answers)"; fi
$F config set chat.tools true >/dev/null 2>&1

# 32. chat INLINE auto-tools on the ANTHROPIC wire (input_json_delta assembly)
$F config set activeProvider mocka >/dev/null 2>&1
out=$(printf 'USE_TOOL_A inline please\n/exit\n' | $F chat 2>&1)
check "anthropic chat inline tool" "$out" "[chat] bash"
check "anthropic inline executed" "$out" "anthropic-e2e-ok"
check "anthropic inline final" "$out" "TOOL RESULT RECEIVED"
$F config set activeProvider mock >/dev/null 2>&1

# 33. doctor --tools self-test
out=$($F doctor --tools 2>&1)
check "doctor --tools runs" "$out" "tools:"
check "doctor --tools bash ok" "$out" "echo verified"
check "doctor --tools summary" "$out" "0 failed"

# 34. agent delegation denied inside read-only sub-agent (depth guard)
out=$($F agent --cwd "$T/work" "USE_THINK and also mention delegate" 2>&1 </dev/null)
check "tool count line v17" "$out" "tool calls •"

# ---- v16 RESILIENT+ additions ----

# 35. apply_patch: creation + modification in one atomic patch
printf 'first\nold line\nthird\n' > "$T/work/patch-base.txt"
out=$($F agent --cwd "$T/work" "USE_PATCH apply the patch" 2>&1 </dev/null)
check "agent apply_patch tool" "$out" "apply_patch"
check "apply_patch created file" "$(cat "$T/work/patch-new.txt" 2>/dev/null)" "patch line one"
check "apply_patch modified hunk" "$(cat "$T/work/patch-base.txt")" "NEW LINE"
check "apply_patch kept context" "$(cat "$T/work/patch-base.txt")" "third"

# 36. apply_patch is atomic: bad hunk → zero changes anywhere
cp "$T/work/patch-base.txt" "$T/work/patch-base.bak"
out=$($F agent --cwd "$T/work" "PATCH_FAIL try the broken patch" 2>&1 </dev/null)
check "bad patch surfaced error" "$out" "ERROR"
check "bad patch no changes applied" "$out" "no changes applied"
if diff -q "$T/work/patch-base.txt" "$T/work/patch-base.bak" >/dev/null 2>&1; then
  PASS=$((PASS+1)); echo "  ok  bad patch left file untouched"
else
  FAIL=$((FAIL+1)); echo "  FAIL bad patch left file untouched"
fi

# 37. git_status inside a real (throwaway) repo
git init -q "$T/work" 2>/dev/null
out=$($F agent --cwd "$T/work" "USE_GIT check the repo" 2>&1 </dev/null)
check "agent git_status tool" "$out" "git_status"
check "git_status branch line" "$out" "git ##"
check "git_status untracked seen" "$out" "patch-base.txt"

# 38. parallel read tools in one round (both results arrive, in order)
out=$($F agent --cwd "$T/work" "USE_TWO_READS read both files" 2>&1 </dev/null)
check "parallel read 1 result" "$out" "DELEGATE-TOKEN-7"
check "parallel read 2 result" "$out" "beta"
check "parallel final answer" "$out" "TOOL RESULT RECEIVED"

# 39. /usage session tokens
out=$(printf 'hello\n/usage\n/exit\n' | $F chat 2>&1)
check "/usage shows session usage" "$out" "session usage"
check "/usage counts requests" "$out" "requests:"

# 40. /compact on a small history = graceful no-op
out=$(printf '/compact\n/exit\n' | $F chat 2>&1)
check "/compact small history no-op" "$out" "nothing to compact"

# 41. auto-compaction fires when history exceeds compactAtChars
$F config set chat.compactAtChars 200 >/dev/null 2>&1
out=$(printf 'filler one alpha bravo charlie delta echo fox go\nfiller two golf hotel india juliet kilo lima mike no\nfiller three mike november oscar papa quebec romeo si\nfiller four sierra tango uniform victor whiskey xray yz\n/exit\n' | $F chat 2>&1)
check "auto-compaction triggered" "$out" "context compacted"
check "chat continues after compaction" "$out" "Hello from mock!"
$F config set chat.compactAtChars 48000 >/dev/null 2>&1

# 42. plan mode (non-TTY): prints plan, does NOT execute the real run
out=$($F agent --plan "USE_TOOL plan this" 2>&1 </dev/null)
check "plan mode prints plan header" "$out" "plan "
check "plan mode blocks write tools" "$out" "write tools are disabled"
check "plan mode non-TTY warning" "$out" "not executing"
if echo "$out" | grep -q "── result"; then
  FAIL=$((FAIL+1)); echo "  FAIL plan mode must not execute the real run"
else
  PASS=$((PASS+1)); echo "  ok  plan mode did not execute"
fi

# 43. checkpoints: forge undo restores the pre-edit content (walks back)
out=$(cd "$T/work" && $F undo 2>&1)
check "undo restores patch" "$out" "restored"
if grep -q "old line" "$T/work/patch-base.txt" 2>/dev/null && ! grep -q "NEW LINE" "$T/work/patch-base.txt" 2>/dev/null; then
  PASS=$((PASS+1)); echo "  ok  undo restored patch-base.txt original"
else
  FAIL=$((FAIL+1)); echo "  FAIL undo restored patch-base.txt original"
fi
out=$(cd "$T/work" && $F undo 2>&1)
check "second undo (walk back)" "$out" "restored"
if grep -q "alpha beta gamma" "$T/work/multi.txt" 2>/dev/null; then
  PASS=$((PASS+1)); echo "  ok  second undo restored multi.txt (multi_edit reverted)"
else
  FAIL=$((FAIL+1)); echo "  FAIL second undo restored multi.txt"
fi
out=$(cd "$T/work" && $F undo 2>&1)
check "undo exhausted" "$out" "no checkpoints yet"

# 44. doctor environment checks
out=$($F doctor 2>&1)
check "doctor node check" "$out" "node:"
check "doctor config writable" "$out" "(writable)"
check "doctor skills resolved" "$out" "skills:"

# 44b. v20.0.1: doctor must report a FAILED probe honestly — it used to print
#      "✓ doctor done" even when every provider probe had just failed.
cp "$T/config.json" "$T/config.json.bak44"
$F config set providers.mock.baseUrl http://127.0.0.1:1/v1 >/dev/null 2>&1
out=$($F doctor 2>&1)
check "doctor reports failed probe" "$out" "FAILED"
check "doctor names the failing provider" "$out" "FAILED (mock"
check_absent "doctor does not claim success on failure" "$out" "✓ doctor done"
cp "$T/config.json.bak44" "$T/config.json"
out=$($F doctor 2>&1)
check "doctor ok probe still passes" "$out" "probe(s) ok"
check_absent "doctor does not cry failure on success" "$out" "FAILED"

# ---- v17 SMARTSTART additions ----

V17H="$T/home17"; mkdir -p "$V17H"

# 45. THE v16 GAP-ERROR REGRESSION: wizard killed mid-flow (EOF) must STILL save
#     a partial config (v16 died silently after the hidden key prompt, doctor
#     then said "config: missing")
CFG17="$T/forge17.json"
out=$(printf '1\n' | FORGE_CONFIG="$CFG17" FORGE_HOME="$V17H" $F onboard 2>&1)
check "wizard eof interrupt msg" "$out" "setup interrupted"
check "wizard eof partial config" "$(cat "$CFG17" 2>/dev/null)" '"activeProvider": "openai"'
check "wizard eof baseUrl saved" "$(cat "$CFG17" 2>/dev/null)" "api.openai.com"

# 46. custom provider smart URL: typing a provider NAME auto-fills the endpoint
CFG18="$T/forge18.json"
out=$(printf '18\nopenrouter\nmy-model-x\nn\nn\n' | FORGE_CONFIG="$CFG18" FORGE_HOME="$V17H" $F onboard 2>&1)
check "name shortcut endpoint" "$out" "https://openrouter.ai/api/v1"
check "name shortcut saved" "$(cat "$CFG18" 2>/dev/null)" "openrouter.ai/api/v1"
check "name shortcut model saved" "$(cat "$CFG18" 2>/dev/null)" "my-model-x"

# 47. forge config interactive menu (piped): add provider deepseek, tested default
CFG19="$T/forge19.json"
out=$(printf '1\ndeepseek\n1\nn\n7\n' | FORGE_MENU=1 FORGE_CONFIG="$CFG19" FORGE_HOME="$V17H" $F config 2>&1)
check "config menu adds provider" "$(cat "$CFG19" 2>/dev/null)" '"deepseek"'
check "config menu tested model" "$(cat "$CFG19" 2>/dev/null)" "deepseek-chat"
check "config menu active set" "$(cat "$CFG19" 2>/dev/null)" '"activeProvider": "deepseek"'

# 48. config menu option 4: update API key + live probe via health record
out=$(printf '4\nmock\ntest-key\n7\n' | FORGE_MENU=1 FORGE_CONFIG="$T/config.json" FORGE_HOME="$T/home" $F config 2>&1)
check "config menu key saved" "$out" "key saved for mock"
check "config menu probe ok" "$out" "connection OK"

# 49. AutoPick: bare `forge` (non-TTY) starts instantly with ZERO questions
out=$(printf '' | FORGE_CONFIG="$ONB" FORGE_HOME="$T/home2" $F 2>&1)
check "autopick banner" "$out" "forge v93"
check "autopick provider" "$out" "provider: custom"
check "autopick notice" "$out" "auto-picked"
check_absent "autopick zero questions" "$out" "Working models"

# 50. health cache written by the wizard probe (feeds the ✓ tested badge)
check "health cache written" "$(cat "$T/home2/health.json" 2>/dev/null)" '"ok": true'

# 51. /tokens context gauge
out=$(printf '/tokens\n/exit\n' | FORGE_CONFIG="$ONB" FORGE_HOME="$T/home2" $F chat 2>&1)
check "/tokens gauge" "$out" "context / tokens"
check "/tokens window" "$out" "128k tok"
check "/tokens compact note" "$out" "auto-compact fires at ~55%"

# 52. /model switch persists + pushes recents + shows context
out=$(printf '/model mock-large\n/model\n/exit\n' | FORGE_CONFIG="$ONB" FORGE_HOME="$T/home2" $F chat 2>&1)
check "/model switch saved" "$out" "model → mock-large"
check "/model context shown" "$out" "context ~128k tok"
check "/model recents pushed" "$(cat "$ONB" 2>/dev/null)" '"mock-large"'

# 53. forge use <provider> --model <id> (switch + set in one line)
out=$(FORGE_CONFIG="$ONB" FORGE_HOME="$T/home2" $F use custom --model mock-coder 2>&1)
check "use --model output" "$out" "active provider → custom"
check "use --model saved" "$(cat "$ONB" 2>/dev/null)" "mock-coder"

# 54. agent token reducer: tiny window + 3 loud tool rounds → mid-run compaction
CFGZ="$T/forge-z.json"
$F config set activeProvider mock >/dev/null 2>&1
$F config set providers.mock.apiKey test-key >/dev/null 2>&1
$F config set providers.mock.baseUrl http://127.0.0.1:8787/v1 >/dev/null 2>&1
$F config set providers.mock.model mock-mini >/dev/null 2>&1
$F config set providers.mock.contextWindow 3000 >/dev/null 2>&1
out=$($F agent --cwd "$T/work" "USE_LOUD_COMPACT big outputs" 2>&1 </dev/null)
check "agent compaction fired" "$out" "context compacted"
check "agent compaction final" "$out" "TOOL RESULT RECEIVED"

# 55. wizard verify-recovery loop: bad key → 401 → menu → save anyway
CFGK="$T/forge-k.json"
out=$(printf '18\nhttp://127.0.0.1:8787/v1\nmock-mini\nY\nwrong-key\ny\ns\nn\n' | FORGE_CONFIG="$CFGK" FORGE_HOME="$V17H" $F onboard 2>&1)
check "probe 401 surfaced" "$out" "HTTP 401"
check "recovery menu offered" "$out" "[r]etry"
check "save anyway kept key" "$(cat "$CFGK" 2>/dev/null)" "wrong-key"

# 56. doctor provider/context line + tested badge from health cache
out=$(FORGE_CONFIG="$ONB" FORGE_HOME="$T/home2" $F doctor 2>&1)
check "doctor provider line" "$out" "context ~128k tok"
check "doctor tested badge" "$out" "✓ tested"

# 57. crash safety net present (no silent exits ever again)
out=$(grep -c "unhandledRejection" "$FORGE_DIR/forge.js" 2>/dev/null)
check "global error net present" "$out" "1"

# ---- v18 FREESTART additions ----

V18H="$T/home18"; mkdir -p "$V18H"

# 58. forge models --free (live): FREE badge, context sizes, cache written
out=$($F models mock --free 2>&1)
check "models --free header" "$out" "free models — mock"
check "models --free :free-suffix id" "$out" "mock-vision:free"
check "models --free priced-free id" "$out" "mock-mini"
check "models --free context size" "$out" "~300k tok"
check "models --free live tag" "$out" "(live)"
check "model cache written" "$(cat "$T/home/models-cache.json" 2>/dev/null)" '"mock-vision:free"'

# 59. forge models <provider> by NAME (no provider switch needed)
out=$($F models mocka 2>&1)
check "models by provider name" "$out" "mock-coder"
out=$($F models nosuch 2>&1)
check "models unknown provider error" "$out" "unknown provider"

# 60. THE v18 HEADLINE: wizard on openrouter auto-detects ALL free models via
#     the PUBLIC /models endpoint (no key yet!) and lists them FIRST
CFGO="$T/forge-or.json"
FORGE_CONFIG="$CFGO" FORGE_HOME="$V18H" $F config set providers.openrouter.baseUrl http://127.0.0.1:8787/v1 >/dev/null 2>&1
out=$(printf '6\n1\nn\nn\n' | FORGE_CONFIG="$CFGO" FORGE_HOME="$V18H" $F onboard 2>&1)
check "wizard free detection (public, pre-key)" "$out" "free models detected (of 4 total)"
check "wizard FREE badge shown" "$out" "FREE"
check "wizard manual line offered" "$out" "enter a model id manually"
check "wizard free model picked+saved" "$(cat "$CFGO" 2>/dev/null)" '"mock-vision:free"'
check "wizard openrouter active" "$(cat "$CFGO" 2>/dev/null)" '"activeProvider": "openrouter"'

# 61. wizard manual/custom model add AFTER choosing openrouter ([m] entry)
CFGM="$T/forge-manual.json"
FORGE_CONFIG="$CFGM" FORGE_HOME="$V18H" $F config set providers.openrouter.baseUrl http://127.0.0.1:8787/v1 >/dev/null 2>&1
out=$(printf '6\nm\nmy-org/my-custom-model\nn\nn\n' | FORGE_CONFIG="$CFGM" FORGE_HOME="$V18H" $F onboard 2>&1)
check "wizard manual entry accepted" "$(cat "$CFGM" 2>/dev/null)" "my-org/my-custom-model"
check "wizard manual still detected free" "$out" "free models detected"

# 62. offline fallback: dead endpoint → cached? no → curated built-in free
#     list, wizard STILL completes (no fail, no stall)
CFGD="$T/forge-off.json"; V18B="$T/home18b"; mkdir -p "$V18B"
FORGE_CONFIG="$CFGD" FORGE_HOME="$V18B" $F config set providers.openrouter.baseUrl http://127.0.0.1:59991/v1 >/dev/null 2>&1
out=$(printf '6\n1\nn\nn\n' | FORGE_CONFIG="$CFGD" FORGE_HOME="$V18B" $F onboard 2>&1)
check "offline fallback suggestions" "$out" "built-in free suggestions"
check "offline fallback model saved" "$(cat "$CFGD" 2>/dev/null)" "deepseek/deepseek-chat-v3-0324:free"

# 63. models --free falls back to the CACHE when the endpoint is down
$F config set providers.mock.baseUrl http://127.0.0.1:59991/v1 >/dev/null 2>&1
out=$($F models mock --free 2>&1)
check "models --free cached fallback" "$out" "(cached)"
check "models --free cached id" "$out" "mock-vision:free"
$F config set providers.mock.baseUrl http://127.0.0.1:8787/v1 >/dev/null 2>&1

# 64. AutoPick FREE-badge source: freeFromCache (unit-level via node -e)
out=$(FORGE_HOME="$T/home" node --input-type=module -e "import {freeFromCache} from 'file://$FORGE_DIR/modelcache.js'; const f = freeFromCache('mock'); console.log(f.map((m) => m.id).join(','))" 2>&1)
check "freeFromCache returns free ids" "$out" "mock-vision:free"

# ---- v19 TERMINAL additions ----

# 65. `!` force prefix: shell output shown in the same chat
out=$(printf '!echo forge-v19-terminal\nbye\n' | $F 2>&1)
check "shell force output" "$out" "forge-v19-terminal"
check "terminal frame drawn" "$out" "\$ echo forge-v19-terminal"

# 66. auto-detect: a bare `pwd` chat line EXECUTES locally (no model call)
out=$(printf 'pwd\nbye\n' | $F 2>&1)
check "shell auto-detect executes" "$out" "\$ pwd"

# 67. cd persists for the session (later commands run there)
out=$(printf '!cd /tmp\npwd\nbye\n' | $F 2>&1)
check "cd persists in session" "$out" "/tmp"

# 68. export persists into later commands (session env)
out=$(printf '!export FORGE_V19=ok19\n!printenv FORGE_V19\nbye\n' | $F 2>&1)
check "export persists in session" "$out" "ok19"

# 69. v88 noguard: nothing is refused in the terminal (probe is harmless —
#     a test must never execute a real root wipe)
out=$(printf '!rm -rf /nonexistent-e2e-v88-probe\nbye\n' | $F 2>&1)
check_absent "v88: terminal command not BLOCKED" "$out" "BLOCKED"
check "v88: the probe command actually ran" "$out" "rm -rf /nonexistent-e2e-v88-probe"

# 70. natural-language look-alikes stay chat messages (no shell exec)
out=$(printf 'Please write a haiku about pwd\nbye\n' | $F 2>&1)
check "sentence stays chat" "$out" "Hello from mock!"

# 70b. v20.0.1: sentences that merely START with a command name were EXECUTED
#      in the shell ("find the bug in main.js" ran find, "node is great" ran
#      node) and the model never saw them. They must stay chat messages…
for s in "find the bug in main.js" "make it work" "cat is my favorite animal" "node is great" "python vs go" "date me" "env is not set"; do
  out=$(printf '%s\nbye\n' "$s" | $F 2>&1)
  if echo "$out" | grep -q "Hello from mock!"; then PASS=$((PASS+1)); echo "  ok  sentence stays chat: $s"
  else FAIL=$((FAIL+1)); echo "  FAIL sentence swallowed by the shell: $s"; fi
done
# …while real commands must still auto-execute without the ! prefix
for c in "pwd" "ls -la" "git status" "echo hello"; do
  out=$(printf '%s\nbye\n' "$c" | $F 2>&1)
  if echo "$out" | grep -qF "\$ $c"; then PASS=$((PASS+1)); echo "  ok  command still auto-detected: $c"
  else FAIL=$((FAIL+1)); echo "  FAIL command no longer auto-detected: $c"; fi
done

# 71. terminal runs are SHARED WITH THE MODEL on the next message
out=$(printf '!echo forge-v19-note\nTERMINAL_NOTE_CHECK\nbye\n' | $F 2>&1)
check "terminal note reaches model" "$out" "TERMINAL NOTE SEEN"

# 72. /shell + /deep toggles (persisted)
out=$(printf '/shell off\n/shell on\n/deep\n/deep\n/exit\n' | $F 2>&1)
check "/shell toggle off" "$out" "shell auto-detect OFF"
check "/shell toggle on" "$out" "shell auto-detect ON"
check "/deep on" "$out" "deep mode ON"
check "/deep off" "$out" "deep mode OFF"

# 73. deep wire: DEEP system directive + provider reasoning params
$F config set providers.mock.model o3-mini >/dev/null 2>&1
$F config set chat.deep true >/dev/null 2>&1
out=$($F chat -m "hello" 2>&1 </dev/null)
check "deep chat streams" "$out" "Hello from mock!"
LAST=$(node -e "fetch('http://127.0.0.1:8787/last-body').then((r)=>r.text()).then((t)=>console.log(t))" 2>&1)
check "deep directive on wire" "$LAST" "DEEP THINKING MODE"
check "reasoning_effort on wire" "$LAST" 'reasoning_effort":"high"'
$F config set chat.deep false >/dev/null 2>&1
$F config set providers.mock.model mock-mini >/dev/null 2>&1

# 74. agent --deep: deep directive + full tool loop
out=$($F agent "USE_TOOL deep run" --deep 2>&1 </dev/null)
check "agent --deep header" "$out" "DEEP"
check "agent --deep tool loop" "$out" "forge-e2e-ok"
check "agent --deep final" "$out" "TOOL RESULT RECEIVED"
LAST=$(node -e "fetch('http://127.0.0.1:8787/last-body').then((r)=>r.text()).then((t)=>console.log(t))" 2>&1)
check "agent deep wire directive" "$LAST" "DEEP THINKING MODE"

# 75. tiered context reduction: SHRINK fires BEFORE summarize (keeps history)
CFGZ2="$T/forge-z2.json"
FORGE_CONFIG="$CFGZ2" $F config set activeProvider mock >/dev/null 2>&1
FORGE_CONFIG="$CFGZ2" $F config set providers.mock.apiKey test-key >/dev/null 2>&1
FORGE_CONFIG="$CFGZ2" $F config set providers.mock.baseUrl http://127.0.0.1:8787/v1 >/dev/null 2>&1
FORGE_CONFIG="$CFGZ2" $F config set providers.mock.model mock-mini >/dev/null 2>&1
FORGE_CONFIG="$CFGZ2" $F config set providers.mock.contextWindow 3000 >/dev/null 2>&1
out=$(FORGE_CONFIG="$CFGZ2" $F agent --cwd "$T/work" "USE_LOUD_COMPACT big outputs" 2>&1 </dev/null)
check "shrink stage fired" "$out" "tool outputs shrunk"
check "shrink run completed" "$out" "TOOL RESULT RECEIVED"

# 76. lazy onboard import (performance): onboard loads only when a wizard runs
out=$(grep -c 'loadOnboard()' "$FORGE_DIR/forge.js" 2>/dev/null)
check "lazy onboard loader" "$out" "3"
check_absent "no static onboard import" "x$(grep -c 'import { runOnboarding' "$FORGE_DIR/forge.js")" "x1"

# 77. help mentions the v19 powers
out=$($F help 2>&1)
check "help mentions AutoPick" "$out" "AutoPick"
check "help mentions --deep" "$out" "--deep"
check "help mentions terminal mode" "$out" "like a real terminal"

# ---- v20 HARDENING additions ----

# 78. v88 noguard: fetch_url fetches loopback URLs (no SSRF gate, no opt-in needed)
out=$(env -u FORGE_ALLOW_PRIVATE_URLS $F agent "USE_URL fetch the page please" 2>&1 </dev/null)
check_absent "v88: no SSRF refusal on loopback" "$out" "SSRF guard"
check "v88: loopback fetch answered by the mock" "$out" "MOCK PAGE 42"

# 79. v88 noguard: writes outside the project are ALLOWED
out=$($F agent --cwd "$T/work" "USE_PATH_ESCAPE write outside" 2>&1 </dev/null)
check "v88: outside write succeeds" "$out" "OK wrote"
# "../../forge-escape-test.txt" resolves relative to the agent cwd ($T/work)
# → dirname($T)/forge-escape-test.txt, i.e. OUTSIDE the project root $T/work
ESCFILE="$(dirname "$T")/forge-escape-test.txt"
if [ -f "$ESCFILE" ]; then
  PASS=$((PASS+1)); echo "  ok  escaped file created (v88: no boundary)"
  rm -f "$ESCFILE"
else
  FAIL=$((FAIL+1)); echo "  FAIL v88 expected the escaped file to exist at $ESCFILE"
fi

# 80. v88 noguard: sensitive reads are allowed (no BLOCKED refusal)
out=$($F agent "USE_SENSITIVE_READ read the key" 2>&1 </dev/null)
check_absent "v88: sensitive read not BLOCKED" "$out" "BLOCKED"

# 81. skill traversal blocked
out=$($F agent "USE_SKILL_TRAVERSAL load that skill" 2>&1 </dev/null)
check "skill traversal blocked" "$out" "invalid skill name"

# 82. v88 noguard: the bash tool runs destructive commands outside the project
#     (the target is a file this test owns in /tmp)
echo "v88" > /tmp/forge-e2e-outside-target
out=$($F agent --cwd "$T/work" "USE_OUTSIDE_RM clean the temp dir" 2>&1 </dev/null)
check_absent "v88: outside rm not BLOCKED" "$out" "BLOCKED"
if [ -e /tmp/forge-e2e-outside-target ]; then
  FAIL=$((FAIL+1)); echo "  FAIL v88 expected the outside target to be removed"
else
  PASS=$((PASS+1)); echo "  ok  outside target removed (v88: no boundary)"
fi

# 83. failure learning recorded to project memory
out=$($F agent --cwd "$T/work" "USE_LEARN remember the fix" 2>&1 </dev/null)
check "learning recorded" "$out" "recorded learning"
check "learning persisted" "$(cat "$T/home/projects"/*/memory.md 2>/dev/null)" "mock test failure X"

# 84. undo removes files CREATED by apply_patch (v19 left them behind)
printf 'first\nold line\nthird\n' > "$T/work/patch2-base.txt"
out=$($F agent --cwd "$T/work" "USE_PATCH apply the patch again" 2>&1 </dev/null)
check "second patch created file" "$(cat "$T/work/patch-new.txt" 2>/dev/null)" "patch line one"
out=$(cd "$T/work" && $F undo 2>&1)
check "undo reports restore" "$out" "restored"
if [ -f "$T/work/patch-new.txt" ]; then
  FAIL=$((FAIL+1)); echo "  FAIL undo must remove created files"
else
  PASS=$((PASS+1)); echo "  ok  undo removed created file"
fi
if grep -q "old line" "$T/work/patch2-base.txt" 2>/dev/null; then
  PASS=$((PASS+1)); echo "  ok  undo restored modified file"
else
  FAIL=$((FAIL+1)); echo "  FAIL undo restored modified file"
fi

# 85. v88 noguard: a piped risky rm just runs — no consent gate at all
printf 'hello doc\n' > "$T/work/risky-target.txt"
out=$(cd "$T/work" && printf '!rm risky-target.txt\nbye\n' | $F 2>&1)
check_absent "v88: piped rm not refused" "$out" "BLOCKED"
if [ -f "$T/work/risky-target.txt" ]; then
  FAIL=$((FAIL+1)); echo "  FAIL v88 rm should have deleted the file"
else
  PASS=$((PASS+1)); echo "  ok  v88 rm deleted without asking"
fi

# 86. v20.0.1 REGRESSION (mv classification) kept as a crash check — v88 never
#     refuses, and a test never writes into /etc or /usr, so use a local rename.
printf 'keepme\n' > "$T/work/mv-target.txt"
out=$(cd "$T/work" && printf '!mv mv-target.txt renamed-v88.txt\nbye\n' | $F 2>&1)
check_absent "v88: mv not BLOCKED" "$out" "BLOCKED"
check_absent "no raw JS error for mv" "$out" "why is not defined"
if [ -f "$T/work/renamed-v88.txt" ]; then
  PASS=$((PASS+1)); echo "  ok  mv actually renamed the file (v88)"
else
  FAIL=$((FAIL+1)); echo "  FAIL v88 mv should have renamed the file"
fi

# 87. v20.0.1: glob_files "**/*.ext" must match files in the search ROOT too
#     (the old glob compiler required at least one "/" and found nothing)
printf 'x' > "$T/work/FORGE_GLOB_ROOT.md"
mkdir -p "$T/work/globbed"
printf 'x' > "$T/work/globbed/FORGE_GLOB_NESTED.md"
out=$($F agent --cwd "$T/work" "USE_DEEPGLOB list every markdown file" 2>&1 </dev/null)
check "**/*.md finds root-level files" "$out" "FORGE_GLOB_ROOT.md"
check "**/*.md finds nested files" "$out" "FORGE_GLOB_NESTED.md"
check "**/*.md glob final answer" "$out" "TOOL RESULT RECEIVED"
out=$($F agent --cwd "$T/work" "USE_GLOB list the markdown files" 2>&1 </dev/null)
check "plain *.md glob still works" "$out" "FORGE_GLOB_ME.md"

# 85b. v90 git views: dedicated diff/log/blame tools through a real agent turn
mkdir -p "$T/gitwork"
printf 'one\ntwo\nthree\n' > "$T/gitwork/blamed.txt"
git -C "$T/gitwork" init -q
git -C "$T/gitwork" add -A
git -C "$T/gitwork" -c user.email=e2e@forge.local -c user.name=e2e commit -q -m "e2e base"
printf 'one\nTWO!\nthree\n' > "$T/gitwork/blamed.txt"
out=$($F agent --cwd "$T/gitwork" "USE_GITDIFF show me the diff" 2>&1 </dev/null)
check "agent git_diff ran" "$out" "TOOL RESULT RECEIVED"
check "agent git_diff shows the file" "$out" "blamed.txt"
out=$($F agent --cwd "$T/gitwork" "USE_GITLOG show recent commits" 2>&1 </dev/null)
check "agent git_log shows the commit" "$out" "e2e base"
out=$($F agent --cwd "$T/gitwork" "USE_GITBLAME who wrote the file" 2>&1 </dev/null)
check "agent git_blame ran" "$out" "TOOL RESULT RECEIVED"

# 85c. v90 empty-response resilience — a model turn with NO text and NO tool
# calls must never silently end the run: one empty turn is nudged and recovers;
# a persistent empty streak fails loudly (no fake completion, no "(empty answer)")
out=$($F agent --cwd "$T/work" "EMPTY_ONCE please answer" 2>&1 </dev/null)
check "empty response nudged and recovered" "$out" "RECOVERED AFTER NUDGE"
check_absent "no silent empty answer" "$out" "(empty answer)"
out=$($F agent --cwd "$T/work" "EMPTY_ALWAYS please answer" 2>&1 </dev/null)
check "persistent empty streak fails loudly" "$out" "3 times in a row"
check "failure names the empty-response problem" "$out" "empty response"
check_absent "empty streak never fakes completion" "$out" "COMPLETED"

# 86. context-overflow recovery: 400 context_length_exceeded → compress → retry
out=$($F chat -m "OVERFLOW_ONCE please answer" 2>&1 </dev/null)
check "overflow recovery fired" "$out" "compressing history and retrying"
check "overflow retry succeeded" "$out" "Hello from mock!"

# 87. /status + /profile
out=$(printf '/status\n/exit\n' | $F chat 2>&1)
check "/status header" "$out" "forge status"
check "/status safety line" "$out" "safety:"
check "/status effort line" "$out" "effort:"
out=$(printf '/profile fast\n/profile\n/exit\n' | $F chat 2>&1)
check "/profile set" "$out" "effort profile → fast"
check "/profile list" "$out" "auto     classify"
$F config set chat.profile auto >/dev/null 2>&1

# 88. sessions carry titles; forge resume restores cwd + messages
out=$($F sessions 2>&1 </dev/null)
check "sessions show title" "$out" "OVERFLOW_ONCE"
REF=$($F sessions 2>&1 </dev/null | grep -oE "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]+-[a-z0-9]+" | head -1)
out=$(cd "$T/work" && printf '' | $F resume "$REF" 2>&1)
check "forge resume loads session" "$out" "resumed session"
check "forge resume restores cwd" "$out" "resumed in "

# 89. export renders tool calls + tool results
out=$(printf 'USE_TOOL inline please\n/export %s\n/exit\n' "$T/work/export2.md" | $F chat 2>&1)
check "export v20 command" "$out" "exported"
check "export tool-call section" "$(cat "$T/work/export2.md" 2>/dev/null)" "assistant (tool calls)"
check "export tool result section" "$(cat "$T/work/export2.md" 2>/dev/null)" "tool result"

# 90. delegate timeout: sub-agent exceeding delegateTimeoutSec is cut off
$F config set agent.delegateTimeoutSec 1 >/dev/null 2>&1
out=$($F agent --cwd "$T/work" "USE_DELEGATE_SLOW dispatch the slow job" 2>&1 </dev/null)
check "delegate timeout fired" "$out" "sub-agent timed out"
$F config set agent.delegateTimeoutSec 180 >/dev/null 2>&1

# 91. secret redaction: terminal output shows raw (real terminal semantics),
# but the note shared with the MODEL is redacted before it enters the request
printf '!echo token=abcdef1234567890abcdef\nhi\n/exit\n' | $F > /dev/null 2>&1
LAST=$(node -e "fetch('http://127.0.0.1:8787/last-body').then((r)=>r.text()).then((t)=>console.log(t))" 2>&1)
check "terminal note redacted for model" "$LAST" "***"
check_absent "raw secret not sent to model" "$LAST" "abcdef1234567890abcdef"

# 92. plan-mode delegation is allowed (delegate is read-only, v20 fix)
out=$($F agent --cwd "$T/work" --plan "USE_DELEGATE research sub.txt" 2>&1 </dev/null)
check "plan mode delegates" "$out" "SUB-AGENT REPORT"

kill $MOCK_PID 2>/dev/null
rm -rf "$T"
echo
echo "== RESULT: $PASS passed, $FAIL failed =="
[ "$FAIL" = "0" ]
