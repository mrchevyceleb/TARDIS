#!/usr/bin/env python3
"""Arm only an already checked, exact live source release. Run after its proof."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--approved-head', required=True)
    parser.add_argument('--roundtrip-receipt', required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    def require(condition, message):
        if not condition:
            raise SystemExit(message)
    require(git(repo, 'rev-parse', 'HEAD') == args.approved_head, 'Wrong approved head')
    require(not git(repo, 'status', '--porcelain', '--untracked-files=no'), 'Source is not clean')
    properties = subprocess.check_output(['systemctl', '--user', 'show', 'rivendell.service', '--property=WorkingDirectory,ActiveState,SubState,MainPID,ActiveEnterTimestampMonotonic'], text=True)
    info = dict(line.split('=', 1) for line in properties.splitlines() if '=' in line)
    require(Path(info.get('WorkingDirectory', '/')).resolve() in (repo, repo / 'server'), 'This is not the live service source')
    require(info.get('ActiveState') == 'active' and info.get('SubState') == 'running', 'Live service is not running')
    with urllib.request.urlopen('http://127.0.0.1:8091/api/health', timeout=3) as response:
        require(json.load(response).get('ok') is True, 'Live health is not green')
    entered = int(info['ActiveEnterTimestampMonotonic']) / 1_000_000
    checkout = Path(git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'logs/HEAD')).stat().st_mtime
    require(time.time() - time.monotonic() + entered >= checkout, 'Service predates this source checkout')
    receipt = json.loads(Path(args.roundtrip_receipt).read_text())
    require(receipt.get('head') == args.approved_head and receipt.get('ok') is True and receipt.get('serviceMainPid') == info['MainPID'], 'Missing exact live round-trip proof')
    require(receipt.get('reply', {}).get('ok') is True and receipt.get('reply', {}).get('tools', 0) > 0, 'No real tool reply')
    require(entered <= receipt.get('checkedMonotonic', 0) <= time.monotonic() and time.monotonic() - receipt.get('checkedMonotonic', 0) < 180, 'Round-trip proof is stale')
    target = Path.home() / '.local/lib/tardis-watchdog'
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    shutil.copy2(Path(__file__).with_name('service-watchdog.py'), target / 'watchdog.py')
    files = git(repo, 'ls-files', 'server/src', 'server/scripts').splitlines()
    config = {
        'repo': str(repo), 'head': args.approved_head,
        'files': {name: hashlib.sha256((repo / name).read_bytes()).hexdigest() for name in files if (repo / name).is_file()},
        'unit': 'rivendell.service', 'base': 'http://127.0.0.1:8091',
        'state_file': str(Path.home() / '.rivendell/service-watchdog.json'),
        'failure_seconds': 60, 'allow_checked_handover': True, 'delivery_state_dir': str(Path.home() / '.rivendell'),
    }
    temporary = target / 'config.tmp'
    temporary.write_text(json.dumps(config))
    temporary.chmod(0o600)
    os.replace(temporary, target / 'config.json')
    units = Path.home() / '.config/systemd/user'
    units.mkdir(parents=True, exist_ok=True)
    (units / 'tardis-watchdog.service').write_text(f'''[Unit]
Description=TARDIS independent liveness recovery

[Service]
Type=simple
ExecStart=/usr/bin/python3 "{target / 'watchdog.py'}" --config "{target / 'config.json'}"
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
''')
    drop = units / 'rivendell.service.d'
    drop.mkdir(exist_ok=True)
    # A frozen event loop cannot handle SIGTERM. Bound systemd's stop grace
    # so a 60s detection plus stop/start remains inside about two minutes.
    (drop / 'watchdog-stop.conf').write_text('[Service]\nTimeoutStopSec=15s\n')
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', '--user', 'enable', '--now', 'tardis-watchdog.service'], check=True)
    subprocess.run(['systemctl', '--user', 'restart', 'tardis-watchdog.service'], check=True)
    print(json.dumps({'armed': True, 'head': args.approved_head, 'failureSeconds': 60, 'stopGraceSeconds': 15}))


if __name__ == '__main__':
    main()
