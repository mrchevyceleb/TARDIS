#!/usr/bin/env python3
"""Outside the Node event loop: recover an unresponsive, checked TARDIS.

Installed as its own systemd user service. No agent turn, model or secret.
Intentional stops and deployments are left alone. Recovery never clears state.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
import urllib.error


def command(*args):
    return subprocess.check_output(args, text=True, timeout=4).strip()


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value))
    temporary.chmod(0o600)
    os.replace(temporary, path)


def load(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def get_json(url, data=None, timeout=3):
    request = urllib.request.Request(url, data=None if data is None else json.dumps(data).encode(),
                                     headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def checked_release(config):
    repo = config['repo']
    if command('git', '-C', repo, 'rev-parse', 'HEAD') != config['head']:
        return False
    if command('git', '-C', repo, 'status', '--porcelain', '--untracked-files=no'):
        return False
    return all(hashlib.sha256((Path(repo) / name).read_bytes()).hexdigest() == digest
               for name, digest in config['files'].items())


def tick(config, state, now):
    unit = config['unit']
    values = command('systemctl', '--user', 'show', unit, '--property=ActiveState,SubState,MainPID').splitlines()
    info = dict(line.split('=', 1) for line in values if '=' in line)
    pid = info.get('MainPID', '0')
    if info.get('ActiveState') != 'active' or info.get('SubState') != 'running' or pid == '0':
        # Planned stop/start is not an outage. Keep an unsent recovery notice.
        state.pop('first_bad', None)
        state.pop('pid', None)
        return
    if state.get('pid') != pid:
        state['pid'] = pid
        state.pop('first_bad', None)
    try:
        healthy = get_json(config['base'] + '/api/health').get('ok') is True
    except (OSError, ValueError):
        healthy = False
    if healthy:
        state.pop('first_bad', None)
        pending = state.get('notice')
        if pending and now >= pending.get('next_attempt', 0):
            # A timed-out durable handoff may already be queued or visible.
            # Reconcile its unique recovery marker before retrying.
            marker = f"Recovery {pending['id']}."
            queue = load(Path(config['delivery_state_dir']) / 'team-delivery-queue.json')
            rows = queue if isinstance(queue, list) else queue.get('items', [])
            already_queued = any(marker in row.get('text', '') for row in rows)
            recent = get_json(config['base'] + '/api/team/recent?name=Max&limit=50', timeout=20)
            already_visible = any(marker in row.get('text', '') for row in recent.get('messages', []))
            if already_queued or already_visible:
                del state['notice']
                return
            attempts = pending.get('attempts', 0)
            pending['attempts'] = attempts + 1
            pending['next_attempt'] = now + min(60 * 2 ** min(attempts, 4), 600)
            atomic(Path(config['state_file']), state)
            duration = round(now - pending['at'])
            try:
                reply = get_json(config['base'] + '/api/team/message', {
                    'from': 'TARDIS', 'to': 'Max', 'wait': False, 'priority': True,
                    'text': f"TARDIS stopped responding, so its watchdog restarted the same checked build. It is responding again ({duration}s after recovery began). Saved chats and queued messages were kept. {marker}",
                }, timeout=20)
                if reply.get('delivered'):
                    del state['notice']
            except (OSError, ValueError):
                pass  # Keep the persisted notice for a later reconciliation.

        return
    first = state.setdefault('first_bad', now)
    if now - first < config.get('failure_seconds', 60):
        return
    if not checked_release(config):
        # A checkout being changed is a deployment, not permission to run it.
        state['unapproved_source'] = True
        return
    state.pop('unapproved_source', None)
    state['notice'] = {'id': f"{pid}-{int(time.time())}", 'at': now}
    state.pop('first_bad', None)
    # Persist the notice BEFORE restarting. The watcher is outside the unit.
    atomic(Path(config['state_file']), state)
    command('systemctl', '--user', 'restart', '--no-block', unit)
    print(json.dumps({'event': 'TARDIS_WATCHDOG_RECOVERY', 'pid': pid, 'head': config['head']}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    config_path = Path(args.config)
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    while True:
        try:
            config = load(config_path)
            state_path = Path(config['state_file'])
            state = load(state_path)
            if state.get('boot') != boot:
                notice = state.get('notice')
                state = {'boot': boot}
                if notice:
                    notice['at'] = time.monotonic()
                    notice.pop('next_attempt', None)
                    state['notice'] = notice
            tick(config, state, time.monotonic())
            atomic(state_path, state)
        except Exception as error:
            # No response bodies or command output: those can hold secrets.
            print(json.dumps({'event': 'WATCHDOG_RETRY', 'errorType': type(error).__name__}), flush=True)
        time.sleep(10)


if __name__ == '__main__':
    main()
