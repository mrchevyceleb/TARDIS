#!/usr/bin/env bash
# Install the TARDIS robot companion on a Doly (Raspberry Pi OS) as a systemd
# service. Run from the robot/ directory of a TARDIS checkout, as root:
#
#   sudo ./install.sh https://your-server.your-tailnet.ts.net [RobotName]   (default name: Spark)
#
# Re-running upgrades the code and keeps /etc/tardis-robot.env. The robot must
# be able to reach the ship: put it on the same tailnet (see docs/ROBOT.md).
set -euo pipefail

SHIP_URL="${1:-${TARDIS_URL:-}}"
ROBOT_NAME="${2:-${TARDIS_ROBOT_NAME:-Spark}}"
PREFIX="${TARDIS_ROBOT_PREFIX:-/opt/tardis-robot}"
ENV_FILE="/etc/tardis-robot.env"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "run as root: sudo $0 $*" >&2
  exit 1
fi
if [[ -z "$SHIP_URL" && ! -f "$ENV_FILE" ]]; then
  echo "usage: sudo $0 <ship-url> [robot-name]" >&2
  exit 1
fi

echo "==> system packages"
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv python3-pip libportaudio2 alsa-utils git rsync >/dev/null
fi

echo "==> python environment at $PREFIX"
mkdir -p "$PREFIX"
# --system-site-packages: the Doly SDK (doly_*) and OpenCV are preinstalled in
# the robot's system Python and must stay visible inside the venv.
if [[ ! -x "$PREFIX/venv/bin/python" ]]; then
  python3 -m venv --system-site-packages "$PREFIX/venv"
fi
"$PREFIX/venv/bin/pip" install --quiet --upgrade pip
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude venv --exclude '__pycache__' "$HERE/" "$PREFIX/src/"
else
  rm -rf "$PREFIX/src" && mkdir -p "$PREFIX/src" && cp -a "$HERE/." "$PREFIX/src/" && rm -rf "$PREFIX/src/venv"
fi
"$PREFIX/venv/bin/pip" install --quiet "$PREFIX/src"
echo "==> voice audio package (failure here only disables voice)"
# Only the 'voice' extra by default: local audio I/O for the Grok voice call.
# The 'wake' extra is intentionally left out (see pyproject) because openWakeWord
# pulls a numpy that breaks the preinstalled OpenCV; summon by touch instead.
"$PREFIX/venv/bin/pip" install --quiet "$PREFIX/src[voice]" || echo "   voice extra did not install; the robot still links, without voice"

echo "==> configuration $ENV_FILE"
if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<EOF
TARDIS_URL=$SHIP_URL
TARDIS_ROBOT_NAME=$ROBOT_NAME
TARDIS_ROBOT_HARDWARE=auto
TARDIS_ROBOT_STATE_DIR=/var/lib/tardis-robot
TARDIS_VOICE=auto
TARDIS_WAKE_WORD=hey_jarvis
TARDIS_TOUCH_SUMMON=1
TARDIS_LOG_LEVEL=INFO
EOF
  chmod 600 "$ENV_FILE"
else
  if [[ -n "$SHIP_URL" ]]; then
    sed -i "s#^TARDIS_URL=.*#TARDIS_URL=$SHIP_URL#" "$ENV_FILE"
  fi
  echo "   kept existing $ENV_FILE"
fi
mkdir -p /var/lib/tardis-robot

echo "==> service"
install -m 644 "$HERE/tardis-robot.service" /etc/systemd/system/tardis-robot.service
systemctl daemon-reload
systemctl enable tardis-robot >/dev/null
systemctl restart tardis-robot
sleep 3
systemctl --no-pager --lines=12 status tardis-robot || true

cat <<EOF

Done. The robot dials the ship at $(grep '^TARDIS_URL=' "$ENV_FILE" | cut -d= -f2-).
  logs:    journalctl -u tardis-robot -f
  config:  $ENV_FILE  (then: sudo systemctl restart tardis-robot)
  check:   $PREFIX/venv/bin/tardis-robot --check
EOF
