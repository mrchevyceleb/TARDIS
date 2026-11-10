import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { GrokChatProps } from '../src/grok/GrokChat.tsx';
import type { Agent } from '../src/grok/agents.ts';
import type { useCompanionPicker } from '../src/chat/hooks/useCompanionPicker.ts';

// Render the real chat host and picker hooks without a transport or a browser.
// Catalog modules load before window exists, so tests cannot call a live API.
const agents = await import('../src/grok/agents.ts');
await import('../src/chat/hooks/useCompanionPicker.ts');
const save = mock.fn<typeof agents.updateAgentReq>();
const confirm = mock.fn<(message: string) => boolean>(() => true);
const chat = { status: 'idle', serverBrain: null as null | {
  cli: string; model?: string; effort?: string; serviceTier?: string; revision: number;
}, reconnect: () => {} };
let picker: ReturnType<typeof useCompanionPicker> & { selectionError?: string | null };
mock.module('../src/grok/agents.ts', { namedExports: {
  AgentUpdateConflictError: agents.AgentUpdateConflictError,
  updateAgentReq: save,
  markAgentRead: async () => {},
} });
mock.module('../src/chat/hooks/useChat.ts', { namedExports: { useChat: () => chat } });
mock.module('../src/chat/components/reimagine/useChatShell.ts', { namedExports: { useChatShell: () => ({}) } });
mock.module('../src/shell/studio/ChatTab.tsx', { namedExports: { companionAgentLabel: () => 'Teammate' } });
mock.module('../src/chat/utils/userPresence.ts', { namedExports: {
  userPresent: () => false, onPresenceChange: () => () => {},
} });
mock.module('../src/grok/GrokConversation.tsx', { namedExports: {
  GrokConversation: (props: { picker: typeof picker }) => { picker = props.picker; return null; },
} });
const { GrokChat } = await import('../src/grok/GrokChat.tsx');

const teammate: Agent = {
  id: 'teammate-one', name: 'Teammate', role: 'Developer', home: 'bot-teammate-one',
  createdAt: 0, engine: 'claude', model: 'claude-opus-5-5', effort: 'high', brainRevision: 1,
};
let renderer: ReactTestRenderer | undefined;
let props: GrokChatProps;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), {
    confirm, setTimeout, clearTimeout, setInterval, clearInterval,
  }) });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  confirm.mock.resetCalls();
  confirm.mock.mockImplementation(() => true);
  save.mock.resetCalls();
  save.mock.mockImplementation(async (_id, patch) => ({ ...teammate, ...patch, brainRevision: (patch.brainRevision ?? 1) + 1 }));
  chat.serverBrain = null;
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  for (const [name, descriptor] of [
    ['window', originalWindow], ['localStorage', originalStorage], ['IS_REACT_ACT_ENVIRONMENT', originalAct],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

async function mount(agent: Agent | null = teammate) {
  props = {
    chatId: agent?.home ?? 'workspace-one', agent: agent ?? undefined, paneOpen: false, voiceActive: false, theme: 'dark',
    onTogglePane() {}, onVoice() {}, onToggleTheme() {}, onOpenStudio() {},
    onOpenAgentEditor() {}, onAgentBrainSaved() {}, onMeta() {},
  };
  await act(async () => { renderer = create(createElement(GrokChat, props)); });
}
async function refresh() {
  await act(async () => renderer!.update(createElement(GrokChat, props)));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('cancel saves nothing; accepting names both engines as the picker does', async () => {
  await mount();
  confirm.mock.mockImplementation(() => false);
  await act(async () => picker.setCompanion('agy'));
  assert.equal(save.mock.callCount(), 0);
  assert.equal(picker.companion, 'claude');
  assert.equal(picker.model, teammate.model);
  assert.equal(picker.effort, teammate.effort);
  assert.equal(confirm.mock.calls[0].arguments[0],
    'Switch Teammate from Claude Code to Gemini? Their next reply runs on the new engine.');

  confirm.mock.mockImplementation(() => true);
  await act(async () => picker.setCompanion('agy'));
  assert.equal(save.mock.callCount(), 1);
  assert.equal(save.mock.calls[0].arguments[1].brainRevision, 1);
  assert.equal(picker.companion, 'agy');
});

test('a lean teammate can switch to Gemini and pick Carbon without changing its toolbox', async () => {
  let stored: Agent = { ...teammate, toolbox: 'lean' };
  save.mock.mockImplementation(async (_id, patch) => {
    stored = { ...stored, ...patch, brainRevision: (stored.brainRevision ?? 1) + 1 };
    return stored;
  });
  await mount(stored);
  await act(async () => picker.setCompanion('agy'));
  assert.equal(picker.companion, 'agy');
  await act(async () => picker.setAgyModel('gemini-4-carbon'));
  assert.equal(picker.model, 'gemini-4-carbon');
  assert.equal(picker.selectionError, null);
  assert.equal(stored.engine, 'agy');
  assert.equal(stored.toolbox, 'lean');
  assert.equal(save.mock.callCount(), 2);
  for (const { arguments: [, patch] } of save.mock.calls) {
    assert.equal(Object.hasOwn(patch, 'toolbox'), false, 'brain-only saves preserve the roster toolbox');
  }
});

test('same-engine model, effort and speed picks stay one tap', async () => {
  await mount({ ...teammate, engine: 'codex', model: 'gpt-6.1-sol', serviceTier: 'default' });
  await act(async () => picker.setCodexModel('gpt-6-sol'));
  await act(async () => picker.setCodexEffort('xhigh'));
  await act(async () => picker.setCodexServiceTier('default'));
  assert.equal(confirm.mock.callCount(), 0);
  assert.equal(save.mock.callCount(), 3);
  assert.deepEqual(save.mock.calls.map(call => call.arguments[1].brainRevision), [1, 2, 3]);
});

test('a teammate can save Carbon at every Gemini effort and reload the authoritative brain', async () => {
  await mount({ ...teammate, engine: 'agy', model: 'gemini-4-argon', effort: 'medium' });
  await act(async () => picker.setAgyModel('gemini-4-carbon'));
  assert.equal(save.mock.calls[0].arguments[1].model, 'gemini-4-carbon');
  assert.equal(picker.model, 'gemini-4-carbon');
  for (const effort of ['low', 'medium', 'high']) {
    await act(async () => picker.setAgyEffort(effort));
    const patch = save.mock.calls.at(-1)!.arguments[1];
    assert.equal(patch.engine, 'agy');
    assert.equal(patch.model, 'gemini-4-carbon');
    assert.equal(patch.effort, effort);
    assert.equal(picker.model, 'gemini-4-carbon');
    assert.equal(picker.effort, effort);
  }
  chat.serverBrain = { cli: 'agy', model: 'gemini-4-carbon', effort: 'low', revision: 10 };
  await refresh();
  assert.equal(picker.model, 'gemini-4-carbon');
  assert.equal(picker.effort, 'low');
  assert.equal(confirm.mock.callCount(), 0, 'a Gemini model change must not ask to switch engines');
});

test('a local Gemini picker preserves a saved Carbon selection and persists new picks', async () => {
  localStorage.setItem('rivendell:agy-model', 'gemini-4-carbon');
  localStorage.setItem('rivendell:agy-effort', 'low');
  await mount(null);
  await act(async () => picker.setCompanion('agy'));
  assert.equal(picker.model, 'gemini-4-carbon');
  assert.equal(picker.effort, 'low');
  await act(async () => picker.setAgyModel('gemini-4-argon'));
  await act(async () => picker.setAgyModel('gemini-4-carbon'));
  await act(async () => picker.setAgyEffort('high'));
  assert.equal(localStorage.getItem('rivendell:agy-model'), 'gemini-4-carbon');
  assert.equal(localStorage.getItem('rivendell:agy-effort'), 'high');
  assert.equal(picker.model, 'gemini-4-carbon');
  assert.equal(picker.effort, 'high');
  assert.equal(save.mock.callCount(), 0);
});

test('a non-teammate picker changes locally without confirmation or an agent save', async () => {
  await mount(null);
  await act(async () => picker.setCompanion('codex'));
  assert.equal(picker.companion, 'codex');
  assert.equal(confirm.mock.callCount(), 0);
  assert.equal(save.mock.callCount(), 0);
});

test('a failed queued pick restores the preceding successful save, not the initial engine', async () => {
  const first = deferred<Agent>();
  const second = deferred<Agent>();
  save.mock.mockImplementationOnce(() => first.promise, 0);
  save.mock.mockImplementationOnce(() => second.promise, 1);
  await mount();
  await act(async () => picker.setCompanion('codex'));
  await act(async () => picker.setCodexEffort('xhigh'));
  assert.equal(save.mock.callCount(), 1, 'only one save may be in flight');
  const saved = { ...teammate, ...save.mock.calls[0].arguments[1], brainRevision: 2 };
  await act(async () => first.resolve(saved));
  assert.equal(save.mock.callCount(), 2);
  assert.equal(save.mock.calls[1].arguments[1].brainRevision, 2);
  await act(async () => second.reject(new Error('offline')));
  assert.equal(picker.companion, 'codex');
  assert.equal(picker.effort, saved.effort);
  assert.match(picker.selectionError ?? '', /Change wasn’t saved.*offline/);
});

test('a failed pick preserves a newer WebSocket brain even after a stale agent poll', async () => {
  await mount();
  chat.serverBrain = { cli: 'codex', model: 'gpt-6.1-sol', effort: 'high', serviceTier: 'default', revision: 3 };
  await refresh();
  assert.equal(picker.companion, 'codex');
  props = { ...props, agent: { ...teammate, model: 'claude-sonnet-5-5', brainRevision: 2 } };
  await refresh();
  assert.equal(picker.companion, 'codex', 'stale polling must not replace a newer server brain');
  save.mock.mockImplementation(async () => { throw new Error('offline'); });
  await act(async () => picker.setCodexEffort('xhigh'));
  assert.equal(save.mock.calls[0].arguments[1].brainRevision, 3);
  assert.equal(picker.companion, 'codex');
  assert.equal(picker.model, 'gpt-6.1-sol');
  assert.equal(picker.effort, 'high');
  assert.equal(confirm.mock.callCount(), 0, 'failure recovery must not silently switch engines');
});

for (const brainRevision of [2, undefined]) {
  test(`a delayed save response (revision ${brainRevision ?? 'missing'}) preserves a newer WebSocket brain`, async () => {
    const response = deferred<Agent>();
    save.mock.mockImplementationOnce(() => response.promise, 0);
    await mount();
    await act(async () => picker.setCompanion('codex'));
    const staleSaved = { ...teammate, ...save.mock.calls[0].arguments[1], brainRevision };
    chat.serverBrain = { cli: 'agy', model: 'gemini-4-argon', effort: 'medium', revision: 3 };
    await refresh();
    await act(async () => response.resolve(staleSaved));
    assert.equal(picker.companion, 'agy');
    assert.equal(picker.model, 'gemini-4-argon');
    assert.equal(picker.effort, 'medium');

    save.mock.mockImplementation(async () => { throw new Error('offline'); });
    await act(async () => picker.setAgyEffort('high'));
    assert.equal(save.mock.calls[1].arguments[1].brainRevision, 3);
    assert.equal(picker.companion, 'agy');
    assert.equal(picker.model, 'gemini-4-argon');
    assert.equal(picker.effort, 'medium', 'failure must restore the newer authoritative brain');
  });
}

for (const source of ['websocket', 'props']) {
  test(`a newer ${source} brain cancels a queued pick without reporting it saved`, async () => {
    const response = deferred<Agent>();
    save.mock.mockImplementationOnce(() => response.promise, 0);
    await mount();
    await act(async () => picker.setCompanion('codex'));
    await act(async () => picker.setCodexEffort('xhigh'));
    assert.equal(save.mock.callCount(), 1);
    if (source === 'websocket') {
      chat.serverBrain = { cli: 'agy', model: 'gemini-4-argon', effort: 'medium', revision: 3 };
    } else {
      props = { ...props, agent: { ...teammate, engine: 'agy', model: 'gemini-4-argon', effort: 'medium', brainRevision: 3 } };
    }
    await refresh();
    await act(async () => response.resolve({ ...teammate, ...save.mock.calls[0].arguments[1], brainRevision: 2 }));
    assert.equal(save.mock.callCount(), 1, 'the discarded queued pick must not save the remote selection');
    assert.equal(picker.companion, 'agy');
    assert.equal(picker.effort, 'medium');
    assert.equal(picker.selectionNotice, null, 'a discarded pick must not be reported as saved');
  });
}

test('a conflict restores the winning brain and uses it in the next confirmation', async () => {
  await mount();
  save.mock.mockImplementation(async () => {
    throw new agents.AgentUpdateConflictError({ ...teammate, engine: 'agy', model: 'gemini-4-argon', effort: 'medium', brainRevision: 4 });
  });
  await act(async () => picker.setClaudeEffort('max'));
  assert.equal(picker.companion, 'agy');
  assert.match(picker.selectionError ?? '', /Settings changed on another device/);
  confirm.mock.mockImplementation(() => false);
  await act(async () => picker.setCompanion('codex'));
  assert.match(confirm.mock.calls[0].arguments[0], /from Gemini to Codex/);
  assert.equal(save.mock.callCount(), 1, 'a conflict must not be retried silently');
});
