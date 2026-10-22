import assert from 'node:assert/strict';
import test from 'node:test';
import { ELROND_WORKSPACE_PATH } from '../config.ts';
import { abortInFlightChannelDeliveries, agentLogKey, batchJoinable, deliveryInterruptClass, deliveryLanePolicy, extendTeamChain, frozenBatchMembers, liveChannelTurnLanes, registerInFlightChannelDelivery, releaseInFlightChannelDelivery, teamAvailability, teamMessageWaitRequested, waitForDeliveryBoundary, type TeamChain } from './teamBus.ts';
import { laneChatId } from './threadKey.ts';
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

  // The timeout path arms only an UNREF'd timer (production: a 30-minute
  // admission wait must never hold the server open). Under node 22 (CI's pin)
  // a test process whose event loop otherwise drains cancels the pending
  // test with "Promise resolution is still pending but the event loop has
  // already resolved" and the rest of this file's queued tests with it, so
  // the first timeout await below cancelled tests 49-51 on every CI run.
  // A REF'd watchdog both holds the loop for the duration of the wait (so
  // this test owns its own liveness instead of borrowing ambient handles
  // from earlier tests) and fails loudly if a regression ever makes the wait
  // stop settling, instead of hanging into another cancelled-by-parent
  // cascade.
  let watchdog: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    watchdog = setTimeout(() => reject(new Error('the boundary wait never settled (5s watchdog)')), 5_000);
  });
  try {
    assert.equal(await Promise.race([waitForDeliveryBoundary(session, 40, undefined, () => false), deadline]), 'timeout');
    assert.equal(await Promise.race([waitForDeliveryBoundary(session, 40, undefined, () => true), deadline]), 'steerable');
  } finally {
    clearTimeout(watchdog);
  }
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

test('the person’s channel posts get person-class delivery, agent posts stay peer class', () => {
  // Matt posting in a channel steers members’ live turns like a one-on-one
  // message: human interrupt boundary, person lane policy (card-1327b9).
  assert.equal(deliveryInterruptClass('channel', true), 'human');
  assert.equal(deliveryLanePolicy('channel', true), 'person');
  // An agent’s channel reply keeps the ordinary peer/background behavior.
  assert.equal(deliveryInterruptClass('channel', false), 'peer');
  assert.equal(deliveryInterruptClass('channel', undefined), 'peer');
  assert.equal(deliveryLanePolicy('channel', false), 'bg');
  assert.equal(deliveryLanePolicy('channel', undefined), 'bg');
  // The existing person classes are unchanged, and automation stays
  // non-interruptible for peers and channels alike.
  assert.equal(deliveryInterruptClass('desk', undefined), 'human');
  assert.equal(deliveryInterruptClass('voice', undefined), 'human');
  assert.equal(deliveryLanePolicy('desk', undefined), 'person');
  assert.equal(deliveryLanePolicy('voice', undefined), 'person');
  assert.equal(deliveryInterruptClass('automation', true), false);
  assert.equal(deliveryInterruptClass(undefined, true), 'peer');
  assert.equal(deliveryLanePolicy(undefined, true), 'bg');
});

test('a queued delivery never requests any interrupt class, on any admission or retry', () => {
  // card-504beb: queue keeps the person class and lane preference, but the
  // delivery never interrupts the live turn — no human boundary request, no
  // peer boundary request, not even on the member's own live channel turn or
  // a drain retry. It waits for the turn to end like a peer message that
  // cannot steer.
  assert.equal(deliveryInterruptClass('channel', true, true), false);
  assert.equal(deliveryInterruptClass('channel', false, true), false);
  assert.equal(deliveryInterruptClass('channel', undefined, true), false);
  assert.equal(deliveryInterruptClass('desk', undefined, true), false);
  assert.equal(deliveryInterruptClass('voice', undefined, true), false);
  assert.equal(deliveryInterruptClass(undefined, true, true), false);
  // Without queue the person classes are exactly as before.
  assert.equal(deliveryInterruptClass('channel', true, false), 'human');
  assert.equal(deliveryInterruptClass('channel', true, undefined), 'human');
  assert.equal(deliveryInterruptClass('desk', undefined, false), 'human');
});

test('a channel Stop aborts the in-flight delivery worker holding its batch', () => {
  // Review finding 1: removing the outbox row alone leaves the drain worker
  // waiting at a turn boundary with its batch already built. Stop must abort
  // that worker, or the interrupt hands it exactly the idle session it was
  // waiting for and the dropped post comes straight back.
  const from = 'channel:stop-test';
  const entry = registerInFlightChannelDelivery('stop-test-member', from);
  try {
    assert.equal(entry.controller.signal.aborted, false);
    assert.equal(abortInFlightChannelDeliveries('stop-test-member', from), 1);
    assert.equal(entry.controller.signal.aborted, true);
    // Aborting again is a no-op, and a foreign member is untouched.
    assert.equal(abortInFlightChannelDeliveries('stop-test-member', from), 1);
    assert.equal(abortInFlightChannelDeliveries('stop-test-other', from), 0);
  } finally {
    releaseInFlightChannelDelivery('stop-test-member', from, entry);
  }
  assert.equal(abortInFlightChannelDeliveries('stop-test-member', from), 0);
});

test('a channel delivery reports its lane only while its turn is live', () => {
  // Later person posts from the same channel steer the exact turn an earlier
  // post started, so the lane must show while the session is busy and stop
  // showing once the turn has been over for a while (review findings 2-4).
  const from = 'channel:lanes-test';
  const entry = registerInFlightChannelDelivery('lanes-test-member', from);
  try {
    // Before admission there is no lane to steer.
    assert.deepEqual(liveChannelTurnLanes('lanes-test-member', from, [{ cli: 'codex', chatId: 'bot-x', busy: true }]), []);
    entry.lane = 'main';
    entry.cli = 'codex';
    entry.chatKey = 'bot-x';
    entry.admittedAt = Date.now() - 6000;
    // Busy on the admitted (cli, chat id): the lane shows. A background
    // sibling on the same member never matches, and neither does a session
    // on a different engine (review 3, P0 1).
    assert.deepEqual(liveChannelTurnLanes('lanes-test-member', from, [{ cli: 'codex', chatId: 'bot-x', busy: true }]), ['main']);
    assert.deepEqual(liveChannelTurnLanes('lanes-test-member', from, [{ cli: 'codex', chatId: 'bot-x__bg', busy: true }]), []);
    assert.deepEqual(liveChannelTurnLanes('lanes-test-member', from, [{ cli: 'claude', chatId: 'bot-x', busy: true }]), []);
    // The turn ended over five seconds ago: pruned, never claimed again.
    assert.deepEqual(liveChannelTurnLanes('lanes-test-member', from, [{ cli: 'codex', chatId: 'bot-x', busy: false }]), []);
    assert.deepEqual(liveChannelTurnLanes('lanes-test-member', from, [{ cli: 'codex', chatId: 'bot-x', busy: true }]), []);
  } finally {
    releaseInFlightChannelDelivery('lanes-test-member', from, entry);
  }
});

test('all legacy lane and account suffixes resolve to the one agent session', () => {
  // Review 3 P0 1: main and background lanes must never compare equal, but
  // an account-pinned main session must still match its lane.
  assert.equal(laneChatId('bot-kate'), 'bot-kate');
  assert.equal(laneChatId('bot-kate__bg'), 'bot-kate');
  assert.equal(laneChatId('bot-kate__acct__kim'), 'bot-kate');
  // A pin can never follow the bg suffix in a real id; if one somehow did,
  // laneChatId leaves it unmatched rather than collapsing lanes — fail safe.
  assert.equal(laneChatId('bot-kate__acct__kim__bg'), 'bot-kate__acct__kim__bg');
  assert.equal(laneChatId('bot-kate'), laneChatId('bot-kate__bg'));
});

test('a coder brief never batches with another sender', () => {
  // Review P1 (Oct 20): a lead-to-coder brief promises the coder a goal
  // sentence first and one named sender waiting on the result, so it must
  // never share a turn with another sender's record. Same-sender briefs and
  // plain peer chatter still batch.
  const base = { fromName: 'Kip', text: 'hi', hop: 1 } as const;
  const brief = { id: 'b1', createdAt: '2026-10-20T00:00:00Z', fromId: 'kip', toId: 'christina', ...base };
  const sameLead = { id: 'b2', createdAt: '2026-10-20T00:00:01Z', fromId: 'kip', toId: 'christina', ...base };
  const otherSender = { id: 'b3', createdAt: '2026-10-20T00:00:02Z', fromId: 'samwise', toId: 'christina', ...base };
  const peerChatter = { id: 'b4', createdAt: '2026-10-20T00:00:03Z', fromId: 'christina', toId: 'naomi', ...base };
  const peerChatterToo = { id: 'b5', createdAt: '2026-10-20T00:00:04Z', fromId: 'maria', toId: 'naomi', ...base };
  assert.equal(batchJoinable(brief as never, sameLead as never), true);
  assert.equal(batchJoinable(brief as never, otherSender as never), false);
  assert.equal(batchJoinable(otherSender as never, brief as never), false);
  assert.equal(batchJoinable(peerChatter as never, peerChatterToo as never), true);
});

test('a frozen batch drops members the join rules now refuse', () => {
  // Review P1 (Oct 20): a stamp written by an earlier build predates the
  // coder-brief same-sender rule. The frozen batch is re-checked so the
  // refused member is un-stamped and takes its own admission, instead of
  // riding the frozen batch verbatim.
  const base = { fromName: 'Kip', text: 'hi', hop: 1 } as const;
  const brief = { id: 'f1', createdAt: '2026-10-20T00:00:00Z', fromId: 'kip', toId: 'christina', batchLeadId: 'f1', ...base };
  const sameSender = { id: 'f2', createdAt: '2026-10-20T00:00:01Z', fromId: 'kip', toId: 'christina', batchLeadId: 'f1', ...base };
  const otherSender = { id: 'f3', createdAt: '2026-10-20T00:00:02Z', fromId: 'samwise', toId: 'christina', batchLeadId: 'f1', ...base };
  const split = frozenBatchMembers(brief as never, [sameSender as never, otherSender as never]);
  assert.deepEqual(split.ride.map((item) => item.id), ['f2']);
  assert.deepEqual(split.drop.map((item) => item.id), ['f3']);
  // A frozen batch that still satisfies the rules is reused whole.
  const chatterLead = { id: 'c1', createdAt: '2026-10-20T00:00:03Z', fromId: 'naomi', toId: 'kate', batchLeadId: 'c1', ...base };
  const chatterMember = { id: 'c2', createdAt: '2026-10-20T00:00:04Z', fromId: 'maria', toId: 'kate', batchLeadId: 'c1', ...base };
  const intact = frozenBatchMembers(chatterLead as never, [chatterMember as never]);
  assert.deepEqual(intact.ride.map((item) => item.id), ['c2']);
  assert.deepEqual(intact.drop, []);
});

test('the person’s channel posts never batch with agent replies from the same channel', () => {
  // Review finding 5: a person post (human interrupt, steering lane policy)
  // and an agent reply from the same channel must not share a batch, or the
  // lead’s class would decide for both.
  const base = { fromId: 'channel:b1', fromName: '#b1', toId: 'kate', text: 'hi', hop: 1 } as const;
  const personLead = { id: 'l1', createdAt: '2026-10-16T00:00:00Z', fromRole: 'channel', personPosted: true, ...base };
  const agentReply = { id: 'l2', createdAt: '2026-10-16T00:00:01Z', fromRole: 'channel', ...base };
  const personToo = { id: 'l3', createdAt: '2026-10-16T00:00:02Z', fromRole: 'channel', personPosted: true, ...base };
  const otherChannel = { id: 'l4', createdAt: '2026-10-16T00:00:03Z', fromRole: 'channel', personPosted: true, ...base, fromId: 'channel:b2' };
  assert.equal(batchJoinable(personLead as never, agentReply as never), false);
  assert.equal(batchJoinable(personLead as never, personToo as never), true);
  assert.equal(batchJoinable(personLead as never, otherChannel as never), false);
});
