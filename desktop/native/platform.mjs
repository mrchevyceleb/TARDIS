import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
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
function settle(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Desktop control was stopped.')); };
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
}
function canonicalWindowId(value) {
  try { return `0x${BigInt(String(value).trim()).toString(16).padStart(8, '0')}`; }
  catch { return ''; }
}

// PATH lookup, not a hardcoded /usr/bin: these are operator-installed tools that
// land in /usr/local/bin, ~/.local/bin or a Nix profile just as often, and run()
// resolves them through PATH anyway. Hardcoding the prefix reports a working
// install as a missing dependency and silently disables computer use.
function onPath(name) {
  return (process.env.PATH || '').split(delimiter).some(dir => {
    if (!dir) return false;
    try { accessSync(join(dir, name), constants.X_OK); return true; } catch { return false; }
  });
}

class LinuxAdapter {
  constructor() {
    const missing = ['xdotool', 'wmctrl', 'xrandr', 'maim', 'gdbus'].filter(name => !onPath(name));
    this.capability = { supported: Boolean(process.env.DISPLAY) && process.env.XDG_SESSION_TYPE !== 'wayland' && !missing.length,
      reason: process.env.XDG_SESSION_TYPE === 'wayland' ? 'Wayland desktop input requires a portal adapter; this build supports X11.' : !process.env.DISPLAY ? 'No graphical DISPLAY. Run the companion in the logged-in desktop session.' : missing.length ? `Install desktop dependencies: ${missing.join(', ')}` : undefined };
  }
  async windowGeometry(id, signal) {
    const raw = await run('xdotool', ['getwindowgeometry', '--shell', id], signal);
    const fields = Object.fromEntries(raw.split('\n').flatMap(line => {
      const match = /^([A-Z]+)=(-?\d+)$/.exec(line.trim());
      return match ? [[match[1], Number(match[2])]] : [];
    }));
    if (![fields.X, fields.Y, fields.WIDTH, fields.HEIGHT].every(Number.isInteger) || fields.WIDTH < 1 || fields.HEIGHT < 1) throw new Error('Window geometry is unavailable.');
    return { x: fields.X, y: fields.Y, width: fields.WIDTH, height: fields.HEIGHT };
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
    const list = await run('wmctrl', ['-l'], signal);
    const rows = list.split('\n').flatMap(line => {
      const m = line.match(/^(0x[\da-f]+)\s+(-?\d+)\s+\S+\s*(.*)$/i);
      return m ? [{ id: canonicalWindowId(m[1]), title: m[3].slice(0, 300) }] : [];
    }).slice(0, 100);
    // wmctrl -lG reports incorrect top-left coordinates for client-side
    // decorated GTK windows on GNOME (observed exactly 2x while width/height
    // stayed unscaled). xdotool asks X for the actual client geometry used by
    // screenshots and input, so coordinates and crops share one space.
    const windows = (await Promise.all(rows.map(async row => {
      try { return { ...row, bounds: await this.windowGeometry(row.id, signal) }; }
      catch { return null; } // window closed between list and geometry
    }))).filter(Boolean);
    let activeWindow;
    try { activeWindow = canonicalWindowId(await run('xdotool', ['getactivewindow'], signal)); } catch { /* desktop has no active managed window */ }
    return { displays, windows, activeWindow: activeWindow || undefined };
  }
  async capture(signal) {
    const dir = await mkdtemp(join(tmpdir(), 'tardis-screen-'));
    try {
      const file = join(dir, 'screen.png');
      // maim, not gnome-screenshot: GNOME plays a shutter sound and flashes
      // the screen on every capture, which is intolerable for an agent that
      // screenshots in a loop (and gets forwarded over remote-desktop audio).
      await run('maim', ['--hidecursor', file], signal);
      const png = await readFile(file);
      // GNOME/X11 captures the root framebuffer, whose origin is (0,0),
      // NOT a Windows-style monitor union. A primary monitor to the right
      // has a positive x offset; unused root pixels are valid too.
      return { png, bounds: { x: 0, y: 0, width: png.readUInt32BE(16), height: png.readUInt32BE(20) } };
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  async activeWindow(signal) {
    return canonicalWindowId(await run('xdotool', ['getactivewindow'], signal));
  }
  async focusWindow(window, signal) {
    const target = canonicalWindowId(window);
    if (!target) throw new Error('Invalid window id. Inspect windows again.');
    await run('xdotool', ['windowactivate', '--sync', target], signal);
    const active = await this.activeWindow(signal);
    if (active !== target) throw new Error(`Window focus verification failed: expected ${target}, active window is ${active || 'none'}. No keyboard input was sent.`);
    return target;
  }
  async assertWindow(target, bounds, signal, afterInput = false) {
    if (await this.activeWindow(signal) !== target) {
      throw new Error(afterInput
        ? 'The active window changed during input. Input may have run; inspect the current desktop before continuing.'
        : 'The active window changed before input. No input was sent; inspect and focus the window again.');
    }
    if (bounds && JSON.stringify(await this.windowGeometry(target, signal)) !== JSON.stringify(bounds)) {
      throw new Error(afterInput
        ? 'The target window moved or resized during input. Input may have run; inspect before continuing.'
        : 'Window moved or resized while it was being focused. No input was sent; capture that window again.');
    }
  }
  async act(a, signal) {
    const target = a.window ? await this.focusWindow(a.window, signal) : '';
    if (target) await this.assertWindow(target, a.windowBounds, signal);
    const mouseAction = ['move', 'click', 'right_click', 'double_click', 'scroll', 'drag'].includes(a.action);
    if (mouseAction) {
      await run('xdotool', ['mousemove', '--sync', String(a.x), String(a.y)], signal);
      if (target) await this.assertWindow(target, a.windowBounds, signal); // immediately before global button/wheel input
      if (a.action === 'move') return;
      const args = a.action === 'click' ? ['click', '1']
        : a.action === 'right_click' ? ['click', '3']
        : a.action === 'double_click' ? ['click', '--repeat', '2', '--delay', '100', '1']
        : a.action === 'scroll' ? ['click', '--repeat', String(a.amount), '--delay', '40', String({ up: 4, down: 5, left: 6, right: 7 }[a.direction])]
        : ['mousedown', '1', 'mousemove', '--sync', String(a.toX), String(a.toY), 'mouseup', '1'];
      try { await run('xdotool', args, signal); }
      finally { if (a.action === 'drag') await this.release(); }
      await settle(80, signal);
      if (target) await this.assertWindow(target, a.windowBounds, signal, true);
      return;
    }
    if (a.action === 'focus') return;
    if (a.action === 'type') {
      if (!target) throw new Error('Targeted typing requires a window id. Use computer_type.');
      await run('xdotool', ['type', '--clearmodifiers', '--delay', '1', '--file', '-'], signal, a.text);
      await settle(80, signal);
      await this.assertWindow(target, undefined, signal, true);
      return;
    }
    if (a.action === 'key') {
      if (!target) throw new Error('Targeted keys require a window id. Use computer_key.');
      try { await run('xdotool', ['key', '--clearmodifiers', a.keys.map(keyName).join('+')], signal); }
      finally { await this.release(); }
      await settle(80, signal);
      await this.assertWindow(target, undefined, signal, true);
      return;
    }
    throw new Error('Unsupported action.');
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
