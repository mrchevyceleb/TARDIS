#!/bin/bash
# TARDIS desktop mac push-update payload. Runs ON a mac. The release step in
# docs/NATIVE.md stages this script there and drives it over the device
# channel, because an unsigned macOS build cannot update itself in place.
#
#   phase1    download the release dmg (TARDIS_URL, TARDIS_BYTES,
#             TARDIS_SHA256, TARDIS_VERSION), byte- and digest-check it,
#             verify the bundled version, and stage TARDIS.app.new beside the
#             running app. The copy is built in a per-run temp directory and
#             only becomes .new once it verifies, so a killed phase1 can never
#             leave a half-staged bundle that phase2 would install. Refuses
#             on any mismatch, before anything is staged. A leading "v" on
#             TARDIS_VERSION (a release tag) is accepted and stripped.
#   phase2    quit the app, swap (the old bundle is kept as TARDIS.app.old),
#             strip the quarantine flag, verify, relaunch. Holds a lock
#             beside the app for the whole swap, so concurrent or repeated
#             phase2 calls can never interleave; if the swapped bundle fails
#             its version check the previous bundle is restored
#             automatically. Self-detaches into its own session first, so a
#             plain device exec can launch it and it keeps running through
#             the quit (the device bridge dies when the app quits, and the
#             app tree-kills the exec shell's process group). Output lands in
#             run.log, the verdict in run.result.
#   rollback  restore TARDIS.app.old (the swapped-out bundle is kept as
#             TARDIS.app.failed) and relaunch. Same lock, same self-detach,
#             and it aborts without changing anything if the app will not
#             quit.
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
LOCK="${APP}.swaplock"

say() { printf '%s\n' "$*"; }
die() { printf 'mac-update: %s\n' "$*" >&2; exit 1; }
# Printed at every swap and appended to the success verdicts: macOS ties the
# Screen Recording + Accessibility grants to the exact bundle, and desktop
# mac builds are ad-hoc signed (no TeamIdentifier), so every swap - a pushed
# update or a rollback - drops those grants for TARDIS on this machine. The
# swap itself is unaffected (it rides device_exec and workspace writes);
# computer control here is dead until a human re-allows TARDIS in System
# Settings > Privacy & Security. No remote fix exists - tccutil only resets,
# it cannot re-grant. Expect this after every push until mac builds are
# properly signed in CI (CSC_LINK).
tcc_note() {
  printf 'note: the swap dropped the Screen Recording + Accessibility grants for TARDIS on this machine (the build is ad-hoc signed, so macOS ties those grants to the exact bundle and drops them on every swap). Re-allow TARDIS in System Settings > Privacy & Security before relying on computer control here - no remote fix exists, tccutil only resets. Expect this after every push until mac builds are CSC_LINK-signed in CI.\n'
}
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
own_lock() {
  # mkdir is atomic, so it is the mutex for every phase2 and rollback. The
  # pid inside lets a later run take over a lock left by a process that died
  # without its exit trap (a kill -9 or a reboot); a live owner is never
  # preempted, so two swaps can never interleave.
  if ! mkdir "$LOCK" 2>/dev/null; then
    local p
    p="$(cat "$LOCK/pid" 2>/dev/null || true)"
    if [ -n "$p" ] && [ -z "$(ps -p "$p" -o pid= 2>/dev/null)" ]; then
      rm -rf "$LOCK"
      mkdir "$LOCK" 2>/dev/null || die "swap-lock contention at $LOCK; retry"
    else
      die "another swap or rollback is running (lock at $LOCK, pid ${p:-unknown}); it must finish first"
    fi
  fi
  printf '%s\n' $$ >"$LOCK/pid"
  trap 'rm -rf "$LOCK"' EXIT
  trap 'rm -rf "$LOCK"; exit 1' INT TERM
}

phase1() {
  : "${TARDIS_URL:?phase1 needs TARDIS_URL: the release dmg download url}"
  : "${TARDIS_BYTES:?phase1 needs TARDIS_BYTES: the release dmg byte size}"
  : "${TARDIS_SHA256:?phase1 needs TARDIS_SHA256: the release dmg sha256 digest}"
  : "${TARDIS_VERSION:?phase1 needs TARDIS_VERSION: the release version}"
  TARDIS_VERSION="${TARDIS_VERSION#v}"
  TARDIS_SHA256="${TARDIS_SHA256#sha256:}"
  if [ ! -d "$APP" ]; then die "no app at $APP (set TARDIS_APP if it lives elsewhere)"; fi
  own_lock
  # Invalidate any earlier staging first, so a killed phase1 can never pair
  # a partial copy with a state file that phase2 would trust.
  rm -f "$STATE" "$RESULT"
  rm -rf "${APP}.new" "${APP}".new.tmp.*
  local dmg="$HERE/TARDIS-$TARDIS_VERSION-mac-arm64.dmg" mount="" \
    tmp="${APP}.new.tmp.$$" got="" v="" sha=""
  say "phase1: downloading $TARDIS_URL"
  curl -fL --retry 3 -o "$dmg" "$TARDIS_URL"
  got="$(stat -f%z "$dmg")"
  if [ "$got" != "$TARDIS_BYTES" ]; then
    rm -f "$dmg"
    die "byte-size mismatch: release says $TARDIS_BYTES, downloaded $got"
  fi
  sha="$(shasum -a 256 "$dmg" | awk '{print $1}')"
  if [ "$(printf '%s' "$sha" | tr '[:upper:]' '[:lower:]')" != \
       "$(printf '%s' "$TARDIS_SHA256" | tr '[:upper:]' '[:lower:]')" ]; then
    rm -f "$dmg"
    die "sha256 mismatch: release says $TARDIS_SHA256, downloaded $sha"
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
  # Copy into a per-run temp dir; only a copy that verifies ever becomes the
  # .new that phase2 installs.
  if ! ditto "$mount/TARDIS.app" "$tmp"; then
    hdiutil detach "$mount" >/dev/null 2>&1 || true
    rm -rf "$tmp" "$dmg"
    die 'could not copy TARDIS.app off the dmg'
  fi
  hdiutil detach "$mount" >/dev/null 2>&1 || true
  v="$(app_version "$tmp")"
  if [ "$v" != "$TARDIS_VERSION" ]; then
    rm -rf "$tmp" "$dmg"
    die "staged copy bundles TARDIS ${v:-unknown}, release says $TARDIS_VERSION"
  fi
  mv "$tmp" "${APP}.new"
  rm -f "$dmg"
  printf 'version=%s\n' "$TARDIS_VERSION" >"$STATE"
  say "phase1: staged ${APP}.new (TARDIS $TARDIS_VERSION); run phase2 to swap it in"
}

phase2() {
  if [ ! -f "$STATE" ] || [ ! -d "${APP}.new" ]; then
    die 'nothing staged: run phase1 first (if this is a retry after a completed swap, the verdict is already in run.result)'
  fi
  local staged old="${APP}.old" new="${APP}.new" v=""
  staged="$(sed -n 's/^version=//p' "$STATE")"
  [ -n "$staged" ] || die "the state file at $STATE has no version; run phase1 again"
  detach_if_needed phase2
  own_lock
  # Re-check everything under the lock, so a retried phase1 or a crash
  # between the checks above and the lock can never slip a mismatched or
  # partial bundle into the swap.
  if [ ! -f "$STATE" ] || [ ! -d "$new" ]; then
    die 'nothing staged: run phase1 first'
  fi
  v="$(app_version "$new")"
  if [ "$v" != "$staged" ]; then
    die "the staged bundle reports TARDIS ${v:-unknown}, the state says $staged; run phase1 again"
  fi
  say "phase2: quitting TARDIS to swap in $staged"
  tcc_note
  if ! wait_for_quit; then die 'TARDIS did not quit; nothing was changed'; fi
  rm -rf "$old"
  mv "$APP" "$old" || die 'could not move the running app aside; nothing was changed'
  if ! mv "$new" "$APP"; then
    mv "$old" "$APP" || true
    die 'swap failed; the previous app was restored at its original path'
  fi
  xattr -dr com.apple.quarantine "$APP" >/dev/null 2>&1 || true
  v="$(app_version "$APP")"
  rm -f "$STATE"
  if [ "$v" != "$staged" ]; then
    # The swapped bundle does not verify: keep it for inspection and put the
    # previous one back, automatically.
    rm -rf "${APP}.failed"
    mv "$APP" "${APP}.failed" || true
    if mv "$old" "$APP"; then
      xattr -dr com.apple.quarantine "$APP" >/dev/null 2>&1 || true
      launch_app || true
      printf 'phase2 failed: the swapped bundle reported %s, expected %s; the previous bundle was restored automatically (now TARDIS %s). The failed bundle is kept at %s.\n' \
        "${v:-nothing}" "$staged" "$(app_version "$APP" || echo unknown)" "${APP}.failed" | tee "$RESULT"
      exit 1
    fi
    printf 'ROLLBACK NOW: bash %s rollback\n(the swap could not be verified and the automatic restore failed; the old bundle may still be at %s)\n' \
      "$0" "$old" | tee "$RESULT"
    exit 1
  fi
  if ! launch_app; then
    printf 'phase2 swapped and verified TARDIS %s but it did not relaunch: the bundle is at %s, launch it from Finder or run "bash %s rollback" (the previous bundle is kept at %s)\n' \
      "$v" "$APP" "$0" "$old" | tee "$RESULT"
    exit 1
  fi
  printf 'phase2 ok: TARDIS.app %s is live; rollback bundle kept at %s\n' "$v" "$old" | tee "$RESULT"
  tcc_note | tee -a "$RESULT"
}

rollback() {
  if [ ! -d "${APP}.old" ]; then die "no rollback bundle at ${APP}.old"; fi
  local v=""
  detach_if_needed rollback
  own_lock
  tcc_note
  if ! wait_for_quit; then die 'TARDIS did not quit; rollback aborted, nothing was changed'; fi
  rm -rf "${APP}.failed"
  if [ -d "$APP" ]; then
    mv "$APP" "${APP}.failed" || die 'could not set the current app aside; nothing was changed'
  fi
  if ! mv "${APP}.old" "$APP"; then
    mv "${APP}.failed" "$APP" || true
    die 'rollback failed; the previous bundle was restored at its original path'
  fi
  xattr -dr com.apple.quarantine "$APP" >/dev/null 2>&1 || true
  v="$(app_version "$APP")"
  if [ -z "$v" ]; then
    printf 'rollback moved the old bundle back but its version could not be read; inspect %s (the swapped-out bundle is kept at %s)\n' \
      "$APP" "${APP}.failed" | tee "$RESULT"
    exit 1
  fi
  if ! launch_app; then
    printf 'rollback restored TARDIS.app %s but it did not relaunch: the bundle is at %s, launch it from Finder\n' \
      "$v" "$APP" | tee "$RESULT"
    exit 1
  fi
  printf 'rollback ok: TARDIS.app restored at %s and is live; the swapped-out bundle is kept at %s\n' \
    "$v" "${APP}.failed" | tee "$RESULT"
  tcc_note | tee -a "$RESULT"
}

case "${1:-}" in
  phase1) phase1 ;;
  phase2) phase2 ;;
  rollback) rollback ;;
  *)
    say 'usage: mac-update.sh phase1|phase2|rollback'
    say '  phase1 needs TARDIS_URL, TARDIS_BYTES, TARDIS_SHA256 and TARDIS_VERSION from the release (a leading v on the version is fine).'
    say '  phase2 and rollback self-detach and hold a lock beside the app, so concurrent or repeated calls cannot interleave.'
    exit 2
    ;;
esac
