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

export const COMPUTER_GRANT_MINUTES = 40;
export const COMPUTER_GRANT_MS = COMPUTER_GRANT_MINUTES * 60_000;

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
// Background window input validates tighter than foreground input: posted
// messages cannot carry modifier chords, and element refs must come from a
// fresh computer_uia snapshot of that same window.
export function validateElementRef(value) {
  if (typeof value !== 'string' || !/^0(\/\d{1,4}){1,40}$/.test(value) || value.length > 260) throw new Error('Element ref must be a snapshot path below the window root, like "0/3/2". Call computer_uia for a fresh one.');
  return value;
}
export function validateUiaKeys(value) {
  if (!Array.isArray(value) || value.length !== 1) throw new Error('Background key input posts exactly one key. Modifier chords need the real keyboard; focus the window and use computer_key.');
  const key = value[0];
  if (!KEYS.has(key) || ['CTRL', 'ALT', 'SHIFT', 'META'].includes(key)) throw new Error(`Background key input cannot post ${key}: single non-modifier keys only. Modifier chords need the real keyboard; focus the window and use computer_key.`);
  return [key];
}
export function validateWindowText(value) {
  if (typeof value !== 'string' || !value || value.length > 8000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) throw new Error('Text must be 1–8000 characters without control codes.');
  return value;
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
    if (op !== 'type' && op !== 'key' && op !== 'uia_value' && op !== 'uia_invoke' && op !== 'uia_key') return null;
    const id = params.operationId;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(id)) throw new Error('A unique operationId is required for targeted keyboard input. Reuse it only when retrying the exact same input.');
    if (typeof params.window !== 'string' || !params.window) throw new Error('Targeted keyboard input requires an exact window id.');
    let payload;
    if (op === 'uia_value') {
      const text = validateWindowText(params.text);
      // Posted characters cannot carry newlines or tabs: a posted ENTER
      // would submit and a posted TAB would move focus.
      if ((params.post === true || params.append === true) && /[\r\n\t]/.test(text)) throw new Error('Posted characters cannot carry newlines or tabs: a posted ENTER would submit and a posted TAB would move focus. Send single-line text, or leave post/append off so SetValue carries them.');
      payload = { element: validateElementRef(params.element), text, post: params.post === true, append: params.append === true };
    } else {
      payload = op === 'type' ? { text: validateText(params.text) }
        : op === 'key' ? { keys: validateKeys(params.keys) }
        : op === 'uia_invoke' ? { element: validateElementRef(params.element) }
        : { keys: validateUiaKeys(params.keys) };
    }
    const fingerprint = createHash('sha256').update(JSON.stringify([op, params.window, payload])).digest('hex');
    const existing = this.grant.operations.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('operationId was already used for different keyboard input. Use a new id for a new operation.');
      if (!existing.outcome) throw new Error('That keyboard operation is still running. Retry later with the SAME operationId; never submit equivalent input under a new id.');
      return { replay: { ...existing.outcome, operationId: id, replayed: true,
        message: 'Keyboard input already ran (or may have run) exactly once. Capture the window to inspect it; do not repeat under a new id.' } };
    }
    if (op === 'type' || op === 'uia_value') {
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
  /** Encode a PrintWindow capture returned by an adapter op into a
   *  window-scoped frame, shared by the background capture, focus and input
   *  ops. */
  async windowFrame(info, window, raw) {
    if (raw.png.length < 24 || raw.png.readUInt32BE(16) * raw.png.readUInt32BE(20) > 100_000_000) throw new Error('Screenshot dimensions exceed the safe limit.');
    const image = await this.encode(raw.png, { left: 0, top: 0, width: raw.png.readUInt32BE(16), height: raw.png.readUInt32BE(20) });
    if (image.data.length > 2 * 1024 * 1024) throw new Error('Screenshot exceeds the safe transport size.');
    const display = info.displays.find(item => {
      const centerX = raw.bounds.x + raw.bounds.width / 2;
      const centerY = raw.bounds.y + raw.bounds.height / 2;
      return centerX >= item.bounds.x && centerX < item.bounds.x + item.bounds.width && centerY >= item.bounds.y && centerY < item.bounds.y + item.bounds.height;
    }) ?? info.displays[0];
    this.frame = { id: randomUUID(), displayId: display.id, bounds: raw.bounds, width: image.info.width, height: image.info.height,
      capturedAt: Date.now(), layout: JSON.stringify(info.displays), image: image.data.toString('base64'), windowId: window.id, windowTitle: window.title };
    const { layout: _layout, ...result } = this.frame;
    return result;
  }

  /** Background capture of one exact window: PrintWindow renders covered or
   *  non-focused windows without touching the foreground, the cursor or the
   *  keyboard. The frame is window-scoped exactly like a focused capture. */
  async captureWindowFrame(info, params, signal) {
    const window = this.findWindow(info, params.window);
    const raw = await this.adapter.windowCapture(window.id, signal);
    const { png: _capturePng, ...captureRest } = raw;
    const result = await this.windowFrame(info, window, raw);
    return { ...captureRest, ...result };
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
    const backgroundInput = op === 'uia_value' || op === 'uia_invoke' || op === 'uia_key';
    let keyboardSpec = null;
    if (op === 'type' || op === 'key' || backgroundInput) {
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
        const allowed = this.automatic() || await this.approve({ owner, label, purpose, minutes: COMPUTER_GRANT_MINUTES }, ac.signal);
        check();
        if (!allowed) throw new Error('The person at this computer declined desktop control. Stop; do not retry by another route.');
        this.grant = { id: randomUUID(), owner, label, purpose, expiresAt: Date.now() + COMPUTER_GRANT_MS, operations: new Map() };
        this.timer = setTimeout(() => this.stop(), COMPUTER_GRANT_MS);
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
      if (op === 'window_capture') {
        if (typeof params.window !== 'string' || !params.window) throw new Error('window_capture requires an exact window id.');
        if (typeof this.adapter.windowCapture !== 'function') throw new Error('Background window capture is not supported by this desktop adapter (Windows only in this build).');
        const result = await this.captureWindowFrame(info, params, ac.signal);
        check(); this.requireGrant(params.session); return result;
      }
      if (op === 'uia') {
        if (typeof params.window !== 'string' || !params.window) throw new Error('uia requires an exact window id.');
        if (typeof this.adapter.uiaTree !== 'function') throw new Error('Background window control is not supported by this desktop adapter (Windows only in this build).');
        const window = this.findWindow(info, params.window);
        const focus = params.focus === 'interactive' ? 'interactive' : undefined;
        if (params.focus !== undefined && focus === undefined) throw new Error("uia focus must be 'interactive' when provided.");
        const tree = await this.adapter.uiaTree(window.id, focus, ac.signal);
        check(); this.requireGrant(params.session);
        return { window: window.id, title: window.title, ...tree, ...(tree.focus === true ? { focus: 'interactive' } : {}) };
      }
      if (op === 'uia_focus') {
        if (typeof params.window !== 'string' || !params.window) throw new Error('uia_focus requires an exact window id.');
        if (typeof this.adapter.uiaFocus !== 'function') throw new Error('Background window control is not supported by this desktop adapter (Windows only in this build).');
        const window = this.findWindow(info, params.window);
        validateElementRef(params.element);
        this.requireGrant(params.session); check();
        const raw = await this.adapter.uiaFocus(window.id, String(params.element), params.name === undefined ? undefined : String(params.name), ac.signal);
        const { png: _focusPng, ...focusRest } = raw;
        const result = await this.windowFrame(info, window, raw);
        check(); this.requireGrant(params.session);
        return { ...focusRest, ...result };
      }
      if (backgroundInput) {
        const method = op === 'uia_value' ? 'uiaValue' : op === 'uia_invoke' ? 'uiaInvoke' : 'uiaKey';
        if (typeof this.adapter[method] !== 'function') throw new Error('Background window control is not supported by this desktop adapter (Windows only in this build).');
        const window = this.findWindow(info, params.window);
        this.frame = null;
        this.requireGrant(params.session); check();
        // Background window input never touches the real mouse or keyboard, so
        // verify-after is a PrintWindow capture of the same window returned by
        // the adapter, not a focus-and-verify capture.
        let raw;
        try {
          raw = op === 'uia_value'
            ? await this.adapter.uiaValue(window.id, keyboardSpec.payload.element, keyboardSpec.payload.text, params.name === undefined ? undefined : String(params.name), keyboardSpec.payload.post, keyboardSpec.payload.append, ac.signal)
            : op === 'uia_invoke'
              ? await this.adapter.uiaInvoke(window.id, keyboardSpec.payload.element, params.name === undefined ? undefined : String(params.name), ac.signal)
              : await this.adapter.uiaKey(window.id, keyboardSpec.payload.keys, ac.signal);
        } catch (error) {
          // attempted === false means the native script refused BEFORE any
          // input (needs foreground, stale ref, missing pattern): the entry is
          // freed and a corrected retry is welcome. undefined means the script
          // died without a verdict (timeout/kill), which is conservatively
          // may-have-run. Either way the native error's foreground-steal
          // evidence must survive the wrap.
          if (error && error.attempted !== false) {
            inputAttempted = true;
            const wrapped = new Error(`Window action may already have run; do NOT replay it. Capture the window to verify. ${error instanceof Error ? error.message : String(error)}`);
            for (const key of ['attempted', 'foregroundBefore', 'foregroundAfter', 'foregroundStolen', 'foregroundRestored', 'foregroundChanged', 'warning', 'note']) {
              if (error[key] !== undefined) wrapped[key] = error[key];
            }
            throw wrapped;
          }
          throw error;
        }
        // The window action itself definitely ran; later failures are
        // post-input, and the reserved operationId replays this outcome.
        inputAttempted = true;
        if (keyboardEntry) keyboardEntry.outcome = { executed: true, windowId: window.id, windowTitle: window.title };
        try {
          await this.windowFrame(info, window, raw);
        } catch (error) {
          throw new Error(`The window action ran, but its verification capture failed: ${error instanceof Error ? error.message : String(error)} Do NOT replay the action; run computer_window_capture and inspect the window.`);
        }
        if (keyboardEntry) keyboardEntry.outcome = { executed: true, windowId: window.id, windowTitle: window.title, capturedAt: this.frame.capturedAt };
        check(); this.requireGrant(params.session);
        const { layout: _backgroundLayout, ...result } = this.frame;
        const { png: _inputPng, ...inputRest } = raw;
        return { ...inputRest, ...result, operationId: keyboardSpec.id };
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
      // The native layer explicitly reported a refusal BEFORE any input ran
      // (the person-activity guard, a validation refusal): never poison the
      // reserved operationId as may-have-run, and never run the release
      // keystrokes (release injects real input — actively harmful while the
      // person is working). A corrected retry with the same id is welcome.
      if (inputAttempted && error && error.attempted === false) {
        inputAttempted = false;
        this.inputActive = false;
      }
      if (keyboardEntry) {
        if (inputAttempted) keyboardEntry.outcome ??= { executed: 'unknown', windowId: params.window,
          message: `Keyboard input may already have run. Do not repeat it under a new operationId. ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000) };
        else keyboardGrant?.operations.delete(keyboardSpec.id);
      }
      if (ac.signal.aborted) this.stop();
      // Background window input never touches the real mouse or keyboard, so a
      // possibly-run failure must not inject release keystrokes either.
      if (inputAttempted && !backgroundInput) {
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
