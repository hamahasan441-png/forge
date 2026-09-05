#!/usr/bin/env bash
# forge installer (v16, verified for v20) — npm global install of the bundled CLI (Node only, no deps)
#
# Fix list vs v15:
#   - explicit Node >= 18 version guard (old Node died with cryptic ESM errors)
#   - EACCES (permission) failures now print 3 concrete working options
#   - verifies `forge` is actually reachable afterwards; if not, prints the
#     exact PATH line to add (npm's global bin dir is often missing from PATH)
#   - Windows note for PowerShell/CMD users
set -u
cd "$(dirname "$0")"

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

# 2. global install, with honest failure guidance
if npm i -g . --silent; then
  echo "✓ forge installed globally (npm package: forge-agent-cli)"
else
  # distinguish permission failures from other breakage
  if npm i -g . 2>&1 | grep -q "EACCES"; then
    echo "! global install failed: EACCES (npm's prefix is root-owned). Options:"
    echo "   1) sudo bash install.sh"
    echo "   2) per-user prefix (no sudo ever again):"
    echo "        mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global"
    echo "        export PATH=\"\$HOME/.npm-global/bin:\$PATH\"   # add to ~/.bashrc or ~/.zshrc"
    echo "        bash install.sh"
    echo "   3) skip installing — run directly:  node $(pwd)/forge.js"
    exit 1
  fi
  echo "! global install failed — trying npm link"
  if npm link; then
    echo "✓ forge linked — type: forge"
  else
    echo "! fallback: run it directly with:  node $(pwd)/forge.js"
    exit 1
  fi
fi

# 3. verify forge is reachable — PATH guidance if not
NODE_BIN_DIR="$(npm prefix -g 2>/dev/null)/bin"
if ! command -v forge >/dev/null 2>&1; then
  echo "! 'forge' is not on your PATH yet — finish the install with ONE of:"
  echo "    export PATH=\"$NODE_BIN_DIR:\$PATH\"      # add this line to ~/.bashrc or ~/.zshrc"
  echo "  or run directly:  node $(pwd)/forge.js"
  echo "  (Windows PowerShell: use npm i -g . from this folder, then just 'forge')"
  exit 1
fi

# 4. proof
forge version && echo "✓ done — start with:  forge"
