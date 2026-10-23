import assert from 'node:assert/strict';
import test from 'node:test';
import { agentTaskMap, agentTaskSubline, taskKindOf, withHeadline, type DeskCardLite, type DeskPr } from '../src/data/desk.ts';

const now = Date.parse('2026-10-24T12:00:00Z');
const day = 86_400_000;
const agent = { id: 'agent-one', name: 'Teammate' };
const owner = { kind: 'agent' as const, ...agent };
const card = (id: string, column: DeskCardLite['column'] = 'in_progress', patch: Partial<DeskCardLite> = {}): DeskCardLite => ({
  id, title: `Task ${id}`, column, owner, updatedAt: new Date(now).toISOString(), ...patch,
});
const pr: DeskPr = { owner: agent.name, repo: 'example/project', number: 12, title: 'A reviewed change', state: 'open', url: 'https://github.com/example/project/pull/12', updatedAt: new Date(now).toISOString() };

test('task ownership uses ids, permits only unambiguous pre-id names, and never adopts deleted ids', () => {
  const twin = { id: 'agent-two', name: agent.name };
  const exact = card('exact', 'in_progress', { owner: { ...owner, name: 'Old name' } });
  const deleted = card('deleted', 'in_progress', { owner: { ...owner, id: 'deleted' } });
  const legacy = card('legacy', 'not_started', { owner: { ...owner, id: '', name: ' TEAMMATE ' } });
  const slots = agentTaskMap([exact, deleted, legacy], [agent, twin], now);
  assert.equal(slots.get(agent.id)?.current, exact);
  assert.deepEqual(slots.get(twin.id), {});
  assert.equal(slots.get(agent.id)?.next, undefined, 'a name twin makes legacy ownership ambiguous');
  assert.equal(agentTaskMap([legacy], [agent], now).get(agent.id)?.next, legacy);
  assert.deepEqual(agentTaskMap([deleted], [agent], now).get(agent.id), {});
});

test('unchanged cards expire at the same current, waiting and next-up cutoffs on every surface', () => {
  for (const [column, key, days] of [
    ['in_progress', 'current', 7], ['on_staging', 'waiting', 14], ['in_qa', 'waiting', 14], ['not_started', 'next', 30],
  ] as const) {
    const cards = [card(column, column, { updatedAt: new Date(now - days * day).toISOString() })];
    assert.equal(agentTaskMap(cards, [agent], now).get(agent.id)?.[key], cards[0], column);
    assert.deepEqual(agentTaskMap(cards, [agent], now + 1).get(agent.id), {}, `${column} expires even without a changed payload`);
  }
});

test('archived, shipped, owner-owned and invalid-date cards never become current or next', () => {
  const cards = [
    card('archived', 'in_progress', { archived: true }), card('shipped', 'in_production'),
    card('human', 'in_progress', { owner: { ...owner, kind: 'owner' } }),
    card('invalid', 'not_started', { updatedAt: 'not-a-date' }),
  ];
  assert.deepEqual(agentTaskMap(cards, [agent], now).get(agent.id), {});
});

test('the newest instant wins regardless of input order or timestamp offset', () => {
  const newest = card('newest', 'in_progress', { updatedAt: '2026-10-24T11:00:00Z' });
  const older = card('older', 'in_progress', { updatedAt: '2026-10-24T14:00:00+05:00' });
  for (const cards of [[newest, older], [older, newest]]) {
    assert.equal(agentTaskMap(cards, [agent], now).get(agent.id)?.current, newest);
  }
});

test('headlines distinguish current work, waiting in QA and parked next-up work', () => {
  const current = card('current');
  const waiting = card('waiting', 'in_qa');
  const next = card('next', 'not_started');
  for (const [slot, kind, headline] of [
    [{ current, waiting, next }, 'current', current.title],
    [{ waiting, next }, 'waiting', `In QA: ${waiting.title}`],
    [{ next }, 'next', `Next up: ${next.title}`],
  ] as const) {
    assert.equal(taskKindOf(slot), kind);
    assert.equal(withHeadline(slot).headline, headline);
  }
  assert.equal(withHeadline({}).headline, undefined);
  assert.equal(taskKindOf({}), undefined);
});

test('sidebar prioritizes the task, then PRs, then waiting/next work, without false idle states', () => {
  const current = card('current');
  const waiting = card('waiting', 'on_staging');
  const next = card('next', 'not_started');
  const line = (slot = {}, prs: DeskPr[] = []) => agentTaskSubline(slot, prs, 'ready', 'ready');
  assert.equal(line({ current, waiting, next }, [pr]).text, current.title);
  assert.match(line({ waiting, next }, [pr]).text, /project #12/);
  assert.deepEqual(line({ waiting, next }), { text: `Waiting on staging: ${waiting.title}`, quiet: true });
  assert.equal(line({ next }).text, `Next up: ${next.title}`);
  assert.equal(line().text, 'No current task');
  assert.equal(agentTaskSubline({}, [], 'loading', 'ready').text, 'Checking current task…');
  assert.equal(agentTaskSubline({}, [], 'error', 'ready').text, 'Current task unavailable');
  assert.equal(agentTaskSubline({}, [], 'ready', 'loading').text, 'Checking PRs…');
  assert.equal(agentTaskSubline({}, [], 'ready', 'error').text, 'PR status unavailable');
  assert.equal(agentTaskSubline({ current }, [], 'error', 'ready').text, `Last known: ${current.title}`);
  assert.match(agentTaskSubline({}, [pr], 'error', 'error').text, /^Last known: project #12/);
  assert.match(line({}, [{ ...pr, state: 'merged' }]).text, /merged to staging/);
});
