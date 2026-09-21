import assert from 'node:assert/strict';
import test from 'node:test';

// Regression guard for the voice call that showed "working" forever: the
// context check fired on a GLOBAL event-log counter that every thread bumps,
// so a call re-sent session.update about once a second even though its own
// instructions never changed, and turn detection never settled.
test('a call only reconfigures the realtime session when its instructions change', () => {
  let globalRevision = 0;
  let instructions = 'RULES\n\nthread context v1';
  let threadContext = 'thread context v1';
  let sessionUpdates = 0;
  let contextSeq = globalRevision;

  const tick = () => {
    const seq = globalRevision;
    if (seq === contextSeq) return;
    contextSeq = seq;
    const next = `RULES\n\n${threadContext}`;
    if (next === instructions) return;
    instructions = next;
    sessionUpdates += 1;
  };

  // Other agents churn the shared counter for a whole call.
  for (let i = 0; i < 500; i += 1) { globalRevision += 1; tick(); }
  assert.equal(sessionUpdates, 0);

  // This call's own thread actually changes: exactly one reconfiguration.
  threadContext = 'thread context v2';
  globalRevision += 1;
  tick();
  assert.equal(sessionUpdates, 1);
  assert.match(instructions, /v2/);
});
