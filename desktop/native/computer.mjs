// Shared by Electron and the optional host companion. No listener, renderer,
// model or server dependency: the machine owns its grant and serialises input.
import { createHash, randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { createAdapter } from './platform.mjs';

// The host companion and Electron can both be open on one desktop. Give the
// relay a shared physical-desktop identity without exposing the local username.
export function desktopIdentity() {
  return createHash('sha256').update(`${hostname()}\0${userInfo().username}`).digest('hex');
}

export function trustedComputerUrl(raw) {
  const url = new URL(raw);
  return !url.username && !url.password && (url.protocol === 'https:' ||
    (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
}

const ACTIONS = new Set(['move', 'click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'key', 'focus']);
export const KEYS = new Set(['CTRL', 'ALT', 'SHIFT', 'META', 'ENTER', 'TAB', 'ESC', 'BACKSPACE', 'DELETE', 'SPACE', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'HOME', 'END', 'PAGEUP', 'PAGEDOWN', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)]);
export function validateAction(input, frame, windows) {
  if (!input || !ACTIONS.has(input.action)) throw new Error('Unknown desktop action.');
  const a = { action: input.action };
  if (['move', 'click', 'double_click', 'right_click', 'drag', 'scroll'].includes(a.action)) {
    for (const key of a.action === 'drag' ? ['x', 'y', 'toX', 'toY'] : ['x', 'y']) {
      const n = input[key];
      const size = key.toLowerCase().endsWith('x') ? frame.width : frame.height;
      if (!Number.isInteger(n) || n < 0 || n >= size) throw new Error(`${key} must be inside the current screenshot.`);
      a[key] = Math.round((key.toLowerCase().endsWith('x') ? frame.bounds.x : frame.bounds.y) + n *
        (key.toLowerCase().endsWith('x') ? frame.bounds.width : frame.bounds.height) / size);
    }
  }
  if (a.action === 'scroll') {
    if (!['up', 'down', 'left', 'right'].includes(input.direction)) throw new Error('Invalid scroll direction.');
    a.direction = input.direction;
    if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > 10) throw new Error('Scroll amount must be 1–10.');
    a.amount = input.amount;
  }
  if (a.action === 'type') {
    if (typeof input.text !== 'string' || !input.text || input.text.length > 2000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(input.text)) throw new Error('Text must be 1–2000 characters without control codes.');
    a.text = input.text;
  }
  if (a.action === 'key') {
    if (!Array.isArray(input.keys) || !input.keys.length || input.keys.length > 5 || input.keys.some(k => !KEYS.has(k))) throw new Error('Invalid keys; use named uppercase keys.');
    a.keys = [...new Set(input.keys)];
  }
  if (a.action === 'focus') {
    if (typeof input.window !== 'string' || !windows.some(w => w.id === input.window)) throw new Error('Window is no longer available. Inspect again.');
    a.window = input.window;
  }
  return a;
}

async function encodeScreenshot(png, region) {
  // Only the Node host uses sharp. Electron injects nativeImage processing to
  // avoid loading a competing libvips/GLib build into its Chromium process.
  const { default: sharp } = await import('sharp');
  return sharp(png, { limitInputPixels: 100_000_000 }).extract(region)
    .resize({ width: 1600, height: 1200, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75 }).toBuffer({ resolveWithObject: true });
}

export class ComputerController {
  constructor({ approve, automatic = () => false, changed = () => {}, adapter = createAdapter(), encode = encodeScreenshot }) {
    this.approve = approve;
    this.automatic = automatic;
    this.paused = false;
    this.changed = changed;
    this.adapter = adapter;
    this.encode = encode;
    this.generation = 0;
    this.busy = false;
    this.grant = null;
    this.frame = null;
    this.inputActive = false;
    this.releasePending = Promise.resolve();
    this.capability = adapter.capability;
  }
  status() {
    const g = this.grant;
    return { supported: this.capability.supported, reason: this.capability.reason,
      approvalMode: this.automatic() ? 'automatic' : 'ask', paused: this.paused,
      control: g ? { owner: g.owner, label: g.label, purpose: g.purpose, expiresAt: g.expiresAt } : null };
  }
  stop(pause = false) {
    if (pause && this.automatic()) this.paused = true;
    this.generation++;
    const hadInput = this.inputActive;
    this.inputActive = false;
    this.abort?.abort();
    clearTimeout(this.timer);
    this.grant = null;
    this.frame = null;
    this.changed(this.status());
    // A cancelled drag/hotkey must never leave a button or modifier down.
    if (hadInput) this.releasePending = this.adapter.release().catch(() => {});
  }
  requireGrant(session) {
    if (!this.grant || this.grant.id !== session || Date.now() >= this.grant.expiresAt) throw new Error('No active desktop grant. Request control again; never work around a refusal.');
  }
  async handle(op, params = {}) {
    if (op === 'end') { this.requireGrant(params.session); this.stop(); return { stopped: true }; }
    if (op === 'stop') { this.stop(true); return { stopped: true, paused: this.paused }; }
    if (op === 'resume') { if (this.paused) { this.paused = false; this.changed(this.status()); } return { resumed: true }; }
    if (this.paused) throw new Error('Computer control is paused by the user. Do not retry, resume it yourself, or change permissions. The operator can use Resume control.');
    if (op === 'preview') {
      if (!this.grant || Date.now() >= this.grant.expiresAt || !this.frame) throw new Error('No active screen preview.');
      const { image, width, height, capturedAt, displayId } = this.frame;
      return { image, width, height, capturedAt, displayId };
    }
    if (!this.capability.supported) throw new Error(this.capability.reason);
    const limit = op === 'start' ? 60_000 : 30_000;
    const remaining = params.deadlineAt === undefined ? limit : Number(params.deadlineAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > limit + 5000) throw new Error('Desktop request expired or machine clocks differ. No action taken.');
    if (this.busy) throw new Error('This desktop is already handling a request. Do not replay input.');
    this.busy = true;
    const generation = this.generation;
    const ac = new AbortController();
    this.abort = ac;
    const check = () => {
      if (ac.signal.aborted || generation !== this.generation) throw new Error('Desktop control was stopped.');
    };
    const deadline = setTimeout(() => ac.abort(), Math.min(limit, remaining));
    let inputAttempted = false;
    try {
      await this.releasePending;
      check();
      if (op === 'start') {
        if (this.grant) throw new Error(`Desktop in use by ${this.grant.label}. Wait for its owner to release control; do not take it over or ask the user to clear routine contention.`);
        const { owner, label, purpose } = params;
        if (typeof owner !== 'string' || !owner || typeof label !== 'string' || label.length > 100 || typeof purpose !== 'string' || !purpose.trim() || purpose.length > 500) throw new Error('A named owner and short task description are required.');
        await this.adapter.inspect(ac.signal);
        const allowed = this.automatic() || await this.approve({ owner, label, purpose, minutes: 5 }, ac.signal);
        check();
        if (!allowed) throw new Error('The person at this computer declined desktop control. Stop; do not retry by another route.');
        this.grant = { id: randomUUID(), owner, label, purpose, expiresAt: Date.now() + 5 * 60_000 };
        this.timer = setTimeout(() => this.stop(), 5 * 60_000);
        this.timer.unref?.();
        this.changed(this.status());
        return { session: this.grant.id, ...this.status() };
      }
      this.requireGrant(params.session);
      const info = await this.adapter.inspect(ac.signal);
      check();
      if (op === 'inspect') return info;
      if (op !== 'capture' && op !== 'act') throw new Error('Unknown desktop operation.');
      let displayId = params.display ?? info.displays[0]?.id;
      if (op === 'act') {
        const f = this.frame;
        if (!f || f.id !== params.frame || Date.now() - f.capturedAt > 30_000 || f.layout !== JSON.stringify(info.displays)) throw new Error('Screenshot is stale or displays changed. Capture again before acting.');
        const action = validateAction(params, f, info.windows);
        displayId = f.displayId;
        this.frame = null; // Consume BEFORE input, including uncertain failures.
        this.requireGrant(params.session);
        check();
        inputAttempted = true;
        this.inputActive = true;
        await this.adapter.act(action, ac.signal);
        this.inputActive = false;
        check();
      }
      const after = op === 'act' ? await this.adapter.inspect(ac.signal) : info;
      const display = after.displays.find(d => d.id === displayId);
      if (!display) throw new Error('Display unavailable. Inspect displays and capture again.');
      const raw = await this.adapter.capture(ac.signal);
      check();
      const bounds = display.bounds;
      if (raw.png.length < 24 || raw.png.readUInt32BE(16) * raw.png.readUInt32BE(20) > 100_000_000) throw new Error('Screenshot dimensions exceed the safe limit.');
      const image = await this.encode(raw.png, { left: bounds.x - raw.bounds.x, top: bounds.y - raw.bounds.y, width: bounds.width, height: bounds.height });
      check();
      this.requireGrant(params.session);
      if (image.data.length > 2 * 1024 * 1024) throw new Error('Screenshot exceeds the safe transport size.');
      this.frame = { id: randomUUID(), displayId, bounds, width: image.info.width, height: image.info.height,
        capturedAt: Date.now(), layout: JSON.stringify(after.displays), image: image.data.toString('base64') };
      const { layout: _layout, ...result } = this.frame;
      return result;
    } catch (error) {
      if (ac.signal.aborted) this.stop();
      if (inputAttempted) {
        this.inputActive = false;
        this.releasePending = this.adapter.release().catch(() => {});
        throw new Error(`Input may already have run; do NOT replay it. Capture to verify. ${error.message}`);
      }
      throw error;
    } finally {
      clearTimeout(deadline);
      if (this.abort === ac) this.abort = null;
      this.busy = false;
    }
  }
}
