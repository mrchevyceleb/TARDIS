#!/usr/bin/env python3
"""Root-level guardian for TARDIS: recovery from outside the agents' reach.

Agents run as the same user as TARDIS and its user watchdog, so one bad
command can take all of them down together (Nov 4 2026: a QA script's
`kill -STOP` became kill(-1) and froze every user process, watchdog
included, for an hour). This runs as a system service under root, which a
user-level signal cannot reach. Each tick it:

  1. Thaws a mass freeze: when the user's systemd manager, TARDIS or its
     watchdog is stopped, every stopped process of that user is continued.
  2. Brings TARDIS back when it has not answered /api/health: restarts the
     unit, and if it still cannot come up, checks out the last build that
     ran healthy (only on a clean tree, verified after) and restarts that.
  3. Pages Matt (Pushover) on every recovery and when it needs a person,
     retrying a page that could not be sent.

It never clears state, never touches chats or uncommitted edits, gives a
fresh process time to repair its packages and build, and leaves a
deliberate stop alone for STOP_GRACE_SECONDS so a hands-on deploy is not
fought.
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
BOOT_GRACE_SECONDS = 900   # start.sh may repair packages (600s) and build (120s)
ROLLBACK_SECONDS = 240     # still down this long after a restart, roll back
GOOD_SECONDS = 600         # one process healthy this long marks its build good
STOP_GRACE_SECONDS = 900   # a deliberate stop is left alone this long
PAGE_RETRY_SECONDS = 120

pw = pwd.getpwnam(USER)
UID = pw.pw_uid
CLK_TCK = os.sysconf('SC_CLK_TCK')


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


def user_systemctl(*args, timeout=20):
    return as_user('systemctl', '--user', *args, timeout=timeout)


def unit_info(unit, timeout=20):
    out = user_systemctl('show', unit, '--property=ActiveState,SubState,MainPID', timeout=timeout).stdout
    return dict(line.split('=', 1) for line in out.splitlines() if '=' in line)


def page(message, priority=1):
    """True once Pushover accepted it (or there are no keys to send with)."""
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
        return True
    data = urllib.parse.urlencode({'token': token, 'user': user, 'title': 'TARDIS guardian',
                                   'priority': priority, 'message': message}).encode()
    try:
        with urllib.request.urlopen('https://api.pushover.net/1/messages.json', data=data, timeout=20) as response:
            return response.status == 200
    except OSError as error:
        log('GUARDIAN_PAGE_FAILED', errorType=type(error).__name__)
        return False


def notify(state, now, message, priority=1):
    """Page now; a page that fails is kept and retried on later ticks."""
    if not page(message, priority):
        state.setdefault('pending_pages', []).append({'message': message, 'priority': priority, 'at': now})


def retry_pages(state, now):
    pending = state.get('pending_pages')
    if not pending or now - state.get('page_retry_at', 0) < PAGE_RETRY_SECONDS:
        return
    state['page_retry_at'] = now
    while pending and page(pending[0]['message'], pending[0]['priority']):
        pending.pop(0)
    if not pending:
        state.pop('pending_pages', None)


def healthy():
    try:
        with urllib.request.urlopen(HEALTH, timeout=5) as response:
            return json.load(response).get('ok') is True
    except (OSError, ValueError):
        return False


def user_processes():
    """(pid, state) for every process owned by USER."""
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
        rows.append((int(entry.name), stat[stat.rindex(')') + 2]))
    return rows


def critical_pids():
    """The user's systemd manager plus the main process of TARDIS and its
    watchdog. Nothing else: an agent's own suspended job, or a helper the
    unit adopted, is not a freeze."""
    manager = subprocess.run(['/usr/bin/pgrep', '-u', USER, '-x', 'systemd'], capture_output=True, text=True).stdout
    pids = {int(p) for p in manager.split()}
    for unit in (UNIT, WATCHDOG_UNIT):
        try:
            # A frozen manager cannot answer; it is already in the set above.
            main = int(unit_info(unit, timeout=5).get('MainPID', '0'))
        except (subprocess.SubprocessError, ValueError):
            continue
        if main:
            pids.add(main)
    return pids


def thaw_if_frozen(state, now):
    stopped = {pid for pid, st in user_processes() if st == 'T'}
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
    notify(state, now, f'Something froze TARDIS. I resumed {len(stopped)} stopped processes; it should answer within a minute.')
    return True


def head():
    result = as_user('git', '-C', REPO, 'rev-parse', 'HEAD')
    return result.stdout.strip() if result.returncode == 0 else ''


def tree_clean():
    result = as_user('git', '-C', REPO, 'status', '--porcelain', '--untracked-files=no')
    return result.returncode == 0 and not result.stdout.strip()


def process_age(pid):
    """Seconds since pid started, or None."""
    try:
        start_ticks = int(Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19])
        uptime = float(Path('/proc/uptime').read_text().split()[0])
    except (OSError, ValueError, IndexError):
        return None
    return uptime - start_ticks / CLK_TCK


def boot_release(pid):
    """The commit a fresh process booted from, or '' when that is unknowable
    (the checkout moved or was edited after the process started)."""
    age = process_age(pid)
    if age is None:
        return ''
    try:
        moved = Path(REPO, '.git', 'logs', 'HEAD').stat().st_mtime
    except OSError:
        return ''
    if moved > time.time() - age or not tree_clean():
        return ''
    return head()


def track_release(state, info, now):
    """Remember which build this process runs; mark it good once it has
    answered continuously for GOOD_SECONDS."""
    pid = info.get('MainPID', '0')
    if state.get('pid') != pid:
        state['pid'] = pid
        state['release'] = boot_release(int(pid)) if pid != '0' else ''
        state.pop('healthy_since', None)
    healthy_since = state.setdefault('healthy_since', now)
    release = state.get('release')
    if release and now - healthy_since >= GOOD_SECONDS and state.get('last_good') != release:
        state['last_good'] = release
        log('GUARDIAN_LAST_GOOD', head=release)


def give_up(state, now, reason):
    if not state.get('gave_up'):
        state['gave_up'] = True
        log('GUARDIAN_GAVE_UP', reason=reason)
        notify(state, now, f'TARDIS is still down and needs a person: {reason}')


def roll_back(state, now):
    current, good = head(), state.get('last_good')
    if not good or good == current:
        give_up(state, now, 'a restart did not bring it back and there is no other healthy build to roll back to.')
        return
    if not tree_clean():
        give_up(state, now, 'a restart did not bring it back, and its checkout has uncommitted edits, so I left it alone instead of rolling back.')
        return
    result = as_user('git', '-C', REPO, 'checkout', '-q', '--detach', good)
    if result.returncode != 0 or head() != good:
        give_up(state, now, f'rolling back to {good[:8]} failed.')
        return
    restart = user_systemctl('restart', '--no-block', UNIT)
    state['rolled_back'] = True
    state['restarted_at'] = now
    log('GUARDIAN_ROLLED_BACK', from_head=current, to_head=good, restart_ok=restart.returncode == 0)
    notify(state, now, f'TARDIS would not come back on build {current[:8]}, so I rolled it back to {good[:8]}, the last build that ran healthy, and restarted it.')


def recover(state, info, now):
    active = info.get('ActiveState')
    if active in ('inactive', 'deactivating'):
        stopped_since = state.setdefault('stopped_since', now)
        if now - stopped_since < STOP_GRACE_SECONDS:
            return
        if user_systemctl('start', UNIT).returncode == 0:
            state.pop('stopped_since', None)
            state['restarted_at'] = now
            log('GUARDIAN_STARTED_STOPPED_UNIT')
            notify(state, now, 'TARDIS was left stopped for 15 minutes, so I started it again.')
        return
    state.pop('stopped_since', None)
    if state.get('gave_up'):
        return

    down_since = state.setdefault('down_since', now)
    running = active == 'active' and info.get('SubState') == 'running'
    age = process_age(int(info.get('MainPID', '0') or 0)) if running else None
    # A running process younger than the boot grace may still be repairing
    # its packages or building; a unit that keeps failing to start is not.
    booting = age is not None and age < BOOT_GRACE_SECONDS

    restarted_at = state.get('restarted_at')
    if restarted_at is None:
        if now - down_since < DOWN_SECONDS or booting:
            return
        if user_systemctl('restart', '--no-block', UNIT).returncode != 0:
            log('GUARDIAN_RESTART_FAILED')
            return  # try again next tick
        state['restarted_at'] = now
        log('GUARDIAN_RESTARTED', head=head())
        notify(state, now, f'TARDIS stopped answering for {round((now - down_since) / 60)} minutes, so I restarted it.')
        return
    if now - restarted_at < ROLLBACK_SECONDS or booting:
        return
    if state.get('rolled_back'):
        give_up(state, now, 'a restart and a rollback did not bring it back.')
        return
    roll_back(state, now)


def tick(state, now):
    retry_pages(state, now)
    if thaw_if_frozen(state, now):
        return
    info = unit_info(UNIT)
    if healthy():
        if state.get('restarted_at') is not None or state.get('gave_up'):
            notify(state, now, 'TARDIS is answering again.', priority=0)
        for key in ('down_since', 'restarted_at', 'rolled_back', 'gave_up', 'stopped_since'):
            state.pop(key, None)
        track_release(state, info, now)
        return
    state.pop('healthy_since', None)
    recover(state, info, now)


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
