#!/bin/bash
# TARDIS desktop mac push-update payload. Runs ON a mac. The release step in
# docs/NATIVE.md stages this script there and drives it over the device
# channel, because an unsigned macOS build cannot update itself in place.
#
#   phase1    download the release dmg (TARDIS_URL, TARDIS_BYTES,
#             TARDIS_VERSION), byte-check it, verify the bundled version, and
#             stage TARDIS.app.new beside the running app. Refuses on any
#             mismatch, before anything is staged.
#   phase2    quit the app, swap (the old bundle is kept as TARDIS.app.old),
#             strip the quarantine flag, relaunch, verify. Self-detaches into
#             its own session first, so a plain device exec can launch it and
#             it keeps running through the quit (the device bridge dies when
#             the app quits, and the app tree-kills the exec shell's process
#             group). Output lands in run.log, the verdict in run.result.
#   rollback  restore TARDIS.app.old (the swapped-out bundle is kept as
#             TARDIS.app.failed) and relaunch. Self-detaches the same way.
#
# Touches only TARDIS.app* beside the running app and files next to this
# script. The app path is read from its usual location; override with
# TARDIS_APP=path/to/TARDIS.app if it is installed elsewhere.
set -euo pipefail

APP="${TARDIS_APP:-$HOME/Applications/TARDIS.app}"
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="$HERE/.mac-update-state"
LOG="$HERE/run.log"
RESULT="$HERE/run.result"

say() { printf '%s\n' "$*"; }
die() { printf 'mac-update: %s\n' "$*" >&2; exit 1; }
app_version() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
    "$1/Contents/Info.plist" 2>/dev/null || true
}
app_is_running() {
  # pgrep does not see the app from the device-exec context on macOS, but ps
  # does; match the main executable path exactly (the helpers' paths differ).
  ps ax -o comm= | grep -Fqx "$APP/Contents/MacOS/TARDIS"
}
wait_for_quit() {
  osascript -e 'tell application "TARDIS" to quit' >/dev/null 2>&1 || true
  local i
  for i in $(seq 1 30); do
    if ! app_is_running; then return 0; fi
    sleep 1
  done
  return 1
}
launch_app() {
  # An open issued right after the quit can return 0 without spawning
  # anything (LaunchServices is still finalizing the old instance), so
  # verify the process is really up and try a bounded number of times.
  local attempt i
  for attempt in 1 2 3; do
    open "$APP" >/dev/null 2>&1 || true
    for i in $(seq 1 10); do
      if app_is_running; then return 0; fi
      sleep 1
    done
  done
  return 1
}
detach_if_needed() {
  # The device bridge dies when the app quits, and the app tree-kills the
  # device-exec shell's whole process group. Re-exec detached in a session
  # of our own, and the swap survives the quit. No Terminal and no computer
  # control needed: an unsigned swap also loses the old bundle's Screen
  # Recording and Accessibility grants, so computer control is not reliable
  # between pushes anyway.
  if [ "${MAC_UPDATE_DETACHED:-}" = "1" ]; then return 0; fi
  # exec via /bin/bash: the staged copy carries no execute bit (device_write
  # lands 0644), and this log is per-run, so it truncates.
  perl -e 'use POSIX qw(setsid); exit if fork; setsid(); exec @ARGV' \
    /bin/bash -c 'export MAC_UPDATE_DETACHED=1; exec /bin/bash "$1" "$2" > "$3" 2>&1' \
    detacher "$0" "$1" "$LOG"
  say "$1: detached, running through the app quit; the verdict lands in $(basename "$RESULT")"
  exit 0
}

phase1() {
  : "${TARDIS_URL:?phase1 needs TARDIS_URL: the release dmg download url}"
  : "${TARDIS_BYTES:?phase1 needs TARDIS_BYTES: the release dmg byte size}"
  : "${TARDIS_VERSION:?phase1 needs TARDIS_VERSION: the release version}"
  if [ ! -d "$APP" ]; then die "no app at $APP (set TARDIS_APP if it lives elsewhere)"; fi
  local dmg="$HERE/TARDIS-$TARDIS_VERSION-mac-arm64.dmg" mount="" got="" v=""
  say "phase1: downloading $TARDIS_URL"
  curl -fL --retry 3 -o "$dmg" "$TARDIS_URL"
  got="$(stat -f%z "$dmg")"
  if [ "$got" != "$TARDIS_BYTES" ]; then
    rm -f "$dmg"
    die "byte-size mismatch: release says $TARDIS_BYTES, downloaded $got"
  fi
  mount="$(hdiutil attach -nobrowse -readonly "$dmg" \
    | sed -n 's/^.*[[:space:]]\(\/Volumes\/.*\)$/\1/p' | tail -1)"
  if [ -z "$mount" ] || [ ! -d "$mount/TARDIS.app" ]; then
    if [ -n "$mount" ]; then hdiutil detach "$mount" >/dev/null 2>&1 || true; fi
    rm -f "$dmg"
    die 'could not mount the dmg or find TARDIS.app on it'
  fi
  v="$(app_version "$mount/TARDIS.app")"
  if [ "$v" != "$TARDIS_VERSION" ]; then
    hdiutil detach "$mount" >/dev/null 2>&1 || true
    rm -f "$dmg"
    die "dmg bundles TARDIS ${v:-unknown}, release says $TARDIS_VERSION"
  fi
  rm -rf "${APP}.new"
  ditto "$mount/TARDIS.app" "${APP}.new"
  hdiutil detach "$mount" >/dev/null 2>&1 || true
  rm -f "$dmg" "$RESULT" "$LOG"
  printf 'version=%s\n' "$TARDIS_VERSION" >"$STATE"
  say "phase1: staged ${APP}.new (TARDIS $TARDIS_VERSION); run phase2 to swap it in"
}

phase2() {
  if [ ! -f "$STATE" ] || [ ! -d "${APP}.new" ]; then
    die 'nothing staged: run phase1 first'
  fi
  local staged old="${APP}.old" new="${APP}.new" v=""
  staged="$(sed -n 's/^version=//p' "$STATE")"
  detach_if_needed phase2
  say "phase2: quitting TARDIS to swap in $staged"
  if ! wait_for_quit; then die 'TARDIS did not quit; nothing was changed'; fi
  rm -rf "$old"
  mv "$APP" "$old"
  mv "$new" "$APP"
  xattr -dr com.apple.quarantine "$APP" >/dev/null 2>&1 || true
  v="$(app_version "$APP")"
  rm -f "$STATE"
  if [ "$v" != "$staged" ]; then
    printf 'ROLLBACK NOW: bash %s rollback\n(swapped bundle reports %s, expected %s; the old bundle is intact at %s)\n' \
      "$0" "${v:-nothing}" "$staged" "$old" | tee "$RESULT"
    exit 1
  fi
  if ! launch_app; then
    say "warn: TARDIS did not come back up on its own; launch it from $APP (the swap itself is complete and verified)"
  fi
  printf 'phase2 ok: TARDIS.app %s is live; rollback bundle kept at %s\n' "$v" "$old" | tee "$RESULT"
}

rollback() {
  if [ ! -d "${APP}.old" ]; then die "no rollback bundle at ${APP}.old"; fi
  detach_if_needed rollback
  if ! wait_for_quit; then say 'warn: TARDIS did not quit; swapping anyway'; fi
  rm -rf "${APP}.failed"
  if [ -d "$APP" ]; then mv "$APP" "${APP}.failed"; fi
  mv "${APP}.old" "$APP"
  launch_app || true
  say "rollback done: TARDIS.app restored at $(app_version "$APP" || echo unknown); the swapped-out bundle is kept at ${APP}.failed"
}

case "${1:-}" in
  phase1) phase1 ;;
  phase2) phase2 ;;
  rollback) rollback ;;
  *)
    say 'usage: mac-update.sh phase1|phase2|rollback'
    say '  phase1 needs TARDIS_URL, TARDIS_BYTES and TARDIS_VERSION from the release.'
    say '  phase2 and rollback self-detach, so a plain device exec can launch them.'
    exit 2
    ;;
esac
