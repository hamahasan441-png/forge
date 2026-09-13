#!/usr/bin/env bash
# forge — installer (P1-10).
#
# Installs the forge CLI globally with npm:
#   bash install.sh                 # npm install -g <this directory>
#   bash install.sh --prefix <dir>  # install into <dir> instead of the
#                                   # global prefix (no sudo needed)
#   bash install.sh --help
#
# Rules this script is held to (tests/test-install.mjs):
#   * npm install runs EXACTLY ONCE — a failing install is surfaced, never
#     retried behind the user's back, and never re-run just to grep its text.
#   * npm's own output is shown, so an EACCES says EACCES.
#   * the EACCES guidance offers the --prefix escape hatch instead of sudo.
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
PREFIX=""

usage() {
  cat <<EOF
usage: bash install.sh [--prefix <dir>]

  Installs the forge CLI from this directory with npm.

  --prefix <dir>  install into <dir> instead of the global npm prefix
                  (use this when the global prefix needs sudo — no root
                  required, then put <dir>/bin on your PATH)
  --help          show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --prefix)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        echo "install.sh: --prefix requires a directory argument" >&2
        usage >&2
        exit 2
      fi
      PREFIX="$2"
      shift 2
      ;;
    -*)
      echo "install.sh: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      echo "install.sh: unexpected argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v npm >/dev/null 2>&1; then
  echo "install.sh: npm not found on PATH — install Node.js >= 20 first" >&2
  exit 1
fi

echo "forge installer: npm install -g $DIR${PREFIX:+ --prefix $PREFIX}"

# P1-10: ONE npm install attempt. Output is NOT swallowed: npm's own text
# (EACCES, ENOSPC, network errors, …) goes to the user verbatim.
if [ -n "$PREFIX" ]; then
  npm install -g "$DIR" --prefix "$PREFIX"
else
  npm install -g "$DIR"
fi
STATUS=$?

if [ $STATUS -ne 0 ]; then
  echo "" >&2
  echo "install.sh: npm install failed (exit $STATUS). npm's output above is the real error." >&2
  cat >&2 <<'EOF'

If the error was EACCES (permission denied), do NOT use sudo. Install into
a prefix you own instead:

  bash install.sh --prefix "$HOME/.npm-global"
  export PATH="$HOME/.npm-global/bin:$PATH"   # add to your shell profile

Using sudo with npm install runs forge's postinstall steps as root and is
the most common cause of a broken global install.
EOF
  exit $STATUS
fi

echo "forge installer: done — run 'forge --version' to verify."
