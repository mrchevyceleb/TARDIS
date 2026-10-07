#!/usr/bin/env bash
# Idempotent installer for the no-vision Read guard hook (card-faf580).
# Adds scripts/vision-read-guard.sh as a PreToolUse ^Read$ hook in the
# settings.json of every engine config dir whose lane can be text-only
# (zai always; fireworks/openrouter per-model, decided at spawn by
# RIVENDELL_NO_VISION). Vision-capable engines (claude/tardis, xai/grok)
# never need it: their spawns never set the marker, and the guard exits 0
# instantly without it. Safe to re-run: an existing entry is left as-is.
# Run once per host after deploy (a fresh box needs this same one-time step).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$ROOT/scripts/vision-read-guard.sh"
test -x "$HOOK" || { echo "missing $HOOK" >&2; exit 1; }

for dir in "$HOME/.claude-zai" "$HOME/.claude-fireworks" "$HOME/.claude-openrouter"; do
  mkdir -p "$dir"
  settings="$dir/settings.json"
  if [ -f "$settings" ] && grep -q "vision-read-guard.sh" "$settings"; then
    echo "already installed: $settings"
    continue
  fi
  tmp="$(mktemp)"
  if [ -f "$settings" ]; then
    jq --arg cmd "$HOOK" '.hooks.PreToolUse += [{matcher: "^Read$", hooks: [{type: "command", command: $cmd}]}]' "$settings" > "$tmp"
  else
    printf '{"hooks":{"PreToolUse":[{"matcher":"^Read$","hooks":[{"type":"command","command":"%s"}]}]}}\n' "$HOOK" > "$tmp"
  fi
  mv "$tmp" "$settings"
  echo "installed: $settings"
done
echo "done"
