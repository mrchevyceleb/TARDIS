#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mkdir -p "$HOME/.rivendell"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

export PORT="${PORT:-8091}"
export HOST="${HOST:-127.0.0.1}"
# Optional remote MCP mirroring is opt-in for a clean public install.
export RIVENDELL_BANANA_REMOTE_MCP="${RIVENDELL_BANANA_REMOTE_MCP:-0}"
# TARDIS is an always-on headless daemon. Claude/Codex authentication must
# fail visibly in chat/logs rather than launching OAuth tabs on a headless server's dormant
# desktop session. Override with RIVENDELL_CLI_BROWSER only for intentional,
# attended maintenance.
export BROWSER="${RIVENDELL_CLI_BROWSER:-/bin/false}"

# The client bundle is served from dist/ (server config STATIC_DIR), and a
# checkout that moves (pull/merge/ff) never rebuilds it on its own: an
# operator restart alone would keep serving a stale client (Oct 13: the rail
# order change went live server-side while the served bundle was a day old).
# Rebuild on boot when the client sources are newer than the bundle, guarded:
# build into dist.new, swap by rename, keep the old bundle on any failure, and
# never touch a checkout without a local vite.
client_stale() {
  [[ ! -f dist/index.html ]] && return 0
  local inputs=(src)
  local p
  for p in index.html public vite.config.ts vite.config.mts vite.config.js; do
    [[ -e "$p" ]] && inputs+=("$p")
  done
  [[ -n $(find "${inputs[@]}" -newer dist/index.html -print -quit 2>/dev/null) ]]
}
if [[ -x node_modules/.bin/vite ]] && client_stale; then
  echo "[start] client bundle stale: rebuilding dist/ before boot" >&2
  rm -rf dist.new
  if node_modules/.bin/vite build --outDir dist.new --emptyOutDir >"$HOME/.rivendell/client-build.log" 2>&1 && [[ -f dist.new/index.html ]]; then
    old="dist.old.$(date +%Y%m%d%H%M%S)"
    mv dist "$old" 2>/dev/null || true
    mv dist.new dist
    # Keep the two newest previous bundles; a failed boot can flip back to one.
    ls -dt dist.old.* 2>/dev/null | tail -n +3 | xargs -r rm -rf
    echo "[start] client bundle rebuilt (previous kept at $old)" >&2
  else
    rm -rf dist.new
    echo "[start] WARN: client rebuild failed (log: $HOME/.rivendell/client-build.log); booting with the existing bundle" >&2
  fi
fi

npm start
