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

const ACTIONS = new Set(['move', 'click', 'double_click', 'right_click', 'drag', 'scroll']);
export const KEYS = new Set(['CTRL', 'ALT', 'SHIFT', 'META', 'ENTER', 'TAB', 'ESC', 'BACKSPACE', 'DELETE', 'SPACE', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'HOME', 'END', 'PAGEUP', 'PAGEDOWN', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)]);
export function validateText(value) {
  if (typeof value !== 'string' || !value || value.length > 2000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) throw new Error('Text must be 1–2000 characters without control codes.');
  return value;
}
export function validateKeys(value) {
  if (!Array.isArray(value) || !value.length || value.length > 5 || value.some(k => !KEYS.has(k))) throw new Error('Invalid keys; use 1–5 named uppercase keys.');
  return [...new Set(value)];
}
export function validateAction(input, frame) {
  if (!input || !ACTIONS.has(input.action)) throw new Error('Unknown mouse action. Use computer_type/computer_key for keyboard input and computer_focus for focus.');
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
  keyboardOperation(op, params) {
    if (op !== 'type' && op !== 'key') return null;
    const id = params.operationId;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(id)) throw new Error('A unique operationId is required for targeted keyboard input. Reuse it only when retrying the exact same input.');
    if (typeof params.window !== 'string' || !params.window) throw new Error('Targeted keyboard input requires an exact window id.');
    const payload = op === 'type' ? { text: validateText(params.text) } : { keys: validateKeys(params.keys) };
    const fingerprint = createHash('sha256').update(JSON.stringify([op, params.window, payload])).digest('hex');
    const existing = this.grant.operations.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('operationId was already used for different keyboard input. Use a new id for a new operation.');
      if (!existing.outcome) throw new Error('That keyboard operation is still running. Retry later with the SAME operationId; never submit equivalent input under a new id.');
      return { replay: { ...existing.outcome, operationId: id, replayed: true,
        message: 'Keyboard input already ran (or may have run) exactly once. Capture the window to inspect it; do not repeat under a new id.' } };
    }
    if (op === 'type') {
      // Models sometimes disregard the same-id retry contract when they cannot
      // visually read a terminal. Exact text to the exact same window must not
      // duplicate merely because they invented a second id.
      const duplicate = [...this.grant.operations.entries()].find(([, entry]) => entry.fingerprint === fingerprint);
      if (duplicate) {
        if (!duplicate[1].outcome) throw new Error(`Identical text is already being typed under operationId ${duplicate[0]}. Do not send it again.`);
        return { replay: { ...duplicate[1].outcome, operationId: id, matchedOperationId: duplicate[0], replayed: true,
          message: 'Identical text was already typed once in this window. It was not typed again. Inspect OCR/window state; do not invent another retry id.' } };
      }
    }
    return { id, fingerprint, payload };
  }
  findWindow(info, id) {
    const window = typeof id === 'string' ? info.windows.find(item => item.id === id) : undefined;
    if (!window) throw new Error('Window is no longer available. Inspect windows again; do not guess its id or coordinates.');
    return window;
  }
  async captureFrame(info, params, signal) {
    if (params.window && params.display) throw new Error('Choose either a window or a display, not both.');
    let current = info;
    let window = params.window ? this.findWindow(current, params.window) : null;
    // A full-desktop crop can only represent the named window if that exact
    // window is raised and active. Focus first, then re-read its geometry; do
    // not label overlapping pixels from another app as the target window.
    if (window && current.activeWindow !== window.id) {
      await this.adapter.act({ action: 'focus', window: window.id }, signal);
      current = await this.adapter.inspect(signal);
      window = this.findWindow(current, params.window);
      if (current.activeWindow !== window.id) throw new Error('Window could not be verified active. No screenshot was returned.');
    }
    const display = window
      ? current.displays.find(item => {
          const centerX = window.bounds.x + window.bounds.width / 2;
          const centerY = window.bounds.y + window.bounds.height / 2;
          return centerX >= item.bounds.x && centerX < item.bounds.x + item.bounds.width && centerY >= item.bounds.y && centerY < item.bounds.y + item.bounds.height;
        }) ?? current.displays[0]
      : current.displays.find(item => item.id === (params.display ?? current.displays[0]?.id));
    if (!display) throw new Error('Display unavailable. Inspect displays again.');
    const bounds = window?.bounds ?? display.bounds;
    const raw = await this.adapter.capture(signal);
    if (raw.png.length < 24 || raw.png.readUInt32BE(16) * raw.png.readUInt32BE(20) > 100_000_000) throw new Error('Screenshot dimensions exceed the safe limit.');
    const region = { left: bounds.x - raw.bounds.x, top: bounds.y - raw.bounds.y, width: bounds.width, height: bounds.height };
    if (region.left < 0 || region.top < 0 || region.left + region.width > raw.bounds.width || region.top + region.height > raw.bounds.height) {
      throw new Error('The selected window is partly outside the captured desktop. Move it fully on-screen and inspect again.');
    }
    if (window) {
      const verified = await this.adapter.inspect(signal);
      const finalWindow = this.findWindow(verified, window.id);
      if (verified.activeWindow !== window.id || JSON.stringify(finalWindow.bounds) !== JSON.stringify(bounds)) {
        throw new Error('Window focus or geometry changed while capturing. Pixels were discarded; inspect and capture again.');
      }
    }
    const image = await this.encode(raw.png, region);
    if (image.data.length > 2 * 1024 * 1024) throw new Error('Screenshot exceeds the safe transport size.');
    this.frame = { id: randomUUID(), displayId: display.id, bounds, width: image.info.width, height: image.info.height,
      capturedAt: Date.now(), layout: JSON.stringify(current.displays), image: image.data.toString('base64'),
      ...(window ? { windowId: window.id, windowTitle: window.title } : {}) };
    const { layout: _layout, ...result } = this.frame;
    return result;
  }
  async handle(op, params = {}) {
    // MCP keyboard tools tunnel through computer.act during a rolling server
    // upgrade, so a new device/script can work while old in-memory routes
    // drain healthy turns. The operation still uses every targeted guard.
    if (op === 'act' && (params.operation === 'focus' || params.operation === 'type' || params.operation === 'key')) op = params.operation;
    if (op === 'end') { this.requireGrant(params.session); this.stop(); return { stopped: true }; }
    if (op === 'stop') { this.stop(true); return { stopped: true, paused: this.paused }; }
    if (op === 'resume') { if (this.paused) { this.paused = false; this.changed(this.status()); } return { resumed: true }; }
    if (this.paused) throw new Error('Computer control is paused by the user. Do not retry, resume it yourself, or change permissions. The operator can use Resume control.');
    if (op === 'preview') {
      if (!this.grant || Date.now() >= this.grant.expiresAt || !this.frame) throw new Error('No active screen preview.');
      const { image, width, height, capturedAt, displayId, windowId, windowTitle } = this.frame;
      return { image, width, height, capturedAt, displayId, windowId, windowTitle };
    }
    if (!this.capability.supported) throw new Error(this.capability.reason);
    const limit = op === 'start' ? 60_000 : 30_000;
    const remaining = params.deadlineAt === undefined ? limit : Number(params.deadlineAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > limit + 5000) throw new Error('Desktop request expired or machine clocks differ. No action taken.');
    let keyboardSpec = null;
    if (op === 'type' || op === 'key') {
      this.requireGrant(params.session);
      keyboardSpec = this.keyboardOperation(op, params);
      if (keyboardSpec.replay) return keyboardSpec.replay;
    }
    if (this.busy) throw new Error('This desktop is already handling a request. Do not replay input.');
    let keyboardEntry = null;
    let keyboardGrant = null;
    if (keyboardSpec) {
      if (this.grant.operations.size >= 256) throw new Error('This desktop grant reached its keyboard-operation limit. Start a new grant; do not replay uncertain input.');
      keyboardEntry = { fingerprint: keyboardSpec.fingerprint };
      keyboardGrant = this.grant;
      keyboardGrant.operations.set(keyboardSpec.id, keyboardEntry); // reserve synchronously, before any await
    }
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
        this.grant = { id: randomUUID(), owner, label, purpose, expiresAt: Date.now() + 5 * 60_000, operations: new Map() };
        this.timer = setTimeout(() => this.stop(), 5 * 60_000);
        this.timer.unref?.();
        this.changed(this.status());
        return { session: this.grant.id, ...this.status() };
      }
      this.requireGrant(params.session);
      const info = await this.adapter.inspect(ac.signal);
      check();
      if (op === 'inspect') return info;
      if (op === 'capture') {
        const result = await this.captureFrame(info, params, ac.signal);
        check(); this.requireGrant(params.session); return result;
      }
      if (op === 'focus' || op === 'type' || op === 'key') {
        const window = this.findWindow(info, params.window);
        const action = op === 'focus' ? { action: 'focus', window: window.id }
          : op === 'type' ? { action: 'type', window: window.id, text: keyboardSpec.payload.text }
          : { action: 'key', window: window.id, keys: keyboardSpec.payload.keys };
        this.frame = null;
        this.requireGrant(params.session); check();
        inputAttempted = op !== 'focus';
        this.inputActive = inputAttempted;
        await this.adapter.act(action, ac.signal);
        this.inputActive = false;
        if (keyboardEntry) keyboardEntry.outcome = { executed: true, windowId: window.id, windowTitle: window.title };
        check();
        const after = await this.adapter.inspect(ac.signal);
        const result = await this.captureFrame(after, { window: window.id }, ac.signal);
        check(); this.requireGrant(params.session);
        if (keyboardEntry) {
          keyboardEntry.outcome = { ...keyboardEntry.outcome, capturedAt: result.capturedAt };
          return { ...result, operationId: keyboardSpec.id };
        }
        return result;
      }
      if (op !== 'act') throw new Error('Unknown desktop operation.');
      const f = this.frame;
      const maxAge = f?.windowId ? 90_000 : 30_000;
      if (!f || f.id !== params.frame || Date.now() - f.capturedAt > maxAge || f.layout !== JSON.stringify(info.displays)) throw new Error('Screenshot is stale or displays changed. Capture again before acting.');
      if (f.windowId) {
        const current = this.findWindow(info, f.windowId);
        if (JSON.stringify(current.bounds) !== JSON.stringify(f.bounds)) throw new Error('Window moved or resized. Capture that window again before acting.');
      }
      const action = validateAction(params, f);
      if (f.windowId) { action.window = f.windowId; action.windowBounds = f.bounds; }
      this.frame = null; // Consume BEFORE input, including uncertain failures.
      this.requireGrant(params.session); check();
      inputAttempted = true;
      this.inputActive = true;
      await this.adapter.act(action, ac.signal);
      this.inputActive = false;
      check();
      const after = await this.adapter.inspect(ac.signal);
      const result = await this.captureFrame(after, f.windowId ? { window: f.windowId } : { display: f.displayId }, ac.signal);
      check(); this.requireGrant(params.session); return result;
    } catch (error) {
      if (keyboardEntry) {
        if (inputAttempted) keyboardEntry.outcome ??= { executed: 'unknown', windowId: params.window,
          message: `Keyboard input may already have run. Do not repeat it under a new operationId. ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000) };
        else keyboardGrant?.operations.delete(keyboardSpec.id);
      }
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
