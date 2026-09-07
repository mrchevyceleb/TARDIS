import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function run(file, args, signal, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { signal, timeout: 20_000, maxBuffer: 40 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (!err) { resolve(stdout); return; }
      let message = err.message;
      try { const out = JSON.parse(stdout); if (typeof out.error === 'string') message = out.error; } catch { /* not adapter JSON */ }
      reject(new Error(`${file}: ${message}`));
    });
    child.stdin?.end(input);
  });
}
const KEY_NAMES = { CTRL: 'ctrl', ALT: 'alt', SHIFT: 'shift', META: 'super', ENTER: 'Return', TAB: 'Tab', ESC: 'Escape', BACKSPACE: 'BackSpace', DELETE: 'Delete', SPACE: 'space', UP: 'Up', DOWN: 'Down', LEFT: 'Left', RIGHT: 'Right', HOME: 'Home', END: 'End', PAGEUP: 'Prior', PAGEDOWN: 'Next' };
const keyName = k => KEY_NAMES[k] ?? (k.length === 1 ? k.toLowerCase() : k);

class LinuxAdapter {
  constructor() {
    const missing = ['xdotool', 'wmctrl', 'xrandr', 'gnome-screenshot', 'gdbus'].filter(name => !existsSync(`/usr/bin/${name}`));
    this.capability = { supported: Boolean(process.env.DISPLAY) && process.env.XDG_SESSION_TYPE !== 'wayland' && !missing.length,
      reason: process.env.XDG_SESSION_TYPE === 'wayland' ? 'Wayland desktop input requires a portal adapter; this build supports X11.' : !process.env.DISPLAY ? 'No graphical DISPLAY. Run the companion in the logged-in desktop session.' : missing.length ? `Install desktop dependencies: ${missing.join(', ')}` : undefined };
  }
  async inspect(signal) {
    const locked = await run('gdbus', ['call', '--session', '--dest', 'org.gnome.ScreenSaver', '--object-path', '/org/gnome/ScreenSaver', '--method', 'org.gnome.ScreenSaver.GetActive'], signal);
    if (locked.trim() !== '(false,)') throw new Error('Desktop is locked or lock state is unavailable.');
    const monitors = await run('xrandr', ['--listmonitors'], signal);
    const displays = monitors.split('\n').flatMap(line => {
      const m = line.match(/^\s*\d+:\s+\S+\s+(\d+)\/\d+x(\d+)\/\d+([+-]\d+)([+-]\d+)\s+(\S+)/);
      return m ? [{ id: m[5], bounds: { x: +m[3], y: +m[4], width: +m[1], height: +m[2] }, scaleFactor: 1 }] : [];
    });
    if (!displays.length) throw new Error('No X11 monitors found.');
    const list = await run('wmctrl', ['-lG'], signal);
    const windows = list.split('\n').flatMap(line => {
      const m = line.match(/^(0x[\da-f]+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s*(.*)$/i);
      return m ? [{ id: m[1], title: m[7].slice(0, 300), bounds: { x: +m[3], y: +m[4], width: +m[5], height: +m[6] } }] : [];
    });
    return { displays, windows };
  }
  async capture(signal) {
    const dir = await mkdtemp(join(tmpdir(), 'tardis-screen-'));
    try {
      const file = join(dir, 'screen.png');
      await run('gnome-screenshot', ['-f', file], signal);
      const png = await readFile(file);
      // GNOME/X11 captures the root framebuffer, whose origin is (0,0),
      // NOT a Windows-style monitor union. A primary monitor to the right
      // has a positive x offset; unused root pixels are valid too.
      return { png, bounds: { x: 0, y: 0, width: png.readUInt32BE(16), height: png.readUInt32BE(20) } };
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  async act(a, signal) {
    const move = ['mousemove', '--sync', String(a.x), String(a.y)];
    let args;
    switch (a.action) {
      case 'focus': await run('wmctrl', ['-ia', a.window], signal); return;
      case 'move': args = move; break;
      case 'click': args = [...move, 'click', '1']; break;
      case 'right_click': args = [...move, 'click', '3']; break;
      case 'double_click': args = [...move, 'click', '--repeat', '2', '--delay', '100', '1']; break;
      case 'scroll': args = [...move, 'click', '--repeat', String(a.amount), '--delay', '40', String({ up: 4, down: 5, left: 6, right: 7 }[a.direction])]; break;
      case 'drag': args = [...move, 'mousedown', '1', 'mousemove', '--sync', String(a.toX), String(a.toY), 'mouseup', '1']; break;
      case 'type': await run('xdotool', ['type', '--clearmodifiers', '--delay', '1', '--file', '-'], signal, a.text); return;
      case 'key': args = ['key', '--clearmodifiers', a.keys.map(keyName).join('+')]; break;
      default: throw new Error('Unsupported action.');
    }
    try { await run('xdotool', args, signal); }
    finally { if (a.action === 'drag' || a.action === 'key') await this.release(); }
  }
  async release() {
    if (this.capability.supported) await run('xdotool', ['mouseup', '1', 'mouseup', '2', 'mouseup', '3', 'keyup', 'ctrl', 'alt', 'shift', 'super']);
  }
}

class WindowsAdapter {
  capability = { supported: true };
  async call(op, args = {}, signal) {
    const script = join(dirname(fileURLToPath(import.meta.url)), 'windows.ps1').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], signal, JSON.stringify({ op, ...args }));
    const result = JSON.parse(out.replace(/^\uFEFF/, '').trim());
    if (result.error) throw new Error(result.error);
    return result;
  }
  inspect(signal) { return this.call('inspect', {}, signal); }
  async capture(signal) { const result = await this.call('capture', {}, signal); return { png: Buffer.from(result.png, 'base64'), bounds: result.bounds }; }
  act(action, signal) { return this.call('act', action, signal); }
  release() { return this.call('release'); }
}
export function createAdapter() {
  if (process.platform === 'linux') return new LinuxAdapter();
  if (process.platform === 'win32') return new WindowsAdapter();
  return { capability: { supported: false, reason: 'Native input is currently available on Windows and GNOME X11. macOS requires a Screen Recording/Accessibility adapter.' }, release: async () => {} };
}
