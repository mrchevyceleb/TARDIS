#!/usr/bin/env bash
set -euo pipefail
umask 077
kit="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
[[ "$(uname -s)" == Linux && $EUID -ne 0 ]] || { echo 'Run this from the installed Linux as its normal user, without sudo.'; exit 1; }
command -v python3 >/dev/null || { echo 'Python 3 is required. Install it with your Linux package manager, then rerun.'; exit 1; }
(cd "$kit"; sha256sum -c SHA256SUMS) || { echo 'USB integrity check failed. Recopy the kit.'; exit 1; }
log_dir="$HOME/.local/share/tardis-setup"
mkdir -p "$log_dir"; chmod 700 "$log_dir"
log="$log_dir/install-$(date +%Y%m%d-%H%M%S).log"
touch "$log"; chmod 600 "$log"
exec > >(tee -a "$log") 2>&1
echo 'TARDIS setup will preserve the installed Linux and AMD drivers.'
sudo -v
# Keep the single attended sudo approval alive while packages and runtimes download.
(while kill -0 $$ 2>/dev/null; do sudo -n true || exit; sleep 45; done) &
sudo_keepalive=$!
trap 'kill "$sudo_keepalive" 2>/dev/null || true' EXIT
export KIM_SETUP_BUNDLE_DIR="$kit"
export TARDIS_REF RALLYPOINT_REF
TARDIS_REF="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tardis"])' "$kit/release.json")"
RALLYPOINT_REF="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["rallypoint"])' "$kit/release.json")"
bash "$kit/setup-kim.sh"
printf '\nInstallation complete. Setup log: %s\n' "$log"
