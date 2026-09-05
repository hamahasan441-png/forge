#!/usr/bin/env bash
# forge installer — npm global install of the bundled CLI (Node only, zero deps)
#
# v20.3 (P1-10):
#   - the install is attempted ONCE. v16..v20.2 ran `npm i -g .` a second time
#     just to grep its error for EACCES, doubling an already-slow failure — and
#     if that second run happened to succeed it was still treated as a failure.
#     The output of the single attempt is captured and reused for diagnosis.
#   - dropped `--silent`: it threw away the very diagnostics we then re-ran to get.
#     npm's output is shown verbatim when the install fails.
#   - `--prefix <dir>` (or FORGE_PREFIX=<dir>) installs into a user-owned prefix
#     without touching the global npm config — the no-sudo path, and what CI and
#     the clean-room suite already do by hand.
#   - pre-flight: the target prefix must be writable and have room.
#   (No network pre-flight: forge has zero dependencies, so installing this local
#    folder never hits the registry.)
#
# Earlier fixes kept: Node >= 18 guard, EACCES guidance, reachability check with
# the exact PATH line, Windows note.
set -u
cd "$(dirname "$0")"

PREFIX="${FORGE_PREFIX:-}"
usage() {
  cat <<USAGE
usage: bash install.sh [--prefix <dir>]

  --prefix <dir>   install into <dir> instead of npm's global prefix
                   (no sudo; binary lands in <dir>/bin). Also settable as
                   FORGE_PREFIX=<dir>.
  -h, --help       this help
USAGE
}
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="${2:-}"; [ -n "$PREFIX" ] || { echo "✗ --prefix needs a directory"; exit 2; }; shift 2 ;;
    --prefix=*) PREFIX="${1#--prefix=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "✗ unknown option: $1"; usage; exit 2 ;;
  esac
done

echo "forge installer — $(pwd)"

# 1. Node present + version >= 18
if ! command -v node >/dev/null 2>&1; then
  echo "✗ node missing — install Node.js >= 18 first (https://nodejs.org; on Termux: pkg install nodejs-lts)"
  exit 1
fi
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  echo "✗ forge needs Node.js >= 18 — found $(node --version)."
  echo "  Upgrade node, then re-run this script."
  exit 1
fi
echo "✓ node $(node --version)"
command -v npm >/dev/null 2>&1 || { echo "✗ npm missing — reinstall Node.js (npm ships with it)"; exit 1; }

# 2. pre-flight on the install target: writable + has room
TARGET="$PREFIX"
[ -n "$TARGET" ] || TARGET="$(npm prefix -g 2>/dev/null || echo "")"
if [ -n "$TARGET" ]; then
  mkdir -p "$TARGET" 2>/dev/null || true
  if [ -d "$TARGET" ] && [ ! -w "$TARGET" ]; then
    echo "! install target is not writable: $TARGET"
    echo "  use a user-owned prefix instead:  bash install.sh --prefix \"\$HOME/.local\""
  fi
  FREE_KB="$(df -Pk "$TARGET" 2>/dev/null | awk 'NR==2 {print $4}')"
  case "${FREE_KB:-}" in
    ''|*[!0-9]*) : ;;  # unknown — don't block the install on a df quirk
    *) if [ "$FREE_KB" -lt 51200 ]; then
         echo "✗ only $((FREE_KB / 1024)) MB free on $TARGET — forge needs ~50 MB (mostly the 69 bundled skills)."
         exit 1
       fi ;;
  esac
fi

# 3. install ONCE, keeping the output for diagnosis
NPM_ARGS="-g ."
[ -n "$PREFIX" ] && NPM_ARGS="$NPM_ARGS --prefix $PREFIX"
OUT="$(npm i $NPM_ARGS 2>&1)"
STATUS=$?
if [ $STATUS -eq 0 ]; then
  echo "✓ forge installed${PREFIX:+ into $PREFIX} (npm package: forge-agent-cli)"
else
  echo "$OUT"
  case "$OUT" in
    *EACCES*)
      echo "! global install failed: EACCES (npm's prefix is root-owned). Options:"
      echo "   1) per-user prefix (no sudo ever again):"
      echo "        bash install.sh --prefix \"\$HOME/.local\""
      echo "        export PATH=\"\$HOME/.local/bin:\$PATH\"   # add to ~/.bashrc or ~/.zshrc"
      echo "   2) sudo bash install.sh"
      echo "   3) skip installing — run directly:  node $(pwd)/forge.js"
      exit 1 ;;
  esac
  echo "! install failed — trying npm link"
  if npm link; then
    echo "✓ forge linked — type: forge"
  else
    echo "! fallback: run it directly with:  node $(pwd)/forge.js"
    exit 1
  fi
fi

# 4. verify forge is reachable — PATH guidance if not
if [ -n "$PREFIX" ]; then BIN_DIR="$PREFIX/bin"; else BIN_DIR="$(npm prefix -g 2>/dev/null)/bin"; fi
if ! command -v forge >/dev/null 2>&1; then
  echo "! 'forge' is not on your PATH yet — finish the install with ONE of:"
  echo "    export PATH=\"$BIN_DIR:\$PATH\"      # add this line to ~/.bashrc or ~/.zshrc"
  echo "  or run directly:  node $(pwd)/forge.js"
  echo "  (Windows PowerShell: use npm i -g . from this folder, then just 'forge')"
  exit 1
fi

# 5. proof
forge version && echo "✓ done — start with:  forge"
