#!/usr/bin/env python3
"""Root-level guardian for TARDIS: recovery from outside the agents' reach.

Agents run as the same user as TARDIS and its user watchdog, so one bad
command can take all of them down together (Nov 4 2026: a QA script's
`kill -STOP` became kill(-1) and froze every user process, watchdog
included, for an hour). This runs as a system service under root, which a
user-level signal cannot reach. Each tick it:

  1. Thaws a mass freeze: when the user's systemd manager, TARDIS or its
     watchdog is stopped, every stopped process of that user is continued.
  2. Brings TARDIS back when it has not answered /api/health for
     DOWN_SECONDS: restarts the unit, and if it cannot boot on the current
     checkout, checks out the last build that ran healthy and restarts that.
  3. Pages Matt (Pushover) on every recovery and when it cannot recover.

It never clears state, never touches chats, and leaves a deliberate stop
alone for STOP_GRACE_SECONDS so a hands-on deploy is not fought.
"""
import json
import os
import pwd
import signal
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path

USER = 'mrchevyceleb'
UNIT = 'rivendell.service'
WATCHDOG_UNIT = 'tardis-watchdog.service'
REPO = f'/home/{USER}/samwise/Personal-Apps/Rivendell'
HEALTH = 'http://127.0.0.1:8091/api/health'
PUSHOVER_ENV = f'/home/{USER}/.config/tardis-watchdog/pushover.env'
STATE = Path('/var/lib/tardis-guardian/state.json')

TICK = 15
FREEZE_TICKS = 2           # critical process stopped on 2 ticks in a row
DOWN_SECONDS = 240         # unhealthy this long before a restart
ROLLBACK_SECONDS = 240     # still down this long after a restart, roll back
GOOD_SECONDS = 600         # healthy this long marks the head as last good
STOP_GRACE_SECONDS = 900   # a deliberate stop is left alone this long

pw = pwd.getpwnam(USER)
UID = pw.pw_uid


def log(event, **fields):
    print(json.dumps({'event': event, **fields}), flush=True)


def load_state():
    try:
        return json.loads(STATE.read_text())
    except (OSError, ValueError):
        return {}


def save_state(state):
    STATE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = STATE.with_suffix('.tmp')
    tmp.write_text(json.dumps(state))
    os.replace(tmp, STATE)


def as_user(*args, timeout=30):
    env = {'HOME': pw.pw_dir, 'USER': USER, 'PATH': '/usr/local/bin:/usr/bin:/bin',
           'XDG_RUNTIME_DIR': f'/run/user/{UID}',
           'DBUS_SESSION_BUS_ADDRESS': f'unix:path=/run/user/{UID}/bus'}
    return subprocess.run(['/usr/sbin/runuser', '-u', USER, '--', *args], env=env, capture_output=True,
                          text=True, timeout=timeout)


def user_systemctl(*args):
    return as_user('systemctl', '--user', *args, timeout=20)


def unit_info(unit):
    out = user_systemctl('show', unit, '--property=ActiveState,SubState,MainPID').stdout
    return dict(line.split('=', 1) for line in out.splitlines() if '=' in line)


def page(message, priority=1):
    keys = {}
    try:
        for line in Path(PUSHOVER_ENV).read_text().splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                k, v = line.split('=', 1)
                keys[k.strip().removeprefix('export ').strip()] = v.strip().strip('"\'')
    except OSError:
        pass
    token, user = keys.get('PUSHOVER_API_KEY'), keys.get('PUSHOVER_USER_KEY')
    if not token or not user:
        log('GUARDIAN_PAGE_SKIPPED', reason='no Pushover keys')
        return
    data = urllib.parse.urlencode({'token': token, 'user': user, 'title': 'TARDIS guardian',
                                   'priority': priority, 'message': message}).encode()
    try:
        urllib.request.urlopen('https://api.pushover.net/1/messages.json', data=data, timeout=20).close()
    except OSError as error:
        log('GUARDIAN_PAGE_FAILED', errorType=type(error).__name__)


def healthy():
    try:
        with urllib.request.urlopen(HEALTH, timeout=5) as response:
            return json.load(response).get('ok') is True
    except (OSError, ValueError):
        return False


def user_processes():
    """(pid, state, comm) for every process owned by USER."""
    rows = []
    for entry in os.scandir('/proc'):
        if not entry.name.isdigit():
            continue
        try:
            if entry.stat().st_uid != UID:
                continue
            stat = Path(f'/proc/{entry.name}/stat').read_text()
        except OSError:
            continue
        # comm is in parentheses and may contain spaces; state follows it.
        comm = stat[stat.index('(') + 1:stat.rindex(')')]
        state = stat[stat.rindex(')') + 2]
        rows.append((int(entry.name), state, comm))
    return rows


def critical_pids():
    """The user's systemd manager plus the main process of TARDIS and its
    watchdog. Agent children in the same cgroup are left out: a shell job an
    agent suspended on purpose is not a freeze."""
    manager = subprocess.run(['/usr/bin/pgrep', '-u', USER, '-x', 'systemd'], capture_output=True, text=True).stdout
    managers = {int(p) for p in manager.split()}
    pids = set(managers)
    # systemctl talks to the frozen manager, so find the units' main PIDs from
    # their cgroups: the process the manager itself started.
    base = Path(f'/sys/fs/cgroup/user.slice/user-{UID}.slice/user@{UID}.service/app.slice')
    for unit in (UNIT, WATCHDOG_UNIT):
        try:
            members = [int(p) for p in (base / unit / 'cgroup.procs').read_text().split()]
        except (OSError, ValueError):
            continue
        for pid in members:
            try:
                status = Path(f'/proc/{pid}/status').read_text()
            except OSError:
                continue
            ppid = int(next(line.split()[1] for line in status.splitlines() if line.startswith('PPid:')))
            if ppid in managers:
                pids.add(pid)
    return pids


def thaw_if_frozen(state):
    procs = user_processes()
    stopped = {pid for pid, st, _ in procs if st == 'T'}
    if not stopped & critical_pids():
        state.pop('freeze_ticks', None)
        return False
    state['freeze_ticks'] = state.get('freeze_ticks', 0) + 1
    if state['freeze_ticks'] < FREEZE_TICKS:
        return False
    for pid in stopped:
        try:
            os.kill(pid, signal.SIGCONT)
        except OSError:
            pass
    state.pop('freeze_ticks', None)
    log('GUARDIAN_THAWED', count=len(stopped))
    page(f'Something froze every TARDIS process. I resumed {len(stopped)} of them; TARDIS should answer within a minute.')
    return True


def head():
    return as_user('git', '-C', REPO, 'rev-parse', 'HEAD').stdout.strip()


def recover(state, now):
    info = unit_info(UNIT)
    active = info.get('ActiveState')
    if active in ('inactive', 'deactivating'):
        stopped_since = state.setdefault('stopped_since', now)
        if now - stopped_since < STOP_GRACE_SECONDS:
            return
        state.pop('stopped_since', None)
        user_systemctl('start', UNIT)
        state['restarted_at'] = now
        log('GUARDIAN_STARTED_STOPPED_UNIT')
        page('TARDIS was left stopped for 15 minutes, so I started it again.')
        return
    state.pop('stopped_since', None)

    down_since = state.setdefault('down_since', now)
    restarted_at = state.get('restarted_at')
    if restarted_at is None:
        if now - down_since < DOWN_SECONDS:
            return
        user_systemctl('restart', '--no-block', UNIT)
        state['restarted_at'] = now
        log('GUARDIAN_RESTARTED', head=head())
        page(f'TARDIS stopped answering for {round((now - down_since) / 60)} minutes, so I restarted it.')
        return
    if now - restarted_at < ROLLBACK_SECONDS:
        return
    current, good = head(), state.get('last_good')
    if good and good != current and not state.get('rolled_back'):
        result = as_user('git', '-C', REPO, 'checkout', '-q', '--detach', good)
        state['rolled_back'] = True
        state['restarted_at'] = now
        user_systemctl('restart', '--no-block', UNIT)
        log('GUARDIAN_ROLLED_BACK', from_head=current, to_head=good, ok=result.returncode == 0)
        page(f'TARDIS would not come back on build {current[:8]}, so I rolled it back to {good[:8]}, the last build that ran healthy, and restarted it.')
        return
    if not state.get('gave_up'):
        state['gave_up'] = True
        log('GUARDIAN_GAVE_UP', head=current)
        page('TARDIS is still down after a restart and a rollback. It needs a person.')


def tick(state, now):
    if thaw_if_frozen(state):
        return
    if healthy():
        if state.get('down_since') is not None and state.get('restarted_at') is not None:
            page('TARDIS is answering again.', priority=0)
        for key in ('down_since', 'restarted_at', 'rolled_back', 'gave_up', 'stopped_since'):
            state.pop(key, None)
        healthy_since = state.setdefault('healthy_since', now)
        if now - healthy_since >= GOOD_SECONDS:
            current = head()
            if current and state.get('last_good') != current:
                state['last_good'] = current
                log('GUARDIAN_LAST_GOOD', head=current)
        return
    state.pop('healthy_since', None)
    recover(state, now)


def main():
    state = load_state()
    while True:
        try:
            tick(state, time.time())
            save_state(state)
        except Exception as error:  # keep guarding; never print command output
            log('GUARDIAN_RETRY', errorType=type(error).__name__)
        time.sleep(TICK)


if __name__ == '__main__':
    main()
