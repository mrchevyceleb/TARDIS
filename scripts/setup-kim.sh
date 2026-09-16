#!/usr/bin/env bash
# Copy this file to a USB and run: bash setup-kim.sh
# Uses Kim's own account, GitHub access, subscriptions and content database.
set -euo pipefail
umask 077
say() { printf '\n%s\n' "$*"; }
die() { printf '\nSetup stopped: %s\n' "$*" >&2; exit 1; }
trap 'printf "\nSetup stopped at line %s. Fix the reported problem and rerun this script. No credentials were printed.\n" "$LINENO" >&2' ERR
bundle_dir="${KIM_SETUP_BUNDLE_DIR:-}"

[[ "$(uname -s)" == Linux ]] || die 'Run this on the new Linux computer, not Windows or macOS.'
[[ $EUID -ne 0 ]] || die 'Log in as Kim and run without sudo. The script asks sudo only for system packages.'
[[ -f /etc/os-release ]] || die 'Cannot identify this Linux distribution.'
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-} ${ID_LIKE:-}" in *ubuntu*|*debian*) ;; *) die 'This setup supports Ubuntu/Debian vendor images. Keep the AMD image; install GNOME and prerequisites with its supported package manager.' ;; esac
case "$(uname -m)" in x86_64) node_arch=x64 ;; aarch64|arm64) node_arch=arm64 ;; *) die 'A 64-bit x86 or ARM Linux machine is required.' ;; esac
[[ -d /run/systemd/system ]] || die 'Boot the vendor Linux installation with systemd; a live installer or container is not supported.'
[[ ! -d /run/live/medium && ! -d /rofs ]] || die 'This is a temporary live Linux session. Boot the installed vendor Linux first, then launch the USB kit so the installation persists.'
command -v sudo >/dev/null || die 'Install sudo or ask the machine administrator to grant Kim sudo access.'

# Check before changing packages, CLIs, configuration, or application files.
# There is deliberately no automatic stop: startup and routine admission cannot
# be atomically drained across two independently running apps by this installer.
assert_services_stopped() {
  local unit state
  for unit in tardis.service rallypoint-engine.service; do
    state="$(systemctl --user show "$unit" --property=ActiveState --value)" || die 'Cannot inspect user services. Run setup from Kim?s normal logged-in Linux session.'
    case "$state" in inactive|failed) ;; *) die "$unit is $state. Finish all agent/content work, stop both user services, then rerun setup. See docs/KIM-SETUP.md." ;; esac
  done
}
assert_services_stopped

config_dir="$HOME/.config/tardis"
runtime_dir="$HOME/.local/share/tardis-runtime"
tardis_dir="$HOME/Applications/TARDIS"
rally_dir="$HOME/Applications/RallyPoint"
node_version=22.22.0
node_dir="$runtime_dir/node-v${node_version}-linux-${node_arch}"
export PATH="$runtime_dir/npm/bin:$node_dir/bin:$HOME/.local/bin:$PATH"
export KIM_SETUP_CONFIG_DIR="$config_dir" KIM_SETUP_HOME="$HOME"
mkdir -p "$config_dir" "$runtime_dir" "$HOME/Applications" "$HOME/.local/bin"
chmod 700 "$config_dir"

say "Preparing ${PRETTY_NAME:-Linux} (${node_arch}). The vendor OS, kernel, and ROCm stack are kept."
sudo apt-get update
sudo apt-get install -y --no-install-recommends ca-certificates curl git xz-utils build-essential python3 gh xdg-utils dbus-user-session ffmpeg
if ! command -v gnome-shell >/dev/null; then
  say 'Adding the GNOME desktop. Existing GPU drivers and vendor packages are not replaced.'
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gnome-shell gnome-session gnome-terminal nautilus gdm3 network-manager-gnome
fi
sudo systemctl set-default graphical.target
if ! systemctl cat display-manager.service >/dev/null 2>&1; then sudo systemctl enable gdm3; fi
if ! command -v firefox >/dev/null && ! command -v firefox-esr >/dev/null && ! command -v chromium >/dev/null && ! command -v google-chrome >/dev/null; then
  if [[ "${ID:-}" == ubuntu ]]; then sudo apt-get install -y firefox
  else sudo apt-get install -y firefox-esr; fi
fi

if [[ ! -x "$node_dir/bin/node" ]]; then
  say "Installing isolated Node ${node_version} for TARDIS."
  download_dir="$(mktemp -d)"
  archive="node-v${node_version}-linux-${node_arch}.tar.xz"
  curl --fail --silent --show-error --location "https://nodejs.org/dist/v${node_version}/${archive}" -o "$download_dir/$archive"
  curl --fail --silent --show-error --location "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" -o "$download_dir/SHASUMS256.txt"
  (cd "$download_dir"; awk -v archive="$archive" '$2 == archive' SHASUMS256.txt > selected.sha256; [[ -s selected.sha256 ]]; sha256sum -c selected.sha256)
  tar --no-same-owner -xJf "$download_dir/$archive" -C "$runtime_dir"
  rm -f -- "$download_dir/$archive" "$download_dir/SHASUMS256.txt" "$download_dir/selected.sha256"
  rmdir -- "$download_dir"
fi
[[ "$(node --version)" == "v${node_version}" ]] || die 'The isolated Node installation did not activate.'
npm install --global --prefix "$runtime_dir/npm" pnpm@10.28.2 @anthropic-ai/claude-code@2.1.272 @openai/codex@0.154.0

if [[ -n "$bundle_dir" ]]; then
  [[ -f "$bundle_dir/tardis.bundle" && -f "$bundle_dir/rallypoint.bundle" && -f "$bundle_dir/SHA256SUMS" ]] || die 'USB source bundles are incomplete. Rebuild the kit.'
  (cd "$bundle_dir"; sha256sum -c SHA256SUMS) || die 'USB integrity check failed. Recopy the kit.'
  say 'Using the reviewed source included on this USB. GitHub sign-in can be completed later for updates.'
elif ! gh auth status --hostname github.com >/dev/null 2>&1; then
  say 'Sign into the GitHub account that has access to both shared repositories.'
  gh auth login --hostname github.com --git-protocol https --web
fi
if [[ -z "$bundle_dir" ]]; then
gh repo view mrchevyceleb/TARDIS --json name >/dev/null 2>&1 || die 'This GitHub account cannot access mrchevyceleb/TARDIS.'
gh repo view R-Link-LLC/RallyPoint --json name >/dev/null 2>&1 || die 'This GitHub account needs access to private R-Link-LLC/RallyPoint. Grant access, then rerun.'
gh auth setup-git --hostname github.com
fi


prepare_repo() {
  local repo="$1" dest="$2" requested_ref="$3" output_var="$4" created=0 remote target bundle
  [[ "$requested_ref" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || die "Invalid Git ref for $repo."
  [[ ! -L "$dest" ]] || die "Refusing a symlink at $dest."
  if [[ -n "$bundle_dir" ]]; then
    if [[ "$repo" == mrchevyceleb/TARDIS ]]; then bundle="$bundle_dir/tardis.bundle"; else bundle="$bundle_dir/rallypoint.bundle"; fi
  fi
  if [[ ! -e "$dest" ]]; then
    if [[ -n "${bundle:-}" ]]; then git clone "$bundle" "$dest"; git -C "$dest" remote set-url origin "https://github.com/$repo.git";
    else gh repo clone "$repo" "$dest" -- --filter=blob:none; fi
    created=1
  fi
  [[ -d "$dest/.git" ]] || die "$dest is not a normal Git checkout."
  remote="$(git -C "$dest" remote get-url origin)"
  case "$remote" in "https://github.com/$repo"|"https://github.com/$repo.git"|"git@github.com:$repo.git") ;; *) die "Unexpected origin in $dest. Your checkout was left intact." ;; esac
  [[ -z "$(git -C "$dest" status --porcelain)" ]] || die "$dest has uncommitted files. Preserve or commit them before rerunning."
  if [[ -n "${bundle:-}" ]]; then git -C "$dest" fetch "$bundle" "$requested_ref"; else git -C "$dest" fetch origin "$requested_ref"; fi
  target="$(git -C "$dest" rev-parse 'FETCH_HEAD^{commit}')"
  if [[ $created == 0 ]]; then
    git -C "$dest" merge-base --is-ancestor HEAD "$target" || die "$repo diverged or the requested version is older. Resolve it manually; setup never resets work."
  fi
  printf -v "$output_var" '%s' "$target"
  printf '%s %s\n' "$repo" "$target" >> "$config_dir/install-commits.txt"
}
: > "$config_dir/install-commits.txt"
prepare_repo mrchevyceleb/TARDIS "$tardis_dir" "${TARDIS_REF:-main}" tardis_target
prepare_repo R-Link-LLC/RallyPoint "$rally_dir" "${RALLYPOINT_REF:-main}" rally_target
[[ -n "$(git -C "$tardis_dir" ls-tree "$tardis_target" server/src/routes/contentGateway.ts)" && -n "$(git -C "$rally_dir" ls-tree "$rally_target" apps/engine/src/headless.ts)" ]] || die 'These repository versions do not contain the content integration. Push the reviewed release and rerun with its commit refs.'

if [[ ! -f "$config_dir/rallypoint.env" && -n "$bundle_dir" && -f "$bundle_dir/workspace.json" ]]; then
  export KIM_SETUP_WORKSPACE_FILE="$bundle_dir/workspace.json"
  python3 - <<'PY'
import json,os
from pathlib import Path
source=json.loads(Path(os.environ['KIM_SETUP_WORKSPACE_FILE']).read_text(encoding='utf-8-sig'))
values={key:source[key] for key in ('SUPABASE_URL','SUPABASE_SERVICE_KEY')}
assert all(isinstance(v,str) and v for v in values.values()), 'USB workspace configuration is incomplete'
path=Path(os.environ['KIM_SETUP_CONFIG_DIR'])/'rallypoint.env'
with path.open('x') as out: out.write(''.join(k+'='+json.dumps(v)+'\n' for k,v in values.items()))
path.chmod(0o600)
PY
fi
if [[ ! -f "$config_dir/rallypoint.env" ]]; then
  say 'Enter the content database provisioned for Kim. Do not copy another installation’s .env or credentials.'
  if [[ -z "${KIM_SB_URL:-}" ]]; then read -r -p 'Supabase project URL: ' KIM_SB_URL; fi
  if [[ -z "${KIM_SB_SERVICE_KEY:-}" ]]; then read -r -s -p 'Supabase service-role key (hidden): ' KIM_SB_SERVICE_KEY; printf '\n'; fi
  [[ -n "$KIM_SB_URL" && -n "$KIM_SB_SERVICE_KEY" ]] || die 'Content database URL and service-role key are required. Provision the database and rerun.'
  export KIM_SB_URL KIM_SB_SERVICE_KEY
fi
python3 - <<'PY'
import json, os, secrets, sys, urllib.request
from pathlib import Path
root = Path(os.environ['KIM_SETUP_CONFIG_DIR'])
home = Path(os.environ['KIM_SETUP_HOME'])
def load(path):
    return {k: json.loads(v) for line in path.read_text().splitlines() if line and not line.startswith('#') for k,v in [line.split('=',1)]} if path.exists() else {}
def save(path, data):
    temp = path.with_suffix('.tmp')
    temp.write_text(''.join(k+'='+json.dumps(v)+'\n' for k,v in data.items()))
    temp.chmod(0o600); temp.replace(path)
tpath, rpath = root/'tardis.env', root/'rallypoint.env'
t, r = load(tpath), load(rpath)
if not r:
    r = {'SUPABASE_URL': os.environ.get('KIM_SB_URL',''), 'SUPABASE_SERVICE_KEY': os.environ.get('KIM_SB_SERVICE_KEY','')}
if not r.get('SUPABASE_URL','').startswith('https://') or not r.get('SUPABASE_SERVICE_KEY'):
    sys.exit('Missing content database credentials. Set them in the private rallypoint.env file and rerun.')
gateway = t.get('RIVENDELL_CONTENT_TOKEN') or r.get('TARDIS_CONTENT_TOKEN') or secrets.token_hex(32)
engine = r.get('RALLYPOINT_ENGINE_TOKEN') or t.get('RALLYPOINT_ENGINE_TOKEN') or secrets.token_hex(32)
t.update({'HOST':'127.0.0.1','PORT':'8091','ELROND_WORKSPACE_PATH':str(home/'ASSISTANT-HUB'), 'RIVENDELL_WORKER_ENABLED':'false', 'RIVENDELL_WORKER_RUNNER':'dry-run', 'RIVENDELL_PREWARM_AGENTS':'false', 'RIVENDELL_CONTENT_TOKEN':gateway, 'RALLYPOINT_ENGINE_TOKEN':engine, 'RALLYPOINT_ENGINE_URL':'http://127.0.0.1:8788', 'RIVENDELL_CODEX_BIN':str(home/'.local/share/tardis-runtime/npm/bin/codex')})
r.update({'RALLYPOINT_ENGINE_TOKEN':engine,'TARDIS_CONTENT_TOKEN':gateway,'TARDIS_URL':'http://127.0.0.1:8091','TARDIS_MODEL':r.get('TARDIS_MODEL','claude'),'RALLYPOINT_ENGINE_PORT':'8788','MAX_CONCURRENT_JOBS':'2'})
save(tpath,t); save(rpath,r)
try:
    for table, columns in [('content_drafts','id,edit_revision,approved_revision'),('content_publications','id'),('generation_jobs','id')]:
        req=urllib.request.Request(r['SUPABASE_URL'].rstrip('/')+'/rest/v1/'+table+'?select='+columns+'&limit=0', headers={'apikey':r['SUPABASE_SERVICE_KEY'],'Authorization':'Bearer '+r['SUPABASE_SERVICE_KEY']})
        with urllib.request.urlopen(req,timeout=15) as response: response.read()
except Exception:
    sys.exit('Content storage is not ready. Check credentials and apply RallyPoint migrations through 0010_headless_content.sql, then rerun. No services started.')
PY
unset KIM_SB_URL KIM_SB_SERVICE_KEY

# Updating is attended: refuse running services rather than race active work.
assert_services_stopped

git -C "$tardis_dir" switch --detach "$tardis_target"
git -C "$rally_dir" switch --detach "$rally_target"

say 'Installing dependencies and building both shared applications.'
(cd "$tardis_dir"; npm ci; npm run typecheck; VITE_TARDIS_STYLE=lavender VITE_TARDIS_THEME=light npm run build)
(cd "$rally_dir"; pnpm install --frozen-lockfile; pnpm --filter @rallypoint/engine typecheck)
(cd "$tardis_dir"; RALLYPOINT_REPO_PATH="$rally_dir" node --import tsx server/scripts/install-content-team.ts)
mkdir -p "$HOME/ASSISTANT-HUB" "$HOME/.config/systemd/user" "$HOME/.local/share/applications"
for service in tardis rallypoint-engine; do
  if [[ "$service" == tardis ]]; then app_dir="$tardis_dir"; command_line='exec npm start'; env_name=tardis
  else app_dir="$rally_dir"; command_line='exec pnpm start:engine'; env_name=rallypoint; fi
  cat > "$HOME/.local/bin/$service-run" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="$runtime_dir/npm/bin:$node_dir/bin:\$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
cd "$app_dir"
$command_line
EOF
  chmod 700 "$HOME/.local/bin/$service-run"
  cat > "$HOME/.config/systemd/user/$service.service" <<EOF
[Unit]
Description=$service local office service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.config/tardis/$env_name.env
ExecStart=%h/.local/bin/$service-run
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=default.target
EOF
done
cat > "$HOME/.local/bin/tardis-cli" <<EOF
#!/usr/bin/env bash
export PATH="$runtime_dir/npm/bin:$node_dir/bin:\$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
exec "\$@"
EOF
chmod 700 "$HOME/.local/bin/tardis-cli"
support_file="${KIM_SUPPORT_CONFIG:-${bundle_dir:+$bundle_dir/support.json}}"
if [[ -f "${support_file:-}" || -f /etc/tardis-support/installed ]]; then
  bash "$tardis_dir/scripts/setup-kim-support.sh" "${support_file:-}"
fi
cat > "$HOME/.local/bin/tardis-connect" <<'EOF'
#!/usr/bin/env bash
set -u
while true; do
  printf '\nFinish TARDIS Setup\n1. Sign into Claude Code\n2. Sign into Codex\n3. Connect Grok\n4. Connect brand publishing accounts\n5. Sign into GitHub for future updates\n6. Open TARDIS\n7. Tailscale and remote support\n0. Done\n'
  read -r -p 'Choose a step: ' step || exit
  case "$step" in
    1) "$HOME/.local/bin/tardis-cli" claude auth login ;;
    2) "$HOME/.local/bin/tardis-cli" codex login ;;
    3) xdg-open http://127.0.0.1:8091/xai-oauth ;;
    4) xdg-open http://127.0.0.1:8091/content ;;
    5) gh auth login --hostname github.com --git-protocol https --web && gh auth setup-git --hostname github.com ;;
    6) xdg-open http://127.0.0.1:8091 ;;
    7) if [[ -x "$HOME/.local/bin/tardis-support" ]]; then "$HOME/.local/bin/tardis-support"; else echo 'Use a USB kit prepared with a support public key and Tailscale IP.'; fi ;;
    0) exit ;;
  esac
done
EOF
chmod 700 "$HOME/.local/bin/tardis-connect"
cat > "$HOME/.local/share/applications/tardis-setup.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Finish TARDIS Setup
Comment=Connect subscriptions and brand accounts
Exec=sh -c "$HOME/.local/bin/tardis-connect"
Icon=preferences-system
Terminal=true
Categories=Office;
EOF
cat > "$HOME/.local/share/applications/tardis.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=TARDIS
Comment=Your agents and content desk
Exec=xdg-open http://127.0.0.1:8091
Icon=applications-office
Terminal=false
Categories=Office;
EOF
mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.local/bin/tardis-open" <<'EOF'
#!/usr/bin/env bash
for attempt in {1..60}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8091/api/health >/dev/null; then
    exec xdg-open http://127.0.0.1:8091
  fi
  sleep 2
done
printf 'TARDIS is still starting. Open it from Applications in a moment.\n' >&2
EOF
chmod 700 "$HOME/.local/bin/tardis-open"
if [[ ! -e "$HOME/.config/autostart/tardis.desktop" ]]; then
cat > "$HOME/.config/autostart/tardis.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=TARDIS
Exec=sh -c "$HOME/.local/bin/tardis-open"
Icon=applications-office
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
fi
systemctl --user daemon-reload
systemctl --user enable --now tardis.service rallypoint-engine.service
sudo loginctl enable-linger "$USER"
for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:8091/api/health >/dev/null; then break; fi
  sleep 2
done
curl --fail --silent http://127.0.0.1:8091/api/health >/dev/null || die 'TARDIS did not become healthy. Run journalctl --user -u tardis -n 50.'
python3 - <<'PY'
import json, os, sys, time, urllib.request
from pathlib import Path
path=Path(os.environ['KIM_SETUP_CONFIG_DIR'])/'rallypoint.env'
values={k:json.loads(v) for line in path.read_text().splitlines() if line and not line.startswith('#') for k,v in [line.split('=',1)]}
for attempt in range(15):
    try:
        req=urllib.request.Request('http://127.0.0.1:8788/api/content/status',headers={'Authorization':'Bearer '+values['RALLYPOINT_ENGINE_TOKEN']})
        with urllib.request.urlopen(req,timeout=10) as response: status=json.load(response)
        if status.get('storage') != 'connected': sys.exit('Content engine storage needs setup. Check its database and migrations.')
        break
    except OSError:
        if attempt==14: sys.exit('Content engine did not become healthy. Run journalctl --user -u rallypoint-engine -n 50.')
        time.sleep(2)
PY
say 'TARDIS is running at http://127.0.0.1:8091. Search Applications for TARDIS.'
say "Finish subscription sign-in as Kim: $HOME/.local/bin/tardis-cli claude auth login, then $HOME/.local/bin/tardis-cli codex login. For Grok, open http://127.0.0.1:8091/xai-oauth."
say 'Open Content → Connections for each brand and connect publishing destinations. Test a draft and approval before publishing.'
say 'If GNOME was just installed, reboot when ready and choose the GNOME session. Setup does not reboot the machine.'
