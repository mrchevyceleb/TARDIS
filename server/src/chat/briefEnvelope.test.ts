import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  briefEnvelopeForHandoff,
  cardRefsIn,
  distillConfig,
  envelopeHeader,
  isCoderBrief,
  ownGoalSentence,
  readsAsGoalSentence,
} from './briefEnvelope.ts';

test('isCoderBrief: leads to coders only (incl. game studio)', () => {
  assert.equal(isCoderBrief('kip', 'christina'), true);
  assert.equal(isCoderBrief('chief-of-staff', 'christina'), true);
  assert.equal(isCoderBrief('samwise', 'adam'), true);
  assert.equal(isCoderBrief('riley', 'tim'), true);
  assert.equal(isCoderBrief('riley', 'piper'), true);
  assert.equal(isCoderBrief('riley', 'felix'), true);
  assert.equal(isCoderBrief('christina', 'maria'), false);
  assert.equal(isCoderBrief('kip', 'quinn'), false);
  assert.equal(isCoderBrief('desk:owner', 'christina'), false);
  assert.equal(isCoderBrief('unknown', 'tim'), false);
});

test('cardRefsIn reads the brief’s own cards, never invents', () => {
  assert.deepEqual(cardRefsIn('Brief for [desk:card-abc123] please.'), ['card-abc123']);
  assert.deepEqual(cardRefsIn('no card here'), []);
  assert.deepEqual(cardRefsIn('[desk:card-abc123] then [desk:card-def456] then [desk:card-abc123]'), ['card-abc123', 'card-def456']);
  assert.deepEqual(cardRefsIn('work on [card-e9b846] and card-8D427d_now'), ['card-e9b846', 'card-8D427d_now']);
});

test('readsAsGoalSentence: one line, full stop, under cap', () => {
  assert.equal(readsAsGoalSentence('The user feels the page answers itself.'), true);
  assert.equal(readsAsGoalSentence('No end mark'), false);
  assert.equal(readsAsGoalSentence('Line one.\nLine two.'), false);
  assert.equal(readsAsGoalSentence('- Fix the thing.'), false);
  assert.equal(readsAsGoalSentence('1. Fix the thing.'), false);
  assert.equal(readsAsGoalSentence('Edit foo.ts.'), false);
  assert.equal(readsAsGoalSentence('Fix v1.2.'), false);
  assert.equal(readsAsGoalSentence('Ship the change tonight.'), false);
});

test('ownGoalSentence: whole-text goal and goal-then-steps', () => {
  assert.equal(
    ownGoalSentence('The user feels the page answers itself.'),
    'The user feels the page answers itself.',
  );
  const brief = 'The user feels the page answers itself. Then edit server/src/routes/x.ts line 12.';
  assert.equal(ownGoalSentence(brief), 'The user feels the page answers itself.');
  assert.equal(ownGoalSentence('Step 1: edit the file. Step 2: restart.'), null);
});

test('envelopeHeader: card line or the honest no-card line', () => {
  assert.deepEqual(envelopeHeader('Goal.', 'card-abc123'), ['Goal.', 'Card: [desk:card-abc123]']);
  assert.deepEqual(envelopeHeader('Goal.', null), ['Goal.', 'No card named in this brief — card it first: nothing is invented here.']);
  assert.equal(envelopeHeader(null, null), null);
});

test('briefEnvelopeForHandoff: no card, no goal and no key fails open', async () => {
  const priorBase = process.env.RIVENDELL_OPENROUTER_ANTHROPIC_BASE_URL;
  const priorKey = process.env.RIVENDELL_OPENROUTER_API_KEY;
  const priorAlt = process.env.OPENROUTER_API_KEY;
  for (const k of ['RIVENDELL_OPENROUTER_ANTHROPIC_BASE_URL', 'RIVENDELL_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY']) delete process.env[k];
  try {
    assert.equal(distillConfig(), null);
    const out = await briefEnvelopeForHandoff({
      senderId: 'kip',
      recipientId: 'christina',
      recipientName: 'Christina',
      text: '1. Edit server/src/routes/x.ts line 12. 2. Restart the bridge.',
      wait: false,
    });
    assert.equal(out, null);
  } finally {
    if (priorBase === undefined) delete process.env.RIVENDELL_OPENROUTER_ANTHROPIC_BASE_URL;
    else process.env.RIVENDELL_OPENROUTER_ANTHROPIC_BASE_URL = priorBase;
    if (priorKey === undefined) delete process.env.RIVENDELL_OPENROUTER_API_KEY;
    else process.env.RIVENDELL_OPENROUTER_API_KEY = priorKey;
    if (priorAlt === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorAlt;
  }
});

test('briefEnvelopeForHandoff: own goal sentence wins, card carried through', async () => {
  const out = await briefEnvelopeForHandoff({
    senderId: 'kip',
    recipientId: 'christina',
    recipientName: 'Christina',
    text: 'The user feels the home page answers them in seconds. Edit server/src/routes/x.ts line 12 and restart. [desk:card-abc123]',
    wait: false,
  });
  assert.ok(out);
  const lines = out!.split('\n');
  assert.equal(lines[0], 'The user feels the home page answers them in seconds.');
  assert.equal(lines[1], 'Card: [desk:card-abc123]');
  assert.ok(out!.includes('Edit server/src/routes/x.ts line 12'));
});

test('briefEnvelopeForHandoff: steer turns and non-coders skip', async () => {
  assert.equal(await briefEnvelopeForHandoff({
    senderId: 'kip', recipientId: 'christina', recipientName: 'Christina',
    text: 'The user feels it.', wait: true,
  }), null);
  assert.equal(await briefEnvelopeForHandoff({
    senderId: 'christina', recipientId: 'maria', recipientName: 'Maria',
    text: 'The user feels it.', wait: false,
  }), null);
  assert.equal(await briefEnvelopeForHandoff({
    senderId: 'kip', recipientId: 'quinn', recipientName: 'Quinn',
    text: 'The user feels it.', wait: false,
  }), null);
});
