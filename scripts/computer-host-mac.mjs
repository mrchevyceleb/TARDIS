#!/usr/bin/env node
// Runs the computer host companion (server/src/devices/host.ts) on a Mac as a
// per-user LaunchAgent: it starts at login, restarts if it stops, and stays
// light, with no Electron window or renderer.
//
// The agent runs host.ts on TARDIS.app's own signed binary in Node mode
// (ELECTRON_RUN_AS_NODE; its embedded Node strips the TypeScript types).
// launchd makes that process its own responsible process, so macOS attributes
// Screen Recording and Accessibility to TARDIS: the host inherits whatever the
// person at the Mac already allowed for TARDIS, with no new grant to click. A
// Homebrew node would be a separate, unsigned identity whose grant breaks on
// every upgrade.
//
//   npm run computer:mac -- install [--server URL] [--name NAME] [--unattended] [--no-indicator] [--app PATH]
//   npm run computer:mac -- uninstall
//
// Running install again rebuilds the Swift helper from this checkout and
// restarts the host, so it is also the update step after a pull.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { trustedComputerUrl } from '../desktop/native/computer.mjs';

const LABEL = 'app.tardis.computer-host';
const BUNDLE_ID = 'app.tardis.desktop';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plist = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const log = join(homedir(), 'Library', 'Logs', 'TARDIS', 'computer-host.log');
const domain = `gui/${userInfo().uid}`;
const usage = 'usage: npm run computer:mac -- install [--server URL] [--name NAME] [--unattended] [--no-indicator] [--app PATH] | uninstall';

function fail(message) {
  console.error(`computer:mac: ${message}`);
  process.exit(1);
}
function run(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 120_000, ...options });
  return { ok: result.status === 0, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() || result.error?.message || '' };
}
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, options: {
    server: { type: 'string' }, name: { type: 'string' }, app: { type: 'string' },
    unattended: { type: 'boolean', default: false }, 'no-indicator': { type: 'boolean', default: false },
  } });
} catch (error) { fail(`${error.message}\n${usage}`); }
const { positionals: [command], values } = parsed;
if (process.platform !== 'darwin') fail('this sets the host up on a Mac. On Linux or Windows, run npm run computer:host in the desktop session (docs/COMPUTER-USE.md).');
const bootout = () => run('launchctl', ['bootout', `${domain}/${LABEL}`]);

if (command === 'uninstall') {
  bootout();
  rmSync(plist, { force: true });
  console.log('Removed the TARDIS computer host. TARDIS.app, its permissions and this machine\'s pairing are unchanged.');
  process.exit(0);
}
if (command !== 'install') fail(usage);

// 1. TARDIS.app: its binary is the host's runtime and its identity is the grant.
const candidates = values.app ? [values.app] : [join(homedir(), 'Applications', 'TARDIS.app'), '/Applications/TARDIS.app'];
const app = candidates.find(path => existsSync(join(path, 'Contents', 'MacOS', 'TARDIS')));
if (!app) fail(`TARDIS.app was not found ${values.app ? `at ${values.app}` : 'in ~/Applications or /Applications'}. Install the desktop app first: the host runs on its binary, so it shares TARDIS's Screen Recording and Accessibility permissions.`);
const bundleId = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(app, 'Contents', 'Info.plist')]).out;
if (bundleId !== BUNDLE_ID) fail(`${app} is not TARDIS (bundle id ${bundleId || 'unknown'}).`);
const binary = join(app, 'Contents', 'MacOS', 'TARDIS');
const probe = run(binary, ['-p', 'process.features.typescript'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 });
if (!probe.ok || !['strip', 'transform'].includes(probe.out)) {
  fail(`${app} cannot run the host in Node mode (${(probe.err || probe.out || 'no output').slice(0, 300)}). Update TARDIS.app: the host needs Electron's RunAsNode fuse and TypeScript type stripping (Node 24+).`);
}

// 2. The Swift helper, built from this checkout so it always matches host.ts.
if (!run('xcode-select', ['-p']).ok) fail('building the macOS control helper needs the Xcode Command Line Tools. Run xcode-select --install, then run this again.');
const helper = join(root, 'desktop', 'native', 'macos-helper');
const building = `${helper}.${process.pid}.tmp`;
const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
console.log(`Building the macOS control helper (${arch})…`);
const build = spawnSync('xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', `${arch}-apple-macos14`, join(root, 'desktop', 'native', 'macos.swift'), '-o', building], { stdio: 'inherit' });
if (build.status !== 0) { rmSync(building, { force: true }); fail('the Swift helper did not build (see above).'); }
renameSync(building, helper); // atomic: a running host never executes a half-written helper

// 3. Where to connect and what to be called. The app's own server is the
// default, so a Mac already linked through TARDIS.app needs no flags.
let appServer;
try { appServer = JSON.parse(readFileSync(join(homedir(), 'Library', 'Application Support', 'TARDIS', 'settings.json'), 'utf8')).serverUrl; } catch { /* the app was never connected */ }
const server = values.server || process.env.RIVENDELL_COMPUTER_SERVER_URL || appServer || 'http://127.0.0.1:8091';
let trusted = false;
try { trusted = trustedComputerUrl(server); } catch { /* not a URL */ }
if (!trusted) fail(`${server} is not a server the host may connect to: use HTTPS, or http on loopback.`);
// The Finder name, with typographic quotes made typeable: agents name the
// computer by it.
const name = (values.name || run('scutil', ['--get', 'ComputerName']).out).replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
const env = {
  ELECTRON_RUN_AS_NODE: '1',
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  RIVENDELL_COMPUTER_SERVER_URL: server,
  ...(name ? { RIVENDELL_COMPUTER_NAME: name } : {}),
  ...(values.unattended ? { RIVENDELL_COMPUTER_UNATTENDED: 'true' } : {}),
  ...(values['no-indicator'] ? { RIVENDELL_COMPUTER_INDICATOR: 'false' } : {}),
};

// 4. The LaunchAgent. Aqua only: computer control needs the logged-in desktop.
// AssociatedBundleIdentifiers lists it under TARDIS in Login Items.
mkdirSync(dirname(plist), { recursive: true });
mkdirSync(dirname(log), { recursive: true });
writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(binary)}</string>
    <string>${xml(join(root, 'server', 'src', 'devices', 'host.ts'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([key, value]) => `    <key>${key}</key><string>${xml(value)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>AssociatedBundleIdentifiers</key><string>${BUNDLE_ID}</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`);
const lint = run('plutil', ['-lint', plist]);
if (!lint.ok) fail(`the LaunchAgent did not validate: ${lint.out || lint.err}`);

// 5. (Re)start it. launchd can take a moment to tear the previous job down.
const logStart = existsSync(log) ? statSync(log).size : 0;
bootout();
for (let attempt = 0; ; attempt++) {
  const started = run('launchctl', ['bootstrap', domain, plist]);
  if (started.ok) break;
  if (attempt === 5) fail(`launchctl could not start the host: ${started.err || started.out}. Run this from the Mac's logged-in user (an SSH session works while that user is logged in at the desktop).`);
  pause(500);
}

// 6. Show what the host itself reports: its link and the permissions it holds.
let report = '';
for (let waited = 0; waited < 15_000 && !/macOS (allows|has not allowed)|not built|cannot|Error/.test(report); waited += 500) {
  pause(500);
  if (!existsSync(log)) continue;
  const size = statSync(log).size;
  if (size <= logStart) continue;
  const fd = openSync(log, 'r');
  const chunk = Buffer.alloc(Math.min(size - logStart, 64 * 1024));
  readSync(fd, chunk, 0, chunk.length, logStart);
  closeSync(fd);
  report = chunk.toString('utf8');
}
console.log(`\n${report.trim() || '(the host has not logged anything yet)'}\n`);
console.log(`TARDIS computer host installed as "${name || 'this Mac'}" → ${new URL(server).origin}
  Starts at login and restarts if it stops (LaunchAgent ${LABEL}).
  Approval: ${values.unattended ? 'automatic (unattended)' : 'asks the person at this Mac for each grant'}; indicator ${values['no-indicator'] ? 'off' : 'on'}.
  Log: ${log}
  Update after a pull: run this install again. Remove: npm run computer:mac -- uninstall`);
