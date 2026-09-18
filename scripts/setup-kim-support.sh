#!/usr/bin/env bash
# Called as Kim after the main installer has checked out its reviewed source.
set -euo pipefail
umask 077
[[ $EUID -ne 0 ]] || { echo 'Run as the desktop user, without sudo.'; exit 1; }
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
support_file="${1:-}"
. /etc/os-release
# Vendor release names are not necessarily upstream package-suite names.
# AMD's Rex image uses Debian 13, so Tailscale must use debian/trixie.
tailscale_distro="${ID:-}"
tailscale_suite="${VERSION_CODENAME:-}"
case "$tailscale_distro" in
  ubuntu|debian) ;;
  amd-ryzen-ai-developer-platform)
    if [[ " ${ID_LIKE:-} " == *' debian '* && "${VERSION_ID:-}" == 1 && -r /etc/debian_version ]]; then
      case "$(cat /etc/debian_version)" in
        13|13.*) tailscale_distro=debian; tailscale_suite=trixie ;;
        *) echo 'Unrecognized AMD Debian base; remote support needs an updated installer.'; exit 1 ;;
      esac
    else
      echo 'Unrecognized AMD image; remote support needs an updated installer.'; exit 1
    fi
    ;;
  *) echo 'Remote support requires Ubuntu, Debian, or the supported AMD vendor image.'; exit 1 ;;
esac
[[ "$tailscale_suite" =~ ^[a-z]+$ ]] || { echo 'Cannot identify the upstream package suite.'; exit 1; }

# Never take over a pre-existing remote desktop installation or support identity.
if [[ ! -f /etc/tardis-support/installed ]]; then
  if dpkg-query -W -f='${Status}' rustdesk 2>/dev/null | grep -q 'install ok installed' || id tardis-support >/dev/null 2>&1; then
    echo 'An existing RustDesk installation or tardis-support account needs manual review before setup.'; exit 1
  fi
fi
if [[ -f /etc/tardis-support/installed ]]; then
  sudo /usr/local/sbin/tardis-support pause
fi
if ! dpkg-query -W -f='${Status}' openssh-server 2>/dev/null | grep -q 'install ok installed'; then
  # Install sshd without opening the distribution default port on the LAN.
  sudo systemctl mask ssh.service ssh.socket
fi
# The vendor postinst starts its service. A condition prevents that without
# breaking its postinst (which does not tolerate a masked service).
sudo mkdir -p /etc/systemd/system/rustdesk.service.d
printf '[Unit]\nConditionPathExists=/etc/tardis-support/enabled\n' | sudo tee /etc/systemd/system/rustdesk.service.d/tardis-support.conf >/dev/null
sudo systemctl daemon-reload
sudo apt-get install -y --no-install-recommends openssh-server nftables
if ! command -v tailscale >/dev/null; then
  download="$(mktemp -d)"
  curl -fsSL "https://pkgs.tailscale.com/stable/$tailscale_distro/$tailscale_suite.noarmor.gpg" -o "$download/tailscale.gpg"
  curl -fsSL "https://pkgs.tailscale.com/stable/$tailscale_distro/$tailscale_suite.tailscale-keyring.list" -o "$download/tailscale.list"
  sudo install -m 644 "$download/tailscale.gpg" /usr/share/keyrings/tailscale-archive-keyring.gpg
  sudo install -m 644 "$download/tailscale.list" /etc/apt/sources.list.d/tailscale.list
  sudo apt-get update
  sudo apt-get install -y tailscale
fi
if ! dpkg-query -W -f='${Version}' rustdesk 2>/dev/null | grep -qx '1.4.9'; then
  case "$(uname -m)" in
    x86_64) arch=x86_64; digest=7244ba47c40e804172044bfbe659467c54ce46554c98e78c8c0406f1d612fda3 ;;
    aarch64|arm64) arch=aarch64; digest=ce62c996f14d33f3bbe3a330e953644a44bace7f05885a7953f7395d69fb49c0 ;;
    *) echo 'Unsupported RustDesk architecture'; exit 1 ;;
  esac
  download="$(mktemp -d)"; chmod 755 "$download"
  curl -fL "https://github.com/rustdesk/rustdesk/releases/download/1.4.9/rustdesk-1.4.9-$arch.deb" -o "$download/rustdesk.deb"
  printf '%s  %s\n' "$digest" "$download/rustdesk.deb" | sha256sum -c -
  chmod 644 "$download/rustdesk.deb"
  sudo apt-get install -y "$download/rustdesk.deb"
fi
sudo install -m 755 "$source_dir/tardis-support.py" /usr/local/sbin/tardis-support
sudo /usr/local/sbin/tardis-support install "$USER" "$support_file"
sudo systemctl enable --now tailscaled
install -m 700 "$source_dir/tardis-support-menu.sh" "$HOME/.local/bin/tardis-support"
cat > "$HOME/.local/share/applications/tardis-support.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=TARDIS Remote Support
Comment=Connect your own Tailscale network, allow or pause support
Exec=sh -c "$HOME/.local/bin/tardis-support"
Icon=preferences-desktop-remote-desktop
Terminal=true
Categories=System;
EOF
echo 'Remote support installed and paused. Open TARDIS Remote Support to finish your own Tailscale sign-in.'
