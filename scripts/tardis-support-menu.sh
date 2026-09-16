#!/usr/bin/env bash
set -u
while true; do
  printf '\nTARDIS Remote Support\n1. Sign into YOUR Tailscale account\n2. Share this machine with your support person\n3. Enable support\n4. Open RustDesk for screen help\n5. Pause support\n6. Connection details\n0. Done\n'
  read -r -p 'Choose a step: ' step || exit
  case "$step" in
    1)
      echo "Use your own account and your own tailnet. Do not join your colleague's network."
      sudo tailscale up --accept-routes=false --ssh=false
      ;;
    2)
      printf '\nIn Machines, select THIS computer > Share > Copy invite link.\nSend a single-use link privately to your support person, who accepts from their own account.\nDo not invite them as a tailnet member, share an exit node, or share their devices back.\n'
      xdg-open https://login.tailscale.com/admin/machines
      ;;
    3) sudo /usr/local/sbin/tardis-support enable ;;
    4)
      echo 'Accept the incoming session only when you expect help. GNOME may also ask which screen to share.'
      rustdesk >/dev/null 2>&1 &
      ;;
    5) sudo /usr/local/sbin/tardis-support pause ;;
    6) sudo /usr/local/sbin/tardis-support status ;;
    0) exit ;;
  esac
done
