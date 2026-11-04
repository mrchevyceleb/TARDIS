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
import urllib.parse
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


def page_matt(message):
    """Outside TARDIS: its own message API is down when this matters most."""
    token, user = os.environ.get('PUSHOVER_API_KEY'), os.environ.get('PUSHOVER_USER_KEY')
    if not token or not user:
        print(json.dumps({'event': 'WATCHDOG_PAGE_SKIPPED', 'reason': 'no Pushover keys'}), flush=True)
        return False
    data = urllib.parse.urlencode({'token': token, 'user': user, 'title': 'TARDIS down',
                                   'priority': 1, 'message': message}).encode()
    try:
        with urllib.request.urlopen('https://api.pushover.net/1/messages.json', data=data, timeout=20) as response:
            return response.status == 200
    except (OSError, ValueError) as error:
        print(json.dumps({'event': 'WATCHDOG_PAGE_FAILED', 'errorType': type(error).__name__}), flush=True)
        return False


def outage_alert(state, now, down):
    """Page once when TARDIS stays down for minutes, whatever the cause.

    down is True (failing), False (healthy) or None (stopped on purpose,
    which neither pages nor counts as recovered)."""
    if down is None:
        state.pop('down_since', None)
        return
    if down:
        since = state.setdefault('down_since', now)
        if not state.get('paged') and now - since >= 300 and now >= state.get('page_retry', 0):
            if page_matt(f'TARDIS has not been responding for {round((now - since) / 60)} minutes. Rally agents and Samwise are offline.'):
                state['paged'] = True
                state.pop('page_retry', None)
            else:
                state['page_retry'] = now + 300
        return
    state.pop('down_since', None)
    if state.get('paged') and now >= state.get('page_retry', 0):
        if page_matt('TARDIS is responding again.'):
            state.pop('paged', None)
            state.pop('page_retry', None)
        else:
            state['page_retry'] = now + 300


def checked_release(config):
    repo = config['repo']
    if command('git', '-C', repo, 'rev-parse', 'HEAD') != config['head']:
        return False
    if command('git', '-C', repo, 'status', '--porcelain', '--untracked-files=no'):
        return False
    return all(hashlib.sha256((Path(repo) / name).read_bytes()).hexdigest() == digest
               for name, digest in config['files'].items())


def adopt_checked_release(config, info, config_path):
    """A healthy new process can inherit only the independent exact-head gate."""
    if not config_path or not config.get('allow_checked_handover'):
        return False
    receipt = load(Path(config['delivery_state_dir']) / 'restart-check-approved.json')
    repo = config['repo']
    current = command('git', '-C', repo, 'rev-parse', 'HEAD')
    if receipt.get('schema') != 1 or receipt.get('message') is not True or receipt.get('head') != current:
        return False
    entered = int(info.get('ActiveEnterTimestampMonotonic', '0')) / 1_000_000
    entered_wall = time.time() - time.monotonic() + entered
    checkout = Path(command('git', '-C', repo, 'rev-parse', '--path-format=absolute', '--git-path', 'logs/HEAD')).stat().st_mtime
    if not entered or not 0 < receipt.get('at', 0) / 1000 <= entered_wall or checkout > entered_wall:
        return False
    files = receipt.get('files')
    names = command('git', '-C', repo, 'ls-files', 'server/src', 'server/scripts').splitlines()
    expected = {name for name in names if (Path(repo) / name).is_file()}
    if not isinstance(files, dict) or set(files) != expected:
        return False
    # Restoring a dirty working tree after start does not prove which code the
    # running process loaded, even when HEAD itself has not moved.
    if any((Path(repo) / name).stat().st_mtime > entered_wall for name in expected):
        return False
    candidate = {**config, 'head': current, 'files': files}
    if not checked_release(candidate):
        return False
    atomic(config_path, candidate)
    config.update(candidate)
    print(json.dumps({'event': 'WATCHDOG_CHECKED_RELEASE_ADOPTED', 'head': current}), flush=True)
    return True


def block_unapproved(config, state, now, pid):
    state['unapproved_source'] = True
    if state.get('unapproved_notice_pid') != pid and (not state.get('notice') or state['notice'].get('kind') == 'approval'):
        state['notice'] = {'id': f'approval-{pid}', 'at': now, 'kind': 'approval'}
        state['unapproved_notice_pid'] = pid


def tick(config, state, now, config_path=None):
    unit = config['unit']
    values = command('systemctl', '--user', 'show', unit, '--property=ActiveState,SubState,MainPID,ActiveEnterTimestampMonotonic').splitlines()
    info = dict(line.split('=', 1) for line in values if '=' in line)
    pid = info.get('MainPID', '0')
    if info.get('ActiveState') != 'active' or info.get('SubState') != 'running' or pid == '0':
        # Planned stop/start is not an outage. Keep an unsent recovery notice.
        # A unit that keeps failing to start (activating, auto-restart) is.
        state.pop('first_bad', None)
        state.pop('pid', None)
        outage_alert(state, now, None if info.get('ActiveState') in ('inactive', 'deactivating') else True)
        return
    new_process = state.get('pid') != pid
    if new_process:
        state['pid'] = pid
        state.pop('first_bad', None)
    try:
        healthy = get_json(config['base'] + '/api/health').get('ok') is True
    except (OSError, ValueError):
        healthy = False
    outage_alert(state, now, not healthy)
    if healthy:
        state.pop('first_bad', None)
        if new_process:
            try:
                approved = checked_release(config) or adopt_checked_release(config, info, config_path)
            except (OSError, ValueError, subprocess.SubprocessError):
                # A git call that is slow while the new process starts is not
                # a verdict on the build: check this process again next tick.
                state.pop('pid', None)
                return
            if approved:
                state.pop('unapproved_source', None)
                state.pop('unapproved_notice_pid', None)
                if state.get('notice', {}).get('kind') == 'approval':
                    del state['notice']
            else:
                block_unapproved(config, state, now, pid)
        elif state.get('unapproved_source'):
            # A blocked running process must be restarted after approval; a
            # late file restore never certifies the process already in memory.
            block_unapproved(config, state, now, pid)
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
            message = ("TARDIS is responding, but its new source has no matching passed restart check. Automatic recovery is paused until that exact build is checked; saved chats and queued messages are retained."
                       if pending.get('kind') == 'approval' else
                       f"TARDIS stopped responding, so its watchdog restarted the same checked build. It is responding again ({duration}s after recovery began). Saved chats and queued messages were kept.")
            try:
                reply = get_json(config['base'] + '/api/team/message', {
                    'from': 'TARDIS', 'to': 'Max', 'wait': False, 'priority': True,
                    'text': f'{message} {marker}',
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
        block_unapproved(config, state, now, pid)
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
            tick(config, state, time.monotonic(), config_path)
            atomic(state_path, state)
        except Exception as error:
            # No response bodies or command output: those can hold secrets.
            print(json.dumps({'event': 'WATCHDOG_RETRY', 'errorType': type(error).__name__}), flush=True)
        time.sleep(10)


if __name__ == '__main__':
    main()
