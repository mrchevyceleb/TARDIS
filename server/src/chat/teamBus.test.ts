import assert from 'node:assert/strict';
import test from 'node:test';
import { ELROND_WORKSPACE_PATH } from '../config.ts';
import { agentLogKey, extendTeamChain, teamAvailability, teamMessageWaitRequested, waitForDeliveryBoundary, type TeamChain } from './teamBus.ts';
import type { Agent } from './agents.ts';

test('raw API preserves its reply default while the MCP can request async delivery', () => {
  assert.equal(teamMessageWaitRequested(undefined), true);
  assert.equal(teamMessageWaitRequested(false), false);
  assert.equal(teamMessageWaitRequested(true), true);
});

test('team chains record repeated edges without muting later collaboration', () => {
  let chain: TeamChain | undefined;
  for (let index = 0; index < 100; index += 1) {
    const next = extendTeamChain(chain, `agent-${index}`, `agent-${index + 1}`);
    assert.equal(next.repeatsEdge, false);
    chain = next.chain;
  }
  assert.equal(chain?.edges.length, 100);

  const returnViaNewEdge = extendTeamChain(chain, 'agent-100', 'agent-0');
  assert.equal(returnViaNewEdge.repeatsEdge, false);
  const repeated = extendTeamChain(returnViaNewEdge.chain, 'agent-0', 'agent-1');
  assert.equal(repeated.repeatsEdge, true);
  assert.equal(repeated.chain.edges.length, 102);
  assert.equal(repeated.chain.route.at(-1), 'agent-1');
});

test('queued delivery wakes when a long busy turn enters a safe steering window', async () => {
  let steerable = false;
  let unsubscribed = false;
  let notify: Parameters<Parameters<typeof waitForDeliveryBoundary>[0]['subscribe']>[0] = () => {};
  const session: Parameters<typeof waitForDeliveryBoundary>[0] = {
    send: async () => {},
    isBusy: () => true,
    canAcceptNativeHumanSteer: () => steerable,
    latestSeq: () => 12,
    subscribe: (listener) => {
      notify = listener;
      return () => { unsubscribed = true; };
    },
    key: 'claude|workspace|bot-kip',
    logKey: 'thread|workspace|bot-kip',
  };

  const waiting = waitForDeliveryBoundary(session, 1_000);
  steerable = true;
  notify({ seq: 13, ev: { type: 'event', event: { type: 'assistant' } } });

  assert.equal(await waiting, 'steerable');
  assert.equal(unsubscribed, true);
});

test('a steering window the caller cannot admit is not a boundary', async () => {
  // Regression: the admission gate refuses a steer when the live turn runs a
  // superseded brain. Reporting 'steerable' anyway resolved with no delay, and
  // the caller's retry loop then pinned the event loop until the 30m deadline.
  const session: Parameters<typeof waitForDeliveryBoundary>[0] = {
    send: async () => {},
    isBusy: () => true,
    canAcceptNativeHumanSteer: () => true,
    latestSeq: () => 12,
    subscribe: () => () => {},
    key: 'codex|workspace|bot-kip',
    logKey: 'thread|workspace|bot-kip',
  };

  assert.equal(await waitForDeliveryBoundary(session, 40, undefined, () => false), 'timeout');
  assert.equal(await waitForDeliveryBoundary(session, 40, undefined, () => true), 'steerable');
});

test('team availability reports process truth separately from queued work', () => {
  const agent: Agent = {
    id: 'christina',
    name: 'Christina',
    role: 'Developer',
    engine: 'codex',
    home: 'bot-christina',
    createdAt: 1,
  };
  assert.deepEqual(teamAvailability(agent, [{
    cli: 'codex',
    cwd: ELROND_WORKSPACE_PATH,
    chatId: `${agent.home}__acct__kim`,
    busy: true,
  }], [{ toId: agent.id }]), {
    status: 'working',
    busy: true,
    queuedMessages: 1,
    activeCli: 'codex',
  });
  assert.deepEqual(teamAvailability(agent, [], [{ toId: agent.id }]), {
    status: 'queued',
    busy: false,
    queuedMessages: 1,
  });
  assert.deepEqual(teamAvailability(agent, [], []), {
    status: 'idle',
    busy: false,
    queuedMessages: 0,
  });
});

test('team delivery uses the persisted agent brain instead of a stale live-lane stamp', () => {
  const agent: Agent = {
    id: 'kate',
    name: 'Kate',
    role: 'Ops',
    engine: 'xai',
    model: 'grok-4.5',
    effort: 'low',
    brainRevision: 7,
    cli: 'codex',
    home: 'bot-kate',
    createdAt: 1,
  };
  assert.deepEqual(agentLogKey(agent), {
    cli: 'xai',
    chatKey: 'bot-kate',
    model: 'grok-4.5',
    effort: 'low',
  });
});
