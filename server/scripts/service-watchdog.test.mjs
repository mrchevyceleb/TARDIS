/** Nov 12 2026: the watchdog checked a new TARDIS process only on the first
 *  10-second tick that saw it. A deploy is usually still booting then, so the
 *  check was skipped for good and every release after Nov 10 went unwatched:
 *  a hang would not have been recovered. Each process (its PID plus when the
 *  unit became active) is now checked once, on its first healthy tick, and a
 *  build without a passed restart check is still flagged to Max instead of
 *  being restarted. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const WATCHDOG = fileURLToPath(new URL('./service-watchdog.py', import.meta.url));
const noPython = spawnSync('python3', ['--version']).status !== 0;

// Runs the real tick() over a list of ticks, with systemd, HTTP and the two
// release gates faked, and prints what the watchdog did.
const HARNESS = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('watchdog', sys.argv[1])
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
plan, home = json.loads(sys.argv[2]), sys.argv[3]
did, current = [], {}

def command(*args):
    if args[:3] == ('systemctl', '--user', 'show'):
        if current.get('stopped'):
            return 'ActiveState=inactive\nSubState=dead\nMainPID=0\nActiveEnterTimestampMonotonic=0'
        return f"ActiveState=active\nSubState=running\nMainPID={current['pid']}\nActiveEnterTimestampMonotonic={current.get('entered', 1000000)}"
    if 'restart' in args:
        did.append(f"restart@{current['at']}")
    return ''

def get_json(url, data=None, timeout=3):
    if url.endswith('/api/health'):
        if not current['healthy']:
            raise ConnectionRefusedError('still booting')
        return {'ok': True}
    if url.endswith('/api/team/message'):
        did.append(f"tell Max@{current['at']}: {data['text']}")
        return {'delivered': True}
    return {'messages': []}

def adopt(config, info, config_path):
    did.append(f"check@{current['at']}")
    if not plan['passedCheck']:
        return False
    config['head'] = current.get('head', 'live')
    return True

w.command, w.get_json, w.adopt_checked_release = command, get_json, adopt
w.checked_release = lambda config: config['head'] == current.get('head', 'live')
config = {'unit': 'rivendell.service', 'base': 'http://tardis', 'head': 'older',
          'state_file': f'{home}/state.json', 'delivery_state_dir': home}
state = {}
for step in plan['ticks']:
    current.clear()
    current.update(step)
    w.tick(config, state, step['at'], f'{home}/config.json')
print(json.dumps(did))
`;

function run(plan) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-test-'));
  try {
    const out = spawnSync('python3', ['-c', HARNESS, WATCHDOG, JSON.stringify(plan), home], {
      encoding: 'utf8',
      env: { ...process.env, PUSHOVER_API_KEY: '', PUSHOVER_USER_KEY: '' },
    });
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout.trim().split('\n').pop());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const tick = (at, healthy, pid = '4242') => ({ at, healthy, pid });
const ticks = (from, to, healthy, pid) => Array.from({ length: (to - from) / 10 + 1 }, (_, i) => tick(from + i * 10, healthy, pid));

test('a deploy still booting at first sight is checked once healthy, and a later hang is recovered', { skip: noPython }, () => {
  const did = run({
    passedCheck: true,
    ticks: [...ticks(0, 10, false), ...ticks(20, 30, true), ...ticks(40, 100, false), tick(110, false, '4343'), tick(120, true, '4343')],
  });
  assert.deepEqual(did.slice(0, 2), ['check@20', 'restart@100']);
  assert.match(did[2], /^tell Max@120: TARDIS stopped responding, so its watchdog restarted the same checked build/);
  assert.equal(did.length, 3);
});

test('a build without a matching passed check is flagged to Max and never restarted', { skip: noPython }, () => {
  const did = run({ passedCheck: false, ticks: [tick(0, false), tick(10, true), ...ticks(20, 90, false)] });
  assert.equal(did[0], 'check@10');
  assert.match(did[1], /^tell Max@10: TARDIS is responding, but its new source has no matching passed restart check/);
  assert.equal(did.length, 2);
});

test('a later deploy that reuses the PID is checked again', { skip: noPython }, () => {
  const did = run({
    passedCheck: true,
    ticks: [
      { at: 0, healthy: true, pid: '4242', entered: 1000000, head: 'b' },
      { at: 10, stopped: true },
      { at: 20, healthy: false, pid: '4242', entered: 2000000, head: 'c' },
      { at: 30, healthy: true, pid: '4242', entered: 2000000, head: 'c' },
    ],
  });
  assert.deepEqual(did, ['check@0', 'check@30']);
});
