#!/usr/bin/env python3
"""Root-owned remote support setup. Only its own firewall table/services are managed."""
import base64
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import sys

ROOT = Path('/etc/tardis-support')
ACCOUNT = 'tardis-support'
PORTS = '{ 2222, 21118 }'


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def write(path, text, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp')
    temp.write_text(text)
    temp.chmod(mode)
    temp.replace(path)


def load():
    return json.loads((ROOT / 'config.json').read_text())


def validate_support(data):
    ip = ipaddress.ip_address(data['peerIp'])
    if ip.version != 4 or ip not in ipaddress.ip_network('100.64.0.0/10'):
        raise ValueError('Support computer must have a Tailscale IPv4 address.')
    parts = data['publicKey'].strip().split()
    if len(parts) < 2 or parts[0] not in ('ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256'):
        raise ValueError('Supply an OpenSSH public key, never a private key or authorized_keys options.')
    base64.b64decode(parts[1], validate=True)
    return {'peerIp': str(ip), 'publicKey': ' '.join(parts[:2])}


def firewall(config, enabled):
    # Earlier than Tailscale's iptables accept rules. Drop remains final across chains.
    allow = f'iifname "tailscale0" ip saddr {config["peerIp"]} tcp dport {PORTS} accept\n' if enabled else ''
    script = f'''add table inet tardis_support
flush table inet tardis_support
add chain inet tardis_support inbound {{ type filter hook input priority -10; policy accept; }}
add rule inet tardis_support inbound {allow.strip()}
add rule inet tardis_support inbound tcp dport {PORTS} drop
'''.replace('add rule inet tardis_support inbound \n', '')
    run('/usr/sbin/nft', '-f', '-', input=script)


def tailnet():
    state = json.loads(subprocess.check_output(['/usr/bin/tailscale', 'status', '--json'], text=True))
    if state.get('BackendState') != 'Running':
        raise ValueError('Sign into your own Tailscale account first (menu step 1).')
    return state


def pause(config):
    # Revoke privilege first, and still try every other boundary if a unit is broken.
    errors = []
    steps = [
        lambda: Path('/etc/sudoers.d/tardis-support').unlink(missing_ok=True),
        lambda: (ROOT / 'enabled').unlink(missing_ok=True),
        lambda: firewall(config, False),
        lambda: run('systemctl', 'disable', '--now', 'tardis-support-sshd.service'),
        lambda: run('systemctl', 'disable', '--now', 'rustdesk.service'),
    ]
    for step in steps:
        try:
            step()
        except (OSError, subprocess.CalledProcessError) as error:
            errors.append(str(error))
    if errors:
        raise ValueError('Pause encountered errors; attempted all revocation steps. ' + '; '.join(errors))
    print('Support paused. New SSH and desktop connections are blocked; the managed sessions were stopped.')
    print('To revoke the relationship entirely, also revoke this machine share in Tailscale.')


def install(owner, support_path):
    user = pwd.getpwnam(owner)
    if user.pw_uid == 0 or owner == ACCOUNT:
        raise ValueError('Select the normal desktop user.')
    ROOT.mkdir(mode=0o755, exist_ok=True)
    ROOT.chmod(0o755)  # sshd reads public authorized_keys as the unprivileged login user.
    if (ROOT / 'config.json').exists():
        config = load()
        if config['owner'] != owner:
            raise ValueError('This support installation belongs to another desktop user.')
    else:
        if not support_path:
            raise ValueError('Rebuild the USB with --support-public-key and --support-peer-ip.')
        config = dict(validate_support(json.loads(Path(support_path).read_text())), owner=owner)
        write(ROOT / 'candidate.pub', config['publicKey'] + '\n')
        run('ssh-keygen', '-lf', str(ROOT / 'candidate.pub'), stdout=subprocess.DEVNULL)
        write(ROOT / 'config.json', json.dumps(config))
    if not (ROOT / 'installed').exists():
        try:
            pwd.getpwnam(ACCOUNT)
        except KeyError:
            run('useradd', '--create-home', '--shell', '/bin/bash', ACCOUNT)
        else:
            raise ValueError('Refusing to reuse an existing support account.')
        write(ROOT / 'installed', '1\n')
    write(ROOT / 'authorized_keys', config['publicKey'] + '\n', 0o644)
    key = ROOT / 'ssh_host_ed25519_key'
    if not key.exists():
        run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key))
    write(ROOT / 'sshd_config', f'''Port 2222
ListenAddress 0.0.0.0
HostKey {key}
PidFile /run/tardis-support/sshd.pid
AuthorizedKeysFile {ROOT}/authorized_keys
AllowUsers {ACCOUNT}@{config['peerIp']}
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
UsePAM yes
AllowAgentForwarding no
X11Forwarding no
AllowTcpForwarding local
PermitOpen 127.0.0.1:8091
PermitTunnel no
''')
    Path('/run/sshd').mkdir(mode=0o755, exist_ok=True)
    run('/usr/sbin/sshd', '-t', '-f', str(ROOT / 'sshd_config'))
    write('/etc/systemd/system/tardis-support-firewall.service', '''[Unit]
Description=TARDIS support network boundary
After=nftables.service
PartOf=nftables.service
Before=tardis-support-sshd.service rustdesk.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/tardis-support firewall
ExecReload=/usr/local/sbin/tardis-support firewall
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
''', 0o644)
    # Native nftables commonly starts with "flush ruleset". Append synchronous
    # reapplication to its existing commands; PartOf handles service stop/restart.
    write('/etc/systemd/system/nftables.service.d/tardis-support.conf', '''[Service]
ExecStartPost=/usr/local/sbin/tardis-support firewall
ExecReload=/usr/local/sbin/tardis-support firewall
''', 0o644)
    write('/etc/systemd/system/tardis-support-sshd.service', '''[Unit]
Description=TARDIS key-only support SSH
After=network.target tailscaled.service tardis-support-firewall.service
Requires=tardis-support-firewall.service
PartOf=tardis-support-firewall.service
ConditionPathExists=/etc/tardis-support/enabled
[Service]
RuntimeDirectory=tardis-support
ExecStartPre=/usr/bin/mkdir -p /run/sshd
ExecStart=/usr/sbin/sshd -D -e -f /etc/tardis-support/sshd_config
Restart=on-failure
KillMode=control-group
[Install]
WantedBy=multi-user.target
''', 0o644)
    # Additional cgroup boundary: the RustDesk service cannot reach public relays.
    write('/etc/systemd/system/rustdesk.service.d/tardis-support.conf', f'''[Unit]
After=tardis-support-firewall.service
Requires=tardis-support-firewall.service
PartOf=tardis-support-firewall.service
ConditionPathExists=/etc/tardis-support/enabled
[Service]
IPAddressDeny=any
IPAddressAllow=localhost
IPAddressAllow={config['peerIp']}
''', 0o644)
    options = {'custom-rendezvous-server': '127.0.0.1', 'relay-server': '127.0.0.1',
               'direct-server': 'Y', 'direct-access-port': '21118', 'enable-lan-discovery': 'N',
               'approve-mode': 'click', 'allow-logon-screen-password': 'N',
               'enable-file-transfer': 'N', 'enable-tunnel': 'N', 'enable-terminal': 'N',
               'enable-clipboard': 'N', 'allow-remote-config-modification': 'N',
               'whitelist': config['peerIp']}
    # These settings are part of the managed support installation, not a general RustDesk setup.
    for home in (Path('/root'), Path(user.pw_dir)):
        parent = home / '.config'
        if not parent.exists():
            parent.mkdir(mode=0o700)
            if home != Path('/root'):
                os.chown(parent, user.pw_uid, user.pw_gid)
        directory = home / '.config/rustdesk'
        directory.mkdir(parents=True, exist_ok=True)
        file = directory / 'RustDesk2.toml'
        write(file, '[options]\n' + ''.join(f'{k} = {json.dumps(v)}\n' for k, v in options.items()))
        if home != Path('/root'):
            os.chown(directory, user.pw_uid, user.pw_gid)
            os.chown(file, user.pw_uid, user.pw_gid)
    run('systemctl', 'daemon-reload')
    run('systemctl', 'unmask', 'rustdesk.service')
    run('systemctl', 'enable', '--now', 'tardis-support-firewall.service')
    pause(config)  # Updates never silently turn previously paused support back on.


def enable(config):
    state = tailnet()
    name = state.get('CurrentTailnet', {}).get('Name', 'unknown')
    print(f'Current tailnet: {name}\nOnly support computer {config["peerIp"]} will be allowed.')
    print('The support key grants administrator access for repairs. Desktop sessions require your acceptance.')
    if input('Confirm this is YOUR separate tailnet and you shared only this machine. Type ENABLE: ') != 'ENABLE':
        return
    write('/etc/sudoers.d/tardis-support', f'{ACCOUNT} ALL=(ALL) NOPASSWD: ALL\n', 0o440)
    run('visudo', '-cf', '/etc/sudoers.d/tardis-support', stdout=subprocess.DEVNULL)
    write(ROOT / 'enabled', '1\n')
    try:
        firewall(config, True)
        run('systemctl', 'enable', '--now', 'tardis-support-sshd.service', 'rustdesk.service')
    except Exception:
        pause(config)
        raise
    status(config)


def status(config):
    print('Support: ' + ('enabled' if (ROOT / 'enabled').exists() else 'paused'))
    print('Allowed support computer: ' + config['peerIp'])
    print('SSH key fingerprint:')
    run('ssh-keygen', '-lf', str(ROOT / 'authorized_keys'))
    try:
        state = tailnet()
        address = next(ip for ip in state['Self']['TailscaleIPs'] if ':' not in ip)
        print(f'SSH: ssh -p 2222 {ACCOUNT}@{address}')
        print(f'RustDesk: connect directly to {address}:21118 (accept on this desktop).')
        print(f'TARDIS tunnel: ssh -p 2222 -N -L 18091:127.0.0.1:8091 {ACCOUNT}@{address}')
        print('Then open http://127.0.0.1:18091 on the support computer.')
    except (ValueError, subprocess.CalledProcessError, StopIteration):
        print('Tailscale sign-in is still required.')


def main():
    if os.geteuid() != 0:
        raise ValueError('Run through the Remote Support menu or sudo.')
    os.umask(0o077)
    command = sys.argv[1] if len(sys.argv) > 1 else 'status'
    if command == 'install':
        install(sys.argv[2], sys.argv[3])
        return
    config = load()
    if command == 'firewall':
        firewall(config, (ROOT / 'enabled').exists())
    elif command == 'enable':
        enable(config)
    elif command == 'pause':
        pause(config)
    elif command == 'status':
        status(config)
    else:
        raise ValueError('Use install, enable, pause, status or firewall.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, IndexError, OSError, subprocess.CalledProcessError) as error:
        sys.exit('Remote support setup stopped: ' + str(error))
