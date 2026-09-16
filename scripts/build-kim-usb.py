#!/usr/bin/env python3
"""Build a private, portable USB setup folder from committed, clean repositories."""
import argparse
import hashlib
import base64
import ipaddress
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--rallypoint', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True, help='A new folder; existing folders are never overwritten')
parser.add_argument('--workspace-config', type=Path, help='Private JSON with only SUPABASE_URL and SUPABASE_SERVICE_KEY')
parser.add_argument('--support-public-key', type=Path, help='Support operator OpenSSH .pub file; never a private key')
parser.add_argument('--support-peer-ip', help='Support computer Tailscale IPv4 address')
args = parser.parse_args()
tardis = Path(__file__).resolve().parents[1]
rallypoint = args.rallypoint.resolve()
output = args.output.resolve()

def git(repo, *command):
    return subprocess.check_output(['git', '-C', str(repo), *command], text=True).strip()

for repo in (tardis, rallypoint):
    if git(repo, 'status', '--porcelain'):
        raise SystemExit(f'Commit and review the changes in {repo.name} before building the kit.')
    if git(repo, 'rev-parse', 'HEAD') != git(repo, 'rev-parse', 'main'):
        raise SystemExit(f'{repo.name} must be checked out at the intended main release.')
if output.exists():
    raise SystemExit('Choose a new output folder. The builder never overwrites an existing USB kit.')
for repo in (tardis, rallypoint):
    if output == repo or repo in output.parents and output.relative_to(repo).parts[0] != 'tmp':
        raise SystemExit('Use a private output folder outside tracked source, or inside tmp/.')
workspace = None
support = None
if bool(args.support_public_key) != bool(args.support_peer_ip):
    raise SystemExit('Supply both --support-public-key and --support-peer-ip.')
if args.support_public_key:
    key = args.support_public_key.read_text(encoding='utf-8-sig').strip().split()
    if len(key) < 2 or key[0] not in ('ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256'):
        raise SystemExit('Supply only an OpenSSH public key, not a private key.')
    base64.b64decode(key[1], validate=True)
    address = ipaddress.ip_address(args.support_peer_ip)
    if address.version != 4 or address not in ipaddress.ip_network('100.64.0.0/10'):
        raise SystemExit('Support peer IP must be a Tailscale IPv4 address.')
    subprocess.run(['ssh-keygen', '-lf', str(args.support_public_key)], check=True, stdout=subprocess.DEVNULL)
    support = {'publicKey': ' '.join(key[:2]), 'peerIp': str(address)}
if args.workspace_config:
    source = json.loads(args.workspace_config.read_text(encoding='utf-8-sig'))
    workspace = {key: source[key] for key in ('SUPABASE_URL', 'SUPABASE_SERVICE_KEY')}
    if not all(isinstance(v, str) and v for v in workspace.values()) or not workspace['SUPABASE_URL'].startswith('https://'):
        raise SystemExit('Workspace configuration needs an HTTPS URL and a service-role key.')
output.mkdir(parents=True, mode=0o700)
commits = {}
for name, repo in (('tardis', tardis), ('rallypoint', rallypoint)):
    commits[name] = git(repo, 'rev-parse', 'main')
    subprocess.run(['git', '-C', str(repo), 'bundle', 'create', str(output / f'{name}.bundle'), 'main'], check=True)
for source, destination in ((tardis/'scripts/setup-kim.sh', 'setup-kim.sh'), (tardis/'scripts/usb-install.sh', 'INSTALL.sh')):
    (output/destination).write_text(source.read_text(encoding='utf-8-sig'), encoding='utf-8', newline='\n')
    (output/destination).chmod(0o700)
if workspace:
    path = output/'workspace.json'
    path.write_text(json.dumps(workspace), encoding='utf-8'); path.chmod(0o600)
if support:
    (output/'support.json').write_text(json.dumps(support), encoding='utf-8')
(output/'release.json').write_text(json.dumps(commits, indent=2)+'\n', encoding='utf-8')
names = ['tardis.bundle', 'rallypoint.bundle', 'setup-kim.sh', 'INSTALL.sh', 'release.json'] + (['workspace.json'] if workspace else []) + (['support.json'] if support else [])
with (output/'SHA256SUMS').open('w', encoding='utf-8', newline='\n') as sums:
    for name in names:
        with (output/name).open('rb') as data: digest=hashlib.file_digest(data, 'sha256').hexdigest()
        sums.write(f'{digest}  {name}\n')
(output/'START-HERE.txt').write_text('''KIM'S TARDIS — USB SETUP

1. Boot the AMD computer's installed Linux and finish its normal first-boot account setup.
2. Connect to the internet. Plug in this USB and open this folder.
3. Right-click the folder > Open in Terminal, then run:

   bash INSTALL.sh

Enter the Linux password once when sudo asks. Setup installs GNOME and Firefox,
FFmpeg, pinned app tools, both apps and the six-person team. The included source
does not need a GitHub login during installation. Downloads still need internet.
'''+('The shared content workspace is preconfigured in this private kit.\n' if workspace else 'Setup will ask for the content database URL and service-role key.\n')+'''
4. When setup finishes, reboot if GNOME was newly installed.
5. Open TARDIS from Applications. Use Finish TARDIS Setup for subscription sign-ins,
   then Content > Connections for the brands' Ayrshare social account authorization.
'''+('''6. Open TARDIS Remote Support. Sign into YOUR separate Tailscale account, share
   only this computer with your support person, then enable support. It starts paused.
   SSH enables administrator repairs using the supplied public key, only from the
   support computer's Tailscale IP. RustDesk asks you to accept screen-help sessions.
   Use Pause support to stop access. Revoke the device share in Tailscale to remove it.
   Your support person connects with: ssh -p 2222 tardis-support@YOUR_TAILSCALE_IP
   RustDesk uses YOUR_TAILSCALE_IP:21118 directly. No public RustDesk relay is used.
''' if support else '')+'''

This USB does not erase disks, replace the vendor OS, or change AMD drivers.
It is an installer launched from Linux, not a bootable operating-system image.
If interrupted, rerun the same command. Existing running apps must be stopped first.
The setup log is kept privately under ~/.local/share/tardis-setup/.

The two brands share content; chats, agents, appearance and subscriptions remain local.
GitHub sign-in is needed later for repository updates. Ayrshare plan/API credentials
must be configured once by an administrator before brand owners can connect accounts.
X additionally needs X developer credentials. Blogs/email are separate connections.
'''+('\nPRIVATE KIT: workspace.json grants access to the shared content database. Keep this USB with the installation team; do not publish or upload the kit.\n' if workspace else ''), encoding='utf-8')
print(f'USB kit ready: {output}')
print('Copy this folder to the USB. No disk was formatted.')
