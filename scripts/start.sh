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
  # Every input that can change the built client, not only the sources:
  # dependency and build-config updates (lockfiles, package.json, tsconfig,
  # the vite config family) change the bundle without touching src.
  for p in index.html public package.json package-lock.json pnpm-lock.yaml yarn.lock tsconfig.json tsconfig.node.json .env .env.local .env.production .env.production.local vite.config.ts vite.config.mts vite.config.js vite.config.mjs vite.config.cjs vite.config.cts; do
    [[ -e "$p" ]] && inputs+=("$p")
  done
  [[ -n $(find "${inputs[@]}" -newer dist/index.html -print -quit 2>/dev/null) ]]
}
if [[ -x node_modules/.bin/vite ]]; then
  # One build at a time (non-blocking: a concurrent boot keeps the existing
  # bundle rather than waiting), a unique build dir per process, a bounded
  # build, and a swap that restores the previous bundle if it half-fails.
  # Staleness is re-checked under the lock: a boot that waited out another
  # boot's rebuild must not rebuild the same fresh bundle again.
  exec 9>"$HOME/.rivendell/client-build.lock"
  if flock -n 9 && client_stale; then
    echo "[start] client bundle stale: rebuilding dist/ before boot" >&2
    build="dist.new.$$"
    rm -rf "$build"
    if timeout --kill-after=10s 120 node_modules/.bin/vite build --outDir "$build" --emptyOutDir >"$HOME/.rivendell/client-build.log" 2>&1 && [[ -f "$build/index.html" ]]; then
      old="dist.old.$(date +%Y%m%d%H%M%S)"
      if [[ ! -e dist ]] || mv dist "$old" 2>/dev/null; then
        if mv "$build" dist; then
          # Keep the two newest previous bundles; a failed boot can flip back to one.
          ls -dt dist.old.* 2>/dev/null | tail -n +3 | xargs -r rm -rf
          echo "[start] client bundle rebuilt (previous kept at $old)" >&2
        else
          [[ -e dist ]] || mv "$old" dist 2>/dev/null || true
          rm -rf "$build"
          echo "[start] WARN: bundle swap failed after the build; the previous bundle was restored (log: $HOME/.rivendell/client-build.log)" >&2
        fi
      else
        rm -rf "$build"
        echo "[start] WARN: bundle swap failed (log: $HOME/.rivendell/client-build.log); booting with the existing bundle" >&2
      fi
    else
      rm -rf "$build"
      echo "[start] WARN: client rebuild failed or timed out (log: $HOME/.rivendell/client-build.log); booting with the existing bundle" >&2
    fi
  else
    echo "[start] WARN: another client build holds the lock; booting with the existing bundle" >&2
  fi
fi

npm start
