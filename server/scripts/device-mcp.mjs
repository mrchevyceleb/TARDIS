#!/usr/bin/env node

/**
 * rivendell-device MCP — the user's own computers, reachable from a turn.
 *
 * A tiny stdio MCP server (no deps) fronting TARDIS's /api/devices surface on
 * localhost. A computer appears here only while its TARDIS desktop app is
 * open, and that app asks its user before running anything, so a refusal is a
 * normal answer, not an error to route around.
 *
 * Tools:
 *   device_list  — which computers are linked right now
 *   device_exec  — run a shell command there
 *   device_read  — read a file there
 *   device_write — write a file there
 *   device_ls    — list a folder there
 *   device_open  — open a file or folder in its default app
 *
 * A linked robot body (the TARDIS robot companion, kind:'robot') rides on the
 * same link and fronts /api/robots:
 *   robot_list, robot_status, robot_say, robot_express, robot_eyes, robot_leds,
 *   robot_move, robot_arms, robot_look, robot_sensors, robot_events, robot_stop
 */

import { createInterface } from 'node:readline';

const BASE = process.env.RIVENDELL_TEAM_URL || 'http://127.0.0.1:8091';

const DEVICE_ARG = {
  type: 'string',
  description: 'Which computer, by name or id. Omit when only one is linked.',
};

const COMPUTER_ARGS = {
  device: { type: 'string', description: 'Exact online computer id. On computer_start only, omit to use the chat selection or operator-configured default. Other tools use the device returned by computer_start. Never infer a fallback.' },
  session: { type: 'string', description: 'The grant returned by computer_start for this task and device.' },
};
const computerTool = (name, description, properties, required) => ({ name, description,
  inputSchema: { type: 'object', properties: { ...COMPUTER_ARGS, ...properties }, required: [...(name === 'computer_start' ? [] : ['device']), ...required], additionalProperties: false } });
const TOOLS = [
  computerTool('computer_start', 'Acquire a forty-minute desktop lease. On automatic-mode computers this happens without a popup: do it yourself for the assigned task, with no permission chatter. Omit device for the selected/default desktop. The result includes device and session for subsequent tools. Other computers may retain native consent. GUI control is broad trust, not a sandbox. Never bypass a pause/refusal or switch machines implicitly. Use the signed context from your current turn.', {
    context: { type: 'string', description: 'Current turn computer context, supplied by TARDIS in the prompt.' },
    purpose: { type: 'string', description: 'The assigned task, shown in control status (max 500 characters).'  },
  }, ['context', 'purpose']),
  computerTool('computer_inspect', 'List monitors, accurately measured native windows, and the active window. Use the exact window id for focused capture and keyboard tools.', {}, ['session']),
  computerTool('computer_capture', 'See one exact native window (preferred) or a whole display. Window capture first raises and verifies that target, then returns a readable, window-relative JPEG and one-use frame: coordinates are pixels in THAT image. Use a window capture before clicking inside an app. Whole-display frames expire after 30 seconds; window frames after 90 seconds. If your model cannot see image results, use computer_step.', {
    display: { type: 'string', description: 'Monitor id from computer_inspect (default when window omitted).' },
    window: { type: 'string', description: 'Preferred: exact window id from computer_inspect. Mutually exclusive with display.' },
  }, ['session']),
  computerTool('computer_focus', 'Activate one exact window, verify the OS really focused it, and return a window-only screenshot. For terminals and Pi TUIs, follow this with computer_type directly—do NOT guess/click the prompt line.', {
    window: { type: 'string', description: 'Exact window id from computer_inspect.' },
  }, ['session', 'window']),
  computerTool('computer_type', 'Reliably type ONCE into an exact native window: reserve operationId, activate/verify the window, type, re-verify focus, and return its screenshot. For a terminal/Pi TUI use this directly after computer_focus, never coordinate clicks. This does NOT press Enter. Result metadata includes local OCR when available; use it with the screenshot to verify text. If a reply is lost, retry the SAME operationId. Even an invented second id with identical window/text is deduplicated within the grant.', {
    operationId: { type: 'string', maxLength: 100, description: 'Unique within this grant, e.g. pi-checkin-text-1. Reuse only to retry this exact same window/text.' },
    window: { type: 'string', description: 'Exact window id from computer_inspect.' },
    text: { type: 'string', maxLength: 2000 },
  }, ['session', 'operationId', 'window', 'text']),
  computerTool('computer_key', 'Send one named key/chord ONCE to an exact verified active window, re-verify focus, then return its screenshot. Use ENTER after computer_type only when its screenshot/OCR proves the text is correct. If a reply is lost, retry the SAME operationId; never resend Enter under a new id.', {
    operationId: { type: 'string', maxLength: 100, description: 'Unique within this grant, e.g. pi-checkin-submit-1. Reuse only to retry this exact same window/chord.' },
    window: { type: 'string', description: 'Exact window id from computer_inspect.' },
    keys: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' }, description: 'Uppercase keys: CTRL,ALT,SHIFT,META,ENTER,TAB,ESC,SPACE,BACKSPACE,DELETE,arrows,HOME,END,PAGEUP,PAGEDOWN,A-Z,0-9,F1-F12.' },
  }, ['session', 'operationId', 'window', 'keys']),
  computerTool('computer_act', 'Perform ONE mouse action against the supplied one-use screenshot and return the same display/window region. Window-scoped frames are strongly preferred: the device focuses that window and prevents coordinates from landing in another app. Never replay uncertain input.', {
    frame: { type: 'string' }, action: { type: 'string', enum: ['move', 'click', 'double_click', 'right_click', 'drag', 'scroll'] },
    x: { type: 'integer' }, y: { type: 'integer' }, toX: { type: 'integer' }, toY: { type: 'integer' },
    direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'integer', minimum: 1, maximum: 10 },
  }, ['session', 'frame', 'action']),
  computerTool('computer_step', 'For text-only engines: a local vision model sees a fresh screenshot, grounds at most ONE small action, and describes the result as text. Use a unique stepId for each new step and reuse that SAME id on retries; cached outcomes prevent duplicate input after a lost reply. Never retry an uncertain operation with a new id. Normal navigation and authorized sign-in are allowed; external sends, purchases, deletes and terminal commands are not delegated to this vision helper.', {
    stepId: { type: 'string', maxLength: 100, description: 'Unique within this grant, e.g. dashboard-open-1. Reuse for retries of the same goal, never for a different step.' },
    goal: { type: 'string', maxLength: 1500, description: 'One small next step within the authorized task, or ask what is visible.' },
    display: { type: 'string', description: 'Display id; omit when window is provided.' },
    window: { type: 'string', description: 'Preferred exact window id for readable, window-relative grounding.' },
  }, ['session', 'stepId', 'goal']),
  computerTool('computer_stop', 'Release your desktop grant and cancel input. Always call when the task ends.', {}, ['session']),
  {
    name: 'device_list',
    description:
      "List the user's computers that are linked right now, with their platform and the folder each one keeps its workspace copy in. " +
      'A computer is reachable through its running TARDIS desktop app or host companion. Call this first when the user asks for something on "my PC", "my laptop", or "this machine". ' +
      'Pass the id rather than the name when two machines share a name.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'device_exec',
    description:
      "Run a shell command on the user's computer (PowerShell on Windows, the login shell elsewhere) and return its exit code, stdout, and stderr. " +
      'The user is asked to approve on that machine, so a denial is a legitimate outcome: report it and stop rather than retrying or rephrasing the command. ' +
      'Prefer one clear command over a chain, and never use it to work around a refusal.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run' },
        cwd: { type: 'string', description: 'Working directory on that machine (default: the home folder)' },
        device: DEVICE_ARG,
        timeoutMs: { type: 'number', description: 'How long to allow, in ms (default 60000, max 600000)' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'device_read',
    description:
      "Read a text file from the user's computer by absolute path (or a path relative to that machine's workspace copy). " +
      'Files inside the workspace are read without a prompt; anything else asks the user first. Credential stores are always refused.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path on that machine, or workspace-relative' },
        device: DEVICE_ARG,
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'device_write',
    description:
      "Write a text file on the user's computer. Overwrites the file at that path. Outside the workspace copy the user is asked first.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path on that machine, or workspace-relative' },
        content: { type: 'string', description: 'The full new contents' },
        device: DEVICE_ARG,
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'device_ls',
    description: "List a folder on the user's computer: names, whether each entry is a folder, size, and modified time.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path on that machine, or workspace-relative' },
        device: DEVICE_ARG,
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'device_open',
    description:
      "Open a file or folder on the user's computer in whatever app they normally use for it. Use this to put something in front of the user rather than describing where it is.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path on that machine, or workspace-relative' },
        device: DEVICE_ARG,
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

const ROBOT_ARG = { type: 'string', description: 'Which robot, by name or id. Omit when only one is linked.' };
const SIDE_ARG = { type: 'string', enum: ['both', 'left', 'right'], description: 'Which side (default both).' };
const ROBOT_EXPRESSIONS = ['ADMIRING', 'AGGRAVATED', 'ANNOYED', 'ANXIOUS', 'ATTENTION', 'ATTENTION LEFT', 'ATTENTION RIGHT', 'AWAKE L', 'AWAKE R', 'BATTERY LOW', 'BLINK', 'BLINK BIG', 'BLINK L', 'BLINK ONLY', 'BLINK R', 'BLINK SLOW', 'BLUE', 'BUGGED', 'BUMP', 'BURNED UP', 'CAUTIOUS', 'CAUTIOUS DOWN', 'CAUTIOUS DOWN LEFT', 'CAUTIOUS DOWN RIGHT', 'CAUTIOUS LEFT', 'CAUTIOUS RIGHT', 'CAUTIOUS UP', 'CHAOTIC', 'CHEERFUL', 'COLOR CHANGE', 'CONCENTRATE', 'CONFUSED', 'CRAZY ABOUT', 'CRUSHED', 'CYCLOPS L', 'CYCLOPS R', 'DAMAGED', 'DEJECTED', 'DELIGHTED', 'DEMORALIZED', 'DEPRESSED', 'DESTROYED', 'DISAPPOINTED', 'DISCOVER', 'DIZZY L', 'DIZZY R', 'DOWN', 'DROP CENTER', 'DROWSY', 'ELEVATED I', 'ELEVATED O', 'EMPTY', 'EXCITED', 'FED UP', 'FINE', 'FIREMAN', 'FLAME', 'FOCUS', 'FRIGHTENED', 'FRUSTRATED', 'FUMING L', 'FUMING R', 'FURIOUS', 'GET BIGGER', 'GET SMALLER', 'HAPPY', 'HEARTS', 'HEATED', 'HOPELESS', 'HOSTILE', 'IMPACT F', 'IMPACT L', 'IMPACT R', 'IMPATIENT', 'INJURED', 'IRRITATED', 'JEALOUS L', 'JEALOUS R', 'LEFT', 'LIDS DOWN 5S', 'LOOK AHEAD', 'LOOK AHEAD SLOW', 'LOOK DOWN', 'LOOK DOWN L', 'LOOK DOWN R', 'LOOK LEFT', 'LOOK RIGHT', 'LOOK UP', 'LOOK UP L', 'LOOK UP R', 'LOW', 'LOW LONG', 'MELANCHOLY', 'MID DOWN', 'MID UP', 'MID UP L', 'MID UP R', 'MIXED UP', 'MOODY LR', 'MOODY RL', 'NERVOUS', 'OFFENDED', 'OUTRAGED', 'OVERJOYED', 'PANICKY', 'PASSIONATE', 'PHOTO', 'POLICE', 'PUMPKIN', 'PUZZLED', 'RIGHT', 'ROLL UD', 'SCAN', 'SHAKE FRONT', 'SHAKE LR', 'SHAKE UD', 'SHOCKED', 'SHY', 'SLEEP', 'SLEEPY', 'SNEEZE', 'SPARKLING', 'SQUINT RL', 'STORMING', 'SUNGLASS', 'SUNGLASS LR', 'SUNGLASS UPR', 'THINK', 'THREATENED L', 'THREATENED R', 'THRILLED', 'THROWN', 'TIRED', 'TROUBLED', 'TURNED ON', 'UNCOMFORTABLE', 'UNHAPPY', 'UPSET', 'VR', 'WAKE WORD', 'WORKOUT', 'ZOOM IN'];
const ROBOT_COLORS = ['BLACK', 'WHITE', 'GRAY', 'SALMON', 'RED', 'DARK_RED', 'PINK', 'ORANGE', 'GOLD', 'YELLOW', 'PURPLE', 'MAGENTA', 'LIME', 'GREEN', 'DARK_GREEN', 'CYAN', 'SKY_BLUE', 'BLUE', 'DARK_BLUE', 'BROWN'];
const robotTool = (name, description, properties = {}, required = []) => ({ name, description,
  inputSchema: { type: 'object', properties: { robot: ROBOT_ARG, ...properties }, required, additionalProperties: false } });
const ROBOT_TOOLS = [
  robotTool('robot_list', 'List the physical robot bodies linked right now with battery, voice state and last expression. A robot is reachable while its TARDIS robot companion is running. Call this first when the user mentions the robot by name or asks it to do something in the room.'),
  robotTool('robot_status', 'Fresh status from one robot: battery, charging, current expression, whether it is moving, voice session state, and any hardware errors.'),
  robotTool('robot_say', "Speak text aloud from the robot's own speaker using its on-board voice, optionally with an eye animation at the same time. Do NOT use this during a live voice call: your spoken reply already plays there. Plain spoken prose only, up to 600 characters.", {
    text: { type: 'string', maxLength: 600 },
    expression: { type: 'string', enum: ROBOT_EXPRESSIONS, description: 'Optional eye animation to play while speaking.' },
  }, ['text']),
  robotTool('robot_express', 'Play one eye animation on the robot, e.g. HAPPY, THINK, PUZZLED, CAUTIOUS, EXCITED, SLEEPY, LOOK LEFT. Use it to react in the room; one per reply is plenty.', {
    expression: { type: 'string', enum: ROBOT_EXPRESSIONS },
    wait: { type: 'boolean', description: 'Wait for the animation to finish before returning (default false).' },
  }, ['expression']),
  robotTool('robot_eyes', 'Set the resting eye look: iris colour, background colour and iris shape.', {
    color: { type: 'string', enum: ROBOT_COLORS }, background: { type: 'string', enum: ROBOT_COLORS },
    shape: { type: 'string', enum: ['CLASSIC', 'MODERN', 'SPACE', 'ORBIT', 'GLOW', 'DIGI'] }, side: SIDE_ARG,
  }),
  robotTool('robot_leds', "Set the robot's body lights to a colour, optionally fading to a second colour over fadeMs.", {
    color: { type: 'string', enum: ROBOT_COLORS }, fadeTo: { type: 'string', enum: ROBOT_COLORS },
    fadeMs: { type: 'integer', minimum: 0, maximum: 10000 }, side: SIDE_ARG,
  }, ['color']),
  robotTool('robot_move', 'Drive straight by distanceMm (negative = backwards, max 1000) or turn by degrees (positive = counter-clockwise, max 360). Give one or the other. Needs standing motion authorization from the server operator (a 403 means it is off; do not work around it). The robot refuses to drive off an edge and stops on obstacles; keep moves small on a desk.', {
    distanceMm: { type: 'integer', minimum: -1000, maximum: 1000 }, degrees: { type: 'integer', minimum: -360, maximum: 360 },
    speed: { type: 'integer', minimum: 1, maximum: 100, description: 'Percent (default 40).' },
  }),
  robotTool('robot_arms', "Move the robot's arms to an angle in degrees (0 = down, up to 180) at a speed percent. Needs the operator's standing motion authorization on the server (a 403 means it is off).", {
    angle: { type: 'integer', minimum: 0, maximum: 180 }, speed: { type: 'integer', minimum: 1, maximum: 100 }, side: SIDE_ARG,
  }, ['angle']),
  robotTool('robot_look', "Take a photo with the robot's camera and return it as an image you can look at. Use when asked what the robot can see or to check on something in the room.", {
    width: { type: 'integer', minimum: 160, maximum: 1920, description: 'Longest side in pixels (default 960).' },
  }),
  robotTool('robot_sensors', "Read the robot's sensors now: touch pads, left/right distance in mm, edge/cliff detectors, IMU orientation, battery."),
  robotTool('robot_events', 'What the robot noticed recently: touches, gestures, being picked up, edges, obstacles, low battery, voice summons. Use since to page past a seq you already handled.', {
    since: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
    names: { type: 'array', items: { type: 'string' }, description: 'Filter to these event names.' },
  }),
  robotTool('robot_stop', 'Immediately stop all robot motion (wheels and arms). Always safe to call.'),
];
TOOLS.push(...ROBOT_TOOLS);

async function api(path, init, signal) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    signal,
    headers: { 'Content-Type': 'application/json', 'x-rivendell-computer-token': process.env.RIVENDELL_COMPUTER_MCP_TOKEN || '', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) throw new Error(body?.error || text || `${res.status} ${res.statusText}`);
  return body;
}

function post(op, args, signal) {
  return api(`/api/devices/${op}`, { method: 'POST', body: JSON.stringify(args) }, signal);
}

function describeDevice(device) {
  return `- ${device.name} (${device.id}) — ${device.platform}${device.workspaceRoot ? ` · workspace at ${device.workspaceRoot}` : ''} · desktop: ${device.computer?.supported ? (device.computer.paused ? 'PAUSED by user — do not resume yourself' : device.computer.control ? `in use by ${device.computer.control.label}` : device.computer.approvalMode === 'automatic' ? 'AUTOMATIC — acquire and work without asking permission' : 'native consent required') : device.computer?.reason || 'not supported by this client'}`;
}

function describeRobot(robot) {
  const s = robot.robot ?? {};
  const bits = [
    s.battery !== undefined ? `battery ${s.battery}%${s.charging ? ' (charging)' : ''}` : null,
    s.voice && s.voice !== 'off' ? `voice ${s.voice}` : null,
    s.expression ? `expression ${s.expression}` : null,
    s.moving ? 'moving' : null,
    s.hardware ? s.hardware : null,
    s.errors?.length ? `errors: ${s.errors.join('; ')}` : null,
  ].filter(Boolean).join(' \u00b7 ');
  return `- ${robot.name} (${robot.id})${bits ? ` \u2014 ${bits}` : ''}`;
}

function clip(text, limit) {
  if (typeof text !== 'string' || text.length <= limit) return text ?? '';
  return `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`;
}

async function callTool(name, args, signal) {
  if (name.startsWith('computer_')) {
    const op = name.slice('computer_'.length);
    if (!['start', 'inspect', 'capture', 'focus', 'type', 'key', 'act', 'step', 'stop'].includes(op)) throw new Error('Unknown computer tool.');
    // Keyboard/focus tools tunnel through the long-standing /act route so
    // devices can roll forward before a busy TARDIS server safely restarts.
    const compatibilityOp = op === 'focus' || op === 'type' || op === 'key';
    const result = await post(`computer/${compatibilityOp ? 'act' : op}`, compatibilityOp ? { ...args, operation: op } : args, signal);
    if (typeof result.image === 'string') {
      const { image, ...metadata } = result;
      return [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', data: image, mimeType: 'image/jpeg' }];
    }
    return JSON.stringify(result);
  }
  if (name.startsWith('robot_')) {
    const op = name.slice('robot_'.length);
    const body = { robot: args.robot };
    if (op === 'list') {
      const { robots, eventAgent, motionAllowed } = await api('/api/robots', undefined, signal);
      if (!robots?.length) return 'No robot is linked right now. Start the TARDIS robot companion on the robot to make it reachable.';
      return `Linked robots (${robots.length}):\n${robots.map(describeRobot).join('\n')}\nMotion (robot_move/robot_arms): ${motionAllowed ? 'authorized by the operator' : 'DISABLED by operator policy'}.${eventAgent ? `\nNotable robot events are handed to ${eventAgent}.` : ''}`;
    }
    if (op === 'events') {
      const q = new URLSearchParams();
      if (args.robot) q.set('robot', args.robot);
      if (args.since) q.set('since', String(args.since));
      if (args.limit) q.set('limit', String(args.limit));
      if (Array.isArray(args.names) && args.names.length) q.set('names', args.names.join(','));
      const { events, latestEventSeq } = await api(`/api/robots/events?${q}`, undefined, signal);
      if (!events?.length) return `No robot events yet (latest seq ${latestEventSeq}).`;
      return `${events.map((e) => `#${e.seq} ${new Date(e.ts).toLocaleTimeString()} ${e.robotName}: ${e.name}${Object.keys(e.data ?? {}).length ? ` ${JSON.stringify(e.data)}` : ''}`).join('\n')}\n(latest seq ${latestEventSeq})`;
    }
    if (op === 'move') {
      const hasDistance = args.distanceMm !== undefined && args.distanceMm !== null;
      const hasDegrees = args.degrees !== undefined && args.degrees !== null;
      if (hasDistance === hasDegrees) throw new Error('Give exactly one of distanceMm or degrees.');
      const result = hasDistance
        ? await api('/api/robots/drive', { method: 'POST', body: JSON.stringify({ ...body, distanceMm: args.distanceMm, speed: args.speed }) }, signal)
        : await api('/api/robots/turn', { method: 'POST', body: JSON.stringify({ ...body, degrees: args.degrees, speed: args.speed }) }, signal);
      return JSON.stringify(result);
    }
    const { robot: _robot, ...params } = args;
    const result = await api(`/api/robots/${op}`, { method: 'POST', body: JSON.stringify({ ...body, ...params }) }, signal);
    if (op === 'look' && typeof result.image === 'string') {
      const { image, ...metadata } = result;
      return [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', data: image, mimeType: 'image/jpeg' }];
    }
    return JSON.stringify(result);
  }
  if (name === 'device_list') {
    const { devices, defaultDevice } = await api('/api/devices', undefined, signal);
    if (!devices?.length) {
      return 'No computer is linked right now. The user opens the TARDIS desktop app on a machine to make it reachable.';
    }
    return `${defaultDevice ? `Default desktop: ${defaultDevice.name} (${defaultDevice.id})${defaultDevice.online ? '' : ' — offline/ambiguous; never fall back'}\n` : ''}Linked computers (${devices.length}):\n${devices.map(describeDevice).join('\n')}`;
  }

  if (name === 'device_exec') {
    const result = await post('exec', {
      device: args.device,
      command: args.command,
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
    }, signal);
    const lines = [`exit ${result.code}${result.timedOut ? ' (timed out)' : ''}`];
    if (result.stdout) lines.push(`stdout:\n${clip(result.stdout, 20000)}`);
    if (result.stderr) lines.push(`stderr:\n${clip(result.stderr, 8000)}`);
    if (!result.stdout && !result.stderr) lines.push('(no output)');
    return lines.join('\n\n');
  }

  if (name === 'device_read') {
    const result = await post('read', { device: args.device, path: args.path }, signal);
    return `${result.path} (${result.size} bytes)\n\n${clip(result.content, 60000)}`;
  }

  if (name === 'device_write') {
    const result = await post('write', { device: args.device, path: args.path, content: args.content }, signal);
    return `Wrote ${result.path} (${result.size} bytes).`;
  }

  if (name === 'device_ls') {
    const result = await post('ls', { device: args.device, path: args.path }, signal);
    if (!result.entries?.length) return `${result.path} is empty.`;
    const rows = result.entries.map((entry) => `${entry.type === 'directory' ? 'dir ' : 'file'}  ${entry.name}${entry.type === 'file' ? `  ${entry.size} bytes` : ''}`);
    return `${result.path}\n${rows.join('\n')}`;
  }

  if (name === 'device_open') {
    const result = await post('open', { device: args.device, path: args.path }, signal);
    return `Opened ${result.path}.`;
  }

  throw new Error(`unknown tool: ${name}`);
}

// --- stdio JSON-RPC (MCP) ----------------------------------------------------

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const activeCalls = new Map();

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'rivendell-device', version: '1.0.0' } } });
    } else if (method === 'notifications/initialized') {
      // no-op
    } else if (method === 'notifications/cancelled') {
      const requestId = params?.requestId;
      activeCalls.get(requestId)?.abort();
      activeCalls.delete(requestId);
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      const controller = new AbortController();
      activeCalls.set(id, controller);
      try {
        const out = await callTool(params.name, params.arguments ?? {}, controller.signal);
        if (!controller.signal.aborted) {
          send({ jsonrpc: '2.0', id, result: { content: Array.isArray(out) ? out : [{ type: 'text', text: String(out) }] } });
        }
      } catch (e) {
        if (!controller.signal.aborted) throw e;
      } finally {
        activeCalls.delete(id);
      }
    } else if (method && id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `ERROR: ${e.message}` }], isError: true } });
  }
});

process.on('SIGTERM', () => process.exit(0));
